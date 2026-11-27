# ADR-0012: Publisher da outbox: `SKIP LOCKED`, entrega at-least-once

Status: Aceito · Data: 2026-11-26

## Contexto
O enunciado (seção 11) exige que a transação, o saldo, o ledger, a inbox e o **evento de
integração** sejam atômicos, e que um worker publique os eventos pendentes **com vários
publishers concorrentes, sem perder nem duplicar indefinidamente**. O cenário obrigatório: o
PostgreSQL confirma o commit; o processo morre antes de publicar; outra instância assume; o evento
é publicado; uma publicação duplicada continua segura para o consumidor.

O fluxo de negócio já grava o evento na tabela `outbox_messages` na mesma transação (o caso de uso de processamento, ADR-0007) e
nunca fala com o SQS. Falta quem publique.

## Decisão

### 1. O ciclo: uma transação, `SELECT ... FOR UPDATE SKIP LOCKED`, publica, marca
1. abre uma transação e reivindica até 10 eventos devidos
   (`published_at IS NULL AND next_attempt_at <= agora`, do mais antigo ao mais novo)
   com `FOR UPDATE SKIP LOCKED`;
2. publica o lote na `wallet-events.fifo` com `SendMessageBatch`, com a transação **aberta**;
3. cada evento aceito: `published_at = agora`; cada recusado: `attempts + 1`, `last_error` e o
   próximo horário com backoff `min(2^attempts × 1 s, 5 min)` (com jitter que só encurta);
4. `COMMIT`.

`MessageGroupId = walletId` (o `aggregateId` dos quatro eventos) e `MessageDeduplicationId =
eventId`. O corpo é o payload da outbox, intacto. O "agora" vem do `Clock` injetado, não do
`now()` do SQL: os testes controlam o tempo.

Os quatro eventos mínimos já existem como subclasses de `IntegrationEvent` (`WagerTransaction
Processed`, `Rejected`, `PendingReference` e `WalletBalanceChanged`, este só quando o saldo muda),
com o envelope do enunciado (`eventId`, `eventType`, `aggregateId`, `correlationId`,
`causationId?`, `occurredAt` ISO, `version`, `data`) e `MoneyProps` em string no `data`.

### 2. Vários publishers: `SKIP LOCKED` segurando a transação (escolhido) ou lease
| | `SKIP LOCKED` na transação (escolhido) | lease (`locked_until`) |
| --- | --- | --- |
| Migration | nenhuma | coluna nova |
| Processo morre no meio | a transação desfaz, as linhas voltam a ser devidas **na hora** | a linha fica presa até o lease vencer |
| Conexão do pool | **1 por publisher durante o envio** (milissegundos; no máximo o prazo do cliente, 5 s) | solta durante o envio |
| Estados/casos de borda | nenhum | lease vencido com publisher lento (dois publicam), cerca para marcar publicado, duas transações por ciclo |

Dois publishers nunca recebem a mesma linha: o segundo **pula** as travadas e pega as seguintes,
sem esperar (há um teste com um publisher parado segurando 3 linhas). O custo aceito é a conexão
presa durante o envio; por isso o cliente SQS tem prazo de 5 s (`OUTBOX_SEND_TIMEOUT_MS`) e poucas
tentativas internas. **O lease fica como evolução** se a latência do SQS crescer a ponto de a
conexão presa pesar (conexões presas esgotam o pool, como mostra `bun test test/concurrency/hot-wallet.test.ts`, ADR-0007).

### 3. At-least-once e quem deduplica
- O processo morre **antes do `COMMIT`** (inclusive depois do SQS aceitar o lote): a transação
  desfaz, as linhas voltam a ser devidas, e outra instância **publica de novo**. Isso é a entrega
  at-least-once: o mesmo evento pode chegar mais de uma vez.
- **Quem consome eventos deduplica pelo `eventId`** (contrato). A deduplicação do FIFO
  (`MessageDeduplicationId`, janela de 5 min) é só otimização: fora da janela, ou em outra fila,
  a duplicata chega. Não existe consumidor real dos eventos neste sistema; nos testes, um coletor
  que deduplica por `eventId` faz o papel dele.
- O broker fora do ar **não perde nada**: as linhas continuam na tabela com a próxima tentativa
  agendada. Eventos confirmados **nunca vão para DLQ**: o retry é infinito (teto de 5 min entre
  tentativas) e, a partir de 10 tentativas (`OUTBOX_STUCK_ATTEMPTS`), o log sobe de `warn` para
  `error` (`outbox_event_stuck`). Um evento "veneno" fica **visível**, não descartado.

### 4. Ordem por wallet: garantida só em condições normais
Os eventos de uma wallet saem em ordem dentro de um lote e quando há um publisher só. Com vários
publishers, ou numa falha por entrada (rara) do `SendMessageBatch`, dois eventos da mesma wallet
podem sair fora de ordem. **Quem consome ordena por `walletVersion`**, que o
`WalletBalanceChanged` leva por isso, e o teste de concorrência confere que cada wallet recebe a
sequência completa de versões, sem buracos.

### 5. Observabilidade (a parte desta fase)
`OutboxReader.stats(agora)` devolve `pending`, `due` e `lagSeconds` (idade do evento mais antigo
não publicado), e o publisher os loga (`outbox_stats`) a cada 10 s quando há pendentes. O gauge
`outbox_lag_seconds` e o registro de métricas vieram na fase seguinte (ADR-0014).

### 6. Ligar e desligar
`OUTBOX_PUBLISHER_ENABLED` (padrão `true`), junto de `OUTBOX_QUEUE_NAME`, `OUTBOX_BATCH_SIZE` (1 a
10), `OUTBOX_POLL_INTERVAL_MS` (500), `OUTBOX_SEND_TIMEOUT_MS` (5000), `OUTBOX_STATS_INTERVAL_MS`,
`OUTBOX_STUCK_ATTEMPTS` e `OUTBOX_SHUTDOWN_TIMEOUT_MS`; todos validados na subida. Roda no mesmo
processo da API. Nos testes nasce **desligado** e aponta para uma fila de eventos só de teste
(`test/support/setup.ts`), como o consumidor (ADR-0011). No SIGTERM o ciclo em andamento termina
(marca o que publicou) e nenhum outro começa; só depois o banco fecha.

## Alternativas consideradas
- **Lease com `locked_until`**: não segura conexão, mas tem mais casos de borda e uma migration
  (ver a tabela). Evolução futura.
- **Publicar dentro da transação de negócio**: proibido (CLAUDE.md): o evento só pode sair
  depois do commit, e o SQS fora do ar derrubaria o dinheiro.
- **DLQ para eventos que falham**: descartaria um evento de uma operação já confirmada.
- **Garantir a ordem global por wallet entre publishers** (trancar a wallet inteira, ou só uma
  linha por wallet por ciclo): derruba a vazão de uma hot wallet (2 eventos por operação) e é
  desnecessário com `walletVersion`.

## Consequências
+ Nenhum evento confirmado se perde (nem com o processo ou o SQS caindo); vários publishers
  dividem a tabela sem se pisar; zero migration; testado com processos reais mortos (`SIGKILL`) e
  com 3 publishers sob carga.
− Uma conexão do pool presa durante o envio; duplicatas são possíveis e o consumidor precisa
  deduplicar; a ordem entre publishers não é garantida (ordenar por `walletVersion`); o publisher
  varre a tabela inteira (um índice `(occurred_at) WHERE published_at IS NULL` entra se o
  backlog crescer).
