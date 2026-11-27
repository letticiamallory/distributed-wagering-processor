import { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Clock } from '../../application/ports/clock.js';
import { MetricsPort } from '../../application/ports/metrics.port.js';
import { IntegrationEventPublisher } from '../../application/ports/integration-event-publisher.js';
import { OutboxReader } from '../../application/ports/outbox-repository.js';
import { UnitOfWork } from '../../application/ports/unit-of-work.js';
import { PublishOutboxBatchUseCase } from '../../application/use-cases/publish-outbox-batch.use-case.js';
import { SqsEventPublisher } from '../../infrastructure/messaging/sqs-event-publisher.js';
import { resolveQueueUrl } from '../sqs/queue-url.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';
import {
  loadOutboxPublisherConfig,
  type OutboxPublisherConfig,
} from './workers.config.js';

const OUTBOX_CONFIG = Symbol('OUTBOX_PUBLISHER_CONFIG');
const OUTBOX_SQS = Symbol('OUTBOX_PUBLISHER_SQS');

// Liga o publisher da outbox ao ciclo de vida da aplicação. Desligado (OUTBOX_PUBLISHER_ENABLED=
// false), nem fala com o SQS: a porta de publicação e o worker valem `undefined`.
@Module({
  providers: [
    { provide: OUTBOX_CONFIG, useFactory: () => loadOutboxPublisherConfig() },
    {
      provide: OUTBOX_SQS,
      // Poucas tentativas do SDK: o prazo de verdade é o do publisher (a transação está aberta).
      useFactory: () =>
        new SQSClient({ endpoint: process.env.SQS_ENDPOINT, maxAttempts: 2 }),
    },
    {
      provide: IntegrationEventPublisher,
      useFactory: async (config: OutboxPublisherConfig, client: SQSClient) =>
        config.enabled
          ? new SqsEventPublisher(
              client,
              await resolveQueueUrl(client, config.queueName),
              { timeoutMs: config.sendTimeoutMs },
            )
          : undefined,
      inject: [OUTBOX_CONFIG, OUTBOX_SQS],
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (
        config: OutboxPublisherConfig,
        publisher: IntegrationEventPublisher | undefined,
        uow: UnitOfWork,
        reader: OutboxReader,
        clock: Clock,
        metrics: MetricsPort,
      ) =>
        publisher
          ? new OutboxPublisherWorker(
              new PublishOutboxBatchUseCase(
                uow,
                publisher,
                clock,
                {
                  batchSize: config.batchSize,
                  jitter: Math.random,
                  stuckAfterAttempts: config.stuckAfterAttempts,
                },
                metrics,
              ),
              reader,
              clock,
              {
                batchSize: config.batchSize,
                pollIntervalMs: config.pollIntervalMs,
                statsIntervalMs: config.statsIntervalMs,
                shutdownTimeoutMs: config.shutdownTimeoutMs,
              },
            )
          : undefined,
      inject: [
        OUTBOX_CONFIG,
        IntegrationEventPublisher,
        UnitOfWork,
        OutboxReader,
        Clock,
        MetricsPort,
      ],
    },
  ],
})
export class OutboxPublisherModule
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisherModule.name);

  constructor(
    @Inject(OutboxPublisherWorker)
    private readonly worker: OutboxPublisherWorker | undefined,
    @Inject(OUTBOX_SQS) private readonly client: SQSClient,
  ) {}

  // Só depois de a aplicação toda estar de pé (banco pronto) a publicação começa.
  onApplicationBootstrap(): void {
    if (this.worker) {
      this.worker.start();
      this.logger.log({ event: 'outbox_publisher_started' });
    }
  }

  // O SIGTERM chega aqui (gracefulShutdown do bootstrap -> app.close(), depois de o HTTP drenar): o ciclo em andamento termina
  // (marca o que publicou) e nenhum outro começa. O banco só fecha depois.
  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      const report = await this.worker.stop();
      this.logger.log({ event: 'outbox_publisher_stopped', ...report });
    }
    this.client.destroy();
  }
}
