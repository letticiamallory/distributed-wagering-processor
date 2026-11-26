import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProviderIdentityPort } from '../../src/application/ports/provider-identity.port.js';
import {
  createWalletVia,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import { parseMetrics } from '../support/metrics.js';
import { RejectEverythingPort } from '../support/provider-identity.js';

let app: TestApp;
let locked: TestApp;

beforeAll(async () => {
  app = await startApp();
  locked = await startApp({
    overrides: [[ProviderIdentityPort, new RejectEverythingPort()]],
  });
}, 60_000);
afterAll(async () => {
  await app.close();
  await locked.close();
});

const scrape = async (target: TestApp = app) => {
  const response = await target.get('/metrics');
  return { response, series: parseMetrics(response.text) };
};

describe('GET /metrics', () => {
  test('answers in the Prometheus text format and lists every series of the catalog', async () => {
    const { response } = await scrape();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('content-type')).toContain('version=0.0.4');
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_conflicts_total',
      'wager_processing_seconds',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_db_unavailable_total',
      'outbox_lag_seconds',
      'outbox_pending_messages',
      'http_requests_total',
      'wallet_reconciliation_divergences',
      'wallet_reconciliation_last_run_timestamp_seconds',
    ]) {
      expect(response.text).toContain(`# TYPE ${name} `);
    }
  });

  test('is OPEN, like /health: no credential, even with an identity provider that refuses everything', async () => {
    expect((await locked.get('/metrics')).status).toBe(200);
    expect((await locked.get('/health/live')).status).toBe(200);
    expect((await locked.post('/wallets', {})).status).toBe(401); // o negócio continua fechado
  });

  test('counts what the API did: a processed bet, a replay, a rejection, an unknown wallet', async () => {
    const before = (await scrape()).series;
    const wallet = await createWalletVia(app, '100.00');
    const bet = wagerBody(wallet, {
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect((await submitVia(app, bet)).status).toBe(201);
    expect((await submitVia(app, bet)).status).toBe(200); // replay
    expect(
      (
        await submitVia(
          app,
          wagerBody(wallet, { money: { amount: '500.00', currency: 'BRL' } }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await submitVia(
          app,
          wagerBody({ id: crypto.randomUUID(), playerId: wallet.playerId }),
        )
      ).status,
    ).toBe(404);
    const after = (await scrape()).series;
    const grew = (series: string) =>
      (after[series] ?? 0) - (before[series] ?? 0);

    expect(
      grew('wager_transactions_total{status="PROCESSED",kind="BET"}'),
    ).toBe(1);
    expect(grew('wager_transactions_total{status="REJECTED",kind="BET"}')).toBe(
      1,
    );
    expect(
      grew(
        'wager_duplicates_total{channel="http",kind="idempotency_key_replay"}',
      ),
    ).toBe(1);
    expect(
      grew(
        'http_requests_total{method="POST",route="/wagering/transactions",status="201"}',
      ),
    ).toBe(1);
    expect(
      grew(
        'http_requests_total{method="POST",route="/wagering/transactions",status="200"}',
      ),
    ).toBe(1);
    expect(
      grew(
        'http_requests_total{method="POST",route="/wagering/transactions",status="422"}',
      ),
    ).toBe(1);
    expect(
      grew(
        'http_requests_total{method="POST",route="/wagering/transactions",status="404"}',
      ),
    ).toBe(1);
    expect(
      grew(
        'http_request_duration_seconds_count{method="POST",route="/wagering/transactions"}',
      ),
    ).toBe(4);
  });

  test('a route that does not exist is one "unmatched" series, not a series per URL (no cardinality explosion)', async () => {
    for (let i = 0; i < 5; i++) await app.get(`/nope/${crypto.randomUUID()}`);
    const { series, response } = await scrape();
    expect(
      series[
        'http_requests_total{method="GET",route="unmatched",status="404"}'
      ],
    ).toBeGreaterThanOrEqual(5);
    expect(response.text).not.toContain('/nope/');
  });

  test('exposes the outbox lag and pending count, read at the scrape (the publisher is off in tests)', async () => {
    const wallet = await createWalletVia(app, '100.00');
    await submitVia(app, wagerBody(wallet));
    const { series } = await scrape();
    expect(series.outbox_pending_messages).toBeGreaterThanOrEqual(3);
    expect(series.outbox_lag_seconds).toBeGreaterThanOrEqual(0);
  });

  test('the reconciliation series exist (with no samples yet): the metric is ready for phase 8', async () => {
    const { response } = await scrape();
    expect(response.text).toContain(
      '# TYPE wallet_reconciliation_divergences gauge',
    );
    expect(response.text).toContain(
      '# TYPE wallet_reconciliation_runs_total counter',
    );
  });

  test('the response never carries a payload, a balance or an id of a player', async () => {
    const wallet = await createWalletVia(app, '321.45');
    await submitVia(
      app,
      wagerBody(wallet, { money: { amount: '77.77', currency: 'BRL' } }),
    );
    const { response } = await scrape();
    expect(response.status).toBe(200);
    for (const secret of ['321.45', '77.77', wallet.playerId, wallet.id]) {
      expect(response.text).not.toContain(secret);
    }
  });
});
