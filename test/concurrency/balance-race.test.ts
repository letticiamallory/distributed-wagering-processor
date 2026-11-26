import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { simultaneously } from '../support/concurrency.js';
import { startApp, type Json, type TestApp } from '../support/http-app.js';
import {
  assertWalletIsConsistent,
  countErrorNames,
  describeFacts,
  expectNoProblems,
  failIfAny,
  recordMetrics,
  walletFacts,
} from '../support/ledger-check.js';
import { ProviderClient, mapLimit } from '../support/provider-client.js';
import { createScenario } from '../support/wager-scenarios.js';

// O cenário OBRIGATÓRIO da seção 8 do enunciado, EXATAMENTE como está escrito:
//   saldo inicial 100.00 BRL; duas apostas de 80.00 BRL processadas simultaneamente
//   -> exatamente uma PROCESSED; a outra REJECTED por saldo insuficiente; saldo final 20.00;
//      exatamente um lançamento de débito no ledger.
// Repetido em muitas rodadas, cada uma com uma wallet nova, para provar que é DETERMINÍSTICO e não
// sorte: se o lock sumir, uma rodada isolada pode escapar por acaso, cem não.
const ROUNDS = 100;

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const bet = (
  wallet: { id: string; playerId: string },
  external: string,
): Json => ({
  providerId: 'provider-a',
  externalTransactionId: external,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '80.00', currency: 'BRL' },
});

// O que tem de ser verdade depois de CADA rodada, lido do banco por fora da aplicação.
async function roundProblems(
  walletId: string,
  outcomes: Array<{ status: string; failureCode?: string; label: string }>,
): Promise<string[]> {
  const problems: string[] = [];
  const statuses = outcomes
    .map((o) => o.status)
    .sort((a, b) => a.localeCompare(b));
  if (statuses.join(',') !== 'PROCESSED,REJECTED') {
    problems.push(
      `statuses were [${outcomes.map((o) => o.label).join(' | ')}], expected one PROCESSED and one REJECTED`,
    );
  }
  const rejected = outcomes.find((o) => o.status === 'REJECTED');
  if (rejected && rejected.failureCode !== 'INSUFFICIENT_FUNDS') {
    problems.push(
      `the rejection was ${String(rejected.failureCode)}, expected INSUFFICIENT_FUNDS`,
    );
  }
  const facts = await walletFacts(app.sql, walletId);
  if (facts.balance !== '20.00') {
    problems.push(`final balance ${facts.balance}, expected 20.00`);
  }
  if (facts.debits !== 1) {
    problems.push(
      `${facts.debits} DEBIT entries in the ledger, expected exactly 1`,
    );
  }
  const ledger = await expectNoProblems(app.sql, [walletId]);
  return [...problems, ...ledger.map((p) => `ledger: ${p}`)];
}

describe('section 8: two BETs of 80.00 on a wallet of 100.00, at the same time', () => {
  test(`1a. through the use case, both released together to fight for the lock (${ROUNDS} rounds)`, async () => {
    // O relógio do cenário começa AGORA (e não na data fixa dos outros testes): as wallets desta
    // suíte têm de ter a data real, senão escapam do escopo do check global.
    const scenario = createScenario(() => app.db, { start: new Date() });
    const problems: string[] = [];
    const firstWon = { a: 0, b: 0 };

    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await scenario.walletWith('100.00');
      const a = scenario.body(wallet, {
        money: { amount: '80.00', currency: 'BRL' },
      });
      const b = scenario.body(wallet, {
        money: { amount: '80.00', currency: 'BRL' },
      });

      // Os dois passam pela checagem rápida e SÓ ENTÃO são soltos juntos para disputar o lock.
      const [ra, rb] = await simultaneously(
        app.db.uow,
        (gate) => scenario.submit(a, {}, scenario.build({ uow: gate })),
        (gate) => scenario.submit(b, {}, scenario.build({ uow: gate })),
      );

      const outcomes = [ra, rb].map((outcome, i) =>
        outcome.ok
          ? {
              status: outcome.value.status,
              failureCode: outcome.value.failureCode,
              label: `${outcome.value.status}${outcome.value.failureCode ? ` ${outcome.value.failureCode}` : ''}`,
            }
          : {
              status: 'ERROR',
              failureCode: undefined,
              label: `${i === 0 ? 'A' : 'B'} threw ${(outcome.error as Error).name}: ${(outcome.error as Error).message.slice(0, 90)}`,
            },
      );
      if (outcomes[0]?.status === 'PROCESSED') firstWon.a++;
      else firstWon.b++;
      for (const problem of await roundProblems(wallet.id, outcomes)) {
        problems.push(`round ${round}: ${problem}`);
      }
    }

    failIfAny('1a', ROUNDS, problems);
    // Quem ganha o lock é arbitrário: só registramos a distribuição, não a afirmamos.
    recordMetrics('1a use case, 100 rounds', {
      rounds: ROUNDS,
      ...firstWon,
      invariants: 'OK',
    });
  }, 300_000);

  test(`1b. over HTTP, two requests in flight at once (${ROUNDS} rounds)`, async () => {
    const client = new ProviderClient();
    const setup = new ProviderClient();
    const problems: string[] = [];
    app.logs.clear();

    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await setup.createWallet(app.url, '100.00');
      const [first, second] = await Promise.all([
        client.submit(app.url, bet(wallet, `race-a-${Bun.randomUUIDv7()}`)),
        client.submit(app.url, bet(wallet, `race-b-${Bun.randomUUIDv7()}`)),
      ]);

      const outcomes = [first, second].map((r) => ({
        status: text(r.body?.status) || `HTTP ${r.status}`,
        failureCode: r.body?.failureCode as string | undefined,
        label:
          `${r.status} ${text(r.body?.status)} ${text(r.body?.failureCode)}`.trim(),
      }));
      const wellFormed =
        [first.status, second.status].sort((a, b) => a - b).join(',') ===
        '201,422';
      if (!wellFormed) {
        problems.push(
          `round ${round}: HTTP statuses ${first.status},${second.status}, expected 201 and 422`,
        );
      }
      for (const problem of await roundProblems(wallet.id, outcomes)) {
        problems.push(`round ${round}: ${problem}`);
      }
    }

    failIfAny('1b', ROUNDS, problems, {
      errors: countErrorNames(app.logs.at('error')),
    });
    recordMetrics('1b http, 100 rounds', {
      rounds: ROUNDS,
      ...client.stats,
      elapsedMs: client.elapsedMs(),
      invariants: 'OK',
    });
  }, 300_000);

  test(`1c. ${ROUNDS} wallets at the same time, two BETs each (${ROUNDS * 2} requests in flight)`, async () => {
    const client = new ProviderClient();
    const setup = new ProviderClient();
    app.logs.clear();
    const wallets = await mapLimit(
      Array.from({ length: ROUNDS }, (_, i) => i),
      10,
      () => setup.createWallet(app.url, '100.00'),
    );
    const startedAt = performance.now();

    // As 200 requisições saem juntas: mais que o pool de conexões (20), então parte delas leva 503
    // e é reenviada com a MESMA chave, como um provedor faria.
    const responses = await Promise.all(
      wallets.flatMap((wallet) => [
        client.submit(app.url, bet(wallet, `wide-a-${Bun.randomUUIDv7()}`)),
        client.submit(app.url, bet(wallet, `wide-b-${Bun.randomUUIDv7()}`)),
      ]),
    );
    const elapsedMs = Math.round(performance.now() - startedAt);

    const problems: string[] = [];
    for (let i = 0; i < wallets.length; i++) {
      const pair = [responses[2 * i], responses[2 * i + 1]];
      const outcomes = pair.map((r) => ({
        status: text(r?.body?.status) || `HTTP ${String(r?.status)}`,
        failureCode: r?.body?.failureCode as string | undefined,
        label:
          `${String(r?.status)} ${text(r?.body?.status)} ${text(r?.body?.failureCode)}`.trim(),
      }));
      for (const problem of await roundProblems(
        (wallets[i] as { id: string }).id,
        outcomes,
      )) {
        problems.push(`wallet ${i}: ${problem}`);
      }
    }
    failIfAny('1c', wallets.length, problems, {
      errors: countErrorNames(app.logs.at('error')),
    });

    recordMetrics('1c wide, 100 wallets x 2 BETs', {
      requests: responses.length,
      attempts: client.stats.attempts,
      status503: client.stats.status503,
      retries: client.stats.retries,
      elapsedMs,
      invariants: 'OK',
    });
    // Reenviar nunca duplicou: 200 requisições, 200 linhas de transação.
    const rows = await app.sql(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ANY(?::uuid[]) AND kind = 'BET'`,
      [`{${wallets.map((w) => w.id).join(',')}}`],
    );
    expect(rows[0]?.n).toBe(responses.length);
    for (const wallet of wallets.slice(0, 5)) {
      const facts = await assertWalletIsConsistent(app.sql, wallet.id);
      expect(describeFacts(facts)).toContain('balance=20.00');
    }
  }, 300_000);
});
