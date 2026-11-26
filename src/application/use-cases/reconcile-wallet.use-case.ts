import { parseUuidParam } from '../queries/params.js';
import { WalletNotFoundError } from '../errors/application-errors.js';
import type { Clock } from '../ports/clock.js';
import type { MetricsPort } from '../ports/metrics.port.js';
import type { ReconciliationReader } from '../ports/reconciliation-reader.js';
import type { ReconciliationResult } from '../queries/queries.js';
import {
  reportReconciliation,
  type DivergenceKind,
} from '../reconciliation-metrics.js';

// Confere UMA wallet: o saldo guardado contra o que o ledger reconstrói, e se a corrente de
// lançamentos fecha. Só LÊ: nunca corrige. Correção de dinheiro é decisão humana e auditada
// (ADR-0015); aqui a divergência vira uma resposta (consistent: false), uma métrica e, no
// controller, um log de erro.
export class ReconcileWalletUseCase {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly metrics: MetricsPort,
    private readonly clock: Clock,
  ) {}

  async execute(input: { walletId: unknown }): Promise<ReconciliationResult> {
    const walletId = parseUuidParam(input.walletId, 'walletId');
    let facts;
    try {
      facts = await this.reader.snapshot(walletId);
    } catch (error) {
      // O banco caiu no meio: a conferência não provou nada, e isso também é contado.
      reportReconciliation(this.metrics, {
        divergences: {},
        at: this.clock.now(),
        failed: true,
      });
      throw error;
    }
    if (!facts) {
      throw new WalletNotFoundError(walletId);
    }

    const findings: DivergenceKind[] = [];
    if (facts.difference !== '0.00') {
      findings.push('balance_mismatch');
    }
    // A corrente: cada lançamento parte de onde o anterior parou, as versões são consecutivas, e
    // a versão guardada na wallet é a do último lançamento (1 se ainda não há nenhum).
    if (
      facts.chainBreaks > 0 ||
      facts.versionGaps > 0 ||
      facts.storedVersion !== (facts.lastVersion ?? 1)
    ) {
      findings.push('ledger_gap');
    }
    if (facts.storedBalance.startsWith('-')) {
      findings.push('negative_balance');
    }

    reportReconciliation(this.metrics, {
      divergences: Object.fromEntries(findings.map((kind) => [kind, 1])),
      at: this.clock.now(),
    });

    const money = (amount: string) => ({ amount, currency: facts.currency });
    return {
      walletId,
      storedBalance: money(facts.storedBalance),
      calculatedBalance: money(facts.calculatedBalance),
      difference: money(facts.difference),
      consistent: findings.length === 0,
      checkedEntries: facts.checkedEntries,
      findings,
    };
  }
}
