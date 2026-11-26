import { describe, expect, test } from 'bun:test';
import { InvalidEnvironmentError } from '../../../src/config/env-integer.js';
import { loadSqsConsumerConfig } from '../../../src/interfaces/sqs/sqs-consumer.config.js';

describe('loadSqsConsumerConfig', () => {
  test('defaults: ON, the real queue names, 10 deliveries, backoff 2 s up to 60 s', () => {
    expect(loadSqsConsumerConfig({})).toEqual({
      enabled: true,
      queueName: 'wager-transactions.fifo',
      dlqName: 'wager-transactions-dlq.fifo',
      maxReceiveCount: 10,
      retryBaseSeconds: 2,
      retryMaxSeconds: 60,
      shutdownTimeoutMs: 20_000,
      waitSeconds: 20,
    });
  });

  test('reads every setting from the environment', () => {
    expect(
      loadSqsConsumerConfig({
        SQS_CONSUMER_ENABLED: 'false',
        SQS_QUEUE_NAME: 'a.fifo',
        SQS_DLQ_NAME: 'b.fifo',
        SQS_MAX_RECEIVE_COUNT: '4',
        SQS_RETRY_BASE_SECONDS: '0',
        SQS_RETRY_MAX_SECONDS: '5',
        SQS_SHUTDOWN_TIMEOUT_MS: '300',
        SQS_WAIT_SECONDS: '1',
      }),
    ).toEqual({
      enabled: false,
      queueName: 'a.fifo',
      dlqName: 'b.fifo',
      maxReceiveCount: 4,
      retryBaseSeconds: 0,
      retryMaxSeconds: 5,
      shutdownTimeoutMs: 300,
      waitSeconds: 1,
    });
  });

  test.each(['TRUE', 'yes', '1', 'on', 'enabled'])(
    'SQS_CONSUMER_ENABLED="%s" is refused: only the words true and false (no guessing)',
    (value) => {
      expect(() =>
        loadSqsConsumerConfig({ SQS_CONSUMER_ENABLED: value }),
      ).toThrow(InvalidEnvironmentError);
    },
  );

  test.each([
    ['SQS_MAX_RECEIVE_COUNT', '0'],
    ['SQS_MAX_RECEIVE_COUNT', '1.5'],
    ['SQS_RETRY_BASE_SECONDS', '-1'],
    ['SQS_RETRY_MAX_SECONDS', '99999'],
    ['SQS_SHUTDOWN_TIMEOUT_MS', 'soon'],
    ['SQS_WAIT_SECONDS', '21'],
  ])('%s=%s stops the startup and names the variable', (name, value) => {
    expect(() => loadSqsConsumerConfig({ [name]: value })).toThrow(name);
  });

  test('a blank queue name counts as NOT SET (the .env convention of the other variables): the default, never "no queue"', () => {
    expect(loadSqsConsumerConfig({ SQS_QUEUE_NAME: '   ' }).queueName).toBe(
      'wager-transactions.fifo',
    );
    expect(loadSqsConsumerConfig({ SQS_DLQ_NAME: '' }).dlqName).toBe(
      'wager-transactions-dlq.fifo',
    );
  });

  test('the TEST ENVIRONMENT points at test-only queues, never at the real ones (the suite must pass with the whole stack up)', () => {
    const config = loadSqsConsumerConfig(process.env);
    expect(config.queueName).toStartWith('test-');
    expect(config.dlqName).toStartWith('test-');
    expect(config.queueName).not.toBe('wager-transactions.fifo');
    expect(config.dlqName).not.toBe('wager-transactions-dlq.fifo');
  });

  test('the TEST ENVIRONMENT is born with the consumer OFF (test/support/setup.ts)', () => {
    expect(loadSqsConsumerConfig(process.env).enabled).toBe(false);
  });
});
