import { describe, expect, test } from 'bun:test';
import { InboxMessageReusedError } from '../../src/application/errors/application-errors.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// A inbox só era gravada quando a mensagem processava algo NOVO. Uma mensagem cujo resultado já
// existia (a mesma operação chegou antes por HTTP, ou por outro messageId) era confirmada sem
// linha na inbox. Depois disso, o MESMO messageId com OUTRO payload não era reconhecido como
// INBOX_MESSAGE_REUSED: virava uma operação nova. Agora o replay também grava a inbox (com
// ON CONFLICT e a comparação do hash).
const db = usePersistence();
const s = createScenario(db);
const CONSUMER = 'wager-transactions-consumer';
let sequence = 0;
const inboxOf = (messageId: string) => ({
  inbox: { consumerName: CONSUMER, messageId },
  correlationId: messageId,
});
const newMessageId = () => `msg-replay-${Date.now()}-${++sequence}`;

async function inboxRows(messageId: string) {
  return s.sql(
    'SELECT payload_hash, processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    [CONSUMER, messageId],
  );
}

describe('a message resolved as a replay is recorded in the inbox', () => {
  test('the operation came first over HTTP: the queue delivery is a replay AND leaves its inbox row', async () => {
    const wallet = await s.walletWith('100.00');
    const operation = s.body(wallet);
    const first = await s.submit(operation); // HTTP: sem inbox
    const messageId = newMessageId();

    const replay = await s.submit(operation, inboxOf(messageId));
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      idempotentReplay: true,
    });

    const rows = await inboxRows(messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  test('the same messageId with ANOTHER payload after a replay is INBOX_MESSAGE_REUSED, and nothing is applied', async () => {
    const wallet = await s.walletWith('100.00');
    const operation = s.body(wallet);
    await s.submit(operation);
    const messageId = newMessageId();
    await s.submit(operation, inboxOf(messageId));

    const other = s.body(wallet, {
      money: { amount: '10.00', currency: 'BRL' },
    });
    await expect(s.submit(other, inboxOf(messageId))).rejects.toBeInstanceOf(
      InboxMessageReusedError,
    );
    const applied = await s.sql(
      'SELECT id FROM wager_transactions WHERE idempotency_key = ?',
      [s.keyOf(other)],
    );
    expect(applied).toHaveLength(0);
    expect(await s.balanceOf(wallet)).toBe('75.00');
  });

  test('redelivering the same message after the replay stays a replay (the row is not duplicated)', async () => {
    const wallet = await s.walletWith('100.00');
    const operation = s.body(wallet);
    await s.submit(operation);
    const messageId = newMessageId();
    await s.submit(operation, inboxOf(messageId));
    const again = await s.submit(operation, inboxOf(messageId));
    expect(again.idempotentReplay).toBe(true);
    expect(await inboxRows(messageId)).toHaveLength(1);
  });

  test('a replay found UNDER THE LOCK is recorded too (same transaction as the lock)', async () => {
    const wallet = await s.walletWith('100.00');
    const operation = s.body(wallet);
    const messageIds = Array.from({ length: 8 }, newMessageId);
    // Oito entregas da mesma operação ao mesmo tempo, cada uma com o seu messageId: uma processa,
    // as outras são replay (no caminho rápido ou sob o lock). Toda entrega deixa a sua linha.
    const results = await Promise.all(
      messageIds.map((messageId) => s.submit(operation, inboxOf(messageId))),
    );
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    for (const messageId of messageIds) {
      expect(await inboxRows(messageId)).toHaveLength(1);
    }
    expect(await s.balanceOf(wallet)).toBe('75.00');
  });
});
