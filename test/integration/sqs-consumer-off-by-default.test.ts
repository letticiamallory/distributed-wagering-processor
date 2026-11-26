import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { startApp } from '../support/http-app.js';
import { startInstances } from '../support/instances.js';
import { uuid } from '../support/persistence.js';
import { removeFromQueue, sqsClient } from '../support/queues.js';

// O requisito: no ambiente de teste o consumidor nasce DESLIGADO. Aqui a prova é de comportamento:
// uma mensagem-sonda vai para a wager-transactions.fifo REAL, a aplicação sobe (a do e2e, e os 3
// processos da Fase 4) e a sonda tem que continuar lá, intocada. Um consumidor a teria recebido
// (e, sendo lixo, mandado para a DLQ).
//
// Atenção: se um app de verdade (ex.: o container "app" do compose, já com o consumidor) estiver
// ligado, ELE consome a sonda e este teste falha, com razão. Para rodar a suíte, pare o app do compose.
const client = sqsClient();
const REAL = 'wager-transactions.fifo';
const REAL_DLQ = 'wager-transactions-dlq.fifo';
afterAll(() => client.destroy());

async function urlOf(name: string): Promise<string> {
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: name }),
  );
  return String(QueueUrl);
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
  const url = await urlOf(REAL);
  const dlq = await urlOf(REAL_DLQ);
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
  test('the e2e application (AppModule, default settings) does not consume from the real queue', async () => {
    await withProbe(async () => {
      const app = await startApp();
      try {
        await Bun.sleep(500);
      } finally {
        await app.close();
      }
    });
  }, 60_000);

  test('the three real processes of the concurrency suite do not consume from the real queue either', async () => {
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
