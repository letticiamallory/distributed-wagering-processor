import { FailureCode } from '../../domain/errors/failure-code.js';
import { ApiOnlyErrorCode, type ApiErrorCode } from './api-error-code.js';

// Base dos erros da camada de aplicação. Cada um diz o `code` que a API devolve e se o
// provedor pode reenviar a MESMA chave depois (retryable). Quem traduz para HTTP é o
// ExceptionFilter (camada interfaces); aqui não existe status HTTP.
export abstract class ApplicationError extends Error {
  abstract readonly code: ApiErrorCode;
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface InvalidCommandDetail {
  path: string;
  message: string;
}

// Payload inválido (400): o provedor precisa corrigir antes de reenviar.
export class InvalidCommandError extends ApplicationError {
  constructor(
    readonly code:
      | FailureCode.InvalidPayload
      | FailureCode.InvalidAmount
      | FailureCode.UnsupportedKind,
    message: string,
    readonly details: InvalidCommandDetail[],
  ) {
    super(message);
  }
}

// A mesma Idempotency-Key já foi usada com outro conteúdo (409).
export class IdempotencyKeyReusedError extends ApplicationError {
  readonly code = FailureCode.IdempotencyKeyReused;
  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency key "${idempotencyKey}" was already used with a different payload`,
    );
  }
}

// O mesmo messageId chegou com um conteúdo diferente: bug do produtor, não do provedor
// final. Erro PERMANENTE (a Fase 5 manda para a DLQ): reenviar não resolve, e processar
// poderia aplicar a operação errada.
export class InboxMessageReusedError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.InternalError;
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(
      `Message ${messageId} of consumer ${consumerName} was already received with a different payload`,
    );
  }
}

// O (provedor, id externo) já existe com outra chave de idempotência (409).
export class ExternalIdConflictError extends ApplicationError {
  readonly code = FailureCode.ExternalIdConflict;
  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(
      `Transaction ${externalTransactionId} of provider ${providerId} already exists under another idempotency key`,
    );
  }
}

// Wallet inexistente (404). Nada é gravado: não há linha de transação para uma wallet
// que não existe (a FK impede), então esta resposta nunca vira replay.
export class WalletNotFoundError extends ApplicationError {
  readonly code = FailureCode.WalletNotFound;
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} was not found`);
  }
}

// Já existe wallet deste jogador nesta moeda (409).
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.WalletAlreadyExists;
  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

// Consulta por uma transação que não existe (404).
export class TransactionNotFoundError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.TransactionNotFound;
  constructor(readonly identifier: string) {
    super(`Transaction ${identifier} was not found`);
  }
}

// Falha transitória de infraestrutura (503): banco fora, lock_timeout, deadlock, pool cheio.
// Nada foi gravado; o provedor reenvia a mesma chave com segurança (ADR-0007 e ADR-0008).
export class DependencyUnavailableError extends ApplicationError {
  readonly code = FailureCode.DependencyUnavailable;
  override readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

// Sinal da infraestrutura: uma constraint UNIQUE recusou a gravação. O caso de uso decide
// pela constraint (corrida de idempotência roda de novo; as outras são bug). Se escapar,
// vira 500: o banco fez o trabalho dele e o código tem um bug.
export class DuplicateKeyError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.InternalError;
  constructor(
    readonly constraint: string,
    cause?: unknown,
  ) {
    super(`Unique constraint violated: ${constraint}`, { cause });
  }
}

// O UPDATE da wallet com a version esperada não afetou 1 linha. Com o lock isto não
// deveria acontecer: é bug (500).
export class ConcurrentWalletUpdateError extends ApplicationError {
  readonly code = ApiOnlyErrorCode.InternalError;
  constructor(
    readonly walletId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Wallet ${walletId} was not at version ${expectedVersion} when it was saved`,
    );
  }
}
