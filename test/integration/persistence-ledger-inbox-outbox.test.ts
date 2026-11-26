import { describe, expect, test } from 'bun:test';
import { messageOf, rejectionOf } from '../support/assertions.js';
import { DuplicateKeyError } from '../../src/application/errors/application-errors.js';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.js';
import { WagerTransactionPendingReference } from '../../src/domain/messaging/events/wager-transaction-pending-reference.js';
import { WalletBalanceChanged } from '../../src/domain/messaging/events/wallet-balance-changed.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import type { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import {
  brl,
  HASH,
  newTransaction,
  newWallet,
  persistWallet,
  T0,
  T1,
  T2,
  usePersistence,
  uuid,
} from '../support/persistence.js';

const db = usePersistence();

async function betInDb(wallet: Wallet): Promise<WagerTransaction> {
  const tx = newTransaction(wallet);
  tx.markProcessed({ balanceAfter: brl('75.00'), at: T1 });
  await db().uow.run(async (r) => r.transactions.insert(tx));
  return tx;
}

describe('LedgerRepository: append-only', () => {
  test('an entry goes in with every field of the chain', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const tx = await betInDb(wallet);

    const entry = wallet.debit({
      money: brl('25.00'),
      transactionId: tx.id,
      entryId: uuid(),
      at: T1,
    });
    await db().uow.run(async (r) => {
      await r.wallets.save(wallet, 1);
      await r.ledger.append(entry);
    });

    const rows = (await db()
      .orm.em.getConnection()
      .execute('SELECT * FROM wallet_ledger_entries WHERE id = ?', [
        entry.id,
      ])) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wallet_id: wallet.id,
      transaction_id: tx.id,
      direction: 'DEBIT',
      amount: '25.00',
      currency: 'BRL',
      balance_before: '100.00',
      balance_after: '75.00',
      wallet_version: 2,
    });
  });

  test('two entries for the same wallet version are refused (the chain has no forks)', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const tx1 = await betInDb(wallet);
    const tx2 = await betInDb(wallet);
    const entry = wallet.debit({
      money: brl('1.00'),
      transactionId: tx1.id,
      entryId: uuid(),
      at: T1,
    });
    await db().uow.run(async (r) => {
      await r.wallets.save(wallet, 1);
      await r.ledger.append(entry);
    });
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(entry)),
      entry,
      {
        id: uuid(),
        transactionId: tx2.id,
      },
    );
    const attempt = db().uow.run(async (r) => r.ledger.append(clone));
    expect(await rejectionOf(attempt)).toBeInstanceOf(DuplicateKeyError);
    expect(await rejectionOf(attempt)).toMatchObject({
      constraint: 'uq_ledger_wallet_version',
    });
  });
});

describe('InboxRepository', () => {
  const message = (messageId = `msg-${uuid()}`) =>
    InboxMessage.receive({
      messageId,
      consumerName: 'wager-transactions-consumer',
      payloadHash: HASH,
      receivedAt: T0,
    });

  test('the first delivery is new, the second is a redelivery', async () => {
    const m = message();
    expect(await db().uow.run(async (r) => r.inbox.tryReceive(m))).toBe(true);
    expect(await db().uow.run(async (r) => r.inbox.tryReceive(m))).toBe(false);
  });

  test('the same messageId for another consumer is a different delivery', async () => {
    const m = message();
    await db().uow.run(async (r) => r.inbox.tryReceive(m));
    const other = InboxMessage.receive({
      messageId: m.messageId,
      consumerName: 'another-consumer',
      payloadHash: HASH,
      receivedAt: T0,
    });
    expect(await db().uow.run(async (r) => r.inbox.tryReceive(other))).toBe(
      true,
    );
  });

  test('find returns what was stored, including the hash used to detect a producer bug', async () => {
    const m = InboxMessage.receive({
      messageId: `msg-${uuid()}`,
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'c'.repeat(64),
      receivedAt: T0,
    });
    await db().uow.run(async (r) => r.inbox.tryReceive(m));
    const found = await db().uow.run(async (r) =>
      r.inbox.find(m.consumerName, m.messageId),
    );
    expect(found?.payloadHash).toBe('c'.repeat(64));
    expect(found?.isProcessed()).toBe(false);
    expect(
      await db().uow.run(async (r) => r.inbox.find(m.consumerName, 'nope')),
    ).toBeUndefined();
  });

  test('markProcessed is stored', async () => {
    const m = message();
    await db().uow.run(async (r) => r.inbox.tryReceive(m));
    m.markProcessed(T2);
    await db().uow.run(async (r) => r.inbox.markProcessed(m));
    const found = await db().uow.run(async (r) =>
      r.inbox.find(m.consumerName, m.messageId),
    );
    expect(found?.isProcessed()).toBe(true);
    expect(found?.processedAt?.toISOString()).toBe(T2.toISOString());
  });

  test('a delivery rolled back with its transaction never existed (redelivery will be new)', async () => {
    const m = message();
    const attempt = db().uow.run(async (r) => {
      await r.inbox.tryReceive(m);
      throw new Error('business failed after the inbox insert');
    });
    expect(messageOf(await rejectionOf(attempt))).toContain('business failed');
    expect(await db().uow.run(async (r) => r.inbox.tryReceive(m))).toBe(true);
  });
});

describe('OutboxRepository', () => {
  test('stores the envelope exactly as the event serializes it', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const tx = newTransaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });
    tx.markPendingReference(T2);
    const event = WagerTransactionPendingReference.from(tx, {
      eventId: uuid(),
      correlationId: 'corr-1',
      occurredAt: T1,
    });
    const message = OutboxMessage.enqueue(event, T1);

    await db().uow.run(async (r) => r.outbox.add(message));

    const [row] = (await db()
      .orm.em.getConnection()
      .execute('SELECT * FROM outbox_messages WHERE id = ?', [
        message.id,
      ])) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      id: event.eventId,
      aggregate_id: wallet.id,
      event_type: 'WagerTransactionPendingReference',
      attempts: 0,
      published_at: null,
      last_error: null,
    });
    expect(row?.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(new Date(row?.occurred_at as string).toISOString()).toBe(
      T1.toISOString(),
    );
    expect(new Date(row?.next_attempt_at as string).toISOString()).toBe(
      T1.toISOString(),
    );
  });

  test('the money inside the payload stays a string, not a float', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const entry = wallet.debit({
      money: brl('0.10'),
      transactionId: uuid(),
      entryId: uuid(),
      at: T1,
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: uuid(),
      correlationId: 'c',
      occurredAt: T1,
    });
    await db().uow.run(async (r) =>
      r.outbox.add(OutboxMessage.enqueue(event, T1)),
    );
    const [row] = (await db()
      .orm.em.getConnection()
      .execute('SELECT payload FROM outbox_messages WHERE id = ?', [
        event.eventId,
      ])) as Array<{
      payload: { data: { money: { amount: unknown }; walletVersion: unknown } };
    }>;
    expect(row?.payload.data.money.amount).toBe('0.10');
    expect(row?.payload.data.walletVersion).toBe(2);
  });

  test('the same event twice is refused by the primary key', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const tx = newTransaction(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'x',
    });
    tx.markPendingReference(T2);
    const event = WagerTransactionPendingReference.from(tx, {
      eventId: uuid(),
      correlationId: 'c',
      occurredAt: T1,
    });
    await db().uow.run(async (r) =>
      r.outbox.add(OutboxMessage.enqueue(event, T1)),
    );
    const again = db().uow.run(async (r) =>
      r.outbox.add(OutboxMessage.enqueue(event, T1)),
    );
    expect(await rejectionOf(again)).toBeInstanceOf(DuplicateKeyError);
  });
});
