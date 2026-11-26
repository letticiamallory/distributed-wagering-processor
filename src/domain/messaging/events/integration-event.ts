import { deepFreeze } from '../deep-freeze.js';
import { InvalidIntegrationEventError } from '../messaging.errors.js';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

// Envelope comum. O data de cada evento só carrega strings, números e MoneyProps: o
// payload da outbox tem de ser um JSON estável e versionável, nunca uma instância de classe.
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const [field, value] of Object.entries({
      eventId: props.eventId,
      aggregateId: props.aggregateId,
      correlationId: props.correlationId,
    })) {
      if (value.trim() === '') {
        throw new InvalidIntegrationEventError(`${field} cannot be empty`);
      }
    }
    if (Number.isNaN(props.occurredAt.getTime())) {
      throw new InvalidIntegrationEventError('occurredAt is not a valid date');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = deepFreeze(props.data);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      // Sem causationId a chave some, em vez de virar "undefined" no JSON.
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
