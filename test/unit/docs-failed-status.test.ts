import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// O FAILED (enunciado 6.3) é gravado em dois gatilhos, decididos no ADR-0016. A documentação não
// pode voltar a descrever o FAILED como "preparado, não usado", e todo documento que fala dele
// aponta para o ADR que diz quando ele é gravado. Do lado do código, só o caso de uso de
// processamento chama WagerTransaction.fail(): um caminho novo que grave FAILED tem que passar por
// ele (e pela regra da prova).
const docs = [
  'README.md',
  'ARCHITECTURE.md',
  ...readdirSync('docs/adr')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/adr/${name}`),
];

describe('documents that mention FAILED point to ADR-0016 and no longer call it unused', () => {
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    // O próprio ADR-0016 e o índice dos ADRs (que só lista o título dele) ficam de fora.
    if (
      !/\bFAILED\b/.test(text) ||
      file.includes('0016-') ||
      file === 'docs/adr/README.md'
    )
      continue;
    test(file, () => {
      expect(text.includes('ADR-0016')).toBe(true);
      expect(text.includes('nenhum caminho do código grava `FAILED`')).toBe(
        false,
      );
    });
  }

  test('ADR-0016 exists and names both triggers and the outage rule', () => {
    const adr = readdirSync('docs/adr').find((name) =>
      name.startsWith('0016-'),
    );
    expect(adr).toBeDefined();
    const text = readFileSync(`docs/adr/${adr}`, 'utf8');
    expect(text).toContain('PROCESSING_FAILED');
    expect(text).toContain('consumer_delivery_failures');
    expect(text).toContain('PermanentDataError');
    expect(/queda longa do banco/i.test(text)).toBe(true);
  });
});

describe('only the processing use case records FAILED', () => {
  test('WagerTransaction.fail() is called in one place in src/', () => {
    const callers = [...new Bun.Glob('src/**/*.ts').scanSync()].filter((file) =>
      /\.fail\(FailureCode\./.test(readFileSync(file, 'utf8')),
    );
    expect(callers.map((f) => f.replaceAll('\\', '/'))).toEqual([
      'src/application/use-cases/process-wager-transaction.use-case.ts',
    ]);
  });
});
