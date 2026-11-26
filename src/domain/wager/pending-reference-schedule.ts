import { DomainError } from '../errors/domain-error.js';

export class InvalidPendingReferenceScheduleError extends DomainError {}

export interface PendingReferenceScheduleOptions {
  // Limite TOTAL de tentativas de resolver a referência. A 1ª gravação como PENDING_REFERENCE
  // conta como a 1ª tentativa.
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULTS = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
} as const;

// A política de espera de uma transação que aponta para uma referência que ainda não chegou
// (ADR-0013). Pura: não lê relógio nem banco; quem chama passa "agora" e quantas vezes já tentou.
//
//   espera depois da tentativa n  =  min(base x 2^n, teto)        (n = tentativas já feitas)
//   a tentativa é a última        =  tentativas já feitas + 1 >= limite
//
// Com os padrões (10, 1 s, 5 min) são 9 esperas: 1+2+4+...+256 = 511 s, cerca de 8,5 minutos.
export class PendingReferenceSchedule {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;

  constructor(options: PendingReferenceScheduleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;

    for (const [name, value] of Object.entries({
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new InvalidPendingReferenceScheduleError(
          `${name} must be an integer greater than zero (got ${String(value)})`,
        );
      }
    }
    if (this.maxDelayMs < this.baseDelayMs) {
      throw new InvalidPendingReferenceScheduleError(
        `maxDelayMs (${this.maxDelayMs}) cannot be smaller than baseDelayMs (${this.baseDelayMs})`,
      );
    }
  }

  // Esta é a última tentativa? (Depois dela, sem referência, a transação é REJECTED.)
  isExhausted(attempts: number): boolean {
    PendingReferenceSchedule.assertAttempts(attempts);
    return attempts + 1 >= this.maxAttempts;
  }

  delayMs(attempts: number): number {
    PendingReferenceSchedule.assertAttempts(attempts);
    // O expoente é limitado antes: 2^100000 seria Infinity (e base x Infinity também), mas
    // 2^52 já passa de qualquer teto razoável, então o resultado é o mesmo sem depender disso.
    return Math.min(
      this.baseDelayMs * 2 ** Math.min(attempts, 52),
      this.maxDelayMs,
    );
  }

  nextAttemptAt(now: Date, attempts: number): Date {
    return new Date(now.getTime() + this.delayMs(attempts));
  }

  private static assertAttempts(attempts: number): void {
    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new InvalidPendingReferenceScheduleError(
        `attempts must be a non-negative integer (got ${String(attempts)})`,
      );
    }
  }
}
