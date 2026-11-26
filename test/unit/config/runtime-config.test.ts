import { describe, expect, test } from 'bun:test';
import {
  InvalidEnvironmentError,
  readIntegerVariable,
} from '../../../src/config/env-integer.js';
import { loadHttpConfig } from '../../../src/interfaces/http/http-config.js';
import { loadLockTimeoutMs } from '../../../src/infrastructure/persistence/lock-timeout.config.js';

const spec = { name: 'SOME_LIMIT', fallback: 5, min: 1, max: 100 };

describe('readIntegerVariable', () => {
  test('uses the fallback when the variable is not set, empty or blank', () => {
    expect(readIntegerVariable({}, spec)).toBe(5);
    expect(readIntegerVariable({ SOME_LIMIT: '' }, spec)).toBe(5);
    expect(readIntegerVariable({ SOME_LIMIT: '   ' }, spec)).toBe(5);
  });

  test('reads a plain integer, tolerating spaces around it', () => {
    expect(readIntegerVariable({ SOME_LIMIT: '42' }, spec)).toBe(42);
    expect(readIntegerVariable({ SOME_LIMIT: ' 7 ' }, spec)).toBe(7);
  });

  test('the bounds are inclusive', () => {
    expect(readIntegerVariable({ SOME_LIMIT: '1' }, spec)).toBe(1);
    expect(readIntegerVariable({ SOME_LIMIT: '100' }, spec)).toBe(100);
  });

  test.each(['abc', '1.5', '-3', '1e3', '0x10', '10 s', 'NaN', 'Infinity'])(
    'refuses %p, naming the variable',
    (value) => {
      const read = () => readIntegerVariable({ SOME_LIMIT: value }, spec);
      expect(read).toThrow(InvalidEnvironmentError);
      expect(read).toThrow('SOME_LIMIT');
    },
  );

  test.each(['0', '101'])(
    'refuses %p (out of 1..100), naming the variable and the range',
    (value) => {
      const read = () => readIntegerVariable({ SOME_LIMIT: value }, spec);
      expect(read).toThrow(InvalidEnvironmentError);
      expect(read).toThrow('SOME_LIMIT');
      expect(read).toThrow('1');
      expect(read).toThrow('100');
    },
  );
});

describe('RETRY_AFTER_SECONDS (the Retry-After of a 503)', () => {
  test('defaults to 1 second', () => {
    expect(loadHttpConfig({}).retryAfterSeconds).toBe(1);
  });
  test('can be changed', () => {
    expect(loadHttpConfig({ RETRY_AFTER_SECONDS: '5' }).retryAfterSeconds).toBe(
      5,
    );
  });
  test.each(['0', '-1', '1.5', 'soon', '3601'])(
    'refuses %p at startup, naming the variable',
    (value) => {
      const load = () => loadHttpConfig({ RETRY_AFTER_SECONDS: value });
      expect(load).toThrow(InvalidEnvironmentError);
      expect(load).toThrow('RETRY_AFTER_SECONDS');
    },
  );
});

describe('DB_LOCK_TIMEOUT_MS (how long to wait for a wallet lock, ADR-0007)', () => {
  test('defaults to 5000 ms', () => {
    expect(loadLockTimeoutMs({})).toBe(5_000);
  });
  test('can be changed', () => {
    expect(loadLockTimeoutMs({ DB_LOCK_TIMEOUT_MS: '300' })).toBe(300);
  });
  test.each(['0', '-1', '2.5', 'forever', '600001'])(
    'refuses %p at startup (0 would mean waiting forever), naming the variable',
    (value) => {
      const load = () => loadLockTimeoutMs({ DB_LOCK_TIMEOUT_MS: value });
      expect(load).toThrow(InvalidEnvironmentError);
      expect(load).toThrow('DB_LOCK_TIMEOUT_MS');
    },
  );
});
