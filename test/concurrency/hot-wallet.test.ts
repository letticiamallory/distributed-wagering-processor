import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startApp, type TestApp } from '../support/http-app.js';
import { runHotWallet } from '../support/hot-wallet.js';
import {
  countErrorNames,
  countUnavailableReasons,
  recordMetrics,
} from '../support/ledger-check.js';
import { ProviderClient } from '../support/provider-client.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

// Hot wallet: centenas de operações misturadas (BET, WIN, REFUND, ROLLBACK) na MESMA wallet, ao
// mesmo tempo, por HTTP. São mais requisições que conexões no pool, então parte delas leva 503 e
// é reenviada com a mesma Idempotency-Key, como um provedor real faria.
test('300 mixed operations on ONE wallet at the same time: never negative, the balance is what the ledger rebuilds, a resend never duplicates', async () => {
  const client = new ProviderClient();
  app.logs.clear();
  const startedAt = performance.now();

  const result = await runHotWallet({
    urls: [app.url],
    sql: app.sql,
    client,
    errorNames: () => countErrorNames(app.logs.at('error')),
  });

  expect(result.requests).toBe(290);
  expect(result.processed + result.rejected + result.pending).toBe(230);
  recordMetrics('3 hot wallet (one process)', {
    requests: result.requests,
    attempts: client.stats.attempts,
    status503: client.stats.status503,
    retries: client.stats.retries,
    reasons503: countUnavailableReasons(app.logs.at('warn')),
    jitter: client.jitter,
    processed: result.processed,
    rejected: result.rejected,
    pending: result.pending,
    seed: result.seed,
    elapsedMs: Math.round(performance.now() - startedAt),
    invariants: 'OK',
  });
}, 300_000);
