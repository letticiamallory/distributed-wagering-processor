-- Roda uma única vez, quando o volume do Postgres é criado do zero
-- (docker-entrypoint-initdb.d). O banco de desenvolvimento ("wallet") já é criado
-- pela variável POSTGRES_DB.
--
-- Os testes usam este banco separado: a Fase 1 recria o schema a cada execução, e isso
-- nunca pode encostar no banco de desenvolvimento.
CREATE DATABASE wallet_test;
