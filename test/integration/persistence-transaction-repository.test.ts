import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../support/assertions.js';
import {
  ConcurrentTransactionUpdateError,
  DuplicateKeyError,
} from '../../src/application/errors/application-errors.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import {
  brl,
  newTransaction,
  newWallet,
  persistWallet,
  T1,
  T2,
  usd,
  usePersistence,
  uuid,
} from '../support/persistence.js';

const db = usePersistence();
const K = WagerTransactionKind;

async function walletInDb(balance = '100.00'): Promise<Wallet> {
  const wallet = newWallet(balance);
  await persistWallet(db().uow, wallet);
  return wallet;
}

async function insert(tx: WagerTransaction): Promise<void> {
  await db().uow.run(async (r) => r.transactions.insert(tx));
}

function processed(
  tx: WagerTransaction,
  referenceTransactionId?: string,
): WagerTransaction {
  tx.markProcessed({
    ...(referenceTransactionId && { referenceTransactionId }),
    balanceAfter: brl('75.00'),
    at: T1,
  });
  return tx;
}

describe('WagerTransactionRepository: round trip of every final state', () => {
  test('PROCESSED keeps balance, processedAt and every business field', async () => {
    const wallet = await walletInDb();
    const tx = processed(
      newTransaction(wallet, { roundId: 'round-77', gameId: 'fortune-chimp' }),
    );
    await insert(tx);

    const loaded = await db().reader.findById(tx.id);
    expect(loaded).toBeDefined();
    expect(loaded?.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded?.kind).toBe(K.Bet);
    expect(loaded?.providerId).toBe('provider-a');
    expect(loaded?.externalTransactionId).toBe(tx.externalTransactionId);
    expect(loaded?.idempotencyKey).toBe(tx.idempotencyKey);
    expect(loaded?.payloadHash).toBe(tx.payloadHash);
    expect(loaded?.walletId).toBe(wallet.id);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.roundId).toBe('round-77');
    expect(loaded?.gameId).toBe('fortune-chimp');
    expect(loaded?.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(loaded?.balanceAfter?.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(loaded?.processedAt?.toISOString()).toBe(T1.toISOString());
    expect(loaded?.createdAt.toISOString()).toBe(tx.createdAt.toISOString());
    expect(loaded?.correlationId).toBe('corr-1');
    expect(loaded?.failureCode).toBeUndefined();
    expect(loaded?.referenceTransactionId).toBeUndefined();
    expect(loaded?.attempts).toBe(0);
    expect(loaded?.nextAttemptAt).toBeUndefined();
  });

  test('REJECTED keeps the failure code and the observed balance, with no processedAt', async () => {
    const wallet = await walletInDb();
    const tx = newTransaction(wallet);
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'));
    await insert(tx);

    const loaded = await db().reader.findById(tx.id);
    expect(loaded?.status).toBe(WagerTransactionStatus.Rejected);
    expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loaded?.balanceAfter?.toJSON().amount).toBe('10.00');
    expect(loaded?.processedAt).toBeUndefined();
  });

  test('a rejection in ANOTHER currency keeps the provider money and the WALLET balance in the wallet currency (ADR-0006)', async () => {
    const wallet = await walletInDb('100.00'); // wallet em BRL
    const tx = newTransaction(wallet, { money: usd('25.00') });
    tx.reject(FailureCode.CurrencyMismatch, brl('100.00'));
    await insert(tx);

    const loaded = await db().reader.findById(tx.id);

    expect(loaded?.failureCode).toBe(FailureCode.CurrencyMismatch);
    // O que o provedor mandou continua como veio (sem FK de moeda, ADR-0004)...
    expect(loaded?.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'USD',
    });
    // ...e o saldo observado é o da wallet, com a moeda DA WALLET, não a da transação.
    expect(loaded?.balanceAfter?.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('balance_after always carries the wallet currency, also when it equals the transaction one', async () => {
    const wallet = await walletInDb('100.00');
    const done = processed(newTransaction(wallet));
    await insert(done);
    const loaded = await db().reader.findById(done.id);
    expect(loaded?.balanceAfter?.currency).toBe('BRL');
    expect(loaded?.money.currency).toBe('BRL');
  });

  test('PENDING_REFERENCE keeps attempts, nextAttemptAt and the external reference', async () => {
    const wallet = await walletInDb();
    const tx = newTransaction(wallet, {
      kind: K.Refund,
      referenceExternalTransactionId: 'ext-of-the-bet',
    });
    tx.markPendingReference(T2);
    await insert(tx);

    const loaded = await db().reader.findById(tx.id);
    expect(loaded?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(loaded?.attempts).toBe(1);
    expect(loaded?.nextAttemptAt?.toISOString()).toBe(T2.toISOString());
    expect(loaded?.referenceExternalTransactionId).toBe('ext-of-the-bet');
    expect(loaded?.referenceTransactionId).toBeUndefined();
    expect(loaded?.balanceAfter).toBeUndefined();
  });

  test('FAILED keeps the failure code', async () => {
    const wallet = await walletInDb();
    const tx = newTransaction(wallet);
    tx.fail(FailureCode.DependencyUnavailable);
    await insert(tx);
    const loaded = await db().reader.findById(tx.id);
    expect(loaded?.status).toBe(WagerTransactionStatus.Failed);
    expect(loaded?.failureCode).toBe(FailureCode.DependencyUnavailable);
  });

  test('a reversal keeps the resolved reference', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    const refund = processed(
      newTransaction(wallet, {
        kind: K.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      bet.id,
    );
    await insert(refund);
    const loaded = await db().reader.findById(refund.id);
    expect(loaded?.referenceTransactionId).toBe(bet.id);
    expect(loaded?.referenceExternalTransactionId).toBe(
      bet.externalTransactionId,
    );
  });

  test('the loaded transaction is terminal: it cannot change state again', async () => {
    const wallet = await walletInDb();
    const tx = processed(newTransaction(wallet));
    await insert(tx);
    const loaded = await db().reader.findById(tx.id);
    expect(loaded?.isTerminal()).toBe(true);
  });
});

describe('WagerTransactionReader: lookups', () => {
  test('by id, by idempotency key and by provider + external id find the same transaction', async () => {
    const wallet = await walletInDb();
    const tx = processed(newTransaction(wallet));
    await insert(tx);
    const byId = await db().reader.findById(tx.id);
    const byKey = await db().reader.findByIdempotencyKey(tx.idempotencyKey);
    const byExternal = await db().reader.findByProviderAndExternalId(
      tx.providerId,
      tx.externalTransactionId,
    );
    expect(byId?.id).toBe(tx.id);
    expect(byKey?.id).toBe(tx.id);
    expect(byExternal?.id).toBe(tx.id);
  });

  test('nothing found is undefined, not an error', async () => {
    expect(await db().reader.findById(uuid())).toBeUndefined();
    expect(await db().reader.findByIdempotencyKey('nope')).toBeUndefined();
    expect(
      await db().reader.findByProviderAndExternalId('provider-a', 'nope'),
    ).toBeUndefined();
  });

  test('the same external id under another provider is another transaction', async () => {
    const wallet = await walletInDb();
    const a = processed(newTransaction(wallet, { providerId: 'provider-a' }));
    const b = processed(
      newTransaction(wallet, {
        providerId: 'provider-b',
        externalTransactionId: a.externalTransactionId,
        idempotencyKey: `provider-b:${a.externalTransactionId}`,
      }),
    );
    await insert(a);
    await insert(b);
    expect(
      (
        await db().reader.findByProviderAndExternalId(
          'provider-a',
          a.externalTransactionId,
        )
      )?.id,
    ).toBe(a.id);
    expect(
      (
        await db().reader.findByProviderAndExternalId(
          'provider-b',
          a.externalTransactionId,
        )
      )?.id,
    ).toBe(b.id);
  });

  test('a fresh read sees a row committed by someone else (no stale cache between calls)', async () => {
    const wallet = await walletInDb();
    const tx = processed(newTransaction(wallet));
    expect(
      await db().reader.findByIdempotencyKey(tx.idempotencyKey),
    ).toBeUndefined();
    await insert(tx);
    expect(
      (await db().reader.findByIdempotencyKey(tx.idempotencyKey))?.id,
    ).toBe(tx.id);
  });
});

describe('WagerTransactionRepository: unique constraints become DuplicateKeyError', () => {
  test('the same idempotency key', async () => {
    const wallet = await walletInDb();
    const first = processed(newTransaction(wallet));
    await insert(first);
    const second = processed(
      newTransaction(wallet, { idempotencyKey: first.idempotencyKey }),
    );
    const attempt = insert(second);
    expect(await rejectionOf(attempt)).toBeInstanceOf(DuplicateKeyError);
    expect(await rejectionOf(attempt)).toMatchObject({
      constraint: 'uq_wtx_idempotency_key',
    });
  });

  test('the same provider and external id under another key', async () => {
    const wallet = await walletInDb();
    const first = processed(newTransaction(wallet));
    await insert(first);
    const second = processed(
      newTransaction(wallet, {
        externalTransactionId: first.externalTransactionId,
        idempotencyKey: `other-key-${uuid()}`,
      }),
    );
    const attempt = insert(second);
    expect(await rejectionOf(attempt)).toBeInstanceOf(DuplicateKeyError);
    expect(await rejectionOf(attempt)).toMatchObject({
      constraint: 'uq_wtx_provider_external',
    });
  });

  test('a second reversal PROCESSED of the same transaction (uq_wtx_reversed_once is the safety net)', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    const mk = () =>
      processed(
        newTransaction(wallet, {
          kind: K.Refund,
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        bet.id,
      );
    await insert(mk());
    const attempt = insert(mk());
    expect(await rejectionOf(attempt)).toBeInstanceOf(DuplicateKeyError);
    expect(await rejectionOf(attempt)).toMatchObject({
      constraint: 'uq_wtx_reversed_once',
    });
  });
});

describe('WagerTransactionRepository: hasProcessedReversal', () => {
  test('false for a transaction nobody reverted', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    expect(
      await db().uow.run(async (r) =>
        r.transactions.hasProcessedReversal(bet.id),
      ),
    ).toBe(false);
  });

  test.each([K.Refund, K.Rollback])(
    'true once a PROCESSED %s points at it',
    async (kind) => {
      const wallet = await walletInDb();
      const bet = processed(newTransaction(wallet));
      await insert(bet);
      await insert(
        processed(
          newTransaction(wallet, {
            kind,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
          bet.id,
        ),
      );
      expect(
        await db().uow.run(async (r) =>
          r.transactions.hasProcessedReversal(bet.id),
        ),
      ).toBe(true);
    },
  );

  test('a REJECTED reversal does not count (ADR-0005: only PROCESSED does)', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    const rejected = newTransaction(wallet, {
      kind: K.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    rejected.reject(FailureCode.InsufficientFunds, brl('10.00'));
    await insert(rejected);
    expect(
      await db().uow.run(async (r) =>
        r.transactions.hasProcessedReversal(bet.id),
      ),
    ).toBe(false);
  });

  test('a WIN pointing at the transaction is not a reversal', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    await insert(
      processed(
        newTransaction(wallet, {
          kind: K.Win,
          money: brl('80.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        bet.id,
      ),
    );
    expect(
      await db().uow.run(async (r) =>
        r.transactions.hasProcessedReversal(bet.id),
      ),
    ).toBe(false);
  });
});

describe('WagerTransactionRepository: hasSettledWin (ADR-0005, sister rule 2)', () => {
  async function betWithWin(
    winStatus: 'processed' | 'rejected' = 'processed',
    winAmount = '80.00',
  ) {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    const win = newTransaction(wallet, {
      kind: K.Win,
      money: brl(winAmount),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    if (winStatus === 'processed') {
      processed(win, bet.id);
    } else {
      win.reject(FailureCode.ReferenceMismatch, brl('10.00'));
    }
    await insert(win);
    return { wallet, bet, win };
  }

  const settled = (bet: WagerTransaction) =>
    db().uow.run(async (r) => r.transactions.hasSettledWin(bet));

  test('false for a BET with no WIN', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    expect(await settled(bet)).toBe(false);
  });

  test('true for a BET with a PROCESSED WIN that was not reversed', async () => {
    const { bet } = await betWithWin();
    expect(await settled(bet)).toBe(true);
  });

  test('false when the WIN was REJECTED: nothing was paid', async () => {
    const { bet } = await betWithWin('rejected');
    expect(await settled(bet)).toBe(false);
  });

  test('false once the WIN was reversed (ROLLBACK of the WIN PROCESSED)', async () => {
    const { wallet, bet, win } = await betWithWin();
    await insert(
      processed(
        newTransaction(wallet, {
          kind: K.Rollback,
          money: brl('80.00'),
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        win.id,
      ),
    );
    expect(await settled(bet)).toBe(false);
  });

  test('still true when the reversal of the WIN was REJECTED', async () => {
    const { wallet, bet, win } = await betWithWin();
    const rejected = newTransaction(wallet, {
      kind: K.Rollback,
      money: brl('80.00'),
      referenceExternalTransactionId: win.externalTransactionId,
    });
    rejected.reject(FailureCode.ReversalInsufficientFunds, brl('0.00'));
    await insert(rejected);
    expect(await settled(bet)).toBe(true);
  });

  test('a WIN of 0.00 pays nothing, so it does not settle the BET (settled = the player got money)', async () => {
    const { bet } = await betWithWin('processed', '0.00');
    expect(await settled(bet)).toBe(false);
  });

  test('a WIN of 0.01 already settles the BET', async () => {
    const { bet } = await betWithWin('processed', '0.01');
    expect(await settled(bet)).toBe(true);
  });

  test('a BET with a WIN of 0.00 AND a WIN of 10.00 is settled (the paying one counts)', async () => {
    const { wallet, bet } = await betWithWin('processed', '0.00');
    const paying = newTransaction(wallet, {
      kind: K.Win,
      money: brl('10.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    processed(paying, bet.id);
    await insert(paying);
    expect(await settled(bet)).toBe(true);
  });

  test('a LOSS never settles a BET (BET + LOSS + REFUND is zero)', async () => {
    const wallet = await walletInDb();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    await insert(
      processed(
        newTransaction(wallet, {
          kind: K.Loss,
          money: brl('0.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
        bet.id,
      ),
    );
    expect(await settled(bet)).toBe(false);
  });

  test('a WIN of another BET does not settle this one', async () => {
    const { wallet } = await betWithWin();
    const other = processed(newTransaction(wallet));
    await insert(other);
    expect(await settled(other)).toBe(false);
  });
});

describe('WagerTransactionRepository: wakePendingReferences', () => {
  async function pending(
    wallet: Wallet,
    reference: string,
    overrides: { providerId?: string } = {},
  ): Promise<WagerTransaction> {
    const providerId = overrides.providerId ?? 'provider-a';
    const tx = newTransaction(wallet, {
      providerId,
      kind: K.Refund,
      referenceExternalTransactionId: reference,
    });
    tx.markPendingReference(new Date('2030-01-01T00:00:00.000Z'));
    await insert(tx);
    return tx;
  }

  // O acordar é por wallet: só mexe nas pendentes da MESMA wallet (ADR-0007: toda gravação em
  // wager_transactions de uma wallet acontece com o lock dela).
  const wake = (
    provider: string,
    walletId: string,
    reference: string,
    at: Date,
  ) =>
    db().uow.run(async (r) =>
      r.transactions.wakePendingReferences(provider, walletId, reference, at),
    );

  test('brings forward the ones waiting for THAT reference, and says how many', async () => {
    const wallet = await walletInDb();
    const reference = `ref-${uuid()}`;
    const a = await pending(wallet, reference);
    const b = await pending(wallet, reference);

    expect(await wake('provider-a', wallet.id, reference, T2)).toBe(2);

    for (const tx of [a, b]) {
      const loaded = await db().reader.findById(tx.id);
      expect(loaded?.nextAttemptAt?.toISOString()).toBe(T2.toISOString());
      expect(loaded?.status).toBe(WagerTransactionStatus.PendingReference);
      expect(loaded?.attempts).toBe(1);
    }
  });

  test('leaves alone the ones waiting for another reference', async () => {
    const wallet = await walletInDb();
    const mine = `ref-${uuid()}`;
    const theirs = `ref-${uuid()}`;
    await pending(wallet, mine);
    const other = await pending(wallet, theirs);
    await wake('provider-a', wallet.id, mine, T2);
    const loaded = await db().reader.findById(other.id);
    expect(loaded?.nextAttemptAt?.toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
  });

  test('leaves alone another provider that happens to use the same external id', async () => {
    const wallet = await walletInDb();
    const reference = `ref-${uuid()}`;
    const other = await pending(wallet, reference, {
      providerId: 'provider-b',
    });
    expect(await wake('provider-a', wallet.id, reference, T2)).toBe(0);
    const loaded = await db().reader.findById(other.id);
    expect(loaded?.nextAttemptAt?.toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
  });

  test('never touches a transaction that is already final (the trigger would refuse)', async () => {
    const wallet = await walletInDb();
    const reference = `ref-${uuid()}`;
    const done = newTransaction(wallet, {
      kind: K.Refund,
      referenceExternalTransactionId: reference,
    });
    done.reject(FailureCode.ReferenceNotFound, brl('10.00'));
    await insert(done);
    expect(await wake('provider-a', wallet.id, reference, T2)).toBe(0);
    expect((await db().reader.findById(done.id))?.status).toBe(
      WagerTransactionStatus.Rejected,
    );
  });

  test('returns 0 when nobody is waiting', async () => {
    expect(await wake('provider-a', uuid(), `ref-${uuid()}`, T2)).toBe(0);
  });

  test('leaves alone the pending ones of ANOTHER wallet that wait for the same external id', async () => {
    const mine = await walletInDb();
    const theirs = await walletInDb();
    const reference = `ref-${uuid()}`;
    const mineWaiting = await pending(mine, reference);
    const theirsWaiting = await pending(theirs, reference);

    expect(await wake('provider-a', mine.id, reference, T2)).toBe(1);

    expect(
      (
        await db().reader.findById(mineWaiting.id)
      )?.nextAttemptAt?.toISOString(),
    ).toBe(T2.toISOString());
    expect(
      (
        await db().reader.findById(theirsWaiting.id)
      )?.nextAttemptAt?.toISOString(),
    ).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('WagerTransactionRepository: update (a pending transaction moving on)', () => {
  async function pendingRow(
    attemptsAlreadyMade = 1,
  ): Promise<{ wallet: Wallet; tx: WagerTransaction }> {
    const wallet = await walletInDb();
    const tx = newTransaction(wallet, {
      kind: K.Refund,
      referenceExternalTransactionId: `ref-${uuid()}`,
    });
    for (let i = 0; i < attemptsAlreadyMade; i++) {
      tx.markPendingReference(new Date('2030-01-01T00:00:00.000Z'));
    }
    await insert(tx);
    return { wallet, tx };
  }
  const update = (tx: WagerTransaction) =>
    db().uow.run(async (r) => r.transactions.update(tx));

  test('waiting again keeps the new attempts and the new next_attempt_at, still PENDING_REFERENCE', async () => {
    const { tx } = await pendingRow();
    const loaded = (await db().reader.findById(tx.id)) as WagerTransaction;
    loaded.markPendingReference(new Date('2030-02-02T00:00:00.000Z'));

    await update(loaded);

    const after = await db().reader.findById(tx.id);
    expect(after?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(after?.attempts).toBe(2);
    expect(after?.nextAttemptAt?.toISOString()).toBe(
      '2030-02-02T00:00:00.000Z',
    );
  });

  test('becoming PROCESSED keeps the resolved reference, the wallet balance, processed_at, and clears next_attempt_at', async () => {
    const { wallet, tx } = await pendingRow();
    const bet = processed(newTransaction(wallet));
    await insert(bet);
    const loaded = (await db().reader.findById(tx.id)) as WagerTransaction;
    loaded.markProcessed({
      referenceTransactionId: bet.id,
      balanceAfter: brl('100.00'),
      at: T2,
    });

    await update(loaded);

    const after = await db().reader.findById(tx.id);
    expect(after?.status).toBe(WagerTransactionStatus.Processed);
    expect(after?.referenceTransactionId).toBe(bet.id);
    expect(after?.balanceAfter?.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(after?.processedAt?.toISOString()).toBe(T2.toISOString());
    expect(after?.nextAttemptAt).toBeUndefined();
    expect(after?.attempts).toBe(1);
  });

  test('becoming REJECTED keeps the failure code and the wallet balance, and clears next_attempt_at', async () => {
    const { tx } = await pendingRow();
    const loaded = (await db().reader.findById(tx.id)) as WagerTransaction;
    loaded.reject(FailureCode.ReferenceNotFound, brl('90.00'));

    await update(loaded);

    const after = await db().reader.findById(tx.id);
    expect(after?.status).toBe(WagerTransactionStatus.Rejected);
    expect(after?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(after?.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(after?.nextAttemptAt).toBeUndefined();
  });

  test('only the columns that can change are written: what the provider sent is untouched', async () => {
    const { wallet, tx } = await pendingRow();
    const loaded = (await db().reader.findById(tx.id)) as WagerTransaction;
    // Um objeto "adulterado" com o mesmo id: outro valor, outro tipo. Só o estado pode mudar.
    const tampered = WagerTransaction.rehydrate({
      id: loaded.id,
      providerId: 'someone-else',
      externalTransactionId: 'ext-tampered',
      idempotencyKey: 'key-tampered',
      payloadHash: 'f'.repeat(64),
      walletId: loaded.walletId,
      playerId: loaded.playerId,
      roundId: 'round-tampered',
      gameId: 'game-tampered',
      kind: K.Win,
      money: brl('999.00'),
      correlationId: 'tampered',
      createdAt: T2,
      status: WagerTransactionStatus.PendingReference,
      attempts: 2,
      nextAttemptAt: T2,
    });

    await update(tampered);

    const row = (await db()
      .orm.em.getConnection()
      .execute('SELECT * FROM wager_transactions WHERE id = ?', [
        tx.id,
      ])) as Array<Record<string, unknown>>;
    expect(row[0]).toMatchObject({
      provider_id: 'provider-a',
      external_transaction_id: tx.externalTransactionId,
      idempotency_key: tx.idempotencyKey,
      payload_hash: tx.payloadHash,
      wallet_id: wallet.id,
      round_id: 'round-1',
      kind: 'REFUND',
      amount: '25.00',
      attempts: 2, // o estado SIM mudou
    });
  });

  test('a transaction that is already FINAL is not updated (ConcurrentTransactionUpdateError, zero rows)', async () => {
    const wallet = await walletInDb();
    const done = processed(newTransaction(wallet));
    await insert(done);
    const loaded = (await db().reader.findById(done.id)) as WagerTransaction;

    const error = await rejectionOf(update(loaded));

    expect(error).toBeInstanceOf(ConcurrentTransactionUpdateError);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      transactionId: done.id,
    });
  });

  test('a transaction that does not exist is the same error', async () => {
    const wallet = await walletInDb();
    const ghost = newTransaction(wallet, {
      kind: K.Refund,
      referenceExternalTransactionId: 'x',
    });
    ghost.markPendingReference(T2);
    expect(await rejectionOf(update(ghost))).toBeInstanceOf(
      ConcurrentTransactionUpdateError,
    );
  });
});
