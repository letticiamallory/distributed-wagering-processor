import { describe, expect, test } from 'bun:test';
import {
  InvalidCommandError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { decodeLedgerCursor } from '../../src/application/queries/ledger-cursor.js';
import {
  GetTransactionUseCase,
  GetWalletUseCase,
  ListLedgerUseCase,
} from '../../src/application/use-cases/queries.use-cases.js';
import {
  MikroOrmLedgerReader,
  MikroOrmWalletReader,
} from '../../src/infrastructure/persistence/repositories/mikro-orm-readers.js';
import { rejectionOf } from '../support/assertions.js';
import { usePersistence, uuid } from '../support/persistence.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db, { start: new Date() });

const wallets = () => new MikroOrmWalletReader(db().orm.em);
const ledger = () => new MikroOrmLedgerReader(db().orm.em);
const getWallet = () => new GetWalletUseCase(wallets());
const listLedger = () => new ListLedgerUseCase(wallets(), ledger());
const getTransaction = () => new GetTransactionUseCase(db().reader);

async function walletWithMovements(n: number) {
  const wallet = await s.walletWith('1000.00');
  for (let i = 0; i < n; i++) await s.placeBet(wallet, '1.00');
  return wallet;
}

describe('GET /wallets/:walletId (the use case)', () => {
  test('returns id, playerId, the balance as money props and the version', async () => {
    const wallet = await walletWithMovements(2);
    expect(await getWallet().execute({ walletId: wallet.id })).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '998.00', currency: 'BRL' },
      version: 3,
    });
  });

  test('a wallet that does not exist is WalletNotFoundError (404)', async () => {
    expect(
      await rejectionOf(getWallet().execute({ walletId: uuid() })),
    ).toBeInstanceOf(WalletNotFoundError);
  });

  test.each([
    'abc',
    '',
    '123',
    'not-a-uuid',
    '0192f291-27dd-7d3f-8071-5f8685deef3',
  ])(
    'the id "%s" is a 400 (never a database error on the uuid column)',
    async (walletId) => {
      const error = await rejectionOf(getWallet().execute({ walletId }));
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(
        (error as InvalidCommandError).details.map((d) => d.path),
      ).toContain('walletId');
    },
  );

  test('an upper-case uuid finds the same wallet', async () => {
    const wallet = await walletWithMovements(0);
    expect(
      (await getWallet().execute({ walletId: wallet.id.toUpperCase() })).id,
    ).toBe(wallet.id);
  });
});

describe('GET /wallets/:walletId/ledger (the use case)', () => {
  test('lists the newest entry first, with the shape of the ledger, and no next page when everything fits', async () => {
    const wallet = await walletWithMovements(2); // abertura + 2 apostas
    const page = await listLedger().execute({ walletId: wallet.id });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.walletVersion)).toEqual([3, 2, 1]);
    expect(page.items[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '999.00', currency: 'BRL' },
      balanceAfter: { amount: '998.00', currency: 'BRL' },
    });
    expect(page.items[2]).toMatchObject({
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00' },
    });
    for (const item of page.items) {
      expect(typeof item.transactionId).toBe('string');
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('walks every page exactly once: no entry twice, none missing, the cursor opaque and the last page without one', async () => {
    const wallet = await walletWithMovements(11); // 12 lançamentos (versões 1..12)
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listLedger().execute({
        walletId: wallet.id,
        limit: 5,
        ...(cursor && { cursor }),
      });
      seen.push(...page.items.map((i) => i.walletVersion));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test('is STABLE while new entries arrive: an older page never repeats or skips because of the newer ones', async () => {
    const wallet = await walletWithMovements(9); // versões 1..10
    const first = await listLedger().execute({ walletId: wallet.id, limit: 4 });
    expect(first.items.map((i) => i.walletVersion)).toEqual([10, 9, 8, 7]);
    // chegam 3 lançamentos novos entre a 1ª e a 2ª página
    for (let i = 0; i < 3; i++) await s.placeBet(wallet, '1.00');
    const second = await listLedger().execute({
      walletId: wallet.id,
      limit: 4,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((i) => i.walletVersion)).toEqual([6, 5, 4, 3]);
  });

  test('the next cursor points at the last item of the page', async () => {
    const wallet = await walletWithMovements(5);
    const page = await listLedger().execute({ walletId: wallet.id, limit: 2 });
    expect(page.nextCursor).not.toBeNull();
    expect(decodeLedgerCursor(page.nextCursor as string)).toBe(
      page.items.at(-1)?.walletVersion as number,
    );
  });

  test('exactly `limit` entries left means NO next page (the +1 row tells)', async () => {
    const wallet = await walletWithMovements(3); // 4 lançamentos
    const page = await listLedger().execute({ walletId: wallet.id, limit: 4 });
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
  });

  test('the default limit is 50 and the maximum is 100', async () => {
    const wallet = await walletWithMovements(60);
    expect(
      (await listLedger().execute({ walletId: wallet.id })).items,
    ).toHaveLength(50);
    expect(
      (await listLedger().execute({ walletId: wallet.id, limit: 100 })).items,
    ).toHaveLength(61);
    for (const limit of [101, 0, -1, 1.5, 'abc', '', '10x']) {
      const error = await rejectionOf(
        listLedger().execute({ walletId: wallet.id, limit }),
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(
        (error as InvalidCommandError).details.map((d) => d.path),
      ).toContain('limit');
    }
  });

  test('a limit that comes as text from the query string ("3") is accepted', async () => {
    const wallet = await walletWithMovements(4);
    expect(
      (await listLedger().execute({ walletId: wallet.id, limit: '3' })).items,
    ).toHaveLength(3);
  });

  test('a bad cursor is a 400, and an unknown wallet is a 404 (the cursor is checked first: a 400 never hides behind a 404)', async () => {
    const wallet = await walletWithMovements(1);
    expect(
      await rejectionOf(
        listLedger().execute({ walletId: wallet.id, cursor: 'garbage' }),
      ),
    ).toBeInstanceOf(InvalidCommandError);
    expect(
      await rejectionOf(listLedger().execute({ walletId: uuid() })),
    ).toBeInstanceOf(WalletNotFoundError);
  });

  test('a wallet with no movements has an empty page (no opening entry for a zero balance)', async () => {
    const wallet = await s.walletWith('0.00');
    expect(await listLedger().execute({ walletId: wallet.id })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test('never shows the entries of ANOTHER wallet', async () => {
    const a = await walletWithMovements(2);
    const b = await walletWithMovements(5);
    const page = await listLedger().execute({ walletId: a.id });
    expect(page.items).toHaveLength(3);
    expect(b.id).not.toBe(a.id);
  });
});

describe('GET /wagering/transactions/... (the use case)', () => {
  test('by id: the stored transaction, with status, failure code and the balance of the time', async () => {
    const wallet = await s.walletWith('10.00');
    const processed = await s.placeBet(wallet, '4.00');
    expect(await getTransaction().byId(processed.transactionId)).toMatchObject({
      transactionId: processed.transactionId,
      providerId: 'provider-a',
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '4.00', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '6.00', currency: 'BRL' },
    });

    const rejected = await s.placeBet(wallet, '500.00');
    const view = await getTransaction().byId(rejected.transactionId);
    expect(view).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  test('a pending reference shows its status and attempts, and no balance yet', async () => {
    const wallet = await s.walletWith('100.00');
    const pending = await s.pend(wallet, 'REFUND', ext(`q-${uuid()}`), '5.00');
    const view = await getTransaction().byId(pending.transactionId);
    expect(view).toMatchObject({ status: 'PENDING_REFERENCE', kind: 'REFUND' });
    expect(view.referenceExternalTransactionId).toStartWith('ext-q-');
    expect(view).not.toHaveProperty('balance');
    expect(typeof view.attempts).toBe('number');
  });

  test('by the provider key: the same transaction', async () => {
    const wallet = await s.walletWith('100.00');
    const placed = await s.placeBet(wallet, '1.00');
    const byKey = await getTransaction().byProviderKey(
      'provider-a',
      placed.external,
    );
    expect(byKey.transactionId).toBe(placed.transactionId);
    expect(byKey).toEqual(await getTransaction().byId(placed.transactionId));
  });

  test('does not show the internal fields (idempotency key, payload hash, correlation id, player id)', async () => {
    const wallet = await s.walletWith('100.00');
    const placed = await s.placeBet(wallet, '1.00');
    const view = await getTransaction().byId(placed.transactionId);
    for (const hidden of [
      'idempotencyKey',
      'payloadHash',
      'correlationId',
      'playerId',
    ]) {
      expect(view).not.toHaveProperty(hidden);
    }
  });

  test('unknown ids are TransactionNotFoundError (404); malformed ids are 400', async () => {
    expect(await rejectionOf(getTransaction().byId(uuid()))).toBeInstanceOf(
      TransactionNotFoundError,
    );
    expect(
      await rejectionOf(getTransaction().byProviderKey('provider-a', 'nope')),
    ).toBeInstanceOf(TransactionNotFoundError);
    expect(
      await rejectionOf(getTransaction().byId('not-a-uuid')),
    ).toBeInstanceOf(InvalidCommandError);
    expect(
      await rejectionOf(getTransaction().byProviderKey('', 'x')),
    ).toBeInstanceOf(InvalidCommandError);
    expect(
      await rejectionOf(getTransaction().byProviderKey('p'.repeat(201), 'x')),
    ).toBeInstanceOf(InvalidCommandError);
  });

  test('the same external id under ANOTHER provider is not found (the key is the pair)', async () => {
    const wallet = await s.walletWith('100.00');
    const placed = await s.placeBet(wallet, '1.00');
    expect(
      await rejectionOf(
        getTransaction().byProviderKey('provider-z', placed.external),
      ),
    ).toBeInstanceOf(TransactionNotFoundError);
  });
});
