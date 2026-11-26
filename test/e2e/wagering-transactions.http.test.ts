import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ResolvePendingReferenceUseCase } from '../../src/application/use-cases/resolve-pending-reference.use-case.js';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { SystemClock } from '../../src/infrastructure/system/system-clock.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import {
  createWalletVia,
  defaultKeyOf,
  nextExternalId,
  startApp,
  submitVia,
  wagerBody,
  type Json,
  type TestApp,
} from '../support/http-app.js';
import { detailPaths, expectError } from '../support/http-expectations.js';
import { assertInvariants } from '../support/invariants.js';
import { uuid } from '../support/persistence.js';

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const wallet100 = () => createWalletVia(app, '100.00');
const countByExternal = async (externalTransactionId: unknown) =>
  (
    await app.sql(
      'SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ?',
      [externalTransactionId],
    )
  )[0]?.n;
const directionsOf = async (walletId: string) =>
  (
    await app.sql(
      'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > 1 ORDER BY wallet_version',
      [walletId],
    )
  ).map((row) => String(row.direction));
const balanceOf = async (walletId: string) =>
  String(
    (
      await app.sql('SELECT balance::text AS b FROM wallets WHERE id = ?', [
        walletId,
      ])
    )[0]?.b,
  );

describe('POST /wagering/transactions: processed (201) and replay (200)', () => {
  test('a BET of 25.00 is 201 with exactly { transactionId, status, balance, idempotentReplay: false }', async () => {
    const wallet = await wallet100();

    const response = await submitVia(app, wagerBody(wallet));

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type') ?? '').toMatch(
      /^application\/json\b/,
    );
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
    await assertInvariants(app.sql, wallet.id);
  });

  test('the same request again is 200, the same body with idempotentReplay: true, and still ONE debit', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const first = await submitVia(app, input);

    const replay = await submitVia(app, input);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  test('the replay answers the balance of THE TIME, not today’s', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    await submitVia(app, input); // 75.00
    await submitVia(
      app,
      wagerBody(wallet, { money: { amount: '10.00', currency: 'BRL' } }),
    ); // 65.00

    const replay = await submitVia(app, input);

    expect(replay.status).toBe(200);
    expect(replay.body?.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await balanceOf(wallet.id)).toBe('65.00');
  });

  test('a WIN, a LOSS, a REFUND and a ROLLBACK are 201 and move the balance as the rules say', async () => {
    const wallet = await wallet100();
    const bet = wagerBody(wallet);
    await submitVia(app, bet); // 75
    const reference = String(bet.externalTransactionId);

    const win = await submitVia(
      app,
      wagerBody(wallet, {
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: reference,
      }),
    ); // 155
    const loss = await submitVia(
      app,
      wagerBody(wallet, {
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
        referenceExternalTransactionId: reference,
      }),
    ); // 155
    expect([win.status, loss.status]).toEqual([201, 201]);
    expect(win.body?.balance).toEqual({ amount: '155.00', currency: 'BRL' });
    expect(loss.body?.balance).toEqual({ amount: '155.00', currency: 'BRL' });

    const wallet2 = await wallet100();
    const bet2 = wagerBody(wallet2);
    await submitVia(app, bet2); // 75
    const refund = await submitVia(
      app,
      wagerBody(wallet2, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet2.externalTransactionId,
      }),
    ); // 100
    expect(refund.status).toBe(201);
    expect(refund.body?.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const wallet3 = await wallet100();
    const bet3 = wagerBody(wallet3);
    await submitVia(app, bet3); // 75
    const rollback = await submitVia(
      app,
      wagerBody(wallet3, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: bet3.externalTransactionId,
      }),
    ); // 100
    expect(rollback.status).toBe(201);
    expect(rollback.body?.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    for (const w of [wallet, wallet2, wallet3])
      await assertInvariants(app.sql, w.id);
  });

  test('50 identical requests at the same time: one 201, forty-nine 200, one debit', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submitVia(app, input)),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body?.transactionId)).size).toBe(1);
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await assertInvariants(app.sql, wallet.id);
  }, 30_000);
});

describe('Idempotency-Key: the header is the source of truth', () => {
  test('a key that is NOT the recommended default is accepted, and replays by itself', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const key = `my-own-key-${uuid()}`;

    const first = await submitVia(app, input, key);
    const replay = await submitVia(app, input, key);

    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
  });

  test('the default key for an external id already used under ANOTHER key is 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    await submitVia(app, input, `my-own-key-${uuid()}`);

    const second = await submitVia(app, input, defaultKeyOf(input));

    expectError(second, { status: 409, code: 'EXTERNAL_ID_CONFLICT' });
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
  });

  test('an idempotencyKey inside the BODY is ignored: only the header counts', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const header = `header-key-${uuid()}`;

    const first = await submitVia(
      app,
      { ...input, idempotencyKey: 'body-key' },
      header,
    );
    const replay = await submitVia(
      app,
      { ...input, idempotencyKey: 'another-body-key' },
      header,
    );

    expect([first.status, replay.status]).toEqual([201, 200]);
    const stored = await app.sql(
      'SELECT idempotency_key FROM wager_transactions WHERE external_transaction_id = ?',
      [input.externalTransactionId],
    );
    expect(stored).toEqual([{ idempotency_key: header }]);
  });

  test('transport extras in the body do not change the hash: the replay is still a replay', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    await submitVia(app, input);

    const replay = await submitVia(
      app,
      { ...input, traceparent: '00-abc-def-01', extra: { a: 1 } },
      defaultKeyOf(input),
    );

    expect(replay.status).toBe(200);
  });

  test.each([
    ['is missing', null],
    ['is empty', ''],
    ['is only blanks', '   '],
    ['has 256 characters', 'k'.repeat(256)],
  ])(
    'a header that %s is 400 INVALID_PAYLOAD pointing at Idempotency-Key, and nothing is written',
    async (_name, key) => {
      const wallet = await wallet100();
      const input = wagerBody(wallet);

      const response = await submitVia(app, input, key);

      const error = expectError(response, {
        status: 400,
        code: 'INVALID_PAYLOAD',
        withDetails: true,
      });
      expect(detailPaths(error)).toContain('Idempotency-Key');
      expect(await countByExternal(input.externalTransactionId)).toBe(0);
    },
  );

  test('a header with 255 characters is accepted (the limit is inclusive)', async () => {
    const wallet = await wallet100();
    // 255 caracteres, e único: o banco de teste persiste entre execuções.
    const key = `${'k'.repeat(255 - 36)}${uuid()}`;
    expect(key).toHaveLength(255);
    const response = await submitVia(app, wagerBody(wallet), key);
    expect(response.status).toBe(201);
  });

  test('the header sent TWICE is 400 (two keys for one operation is ambiguous)', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const payload = JSON.stringify(input);
    const response = await app.rawHttp(
      [
        'POST /wagering/transactions HTTP/1.1',
        `Host: ${new URL(app.url).host}`,
        'Content-Type: application/json',
        'Idempotency-Key: first-key',
        'Idempotency-Key: second-key',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        '',
        payload,
      ].join('\r\n'),
    );

    const error = expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
    expect(detailPaths(error)).toContain('Idempotency-Key');
    expect(await countByExternal(input.externalTransactionId)).toBe(0);
  });

  test('the header name is case-insensitive', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const response = await app.post('/wagering/transactions', input, {
      'IDEMPOTENCY-KEY': defaultKeyOf(input),
    });
    expect(response.status).toBe(201);
  });
});

describe('409: idempotency conflicts are not replays', () => {
  test('the same key with ONE CENT of difference is 409 IDEMPOTENCY_KEY_REUSED and the balance does not move', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    const key = defaultKeyOf(input);
    await submitVia(app, input, key);

    const conflict = await submitVia(
      app,
      { ...input, money: { amount: '25.01', currency: 'BRL' } },
      key,
    );

    expectError(conflict, { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
  });

  test('the same key for ANOTHER wallet is 409 IDEMPOTENCY_KEY_REUSED and writes nothing in the other wallet', async () => {
    const mine = await wallet100();
    const theirs = await wallet100();
    const input = wagerBody(mine);
    const key = defaultKeyOf(input);
    await submitVia(app, input, key);

    const conflict = await submitVia(
      app,
      { ...input, walletId: theirs.id, playerId: theirs.playerId },
      key,
    );

    expectError(conflict, { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await balanceOf(theirs.id)).toBe('100.00');
    expect(await directionsOf(theirs.id)).toEqual([]);
  });

  test('two wallets racing for the same key at the same time: one wins, the other is 409, one debit in total', async () => {
    const mine = await wallet100();
    const theirs = await wallet100();
    const input = wagerBody(mine);
    const key = defaultKeyOf(input);

    const [a, b] = await Promise.all([
      submitVia(app, input, key),
      submitVia(
        app,
        { ...input, walletId: theirs.id, playerId: theirs.playerId },
        key,
      ),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expectError(loser, { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    const debits =
      (await directionsOf(mine.id)).length +
      (await directionsOf(theirs.id)).length;
    expect(debits).toBe(1);
  });

  test('a new key for an external id that already exists is 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet);
    await submitVia(app, input);

    const conflict = await submitVia(app, input, `another-key-${uuid()}`);

    expectError(conflict, { status: 409, code: 'EXTERNAL_ID_CONFLICT' });
    expect(await directionsOf(wallet.id)).toEqual(['DEBIT']);
  });
});

describe('422: rejected by a business rule (first time and replay)', () => {
  test('a BET bigger than the balance is 422 with the stored failureCode, the balance, and nothing moved', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet, {
      money: { amount: '100.01', currency: 'BRL' },
    });

    const response = await submitVia(app, input);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await directionsOf(wallet.id)).toEqual([]);
    await assertInvariants(app.sql, wallet.id);
  });

  test('the replay of a rejected transaction is ALSO 422, the same body with idempotentReplay: true', async () => {
    const wallet = await wallet100();
    const input = wagerBody(wallet, {
      money: { amount: '999.00', currency: 'BRL' },
    });
    const first = await submitVia(app, input);

    const replay = await submitVia(app, input);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('a rejection has no `error` envelope: it is a stored transaction, with an id', async () => {
    const wallet = await wallet100();
    const response = await submitVia(
      app,
      wagerBody(wallet, { money: { amount: '999.00', currency: 'BRL' } }),
    );
    expect(response.body).not.toHaveProperty('error');
    expect(response.body).toHaveProperty('transactionId');
  });

  test('USD on a BRL wallet is 422 CURRENCY_MISMATCH, with the balance in the WALLET currency', async () => {
    const wallet = await wallet100();
    const response = await submitVia(
      app,
      wagerBody(wallet, { money: { amount: '25.00', currency: 'USD' } }),
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('another player on the wallet is 422 WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await wallet100();
    const response = await submitVia(
      app,
      wagerBody(wallet, { playerId: uuid() }),
    );
    expect(response.status).toBe(422);
    expect(response.body?.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('a second REFUND of the same BET is 422 REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await wallet100();
    const bet = wagerBody(wallet);
    await submitVia(app, bet);
    const reversal = () =>
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
    expect((await submitVia(app, reversal())).status).toBe(201);

    const second = await submitVia(app, reversal());

    expect(second.status).toBe(422);
    expect(second.body?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('a ROLLBACK of a WIN the wallet cannot cover is 422 REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await wallet100();
    const bet = wagerBody(wallet);
    await submitVia(app, bet); // 75
    const win = wagerBody(wallet, {
      kind: 'WIN',
      money: { amount: '80.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submitVia(app, win); // 155
    await submitVia(
      app,
      wagerBody(wallet, { money: { amount: '150.00', currency: 'BRL' } }),
    ); // 5
    const response = await submitVia(
      app,
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(response.status).toBe(422);
    expect(response.body?.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  });
});

describe('202: accepted, waiting for a reference that has not arrived', () => {
  const pendingRefund = (wallet: { id: string; playerId: string }) =>
    wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: nextExternalId(),
    });

  test('is 202 with { transactionId, status: PENDING_REFERENCE, idempotentReplay: false } and NO balance', async () => {
    const wallet = await wallet100();

    const response = await submitVia(app, pendingRefund(wallet));

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await directionsOf(wallet.id)).toEqual([]);
    await assertInvariants(app.sql, wallet.id);
  });

  test('the replay is 202 again, idempotentReplay: true, with no new attempt', async () => {
    const wallet = await wallet100();
    const input = pendingRefund(wallet);
    const first = await submitVia(app, input);

    const replay = await submitVia(app, input);

    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    const row = await app.sql(
      'SELECT attempts FROM wager_transactions WHERE id = ?',
      [first.body?.transactionId],
    );
    expect(row).toEqual([{ attempts: 1 }]);
  });

  test('once the reference arrives and the worker resolves it, the SAME request is a 200 replay with the final result', async () => {
    const wallet = await wallet100();
    const bet = wagerBody(wallet);
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await submitVia(app, refund);
    expect(pending.status).toBe(202);
    await submitVia(app, bet); // 75; acorda o REFUND

    const resolver = new ResolvePendingReferenceUseCase(
      app.db.uow,
      app.db.reader,
      new SystemClock(),
      new UuidV7Generator(),
      new PendingReferenceSchedule(),
    );
    const resolved = await resolver.execute(
      { transactionId: String(pending.body?.transactionId) },
      { correlationId: 'worker' },
    );
    expect(resolved.outcome).toBe('RESOLVED');

    const replay = await submitVia(app, refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: pending.body?.transactionId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    await assertInvariants(app.sql, wallet.id);
  });
});

describe('400: invalid input (nothing is written)', () => {
  const invalid = async (
    overrides: Json,
    expectedCode: string,
    path?: string,
  ) => {
    const wallet = await wallet100();
    const input = wagerBody(wallet, overrides);
    const response = await submitVia(app, input);
    const error = expectError(response, {
      status: 400,
      code: expectedCode,
      withDetails: true,
    });
    if (path) expect(detailPaths(error)).toContain(path);
    expect(await countByExternal(input.externalTransactionId)).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  };

  test('an amount that is a JSON number', () =>
    invalid(
      { money: { amount: 25, currency: 'BRL' } },
      'INVALID_PAYLOAD',
      'money.amount',
    ));
  test('an amount with one decimal place', () =>
    invalid({ money: { amount: '25.5', currency: 'BRL' } }, 'INVALID_AMOUNT'));
  test('a zero BET', () =>
    invalid({ money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_AMOUNT'));
  test('the internal kind OPENING', () =>
    invalid({ kind: 'OPENING' }, 'UNSUPPORTED_KIND', 'kind'));
  test('an unknown kind', () =>
    invalid({ kind: 'JACKPOT' }, 'UNSUPPORTED_KIND', 'kind'));
  test('a REFUND without a reference', () =>
    invalid(
      { kind: 'REFUND' },
      'INVALID_PAYLOAD',
      'referenceExternalTransactionId',
    ));
  test('a walletId that is not a UUID', () =>
    invalid({ walletId: 'wallet-1' }, 'INVALID_PAYLOAD', 'walletId'));
  test('a missing providerId', () =>
    invalid({ providerId: undefined }, 'INVALID_PAYLOAD', 'providerId'));
  test('a blank externalTransactionId', () =>
    invalid(
      { externalTransactionId: '   ' },
      'INVALID_PAYLOAD',
      'externalTransactionId',
    ));

  test('malformed JSON is 400 INVALID_PAYLOAD in the same format', async () => {
    const response = await app.request('POST', '/wagering/transactions', {
      raw: '{"providerId": "provider-a",',
      headers: { 'idempotency-key': 'k-1' },
    });
    expectError(response, { status: 400, code: 'INVALID_PAYLOAD' });
  });

  test('an empty body is 400 INVALID_PAYLOAD', async () => {
    const response = await app.request('POST', '/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
    });
    expectError(response, {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });
});

describe('404: the wallet does not exist', () => {
  test('is 404 WALLET_NOT_FOUND, writes nothing, and is NOT remembered as a replay', async () => {
    const input = wagerBody({ id: uuid(), playerId: uuid() });

    const first = await submitVia(app, input);
    const second = await submitVia(app, input);

    expectError(first, { status: 404, code: 'WALLET_NOT_FOUND' });
    expectError(second, { status: 404, code: 'WALLET_NOT_FOUND' });
    expect(await countByExternal(input.externalTransactionId)).toBe(0);
  });
});
