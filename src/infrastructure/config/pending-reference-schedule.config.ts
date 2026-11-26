import { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';

export class InvalidPendingReferenceConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

const MAX_ATTEMPTS = 'PENDING_REFERENCE_MAX_ATTEMPTS';
const BASE_DELAY_MS = 'PENDING_REFERENCE_BASE_DELAY_MS';
const MAX_DELAY_MS = 'PENDING_REFERENCE_MAX_DELAY_MS';

// Só dígitos: recusa "1.5", "-3", "1e3", "0x10" e "10 attempts", que o Number() aceitaria ou
// arredondaria em silêncio.
const PLAIN_INTEGER = /^[0-9]+$/;

function read(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') {
    return undefined; // linha em branco no .env = não definida
  }
  const value = Number(raw);
  if (!PLAIN_INTEGER.test(raw) || !Number.isSafeInteger(value)) {
    throw new InvalidPendingReferenceConfigError(
      `${name} must be a plain integer (got "${raw}")`,
    );
  }
  return value;
}

// Monta a política de espera pelas variáveis de ambiente, com os padrões do ADR-0013. Um valor
// inválido derruba a subida da aplicação, dizendo qual variável é: melhor parar na partida do
// que descobrir uma política errada com transações reais esperando.
export function loadPendingReferenceSchedule(
  env: NodeJS.ProcessEnv = process.env,
): PendingReferenceSchedule {
  const maxAttempts = read(env, MAX_ATTEMPTS);
  const baseDelayMs = read(env, BASE_DELAY_MS);
  const maxDelayMs = read(env, MAX_DELAY_MS);

  try {
    return new PendingReferenceSchedule({
      ...(maxAttempts !== undefined && { maxAttempts }),
      ...(baseDelayMs !== undefined && { baseDelayMs }),
      ...(maxDelayMs !== undefined && { maxDelayMs }),
    });
  } catch (cause) {
    throw new InvalidPendingReferenceConfigError(
      explain({ maxAttempts, baseDelayMs, maxDelayMs }),
      { cause },
    );
  }
}

// Diz QUAL variável está errada (a política só sabe o nome do campo, não o da variável).
function explain(values: {
  maxAttempts: number | undefined;
  baseDelayMs: number | undefined;
  maxDelayMs: number | undefined;
}): string {
  if (values.maxAttempts !== undefined && values.maxAttempts < 1) {
    return `${MAX_ATTEMPTS} must be greater than zero`;
  }
  if (values.baseDelayMs !== undefined && values.baseDelayMs < 1) {
    return `${BASE_DELAY_MS} must be greater than zero`;
  }
  if (values.maxDelayMs !== undefined && values.maxDelayMs < 1) {
    return `${MAX_DELAY_MS} must be greater than zero`;
  }
  return `${MAX_DELAY_MS} cannot be smaller than ${BASE_DELAY_MS}`;
}
