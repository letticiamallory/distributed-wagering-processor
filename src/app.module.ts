import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { correlationIdMiddleware } from './interfaces/http/correlation-id.js';
import { HealthModule } from './interfaces/http/health/health.module.js';
import { HttpConfig, loadHttpConfig } from './interfaces/http/http-config.js';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter.js';
import { WageringModule } from './interfaces/http/wagering/wagering.module.js';
import { WalletsModule } from './interfaces/http/wallets/wallets.module.js';

@Module({
  imports: [PersistenceModule, HealthModule, WalletsModule, WageringModule],
  providers: [
    { provide: HttpConfig, useFactory: () => loadHttpConfig() },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  // Em TODAS as rotas (inclusive as que não existem): toda resposta leva o correlationId.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationIdMiddleware).forRoutes('*');
  }
}
