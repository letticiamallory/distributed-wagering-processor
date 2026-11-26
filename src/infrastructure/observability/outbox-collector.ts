import type { Clock } from '../../application/ports/clock.js';
import type { OutboxReader } from '../../application/ports/outbox-repository.js';
import type { PrometheusRegistry } from './prometheus-registry.js';

// O lag e a fila da outbox são valores "no momento da leitura": em vez de um laço que os
// atualiza de tempos em tempos (e fica velho entre uma e outra), o registro chama este coletor
// ANTES de cada raspagem do /metrics. Funciona em qualquer instância, mesmo com o publisher
// desligado, porque lê a mesma tabela que o publisher usa.
export function registerOutboxCollector(
  registry: PrometheusRegistry,
  reader: OutboxReader,
  clock: Clock,
): void {
  registry.addCollector(async () => {
    const stats = await reader.stats(clock.now());
    registry.set('outbox_pending_messages', {}, stats.pending);
    registry.set('outbox_lag_seconds', {}, stats.lagSeconds);
  });
}
