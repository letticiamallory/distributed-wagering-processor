import { DomainError } from '../errors/domain-error.js';
import type { Money } from '../money/money.js';

export class InsufficientBalanceError extends DomainError {
  constructor(balance: Money, requested: Money) {
    super(
      `Insufficient balance: ${balance.toString()} available, ${requested.toString()} requested`,
    );
  }
}

export class InvalidLedgerEntryError extends DomainError {}

// Operação que o chamador não deveria pedir (valor zero, saldo inicial sem os ids...).
export class InvalidWalletOperationError extends DomainError {}
