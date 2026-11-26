import type { Wallet } from '../../domain/wallet/wallet.js';

export abstract class WalletRepository {
  // SELECT ... FOR UPDATE: só vale dentro do UnitOfWork. Devolve undefined se não existe.
  abstract lockById(id: string): Promise<Wallet | undefined>;

  // Lança WalletAlreadyExistsError se (player, moeda) já tem wallet (uq_wallets_player_currency).
  abstract insert(wallet: Wallet): Promise<void>;

  // UPDATE ... WHERE id = $1 AND version = $expectedVersion. Se não afetar exatamente 1
  // linha, lança ConcurrentWalletUpdateError (com o lock isso é bug).
  abstract save(wallet: Wallet, expectedVersion: number): Promise<void>;
}
