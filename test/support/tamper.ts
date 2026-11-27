import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { NOOP_METRICS } from '../../src/application/ports/metrics.port.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { classifyAndCount } from '../../src/infrastructure/persistence/classify-and-count.js';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-inbox.repository.js';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.js';

// Adulterar o banco DE PROPÓSITO, nos testes que precisam de um estado que o schema recusa: uma
// divergência para a reconciliação detectar, um UPDATE de saldo cru para provar o CHECK de saldo
// negativo, um repositório testado sozinho (sem o lançamento que o caso de uso gravaria).
//
// `session_replication_role = replica` desliga os triggers SÓ nesta transação (inclusive o
// trg_wallet_balance_has_ledger, que exige um lançamento para todo saldo); os CHECK, UNIQUE e FK
// continuam valendo. Exige superusuário, que é o usuário do Postgres do compose e do CI.
const REPLICA = 'SET LOCAL session_replication_role = replica';

export type Sql = (
  query: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

// Uma instrução numa transação própria, com os triggers desligados.
export function tamperSql(em: EntityManager): Sql {
  return (query, params = []) =>
    em.fork().transactional(async (tx) => {
      const connection = tx.getConnection();
      const context = tx.getTransactionContext();
      await connection.execute(REPLICA, [], 'run', context);
      return (await connection.execute(query, params, 'all', context)) as Array<
        Record<string, unknown>
      >;
    });
}

// Um UnitOfWork como o de produção (READ COMMITTED, lock_timeout, erros classificados), mas com os
// triggers desligados: para testar um repositório sozinho.
export class UnitOfWorkWithoutTriggers extends UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeoutMs = 5_000,
  ) {
    super();
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          const connection = tx.getConnection();
          const context = tx.getTransactionContext();
          await connection.execute(
            `SET LOCAL lock_timeout = ${this.lockTimeoutMs}`,
            [],
            'run',
            context,
          );
          await connection.execute(REPLICA, [], 'run', context);
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
      throw classifyAndCount(error, NOOP_METRICS);
    }
  }
}
