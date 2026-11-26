import { describe, expect, test } from 'bun:test';
import { METRICS } from '../../../src/application/ports/metrics.port.js';
import { PrometheusRegistry } from '../../../src/infrastructure/observability/prometheus-registry.js';

// Quebra o texto do Prometheus em linhas de amostra: { "nome{rótulos}": valor }.
function samples(text: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.lastIndexOf(' ');
    found[line.slice(0, at)] = Number(line.slice(at + 1));
  }
  return found;
}

describe('the Prometheus text format (version 0.0.4)', () => {
  test('every metric of the catalog is listed with HELP and TYPE, even before the first sample', async () => {
    const text = await new PrometheusRegistry().render();
    for (const [name, definition] of Object.entries(METRICS)) {
      expect(text).toContain(`# HELP ${name} ${definition.help}`);
      expect(text).toContain(`# TYPE ${name} ${definition.type}`);
    }
    expect(text.endsWith('\n')).toBe(true);
  });

  test('a counter adds up per label set; the text shows one line per set', async () => {
    const registry = new PrometheusRegistry();
    registry.increment('wager_transactions_total', {
      status: 'PROCESSED',
      kind: 'BET',
    });
    registry.increment('wager_transactions_total', {
      status: 'PROCESSED',
      kind: 'BET',
    });
    registry.increment(
      'wager_transactions_total',
      { status: 'REJECTED', kind: 'BET' },
      3,
    );
    const found = samples(await registry.render());
    expect(
      found['wager_transactions_total{status="PROCESSED",kind="BET"}'],
    ).toBe(2);
    expect(
      found['wager_transactions_total{status="REJECTED",kind="BET"}'],
    ).toBe(3);
  });

  test('a counter with no labels is printed without braces', async () => {
    const registry = new PrometheusRegistry();
    registry.increment('outbox_events_published_total', {}, 5);
    expect(samples(await registry.render()).outbox_events_published_total).toBe(
      5,
    );
  });

  test('a counter never goes down, and refuses a non-finite or negative step', () => {
    const registry = new PrometheusRegistry();
    expect(() =>
      registry.increment('outbox_events_published_total', {}, -1),
    ).toThrow();
    expect(() =>
      registry.increment('outbox_events_published_total', {}, Number.NaN),
    ).toThrow();
  });

  test('a gauge keeps the LAST value set', async () => {
    const registry = new PrometheusRegistry();
    registry.set('outbox_lag_seconds', {}, 12);
    registry.set('outbox_lag_seconds', {}, 3);
    expect(samples(await registry.render()).outbox_lag_seconds).toBe(3);
  });

  test('a histogram prints cumulative buckets, +Inf, _sum and _count', async () => {
    const registry = new PrometheusRegistry();
    for (const seconds of [0.004, 0.02, 0.02, 3, 99]) {
      registry.observe(
        'wager_processing_seconds',
        { channel: 'http', outcome: 'processed' },
        seconds,
      );
    }
    const found = samples(await registry.render());
    const key = (le: string) =>
      `wager_processing_seconds_bucket{channel="http",outcome="processed",le="${le}"}`;
    expect(found[key('0.005')]).toBe(1);
    expect(found[key('0.025')]).toBe(3);
    expect(found[key('5')]).toBe(4);
    expect(found[key('10')]).toBe(4);
    expect(found[key('+Inf')]).toBe(5);
    expect(
      found[
        'wager_processing_seconds_count{channel="http",outcome="processed"}'
      ],
    ).toBe(5);
    expect(
      found['wager_processing_seconds_sum{channel="http",outcome="processed"}'],
    ).toBeCloseTo(102.044, 6);
  });

  test('label values are escaped (backslash, quote and newline), so a hostile value cannot break the format', async () => {
    const registry = new PrometheusRegistry();
    registry.increment('http_requests_total', {
      method: 'GET',
      route: 'a"b\\c\nd',
      status: '200',
    });
    const text = await registry.render();
    expect(text).toContain('route="a\\"b\\\\c\\nd"');
    expect(text.split('\n').every((line) => !line.includes('\r'))).toBe(true);
  });

  test('labels outside the catalog are refused (a typo fails loudly instead of creating a new series)', () => {
    const registry = new PrometheusRegistry();
    expect(() =>
      registry.increment('wager_transactions_total', {
        status: 'PROCESSED',
      } as never),
    ).toThrow();
    expect(() =>
      registry.increment('wager_transactions_total', {
        status: 'PROCESSED',
        kind: 'BET',
        extra: 'x',
      } as never),
    ).toThrow();
    expect(() => registry.increment('nope' as never, {} as never)).toThrow();
  });

  test('collectors run before every render, so a value "as of the scrape" is fresh', async () => {
    const registry = new PrometheusRegistry();
    let lag = 7;
    registry.addCollector(() => registry.set('outbox_lag_seconds', {}, lag));
    expect(samples(await registry.render()).outbox_lag_seconds).toBe(7);
    lag = 9;
    expect(samples(await registry.render()).outbox_lag_seconds).toBe(9);
  });

  test('a failing collector does not break the scrape (the other series are still served)', async () => {
    const registry = new PrometheusRegistry();
    registry.increment('outbox_events_published_total', {}, 2);
    registry.addCollector(() => Promise.reject(new Error('database down')));
    const found = samples(await registry.render());
    expect(found.outbox_events_published_total).toBe(2);
  });
});
