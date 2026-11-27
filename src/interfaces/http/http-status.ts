import {
  ApiOnlyErrorCode,
  type ApiErrorCode,
} from '../../application/errors/api-error-code.js';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { FailureCode } from '../../domain/errors/failure-code.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';

// Segundos que o provedor deve esperar antes de reenviar a MESMA chave num 503 (padrão; a
// variável RETRY_AFTER_SECONDS troca).
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

// O status HTTP de uma transação que FOI gravada: o estado dela diz o que aconteceu. O replay
// devolve a mesma resposta da primeira vez; só o PROCESSED muda (201 na primeira, 200 no replay),
// porque "criou" só vale uma vez. REJECTED é 422 e não 200: o provedor precisa saber só pelo
// status que a operação NÃO foi aplicada e que reenviar não muda nada.
export function statusOfResult(result: ProcessWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      // FAILED (terminou em falha) e PENDING (nunca é gravado): nenhum dos dois é resposta de
      // sucesso; quem chama transforma em erro 500.
      return 500;
  }
}

// O status de um erro, pelo `code`. O Record obriga a classificar todo código novo: o compilador
// reclama. O mesmo código tem o mesmo status em qualquer rota.
const ERROR_STATUS: Record<ApiErrorCode, number> = {
  // 400: o provedor precisa corrigir o que mandou
  [FailureCode.InvalidPayload]: 400,
  [FailureCode.InvalidAmount]: 400,
  [FailureCode.UnsupportedKind]: 400,
  // 404
  [FailureCode.WalletNotFound]: 404,
  [ApiOnlyErrorCode.TransactionNotFound]: 404,
  // 409: conflito de idempotência ou de unicidade
  [FailureCode.IdempotencyKeyReused]: 409,
  [FailureCode.ExternalIdConflict]: 409,
  [ApiOnlyErrorCode.WalletAlreadyExists]: 409,
  // 422: regras de negócio (hoje só saem como REJECTED, mas o código tem um status só)
  [FailureCode.WalletPlayerMismatch]: 422,
  [FailureCode.CurrencyMismatch]: 422,
  [FailureCode.InsufficientFunds]: 422,
  [FailureCode.ReversalInsufficientFunds]: 422,
  [FailureCode.ReferenceNotFound]: 422,
  [FailureCode.ReferenceMismatch]: 422,
  [FailureCode.ReferenceNotProcessed]: 422,
  [FailureCode.ReferenceKindNotAllowed]: 422,
  [FailureCode.AmountMismatch]: 422,
  [FailureCode.ReferenceAlreadyReversed]: 422,
  [FailureCode.ReferenceSettled]: 422,
  [FailureCode.BalanceLimitExceeded]: 422,
  // 503 e 500
  [FailureCode.DependencyUnavailable]: 503,
  [FailureCode.ProcessingFailed]: 500,
  [ApiOnlyErrorCode.InternalError]: 500,
  // autenticação (ADR-0010): 401 não identificado, 403 identificado mas sem o provedor do corpo
  [ApiOnlyErrorCode.Unauthenticated]: 401,
  [ApiOnlyErrorCode.ProviderForbidden]: 403,
};

export function statusOfError(code: ApiErrorCode): number {
  return ERROR_STATUS[code];
}
