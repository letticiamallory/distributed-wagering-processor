# Distributed Wagering Processor
Carteira de apostas que processa transações vindas de HTTP e SQS, feita com NestJS, PostgreSQL e MikroORM rodando no Bun.
Suba com `docker compose up -d` e confira em `GET http://localhost:3000/health/live`. Testes: `bun test` (com `postgres sqs queues-init` rodando). Decisões de arquitetura: [docs/adr](docs/adr/README.md).
