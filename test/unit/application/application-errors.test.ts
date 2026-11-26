import { describe, expect, test } from 'bun:test';
import {
  ApiOnlyErrorCode,
  type ApiErrorCode,
} from '../../../src/application/errors/api-error-code.js';
import {
  ApplicationError,
  ConcurrentWalletUpdateError,
  DependencyUnavailableError,
  DuplicateKeyError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InvalidCommandError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors/application-errors.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';

describe('API error codes', () => {
  test('the codes only the API knows are not failure codes (they are never stored in a transaction)', () => {
    const stored = new Set<string>(Object.values(FailureCode));
    for (const code of Object.values(ApiOnlyErrorCode)) {
      expect(stored.has(code)).toBe(false);
    }
    expect(Object.values(ApiOnlyErrorCode).sort()).toEqual([
      'INTERNAL_ERROR',
      'TRANSACTION_NOT_FOUND',
      'WALLET_ALREADY_EXISTS',
    ]);
  });
});

describe('application errors', () => {
  const cases: Array<[string, ApplicationError, ApiErrorCode, boolean]> = [
    [
      'InvalidCommandError',
      new InvalidCommandError(FailureCode.InvalidAmount, 'bad amount', []),
      FailureCode.InvalidAmount,
      false,
    ],
    [
      'IdempotencyKeyReusedError',
      new IdempotencyKeyReusedError('key-1'),
      FailureCode.IdempotencyKeyReused,
      false,
    ],
    [
      'ExternalIdConflictError',
      new ExternalIdConflictError('provider-a', 'ext-1'),
      FailureCode.ExternalIdConflict,
      false,
    ],
    [
      'WalletNotFoundError',
      new WalletNotFoundError('wallet-1'),
      FailureCode.WalletNotFound,
      false,
    ],
    [
      'WalletAlreadyExistsError',
      new WalletAlreadyExistsError('player-1', 'BRL'),
      ApiOnlyErrorCode.WalletAlreadyExists,
      false,
    ],
    [
      'TransactionNotFoundError',
      new TransactionNotFoundError('tx-1'),
      ApiOnlyErrorCode.TransactionNotFound,
      false,
    ],
    [
      'DependencyUnavailableError',
      new DependencyUnavailableError('lock timeout'),
      FailureCode.DependencyUnavailable,
      true,
    ],
    [
      'DuplicateKeyError',
      new DuplicateKeyError('uq_wtx_idempotency_key'),
      ApiOnlyErrorCode.InternalError,
      false,
    ],
    [
      'ConcurrentWalletUpdateError',
      new ConcurrentWalletUpdateError('wallet-1', 3),
      ApiOnlyErrorCode.InternalError,
      false,
    ],
  ];

  test.each(cases)(
    '%s has the right code and retryable flag',
    (name, error, code, retryable) => {
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
    },
  );

  test('messages say what and who, so a log line is useful on its own', () => {
    expect(new IdempotencyKeyReusedError('key-1').message).toContain('key-1');
    expect(
      new ExternalIdConflictError('provider-a', 'ext-1').message,
    ).toContain('provider-a');
    expect(
      new ExternalIdConflictError('provider-a', 'ext-1').message,
    ).toContain('ext-1');
    expect(new WalletNotFoundError('wallet-1').message).toContain('wallet-1');
    expect(new WalletAlreadyExistsError('player-1', 'BRL').message).toContain(
      'player-1',
    );
    expect(new WalletAlreadyExistsError('player-1', 'BRL').message).toContain(
      'BRL',
    );
    expect(new TransactionNotFoundError('tx-1').message).toContain('tx-1');
    expect(new ConcurrentWalletUpdateError('wallet-1', 3).message).toContain(
      'wallet-1',
    );
  });

  test('DuplicateKeyError carries the constraint, which is how the use case tells races apart', () => {
    expect(new DuplicateKeyError('uq_wtx_idempotency_key').constraint).toBe(
      'uq_wtx_idempotency_key',
    );
  });

  test('DependencyUnavailableError keeps the original error as the cause', () => {
    const cause = new Error('57P01');
    expect(new DependencyUnavailableError('db down', cause).cause).toBe(cause);
  });

  test('InvalidCommandError lists the fields that failed', () => {
    const error = new InvalidCommandError(FailureCode.InvalidPayload, 'x', [
      { path: 'walletId', message: 'not a UUID' },
    ]);
    expect(error.details).toEqual([
      { path: 'walletId', message: 'not a UUID' },
    ]);
  });
});
