import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  QueueGateway,
  type DeadLetterInfo,
  type QueueMessage,
} from './queue-gateway.js';

// A porta com o SQS de verdade (AWS SDK v3). Sem lógica de negócio: cada método é um comando.
export class AwsQueueGateway extends QueueGateway {
  constructor(
    readonly client: SQSClient,
    readonly urls: { queueUrl: string; dlqUrl: string },
  ) {
    super();
  }

  async receive(options: {
    max: number;
    waitSeconds: number;
    signal: AbortSignal;
  }): Promise<QueueMessage[]> {
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls.queueUrl,
        MaxNumberOfMessages: options.max,
        WaitTimeSeconds: options.waitSeconds,
        // O número de entregas (para o limite e o backoff) e o grupo (para a ordem por wallet).
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      { abortSignal: options.signal },
    );
    return Messages.map((message) => ({
      sqsMessageId: String(message.MessageId),
      receiptHandle: String(message.ReceiptHandle),
      body: message.Body ?? '',
      groupId: message.Attributes?.MessageGroupId ?? String(message.MessageId),
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async delete(message: QueueMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.urls.queueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  async changeVisibility(
    message: QueueMessage,
    seconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.urls.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  // Envio EXPLÍCITO para a DLQ (ADR-0011): o corpo vai intacto, com o motivo nos atributos.
  // O grupo é o mesmo (se alguém reinjetar a mensagem, a ordem por wallet se mantém) e a
  // deduplicação usa o id do SQS da mensagem original: se o processo morrer entre o envio e o
  // delete, a segunda tentativa de envio é descartada pelo SQS (janela de 5 minutos).
  async sendToDeadLetter(
    message: QueueMessage,
    info: DeadLetterInfo,
  ): Promise<void> {
    const attribute = (value: string) => ({
      DataType: 'String',
      StringValue: value,
    });
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.dlqUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          reason: attribute(info.reason),
          originalMessageId: attribute(message.sqsMessageId),
          receiveCount: attribute(String(message.receiveCount)),
          ...(info.failureCode !== undefined && {
            failureCode: attribute(info.failureCode),
          }),
        },
      }),
    );
  }
}
