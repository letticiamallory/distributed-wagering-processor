import { Migration } from '@mikro-orm/migrations';

export class Migration20261126111500_wtx_pending_only_on_insert extends Migration {
  override name = 'Migration20261126111500_wtx_pending_only_on_insert';

  override up(): void {
    // PENDING é o estado de uma transação DENTRO da transação SQL do caso de uso: ela é
    // decidida antes de ser gravada, então nenhum código grava PENDING. Se uma linha o tem, é
    // porque nasceu num INSERT (o trigger não roda em INSERT). Daí a regra: nenhum UPDATE pode
    // levar a PENDING, de nenhum estado, nem de PENDING nem de PENDING_REFERENCE (a espera por
    // uma referência é PENDING_REFERENCE -> PENDING_REFERENCE, que continua permitida).
    //
    // A ordem dentro da função importa: o estado FINAL é recusado primeiro, então
    // PROCESSED/REJECTED/FAILED -> PENDING continua dizendo "is terminal".
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_terminal_change() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transaction % cannot be deleted', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot be updated to PENDING (it only exists on INSERT)', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  override down(): void {
    // Volta exatamente à função da migration de criação de wager_transactions.
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_terminal_change() RETURNS trigger AS $$
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
  }
}
