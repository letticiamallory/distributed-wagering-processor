// Relógio injetado: o domínio e os casos de uso nunca chamam new Date() sozinhos, então os
// testes controlam o tempo (backoff, nextAttemptAt, processedAt).
export abstract class Clock {
  abstract now(): Date;
}
