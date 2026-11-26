import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';

// Leitura sem transação nem lock: o caminho rápido da idempotência e as consultas HTTP.
export abstract class WagerTransactionReader {
  abstract findById(id: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  // Também resolve a referência de uma reversão: (provedor, id externo da referência).
  abstract findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
}

// Versão ligada à transação do UnitOfWork: lê e grava dentro dela.
export abstract class WagerTransactionRepository extends WagerTransactionReader {
  // A transação entra já no estado final (o trigger proíbe UPDATE depois). Em violação de
  // UNIQUE lança DuplicateKeyError com o nome da constraint.
  abstract insert(transaction: WagerTransaction): Promise<void>;

  // Existe uma reversão (REFUND ou ROLLBACK) PROCESSED apontando para esta transação?
  abstract hasProcessedReversal(transactionId: string): Promise<boolean>;

  // Esta BET tem um WIN PROCESSED apontando para ela, sem reversão PROCESSED desse WIN?
  abstract hasSettledWin(betTransactionId: string): Promise<boolean>;

  // "Acorda" as PENDING_REFERENCE que esperam por esta referência: next_attempt_at = at.
  // Busca por (provedor, id externo da referência), porque uma PENDING_REFERENCE ainda não
  // tem reference_transaction_id. Devolve quantas acordou.
  abstract wakePendingReferences(
    providerId: string,
    referenceExternalTransactionId: string,
    at: Date,
  ): Promise<number>;
}
