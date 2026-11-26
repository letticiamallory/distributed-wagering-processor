import { Logger } from '@nestjs/common';
import type { Clock } from '../../application/ports/clock.js';
import type {
  PendingReferenceQueue,
  ReservedPending,
} from '../../application/ports/pending-reference-queue.js';
import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case.js';
import { WorkerLoop } from './worker-loop.js';

export interface PendingWorkerOptions {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  shutdownTimeoutMs: number;
}

export interface PendingTickReport {
  reserved: number;
  resolved: number;
  stillPending: number;
  notPending: number;
  failed: number;
}

const ERROR_PAUSE_MS = 1_000;

// O worker de PENDING_REFERENCE (ADR-0013): reserva as pendentes vencidas (lease, sem o lock da
// wallet) e chama, para cada uma, o MESMO ResolvePendingReferenceUseCase da Fase 3, que trava a
// wallet, relê o estado e decide. Wallets diferentes em paralelo; a mesma wallet em sequência.
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly loop: WorkerLoop;
  // Depois do stop(), o que ainda não começou fica para o lease vencer (não há pressa de resolver).
  private stopping = false;

  constructor(
    private readonly queue: PendingReferenceQueue,
    private readonly resolver: Pick<ResolvePendingReferenceUseCase, 'execute'>,
    private readonly clock: Clock,
    private readonly options: PendingWorkerOptions,
  ) {
    this.loop = new WorkerLoop(options.shutdownTimeoutMs);
  }

  async tick(): Promise<PendingTickReport> {
    const reserved = await this.queue.reserveDue(
      this.options.batchSize,
      this.options.leaseMs,
      this.clock.now(),
    );
    const report: PendingTickReport = {
      reserved: reserved.length,
      resolved: 0,
      stillPending: 0,
      notPending: 0,
      failed: 0,
    };

    const byWallet = new Map<string, ReservedPending[]>();
    for (const item of reserved) {
      const list = byWallet.get(item.walletId) ?? [];
      list.push(item);
      byWallet.set(item.walletId, list);
    }
    await Promise.all(
      [...byWallet.values()].map(async (items) => {
        for (const item of items) {
          if (this.stopping) return;
          try {
            const result = await this.resolver.execute(
              { transactionId: item.transactionId },
              { correlationId: `pending-worker:${item.transactionId}` },
            );
            switch (result.outcome) {
              case 'RESOLVED':
                report.resolved++;
                break;
              case 'STILL_PENDING':
                report.stillPending++;
                break;
              default:
                report.notPending++;
            }
          } catch (error) {
            // Erro de infraestrutura: nada foi gravado e a tentativa NÃO é gasta. O lease vence e
            // o item volta a ser devido.
            report.failed++;
            this.logger.warn({
              event: 'pending_resolve_failed',
              transactionId: item.transactionId,
              walletId: item.walletId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );
    return report;
  }

  start(): void {
    this.loop.start(async () => {
      try {
        const report = await this.tick();
        return report.reserved >= this.options.batchSize
          ? 0
          : this.options.pollIntervalMs;
      } catch (error) {
        this.logger.warn({
          event: 'pending_cycle_failed',
          message: error instanceof Error ? error.message : String(error),
        });
        return ERROR_PAUSE_MS;
      }
    });
  }

  async stop(): Promise<{ drained: boolean }> {
    this.stopping = true;
    return this.loop.stop();
  }
}
