import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/outbox-repository.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { OutboxMessageEntity } from '../entities.js';

// Só grava: quem publica no SQS é o publisher da Fase 6, e o fluxo de negócio nunca fala
// com a fila (CLAUDE.md).
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageEntity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      lastError: message.lastError ?? null,
    });
  }
}
