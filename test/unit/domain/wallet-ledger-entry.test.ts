import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction.js';
import { InvalidLedgerEntryError } from '../../../src/domain/wallet/wallet.errors.js';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry.js';
import { CurrencyMismatchError } from '../../../src/domain/money/money.errors.js';
import { Money } from '../../../src/domain/money/money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-11-25T12:00:00.000Z');

// Um DEBIT válido: 100,00 - 30,00 = 70,00, versão 1. Cada teste sobrescreve o que quer violar.
const props = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
  walletVersion: 1,
  createdAt: at,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('accepts a valid DEBIT', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(entry.walletVersion).toBe(1);
    expect(entry.isBalanced()).toBe(true);
  });

  test('accepts a valid CREDIT', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('130.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects a DEBIT with wrong arithmetic (100 - 30 = 80)', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: brl('80.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a CREDIT with wrong arithmetic (100 + 30 = 120)', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceAfter: brl('120.00'),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a DEBIT with the arithmetic of a CREDIT (direction matters)', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: brl('130.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects an amount of zero or less', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('30.00').negate(), balanceAfter: brl('130.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a balance that would be negative', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          balanceBefore: brl('10.00'),
          balanceAfter: brl('20.00').negate(),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects money and balances in different currencies', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: usd('30.00') })),
    ).toThrow(CurrencyMismatchError);
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: usd('70.00') })),
    ).toThrow(CurrencyMismatchError);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    'rejects walletVersion %p',
    (walletVersion) => {
      expect(() => WalletLedgerEntry.create(props({ walletVersion }))).toThrow(
        InvalidLedgerEntryError,
      );
    },
  );

  test('rejects an unknown direction', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ direction: 'SIDEWAYS' as LedgerDirection }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry is immutable and rehydrates without judging', () => {
  test('the instance is frozen and has no mutators', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);
    expect(
      methods.filter((name) => /^(set|update|delete|mark|change)/.test(name)),
    ).toEqual([]);
  });

  test('rehydrate only rebuilds: it does not validate rules, isBalanced tells', () => {
    const corrupted = WalletLedgerEntry.rehydrate(
      props({ balanceAfter: brl('80.00') }),
    );
    expect(corrupted.isBalanced()).toBe(false);
    expect(Object.isFrozen(corrupted)).toBe(true);
  });
});
