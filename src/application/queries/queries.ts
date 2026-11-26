import type { MoneyProps } from '../../domain/money/money.js';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerItemView {
  id: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItemView[];
  // null na última página.
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  // O saldo da wallet quando a transação foi decidida (ausente enquanto pendente).
  balance?: MoneyProps;
  referenceExternalTransactionId?: string;
  attempts: number;
  createdAt: string;
  processedAt?: string;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  // stored - calculated: pode ser NEGATIVA (o ledger tem mais do que o saldo guardado).
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  // Por que não é consistente: balance_mismatch, ledger_gap, negative_balance.
  findings: string[];
}
