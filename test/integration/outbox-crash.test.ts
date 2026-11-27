import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PublishOutboxBatchUseCase } from '../../src/application/use-cases/publish-outbox-batch.use-case.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';
import { spawnApp } from '../support/app-process.js';
import { createEventQueue, type EventQueue } from '../support/event-queue.js';
import {
  dropWalletEvents,
  outboxRowsOf,
  quiesceOutbox,
} from '../support/outbox.js';
import { usePersistence } from '../support/persistence.js';
import {
  createTestQueues,
  envelope,
  waitFor,
  type TestQueues,
} from '../support/queues.js';
import { createScenario } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db, { start: new Date() });

beforeAll(async () => {
  await quiesceOutbox(s.sql);
});

let events: EventQueue;
let queues: TestQueues;
beforeAll(async () => {
  events = await createEventQueue();
  queues = await createTestQueues({ visibilitySeconds: 2 });
}, 30_000);
afterAll(async () => {
  await events?.close();
  await queues?.close();
});

const publisherEnv = () => ({
  OUTBOX_PUBLISHER_ENABLED: 'true',
  OUTBOX_QUEUE_NAME: events.queueName,
  OUTBOX_POLL_INTERVAL_MS: '100',
});

// Cenário do enunciado (seção 11): "o PostgreSQL confirma o commit; o processo morre antes de
// publicar; outra instância assume o trabalho; o evento é publicado; uma publicação duplicada
// continua segura para o consumidor".
describe('the process dies between the commit and the publication', () => {
  test('dies BEFORE publishing: the committed events are still there, and ANOTHER instance publishes them', async () => {
    const wallet = await s.walletWith('100.00');
    await dropWalletEvents(s.sql, wallet.id);
    const body = s.body(wallet);

    // Instância A: consome da fila e grava (o publisher dela está desligado). Morre com SIGKILL.
    const a = spawnApp({
      SQS_CONSUMER_ENABLED: 'true',
      SQS_QUEUE_NAME: queues.queueName,
      SQS_DLQ_NAME: queues.dlqName,
      SQS_WAIT_SECONDS: '1',
      SQS_RETRY_BASE_SECONDS: '0',
    });
    try {
      await a.waitReady();
      await queues.send(envelope(body), { groupId: wallet.id });
      await waitFor(
        'the instance to commit the transaction and its events',
        async () => {
          return (await outboxRowsOf(s.sql, [wallet.id])).length === 2;
        },
      );
    } finally {
      await a.kill(); // o commit confirmou; o processo morre antes de publicar
    }

    const rows = await outboxRowsOf(s.sql, [wallet.id]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']); // o dinheiro está gravado
    expect(await events.listen(1_500)).toHaveLength(0); // e nada foi publicado

    // Instância B: só publica. Assume o trabalho que A deixou.
    const b = spawnApp(publisherEnv());
    try {
      await b.waitReady();
      await events.collect(2);
    } finally {
      await b.kill();
    }
    const after = await outboxRowsOf(s.sql, [wallet.id]);
    expect(after.every((r) => r.published_at !== null)).toBe(true);
    expect(events.uniqueIds()).toEqual(new Set(after.map((r) => String(r.id))));
  }, 90_000);

  test('dies AFTER the broker accepted the batch but BEFORE marking it published: it is published again, and a consumer that dedups by eventId sees each event once', async () => {
    const wallet = await s.walletWith('100.00');
    await dropWalletEvents(s.sql, wallet.id);
    await s.placeBet(wallet, '1.00');
    await s.placeBet(wallet, '1.00');
    const ids = (await outboxRowsOf(s.sql, [wallet.id])).map((r) =>
      String(r.id),
    );
    expect(ids).toHaveLength(4);
    const uniqueBefore = events.uniqueIds().size;

    // Um processo de verdade cujo SQS aceitou o lote e que morre ANTES do commit.
    const child = Bun.spawn(
      [process.execPath, 'test/support/publisher-crash-process.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...publisherEnv() },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = new Response(child.stdout as ReadableStream).text();
    const errors = new Response(child.stderr as ReadableStream).text();
    const code = await child.exited;
    // Morreu mesmo (kill -9). No POSIX o sinal é visível; no Windows só o código diferente de 0.
    expect(code, await errors).not.toBe(0);
    if (process.platform !== 'win32') {
      expect(child.signalCode).toBe('SIGKILL');
    }
    expect(await output).toContain('SENT');

    // O COMMIT não aconteceu: nada ficou marcado como publicado, embora o SQS tenha recebido.
    const rows = await outboxRowsOf(s.sql, [wallet.id]);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    // ...e o SQS recebeu os 4 eventos desta wallet (a publicação de antes da morte).
    const firstWave = await events.collect(uniqueBefore + 4, 15_000);
    expect(
      new Set(
        firstWave
          .filter((e) => e.aggregateId === wallet.id)
          .map((e) => e.eventId),
      ),
    ).toEqual(new Set(ids));

    // Outra instância assume e publica DE NOVO (at-least-once).
    const takeover = new PublishOutboxBatchUseCase(
      db().uow,
      new SqsEventPublisher(events.client, events.queueUrl, {
        timeoutMs: 5_000,
      }),
      s.clock,
      { batchSize: 10, jitter: () => 0, stuckAfterAttempts: 10 },
    );
    for (let i = 0; i < 10; i++) {
      if ((await takeover.execute()).claimed === 0) break;
    }
    await events.listen(1_500);

    const after = await outboxRowsOf(s.sql, [wallet.id]);
    expect(after.every((r) => r.published_at !== null)).toBe(true);
    // Quem consome deduplica por eventId: cada evento da carteira aparece uma vez, e nenhum falta.
    const mine = events.received().filter((e) => e.aggregateId === wallet.id);
    expect(new Set(mine.map((e) => e.eventId))).toEqual(new Set(ids));
    // Se o SQS entregou repetido, o conteúdo é o mesmo (nada diverge entre as duas publicações).
    for (const id of ids) {
      const copies = mine.filter((e) => e.eventId === id);
      expect(copies.length).toBeGreaterThanOrEqual(1);
      for (const copy of copies)
        expect(copy.envelope).toEqual(
          copies[0]?.envelope as Record<string, unknown>,
        );
    }
  }, 90_000);
});
