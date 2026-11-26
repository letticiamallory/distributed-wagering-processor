import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export type PublishOutcome = { ok: true } | { ok: false; error: string };

// Publica eventos da outbox no broker. Nunca lança por causa de uma falha do broker: devolve, por
// eventId, se foi aceito ou o motivo.
export abstract class IntegrationEventPublisher {
  abstract publish(
    messages: readonly OutboxMessage[],
  ): Promise<Map<string, PublishOutcome>>;
}
