import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProviderIdentityPort } from '../../src/application/ports/provider-identity.port.js';
import { spawnApp, type AppProcess } from '../support/app-process.js';
import {
  dockerAvailable,
  startMiniStack,
  startPostgres,
  type Disposable,
} from '../support/docker-deps.js';
import { startApp, type TestApp } from '../support/http-app.js';
import { waitFor } from '../support/queues.js';
import { RejectEverythingPort } from '../support/provider-identity.js';

// ---- com as dependências do ambiente de teste (de pé) ------------------------------------------

describe('GET /health/ready with healthy dependencies', () => {
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

  test('is 200 and names what it checked', async () => {
    const response = await app.get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  test('is open (no credential), like /health/live', async () => {
    expect((await locked.get('/health/ready')).status).toBe(200);
  });

  test('/health/live stays the plain "the process is alive"', async () => {
    const response = await app.get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

// ---- com as dependências DERRUBADAS de verdade -------------------------------------------------

const withDocker = dockerAvailable() ? describe : describe.skip;

withDocker(
  'GET /health/ready with the dependencies REALLY brought down (throwaway containers)',
  () => {
    let postgres: Disposable;
    let sqs: Disposable;
    let app: AppProcess;

    const ready = async () => {
      const response = await fetch(`${app.url}/health/ready`);
      const text = await response.text();
      return {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        text,
        body: (text.startsWith('{') ? JSON.parse(text) : {}) as {
          status: string;
          checks: Record<string, string>;
        },
      };
    };
    const waitForReady = (status: number) =>
      waitFor(
        `/health/ready to answer ${status}`,
        async () => (await ready()).status === status,
        60_000,
      );

    beforeAll(async () => {
      postgres = startPostgres();
      sqs = startMiniStack();
      // a imagem pode ter de ser baixada; os dois sobem em paralelo
      await waitFor(
        'the throwaway dependencies to accept connections',
        async () => {
          try {
            const [pg, ms] = await Promise.all([
              fetch(`http://127.0.0.1:${sqs.port}/_ministack/health`).then(
                (r) => r.ok,
              ),
              Bun.connect({
                hostname: '127.0.0.1',
                port: postgres.port,
                socket: {
                  data() {},
                  open(s) {
                    s.end();
                  },
                },
              }).then(() => true),
            ]);
            return pg && ms;
          } catch {
            return false;
          }
        },
        120_000,
      );
      app = spawnApp({
        DATABASE_URL: `postgres://wallet:wallet@127.0.0.1:${postgres.port}/wallet`,
        SQS_ENDPOINT: `http://127.0.0.1:${sqs.port}`,
        DB_ACQUIRE_TIMEOUT_MS: '1000',
      });
      await app.waitReady();
    }, 240_000);

    afterAll(async () => {
      await app?.kill();
      // `docker rm -f` leva alguns segundos por container
      postgres?.remove();
      sqs?.remove();
    }, 60_000);

    test('with both up: 200', async () => {
      // Os containers recém-criados ainda estão subindo (o Postgres reinicia uma vez depois do
      // initdb): o /health/ready diz "down" até eles responderem, e isso é o certo.
      await waitForReady(200);
      expect((await ready()).body.checks).toEqual({
        postgres: 'up',
        sqs: 'up',
      });
    }, 120_000);

    test('PostgreSQL goes down: 503 naming postgres, with Retry-After, while /health/live stays 200; it comes back: 200', async () => {
      postgres.stop();
      await waitForReady(503);
      const down = await ready();
      expect(down.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'down', sqs: 'up' },
      });
      expect(down.retryAfter).not.toBeNull();
      // nada de string de conexão, senha ou texto de erro na resposta
      expect(down.text).not.toMatch(
        /postgres:\/\/|wallet:wallet|ECONN|password/i,
      );
      expect((await fetch(`${app.url}/health/live`)).status).toBe(200);

      postgres.start();
      await waitForReady(200);
      expect((await ready()).body.checks).toEqual({
        postgres: 'up',
        sqs: 'up',
      });
    }, 120_000);

    test('SQS goes down: 503 naming sqs; it comes back: 200', async () => {
      sqs.stop();
      await waitForReady(503);
      const down = await ready();
      expect(down.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'up', sqs: 'down' },
      });
      expect((await fetch(`${app.url}/health/live`)).status).toBe(200);

      sqs.start();
      await waitForReady(200);
    }, 120_000);

    test('both down: 503 naming both, and the answer is quick (the checks have a deadline)', async () => {
      postgres.stop();
      sqs.stop();
      await waitForReady(503);
      const started = performance.now();
      const down = await ready();
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(down.body.checks).toEqual({ postgres: 'down', sqs: 'down' });
      postgres.start();
      sqs.start();
      await waitForReady(200);
    }, 180_000);
  },
);
