import { readIntegerVariable } from '../../config/env-integer.js';
import { DEFAULT_RETRY_AFTER_SECONDS } from './http-status.js';

// Configuração da camada HTTP. É uma classe (e não um objeto solto) para o Nest poder injetá-la.
export class HttpConfig {
  constructor(
    // Segundos que o provedor espera antes de reenviar a MESMA chave depois de um 503.
    readonly retryAfterSeconds: number,
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
  );
}
