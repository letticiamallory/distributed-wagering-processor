import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkSources,
  collectSourceFiles,
  type SourceFile,
} from '../../../scripts/check-money.js';

const file = (path: string, ...lines: string[]): SourceFile => ({
  path,
  content: lines.join('\n'),
});

const rulesOf = (files: SourceFile[]) => checkSources(files).map((v) => v.rule);

describe('check-money: numeric conversion of money', () => {
  test.each([
    'const value = parseFloat(amount);',
    'const value = parseInt(balance, 10);',
    'const value = Number(money.amount);',
    'return amount.toFixed(2);',
    'const total = Number(balance) + 1;',
  ])('fails outside Money: %s', (line) => {
    const violations = checkSources([
      file('src/application/use-cases/bet.ts', line),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-number-conversion');
  });

  test('is allowed inside src/domain/money/ (the only place with the Decimal care)', () => {
    expect(
      checkSources([
        file(
          'src/domain/money/money.ts',
          'return this.value.toFixed(2); // amount',
        ),
        file('src/domain/money/other.ts', 'const n = Number(amount);'),
      ]),
    ).toEqual([]);
  });

  test('ignores lines that do not talk about money', () => {
    expect(
      checkSources([
        file(
          'src/main.ts',
          'const port = Number(process.env.PORT);',
          'const retries = parseInt(raw, 10);',
        ),
      ]),
    ).toEqual([]);
  });

  test('ignores comments that mention the forbidden call', () => {
    expect(
      checkSources([
        file(
          'src/application/x.ts',
          '// nunca parseFloat(amount) aqui',
          ' * Number(balance) é proibido',
          '/* parseInt(money) */',
        ),
      ]),
    ).toEqual([]);
  });

  test('ignores a trailing comment that mentions the forbidden call', () => {
    expect(
      checkSources([
        file(
          'src/application/x.ts',
          'const total = 1; // nunca parseFloat(amount)',
          'const url = "https://example.com"; const balance = Number(raw);',
        ),
      ]).map((v) => v.line),
    ).toEqual([2]);
  });

  test('reports the file and the line of each violation', () => {
    const violations = checkSources([
      file(
        'src/interfaces/http/x.ts',
        'const ok = 1;',
        'const a = parseFloat(amount);',
        'const b = 2;',
        'const c = Number(balance);',
      ),
    ]);
    expect(violations.map((v) => [v.path, v.line])).toEqual([
      ['src/interfaces/http/x.ts', 2],
      ['src/interfaces/http/x.ts', 4],
    ]);
  });

  test('handles Windows line endings, trailing comments included', () => {
    const violations = checkSources([
      {
        path: 'src/a.ts',
        content:
          'const ok = 1; // parseFloat(amount)\r\nconst b = Number(balance);\r\n',
      },
    ]);
    expect(violations.map((v) => v.line)).toEqual([2]);
  });

  test('handles Windows line endings', () => {
    const violations = checkSources([
      {
        path: 'src/a.ts',
        content: 'const ok = 1;\r\nconst a = parseFloat(amount);\r\n',
      },
    ]);
    expect(violations.map((v) => v.line)).toEqual([2]);
  });
});

describe('check-money: decimal.js stays inside src/domain/money/', () => {
  test.each([
    "import { Decimal } from 'decimal.js';",
    'import Decimal from "decimal.js";',
    "import type { Decimal } from 'decimal.js';",
    "const { Decimal } = require('decimal.js');",
    "const mod = await import('decimal.js');",
  ])('fails elsewhere: %s', (line) => {
    expect(rulesOf([file('src/domain/wallet/wallet.ts', line)])).toEqual([
      'no-decimal-outside-money',
    ]);
  });

  test('is allowed inside src/domain/money/', () => {
    expect(
      checkSources([
        file(
          'src/domain/money/money.ts',
          "import { Decimal } from 'decimal.js';",
        ),
      ]),
    ).toEqual([]);
  });

  test('also fails in the infrastructure layer', () => {
    expect(
      rulesOf([
        file(
          'src/infrastructure/persistence/x.ts',
          "import { Decimal } from 'decimal.js';",
        ),
      ]),
    ).toEqual(['no-decimal-outside-money']);
  });
});

describe('check-money: the domain does not import frameworks (ADR-0001)', () => {
  test.each([
    "import { Injectable } from '@nestjs/common';",
    "import { Entity } from '@mikro-orm/core';",
    "import { SQSClient } from '@aws-sdk/client-sqs';",
    "import '@nestjs/core';",
    "const m = require('@mikro-orm/postgresql');",
    "const m = await import('@aws-sdk/client-sqs');",
    "export { Module } from '@nestjs/common';",
  ])('fails inside src/domain: %s', (line) => {
    expect(rulesOf([file('src/domain/wallet/wallet.ts', line)])).toEqual([
      'no-framework-in-domain',
    ]);
  });

  test('fails in the nested folders of the domain too', () => {
    expect(
      rulesOf([
        file(
          'src/domain/messaging/events/x.ts',
          "import { Injectable } from '@nestjs/common';",
        ),
      ]),
    ).toEqual(['no-framework-in-domain']);
  });

  test.each([
    [
      'src/infrastructure/persistence/x.ts',
      "import { Entity } from '@mikro-orm/core';",
    ],
    [
      'src/interfaces/http/x.ts',
      "import { Controller } from '@nestjs/common';",
    ],
    [
      'src/application/queue.ts',
      "import { SQSClient } from '@aws-sdk/client-sqs';",
    ],
  ])('is allowed outside the domain: %s', (path, line) => {
    expect(checkSources([file(path, line)])).toEqual([]);
  });

  test('node:crypto is allowed in the domain (standard library, no I/O)', () => {
    expect(
      checkSources([
        file(
          'src/domain/wager/x.ts',
          "import { createHash } from 'node:crypto';",
        ),
      ]),
    ).toEqual([]);
  });

  test('a package that only looks similar is not a framework', () => {
    expect(
      checkSources([
        file('src/domain/x.ts', "import { x } from '@nestjs-like/thing';"),
      ]),
    ).toEqual([]);
  });

  test('a comment mentioning the framework is fine', () => {
    expect(
      checkSources([
        file('src/domain/x.ts', "// não importe '@nestjs/common' aqui"),
      ]),
    ).toEqual([]);
  });
});

describe('check-money: the command', () => {
  const script = join(import.meta.dir, '../../../scripts/check-money.ts');

  function run(files: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), 'check-money-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(cwd, dirname(path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
      }
      const result = Bun.spawnSync([process.execPath, script], { cwd });
      return {
        code: result.exitCode,
        out: result.stdout.toString() + result.stderr.toString(),
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  test('exits 0 when everything is clean', () => {
    const r = run({ 'src/domain/x.ts': 'export const x = 1;\n' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('check:money OK');
  });

  test('exits 1 and names file, line and rule on a violation', () => {
    const r = run({
      'src/application/bet.ts': 'const a = 1;\nconst b = parseFloat(amount);\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/application/bet.ts:2');
    expect(r.out).toContain('no-number-conversion');
  });

  test('exits 1 for a framework import inside the domain', () => {
    const r = run({
      'src/domain/wallet/w.ts':
        "import { Injectable } from '@nestjs/common';\n",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no-framework-in-domain');
  });
});

describe('check-money: the real project', () => {
  test('src/ passes today, so a regression shows up in bun test too', () => {
    const files = collectSourceFiles('src');
    expect(files.length).toBeGreaterThan(20);
    expect(checkSources(files)).toEqual([]);
  });

  test('collected paths use forward slashes and start with src/', () => {
    for (const f of collectSourceFiles('src')) {
      expect(f.path.startsWith('src/')).toBe(true);
      expect(f.path).not.toContain('\\');
    }
  });
});
