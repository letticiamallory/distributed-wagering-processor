import { afterAll, describe, expect, test } from 'bun:test';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';

// Serviços reais (docker compose up -d postgres sqs queues-init). Sem mocks.
describe('infrastructure smoke', () => {
  const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
  let orm: MikroORM | undefined;

  afterAll(async () => {
    await orm?.close();
    sqs.destroy();
  });

  test('connects to the test database, not the development one', async () => {
    orm = await MikroORM.init(config);
    const rows = await orm.em
      .getConnection()
      .execute<{ db: string }[]>('select current_database() as db');
    expect(rows[0]?.db).toBe('wallet_test');
  });

  test('MiniStack has the three FIFO queues', async () => {
    const { QueueUrls = [] } = await sqs.send(new ListQueuesCommand({}));
    // As filas `test-*` são as que os testes do consumidor criam (e apagam) para si.
    const names = QueueUrls.map((url) => url.split('/').pop() ?? url)
      .filter((name) => !name.startsWith('test-'))
      .sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([
      'wager-transactions-dlq.fifo',
      'wager-transactions.fifo',
      'wallet-events.fifo',
    ]);
  });

  // Os nomes do enunciado (seção 10) e o redrive que o consumidor assume (ADR-0011).
  test('the main queue redrives to the DLQ after 10 receives, with a 30 s visibility', async () => {
    const url = (name: string) =>
      sqs
        .send(new GetQueueUrlCommand({ QueueName: name }))
        .then((r) => String(r.QueueUrl));
    const attributes = (queueUrl: string, names: string[]) =>
      sqs
        .send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: names as never,
          }),
        )
        .then((r) => r.Attributes ?? {});

    const main = await attributes(await url('wager-transactions.fifo'), [
      'RedrivePolicy',
      'VisibilityTimeout',
      'FifoQueue',
    ]);
    const dlq = await attributes(await url('wager-transactions-dlq.fifo'), [
      'QueueArn',
      'FifoQueue',
    ]);
    const redrive = JSON.parse(String(main.RedrivePolicy)) as {
      deadLetterTargetArn: string;
      maxReceiveCount: number | string;
    };
    expect(Number(redrive.maxReceiveCount)).toBe(10);
    expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn as string);
    expect(main.VisibilityTimeout).toBe('30');
    expect(main.FifoQueue).toBe('true');
    expect(dlq.FifoQueue).toBe('true');
  });
});
