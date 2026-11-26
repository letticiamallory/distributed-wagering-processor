import { Logger } from '@nestjs/common';
import type { Clock } from '../../application/ports/clock.js';
import type { OutboxReader } from '../../application/ports/outbox-repository.js';
import type {
  PublishOutboxBatchUseCase,
  PublishReport,
} from '../../application/use-cases/publish-outbox-batch.use-case.js';
import { WorkerLoop } from './worker-loop.js';

export interface OutboxWorkerOptions {
  batchSize: number;
  pollIntervalMs: number;
  statsIntervalMs: number;
  shutdownTimeoutMs: number;
}

const ERROR_PAUSE_MS = 1_000;

// O laço do publisher da outbox: roda um ciclo; se o lote veio cheio, segue direto (há mais
// trabalho); senão espera o intervalo. Loga o que falhou (warn; error a partir de "preso") e, de
// tempos em tempos, o estado da outbox (pendentes e lag), a base do gauge `outbox_lag_seconds` da
// fase de observabilidade.
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly loop: WorkerLoop;
  private lastStatsAt = 0;

  constructor(
    private readonly useCase: PublishOutboxBatchUseCase,
    private readonly reader: OutboxReader,
    private readonly clock: Clock,
    private readonly options: OutboxWorkerOptions,
  ) {
    this.loop = new WorkerLoop(options.shutdownTimeoutMs);
  }

  // Um ciclo (os testes o chamam direto, com o relógio na mão).
  async tick(): Promise<PublishReport> {
    const report = await this.useCase.execute();
    for (const failure of report.failed) {
      const entry = {
        eventId: failure.eventId,
        correlationId: failure.eventId,
        walletId: failure.walletId,
        eventType: failure.eventType,
        attempts: failure.attempts,
        error: failure.error,
      };
      if (failure.stuck) {
        // Nunca descartado: o retry continua para sempre, mas alguém precisa olhar.
        this.logger.error({ event: 'outbox_event_stuck', ...entry });
      } else {
        this.logger.warn({ event: 'outbox_event_retry', ...entry });
      }
    }
    if (report.published > 0) {
      this.logger.log({
        event: 'outbox_batch_published',
        claimed: report.claimed,
        published: report.published,
        failed: report.failed.length,
      });
    }
    return report;
  }

  start(): void {
    this.loop.start(async () => {
      let report: PublishReport;
      try {
        report = await this.tick();
      } catch (error) {
        // Banco indisponível, por exemplo: nada foi marcado, tenta de novo no próximo ciclo.
        this.logger.warn({
          event: 'outbox_cycle_failed',
          message: error instanceof Error ? error.message : String(error),
        });
        return ERROR_PAUSE_MS;
      }
      await this.logStats();
      return report.claimed >= this.options.batchSize
        ? 0
        : this.options.pollIntervalMs;
    });
  }

  async stop(): Promise<{ drained: boolean }> {
    return this.loop.stop();
  }

  private async logStats(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastStatsAt < this.options.statsIntervalMs) {
      return;
    }
    this.lastStatsAt = nowMs;
    try {
      const stats = await this.reader.stats(this.clock.now());
      if (stats.pending > 0) {
        this.logger.log({ event: 'outbox_stats', ...stats });
      }
    } catch {
      // as estatísticas são só observabilidade: nunca derrubam um ciclo
    }
  }
}
