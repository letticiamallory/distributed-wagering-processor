import { afterAll, describe, expect, test } from 'bun:test';
import { startApp } from '../support/http-app.js';
import { startInstances } from '../support/instances.js';
import {
  outboxRowsOf,
  parkForeignPendings,
  quiesceOutbox,
} from '../support/outbox.js';
import { usePersistence, uuid } from '../support/persistence.js';
import { createScenario, ext } from '../support/wager-scenarios.js';

const db = usePersistence();
const s = createScenario(db, { start: new Date() });

// O que este teste planta (um evento devido e uma pendente vencida) é só dele: ao fim, fica inerte.
afterAll(async () => {
  await quiesceOutbox(s.sql);
  await parkForeignPendings(s.sql);
});

// O requisito: no ambiente de teste o publisher da outbox e o worker de PENDING_REFERENCE nascem
// DESLIGADOS. A prova é de comportamento: um evento devido e uma pendente devida ficam na tabela, a
// aplicação sobe (a do e2e, e os 3 processos da Fase 4) e NADA muda neles. Um publisher ligado os
// teria publicado; um worker ligado teria resolvido (ou gasto uma tentativa da) pendente.
async function plant() {
  const wallet = await s.walletWith('100.00');
  await s.placeBet(wallet, '1.00'); // 2 eventos devidos
  const pending = await s.pend(wallet, 'REFUND', ext(`off-${uuid()}`), '1.00');
  // a pendente venceu há um minuto (relógio REAL: é o do processo que subir)
  await s.sql(
    `UPDATE wager_transactions SET next_attempt_at = now() - interval '1 minute' WHERE id = ?`,
    [pending.transactionId],
  );
  const snapshot = async () => ({
    outbox: (await outboxRowsOf(s.sql, [wallet.id])).map((r) => [
      String(r.id),
      r.published_at,
      Number(r.attempts),
    ]),
    pending: await s.one(
      'SELECT status, attempts, next_attempt_at FROM wager_transactions WHERE id = ?',
      [pending.transactionId],
    ),
  });
  return { snapshot, wallet };
}

describe('in the test environment the outbox publisher and the pending worker are born OFF', () => {
  test('the e2e application (AppModule, default settings) leaves a due event and a due pending untouched', async () => {
    const { snapshot } = await plant();
    const before = await snapshot();
    expect(before.outbox.length).toBeGreaterThanOrEqual(3);
    const app = await startApp();
    try {
      await Bun.sleep(3_000); // muitos ciclos de um publisher (500 ms) e de um worker (1 s)
    } finally {
      await app.close();
    }
    expect(await snapshot()).toEqual(before);
    expect(before.pending.status).toBe('PENDING_REFERENCE');
  }, 60_000);

  test('the three real processes of the concurrency suite leave them untouched as well', async () => {
    const { snapshot } = await plant();
    const before = await snapshot();
    const instances = await startInstances(3);
    try {
      await Bun.sleep(3_000);
    } finally {
      await instances.stop();
    }
    expect(await snapshot()).toEqual(before);
  }, 90_000);
});
