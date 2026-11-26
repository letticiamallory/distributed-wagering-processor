// Postgres e MiniStack DESCARTÁVEIS, em containers de verdade, que o teste pode derrubar e subir de
// novo: a única forma honesta de provar que o /health/ready enxerga uma dependência CAIDA (e não
// uma configurada errado). Não tocam nos serviços do compose nem no banco de teste.

const run = (args: string[]) => {
  try {
    const result = Bun.spawnSync(['docker', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      ok: result.exitCode === 0,
      out: result.stdout.toString().trim(),
      err: result.stderr.toString().trim(),
    };
  } catch (error) {
    // Sem o binário `docker` (um container de CI, por exemplo) o Bun LANÇA em vez de devolver um
    // código de saída: para quem pergunta "há Docker?", isso é só "não".
    return {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  }
};

export const dockerAvailable = (): boolean =>
  run(['version', '--format', '{{.Server.Version}}']).ok;

export interface Disposable {
  name: string;
  // Porta no host (aleatória, escolhida pelo Docker, e MANTIDA depois de parar e subir de novo).
  port: number;
  stop(): void;
  start(): void;
  remove(): void;
}

let sequence = 0;

function launch(
  image: string,
  containerPort: number,
  env: string[] = [],
): Disposable {
  const name = `deps-${Date.now().toString(36)}-${++sequence}`;
  // Porta fixa no host (livre no momento): o container volta na MESMA porta depois de um stop/start.
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const hostPort = server.port as number;
  void server.stop(true);
  const created = run([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${hostPort}:${containerPort}`,
    ...env.flatMap((e) => ['-e', e]),
    image,
  ]);
  if (!created.ok) {
    throw new Error(`could not start ${image}: ${created.err}`);
  }
  return {
    name,
    port: hostPort,
    stop: () => void run(['stop', '-t', '1', name]),
    start: () => void run(['start', name]),
    remove: () => void run(['rm', '-f', name]),
  };
}

export const startPostgres = () =>
  launch('postgres:16-alpine', 5432, [
    'POSTGRES_USER=wallet',
    'POSTGRES_PASSWORD=wallet',
    'POSTGRES_DB=wallet',
  ]);

export const startMiniStack = () => launch('ministackorg/ministack', 4566);
