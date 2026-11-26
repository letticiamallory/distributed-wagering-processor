import { SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  IntegrationEventPublisher,
  type PublishOutcome,
} from '../../src/application/ports/integration-event-publisher.js';
import { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { PublishOutboxBatchUseCase } from '../../src/application/use-cases/publish-outbox-batch.use-case.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';
import { OutboxPublisherWorker } from '../../src/interfaces/workers/outbox-publisher.worker.js';
import { GatedUnitOfWork } from '../support/concurrency.js';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import { sharedLogs } from '../support/http-app.js';
import {
  dropWalletEvents,
  outboxRowsOf,
  quiesceOutbox,
} from '../support/outbox.js';
import {
  openPersistence,
  usePersistence,
  type Persistence,
} from '../support/persistence.js';
import { createScenario, type Wallet } from '../support/wager-scenarios.js';

const db = usePersistence();
// Relógio que o teste move: o backoff e o "devido" dependem do tempo.
const s = createScenario(db, { start: new Date() });

beforeAll(async () => {
  Logger.overrideLogger(sharedLogs);
  await quiesceOutbox(s.sql);
});
// Cada teste começa com a outbox "quieta": o que os outros deixaram não é dele (o publisher enxerga
// a tabela inteira).
beforeEach(async () => {
  sharedLogs.clear();
  await quiesceOutbox(s.sql);
});

// ---- ferramentas dos testes ------------------------------------------------------------------

// Uma wallet sem o evento de abertura na outbox: os testes contam só o que as apostas geram.
async function freshWallet(balance = '100.00'): Promise<Wallet> {
  const wallet = await s.walletWith(balance);
  await dropWalletEvents(s.sql, wallet.id);
  return wallet;
}

const sqsFor = (events: EventQueue, over: { endpoint?: string } = {}) =>
  new SqsEventPublisher(
    over.endpoint
      ? new SQSClient({ endpoint: over.endpoint, maxAttempts: 1 })
      : events.client,
    events.queueUrl,
    { timeoutMs: 5_000 },
  );

function useCaseOf(
  publisher: IntegrationEventPublisher,
  over: {
    persistence?: Persistence;
    uow?: UnitOfWork;
    batchSize?: number;
  } = {},
) {
  return new PublishOutboxBatchUseCase(
    over.uow ?? (over.persistence ?? db()).uow,
    publisher,
    s.clock,
    {
      batchSize: over.batchSize ?? 10,
      jitter: () => 0,
      stuckAfterAttempts: 10,
    },
  );
}

// `n` apostas na wallet: 2 eventos cada (Processed + BalanceChanged), gravados na outbox pela mesma
// transação do negócio.
async function betsOn(wallet: Wallet, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await s.placeBet(wallet, '1.00');
  }
}

async function drain(useCase: PublishOutboxBatchUseCase): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const report = await useCase.execute();
    if (report.claimed === 0) return;
  }
  throw new Error('the outbox never drained');
}

// Um publisher que registra o que foi enviado (por eventId) e delega ao de verdade.
class RecordingPublisher extends IntegrationEventPublisher {
  sent: string[] = [];
  constructor(private readonly inner: IntegrationEventPublisher) {
    super();
  }
  async publish(messages: readonly OutboxMessage[]) {
    const outcomes = await this.inner.publish(messages);
    for (const message of messages) {
      if (outcomes.get(message.id)?.ok) this.sent.push(message.id);
    }
    return outcomes;
  }
}

// Recusa os eventos indicados (como se o SQS tivesse falhado SÓ para eles) e envia o resto.
class PartiallyFailingPublisher extends IntegrationEventPublisher {
  constructor(
    private readonly inner: IntegrationEventPublisher,
    private readonly failing: Set<string>,
  ) {
    super();
  }
  async publish(messages: readonly OutboxMessage[]) {
    const good = messages.filter((m) => !this.failing.has(m.id));
    const outcomes = await this.inner.publish(good);
    for (const message of messages) {
      if (this.failing.has(message.id)) {
        outcomes.set(message.id, { ok: false, error: 'throttled (injected)' });
      }
    }
    return outcomes as Map<string, PublishOutcome>;
  }
}

async function withEvents(test: (events: EventQueue) => Promise<void>) {
  const events = await createEventQueue();
  try {
    await test(events);
  } finally {
    await events.close();
  }
}

// ---- 1. o fluxo feliz e o contrato da mensagem -----------------------------------------------

describe('publishing', () => {
  test('a committed bet is published: group = walletId, deduplication id = eventId, body = the outbox payload, published_at set', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      const before = await outboxRowsOf(s.sql, [wallet.id]);
      expect(before.map((r) => String(r.event_type)).sort()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(before.every((r) => r.published_at === null)).toBe(true);

      const report = await useCaseOf(sqsFor(events)).execute();
      expect(report).toMatchObject({ claimed: 2, published: 2, failed: [] });

      const received = await events.collect(2);
      expect(received).toHaveLength(2);
      for (const event of received) {
        expect(event.groupId).toBe(wallet.id);
        expect(event.deduplicationId).toBe(event.eventId);
        expect(event.aggregateId).toBe(wallet.id);
        expect(event.envelope).toMatchObject({
          version: 1,
          correlationId: expect.any(String),
          occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        });
      }
      // O corpo publicado é o payload da outbox, byte a byte do que foi gravado.
      const rows = await s.sql(
        'SELECT id, payload FROM outbox_messages WHERE aggregate_id = ?',
        [wallet.id],
      );
      for (const row of rows) {
        const event = received.find((e) => e.eventId === String(row.id));
        expect(event?.envelope).toEqual(row.payload as Record<string, unknown>);
      }
      const after = await outboxRowsOf(s.sql, [wallet.id]);
      expect(after.every((r) => r.published_at !== null)).toBe(true);
      expect(after.every((r) => Number(r.attempts) === 0)).toBe(true);
    });
  });

  test('money in the published events is MoneyProps (strings), never a number', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      await useCaseOf(sqsFor(events)).execute();
      const received = await events.collect(2);
      const changed = received.find(
        (e) => e.eventType === 'WalletBalanceChanged',
      );
      const data = changed?.envelope.data as Record<string, unknown>;
      expect(data.money).toEqual({ amount: '1.00', currency: 'BRL' });
      expect(data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(data.balanceAfter).toEqual({ amount: '99.00', currency: 'BRL' });
      expect(typeof data.walletVersion).toBe('number');
    });
  });

  test('only DUE events are claimed: published ones and ones scheduled for later are left alone', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      await s.sql(
        `UPDATE outbox_messages SET next_attempt_at = ? WHERE aggregate_id = ?`,
        [new Date(s.clock.now().getTime() + 60_000), wallet.id],
      );
      const report = await useCaseOf(sqsFor(events)).execute();
      expect(report.claimed).toBe(0);
      s.clock.advance(61_000);
      expect((await useCaseOf(sqsFor(events)).execute()).claimed).toBe(2);
      expect((await useCaseOf(sqsFor(events)).execute()).claimed).toBe(0); // já publicados
    });
  });

  test('events are claimed oldest first, at most `batchSize` per cycle', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 3); // 6 eventos
      const first = await useCaseOf(sqsFor(events), { batchSize: 4 }).execute();
      expect(first.claimed).toBe(4);
      const rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(
        rows.filter((r) => r.published_at !== null).map((r) => r.id),
      ).toEqual(
        rows.slice(0, 4).map((r) => r.id), // os 4 mais antigos
      );
    });
  });
});

// ---- 2. o SQS fora do ar e de volta ----------------------------------------------------------

describe('the broker is down, then back', () => {
  test('nothing is lost: attempts and the backoff grow, last_error is kept, and everything is published once SQS returns', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 2); // 4 eventos
      const down = sqsFor(events, { endpoint: 'http://127.0.0.1:9' });

      const t0 = s.clock.now();
      const first = await useCaseOf(down).execute();
      expect(first.published).toBe(0);
      expect(first.failed).toHaveLength(4);
      let rows = await outboxRowsOf(s.sql, [wallet.id]);
      for (const row of rows) {
        expect(row.published_at).toBeNull();
        expect(Number(row.attempts)).toBe(1);
        expect(String(row.last_error).length).toBeGreaterThan(0);
        // 1ª falha: espera 2^0 x 1 s (jitter zero no teste)
        expect(new Date(String(row.next_attempt_at)).getTime()).toBe(
          t0.getTime() + 1_000,
        );
      }

      // ainda dentro da espera: nada é tentado
      expect((await useCaseOf(down).execute()).claimed).toBe(0);

      s.clock.advance(1_000);
      await useCaseOf(down).execute(); // 2ª falha: espera 2 s
      rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(rows.every((r) => Number(r.attempts) === 2)).toBe(true);
      expect(new Date(String(rows[0]?.next_attempt_at)).getTime()).toBe(
        s.clock.now().getTime() + 2_000,
      );

      // o SQS volta
      s.clock.advance(2_000);
      const back = await useCaseOf(sqsFor(events)).execute();
      expect(back).toMatchObject({ claimed: 4, published: 4 });
      expect((await events.collect(4)).length).toBeGreaterThanOrEqual(4);
      expect(events.uniqueIds().size).toBe(4);
      rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(rows.every((r) => r.published_at !== null)).toBe(true);
    });
  });

  test('a failure for SOME events retries only those; the others are published and not repeated', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 2); // 4 eventos
      const rows = await outboxRowsOf(s.sql, [wallet.id]);
      const failing = new Set([String(rows[1]?.id), String(rows[2]?.id)]);

      const report = await useCaseOf(
        new PartiallyFailingPublisher(sqsFor(events), failing),
      ).execute();
      expect(report.published).toBe(2);
      expect(report.failed.map((f) => f.eventId).sort()).toEqual(
        [...failing].sort(),
      );

      const after = await outboxRowsOf(s.sql, [wallet.id]);
      for (const row of after) {
        if (failing.has(String(row.id))) {
          expect(row.published_at).toBeNull();
          expect(Number(row.attempts)).toBe(1);
        } else {
          expect(row.published_at).not.toBeNull();
          expect(Number(row.attempts)).toBe(0);
        }
      }
      s.clock.advance(1_000);
      expect(await useCaseOf(sqsFor(events)).execute()).toMatchObject({
        claimed: 2,
        published: 2,
      });
      await events.collect(4);
      expect(events.uniqueIds().size).toBe(4);
    });
  });

  test('a failure never touches the business: the committed transaction and the balance stay as they were', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      await useCaseOf(
        sqsFor(events, { endpoint: 'http://127.0.0.1:9' }),
      ).execute();
      expect(await s.balanceOf(wallet)).toBe('99.00');
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
    });
  });

  test('an event that keeps failing is retried FOREVER (no DLQ) and is logged at error from the 10th attempt', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      const down = sqsFor(events, { endpoint: 'http://127.0.0.1:9' });
      for (let attempt = 1; attempt <= 11; attempt++) {
        s.clock.advance(6 * 60_000); // além do teto de 5 min
        const report = await useCaseOf(down).execute();
        expect(report.failed).toHaveLength(2);
        expect(report.failed.every((f) => f.attempts === attempt)).toBe(true);
        expect(report.failed.every((f) => f.stuck === attempt >= 10)).toBe(
          true,
        );
      }
      const rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(rows.every((r) => r.published_at === null)).toBe(true); // continua lá, nunca descartado
      // O teto do backoff é de 5 minutos
      const last = new Date(String(rows[0]?.next_attempt_at)).getTime();
      expect(last - s.clock.now().getTime()).toBe(5 * 60_000);
    });
  });
});

// ---- 3. publishers concorrentes ---------------------------------------------------------------

describe('several publishers over the same outbox', () => {
  test('3 publishers (own connections) over 200 events: every event is sent exactly once, none is lost, none repeated', async () => {
    await withEvents(async (events) => {
      const wallets = await Promise.all(
        Array.from({ length: 5 }, () => freshWallet('1000.00')),
      );
      await Promise.all(wallets.map((w) => betsOn(w, 20))); // 5 x 20 x 2 = 200 eventos
      const ids = wallets.map((w) => w.id);
      expect(await outboxRowsOf(s.sql, ids)).toHaveLength(200);

      const real = sqsFor(events);
      const extra = await Promise.all([openPersistence(), openPersistence()]);
      try {
        const recorder = new RecordingPublisher(real);
        const publishers = [db(), ...extra].map((persistence) =>
          useCaseOf(recorder, { persistence, batchSize: 5 }),
        );
        await Promise.all(
          publishers.map(async (useCase) => {
            for (let i = 0; i < 100; i++) {
              if ((await useCase.execute()).claimed === 0) return;
            }
          }),
        );
        await drain(publishers[0] as PublishOutboxBatchUseCase);

        // nenhum evento foi enviado duas vezes (o SKIP LOCKED separou os lotes)
        expect(recorder.sent).toHaveLength(200);
        expect(new Set(recorder.sent).size).toBe(200);
        const rows = await outboxRowsOf(s.sql, ids);
        expect(rows.every((r) => r.published_at !== null)).toBe(true);

        await events.collect(200, 60_000);
        expect(events.uniqueIds().size).toBe(200);
        expect(new Set(rows.map((r) => String(r.id)))).toEqual(
          events.uniqueIds(),
        );
      } finally {
        await Promise.all(extra.map((p) => p.close()));
      }
    });
  }, 120_000);

  test('a publisher HOLDING rows does not block the others: they skip the locked rows (SKIP LOCKED) and take the rest', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 3); // 6 eventos
      const holderDb = await openPersistence();
      try {
        // O "publisher lento": reivindicou 3 e está parado no meio do envio (transação aberta).
        let release!: () => void;
        const until = new Promise<void>((resolve) => (release = resolve));
        let held!: () => void;
        const heldSignal = new Promise<void>((resolve) => (held = resolve));
        const holder = holderDb.uow.run(async (r) => {
          const mine = await r.outbox.claimDue(3, s.clock.now());
          expect(mine).toHaveLength(3);
          held();
          await until;
          return mine.map((m) => m.id);
        });
        await heldSignal;

        // O outro publisher NÃO espera: pega os 3 que sobraram, na hora.
        const started = performance.now();
        const fast = await useCaseOf(sqsFor(events), {
          batchSize: 10,
        }).execute();
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(fast.claimed).toBe(3);

        release();
        const heldIds = await holder;
        const sentByFast = (await outboxRowsOf(s.sql, [wallet.id]))
          .filter((r) => r.published_at !== null)
          .map((r) => String(r.id));
        expect(sentByFast.some((id) => heldIds.includes(id))).toBe(false);

        // o dono desistiu sem publicar: as 3 linhas dele continuam devidas e saem no ciclo seguinte
        expect((await useCaseOf(sqsFor(events)).execute()).claimed).toBe(3);
      } finally {
        await holderDb.close();
      }
    });
  });
});

// ---- 4. o laço do worker ----------------------------------------------------------------------

describe('the worker loop', () => {
  const options = {
    batchSize: 10,
    pollIntervalMs: 50,
    statsIntervalMs: 60_000,
    shutdownTimeoutMs: 3_000,
  };

  test('the running worker publishes what is committed, and stop() waits for the cycle in flight', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 2);
      const worker = new OutboxPublisherWorker(
        useCaseOf(sqsFor(events)),
        db().outbox,
        s.clock,
        options,
      );
      worker.start();
      await events.collect(4);
      const report = await worker.stop();
      expect(report.drained).toBe(true);
      expect(events.uniqueIds().size).toBe(4);
    });
  });

  test('stop() lets the batch in flight finish and mark published, then claims nothing more', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      const gated = new GatedUnitOfWork(db().uow);
      const worker = new OutboxPublisherWorker(
        useCaseOf(sqsFor(events), { uow: gated }),
        db().outbox,
        s.clock,
        options,
      );
      worker.start();
      await gated.reached; // o ciclo está em andamento
      const stopping = worker.stop();
      gated.release();
      expect((await stopping).drained).toBe(true);
      expect(
        (await outboxRowsOf(s.sql, [wallet.id])).every(
          (r) => r.published_at !== null,
        ),
      ).toBe(true);

      await betsOn(wallet, 1); // novos eventos depois do stop
      await Bun.sleep(400);
      const rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(rows.filter((r) => r.published_at === null)).toHaveLength(2);
    });
  });

  test('stats(): pending, due and the lag of the oldest unpublished event', async () => {
    const wallet = await freshWallet('100.00');
    await betsOn(wallet, 1);
    s.clock.advance(30_000);
    const stats = await db().outbox.stats(s.clock.now());
    expect(stats.pending).toBeGreaterThanOrEqual(2);
    expect(stats.due).toBeGreaterThanOrEqual(2);
    expect(stats.lagSeconds).toBeGreaterThanOrEqual(30);
    await quiesceOutbox(s.sql);
    expect(await db().outbox.stats(s.clock.now())).toEqual({
      pending: 0,
      due: 0,
      lagSeconds: 0,
    });
  });
});

// ---- 5. o que vai para o log ------------------------------------------------------------------

describe('logging', () => {
  test('a failing cycle logs a warn per retry, and an ERROR (once per event per attempt) from the 10th', async () => {
    await withEvents(async (events) => {
      const wallet = await freshWallet('100.00');
      await betsOn(wallet, 1);
      const down = sqsFor(events, { endpoint: 'http://127.0.0.1:9' });
      const worker = new OutboxPublisherWorker(
        useCaseOf(down),
        db().outbox,
        s.clock,
        {
          batchSize: 10,
          pollIntervalMs: 50,
          statsIntervalMs: 60_000,
          shutdownTimeoutMs: 1_000,
        },
      );
      sharedLogs.clear();
      s.clock.advance(6 * 60_000);
      await worker.tick();
      expect(sharedLogs.at('warn').length).toBeGreaterThanOrEqual(1);
      expect(sharedLogs.at('error')).toHaveLength(0);
      for (let i = 0; i < 9; i++) {
        s.clock.advance(6 * 60_000);
        await worker.tick();
      }
      const stuck = sharedLogs.mentioning('outbox_event_stuck');
      expect(stuck.length).toBeGreaterThanOrEqual(2); // os 2 eventos, na 10ª tentativa
      expect(stuck.every((entry) => entry.level === 'error')).toBe(true);
    });
  });
});
