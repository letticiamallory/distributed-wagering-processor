import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LookupOptions {
  attempts?: number;
  pauseMs?: number;
}

// Procura a URL de uma fila pelo nome. No docker compose o `queues-init` termina antes de a app
// subir, mas o SQS pode demorar a responder: tenta por até ~30 s e só então desiste (e a aplicação
// não sobe, em vez de ficar de pé sem trabalhar).
export async function resolveQueueUrl(
  client: SQSClient,
  queueName: string,
  options: LookupOptions = {},
): Promise<string> {
  const attempts = options.attempts ?? 15;
  const pauseMs = options.pauseMs ?? 2_000;
  const logger = new Logger('QueueLookup');
  for (let attempt = 1; ; attempt++) {
    try {
      const { QueueUrl } = await client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      return String(QueueUrl);
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(
          `the SQS queue ${queueName} was not found after ${attempts} attempts`,
          { cause: error },
        );
      }
      logger.warn({
        event: 'queue_lookup_failed',
        queueName,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await sleep(pauseMs);
    }
  }
}

export async function resolveQueueUrls(
  client: SQSClient,
  names: { queueName: string; dlqName: string },
  options: LookupOptions = {},
): Promise<{ queueUrl: string; dlqUrl: string }> {
  const [queueUrl, dlqUrl] = await Promise.all([
    resolveQueueUrl(client, names.queueName, options),
    resolveQueueUrl(client, names.dlqName, options),
  ]);
  return { queueUrl, dlqUrl };
}
