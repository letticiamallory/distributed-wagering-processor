import { describe, expect, test } from 'bun:test';
import { ConsumerRetryPolicy } from '../../../src/application/messaging/consumer-retry-policy.js';

const policy = (
  over: Partial<ConstructorParameters<typeof ConsumerRetryPolicy>[0]> = {},
) =>
  new ConsumerRetryPolicy({
    maxReceiveCount: 10,
    baseSeconds: 2,
    maxSeconds: 60,
    ...over,
  });

describe('consumer backoff: min(2^receiveCount x base, max)', () => {
  test.each([
    [1, 4],
    [2, 8],
    [3, 16],
    [4, 32],
    [5, 60], // 64 passaria do teto
    [9, 60],
    [1000, 60], // sem estourar com contagens absurdas
  ])('after delivery %i the message waits %i s', (count, expected) => {
    expect(policy().delaySeconds(count)).toBe(expected);
  });

  test('a base of zero means "try again at once" (the tests use it to be fast)', () => {
    expect(policy({ baseSeconds: 0 }).delaySeconds(3)).toBe(0);
  });

  test('the whole wait before the dead-letter queue adds up to about six minutes with the defaults', () => {
    // 9 esperas (as entregas 1 a 9; a 10ª já vai para a DLQ): 4+8+16+32 + 5x60
    const total = Array.from({ length: 9 }, (_, i) =>
      policy().delaySeconds(i + 1),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBe(360);
  });
});

describe('the attempt limit', () => {
  test('is exhausted exactly at maxReceiveCount deliveries, not before', () => {
    const p = policy({ maxReceiveCount: 5 });
    expect([1, 2, 3, 4].map((n) => p.isExhausted(n))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(p.isExhausted(5)).toBe(true);
    expect(p.isExhausted(6)).toBe(true);
  });
});
