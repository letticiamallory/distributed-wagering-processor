# ADR-0004: Garantias no schema (constraints e triggers)
Status: Aceito · Data: 2026-11-25
## Contexto
O enunciado exige que unicidade, imutabilidade e saldo não negativo estejam no schema. Se o código tiver um bug, o banco deve recusar o dado em vez de corromper o saldo.
## Decisão
Constraints nomeadas (`ck_`, `uq_`, `fk_`, `pk_`) para o erro dizer qual regra caiu, e triggers: `balance >= 0`; `UNIQUE` em `idempotency_key` e em `(provider_id, external_transaction_id)`; trigger de estados terminais (sem `UPDATE` em PROCESSED/REJECTED/FAILED, sem `DELETE`); ledger append-only (triggers por linha e por comando, para o `TRUNCATE`), aritmética `balance_before ± amount = balance_after`, FK `(wallet_id, currency)` e `UNIQUE (wallet_id, wallet_version)`; PK `(consumer_name, message_id)` na inbox. `amount` só pode ser 0 em WIN e LOSS (`ck_wtx_positive_amount`), porque o ledger exige `amount > 0`: valor 0 não gera lançamento.
Sem FK de moeda entre `wager_transactions` e `wallets`: CURRENCY_MISMATCH e REFERENCE_MISMATCH são gravadas como REJECTED com a moeda que o provedor mandou, e a FK as impediria. O caso de uso confere provider, jogador, wallet, moeda e rodada da referência.
Sem `ck_ledger_direction`: a aritmética já só aceita DEBIT e CREDIT (verificado: com direção inválida o erro cita `ck_ledger_arithmetic`, que vem antes na ordem alfabética).
## Alternativas consideradas
- Validar só no código: um bug ou uma corrida entre instâncias grava o dado errado.
## Consequências
+ O banco recusa o que o código esquecer, e cada regra tem teste que a viola. − Direção inválida gera uma mensagem de erro menos específica (cita a aritmética). Um superusuário pode desligar os triggers (`ALTER TABLE ... DISABLE TRIGGER`): protegem contra bug, não contra administrador mal-intencionado. O ledger não aceita `DELETE`, então os testes usam UUIDs novos e recriam o schema a cada execução. A constraint diferida saldo ↔ ledger fica para uma migration 5, depois da Fase 3.
