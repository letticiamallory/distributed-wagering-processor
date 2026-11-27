# Distributed Wagering Processor

[![CI](https://github.com/letticiamallory/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/letticiamallory/distributed-wagering-processor/actions/workflows/ci.yml)

Serviço de carteira (wallet) para apostas, feito para o desafio técnico da Jungle Gaming. Processa
transações de provedores de jogos que chegam por **HTTP** e por **SQS**, sem deixar o saldo
negativo, sem duplicar débito nem crédito quando a mensagem chega de novo, e sem perder um evento
confirmado. NestJS 12 e MikroORM 7 sobre PostgreSQL 16, no Bun 1.4.5; o SQS é emulado pelo MiniStack.

| Para | Leia |
| --- | --- |
| subir, testar e conferir cada requisito | este README |
| entender **como** e **por quê** (decisões, trade-offs, limitações, números medidos) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| uma decisão a fundo, com as alternativas recusadas | [docs/adr](docs/adr/README.md) (16 ADRs) |

## Avaliar em 5 minutos

**Pré-requisitos:** Docker com Compose v2; para os testes, o [Bun](https://bun.sh) **1.4.5**; para
os exemplos, `bash` e `curl`. O compose não precisa de arquivo `.env`.

**1. Subir.**

```bash
git clone https://github.com/letticiamallory/distributed-wagering-processor.git
cd distributed-wagering-processor
docker compose up -d --wait        # postgres, sqs (MiniStack), filas, migrations e a app
curl -s localhost:3000/health/ready
```

O compose sobe, nesta ordem: o PostgreSQL (que também cria o banco de testes `wallet_test`), o
MiniStack, o `queues-init` (cria `wager-transactions.fifo`, a DLQ `wager-transactions-dlq.fifo` e
`wallet-events.fifo`), o `migrate` (aplica o schema e termina) e a aplicação em
`http://localhost:3000`, que já roda o consumidor SQS, o publisher da outbox e o worker de
referências pendentes. Na primeira subida (volume vazio) o PostgreSQL leva perto de 1 minuto para
inicializar; o healthcheck espera até 170 s, então o `--wait` pode demorar sem que nada esteja
errado.

> **O MiniStack guarda as filas só em memória (não persiste nada).** Se o container `sqs` reiniciar,
> as filas e as mensagens que estavam nelas somem, e o consumidor passa a logar
> `queue_receive_failed` (e o `/health/ready` responde 503). Para recriá-las, rode de novo
> `docker compose up -d --wait`: ele executa outra vez o `queues-init` (que é idempotente). Os
> eventos da outbox não se perdem: ficam no banco e são publicados quando a fila volta.

**2. Ver funcionando.** Cole no `bash` o script de [Exemplos de ponta a ponta](#exemplos-de-ponta-a-ponta):
ele percorre a API inteira e manda uma aposta pela fila.

**3. Rodar os testes** (usam um banco e filas **próprios**, `wallet_test` e `test-*`: podem rodar
com a stack do compose no ar).

```bash
bun install --frozen-lockfile
bun run test                # unidade, integração e e2e
bun run test:concurrency    # concorrência com paralelismo real
bun run test:all            # as duas
```

| Comando | O que prova |
| --- | --- |
| `bun run test` | Unidade, integração e e2e contra **PostgreSQL e MiniStack de verdade** (sem mock de banco nem de fila): o `Money`, as regras e a máquina de estados, as constraints e os triggers do schema, a idempotência, o consumidor SQS (retry, DLQ, ack só depois do commit), a outbox e o worker de pendentes, processos mortos com `SIGKILL`, o encerramento no `SIGTERM`, os logs, as métricas, o `/health/ready` com dependências derrubadas de verdade, e **os exemplos deste README**. |
| `bun run test:concurrency` | O saldo nunca fica negativo e **saldo = o que o ledger reconstrói** sob paralelismo real: a mesma aposta 50 vezes ao mesmo tempo, o cenário da seção 8, uma wallet quente, **3 processos** da aplicação sobre o mesmo banco e 3 publishers sobre a mesma outbox. Termina com uma checagem global de todas as wallets que a suíte criou. |

## Onde está cada requisito

Cada linha é um requisito do enunciado, o código que o cumpre e o teste que o prova. Os caminhos
desta tabela são conferidos por um teste (`test/unit/readme-requirements-table.test.ts`): se um
arquivo mudar de lugar, o CI quebra. O porquê de cada decisão está no
[ARCHITECTURE.md](ARCHITECTURE.md).

| Requisito (seção do enunciado) | Onde está | Que teste prova |
| --- | --- | --- |
| Dinheiro sem `number`: string de 2 casas, entradas inválidas recusadas (5, 6.1) | `src/domain/money/money.ts`, `scripts/check-money.ts` | `test/unit/domain/money.test.ts`, `test/unit/scripts/check-money.test.ts` |
| Multi-moeda (ISO-4217) e conflito de moeda (6.1, 7) | `src/domain/money/iso-4217.ts`, `src/domain/wager/wager-policy.ts` | `test/unit/domain/iso-4217.test.ts`, `test/unit/domain/wager-policy.test.ts` |
| `Wallet`: construtor privado, `open`/`rehydrate`, `version` (6.0, 6.2) | `src/domain/wallet/wallet.ts` | `test/unit/domain/wallet.test.ts` |
| `WagerTransaction` e as transições de estado (6.3) | `src/domain/wager/wager-transaction.ts` | `test/unit/domain/wager-transaction.test.ts`, `test/integration/schema-wager-transactions.test.ts` |
| Ledger imutável, *append-only* (5, 6.4) | `src/domain/wallet/wallet-ledger-entry.ts`, `src/infrastructure/migrations` | `test/unit/domain/wallet-ledger-entry.test.ts`, `test/integration/schema-wallet-ledger.test.ts` |
| Saldo ↔ ledger também no schema (5, 6.2) | `src/infrastructure/migrations` (`trg_wallet_balance_has_ledger`) | `test/integration/schema-balance-has-ledger.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK (7) | `src/domain/wager/wager-policy.ts`, `src/application/use-cases/settle-wager-transaction.ts` | `test/unit/domain/wager-policy.test.ts`, `test/integration/process-wager-transaction.use-case.test.ts` |
| Reversão uma vez só; prêmio pago impede devolver a aposta (7) | `src/domain/wager/wager-policy.ts`, índice `uq_wtx_reversed_once` | `test/integration/settled-without-reference.test.ts`, `test/integration/schema-wager-transactions.test.ts` |
| Referência fora de ordem: `PENDING_REFERENCE`, backoff, limite (7.1) | `src/application/use-cases/resolve-pending-reference.use-case.ts`, `src/domain/wager/pending-reference-schedule.ts` | `test/integration/pending-reference.test.ts`, `test/integration/pending-reference-worker.test.ts`, `test/concurrency/reference-arrives-together.test.ts` |
| Taxonomia de `failureCode` (7.2) | `src/domain/errors/failure-code.ts` | `test/unit/domain/failure-code.test.ts` |
| Cenário obrigatório: 100.00 e duas BETs de 80.00 (8) | `src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.ts` (`FOR UPDATE` + versão) | `test/concurrency/balance-race.test.ts`, `test/concurrency/database-refuses-negative.test.ts` |
| A mesma aposta 50 vezes em paralelo (13) | `src/application/use-cases/process-wager-transaction.use-case.ts` | `test/concurrency/same-bet-50.test.ts` |
| Sem lock global; wallets distintas em paralelo (5, 8) | `src/infrastructure/persistence/repositories/mikro-orm-wallet.repository.ts` | `test/concurrency/wallet-lock-scope.test.ts`, `test/concurrency/hot-wallet.test.ts` |
| Três ou mais instâncias (8) | o banco decide (nenhum estado em memória) | `test/concurrency/multi-instance.test.ts` |
| Idempotência persistente, replay e payload divergente (9) | `src/application/use-cases/process-wager-transaction.use-case.ts` | `test/integration/process-wager-transaction.use-case.test.ts`, `test/integration/idempotency-race.test.ts` |
| Algoritmo do `payloadHash` (9) | `src/domain/wager/wager-payload-hash.ts` | `test/unit/domain/payload-hash.test.ts` |
| Status HTTP distintos e consistentes (9) | `src/interfaces/http/http-status.ts`, `src/interfaces/http/http-exception.filter.ts` | `test/unit/interfaces/http-status.test.ts`, `test/e2e/http-errors.http.test.ts` |
| Rotas da API e formato das respostas (9) | `src/interfaces/http` | `test/e2e/wallets.http.test.ts`, `test/e2e/wagering-transactions.http.test.ts`, `test/e2e/queries.http.test.ts` |
| Extrato com cursor estável e opaco (9) | `src/application/queries/ledger-cursor.ts` | `test/unit/application/ledger-cursor.test.ts`, `test/integration/queries.test.ts` |
| Reconciliação que detecta e não corrige (9) | `src/application/use-cases/reconcile-wallet.use-case.ts` | `test/integration/reconciliation.test.ts` |
| Consumidor SQS: mesmo caso de uso, inbox, ack após o commit, DLQ (10) | `src/interfaces/sqs/wager-sqs.consumer.ts`, `src/application/messaging/wager-message-handler.ts` | `test/integration/sqs-consumer.test.ts`, `test/integration/inbox-on-replay.test.ts`, `test/unit/application/wager-message-handler.test.ts` |
| Worker morto depois do commit e antes do ack (10, 13) | `src/interfaces/sqs/wager-sqs.consumer.ts` | `test/integration/sqs-consumer-crash.test.ts` |
| `SIGTERM`: termina o que está em andamento (10) | `src/bootstrap.ts` | `test/e2e/sigterm.process.test.ts` (só em Linux), `test/e2e/http-drain.test.ts` |
| Outbox atômica: nada publicado antes do commit (5, 11) | `src/application/use-cases/settle-wager-transaction.ts`, `src/application/use-cases/publish-outbox-batch.use-case.ts` | `test/integration/persistence-unit-of-work.test.ts`, `test/integration/outbox-crash.test.ts` |
| Publishers concorrentes sobre a mesma outbox (11) | `src/infrastructure/persistence/repositories/mikro-orm-outbox.repository.ts` (`SKIP LOCKED`) | `test/integration/outbox-publisher.test.ts`, `test/concurrency/outbox-publishers.test.ts` |
| Eventos mínimos e o envelope versionado (11) | `src/domain/messaging/events` | `test/unit/domain/integration-events.test.ts` |
| `FAILED`, terminal e auditável (6.3, ADR-0016) | `src/application/use-cases/process-wager-transaction.use-case.ts`, `src/application/messaging/wager-message-handler.ts` | `test/integration/failed-status.test.ts`, `test/unit/application/consumer-failed-decision.test.ts` |
| Recuperação após reinicialização (13) | todo o estado está no banco | `test/e2e/service-restart.test.ts` |
| Invariante final: saldo = ledger em toda wallet (13) | `test/support/invariants.ts` | `test/concurrency/global-invariants.test.ts` |
| Migrations versionadas e reversíveis (4) | `src/infrastructure/migrations` | `test/integration/migrations.test.ts` |
| Logs JSON sem dados sensíveis (12) | `src/infrastructure/observability/json-logger.ts` | `test/unit/infrastructure/json-logger.test.ts`, `test/e2e/logging.process.test.ts` |
| Métricas exigidas (12) | `src/application/ports/metrics.port.ts`, `src/infrastructure/observability/prometheus-registry.ts` | `test/e2e/metrics.http.test.ts`, `test/integration/metrics-instrumentation.test.ts` |
| Liveness e readiness separados (9, 12) | `src/interfaces/http/health/health.service.ts`, `src/infrastructure/health/sqs-probe.ts` | `test/e2e/health-ready.test.ts`, `test/integration/sqs-readiness-queues.test.ts` |
| Autenticação: decisão e ponto de extensão (2) | `src/application/ports/provider-identity.port.ts`, `src/interfaces/http/provider-auth.guard.ts` | `test/e2e/provider-auth.http.test.ts` |
| Domínio sem Nest, ORM nem AWS SDK (6.1) | `scripts/check-money.ts` | `test/unit/scripts/check-money.test.ts` |

## Exemplos de ponta a ponta

A autenticação não está implementada (decisão no [ARCHITECTURE.md](ARCHITECTURE.md#510-autenticação-adiada-com-ponto-de-extensão)),
então **nenhum exemplo leva `Authorization`**. O bloco abaixo é um único script: cole-o inteiro num
terminal com `bash` e `curl`, com a stack no ar. Ele cria uma wallet, aposta, repete a aposta
(replay), recebe um prêmio, devolve uma aposta, mostra uma rejeição e uma referência que chega fora
de ordem, lê o extrato e a reconciliação, e manda uma aposta **pela fila**.

O comentário `# => NNN` antes de cada chamada é o status HTTP esperado. **Um teste
(`test/e2e/readme-examples.test.ts`) executa este bloco de verdade, com `bash` e `curl`, e confere
cada status**; o CI também o roda contra a stack do `docker compose`, subida do zero.

```bash readme-example
BASE=${BASE:-http://localhost:3000}
SQS_QUEUE_URL=${SQS_QUEUE_URL:-http://localhost:4566/000000000000/wager-transactions.fifo}
RUN=${RUN:-$(date +%s)}                     # torna cada execução única (as chaves não colidem)
PLAYER_ID="00000000-0000-4000-8000-$(printf '%012d' "$RUN")"
JSON='Content-Type: application/json'

# 1. Criar a wallet com saldo inicial de 100.00 (o saldo inicial vira um lançamento CREDIT)
# => 201
RESPONSE=$(curl -s -X POST "$BASE/wallets" -H "$JSON" -d '{
  "playerId": "'"$PLAYER_ID"'",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}')
echo "$RESPONSE"
WALLET_ID=$(echo "$RESPONSE" | sed -E 's/.*"id":"([^"]+)".*/\1/')

# 2. Apostar 25.00. O header Idempotency-Key é obrigatório; o padrão é {providerId}:{externalTransactionId}
# => 201
BET='{
  "providerId": "provider-a", "externalTransactionId": "bet-'"$RUN"'",
  "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
  "roundId": "round-1", "gameId": "fortune-chimp", "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
RESPONSE=$(curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:bet-$RUN" -d "$BET")
echo "$RESPONSE"                            # saldo 75.00, idempotentReplay false
BET_TRANSACTION_ID=$(echo "$RESPONSE" | sed -E 's/.*"transactionId":"([^"]+)".*/\1/')

# 3. Reenviar a MESMA aposta (replay): 200, o mesmo resultado, idempotentReplay true, nenhum débito novo
# => 200
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:bet-$RUN" -d "$BET"; echo

# 4. A mesma chave com OUTRO valor não é replay: 409 IDEMPOTENCY_KEY_REUSED
# => 409
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:bet-$RUN" -d "${BET/25.00/26.00}"; echo

# 5. Pagar o prêmio (WIN de 80.00, que aponta para a aposta): saldo 155.00
# => 201
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:win-$RUN" -d '{
  "providerId": "provider-a", "externalTransactionId": "win-'"$RUN"'",
  "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
  "roundId": "round-1", "gameId": "fortune-chimp", "kind": "WIN",
  "referenceExternalTransactionId": "bet-'"$RUN"'",
  "money": { "amount": "80.00", "currency": "BRL" }
}'; echo

# 6. REFUND que chega ANTES da aposta que ele devolve: aceito e pendente (202 PENDING_REFERENCE)
# => 202
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:refund-$RUN" -d '{
  "providerId": "provider-a", "externalTransactionId": "refund-'"$RUN"'",
  "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
  "roundId": "round-2", "gameId": "fortune-chimp", "kind": "REFUND",
  "referenceExternalTransactionId": "bet-2-'"$RUN"'",
  "money": { "amount": "10.00", "currency": "BRL" }
}'; echo

# 7. A aposta que faltava chega: 201, saldo 145.00. O worker resolve o REFUND em instantes
# => 201
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:bet-2-$RUN" -d '{
  "providerId": "provider-a", "externalTransactionId": "bet-2-'"$RUN"'",
  "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
  "roundId": "round-2", "gameId": "fortune-chimp", "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}'; echo
sleep 3

# 8. O REFUND pendente já foi resolvido (consulta pela chave do PROVEDOR): PROCESSED
# => 200
curl -s "$BASE/providers/provider-a/wagering/transactions/refund-$RUN"; echo

# 9. Uma regra de negócio violada é 422 REJECTED, gravada e auditável (saldo insuficiente)
# => 422
curl -s -X POST "$BASE/wagering/transactions" -H "$JSON" \
  -H "Idempotency-Key: provider-a:big-bet-$RUN" -d '{
  "providerId": "provider-a", "externalTransactionId": "big-bet-'"$RUN"'",
  "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
  "roundId": "round-3", "gameId": "fortune-chimp", "kind": "BET",
  "money": { "amount": "999999.00", "currency": "BRL" }
}'; echo

# 10. A wallet e o extrato (o mais novo primeiro), 2 por página, com cursor opaco
# => 200
curl -s "$BASE/wallets/$WALLET_ID"; echo
# => 200
PAGE=$(curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=2")
echo "$PAGE"
CURSOR=$(echo "$PAGE" | sed -E 's/.*"nextCursor":"([^"]+)".*/\1/')
# => 200
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=2&cursor=$CURSOR"; echo

# 11. Uma transação pelo id
# => 200
curl -s "$BASE/wagering/transactions/$BET_TRANSACTION_ID"; echo

# 12. Reconciliação: o saldo guardado contra o que o ledger reconstrói (só lê, nunca corrige)
# => 200
curl -s -X POST "$BASE/wallets/$WALLET_ID/reconciliation"; echo

# 13. Uma aposta pela FILA (o mesmo caso de uso; a mensagem segue o envelope do enunciado). O
#     SQS é o MiniStack: a chamada é a API de fila da AWS, que o curl faz sem SDK.
MESSAGE='{
  "messageId": "msg-'"$RUN"'", "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-26T12:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "sqs-bet-'"$RUN"'",
    "idempotencyKey": "provider-a:sqs-bet-'"$RUN"'",
    "playerId": "'"$PLAYER_ID"'", "walletId": "'"$WALLET_ID"'",
    "roundId": "round-4", "gameId": "fortune-chimp", "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}'
# => 200
curl -s -X POST "$SQS_QUEUE_URL" -d Action=SendMessage -d Version=2012-11-05 \
  --data-urlencode "MessageBody=$MESSAGE" \
  -d "MessageGroupId=$WALLET_ID" -d "MessageDeduplicationId=msg-$RUN" > /dev/null
sleep 3

# 14. O consumidor processou: o saldo é 145.00 (e a transação existe pela chave do provedor)
# => 200
curl -s "$BASE/wallets/$WALLET_ID"; echo
# => 200
curl -s "$BASE/providers/provider-a/wagering/transactions/sqs-bet-$RUN"; echo

# 15. Saúde e métricas (abertos, sem token)
# => 200
curl -s "$BASE/health/ready"; echo
# => 200
curl -s "$BASE/metrics" | grep '^wager_transactions_total'
```

Saldo esperado ao fim: `145.00` (100 − 25 + 80 − 10 + 10 − 10: aposta, prêmio, segunda aposta, o
REFUND que a devolve, e a aposta enviada pela fila). A reconciliação do passo 12 responde
`consistent: true` com `checkedEntries: 5`; o teste confere esses números.

## Comandos

Os comandos que rodam **no host** (migrations, a app fora do compose) leem `DATABASE_URL` e
`SQS_ENDPOINT` do ambiente. O compose não precisa disso, mas num clone limpo `bun run migration:up`
falha com `DATABASE_URL is required` até você criar o `.env` (o Bun o lê sozinho; os valores do
modelo apontam para a stack do compose em `localhost`):

```bash
cp .env.example .env               # bash
Copy-Item .env.example .env        # PowerShell
```

```bash
bun run check               # typecheck, lint, format:check e check:money, em sequência (para no 1º erro)
bun run build
bun run migration:up        # aplica as migrations do lado do host (no compose, o serviço `migrate` faz isso)
bun run migration:down      # desfaz a mais nova
bun scripts/burst.ts        # uma rajada de 150 requisições em 30 wallets contra a app no ar
docker compose logs -f app  # logs JSON da aplicação
docker compose down -v      # derruba tudo e apaga os volumes
```

Cada linha é um comando só (nada encadeado com `&&`), então funciona igual no bash e no Windows
PowerShell 5.1.

## Variáveis de ambiente

Todas têm padrão que funciona no `docker compose`; um valor inválido **derruba a subida** dizendo
qual variável é. Os valores do compose estão em [docker-compose.yml](docker-compose.yml) e o modelo
em [.env.example](.env.example). Os padrões e as faixas abaixo são conferidos por um teste contra o
código (`test/unit/readme-env-table.test.ts`).

| Variável | Padrão | Faixa | O que faz |
| --- | --- | --- | --- |
| `PORT` | `3000` | | Porta HTTP. |
| `DATABASE_URL` | (obrigatória) | | PostgreSQL. No compose: `postgres://wallet:wallet@postgres:5432/wallet`. |
| `SQS_ENDPOINT` | (sem padrão) | | Endpoint do SQS (MiniStack no compose). `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e `AWS_REGION` seguem o SDK da AWS (no compose: `test`, `test`, `us-east-1`). |
| `DB_POOL_MIN` | `2` | inteiro ≥ 0 | Conexões mínimas do pool. |
| `DB_POOL_MAX` | `20` | inteiro ≥ 0 | Conexões máximas **por processo**. Com o pool cheio, o pedido espera até `DB_ACQUIRE_TIMEOUT_MS` e vira 503. |
| `DB_ACQUIRE_TIMEOUT_MS` | `3000` | inteiro ≥ 0 | Quanto esperar por uma conexão livre. O padrão de 3 s foi medido (ARCHITECTURE.md, seção 5.2): com 1 s, a rajada da tabela dá 503 em mais da metade das requisições. |
| `DB_LOCK_TIMEOUT_MS` | `5000` | 1 a 600000 | Quanto esperar pelo lock de uma wallet antes de responder 503. |
| `RETRY_AFTER_SECONDS` | `1` | 1 a 3600 | O `Retry-After` do 503. |
| `HTTP_SHUTDOWN_DRAIN_MS` | `5000` | 0 a 60000 | No SIGTERM, por quanto tempo o HTTP continua atendendo com o `/health/ready` já em 503, para o balanceador parar de mandar tráfego. |
| `HTTP_SHUTDOWN_TIMEOUT_MS` | `10000` | 0 a 120000 | Depois da drenagem, quanto esperar as requisições em andamento antes de cortar as conexões. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `fatal` | Nível mínimo dos logs JSON. |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | inteiro ≥ 1 | Tentativas totais (a 1ª gravação conta) até rejeitar uma referência que não chega. O campo `attempts` da transação conta só as tentativas que **não** acharam a referência; a que decide não entra, então uma rejeição com o limite 10 mostra `attempts: 9`. |
| `PENDING_REFERENCE_BASE_DELAY_MS` | `1000` | inteiro ≥ 1 | Base do backoff da espera pela referência. |
| `PENDING_REFERENCE_MAX_DELAY_MS` | `300000` | inteiro ≥ base | Teto da espera entre tentativas. |
| `SQS_CONSUMER_ENABLED` | `true` | `true` ou `false` | Liga o consumidor SQS neste processo. |
| `SQS_QUEUE_NAME` | `wager-transactions.fifo` | | Fila de entrada. |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | | Fila dos que não têm jeito. |
| `SQS_MAX_RECEIVE_COUNT` | `10` | 1 a 1000 | Entregas antes de ir para a DLQ (tem que ser ≤ o `maxReceiveCount` da fila). |
| `SQS_RETRY_BASE_SECONDS` | `2` | 0 a 60 | Base do backoff do consumidor. |
| `SQS_RETRY_MAX_SECONDS` | `60` | 0 a 900 | Teto do backoff do consumidor. |
| `SQS_SHUTDOWN_TIMEOUT_MS` | `20000` | 0 a 120000 | Quanto esperar as mensagens em andamento no SIGTERM. |
| `SQS_WAIT_SECONDS` | `20` | 0 a 20 | Long polling do `ReceiveMessage`. |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | `true` ou `false` | Liga o publisher da outbox neste processo. |
| `OUTBOX_QUEUE_NAME` | `wallet-events.fifo` | | Fila dos eventos publicados. |
| `OUTBOX_BATCH_SIZE` | `10` | 1 a 10 | Eventos por ciclo. |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | 10 a 60000 | Pausa entre ciclos vazios. |
| `OUTBOX_SEND_TIMEOUT_MS` | `5000` | 100 a 60000 | Prazo do envio ao SQS (a transação fica aberta). |
| `OUTBOX_STATS_INTERVAL_MS` | `10000` | 100 a 3600000 | De quanto em quanto tempo o publisher loga o estado da outbox. |
| `OUTBOX_STUCK_ATTEMPTS` | `10` | 1 a 1000 | A partir de quantas tentativas um evento é "preso" e o log sobe para `error`. |
| `OUTBOX_SHUTDOWN_TIMEOUT_MS` | `10000` | 0 a 120000 | Quanto esperar o ciclo em andamento no SIGTERM. |
| `PENDING_WORKER_ENABLED` | `true` | `true` ou `false` | Liga o worker de referências pendentes. |
| `PENDING_WORKER_BATCH_SIZE` | `20` | 1 a 100 | Pendentes reservadas por ciclo. |
| `PENDING_WORKER_POLL_INTERVAL_MS` | `1000` | 10 a 60000 | Pausa entre ciclos. |
| `PENDING_WORKER_LEASE_MS` | `30000` | 1000 a 3600000 | Por quanto tempo um item reservado é "do" worker. |
| `PENDING_WORKER_SHUTDOWN_TIMEOUT_MS` | `10000` | 0 a 120000 | Quanto esperar a resolução em andamento no SIGTERM. |

Só para os testes: `TEST_DATABASE_URL` (padrão `postgres://wallet:wallet@localhost:5432/wallet_test`;
o nome do banco **tem** que terminar em `_test`), `TEST_DB_RESET=1` (recria o banco de testes) e
`CONCURRENCY_ROUNDS` (rodadas das cargas de concorrência; padrão `100`).

## Mapa do repositório

```text
src/domain/          Money, Wallet, ledger, WagerPolicy, máquina de estados, eventos (sem framework, sem ORM)
src/application/     casos de uso, portas, comandos, consultas, métricas (sem framework)
src/infrastructure/  MikroORM (repositórios, UnitOfWork, migrations), SQS, logs, métricas, probes
src/interfaces/      controllers HTTP, consumidor SQS, workers (outbox e pendentes), módulos Nest
scripts/             check (verificações estáticas), check-money (fronteiras), burst (rajada), filas
test/                unit, integration, e2e e concurrency (+ support)
docs/adr/            as decisões de arquitetura, uma por arquivo
```

As fronteiras (`domain` ← `application` ← `infrastructure` e `interfaces`) são **verificadas** por
`bun run check:money`, que também roda no CI: o domínio e a aplicação não importam Nest, MikroORM
nem AWS SDK, e dinheiro nunca passa por `number`.
