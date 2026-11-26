# ADR-0009: Mapa de status HTTP, formato único de erro e taxonomia de `failureCode`

Status: Aceito · Data: 2026-11-27

## Contexto
O enunciado deixa o mapeamento de status a nosso critério, mas exige que a API distinga com
clareza, e igual em todas as rotas: payload inválido, conflito de idempotência, rejeição por
regra de negócio, aceite com processamento pendente e falha transitória. Colapsar duas dessas
situações num mesmo código obriga o provedor a ler a mensagem para decidir se pode reenviar.

## Decisão
**Um código, um status, em qualquer rota.** O mapa é uma tabela total sobre todos os códigos
da API (`Record<ApiErrorCode, number>`): um código novo não compila sem um status.

| Situação | Status | Corpo |
|---|---|---|
| Transação processada (primeira vez) | 201 | `{ transactionId, status, balance, idempotentReplay: false }` |
| Replay de transação processada | 200 | o mesmo corpo, com `idempotentReplay: true` e o saldo **da época** |
| Aceita, aguardando a referência (primeira vez ou replay) | 202 | `status: PENDING_REFERENCE`, sem `balance` |
| Rejeitada por regra de negócio (primeira vez ou replay) | 422 | `status: REJECTED`, `failureCode`, `balance` |
| Payload inválido, JSON malformado, corpo vazio ou não-JSON, `Idempotency-Key` ausente/inválida/repetida | 400 | erro (com `details`) |
| Wallet ou transação inexistente, rota inexistente | 404 | erro |
| Conflito de idempotência (`IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT`) ou `WALLET_ALREADY_EXISTS` | 409 | erro |
| Corpo acima do limite | 413 | erro |
| Falha transitória de infraestrutura | 503 + `Retry-After` | erro, `retryable: true` |
| Erro inesperado (bug), inclusive o replay de uma transação `FAILED` | 500 | erro |

**REJECTED é 422, não 200.** O provedor precisa saber só pelo status que a operação **não** foi
aplicada e que reenviar não muda nada. O replay de uma rejeição também é 422: replay devolve a
mesma resposta da primeira vez. O corpo é o **resultado da transação** (ela existe, tem id e
saldo da época), e não o envelope de erro.

**Formato único de erro**, igual em todas as rotas e em todos os status de erro:

```json
{ "error": { "code": "…", "message": "…", "retryable": false, "correlationId": "…" } }
```

`details: [{ path, message }]` aparece só nos 400. Nada mais vaza: nem SQL, nem constraint, nem
stack. A causa de verdade vai para o **log**, com o mesmo `correlationId`. Um filtro global do
Nest faz o mapeamento, então os controllers só convertem HTTP em comando e resultado em status.

**`Idempotency-Key`.** Obrigatório e é a fonte da verdade; o padrão `{providerId}:{externalId}`
é só recomendação, e qualquer outra chave é aceita. Ausente, vazio, em branco ou com mais de
255 caracteres: 400 apontando `Idempotency-Key`. **Repetido** (duas linhas do header): 400, porque
o Node junta cabeçalhos repetidos em `"a, b"` e adivinhar qual vale poderia duplicar um débito.
Um `idempotencyKey` dentro do corpo é ignorado e não entra no hash.

**Replay de FAILED.** Uma transação que terminou em `FAILED` é final (o trigger a trava), então
a mesma chave devolve sempre a mesma resposta: 500, `INTERNAL_ERROR`, `retryable: false`, com o
`failureCode` gravado e o `transactionId` para o suporte achar a linha.

**503.** Falha transitória (`lock_timeout`, pool cheio, banco fora, deadlock): `Retry-After` em
segundos inteiros (`RETRY_AFTER_SECONDS`, padrão 1, validado na subida). Nada foi gravado; o
provedor reenvia a mesma chave com segurança (ADR-0008).

**Níveis de log.** 4xx não é erro nosso e não gera log de erro. 503 é `warn` (esperado sob
carga). Qualquer outro 500 é `error`. O que **nunca** deveria acontecer (a corrida de idempotência
que a reexecução não resolveu, `critical`) é `fatal`, uma única vez, com o `correlationId`.

**`X-Correlation-Id`.** Um middleware lê o header, devolve na resposta e o guarda num
`AsyncLocalStorage`. Só entra o que parece um identificador (`[\w.:-]{1,128}`); qualquer outra
coisa (espaço, aspas, `<script>`) é descartada e vira um UUID novo, porque o valor vai direto
para logs e eventos. A transação e os eventos da outbox gravam o id da requisição que os criou.

**Taxonomia de `failureCode`.** Cada código tem categoria (`validation`, `idempotency`,
`business`, `transient`) e diz se é reenviável. Só `DEPENDENCY_UNAVAILABLE` é. Os códigos de
regra de negócio são 422 onde quer que apareçam.

## Alternativas consideradas
- **REJECTED como 200 com `status: REJECTED`:** o provedor teria de abrir o corpo para saber que
  nada foi aplicado.
- **Rejeição dentro do envelope de erro:** a rejeição é uma transação gravada, com id e saldo da
  época; o envelope é para o que não criou transação.
- **Aceitar o header repetido (usar o primeiro):** adivinhar a chave certa pode duplicar um débito.
- **Retry-After fixo:** o ajuste certo depende do ambiente, e o mínimo é 1 s.

## Consequências
+ O provedor decide reenviar, corrigir ou desistir só pelo status e por `retryable`.
+ Um bug de mapeamento quebra um teste (a tabela é exaustiva), não a produção.
− Dois formatos de corpo de erro (o envelope e o resultado do 422) que o cliente precisa conhecer.
− O replay de FAILED é 500 mesmo sendo uma resposta guardada, para o provedor não tratá-lo como
  sucesso nem tentar de novo.
