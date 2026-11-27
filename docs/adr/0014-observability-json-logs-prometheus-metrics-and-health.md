# ADR-0014: Observabilidade: logs JSON, métricas Prometheus e health checks

Status: Aceito · Data: 2026-11-26

## Contexto
O enunciado (seção 12) exige: logs estruturados em JSON com `correlationId`, `messageId`,
`transactionId`, `walletId` e `providerId`, **sem dados sensíveis nem payload financeiro
completo**; métricas cobrindo transações por status, duplicatas, retries, mensagens em DLQ,
conflitos de lock, outbox lag e latência de processamento; e health checks separados para
liveness e readiness. OpenTelemetry e dashboard são opcionais.

Restrições do projeto: a aplicação (`src/application`) não conhece framework nem biblioteca de
métricas (ADR-0001); o Bun e o Nest já estão fixados; e o número de dependências deve ficar
pequeno.

## Decisão

### 1. Logs: um objeto JSON por linha, em stdout, sem dependência nova
- `JsonLogger` é um `LoggerService` do Nest (≈150 linhas), instalado em `createApp()` desde a
  primeira linha de partida. O que a aplicação já logava como objeto (`{ event: '...', ... }`)
  vira os **campos** da linha; o que o framework loga como texto vira `message`. Todo log tem
  `time` (ISO), `level` (`debug`, `info`, `warn`, `error`, `fatal`) e `context`. `LOG_LEVEL`
  (padrão `info`) é validado na subida.
- **Contexto por requisição/mensagem/item** (`AsyncLocalStorage`): o `correlationId` e os
  identificadores que já se conhecem acompanham todo log feito dentro dele, sem passar por
  parâmetro. Campo explícito da própria linha vale mais que o do contexto.
- Os três caminhos:
  - **HTTP:** uma linha `request_completed` por requisição (inclusive erro e rota inexistente), com
    método, **padrão** da rota, status, duração, `correlationId` (o do cliente, se válido) e
    `walletId`/`providerId`/`transactionId` quando existem. `/metrics` e `/health/*` vão para
    `debug`.
  - **Consumidor SQS:** `message_acked`, `message_retry`, `message_dead_lettered`, com `messageId`,
    `correlationId` (= `messageId`; sem envelope válido, o id do SQS), `walletId`, `providerId`,
    `idempotencyKey` e `transactionId`. O `message_acked` de sucesso (PROCESSED, REJECTED,
    PENDING_REFERENCE, replay) sai em `info`, para o `LOG_LEVEL` padrão ligar o `messageId` ao
    `transactionId`; o conflito de idempotência sai em `warn`.
  - **Workers:** `pending_reference_resolved` (`transactionId`, `walletId`), `outbox_batch_published`
    (quantos), `outbox_event_retry` e `outbox_event_stuck` (`eventId`, `walletId`, tentativas).
- **O que nunca entra numa linha** (cinco camadas, porque uma só falha em silêncio):
  1. **o código só loga identificadores**: nenhum log recebe o corpo, o valor ou o jogador;
  2. campos pelo **nome**, em qualquer profundidade, viram `[redacted]`: `money`, `amount`, `payload`,
     `body`, `data`, `balance*`/`*balance`, e o que cheira a segredo (`authorization`, `token`,
     `password`, `secret`, `cookie`, `apiKey`);
  3. strings acima de 500 caracteres são cortadas;
  4. **o texto de erro de quem lê o corpo não é repassado**: o erro do `JSON.parse` e o do zod
     **citam pedaços do corpo**, então o log traz uma descrição fixa (`the message body is not valid
     JSON`) ou só os **caminhos** dos campos inválidos;
  5. um teste captura os **logs reais de um processo** (HTTP, SQS e workers) e prova que nenhum
     valor do corpo (valores monetários, saldo inicial, texto da mensagem, id do jogador) aparece em
     linha nenhuma.
  O `playerId` não é logado: o enunciado pede `walletId`, e o jogador é dado pessoal.

### 2. Métricas: `MetricsPort` na aplicação, registro Prometheus escrito à mão
- **`MetricsPort`** (aplicação) tem três operações (`increment`, `set`, `observe`) e um **catálogo**
  (`METRICS`) com nome, tipo, ajuda e rótulos de cada série. O catálogo é tipado: um nome ou um
  rótulo errado **não compila**, e o registro **lança** em tempo de execução se receber um rótulo
  fora do catálogo. Sem porta de verdade, os casos de uso usam `NoopMetrics`.
- **`PrometheusRegistry`** (infraestrutura, ≈200 linhas, **sem `prom-client`**) imprime o formato
  de texto 0.0.4 (HELP/TYPE de **todas** as séries, mesmo antes da primeira amostra; histograma
  com buckets cumulativos, `+Inf`, `_sum`, `_count`; rótulos escapados).
- **`GET /metrics`**, aberto como o `/health` (ver o ADR-0010): só contagens e latências, nunca um
  valor, uma wallet ou um jogador (há um teste).

| Série | O que conta | Onde |
| --- | --- | --- |
| `wager_transactions_total{status,kind}` | transações decididas, depois do commit | caso de uso |
| `wager_duplicates_total{channel,kind}` | replay de chave (`idempotency_key_replay`) e reentrega já na inbox (`inbox_redelivery`) | caso de uso |
| `wager_conflicts_total{kind}` | chave reusada, id externo sob outra chave, `messageId` reusado | caso de uso |
| `wager_processing_seconds{channel,outcome}` | **latência** (histograma): processed, rejected, pending_reference, replay, error | caso de uso |
| `wager_retries_total{component}` | `consumer` (devolveu a mensagem) e `outbox` (reagendou o evento) | consumidor, publisher |
| `wager_dlq_messages_total{reason}` | mensagens enviadas à DLQ, por motivo | consumidor |
| `consumer_messages_total{outcome}` | acked, retried, dead_lettered | consumidor |
| `wager_db_unavailable_total{reason}` | o que vira 503: `pool_timeout`, `lock_timeout`, `deadlock`, `serialization`, `connection`, `other` | UnitOfWork e leitores |
| `wallet_lock_wait_seconds{outcome}` | espera pelo `SELECT ... FOR UPDATE` da wallet (histograma, `acquired` ou `timeout`): os conflitos de lock, não só os que estouram | repositório da wallet, pelo `UnitOfWork` |
| `outbox_events_published_total` | eventos aceitos pelo broker | publisher |
| `outbox_pending_messages`, `outbox_lag_seconds` | fila e idade do evento mais antigo | coletor, **na raspagem** |
| `pending_reference_resolutions_total{outcome}` | resolved, still_pending, not_pending, failed | worker |
| `http_requests_total{method,route,status}`, `http_request_duration_seconds{method,route}` | tráfego HTTP | middleware |
| `wallet_reconciliation_*` | divergências por tipo, última execução, execuções (ver o item 4) | caso de uso de reconciliação (ADR-0015) |

Regras que mantêm as séries honestas:
- **Conta-se depois do commit**: um `ROLLBACK` não aconteceu. O publisher e o caso de uso contam
  fora da transação.
- **Rótulos de baixa cardinalidade**: a rota é o **padrão** (`/wagering/transactions`), e o que não
  casa vira `unmatched` (um scanner em mil URLs cria uma série). Nenhum id (wallet, jogador,
  transação, provedor) é rótulo.
- **O lag da outbox é lido no momento da raspagem**: um coletor consulta `OutboxReader.stats()`
  antes de cada `/metrics`. Funciona em qualquer instância, mesmo com o publisher desligado, e
  nunca fica velho. Se o coletor falha (o banco caiu), as outras séries continuam saindo.
- **A causa do 503 é contada onde o erro nasce** (UnitOfWork e leitores), então vale para HTTP, SQS e
  workers; a causa vem do código do driver ou da mensagem do pool (`unavailableReason`).
- `wager_transactions_total` conta `PENDING_REFERENCE` **quando é gravada** e o status final **de
  novo quando o worker a resolve**: a soma por status é "decisões", não "transações distintas".

### 3. Health: liveness não olha dependência; readiness olha de verdade
- **`GET /health/live`**: só diz que o processo está de pé (`{"status":"ok"}`). **Não** consulta
  banco nem fila: um orquestrador que reiniciasse o processo porque o banco caiu pioraria a queda.
- **`GET /health/ready`**: roda, em paralelo, **uma operação real** em cada dependência, cada uma com
  prazo de 2 s: um `SELECT 1` numa conexão do pool (PostgreSQL) e um `ListQueues` (SQS).
  `200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}`; se qualquer uma falhar,
  `503 {"status":"unavailable","checks":{...}}` com `Retry-After`, **dizendo qual caiu e nada além**
  (sem string de conexão nem texto de erro; o motivo vai para o log `readiness_check_failed`).
  O teste derruba um PostgreSQL e um MiniStack **de verdade** (containers descartáveis), vê o 503 e
  vê o 200 quando voltam.
- Ambos abertos, sem autenticação (enunciado, seção 9).

### 4. A métrica de divergência da reconciliação
`wallet_reconciliation_divergences{kind}` (gauge: `balance_mismatch`, `ledger_gap`,
`negative_balance`), `wallet_reconciliation_last_run_timestamp_seconds` e
`wallet_reconciliation_runs_total{result}` estão no catálogo, e `reportReconciliation()` (aplicação)
é a função que a reconciliação chama ao fim de cada execução. **Atualização (ADR-0015):** a
reconciliação por wallet a usa desde então, e ganhou o contador `wallet_reconciliation_divergences_total`
(o que alerta, porque o gauge é o da última execução); o gauge `pending_reference_transactions` e o
503 do `/health/ready` no encerramento também entraram com o ADR-0015. Uma execução que **terminou**
substitui os valores (o tipo que não aparece volta a 0, para a divergência corrigida sair do alerta);
uma que **falhou** só conta a falha e deixa os valores e o "último sucesso" como estavam. (O teste que garantia "ninguém a chama" virou "só o `ReconcileWalletUseCase` a chama".)

## Alternativas consideradas
- **pino** para os logs: mais rápido e maduro, mas é uma dependência a mais para uma aplicação que já
  loga objetos pelo `LoggerService` do Nest; o `JsonLogger` cobre o necessário (nível, contexto,
  redação) e o contrato é o do próprio Nest. Se o volume de log virar gargalo, trocar é mudar o
  `useLogger`.
- **`prom-client`**: completo (métricas de processo, GC...), mas arrasta dependências para um
  conjunto pequeno de séries que o registro próprio imprime. As métricas de processo ficam fora.
- **Métricas só por log**: não agregam nem alertam.
- **Atualizar o lag da outbox num laço**: velho entre uma execução e outra, e dependia do publisher
  estar ligado.
- **Readiness só "a configuração existe"**: diria "pronto" com o banco caído.

## Consequências
+ Os três caminhos (HTTP, SQS, workers) produzem logs com os mesmos campos e o mesmo contexto;
  nenhum teste de formato depende de mock (captura de um processo real); todas as métricas do
  enunciado existem e são testadas contra Postgres e MiniStack reais; o ready enxerga uma
  dependência caída de verdade; zero dependências novas; as fronteiras (`check:money`) continuam
  passando.
− As métricas são **por processo**: com 3 instâncias, o Prometheus raspa as 3 e soma; os contadores
  zeram quando o processo reinicia (o `rate()` do Prometheus lida com isso). Não há métricas de
  runtime (memória, GC, event loop). Os buckets de latência são fixos (5 ms a 10 s). O log em stdout
  é síncrono por linha. Não há tracing distribuído (OpenTelemetry é opcional no enunciado). Um campo
  novo com nome inofensivo que carregue um valor financeiro **passa** pela redação por nome: é o
  teste do processo real que protege isso, não a lista de nomes.
