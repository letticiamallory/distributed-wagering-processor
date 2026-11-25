import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';

// Guarda contra o erro silencioso do `import type` no controller: se o Nest não
// conseguir injetar o HealthService, o app nem sobe e este teste falha.
let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
});

afterAll(async () => {
  await app.close();
});

test('GET /health/live answers ok (constructor injection works on Bun)', async () => {
  const res = await fetch(`${await app.getUrl()}/health/live`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});
