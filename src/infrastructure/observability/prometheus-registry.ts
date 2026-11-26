import {
  METRICS,
  MetricsPort,
  type CounterName,
  type GaugeName,
  type HistogramName,
  type LabelsOf,
  type MetricName,
} from '../../application/ports/metrics.port.js';

interface Sample {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSample {
  labels: Record<string, string>;
  // Quantas observações cabem em cada limite (NÃO cumulativo; a soma acontece ao imprimir).
  counts: number[];
  inf: number;
  sum: number;
}

type Definition = {
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
};

// Um registro Prometheus escrito à mão (sem dependência): só contadores, gauges e histogramas, com
// rótulos validados contra o CATÁLOGO da aplicação (a mesma lista que o /metrics imprime, até sem
// amostras). Rótulo fora do catálogo, ou faltando, lança: um erro de digitação não cria uma série.
export class PrometheusRegistry extends MetricsPort {
  private readonly counters = new Map<string, Map<string, Sample>>();
  private readonly gauges = new Map<string, Map<string, Sample>>();
  private readonly histograms = new Map<string, Map<string, HistogramSample>>();
  private readonly collectors: Array<() => Promise<void> | void> = [];

  increment<N extends CounterName>(name: N, labels: LabelsOf<N>, by = 1): void {
    if (!Number.isFinite(by) || by < 0) {
      throw new Error(`a counter only goes up (${name} += ${String(by)})`);
    }
    const sample = this.sampleOf(this.counters, name, labels, 'counter');
    sample.value += by;
  }

  set<N extends GaugeName>(name: N, labels: LabelsOf<N>, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number (got ${String(value)})`);
    }
    this.sampleOf(this.gauges, name, labels, 'gauge').value = value;
  }

  observe<N extends HistogramName>(
    name: N,
    labels: LabelsOf<N>,
    seconds: number,
  ): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`${name} cannot observe ${String(seconds)}`);
    }
    const definition = this.definitionOf(name, 'histogram');
    const key = this.keyOf(name, definition, labels);
    let series = this.histograms.get(name);
    if (!series) {
      series = new Map();
      this.histograms.set(name, series);
    }
    let sample = series.get(key);
    if (!sample) {
      sample = {
        labels: { ...labels },
        counts: Array.from(
          { length: definition.buckets?.length ?? 0 },
          () => 0,
        ),
        inf: 0,
        sum: 0,
      };
      series.set(key, sample);
    }
    const buckets = definition.buckets ?? [];
    const index = buckets.findIndex((limit) => seconds <= limit);
    if (index >= 0) {
      sample.counts[index] = (sample.counts[index] ?? 0) + 1;
    }
    sample.inf += 1;
    sample.sum += seconds;
  }

  // Roda antes de cada render: quem tem um valor "no momento da leitura" (o lag da outbox) o
  // atualiza aqui.
  addCollector(collect: () => Promise<void> | void): void {
    this.collectors.push(collect);
  }

  async render(): Promise<string> {
    for (const collect of this.collectors) {
      try {
        await collect();
      } catch {
        // Um coletor que falha (o banco caiu) não derruba a leitura das outras séries.
      }
    }
    const lines: string[] = [];
    for (const [name, definition] of Object.entries(METRICS) as Array<
      [MetricName, Definition]
    >) {
      lines.push(`# HELP ${name} ${escapeHelp(definition.help)}`);
      lines.push(`# TYPE ${name} ${definition.type}`);
      if (definition.type === 'histogram') {
        this.renderHistogram(name, definition, lines);
      } else {
        const store =
          definition.type === 'counter' ? this.counters : this.gauges;
        for (const sample of store.get(name)?.values() ?? []) {
          lines.push(
            `${name}${formatLabels(definition.labels, sample.labels)} ${String(sample.value)}`,
          );
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private renderHistogram(
    name: string,
    definition: Definition,
    lines: string[],
  ): void {
    const buckets = definition.buckets ?? [];
    for (const sample of this.histograms.get(name)?.values() ?? []) {
      let cumulative = 0;
      buckets.forEach((limit, index) => {
        cumulative += sample.counts[index] ?? 0;
        lines.push(
          `${name}_bucket${formatLabels(definition.labels, sample.labels, ['le', String(limit)])} ${String(cumulative)}`,
        );
      });
      lines.push(
        `${name}_bucket${formatLabels(definition.labels, sample.labels, ['le', '+Inf'])} ${String(sample.inf)}`,
      );
      lines.push(
        `${name}_sum${formatLabels(definition.labels, sample.labels)} ${String(sample.sum)}`,
      );
      lines.push(
        `${name}_count${formatLabels(definition.labels, sample.labels)} ${String(sample.inf)}`,
      );
    }
  }

  private definitionOf(name: string, type: Definition['type']): Definition {
    const definition = (METRICS as Record<string, Definition>)[name];
    if (!definition) {
      throw new Error(`unknown metric "${name}" (it is not in the catalog)`);
    }
    if (definition.type !== type) {
      throw new Error(`${name} is a ${definition.type}, not a ${type}`);
    }
    return definition;
  }

  private keyOf(
    name: string,
    definition: Definition,
    labels: Record<string, string>,
  ): string {
    const given = Object.keys(labels);
    const unexpected = given.filter((l) => !definition.labels.includes(l));
    const missing = definition.labels.filter((l) => !given.includes(l));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        `${name} takes the labels [${definition.labels.join(', ')}] (unexpected: [${unexpected.join(', ')}], missing: [${missing.join(', ')}])`,
      );
    }
    return definition.labels.map((l) => labels[l]).join('\u0000');
  }

  private sampleOf(
    store: Map<string, Map<string, Sample>>,
    name: string,
    labels: Record<string, string>,
    type: 'counter' | 'gauge',
  ): Sample {
    const definition = this.definitionOf(name, type);
    const key = this.keyOf(name, definition, labels);
    let series = store.get(name);
    if (!series) {
      series = new Map();
      store.set(name, series);
    }
    let sample = series.get(key);
    if (!sample) {
      sample = { labels: { ...labels }, value: 0 };
      series.set(key, sample);
    }
    return sample;
  }
}

function escapeHelp(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

function formatLabels(
  names: readonly string[],
  labels: Record<string, string>,
  extra?: [string, string],
): string {
  const parts = names.map((n) => `${n}="${escapeLabel(labels[n] ?? '')}"`);
  if (extra) {
    parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}
