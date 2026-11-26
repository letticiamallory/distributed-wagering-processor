// Quantas rodadas cada teste de concorrência repete. O padrão é o do enunciado desta suíte (100
// rodadas do cenário da seção 8) e CONCURRENCY_ROUNDS o troca, por exemplo para 20 numa sabotagem,
// onde o erro aparece já nas primeiras rodadas. Os testes que nasceram com outro número (50, 10)
// escalam na mesma proporção: com 20, o de 50 vira 10 e o de 10 vira 2.
const DEFAULT_ROUNDS = 100;

function configured(): number {
  const raw = process.env.CONCURRENCY_ROUNDS?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_ROUNDS;
  }
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `CONCURRENCY_ROUNDS must be a positive integer (got "${raw}")`,
    );
  }
  return value;
}

// `base` é o número de rodadas do teste quando CONCURRENCY_ROUNDS vale 100.
export function rounds(base = DEFAULT_ROUNDS): number {
  return Math.max(1, Math.round((base * configured()) / DEFAULT_ROUNDS));
}
