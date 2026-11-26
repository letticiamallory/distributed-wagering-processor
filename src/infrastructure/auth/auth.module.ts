import { Global, Module } from '@nestjs/common';
import { ProviderIdentityPort } from '../../application/ports/provider-identity.port.js';
import { UnrestrictedProviderIdentityPort } from './unrestricted-provider-identity.js';

// Liga a porta de identidade à implementação de HOJE (aceita tudo). Para ativar a autenticação
// real, é aqui que a classe do provedor de identidade entra no lugar (ADR-0010).
@Global()
@Module({
  providers: [
    {
      provide: ProviderIdentityPort,
      useFactory: () => new UnrestrictedProviderIdentityPort(),
    },
  ],
  exports: [ProviderIdentityPort],
})
export class AuthModule {}
