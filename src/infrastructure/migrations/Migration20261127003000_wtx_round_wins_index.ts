import { Migration } from '@mikro-orm/migrations';

export class Migration20261127003000_wtx_round_wins_index extends Migration {
  override name = 'Migration20261127003000_wtx_round_wins_index';

  override up(): void {
    // Índice de consulta, não regra. O REFERENCE_SETTLED (ADR-0005) também procura, sob o lock da
    // wallet, um WIN PROCESSED SEM referência da mesma wallet, provedor e rodada da BET. Sem índice,
    // isso varreria as transações da wallet a cada REFUND/ROLLBACK de BET. Parcial: só os WINs
    // PROCESSED sem referência (os que referenciam usam ix_wtx_reference_transaction).
    this.addSql(`
      CREATE INDEX ix_wtx_round_wins
        ON wager_transactions (wallet_id, provider_id, round_id)
        WHERE kind = 'WIN' AND status = 'PROCESSED' AND reference_transaction_id IS NULL
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX ix_wtx_round_wins');
  }
}
