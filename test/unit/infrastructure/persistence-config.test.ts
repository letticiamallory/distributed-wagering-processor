import { describe, expect, test } from 'bun:test';
import config from '../../../src/infrastructure/persistence/mikro-orm.config.js';

// ADR-0007: pelo menos 20 conexões (N requisições concorrentes viram N transações de
// verdade) e no máximo 1s de espera por uma conexão livre (pool cheio = 503 rápido, não fila).
describe('persistence config: pool defaults (ADR-0007)', () => {
  test('the pool has room for 20 concurrent transactions', () => {
    expect(config.pool?.max).toBeGreaterThanOrEqual(20);
  });

  test('waiting for a free connection is limited to 1 second', () => {
    expect(config.driverOptions?.connectionTimeoutMillis).toBe(1_000);
  });

  test('every table has its row mapping registered', () => {
    const names = (config.entities as Array<{ meta?: { tableName?: string } }>)
      .map((e) => String(e.meta?.tableName))
      .sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});
