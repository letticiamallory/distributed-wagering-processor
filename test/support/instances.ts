import { ensureTestDatabase } from './database.js';

export interface Instance {
  index: number;
  pid: number;
  port: number;
  url: string;
  process: ReturnType<typeof Bun.spawn>;
  // As últimas linhas que o processo escreveu (stdout e stderr), para mostrar se algo falhar.
  output: string[];
  // Contagens feitas LINHA A LINHA durante a leitura (o buffer acima guarda só o final e estouraria
  // com centenas de avisos): o nome de cada erro registrado e o motivo de cada 503.
  errorCounts: Record<string, number>;
  unavailableCounts: Record<string, number>;
}

export interface Instances {
  all: Instance[];
  urls: string[];
  // Os erros que cada processo registrou no log, contados pelo nome ("ConcurrentWalletUpdateError").
  errorNames(): Record<string, number>;
  // Por que cada processo respondeu 503: o texto entre parênteses de "Database unavailable or busy
  // (...)": 55P03 (lock_timeout) ou "timeout exceeded when trying to connect" (pool sem conexão).
  unavailableReasons(): Record<string, number>;
  stop(): Promise<void>;
}

const MAX_OUTPUT_LINES = 400;
// Os códigos de cor ANSI (ESC [ ... m) que o Nest escreve mesmo fora de um terminal.
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const READY_TIMEOUT_MS = 60_000;

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

async function drain(
  stream: ReadableStream<Uint8Array> | undefined | null,
  instance: Pick<Instance, 'output' | 'errorCounts' | 'unavailableCounts'>,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = ''; // um bloco pode terminar no meio de uma linha
  const take = (line: string) => {
    if (line.trim() === '') return;
    instance.output.push(line);
    if (instance.output.length > MAX_OUTPUT_LINES) instance.output.shift();
    const plain = line.replace(ANSI_COLOR, '');
    const error = /error: '(\w+)'/.exec(plain)?.[1];
    if (error) {
      instance.errorCounts[error] = (instance.errorCounts[error] ?? 0) + 1;
    }
    const reason = /Database unavailable or busy \(([^)]*)\)/.exec(plain)?.[1];
    if (reason) {
      instance.unavailableCounts[reason] =
        (instance.unavailableCounts[reason] ?? 0) + 1;
    }
  };
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      lines.forEach(take);
    }
    take(pending);
  } catch {
    // o processo morreu: o que já foi lido basta
  }
}

async function waitUntilReady(instance: Instance): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (instance.process.exitCode !== null) {
      throw new Error(
        `instance ${instance.index} exited with code ${instance.process.exitCode} before it was ready:\n${instance.output.slice(-25).join('\n')}`,
      );
    }
    try {
      const response = await fetch(`${instance.url}/health/live`);
      if (response.status === 200) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(150);
  }
  throw new Error(
    `instance ${instance.index} was not ready in ${READY_TIMEOUT_MS} ms:\n${instance.output.slice(-25).join('\n')}`,
  );
}

// Sobe N PROCESSOS da aplicação de verdade (bun src/main.ts), em portas diferentes, contra o MESMO
// banco de teste. Nada de threads nem de vários apps no mesmo processo: cada um tem a sua conexão,
// o seu pool e o seu event loop, como três réplicas.
export async function startInstances(
  count = 3,
  options: { env?: Record<string, string> } = {},
): Promise<Instances> {
  await ensureTestDatabase(); // o schema existe antes de qualquer instância abrir conexão
  const all: Instance[] = [];
  const killAll = () => {
    for (const instance of all) {
      try {
        instance.process.kill();
      } catch {
        // já morreu
      }
    }
  };
  // Garante que nenhuma instância sobra se o teste for interrompido.
  const onExit = () => killAll();
  process.once('exit', onExit);

  try {
    for (let index = 0; index < count; index++) {
      const port = freePort();
      const output: string[] = [];
      const errorCounts: Record<string, number> = {};
      const unavailableCounts: Record<string, number> = {};
      const child = Bun.spawn([process.execPath, 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env, // inclui a DATABASE_URL do banco de TESTE (o preload a fixa)
          PORT: String(port),
          DB_POOL_MIN: '1',
          // 3 x 15 = 45 conexões, com folga para as do teste e abaixo dos 100 do Postgres.
          DB_POOL_MAX: '15',
          RETRY_AFTER_SECONDS: '1',
          ...options.env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const instance: Instance = {
        index,
        pid: child.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        process: child,
        output,
        errorCounts,
        unavailableCounts,
      };
      all.push(instance);
      void drain(child.stdout as ReadableStream<Uint8Array>, instance);
      void drain(child.stderr as ReadableStream<Uint8Array>, instance);
    }
    await Promise.all(all.map((instance) => waitUntilReady(instance)));
  } catch (error) {
    killAll();
    await Promise.all(all.map((instance) => instance.process.exited));
    process.off('exit', onExit);
    throw error;
  }

  return {
    all,
    urls: all.map((instance) => instance.url),
    errorNames() {
      return sumCounts(all.map((instance) => instance.errorCounts));
    },
    unavailableReasons() {
      return sumCounts(all.map((instance) => instance.unavailableCounts));
    },
    async stop() {
      killAll();
      await Promise.all(all.map((instance) => instance.process.exited));
      process.off('exit', onExit);
    },
  };
}

function sumCounts(
  parts: Array<Record<string, number>>,
): Record<string, number> {
  const total: Record<string, number> = {};
  for (const part of parts) {
    for (const [name, count] of Object.entries(part)) {
      total[name] = (total[name] ?? 0) + count;
    }
  }
  return total;
}
