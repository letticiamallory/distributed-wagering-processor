import { expect } from 'bun:test';
import { Money } from '../../src/domain/money/money.js';

type Row = Record<string, unknown>;
type Sql = (query: string, params?: unknown[]) => Promise<unknown>;

const money = (amount: unknown, currency: unknown) =>
  Money.from({ amount: String(amount), currency: String(currency) });

// As invariantes que valem para QUALQUER wallet, depois de qualquer sequência de operações.
// Versão mínima da Fase 3 (a Fase 4 a amplia com concorrência e a reconciliação):
//   1. o saldo da wallet é o `balance_after` do último lançamento, e a version é a dele;
//   2. o ledger é uma corrente sem buracos: versões 1..n e cada `balance_before` é o
//      `balance_after` do anterior, com a aritmética certa por direção;
//   3. o saldo nunca é negativo;
//   4. todo lançamento pertence a uma transação PROCESSED da própria wallet;
//   5. toda transação PROCESSED que move saldo (valor > 0 e não LOSS) tem exatamente UM
//      lançamento, e as que não movem (LOSS, valor 0) não têm nenhum.
export async function assertInvariants(
  sql: Sql,
  walletId: string,
): Promise<void> {
  const wallets = (await sql('SELECT * FROM wallets WHERE id = ?', [
    walletId,
  ])) as Row[];
  expect(wallets).toHaveLength(1);
  const wallet = wallets[0] as Row;
  const currency = wallet.currency;
  const balance = money(wallet.balance, currency);
  expect(balance.isNegative()).toBe(false);

  const entries = (await sql(
    'SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version',
    [walletId],
  )) as Row[];

  if (entries.length === 0) {
    expect(balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  } else {
    let previousAfter = Money.zero(String(currency));
    entries.forEach((entry, index) => {
      expect(entry.wallet_version).toBe(index + 1);
      const before = money(entry.balance_before, entry.currency);
      const after = money(entry.balance_after, entry.currency);
      const amount = money(entry.amount, entry.currency);
      expect(before.equals(previousAfter)).toBe(true);
      const expected =
        entry.direction === 'CREDIT'
          ? before.add(amount)
          : before.subtract(amount);
      expect(after.equals(expected)).toBe(true);
      expect(after.isNegative()).toBe(false);
      previousAfter = after;
    });
    const last = entries[entries.length - 1] as Row;
    expect(balance.equals(money(last.balance_after, currency))).toBe(true);
    expect(wallet.version).toBe(last.wallet_version);
  }

  const transactions = (await sql(
    'SELECT * FROM wager_transactions WHERE wallet_id = ?',
    [walletId],
  )) as Row[];
  const byId = new Map(transactions.map((tx) => [tx.id, tx]));

  for (const entry of entries) {
    const tx = byId.get(entry.transaction_id);
    expect(tx).toBeDefined();
    expect(tx?.status).toBe('PROCESSED');
  }

  for (const tx of transactions) {
    if (tx.status !== 'PROCESSED') {
      continue;
    }
    const amount = money(tx.amount, tx.currency);
    const movesBalance = tx.kind !== 'LOSS' && !amount.isZero();
    const mine = entries.filter((entry) => entry.transaction_id === tx.id);
    expect(mine).toHaveLength(movesBalance ? 1 : 0);
  }
}
