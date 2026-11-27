import { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { PostgresProbe } from '../../../infrastructure/health/postgres-probe.js';
import { SqsProbe } from '../../../infrastructure/health/sqs-probe.js';
import { requiredQueueNames } from './required-queues.js';
import { HttpConfig, loadHttpConfig } from '../http-config.js';
import { HealthController } from './health.controller.js';
import { HealthService, READINESS_PROBES } from './health.service.js';

const HEALTH_SQS = Symbol('HEALTH_SQS');

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: HttpConfig, useFactory: () => loadHttpConfig() },
    {
      provide: HEALTH_SQS,
      // Uma tentativa só: o prazo da sonda é o que vale, e o SDK não pode multiplicá-lo.
      useFactory: () =>
        new SQSClient({ endpoint: process.env.SQS_ENDPOINT, maxAttempts: 1 }),
    },
    {
      provide: READINESS_PROBES,
      useFactory: (postgres: PostgresProbe, sqs: SQSClient) => [
        postgres,
        new SqsProbe(sqs, requiredQueueNames()),
      ],
      inject: [PostgresProbe, HEALTH_SQS],
    },
  ],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(HEALTH_SQS) private readonly sqs: SQSClient) {}

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
