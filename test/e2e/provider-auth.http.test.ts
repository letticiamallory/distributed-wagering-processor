import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { ProviderIdentityPort } from '../../src/application/ports/provider-identity.port.js';
import { HealthController } from '../../src/interfaces/http/health/health.controller.js';
import { MetricsController } from '../../src/interfaces/http/metrics/metrics.controller.js';
import { ProviderAuthGuard } from '../../src/interfaces/http/provider-auth.guard.js';
import { WagerTransactionsController } from '../../src/interfaces/http/wagering/wager-transactions.controller.js';
import { WalletsController } from '../../src/interfaces/http/wallets/wallets.controller.js';
import {
  createWalletVia,
  defaultKeyOf,
  newPlayerId,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import { expectError } from '../support/http-expectations.js';
import {
  FakeProviderIdentityPort,
  RejectEverythingPort,
} from '../support/provider-identity.js';

// Duas aplicações: a de HOJE (o no-op, que aceita tudo) e uma com um provedor de identidade
// "de verdade" plugado na porta, para provar que o ponto de extensão funciona de ponta a ponta
// (401, 403, health aberto) sem subir um IdP.
const fake = new FakeProviderIdentityPort({
  'token-a': ['provider-a'],
  'token-b': ['provider-b'],
  'token-ab': ['provider-a', 'provider-b'],
});
const rejectAll = new RejectEverythingPort();
let noop: TestApp;
let secured: TestApp;
let locked: TestApp;

beforeAll(async () => {
  noop = await startApp();
  secured = await startApp({ overrides: [[ProviderIdentityPort, fake]] });
  locked = await startApp({ overrides: [[ProviderIdentityPort, rejectAll]] });
}, 90_000);
afterAll(async () => {
  await noop.close();
  await secured.close();
  await locked.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const walletBody = () => ({
  playerId: newPlayerId(),
  initialBalance: { amount: '100.00', currency: 'BRL' },
});
const countWallets = async (app: TestApp, playerId: unknown) =>
  (
    await app.sql(
      'SELECT count(*)::int AS n FROM wallets WHERE player_id = ?',
      [playerId],
    )
  )[0]?.n;

describe('today: the no-op accepts everything (the extension point is there, the IdP is not)', () => {
  test.each([
    ['no Authorization header', {}],
    ['a Bearer token that means nothing', bearer('garbage')],
    ['another scheme', { authorization: 'Basic abc' }],
  ])('POST /wallets works with %s', async (_name, headers) => {
    const response = await noop.post('/wallets', walletBody(), headers);
    expect(response.status).toBe(201);
  });

  test('POST /wagering/transactions works for ANY providerId, with no credential', async () => {
    const wallet = await createWalletVia(noop);
    const response = await submitVia(
      noop,
      wagerBody(wallet, { providerId: 'a-provider-nobody-registered' }),
    );
    expect(response.status).toBe(201);
  });
});

describe('/health stays open: no credential, no identity provider, no guard', () => {
  test('answers 200 with no Authorization header', async () => {
    expect((await noop.get('/health/live')).status).toBe(200);
  });

  test('answers 200 even when the identity provider rejects EVERY credential, and never asks it', async () => {
    rejectAll.calls = 0;
    const response = await locked.get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(rejectAll.calls).toBe(0);
  });

  test('also with a credential that would be refused (a health check must not depend on auth)', async () => {
    const response = await locked.get('/health/live', bearer('expired'));
    expect(response.status).toBe(200);
  });
});

describe('401: the business routes ask the identity provider', () => {
  test('POST /wallets with no credential is 401 UNAUTHENTICATED, with WWW-Authenticate: Bearer, and writes nothing', async () => {
    const input = walletBody();

    const response = await secured.post('/wallets', input);

    expectError(response, { status: 401, code: 'UNAUTHENTICATED' });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await countWallets(secured, input.playerId)).toBe(0);
  });

  test('POST /wagering/transactions with an invalid token is 401, and the same on every route', async () => {
    const wallet = await createWalletVia(noop);
    const input = wagerBody(wallet);

    const response = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('not-a-token'),
    );

    expectError(response, { status: 401, code: 'UNAUTHENTICATED' });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('the message does not say WHY (a stolen token and a wrong one look the same)', async () => {
    const missing = await secured.post('/wallets', walletBody());
    const wrong = await secured.post('/wallets', walletBody(), bearer('nope'));
    const message = (r: typeof missing) =>
      (r.body as { error: { message: string } }).error.message;
    expect(message(missing)).toBe(message(wrong));
  });

  test('authentication comes BEFORE validation: bad token and bad body is 401, not 400', async () => {
    const response = await secured.post(
      '/wallets',
      { playerId: 'nope' },
      bearer('nope'),
    );
    expectError(response, { status: 401, code: 'UNAUTHENTICATED' });
  });

  test('another scheme (Basic) reaches the identity provider as "no credential"', async () => {
    fake.calls = [];
    const response = await secured.post('/wallets', walletBody(), {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    expect(response.status).toBe(401);
    expect(fake.calls).toEqual([undefined]);
  });

  test('the scheme name is case-insensitive, and the token reaches the port WITHOUT the "Bearer " prefix', async () => {
    fake.calls = [];
    const response = await secured.post('/wallets', walletBody(), {
      authorization: 'bearer token-a',
    });
    expect(response.status).toBe(201);
    expect(fake.calls).toEqual(['token-a']);
  });

  test('the 401 carries the correlationId, like every error', async () => {
    const response = await secured.post('/wallets', walletBody(), {
      'x-correlation-id': 'trace-401',
    });
    expect(
      (response.body as { error: { correlationId: string } }).error
        .correlationId,
    ).toBe('trace-401');
  });

  test('a 401 is not our error: nothing is logged as error or fatal', async () => {
    secured.logs.clear();
    await secured.post('/wallets', walletBody());
    expect(secured.logs.at('error')).toHaveLength(0);
    expect(secured.logs.at('fatal')).toHaveLength(0);
  });

  test('the identity provider is asked exactly ONCE per business request', async () => {
    fake.calls = [];
    await secured.post('/wallets', walletBody(), bearer('token-a'));
    await secured.post('/wallets', walletBody(), bearer('nope'));
    expect(fake.calls).toEqual(['token-a', 'nope']);
  });
});

describe('403: the providerId of the body has to be one the token can act as', () => {
  test('a token for provider-a, a body for provider-a: 201', async () => {
    const wallet = await createWalletVia(noop);
    const input = wagerBody(wallet, { providerId: 'provider-a' });
    const response = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('token-a'),
    );
    expect(response.status).toBe(201);
  });

  test('a token for provider-a, a body for provider-b: 403 PROVIDER_FORBIDDEN, nothing written, balance intact', async () => {
    const wallet = await createWalletVia(noop);
    const input = wagerBody(wallet, { providerId: 'provider-b' });

    const response = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('token-a'),
    );

    expectError(response, { status: 403, code: 'PROVIDER_FORBIDDEN' });
    const stored = await secured.sql(
      'SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ?',
      [input.externalTransactionId],
    );
    expect(stored).toEqual([{ n: 0 }]);
    const balance = await secured.sql(
      'SELECT balance::text AS b FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(balance).toEqual([{ b: '100.00' }]);
  });

  test('a token that can act as BOTH providers may use either', async () => {
    const wallet = await createWalletVia(noop);
    for (const providerId of ['provider-a', 'provider-b']) {
      const input = wagerBody(wallet, { providerId });
      const response = await submitVia(
        secured,
        input,
        defaultKeyOf(input),
        bearer('token-ab'),
      );
      expect(response.status).toBe(201);
    }
  });

  test('the message does not reveal anything about the providers', async () => {
    const wallet = await createWalletVia(noop);
    const input = wagerBody(wallet, { providerId: 'provider-b' });
    const response = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('token-a'),
    );
    expect(response.status).toBe(403);
    expect(response.text).not.toContain('provider-a');
  });

  test('a provider that did not make the operation cannot replay it: 403, never the stored result', async () => {
    const wallet = await createWalletVia(noop);
    const input = wagerBody(wallet, { providerId: 'provider-a' });
    const first = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('token-a'),
    );
    expect(first.status).toBe(201);

    const stolen = await submitVia(
      secured,
      input,
      defaultKeyOf(input),
      bearer('token-b'),
    );

    expectError(stolen, { status: 403, code: 'PROVIDER_FORBIDDEN' });
    expect(stolen.text).not.toContain(String(first.body?.transactionId));
  });

  test('POST /wallets has no providerId in the body, so any VALID token may create a wallet', async () => {
    const response = await secured.post(
      '/wallets',
      walletBody(),
      bearer('token-b'),
    );
    expect(response.status).toBe(201);
  });

  test('a body with no providerId (or a non-text one) is NOT a 403: the use case answers 400, as always', async () => {
    const wallet = await createWalletVia(noop);
    const missing = await secured.post(
      '/wagering/transactions',
      wagerBody(wallet, { providerId: undefined }),
      { ...bearer('token-a'), 'idempotency-key': 'k-1' },
    );
    const notText = await secured.post(
      '/wagering/transactions',
      wagerBody(wallet, { providerId: 123 }),
      { ...bearer('token-a'), 'idempotency-key': 'k-2' },
    );
    expectError(missing, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
    expectError(notText, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });

  test('a 403 is not our error either: nothing is logged as error or fatal', async () => {
    const wallet = await createWalletVia(noop);
    secured.logs.clear();
    const input = wagerBody(wallet, { providerId: 'provider-b' });
    await submitVia(secured, input, defaultKeyOf(input), bearer('token-a'));
    expect(secured.logs.at('error')).toHaveLength(0);
    expect(secured.logs.at('fatal')).toHaveLength(0);
  });
});

describe('no route can forget the guard', () => {
  // Percorre os controllers que o Nest registrou. Uma rota nova (as consultas da Fase 8) nasce
  // num controller novo: se ele esquecer o guard, este teste falha antes de ir para produção.
  const controllersOf = (app: TestApp) => {
    const modules = [...app.nest.get(ModulesContainer).values()];
    return modules.flatMap((module) =>
      [...module.controllers.values()].map(
        (wrapper) => wrapper.metatype as new (...args: never[]) => unknown,
      ),
    );
  };
  const guardsOf = (controller: unknown): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, controller as object) ??
      []) as unknown[];

  test('the business controllers are behind ProviderAuthGuard', () => {
    const controllers = controllersOf(noop);
    for (const business of [WalletsController, WagerTransactionsController]) {
      expect(controllers).toContain(business);
      expect(guardsOf(business)).toContain(ProviderAuthGuard);
    }
  });

  test('the health controller is NOT (the enunciado: health stays open)', () => {
    expect(controllersOf(noop)).toContain(HealthController);
    expect(guardsOf(HealthController)).toHaveLength(0);
  });

  test('the metrics controller is open too (a scraper has no provider token), and it is the only other one', () => {
    expect(controllersOf(noop)).toContain(MetricsController);
    expect(guardsOf(MetricsController)).toHaveLength(0);
  });

  test('EVERY registered controller has the guard, except the operational ones (health and metrics)', () => {
    const unguarded = controllersOf(noop)
      .filter(
        (controller) =>
          controller !== HealthController && controller !== MetricsController,
      )
      .filter((controller) => !guardsOf(controller).includes(ProviderAuthGuard))
      .map((controller) => controller.name);
    expect(unguarded).toEqual([]);
  });
});
