import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// E5: um número "medido" que o leitor não consegue refazer com um comando do repositório tem que
// dizer de onde veio (durante o desenvolvimento, em que máquina), ou sair. Regra por seção (o texto
// entre dois títulos): se ela fala de medição ou de sabotagem, ela traz o comando que refaz a
// medida OU a marca de medição de desenvolvimento, e essa marca diz a máquina.
const DEV_MARK = 'medido durante o desenvolvimento';
const MACHINE = /Windows 11\s+com\s+Docker\s+Desktop/;
const COMMAND =
  /`(?:CLIENT_RETRY_JITTER=\w+ )?bun (?:run test:concurrency|test test\/concurrency[^`]*)`/;
const TALKS_ABOUT_MEASURES =
  /\bmedid[oa]s?\b|\bmediu\b|\bmedição\b|sabotag|execuções seguidas/i;

const docs = [
  'ARCHITECTURE.md',
  ...readdirSync('docs/adr')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/adr/${name}`),
];

function sections(text: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let current = { title: '(top)', body: '' };
  for (const line of text.split('\n')) {
    if (/^#{1,4} /.test(line)) {
      out.push(current);
      current = { title: line, body: '' };
    } else {
      current.body += `${line}\n`;
    }
  }
  out.push(current);
  return out;
}

describe('every measured number says how to redo it, or where it was measured', () => {
  for (const file of docs) {
    test(file, () => {
      const unsourced = sections(readFileSync(file, 'utf8'))
        .filter(({ title, body }) => TALKS_ABOUT_MEASURES.test(title + body))
        .filter(({ body }) => !COMMAND.test(body) && !body.includes(DEV_MARK))
        .map(({ title }) => title);
      expect(unsourced).toEqual([]);
    });
  }

  test('the development mark always names the machine', () => {
    for (const file of docs) {
      const text = readFileSync(file, 'utf8');
      let index = text.indexOf(DEV_MARK);
      while (index >= 0) {
        expect(MACHINE.test(text.slice(index, index + 300))).toBe(true);
        index = text.indexOf(DEV_MARK, index + 1);
      }
    }
  });

  test('the numbers seen before the instrumentation (not reproducible by anything) are gone', () => {
    const text = readFileSync('ARCHITECTURE.md', 'utf8');
    expect(text.includes('1143')).toBe(false);
    expect(text.includes('1408')).toBe(false);
  });
});
