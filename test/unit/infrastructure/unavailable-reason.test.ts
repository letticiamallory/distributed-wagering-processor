import { describe, expect, test } from 'bun:test';
import { DependencyUnavailableError } from '../../../src/application/errors/application-errors.js';
import { unavailableReason } from '../../../src/infrastructure/persistence/unavailable-reason.js';

const driver = (code: string, message = 'x') =>
  Object.assign(new Error(message), { code });
const wrapped = (cause: unknown) =>
  new DependencyUnavailableError('busy', cause);

describe('unavailableReason: why a 503 happened, from the driver error behind it', () => {
  test.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
    ['57P01', 'connection'],
    ['57P02', 'connection'],
    ['57P03', 'connection'],
    ['53300', 'connection'],
    ['08006', 'connection'],
    ['ECONNREFUSED', 'connection'],
    ['ECONNRESET', 'connection'],
    ['ETIMEDOUT', 'connection'],
  ] as const)('SQLSTATE/code %s is %s', (code, reason) => {
    expect(unavailableReason(wrapped(driver(code)))).toBe(reason);
  });

  test('the pool with no free connection (the pg error has no code, only a message) is pool_timeout', () => {
    expect(
      unavailableReason(
        wrapped(new Error('timeout exceeded when trying to connect')),
      ),
    ).toBe('pool_timeout');
  });

  test('the cause is found through the cause chain and inside an AggregateError', () => {
    const nested = new Error('outer', { cause: driver('55P03') });
    expect(unavailableReason(wrapped(nested))).toBe('lock_timeout');
    const aggregate = Object.assign(new Error('both families refused'), {
      errors: [driver('ECONNREFUSED'), driver('ECONNREFUSED')],
    });
    expect(unavailableReason(wrapped(aggregate))).toBe('connection');
  });

  test('the connection-lost messages without a code are "connection"', () => {
    expect(
      unavailableReason(
        wrapped(new Error('Connection terminated unexpectedly')),
      ),
    ).toBe('connection');
  });

  test('anything else is "other" (never an exception)', () => {
    expect(unavailableReason(wrapped(new Error('something unknown')))).toBe(
      'other',
    );
    expect(unavailableReason(undefined)).toBe('other');
    expect(unavailableReason('text')).toBe('other');
  });
});
