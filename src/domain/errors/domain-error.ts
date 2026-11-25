// Base de todo erro de regra de negócio. O nome da classe vira o `name`, para o log e os
// testes dizerem qual regra caiu sem depender do texto da mensagem.
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
