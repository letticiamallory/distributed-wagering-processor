export class InvalidEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface IntegerVariable {
  name: string;
  fallback: number;
  min: number;
  max: number;
}

// Só dígitos: recusa "1.5", "-3", "1e3", "0x10" e "10 s", que o Number() aceitaria ou
// arredondaria em silêncio.
const PLAIN_INTEGER = /^[0-9]+$/;

// Lê um inteiro de uma variável de ambiente. Vazia ou em branco (uma linha em branco no .env)
// vale como não definida. Um valor inválido derruba a subida da aplicação dizendo QUAL variável
// é: melhor parar na partida do que descobrir um limite errado com tráfego real.
export function readIntegerVariable(
  env: NodeJS.ProcessEnv,
  variable: IntegerVariable,
): number {
  const raw = env[variable.name]?.trim();
  if (raw === undefined || raw === '') {
    return variable.fallback;
  }
  const value = Number(raw);
  if (!PLAIN_INTEGER.test(raw) || !Number.isSafeInteger(value)) {
    throw new InvalidEnvironmentError(
      `${variable.name} must be a plain integer (got "${raw}")`,
    );
  }
  if (value < variable.min || value > variable.max) {
    throw new InvalidEnvironmentError(
      `${variable.name} must be between ${variable.min} and ${variable.max} (got ${value})`,
    );
  }
  return value;
}
