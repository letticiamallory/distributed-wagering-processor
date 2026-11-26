import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import type { Json } from '../support/http-app.js';
import { startInstances, type Instances } from '../support/instances.js';
import {
  expectNoProblems,
  failIfAny,
  recordMetrics,
} from '../support/ledger-check.js';
import { outboxRowsOf, quiesceOutbox } from '../support/outbox.js';
import { openPersistence, type Persistence } from '../support/persistence.js';
import { ProviderClient, mapLimit } from '../support/provider-client.js';
import { waitFor } from '../support/queues.js';

// TRÊS PROCESSOS reais, cada um com o PUBLISHER ligado, sobre a MESMA outbox, enquanto recebem
// carga por HTTP: o "dois publishers sobre a mesma outbox" do enunciado (seção 13), sob paralelismo
// real. Nenhum evento se perde; quem deduplica por eventId vê cada um uma vez; e cada wallet
// recebe a sequência COMPLETA de walletVersion (sem buracos).
let instances: Instances;
let db: Persistence;
let events: EventQueue;
const sql = (query: string, params: unknown[] = []) =>
  db.orm.em.getConnection().execute(query, params) as Promise<
    Array<Record<string, unknown>>
  >;

beforeAll(async () => {
  db = await openPersistence();
  await quiesceOutbox(sql);
  events = await createEventQueue();
  instances = await startInstances(3, {
    env: {
      OUTBOX_PUBLISHER_ENABLED: 'true',
      OUTBOX_QUEUE_NAME: events.queueName,
      OUTBOX_POLL_INTERVAL_MS: '100',
      OUTBOX_BATCH_SIZE: '5',
    },
  });
}, 120_000);
afterAll(async () => {
  await instances?.stop();
  await events?.close();
  await db?.close();
});

const bet = (
  wallet: { id: string; playerId: string },
  external: string,
): Json => ({
  providerId: 'provider-a',
  externalTransactionId: external,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '1.00', currency: 'BRL' },
});

describe('three real processes, all publishing from the same outbox', () => {
  test('30 wallets x 8 bets sent to the three instances: every event is published, none is missing, every wallet gets versions 1..9', async () => {
    const WALLETS = 30;
    const BETS = 8;
    const setup = new ProviderClient();
    const client = new ProviderClient();
    const urls = instances.urls;
    const wallets = await mapLimit(
      Array.from({ length: WALLETS }, (_, i) => i),
      10,
      (i) => setup.createWallet(urls[i % 3] as string, '1000.00'),
    );
    const started = performance.now();
    await mapLimit(
      wallets.flatMap((wallet) =>
        Array.from({ length: BETS }, (_, n) => ({ wallet, n })),
      ),
      24,
      ({ wallet, n }) =>
        client.submit(
          urls[n % 3] as string,
          bet(wallet, `ob-${Bun.randomUUIDv7()}`),
        ),
    );

    const ids = wallets.map((w) => w.id);
    // por wallet: o evento de abertura (1) + 2 por aposta (Processed e BalanceChanged)
    const expected = WALLETS * (1 + BETS * 2);
    await waitFor(
      'the three publishers to drain the outbox',
      async () => {
        const rows = await outboxRowsOf(sql, ids);
        return (
          rows.length === expected && rows.every((r) => r.published_at !== null)
        );
      },
      90_000,
    );
    await events.collect(expected, 60_000);

    const rows = await outboxRowsOf(sql, ids);
    const problems: string[] = [...(await expectNoProblems(sql, ids))];
    if (rows.length !== expected)
      problems.push(`outbox has ${rows.length} rows, expected ${expected}`);
    const unique = events.uniqueIds();
    if (unique.size !== expected)
      problems.push(
        `consumer saw ${unique.size} distinct eventIds, expected ${expected}`,
      );
    for (const row of rows) {
      if (!unique.has(String(row.id)))
        problems.push(`event ${String(row.id)} was never published`);
    }
    // por wallet: as versões do saldo chegam completas (1..BETS+1), nenhuma faltando
    for (const wallet of wallets) {
      const versions = events
        .received()
        .filter(
          (e) =>
            e.aggregateId === wallet.id &&
            e.eventType === 'WalletBalanceChanged',
        )
        .map((e) =>
          Number((e.envelope.data as { walletVersion: number }).walletVersion),
        );
      const distinct = [...new Set(versions)].sort((a, b) => a - b);
      const want = Array.from({ length: BETS + 1 }, (_, i) => i + 1);
      if (JSON.stringify(distinct) !== JSON.stringify(want)) {
        problems.push(
          `wallet ${wallet.id}: versions ${JSON.stringify(distinct)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
    failIfAny('outbox publishers x3', WALLETS * BETS, problems, {
      errors: instances.errorNames(),
    });
    recordMetrics('6 three publishers, one outbox', {
      wallets: WALLETS,
      bets: WALLETS * BETS,
      events: expected,
      receivedMessages: events.received().length,
      duplicatesDelivered: events.received().length - unique.size,
      requests: client.stats.requests,
      status503: client.stats.status503,
      elapsedMs: Math.round(performance.now() - started),
      invariants: 'OK',
    });
    expect(problems).toEqual([]);
  }, 240_000);
});
