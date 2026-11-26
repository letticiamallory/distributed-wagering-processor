export interface ReservedPending {
  transactionId: string;
  walletId: string;
}

// Quem reserva o trabalho do worker de PENDING_REFERENCE. SEM o lock da wallet: só escreve a coluna
// de agendamento (next_attempt_at); toda DECISÃO é do ResolvePendingReferenceUseCase, sob o lock.
export abstract class PendingReferenceQueue {
  abstract reserveDue(
    limit: number,
    leaseMs: number,
    now: Date,
  ): Promise<ReservedPending[]>;
}
