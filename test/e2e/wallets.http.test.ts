import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertInvariants } from '../support/invariants.js';
import {
  createWalletVia,
  newPlayerId,
  startApp,
  type TestApp,
} from '../support/http-app.js';
import { detailPaths, expectError } from '../support/http-expectations.js';

// A aplicação Nest de verdade, ouvindo numa porta, contra o Postgres de teste.
let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  playerId: newPlayerId(),
  initialBalance: { amount: '1000.00', currency: 'BRL' },
  ...overrides,
});

describe('POST /wallets: creating a wallet', () => {
  test('201 with exactly { id, playerId, balance, version: 1 }', async () => {
    const input = body();

    const response = await app.post('/wallets', input);

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type') ?? '').toMatch(
      /^application\/json\b/,
    );
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId: input.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('the money comes back as strings, never as numbers (ADR-0006)', async () => {
    const response = await app.post('/wallets', body());
    expect(response.text).toContain('"amount":"1000.00"');
    expect(response.text).not.toMatch(/"amount":\s*\d/);
  });

  test('with a balance, an OPENING transaction and one CREDIT in the ledger explain it', async () => {
    const response = await app.post('/wallets', body());
    const id = String(response.body?.id);

    const openings = await app.sql(
      `SELECT status, kind, amount::text AS amount FROM wager_transactions WHERE wallet_id = ?`,
      [id],
    );
    const ledger = await app.sql(
      `SELECT direction, amount::text AS amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [id],
    );

    expect(openings).toEqual([
      { status: 'PROCESSED', kind: 'OPENING', amount: '1000.00' },
    ]);
    expect(ledger).toEqual([
      { direction: 'CREDIT', amount: '1000.00', wallet_version: 1 },
    ]);
    await assertInvariants(app.sql, id);
  });

  test('with a zero balance there is no OPENING and no ledger entry, but the wallet exists', async () => {
    const response = await app.post(
      '/wallets',
      body({ initialBalance: { amount: '0.00', currency: 'BRL' } }),
    );
    const id = String(response.body?.id);

    expect(response.status).toBe(201);
    expect(response.body?.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(
      await app.sql(
        'SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ?',
        [id],
      ),
    ).toEqual([{ n: 0 }]);
  });

  test('the same player can have one wallet per currency', async () => {
    const playerId = newPlayerId();
    const brl = await app.post('/wallets', body({ playerId }));
    const usd = await app.post(
      '/wallets',
      body({ playerId, initialBalance: { amount: '5.00', currency: 'USD' } }),
    );
    expect([brl.status, usd.status]).toEqual([201, 201]);
    expect(brl.body?.id).not.toBe(usd.body?.id);
  });

  test('a duplicate wallet (same player and currency) is 409 WALLET_ALREADY_EXISTS, and nothing else is written', async () => {
    const playerId = newPlayerId();
    const first = await app.post('/wallets', body({ playerId }));
    const before = await app.sql(
      'SELECT count(*)::int AS n FROM wager_transactions WHERE player_id = ?',
      [playerId],
    );

    const second = await app.post('/wallets', body({ playerId }));

    expectError(second, { status: 409, code: 'WALLET_ALREADY_EXISTS' });
    expect(
      await app.sql(
        'SELECT count(*)::int AS n FROM wallets WHERE player_id = ?',
        [playerId],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await app.sql(
        'SELECT count(*)::int AS n FROM wager_transactions WHERE player_id = ?',
        [playerId],
      ),
    ).toEqual(before);
    expect(first.status).toBe(201);
  });

  test('two identical requests at the same time: one 201 and one 409, one wallet', async () => {
    const playerId = newPlayerId();
    const responses = await Promise.all([
      app.post('/wallets', body({ playerId })),
      app.post('/wallets', body({ playerId })),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(
      await app.sql(
        'SELECT count(*)::int AS n FROM wallets WHERE player_id = ?',
        [playerId],
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe('POST /wallets: invalid input is 400, with the unified error format and nothing written', () => {
  test.each([
    ['playerId missing', { playerId: undefined }, 'playerId'],
    ['playerId is not a UUID', { playerId: 'player-1' }, 'playerId'],
    ['initialBalance missing', { initialBalance: undefined }, 'initialBalance'],
    [
      'amount is a JSON number',
      { initialBalance: { amount: 25, currency: 'BRL' } },
      'initialBalance.amount',
    ],
    [
      'currency is lowercase',
      { initialBalance: { amount: '1.00', currency: 'brl' } },
      'initialBalance.currency',
    ],
    [
      'currency has 4 letters',
      { initialBalance: { amount: '1.00', currency: 'BRLL' } },
      'initialBalance.currency',
    ],
  ])('%s', async (_name, overrides, path) => {
    const response = await app.post('/wallets', body(overrides));
    const error = expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
    expect(detailPaths(error)).toContain(path);
  });

  test.each([
    ['one decimal place', '10.5'],
    ['three decimal places', '10.001'],
    ['negative', '-1.00'],
    ['scientific notation', '1e3'],
    ['more than 16 integer digits', '12345678901234567.00'],
    ['not a number', 'abc'],
  ])('an amount with %s is 400 INVALID_AMOUNT', async (_name, amount) => {
    const response = await app.post(
      '/wallets',
      body({ initialBalance: { amount, currency: 'BRL' } }),
    );
    expectError(response, {
      status: 400,
      code: 'INVALID_AMOUNT',
      withDetails: true,
    });
  });

  test('malformed JSON is 400 INVALID_PAYLOAD in the same format (not the framework default)', async () => {
    const response = await app.request('POST', '/wallets', {
      raw: '{"playerId": ',
    });
    expectError(response, { status: 400, code: 'INVALID_PAYLOAD' });
  });

  test('an empty body is 400 INVALID_PAYLOAD', async () => {
    const response = await app.request('POST', '/wallets', {
      headers: { 'content-type': 'application/json' },
    });
    expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });

  test('a body that is not an object is 400 INVALID_PAYLOAD', async () => {
    const response = await app.request('POST', '/wallets', { raw: '[1,2,3]' });
    expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });

  test('nothing is written when the input is invalid', async () => {
    const playerId = newPlayerId();
    await app.post(
      '/wallets',
      body({ playerId, initialBalance: { amount: '1.5', currency: 'BRL' } }),
    );
    expect(
      await app.sql(
        'SELECT count(*)::int AS n FROM wallets WHERE player_id = ?',
        [playerId],
      ),
    ).toEqual([{ n: 0 }]);
  });
});

test('a wallet created by the API is usable right away (helper used by the other files)', async () => {
  const wallet = await createWalletVia(app, '10.00');
  expect(wallet.id).toMatch(/^[0-9a-f-]{36}$/);
});
