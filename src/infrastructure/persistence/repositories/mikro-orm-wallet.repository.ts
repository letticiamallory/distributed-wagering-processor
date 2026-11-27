import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrentWalletUpdateError,
  DuplicateKeyError,
  WalletAlreadyExistsError,
} from '../../../application/errors/application-errors.js';
import {
  NOOP_METRICS,
  type MetricsPort,
} from '../../../application/ports/metrics.port.js';
import { WalletRepository } from '../../../application/ports/wallet-repository.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletEntity } from '../entities.js';
import { walletFromRow, walletToRow } from '../mappers.js';
import { classifyPersistenceError } from '../postgres-error-classifier.js';

const PLAYER_CURRENCY_CONSTRAINT = 'uq_wallets_player_currency';

// 55P03 = lock_not_available: o lock_timeout estourou. Procura também na cadeia de causas (o
// MikroORM embrulha o erro do driver).
function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === 'object' && current !== null;
    depth++
  ) {
    if ((current as { code?: unknown }).code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class MikroOrmWalletRepository extends WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  // SELECT ... FOR UPDATE. O MikroORM exige uma transação aberta para o lock pessimista:
  // só funciona dentro do UnitOfWork, que é o que queremos. O tempo até o lock vir (ou o
  // lock_timeout estourar) vai para wallet_lock_wait_seconds: a disputa por uma wallet quente
  // aparece ali antes de virar 503 (ADR-0014).
  async lockById(id: string): Promise<Wallet | undefined> {
    const started = performance.now();
    const waited = () => (performance.now() - started) / 1_000;
    try {
      const row = await this.em.findOne(
        WalletEntity,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      this.metrics.observe(
        'wallet_lock_wait_seconds',
        { outcome: 'acquired' },
        waited(),
      );
      return row ? walletFromRow(row) : undefined;
    } catch (error) {
      if (isLockTimeout(error)) {
        this.metrics.observe(
          'wallet_lock_wait_seconds',
          { outcome: 'timeout' },
          waited(),
        );
      }
      throw error;
    }
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
