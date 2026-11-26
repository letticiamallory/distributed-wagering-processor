import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerResult,
} from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { currentCorrelationId } from '../correlation-id.js';
import { statusOfResult } from '../http-status.js';
import { idempotencyKeyOf } from '../idempotency-header.js';
import { StoredFailureReplayError } from '../stored-failure-replay.error.js';

// Fino de propósito: o corpo e o header vão como estão para o caso de uso (que valida e decide), e
// o resultado vira o status pelo mapa. Nenhuma regra de negócio aqui.
@Controller('wagering/transactions')
export class WagerTransactionsController {
  constructor(private readonly processWager: ProcessWagerTransactionUseCase) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessWagerResult> {
    const result = await this.processWager.execute(body, {
      idempotencyKey: idempotencyKeyOf(request),
      correlationId: currentCorrelationId(),
    });
    const status = statusOfResult(result);
    if (status >= 500) {
      // O replay de uma transação que terminou em FAILED: não é sucesso, vira o erro 500.
      throw new StoredFailureReplayError(result);
    }
    response.status(status);
    return result;
  }
}
