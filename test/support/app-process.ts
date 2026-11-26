import { waitFor } from './queues.js';

// Um processo de verdade da aplicação (`bun src/main.ts`) que o teste pode matar (SIGKILL) e
// reiniciar. O ambiente é o do teste (consumidor, publisher e worker DESLIGADOS) mais o que o teste
// ligar de propósito.
export interface AppProcess {
  url: string;
  output(): string;
  waitReady(): Promise<void>;
  // SIGKILL: sem handlers, sem shutdown gracioso (a queda de energia do processo).
  kill(): Promise<void>;
  exited: Promise<number>;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

export function spawnApp(env: Record<string, string>): AppProcess {
  const port = freePort();
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let text = '';
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        text += decoder.decode(chunk, { stream: true });
      }
    } catch {
      // o processo morreu
    }
  };
  void collect(child.stdout as ReadableStream<Uint8Array>);
  void collect(child.stderr as ReadableStream<Uint8Array>);
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    output: () => text.replace(ANSI, ''),
    exited: child.exited,
    async waitReady() {
      await waitFor(
        `the process on port ${port} to be ready`,
        async () => {
          if (child.exitCode !== null) {
            throw new Error(`the process exited early:\n${text.slice(-2000)}`);
          }
          try {
            return (await fetch(`${url}/health/live`)).ok;
          } catch {
            return false;
          }
        },
        60_000,
      );
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}
