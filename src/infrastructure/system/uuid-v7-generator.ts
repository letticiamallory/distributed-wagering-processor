import { IdGenerator } from '../../application/ports/id-generator.js';

// UUID v7: ordenável por tempo (índices melhores) e no formato dos exemplos do enunciado.
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
