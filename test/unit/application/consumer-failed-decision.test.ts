import { describe, expect, test } from 'bun:test';
import {
  ConcurrentWalletUpdateError,
  DependencyUnavailableError,
  PermanentDataError,
} from '../../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../../src/application/messaging/consumer-retry-policy.js';
import {
  WagerMessageHandler,
  type WagerProcessor,
} from '../../../src/application/messaging/wager-message-handler.js';
import { DeliveryFailureLog } from '../../../src/application/ports/delivery-failure-log.js';
import type { ProcessWagerResult } from '../../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../../src/domain/wager/wager-transaction-status.js';

// FAILED (enunciado 6.3: erro permanente de infraestrutura, terminal e auditável) só é gravado na
// fila quando TODA entrega da mensagem falhou com um erro permanente, e há prova disso: cada falha
// permanente soma 1 no DeliveryFailureLog, numa transação própria. Uma entrega sem registro (o banco
// estava fora, então nem o registro passou; ou a mensagem voltou por crash) impede o FAILED. Assim
// uma queda longa do banco NUNCA vira FAILED: a mensagem vai para a DLQ e um redrive a processa.
const MAX = 10;
const policy = new ConsumerRetryPolicy({
  maxReceiveCount: MAX,
  baseSeconds: 2,
  maxSeconds: 60,
});

class FakeFailureLog extends DeliveryFailureLog {
  counts = new Map<string, number>();
  down = false;
  async recordPermanentFailure(consumerName: string, messageId: string) {
    if (this.down) {
      throw new DependencyUnavailableError('db down');
    }
    const key = `${consumerName}:${messageId}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

const failedResult: ProcessWagerResult = {
  transactionId: 'tx-failed',
  status: WagerTransactionStatus.Failed,
  failureCode: FailureCode.ProcessingFailed,
  idempotentReplay: false,
};

function setup(errorFor: (delivery: number) => unknown) {
  let delivery = 0;
  const failCalls: unknown[] = [];
  const processor: WagerProcessor = {
    execute: () => Promise.reject(errorFor(delivery)),
    fail: (input) => {
      failCalls.push(input);
      return Promise.resolve(failedResult);
    },
  };
  const log = new FakeFailureLog();
  const handler = new WagerMessageHandler(processor, policy, log);
  const body = JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-27T12:00:00.000Z',
    data: { walletId: 'w', providerId: 'p', idempotencyKey: 'k' },
  });
  const deliver = async (n: number) => {
    delivery = n;
    return handler.handle(body, { receiveCount: n });
  };
  return { deliver, log, failCalls };
}

const bug = () => new ConcurrentWalletUpdateError('wallet-1', 3);
const dbDown = () => new DependencyUnavailableError('db down');

describe('FAILED on the queue: only with proof that every delivery failed permanently', () => {
  test('a permanent error on all 10 deliveries: retried 9 times, then FAILED (ack)', async () => {
    const { deliver, failCalls } = setup(bug);
    for (let n = 1; n < MAX; n++) {
      expect((await deliver(n)).action).toBe('RETRY');
    }
    expect(await deliver(MAX)).toMatchObject({
      action: 'ACK',
      outcome: 'FAILED',
      transactionId: 'tx-failed',
    });
    expect(failCalls).toHaveLength(1);
  });

  test('the long database outage: 10 transient deliveries go to the DLQ and NEVER to FAILED', async () => {
    const { deliver, log, failCalls } = setup(dbDown);
    log.down = true; // o banco fora: nem o registro de falha passa
    for (let n = 1; n < MAX; n++) {
      expect((await deliver(n)).action).toBe('RETRY');
    }
    expect(await deliver(MAX)).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
    });
    expect(failCalls).toHaveLength(0);
    expect(log.counts.size).toBe(0);
  });

  test('outage first (5 transient), then a permanent error (5): still DLQ, never FAILED', async () => {
    const { deliver, log, failCalls } = setup((n) =>
      n <= 5 ? dbDown() : bug(),
    );
    for (let n = 1; n < MAX; n++) {
      log.down = n <= 5;
      await deliver(n);
    }
    log.down = false;
    expect(await deliver(MAX)).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
    });
    expect(failCalls).toHaveLength(0);
  });

  test('a permanent error whose failure record cannot be written counts as missing proof', async () => {
    const { deliver, log, failCalls } = setup(bug);
    for (let n = 1; n < MAX; n++) {
      log.down = n === 3; // o registro da 3ª entrega falhou
      await deliver(n);
    }
    log.down = false;
    expect((await deliver(MAX)).action).toBe('DEAD_LETTER');
    expect(failCalls).toHaveLength(0);
  });

  test('a PermanentDataError on the first delivery is recorded as FAILED at once', async () => {
    const { deliver, failCalls } = setup(
      () => new PermanentDataError('22021', new Error('x')),
    );
    expect(await deliver(1)).toMatchObject({
      action: 'ACK',
      outcome: 'FAILED',
    });
    expect(failCalls).toHaveLength(1);
  });

  test('a PermanentDataError after an unrecorded delivery goes to the DLQ (no FAILED)', async () => {
    const { deliver, failCalls } = setup(
      () => new PermanentDataError('22021', new Error('x')),
    );
    expect(await deliver(2)).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'PERMANENT_DATA_ERROR',
    });
    expect(failCalls).toHaveLength(0);
  });

  test('if recording FAILED itself fails, the message goes to the DLQ (never lost, never acked)', async () => {
    let delivery = 0;
    const processor: WagerProcessor = {
      execute: () => Promise.reject(bug()),
      fail: () => Promise.reject(new Error('cannot store the row')),
    };
    const handler = new WagerMessageHandler(
      processor,
      policy,
      new FakeFailureLog(),
    );
    const body = JSON.stringify({
      messageId: 'msg-2',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-11-27T12:00:00.000Z',
      data: {},
    });
    let last;
    for (delivery = 1; delivery <= MAX; delivery++) {
      last = await handler.handle(body, { receiveCount: delivery });
    }
    expect(last).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
    });
  });

  test('an unknown error (not an application error) is not proof of anything: never FAILED', async () => {
    const { deliver, failCalls } = setup(() => new Error('who knows'));
    for (let n = 1; n < MAX; n++) await deliver(n);
    expect((await deliver(MAX)).action).toBe('DEAD_LETTER');
    expect(failCalls).toHaveLength(0);
  });

  test('without a failure log (the old wiring) the handler never records FAILED', async () => {
    const handler = new WagerMessageHandler(
      {
        execute: () => Promise.reject(bug()),
        fail: () => Promise.resolve(failedResult),
      },
      policy,
    );
    const body = JSON.stringify({
      messageId: 'msg-3',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-11-27T12:00:00.000Z',
      data: {},
    });
    expect((await handler.handle(body, { receiveCount: MAX })).action).toBe(
      'DEAD_LETTER',
    );
  });
});
