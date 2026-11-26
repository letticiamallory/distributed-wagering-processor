import { describe, expect, test } from 'bun:test';
import {
  InvalidPendingReferenceScheduleError,
  PendingReferenceSchedule,
} from '../../../src/domain/wager/pending-reference-schedule.js';

const T0 = new Date('2026-11-27T09:00:00.000Z');
const seconds = (n: number) => n * 1_000;

// "attempts" é quantas vezes a transação JÁ tentou resolver a referência (a 1ª gravação como
// PENDING_REFERENCE conta como a 1ª tentativa). O backoff é min(2^attempts x base, teto).
describe('PendingReferenceSchedule: the wait grows by doubling, up to a ceiling', () => {
  const schedule = new PendingReferenceSchedule({
    maxAttempts: 10,
    baseDelayMs: seconds(1),
    maxDelayMs: seconds(300),
  });

  test.each([
    [0, 1],
    [1, 2],
    [2, 4],
    [3, 8],
    [4, 16],
    [5, 32],
    [6, 64],
    [7, 128],
    [8, 256],
  ])('after %i attempts it waits %i s', (attempts, expected) => {
    expect(schedule.delayMs(attempts)).toBe(seconds(expected));
  });

  test.each([9, 10, 20, 100, 100_000])(
    'after %i attempts the wait is capped at 5 minutes (no overflow)',
    (attempts) => {
      expect(schedule.delayMs(attempts)).toBe(seconds(300));
    },
  );

  test('nextAttemptAt is now + the wait, and does not change the Date it received', () => {
    const now = new Date(T0);
    expect(schedule.nextAttemptAt(now, 2).toISOString()).toBe(
      '2026-11-27T09:00:04.000Z',
    );
    expect(now.toISOString()).toBe(T0.toISOString());
  });

  test('the base and the ceiling are configurable', () => {
    const quick = new PendingReferenceSchedule({
      maxAttempts: 4,
      baseDelayMs: 50,
      maxDelayMs: 120,
    });
    expect([0, 1, 2, 3].map((n) => quick.delayMs(n))).toEqual([
      50, 100, 120, 120,
    ]);
  });
});

describe('PendingReferenceSchedule: when the attempts are over', () => {
  test.each([
    [0, false],
    [7, false],
    [8, false],
    [9, true], // esta seria a 10ª tentativa: é a última
    [10, true],
    [50, true],
  ])(
    'with a limit of 10, a transaction that already tried %i times is exhausted: %p',
    (attempts, exhausted) => {
      expect(
        new PendingReferenceSchedule({ maxAttempts: 10 }).isExhausted(attempts),
      ).toBe(exhausted);
    },
  );

  test('with a limit of 3, the third try is the last', () => {
    const schedule = new PendingReferenceSchedule({ maxAttempts: 3 });
    expect([0, 1, 2, 3].map((n) => schedule.isExhausted(n))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test('with a limit of 1 there is no second chance: even the first pass is the last', () => {
    expect(
      new PendingReferenceSchedule({ maxAttempts: 1 }).isExhausted(0),
    ).toBe(true);
  });
});

// O manual diz "10 tentativas, cerca de 14 minutos (1 + 2 + ... + 256 + 300 s)". Estes dois casos
// deixam a aritmética à vista: a contagem escolhida muda o tempo total de espera.
describe('PendingReferenceSchedule: how long a transaction can wait in total', () => {
  const totalWaitMs = (schedule: PendingReferenceSchedule) => {
    let total = 0;
    for (let attempts = 0; !schedule.isExhausted(attempts); attempts++) {
      total += schedule.delayMs(attempts);
    }
    return total;
  };

  test('10 attempts (the first write counts as the 1st): 9 waits, 511 s, about 8.5 minutes', () => {
    expect(totalWaitMs(new PendingReferenceSchedule({ maxAttempts: 10 }))).toBe(
      seconds(511),
    );
  });

  test('11 attempts: 10 waits, 811 s, about 14 minutes (the manual: 1+2+...+256+300)', () => {
    expect(totalWaitMs(new PendingReferenceSchedule({ maxAttempts: 11 }))).toBe(
      seconds(811),
    );
  });
});

describe('PendingReferenceSchedule: invalid configuration is refused', () => {
  test.each([
    { maxAttempts: 0 },
    { maxAttempts: -1 },
    { maxAttempts: 2.5 },
    { maxAttempts: Number.NaN },
    { baseDelayMs: 0 },
    { baseDelayMs: -5 },
    { baseDelayMs: 1.5 },
    { maxDelayMs: 0 },
    { baseDelayMs: 2_000, maxDelayMs: 1_000 }, // teto menor que a base
  ])('%j', (options) => {
    expect(() => new PendingReferenceSchedule(options)).toThrow(
      InvalidPendingReferenceScheduleError,
    );
  });

  test('delayMs and nextAttemptAt refuse a negative or fractional attempt count', () => {
    const schedule = new PendingReferenceSchedule({ maxAttempts: 5 });
    expect(() => schedule.delayMs(-1)).toThrow(
      InvalidPendingReferenceScheduleError,
    );
    expect(() => schedule.nextAttemptAt(T0, 1.5)).toThrow(
      InvalidPendingReferenceScheduleError,
    );
    expect(() => schedule.isExhausted(-1)).toThrow(
      InvalidPendingReferenceScheduleError,
    );
  });

  test('the defaults: 10 attempts (the first write counts), 1 s base, 5 min ceiling', () => {
    const schedule = new PendingReferenceSchedule();
    expect(schedule.maxAttempts).toBe(10);
    expect(schedule.baseDelayMs).toBe(1_000);
    expect(schedule.maxDelayMs).toBe(300_000);
  });
});
