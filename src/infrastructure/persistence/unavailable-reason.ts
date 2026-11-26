export type UnavailableReason =
  | 'pool_timeout'
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization'
  | 'connection'
  | 'other';

const SQLSTATE: Record<string, UnavailableReason> = {
  '55P03': 'lock_timeout', // lock_timeout estourou: a wallet estava com outra operação
  '40P01': 'deadlock',
  '40001': 'serialization',
  '57P01': 'connection', // admin_shutdown / pg_terminate_backend
  '57P02': 'connection',
  '57P03': 'connection', // cannot_connect_now
  '53300': 'connection', // too_many_connections
};

const NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

// O pg lança estes SEM código: só a mensagem diz o que houve.
const POOL_MESSAGE = /timeout exceeded when trying to connect/i;
const CONNECTION_MESSAGE =
  /connection terminated|connection error|connection ended unexpectedly|server closed the connection|the database system is (?:starting up|shutting down)/i;

const MAX_DEPTH = 5;

// Por que o banco ficou indisponível (o que vira 503), lendo a causa por trás do
// DependencyUnavailableError: o código do driver, a mensagem do pool, ou o erro dentro de
// `cause` ou de um AggregateError. Nunca lança: o que não conhece é "other".
export function unavailableReason(error: unknown): UnavailableReason {
  const seen = new Set<unknown>();
  let found: UnavailableReason | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (
      found ||
      depth > MAX_DEPTH ||
      typeof value !== 'object' ||
      value === null
    ) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    const { code, message, cause, errors } = value as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === 'string') {
      if (code in SQLSTATE) {
        found = SQLSTATE[code];
        return;
      }
      if (NODE_CODES.has(code) || code.startsWith('08')) {
        found = 'connection';
        return;
      }
    }
    if (typeof message === 'string') {
      if (POOL_MESSAGE.test(message)) {
        found = 'pool_timeout';
        return;
      }
      if (CONNECTION_MESSAGE.test(message)) {
        found = 'connection';
        return;
      }
    }
    visit(cause, depth + 1);
    if (Array.isArray(errors)) {
      for (const inner of errors) visit(inner, depth + 1);
    }
  };
  visit(error, 0);
  return found ?? 'other';
}
