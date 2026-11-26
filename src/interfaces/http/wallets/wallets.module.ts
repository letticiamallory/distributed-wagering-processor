import { Module } from '@nestjs/common';
import { Clock } from '../../../application/ports/clock.js';
import { IdGenerator } from '../../../application/ports/id-generator.js';
import { UnitOfWork } from '../../../application/ports/unit-of-work.js';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case.js';
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
  ],
})
export class WalletsModule {}
