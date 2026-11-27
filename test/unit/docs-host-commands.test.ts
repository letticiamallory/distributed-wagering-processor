import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';

const README = readFileSync('README.md', 'utf8');
const ARCHITECTURE = readFileSync('ARCHITECTURE.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};
const has = (text: string, pattern: RegExp) => pattern.test(text);

// E2: o compose não precisa de .env, mas os comandos do HOST (migration:up/down, os testes) leem o
// DATABASE_URL e o SQS_ENDPOINT do ambiente. Sem .env, `bun run migration:up` falha num clone limpo.
describe('the README tells how to prepare the host commands', () => {
  test('copy .env.example to .env, in bash and in PowerShell', () => {
    expect(README.includes('cp .env.example .env')).toBe(true);
    expect(README.includes('Copy-Item .env.example .env')).toBe(true);
  });
});

// E9: `a && b` não roda no Windows PowerShell 5.1. Um script só, que roda as verificações em
// sequência e para na primeira que falhar, funciona em qualquer shell.
describe('bun run check runs the static checks in sequence, without &&', () => {
  test('the script exists and does not chain with &&', () => {
    expect(pkg.scripts.check).toBeDefined();
    expect(pkg.scripts.check).not.toContain('&&');
  });

  test('it runs typecheck, lint, format:check and check:money, in this order', () => {
    const source = readFileSync('scripts/check.ts', 'utf8');
    const order = ['typecheck', 'lint', 'format:check', 'check:money'].map(
      (name) => source.indexOf(`'${name}'`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the README shows bun run check and no command line chained with &&', () => {
    expect(README.includes('bun run check')).toBe(true);
    const chained = README.split('\n').filter((line) =>
      /^\s*bun run .*&&/.test(line),
    );
    expect(chained).toEqual([]);
  });
});

// E10: PENDING_REFERENCE_MAX_ATTEMPTS = 10 é o total de tentativas, mas uma transação rejeitada por
// REFERENCE_NOT_FOUND mostra attempts = 9. O campo conta as tentativas que NÃO acharam a referência
// e deixaram a transação esperando; a tentativa que decide não entra. Isso tem que estar escrito.
describe('attempts vs. the attempt limit', () => {
  test('with the limit of 10, a reference that never arrives is rejected with attempts = 9', () => {
    const schedule = new PendingReferenceSchedule();
    let attempts = 0;
    let tries = 0;
    for (;;) {
      tries++;
      if (schedule.isExhausted(attempts)) break; // esta tentativa decide: REJECTED
      attempts++; // esta tentativa não achou: PENDING_REFERENCE, attempts + 1
    }
    expect(tries).toBe(10);
    expect(attempts).toBe(9);
  });

  test('the README and ARCHITECTURE.md explain it', () => {
    for (const text of [README, ARCHITECTURE]) {
      expect(has(text, /`attempts`[^\n]*(conta|é o número)/)).toBe(true);
      expect(has(text, /attempts:? ?(=|é) ?9|`attempts: 9`/)).toBe(true);
    }
  });
});
