import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Clock } from '../../application/ports/clock.js';
import { IdGenerator } from '../../application/ports/id-generator.js';
import { MetricsPort } from '../../application/ports/metrics.port.js';
import { PendingReferenceQueue } from '../../application/ports/pending-reference-queue.js';
import { UnitOfWork } from '../../application/ports/unit-of-work.js';
import { WagerTransactionReader } from '../../application/ports/wager-transaction-repository.js';
import { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case.js';
import { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';
import {
  loadPendingWorkerConfig,
  type PendingWorkerConfig,
} from './workers.config.js';

const PENDING_CONFIG = Symbol('PENDING_WORKER_CONFIG');

// Liga o worker de PENDING_REFERENCE ao ciclo de vida da aplicação. Desligado
// (PENDING_WORKER_ENABLED=false), o worker vale `undefined`.
@Module({
  providers: [
    { provide: PENDING_CONFIG, useFactory: () => loadPendingWorkerConfig() },
    {
      provide: PendingReferenceWorker,
      useFactory: (
        config: PendingWorkerConfig,
        queue: PendingReferenceQueue,
        uow: UnitOfWork,
        reader: WagerTransactionReader,
        clock: Clock,
        ids: IdGenerator,
        schedule: PendingReferenceSchedule,
        metrics: MetricsPort,
      ) =>
        config.enabled
          ? new PendingReferenceWorker(
              queue,
              // O MESMO caso de uso da resolução (Fase 3): o worker só decide QUANDO chamá-lo.
              new ResolvePendingReferenceUseCase(
                uow,
                reader,
                clock,
                ids,
                schedule,
                metrics,
              ),
              clock,
              {
                batchSize: config.batchSize,
                leaseMs: config.leaseMs,
                pollIntervalMs: config.pollIntervalMs,
                shutdownTimeoutMs: config.shutdownTimeoutMs,
              },
              metrics,
            )
          : undefined,
      inject: [
        PENDING_CONFIG,
        PendingReferenceQueue,
        UnitOfWork,
        WagerTransactionReader,
        Clock,
        IdGenerator,
        PendingReferenceSchedule,
        MetricsPort,
      ],
    },
  ],
})
export class PendingReferenceWorkerModule
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceWorkerModule.name);

  constructor(
    @Inject(PendingReferenceWorker)
    private readonly worker: PendingReferenceWorker | undefined,
  ) {}

  onApplicationBootstrap(): void {
    if (this.worker) {
      this.worker.start();
      this.logger.log({ event: 'pending_worker_started' });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      const report = await this.worker.stop();
      this.logger.log({ event: 'pending_worker_stopped', ...report });
    }
  }
}
