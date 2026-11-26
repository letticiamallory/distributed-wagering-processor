import type { FailureCode } from '../errors/failure-code.js';
import { PAYLOAD_HASH_PATTERN } from '../messaging/payload-hash.js';
import type { Money } from '../money/money.js';
import { LedgerDirection } from '../wallet/ledger-direction.js';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from './wager-transaction.errors.js';
import { WagerTransactionKind } from './wager-transaction-kind.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string; // SHA-256 em hexadecimal minúsculo (64 caracteres)
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  // id da transação referenciada NO PROVEDOR (não o id interno)
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string; // id interno, preenchido quando a referência é resolvida
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money; // saldo observado, devolvido no replay
  attempts: number;
  nextAttemptAt?: Date; // só faz sentido em PENDING_REFERENCE
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  createdAt: Date;
}

const ALL_KINDS = Object.values(WagerTransactionKind);

// Máquina de estados:
//   (nasce) PENDING
//   PENDING             -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
//   PENDING_REFERENCE   -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (attempts + 1)
//   PROCESSED, REJECTED, FAILED são finais: qualquer transição lança InvalidTransactionStateError.
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _balanceAfter: Money | undefined;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._balanceAfter = state.balanceAfter;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  // Nasce em PENDING. OPENING não entra por aqui: só createOpening() o cria.
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING is internal and cannot be submitted',
      );
    }
    if (!ALL_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(
        `Unknown transaction kind: ${String(props.kind)}`,
      );
    }
    WagerTransaction.assertCommon(props);
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('The amount cannot be negative');
    }
    // Espelha ck_wtx_positive_amount: só WIN e LOSS podem valer zero.
    const mayBeZero =
      props.kind === WagerTransactionKind.Win ||
      props.kind === WagerTransactionKind.Loss;
    if (props.money.isZero() && !mayBeZero) {
      throw new InvalidWagerTransactionError(
        `A ${props.kind} needs an amount greater than zero`,
      );
    }
    // Espelha ck_wtx_reference_required.
    const needsReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (
      needsReference &&
      (props.referenceExternalTransactionId ?? '').trim() === ''
    ) {
      throw new InvalidWagerTransactionError(
        `A ${props.kind} needs referenceExternalTransactionId`,
      );
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      attempts: 0,
    });
  }

  // Crédito de abertura da wallet: interno e já aplicado (nasce PROCESSED), porque o
  // saldo inicial entra junto com a criação da wallet, na mesma transação SQL.
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'An opening needs an amount greater than zero',
      );
    }
    const state: WagerTransactionState = {
      id: props.id,
      providerId: 'internal',
      externalTransactionId: props.walletId,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Processed,
      processedAt: props.createdAt,
      balanceAfter: props.money,
      attempts: 0,
    };
    WagerTransaction.assertCommon(state);
    return new WagerTransaction(state);
  }

  // Só reconstrói o que veio do banco: não revalida regras de transição.
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError a partir de um estado final)

  markProcessed(input: {
    referenceTransactionId?: string;
    balanceAfter: Money;
    at: Date;
  }): void {
    this.assertOpen(WagerTransactionStatus.Processed);
    this.assertObservedBalance(input.balanceAfter);
    // O índice uq_wtx_reversed_once depende de reference_transaction_id: uma reversão
    // PROCESSED precisa saber exatamente o que reverteu.
    if (this.requiresReference() && !input.referenceTransactionId) {
      throw new InvalidWagerTransactionError(
        `A ${this.kind} cannot be PROCESSED without the resolved referenceTransactionId`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = input.referenceTransactionId;
    this._balanceAfter = input.balanceAfter;
    this._processedAt = input.at;
    this._nextAttemptAt = undefined;
  }

  // REJECTED guarda o saldo observado (o replay o devolve) e não tem processedAt.
  reject(code: FailureCode, balanceAfter: Money): void {
    this.assertOpen(WagerTransactionStatus.Rejected);
    this.assertObservedBalance(balanceAfter);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertOpen(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  // attempts conta as vezes em que tentamos resolver a referência e ela não estava lá.
  markPendingReference(nextAttemptAt: Date): void {
    this.assertOpen(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  // LOSS não mexe no saldo, e um WIN de 0.00 também não.
  affectsBalance(): boolean {
    if (this.kind === WagerTransactionKind.Loss) {
      return false;
    }
    return !this.money.isZero();
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  // BET debita; WIN, REFUND e OPENING creditam; ROLLBACK é o contrário da referência.
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) {
      throw new InvalidWagerTransactionError(
        `A ${this.kind} of ${this.money.toString()} does not move the balance`,
      );
    }
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference?.affectsBalance()) {
          throw new InvalidWagerTransactionError(
            'A ROLLBACK needs a reference that moved the balance',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        throw new InvalidWagerTransactionError(
          `A ${this.kind} has no ledger direction`,
        );
    }
  }

  // ---- internos

  private assertOpen(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }

  private assertObservedBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError(
        `The observed balance is in ${balance.currency}, the transaction in ${this.money.currency}`,
      );
    }
    if (balance.isNegative()) {
      throw new InvalidWagerTransactionError(
        'The observed balance cannot be negative',
      );
    }
  }

  private static assertCommon(props: CreateWagerTransactionProps): void {
    const texts = {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      correlationId: props.correlationId,
    };
    for (const [field, value] of Object.entries(texts)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(`${field} cannot be empty`);
      }
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError(
        'payloadHash must be 64 lowercase hex characters (SHA-256)',
      );
    }
  }
}
