import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  IntegrationEventPublisher,
  type PublishOutcome,
} from '../../application/ports/integration-event-publisher.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

// Publica os eventos da outbox na wallet-events.fifo com SendMessageBatch (até 10 por chamada):
//   MessageGroupId           = aggregateId (a wallet: os eventos de uma wallet formam um grupo)
//   MessageDeduplicationId   = eventId (o SQS descarta o mesmo evento por 5 minutos; fora dessa
//                              janela o consumidor deduplica pelo eventId: at-least-once)
//   MessageBody              = o payload da outbox, intacto
// Nunca lança por causa do broker: devolve o motivo por evento. O cliente tem um prazo (a
// transação do publisher fica aberta enquanto espera).
export class SqsEventPublisher extends IntegrationEventPublisher {
  constructor(
    readonly client: SQSClient,
    readonly queueUrl: string,
    readonly options: { timeoutMs: number },
  ) {
    super();
  }

  async publish(
    messages: readonly OutboxMessage[],
  ): Promise<Map<string, PublishOutcome>> {
    const outcomes = new Map<string, PublishOutcome>();
    if (messages.length === 0) {
      return outcomes;
    }
    const byEntryId = new Map(
      messages.map((message, index) => [String(index), message] as const),
    );
    try {
      const response = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.options.timeoutMs) },
      );
      for (const sent of response.Successful ?? []) {
        const message = byEntryId.get(String(sent.Id));
        if (message) outcomes.set(message.id, { ok: true });
      }
      for (const failure of response.Failed ?? []) {
        const message = byEntryId.get(String(failure.Id));
        if (message) {
          outcomes.set(message.id, {
            ok: false,
            error: `${failure.Code ?? 'SendFailed'}: ${failure.Message ?? 'the broker refused the message'}`,
          });
        }
      }
    } catch (error) {
      const text =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      for (const message of messages) {
        outcomes.set(message.id, { ok: false, error: text });
      }
    }
    // O que o broker não mencionou conta como falha (nunca como sucesso).
    for (const message of messages) {
      if (!outcomes.has(message.id)) {
        outcomes.set(message.id, {
          ok: false,
          error: 'the broker did not report a result for this message',
        });
      }
    }
    return outcomes;
  }
}
