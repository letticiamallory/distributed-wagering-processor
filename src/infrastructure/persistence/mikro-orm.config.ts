import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

const clientUrl = process.env.DATABASE_URL;
if (!clientUrl) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

// As entidades (defineEntity) chegam nas Fases 1 e 3. Por enquanto só as migrations.
export default defineConfig({
  clientUrl,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    // O Bun executa o TypeScript direto, então não existe pasta de JS compilado.
    path: 'src/infrastructure/migrations',
    pathTs: 'src/infrastructure/migrations',
    // As migrations são SQL escrito à mão; não queremos arquivos .snapshot gerados.
    snapshot: false,
    snapshotOnMigrate: false,
  },
});
