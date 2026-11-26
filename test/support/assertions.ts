import { expect } from 'bun:test';

// Espera que o Postgres recuse a operação e que o erro cite a constraint (ou o trigger)
// esperada. Assim o teste só passa pelo motivo certo, não por qualquer outro erro de SQL.
export async function expectViolation(
  operation: Promise<unknown>,
  constraint: string,
): Promise<void> {
  const outcome = await operation.then(
    () => 'accepted',
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  expect(outcome).not.toBe('accepted');
  expect(outcome).toContain(constraint);
}

// Devolve o erro com que a operação foi rejeitada (e falha se ela deu certo). Existe para
// não usar `await expect(promise).rejects...`, que o lint marca como await de não-Promise.
// O teste afirma sobre o erro devolvido (classe, campos, mensagem).
export async function rejectionOf(
  operation: Promise<unknown>,
): Promise<unknown> {
  const outcome = await operation.then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  if (!outcome.rejected) {
    throw new Error('Expected the operation to be rejected, but it resolved');
  }
  return outcome.error;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
