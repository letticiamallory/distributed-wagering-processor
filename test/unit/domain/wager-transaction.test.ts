import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction.js';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/wager/wager-transaction.errors.js';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../src/domain/wager/wager-transaction-status.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wager/wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const t0 = new Date('2026-11-25T12:00:00.000Z');
const t1 = new Date('2026-11-25T12:00:05.000Z');
const t2 = new Date('2026-11-25T12:01:00.000Z');
const HASH = 'a'.repeat(64);

const K = WagerTransactionKind;
const S = WagerTransactionStatus;

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: K.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
    createdAt: t0,
    ...overrides,
  };
}

const make = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

const reversal = (kind: WagerTransactionKind = K.Refund) =>
  make({ kind, referenceExternalTransactionId: 'ext-bet' });

describe('the schema and the domain speak the same strings', () => {
  test('kinds and statuses match the CHECKs of wager_transactions', () => {
    expect(Object.values(K).map(String)).toEqual([
      'OPENING',
      'BET',
      'WIN',
      'LOSS',
      'REFUND',
      'ROLLBACK',
    ]);
    expect(Object.values(S).map(String)).toEqual([
      'PENDING',
      'PENDING_REFERENCE',
      'PROCESSED',
      'REJECTED',
      'FAILED',
    ]);
  });
});

describe('WagerTransaction.create', () => {
  test('is born PENDING, with no attempts and nothing resolved yet', () => {
    const tx = make();
    expect(tx.status).toBe(S.Pending);
    expect(tx.kind).toBe(K.Bet);
    expect(tx.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(tx.attempts).toBe(0);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test('refuses OPENING from outside (only createOpening may build it)', () => {
    expect(() => make({ kind: K.Opening })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('refuses a kind that does not exist', () => {
    expect(() => make({ kind: 'GIFT' as WagerTransactionKind })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([K.Refund, K.Rollback])(
    'a %s without a reference is refused',
    (kind) => {
      expect(() => make({ kind })).toThrow(InvalidWagerTransactionError);
      expect(() => make({ kind, referenceExternalTransactionId: '' })).toThrow(
        InvalidWagerTransactionError,
      );
    },
  );

  test('a WIN may carry a reference to its BET, and a BET does not need one', () => {
    expect(
      make({ kind: K.Win, referenceExternalTransactionId: 'ext-bet' })
        .referenceExternalTransactionId,
    ).toBe('ext-bet');
    expect(make().referenceExternalTransactionId).toBeUndefined();
  });

  test('amount 0 is allowed only for WIN and LOSS', () => {
    expect(() => make({ kind: K.Win, money: brl('0.00') })).not.toThrow();
    expect(() => make({ kind: K.Loss, money: brl('0.00') })).not.toThrow();
    expect(() => make({ kind: K.Bet, money: brl('0.00') })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      make({
        kind: K.Refund,
        money: brl('0.00'),
        referenceExternalTransactionId: 'ext-bet',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('a negative amount is refused', () => {
    expect(() => make({ kind: K.Win, money: brl('1.00').negate() })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'correlationId',
  ] as const)('an empty %s is refused', (field) => {
    expect(() => make({ [field]: '' })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ [field]: '   ' })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each(['', 'abc', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])(
    'payloadHash %p is not a lowercase SHA-256 hex',
    (payloadHash) => {
      expect(() => make({ payloadHash })).toThrow(InvalidWagerTransactionError);
    },
  );
});

describe('WagerTransaction.createOpening', () => {
  const opening = () =>
    WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: HASH,
      correlationId: 'corr-open',
      createdAt: t0,
    });

  test('is internal, already PROCESSED, and credits the initial balance', () => {
    const tx = opening();
    expect(tx.kind).toBe(K.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.externalTransactionId).toBe('wallet-1');
    expect(tx.idempotencyKey).toBe('internal:opening:wallet-1');
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toEqual(t0);
    expect(tx.balanceAfter?.toJSON().amount).toBe('1000.00');
    expect(tx.isTerminal()).toBe(true);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('an opening of zero is refused (a zero balance opens with no transaction)', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('0.00'),
        payloadHash: HASH,
        correlationId: 'corr-open',
        createdAt: t0,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('transitions from PENDING', () => {
  test('-> PROCESSED records when, the observed balance and the reference', () => {
    const tx = reversal();
    tx.markProcessed({
      referenceTransactionId: 'tx-bet',
      balanceAfter: brl('125.00'),
      at: t1,
    });
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toEqual(t1);
    expect(tx.balanceAfter?.toJSON().amount).toBe('125.00');
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.isTerminal()).toBe(true);
  });

  test('a BET becomes PROCESSED without a reference', () => {
    const tx = make();
    tx.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test('a REFUND or ROLLBACK cannot be PROCESSED without knowing what it reverses', () => {
    for (const kind of [K.Refund, K.Rollback]) {
      const tx = reversal(kind);
      expect(() =>
        tx.markProcessed({ balanceAfter: brl('100.00'), at: t1 }),
      ).toThrow(InvalidWagerTransactionError);
      expect(tx.status).toBe(S.Pending);
    }
  });

  // balance_after é SEMPRE o saldo da wallet, na moeda da wallet (ADR-0006). A transação não
  // conhece a moeda da wallet: quando o provedor manda outra moeda (CURRENCY_MISMATCH), as duas
  // diferem, e isso é normal. O único limite do domínio é que o saldo não seja negativo.
  test('the observed balance is the WALLET balance: it may be in another currency than the transaction', () => {
    const processed = make({ money: usd('10.00') });
    processed.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
    expect(processed.balanceAfter?.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });

    const rejected = make({ money: usd('10.00') });
    rejected.reject(FailureCode.CurrencyMismatch, brl('75.00'));
    expect(rejected.balanceAfter?.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(rejected.money.currency).toBe('USD'); // o que o provedor mandou continua como veio
  });

  test('the observed balance cannot be negative, in any currency', () => {
    const tx = make();
    expect(() =>
      tx.markProcessed({ balanceAfter: brl('1.00').negate(), at: t1 }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      tx.reject(FailureCode.InsufficientFunds, usd('1.00').negate()),
    ).toThrow(InvalidWagerTransactionError);
    expect(tx.status).toBe(S.Pending);
  });

  test('-> REJECTED keeps the code and the observed balance, and has no processedAt', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'));
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toJSON().amount).toBe('10.00');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('-> FAILED keeps the code', () => {
    const tx = make();
    tx.fail(FailureCode.DependencyUnavailable);
    expect(tx.status).toBe(S.Failed);
    expect(tx.failureCode).toBe(FailureCode.DependencyUnavailable);
    expect(tx.isTerminal()).toBe(true);
  });

  test('-> PENDING_REFERENCE counts the attempt and schedules the next one', () => {
    const tx = reversal();
    tx.markPendingReference(t2);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(t2);
    expect(tx.isTerminal()).toBe(false);
  });
});

describe('transitions from PENDING_REFERENCE', () => {
  const waiting = () => {
    const tx = reversal();
    tx.markPendingReference(t1);
    return tx;
  };

  test('another failed attempt stays in PENDING_REFERENCE with attempts + 1', () => {
    const tx = waiting();
    tx.markPendingReference(t2);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt).toEqual(t2);
  });

  test('can become PROCESSED, and the schedule is cleared', () => {
    const tx = waiting();
    tx.markProcessed({
      referenceTransactionId: 'tx-bet',
      balanceAfter: brl('125.00'),
      at: t2,
    });
    expect(tx.status).toBe(S.Processed);
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.attempts).toBe(1);
  });

  test('can become REJECTED (attempts exhausted) or FAILED', () => {
    const rejected = waiting();
    rejected.reject(FailureCode.ReferenceNotFound, brl('100.00'));
    expect(rejected.status).toBe(S.Rejected);
    expect(rejected.nextAttemptAt).toBeUndefined();

    const failed = waiting();
    failed.fail(FailureCode.DependencyUnavailable);
    expect(failed.status).toBe(S.Failed);
    expect(failed.nextAttemptAt).toBeUndefined();
  });
});

describe('terminal states never change', () => {
  const terminal = {
    PROCESSED: () => {
      const tx = make();
      tx.markProcessed({ balanceAfter: brl('75.00'), at: t1 });
      return tx;
    },
    REJECTED: () => {
      const tx = make();
      tx.reject(FailureCode.InsufficientFunds, brl('10.00'));
      return tx;
    },
    FAILED: () => {
      const tx = make();
      tx.fail(FailureCode.DependencyUnavailable);
      return tx;
    },
  };
  const attempts: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) =>
      tx.markProcessed({ balanceAfter: brl('1.00'), at: t2 }),
    reject: (tx) => tx.reject(FailureCode.InsufficientFunds, brl('1.00')),
    fail: (tx) => tx.fail(FailureCode.DependencyUnavailable),
    markPendingReference: (tx) => tx.markPendingReference(t2),
  };

  for (const [stateName, build] of Object.entries(terminal)) {
    for (const [transition, run] of Object.entries(attempts)) {
      test(`${stateName} -> ${transition} throws InvalidTransactionStateError and changes nothing`, () => {
        const tx = build();
        const before = {
          status: tx.status,
          code: tx.failureCode,
          attempts: tx.attempts,
          processedAt: tx.processedAt,
          balance: tx.balanceAfter?.toJSON().amount,
        };
        expect(() => run(tx)).toThrow(InvalidTransactionStateError);
        expect({
          status: tx.status,
          code: tx.failureCode,
          attempts: tx.attempts,
          processedAt: tx.processedAt,
          balance: tx.balanceAfter?.toJSON().amount,
        }).toEqual(before);
      });
    }
  }

  test('the error names the states involved', () => {
    const tx = terminal.PROCESSED();
    expect(() => tx.fail(FailureCode.DependencyUnavailable)).toThrow(
      /PROCESSED.*FAILED/,
    );
  });
});

describe('queries', () => {
  test('affectsBalance is false for LOSS and for a WIN of zero', () => {
    expect(make().affectsBalance()).toBe(true);
    expect(make({ kind: K.Win }).affectsBalance()).toBe(true);
    expect(make({ kind: K.Win, money: brl('0.00') }).affectsBalance()).toBe(
      false,
    );
    expect(make({ kind: K.Loss }).affectsBalance()).toBe(false);
    expect(make({ kind: K.Loss, money: brl('0.00') }).affectsBalance()).toBe(
      false,
    );
    expect(reversal(K.Refund).affectsBalance()).toBe(true);
    expect(reversal(K.Rollback).affectsBalance()).toBe(true);
  });

  test('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(reversal(K.Refund).requiresReference()).toBe(true);
    expect(reversal(K.Rollback).requiresReference()).toBe(true);
    for (const kind of [K.Bet, K.Win, K.Loss]) {
      expect(make({ kind }).requiresReference()).toBe(false);
    }
  });

  test('matchesPayload compares the hash', () => {
    const tx = make();
    expect(tx.matchesPayload(HASH)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  test('BET debits; WIN and REFUND credit', () => {
    expect(make().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: K.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(reversal(K.Refund).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test('ROLLBACK is the opposite of its reference', () => {
    const rollback = reversal(K.Rollback);
    expect(rollback.ledgerDirectionFor(make())).toBe(LedgerDirection.Credit); // BET debitou
    expect(rollback.ledgerDirectionFor(make({ kind: K.Win }))).toBe(
      LedgerDirection.Debit,
    ); // WIN creditou
    expect(rollback.ledgerDirectionFor(reversal(K.Refund))).toBe(
      LedgerDirection.Debit,
    ); // REFUND creditou
  });

  test('ROLLBACK needs a reference that moved the balance', () => {
    const rollback = reversal(K.Rollback);
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => rollback.ledgerDirectionFor(make({ kind: K.Loss }))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      rollback.ledgerDirectionFor(make({ kind: K.Win, money: brl('0.00') })),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('a transaction that does not move the balance has no direction', () => {
    expect(() => make({ kind: K.Loss }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      make({ kind: K.Win, money: brl('0.00') }).ledgerDirectionFor(),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('rebuilds persisted state without judging it, but terminal states still lock', () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: K.Refund }), // sem referência: create() recusaria
      status: S.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: t1,
      balanceAfter: brl('125.00'),
      attempts: 3,
      nextAttemptAt: undefined,
    });
    expect(tx.status).toBe(S.Processed);
    expect(tx.attempts).toBe(3);
    expect(tx.balanceAfter?.toJSON().amount).toBe('125.00');
    expect(() => tx.fail(FailureCode.DependencyUnavailable)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
