import { describe, expect, test } from 'bun:test';
import {
  InvalidCommandError,
  WalletNotFoundError,
} from '../../src/application/errors/application-errors.js';
import type { Clock } from '../../src/application/ports/clock.js';
import {
  ReconciliationReader,
  type ReconciliationFacts,
} from '../../src/application/ports/reconciliation-reader.js';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import { PrometheusRegistry } from '../../src/infrastructure/observability/prometheus-registry.js';
import { MikroOrmReconciliationReader } from '../../src/infrastructure/persistence/repositories/mikro-orm-readers.js';
import { rejectionOf } from '../support/assertions.js';
import { metric } from '../support/metrics.js';
import {
  openPersistence,
  usePersistence,
  uuid,
} from '../support/persistence.js';
import { createScenario, type Wallet } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db, { start: new Date() });

function useCaseFor(
  reader: ReconciliationReader = new MikroOrmReconciliationReader(db().orm.em),
  registry = new PrometheusRegistry(),
) {
  return {
    registry,
    useCase: new ReconcileWalletUseCase(reader, registry, s.clock as Clock),
  };
}

async function walletWithMovements(n: number): Promise<Wallet> {
  const wallet = await s.walletWith('1000.00');
  for (let i = 0; i < n; i++) await s.placeBet(wallet, '10.00');
  return wallet;
}

// Corrompe de propósito o que o sistema nunca corrompe: o ledger é append-only e o saldo só muda
// pelo caso de uso. Os triggers do usuário são desligados SÓ durante a adulteração.
async function tamper(work: () => Promise<void>): Promise<void> {
  await s.sql('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER USER');
  try {
    await work();
  } finally {
    await s.sql('ALTER TABLE wallet_ledger_entries ENABLE TRIGGER USER');
  }
}

describe('POST /wallets/:walletId/reconciliation (the use case)', () => {
  test('a healthy wallet: the stored balance is what the ledger rebuilds, difference zero, consistent', async () => {
    const wallet = await walletWithMovements(5);
    const { useCase } = useCaseFor();
    expect(await useCase.execute({ walletId: wallet.id })).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '950.00', currency: 'BRL' },
      calculatedBalance: { amount: '950.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 6, // abertura + 5 apostas
      findings: [],
    });
  });

  test('credits and debits both count (a win after a bet)', async () => {
    const wallet = await s.walletWith('100.00');
    const bet = await s.placeBet(wallet, '30.00');
    await s.submit(s.winBody(wallet, bet.external, '50.00'));
    const result = await useCaseFor().useCase.execute({ walletId: wallet.id });
    expect(result).toMatchObject({
      storedBalance: { amount: '120.00' },
      calculatedBalance: { amount: '120.00' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('a wallet with no ledger entries (zero opening balance) is consistent with 0 entries checked', async () => {
    const wallet = await s.walletWith('0.00');
    expect(
      await useCaseFor().useCase.execute({ walletId: wallet.id }),
    ).toMatchObject({
      storedBalance: { amount: '0.00' },
      calculatedBalance: { amount: '0.00' },
      difference: { amount: '0.00' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('a stored balance ABOVE the ledger: positive difference, balance_mismatch, consistent false', async () => {
    const wallet = await walletWithMovements(3);
    await s.sql('UPDATE wallets SET balance = balance + 1 WHERE id = ?', [
      wallet.id,
    ]);
    expect(
      await useCaseFor().useCase.execute({ walletId: wallet.id }),
    ).toMatchObject({
      storedBalance: { amount: '971.00' },
      calculatedBalance: { amount: '970.00' },
      difference: { amount: '1.00' },
      consistent: false,
      findings: ['balance_mismatch'],
    });
  });

  test('a stored balance BELOW the ledger: the difference is NEGATIVE', async () => {
    const wallet = await walletWithMovements(3);
    await s.sql('UPDATE wallets SET balance = balance - 2.50 WHERE id = ?', [
      wallet.id,
    ]);
    const result = await useCaseFor().useCase.execute({ walletId: wallet.id });
    expect(result.difference).toEqual({ amount: '-2.50', currency: 'BRL' });
    expect(result.consistent).toBe(false);
  });

  test('a broken chain with the SAME total (an entry whose balance_before is not the previous balance_after) is a ledger_gap alone', async () => {
    const wallet = await walletWithMovements(4);
    await tamper(async () => {
      await s.sql(
        'UPDATE wallet_ledger_entries SET balance_before = balance_before + 1, balance_after = balance_after + 1 WHERE wallet_id = ? AND wallet_version = 3',
        [wallet.id],
      );
    });
    const result = await useCaseFor().useCase.execute({ walletId: wallet.id });
    expect(result).toMatchObject({
      difference: { amount: '0.00' },
      consistent: false,
      findings: ['ledger_gap'],
    });
  });

  test('a missing entry (a hole in the versions) is a ledger_gap, and the total no longer matches either', async () => {
    const wallet = await walletWithMovements(4);
    await tamper(async () => {
      await s.sql(
        'DELETE FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version = 3',
        [wallet.id],
      );
    });
    const result = await useCaseFor().useCase.execute({ walletId: wallet.id });
    expect(result.consistent).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining(['ledger_gap', 'balance_mismatch']),
    );
    expect(result.checkedEntries).toBe(4);
  });

  test('the stored version ahead of the last ledger entry is a ledger_gap (an operation was saved with no ledger line)', async () => {
    const wallet = await walletWithMovements(2);
    await s.sql('UPDATE wallets SET version = version + 1 WHERE id = ?', [
      wallet.id,
    ]);
    expect(
      (await useCaseFor().useCase.execute({ walletId: wallet.id })).findings,
    ).toEqual(['ledger_gap']);
  });

  test('NEVER corrects anything: the tampered balance, the ledger and the version stay exactly as found', async () => {
    const wallet = await walletWithMovements(3);
    await s.sql('UPDATE wallets SET balance = balance + 7 WHERE id = ?', [
      wallet.id,
    ]);
    const before = {
      wallet: await s.walletRow(wallet.id),
      ledger: await s.movements(wallet.id),
    };
    await useCaseFor().useCase.execute({ walletId: wallet.id });
    await useCaseFor().useCase.execute({ walletId: wallet.id });
    expect(await s.walletRow(wallet.id)).toEqual(before.wallet);
    expect(await s.movements(wallet.id)).toEqual(before.ledger);
  });

  test('an unknown wallet is WalletNotFoundError; a malformed id is a 400 before any query', async () => {
    expect(
      await rejectionOf(useCaseFor().useCase.execute({ walletId: uuid() })),
    ).toBeInstanceOf(WalletNotFoundError);
    expect(
      await rejectionOf(useCaseFor().useCase.execute({ walletId: 'nope' })),
    ).toBeInstanceOf(InvalidCommandError);
  });
});

describe('what the reconciliation reports to the metrics', () => {
  test('a clean run counts a clean run and no divergence', async () => {
    const wallet = await walletWithMovements(1);
    const { registry, useCase } = useCaseFor();
    await useCase.execute({ walletId: wallet.id });
    expect(
      await metric(
        registry,
        'wallet_reconciliation_runs_total{result="clean"}',
      ),
    ).toBe(1);
    expect(
      await metric(
        registry,
        'wallet_reconciliation_divergences_total{kind="balance_mismatch"}',
      ),
    ).toBe(0);
    expect(
      await metric(
        registry,
        'wallet_reconciliation_divergences{kind="balance_mismatch"}',
      ),
    ).toBe(0);
  });

  test('a divergent run counts a divergent run, the divergence by kind, and sets the gauge', async () => {
    const wallet = await walletWithMovements(1);
    await s.sql('UPDATE wallets SET balance = balance + 1 WHERE id = ?', [
      wallet.id,
    ]);
    const { registry, useCase } = useCaseFor();
    await useCase.execute({ walletId: wallet.id });
    await useCase.execute({ walletId: wallet.id });
    expect(
      await metric(
        registry,
        'wallet_reconciliation_runs_total{result="divergent"}',
      ),
    ).toBe(2);
    expect(
      await metric(
        registry,
        'wallet_reconciliation_divergences_total{kind="balance_mismatch"}',
      ),
    ).toBe(2);
    expect(
      await metric(
        registry,
        'wallet_reconciliation_divergences{kind="balance_mismatch"}',
      ),
    ).toBe(1);
    expect(
      await metric(
        registry,
        'wallet_reconciliation_last_run_timestamp_seconds',
      ),
    ).toBe(s.clock.now().getTime() / 1000);
  });

  test('the TOTAL still shows a divergence after a clean check of ANOTHER wallet (the gauge alone would hide it)', async () => {
    const bad = await walletWithMovements(1);
    await s.sql('UPDATE wallets SET balance = balance + 1 WHERE id = ?', [
      bad.id,
    ]);
    const good = await walletWithMovements(1);
    const { registry, useCase } = useCaseFor();
    await useCase.execute({ walletId: bad.id });
    await useCase.execute({ walletId: good.id });
    expect(
      await metric(
        registry,
        'wallet_reconciliation_divergences_total{kind="balance_mismatch"}',
      ),
    ).toBe(1);
  });

  test('a run that FAILS (the database is down) counts a failure and keeps the previous gauge', async () => {
    const failing = new (class extends ReconciliationReader {
      snapshot(): Promise<ReconciliationFacts | undefined> {
        return Promise.reject(new Error('database unavailable (injected)'));
      }
    })();
    const { registry, useCase } = useCaseFor(failing);
    await rejectionOf(useCase.execute({ walletId: uuid() }));
    expect(
      await metric(
        registry,
        'wallet_reconciliation_runs_total{result="failed"}',
      ),
    ).toBe(1);
  });
});

describe('reading without disturbing: a snapshot, no locks, read only', () => {
  test('runs in a REPEATABLE READ READ ONLY transaction', async () => {
    const reader = await openPersistence();
    try {
      const wallet = await walletWithMovements(1);
      await useCaseFor(
        new MikroOrmReconciliationReader(reader.orm.em),
      ).useCase.execute({ walletId: wallet.id });
      const sql = reader.queries.join('\n').toLowerCase();
      expect(sql).toContain('repeatable read');
      expect(sql).toContain('read only');
    } finally {
      await reader.close();
    }
  });

  test('does NOT wait for the wallet lock: with an operation holding the wallet, the reconciliation answers at once', async () => {
    const wallet = await walletWithMovements(2);
    const holder = await openPersistence();
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const heldSignal = new Promise<void>((resolve) => (held = resolve));
    const holding = holder.uow.run(async (r) => {
      await r.wallets.lockById(wallet.id);
      held();
      await until;
    });
    try {
      await heldSignal;
      const started = performance.now();
      const result = await useCaseFor().useCase.execute({
        walletId: wallet.id,
      });
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(result.consistent).toBe(true);
    } finally {
      release();
      await holding;
      await holder.close();
    }
  });

  test('under CONCURRENT writes every answer is consistent: saldo and ledger come from the same instant', async () => {
    const wallet = await s.walletWith('100000.00');
    const reader = await openPersistence();
    const useCase = new ReconcileWalletUseCase(
      new MikroOrmReconciliationReader(reader.orm.em),
      new PrometheusRegistry(),
      s.clock as Clock,
    );
    let writing = true;
    const writers = Array.from({ length: 4 }, async () => {
      while (writing) {
        await s.placeBet(wallet, '1.00');
      }
    });
    try {
      const results = [];
      for (let i = 0; i < 120; i++) {
        results.push(await useCase.execute({ walletId: wallet.id }));
      }
      const inconsistent = results.filter((r) => !r.consistent);
      expect(inconsistent).toEqual([]);
      expect(results.at(-1)?.checkedEntries).toBeGreaterThan(
        results[0]?.checkedEntries as number,
      );
    } finally {
      writing = false;
      await Promise.all(writers);
      await reader.close();
    }
  }, 120_000);
});

describe('the decision, from the facts the database gives', () => {
  const facts = (
    over: Partial<ReconciliationFacts> = {},
  ): ReconciliationFacts => ({
    currency: 'BRL',
    storedBalance: '10.00',
    storedVersion: 3,
    calculatedBalance: '10.00',
    difference: '0.00',
    checkedEntries: 3,
    chainBreaks: 0,
    versionGaps: 0,
    lastVersion: 3,
    ...over,
  });
  const reader = (value: ReconciliationFacts) =>
    new (class extends ReconciliationReader {
      snapshot(): Promise<ReconciliationFacts | undefined> {
        return Promise.resolve(value);
      }
    })();

  test.each([
    ['everything fits', facts(), true, []],
    [
      'a negative stored balance',
      facts({
        storedBalance: '-1.00',
        calculatedBalance: '-1.00',
        difference: '0.00',
      }),
      false,
      ['negative_balance'],
    ],
    ['chain breaks', facts({ chainBreaks: 1 }), false, ['ledger_gap']],
    ['version gaps', facts({ versionGaps: 2 }), false, ['ledger_gap']],
    [
      'the stored version is not the last entry',
      facts({ storedVersion: 5 }),
      false,
      ['ledger_gap'],
    ],
    [
      'no entries and version 1',
      // sem lançamentos a versão é 1 e não há "última versão"
      {
        ...facts({ checkedEntries: 0, storedVersion: 1 }),
        lastVersion: undefined,
      },
      true,
      [],
    ],
    [
      'several findings together',
      facts({ storedBalance: '11.00', difference: '1.00', chainBreaks: 1 }),
      false,
      ['balance_mismatch', 'ledger_gap'],
    ],
  ] as const)('%s', async (_name, input, consistent, findings) => {
    const result = await useCaseFor(reader(input)).useCase.execute({
      walletId: uuid(),
    });
    expect(result.consistent).toBe(consistent);
    expect(result.findings).toEqual([...findings]);
  });
});
