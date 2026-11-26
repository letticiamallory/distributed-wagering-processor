import { ApiOnlyErrorCode } from '../../application/errors/api-error-code.js';
import { ApplicationError } from '../../application/errors/application-errors.js';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction.use-case.js';

// A chave de idempotência aponta para uma transação que terminou em FAILED. Não é um erro NOVO:
// é a resposta guardada (o replay devolve a mesma resposta da primeira vez), e ela é uma falha.
// Reenviar a mesma chave devolve sempre isto, então não é reenviável: 500, retryable false, com o
// failureCode que ficou gravado e o id da transação para o suporte achar a linha.
export class StoredFailureReplayError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.InternalError;
  constructor(readonly result: ProcessWagerResult) {
    super(
      `Transaction ${result.transactionId} ended in failure (${result.failureCode ?? 'unknown'})`,
    );
  }
}
