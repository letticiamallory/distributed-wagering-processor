import type { MetricsPort } from './ports/metrics.port.js';

// Os tipos de divergência que a reconciliação (Fase 8) vai procurar.
export const DIVERGENCE_KINDS = [
  'balance_mismatch',
  'ledger_gap',
  'negative_balance',
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

export interface ReconciliationReport {
  // Quantas wallets divergentes por tipo (o que não aparece vale 0).
  divergences: Partial<Record<DivergenceKind, number>>;
  at: Date;
  // A execução falhou antes de terminar (o banco caiu, por exemplo): não zera as divergências.
  failed?: boolean;
}

// Pronta e testada, mas nada a chama ainda: a reconciliação da Fase 8 a usa ao fim de cada
// execução. Uma execução que terminou REPLACE os valores (um tipo que não aparece volta a 0, para
// uma divergência já corrigida sumir do alerta); uma que FALHOU não prova nada, então só conta a
// falha e deixa os valores e o "último sucesso" como estavam.
export function reportReconciliation(
  metrics: MetricsPort,
  report: ReconciliationReport,
): void {
  if (report.failed) {
    metrics.increment('wallet_reconciliation_runs_total', { result: 'failed' });
    return;
  }
  let total = 0;
  for (const kind of DIVERGENCE_KINDS) {
    const count = report.divergences[kind] ?? 0;
    total += count;
    metrics.set('wallet_reconciliation_divergences', { kind }, count);
  }
  metrics.set(
    'wallet_reconciliation_last_run_timestamp_seconds',
    {},
    report.at.getTime() / 1000,
  );
  metrics.increment('wallet_reconciliation_runs_total', {
    result: total === 0 ? 'clean' : 'divergent',
  });
}
