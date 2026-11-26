import { SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, test } from 'bun:test';
import {
  DependencyUnavailableError,
  DuplicateKeyError,
} from '../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../src/application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../src/application/messaging/wager-message-handler.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { PublishOutboxBatchUseCase } from '../../src/application/use-cases/publish-outbox-batch.use-case.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';
import { registerOutboxCollector } from '../../src/infrastructure/observability/outbox-collector.js';
import { PrometheusRegistry } from '../../src/infrastructure/observability/prometheus-registry.js';
import { MikroOrmPendingReferenceQueue } from '../../src/infrastructure/persistence/repositories/mikro-orm-pending-reference.queue.js';
import { AwsQueueGateway } from '../../src/interfaces/sqs/aws-queue-gateway.js';
import { WagerSqsConsumer } from '../../src/interfaces/sqs/wager-sqs.consumer.js';
import { PendingReferenceWorker } from '../../src/interfaces/workers/pending-reference.worker.js';
import { GatedUnitOfWork, inTheWindow } from '../support/concurrency.js';
import { createEventQueue } from '../support/event-queue.js';
import { sharedLogs } from '../support/http-app.js';
import { metric } from '../support/metrics.js';
import {
  dropWalletEvents,
  parkForeignPendings,
  quiesceOutbox,
} from '../support/outbox.js';
import {
  openPersistence,
  usePersistence,
  uuid,
} from '../support/persistence.js';
import { createTestQueues, envelope, waitFor } from '../support/queues.js';
import { rejectionOf } from '../support/assertions.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

const db = usePersistence();

beforeAll(async () => {
  Logger.overrideLogger(sharedLogs);
  await quiesceOutbox(
    (q, p = []) => db().orm.em.getConnection().execute(q, p) as never,
  );
});

// Um cenário e um registro NOVOS por teste: cada contador começa do zero.
function fresh() {
  const registry = new PrometheusRegistry();
  const s = createScenario(db, { start: new Date(), metrics: registry });
  return { registry, s };
}
const countOf = (registry: PrometheusRegistry, series: string) =>
  metric(registry, series);

// ---- 1. transações, duplicatas, conflitos e latência -----------------------------------------

describe('the use case counts what it decides', () => {
  test('a processed bet: one PROCESSED/BET, and one observation in the latency histogram', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    await s.placeBet(wallet, '10.00');
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="BET"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="processed"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_sum{channel="http",outcome="processed"}',
      ),
    ).toBeGreaterThan(0);
  });

  test('a rejection (no funds) and a missing reference (pending) each have their own status', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('10.00');
    await s.placeBet(wallet, '50.00'); // REJECTED
    await s.pend(wallet, 'REFUND', ext(`missing-${uuid()}`), '5.00'); // PENDING_REFERENCE
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="REJECTED",kind="BET"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="rejected"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="pending_reference"}',
      ),
    ).toBe(1);
  });

  test('an HTTP replay is a DUPLICATE, not a new transaction', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    await s.submit(input);
    await s.submit(input);
    await s.submit(input);
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="BET"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_duplicates_total{channel="http",kind="idempotency_key_replay"}',
      ),
    ).toBe(2);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="replay"}',
      ),
    ).toBe(2);
  });

  test('a replay found only UNDER THE LOCK (a race: another request committed in between) is a duplicate, not a second transaction', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    // A requisição lenta passa pela checagem rápida (nada ainda), para na porta da transação, a
    // outra commita, e só então a lenta trava a wallet e encontra o resultado pronto.
    await inTheWindow(
      db().uow,
      (gated) => s.submit(input, {}, s.build({ uow: gated })),
      () => s.submit(input),
    );
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']); // um débito só
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="BET"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_duplicates_total{channel="http",kind="idempotency_key_replay"}',
      ),
    ).toBe(1);
  });

  test('an SQS redelivery already in the inbox is counted as an inbox redelivery', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const inbox = {
      consumerName: 'wager-transactions-consumer',
      messageId: `msg-${uuid()}`,
    };
    await s.submit(input, { inbox });
    await s.submit(input, { inbox });
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="BET"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_duplicates_total{channel="sqs",kind="inbox_redelivery"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_duplicates_total{channel="sqs",kind="idempotency_key_replay"}',
      ),
    ).toBe(0); // contou UMA vez, pela inbox
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="sqs",outcome="replay"}',
      ),
    ).toBe(1);
  });

  test('conflicts are counted by kind, and the request counts as an error in the histogram', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    await s.submit(input);
    // mesma chave, outro valor
    await rejectionOf(
      s.submit({ ...input, money: { amount: '30.00', currency: 'BRL' } }),
    );
    // mesmo id externo, outra chave
    await rejectionOf(
      s.submit(input, { idempotencyKey: `another-key-${uuid()}` }),
    );
    // o mesmo messageId com outro conteúdo
    const inbox = {
      consumerName: 'wager-transactions-consumer',
      messageId: `msg-${uuid()}`,
    };
    await s.submit(s.body(wallet), { inbox });
    await rejectionOf(s.submit(s.body(wallet), { inbox }));

    expect(
      await countOf(
        registry,
        'wager_conflicts_total{kind="idempotency_key_reused"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_conflicts_total{kind="external_id_conflict"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_conflicts_total{kind="inbox_message_reused"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="error"}',
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  test('an invalid payload is an error observation and counts no transaction', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    await rejectionOf(s.submit(s.body(wallet, { providerId: '' })));
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="BET"}',
      ),
    ).toBe(0);
    expect(
      await countOf(
        registry,
        'wager_processing_seconds_count{channel="http",outcome="error"}',
      ),
    ).toBe(1);
  });

  test('resolving a pending reference counts the FINAL status of the reversal', async () => {
    const { registry, s } = fresh();
    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`bet-${uuid()}`);
    const reversal = await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.placeBet(wallet, '25.00', betExternal);
    await s.resolveFinal(reversal.transactionId);
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PROCESSED",kind="REFUND"}',
      ),
    ).toBe(1);
    // a PENDING_REFERENCE continua contada uma vez (quando foi gravada)
    expect(
      await countOf(
        registry,
        'wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"}',
      ),
    ).toBe(1);
  });
});

// ---- 2. falhas transitórias do banco, por causa -----------------------------------------------

describe('database unavailability is counted by cause', () => {
  test('a REAL lock_timeout is counted as lock_timeout', async () => {
    const registry = new PrometheusRegistry();
    const short = await openPersistence({
      lockTimeoutMs: 300,
      metrics: registry,
    });
    try {
      const s = createScenario(() => short, {
        start: new Date(),
        metrics: registry,
      });
      const wallet = await s.walletWith('100.00');
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const heldSignal = new Promise<void>((resolve) => (held = resolve));
      const holder = short.uow.run(async (r) => {
        await r.wallets.lockById(wallet.id);
        held();
        await until;
      });
      await heldSignal;
      const error = await rejectionOf(s.submit(s.body(wallet)));
      release();
      await holder;
      expect(error).toBeInstanceOf(DependencyUnavailableError);
      expect(
        await countOf(
          registry,
          'wager_db_unavailable_total{reason="lock_timeout"}',
        ),
      ).toBe(1);
      expect(
        await countOf(
          registry,
          'wager_db_unavailable_total{reason="pool_timeout"}',
        ),
      ).toBe(0);
    } finally {
      await short.close();
    }
  });

  test('a REAL exhausted pool is counted as pool_timeout (on the fast-path read, before any transaction)', async () => {
    const registry = new PrometheusRegistry();
    const tiny = await openPersistence({
      pool: { min: 1, max: 1 },
      connectionTimeoutMillis: 200,
      metrics: registry,
    });
    try {
      const s = createScenario(() => tiny, {
        start: new Date(),
        metrics: registry,
      });
      const wallet = await s.walletWith('100.00');
      // a única conexão do pool fica presa numa transação aberta
      const gate = new GatedUnitOfWork(tiny.uow);
      void gate; // (o portão não é usado: a conexão é presa abaixo)
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const heldSignal = new Promise<void>((resolve) => (held = resolve));
      const holder = tiny.uow.run(async () => {
        held();
        await until;
      });
      await heldSignal;
      const error = await rejectionOf(s.submit(s.body(wallet)));
      release();
      await holder;
      expect(error).toBeInstanceOf(DependencyUnavailableError);
      expect(
        await countOf(
          registry,
          'wager_db_unavailable_total{reason="pool_timeout"}',
        ),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await tiny.close();
    }
  });

  test('a non-transient failure (a duplicate key that escapes) is NOT counted as unavailability', async () => {
    const registry = new PrometheusRegistry();
    const persistence = await openPersistence({ metrics: registry });
    try {
      const failing = new (class extends UnitOfWork {
        run<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
          return persistence.uow.run((r) =>
            work({
              ...r,
              transactions: Object.assign(
                Object.create(r.transactions) as typeof r.transactions,
                {
                  insert: () =>
                    Promise.reject(new DuplicateKeyError('uq_other')),
                },
              ),
            }),
          );
        }
      })();
      const s = createScenario(() => persistence, {
        start: new Date(),
        metrics: registry,
      });
      const wallet = await s.walletWith('100.00');
      await rejectionOf(
        s.submit(s.body(wallet), {}, s.build({ uow: failing })),
      );
      for (const reason of [
        'pool_timeout',
        'lock_timeout',
        'deadlock',
        'serialization',
        'connection',
        'other',
      ]) {
        expect(
          await countOf(
            registry,
            `wager_db_unavailable_total{reason="${reason}"}`,
          ),
        ).toBe(0);
      }
    } finally {
      await persistence.close();
    }
  });
});

// ---- 3. o consumidor SQS: retries, DLQ e resultado --------------------------------------------

describe('the SQS consumer counts retries, dead letters and outcomes', () => {
  async function withConsumer(
    over: { uow?: UnitOfWork },
    run: (h: {
      registry: PrometheusRegistry;
      send: (body: unknown, groupId: string) => Promise<string>;
      s: ReturnType<typeof createScenario>;
      queues: Awaited<ReturnType<typeof createTestQueues>>;
    }) => Promise<void>,
  ) {
    const registry = new PrometheusRegistry();
    const s = createScenario(db, { start: new Date(), metrics: registry });
    const queues = await createTestQueues({ visibilitySeconds: 2 });
    const consumer = new WagerSqsConsumer(
      new AwsQueueGateway(queues.client, {
        queueUrl: queues.queueUrl,
        dlqUrl: queues.dlqUrl,
      }),
      new WagerMessageHandler(
        s.build(over.uow ? { uow: over.uow } : {}),
        new ConsumerRetryPolicy({
          maxReceiveCount: 5,
          baseSeconds: 0,
          maxSeconds: 60,
        }),
      ),
      { waitSeconds: 1, batchSize: 10, shutdownTimeoutMs: 3_000 },
      registry,
    );
    consumer.start();
    try {
      await run({
        registry,
        send: (body, groupId) => queues.send(body, { groupId }),
        s,
        queues,
      });
    } finally {
      await consumer.stop();
      await queues.close();
    }
  }

  test('two transient failures then success: 2 retries, 2 "retried", 1 "acked"', async () => {
    let runs = 0;
    const flaky = new (class extends UnitOfWork {
      run<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
        return ++runs <= 2
          ? Promise.reject(new DependencyUnavailableError('db down (injected)'))
          : db().uow.run(work);
      }
    })();
    await withConsumer(
      { uow: flaky },
      async ({ registry, send, s, queues }) => {
        const wallet = await s.walletWith('100.00');
        await send(envelope(s.body(wallet)), wallet.id);
        await queues.waitUntilEmpty();
        expect(
          await countOf(registry, 'wager_retries_total{component="consumer"}'),
        ).toBe(2);
        expect(
          await countOf(registry, 'consumer_messages_total{outcome="retried"}'),
        ).toBe(2);
        expect(
          await countOf(registry, 'consumer_messages_total{outcome="acked"}'),
        ).toBe(1);
        expect(
          await countOf(
            registry,
            'wager_dlq_messages_total{reason="RETRIES_EXHAUSTED"}',
          ),
        ).toBe(0);
      },
    );
  });

  test('a message sent to the DLQ is counted by reason (and as dead_lettered)', async () => {
    await withConsumer({}, async ({ registry, send, queues }) => {
      await send('not json at all', 'g-garbage');
      await queues.waitForDead(1);
      await queues.waitUntilEmpty();
      expect(
        await countOf(
          registry,
          'wager_dlq_messages_total{reason="INVALID_JSON"}',
        ),
      ).toBe(1);
      expect(
        await countOf(
          registry,
          'consumer_messages_total{outcome="dead_lettered"}',
        ),
      ).toBe(1);
      expect(
        await countOf(registry, 'consumer_messages_total{outcome="acked"}'),
      ).toBe(0);
    });
  });

  test('a business rejection is an "acked" message, never a dead letter', async () => {
    await withConsumer({}, async ({ registry, send, s, queues }) => {
      const wallet = await s.walletWith('10.00');
      await send(envelope(s.body(wallet)), wallet.id); // 25.00 > 10.00: REJECTED
      await queues.waitUntilEmpty();
      expect(
        await countOf(registry, 'consumer_messages_total{outcome="acked"}'),
      ).toBe(1);
      expect(
        await countOf(
          registry,
          'wager_transactions_total{status="REJECTED",kind="BET"}',
        ),
      ).toBe(1);
      expect(
        await countOf(
          registry,
          'consumer_messages_total{outcome="dead_lettered"}',
        ),
      ).toBe(0);
    });
  });

  test('the same message delivered twice counts one inbox redelivery', async () => {
    await withConsumer({}, async ({ registry, send, s, queues }) => {
      const wallet = await s.walletWith('100.00');
      const message = envelope(s.body(wallet));
      await send(message, wallet.id);
      await send(message, wallet.id);
      await queues.waitUntilEmpty();
      expect(
        await countOf(
          registry,
          'wager_duplicates_total{channel="sqs",kind="inbox_redelivery"}',
        ),
      ).toBe(1);
      expect(
        await countOf(
          registry,
          'wager_transactions_total{status="PROCESSED",kind="BET"}',
        ),
      ).toBe(1);
    });
  });
});

// ---- 4. outbox e worker de pendentes -----------------------------------------------------------

describe('the outbox and the pending worker', () => {
  test('published events are counted; failures count outbox retries; the lag gauge is read AT THE SCRAPE', async () => {
    const registry = new PrometheusRegistry();
    const s = createScenario(db, { start: new Date(), metrics: registry });
    await quiesceOutbox(s.sql);
    registerOutboxCollector(registry, db().outbox, s.clock);
    const events = await createEventQueue();
    try {
      const wallet = await s.walletWith('100.00');
      await dropWalletEvents(s.sql, wallet.id);
      await s.placeBet(wallet, '1.00'); // 2 eventos devidos

      s.clock.advance(45_000);
      expect(await countOf(registry, 'outbox_pending_messages')).toBe(2);
      expect(
        await countOf(registry, 'outbox_lag_seconds'),
      ).toBeGreaterThanOrEqual(45);

      const down = new SqsEventPublisher(
        new SQSClient({ endpoint: 'http://127.0.0.1:9', maxAttempts: 1 }),
        events.queueUrl,
        { timeoutMs: 2_000 },
      );
      const options = {
        batchSize: 10,
        jitter: () => 0,
        stuckAfterAttempts: 10,
      };
      await new PublishOutboxBatchUseCase(
        db().uow,
        down,
        s.clock,
        options,
        registry,
      ).execute();
      expect(
        await countOf(registry, 'wager_retries_total{component="outbox"}'),
      ).toBe(2);
      expect(await countOf(registry, 'outbox_events_published_total')).toBe(0);
      expect(await countOf(registry, 'outbox_pending_messages')).toBe(2); // continuam lá

      s.clock.advance(2_000);
      const up = new SqsEventPublisher(events.client, events.queueUrl, {
        timeoutMs: 5_000,
      });
      await new PublishOutboxBatchUseCase(
        db().uow,
        up,
        s.clock,
        options,
        registry,
      ).execute();
      expect(await countOf(registry, 'outbox_events_published_total')).toBe(2);
      expect(await countOf(registry, 'outbox_pending_messages')).toBe(0);
      expect(await countOf(registry, 'outbox_lag_seconds')).toBe(0);
    } finally {
      await events.close();
    }
  });

  test('the pending worker counts resolved, still_pending and failed attempts', async () => {
    const registry = new PrometheusRegistry();
    const s = createScenario(db, { start: new Date(), metrics: registry });
    await parkForeignPendings(s.sql);
    const queue = new MikroOrmPendingReferenceQueue(db().orm.em);
    const worker = (uow?: UnitOfWork) =>
      new PendingReferenceWorker(
        queue,
        s.resolver(uow ? { uow } : {}),
        s.clock,
        {
          batchSize: 20,
          leaseMs: 30_000,
          pollIntervalMs: 50,
          shutdownTimeoutMs: 1_000,
        },
        registry,
      );

    const wallet = await s.walletWith('100.00');
    const betExternal = ext(`w-${uuid()}`);
    await s.pend(wallet, 'REFUND', betExternal, '25.00');
    await s.pend(wallet, 'REFUND', ext(`never-${uuid()}`), '5.00');
    await s.placeBet(wallet, '25.00', betExternal); // acorda só a primeira
    s.clock.advance(2_000);
    await worker().tick();
    expect(
      await countOf(
        registry,
        'pending_reference_resolutions_total{outcome="resolved"}',
      ),
    ).toBe(1);
    expect(
      await countOf(
        registry,
        'pending_reference_resolutions_total{outcome="still_pending"}',
      ),
    ).toBe(1);

    const flaky = new (class extends UnitOfWork {
      run<T>(): Promise<T> {
        return Promise.reject(
          new DependencyUnavailableError('db down (injected)'),
        );
      }
    })();
    s.clock.advance(60_000);
    await worker(flaky).tick();
    expect(
      await countOf(
        registry,
        'pending_reference_resolutions_total{outcome="failed"}',
      ),
    ).toBe(1);
  });
});

void waitFor;
