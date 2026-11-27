import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// d.2 da segunda avaliação: os números da rajada (p95 e 503 em 150) são medidas de UMA máquina, não
// propriedades do sistema. O texto dizia que 3 s "mantém o p95 abaixo de 5 s", e na máquina do
// avaliador, com o mesmo comando, o p95 chegou a 5,7 s e os 503 foram de 0 a 85. Os dois documentos
// que trazem a tabela têm que apresentar os números como medidas e citar a faixa do avaliador.
const DOCS = [
  'ARCHITECTURE.md',
  'docs/adr/0007-pessimistic-lock-per-wallet.md',
];

describe('the burst numbers are measurements of a machine, not properties', () => {
  for (const file of DOCS) {
    test(file, () => {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/mant[ée]m o p95 abaixo/);
      // a faixa que o avaliador mediu, com o comando de sempre
      expect(text).toContain('0–85');
      expect(text).toContain('5,7 s');
      expect(text).toMatch(/segunda avaliação/);
      expect(text).toMatch(/não (?:são|é) (?:uma )?propriedade/);
    });
  }
});
