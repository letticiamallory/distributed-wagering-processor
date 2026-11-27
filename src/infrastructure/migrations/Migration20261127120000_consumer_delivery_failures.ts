import { Migration } from '@mikro-orm/migrations';

export class Migration20261127120000_consumer_delivery_failures extends Migration {
  override name = 'Migration20261127120000_consumer_delivery_failures';

  override up(): void {
    // Quantas entregas de cada mensagem falharam com erro PERMANENTE (ADR-0016). É a prova que o
    // consumidor exige antes de gravar FAILED: o total tem que ser igual ao número de entregas.
    // Uma falha transitória (o banco fora) não soma nada, de propósito.
    this.addSql(`
      CREATE TABLE consumer_delivery_failures (
        consumer_name      TEXT NOT NULL,
        message_id         TEXT NOT NULL,
        permanent_failures INTEGER NOT NULL,
        last_failed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_consumer_delivery_failures PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT ck_cdf_failures_positive CHECK (permanent_failures >= 1)
      )
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE consumer_delivery_failures');
  }
}
