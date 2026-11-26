import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { sqsClient } from './queues.js';

// A fila de EVENTOS (a wallet-events.fifo de teste) e o "consumidor" dela: um coletor que lê tudo,
// apaga e DEDUPLICA POR eventId, exatamente como o contrato do ADR-0012 pede de quem consome
// eventos da outbox (at-least-once: o mesmo eventId pode chegar mais de uma vez).
export interface SinkEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  groupId: string;
  deduplicationId: string;
  envelope: Record<string, unknown>;
}

export interface EventQueue {
  client: SQSClient;
  queueName: string;
  queueUrl: string;
  // Tudo o que chegou, na ordem, inclusive repetidos.
  received(): SinkEvent[];
  // Os eventIds distintos (a visão do consumidor que deduplica).
  uniqueIds(): Set<string>;
  // Lê da fila até haver `unique` eventIds distintos (ou o tempo acabar) e devolve o que chegou.
  collect(unique: number, timeoutMs?: number): Promise<SinkEvent[]>;
  // Lê por `ms` sem esperar nada em particular (para provar que NADA chegou).
  listen(ms: number): Promise<SinkEvent[]>;
  close(): Promise<void>;
}

const RUN = Math.random().toString(36).slice(2, 8);
let sequence = 0;

export async function createEventQueue(): Promise<EventQueue> {
  const client = sqsClient();
  const queueName = `test-${RUN}-${++sequence}-wallet-events.fifo`;
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '30' },
    }),
  );
  const queueUrl = String(created.QueueUrl);
  const all: SinkEvent[] = [];

  async function poll(waitSeconds: number): Promise<number> {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: [
          'MessageGroupId',
          'MessageDeduplicationId',
        ],
      }),
    );
    for (const message of Messages) {
      const envelope = JSON.parse(String(message.Body)) as Record<
        string,
        unknown
      >;
      all.push({
        eventId: String(envelope.eventId),
        eventType: String(envelope.eventType),
        aggregateId: String(envelope.aggregateId),
        groupId: String(message.Attributes?.MessageGroupId),
        deduplicationId: String(message.Attributes?.MessageDeduplicationId),
        envelope,
      });
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: String(message.ReceiptHandle),
        }),
      );
    }
    return Messages.length;
  }

  const unique = () => new Set(all.map((event) => event.eventId));

  return {
    client,
    queueName,
    queueUrl,
    received: () => [...all],
    uniqueIds: unique,
    async collect(count, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (unique().size < count && Date.now() < deadline) {
        await poll(1);
      }
      return [...all];
    },
    async listen(ms) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await poll(1);
      }
      return [...all];
    },
    async close() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      client.destroy();
    },
  };
}
