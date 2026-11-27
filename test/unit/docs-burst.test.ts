import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// E6 do avaliador: o 503 por pool cheio não é só da wallet quente. Qualquer rajada maior que o pool
// (20 conexões por processo) o produz, mesmo em wallets distintas. O ARCHITECTURE.md e o ADR-0007
// têm que dizer isso, com a tabela medida de 1 s, 3 s e 5 s de acquire timeout e o comando que a
// refaz (que existe no repositório).
const ARCHITECTURE = readFileSync('ARCHITECTURE.md', 'utf8');
const ADR = readFileSync(
  'docs/adr/0007-pessimistic-lock-per-wallet.md',
  'utf8',
);
const COMMAND = 'bun scripts/burst.ts';

describe('the 503 of a burst larger than the pool is documented, with numbers and a command', () => {
  for (const [name, text] of [
    ['ARCHITECTURE.md', ARCHITECTURE],
    ['ADR-0007', ADR],
  ] as const) {
    test(`${name} says it is any burst larger than the pool, not only the hot wallet`, () => {
      expect(/qualquer rajada maior que o pool/i.test(text)).toBe(true);
    });

    test(`${name} has the 1 s / 3 s / 5 s table and the command that redoes it`, () => {
      for (const row of [/\|\s*1 s\b/, /\|\s*3 s \(padrão\)/, /\|\s*5 s\b/]) {
        expect(row.test(text)).toBe(true);
      }
      expect(text.includes(COMMAND)).toBe(true);
    });
  }

  test('the separate pool for the workers is documented as future work', () => {
    expect(
      /pool próprio[^\n]*workers|workers[^\n]*pool próprio/i.test(ARCHITECTURE),
    ).toBe(true);
  });

  test('the command exists, and the compose app lets you choose the acquire timeout', () => {
    expect(Bun.file('scripts/burst.ts').size).toBeGreaterThan(0);
    const compose = readFileSync('docker-compose.yml', 'utf8');
    expect(
      compose.includes('DB_ACQUIRE_TIMEOUT_MS: ${DB_ACQUIRE_TIMEOUT_MS:-3000}'),
    ).toBe(true);
  });
});
