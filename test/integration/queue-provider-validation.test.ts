import { describe, expect, test } from 'bun:test';
import { InvalidCommandError } from '../../src/application/errors/application-errors.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { rejectionOf } from '../support/assertions.js';
import { usePersistence, uuid } from '../support/persistence.js';
import { createScenario } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db);

// O canal da fila é um canal INTERNO CONFIÁVEL (enunciado, seção 2): não há token, e a porta de
// identidade não participa. Mas o `providerId` da mensagem continua passando pelas MESMAS
// validações de domínio do HTTP, porque elas moram no caso de uso, e não no guard.
const fromQueue = (messageId: string) => ({
  inbox: { consumerName: 'wager-transactions-consumer', messageId },
});

describe('the queue channel: no identity check, but the providerId is still validated', () => {
  test('an ordinary message is processed with no credential at all', async () => {
    const wallet = await s.walletWith('100.00');
    const result = await s.submit(s.body(wallet), fromQueue(`msg-${uuid()}`));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
  });

  test.each([
    ['blank', '   '],
    ['empty', ''],
    ['over 200 characters', 'p'.repeat(201)],
  ])(
    'a providerId that is %s is INVALID_PAYLOAD, exactly as over HTTP',
    async (_name, providerId) => {
      const wallet = await s.walletWith('100.00');
      const error = await rejectionOf(
        s.submit(s.body(wallet, { providerId }), fromQueue(`msg-${uuid()}`)),
      );
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect(error).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(
        (error as InvalidCommandError).details.map((d) => d.path),
      ).toContain('providerId');
    },
  );

  test('a providerId that is not text is INVALID_PAYLOAD', async () => {
    const wallet = await s.walletWith('100.00');
    const error = await rejectionOf(
      s.submit(s.body(wallet, { providerId: 42 }), fromQueue(`msg-${uuid()}`)),
    );
    expect(error).toBeInstanceOf(InvalidCommandError);
  });

  test('any well-formed providerId is accepted from the queue (the channel is trusted)', async () => {
    const wallet = await s.walletWith('100.00');
    const result = await s.submit(
      s.body(wallet, { providerId: 'a-provider-with-no-token' }),
      fromQueue(`msg-${uuid()}`),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
  });
});
