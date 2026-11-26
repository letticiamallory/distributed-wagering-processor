import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ReadinessProbe } from '../../application/ports/readiness-probe.port.js';

// Uma chamada de verdade ao SQS (`ListQueues`, no máximo 1 resultado), com prazo. Não depende de
// uma fila específica existir: pergunta se o SQS responde.
export class SqsProbe extends ReadinessProbe {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly timeoutMs = 2_000,
  ) {
    super();
  }

  async isUp(): Promise<boolean> {
    try {
      await this.client.send(new ListQueuesCommand({ MaxResults: 1 }), {
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  }
}
