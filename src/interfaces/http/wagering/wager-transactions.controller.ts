import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerResult,
} from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { addLogFields } from '../../../infrastructure/observability/log-context.js';
import type { TransactionView } from '../../../application/queries/queries.js';
import { GetTransactionUseCase } from '../../../application/use-cases/queries.use-cases.js';
import { currentCorrelationId } from '../correlation-id.js';
import { statusOfResult } from '../http-status.js';
import { idempotencyKeyOf } from '../idempotency-header.js';
import { ProviderAuthGuard } from '../provider-auth.guard.js';
import { StoredFailureReplayError } from '../stored-failure-replay.error.js';

// Fino de propósito: o corpo e o header vão como estão para o caso de uso (que valida e decide), e
// o resultado vira o status pelo mapa. Nenhuma regra de negócio aqui.
@UseGuards(ProviderAuthGuard)
@Controller('wagering/transactions')
export class WagerTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  // A transação como está gravada (qualquer status: uma REJECTED, uma PENDING_REFERENCE ou uma
  // FAILED também é um recurso que existe, então é 200).
  @Get(':transactionId')
  async get(
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionView> {
    const view = await this.getTransaction.byId(transactionId);
    addLogFields({
      transactionId: view.transactionId,
      walletId: view.walletId,
    });
    return view;
  }

  @Post()
  async submit(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessWagerResult> {
    // Só identificadores vão para o log (o corpo financeiro nunca).
    addLogFields(idsOf(body));
    const result = await this.processWager.execute(body, {
      idempotencyKey: idempotencyKeyOf(request),
      correlationId: currentCorrelationId(),
    });
    addLogFields({ transactionId: result.transactionId });
    const status = statusOfResult(result);
    if (status >= 500) {
      // O replay de uma transação que terminou em FAILED: não é sucesso, vira o erro 500.
      throw new StoredFailureReplayError(result);
    }
    response.status(status);
    return result;
  }
}

// walletId e providerId do corpo, quando são texto curto: identificadores, não dados financeiros.
function idsOf(body: unknown): Record<string, string> {
  const ids: Record<string, string> = {};
  if (typeof body === 'object' && body !== null) {
    const { walletId, providerId } = body as Record<string, unknown>;
    if (typeof walletId === 'string' && walletId.length <= 64) {
      ids.walletId = walletId;
    }
    if (typeof providerId === 'string' && providerId.length <= 200) {
      ids.providerId = providerId;
    }
  }
  return ids;
}
