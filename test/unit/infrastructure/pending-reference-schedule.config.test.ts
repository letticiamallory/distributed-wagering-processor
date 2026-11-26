import { describe, expect, test } from 'bun:test';
import { PendingReferenceSchedule } from '../../../src/domain/wager/pending-reference-schedule.js';
import {
  InvalidPendingReferenceConfigError,
  loadPendingReferenceSchedule,
} from '../../../src/infrastructure/config/pending-reference-schedule.config.js';

const MAX = 'PENDING_REFERENCE_MAX_ATTEMPTS';
const BASE = 'PENDING_REFERENCE_BASE_DELAY_MS';
const CEILING = 'PENDING_REFERENCE_MAX_DELAY_MS';

// ADR-0013: 10 tentativas no total (a 1ª gravação conta), espera de 1 s dobrando até 5 min.
describe('loadPendingReferenceSchedule: the defaults', () => {
  test('without any variable: 10 attempts, 1 s base, 5 min ceiling', () => {
    const schedule = loadPendingReferenceSchedule({});
    expect(schedule).toBeInstanceOf(PendingReferenceSchedule);
    expect(schedule.maxAttempts).toBe(10);
    expect(schedule.baseDelayMs).toBe(1_000);
    expect(schedule.maxDelayMs).toBe(300_000);
  });

  test('an empty variable is the same as an unset one (a blank line in .env)', () => {
    const schedule = loadPendingReferenceSchedule({
      [MAX]: '',
      [BASE]: '  ',
      [CEILING]: '',
    });
    expect(schedule.maxAttempts).toBe(10);
    expect(schedule.baseDelayMs).toBe(1_000);
    expect(schedule.maxDelayMs).toBe(300_000);
  });

  test('the total wait with the defaults is 511 s, about 8.5 minutes (not the manual 14)', () => {
    const schedule = loadPendingReferenceSchedule({});
    let total = 0;
    for (let attempts = 0; !schedule.isExhausted(attempts); attempts++) {
      total += schedule.delayMs(attempts);
    }
    expect(total).toBe(511_000);
  });
});

describe('loadPendingReferenceSchedule: the maximum and the ceiling come from the environment', () => {
  test('every value can be changed', () => {
    const schedule = loadPendingReferenceSchedule({
      [MAX]: '5',
      [BASE]: '200',
      [CEILING]: '1500',
    });
    expect(schedule.maxAttempts).toBe(5);
    expect(schedule.baseDelayMs).toBe(200);
    expect(schedule.maxDelayMs).toBe(1_500);
    expect([0, 1, 2, 3].map((n) => schedule.delayMs(n))).toEqual([
      200, 400, 800, 1_500,
    ]);
  });

  test('only one can be changed and the others keep their defaults', () => {
    const schedule = loadPendingReferenceSchedule({ [MAX]: '3' });
    expect(schedule.maxAttempts).toBe(3);
    expect(schedule.baseDelayMs).toBe(1_000);
    expect(schedule.maxDelayMs).toBe(300_000);
  });

  test('surrounding spaces are tolerated', () => {
    expect(loadPendingReferenceSchedule({ [MAX]: ' 7 ' }).maxAttempts).toBe(7);
  });
});

describe('loadPendingReferenceSchedule: an invalid value stops the startup, naming the variable', () => {
  test.each([
    [MAX, 'abc'],
    [MAX, '1.5'],
    [MAX, '-3'],
    [MAX, '1e3'],
    [MAX, '0x10'],
    [MAX, '10 attempts'],
    [BASE, 'fast'],
    [BASE, '1,5'],
    [CEILING, 'NaN'],
    [CEILING, 'Infinity'],
  ])('%s=%p (not a plain non-negative integer)', (name, value) => {
    expect(() => loadPendingReferenceSchedule({ [name]: value })).toThrow(
      InvalidPendingReferenceConfigError,
    );
    expect(() => loadPendingReferenceSchedule({ [name]: value })).toThrow(name);
  });

  test.each([
    [{ [MAX]: '0' }, MAX],
    [{ [BASE]: '0' }, BASE],
    [{ [CEILING]: '0' }, CEILING],
  ])('%j (zero is not a valid limit)', (env, name) => {
    expect(() => loadPendingReferenceSchedule(env)).toThrow(
      InvalidPendingReferenceConfigError,
    );
    expect(() => loadPendingReferenceSchedule(env)).toThrow(name);
  });

  test('a ceiling below the base is refused, and the message names both variables', () => {
    const env = { [BASE]: '5000', [CEILING]: '1000' };
    expect(() => loadPendingReferenceSchedule(env)).toThrow(
      InvalidPendingReferenceConfigError,
    );
    expect(() => loadPendingReferenceSchedule(env)).toThrow(CEILING);
    expect(() => loadPendingReferenceSchedule(env)).toThrow(BASE);
  });

  test('the original error is kept as the cause, for the log', () => {
    try {
      loadPendingReferenceSchedule({ [MAX]: '0' });
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as Error).cause).toBeDefined();
    }
  });

  test('reads process.env when no environment is given', () => {
    const previous = process.env[MAX];
    process.env[MAX] = '4';
    try {
      expect(loadPendingReferenceSchedule().maxAttempts).toBe(4);
    } finally {
      if (previous === undefined) delete process.env[MAX];
      else process.env[MAX] = previous;
    }
  });
});
