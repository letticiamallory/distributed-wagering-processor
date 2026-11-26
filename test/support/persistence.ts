import { afterAll, beforeAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories } from '../../src/application/ports/unit-of-work.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager/wager-transaction.js';
import config from '../../src/infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import type { MetricsPort } from '../../src/application/ports/metrics.port.js';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.js';
import { MikroOrmInboxReader } from '../../src/infrastructure/persistence/repositories/mikro-orm-inbox.reader.js';
import { MikroOrmWagerTransactionReader } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.reader.js';
import { ensureTestDatabase } from './database.js';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
export const T0 = new Date('2026-11-25T12:00:00.000Z');
export const T1 = new Date('2026-11-25T12:00:05.000Z');
export const T2 = new Date('2026-11-25T12:01:00.000Z');
export const HASH = 'a'.repeat(64);

export interface PersistenceOptions {
  metrics?: MetricsPort;
  lockTimeoutMs?: number;
  pool?: { min?: number; max?: number };
  connectionTimeoutMillis?: number;
  clientUrl?: string;
}

export interface Persistence {
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  reader: MikroOrmWagerTransactionReader;
  inboxReader: MikroOrmInboxReader;
  // A outbox fora de transação (só as consultas de observabilidade, como stats()).
  outbox: MikroOrmOutboxRepository;
  // Todo SQL que o MikroORM enviou, na ordem (para mostrar o FOR UPDATE de verdade).
  queries: string[];
  close(): Promise<void>;
}

export async function openPersistence(
  options: PersistenceOptions = {},
): Promise<Persistence> {
  await ensureTestDatabase();
  const queries: string[] = [];
  const orm = await MikroORM.init({
    ...config,
    ...(options.clientUrl && { clientUrl: options.clientUrl }),
    ...(options.pool && { pool: options.pool }),
    ...(options.connectionTimeoutMillis !== undefined && {
      driverOptions: {
        connectionTimeoutMillis: options.connectionTimeoutMillis,
      },
    }),
    debug: ['query'],
    logger: (message: string) => queries.push(message),
  });
  return {
    orm,
    uow: new MikroOrmUnitOfWork(orm.em, {
      lockTimeoutMs: options.lockTimeoutMs ?? 5_000,
      ...(options.metrics && { metrics: options.metrics }),
    }),
    reader: new MikroOrmWagerTransactionReader(orm.em, options.metrics),
    inboxReader: new MikroOrmInboxReader(orm.em, options.metrics),
    outbox: new MikroOrmOutboxRepository(orm.em),
    queries,
    close: () => orm.close(),
  };
}

// Abre a persistência antes dos testes do arquivo e fecha no fim.
export function usePersistence(
  options: PersistenceOptions = {},
): () => Persistence {
  let current: Persistence;
  beforeAll(async () => {
    current = await openPersistence(options);
  }, 60_000);
  afterAll(async () => {
    await current.close();
  });
  return () => current;
}

let counter = 0;
export const uuid = (): string => Bun.randomUUIDv7();
export const nextExternalId = (): string => `ext-${Date.now()}-${++counter}`;

export function newWallet(
  balance = '100.00',
  overrides: { playerId?: string; id?: string } = {},
): Wallet {
  return Wallet.open({
    id: overrides.id ?? uuid(),
    playerId: overrides.playerId ?? uuid(),
    initialBalance: brl(balance),
    opening: { transactionId: uuid(), entryId: uuid() },
    at: T0,
  }).wallet;
}

// Uma transação PENDING pronta para decidir o destino (markProcessed, reject...).
export function newTransaction(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId =
    overrides.externalTransactionId ?? nextExternalId();
  return WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
    createdAt: T0,
    ...overrides,
  });
}

// Grava a wallet (que as FKs exigem) e devolve o que for preciso para o teste continuar.
export async function persistWallet(
  uow: MikroOrmUnitOfWork,
  wallet: Wallet,
): Promise<void> {
  await uow.run(async (r: Repositories) => {
    await r.wallets.insert(wallet);
  });
}
