import { describe, expect, test } from 'bun:test';
import {
  ConcurrentWalletUpdateError,
  DependencyUnavailableError,
  DuplicateKeyError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InboxMessageReusedError,
  InvalidCommandError,
  UnresolvedIdempotencyRaceError,
  WalletNotFoundError,
} from '../../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../../src/application/messaging/consumer-retry-policy.js';
import {
  WAGER_CONSUMER_NAME,
  WagerMessageHandler,
  type WagerProcessor,
} from '../../../src/application/messaging/wager-message-handler.js';
import type {
  ProcessWagerContext,
  ProcessWagerResult,
} from '../../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../../src/domain/wager/wager-transaction-status.js';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const envelope = (over: Record<string, unknown> = {}) => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data,
  ...over,
});
const body = (value: unknown) => JSON.stringify(value);

interface Call {
  input: unknown;
  context: ProcessWagerContext;
}

function handlerWith(
  behaviour: () => Promise<ProcessWagerResult>,
  policy = new ConsumerRetryPolicy({
    maxReceiveCount: 5,
    baseSeconds: 2,
    maxSeconds: 60,
  }),
) {
  const calls: Call[] = [];
  const processor: WagerProcessor = {
    execute: (input, context) => {
      calls.push({ input, context });
      return behaviour();
    },
  };
  return { handler: new WagerMessageHandler(processor, policy), calls };
}

const processed: ProcessWagerResult = {
  transactionId: 'tx-1',
  status: WagerTransactionStatus.Processed,
  idempotentReplay: false,
};
const failing = (error: unknown) => () => Promise.reject(error);

describe('the envelope (enunciado, seção 10)', () => {
  test('a valid message reaches the SAME use case with the inbox identity, the data and data.idempotencyKey', async () => {
    const { handler, calls } = handlerWith(() => Promise.resolve(processed));
    const result = await handler.handle(body(envelope()), { receiveCount: 1 });

    expect(result).toMatchObject({
      action: 'ACK',
      outcome: 'PROCESSED',
      replay: false,
      messageId: 'msg-123',
      transactionId: 'tx-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toMatchObject({
      idempotencyKey: 'provider-a:transaction-123',
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: 'msg-123' },
      correlationId: 'msg-123',
    });
    expect(calls[0]?.input).toMatchObject({
      walletId: WALLET,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  test.each([
    ['not JSON at all', '{"messageId": ', 'INVALID_JSON'],
    ['an empty body', '', 'INVALID_JSON'],
    ['JSON that is not an object', '[1,2,3]', 'INVALID_ENVELOPE'],
    ['the JSON literal null', 'null', 'INVALID_ENVELOPE'],
  ])(
    '%s goes to the DLQ, without touching the use case',
    async (_name, raw, reason) => {
      const { handler, calls } = handlerWith(() => Promise.resolve(processed));
      const result = await handler.handle(raw, { receiveCount: 1 });
      expect(result).toMatchObject({
        action: 'DEAD_LETTER',
        reason,
        critical: false,
      });
      expect(calls).toHaveLength(0);
    },
  );

  test.each([
    ['no messageId', envelope({ messageId: undefined })],
    ['a blank messageId', envelope({ messageId: '   ' })],
    ['a messageId that is not text', envelope({ messageId: 42 })],
    ['no type', envelope({ type: undefined })],
    ['another type', envelope({ type: 'SomethingElse' })],
    ['no occurredAt', envelope({ occurredAt: undefined })],
    ['an occurredAt that is not a date', envelope({ occurredAt: 'yesterday' })],
    ['no data', envelope({ data: undefined })],
    ['data that is not an object', envelope({ data: 'text' })],
    ['data as a list', envelope({ data: [] })],
  ])('%s goes to the DLQ as INVALID_ENVELOPE', async (_name, message) => {
    const { handler, calls } = handlerWith(() => Promise.resolve(processed));
    const result = await handler.handle(body(message), { receiveCount: 1 });
    expect(result).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'INVALID_ENVELOPE',
    });
    expect(calls).toHaveLength(0);
  });

  test('a bad business payload inside a good envelope is INVALID_PAYLOAD with the failure code, and names the message', async () => {
    const error = new InvalidCommandError(
      FailureCode.InvalidAmount,
      'Invalid amount',
      [{ path: 'money.amount', message: 'x' }],
    );
    const { handler } = handlerWith(failing(error));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 1 }),
    ).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'INVALID_PAYLOAD',
      failureCode: 'INVALID_AMOUNT',
      messageId: 'msg-123',
      idempotencyKey: 'provider-a:transaction-123',
    });
  });

  test('a missing data.idempotencyKey is passed on as missing, so the use case answers INVALID_PAYLOAD', async () => {
    const { handler, calls } = handlerWith(() => Promise.resolve(processed));
    const withoutKey: Record<string, unknown> = { ...data };
    delete withoutKey.idempotencyKey;
    await handler.handle(body(envelope({ data: withoutKey })), {
      receiveCount: 1,
    });
    expect(calls[0]?.context.idempotencyKey).toBeUndefined();
  });
});

describe('the three kinds of outcome', () => {
  test.each([
    ['PROCESSED', WagerTransactionStatus.Processed, false, 'PROCESSED'],
    ['REJECTED', WagerTransactionStatus.Rejected, false, 'REJECTED'],
    [
      'PENDING_REFERENCE',
      WagerTransactionStatus.PendingReference,
      false,
      'PENDING_REFERENCE',
    ],
    [
      'a replay of a PROCESSED',
      WagerTransactionStatus.Processed,
      true,
      'PROCESSED',
    ],
    [
      'a stored FAILED (it was recorded)',
      WagerTransactionStatus.Failed,
      false,
      'FAILED',
    ],
  ])(
    'business result %s: ACK',
    async (_name, status, idempotentReplay, outcome) => {
      const { handler } = handlerWith(() =>
        Promise.resolve({ ...processed, status, idempotentReplay }),
      );
      expect(
        await handler.handle(body(envelope()), { receiveCount: 1 }),
      ).toMatchObject({
        action: 'ACK',
        outcome,
        replay: idempotentReplay,
      });
    },
  );

  test.each([
    [
      'IDEMPOTENCY_KEY_REUSED',
      new IdempotencyKeyReusedError('provider-a:transaction-123'),
    ],
    [
      'EXTERNAL_ID_CONFLICT',
      new ExternalIdConflictError('provider-a', 'transaction-123'),
    ],
  ])(
    'an idempotency conflict (%s): ACK, carrying the ids so the consumer can log them',
    async (_name, error) => {
      const { handler } = handlerWith(failing(error));
      expect(
        await handler.handle(body(envelope()), { receiveCount: 1 }),
      ).toMatchObject({
        action: 'ACK',
        outcome: 'IDEMPOTENCY_CONFLICT',
        messageId: 'msg-123',
        idempotencyKey: 'provider-a:transaction-123',
        error,
      });
    },
  );

  test('DEPENDENCY_UNAVAILABLE: RETRY, never an ack, with the backoff of the delivery that just failed', async () => {
    const error = new DependencyUnavailableError('db down');
    const { handler } = handlerWith(failing(error));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 2 }),
    ).toMatchObject({ action: 'RETRY', delaySeconds: 8, error });
  });

  test.each([
    ['WALLET_NOT_FOUND', new WalletNotFoundError(WALLET), 'WALLET_NOT_FOUND'],
    [
      'an inbox id reused with another content',
      new InboxMessageReusedError(WAGER_CONSUMER_NAME, 'msg-123'),
      'INBOX_MESSAGE_REUSED',
    ],
  ])(
    '%s is permanent: DLQ now, not after N tries',
    async (_name, error, reason) => {
      const { handler } = handlerWith(failing(error));
      expect(
        await handler.handle(body(envelope()), { receiveCount: 1 }),
      ).toMatchObject({ action: 'DEAD_LETTER', reason, critical: false });
    },
  );

  test('a critical error goes to the DLQ at once, flagged critical (so the consumer logs fatal)', async () => {
    const error = new UnresolvedIdempotencyRaceError(
      new DuplicateKeyError('uq_wtx_idempotency_key'),
    );
    const { handler } = handlerWith(failing(error));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 1 }),
    ).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'CRITICAL',
      critical: true,
      error,
    });
  });

  test.each([
    ['a plain Error (a bug)', new Error('boom')],
    [
      'a non-critical application bug',
      new ConcurrentWalletUpdateError(WALLET, 3),
    ],
    ['a duplicate key that escaped', new DuplicateKeyError('uq_other')],
  ])(
    '%s is unknown: RETRY (not deleted, not dropped), and the limit takes it to the DLQ',
    async (_name, error) => {
      const { handler } = handlerWith(failing(error));
      expect(
        await handler.handle(body(envelope()), { receiveCount: 1 }),
      ).toMatchObject({ action: 'RETRY', error });
    },
  );

  test('something that is not even an Error object is also RETRY', async () => {
    const { handler } = handlerWith(failing('just a string'));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 1 }),
    ).toMatchObject({ action: 'RETRY' });
  });
});

describe('the attempt limit', () => {
  test('a transient failure on the LAST allowed delivery goes to the DLQ as RETRIES_EXHAUSTED', async () => {
    const error = new DependencyUnavailableError('db down');
    const { handler } = handlerWith(failing(error));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 5 }),
    ).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
      critical: false,
      error,
    });
    // uma entrega antes, ainda é retry
    expect(
      await handler.handle(body(envelope()), { receiveCount: 4 }),
    ).toMatchObject({ action: 'RETRY', delaySeconds: 32 });
  });

  test('the limit never turns a business ACK into a DLQ: a PROCESSED on the last delivery is still an ack', async () => {
    const { handler } = handlerWith(() => Promise.resolve(processed));
    expect(
      await handler.handle(body(envelope()), { receiveCount: 5 }),
    ).toMatchObject({ action: 'ACK' });
  });
});
