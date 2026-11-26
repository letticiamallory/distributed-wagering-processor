# ADR-0001: Arquitetura hexagonal em 4 camadas
Status: Aceito · Data: 2026-11-25
## Contexto
O domínio (Money, Wallet, ledger) tem invariantes que não podem depender de framework, e o enunciado exige que HTTP e consumidor SQS reutilizem o mesmo caso de uso.
## Decisão
Hexagonal simples: `domain` ← `application` ← `infrastructure` e `interfaces`; as dependências apontam para dentro. O domínio não importa Nest, MikroORM nem AWS SDK (única exceção: `decimal.js` em `domain/money`). Os casos de uso definem as portas e `infrastructure` as implementa. Controller e consumidor chamam o mesmo `ProcessWagerTransactionUseCase`.
## Alternativas consideradas
- Camadas padrão do Nest (controller/service/repository): mistura regra de negócio com ORM e dificulta testar invariantes.
- DDD completo (agregados, bus de comandos): cerimônia demais para o prazo.
## Consequências
+ O domínio é testado sem banco nem Nest. − Mais arquivos (portas, mappers) e a fronteira é conferida por `bun run check:money` (que roda no CI): `src/domain` e `src/application` não podem importar Nest, MikroORM nem o AWS SDK (a aplicação pode usar `zod`).
− Armadilha na borda: o Nest injeta pelo metadado do construtor, então um `import type` no controller passa em `typecheck` e `lint` e só quebra na subida. Usar import de valor; `test/integration/health.test.ts` sobe o `AppModule` e falha se isso acontecer (verificado).
