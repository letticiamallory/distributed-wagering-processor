import type { InboxRepository } from './inbox-repository.js';
import type { LedgerRepository } from './ledger-repository.js';
import type { OutboxRepository } from './outbox-repository.js';
import type { WagerTransactionRepository } from './wager-transaction-repository.js';
import type { WalletRepository } from './wallet-repository.js';

// Os repositórios de UMA transação: todos enxergam a mesma conexão e o mesmo COMMIT.
export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

// Uma transação SQL por operação financeira (READ COMMITTED, lock_timeout local).
// Se `work` lançar, tudo é desfeito; se retornar, é confirmado. Erros transitórios do
// banco saem como DependencyUnavailableError, e violações de UNIQUE como DuplicateKeyError.
export abstract class UnitOfWork {
  abstract run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
