import { describe, expect, test } from 'bun:test';
import {
  ApplicationError,
  DependencyUnavailableError,
  DuplicateKeyError,
  WalletNotFoundError,
} from '../../../src/application/errors/application-errors.js';
import { InvalidMoneyError } from '../../../src/domain/money/money.errors.js';
import { classifyPersistenceError } from '../../../src/infrastructure/persistence/postgres-error-classifier.js';

// Formatos medidos no spike contra o Postgres real (25/11/2026): o pg lança DatabaseError
// com `code` (SQLSTATE) e `constraint`; a conexão recusada vem como AggregateError com
// code ECONNREFUSED e mensagem vazia; o pool cheio vem como Error SEM código.
const pgError = (code: string, message = 'x', extra: object = {}) =>
  Object.assign(new Error(message), { code }, extra);

describe('classifyPersistenceError: transient errors become DependencyUnavailableError', () => {
  test.each([
    ['55P03', 'canceling statement due to lock timeout'],
    ['40P01', 'deadlock detected'],
    ['40001', 'could not serialize access due to concurrent update'],
    ['57P01', 'terminating connection due to administrator command'],
    ['57P02', 'terminating connection due to crash of another server process'],
    ['57P03', 'the database system is starting up'],
    ['53300', 'sorry, too many clients already'],
    ['08000', 'connection_exception'],
    ['08003', 'connection does not exist'],
    ['08006', 'connection failure'],
  ])('SQLSTATE %s', (code, message) => {
    const classified = classifyPersistenceError(pgError(code, message));
    expect(classified).toBeInstanceOf(DependencyUnavailableError);
    expect((classified as DependencyUnavailableError).retryable).toBe(true);
  });

  test.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
  ])('network error %s', (code) => {
    expect(classifyPersistenceError(pgError(code))).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });

  test('a refused connection arrives as an AggregateError with an EMPTY message', () => {
    const inner = pgError('ECONNREFUSED');
    const aggregate = Object.assign(new AggregateError([inner], ''), {
      code: 'ECONNREFUSED',
    });
    expect(classifyPersistenceError(aggregate)).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });

  test('an AggregateError without its own code is read through its inner errors', () => {
    const aggregate = new AggregateError(
      [new Error('boom'), pgError('ECONNREFUSED')],
      '',
    );
    expect(classifyPersistenceError(aggregate)).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });

  test.each([
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'Client has encountered a connection error and is not queryable',
    'Cannot use a pool after calling end on the pool',
    'server closed the connection unexpectedly',
  ])(
    'a pool or connection error with no code, recognized by its message: %s',
    (message) => {
      expect(classifyPersistenceError(new Error(message))).toBeInstanceOf(
        DependencyUnavailableError,
      );
    },
  );

  test('the original error is kept as the cause, for the log', () => {
    const original = pgError(
      '55P03',
      'canceling statement due to lock timeout',
    );
    const classified = classifyPersistenceError(
      original,
    ) as DependencyUnavailableError;
    expect(classified.cause).toBe(original);
    expect(classified.message).toContain('55P03');
  });

  test('the code is found on a wrapped cause too', () => {
    const wrapped = new Error('query failed', {
      cause: pgError('40P01', 'deadlock detected'),
    });
    expect(classifyPersistenceError(wrapped)).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });

  test('a cause chain that loops does not hang', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(classifyPersistenceError(a)).toBe(a);
  });
});

describe('classifyPersistenceError: unique violations become DuplicateKeyError', () => {
  test('keeps the constraint name', () => {
    const classified = classifyPersistenceError(
      pgError(
        '23505',
        'duplicate key value violates unique constraint "uq_wtx_idempotency_key"',
        {
          constraint: 'uq_wtx_idempotency_key',
        },
      ),
    );
    expect(classified).toBeInstanceOf(DuplicateKeyError);
    expect((classified as DuplicateKeyError).constraint).toBe(
      'uq_wtx_idempotency_key',
    );
  });

  test('without a constraint name it says so, instead of guessing', () => {
    const classified = classifyPersistenceError(
      pgError('23505'),
    ) as DuplicateKeyError;
    expect(classified.constraint).toBe('unknown');
  });

  test('the original error is kept as the cause', () => {
    const original = pgError('23505', 'dup', { constraint: 'uq_x' });
    expect(
      (classifyPersistenceError(original) as DuplicateKeyError).cause,
    ).toBe(original);
  });
});

describe('classifyPersistenceError: everything else is left alone (permanent, 500)', () => {
  test.each([
    [
      '23514',
      'new row violates check constraint "ck_wallets_balance_non_negative"',
    ],
    ['23503', 'insert or update violates foreign key constraint'],
    ['23502', 'null value in column violates not-null constraint'],
    ['42P01', 'relation does not exist'],
    ['42601', 'syntax error'],
    ['P0001', 'wager_transactions is terminal'],
  ])(
    'SQLSTATE %s is returned unchanged: the database did its job and the code has a bug',
    (code, message) => {
      const original = pgError(code, message);
      expect(classifyPersistenceError(original)).toBe(original);
    },
  );

  test('an unknown error is returned unchanged', () => {
    const original = new TypeError('x is not a function');
    expect(classifyPersistenceError(original)).toBe(original);
  });

  test.each([undefined, null, 'a string', 42, {}])(
    'a non-error value %p is returned unchanged',
    (value) => {
      expect(classifyPersistenceError(value)).toBe(value);
    },
  );
});

describe('classifyPersistenceError: errors that already mean something are never reclassified', () => {
  test('an ApplicationError passes through, even if it has a transient-looking cause', () => {
    const error = new WalletNotFoundError('wallet-1');
    expect(classifyPersistenceError(error)).toBe(error);
    const already = new DependencyUnavailableError('x', pgError('23505'));
    expect(classifyPersistenceError(already)).toBe(already);
    expect(already).toBeInstanceOf(ApplicationError);
  });

  test('a domain error passes through', () => {
    const error = new InvalidMoneyError('bad');
    expect(classifyPersistenceError(error)).toBe(error);
  });
});
