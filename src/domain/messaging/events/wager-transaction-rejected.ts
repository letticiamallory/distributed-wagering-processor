import type { MoneyProps } from '../../money/money.js';
import type { WagerTransaction } from '../../wager/wager-transaction.js';
import { WagerTransactionStatus } from '../../wager/wager-transaction-status.js';
import { InvalidIntegrationEventError } from '../messaging.errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
  balanceAfter: MoneyProps;
}

// Rejeitada por regra de negócio. balanceAfter é o saldo observado (o replay o devolve).
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    if (
      tx.status !== WagerTransactionStatus.Rejected ||
      !tx.failureCode ||
      !tx.balanceAfter
    ) {
      throw new InvalidIntegrationEventError(
        `Transaction ${tx.id} is not REJECTED`,
      );
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        balanceAfter: tx.balanceAfter.toJSON(),
      },
    });
  }
}
