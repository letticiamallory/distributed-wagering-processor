import { invalidPayload, text, uuid } from '../commands/command-parsing.js';

// Os parâmetros de rota e de query string chegam como TEXTO: a validação mora na aplicação, então
// um id que não é UUID é 400 e nunca chega ao banco (onde viraria um erro 22P02 e um 500).
export function parseUuidParam(value: unknown, path: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) {
    throw invalidPayload([{ path, message: 'must be a UUID' }]);
  }
  return parsed.data;
}

export function parseTextParam(value: unknown, path: string): string {
  const parsed = text().safeParse(value);
  if (!parsed.success) {
    throw invalidPayload([
      { path, message: 'must be non-blank text of at most 200 characters' },
    ]);
  }
  return parsed.data;
}
