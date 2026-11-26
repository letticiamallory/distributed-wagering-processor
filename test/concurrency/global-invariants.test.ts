import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { globalViolations, recordMetrics } from '../support/ledger-check.js';
import { usePersistence } from '../support/persistence.js';

// O CHECK GLOBAL, no fim da suíte (rodado depois de todos os outros arquivos pelo script
// `test:concurrency`): a invariante do enunciado para TODAS as wallets que a suíte criou,
//   wallet.balance == saldo reconstruído pelo ledger,
// numa só consulta. Pega o que um teste individual não vê: uma wallet esquecida, ou um efeito
// que só aparece depois que outro teste terminou.
//
// "Wallets da suíte" = criadas depois do marco gravado no começo da execução. O banco de teste
// também tem wallets de fixture dos testes de schema (sem ledger, por construção), que ficam de fora.
const db = usePersistence();
const MARK_FILE = '.context/concurrency-suite-start.txt';

function suiteStart(): { since: Date; fromMark: boolean } {
  if (existsSync(MARK_FILE)) {
    return {
      since: new Date(readFileSync(MARK_FILE, 'utf8').trim()),
      fromMark: true,
    };
  }
  // Rodado sozinho (sem o script): as wallets da última hora.
  return { since: new Date(Date.now() - 60 * 60 * 1_000), fromMark: false };
}

test('every wallet the concurrency suite created has balance == the balance the ledger rebuilds', async () => {
  const { since, fromMark } = suiteStart();

  const sql = (query: string, params: unknown[] = []) =>
    db().orm.em.getConnection().execute(query, params) as Promise<
      Array<Record<string, unknown>>
    >;
  const { checked, violations } = await globalViolations(sql, since);

  recordMetrics('G global check', {
    since: since.toISOString(),
    walletsChecked: checked,
    violations: violations.length,
    invariants: violations.length === 0 ? 'OK' : 'VIOLATED',
  });
  expect(violations).toEqual([]);
  // Não é uma checagem vazia: se o marco existe, a suíte criou wallets depois dele.
  if (fromMark) {
    expect(checked).toBeGreaterThan(0);
  }
}, 120_000);
