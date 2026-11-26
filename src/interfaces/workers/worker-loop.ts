// O esqueleto comum dos dois workers: um laço que roda um ciclo, espera, e para quando mandarem,
// esperando o ciclo em andamento terminar (até um prazo). A espera entre ciclos é interrompida
// pelo stop(), então desligar não custa um intervalo inteiro.
export class WorkerLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly shutdownTimeoutMs: number) {}

  get isRunning(): boolean {
    return this.running;
  }

  // `cycle` devolve quantos ms esperar antes do próximo (0: seguir direto).
  start(cycle: () => Promise<number>): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const pause = await cycle();
        if (this.running && pause > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pause);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = undefined;
        }
      }
    })();
  }

  async stop(): Promise<{ drained: boolean }> {
    const loop = this.loop;
    if (!loop || !this.running) {
      return { drained: true };
    }
    this.running = false;
    this.wake?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      loop.then(() => 'drained' as const),
      new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), this.shutdownTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.loop = undefined;
    return { drained: outcome === 'drained' };
  }
}
