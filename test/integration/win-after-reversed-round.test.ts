import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// N-1 da segunda avaliação: o espelho do REFERENCE_SETTLED. A BET da rodada foi devolvida (REFUND ou
// ROLLBACK) e DEPOIS chega um WIN da mesma rodada SEM referência: ele era pago, e o jogador ficava com
// a aposta de volta e com o prêmio (100 - 10 + 10 + 30 = 130). Agora é REFERENCE_ALREADY_REVERSED, o
// mesmo código do WIN que aponta para a BET devolvida.
const db = usePersistence();
const s = createScenario(db);
type W = Awaited<ReturnType<typeof s.walletWith>>;

const winNoRef = (wallet: W, round: string, amount = '30.00') =>
  s.submit(
    s.body(wallet, {
      kind: 'WIN',
      roundId: round,
      money: { amount, currency: 'BRL' },
    }),
  );

async function betReversed(kind: 'REFUND' | 'ROLLBACK', round: string) {
  const wallet = await s.walletWith('100.00');
  const bet = s.body(wallet, {
    roundId: round,
    money: { amount: '10.00', currency: 'BRL' },
  });
  await s.submit(bet);
  const reversal = await s.submit(
    s.reversalBody(wallet, kind, String(bet.externalTransactionId), '10.00', {
      roundId: round,
    }),
  );
  expect(reversal.status).toBe(WagerTransactionStatus.Processed);
  return wallet;
}

describe('a WIN without reference in a round whose BET was already reversed', () => {
  test.each(['REFUND', 'ROLLBACK'] as const)(
    'after a %s: REJECTED with REFERENCE_ALREADY_REVERSED, the balance stays 100.00',
    async (kind) => {
      const wallet = await betReversed(kind, 'r-1');
      const win = await winNoRef(wallet, 'r-1');
      expect(win).toMatchObject({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceAlreadyReversed,
      });
      expect(await s.balanceOf(wallet)).toBe('100.00');
      await assertInvariants(s.sql, wallet.id);
    },
  );

  test('a WIN of ANOTHER round is still paid', async () => {
    const wallet = await betReversed('REFUND', 'r-1');
    expect((await winNoRef(wallet, 'r-2')).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('a WIN of 0.00 pays nothing, so it is still accepted (the mirror of "a WIN of 0.00 does not settle")', async () => {
    const wallet = await betReversed('REFUND', 'r-1');
    expect((await winNoRef(wallet, 'r-1', '0.00')).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('a reversal that was REJECTED does not count', async () => {
    const wallet = await s.walletWith('100.00');
    const bet = s.body(wallet, {
      roundId: 'r-1',
      money: { amount: '10.00', currency: 'BRL' },
    });
    await s.submit(bet);
    const wrong = await s.submit(
      s.reversalBody(
        wallet,
        'REFUND',
        String(bet.externalTransactionId),
        '9.00',
        {
          roundId: 'r-1',
        },
      ),
    );
    expect(wrong.failureCode).toBe(FailureCode.AmountMismatch);
    expect((await winNoRef(wallet, 'r-1')).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('race: REFUND and WIN without reference of the same round at the same time, 15 rounds: never both', async () => {
    const problems: string[] = [];
    for (let round = 0; round < 15; round++) {
      const wallet = await s.walletWith('100.00');
      const bet = s.body(wallet, {
        roundId: 'r-race',
        money: { amount: '10.00', currency: 'BRL' },
      });
      await s.submit(bet);
      const [refund, win] = await Promise.all([
        s.submit(
          s.reversalBody(
            wallet,
            'REFUND',
            String(bet.externalTransactionId),
            '10.00',
            {
              roundId: 'r-race',
            },
          ),
        ),
        winNoRef(wallet, 'r-race'),
      ]);
      const both =
        refund.status === WagerTransactionStatus.Processed &&
        win.status === WagerTransactionStatus.Processed;
      const balance = await s.balanceOf(wallet);
      // Quem chegou primeiro ao lock ganha: só o REFUND (100.00) ou só o WIN (120.00).
      if (both || !['100.00', '120.00'].includes(balance)) {
        problems.push(`${refund.status}/${win.status} -> ${balance}`);
      }
      await assertInvariants(s.sql, wallet.id);
    }
    expect(problems).toEqual([]);
  }, 60_000);
});
