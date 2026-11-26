-- Roda uma única vez, quando o volume do Postgres é criado do zero
-- (docker-entrypoint-initdb.d). O banco de desenvolvimento ("wallet") já é criado
-- pela variável POSTGRES_DB.
--
-- Os testes usam este banco separado: a Fase 1 recria o schema a cada execução, e isso
-- nunca pode encostar no banco de desenvolvimento.
CREATE DATABASE wallet_test;

-- Só o banco de testes: o COMMIT não espera o fsync do WAL. No Docker do Windows cada
-- transação que grava custa ~129 ms com o fsync e ~4 ms sem ele (medido em 26/11/2026), e
-- a suíte faz centenas delas. Um teste não precisa sobreviver a uma queda de energia do
-- servidor. É uma configuração POR BANCO: "wallet" (desenvolvimento) e qualquer ambiente
-- real continuam duráveis. Um banco novo não herda isto; o teste de migrations aplica o
-- mesmo ajuste ao banco descartável que cria (wallet_migrations_test).
ALTER DATABASE wallet_test SET synchronous_commit = off;
