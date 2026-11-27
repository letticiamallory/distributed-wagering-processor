import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// Os links relativos do README e do ARCHITECTURE.md (para arquivos e para seções) têm que levar a
// algum lugar. A âncora de uma seção segue a regra do GitHub: minúsculas, sem pontuação (letras com
// acento ficam), espaços viram hífens.
const DOCS = ['README.md', 'ARCHITECTURE.md'];

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(file: string): Set<string> {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return new Set(
    [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1] as string)),
  );
}

describe('relative links in the documentation lead somewhere', () => {
  for (const file of DOCS) {
    test(file, () => {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      const broken: string[] = [];
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^[a-z]+:/i.test(target)) continue; // http(s), mailto
        const [path = '', anchor] = target.split('#');
        const destination = path === '' ? file : join(dirname(file), path);
        if (!existsSync(destination)) {
          broken.push(target);
          continue;
        }
        if (
          anchor &&
          destination.endsWith('.md') &&
          !anchorsOf(destination).has(decodeURIComponent(anchor))
        ) {
          broken.push(target);
        }
      }
      expect(broken).toEqual([]);
    });
  }
});
