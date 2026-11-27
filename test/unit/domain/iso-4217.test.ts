import { describe, expect, test } from 'bun:test';
import { InvalidCommandError } from '../../../src/application/errors/application-errors.js';
import { parseCreateWalletCommand } from '../../../src/application/commands/create-wallet.command.js';
import { parseProcessWagerTransactionCommand } from '../../../src/application/commands/process-wager-transaction.command.js';
import { FailureCode } from '../../../src/domain/errors/failure-code.js';
import {
  ISO_4217_CURRENCIES,
  isIso4217Currency,
} from '../../../src/domain/money/iso-4217.js';
import { InvalidMoneyError } from '../../../src/domain/money/money.errors.js';
import { Money } from '../../../src/domain/money/money.js';

// Bug 5 do avaliador: a moeda só era conferida no formato (3 letras maiúsculas). Uma wallet "ZZZ"
// nascia, e "XYZ" numa transação virava 422 CURRENCY_MISMATCH em vez de payload inválido. Agora a
// moeda tem que estar na lista ISO-4217 vigente, fixa no domínio.
describe('the ISO-4217 list', () => {
  // O Intl (ICU) conhece também as moedas HISTÓRICAS (ATS, DEM, FRF...), então as listas não são
  // iguais: o que se exige é que toda moeda da nossa lista exista lá (um erro de digitação aparece
  // aqui), e que as históricas mais conhecidas NÃO estejam na nossa.
  const intl = new Set(Intl.supportedValuesOf('currency'));

  test('every code of our list is a currency the runtime knows', () => {
    const unknown = [...ISO_4217_CURRENCIES].filter((code) => !intl.has(code));
    expect(unknown).toEqual([]);
  });

  test('has the active codes (about 180), including the recent ones', () => {
    expect(ISO_4217_CURRENCIES.size).toBeGreaterThan(170);
    expect(ISO_4217_CURRENCIES.size).toBeLessThan(intl.size);
    for (const code of [
      'BRL',
      'USD',
      'EUR',
      'JPY',
      'XCG',
      'ZWG',
      'SLE',
      'VES',
    ]) {
      expect(isIso4217Currency(code)).toBe(true);
    }
  });

  test('does not have withdrawn currencies', () => {
    for (const code of [
      'DEM',
      'FRF',
      'ITL',
      'HRK',
      'ANG',
      'ZWL',
      'VEF',
      'BRE',
      'CUC',
    ]) {
      expect(isIso4217Currency(code)).toBe(false);
    }
  });

  test('every code is 3 uppercase letters', () => {
    for (const code of ISO_4217_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
  });
});

describe('a currency outside the list is refused', () => {
  test('in Money (the domain), as InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'ZZZ' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.zero('XYZ')).toThrow(InvalidMoneyError);
  });

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCommandError);
      return (error as InvalidCommandError).code;
    }
    throw new Error('expected a 400');
  };

  test('in the wallet creation: 400 INVALID_PAYLOAD', () => {
    expect(
      codeOf(() =>
        parseCreateWalletCommand({
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          initialBalance: { amount: '10.00', currency: 'ZZZ' },
        }),
      ),
    ).toBe(FailureCode.InvalidPayload);
  });

  const transaction = (over: Record<string, unknown>) => ({
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...over,
  });

  test('in the transaction: 400 INVALID_PAYLOAD (not 422 CURRENCY_MISMATCH)', () => {
    expect(
      codeOf(() =>
        parseProcessWagerTransactionCommand(
          transaction({ money: { amount: '10.00', currency: 'XYZ' } }),
          'k',
        ),
      ),
    ).toBe(FailureCode.InvalidPayload);
  });

  test('a valid ISO currency that is not the wallet one still passes the parse (422 later)', () => {
    expect(
      parseProcessWagerTransactionCommand(
        transaction({ money: { amount: '10.00', currency: 'USD' } }),
        'k',
      ).money.currency,
    ).toBe('USD');
  });
});

describe('a BET does not take a reference', () => {
  test('BET with referenceExternalTransactionId is 400 INVALID_PAYLOAD', () => {
    try {
      parseProcessWagerTransactionCommand(
        {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'other',
        },
        'k',
      );
      throw new Error('expected a 400');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as InvalidCommandError).code).toBe(
        FailureCode.InvalidPayload,
      );
      expect(
        (error as InvalidCommandError).details.map((d) => d.path),
      ).toContain('referenceExternalTransactionId');
    }
  });
});
