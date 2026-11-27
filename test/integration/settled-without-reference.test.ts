import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// ADR-0005: não se devolve uma BET que já pagou prêmio. O enunciado deixa o WIN referenciar a BET
// ("pode referenciar"), e o hasSettledWin só enxergava o WIN que apontava para ela: um WIN da mesma
// rodada SEM referência deixava devolver a aposta, e o jogador ficava com os dois (cenário do
// avaliador: 100 - 10 + 30 + 10 = 130). Agora o WIN PROCESSED com valor > 0 da mesma wallet, do
// mesmo provedor e da mesma rodada liquida a BET, com ou sem referência.
const db = usePersistence();
const s = createScenario(db);

async function betAndWin(winOverrides: Record<string, unknown> = {}) {
  const wallet = await s.walletWith('100.00');
  const bet = await s.placeBet(wallet, '10.00');
  const win = await s.submit(
    s.body(wallet, {
      kind: 'WIN',
      money: { amount: '30.00', currency: 'BRL' },
      ...winOverrides,
    }),
  );
  expect(win.status).toBe(WagerTransactionStatus.Processed);
  return { wallet, bet, win };
}

const refund = (
  wallet: Awaited<ReturnType<typeof s.walletWith>>,
  betExternal: string,
) => s.submit(s.reversalBody(wallet, 'REFUND', betExternal, '10.00'));

describe('REFERENCE_SETTLED also sees a WIN of the same round without a reference', () => {
  test("the evaluator's scenario: BET 10, WIN 30 without reference, REFUND of the BET -> REJECTED", async () => {
    const { wallet, bet } = await betAndWin();
    const result = await refund(wallet, bet.external);
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceSettled,
    });
    expect(await s.balanceOf(wallet)).toBe('120.00');
    await assertInvariants(s.sql, wallet.id);
  });

  test('the ROLLBACK of the BET is refused the same way', async () => {
    const { wallet, bet } = await betAndWin();
    const result = await s.submit(
      s.reversalBody(wallet, 'ROLLBACK', bet.external, '10.00'),
    );
    expect(result.failureCode).toBe(FailureCode.ReferenceSettled);
  });

  test('a WIN of ANOTHER round does not settle the BET', async () => {
    const { wallet, bet } = await betAndWin({ roundId: 'another-round' });
    expect((await refund(wallet, bet.external)).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('a WIN of ANOTHER provider in a round with the same name does not settle the BET', async () => {
    const { wallet, bet } = await betAndWin({
      providerId: 'provider-b',
      externalTransactionId: `win-b-${Date.now()}`,
    });
    expect((await refund(wallet, bet.external)).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('a WIN of 0.00 without reference pays nothing, so the BET can be refunded', async () => {
    const { wallet, bet } = await betAndWin({
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect((await refund(wallet, bet.external)).status).toBe(
      WagerTransactionStatus.Processed,
    );
  });

  test('once the WIN without reference is rolled back, the BET can be refunded', async () => {
    const wallet = await s.walletWith('100.00');
    const bet = await s.placeBet(wallet, '10.00');
    const winInput = s.body(wallet, {
      kind: 'WIN',
      money: { amount: '30.00', currency: 'BRL' },
    });
    await s.submit(winInput);
    const rollback = await s.submit(
      s.reversalBody(
        wallet,
        'ROLLBACK',
        String(winInput.externalTransactionId),
        '30.00',
      ),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect((await refund(wallet, bet.external)).status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(await s.balanceOf(wallet)).toBe('100.00');
    await assertInvariants(s.sql, wallet.id);
  });

  test('a WIN that points to ANOTHER BET of the same round settles that one, not this one', async () => {
    const wallet = await s.walletWith('100.00');
    const first = await s.placeBet(wallet, '10.00');
    const second = await s.placeBet(wallet, '10.00');
    await s.submit(s.winBody(wallet, second.external, '30.00'));
    expect((await refund(wallet, first.external)).status).toBe(
      WagerTransactionStatus.Processed,
    );
    expect((await refund(wallet, second.external)).failureCode).toBe(
      FailureCode.ReferenceSettled,
    );
  });
});
