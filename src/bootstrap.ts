import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import {
  JsonLogger,
  loadLogLevel,
} from './infrastructure/observability/json-logger.js';
import { HealthService } from './interfaces/http/health/health.service.js';
import { loadHttpConfig } from './interfaces/http/http-config.js';
import { WagerSqsConsumer } from './interfaces/sqs/wager-sqs.consumer.js';
import { OutboxPublisherWorker } from './interfaces/workers/outbox-publisher.worker.js';
import { PendingReferenceWorker } from './interfaces/workers/pending-reference.worker.js';

export interface ShutdownOptions {
  // Por quanto tempo o HTTP continua atendendo, com o /health/ready em 503.
  drainMs: number;
  // Quanto esperar as requisições em andamento depois de parar de aceitar novas.
  timeoutMs: number;
  // O que fazer no fim (o processo de verdade reenvia o sinal a si mesmo; os testes não saem).
  exit: (signal: string) => void;
}

const logger = new Logger('Shutdown');

// O encerramento, na ordem (C7, ADR-0011, ADR-0014):
//   1. /health/ready vira 503 (o balanceador para de mandar tráfego novo);
//   2. drenagem: o HTTP continua atendendo normalmente, com o banco aberto, por drainMs;
//   3. o consumidor SQS termina (ou devolve) as mensagens em andamento e os workers param, COM O HTTP
//      AINDA NO AR: enquanto isso o /health/live responde 200 (um orquestrador não mata o processo
//      no meio de uma mensagem) e o /health/ready, 503;
//   4. o servidor HTTP para de aceitar e espera as requisições em andamento (até timeoutMs, e
//      depois corta as conexões que sobraram);
//   5. app.close(): o resto, e SÓ ENTÃO a persistência fecha o pool.
// Antes, o enableShutdownHooks do Nest fazia o 4 primeiro (os módulos são destruídos antes de o
// HTTP fechar): quem chegava durante o encerramento achava o banco fechado (503) ou a conexão
// cortada.
export async function gracefulShutdown(
  app: INestApplication,
  signal: string,
  options: ShutdownOptions,
): Promise<void> {
  app.get(HealthService, { strict: false }).markShuttingDown();
  logger.log({ event: 'shutdown_draining', signal, drainMs: options.drainMs });
  await new Promise((resolve) => setTimeout(resolve, options.drainMs));

  await stopBackgroundWork(app);
  logger.log({ event: 'shutdown_background_stopped', signal });

  const server = app.getHttpServer() as Server;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, options.timeoutMs);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    // Conexões keep-alive paradas não seguram o fechamento; as que estão atendendo, sim.
    server.closeIdleConnections?.();
  });
  logger.log({ event: 'shutdown_http_closed', signal });

  await app.close();
  options.exit(signal);
}

// O consumidor SQS e os workers, parados ANTES de o HTTP fechar. Cada stop() aceita ser chamado de
// novo: o onModuleDestroy deles, no app.close(), vira no-op. Um componente desligado não existe
// (o provider vale undefined).
async function stopBackgroundWork(app: INestApplication): Promise<void> {
  const optional = <T>(token: new (...args: never[]) => T): T | undefined => {
    try {
      return app.get(token, { strict: false }) as T | undefined;
    } catch {
      return undefined;
    }
  };
  await Promise.all([
    optional(WagerSqsConsumer)?.stop(),
    optional(OutboxPublisherWorker)?.stop(),
    optional(PendingReferenceWorker)?.stop(),
  ]);
}

// A aplicação como o main.ts a sobe. Separada dele para os testes conferirem que o SIGTERM está
// ligado ao encerramento: sem isso o processo morre no meio de uma mensagem, sem o consumidor
// devolver a visibilidade (ADR-0011).
export async function createApp(): Promise<INestApplication> {
  // Logs estruturados desde a primeira linha (ADR-0014): UM objeto JSON por linha, em stdout.
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(undefined, loadLogLevel()),
  });
  installShutdownSignals(app);
  return app;
}

// SIGTERM e SIGINT disparam o gracefulShutdown uma vez. No fim, o processo reenvia o próprio sinal
// (sem os ouvintes, o padrão do Node encerra), como o enableShutdownHooks do Nest fazia. Um
// app.close() direto (os testes) também tira os ouvintes, quando o servidor HTTP fecha.
function installShutdownSignals(app: INestApplication): void {
  const config = loadHttpConfig();
  let started = false;
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const remove = () => {
    for (const signal of signals) process.off(signal, handler);
  };
  const handler = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    void gracefulShutdown(app, signal, {
      drainMs: config.shutdownDrainMs,
      timeoutMs: config.shutdownTimeoutMs,
      exit: (received) => {
        remove();
        process.kill(process.pid, received);
      },
    }).catch((error: unknown) => {
      logger.error({ event: 'shutdown_failed', message: String(error) });
      process.exit(1);
    });
  };
  for (const signal of signals) process.on(signal, handler);
  // O app do NestFactory é um Proxy (não dá para trocar o close); o servidor HTTP é fechado dentro
  // de todo app.close(), então o evento 'close' dele é o momento de tirar os ouvintes.
  (app.getHttpServer() as Server).once('close', remove);
}
