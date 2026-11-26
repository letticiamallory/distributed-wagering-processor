import type { FailureCode } from '../../domain/errors/failure-code.js';

// Códigos que só existem na resposta da API. O FailureCode descreve o que fica GRAVADO
// numa transação (coluna failure_code); estes nunca são gravados, então não entram nele.
export const ApiOnlyErrorCode = {
  WalletAlreadyExists: 'WALLET_ALREADY_EXISTS',
  TransactionNotFound: 'TRANSACTION_NOT_FOUND',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type ApiOnlyErrorCode =
  (typeof ApiOnlyErrorCode)[keyof typeof ApiOnlyErrorCode];

// Tudo que pode aparecer em `error.code` na resposta HTTP.
export type ApiErrorCode = FailureCode | ApiOnlyErrorCode;
