import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// O status FAILED existe no domínio (WagerTransaction.fail) e no schema, mas NENHUM caminho do
// código o grava hoje (a proposta de quando gravá-lo está em aberto). A documentação descrevia o
// tratamento do replay de FAILED (500, ack) como se acontecesse. Todo documento que fala de FAILED
// tem que dizer que ele não é gravado, e o código tem que continuar sem gravá-lo: se um dia gravar,
// este teste falha e obriga a atualizar a documentação junto.
const NOTICE = 'nenhum caminho do código grava `FAILED`';

const docs = [
  'README.md',
  'ARCHITECTURE.md',
  ...readdirSync('docs/adr')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/adr/${name}`),
];

describe('documents that mention FAILED say it is not recorded today', () => {
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    if (!/\bFAILED\b/.test(text)) continue;
    test(file, () => {
      expect(text.includes(NOTICE)).toBe(true);
    });
  }
});

describe('the code really never records FAILED', () => {
  test('WagerTransaction.fail() has no caller in src/', () => {
    const files = new Bun.Glob('src/**/*.ts').scanSync();
    const callers = [...files].filter((file) =>
      /\.fail\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers).toEqual([]);
  });
});
