import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Clock } from '../../application/ports/clock.js';
import { IdGenerator } from '../../application/ports/id-generator.js';
import { InboxReader } from '../../application/ports/inbox-repository.js';
import { UnitOfWork } from '../../application/ports/unit-of-work.js';
import { WagerTransactionReader } from '../../application/ports/wager-transaction-repository.js';
import { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { loadPendingReferenceSchedule } from '../config/pending-reference-schedule.config.js';
import { SystemClock } from '../system/system-clock.js';
import { UuidV7Generator } from '../system/uuid-v7-generator.js';
import { loadLockTimeoutMs } from './lock-timeout.config.js';
import config from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { MikroOrmInboxReader } from './repositories/mikro-orm-inbox.reader.js';
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
      useFactory: (orm: MikroORM) =>
        new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: loadLockTimeoutMs() }),
      inject: [MikroORM],
    },
    {
      provide: WagerTransactionReader,
      useFactory: (orm: MikroORM) => new MikroOrmWagerTransactionReader(orm.em),
      inject: [MikroORM],
    },
    {
      provide: InboxReader,
      useFactory: (orm: MikroORM) => new MikroOrmInboxReader(orm.em),
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
