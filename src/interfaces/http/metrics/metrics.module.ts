import { Global, Module } from '@nestjs/common';
import { Clock } from '../../../application/ports/clock.js';
import { MetricsPort } from '../../../application/ports/metrics.port.js';
import { OutboxReader } from '../../../application/ports/outbox-repository.js';
import { registerOutboxCollector } from '../../../infrastructure/observability/outbox-collector.js';
import { PrometheusRegistry } from '../../../infrastructure/observability/prometheus-registry.js';
import { MetricsController } from './metrics.controller.js';

const OUTBOX_COLLECTOR = Symbol('OUTBOX_COLLECTOR');

// Global: toda a aplicação conta pela MESMA porta (MetricsPort), e o /metrics lê o mesmo registro.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: PrometheusRegistry, useFactory: () => new PrometheusRegistry() },
    { provide: MetricsPort, useExisting: PrometheusRegistry },
    {
      // O lag da outbox é lido NO MOMENTO da raspagem (ver outbox-collector.ts).
      provide: OUTBOX_COLLECTOR,
      useFactory: (
        registry: PrometheusRegistry,
        reader: OutboxReader,
        clock: Clock,
      ) => registerOutboxCollector(registry, reader, clock),
      inject: [PrometheusRegistry, OutboxReader, Clock],
    },
  ],
  exports: [MetricsPort, PrometheusRegistry],
})
export class MetricsModule {}
