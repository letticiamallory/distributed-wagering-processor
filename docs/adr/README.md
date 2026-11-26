# Registro de decisões de arquitetura (ADRs)
Uma decisão por arquivo, numeração sequencial e nunca reaproveitada. Para mudar uma decisão, crie um ADR novo e marque o antigo como `Substituído por ADR-00XX`; não se apaga histórico.
| ADR | Decisão | Status |
| --- | --- | --- |
| [0001](0001-hexagonal-architecture.md) | Arquitetura hexagonal em 4 camadas | Aceito |
| [0002](0002-ministack-instead-of-localstack.md) | MiniStack em vez de LocalStack | Aceito |
| [0003](0003-mikroorm-v7-define-entity.md) | MikroORM v7 com `defineEntity` fora do domínio | Aceito |
| [0004](0004-schema-level-guarantees.md) | Garantias no schema (constraints e triggers) | Aceito |
| [0005](0005-single-reversal-per-transaction.md) | Reversão única por transação, de qualquer tipo | Aceito |
| [0006](0006-money-with-decimal-without-rounding.md) | Money com Decimal, sem arredondamento | Aceito |
| [0007](0007-pessimistic-lock-per-wallet.md) | Lock pessimista por wallet | Aceito |
| [0008](0008-two-layer-idempotency-and-payload-hash.md) | Idempotência em duas camadas e algoritmo do `payloadHash` | Aceito |
| [0009](0009-http-status-map-and-error-format.md) | Mapa de status HTTP, formato único de erro e taxonomia de `failureCode` | Aceito |
| [0010](0010-authentication-deferred-with-extension-point.md) | Autenticação adiada, com ponto de extensão | Aceito |
| [0011](0011-sqs-consumer-error-classification-retry-and-dlq.md) | Consumidor SQS: classificação de erros, retry com backoff e DLQ | Aceito |
| [0012](0012-outbox-publisher-skip-locked-at-least-once.md) | Publisher da outbox: `SKIP LOCKED`, entrega at-least-once | Aceito |
| [0013](0013-pending-reference-worker-and-retry-policy.md) | Worker de `PENDING_REFERENCE` e a política de retentativa | Aceito |
| [0014](0014-observability-json-logs-prometheus-metrics-and-health.md) | Observabilidade: logs JSON, métricas Prometheus e health checks | Aceito |
