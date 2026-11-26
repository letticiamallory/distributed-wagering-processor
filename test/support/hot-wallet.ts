import type { Json } from './http-app.js';
import {
  assertWalletIsConsistent,
  describeFacts,
  failIfAny,
  walletFacts,
  type SqlFn,
} from './ledger-check.js';
import {
  mapLimit,
  type ClientResponse,
  ProviderClient,
} from './provider-client.js';

// Gerador pseudoaleatório com semente: a ordem do disparo muda a cada rodada, mas uma falha pode
// ser repetida com a mesma semente.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (amount: string): bigint => BigInt(amount.replace('.', ''));
const money = (value: bigint): string => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

interface Operation {
  tag: string;
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
  amount: string;
  external: string;
  reference?: string;
  // O que muda no saldo SE a operação terminar PROCESSED (em centavos).
  effect: bigint;
}

export interface HotWalletOptions {
  urls: string[];
  sql: SqlFn;
  client: ProviderClient;
  // Os erros que o servidor registrou (para mostrar o sintoma de uma sabotagem).
  errorNames: () => Record<string, number>;
  seed?: number;
}

export interface HotWalletResult {
  walletId: string;
  requests: number;
  processed: number;
  rejected: number;
  pending: number;
  seed: number;
}

const INITIAL = '1000.00';
const SETUP_REFERENCES = 60; // BETs de 10.00 que servem de referência
const NEW_BETS = 150;
const WINS = 40; // sobre as referências 0..39
const REFUNDS = 20; // 2 por referência, sobre as referências 40..49
const ROLLBACKS_OF_BETS = 10; // referências 50..59
const ROLLBACKS_OF_WINS = 10; // dos WINs das referências 0..9 (podem chegar ANTES do WIN)

// Centenas de operações misturadas (BET, WIN, REFUND, ROLLBACK, e algumas que se atropelam)
// disparadas AO MESMO TEMPO sobre UMA wallet. O resultado de cada uma depende da ordem em que o
// lock a deixa passar (uma BET pode ou não achar saldo), então o teste não prevê quem ganha: ele
// confere o que TEM de ser verdade em qualquer ordem.
export async function runHotWallet(
  options: HotWalletOptions,
): Promise<HotWalletResult> {
  const { urls, sql, client } = options;
  const seed = options.seed ?? Date.now() & 0xffffffff;
  const random = prng(seed);
  const run = Bun.randomUUIDv7().slice(-8);
  const ext = (name: string) => `hot-${run}-${name}`;
  const at = (index: number) => urls[index % urls.length] as string;

  // O preparo da wallet não entra nas métricas de carga: cliente à parte.
  const wallet = await new ProviderClient().createWallet(at(0), INITIAL);
  const body = (op: Operation): Json => ({
    providerId: 'provider-a',
    externalTransactionId: op.external,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'hot-round',
    gameId: 'hot-game',
    kind: op.kind,
    money: { amount: op.amount, currency: 'BRL' },
    ...(op.reference && { referenceExternalTransactionId: op.reference }),
  });

  // ---- 1. as referências (BETs de 10.00), enviadas com um pouco de paralelismo
  const setup: Operation[] = Array.from(
    { length: SETUP_REFERENCES },
    (_, i) => ({
      tag: `setup-${i}`,
      kind: 'BET',
      amount: '10.00',
      external: ext(`ref-${i}`),
      effect: -cents('10.00'),
    }),
  );
  const setupResponses = await mapLimit(setup, 10, (op, i) =>
    client.submit(at(i), body(op)),
  );
  const setupFailures = setupResponses
    .map((response, i) => ({ response, op: setup[i] as Operation }))
    .filter(({ response }) => response.status !== 201);
  failIfAny(
    'hot wallet setup (a BET of 10.00 on 1000.00 must be processed)',
    setup.length,
    setupFailures.map(
      ({ op, response }) =>
        `${op.tag}: ${response.status} ${response.text.slice(0, 120)}`,
    ),
    { errors: options.errorNames() },
  );

  // ---- 2. as operações concorrentes
  const ops: Operation[] = [];
  const betAmounts = ['5.00', '10.00', '25.00', '40.00'];
  for (let i = 0; i < NEW_BETS; i++) {
    const amount = betAmounts[
      Math.floor(random() * betAmounts.length)
    ] as string;
    ops.push({
      tag: `bet-${i}`,
      kind: 'BET',
      amount,
      external: ext(`bet-${i}`),
      effect: -cents(amount),
    });
  }
  for (let i = 0; i < WINS; i++) {
    ops.push({
      tag: `win-${i}`,
      kind: 'WIN',
      amount: '30.00',
      external: ext(`win-${i}`),
      reference: ext(`ref-${i}`),
      effect: cents('30.00'),
    });
  }
  for (let i = 0; i < REFUNDS; i++) {
    const reference = 40 + (i % 10); // dois REFUNDs por referência: só um pode valer
    ops.push({
      tag: `refund-${i}`,
      kind: 'REFUND',
      amount: '10.00',
      external: ext(`refund-${i}`),
      reference: ext(`ref-${reference}`),
      effect: cents('10.00'),
    });
  }
  for (let i = 0; i < ROLLBACKS_OF_BETS; i++) {
    ops.push({
      tag: `rollback-bet-${i}`,
      kind: 'ROLLBACK',
      amount: '10.00',
      external: ext(`rollback-bet-${i}`),
      reference: ext(`ref-${50 + i}`),
      effect: cents('10.00'),
    });
  }
  for (let i = 0; i < ROLLBACKS_OF_WINS; i++) {
    ops.push({
      tag: `rollback-win-${i}`,
      kind: 'ROLLBACK',
      amount: '30.00',
      external: ext(`rollback-win-${i}`),
      reference: ext(`win-${i}`),
      effect: -cents('30.00'),
    });
  }
  // Embaralha: a ordem de chegada nunca é a de criação (um ROLLBACK pode chegar antes do WIN).
  for (let i = ops.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ops[i], ops[j]] = [ops[j] as Operation, ops[i] as Operation];
  }

  const responses = await Promise.all(
    ops.map((op, i) => client.submit(at(i), body(op))),
  );

  // ---- 3. o que TEM de ser verdade em qualquer ordem
  const problems: string[] = [];
  const total = setup.length + ops.length;
  const pairs = ops.map((op, i) => ({
    op,
    response: responses[i] as ClientResponse,
  }));

  let processed = 0;
  let rejected = 0;
  let pending = 0;
  let expected =
    cents(INITIAL) + setup.reduce((sum, op) => sum + op.effect, 0n);
  for (const { op, response } of pairs) {
    const status = response.body?.status;
    if (
      response.status >= 500 ||
      ![200, 201, 202, 422].includes(response.status)
    ) {
      problems.push(
        `${op.tag}: HTTP ${response.status} ${response.text.slice(0, 160)}`,
      );
      continue;
    }
    if (status === 'PROCESSED') {
      processed++;
      expected += op.effect;
    } else if (status === 'REJECTED') {
      rejected++;
    } else if (status === 'PENDING_REFERENCE') {
      pending++;
    } else {
      problems.push(`${op.tag}: unexpected status ${String(status)}`);
    }
  }

  const facts = await walletFacts(sql, wallet.id);
  if (facts.balance.startsWith('-')) {
    problems.push(`NEGATIVE balance ${facts.balance}`);
  }
  if (facts.balance !== money(expected)) {
    problems.push(
      `final balance ${facts.balance} but the results the provider saw add up to ${money(expected)} (a lost update or a double apply)`,
    );
  }
  // Cada requisição (e cada reenvio) deixou UMA linha: reenviar nunca duplica.
  const rows = (
    await sql(
      "SELECT count(*)::int AS rows, count(DISTINCT idempotency_key)::int AS keys FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
      [wallet.id],
    )
  )[0] as { rows: number; keys: number };
  if (rows.rows !== total || rows.keys !== total) {
    problems.push(
      `${rows.rows} transaction rows / ${rows.keys} keys for ${total} requests`,
    );
  }
  // Todo PROCESSED moveu o saldo EXATAMENTE uma vez: o ledger tem OPENING + referências + eles.
  const expectedEntries = 1 + SETUP_REFERENCES + processed;
  if (facts.entries !== expectedEntries) {
    problems.push(
      `ledger has ${facts.entries} entries, expected ${expectedEntries} (1 opening + ${SETUP_REFERENCES} references + ${processed} processed)`,
    );
  }

  failIfAny('hot wallet', total, problems, {
    seed,
    facts: describeFacts(facts),
    errors: options.errorNames(),
  });
  await assertWalletIsConsistent(sql, wallet.id);

  return {
    walletId: wallet.id,
    requests: total,
    processed,
    rejected,
    pending,
    seed,
  };
}
