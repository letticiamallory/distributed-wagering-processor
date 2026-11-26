import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import {
  JsonLogger,
  loadLogLevel,
} from './infrastructure/observability/json-logger.js';

// A aplicação como o main.ts a sobe. Separada dele para os testes conferirem que o SIGTERM está
// ligado ao encerramento: sem `enableShutdownHooks()` o Nest ignora o sinal e o processo morre
// no meio de uma mensagem, sem o consumidor devolver a visibilidade (ADR-0011).
export async function createApp(): Promise<INestApplication> {
  // Logs estruturados desde a primeira linha (ADR-0014): UM objeto JSON por linha, em stdout.
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(undefined, loadLogLevel()),
  });
  app.enableShutdownHooks();
  return app;
}
