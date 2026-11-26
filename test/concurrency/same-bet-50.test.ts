import { afterAll, beforeAll, test } from 'bun:test';
import { startApp, type Json, type TestApp } from '../support/http-app.js';
import {
  countErrorNames,
  expectNoProblems,
  failIfAny,
  recordMetrics,
  walletFacts,
} from '../support/ledger-check.js';
import { ProviderClient } from '../support/provider-client.js';
import { rounds } from '../support/rounds.js';

// "A mesma aposta enviada 50 vezes em paralelo -> um único débito" (enunciado, seção 13).
// Repetido em várias rodadas, cada uma com uma wallet nova. Quem reenvia depois de um 503 usa a
// MESMA Idempotency-Key, então nada pode contar duas vezes.
const ROUNDS = rounds(10);
const COPIES = 50;

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
}, 60_000);
afterAll(async () => {
  await app.close();
});

test(`the same BET ${COPIES} times in parallel: one 201, ${COPIES - 1} replays, one debit (${ROUNDS} rounds)`, async () => {
  const client = new ProviderClient();
  const setup = new ProviderClient();
  const problems: string[] = [];
  app.logs.clear();
  const walletIds: string[] = [];
  const startedAt = performance.now();

  for (let round = 0; round < ROUNDS; round++) {
    const wallet = await setup.createWallet(app.url, '100.00');
    walletIds.push(wallet.id);
    const input: Json = {
      providerId: 'provider-a',
      externalTransactionId: `same-bet-${Bun.randomUUIDv7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const responses = await Promise.all(
      Array.from({ length: COPIES }, () => client.submit(app.url, input)),
    );

    const created = responses.filter((r) => r.status === 201).length;
    const replays = responses.filter((r) => r.status === 200).length;
    const others = responses.filter(
      (r) => r.status !== 201 && r.status !== 200,
    );
    if (created !== 1 || replays !== COPIES - 1 || others.length > 0) {
      problems.push(
        `round ${round}: ${created} x 201, ${replays} x 200, others [${others.map((r) => `${r.status} ${String(r.body?.error ? (r.body.error as { code: string }).code : '')}`).join(', ')}]`,
      );
    }
    if (new Set(responses.map((r) => r.body?.transactionId)).size !== 1) {
      problems.push(
        `round ${round}: the copies answered with different transactionIds`,
      );
    }
    const facts = await walletFacts(app.sql, wallet.id);
    if (facts.debits !== 1 || facts.balance !== '75.00') {
      problems.push(
        `round ${round}: ${facts.debits} DEBITs and balance ${facts.balance}, expected 1 DEBIT and 75.00`,
      );
    }
  }
  const ledger = await expectNoProblems(app.sql, walletIds);
  failIfAny('same BET x50', ROUNDS, [...problems, ...ledger], {
    errors: countErrorNames(app.logs.at('error')),
  });

  recordMetrics(`2 same BET x50, ${ROUNDS} rounds`, {
    requests: client.stats.requests,
    attempts: client.stats.attempts,
    status503: client.stats.status503,
    retries: client.stats.retries,
    elapsedMs: Math.round(performance.now() - startedAt),
    invariants: 'OK',
  });
}, 300_000);
