import type { FailureCode } from '../../domain/errors/failure-code.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { computePayloadHash } from '../../domain/wager/wager-payload-hash.js';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import {
  type ProcessWagerTransactionCommand,
  parseProcessWagerTransactionCommand,
} from '../commands/process-wager-transaction.command.js';
import {
  DuplicateKeyError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InboxMessageReusedError,
  UnresolvedIdempotencyRaceError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { InboxReader } from '../ports/inbox-repository.js';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.js';
import type { WagerTransactionReader } from '../ports/wager-transaction-repository.js';
import { settleWagerTransaction } from './settle-wager-transaction.js';

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

// Onde a idempotência é consultada: antes da transação (leitores sem lock) e de novo sob o
// lock (os repositórios da transação). Os dois lados têm a mesma forma.
interface Lookups {
  transactions: WagerTransactionReader;
  inbox: InboxReader;
}

// As duas constraints UNIQUE que significam "outra requisição, de outra wallet, gravou a mesma
// chave (ou o mesmo id externo) entre as nossas checagens e a nossa gravação". As checagens de
// idempotência rodam SOB o lock de UMA wallet; duas wallets diferentes não se travam entre si,
// então só o índice único as separa. Qualquer outro 23505 é bug.
const IDEMPOTENCY_RACE_CONSTRAINTS = new Set([
  'uq_wtx_idempotency_key',
  'uq_wtx_provider_external',
]);

const isIdempotencyRace = (error: unknown): error is DuplicateKeyError =>
  error instanceof DuplicateKeyError &&
  IDEMPOTENCY_RACE_CONSTRAINTS.has(error.constraint);

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
    private readonly schedule: PendingReferenceSchedule,
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

    // 3 a 10, com UMA reexecução se a corrida do 23505 acontecer: a transação do banco foi
    // desfeita, nada ficou, e a segunda passada enxerga a linha da vencedora (replay ou o 409
    // certo). Um segundo 23505 não pode acontecer: é bug, com log crítico.
    try {
      return await this.attempt(command, payloadHash, context);
    } catch (error) {
      if (!isIdempotencyRace(error)) {
        throw error;
      }
    }
    try {
      return await this.attempt(command, payloadHash, context);
    } catch (error) {
      throw isIdempotencyRace(error)
        ? new UnresolvedIdempotencyRaceError(error)
        : error;
    }
  }

  private async attempt(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    context: ProcessWagerContext,
  ): Promise<ProcessWagerResult> {
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

    // 6 a 8. O domínio decide e o módulo comum grava (a mesma lógica da resolução de uma
    //        pendente): transação no estado em que ficou, saldo, ledger, eventos e o acordar.
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
    await settleWagerTransaction(
      { ids: this.ids, schedule: this.schedule },
      repositories,
      {
        wallet,
        transaction,
        now,
        correlationId: context.correlationId,
        mode: 'insert',
      },
    );

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
