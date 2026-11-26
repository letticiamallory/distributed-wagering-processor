# ADR-0007: Lock pessimista por wallet

Status: Proposto · Data: 2026-11-25

## Contexto
Várias instâncias da aplicação (e vários consumidores SQS) podem debitar a mesma wallet ao
mesmo tempo. Sem coordenação, duas BETs de 60,00 numa wallet de 100,00 leem o mesmo saldo,
as duas passam na regra e o saldo vai para -20,00. O enunciado exige que o saldo nunca fique
negativo e que nenhum retry duplique um débito.

## Decisão
Cada operação financeira roda numa única transação `READ COMMITTED` e **trava a linha da
wallet** com `SELECT ... FOR UPDATE` antes de decidir qualquer coisa.

- **Como:** `em.transactional(...)` do MikroORM abre a transação, e a leitura da wallet usa
  `LockMode.PESSIMISTIC_WRITE`. Logo depois do `BEGIN`, `SET LOCAL lock_timeout = '5s'`
  vale só para essa transação.
- **Uma wallet por transação.** O caso de uso trava só a wallet da operação, então duas
  transações nunca esperam uma pela outra em ciclo: não há deadlock por desenho. A referência
  de uma reversão é lida sem lock (ela pertence à mesma wallet, ou a política a recusa com
  `REFERENCE_MISMATCH` antes de usar o que leu).
- **Duas barreiras atrás do lock**, para o caso de um bug no código:
  `UPDATE wallets ... WHERE id = $1 AND version = $esperada` precisa afetar exatamente 1 linha,
  e `CHECK (balance >= 0)` recusa o saldo negativo no banco (ADR-0004).
- **Timeout:** se o lock não sai em 5s (`55P03`), a operação falha como transitória
  (`DEPENDENCY_UNAVAILABLE`, 503 com `Retry-After`) sem gravar nada. O provedor reenvia a
  mesma chave com segurança, por causa da idempotência (ADR-0008).
- **Pool:** pelo menos 20 conexões e no máximo 1s de espera por uma conexão livre, ambos por
  variável de ambiente. Com o pool cheio o erro é o mesmo 503, não uma fila infinita.
- **Gravação explícita.** A transação e as gravações dentro dela usam `em.transactional` e o
  lock do MikroORM, mas os `INSERT` e `UPDATE` são `nativeInsert` e `nativeUpdate`, em vez do
  identity map com `flush`. Motivos:
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
