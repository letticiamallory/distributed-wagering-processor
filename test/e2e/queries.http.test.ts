import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProviderIdentityPort } from '../../src/application/ports/provider-identity.port.js';
import {
  createWalletVia,
  startApp,
  submitVia,
  wagerBody,
  type Json,
  type TestApp,
} from '../support/http-app.js';
import { detailPaths, expectError } from '../support/http-expectations.js';
import { parseMetrics } from '../support/metrics.js';
import {
  FakeProviderIdentityPort,
  RejectEverythingPort,
} from '../support/provider-identity.js';

let app: TestApp;
let secured: TestApp;
let locked: TestApp;
const fake = new FakeProviderIdentityPort({
  'token-a': ['provider-a'],
  'token-b': ['provider-b'],
});

beforeAll(async () => {
  app = await startApp();
  secured = await startApp({ overrides: [[ProviderIdentityPort, fake]] });
  locked = await startApp({
    overrides: [[ProviderIdentityPort, new RejectEverythingPort()]],
  });
}, 90_000);
afterAll(async () => {
  await app.close();
  await secured.close();
  await locked.close();
});

async function walletWithBets(n: number, amount = '1.00') {
  const wallet = await createWalletVia(app, '1000.00');
  const bets: Json[] = [];
  for (let i = 0; i < n; i++) {
    const body = wagerBody(wallet, { money: { amount, currency: 'BRL' } });
    expect((await submitVia(app, body)).status).toBe(201);
    bets.push(body);
  }
  return { wallet, bets };
}

describe('GET /wallets/:walletId', () => {
  test('200 with id, playerId, balance and version (the same shape POST /wallets answers)', async () => {
    const { wallet } = await walletWithBets(2);
    const response = await app.get(`/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '998.00', currency: 'BRL' },
      version: 3,
    });
  });

  test('404 WALLET_NOT_FOUND in the standard error format; 400 for an id that is not a uuid', async () => {
    expectError(await app.get(`/wallets/${crypto.randomUUID()}`), {
      status: 404,
      code: 'WALLET_NOT_FOUND',
    });
    const bad = expectError(await app.get('/wallets/not-a-uuid'), {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
    expect(detailPaths(bad)).toContain('walletId');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pages through the whole ledger with an opaque cursor: every entry once, newest first', async () => {
    const { wallet } = await walletWithBets(7); // 8 lançamentos
    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/wallets/${wallet.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await app.get(url);
      expect(response.status).toBe(200);
      const body = response.body as {
        items: Array<{ walletVersion: number }>;
        nextCursor: string | null;
      };
      versions.push(...body.items.map((i) => i.walletVersion));
      cursor = body.nextCursor;
      pages++;
      if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(versions).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test('an item has the ledger fields, with money as strings', async () => {
    const { wallet } = await walletWithBets(1, '12.34');
    const body = (await app.get(`/wallets/${wallet.id}/ledger`)).body as {
      items: Json[];
      nextCursor: null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '12.34', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '987.66', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('a bad cursor, a limit out of range and a bad id are 400 with the field named', async () => {
    const { wallet } = await walletWithBets(1);
    expect(
      detailPaths(
        expectError(
          await app.get(`/wallets/${wallet.id}/ledger?cursor=garbage`),
          { status: 400, code: 'INVALID_PAYLOAD', withDetails: true },
        ),
      ),
    ).toContain('cursor');
    for (const limit of ['101', '0', '-3', 'abc', '2.5']) {
      expect(
        detailPaths(
          expectError(
            await app.get(`/wallets/${wallet.id}/ledger?limit=${limit}`),
            { status: 400, code: 'INVALID_PAYLOAD', withDetails: true },
          ),
        ),
      ).toContain('limit');
    }
    expectError(await app.get('/wallets/xyz/ledger'), {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });

  test('an unknown wallet is 404', async () => {
    expectError(await app.get(`/wallets/${crypto.randomUUID()}/ledger`), {
      status: 404,
      code: 'WALLET_NOT_FOUND',
    });
  });
});

describe('the transaction queries', () => {
  test('by id: 200 with the status, the failure code and the balance of the time', async () => {
    const wallet = await createWalletVia(app, '10.00');
    const body = wagerBody(wallet, {
      money: { amount: '50.00', currency: 'BRL' },
    });
    const rejected = await submitVia(app, body);
    expect(rejected.status).toBe(422);
    const transactionId = String(rejected.body?.transactionId);
    const response = await app.get(`/wagering/transactions/${transactionId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId,
      providerId: 'provider-a',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
  });

  test('a stored FAILED or pending transaction is still a 200 (it is a resource that exists)', async () => {
    const wallet = await createWalletVia(app, '100.00');
    const pending = await submitVia(
      app,
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: `nobody-${crypto.randomUUID()}`,
        money: { amount: '5.00', currency: 'BRL' },
      }),
    );
    expect(pending.status).toBe(202);
    const response = await app.get(
      `/wagering/transactions/${String(pending.body?.transactionId)}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  test('by the provider key: the same transaction; another provider or an unknown key is 404', async () => {
    const { bets } = await walletWithBets(1);
    const external = String(bets[0]?.externalTransactionId);
    const found = await app.get(
      `/providers/provider-a/wagering/transactions/${external}`,
    );
    expect(found.status).toBe(200);
    expect(found.body?.externalTransactionId).toBe(external);
    expectError(
      await app.get(`/providers/provider-b/wagering/transactions/${external}`),
      { status: 404, code: 'TRANSACTION_NOT_FOUND' },
    );
    expectError(
      await app.get('/providers/provider-a/wagering/transactions/nope'),
      { status: 404, code: 'TRANSACTION_NOT_FOUND' },
    );
  });

  test('404 for an unknown id, 400 for one that is not a uuid', async () => {
    expectError(
      await app.get(`/wagering/transactions/${crypto.randomUUID()}`),
      { status: 404, code: 'TRANSACTION_NOT_FOUND' },
    );
    expectError(await app.get('/wagering/transactions/abc'), {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('a healthy wallet: the enunciado shape, consistent true, the entries checked', async () => {
    const { wallet } = await walletWithBets(3);
    const response = await app.post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '997.00', currency: 'BRL' },
      calculatedBalance: { amount: '997.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
      findings: [],
    });
  });

  test('a divergence: consistent false in the response, an ERROR log with the wallet and the kinds (no amounts), and the metric goes up; nothing is corrected', async () => {
    const { wallet } = await walletWithBets(2);
    await app.sql('UPDATE wallets SET balance = balance + 7.77 WHERE id = ?', [
      wallet.id,
    ]);
    app.logs.clear();
    const before = parseMetrics((await app.get('/metrics')).text);

    const response = await app.post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(response.status).toBe(200); // a consulta funcionou; o que ela ENCONTROU é o que vem no corpo
    expect(response.body).toMatchObject({
      consistent: false,
      difference: { amount: '7.77', currency: 'BRL' },
      findings: ['balance_mismatch'],
    });

    const errors = app.logs
      .at('error')
      .filter((e) =>
        JSON.stringify(e.message).includes('reconciliation_divergence'),
      );
    expect(errors).toHaveLength(1);
    const logged = JSON.stringify(errors[0]?.message);
    expect(logged).toContain(wallet.id);
    expect(logged).toContain('balance_mismatch');
    expect(logged).not.toContain('7.77'); // nenhum valor no log

    const after = parseMetrics((await app.get('/metrics')).text);
    const series =
      'wallet_reconciliation_divergences_total{kind="balance_mismatch"}';
    expect((after[series] ?? 0) - (before[series] ?? 0)).toBe(1);

    const stored = await app.sql('SELECT balance FROM wallets WHERE id = ?', [
      wallet.id,
    ]);
    expect(String(stored[0]?.balance)).toBe('1005.77'); // continua adulterado: nunca corrige sozinho
  });

  test('404 for an unknown wallet, 400 for a malformed id', async () => {
    expectError(
      await app.post(`/wallets/${crypto.randomUUID()}/reconciliation`, {}),
      { status: 404, code: 'WALLET_NOT_FOUND' },
    );
    expectError(await app.post('/wallets/zzz/reconciliation', {}), {
      status: 400,
      code: 'INVALID_PAYLOAD',
      withDetails: true,
    });
  });
});

describe('the new routes are behind the guard (ADR-0010)', () => {
  const ROUTES: Array<['GET' | 'POST', string]> = [
    ['GET', `/wallets/${crypto.randomUUID()}`],
    ['GET', `/wallets/${crypto.randomUUID()}/ledger`],
    ['POST', `/wallets/${crypto.randomUUID()}/reconciliation`],
    ['GET', `/wagering/transactions/${crypto.randomUUID()}`],
    ['GET', '/providers/provider-a/wagering/transactions/x'],
  ];

  test.each(ROUTES)('%s %s with no credential is 401', async (method, path) => {
    const response =
      method === 'GET' ? await locked.get(path) : await locked.post(path, {});
    expectError(response, { status: 401, code: 'UNAUTHENTICATED' });
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test.each(ROUTES)(
    '%s %s with a valid token passes the guard (and then 404/400 is the use case answering)',
    async (method, path) => {
      const headers = { authorization: 'Bearer token-a' };
      const response =
        method === 'GET'
          ? await secured.get(path, headers)
          : await secured.post(path, {}, headers);
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    },
  );

  test('a token for provider-a cannot read the transactions of /providers/provider-b (403), but can read its own', async () => {
    const headers = { authorization: 'Bearer token-a' };
    expectError(
      await secured.get(
        '/providers/provider-b/wagering/transactions/x',
        headers,
      ),
      { status: 403, code: 'PROVIDER_FORBIDDEN' },
    );
    expect(
      (
        await secured.get(
          '/providers/provider-a/wagering/transactions/x',
          headers,
        )
      ).status,
    ).toBe(404);
  });
});

describe('the pending-reference gauge', () => {
  test('/metrics shows how many transactions wait for their reference, read at the scrape', async () => {
    const before =
      parseMetrics((await app.get('/metrics')).text)
        .pending_reference_transactions ?? -1;
    expect(before).toBeGreaterThanOrEqual(0);
    const wallet = await createWalletVia(app, '100.00');
    for (let i = 0; i < 2; i++) {
      await submitVia(
        app,
        wagerBody(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: `ghost-${crypto.randomUUID()}`,
          money: { amount: '1.00', currency: 'BRL' },
        }),
      );
    }
    const after = parseMetrics(
      (await app.get('/metrics')).text,
    ).pending_reference_transactions;
    expect((after as number) - before).toBe(2);
  });
});
