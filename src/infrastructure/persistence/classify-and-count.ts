import { DependencyUnavailableError } from '../../application/errors/application-errors.js';
import type { MetricsPort } from '../../application/ports/metrics.port.js';
import { classifyPersistenceError } from './postgres-error-classifier.js';
import { unavailableReason } from './unavailable-reason.js';

// Traduz o erro do driver (como sempre) e, se virou "banco indisponível" (o que o HTTP mostra como
// 503), conta a CAUSA: pool cheio, lock_timeout, deadlock, conexão... Todos os caminhos que falam
// com o banco passam por aqui, então a contagem é a mesma para o HTTP, o SQS e os workers.
export function classifyAndCount(
  error: unknown,
  metrics: MetricsPort,
): unknown {
  const classified = classifyPersistenceError(error);
  if (classified instanceof DependencyUnavailableError) {
    metrics.increment('wager_db_unavailable_total', {
      reason: unavailableReason(classified),
    });
  }
  return classified;
}
