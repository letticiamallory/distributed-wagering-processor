import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createWalletVia,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';
import { assertInvariants } from '../support/invariants.js';
import { openPersistence } from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
} from '../support/queues.js';
import { waitUntilSomeoneIsBlocked } from '../support/wager-scenarios.js';

// A aplicação inteira (AppModule) com o consumidor LIGADO, na fila do próprio teste.
let queues: TestQueues;
let app: TestApp;
let closed = false;

beforeAll(async () => {
  queues = await createTestQueues({ visibilitySeconds: 2 });
  app = await startApp({
    env: {
      SQS_CONSUMER_ENABLED: 'true',
      SQS_QUEUE_NAME: queues.queueName,
      SQS_DLQ_NAME: queues.dlqName,
      SQS_WAIT_SECONDS: '1',
      SQS_RETRY_BASE_SECONDS: '0',
      SQS_SHUTDOWN_TIMEOUT_MS: '5000',
    },
  });
}, 60_000);

afterAll(async () => {
  if (!closed) await app.close();
  await queues.close();
});

const rows = (key: string) =>
  app.sql('SELECT status FROM wager_transactions WHERE idempotency_key = ?', [
    key,
  ]);
const keyOf = (body: Record<string, unknown>) =>
  `${String(body.providerId)}:${String(body.externalTransactionId)}`;

describe('the Nest application with the consumer switched on', () => {
  test('a message on the queue is processed by the app, and the same key over HTTP is then a replay', async () => {
    const wallet = await createWalletVia(app, '100.00');
    const body = wagerBody(wallet);
    await queues.send(envelope(body), { groupId: wallet.id });
    await waitFor(
      'the app to process the message',
      async () => (await rows(keyOf(body))).length === 1,
    );
    await queues.waitUntilEmpty();

    const replay = await submitVia(app, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      idempotentReplay: true,
      status: 'PROCESSED',
    });
    const entries = await app.sql(
      'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > 1',
      [wallet.id],
    );
    expect(entries).toHaveLength(1);
  });

  test('closing the app (what SIGTERM does) lets the message in flight FINISH before the database closes, then stops consuming', async () => {
    const wallet = await createWalletVia(app, '100.00');
    const body = wagerBody(wallet);
    const other = await openPersistence();
    try {
      // Uma transação alheia segura o lock da wallet: a mensagem entra no app e fica ESPERANDO.
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const heldSignal = new Promise<void>((resolve) => (held = resolve));
      const holder = other.uow.run(async (r) => {
        await r.wallets.lockById(wallet.id);
        held();
        await until;
      });
      await heldSignal;
      await queues.send(envelope(body), { groupId: wallet.id });
      await waitUntilSomeoneIsBlocked(app.sql);

      const closing = app.close(); // SIGTERM: para de buscar, espera a mensagem em andamento
      closed = true;
      // Com a mensagem em andamento o close() NÃO pode terminar: ele espera o consumidor.
      const early = await Promise.race([
        closing.then(() => 'closed'),
        Bun.sleep(700).then(() => 'still waiting'),
      ]);
      expect(early).toBe('still waiting');
      release(); // o lock é solto: a mensagem em andamento termina
      await holder;
      await closing;

      // O módulo só declara o consumidor parado depois de ele terminar tudo (nada abandonado).
      const stopped = app.logs.mentioning('sqs_consumer_stopped');
      expect(stopped).toHaveLength(1);
      expect(JSON.stringify(stopped[0]?.message)).toContain('"drained":true');
      expect(JSON.stringify(stopped[0]?.message)).toContain('"abandoned":0');

      const committed = await other.orm.em
        .getConnection()
        .execute(
          'SELECT status FROM wager_transactions WHERE idempotency_key = ?',
          [keyOf(body)],
        );
      expect(committed).toHaveLength(1);
      await queues.waitUntilEmpty();
    } finally {
      await other.close();
    }

    // depois de fechado, uma mensagem nova fica na fila: ninguém mais consome
    const after = await openPersistence();
    try {
      await queues.send(envelope(wagerBody(wallet)), { groupId: wallet.id });
      await Bun.sleep(2_500);
      expect((await queues.depth()).visible).toBe(1);
      await assertInvariants(
        (q, p = []) => after.orm.em.getConnection().execute(q, p),
        wallet.id,
      );
    } finally {
      await after.close();
    }
  }, 60_000);
});
