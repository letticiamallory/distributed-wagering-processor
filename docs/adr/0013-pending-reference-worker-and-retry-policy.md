# ADR-0013: Worker de `PENDING_REFERENCE` e a política de retentativa

Status: Aceito · Data: 2026-11-26

## Contexto
Um `REFUND`, `ROLLBACK` ou `WIN` pode chegar **antes** da transação que referencia (provedores
mandam operações relacionadas por canais diferentes, e a fila não ordena entre wallets nem entre
HTTP e SQS). O sistema o grava como `PENDING_REFERENCE` (ack imediato: a transação está segura no
banco) e, a partir daí, **quem cuida dele é o worker, não o SQS**. O worker precisa resolver essas
transações quando a referência chega, sem dois workers no mesmo item, e desistir de forma
auditável quando ela nunca chega.

## Decisão

### 1. Política: 10 tentativas no total, backoff `min(2^n × 1 s, 5 min)` (511 s)
A **primeira gravação** como `PENDING_REFERENCE` conta como a 1ª tentativa. Com os padrões
(10 tentativas, base 1 s, teto 5 min) são 9 esperas: `1+2+4+8+16+32+64+128+256 = 511 s`, cerca de
**8,5 minutos**. Provedores mandam operações relacionadas em segundos; 8,5 min cobrem uma
instabilidade de fila ou de rede sem deixar dinheiro "pendurado" por horas. Depois da última
tentativa, sem referência: `REJECTED` com `REFERENCE_NOT_FOUND` e o evento
`WagerTransactionRejected` (o PENDING nunca vira "para sempre pendente"). Os valores vêm de
`PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_DELAY_MS` e `PENDING_REFERENCE_MAX_DELAY_MS`,
validados na subida (o `PendingReferenceSchedule`, do domínio). A conta com 10 tentativas é a de cima.

### 2. Dois mecanismos de acordar
- **O atalho:** quando uma BET é processada, `wakePendingReferences` marca
  `next_attempt_at = agora` nas pendentes da **mesma wallet** que esperam por ela (sob o lock da
  wallet). O worker as resolve no próximo ciclo (em até 1 s), sem esperar o backoff.
- **O agendamento:** se o acordar não acontece (a referência chegou por outra wallet, ou o evento
  se perdeu), o próprio `next_attempt_at` da pendente vence e o worker a pega. Há um teste do
  "acordar perdido".

### 3. Como dois workers não pegam o mesmo item: reserva com lease, sem o lock da wallet
Cada ciclo (a cada 1 s) **reserva** um lote numa instrução só:

```sql
UPDATE wager_transactions SET next_attempt_at = agora + lease
 WHERE id IN (SELECT id FROM wager_transactions
               WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= agora
               ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
RETURNING id, wallet_id
```
O lease (30 s) é "o item é seu até aqui". Se o worker morre, o lease vence e outro assume (teste).
Para cada item reservado, o worker chama o **mesmo** `ResolvePendingReferenceUseCase` do fluxo de processamento,
que **trava a wallet, relê a transação sob o lock e só então decide**. Wallets diferentes em
paralelo; a mesma wallet em sequência.

**Relação com o ADR-0007.** A reserva escreve sem o lock da wallet, e isso está previsto na regra
do ADR-0007: *toda decisão de estado ou de dinheiro acontece sob o lock da wallet; colunas só de
agendamento (`next_attempt_at`) podem ser escritas sem ele, porque toda decisão relê sob o lock*.
A reserva nunca decide nada. O pior caso (um acordar e uma reserva se sobrescrevendo) é um item
processado duas vezes, e o segundo lê `NOT_PENDING`.

### 4. Falha de infraestrutura não gasta tentativa
Se o banco falha durante a resolução, nada foi gravado: a tentativa **não** é contada, o worker
registra `pending_resolve_failed` e o item volta quando o lease vence. Um item que falha sempre
fica nesse laço (a cada ~30 s), visível no log.

### 5. Ligar e desligar
`PENDING_WORKER_ENABLED` (padrão `true`), `PENDING_WORKER_BATCH_SIZE` (20),
`PENDING_WORKER_POLL_INTERVAL_MS` (1000), `PENDING_WORKER_LEASE_MS` (30000; mínimo 1 s) e
`PENDING_WORKER_SHUTDOWN_TIMEOUT_MS`. Nos testes nasce **desligado**. No SIGTERM a resolução em
andamento termina; o que ainda não começou fica para o lease vencer (não há pressa).

## Alternativas consideradas
- **Não reservar** (só o lock da wallet): correto, porque o resolvedor relê, mas dois workers
  fariam o mesmo trabalho e o segundo esperaria o lock à toa.
- **Reservar com a linha travada durante a resolução** (`FOR UPDATE` numa transação longa):
  prenderia a linha enquanto o resolvedor, em outra conexão, tenta atualizá-la (deadlock de
  aplicação).
- **Resolver só pelo atalho (sem agendamento)**: um acordar perdido deixaria a transação pendente
  para sempre.
- **Tentativas ilimitadas**: dinheiro parado indefinidamente; a rejeição auditável é melhor.

## Consequências
+ REFUND/ROLLBACK antes da BET viram `PROCESSED` em segundos, ou `REJECTED` (auditado e com
  evento) em ~8,5 min; dois workers nunca colidem; um worker morto não prende nada além do lease.
− A reserva é a única escrita sem o lock da wallet (limitada à coluna de agendamento e coberta
  por teste); um item que falha sempre é repetido a cada lease; um lease curto demais geraria
  trabalho repetido (por isso o mínimo de 1 s).
