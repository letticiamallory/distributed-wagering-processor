import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { InvalidIntegrationEventError } from '../../../src/domain/messaging/messaging.errors.js';
import { IntegrationEvent } from '../../../src/domain/messaging/events/integration-event.js';
import { WagerTransactionPendingReference } from '../../../src/domain/messaging/events/wager-transaction-pending-reference.js';
import { WagerTransactionProcessed } from '../../../src/domain/messaging/events/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../../../src/domain/messaging/events/wager-transaction-rejected.js';
import { WalletBalanceChanged } from '../../../src/domain/messaging/events/wallet-balance-changed.js';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../src/domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-25T12:00:00.000Z');
const t1 = new Date('2026-11-25T12:00:05.000Z');
const t2 = new Date('2026-11-25T12:01:00.000Z');
const ctx = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'cause-1',
  occurredAt: t2,
};

function txProps(kind = WagerTransactionKind.Bet, amount = '25.00') {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    referenceExternalTransactionId:
      kind === WagerTransactionKind.Refund ? 'ext-bet' : undefined,
    correlationId: 'corr-1',
    createdAt: t0,
  };
}

function tx(kind = WagerTransactionKind.Bet, amount = '25.00') {
  return WagerTransaction.create(txProps(kind, amount));
}

function wallet() {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    opening: { transactionId: 'open-1', entryId: 'entry-0' },
    at: t0,
  }).wallet;
}

// Nenhuma instância de Money (nem de qualquer classe) pode estar dentro do data.
function expectPlainJson(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    expect(['string', 'number', 'boolean', 'undefined']).toContain(
      typeof value,
    );
    return;
  }
  expect(value).not.toBeInstanceOf(Money);
  expect(value).not.toBeInstanceOf(Date);
  const proto = Object.getPrototypeOf(value) as object;
  expect([Object.prototype, Array.prototype]).toContain(proto);
  for (const inner of Object.values(value)) {
    expectPlainJson(inner);
  }
}

describe('IntegrationEvent envelope', () => {
  const processed = () => {
    const t = tx();
    t.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    return WagerTransactionProcessed.from(t, ctx);
  };

  test('toJSON serializes the envelope with ISO dates', () => {
    const json = processed().toJSON();
    expect(json.eventId).toBe('evt-1');
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe('wallet-1');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.occurredAt).toBe('2026-11-25T12:01:00.000Z');
    expect(json.version).toBe(1);
    expect(Object.keys(json).sort()).toEqual([
      'aggregateId',
      'causationId',
      'correlationId',
      'data',
      'eventId',
      'eventType',
      'occurredAt',
      'version',
    ]);
  });

  test('without causationId the key is absent, not undefined', () => {
    const t = tx();
    t.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    const e = WagerTransactionProcessed.from(t, {
      eventId: 'e',
      correlationId: 'c',
      occurredAt: t2,
    });
    expect('causationId' in e.toJSON()).toBe(false);
  });

  test('survives a JSON round trip unchanged', () => {
    const json = processed().toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('the data is frozen, at every level', () => {
    const e = processed();
    expect(Object.isFrozen(e.data)).toBe(true);
    expect(Object.isFrozen(e.data.money)).toBe(true);
    expect(Object.isFrozen(e.data.balanceAfter)).toBe(true);
  });

  test.each([
    ['eventId', { eventId: ' ' }],
    ['correlationId', { correlationId: '' }],
    ['occurredAt', { occurredAt: new Date('nope') }],
  ])('refuses an invalid %s', (_label, overrides) => {
    const t = tx();
    t.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    expect(() =>
      WagerTransactionProcessed.from(t, { ...ctx, ...overrides }),
    ).toThrow(InvalidIntegrationEventError);
  });

  test('every event is an IntegrationEvent', () => {
    expect(processed()).toBeInstanceOf(IntegrationEvent);
  });
});

describe('WagerTransactionProcessed', () => {
  test('carries the applied transaction with money as MoneyProps', () => {
    const t = tx();
    t.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    const e = WagerTransactionProcessed.from(t, ctx);
    expect(e.eventType).toBe('WagerTransactionProcessed');
    expect(e.version).toBe(1);
    expect(e.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      processedAt: '2026-11-25T12:00:05.000Z',
    });
    expectPlainJson(e.data);
  });

  test('a LOSS is also a processed transaction', () => {
    const t = tx(WagerTransactionKind.Loss, '0.00');
    t.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    expect(WagerTransactionProcessed.from(t, ctx).data.kind).toBe('LOSS');
  });

  test.each(['pending', 'rejected'])(
    'refuses a transaction that is %s',
    (state) => {
      const t = tx();
      if (state === 'rejected') {
        t.reject(FailureCode.InsufficientFunds, brl('10.00'));
      }
      expect(() => WagerTransactionProcessed.from(t, ctx)).toThrow(
        InvalidIntegrationEventError,
      );
    },
  );
});

describe('WagerTransactionRejected', () => {
  test('carries the failure code and the observed balance', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, brl('10.00'));
    const e = WagerTransactionRejected.from(t, ctx);
    expect(e.eventType).toBe('WagerTransactionRejected');
    expect(e.version).toBe(1);
    expect(e.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(e.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(e.data.balanceAfter).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(e.data.transactionId).toBe('tx-1');
    expectPlainJson(e.data);
  });

  test('refuses a transaction that was not rejected', () => {
    expect(() => WagerTransactionRejected.from(tx(), ctx)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  test('says what is missing and when we look again', () => {
    const t = tx(WagerTransactionKind.Refund);
    t.markPendingReference(t2);
    const e = WagerTransactionPendingReference.from(t, ctx);
    expect(e.eventType).toBe('WagerTransactionPendingReference');
    expect(e.version).toBe(1);
    expect(e.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-bet',
      attempts: 1,
      nextAttemptAt: '2026-11-25T12:01:00.000Z',
    });
    expectPlainJson(e.data);
  });

  test('refuses a transaction that is not waiting for a reference', () => {
    expect(() =>
      WagerTransactionPendingReference.from(
        tx(WagerTransactionKind.Refund),
        ctx,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe('WalletBalanceChanged', () => {
  function debited() {
    const w = wallet();
    const entry = w.debit({
      money: brl('25.00'),
      transactionId: 'tx-1',
      entryId: 'entry-1',
      at: t1,
    });
    return { w, entry };
  }

  test('carries the walletVersion and every amount as MoneyProps', () => {
    const { w, entry } = debited();
    const e = WalletBalanceChanged.from(w, entry, ctx);
    expect(e.eventType).toBe('WalletBalanceChanged');
    expect(e.version).toBe(1);
    expect(e.aggregateId).toBe('wallet-1');
    expect(e.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(e.data.direction).toBe(LedgerDirection.Debit);
    expectPlainJson(e.data);
  });

  test('walletVersion follows the wallet: the third movement is version 4', () => {
    const w = wallet();
    w.debit({
      money: brl('1.00'),
      transactionId: 't-a',
      entryId: 'e-a',
      at: t1,
    });
    w.credit({
      money: brl('2.00'),
      transactionId: 't-b',
      entryId: 'e-b',
      at: t1,
    });
    const entry = w.credit({
      money: brl('3.00'),
      transactionId: 't-c',
      entryId: 'e-c',
      at: t1,
    });
    expect(WalletBalanceChanged.from(w, entry, ctx).data.walletVersion).toBe(4);
  });

  test('a credit says CREDIT', () => {
    const w = wallet();
    const entry = w.credit({
      money: brl('5.00'),
      transactionId: 't',
      entryId: 'e',
      at: t1,
    });
    expect(WalletBalanceChanged.from(w, entry, ctx).data.direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test('refuses an entry from another wallet', () => {
    const { entry } = debited();
    const other = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      at: t0,
    }).wallet;
    expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('eventType and version are part of the type', () => {
  test('literal types, so a wrong string does not compile', () => {
    const { w, entry } = (() => {
      const wl = wallet();
      return {
        w: wl,
        entry: wl.debit({
          money: brl('1.00'),
          transactionId: 't',
          entryId: 'e',
          at: t1,
        }),
      };
    })();
    const e = WalletBalanceChanged.from(w, entry, ctx);
    const type: 'WalletBalanceChanged' = e.eventType;
    const version: 1 = e.version;
    expect([type, version]).toEqual(['WalletBalanceChanged', 1]);
  });

  test('the four events have distinct eventTypes', () => {
    expect(
      new Set([
        'WagerTransactionProcessed',
        'WagerTransactionRejected',
        'WalletBalanceChanged',
        'WagerTransactionPendingReference',
      ]).size,
    ).toBe(4);
  });
});

// O status é uma invariante visível do evento: mesmo que o resto do estado pareça certo
// (dados que sobraram de uma leitura inconsistente), só o status certo gera o evento.
describe('events check the status on its own, not only the leftovers', () => {
  const inconsistent = (
    status: WagerTransactionStatus,
    kind = WagerTransactionKind.Refund,
  ) =>
    WagerTransaction.rehydrate({
      ...txProps(kind),
      status,
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: brl('10.00'),
      processedAt: t1,
      nextAttemptAt: t2,
      attempts: 1,
    });

  test('Processed refuses a REJECTED transaction that has a processedAt', () => {
    expect(() =>
      WagerTransactionProcessed.from(
        inconsistent(WagerTransactionStatus.Rejected),
        ctx,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });

  test('Rejected refuses a PROCESSED transaction that has a failureCode', () => {
    expect(() =>
      WagerTransactionRejected.from(
        inconsistent(WagerTransactionStatus.Processed),
        ctx,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });

  test('PendingReference refuses a PROCESSED transaction that has a nextAttemptAt', () => {
    expect(() =>
      WagerTransactionPendingReference.from(
        inconsistent(WagerTransactionStatus.Processed),
        ctx,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});
