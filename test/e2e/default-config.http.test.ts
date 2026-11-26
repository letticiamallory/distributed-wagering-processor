import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ProviderIdentityPort } from '../../src/application/ports/provider-identity.port.js';
import { UnrestrictedProviderIdentityPort } from '../../src/infrastructure/auth/unrestricted-provider-identity.js';
import {
  createWalletVia,
  defaultKeyOf,
  newPlayerId,
  startApp,
  submitVia,
  wagerBody,
  type TestApp,
} from '../support/http-app.js';

// O AVALIADOR roda os exemplos do README (curl) SEM token. Este arquivo prova que a aplicação, na
// configuração PADRÃO (a mesma do docker compose: nenhuma variável de autenticação, nenhuma troca
// de provedor), atende as rotas de negócio sem o header Authorization. Se alguém ligar a
// autenticação real por padrão, este arquivo falha antes de os exemplos do README quebrarem.
let app: TestApp;
beforeAll(async () => {
  app = await startApp(); // sem env extra e sem overrides: o que o compose sobe
}, 60_000);
afterAll(async () => {
  await app.close();
});

describe('the default configuration (the one in docker compose) needs no token', () => {
  test('the identity port that is wired is the no-op that accepts everything', () => {
    expect(app.nest.get(ProviderIdentityPort)).toBeInstanceOf(
      UnrestrictedProviderIdentityPort,
    );
  });

  test('POST /wallets works with NO Authorization header, like the README example', async () => {
    const response = await app.post('/wallets', {
      playerId: newPlayerId(),
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.body).toMatchObject({
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('POST /wagering/transactions works with NO Authorization header, only the Idempotency-Key', async () => {
    const wallet = await createWalletVia(app, '1000.00');
    const input = wagerBody(wallet, { providerId: 'provider-a' });

    const first = await submitVia(app, input, defaultKeyOf(input));
    const replay = await submitVia(app, input, defaultKeyOf(input));

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true });
  });

  test('any providerId is accepted: there is no token to compare it with', async () => {
    const wallet = await createWalletVia(app);
    for (const providerId of ['provider-a', 'provider-b', 'novo-provedor']) {
      const input = wagerBody(wallet, { providerId });
      expect((await submitVia(app, input)).status).toBe(201);
    }
  });

  test('a stray Authorization header (a client that always sends one) does not break anything', async () => {
    const response = await app.post(
      '/wallets',
      {
        playerId: newPlayerId(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      },
      { authorization: 'Bearer some-token-from-a-future-idp' },
    );
    expect(response.status).toBe(201);
  });

  test('/health/live is open', async () => {
    const response = await app.get('/health/live');
    expect(response.status).toBe(200);
  });
});

describe('docker-compose.yml does not turn authentication on', () => {
  // As variáveis que o serviço "app" recebe no compose. Se uma delas parecer configuração de
  // autenticação, a aplicação deixaria de atender os exemplos do README sem token.
  const composeEnvNamesOfApp = (): string[] => {
    const lines = readFileSync('docker-compose.yml', 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => /^ {2}app:\s*$/.test(line));
    expect(start).toBeGreaterThan(-1);
    const names: string[] = [];
    let inEnvironment = false;
    for (const line of lines.slice(start + 1)) {
      if (/^ {2}\S/.test(line)) break; // outro serviço
      if (/^ {4}environment:\s*$/.test(line)) {
        inEnvironment = true;
        continue;
      }
      if (inEnvironment) {
        const name = /^ {6}([A-Z0-9_]+):/.exec(line)?.[1];
        if (name) names.push(name);
        else if (/^ {4}\S/.test(line)) inEnvironment = false;
      }
    }
    return names;
  };

  test('the app service environment has no authentication variable', () => {
    const names = composeEnvNamesOfApp();
    expect(names).toContain('DATABASE_URL'); // o parser achou o bloco certo
    const auth = names.filter((name) =>
      /AUTH|TOKEN|JWT|JWKS|OIDC|KEYCLOAK|ISSUER|AUDIENCE|CLIENT_(ID|SECRET)|API_KEY/i.test(
        name,
      ),
    );
    expect(auth).toEqual([]);
  });
});
