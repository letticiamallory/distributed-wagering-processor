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
- **Regra irmã 1, no código (`WagerPolicy`):** WIN ou LOSS sobre uma BET já revertida é
  rejeitado com `REFERENCE_ALREADY_REVERSED`, para não pagar prêmio de aposta devolvida.
- **Regra irmã 2, no código (`WagerPolicy`):** REFUND ou ROLLBACK de uma BET que tem um WIN
  `PROCESSED` apontando para ela, e ainda não revertido, é rejeitado com `REFERENCE_SETTLED`.
  Sem isso, o jogador ficaria com o prêmio e com a aposta de volta. É o espelho da regra
  irmã 1: aquela impede o prêmio de uma aposta devolvida, esta impede devolver uma aposta
  já premiada.
  - LOSS não entra: BET + LOSS + REFUND dá zero, porque a LOSS não mexe no saldo.
  - Se o WIN for revertido (ROLLBACK do WIN `PROCESSED`), a BET volta a poder ser revertida.
  - **Liquidar quer dizer que o jogador recebeu dinheiro**, o mesmo critério da LOSS. Um WIN de
    `0.00` não liquida a BET (decisão de 26/11/2026): não paga nada, e um WIN de `0.00` nem pode
    ser revertido (o ROLLBACK exige valor maior que zero), então contá-lo travaria a BET para
    sempre sem que o jogador tivesse prêmio algum. Um WIN de `0.01` já liquida.
  - **O WIN sem referência também liquida** (decisão de 27/11/2026, achado de avaliação). O
    enunciado diz que o WIN "pode" referenciar a BET; quando não referencia, um WIN `PROCESSED` de
    valor maior que zero da **mesma wallet, do mesmo provedor e da mesma rodada** (`roundId`)
    liquida a BET do mesmo jeito. Antes só contava o WIN que apontava para ela, e o cenário
    BET 10,00 → WIN 30,00 sem referência → REFUND da BET passava: o jogador terminava com 130,00
    numa wallet de 100,00 (o prêmio e a aposta de volta). Teste:
    `test/integration/settled-without-reference.test.ts`. Um WIN que aponta para **outra** BET
    da rodada liquida aquela, não esta; um WIN de outro provedor numa rodada de mesmo nome não
    conta (o `roundId` é do provedor). O índice parcial `ix_wtx_round_wins` serve essa busca.
  - Só vale para REFUND e ROLLBACK de uma **BET**. Um ROLLBACK do próprio WIN, ou de um
    REFUND, não é bloqueado.
  - A política não consulta o banco: o caso de uso calcula `hasSettledWin` (existe WIN
    `PROCESSED` de valor maior que zero, sem reversão `PROCESSED` apontando para esse WIN, e com
    `reference_transaction_id` = BET ou, sem referência, da mesma wallet, provedor e rodada), do mesmo modo que calcula `alreadyReversed`. Na ordem das regras, vem logo
    depois de `REFERENCE_ALREADY_REVERSED` e antes da checagem de saldo. O código é de
    negócio, não retentável: o provedor desiste ou reverte o WIN primeiro.
- **Vários WINs para a mesma BET são permitidos** (decisão de 26/11/2026). Há jogos que
  pagam em partes e rodadas bônus que premiam a mesma aposta mais de uma vez, então não existe
  limite de quantidade nem de soma por BET. A segurança não vem de limitar os WINs, vem de duas
  coisas que já existem:
  - **Idempotência por id externo:** cada WIN tem o seu `(provider_id, external_transaction_id)`
    e a sua chave. Reenviar o MESMO WIN é replay e não paga de novo (ADR-0008); dois WINs com ids
    externos diferentes são dois prêmios diferentes, e cada um paga uma vez.
  - **`REFERENCE_SETTLED`:** enquanto existir QUALQUER WIN `PROCESSED` não revertido apontando
    para a BET, ela não pode ser revertida. Para reverter a BET é preciso reverter antes todos
    os WINs, um por um (cada um é uma reversão única, como qualquer transação).
  Por isso o índice `uq_wtx_reversed_once` não cobre WIN: ele só existe para REFUND e ROLLBACK.
- **Limite de tentativas com a referência pendente:** cada transação respeita o próprio limite
  de tentativas (`attemptsExhausted`). Se a referência ainda está em `PENDING_REFERENCE` e as
  tentativas da reversão acabaram, a política rejeita com `REFERENCE_NOT_PROCESSED` em vez de
  esperar. Sem isso, a espera dependeria de a outra transação terminar, e o limite de uma
  passaria a ser o da outra. Se a referência nem existe e as tentativas acabaram, o código é
  `REFERENCE_NOT_FOUND`.

## Alternativas consideradas
- `UNIQUE (reference_transaction_id, kind)`: cumpre o texto do enunciado,
  mas deixa passar REFUND seguido de ROLLBACK.
- Checar só no código: duas instâncias processando ao mesmo tempo passam pela checagem juntas.
- Deixar o ROLLBACK de uma BET premiada passar (o enunciado não proíbe): o jogador
  ficaria com o WIN e com a aposta de volta. Fechado pela regra irmã 2.
- Um WIN por BET (índice único): quebraria o pagamento em partes e as rodadas bônus, que são
  casos reais. O risco que ele cobriria (pagar e devolver a mesma aposta) já está fechado pela
  regra irmã 2.
- Esperar a referência pendente mesmo com as tentativas esgotadas: o limite de uma transação
  passaria a depender do limite da outra.

## Consequências
+ Cumpre o enunciado e fecha o buraco do REFUND + ROLLBACK.
+ Só PROCESSED conta: uma reversão REJECTED ou PENDING_REFERENCE não bloqueia
  uma nova tentativa válida (testado).
− A regra é mais rígida que o texto do enunciado e precisa ser explicada na apresentação.
− `REFERENCE_SETTLED` é um código a mais na taxonomia (categoria `business`, não retentável)
  que o enunciado não prevê; o caso de uso precisa calcular `hasSettledWin` sob o lock da
  wallet, para duas requisições não decidirem com a mesma foto do banco.
− Não há teto para a soma dos WINs de uma BET: o valor do prêmio é do provedor. Quem confere
  se o total pago faz sentido é o provedor; a reconciliação (ADR-0015) só confere saldo contra ledger e não avalia a soma dos prêmios.
− O caminho normal é o caso de uso de processamento (ADR-0007) recusar a segunda reversão como rejeição de negócio;
  o índice é a rede de segurança para bugs e corridas, não o fluxo principal.
