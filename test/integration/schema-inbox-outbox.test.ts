import { describe, expect, test } from 'bun:test';
import { expectViolation } from '../support/assertions.js';
import { useSql } from '../support/database.js';

// SQL direto no banco real: cada teste tenta violar uma regra do schema.
const sql = useSql();

const insertInbox = (consumerName: string, messageId: string) =>
  sql(
    'INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)',
    [consumerName, messageId, 'a'.repeat(64)],
  );

const insertOutbox = (overrides: { id?: string; attempts?: number } = {}) =>
  sql(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
     VALUES (?, ?, ?, ?::jsonb, now(), ?)`,
    [
      overrides.id ?? crypto.randomUUID(),
      crypto.randomUUID(),
      'wallet.transaction.processed',
      JSON.stringify({ ok: true }),
      overrides.attempts ?? 0,
    ],
  );

describe('inbox_messages', () => {
  test('accepts a new message', async () => {
    await insertInbox('wager-consumer', crypto.randomUUID());
  });

  test('rejects the same (consumer_name, message_id) twice', async () => {
    const messageId = crypto.randomUUID();
    await insertInbox('wager-consumer', messageId);
    await expectViolation(
      insertInbox('wager-consumer', messageId),
      'pk_inbox_messages',
    );
  });

  test('accepts the same message_id for a different consumer', async () => {
    const messageId = crypto.randomUUID();
    await insertInbox('consumer-a', messageId);
    await insertInbox('consumer-b', messageId);
  });

  test('starts as received and not processed', async () => {
    const messageId = crypto.randomUUID();
    await insertInbox('wager-consumer', messageId);
    const rows = (await sql(
      'SELECT received_at IS NOT NULL AS received, processed_at IS NULL AS pending FROM inbox_messages WHERE message_id = ?',
      [messageId],
    )) as { received: boolean; pending: boolean }[];
    expect(rows).toEqual([{ received: true, pending: true }]);
  });
});

describe('outbox_messages', () => {
  test('accepts a new event with attempts 0, due now and not published', async () => {
    const id = crypto.randomUUID();
    await insertOutbox({ id });
    const rows = (await sql(
      `SELECT attempts, published_at IS NULL AS unpublished, next_attempt_at <= now() AS due
         FROM outbox_messages WHERE id = ?`,
      [id],
    )) as { attempts: number; unpublished: boolean; due: boolean }[];
    expect(rows).toEqual([{ attempts: 0, unpublished: true, due: true }]);
  });

  test('rejects the same event id twice', async () => {
    const id = crypto.randomUUID();
    await insertOutbox({ id });
    await expectViolation(insertOutbox({ id }), 'pk_outbox_messages');
  });

  test('rejects negative attempts', async () => {
    await expectViolation(
      insertOutbox({ attempts: -1 }),
      'ck_outbox_attempts_non_negative',
    );
  });

  test('indexes only unpublished events by next_attempt_at', async () => {
    const rows = (await sql(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_outbox_due'",
    )) as { indexdef: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('(next_attempt_at)');
    expect(rows[0]?.indexdef).toContain('published_at IS NULL');
  });
});
