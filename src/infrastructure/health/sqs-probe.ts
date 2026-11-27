import {
  GetQueueUrlCommand,
  ListQueuesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ReadinessProbe } from '../../application/ports/readiness-probe.port.js';

// O SQS está pronto para ESTE processo? Responder não basta: o MiniStack reiniciado responde a tudo,
// mas perdeu as filas (só as guarda em memória), e o consumidor e o publisher ficam falhando em loop.
// Então o probe confere, por nome (`GetQueueUrl`), cada fila de que o processo precisa. Sem fila
// exigida (consumidor e publisher desligados), pergunta só se o SQS responde (`ListQueues`). Tudo com
// prazo, e as filas em paralelo: o prazo total continua sendo o de uma chamada.
export class SqsProbe extends ReadinessProbe {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly requiredQueues: readonly string[] = [],
    private readonly timeoutMs = 2_000,
  ) {
    super();
  }

  async isUp(): Promise<boolean> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      if (this.requiredQueues.length === 0) {
        await this.client.send(new ListQueuesCommand({ MaxResults: 1 }), {
          abortSignal: signal,
        });
      } else {
        await Promise.all(
          this.requiredQueues.map((QueueName) =>
            this.client.send(new GetQueueUrlCommand({ QueueName }), {
              abortSignal: signal,
            }),
          ),
        );
      }
      return true;
    } catch {
      return false;
    }
  }
}
