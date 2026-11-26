import { Logger } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { DependencyUnavailableError } from '../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../src/application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../src/application/messaging/wager-message-handler.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import type {
  ResolvePendingReferenceUseCase,
  ResolvePendingResult,
} from '../../src/application/use-cases/resolve-pending-reference.use-case.js';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { MikroOrmPendingReferenceQueue } from '../../src/infrastructure/persistence/repositories/mikro-orm-pending-reference.queue.js';
import { AwsQueueGateway } from '../../src/interfaces/sqs/aws-queue-gateway.js';
import { WagerSqsConsumer } from '../../src/interfaces/sqs/wager-sqs.consumer.js';
import { PendingReferenceWorker } from '../../src/interfaces/workers/pending-reference.worker.js';
import { GatedUnitOfWork } from '../support/concurrency.js';
import { sharedLogs } from '../support/http-app.js';
import { assertInvariants } from '../support/invariants.js';
import { parkForeignPendings } from '../support/outbox.js';
import { usePersistence, uuid } from '../support/persistence.js';
import { createTestQueues, envelope, waitFor } from '../support/queues.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

const db = usePersistence();
// 3 tentativas no total, espera de 1 s dobrando até 4 s: curto o bastante para o teste.
const schedule = new PendingReferenceSchedule({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
});
const s = createScenario(db, { start: new Date(), schedule });

beforeAll(() => {
  Logger.overrideLogger(sharedLogs);
});
// As pendentes que estes testes deixam (esperando referências que nunca chegam) NÃO podem ficar
// devidas: um app de outro teste, com o worker ligado, as resolveria e publicaria eventos alheios.
afterAll(async () => {
  await parkForeignPendings(s.sql);
});
// Cada teste começa sem pendentes alheias devidas (o worker enxerga a tabela inteira).
beforeEach(async () => {
  await parkForeignPendings(s.sql);
});

const queue = () => new MikroOrmPendingReferenceQueue(db().orm.em);
const LEASE_MS = 30_000;

function workerOf(
  resolver: Pick<ResolvePendingReferenceUseCase, 'execute'> = s.resolver(),
  over: { pollIntervalMs?: number; shutdownTimeoutMs?: number } = {},
) {
  return new PendingReferenceWorker(queue(), resolver, s.clock, {
    batchSize: 20,
    leaseMs: LEASE_MS,
    pollIntervalMs: over.pollIntervalMs ?? 50,
    shutdownTimeoutMs: over.shutdownTimeoutMs ?? 3_000,
  });
}

const rowOf = (id: string) =>
  s.one(
    'SELECT status, attempts, next_attempt_at, failure_code, balance_after FROM wager_transactions WHERE id = ?',
    [id],
  );

// ---- a reserva -------------------------------------------------------------------------------

describe('reserving work (no wallet lock: it only writes the scheduling column)', () => {
  test('reserves due pendings with a lease; a second worker gets nothing until the lease ends', async () => {
    const wallet = await s.walletWith('100.00');
    const a = await s.pend(wallet, 'REFUND', ext('never-a'));
    const b = await s.pend(wallet, 'REFUND', ext('never-b'));
    s.clock.advance(60_000); // as duas vencem (a espera de 1 s já passou)

    const first = await queue().reserveDue(20, LEASE_MS, s.clock.now());
    const mine = first.filter((r) =>
      [a.transactionId, b.transactionId].includes(r.transactionId),
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.walletId === wallet.id)).toBe(true);

    // o lease: next_attempt_at agora + 30 s, e só isso mudou
    const row = await rowOf(a.transactionId);
    expect(new Date(String(row.next_attempt_at)).getTime()).toBe(
      s.clock.now().getTime() + LEASE_MS,
    );
    expect(row).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      failure_code: null,
    });
    expect(Number(row.attempts)).toBe(
      Number((await rowOf(b.transactionId)).attempts),
    );

    expect(await queue().reserveDue(20, LEASE_MS, s.clock.now())).toEqual([]);
    s.clock.advance(LEASE_MS + 1);
    const again = await queue().reserveDue(20, LEASE_MS, s.clock.now());
    expect(again.map((r) => r.transactionId)).toEqual(
      expect.arrayContaining([a.transactionId, b.transactionId]),
    );
  });

  test('only PENDING_REFERENCE rows, never a terminal one, and at most `limit`', async () => {
    const wallet = await s.walletWith('100.00');
    const done = await s.placeBet(wallet, '1.00'); // PROCESSED
    const pendings = [];
    for (let i = 0; i < 3; i++) {
      pendings.push(await s.pend(wallet, 'REFUND', ext(`lim-${i}-${uuid()}`)));
    }
    s.clock.advance(60_000);
    const got = await queue().reserveDue(2, LEASE_MS, s.clock.now());
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.transactionId)).not.toContain(done.transactionId);
  });
});

// ---- REFUND e ROLLBACK antes da BET ------------------------------------------------------------

describe('a reversal that arrives BEFORE its bet', () => {
  test.each(['REFUND', 'ROLLBACK'] as const)(
    'a %s is recorded as pending, and when the bet arrives the worker resolves it: balance and ledger are right',
    async (kind) => {
      const wallet = await s.walletWith('100.00');
      const betExternal = ext(`bet-${kind}-${uuid()}`);
      const reversal = await s.pend(wallet, kind, betExternal, '25.00');
      expect(reversal.status).toBe(WagerTransactionStatus.PendingReference);
      expect(await s.balanceOf(wallet)).toBe('100.00'); // nada se moveu

      const bet = await s.placeBet(wallet, '25.00', betExternal); // acorda a pendente
      expect(await s.balanceOf(wallet)).toBe('75.00');

      const report = await workerOf().tick();
      expect(report).toMatchObject({ resolved: 1, failed: 0 });
      expect(await rowOf(reversal.transactionId)).toMatchObject({
        status: WagerTransactionStatus.Processed,
      });
      expect(await s.balanceOf(wallet)).toBe('100.00');
      expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      await assertInvariants(s.sql, wallet.id);
    },
  );

  test.each(['REFUND', 'ROLLBACK'] as const)(
    'the %s delivered by SQS before the bet: acked as pending, then resolved by the running worker after the bet message',
    async (kind) => {
      const queues = await createTestQueues({ visibilitySeconds: 2 });
      const consumer = new WagerSqsConsumer(
        new AwsQueueGateway(queues.client, {
          queueUrl: queues.queueUrl,
          dlqUrl: queues.dlqUrl,
        }),
        new WagerMessageHandler(
          s.build(),
          new ConsumerRetryPolicy({
            maxReceiveCount: 5,
            baseSeconds: 0,
            maxSeconds: 60,
          }),
        ),
        { waitSeconds: 1, batchSize: 10, shutdownTimeoutMs: 3_000 },
      );
      const worker = workerOf(s.resolver(), { pollIntervalMs: 100 });
      try {
        const wallet = await s.walletWith('100.00');
        const betExternal = ext(`sqs-${kind}-${uuid()}`);
        const reversal = s.body(wallet, {
          kind,
          referenceExternalTransactionId: betExternal,
        });
        consumer.start();
        worker.start();

        await queues.send(envelope(reversal), { groupId: wallet.id });
        await waitFor('the reversal to be recorded as pending', async () => {
          const rows = await s.sql(
            'SELECT status FROM wager_transactions WHERE idempotency_key = ?',
            [s.keyOf(reversal)],
          );
          return rows[0]?.status === WagerTransactionStatus.PendingReference;
        });
        await queues.waitUntilEmpty(); // a mensagem foi apagada: a transação está segura no banco
        expect(await s.balanceOf(wallet)).toBe('100.00');

        const bet = s.body(wallet, { externalTransactionId: betExternal });
        await queues.send(envelope(bet), { groupId: wallet.id });
        await waitFor('the worker to resolve the reversal', async () => {
          const rows = await s.sql(
            'SELECT status FROM wager_transactions WHERE idempotency_key = ?',
            [s.keyOf(reversal)],
          );
          return rows[0]?.status === WagerTransactionStatus.Processed;
        });
        await queues.waitUntilEmpty();

        expect(await s.balanceOf(wallet)).toBe('100.00');
        expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
        expect(await queues.dead()).toHaveLength(0);
        await assertInvariants(s.sql, wallet.id);
      } finally {
        await worker.stop();
        await consumer.stop();
        await queues.close();
      }
    },
    60_000,
  );

  test('if the wake was missed, the SCHEDULE alone resolves it once it is due', async () => {
    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`late-${uuid()}`);
    const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.placeBet(wallet, '25.00', betExternal);
    // simula um acordar perdido: a pendente volta a esperar uma hora
    await s.sql(
      `UPDATE wager_transactions SET next_attempt_at = ? WHERE id = ?`,
      [new Date(s.clock.now().getTime() + 3_600_000), reversal.transactionId],
    );
    expect(await workerOf().tick()).toMatchObject({ reserved: 0 });
    expect((await rowOf(reversal.transactionId)).status).toBe(
      'PENDING_REFERENCE',
    );

    s.clock.advance(3_601_000);
    expect(await workerOf().tick()).toMatchObject({ resolved: 1 });
    expect((await rowOf(reversal.transactionId)).status).toBe('PROCESSED');
    await assertInvariants(s.sql, wallet.id);
  });

  test('a reference that NEVER arrives: after the attempts it is REJECTED (REFERENCE_NOT_FOUND) with the rejection event in the outbox', async () => {
    const wallet = await s.walletWith('100.00');
    const reversal = await s.pend(
      wallet,
      'REFUND',
      ext(`ghost-${uuid()}`),
      '25.00',
    );
    let rounds = 0;
    for (; rounds < 6; rounds++) {
      s.clock.advance(10_000);
      await workerOf().tick();
      if ((await rowOf(reversal.transactionId)).status !== 'PENDING_REFERENCE')
        break;
    }
    expect(rounds).toBeLessThan(3); // 3 tentativas no total, a 1ª foi a gravação
    expect(await rowOf(reversal.transactionId)).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await s.balanceOf(wallet)).toBe('100.00');
    expect(await s.eventTypesOf(reversal.transactionId)).toContain(
      'WagerTransactionRejected',
    );
    await assertInvariants(s.sql, wallet.id);
  });
});

// ---- vários workers ---------------------------------------------------------------------------

class CountingResolver {
  outcomes = new Map<string, string[]>();
  constructor(
    private readonly inner: Pick<ResolvePendingReferenceUseCase, 'execute'>,
  ) {}
  async execute(
    input: { transactionId: string },
    context: { correlationId: string },
  ): Promise<ResolvePendingResult> {
    const result = await this.inner.execute(input, context);
    const list = this.outcomes.get(input.transactionId) ?? [];
    list.push(result.outcome);
    this.outcomes.set(input.transactionId, list);
    return result;
  }
}

describe('several workers', () => {
  test('3 workers over 30 due pendings: every one is resolved EXACTLY once and nobody collides on the same item', async () => {
    const counting = new CountingResolver(s.resolver());
    const pendings: Array<{
      id: string;
      walletId: string;
      wallet: { id: string; playerId: string };
    }> = [];
    for (let i = 0; i < 30; i++) {
      const wallet = await s.walletWith('100.00');
      const betExternal = ext(`multi-${i}-${uuid()}`);
      const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
      await s.placeBet(wallet, '25.00', betExternal);
      pendings.push({
        id: reversal.transactionId,
        walletId: wallet.id,
        wallet,
      });
    }

    const workers = [
      workerOf(counting),
      workerOf(counting),
      workerOf(counting),
    ];
    await Promise.all(
      workers.map(async (worker) => {
        for (let i = 0; i < 50; i++) {
          if ((await worker.tick()).reserved === 0) return;
        }
      }),
    );

    for (const pending of pendings) {
      // uma única chamada, e ela resolveu: nenhum NOT_PENDING (que seria o sinal de dois workers
      // no mesmo item)
      expect(counting.outcomes.get(pending.id)).toEqual(['RESOLVED']);
      expect(await rowOf(pending.id)).toMatchObject({ status: 'PROCESSED' });
      expect(await s.directions(pending.walletId)).toEqual(['DEBIT', 'CREDIT']);
      expect(await s.balanceOf(pending.wallet)).toBe('100.00');
    }
  }, 120_000);

  test('a worker that dies after reserving: nobody else takes the item until the lease ends, then another worker resolves it', async () => {
    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`dead-${uuid()}`);
    const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.placeBet(wallet, '25.00', betExternal);

    // o "worker A" reserva e morre sem resolver
    const reserved = await queue().reserveDue(20, LEASE_MS, s.clock.now());
    expect(reserved.map((r) => r.transactionId)).toContain(
      reversal.transactionId,
    );

    expect(await workerOf().tick()).toMatchObject({ reserved: 0 });
    expect((await rowOf(reversal.transactionId)).status).toBe(
      'PENDING_REFERENCE',
    );

    s.clock.advance(LEASE_MS + 1_000);
    expect(await workerOf().tick()).toMatchObject({ resolved: 1 });
    expect((await rowOf(reversal.transactionId)).status).toBe('PROCESSED');
  });
});

// ---- falhas e encerramento --------------------------------------------------------------------

describe('failures and shutdown', () => {
  test('a transient database error does NOT burn an attempt: the item is retried after the lease', async () => {
    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`flaky-${uuid()}`);
    const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.placeBet(wallet, '25.00', betExternal);
    const attemptsBefore = Number(
      (await rowOf(reversal.transactionId)).attempts,
    );

    let runs = 0;
    const flaky = new (class extends UnitOfWork {
      run<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
        return ++runs === 1
          ? Promise.reject(new DependencyUnavailableError('db down (injected)'))
          : db().uow.run(work);
      }
    })();
    const report = await workerOf(s.resolver({ uow: flaky })).tick();
    expect(report).toMatchObject({ failed: 1, resolved: 0 });
    expect(await rowOf(reversal.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
    });
    expect(Number((await rowOf(reversal.transactionId)).attempts)).toBe(
      attemptsBefore,
    );

    s.clock.advance(LEASE_MS + 1_000);
    expect(await workerOf(s.resolver({ uow: flaky })).tick()).toMatchObject({
      resolved: 1,
    });
  });

  test('stop() lets the item in flight finish (the money decision is whole), then asks for nothing more', async () => {
    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`stop-${uuid()}`);
    const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.placeBet(wallet, '25.00', betExternal);

    const gated = new GatedUnitOfWork(db().uow);
    const worker = workerOf(s.resolver({ uow: gated }));
    worker.start();
    await gated.reached; // a resolução está em andamento
    const stopping = worker.stop();
    gated.release();
    expect((await stopping).drained).toBe(true);
    expect((await rowOf(reversal.transactionId)).status).toBe('PROCESSED');
    await assertInvariants(s.sql, wallet.id);

    // depois do stop, uma nova pendente devida NÃO é tocada
    const betTwo = ext(`stop2-${uuid()}`);
    const second = await s.pend(wallet, 'REFUND', betTwo, '10.00');
    await s.placeBet(wallet, '10.00', betTwo);
    await Bun.sleep(400);
    expect((await rowOf(second.transactionId)).status).toBe(
      'PENDING_REFERENCE',
    );
  });
});
