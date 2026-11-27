import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// d.1 da segunda avaliação: o README diz que o modelo das variáveis é o `.env.example`, mas faltavam
// variáveis que o código lê. Este teste junta todo nome que o código de produção lê do ambiente e
// exige cada um no `.env.example` (ativo ou comentado, com o padrão).
//
// Como um nome é achado, nos arquivos de src/ que leem o ambiente (`process.env` ou
// `NodeJS.ProcessEnv`): `process.env.X` e `env.X`, e todo literal 'X_Y' em MAIÚSCULAS (é assim que os
// leitores recebem o nome: `name: 'X'`, `intFromEnv('X')`). Os `Symbol('X')` são tokens de injeção
// do Nest, não variáveis.
function filesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
}

// Lidas pelo AWS SDK, não pelo nosso código.
const READ_BY_THE_AWS_SDK = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
];

function variablesReadByTheCode(): string[] {
  const names = new Set<string>(READ_BY_THE_AWS_SDK);
  for (const file of filesOf('src').filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    if (!/process\.env|NodeJS\.ProcessEnv/.test(text)) continue;
    const code = text.replace(/Symbol\('[^']*'\)/g, '');
    for (const [, name] of code.matchAll(
      /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g,
    )) {
      names.add(name as string);
    }
    for (const [, name] of code.matchAll(
      /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g,
    )) {
      names.add(name as string);
    }
  }
  return [...names].sort();
}

const documented = new Set(
  [
    ...readFileSync('.env.example', 'utf8').matchAll(
      /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
    ),
  ].map((m) => m[1] as string),
);

describe('.env.example lists every variable the code reads', () => {
  test('the scan finds the variables (sanity)', () => {
    const found = variablesReadByTheCode();
    expect(found).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'PORT',
        'LOG_LEVEL',
        'DB_POOL_MAX',
      ]),
    );
    expect(found).not.toContain('SQS_CONSUMER_CONFIG');
  });

  test('none is missing', () => {
    expect(
      variablesReadByTheCode().filter((name) => !documented.has(name)),
    ).toEqual([]);
  });

  test('nothing documented that the code no longer reads', () => {
    const read = new Set(variablesReadByTheCode());
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
  });
});
