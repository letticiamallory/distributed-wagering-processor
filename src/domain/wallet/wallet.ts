import {
  CurrencyMismatchError,
  MoneyOverflowError,
} from '../money/money.errors.js';
import { Money } from '../money/money.js';
import { LedgerDirection } from './ledger-direction.js';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
} from './wallet.errors.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  // Ids da transação OPENING e do lançamento de abertura. Só são usados (e obrigatórios)
  // quando o saldo inicial é maior que zero.
  opening?: { transactionId: string; entryId: string };
  at: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

// Aggregate root. Saldo e lançamento nascem juntos: debit e credit devolvem o
// WalletLedgerEntry já com saldo antes, saldo depois e versão, então nunca se desencontram.
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    const { id, playerId, initialBalance, opening, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'A wallet cannot open with a negative balance',
      );
    }
    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      at,
      at,
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!opening) {
      throw new InvalidWalletOperationError(
        'A positive initial balance needs the opening transaction and entry ids',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  // Só reconstrói o que veio da persistência.
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // Existe para a regra de negócio escolher o failureCode certo antes de chamar debit.
  // Em outra moeda lança erro: responder "sem saldo" esconderia o motivo real.
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    return !this._balance.subtract(money).isNegative();
  }

  // O crédito caberia no teto do Money (16 dígitos inteiros)? Responde em vez de lançar: a política
  // transforma o "não" em BALANCE_LIMIT_EXCEEDED, uma rejeição auditável (e não um 500).
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    try {
      this._balance.add(money);
      return true;
    } catch (error) {
      if (error instanceof MoneyOverflowError) {
        return false;
      }
      throw error;
    }
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);
    const balanceAfter = this._balance.subtract(props.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError(this._balance, props.money);
    }
    return this.apply(LedgerDirection.Debit, balanceAfter, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);
    return this.apply(
      LedgerDirection.Credit,
      this._balance.add(props.money),
      props,
    );
  }

  // Monta o lançamento ANTES de mudar o estado: se algo falhar, a wallet fica intacta.
  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const version = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: version,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version = version;
    this._updatedAt = props.at;
    return entry;
  }

  // Invariante: a moeda da operação é a da wallet. O Money também recusaria a conta, mas
  // aqui o erro diz de qual wallet se trata e a regra fica visível na classe.
  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        this.currency,
        money.currency,
        `wallet ${this.id} operates in ${this.currency}`,
      );
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(
        'A wallet movement needs an amount greater than zero',
      );
    }
  }
}
