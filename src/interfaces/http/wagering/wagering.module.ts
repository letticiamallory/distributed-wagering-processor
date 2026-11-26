import { Module } from '@nestjs/common';
import { Clock } from '../../../application/ports/clock.js';
import { IdGenerator } from '../../../application/ports/id-generator.js';
import { InboxReader } from '../../../application/ports/inbox-repository.js';
import { MetricsPort } from '../../../application/ports/metrics.port.js';
import { UnitOfWork } from '../../../application/ports/unit-of-work.js';
import { WagerTransactionReader } from '../../../application/ports/wager-transaction-repository.js';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { PendingReferenceSchedule } from '../../../domain/wager/pending-reference-schedule.js';
import { GetTransactionUseCase } from '../../../application/use-cases/queries.use-cases.js';
import { ProvidersController } from './providers.controller.js';
import { WagerTransactionsController } from './wager-transactions.controller.js';

@Module({
  controllers: [WagerTransactionsController, ProvidersController],
  providers: [
    {
      provide: GetTransactionUseCase,
      useFactory: (reader: WagerTransactionReader) =>
        new GetTransactionUseCase(reader),
      inject: [WagerTransactionReader],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (
        uow: UnitOfWork,
        reader: WagerTransactionReader,
        inboxReader: InboxReader,
        clock: Clock,
        ids: IdGenerator,
        schedule: PendingReferenceSchedule,
        metrics: MetricsPort,
      ) =>
        new ProcessWagerTransactionUseCase(
          uow,
          reader,
          inboxReader,
          clock,
          ids,
          schedule,
          metrics,
        ),
      inject: [
        UnitOfWork,
        WagerTransactionReader,
        InboxReader,
        Clock,
        IdGenerator,
        PendingReferenceSchedule,
        MetricsPort,
      ],
    },
  ],
  // O consumidor SQS usa o MESMO caso de uso do HTTP (enunciado, seção 10).
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
