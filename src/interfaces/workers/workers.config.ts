import {
  InvalidEnvironmentError,
  readIntegerVariable,
} from '../../config/env-integer.js';

export interface OutboxPublisherConfig {
  // Liga o publisher da outbox neste processo. Padrão: ligado; os testes o desligam em
  // test/support/setup.ts e só o teste que precisa o liga.
  enabled: boolean;
  queueName: string;
  // Eventos por ciclo (o SendMessageBatch aceita no máximo 10).
  batchSize: number;
  pollIntervalMs: number;
  // Quanto esperar o SQS por um lote antes de desistir (a transação fica aberta nesse tempo).
  sendTimeoutMs: number;
  statsIntervalMs: number;
  // A partir de quantas tentativas um evento é "preso" e o log sobe para error.
  stuckAfterAttempts: number;
  shutdownTimeoutMs: number;
}

export interface PendingWorkerConfig {
  enabled: boolean;
  batchSize: number;
  pollIntervalMs: number;
  // Por quanto tempo um item reservado fica "do" worker que o reservou. Se ele morrer, o item
  // volta a ser devido quando o lease vence.
  leaseMs: number;
  shutdownTimeoutMs: number;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new InvalidEnvironmentError(
    `${name} must be "true" or "false" (got "${raw}")`,
  );
}

function readName(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? fallback : raw;
}

// Lê e valida na subida (como as outras variáveis): um valor inválido derruba a aplicação dizendo
// QUAL variável é.
export function loadOutboxPublisherConfig(
  env: NodeJS.ProcessEnv = process.env,
): OutboxPublisherConfig {
  return {
    enabled: readBoolean(env, 'OUTBOX_PUBLISHER_ENABLED', true),
    queueName: readName(env, 'OUTBOX_QUEUE_NAME', 'wallet-events.fifo'),
    batchSize: readIntegerVariable(env, {
      name: 'OUTBOX_BATCH_SIZE',
      fallback: 10,
      min: 1,
      max: 10,
    }),
    pollIntervalMs: readIntegerVariable(env, {
      name: 'OUTBOX_POLL_INTERVAL_MS',
      fallback: 500,
      min: 10,
      max: 60_000,
    }),
    sendTimeoutMs: readIntegerVariable(env, {
      name: 'OUTBOX_SEND_TIMEOUT_MS',
      fallback: 5_000,
      min: 100,
      max: 60_000,
    }),
    statsIntervalMs: readIntegerVariable(env, {
      name: 'OUTBOX_STATS_INTERVAL_MS',
      fallback: 10_000,
      min: 100,
      max: 3_600_000,
    }),
    stuckAfterAttempts: readIntegerVariable(env, {
      name: 'OUTBOX_STUCK_ATTEMPTS',
      fallback: 10,
      min: 1,
      max: 1_000,
    }),
    shutdownTimeoutMs: readIntegerVariable(env, {
      name: 'OUTBOX_SHUTDOWN_TIMEOUT_MS',
      fallback: 10_000,
      min: 0,
      max: 120_000,
    }),
  };
}

export function loadPendingWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): PendingWorkerConfig {
  return {
    enabled: readBoolean(env, 'PENDING_WORKER_ENABLED', true),
    batchSize: readIntegerVariable(env, {
      name: 'PENDING_WORKER_BATCH_SIZE',
      fallback: 20,
      min: 1,
      max: 100,
    }),
    pollIntervalMs: readIntegerVariable(env, {
      name: 'PENDING_WORKER_POLL_INTERVAL_MS',
      fallback: 1_000,
      min: 10,
      max: 60_000,
    }),
    // Menor que 1 s o lease acabaria antes de uma resolução normal terminar: trabalho duplicado.
    leaseMs: readIntegerVariable(env, {
      name: 'PENDING_WORKER_LEASE_MS',
      fallback: 30_000,
      min: 1_000,
      max: 3_600_000,
    }),
    shutdownTimeoutMs: readIntegerVariable(env, {
      name: 'PENDING_WORKER_SHUTDOWN_TIMEOUT_MS',
      fallback: 10_000,
      min: 0,
      max: 120_000,
    }),
  };
}
