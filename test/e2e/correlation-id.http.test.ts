import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createWalletVia,
  defaultKeyOf,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import { uuid } from '../support/persistence.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const header = (response: { headers: Headers }) =>
  response.headers.get('x-correlation-id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('X-Correlation-Id: the id that ties a request to its logs and events', () => {
  test('a valid id sent by the caller is echoed in the response header', async () => {
    const response = await app.post(
      '/wallets',
      { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } },
      { 'x-correlation-id': 'trace-from-the-provider-123' },
    );
    expect(response.status).toBe(201);
    expect(header(response)).toBe('trace-from-the-provider-123');
  });

  test('without it, one is generated (a UUID), and two requests get different ids', async () => {
    const a = await app.get('/health/live');
    const b = await app.get('/health/live');
    expect(header(a)).toMatch(UUID);
    expect(header(b)).toMatch(UUID);
    expect(header(a)).not.toBe(header(b));
  });

  test.each([
    [
      '201',
      async () =>
        app.post('/wallets', {
          playerId: uuid(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        }),
    ],
    ['400', async () => app.post('/wallets', { playerId: 'nope' })],
    ['404 (unknown route)', async () => app.get('/nope')],
    [
      '422',
      async () => {
        const wallet = await createWalletVia(app, '1.00');
        return submitVia(
          app,
          wagerBody(wallet, { money: { amount: '99.00', currency: 'BRL' } }),
        );
      },
    ],
  ])('every answer carries it (%s)', async (_name, call) => {
    expect(header(await call())).toMatch(/^[\w.:-]{1,128}$/);
  });

  test.each([
    ['too long', 'a'.repeat(200)],
    ['with a space', 'trace id'],
    ['with a script', '<script>alert(1)</script>'],
    ['with a quote', 'x"y'],
    ['blank', '   '],
  ])(
    'an id %s is NOT echoed: a fresh UUID replaces it (it would go straight into the logs)',
    async (_name, value) => {
      const response = await app.get('/health/live', {
        'x-correlation-id': value,
      });
      expect(header(response)).toMatch(UUID);
      expect(header(response)).not.toBe(value);
    },
  );

  test('the correlationId of an error body is the same as the response header', async () => {
    const response = await app.post(
      '/wallets',
      { playerId: 'nope' },
      { 'x-correlation-id': 'trace-400' },
    );
    expect(header(response)).toBe('trace-400');
    expect(
      (response.body as { error: { correlationId: string } }).error
        .correlationId,
    ).toBe('trace-400');
  });

  test('it is recorded on the transaction and on its events, so a log line leads to the rows', async () => {
    const wallet = await createWalletVia(app);
    const input = wagerBody(wallet);

    const response = await submitVia(app, input, defaultKeyOf(input), {
      'x-correlation-id': 'trace-bet-777',
    });

    const id = String(response.body?.transactionId);
    expect(
      await app.sql(
        'SELECT correlation_id FROM wager_transactions WHERE id = ?',
        [id],
      ),
    ).toEqual([{ correlation_id: 'trace-bet-777' }]);
    const events = await app.sql(
      `SELECT DISTINCT payload->>'correlationId' AS correlation_id FROM outbox_messages
        WHERE payload->'data'->>'transactionId' = ?`,
      [id],
    );
    expect(events).toEqual([{ correlation_id: 'trace-bet-777' }]);
  });

  test('a REPLAY keeps the correlationId of the original transaction in storage, and answers with its own header', async () => {
    const wallet = await createWalletVia(app);
    const input = wagerBody(wallet);
    const first = await submitVia(app, input, defaultKeyOf(input), {
      'x-correlation-id': 'trace-first',
    });

    const replay = await submitVia(app, input, defaultKeyOf(input), {
      'x-correlation-id': 'trace-second',
    });

    expect(header(replay)).toBe('trace-second');
    expect(
      await app.sql(
        'SELECT correlation_id FROM wager_transactions WHERE id = ?',
        [first.body?.transactionId],
      ),
    ).toEqual([{ correlation_id: 'trace-first' }]);
  });

  test('on POST /wallets it ends up on the OPENING transaction', async () => {
    const response = await app.post(
      '/wallets',
      { playerId: uuid(), initialBalance: { amount: '5.00', currency: 'BRL' } },
      { 'x-correlation-id': 'trace-wallet-1' },
    );
    expect(
      await app.sql(
        `SELECT correlation_id FROM wager_transactions WHERE wallet_id = ?`,
        [response.body?.id],
      ),
    ).toEqual([{ correlation_id: 'trace-wallet-1' }]);
  });
});
