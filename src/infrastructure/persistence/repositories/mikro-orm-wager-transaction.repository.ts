import type { EntityManager } from '@mikro-orm/postgresql';
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

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId: transactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  // WIN PROCESSED que aponta para a BET, que PAGOU alguma coisa (valor > 0) e que ninguém
  // reverteu com sucesso. "Liquidada" quer dizer que o jogador recebeu dinheiro: um WIN
  // REJECTED não pagou nada, um WIN revertido devolveu o prêmio, e um WIN de 0.00 (como a
  // LOSS) nunca pagou; nesses casos a BET pode ser revertida (ADR-0005).
  async hasSettledWin(betTransactionId: string): Promise<boolean> {
    const rows = (await this.em.getConnection().execute(
      `SELECT EXISTS (
           SELECT 1 FROM wager_transactions win
           WHERE win.reference_transaction_id = ?
             AND win.kind = 'WIN' AND win.status = 'PROCESSED'
             AND win.amount > 0
             AND NOT EXISTS (
               SELECT 1 FROM wager_transactions reversal
               WHERE reversal.reference_transaction_id = win.id
                 AND reversal.status = 'PROCESSED'
                 AND reversal.kind IN ('REFUND', 'ROLLBACK')
             )
         ) AS settled`,
      [betTransactionId],
      'all',
      this.em.getTransactionContext(),
    )) as Array<{ settled: boolean }>;
    return rows[0]?.settled === true;
  }

  // Busca por (provedor, id EXTERNO da referência): uma PENDING_REFERENCE ainda não tem
  // reference_transaction_id. Só mexe nas que estão esperando; as finais o trigger recusaria.
  wakePendingReferences(
    providerId: string,
    referenceExternalTransactionId: string,
    at: Date,
  ): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionEntity,
      {
        providerId,
        referenceExternalTransactionId,
        status: 'PENDING_REFERENCE',
      },
      { nextAttemptAt: at },
    );
  }
}
