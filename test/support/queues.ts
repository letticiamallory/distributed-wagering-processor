import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { uuid } from './persistence.js';

// Um par de filas FIFO (principal + DLQ) CRIADO PELO TESTE, com nome único: o teste consome da
// própria fila e nunca da wager-transactions.fifo de verdade. O redrive é o mesmo do
// init-queues.sh, só que com a visibilidade curta para o teste não esperar 30 s.
export interface TestQueues {
  client: SQSClient;
  queueName: string;
  dlqName: string;
  queueUrl: string;
  dlqUrl: string;
  maxReceiveCount: number;
  send(
    body: unknown,
    options?: { groupId?: string; deduplicationId?: string },
  ): Promise<string>;
  // Mensagens que a fila principal ainda tem: visíveis, em andamento (invisíveis) e adiadas.
  depth(): Promise<{ visible: number; inFlight: number }>;
  waitUntilEmpty(timeoutMs?: number): Promise<void>;
  // O que há na DLQ (lê e devolve; não apaga, para o teste poder ler de novo).
  dead(): Promise<DeadMessage[]>;
  waitForDead(count: number, timeoutMs?: number): Promise<DeadMessage[]>;
  close(): Promise<void>;
}

export interface DeadMessage {
  body: string;
  groupId: string;
  attributes: Record<string, string>;
}

export interface TestQueuesOptions {
  visibilitySeconds?: number;
  maxReceiveCount?: number;
}

const RUN = Math.random().toString(36).slice(2, 8);
let sequence = 0;

export function sqsClient(): SQSClient {
  return new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
}

export async function createTestQueues(
  options: TestQueuesOptions = {},
): Promise<TestQueues> {
  const client = sqsClient();
  const maxReceiveCount = options.maxReceiveCount ?? 10;
  const id = `${RUN}-${++sequence}`;
  const dlqName = `test-${id}-wager-transactions-dlq.fifo`;
  const queueName = `test-${id}-wager-transactions.fifo`;

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '86400' },
    }),
  );
  const dlqUrl = String(dlq.QueueUrl);
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(options.visibilitySeconds ?? 2),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  const queueUrl = String(main.QueueUrl);

  const depth = async () => {
    const result = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    const a = result.Attributes ?? {};
    return {
      visible: Number(a.ApproximateNumberOfMessages ?? 0),
      inFlight:
        Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) +
        Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
    };
  };

  const dead = async (): Promise<DeadMessage[]> => {
    const found = new Map<string, DeadMessage>();
    // Lê com visibilidade curta e devolve tudo logo em seguida: o teste só olha.
    for (let round = 0; round < 3; round++) {
      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: round === 0 ? 1 : 0,
          VisibilityTimeout: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['MessageGroupId'],
        }),
      );
      for (const message of received.Messages ?? []) {
        found.set(String(message.MessageId), {
          body: String(message.Body),
          groupId: String(message.Attributes?.MessageGroupId),
          attributes: Object.fromEntries(
            Object.entries(message.MessageAttributes ?? {}).map(
              ([name, value]) => [name, String(value.StringValue)],
            ),
          ),
        });
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: dlqUrl,
            ReceiptHandle: String(message.ReceiptHandle),
            VisibilityTimeout: 0,
          }),
        );
      }
    }
    return [...found.values()];
  };

  return {
    client,
    queueName,
    dlqName,
    queueUrl,
    dlqUrl,
    maxReceiveCount,
    async send(body, sendOptions = {}) {
      const result = await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: sendOptions.groupId ?? 'test-group',
          MessageDeduplicationId: sendOptions.deduplicationId ?? uuid(),
        }),
      );
      return String(result.MessageId);
    },
    depth,
    async waitUntilEmpty(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      let last = { visible: -1, inFlight: -1 };
      while (Date.now() < deadline) {
        last = await depth();
        if (last.visible === 0 && last.inFlight === 0) {
          return;
        }
        await Bun.sleep(100);
      }
      throw new Error(
        `the queue still had messages after ${timeoutMs} ms: ${JSON.stringify(last)}`,
      );
    },
    dead,
    async waitForDead(count, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      let found: DeadMessage[] = [];
      while (Date.now() < deadline) {
        found = await dead();
        if (found.length >= count) {
          return found;
        }
        await Bun.sleep(150);
      }
      throw new Error(
        `expected ${count} message(s) in the DLQ, found ${found.length}`,
      );
    },
    async close() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
      client.destroy();
    },
  };
}

// Espera até a condição valer (sondagem curta), com mensagem de erro útil.
export async function waitFor(
  what: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}

// O envelope do enunciado (seção 10) para uma transação de uma wallet.
export function envelope(
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      idempotencyKey: `${String(data.providerId)}:${String(data.externalTransactionId)}`,
      ...data,
    },
    ...overrides,
  };
}

// Apaga uma mensagem da fila pelo corpo (limpeza do teste do consumidor desligado).
export async function removeFromQueue(
  client: SQSClient,
  queueUrl: string,
  bodyContains: string,
): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 5; round++) {
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 5,
      }),
    );
    for (const message of received.Messages ?? []) {
      if (String(message.Body).includes(bodyContains)) {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: String(message.ReceiptHandle),
          }),
        );
        removed++;
      } else {
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: String(message.ReceiptHandle),
            VisibilityTimeout: 0,
          }),
        );
      }
    }
  }
  return removed;
}
