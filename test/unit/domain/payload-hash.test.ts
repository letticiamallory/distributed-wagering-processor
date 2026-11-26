import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PAYLOAD_HASH_PATTERN } from '../../../src/domain/messaging/payload-hash.js';
import { Money } from '../../../src/domain/money/money.js';
import {
  canonicalPayloadJson,
  computePayloadHash,
  type PayloadFields,
} from '../../../src/domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction.js';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

function fields(overrides: Partial<PayloadFields> = {}): PayloadFields {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: money('25.00'),
    ...overrides,
  };
}

// Vetores calculados fora da implementação (node:crypto direto sobre o texto), para o
// algoritmo não poder mudar sem os testes perceberem.
const CANONICAL_BET =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","roundId":"round-1","walletId":"wallet-1"}';
const HASH_BET =
  '1c5bd6a0bbfcf96205e31f62df96680cc856108aabe2a407483927fc72077792';
const CANONICAL_REFUND =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":"ext-bet","roundId":"round-1","walletId":"wallet-1"}';
const HASH_REFUND =
  'fbe5903f891a07d70ade060e3f13c2cab26c350f9ac4e884af7d07d0029903a2';

describe('canonical payload and algorithm', () => {
  test('the canonical JSON has sorted keys, no spaces, and nested money', () => {
    expect(canonicalPayloadJson(fields())).toBe(CANONICAL_BET);
  });

  test('the hash is the SHA-256 of that text (golden vector)', () => {
    expect(computePayloadHash(fields())).toBe(HASH_BET);
    expect(HASH_BET).toBe(
      createHash('sha256').update(CANONICAL_BET).digest('hex'),
    );
  });

  test('with a reference, the key enters in its alphabetical place', () => {
    const f = fields({ referenceExternalTransactionId: 'ext-bet' });
    expect(canonicalPayloadJson(f)).toBe(CANONICAL_REFUND);
    expect(computePayloadHash(f)).toBe(HASH_REFUND);
  });

  test('is 64 lowercase hex characters, the format the schema and the domain accept', () => {
    const hash = computePayloadHash(fields());
    expect(PAYLOAD_HASH_PATTERN.test(hash)).toBe(true);
    expect(() =>
      WagerTransaction.create({
        id: 'tx-1',
        idempotencyKey: 'provider-a:transaction-123',
        payloadHash: hash,
        correlationId: 'corr-1',
        createdAt: new Date('2026-11-25T12:00:00.000Z'),
        ...fields(),
      }),
    ).not.toThrow();
  });
});

describe('what does not change the hash', () => {
  test('keys in another order give the same hash', () => {
    const reversed = Object.fromEntries(
      Object.entries(fields()).reverse(),
    ) as unknown as PayloadFields;
    expect(Object.keys(reversed)[0]).toBe('money');
    expect(computePayloadHash(reversed)).toBe(computePayloadHash(fields()));
  });

  test('a missing reference and an undefined one are the same payload', () => {
    const withUndefined = fields({ referenceExternalTransactionId: undefined });
    expect(computePayloadHash(withUndefined)).toBe(
      computePayloadHash(fields()),
    );
    expect(canonicalPayloadJson(withUndefined)).not.toContain('reference');
  });

  test('transport fields are ignored: idempotencyKey, messageId and the rest', () => {
    const withTransport = {
      ...fields(),
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'sqs-msg-1',
      correlationId: 'corr-9',
      receivedAt: new Date(),
      headers: { 'idempotency-key': 'whatever' },
    };
    expect(computePayloadHash(withTransport)).toBe(
      computePayloadHash(fields()),
    );
    expect(canonicalPayloadJson(withTransport)).toBe(CANONICAL_BET);
  });

  test('a different idempotencyKey or messageId does not turn the same operation into another', () => {
    const a = { ...fields(), idempotencyKey: 'key-1', messageId: 'm-1' };
    const b = { ...fields(), idempotencyKey: 'key-2', messageId: 'm-2' };
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });

  test('two Money instances with the same value are the same payload', () => {
    expect(computePayloadHash(fields({ money: money('25.00') }))).toBe(
      computePayloadHash(fields({ money: money('25.00') })),
    );
  });
});

describe('what changes the hash', () => {
  test('one cent more changes it', () => {
    expect(computePayloadHash(fields({ money: money('25.01') }))).not.toBe(
      computePayloadHash(fields()),
    );
  });

  test('another currency changes it', () => {
    expect(
      computePayloadHash(fields({ money: money('25.00', 'USD') })),
    ).not.toBe(computePayloadHash(fields()));
  });

  test.each<[string, Partial<PayloadFields>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'x' }],
  ])('%s changes it', (_field, overrides) => {
    expect(computePayloadHash(fields(overrides))).not.toBe(
      computePayloadHash(fields()),
    );
  });

  test('the reference value matters, not only its presence', () => {
    const a = fields({ referenceExternalTransactionId: 'ext-1' });
    const b = fields({ referenceExternalTransactionId: 'ext-2' });
    expect(computePayloadHash(a)).not.toBe(computePayloadHash(b));
  });

  test('swapping two values between fields changes it (the names are part of the hash)', () => {
    const swapped = fields({ playerId: 'wallet-1', walletId: 'player-1' });
    expect(computePayloadHash(swapped)).not.toBe(computePayloadHash(fields()));
  });

  test('quotes and commas in a value cannot forge another payload', () => {
    const tricky = fields({ providerId: 'provider-a","gameId":"x' });
    expect(computePayloadHash(tricky)).not.toBe(computePayloadHash(fields()));
    expect(canonicalPayloadJson(tricky)).toContain('\\"');
  });
});

describe('the same operation arriving by HTTP and by SQS', () => {
  // POST /wagering/transactions: o Idempotency-Key vem no header, o corpo tem money aninhado.
  const http = {
    headers: { 'idempotency-key': 'provider-a:transaction-123' },
    body: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  };

  // Mensagem do SQS: o messageId é do transporte, e o corpo é uma string JSON com as chaves
  // em outra ordem e a chave de idempotência dentro.
  const sqs = {
    MessageId: '5fea7756-0ea4-451a-a703-a558b933e274',
    Body: JSON.stringify({
      idempotencyKey: 'provider-a:transaction-123',
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    }),
  };

  interface BusinessBody {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  }

  // O mapeamento é da camada de aplicação; aqui só mostramos que, depois dele, o hash coincide.
  const toFields = (b: BusinessBody): PayloadFields => ({
    providerId: b.providerId,
    externalTransactionId: b.externalTransactionId,
    playerId: b.playerId,
    walletId: b.walletId,
    roundId: b.roundId,
    gameId: b.gameId,
    kind: b.kind,
    money: Money.from(b.money),
    referenceExternalTransactionId: b.referenceExternalTransactionId,
  });

  test('both channels produce the same hash', () => {
    const fromHttp = toFields(http.body as BusinessBody);
    const fromSqs = toFields(JSON.parse(sqs.Body) as BusinessBody);
    expect(computePayloadHash(fromHttp)).toBe(computePayloadHash(fromSqs));
    expect(computePayloadHash(fromHttp)).toBe(HASH_BET);
  });

  test('and so does a REFUND with a reference', () => {
    const body = {
      ...http.body,
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-bet',
    } as BusinessBody;
    const viaSqs = JSON.parse(JSON.stringify(body)) as BusinessBody;
    expect(computePayloadHash(toFields(body))).toBe(
      computePayloadHash(toFields(viaSqs)),
    );
  });

  test('a body with extra transport keys still gives the same hash', () => {
    const sqsBody = JSON.parse(sqs.Body) as BusinessBody & {
      idempotencyKey: string;
    };
    const withTransport = { ...sqsBody, ...toFields(sqsBody) };
    expect(computePayloadHash(withTransport as unknown as PayloadFields)).toBe(
      HASH_BET,
    );
  });

  test('a cent of difference between channels is a different payload', () => {
    const tampered = JSON.parse(sqs.Body) as BusinessBody;
    tampered.money.amount = '25.01';
    expect(computePayloadHash(toFields(tampered))).not.toBe(
      computePayloadHash(toFields(http.body as BusinessBody)),
    );
  });
});
