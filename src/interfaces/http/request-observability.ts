import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { MetricsPort } from '../../application/ports/metrics.port.js';
import { currentLogContext } from '../../infrastructure/observability/log-context.js';

// O que se observa de TODA requisição HTTP, inclusive as que dão erro e as de rota inexistente:
//   - uma linha de log `request_completed` (método, rota, status, duração, correlationId e os
//     identificadores que o controller acrescentou: walletId, providerId, transactionId)
//   - http_requests_total e http_request_duration_seconds
//
// A rota é o PADRÃO (`/wagering/transactions`), nunca a URL pedida; o que não casa com rota nenhuma
// vira "unmatched". Assim um scanner batendo em mil URLs cria uma série só, e não mil.
// O /metrics e o /health vão para o nível debug: raspagem e sonda a cada poucos segundos não são
// o que se quer ler no log.
const QUIET_ROUTES = new Set(['/metrics', '/health/live', '/health/ready']);

export function requestObservability(metrics: MetricsPort) {
  const logger = new Logger('Http');
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    // O contexto de log é capturado AGORA: o evento "finish" pode disparar fora dele.
    const context = currentLogContext();
    res.on('finish', () => {
      const route =
        typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const seconds = (performance.now() - started) / 1_000;
      metrics.increment('http_requests_total', {
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      metrics.observe(
        'http_request_duration_seconds',
        { method: req.method, route },
        seconds,
      );
      const entry = {
        event: 'request_completed',
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1_000 * 10) / 10,
        ...(context && {
          correlationId: context.correlationId,
          ...context.fields,
        }),
      };
      if (QUIET_ROUTES.has(route)) {
        logger.debug(entry);
      } else {
        logger.log(entry);
      }
    });
    next();
  };
}
