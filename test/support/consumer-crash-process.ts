// Um processo de verdade que consome UMA fila de teste e MORRE com SIGKILL (kill -9 de verdade) no
// instante em que ia apagar a mensagem: depois do commit e antes do ack. O código de produção
// não tem gancho nenhum para isso: só trocamos o gateway (a porta) por um que morre no delete.
import { Test } from '@nestjs/testing';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { AwsQueueGateway } from '../../src/interfaces/sqs/aws-queue-gateway.js';
import {
  QueueGateway,
  type QueueMessage,
} from '../../src/interfaces/sqs/queue-gateway.js';
import { resolveQueueUrls } from '../../src/interfaces/sqs/sqs-consumer.module.js';

class DiesBeforeTheAck extends AwsQueueGateway {
  override async delete(_message: QueueMessage): Promise<void> {
    process.stdout.write('ABOUT_TO_ACK\n');
    // No Linux o pai vê signalCode SIGKILL (exit 137); no Windows o processo é encerrado do mesmo jeito
    // (TerminateProcess), sem sinal POSIX. O await nunca termina: nada roda depois do kill.
    process.kill(process.pid, 'SIGKILL');
    await new Promise<never>(() => {});
  }
}

const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
const urls = await resolveQueueUrls(client, {
  queueName: String(process.env.SQS_QUEUE_NAME),
  dlqName: String(process.env.SQS_DLQ_NAME),
});
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(QueueGateway)
  .useValue(new DiesBeforeTheAck(client, urls))
  .compile();
const app = moduleRef.createNestApplication();
await app.listen(0);
process.stdout.write('READY\n');
