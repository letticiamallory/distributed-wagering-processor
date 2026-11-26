import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Clock } from '../../application/ports/clock.js';
import { IdGenerator } from '../../application/ports/id-generator.js';
import { InboxReader } from '../../application/ports/inbox-repository.js';
import { LedgerReader } from '../../application/ports/ledger-reader.js';
import { MetricsPort } from '../../application/ports/metrics.port.js';
import { OutboxReader } from '../../application/ports/outbox-repository.js';
import { PendingReferenceQueue } from '../../application/ports/pending-reference-queue.js';
import { ReconciliationReader } from '../../application/ports/reconciliation-reader.js';
import { WalletReader } from '../../application/ports/wallet-reader.js';
import { UnitOfWork } from '../../application/ports/unit-of-work.js';
import { WagerTransactionReader } from '../../application/ports/wager-transaction-repository.js';
import { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { loadPendingReferenceSchedule } from '../config/pending-reference-schedule.config.js';
import { PostgresProbe } from '../health/postgres-probe.js';
import { SystemClock } from '../system/system-clock.js';
import { UuidV7Generator } from '../system/uuid-v7-generator.js';
import { loadLockTimeoutMs } from './lock-timeout.config.js';
import config from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { MikroOrmInboxReader } from './repositories/mikro-orm-inbox.reader.js';
import {
  MikroOrmLedgerReader,
  MikroOrmReconciliationReader,
  MikroOrmWalletReader,
} from './repositories/mikro-orm-readers.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository.js';
import { MikroOrmPendingReferenceQueue } from './repositories/mikro-orm-pending-reference.queue.js';
import { MikroOrmWagerTransactionReader } from './repositories/mikro-orm-wager-transaction.reader.js';

// A ligação das portas da aplicação com o MikroORM e com o relógio e o gerador de ids reais.
// Global: todo módulo de funcionalidade usa estas portas, sem repetir o import. Valores
// inválidos de ambiente (DB_LOCK_TIMEOUT_MS, PENDING_REFERENCE_*) derrubam a subida aqui.
@Global()
@Module({
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(config) },
    {
      provide: UnitOfWork,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmUnitOfWork(orm.em, {
          lockTimeoutMs: loadLockTimeoutMs(),
          metrics,
        }),
      inject: [MikroORM, MetricsPort],
    },
    {
      provide: WagerTransactionReader,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmWagerTransactionReader(orm.em, metrics),
      inject: [MikroORM, MetricsPort],
    },
    {
      provide: InboxReader,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmInboxReader(orm.em, metrics),
      inject: [MikroORM, MetricsPort],
    },
    {
      provide: WalletReader,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmWalletReader(orm.em, metrics),
      inject: [MikroORM, MetricsPort],
    },
    {
      provide: LedgerReader,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmLedgerReader(orm.em, metrics),
      inject: [MikroORM, MetricsPort],
    },
    {
      provide: ReconciliationReader,
      useFactory: (orm: MikroORM, metrics: MetricsPort) =>
        new MikroOrmReconciliationReader(orm.em, metrics),
      inject: [MikroORM, MetricsPort],
    },
    {
      // A outbox fora de transação: só as consultas de observabilidade (stats).
      provide: OutboxReader,
      useFactory: (orm: MikroORM) => new MikroOrmOutboxRepository(orm.em),
      inject: [MikroORM],
    },
    {
      provide: PendingReferenceQueue,
      useFactory: (orm: MikroORM) => new MikroOrmPendingReferenceQueue(orm.em),
      inject: [MikroORM],
    },
    {
      // O /health/ready testa o banco por aqui (um SELECT 1 de verdade, com prazo).
      provide: PostgresProbe,
      useFactory: (orm: MikroORM) => new PostgresProbe(orm.em),
      inject: [MikroORM],
    },
    { provide: Clock, useFactory: () => new SystemClock() },
    { provide: IdGenerator, useFactory: () => new UuidV7Generator() },
    {
      provide: PendingReferenceSchedule,
      useFactory: () => loadPendingReferenceSchedule(),
    },
  ],
  exports: [
    UnitOfWork,
    WagerTransactionReader,
    InboxReader,
    OutboxReader,
    WalletReader,
    LedgerReader,
    ReconciliationReader,
    PendingReferenceQueue,
    PostgresProbe,
    Clock,
    IdGenerator,
    PendingReferenceSchedule,
  ],
})
export class PersistenceModule implements OnModuleDestroy {
  constructor(private readonly orm: MikroORM) {}

  async onModuleDestroy(): Promise<void> {
    await this.orm.close();
  }
}
