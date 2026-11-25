# ADR-0005: Reversão única por transação, de qualquer tipo
Status: Aceito · Data: 2026-11-25
## Contexto
O enunciado diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Mas um REFUND e depois um ROLLBACK da mesma BET devolveriam o dinheiro duas vezes.
## Decisão
Cada transação é revertida no máximo uma vez, por qualquer tipo. O índice único parcial `uq_wtx_reversed_once` em `wager_transactions (reference_transaction_id)`, `WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`, garante isso no banco.
## Alternativas consideradas
- `UNIQUE (reference_transaction_id, kind)`: cumpre o texto do enunciado, mas deixa passar REFUND seguido de ROLLBACK.
- Checar só no código: duas instâncias processando ao mesmo tempo passam pela checagem juntas.
## Consequências
+ Cumpre o enunciado e fecha o buraco; numa corrida, o banco decide e a segunda transação falha. Só PROCESSED conta, então uma reversão REJECTED ou PENDING_REFERENCE não bloqueia uma nova tentativa válida (testado).
− A regra é mais rígida que o enunciado e precisa ser explicada na apresentação. O caso de uso (Fase 3) recusa a segunda reversão como rejeição de negócio; o índice é a rede de segurança, não o caminho normal.
