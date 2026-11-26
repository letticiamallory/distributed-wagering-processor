import type { WagerTransaction } from '../../wager/wager-transaction.js';
import { WagerTransactionStatus } from '../../wager/wager-transaction-status.js';
import { InvalidIntegrationEventError } from '../messaging.errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

// A referência ainda não chegou: o worker tenta de novo em nextAttemptAt.
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !tx.nextAttemptAt ||
      !tx.referenceExternalTransactionId
    ) {
      throw new InvalidIntegrationEventError(
        `Transaction ${tx.id} is not waiting for a reference`,
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempts: tx.attempts,
        nextAttemptAt: tx.nextAttemptAt.toISOString(),
      },
    });
  }
}
