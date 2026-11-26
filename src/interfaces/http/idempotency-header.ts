import type { Request } from 'express';
import { InvalidCommandError } from '../../application/errors/application-errors.js';
import { FailureCode } from '../../domain/errors/failure-code.js';

const HEADER = 'idempotency-key';

// O valor do header Idempotency-Key, como veio. Aqui só há transporte: a validação do valor
// (obrigatório, não vazio, até 255 caracteres) é do caso de uso, para o canal SQS passar pela
// mesma regra.
//
// Uma exceção só existe em HTTP: o header REPETIDO. O Node junta cabeçalhos repetidos em
// "a, b", e então "duas chaves" seria indistinguível de uma chave que contém vírgula. Duas
// chaves para uma operação é ambíguo, e adivinhar qual vale poderia duplicar um débito.
export function idempotencyKeyOf(req: Request): string | undefined {
  const names = req.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && _value.toLowerCase() === HEADER,
  );
  if (names.length > 1) {
    const detail = {
      path: 'Idempotency-Key',
      message: 'must be sent only once',
    };
    throw new InvalidCommandError(
      FailureCode.InvalidPayload,
      `Invalid payload: ${detail.path}: ${detail.message}`,
      [detail],
    );
  }
  return req.header(HEADER);
}
