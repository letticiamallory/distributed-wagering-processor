// Os valores são os mesmos do CHECK ck_wtx_status do schema.
export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada (só existe dentro da transação SQL)
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violou regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}
