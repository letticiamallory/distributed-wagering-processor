import { describe, expect, test } from 'bun:test';
import {
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
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { computePayloadHash } from '../../src/domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import { rejectionOf } from '../support/assertions.js';
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

// Para na porta da transação, para o teste fazer outra requisição passar no meio (a janela
// entre a checagem rápida e o lock).
class GatedUnitOfWork extends UnitOfWork {
  readonly reached: Promise<void>;
  private markReached!: () => void;
  private open!: () => void;
  private readonly gate: Promise<void>;
  constructor(private readonly inner: UnitOfWork) {
    super();
    this.reached = new Promise((resolve) => (this.markReached = resolve));
    this.gate = new Promise((resolve) => (this.open = resolve));
  }
  release(): void {
    this.open();
  }
  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.markReached();
    await this.gate;
    return this.inner.run(work);
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

describe("ProcessWagerTransaction: several WINs for the same BET (documents today's behavior)", () => {
  // Nenhuma regra da política nem do schema limita quantos WINs apontam para a mesma BET (o
  // índice único de referência só cobre REFUND e ROLLBACK). Este teste NÃO decide que deve ser
  // assim: registra o que acontece hoje, para uma mudança futura ser consciente.
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

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    const holder = db().uow.run(async (r) => {
      await r.wallets.lockById(wallet.id);
      locked();
      await hold;
    });
    await hasLock;

    const started = performance.now();
    const replay = await submit(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);

    release();
    await holder;
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
    const gated = new GatedUnitOfWork(db().uow);

    const slow = submit(input, {}, build({ uow: gated })); // passa pela checagem rápida e para na porta
    await gated.reached;
    const twin = await submit(input); // o gêmeo termina antes: commitou o débito
    expect(twin.idempotentReplay).toBe(false);
    gated.release();
    const result = await slow;

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
    const gated = new GatedUnitOfWork(db().uow);

    const slow = submit(
      { ...input, money: { amount: '26.00', currency: 'BRL' } },
      { idempotencyKey: keyOf(input) },
      build({ uow: gated }),
    );
    await gated.reached;
    await submit(input);
    gated.release();

    expect(await rejectionOf(slow)).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '75.00',
      version: 2,
    });
  });

  test('step 5: another key with the same external id committed in the window is EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet);
    const gated = new GatedUnitOfWork(db().uow);

    const slow = submit(
      input,
      { idempotencyKey: 'slow-key' },
      build({ uow: gated }),
    );
    await gated.reached;
    await submit(input);
    gated.release();

    expect(await rejectionOf(slow)).toBeInstanceOf(ExternalIdConflictError);
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
    const gateA = new GatedUnitOfWork(db().uow);
    const gateB = new GatedUnitOfWork(db().uow);
    const a = submit(input, { inbox: inbox(messageId) }, build({ uow: gateA }));
    const b = submit(input, { inbox: inbox(messageId) }, build({ uow: gateB }));
    await Promise.all([gateA.reached, gateB.reached]);
    gateA.release();
    gateB.release();
    const results = await Promise.all([a, b]);

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
    const gateA = new GatedUnitOfWork(db().uow);
    const gateB = new GatedUnitOfWork(db().uow);
    const idsA = new CountingIds();
    const idsB = new CountingIds();
    const a = submit(
      body(wallet),
      { inbox: inbox(messageId) },
      build({ uow: gateA, ids: idsA }),
    );
    const b = submit(
      body(wallet, { money: { amount: '40.00', currency: 'BRL' } }),
      { inbox: inbox(messageId) },
      build({ uow: gateB, ids: idsB }),
    );
    await Promise.all([gateA.reached, gateB.reached]);
    gateA.release();
    gateB.release();
    const outcomes = await Promise.allSettled([a, b]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected');
    expect(refused).toBeDefined();
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      name: 'InboxMessageReusedError',
    });
    expect(await inboxRows(messageId)).toBe(1);
    expect(await movements(wallet.id)).toHaveLength(1);
    await assertInvariants(sql, wallet.id);

    // A recusa vem da checagem sob o lock, ANTES de qualquer trabalho: quem foi recusado nem
    // chegou a pedir um id (não construiu a transação). Sem essa checagem o erro só viria no
    // fim, do INSERT da inbox, depois de decidir a política e gravar tudo (e desfazer).
    const refusedIndex = outcomes.findIndex((o) => o.status === 'rejected');
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

describe('ProcessWagerTransaction: not supported yet (explicit errors, removed in commits 5 and 6)', () => {
  test.each(['REFUND', 'ROLLBACK'])(
    '%s fails loudly instead of being applied without its rules, and writes nothing',
    async (kind) => {
      const wallet = await walletWith('100.00');
      const bet = await submit(body(wallet));
      const betExternal = String(
        (await txRow(bet.transactionId)).external_transaction_id,
      );
      const before = await walletRow(wallet.id);

      const error = await rejectionOf(
        submit(
          body(wallet, { kind, referenceExternalTransactionId: betExternal }),
        ),
      );

      expect(error).toMatchObject({
        name: 'NotSupportedYetError',
        code: 'INTERNAL_ERROR',
      });
      expect(await walletRow(wallet.id)).toEqual(before);
      expect(await wagerRows(wallet.id)).toBe(1); // só a BET
    },
  );

  test('a WIN whose reference does not exist yet fails loudly (PENDING_REFERENCE is commit 6) and writes nothing', async () => {
    const wallet = await walletWith('100.00');
    const input = body(wallet, {
      kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-that-never-arrived',
    });

    const error = await rejectionOf(submit(input));

    expect(error).toMatchObject({ name: 'NotSupportedYetError' });
    expect(await wagerRows(wallet.id)).toBe(0);
    expect(await walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
  });
});

describe('ProcessWagerTransaction: left for the next commits (todo)', () => {
  // Commit 5
  test.todo(
    'REFUND of a BET credits the wallet and stores the resolved reference',
  );
  test.todo(
    'ROLLBACK of a BET, of a WIN and of a REFUND (direction is the inverse of the reference)',
  );
  test.todo(
    'a second reversal of the same transaction is REFERENCE_ALREADY_REVERSED',
  );
  test.todo(
    'REFUND/ROLLBACK of a BET that has a settled WIN is REFERENCE_SETTLED',
  );
  test.todo('ROLLBACK of a WIN without balance is REVERSAL_INSUFFICIENT_FUNDS');
  // Commit 6
  test.todo(
    'a reference that does not exist yet is PENDING_REFERENCE (202) and writes the pending event',
  );
  test.todo(
    'a PROCESSED transaction wakes the PENDING_REFERENCE ones waiting for its external id',
  );
  test.todo(
    'same key with another walletId: the 23505 race (both constraints) reruns once and answers 409',
  );
  test.todo(
    'lock_timeout, deadlock, connection and full pool become DependencyUnavailableError (503)',
  );
});
