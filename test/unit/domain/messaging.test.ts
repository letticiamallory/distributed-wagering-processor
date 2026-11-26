import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message.js';
import {
  InvalidInboxMessageError,
  InvalidOutboxMessageError,
} from '../../../src/domain/messaging/messaging.errors.js';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message.js';
import { WagerTransactionPendingReference } from '../../../src/domain/messaging/events/wager-transaction-pending-reference.js';

import { Money } from '../../../src/domain/money/money.js';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction.js';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind.js';

const t0 = new Date('2026-11-25T12:00:00.000Z');
const t1 = new Date('2026-11-25T12:00:05.000Z');
const HASH = 'b'.repeat(64);

describe('InboxMessage', () => {
  const receive = (overrides = {}) =>
    InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions-consumer',
      payloadHash: HASH,
      receivedAt: t0,
      ...overrides,
    });

  test('is received not processed', () => {
    const m = receive();
    expect(m.messageId).toBe('msg-1');
    expect(m.consumerName).toBe('wager-transactions-consumer');
    expect(m.payloadHash).toBe(HASH);
    expect(m.receivedAt).toBe(t0);
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
  });

  test('markProcessed records when', () => {
    const m = receive();
    m.markProcessed(t1);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toBe(t1);
  });

  test('cannot be processed twice, and the first date is kept', () => {
    const m = receive();
    m.markProcessed(t1);
    expect(() => m.markProcessed(new Date('2027-01-01'))).toThrow(
      InvalidInboxMessageError,
    );
    expect(m.processedAt).toBe(t1);
  });

  test.each([
    ['messageId', { messageId: ' ' }],
    ['consumerName', { consumerName: '' }],
    ['payloadHash too short', { payloadHash: 'abc' }],
    ['payloadHash uppercase', { payloadHash: 'B'.repeat(64) }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => receive(overrides)).toThrow(InvalidInboxMessageError);
  });

  test('rehydrate restores a processed message without revalidating', () => {
    const m = InboxMessage.rehydrate({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: HASH,
      receivedAt: t0,
      processedAt: t1,
    });
    expect(m.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const event = WagerTransactionPendingReference.from(pendingTransaction(), {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    occurredAt: t0,
  });
  const enqueue = (now = t0) => OutboxMessage.enqueue(event, now);

  test('enqueue copies the envelope and is due right away', () => {
    const m = enqueue();
    expect(m.id).toBe('evt-1');
    expect(m.aggregateId).toBe('wallet-1');
    expect(m.eventType).toBe('WagerTransactionPendingReference');
    expect(m.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(m.occurredAt).toBe(t0);
    expect(m.attempts).toBe(0);
    expect(m.nextAttemptAt).toEqual(t0);
    expect(m.publishedAt).toBeUndefined();
    expect(m.lastError).toBeUndefined();
    expect(m.isPending()).toBe(true);
    expect(m.isDue(t0)).toBe(true);
  });

  test('the payload cannot be changed after enqueue', () => {
    const m = enqueue();
    expect(Object.isFrozen(m.payload)).toBe(true);
    expect(Object.isFrozen(m.payload.data)).toBe(true);
  });

  test('isDue is false before nextAttemptAt and true from it on', () => {
    const m = enqueue(t1);
    expect(m.isDue(t0)).toBe(false);
    expect(m.isDue(new Date(t1.getTime() - 1))).toBe(false);
    expect(m.isDue(t1)).toBe(true);
    expect(m.isDue(new Date(t1.getTime() + 1))).toBe(true);
  });

  test('markPublished ends the life of the message', () => {
    const m = enqueue();
    m.markPublished(t1);
    expect(m.publishedAt).toBe(t1);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date('2030-01-01'))).toBe(false);
  });

  test('a published message cannot be published or retried again', () => {
    const m = enqueue();
    m.markPublished(t1);
    expect(() => m.markPublished(t1)).toThrow(InvalidOutboxMessageError);
    expect(() => m.scheduleRetry(t1, 0)).toThrow(InvalidOutboxMessageError);
    expect(m.attempts).toBe(0);
  });

  describe('scheduleRetry: min(2^attempts x 1s, 5min)', () => {
    test.each([
      [0, 1_000],
      [1, 2_000],
      [2, 4_000],
      [3, 8_000],
      [4, 16_000],
      [5, 32_000],
      [6, 64_000],
      [7, 128_000],
      [8, 256_000],
      [9, 300_000],
      [10, 300_000],
      [60, 300_000],
    ])('with %i attempts waits %i ms (no jitter)', (attempts, ms) => {
      const m = OutboxMessage.rehydrate({
        ...stateOf(enqueue()),
        attempts,
      });
      m.scheduleRetry(t1, 0);
      expect(m.nextAttemptAt.getTime()).toBe(t1.getTime() + ms);
      expect(m.attempts).toBe(attempts + 1);
    });

    test('jitter only shortens the wait, by at most 20%', () => {
      const wait = (jitter: number) => {
        const m = enqueue();
        m.scheduleRetry(t1, jitter);
        return m.nextAttemptAt.getTime() - t1.getTime();
      };
      expect(wait(0)).toBe(1_000);
      expect(wait(0.5)).toBe(900);
      expect(wait(1)).toBe(800);
    });

    test('jitter never pushes past the 5 minute ceiling', () => {
      const m = OutboxMessage.rehydrate({
        ...stateOf(enqueue()),
        attempts: 20,
      });
      m.scheduleRetry(t1, 0);
      expect(m.nextAttemptAt.getTime() - t1.getTime()).toBeLessThanOrEqual(
        300_000,
      );
    });

    test.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses jitter %p and changes nothing',
      (jitter) => {
        const m = enqueue();
        expect(() => m.scheduleRetry(t1, jitter)).toThrow(
          InvalidOutboxMessageError,
        );
        expect(m.attempts).toBe(0);
        expect(m.nextAttemptAt).toEqual(t0);
      },
    );

    test('keeps the last error, truncated', () => {
      const m = enqueue();
      m.scheduleRetry(t1, 0, 'queue unavailable');
      expect(m.lastError).toBe('queue unavailable');
      m.scheduleRetry(t1, 0, 'x'.repeat(5000));
      expect(m.lastError?.length).toBe(1000);
    });

    test('the retried message is not due until the new time', () => {
      const m = enqueue();
      m.scheduleRetry(t1, 0);
      expect(m.isDue(t1)).toBe(false);
      expect(m.isDue(new Date(t1.getTime() + 1_000))).toBe(true);
    });
  });
});

function stateOf(m: OutboxMessage) {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: m.payload,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt,
    publishedAt: m.publishedAt,
    lastError: m.lastError,
  };
}

function pendingTransaction(): WagerTransaction {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: 'ext-bet',
    correlationId: 'corr-1',
    createdAt: t0,
  });
  tx.markPendingReference(t1);
  return tx;
}
