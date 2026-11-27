import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// A tabela "Onde está cada requisito" do README é o mapa do avaliador: requisito do enunciado, o
// código que o cumpre e o teste que o prova. Um mapa com um caminho errado é pior que nenhum. Este
// teste confere que todo caminho citado existe, e que toda linha aponta para pelo menos um teste.
const README = readFileSync('README.md', 'utf8');
const section =
  /## Onde está cada requisito\n([\s\S]*?)\n## /.exec(README)?.[1] ?? '';

const rows = section
  .split('\n')
  .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
  .slice(1) // o cabeçalho
  .map((line) => {
    const [requirement = '', where = '', proof = ''] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return { requirement, where, proof };
  });

const pathsIn = (cell: string) =>
  [...cell.matchAll(/`((?:src|test|scripts)\/[^`\s]+)`/g)].map(
    (m) => m[1] as string,
  );

describe('the README requirements table', () => {
  test('exists and covers the challenge (at least 30 rows)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  test('every path it cites exists in the repository', () => {
    const missing = rows
      .flatMap((row) => [...pathsIn(row.where), ...pathsIn(row.proof)])
      .filter((path) => !existsSync(path));
    expect(missing).toEqual([]);
  });

  test('every row points to at least one test file', () => {
    const withoutTest = rows
      .filter((row) => !pathsIn(row.proof).some((p) => p.endsWith('.test.ts')))
      .map((row) => row.requirement);
    expect(withoutTest).toEqual([]);
  });

  test('every row says which section of the challenge it answers', () => {
    const withoutSection = rows
      .filter(
        (row) =>
          !/\((?:[\d.]+(?:, )?|ADR-\d{4}(?:, )?)+\)/.test(row.requirement),
      )
      .map((row) => row.requirement);
    expect(withoutSection).toEqual([]);
  });
});
