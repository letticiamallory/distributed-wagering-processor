import { describe, expect, test } from 'bun:test';
import {
  InvalidCommandError,
  PermanentDataError,
} from '../../../src/application/errors/application-errors.js';
import { parseProcessWagerTransactionCommand } from '../../../src/application/commands/process-wager-transaction.command.js';
import { parseCreateWalletCommand } from '../../../src/application/commands/create-wallet.command.js';
import { ConsumerRetryPolicy } from '../../../src/application/messaging/consumer-retry-policy.js';
import { WagerMessageHandler } from '../../../src/application/messaging/wager-message-handler.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';

// Texto que o PostgreSQL recusa (NUL vira 08P01; um surrogate isolado quebra o JSONB da outbox,
// 22P02) e caracteres de controle. Antes eram aceitos pela validação, chegavam ao banco e voltavam
// como 503 "reenvie" ou 500, e pela fila seguravam a wallet com retries por 6 minutos. Agora são
// payload inválido: 400 no HTTP, DLQ direto na fila.
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const KEY = 'provider-a:transaction-123';

const body = (overrides: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER,
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...overrides,
});

function failure(input: unknown, key: unknown = KEY): InvalidCommandError {
  try {
    parseProcessWagerTransactionCommand(input, key);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCommandError);
    return error as InvalidCommandError;
  }
  throw new Error('expected the parse to fail');
}

const HOSTILE: Array<[string, string]> = [
  ['NUL', 'g\u0000'],
  ['a lone high surrogate', 'g\ud800'],
  ['a lone low surrogate', 'g\udc00'],
  ['ESC (C0 control)', 'g\u001b[31m'],
  ['a newline', 'g\nh'],
  ['a tab', 'g\th'],
  ['DEL', 'g\u007f'],
  ['a C1 control', 'g\u0085'],
];

const TEXT_FIELDS = [
  'providerId',
  'externalTransactionId',
  'roundId',
  'gameId',
  'referenceExternalTransactionId',
];

describe('text fields refuse what the database cannot store and control characters', () => {
  for (const field of TEXT_FIELDS) {
    test.each(HOSTILE)(
      `${field} with %s is INVALID_PAYLOAD`,
      (_name, value) => {
        const error = failure(
          body({
            kind: 'REFUND',
            referenceExternalTransactionId: 'bet-1',
            [field]: value,
          }),
        );
        expect(error.code).toBe(FailureCode.InvalidPayload);
        expect(error.details.map((d) => d.path)).toContain(field);
        // A mensagem nunca repete o valor recebido.
        expect(error.message).not.toContain(value);
      },
    );
  }

  test.each(HOSTILE)(
    'the Idempotency-Key with %s is INVALID_PAYLOAD',
    (_name, value) => {
      const error = failure(body(), `key-${value}`);
      expect(error.code).toBe(FailureCode.InvalidPayload);
      expect(error.details.map((d) => d.path)).toContain('Idempotency-Key');
    },
  );

  test('ordinary text, accents and emoji are still accepted', () => {
    const command = parseProcessWagerTransactionCommand(
      body({ gameId: 'Fortune Chimp — edição 2 🐒', roundId: 'rodada-ação' }),
      KEY,
    );
    expect(command.gameId).toBe('Fortune Chimp — edição 2 🐒');
  });

  test('the wallet creation (playerId is a UUID) is unaffected', () => {
    expect(
      parseCreateWalletCommand({
        playerId: PLAYER,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }).playerId,
    ).toBe(PLAYER);
  });
});

describe('on the queue the same input goes to the DLQ at once, never to retry', () => {
  const policy = new ConsumerRetryPolicy({
    maxReceiveCount: 10,
    baseSeconds: 2,
    maxSeconds: 60,
  });
  const envelope = (messageId: string, data: unknown) =>
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-11-26T12:00:00.000Z',
      data,
    });

  test('a NUL in the business data: the use case refuses it, the message is dead-lettered', async () => {
    const handler = new WagerMessageHandler(
      {
        execute: (input, context) => {
          parseProcessWagerTransactionCommand(input, context.idempotencyKey);
          throw new Error('unreachable');
        },
      },
      policy,
    );
    const disposition = await handler.handle(
      envelope('msg-1', {
        ...body({ gameId: 'g\u0000' }),
        idempotencyKey: KEY,
      }),
      { receiveCount: 1 },
    );
    expect(disposition).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'INVALID_PAYLOAD',
      failureCode: FailureCode.InvalidPayload,
    });
  });

  test('a messageId with a control character is an invalid envelope (DLQ)', async () => {
    const handler = new WagerMessageHandler(
      { execute: () => Promise.reject(new Error('unreachable')) },
      policy,
    );
    expect(
      await handler.handle(envelope('msg\u0000', body()), { receiveCount: 1 }),
    ).toMatchObject({ action: 'DEAD_LETTER', reason: 'INVALID_ENVELOPE' });
  });

  test('a data error the database still raises (class 22, 08P01) is PERMANENT: DLQ at once', async () => {
    const handler = new WagerMessageHandler(
      {
        execute: () =>
          Promise.reject(new PermanentDataError('22021', new Error('x'))),
      },
      policy,
    );
    expect(
      await handler.handle(
        envelope('msg-2', { ...body(), idempotencyKey: KEY }),
        {
          receiveCount: 1,
        },
      ),
    ).toMatchObject({
      action: 'DEAD_LETTER',
      reason: 'PERMANENT_DATA_ERROR',
      critical: false,
    });
  });
});
