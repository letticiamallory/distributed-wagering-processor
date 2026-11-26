export interface QueueMessage {
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  groupId: string;
  receiveCount: number;
}

export interface DeadLetterInfo {
  reason: string;
  failureCode?: string;
}

// A porta fina entre o consumidor e o SQS. Existe para os testes decorarem UMA chamada (o
// delete, por exemplo) sem trocar a fila de verdade.
export abstract class QueueGateway {
  abstract receive(options: {
    max: number;
    waitSeconds: number;
    signal: AbortSignal;
  }): Promise<QueueMessage[]>;
  abstract delete(message: QueueMessage): Promise<void>;
  abstract changeVisibility(
    message: QueueMessage,
    seconds: number,
  ): Promise<void>;
  abstract sendToDeadLetter(
    message: QueueMessage,
    info: DeadLetterInfo,
  ): Promise<void>;
}
