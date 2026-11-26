import type { EntityManager } from '@mikro-orm/postgresql';
import { LedgerRepository } from '../../../application/ports/ledger-repository.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { LedgerEntryEntity } from '../entities.js';
import { ledgerEntryToRow } from '../mappers.js';

// Append-only: só existe INSERT. Não há update nem delete, nem aqui nem no banco (ADR-0004).
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryEntity, ledgerEntryToRow(entry));
  }
}
