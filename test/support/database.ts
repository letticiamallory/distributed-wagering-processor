import { afterAll, beforeAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';
import {
  MIGRATIONS_DIR,
  hashMigrationFiles,
  needsSchemaReset,
  recordSchemaState,
} from './schema-state.js';

// Conexão com o banco de testes, sem preparar nada. Quem só precisa de uma conexão
// (por exemplo para criar outro banco) usa esta; quem precisa das tabelas, `openTestOrm`.
// Quanto o pool do PRÓPRIO processo de testes espera por uma conexão (inclusive para abri-la). O
// padrão de produção (3 s) é curto demais sob a carga da suíte completa no Docker do Windows, com
// processos filhos subindo e descendo: a primeira consulta de um arquivo chegou a esperar mais que
// isso. As apps que os testes sobem continuam com o valor de produção.
export const TEST_CONNECTION_TIMEOUT_MS = 15_000;

export function openOrm(): Promise<MikroORM> {
  return MikroORM.init({
    ...config,
    driverOptions: { connectionTimeoutMillis: TEST_CONNECTION_TIMEOUT_MS },
  });
}

// O ledger não aceita DELETE, então não dá para limpar tabelas entre testes. Em vez disso,
// cada teste usa UUIDs novos, e o schema só é recriado (DROP SCHEMA + migrations) quando
// as migrations mudam: o hash delas fica guardado no próprio banco de testes.
// Para forçar um banco limpo: TEST_DB_RESET=1 bun test.
async function prepareTestDatabase(): Promise<void> {
  const orm = await openOrm();
  try {
    const connection = orm.em.getConnection();
    const hash = hashMigrationFiles(MIGRATIONS_DIR);
    const forced = process.env.TEST_DB_RESET === '1';
    if (!forced && !(await needsSchemaReset(connection, hash))) {
      return;
    }
    await connection.execute('DROP SCHEMA public CASCADE');
    await connection.execute('CREATE SCHEMA public');
    await orm.migrator.up();
    await recordSchemaState(connection, hash);
  } finally {
    await orm.close();
  }
}

// Só roda se algum teste usar o banco, e uma vez por execução do `bun test`: o módulo é
// carregado uma vez, então a promessa fica guardada aqui. Os testes unitários nunca chamam
// isto e não pagam nada.
let ready: Promise<void> | undefined;
export function ensureTestDatabase(): Promise<void> {
  ready ??= prepareTestDatabase();
  return ready;
}

// Conexão com o banco de testes já migrado.
export async function openTestOrm(): Promise<MikroORM> {
  await ensureTestDatabase();
  return openOrm();
}

// Abre a conexão antes dos testes do arquivo e fecha no fim. Devolve a função que
// executa SQL direto no banco real; chamar no topo do arquivo de teste.
export function useSql(): (
  query: string,
  params?: unknown[],
) => Promise<unknown> {
  let orm: MikroORM;
  // O primeiro arquivo a chegar aqui pode pagar o reset do schema, por isso o timeout longo.
  beforeAll(async () => {
    orm = await openTestOrm();
  }, 60_000);
  afterAll(async () => {
    await orm.close();
  });
  return (query, params = []) => orm.em.getConnection().execute(query, params);
}
