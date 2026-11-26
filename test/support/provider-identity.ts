import {
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../src/application/ports/provider-identity.port.js';
import { UnauthenticatedError } from '../../src/application/errors/application-errors.js';

class Identity extends ProviderIdentity {
  constructor(private readonly providers: ReadonlySet<string>) {
    super();
  }
  mayActAs(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

// Um provedor de identidade de teste, com a MESMA forma que o real (Keycloak, ADR-0010) terá: cada
// token vale para um conjunto de provedores, e o resto é recusado com UnauthenticatedError. Serve
// para provar o ponto de extensão (401, 403, health aberto) sem subir um IdP.
export class FakeProviderIdentityPort extends ProviderIdentityPort {
  // Cada chamada, com o que o guard entregou: prova que o token chega sem o prefixo "Bearer ".
  calls: Array<string | undefined> = [];

  constructor(private readonly tokens: Record<string, string[]>) {
    super();
  }

  identify(credential: string | undefined): Promise<ProviderIdentity> {
    this.calls.push(credential);
    const providers =
      credential === undefined ? undefined : this.tokens[credential];
    return providers === undefined
      ? Promise.reject(new UnauthenticatedError())
      : Promise.resolve(new Identity(new Set(providers)));
  }
}

// Recusa TODA credencial: o /health tem que continuar aberto mesmo assim.
export class RejectEverythingPort extends ProviderIdentityPort {
  calls = 0;
  identify(): Promise<ProviderIdentity> {
    this.calls++;
    return Promise.reject(new UnauthenticatedError());
  }
}
