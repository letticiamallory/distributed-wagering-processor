import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openOrm } from '../support/database.js';

// O que o serviço `migrate` do docker-compose executa antes de a aplicação subir. Num banco NOVO
// (o que um clone limpo tem) ele tem que criar o schema inteiro; num banco que já está em dia, não
// pode fazer nada. Banco só deste teste: o nome termina em _test.
const DB_NAME = 'wallet_runmigrations_test';
const ENTRYPOINT = 'src/infrastructure/persistence/run-migrations.ts';
const FILES = readdirSync('src/infrastructure/migrations').filter((f) =>
  f.endsWith('.ts'),
);

let admin: MikroORM;
const url = new URL(process.env.DATABASE_URL as string);
url.pathname = `/${DB_NAME}`;

beforeAll(async () => {
  admin = await openOrm();
  const connection = admin.em.getConnection();
  await connection.execute(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await connection.execute(`CREATE DATABASE ${DB_NAME}`);
}, 30_000);

afterAll(async () => {
  await admin.em
    .getConnection()
    .execute(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.close();
  // O mesmo prazo do beforeAll: apagar um banco com o schema inteiro passa de 5 s sob a carga da
  // suíte completa no Docker do Windows.
}, 30_000);

async function run() {
  const child = Bun.spawn([process.execPath, ENTRYPOINT], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  return { out, err, code };
}

const tablesOf = async (): Promise<string[]> => {
  const { default: config } =
    await import('../../src/infrastructure/persistence/mikro-orm.config.js');
  const { MikroORM: Orm } = await import('@mikro-orm/postgresql');
  const orm = await Orm.init({ ...config, clientUrl: url.toString() });
  try {
    const rows = (await orm.em
      .getConnection()
      .execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      )) as Array<{ table_name: string }>;
    return rows.map((r) => r.table_name);
  } finally {
    await orm.close();
  }
};

describe('run-migrations (the docker-compose `migrate` service)', () => {
  test('on a brand-new database it creates the whole schema and exits 0', async () => {
    expect(await tablesOf()).toEqual([]);
    const { out, err, code } = await run();
    expect(code, err).toBe(0);
    const line = JSON.parse(out.trim().split('\n').at(-1) as string);
    expect(line).toMatchObject({
      event: 'migrations_applied',
      count: FILES.length,
    });
    expect(line.names).toHaveLength(FILES.length);
    expect(await tablesOf()).toEqual(
      expect.arrayContaining([
        'inbox_messages',
        'mikro_orm_migrations',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]),
    );
  }, 60_000);

  test('run again, it does nothing and still exits 0 (the compose restart or a second replica is safe)', async () => {
    const { out, err, code } = await run();
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim().split('\n').at(-1) as string)).toMatchObject({
      count: 0,
      names: [],
    });
  }, 60_000);

  test('a database that stopped at an older migration is brought up to date (what the old dev volume looked like)', async () => {
    const { MikroORM: Orm } = await import('@mikro-orm/postgresql');
    const { default: config } =
      await import('../../src/infrastructure/persistence/mikro-orm.config.js');
    const orm = await Orm.init({ ...config, clientUrl: url.toString() });
    try {
      await orm.migrator.down(); // desfaz a mais nova
    } finally {
      await orm.close();
    }
    const { out, err, code } = await run();
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim().split('\n').at(-1) as string)).toMatchObject({
      count: 1,
    });
  }, 60_000);
});
