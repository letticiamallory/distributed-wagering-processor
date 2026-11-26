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

// O consumidor SQS nasce DESLIGADO nos testes (inclusive nos processos filhos, que herdam o
// ambiente): só o teste que o liga, com a PRÓPRIA fila, consome. Fixo de propósito (não `??=`):
// um .env de desenvolvimento não pode ligá-lo e fazer a suíte competir pela fila de verdade.
process.env.SQS_CONSUMER_ENABLED = 'false';

// O schema do banco de testes é recriado sob demanda, por test/support/database.ts.
