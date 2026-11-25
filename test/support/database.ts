import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';

export function openTestOrm(): Promise<MikroORM> {
  return MikroORM.init(config);
}

// O ledger não aceita DELETE, então não dá para limpar tabelas entre testes.
// Em vez disso, recriamos o schema inteiro uma vez por execução do `bun test`
// e cada teste usa UUIDs novos.
export async function resetTestDatabase(): Promise<void> {
  const orm = await openTestOrm();
  try {
    const connection = orm.em.getConnection();
    await connection.execute('DROP SCHEMA public CASCADE');
    await connection.execute('CREATE SCHEMA public');
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}
