import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnApp, type AppProcess } from '../support/app-process.js';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import { assertInvariants } from '../support/invariants.js';
import {
  outboxRowsOf,
  parkForeignPendings,
  quiesceOutbox,
} from '../support/outbox.js';
import { usePersistence, uuid } from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
} from '../support/queues.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

// Lista de uuids no formato de array do Postgres (o ? do MikroORM expande arrays JS em vírgulas).
const uuidList = (ids: string[]) => `{${ids.join(',')}}`;

const db = usePersistence();
const s = createScenario(db, { start: new Date() });

let queues: TestQueues;
let events: EventQueue;
beforeAll(async () => {
  // O publisher e o worker dos apps enxergam a tabela INTEIRA: o que os outros testes deixaram
  // (eventos não publicados, pendentes vencendo) não pode entrar na fila deste teste.
  await quiesceOutbox(s.sql);
  await parkForeignPendings(s.sql);
  queues = await createTestQueues({ visibilitySeconds: 2 });
  events = await createEventQueue();
}, 30_000);
afterAll(async () => {
  await queues?.close();
  await events?.close();
});

// O serviço INTEIRO (consumidor SQS, publisher da outbox e worker de pendentes, num processo só)
// é morto com SIGKILL no meio do trabalho, duas vezes, e reiniciado. No fim a consistência é
// provada pelo ledger: saldo == o que o ledger reconstrói, nenhuma transação pendente, todo evento
// confirmado publicado.
describe('restarting the whole service in the middle of the work', () => {
  const WALLETS = 40;

  const appEnv = () => ({
    SQS_CONSUMER_ENABLED: 'true',
    SQS_QUEUE_NAME: queues.queueName,
    SQS_DLQ_NAME: queues.dlqName,
    SQS_WAIT_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '0',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_QUEUE_NAME: events.queueName,
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_WORKER_ENABLED: 'true',
    PENDING_WORKER_POLL_INTERVAL_MS: '200',
    PENDING_WORKER_LEASE_MS: '2000',
    PENDING_REFERENCE_BASE_DELAY_MS: '300',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  });

  test('two kills (SIGKILL) and three starts later: balance == ledger on every wallet, nothing pending, every event published', async () => {
    // Por carteira, NESTA ordem: o REFUND da segunda aposta chega ANTES dela; depois as apostas e o WIN.
    //   100 - 25 (x1) - 10 (x2) + 10 (REFUND de x2) + 80 (WIN de x1) = 155
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => s.walletWith('100.00')),
    );
    for (const wallet of wallets) {
      const x1 = ext(`x1-${uuid()}`);
      const x2 = ext(`x2-${uuid()}`);
      const messages = [
        s.body(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: x2,
          money: { amount: '10.00', currency: 'BRL' },
        }),
        s.body(wallet, {
          externalTransactionId: x1,
          money: { amount: '25.00', currency: 'BRL' },
        }),
        s.body(wallet, {
          externalTransactionId: x2,
          money: { amount: '10.00', currency: 'BRL' },
        }),
        s.body(wallet, {
          kind: 'WIN',
          referenceExternalTransactionId: x1,
          money: { amount: '80.00', currency: 'BRL' },
        }),
      ];
      for (const message of messages) {
        await queues.send(envelope(message), { groupId: wallet.id });
      }
    }
    const ids = wallets.map((w) => w.id);
    const total = WALLETS * 4;
    const done = async () =>
      Number(
        (
          await s.sql(
            'SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ANY(?::uuid[]) AND kind <> ?',
            [uuidList(ids), 'OPENING'],
          )
        )[0]?.n,
      );

    const progressAtKill: number[] = [];
    const runUntil = async (app: AppProcess, atLeast: number) => {
      await app.waitReady();
      await waitFor(
        `${atLeast} transactions recorded`,
        async () => (await done()) >= atLeast,
        90_000,
      );
      progressAtKill.push(await done());
      await app.kill();
    };

    await runUntil(spawnApp(appEnv()), Math.round(total * 0.2));
    await runUntil(spawnApp(appEnv()), Math.round(total * 0.6));
    // As duas quedas foram NO MEIO do trabalho (senão o teste não provaria nada).
    expect(progressAtKill[0]).toBeLessThan(total);
    expect(progressAtKill[1]).toBeLessThan(total);

    const last = spawnApp(appEnv());
    try {
      await last.waitReady();
      await waitFor(
        'every wallet to reach its final balance',
        async () => {
          const rows = await s.sql(
            'SELECT count(*)::int AS n FROM wallets WHERE id = ANY(?::uuid[]) AND balance = ?',
            [uuidList(ids), '155.00'],
          );
          return Number(rows[0]?.n) === WALLETS;
        },
        120_000,
      );
      await queues.waitUntilEmpty(60_000);
      await waitFor(
        'every event to be published',
        async () => {
          const rows = await s.sql(
            'SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ANY(?::uuid[]) AND published_at IS NULL',
            [uuidList(ids)],
          );
          return Number(rows[0]?.n) === 0;
        },
        60_000,
      );
    } finally {
      await last.kill();
    }

    // ---- a prova pelo ledger
    for (const wallet of wallets) {
      await assertInvariants(s.sql, wallet.id); // saldo == ledger, corrente sem buracos, nunca negativo
      expect(await s.balanceOf(wallet)).toBe('155.00');
      const transactions = await s.sql(
        'SELECT status FROM wager_transactions WHERE wallet_id = ? AND kind <> ?',
        [wallet.id, 'OPENING'],
      );
      expect(transactions).toHaveLength(4);
      expect(transactions.every((t) => t.status === 'PROCESSED')).toBe(true); // nada ficou pendente
    }
    expect(await queues.dead()).toHaveLength(0);

    // ---- todo evento confirmado foi publicado, e quem deduplica por eventId vê cada um uma vez
    const rows = await outboxRowsOf(s.sql, ids);
    expect(rows.length).toBeGreaterThanOrEqual(WALLETS * 8);
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
    await events.collect(rows.length, 60_000);
    const expected = new Set(rows.map((r) => String(r.id)));
    const got = events.uniqueIds();
    const missing = [...expected].filter((id) => !got.has(id));
    const foreign = events
      .received()
      .filter((e) => !expected.has(e.eventId))
      .map((e) => `${e.eventType} of ${e.aggregateId}`);
    expect({ missing: missing.length, foreign }).toEqual({
      missing: 0,
      foreign: [],
    });
  }, 300_000);
});
