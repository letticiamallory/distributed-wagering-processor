# Distributed Wagering Processor

[![CI](https://github.com/letticiamallory/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/letticiamallory/distributed-wagering-processor/actions/workflows/ci.yml)

Serviço de carteira (wallet) para apostas: processa transações de provedores de jogos que chegam
por **HTTP** e por **SQS**, sem nunca deixar o saldo negativo, sem duplicar um débito quando o
provedor reenvia, e sem perder um evento confirmado. NestJS 12 e MikroORM 7 sobre PostgreSQL 16,
rodando no Bun 1.4.5; SQS emulado pelo MiniStack.

- **Como a coisa funciona e por quê:** [ARCHITECTURE.md](ARCHITECTURE.md) (decisões, trade-offs e
  limitações, com os números medidos).
- **Cada decisão, uma por arquivo:** [docs/adr](docs/adr/README.md).

## Como avaliar em 5 minutos

**Pré-requisitos:** Docker com Compose v2. Para os testes, o [Bun](https://bun.sh) **1.4.5**. Para
os exemplos abaixo, `bash` e `curl`. O repositório não precisa de nenhum arquivo `.env` para subir.

```bash
git clone https://github.com/letticiamallory/distributed-wagering-processor.git
cd distributed-wagering-processor
docker compose up -d --wait        # postgres, sqs (MiniStack), filas, migrations e a app
curl -s localhost:3000/health/ready
```

O `docker compose up` sobe cinco coisas, nesta ordem: o PostgreSQL (que também cria o banco de
testes `wallet_test`), o MiniStack, o `queues-init` (cria `wager-transactions.fifo`, a DLQ
`wager-transactions-dlq.fifo` e `wallet-events.fifo`), o `migrate` (aplica o schema e termina) e a
aplicação em `http://localhost:3000`, que já roda o consumidor SQS, o publisher da outbox e o worker
de referências pendentes.

Na primeira subida (volume vazio) o PostgreSQL leva perto de 1 minuto para inicializar; o
healthcheck espera até 170 s, então o `--wait` pode demorar sem que nada esteja errado.

> **O MiniStack guarda as filas só em memória (não persiste nada).** Se o container `sqs` reiniciar,
> as filas e as mensagens que estavam nelas somem, e o consumidor passa a logar
> `queue_receive_failed`. Para recriá-las, rode de novo `docker compose up -d --wait`: ele executa
> outra vez o `queues-init` (que é idempotente). Os eventos da outbox não se perdem: ficam no banco e
> são publicados quando a fila volta.

```bash
bun install --frozen-lockfile
bun run test                # suíte principal
bun run test:concurrency    # concorrência com paralelismo real
bun run test:all            # as duas
```

| Comando | O que prova |
| --- | --- |
| `bun run test` | Unidade, integração e e2e, contra **PostgreSQL e MiniStack de verdade** (sem mock de banco nem de fila): o domínio e o `Money`, as constraints e os triggers do schema, a idempotência, o consumidor SQS (retry, DLQ, ack só depois do commit), a outbox e o worker de pendentes, processos mortos com `SIGKILL`, o formato dos logs, as métricas, o `/health/ready` com dependências derrubadas de verdade, e **os exemplos deste README**. |
| `bun run test:concurrency` | O saldo nunca fica negativo e **saldo = o que o ledger reconstrói** sob paralelismo real: a mesma aposta 50 vezes ao mesmo tempo, duas apostas disputando o saldo, uma wallet quente, **3 processos** da aplicação sobre o mesmo banco, e 3 publishers sobre a mesma outbox. Termina com uma checagem global de todas as wallets que a suíte criou. |
| `bun run test:all` | As duas, em sequência. |

Os testes usam filas e um banco **próprios** (`wallet_test`, filas `test-*`): pode rodá-los com a
stack do compose no ar. O [ARCHITECTURE.md](ARCHITECTURE.md) tem a tabela das **sabotagens**: o que
acontece quando se remove cada proteção, para ver que os testes de fato a pegam.

## Exemplos de ponta a ponta (sem token)

A autenticação não está implementada (ADR-0010: o enunciado não a pontua, e o ponto de extensão está
pronto), então **nenhum exemplo leva `Authorization`**. O bloco abaixo é um único script: cole-o
inteiro num terminal com `bash` e `curl`, com a stack no ar. Ele cria uma wallet, aposta, repete a
aposta (replay), recebe um prêmio, devolve uma aposta, mostra uma rejeição e uma referência que
chega fora de ordem, lê o extrato e a reconciliação, e manda uma aposta **pela fila**.

O comentário `# => NNN` antes de cada chamada é o status HTTP esperado. **Um teste
(`test/e2e/readme-examples.test.ts`) executa este bloco de verdade, com `bash` e `curl`, e confere
cada status**: se o exemplo parar de funcionar, o CI quebra.

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

## Variáveis de ambiente

Todas têm padrão que funciona no `docker compose`; um valor inválido **derruba a subida** dizendo
qual variável é. Os valores do compose estão em [docker-compose.yml](docker-compose.yml) e o modelo
em [.env.example](.env.example). Os padrões abaixo são conferidos por um teste contra o código.

| Variável | Padrão | Faixa | O que faz |
| --- | --- | --- | --- |
| `PORT` | `3000` | | Porta HTTP. |
| `DATABASE_URL` | (obrigatória) | | PostgreSQL. No compose: `postgres://wallet:wallet@postgres:5432/wallet`. |
| `SQS_ENDPOINT` | (sem padrão) | | Endpoint do SQS (MiniStack no compose). `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e `AWS_REGION` seguem o SDK da AWS (no compose: `test`, `test`, `us-east-1`). |
| `DB_POOL_MIN` | `2` | inteiro ≥ 0 | Conexões mínimas do pool. |
| `DB_POOL_MAX` | `20` | inteiro ≥ 0 | Conexões máximas **por processo**. Com o pool cheio, o pedido espera até `DB_ACQUIRE_TIMEOUT_MS` e vira 503. |
| `DB_ACQUIRE_TIMEOUT_MS` | `1000` | inteiro ≥ 0 | Quanto esperar por uma conexão livre. |
| `DB_LOCK_TIMEOUT_MS` | `5000` | 1 a 600000 | Quanto esperar pelo lock de uma wallet antes de responder 503. |
| `RETRY_AFTER_SECONDS` | `1` | 1 a 3600 | O `Retry-After` do 503. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `fatal` | Nível mínimo dos logs JSON. |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | inteiro ≥ 1 | Tentativas totais (a 1ª gravação conta) até rejeitar uma referência que não chega. |
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

## Como a requisição anda

```mermaid
flowchart LR
  subgraph entrada["Entrada (a mesma regra para os dois canais)"]
    H["HTTP<br/>POST /wagering/transactions<br/>Idempotency-Key"] --> UC
    S[("wager-transactions.fifo")] --> C["Consumidor SQS<br/>(grupo = walletId)"]
    C -->|"ok: ack só depois do commit"| UC
    C -.->|"permanente ou 10 entregas"| D[("DLQ")]
  end

  UC["ProcessWagerTransactionUseCase<br/>(idempotência, política, lock da wallet)"]

  subgraph tx["UMA transação PostgreSQL (READ COMMITTED)"]
    W["wallets<br/>SELECT … FOR UPDATE + version"]
    T["wager_transactions"]
    L["wallet_ledger_entries<br/>(append-only)"]
    I["inbox_messages<br/>(só vindo do SQS)"]
    O["outbox_messages"]
  end

  UC --> tx
  O -->|"FOR UPDATE SKIP LOCKED"| P["Publisher da outbox<br/>(vários ao mesmo tempo)"]
  P -->|"at-least-once (quem consome deduplica por eventId)"| E[("wallet-events.fifo")]
  T -->|"PENDING_REFERENCE"| K["Worker de pendentes<br/>(lease, relê sob o lock)"]
  K --> UC
```

A mesma operação por HTTP ou por SQS passa pelo **mesmo caso de uso**, e o `payloadHash` é igual.
Saldo, lançamento no ledger, transação, inbox (quando vem da fila) e evento da outbox são
gravados na **mesma transação SQL**: ou tudo é confirmado, ou nada. Nada é publicado antes do
commit.

## Estrutura

```text
src/domain/          Money, Wallet, ledger, WagerPolicy, eventos (sem framework, sem ORM)
src/application/     casos de uso, portas, comandos, consultas, métricas (sem framework)
src/infrastructure/  MikroORM (repositórios, UnitOfWork, migrations), SQS, logs, métricas, probes
src/interfaces/      controllers HTTP, consumidor SQS, workers (outbox e pendentes), módulos Nest
test/                unit, integration, e2e e concurrency (+ support)
docs/adr/            as decisões de arquitetura, uma por arquivo
```

As fronteiras (`domain` ← `application` ← `infrastructure` e `interfaces`) são **verificadas** por
`bun run check:money`, que também roda no CI: o domínio e a aplicação não importam Nest, MikroORM
nem AWS SDK, e dinheiro nunca passa por `number`.

## Comandos úteis

```bash
bun run typecheck && bun run lint && bun run format:check && bun run check:money && bun run build
bun run migration:up        # aplica as migrations do lado do host (no compose, o serviço `migrate` faz isso)
docker compose logs -f app  # logs JSON da aplicação
docker compose down -v      # derruba tudo e apaga os volumes
```
