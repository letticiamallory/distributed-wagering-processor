// Taxonomia de failureCode: estável, legível por máquina, suficiente para o provedor
// decidir se reenvia, corrige o payload ou desiste (enunciado 7.2).
export enum FailureCode {
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidAmount = 'INVALID_AMOUNT',
  UnsupportedKind = 'UNSUPPORTED_KIND',
  IdempotencyKeyReused = 'IDEMPOTENCY_KEY_REUSED',
  ExternalIdConflict = 'EXTERNAL_ID_CONFLICT',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  // BET que já tem um WIN PROCESSED (e não revertido) não pode ser revertida: o jogador
  // ficaria com o prêmio e com a aposta de volta (ADR-0005).
  ReferenceSettled = 'REFERENCE_SETTLED',
  DependencyUnavailable = 'DEPENDENCY_UNAVAILABLE',
}

export type FailureCategory =
  'validation' | 'idempotency' | 'business' | 'transient';

export interface FailureCodeInfo {
  category: FailureCategory;
  // true: o provedor pode reenviar a MESMA chave depois (com backoff). Nos demais, reenviar
  // sem mudar nada dá o mesmo resultado.
  retryable: boolean;
}

const validation: FailureCodeInfo = {
  category: 'validation',
  retryable: false,
};
const idempotency: FailureCodeInfo = {
  category: 'idempotency',
  retryable: false,
};
const business: FailureCodeInfo = { category: 'business', retryable: false };

// Record<FailureCode, ...> obriga a classificar todo código novo: o compilador reclama.
const INFO: Record<FailureCode, FailureCodeInfo> = {
  [FailureCode.InvalidPayload]: validation,
  [FailureCode.InvalidAmount]: validation,
  [FailureCode.UnsupportedKind]: validation,
  [FailureCode.IdempotencyKeyReused]: idempotency,
  [FailureCode.ExternalIdConflict]: idempotency,
  [FailureCode.WalletNotFound]: business,
  [FailureCode.WalletPlayerMismatch]: business,
  [FailureCode.CurrencyMismatch]: business,
  [FailureCode.InsufficientFunds]: business,
  [FailureCode.ReversalInsufficientFunds]: business,
  [FailureCode.ReferenceNotFound]: business,
  [FailureCode.ReferenceMismatch]: business,
  [FailureCode.ReferenceNotProcessed]: business,
  [FailureCode.ReferenceKindNotAllowed]: business,
  [FailureCode.AmountMismatch]: business,
  [FailureCode.ReferenceAlreadyReversed]: business,
  [FailureCode.ReferenceSettled]: business,
  [FailureCode.DependencyUnavailable]: {
    category: 'transient',
    retryable: true,
  },
};

export function failureCodeInfo(code: FailureCode): FailureCodeInfo {
  return INFO[code];
}

export function isRetryable(code: FailureCode): boolean {
  return INFO[code].retryable;
}
