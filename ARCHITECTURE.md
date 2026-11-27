# Arquitetura, decisões, trade-offs e limitações

Este documento explica **como** o serviço de wallet garante o que o enunciado exige e **por quê**,
com os números que foram medidos. Cada decisão tem um ADR próprio em [docs/adr](docs/adr/README.md);
aqui está o quadro todo. Para subir e avaliar em 5 minutos, veja o [README](README.md).

Regra deste documento: só entra o que foi **medido** ou **testado**. Onde algo é desenho e não está
implementado (a autenticação, a fila por wallet), a seção diz isso na primeira linha. Todo número
diz como refazê-lo: com um comando do repositório (`bun run test:concurrency` imprime uma linha
`[concurrency]` por cenário, com requisições, 503, tempo e invariantes), ou, quando não há comando
(as sabotagens, feitas editando o código à mão), com a marca "medido durante o desenvolvimento
(26/11/2026, Windows 11 com Docker Desktop, Bun 1.4.5)". Os números marcados assim variam de máquina
para máquina.

- [1. Arquitetura hexagonal e fronteiras](#1-arquitetura-hexagonal-e-fronteiras)
- [2. Concorrência: o saldo nunca fica negativo](#2-concorrência-o-saldo-nunca-fica-negativo)
- [3. Idempotência em duas camadas e o `payloadHash`](#3-idempotência-em-duas-camadas-e-o-payloadhash)
- [4. Taxonomia de `failureCode` e o que o provedor faz](#4-taxonomia-de-failurecode-e-o-que-o-provedor-faz)
- [5. Mapa de status HTTP](#5-mapa-de-status-http)
- [6. Mensageria: inbox, consumidor, DLQ, outbox e pendentes](#6-mensageria-inbox-consumidor-dlq-outbox-e-pendentes)
- [7. Reconciliação](#7-reconciliação)
- [8. Observabilidade](#8-observabilidade)
- [9. Autenticação (adiada, com ponto de extensão)](#9-autenticação-adiada-com-ponto-de-extensão)
- [10. Limitações conhecidas, com números](#10-limitações-conhecidas-com-números)
- [11. Índice dos ADRs](#11-índice-dos-adrs)

---

## 1. Arquitetura hexagonal e fronteiras

(ADR-0001, ADR-0003)

```text
interfaces ──┐                          HTTP (controllers), consumidor SQS, workers
             ├──► application ──► domain
infrastructure ┘   (casos de uso,         (Money, Wallet, ledger, WagerPolicy,
 (MikroORM, SQS,    portas)                máquina de estados, eventos)
  logs, métricas)
```

- **`src/domain`**: regras puras, sem relógio, sem banco e sem framework. A decisão de negócio de
  uma transação é uma função (`WagerPolicy.decide`) que recebe a wallet, a transação e a referência
  e devolve *aplicar*, *rejeitar com um código* ou *esperar a referência*.
- **`src/application`**: os casos de uso e as **portas** (classes abstratas que a infraestrutura
  implementa): `UnitOfWork`, repositórios, leitores, `MetricsPort`. Os casos de uso entram no Nest
  por `useFactory`, então não carregam decorador de framework.
- **`src/infrastructure`**: MikroORM v7 com `defineEntity`, **fora** do domínio. As classes do
  domínio **não** são as entidades do ORM; o mapeamento é explícito nos dois sentidos
  (`rehydrate`). Construtores das entidades de domínio são privados (`create`/`rehydrate`).
- **`src/interfaces`**: HTTP, o consumidor SQS e os workers. Só convertem entrada em comando e
  resultado em status.

**A fronteira é verificada, não combinada.** `bun run check:money` (também no CI) falha se
`src/domain` ou `src/application` importar Nest, MikroORM ou o AWS SDK (a aplicação pode usar
`zod`); se `decimal.js` for importado fora de `src/domain/money`; ou se uma linha que fala de
`amount`, `balance` ou `money` converter para `number`. É uma heurística de linha, e o ADR-0006
diz o que ela não prova.

**Dinheiro** (ADR-0006) é um `Money` imutável sobre `decimal.js`, com string de 2 casas exatas
(`"25.00"`), sem arredondar nem completar (`"10.5"` e `"10.005"` são recusados) e com teto de
16 dígitos inteiros. No banco é `NUMERIC(20,2)`.

**Garantias também no schema** (ADR-0004): `CHECK (balance >= 0)`, ledger *append-only* por
trigger (UPDATE e DELETE recusados), estado final de transação imutável por trigger,
`UNIQUE (wallet_id, wallet_version)` no ledger e `UNIQUE` de idempotência. Um bug no código
esbarra no banco.

---

## 2. Concorrência: o saldo nunca fica negativo

(ADR-0007; enunciado, seção 8)

Duas BETs de 60,00 numa wallet de 100,00 leem o mesmo saldo, as duas passam na regra, e o saldo
iria a −20,00. A defesa tem **quatro barreiras**, em camadas:

| # | Barreira | Onde | O que pega |
| --- | --- | --- | --- |
| 1 | `SELECT … FOR UPDATE` na wallet, dentro de **uma** transação `READ COMMITTED` | caso de uso + `UnitOfWork` | serializa as operações da mesma wallet; quem entra vê o saldo final |
| 2 | `UPDATE wallets … WHERE id = $1 AND version = $esperada` precisa afetar 1 linha | repositório | um bug que escreva sem o lock |
| 3 | `UNIQUE (wallet_id, wallet_version)` no ledger | schema | dois lançamentos para a mesma versão |
| 4 | `CHECK (balance >= 0)` | schema | o saldo negativo, mesmo se tudo acima falhar |

**Por que lock pessimista, e não otimista ou `SERIALIZABLE`.** Numa wallet muito usada quase toda
tentativa otimista conflitaria e refaria o trabalho; `SERIALIZABLE` devolve erros de serialização
que o código teria de repetir e cobra de toda operação, não só das concorrentes. O lock é preso à
própria linha (um advisory lock trava por um número que o banco não relaciona às linhas).

**Sem deadlock por desenho.** Cada operação trava **uma** wallet. A referência de uma reversão é
lida sem lock, e isso é seguro por uma regra que vale para o sistema todo:

> toda decisão de estado ou de dinheiro acontece sob o lock da wallet; colunas só de agendamento
> (`next_attempt_at`) podem ser escritas sem ele, porque toda decisão relê sob o lock.

O `lock_timeout` é de 5 s (`DB_LOCK_TIMEOUT_MS`): estourou, é falha **transitória** (503 com
`Retry-After`), sem gravar nada, e reenviar a mesma chave é seguro (seção 3).

### O que acontece quando se remove cada barreira (medido na suíte de concorrência)

Cada linha é uma **sabotagem**: tirei a proteção do código, rodei a suíte de concorrência e
registrei o que quebrou. O objetivo é provar que os testes realmente enxergam cada defesa.
Os números da tabela: medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker Desktop,
Bun 1.4.5), editando o código à mão. Não há script no repositório que refaça as sabotagens; o que dá
para refazer é a suíte com o código certo (`bun run test:concurrency`).

| Sabotagem | Testes que falham | Sintoma |
| --- | --- | --- |
| (a) sem `FOR UPDATE` | 8 | `500 ConcurrentWalletUpdateError`: a **versão** segura; saldo e ledger continuam corretos (check global: 0 violações) |
| (b) sem `FOR UPDATE` e sem versão | 8 | `500 DuplicateKeyError uq_ledger_wallet_version`: o **ledger** segura; check global: 0 violações |
| (c) sem `CHECK (balance >= 0)`, mantendo o lock | 1 (o teste 7) | saldo final −60,00 em 100 problemas de 50 rodadas; os outros 16 seguem verdes **por desenho** (com o lock o código nunca chega ao `CHECK`) |
| (d) sem lock, sem versão e sem `uq_ledger_wallet_version` | 8 | **lost update de verdade**: as duas BETs de 80,00 ficam `PROCESSED`, saldo 20,00 contra −60,00 que o ledger reconstrói; hot wallet 765,00 contra −1335,00; **check global: 434 violações em 775 wallets** |
| (e) lock **global** (advisory) no lugar do lock por wallet | 1 | só o teste "com a wallet A travada, a BET na B termina" falha (503 em vez de 201); os de saldo seguem verdes, porque serializar tudo continua correto, só mais lento |

A leitura: as camadas 2, 3 e 4 são **redes de segurança** que nunca disparam com o código certo;
só removendo as três (d) aparece corrupção. Por isso o teste 4 ("wallets diferentes em paralelo")
é necessário: só ele distingue o lock por wallet de um lock global.

### Cargas da suíte de concorrência

`bun run test:concurrency` (17 cenários na época e um **check global** que reconstrói o ledger de
todas as wallets criadas; 3 execuções seguidas, todas verdes, em 86 s, 82 s e 69 s, com 775 wallets
no check global e 0 violações: medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker
Desktop, Bun 1.4.5)). Os números de cada execução saem nas linhas `[concurrency]` da própria suíte. Alguns cenários: a mesma BET 50 vezes ao mesmo tempo (10 rodadas, 500 requisições,
0 falhas de 503); 100 wallets × 2 BETs; 50 wallets em paralelo; **3 processos** da aplicação sobre
o mesmo banco (200 requisições, 67/67/66 por processo, 0 503). A suíte atual tem 18 cenários
(entrou o dos 3 publishers).

### O limite conhecido: a wallet quente (medido, **não é defeito**)

Quem espera o lock de uma wallet **segura uma conexão do pool sem fazer nada**. Numa wallet
quente as operações saem uma por vez, mas cada requisição na fila ocupa uma das 20 conexões do
processo (`DB_POOL_MAX`); quando acabam, as seguintes esperam no máximo 1 s por uma conexão
(`DB_ACQUIRE_TIMEOUT_MS`) e levam **503 com `Retry-After`**.

- **290 requisições simultâneas** na mesma wallet: de 154 a 343 respostas 503 com 1 processo; com
  3 processos, de 228 a 535 (medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker
  Desktop, Bun 1.4.5), várias execuções). Uma execução se refaz com
  `bun test test/concurrency/hot-wallet.test.ts` (1 processo) e
  `bun test test/concurrency/multi-instance.test.ts` (3 processos): a linha `[concurrency]` traz
  `status503` e `reasons503`.
- **100% das causas foram "pool sem conexão" e 0 foram `lock_timeout`** (em todas as execuções).
- Todo reenvio com a mesma `Idempotency-Key` foi seguro: uma linha por chave, saldo e ledger
  batendo.
- Jitter no reenvio do cliente (3 execuções por modo, intercaladas; medido durante o
  desenvolvimento (26/11/2026, Windows 11 com Docker Desktop, Bun 1.4.5); o modo se escolhe com
  `CLIENT_RETRY_JITTER=wide bun test test/concurrency/multi-instance.test.ts`, ou `none`/`narrow`): com 3 processos, o jitter
  largo corta os 503 em cerca de 25–30% (228–260 contra 294–400), mas **o tempo total não
  melhora**; com 1 processo o corte está dentro do ruído.

É o **controle de admissão** funcionando: recusar com segurança em vez de enfileirar sem limite.
O custo é tempo e tráfego de reenvio numa wallet quente, nunca correção.

**Correção estrutural (não aplicada):** uma **fila por wallet em memória, antes de pedir a
conexão**, para quem espera ocupar uma entrada de fila (barata) e não uma conexão. O `FOR UPDATE`
continua sendo a garantia entre processos. Exige limite de tamanho e de espera da fila e muda o
desenho do ADR-0007, então entra com ADR próprio. Aumentar o pool foi descartado (3 processos × 50
passam dos 100 do Postgres) e o acquire timeout de 1 s é uma escolha de controle de admissão (recusar cedo em vez de
enfileirar; dá para medir outros valores com `DB_ACQUIRE_TIMEOUT_MS`).

---

## 3. Idempotência em duas camadas e o `payloadHash`

(ADR-0008)

O provedor reenvia (timeout no HTTP, entrega *at-least-once* no SQS, queda depois do commit e
antes do ack). Duas perguntas diferentes:

- *Esta **entrega** da fila já foi processada?* → **inbox** (`inbox_messages`, chave primária
  `(consumer_name, message_id)`), gravada na **mesma transação** do negócio. Só existe linha de
  inbox se o negócio também foi confirmado. **Toda entrega deixa a sua linha, inclusive a que é
  resolvida como replay** (a operação já tinha chegado por HTTP ou por outro `messageId`): nesse
  caso a linha entra com `ON CONFLICT DO NOTHING` e, se já existia, o hash guardado tem que ser o
  mesmo. Assim o mesmo `messageId` com outro payload é sempre `INBOX_MESSAGE_REUSED` (DLQ), e nunca
  uma operação nova.
- *Esta **operação de negócio** já foi processada?* → **chave de idempotência**
  (`wager_transactions.idempotency_key` é `UNIQUE`). Vale entre instâncias **e entre canais**: a
  mesma BET por HTTP e por SQS é uma operação só.

| Situação | Resultado |
| --- | --- |
| Chave nova | Processa |
| Mesma chave, mesmo hash | Replay do resultado guardado (`idempotentReplay: true`, com o saldo **da época**, não o de hoje) |
| Mesma chave, hash diferente | `409 IDEMPOTENCY_KEY_REUSED` |
| Chave nova, mas `(provider_id, external_transaction_id)` já existe | `409 EXTERNAL_ID_CONFLICT` |
| Wallet inexistente | `404 WALLET_NOT_FOUND`, **nada gravado**; reenviar a chave depois que a wallet existir é aceito |

**Duas checagens por chave.** O caminho rápido (antes da transação, sem lock) resolve quase todos
os replays sem travar nada; a mesma checagem se repete **depois** do lock, porque outra
requisição igual pode ter commitado entre as duas. Os `UNIQUE` são a última barreira. Dois
achados dos testes ficaram registrados no ADR:

1. **A janela entre as duas leituras do caminho rápido** (chave e depois id externo): a mesma
   operação pode commitar entre elas. Antes de lançar `EXTERNAL_ID_CONFLICT`, o caso de uso
   **relê a chave**. Foi achado por 50 requisições idênticas em paralelo por HTTP (4 recebiam
   409 falso).
2. **A corrida que o lock não cobre.** Mesma chave com `walletId` diferente trava wallets
   diferentes e passa junta pelas duas checagens; a segunda bloqueia no índice único e recebe
   `23505`. O caso de uso captura **só** o `23505` dessas duas constraints, deixa o rollback
   acontecer e **roda mais uma vez, no máximo uma**. Se falhar de novo, é bug: 500 e log `fatal`.

### Algoritmo do `payloadHash` (`computePayloadHash`, no domínio)

1. Só campos de **negócio**: `providerId`, `externalTransactionId`, `playerId`, `walletId`,
   `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e
   `referenceExternalTransactionId` (só quando existe). Header, `idempotencyKey`, `messageId`,
   `correlationId` e qualquer metadado de transporte ficam **de fora**.
2. Um JSON com as chaves em ordem alfabética, sem espaços, com `money` aninhado como
   `{ "amount", "currency" }`.
3. SHA-256 desse texto em UTF-8, em hexadecimal minúsculo (64 caracteres).

O valor entra já normalizado em 2 casas. Vetores fixos nos testes impedem mudar o algoritmo sem
perceber (isso invalidaria os hashes gravados), e a mesma operação por HTTP e por SQS dá o mesmo
hash (testado). **O hash é parte do contrato**: mudar campo, ordem ou algoritmo exige um ADR novo.

---

## 4. Taxonomia de `failureCode` e o que o provedor faz

(ADR-0009; `src/domain/errors/failure-code.ts`)

São **20 códigos** de domínio, em 5 categorias. **Só `DEPENDENCY_UNAVAILABLE` é reenviável**; nos
outros, reenviar a mesma chave sem mudar nada dá exatamente o mesmo resultado.

| Categoria | Código | HTTP | O que significa | O que o provedor faz |
| --- | --- | --- | --- | --- |
| validação | `INVALID_PAYLOAD` | 400 | corpo fora do contrato (campo ausente, tipo errado, JSON ruim) | **corrigir** e reenviar (com chave nova, se mudou o conteúdo) |
| validação | `INVALID_AMOUNT` | 400 | valor fora do formato (`"10.5"`, `"1e3"`, negativo, 3 casas) | **corrigir** |
| validação | `UNSUPPORTED_KIND` | 400 | `kind` fora de BET, WIN, LOSS, REFUND, ROLLBACK | **corrigir** |
| idempotência | `IDEMPOTENCY_KEY_REUSED` | 409 | mesma chave com conteúdo diferente | **não reenviar**: é bug do provedor; usar uma chave nova se a operação é outra |
| idempotência | `EXTERNAL_ID_CONFLICT` | 409 | o id externo já existe sob outra chave | **não reenviar**; reconciliar as chaves |
| negócio | `WALLET_NOT_FOUND` | 404 | a wallet não existe (nada foi gravado) | criar a wallet e reenviar a **mesma** chave; **no SQS** a mensagem vai para a DLQ |
| negócio | `WALLET_PLAYER_MISMATCH` | 422 | a wallet é de outro jogador | **desistir** (corrigir o cadastro) |
| negócio | `CURRENCY_MISMATCH` | 422 | moeda da transação ≠ moeda da wallet | **desistir** |
| negócio | `INSUFFICIENT_FUNDS` | 422 | a BET passa do saldo | **desistir** desta chave; uma BET nova só se o saldo mudar |
| negócio | `REVERSAL_INSUFFICIENT_FUNDS` | 422 | o ROLLBACK deixaria o saldo negativo | **desistir** |
| negócio | `REFERENCE_NOT_FOUND` | 422 | a referência não chegou em 10 tentativas (≈ 8,5 min) | **desistir**, ou reenviar a referência e a operação com chaves novas |
| negócio | `REFERENCE_MISMATCH` | 422 | a referência é de outro jogador, wallet, moeda ou rodada | **desistir** |
| negócio | `REFERENCE_NOT_PROCESSED` | 422 | a referência existe mas não está `PROCESSED` | **desistir** |
| negócio | `REFERENCE_KIND_NOT_ALLOWED` | 422 | tipo de referência que a operação não aceita | **desistir** |
| negócio | `AMOUNT_MISMATCH` | 422 | o valor da reversão difere do da referência | **desistir** |
| negócio | `REFERENCE_ALREADY_REVERSED` | 422 | a referência já foi revertida (ADR-0005: uma reversão, de qualquer tipo) | **desistir** |
| negócio | `REFERENCE_SETTLED` | 422 | reverter uma BET que já pagou prêmio deixaria o jogador com os dois | **desistir** (reverta o WIN antes) |
| negócio | `BALANCE_LIMIT_EXCEEDED` | 422 | o crédito (WIN, REFUND, ROLLBACK de BET) passaria do teto de 16 dígitos inteiros do saldo (`9999999999999999.99`); o mesmo teto vale para o `initialBalance` (ADR-0006) | **desistir**; uma nova operação só depois de o saldo baixar |
| transitório | `DEPENDENCY_UNAVAILABLE` | **503** + `Retry-After` | banco fora, pool cheio, `lock_timeout`, deadlock | **reenviar a mesma chave** depois do `Retry-After`; nada foi gravado |
| permanente | `PROCESSING_FAILED` | **500** | erro permanente de infraestrutura: a transação ficou `FAILED`, terminal e auditável, sem saldo nem ledger (só com a prova de que nenhuma tentativa foi transitória, ADR-0016) | **não reenviar a mesma chave** (devolve sempre o mesmo `FAILED`); corrigir a causa e mandar com chave nova |

Além dos 20, a API tem códigos que **não** são de transação: `WALLET_ALREADY_EXISTS` (409),
`TRANSACTION_NOT_FOUND` (404), `INTERNAL_ERROR` (500), `UNAUTHENTICATED` (401) e
`PROVIDER_FORBIDDEN` (403). O mapa é uma tabela **total** sobre todos eles
(`Record<ApiErrorCode, number>`): um código novo não compila sem um status.

**`REJECTED` não é erro de infraestrutura.** A transação rejeitada **é gravada** (tem id, saldo da
época e `failureCode`), é auditável, e o replay devolve a mesma resposta.

---

## 5. Mapa de status HTTP

(ADR-0009)

| Situação | Status | Corpo |
| --- | --- | --- |
| Transação processada (1ª vez) | **201** | `{ transactionId, status, balance, idempotentReplay: false }` |
| Replay de transação processada | **200** | o mesmo corpo, `idempotentReplay: true`, saldo da época |
| Aceita, aguardando a referência (1ª vez ou replay) | **202** | `status: PENDING_REFERENCE`, sem `balance` |
| Rejeitada por regra de negócio (1ª vez ou replay) | **422** | `status: REJECTED`, `failureCode`, `balance` |
| Payload inválido, JSON ruim, corpo vazio, `Idempotency-Key` ausente, inválida ou repetida | **400** | erro, com `details` |
| Wallet, transação ou rota inexistente | **404** | erro |
| Conflito de idempotência, ou wallet já existente | **409** | erro |
| Corpo acima do limite | **413** | erro |
| Falha transitória de infraestrutura | **503** + `Retry-After` | erro, `retryable: true` |
| Erro inesperado (bug), e o replay de uma transação `FAILED` (ADR-0016) | **500** | erro |
| Sem credencial, ou provedor sem direito sobre o `providerId` | 401 / 403 | erro (ADR-0010) |

- **Formato único de erro** em todas as rotas: `{ "error": { "code", "message", "retryable",
  "correlationId" } }`, com `details: [{ path, message }]` só nos 400. Nada de SQL, constraint ou
  stack vaza; a causa vai para o **log**, com o mesmo `correlationId`.
- **`REJECTED` é 422, não 200**: o provedor sabe pelo status que nada foi aplicado e que reenviar
  não muda nada. O custo: dois formatos de corpo de erro (o envelope e o resultado do 422).
- **`Idempotency-Key` repetido** (duas linhas do header) é 400: o Node junta em `"a, b"`, e
  adivinhar qual vale poderia duplicar um débito.
- **As consultas** (`GET`) respondem **200 para qualquer status** guardado (um `REJECTED` ou um
  `PENDING_REFERENCE` é um recurso que existe). A reconciliação (`POST`) responde **200 mesmo
  divergente**: a resposta é o relatório, não uma falha.
- **Níveis de log:** 4xx não gera log de erro; 503 é `warn`; qualquer outro 500 é `error`; o que
  nunca deveria acontecer (a corrida de idempotência que a reexecução não resolveu) é `fatal`,
  uma única vez.

---

## 6. Mensageria: inbox, consumidor, DLQ, outbox e pendentes

### 6.1 Consumidor SQS (ADR-0011)

O consumidor faz *long polling* (lotes de até 10), agrupa por `MessageGroupId = walletId` (grupos
em **paralelo**, e dentro do grupo em **sequência**) e chama o **mesmo** caso de uso do HTTP. O
`DeleteMessage` só acontece **depois** do commit. A ordem por wallet é uma **otimização** (evita
disputa pelo lock); a garantia de correção é do banco.

| O que aconteceu | Ação |
| --- | --- |
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, inbox já vista | **ack** |
| `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT` (terminais e determinísticos) | **ack** + log `warn` com `messageId` e `idempotencyKey` |
| `DEPENDENCY_UNAVAILABLE` (banco, `lock_timeout`, deadlock, pool) | **não apaga**; devolve a visibilidade com backoff |
| erro que não sabemos classificar (bug) | tratado como transitório; o limite o leva à DLQ |
| JSON, envelope ou payload inválido (inclusive texto com caractere de controle ou Unicode inválido); `WALLET_NOT_FOUND`; mesmo `messageId` com outro conteúdo; erro `critical` | **DLQ** (o `critical` também loga `fatal`, uma vez) |
| o banco recusou o **dado** (SQLSTATE classe `22`, ou `08P01`): `PERMANENT_DATA_ERROR` | **DLQ** já: reenviar dá o mesmo erro, e o retry seguraria a wallet por minutos |
| erro permanente (bug, ou `PermanentDataError`) em **todas** as entregas, com a prova em `consumer_delivery_failures` | grava `FAILED` com `PROCESSING_FAILED` e ack (ADR-0016); sem a prova completa (alguma entrega foi transitória, ou ficou sem registro), DLQ: **uma queda longa do banco nunca vira `FAILED`** |
| transitório na última entrega permitida | **DLQ** (`RETRIES_EXHAUSTED`) |

- **Por que conflito de idempotência é *ack* e `WALLET_NOT_FOUND` é DLQ:** o conflito é terminal e
  determinístico (apagar não perde nada, e o `warn` deixa rastro); `WALLET_NOT_FOUND` **não
  gravou nada**, e um operador pode reinjetar a mensagem depois de criar a wallet. *Ack* ali
  perderia dinheiro de verdade.
- **Backoff:** `min(2^n × 2 s, 60 s)` entre as falhas (4, 8, 16, 32, 60, … s); `maxReceiveCount`
  de **10** entregas = 9 esperas = **360 s** no total. No FIFO, a mensagem em backoff **segura as
  seguintes da mesma wallet**, e isso é desejável (preserva a ordem por wallet).
- **DLQ por envio explícito, com o *redrive* como rede de segurança.** O consumidor envia à DLQ
  (corpo intacto, com `reason`, `failureCode`, `originalMessageId` e `receiveCount`) e **depois**
  apaga a original; se o envio falha, a original não é apagada. Só o *redrive* bloquearia a fila
  da wallet por N entregas por uma mensagem que nunca vai funcionar. Custo aceito: uma
  **duplicata possível na DLQ** se o processo morrer entre o envio e o delete (a deduplicação do
  FIFO a descarta na maioria dos casos; a DLQ não é processada).
- **SIGTERM:** para de buscar, espera as mensagens em andamento (`SQS_SHUTDOWN_TIMEOUT_MS`) e
  devolve à fila, com visibilidade 0, as que foram recebidas e não começaram.
- Testes: crash real (o processo filho se mata com `SIGKILL` no instante do delete, depois do
  commit; a mensagem volta e o
  efeito não duplica) e o `SIGTERM` real num processo (só em Linux; no Windows o Node não
  executa handlers de sinal).

### 6.2 Outbox e publisher (ADR-0012)

Eventos **só vão para a outbox**, na mesma transação do saldo e do ledger; **nunca** direto no
SQS. Um publisher lê com `FOR UPDATE SKIP LOCKED`, **segurando a transação** durante o envio (com
prazo de 5 s no cliente SQS), marca como publicado e confirma. Vários publishers (ou processos)
rodam ao mesmo tempo sem pegar a mesma linha.

- **At-least-once.** Se o processo morre depois do envio e antes do commit, o evento é
  reenviado. **Quem consome eventos deduplica pelo `eventId`** (contrato); a deduplicação do FIFO (`MessageDeduplicationId = eventId`, janela de 5 min) é só otimização.
- **Evento preso:** sem DLQ, *retry* infinito com backoff; a partir de 10 tentativas o log sobe
  para `error` (`OUTBOX_STUCK_ATTEMPTS`).
- **3 processos, 3 publishers, 30 wallets × 8 apostas** (refaça com
  `bun test test/concurrency/outbox-publishers.test.ts`): 510 eventos gerados, 510 mensagens
  entregues, **0 duplicatas** entregues, 240 requisições, 0 respostas 503, versões 1..9 completas por
  wallet. O tempo (5,7 s) foi medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker
  Desktop, Bun 1.4.5).
- **Ordem:** a ordem por wallet **não** é garantida entre publishers nem em falha parcial por
  entrada do `SendMessageBatch` (o SQS pode aceitar os seguintes); o `walletVersion` do evento
  ordena. Criar uma wallet grava 1 evento de abertura (`WalletBalanceChanged`), então os eventos
  de uma wallet são 1 + 2 por aposta.

### 6.3 Referências que chegam fora de ordem (ADR-0013)

Um REFUND, ROLLBACK, WIN ou LOSS pode chegar **antes** da BET que referencia. Ele é aceito como
`PENDING_REFERENCE` (202) e um worker o resolve:

- **Política:** 10 tentativas no total (a primeira gravação conta), espera `min(2^n × 1 s, 5 min)`:
  9 esperas = 1+2+4+8+16+32+64+128+256 = **511 s, cerca de 8,5 minutos**. Esgotadas, vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento
  `WagerTransactionRejected`: nada fica "pendente para sempre".
- **O campo `attempts`** conta as tentativas que **não** acharam a referência (cada uma deixou a
  transação em `PENDING_REFERENCE` e agendou a próxima). A tentativa que **decide** (resolve ou
  rejeita) não incrementa. Com o limite de 10: uma referência que nunca chega dá 9 tentativas sem
  achar e a 10ª rejeita, então a transação fica `REJECTED` com `attempts: 9`; uma que chega na 2ª
  tentativa fica `PROCESSED` com `attempts: 1`. Tentativas feitas = `attempts` + 1.
- **Acordar:** quando a BET é processada, as pendentes **da mesma wallet** que a esperam são
  agendadas para agora, sob o lock; o worker as resolve no ciclo seguinte (em até 1 s). Se o
  atalho se perder, o `next_attempt_at` vence sozinho.
- **Dois workers não pegam o mesmo item:** a reserva é um `UPDATE … FOR UPDATE SKIP LOCKED` que
  escreve **só** `next_attempt_at` (um *lease* de 30 s) e roda **sem** o lock da wallet. É a
  exceção que a regra do ADR-0007 prevê. Quem decide (`ResolvePendingReferenceUseCase`) **trava a
  wallet e relê tudo**. O pior que a reserva causa é trabalho repetido, nunca um estado errado.
  Há um teste que prova que a reserva muda só `next_attempt_at`.
- **Reversões** (ADR-0005): cada transação é revertida no máximo **uma vez, por qualquer tipo**
  (índice único parcial `uq_wtx_reversed_once`); sem isso, BET 25,00 → REFUND → ROLLBACK da BET
  devolveria o dinheiro duas vezes. `REFERENCE_SETTLED` é o espelho: não se reverte uma BET que já
  pagou prêmio.

---

## 7. Reconciliação

(ADR-0015)

`POST /wallets/:walletId/reconciliation` compara o **saldo guardado** com o que o **ledger
reconstrói** (a soma de créditos menos débitos, a corrente em que cada `balance_before` é o
`balance_after` do lançamento anterior, e as versões sem buraco).

- **Roda em `REPEATABLE READ` e `READ ONLY`, sem lock.** O `REPEATABLE READ` dá uma **foto única**
  do banco: o saldo e a soma do ledger são lidos no mesmo instante. Em `READ COMMITTED`, uma
  aposta que commitasse entre as duas leituras faria a conferência acusar uma divergência que não
  existe (uma sabotagem mostrou isso com escritores concorrentes: medido durante o desenvolvimento
  (26/11/2026, Windows 11 com Docker Desktop, Bun 1.4.5), editando o código). O `READ ONLY` faz o banco recusar
  qualquer escrita nessa transação (também sabotado), e sem lock a conferência **nunca atrasa uma
  aposta**.
- A diferença sai do próprio banco, em `NUMERIC` (a aplicação não faz conta de dinheiro) e pode
  ser negativa. Achados: `balance_mismatch`, `ledger_gap`, `negative_balance`.
- **Só detecta, nunca corrige.** Responde **200 mesmo divergente** (`consistent: false`), loga
  `error` **sem valores** (só `walletId`, os tipos e `checkedEntries`) e conta
  `wallet_reconciliation_divergences_total`, que é o que se alerta (o gauge guarda a última
  execução, e uma wallet limpa o zera).
- **Escopo:** é por wallet e sob demanda. **Não existe varredura global** do banco no serviço; a
  suíte de concorrência tem um check global próprio, que é ferramenta de teste.

---

## 8. Observabilidade

(ADR-0014)

- **Logs:** um objeto JSON por linha em stdout (`JsonLogger` próprio, sem dependência), nível por
  `LOG_LEVEL`, com `correlationId` (do header `X-Correlation-Id` validado, ou um UUID novo; no SQS
  é o `messageId`) em toda linha da requisição. **Nunca** o corpo da requisição ou da mensagem: os
  erros do parser (`JSON.parse`, `zod`) citam o corpo, então viram descrições fixas; a redação de
  campos sensíveis é testada.
- **Métricas Prometheus** em `GET /metrics`, num **registro próprio** (sem `prom-client`; uma nota
  antiga previa `prom-client@15.1.3`, mas a implementação o dispensou, e as dependências foram
  removidas do `package.json`). O `MetricsPort` é opcional nos casos de uso (padrão: no-op), e
  conta-se **depois do commit**: um `ROLLBACK` não aconteceu.

| Série | O que conta |
| --- | --- |
| `wager_transactions_total{status,kind}` | transações decididas |
| `wager_duplicates_total{channel,kind}` | replays de chave e reentregas já na inbox |
| `wager_conflicts_total{kind}` | chave reusada, id externo sob outra chave, `messageId` reusado |
| `wager_processing_seconds{channel,outcome}` | **latência** (histograma) |
| `wager_retries_total{component}` | consumidor devolveu a mensagem; outbox reagendou o evento |
| `wager_dlq_messages_total{reason}`, `consumer_messages_total{outcome}` | o consumidor |
| `wager_db_unavailable_total{reason}` | o que vira 503: `pool_timeout`, `lock_timeout`, `deadlock`, `serialization`, `connection`, `other` |
| `outbox_events_published_total`, `outbox_pending_messages`, `outbox_lag_seconds` | a outbox (as duas últimas são lidas **na raspagem**) |
| `pending_reference_resolutions_total{outcome}`, `pending_reference_transactions` | o worker e a fila de pendentes |
| `http_requests_total`, `http_request_duration_seconds` | tráfego (rota como **padrão**, nunca a URL; o resto é `unmatched`) |
| `wallet_reconciliation_*` | execuções, divergências por tipo, divergências acumuladas, última execução |

- **Health:** `GET /health/live` só diz que o processo responde (não olha o banco, de propósito);
  `GET /health/ready` confere o **Postgres e o SQS de verdade**, e no SQS **as filas, por nome**, de que o processo precisa (a de entrada e a DLQ se o consumidor está ligado, a de eventos se o publisher está ligado): o MiniStack reiniciado responde, mas perdeu as filas, e responde 503 enquanto qualquer
  um estiver fora, **e também no primeiro instante do SIGTERM** (`shutting_down`), para o
  balanceador parar de mandar tráfego. Há testes que derrubam um PostgreSQL e um MiniStack
  **reais** (containers descartáveis) e veem o 503 e depois o 200.
- `/health` e `/metrics` são **abertos** (enunciado, seção 9).
- **Sabotagens do consumidor, da outbox e do worker, da observabilidade e das consultas** (medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker Desktop, Bun 1.4.5), editando o código à mão e conferindo o SHA-256 dos arquivos antes e depois; não há script que as refaça):
  consumidor, 10 variantes (apagar antes do commit derrubou 15 testes; sem inbox derrubou 4, e
  note que **o débito não duplica**, porque a chave de idempotência cobre: quem acusa é a linha da
  inbox); outbox e worker, 10 (sem `SKIP LOCKED` derrubou 6); observabilidade, 15 (log que vaza o
  corpo, `/ready` sem Postgres, métrica que deixa de contar); consultas e reconciliação, 14
  (leitura em `READ COMMITTED` derrubou 2, cursor inclusivo 3, `consistent` fixo em `true` 10).
  Duas escaparam na primeira versão do teste (o módulo que não espera o consumidor, e o replay
  contado como transação nova) e os testes foram **fortalecidos** até pegá-las.

---

## 9. Autenticação (adiada, com ponto de extensão)

(ADR-0010; enunciado, seção 2: a autenticação **não vale pontos**)

**Decisão: não está implementada.** Qualquer cliente, inclusive sem token, pode chamar as rotas de
negócio; por isso os exemplos do README não levam `Authorization`. Em vez disso há um **ponto de
extensão** com a forma final, testado:

- `ProviderIdentityPort` (aplicação): `identify(credential)` devolve uma identidade que responde
  `mayActAs(providerId)`; credencial ausente ou inválida lança `UnauthenticatedError` (401).
- `UnrestrictedProviderIdentityPort` (infraestrutura): a implementação **de hoje**, que aceita
  qualquer credencial e deixa agir como qualquer provedor.
- `ProviderAuthGuard` (interfaces): aplicado nos controllers de **negócio** e **não** no health nem
  no `/metrics`. Autentica antes de validar o corpo (401 antes de 400) e confere o `providerId` do
  corpo **e o da rota** (`:providerId`) contra a identidade (403 `PROVIDER_FORBIDDEN`).
- Um teste percorre **todos os controllers** e falha se algum, fora health e metrics, estiver sem
  o guard: uma rota nova não pode esquecê-lo.

**O desenho que adotaríamos** (não implementado): Keycloak (ou outro IdP OIDC) no Compose, fluxo
*client credentials* com um *client* por provedor; JWT RS256 validado **localmente** pelo JWKS
(assinatura, `iss`, `aud`, `exp`, `nbf`, lista fechada de algoritmos, tolerância de relógio
curta; nada de chamar o IdP por requisição); o `providerId` do *client* entra no token por um
*protocol mapper*; o `providerId` do corpo tem que bater com o do token (senão 403, antes de ler
o banco); a **criação de wallet** seria restrita à plataforma por um escopo próprio
(`wallet:create`). Trocar a implementação é **uma classe nova** (a que lê o JWKS, com `jose`) ligada
no módulo, mais a configuração validada na subida: nenhum caso de uso, controller ou guard muda.
O SQS é um canal interno confiável: a mensagem não leva token, mas o `providerId` dela passa pela
mesma validação do comando.

---

## 10. Limitações conhecidas, com números

| Limitação | O que se sabe | Onde |
| --- | --- | --- |
| **Wallet quente** responde 503 sob pico | 290 requisições simultâneas na mesma wallet: 154–343 respostas 503 com 1 processo, 228–535 com 3 (medido durante o desenvolvimento (26/11/2026, Windows 11 com Docker Desktop, Bun 1.4.5); uma execução: `bun test test/concurrency/hot-wallet.test.ts`); **100% por pool sem conexão, 0 por `lock_timeout`**; nenhum reenvio duplicou. Correção estrutural (fila por wallet antes da conexão) **não aplicada** | seção 2, ADR-0007 |
| **Ordem dos eventos** entre publishers | não garantida; o `walletVersion` ordena. Em falha parcial do `SendMessageBatch` o SQS pode aceitar entradas seguintes | seção 6.2, ADR-0012 |
| **Métricas por processo** | cada instância expõe o próprio `/metrics`; somar entre réplicas é com o Prometheus | seção 8 |
| **Saldo ↔ ledger só confere sob demanda** | a constraint diferida no banco **não foi implementada**; a reconciliação detecta, não impede, e não há varredura global | seção 7, ADR-0004 |
| **Lote do consumidor** | o lote de até 10 mensagens espera o grupo mais lento | seção 6.1 |
| **Duplicata na DLQ** | possível se o processo morrer entre o envio e o delete | seção 6.1 |
| **Outbox**: índice `(occurred_at) WHERE published_at IS NULL` não existe | só vale criar se o backlog crescer; hoje não foi medido como necessário | ADR-0012 |
| **Moedas** | todas usam 2 casas (JPY sem centavos não é suportado); teto de 16 dígitos inteiros | ADR-0006 |
| **`check:money` é uma heurística de linha** | pega o descuido comum (`parseFloat(amount)`); não prova que não existe `number` em lugar nenhum | ADR-0006 |
| **Autenticação** | não implementada (desenho na seção 9) | ADR-0010 |
| **SIGTERM real no Windows** | o Node não executa handlers de sinal no Windows; o teste real roda em Linux (no CI e em container) e no Windows prova só a ligação do encerramento | ADR-0011 |
| **Ambiente de teste** | o banco de teste usa `synchronous_commit = off` (só por velocidade, **nunca** em produção); o compose do repositório não é um deploy de produção | README |
| **Um REFUND/ROLLBACK de wallet diferente** não é acordado pelo atalho | a pendente de outra wallet espera o próprio backoff e vira `REFERENCE_MISMATCH` na vez dela | ADR-0007 |

---

## 11. Índice dos ADRs

| ADR | Decisão |
| --- | --- |
| [0001](docs/adr/0001-hexagonal-architecture.md) | Arquitetura hexagonal em 4 camadas |
| [0002](docs/adr/0002-ministack-instead-of-localstack.md) | MiniStack em vez de LocalStack |
| [0003](docs/adr/0003-mikroorm-v7-define-entity.md) | MikroORM v7 com `defineEntity` fora do domínio |
| [0004](docs/adr/0004-schema-level-guarantees.md) | Garantias no schema (constraints e triggers) |
| [0005](docs/adr/0005-single-reversal-per-transaction.md) | Reversão única por transação, de qualquer tipo |
| [0006](docs/adr/0006-money-with-decimal-without-rounding.md) | Money com Decimal, sem arredondamento |
| [0007](docs/adr/0007-pessimistic-lock-per-wallet.md) | Lock pessimista por wallet (e o limite da wallet quente) |
| [0008](docs/adr/0008-two-layer-idempotency-and-payload-hash.md) | Idempotência em duas camadas e algoritmo do `payloadHash` |
| [0009](docs/adr/0009-http-status-map-and-error-format.md) | Mapa de status HTTP, formato único de erro e taxonomia de `failureCode` |
| [0010](docs/adr/0010-authentication-deferred-with-extension-point.md) | Autenticação adiada, com ponto de extensão |
| [0011](docs/adr/0011-sqs-consumer-error-classification-retry-and-dlq.md) | Consumidor SQS: classificação de erros, retry com backoff e DLQ |
| [0012](docs/adr/0012-outbox-publisher-skip-locked-at-least-once.md) | Publisher da outbox: `SKIP LOCKED`, entrega at-least-once |
| [0013](docs/adr/0013-pending-reference-worker-and-retry-policy.md) | Worker de `PENDING_REFERENCE` e a política de retentativa |
| [0014](docs/adr/0014-observability-json-logs-prometheus-metrics-and-health.md) | Observabilidade: logs JSON, métricas Prometheus e health checks |
| [0015](docs/adr/0015-queries-cursor-pagination-and-read-only-reconciliation.md) | Consultas, paginação por cursor e reconciliação somente leitura |
| [0016](docs/adr/0016-failed-status-only-with-proof.md) | `FAILED` só com prova de que nenhuma tentativa foi transitória |
