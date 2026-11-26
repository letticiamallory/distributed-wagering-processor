import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { TransactionView } from '../../../application/queries/queries.js';
import { GetTransactionUseCase } from '../../../application/use-cases/queries.use-cases.js';
import { addLogFields } from '../../../infrastructure/observability/log-context.js';
import { ProviderAuthGuard } from '../provider-auth.guard.js';

// A mesma transação, achada pela chave que o PROVEDOR conhece (o id dele). O guard confere que o
// token pode agir como o `:providerId` da rota (403 se não), como confere o `providerId` do corpo.
@UseGuards(ProviderAuthGuard)
@Controller('providers/:providerId/wagering/transactions')
export class ProvidersController {
  constructor(private readonly getTransaction: GetTransactionUseCase) {}

  @Get(':externalTransactionId')
  async get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    const view = await this.getTransaction.byProviderKey(
      providerId,
      externalTransactionId,
    );
    addLogFields({
      providerId: view.providerId,
      transactionId: view.transactionId,
      walletId: view.walletId,
    });
    return view;
  }
}
