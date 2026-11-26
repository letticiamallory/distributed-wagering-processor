import { describe, expect, test } from 'bun:test';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { rejectionOf } from '../support/assertions.js';
import {
  inTheWindow,
  simultaneously,
  valueOf,
} from '../support/concurrency.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence, uuid } from '../support/persistence.js';
import {
  UnitOfWorkWith,
  createScenario,
  ext,
  type Wallet,
} from '../support/wager-scenarios.js';

const db = usePersistence();
const PENDING = WagerTransactionStatus.PendingReference;

// 10 tentativas, base de 1 s e teto de 5 min: a política do manual, escrita aqui de forma
// explícita para os testes não dependerem do padrão (que ainda é uma decisão).
const SCHEDULE_10 = new PendingReferenceSchedule({
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
});
// Poucas tentativas e teto curto: o limite chega rápido.
const SCHEDULE_3 = new PendingReferenceSchedule({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
});

const s = createScenario(db, { schedule: SCHEDULE_10 });
const iso = (value: unknown) => new Date(String(value)).toISOString();
const inMs = (ms: number) =>
  new Date(s.clock.now().getTime() + ms).toISOString();

const pendingEvents = (transactionId: string) =>
  s.sql(
    `SELECT payload FROM outbox_messages
      WHERE event_type = 'WagerTransactionPendingReference'
        AND payload->'data'->>'transactionId' = ?`,
    [transactionId],
  );

// ---------------------------------------------------------------- 1. a primeira passada

describe('PENDING_REFERENCE: a transaction whose reference does not exist yet (first pass)', () => {
  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const)(
    'a %s is stored as PENDING_REFERENCE (202) and touches neither the balance, the ledger nor the balance event',
    async (kind) => {
      const wallet = await s.walletWith('100.00');
      const at = s.clock.now();

      const pending = await s.pend(wallet, kind, ext('not-here-yet'));

      expect(pending).toMatchObject({
        status: PENDING,
        idempotentReplay: false,
      });
      expect(pending.balance).toBeUndefined();
      expect(pending.failureCode).toBeUndefined();
      expect(await s.txRow(pending.transactionId)).toMatchObject({
        kind,
        status: 'PENDING_REFERENCE',
        attempts: 1,
        failure_code: null,
        balance_after: null,
        processed_at: null,
        reference_transaction_id: null,
        reference_external_transaction_id: ext('not-here-yet'),
      });
      expect(iso((await s.txRow(pending.transactionId)).next_attempt_at)).toBe(
        new Date(at.getTime() + 1_000).toISOString(),
      );
      expect(await s.walletRow(wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
      });
      expect(await s.movements(wallet.id)).toHaveLength(0);
      expect(await s.eventTypesOf(pending.transactionId)).toEqual([
        'WagerTransactionPendingReference',
      ]);
      await assertInvariants(s.sql, wallet.id);
    },
  );

  test('the pending event says how many attempts were made and when the next one is', async () => {
    const wallet = await s.walletWith('100.00');
    const at = s.clock.now();
    const pending = await s.pend(wallet, 'REFUND', ext('not-here-yet'));

    const events = await pendingEvents(pending.transactionId);

    expect(events).toHaveLength(1);
    const payload = (
      events[0] as { payload: { aggregateId: string; data: unknown } }
    ).payload;
    expect(payload.aggregateId).toBe(wallet.id);
    expect(payload.data).toMatchObject({
      kind: 'REFUND',
      referenceExternalTransactionId: ext('not-here-yet'),
      attempts: 1,
      nextAttemptAt: new Date(at.getTime() + 1_000).toISOString(),
    });
  });

  test('the replay answers the same 202, with no new attempt and no new event', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.reversalBody(wallet, 'REFUND', ext('not-here-yet'));
    const first = await s.submit(input);
    s.clock.advance(30_000);

    const replay = await s.submit(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.status).toBe(PENDING);
    expect((await s.txRow(first.transactionId)).attempts).toBe(1);
    expect(await pendingEvents(first.transactionId)).toHaveLength(1);
  });

  test('another key with the same external id is EXTERNAL_ID_CONFLICT even while pending', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.reversalBody(wallet, 'REFUND', ext('not-here-yet'));
    await s.submit(input);
    const error = await rejectionOf(
      s.submit(input, { idempotencyKey: 'another-key' }),
    );
    expect(error).toMatchObject({ code: FailureCode.ExternalIdConflict });
  });

  test('a REFERENCE_MISMATCH is NOT decided now: only when the reference exists', async () => {
    const mine = await s.walletWith('100.00');
    const theirs = await s.walletWith('100.00');

    const pending = await s.pend(
      mine,
      'REFUND',
      ext('of-a-bet-that-will-be-theirs'),
    );
    expect(pending.status).toBe(PENDING); // nem rejeitada, nem erro: ainda não dá para saber

    await s.placeBet(theirs, '25.00', ext('of-a-bet-that-will-be-theirs'));
    const resolved = await s.resolve(pending.transactionId);

    expect(resolved).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('the currency and the owner are decided BEFORE waiting: no pending for a transaction that can never be valid', async () => {
    const wallet = await s.walletWith('100.00', 'BRL');
    const wrongCurrency = await s.submit(
      s.body(wallet, {
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'USD' },
        referenceExternalTransactionId: 'x',
      }),
    );
    expect(wrongCurrency).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
    });

    const wrongOwner = await s.submit(
      s.body(wallet, {
        kind: 'REFUND',
        playerId: uuid(),
        referenceExternalTransactionId: 'y',
      }),
    );
    expect(wrongOwner).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test('when it comes from SQS the message is consumed (inbox row, processed): the worker takes over', async () => {
    const wallet = await s.walletWith('100.00');
    const messageId = `msg-${uuid()}`;
    const pending = await s.submit(
      s.reversalBody(wallet, 'REFUND', ext('not-here-yet')),
      { inbox: { consumerName: 'wager-transactions-consumer', messageId } },
    );
    expect(pending.status).toBe(PENDING);
    const row = await s.one(
      'SELECT processed_at FROM inbox_messages WHERE message_id = ?',
      [messageId],
    );
    expect(row.processed_at).not.toBeNull();
  });

  test('with a limit of ONE attempt, a missing reference is REJECTED REFERENCE_NOT_FOUND right away', async () => {
    const once = createScenario(db, {
      schedule: new PendingReferenceSchedule({ maxAttempts: 1 }),
    });
    const wallet = await once.walletWith('100.00');
    const result = await once.pend(wallet, 'REFUND', ext('not-here-yet'));
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('a pending transaction does not block the wallet: other operations go through', async () => {
    const wallet = await s.walletWith('100.00');
    await s.pend(wallet, 'REFUND', ext('not-here-yet'));
    const bet = await s.placeBet(wallet);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(await s.balanceOf(wallet)).toBe('75.00');
    await assertInvariants(s.sql, wallet.id);
  });
});

// ---------------------------------------------------------------- 2. acordar

describe('PENDING_REFERENCE: waking up when the referenced transaction is PROCESSED', () => {
  const nextAttemptOf = async (transactionId: string) =>
    iso((await s.txRow(transactionId)).next_attempt_at);

  test('a BET that is PROCESSED brings forward the pending transactions waiting for it (to now)', async () => {
    const wallet = await s.walletWith('100.00');
    const pending = await s.pend(wallet, 'REFUND', ext('bet-1'));
    const scheduled = await nextAttemptOf(pending.transactionId); // agora + 1 s
    s.clock.advance(120_000);

    await s.placeBet(wallet, '25.00', ext('bet-1'));

    expect(await nextAttemptOf(pending.transactionId)).toBe(inMs(0)); // exatamente "agora"
    expect(await nextAttemptOf(pending.transactionId)).not.toBe(scheduled);
    // Só o horário muda: o pendente continua pendente, com as mesmas tentativas.
    expect(await s.txRow(pending.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      attempts: 1,
    });
  });

  test('it wakes every kind that was waiting: a WIN, a REFUND and a ROLLBACK', async () => {
    const wallet = await s.walletWith('100.00');
    const waiting = [
      await s.pend(wallet, 'WIN', ext('bet-2')),
      await s.pend(wallet, 'REFUND', ext('bet-2')),
      await s.pend(wallet, 'ROLLBACK', ext('bet-2')),
    ];
    s.clock.advance(60_000);

    await s.placeBet(wallet, '25.00', ext('bet-2'));

    for (const tx of waiting) {
      expect(await nextAttemptOf(tx.transactionId)).toBe(inMs(0));
    }
  });

  test('it happens in the SAME transaction as the BET: if the BET fails, nothing is woken', async () => {
    const wallet = await s.walletWith('100.00');
    const pending = await s.pend(wallet, 'REFUND', ext('bet-3'));
    const scheduled = await nextAttemptOf(pending.transactionId);
    s.clock.advance(120_000);
    const failure = new Error('ledger insert failed');
    const broken = new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      ledger: { append: () => Promise.reject(failure) },
    }));

    const error = await rejectionOf(
      s.submit(
        s.body(wallet, { externalTransactionId: ext('bet-3') }),
        {},
        s.build({ uow: broken }),
      ),
    );

    expect(error).toBe(failure);
    expect(await nextAttemptOf(pending.transactionId)).toBe(scheduled); // nada foi acordado
  });

  test('a processed REFUND wakes the ROLLBACK that was waiting for IT', async () => {
    const wallet = await s.walletWith('100.00');
    const bet = await s.placeBet(wallet); // 75
    const rollback = await s.pend(wallet, 'ROLLBACK', ext('refund-1')); // espera um REFUND que não chegou
    s.clock.advance(60_000);

    await s.submit(
      s.reversalBody(wallet, 'REFUND', bet.external, '25.00', {
        externalTransactionId: ext('refund-1'),
      }),
    );

    expect(await nextAttemptOf(rollback.transactionId)).toBe(inMs(0));
  });

  test('it leaves alone what was NOT waiting for this transaction', async () => {
    const wallet = await s.walletWith('100.00');
    const otherReference = await s.pend(
      wallet,
      'REFUND',
      ext('other-reference'),
    );
    const otherProvider = await s.pend(
      wallet,
      'REFUND',
      ext('bet-4'),
      undefined,
      { providerId: 'provider-b' },
    );
    const rejectedAlready = await s.submit(
      s.body(wallet, {
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'USD' },
        referenceExternalTransactionId: ext('bet-4'),
      }),
    );
    const before = {
      reference: await nextAttemptOf(otherReference.transactionId),
      provider: await nextAttemptOf(otherProvider.transactionId),
    };
    s.clock.advance(120_000);

    await s.placeBet(wallet, '25.00', ext('bet-4'));

    expect(await nextAttemptOf(otherReference.transactionId)).toBe(
      before.reference,
    );
    expect(await nextAttemptOf(otherProvider.transactionId)).toBe(
      before.provider,
    );
    expect(await s.txRow(rejectedAlready.transactionId)).toMatchObject({
      status: 'REJECTED',
      next_attempt_at: null,
    });
  });

  test('it never wakes the pending transactions of ANOTHER wallet (ADR-0007: no write without that wallet lock)', async () => {
    const mine = await s.walletWith('100.00');
    const theirs = await s.walletWith('100.00');
    const theirPending = await s.pend(theirs, 'REFUND', ext('bet-5'));
    const scheduled = await nextAttemptOf(theirPending.transactionId);
    s.clock.advance(120_000);

    await s.placeBet(mine, '25.00', ext('bet-5'));

    expect(await nextAttemptOf(theirPending.transactionId)).toBe(scheduled);
  });

  test('a BET that is REJECTED does not wake anyone (only a PROCESSED transaction can be referenced)', async () => {
    const wallet = await s.walletWith('10.00');
    const pending = await s.pend(wallet, 'REFUND', ext('bet-6'));
    const scheduled = await nextAttemptOf(pending.transactionId);
    s.clock.advance(120_000);

    const bet = await s.placeBet(wallet, '999.00', ext('bet-6'));

    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    expect(await nextAttemptOf(pending.transactionId)).toBe(scheduled);
  });
});

// ---------------------------------------------------------------- 3. resolver um pendente

describe('ResolvePendingReference: the reference arrived', () => {
  test('a REFUND becomes PROCESSED once: credit, ledger, final row and both events', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-10'));
    await s.placeBet(wallet, '25.00', ext('bet-10')); // 75
    s.clock.advance(5_000);

    const result = await s.resolve(refund.transactionId);

    expect(result).toMatchObject({
      outcome: 'RESOLVED',
      transactionId: refund.transactionId,
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await s.txRow(refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      balance_after: '100.00',
      failure_code: null,
      next_attempt_at: null,
      attempts: 1,
    });
    expect(iso((await s.txRow(refund.transactionId)).processed_at)).toBe(
      inMs(0),
    );
    const bet = await s.one(
      'SELECT id FROM wager_transactions WHERE external_transaction_id = ?',
      [ext('bet-10')],
    );
    expect((await s.txRow(refund.transactionId)).reference_transaction_id).toBe(
      bet.id,
    );
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    expect(await s.walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 3,
    });
    expect(await s.eventTypesOf(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertInvariants(s.sql, wallet.id);
  });

  test('a WIN pays, a LOSS moves nothing, a ROLLBACK of a BET credits, a ROLLBACK of a WIN debits', async () => {
    const wallet = await s.walletWith('100.00');
    const win = await s.pend(wallet, 'WIN', ext('bet-11'), '80.00');
    const loss = await s.pend(wallet, 'LOSS', ext('bet-11'), '0.00');
    await s.placeBet(wallet, '25.00', ext('bet-11')); // 75

    expect((await s.resolveFinal(win.transactionId)).balance?.amount).toBe(
      '155.00',
    ); // paga
    expect((await s.resolveFinal(loss.transactionId)).balance?.amount).toBe(
      '155.00',
    ); // não move
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);

    const undoWin = await s.pend(wallet, 'ROLLBACK', win.external, '80.00');
    expect(undoWin.status).toBe(WagerTransactionStatus.Processed); // a referência já existia: não ficou pendente
    expect(await s.balanceOf(wallet)).toBe('75.00');
    await assertInvariants(s.sql, wallet.id);
  });

  test('a ROLLBACK of a BET that was waiting credits it back', async () => {
    const wallet = await s.walletWith('100.00');
    const rollback = await s.pend(wallet, 'ROLLBACK', ext('bet-12'));
    await s.placeBet(wallet, '25.00', ext('bet-12')); // 75
    const result = await s.resolve(rollback.transactionId);
    expect(result).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
  });

  test('the replay of the ORIGINAL request answers the final state, with the balance of the resolution', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.reversalBody(wallet, 'REFUND', ext('bet-13'));
    const first = await s.submit(input);
    expect(first.status).toBe(PENDING);
    await s.placeBet(wallet, '25.00', ext('bet-13'));
    await s.resolve(first.transactionId);
    await s.placeBet(wallet, '10.00'); // o saldo de hoje já é outro

    const replay = await s.submit(input);

    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });
});

describe('ResolvePendingReference: the reference arrived but a business rule says no (REJECTED, once)', () => {
  async function expectRejected(
    pendingId: string,
    wallet: Wallet,
    code: FailureCode,
    expectedBalance: string,
  ) {
    const movementsBefore = (await s.movements(wallet.id)).length;
    const result = await s.resolve(pendingId);
    expect(result).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Rejected,
      failureCode: code,
      balance: { amount: expectedBalance, currency: 'BRL' },
    });
    expect(await s.txRow(pendingId)).toMatchObject({
      status: 'REJECTED',
      failure_code: code,
      balance_after: expectedBalance,
      next_attempt_at: null,
      processed_at: null,
    });
    expect((await s.movements(wallet.id)).length).toBe(movementsBefore);
    expect(await s.balanceOf(wallet)).toBe(expectedBalance);
    expect(await s.eventTypesOf(pendingId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    await assertInvariants(s.sql, wallet.id);
  }

  test('a REFUND whose reference is a WIN: REFERENCE_KIND_NOT_ALLOWED', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('win-20'), '5.00');
    const bet = await s.placeBet(wallet); // 75
    await s.submit(
      s.winBody(wallet, bet.external, '10.00', {
        externalTransactionId: ext('win-20'),
      }),
    ); // 85
    await expectRejected(
      refund.transactionId,
      wallet,
      FailureCode.ReferenceKindNotAllowed,
      '85.00',
    );
  });

  test('a REFUND for another amount than the BET: AMOUNT_MISMATCH', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-21'), '20.00');
    await s.placeBet(wallet, '25.00', ext('bet-21'));
    await expectRejected(
      refund.transactionId,
      wallet,
      FailureCode.AmountMismatch,
      '75.00',
    );
  });

  test('a REFERENCE_MISMATCH: the BET that arrived belongs to another wallet', async () => {
    const mine = await s.walletWith('100.00');
    const theirs = await s.walletWith('100.00');
    const refund = await s.pend(mine, 'REFUND', ext('bet-22'));
    await s.placeBet(theirs, '25.00', ext('bet-22'));
    await expectRejected(
      refund.transactionId,
      mine,
      FailureCode.ReferenceMismatch,
      '100.00',
    );
  });

  test('a REFERENCE_MISMATCH: the BET that arrived is from another round', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-23'), '25.00', {
      roundId: 'round-B',
    });
    await s.submit(
      s.body(wallet, {
        externalTransactionId: ext('bet-23'),
        roundId: 'round-A',
      }),
    );
    await expectRejected(
      refund.transactionId,
      wallet,
      FailureCode.ReferenceMismatch,
      '75.00',
    );
  });

  test('the BET that arrived was REJECTED: REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-24'), '999.00');
    await s.placeBet(wallet, '999.00', ext('bet-24')); // sem saldo: REJECTED
    await expectRejected(
      refund.transactionId,
      wallet,
      FailureCode.ReferenceNotProcessed,
      '100.00',
    );
  });

  test('two reversals were waiting for the same BET: the first wins, the second is REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-25'));
    const rollback = await s.pend(wallet, 'ROLLBACK', ext('bet-25'));
    await s.placeBet(wallet, '25.00', ext('bet-25')); // 75

    expect((await s.resolveFinal(refund.transactionId)).status).toBe(
      WagerTransactionStatus.Processed,
    ); // 100
    await expectRejected(
      rollback.transactionId,
      wallet,
      FailureCode.ReferenceAlreadyReversed,
      '100.00',
    );
  });

  test('the BET got a WIN meanwhile: REFERENCE_SETTLED', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-26'));
    const bet = await s.placeBet(wallet, '25.00', ext('bet-26'));
    await s.submit(s.winBody(wallet, bet.external, '80.00')); // 155
    await expectRejected(
      refund.transactionId,
      wallet,
      FailureCode.ReferenceSettled,
      '155.00',
    );
  });

  test('a ROLLBACK of a WIN the wallet can no longer cover: REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await s.walletWith('100.00');
    const rollback = await s.pend(wallet, 'ROLLBACK', ext('win-27'), '80.00');
    const bet = await s.placeBet(wallet); // 75
    await s.submit(
      s.winBody(wallet, bet.external, '80.00', {
        externalTransactionId: ext('win-27'),
      }),
    ); // 155
    await s.placeBet(wallet, '140.00'); // 15
    await expectRejected(
      rollback.transactionId,
      wallet,
      FailureCode.ReversalInsufficientFunds,
      '15.00',
    );
  });
});

describe('ResolvePendingReference: the reference has not arrived yet', () => {
  test('stays pending: one more attempt, a longer wait each time, nothing else changes', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('never-1'));
    const events = await s.eventTypesOf(refund.transactionId);

    const waits: number[] = [];
    for (let expectedAttempts = 2; expectedAttempts <= 5; expectedAttempts++) {
      s.clock.advance(1_000);
      const before = s.clock.now().getTime();
      const result = await s.resolve(refund.transactionId);
      expect(result).toMatchObject({
        outcome: 'STILL_PENDING',
        transactionId: refund.transactionId,
        attempts: expectedAttempts,
      });
      const next = new Date(
        String((await s.txRow(refund.transactionId)).next_attempt_at),
      ).getTime();
      waits.push(next - before);
    }

    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]); // 2^attempts, dobrando
    expect(await s.txRow(refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      attempts: 5,
    });
    expect(await s.eventTypesOf(refund.transactionId)).toEqual(events); // sem evento novo a cada tentativa
    expect(await s.walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    await assertInvariants(s.sql, wallet.id);
  });

  test('the wait never exceeds the ceiling', async () => {
    const capped = createScenario(db, {
      schedule: new PendingReferenceSchedule({
        maxAttempts: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
      }),
    });
    const wallet = await capped.walletWith('100.00');
    const refund = await capped.pend(wallet, 'REFUND', ext('never-2'));
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      capped.clock.advance(1_000);
      const before = capped.clock.now().getTime();
      await capped.resolve(refund.transactionId);
      waits.push(
        new Date(
          String((await capped.txRow(refund.transactionId)).next_attempt_at),
        ).getTime() - before,
      );
    }
    expect(waits).toEqual([2_000, 3_000, 3_000, 3_000]);
  });

  test('out of attempts with the reference ABSENT: REJECTED REFERENCE_NOT_FOUND, with the Rejected event', async () => {
    const limited = createScenario(db, { schedule: SCHEDULE_3 });
    const wallet = await limited.walletWith('100.00');
    const refund = await limited.pend(wallet, 'REFUND', ext('never-3')); // tentativa 1

    limited.clock.advance(1_000);
    expect((await limited.resolve(refund.transactionId)).outcome).toBe(
      'STILL_PENDING',
    ); // tentativa 2
    limited.clock.advance(2_000);
    const last = await limited.resolve(refund.transactionId); // tentativa 3 = a última

    expect(last).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await limited.txRow(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      balance_after: '100.00',
      next_attempt_at: null,
    });
    expect(await limited.eventTypesOf(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    await assertInvariants(limited.sql, wallet.id);
  });

  test('out of attempts with the reference itself still PENDING: REJECTED REFERENCE_NOT_PROCESSED', async () => {
    const limited = createScenario(db, { schedule: SCHEDULE_3 });
    const wallet = await limited.walletWith('100.00');
    const refund = await limited.pend(wallet, 'REFUND', ext('never-4')); // espera uma BET que nunca chega
    const rollback = await limited.pend(wallet, 'ROLLBACK', refund.external); // espera o REFUND, que está pendente
    expect(rollback.status).toBe(PENDING);

    limited.clock.advance(1_000);
    expect((await limited.resolve(rollback.transactionId)).outcome).toBe(
      'STILL_PENDING',
    ); // referência existe, mas pendente: espera
    limited.clock.advance(2_000);
    const last = await limited.resolve(rollback.transactionId);

    expect(last).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('ResolvePendingReference: it resolves ONCE, under the lock', () => {
  test('a transaction that is already final is not touched again (NOT_PENDING)', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-30'));
    await s.placeBet(wallet, '25.00', ext('bet-30'));
    await s.resolve(refund.transactionId);
    const state = {
      balance: await s.balanceOf(wallet),
      ledger: (await s.movements(wallet.id)).length,
      events: await s.eventTypesOf(refund.transactionId),
    };

    const again = await s.resolve(refund.transactionId);

    expect(again).toMatchObject({
      outcome: 'NOT_PENDING',
      status: WagerTransactionStatus.Processed,
    });
    expect(await s.balanceOf(wallet)).toBe(state.balance);
    expect((await s.movements(wallet.id)).length).toBe(state.ledger);
    expect(await s.eventTypesOf(refund.transactionId)).toEqual(state.events);
  });

  test('a REJECTED one is not touched again either', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-31'), '20.00');
    await s.placeBet(wallet, '25.00', ext('bet-31'));
    await s.resolve(refund.transactionId); // AMOUNT_MISMATCH
    const again = await s.resolve(refund.transactionId);
    expect(again).toMatchObject({
      outcome: 'NOT_PENDING',
      status: WagerTransactionStatus.Rejected,
    });
  });

  test('an id that does not exist is NOT_FOUND (a worker must not blow up on it)', async () => {
    expect(await s.resolve(uuid())).toMatchObject({ outcome: 'NOT_FOUND' });
  });

  test('two workers resolving the same pending transaction at the same time: one resolves, the other finds it done', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-32'));
    await s.placeBet(wallet, '25.00', ext('bet-32')); // 75

    const [a, b] = await simultaneously(
      db().uow,
      (gate) => s.resolve(refund.transactionId, s.resolver({ uow: gate })),
      (gate) => s.resolve(refund.transactionId, s.resolver({ uow: gate })),
    );

    // O dinheiro primeiro: creditado UMA vez.
    expect(await s.balanceOf(wallet)).toBe('100.00');
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    await assertInvariants(s.sql, wallet.id);
    const outcomes = [valueOf(a), valueOf(b)]
      .map((r) => String(r.outcome))
      .sort((x, y) => x.localeCompare(y));
    expect(outcomes).toEqual(['NOT_PENDING', 'RESOLVED']);
  });

  test('the pending transaction is read AGAIN after the lock: a worker that was waiting finds it already resolved', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-33'));
    await s.placeBet(wallet, '25.00', ext('bet-33'));

    const slow = await inTheWindow(
      db().uow,
      (gate) => s.resolve(refund.transactionId, s.resolver({ uow: gate })),
      async () => {
        const fast = await s.resolve(refund.transactionId); // outro worker termina antes
        expect(fast.outcome).toBe('RESOLVED');
      },
    );

    expect(slow.outcome).toBe('NOT_PENDING');
    expect(await s.balanceOf(wallet)).toBe('100.00');
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
  });

  test('a wake-up and a resolution at the same time never credit twice', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-34'));

    const [processing, resolving] = await simultaneously(
      db().uow,
      (gate) =>
        s.submit(
          s.body(wallet, { externalTransactionId: ext('bet-34') }),
          {},
          s.build({ uow: gate }),
        ),
      (gate) => s.resolve(refund.transactionId, s.resolver({ uow: gate })),
    );

    valueOf(processing);
    // Qualquer que seja a ordem, o saldo é coerente com o ledger e o REFUND foi aplicado no máximo uma vez.
    await assertInvariants(s.sql, wallet.id);
    const row = await s.txRow(refund.transactionId);
    expect(['PENDING_REFERENCE', 'PROCESSED']).toContain(String(row.status));
    expect(await s.balanceOf(wallet)).toBe(
      row.status === 'PROCESSED' ? '100.00' : '75.00',
    );
    expect(valueOf(resolving).outcome).toMatch(/STILL_PENDING|RESOLVED/);
  });
});

describe('PENDING_REFERENCE: a whole chain, in the order it arrives', () => {
  test('ROLLBACK waits for a REFUND that waits for a BET: the BET wakes the REFUND, the REFUND wakes the ROLLBACK', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-40')); // espera a BET
    const rollback = await s.pend(wallet, 'ROLLBACK', refund.external); // espera o REFUND
    s.clock.advance(60_000);

    await s.placeBet(wallet, '25.00', ext('bet-40')); // 75; acorda o REFUND
    const refundNext = new Date(
      String((await s.txRow(refund.transactionId)).next_attempt_at),
    ).toISOString();
    expect(refundNext).toBe(inMs(0));

    const refunded = await s.resolve(refund.transactionId); // 100; acorda o ROLLBACK
    expect(refunded).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Processed,
    });
    expect(
      new Date(
        String((await s.txRow(rollback.transactionId)).next_attempt_at),
      ).toISOString(),
    ).toBe(inMs(0));

    const undone = await s.resolve(rollback.transactionId); // desfaz o REFUND: 75
    expect(undone).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(await s.directions(wallet.id)).toEqual(['DEBIT', 'CREDIT', 'DEBIT']);
    await assertInvariants(s.sql, wallet.id);
  });
});
