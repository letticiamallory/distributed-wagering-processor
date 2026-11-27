import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrentTransactionUpdateError } from '../../../application/errors/application-errors.js';
import { WagerTransactionRepository } from '../../../application/ports/wager-transaction-repository.js';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction.js';
import { WagerTransactionEntity } from '../entities.js';
import { transactionToRow } from '../mappers.js';
import { findTransaction } from './mikro-orm-wager-transaction.reader.js';

// Versão ligada à transação do UnitOfWork (o `em` já é o da transação).
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return findTransaction(this.em, { id });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return findTransaction(this.em, { idempotencyKey });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return findTransaction(this.em, { providerId, externalTransactionId });
  }

  // Entra já no estado final: o trigger proíbe UPDATE depois. A violação de UNIQUE sobe
  // como erro do driver e o UnitOfWork a traduz para DuplicateKeyError.
  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionEntity, transactionToRow(transaction));
  }

  // Só o que o estado muda: status, tentativas, próximo horário, código de falha, saldo da época,
  // referência resolvida e processed_at. A guarda `status = PENDING_REFERENCE` faz o UPDATE
  // não afetar nenhuma linha se outra instância já resolveu a transação.
  async update(transaction: WagerTransaction): Promise<void> {
    const row = transactionToRow(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionEntity,
      { id: transaction.id, status: 'PENDING_REFERENCE' },
      {
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        failureCode: row.failureCode,
        balanceAfter: row.balanceAfter,
        referenceTransactionId: row.referenceTransactionId,
        processedAt: row.processedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrentTransactionUpdateError(transaction.id);
    }
  }

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId: transactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  // WIN PROCESSED que PAGOU alguma coisa (valor > 0), que ninguém reverteu com sucesso, e que é
  // desta BET: aponta para ela, OU não aponta para nada e é da mesma wallet, do mesmo provedor e
  // da mesma rodada (o enunciado diz que o WIN "pode" referenciar a BET; sem isso, um WIN sem
  // referência deixava devolver a aposta e o jogador ficava com os dois). Um WIN que aponta para
  // OUTRA BET liquida aquela, não esta. "Liquidada" quer dizer que o jogador recebeu dinheiro: um
  // WIN REJECTED não pagou nada, um WIN revertido devolveu o prêmio, e um WIN de 0.00 (como a
  // LOSS) nunca pagou; nesses casos a BET pode ser revertida (ADR-0005).
  async hasSettledWin(
    bet: Pick<WagerTransaction, 'id' | 'walletId' | 'providerId' | 'roundId'>,
  ): Promise<boolean> {
    const rows = (await this.em.getConnection().execute(
      `SELECT EXISTS (
           SELECT 1 FROM wager_transactions win
           WHERE (win.reference_transaction_id = ?
                  OR (win.reference_transaction_id IS NULL
                      AND win.wallet_id = ?
                      AND win.provider_id = ?
                      AND win.round_id = ?))
             AND win.kind = 'WIN' AND win.status = 'PROCESSED'
             AND win.amount > 0
             AND NOT EXISTS (
               SELECT 1 FROM wager_transactions reversal
               WHERE reversal.reference_transaction_id = win.id
                 AND reversal.status = 'PROCESSED'
                 AND reversal.kind IN ('REFUND', 'ROLLBACK')
             )
         ) AS settled`,
      [bet.id, bet.walletId, bet.providerId, bet.roundId],
      'all',
      this.em.getTransactionContext(),
    )) as Array<{ settled: boolean }>;
    return rows[0]?.settled === true;
  }

  // Busca por (provedor, id EXTERNO da referência): uma PENDING_REFERENCE ainda não tem
  // reference_transaction_id. Só mexe nas que estão esperando (as finais o trigger recusaria) e
  // só nas da MESMA wallet, que quem chama já travou (ADR-0007).
  wakePendingReferences(
    providerId: string,
    walletId: string,
    referenceExternalTransactionId: string,
    at: Date,
  ): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionEntity,
      {
        providerId,
        walletId,
        referenceExternalTransactionId,
        status: 'PENDING_REFERENCE',
      },
      { nextAttemptAt: at },
    );
  }
}
