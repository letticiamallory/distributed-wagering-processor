// Roda no começo de `bun run test:concurrency`: grava o marco de tempo que o check global usa para
// saber quais wallets são da suíte, e zera o arquivo de métricas das cargas.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('.context', { recursive: true });
writeFileSync(
  '.context/concurrency-suite-start.txt',
  `${new Date().toISOString()}\n`,
);
writeFileSync('.context/concurrency-metrics.jsonl', '');
console.log('concurrency suite started at', new Date().toISOString());
