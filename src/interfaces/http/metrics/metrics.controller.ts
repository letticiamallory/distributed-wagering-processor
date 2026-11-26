import { Controller, Get, Header } from '@nestjs/common';
import { PrometheusRegistry } from '../../../infrastructure/observability/prometheus-registry.js';

// Aberto como o /health: quem raspa as métricas (o Prometheus) não tem token de provedor, e o
// que sai daqui são contagens e latências, nunca um valor, uma wallet ou um jogador (ADR-0014).
@Controller('metrics')
export class MetricsController {
  constructor(private readonly registry: PrometheusRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.render();
  }
}
