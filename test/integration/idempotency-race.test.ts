import { describe, expect, test } from 'bun:test';
import {
  ApplicationError,
  DuplicateKeyError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  UnresolvedIdempotencyRaceError,
} from '../../src/application/errors/application-errors.js';
import { WagerTransactionReader } from '../../src/application/ports/wager-transaction-repository.js';
import { FailureCode } from '../../src/domain/errors/failure-code.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet as DomainWallet } from '../../src/domain/wallet/wallet.js';
import { computePayloadHash } from '../../src/domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction.js';
import { rejectionOf } from '../support/assertions.js';
import { capture, holding } from '../support/concurrency.js';
import { assertInvariants } from '../support/invariants.js';
import { brl, T0, usePersistence, uuid } from '../support/persistence.js';
import {
  AlwaysFailingUnitOfWork,
  CountingUnitOfWork,
  UnitOfWorkWith,
  createScenario,
  waitUntilSomeoneIsBlocked,
  type Wallet,
} from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db);

// Conta as consultas por chave de idempotência do caminho rápido: um "rerun" do caso de uso
// volta ao passo 3, então são 2 consultas (a execução original e a reexecução).
class CountingReader extends WagerTransactionReader {
  keyLookups = 0;
  findById = (id: string) => db().reader.findById(id);
  findByIdempotencyKey = (key: string) => {
    this.keyLookups++;
    return db().reader.findByIdempotencyKey(key);
  };
  findByProviderAndExternalId = (provider: string, external: string) =>
    db().reader.findByProviderAndExternalId(provider, external);
}

// Uma transação PROCESSED que vai ocupar a chave e/ou o id externo, segurada SEM commitar.
function occupying(
  wallet: Wallet,
  key: string,
  external: string,
): WagerTransaction {
  const tx = WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: key,
    payloadHash: 'c'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-winner',
    createdAt: T0,
  });
  tx.markProcessed({ balanceAfter: brl('75.00'), at: T0 });
  return tx;
}

// Cenário determinístico da corrida (sem sorte): uma transação NÃO commitada ocupa a chave; a
// requisição perdedora passa pelas duas checagens (a linha ainda é invisível), tenta gravar e
// FICA PARADA no índice único; só então a primeira commita, e a perdedora recebe o 23505.
async function race(options: {
  winner: WagerTransaction;
  loserInput: Record<string, unknown>;
  loserKey: string;
}) {
  const reader = new CountingReader();
  const counting = new CountingUnitOfWork(db().uow);
  const { slow } = await holding(
    async ({ locked, until }) => {
      await db().uow.run(async (r) => {
        await r.transactions.insert(options.winner);
        locked();
        await until;
      });
    },
    async () => {
      const slow = capture(
        s.submit(
          options.loserInput,
          { idempotencyKey: options.loserKey },
          s.build({ uow: counting, reader }),
        ),
      );
      await waitUntilSomeoneIsBlocked(s.sql); // a perdedora está parada no índice único
      return { slow };
    },
  );
  return { outcome: await slow, counting, reader };
}

describe('the 23505 race: the same key (or external id) from two wallets at once', () => {
  test('same KEY, another wallet: the loser reruns once and answers IDEMPOTENCY_KEY_REUSED (409), writing nothing', async () => {
    const a = await s.walletWith('100.00');
    const b = await s.walletWith('100.00');
    const key = `race-${uuid()}`;
    const winner = occupying(a, key, s.nextExternal());

    const { outcome, counting, reader } = await race({
      winner,
      loserInput: s.body(b),
      loserKey: key,
    });

    expect(outcome.ok).toBe(false);
    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(error).toMatchObject({
      code: FailureCode.IdempotencyKeyReused,
      retryable: false,
    });
    expect(counting.runs).toBe(1); // a 1ª execução abriu a transação; a reexecução parou no caminho rápido
    expect(reader.keyLookups).toBe(2); // exatamente UMA reexecução
    // Nada do perdedor ficou: a wallet dele está como estava, e a linha da vencedora é a única da chave.
    expect(await s.walletRow(b.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(
      await s.count(
        'wager_transactions',
        `wallet_id = ? AND kind <> 'OPENING'`,
        [b.id],
      ),
    ).toBe(0);
    expect(
      await s.count('wager_transactions', 'idempotency_key = ?', [key]),
    ).toBe(1);
    await assertInvariants(s.sql, b.id);
  });

  test('same EXTERNAL ID under another key: the loser reruns once and answers EXTERNAL_ID_CONFLICT (409)', async () => {
    const a = await s.walletWith('100.00');
    const b = await s.walletWith('100.00');
    const external = s.nextExternal();
    const winner = occupying(a, `winner-${uuid()}`, external);

    const { outcome, counting, reader } = await race({
      winner,
      loserInput: s.body(b, { externalTransactionId: external }),
      loserKey: `loser-${uuid()}`,
    });

    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toBeInstanceOf(ExternalIdConflictError);
    expect(error).toMatchObject({ code: FailureCode.ExternalIdConflict });
    expect(counting.runs).toBe(1);
    expect(reader.keyLookups).toBe(2);
    expect(
      await s.count(
        'wager_transactions',
        `wallet_id = ? AND kind <> 'OPENING'`,
        [b.id],
      ),
    ).toBe(0);
    expect(await s.walletRow(b.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
  });

  test('BOTH constraints at once (same key and same external id): whichever Postgres reports, the answer is the key conflict', async () => {
    const a = await s.walletWith('100.00');
    const b = await s.walletWith('100.00');
    const key = `race-${uuid()}`;
    const external = s.nextExternal();

    const { outcome } = await race({
      winner: occupying(a, key, external),
      loserInput: s.body(b, { externalTransactionId: external }),
      loserKey: key,
    });

    expect(!outcome.ok && outcome.error).toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });

  test('after the race the loser can try again with a NEW key and is processed normally', async () => {
    const a = await s.walletWith('100.00');
    const b = await s.walletWith('100.00');
    const key = `race-${uuid()}`;
    await race({
      winner: occupying(a, key, s.nextExternal()),
      loserInput: s.body(b),
      loserKey: key,
    });

    const retry = await s.submit(s.body(b));

    expect(retry).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false,
    });
    expect(await s.balanceOf(b)).toBe('75.00');
  });
});

describe('the 23505 race: what happens when the rerun does not settle it', () => {
  test('a SECOND 23505 on these constraints is an internal error flagged CRITICAL, after exactly two attempts', async () => {
    const wallet = await s.walletWith('100.00');
    const second = new DuplicateKeyError('uq_wtx_idempotency_key');
    let calls = 0;
    const failing = new AlwaysFailingUnitOfWork(() =>
      ++calls === 1 ? new DuplicateKeyError('uq_wtx_idempotency_key') : second,
    );

    const error = await rejectionOf(
      s.submit(s.body(wallet), {}, s.build({ uow: failing })),
    );

    expect(error).toBeInstanceOf(UnresolvedIdempotencyRaceError);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      critical: true,
    });
    expect((error as Error).cause).toBe(second); // a causa é o 2º 23505, para o log
    expect(failing.runs).toBe(2); // nunca uma terceira
  });

  test('the second 23505 on the OTHER constraint (uq_wtx_provider_external) is the same critical error', async () => {
    const wallet = await s.walletWith('100.00');
    const failing = new AlwaysFailingUnitOfWork(
      () => new DuplicateKeyError('uq_wtx_provider_external'),
    );
    const error = await rejectionOf(
      s.submit(s.body(wallet), {}, s.build({ uow: failing })),
    );
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', critical: true });
    expect(failing.runs).toBe(2);
  });

  test('a first 23505 on one constraint and a second on the other still counts as unresolved', async () => {
    const wallet = await s.walletWith('100.00');
    let calls = 0;
    const failing = new AlwaysFailingUnitOfWork(
      () =>
        new DuplicateKeyError(
          ++calls === 1 ? 'uq_wtx_idempotency_key' : 'uq_wtx_provider_external',
        ),
    );
    const error = await rejectionOf(
      s.submit(s.body(wallet), {}, s.build({ uow: failing })),
    );
    expect(error).toBeInstanceOf(UnresolvedIdempotencyRaceError);
    expect(failing.runs).toBe(2);
  });

  test.each([
    'uq_wtx_reversed_once',
    'uq_wallets_player_currency',
    'pk_wager_transactions',
    'unknown',
  ])(
    'a 23505 on ANOTHER constraint (%s) is permanent: no rerun, the same error comes out (500, a bug)',
    async (constraint) => {
      const wallet = await s.walletWith('100.00');
      const failure = new DuplicateKeyError(constraint);
      const failing = new AlwaysFailingUnitOfWork(() => failure);

      const error = await rejectionOf(
        s.submit(s.body(wallet), {}, s.build({ uow: failing })),
      );

      expect(error).toBe(failure);
      expect(failing.runs).toBe(1);
    },
  );

  test('a REAL 23514 (a check constraint saved the wallet) is permanent too: no rerun, not a 503, nothing left', async () => {
    const wallet = await s.walletWith('100.00');
    const counting = new CountingUnitOfWork(
      new UnitOfWorkWith(db().uow, (r) => ({
        ...r,
        wallets: Object.assign(Object.create(r.wallets) as typeof r.wallets, {
          // Um bug fingido: grava um saldo negativo. O CHECK do banco recusa (23514).
          save: (w: DomainWallet, expected: number) =>
            r.wallets.save(
              DomainWallet.rehydrate({
                id: w.id,
                playerId: w.playerId,
                currency: w.currency,
                balance: Money.zero('BRL').subtract(
                  Money.from({ amount: '1.00', currency: 'BRL' }),
                ),
                version: w.version,
                createdAt: w.createdAt,
                updatedAt: w.updatedAt,
              }),
              expected,
            ),
        }),
      })),
    );

    const error = await rejectionOf(
      s.submit(s.body(wallet), {}, s.build({ uow: counting })),
    );

    expect((error as { code?: string }).code).toBe('23514');
    expect(error).not.toBeInstanceOf(ApplicationError); // continua sendo o erro cru do banco: 500
    expect(counting.runs).toBe(1);
    expect(await s.walletRow(wallet.id)).toMatchObject({
      balance: '100.00',
      version: 1,
    });
    expect(await s.movements(wallet.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- o hash é o mesmo por HTTP e por SQS

describe('the same operation by HTTP and by SQS has the SAME payload hash (ADR-0008)', () => {
  // O que o consumidor SQS da Fase 5 fará: tirar a chave de idempotência de dentro de data e
  // mandar o resto como o corpo, junto com o messageId para a inbox.
  const asSqsMessage = (business: Record<string, unknown>, key: string) => {
    const reordered = Object.fromEntries(Object.entries(business).reverse());
    return {
      messageId: `msg-${uuid()}`,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-11-27T09:00:00.000Z',
      data: { idempotencyKey: key, ...reordered, traceparent: '00-abc-def-01' }, // chaves em outra ordem e metadado a mais
    };
  };
  const fromSqs = (message: ReturnType<typeof asSqsMessage>) => {
    const { idempotencyKey, ...business } = message.data;
    return {
      input: business as Record<string, unknown>,
      context: {
        idempotencyKey,
        inbox: {
          consumerName: 'wager-transactions-consumer',
          messageId: message.messageId,
        },
      },
    };
  };

  test('HTTP first, SQS later: the SQS message is a replay, not a second debit', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const key = s.keyOf(input);
    const viaHttp = await s.submit(input);

    const sqs = fromSqs(asSqsMessage(input, key));
    const viaSqs = await s.submit(sqs.input, sqs.context);

    expect(viaSqs).toEqual({ ...viaHttp, idempotentReplay: true });
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
    expect(await s.balanceOf(wallet)).toBe('75.00');
    await assertInvariants(s.sql, wallet.id);
  });

  test('SQS first, HTTP later: the HTTP request is a replay', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const key = s.keyOf(input);
    const sqs = fromSqs(asSqsMessage(input, key));
    const viaSqs = await s.submit(sqs.input, sqs.context);

    const viaHttp = await s.submit(input);

    expect(viaHttp).toEqual({ ...viaSqs, idempotentReplay: true });
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
  });

  test('the stored hash is the canonical one of the business fields, whichever channel came first', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const sqs = fromSqs(asSqsMessage(input, s.keyOf(input)));
    const result = await s.submit(sqs.input, sqs.context);

    expect((await s.txRow(result.transactionId)).payload_hash).toBe(
      computePayloadHash({
        providerId: 'provider-a',
        externalTransactionId: String(input.externalTransactionId),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('25.00'),
      }),
    );
  });

  test('the transport metadata (messageId, traceparent, correlation id, key order) never changes the hash', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const key = s.keyOf(input);
    await s.submit(input, { correlationId: 'corr-http' });

    for (let delivery = 0; delivery < 3; delivery++) {
      const sqs = fromSqs(asSqsMessage(input, key));
      const replay = await s.submit(sqs.input, {
        ...sqs.context,
        correlationId: `corr-sqs-${delivery}`,
      });
      expect(replay.idempotentReplay).toBe(true);
    }
    expect(await s.directions(wallet.id)).toEqual(['DEBIT']);
  });

  test('the same key from SQS with ONE CENT of difference is IDEMPOTENCY_KEY_REUSED, not a replay', async () => {
    const wallet = await s.walletWith('100.00');
    const input = s.body(wallet);
    const key = s.keyOf(input);
    await s.submit(input);

    const sqs = fromSqs(
      asSqsMessage(
        { ...input, money: { amount: '25.01', currency: 'BRL' } },
        key,
      ),
    );
    const error = await rejectionOf(s.submit(sqs.input, sqs.context));

    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await s.balanceOf(wallet)).toBe('75.00');
  });

  test('a REFUND by SQS and by HTTP also share the hash (the reference is part of it)', async () => {
    const wallet = await s.walletWith('100.00');
    const bet = await s.placeBet(wallet);
    const input = s.reversalBody(wallet, 'REFUND', bet.external);
    const key = s.keyOf(input);
    const viaHttp = await s.submit(input);

    const sqs = fromSqs(asSqsMessage(input, key));
    const viaSqs = await s.submit(sqs.input, sqs.context);

    expect(viaSqs).toEqual({ ...viaHttp, idempotentReplay: true });
    expect(await s.balanceOf(wallet)).toBe('100.00');
  });
});
