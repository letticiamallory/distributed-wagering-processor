import { readIntegerVariable } from '../../config/env-integer.js';
import { DEFAULT_RETRY_AFTER_SECONDS } from './http-status.js';

export const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

// Configuração da camada HTTP. É uma classe (e não um objeto solto) para o Nest poder injetá-la.
export class HttpConfig {
  constructor(
    // Segundos que o provedor espera antes de reenviar a MESMA chave depois de um 503.
    readonly retryAfterSeconds: number,
    // Encerramento (C7): por quanto tempo o HTTP continua atendendo depois do SIGTERM, com o
    // /health/ready já em 503, para o balanceador parar de mandar tráfego antes de a porta fechar.
    readonly shutdownDrainMs: number = DEFAULT_SHUTDOWN_DRAIN_MS,
    // Quanto esperar as requisições em andamento depois de parar de aceitar novas.
    readonly shutdownTimeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ) {}
}

export function loadHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig {
  return new HttpConfig(
    readIntegerVariable(env, {
      name: 'RETRY_AFTER_SECONDS',
      fallback: DEFAULT_RETRY_AFTER_SECONDS,
      min: 1,
      max: 3_600,
    }),
    readIntegerVariable(env, {
      name: 'HTTP_SHUTDOWN_DRAIN_MS',
      fallback: DEFAULT_SHUTDOWN_DRAIN_MS,
      min: 0,
      max: 60_000,
    }),
    readIntegerVariable(env, {
      name: 'HTTP_SHUTDOWN_TIMEOUT_MS',
      fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      min: 0,
      max: 120_000,
    }),
  );
}
