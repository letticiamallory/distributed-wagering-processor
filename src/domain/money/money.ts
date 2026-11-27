import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
} from './money.errors.js';
import { isIso4217Currency } from './iso-4217.js';

// Cuidado 3: um Decimal só nosso, com precisão própria. Não mexemos na configuração
// global da biblioteca e não dependemos da precisão padrão (20 dígitos).
const Dec = Decimal.clone({ precision: 40 });

// Cuidado 1: a string é validada ANTES de virar Decimal, porque o decimal.js aceitaria
// "1e5", "NaN" e "Infinity". Até 16 dígitos inteiros e exatamente 2 casas.
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_INTEGER_DIGITS = 16;

export interface MoneyProps {
  amount: string; // string decimal, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

export class Money {
  private readonly value: Decimal;
  readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    // Cuidado 2: a biblioteca nunca arredonda por nós. Se sobrar mais de 2 casas, é erro.
    if (value.decimalPlaces() > 2) {
      throw new InvalidMoneyError(
        `Money has more than 2 decimal places: ${value.toString()}`,
      );
    }
    // O banco guarda NUMERIC(20,2), mas só aceitamos 16 dígitos inteiros: assim todo
    // valor que existe no banco volta a ser lido pela mesma regra de entrada.
    if (value.abs().trunc().toFixed(0).length > MAX_INTEGER_DIGITS) {
      throw new MoneyOverflowError(MAX_INTEGER_DIGITS);
    }
    this.value = value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount, expected a string like "25.00": ${String(amount).slice(0, 40)}`,
      );
    }
    Money.assertCurrency(currency);
    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Dec(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  // Pode dar negativo dentro do domínio (veja isNegative); a entrada é que não aceita.
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  // Moedas diferentes não são iguais; aqui não faz sentido lançar erro.
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    // toFixed (e não toString, que pode sair em notação científica): sempre 2 casas.
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency, expected 3 uppercase letters: ${String(currency).slice(0, 10)}`,
      );
    }
    if (!isIso4217Currency(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency, not an ISO-4217 code: ${currency}`,
      );
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
