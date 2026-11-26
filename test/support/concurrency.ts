import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';

// Ferramentas para testes que precisam de DUAS coisas acontecendo ao mesmo tempo (um portão
// no UnitOfWork, um lock mantido de propósito). Garantias de todas elas, para um teste nunca
// vazar para o vizinho:
//   1. todo portão é liberado num `finally`, mesmo se o teste falhar no meio;
//   2. toda promessa disparada é CAPTURADA (vira dado), então nunca existe rejeição sem dono;
//   3. se o caso de uso rejeitar ANTES de chegar ao portão, ninguém fica esperando por ele:
//      a falha aparece no teste que a causou.

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Transforma uma promessa em dado: resolve sempre, nunca é uma rejeição solta.
export function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export function valueOf<T>(outcome: Outcome<T>): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw outcome.error;
}

// Executa a função já capturando uma falha SÍNCRONA (que não passa por promessa) como dado.
const started = <T>(fn: () => Promise<T>): Promise<Outcome<T>> =>
  capture((async () => fn())());

// O UnitOfWork de verdade, mas parado na porta de `run`: o teste decide quando soltar.
export class GatedUnitOfWork extends UnitOfWork {
  readonly reached: Promise<void>;
  private markReached!: () => void;
  private open!: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly inner: UnitOfWork) {
    super();
    this.reached = new Promise((resolve) => (this.markReached = resolve));
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  // Idempotente, e pode vir antes de o portão ser alcançado.
  release(): void {
    this.open();
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.markReached();
    await this.gate;
    return this.inner.run(work);
  }
}

// A janela entre a checagem rápida e o lock: a requisição LENTA para na porta da transação,
// a etapa do MEIO roda (outra requisição que commita), e só então a lenta é solta.
export async function inTheWindow<R>(
  inner: UnitOfWork,
  start: (gated: GatedUnitOfWork) => Promise<R>,
  during: () => Promise<unknown>,
): Promise<R> {
  const gate = new GatedUnitOfWork(inner);
  const slow = started(() => start(gate));
  try {
    // Se a lenta falhar antes da porta, `slow` resolve (capturada) e ninguém fica esperando.
    await Promise.race([gate.reached, slow]);
    await during();
  } finally {
    gate.release();
  }
  return valueOf(await slow);
}

// Duas requisições disputando ao mesmo tempo: ambas passam pela checagem rápida (param na
// porta) e só então são soltas JUNTAS para disputar o lock. Devolve as duas como dados.
export async function simultaneously<A, B>(
  inner: UnitOfWork,
  startA: (gated: GatedUnitOfWork) => Promise<A>,
  startB: (gated: GatedUnitOfWork) => Promise<B>,
): Promise<[Outcome<A>, Outcome<B>]> {
  const gateA = new GatedUnitOfWork(inner);
  const gateB = new GatedUnitOfWork(inner);
  const a = started(() => startA(gateA));
  const b = started(() => startB(gateB));
  try {
    await Promise.all([
      Promise.race([gateA.reached, a]),
      Promise.race([gateB.reached, b]),
    ]);
  } finally {
    gateA.release();
    gateB.release();
  }
  return Promise.all([a, b]);
}

// Um lock mantido de propósito (por uma transação que fica aberta) enquanto a etapa do meio
// roda. `hold` recebe { locked, until }: chama `locked()` quando o lock foi obtido e espera
// `until` para terminar (e soltar). A etapa só roda depois do lock, e o holder é SEMPRE solto
// e aguardado, mesmo se a etapa falhar ou o holder falhar antes de travar.
export async function holding<T>(
  hold: (control: {
    locked: () => void;
    until: Promise<void>;
  }) => Promise<void>,
  during: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const until = new Promise<void>((resolve) => (release = resolve));
  let markLocked!: () => void;
  const lockedSignal = new Promise<void>((resolve) => (markLocked = resolve));
  let isLocked = false;

  const holder = started(() =>
    hold({
      locked: () => {
        isLocked = true;
        markLocked();
      },
      until,
    }),
  );

  let step: Outcome<T>;
  try {
    await Promise.race([lockedSignal, holder]);
    if (!isLocked) {
      valueOf(await holder); // se o holder falhou antes de travar, lança a falha dele
      throw new Error('the holder finished without ever locking');
    }
    step = await started(during);
  } catch (error) {
    step = { ok: false, error };
  }
  release();
  const held = await holder;
  const result = valueOf(step); // a falha da etapa tem prioridade
  valueOf(held);
  return result;
}
