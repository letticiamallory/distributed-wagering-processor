import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HttpConfig } from '../http-config.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  // Sem @Inject() no serviço: o Nest descobre o tipo pelo metadado que o TypeScript emite
  // (emitDecoratorMetadata). Por isso o import acima é de valor, nunca `import type`.
  constructor(
    private readonly health: HealthService,
    @Inject(HttpConfig) private readonly config: HttpConfig,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  // 200 com tudo de pé; 503 (com Retry-After) se o PostgreSQL ou o SQS não responderem. A
  // resposta diz QUAL caiu, e nada além disso (nada de string de conexão nem de texto de erro).
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<{
    status: 'ok' | 'unavailable' | 'shutting_down';
    checks: Record<string, 'up' | 'down'>;
  }> {
    const { ok, checks, shuttingDown } = await this.health.ready();
    if (!ok) {
      response.status(503);
      response.setHeader('Retry-After', String(this.config.retryAfterSeconds));
    }
    return {
      status: shuttingDown ? 'shutting_down' : ok ? 'ok' : 'unavailable',
      checks,
    };
  }
}
