import { describe, expect, test } from 'bun:test';
import { InvalidCommandError } from '../../../src/application/errors/application-errors.js';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../src/application/queries/ledger-cursor.js';

const W = '0192f291-27dd-7d3f-8071-5f8685deef37';
const OTHER = '0192f291-27dd-7d3f-8071-000000000000';

const b64url = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

describe('the ledger cursor', () => {
  test.each([1, 2, 42, 1_000_000, 2_147_483_647])(
    'round-trips wallet version %i',
    (version) => {
      expect(decodeLedgerCursor(encodeLedgerCursor(W, version), W)).toBe(
        version,
      );
    },
  );

  test('is base64url (safe in a query string) and says nothing a client could build by hand', () => {
    const cursor = encodeLedgerCursor(W, 42);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('42');
    expect(cursor).not.toContain('walletVersion');
    expect(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    ).toEqual({ v: 2, walletId: W, walletVersion: 42 });
  });

  test('refuses to encode a version that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeLedgerCursor(W, bad)).toThrow();
    }
  });

  test.each([
    ['not base64url at all', '***not*a*cursor***'],
    ['base64url of text that is not JSON', b64url('hello')],
    ['JSON that is not an object', b64url('[1,2]')],
    [
      'an unknown format version',
      b64url({ v: 3, walletId: W, walletVersion: 3 }),
    ],
    ['the old format, without walletId', b64url({ v: 1, walletVersion: 3 })],
    [
      'a cursor of ANOTHER wallet',
      b64url({ v: 2, walletId: OTHER, walletVersion: 3 }),
    ],
    ['no format version', b64url({ walletId: W, walletVersion: 3 })],
    ['no walletVersion', b64url({ v: 2, walletId: W })],
    [
      'a walletVersion that is text',
      b64url({ v: 2, walletId: W, walletVersion: '3' }),
    ],
    [
      'a fractional walletVersion',
      b64url({ v: 2, walletId: W, walletVersion: 3.5 }),
    ],
    ['a zero walletVersion', b64url({ v: 2, walletId: W, walletVersion: 0 })],
    [
      'a negative walletVersion',
      b64url({ v: 2, walletId: W, walletVersion: -4 }),
    ],
    [
      'a walletVersion beyond the database integer',
      b64url({ v: 2, walletId: W, walletVersion: 2_147_483_648 }),
    ],
    ['an empty string', ''],
    ['a huge string', 'A'.repeat(5_000)],
  ])(
    '%s is a 400 (INVALID_PAYLOAD naming the cursor), never a wrong page',
    (_name, cursor) => {
      let error: unknown;
      try {
        decodeLedgerCursor(cursor, W);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(error).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(
        (error as InvalidCommandError).details.map((d) => d.path),
      ).toContain('cursor');
    },
  );

  test('the error message never echoes the cursor back', () => {
    const secret = b64url({ v: 9, walletVersion: 'LEAK-ME' });
    try {
      decodeLedgerCursor(secret, W);
    } catch (error) {
      expect(
        JSON.stringify([
          (error as Error).message,
          (error as InvalidCommandError).details,
        ]),
      ).not.toContain('LEAK-ME');
    }
  });
});
