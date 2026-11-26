import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/bootstrap.js';

// O SIGTERM só chega ao consumidor se o Nest o escuta (enableShutdownHooks). Sem isso o processo
// morre no meio de uma mensagem e nada é devolvido à fila. O sinal em si não dá para disparar
// aqui sem matar o próprio teste (e no Windows um SIGTERM nem roda handlers); a prova é que o
// app que o main.ts sobe REGISTRA o handler, e que o main.ts usa esse mesmo app.
describe('the SIGTERM wiring of the real bootstrap', () => {
  test('createApp() registers a SIGTERM and a SIGINT listener, and close() removes them', async () => {
    const before = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    };
    const app = await createApp();
    try {
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
      expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    } finally {
      await app.close();
    }
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  }, 30_000);

  test('src/main.ts starts the application through createApp()', async () => {
    const main = await Bun.file('src/main.ts').text();
    expect(main).toContain('createApp()');
    expect(main).not.toContain('NestFactory');
  });
});
