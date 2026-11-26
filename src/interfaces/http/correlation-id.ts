import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  currentLogContext,
  runWithLogContext,
} from '../../infrastructure/observability/log-context.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

// O que o provedor manda vai direto para os logs e para os eventos: só entra o que parece um
// identificador (letras, dígitos, ponto, dois-pontos, hífen e sublinhado, até 128). Qualquer
// outra coisa (espaço, aspas, <script>, quebra de linha) é descartada e vira um UUID novo.
const VALID_CORRELATION_ID = /^[\w.:-]{1,128}$/;

export function correlationIdFrom(header: string | undefined): string {
  return header !== undefined && VALID_CORRELATION_ID.test(header)
    ? header
    : randomUUID();
}

// Lê X-Correlation-Id (ou gera um UUID), devolve no cabeçalho da resposta e deixa o valor
// disponível durante toda a requisição, sem passar por parâmetro.
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId = correlationIdFrom(req.header(CORRELATION_ID_HEADER));
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  // O mesmo contexto leva o id e os identificadores que os controllers acrescentarem: todo log
  // feito durante a requisição os traz, sem passar por parâmetro.
  runWithLogContext(correlationId, {}, next);
}

// O id da requisição em andamento. Fora de uma requisição (um teste de unidade, por exemplo)
// devolve um novo, para quem chama nunca receber vazio.
export function currentCorrelationId(): string {
  return currentLogContext()?.correlationId ?? randomUUID();
}
