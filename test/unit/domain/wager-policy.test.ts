import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';
import {
  WagerPolicy,
  type PolicyDecision,
  type PolicyInput,
} from '../../../src/domain/wager/wager-policy.js';
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
const HASH = 'a'.repeat(64);
const K = WagerTransactionKind;
const F = FailureCode;

function walletWith(balance: string, playerId = 'player-1'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId,
    initialBalance: brl(balance),
    opening: { transactionId: 'open-1', entryId: 'entry-0' },
    at: t0,
  }).wallet;
}

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

// Transação que já está PROCESSED no banco (as referências nos testes).
function processed(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const tx = make({
    id: 'ref-1',
    externalTransactionId: 'ext-ref',
    ...overrides,
  });
  tx.markProcessed({
    referenceTransactionId: tx.requiresReference() ? 'ref-0' : undefined,
    balanceAfter: Money.from({ amount: '75.00', currency: tx.money.currency }),
    at: t1,
  });
  return tx;
}

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  processed({ kind: K.Bet, ...overrides });

// Um REFUND/ROLLBACK/WIN que aponta para 'ext-ref'.
const pointing = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
) =>
  make({
    id: 'tx-2',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'provider-a:ext-2',
    kind,
    referenceExternalTransactionId: 'ext-ref',
    ...overrides,
  });

function decide(
  input: Partial<PolicyInput> & { transaction: WagerTransaction },
) {
  return WagerPolicy.decide({
    wallet: walletWith('100.00'),
    reference: undefined,
    alreadyReversed: false,
    hasSettledWin: false,
    attemptsExhausted: false,
    ...input,
  });
}

const apply = (direction: LedgerDirection | null): PolicyDecision => ({
  type: 'apply',
  direction,
});
const reject = (code: FailureCode): PolicyDecision => ({
  type: 'reject',
  code,
});
const wait: PolicyDecision = { type: 'waitForReference' };

describe('WagerPolicy: transactions without a reference', () => {
  test('BET with enough balance debits', () => {
    expect(decide({ transaction: make() })).toEqual(
      apply(LedgerDirection.Debit),
    );
  });

  test('BET for exactly the whole balance is allowed', () => {
    const d = decide({
      transaction: make({ money: brl('100.00') }),
      wallet: walletWith('100.00'),
    });
    expect(d).toEqual(apply(LedgerDirection.Debit));
  });

  test('BET above the balance is INSUFFICIENT_FUNDS', () => {
    const d = decide({ transaction: make({ money: brl('100.01') }) });
    expect(d).toEqual(reject(F.InsufficientFunds));
  });

  test('WIN without a reference credits', () => {
    const d = decide({
      transaction: make({ kind: K.Win, money: brl('80.00') }),
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });

  test('WIN of 0.00 is applied without moving the balance', () => {
    const d = decide({
      transaction: make({ kind: K.Win, money: brl('0.00') }),
    });
    expect(d).toEqual(apply(null));
  });

  test('LOSS is applied without moving the balance', () => {
    const d = decide({
      transaction: make({ kind: K.Loss, money: brl('0.00') }),
    });
    expect(d).toEqual(apply(null));
  });

  test('LOSS never fails for lack of balance', () => {
    const d = decide({
      transaction: make({ kind: K.Loss, money: brl('999.00') }),
    });
    expect(d).toEqual(apply(null));
  });
});

describe('WagerPolicy rule 1: currency', () => {
  test('a transaction in another currency is CURRENCY_MISMATCH', () => {
    const d = decide({ transaction: make({ money: usd('10.00') }) });
    expect(d).toEqual(reject(F.CurrencyMismatch));
  });

  test('currency is checked before the owner', () => {
    const d = decide({
      transaction: make({ money: usd('10.00'), playerId: 'player-2' }),
    });
    expect(d).toEqual(reject(F.CurrencyMismatch));
  });
});

describe('WagerPolicy rule 2: owner of the wallet', () => {
  test('a transaction of another player is WALLET_PLAYER_MISMATCH', () => {
    const d = decide({ transaction: make({ playerId: 'player-2' }) });
    expect(d).toEqual(reject(F.WalletPlayerMismatch));
  });

  test('the owner is checked before the reference is looked up', () => {
    const d = decide({
      transaction: pointing(K.Refund, { playerId: 'player-2' }),
    });
    expect(d).toEqual(reject(F.WalletPlayerMismatch));
  });
});

describe('WagerPolicy rule 3: the reference does not exist (yet)', () => {
  test.each([K.Refund, K.Rollback])(
    '%s without the reference waits while there are attempts left',
    (kind) => {
      expect(decide({ transaction: pointing(kind) })).toEqual(wait);
    },
  );

  test.each([K.Refund, K.Rollback])(
    '%s without the reference is REFERENCE_NOT_FOUND when attempts are exhausted',
    (kind) => {
      const d = decide({
        transaction: pointing(kind),
        attemptsExhausted: true,
      });
      expect(d).toEqual(reject(F.ReferenceNotFound));
    },
  );

  test('a WIN that declares a reference follows the same path', () => {
    expect(decide({ transaction: pointing(K.Win) })).toEqual(wait);
    expect(
      decide({ transaction: pointing(K.Win), attemptsExhausted: true }),
    ).toEqual(reject(F.ReferenceNotFound));
  });

  test('a reference that is there ignores attemptsExhausted', () => {
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      attemptsExhausted: true,
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('WagerPolicy rule 4: the reference belongs to someone else', () => {
  test.each([
    ['another player', { playerId: 'player-2' }],
    ['another wallet', { walletId: 'wallet-2' }],
    ['another currency', { money: usd('25.00') }],
    ['another round', { roundId: 'round-9' }],
  ])('a reference from %s is REFERENCE_MISMATCH', (_label, overrides) => {
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(overrides),
    });
    expect(d).toEqual(reject(F.ReferenceMismatch));
  });

  test('the mismatch is reported before the reference state', () => {
    const ref = make({ id: 'ref-x', roundId: 'round-9' });
    ref.reject(F.InsufficientFunds, brl('10.00'));
    const d = decide({ transaction: pointing(K.Refund), reference: ref });
    expect(d).toEqual(reject(F.ReferenceMismatch));
  });
});

describe('WagerPolicy rule 5: state of the reference', () => {
  test('a reference still in PENDING_REFERENCE waits', () => {
    const ref = pointing(K.Refund, {
      id: 'ref-1',
      externalTransactionId: 'ext-ref',
    });
    ref.markPendingReference(t1);
    const d = decide({ transaction: pointing(K.Rollback), reference: ref });
    expect(d).toEqual(wait);
  });

  test('a reference still in PENDING_REFERENCE is REFERENCE_NOT_PROCESSED once the attempts are exhausted', () => {
    const ref = pointing(K.Refund, {
      id: 'ref-1',
      externalTransactionId: 'ext-ref',
    });
    ref.markPendingReference(t1);
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: ref,
      attemptsExhausted: true,
    });
    expect(d).toEqual(reject(F.ReferenceNotProcessed));
  });

  test('a reference REJECTED is REFERENCE_NOT_PROCESSED', () => {
    const ref = make({ id: 'ref-1', externalTransactionId: 'ext-ref' });
    ref.reject(F.InsufficientFunds, brl('10.00'));
    const d = decide({ transaction: pointing(K.Refund), reference: ref });
    expect(d).toEqual(reject(F.ReferenceNotProcessed));
  });

  test('a reference FAILED is REFERENCE_NOT_PROCESSED', () => {
    const ref = make({ id: 'ref-1', externalTransactionId: 'ext-ref' });
    ref.fail(F.DependencyUnavailable);
    const d = decide({ transaction: pointing(K.Refund), reference: ref });
    expect(d).toEqual(reject(F.ReferenceNotProcessed));
  });

  test('waiting is decided before the kind is checked', () => {
    const ref = pointing(K.Refund, {
      id: 'ref-1',
      externalTransactionId: 'ext-ref',
    });
    ref.markPendingReference(t1);
    // ROLLBACK de ROLLBACK seria tipo inválido, mas ainda não sabemos o que a ref virou.
    const d = decide({ transaction: pointing(K.Refund), reference: ref });
    expect(d).toEqual(wait);
  });
});

describe('WagerPolicy rule 6: kind of the reference', () => {
  test('REFUND of a BET is allowed', () => {
    const d = decide({ transaction: pointing(K.Refund), reference: bet() });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });

  test.each([K.Win, K.Loss, K.Refund, K.Rollback])(
    'REFUND of a %s is REFERENCE_KIND_NOT_ALLOWED',
    (kind) => {
      const ref = processedOfKind(kind);
      const d = decide({ transaction: pointing(K.Refund), reference: ref });
      expect(d).toEqual(reject(F.ReferenceKindNotAllowed));
    },
  );

  test.each([K.Bet, K.Win, K.Refund])(
    'ROLLBACK of a %s passes this rule',
    (kind) => {
      const ref = processedOfKind(kind);
      const d = decide({
        transaction: pointing(K.Rollback, { money: ref.money }),
        reference: ref,
      });
      expect(d.type).toBe('apply');
    },
  );

  test.each([K.Loss, K.Rollback])(
    'ROLLBACK of a %s is REFERENCE_KIND_NOT_ALLOWED',
    (kind) => {
      const ref = processedOfKind(kind);
      // O valor não importa: o tipo é checado antes (regra 6 vem antes da 7).
      const d = decide({
        transaction: pointing(K.Rollback),
        reference: ref,
      });
      expect(d).toEqual(reject(F.ReferenceKindNotAllowed));
    },
  );

  test('WIN of a BET is allowed', () => {
    const d = decide({
      transaction: pointing(K.Win, { money: brl('80.00') }),
      reference: bet(),
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });

  test.each([K.Win, K.Loss, K.Refund, K.Rollback])(
    'WIN of a %s is REFERENCE_KIND_NOT_ALLOWED',
    (kind) => {
      const d = decide({
        transaction: pointing(K.Win, { money: brl('80.00') }),
        reference: processedOfKind(kind),
      });
      expect(d).toEqual(reject(F.ReferenceKindNotAllowed));
    },
  );

  test('LOSS of a BET is allowed and does not move the balance', () => {
    const d = decide({
      transaction: pointing(K.Loss, { money: brl('0.00') }),
      reference: bet(),
    });
    expect(d).toEqual(apply(null));
  });

  test('LOSS of a WIN is REFERENCE_KIND_NOT_ALLOWED', () => {
    const d = decide({
      transaction: pointing(K.Loss, { money: brl('0.00') }),
      reference: processedOfKind(K.Win),
    });
    expect(d).toEqual(reject(F.ReferenceKindNotAllowed));
  });
});

describe('WagerPolicy rule 7: amount', () => {
  test.each([K.Refund, K.Rollback])(
    '%s with a different amount is AMOUNT_MISMATCH',
    (kind) => {
      const d = decide({
        transaction: pointing(kind, { money: brl('24.99') }),
        reference: bet(),
      });
      expect(d).toEqual(reject(F.AmountMismatch));
    },
  );

  test('the amount is compared as money, not as text', () => {
    const d = decide({
      transaction: pointing(K.Refund, { money: brl('25.00') }),
      reference: bet({ money: brl('25.00') }),
    });
    expect(d.type).toBe('apply');
  });

  test('a WIN pays more than the bet and that is fine', () => {
    const d = decide({
      transaction: pointing(K.Win, { money: brl('500.00') }),
      reference: bet(),
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('WagerPolicy rule 8: reference already reversed', () => {
  test('REFUND of a reversed BET is REFERENCE_ALREADY_REVERSED', () => {
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('ROLLBACK of a reversed BET is REFERENCE_ALREADY_REVERSED', () => {
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('WIN on a BET that was already refunded is REFERENCE_ALREADY_REVERSED', () => {
    const d = decide({
      transaction: pointing(K.Win, { money: brl('80.00') }),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('LOSS on a BET that was already refunded is REFERENCE_ALREADY_REVERSED', () => {
    const d = decide({
      transaction: pointing(K.Loss, { money: brl('0.00') }),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('the amount is checked before "already reversed"', () => {
    const d = decide({
      transaction: pointing(K.Refund, { money: brl('1.00') }),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.AmountMismatch));
  });
});

describe('WagerPolicy rule 8b: REFERENCE_SETTLED', () => {
  test.each([K.Refund, K.Rollback])(
    '%s of a BET that has a settled WIN is REFERENCE_SETTLED',
    (kind) => {
      const d = decide({
        transaction: pointing(kind),
        reference: bet(),
        hasSettledWin: true,
      });
      expect(d).toEqual(reject(F.ReferenceSettled));
    },
  );

  test('"already reversed" wins over "settled"', () => {
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      alreadyReversed: true,
      hasSettledWin: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('"settled" is decided before the balance check', () => {
    // ROLLBACK de uma BET credita, mas a REFUND de uma BET também: o ponto é a ordem,
    // então usamos uma wallet vazia para provar que o saldo nem é consultado.
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: bet(),
      hasSettledWin: true,
      wallet: walletWith('0.01'),
    });
    expect(d).toEqual(reject(F.ReferenceSettled));
  });

  test('a ROLLBACK of the WIN itself is not blocked by the flag', () => {
    const win = processedOfKind(K.Win);
    const d = decide({
      transaction: pointing(K.Rollback, { money: win.money }),
      reference: win,
      hasSettledWin: true,
    });
    expect(d).toEqual(apply(LedgerDirection.Debit));
  });

  test('a ROLLBACK of a REFUND is not blocked by the flag', () => {
    const refund = processedOfKind(K.Refund);
    const d = decide({
      transaction: pointing(K.Rollback, { money: refund.money }),
      reference: refund,
      hasSettledWin: true,
    });
    expect(d.type).toBe('apply');
  });

  test('a LOSS does not settle the BET (BET + LOSS + REFUND is zero)', () => {
    // O caso de uso só marca hasSettledWin para WIN; sem a flag, o REFUND passa.
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      hasSettledWin: false,
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });

  test('a WIN on the BET is not blocked by the flag', () => {
    const d = decide({
      transaction: pointing(K.Win, { money: brl('80.00') }),
      reference: bet(),
      hasSettledWin: true,
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('WagerPolicy rule 9: debit without balance', () => {
  test('ROLLBACK of a WIN that the wallet can no longer cover is REVERSAL_INSUFFICIENT_FUNDS', () => {
    const win = processedOfKind(K.Win, { money: brl('80.00') });
    const d = decide({
      transaction: pointing(K.Rollback, { money: brl('80.00') }),
      reference: win,
      wallet: walletWith('10.00'),
    });
    expect(d).toEqual(reject(F.ReversalInsufficientFunds));
  });

  test('ROLLBACK of a WIN with enough balance debits', () => {
    const win = processedOfKind(K.Win, { money: brl('80.00') });
    const d = decide({
      transaction: pointing(K.Rollback, { money: brl('80.00') }),
      reference: win,
      wallet: walletWith('80.00'),
    });
    expect(d).toEqual(apply(LedgerDirection.Debit));
  });

  test('ROLLBACK of a BET credits, even with an empty wallet', () => {
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: bet(),
      wallet: walletWith('0.01'),
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });

  test('REFUND credits, even with an empty wallet', () => {
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      wallet: walletWith('0.01'),
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('WagerPolicy: the cases of ADR-0005', () => {
  test('REFUND after a ROLLBACK of the same BET is refused', () => {
    // O caso de uso viu um ROLLBACK PROCESSED apontando para a BET.
    const d = decide({
      transaction: pointing(K.Refund),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('ROLLBACK of a REFUND is allowed (it puts the money back)', () => {
    const refund = processedOfKind(K.Refund);
    const d = decide({
      transaction: pointing(K.Rollback, { money: refund.money }),
      reference: refund,
      alreadyReversed: false,
    });
    // Desfazer um crédito é um débito: o jogador devolve o reembolso.
    expect(d).toEqual(apply(LedgerDirection.Debit));
  });

  test('WIN on a refunded BET is REFERENCE_ALREADY_REVERSED', () => {
    const d = decide({
      transaction: pointing(K.Win, { money: brl('80.00') }),
      reference: bet(),
      alreadyReversed: true,
    });
    expect(d).toEqual(reject(F.ReferenceAlreadyReversed));
  });

  test('ROLLBACK of a BET with a settled WIN is REFERENCE_SETTLED', () => {
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: bet(),
      hasSettledWin: true,
    });
    expect(d).toEqual(reject(F.ReferenceSettled));
  });

  test('ROLLBACK of a BET after the WIN was reverted is allowed', () => {
    // O WIN foi revertido, então o caso de uso calcula hasSettledWin = false.
    const d = decide({
      transaction: pointing(K.Rollback),
      reference: bet(),
      hasSettledWin: false,
    });
    expect(d).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('WagerPolicy: purity', () => {
  test('deciding does not change the wallet or the transactions', () => {
    const wallet = walletWith('100.00');
    const transaction = pointing(K.Refund);
    const reference = bet();
    decide({ wallet, transaction, reference });
    expect(wallet.balance.toString()).toBe('100.00 BRL');
    expect(wallet.version).toBe(1);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(reference.status).toBe(WagerTransactionStatus.Processed);
  });
});

// Referência PROCESSED de um tipo qualquer (usada nos testes do tipo da referência).
function processedOfKind(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const zeroAllowed = kind === K.Win || kind === K.Loss;
  return processed({
    kind,
    money: zeroAllowed && kind === K.Loss ? brl('0.00') : brl('25.00'),
    referenceExternalTransactionId:
      kind === K.Refund || kind === K.Rollback ? 'ext-bet' : undefined,
    ...overrides,
  });
}
