type Sql = (
  query: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

// O banco de teste PERSISTE entre execuções e os outros testes deixam eventos não publicados e
// pendentes vencendo na tabela. Um publisher (ou um worker) enxerga a tabela INTEIRA, então os
// testes que os ligam começam "quietos": o que sobrou dos outros é dado como publicado, e as
// pendentes alheias são empurradas para o futuro. Os eventos do próprio teste nascem depois.
export async function quiesceOutbox(sql: Sql): Promise<void> {
  await sql(
    'UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL',
  );
}

export async function parkForeignPendings(sql: Sql): Promise<void> {
  await sql(
    `UPDATE wager_transactions SET next_attempt_at = '9999-01-01'
      WHERE status = 'PENDING_REFERENCE'`,
  );
}

// Criar uma wallet já grava o evento de abertura (WalletBalanceChanged). Os testes que contam
// eventos por aposta o removem da outbox (a tabela não é append-only), para contar só o que a
// aposta gerou.
export async function dropWalletEvents(
  sql: Sql,
  walletId: string,
): Promise<void> {
  await sql('DELETE FROM outbox_messages WHERE aggregate_id = ?', [walletId]);
}

export const outboxRowsOf = (sql: Sql, walletIds: string[]) =>
  sql(
    `SELECT id, event_type, attempts, next_attempt_at, published_at, last_error, aggregate_id
       FROM outbox_messages WHERE aggregate_id::text = ANY(string_to_array(?, ',')) ORDER BY occurred_at, id`,
    [walletIds.join(',')],
  );
