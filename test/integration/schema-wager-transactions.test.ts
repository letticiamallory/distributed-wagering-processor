import { describe, test } from 'bun:test';
import { expectViolation } from '../support/assertions.js';
import { useSql } from '../support/database.js';
import { createFixtures, type Row } from '../support/fixtures.js';

// SQL direto no banco real: cada teste tenta violar uma regra do schema.
const sql = useSql();
const { newWallet, insertTransaction, processed } = createFixtures(sql);

describe('wager_transactions', () => {
  test('accepts a valid transaction', async () => {
    await insertTransaction(await newWallet());
  });

  test('rejects a repeated idempotency_key', async () => {
    const wallet = await newWallet();
    const idempotency_key = crypto.randomUUID();
    await insertTransaction(wallet, { idempotency_key });
    await expectViolation(
      insertTransaction(wallet, { idempotency_key }),
      'uq_wtx_idempotency_key',
    );
  });

  test('rejects a repeated (provider_id, external_transaction_id)', async () => {
    const wallet = await newWallet();
    const external_transaction_id = crypto.randomUUID();
    await insertTransaction(wallet, { external_transaction_id });
    await expectViolation(
      insertTransaction(wallet, { external_transaction_id }),
      'uq_wtx_provider_external',
    );
    // O mesmo id em outro provedor é outra transação.
    await insertTransaction(wallet, {
      external_transaction_id,
      provider_id: 'provider-b',
    });
  });

  test('rejects an unknown kind and an unknown status', async () => {
    const wallet = await newWallet();
    await expectViolation(
      insertTransaction(wallet, { kind: 'GIFT' }),
      'ck_wtx_kind',
    );
    await expectViolation(
      insertTransaction(wallet, { status: 'PROCESED' }),
      'ck_wtx_status',
    );
  });

  test('rejects a negative amount', async () => {
    await expectViolation(
      insertTransaction(await newWallet(), { kind: 'WIN', amount: '-0.01' }),
      'ck_wtx_amount_non_negative',
    );
  });

  test('accepts amount 0 only for WIN and LOSS', async () => {
    const wallet = await newWallet();
    await insertTransaction(wallet, { kind: 'WIN', amount: '0.00' });
    await insertTransaction(wallet, { kind: 'LOSS', amount: '0.00' });
    await expectViolation(
      insertTransaction(wallet, { kind: 'BET', amount: '0.00' }),
      'ck_wtx_positive_amount',
    );
    await expectViolation(
      insertTransaction(wallet, {
        kind: 'REFUND',
        amount: '0.00',
        reference_external_transaction_id: 'ext-1',
      }),
      'ck_wtx_positive_amount',
    );
  });

  test('rejects a REFUND or ROLLBACK without a reference', async () => {
    const wallet = await newWallet();
    await expectViolation(
      insertTransaction(wallet, { kind: 'REFUND' }),
      'ck_wtx_reference_required',
    );
    await expectViolation(
      insertTransaction(wallet, { kind: 'ROLLBACK' }),
      'ck_wtx_reference_required',
    );
  });

  test('requires failure_code exactly for REJECTED and FAILED', async () => {
    const wallet = await newWallet();
    await expectViolation(
      insertTransaction(wallet, { status: 'FAILED' }),
      'ck_wtx_failure_code',
    );
    await expectViolation(
      insertTransaction(wallet, {
        status: 'PENDING',
        failure_code: 'INSUFFICIENT_FUNDS',
      }),
      'ck_wtx_failure_code',
    );
    await insertTransaction(wallet, {
      status: 'FAILED',
      failure_code: 'INTERNAL_ERROR',
    });
  });

  test('requires processed_at exactly for PROCESSED', async () => {
    const wallet = await newWallet();
    await expectViolation(
      insertTransaction(wallet, { ...processed(), processed_at: null }),
      'ck_wtx_processed_at',
    );
    await expectViolation(
      insertTransaction(wallet, { processed_at: new Date().toISOString() }),
      'ck_wtx_processed_at',
    );
  });

  test('requires balance_after for PROCESSED and REJECTED', async () => {
    const wallet = await newWallet();
    await expectViolation(
      insertTransaction(wallet, { ...processed(), balance_after: null }),
      'ck_wtx_balance_snapshot',
    );
    await expectViolation(
      insertTransaction(wallet, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      }),
      'ck_wtx_balance_snapshot',
    );
  });

  test('requires next_attempt_at for PENDING_REFERENCE', async () => {
    const wallet = await newWallet();
    const pendingReference = {
      kind: 'REFUND',
      reference_external_transaction_id: 'ext-1',
    };
    await expectViolation(
      insertTransaction(wallet, {
        ...pendingReference,
        status: 'PENDING_REFERENCE',
      }),
      'ck_wtx_pending_schedule',
    );
    await insertTransaction(wallet, {
      ...pendingReference,
      status: 'PENDING_REFERENCE',
      next_attempt_at: new Date().toISOString(),
    });
  });
});

describe('wager_transactions: single reversal', () => {
  const reversal = (
    original: string,
    kind: 'REFUND' | 'ROLLBACK',
    extra: Row = {},
  ): Row => ({
    kind,
    reference_external_transaction_id: 'ext-original',
    reference_transaction_id: original,
    ...processed(),
    ...extra,
  });

  test('rejects a second PROCESSED reversal of the same transaction, of any kind', async () => {
    const wallet = await newWallet();
    const original = await insertTransaction(wallet, processed());
    await insertTransaction(wallet, reversal(original, 'REFUND'));
    await expectViolation(
      insertTransaction(wallet, reversal(original, 'REFUND')),
      'uq_wtx_reversed_once',
    );
    await expectViolation(
      insertTransaction(wallet, reversal(original, 'ROLLBACK')),
      'uq_wtx_reversed_once',
    );
  });

  test('does not count a REJECTED reversal', async () => {
    const wallet = await newWallet();
    const original = await insertTransaction(wallet, processed());
    await insertTransaction(
      wallet,
      reversal(original, 'REFUND', {
        status: 'REJECTED',
        failure_code: 'REFERENCE_MISMATCH',
        processed_at: null,
      }),
    );
    await insertTransaction(wallet, reversal(original, 'REFUND'));
  });
});

describe('wager_transactions: terminal states', () => {
  const touch = (id: string) =>
    sql('UPDATE wager_transactions SET attempts = 1 WHERE id = ?', [id]);
  const remove = (id: string) =>
    sql('DELETE FROM wager_transactions WHERE id = ?', [id]);

  test('rejects UPDATE of a PROCESSED transaction', async () => {
    const id = await insertTransaction(await newWallet(), processed());
    await expectViolation(touch(id), 'is terminal');
  });

  test('rejects DELETE of a PROCESSED transaction', async () => {
    const id = await insertTransaction(await newWallet(), processed());
    await expectViolation(remove(id), 'cannot be deleted');
  });

  test('rejects DELETE even of a PENDING transaction', async () => {
    const id = await insertTransaction(await newWallet());
    await expectViolation(remove(id), 'cannot be deleted');
  });

  test('allows PENDING_REFERENCE to become PROCESSED, and then locks it', async () => {
    const wallet = await newWallet();
    const original = await insertTransaction(wallet, processed());
    const id = await insertTransaction(wallet, {
      kind: 'REFUND',
      reference_external_transaction_id: 'ext-original',
      status: 'PENDING_REFERENCE',
      next_attempt_at: new Date().toISOString(),
    });

    await touch(id); // ainda não é terminal: editar é permitido
    await sql(
      `UPDATE wager_transactions
          SET status = 'PROCESSED', reference_transaction_id = ?, processed_at = now(), balance_after = '90.00'
        WHERE id = ?`,
      [original, id],
    );
    await expectViolation(touch(id), 'is terminal');
  });
});
