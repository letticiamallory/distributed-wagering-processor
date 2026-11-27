import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { TEST_CONNECTION_TIMEOUT_MS } from '../support/database.js';

// Falhas intermitentes só na suíte COMPLETA (no Docker do Windows, com processos filhos subindo e
// descendo): o service-restart esperou 3 s por uma conexão do pool do PRÓPRIO processo de testes
// (o acquire timeout de produção, que também vale para abrir a conexão), e um teste e2e passou do
// prazo padrão de 5 s do Bun. São prazos da infraestrutura de teste, não do sistema sob teste: as
// apps que os testes sobem continuam com os valores de produção, e os testes de pool cheio pedem os
// seus prazos curtos explicitamente.
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

describe('timeouts of the test harness (not of the system under test)', () => {
  test('the harness pools wait up to 15 s for a connection', () => {
    expect(TEST_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  test.each(['test', 'test:concurrency'])(
    'the %s script gives each test at least 20 s',
    (script) => {
      const runs = (pkg.scripts[script] ?? '')
        .split('&&')
        .filter((part) => /\bbun test\b/.test(part));
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        const timeout = /--timeout (\d+)/.exec(run)?.[1];
        expect(Number(timeout)).toBeGreaterThanOrEqual(20_000);
      }
    },
  );
});
