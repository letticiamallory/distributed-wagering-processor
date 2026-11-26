import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { MoneyProps } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { computePayloadHash } from '../../domain/wager/wager-payload-hash.js';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import { parseCreateWalletCommand } from '../commands/create-wallet.command.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface CreateWalletContext {
  correlationId: string;
}

// O corpo da resposta de POST /wallets. O dinheiro sai como MoneyProps (string decimal).
export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

// Cria a wallet e, quando o saldo inicial é maior que zero, a transação interna OPENING, o
// lançamento CREDIT que a explica e o evento WalletBalanceChanged, tudo na MESMA transação
// do banco: ou existe tudo, ou não existe nada. Não conhece Nest nem MikroORM: só as portas.
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  // `input` é o corpo bruto (HTTP): a validação mora aqui, então todo canal passa por ela.
  // Valor inválido, negativo ou com moeda mal formada nem chega a abrir transação.
  async execute(
    input: unknown,
    context: CreateWalletContext,
  ): Promise<CreateWalletResult> {
    const command = parseCreateWalletCommand(input);
    const now = this.clock.now();
    const walletId = this.ids.next();
    // Saldo zero não gera abertura, lançamento nem evento: não há o que explicar.
    const opening = command.initialBalance.isPositive()
      ? { transactionId: this.ids.next(), entryId: this.ids.next() }
      : undefined;

    // O domínio decide: moeda vem do saldo inicial, saldo negativo seria recusado, e o
    // lançamento de abertura já nasce com a aritmética conferida.
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      ...(opening && { opening }),
      at: now,
    });

    await this.uow.run(async (repositories) => {
      // Ordem das FKs: a wallet existe antes da transação, e a transação antes do lançamento.
      await repositories.wallets.insert(wallet);
      if (!opening || !openingEntry) {
        return;
      }

      const openingTransaction = WagerTransaction.createOpening({
        id: opening.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: command.initialBalance,
        payloadHash: computePayloadHash({
          providerId: 'internal',
          externalTransactionId: wallet.id,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: command.initialBalance,
        }),
        correlationId: context.correlationId,
        createdAt: now,
      });
      await repositories.transactions.insert(openingTransaction);
      await repositories.ledger.append(openingEntry);

      const event = WalletBalanceChanged.from(wallet, openingEntry, {
        eventId: this.ids.next(),
        correlationId: context.correlationId,
        causationId: openingTransaction.id,
        occurredAt: now,
      });
      await repositories.outbox.add(OutboxMessage.enqueue(event, now));
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
