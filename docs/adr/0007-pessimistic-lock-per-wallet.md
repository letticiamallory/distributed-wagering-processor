# ADR-0007: Lock pessimista por wallet

Status: Aceito · Data: 2026-11-25

## Contexto
Várias instâncias da aplicação (e vários consumidores SQS) podem debitar a mesma wallet ao
mesmo tempo. Sem coordenação, duas BETs de 60,00 numa wallet de 100,00 leem o mesmo saldo,
as duas passam na regra e o saldo vai para -20,00. O enunciado exige que o saldo nunca fique
negativo e que nenhum retry duplique um débito.

## Decisão
Cada operação financeira roda numa única transação `READ COMMITTED` e **trava a linha da
wallet** com `SELECT ... FOR UPDATE` antes de decidir qualquer coisa.

- **Como:** `em.transactional(...)` do MikroORM abre a transação, e a leitura da wallet usa
  `LockMode.PESSIMISTIC_WRITE`. O SQL real, capturado do MikroORM, é: `start transaction
  isolation level read committed`; `SET LOCAL lock_timeout = 5000` (em milissegundos, vale só
  para essa transação e morre no `COMMIT`); `select ... from "wallets" ... for update`; `commit`.
- **Uma wallet por transação.** O caso de uso trava só a wallet da operação, então duas
  transações nunca esperam uma pela outra em ciclo: não há deadlock por desenho. A referência
  de uma reversão é lida sem lock, e isso é seguro por uma regra que vale para o sistema todo:
  **toda gravação em `wager_transactions` de uma wallet acontece com o lock dessa wallet**,
  inclusive a do worker de `PENDING_REFERENCE` (Fase 5). Como a referência pertence à mesma
  wallet, quem tem o lock a vê estável: ninguém pode mudá-la enquanto a decisão é tomada. Se
  ela pertencer a outra wallet, nada a protege, mas a política a recusa com
  `REFERENCE_MISMATCH` antes de usar o que leu. Quem quebrar essa regra (gravar numa wallet
  sem o lock dela) quebra o ADR.
  Dois casos já seguem a regra, e os dois escrevem em `wager_transactions` de uma wallet:
  1. **Resolver uma PENDING_REFERENCE** (`ResolvePendingReferenceUseCase`) trava a wallet da
     transação pendente, **relê a pendente sob o lock** (outro worker pode tê-la resolvido
     entre a primeira leitura e o lock) e só então decide e grava.
  2. **Acordar as pendentes** quando a referência é processada
     (`wakePendingReferences(provider, walletId, referência, agora)`) é um UPDATE em
     `wager_transactions`: por isso filtra pela **mesma wallet** que quem chama já travou.
     Uma pendente de outra wallet que espera o mesmo id externo **não** é acordada, porque não
     temos o lock dela; ela tenta no próprio backoff e vira `REFERENCE_MISMATCH` na vez dela.
- **Duas barreiras atrás do lock**, para o caso de um bug no código:
  `UPDATE wallets ... WHERE id = $1 AND version = $esperada` precisa afetar exatamente 1 linha,
  e `CHECK (balance >= 0)` recusa o saldo negativo no banco (ADR-0004).
- **Timeout:** se o lock não sai em 5s (`55P03`), a operação falha como transitória
  (`DEPENDENCY_UNAVAILABLE`, 503 com `Retry-After`) sem gravar nada. O provedor reenvia a
  mesma chave com segurança, por causa da idempotência (ADR-0008).
- **Pool:** até 20 conexões por padrão (mínimo de 2) e no máximo 1s de espera por uma conexão
  livre, por `DB_POOL_MIN`, `DB_POOL_MAX` e `DB_ACQUIRE_TIMEOUT_MS`. Com o pool cheio o erro é
  o mesmo 503, não uma fila infinita. O `lock_timeout` de 5s é uma opção do `UnitOfWork`
  (`lockTimeoutMs`); a variável de ambiente que o configura entra com o módulo do Nest.
- **Gravação explícita.** A transação e as gravações dentro dela usam `em.transactional` e o
  lock do MikroORM, mas os `INSERT` e `UPDATE` são `em.insert` e `em.nativeUpdate` (no v7 não
  existe `nativeInsert`), em vez do identity map com `flush`. Motivos:
  1. A ordem das gravações é a ordem das FKs e do trigger de estado final (a transação já
     nasce no estado final, depois o saldo, depois o ledger). Um `flush` decide a ordem sozinho.
  2. O `UPDATE ... AND version` precisa confirmar 1 linha afetada; o identity map esconde isso.
  3. O ledger é append-only: só existe `INSERT`. Uma entidade rastreada poderia gerar `UPDATE`
     sem querermos.
  4. As classes de domínio não são as entidades do MikroORM (ADR-0003). O mapeamento é
     explícito, nos dois sentidos (`rehydrate`), sem o ORM tocar o domínio.

## Alternativas consideradas
- **Lock otimista com retry** (só `version`): numa wallet muito usada quase toda tentativa
  conflita e refaz o trabalho. A versão fica como segunda barreira, não como mecanismo.
- **`SERIALIZABLE`:** o banco detecta o conflito, mas devolve erros de serialização que o
  código precisa repetir, e o custo cai em toda operação, não só nas concorrentes.
- **Advisory lock:** funciona, mas trava por um número que o banco não relaciona às linhas;
  o `FOR UPDATE` já é o lock certo, preso à própria linha.
- **Serializar por fila (um consumidor por wallet):** resolve o SQS, mas não o HTTP, e
  empurra a garantia para fora do banco.

## Consequências
+ Fácil de provar correto: quem tem o lock vê o saldo final, e o teste de concorrência
  (Fase 4) confere o saldo contra o ledger.
+ Sem deadlock por desenho, e o timeout vira um 503 que o provedor sabe tratar.
− Operações na mesma wallet são serializadas. É o comportamento desejado, mas o limite de
  vazão de uma wallet muito quente é o de uma transação por vez.
− O 503 por `lock_timeout` precisa de uma métrica (`lock_conflicts_total`) para o limite de 5s
  ser ajustado com medição (Fase 7).
− Escrever `INSERT` e `UPDATE` à mão tira do MikroORM o rastreamento de mudanças: cada
  gravação nova é um método do repositório, com teste contra o Postgres real.
