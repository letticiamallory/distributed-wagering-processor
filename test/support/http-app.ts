import {
  Logger,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { connect } from 'node:net';
import { AppModule } from '../../src/app.module.js';
import { openPersistence, uuid, type Persistence } from './persistence.js';

export type Json = Record<string, unknown>;

export interface HttpResult {
  status: number;
  headers: Headers;
  // O corpo já interpretado quando é JSON; undefined quando vazio.
  body: Json | undefined;
  text: string;
}

export interface LogEntry {
  level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  message: unknown;
  // Tudo que veio depois da mensagem (o Nest manda o contexto por último).
  rest: unknown[];
}

// Registra o que a aplicação logou, para os testes conferirem o NÍVEL de cada erro.
export class LogSpy implements LoggerService {
  entries: LogEntry[] = [];
  private add(level: LogEntry['level'], message: unknown, rest: unknown[]) {
    this.entries.push({ level, message, rest });
  }
  log(message: unknown, ...rest: unknown[]) {
    this.add('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.add('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.add('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.add('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.add('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.add('fatal', message, rest);
  }
  at(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
  // Tudo que mencionou o texto (a mensagem ou qualquer argumento), em qualquer nível.
  mentioning(text: string): LogEntry[] {
    return this.entries.filter((entry) =>
      JSON.stringify([entry.message, ...entry.rest]).includes(text),
    );
  }
  clear() {
    this.entries = [];
  }
}

// Um espião só para o processo: o Logger do Nest é estático (useLogger vale para todos os apps).
export const sharedLogs = new LogSpy();

export interface StartOptions {
  // Variáveis de ambiente só durante a vida deste app (restauradas no close).
  env?: Record<string, string>;
  // Troca de provedores (injeção de falha): [token, valor].
  overrides?: Array<[token: unknown, value: unknown]>;
}

export interface TestApp {
  url: string;
  logs: LogSpy;
  // Segunda conexão ao MESMO banco de teste, para o teste conferir o que ficou gravado.
  db: Persistence;
  sql: (
    query: string,
    params?: unknown[],
  ) => Promise<Array<Record<string, unknown>>>;
  request(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    },
  ): Promise<HttpResult>;
  post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResult>;
  get(path: string, headers?: Record<string, string>): Promise<HttpResult>;
  // Manda os bytes como estão (para cabeçalho repetido, que o fetch junta sozinho).
  rawHttp(requestText: string): Promise<HttpResult>;
  close(): Promise<void>;
}

// A aplicação inteira (AppModule), ouvindo numa porta real, contra o Postgres de teste: é o que
// o provedor enxerga. Nada de mock de banco; só a injeção de falha opcional por `overrides`.
export async function startApp(options: StartOptions = {}): Promise<TestApp> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(options.env ?? {})) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  const restoreEnv = () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  const db = await openPersistence();
  const logs = sharedLogs;
  let app: INestApplication | undefined;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const [token, value] of options.overrides ?? []) {
      builder = builder.overrideProvider(token as never).useValue(value);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    app.useLogger(logs);
    await app.listen(0);
  } catch (error) {
    // O compile() do Nest reinstala o logger de teste do próprio Nest, mesmo quando a subida
    // falha: devolve o espião, para o app que já está no ar continuar sendo observado.
    Logger.overrideLogger(logs);
    restoreEnv();
    await db.close();
    throw error;
  }
  const running = app;
  const url = await running.getUrl();

  async function request(
    method: string,
    path: string,
    init: {
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const hasBody = init.raw !== undefined || init.body !== undefined;
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(hasBody && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(hasBody && {
        body: init.raw ?? JSON.stringify(init.body),
      }),
    });
    return toResult(response.status, response.headers, await response.text());
  }

  function rawHttp(requestText: string): Promise<HttpResult> {
    const { port } = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(port) });
      let data = '';
      socket.on('connect', () => socket.write(requestText));
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('error', reject);
      socket.on('close', () => {
        const [head = '', ...bodyParts] = data.split('\r\n\r\n');
        const [statusLine = '', ...headerLines] = head.split('\r\n');
        const headers = new Headers();
        for (const line of headerLines) {
          const index = line.indexOf(':');
          if (index > 0) {
            headers.append(line.slice(0, index), line.slice(index + 1).trim());
          }
        }
        resolve(
          toResult(
            Number(statusLine.split(' ')[1]),
            headers,
            bodyParts.join('\r\n\r\n'),
          ),
        );
      });
    });
  }

  return {
    url,
    logs,
    db,
    sql: (query, params = []) =>
      db.orm.em.getConnection().execute(query, params) as Promise<
        Array<Record<string, unknown>>
      >,
    request,
    post: (path, body, headers) =>
      request('POST', path, { body, headers: headers ?? {} }),
    get: (path, headers) => request('GET', path, { headers: headers ?? {} }),
    rawHttp,
    close: async () => {
      try {
        await running.close();
        await db.close();
      } finally {
        Logger.overrideLogger(logs);
        restoreEnv();
      }
    },
  };
}

function toResult(status: number, headers: Headers, text: string): HttpResult {
  let body: Json | undefined;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = undefined;
    }
  }
  return { status, headers, body, text };
}

// ---- atalhos dos testes

export const newPlayerId = (): string => uuid();

export async function createWalletVia(
  app: TestApp,
  balance = '100.00',
  currency = 'BRL',
): Promise<{ id: string; playerId: string }> {
  const playerId = newPlayerId();
  const response = await app.post('/wallets', {
    playerId,
    initialBalance: { amount: balance, currency },
  });
  if (response.status !== 201) {
    throw new Error(
      `POST /wallets answered ${response.status}: ${response.text}`,
    );
  }
  return { id: String(response.body?.id), playerId };
}

let sequence = 0;
export const nextExternalId = (): string => `ext-http-${uuid()}-${++sequence}`;

export function wagerBody(
  wallet: { id: string; playerId: string },
  overrides: Json = {},
): Json {
  return {
    providerId: 'provider-a',
    externalTransactionId: nextExternalId(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

// O padrão recomendado pelo enunciado: "{providerId}:{externalTransactionId}".
export const defaultKeyOf = (body: Json): string =>
  `${String(body.providerId)}:${String(body.externalTransactionId)}`;

export function submitVia(
  app: TestApp,
  body: Json,
  key: string | null = defaultKeyOf(body),
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return app.post('/wagering/transactions', body, {
    ...(key !== null && { 'idempotency-key': key }),
    ...headers,
  });
}
