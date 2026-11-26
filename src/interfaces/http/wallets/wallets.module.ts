import { Module } from '@nestjs/common';
import { Clock } from '../../../application/ports/clock.js';
import { IdGenerator } from '../../../application/ports/id-generator.js';
import { UnitOfWork } from '../../../application/ports/unit-of-work.js';
import { LedgerReader } from '../../../application/ports/ledger-reader.js';
import { MetricsPort } from '../../../application/ports/metrics.port.js';
import { ReconciliationReader } from '../../../application/ports/reconciliation-reader.js';
import { WalletReader } from '../../../application/ports/wallet-reader.js';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case.js';
import {
  GetWalletUseCase,
  ListLedgerUseCase,
} from '../../../application/use-cases/queries.use-cases.js';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWalletUseCase(uow, clock, ids),
      inject: [UnitOfWork, Clock, IdGenerator],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (wallets: WalletReader) => new GetWalletUseCase(wallets),
      inject: [WalletReader],
    },
    {
      provide: ListLedgerUseCase,
      useFactory: (wallets: WalletReader, ledger: LedgerReader) =>
        new ListLedgerUseCase(wallets, ledger),
      inject: [WalletReader, LedgerReader],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        reader: ReconciliationReader,
        metrics: MetricsPort,
        clock: Clock,
      ) => new ReconcileWalletUseCase(reader, metrics, clock),
      inject: [ReconciliationReader, MetricsPort, Clock],
    },
  ],
})
export class WalletsModule {}
