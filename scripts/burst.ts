// `bun scripts/burst.ts`: uma rajada maior que o pool, contra uma app já no ar (o compose, por
// padrão). WALLETS wallets distintas (padrão 30) recebem BETS apostas de 30.00 cada (padrão 5), todas
// ao mesmo tempo e SEM reenvio: 150 requisições para 20 conexões. Mede os 503 e a latência; depois
// reenvia só os 503 até passarem e confere que toda wallet terminou certa (100.00 - 3 x 30.00 = 10.00,
// as outras duas BETs rejeitadas por saldo) e consistente com o ledger.
//
// Para refazer a tabela do ARCHITECTURE.md (seção 5.2), suba a app com cada valor e rode o script:
//   DB_ACQUIRE_TIMEOUT_MS=1000 docker compose up -d --wait app
//   bun scripts/burst.ts
const BASE = process.env.BASE ?? 'http://localhost:3000';
const WALLETS = Number(process.env.WALLETS ?? 30);
const BETS = Number(process.env.BETS ?? 5);
const RUN = `${Date.now()}`;
let sequence = 0;

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const wallets = await Promise.all(
  Array.from({ length: WALLETS }, async () => {
    const playerId = crypto.randomUUID();
    const created = await post('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    if (created.status !== 201) throw new Error(`wallet: ${created.status}`);
    return { walletId: String(created.body.id), playerId };
  }),
);

const bets = wallets.flatMap((wallet) =>
  Array.from({ length: BETS }, () => {
    const externalTransactionId = `burst-${RUN}-${++sequence}`;
    return {
      key: `provider-burst:${externalTransactionId}`,
      body: {
        providerId: 'provider-burst',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'burst',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    };
  }),
);
const submit = (bet: (typeof bets)[number]) =>
  post('/wagering/transactions', bet.body, { 'Idempotency-Key': bet.key });

const started = performance.now();
const first = await Promise.all(
  bets.map(async (bet) => {
    const t0 = performance.now();
    const response = await submit(bet);
    return { status: response.status, ms: performance.now() - t0 };
  }),
);
const totalMs = performance.now() - started;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? 0,
  );
};
const statuses: Record<number, number> = {};
for (const { status } of first) statuses[status] = (statuses[status] ?? 0) + 1;

let pending = bets.filter((_, i) => first[i]?.status === 503);
let retryRounds = 0;
while (pending.length > 0 && retryRounds < 30) {
  retryRounds++;
  const again = await Promise.all(pending.map(submit));
  pending = pending.filter((_, i) => again[i]?.status === 503);
  await Bun.sleep(300);
}

let walletsWrong = 0;
for (const wallet of wallets) {
  const view = (await (
    await fetch(`${BASE}/wallets/${wallet.walletId}`)
  ).json()) as {
    balance: { amount: string };
  };
  const reconciliation = await post(
    `/wallets/${wallet.walletId}/reconciliation`,
    {},
  );
  if (
    view.balance.amount !== '10.00' ||
    reconciliation.body.consistent !== true
  )
    walletsWrong++;
}

const latencies = first.map((r) => r.ms);
console.log(
  JSON.stringify({
    requests: bets.length,
    statuses,
    totalMs: Math.round(totalMs),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    retryRounds,
    stillFailing: pending.length,
    walletsWrong,
  }),
);
if (walletsWrong > 0 || pending.length > 0) process.exit(1);
