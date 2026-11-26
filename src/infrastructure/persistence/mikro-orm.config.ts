import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { entities } from './entities.js';

const clientUrl = process.env.DATABASE_URL;
if (!clientUrl) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative integer, received "${raw}"`,
    );
  }
  return value;
}

// Pool (ADR-0007): pelo menos 20 conexões, para N requisições concorrentes virarem N
// transações de verdade, e no máximo 1s de espera por uma conexão livre. Com o pool
// cheio o pg lança "timeout exceeded when trying to connect", que vira 503.
export default defineConfig({
  clientUrl,
  entities,
  pool: {
    min: intFromEnv('DB_POOL_MIN', 2),
    max: intFromEnv('DB_POOL_MAX', 20),
  },
  driverOptions: {
    connectionTimeoutMillis: intFromEnv('DB_ACQUIRE_TIMEOUT_MS', 1_000),
  },
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
