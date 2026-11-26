import type { Json } from './http-app.js';

export interface ClientResponse {
  status: number;
  body: Json | undefined;
  text: string;
  // Quantas tentativas foram necessárias até esta resposta (1 = sem reenvio).
  attempts: number;
  url: string;
}

export interface ClientStats {
  requests: number;
  attempts: number;
  retries: number;
  status503: number;
  networkErrors: number;
}

const MAX_ATTEMPTS = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Um provedor de verdade: quando o serviço responde 503 (nada foi gravado), espera o Retry-After e
// reenvia a MESMA requisição com a MESMA Idempotency-Key. É assim que um reenvio é provado seguro:
// se o serviço duplicasse algo, o teste que usa este cliente veria o saldo ou o ledger errados.
export class ProviderClient {
  readonly stats: ClientStats = {
    requests: 0,
    attempts: 0,
    retries: 0,
    status503: 0,
    networkErrors: 0,
  };
  // Quantas tentativas cada instância (URL) atendeu.
  readonly perUrl = new Map<string, number>();
  private readonly startedAt = performance.now();

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  async send(
    url: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    options: { retryNetworkErrors?: boolean } = {},
  ): Promise<ClientResponse> {
    this.stats.requests++;
    const retryNetwork = options.retryNetworkErrors ?? true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.stats.attempts++;
      this.perUrl.set(url, (this.perUrl.get(url) ?? 0) + 1);
      try {
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (response.status === 503) {
          this.stats.status503++;
          this.stats.retries++;
          const seconds = Number(response.headers.get('retry-after') ?? '1');
          // O Retry-After do servidor, com um pouco de jitter para os clientes não voltarem juntos.
          await sleep(seconds * 1_000 * (0.6 + Math.random() * 0.4));
          continue;
        }
        let parsed: Json | undefined;
        try {
          parsed = text.trim() === '' ? undefined : (JSON.parse(text) as Json);
        } catch {
          parsed = undefined;
        }
        return {
          status: response.status,
          body: parsed,
          text,
          attempts: attempt,
          url,
        };
      } catch (error) {
        this.stats.networkErrors++;
        if (!retryNetwork) {
          throw error;
        }
        this.stats.retries++;
        await sleep(200);
      }
    }
    throw new Error(
      `gave up after ${MAX_ATTEMPTS} attempts: POST ${url}${path}`,
    );
  }

  submit(
    url: string,
    body: Json,
    key: string = `${String(body.providerId)}:${String(body.externalTransactionId)}`,
  ): Promise<ClientResponse> {
    return this.send(url, '/wagering/transactions', body, {
      'idempotency-key': key,
    });
  }

  // A criação de wallet não é idempotente: um erro de rede NÃO é reenviado (poderia duplicar), e o
  // 503 sim (nada foi gravado).
  async createWallet(
    url: string,
    balance = '100.00',
  ): Promise<{ id: string; playerId: string }> {
    const playerId = Bun.randomUUIDv7();
    const response = await this.send(
      url,
      '/wallets',
      { playerId, initialBalance: { amount: balance, currency: 'BRL' } },
      {},
      { retryNetworkErrors: false },
    );
    if (response.status !== 201) {
      throw new Error(
        `POST /wallets answered ${response.status}: ${response.text}`,
      );
    }
    return { id: String(response.body?.id), playerId };
  }
}

// Executa `fn` sobre os itens com no máximo `limit` em andamento.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
