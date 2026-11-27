import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// A documentação é lida por quem só tem o repositório. "O manual" e "a Fase N" eram o plano de
// trabalho de quem escreveu, que não está no repositório: a referência tem que ser ao nome da
// funcionalidade ou ao número do ADR.
const docs = [
  'README.md',
  'ARCHITECTURE.md',
  ...readdirSync('docs/adr')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/adr/${name}`),
];

describe('no reference to material outside the repository', () => {
  for (const file of docs) {
    test(file, () => {
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter(({ text }) => /\bmanual\b|\bFases? \d/i.test(text))
        .map(({ line, text }) => `${line}: ${text.trim().slice(0, 100)}`);
      expect(offending).toEqual([]);
    });
  }
});

// O ARCHITECTURE.md diz que os testes de crash matam o processo com SIGKILL. Os processos de crash
// tinham `process.exit(137)`: sair com o código de um kill -9 não é ser morto por um.
describe('the crash processes really die by SIGKILL', () => {
  test.each([
    'test/support/consumer-crash-process.ts',
    'test/support/publisher-crash-process.ts',
  ])('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toContain('process.exit(137)');
    expect(source).toContain("process.kill(process.pid, 'SIGKILL')");
  });
});
