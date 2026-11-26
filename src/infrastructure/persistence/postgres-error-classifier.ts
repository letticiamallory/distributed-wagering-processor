import {
  ApplicationError,
  DependencyUnavailableError,
  DuplicateKeyError,
} from '../../application/errors/application-errors.js';
import { DomainError } from '../../domain/errors/domain-error.js';

// Códigos medidos no Postgres real (spike de 25/11/2026) e o que o provedor deve fazer:
//   transitório -> DependencyUnavailableError (503, reenviar a MESMA chave com backoff)
//   23505       -> DuplicateKeyError (o caso de uso decide pela constraint)
//   o resto     -> devolvido como veio: o banco fez o trabalho dele e o código tem um bug (500)
const TRANSIENT_SQLSTATE = new Set([
  '55P03', // lock_timeout estourou
  '40P01', // deadlock (não deveria acontecer: uma wallet por transação)
  '40001', // falha de serialização (não usamos SERIALIZABLE, mas é repetível)
  '57P01', // admin_shutdown / pg_terminate_backend
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (o banco está subindo)
  '53300', // too_many_connections
]);

// Classe 08 = connection_exception (08000, 08003, 08006...).
const CONNECTION_CLASS = '08';

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

// O pg lança estes SEM código: só a mensagem diz o que houve. O pool cheio é
// "timeout exceeded when trying to connect" (espera máxima por uma conexão livre).
const TRANSIENT_MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|connection error|connection ended unexpectedly|cannot use a pool after calling end|server closed the connection unexpectedly|the database system is (?:starting up|shutting down)/i;

const MAX_DEPTH = 5;

interface Candidate {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

// O erro que importa pode estar no próprio objeto, em `cause` ou dentro de um
// AggregateError (conexão recusada em IPv4 e IPv6 chega assim). Limita a profundidade e
// não repete objetos, para uma cadeia circular não travar.
function candidatesOf(error: unknown): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    found.push(value as Candidate);
    const { cause, errors } = value as { cause?: unknown; errors?: unknown };
    visit(cause, depth + 1);
    if (Array.isArray(errors)) {
      for (const inner of errors) {
        visit(inner, depth + 1);
      }
    }
  };
  visit(error, 0);
  return found;
}

function isTransient(candidate: Candidate): boolean {
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  if (code !== undefined) {
    if (
      TRANSIENT_SQLSTATE.has(code) ||
      code.startsWith(CONNECTION_CLASS) ||
      TRANSIENT_NODE_CODES.has(code)
    ) {
      return true;
    }
  }
  return (
    typeof candidate.message === 'string' &&
    TRANSIENT_MESSAGE.test(candidate.message)
  );
}

// Traduz o erro do driver para o vocabulário da aplicação. Erros que já são da aplicação
// ou do domínio passam intactos.
export function classifyPersistenceError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) {
    return error;
  }
  const candidates = candidatesOf(error);

  const unique = candidates.find((c) => c.code === '23505');
  if (unique) {
    const constraint =
      typeof unique.constraint === 'string' ? unique.constraint : 'unknown';
    return new DuplicateKeyError(constraint, error);
  }

  const transient = candidates.find(isTransient);
  if (transient) {
    const label =
      typeof transient.code === 'string'
        ? transient.code
        : String(transient.message).slice(0, 80);
    return new DependencyUnavailableError(
      `Database unavailable or busy (${label})`,
      error,
    );
  }
  return error;
}
