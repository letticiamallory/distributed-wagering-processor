import { afterAll, beforeAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';

// Conexão com o banco de testes, sem preparar nada. Quem só precisa de uma conexão
// (por exemplo para criar outro banco) usa esta; quem precisa das tabelas, `openTestOrm`.
export function openOrm(): Promise<MikroORM> {
  return MikroORM.init(config);
}

// O ledger não aceita DELETE, então não dá para limpar tabelas entre testes.
// Em vez disso, recriamos o schema inteiro e cada teste usa UUIDs novos.
async function resetTestDatabase(): Promise<void> {
  const orm = await openOrm();
  try {
    const connection = orm.em.getConnection();
    await connection.execute('DROP SCHEMA public CASCADE');
    await connection.execute('CREATE SCHEMA public');
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

// O reset leva alguns segundos (as migrations). Só roda se algum teste usar o banco, e
// uma vez por execução do `bun test`: o módulo é carregado uma vez, então a promessa
// fica guardada aqui. Os testes unitários da Fase 2 nunca chamam isto e não pagam o custo.
let ready: Promise<void> | undefined;
export function ensureTestDatabase(): Promise<void> {
  ready ??= resetTestDatabase();
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
  // O primeiro arquivo a chegar aqui paga o reset do schema, por isso o timeout longo.
  beforeAll(async () => {
    orm = await openTestOrm();
  }, 60_000);
  afterAll(async () => {
    await orm.close();
  });
  return (query, params = []) => orm.em.getConnection().execute(query, params);
}
