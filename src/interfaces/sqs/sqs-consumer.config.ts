import {
  InvalidEnvironmentError,
  readIntegerVariable,
} from '../../config/env-integer.js';

export interface SqsConsumerConfig {
  // Liga o consumidor neste processo. Padrão: ligado (é o que o docker compose espera); os
  // testes o desligam em test/support/setup.ts e só o teste que precisa o liga.
  enabled: boolean;
  queueName: string;
  dlqName: string;
  // Entregas antes de a mensagem ir para a DLQ. Tem que ser <= o maxReceiveCount do redrive da
  // fila (scripts/init-queues.sh), que é só a rede de segurança.
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  // Quanto esperar as mensagens em andamento ao desligar (SIGTERM).
  shutdownTimeoutMs: number;
  // Long polling do ReceiveMessage (o máximo do SQS é 20).
  waitSeconds: number;
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
  // Nada de adivinhar "1", "yes", "TRUE": um valor estranho derruba a subida.
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

// Lê e valida na subida (como as outras variáveis): um valor inválido derruba a aplicação
// dizendo QUAL variável é, em vez de aparecer como comportamento estranho com tráfego real.
export function loadSqsConsumerConfig(
  env: NodeJS.ProcessEnv = process.env,
): SqsConsumerConfig {
  return {
    enabled: readBoolean(env, 'SQS_CONSUMER_ENABLED', true),
    queueName: readName(env, 'SQS_QUEUE_NAME', 'wager-transactions.fifo'),
    dlqName: readName(env, 'SQS_DLQ_NAME', 'wager-transactions-dlq.fifo'),
    maxReceiveCount: readIntegerVariable(env, {
      name: 'SQS_MAX_RECEIVE_COUNT',
      fallback: 10,
      min: 1,
      max: 1000,
    }),
    retryBaseSeconds: readIntegerVariable(env, {
      name: 'SQS_RETRY_BASE_SECONDS',
      fallback: 2,
      min: 0,
      max: 60,
    }),
    retryMaxSeconds: readIntegerVariable(env, {
      name: 'SQS_RETRY_MAX_SECONDS',
      fallback: 60,
      min: 0,
      max: 900,
    }),
    shutdownTimeoutMs: readIntegerVariable(env, {
      name: 'SQS_SHUTDOWN_TIMEOUT_MS',
      fallback: 20_000,
      min: 0,
      max: 120_000,
    }),
    waitSeconds: readIntegerVariable(env, {
      name: 'SQS_WAIT_SECONDS',
      fallback: 20,
      min: 0,
      max: 20,
    }),
  };
}
