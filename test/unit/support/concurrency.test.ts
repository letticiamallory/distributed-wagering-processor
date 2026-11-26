import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../support/assertions.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../../src/application/ports/unit-of-work.js';
import {
  GatedUnitOfWork,
  capture,
  holding,
  inTheWindow,
  simultaneously,
  valueOf,
} from '../../support/concurrency.js';

// Um UnitOfWork falso e instantâneo: o que se testa aqui é a MECÂNICA dos portões, não o banco.
class InstantUnitOfWork extends UnitOfWork {
  runs = 0;
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.runs++;
    return work({} as Repositories);
  }
}

describe('capture / valueOf', () => {
  test('capture turns a resolution and a rejection into plain data (never an unhandled rejection)', async () => {
    expect(await capture(Promise.resolve(7))).toEqual({ ok: true, value: 7 });
    const failure = new Error('x');
    expect(await capture(Promise.reject(failure))).toEqual({
      ok: false,
      error: failure,
    });
  });

  test('valueOf returns the value, or throws the original error', () => {
    expect(valueOf({ ok: true, value: 3 })).toBe(3);
    const failure = new Error('boom');
    expect(() => valueOf({ ok: false, error: failure })).toThrow(failure);
  });
});

describe('GatedUnitOfWork', () => {
  test('stops at the door until released, then runs the work', async () => {
    const inner = new InstantUnitOfWork();
    const gate = new GatedUnitOfWork(inner);
    let finished = false;
    const running = gate.run(async () => {
      finished = true;
      return 'done';
    });
    await gate.reached;
    await Bun.sleep(30);
    expect(finished).toBe(false);
    expect(inner.runs).toBe(0);

    gate.release();
    expect(await running).toBe('done');
    expect(inner.runs).toBe(1);
  });

  test('release is idempotent and can come BEFORE the door is reached', async () => {
    const gate = new GatedUnitOfWork(new InstantUnitOfWork());
    gate.release();
    gate.release();
    expect(await gate.run(async () => 1)).toBe(1);
  });
});

describe('inTheWindow', () => {
  test('runs the middle step while the slow request waits at the door, and returns the slow result', async () => {
    const order: string[] = [];
    const result = await inTheWindow(
      new InstantUnitOfWork(),
      (uow) =>
        uow.run(async () => {
          order.push('slow runs');
          return 'slow';
        }),
      async () => {
        order.push('middle runs');
      },
    );
    expect(result).toBe('slow');
    expect(order).toEqual(['middle runs', 'slow runs']); // o do meio passou primeiro
  });

  test('if the slow request fails BEFORE reaching the door, it does not hang and the failure is its own', async () => {
    const failure = new Error('failed before the gate');
    const run = inTheWindow(
      new InstantUnitOfWork(),
      () => Promise.reject(failure), // nunca chega ao portão
      async () => undefined,
    );
    expect(await rejectionOf(run)).toBe(failure);
  });

  test('if the middle step throws, the gate is still released and the slow request is not left hanging', async () => {
    const inner = new InstantUnitOfWork();
    let slowSettled = false;
    const middleFailure = new Error('middle failed');
    const run = inTheWindow(
      inner,
      async (uow) => {
        try {
          return await uow.run(async () => 'slow');
        } finally {
          slowSettled = true;
        }
      },
      async () => {
        throw middleFailure;
      },
    );
    expect(await rejectionOf(run)).toBe(middleFailure);
    await Bun.sleep(30);
    expect(slowSettled).toBe(true); // a lenta foi liberada e terminou, não ficou solta
    expect(inner.runs).toBe(1);
  });
});

describe('simultaneously', () => {
  test('releases both only after BOTH reached the door, and returns both outcomes', async () => {
    const inner = new InstantUnitOfWork();
    const started: string[] = [];
    let startedWhenTheFirstWorkRan = -1;
    const work = (name: string) => async () => {
      if (startedWhenTheFirstWorkRan < 0) {
        startedWhenTheFirstWorkRan = started.length;
      }
      return name;
    };
    const [a, b] = await simultaneously(
      inner,
      (uow) => {
        started.push('a');
        return uow.run(work('A'));
      },
      (uow) => {
        started.push('b');
        return uow.run(work('B'));
      },
    );
    expect(valueOf(a)).toBe('A');
    expect(valueOf(b)).toBe('B');
    expect(inner.runs).toBe(2);
    expect(startedWhenTheFirstWorkRan).toBe(2); // o primeiro trabalho só rodou com os DOIS no portão
  });

  test('a rejection of one side is data, not a thrown error, and does not hang the other side', async () => {
    const failure = new Error('A failed at the work');
    const [a, b] = await simultaneously(
      new InstantUnitOfWork(),
      (uow) =>
        uow.run(async () => {
          throw failure;
        }),
      (uow) => uow.run(async () => 'B'),
    );
    expect(a).toEqual({ ok: false, error: failure });
    expect(valueOf(b)).toBe('B');
  });

  test('if one side fails BEFORE reaching the door, the other is still released and finishes', async () => {
    const early = new Error('rejected before the gate');
    const [a, b] = await simultaneously(
      new InstantUnitOfWork(),
      () => Promise.reject(early),
      (uow) => uow.run(async () => 'B'),
    );
    expect(a).toEqual({ ok: false, error: early });
    expect(valueOf(b)).toBe('B');
  });
});

describe('holding (a lock kept on purpose while the middle step runs)', () => {
  test('the middle step runs only after the holder says it LOCKED, and the holder is ALWAYS released, even if the step throws', async () => {
    const events: string[] = [];
    const failure = new Error('step failed');
    expect(
      await rejectionOf(
        holding(
          async ({ locked, until }) => {
            await Bun.sleep(30);
            events.push('locked');
            locked();
            await until;
            events.push('released');
          },
          async () => {
            events.push('step');
            throw failure;
          },
        ),
      ),
    ).toBe(failure);
    expect(events).toEqual(['locked', 'step', 'released']);
  });

  test('returns what the middle step returns', async () => {
    const result = await holding(
      async ({ locked, until }) => {
        locked();
        await until;
      },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  test('if the holder fails before it locked, the failure surfaces and the step never runs (no hang)', async () => {
    const failure = new Error('could not lock');
    let stepRan = false;
    expect(
      await rejectionOf(
        holding(
          async () => {
            throw failure;
          },
          async () => {
            stepRan = true;
          },
        ),
      ),
    ).toBe(failure);
    expect(stepRan).toBe(false);
  });

  test('if the holder fails AFTER the step, that failure is not lost either', async () => {
    const failure = new Error('holder blew up on release');
    expect(
      await rejectionOf(
        holding(
          async ({ locked, until }) => {
            locked();
            await until;
            throw failure;
          },
          async () => 'ok',
        ),
      ),
    ).toBe(failure);
  });
});
