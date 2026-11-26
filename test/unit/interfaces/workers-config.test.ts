import { describe, expect, test } from 'bun:test';
import { InvalidEnvironmentError } from '../../../src/config/env-integer.js';
import {
  loadOutboxPublisherConfig,
  loadPendingWorkerConfig,
} from '../../../src/interfaces/workers/workers.config.js';

describe('loadOutboxPublisherConfig', () => {
  test('defaults: ON, the real events queue, batches of 10 every 500 ms, a 5 s send timeout, "stuck" at 10 attempts', () => {
    expect(loadOutboxPublisherConfig({})).toEqual({
      enabled: true,
      queueName: 'wallet-events.fifo',
      batchSize: 10,
      pollIntervalMs: 500,
      sendTimeoutMs: 5_000,
      statsIntervalMs: 10_000,
      stuckAfterAttempts: 10,
      shutdownTimeoutMs: 10_000,
    });
  });

  test('reads every setting from the environment', () => {
    expect(
      loadOutboxPublisherConfig({
        OUTBOX_PUBLISHER_ENABLED: 'false',
        OUTBOX_QUEUE_NAME: 'x.fifo',
        OUTBOX_BATCH_SIZE: '5',
        OUTBOX_POLL_INTERVAL_MS: '100',
        OUTBOX_SEND_TIMEOUT_MS: '2000',
        OUTBOX_STATS_INTERVAL_MS: '1000',
        OUTBOX_STUCK_ATTEMPTS: '3',
        OUTBOX_SHUTDOWN_TIMEOUT_MS: '500',
      }),
    ).toEqual({
      enabled: false,
      queueName: 'x.fifo',
      batchSize: 5,
      pollIntervalMs: 100,
      sendTimeoutMs: 2_000,
      statsIntervalMs: 1_000,
      stuckAfterAttempts: 3,
      shutdownTimeoutMs: 500,
    });
  });

  test.each([
    ['OUTBOX_BATCH_SIZE', '11'], // o SendMessageBatch aceita no máximo 10
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_POLL_INTERVAL_MS', '0'],
    ['OUTBOX_POLL_INTERVAL_MS', 'fast'],
    ['OUTBOX_SEND_TIMEOUT_MS', '0'],
    ['OUTBOX_STUCK_ATTEMPTS', '-1'],
  ])('%s=%s stops the startup and names the variable', (name, value) => {
    expect(() => loadOutboxPublisherConfig({ [name]: value })).toThrow(name);
  });

  test.each(['TRUE', 'yes', '1'])(
    'OUTBOX_PUBLISHER_ENABLED="%s" is refused: only true and false',
    (value) => {
      expect(() =>
        loadOutboxPublisherConfig({ OUTBOX_PUBLISHER_ENABLED: value }),
      ).toThrow(InvalidEnvironmentError);
    },
  );

  test('the TEST ENVIRONMENT is born with the publisher OFF and on a test-only events queue', () => {
    const config = loadOutboxPublisherConfig(process.env);
    expect(config.enabled).toBe(false);
    expect(config.queueName).toStartWith('test-');
    expect(config.queueName).not.toBe('wallet-events.fifo');
  });
});

describe('loadPendingWorkerConfig', () => {
  test('defaults: ON, batches of 20 every second, a 30 s lease', () => {
    expect(loadPendingWorkerConfig({})).toEqual({
      enabled: true,
      batchSize: 20,
      pollIntervalMs: 1_000,
      leaseMs: 30_000,
      shutdownTimeoutMs: 10_000,
    });
  });

  test('reads every setting from the environment', () => {
    expect(
      loadPendingWorkerConfig({
        PENDING_WORKER_ENABLED: 'false',
        PENDING_WORKER_BATCH_SIZE: '5',
        PENDING_WORKER_POLL_INTERVAL_MS: '200',
        PENDING_WORKER_LEASE_MS: '5000',
        PENDING_WORKER_SHUTDOWN_TIMEOUT_MS: '700',
      }),
    ).toEqual({
      enabled: false,
      batchSize: 5,
      pollIntervalMs: 200,
      leaseMs: 5_000,
      shutdownTimeoutMs: 700,
    });
  });

  test.each([
    ['PENDING_WORKER_BATCH_SIZE', '0'],
    ['PENDING_WORKER_POLL_INTERVAL_MS', '0'],
    ['PENDING_WORKER_LEASE_MS', '999'], // um lease menor que o tempo de uma resolução vira trabalho duplicado
    ['PENDING_WORKER_LEASE_MS', 'long'],
  ])('%s=%s stops the startup and names the variable', (name, value) => {
    expect(() => loadPendingWorkerConfig({ [name]: value })).toThrow(name);
  });

  test('the TEST ENVIRONMENT is born with the worker OFF', () => {
    expect(loadPendingWorkerConfig(process.env).enabled).toBe(false);
  });
});
