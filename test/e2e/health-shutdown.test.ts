import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HealthService } from '../../src/interfaces/http/health/health.service.js';
import { startApp, type TestApp } from '../support/http-app.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

// Quando o processo recebe o SIGTERM ele ainda leva alguns segundos terminando o que está em
// andamento. Nesse tempo o balanceador não pode mandar tráfego novo: o ready passa a dizer 503.
// O live continua 200, porque o processo está vivo (e o orquestrador não deve matá-lo antes da hora).
describe('GET /health/ready while the process is shutting down', () => {
  test('is 200 before, 503 "shutting_down" after the shutdown starts, and /health/live stays 200', async () => {
    expect((await app.get('/health/ready')).status).toBe(200);

    app.nest.get(HealthService, { strict: false }).markShuttingDown();

    const ready = await app.get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'shutting_down', checks: {} });
    expect(ready.headers.get('retry-after')).not.toBeNull();
    expect((await app.get('/health/live')).status).toBe(200);
  });

  test('the answer does not wait for the dependencies (it is immediate)', async () => {
    const started = performance.now();
    await app.get('/health/ready');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
