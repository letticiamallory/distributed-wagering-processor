import type { EntityManager } from '@mikro-orm/postgresql';
import {
  NOOP_METRICS,
  type MetricsPort,
} from '../../../application/ports/metrics.port.js';
import { InboxReader } from '../../../application/ports/inbox-repository.js';
import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../entities.js';
import { classifyAndCount } from '../classify-and-count.js';

// Leitura da inbox SEM transação (o caminho rápido do consumidor). Cada chamada usa um
// EntityManager novo: nenhum cache entre leituras.
export class MikroOrmInboxReader extends InboxReader {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    try {
      const row = await this.em
        .fork()
        .findOne(InboxMessageEntity, { consumerName, messageId });
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
    } catch (error) {
      throw classifyAndCount(error, this.metrics);
    }
  }
}
