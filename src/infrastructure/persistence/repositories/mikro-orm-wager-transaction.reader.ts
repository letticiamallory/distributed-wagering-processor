import type { EntityManager } from '@mikro-orm/postgresql';
import {
  NOOP_METRICS,
  type MetricsPort,
} from '../../../application/ports/metrics.port.js';
import { WagerTransactionReader } from '../../../application/ports/wager-transaction-repository.js';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction.js';
import { WagerTransactionEntity } from '../entities.js';
import { transactionFromRow } from '../mappers.js';
import { classifyAndCount } from '../classify-and-count.js';

export interface TransactionLookup {
  id?: string;
  idempotencyKey?: string;
  providerId?: string;
  externalTransactionId?: string;
}

export async function findTransaction(
  em: EntityManager,
  where: TransactionLookup,
): Promise<WagerTransaction | undefined> {
  const row = await em.findOne(WagerTransactionEntity, where);
  return row ? transactionFromRow(row) : undefined;
}

// Leitura SEM transação (o caminho rápido da idempotência e as consultas HTTP). Cada
// chamada usa um EntityManager novo: nenhum cache entre leituras, então uma linha
// commitada por outra instância aparece na hora.
export class MikroOrmWagerTransactionReader extends WagerTransactionReader {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    super();
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.read({ id });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.read({ idempotencyKey });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.read({ providerId, externalTransactionId });
  }

  private async read(
    where: TransactionLookup,
  ): Promise<WagerTransaction | undefined> {
    try {
      return await findTransaction(this.em.fork(), where);
    } catch (error) {
      throw classifyAndCount(error, this.metrics);
    }
  }
}
