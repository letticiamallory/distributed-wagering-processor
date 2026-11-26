import { CurrencyMismatchError } from '../money/money.errors.js';
import type { Money } from '../money/money.js';
import { LedgerDirection } from './ledger-direction.js';
import { InvalidLedgerEntryError } from './wallet.errors.js';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

// Lançamento do extrato. Imutável de forma estrutural: todos os campos são readonly, a
// instância é congelada e não existe nenhum método que mude estado.
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  // Valida tudo: é usado quando o lançamento nasce no sistema.
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { direction, money, balanceBefore, balanceAfter, walletVersion } =
      props;

    if (
      direction !== LedgerDirection.Debit &&
      direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError(
        `Unknown ledger direction: ${String(direction)}`,
      );
    }
    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        `walletVersion must be an integer >= 1: ${String(walletVersion)}`,
      );
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'A ledger entry needs an amount greater than zero',
      );
    }
    for (const balance of [balanceBefore, balanceAfter]) {
      if (balance.currency !== money.currency) {
        throw new CurrencyMismatchError(money.currency, balance.currency);
      }
      if (balance.isNegative()) {
        throw new InvalidLedgerEntryError(
          'A ledger balance cannot be negative',
        );
      }
    }
    if (!WalletLedgerEntry.isArithmeticCorrect(props)) {
      const sign = direction === LedgerDirection.Credit ? '+' : '-';
      throw new InvalidLedgerEntryError(
        `balanceBefore ${sign} amount does not equal balanceAfter`,
      );
    }
    return new WalletLedgerEntry(props);
  }

  // Só reconstrói o que já está no banco: não revalida regra (quem barra é o schema).
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  // balanceBefore ± amount === balanceAfter.
  isBalanced(): boolean {
    return WalletLedgerEntry.isArithmeticCorrect(this);
  }

  private static isArithmeticCorrect(
    entry: Pick<
      LedgerEntryState,
      'direction' | 'money' | 'balanceBefore' | 'balanceAfter'
    >,
  ): boolean {
    const expected =
      entry.direction === LedgerDirection.Credit
        ? entry.balanceBefore.add(entry.money)
        : entry.balanceBefore.subtract(entry.money);
    return expected.equals(entry.balanceAfter);
  }
}
