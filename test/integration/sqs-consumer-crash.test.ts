import { describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { AwsQueueGateway } from '../../src/interfaces/sqs/aws-queue-gateway.js';
import { ConsumerRetryPolicy } from '../../src/application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../src/application/messaging/wager-message-handler.js';
import { WagerSqsConsumer } from '../../src/interfaces/sqs/wager-sqs.consumer.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence } from '../support/persistence.js';
import { createTestQueues, envelope } from '../support/queues.js';
import { sharedLogs } from '../support/http-app.js';
import { createScenario } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db);

// O pior momento possível: o Postgres confirmou o commit e o processo morre ANTES do DeleteMessage.
// O SQS reentrega; a reentrega tem que virar replay, sem debitar de novo.
describe('the process DIES between the commit and the ack', () => {
  test('the committed work stays, the message is redelivered, and the redelivery is a replay (one debit)', async () => {
    Logger.overrideLogger(sharedLogs);
    const queues = await createTestQueues({ visibilitySeconds: 2 });
    try {
      const wallet = await s.walletWith('100.00');
      const body = s.body(wallet);
      const message = envelope(body);
      await queues.send(message, { groupId: wallet.id });

      const child = Bun.spawn(
        [process.execPath, 'test/support/consumer-crash-process.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PORT: '0',
            SQS_CONSUMER_ENABLED: 'true',
            SQS_QUEUE_NAME: queues.queueName,
            SQS_DLQ_NAME: queues.dlqName,
            SQS_WAIT_SECONDS: '1',
            SQS_RETRY_BASE_SECONDS: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const output = new Response(child.stdout as ReadableStream).text();
      const errors = new Response(child.stderr as ReadableStream).text();
      const code = await child.exited;

      // Morreu mesmo (kill -9), não saiu limpo. No POSIX o sinal é visível; no Windows só o código.
      expect(code, await errors).not.toBe(0);
      if (process.platform !== 'win32') {
        expect(child.signalCode).toBe('SIGKILL');
      }
      expect(await output).toContain('ABOUT_TO_ACK');

      // O commit aconteceu e ficou: a transação, o débito e a inbox existem.
      const key = s.keyOf(body);
      const rows = await s.sql(
        'SELECT status FROM wager_transactions WHERE idempotency_key = ?',
        [key],
      );
      expect(rows).toHaveLength(1);
      expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
      // ...e a mensagem NÃO foi apagada: continua na fila.
      const depth = await queues.depth();
      expect(depth.visible + depth.inFlight).toBe(1);

      // Outro consumidor (um processo novo, na prática) assume quando a visibilidade vence.
      const gateway = new AwsQueueGateway(queues.client, {
        queueUrl: queues.queueUrl,
        dlqUrl: queues.dlqUrl,
      });
      const handler = new WagerMessageHandler(
        s.build(),
        new ConsumerRetryPolicy({
          maxReceiveCount: 5,
          baseSeconds: 0,
          maxSeconds: 60,
        }),
      );
      const consumer = new WagerSqsConsumer(gateway, handler, {
        waitSeconds: 1,
        batchSize: 10,
        shutdownTimeoutMs: 3_000,
      });
      consumer.start();
      try {
        await queues.waitUntilEmpty(30_000);
      } finally {
        await consumer.stop();
      }

      expect(await s.directions(wallet.id)).toEqual(['DEBIT']); // um débito só
      expect(await s.balanceOf(wallet)).toBe('75.00');
      expect(await queues.dead()).toHaveLength(0);
      await assertInvariants(s.sql, wallet.id);
    } finally {
      await queues.close();
    }
  }, 90_000);
});
