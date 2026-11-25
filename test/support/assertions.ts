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
