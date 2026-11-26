import { describe, expect, test } from 'bun:test';
import {
  DuplicateKeyError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InvalidCommandError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { Clock } from '../../src/application/ports/clock.js';
import { InboxReader } from '../../src/application/ports/inbox-repository.js';
import { IdGenerator } from '../../src/application/ports/id-generator.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { WagerTransactionReader } from '../../src/application/ports/wager-transaction-repository.js';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerContext,
  type ProcessWagerResult,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { computePayloadHash } from '../../src/domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import { rejectionOf } from '../support/assertions.js';
import {
  holding,
  inTheWindow,
  simultaneously,
  valueOf,
} from '../support/concurrency.js';
import { assertInvariants } from '../support/invariants.js';
import { brl, usePersistence, uuid } from '../support/persistence.js';

const db = usePersistence();

// ---------------------------------------------------------------- apoio

type Row = Record<string, unknown>;
const sql = (query: string, params: unknown[] = []) =>
  db().orm.em.getConnection().execute(query, params) as Promise<Row[]>;
const one = async (query: string, params: unknown[] = []): Promise<Row> => {
  const rows = await sql(query, params);
  expect(rows).toHaveLength(1);
  return rows[0] as Row;
};
const count = async (table: string, where: string, params: unknown[]) =>
  Number(
    (
      await one(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        params,
      )
    ).n,
  );

class FixedClock extends Clock {
  constructor(private readonly date: Date) {
    super();
  }
  now(): Date {
    return this.date;
  }
}

const NOW = new Date('2026-11-26T10:00:00.000Z');
const CTX_ID = 'corr-wager';

interface Wallet {
  id: string;
  playerId: string;
}

// Cria uma wallet de verdade (com OPENING e lançamento), pelo caso de uso da etapa anterior.
async function walletWith(
  balance = '100.00',
  currency = 'BRL',
): Promise<Wallet> {
  const playerId = uuid();
  const created = await new CreateWalletUseCase(
    db().uow,
    new FixedClock(NOW),
    new UuidV7Generator(),
  ).execute(
    { playerId, initialBalance: { amount: balance, currency } },
    { correlationId: 'setup' },
  );
  return { id: created.id, playerId };
}

let sequence = 0;
const nextExternal = () => `ext-${Date.now()}-${++sequence}`;

function body(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: nextExternal(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const keyOf = (b: Record<string, unknown>) =>
  `${String(b.providerId)}:${String(b.externalTransactionId)}`;

const build = (
  overrides: {
    uow?: UnitOfWork;
    reader?: WagerTransactionReader;
    inboxReader?: InboxReader;
    ids?: IdGenerator;
  } = {},
) =>
  new ProcessWagerTransactionUseCase(
    overrides.uow ?? db().uow,
    overrides.reader ?? db().reader,
    overrides.inboxReader ?? db().inboxReader,
    new FixedClock(NOW),
    overrides.ids ?? new UuidV7Generator(),
    new PendingReferenceSchedule(),
  );

function submit(
  input: Record<string, unknown>,
  context: Partial<ProcessWagerContext> = {},
  useCase: ProcessWagerTransactionUseCase = build(),
) {
  return useCase.execute(input, {
    idempotencyKey: keyOf(
      input as { providerId: unknown; externalTransactionId: unknown },
    ),
    correlationId: CTX_ID,
    ...context,
  });
}

const walletRow = (walletId: string) =>
  one('SELECT balance, version FROM wallets WHERE id = ?', [walletId]);
const txRow = (id: string) =>
  one('SELECT * FROM wager_transactions WHERE id = ?', [id]);
const movements = (walletId: string) =>
  sql(
    `SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > 1 ORDER BY wallet_version`,
    [walletId],
  );
// Os eventos desta wallet que dizem respeito a operações (não à abertura), ordenados por nome.
const eventTypes = async (walletId: string) =>
  (
    await sql(
      `SELECT o.event_type FROM outbox_messages o
        WHERE o.aggregate_id = ?
          AND o.payload->'data'->>'transactionId' IN (
                SELECT id::text FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING')
        ORDER BY o.event_type`,
      [walletId, walletId],
    )
  ).map((r) => String(r.event_type));
const wagerRows = (walletId: string) =>
  count('wager_transactions', `wallet_id = ? AND kind <> 'OPENING'`, [
    walletId,
  ]);

// Insere direto uma reversão PROCESSED que aponta para a BET (REFUND ainda não tem caso de uso,
// é o commit 5): serve para provar "BET já revertida" sem depender dele.
async function refundOf(
  betId: string,
  wallet: Wallet,
  betExternalId: string,
): Promise<void> {
  const refund = WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId: nextExternal(),
    idempotencyKey: `fixture:${uuid()}`,
    payloadHash: 'd'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: brl('25.00'),
    referenceExternalTransactionId: betExternalId,
    correlationId: 'fixture',
    createdAt: NOW,
  });
  refund.markProcessed({
    referenceTransactionId: betId,
    balanceAfter: brl('100.00'),
    at: NOW,
  });
  await db().uow.run(async (r) => r.transactions.insert(refund));
}

// Um UnitOfWork que conta quantas transações foram abertas, e pode proibir qualquer uma.
class CountingUnitOfWork extends UnitOfWork {
  runs = 0;
  constructor(
    private readonly inner: UnitOfWork,
    private readonly forbidden = false,
  ) {
    super();
  }
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.runs++;
    if (this.forbidden) {
      throw new Error('a transaction was opened where none was expected');
    }
    return this.inner.run(work);
  }
}

// Conta os ids pedidos: prova que uma entrega recusada cedo não chegou a construir nada.
class CountingIds extends IdGenerator {
  readonly given: string[] = [];
  next(): string {
    const id = uuid();
    this.given.push(id);
    return id;
  }
}

class UnitOfWorkWith extends UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly patch: (r: Repositories) => Repositories,
  ) {
    super();
  }
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run((r) => work(this.patch(r)));
  }
}

// ---------------------------------------------------------------- BET

describe('ProcessWagerTransaction: BET', () => {
  test('debits the wallet, writes the final transaction, the ledger entry and the events', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const result = await submit(input);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(result.failureCode).toBeUndefined();

    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
    const tx = await txRow(result.transactionId);
    expect(tx).toMatchObject({
      status: 'PROCESSED',
      kind: 'BET',
      amount: '25.00',
      balance_after: '75.00',
      failure_code: null,
      correlation_id: CTX_ID,
      idempotency_key: keyOf(input),
    });
    expect(new Date(String(tx.processed_at)).toISOString()).toBe(
      NOW.toISOString(),
    );
    expect(tx.payload_hash).toBe(
      computePayloadHash({
        providerId: 'provider-a',
        externalTransactionId: String(input.externalTransactionId),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('25.00'),
      }),
    );

    const entries = await movements(wallet.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transaction_id: result.transactionId,
      direction: 'DEBIT',
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
      wallet_version: 2,
    });
    expect(await eventTypes(wallet.id)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertInvariants(sql, wallet.id);
  });

  test('puts the right events in the outbox, with money as strings and the correlation id', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(body(wallet));

    const events = await sql(
      `SELECT event_type, payload FROM outbox_messages
        WHERE aggregate_id = ? AND payload->'data'->>'transactionId' = ?`,
      [wallet.id, result.transactionId],
    );
    const byType = Object.fromEntries(
      events.map((e) => [
        String(e.event_type),
        e.payload as Record<string, any>,
      ]),
    );
    expect(Object.keys(byType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(byType.WalletBalanceChanged).toMatchObject({
      aggregateId: wallet.id,
      correlationId: CTX_ID,
      causationId: result.transactionId,
      data: {
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(byType.WagerTransactionProcessed).toMatchObject({
      aggregateId: wallet.id,
      data: { kind: 'BET', balanceAfter: { amount: '75.00', currency: 'BRL' } },
    });
  });

  test('a BET for the whole balance is allowed and leaves exactly 0.00', async () => {
    const wallet = await walletWith('25.00');
    const result = await submit(body(wallet));
    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '0.00',
      version: 2,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('decimal arithmetic is exact: 0.10 + 0.20 taken from 0.30 leaves 0.00', async () => {
    const wallet = await walletWith('0.30');
    await submit(body(wallet, { money: { amount: '0.10', currency: 'BRL' } }));
    const second = await submit(
      body(wallet, { money: { amount: '0.20', currency: 'BRL' } }),
    );
    expect(second.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect((await movements(wallet.id)).map((e) => e.balance_after)).toEqual([
      '0.20',
      '0.00',
    ]);
    await assertInvariants(sql, wallet.id);
  });

  test('a BET above the balance is REJECTED INSUFFICIENT_FUNDS, stored so a replay answers the same', async () => {
    const wallet = await walletWith('10.00');
    const input = body(wallet, { money: { amount: '10.01', currency: 'BRL' } });

    const result = await submit(input);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: false,
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await txRow(result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      balance_after: '10.00',
      processed_at: null,
    });
    // Nada se mexeu: saldo, versão, lançamentos. Só a transação rejeitada e o evento dela.
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '10.00',
      version: 1,
    });
    expect(await movements(wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionRejected']);
    await assertInvariants(sql, wallet.id);
  });

  test('a BET that carries a reference field ignores it: the policy never validated it, so it is NOT linked', async () => {
    const wallet = await walletWith('100.00');
    const other = await submit(body(wallet)); // uma transação qualquer, já PROCESSED
    const otherExternal = String(
      (await txRow(other.transactionId)).external_transaction_id,
    );

    const bet = await submit(
      body(wallet, { referenceExternalTransactionId: otherExternal }),
    );

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    const row = await txRow(bet.transactionId);
    expect(row.reference_transaction_id).toBeNull(); // não virou vínculo
    expect(row.reference_external_transaction_id).toBe(otherExternal); // o que o provedor mandou fica como veio
    await assertInvariants(sql, wallet.id);
  });

  test('a rejected BET does not block a smaller one afterwards', async () => {
    const wallet = await walletWith('10.00');
    await submit(body(wallet, { money: { amount: '50.00', currency: 'BRL' } }));
    const ok = await submit(
      body(wallet, { money: { amount: '4.00', currency: 'BRL' } }),
    );
    expect(ok.status).toBe(WagerTransactionStatus.Processed);
    expect(ok.balance?.amount).toBe('6.00');
    await assertInvariants(sql, wallet.id);
  });

  test('a transaction from a player who does not own the wallet is REJECTED WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(body(wallet, { playerId: uuid() }));
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.WalletPlayerMismatch,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    await assertInvariants(sql, wallet.id);
  });
});

// ---------------------------------------------------------------- WIN e LOSS

describe('ProcessWagerTransaction: WIN', () => {
  test('without a reference credits the wallet', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(
      body(wallet, {
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    );
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '180.00', currency: 'BRL' },
    });
    expect((await movements(wallet.id))[0]).toMatchObject({
      direction: 'CREDIT',
      amount: '80.00',
      balance_after: '180.00',
    });
    await assertInvariants(sql, wallet.id);
  });

  test('referencing a PROCESSED BET of the same wallet credits and stores the resolved reference', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );

    const win = await submit(
      body(wallet, {
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternal,
      }),
    );

    expect(win).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '155.00', currency: 'BRL' },
    });
    expect(await txRow(win.transactionId)).toMatchObject({
      reference_transaction_id: bet.transactionId,
      reference_external_transaction_id: betExternal,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('a WIN of 0.00 is PROCESSED without moving the balance, the version, the ledger or the balance event', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(
      body(wallet, { kind: 'WIN', money: { amount: '0.00', currency: 'BRL' } }),
    );

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(await movements(wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed']);
    await assertInvariants(sql, wallet.id);
  });

  test.each([
    ['a BET of another wallet', FailureCode.ReferenceMismatch],
    ['a BET that was REJECTED', FailureCode.ReferenceNotProcessed],
    [
      'a WIN (only a BET can be referenced)',
      FailureCode.ReferenceKindNotAllowed,
    ],
    ['a BET of another round', FailureCode.ReferenceMismatch],
  ] as const)(
    'referencing %s is REJECTED %s and moves nothing',
    async (label, code) => {
      const wallet = await walletWith('100.00');
      let referenceExternal: string;
      if (label.includes('another wallet')) {
        const other = await walletWith('100.00');
        const bet = await submit(body(other));
        referenceExternal = String(
          (await txRow(bet.transactionId)).external_transaction_id,
        );
      } else if (label.includes('REJECTED')) {
        const bet = await submit(
          body(wallet, { money: { amount: '999.00', currency: 'BRL' } }),
        );
        referenceExternal = String(
          (await txRow(bet.transactionId)).external_transaction_id,
        );
      } else if (label.includes('a WIN')) {
        const win = await submit(
          body(wallet, {
            kind: 'WIN',
            money: { amount: '1.00', currency: 'BRL' },
          }),
        );
        referenceExternal = String(
          (await txRow(win.transactionId)).external_transaction_id,
        );
      } else {
        const bet = await submit(body(wallet, { roundId: 'round-A' }));
        referenceExternal = String(
          (await txRow(bet.transactionId)).external_transaction_id,
        );
      }
      const before = await walletRow(wallet.id);

      const win = await submit(
        body(wallet, {
          kind: 'WIN',
          roundId: label.includes('another round') ? 'round-B' : 'round-1',
          money: { amount: '5.00', currency: 'BRL' },
          referenceExternalTransactionId: referenceExternal,
        }),
      );

      expect(win).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: code,
      });
      expect(await walletRow(wallet.id)).toEqual(before);
      await assertInvariants(sql, wallet.id);
    },
  );

  test('on a BET that was already reversed is REJECTED REFERENCE_ALREADY_REVERSED (no prize for a returned bet)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );
    await refundOf(bet.transactionId, wallet, betExternal);
    const before = await walletRow(wallet.id);

    const win = await submit(
      body(wallet, {
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternal,
      }),
    );

    expect(win).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await walletRow(wallet.id)).toEqual(before);
  });
});

describe('ProcessWagerTransaction: several WINs for the same BET are allowed (ADR-0005)', () => {
  // É A REGRA, não um acaso: há jogos que pagam em partes e rodadas bônus que premiam a mesma
  // aposta mais de uma vez. Não existe limite de WINs por BET (o índice único de referência só
  // cobre REFUND e ROLLBACK). A segurança vem da idempotência por id externo (o mesmo WIN
  // reenviado não paga de novo) e do REFERENCE_SETTLED (a BET não pode ser revertida enquanto
  // houver um WIN PROCESSED não revertido).
  // A regra: dois WINs com ids externos diferentes são dois prêmios, e cada um paga uma vez.
  test('two WINs with different external ids for the same BET are both PROCESSED and both pay', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );
    const winOf = (amount: string) =>
      body(wallet, {
        kind: 'WIN',
        money: { amount, currency: 'BRL' },
        referenceExternalTransactionId: betExternal,
      });

    const first = await submit(winOf('40.00'));
    const second = await submit(winOf('10.00'));

    expect(first).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '115.00', currency: 'BRL' },
    });
    expect(second).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '125.00', currency: 'BRL' },
    });
    expect(first.transactionId).not.toBe(second.transactionId);
    const pointing = await count(
      'wager_transactions',
      'reference_transaction_id = ?',
      [bet.transactionId],
    );
    expect(pointing).toBe(2);
    expect((await movements(wallet.id)).map((e) => e.direction)).toEqual([
      'DEBIT',
      'CREDIT',
      'CREDIT',
    ]);
    await assertInvariants(sql, wallet.id);
  });

  // A regra: o limite de pagamento é a idempotência. O MESMO WIN (mesmo id externo) paga uma vez.
  test('the SAME WIN sent twice (same external id) pays once: the second is a replay', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );
    const win = body(wallet, {
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
    });

    const first = await submit(win);
    const again = await submit(win);

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '115.00',
      version: 3,
    });
    await assertInvariants(sql, wallet.id);
  });
});

describe('ProcessWagerTransaction: LOSS', () => {
  test('a LOSS of 0.00 is PROCESSED and does not touch the balance, the version or the ledger', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(
      body(wallet, {
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      }),
    );
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(await movements(wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionProcessed']);
    await assertInvariants(sql, wallet.id);
  });

  test('a LOSS carrying the bet amount still moves nothing (the debit was the BET)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );

    const loss = await submit(
      body(wallet, {
        kind: 'LOSS',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternal,
      }),
    );

    expect(loss).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
    expect(await movements(wallet.id)).toHaveLength(1);
    expect(await txRow(loss.transactionId)).toMatchObject({
      reference_transaction_id: bet.transactionId,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('on a BET that was already reversed is REJECTED REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet));
    const betExternal = String(
      (await txRow(bet.transactionId)).external_transaction_id,
    );
    await refundOf(bet.transactionId, wallet, betExternal);
    const loss = await submit(
      body(wallet, {
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternal,
      }),
    );
    expect(loss).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

// ---------------------------------------------------------------- moeda (ADR-0006)

describe('ProcessWagerTransaction: currency (balance_after is always the WALLET balance, in the wallet currency)', () => {
  test('a transaction in another currency is REJECTED CURRENCY_MISMATCH, answering with the wallet balance in the WALLET currency', async () => {
    const wallet = await walletWith('100.00', 'BRL');
    const input = body(wallet, { money: { amount: '25.00', currency: 'USD' } });

    const result = await submit(input);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
      idempotentReplay: false,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    // Gravada como o provedor mandou (USD), com o saldo da wallet (BRL) ao lado.
    expect(await txRow(result.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'CURRENCY_MISMATCH',
      amount: '25.00',
      currency: 'USD',
      balance_after: '100.00',
      processed_at: null,
    });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(await movements(wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toEqual(['WagerTransactionRejected']);
    await assertInvariants(sql, wallet.id);
  });

  test('the Rejected event keeps both currencies apart: money as sent, balance in the wallet currency', async () => {
    const wallet = await walletWith('100.00', 'BRL');
    const result = await submit(
      body(wallet, { money: { amount: '25.00', currency: 'USD' } }),
    );
    const events = await sql(
      `SELECT payload FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'
          AND payload->'data'->>'transactionId' = ?`,
      [wallet.id, result.transactionId],
    );
    expect(events).toHaveLength(1);
    const payload = (events[0] as Row).payload as { data: unknown };
    expect(payload.data).toMatchObject({
      failureCode: 'CURRENCY_MISMATCH',
      money: { amount: '25.00', currency: 'USD' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('the replay answers the same rejection, with the same wallet-currency balance', async () => {
    const wallet = await walletWith('100.00', 'BRL');
    const input = body(wallet, { money: { amount: '25.00', currency: 'USD' } });
    const first = await submit(input);
    await submit(
      body(wallet, {
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      }),
    );

    const replay = await submit(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' }); // o da época
  });

  test('a USD wallet refuses BRL, and answers in USD', async () => {
    const wallet = await walletWith('50.00', 'USD');
    const result = await submit(
      body(wallet, { money: { amount: '10.00', currency: 'BRL' } }),
    );
    expect(result).toMatchObject({
      failureCode: FailureCode.CurrencyMismatch,
      balance: { amount: '50.00', currency: 'USD' },
    });
    await assertInvariants(sql, wallet.id);
  });

  test.each(['BET', 'WIN', 'LOSS'])(
    'a %s in the wrong currency is also CURRENCY_MISMATCH and moves nothing',
    async (kind) => {
      const wallet = await walletWith('100.00', 'BRL');
      const amount = kind === 'LOSS' ? '0.00' : '10.00';
      const result = await submit(
        body(wallet, { kind, money: { amount, currency: 'USD' } }),
      );
      expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(await walletRow(wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
      });
      await assertInvariants(sql, wallet.id);
    },
  );

  test('the currency is checked before the owner: both wrong is CURRENCY_MISMATCH', async () => {
    const wallet = await walletWith('100.00', 'BRL');
    const result = await submit(
      body(wallet, {
        playerId: uuid(),
        money: { amount: '10.00', currency: 'USD' },
      }),
    );
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('in a normal transaction the observed balance is in the wallet currency too (same as the transaction)', async () => {
    const wallet = await walletWith('100.00', 'USD');
    const result = await submit(
      body(wallet, { money: { amount: '10.00', currency: 'USD' } }),
    );
    expect(result.balance).toEqual({ amount: '90.00', currency: 'USD' });
  });
});

// ---------------------------------------------------------------- passos 1 a 3: antes de travar

describe('ProcessWagerTransaction: steps 1-3 happen before any lock or transaction', () => {
  test('step 1: an invalid payload fails without touching the database at all', async () => {
    const wallet = await walletWith('100.00');
    const forbidden = new CountingUnitOfWork(db().uow, true);
    const neverRead = new (class extends WagerTransactionReader {
      findById(): never {
        throw new Error('read the database');
      }
      findByIdempotencyKey(): never {
        throw new Error('read the database');
      }
      findByProviderAndExternalId(): never {
        throw new Error('read the database');
      }
    })();
    const neverReadInbox = new (class extends InboxReader {
      find(): never {
        throw new Error('read the database');
      }
    })();
    const useCase = build({
      uow: forbidden,
      reader: neverRead,
      inboxReader: neverReadInbox,
    });

    for (const bad of [
      body(wallet, { kind: 'OPENING' }),
      body(wallet, { money: { amount: 25, currency: 'BRL' } }),
      body(wallet, { money: { amount: '25.5', currency: 'BRL' } }),
      body(wallet, { walletId: 'not-a-uuid' }),
      body(wallet, { kind: 'REFUND' }),
    ]) {
      const error = await rejectionOf(submit(bad, {}, useCase));
      expect(error).toBeInstanceOf(InvalidCommandError);
    }
    const missingKey = await rejectionOf(
      submit(body(wallet), { idempotencyKey: undefined }, useCase),
    );
    expect(missingKey).toMatchObject({ code: FailureCode.InvalidPayload });
    expect(forbidden.runs).toBe(0);
  });

  test.each([
    [{ kind: 'OPENING' }, FailureCode.UnsupportedKind],
    [{ money: { amount: 25, currency: 'BRL' } }, FailureCode.InvalidPayload],
    [
      { money: { amount: '-5.00', currency: 'BRL' } },
      FailureCode.InvalidAmount,
    ],
    [{ money: { amount: '0.00', currency: 'BRL' } }, FailureCode.InvalidAmount],
  ])('step 1: %j is %s and nothing is written', async (overrides, code) => {
    const wallet = await walletWith('100.00');
    const error = await rejectionOf(submit(body(wallet, overrides)));
    expect(error).toMatchObject({ code });
    expect(await wagerRows(wallet.id)).toBe(0);
  });

  test('step 3: a replay is answered without opening a transaction (and so without a lock)', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const first = await submit(input);

    const counting = new CountingUnitOfWork(db().uow);
    const replay = await submit(input, {}, build({ uow: counting }));

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(counting.runs).toBe(0);
  });

  test('step 3: a replay does not wait for a lock another request is holding', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    await submit(input);

    const replay = await holding(
      async ({ locked, until }) => {
        await db().uow.run(async (r) => {
          await r.wallets.lockById(wallet.id);
          locked();
          await until;
        });
      },
      async () => {
        const started = performance.now();
        const answer = await submit(input);
        expect(performance.now() - started).toBeLessThan(1000);
        return answer;
      },
    );

    expect(replay.idempotentReplay).toBe(true);
  });
});

// ---------------------------------------------------------------- idempotência

describe('ProcessWagerTransaction: idempotency', () => {
  test('the same request again is a replay: same transaction, same answer, no new effect', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const first = await submit(input);
    const rowsBefore = {
      tx: await wagerRows(wallet.id),
      ledger: await count('wallet_ledger_entries', 'wallet_id = ?', [
        wallet.id,
      ]),
      outbox: await count('outbox_messages', 'aggregate_id = ?', [wallet.id]),
    };

    const again = await submit(input);

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await wagerRows(wallet.id)).toBe(rowsBefore.tx);
    expect(
      await count('wallet_ledger_entries', 'wallet_id = ?', [wallet.id]),
    ).toBe(rowsBefore.ledger);
    expect(
      await count('outbox_messages', 'aggregate_id = ?', [wallet.id]),
    ).toBe(rowsBefore.outbox);
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('the replay returns the balance of THAT day, not the current one', async () => {
    const wallet = await walletWith('100.00');
    const first = body(wallet);
    const firstResult = await submit(first);
    await submit(body(wallet, { money: { amount: '30.00', currency: 'BRL' } }));
    expect((await walletRow(wallet.id)).balance).toBe('45.00');

    const replay = await submit(first);

    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(replay.transactionId).toBe(firstResult.transactionId);
  });

  test('the replay of a REJECTED transaction answers the same rejection, still rejected', async () => {
    const wallet = await walletWith('10.00');
    const input = body(wallet, { money: { amount: '99.00', currency: 'BRL' } });
    const first = await submit(input);
    await submit(
      body(wallet, {
        kind: 'WIN',
        money: { amount: '500.00', currency: 'BRL' },
      }),
    );

    const replay = await submit(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.balance).toEqual({ amount: '10.00', currency: 'BRL' }); // o saldo da época
  });

  test('the same key with another amount is IDEMPOTENCY_KEY_REUSED, and nothing changes', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    await submit(input);
    const before = await walletRow(wallet.id);

    const error = await rejectionOf(
      submit({ ...input, money: { amount: '26.00', currency: 'BRL' } }),
    );

    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(error).toMatchObject({ code: FailureCode.IdempotencyKeyReused });
    expect(await walletRow(wallet.id)).toEqual(before);
    expect(await wagerRows(wallet.id)).toBe(1);
  });

  test('the same key for another wallet is IDEMPOTENCY_KEY_REUSED (the wallet is part of the hash)', async () => {
    const a = await walletWith('100.00');
    const b = await walletWith('100.00');
    const input = body(a);
    await submit(input);
    const error = await rejectionOf(
      submit(
        { ...input, walletId: b.id, playerId: b.playerId },
        { idempotencyKey: keyOf(input) },
      ),
    );
    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await wagerRows(b.id)).toBe(0);
  });

  test('another key with the same provider and external id is EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    await submit(input);
    const before = await walletRow(wallet.id);

    const error = await rejectionOf(
      submit(input, { idempotencyKey: 'another-key' }),
    );

    expect(error).toBeInstanceOf(ExternalIdConflictError);
    expect(error).toMatchObject({ code: FailureCode.ExternalIdConflict });
    expect(await walletRow(wallet.id)).toEqual(before);
  });

  test('the same external id under another provider is a different transaction', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    await submit(input);
    const other = await submit(
      { ...input, providerId: 'provider-b' },
      { idempotencyKey: `provider-b:${String(input.externalTransactionId)}` },
    );
    expect(other.idempotentReplay).toBe(false);
    expect((await walletRow(wallet.id)).balance).toBe('50.00');
  });

  test('step 5: a twin that commits between the fast check and the lock makes this one a replay (one debit only)', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    let twin!: ProcessWagerResult;

    const result = await inTheWindow(
      db().uow,
      (gated) => submit(input, {}, build({ uow: gated })), // passa pela checagem rápida e para na porta
      async () => {
        twin = await submit(input); // o gêmeo termina antes: commitou o débito
        expect(twin.idempotentReplay).toBe(false);
      },
    );

    expect(result).toEqual({ ...twin, idempotentReplay: true });
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
    expect(await movements(wallet.id)).toHaveLength(1);
    await assertInvariants(sql, wallet.id);
  });

  test('step 5: the same key with another payload committed in the window is IDEMPOTENCY_KEY_REUSED', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);

    const error = await rejectionOf(
      inTheWindow(
        db().uow,
        (gated) =>
          submit(
            { ...input, money: { amount: '26.00', currency: 'BRL' } },
            { idempotencyKey: keyOf(input) },
            build({ uow: gated }),
          ),
        async () => {
          await submit(input);
        },
      ),
    );

    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
  });

  test('step 5: another key with the same external id committed in the window is EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);

    const error = await rejectionOf(
      inTheWindow(
        db().uow,
        (gated) =>
          submit(input, { idempotencyKey: 'slow-key' }, build({ uow: gated })),
        async () => {
          await submit(input);
        },
      ),
    );

    expect(error).toBeInstanceOf(ExternalIdConflictError);
    expect(await movements(wallet.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- passo 4: wallet inexistente

describe('ProcessWagerTransaction: step 4, the wallet does not exist', () => {
  test('is WALLET_NOT_FOUND, writes nothing, and the same key is processed again later (not a replay)', async () => {
    const ghostWallet = uuid();
    const playerId = uuid();
    const input = {
      ...body({ id: ghostWallet, playerId }),
      money: { amount: '25.00', currency: 'BRL' },
    };

    const error = await rejectionOf(submit(input));

    expect(error).toBeInstanceOf(WalletNotFoundError);
    expect(error).toMatchObject({
      code: FailureCode.WalletNotFound,
      walletId: ghostWallet,
    });
    expect(
      await count('wager_transactions', 'wallet_id = ?', [ghostWallet]),
    ).toBe(0);
    expect(
      await count('wager_transactions', 'idempotency_key = ?', [keyOf(input)]),
    ).toBe(0);
    expect(
      await count('outbox_messages', 'aggregate_id = ?', [ghostWallet]),
    ).toBe(0);

    // A wallet passa a existir com aquele id: a MESMA chave agora é processada, sem replay.
    await new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      new (class extends IdGenerator {
        private readonly ids = [ghostWallet, uuid(), uuid(), uuid()];
        next(): string {
          return this.ids.shift() as string;
        }
      })(),
    ).execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'x' },
    );

    const later = await submit(input);
    expect(later).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false,
    });
    expect(later.balance?.amount).toBe('75.00');
  });
});

// ---------------------------------------------------------------- atomicidade

describe('ProcessWagerTransaction: all or nothing', () => {
  async function expectUntouched(
    wallet: Wallet,
    input: Record<string, unknown>,
  ) {
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(
      await count('wager_transactions', 'idempotency_key = ?', [keyOf(input)]),
    ).toBe(0);
    expect(await movements(wallet.id)).toHaveLength(0);
    expect(await eventTypes(wallet.id)).toEqual([]);
  }

  test.each([
    [
      'ledger',
      (failure: Error) =>
        (r: Repositories): Repositories => ({
          ...r,
          ledger: { append: () => Promise.reject(failure) },
        }),
    ],
    [
      'outbox',
      (failure: Error) =>
        (r: Repositories): Repositories => ({
          ...r,
          outbox: { add: () => Promise.reject(failure) },
        }),
    ],
  ])(
    'if the %s insert fails, the wallet, the transaction and the ledger are undone and a retry works',
    async (_name, patch) => {
      const wallet = await walletWith('100.00');
      const input = body(wallet);
      const failure = new Error('boom');

      const error = await rejectionOf(
        submit(
          input,
          {},
          build({ uow: new UnitOfWorkWith(db().uow, patch(failure)) }),
        ),
      );

      expect(error).toBe(failure);
      await expectUntouched(wallet, input);

      const retry = await submit(input); // nada ficou preso: processa normalmente
      expect(retry).toMatchObject({
        status: WagerTransactionStatus.Processed,
        idempotentReplay: false,
      });
      expect(await movements(wallet.id)).toHaveLength(1);
      await assertInvariants(sql, wallet.id);
    },
  );

  test('if the wallet UPDATE finds another version, nothing is left (the version guard)', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const stale = new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      wallets: {
        lockById: (id) => r.wallets.lockById(id),
        insert: (w) => r.wallets.insert(w),
        save: (w, expected) => r.wallets.save(w, expected + 5),
      },
    }));
    const error = await rejectionOf(submit(input, {}, build({ uow: stale })));
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    await expectUntouched(wallet, input);
  });
});

// ---------------------------------------------------------------- inbox (SQS)

describe('ProcessWagerTransaction: when the message comes from SQS (inbox)', () => {
  const inbox = (messageId: string) => ({
    consumerName: 'wager-transactions-consumer',
    messageId,
  });

  test('the inbox row is written in the same transaction, processed, with the business hash', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const messageId = `msg-${uuid()}`;

    const result = await submit(input, { inbox: inbox(messageId) });

    const row = await one(
      'SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      ['wager-transactions-consumer', messageId],
    );
    expect(row.payload_hash).toBe(
      (await txRow(result.transactionId)).payload_hash,
    );
    expect(row.processed_at).not.toBeNull();
    expect(new Date(String(row.received_at)).toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  test('a REJECTED business outcome also consumes the message (a normal outcome, ack)', async () => {
    const wallet = await walletWith('1.00');
    const messageId = `msg-${uuid()}`;
    const result = await submit(body(wallet), { inbox: inbox(messageId) });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(
      1,
    );
  });

  test('the same message delivered again is a replay with no new effect and a single inbox row', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const messageId = `msg-${uuid()}`;
    const first = await submit(input, { inbox: inbox(messageId) });

    const again = await submit(input, { inbox: inbox(messageId) });

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(
      1,
    );
    expect(await movements(wallet.id)).toHaveLength(1);
    await assertInvariants(sql, wallet.id);
  });

  test('the same messageId with another payload is a producer bug: a permanent error, nothing written', async () => {
    const wallet = await walletWith('100.00');
    const messageId = `msg-${uuid()}`;
    await submit(body(wallet), { inbox: inbox(messageId) });
    const before = await walletRow(wallet.id);

    const error = await rejectionOf(
      submit(body(wallet), { inbox: inbox(messageId) }),
    );

    expect(error).toMatchObject({
      name: 'InboxMessageReusedError',
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
    expect(await walletRow(wallet.id)).toEqual(before);
    expect(await wagerRows(wallet.id)).toBe(1);
  });

  test('a failure leaves no inbox row, so the redelivery is processed from scratch', async () => {
    const ghost = { id: uuid(), playerId: uuid() };
    const messageId = `msg-${uuid()}`;
    const error = await rejectionOf(
      submit(body(ghost), { inbox: inbox(messageId) }),
    );
    expect(error).toBeInstanceOf(WalletNotFoundError);
    expect(await count('inbox_messages', 'message_id = ?', [messageId])).toBe(
      0,
    );
  });

  test('without inbox context (HTTP) no inbox row is written', async () => {
    const wallet = await walletWith('100.00');
    const before = Number(
      (await one('SELECT count(*)::int AS n FROM inbox_messages')).n,
    );
    await submit(body(wallet));
    expect(
      Number((await one('SELECT count(*)::int AS n FROM inbox_messages')).n),
    ).toBe(before);
  });
});

describe('ProcessWagerTransaction: the inbox is checked twice, like the idempotency key', () => {
  const inbox = (messageId: string) => ({
    consumerName: 'wager-transactions-consumer',
    messageId,
  });
  const inboxRows = (messageId: string) =>
    count('inbox_messages', 'message_id = ?', [messageId]);

  test('step 3: the same messageId with another payload is refused BEFORE any transaction is opened', async () => {
    const wallet = await walletWith('100.00');
    const messageId = `msg-${uuid()}`;
    await submit(body(wallet), { inbox: inbox(messageId) });

    const counting = new CountingUnitOfWork(db().uow);
    const error = await rejectionOf(
      submit(
        body(wallet),
        { inbox: inbox(messageId) },
        build({ uow: counting }),
      ),
    );

    expect(error).toMatchObject({ name: 'InboxMessageReusedError' });
    expect(counting.runs).toBe(0);
  });

  test('step 5: two deliveries of the SAME message at the same time: one processes, the other is a replay', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const messageId = `msg-${uuid()}`;
    // As duas passam juntas pelo passo 3 (nenhuma commitou ainda) e só depois disputam o lock.
    const [a, b] = await simultaneously(
      db().uow,
      (gate) =>
        submit(input, { inbox: inbox(messageId) }, build({ uow: gate })),
      (gate) =>
        submit(input, { inbox: inbox(messageId) }, build({ uow: gate })),
    );
    const results = [valueOf(a), valueOf(b)];

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(1);
    expect(results[0]?.transactionId).toBe(results[1]?.transactionId);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await movements(wallet.id)).toHaveLength(1); // um débito só
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('step 5: two deliveries of the same message with DIFFERENT payloads: one processes, the other is a producer bug', async () => {
    const wallet = await walletWith('100.00');
    const messageId = `msg-${uuid()}`;
    const idsA = new CountingIds();
    const idsB = new CountingIds();
    const outcomes = await simultaneously(
      db().uow,
      (gate) =>
        submit(
          body(wallet),
          { inbox: inbox(messageId) },
          build({ uow: gate, ids: idsA }),
        ),
      (gate) =>
        submit(
          body(wallet, { money: { amount: '40.00', currency: 'BRL' } }),
          { inbox: inbox(messageId) },
          build({ uow: gate, ids: idsB }),
        ),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const refusedIndex = outcomes.findIndex((o) => !o.ok);
    const refused = outcomes[refusedIndex];
    expect(refused && !refused.ok && refused.error).toMatchObject({
      name: 'InboxMessageReusedError',
    });
    expect(await inboxRows(messageId)).toBe(1);
    expect(await movements(wallet.id)).toHaveLength(1);
    await assertInvariants(sql, wallet.id);

    // A recusa vem da checagem sob o lock, ANTES de qualquer trabalho: quem foi recusado nem
    // chegou a pedir um id (não construiu a transação). Sem essa checagem o erro só viria no
    // fim, do INSERT da inbox, depois de decidir a política e gravar tudo (e desfazer).
    const refusedIds = refusedIndex === 0 ? idsA : idsB;
    expect(refusedIds.given).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- relógio e ids

describe('ProcessWagerTransaction: clock and ids', () => {
  test('uses the injected clock for every date it writes', async () => {
    const wallet = await walletWith('100.00');
    const result = await submit(body(wallet));
    const tx = await txRow(result.transactionId);
    const entry = (await movements(wallet.id))[0] as Row;
    const wallets = await one('SELECT updated_at FROM wallets WHERE id = ?', [
      wallet.id,
    ]);
    for (const value of [
      tx.created_at,
      tx.processed_at,
      entry.created_at,
      wallets.updated_at,
    ]) {
      expect(new Date(String(value)).toISOString()).toBe(NOW.toISOString());
    }
  });

  test('every id comes from the IdGenerator and all of them are different', async () => {
    const wallet = await walletWith('100.00');
    const given: string[] = [];
    const ids = new (class extends IdGenerator {
      next(): string {
        const id = uuid();
        given.push(id);
        return id;
      }
    })();
    const result = await submit(body(wallet), {}, build({ ids }));
    expect(new Set(given).size).toBe(given.length);
    expect(given).toContain(result.transactionId);
    const entry = (await movements(wallet.id))[0] as Row;
    expect(given).toContain(String(entry.id));
  });
});

// ---------------------------------------------------------------- fora deste commit

// ---------------------------------------------------------------- commit 5: REFUND e ROLLBACK

// Apoio: aposta, prêmio e reversão com os valores mais comuns (wallet de 100.00).
const externalOf = async (transactionId: string) =>
  String((await txRow(transactionId)).external_transaction_id);

async function placeBet(wallet: Wallet, amount = '25.00') {
  const result = await submit(
    body(wallet, { money: { amount, currency: 'BRL' } }),
  );
  expect(result.status).toBe(WagerTransactionStatus.Processed);
  return { ...result, external: await externalOf(result.transactionId) };
}

const winBody = (wallet: Wallet, betExternal: string, amount = '80.00') =>
  body(wallet, {
    kind: 'WIN',
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: betExternal,
  });

async function pay(wallet: Wallet, betExternal: string, amount = '80.00') {
  const result = await submit(winBody(wallet, betExternal, amount));
  expect(result.status).toBe(WagerTransactionStatus.Processed);
  return { ...result, external: await externalOf(result.transactionId) };
}

const reversalBody = (
  wallet: Wallet,
  kind: 'REFUND' | 'ROLLBACK',
  referenceExternal: string,
  amount = '25.00',
  overrides: Record<string, unknown> = {},
) =>
  body(wallet, {
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: referenceExternal,
    ...overrides,
  });

async function reverse(
  wallet: Wallet,
  kind: 'REFUND' | 'ROLLBACK',
  referenceExternal: string,
  amount = '25.00',
) {
  const result = await submit(
    reversalBody(wallet, kind, referenceExternal, amount),
  );
  return { ...result, external: await externalOf(result.transactionId) };
}

const directions = async (walletId: string) =>
  (await movements(walletId)).map((e) => String(e.direction));
const balanceOf = async (wallet: Wallet) =>
  String((await walletRow(wallet.id)).balance);
const eventsOf = async (walletId: string, transactionId: string) =>
  sql(
    `SELECT event_type, payload FROM outbox_messages
      WHERE aggregate_id = ? AND payload->'data'->>'transactionId' = ?
      ORDER BY event_type`,
    [walletId, transactionId],
  );

describe('ProcessWagerTransaction: REFUND', () => {
  test('of a PROCESSED BET credits the whole amount back and stores the resolved reference', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await txRow(refund.transactionId)).toMatchObject({
      kind: 'REFUND',
      status: 'PROCESSED',
      reference_transaction_id: bet.transactionId,
      reference_external_transaction_id: bet.external,
      balance_after: '100.00',
    });
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 3,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('writes WagerTransactionProcessed and WalletBalanceChanged (CREDIT)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    const events = await eventsOf(wallet.id, refund.transactionId);

    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const changed = (events[1] as Row).payload as { data: unknown };
    expect(changed.data).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '75.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 3,
    });
  });

  test('the replay answers with the balance of THAT day', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const input = reversalBody(wallet, 'REFUND', bet.external);
    const first = await submit(input);
    await placeBet(wallet, '30.00'); // o saldo de hoje já é 70.00

    const replay = await submit(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await balanceOf(wallet)).toBe('70.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT', 'DEBIT']); // um CREDIT só
  });

  test.each(['20.00', '30.00'])(
    'for %s instead of the BET amount is REJECTED AMOUNT_MISMATCH, and does not block the right one',
    async (amount) => {
      const wallet = await walletWith('100.00');
      const bet = await placeBet(wallet);

      const wrong = await submit(
        reversalBody(wallet, 'REFUND', bet.external, amount),
      );
      expect(wrong).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.AmountMismatch,
        balance: { amount: '75.00', currency: 'BRL' },
      });
      expect(await balanceOf(wallet)).toBe('75.00');

      // Só PROCESSED conta como reversão (ADR-0005): a rejeitada não trava a certa.
      const right = await submit(reversalBody(wallet, 'REFUND', bet.external));
      expect(right.status).toBe(WagerTransactionStatus.Processed);
      expect(await balanceOf(wallet)).toBe('100.00');
      await assertInvariants(sql, wallet.id);
    },
  );

  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'])(
    'of a %s is REJECTED REFERENCE_KIND_NOT_ALLOWED (a REFUND only reverses a BET)',
    async (kind) => {
      const wallet = await walletWith('100.00');
      let referenceExternal: string;
      if (kind === 'WIN') {
        const bet = await placeBet(wallet);
        referenceExternal = (await pay(wallet, bet.external, '10.00')).external;
      } else if (kind === 'LOSS') {
        const loss = await submit(
          body(wallet, {
            kind: 'LOSS',
            money: { amount: '0.00', currency: 'BRL' },
          }),
        );
        referenceExternal = await externalOf(loss.transactionId);
      } else {
        const bet = await placeBet(wallet);
        referenceExternal = (
          await reverse(wallet, kind as 'REFUND' | 'ROLLBACK', bet.external)
        ).external;
      }
      const before = await balanceOf(wallet);

      const result = await submit(
        reversalBody(wallet, 'REFUND', referenceExternal, '5.00'),
      );

      expect(result).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
      expect(await balanceOf(wallet)).toBe(before);
      await assertInvariants(sql, wallet.id);
    },
  );

  test('of a BET that was REJECTED is REJECTED REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await walletWith('100.00');
    const rejectedBet = await submit(
      body(wallet, { money: { amount: '999.00', currency: 'BRL' } }),
    );
    expect(rejectedBet.status).toBe(WagerTransactionStatus.Rejected);

    const result = await submit(
      reversalBody(
        wallet,
        'REFUND',
        await externalOf(rejectedBet.transactionId),
        '999.00',
      ),
    );

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  test('of a BET of another wallet is REJECTED REFERENCE_MISMATCH', async () => {
    const mine = await walletWith('100.00');
    const theirs = await walletWith('100.00');
    const theirBet = await placeBet(theirs);

    const result = await submit(
      reversalBody(mine, 'REFUND', theirBet.external),
    );

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
    expect(await balanceOf(mine)).toBe('100.00');
    expect(await balanceOf(theirs)).toBe('75.00'); // a wallet alheia nem foi tocada
  });

  test('of a BET of another round is REJECTED REFERENCE_MISMATCH', async () => {
    const wallet = await walletWith('100.00');
    const bet = await submit(body(wallet, { roundId: 'round-A' }));
    const result = await submit(
      reversalBody(
        wallet,
        'REFUND',
        await externalOf(bet.transactionId),
        '25.00',
        { roundId: 'round-B' },
      ),
    );
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('a second REFUND of the same BET (another external id) is REJECTED REFERENCE_ALREADY_REVERSED: credited once', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    await reverse(wallet, 'REFUND', bet.external);

    const again = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(again).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    await assertInvariants(sql, wallet.id);
  });

  test('after a ROLLBACK of the same BET is REJECTED REFERENCE_ALREADY_REVERSED (ADR-0005: one reversal, any kind)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    await reverse(wallet, 'ROLLBACK', bet.external);

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  test('needs no balance at all: a credit never fails for lack of funds', async () => {
    const wallet = await walletWith('25.00');
    const bet = await placeBet(wallet); // saldo 0.00
    expect(await balanceOf(wallet)).toBe('0.00');
    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('25.00');
  });
});

describe('ProcessWagerTransaction: REFERENCE_SETTLED (a settled BET cannot be reversed, ADR-0005 sister rule 2)', () => {
  test.each(['REFUND', 'ROLLBACK'] as const)(
    'a %s of a BET that has a PROCESSED WIN is REJECTED REFERENCE_SETTLED and moves nothing',
    async (kind) => {
      const wallet = await walletWith('100.00');
      const bet = await placeBet(wallet);
      await pay(wallet, bet.external, '80.00'); // saldo 155.00

      const result = await submit(reversalBody(wallet, kind, bet.external));

      expect(result).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceSettled,
        balance: { amount: '155.00', currency: 'BRL' },
      });
      expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
      expect(
        await eventsOf(wallet.id, result.transactionId).then((e) =>
          e.map((x) => x.event_type),
        ),
      ).toEqual(['WagerTransactionRejected']);
      await assertInvariants(sql, wallet.id);
    },
  );

  test('a WIN that was REJECTED paid nothing, so it does not settle the BET', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const rejectedWin = await submit(
      body(wallet, {
        kind: 'WIN',
        playerId: uuid(), // outro jogador: WALLET_PLAYER_MISMATCH, nada é pago
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.external,
      }),
    );
    expect(rejectedWin.status).toBe(WagerTransactionStatus.Rejected);

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  test('a WIN of 0.00 pays nothing, so it does not settle the BET (same criterion as a LOSS: settled = the player got money)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet); // 75.00
    const zero = await submit(winBody(wallet, bet.external, '0.00'));
    expect(zero).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('100.00');
    await assertInvariants(sql, wallet.id);
  });

  test('a WIN of 0.01 already settles the BET: any money paid counts', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    await pay(wallet, bet.external, '0.01'); // 75.01

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceSettled,
    });
    expect(await balanceOf(wallet)).toBe('75.01');
  });

  test('a WIN of 0.00 does not keep the BET locked forever, even though it can never be rolled back', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const zero = await pay(wallet, bet.external, '0.00');
    // Um WIN de 0.00 não tem o que desfazer: o ROLLBACK de valor zero nem é aceito como entrada.
    const rollbackOfZero = await rejectionOf(
      submit(reversalBody(wallet, 'ROLLBACK', zero.external, '0.00')),
    );
    expect(rollbackOfZero).toMatchObject({ code: FailureCode.InvalidAmount });
    // E, ainda assim, a BET pode ser devolvida.
    const rollback = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  });

  test('a LOSS does not settle the BET: BET + LOSS + REFUND is zero', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const loss = await submit(
      body(wallet, {
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.external,
      }),
    );
    expect(loss.status).toBe(WagerTransactionStatus.Processed);

    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('100.00');
    await assertInvariants(sql, wallet.id);
  });

  test('once the WIN is reversed the BET can be reversed again', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00'); // 155.00
    const blocked = await submit(reversalBody(wallet, 'REFUND', bet.external));
    expect(blocked.failureCode).toBe(FailureCode.ReferenceSettled);

    const undo = await reverse(wallet, 'ROLLBACK', win.external, '80.00'); // devolve o prêmio: 75.00
    expect(undo.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('75.00');
    const refund = await submit(reversalBody(wallet, 'REFUND', bet.external));

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual([
      'DEBIT',
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]);
    await assertInvariants(sql, wallet.id);
  });

  test('with SEVERAL WINs the BET stays settled until ALL of them are reversed', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet); // 75
    const first = await pay(wallet, bet.external, '40.00'); // 115
    const second = await pay(wallet, bet.external, '10.00'); // 125

    await reverse(wallet, 'ROLLBACK', first.external, '40.00'); // 85
    const stillBlocked = await submit(
      reversalBody(wallet, 'REFUND', bet.external),
    );
    expect(stillBlocked).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceSettled,
    });

    await reverse(wallet, 'ROLLBACK', second.external, '10.00'); // 75
    const allowed = await submit(reversalBody(wallet, 'REFUND', bet.external));
    expect(allowed.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('100.00');
    await assertInvariants(sql, wallet.id);
  });

  test('the replay of a REFERENCE_SETTLED rejection stays the same even after the WIN was reversed', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00');
    const input = reversalBody(wallet, 'REFUND', bet.external);
    const rejected = await submit(input);
    await reverse(wallet, 'ROLLBACK', win.external, '80.00'); // agora a BET poderia ser devolvida

    const replay = await submit(input);

    expect(replay).toEqual({ ...rejected, idempotentReplay: true });
    expect(replay.failureCode).toBe(FailureCode.ReferenceSettled);
    expect(replay.balance).toEqual({ amount: '155.00', currency: 'BRL' }); // o saldo da época
    // A rejeição é história; uma NOVA tentativa (outro id externo) agora passa.
    const fresh = await submit(reversalBody(wallet, 'REFUND', bet.external));
    expect(fresh.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe('ProcessWagerTransaction: ROLLBACK (the inverse of the reference)', () => {
  test('of a BET credits it back (the inverse of a DEBIT) and stores the reference', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const rollback = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external),
    );

    expect(rollback).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await txRow(rollback.transactionId)).toMatchObject({
      kind: 'ROLLBACK',
      reference_transaction_id: bet.transactionId,
    });
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    await assertInvariants(sql, wallet.id);
  });

  test('of a WIN debits the prize back (the inverse of a CREDIT)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00'); // 155.00

    const rollback = await submit(
      reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
    );

    expect(rollback).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT', 'DEBIT']);
    const changed = (await eventsOf(wallet.id, rollback.transactionId)).find(
      (e) => e.event_type === 'WalletBalanceChanged',
    );
    expect(changed).toBeDefined();
    expect(((changed as Row).payload as { data: unknown }).data).toMatchObject({
      direction: 'DEBIT',
      walletVersion: 4,
    });
    await assertInvariants(sql, wallet.id);
  });

  test('of a REFUND debits it back; the BET still cannot be refunded or rolled back again (ADR-0005)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const refund = await reverse(wallet, 'REFUND', bet.external); // 100.00

    const rollback = await submit(
      reversalBody(wallet, 'ROLLBACK', refund.external),
    );

    expect(rollback).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT', 'DEBIT']);

    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const again = await submit(reversalBody(wallet, kind, bet.external));
      expect(again).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceAlreadyReversed,
      });
    }
    expect(await balanceOf(wallet)).toBe('75.00');
    await assertInvariants(sql, wallet.id);
  });

  test('of a WIN the wallet can no longer cover is REJECTED REVERSAL_INSUFFICIENT_FUNDS (not INSUFFICIENT_FUNDS)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00'); // 155.00
    await placeBet(wallet, '140.00'); // gasta: sobram 15.00
    const input = reversalBody(wallet, 'ROLLBACK', win.external, '80.00');

    const result = await submit(input);

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
      balance: { amount: '15.00', currency: 'BRL' },
    });
    expect(await balanceOf(wallet)).toBe('15.00');
    const replay = await submit(input);
    expect(replay).toEqual({ ...result, idempotentReplay: true });
    await assertInvariants(sql, wallet.id);
  });

  test('of a BET needs no balance: the wallet at 0.00 gets the money back', async () => {
    const wallet = await walletWith('25.00');
    const bet = await placeBet(wallet);
    expect(await balanceOf(wallet)).toBe('0.00');
    const rollback = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('25.00');
  });

  test.each(['LOSS', 'ROLLBACK'])(
    'of a %s is REJECTED REFERENCE_KIND_NOT_ALLOWED',
    async (kind) => {
      const wallet = await walletWith('100.00');
      let referenceExternal: string;
      if (kind === 'LOSS') {
        const loss = await submit(
          body(wallet, {
            kind: 'LOSS',
            money: { amount: '0.00', currency: 'BRL' },
          }),
        );
        referenceExternal = await externalOf(loss.transactionId);
      } else {
        const bet = await placeBet(wallet);
        referenceExternal = (await reverse(wallet, 'ROLLBACK', bet.external))
          .external;
      }
      const result = await submit(
        reversalBody(wallet, 'ROLLBACK', referenceExternal, '5.00'),
      );
      expect(result).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    },
  );

  test('a second ROLLBACK of the same transaction is REJECTED REFERENCE_ALREADY_REVERSED: debited once', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00');
    await reverse(wallet, 'ROLLBACK', win.external, '80.00'); // 75.00

    const again = await submit(
      reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
    );

    expect(again).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await balanceOf(wallet)).toBe('75.00');
    await assertInvariants(sql, wallet.id);
  });

  test('for another amount is REJECTED AMOUNT_MISMATCH', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const result = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external, '24.99'),
    );
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.AmountMismatch,
    });
    expect(await balanceOf(wallet)).toBe('75.00');
  });

  test('the full chain: a settled BET is only reversible after its WIN, in order', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet); // 75
    const win = await pay(wallet, bet.external, '80.00'); // 155

    const tooEarly = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external),
    );
    expect(tooEarly.failureCode).toBe(FailureCode.ReferenceSettled);
    expect(await balanceOf(wallet)).toBe('155.00');

    const undoWin = await submit(
      reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
    );
    expect(undoWin.balance?.amount).toBe('75.00');
    const undoBet = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external),
    );
    expect(undoBet.balance?.amount).toBe('100.00');

    expect(await directions(wallet.id)).toEqual([
      'DEBIT',
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]);
    await assertInvariants(sql, wallet.id);
  });

  test('a rejected reversal writes only the Rejected event', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    const result = await submit(
      reversalBody(wallet, 'ROLLBACK', bet.external, '1.00'),
    );
    expect(
      (await eventsOf(wallet.id, result.transactionId)).map(
        (e) => e.event_type,
      ),
    ).toEqual(['WagerTransactionRejected']);
  });
});

// Quantas reversões (REFUND/ROLLBACK) PROCESSED apontam para esta transação.
const processedReversalsOf = (transactionId: string) =>
  count(
    'wager_transactions',
    `reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`,
    [transactionId],
  );

// Das duas requisições que disputaram: exatamente uma aplicada (PROCESSED) e a outra recusada
// como RESULTADO de negócio (REJECTED com o código esperado), não como erro.
function expectOneAppliedAndOneRefused(
  outcomes: Array<
    { ok: true; value: ProcessWagerResult } | { ok: false; error: unknown }
  >,
  refusalCode: FailureCode,
) {
  const results = outcomes.map((o) => valueOf(o));
  expect(
    results.filter((r) => r.status === WagerTransactionStatus.Processed),
  ).toHaveLength(1);
  const refused = results.filter(
    (r) => r.status === WagerTransactionStatus.Rejected,
  );
  expect(refused).toHaveLength(1);
  expect(refused[0]?.failureCode).toBe(refusalCode);
}

describe('ProcessWagerTransaction: reversals are decided UNDER THE LOCK (alreadyReversed and hasSettledWin)', () => {
  test('a WIN that commits between the fast check and the lock makes the REFUND REFERENCE_SETTLED', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const refund = await inTheWindow(
      db().uow,
      (gated) =>
        submit(
          reversalBody(wallet, 'REFUND', bet.external),
          {},
          build({ uow: gated }),
        ),
      async () => {
        // já passou pelos passos 1-3, ainda não travou: o prêmio commita na janela
        const win = await submit(winBody(wallet, bet.external));
        expect(win.status).toBe(WagerTransactionStatus.Processed);
      },
    );

    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceSettled,
    });
    expect(await balanceOf(wallet)).toBe('155.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    await assertInvariants(sql, wallet.id);
  });

  test('a REFUND that commits between the fast check and the lock makes the WIN REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const win = await inTheWindow(
      db().uow,
      (gated) =>
        submit(winBody(wallet, bet.external), {}, build({ uow: gated })),
      async () => {
        const refund = await submit(
          reversalBody(wallet, 'REFUND', bet.external),
        );
        expect(refund.status).toBe(WagerTransactionStatus.Processed);
      },
    );

    expect(win).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await balanceOf(wallet)).toBe('100.00'); // prêmio de aposta devolvida: não pagou
    await assertInvariants(sql, wallet.id);
  });

  test('a REFUND that commits in the window makes a second REFUND of the same BET REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const second = await inTheWindow(
      db().uow,
      (gated) =>
        submit(
          reversalBody(wallet, 'REFUND', bet.external),
          {},
          build({ uow: gated }),
        ),
      async () => {
        await submit(reversalBody(wallet, 'REFUND', bet.external)); // outro id externo, commita antes
      },
    );

    expect(second).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
  });

  test('a REFUND and a ROLLBACK of the same BET at the same time: exactly one is applied', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const outcomes = await simultaneously(
      db().uow,
      (gate) =>
        submit(
          reversalBody(wallet, 'REFUND', bet.external),
          {},
          build({ uow: gate }),
        ),
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', bet.external),
          {},
          build({ uow: gate }),
        ),
    );

    // 1. O DINHEIRO primeiro (nada disto pode falhar, qualquer que seja a forma do perdedor):
    //    devolvida UMA vez, uma só reversão PROCESSED, e as invariantes de pé.
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    expect(await processedReversalsOf(bet.transactionId)).toBe(1);
    await assertInvariants(sql, wallet.id);
    // 2. Depois, a forma: um aplicado, o outro rejeitado pela regra de negócio.
    expectOneAppliedAndOneRefused(
      outcomes,
      FailureCode.ReferenceAlreadyReversed,
    );
  });

  test('a REFUND and a WIN of the same BET at the same time: never both (no prize AND money back)', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const outcomes = await simultaneously(
      db().uow,
      (gate) =>
        submit(
          reversalBody(wallet, 'REFUND', bet.external),
          {},
          build({ uow: gate }),
        ),
      (gate) => submit(winBody(wallet, bet.external), {}, build({ uow: gate })),
    );

    // 1. O DINHEIRO primeiro: nunca o REFUND E o prêmio. Uma só das duas PROCESSED.
    const refundApplied = await count(
      'wager_transactions',
      `reference_transaction_id = ? AND kind = 'REFUND' AND status = 'PROCESSED'`,
      [bet.transactionId],
    );
    const winApplied = await count(
      'wager_transactions',
      `reference_transaction_id = ? AND kind = 'WIN' AND status = 'PROCESSED'`,
      [bet.transactionId],
    );
    expect(refundApplied + winApplied).toBe(1);
    expect(await balanceOf(wallet)).toBe(
      refundApplied === 1 ? '100.00' : '155.00',
    );
    await assertInvariants(sql, wallet.id);
    // 2. Depois, a forma: quem perdeu foi rejeitado pelo motivo certo.
    const [refundOutcome, winOutcome] = outcomes;
    if (refundApplied === 1) {
      expect(valueOf(winOutcome).failureCode).toBe(
        FailureCode.ReferenceAlreadyReversed,
      );
    } else {
      expect(valueOf(refundOutcome).failureCode).toBe(
        FailureCode.ReferenceSettled,
      );
    }
  });

  test('two ROLLBACKs of the same WIN at the same time debit it once (the wallet could afford BOTH, so only the rule separates them)', async () => {
    const wallet = await walletWith('300.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00'); // 355: cabem dois débitos de 80

    const outcomes = await simultaneously(
      db().uow,
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
          {},
          build({ uow: gate }),
        ),
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
          {},
          build({ uow: gate }),
        ),
    );

    // 1. O DINHEIRO primeiro: debitado UMA vez, uma só reversão PROCESSED.
    expect(await balanceOf(wallet)).toBe('275.00');
    expect(await processedReversalsOf(win.transactionId)).toBe(1);
    await assertInvariants(sql, wallet.id);
    // 2. Depois, a forma.
    expectOneAppliedAndOneRefused(
      outcomes,
      FailureCode.ReferenceAlreadyReversed,
    );
  });
});

// Se um dia a checagem de alreadyReversed sumir do código por engano, o ÍNDICE ÚNICO do banco
// (uq_wtx_reversed_once, ADR-0005) ainda impede o segundo crédito: o perdedor FALHA (23505), não
// credita. Aqui a checagem é desligada de propósito, só para provar a última linha de defesa.
describe('ProcessWagerTransaction: the unique index is the LAST line of defense for reversals', () => {
  // O UnitOfWork de verdade, mas com hasProcessedReversal sempre "não": o bug que o índice cobre.
  const withoutTheCheck = () =>
    new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      transactions: Object.assign(
        Object.create(r.transactions) as typeof r.transactions,
        {
          hasProcessedReversal: () => Promise.resolve(false),
        },
      ),
    }));

  test('a REFUND and a ROLLBACK at the same time: the loser FAILS with 23505 and does not credit', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const outcomes = await simultaneously(
      withoutTheCheck(),
      (gate) =>
        submit(
          reversalBody(wallet, 'REFUND', bet.external),
          {},
          build({ uow: gate }),
        ),
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', bet.external),
          {},
          build({ uow: gate }),
        ),
    );

    // O dinheiro: devolvido UMA vez, mesmo sem a checagem.
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    expect(await processedReversalsOf(bet.transactionId)).toBe(1);
    await assertInvariants(sql, wallet.id);
    // O perdedor falhou (e o rollback desfez tudo dele), não foi "rejeitado": é o banco falando.
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok);
    expect(loser && !loser.ok && loser.error).toBeInstanceOf(DuplicateKeyError);
    expect(loser && !loser.ok && loser.error).toMatchObject({
      constraint: 'uq_wtx_reversed_once',
    });
    // Nada do perdedor ficou: só a BET e a reversão que venceu apontam para ela.
    expect(
      await count('wager_transactions', 'reference_transaction_id = ?', [
        bet.transactionId,
      ]),
    ).toBe(1);
  });

  test('two ROLLBACKs of the same WIN (balance for both): the loser FAILS with 23505 and does not debit twice', async () => {
    const wallet = await walletWith('300.00');
    const bet = await placeBet(wallet);
    const win = await pay(wallet, bet.external, '80.00'); // 355

    const outcomes = await simultaneously(
      withoutTheCheck(),
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
          {},
          build({ uow: gate }),
        ),
      (gate) =>
        submit(
          reversalBody(wallet, 'ROLLBACK', win.external, '80.00'),
          {},
          build({ uow: gate }),
        ),
    );

    expect(await balanceOf(wallet)).toBe('275.00'); // debitado UMA vez
    expect(await processedReversalsOf(win.transactionId)).toBe(1);
    await assertInvariants(sql, wallet.id);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok);
    expect(loser && !loser.ok && loser.error).toBeInstanceOf(DuplicateKeyError);
    expect(loser && !loser.ok && loser.error).toMatchObject({
      constraint: 'uq_wtx_reversed_once',
    });
  });

  test('a second REFUND that commits in the window: the loser FAILS with 23505 and does not credit', async () => {
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);

    const error = await rejectionOf(
      inTheWindow(
        withoutTheCheck(),
        (gated) =>
          submit(
            reversalBody(wallet, 'REFUND', bet.external),
            {},
            build({ uow: gated }),
          ),
        async () => {
          await submit(
            reversalBody(wallet, 'REFUND', bet.external),
            {},
            build({ uow: withoutTheCheck() }),
          );
        },
      ),
    );

    expect(error).toBeInstanceOf(DuplicateKeyError);
    expect(error).toMatchObject({ constraint: 'uq_wtx_reversed_once' });
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await directions(wallet.id)).toEqual(['DEBIT', 'CREDIT']);
    await assertInvariants(sql, wallet.id);
  });

  test('the limit of the index: it covers a reversal against a reversal, NOT a WIN after a reversal', async () => {
    // Por isso a checagem existe: o índice só olha REFUND e ROLLBACK. Sem ela, um WIN sobre uma
    // BET já devolvida passaria (a regra irmã 1 do ADR-0005 é só do código).
    const wallet = await walletWith('100.00');
    const bet = await placeBet(wallet);
    await submit(reversalBody(wallet, 'REFUND', bet.external)); // 100.00

    const win = await submit(
      winBody(wallet, bet.external),
      {},
      build({ uow: withoutTheCheck() }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed); // o que a checagem normalmente impede
    expect(await balanceOf(wallet)).toBe('180.00');
  });
});
