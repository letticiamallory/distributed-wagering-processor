# ADR-0004: Garantias no schema (constraints e triggers)

Status: Aceito · Data: 2026-11-25

## Contexto
O enunciado exige unicidade, imutabilidade e saldo não negativo no schema.
Se o código tiver um bug, o banco deve recusar o dado em vez de corromper o saldo.

## Decisão
Toda constraint tem nome (`ck_`, `uq_`, `fk_`, `pk_`), para o erro dizer qual regra caiu.

- **wallets:** `balance >= 0`; uma wallet por `(player_id, currency)`.
- **wager_transactions:** `UNIQUE` em `idempotency_key` e em `(provider_id, external_transaction_id)`;
  `amount >= 0`, e só WIN e LOSS podem ter valor 0; trigger que trava UPDATE em PROCESSED,
  REJECTED e FAILED e recusa qualquer DELETE. A reversão única está no ADR-0005.
- **wallet_ledger_entries:** append-only (trigger por linha e trigger por comando para o TRUNCATE);
  aritmética `balance_before ± amount = balance_after`; `amount > 0`;
  FK `(wallet_id, currency)`; `UNIQUE (wallet_id, wallet_version)`.
- **inbox_messages:** PK `(consumer_name, message_id)`.

## Alternativas consideradas
- **Validar só no código:** um bug ou uma corrida entre instâncias grava o dado errado.
- **FK de moeda entre transação e wallet:** descartada. CURRENCY_MISMATCH e REFERENCE_MISMATCH
  precisam ser gravadas como REJECTED com a moeda que o provedor mandou, e a FK impediria isso.
  O caso de uso confere provider, jogador, wallet, moeda e rodada da referência.
- **`ck_ledger_direction`:** removida. A aritmética já só aceita DEBIT e CREDIT
  (verificado: com direção inválida, o erro cita `ck_ledger_arithmetic`).

## Consequências
+ O banco recusa o que o código esquecer, e cada regra tem um teste que tenta violá-la.
+ Um teste revelou que `amount > 0` fora de WIN/LOSS deixava passar WIN negativo,
  o que gerou o `ck_wtx_amount_non_negative`.
− Direção inválida gera uma mensagem menos específica (cita a aritmética).
− Um superusuário pode desligar os triggers: eles protegem contra bug, não contra administrador.
− O ledger não aceita DELETE, então os testes usam UUIDs novos e recriam o schema a cada execução.
− A constraint diferida saldo ↔ ledger fica para uma migration 5, depois da Fase 3.
