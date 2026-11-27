import { z } from 'zod';
import { FailureCode } from '../../domain/errors/failure-code.js';
import type { Money } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import {
  isReservedIdempotencyKey,
  isReservedProviderId,
} from '../../domain/wager/wager-transaction.js';
import { InvalidCommandError } from '../errors/application-errors.js';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  detailsOf,
  invalidPayload,
  moneyInput,
  text,
  toMoney,
  uuid,
} from './command-parsing.js';

// OPENING é interno: só nasce na criação da wallet, nunca por esta entrada.
const SUBMITTABLE_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

// Os mesmos campos de negócio chegam por HTTP (corpo) e por SQS (data). A chave de
// idempotência vem de fora: header no HTTP, data.idempotencyKey no SQS. Chaves
// desconhecidas são ignoradas (o zod as descarta), para um campo novo do provedor não
// derrubar o contrato.
const businessSchema = z.object({
  providerId: text().refine(
    (value) => !isReservedProviderId(value),
    'is reserved for the system',
  ),
  externalTransactionId: text(),
  playerId: uuid,
  walletId: uuid,
  roundId: text(),
  gameId: text(),
  kind: z.string(),
  money: moneyInput,
  referenceExternalTransactionId: text().optional(),
});

const idempotencyKeySchema = text(MAX_IDEMPOTENCY_KEY_LENGTH).refine(
  (value) => !isReservedIdempotencyKey(value),
  'is in a namespace reserved for the system',
);

// Ordem dos erros, para o provedor corrigir uma coisa por vez:
//   1. forma do payload e chave de idempotência  -> INVALID_PAYLOAD
//   2. tipo desconhecido, inclusive OPENING       -> UNSUPPORTED_KIND
//   3. REFUND/ROLLBACK sem referência             -> INVALID_PAYLOAD
//   4. valor inválido, ou zero fora de WIN/LOSS   -> INVALID_AMOUNT
export function parseProcessWagerTransactionCommand(
  input: unknown,
  idempotencyKey: unknown,
): ProcessWagerTransactionCommand {
  const business = businessSchema.safeParse(input);
  const key = idempotencyKeySchema.safeParse(idempotencyKey);

  const details = [
    ...(key.success
      ? []
      : detailsOf(key.error).map((d) => ({ ...d, path: 'Idempotency-Key' }))),
    ...(business.success ? [] : detailsOf(business.error)),
  ];
  if (!business.success || !key.success) {
    throw invalidPayload(details);
  }

  const data = business.data;
  if (!SUBMITTABLE_KINDS.includes(data.kind)) {
    const detail = { path: 'kind', message: `unsupported kind "${data.kind}"` };
    throw new InvalidCommandError(
      FailureCode.UnsupportedKind,
      `Unsupported kind: ${detail.message}`,
      [detail],
    );
  }
  const kind = data.kind as WagerTransactionKind;

  const reversal =
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback;
  // Uma BET não aponta para nada: uma referência nela é erro do provedor, não algo a ignorar.
  if (
    kind === WagerTransactionKind.Bet &&
    data.referenceExternalTransactionId !== undefined
  ) {
    throw invalidPayload([
      {
        path: 'referenceExternalTransactionId',
        message: 'a BET does not reference another transaction',
      },
    ]);
  }
  if (reversal && data.referenceExternalTransactionId === undefined) {
    throw invalidPayload([
      {
        path: 'referenceExternalTransactionId',
        message: `a ${kind} needs the reference it reverses`,
      },
    ]);
  }

  const money = toMoney(data.money, 'money');
  const mayBeZero =
    kind === WagerTransactionKind.Win || kind === WagerTransactionKind.Loss;
  if (money.isZero() && !mayBeZero) {
    const detail = {
      path: 'money.amount',
      message: `a ${kind} needs an amount greater than zero`,
    };
    throw new InvalidCommandError(
      FailureCode.InvalidAmount,
      `Invalid amount: ${detail.path}: ${detail.message}`,
      [detail],
    );
  }

  return {
    idempotencyKey: key.data,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind,
    money,
    ...(data.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    }),
  };
}
