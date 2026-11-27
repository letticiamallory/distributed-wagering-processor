import { z } from 'zod';
import { FailureCode } from '../../domain/errors/failure-code.js';
import { Money } from '../../domain/money/money.js';
import { InvalidMoneyError } from '../../domain/money/money.errors.js';
import {
  InvalidCommandError,
  type InvalidCommandDetail,
} from '../errors/application-errors.js';

export const MAX_TEXT_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const notBlank = (value: string) => value.trim() !== '';

// Caracteres de controle C0 (U+0000 a U+001F, inclusive o NUL, \t e \n), DEL e C1 (U+007F a U+009F).
// O NUL o PostgreSQL nem aceita num TEXT (08P01); os outros não têm lugar num identificador.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// Um surrogate alto sem o baixo depois, ou um baixo sem o alto antes (o que String.isWellFormed, do
// ES2024, recusaria; o tsconfig ainda não inclui essa lib).
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// Texto que pode ser guardado e logado: sem caractere de controle e UTF-16 bem formado (um surrogate
// isolado não é Unicode e o JSONB da outbox o recusa com 22P02). As mensagens são fixas: nunca
// repetem o valor recebido.
export const isStorableText = (value: string): boolean =>
  !LONE_SURROGATE.test(value) && !CONTROL_CHARACTER.test(value);
export const STORABLE_TEXT_MESSAGE =
  'must not contain control characters or invalid Unicode';

// Texto livre do provedor: não pode ser vazio nem branco, tem um teto de tamanho, e tem que poder
// ser guardado.
export const text = (max = MAX_TEXT_LENGTH) =>
  z
    .string()
    .max(max, `must have at most ${max} characters`)
    .refine(notBlank, 'must not be blank')
    .refine(isStorableText, STORABLE_TEXT_MESSAGE);

// walletId e playerId são colunas UUID: um valor que não seja UUID chegaria ao banco e
// viraria erro 22P02 (500). Aceita qualquer UUID (guid, não só os de versão RFC) e
// normaliza para minúsculas, que é como o Postgres devolve: sem isso a comparação da
// política (reference.walletId !== transaction.walletId) daria REFERENCE_MISMATCH falso.
export const uuid = z
  .guid('must be a UUID')
  .transform((value) => value.toLowerCase());

// O valor é lido como string. A moeda tem formato próprio (erro de payload); o valor em si
// é validado pelo Money (erro de valor).
export const moneyInput = z.object({
  amount: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be 3 uppercase letters'),
});

export function detailsOf(error: z.ZodError): InvalidCommandDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}

export function summarize(details: InvalidCommandDetail[]): string {
  return details.map((d) => `${d.path}: ${d.message}`).join('; ');
}

export function invalidPayload(
  details: InvalidCommandDetail[],
): InvalidCommandError {
  return new InvalidCommandError(
    FailureCode.InvalidPayload,
    `Invalid payload: ${summarize(details)}`,
    details,
  );
}

// Money.from recusa notação científica, mais de 2 casas, sinal, NaN e acima de 16 dígitos
// inteiros (tudo isso como InvalidMoneyError: o overflow só existe em add, não aqui).
export function toMoney(
  input: { amount: string; currency: string },
  path: string,
): Money {
  try {
    return Money.from(input);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      const details = [{ path: `${path}.amount`, message: error.message }];
      throw new InvalidCommandError(
        FailureCode.InvalidAmount,
        `Invalid amount: ${summarize(details)}`,
        details,
      );
    }
    throw error;
  }
}
