import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface OutboxStats {
  // Eventos ainda não publicados.
  pending: number;
  // Destes, quantos já podem ser publicados agora (next_attempt_at <= agora).
  due: number;
  // Há quanto tempo o evento mais antigo não publicado espera (o "lag" da outbox), em segundos.
  lagSeconds: number;
}

// Leitura SEM transação: a observabilidade da outbox.
export abstract class OutboxReader {
  abstract stats(now: Date): Promise<OutboxStats>;
}

// Os eventos entram na outbox na mesma transação do negócio (add). Quem publica no SQS é o
// publisher; o fluxo de negócio nunca fala com a fila.
export abstract class OutboxRepository extends OutboxReader {
  abstract add(message: OutboxMessage): Promise<void>;

  // Reivindica até `limit` eventos devidos (não publicados, next_attempt_at <= now), do mais
  // antigo ao mais novo, com FOR UPDATE SKIP LOCKED: dois publishers nunca recebem a mesma linha.
  // As linhas ficam travadas até o fim da transação.
  abstract claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;

  // Grava o que o publisher mudou (publicado, ou tentativas e próxima tentativa).
  abstract save(message: OutboxMessage): Promise<void>;
}
