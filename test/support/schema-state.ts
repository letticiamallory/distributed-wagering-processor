import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = 'src/infrastructure/migrations';

// O schema do banco de testes só precisa ser recriado quando as migrations mudam. Este hash
// resume TODAS elas: nome e conteúdo de cada arquivo, em ordem alfabética (que é a ordem
// em que o MikroORM as aplica). Mudar um caractere, renomear, mover conteúdo entre arquivos
// ou criar uma migration nova muda o hash. Arquivos que não são migration (snapshots,
// anotações) não entram.
export function hashMigrationFiles(directory: string): string {
  const names = readdirSync(directory)
    .filter((name) => /^Migration.*\.ts$/.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error(`No migration found in ${directory}`);
  }
  const hash = createHash('sha256');
  for (const name of names) {
    // O separador NUL evita que "ab" + "c" e "a" + "bc" deem o mesmo resumo.
    hash.update(name).update('\0');
    hash.update(readFileSync(join(directory, name))).update('\0');
  }
  return hash.digest('hex');
}

// O estado fica FORA do schema public (que o reset apaga com DROP SCHEMA ... CASCADE), numa
// tabela do próprio banco de testes.
const STATE_TABLE = 'test_support.schema_state';
const DEFAULT_REQUIRED_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
];

interface Executor {
  execute(query: string, params?: unknown[]): Promise<unknown>;
}

// true: recriar o schema. Qualquer dúvida (tabela de estado ausente, hash diferente, tabela
// da aplicação sumida) vira "recriar": o custo de errar para esse lado é só tempo.
export async function needsSchemaReset(
  connection: Executor,
  expectedHash: string,
  requiredTables: readonly string[] = DEFAULT_REQUIRED_TABLES,
): Promise<boolean> {
  try {
    const stored = (await connection.execute(
      `SELECT migrations_hash FROM ${STATE_TABLE} WHERE id = 1`,
    )) as Array<{ migrations_hash: string }>;
    if (stored[0]?.migrations_hash !== expectedHash) {
      return true;
    }
    for (const table of requiredTables) {
      const found = (await connection.execute(
        'SELECT to_regclass(?) AS found',
        [`public.${table}`],
      )) as Array<{ found: string | null }>;
      if (found[0]?.found == null) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export async function recordSchemaState(
  connection: Executor,
  hash: string,
): Promise<void> {
  await connection.execute('CREATE SCHEMA IF NOT EXISTS test_support');
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
       id              INTEGER PRIMARY KEY CHECK (id = 1),
       migrations_hash TEXT NOT NULL,
       applied_at      TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await connection.execute(
    `INSERT INTO ${STATE_TABLE} (id, migrations_hash) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET migrations_hash = EXCLUDED.migrations_hash, applied_at = now()`,
    [hash],
  );
}
