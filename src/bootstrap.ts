import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// A aplicação como o main.ts a sobe. Separada dele para os testes conferirem que o SIGTERM está
// ligado ao encerramento: sem `enableShutdownHooks()` o Nest ignora o sinal e o processo morre
// no meio de uma mensagem, sem o consumidor devolver a visibilidade (ADR-0011).
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  return app;
}
