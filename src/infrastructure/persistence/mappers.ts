import type { FailureCode } from '../../domain/errors/failure-code.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { WagerTransactionEntity, WalletEntity } from './entities.js';

// Linha <-> domínio. Dinheiro sai e entra como string decimal (NUMERIC(20,2) já devolve
// duas casas, que é o que o Money exige), nunca como number.
type RowOf<E> = E extends { '~entity'?: infer R } ? NonNullable<R> : never;
type WalletRow = RowOf<typeof WalletEntity>;
type TransactionRow = RowOf<typeof WagerTransactionEntity>;

const money = (amount: string, currency: string): Money =>
  Money.from({ amount, currency });

export function walletToRow(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function transactionToRow(tx: WagerTransaction) {
  const { amount, currency } = tx.money.toJSON();
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount,
    currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfter: tx.balanceAfter?.toJSON().amount ?? null,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt ?? null,
    correlationId: tx.correlationId,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
  };
}

export function transactionFromRow(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    ...(row.referenceExternalTransactionId !== null &&
      row.referenceExternalTransactionId !== undefined && {
        referenceExternalTransactionId: row.referenceExternalTransactionId,
      }),
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    ...(row.referenceTransactionId != null && {
      referenceTransactionId: row.referenceTransactionId,
    }),
    ...(row.failureCode != null && {
      failureCode: row.failureCode as FailureCode,
    }),
    ...(row.processedAt != null && { processedAt: row.processedAt }),
    ...(row.balanceAfter != null && {
      balanceAfter: money(row.balanceAfter, row.currency),
    }),
    attempts: row.attempts,
    ...(row.nextAttemptAt != null && { nextAttemptAt: row.nextAttemptAt }),
  });
}

export function ledgerEntryToRow(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}
