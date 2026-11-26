import { describe, expect, test } from 'bun:test';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import {
  DuplicateKeyError,
  InvalidCommandError,
  WalletAlreadyExistsError,
} from '../../src/application/errors/application-errors.js';
import { Clock } from '../../src/application/ports/clock.js';
import { IdGenerator } from '../../src/application/ports/id-generator.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { Money } from '../../src/domain/money/money.js';
import { computePayloadHash } from '../../src/domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import { rejectionOf } from '../support/assertions.js';
import { usePersistence, uuid } from '../support/persistence.js';

const db = usePersistence();

type Row = Record<string, unknown>;
const query = (sql: string, params: unknown[] = []) =>
  db().orm.em.getConnection().execute(sql, params) as Promise<Row[]>;
const one = async (sql: string, params: unknown[] = []): Promise<Row> => {
  const rows = await query(sql, params);
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

// Entrega os ids na ordem; falha alto se o caso de uso pedir mais do que o esperado.
class SequenceIds extends IdGenerator {
  private readonly pending: string[];
  readonly given: string[] = [];
  constructor(ids: string[]) {
    super();
    this.pending = [...ids];
  }
  next(): string {
    const id = this.pending.shift();
    if (!id) throw new Error('the use case asked for more ids than expected');
    this.given.push(id);
    return id;
  }
}

// O UnitOfWork de verdade, mas com o INSERT do ledger quebrado: tudo que veio antes (a wallet
// e a transação OPENING) já foi gravado no Postgres real dentro da transação aberta.
class UnitOfWorkWithBrokenLedger extends UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly failure: Error,
  ) {
    super();
  }
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run((repositories) =>
      work({
        ...repositories,
        ledger: { append: () => Promise.reject(this.failure) },
      }),
    );
  }
}

const NOW = new Date('2026-11-26T09:30:00.000Z');
const input = (playerId: string, amount = '1000.00', currency = 'BRL') => ({
  playerId,
  initialBalance: { amount, currency },
});
const ctx = { correlationId: 'corr-create-wallet' };
const realUseCase = () =>
  new CreateWalletUseCase(db().uow, new FixedClock(NOW), new UuidV7Generator());

describe('CreateWalletUseCase: wallet with an initial balance', () => {
  test('creates the wallet at version 1 with the initial balance, and answers with it', async () => {
    const playerId = uuid();
    const result = await realUseCase().execute(input(playerId), ctx);

    expect(result.playerId).toBe(playerId);
    expect(result.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(result.version).toBe(1);

    const row = await one('SELECT * FROM wallets WHERE id = ?', [result.id]);
    expect(row).toMatchObject({
      player_id: playerId,
      currency: 'BRL',
      balance: '1000.00',
      version: 1,
    });
  });

  test('creates the OPENING transaction already PROCESSED, internal, in the same database', async () => {
    const playerId = uuid();
    const result = await realUseCase().execute(input(playerId, '250.50'), ctx);

    const tx = await one(
      'SELECT * FROM wager_transactions WHERE wallet_id = ?',
      [result.id],
    );
    expect(tx).toMatchObject({
      provider_id: 'internal',
      player_id: playerId, // o dono da wallet, não qualquer id
      wallet_id: result.id,
      external_transaction_id: result.id,
      idempotency_key: `internal:opening:${result.id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '250.50',
      currency: 'BRL',
      balance_after: '250.50',
      round_id: 'opening',
      game_id: 'opening',
      correlation_id: 'corr-create-wallet',
      failure_code: null,
      reference_transaction_id: null,
    });
    // O hash da abertura é o canônico dos campos da OPENING (ADR-0008), não um texto qualquer.
    expect(tx.payload_hash).toBe(
      computePayloadHash({
        providerId: 'internal',
        externalTransactionId: result.id,
        playerId,
        walletId: result.id,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: '250.50', currency: 'BRL' }),
      }),
    );
    expect(new Date(String(tx.processed_at)).toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  test('creates the CREDIT ledger entry that explains the balance', async () => {
    const result = await realUseCase().execute(input(uuid(), '1000.00'), ctx);
    const tx = await one(
      'SELECT id FROM wager_transactions WHERE wallet_id = ?',
      [result.id],
    );

    const entries = await query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = ?',
      [result.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transaction_id: tx.id,
      direction: 'CREDIT',
      amount: '1000.00',
      currency: 'BRL',
      balance_before: '0.00',
      balance_after: '1000.00',
      wallet_version: 1,
    });
    // O invariante que a Fase 4 vai conferir sempre: saldo da wallet = último lançamento.
    const wallet = await one(
      'SELECT balance, version FROM wallets WHERE id = ?',
      [result.id],
    );
    expect(wallet.balance).toBe(entries[0]?.balance_after);
    expect(wallet.version).toBe(entries[0]?.wallet_version);
  });

  test('puts exactly one WalletBalanceChanged in the outbox, and nothing is published', async () => {
    const result = await realUseCase().execute(input(uuid(), '75.25'), ctx);
    const tx = await one(
      'SELECT id FROM wager_transactions WHERE wallet_id = ?',
      [result.id],
    );

    const events = await query(
      'SELECT * FROM outbox_messages WHERE aggregate_id = ?',
      [result.id],
    );
    expect(events).toHaveLength(1);
    const event = events[0] as Row;
    expect(event).toMatchObject({
      event_type: 'WalletBalanceChanged',
      attempts: 0,
      published_at: null,
    });
    const payload = event.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      eventId: event.id,
      eventType: 'WalletBalanceChanged',
      aggregateId: result.id,
      correlationId: 'corr-create-wallet',
      causationId: tx.id,
      version: 1,
      occurredAt: NOW.toISOString(),
    });
    // Dinheiro como string decimal, nunca number.
    expect(payload.data).toEqual({
      walletId: result.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      money: { amount: '75.25', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '75.25', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('uses the injected clock and the injected ids, and every id is different', async () => {
    const ids = Array.from({ length: 4 }, () => uuid());
    const sequence = new SequenceIds(ids);
    const useCase = new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      sequence,
    );

    const result = await useCase.execute(input(uuid()), ctx);

    expect(new Set(sequence.given).size).toBe(sequence.given.length);
    expect(ids).toContain(result.id);
    const tx = await one(
      'SELECT id, created_at FROM wager_transactions WHERE wallet_id = ?',
      [result.id],
    );
    const entry = await one(
      'SELECT id, created_at FROM wallet_ledger_entries WHERE wallet_id = ?',
      [result.id],
    );
    const event = await one(
      'SELECT id FROM outbox_messages WHERE aggregate_id = ?',
      [result.id],
    );
    for (const id of [result.id, tx.id, entry.id, event.id]) {
      expect(ids).toContain(id as string);
    }
    expect(new Set([result.id, tx.id, entry.id, event.id]).size).toBe(4);
    expect(new Date(String(tx.created_at)).toISOString()).toBe(
      NOW.toISOString(),
    );
    expect(new Date(String(entry.created_at)).toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  test.each(['0.01', '0.10', '9999999999999999.99', '1234567.89'])(
    'the amount %s stays exact end to end (a decimal string, never a number)',
    async (amount) => {
      const result = await realUseCase().execute(input(uuid(), amount), ctx);
      expect(result.balance.amount).toBe(amount);
      const wallet = await one('SELECT balance FROM wallets WHERE id = ?', [
        result.id,
      ]);
      const entry = await one(
        'SELECT amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
        [result.id],
      );
      expect(wallet.balance).toBe(amount);
      expect(entry).toMatchObject({ amount, balance_after: amount });
    },
  );

  test('the same player can have a wallet in another currency', async () => {
    const playerId = uuid();
    const brl = await realUseCase().execute(
      input(playerId, '10.00', 'BRL'),
      ctx,
    );
    const usd = await realUseCase().execute(
      input(playerId, '5.00', 'USD'),
      ctx,
    );
    expect(brl.id).not.toBe(usd.id);
    expect(usd.balance).toEqual({ amount: '5.00', currency: 'USD' });
    const entry = await one(
      'SELECT currency FROM wallet_ledger_entries WHERE wallet_id = ?',
      [usd.id],
    );
    expect(entry.currency).toBe('USD');
  });
});

describe('CreateWalletUseCase: zero initial balance', () => {
  test('is allowed: the wallet exists at version 1, with no OPENING, no ledger entry and no event', async () => {
    const result = await realUseCase().execute(input(uuid(), '0.00'), ctx);

    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.version).toBe(1);
    const wallet = await one(
      'SELECT balance, version FROM wallets WHERE id = ?',
      [result.id],
    );
    expect(wallet).toMatchObject({ balance: '0.00', version: 1 });
    expect(
      await count('wager_transactions', 'wallet_id = ?', [result.id]),
    ).toBe(0);
    expect(
      await count('wallet_ledger_entries', 'wallet_id = ?', [result.id]),
    ).toBe(0);
    expect(
      await count('outbox_messages', 'aggregate_id = ?', [result.id]),
    ).toBe(0);
  });

  test('asks the IdGenerator only for what it needs (just the wallet id)', async () => {
    const sequence = new SequenceIds([uuid()]);
    await new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      sequence,
    ).execute(input(uuid(), '0.00'), ctx);
    expect(sequence.given).toHaveLength(1);
  });
});

describe('CreateWalletUseCase: input the domain refuses', () => {
  const nothingWritten = async (playerId: string) =>
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(0);

  test.each(['-1.00', '-0.01', '-1000.00'])(
    'a negative balance (%s) is INVALID_AMOUNT and writes nothing',
    async (amount) => {
      const playerId = uuid();
      const error = await rejectionOf(
        realUseCase().execute(input(playerId, amount), ctx),
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(error).toMatchObject({ code: FailureCode.InvalidAmount });
      await nothingWritten(playerId);
    },
  );

  test.each([
    '10',
    '10.5',
    '10.005',
    '1e3',
    'NaN',
    'Infinity',
    ' 10.00',
    '10000000000000000.00',
    '',
  ])('the amount %p is INVALID_AMOUNT and writes nothing', async (amount) => {
    const playerId = uuid();
    const error = await rejectionOf(
      realUseCase().execute(input(playerId, amount), ctx),
    );
    expect(error).toMatchObject({ code: FailureCode.InvalidAmount });
    await nothingWritten(playerId);
  });

  test('an amount that is a JSON number is INVALID_PAYLOAD: money is never a number', async () => {
    const playerId = uuid();
    const error = await rejectionOf(
      realUseCase().execute(
        { playerId, initialBalance: { amount: 1000, currency: 'BRL' } },
        ctx,
      ),
    );
    expect(error).toMatchObject({ code: FailureCode.InvalidPayload });
    await nothingWritten(playerId);
  });

  test.each(['brl', 'BR', 'BRLL', 'R$', '', '123'])(
    'the currency %p is refused and writes nothing',
    async (currency) => {
      const playerId = uuid();
      const error = await rejectionOf(
        realUseCase().execute(input(playerId, '10.00', currency), ctx),
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      await nothingWritten(playerId);
    },
  );

  test.each([
    ['a body that is not an object', 'nope'],
    ['no playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['a playerId that is not a UUID', input('player-1')],
    ['no initialBalance', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' }],
  ])('%s is INVALID_PAYLOAD', async (_label, body) => {
    const error = await rejectionOf(realUseCase().execute(body, ctx));
    expect(error).toMatchObject({ code: FailureCode.InvalidPayload });
  });
});

describe('CreateWalletUseCase: a second wallet for the same player and currency', () => {
  test('is WalletAlreadyExistsError, and the first wallet is left exactly as it was', async () => {
    const playerId = uuid();
    const first = await realUseCase().execute(input(playerId, '100.00'), ctx);

    const sequence = new SequenceIds([uuid(), uuid(), uuid(), uuid()]);
    const second = new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      sequence,
    );
    const error = await rejectionOf(
      second.execute(input(playerId, '999.00'), ctx),
    );

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      playerId,
      currency: 'BRL',
    });

    // A primeira wallet continua inteira, com uma só abertura, um só lançamento, um só evento.
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(1);
    expect(
      await one('SELECT balance FROM wallets WHERE id = ?', [first.id]),
    ).toMatchObject({ balance: '100.00' });
    expect(await count('wager_transactions', 'wallet_id = ?', [first.id])).toBe(
      1,
    );
    expect(
      await count('wallet_ledger_entries', 'wallet_id = ?', [first.id]),
    ).toBe(1);
    expect(await count('outbox_messages', 'aggregate_id = ?', [first.id])).toBe(
      1,
    );
    // E o que a segunda tentativa teria gravado não existe: nem wallet, nem transação, nem evento.
    for (const id of sequence.given) {
      expect(await count('wallets', 'id = ?', [id])).toBe(0);
      expect(await count('wager_transactions', 'id = ?', [id])).toBe(0);
      expect(await count('outbox_messages', 'id = ?', [id])).toBe(0);
    }
  });
});

describe('CreateWalletUseCase: all or nothing', () => {
  const nothingLeft = async (
    walletId: string,
    playerId: string,
    eventId?: string,
  ) => {
    expect(await count('wallets', 'id = ?', [walletId])).toBe(0);
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(0);
    expect(await count('wager_transactions', 'wallet_id = ?', [walletId])).toBe(
      0,
    );
    expect(
      await count('wallet_ledger_entries', 'wallet_id = ?', [walletId]),
    ).toBe(0);
    expect(await count('outbox_messages', 'aggregate_id = ?', [walletId])).toBe(
      0,
    );
    if (eventId)
      expect(await count('outbox_messages', 'id = ?', [eventId])).toBe(0);
  };

  test('if the ledger insert fails, no wallet and no OPENING transaction are left', async () => {
    const playerId = uuid();
    const [walletId, txId, entryId, eventId] = [
      uuid(),
      uuid(),
      uuid(),
      uuid(),
    ] as [string, string, string, string];
    const failure = new Error('ledger insert failed');
    const useCase = new CreateWalletUseCase(
      new UnitOfWorkWithBrokenLedger(db().uow, failure),
      new FixedClock(NOW),
      new SequenceIds([walletId, txId, entryId, eventId]),
    );

    const error = await rejectionOf(useCase.execute(input(playerId), ctx));

    expect(error).toBe(failure); // o erro original chega intacto a quem chamou
    await nothingLeft(walletId, playerId, eventId);
    expect(await count('wager_transactions', 'id = ?', [txId])).toBe(0);
  });

  test('a REAL database failure at the ledger insert (primary key already taken) rolls everything back too', async () => {
    // A primeira wallet cria um lançamento com um id conhecido. A segunda tenta reusar o MESMO
    // id de lançamento: o Postgres recusa o INSERT do ledger (23505), depois de a wallet e a
    // transação já terem sido gravadas dentro da transação aberta. Ordem dos ids pedidos pelo
    // caso de uso: wallet, transação OPENING, lançamento, evento.
    const takenEntryId = uuid();
    await new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      new SequenceIds([uuid(), uuid(), takenEntryId, uuid()]),
    ).execute(input(uuid()), ctx);

    const playerId = uuid();
    const [walletId, txId, eventId] = [uuid(), uuid(), uuid()] as [
      string,
      string,
      string,
    ];
    const useCase = new CreateWalletUseCase(
      db().uow,
      new FixedClock(NOW),
      new SequenceIds([walletId, txId, takenEntryId, eventId]),
    );

    const error = await rejectionOf(useCase.execute(input(playerId), ctx));

    expect(error).toBeInstanceOf(DuplicateKeyError);
    await nothingLeft(walletId, playerId, eventId);
    expect(await count('wager_transactions', 'id = ?', [txId])).toBe(0);
  });

  test('after a failure the player can create the wallet normally (nothing was left blocking)', async () => {
    const playerId = uuid();
    const broken = new CreateWalletUseCase(
      new UnitOfWorkWithBrokenLedger(db().uow, new Error('boom')),
      new FixedClock(NOW),
      new UuidV7Generator(),
    );
    await rejectionOf(broken.execute(input(playerId), ctx));

    const result = await realUseCase().execute(input(playerId, '30.00'), ctx);
    expect(result.balance.amount).toBe('30.00');
    expect(await count('wallets', 'player_id = ?', [playerId])).toBe(1);
    expect(
      await count('wallet_ledger_entries', 'wallet_id = ?', [result.id]),
    ).toBe(1);
  });

  test('if the outbox insert fails, the wallet, the OPENING and the ledger entry are also undone', async () => {
    const playerId = uuid();
    const walletId = uuid();
    const failure = new Error('outbox insert failed');
    const brokenOutbox = new (class extends UnitOfWork {
      run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
        return db().uow.run((repositories) =>
          work({
            ...repositories,
            outbox: Object.assign(
              Object.create(repositories.outbox) as typeof repositories.outbox,
              {
                add: () => Promise.reject(failure),
              },
            ),
          }),
        );
      }
    })();
    const useCase = new CreateWalletUseCase(
      brokenOutbox,
      new FixedClock(NOW),
      new SequenceIds([walletId, uuid(), uuid(), uuid()]),
    );

    const error = await rejectionOf(useCase.execute(input(playerId), ctx));

    expect(error).toBe(failure);
    await nothingLeft(walletId, playerId);
  });
});
