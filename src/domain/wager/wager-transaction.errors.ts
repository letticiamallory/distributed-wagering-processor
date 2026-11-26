import { DomainError } from '../errors/domain-error.js';
import type { WagerTransactionStatus } from './wager-transaction-status.js';

// A transação não pode ser criada ou operada assim (dado inválido ou chamada indevida).
export class InvalidWagerTransactionError extends DomainError {}

// Tentativa de mudar o estado a partir de um estado final. É erro de programação, não
// caminho de negócio: o trigger do banco também recusa.
export class InvalidTransactionStateError extends DomainError {
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Invalid wager transaction transition: ${from} -> ${to}`);
  }
}
