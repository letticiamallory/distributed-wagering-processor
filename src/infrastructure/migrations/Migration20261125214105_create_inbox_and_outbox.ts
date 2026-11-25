import { Migration } from '@mikro-orm/migrations';

export class Migration20261125214105_create_inbox_and_outbox extends Migration {
  override name = 'Migration20261125214105_create_inbox_and_outbox';

  override up(): void {
    // Inbox: o SQS entrega pelo menos uma vez, então a mesma mensagem pode chegar duas
    // vezes. A chave primária faz a segunda inserção falhar, e é assim que detectamos.
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        payload_hash  CHAR(64) NOT NULL,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at  TIMESTAMPTZ,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // Outbox: os eventos são gravados na mesma transação do negócio e publicados depois.
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              UUID NOT NULL,  -- igual ao eventId
        aggregate_id    UUID NOT NULL,
        event_type      TEXT NOT NULL,
        payload         JSONB NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at    TIMESTAMPTZ,
        last_error      TEXT,
        CONSTRAINT pk_outbox_messages PRIMARY KEY (id),
        CONSTRAINT ck_outbox_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    // Parcial: o publisher só olha o que ainda não foi publicado.
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX ix_outbox_due');
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
  }
}
