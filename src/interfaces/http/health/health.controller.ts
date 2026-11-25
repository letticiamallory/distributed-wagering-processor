import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  // Sem @Inject(): o Nest descobre o tipo pelo metadado que o TypeScript emite
  // (emitDecoratorMetadata). Por isso o import acima é de valor, nunca `import type`.
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }
}
