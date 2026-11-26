# ADR-0008: Idempotência em duas camadas e algoritmo do `payloadHash`

Status: Proposto · Data: 2026-11-25

## Contexto
O provedor reenvia: o HTTP dá timeout, o SQS entrega pelo menos uma vez, a aplicação cai
depois do commit e antes do ack. Cada reenvio não pode mexer no saldo de novo. Dois problemas
diferentes se misturam:

- "Esta **entrega** da fila já foi processada?" (mesma mensagem chegando duas vezes).
- "Esta **operação de negócio** já foi processada?" (o provedor mandou a mesma BET por HTTP e
  por SQS, ou com outro `messageId`).

## Decisão
**Camada de transporte: inbox.** No consumidor SQS, `inbox_messages` tem chave primária
`(consumer_name, message_id)`. A inserção `ON CONFLICT DO NOTHING` acontece na mesma transação
do negócio, então uma linha de inbox só existe se o negócio também foi confirmado. Se a
mensagem já existia, é reentrega: o consumidor devolve o resultado guardado e dá o ack. Mesmo
`message_id` com `payload_hash` diferente é bug do produtor: erro permanente, vai para a DLQ.

**Camada de negócio: chave de idempotência.** `wager_transactions.idempotency_key` é único.
O header `Idempotency-Key` (HTTP) ou o campo `idempotencyKey` (SQS) é a fonte da verdade; o
padrão recomendado é `{providerId}:{externalTransactionId}`. Junto da chave gravamos o
`payload_hash`, e a resposta do replay é a mesma da primeira vez, com `idempotentReplay: true`
e o saldo da época (`balance_after`), não o saldo de hoje:

| Situação | Resultado |
|---|---|
| Chave nova | Processa normalmente |
| Mesma chave, mesmo hash | Replay do resultado guardado, sem efeito colateral |
| Mesma chave, hash diferente | 409 `IDEMPOTENCY_KEY_REUSED` |
| Chave nova, mas `(provider_id, external_transaction_id)` já existe | 409 `EXTERNAL_ID_CONFLICT` |
| Wallet inexistente | 404 `WALLET_NOT_FOUND`, **nada gravado** (veja abaixo) |

**Wallet inexistente não deixa rastro.** A FK de `wager_transactions.wallet_id` impede gravar
uma transação para uma wallet que não existe, então `WALLET_NOT_FOUND` não vira linha, e
reenviar a mesma chave é **processado de novo**, não é replay. É o comportamento desejado:
se a wallet passar a existir, a mesma chave é aceita. Na inbox, o rollback desfaz também a
linha da mensagem; como o consumidor SQS reage a esse 404 fica para o ADR-0011 (Fase 5).

**Duas checagens, uma sem lock e outra com.** O caminho rápido (antes da transação, sem lock)
resolve quase todos os replays sem travar nada. A mesma checagem se repete **depois** de
travar a wallet, porque outra requisição igual pode ter commitado entre as duas. As restrições
`uq_wtx_idempotency_key` e `uq_wtx_provider_external` são a última barreira.

**A corrida que o lock não cobre.** Duas requisições com a mesma chave e `walletId`
diferente travam wallets diferentes e passam juntas pelas duas checagens. A segunda bloqueia
no índice único e recebe `23505` quando a primeira commita. O caso de uso captura **só** o
`23505` dessas duas constraints, deixa o rollback acontecer e **roda mais uma vez**, no máximo
uma: na segunda vez o caminho rápido acha a linha e devolve o conflito certo (como `walletId`
está no hash, o resultado é sempre 409). Se a segunda execução falhar de novo com `23505`, é
bug: erro 500 e log crítico. Qualquer outro `23505` ou `23514` é erro permanente.

**Algoritmo do `payloadHash`** (`computePayloadHash`, no domínio):
1. Usa só os campos de **negócio**: `providerId`, `externalTransactionId`, `playerId`,
   `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e
   `referenceExternalTransactionId` (só quando existe). O header, o `idempotencyKey`, o
   `messageId`, o `correlationId` e qualquer outro metadado de transporte ficam de fora.
2. Monta um JSON com as chaves em ordem alfabética, sem espaços, com `money` aninhado como
   `{ "amount", "currency" }`.
3. O hash é o SHA-256 desse texto em UTF-8, em hexadecimal minúsculo (64 caracteres, `CHAR(64)`).

O valor entra como `Money`, já normalizado em 2 casas: `"25.0"` nunca chega ao hash (ADR-0006).
Vetores fixos nos testes impedem mudar o algoritmo sem perceber, porque isso invalidaria os
hashes já gravados. A mesma operação por HTTP e por SQS produz o mesmo hash (testado).

## Alternativas consideradas
- **Só a constraint única, sem comparar hash:** impede o débito duplicado, mas não distingue
  um replay legítimo de uma chave reusada com outro valor.
- **Cache (Redis) de idempotência:** nova dependência e uma segunda fonte da verdade que pode
  divergir do banco. As tabelas de transação e inbox já são duráveis e transacionais.
- **Só a inbox:** cobre a reentrega do SQS, mas não o provedor que reenvia por HTTP, nem a
  mesma operação chegando por dois canais.
- **Hash do corpo bruto:** muda com a ordem das chaves, espaços e `"25.0"` contra `"25.00"`,
  e incluiria metadados de transporte.
- **Incluir o `Idempotency-Key` no hash:** a chave já é a identidade; no hash, duas chaves
  diferentes para a mesma operação nunca seriam detectadas como a mesma.

## Consequências
+ Replay barato (uma consulta por chave) e seguro: o retorno é exatamente o da primeira vez.
+ A idempotência vale entre instâncias e entre canais, porque a fonte da verdade é o Postgres.
+ A corrida de chaves tem tratamento e teste próprios, não depende de sorte.
− Cada caminho lento faz duas consultas por chave (antes e depois do lock). É o preço de
  fechar a janela entre elas.
− O hash é parte do contrato: mudar campo, ordem ou algoritmo exige um ADR novo e um plano
  para os hashes já gravados.
− O caso de uso precisa repetir a execução uma vez no `23505`, o que exige que a execução
  inteira seja segura de refazer (e é: a transação anterior foi desfeita por completo).
