import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertInvariants } from '../support/invariants.js';
import {
  openPersistence,
  uuid,
  usePersistence,
} from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
} from '../support/queues.js';
import {
  createScenario,
  waitUntilSomeoneIsBlocked,
} from '../support/wager-scenarios.js';

// O SIGTERM DE VERDADE, num processo de verdade (`bun src/main.ts`), com uma mensagem em andamento.
//
// No Windows o Node/Bun não entrega SIGTERM como sinal: `kill('SIGTERM')` encerra o processo à
// força, sem rodar nenhum handler, e este teste mediria outra coisa. Por isso ele só roda onde o
// sinal existe (Linux e macOS, inclusive o CI). O que vale no Windows (o wiring do
// gracefulShutdown do bootstrap e o app.close() de verdade) está em shutdown-hooks.test.ts e em
// sqs-consumer.app.test.ts.
const hasPosixSignals = process.platform !== 'win32';
const realSignal = hasPosixSignals ? test : test.skip;

const db = usePersistence();
const s = createScenario(db);
let queues: TestQueues;
beforeAll(async () => {
  queues = await createTestQueues({ visibilitySeconds: 2 });
}, 30_000);
afterAll(async () => {
  await queues?.close();
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

describe('SIGTERM on a real process with a message in flight', () => {
  realSignal(
    'the process waits for the message in flight, commits, deletes it, and only then exits (skipped on Windows: no SIGTERM handlers there)',
    async () => {
      const wallet = await s.walletWith('100.00');
      const body = s.body(wallet);
      const key = s.keyOf(body);

      const port = freePort();
      const child = Bun.spawn([process.execPath, 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          SQS_CONSUMER_ENABLED: 'true',
          SQS_QUEUE_NAME: queues.queueName,
          SQS_DLQ_NAME: queues.dlqName,
          SQS_WAIT_SECONDS: '1',
          SQS_RETRY_BASE_SECONDS: '0',
          SQS_SHUTDOWN_TIMEOUT_MS: '15000',
          DB_LOCK_TIMEOUT_MS: '30000',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let output = '';
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          output += decoder.decode(chunk, { stream: true });
        }
      };
      void collect(child.stdout as ReadableStream<Uint8Array>);
      void collect(child.stderr as ReadableStream<Uint8Array>);

      const holder = await openPersistence();
      try {
        await waitFor(
          'the process to be ready',
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
            } catch {
              return false;
            }
          },
          60_000,
        );

        // Uma transação alheia segura o lock da wallet: a mensagem entra no processo e ESPERA.
        let release!: () => void;
        const until = new Promise<void>((resolve) => (release = resolve));
        let held!: () => void;
        const heldSignal = new Promise<void>((resolve) => (held = resolve));
        const holding = holder.uow.run(async (r) => {
          await r.wallets.lockById(wallet.id);
          held();
          await until;
        });
        await heldSignal;
        await queues.send(envelope(body, { messageId: `msg-${uuid()}` }), {
          groupId: wallet.id,
        });
        await waitUntilSomeoneIsBlocked(s.sql);

        child.kill('SIGTERM');

        // O processo NÃO morre: a mensagem em andamento ainda não terminou.
        const early = await Promise.race([
          child.exited.then(() => 'exited'),
          Bun.sleep(1_000).then(() => 'still running'),
        ]);
        expect(early).toBe('still running');

        // Enquanto termina a mensagem, o processo sai de rotação: ready 503, live ainda 200.
        const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({
          status: 'shutting_down',
          checks: {},
        });
        expect(
          (await fetch(`http://127.0.0.1:${port}/health/live`)).status,
        ).toBe(200);

        release(); // a mensagem termina: commit, delete, e só então o processo sai
        await holding;
        const exitCode = await Promise.race([
          child.exited,
          Bun.sleep(20_000).then(() => 'timeout' as const),
        ]);
        expect(exitCode).not.toBe('timeout');

        expect(
          await s.sql(
            'SELECT status FROM wager_transactions WHERE idempotency_key = ?',
            [key],
          ),
        ).toHaveLength(1);
        expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
        await queues.waitUntilEmpty();
        expect(await queues.dead()).toHaveLength(0);
        await assertInvariants(s.sql, wallet.id);

        const text = output.replace(ANSI, '');
        expect(text).toContain('sqs_consumer_stopped');
        // Os logs são JSON (ADR-0014): {"event":"sqs_consumer_stopped","drained":true,...}
        expect(text).toMatch(/"drained":\s*true/);
      } finally {
        child.kill('SIGKILL');
        await holder.close();
      }
    },
    90_000,
  );
});
