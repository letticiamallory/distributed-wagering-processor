import { describe, expect, test } from 'bun:test';
import { DependencyUnavailableError } from '../../src/application/errors/application-errors.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { rejectionOf } from '../support/assertions.js';
import { holding } from '../support/concurrency.js';
import { assertInvariants } from '../support/invariants.js';
import { openPersistence, usePersistence } from '../support/persistence.js';
import {
  CountingUnitOfWork,
  UnitOfWorkWith,
  createScenario,
  ext,
} from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db);

// Um erro como o que o driver devolve: o `code` é o SQLSTATE.
const driverError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

// O que "transitório" promete ao HTTP e ao worker: DEPENDENCY_UNAVAILABLE, reenviável com a MESMA
// chave (503 com Retry-After), com a causa original guardada para o log. Nada foi gravado.
function expectTransient(error: unknown) {
  expect(error).toBeInstanceOf(DependencyUnavailableError);
  expect(error).toMatchObject({
    code: FailureCode.DependencyUnavailable,
    retryable: true,
  });
  expect((error as Error).cause).toBeDefined();
}

describe('transient database errors: DEPENDENCY_UNAVAILABLE, retryable, nothing written, no rerun', () => {
  test.each([
    ['55P03', 'canceling statement due to lock timeout'],
    ['40P01', 'deadlock detected'],
    ['40001', 'could not serialize access due to concurrent update'],
    ['57P01', 'terminating connection due to administrator command'],
  ])(
    'SQLSTATE %s raised while saving: the answer is a 503 and the same key works afterwards',
    async (code, message) => {
      const wallet = await s.walletWith('100.00');
      const input = s.body(wallet);
      const counting = new CountingUnitOfWork(
        new UnitOfWorkWith(db().uow, (r) => ({
          ...r,
          transactions: Object.assign(
            Object.create(r.transactions) as typeof r.transactions,
            {
              insert: () => Promise.reject(driverError(code, message)),
            },
          ),
        })),
      );

      const error = await rejectionOf(
        s.submit(input, {}, s.build({ uow: counting })),
      );

      expectTransient(error);
      expect(((error as Error).cause as { code: string }).code).toBe(code);
      expect(counting.runs).toBe(1); // transitório NÃO reexecuta sozinho: quem reenvia é o provedor
      expect(await s.walletRow(wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
      });
      expect(
        await s.count('wager_transactions', 'idempotency_key = ?', [
          s.keyOf(input),
        ]),
      ).toBe(0);
      expect(await s.movements(wallet.id)).toHaveLength(0);

      // Reenvio com a MESMA chave: processa de verdade (não existe fantasma, não é replay).
      const retry = await s.submit(input);
      expect(retry).toMatchObject({
        status: WagerTransactionStatus.Processed,
        idempotentReplay: false,
      });
      expect(await s.balanceOf(wallet)).toBe('75.00');
      await assertInvariants(s.sql, wallet.id);
    },
  );

  test('a REAL lock_timeout: someone holds the wallet, the wait runs out, 503, and the same key works after', async () => {
    const short = await openPersistence({ lockTimeoutMs: 300 });
    try {
      const scenario = createScenario(() => short);
      const wallet = await scenario.walletWith('100.00');
      const input = scenario.body(wallet);

      const error = await holding(
        async ({ locked, until }) => {
          await short.uow.run(async (r) => {
            await r.wallets.lockById(wallet.id);
            locked();
            await until;
          });
        },
        () => rejectionOf(scenario.submit(input)),
      );

      expectTransient(error);
      expect(((error as Error).cause as { code: string }).code).toBe('55P03');
      expect(
        await scenario.count('wager_transactions', 'idempotency_key = ?', [
          scenario.keyOf(input),
        ]),
      ).toBe(0);
      const retry = await scenario.submit(input);
      expect(retry).toMatchObject({
        status: WagerTransactionStatus.Processed,
        idempotentReplay: false,
      });
      await assertInvariants(scenario.sql, wallet.id);
    } finally {
      await short.close();
    }
  });

  test('a REAL lost connection in the middle of the work (57P01) is a 503 and nothing is written', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const killing = new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      wallets: Object.assign(Object.create(r.wallets) as typeof r.wallets, {
        // Trava a wallet e DERRUBA a conexão da transação, como um restart do banco faria.
        lockById: async (id: string) => {
          const locked = await r.wallets.lockById(id);
          await db()
            .orm.em.getConnection()
            .execute(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`,
            );
          return locked;
        },
      }),
    }));

    const error = await rejectionOf(
      s.submit(input, {}, s.build({ uow: killing })),
    );

    expectTransient(error);
    expect(await s.walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(
      await s.count('wager_transactions', 'idempotency_key = ?', [
        s.keyOf(input),
      ]),
    ).toBe(0);
    expect((await s.submit(input)).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('a REAL exhausted pool (no free connection in time) is a 503, even before the transaction starts', async () => {
    const small = await openPersistence({
      pool: { min: 0, max: 1 },
      connectionTimeoutMillis: 300,
    });
    try {
      const scenario = createScenario(() => small);
      const wallet = await scenario.walletWith('100.00');
      const input = scenario.body(wallet);

      const error = await holding(
        async ({ locked, until }) => {
          await small.uow.run(async (r) => {
            await r.wallets.lockById(wallet.id); // ocupa a ÚNICA conexão do pool
            locked();
            await until;
          });
        },
        () => rejectionOf(scenario.submit(input)),
      );

      expectTransient(error);
      expect(
        await scenario.count('wager_transactions', 'idempotency_key = ?', [
          scenario.keyOf(input),
        ]),
      ).toBe(0);
      expect((await scenario.submit(input)).status).toBe(
        WagerTransactionStatus.Processed,
      ); // o pool se recuperou
    } finally {
      await small.close();
    }
  });

  test('the same on the first pass of a PENDING_REFERENCE: nothing is stored, and the retry stores it', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.reversalBody(wallet, 'REFUND', ext('not-here-yet'));
    const failing = new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      transactions: Object.assign(
        Object.create(r.transactions) as typeof r.transactions,
        {
          insert: () =>
            Promise.reject(driverError('40P01', 'deadlock detected')),
        },
      ),
    }));

    expectTransient(
      await rejectionOf(s.submit(input, {}, s.build({ uow: failing }))),
    );
    expect(
      await s.count('wager_transactions', 'idempotency_key = ?', [
        s.keyOf(input),
      ]),
    ).toBe(0);
    expect((await s.submit(input)).status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });
});

describe('transient errors when a pending transaction is resolved', () => {
  test('a deadlock while resolving leaves the transaction PENDING_REFERENCE, untouched, and the next try resolves it', async () => {
    const wallet = await s.walletWith('100.00');
    const refund = await s.pend(wallet, 'REFUND', ext('bet-90'));
    await s.placeBet(wallet, '25.00', ext('bet-90')); // 75
    const before = await s.txRow(refund.transactionId);
    const failing = new UnitOfWorkWith(db().uow, (r) => ({
      ...r,
      transactions: Object.assign(
        Object.create(r.transactions) as typeof r.transactions,
        {
          update: () =>
            Promise.reject(driverError('40P01', 'deadlock detected')),
        },
      ),
    }));

    const error = await rejectionOf(
      s.resolve(refund.transactionId, s.resolver({ uow: failing })),
    );

    expectTransient(error);
    expect(await s.txRow(refund.transactionId)).toEqual(before); // nada mudou: nem tentativa, nem horário
    expect(await s.balanceOf(wallet)).toBe('75.00');
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']);

    const retry = await s.resolve(refund.transactionId);
    expect(retry).toMatchObject({
      outcome: 'RESOLVED',
      status: WagerTransactionStatus.Processed,
    });
    expect(await s.balanceOf(wallet)).toBe('100.00');
    await assertInvariants(s.sql, wallet.id);
  });

  test('a lock_timeout while resolving is a 503 for the worker (it retries later, the attempt is not burned)', async () => {
    const short = await openPersistence({ lockTimeoutMs: 300 });
    try {
      const scenario = createScenario(() => short);
      const wallet = await scenario.walletWith('100.00');
      const refund = await scenario.pend(wallet, 'REFUND', ext('bet-91'));
      await scenario.placeBet(wallet, '25.00', ext('bet-91'));
      const before = await scenario.txRow(refund.transactionId);

      const error = await holding(
        async ({ locked, until }) => {
          await short.uow.run(async (r) => {
            await r.wallets.lockById(wallet.id);
            locked();
            await until;
          });
        },
        () => rejectionOf(scenario.resolve(refund.transactionId)),
      );

      expectTransient(error);
      expect(await scenario.txRow(refund.transactionId)).toEqual(before); // a tentativa NÃO foi gasta
    } finally {
      await short.close();
    }
  });
});
