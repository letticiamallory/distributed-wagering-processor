import { describe, expect, test } from 'bun:test';
import { usePersistence } from '../support/persistence.js';
import { failIfAny, recordMetrics } from '../support/ledger-check.js';
import { createScenario } from '../support/wager-scenarios.js';

// A terceira barreira (ADR-0007): MESMO que um bug tire o lock e a versão, o BANCO recusa o saldo
// negativo. Aqui não há aplicação no meio: dois UPDATEs em SQL puro, ao mesmo tempo, na mesma
// wallet de 100.00, cada um tirando 80.00. O Postgres serializa as duas linhas, e o CHECK recusa a
// que deixaria o saldo em -60.00.
//
// Por que existe: com o lock ligado, o código nunca chega perto do CHECK, e nenhum outro teste
// desta suíte o exercita. Sem ele, o CHECK poderia sumir sem que ninguém notasse.
const db = usePersistence();
const s = createScenario(db);
const ROUNDS = 50;

describe('the database refuses a negative balance on its own, under concurrency', () => {
  test(`two parallel debits of 80.00 on 100.00: one is refused by ck_wallets_balance_non_negative (${ROUNDS} rounds)`, async () => {
    const problems: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      // Uma wallet de FIXTURE (sem ledger, datada de 2000): este teste mexe no saldo por fora da
      // aplicação de propósito, então ela fica de fora do check global das wallets da suíte.
      const wallet = { id: crypto.randomUUID() };
      await s.sql(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', '100.00', 1, '2000-01-01', '2000-01-01')`,
        [wallet.id, crypto.randomUUID()],
      );
      const debit = () =>
        s.sql(
          'UPDATE wallets SET balance = balance - 80.00 WHERE id = ? RETURNING balance::text AS balance',
          [wallet.id],
        );

      const [first, second] = await Promise.allSettled([debit(), debit()]);

      const settled = [first, second];
      const refused = settled.filter((r) => r.status === 'rejected');
      const accepted = settled.filter((r) => r.status === 'fulfilled');
      const refusalText = refused
        .map((r) => String((r as PromiseRejectedResult).reason))
        .join(' ');
      if (accepted.length !== 1 || refused.length !== 1) {
        problems.push(
          `round ${round}: ${accepted.length} accepted and ${refused.length} refused, expected 1 and 1`,
        );
      } else if (!refusalText.includes('ck_wallets_balance_non_negative')) {
        problems.push(
          `round ${round}: refused by something else: ${refusalText.slice(0, 120)}`,
        );
      }
      const balance = String(
        (
          await s.sql(
            'SELECT balance::text AS balance FROM wallets WHERE id = ?',
            [wallet.id],
          )
        )[0]?.balance,
      );
      if (balance !== '20.00') {
        problems.push(
          `round ${round}: final balance ${balance}, expected 20.00`,
        );
      }
    }

    failIfAny('CHECK (balance >= 0)', ROUNDS, problems);
    expect(problems).toEqual([]);
    recordMetrics('7 CHECK refuses negative', {
      rounds: ROUNDS,
      invariants: 'OK',
    });
  }, 120_000);
});
