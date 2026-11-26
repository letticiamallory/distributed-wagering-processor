import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { startApp } from '../support/http-app.js';
import { startInstances } from '../support/instances.js';
import { uuid } from '../support/persistence.js';
import { removeFromQueue, sqsClient } from '../support/queues.js';

// O requisito: no ambiente de teste o consumidor nasce DESLIGADO. A prova é de comportamento: uma
// mensagem-sonda vai para a fila que o app de teste tem CONFIGURADA (SQS_QUEUE_NAME, fixada em
// test/support/setup.ts numa fila SÓ DE TESTE), a aplicação sobe (a do e2e, e os 3 processos da
// Fase 4) e a sonda tem que continuar lá, intocada. Um consumidor ligado a teria recebido (e,
// sendo lixo, mandado para a DLQ).
//
// As filas reais (wager-transactions.fifo) NÃO são usadas aqui: com o `docker compose up -d` no ar
// o consumidor do app de verdade as consome, e a suíte tem que passar assim.
const client = sqsClient();
const CONFIGURED = String(process.env.SQS_QUEUE_NAME);
const CONFIGURED_DLQ = String(process.env.SQS_DLQ_NAME);
afterAll(() => client.destroy());

// Cria (ou reaproveita) o par de filas de teste do ambiente, com o mesmo redrive das reais.
async function ensureConfiguredQueues(): Promise<{ url: string; dlq: string }> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: CONFIGURED_DLQ,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: String(dlq.QueueUrl),
      AttributeNames: ['QueueArn'],
    }),
  );
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: CONFIGURED,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: '10',
        }),
      },
    }),
  );
  return { url: String(main.QueueUrl), dlq: String(dlq.QueueUrl) };
}

async function counts(url: string) {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible),
  };
}

async function withProbe(run: () => Promise<void>): Promise<void> {
  expect(CONFIGURED).not.toBe('wager-transactions.fifo');
  const { url, dlq } = await ensureConfiguredQueues();
  const marker = `probe-${uuid()}`;
  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify({ probe: marker }),
      MessageGroupId: marker,
      MessageDeduplicationId: marker,
    }),
  );
  const before = await counts(url);
  const dlqBefore = await counts(dlq);
  try {
    await run();
    await Bun.sleep(3_000); // tempo de sobra para um consumidor pegar a sonda
    expect(await counts(url)).toEqual(before); // nada recebido, nada em andamento
    expect(await counts(dlq)).toEqual(dlqBefore); // nada foi para a DLQ
  } finally {
    await removeFromQueue(client, url, marker);
  }
}

describe('in the test environment the consumer is born OFF', () => {
  test('the e2e application (AppModule, default settings) does not consume from its configured queue', async () => {
    await withProbe(async () => {
      const app = await startApp();
      try {
        await Bun.sleep(500);
      } finally {
        await app.close();
      }
    });
  }, 60_000);

  test('the three real processes of the concurrency suite do not consume from their configured queue either', async () => {
    await withProbe(async () => {
      const instances = await startInstances(3);
      try {
        await Bun.sleep(500);
      } finally {
        await instances.stop();
      }
    });
  }, 90_000);
});
