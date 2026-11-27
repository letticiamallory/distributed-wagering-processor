import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Logger, type LoggerService } from '@nestjs/common';
import type {
  Disposition,
  WagerMessageHandler,
} from '../../../src/application/messaging/wager-message-handler.js';
import {
  QueueGateway,
  type QueueMessage,
} from '../../../src/interfaces/sqs/queue-gateway.js';
import { WagerSqsConsumer } from '../../../src/interfaces/sqs/wager-sqs.consumer.js';

// Com o LOG_LEVEL padrão (info), uma mensagem consumida com sucesso não deixava NENHUMA linha:
// o message_acked saía em debug. Rastrear uma mensagem pelo messageId exigia subir o nível de log.
// Agora o ack de sucesso sai em info, com messageId e transactionId (enunciado, seção 12).
interface Line {
  level: string;
  entry: Record<string, unknown>;
}
const lines: Line[] = [];
const capture =
  (level: string) =>
  (message: unknown): void => {
    if (typeof message === 'object' && message !== null) {
      lines.push({ level, entry: message as Record<string, unknown> });
    }
  };
const logger: LoggerService = {
  log: capture('info'),
  warn: capture('warn'),
  error: capture('error'),
  fatal: capture('fatal'),
  debug: capture('debug'),
  verbose: capture('debug'),
};

beforeAll(() => Logger.overrideLogger(logger));
afterAll(() => Logger.overrideLogger(new Logger()));

class OneBatch extends QueueGateway {
  private served = false;
  constructor(private readonly messages: QueueMessage[]) {
    super();
  }
  async receive(options: { signal: AbortSignal }): Promise<QueueMessage[]> {
    if (!this.served) {
      this.served = true;
      return this.messages;
    }
    // Depois do lote, fica parado até o stop() abortar o long polling.
    await new Promise((_, reject) =>
      options.signal.addEventListener('abort', () =>
        reject(new Error('aborted')),
      ),
    );
    return [];
  }
  async delete(): Promise<void> {}
  async changeVisibility(): Promise<void> {}
  async sendToDeadLetter(): Promise<void> {}
}

const message = (id: string): QueueMessage => ({
  sqsMessageId: `sqs-${id}`,
  receiptHandle: `rh-${id}`,
  body: '{}',
  groupId: 'wallet-1',
  receiveCount: 1,
});

async function consume(disposition: Disposition): Promise<Line[]> {
  lines.length = 0;
  const handler = {
    handle: () => Promise.resolve(disposition),
  } as unknown as WagerMessageHandler;
  const consumer = new WagerSqsConsumer(new OneBatch([message('1')]), handler, {
    waitSeconds: 1,
    batchSize: 10,
    shutdownTimeoutMs: 1_000,
  });
  consumer.start();
  await Bun.sleep(50);
  await consumer.stop();
  return lines.filter((l) => l.entry.event === 'message_acked');
}

const identity = {
  messageId: 'msg-1',
  idempotencyKey: 'provider-a:tx-1',
  walletId: 'wallet-1',
  providerId: 'provider-a',
};

describe('message_acked is logged at info, with messageId and transactionId', () => {
  test.each(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'] as const)(
    'outcome %s',
    async (outcome) => {
      const [acked] = await consume({
        action: 'ACK',
        outcome,
        replay: false,
        transactionId: 'tx-1',
        ...identity,
      });
      expect(acked?.level).toBe('info');
      expect(acked?.entry).toMatchObject({
        messageId: 'msg-1',
        transactionId: 'tx-1',
        correlationId: 'msg-1',
        outcome,
      });
    },
  );

  test('a replay is info too (and says so)', async () => {
    const [acked] = await consume({
      action: 'ACK',
      outcome: 'PROCESSED',
      replay: true,
      transactionId: 'tx-1',
      ...identity,
    });
    expect(acked?.level).toBe('info');
    expect(acked?.entry.replay).toBe(true);
  });

  test('an idempotency conflict stays at warn', async () => {
    const [acked] = await consume({
      action: 'ACK',
      outcome: 'IDEMPOTENCY_CONFLICT',
      replay: false,
      error: new Error('conflict'),
      ...identity,
    });
    expect(acked?.level).toBe('warn');
  });
});
