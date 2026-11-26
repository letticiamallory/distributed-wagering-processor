import { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { MetricsPort } from '../../application/ports/metrics.port.js';
import { ConsumerRetryPolicy } from '../../application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../application/messaging/wager-message-handler.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { WageringModule } from '../http/wagering/wagering.module.js';
import { AwsQueueGateway } from './aws-queue-gateway.js';
import { QueueGateway } from './queue-gateway.js';
import { resolveQueueUrls } from './queue-url.js';
import {
  loadSqsConsumerConfig,
  type SqsConsumerConfig,
} from './sqs-consumer.config.js';
import { WagerSqsConsumer } from './wager-sqs.consumer.js';

const SQS_CONSUMER_CONFIG = Symbol('SQS_CONSUMER_CONFIG');

// A procura das URLs mora em queue-url.ts (o publisher da outbox usa a mesma).
export { resolveQueueUrls };

// Liga o consumidor ao ciclo de vida da aplicação. Desligado (SQS_CONSUMER_ENABLED=false), nem
// fala com o SQS: o gateway e o consumidor valem `undefined`.
@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CONSUMER_CONFIG, useFactory: () => loadSqsConsumerConfig() },
    {
      provide: SQSClient,
      // O endpoint e as credenciais vêm do ambiente (SQS_ENDPOINT, AWS_*), como no compose.
      useFactory: () => new SQSClient({ endpoint: process.env.SQS_ENDPOINT }),
    },
    {
      provide: QueueGateway,
      useFactory: async (config: SqsConsumerConfig, client: SQSClient) =>
        config.enabled
          ? new AwsQueueGateway(client, await resolveQueueUrls(client, config))
          : undefined,
      inject: [SQS_CONSUMER_CONFIG, SQSClient],
    },
    {
      provide: WagerSqsConsumer,
      useFactory: (
        config: SqsConsumerConfig,
        gateway: QueueGateway | undefined,
        useCase: ProcessWagerTransactionUseCase,
        metrics: MetricsPort,
      ) =>
        gateway
          ? new WagerSqsConsumer(
              gateway,
              new WagerMessageHandler(
                useCase,
                new ConsumerRetryPolicy({
                  maxReceiveCount: config.maxReceiveCount,
                  baseSeconds: config.retryBaseSeconds,
                  maxSeconds: config.retryMaxSeconds,
                }),
              ),
              {
                waitSeconds: config.waitSeconds,
                batchSize: 10,
                shutdownTimeoutMs: config.shutdownTimeoutMs,
              },
              metrics,
            )
          : undefined,
      inject: [
        SQS_CONSUMER_CONFIG,
        QueueGateway,
        ProcessWagerTransactionUseCase,
        MetricsPort,
      ],
    },
  ],
})
export class SqsConsumerModule
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SqsConsumerModule.name);

  constructor(
    @Inject(WagerSqsConsumer)
    private readonly consumer: WagerSqsConsumer | undefined,
    @Inject(SQSClient) private readonly client: SQSClient,
  ) {}

  // Só depois de a aplicação toda estar de pé (banco e rotas prontos) o consumo começa.
  onApplicationBootstrap(): void {
    this.consumer?.start();
    if (this.consumer) {
      this.logger.log({ event: 'sqs_consumer_started' });
    }
  }

  // O SIGTERM chega aqui (enableShutdownHooks -> app.close()): para de buscar, termina o que
  // está em andamento e devolve o resto. O banco só fecha depois (ver o teste do e2e).
  async onModuleDestroy(): Promise<void> {
    if (this.consumer) {
      const report = await this.consumer.stop();
      this.logger.log({ event: 'sqs_consumer_stopped', ...report });
    }
    this.client.destroy();
  }
}
