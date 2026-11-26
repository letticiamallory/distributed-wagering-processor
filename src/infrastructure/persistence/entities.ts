import { defineEntity, p } from '@mikro-orm/core';

// Mapeamento das tabelas (ADR-0003: defineEntity, sem decorators, fora do domínio). Estas
// "entidades" são só o formato da LINHA: o domínio nunca as enxerga, os repositórios
// convertem nos dois sentidos. Os nomes de coluna vêm da convenção (playerId -> player_id).
//
// NUMERIC vira string (p.decimal('string')): dinheiro nunca passa por number, nem aqui.
// O schema é escrito à mão nas migrations; estas definições não geram nem alteram tabelas.

export const WalletEntity = defineEntity({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balance: p.decimal('string'),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal('string'),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    // Escalar, não relação: queremos o id cru, sem o ORM carregar a transação referenciada.
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    balanceAfter: p.decimal('string').nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    correlationId: p.string(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export const LedgerEntryEntity = defineEntity({
  name: 'LedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal('string'),
    currency: p.string(),
    balanceBefore: p.decimal('string'),
    balanceAfter: p.decimal('string'),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});

export const InboxMessageEntity = defineEntity({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.string().nullable(),
  },
});

export const entities = [
  WalletEntity,
  WagerTransactionEntity,
  LedgerEntryEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
];
