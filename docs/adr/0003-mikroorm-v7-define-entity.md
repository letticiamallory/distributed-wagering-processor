# ADR-0003: MikroORM v7 com `defineEntity` fora do domínio
Status: Aceito · Data: 2026-11-25
## Contexto
O enunciado prefere MikroORM, e o domínio não pode conhecer o ORM (ADR-0001). O projeto roda no Bun 1.4.5 com Nest 12 em ESM.
## Decisão
MikroORM v7 com `defineEntity`, sem decorators: o mapeamento vive em `infrastructure/persistence` e mappers convertem entre entidade de domínio e linha. `core`, `postgresql`, `migrations` e `cli` fixados em `7.2.12`; `@mikro-orm/nestjs` 7.1.0 (aceita Nest `^11 || ^12`). Migrations são SQL escrito à mão, sem arquivos `.snapshot`.
Spike (25/11): Nest 12 + MikroORM 7.2.12 sobem no Bun; `migration:up` e `migration:down` rodam e revertem; `nest start` também sobe no Node 26, então o Bun não é obrigatório.
## Alternativas consideradas
- Decorators do ORM nas classes de domínio: acopla o domínio ao ORM e quebra as regras do ADR-0001.
- SQL cru sem ORM: perde unit of work e mapeamento de entidades.
## Consequências
+ Domínio puro e testável. − Camada extra de mappers e a v7 é recente; o pin exato evita surpresa em `bun install`.
