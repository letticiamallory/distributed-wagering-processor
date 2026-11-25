import { afterAll, describe, expect, test } from 'bun:test';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
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
    const names = QueueUrls.map((url) => url.split('/').pop() ?? url).sort(
      (a, b) => a.localeCompare(b),
    );
    expect(names).toEqual([
      'wager-transactions-dlq.fifo',
      'wager-transactions.fifo',
      'wallet-events.fifo',
    ]);
  });
});
