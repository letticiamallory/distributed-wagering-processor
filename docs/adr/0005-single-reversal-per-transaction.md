# ADR-0005: Reversão única por transação, de qualquer tipo

Status: Aceito · Data: 2026-11-25

## Contexto
O enunciado diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação".
Mas um REFUND e depois um ROLLBACK da mesma BET devolveriam o dinheiro duas vezes:
BET de 25,00 → REFUND +25,00 → ROLLBACK da BET +25,00, e o jogador ganha 25,00 do nada.

## Decisão
Cada transação é revertida no máximo uma vez, por qualquer tipo. O índice único parcial
`uq_wtx_reversed_once` em `wager_transactions (reference_transaction_id)`,
`WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`, garante isso no banco.

- Um ROLLBACK de um REFUND continua permitido: a referência dele é o REFUND, não a BET.
  Depois disso, a BET não pode ser reembolsada de novo, porque o REFUND original segue PROCESSED.
- Regra irmã, no código (`WagerPolicy`): WIN ou LOSS sobre uma BET já revertida é rejeitado
  com `REFERENCE_ALREADY_REVERSED`, para não pagar prêmio de aposta devolvida.

## Alternativas consideradas
- `UNIQUE (reference_transaction_id, kind)`: cumpre o texto do enunciado,
  mas deixa passar REFUND seguido de ROLLBACK.
- Checar só no código: duas instâncias processando ao mesmo tempo passam pela checagem juntas.

## Consequências
+ Cumpre o enunciado e fecha o buraco do REFUND + ROLLBACK.
+ Só PROCESSED conta: uma reversão REJECTED ou PENDING_REFERENCE não bloqueia
  uma nova tentativa válida (testado).
− A regra é mais rígida que o texto do enunciado e precisa ser explicada na apresentação.
− O caminho normal é o caso de uso (Fase 3) recusar a segunda reversão como rejeição de negócio;
  o índice é a rede de segurança para bugs e corridas, não o fluxo principal.
