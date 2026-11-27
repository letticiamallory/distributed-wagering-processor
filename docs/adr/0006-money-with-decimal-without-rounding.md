# ADR-0006: Money com Decimal, sem arredondamento

Status: Aceito · Data: 2026-11-25

## Contexto
O enunciado proíbe `number`, `float` e `double` para dinheiro e pede `amount` como string
decimal com escala fixa de 2 casas (`"25.00"`). O esqueleto da seção 6.1 já guarda o valor
num `Decimal`. O motivo da proibição é concreto: em ponto flutuante, `0.1 + 0.2` dá
`0.30000000000000004`, e um saldo que acumula milhares de apostas deixaria de bater com o
ledger, centavo a centavo.

## Decisão
`Money` é um value object imutável sobre `decimal.js`, e a biblioteca só aparece dentro de
`src/domain/money/`. O resto do sistema enxerga `Money` e `MoneyProps` (strings), nunca `Decimal`.

Três cuidados, todos no código e todos com teste:

1. **Validar a string antes de criar o Decimal.** O `decimal.js` aceita `"1e5"`, `"NaN"` e
   `"Infinity"`. A regex `^(0|[1-9][0-9]{0,15})\.[0-9]{2}$` roda primeiro, então só entram
   valores como `"25.00"`: sem espaço, sem notação científica, sem sinal, com 2 casas exatas.
2. **Nunca arredondar, nem completar.** A escala é fixa, então 2 casas exatas: mais de 2 é erro
   (`"10.005"` não vira `"10.01"`) e menos de 2 também (`"10.5"` não vira `"10.50"`; o
   contrato é `"10.50"`). Um valor que o provedor não mandou não pode virar dinheiro de alguém. A saída usa `toFixed(2)`, nunca
   `toString()`, que pode devolver notação científica.
3. **Um Decimal só nosso.** `Decimal.clone({ precision: 40 })` isola a configuração: não
   mexemos no `Decimal` global e não dependemos da precisão padrão (20 dígitos).

**O saldo observado é sempre o da wallet, na moeda da wallet.** `balance_after`, em toda
transação e em todo replay, é o saldo da WALLET quando a transação foi decidida, e o `Money`
correspondente está na moeda da wallet. Não existe caso especial: na imensa maioria dos casos a
moeda da wallet e a da transação coincidem; elas diferem só quando o provedor manda outra moeda
e a transação é rejeitada com `CURRENCY_MISMATCH`. A transação continua gravada como o provedor
mandou (`amount` e `currency` em USD, por exemplo), e `balance_after` guarda o saldo da wallet
(BRL). A coluna é `NUMERIC` sem moeda própria, então a moeda vem da wallet (imutável) na
leitura. O domínio não confere a moeda do saldo observado, porque a transação não conhece a da
wallet: o único limite é não ser negativo.

O que os testes provaram, além do esperado:

- **O zero negado.** No `decimal.js`, `new Decimal(0).negated()` é `-0`: serializa como
  `"0.00"`, mas `isNegative()` responde `true`. Sem tratamento, um saldo ou valor zero seria
  tratado como negativo. `Money.isNegative()` exige `!isZero()`, e o teste confere
  `negate()` de zero: `isZero()` verdadeiro, `isNegative()` falso, texto `"0.00"`.
- **O teto de 16 dígitos inteiros.** A regex de entrada aceita até 16 dígitos, mas `add`
  poderia somar além disso. O banco guarda `NUMERIC(20,2)` (18 dígitos inteiros), e um valor
  maior que 16 não passaria mais pela regex ao ser lido de volta. Então o teto vale também
  nas operações: somar além dele lança `MoneyOverflowError`, e os resultados negativos têm o
  mesmo limite (testado em `9999999999999999.99 + 0.01` e na subtração equivalente).
  No fluxo de negócio o `MoneyOverflowError` nunca chega a acontecer: antes de creditar, a política
  pergunta `wallet.canCredit(money)` e, se o crédito passaria do teto, rejeita a transação com
  `BALANCE_LIMIT_EXCEEDED` (422, `REJECTED`, gravada e com o evento `WagerTransactionRejected`), o
  espelho do `INSUFFICIENT_FUNDS`. **O `initialBalance` tem o mesmo teto**, e nenhum a mais: uma
  wallet pode nascer em `9999999999999999.99`, e a partir daí as apostas funcionam e os créditos
  são rejeitados de forma auditável. Uma folga extra na criação não resolveria nada (a wallet
  chegaria ao teto por créditos do mesmo jeito) e seria uma segunda regra para explicar.

Duas verificações automáticas mantêm isso de pé (`bun run check:money`, também coberta pelos
testes): conversão numérica (`parseFloat`, `parseInt`, `Number`, `.toFixed`) em linha que fala
de `amount`, `balance` ou `money` fora de `src/domain/money/` falha, e importar `decimal.js`
fora dessa pasta também. O mesmo script falha se `src/domain` importar `@nestjs`,
`@mikro-orm` ou `@aws-sdk`, o que transforma o ADR-0001 em verificação.

## Alternativas consideradas
- **`number`:** proibido pelo enunciado e impreciso (`0.1 + 0.2`).
- **Inteiros em centavos (`number` ou `bigint`):** exatos, mas empurram a conversão `× 100` para
  todas as bordas (HTTP, SQS, banco), e o contrato é string com ponto. Um erro de escala
  (`2500` lido como `25.00`) seria silencioso. O esqueleto do enunciado também usa `Decimal`.
- **Outra biblioteca (`big.js`, `dinero.js`):** `decimal.js` já está no esqueleto do enunciado e
  tem tudo o que precisamos. Trocar traria dependência nova sem ganho.
- **Arredondar com uma regra (meio para cima, bancário):** esconderia um erro do provedor e
  exigiria uma regra de negócio que ninguém pediu. Rejeitar é mais seguro e testável.

## Consequências
+ Soma, subtração e comparação exatas; o saldo sempre bate com o ledger.
+ O erro aparece na borda (valor inválido), não como um centavo faltando semanas depois.
+ O domínio continua sem `Decimal` vazando: trocar a biblioteca mexe numa pasta só.
− O teto de 16 dígitos inteiros é uma regra nossa, mais estrita que o `NUMERIC(20,2)` do
  banco; precisa constar na documentação da API.
− `check:money` é uma heurística de linha: pega o descuido comum (`parseFloat(amount)`),
  mas não prova que não existe `number` em nenhum lugar. A revisão e o `Money` fechado
  (construtor privado, instância congelada) cobrem o resto.
− Multi-moeda com escalas diferentes (JPY sem centavos) não é suportado: todas as moedas
  usam 2 casas. Aceitável porque o desafio assume BRL, mas é um limite conhecido.

## Adendo: a moeda é da ISO-4217
A moeda não é só "3 letras maiúsculas": tem que estar na lista ISO-4217 vigente, fixa no domínio
(`src/domain/money/iso-4217.ts`). O `Money` recusa o resto (`InvalidMoneyError`), e a entrada da
API e da fila responde 400 `INVALID_PAYLOAD`, na wallet e na transação. Um teste compara a lista
com `Intl.supportedValuesOf('currency')`: toda moeda nossa existe lá (pega erro de digitação), e
as históricas que o Intl ainda conhece (DEM, FRF, HRK, ANG...) não estão na nossa. Uma moeda
válida que não é a da wallet continua sendo `422 CURRENCY_MISMATCH`.
