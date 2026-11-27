import { describe, expect, test } from 'bun:test';
import {
  ApiOnlyErrorCode,
  type ApiErrorCode,
} from '../../../src/application/errors/api-error-code.js';
import type { ProcessWagerResult } from '../../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus as S } from '../../../src/domain/wager/wager-transaction-status.js';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  statusOfError,
  statusOfResult,
} from '../../../src/interfaces/http/http-status.js';

const result = (status: S, idempotentReplay: boolean): ProcessWagerResult => ({
  transactionId: 'tx-1',
  status,
  idempotentReplay,
});

// O resultado de uma transação que EXISTE (foi gravada): o status diz o que aconteceu com ela.
describe('statusOfResult: the HTTP status of a transaction that was stored', () => {
  test.each([
    [S.Processed, false, 201],
    [S.Processed, true, 200],
    [S.PendingReference, false, 202],
    [S.PendingReference, true, 202],
    [S.Rejected, false, 422],
    [S.Rejected, true, 422], // o replay devolve a mesma resposta da primeira vez
    [S.Failed, false, 500],
    [S.Failed, true, 500],
    [S.Pending, false, 500], // PENDING nunca é gravado: se aparecer é bug
  ])('%s with idempotentReplay=%p is %i', (status, replay, expected) => {
    expect(statusOfResult(result(status, replay))).toBe(expected);
  });
});

// Um erro (nada foi gravado) vira o status pelo `code`. O mapa é TOTAL: todo código da API tem
// um status, e o mesmo código tem o mesmo status em qualquer rota.
describe('statusOfError: the HTTP status of an error code', () => {
  const expected: Record<ApiErrorCode, number> = {
    // 400: o provedor precisa corrigir o que mandou
    [FailureCode.InvalidPayload]: 400,
    [FailureCode.InvalidAmount]: 400,
    [FailureCode.UnsupportedKind]: 400,
    // 404
    [FailureCode.WalletNotFound]: 404,
    [ApiOnlyErrorCode.TransactionNotFound]: 404,
    // 409: conflito de idempotência ou de unicidade
    [FailureCode.IdempotencyKeyReused]: 409,
    [FailureCode.ExternalIdConflict]: 409,
    [ApiOnlyErrorCode.WalletAlreadyExists]: 409,
    // 422: regras de negócio (hoje só saem como REJECTED, mas o código tem um status só)
    [FailureCode.WalletPlayerMismatch]: 422,
    [FailureCode.CurrencyMismatch]: 422,
    [FailureCode.InsufficientFunds]: 422,
    [FailureCode.ReversalInsufficientFunds]: 422,
    [FailureCode.ReferenceNotFound]: 422,
    [FailureCode.ReferenceMismatch]: 422,
    [FailureCode.ReferenceNotProcessed]: 422,
    [FailureCode.ReferenceKindNotAllowed]: 422,
    [FailureCode.AmountMismatch]: 422,
    [FailureCode.ReferenceAlreadyReversed]: 422,
    [FailureCode.ReferenceSettled]: 422,
    [FailureCode.BalanceLimitExceeded]: 422,
    // 503 e 500
    [FailureCode.DependencyUnavailable]: 503,
    [ApiOnlyErrorCode.InternalError]: 500,
    // autenticação (ADR-0010)
    [ApiOnlyErrorCode.Unauthenticated]: 401,
    [ApiOnlyErrorCode.ProviderForbidden]: 403,
  };

  test.each(Object.entries(expected))('%s is %i', (code, status) => {
    expect(statusOfError(code as ApiErrorCode)).toBe(status);
  });

  test('every code of the API is covered by this table (a new code fails here first)', () => {
    const all = [
      ...Object.values(FailureCode),
      ...Object.values(ApiOnlyErrorCode),
    ];
    expect(Object.keys(expected).sort((a, b) => a.localeCompare(b))).toEqual(
      [...all].sort((a, b) => a.localeCompare(b)),
    );
  });

  test('the five situations the API must tell apart have five different statuses', () => {
    const statuses = [
      statusOfError(FailureCode.InvalidPayload), // payload inválido
      statusOfError(FailureCode.IdempotencyKeyReused), // conflito de idempotência
      statusOfResult(result(S.Rejected, false)), // rejeição por regra de negócio
      statusOfResult(result(S.PendingReference, false)), // aceite com processamento pendente
      statusOfError(FailureCode.DependencyUnavailable), // falha transitória
    ];
    expect(new Set(statuses).size).toBe(5);
  });
});

test('the default Retry-After is a whole number of seconds, at least one', () => {
  expect(Number.isInteger(DEFAULT_RETRY_AFTER_SECONDS)).toBe(true);
  expect(DEFAULT_RETRY_AFTER_SECONDS).toBeGreaterThanOrEqual(1);
});
