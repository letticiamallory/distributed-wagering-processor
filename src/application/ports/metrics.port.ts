// A porta de métricas (ADR-0014). A aplicação só conhece esta porta e o CATÁLOGO abaixo: quem
// transforma isto em Prometheus (ou em qualquer outro formato) é a infraestrutura. O catálogo é a
// fonte única dos nomes, dos tipos e dos rótulos: um nome ou um rótulo errado não compila, e o
// /metrics lista todas as séries mesmo antes da primeira amostra.

type Kind = 'counter' | 'gauge' | 'histogram';

interface Definition {
  type: Kind;
  help: string;
  labels: readonly string[];
  // Só para histogramas: os limites superiores, em segundos, em ordem crescente.
  buckets?: readonly number[];
}

// Latências de uma operação financeira (5 ms a 10 s).
const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export const METRICS = {
  // ---- transações
  wager_transactions_total: {
    type: 'counter',
    help: 'Transactions decided, by final status and kind (PENDING_REFERENCE counts when first recorded)',
    labels: ['status', 'kind'],
  },
  wager_duplicates_total: {
    type: 'counter',
    help: 'Duplicates detected: an idempotency-key replay, or a redelivery already in the inbox',
    labels: ['channel', 'kind'],
  },
  wager_conflicts_total: {
    type: 'counter',
    help: 'Requests refused as a conflict: key reused with another payload, external id under another key, inbox id reused',
    labels: ['kind'],
  },
  wager_processing_seconds: {
    type: 'histogram',
    help: 'Time to process one transaction request, from the use case entry to its result',
    labels: ['channel', 'outcome'],
    buckets: LATENCY_BUCKETS,
  },
  pending_reference_resolutions_total: {
    type: 'counter',
    help: 'Attempts of the pending-reference worker, by outcome',
    labels: ['outcome'],
  },
  // ---- retries, filas e DLQ
  wager_retries_total: {
    type: 'counter',
    help: 'Retries scheduled, by component (the SQS consumer handing a message back, the outbox publisher rescheduling an event)',
    labels: ['component'],
  },
  wager_dlq_messages_total: {
    type: 'counter',
    help: 'Messages sent to the dead-letter queue, by reason',
    labels: ['reason'],
  },
  consumer_messages_total: {
    type: 'counter',
    help: 'SQS messages handled by the consumer, by outcome (acked, retried, dead_lettered)',
    labels: ['outcome'],
  },
  // ---- banco
  wager_db_unavailable_total: {
    type: 'counter',
    help: 'Transient database failures (what becomes a 503), by cause: pool_timeout, lock_timeout, deadlock, serialization, connection, other',
    labels: ['reason'],
  },
  // ---- outbox
  outbox_events_published_total: {
    type: 'counter',
    help: 'Outbox events accepted by the broker',
    labels: [],
  },
  outbox_pending_messages: {
    type: 'gauge',
    help: 'Outbox events not yet published',
    labels: [],
  },
  outbox_lag_seconds: {
    type: 'gauge',
    help: 'Age of the oldest outbox event not yet published (0 when the outbox is empty)',
    labels: [],
  },
  pending_reference_transactions: {
    type: 'gauge',
    help: 'Transactions waiting in PENDING_REFERENCE for the transaction they reference, read at the scrape',
    labels: [],
  },
  // ---- HTTP
  http_requests_total: {
    type: 'counter',
    help: 'HTTP requests, by method, route pattern and status',
    labels: ['method', 'route', 'status'],
  },
  http_request_duration_seconds: {
    type: 'histogram',
    help: 'HTTP request duration, by method and route pattern',
    labels: ['method', 'route'],
    buckets: LATENCY_BUCKETS,
  },
  // ---- reconciliação (a Fase 8 vai usar; nada a chama ainda)
  wallet_reconciliation_divergences: {
    type: 'gauge',
    help: 'Wallets found divergent by the last reconciliation, by kind (balance_mismatch, ledger_gap, negative_balance)',
    labels: ['kind'],
  },
  wallet_reconciliation_divergences_total: {
    type: 'counter',
    help: 'Divergences found by reconciliations, by kind. Alert on its increase: unlike the gauge, a later clean check of ANOTHER wallet never hides it',
    labels: ['kind'],
  },
  wallet_reconciliation_last_run_timestamp_seconds: {
    type: 'gauge',
    help: 'Unix time of the last completed reconciliation run',
    labels: [],
  },
  wallet_reconciliation_runs_total: {
    type: 'counter',
    help: 'Reconciliation runs, by result (clean, divergent, failed)',
    labels: ['result'],
  },
} as const satisfies Record<string, Definition>;

export type MetricName = keyof typeof METRICS;

type NamesOf<T extends Kind> = {
  [N in MetricName]: (typeof METRICS)[N]['type'] extends T ? N : never;
}[MetricName];

export type CounterName = NamesOf<'counter'>;
export type GaugeName = NamesOf<'gauge'>;
export type HistogramName = NamesOf<'histogram'>;

export type LabelsOf<N extends MetricName> = Record<
  (typeof METRICS)[N]['labels'][number],
  string
>;

export abstract class MetricsPort {
  // Só soma (por padrão 1): um contador nunca diminui.
  abstract increment<N extends CounterName>(
    name: N,
    labels: LabelsOf<N>,
    by?: number,
  ): void;
  abstract set<N extends GaugeName>(
    name: N,
    labels: LabelsOf<N>,
    value: number,
  ): void;
  // `seconds` em segundos (a unidade do Prometheus).
  abstract observe<N extends HistogramName>(
    name: N,
    labels: LabelsOf<N>,
    seconds: number,
  ): void;
}

// A métrica "desligada": o que um caso de uso usa quando ninguém liga uma de verdade (os testes de
// unidade, por exemplo). Nunca falha e nunca guarda nada.
export class NoopMetrics extends MetricsPort {
  increment(): void {}
  set(): void {}
  observe(): void {}
}

export const NOOP_METRICS: MetricsPort = new NoopMetrics();
