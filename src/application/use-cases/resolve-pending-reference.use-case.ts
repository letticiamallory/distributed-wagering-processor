import type { FailureCode } from '../../domain/errors/failure-code.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { PendingReferenceSchedule } from '../../domain/wager/pending-reference-schedule.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import { WalletNotFoundError } from '../errors/application-errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { WagerTransactionReader } from '../ports/wager-transaction-repository.js';
import { settleWagerTransaction } from './settle-wager-transaction.js';

export type ResolvePendingResult =
  // A referência chegou (ou as tentativas acabaram): a transação ficou PROCESSED ou REJECTED.
  | {
      outcome: 'RESOLVED';
      transactionId: string;
      status: WagerTransactionStatus;
      failureCode?: FailureCode;
      balance?: MoneyProps;
    }
  // A referência ainda não chegou e ainda há tentativas: uma a mais, esperando mais.
  | {
      outcome: 'STILL_PENDING';
      transactionId: string;
      attempts: number;
      nextAttemptAt: string;
    }
  // Outro worker (ou outra requisição) já a resolveu: não se toca de novo.
  | {
      outcome: 'NOT_PENDING';
      transactionId: string;
      status: WagerTransactionStatus;
    }
  | { outcome: 'NOT_FOUND'; transactionId: string };

// Resolve UMA transação em PENDING_REFERENCE: o worker da Fase 5 só chama isto. Nunca lança por
// causa do estado da transação (NOT_FOUND, NOT_PENDING e STILL_PENDING são respostas normais);
// só erros de infraestrutura sobem (DEPENDENCY_UNAVAILABLE, e o worker tenta depois sem gastar
// a tentativa, porque nada foi gravado).
//
//   1. lê a transação, sem lock: já resolvida? sai sem abrir transação
//   2. abre a transação e trava a wallet (ADR-0007)
//   3. LÊ DE NOVO sob o lock: outro worker pode ter resolvido entre 1 e 2
//   4. aplica a mesma política da primeira passada (regras, saldo, ledger, eventos)
//   5. grava o estado novo e, se ficou PROCESSED, acorda quem esperava por ela
export class ResolvePendingReferenceUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reader: WagerTransactionReader,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly schedule: PendingReferenceSchedule,
  ) {}

  async execute(
    input: { transactionId: string },
    context: { correlationId: string },
  ): Promise<ResolvePendingResult> {
    const known = await this.reader.findById(input.transactionId);
    if (!known) {
      return { outcome: 'NOT_FOUND', transactionId: input.transactionId };
    }
    if (known.status !== WagerTransactionStatus.PendingReference) {
      return {
        outcome: 'NOT_PENDING',
        transactionId: known.id,
        status: known.status,
      };
    }

    return this.uow.run(async (repositories) => {
      const wallet = await repositories.wallets.lockById(known.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(known.walletId);
      }

      // Sob o lock a leitura é a verdade: quem a resolveu antes já commitou.
      const transaction = await repositories.transactions.findById(known.id);
      if (!transaction) {
        return { outcome: 'NOT_FOUND', transactionId: known.id } as const;
      }
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        return {
          outcome: 'NOT_PENDING',
          transactionId: transaction.id,
          status: transaction.status,
        } as const;
      }

      await settleWagerTransaction(
        { ids: this.ids, schedule: this.schedule },
        repositories,
        {
          wallet,
          transaction,
          now: this.clock.now(),
          correlationId: context.correlationId,
          mode: 'update',
        },
      );

      if (transaction.status === WagerTransactionStatus.PendingReference) {
        return {
          outcome: 'STILL_PENDING',
          transactionId: transaction.id,
          attempts: transaction.attempts,
          nextAttemptAt: (transaction.nextAttemptAt as Date).toISOString(),
        } as const;
      }
      return {
        outcome: 'RESOLVED',
        transactionId: transaction.id,
        status: transaction.status,
        ...(transaction.failureCode && {
          failureCode: transaction.failureCode,
        }),
        ...(transaction.balanceAfter && {
          balance: transaction.balanceAfter.toJSON(),
        }),
      } as const;
    });
  }
}
