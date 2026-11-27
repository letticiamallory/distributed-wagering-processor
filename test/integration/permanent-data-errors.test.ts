import { describe, expect, test } from 'bun:test';
import { PermanentDataError } from '../../src/application/errors/application-errors.js';
import { classifyAndCount } from '../../src/infrastructure/persistence/classify-and-count.js';
import { usePersistence } from '../support/persistence.js';

// Os erros de dado do PostgreSQL REAL (não um código inventado): o que o banco devolve para um NUL,
// um surrogate isolado num JSONB e um NUMERIC que estoura. Todos viram PermanentDataError, e nenhum
// é contado como "banco indisponível".
const db = usePersistence();

async function errorOf(sql: string, params: unknown[]): Promise<unknown> {
  try {
    await db().orm.em.getConnection().execute(sql, params);
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to fail');
}

describe('data errors raised by the real PostgreSQL are permanent', () => {
  test.each([
    ['a NUL in a text parameter', 'SELECT ?::text AS v', ['g\u0000']],
    ['a lone surrogate in JSONB', 'SELECT ?::jsonb AS v', ['{"g":"\\ud800"}']],
    ['a NUMERIC(20,2) overflow', 'SELECT ?::numeric(20,2) AS v', ['1e30']],
  ])('%s', async (_name, sql, params) => {
    const counted: string[] = [];
    const metrics = {
      increment: (name: string) => counted.push(name),
      observe: () => {},
      set: () => {},
    };
    const classified = classifyAndCount(
      await errorOf(sql, params),
      metrics as never,
    );
    expect(classified).toBeInstanceOf(PermanentDataError);
    expect(counted).not.toContain('wager_db_unavailable_total');
  });
});
