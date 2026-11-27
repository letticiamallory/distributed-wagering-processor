import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  MoneyOverflowError,
} from '../../../src/domain/money/money.errors.js';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction.js';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
} from '../../../src/domain/wallet/wallet.errors.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const opened = new Date('2026-11-25T12:00:00.000Z');
const later = new Date('2026-11-25T12:05:00.000Z');

function openWallet(initialBalance = brl('100.00')) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    at: opened,
  });
}

const move = (money: Money, n = 1) => ({
  money,
  transactionId: `tx-${n}`,
  entryId: `entry-${n}`,
  at: later,
});

// O erro precisa dizer de qual wallet se trata e em que moeda ela opera: é a invariante
// "a moeda da operação é a da wallet" vista pela própria Wallet, não só pelo Money.
function expectWalletCurrencyMismatch(operation: () => unknown) {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CurrencyMismatchError);
  const message = (thrown as Error).message;
  expect(message).toContain('wallet-1');
  expect(message).toContain('operates in BRL');
  expect(message).toContain('USD');
}

describe('Wallet.open', () => {
  test('opens with version 1 and the initial balance, plus the opening CREDIT entry', () => {
    const { wallet, openingEntry } = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(opened);
    expect(wallet.updatedAt).toEqual(opened);

    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.walletId).toBe('wallet-1');
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('a zero initial balance opens at version 1 with no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
      at: opened,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('a positive initial balance needs the opening ids', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('10.00'),
        at: opened,
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  test('refuses a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('1.00').negate(),
        opening: { transactionId: 't', entryId: 'e' },
        at: opened,
      }),
    ).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit and Wallet.credit', () => {
  test('debit lowers the balance, bumps the version and returns the matching entry', () => {
    const { wallet } = openWallet();
    const entry = wallet.debit(move(brl('30.00')));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit raises the balance, bumps the version and returns the matching entry', () => {
    const { wallet } = openWallet();
    const entry = wallet.credit(move(brl('25.50')));

    expect(wallet.balance.toJSON().amount).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.walletVersion).toBe(wallet.version);
  });

  test('versions form a chain: each movement is exactly one more', () => {
    const { wallet } = openWallet();
    const versions = [
      wallet.debit(move(brl('10.00'), 1)).walletVersion,
      wallet.credit(move(brl('5.00'), 2)).walletVersion,
      wallet.debit(move(brl('1.00'), 3)).walletVersion,
    ];
    expect(versions).toEqual([2, 3, 4]);
    expect(wallet.balance.toJSON().amount).toBe('94.00');
  });

  test('debit of exactly the whole balance is allowed and leaves zero', () => {
    const { wallet } = openWallet();
    wallet.debit(move(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('debit beyond the balance throws InsufficientBalanceError and changes nothing', () => {
    const { wallet } = openWallet();
    expect(() => wallet.debit(move(brl('100.01')))).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(opened);
  });

  test('a movement in another currency throws CurrencyMismatchError and changes nothing', () => {
    const { wallet } = openWallet();
    expectWalletCurrencyMismatch(() => wallet.debit(move(usd('1.00'))));
    expectWalletCurrencyMismatch(() => wallet.credit(move(usd('1.00'))));
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('a movement of zero or less is refused (the ledger needs amount > 0)', () => {
    const { wallet } = openWallet();
    for (const money of [brl('0.00'), brl('1.00').negate()]) {
      expect(() => wallet.debit(move(money))).toThrow(
        InvalidWalletOperationError,
      );
      expect(() => wallet.credit(move(money))).toThrow(
        InvalidWalletOperationError,
      );
    }
    expect(wallet.version).toBe(1);
  });

  test('a credit past the Money ceiling throws and changes nothing', () => {
    const { wallet } = openWallet(brl('9999999999999999.99'));
    expect(() => wallet.credit(move(brl('0.01')))).toThrow(MoneyOverflowError);
    expect(wallet.balance.toJSON().amount).toBe('9999999999999999.99');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.canDebit', () => {
  test('is true up to and including the whole balance, false above', () => {
    const { wallet } = openWallet();
    expect(wallet.canDebit(brl('99.99'))).toBe(true);
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
  });

  test('throws on another currency instead of answering "no funds"', () => {
    const { wallet } = openWallet();
    expectWalletCurrencyMismatch(() => wallet.canDebit(usd('1.00')));
  });
});

describe('Wallet.canCredit', () => {
  test('is true up to and including the Money ceiling, false above (instead of throwing)', () => {
    const { wallet } = openWallet(brl('9999999999999998.99'));
    expect(wallet.canCredit(brl('1.00'))).toBe(true);
    expect(wallet.canCredit(brl('1.01'))).toBe(false);
  });

  test('throws on another currency instead of answering "over the limit"', () => {
    const { wallet } = openWallet();
    expectWalletCurrencyMismatch(() => wallet.canCredit(usd('1.00')));
  });
});

describe('Wallet.rehydrate', () => {
  test('rebuilds the persisted state as it is', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: opened,
      updatedAt: later,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.debit(move(brl('2.00'))).walletVersion).toBe(8);
  });
});
