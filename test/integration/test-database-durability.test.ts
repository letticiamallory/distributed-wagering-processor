import { describe, expect, test } from 'bun:test';
import { useSql } from '../support/database.js';

const sql = useSql();

// Os bancos de teste trocam durabilidade por velocidade: o COMMIT não espera o fsync do WAL
// (129 ms por transação que grava no Docker do Windows, contra 4 ms). Um teste nunca precisa
// sobreviver a uma queda de energia do servidor. O banco de desenvolvimento e produção
// continuam duráveis: a configuração é POR BANCO (ALTER DATABASE), nunca do servidor.
describe('test databases do not wait for the fsync at COMMIT', () => {
  test('wallet_test commits with synchronous_commit = off', async () => {
    const rows = (await sql('SHOW synchronous_commit')) as Array<{
      synchronous_commit: string;
    }>;
    expect(rows[0]?.synchronous_commit).toBe('off');
  });

  test('the value comes from the DATABASE, not from the server configuration', async () => {
    const rows = (await sql(
      `SELECT source FROM pg_settings WHERE name = 'synchronous_commit'`,
    )) as Array<{ source: string }>;
    expect(rows[0]?.source).toBe('database');
  });

  test('only databases whose name ends in _test have it', async () => {
    const rows = (await sql(
      `SELECT d.datname, s.setconfig::text AS setconfig
         FROM pg_db_role_setting s
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE s.setconfig::text ILIKE '%synchronous_commit%'`,
    )) as Array<{ datname: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.datname.endsWith('_test')).toBe(true);
    }
  });

  test('the development database keeps the durable default', async () => {
    const rows = (await sql(
      `SELECT d.datname
         FROM pg_db_role_setting s
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname IN ('wallet', 'postgres')
          AND s.setconfig::text ILIKE '%synchronous_commit%'`,
    )) as unknown[];
    expect(rows).toEqual([]);
  });
});
