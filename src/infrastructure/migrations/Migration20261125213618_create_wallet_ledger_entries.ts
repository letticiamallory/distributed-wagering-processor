import { Migration } from '@mikro-orm/migrations';

export class Migration20261125213618_create_wallet_ledger_entries extends Migration {
  override name = 'Migration20261125213618_create_wallet_ledger_entries';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              UUID PRIMARY KEY,
        wallet_id       UUID NOT NULL,
        transaction_id  UUID NOT NULL REFERENCES wager_transactions (id),
        direction       TEXT NOT NULL,
        amount          NUMERIC(20,2) NOT NULL,
        currency        CHAR(3) NOT NULL,
        balance_before  NUMERIC(20,2) NOT NULL,
        balance_after   NUMERIC(20,2) NOT NULL,
        wallet_version  INTEGER NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- A moeda do lançamento tem que ser a da wallet (alvo: uq_wallets_id_currency).
        CONSTRAINT fk_ledger_wallet_currency
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT uq_ledger_tx_wallet UNIQUE (transaction_id, wallet_id),
        -- Cada versão da wallet tem exatamente um lançamento: o ledger vira uma corrente.
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        -- Valor zero não gera lançamento; o sinal vem de "direction" (ADR-0004).
        CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT ck_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ck_ledger_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      )
    `);

    // TG_OP entra na mensagem para o erro dizer qual operação foi barrada.
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (%)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);
    // TRUNCATE apaga a tabela inteira sem passar por linhas: um trigger FOR EACH ROW
    // nunca dispara nele, então precisa de um trigger próprio, por comando.
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER trg_ledger_no_truncate ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER trg_ledger_append_only ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION forbid_ledger_mutation()');
    this.addSql('DROP TABLE wallet_ledger_entries');
  }
}
