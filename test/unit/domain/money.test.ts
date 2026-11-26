import { describe, expect, test } from 'bun:test';
import { Decimal } from 'decimal.js';
import { DomainError } from '../../../src/domain/errors/domain-error.js';
import { Money } from '../../../src/domain/money/money.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../../../src/domain/money/money.errors.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from: cuidado 1, validar antes de criar o Decimal', () => {
  test.each(['0.00', '25.00', '999999999.99', '9999999999999999.99', '0.05'])(
    'accepts %p',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  test.each([
    '',
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e5',
    '1.00e2',
    '-1.00',
    '+1.00',
    '10',
    '10.',
    '.50',
    '10.5',
    '10.005',
    ' 10.00',
    '10.00 ',
    '01.00',
    '1,00',
    '10000000000000000.00', // 17 dígitos inteiros
  ])('rejects %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects an amount that is not a string (for example a JSON number)', () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  test.each(['', 'br', 'brl', 'BRLL', 'B1L', 'R$'])(
    'rejects the currency %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );
});

describe('Money: cuidado 2, nada arredonda', () => {
  test('"10.005" is rejected and never becomes "10.01"', () => {
    expect(() => brl('10.005')).toThrow(InvalidMoneyError);
    expect(() => brl('10.01')).not.toThrow();
    expect(brl('10.01').equals(brl('10.00'))).toBe(false);
  });

  test('the private constructor refuses a Decimal with more than 2 places', () => {
    const construct = Money as unknown as new (
      value: Decimal,
      currency: string,
    ) => Money;
    expect(() => new construct(new Decimal('10.005'), 'BRL')).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('Money: aritmética exata (cuidado 3, Decimal isolado)', () => {
  test('0.10 + 0.20 = 0.30, the classic that breaks with float', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('stays exact beyond the 15 digits a double can hold', () => {
    const sum = brl('1234567890123.45').add(brl('0.55'));
    expect(sum.toJSON().amount).toBe('1234567890124.00');
    expect(
      brl('9999999999999999.99').subtract(brl('0.01')).toJSON().amount,
    ).toBe('9999999999999999.98');
  });

  test('always serializes with 2 places', () => {
    expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
    expect(brl('0.05').toJSON().amount).toBe('0.05');
    expect(brl('7.10').add(brl('0.90')).toJSON().amount).toBe('8.00');
  });

  test('subtract can go negative inside the domain', () => {
    const result = brl('3.00').subtract(brl('8.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
    expect(result.toJSON().amount).toBe('-5.00');
  });

  test('negate flips the sign, and zero never becomes "-0.00"', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('0.00').negate().toJSON().amount).toBe('0.00');
    expect(brl('0.00').negate().isZero()).toBe(true);
    expect(brl('0.00').negate().isNegative()).toBe(false); // o Decimal diria true
    expect(brl('2.50').subtract(brl('2.50')).toJSON().amount).toBe('0.00');
  });

  test('add, subtract and negate return new instances and leave the original alone', () => {
    const original = brl('10.00');
    const sum = original.add(brl('1.00'));
    expect(sum).not.toBe(original);
    expect(original.toJSON().amount).toBe('10.00');
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe('Money: teto de 16 dígitos inteiros', () => {
  test('add past the ceiling throws MoneyOverflowError', () => {
    expect(() => brl('9999999999999999.99').add(brl('0.01'))).toThrow(
      MoneyOverflowError,
    );
    expect(() =>
      brl('9999999999999999.99').add(brl('9999999999999999.99')),
    ).toThrow(MoneyOverflowError);
  });

  test('the ceiling itself is allowed', () => {
    expect(brl('9999999999999998.99').add(brl('1.00')).toJSON().amount).toBe(
      '9999999999999999.99',
    );
  });

  test('negative results are also bounded', () => {
    expect(() =>
      brl('0.00').subtract(brl('9999999999999999.99')).subtract(brl('0.01')),
    ).toThrow(MoneyOverflowError);
  });
});

describe('Money: moedas diferentes', () => {
  test('add and subtract throw CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
  });

  test('isLessThan throws, equals is simply false', () => {
    expect(() => brl('1.00').isLessThan(usd('2.00'))).toThrow(
      CurrencyMismatchError,
    );
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  test('errors are domain errors with a readable name', () => {
    const error = new CurrencyMismatchError('BRL', 'USD');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('CurrencyMismatchError');
  });
});

describe('Money: consultas', () => {
  test('zero, isZero, isPositive and isLessThan', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.99').isLessThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  test('Money.zero validates the currency', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });

  test('toString and JSON.stringify use the exact string', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(JSON.stringify({ stake: brl('25.00') })).toBe(
      '{"stake":{"amount":"25.00","currency":"BRL"}}',
    );
  });
});
