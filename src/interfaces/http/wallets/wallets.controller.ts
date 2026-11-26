import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  LedgerPage,
  ReconciliationResult,
  WalletView,
} from '../../../application/queries/queries.js';
import {
  CreateWalletUseCase,
  type CreateWalletResult,
} from '../../../application/use-cases/create-wallet.use-case.js';
import {
  GetWalletUseCase,
  ListLedgerUseCase,
} from '../../../application/use-cases/queries.use-cases.js';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case.js';
import { addLogFields } from '../../../infrastructure/observability/log-context.js';
import { currentCorrelationId } from '../correlation-id.js';
import { ProviderAuthGuard } from '../provider-auth.guard.js';

// Fino de propósito: passa o corpo (ou os parâmetros) brutos ao caso de uso, que valida, e devolve o
// resultado com o status. Nenhuma regra de negócio aqui.
@UseGuards(ProviderAuthGuard)
@Controller('wallets')
export class WalletsController {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateWalletResult> {
    const wallet = await this.createWallet.execute(body, {
      correlationId: currentCorrelationId(),
    });
    addLogFields({ walletId: wallet.id });
    response.status(201);
    return wallet;
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    const wallet = await this.getWallet.execute({ walletId });
    addLogFields({ walletId: wallet.id });
    return wallet;
  }

  // ?limit= (1 a 100, padrão 50) e ?cursor= (opaco, vem do nextCursor da página anterior)
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<LedgerPage> {
    const page = await this.listLedger.execute({ walletId, cursor, limit });
    addLogFields({ walletId });
    return page;
  }

  // Confere o saldo contra o ledger. Responde 200 também quando ACHA uma divergência: a consulta
  // funcionou, e o que ela encontrou está no corpo (consistent: false). Nunca corrige.
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResult> {
    const result = await this.reconcile.execute({ walletId });
    addLogFields({ walletId: result.walletId });
    if (!result.consistent) {
      // Só o que identifica e classifica: nenhum valor (nem o saldo nem a diferença) vai para o log;
      // quem precisa deles os tem na resposta, com credencial.
      this.logger.error({
        event: 'reconciliation_divergence',
        walletId: result.walletId,
        findings: result.findings,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}
