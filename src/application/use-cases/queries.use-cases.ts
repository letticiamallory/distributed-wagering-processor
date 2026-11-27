import { z } from 'zod';
import { isReservedProviderId } from '../../domain/wager/wager-transaction.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { invalidPayload } from '../commands/command-parsing.js';
import {
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
import type { LedgerReader } from '../ports/ledger-reader.js';
import type { WalletReader } from '../ports/wallet-reader.js';
import type { WagerTransactionReader } from '../ports/wager-transaction-repository.js';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../queries/ledger-cursor.js';
import { parseTextParam, parseUuidParam } from '../queries/params.js';
import type {
  LedgerItemView,
  LedgerPage,
  TransactionView,
  WalletView,
} from '../queries/queries.js';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;

const limitSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^[0-9]{1,4}$/)
    .transform(Number),
]);

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }
  const parsed = limitSchema.safeParse(value);
  if (!parsed.success || parsed.data < 1 || parsed.data > MAX_LEDGER_LIMIT) {
    throw invalidPayload([
      {
        path: 'limit',
        message: `must be an integer from 1 to ${MAX_LEDGER_LIMIT}`,
      },
    ]);
  }
  return parsed.data;
}

export class GetWalletUseCase {
  constructor(private readonly wallets: WalletReader) {}

  async execute(input: { walletId: unknown }): Promise<WalletView> {
    const walletId = parseUuidParam(input.walletId, 'walletId');
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

function ledgerItem(entry: WalletLedgerEntry): LedgerItemView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

// O extrato, do lançamento mais novo para o mais antigo, em páginas por cursor opaco (veja
// ledger-cursor.ts). Lê `limit + 1`: se vier a mais, existe próxima página.
export class ListLedgerUseCase {
  constructor(
    private readonly wallets: WalletReader,
    private readonly ledger: LedgerReader,
  ) {}

  async execute(input: {
    walletId: unknown;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LedgerPage> {
    // 400 antes de 404: um parâmetro malformado nunca se esconde atrás de "não existe".
    const walletId = parseUuidParam(input.walletId, 'walletId');
    const limit = parseLimit(input.limit);
    const beforeVersion =
      input.cursor === undefined
        ? undefined
        : decodeLedgerCursor(
            typeof input.cursor === 'string' ? input.cursor : '',
            walletId,
          );

    if (!(await this.wallets.findById(walletId))) {
      throw new WalletNotFoundError(walletId);
    }
    const rows = await this.ledger.page(walletId, {
      ...(beforeVersion !== undefined && { beforeVersion }),
      limit: limit + 1,
    });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map(ledgerItem);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasNext && last
          ? encodeLedgerCursor(walletId, last.walletVersion)
          : null,
    };
  }
}

// O que a API mostra de uma transação: o que o provedor mandou e o que decidimos. Os campos
// internos (chave de idempotência, hash, correlationId, jogador) ficam de fora.
function transactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    ...(tx.balanceAfter && { balance: tx.balanceAfter.toJSON() }),
    ...(tx.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
    }),
    attempts: tx.attempts,
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt && { processedAt: tx.processedAt.toISOString() }),
  };
}

export class GetTransactionUseCase {
  constructor(private readonly transactions: WagerTransactionReader) {}

  async byId(transactionId: unknown): Promise<TransactionView> {
    const id = parseUuidParam(transactionId, 'transactionId');
    const found = await this.transactions.findById(id);
    if (!found) {
      throw new TransactionNotFoundError(id);
    }
    return transactionView(found);
  }

  async byProviderKey(
    providerId: unknown,
    externalTransactionId: unknown,
  ): Promise<TransactionView> {
    const provider = parseTextParam(providerId, 'providerId');
    const external = parseTextParam(
      externalTransactionId,
      'externalTransactionId',
    );
    // As transações do sistema (a OPENING) não são de provedor nenhum: a rota não as expõe.
    const found = isReservedProviderId(provider)
      ? undefined
      : await this.transactions.findByProviderAndExternalId(provider, external);
    if (!found) {
      throw new TransactionNotFoundError(`${provider}/${external}`);
    }
    return transactionView(found);
  }
}
