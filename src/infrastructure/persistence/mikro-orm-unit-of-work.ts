import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  UnitOfWork,
  type Repositories,
} from '../../application/ports/unit-of-work.js';
import { classifyPersistenceError } from './postgres-error-classifier.js';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository.js';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';

export interface UnitOfWorkOptions {
  // Quanto esperar por um lock antes de desistir com 55P03 (ADR-0007: 5s).
  lockTimeoutMs: number;
}

// Uma transação SQL por operação financeira (ADR-0007): READ COMMITTED, com lock_timeout
// só para esta transação (SET LOCAL morre no COMMIT ou no ROLLBACK e não vaza para a
// conexão do pool). Cada chamada a run() usa um EntityManager novo (fork): nada fica
// guardado entre operações, então não existe cache velho de wallet.
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly options: UnitOfWorkOptions,
  ) {
    super();
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 0) {
      throw new Error('lockTimeoutMs must be a non-negative integer');
    }
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          // Inteiro já validado no construtor: pode ir no texto (SET não aceita parâmetro).
          await tx
            .getConnection()
            .execute(
              `SET LOCAL lock_timeout = ${this.options.lockTimeoutMs}`,
              [],
              'run',
              tx.getTransactionContext(),
            );
          return work({
            wallets: new MikroOrmWalletRepository(tx),
            transactions: new MikroOrmWagerTransactionRepository(tx),
            ledger: new MikroOrmLedgerRepository(tx),
            inbox: new MikroOrmInboxRepository(tx),
            outbox: new MikroOrmOutboxRepository(tx),
          });
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      // Erros do caso de uso (domínio e aplicação) passam intactos; erros do driver viram
      // DuplicateKeyError ou DependencyUnavailableError, e o resto continua sendo bug.
      throw classifyPersistenceError(error);
    }
  }
}
