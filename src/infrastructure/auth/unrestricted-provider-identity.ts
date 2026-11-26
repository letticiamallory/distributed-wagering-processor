import {
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity.port.js';

// A identidade de HOJE: age em nome de qualquer provedor (ADR-0010).
export class UnrestrictedProviderIdentity extends ProviderIdentity {
  mayActAs(_providerId: string): boolean {
    return true;
  }
}

// A implementação de HOJE da porta de identidade: aceita qualquer credencial, inclusive nenhuma.
// A autenticação não vale pontos no desafio (enunciado, seção 2), então o que existe é o PONTO DE
// EXTENSÃO: a porta, o guard e os testes. O desenho que adotaríamos (Keycloak, client credentials
// por provedor, JWT validado pelo JWKS, claim com o providerId) está no ADR-0010; trocá-lo por
// esta classe não mexe em nenhum caso de uso, controller ou guard.
//
// NÃO exponha o serviço fora de uma rede confiável enquanto esta for a implementação ligada.
export class UnrestrictedProviderIdentityPort extends ProviderIdentityPort {
  identify(_credential: string | undefined): Promise<ProviderIdentity> {
    return Promise.resolve(new UnrestrictedProviderIdentity());
  }
}
