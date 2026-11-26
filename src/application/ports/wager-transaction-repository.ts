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

  // Grava o novo estado de uma transação que ESTAVA em PENDING_REFERENCE (outra tentativa, ou o
  // estado final). Só as colunas que mudam com o estado; o que o provedor mandou nunca é
  // reescrito. Se a linha não existe ou já não está em PENDING_REFERENCE, lança
  // ConcurrentTransactionUpdateError: com o lock da wallet isso é bug.
  abstract update(transaction: WagerTransaction): Promise<void>;

  // "Acorda" as PENDING_REFERENCE desta WALLET que esperam por esta referência:
  // next_attempt_at = at. Busca por (provedor, id externo da referência), porque uma
  // PENDING_REFERENCE ainda não tem reference_transaction_id. Só a mesma wallet: é um caso da
  // regra do ADR-0007 (toda gravação em wager_transactions de uma wallet acontece com o lock
  // dela, e quem chama já o tem). Devolve quantas acordou.
  abstract wakePendingReferences(
    providerId: string,
    walletId: string,
    referenceExternalTransactionId: string,
    at: Date,
  ): Promise<number>;
}
