import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';
import { openOrm } from '../support/database.js';

// Roda todas as migrations para cima, para baixo e para cima de novo num banco só deste
// teste. Se fosse no wallet_test, o `down` derrubaria as tabelas dos outros testes.
const DB_NAME = 'wallet_migrations_test';
if (!DB_NAME.endsWith('_test')) {
  throw new Error('The throwaway database name must end with _test');
}

const url = new URL(process.env.DATABASE_URL as string);
url.pathname = `/${DB_NAME}`;

const TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];
const FUNCTIONS = ['forbid_ledger_mutation', 'forbid_terminal_change'];

let admin: MikroORM;
let orm: MikroORM;

beforeAll(async () => {
  admin = await openOrm();
  const connection = admin.em.getConnection();
  await connection.execute(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await connection.execute(`CREATE DATABASE ${DB_NAME}`);
  // Mesmo ajuste do wallet_test (scripts/init-db.sql): o COMMIT não espera o fsync. É por
  // banco, então um banco recém-criado não herda; precisa ser feito aqui.
  await connection.execute(
    `ALTER DATABASE ${DB_NAME} SET synchronous_commit = off`,
  );
  orm = await MikroORM.init({ ...config, clientUrl: url.toString() });
}, 30_000);

afterAll(async () => {
  await orm.close();
  await admin.em
    .getConnection()
    .execute(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.close();
}, 30_000);

// Tudo que as migrations criam no schema public (tabelas e funções).
// Índices, triggers e constraints morrem junto com a tabela.
async function schemaObjects() {
  const rows = await orm.em.getConnection().execute<
    { kind: string; name: string }[]
  >(`
    SELECT 'table' AS kind, tablename AS name FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
    UNION ALL
    SELECT 'function', p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    ORDER BY 1, 2`);
  return {
    tables: rows.filter((r) => r.kind === 'table').map((r) => r.name),
    functions: rows.filter((r) => r.kind === 'function').map((r) => r.name),
  };
}

test('the throwaway database also commits without waiting for the fsync', async () => {
  const rows = await orm.em
    .getConnection()
    .execute<{ synchronous_commit: string }[]>('SHOW synchronous_commit');
  expect(rows[0]?.synchronous_commit).toBe('off');
});

test('all migrations go up, down to nothing, and up again', async () => {
  await orm.migrator.up();
  expect(await schemaObjects()).toEqual({
    tables: TABLES,
    functions: FUNCTIONS,
  });

  await orm.migrator.down({ to: 0 });
  expect(await schemaObjects()).toEqual({ tables: [], functions: [] });

  await orm.migrator.up();
  expect(await schemaObjects()).toEqual({
    tables: TABLES,
    functions: FUNCTIONS,
  });
}, 60_000);
