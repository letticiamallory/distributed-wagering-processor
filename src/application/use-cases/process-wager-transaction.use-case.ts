import type { FailureCode } from '../../domain/errors/failure-code.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected.js';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { MoneyProps } from '../../domain/money/money.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { computePayloadHash } from '../../domain/wager/wager-payload-hash.js';
import { WagerPolicy } from '../../domain/wager/wager-policy.js';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import {
  type ProcessWagerTransactionCommand,
  parseProcessWagerTransactionCommand,
} from '../commands/process-wager-transaction.command.js';
import {
  ApplicationError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InboxMessageReusedError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
import { ApiOnlyErrorCode } from '../errors/api-error-code.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { InboxReader } from '../ports/inbox-repository.js';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.js';
import type { WagerTransactionReader } from '../ports/wager-transaction-repository.js';

export interface ProcessWagerContext {
  // Header Idempotency-Key (HTTP) ou data.idempotencyKey (SQS). Validado dentro do caso de uso.
  idempotencyKey: unknown;
  correlationId: string;
  // Só quando a entrada vem do SQS.
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  // Saldo da WALLET quando a transação foi decidida, na moeda da wallet (ADR-0006). Em replay
  // é o da época, não o de hoje.
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

// Pedaço que ainda não existe: falha alto e explícito, em vez de fingir (ou de aplicar uma
// regra pela metade). Sai no commit 6 (PENDING_REFERENCE).
export class NotSupportedYetError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.InternalError;
  constructor(readonly feature: string) {
    super(`${feature} is not supported yet`);
  }
}

// Onde a idempotência é consultada: antes da transação (leitores sem lock) e de novo sob o
// lock (os repositórios da transação). Os dois lados têm a mesma forma.
interface Lookups {
  transactions: WagerTransactionReader;
  inbox: InboxReader;
}

// O coração do sistema (ADR-0007 e ADR-0008): uma operação financeira, numa transação só.
//
//   1. valida a entrada e monta o Money (nada de banco)
//   2. calcula o payloadHash
//   3. checagem rápida de idempotência, SEM lock: replay ou conflito
//   4. abre a transação e trava a wallet (inexistente: WALLET_NOT_FOUND, nada gravado)
//   5. repete a checagem de idempotência (e da inbox) SOB o lock
//   6-7. política do domínio (moeda, dono, referência, saldo)
//   8. grava: transação final, saldo com a versão, ledger, eventos e inbox
//   9. commit
//  10. devolve o resultado com o saldo da época
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reader: WagerTransactionReader,
    private readonly inboxReader: InboxReader,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    input: unknown,
    context: ProcessWagerContext,
  ): Promise<ProcessWagerResult> {
    // 1. Entrada inválida nem abre conexão.
    const command = parseProcessWagerTransactionCommand(
      input,
      context.idempotencyKey,
    );

    // 2. Hash dos campos de negócio (ADR-0008).
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    // 3. Caminho rápido: a maioria dos replays termina aqui, sem travar nada.
    const known = await this.findPriorOutcome(command, payloadHash, context, {
      transactions: this.reader,
      inbox: this.inboxReader,
    });
    if (known) {
      return known;
    }

    // 4 a 10.
    return this.uow.run((repositories) =>
      this.processLocked(command, payloadHash, context, repositories),
    );
  }

  private async processLocked(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    context: ProcessWagerContext,
    repositories: Repositories,
  ): Promise<ProcessWagerResult> {
    // 4. A partir daqui ninguém mexe nesta wallet até o commit.
    const wallet = await repositories.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // 5. Outra requisição igual pode ter commitado entre o passo 3 e o lock.
    const known = await this.findPriorOutcome(command, payloadHash, context, {
      transactions: repositories.transactions,
      inbox: repositories.inbox,
    });
    if (known) {
      return known;
    }

    // 6 e 7. O domínio decide; aqui só reunimos o que a política precisa saber.
    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      ...(command.referenceExternalTransactionId !== undefined && {
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
      correlationId: context.correlationId,
      createdAt: now,
    });

    const reference =
      command.referenceExternalTransactionId === undefined
        ? undefined
        : await repositories.transactions.findByProviderAndExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
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
        ? await repositories.transactions.hasSettledWin(reference.id)
        : false;

    const decision = WagerPolicy.decide({
      wallet,
      transaction,
      reference,
      alreadyReversed,
      hasSettledWin,
      attemptsExhausted: false,
    });
    if (decision.type === 'waitForReference') {
      throw new NotSupportedYetError('PENDING_REFERENCE (commit 6)');
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
          entryId: this.ids.next(),
          at: now,
        };
        entry =
          decision.direction === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
      }
      transaction.markProcessed({
        // Uma BET não referencia nada: a referência só vale para WIN e LOSS.
        ...(reference &&
          transaction.kind !== WagerTransactionKind.Bet && {
            referenceTransactionId: reference.id,
          }),
        balanceAfter: wallet.balance,
        at: now,
      });
    }

    // 8. Nesta ordem, por causa das FKs e do trigger de estado final: a transação já nasce no
    //    estado final; depois o saldo (com a versão esperada) e o lançamento que a aponta.
    await repositories.transactions.insert(transaction);
    if (entry) {
      await repositories.wallets.save(wallet, expectedVersion);
      await repositories.ledger.append(entry);
    }

    const eventContext = () => ({
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      causationId: transaction.id,
      occurredAt: now,
    });
    if (transaction.status === WagerTransactionStatus.Rejected) {
      await repositories.outbox.add(
        OutboxMessage.enqueue(
          WagerTransactionRejected.from(transaction, eventContext()),
          now,
        ),
      );
    } else {
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
    }

    if (context.inbox) {
      const message = InboxMessage.receive({
        messageId: context.inbox.messageId,
        consumerName: context.inbox.consumerName,
        payloadHash,
        receivedAt: now,
      });
      // Já passamos pela checagem sob o lock: "não é novo" aqui seria um bug.
      if (!(await repositories.inbox.tryReceive(message))) {
        throw new InboxMessageReusedError(
          context.inbox.consumerName,
          context.inbox.messageId,
        );
      }
      message.markProcessed(now);
      await repositories.inbox.markProcessed(message);
    }

    // 9 e 10. O commit acontece quando o uow.run retorna; o resultado sai com o saldo da época.
    return toResult(transaction, false);
  }

  // A mesma checagem nos passos 3 e 5. Devolve o resultado guardado (replay), lança o conflito
  // certo, ou undefined quando é uma operação nova.
  private async findPriorOutcome(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    context: ProcessWagerContext,
    lookups: Lookups,
  ): Promise<ProcessWagerResult | undefined> {
    if (context.inbox) {
      const received = await lookups.inbox.find(
        context.inbox.consumerName,
        context.inbox.messageId,
      );
      if (received && received.payloadHash !== payloadHash) {
        throw new InboxMessageReusedError(
          context.inbox.consumerName,
          context.inbox.messageId,
        );
      }
    }

    const byKey = await lookups.transactions.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new IdempotencyKeyReusedError(command.idempotencyKey);
      }
      return toResult(byKey, true);
    }

    const byExternalId = await lookups.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byExternalId) {
      throw new ExternalIdConflictError(
        command.providerId,
        command.externalTransactionId,
      );
    }
    return undefined;
  }
}

function toResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): ProcessWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    ...(transaction.balanceAfter && {
      balance: transaction.balanceAfter.toJSON(),
    }),
    idempotentReplay,
  };
}
