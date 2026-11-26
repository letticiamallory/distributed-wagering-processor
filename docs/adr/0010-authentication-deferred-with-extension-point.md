# ADR-0010: Autenticação adiada, com ponto de extensão

Status: Aceito · Data: 2026-11-27

## Contexto
O enunciado (seção 2) deixa a autenticação a cargo do candidato e diz que ela **não vale pontos**
na avaliação. Também diz que, se a implementarmos, a expectativa é integrar um Identity Provider
externo, nunca escrever autenticação artesanal (nada de tabela própria de usuários com hash de
senha). Se não a implementarmos, é aceito, desde que a decisão seja documentada, o desenho que
adotaríamos seja descrito e o ponto de extensão fique explícito no código. O escopo é restrito: os
endpoints de health ficam abertos, e as mensagens vindas da fila são um canal interno confiável,
mas o `providerId` contido nelas continua sujeito às mesmas validações de domínio.

O prazo é curto, e o que vale nota (correção financeira, concorrência, idempotência) disputa o
mesmo tempo.

## Decisão
**Não implementamos a autenticação agora.** Ela não vale pontos e competiria com o essencial.
Deixamos, no lugar dela, um **ponto de extensão** pequeno, testado e com a forma final:

- **`ProviderIdentityPort`** (aplicação): `identify(credential) → ProviderIdentity`, e a
  identidade responde `mayActAs(providerId)`. Credencial ausente ou inválida lança
  `UnauthenticatedError` (401). A aplicação só enxerga esta porta.
- **`UnrestrictedProviderIdentityPort`** (infraestrutura): a implementação **de hoje**, que aceita
  qualquer credencial, inclusive nenhuma, e deixa agir como qualquer provedor.
- **`ProviderAuthGuard`** (interfaces): aplicado nos controllers de **negócio** (`POST /wallets` e
  `POST /wagering/transactions`) e **não** no `/health`. Extrai o token `Bearer`, chama a porta e,
  quando o corpo traz um `providerId`, exige que a identidade possa agir como ele (senão 403
  `PROVIDER_FORBIDDEN`). Autenticar vem antes de validar o corpo (401 antes de 400).
- Um teste percorre **todos os controllers registrados** e falha se algum, exceto o de health,
  estiver sem o guard (as consultas da Fase 8 entraram sob essa regra; o `/metrics` é aberto como o health, ver o adendo da Fase 7).
- Os casos de uso **não** conhecem identidade. A validação do `providerId` (não vazio, até 200
  caracteres, texto) mora no comando, então vale igual para HTTP e SQS.

### O desenho que adotaríamos
- **Provedor de identidade:** Keycloak, no Docker Compose do projeto (OIDC completo e o mais
  comum no mercado). Zitadel ou qualquer IdP equivalente serve.
- **Fluxo:** *client credentials*, um *client* por provedor de jogos. Os provedores são sistemas, não
  pessoas: não há login interativo.
- **Token:** JWT assinado (RS256), validado a cada requisição **localmente**, pelas chaves do
  **JWKS** do IdP (com cache e rotação): assinatura, `iss`, `aud`, `exp` e `nbf`, com lista
  fechada de algoritmos e tolerância de relógio curta. Nada de chamar o IdP por requisição.
- **Claim de provedor:** um *protocol mapper* do Keycloak põe o `providerId` do *client* no token
  (por exemplo `provider_id`). A identidade devolvida pela porta carrega esse conjunto.
- **Regra de autorização:** o `providerId` do **corpo** tem que bater com o do **token**. Se não
  bater, **403**, antes de qualquer leitura do banco: um provedor não consegue operar nem fazer
  replay no nome de outro. Token inválido, ausente ou expirado é **401** (`WWW-Authenticate: Bearer`),
  com a mesma mensagem para qualquer motivo.
- **Criação de wallet (`POST /wallets`) em produção:** o corpo não traz `providerId`, então a
  regra "o provedor do corpo bate com o do token" não se aplica. Hoje qualquer identidade válida
  pode criar wallet (e, com o no-op, qualquer cliente). **Em produção a criação seria restrita à
  plataforma**, com um escopo próprio no token (por exemplo `wallet:create`), e não a qualquer
  provedor de jogos: quem cria a conta do jogador é o sistema que o cadastra, não o provedor que
  só envia apostas. A identidade ganharia um método de escopo (por exemplo `hasScope`) e o guard
  da rota de wallet o exigiria; os provedores receberiam só o escopo de transações.
- **Consultas** (implementado na Fase 8, ver o adendo ao fim): o guard compara o `:providerId` da
  rota com a identidade, igual ao corpo.
- **Trocar a implementação:** uma classe nova que estende `ProviderIdentityPort` (a que lê o
  JWKS, com a biblioteca `jose`), ligada no módulo no lugar da `Unrestricted...`, mais a configuração
  (emissor, audiência, URL do JWKS) validada na subida como as demais variáveis. **Nenhum caso de
  uso, controller ou guard muda.**
- **SQS:** canal interno confiável. A mensagem não leva token e a porta não participa; o
  `providerId` dela passa pela mesma validação do comando. Se um dia a fila deixar de ser
  confiável, o produtor assina a mensagem e a mesma porta ganha um segundo método.

## Alternativas consideradas
- **Implementar já:** Keycloak no Compose, mapper, JWKS e testes custariam horas que a nota não
  paga, e adiantariam pouco o que o avaliador mede.
- **Chave de API por provedor numa tabela:** é o desvio mais curto, mas é autenticação artesanal
  (rotação, armazenamento do segredo, revogação), exatamente o que o enunciado desaconselha.
- **mTLS entre provedor e serviço:** forte, mas empurra a identidade para a borda de rede e para
  quem opera os certificados; não deixa o `providerId` como um dado da aplicação.
- **Guard global em vez de por controller:** exigiria excluir o health por exceção; o desenho
  atual deixa a regra explícita e testada em cada controller.
- **Checar o `providerId` dentro do caso de uso:** misturaria quem chama com o que o provedor
  pode fazer, e o canal SQS (sem token) teria de contorná-lo.

## Consequências
+ O ponto de extensão existe, tem a forma final e está provado por teste (401, 403, health aberto,
  e "nenhum controller sem guard"), com uma identidade de teste no lugar do IdP.
+ A configuração padrão (a do `docker compose`) atende `POST /wallets` e `POST /wagering/transactions`
  **sem** header `Authorization`, e um teste prova isso e falha se o compose ganhar variáveis de
  autenticação: o avaliador roda os exemplos do README sem token.
+ Trocar o no-op pelo IdP real é uma classe e uma configuração; o resto do sistema não muda.
− **Hoje qualquer cliente que alcance a API pode agir como qualquer provedor.** O serviço **não
  deve ser exposto** fora de uma rede confiável até a implementação real entrar.
− O 403 por `providerId` só protege o que o corpo declara: as consultas de leitura herdam a
  mesma regra quando forem escritas, e o teste de "todo controller tem guard" é o que garante isso.

## Adendo (Fase 7, ADR-0014): `/metrics` também é aberto
O `GET /metrics` fica aberto como o `/health`: quem o raspa (o Prometheus) não é um provedor e não
tem token. Só expõe contagens e latências, nunca um valor, uma wallet ou um jogador (há um teste). O
teste que percorre todos os controllers agora aceita sem o guard **só** o de health e o de métricas.
Num ambiente real, o `/metrics` ficaria numa porta ou rede internas.

## Adendo (Fase 8, ADR-0015): o guard também confere o `:providerId` da rota
O `ProviderAuthGuard` compara o `providerId` do **corpo** com o que o token pode representar (403 se
não puder). Com as consultas, ele passou a conferir também o `:providerId` da **rota**
(`GET /providers/:providerId/wagering/transactions/:externalId`): um token do provedor A não lê as
transações do provedor B. As consultas por id (`/wallets/:id`, `/wagering/transactions/:id`) não
nomeiam provedor e só exigem credencial. O teste que percorre todos os controllers continua exigindo
o guard em todos, menos health e metrics.
