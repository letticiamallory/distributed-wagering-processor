import { describe, expect, test } from 'bun:test';
import {
  InvalidCommandError,
  TransactionNotFoundError,
} from '../../src/application/errors/application-errors.js';
import { GetTransactionUseCase } from '../../src/application/use-cases/queries.use-cases.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { usePersistence } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

// Bug 6 do avaliador: a transação OPENING é gravada com providerId "internal" (e a chave
// "internal:opening:<walletId>"), mas nada reservava esse nome. Um provedor chamado "internal"
// podia submeter transações no mesmo namespace, e GET /providers/internal/... devolvia a OPENING.
// Agora o nome é reservado: na submissão é payload inválido, e a consulta não o expõe.
const db = usePersistence();
const s = createScenario(db);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCommandError);
    return (error as InvalidCommandError).code;
  }
  throw new Error('expected INVALID_PAYLOAD');
}

describe('the provider id "internal" is reserved for the system', () => {
  test.each(['internal', 'INTERNAL', 'Internal'])(
    'a submission with providerId %s is INVALID_PAYLOAD, and nothing is recorded',
    async (providerId) => {
      const wallet = await s.walletWith('100.00');
      const input = s.body(wallet, { providerId });
      expect(await codeOf(s.submit(input))).toBe(FailureCode.InvalidPayload);
      expect(
        await s.sql(
          'SELECT id FROM wager_transactions WHERE idempotency_key = ?',
          [s.keyOf(input)],
        ),
      ).toHaveLength(0);
    },
  );

  test('an Idempotency-Key in the internal namespace is INVALID_PAYLOAD', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    expect(
      await codeOf(
        s.submit(input, { idempotencyKey: `internal:opening:${wallet.id}` }),
      ),
    ).toBe(FailureCode.InvalidPayload);
  });

  test('GET /providers/internal/... does not expose the OPENING (404)', async () => {
    const wallet = await s.walletWith('100.00');
    const queries = new GetTransactionUseCase(db().reader);
    await expect(
      queries.byProviderKey('internal', wallet.id),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });

  test('the OPENING itself is still created and readable by its id', async () => {
    const wallet = await s.walletWith('100.00');
    const [opening] = await s.sql(
      "SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'",
      [wallet.id],
    );
    const view = await new GetTransactionUseCase(db().reader).byId(
      String(opening?.id),
    );
    expect(view.kind).toBe('OPENING');
  });
});
