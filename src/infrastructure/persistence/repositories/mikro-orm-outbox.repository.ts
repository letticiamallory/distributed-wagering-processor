import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  OutboxRepository,
  type OutboxStats,
} from '../../../application/ports/outbox-repository.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { OutboxMessageEntity } from '../entities.js';

// A outbox no banco. Quem publica no SQS é o publisher (claimDue/save); o fluxo de negócio só
// grava (add) e nunca fala com a fila (CLAUDE.md).
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

  // FOR UPDATE SKIP LOCKED: o publisher que chega depois pula as linhas que outro já travou e
  // pega as seguintes, sem esperar (ADR-0012). Só vale dentro de uma transação.
  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageEntity,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return rows.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        ...(row.publishedAt != null && { publishedAt: row.publishedAt }),
        ...(row.lastError != null && { lastError: row.lastError }),
      }),
    );
  }

  // Só as colunas que o publisher muda. Nunca o evento em si (id, tipo, payload).
  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageEntity,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }

  async stats(now: Date): Promise<OutboxStats> {
    const rows = (await this.em.getConnection().execute(
      `SELECT count(*)::int AS pending,
              (count(*) FILTER (WHERE next_attempt_at <= ?))::int AS due,
              min(occurred_at) AS oldest
         FROM outbox_messages
        WHERE published_at IS NULL`,
      [now],
    )) as Array<{ pending: number; due: number; oldest: Date | null }>;
    const row = rows[0];
    const oldest = row?.oldest ? new Date(row.oldest).getTime() : undefined;
    return {
      pending: Number(row?.pending ?? 0),
      due: Number(row?.due ?? 0),
      lagSeconds:
        oldest === undefined
          ? 0
          : Math.max(0, Math.floor((now.getTime() - oldest) / 1_000)),
    };
  }
}
