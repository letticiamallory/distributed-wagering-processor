import { describe, expect, test } from 'bun:test';
import { reportReconciliation } from '../../../src/application/reconciliation-metrics.js';
import { PrometheusRegistry } from '../../../src/infrastructure/observability/prometheus-registry.js';

async function sample(registry: PrometheusRegistry, series: string) {
  const line = (await registry.render())
    .split('\n')
    .find((l) => l.startsWith(`${series} `));
  return line === undefined
    ? undefined
    : Number(line.slice(line.lastIndexOf(' ') + 1));
}

// A métrica de divergência que a reconciliação (Fase 8) vai alimentar. Está pronta e testada aqui,
// e nada no código de produção a chama ainda.
describe('reportReconciliation: ready for the reconciliation of phase 8', () => {
  test('a clean run sets every divergence kind to 0, stamps the run time and counts a clean run', async () => {
    const registry = new PrometheusRegistry();
    reportReconciliation(registry, {
      divergences: {},
      at: new Date('2026-11-26T12:00:00Z'),
    });
    for (const kind of ['balance_mismatch', 'ledger_gap', 'negative_balance']) {
      expect(
        await sample(
          registry,
          `wallet_reconciliation_divergences{kind="${kind}"}`,
        ),
      ).toBe(0);
    }
    expect(
      await sample(
        registry,
        'wallet_reconciliation_last_run_timestamp_seconds',
      ),
    ).toBe(Date.parse('2026-11-26T12:00:00Z') / 1000);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_runs_total{result="clean"}',
      ),
    ).toBe(1);
  });

  test('a divergent run reports how many wallets per kind (a kind that is absent is 0, never stale)', async () => {
    const registry = new PrometheusRegistry();
    reportReconciliation(registry, {
      divergences: { balance_mismatch: 2, ledger_gap: 1 },
      at: new Date('2026-11-26T12:00:00Z'),
    });
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="balance_mismatch"}',
      ),
    ).toBe(2);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="ledger_gap"}',
      ),
    ).toBe(1);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="negative_balance"}',
      ),
    ).toBe(0);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_runs_total{result="divergent"}',
      ),
    ).toBe(1);

    // a execução seguinte, limpa, zera os valores antigos
    reportReconciliation(registry, {
      divergences: {},
      at: new Date('2026-11-26T12:05:00Z'),
    });
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="balance_mismatch"}',
      ),
    ).toBe(0);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_runs_total{result="clean"}',
      ),
    ).toBe(1);
  });

  test('a run that FAILED keeps the previous divergences (it proves nothing) and counts a failure', async () => {
    const registry = new PrometheusRegistry();
    reportReconciliation(registry, {
      divergences: { ledger_gap: 4 },
      at: new Date('2026-11-26T12:00:00Z'),
    });
    reportReconciliation(registry, {
      divergences: {},
      at: new Date('2026-11-26T12:05:00Z'),
      failed: true,
    });
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="ledger_gap"}',
      ),
    ).toBe(4);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_runs_total{result="failed"}',
      ),
    ).toBe(1);
    // e o "último sucesso" não avança
    expect(
      await sample(
        registry,
        'wallet_reconciliation_last_run_timestamp_seconds',
      ),
    ).toBe(Date.parse('2026-11-26T12:00:00Z') / 1000);
  });

  test('adds the divergences found to the TOTAL, per kind, and a later clean run never takes them back', async () => {
    const registry = new PrometheusRegistry();
    reportReconciliation(registry, {
      divergences: { balance_mismatch: 2, ledger_gap: 1 },
      at: new Date('2026-11-26T12:00:00Z'),
    });
    reportReconciliation(registry, {
      divergences: {},
      at: new Date('2026-11-26T12:05:00Z'),
    });
    reportReconciliation(registry, {
      divergences: { balance_mismatch: 1 },
      at: new Date('2026-11-26T12:10:00Z'),
    });
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences_total{kind="balance_mismatch"}',
      ),
    ).toBe(3);
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences_total{kind="ledger_gap"}',
      ),
    ).toBe(1);
    // o gauge é o da ÚLTIMA execução; o total é o que alerta
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences{kind="balance_mismatch"}',
      ),
    ).toBe(1);
  });

  test('a failed run adds nothing to the total', async () => {
    const registry = new PrometheusRegistry();
    reportReconciliation(registry, {
      divergences: { ledger_gap: 4 },
      at: new Date('2026-11-26T12:00:00Z'),
    });
    reportReconciliation(registry, {
      divergences: {},
      at: new Date(),
      failed: true,
    });
    expect(
      await sample(
        registry,
        'wallet_reconciliation_divergences_total{kind="ledger_gap"}',
      ),
    ).toBe(4);
  });

  test('only the reconcile-wallet use case calls it in production', async () => {
    const hits: string[] = [];
    const glob = new Bun.Glob('src/**/*.ts');
    for await (const file of glob.scan('.')) {
      const path = file.replaceAll('\\', '/');
      if (path === 'src/application/reconciliation-metrics.ts') continue;
      if ((await Bun.file(file).text()).includes('reportReconciliation('))
        hits.push(path);
    }
    expect(hits).toEqual([
      'src/application/use-cases/reconcile-wallet.use-case.ts',
    ]);
  });
});
