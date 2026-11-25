import { describe, test } from 'bun:test';
import { expectViolation } from '../support/assertions.js';
import { useSql } from '../support/database.js';

// SQL direto no banco real: cada teste tenta violar uma regra do schema.
const sql = useSql();

describe('wallets', () => {
  const insertWallet = (
    overrides: {
      playerId?: string;
      currency?: string;
      balance?: string;
      version?: number;
    } = {},
  ) =>
    sql(
      'INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        overrides.playerId ?? crypto.randomUUID(),
        overrides.currency ?? 'BRL',
        overrides.balance ?? '100.00',
        overrides.version ?? 1,
      ],
    );

  test('accepts a valid wallet', async () => {
    await insertWallet();
  });

  test('rejects a negative balance', async () => {
    await expectViolation(
      insertWallet({ balance: '-0.01' }),
      'ck_wallets_balance_non_negative',
    );
  });

  test('rejects a second wallet for the same player and currency', async () => {
    const playerId = crypto.randomUUID();
    await insertWallet({ playerId, currency: 'BRL' });
    await expectViolation(
      insertWallet({ playerId, currency: 'BRL' }),
      'uq_wallets_player_currency',
    );
    await insertWallet({ playerId, currency: 'USD' }); // outra moeda é permitida
  });

  test('rejects a malformed currency', async () => {
    await expectViolation(
      insertWallet({ currency: 'brl' }),
      'ck_wallets_currency_format',
    );
  });

  test('rejects version below 1', async () => {
    await expectViolation(
      insertWallet({ version: 0 }),
      'ck_wallets_version_positive',
    );
  });
});
