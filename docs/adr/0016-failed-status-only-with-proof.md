# ADR-0016: FAILED só com prova de que nenhuma tentativa foi transitória

## Contexto
O enunciado (6.3) define `FAILED` como "erro permanente de infraestrutura (terminal, auditável)". O
domínio e o schema já tinham o estado (terminal, travado pelo trigger do ADR-0004), mas nenhum
caminho o gravava: um erro permanente virava 500 sem linha no HTTP, ou só uma mensagem na DLQ.

O risco de gravar `FAILED` é transformar uma falha **passageira** em resultado **permanente**: uma
queda longa do banco esgota as 10 entregas da fila (cerca de 6 minutos, ADR-0011), e se a última
entrega gravasse `FAILED`, uma aposta válida ficaria morta para sempre (o `FAILED` é terminal, e a
mesma chave devolve sempre o mesmo resultado).

## Decisão

### 1. Dois gatilhos
- **Fila:** todas as entregas da mensagem falharam com um erro **permanente** e a última entrega
  permitida (`SQS_MAX_RECEIVE_COUNT`) chegou. Permanente é um erro de aplicação não reenviável
  (um bug, como `ConcurrentWalletUpdateError`) ou de domínio. Um `PermanentDataError` (o banco
  recusou o dado, ADR-0011) é determinístico: vira `FAILED` já na entrega em que aparece, desde que
  todas as anteriores também tenham sido falhas permanentes registradas.
- **HTTP:** só o `PermanentDataError`. Não há histórico de entregas para conferir, e o erro é
  determinístico. Um erro desconhecido no HTTP continua 500 **sem** gravar nada: o provedor reenvia
  a mesma chave, e depois da correção do bug o reenvio funciona.

### 2. A regra da prova: nunca gravar se qualquer tentativa foi transitória
Cada entrega que falha com erro permanente soma 1 em `consumer_delivery_failures`
(`(consumer_name, message_id)`, numa instrução própria, fora da transação de negócio). O consumidor
só grava `FAILED` quando esse total é **igual** ao `receiveCount` da entrega atual. Uma entrega sem
registro é **falta de prova**, e falta de prova nunca vira `FAILED`:
- a entrega falhou com o banco fora (`DEPENDENCY_UNAVAILABLE`): o transitório não soma nada, e o
  próprio registro também falharia;
- o registro da falha não passou (o banco caiu naquele instante);
- a mensagem voltou sem ter falhado (crash, SIGTERM, visibilidade vencida).

Um `Error` qualquer, que ninguém classificou, também não soma: pode ser um problema de rede. Na
dúvida, o `FAILED` não acontece e a mensagem vai para a DLQ (`RETRIES_EXHAUSTED`), de onde um
redrive depois da queda a processa normalmente.

### 3. Como é gravado
`ProcessWagerTransactionUseCase.fail()`: uma transação **separada** (a original foi desfeita),
**sob o lock da wallet** (ADR-0007), com:
- a transação em `FAILED`, `failure_code = PROCESSING_FAILED` (categoria `permanent`, não
  reenviável), sem `balance_after`, sem `processed_at`;
- **nenhum** saldo, ledger ou evento: a linha gravada é a auditoria (não há evento novo);
- a linha da inbox, quando veio da fila.

Se a chave já tem resultado (outra entrega terminou antes), devolve esse resultado: nunca
sobrescreve. Wallet inexistente não vira `FAILED` (`WALLET_NOT_FOUND`). Se o próprio `FAILED` não
grava (o dado ruim está na própria linha), a mensagem vai para a DLQ e o HTTP responde o 500
original.

### 4. O reenvio da mesma chave
Recebe sempre o `FAILED` gravado: **500** `INTERNAL_ERROR`, `retryable: false`, com o `failureCode`
e o `transactionId` (ADR-0009); na fila, ack com log `error` (ADR-0011). Depois de corrigir a
causa, o provedor reenvia com uma **chave nova**.

## Alternativas consideradas
- **Gravar `FAILED` em `RETRIES_EXHAUSTED`, qualquer que fosse o erro:** a queda longa do banco
  viraria `FAILED` permanente. É o risco que este ADR existe para evitar.
- **Guardar o histórico nas mensagens do SQS:** os atributos de uma mensagem não mudam entre
  entregas; o histórico precisa estar no banco.
- **Contar as falhas transitórias e exigir zero:** uma falha transitória com o banco fora não
  consegue ser registrada; contar as permanentes e exigir todas é o que funciona sem o banco.
- **Um evento `WagerTransactionFailed`:** recusado por ora; a linha é a auditoria.

## Consequências
+ O enunciado é cumprido: erro permanente de infraestrutura fica terminal e auditável.
+ A queda longa do banco nunca vira `FAILED` (teste: `test/integration/failed-status.test.ts`,
  "the consumer and a LONG database outage").
− Uma tabela a mais (`consumer_delivery_failures`) e uma instrução por falha permanente.
− Uma mensagem que voltou sem falhar (crash) nunca chega a `FAILED`: vai para a DLQ. É o lado
  conservador da regra.
