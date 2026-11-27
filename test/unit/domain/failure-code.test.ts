import { describe, expect, test } from 'bun:test';
import {
  FailureCode,
  failureCodeInfo,
  isRetryable,
} from '../../../src/domain/errors/failure-code.js';

const allCodes = Object.values(FailureCode);

describe('FailureCode taxonomy', () => {
  test('every code is a stable UPPER_SNAKE string, the one the provider reads', () => {
    const toSnake = (key: string) =>
      key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    for (const [key, value] of Object.entries(FailureCode)) {
      expect(String(value)).toBe(toSnake(key));
    }
  });

  test('has the 20 codes of the taxonomy, including REFERENCE_SETTLED, BALANCE_LIMIT_EXCEEDED and PROCESSING_FAILED', () => {
    expect(allCodes).toHaveLength(20);
    expect(allCodes).toContain(FailureCode.ProcessingFailed);
    expect(allCodes).toContain(FailureCode.BalanceLimitExceeded);
    expect(allCodes).toContain(FailureCode.ReferenceSettled);
  });

  test('every code has a category and a retryable flag', () => {
    const categories = [
      'validation',
      'idempotency',
      'business',
      'transient',
      'permanent',
    ];
    for (const code of allCodes) {
      const info = failureCodeInfo(code);
      expect(categories).toContain(info.category);
      expect(typeof info.retryable).toBe('boolean');
    }
  });

  test('only DEPENDENCY_UNAVAILABLE is retryable with the same key', () => {
    expect(allCodes.filter(isRetryable)).toEqual([
      FailureCode.DependencyUnavailable,
    ]);
    expect(failureCodeInfo(FailureCode.DependencyUnavailable).category).toBe(
      'transient',
    );
  });

  test('the categories follow the taxonomy', () => {
    expect(failureCodeInfo(FailureCode.InvalidPayload).category).toBe(
      'validation',
    );
    expect(failureCodeInfo(FailureCode.InvalidAmount).category).toBe(
      'validation',
    );
    expect(failureCodeInfo(FailureCode.UnsupportedKind).category).toBe(
      'validation',
    );
    expect(failureCodeInfo(FailureCode.IdempotencyKeyReused).category).toBe(
      'idempotency',
    );
    expect(failureCodeInfo(FailureCode.ExternalIdConflict).category).toBe(
      'idempotency',
    );
    for (const code of [
      FailureCode.InsufficientFunds,
      FailureCode.ReversalInsufficientFunds,
      FailureCode.ReferenceAlreadyReversed,
      FailureCode.ReferenceSettled,
      FailureCode.CurrencyMismatch,
    ]) {
      expect(failureCodeInfo(code).category).toBe('business');
    }
  });
});
