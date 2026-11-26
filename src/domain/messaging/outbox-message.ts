import { deepFreeze } from './deep-freeze.js';
import type { IntegrationEvent } from './events/integration-event.js';
import { InvalidOutboxMessageError } from './messaging.errors.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60 * 1_000;
// Quanto o jitter pode encurtar a espera (20%). Só encurta: assim o teto de 5 minutos
// continua valendo e, mesmo no teto, publishers diferentes não voltam todos juntos.
const MAX_JITTER_REDUCTION = 0.2;
const MAX_ERROR_LENGTH = 1_000;

// Evento gravado na mesma transação do negócio e publicado depois. Desvio do esqueleto do
// enunciado: nextAttemptAt é obrigatório (a coluna é NOT NULL), então nasce já "devida".
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>, now: Date): OutboxMessage {
    // JSON.parse(JSON.stringify(...)) garante um objeto simples e independente do evento.
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<
      string,
      unknown
    >;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze(payload),
      event.occurredAt,
      0,
      now,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending('published');
    this._publishedAt = at;
  }

  // nextAttemptAt = now + min(2^attempts x 1s, 5min), encurtado em até 20% pelo jitter.
  // jitter é um número em [0, 1] vindo de fora: o domínio não sorteia nem lê relógio.
  scheduleRetry(now: Date, jitter: number, error?: string): void {
    this.assertPending('retried');
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
      throw new InvalidOutboxMessageError(
        `jitter must be a number between 0 and 1, received ${String(jitter)}`,
      );
    }
    // O expoente é limitado só para 2 ** n não estourar com attempts absurdos.
    const exponential = BASE_DELAY_MS * 2 ** Math.min(this._attempts, 20);
    const base = Math.min(exponential, MAX_DELAY_MS);
    const delay = Math.round(base * (1 - MAX_JITTER_REDUCTION * jitter));
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    if (error !== undefined) {
      this._lastError = error.slice(0, MAX_ERROR_LENGTH);
    }
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError(
        `Outbox message ${this.id} was already published and cannot be ${action}`,
      );
    }
  }
}
