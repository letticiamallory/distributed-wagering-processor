import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

// Aplica as migrations que faltam e termina. É o que o serviço `migrate` do docker-compose roda
// antes de a aplicação subir: sem isso, um banco novo não tem tabela nenhuma e todo endpoint de
// negócio responderia 500. Rodar de novo é seguro: o que já foi aplicado é pulado.
//
// O CLI do MikroORM (`bun run migration:up`) é uma dependência de desenvolvimento e não vai na
// imagem; este arquivo só usa o que a aplicação já tem.
const orm = await MikroORM.init(config);
try {
  const applied = await orm.migrator.up();
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      event: 'migrations_applied',
      count: applied.length,
      names: applied.map((migration) => migration.name),
    })}\n`,
  );
} finally {
  await orm.close();
}
