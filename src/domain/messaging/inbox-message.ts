import { InvalidInboxMessageError } from './messaging.errors.js';
import { PAYLOAD_HASH_PATTERN } from './payload-hash.js';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

// "Esta entrega já foi vista?" A chave (consumerName, messageId) vive no banco; a classe
// guarda o hash para detectar o mesmo messageId com conteúdo diferente (bug do produtor).
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim() === '') {
      throw new InvalidInboxMessageError('messageId cannot be empty');
    }
    if (props.consumerName.trim() === '') {
      throw new InvalidInboxMessageError('consumerName cannot be empty');
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidInboxMessageError(
        'payloadHash must be 64 lowercase hex characters (SHA-256)',
      );
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageError(
        `Message ${this.messageId} was already processed`,
      );
    }
    this._processedAt = at;
  }
}
