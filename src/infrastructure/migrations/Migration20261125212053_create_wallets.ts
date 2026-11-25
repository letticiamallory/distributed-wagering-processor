import { Migration } from '@mikro-orm/migrations';

export class Migration20261125212053_create_wallets extends Migration {
  override name = 'Migration20261125212053_create_wallets';

  override up(): void {
    // As constraints têm nome para o erro do Postgres dizer qual regra foi violada.
    this.addSql(`
      CREATE TABLE wallets (
        id          UUID PRIMARY KEY,
        player_id   UUID NOT NULL,
        currency    CHAR(3) NOT NULL,
        balance     NUMERIC(20,2) NOT NULL,
        version     INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- Redundante com a PK; existe só como alvo da FK composta do ledger.
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      )
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallets');
  }
}
