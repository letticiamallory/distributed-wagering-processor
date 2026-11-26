import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConsumerRetryPolicy } from '../../application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../application/messaging/wager-message-handler.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { WageringModule } from '../http/wagering/wagering.module.js';
import { AwsQueueGateway } from './aws-queue-gateway.js';
import { QueueGateway } from './queue-gateway.js';
import {
  loadSqsConsumerConfig,
  type SqsConsumerConfig,
} from './sqs-consumer.config.js';
import { WagerSqsConsumer } from './wager-sqs.consumer.js';

const SQS_CONSUMER_CONFIG = Symbol('SQS_CONSUMER_CONFIG');

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Procura as URLs das duas filas pelo nome. No docker compose o `queues-init` termina antes de
// a app subir, mas o SQS pode demorar a responder: tenta por até ~30 s e só então desiste (e a
// aplicação não sobe, em vez de ficar de pé sem consumir).
export async function resolveQueueUrls(
  client: SQSClient,
  names: { queueName: string; dlqName: string },
  options: { attempts?: number; pauseMs?: number } = {},
): Promise<{ queueUrl: string; dlqUrl: string }> {
  const attempts = options.attempts ?? 15;
  const pauseMs = options.pauseMs ?? 2_000;
  const logger = new Logger('SqsConsumerModule');
  for (let attempt = 1; ; attempt++) {
    try {
      const [queue, dlq] = await Promise.all([
        client.send(new GetQueueUrlCommand({ QueueName: names.queueName })),
        client.send(new GetQueueUrlCommand({ QueueName: names.dlqName })),
      ]);
      return { queueUrl: String(queue.QueueUrl), dlqUrl: String(dlq.QueueUrl) };
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(
          `the SQS queues ${names.queueName} / ${names.dlqName} were not found after ${attempts} attempts`,
          { cause: error },
        );
      }
      logger.warn({
        event: 'queue_lookup_failed',
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(pauseMs);
    }
  }
}

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
            )
          : undefined,
      inject: [
        SQS_CONSUMER_CONFIG,
        QueueGateway,
        ProcessWagerTransactionUseCase,
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
