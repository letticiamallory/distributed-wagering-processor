import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { holding } from '../support/concurrency.js';
import {
  createWalletVia,
  defaultKeyOf,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import {
  expectNoProblems,
  failIfAny,
  recordMetrics,
  walletFacts,
} from '../support/ledger-check.js';
import { ProviderClient, mapLimit } from '../support/provider-client.js';

// O lock é POR WALLET, não global (enunciado, seção 8: "wallets diferentes são processadas em
// paralelo"). A prova NÃO mede tempo: com a wallet A travada por uma transação aberta, uma BET na
// wallet B tem de TERMINAR. Se o lock fosse global, B esperaria A, e A só solta depois que B
// terminar: o lock_timeout (curto, aqui) estoura e B volta 503. Falha por lógica, não por relógio.
let app: TestApp;
beforeAll(async () => {
  app = await startApp({ env: { DB_LOCK_TIMEOUT_MS: '1500' } });
}, 60_000);
afterAll(async () => {
  await app.close();
});

const lockWallet =
  (walletId: string) =>
  async ({ locked, until }: { locked: () => void; until: Promise<void> }) => {
    await app.db.uow.run(async (repositories) => {
      await repositories.wallets.lockById(walletId);
      locked();
      await until; // a transação fica ABERTA, segurando o lock, até a etapa do meio terminar
    });
  };

describe('the lock belongs to a wallet, not to the system', () => {
  test('with wallet A locked by an open transaction, a BET on wallet B completes', async () => {
    const a = await createWalletVia(app, '100.00');
    const b = await createWalletVia(app, '100.00');
    const input = wagerBody(b);

    const response = await holding(lockWallet(a.id), () =>
      submitVia(app, input, defaultKeyOf(input)),
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00' },
    });
    expect((await walletFacts(app.sql, a.id)).balance).toBe('100.00');
    expect((await walletFacts(app.sql, b.id)).balance).toBe('75.00');
    expect(await expectNoProblems(app.sql, [a.id, b.id])).toEqual([]);
  }, 60_000);

  test('the lock is REAL on the same wallet: with A locked, an operation on A waits and times out (503), and the same key works once it is released', async () => {
    const a = await createWalletVia(app, '100.00');
    const input = wagerBody(a);

    const blocked = await holding(lockWallet(a.id), () =>
      submitVia(app, input, defaultKeyOf(input)),
    );

    expect(blocked.status).toBe(503);
    expect((blocked.body as { error: { code: string } }).error.code).toBe(
      'DEPENDENCY_UNAVAILABLE',
    );
    expect((await walletFacts(app.sql, a.id)).debits).toBe(0);

    const retry = await submitVia(app, input, defaultKeyOf(input));
    expect(retry.status).toBe(201);
    expect((await walletFacts(app.sql, a.id)).debits).toBe(1);
  }, 60_000);

  test('many wallets at once, several operations each: every wallet ends with exactly its own result', async () => {
    const WALLETS = 50;
    const BETS_EACH = 3;
    const client = new ProviderClient();
    const setup = new ProviderClient();
    const wallets = await mapLimit(
      Array.from({ length: WALLETS }, (_, i) => i),
      10,
      () => setup.createWallet(app.url, '100.00'),
    );
    const startedAt = performance.now();

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: BETS_EACH }, (_, n) =>
          client.submit(app.url, {
            ...wagerBody(wallet),
            money: { amount: '10.00', currency: 'BRL' },
            roundId: `round-${n}`,
          }),
        ),
      ),
    );

    const problems: string[] = [];
    responses.forEach((response, i) => {
      if (response.status !== 201)
        problems.push(
          `request ${i}: HTTP ${response.status} ${response.text.slice(0, 100)}`,
        );
    });
    for (const wallet of wallets) {
      const facts = await walletFacts(app.sql, wallet.id);
      if (facts.balance !== '70.00' || facts.debits !== BETS_EACH) {
        problems.push(
          `wallet ${wallet.id}: ${facts.debits} DEBITs, balance ${facts.balance}, expected ${BETS_EACH} and 70.00`,
        );
      }
    }
    failIfAny('many wallets', WALLETS, [
      ...problems,
      ...(await expectNoProblems(
        app.sql,
        wallets.map((w) => w.id),
      )),
    ]);
    recordMetrics('4 distinct wallets in parallel', {
      wallets: WALLETS,
      requests: responses.length,
      attempts: client.stats.attempts,
      status503: client.stats.status503,
      retries: client.stats.retries,
      elapsedMs: Math.round(performance.now() - startedAt),
      invariants: 'OK',
    });
  }, 120_000);
});
