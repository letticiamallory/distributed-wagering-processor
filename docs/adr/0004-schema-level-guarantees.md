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
  **PENDING só existe num INSERT:** o mesmo trigger recusa qualquer UPDATE que leve a
  PENDING, de qualquer estado (inclusive de PENDING e de PENDING_REFERENCE). A transação é
  decidida antes de ser gravada, então nenhum código grava PENDING; se uma linha o tem, nasceu
  num INSERT, e o banco garante que nada a devolve a esse estado. A espera por uma referência
  é PENDING_REFERENCE → PENDING_REFERENCE (attempts e next_attempt_at), que continua
  permitida. Transições aceitas por UPDATE: PENDING → PENDING_REFERENCE | PROCESSED |
  REJECTED | FAILED; PENDING_REFERENCE → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED;
  dos três finais, nenhuma. A ordem dentro da função importa: o estado final é recusado
  primeiro (`is terminal`), depois a volta a PENDING (`cannot be updated to PENDING`).
  `FAILED` é gravado só com a prova de que nenhuma tentativa foi transitória (ADR-0016), num
  INSERT já final; o trigger o trava como os outros estados finais.
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

- **Saldo ↔ ledger (constraint diferida, achado de avaliação):** `trg_wallet_balance_has_ledger`
  é uma constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets` (INSERT e UPDATE de
  `balance` ou `version`). No COMMIT, confere o estado FINAL da wallet: existe o lançamento da versão
  atual, e o `balance_after` dele é o saldo; a única wallet sem lançamento é a que nasceu zerada e
  nunca mudou (versão 1, saldo 0). Diferida porque, na operação, o UPDATE da wallet vem antes do
  INSERT do lançamento, na mesma transação, e um CHECK não enxerga outra tabela. Recusa (23514) um
  UPDATE cru do saldo, uma versão pulada e uma wallet que nasce com saldo sem a OPENING. Não confere a
  corrente inteira nem o vínculo do lançamento com a transação: isso continua com a reconciliação.
  Os testes que adulteram o banco de propósito usam `session_replication_role = replica`
  (`test/support/tamper.ts`), que desliga os triggers só naquela transação.

## Consequências
+ O banco recusa o que o código esquecer, e cada regra tem um teste que tenta violá-la.
+ Um teste revelou que `amount > 0` fora de WIN/LOSS deixava passar WIN negativo,
  o que gerou o `ck_wtx_amount_non_negative`.
− Direção inválida gera uma mensagem menos específica (cita a aritmética).
− Um superusuário pode desligar os triggers: eles protegem contra bug, não contra administrador.
− O ledger não aceita DELETE, então os testes usam UUIDs novos e recriam o schema a cada execução.
− A constraint diferida saldo ↔ ledger **não foi implementada**. No lugar dela, o `FOR UPDATE`, a versão e o `UNIQUE (wallet_id, wallet_version)` protegem a escrita (ADR-0007), e a reconciliação somente leitura (ADR-0015) confere o saldo contra o ledger sob demanda: ela detecta, não impede.
− A regra do PENDING mora na função do trigger (`forbid_terminal_change`, recriada por
  `CREATE OR REPLACE` na migration `wtx_pending_only_on_insert`); o `down` dela devolve a
  função anterior, e o teste de migrations desce e sobe só esse passo.
