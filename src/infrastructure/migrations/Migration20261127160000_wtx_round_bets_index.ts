import { Migration } from '@mikro-orm/migrations';

export class Migration20261127160000_wtx_round_bets_index extends Migration {
  override name = 'Migration20261127160000_wtx_round_bets_index';

  override up(): void {
    // Índice de consulta, não regra. Um WIN sem referência procura, sob o lock da wallet, uma BET
    // revertida da mesma rodada (ADR-0005). Parcial: só as BETs PROCESSED.
    this.addSql(`
      CREATE INDEX ix_wtx_round_bets
        ON wager_transactions (wallet_id, provider_id, round_id)
        WHERE kind = 'BET' AND status = 'PROCESSED'
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX ix_wtx_round_bets');
  }
}
