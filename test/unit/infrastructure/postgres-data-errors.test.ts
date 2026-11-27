import { describe, expect, test } from 'bun:test';
import {
  DependencyUnavailableError,
  PermanentDataError,
} from '../../../src/application/errors/application-errors.js';
import { classifyPersistenceError } from '../../../src/infrastructure/persistence/postgres-error-classifier.js';

const pgError = (code: string, message = 'x') =>
  Object.assign(new Error(message), { code });

// Erro de DADO: reenviar o mesmo dado dá o mesmo erro. Nunca pode virar "banco indisponível" (503,
// reenviável), senão o provedor reenvia para sempre e a fila segura a wallet com retries.
describe('classifyPersistenceError: data errors are permanent, never transient', () => {
  test.each([
    ['22021', 'invalid byte sequence for encoding "UTF8": 0x00'],
    ['22003', 'numeric field overflow'],
    ['22P02', 'invalid input syntax for type json'],
    ['22001', 'value too long for type character varying(10)'],
    ['22007', 'invalid datetime format'],
    // 08P01 é da classe 08 (conexão), mas é o que o Postgres devolve quando a MENSAGEM tem um NUL.
    ['08P01', 'invalid message format'],
  ])('SQLSTATE %s', (code, message) => {
    const classified = classifyPersistenceError(pgError(code, message));
    expect(classified).not.toBeInstanceOf(DependencyUnavailableError);
    expect(classified).toBeInstanceOf(PermanentDataError);
    expect(classified).toMatchObject({ sqlState: code, retryable: false });
  });

  test('found through the cause chain too', () => {
    const wrapped = new Error('wrapper', { cause: pgError('22021') });
    expect(classifyPersistenceError(wrapped)).toBeInstanceOf(
      PermanentDataError,
    );
  });

  test('the rest of class 08 is still a connection problem (transient)', () => {
    expect(classifyPersistenceError(pgError('08006'))).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });
});
