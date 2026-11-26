import { describe, expect, test } from 'bun:test';
import {
  JsonLogger,
  loadLogLevel,
} from '../../../src/infrastructure/observability/json-logger.js';
import {
  addLogFields,
  runWithLogContext,
} from '../../../src/infrastructure/observability/log-context.js';

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger((line) => lines.push(line));
  const parsed = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe('structured logs: one JSON object per line', () => {
  test('an event object becomes the fields of the line, with time, level and context', () => {
    const { logger, lines, parsed } = capture();
    logger.log({ event: 'sqs_consumer_started' }, 'SqsConsumerModule');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(parsed()[0]).toMatchObject({
      level: 'info',
      context: 'SqsConsumerModule',
      event: 'sqs_consumer_started',
    });
    expect(String(parsed()[0]?.time)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test.each([
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['fatal', 'fatal'],
    ['debug', 'debug'],
    ['verbose', 'debug'],
  ] as const)('%s is logged at level %s', (method, level) => {
    const { logger, parsed } = capture();
    logger[method]({ event: 'x' }, 'Ctx');
    expect(parsed()[0]?.level).toBe(level);
  });

  test('a plain string message (what the framework logs) is kept under "message"', () => {
    const { logger, parsed } = capture();
    logger.log('Nest application successfully started', 'NestApplication');
    expect(parsed()[0]).toMatchObject({
      level: 'info',
      message: 'Nest application successfully started',
      context: 'NestApplication',
    });
  });

  test('error and fatal carry the stack under "stack"', () => {
    const { logger, parsed } = capture();
    logger.error({ event: 'boom' }, 'at boom (file.ts:1)', 'Ctx');
    expect(parsed()[0]).toMatchObject({
      stack: 'at boom (file.ts:1)',
      context: 'Ctx',
    });
  });

  test('an Error as the message is logged by name and message, with its stack', () => {
    const { logger, parsed } = capture();
    logger.error(new TypeError('bad thing'), undefined, 'Ctx');
    expect(parsed()[0]).toMatchObject({
      level: 'error',
      errorName: 'TypeError',
      message: 'bad thing',
    });
    expect(String(parsed()[0]?.stack)).toContain('bad thing');
  });
});

describe('correlation: the identifiers that are known travel with every line', () => {
  test('correlationId and the fields added so far are on every line logged inside the context', async () => {
    const { logger, parsed } = capture();
    await runWithLogContext(
      'corr-1',
      { providerId: 'provider-a' },
      async () => {
        logger.log({ event: 'first' }, 'Ctx');
        addLogFields({ walletId: 'w-1', transactionId: 'tx-1' });
        await Promise.resolve();
        logger.log({ event: 'second' }, 'Ctx');
      },
    );
    expect(parsed()[0]).toMatchObject({
      correlationId: 'corr-1',
      providerId: 'provider-a',
    });
    expect(parsed()[0]).not.toHaveProperty('walletId');
    expect(parsed()[1]).toMatchObject({
      correlationId: 'corr-1',
      providerId: 'provider-a',
      walletId: 'w-1',
      transactionId: 'tx-1',
    });
  });

  test('an explicit field of the entry wins over the context (a consumer line names its own messageId)', () => {
    const { logger, parsed } = capture();
    runWithLogContext('ctx-corr', { messageId: 'from-context' }, () => {
      logger.log(
        { event: 'x', messageId: 'explicit', correlationId: 'explicit-corr' },
        'Ctx',
      );
    });
    expect(parsed()[0]).toMatchObject({
      messageId: 'explicit',
      correlationId: 'explicit-corr',
    });
  });

  test('two contexts at the same time do not mix (each request keeps its own ids)', async () => {
    const { logger, parsed } = capture();
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithLogContext(`corr-${id}`, {}, async () => {
          await Bun.sleep(id === 'a' ? 10 : 1);
          addLogFields({ walletId: `wallet-${id}` });
          logger.log({ event: 'done' }, 'Ctx');
        }),
      ),
    );
    for (const line of parsed()) {
      expect(String(line.correlationId).slice(-1)).toBe(
        String(line.walletId).slice(-1),
      );
    }
  });
});

describe('what a log line must never carry', () => {
  test.each([
    'money',
    'amount',
    'balance',
    'balanceAfter',
    'balanceBefore',
    'payload',
    'body',
    'data',
    'authorization',
    'token',
    'password',
    'secret',
    'cookie',
    'apiKey',
    'initialBalance',
  ])('a field named "%s" is replaced by a marker, at any depth', (key) => {
    const { logger, lines, parsed } = capture();
    logger.log(
      {
        event: 'x',
        [key]: '123.45-SECRET',
        nested: { deep: { [key]: '123.45-SECRET' } },
      },
      'Ctx',
    );
    expect(lines[0]).not.toContain('123.45-SECRET');
    expect(parsed()[0]?.[key]).toBe('[redacted]');
    const nested = parsed()[0]?.nested as {
      deep: Record<string, unknown>;
    };
    expect(nested.deep[key]).toBe('[redacted]');
  });

  test('the field names are matched ignoring case and punctuation (Authorization, API_KEY)', () => {
    const { logger, lines } = capture();
    logger.log(
      {
        event: 'x',
        Authorization: 'Bearer abc',
        API_KEY: 'k-1',
        'x-api-key': 'k-2',
      },
      'Ctx',
    );
    expect(lines[0]).not.toContain('Bearer abc');
    expect(lines[0]).not.toContain('k-1');
    expect(lines[0]).not.toContain('k-2');
  });

  test('the identifiers we DO want survive (ids are not secrets)', () => {
    const { logger, parsed } = capture();
    logger.log(
      {
        event: 'x',
        walletId: 'w',
        providerId: 'p',
        transactionId: 't',
        messageId: 'm',
      },
      'Ctx',
    );
    expect(parsed()[0]).toMatchObject({
      walletId: 'w',
      providerId: 'p',
      transactionId: 't',
      messageId: 'm',
    });
  });

  test('a long string is cut (a whole payload pasted into a message cannot go out)', () => {
    const { logger, parsed } = capture();
    logger.log({ event: 'x', detail: 'a'.repeat(5_000) }, 'Ctx');
    const detail = String(parsed()[0]?.detail);
    expect(detail.length).toBeLessThan(700);
    expect(detail).toContain('truncated');
  });

  test('a circular object does not crash the logger', () => {
    const { logger, parsed } = capture();
    const loop: Record<string, unknown> = { event: 'x' };
    loop.self = loop;
    logger.log(loop, 'Ctx');
    expect(parsed()[0]?.event).toBe('x');
  });

  test('a value that cannot be serialised (a BigInt) does not crash the logger either', () => {
    const { logger, lines } = capture();
    logger.log({ event: 'x', big: 10n }, 'Ctx');
    expect(JSON.parse(lines[0] as string).event).toBe('x');
  });
});

describe('LOG_LEVEL', () => {
  test('defaults to info, and accepts only the five levels', () => {
    expect(loadLogLevel({})).toBe('info');
    expect(loadLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(loadLogLevel({ LOG_LEVEL: '  ' })).toBe('info');
    expect(() => loadLogLevel({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
    expect(() => loadLogLevel({ LOG_LEVEL: 'INFO' })).toThrow('LOG_LEVEL');
  });

  test('a line below the minimum level is not written at all', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line), 'warn');
    logger.debug({ event: 'a' }, 'Ctx');
    logger.log({ event: 'b' }, 'Ctx');
    logger.warn({ event: 'c' }, 'Ctx');
    logger.error({ event: 'd' }, 'Ctx');
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(['c', 'd']);
  });
});
