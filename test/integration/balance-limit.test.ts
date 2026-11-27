import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { assertInvariants } from '../support/invariants.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// O teto do Money é de 16 dígitos inteiros (9999999999999999.99). Um crédito que passaria dele
// lançava MoneyOverflowError dentro da transação: 500, nada gravado, e pela fila um retry de 6
// minutos. Agora é regra de negócio: REJECTED com BALANCE_LIMIT_EXCEEDED, gravado e auditável.
const db = usePersistence();
const s = createScenario(db);
const MAX = '9999999999999999.99';

describe('a credit that would pass the Money ceiling is a business rejection', () => {
  test('WIN: REJECTED with BALANCE_LIMIT_EXCEEDED, the balance seen, no ledger entry, a Rejected event', async () => {
    const wallet = await s.walletWith(MAX);
    const input = s.body(wallet, {
      kind: 'WIN',
      money: { amount: '0.01', currency: 'BRL' },
    });
    const result = await s.submit(input);
    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.BalanceLimitExceeded,
      balance: { amount: MAX, currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await s.balanceOf(wallet)).toBe(MAX);
    expect(await s.movements(wallet.id)).toHaveLength(0);
    expect(await s.eventTypesOf(result.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);

    // O replay devolve a mesma rejeição, sem tentar de novo.
    expect(await s.submit(input)).toMatchObject({
      transactionId: result.transactionId,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.BalanceLimitExceeded,
      idempotentReplay: true,
    });
    await assertInvariants(s.sql, wallet.id);
  });

  test('REFUND of a BET that would pass the ceiling is also BALANCE_LIMIT_EXCEEDED', async () => {
    const wallet = await s.walletWith(MAX);
    const bet = await s.placeBet(wallet, '1.00');
    // Um WIN enche a wallet de novo até o teto; devolver a aposta passaria dele.
    await s.submit(
      s.body(wallet, {
        kind: 'WIN',
        money: { amount: '1.00', currency: 'BRL' },
        roundId: 'r-2',
      }),
    );
    const refund = await s.submit(
      s.reversalBody(wallet, 'REFUND', bet.external, '1.00'),
    );
    expect(refund).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.BalanceLimitExceeded,
    });
    expect(await s.balanceOf(wallet)).toBe(MAX);
    await assertInvariants(s.sql, wallet.id);
  });

  test('a credit that reaches the ceiling exactly is still applied', async () => {
    const wallet = await s.walletWith('9999999999999998.99');
    const result = await s.submit(
      s.body(wallet, {
        kind: 'WIN',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(await s.balanceOf(wallet)).toBe(MAX);
  });
});
