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

// Os nomes das filas dos apps de teste (inclusive os processos filhos) apontam para filas SÓ DE
// TESTE, nunca para as reais. Assim a suíte passa com a stack inteira no ar (docker compose up -d,
// com o consumidor do app de verdade ligado na wager-transactions.fifo): ninguém disputa a fila.
// Também fixos de propósito. Só o teste que confere os nomes e o redrive das filas reais as
// toca, e só para LER os atributos (nunca envia mensagem).
const TEST_QUEUE_NAME = 'test-app-wager-transactions.fifo';
const TEST_DLQ_NAME = 'test-app-wager-transactions-dlq.fifo';
process.env.SQS_QUEUE_NAME = TEST_QUEUE_NAME;
process.env.SQS_DLQ_NAME = TEST_DLQ_NAME;

// O publisher da outbox e o worker de PENDING_REFERENCE também nascem DESLIGADOS nos testes (e nos
// processos filhos): só o teste que os liga, com a PRÓPRIA fila de eventos, os executa. Os padrões
// de produção são `true`. A fila de eventos aponta para uma fila só de teste, como as de cima.
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.PENDING_WORKER_ENABLED = 'false';
process.env.OUTBOX_QUEUE_NAME = 'test-app-wallet-events.fifo';

// O schema do banco de testes é recriado sob demanda, por test/support/database.ts.
