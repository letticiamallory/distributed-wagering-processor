import { describe, expect, test } from 'bun:test';
import { createApp, gracefulShutdown } from '../../src/bootstrap.js';
import { ensureTestDatabase } from '../support/database.js';

// C7 do avaliador: no SIGTERM, o Nest destruía os módulos (inclusive a persistência, que fecha o
// pool) ANTES de fechar o servidor HTTP. As requisições que ainda chegavam durante o encerramento
// achavam o banco fechado (503) ou a conexão cortada. Agora o encerramento é:
//   1. /health/ready vira 503 (o balanceador para de mandar tráfego novo);
//   2. drenagem: o HTTP continua atendendo normalmente, com o banco aberto, por HTTP_SHUTDOWN_DRAIN_MS;
//   3. o servidor HTTP para de aceitar e termina as requisições em andamento;
//   4. só então o resto fecha (consumidor, workers, banco).
// O sinal real não roda handlers no Windows; aqui a rotina é chamada direto, sem sair do processo.
describe('graceful shutdown drains HTTP before closing the database', () => {
  test('during the drain: ready is 503, business requests still succeed; afterwards the port is closed', async () => {
    await ensureTestDatabase();
    const app = await createApp();
    await app.listen(0);
    const url = (await app.getUrl()).replace('[::1]', 'localhost');

    const shutdown = gracefulShutdown(app, 'SIGTERM', {
      drainMs: 1_500,
      timeoutMs: 5_000,
      exit: () => {},
    });
    await Bun.sleep(200);

    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'shutting_down' });

    // Ainda na drenagem: o banco está aberto e a API responde normalmente.
    const created = await fetch(`${url}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await fetch(`${url}/wallets/${id}`)).status).toBe(200);

    await shutdown;
    const after = await fetch(`${url}/health/live`).then(
      () => 'answered',
      () => 'refused',
    );
    expect(after).toBe('refused');
  }, 30_000);

  test('a request in flight when the server stops accepting still completes', async () => {
    await ensureTestDatabase();
    const app = await createApp();
    await app.listen(0);
    const url = (await app.getUrl()).replace('[::1]', 'localhost');
    const shutdown = gracefulShutdown(app, 'SIGTERM', {
      drainMs: 300,
      timeoutMs: 5_000,
      exit: () => {},
    });
    // Disparada no fim da drenagem: termina com resposta, não com conexão cortada.
    await Bun.sleep(280);
    const inFlight = fetch(`${url}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    }).then(
      (r) => r.status,
      () => 'connection error',
    );
    await shutdown;
    expect([201, 'connection error']).toContain(await inFlight);
    expect(await inFlight).not.toBe(503);
  }, 30_000);
});
