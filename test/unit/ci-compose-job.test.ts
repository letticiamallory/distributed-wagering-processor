import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// O primeiro `docker compose up` do README falhava com o volume vazio (o healthcheck do Postgres
// desistia antes do initdb terminar), e o CI não pegou: ele usa *service containers*, não o compose.
// Um job do CI tem que subir o compose do zero, como quem avalia, e rodar os exemplos do README
// contra ESSA stack.
type Step = {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
const workflow = Bun.YAML.parse(
  readFileSync('.github/workflows/ci.yml', 'utf8'),
) as {
  jobs: Record<string, { steps?: Step[]; services?: unknown }>;
};

const composeJob = Object.values(workflow.jobs).find((job) =>
  (job.steps ?? []).some((step) =>
    /docker compose up -d --wait/.test(step.run ?? ''),
  ),
);
const steps = composeJob?.steps ?? [];
const runOf = (pattern: RegExp) =>
  steps.findIndex((step) => pattern.test(step.run ?? ''));

describe('CI has a job that boots docker compose from scratch', () => {
  test('there is such a job, and it does not use service containers', () => {
    expect(composeJob).toBeDefined();
    expect(composeJob?.services).toBeUndefined();
  });

  test('it removes the volumes first, so the Postgres boots on an empty volume', () => {
    const down = runOf(/docker compose down -v/);
    const up = runOf(/docker compose up -d --wait/);
    expect(down).toBeGreaterThanOrEqual(0);
    expect(down).toBeLessThan(up);
  });

  test('it builds the image from the checkout (not a cached one)', () => {
    expect(steps[runOf(/docker compose up -d --wait/)]?.run).toContain(
      '--build',
    );
  });

  test('after the boot it runs the README examples test against that stack', () => {
    const up = runOf(/docker compose up -d --wait/);
    const readme = runOf(/test\/e2e\/readme-examples\.test\.ts/);
    expect(readme).toBeGreaterThan(up);
    expect(steps[readme]?.env?.README_EXAMPLE_BASE).toBe(
      'http://localhost:3000',
    );
  });

  test('it shows the compose logs when something fails, and always tears the stack down', () => {
    expect(
      steps.some(
        (s) => s.if === 'failure()' && /docker compose logs/.test(s.run ?? ''),
      ),
    ).toBe(true);
    expect(
      steps.some(
        (s) =>
          s.if === 'always()' && /docker compose down -v/.test(s.run ?? ''),
      ),
    ).toBe(true);
  });
});

describe('the README examples test can target an external stack', () => {
  const source = readFileSync('test/e2e/readme-examples.test.ts', 'utf8');

  test('README_EXAMPLE_BASE switches off the app and the queues it would start itself', () => {
    expect(source).toContain('README_EXAMPLE_BASE');
    expect(source).toContain('README_EXAMPLE_SQS_QUEUE_URL');
  });
});
