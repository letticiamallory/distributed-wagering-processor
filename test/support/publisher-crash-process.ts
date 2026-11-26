// Um processo de verdade com o PUBLISHER ligado que MORRE (exit 137, como um kill -9) logo depois
// de o SQS aceitar o lote e ANTES do COMMIT que marcaria published_at. O código de produção não
// tem gancho nenhum para isso: só trocamos a porta (IntegrationEventPublisher) por uma que
// envia de verdade e então morre.
import { SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import { IntegrationEventPublisher } from '../../src/application/ports/integration-event-publisher.js';
import { AppModule } from '../../src/app.module.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';
import { resolveQueueUrl } from '../../src/interfaces/sqs/queue-url.js';

class DiesAfterTheSend extends SqsEventPublisher {
  override async publish(messages: readonly OutboxMessage[]) {
    const outcomes = await super.publish(messages);
    process.stdout.write(`SENT ${messages.length}\n`);
    process.exit(137);
    return outcomes;
  }
}

const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
const queueUrl = await resolveQueueUrl(
  client,
  String(process.env.OUTBOX_QUEUE_NAME),
);
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(IntegrationEventPublisher)
  .useValue(new DiesAfterTheSend(client, queueUrl, { timeoutMs: 5_000 }))
  .compile();
const app = moduleRef.createNestApplication();
await app.listen(0);
process.stdout.write('READY\n');
