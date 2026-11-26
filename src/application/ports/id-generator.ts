// Gerador de ids injetado (UUID v7 na infraestrutura). O domínio recebe o id por parâmetro.
export abstract class IdGenerator {
  abstract next(): string;
}
