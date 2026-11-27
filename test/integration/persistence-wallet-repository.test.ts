import { describe, expect, test } from 'bun:test';
import { capture, holding, valueOf } from '../support/concurrency.js';
import { messageOf, rejectionOf } from '../support/assertions.js';
import {
  ConcurrentWalletUpdateError,
  DependencyUnavailableError,
  WalletAlreadyExistsError,
} from '../../src/application/errors/application-errors.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import {
  brl,
  newWallet,
  openPersistence,
  T1,
  usd,
  usePersistence,
  uuid,
} from '../support/persistence.js';
import { UnitOfWorkWithoutTriggers } from '../support/tamper.js';

// O repositório SOZINHO: grava e muda saldos sem o lançamento que o caso de uso gravaria junto, então
// roda com os triggers desligados (o trg_wallet_balance_has_ledger recusaria no COMMIT).
const uow = () => new UnitOfWorkWithoutTriggers(db().orm.em);

const db = usePersistence();

describe('WalletRepository: insert and lock', () => {
  test('a wallet goes in and comes back equal, with money exact to the cent', async () => {
    const wallet = newWallet('9999999999999999.99');
    await uow().run(async (r) => r.wallets.insert(wallet));

    const loaded = await uow().run(async (r) => r.wallets.lockById(wallet.id));
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(wallet.id);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.currency).toBe('BRL');
    expect(loaded?.balance.toJSON()).toEqual({
      amount: '9999999999999999.99',
      currency: 'BRL',
    });
    expect(loaded?.version).toBe(1);
    expect(loaded?.createdAt.toISOString()).toBe(
      wallet.createdAt.toISOString(),
    );
  });

  test('a wallet that does not exist comes back as undefined', async () => {
    const loaded = await uow().run(async (r) => r.wallets.lockById(uuid()));
    expect(loaded).toBeUndefined();
  });

  test('a second wallet for the same player and currency is WalletAlreadyExistsError', async () => {
    const first = newWallet('10.00');
    await uow().run(async (r) => r.wallets.insert(first));
    const duplicate = newWallet('20.00', { playerId: first.playerId });
    const run = uow().run(async (r) => r.wallets.insert(duplicate));
    expect(await rejectionOf(run)).toBeInstanceOf(WalletAlreadyExistsError);
    expect(await rejectionOf(run)).toMatchObject({
      playerId: first.playerId,
      currency: 'BRL',
    });
  });

  test('the same player can have wallets in different currencies', async () => {
    const brlWallet = newWallet('10.00');
    await uow().run(async (r) => r.wallets.insert(brlWallet));
    const usdWallet = Wallet.open({
      id: uuid(),
      playerId: brlWallet.playerId,
      initialBalance: usd('5.00'),
      opening: { transactionId: uuid(), entryId: uuid() },
      at: T1,
    }).wallet;
    await uow().run(async (r) => r.wallets.insert(usdWallet));
    const loaded = await uow().run(async (r) =>
      r.wallets.lockById(usdWallet.id),
    );
    expect(loaded?.currency).toBe('USD');
  });
});

describe('WalletRepository: lock', () => {
  test('lockById issues SELECT ... FOR UPDATE inside the transaction', async () => {
    const wallet = newWallet('50.00');
    await uow().run(async (r) => r.wallets.insert(wallet));
    db().queries.length = 0;

    await uow().run(async (r) => r.wallets.lockById(wallet.id));

    const lockQuery = db().queries.find((q) => /for update/i.test(q));
    expect(lockQuery).toBeDefined();
    expect(lockQuery).toMatch(/from "wallets"/i);
    // A ordem importa: BEGIN, SET LOCAL lock_timeout, o lock, COMMIT.
    const kinds = db().queries.map((q) => {
      if (/start transaction isolation level read committed/i.test(q))
        return 'BEGIN';
      if (/lock_timeout/i.test(q)) return 'SET LOCAL';
      if (/for update/i.test(q)) return 'LOCK';
      if (/commit/i.test(q)) return 'COMMIT';
      return 'OTHER';
    });
    expect(kinds.filter((k) => k !== 'OTHER')).toEqual([
      'BEGIN',
      'SET LOCAL',
      'LOCK',
      'COMMIT',
    ]);
    console.log(
      '\nSQL do lock:\n' +
        db()
          .queries.map((q) => '  ' + q)
          .join('\n'),
    );
  });

  test('a second transaction waits for the first one to commit', async () => {
    const wallet = newWallet('50.00');
    await uow().run(async (r) => r.wallets.insert(wallet));
    const order: string[] = [];

    const { second } = await holding(
      async ({ locked, until }) => {
        await uow().run(async (r) => {
          await r.wallets.lockById(wallet.id);
          order.push('first locked');
          locked();
          await until;
          order.push('first committing');
        });
      },
      async () => {
        // Capturada: mesmo que uma asserção abaixo falhe, esta promessa nunca fica sem dono.
        const second = capture(
          uow().run(async (r) => {
            await r.wallets.lockById(wallet.id);
            order.push('second locked');
          }),
        );
        await Bun.sleep(300);
        expect(order).toEqual(['first locked']); // a segunda ainda espera o commit da primeira
        return { second };
      },
    );

    valueOf(await second);
    expect(order).toEqual([
      'first locked',
      'first committing',
      'second locked',
    ]);
  });

  test('when the lock does not come in time, the wait becomes DependencyUnavailableError (55P03)', async () => {
    const short = await openPersistence({ lockTimeoutMs: 300 });
    const shortUow = new UnitOfWorkWithoutTriggers(short.orm.em, 300);
    try {
      const wallet = newWallet('50.00');
      await shortUow.run(async (r) => r.wallets.insert(wallet));

      await holding(
        async ({ locked, until }) => {
          await shortUow.run(async (r) => {
            await r.wallets.lockById(wallet.id);
            locked();
            await until;
          });
        },
        async () => {
          const error = await rejectionOf(
            shortUow.run(async (r) => r.wallets.lockById(wallet.id)),
          );
          expect(error).toBeInstanceOf(DependencyUnavailableError);
          expect(error).toMatchObject({ retryable: true });
        },
      );

      // Nada ficou preso: depois que o primeiro soltou, o lock sai de novo.
      expect(
        await shortUow.run(async (r) => r.wallets.lockById(wallet.id)),
      ).toBeDefined();
    } finally {
      await short.close();
    }
  });
});

describe('WalletRepository: save (optimistic guard behind the lock)', () => {
  test('saves the new balance and version, and the next read sees them', async () => {
    const wallet = newWallet('100.00');
    await uow().run(async (r) => r.wallets.insert(wallet));

    await uow().run(async (r) => {
      const locked = await r.wallets.lockById(wallet.id);
      const entry = locked!.debit({
        money: brl('25.00'),
        transactionId: uuid(),
        entryId: uuid(),
        at: T1,
      });
      expect(entry.walletVersion).toBe(2);
      await r.wallets.save(locked!, 1);
    });

    const after = await uow().run(async (r) => r.wallets.lockById(wallet.id));
    expect(after?.balance.toJSON().amount).toBe('75.00');
    expect(after?.version).toBe(2);
    expect(after?.updatedAt.toISOString()).toBe(T1.toISOString());
  });

  test('with the wrong expected version it fails and changes nothing', async () => {
    const wallet = newWallet('100.00');
    await uow().run(async (r) => r.wallets.insert(wallet));

    const attempt = uow().run(async (r) => {
      const locked = await r.wallets.lockById(wallet.id);
      locked!.debit({
        money: brl('25.00'),
        transactionId: uuid(),
        entryId: uuid(),
        at: T1,
      });
      await r.wallets.save(locked!, 7);
    });
    expect(await rejectionOf(attempt)).toBeInstanceOf(
      ConcurrentWalletUpdateError,
    );
    expect(await rejectionOf(attempt)).toMatchObject({
      walletId: wallet.id,
      expectedVersion: 7,
    });

    const after = await uow().run(async (r) => r.wallets.lockById(wallet.id));
    expect(after?.balance.toJSON().amount).toBe('100.00');
    expect(after?.version).toBe(1);
  });

  test('saving a wallet that does not exist fails the same way', async () => {
    const ghost = newWallet('10.00');
    ghost.credit({
      money: brl('1.00'),
      transactionId: uuid(),
      entryId: uuid(),
      at: T1,
    });
    const attempt = uow().run(async (r) => r.wallets.save(ghost, 1));
    expect(await rejectionOf(attempt)).toBeInstanceOf(
      ConcurrentWalletUpdateError,
    );
  });

  test('the database refuses a negative balance even if the code tried (ck_wallets_balance_non_negative)', async () => {
    const wallet = newWallet('10.00');
    await uow().run(async (r) => r.wallets.insert(wallet));
    const attempt = uow().run(async (r) => {
      const locked = await r.wallets.lockById(wallet.id);
      // Contorna a regra do domínio de propósito: rehydrate não valida.
      const broken = Wallet.rehydrate({
        id: locked!.id,
        playerId: locked!.playerId,
        currency: 'BRL',
        balance: brl('0.00').subtract(brl('1.00')),
        version: 2,
        createdAt: locked!.createdAt,
        updatedAt: T1,
      });
      await r.wallets.save(broken, 1);
    });
    // A constraint fez o trabalho dela: erro permanente, sem virar 503 nem 409.
    expect(messageOf(await rejectionOf(attempt))).toMatch(
      /ck_wallets_balance_non_negative/,
    );
    const after = await uow().run(async (r) => r.wallets.lockById(wallet.id));
    expect(after?.balance.toJSON().amount).toBe('10.00');
  });
});
