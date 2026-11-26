import { Inject, Injectable, Logger } from '@nestjs/common';
import { ReadinessProbe } from '../../../application/ports/readiness-probe.port.js';

export const READINESS_PROBES = Symbol('READINESS_PROBES');

export interface Readiness {
  ok: boolean;
  checks: Record<string, 'up' | 'down'>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbe[],
  ) {}

  // Liveness: o processo está de pé e atende. NÃO olha banco nem fila: um orquestrador que
  // reiniciasse o processo porque o banco caiu só pioraria a queda.
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: o serviço consegue trabalhar? Testa cada dependência de verdade, em paralelo, cada
  // uma com o seu prazo.
  async ready(): Promise<Readiness> {
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
