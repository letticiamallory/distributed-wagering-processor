import type { InboxMessage } from '../../domain/messaging/inbox-message.js';

export abstract class InboxRepository {
  // INSERT ... ON CONFLICT DO NOTHING. true: a mensagem é nova; false: já existia (reentrega).
  abstract tryReceive(message: InboxMessage): Promise<boolean>;

  abstract find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;

  abstract markProcessed(message: InboxMessage): Promise<void>;
}
