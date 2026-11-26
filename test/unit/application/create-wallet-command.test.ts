import { describe, expect, test } from 'bun:test';
import { parseCreateWalletCommand } from '../../../src/application/commands/create-wallet.command.js';
import { InvalidCommandError } from '../../../src/application/errors/application-errors.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

const body = (overrides: Record<string, unknown> = {}) => ({
  playerId: PLAYER,
  initialBalance: { amount: '1000.00', currency: 'BRL' },
  ...overrides,
});

function codeOf(input: unknown): string {
  try {
    parseCreateWalletCommand(input);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCommandError);
    return (error as InvalidCommandError).code;
  }
  throw new Error('expected the parse to fail');
}

describe('parseCreateWalletCommand', () => {
  test('a valid body becomes a command with Money', () => {
    const command = parseCreateWalletCommand(body());
    expect(command.playerId).toBe(PLAYER);
    expect(command.initialBalance.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
  });

  test('a zero initial balance is allowed (no OPENING is created)', () => {
    const command = parseCreateWalletCommand(
      body({ initialBalance: { amount: '0.00', currency: 'BRL' } }),
    );
    expect(command.initialBalance.isZero()).toBe(true);
  });

  test('the playerId is normalized to lowercase', () => {
    expect(
      parseCreateWalletCommand(body({ playerId: PLAYER.toUpperCase() }))
        .playerId,
    ).toBe(PLAYER);
  });

  test.each([
    ['not an object', 'x'],
    ['null', null],
    ['no playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['no initialBalance', { playerId: PLAYER }],
    ['a playerId that is not a UUID', body({ playerId: 'player-1' })],
    [
      'an amount as a number',
      body({ initialBalance: { amount: 10, currency: 'BRL' } }),
    ],
    [
      'a lowercase currency',
      body({ initialBalance: { amount: '1.00', currency: 'brl' } }),
    ],
  ])('INVALID_PAYLOAD for %s', (_label, input) => {
    expect(codeOf(input)).toBe(FailureCode.InvalidPayload);
  });

  test('the amount error points at initialBalance.amount', () => {
    try {
      parseCreateWalletCommand(
        body({ initialBalance: { amount: '10.5', currency: 'BRL' } }),
      );
      throw new Error('expected a failure');
    } catch (error) {
      const e = error as InvalidCommandError;
      expect(e.details.map((d) => d.path)).toEqual(['initialBalance.amount']);
    }
  });

  test.each(['1000', '1000.5', '-1.00', '1e3', 'NaN', '10000000000000000.00'])(
    'INVALID_AMOUNT for the amount %p',
    (amount) => {
      expect(
        codeOf(body({ initialBalance: { amount, currency: 'BRL' } })),
      ).toBe(FailureCode.InvalidAmount);
    },
  );
});
