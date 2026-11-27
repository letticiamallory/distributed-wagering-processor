import { Migration } from '@mikro-orm/migrations';

export class Migration20261127130000_wallet_balance_has_ledger extends Migration {
  override name = 'Migration20261127130000_wallet_balance_has_ledger';

  override up(): void {
    // "Toda alteração de saldo tem um lançamento no ledger" (enunciado 6.2), no schema. Um CHECK não
    // enxerga outra tabela, e na operação o UPDATE da wallet vem ANTES do INSERT do lançamento (os
    // dois na mesma transação). Por isso é uma constraint trigger DIFERIDA: roda no COMMIT e olha o
    // estado FINAL da wallet. Regra: existe o lançamento da versão atual e o balance_after dele é o
    // saldo. A única wallet sem lançamento é a que nasceu zerada e nunca mudou (versão 1, saldo 0).
    // Assim um UPDATE do saldo sozinho, uma versão pulada, ou uma wallet que nasce com saldo sem a
    // OPENING são recusados no COMMIT (23514), e nada da transação fica.
    this.addSql(`
      CREATE FUNCTION check_wallet_balance_has_ledger() RETURNS trigger AS $$
      DECLARE
        current_balance NUMERIC(20,2);
        current_version INTEGER;
        entry_after     NUMERIC(20,2);
      BEGIN
        SELECT balance, version INTO current_balance, current_version
          FROM wallets WHERE id = NEW.id;
        IF NOT FOUND THEN
          RETURN NULL;
        END IF;
        SELECT balance_after INTO entry_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id AND wallet_version = current_version;
        IF FOUND THEN
          IF entry_after <> current_balance THEN
            RAISE EXCEPTION 'wallet % has balance % but its ledger entry of version % says %',
              NEW.id, current_balance, current_version, entry_after
              USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_wallet_balance_has_ledger';
          END IF;
        ELSIF NOT (current_version = 1 AND current_balance = 0) THEN
          RAISE EXCEPTION 'wallet % is at version % with balance % and no ledger entry for it',
            NEW.id, current_version, current_balance
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_wallet_balance_has_ledger';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_balance_has_ledger
        AFTER INSERT OR UPDATE OF balance, version ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_balance_has_ledger()
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER trg_wallet_balance_has_ledger ON wallets');
    this.addSql('DROP FUNCTION check_wallet_balance_has_ledger()');
  }
}
