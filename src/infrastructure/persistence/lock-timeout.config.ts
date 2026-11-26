import { readIntegerVariable } from '../../config/env-integer.js';

// Quanto esperar pelo lock de uma wallet antes de desistir com 55P03 (ADR-0007: 5 s). O mínimo é
// 1 ms porque `lock_timeout = 0` no Postgres quer dizer "esperar para sempre".
export function loadLockTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readIntegerVariable(env, {
    name: 'DB_LOCK_TIMEOUT_MS',
    fallback: 5_000,
    min: 1,
    max: 600_000,
  });
}
