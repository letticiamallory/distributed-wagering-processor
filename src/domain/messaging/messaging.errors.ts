import { DomainError } from '../errors/domain-error.js';

export class InvalidInboxMessageError extends DomainError {}
export class InvalidOutboxMessageError extends DomainError {}
export class InvalidIntegrationEventError extends DomainError {}
