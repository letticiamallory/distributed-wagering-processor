import { describe, expect, test } from 'bun:test';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// C6 do avaliador: "toda alteração de saldo tem um lançamento no ledger" só valia no código. Por SQL
// dava para mudar o saldo ou pular a versão sem lançamento, e a reconciliação só DETECTAVA depois.
// Agora uma constraint diferida (conferida no COMMIT) exige, para o estado final de cada wallet, o
// lançamento da versão atual com balance_after = saldo. A única wallet sem lançamento é a que nasceu
// zerada e nunca mudou (versão 1, saldo 0.00).
const db = usePersistence();
const s = createScenario(db);

// Uma transação de verdade (o erro da constraint diferida só aparece no COMMIT).
async function inTransaction(
  statements: Array<[string, unknown[]]>,
): Promise<unknown> {
  try {
    await db()
      .orm.em.fork()
      .transactional(async (tx) => {
        const connection = tx.getConnection();
        for (const [query, params] of statements) {
          await connection.execute(
            query,
            params,
            'all',
            tx.getTransactionContext(),
          );
        }
      });
    return 'committed';
  } catch (error) {
    return error;
  }
}

const refused = (outcome: unknown) => {
  expect(outcome).not.toBe('committed');
  expect(String((outcome as Error).message)).toContain('ledger');
};

describe('the database refuses a balance change without its ledger entry', () => {
  test('UPDATE of the balance alone is refused at COMMIT', async () => {
    const wallet = await s.walletWith('100.00');
    refused(
      await inTransaction([
        [
          'UPDATE wallets SET balance = balance + 1000 WHERE id = ?',
          [wallet.id],
        ],
      ]),
    );
    expect(await s.balanceOf(wallet)).toBe('100.00');
  });

  test('skipping versions without entries is refused', async () => {
    const wallet = await s.walletWith('100.00');
    refused(
      await inTransaction([
        ['UPDATE wallets SET version = version + 7 WHERE id = ?', [wallet.id]],
      ]),
    );
  });

  test('balance and version moved together, but with no entry for the new version, is refused', async () => {
    const wallet = await s.walletWith('100.00');
    refused(
      await inTransaction([
        [
          'UPDATE wallets SET balance = balance - 10, version = version + 1 WHERE id = ?',
          [wallet.id],
        ],
      ]),
    );
  });

  test('a wallet born with a balance and no OPENING entry is refused', async () => {
    refused(
      await inTransaction([
        [
          'INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, ?)',
          [crypto.randomUUID(), crypto.randomUUID(), 'BRL', '100.00', 1],
        ],
      ]),
    );
  });

  test('a wallet born at 0.00 needs no entry', async () => {
    expect(
      await inTransaction([
        [
          'INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, ?)',
          [crypto.randomUUID(), crypto.randomUUID(), 'BRL', '0.00', 1],
        ],
      ]),
    ).toBe('committed');
  });

  test('the normal flow still commits: opening, BET, WIN, rejection, and a wallet created at zero', async () => {
    const wallet = await s.walletWith('100.00');
    await s.placeBet(wallet, '25.00');
    await s.submit(
      s.body(wallet, {
        kind: 'WIN',
        money: { amount: '5.00', currency: 'BRL' },
      }),
    );
    await s.placeBet(wallet, '999.00'); // REJECTED: não mexe no saldo
    expect(await s.balanceOf(wallet)).toBe('80.00');
    const zero = await s.walletWith('0.00');
    await s.submit(
      s.body(zero, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }),
    );
    expect(await s.balanceOf(zero)).toBe('5.00');
  });
});
