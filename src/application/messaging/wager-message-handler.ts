import { z } from 'zod';
import { DomainError } from '../../domain/errors/domain-error.js';
import type { DeliveryFailureLog } from '../ports/delivery-failure-log.js';
import {
  STORABLE_TEXT_MESSAGE,
  isStorableText,
} from '../commands/command-parsing.js';
import {
  ApplicationError,
  ExternalIdConflictError,
  IdempotencyKeyReusedError,
  InboxMessageReusedError,
  InvalidCommandError,
  PermanentDataError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import type {
  ProcessWagerContext,
  ProcessWagerResult,
} from '../use-cases/process-wager-transaction.use-case.js';
import type { ConsumerRetryPolicy } from './consumer-retry-policy.js';

// O nome com que o consumidor assina a inbox: a chave é (consumerName, messageId).
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export type DeadLetterReason =
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'INVALID_PAYLOAD'
  | 'WALLET_NOT_FOUND'
  | 'INBOX_MESSAGE_REUSED'
  | 'PERMANENT_DATA_ERROR'
  | 'CRITICAL'
  | 'RETRIES_EXHAUSTED';

export type AckOutcome =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'FAILED'
  | 'IDEMPOTENCY_CONFLICT';

interface Identified {
  messageId?: string;
  idempotencyKey?: string;
  // Identificadores para o log (nunca o corpo).
  walletId?: string;
  providerId?: string;
}

// O que fazer com a mensagem. Quem executa (apagar, devolver a visibilidade, mandar para a DLQ)
// é o consumidor da camada de interfaces; aqui só se DECIDE, sem tocar em fila nenhuma.
export type Disposition =
  // Terminou (inclusive com rejeição de negócio): apagar a mensagem.
  | (Identified & {
      action: 'ACK';
      outcome: AckOutcome;
      replay: boolean;
      transactionId?: string;
      error?: unknown;
    })
  // Falha passageira: NÃO apagar; devolver a visibilidade com a espera.
  | (Identified & { action: 'RETRY'; delaySeconds: number; error: unknown })
  // Não adianta tentar de novo: mandar para a DLQ com o motivo e só então apagar.
  | (Identified & {
      action: 'DEAD_LETTER';
      reason: DeadLetterReason;
      failureCode?: string;
      // Erro que nunca deveria acontecer: o consumidor loga no nível mais alto (fatal).
      critical: boolean;
      error?: unknown;
    });

export interface MessageContext {
  // Quantas vezes o SQS já entregou esta mensagem, contando esta (ApproximateReceiveCount).
  receiveCount: number;
}

// O que o handler precisa do caso de uso: só `execute` (o MESMO do HTTP).
export interface WagerProcessor {
  execute(
    input: unknown,
    context: ProcessWagerContext,
  ): Promise<ProcessWagerResult>;
  // Grava a transação como FAILED (ADR-0016). Opcional: sem ele, nada vira FAILED.
  fail?(
    input: unknown,
    context: ProcessWagerContext,
  ): Promise<ProcessWagerResult>;
}

const notBlank = (value: string) => value.trim() !== '';

// O envelope do enunciado (seção 10). `data` só precisa ser um objeto aqui: os campos de negócio
// são validados pelo caso de uso, as MESMAS regras do HTTP.
const envelopeSchema = z.object({
  messageId: z
    .string()
    .max(255)
    .refine(notBlank, 'must not be blank')
    .refine(isStorableText, STORABLE_TEXT_MESSAGE),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z
    .record(z.string(), z.unknown())
    .refine((value) => !Array.isArray(value), 'must be an object'),
});

// Traduz a mensagem do SQS em uma chamada ao caso de uso e o resultado numa decisão.
// Nunca lança: qualquer falha vira uma `Disposition`.
export class WagerMessageHandler {
  constructor(
    private readonly processor: WagerProcessor,
    private readonly policy: ConsumerRetryPolicy,
    // A prova das falhas permanentes (ADR-0016). Sem ela, o consumidor nunca grava FAILED.
    private readonly failures?: DeliveryFailureLog,
  ) {}

  async handle(body: string, context: MessageContext): Promise<Disposition> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // O texto do erro do parser CITA um pedaço do corpo: o corpo nunca vai para o log, então a
      // causa guardada é uma descrição fixa.
      return deadLetter(
        'INVALID_JSON',
        {},
        new Error('the message body is not valid JSON'),
      );
    }

    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      // Só OS CAMINHOS dos campos inválidos (o texto do zod poderia citar valores do corpo).
      const fields = [
        ...new Set(
          envelope.error.issues.map((i) => i.path.join('.') || '(body)'),
        ),
      ].join(', ');
      return deadLetter(
        'INVALID_ENVELOPE',
        identify(parsed),
        new Error(`invalid envelope: ${fields}`),
      );
    }
    const { messageId, data } = envelope.data;
    const ids: Identified = {
      messageId,
      ...(typeof data.idempotencyKey === 'string' && {
        idempotencyKey: data.idempotencyKey,
      }),
      ...(typeof data.walletId === 'string' && { walletId: data.walletId }),
      ...(typeof data.providerId === 'string' && {
        providerId: data.providerId,
      }),
    };

    try {
      const result = await this.processor.execute(data, {
        idempotencyKey: data.idempotencyKey,
        correlationId: messageId,
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId },
      });
      return acknowledge(result, ids);
    } catch (error) {
      return this.classify(error, data, ids, context);
    }
  }

  // A tabela do ADR-0011: o tipo do erro decide o destino. O FAILED (ADR-0016) só nasce aqui, com a
  // prova de que nenhuma entrega foi transitória.
  private async classify(
    error: unknown,
    data: Record<string, unknown>,
    ids: Identified,
    context: MessageContext,
  ): Promise<Disposition> {
    if (error instanceof ApplicationError) {
      // O que nunca deveria acontecer: DLQ já, e o consumidor loga fatal.
      if (error.critical) {
        return {
          action: 'DEAD_LETTER',
          reason: 'CRITICAL',
          critical: true,
          error,
          ...ids,
        };
      }
      // O banco recusou o dado: reenviar dá o mesmo erro, então nunca há retry. Com a prova de que
      // todas as entregas falharam assim, vira FAILED; sem ela, DLQ já.
      if (error instanceof PermanentDataError) {
        const failed = await this.failIfProven(data, ids, context);
        return failed ?? deadLetter('PERMANENT_DATA_ERROR', ids, error);
      }
      if (error instanceof InboxMessageReusedError) {
        return deadLetter('INBOX_MESSAGE_REUSED', ids, error);
      }
      if (error instanceof InvalidCommandError) {
        return deadLetter('INVALID_PAYLOAD', ids, error, error.code);
      }
      if (error instanceof WalletNotFoundError) {
        return deadLetter('WALLET_NOT_FOUND', ids, error, error.code);
      }
      // Resultado terminal e determinístico: reprocessar daria o mesmo conflito. Ack.
      if (
        error instanceof IdempotencyKeyReusedError ||
        error instanceof ExternalIdConflictError
      ) {
        return {
          action: 'ACK',
          outcome: 'IDEMPOTENCY_CONFLICT',
          replay: false,
          error,
          ...ids,
        };
      }
    }

    // O resto não apaga (apagar um erro desconhecido é perder a mensagem): retry com backoff, e o
    // limite de entregas o leva à DLQ. Um erro PERMANENTE conhecido (erro de aplicação não
    // reenviável, ou de domínio: um bug) soma 1 na prova; na última entrega, se TODAS somaram,
    // vira FAILED. O transitório (banco fora) e o desconhecido nunca somam.
    const exhausted = this.policy.isExhausted(context.receiveCount);
    if (isPermanent(error)) {
      if (exhausted) {
        const failed = await this.failIfProven(data, ids, context);
        if (failed) {
          return failed;
        }
      } else {
        await this.recordPermanentFailure(ids);
      }
    }
    if (exhausted) {
      return deadLetter('RETRIES_EXHAUSTED', ids, error);
    }
    return {
      action: 'RETRY',
      delaySeconds: this.policy.delaySeconds(context.receiveCount),
      error,
      ...ids,
    };
  }

  // Soma esta falha permanente na prova. Se nem isso passa (o banco caiu agora), a entrega fica sem
  // registro: falta de prova, e o FAILED não acontece. Devolve o total, ou undefined.
  private async recordPermanentFailure(
    ids: Identified,
  ): Promise<number | undefined> {
    if (!this.failures || !ids.messageId) {
      return undefined;
    }
    try {
      return await this.failures.recordPermanentFailure(
        WAGER_CONSUMER_NAME,
        ids.messageId,
      );
    } catch {
      return undefined;
    }
  }

  // Registra esta falha e, se TODAS as entregas até agora (receiveCount) foram falhas permanentes
  // registradas, grava FAILED e devolve o ack. Qualquer outra coisa (sem prova, sem processor.fail,
  // ou o próprio FAILED não gravou) devolve undefined, e quem chama manda para a DLQ.
  private async failIfProven(
    data: Record<string, unknown>,
    ids: Identified,
    context: MessageContext,
  ): Promise<Disposition | undefined> {
    const recorded = await this.recordPermanentFailure(ids);
    if (
      recorded === undefined ||
      recorded < context.receiveCount ||
      !this.processor.fail ||
      !ids.messageId
    ) {
      return undefined;
    }
    try {
      const result = await this.processor.fail(data, {
        idempotencyKey: data.idempotencyKey,
        correlationId: ids.messageId,
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: ids.messageId },
      });
      return acknowledge(result, ids);
    } catch {
      return undefined;
    }
  }
}

// Erro que reenviar não resolve e que não é de banco fora: erro de aplicação não reenviável (bug,
// como ConcurrentWalletUpdateError) ou de domínio. Um Error qualquer NÃO conta: pode ser um problema
// de rede que ninguém classificou, e na dúvida o FAILED não acontece.
function isPermanent(error: unknown): boolean {
  if (error instanceof DomainError) {
    return true;
  }
  return error instanceof ApplicationError && !error.retryable;
}

function deadLetter(
  reason: DeadLetterReason,
  ids: Identified,
  error: unknown,
  failureCode?: string,
): Disposition {
  return {
    action: 'DEAD_LETTER',
    reason,
    critical: false,
    error,
    ...(failureCode !== undefined && { failureCode }),
    ...ids,
  };
}

function acknowledge(result: ProcessWagerResult, ids: Identified): Disposition {
  const outcome = outcomeOf(result.status);
  if (outcome === undefined) {
    // PENDING nunca é um resultado final: é bug, e bug não se apaga em silêncio.
    throw new Error(`unexpected transaction status ${result.status}`);
  }
  return {
    action: 'ACK',
    outcome,
    replay: result.idempotentReplay,
    transactionId: result.transactionId,
    ...ids,
  };
}

function outcomeOf(status: WagerTransactionStatus): AckOutcome | undefined {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 'PROCESSED';
    case WagerTransactionStatus.Rejected:
      return 'REJECTED';
    case WagerTransactionStatus.PendingReference:
      return 'PENDING_REFERENCE';
    case WagerTransactionStatus.Failed:
      return 'FAILED';
    default:
      return undefined;
  }
}

// Melhor esforço: o messageId de um envelope inválido, só para o log dizer de quem é.
function identify(parsed: unknown): Identified {
  if (typeof parsed === 'object' && parsed !== null && 'messageId' in parsed) {
    const { messageId } = parsed as { messageId: unknown };
    if (typeof messageId === 'string') {
      return { messageId };
    }
  }
  return {};
}
