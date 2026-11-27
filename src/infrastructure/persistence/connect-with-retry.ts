// Abre a conexão com o banco tentando de novo, com backoff exponencial limitado, até um prazo total.
// Existe para o serviço `migrate` do docker-compose: num host lento (primeiro boot, imagens recém
// construídas) o Postgres já responde ao healthcheck mas uma conexão nova ainda pode passar do prazo
// de 3 s, e sem retentativa a subida inteira falhava (N-2 da segunda avaliação). Cada tentativa que
// falha é registrada; ao desistir, o último erro sobe.

// Prazo total padrão do migrate: generoso, porque só roda na subida.
export const MIGRATE_CONNECT_DEADLINE_MS = 180_000;

export interface ConnectRetryOptions {
  deadlineMs: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function connectWithRetry<T>(
  open: () => Promise<T>,
  options: ConnectRetryOptions,
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  const entry = (level: string, event: string, extra: object) => ({
    time: new Date().toISOString(),
    level,
    event,
    ...extra,
  });

  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await open();
      options.log(
        entry('info', 'db_connected', {
          attempt,
          elapsedMs: now() - startedAt,
        }),
      );
      return connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = now() - startedAt;
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (elapsedMs + delayMs > options.deadlineMs) {
        options.log(
          entry('error', 'db_connect_gave_up', {
            attempt,
            elapsedMs,
            deadlineMs: options.deadlineMs,
            error: message,
          }),
        );
        throw error;
      }
      options.log(
        entry('warn', 'db_connect_attempt_failed', {
          attempt,
          elapsedMs,
          nextDelayMs: delayMs,
          error: message,
        }),
      );
      await sleep(delayMs);
    }
  }
}
