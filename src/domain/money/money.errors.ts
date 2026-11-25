import { DomainError } from '../errors/domain-error.js';

export class InvalidMoneyError extends DomainError {}

export class MoneyOverflowError extends DomainError {
  constructor(maxIntegerDigits: number) {
    super(`Money exceeds ${maxIntegerDigits} integer digits`);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} vs ${right}`);
  }
}
