// Guarda das regras invioláveis do CLAUDE.md, rodado por `bun run check:money`:
//   1. dinheiro nunca passa por number/float fora de src/domain/money/;
//   2. decimal.js só aparece dentro de src/domain/money/;
//   3. o domínio não importa Nest, MikroORM nem AWS SDK (ADR-0001);
//   4. as camadas só apontam para dentro: domain não importa de application, infrastructure
//      ou interfaces, e application não importa de infrastructure nem de interfaces (ADR-0001).
// node:crypto continua permitido no domínio: é biblioteca padrão, sem I/O e determinística.
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

export interface SourceFile {
  path: string; // sempre com "/" e relativo à raiz do projeto, por exemplo src/domain/x.ts
  content: string;
}

export type Rule =
  | 'no-number-conversion'
  | 'no-decimal-outside-money'
  | 'no-framework-in-domain'
  | 'no-layer-violation';

export interface Violation {
  path: string;
  line: number;
  rule: Rule;
  message: string;
  source: string;
}

const MONEY_DIR = 'src/domain/money/';
const DOMAIN_DIR = 'src/domain/';

// Conversão numérica numa linha que fala de dinheiro. É uma heurística de linha: pega o
// descuido comum (parseFloat(amount)), não prova a ausência de number em todo o código.
const NUMBER_CONVERSION =
  /\b(?:parseFloat|parseInt)\s*\(|\bNumber\s*\(|\.toFixed\s*\(/;
const MONEY_WORDS = /amount|balance|money/i;

// from 'x', import 'x', require('x') e import('x').
const MODULE_REF = String.raw`(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]`;
const DECIMAL_IMPORT = new RegExp(`${MODULE_REF}decimal\\.js['"]`);
// A barra depois do escopo evita confundir "@nestjs-like" com "@nestjs/...".
const FRAMEWORK_IMPORT = new RegExp(
  `${MODULE_REF}@(?:nestjs|mikro-orm|aws-sdk)/[^'"]*['"]`,
);

// Camadas de src/ e, para cada uma, as camadas que ela NÃO pode importar.
type Layer = 'domain' | 'application' | 'infrastructure' | 'interfaces';
const FORBIDDEN_IMPORTS: Partial<Record<Layer, Layer[]>> = {
  domain: ['application', 'infrastructure', 'interfaces'],
  application: ['infrastructure', 'interfaces'],
};
const LAYER_OF_PATH =
  /^src\/(domain|application|infrastructure|interfaces)(?:\/|$)/;
const MODULE_SPECIFIER = new RegExp(`${MODULE_REF}([^'"]+)['"]`, 'g');

function layerOf(path: string): Layer | undefined {
  return LAYER_OF_PATH.exec(path)?.[1] as Layer | undefined;
}

// Resolve o import contra a pasta do arquivo e devolve a camada de destino. Pacotes
// ('decimal.js', 'node:crypto') não são camadas. O que conta é o caminho resolvido, não o
// nome: src/domain/wallet/../infrastructure/x continua sendo domain.
function importedLayers(path: string, code: string): Layer[] {
  const layers: Layer[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? '';
    let target: string | undefined;
    if (specifier.startsWith('.')) {
      target = posix.normalize(posix.join(posix.dirname(path), specifier));
    } else if (specifier.startsWith('src/')) {
      target = posix.normalize(specifier);
    }
    const layer = target === undefined ? undefined : layerOf(target);
    if (layer) {
      layers.push(layer);
    }
  }
  return layers;
}

// Tira comentários para que um texto como "nunca parseFloat(amount)" não vire falso positivo.
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  ) {
    return '';
  }
  // Exige espaço antes do "//" para não cortar URLs (https://...).
  return line.replace(/\s\/\/.*$/, '');
}

export function checkSources(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, content } of files) {
    const inMoney = path.startsWith(MONEY_DIR);
    const inDomain = path.startsWith(DOMAIN_DIR);
    const forbiddenLayers = FORBIDDEN_IMPORTS[layerOf(path) as Layer] ?? [];
    content.split(/\r?\n/).forEach((raw, index) => {
      const code = codeOf(raw);
      if (code === '') {
        return;
      }
      const report = (rule: Rule, message: string) =>
        violations.push({
          path,
          line: index + 1,
          rule,
          message,
          source: raw.trim(),
        });

      if (!inMoney && NUMBER_CONVERSION.test(code) && MONEY_WORDS.test(code)) {
        report(
          'no-number-conversion',
          'money must not go through number/float; use Money (src/domain/money)',
        );
      }
      if (!inMoney && DECIMAL_IMPORT.test(code)) {
        report(
          'no-decimal-outside-money',
          'decimal.js may only be imported inside src/domain/money/',
        );
      }
      if (inDomain && FRAMEWORK_IMPORT.test(code)) {
        report(
          'no-framework-in-domain',
          'the domain cannot import @nestjs, @mikro-orm or @aws-sdk (ADR-0001)',
        );
      }
      for (const target of importedLayers(path, code)) {
        if (forbiddenLayers.includes(target)) {
          report(
            'no-layer-violation',
            `${layerOf(path)} cannot import from ${target}: layers only point inward (ADR-0001)`,
          );
        }
      }
    });
  }
  return violations;
}

export function collectSourceFiles(root: string): SourceFile[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((relative) => relative.replaceAll('\\', '/'))
    .filter(
      (relative) => relative.endsWith('.ts') && !relative.endsWith('.d.ts'),
    )
    .sort()
    .map((relative) => ({
      path: `${root}/${relative}`,
      content: readFileSync(`${root}/${relative}`, 'utf8'),
    }));
}

if (import.meta.main) {
  const files = collectSourceFiles('src');
  const violations = checkSources(files);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.path}:${v.line}  [${v.rule}]  ${v.message}`);
      console.error(`    ${v.source}`);
    }
    console.error(`\ncheck:money FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(`check:money OK (${files.length} files checked)`);
}
