import { describe, expect, test } from 'bun:test';
import { useSql } from '../support/database.js';

const sql = useSql();

async function indexDefinition(name: string): Promise<string | undefined> {
  const rows = (await sql(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?',
    [name],
  )) as Array<{ indexdef: string }>;
  return rows[0]?.indexdef;
}

// Índices de consulta (não são regras): sem eles, hasSettledWin e o "acordar" varreriam a
// tabela inteira de transações a cada operação.
describe('migration 5: lookup indexes on wager_transactions', () => {
  test('ix_wtx_reference_transaction serves "who points at this transaction"', async () => {
    const def = await indexDefinition('ix_wtx_reference_transaction');
    expect(def).toBeDefined();
    expect(def).toContain('ON public.wager_transactions');
    expect(def).toContain('(reference_transaction_id)');
    // Parcial: a maioria das linhas (BET, WIN sem referência...) não tem referência.
    expect(def).toContain('WHERE (reference_transaction_id IS NOT NULL)');
    expect(def).not.toContain('UNIQUE');
  });

  test('ix_wtx_pending_by_reference serves the wake-up, by the EXTERNAL id', async () => {
    const def = await indexDefinition('ix_wtx_pending_by_reference');
    expect(def).toBeDefined();
    expect(def).toContain('(provider_id, reference_external_transaction_id)');
    // Uma PENDING_REFERENCE ainda não tem reference_transaction_id: a busca é pelo id
    // externo da referência, e só entre as que estão esperando.
    expect(def).toContain("WHERE (status = 'PENDING_REFERENCE'::text)");
    expect(def).not.toContain('UNIQUE');
  });
});

describe('migration 7: the WINs of a round, for REFERENCE_SETTLED without a reference', () => {
  test('ix_wtx_round_wins serves "does this round have a paid WIN without reference"', async () => {
    const def = await indexDefinition('ix_wtx_round_wins');
    expect(def).toBeDefined();
    expect(def).toContain('(wallet_id, provider_id, round_id)');
    // Parcial: só os WINs PROCESSED sem referência entram (os com referência usam o índice acima).
    expect(def).toContain("kind = 'WIN'::text");
    expect(def).toContain("status = 'PROCESSED'::text");
    expect(def).toContain('reference_transaction_id IS NULL');
    expect(def).not.toContain('UNIQUE');
  });
});
