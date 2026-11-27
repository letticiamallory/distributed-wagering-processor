import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { SqsProbe } from '../../src/infrastructure/health/sqs-probe.js';
import { requiredQueueNames } from '../../src/interfaces/http/health/required-queues.js';
import { createTestQueues, type TestQueues } from '../support/queues.js';

// O MiniStack guarda as filas só em memória: reiniciado, ele responde a tudo, mas as filas sumiram.
// O probe antigo (ListQueues) seguia verde, e o balanceador mantinha no ar uma instância que não
// consumia nem publicava. Agora o probe confere, POR NOME, as filas de que este processo precisa.
let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues();
});
afterAll(async () => {
  await queues?.close();
});

describe('SqsProbe against a real MiniStack', () => {
  test('up when every required queue exists', async () => {
    const probe = new SqsProbe(queues.client, [
      queues.queueName,
      queues.dlqName,
    ]);
    expect(await probe.isUp()).toBe(true);
  });

  test('down when one required queue does not exist', async () => {
    const probe = new SqsProbe(queues.client, [
      queues.queueName,
      `missing-${Date.now()}.fifo`,
    ]);
    expect(await probe.isUp()).toBe(false);
  });

  test('down after a required queue is deleted (what a MiniStack restart does)', async () => {
    const victim = await createTestQueues();
    const probe = new SqsProbe(victim.client, [
      victim.queueName,
      victim.dlqName,
    ]);
    expect(await probe.isUp()).toBe(true);
    await victim.client.send(
      new DeleteQueueCommand({ QueueUrl: victim.queueUrl }),
    );
    expect(await probe.isUp()).toBe(false);
    await victim.close().catch(() => {});
  });

  test('with nothing required it still checks that the SQS answers', async () => {
    expect(await new SqsProbe(queues.client, []).isUp()).toBe(true);
  });
});

describe('requiredQueueNames: only the queues of the components this process runs', () => {
  test('consumer and publisher on (the compose app): the 3 queues', () => {
    expect(requiredQueueNames({}).sort()).toEqual(
      [
        'wager-transactions-dlq.fifo',
        'wager-transactions.fifo',
        'wallet-events.fifo',
      ].sort(),
    );
  });

  test('both off: none (the probe falls back to "the SQS answers")', () => {
    expect(
      requiredQueueNames({
        SQS_CONSUMER_ENABLED: 'false',
        OUTBOX_PUBLISHER_ENABLED: 'false',
      }),
    ).toEqual([]);
  });

  test('names come from the same variables the components read', () => {
    expect(
      requiredQueueNames({
        SQS_QUEUE_NAME: 'a.fifo',
        SQS_DLQ_NAME: 'b.fifo',
        OUTBOX_PUBLISHER_ENABLED: 'false',
      }),
    ).toEqual(['a.fifo', 'b.fifo']);
  });
});
