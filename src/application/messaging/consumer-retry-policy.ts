export interface ConsumerRetryOptions {
  // Quantas entregas a mensagem pode ter antes de ir para a DLQ (a última inclusive).
  maxReceiveCount: number;
  // A espera depois da falha de ordem n é base * 2^n, até o teto.
  baseSeconds: number;
  maxSeconds: number;
}

// A política de tentativas do consumidor (ADR-0011). Pura: só números, nada de SQS.
//
//   espera depois da falha n = min(2^n x base, teto)      (base 2 s, teto 60 s)
//   n = 1: 4 s, 2: 8 s, 3: 16 s, 4: 32 s, 5 em diante: 60 s
//
// Com 10 entregas são 9 esperas (4+8+16+32+5x60 = 360 s, uns 6 min) antes da DLQ: o bastante
// para sobreviver a uma queda curta do banco, sem prender a fila da wallet por horas.
export class ConsumerRetryPolicy {
  constructor(readonly options: ConsumerRetryOptions) {}

  delaySeconds(receiveCount: number): number {
    // O expoente é limitado: 2^1000 seria Infinity, e Infinity x 0 seria NaN.
    const exponent = Math.min(Math.max(receiveCount, 0), 30);
    return Math.min(
      2 ** exponent * this.options.baseSeconds,
      this.options.maxSeconds,
    );
  }

  // `receiveCount` é a entrega que acabou de falhar: na última permitida, não há próxima.
  isExhausted(receiveCount: number): boolean {
    return receiveCount >= this.options.maxReceiveCount;
  }
}
