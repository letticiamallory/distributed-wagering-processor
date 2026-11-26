import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DependencyUnavailableError,
  DuplicateKeyError,
} from '../../src/application/errors/application-errors.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { computePayloadHash } from '../../src/domain/wager/wager-payload-hash.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { Money } from '../../src/domain/money/money.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import {
  createWalletVia,
  defaultKeyOf,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import { expectError } from '../support/http-expectations.js';
import { rejectionOf } from '../support/assertions.js';
import { holding } from '../support/concurrency.js';
import { assertInvariants } from '../support/invariants.js';
import { uuid } from '../support/persistence.js';

// ---------------------------------------------------------------- falha injetada

// O UnitOfWork da aplicação, trocado por um que falha com o erro que o teste escolher. É
// injeção de FALHA (o que o classificador de erros do Postgres devolveria), não mock de banco:
// os caminhos que dependem do banco de verdade usam o app real mais abaixo.
class FailingUnitOfWork extends UnitOfWork {
  failure: () => Error = () => new Error('unset');
  runs = 0;
  run<T>(_work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.runs++;
    return Promise.reject(this.failure());
  }
}

const failing = new FailingUnitOfWork();
let broken: TestApp;
let real: TestApp;

beforeAll(async () => {
  broken = await startApp({ overrides: [[UnitOfWork, failing]] });
  real = await startApp();
}, 60_000);
afterAll(async () => {
  await broken.close();
  await real.close();
});

const aWalletBody = () => ({
  playerId: uuid(),
  initialBalance: { amount: '10.00', currency: 'BRL' },
});
// A rota só chega ao UnitOfWork quando a entrada é válida e a idempotência não resolveu antes.
const aWagerBody = () => wagerBody({ id: uuid(), playerId: uuid() });

describe('503 + Retry-After: a transient failure of the infrastructure', () => {
  test('POST /wagering/transactions: 503 DEPENDENCY_UNAVAILABLE, retryable, with a Retry-After in whole seconds', async () => {
    failing.failure = () =>
      new DependencyUnavailableError('lock timeout', new Error('55P03'));

    const response = await submitVia(broken, aWagerBody());

    expectError(response, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });
    expect(response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
  });

  test('POST /wallets answers the SAME way (the mapping is the same on every route)', async () => {
    failing.failure = () => new DependencyUnavailableError('pool is full');

    const response = await broken.post('/wallets', aWalletBody());

    expectError(response, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });
    expect(response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
  });

  test('the cause stays in the log and never reaches the provider', async () => {
    failing.failure = () =>
      new DependencyUnavailableError(
        'lock timeout',
        new Error('canceling statement due to lock timeout'),
      );
    broken.logs.clear();

    const response = await submitVia(broken, aWagerBody());

    expect(response.text).not.toContain('canceling statement');
    expect(
      broken.logs.mentioning('canceling statement').length,
    ).toBeGreaterThan(0);
  });

  test('is logged as a warning: neither error nor fatal (it is expected under load)', async () => {
    failing.failure = () => new DependencyUnavailableError('lock timeout');
    broken.logs.clear();
    await submitVia(broken, aWagerBody());
    expect(broken.logs.at('warn').length).toBeGreaterThan(0);
    expect(broken.logs.at('error')).toHaveLength(0);
    expect(broken.logs.at('fatal')).toHaveLength(0);
  });

  test('a REAL lock_timeout (another transaction holds the wallet): 503, nothing written, and the same key works afterwards', async () => {
    const short = await startApp({ env: { DB_LOCK_TIMEOUT_MS: '300' } });
    try {
      const wallet = await createWalletVia(short);
      const input = wagerBody(wallet);

      const startedAt = Date.now();
      const response = await holding(
        async ({ locked, until }) => {
          await short.db.uow.run(async (r) => {
            await r.wallets.lockById(wallet.id);
            locked();
            await until;
          });
        },
        () => submitVia(short, input),
      );
      // DB_LOCK_TIMEOUT_MS=300 vale de verdade: desistiu em bem menos que os 5 s do padrão.
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      expectError(response, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
      expect(response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
      const stored = await short.sql(
        'SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ?',
        [input.externalTransactionId],
      );
      expect(stored).toEqual([{ n: 0 }]);

      const retry = await submitVia(short, input);
      expect(retry.status).toBe(201);
      await assertInvariants(short.sql, wallet.id);
    } finally {
      await short.close();
    }
  });
});

describe('RETRY_AFTER_SECONDS comes from the environment, validated at startup', () => {
  test('the value of the variable is the Retry-After of the 503', async () => {
    const unavailable = new FailingUnitOfWork();
    unavailable.failure = () => new DependencyUnavailableError('lock timeout');
    const custom = await startApp({
      env: { RETRY_AFTER_SECONDS: '7' },
      overrides: [[UnitOfWork, unavailable]],
    });
    try {
      const response = await submitVia(custom, aWagerBody());
      expectError(response, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });
      expect(response.headers.get('retry-after')).toBe('7');
    } finally {
      await custom.close();
    }
  }, 30_000);

  test.each(['0', 'soon', '1.5'])(
    'an invalid value (%p) stops the application from starting, and the variable is restored',
    async (value) => {
      const before = process.env.RETRY_AFTER_SECONDS;
      const error = await rejectionOf(
        startApp({ env: { RETRY_AFTER_SECONDS: value } }),
      );
      expect(String(error)).toContain('RETRY_AFTER_SECONDS');
      expect(process.env.RETRY_AFTER_SECONDS).toBe(before);
    },
    30_000,
  );

  test('an invalid DB_LOCK_TIMEOUT_MS also stops the startup', async () => {
    const error = await rejectionOf(
      startApp({ env: { DB_LOCK_TIMEOUT_MS: '0' } }),
    );
    expect(String(error)).toContain('DB_LOCK_TIMEOUT_MS');
  }, 30_000);
});

describe('500: anything else is a bug, and the provider learns nothing about it', () => {
  test('an unexpected error is 500 INTERNAL_ERROR, not retryable, with a generic message (no SQL, no stack)', async () => {
    failing.failure = () => new Error('relation "secret_table" does not exist');

    const response = await submitVia(broken, aWagerBody());

    expectError(response, {
      status: 500,
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
    expect(response.text).not.toContain('secret_table');
    expect(response.text).not.toContain('node_modules');
    expect(response.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });

  test('POST /wallets answers the same way', async () => {
    failing.failure = () => new Error('boom');
    const response = await broken.post('/wallets', aWalletBody());
    expectError(response, {
      status: 500,
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
  });

  test('a database constraint that caught a bug (a 23505 on another constraint) is 500', async () => {
    failing.failure = () => new DuplicateKeyError('uq_wtx_reversed_once');
    const response = await submitVia(broken, aWagerBody());
    expectError(response, {
      status: 500,
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
  });

  test('the real cause is logged at ERROR level, with the correlationId of the response', async () => {
    failing.failure = () => new Error('relation "secret_table" does not exist');
    broken.logs.clear();

    const response = await submitVia(broken, aWagerBody());

    const correlationId = response.headers.get('x-correlation-id') as string;
    const logged = broken.logs.at('error');
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).toContain('secret_table');
    expect(JSON.stringify(logged)).toContain(correlationId);
    expect(broken.logs.at('fatal')).toHaveLength(0);
  });

  test('a 500 that is NOT critical (a 23505 on another constraint) is logged at ERROR, never fatal', async () => {
    failing.failure = () => new DuplicateKeyError('uq_wtx_reversed_once');
    broken.logs.clear();

    const response = await submitVia(broken, aWagerBody());

    expect(response.status).toBe(500);
    expect(broken.logs.at('error').length).toBeGreaterThan(0);
    expect(JSON.stringify(broken.logs.at('error'))).toContain(
      'uq_wtx_reversed_once',
    );
    expect(broken.logs.at('fatal')).toHaveLength(0);
  });

  test('the idempotency race that the rerun did NOT settle (critical) is 500 and is logged at the HIGHEST level (fatal), once', async () => {
    failing.failure = () => new DuplicateKeyError('uq_wtx_idempotency_key');
    broken.logs.clear();
    const runsBefore = failing.runs;

    const response = await submitVia(broken, aWagerBody());

    expectError(response, {
      status: 500,
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
    expect(failing.runs - runsBefore).toBe(2); // a 1ª execução e a única reexecução
    const fatal = broken.logs.at('fatal');
    expect(fatal).toHaveLength(1);
    const correlationId = response.headers.get('x-correlation-id') as string;
    expect(JSON.stringify(fatal)).toContain(correlationId);
    expect(JSON.stringify(fatal)).toContain('uq_wtx_idempotency_key');
    expect(response.text).not.toContain('uq_wtx_idempotency_key');
  });

  test('a normal 4xx is not logged as error or fatal (the provider made the mistake, not us)', async () => {
    broken.logs.clear();
    await broken.post('/wallets', { playerId: 'nope' });
    await submitVia(broken, aWagerBody(), null);
    expect(broken.logs.at('error')).toHaveLength(0);
    expect(broken.logs.at('fatal')).toHaveLength(0);
  });
});

describe('500: replaying a transaction that ended FAILED', () => {
  async function aFailedTransaction() {
    const wallet = await createWalletVia(real);
    const body = wagerBody(wallet);
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    const tx = WagerTransaction.create({
      id: uuid(),
      providerId: String(body.providerId),
      externalTransactionId: String(body.externalTransactionId),
      idempotencyKey: defaultKeyOf(body),
      payloadHash: computePayloadHash({
        providerId: String(body.providerId),
        externalTransactionId: String(body.externalTransactionId),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money,
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money,
      correlationId: 'setup',
      createdAt: new Date(),
    });
    tx.fail(FailureCode.DependencyUnavailable);
    await real.db.uow.run((r) => r.transactions.insert(tx));
    return { wallet, body, transactionId: tx.id };
  }

  test('is 500 INTERNAL_ERROR, NOT retryable (the same key will keep answering the same), carrying the stored failureCode and the transactionId', async () => {
    const { body, transactionId } = await aFailedTransaction();

    const response = await submitVia(real, body);

    expect(response.status).toBe(500);
    const error = (response.body as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      failureCode: 'DEPENDENCY_UNAVAILABLE',
      transactionId,
    });
    expect(error.correlationId).toBe(response.headers.get('x-correlation-id'));
    expect(response.headers.get('retry-after')).toBeNull();
  });

  test('the answer is the same on every replay, and nothing moves', async () => {
    const { wallet, body } = await aFailedTransaction();
    const first = await submitVia(real, body);
    const second = await submitVia(real, body);
    expect(second.status).toBe(500);
    expect(
      (second.body as { error: Record<string, unknown> }).error.transactionId,
    ).toBe(
      (first.body as { error: Record<string, unknown> }).error.transactionId,
    );
    const balance = await real.sql(
      'SELECT balance::text AS b FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(balance).toEqual([{ b: '100.00' }]);
  });
});

describe('errors the framework raises still use the unified format', () => {
  test('an unknown route is 404 ROUTE_NOT_FOUND', async () => {
    const response = await real.get('/nope');
    expectError(response, { status: 404, code: 'ROUTE_NOT_FOUND' });
  });

  test('a body over the limit is 413 PAYLOAD_TOO_LARGE', async () => {
    const response = await real.request('POST', '/wallets', {
      raw: JSON.stringify({ playerId: uuid(), padding: 'x'.repeat(300_000) }),
    });
    expectError(response, { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  test('a body that is not JSON (text/plain) is 400 INVALID_PAYLOAD, not a framework page', async () => {
    const response = await real.request('POST', '/wallets', {
      raw: 'playerId=1',
      headers: { 'content-type': 'text/plain' },
    });
    expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });

  test('the health endpoint keeps its own simple answer (it is not part of the provider API)', async () => {
    const response = await real.get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
