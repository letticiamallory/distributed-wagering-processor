import type { MoneyProps } from '../../money/money.js';
import type { WagerTransaction } from '../../wager/wager-transaction.js';
import { WagerTransactionStatus } from '../../wager/wager-transaction-status.js';
import { InvalidIntegrationEventError } from '../messaging.errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  processedAt: string;
}

// Qualquer transação aplicada, inclusive LOSS (que não mexe no saldo).
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    if (
      tx.status !== WagerTransactionStatus.Processed ||
      !tx.balanceAfter ||
      !tx.processedAt
    ) {
      throw new InvalidIntegrationEventError(
        `Transaction ${tx.id} is not PROCESSED`,
      );
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balanceAfter: tx.balanceAfter.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
