import { describe, expect, test } from 'bun:test';
import {
  MIGRATE_CONNECT_DEADLINE_MS,
  connectWithRetry,
} from '../../src/infrastructure/persistence/connect-with-retry.js';

// N-2 da segunda avaliação: num host lento, a primeira conexão do `migrate` passou do prazo e o
// `docker compose up` inteiro falhou. Agora o migrate tenta de novo, com backoff, até um prazo total,
// e registra cada tentativa.
type Log = Record<string, unknown>;

function harness(failures: number) {
  const logs: Log[] = [];
  const waits: number[] = [];
  let now = 0;
  let calls = 0;
  const run = (deadlineMs = 60_000) =>
    connectWithRetry(
      async () => {
        calls++;
        if (calls <= failures) throw new Error(`connection timeout #${calls}`);
        return 'connected';
      },
      {
        deadlineMs,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        log: (entry) => logs.push(entry),
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        now: () => now,
      },
    );
  return { run, logs, waits, calls: () => calls };
}

describe('connectWithRetry (the migrate tolerates a slow Postgres)', () => {
  test('fails the first 3 attempts, connects on the 4th, and logs every attempt', async () => {
    const h = harness(3);
    expect(await h.run()).toBe('connected');
    expect(h.calls()).toBe(4);
    const failed = h.logs.filter(
      (l) => l.event === 'db_connect_attempt_failed',
    );
    expect(failed.map((l) => l.attempt)).toEqual([1, 2, 3]);
    expect(failed[0]).toMatchObject({
      level: 'warn',
      error: 'connection timeout #1',
    });
    expect(h.logs.at(-1)).toMatchObject({ event: 'db_connected', attempt: 4 });
  });

  test('backs off exponentially, capped', async () => {
    const h = harness(6);
    await h.run();
    expect(h.waits).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  test('gives up after the total deadline with the last error', async () => {
    const h = harness(1_000);
    await expect(h.run(10_000)).rejects.toThrow(/connection timeout/);
    expect(h.logs.at(-1)).toMatchObject({
      event: 'db_connect_gave_up',
      level: 'error',
    });
    expect(h.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });

  test('the default total deadline of the migrate is generous (at least 2 minutes)', () => {
    expect(MIGRATE_CONNECT_DEADLINE_MS).toBeGreaterThanOrEqual(120_000);
  });
});
