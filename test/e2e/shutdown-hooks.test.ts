import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/bootstrap.js';

// O SIGTERM só chega ao consumidor se alguém o escuta: o createApp() instala o encerramento em
// ordem (gracefulShutdown: drenagem do HTTP, depois o resto). Sem isso o processo morre no meio de
// uma mensagem e nada é devolvido à fila. O sinal em si não dá para disparar
// aqui sem matar o próprio teste (e no Windows um SIGTERM nem roda handlers); a prova é que o
// app que o main.ts sobe REGISTRA o handler, e que o main.ts usa esse mesmo app.
describe('the SIGTERM wiring of the real bootstrap', () => {
  test('createApp() registers a SIGTERM and a SIGINT listener, and close() removes them', async () => {
    const before = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    };
    const app = await createApp();
    // Como o main.ts: a porta aberta. Os ouvintes saem quando o servidor HTTP fecha (no app.close()).
    await app.listen(0);
    try {
      // O encerramento do bootstrap e o do HealthService (que vira o /ready para 503 no ato).
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 2);
      expect(process.listenerCount('SIGINT')).toBe(before.int + 2);
      const handlers = process.listeners('SIGTERM').map(String).join('\n');
      expect(handlers).toContain('gracefulShutdown');
    } finally {
      await app.close();
    }
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
  }, 30_000);

  test('src/main.ts starts the application through createApp()', async () => {
    const main = await Bun.file('src/main.ts').text();
    expect(main).toContain('createApp()');
    expect(main).not.toContain('NestFactory');
  });
});
