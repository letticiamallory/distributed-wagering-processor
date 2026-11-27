import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// O primeiro `docker compose up -d --wait` com o volume vazio: o initdb do Postgres (com o
// checkpoint de shutdown do servidor temporário) levou 59 s no Docker Desktop do Windows, e o
// healthcheck antigo (5 s x 10 tentativas, sem start_period) desistia aos 50 s. O compose então
// derrubava a subida inteira com "container ... is unhealthy".
const compose = Bun.YAML.parse(readFileSync('docker-compose.yml', 'utf8')) as {
  services: Record<string, { healthcheck?: Record<string, unknown> }>;
};

// "5s" -> 5, "2m" -> 120, "1m30s" -> 90
function seconds(value: unknown): number {
  if (typeof value !== 'string') return 0;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)(ms|s|m|h)/g)) {
    const n = Number(amount);
    total +=
      unit === 'ms'
        ? n / 1000
        : unit === 's'
          ? n
          : unit === 'm'
            ? n * 60
            : n * 3600;
  }
  return total;
}

// Quanto tempo o compose espera um serviço antes de chamá-lo de unhealthy: as falhas dentro do
// start_period não contam, e depois dele são `retries` falhas seguidas, uma a cada `interval`.
function patience(service: string): number {
  const check = compose.services[service]?.healthcheck ?? {};
  return (
    seconds(check.start_period) +
    seconds(check.interval) * Number(check.retries ?? 3)
  );
}

describe('docker-compose healthchecks survive a first boot on an empty volume', () => {
  test('postgres waits at least 2 minutes (the measured first boot was 59 s)', () => {
    expect(
      seconds(compose.services.postgres?.healthcheck?.start_period),
    ).toBeGreaterThanOrEqual(60);
    expect(patience('postgres')).toBeGreaterThanOrEqual(120);
  });

  test('sqs (MiniStack) also has a start period', () => {
    expect(
      seconds(compose.services.sqs?.healthcheck?.start_period),
    ).toBeGreaterThan(0);
  });
});

describe('README documents that MiniStack keeps the queues only in memory', () => {
  const README = readFileSync('README.md', 'utf8');

  // `.test()` e não `toMatch`: numa falha, o toMatch imprimiria o README inteiro.
  test('says the queues are lost when the sqs container restarts', () => {
    expect(/MiniStack[^\n]*(mem[oó]ria|não persiste)/i.test(README)).toBe(true);
  });

  test('says how to recreate them (queues-init)', () => {
    expect(
      /docker compose up -d --wait[\s\S]{0,120}queues-init/.test(README),
    ).toBe(true);
  });
});
