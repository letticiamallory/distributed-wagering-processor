import { DomainError } from '../errors/domain-error.js';

export class InvalidMoneyError extends DomainError {}

export class MoneyOverflowError extends DomainError {
  constructor(maxIntegerDigits: number) {
    super(`Money exceeds ${maxIntegerDigits} integer digits`);
  }
}

export class CurrencyMismatchError extends DomainError {
  // `context` diz de quem é a moeda esperada (por exemplo, a wallet), para o log ser útil.
  constructor(left: string, right: string, context?: string) {
    super(
      `Currency mismatch: ${left} vs ${right}${context ? ` (${context})` : ''}`,
    );
  }
}
