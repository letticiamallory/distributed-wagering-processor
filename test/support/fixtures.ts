export type Sql = (query: string, params?: unknown[]) => Promise<unknown>;
export type Row = Record<string, unknown>;
export type Wallet = { walletId: string; playerId: string };

// Dados de apoio para os testes de schema. Cada chamada cria UUIDs novos, porque o
// ledger não aceita DELETE e por isso nada é limpo entre os testes.
export function createFixtures(sql: Sql) {
  async function newWallet(currency = 'BRL'): Promise<Wallet> {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await sql(
      'INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, ?)',
      [walletId, playerId, currency, '0.00', 1],
    );
    return { walletId, playerId };
  }

  // Uma transação válida (PENDING); cada teste sobrescreve só o que quer violar.
  function buildRow(wallet: Wallet, overrides: Row = {}): Row {
    return {
      id: crypto.randomUUID(),
      provider_id: 'provider-a',
      external_transaction_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      payload_hash: 'a'.repeat(64),
      wallet_id: wallet.walletId,
      player_id: wallet.playerId,
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      amount: '10.00',
      currency: 'BRL',
      status: 'PENDING',
      correlation_id: crypto.randomUUID(),
      ...overrides,
    };
  }

  async function insertTransaction(
    wallet: Wallet,
    overrides: Row = {},
  ): Promise<string> {
    const row = buildRow(wallet, overrides);
    const columns = Object.keys(row);
    await sql(
      `INSERT INTO wager_transactions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
    return row.id as string;
  }

  // Campos exigidos pelo schema para uma transação PROCESSED.
  const processed = (): Row => ({
    status: 'PROCESSED',
    processed_at: new Date().toISOString(),
    balance_after: '90.00',
  });

  return { newWallet, insertTransaction, processed };
}
