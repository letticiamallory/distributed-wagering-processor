import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashMigrationFiles,
  needsSchemaReset,
  MIGRATIONS_DIR,
} from '../support/schema-state.js';
import { useSql } from '../support/database.js';

const sql = useSql();

describe('hashMigrationFiles', () => {
  const dirs: string[] = [];
  const makeDir = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-hash-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    'Migration20260101000000_a.ts': 'export class A {}',
    'Migration20260102000000_b.ts': 'export class B {}',
  };

  test('the same files give the same hash, whatever order they were written in', () => {
    const one = makeDir(base);
    const reversed = makeDir(
      Object.fromEntries(Object.entries(base).reverse()),
    );
    expect(hashMigrationFiles(one)).toBe(hashMigrationFiles(reversed));
  });

  test('is a SHA-256 in hex', () => {
    expect(hashMigrationFiles(makeDir(base))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changing one character of a migration changes the hash', () => {
    const changed = makeDir({
      ...base,
      'Migration20260102000000_b.ts': 'export class B { }',
    });
    expect(hashMigrationFiles(changed)).not.toBe(
      hashMigrationFiles(makeDir(base)),
    );
  });

  test('a new migration changes the hash', () => {
    const more = makeDir({
      ...base,
      'Migration20260103000000_c.ts': 'export class C {}',
    });
    expect(hashMigrationFiles(more)).not.toBe(
      hashMigrationFiles(makeDir(base)),
    );
  });

  test('renaming a migration changes the hash (the name is part of the history)', () => {
    const renamed = makeDir({
      'Migration20260101000000_a.ts': base['Migration20260101000000_a.ts'],
      'Migration20260102000000_renamed.ts':
        base['Migration20260102000000_b.ts'],
    });
    expect(hashMigrationFiles(renamed)).not.toBe(
      hashMigrationFiles(makeDir(base)),
    );
  });

  test('moving content between two files changes the hash (name and content are tied together)', () => {
    const swapped = makeDir({
      'Migration20260101000000_a.ts': base['Migration20260102000000_b.ts'],
      'Migration20260102000000_b.ts': base['Migration20260101000000_a.ts'],
    });
    expect(hashMigrationFiles(swapped)).not.toBe(
      hashMigrationFiles(makeDir(base)),
    );
  });

  test('files that are not migrations do not matter (snapshots, notes, editor files)', () => {
    const noisy = makeDir({
      ...base,
      '.snapshot-wallet.json': '{}',
      'README.md': 'x',
      'notes.ts': 'y',
    });
    expect(hashMigrationFiles(noisy)).toBe(hashMigrationFiles(makeDir(base)));
  });

  test('a directory with no migration is an error, not a hash of nothing', () => {
    const empty = makeDir({ 'README.md': 'x' });
    expect(() => hashMigrationFiles(empty)).toThrow(/no migration/i);
  });

  test('a missing directory is an error', () => {
    const dir = join(tmpdir(), 'does-not-exist-' + Date.now());
    expect(() => hashMigrationFiles(dir)).toThrow();
    mkdirSync(dir);
    rmSync(dir, { recursive: true });
  });

  test('the real migrations have a hash', () => {
    expect(hashMigrationFiles(MIGRATIONS_DIR)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('needsSchemaReset: the test database is only rebuilt when it must be', () => {
  const connection = () =>
    ({
      execute: (query: string, params?: unknown[]) => sql(query, params ?? []),
    }) as { execute: (query: string, params?: unknown[]) => Promise<unknown> };

  test('after the first setup the stored hash is the current one: no reset', async () => {
    expect(
      await needsSchemaReset(connection(), hashMigrationFiles(MIGRATIONS_DIR)),
    ).toBe(false);
  });

  test('a different migrations hash asks for a reset', async () => {
    expect(await needsSchemaReset(connection(), 'f'.repeat(64))).toBe(true);
  });

  test('the state lives outside the public schema, so DROP SCHEMA public does not erase it', async () => {
    const rows = (await sql(
      `SELECT schemaname FROM pg_tables WHERE tablename = 'schema_state'`,
    )) as Array<{ schemaname: string }>;
    expect(rows.map((r) => r.schemaname)).toEqual(['test_support']);
  });

  test('the stored row is a single row with the hash and when it was applied', async () => {
    const rows = (await sql(
      'SELECT id, migrations_hash, applied_at FROM test_support.schema_state',
    )) as Array<{ id: number; migrations_hash: string; applied_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.migrations_hash).toBe(hashMigrationFiles(MIGRATIONS_DIR));
    // O execute cru devolve timestamptz como texto, não como Date.
    expect(Number.isNaN(new Date(String(rows[0]?.applied_at)).getTime())).toBe(
      false,
    );
  });

  test('a missing application table asks for a reset even if the hash matches', async () => {
    // Pergunta com um nome de tabela que não existe: simula um schema que alguém estragou.
    expect(
      await needsSchemaReset(connection(), hashMigrationFiles(MIGRATIONS_DIR), [
        'wallets',
        'table_that_is_gone',
      ]),
    ).toBe(true);
  });

  test('with no state table at all (a brand new database) it asks for a reset', async () => {
    const broken = {
      execute: () =>
        Promise.reject(
          new Error('relation "test_support.schema_state" does not exist'),
        ),
    };
    expect(
      await needsSchemaReset(broken, hashMigrationFiles(MIGRATIONS_DIR)),
    ).toBe(true);
  });
});
