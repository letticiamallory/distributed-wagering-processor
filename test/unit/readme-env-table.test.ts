import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { loadHttpConfig } from '../../src/interfaces/http/http-config.js';
import { loadSqsConsumerConfig } from '../../src/interfaces/sqs/sqs-consumer.config.js';
import {
  loadOutboxPublisherConfig,
  loadPendingWorkerConfig,
} from '../../src/interfaces/workers/workers.config.js';
import { loadPendingReferenceSchedule } from '../../src/infrastructure/config/pending-reference-schedule.config.js';
import { loadLockTimeoutMs } from '../../src/infrastructure/persistence/lock-timeout.config.js';
import {
  loadLogLevel,
  type LogLevel,
} from '../../src/infrastructure/observability/json-logger.js';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';

// A tabela de variáveis do README não pode mentir: cada padrão e cada faixa dela é conferida
// contra o carregador de verdade, e toda variável que o código lê tem que estar na tabela.
const README = readFileSync('README.md', 'utf8');

interface Row {
  name: string;
  defaultValue: string | undefined;
  range: string;
}

const rows: Row[] = [];
for (const line of README.split('\n')) {
  const cells = line.split('|').map((cell) => cell.trim());
  const name = /^`([A-Z][A-Z0-9_]+)`$/.exec(cells[1] ?? '')?.[1];
  if (!name || cells.length < 6) continue;
  const defaultValue = /^`(.+)`$/.exec(cells[2] ?? '')?.[1];
  rows.push({ name, defaultValue, range: cells[3] ?? '' });
}
const byName = new Map(rows.map((row) => [row.name, row]));

// O valor que o código usa quando a variável não está definida.
const poolDefault = (key: 'min' | 'max') =>
  String((config.pool as { min: number; max: number })[key]);
const FROM_CODE: Record<string, (env: NodeJS.ProcessEnv) => string> = {
  PORT: () => '3000', // src/main.ts: `process.env.PORT ?? 3000` (conferido abaixo no texto)
  DB_POOL_MIN: () => poolDefault('min'),
  DB_POOL_MAX: () => poolDefault('max'),
  DB_ACQUIRE_TIMEOUT_MS: () =>
    String(
      (config.driverOptions as { connectionTimeoutMillis: number })
        .connectionTimeoutMillis,
    ),
  DB_LOCK_TIMEOUT_MS: (env) => String(loadLockTimeoutMs(env)),
  RETRY_AFTER_SECONDS: (env) => String(loadHttpConfig(env).retryAfterSeconds),
  LOG_LEVEL: (env) => loadLogLevel(env),
  PENDING_REFERENCE_MAX_ATTEMPTS: (env) =>
    String(loadPendingReferenceSchedule(env).maxAttempts),
  PENDING_REFERENCE_BASE_DELAY_MS: (env) =>
    String(loadPendingReferenceSchedule(env).baseDelayMs),
  PENDING_REFERENCE_MAX_DELAY_MS: (env) =>
    String(loadPendingReferenceSchedule(env).maxDelayMs),
  SQS_CONSUMER_ENABLED: (env) => String(loadSqsConsumerConfig(env).enabled),
  SQS_QUEUE_NAME: (env) => loadSqsConsumerConfig(env).queueName,
  SQS_DLQ_NAME: (env) => loadSqsConsumerConfig(env).dlqName,
  SQS_MAX_RECEIVE_COUNT: (env) =>
    String(loadSqsConsumerConfig(env).maxReceiveCount),
  SQS_RETRY_BASE_SECONDS: (env) =>
    String(loadSqsConsumerConfig(env).retryBaseSeconds),
  SQS_RETRY_MAX_SECONDS: (env) =>
    String(loadSqsConsumerConfig(env).retryMaxSeconds),
  SQS_SHUTDOWN_TIMEOUT_MS: (env) =>
    String(loadSqsConsumerConfig(env).shutdownTimeoutMs),
  SQS_WAIT_SECONDS: (env) => String(loadSqsConsumerConfig(env).waitSeconds),
  OUTBOX_PUBLISHER_ENABLED: (env) =>
    String(loadOutboxPublisherConfig(env).enabled),
  OUTBOX_QUEUE_NAME: (env) => loadOutboxPublisherConfig(env).queueName,
  OUTBOX_BATCH_SIZE: (env) => String(loadOutboxPublisherConfig(env).batchSize),
  OUTBOX_POLL_INTERVAL_MS: (env) =>
    String(loadOutboxPublisherConfig(env).pollIntervalMs),
  OUTBOX_SEND_TIMEOUT_MS: (env) =>
    String(loadOutboxPublisherConfig(env).sendTimeoutMs),
  OUTBOX_STATS_INTERVAL_MS: (env) =>
    String(loadOutboxPublisherConfig(env).statsIntervalMs),
  OUTBOX_STUCK_ATTEMPTS: (env) =>
    String(loadOutboxPublisherConfig(env).stuckAfterAttempts),
  OUTBOX_SHUTDOWN_TIMEOUT_MS: (env) =>
    String(loadOutboxPublisherConfig(env).shutdownTimeoutMs),
  PENDING_WORKER_ENABLED: (env) => String(loadPendingWorkerConfig(env).enabled),
  PENDING_WORKER_BATCH_SIZE: (env) =>
    String(loadPendingWorkerConfig(env).batchSize),
  PENDING_WORKER_POLL_INTERVAL_MS: (env) =>
    String(loadPendingWorkerConfig(env).pollIntervalMs),
  PENDING_WORKER_LEASE_MS: (env) =>
    String(loadPendingWorkerConfig(env).leaseMs),
  PENDING_WORKER_SHUTDOWN_TIMEOUT_MS: (env) =>
    String(loadPendingWorkerConfig(env).shutdownTimeoutMs),
};

describe('README environment table', () => {
  test('the table has a row for every variable the configuration loaders know', () => {
    expect(rows.length).toBeGreaterThan(30);
    for (const name of Object.keys(FROM_CODE)) {
      expect(byName.has(name), `${name} is missing from the README table`).toBe(
        true,
      );
    }
  });

  test('every variable the code reads is documented in the table', () => {
    const files = [
      'src/interfaces/workers/workers.config.ts',
      'src/interfaces/sqs/sqs-consumer.config.ts',
      'src/interfaces/http/http-config.ts',
      'src/infrastructure/persistence/lock-timeout.config.ts',
      'src/infrastructure/persistence/mikro-orm.config.ts',
      'src/infrastructure/config/pending-reference-schedule.config.ts',
      'src/infrastructure/observability/json-logger.ts',
    ];
    const read = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /'((?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+)'/g,
      )) {
        read.add(match[1] as string);
      }
      for (const match of source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) {
        read.add(match[1] as string);
      }
    }
    // O código também lê estas três (a documentação delas está na linha do SQS_ENDPOINT).
    read.add('PORT');
    expect(read.size).toBeGreaterThan(25);
    for (const name of read) {
      if (['DATABASE_URL'].includes(name)) continue;
      expect(byName.has(name), `${name} is read by the code`).toBe(true);
    }
    expect(readFileSync('src/main.ts', 'utf8')).toContain(
      'process.env.PORT ?? 3000',
    );
  });

  for (const [name, fromCode] of Object.entries(FROM_CODE)) {
    test(`${name}: the documented default is the one the code uses`, () => {
      const row = byName.get(name) as Row;
      expect(
        row.defaultValue,
        `${name} has no default in the table`,
      ).toBeDefined();
      expect(row.defaultValue).toBe(fromCode({}));
    });
  }

  // As faixas "a a b" e "inteiro ≥ n" são testadas nas bordas, de verdade.
  describe('documented ranges are the real ones (inclusive edges accepted, outside rejected)', () => {
    for (const row of rows) {
      const loader = FROM_CODE[row.name];
      const between = /^(\d+) a (\d+)$/.exec(row.range);
      const atLeast = /^inteiro ≥ (\d+)$/.exec(row.range);
      if (!loader || (!between && !atLeast)) continue;
      // DB_POOL_* e DB_ACQUIRE_TIMEOUT_MS são lidos na importação, não por um carregador.
      if (
        row.name.startsWith('DB_POOL') ||
        row.name === 'DB_ACQUIRE_TIMEOUT_MS'
      )
        continue;
      const min = Number((between ?? atLeast)?.[between ? 1 : 1]);
      const max = between ? Number(between[2]) : undefined;
      test(`${row.name} accepts ${min}${max !== undefined ? ` and ${max}` : ''}`, () => {
        expect(() => loader({ [row.name]: String(min) })).not.toThrow();
        if (max !== undefined) {
          expect(() => loader({ [row.name]: String(max) })).not.toThrow();
          expect(() => loader({ [row.name]: String(max + 1) })).toThrow(
            new RegExp(row.name),
          );
        }
        if (min > 0) {
          expect(() => loader({ [row.name]: String(min - 1) })).toThrow(
            new RegExp(row.name),
          );
        }
      });
    }
  });

  test('boolean variables accept only true or false', () => {
    for (const name of [
      'SQS_CONSUMER_ENABLED',
      'OUTBOX_PUBLISHER_ENABLED',
      'PENDING_WORKER_ENABLED',
    ]) {
      const loader = FROM_CODE[name] as (env: NodeJS.ProcessEnv) => string;
      expect(loader({ [name]: 'true' })).toBe('true');
      expect(loader({ [name]: 'false' })).toBe('false');
      expect(() => loader({ [name]: 'yes' })).toThrow(new RegExp(name));
    }
  });

  test('LOG_LEVEL lists exactly the levels the logger accepts', () => {
    const range = (byName.get('LOG_LEVEL') as Row).range;
    const documented = [...range.matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(documented).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
    for (const level of documented) {
      expect(loadLogLevel({ LOG_LEVEL: level })).toBe(level as LogLevel);
    }
    expect(() => loadLogLevel({ LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
  });
});
