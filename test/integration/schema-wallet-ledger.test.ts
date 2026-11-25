import { describe, test } from 'bun:test';
import { expectViolation } from '../support/assertions.js';
import { useSql } from '../support/database.js';
import { createFixtures, type Row, type Wallet } from '../support/fixtures.js';

// SQL direto no banco real: cada teste tenta violar uma regra do schema.
const sql = useSql();
const { newWallet, insertTransaction } = createFixtures(sql);

// Cada teste cria a sua wallet e as suas transações: o ledger não aceita DELETE.
async function setup(currency = 'BRL') {
  const wallet = await newWallet(currency);
  const transactionId = await insertTransaction(wallet);
  return { wallet, transactionId };
}

// Um DEBIT válido: 100,00 - 30,00 = 70,00, versão 1.
function insertEntry(
  wallet: Wallet,
  transactionId: string,
  overrides: Row = {},
): Promise<unknown> {
  const row: Row = {
    id: crypto.randomUUID(),
    wallet_id: wallet.walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '30.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '70.00',
    wallet_version: 1,
    ...overrides,
  };
  const columns = Object.keys(row);
  return sql(
    `INSERT INTO wallet_ledger_entries (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

describe('wallet_ledger_entries: accepts what it should', () => {
  test('accepts a valid DEBIT', async () => {
    const { wallet, transactionId } = await setup();
    await insertEntry(wallet, transactionId);
  });

  test('accepts a valid CREDIT', async () => {
    const { wallet, transactionId } = await setup();
    await insertEntry(wallet, transactionId, {
      direction: 'CREDIT',
      balance_after: '130.00',
    });
  });

  test('accepts a chain of versions 1, 2 on the same wallet', async () => {
    const { wallet, transactionId } = await setup();
    const second = await insertTransaction(wallet);
    await insertEntry(wallet, transactionId); // 100 -> 70
    await insertEntry(wallet, second, {
      direction: 'CREDIT',
      balance_before: '70.00',
      balance_after: '100.00',
      wallet_version: 2,
    });
  });
});

describe('wallet_ledger_entries: arithmetic and amounts', () => {
  test('rejects a DEBIT whose arithmetic is wrong (100 - 30 = 80)', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, { balance_after: '80.00' }),
      'ck_ledger_arithmetic',
    );
  });

  test('rejects a CREDIT whose arithmetic is wrong (100 + 30 = 120)', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, {
        direction: 'CREDIT',
        balance_after: '120.00',
      }),
      'ck_ledger_arithmetic',
    );
  });

  test('rejects direction DEBIT that would leave the balance negative', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, {
        balance_before: '10.00',
        balance_after: '-20.00',
      }),
      'ck_ledger_balance_after_non_negative',
    );
  });

  test('rejects amount 0 and negative amounts', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, {
        amount: '0.00',
        balance_after: '100.00',
      }),
      'ck_ledger_amount_positive',
    );
    await expectViolation(
      insertEntry(wallet, transactionId, {
        amount: '-30.00',
        balance_after: '130.00',
      }),
      'ck_ledger_amount_positive',
    );
  });

  // Não existe CHECK só para a direção: a aritmética já aceita apenas DEBIT e CREDIT.
  test('rejects an unknown direction', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, { direction: 'SIDEWAYS' }),
      'ck_ledger_arithmetic',
    );
  });

  test('rejects wallet_version below 1', async () => {
    const { wallet, transactionId } = await setup();
    await expectViolation(
      insertEntry(wallet, transactionId, { wallet_version: 0 }),
      'ck_ledger_version_positive',
    );
  });
});

describe('wallet_ledger_entries: uniqueness and currency', () => {
  test('rejects two entries for the same transaction and wallet', async () => {
    const { wallet, transactionId } = await setup();
    await insertEntry(wallet, transactionId);
    // Versão diferente, para só a regra (transação, wallet) ser violada.
    await expectViolation(
      insertEntry(wallet, transactionId, {
        balance_before: '70.00',
        balance_after: '40.00',
        wallet_version: 2,
      }),
      'uq_ledger_tx_wallet',
    );
  });

  test('rejects two entries with the same wallet_version', async () => {
    const { wallet, transactionId } = await setup();
    const other = await insertTransaction(wallet);
    await insertEntry(wallet, transactionId);
    await expectViolation(
      insertEntry(wallet, other, {
        balance_before: '70.00',
        balance_after: '40.00',
      }),
      'uq_ledger_wallet_version',
    );
  });

  test('rejects an entry in a currency different from the wallet', async () => {
    const { wallet, transactionId } = await setup('BRL');
    await expectViolation(
      insertEntry(wallet, transactionId, { currency: 'USD' }),
      'fk_ledger_wallet_currency',
    );
  });
});

describe('wallet_ledger_entries: append-only', () => {
  async function entry() {
    const { wallet, transactionId } = await setup();
    const id = crypto.randomUUID();
    await insertEntry(wallet, transactionId, { id });
    return id;
  }

  test('rejects UPDATE', async () => {
    const id = await entry();
    await expectViolation(
      sql("UPDATE wallet_ledger_entries SET amount = '31.00' WHERE id = ?", [
        id,
      ]),
      'append-only (UPDATE)',
    );
  });

  test('rejects DELETE', async () => {
    const id = await entry();
    await expectViolation(
      sql('DELETE FROM wallet_ledger_entries WHERE id = ?', [id]),
      'append-only (DELETE)',
    );
  });

  test('rejects TRUNCATE', async () => {
    await entry();
    await expectViolation(
      sql('TRUNCATE wallet_ledger_entries'),
      'append-only (TRUNCATE)',
    );
  });
});
