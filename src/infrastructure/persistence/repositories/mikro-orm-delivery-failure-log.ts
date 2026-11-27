import type { EntityManager } from '@mikro-orm/postgresql';
import { DeliveryFailureLog } from '../../../application/ports/delivery-failure-log.js';
import { classifyPersistenceError } from '../postgres-error-classifier.js';

// Uma instrução só (autocommit): soma 1 e devolve o total. Sem transação de negócio e sem lock de
// wallet: é só a contagem das falhas permanentes de uma mensagem (ADR-0016).
export class MikroOrmDeliveryFailureLog extends DeliveryFailureLog {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async recordPermanentFailure(
    consumerName: string,
    messageId: string,
  ): Promise<number> {
    try {
      const rows = (await this.em.getConnection().execute(
        `INSERT INTO consumer_delivery_failures (consumer_name, message_id, permanent_failures)
         VALUES (?, ?, 1)
         ON CONFLICT (consumer_name, message_id) DO UPDATE
           SET permanent_failures = consumer_delivery_failures.permanent_failures + 1,
               last_failed_at = now()
         RETURNING permanent_failures`,
        [consumerName, messageId],
      )) as Array<{ permanent_failures: number }>;
      return Number(rows[0]?.permanent_failures ?? 0);
    } catch (error) {
      throw classifyPersistenceError(error);
    }
  }
}
