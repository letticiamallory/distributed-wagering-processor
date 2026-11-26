import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ResolvePendingReferenceUseCase } from '../../src/application/use-cases/resolve-pending-reference.use-case.js';
import { PendingReferenceSchedule } from '../../src/domain/wager/pending-reference-schedule.js';
import { SystemClock } from '../../src/infrastructure/system/system-clock.js';
import { UuidV7Generator } from '../../src/infrastructure/system/uuid-v7-generator.js';
import { startApp, type Json, type TestApp } from '../support/http-app.js';
import {
  countErrorNames,
  expectNoProblems,
  failIfAny,
  recordMetrics,
  walletFacts,
} from '../support/ledger-check.js';
import {
  ProviderClient,
  type ClientResponse,
} from '../support/provider-client.js';

// "ROLLBACK ou REFUND entregue antes da referência" (enunciado, seção 13), mas AGORA junto: a
// reversão e a BET dela saem ao mesmo tempo, e a que chega primeiro varia. Em qualquer ordem o
// resultado final é o mesmo:
//   - a BET está PROCESSED;
//   - a reversão foi aplicada UMA vez (ou direto, ou ficou 202 pendente e foi resolvida depois);
//   - o saldo voltou a 100.00, com um DEBIT e um CREDIT além da abertura.
const ROUNDS = 100;

let app: TestApp;
let resolver: ResolvePendingReferenceUseCase;
beforeAll(async () => {
  app = await startApp();
  resolver = new ResolvePendingReferenceUseCase(
    app.db.uow,
    app.db.reader,
    new SystemClock(),
    new UuidV7Generator(),
    new PendingReferenceSchedule(),
  );
}, 60_000);
afterAll(async () => {
  await app.close();
});

const body = (
  wallet: { id: string; playerId: string },
  kind: 'BET' | 'REFUND' | 'ROLLBACK',
  external: string,
  reference?: string,
): Json => ({
  providerId: 'provider-a',
  externalTransactionId: external,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount: '25.00', currency: 'BRL' },
  ...(reference && { referenceExternalTransactionId: reference }),
});

// O papel do worker da Fase 5: resolve as pendentes que ficaram (a BET já existe nessa altura).
async function resolveAllPending(responses: ClientResponse[]): Promise<void> {
  for (const response of responses.filter((r) => r.status === 202)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await resolver.execute(
        { transactionId: String(response.body?.transactionId) },
        { correlationId: 'worker' },
      );
      if (result.outcome !== 'STILL_PENDING') break;
    }
  }
}

async function finalStatuses(
  transactionIds: string[],
): Promise<Array<{ kind: string; status: string; failure: string | null }>> {
  const rows = await app.sql(
    `SELECT kind, status, failure_code FROM wager_transactions WHERE id = ANY(?::uuid[]) ORDER BY kind`,
    [`{${transactionIds.join(',')}}`],
  );
  return rows.map((r) => ({
    kind: String(r.kind),
    status: String(r.status),
    failure: r.failure_code as string | null,
  }));
}

describe('a reversal and its BET sent at the same time', () => {
  test.each([
    ['REFUND', ['REFUND'] as const],
    ['ROLLBACK', ['ROLLBACK'] as const],
    ['REFUND and ROLLBACK', ['REFUND', 'ROLLBACK'] as const],
  ])(
    `BET + %s (${ROUNDS} rounds, the order of arrival alternates)`,
    async (_name, reversals) => {
      const client = new ProviderClient();
      const setup = new ProviderClient();
      const problems: string[] = [];
      const walletIds: string[] = [];
      let reversalFirst = 0;
      let betFirst = 0;
      app.logs.clear();

      for (let round = 0; round < ROUNDS; round++) {
        const wallet = await setup.createWallet(app.url, '100.00');
        walletIds.push(wallet.id);
        const betExternal = `ref-${Bun.randomUUIDv7()}`;
        const betRequest = () =>
          client.submit(app.url, body(wallet, 'BET', betExternal));
        const reversalRequests = () =>
          reversals.map((kind) =>
            client.submit(
              app.url,
              body(
                wallet,
                kind,
                `${kind.toLowerCase()}-${Bun.randomUUIDv7()}`,
                betExternal,
              ),
            ),
          );

        // A ordem de DISPARO alterna: ora a BET sai primeiro, ora a reversão.
        const all =
          round % 2 === 0
            ? await Promise.all([betRequest(), ...reversalRequests()])
            : await (async () => {
                const rs = reversalRequests();
                const b = betRequest();
                return Promise.all([b, ...rs]);
              })();
        const [betResponse, ...reversalResponses] = all as [
          ClientResponse,
          ...ClientResponse[],
        ];

        if (betResponse.status !== 201) {
          problems.push(
            `round ${round}: the BET answered ${betResponse.status} ${betResponse.text.slice(0, 100)}`,
          );
        }
        if (reversalResponses.some((r) => r.status === 202)) reversalFirst++;
        else betFirst++;
        for (const r of reversalResponses) {
          if (![200, 201, 202, 422].includes(r.status)) {
            problems.push(
              `round ${round}: a reversal answered ${r.status} ${r.text.slice(0, 100)}`,
            );
          }
        }

        await resolveAllPending(reversalResponses);

        const statuses = await finalStatuses(
          all.map((r) => String(r.body?.transactionId)),
        );
        const reversalsDone = statuses.filter((s) => s.kind !== 'BET');
        const applied = reversalsDone.filter((s) => s.status === 'PROCESSED');
        const stillPending = reversalsDone.filter(
          (s) => s.status === 'PENDING_REFERENCE',
        );
        const refused = reversalsDone.filter((s) => s.status === 'REJECTED');
        if (statuses.find((s) => s.kind === 'BET')?.status !== 'PROCESSED') {
          problems.push(
            `round ${round}: the BET is ${statuses.find((s) => s.kind === 'BET')?.status}`,
          );
        }
        if (applied.length !== 1 || stillPending.length > 0) {
          problems.push(
            `round ${round}: ${applied.length} reversals applied and ${stillPending.length} still pending, expected exactly 1 applied: ${JSON.stringify(reversalsDone)}`,
          );
        }
        if (refused.some((s) => s.failure !== 'REFERENCE_ALREADY_REVERSED')) {
          problems.push(
            `round ${round}: a reversal was refused for ${refused.map((s) => s.failure).join(',')}, expected REFERENCE_ALREADY_REVERSED`,
          );
        }
        const facts = await walletFacts(app.sql, wallet.id);
        // abertura (CREDIT) + a reversão (CREDIT) e UM débito, a BET
        if (
          facts.balance !== '100.00' ||
          facts.debits !== 1 ||
          facts.credits !== 2
        ) {
          problems.push(
            `round ${round}: balance ${facts.balance}, ${facts.debits} DEBITs, ${facts.credits} CREDITs, expected 100.00, 1 and 2`,
          );
        }
      }

      failIfAny(
        `BET + ${reversals.join(' + ')}`,
        ROUNDS,
        [...problems, ...(await expectNoProblems(app.sql, walletIds))],
        {
          errors: countErrorNames(app.logs.at('error')),
        },
      );
      recordMetrics(`6 BET + ${reversals.join(' + ')}`, {
        rounds: ROUNDS,
        reversalArrivedFirst: reversalFirst,
        betArrivedFirst: betFirst,
        status503: client.stats.status503,
        retries: client.stats.retries,
        invariants: 'OK',
      });
      expect(reversalFirst + betFirst).toBe(ROUNDS);
    },
    300_000,
  );
});
