import type { InboxMessage } from '../../domain/messaging/inbox-message.js';

// Leitura SEM transação: o caminho rápido do consumidor SQS (sem lock).
export abstract class InboxReader {
  abstract find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
}

// Versão ligada à transação do UnitOfWork.
export abstract class InboxRepository extends InboxReader {
  // INSERT ... ON CONFLICT DO NOTHING. true: a mensagem é nova; false: já existia (reentrega).
  abstract tryReceive(message: InboxMessage): Promise<boolean>;

  abstract markProcessed(message: InboxMessage): Promise<void>;
}
