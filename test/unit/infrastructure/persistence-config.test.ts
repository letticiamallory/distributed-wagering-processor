import { describe, expect, test } from 'bun:test';
import config from '../../../src/infrastructure/persistence/mikro-orm.config.js';

// ADR-0007: pelo menos 20 conexões (N requisições concorrentes viram N transações de
// verdade) e no máximo 3 s de espera por uma conexão livre (medido: com 1 s, uma rajada de 150
// requisições em 30 wallets dava 58-70% de 503; com 3 s, 13-35%, com o p95 abaixo de 5 s).
describe('persistence config: pool defaults (ADR-0007)', () => {
  test('the pool has room for 20 concurrent transactions', () => {
    expect(config.pool?.max).toBeGreaterThanOrEqual(20);
  });

  test('waiting for a free connection is limited to 3 seconds', () => {
    expect(config.driverOptions?.connectionTimeoutMillis).toBe(3_000);
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
