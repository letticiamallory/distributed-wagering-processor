import { describe, expect, test } from 'bun:test';
import { DependencyUnavailableError } from '../../src/application/errors/application-errors.js';
import { MetricsPort } from '../../src/application/ports/metrics.port.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { holding } from '../support/concurrency.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// D7 do avaliador: "conflitos de lock" só apareciam quando o lock ESTOURAVA (lock_timeout). A
// disputa em si, que é o sinal de uma wallet quente antes do 503, não era medida. Agora o
// SELECT ... FOR UPDATE da wallet observa quanto esperou, em wallet_lock_wait_seconds{outcome}.
const db = usePersistence();
const s = createScenario(db);

class Recording extends MetricsPort {
  observed: Array<{
    name: string;
    labels: Record<string, string>;
    seconds: number;
  }> = [];
  increment(): void {}
  set(): void {}
  observe(name: string, labels: Record<string, string>, seconds: number): void {
    this.observed.push({ name, labels, seconds });
  }
}

const lockWaits = (m: Recording) =>
  m.observed.filter((o) => o.name === 'wallet_lock_wait_seconds');

describe('wallet_lock_wait_seconds measures the wait for the wallet lock', () => {
  test('uncontended: one observation, outcome acquired, close to zero', async () => {
    const wallet = await s.walletWith('100.00');
    const metrics = new Recording();
    const uow = new MikroOrmUnitOfWork(db().orm.em, {
      lockTimeoutMs: 5_000,
      metrics,
    });
    await uow.run((r) => r.wallets.lockById(wallet.id));
    const [wait] = lockWaits(metrics);
    expect(wait?.labels).toEqual({ outcome: 'acquired' });
    expect(wait?.seconds).toBeLessThan(0.25);
  });

  test('contended: the waiter observes the time the holder kept the lock', async () => {
    const wallet = await s.walletWith('100.00');
    const metrics = new Recording();
    const uow = new MikroOrmUnitOfWork(db().orm.em, {
      lockTimeoutMs: 5_000,
      metrics,
    });
    // A etapa começa a esperar o lock e dura 400 ms; só então `holding` solta o lock, e a espera
    // termina. Ela é aguardada depois.
    let waiting: Promise<unknown> = Promise.resolve();
    await holding(
      ({ locked, until }) =>
        db().uow.run(async (r) => {
          await r.wallets.lockById(wallet.id);
          locked();
          await until;
        }),
      async () => {
        waiting = uow.run((r) => r.wallets.lockById(wallet.id));
        await Bun.sleep(400);
      },
    );
    await waiting;
    const [wait] = lockWaits(metrics);
    expect(wait?.labels).toEqual({ outcome: 'acquired' });
    expect(wait?.seconds).toBeGreaterThanOrEqual(0.3);
  });

  test('lock_timeout: outcome timeout, and the error is still the transient 503', async () => {
    const wallet = await s.walletWith('100.00');
    const metrics = new Recording();
    const uow = new MikroOrmUnitOfWork(db().orm.em, {
      lockTimeoutMs: 200,
      metrics,
    });
    const error = await holding(
      ({ locked, until }) =>
        db().uow.run(async (r) => {
          await r.wallets.lockById(wallet.id);
          locked();
          await until;
        }),
      () =>
        uow.run((r) => r.wallets.lockById(wallet.id)).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(DependencyUnavailableError);
    const [wait] = lockWaits(metrics);
    expect(wait?.labels).toEqual({ outcome: 'timeout' });
    expect(wait?.seconds).toBeGreaterThanOrEqual(0.15);
  });
});
