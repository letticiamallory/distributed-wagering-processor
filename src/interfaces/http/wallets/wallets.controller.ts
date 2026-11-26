import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateWalletUseCase,
  type CreateWalletResult,
} from '../../../application/use-cases/create-wallet.use-case.js';
import { currentCorrelationId } from '../correlation-id.js';

// Fino de propósito: passa o corpo bruto ao caso de uso (que valida) e devolve o resultado com o
// status. Nenhuma regra de negócio aqui.
@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateWalletResult> {
    const wallet = await this.createWallet.execute(body, {
      correlationId: currentCorrelationId(),
    });
    response.status(201);
    return wallet;
  }
}
