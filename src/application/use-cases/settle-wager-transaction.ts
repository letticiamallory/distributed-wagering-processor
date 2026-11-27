import { WagerTransactionPendingReference } from '../../domain/messaging/events/wager-transaction-pending-reference.js';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected.js';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import type { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { WagerPolicy } from '../../domain/wager/wager-policy.js';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/unit-of-work.js';

export interface SettleInput {
  // A wallet JÁ travada (FOR UPDATE) pelo chamador: tudo aqui depende desse lock (ADR-0007).
  wallet: Wallet;
  transaction: WagerTransaction;
  now: Date;
  correlationId: string;
  // insert: a transação é nova (1ª passada). update: já existia em PENDING_REFERENCE (resolver).
  mode: 'insert' | 'update';
}

// A decisão e a gravação das regras de negócio, iguais na primeira passada e na resolução de uma
// pendente (ADR-0005): moeda, dono, referência, saldo. Sempre sob o lock da wallet. Deixa a
// transação no estado em que ficou (PROCESSED, REJECTED ou, se a referência não chegou e ainda
// há tentativas, PENDING_REFERENCE) e grava tudo na mesma transação SQL.
export async function settleWagerTransaction(
  deps: { ids: IdGenerator; schedule: PendingReferenceSchedule },
  repositories: Repositories,
  input: SettleInput,
): Promise<void> {
  const { wallet, transaction, now } = input;

  const reference =
    transaction.referenceExternalTransactionId === undefined
      ? undefined
      : await repositories.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );
  // Os dois são calculados AQUI, sob o lock desta wallet: ninguém mexe nas transações dela
  // entre a leitura e a gravação (ADR-0007), então a foto vale até o commit.
  const alreadyReversed = reference
    ? await repositories.transactions.hasProcessedReversal(reference.id)
    : false;
  // Só interessa para REFUND/ROLLBACK de uma BET: um prêmio pago impede devolver a aposta.
  const hasSettledWin =
    transaction.requiresReference() &&
    reference?.kind === WagerTransactionKind.Bet
      ? await repositories.transactions.hasSettledWin(reference)
      : false;

  const decision = WagerPolicy.decide({
    wallet,
    transaction,
    reference,
    alreadyReversed,
    hasSettledWin,
    // Esta é a última tentativa? Sem referência, a transação é rejeitada em vez de esperar.
    attemptsExhausted: deps.schedule.isExhausted(transaction.attempts),
  });

  const eventContext = () => ({
    eventId: deps.ids.next(),
    correlationId: input.correlationId,
    causationId: transaction.id,
    occurredAt: now,
  });
  const persist = () =>
    input.mode === 'insert'
      ? repositories.transactions.insert(transaction)
      : repositories.transactions.update(transaction);

  if (decision.type === 'waitForReference') {
    // A espera depois da tentativa n usa o número de tentativas ANTES de contar esta.
    transaction.markPendingReference(
      deps.schedule.nextAttemptAt(now, transaction.attempts),
    );
    await persist();
    // Só a ENTRADA em PENDING_REFERENCE avisa; as tentativas seguintes não repetem o evento.
    if (input.mode === 'insert') {
      await repositories.outbox.add(
        OutboxMessage.enqueue(
          WagerTransactionPendingReference.from(transaction, eventContext()),
          now,
        ),
      );
    }
    return;
  }

  // O saldo observado é SEMPRE o da wallet, na moeda dela (ADR-0006).
  const expectedVersion = wallet.version;
  let entry: WalletLedgerEntry | undefined;
  if (decision.type === 'reject') {
    transaction.reject(decision.code, wallet.balance);
  } else {
    if (decision.direction !== null) {
      const movement = {
        money: transaction.money,
        transactionId: transaction.id,
        entryId: deps.ids.next(),
        at: now,
      };
      entry =
        decision.direction === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
    }
    transaction.markProcessed({
      // Uma BET não referencia nada: a referência só vale para WIN, LOSS, REFUND e ROLLBACK.
      ...(reference &&
        transaction.kind !== WagerTransactionKind.Bet && {
          referenceTransactionId: reference.id,
        }),
      balanceAfter: wallet.balance,
      at: now,
    });
  }

  // Nesta ordem, por causa das FKs e do trigger de estado final: a transação já com o estado
  // final; depois o saldo (com a versão esperada) e o lançamento que a aponta.
  await persist();
  if (entry) {
    await repositories.wallets.save(wallet, expectedVersion);
    await repositories.ledger.append(entry);
  }

  if (transaction.status === WagerTransactionStatus.Rejected) {
    await repositories.outbox.add(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(transaction, eventContext()),
        now,
      ),
    );
    return;
  }

  await repositories.outbox.add(
    OutboxMessage.enqueue(
      WagerTransactionProcessed.from(transaction, eventContext()),
      now,
    ),
  );
  if (entry) {
    await repositories.outbox.add(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, entry, eventContext()),
        now,
      ),
    );
  }
  // Quem estava esperando por esta transação (um REFUND esperando a BET, um ROLLBACK esperando o
  // REFUND) tenta já, em vez de esperar o backoff. Mesma transação SQL, mesma wallet.
  await repositories.transactions.wakePendingReferences(
    transaction.providerId,
    transaction.walletId,
    transaction.externalTransactionId,
    now,
  );
}
