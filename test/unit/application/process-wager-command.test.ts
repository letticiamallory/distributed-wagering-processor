import { describe, expect, test } from 'bun:test';
import { InvalidCommandError } from '../../../src/application/errors/application-errors.js';
import { parseProcessWagerTransactionCommand } from '../../../src/application/commands/process-wager-transaction.command.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import { WagerTransactionKind } from '../../../src/domain/wager/wager-transaction-kind.js';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const KEY = 'provider-a:transaction-123';

function body(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

// Sem valor padrão no parâmetro: passar undefined de propósito testa a chave ausente.
function codeOfWithKey(input: unknown, key: unknown): string {
  try {
    parseProcessWagerTransactionCommand(input, key);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCommandError);
    return (error as InvalidCommandError).code;
  }
  throw new Error('expected the parse to fail');
}

const codeOf = (input: unknown) => codeOfWithKey(input, KEY);

describe('parseProcessWagerTransactionCommand: a valid payload', () => {
  test('becomes a typed command with Money, not strings', () => {
    const command = parseProcessWagerTransactionCommand(body(), KEY);
    expect(command.idempotencyKey).toBe(KEY);
    expect(command.providerId).toBe('provider-a');
    expect(command.externalTransactionId).toBe('transaction-123');
    expect(command.playerId).toBe(PLAYER);
    expect(command.walletId).toBe(WALLET);
    expect(command.roundId).toBe('round-987');
    expect(command.gameId).toBe('fortune-chimp');
    expect(command.kind).toBe(WagerTransactionKind.Bet);
    expect(command.money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(command.referenceExternalTransactionId).toBeUndefined();
  });

  test.each(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])(
    'accepts kind %s',
    (kind) => {
      const needsReference = kind === 'REFUND' || kind === 'ROLLBACK';
      const command = parseProcessWagerTransactionCommand(
        body({
          kind,
          ...(needsReference && { referenceExternalTransactionId: 'ext-bet' }),
        }),
        KEY,
      );
      expect(command.kind).toBe(kind as WagerTransactionKind);
    },
  );

  test('keeps the reference of a REFUND', () => {
    const command = parseProcessWagerTransactionCommand(
      body({ kind: 'REFUND', referenceExternalTransactionId: 'ext-bet' }),
      KEY,
    );
    expect(command.referenceExternalTransactionId).toBe('ext-bet');
  });

  test.each(['WIN', 'LOSS'])('a %s of 0.00 is allowed', (kind) => {
    const command = parseProcessWagerTransactionCommand(
      body({ kind, money: { amount: '0.00', currency: 'BRL' } }),
      KEY,
    );
    expect(command.money.isZero()).toBe(true);
  });

  test('unknown keys are ignored, not an error', () => {
    const command = parseProcessWagerTransactionCommand(
      body({ somethingNew: 'x', headers: {} }),
      KEY,
    );
    expect(command.providerId).toBe('provider-a');
    expect('somethingNew' in command).toBe(false);
  });

  test('UUIDs are normalized to lowercase, which is how Postgres returns them', () => {
    const command = parseProcessWagerTransactionCommand(
      body({ walletId: WALLET.toUpperCase(), playerId: PLAYER.toUpperCase() }),
      KEY,
    );
    expect(command.walletId).toBe(WALLET);
    expect(command.playerId).toBe(PLAYER);
  });
});

describe('parseProcessWagerTransactionCommand: INVALID_PAYLOAD', () => {
  test.each([
    ['null', null],
    ['a string', 'BET'],
    ['an array', []],
    ['a number', 42],
    ['undefined', undefined],
  ])('a body that is %s', (_label, input) => {
    expect(codeOf(input)).toBe(FailureCode.InvalidPayload);
  });

  test.each([
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
    'money',
  ])('a missing %s', (field) => {
    const input = body();
    delete input[field];
    expect(codeOf(input)).toBe(FailureCode.InvalidPayload);
  });

  test.each([
    ['providerId', 42],
    ['externalTransactionId', null],
    ['roundId', {}],
    ['gameId', true],
    ['kind', 7],
  ])('a %s of the wrong type', (field, value) => {
    expect(codeOf(body({ [field]: value }))).toBe(FailureCode.InvalidPayload);
  });

  test.each(['providerId', 'externalTransactionId', 'roundId', 'gameId'])(
    'a blank %s',
    (field) => {
      expect(codeOf(body({ [field]: '   ' }))).toBe(FailureCode.InvalidPayload);
      expect(codeOf(body({ [field]: '' }))).toBe(FailureCode.InvalidPayload);
    },
  );

  test('text fields have a size limit', () => {
    expect(codeOf(body({ gameId: 'g'.repeat(201) }))).toBe(
      FailureCode.InvalidPayload,
    );
    expect(() =>
      parseProcessWagerTransactionCommand(
        body({ gameId: 'g'.repeat(200) }),
        KEY,
      ),
    ).not.toThrow();
  });

  test.each([
    ['walletId', 'not-a-uuid'],
    ['walletId', '0192f291-27dd-7d3f-8071'],
    ['playerId', 'player-1'],
    ['playerId', ''],
  ])(
    '%s that is not a UUID (the column is UUID: it would be a 500)',
    (field, value) => {
      expect(codeOf(body({ [field]: value }))).toBe(FailureCode.InvalidPayload);
    },
  );

  test('amount as a JSON number is a payload error, not an amount error', () => {
    expect(codeOf(body({ money: { amount: 25, currency: 'BRL' } }))).toBe(
      FailureCode.InvalidPayload,
    );
  });

  test.each([
    ['money as a string', '25.00 BRL'],
    ['money as null', null],
    ['money without currency', { amount: '25.00' }],
    ['money without amount', { currency: 'BRL' }],
    ['a lowercase currency', { amount: '25.00', currency: 'brl' }],
    ['a currency with 2 letters', { amount: '25.00', currency: 'BR' }],
    ['a currency with 4 letters', { amount: '25.00', currency: 'BRLL' }],
  ])('%s', (_label, money) => {
    expect(codeOf(body({ money }))).toBe(FailureCode.InvalidPayload);
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 12],
    ['blank', '   '],
    ['empty', ''],
    ['too long', 'k'.repeat(256)],
  ])('an Idempotency-Key that is %s', (_label, key) => {
    expect(codeOfWithKey(body(), key)).toBe(FailureCode.InvalidPayload);
  });

  test('an Idempotency-Key of 255 characters is fine', () => {
    expect(() =>
      parseProcessWagerTransactionCommand(body(), 'k'.repeat(255)),
    ).not.toThrow();
  });

  test.each(['REFUND', 'ROLLBACK'])(
    'a %s without referenceExternalTransactionId',
    (kind) => {
      expect(codeOf(body({ kind }))).toBe(FailureCode.InvalidPayload);
      expect(codeOf(body({ kind, referenceExternalTransactionId: '  ' }))).toBe(
        FailureCode.InvalidPayload,
      );
    },
  );

  test('the amount error points at money.amount', () => {
    try {
      parseProcessWagerTransactionCommand(
        body({ money: { amount: '25.0', currency: 'BRL' } }),
        KEY,
      );
      throw new Error('expected a failure');
    } catch (error) {
      const e = error as InvalidCommandError;
      expect(e.code).toBe(FailureCode.InvalidAmount);
      expect(e.details.map((d) => d.path)).toEqual(['money.amount']);
      expect(e.message).toContain('money.amount');
    }
  });

  test('the error says which field is wrong', () => {
    try {
      parseProcessWagerTransactionCommand(body({ walletId: 'nope' }), KEY);
      throw new Error('expected a failure');
    } catch (error) {
      const e = error as InvalidCommandError;
      expect(e.details.map((d) => d.path)).toContain('walletId');
      expect(e.message).toContain('walletId');
    }
  });
});

describe('parseProcessWagerTransactionCommand: INVALID_AMOUNT', () => {
  test.each([
    '25',
    '25.0',
    '25.000',
    '10.005',
    '-25.00',
    '+25.00',
    '1e5',
    'NaN',
    'Infinity',
    ' 25.00',
    '25.00 ',
    '25,00',
    '',
    '10000000000000000.00',
  ])('the amount string %p', (amount) => {
    expect(codeOf(body({ money: { amount, currency: 'BRL' } }))).toBe(
      FailureCode.InvalidAmount,
    );
  });

  test.each(['BET', 'REFUND', 'ROLLBACK'])('a %s of 0.00', (kind) => {
    const input = body({
      kind,
      money: { amount: '0.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-bet',
    });
    expect(codeOf(input)).toBe(FailureCode.InvalidAmount);
  });
});

describe('parseProcessWagerTransactionCommand: UNSUPPORTED_KIND', () => {
  test.each([
    'OPENING',
    'DEPOSIT',
    'bet',
    'Bet',
    ' BET',
    'WITHDRAW',
    'ROLLBACK ',
  ])('the kind %p', (kind) => {
    expect(codeOf(body({ kind }))).toBe(FailureCode.UnsupportedKind);
  });

  test('an unsupported kind wins over a bad amount, so the provider fixes one thing at a time', () => {
    expect(
      codeOf(
        body({ kind: 'OPENING', money: { amount: '1.5', currency: 'BRL' } }),
      ),
    ).toBe(FailureCode.UnsupportedKind);
  });

  test('a payload error wins over an unsupported kind', () => {
    expect(codeOf(body({ kind: 'OPENING', walletId: 'nope' }))).toBe(
      FailureCode.InvalidPayload,
    );
  });
});
