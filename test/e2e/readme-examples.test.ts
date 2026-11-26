import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnApp, type AppProcess } from '../support/app-process.js';
import { createTestQueues, type TestQueues } from '../support/queues.js';

// O README não pode mentir: este teste extrai o bloco ```bash readme-example e o EXECUTA de
// verdade (bash + curl) contra uma aplicação real (Postgres e MiniStack reais). Cada chamada de
// curl tem, na linha de comentário acima, o status esperado ("# => 201"); o teste confere um por um.
const README = readFileSync('README.md', 'utf8');
const BLOCK = /```bash readme-example\n([\s\S]*?)```/.exec(README)?.[1];

let app: AppProcess;
let queues: TestQueues;
let dir: string;

// Um processo de verdade, com o consumidor SQS e o worker de pendentes LIGADOS (como no compose),
// mas na fila de teste própria: nunca a wager-transactions.fifo real.
beforeAll(async () => {
  queues = await createTestQueues();
  app = spawnApp({
    SQS_CONSUMER_ENABLED: 'true',
    SQS_QUEUE_NAME: queues.queueName,
    SQS_DLQ_NAME: queues.dlqName,
    SQS_WAIT_SECONDS: '1',
    PENDING_WORKER_ENABLED: 'true',
    PENDING_WORKER_POLL_INTERVAL_MS: '200',
    PENDING_REFERENCE_BASE_DELAY_MS: '300',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  });
  await app.waitReady();
  dir = mkdtempSync(join(tmpdir(), 'readme-'));
}, 120_000);

afterAll(async () => {
  await app?.kill();
  await queues?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the README has exactly one executable example block', () => {
  expect(BLOCK).toBeDefined();
  expect(README.match(/```bash readme-example/g)).toHaveLength(1);
});

// O exemplo usa bash e curl, como quem avalia. Sem eles (uma imagem mínima), o teste não tem como
// rodar: pula com o motivo, em vez de falhar por uma ferramenta que o README já lista como requisito.
const HAS_TOOLS = Bun.which('bash') !== null && Bun.which('curl') !== null;

test.skipIf(!HAS_TOOLS)(
  'running the README example gives every documented HTTP status',
  async () => {
    const script = BLOCK as string;
    const expected = [...script.matchAll(/^# => (\d{3})$/gm)].map(
      (m) => m[1] as string,
    );
    expect(expected.length).toBeGreaterThan(10);

    // Um `curl` que registra o status de cada chamada e devolve o corpo, como o curl faria.
    const log = join(dir, 'statuses.log').replaceAll('\\', '/');
    const body = join(dir, 'body.tmp').replaceAll('\\', '/');
    const shim = `
curl() {
  local status
  status=$(command curl -o "${body}" -w '%{http_code}' "$@")
  echo "$status" >> "${log}"
  cat "${body}"
}
`;
    const file = join(dir, 'example.sh');
    writeFileSync(file, `${shim}\n${script}`, { encoding: 'utf8' });

    const child = Bun.spawn(['bash', file.replaceAll('\\', '/')], {
      env: {
        ...process.env,
        BASE: app.url,
        SQS_QUEUE_URL: queues.queueUrl,
        RUN: String(Date.now()).slice(-10),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    expect(code, `${err}\n${out}`).toBe(0);

    const actual = readFileSync(log, 'utf8').trim().split('\n');
    expect(actual, out).toEqual(expected);

    // Os números que o README promete, não só os status.
    const balances = [
      ...out.matchAll(/"balance":\{"amount":"(\d+\.\d{2})"/g),
    ].map((m) => m[1]);
    expect(balances.slice(0, 5)).toEqual([
      '100.00',
      '75.00',
      '75.00',
      '155.00',
      '145.00',
    ]);
    expect(out).toContain('"idempotentReplay":true');
    expect(out).toContain('"code":"IDEMPOTENCY_KEY_REUSED"');
    expect(out).toContain('"status":"PENDING_REFERENCE"');
    expect(out).toContain('"failureCode":"INSUFFICIENT_FUNDS"');
    expect(out).toMatch(/"consistent":true,"checkedEntries":5/);
    // O saldo final (passo 14) e a transação que veio pela fila.
    expect(out).toMatch(/"version":6\}/);
    expect(out).toContain(
      '"balance":{"amount":"145.00","currency":"BRL"},"version":6',
    );
    expect(out).toContain('"externalTransactionId":"sqs-bet-');
    expect(out).toContain('"postgres":"up","sqs":"up"');
  },
  120_000,
);
