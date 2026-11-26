import { Logger } from '@nestjs/common';
import type {
  Disposition,
  WagerMessageHandler,
} from '../../application/messaging/wager-message-handler.js';
import {
  NOOP_METRICS,
  type MetricsPort,
} from '../../application/ports/metrics.port.js';
import type { QueueGateway, QueueMessage } from './queue-gateway.js';

export interface ConsumerOptions {
  waitSeconds: number;
  batchSize: number;
  // Quanto o stop() espera as mensagens em andamento.
  shutdownTimeoutMs: number;
}

export interface StopReport {
  // Todas as mensagens em andamento terminaram dentro do prazo.
  drained: boolean;
  // Mensagens recebidas que NÃO tinham começado e voltaram à fila com visibilidade 0.
  released: number;
  // Mensagens que ainda estavam em andamento quando o prazo acabou (não foram apagadas).
  abandoned: number;
}

const RECEIVE_ERROR_PAUSE_MS = 1_000;

// O laço do consumidor (ADR-0011):
//   1. ReceiveMessage (long polling) de até 10 mensagens;
//   2. agrupa por MessageGroupId: grupos em PARALELO, e dentro do grupo em SEQUÊNCIA;
//   3. o handler decide (ACK, RETRY ou DEAD_LETTER) e só DEPOIS desta decisão, que já inclui o
//      commit do banco, o consumidor age na fila: delete, devolução da visibilidade ou DLQ.
//
// A ordem por wallet (grupo = walletId) é uma OTIMIZAÇÃO: evita disputa pelo lock e mantém a
// ordem em condições normais. A garantia de correção é do banco (lock, versão, UNIQUE).
export class WagerSqsConsumer {
  private readonly logger = new Logger(WagerSqsConsumer.name);
  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  private active = 0;
  private released = 0;

  constructor(
    private readonly gateway: QueueGateway,
    private readonly handler: WagerMessageHandler,
    private readonly options: ConsumerOptions,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  // O que o SIGTERM dispara: para de buscar, espera as mensagens em andamento (até o prazo) e
  // devolve à fila as que tinham sido recebidas e não começaram.
  async stop(): Promise<StopReport> {
    const loop = this.loop;
    if (!loop || !this.running) {
      return { drained: true, released: 0, abandoned: 0 };
    }
    this.running = false;
    this.released = 0;
    this.abort.abort(); // interrompe o long polling parado, se houver

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      loop.then(() => 'drained' as const),
      new Promise<'late'>((resolve) => {
        timer = setTimeout(
          () => resolve('late'),
          this.options.shutdownTimeoutMs,
        );
      }),
    ]);
    clearTimeout(timer);
    this.loop = undefined;
    return {
      drained: outcome === 'drained',
      released: this.released,
      abandoned: outcome === 'drained' ? 0 : this.active,
    };
  }

  private async run(): Promise<void> {
    while (this.running) {
      let batch: QueueMessage[];
      try {
        batch = await this.gateway.receive({
          max: this.options.batchSize,
          waitSeconds: this.options.waitSeconds,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (!this.running) {
          return; // o stop() abortou o long polling
        }
        this.logger.warn({
          event: 'queue_receive_failed',
          message: error instanceof Error ? error.message : String(error),
        });
        await sleep(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }
      await this.processBatch(batch);
    }
  }

  private async processBatch(batch: QueueMessage[]): Promise<void> {
    const groups = new Map<string, QueueMessage[]>();
    for (const message of batch) {
      const group = groups.get(message.groupId) ?? [];
      group.push(message);
      groups.set(message.groupId, group);
    }
    await Promise.all(
      [...groups.values()].map((messages) => this.processGroup(messages)),
    );
  }

  // Dentro de um grupo a ordem é a da fila. Se uma mensagem NÃO foi concluída (retry, falha no
  // ack ou na DLQ), as seguintes do grupo não podem passar na frente: voltam à fila sem ser
  // processadas. No FIFO, aliás, o SQS já segura o grupo enquanto a primeira está invisível.
  private async processGroup(messages: QueueMessage[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      if (!this.running) {
        await this.release(messages.slice(index));
        return;
      }
      this.active++;
      let done: boolean;
      try {
        done = await this.processOne(message);
      } finally {
        this.active--;
      }
      if (!done) {
        await this.release(messages.slice(index + 1));
        return;
      }
    }
  }

  // Devolve à fila, sem processar, mensagens que já tinham sido recebidas.
  private async release(messages: QueueMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.gateway.changeVisibility(message, 0);
        this.released++;
      } catch (error) {
        this.logger.warn({
          event: 'message_release_failed',
          sqsMessageId: message.sqsMessageId,
          message: describe(error),
        });
      }
    }
  }

  // true: a mensagem foi concluída (apagada); false: o grupo deve parar aqui.
  private async processOne(message: QueueMessage): Promise<boolean> {
    let disposition: Disposition;
    try {
      disposition = await this.handler.handle(message.body, {
        receiveCount: message.receiveCount,
      });
    } catch (error) {
      // O handler não deveria lançar. Se lançou, nada foi decidido: deixa a mensagem como está
      // (a visibilidade vence e ela volta), e o limite do redrive a protege.
      this.logger.error(
        {
          event: 'message_handler_crashed',
          sqsMessageId: message.sqsMessageId,
          message: describe(error),
        },
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }

    switch (disposition.action) {
      case 'ACK': {
        this.logAck(message, disposition);
        const acked = await this.acknowledge(message);
        if (acked) {
          this.metrics.increment('consumer_messages_total', {
            outcome: 'acked',
          });
        }
        return acked;
      }

      case 'RETRY':
        this.metrics.increment('consumer_messages_total', {
          outcome: 'retried',
        });
        this.metrics.increment('wager_retries_total', {
          component: 'consumer',
        });
        this.logger.warn({
          event: 'message_retry',
          sqsMessageId: message.sqsMessageId,
          receiveCount: message.receiveCount,
          delaySeconds: disposition.delaySeconds,
          ...identity(disposition, message),
          error: describe(disposition.error),
        });
        try {
          await this.gateway.changeVisibility(
            message,
            disposition.delaySeconds,
          );
        } catch (error) {
          this.logger.warn({
            event: 'message_retry_not_scheduled',
            sqsMessageId: message.sqsMessageId,
            message: describe(error),
          });
        }
        return false;

      case 'DEAD_LETTER': {
        const entry = {
          event: 'message_dead_lettered',
          sqsMessageId: message.sqsMessageId,
          receiveCount: message.receiveCount,
          reason: disposition.reason,
          ...(disposition.failureCode && {
            failureCode: disposition.failureCode,
          }),
          ...identity(disposition, message),
          error: describe(disposition.error),
        };
        const stack =
          disposition.error instanceof Error
            ? disposition.error.stack
            : undefined;
        // `fatal` (o nível mais alto) só para o que NUNCA deveria acontecer.
        if (disposition.critical) {
          this.logger.fatal(entry, stack);
        } else {
          this.logger.error(entry, stack);
        }
        try {
          await this.gateway.sendToDeadLetter(message, {
            reason: disposition.reason,
            ...(disposition.failureCode && {
              failureCode: disposition.failureCode,
            }),
          });
        } catch (error) {
          // Sem a DLQ confirmada a mensagem NÃO é apagada: ela volta e tenta de novo.
          this.logger.error({
            event: 'dead_letter_send_failed',
            sqsMessageId: message.sqsMessageId,
            message: describe(error),
          });
          return false;
        }
        // O envio para a DLQ foi confirmado: agora conta (e só então apaga a original).
        this.metrics.increment('wager_dlq_messages_total', {
          reason: disposition.reason,
        });
        this.metrics.increment('consumer_messages_total', {
          outcome: 'dead_lettered',
        });
        return this.acknowledge(message);
      }
    }
  }

  // O DeleteMessage: só chega aqui depois de o handler terminar, isto é, depois do commit.
  private async acknowledge(message: QueueMessage): Promise<boolean> {
    try {
      await this.gateway.delete(message);
      return true;
    } catch (error) {
      // O trabalho está no banco. A mensagem volta e vira replay (inbox + idempotência).
      this.logger.warn({
        event: 'message_ack_failed',
        sqsMessageId: message.sqsMessageId,
        message: describe(error),
      });
      return false;
    }
  }

  private logAck(
    message: QueueMessage,
    disposition: Extract<Disposition, { action: 'ACK' }>,
  ): void {
    const entry = {
      event: 'message_acked',
      sqsMessageId: message.sqsMessageId,
      outcome: disposition.outcome,
      replay: disposition.replay,
      ...identity(disposition, message),
      ...(disposition.transactionId && {
        transactionId: disposition.transactionId,
      }),
    };
    if (disposition.outcome === 'IDEMPOTENCY_CONFLICT') {
      // Apagada de propósito (o resultado é determinístico), mas nunca em silêncio.
      this.logger.warn({ ...entry, error: describe(disposition.error) });
    } else if (disposition.outcome === 'FAILED') {
      this.logger.error(entry);
    } else {
      this.logger.debug(entry);
    }
  }
}

function identity(
  disposition: {
    messageId?: string;
    idempotencyKey?: string;
    walletId?: string;
    providerId?: string;
  },
  message: QueueMessage,
): Record<string, string> {
  return {
    // O id de correlação de uma mensagem é o messageId dela (o caso de uso o usa assim também);
    // sem envelope válido, o id do próprio SQS.
    correlationId: disposition.messageId ?? message.sqsMessageId,
    ...(disposition.messageId && { messageId: disposition.messageId }),
    ...(disposition.idempotencyKey && {
      idempotencyKey: disposition.idempotencyKey,
    }),
    ...(disposition.walletId && { walletId: disposition.walletId }),
    ...(disposition.providerId && { providerId: disposition.providerId }),
  };
}

function describe(error: unknown): string {
  if (error === undefined) {
    return '';
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
