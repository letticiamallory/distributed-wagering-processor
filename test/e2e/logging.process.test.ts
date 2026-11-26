import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnApp, type AppProcess } from '../support/app-process.js';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import {
  dropWalletEvents,
  parkForeignPendings,
  quiesceOutbox,
} from '../support/outbox.js';
import { usePersistence, uuid } from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
} from '../support/queues.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

// Os logs REAIS de um processo de verdade (`bun src/main.ts`), nos três caminhos: HTTP, consumidor
// SQS e workers. O teste captura tudo o que o processo escreveu e prova o formato (uma linha, um
// JSON), os campos (correlationId, messageId, transactionId, walletId, providerId) e, o mais
// importante, a AUSÊNCIA do corpo financeiro.
const db = usePersistence();
const s = createScenario(db, { start: new Date() });

type Line = Record<string, unknown>;
let app: AppProcess;
let queues: TestQueues;
let events: EventQueue;
let lines: Line[] = [];
let raw: string[] = [];

// Valores que existem SÓ no corpo das requisições e das mensagens: se aparecerem num log, o corpo vazou.
const MARKERS = {
  httpBet: '37.31',
  httpRejected: '9999.99',
  initialBalance: '512.64',
  sqsBet: '41.17',
  sqsRefund: '13.13',
  // Só o começo: o erro do parser de JSON cita um pedaço do texto, e um pedaço já é vazamento.
  garbage: 'LEAKCHECK',
};
const walletBody = {
  playerId: uuid(),
  initialBalance: { amount: MARKERS.initialBalance, currency: 'BRL' },
};
const CORRELATION = `corr-log-${uuid()}`;
const sqsBetMessageId = `msg-${uuid()}`;
let httpWalletId = '';
let httpTransactionId = '';

beforeAll(async () => {
  await quiesceOutbox(s.sql);
  await parkForeignPendings(s.sql);
  queues = await createTestQueues({ visibilitySeconds: 2 });
  events = await createEventQueue();
  app = spawnApp({
    LOG_LEVEL: 'debug',
    SQS_CONSUMER_ENABLED: 'true',
    SQS_QUEUE_NAME: queues.queueName,
    SQS_DLQ_NAME: queues.dlqName,
    SQS_WAIT_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '0',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_QUEUE_NAME: events.queueName,
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_WORKER_ENABLED: 'true',
    PENDING_WORKER_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '300',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  });
  await app.waitReady();

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // ---- HTTP
  const wallet = (await (
    await post('/wallets', walletBody, { 'x-correlation-id': CORRELATION })
  ).json()) as { id: string };
  httpWalletId = wallet.id;
  const bet = {
    providerId: 'provider-a',
    externalTransactionId: `ext-${uuid()}`,
    playerId: walletBody.playerId,
    walletId: wallet.id,
    roundId: 'r-1',
    gameId: 'g-1',
    kind: 'BET',
    money: { amount: MARKERS.httpBet, currency: 'BRL' },
  };
  const key = `provider-a:${bet.externalTransactionId}`;
  const created = await post('/wagering/transactions', bet, {
    'idempotency-key': key,
    'x-correlation-id': CORRELATION,
  });
  httpTransactionId = ((await created.json()) as { transactionId: string })
    .transactionId;
  await post('/wagering/transactions', bet, { 'idempotency-key': key }); // replay
  await post(
    '/wagering/transactions',
    {
      ...bet,
      externalTransactionId: `ext-${uuid()}`,
      money: { amount: MARKERS.httpRejected, currency: 'BRL' },
    },
    { 'idempotency-key': `k-${uuid()}` },
  ); // 422
  await post(
    '/wagering/transactions',
    { nope: true },
    { 'idempotency-key': `k-${uuid()}` },
  ); // 400

  // ---- SQS: uma aposta, um lixo, e um REFUND antes da aposta (o worker resolve)
  const sqsWallet = await s.walletWith('1000.00');
  await dropWalletEvents(s.sql, sqsWallet.id);
  const sqsBet = s.body(sqsWallet, {
    money: { amount: MARKERS.sqsBet, currency: 'BRL' },
  });
  await queues.send(envelope(sqsBet, { messageId: sqsBetMessageId }), {
    groupId: sqsWallet.id,
  });
  await queues.send(`${MARKERS.garbage}-garbage-body`, {
    groupId: 'g-garbage',
  });
  const lateBetExternal = ext(`late-${uuid()}`);
  await queues.send(
    envelope(
      s.body(sqsWallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: lateBetExternal,
        money: { amount: MARKERS.sqsRefund, currency: 'BRL' },
      }),
    ),
    { groupId: sqsWallet.id },
  );
  await queues.send(
    envelope(
      s.body(sqsWallet, {
        externalTransactionId: lateBetExternal,
        money: { amount: MARKERS.sqsRefund, currency: 'BRL' },
      }),
    ),
    { groupId: sqsWallet.id },
  );

  await queues.waitUntilEmpty();
  await waitFor(
    'the pending refund to be resolved by the worker',
    async () => {
      const rows = await s.sql(
        "SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'REFUND' AND status = 'PROCESSED'",
        [sqsWallet.id],
      );
      return Number(rows[0]?.n) === 1;
    },
    30_000,
  );
  await waitFor(
    'the outbox to drain',
    async () => {
      const rows = await s.sql(
        'SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL',
      );
      return Number(rows[0]?.n) === 0;
    },
    30_000,
  );
  await Bun.sleep(500);
  await app.kill();

  raw = app
    .output()
    .split('\n')
    .filter((l) => l.trim() !== '');
  lines = raw.flatMap((l) => {
    try {
      return [JSON.parse(l) as Line];
    } catch {
      return [];
    }
  });
}, 240_000);

afterAll(async () => {
  await events?.close();
  await queues?.close();
});

const byEvent = (event: string) => lines.filter((l) => l.event === event);

describe('the format: every line the process writes is one JSON object', () => {
  test('nothing the process printed is outside the format (not even the framework start-up lines)', () => {
    expect(raw.length).toBeGreaterThan(10);
    const notJson = raw.filter((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    });
    expect(notJson).toEqual([]);
  });

  test('every line has an ISO time, a known level and either an event or a message', () => {
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(String(line.time)).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(['debug', 'info', 'warn', 'error', 'fatal']).toContain(
        String(line.level),
      );
      expect(typeof (line.event ?? line.message)).toBe('string');
    }
  });
});

describe('the HTTP path', () => {
  test('each request is one line with method, route, status, duration and the correlation id the client sent', () => {
    const bets = byEvent('request_completed').filter(
      (l) => l.route === '/wagering/transactions' && l.status === 201,
    );
    expect(bets).toHaveLength(1);
    expect(bets[0]).toMatchObject({
      method: 'POST',
      route: '/wagering/transactions',
      status: 201,
      correlationId: CORRELATION,
      providerId: 'provider-a',
      walletId: httpWalletId,
      transactionId: httpTransactionId,
    });
    expect(typeof bets[0]?.durationMs).toBe('number');
  });

  test('the replay (200), the rejection (422) and the bad request (400) are logged too, each with its status', () => {
    const statuses = byEvent('request_completed')
      .filter((l) => l.route === '/wagering/transactions')
      .map((l) => Number(l.status))
      .sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201, 400, 422]);
  });

  test('a request that never sent a correlation id still gets one (the line is never anonymous)', () => {
    expect(byEvent('request_completed').length).toBeGreaterThan(0);
    for (const line of byEvent('request_completed')) {
      expect(String(line.correlationId).length).toBeGreaterThan(0);
    }
  });
});

describe('the SQS consumer path', () => {
  test('an acked message carries messageId, correlationId (= messageId), walletId, providerId and transactionId', () => {
    const acked = byEvent('message_acked').find(
      (l) => l.messageId === sqsBetMessageId,
    );
    expect(acked).toMatchObject({
      outcome: 'PROCESSED',
      correlationId: sqsBetMessageId,
      providerId: 'provider-a',
    });
    expect(typeof acked?.walletId).toBe('string');
    expect(typeof acked?.transactionId).toBe('string');
  });

  test('a dead letter is logged with its reason and the SQS message id, and never with the body', () => {
    const dead = byEvent('message_dead_lettered');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ reason: 'INVALID_JSON', level: 'error' });
    expect(typeof dead[0]?.sqsMessageId).toBe('string');
  });
});

describe('the worker paths', () => {
  test('the pending worker logs the resolution with transactionId, walletId and a correlationId', () => {
    const resolved = byEvent('pending_reference_resolved');
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved[0]).toMatchObject({ outcome: 'RESOLVED' });
    expect(typeof resolved[0]?.transactionId).toBe('string');
    expect(typeof resolved[0]?.walletId).toBe('string');
    expect(String(resolved[0]?.correlationId)).toStartWith('pending-worker:');
  });

  test('the outbox publisher logs each published batch with how many events it took', () => {
    const batches = byEvent('outbox_batch_published');
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(
      batches.reduce((sum, l) => sum + Number(l.published), 0),
    ).toBeGreaterThanOrEqual(8);
    expect(batches.every((l) => Number(l.failed) === 0)).toBe(true);
  });
});

describe('what the logs must NOT contain: the financial payload', () => {
  test.each(Object.entries(MARKERS))(
    'the value of "%s" (%s) is in no log line',
    (_name, value) => {
      const leaked = raw.filter((l) => l.includes(value));
      expect(leaked).toEqual([]);
    },
  );

  test('neither the player id nor the field names of a financial body appear', () => {
    const leaked = raw.filter(
      (l) =>
        l.includes(walletBody.playerId) ||
        /"(money|amount|initialBalance|balanceAfter|balanceBefore|payload|body)"/.test(
          l,
        ),
    );
    expect(leaked).toEqual([]);
  });

  test('the identifiers ARE there (the opposite of the check above): the wallet id is in the HTTP line', () => {
    expect(raw.some((l) => l.includes(httpWalletId))).toBe(true);
  });
});
