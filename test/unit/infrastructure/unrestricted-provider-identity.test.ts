import { describe, expect, test } from 'bun:test';
import { ProviderIdentityPort } from '../../../src/application/ports/provider-identity.port.js';
import { UnrestrictedProviderIdentityPort } from '../../../src/infrastructure/auth/unrestricted-provider-identity.js';

// A implementação de HOJE (ADR-0010): aceita tudo. Existe para o ponto de extensão estar no
// lugar e testado; trocá-la pelo provedor de identidade real não mexe em mais nada.
describe('UnrestrictedProviderIdentityPort (the no-op that is in use today)', () => {
  const port = new UnrestrictedProviderIdentityPort();

  test('is a ProviderIdentityPort, so the real one can replace it', () => {
    expect(port).toBeInstanceOf(ProviderIdentityPort);
  });

  test.each([undefined, '', 'any-token', 'a.b.c', 'x'.repeat(5_000)])(
    'accepts the credential %p, even a missing one',
    async (credential) => {
      const identity = await port.identify(credential);
      expect(identity).toBeDefined();
    },
  );

  test.each(['provider-a', 'provider-b', 'internal', '', 'x'.repeat(500)])(
    'lets the caller act as ANY provider (%p)',
    async (providerId) => {
      const identity = await port.identify('whatever');
      expect(identity.mayActAs(providerId)).toBe(true);
    },
  );

  test('never rejects: there is no failing path in the no-op', async () => {
    for (const credential of [undefined, '', 'garbage']) {
      const outcome = await port.identify(credential).then(
        () => 'ok',
        () => 'rejected',
      );
      expect(outcome).toBe('ok');
    }
  });
});
