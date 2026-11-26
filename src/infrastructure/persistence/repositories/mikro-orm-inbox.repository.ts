import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../../../application/ports/inbox-repository.js';
import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../entities.js';

export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  // ON CONFLICT DO NOTHING: se a chave (consumidor, mensagem) já existe, nada é inserido.
  // Uma linha devolvida = mensagem nova; nenhuma = reentrega. Se outra transação está
  // inserindo a mesma chave, este INSERT espera o commit dela e então não insere.
  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = (await this.em.getConnection().execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (consumer_name, message_id) DO NOTHING
         RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
      ],
      'all',
      this.em.getTransactionContext(),
    )) as unknown[];
    return rows.length === 1;
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    if (!row) {
      return undefined;
    }
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      ...(row.processedAt != null && { processedAt: row.processedAt }),
    });
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageEntity,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
