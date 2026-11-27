import { describe, expect, test } from 'bun:test';
import {
  ConcurrentWalletUpdateError,
  DependencyUnavailableError,
  PermanentDataError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { ConsumerRetryPolicy } from '../../src/application/messaging/consumer-retry-policy.js';
import {
  WAGER_CONSUMER_NAME,
  WagerMessageHandler,
} from '../../src/application/messaging/wager-message-handler.js';
import { DeliveryFailureLog } from '../../src/application/ports/delivery-failure-log.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { MikroOrmDeliveryFailureLog } from '../../src/infrastructure/persistence/repositories/mikro-orm-delivery-failure-log.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence, uuid } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db);
const MAX = 10;
const policy = new ConsumerRetryPolicy({
  maxReceiveCount: MAX,
  baseSeconds: 0,
  maxSeconds: 0,
});

// O banco "cai" para tudo o que passa por aqui: a unidade de trabalho e o registro de falhas.
class Switch {
  down = false;
}
class SwitchableUnitOfWork extends UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly sw: Switch,
    private readonly firstRunError?: () => Error,
  ) {
    super();
  }
  private used = false;
  run<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
    if (this.sw.down)
      return Promise.reject(new DependencyUnavailableError('db down'));
    if (this.firstRunError && !this.used) {
      this.used = true;
      return Promise.reject(this.firstRunError());
    }
    return this.inner.run(work);
  }
}
class SwitchableFailureLog extends DeliveryFailureLog {
  constructor(
    private readonly inner: DeliveryFailureLog,
    private readonly sw: Switch,
  ) {
    super();
  }
  recordPermanentFailure(consumer: string, messageId: string) {
    if (this.sw.down)
      return Promise.reject(new DependencyUnavailableError('db down'));
    return this.inner.recordPermanentFailure(consumer, messageId);
  }
}

const envelope = (messageId: string, data: Record<string, unknown>) =>
  JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-27T12:00:00.000Z',
    data: { ...data, idempotencyKey: s.keyOf(data) },
  });

const rowsOf = (key: string) =>
  s.sql('SELECT * FROM wager_transactions WHERE idempotency_key = ?', [key]);

describe('ProcessWagerTransactionUseCase.fail: the FAILED row is the audit', () => {
  test('records FAILED with PROCESSING_FAILED, no balance, no ledger, no event; the same key replays it', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const useCase = s.build();
    const failed = await useCase.fail(input, {
      idempotencyKey: s.keyOf(input),
      correlationId: 'corr-fail',
    });
    expect(failed).toMatchObject({
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.ProcessingFailed,
      idempotentReplay: false,
    });
    expect(failed.balance).toBeUndefined();

    const [row] = await rowsOf(s.keyOf(input));
    expect(row).toMatchObject({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
    });
    expect(row?.balance_after).toBeNull();
    expect(await s.balanceOf(wallet)).toBe('100.00');
    expect(await s.movements(wallet.id)).toHaveLength(0);
    expect(await s.eventTypesOf(failed.transactionId)).toEqual([]);

    // Reenviar a MESMA chave devolve o FAILED gravado (terminal: não processa de novo).
    expect(await s.submit(input)).toMatchObject({
      transactionId: failed.transactionId,
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.ProcessingFailed,
      idempotentReplay: true,
    });
    await assertInvariants(s.sql, wallet.id);
  });

  test('a key that was already processed is a replay, never overwritten by FAILED', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const done = await s.submit(input);
    const again = await s.build().fail(input, {
      idempotencyKey: s.keyOf(input),
      correlationId: 'corr-fail',
    });
    expect(again).toMatchObject({
      transactionId: done.transactionId,
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
    });
  });

  test('an unknown wallet is not recorded as FAILED', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet, { walletId: uuid() });
    await expect(
      s
        .build()
        .fail(input, { idempotencyKey: s.keyOf(input), correlationId: 'c' }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await rowsOf(s.keyOf(input))).toHaveLength(0);
  });

  test('HTTP: a PermanentDataError is recorded as FAILED (no queue history to check)', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const useCase = s.build({
      uow: new SwitchableUnitOfWork(
        db().uow,
        new Switch(),
        () => new PermanentDataError('22021', new Error('x')),
      ),
    });
    const result = await s.submit(input, {}, useCase);
    expect(result).toMatchObject({ status: WagerTransactionStatus.Failed });
    expect((await rowsOf(s.keyOf(input)))[0]?.status).toBe('FAILED');
  });
});

describe('the consumer and a LONG database outage', () => {
  function consumerWith(sw: Switch, errorWhenUp?: () => Error) {
    const uow = new SwitchableUnitOfWork(db().uow, sw);
    const useCase = s.build({ uow });
    const processor = errorWhenUp
      ? {
          execute: () => Promise.reject(errorWhenUp()),
          fail: useCase.fail.bind(useCase),
        }
      : useCase;
    return new WagerMessageHandler(
      processor,
      policy,
      new SwitchableFailureLog(new MikroOrmDeliveryFailureLog(db().orm.em), sw),
    );
  }

  test('all 10 deliveries during the outage: DLQ, NO FAILED row, and a redrive after it processes normally', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const sw = new Switch();
    sw.down = true;
    const handler = consumerWith(sw);
    const messageId = `msg-outage-${uuid()}`;
    let last;
    for (let n = 1; n <= MAX; n++) {
      last = await handler.handle(envelope(messageId, input), {
        receiveCount: n,
      });
    }
    expect(last).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
    });

    sw.down = false;
    expect(await rowsOf(s.keyOf(input))).toHaveLength(0);
    const failures = await s.sql(
      'SELECT * FROM consumer_delivery_failures WHERE consumer_name = ? AND message_id = ?',
      [WAGER_CONSUMER_NAME, messageId],
    );
    expect(failures).toHaveLength(0);

    // O operador reinjeta a mensagem da DLQ depois da queda: ela é processada como nova.
    const redriven = await handler.handle(envelope(messageId, input), {
      receiveCount: 1,
    });
    expect(redriven).toMatchObject({ action: 'ACK', outcome: 'PROCESSED' });
    expect(await s.balanceOf(wallet)).toBe('75.00');
  });

  test('outage during the first 5 deliveries, a bug on the last 5: DLQ, NO FAILED row', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const sw = new Switch();
    const handler = consumerWith(
      sw,
      () => new ConcurrentWalletUpdateError(wallet.id, 1),
    );
    const messageId = `msg-mixed-${uuid()}`;
    let last;
    for (let n = 1; n <= MAX; n++) {
      sw.down = n <= 5;
      last = await handler.handle(envelope(messageId, input), {
        receiveCount: n,
      });
    }
    expect(last).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'RETRIES_EXHAUSTED',
    });
    expect(await rowsOf(s.keyOf(input))).toHaveLength(0);
  });

  test('the same bug on all 10 deliveries, database up: FAILED is recorded, with its inbox row', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const handler = consumerWith(
      new Switch(),
      () => new ConcurrentWalletUpdateError(wallet.id, 1),
    );
    const messageId = `msg-bug-${uuid()}`;
    let last;
    for (let n = 1; n <= MAX; n++) {
      last = await handler.handle(envelope(messageId, input), {
        receiveCount: n,
      });
    }
    expect(last).toMatchObject({ action: 'ACK', outcome: 'FAILED' });
    const [row] = await rowsOf(s.keyOf(input));
    expect(row).toMatchObject({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
    });
    const inbox = await s.sql(
      'SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [WAGER_CONSUMER_NAME, messageId],
    );
    expect(inbox).toHaveLength(1);
    expect(await s.balanceOf(wallet)).toBe('100.00');
  });
});
