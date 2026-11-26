import type { LoggerService } from '@nestjs/common';
import { InvalidEnvironmentError } from '../../config/env-integer.js';
import { currentLogContext } from './log-context.js';

// Logs estruturados (ADR-0014): UMA linha, UM objeto JSON, com `time`, `level`, `context` e os
// campos do evento. É o LoggerService do Nest, então o que a aplicação já loga como objeto
// ({ event: '...', ... }) vira os campos da linha, e o que o framework loga como texto vira
// `message`. Zero dependências.
//
// O que NUNCA entra numa linha (defesa em profundidade; o código já loga só identificadores):
//   - campos de dinheiro e de corpo, por NOME, em qualquer profundidade: money, amount, balance*,
//     *balance, payload, body, data, e tudo o que parece segredo (authorization, token, password...)
//   - strings longas (cortadas em 500 caracteres): um payload inteiro colado numa mensagem
//     não sai inteiro

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export function loadLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.LOG_LEVEL?.trim();
  if (raw === undefined || raw === '') {
    return 'info';
  }
  if (raw in RANK) {
    return raw as LogLevel;
  }
  throw new InvalidEnvironmentError(
    `LOG_LEVEL must be one of ${Object.keys(RANK).join(', ')} (got "${raw}")`,
  );
}

const REDACTED = '[redacted]';
const MAX_STRING = 500;
const MAX_DEPTH = 6;

const EXACT_SENSITIVE = new Set(['money', 'amount', 'payload', 'body', 'data']);
const SENSITIVE_PARTS = [
  'authorization',
  'password',
  'secret',
  'token',
  'cookie',
  'apikey',
];

function isSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return (
    EXACT_SENSITIVE.has(normalized) ||
    normalized.startsWith('balance') ||
    normalized.endsWith('balance') ||
    SENSITIVE_PARTS.some((part) => normalized.includes(part))
  );
}

function clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`
      : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[too deep]';
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: clean(value.message, depth + 1, seen),
      };
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => clean(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitive(key) ? REDACTED : clean(inner, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const STACK_LIKE = /^\s*(?:Error|\w+Error)?.*\n?\s+at /;

export class JsonLogger implements LoggerService {
  constructor(
    readonly write: (line: string) => void = (line) =>
      process.stdout.write(`${line}\n`),
    private readonly minLevel: LogLevel = 'debug',
  ) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (RANK[level] < RANK[this.minLevel]) {
      return;
    }
    try {
      this.write(JSON.stringify(this.build(level, message, rest)));
    } catch {
      // Um log nunca derruba quem logou.
      this.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          event: 'log_serialization_failed',
        }),
      );
    }
  }

  private build(
    level: LogLevel,
    message: unknown,
    rest: unknown[],
  ): Record<string, unknown> {
    const { context, stack } = interpret(level, rest);
    const store = currentLogContext();

    const fields: Record<string, unknown> = {};
    if (message instanceof Error) {
      fields.errorName = message.name;
      fields.message = clean(message.message, 1, new WeakSet());
      fields.stack ??= message.stack;
    } else if (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message)
    ) {
      Object.assign(
        fields,
        clean(message, 0, new WeakSet()) as Record<string, unknown>,
      );
    } else {
      fields.message = clean(
        typeof message === 'string' ? message : JSON.stringify(message),
        1,
        new WeakSet(),
      );
    }

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      ...(context !== undefined && { context }),
    };
    if (store) {
      entry.correlationId = store.correlationId;
      Object.assign(entry, clean(store.fields, 1, new WeakSet()));
    }
    // O que a própria linha diz vale mais do que o contexto em volta.
    Object.assign(entry, fields);
    if (stack !== undefined && entry.stack === undefined) {
      entry.stack = stack;
    }
    return entry;
  }
}

// A convenção do Nest: o ÚLTIMO argumento texto é o contexto; em error/fatal o argumento antes
// dele é a stack.
function interpret(
  level: LogLevel,
  rest: unknown[],
): { context?: string; stack?: string } {
  const strings = rest.filter(
    (item): item is string => typeof item === 'string',
  );
  if (strings.length === 0) {
    return {};
  }
  if (level === 'error' || level === 'fatal') {
    if (strings.length >= 2) {
      return { stack: strings[0] as string, context: strings.at(-1) as string };
    }
    const only = strings[0] as string;
    return STACK_LIKE.test(only) ? { stack: only } : { context: only };
  }
  return { context: strings.at(-1) as string };
}
