import { expect } from 'bun:test';
import { Clock } from '../../src/application/ports/clock.js';
import type { IdGenerator } from '../../src/application/ports/id-generator.js';
import type { InboxReader } from '../../src/application/ports/inbox-repository.js';
import {
  UnitOfWork,
  type Repositories,
} from '../../src/application/ports/unit-of-work.js';
import type { WagerTransactionReader } from '../../src/application/ports/wager-transaction-repository.js';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerContext,
  type ProcessWagerResult,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import {
  ResolvePendingReferenceUseCase,
  type ResolvePendingResult,
} from '../../src/application/use-cases/resolve-pending-reference.use-case.js';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import type { Persistence } from './persistence.js';
import { uuid } from './persistence.js';

export type Row = Record<string, unknown>;

// O banco de teste PERSISTE entre execuções: um id externo fixo ("ext-bet-1") colidiria com o da
// execução anterior (a BET dele já existiria). Este sufixo é novo a cada processo, então cada
// execução enxerga ids que ninguém usou antes, e o mesmo nome continua igual DENTRO da execução.
const RUN = Math.random().toString(36).slice(2, 10);
export const ext = (name: string): string => `ext-${name}-${RUN}`;

// Relógio que o teste move: backoff e "acordar" dependem do tempo.
export class MutableClock extends Clock {
  private current: Date;
  constructor(start: Date) {
    super();
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// Conta quantas transações foram abertas (um "rerun" do caso de uso abre outra).
export class CountingUnitOfWork extends UnitOfWork {
  runs = 0;
  constructor(private readonly inner: UnitOfWork) {
    super();
  }
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    this.runs++;
    return this.inner.run(work);
  }
}

// O UnitOfWork de verdade, com os repositórios trocados: injeta falhas ou desliga uma checagem.
export class UnitOfWorkWith extends UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly patch: (r: Repositories) => Repositories,
  ) {
    super();
  }
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run((r) => work(this.patch(r)));
  }
}

// Falha SEMPRE com o erro que a fábrica devolver, sem tocar no banco (conta as chamadas).
export class AlwaysFailingUnitOfWork extends UnitOfWork {
  runs = 0;
  constructor(private readonly failure: () => Error) {
    super();
  }
  run<T>(): Promise<T> {
    this.runs++;
    return Promise.reject(this.failure());
  }
}

export interface Wallet {
  id: string;
  playerId: string;
}

export interface ScenarioOptions {
  schedule?: PendingReferenceSchedule;
  start?: Date;
}

// Tudo que os testes de transação precisam, ligado ao banco real e a UM relógio e UMA política de
// tentativas compartilhados (assim o teste controla o tempo e o limite de tentativas).
export function createScenario(
  db: () => Persistence,
  options: ScenarioOptions = {},
) {
  const clock = new MutableClock(
    options.start ?? new Date('2026-11-27T09:00:00.000Z'),
  );
  const schedule = options.schedule ?? new PendingReferenceSchedule();

  const sql = (query: string, params: unknown[] = []) =>
    db().orm.em.getConnection().execute(query, params) as Promise<Row[]>;
  const one = async (query: string, params: unknown[] = []): Promise<Row> => {
    const rows = await sql(query, params);
    expect(rows).toHaveLength(1);
    return rows[0] as Row;
  };
  const count = async (table: string, where: string, params: unknown[]) =>
    Number(
      (
        await one(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
          params,
        )
      ).n,
    );

  async function walletWith(
    balance = '100.00',
    currency = 'BRL',
  ): Promise<Wallet> {
    const playerId = uuid();
    const created = await new CreateWalletUseCase(
      db().uow,
      clock,
      new UuidV7Generator(),
    ).execute(
      { playerId, initialBalance: { amount: balance, currency } },
      { correlationId: 'setup' },
    );
    return { id: created.id, playerId };
  }

  let sequence = 0;
  const nextExternal = () => `ext-${Date.now()}-${++sequence}`;

  const body = (wallet: Wallet, overrides: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: nextExternal(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  });

  const keyOf = (b: Record<string, unknown>) =>
    `${String(b.providerId)}:${String(b.externalTransactionId)}`;

  const build = (
    overrides: {
      uow?: UnitOfWork;
      reader?: WagerTransactionReader;
      inboxReader?: InboxReader;
      ids?: IdGenerator;
      schedule?: PendingReferenceSchedule;
    } = {},
  ) =>
    new ProcessWagerTransactionUseCase(
      overrides.uow ?? db().uow,
      overrides.reader ?? db().reader,
      overrides.inboxReader ?? db().inboxReader,
      clock,
      overrides.ids ?? new UuidV7Generator(),
      overrides.schedule ?? schedule,
    );

  const submit = (
    input: Record<string, unknown>,
    context: Partial<ProcessWagerContext> = {},
    useCase: ProcessWagerTransactionUseCase = build(),
  ): Promise<ProcessWagerResult> =>
    useCase.execute(input, {
      idempotencyKey: keyOf(input),
      correlationId: 'corr-scenario',
      ...context,
    });

  const resolver = (
    overrides: {
      uow?: UnitOfWork;
      reader?: WagerTransactionReader;
      ids?: IdGenerator;
      schedule?: PendingReferenceSchedule;
    } = {},
  ) =>
    new ResolvePendingReferenceUseCase(
      overrides.uow ?? db().uow,
      overrides.reader ?? db().reader,
      clock,
      overrides.ids ?? new UuidV7Generator(),
      overrides.schedule ?? schedule,
    );

  const resolve = (transactionId: string, useCase = resolver()) =>
    useCase.execute({ transactionId }, { correlationId: 'corr-resolver' });

  // Resolve e exige que a transação tenha ficado em estado final (já estreitando o tipo).
  const resolveFinal = async (transactionId: string, useCase = resolver()) => {
    const result = await resolve(transactionId, useCase);
    expect(result.outcome).toBe('RESOLVED');
    return result as Extract<ResolvePendingResult, { outcome: 'RESOLVED' }>;
  };

  const walletRow = (walletId: string) =>
    one('SELECT balance, version FROM wallets WHERE id = ?', [walletId]);
  const txRow = (id: string) =>
    one('SELECT * FROM wager_transactions WHERE id = ?', [id]);
  const balanceOf = async (wallet: Wallet) =>
    String((await walletRow(wallet.id)).balance);
  const movements = (walletId: string) =>
    sql(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > 1 ORDER BY wallet_version',
      [walletId],
    );
  const directions = async (walletId: string) =>
    (await movements(walletId)).map((e) => String(e.direction));
  const externalOf = async (transactionId: string) =>
    String((await txRow(transactionId)).external_transaction_id);
  // Os eventos que dizem respeito a UMA transação (de qualquer wallet), ordenados por nome.
  const eventTypesOf = async (transactionId: string) =>
    (
      await sql(
        `SELECT event_type FROM outbox_messages
          WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type`,
        [transactionId],
      )
    ).map((r) => String(r.event_type));

  async function placeBet(
    wallet: Wallet,
    amount = '25.00',
    externalId?: string,
  ) {
    const input = body(wallet, {
      money: { amount, currency: 'BRL' },
      ...(externalId && { externalTransactionId: externalId }),
    });
    const result = await submit(input);
    return { ...result, external: String(input.externalTransactionId) };
  }

  const winBody = (
    wallet: Wallet,
    betExternal: string,
    amount = '80.00',
    overrides: Record<string, unknown> = {},
  ) =>
    body(wallet, {
      kind: 'WIN',
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: betExternal,
      ...overrides,
    });

  const reversalBody = (
    wallet: Wallet,
    kind: 'REFUND' | 'ROLLBACK',
    referenceExternal: string,
    amount = '25.00',
    overrides: Record<string, unknown> = {},
  ) =>
    body(wallet, {
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: referenceExternal,
      ...overrides,
    });

  // Envia uma transação que aponta para uma referência que (ainda) não existe, e devolve o
  // resultado junto com o id externo dela (para mandar a referência DEPOIS, com esse mesmo id).
  async function pend(
    wallet: Wallet,
    kind: 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
    referenceExternal: string,
    amount?: string,
    overrides: Record<string, unknown> = {},
  ) {
    const money =
      amount ?? (kind === 'LOSS' ? '0.00' : kind === 'WIN' ? '80.00' : '25.00');
    const input = body(wallet, {
      kind,
      money: { amount: money, currency: 'BRL' },
      referenceExternalTransactionId: referenceExternal,
      ...overrides,
    });
    const result = await submit(input);
    return { ...result, external: String(input.externalTransactionId) };
  }

  return {
    clock,
    schedule,
    sql,
    one,
    count,
    walletWith,
    nextExternal,
    body,
    keyOf,
    build,
    submit,
    resolver,
    resolve,
    resolveFinal,
    walletRow,
    txRow,
    balanceOf,
    movements,
    directions,
    externalOf,
    eventTypesOf,
    placeBet,
    winBody,
    reversalBody,
    pend,
  };
}

export type Scenario = ReturnType<typeof createScenario>;

// Espera (até 5 s) alguma sessão ficar BLOQUEADA esperando um lock do banco: a prova de que a
// requisição disputada chegou ao ponto da disputa, sem depender de sorte nem de sleep fixo.
export async function waitUntilSomeoneIsBlocked(
  sql: (query: string, params?: unknown[]) => Promise<Row[]>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number((rows[0] as Row).n) > 0) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error('nobody got blocked on a lock within 5 seconds');
}
