import type { MoneyProps } from '../../money/money.js';
import type { LedgerDirection } from '../../wallet/ledger-direction.js';
import type { Wallet } from '../../wallet/wallet.js';
import type { WalletLedgerEntry } from '../../wallet/wallet-ledger-entry.js';
import { InvalidIntegrationEventError } from '../messaging.errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  // Quem consome ordena por aqui: com a fila reentregando, a versão maior vence.
  walletVersion: number;
}

// Só quando o saldo muda (há um lançamento no ledger).
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        `Ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not ${wallet.id}`,
      );
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
