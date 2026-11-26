import { appendFileSync } from 'node:fs';
import { assertInvariants } from './invariants.js';

export type SqlFn = (
  query: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

export interface WalletFacts {
  balance: string;
  version: number;
  // Saldo reconstruído pelo ledger: soma dos créditos menos a soma dos débitos.
  rebuilt: string;
  entries: number;
  debits: number;
  credits: number;
}

export async function walletFacts(
  sql: SqlFn,
  walletId: string,
): Promise<WalletFacts> {
  const rows = await sql(
    `SELECT w.balance::text AS balance, w.version::int AS version,
            coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS rebuilt,
            count(l.id)::int AS entries,
            (count(*) FILTER (WHERE l.direction = 'DEBIT'))::int AS debits,
            (count(*) FILTER (WHERE l.direction = 'CREDIT'))::int AS credits
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`,
    [walletId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} does not exist`);
  }
  return row as unknown as WalletFacts;
}

export const describeFacts = (facts: WalletFacts): string =>
  `balance=${facts.balance} ledger=${facts.rebuilt} version=${facts.version} entries=${facts.entries} debits=${facts.debits} credits=${facts.credits}`;

// A invariante do enunciado, calculada POR FORA do código da aplicação (uma soma em SQL):
//   wallet.balance == saldo reconstruído pelo ledger
// mais a corrente sem buracos e o saldo nunca negativo. Devolve o que está errado (vazio = ok).
export async function ledgerProblems(
  sql: SqlFn,
  walletId: string,
): Promise<string[]> {
  const facts = await walletFacts(sql, walletId);
  const problems: string[] = [];
  if (facts.balance.startsWith('-')) {
    problems.push(`NEGATIVE balance ${facts.balance}`);
  }
  if (facts.balance !== facts.rebuilt) {
    problems.push(`balance ${facts.balance} != ledger ${facts.rebuilt}`);
  }
  if (facts.version !== Math.max(1, facts.entries)) {
    problems.push(
      `version ${facts.version} != ledger entries ${facts.entries}`,
    );
  }
  return problems;
}

// O fim de todo teste da suíte: a invariante por fora (SQL) e a mais detalhada (assertInvariants),
// que confere cada lançamento da corrente.
export async function assertWalletIsConsistent(
  sql: SqlFn,
  walletId: string,
): Promise<WalletFacts> {
  const problems = await ledgerProblems(sql, walletId);
  const facts = await walletFacts(sql, walletId);
  if (problems.length > 0) {
    throw new Error(
      `wallet ${walletId} is inconsistent: ${problems.join('; ')} (${describeFacts(facts)})`,
    );
  }
  try {
    await assertInvariants(sql, walletId);
  } catch (error) {
    throw new Error(
      `wallet ${walletId} breaks the ledger chain: ${(error as Error).message} (${describeFacts(facts)})`,
    );
  }
  return facts;
}

export async function expectNoProblems(
  sql: SqlFn,
  walletIds: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const id of walletIds) {
    const problems = await ledgerProblems(sql, id);
    if (problems.length > 0) {
      found.push(`${id}: ${problems.join('; ')}`);
    }
  }
  return found;
}

// ---- o check global (todas as wallets da suíte, numa só consulta)

export async function globalViolations(
  sql: SqlFn,
  since: Date,
): Promise<{ checked: number; violations: string[] }> {
  const checked = (
    await sql(
      "SELECT count(*)::int AS n FROM wallets WHERE created_at >= ? AND created_at <= now() + interval '1 minute'",
      [since],
    )
  )[0]?.n as number;
  const rows = await sql(
    `SELECT w.id, w.balance::text AS balance, w.version::int AS version,
            coalesce(r.rebuilt, 0)::text AS rebuilt, coalesce(r.entries, 0)::int AS entries,
            coalesce(r.max_version, 0)::int AS max_version
       FROM wallets w
       LEFT JOIN (SELECT wallet_id,
                         sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS rebuilt,
                         count(*) AS entries, max(wallet_version) AS max_version
                    FROM wallet_ledger_entries GROUP BY wallet_id) r ON r.wallet_id = w.id
      WHERE w.created_at >= ? AND w.created_at <= now() + interval '1 minute'
        AND (w.balance < 0
          OR w.balance <> coalesce(r.rebuilt, 0)
          OR w.version <> greatest(1, coalesce(r.max_version, 0))
          OR coalesce(r.entries, 0) <> coalesce(r.max_version, 0))
      ORDER BY w.created_at`,
    [since],
  );
  return {
    checked,
    violations: rows.map(
      (row) =>
        `${String(row.id)}: balance=${String(row.balance)} ledger=${String(row.rebuilt)} version=${String(row.version)} entries=${String(row.entries)} max_version=${String(row.max_version)}`,
    ),
  };
}

// ---- métricas das cargas (vão para as notas e para o ARCHITECTURE.md)

const METRICS_FILE = '.context/concurrency-metrics.jsonl';

export function recordMetrics(
  name: string,
  data: Record<string, unknown>,
): void {
  const line = { name, at: new Date().toISOString(), ...data };
  try {
    appendFileSync(METRICS_FILE, `${JSON.stringify(line)}\n`);
  } catch {
    // sem a pasta .context (um clone limpo), só imprime
  }
  console.log(`[concurrency] ${name} ${JSON.stringify(data)}`);
}

// Junta os problemas e falha UMA vez, dizendo quantos foram e mostrando os primeiros: assim a
// sabotagem mostra o sintoma e a escala ("37 de 100 rodadas"), não só "falhou".
export function failIfAny(
  what: string,
  total: number,
  problems: readonly string[],
  extra: Record<string, unknown> = {},
): void {
  if (problems.length === 0) {
    return;
  }
  const sample = problems.slice(0, 4).join('\n  - ');
  throw new Error(
    `${what}: ${problems.length} problems found over ${total} checks\n  - ${sample}\n  extra=${JSON.stringify(extra)}`,
  );
}

// Conta os erros que a aplicação registrou no log (ConcurrentWalletUpdateError, DuplicateKeyError...).
export function countErrorNames(
  entries: ReadonlyArray<{ message: unknown }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const message = entry.message as { error?: unknown } | undefined;
    const name = typeof message?.error === 'string' ? message.error : 'unknown';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}
