# ADR-0011: Consumidor SQS: classificação de erros, retry com backoff e DLQ

Status: Aceito · Data: 2026-11-26

## Contexto
O enunciado (seção 10) pede um consumidor que reutilize o caso de uso do HTTP, deduplique pela
inbox `(consumerName, messageId)`, só dê ack **depois do commit**, distinga erros de negócio
(terminais, com ack), transitórios (retry com backoff) e permanentes (DLQ), respeite um limite de
tentativas, trate o SIGTERM e suporte redelivery sem duplicar efeitos.

O SQS entrega **pelo menos uma vez**. Na fila FIFO, mensagens do mesmo `MessageGroupId` saem em
ordem: enquanto uma está invisível (em andamento ou em espera), as seguintes do grupo não são
entregues. Usamos `MessageGroupId = walletId`.

## Decisão

### 1. Quem decide e quem age
- **`WagerMessageHandler`** (aplicação, sem AWS): lê o envelope (`messageId`, `type`,
  `occurredAt`, `data`, validado com zod), chama o **mesmo** `ProcessWagerTransactionUseCase` do
  HTTP (`data` como corpo, `data.idempotencyKey` como chave, `inbox: { consumerName, messageId }`
  e `correlationId = messageId`) e devolve uma decisão: `ACK`, `RETRY(espera)` ou
  `DEAD_LETTER(motivo)`. Nunca lança.
- **`WagerSqsConsumer`** (interfaces): o laço (long polling, lote de 10, grupos em paralelo e,
  dentro do grupo, em sequência) e a execução da decisão contra a fila, por uma porta fina
  (`QueueGateway`). O `DeleteMessage` só acontece **depois** de o handler terminar, isto é,
  depois do commit do banco.
- O hash do payload é o mesmo do HTTP (o cálculo mora no caso de uso): o mesmo conteúdo por HTTP
  e por SQS dá replay, nunca `IDEMPOTENCY_KEY_REUSED`.

### 2. Tabela de classificação
| O que aconteceu | Tipo | Ação |
| --- | --- | --- |
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, inbox já vista | negócio (concluído) | **ack** |
| `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT` | negócio (terminal, determinístico) | **ack**, com log `warn` com `messageId` e `idempotencyKey` |
| transação `FAILED` já registrada (preparado: hoje nenhum caminho do código grava `FAILED`) | negócio (registrado) | ack, log `error` |
| `DEPENDENCY_UNAVAILABLE` (banco fora, `lock_timeout`, deadlock, pool) | transitório | **não apaga**; `ChangeMessageVisibility` com backoff |
| erro que não sabemos classificar (bug) | desconhecido | tratado como transitório: não apaga; o limite o leva à DLQ |
| JSON inválido, envelope inválido, payload inválido (`INVALID_PAYLOAD`, `INVALID_AMOUNT`, `UNSUPPORTED_KIND`) | permanente | **DLQ** |
| `WALLET_NOT_FOUND` | permanente | **DLQ** |
| `InboxMessageReusedError` (mesmo `messageId`, outro conteúdo) | permanente (bug do produtor) | **DLQ** |
| erro `critical` (ex.: `UnresolvedIdempotencyRaceError`) | permanente | **DLQ** e log `fatal`, uma vez |
| transitório na última entrega permitida | esgotado | **DLQ** (`RETRIES_EXHAUSTED`) |

Por que o conflito de idempotência leva **ack** e `WALLET_NOT_FOUND` leva **DLQ**: o conflito é um
resultado terminal e determinístico (reprocessar dá o mesmo conflito, e a operação original já
vale); apagar não perde nada, e o `warn` deixa rastro. Já `WALLET_NOT_FOUND` **não gravou nada**:
a operação não terminou, e um operador pode reinjetar a mensagem depois de criar a wallet. Ack
aqui perderia dinheiro de verdade. (Mandar os conflitos para a DLQ foi considerado; o enunciado os chama de
erros de negócio, terminais, com ack, e é ele quem manda.)

### 3. Como o permanente chega à DLQ: envio explícito
O consumidor faz `SendMessage` na DLQ (corpo intacto, mesmo `MessageGroupId`, atributos `reason`,
`failureCode`, `originalMessageId`, `receiveCount`) e **depois** `DeleteMessage` na original. O
`redrive` do SQS fica como **rede de segurança** para o que o código não consegue classificar (o
processo que morre no meio).

| | Envio explícito (escolhido) | Só o redrive |
| --- | --- | --- |
| Quando chega à DLQ | na 1ª entrega | só depois de N entregas |
| Fila da wallet (FIFO) | liberada na hora | **bloqueada** por N entregas por uma mensagem que nunca vai funcionar |
| Motivo na DLQ | sim (atributos) | não |
| Atomicidade | não: se o processo morre entre o envio e o delete, a mensagem volta e é enviada de novo | sim |

Custo aceito: uma duplicata na DLQ nessa janela. A deduplicação do FIFO (`MessageDeduplicationId`
= id do SQS da original, janela de 5 minutos) a descarta na maioria dos casos, e nada financeiro
se duplica (a DLQ não é processada). Se o **envio falhar**, a original **não** é apagada: ela
volta e tenta de novo (nada se perde).

### 4. Limite de tentativas e backoff
- Espera depois da falha de ordem n: `min(2^n × 2 s, 60 s)` → 4, 8, 16, 32, 60, 60... segundos.
- **10 entregas** no total (`SQS_MAX_RECEIVE_COUNT`, o mesmo número do `maxReceiveCount` do
  redrive em `init-queues.sh`): 9 esperas somam **360 s (6 min)**. Com 5 seriam só 60 s, curto
  demais para uma queda do banco. É da mesma ordem do PENDING_REFERENCE (511 s).
- Na última entrega permitida o **consumidor** envia à DLQ (`RETRIES_EXHAUSTED`), sem depender do
  momento em que o emulador faz o redrive (o spike do ADR-0002 mostrou que ele acontece no
  *receive* seguinte). Um teste confere que o limite do consumidor é **menor ou igual** ao do
  redrive.
- Tudo é configurável por variável de ambiente e validado na subida (`SQS_MAX_RECEIVE_COUNT`,
  `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS`, `SQS_SHUTDOWN_TIMEOUT_MS`,
  `SQS_WAIT_SECONDS`, `SQS_QUEUE_NAME`, `SQS_DLQ_NAME`, `SQS_CONSUMER_ENABLED`).

### 5. Mensagem em backoff segura as seguintes da mesma wallet, e isso é desejável
No FIFO, enquanto a mensagem de uma wallet espera em backoff (invisível), o SQS **não entrega as
seguintes do mesmo grupo**. Isso é o comportamento que queremos: **preserva a ordem por wallet**
(uma `WIN` não passa na frente da `BET` que ainda vai ser reprocessada). Outras wallets (outros
grupos) não são afetadas. O consumidor reforça a regra no lote: se uma mensagem do grupo não é
concluída (retry, falha no ack ou na DLQ), as seguintes do mesmo lote voltam à fila **sem ser
processadas**. O custo é o atraso das mensagens daquela wallet durante o backoff (até ~6 min no
pior caso), em troca de ordem.

### 6. `MessageGroupId = walletId` é otimização, não garantia
A ordem por wallet evita disputa pelo lock e mantém a ordem em condições normais. **A correção não
depende dela**: lock `FOR UPDATE`, versão e `UNIQUE` (ADR-0007) valem com mensagens da mesma
wallet em grupos diferentes e vários consumidores (há um teste assim). Nenhuma regra de negócio
pode assumir a ordem da fila.

### 7. SIGTERM
`enableShutdownHooks()` no `bootstrap` liga o sinal ao `app.close()`. O consumidor então:
1. **para de buscar** (e aborta o long polling parado);
2. **espera** as mensagens em andamento, até `SQS_SHUTDOWN_TIMEOUT_MS` (padrão 20 s, abaixo dos
   30 s do `stop_grace_period` do compose);
3. **devolve** (`ChangeMessageVisibility 0`) as que foram recebidas e não começaram, para outra
   instância pegar na hora;
4. o banco só fecha **depois** (o hook do consumidor roda antes do hook do MikroORM; há um teste
   e2e que prende a mensagem em um lock e fecha o app).

Passado o prazo, a mensagem ainda em andamento **não é apagada nem devolvida**: se o commit saiu,
a reentrega vira replay (inbox + idempotência); se não saiu, nada foi gravado.

### 8. O `critical` nunca passa em silêncio
Erro `critical` vai à DLQ e é logado no nível `fatal` (o mais alto do Logger do Nest), uma vez só,
como o filtro HTTP faz. Nunca há ack silencioso.

### 9. Ligado por padrão, desligado nos testes, e filas de teste separadas
`SQS_CONSUMER_ENABLED` vale `true` por padrão (é o que o `docker compose up` espera). Em
`test/support/setup.ts` ele é fixado em `false` (inclusive para os processos filhos da suíte de concorrência), e
`SQS_QUEUE_NAME`/`SQS_DLQ_NAME` apontam para filas **só de teste** (`test-app-wager-transactions*`).
Resultado: a suíte passa com a stack inteira no ar (`docker compose up -d`, com o consumidor do app
de verdade ligado nas filas reais), porque **nenhum teste envia mensagem às filas reais**. O único
teste que as toca (`smoke.test.ts`) só lê nomes e atributos (o redrive). Cada teste que consome
cria o seu par de filas, com nome único.
Uma mensagem-sonda, enviada à fila configurada do ambiente de teste, prova que o app do e2e e os 3
processos da suíte de concorrência não a consomem.

## Alternativas consideradas
- **Só o redrive para os permanentes**: mais simples e atômico, mas bloqueia o grupo FIFO por N
  entregas e a DLQ perde o motivo.
- **Conflitos de idempotência na DLQ**: enche a DLQ com mensagens que o operador não tem
  o que fazer; o `warn` com os ids dá o mesmo rastro.
- **`maxReceiveCount` 5**: só 60 s de espera total.
- **Processar o lote em paralelo sem agrupar por grupo**: mais vazão, mas disputa o lock da mesma
  wallet e prende conexões do pool (o limite medido na suíte de concorrência, ADR-0007).

## Consequências
+ Ack só depois do commit; reentrega vira replay; permanentes saem da frente na 1ª entrega, com
  motivo; desligar o processo não deixa mensagem pela metade; tudo configurável e testado com
  Postgres e MiniStack reais.
− O lote espera o grupo mais lento (uma wallet quente atrasa o lote inteiro): trocar por um
  limite de concorrência por grupo é trabalho futuro, junto da fila por wallet do ADR-0007.
− O long polling abortado pelo SIGTERM pode deixar uma mensagem invisível até a visibilidade da
  fila (30 s) vencer; não há perda.
− No Windows o `SIGTERM` não executa handlers: lá o teste prova o *wiring* (`createApp()`
  registra o handler) e o `app.close()` de verdade. O SIGTERM real, num processo real com uma
  mensagem em andamento, roda no Linux/CI (`test/e2e/sigterm.process.test.ts`, pulado no Windows).
− Uma duplicata na DLQ é possível na janela entre o envio e o delete (descrita acima).
