import { describe, expect, test } from 'bun:test';
import { holding } from '../support/concurrency.js';
import { rejectionOf } from '../support/assertions.js';
import {
  DependencyUnavailableError,
  DuplicateKeyError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';
import {
  brl,
  newTransaction,
  newWallet,
  openPersistence,
  persistWallet,
  T1,
  usePersistence,
  uuid,
} from '../support/persistence.js';

const db = usePersistence();

describe('UnitOfWork: one transaction, one COMMIT', () => {
  test('returns what the work returns', async () => {
    expect(await db().uow.run(async () => 42)).toBe(42);
  });

  test('when the work throws, everything it wrote is undone and the error is the same', async () => {
    const wallet = newWallet('10.00');
    const failure = new WalletNotFoundError('x');
    const attempt = db().uow.run(async (r) => {
      await r.wallets.insert(wallet);
      throw failure;
    });
    expect(await rejectionOf(attempt)).toBe(failure);
    expect(
      await db().uow.run(async (r) => r.wallets.lockById(wallet.id)),
    ).toBeUndefined();
  });

  test('every repository shares the same transaction: a late failure undoes the early writes', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const first = newTransaction(wallet);
    first.markProcessed({ balanceAfter: brl('75.00'), at: T1 });
    const duplicate = newTransaction(wallet, {
      idempotencyKey: first.idempotencyKey,
    });
    duplicate.markProcessed({ balanceAfter: brl('75.00'), at: T1 });

    const attempt = db().uow.run(async (r) => {
      await r.transactions.insert(first);
      await r.transactions.insert(duplicate); // viola uq_wtx_idempotency_key
    });
    expect(await rejectionOf(attempt)).toBeInstanceOf(DuplicateKeyError);
    // O primeiro insert, que tinha dado certo, também foi desfeito.
    expect(await db().reader.findById(first.id)).toBeUndefined();
  });

  test('writes are invisible to others until the COMMIT', async () => {
    const wallet = newWallet('100.00');
    await persistWallet(db().uow, wallet);
    const tx = newTransaction(wallet);
    tx.markProcessed({ balanceAfter: brl('75.00'), at: T1 });

    let seenBeforeCommit: unknown = 'not checked';
    await db().uow.run(async (r) => {
      await r.transactions.insert(tx);
      seenBeforeCommit = await db().reader.findById(tx.id);
    });
    expect(seenBeforeCommit).toBeUndefined();
    expect(await db().reader.findById(tx.id)).toBeDefined();
  });

  test('lock_timeout is configured per transaction (SET LOCAL) and does not leak to the connection', async () => {
    const short = await openPersistence({ lockTimeoutMs: 7_000 });
    try {
      await short.uow.run(async (r) => r.wallets.lockById(uuid()));
      expect(
        short.queries.some(
          (q) => /set local lock_timeout/i.test(q) && /7000/.test(q),
        ),
      ).toBe(true);
      // SET LOCAL morre com o COMMIT: a conexão volta ao pool sem o limite.
      const rows = (await short.orm.em
        .getConnection()
        .execute('SHOW lock_timeout')) as Array<{
        lock_timeout: string;
      }>;
      expect(rows[0]?.lock_timeout).toBe('0');
    } finally {
      await short.close();
    }
  });

  test('the ledger repository only knows how to append', () => {
    expect(
      Object.getOwnPropertyNames(MikroOrmLedgerRepository.prototype).sort(),
    ).toEqual(['append', 'constructor']);
  });

  test("the outbox repository only knows how to add (publishing is the publisher's job, Phase 6)", () => {
    expect(
      Object.getOwnPropertyNames(MikroOrmOutboxRepository.prototype).sort(),
    ).toEqual(['add', 'constructor']);
  });
});

describe('UnitOfWork: database errors become application errors', () => {
  test('a unique violation is DuplicateKeyError with the constraint name', async () => {
    const wallet = newWallet('10.00');
    await persistWallet(db().uow, wallet);
    const tx = newTransaction(wallet);
    tx.markProcessed({ balanceAfter: brl('1.00'), at: T1 });
    await db().uow.run(async (r) => r.transactions.insert(tx));
    const again = db().uow.run(async (r) => r.transactions.insert(tx));
    expect(await rejectionOf(again)).toBeInstanceOf(DuplicateKeyError);
  });

  test('the connection being killed in the middle of the work (57P01) is DependencyUnavailableError', async () => {
    const victim = await openPersistence();
    try {
      const attempt = victim.uow.run(async (r) => {
        await r.wallets.lockById(uuid()); // a transação está aberta e a conexão ociosa
        // Outro processo derruba o backend da transação (o que um restart do banco faz).
        await db()
          .orm.em.getConnection()
          .execute(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = current_database() AND state = 'idle in transaction'
             AND pid <> pg_backend_pid()`,
          );
        await r.wallets.lockById(uuid()); // a próxima instrução encontra a conexão morta
      });
      expect(await rejectionOf(attempt)).toBeInstanceOf(
        DependencyUnavailableError,
      );
      expect(await rejectionOf(attempt)).toMatchObject({ retryable: true });
      // Depois da queda o pool se recupera sozinho.
      expect(
        await victim.uow.run(async (r) => r.wallets.lockById(uuid())),
      ).toBeUndefined();
    } finally {
      await victim.close();
    }
  });

  test('a refused connection (ECONNREFUSED) is DependencyUnavailableError, for the UnitOfWork and the reader', async () => {
    const dead = await openPersistence({
      clientUrl: 'postgres://wallet:wallet@localhost:1/wallet_test',
      connectionTimeoutMillis: 500,
    });
    try {
      expect(
        await rejectionOf(
          dead.uow.run(async (r) => r.wallets.lockById(uuid())),
        ),
      ).toBeInstanceOf(DependencyUnavailableError);
      expect(await rejectionOf(dead.reader.findById(uuid()))).toBeInstanceOf(
        DependencyUnavailableError,
      );
    } finally {
      await dead.close();
    }
  });

  test('a full pool (no free connection within the limit) is DependencyUnavailableError', async () => {
    const small = await openPersistence({
      pool: { min: 0, max: 1 },
      connectionTimeoutMillis: 300,
    });
    try {
      await holding(
        async ({ locked, until }) => {
          await small.uow.run(async (r) => {
            await r.wallets.lockById(uuid());
            locked();
            await until;
          });
        },
        async () => {
          const waiting = await rejectionOf(
            small.uow.run(async (r) => r.wallets.lockById(uuid())),
          );
          expect(waiting).toBeInstanceOf(DependencyUnavailableError);
          expect(
            await rejectionOf(small.reader.findById(uuid())),
          ).toBeInstanceOf(DependencyUnavailableError);
        },
      );

      // O pool volta ao normal sozinho.
      expect(await small.reader.findById(uuid())).toBeUndefined();
    } finally {
      await small.close();
    }
  });
});
