import { Logger } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  DependencyUnavailableError,
  DuplicateKeyError,
} from '../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../src/application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../src/application/messaging/wager-message-handler.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { AwsQueueGateway } from '../../src/interfaces/sqs/aws-queue-gateway.js';
import type {
  DeadLetterInfo,
  QueueMessage,
} from '../../src/interfaces/sqs/queue-gateway.js';
import { WagerSqsConsumer } from '../../src/interfaces/sqs/wager-sqs.consumer.js';
import { GatedUnitOfWork } from '../support/concurrency.js';
import { sharedLogs } from '../support/http-app.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence, uuid } from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
  type TestQueuesOptions,
} from '../support/queues.js';
import {
  AlwaysFailingUnitOfWork,
  UnitOfWorkWith,
  createScenario,
  type Wallet,
} from '../support/wager-scenarios.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';

const db = usePersistence();
const s = createScenario(db);

beforeAll(() => {
  // O Logger do Nest é estático: sem um app no ar, o espião precisa ser instalado à mão.
  Logger.overrideLogger(sharedLogs);
});
beforeEach(() => sharedLogs.clear());
afterAll(() => Logger.overrideLogger(sharedLogs));

// ---- infraestrutura dos testes ---------------------------------------------------------------

// O gateway de verdade, só que anotando cada chamada (e deixando o teste trocar UMA delas).
class RecordingGateway extends AwsQueueGateway {
  deletes: string[] = [];
  visibility: Array<{ id: string; seconds: number }> = [];
  deadLettered: Array<{
    id: string;
    info: DeadLetterInfo;
    receiveCount: number;
  }> = [];
  onDelete?: (message: QueueMessage) => Promise<void>;
  onDeadLetter?: (message: QueueMessage) => Promise<void>;

  override async delete(message: QueueMessage): Promise<void> {
    await this.onDelete?.(message);
    this.deletes.push(message.sqsMessageId);
    await super.delete(message);
  }
  override async changeVisibility(
    message: QueueMessage,
    seconds: number,
  ): Promise<void> {
    this.visibility.push({ id: message.sqsMessageId, seconds });
    await super.changeVisibility(message, seconds);
  }
  override async sendToDeadLetter(
    message: QueueMessage,
    info: DeadLetterInfo,
  ): Promise<void> {
    await this.onDeadLetter?.(message);
    this.deadLettered.push({
      id: message.sqsMessageId,
      info,
      receiveCount: message.receiveCount,
    });
    await super.sendToDeadLetter(message, info);
  }
}

interface Harness {
  queues: TestQueues;
  gateway: RecordingGateway;
  start(over?: {
    uow?: UnitOfWork;
    maxReceiveCount?: number;
    baseSeconds?: number;
    shutdownTimeoutMs?: number;
    waitSeconds?: number;
    gateway?: RecordingGateway;
  }): WagerSqsConsumer;
  message(
    wallet: Wallet,
    over?: Record<string, unknown>,
    envelopeOver?: Record<string, unknown>,
  ): {
    body: Record<string, unknown>;
    envelope: Record<string, unknown>;
    key: string;
  };
}

async function withHarness(
  options: TestQueuesOptions,
  test: (h: Harness) => Promise<void>,
): Promise<void> {
  const queues = await createTestQueues(options);
  const consumers: WagerSqsConsumer[] = [];
  const gateway = new RecordingGateway(queues.client, {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
  });
  try {
    await test({
      queues,
      gateway,
      start(over = {}) {
        const useCase = s.build(over.uow ? { uow: over.uow } : {});
        const handler = new WagerMessageHandler(
          useCase,
          new ConsumerRetryPolicy({
            maxReceiveCount: over.maxReceiveCount ?? 5,
            baseSeconds: over.baseSeconds ?? 0,
            maxSeconds: 60,
          }),
        );
        const consumer = new WagerSqsConsumer(
          over.gateway ?? gateway,
          handler,
          {
            waitSeconds: over.waitSeconds ?? 1,
            batchSize: 10,
            shutdownTimeoutMs: over.shutdownTimeoutMs ?? 3_000,
          },
        );
        consumers.push(consumer);
        consumer.start();
        return consumer;
      },
      message(wallet, over = {}, envelopeOver = {}) {
        const body = s.body(wallet, over);
        return {
          body,
          envelope: envelope(body, envelopeOver),
          key: s.keyOf(body),
        };
      },
    });
  } finally {
    await Promise.all(consumers.map((c) => c.stop().catch(() => undefined)));
    await queues.close();
  }
}

const txOf = (key: string) =>
  s.sql('SELECT * FROM wager_transactions WHERE idempotency_key = ?', [key]);
const inboxOf = (messageId: string) =>
  s.sql(
    'SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    ['wager-transactions-consumer', messageId],
  );
const flaky = (inner: UnitOfWork, failures: number) =>
  new (class extends UnitOfWork {
    runs = 0;
    run<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
      this.runs++;
      return this.runs <= failures
        ? Promise.reject(
            new DependencyUnavailableError('database busy (injected)'),
          )
        : inner.run(work);
    }
  })();

// ---- 1. o fluxo feliz e a deduplicação -------------------------------------------------------

describe('the happy path and deduplication', () => {
  test('a BET message: PROCESSED, one DEBIT, one inbox row, the queue is empty and nothing went to the DLQ', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const [tx] = await txOf(m.key);
      expect(tx).toMatchObject({ status: WagerTransactionStatus.Processed });
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await s.balanceOf(wallet)).toBe('75.00');
      const [inbox] = await inboxOf(String(m.envelope.messageId));
      expect(inbox?.processed_at).not.toBeNull();
      expect(await h.queues.dead()).toHaveLength(0);
      expect(h.gateway.deletes).toHaveLength(1);
      await assertInvariants(s.sql, wallet.id);
    });
  });

  test('the SAME message delivered twice (same messageId, different SQS dedup ids): ONE debit, both deleted', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await s.balanceOf(wallet)).toBe('75.00');
      expect(await txOf(m.key)).toHaveLength(1);
      expect(await inboxOf(String(m.envelope.messageId))).toHaveLength(1);
      expect(h.gateway.deletes).toHaveLength(2);
      expect(await h.queues.dead()).toHaveLength(0);
    });
  });

  test('the same operation by HTTP first and by SQS later is a replay: one debit', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await s.submit(m.body); // o caminho do HTTP: sem inbox
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await h.queues.dead()).toHaveLength(0);
    });
  });

  test('the same operation by SQS first and by HTTP later is a replay, not a 409: the payload hash is the same on both doors', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const [tx] = await txOf(m.key);
      const [inbox] = await inboxOf(String(m.envelope.messageId));
      expect(String(inbox?.payload_hash)).toBe(String(tx?.payload_hash));

      const again = await s.submit(m.body); // HTTP com a mesma chave
      expect(again).toMatchObject({
        idempotentReplay: true,
        status: WagerTransactionStatus.Processed,
      });
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
    });
  });

  test('a business rejection (no funds) is recorded and DELETED: it does not go to the DLQ', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('10.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const [tx] = await txOf(m.key);
      expect(tx).toMatchObject({ status: WagerTransactionStatus.Rejected });
      expect(await s.balanceOf(wallet)).toBe('10.00');
      expect(await h.queues.dead()).toHaveLength(0);
    });
  });

  test('a reference that has not arrived (PENDING_REFERENCE) is recorded and DELETED', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet, {
        kind: 'WIN',
        referenceExternalTransactionId: 'nobody-yet-' + uuid(),
      });
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const [tx] = await txOf(m.key);
      expect(tx).toMatchObject({
        status: WagerTransactionStatus.PendingReference,
      });
      expect(await h.queues.dead()).toHaveLength(0);
    });
  });

  test('an idempotency conflict (same key, another amount) is ACKED, and the consumer logs a warn with the ids', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const first = h.message(wallet);
      await h.queues.send(first.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();
      sharedLogs.clear();

      const clash = envelope(
        { ...first.body, money: { amount: '30.00', currency: 'BRL' } },
        {},
      );
      await h.queues.send(clash, { groupId: wallet.id });
      await h.queues.waitUntilEmpty();

      expect(await s.balanceOf(wallet)).toBe('75.00'); // só a primeira valeu
      expect(await h.queues.dead()).toHaveLength(0);
      const warns = sharedLogs.at('warn');
      expect(warns).toHaveLength(1);
      const text = JSON.stringify([
        warns[0]?.message,
        ...(warns[0]?.rest ?? []),
      ]);
      expect(text).toContain(String(clash.messageId));
      expect(text).toContain(first.key);
      expect(text).toContain('IDEMPOTENCY');
    });
  });
});

// ---- 2. transitório: não apaga, devolve com backoff, e volta a processar ---------------------

describe('transient failures: not deleted, back with a backoff, then processed', () => {
  test('the database is "down" for two deliveries, then comes back: processed ONCE, never dead-lettered', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      const uow = flaky(db().uow, 2);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start({ uow });
      await h.queues.waitUntilEmpty();

      expect(uow.runs).toBe(3);
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await h.queues.dead()).toHaveLength(0);
      // só o último passo foi um ack; os dois primeiros devolveram a visibilidade
      expect(h.gateway.deletes).toHaveLength(1);
      expect(h.gateway.visibility).toHaveLength(2);
      await assertInvariants(s.sql, wallet.id);
    });
  });

  test('the visibility goes back with the BACKOFF of the delivery (base 1 s: 2 s after the first failure)', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      const started = performance.now();
      h.start({ uow: flaky(db().uow, 1), baseSeconds: 1 });
      await h.queues.waitUntilEmpty();

      expect(h.gateway.visibility.map((v) => v.seconds)).toEqual([2]);
      expect(performance.now() - started).toBeGreaterThan(1_800); // esperou de verdade
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
    });
  });

  test('the message is still in the queue while it waits (it was NOT deleted by the failure)', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start({
        uow: new AlwaysFailingUnitOfWork(
          () => new DependencyUnavailableError('down'),
        ),
        baseSeconds: 30,
        maxReceiveCount: 5,
      });
      await waitFor(
        'the first failure to hand the message back',
        () => h.gateway.visibility.length >= 1,
      );
      expect(h.gateway.deletes).toHaveLength(0);
      const depth = await h.queues.depth();
      expect(depth.visible + depth.inFlight).toBe(1);
      expect(await txOf(m.key)).toHaveLength(0);
    });
  });

  test('a transient failure on a wallet holds back the NEXT message of the same wallet (FIFO order is kept)', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const first = h.message(wallet);
      const second = h.message(wallet);
      await h.queues.send(first.envelope, { groupId: wallet.id });
      await h.queues.send(second.envelope, { groupId: wallet.id });
      const uow = new AlwaysFailingUnitOfWork(
        () => new DependencyUnavailableError('down'),
      );
      h.start({ uow, baseSeconds: 30, maxReceiveCount: 5 });
      await waitFor(
        'the first failure',
        () => h.gateway.visibility.length >= 1,
      );
      await Bun.sleep(1_500);
      // enquanto a primeira espera, a segunda NÃO foi processada nem tentada (mesmo grupo)
      expect(uow.runs).toBe(1);
      expect(await txOf(second.key)).toHaveLength(0);
    });
  });
});

// ---- 3. permanente: DLQ por envio explícito, motivo registrado -------------------------------

describe('permanent errors go to the DLQ at once, with the reason, and the original is deleted', () => {
  test('invalid JSON: in the DLQ on the FIRST delivery, body intact, with reason and originalMessageId', async () => {
    await withHarness({}, async (h) => {
      const garbage = '{"messageId": "msg-x", ';
      const sqsId = await h.queues.send(garbage, { groupId: 'g-json' });
      h.start();
      const [dead] = await h.queues.waitForDead(1);
      await h.queues.waitUntilEmpty();

      expect(dead).toMatchObject({ body: garbage, groupId: 'g-json' });
      expect(dead?.attributes).toMatchObject({
        reason: 'INVALID_JSON',
        originalMessageId: sqsId,
      });
      expect(h.gateway.deadLettered).toHaveLength(1);
      expect(h.gateway.deadLettered[0]?.receiveCount).toBe(1); // não esperou 5 entregas
    });
  });

  test('an invalid envelope (wrong type) goes to the DLQ as INVALID_ENVELOPE', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet, {}, { type: 'SomethingElse' });
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      const [dead] = await h.queues.waitForDead(1);
      expect(dead?.attributes.reason).toBe('INVALID_ENVELOPE');
      expect(await txOf(m.key)).toHaveLength(0);
    });
  });

  test('an invalid business payload (OPENING kind) is INVALID_PAYLOAD with the failure code, nothing written', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet, { kind: 'OPENING' });
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      const [dead] = await h.queues.waitForDead(1);
      expect(dead?.attributes).toMatchObject({
        reason: 'INVALID_PAYLOAD',
        failureCode: 'UNSUPPORTED_KIND',
      });
      expect(await txOf(m.key)).toHaveLength(0);
      expect(await s.balanceOf(wallet)).toBe('100.00');
    });
  });

  test('a wallet that does not exist (WALLET_NOT_FOUND) goes to the DLQ: the operation did not finish, an operator can resend it', async () => {
    await withHarness({}, async (h) => {
      const ghost = { id: uuid(), playerId: uuid() };
      const m = h.message(ghost);
      await h.queues.send(m.envelope, { groupId: ghost.id });
      h.start();
      const [dead] = await h.queues.waitForDead(1);
      expect(dead?.attributes.reason).toBe('WALLET_NOT_FOUND');
      await h.queues.waitUntilEmpty();
    });
  });

  test('the same messageId with ANOTHER content (InboxMessageReusedError) goes to the DLQ and applies nothing', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const first = h.message(wallet);
      await h.queues.send(first.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const other = h.message(wallet);
      const reused = { ...other.envelope, messageId: first.envelope.messageId };
      await h.queues.send(reused, { groupId: wallet.id });
      const [dead] = await h.queues.waitForDead(1);
      await h.queues.waitUntilEmpty();

      expect(dead?.attributes.reason).toBe('INBOX_MESSAGE_REUSED');
      expect(await txOf(other.key)).toHaveLength(0);
      expect(await s.balanceOf(wallet)).toBe('75.00');
    });
  });

  test('a CRITICAL error goes to the DLQ at once, logged ONCE at fatal, and is never acked silently', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      // a corrida do 23505 que não se resolve na reexecução: o caso de uso a declara crítica
      const uow = new UnitOfWorkWith(db().uow, (r) => ({
        ...r,
        transactions: Object.assign(
          Object.create(r.transactions) as typeof r.transactions,
          {
            insert: () =>
              Promise.reject(new DuplicateKeyError('uq_wtx_idempotency_key')),
          },
        ),
      }));
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start({ uow });
      const [dead] = await h.queues.waitForDead(1);
      await h.queues.waitUntilEmpty();

      expect(dead?.attributes.reason).toBe('CRITICAL');
      const fatals = sharedLogs.at('fatal');
      expect(fatals).toHaveLength(1);
      const text = JSON.stringify([
        fatals[0]?.message,
        ...(fatals[0]?.rest ?? []),
      ]);
      expect(text).toContain(String(m.envelope.messageId));
      expect(await h.queues.dead()).toHaveLength(1); // e uma só vez
    });
  });

  test('if the DLQ send FAILS the original is NOT deleted: it comes back and still ends up in the DLQ (nothing is lost)', async () => {
    await withHarness({}, async (h) => {
      let failures = 0;
      h.gateway.onDeadLetter = () => {
        if (failures++ === 0)
          return Promise.reject(new Error('DLQ unreachable (injected)'));
        return Promise.resolve();
      };
      await h.queues.send('not json', { groupId: 'g-dlq-fail' });
      h.start();
      const dead = await h.queues.waitForDead(1);
      await h.queues.waitUntilEmpty();

      expect(dead).toHaveLength(1);
      expect(failures).toBe(2);
      expect(h.gateway.deletes).toHaveLength(1); // só depois do envio que deu certo
    });
  });
});

// ---- 4. o limite de tentativas ---------------------------------------------------------------

describe('the attempt limit', () => {
  test('a transient failure that never goes away is delivered exactly N times and then lands in the DLQ as RETRIES_EXHAUSTED', async () => {
    await withHarness({ maxReceiveCount: 10 }, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      const uow = new AlwaysFailingUnitOfWork(
        () => new DependencyUnavailableError('down for good'),
      );
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start({ uow, maxReceiveCount: 5 });
      const [dead] = await h.queues.waitForDead(1);
      await h.queues.waitUntilEmpty();

      expect(dead?.attributes.reason).toBe('RETRIES_EXHAUSTED');
      expect(uow.runs).toBe(5);
      expect(h.gateway.visibility).toHaveLength(4);
      expect(await txOf(m.key)).toHaveLength(0);
    });
  });

  test('the consumer limit is never above the maxReceiveCount of the redrive (the redrive is only the safety net)', async () => {
    const real = await createTestQueues({ maxReceiveCount: 10 });
    try {
      const { loadSqsConsumerConfig } =
        await import('../../src/interfaces/sqs/sqs-consumer.config.js');
      expect(loadSqsConsumerConfig({}).maxReceiveCount).toBeLessThanOrEqual(
        real.maxReceiveCount,
      );
    } finally {
      await real.close();
    }
  });
});

// ---- 5. o ack só depois do commit ------------------------------------------------------------

describe('the ack comes only after the commit', () => {
  test('at the moment of the DeleteMessage the transaction is already committed and visible to ANOTHER connection', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      const seenAtDelete: number[] = [];
      h.gateway.onDelete = async () => {
        seenAtDelete.push((await txOf(m.key)).length);
      };
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();
      expect(seenAtDelete).toEqual([1]);
    });
  });

  test('the ack is LOST after the commit (delete fails): the message comes back, is a replay, and does not debit twice', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      let attempts = 0;
      h.gateway.onDelete = () => {
        if (attempts++ === 0)
          return Promise.reject(
            new Error('connection lost before the ack (injected)'),
          );
        return Promise.resolve();
      };
      await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      expect(attempts).toBe(2);
      expect(await txOf(m.key)).toHaveLength(1);
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await s.balanceOf(wallet)).toBe('75.00');
      expect(await h.queues.dead()).toHaveLength(0);
      await assertInvariants(s.sql, wallet.id);
    });
  });
});

// ---- 6. a ordem por wallet é otimização; a garantia é do banco ------------------------------

describe('MessageGroupId = walletId is an optimisation, not the guarantee', () => {
  test('messages of one wallet (one group) are applied in the order they were sent', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const sent = Array.from({ length: 8 }, (_, i) =>
        h.message(wallet, {
          money: { amount: '1.00', currency: 'BRL' },
          roundId: `order-${i}`,
        }),
      );
      for (const m of sent)
        await h.queues.send(m.envelope, { groupId: wallet.id });
      h.start();
      await h.queues.waitUntilEmpty();

      const applied = await s.sql(
        `SELECT t.idempotency_key FROM wallet_ledger_entries l
           JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE l.wallet_id = ? AND l.wallet_version > 1 ORDER BY l.wallet_version`,
        [wallet.id],
      );
      expect(applied.map((r) => String(r.idempotency_key))).toEqual(
        sent.map((m) => m.key),
      );
    });
  });

  test('the SAME wallet spread over many groups and TWO consumers at once: the database still keeps the books right', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const sent = Array.from({ length: 20 }, () =>
        h.message(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
      );
      for (const m of sent)
        await h.queues.send(m.envelope, { groupId: `scatter-${uuid()}` });
      h.start();
      h.start();
      await h.queues.waitUntilEmpty(40_000);

      expect(await s.balanceOf(wallet)).toBe('80.00');
      expect(await s.directions(wallet.id)).toHaveLength(20);
      expect(await h.queues.dead()).toHaveLength(0);
      await assertInvariants(s.sql, wallet.id);
    });
  });
});

// ---- 7. desligar com mensagens em andamento --------------------------------------------------

describe('shutdown (what SIGTERM triggers): stop fetching, finish what runs, hand back what has not started', () => {
  test('the one in flight FINISHES and is deleted; the ones that had not started go back with visibility 0 and are processed by another consumer', async () => {
    await withHarness({}, async (h) => {
      const wallet = await s.walletWith('100.00');
      const msgs = [h.message(wallet), h.message(wallet), h.message(wallet)];
      for (const m of msgs)
        await h.queues.send(m.envelope, { groupId: wallet.id });
      const gated = new GatedUnitOfWork(db().uow);
      const consumer = h.start({ uow: gated });
      await gated.reached; // a primeira está dentro do caso de uso, parada na porta

      const stopping = consumer.stop();
      gated.release();
      const report = await stopping;

      expect(report).toMatchObject({
        drained: true,
        abandoned: 0,
        released: 2,
      });
      expect(await txOf(msgs[0]!.key)).toHaveLength(1); // terminou
      expect(await txOf(msgs[1]!.key)).toHaveLength(0); // nem começou
      expect(await txOf(msgs[2]!.key)).toHaveLength(0);
      expect(h.gateway.deletes).toHaveLength(1);
      expect(h.gateway.visibility.filter((v) => v.seconds === 0)).toHaveLength(
        2,
      );

      // outra instância assume na hora (sem esperar os 2 s de visibilidade da fila)
      const started = performance.now();
      h.start();
      await h.queues.waitUntilEmpty();
      expect(performance.now() - started).toBeLessThan(1_900);
      expect(await s.directions(wallet.id)).toEqual([
        'DEBIT',
        'DEBIT',
        'DEBIT',
      ]);
      await assertInvariants(s.sql, wallet.id);
    });
  });

  test('after stop() the consumer asks for nothing more', async () => {
    await withHarness({}, async (h) => {
      const consumer = h.start();
      await consumer.stop();
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      await Bun.sleep(2_500);
      expect(await txOf(m.key)).toHaveLength(0);
      const depth = await h.queues.depth();
      expect(depth.visible).toBe(1);
    });
  });

  test('stop() on an idle consumer in a 20 s long poll returns at once (it aborts the wait)', async () => {
    await withHarness({}, async (h) => {
      const consumer = h.start({ waitSeconds: 20 });
      await Bun.sleep(300);
      const started = performance.now();
      const report = await consumer.stop();
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(report).toMatchObject({
        drained: true,
        abandoned: 0,
        released: 0,
      });
    });
  });

  test('past the deadline the stuck message is ABANDONED (not deleted); another consumer processes it and the late one finds a replay: one debit', async () => {
    await withHarness({ visibilitySeconds: 2 }, async (h) => {
      const wallet = await s.walletWith('100.00');
      const m = h.message(wallet);
      await h.queues.send(m.envelope, { groupId: wallet.id });
      const gated = new GatedUnitOfWork(db().uow);
      const slow = h.start({ uow: gated, shutdownTimeoutMs: 300 });
      await gated.reached;

      const report = await slow.stop();
      expect(report).toMatchObject({ drained: false, abandoned: 1 });
      expect(h.gateway.deletes).toHaveLength(0);

      // a visibilidade vence, outra instância processa
      h.start({
        gateway: new RecordingGateway(h.queues.client, {
          queueUrl: h.queues.queueUrl,
          dlqUrl: h.queues.dlqUrl,
        }),
      });
      await waitFor(
        'the other consumer to commit',
        async () => (await txOf(m.key)).length === 1,
      );
      // agora a lenta acorda: acha o resultado pronto (replay)
      gated.release();
      await Bun.sleep(500);
      await h.queues.waitUntilEmpty();

      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      expect(await s.balanceOf(wallet)).toBe('75.00');
      await assertInvariants(s.sql, wallet.id);
    });
  });
});
