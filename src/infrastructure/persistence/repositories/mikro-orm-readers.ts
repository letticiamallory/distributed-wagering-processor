import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  NOOP_METRICS,
  type MetricsPort,
} from '../../../application/ports/metrics.port.js';
import { LedgerReader } from '../../../application/ports/ledger-reader.js';
import {
  ReconciliationReader,
  type ReconciliationFacts,
} from '../../../application/ports/reconciliation-reader.js';
import { WalletReader } from '../../../application/ports/wallet-reader.js';
import { Money } from '../../../domain/money/money.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import type { LedgerDirection } from '../../../domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { classifyAndCount } from '../classify-and-count.js';
import { LedgerEntryEntity, WalletEntity } from '../entities.js';
import { walletFromRow } from '../mappers.js';

// Leituras das CONSULTAS HTTP: sem lock e sem transação de negócio. Cada chamada usa um
// EntityManager novo (nenhum cache entre leituras), e uma falha transitória do banco é contada
// pela causa, como em todo caminho que fala com o banco.
export class MikroOrmWalletReader extends WalletReader {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  async findById(id: string): Promise<Wallet | undefined> {
    try {
      const row = await this.em.fork().findOne(WalletEntity, { id });
      return row ? walletFromRow(row) : undefined;
    } catch (error) {
      throw classifyAndCount(error, this.metrics);
    }
  }
}

export class MikroOrmLedgerReader extends LedgerReader {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  // WHERE wallet_id = $1 AND wallet_version < $cursor ORDER BY wallet_version DESC LIMIT $limit.
  // O (wallet_id, wallet_version) já é UNIQUE (uq_ledger_wallet_version): o índice serve a consulta.
  async page(
    walletId: string,
    options: { beforeVersion?: number; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    try {
      const rows = await this.em.fork().find(
        LedgerEntryEntity,
        {
          walletId,
          ...(options.beforeVersion !== undefined && {
            walletVersion: { $lt: options.beforeVersion },
          }),
        },
        { orderBy: { walletVersion: 'desc' }, limit: options.limit },
      );
      return rows.map((row) => {
        const money = (amount: string) =>
          Money.from({ amount, currency: row.currency });
        return WalletLedgerEntry.rehydrate({
          id: row.id,
          walletId: row.walletId,
          transactionId: row.transactionId,
          direction: row.direction as LedgerDirection,
          money: money(row.amount),
          balanceBefore: money(row.balanceBefore),
          balanceAfter: money(row.balanceAfter),
          walletVersion: row.walletVersion,
          createdAt: row.createdAt,
        });
      });
    } catch (error) {
      throw classifyAndCount(error, this.metrics);
    }
  }
}

// A conferência saldo x ledger (ADR-0015). REPEATABLE READ + READ ONLY:
//   - REPEATABLE READ: as duas leituras (o saldo e o ledger) enxergam o MESMO instante. Em READ
//     COMMITTED, uma aposta que commitasse entre elas mudaria o ledger depois de o saldo ter sido
//     lido, e a conferência acusaria uma divergência que não existe.
//   - READ ONLY: o banco recusa qualquer escrita nesta transação, e ela não pega lock nenhum:
//     conferir uma wallet nunca atrasa uma aposta (nem o contrário).
export class MikroOrmReconciliationReader extends ReconciliationReader {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  async snapshot(walletId: string): Promise<ReconciliationFacts | undefined> {
    try {
      return await this.em.fork().transactional(
        async (tx) => {
          const connection = tx.getConnection();
          const context = tx.getTransactionContext();
          const wallets = (await connection.execute(
            `SELECT currency, balance::numeric(20,2)::text AS stored, version
               FROM wallets WHERE id = ?`,
            [walletId],
            'all',
            context,
          )) as Array<{ currency: string; stored: string; version: number }>;
          const wallet = wallets[0];
          if (!wallet) {
            return undefined;
          }
          // O ledger inteiro de uma vez: a soma (crédito menos débito), quantos lançamentos, e a
          // corrente (cada balance_before é o balance_after do anterior, e as versões seguem). A
          // diferença sai do próprio banco, em NUMERIC: a aplicação não faz conta de dinheiro.
          const ledger = (await connection.execute(
            `WITH entries AS (
               SELECT wallet_version, direction, amount, balance_before,
                      LAG(balance_after) OVER (ORDER BY wallet_version) AS previous_after,
                      LAG(wallet_version) OVER (ORDER BY wallet_version) AS previous_version
                 FROM wallet_ledger_entries
                WHERE wallet_id = ?
             ),
             total AS (
               SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
                        ::numeric(20,2) AS calculated
                 FROM entries
             )
             SELECT (SELECT count(*) FROM entries)::int AS entries,
                    total.calculated::text AS calculated,
                    ((SELECT balance FROM wallets WHERE id = ?) - total.calculated)
                      ::numeric(20,2)::text AS difference,
                    (SELECT count(*) FROM entries
                      WHERE balance_before <> coalesce(previous_after, 0))::int AS chain_breaks,
                    (SELECT count(*) FROM entries
                      WHERE previous_version IS NOT NULL
                        AND wallet_version <> previous_version + 1)::int AS version_gaps,
                    (SELECT max(wallet_version) FROM entries) AS last_version
               FROM total`,
            [walletId, walletId],
            'all',
            context,
          )) as Array<{
            entries: number;
            calculated: string;
            difference: string;
            chain_breaks: number;
            version_gaps: number;
            last_version: number | null;
          }>;
          const row = ledger[0];
          if (!row) {
            return undefined;
          }
          return {
            currency: wallet.currency.trim(),
            storedBalance: wallet.stored,
            storedVersion: Number(wallet.version),
            calculatedBalance: row.calculated,
            difference: row.difference,
            checkedEntries: Number(row.entries),
            chainBreaks: Number(row.chain_breaks),
            versionGaps: Number(row.version_gaps),
            ...(row.last_version !== null && {
              lastVersion: Number(row.last_version),
            }),
          };
        },
        {
          isolationLevel: IsolationLevel.REPEATABLE_READ,
          readOnly: true,
        },
      );
    } catch (error) {
      throw classifyAndCount(error, this.metrics);
    }
  }
}
