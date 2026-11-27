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
  'consumer_delivery_failures',
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

// A regra "PENDING só existe num INSERT" é a migration mais nova: o down de UMA migration a
// desfaz (a função volta a ser a de antes) e o up a refaz. O resto do schema não é tocado.
const INSERT_PENDING_REFERENCE = `
  INSERT INTO wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
     player_id, round_id, game_id, kind, amount, currency, status,
     reference_external_transaction_id, attempts, next_attempt_at, correlation_id)
  VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'REFUND', '10.00', 'BRL', 'PENDING_REFERENCE',
     'ext', 1, now(), 'c')`;

test('the PENDING-only-on-INSERT migration goes down (with the ones after it) and up again', async () => {
  await orm.migrator.up();
  const connection = orm.em.getConnection();
  const walletId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await connection.execute(
    'INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, ?)',
    [walletId, playerId, 'BRL', '100.00', 1],
  );
  const newPending = async () => {
    const id = crypto.randomUUID();
    await connection.execute(INSERT_PENDING_REFERENCE, [
      id,
      crypto.randomUUID(),
      crypto.randomUUID(),
      'a'.repeat(64),
      walletId,
      playerId,
    ]);
    return id;
  };
  const outcomeOfToPending = (id: string) =>
    connection
      .execute(
        `UPDATE wager_transactions SET status = 'PENDING', next_attempt_at = NULL WHERE id = ?`,
        [id],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as Error).message,
      );

  // up: o UPDATE para PENDING é recusado.
  expect(await outcomeOfToPending(await newPending())).toContain(
    'cannot be updated to PENDING',
  );

  // down até a migration ANTERIOR a ela (desfaz ela e as mais novas, que são só índices): a regra
  // some, o resto continua (a função existe, o trigger vale).
  await orm.migrator.down({ to: 'Migration20261126011328_wtx_lookup_indexes' });
  expect((await schemaObjects()).functions).toEqual(FUNCTIONS);
  const id = await newPending();
  expect(await outcomeOfToPending(id)).toBe('accepted'); // como antes da migration
  await connection.execute(
    `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), balance_after = '90.00' WHERE id = ?`,
    [id],
  );
  const stillTerminal = await connection
    .execute('UPDATE wager_transactions SET attempts = 5 WHERE id = ?', [id])
    .then(
      () => 'accepted',
      (error: unknown) => (error as Error).message,
    );
  expect(stillTerminal).toContain('is terminal'); // a regra do estado final continua

  // up de novo: a regra volta.
  await orm.migrator.up();
  expect(await outcomeOfToPending(await newPending())).toContain(
    'cannot be updated to PENDING',
  );
}, 60_000);

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
