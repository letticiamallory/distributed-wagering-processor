import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

// Os eventos entram na outbox na mesma transação do negócio. Quem publica no SQS é o
// publisher da Fase 6; o fluxo de negócio nunca fala com a fila.
export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
}
