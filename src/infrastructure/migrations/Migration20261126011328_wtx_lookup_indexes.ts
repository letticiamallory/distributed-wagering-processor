import { Migration } from '@mikro-orm/migrations';

export class Migration20261126011328_wtx_lookup_indexes extends Migration {
  override name = 'Migration20261126011328_wtx_lookup_indexes';

  override up(): void {
    // Índices de consulta, não regras. Sem eles o caso de uso varreria a tabela inteira
    // enquanto segura o lock da wallet.

    // "Quem aponta para esta transação?": alreadyReversed (reversão PROCESSED de uma
    // referência) e hasSettledWin (WIN PROCESSED que aponta para uma BET). O índice único
    // uq_wtx_reversed_once só cobre REFUND e ROLLBACK, então o WIN não passa por ele.
    this.addSql(`
      CREATE INDEX ix_wtx_reference_transaction ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL
    `);

    // "Acordar" as PENDING_REFERENCE que esperam por uma referência que acabou de chegar.
    // A busca é pelo id EXTERNO da referência: uma PENDING_REFERENCE ainda não tem
    // reference_transaction_id (ele só é preenchido quando a referência é resolvida).
    this.addSql(`
      CREATE INDEX ix_wtx_pending_by_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX ix_wtx_pending_by_reference');
    this.addSql('DROP INDEX ix_wtx_reference_transaction');
  }
}
