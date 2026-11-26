import type { Clock } from '../ports/clock.js';
import { NOOP_METRICS, type MetricsPort } from '../ports/metrics.port.js';
import type { IntegrationEventPublisher } from '../ports/integration-event-publisher.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface PublishOptions {
  // Eventos reivindicados por ciclo.
  batchSize: number;
  // Número em [0, 1] que encurta o backoff (o domínio não sorteia): o worker passa Math.random.
  jitter: () => number;
  // A partir de quantas tentativas um evento conta como "preso".
  stuckAfterAttempts: number;
}

export interface FailedEvent {
  eventId: string;
  walletId: string;
  eventType: string;
  attempts: number;
  error: string;
  stuck: boolean;
}

export interface PublishReport {
  claimed: number;
  published: number;
  failed: FailedEvent[];
}

// Um ciclo do publisher da outbox (ADR-0012), numa transação só:
//   1. reivindica um lote devido com FOR UPDATE SKIP LOCKED (outro publisher pega as outras linhas);
//   2. publica o lote no broker, COM a transação aberta (prazo curto no cliente);
//   3. marca cada evento aceito como publicado, e agenda a nova tentativa dos recusados
//      (attempts + 1, backoff exponencial até 5 minutos, last_error);
//   4. COMMIT.
//
// Se o processo morre antes do COMMIT, a transação é desfeita e as linhas voltam a ser devidas:
// outra instância as publica de novo (at-least-once; quem consome deduplica pelo eventId). Se o
// broker cai, nada se perde: as linhas ficam na tabela com a próxima tentativa agendada. Eventos
// confirmados NUNCA vão para DLQ: o retry é infinito, e a partir de `stuckAfterAttempts` o log
// sobe para error.
export class PublishOutboxBatchUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: IntegrationEventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOptions,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async execute(): Promise<PublishReport> {
    const report = await this.uow.run(async (repositories) => {
      const batch = await repositories.outbox.claimDue(
        this.options.batchSize,
        this.clock.now(),
      );
      if (batch.length === 0) {
        return { claimed: 0, published: 0, failed: [] };
      }

      const outcomes = await this.publisher.publish(batch);

      const at = this.clock.now();
      let published = 0;
      const failed: FailedEvent[] = [];
      for (const message of batch) {
        const outcome = outcomes.get(message.id);
        if (outcome?.ok) {
          message.markPublished(at);
          published++;
        } else {
          const error =
            outcome && !outcome.ok
              ? outcome.error
              : 'the broker did not report a result for this message';
          message.scheduleRetry(at, this.options.jitter(), error);
          failed.push({
            eventId: message.id,
            walletId: message.aggregateId,
            eventType: message.eventType,
            attempts: message.attempts,
            error,
            stuck: message.attempts >= this.options.stuckAfterAttempts,
          });
        }
        await repositories.outbox.save(message);
      }
      return { claimed: batch.length, published, failed };
    });
    // Só depois do commit (o que foi desfeito não aconteceu).
    if (report.published > 0) {
      this.metrics.increment(
        'outbox_events_published_total',
        {},
        report.published,
      );
    }
    if (report.failed.length > 0) {
      this.metrics.increment(
        'wager_retries_total',
        { component: 'outbox' },
        report.failed.length,
      );
    }
    return report;
  }
}
