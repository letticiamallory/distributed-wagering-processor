import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Json } from '../support/http-app.js';
import { runHotWallet } from '../support/hot-wallet.js';
import { startInstances, type Instances } from '../support/instances.js';
import {
  expectNoProblems,
  failIfAny,
  recordMetrics,
  walletFacts,
} from '../support/ledger-check.js';
import { openPersistence, type Persistence } from '../support/persistence.js';
import { ProviderClient } from '../support/provider-client.js';
import { rounds } from '../support/rounds.js';

// TRÊS PROCESSOS da aplicação (bun src/main.ts), em portas diferentes, contra o mesmo Postgres: o
// que "três ou mais instâncias rodam simultaneamente" (enunciado, seção 8) pede. Nenhum estado em
// memória é compartilhado, então só o banco decide quem ganha.
const INSTANCES = 3;
let instances: Instances;
let db: Persistence;
const sql = (query: string, params: unknown[] = []) =>
  db.orm.em.getConnection().execute(query, params) as Promise<
    Array<Record<string, unknown>>
  >;

beforeAll(async () => {
  db = await openPersistence();
  instances = await startInstances(INSTANCES);
}, 120_000);
afterAll(async () => {
  await instances?.stop();
  await db?.close();
});

const bet = (
  wallet: { id: string; playerId: string },
  external: string,
  amount = '80.00',
): Json => ({
  providerId: 'provider-a',
  externalTransactionId: external,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount, currency: 'BRL' },
});

describe('three real processes against one database', () => {
  test('they are three distinct, live processes, each listening on its own port', async () => {
    const pids = instances.all.map((i) => i.pid);
    const ports = instances.all.map((i) => i.port);
    expect(new Set(pids).size).toBe(INSTANCES);
    expect(new Set(ports).size).toBe(INSTANCES);
    expect(pids).not.toContain(process.pid);
    for (const instance of instances.all) {
      expect(instance.process.exitCode).toBeNull();
      const response = await fetch(`${instance.url}/health/live`);
      expect(response.status).toBe(200);
    }
  });

  test('section 8 scenario with the two BETs of each round sent to DIFFERENT instances (100 rounds)', async () => {
    const ROUNDS = rounds(100);
    const client = new ProviderClient();
    const setup = new ProviderClient();
    const problems: string[] = [];
    const walletIds: string[] = [];
    const urls = instances.urls;

    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await setup.createWallet(
        urls[round % INSTANCES] as string,
        '100.00',
      );
      walletIds.push(wallet.id);
      const [first, second] = await Promise.all([
        client.submit(
          urls[round % INSTANCES] as string,
          bet(wallet, `mi-a-${Bun.randomUUIDv7()}`),
        ),
        client.submit(
          urls[(round + 1) % INSTANCES] as string,
          bet(wallet, `mi-b-${Bun.randomUUIDv7()}`),
        ),
      ]);
      const statuses = [first.status, second.status]
        .sort((a, b) => a - b)
        .join(',');
      const loser = [first, second].find((r) => r.status === 422);
      if (
        statuses !== '201,422' ||
        loser?.body?.failureCode !== 'INSUFFICIENT_FUNDS'
      ) {
        problems.push(
          `round ${round}: HTTP ${first.status},${second.status} ${first.text.slice(0, 80)} | ${second.text.slice(0, 80)}`,
        );
      }
      const facts = await walletFacts(sql, wallet.id);
      if (facts.balance !== '20.00' || facts.debits !== 1) {
        problems.push(
          `round ${round}: balance ${facts.balance}, ${facts.debits} DEBITs, expected 20.00 and 1`,
        );
      }
    }
    failIfAny(
      'multi-instance section 8',
      ROUNDS,
      [...problems, ...(await expectNoProblems(sql, walletIds))],
      {
        errors: instances.errorNames(),
      },
    );
    recordMetrics(`5a three instances, section 8 x${ROUNDS}`, {
      rounds: ROUNDS,
      requests: client.stats.requests,
      attempts: client.stats.attempts,
      status503: client.stats.status503,
      retries: client.stats.retries,
      perInstance: instances.urls.map((u) => client.perUrl.get(u) ?? 0),
      elapsedMs: client.elapsedMs(),
      invariants: 'OK',
    });
    for (const url of urls) {
      expect(client.perUrl.get(url) ?? 0).toBeGreaterThan(0);
    }
  }, 300_000);

  test('hot wallet: 290 mixed operations spread round-robin over the three processes', async () => {
    const client = new ProviderClient();
    const result = await runHotWallet({
      urls: instances.urls,
      sql,
      client,
      errorNames: () => instances.errorNames(),
    });
    recordMetrics('5b three instances, hot wallet', {
      requests: result.requests,
      attempts: client.stats.attempts,
      status503: client.stats.status503,
      retries: client.stats.retries,
      processed: result.processed,
      rejected: result.rejected,
      pending: result.pending,
      reasons503: instances.unavailableReasons(),
      jitter: client.jitter,
      perInstance: instances.urls.map((u) => client.perUrl.get(u) ?? 0),
      seed: result.seed,
      elapsedMs: client.elapsedMs(),
      invariants: 'OK',
    });
    expect(result.requests).toBe(290);
  }, 300_000);

  test('the same BET 50 times, copies spread over the three processes: one debit', async () => {
    const ROUNDS = rounds(10);
    const client = new ProviderClient();
    const setup = new ProviderClient();
    const problems: string[] = [];
    const walletIds: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      const wallet = await setup.createWallet(
        instances.urls[0] as string,
        '100.00',
      );
      walletIds.push(wallet.id);
      const input = bet(wallet, `mi-same-${Bun.randomUUIDv7()}`, '25.00');
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          client.submit(instances.urls[i % INSTANCES] as string, input),
        ),
      );
      const created = responses.filter((r) => r.status === 201).length;
      const replays = responses.filter((r) => r.status === 200).length;
      if (created !== 1 || replays !== 49) {
        problems.push(
          `round ${round}: ${created} x 201 and ${replays} x 200 (others: ${responses
            .filter((r) => ![200, 201].includes(r.status))
            .map((r) => `${r.status} ${r.text.slice(0, 60)}`)
            .join('; ')})`,
        );
      }
      const facts = await walletFacts(sql, wallet.id);
      if (facts.debits !== 1 || facts.balance !== '75.00') {
        problems.push(
          `round ${round}: ${facts.debits} DEBITs, balance ${facts.balance}, expected 1 and 75.00`,
        );
      }
    }
    failIfAny(
      'multi-instance same BET',
      ROUNDS,
      [...problems, ...(await expectNoProblems(sql, walletIds))],
      {
        errors: instances.errorNames(),
      },
    );
    recordMetrics('5c three instances, same BET x50', {
      rounds: ROUNDS,
      requests: client.stats.requests,
      attempts: client.stats.attempts,
      status503: client.stats.status503,
      retries: client.stats.retries,
      elapsedMs: client.elapsedMs(),
      invariants: 'OK',
    });
  }, 300_000);

  test('every process was still alive and answering at the end', async () => {
    for (const instance of instances.all) {
      expect(instance.process.exitCode).toBeNull();
      expect((await fetch(`${instance.url}/health/live`)).status).toBe(200);
    }
  });
});
