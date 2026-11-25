import { Migration } from '@mikro-orm/migrations';

export class Migration20261125213119_create_wager_transactions extends Migration {
  override name = 'Migration20261125213119_create_wager_transactions';

  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                UUID PRIMARY KEY,
        provider_id                       TEXT NOT NULL,
        external_transaction_id           TEXT NOT NULL,
        idempotency_key                   TEXT NOT NULL,
        payload_hash                      CHAR(64) NOT NULL,
        wallet_id                         UUID NOT NULL REFERENCES wallets (id),
        player_id                         UUID NOT NULL,
        round_id                          TEXT NOT NULL,
        game_id                           TEXT NOT NULL,
        kind                              TEXT NOT NULL,
        amount                            NUMERIC(20,2) NOT NULL,
        -- Sem FK de moeda para a wallet: rejeições como CURRENCY_MISMATCH precisam
        -- ser gravadas como REJECTED com a moeda que o provedor mandou (ADR-0004).
        currency                          CHAR(3) NOT NULL,
        reference_external_transaction_id TEXT,
        reference_transaction_id          UUID REFERENCES wager_transactions (id),
        status                            TEXT NOT NULL,
        failure_code                      TEXT,
        balance_after                     NUMERIC(20,2), -- saldo observado, usado no replay
        attempts                          INTEGER NOT NULL DEFAULT 0,
        next_attempt_at                   TIMESTAMPTZ,   -- usado por PENDING_REFERENCE
        correlation_id                    TEXT NOT NULL,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at                      TIMESTAMPTZ,
        CONSTRAINT uq_wtx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wtx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wtx_kind
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_wtx_status
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_wtx_amount_non_negative CHECK (amount >= 0),
        -- Só WIN e LOSS podem ter valor 0; o ledger exige amount > 0 (ADR-0004).
        CONSTRAINT ck_wtx_positive_amount CHECK (kind IN ('WIN','LOSS') OR amount > 0),
        CONSTRAINT ck_wtx_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wtx_failure_code
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wtx_processed_at
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wtx_balance_snapshot
          CHECK (status NOT IN ('PROCESSED','REJECTED') OR balance_after IS NOT NULL),
        CONSTRAINT ck_wtx_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )
    `);

    // Cada transação é revertida no máximo uma vez, por qualquer tipo (ADR-0005).
    this.addSql(`
      CREATE UNIQUE INDEX uq_wtx_reversed_once ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
    `);
    this.addSql(`
      CREATE INDEX ix_wtx_pending_due ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    // Roda ANTES de cada UPDATE/DELETE e olha a linha ANTIGA (OLD): CHECK e UNIQUE só
    // enxergam a linha nova, então não conseguiriam saber que o estado antigo era final.
    this.addSql(`
      CREATE FUNCTION forbid_terminal_change() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transaction % cannot be deleted', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER trg_wtx_terminal BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_terminal_change()
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER trg_wtx_terminal ON wager_transactions');
    this.addSql('DROP FUNCTION forbid_terminal_change()');
    this.addSql('DROP INDEX ix_wtx_pending_due');
    this.addSql('DROP INDEX uq_wtx_reversed_once');
    this.addSql('DROP TABLE wager_transactions');
  }
}
