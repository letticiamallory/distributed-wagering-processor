import { AsyncLocalStorage } from 'node:async_hooks';

// Os campos que acompanham TODO log feito durante uma requisição, uma mensagem ou um item de
// worker, sem passar por parâmetro: o correlationId e os identificadores que já se conhecem
// (transactionId, walletId, providerId, messageId). Só identificadores: nunca o corpo.
export type LogFieldValue = string | number | boolean;

export interface LogContext {
  correlationId: string;
  fields: Record<string, LogFieldValue>;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(
  correlationId: string,
  fields: Record<string, LogFieldValue>,
  work: () => T,
): T {
  return storage.run({ correlationId, fields: { ...fields } }, work);
}

// Acrescenta identificadores ao contexto em andamento (se houver um).
export function addLogFields(fields: Record<string, LogFieldValue>): void {
  const context = storage.getStore();
  if (context) {
    Object.assign(context.fields, fields);
  }
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}
