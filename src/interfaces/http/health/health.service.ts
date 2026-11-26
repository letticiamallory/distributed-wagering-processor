import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ReadinessProbe } from '../../../application/ports/readiness-probe.port.js';

export const READINESS_PROBES = Symbol('READINESS_PROBES');

export interface Readiness {
  ok: boolean;
  // O processo recebeu o sinal de encerramento: sai de rotação, sem testar nada.
  shuttingDown?: boolean;
  checks: Record<string, 'up' | 'down'>;
}

@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbe[],
  ) {}

  private shuttingDown = false;
  private readonly onSignal = () => this.markShuttingDown();

  // O ouvinte do sinal mora aqui, dentro do ciclo de vida do Nest (e sai quando o módulo é
  // destruído). O Node chama os ouvintes do mesmo sinal no mesmo instante, um após o outro, antes
  // de qualquer espera: quando o Nest começa a esperar as mensagens em andamento, a flag já virou.
  onModuleInit(): void {
    process.on('SIGTERM', this.onSignal);
    process.on('SIGINT', this.onSignal);
  }

  onModuleDestroy(): void {
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
  }

  // Chamado no PRIMEIRO instante do encerramento (o SIGTERM): enquanto o processo termina o que
  // está em andamento, o balanceador não pode mandar tráfego novo.
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  // Liveness: o processo está de pé e atende. NÃO olha banco nem fila: um orquestrador que
  // reiniciasse o processo porque o banco caiu só pioraria a queda.
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: o serviço consegue trabalhar? Testa cada dependência de verdade, em paralelo, cada
  // uma com o seu prazo.
  async ready(): Promise<Readiness> {
    if (this.shuttingDown) {
      return { ok: false, shuttingDown: true, checks: {} };
    }
    const results = await Promise.all(
      this.probes.map(async (probe) => ({
        name: probe.name,
        up: await probe.isUp(),
      })),
    );
    const checks: Record<string, 'up' | 'down'> = {};
    for (const result of results) {
      checks[result.name] = result.up ? 'up' : 'down';
      if (!result.up) {
        this.logger.warn({
          event: 'readiness_check_failed',
          check: result.name,
        });
      }
    }
    return { ok: results.every((r) => r.up), checks };
  }
}
