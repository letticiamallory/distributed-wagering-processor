import type { FailureCode } from '../../domain/errors/failure-code.js';

// Códigos que só existem na resposta da API. O FailureCode descreve o que fica GRAVADO
// numa transação (coluna failure_code); estes nunca são gravados, então não entram nele.
export const ApiOnlyErrorCode = {
  WalletAlreadyExists: 'WALLET_ALREADY_EXISTS',
  TransactionNotFound: 'TRANSACTION_NOT_FOUND',
  InternalError: 'INTERNAL_ERROR',
  // Autenticação (ADR-0010): quem chama não foi identificado (401), ou foi e não pode agir como
  // o provedor que o corpo diz (403).
  Unauthenticated: 'UNAUTHENTICATED',
  ProviderForbidden: 'PROVIDER_FORBIDDEN',
} as const;

export type ApiOnlyErrorCode =
  (typeof ApiOnlyErrorCode)[keyof typeof ApiOnlyErrorCode];

// Tudo que pode aparecer em `error.code` na resposta HTTP.
export type ApiErrorCode = FailureCode | ApiOnlyErrorCode;
