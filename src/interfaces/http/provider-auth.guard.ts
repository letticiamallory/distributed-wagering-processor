import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProviderForbiddenError } from '../../application/errors/application-errors.js';
import { ProviderIdentityPort } from '../../application/ports/provider-identity.port.js';

// "Authorization: Bearer <token>", com o nome do esquema sem diferenciar maiúsculas. Qualquer
// outro esquema (Basic, por exemplo) conta como "sem credencial" e quem decide é a porta.
const BEARER = /^Bearer\s+(\S+)\s*$/i;

export function bearerTokenOf(request: Request): string | undefined {
  return BEARER.exec(request.header('authorization') ?? '')?.[1];
}

// A autenticação das rotas de NEGÓCIO (ADR-0010). Aplicado por controller, nunca no /health, que
// fica aberto (enunciado, seção 2). Faz duas perguntas, nesta ordem, antes de qualquer validação
// do corpo (um token ruim é 401 mesmo com o corpo ruim):
//   1. quem é você?              -> ProviderIdentityPort (401 se não for ninguém)
//   2. você pode agir como ESTE provedor? -> só quando o corpo traz um `providerId` (403 se não)
// Sem regra de negócio aqui: a validação do `providerId` (não vazio, até 200 caracteres) é do
// caso de uso e vale também para a fila, que não passa por este guard.
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly identityPort: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = await this.identityPort.identify(bearerTokenOf(request));

    const body = request.body as { providerId?: unknown } | undefined;
    const providerId = body?.providerId;
    // Sem `providerId` em texto (a criação de wallet, ou um corpo malformado) não há com o que
    // comparar: o caso de uso responde 400 se for o caso.
    if (typeof providerId === 'string' && !identity.mayActAs(providerId)) {
      throw new ProviderForbiddenError(providerId);
    }
    return true;
  }
}
