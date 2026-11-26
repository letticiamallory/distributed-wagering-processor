import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrentWalletUpdateError,
  DuplicateKeyError,
  WalletAlreadyExistsError,
} from '../../../application/errors/application-errors.js';
import { WalletRepository } from '../../../application/ports/wallet-repository.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletEntity } from '../entities.js';
import { walletFromRow, walletToRow } from '../mappers.js';
import { classifyPersistenceError } from '../postgres-error-classifier.js';

const PLAYER_CURRENCY_CONSTRAINT = 'uq_wallets_player_currency';

export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  // SELECT ... FOR UPDATE. O MikroORM exige uma transação aberta para o lock pessimista:
  // só funciona dentro do UnitOfWork, que é o que queremos.
  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? walletFromRow(row) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletEntity, walletToRow(wallet));
    } catch (error) {
      const classified = classifyPersistenceError(error);
      if (
        classified instanceof DuplicateKeyError &&
        classified.constraint === PLAYER_CURRENCY_CONSTRAINT
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  // UPDATE ... WHERE id = $1 AND version = $expectedVersion: o `version` é a segunda
  // barreira atrás do lock (ADR-0007). Se não afetar exatamente 1 linha, é bug.
  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const row = walletToRow(wallet);
    const affected = await this.em.nativeUpdate(
      WalletEntity,
      { id: wallet.id, version: expectedVersion },
      { balance: row.balance, version: row.version, updatedAt: row.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrentWalletUpdateError(wallet.id, expectedVersion);
    }
  }
}
