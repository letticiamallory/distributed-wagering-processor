// O Bun já carregou o .env (banco de desenvolvimento) antes deste arquivo.
// Aqui forçamos os testes para o banco de testes, para nunca tocar em "wallet".
const testUrl =
  process.env.TEST_DATABASE_URL ??
  'postgres://wallet:wallet@localhost:5432/wallet_test';

const dbName = new URL(testUrl).pathname.slice(1);
if (!dbName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against "${dbName}": database name must end with _test`,
  );
}

process.env.DATABASE_URL = testUrl;
process.env.SQS_ENDPOINT ??= 'http://localhost:4566';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= 'us-east-1';

// Schema limpo e migrado, uma vez por execução. Import dinâmico porque o config do
// MikroORM lê DATABASE_URL ao ser importado, e ela só está certa depois das linhas acima.
const { resetTestDatabase } = await import('./database.js');
await resetTestDatabase();
