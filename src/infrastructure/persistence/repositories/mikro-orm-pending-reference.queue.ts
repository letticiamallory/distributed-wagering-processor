import type { EntityManager } from '@mikro-orm/postgresql';
import {
  PendingReferenceQueue,
  type ReservedPending,
} from '../../../application/ports/pending-reference-queue.js';
import { classifyPersistenceError } from '../postgres-error-classifier.js';

// Reserva o trabalho do worker de PENDING_REFERENCE (ADR-0013), SEM o lock da wallet (ADR-0007: o
// que exige o lock é DECIDIR estado ou dinheiro; esta consulta só escreve a coluna de
// agendamento, next_attempt_at, e quem decide relê tudo sob o lock).
//
// Uma instrução só (autocommit): o SELECT interno trava as linhas com SKIP LOCKED, então dois
// workers nunca recebem a mesma, e uma linha que o `wake` (que roda sob o lock da wallet) está
// atualizando é pulada em vez de esperada, o que também evita deadlock entre os dois.
export class MikroOrmPendingReferenceQueue extends PendingReferenceQueue {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async reserveDue(
    limit: number,
    leaseMs: number,
    now: Date,
  ): Promise<ReservedPending[]> {
    try {
      const rows = (await this.em.getConnection().execute(
        `UPDATE wager_transactions SET next_attempt_at = ?
          WHERE id IN (
            SELECT id FROM wager_transactions
             WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
             ORDER BY next_attempt_at
             LIMIT ?
               FOR UPDATE SKIP LOCKED)
          RETURNING id, wallet_id`,
        [new Date(now.getTime() + leaseMs), now, limit],
      )) as Array<{ id: string; wallet_id: string }>;
      return rows.map((row) => ({
        transactionId: row.id,
        walletId: row.wallet_id,
      }));
    } catch (error) {
      throw classifyPersistenceError(error);
    }
  }
}
