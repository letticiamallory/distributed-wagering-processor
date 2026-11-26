import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import {
  createWalletVia,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import {
  outboxRowsOf,
  parkForeignPendings,
  quiesceOutbox,
} from '../support/outbox.js';
import { openPersistence } from '../support/persistence.js';
import { waitFor } from '../support/queues.js';

// A aplicação inteira (AppModule) com o publisher e o worker LIGADOS, pela API HTTP de verdade.
let events: EventQueue;
let app: TestApp;
let closed = false;

beforeAll(async () => {
  events = await createEventQueue();
  // O app enxerga a tabela inteira: o que sobrou dos outros testes é dado como publicado ANTES.
  const before = await openPersistence();
  await quiesceOutbox((q, p = []) =>
    before.orm.em.getConnection().execute(q, p),
  );
  await parkForeignPendings((q, p = []) =>
    before.orm.em.getConnection().execute(q, p),
  );
  await before.close();
  app = await startApp({
    env: {
      OUTBOX_PUBLISHER_ENABLED: 'true',
      OUTBOX_QUEUE_NAME: events.queueName,
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_WORKER_ENABLED: 'true',
      PENDING_WORKER_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_BASE_DELAY_MS: '300',
      PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    },
  });
}, 60_000);
afterAll(async () => {
  if (!closed) await app.close();
  await events.close();
});

describe('the Nest application with the publisher and the pending worker switched on', () => {
  test('a bet over HTTP is published by the app, and a REFUND sent before its bet is resolved by the worker', async () => {
    const wallet = await createWalletVia(app, '100.00');
    const bet = wagerBody(wallet, {
      money: { amount: '25.00', currency: 'BRL' },
    });
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '25.00', currency: 'BRL' },
    });

    const early = await submitVia(app, refund);
    expect(early.status).toBe(202); // PENDING_REFERENCE
    const betResponse = await submitVia(app, bet);
    expect(betResponse.status).toBe(201);

    await waitFor(
      'the worker to resolve the refund',
      async () => {
        const rows = await app.sql(
          'SELECT status FROM wager_transactions WHERE wallet_id = ? AND kind = ?',
          [wallet.id, 'REFUND'],
        );
        return rows[0]?.status === 'PROCESSED';
      },
      30_000,
    );
    const balance = await app.sql('SELECT balance FROM wallets WHERE id = ?', [
      wallet.id,
    ]);
    expect(String(balance[0]?.balance)).toBe('100.00');

    // Abertura da wallet (1) + PendingReference (REFUND) + Processed e BalanceChanged da BET (2)
    // + Processed e BalanceChanged do REFUND resolvido (2) = 6
    await waitFor(
      'the outbox to be fully published',
      async () => {
        const rows = await outboxRowsOf(app.sql, [wallet.id]);
        return rows.length === 6 && rows.every((r) => r.published_at !== null);
      },
      30_000,
    );
    await events.collect(6);
    expect(events.uniqueIds().size).toBe(6);
  }, 60_000);

  test('closing the app stops both workers (each logs that it drained), and nothing is published afterwards', async () => {
    const wallet = await createWalletVia(app, '100.00');
    await app.close();
    closed = true;

    for (const event of [
      'outbox_publisher_stopped',
      'pending_worker_stopped',
    ]) {
      const logs = app.logs.mentioning(event);
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs[0]?.message)).toContain('"drained":true');
    }

    // um evento novo, gravado depois do fechamento, fica sem publicar
    const after = await openPersistence();
    try {
      const { createScenario } = await import('../support/wager-scenarios.js');
      const s = createScenario(() => after, { start: new Date() });
      await s.placeBet({ id: wallet.id, playerId: wallet.playerId }, '1.00');
      const before = events.received().length;
      await events.listen(1_500);
      expect(events.received().length).toBe(before);
      const rows = await outboxRowsOf(s.sql, [wallet.id]);
      expect(
        rows.filter((r) => r.published_at === null).length,
      ).toBeGreaterThan(0);
    } finally {
      await after.close();
    }
  }, 60_000);
});
