import { FailureCode } from '../errors/failure-code.js';
import { LedgerDirection } from '../wallet/ledger-direction.js';
import type { Wallet } from '../wallet/wallet.js';
import { WagerTransactionKind } from './wager-transaction-kind.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';
import type { WagerTransaction } from './wager-transaction.js';

// direction = null: a transação é aplicada (PROCESSED) mas não mexe no saldo
// (LOSS, ou WIN de 0.00). Não gera lançamento no ledger.
export type PolicyDecision =
  | { type: 'apply'; direction: LedgerDirection | null }
  | { type: 'reject'; code: FailureCode }
  | { type: 'waitForReference' };

export interface PolicyInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  // A transação referenciada, se o caso de uso a encontrou.
  reference: WagerTransaction | undefined;
  // A referência já tem uma reversão PROCESSED apontando para ela (ADR-0005).
  alreadyReversed: boolean;
  // A referência é uma BET com um WIN PROCESSED, ainda não revertido, apontando para ela.
  hasSettledWin: boolean;
  // attempts + 1 >= limite de tentativas de resolver a referência.
  attemptsExhausted: boolean;
}

const K = WagerTransactionKind;

// Quais tipos cada operação aceita como referência. LOSS segue o WIN: o enunciado só diz
// que ambos registram o resultado de uma BET.
const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, WagerTransactionKind[]>
> = {
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
  [K.Win]: [K.Bet],
  [K.Loss]: [K.Bet],
};

const reject = (code: FailureCode): PolicyDecision => ({
  type: 'reject',
  code,
});
const WAIT: PolicyDecision = { type: 'waitForReference' };

// Todas as regras de negócio de uma transação, numa função pura (sem banco, sem relógio).
// A ordem importa: a primeira regra violada define o código que o provedor recebe.
export class WagerPolicy {
  static decide(input: PolicyInput): PolicyDecision {
    const { wallet, transaction, reference } = input;

    // 1. Moeda
    if (transaction.money.currency !== wallet.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }
    // 2. Dono da wallet
    if (transaction.playerId !== wallet.playerId) {
      return reject(FailureCode.WalletPlayerMismatch);
    }

    if (!WagerPolicy.pointsToReference(transaction)) {
      return WagerPolicy.balanceDecision(wallet, transaction, undefined);
    }

    // 3. A referência existe?
    if (!reference) {
      return input.attemptsExhausted
        ? reject(FailureCode.ReferenceNotFound)
        : WAIT;
    }
    // 4. Referência de outro player, wallet, moeda ou rodada
    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    // 5. Estado da referência
    // Cada transação respeita o próprio limite: esgotadas as tentativas, não espera mais
    // a referência terminar.
    if (reference.status === WagerTransactionStatus.PendingReference) {
      return input.attemptsExhausted
        ? reject(FailureCode.ReferenceNotProcessed)
        : WAIT;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    // 6. Tipo da referência
    const allowed = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }
    // 7. Valor (só nas reversões: um WIN paga um valor diferente da aposta)
    if (
      transaction.requiresReference() &&
      !transaction.money.equals(reference.money)
    ) {
      return reject(FailureCode.AmountMismatch);
    }
    // 8. Referência já revertida (vale também para WIN e LOSS de uma BET devolvida)
    if (input.alreadyReversed) {
      return reject(FailureCode.ReferenceAlreadyReversed);
    }
    // 8b. BET com prêmio pago: reverter a aposta deixaria o jogador com os dois (ADR-0005)
    if (
      transaction.requiresReference() &&
      reference.kind === K.Bet &&
      input.hasSettledWin
    ) {
      return reject(FailureCode.ReferenceSettled);
    }
    // 9. Saldo
    return WagerPolicy.balanceDecision(wallet, transaction, reference);
  }

  // Exige referência quem é REFUND/ROLLBACK, ou WIN/LOSS que declarou uma.
  private static pointsToReference(transaction: WagerTransaction): boolean {
    if (transaction.requiresReference()) {
      return true;
    }
    const isResult = transaction.kind === K.Win || transaction.kind === K.Loss;
    return isResult && transaction.referenceExternalTransactionId !== undefined;
  }

  private static balanceDecision(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
  ): PolicyDecision {
    if (!transaction.affectsBalance()) {
      return { type: 'apply', direction: null };
    }
    const direction = transaction.ledgerDirectionFor(reference);
    if (
      direction === LedgerDirection.Debit &&
      !wallet.canDebit(transaction.money)
    ) {
      return reject(
        transaction.kind === K.Rollback
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds,
      );
    }
    // O espelho do saldo insuficiente: um crédito que passaria do teto do Money.
    if (
      direction === LedgerDirection.Credit &&
      !wallet.canCredit(transaction.money)
    ) {
      return reject(FailureCode.BalanceLimitExceeded);
    }
    return { type: 'apply', direction };
  }
}
