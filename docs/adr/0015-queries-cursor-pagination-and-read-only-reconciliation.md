# ADR-0015: Consultas, paginação por cursor e reconciliação somente leitura

Status: Aceito · Data: 2026-11-26

## Contexto
O enunciado (seção 9) pede quatro consultas (`GET /wallets/:id`, `GET /wallets/:id/ledger` com
cursor "estável e opaco", `GET /wagering/transactions/:id` e a mesma transação pela chave do
provedor) e a reconciliação `POST /wallets/:id/reconciliation`: saldo guardado contra o saldo
reconstruído pelo ledger, com divergência **logada, contabilizada em métrica e sinalizada na
resposta, nunca corrigida em silêncio**.

## Decisão

### 1. Quatro consultas, todas atrás do `ProviderAuthGuard`
| Rota | 200 | Erros |
| --- | --- | --- |
| `GET /wallets/:walletId` | `id`, `playerId`, `balance`, `version` (a mesma forma do `POST /wallets`) | 400 id inválido, 404 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | `{ items[], nextCursor }` | 400 cursor ou limite inválido, 404 |
| `GET /wagering/transactions/:transactionId` | a transação: status, `failureCode`, `balance` (o saldo da época) | 400, 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | idem, pela chave do provedor | 400, 404 |

- Parâmetros de rota e de query chegam como **texto** e são validados **na aplicação**: um id que não
  é UUID é 400, nunca um erro 22P02 do banco virando 500. **400 vem antes de 404**: um parâmetro
  malformado não se esconde atrás de "não existe".
- Uma transação gravada é um recurso que existe em **qualquer status**: `REJECTED`,
  `PENDING_REFERENCE` e `FAILED` (ADR-0016) são **200** com o status no corpo (o 422 e o 202 são respostas da
  *submissão*, não do recurso). O corpo omite o que é interno (chave de idempotência, hash,
  `correlationId`, jogador).
- O `ProviderAuthGuard` agora também confere o **`:providerId` da rota** (403 se o token não pode
  agir como ele), além do `providerId` do corpo (ver o adendo do ADR-0010). As outras consultas
  (por id) não nomeiam provedor: só exigem credencial, como o resto do negócio.

### 2. Paginação do extrato: cursor opaco sobre `wallet_version`
- Ordem: `wallet_version` **decrescente** (o mais novo primeiro). A consulta é
  `WHERE wallet_id = $1 AND wallet_version < $cursor ORDER BY wallet_version DESC LIMIT $limit + 1`;
  o `+1` diz se existe próxima página, sem uma segunda consulta de contagem.
- **Por que `wallet_version` e não OFFSET:** é único por wallet (`uq_ledger_wallet_version`) e só
  cresce. "As versões menores que esta" é uma fronteira que **não se mexe quando chegam lançamentos
  novos** (eles entram do lado de cima): nenhuma entrada aparece duas vezes nem some entre páginas.
  Com OFFSET, três lançamentos novos empurrariam três velhos para a página seguinte. Há um teste com
  lançamentos chegando entre duas páginas.
- **Opaco e versionado:** `base64url(JSON { v: 1, walletVersion })`. O cliente só devolve o que
  recebeu; se o formato mudar, sobe o `v` e os cursores antigos viram 400 em vez de uma página
  errada. Cursor inválido (lixo, JSON que não é objeto, `v` desconhecido, versão não inteira, zero,
  negativa ou maior que o INTEGER do Postgres, texto longo demais) é **400 que nomeia o campo
  `cursor` e nunca repete o que veio**.
- `limit`: padrão **50**, máximo **100**; fora disso (0, negativo, fracionário, texto) é 400.

### 3. Reconciliação: `REPEATABLE READ` + `READ ONLY`, sem lock
`POST /wallets/:id/reconciliation` abre uma transação **`REPEATABLE READ READ ONLY`**, lê o saldo
guardado da wallet e, numa consulta SQL, a soma `CREDIT − DEBIT`, quantos lançamentos há e se a
corrente fecha (`LAG(balance_after)` e `LAG(wallet_version)`):

| Por que | Explicação |
| --- | --- |
| `REPEATABLE READ` | o saldo e o ledger saem do **mesmo instante**. Em `READ COMMITTED`, uma aposta que commitasse entre as duas leituras acusaria uma divergência que não existe. (O fluxo de aposta usa `READ COMMITTED` e o lock da wallet, ADR-0007: lá a garantia é o lock; aqui não há lock, a garantia é o snapshot.) |
| `READ ONLY` | o banco **recusa qualquer escrita** nesta transação: a reconciliação não consegue corrigir nada, nem por bug. |
| sem lock | conferir uma wallet nunca atrasa uma aposta, nem o contrário (há um teste com a wallet travada por outra operação e outro com escritas concorrentes). |

A **diferença é calculada pelo banco** (`NUMERIC`), em string com 2 casas, e pode ser **negativa**
(o ledger tem mais do que o saldo guardado); a aplicação não faz conta de dinheiro com ela. A
resposta segue o enunciado (`walletId`, `storedBalance`, `calculatedBalance`, `difference`,
`consistent`, `checkedEntries`) mais `findings`, a lista do que está errado:
- `balance_mismatch`: saldo guardado ≠ saldo reconstruído;
- `ledger_gap`: algum lançamento não parte de onde o anterior parou, as versões não são
  consecutivas, ou a versão guardada na wallet não é a do último lançamento;
- `negative_balance`: saldo guardado negativo (o `CHECK` do banco impede; o teste cobre a decisão).

**Nunca corrige.** Correção de dinheiro é decisão humana e auditada. Divergência vira: (1) a
resposta (`consistent: false`, **200**, porque a consulta funcionou e o achado está no corpo), (2) um
log de nível **`error`** `reconciliation_divergence` com `walletId`, os `findings` e quantos
lançamentos foram conferidos, e (3) métricas. **O log não leva valor nenhum** (nem o saldo, nem a
diferença; ADR-0014): quem precisa deles os tem na resposta, com credencial.

### 4. As métricas da reconciliação (fecha o item 4 do ADR-0014)
`ReconcileWalletUseCase` chama `reportReconciliation()`:
- `wallet_reconciliation_runs_total{result}`: `clean`, `divergent`, `failed` (o banco caiu);
- `wallet_reconciliation_divergences{kind}` (gauge): a **última** execução, por tipo;
- **`wallet_reconciliation_divergences_total{kind}` (contador, novo)**: o total. **É este que
  alerta** (`increase()`): com a reconciliação por wallet, uma conferência limpa de *outra* wallet
  zeraria o gauge e esconderia uma divergência já encontrada; o total nunca volta atrás;
- `wallet_reconciliation_last_run_timestamp_seconds`.
Uma execução que **falha** só conta a falha: não zera nem avança nada.

### 5. Duas pequenas coisas da observabilidade que ficaram para esta fase
- **`pending_reference_transactions`** (gauge, lido na raspagem): quantas transações esperam a
  referência. É a métrica que diz se o worker (ADR-0013) está dando conta.
- **Readiness durante o encerramento:** ao receber o SIGTERM/SIGINT o `/health/ready` passa a
  `503 {"status":"shutting_down"}` **no primeiro instante** (o `HealthService` registra o ouvinte do
  sinal no próprio ciclo de vida), enquanto o `/health/live` segue 200. Assim o balanceador tira a
  instância de rotação enquanto ela termina o que está em andamento (ADR-0011). Um teste com um
  processo real e um SIGTERM de verdade (só Linux) confere os dois endpoints durante o encerramento.

## Alternativas consideradas
- **Paginar por OFFSET/LIMIT** ou por `created_at`: a primeira repete e perde entradas quando chegam
  lançamentos; a segunda tem empates. `wallet_version` não tem nenhum dos dois problemas.
- **Cursor em texto claro** (`?beforeVersion=42`): prende o contrato ao formato interno.
- **Reconciliar em `READ COMMITTED` ou com `SELECT ... FOR UPDATE`**: o primeiro dá falso positivo
  sob carga; o segundo atrasa as apostas daquela wallet.
- **Reconciliação que corrige** (por exemplo, recalcular o saldo): esconderia o bug que causou a
  divergência e mexeria em dinheiro sem auditoria.
- **Só o gauge** para a divergência: some quando a próxima conferência é limpa.
- **Devolver 409 ou 500 quando há divergência**: o `POST` é uma consulta; quem decide o que fazer
  com o achado é quem chamou.

## Consequências
+ Extrato estável sob escrita concorrente; reconciliação que não trava nem escreve e não dá falso
  alarme sob carga; divergência visível na resposta, no log e na métrica sem vazar valor; consultas
  atrás do mesmo guard do resto.
− A reconciliação confere **uma wallet por chamada**: não existe varredura de todas as wallets (o
  gauge `wallet_reconciliation_divergences` fica pronto para uma, se um dia houver). A diferença
  negativa sai como `"-2.50"` na mesma forma `MoneyProps` (a entrada de dinheiro continua não
  aceitando sinal). O `GET` por id não confere o dono da wallet: a autenticação real (ADR-0010) é
  quem decidirá quem pode ler o quê.
