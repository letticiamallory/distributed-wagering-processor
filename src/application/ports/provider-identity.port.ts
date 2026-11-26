// QUEM está chamando, dito pelo que o transporte trouxe (hoje, o token Bearer do HTTP). É a
// costura da autenticação (enunciado, seção 2): a aplicação só enxerga esta porta, então trocar a
// implementação que aceita tudo pelo provedor de identidade real (ADR-0010) não mexe em nenhum
// caso de uso, nem em controller, nem no guard.
//
// Não confundir com a validação do `providerId` dos casos de uso: aquela vale para TODO canal
// (HTTP e SQS) e é de domínio. Esta é só a pergunta "quem é você?", e só o canal HTTP a faz.
export abstract class ProviderIdentity {
  // O chamador pode agir em nome deste provedor? (O `providerId` do corpo tem que ser um deles.)
  abstract mayActAs(providerId: string): boolean;
}

export abstract class ProviderIdentityPort {
  // `credential` é o token Bearer sem o prefixo, ou undefined quando a requisição não trouxe um.
  // Credencial ausente, inválida ou expirada: lança UnauthenticatedError (401). Nunca devolve
  // "ninguém": ou há uma identidade, ou há um erro.
  abstract identify(credential: string | undefined): Promise<ProviderIdentity>;
}
