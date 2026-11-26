import { createHash } from 'node:crypto';
import type { Money } from '../money/money.js';
import type { WagerTransactionKind } from './wager-transaction-kind.js';

// Só os campos de NEGÓCIO. A chave de idempotência, o messageId, o correlationId e qualquer
// outro metadado de transporte ficam de fora: a mesma operação pode chegar por HTTP ou por
// SQS e precisa dar o mesmo hash.
export interface PayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

// Algoritmo (documentado no ADR-0008):
//   1. escolhe os campos de negócio acima (o resto do objeto é ignorado);
//   2. monta um JSON com as chaves em ordem alfabética, sem espaços, com `money` aninhado
//      como { amount, currency } e `referenceExternalTransactionId` só quando existe;
//   3. hash = SHA-256 desse texto em UTF-8, em hexadecimal minúsculo (64 caracteres).
// O valor entra como Money (já normalizado em 2 casas), então "25.0" nunca chega aqui.
export function canonicalPayloadJson(fields: PayloadFields): string {
  const { amount, currency } = fields.money.toJSON();
  // As chaves são escritas já em ordem alfabética, e o JSON.stringify as mantém assim.
  const canonical = {
    externalTransactionId: fields.externalTransactionId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount, currency },
    playerId: fields.playerId,
    providerId: fields.providerId,
    ...(fields.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
    roundId: fields.roundId,
    walletId: fields.walletId,
  };
  return JSON.stringify(canonical);
}

export function computePayloadHash(fields: PayloadFields): string {
  return createHash('sha256')
    .update(canonicalPayloadJson(fields), 'utf8')
    .digest('hex');
}
