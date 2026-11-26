import type { Wallet } from '../../domain/wallet/wallet.js';

// Leitura SEM transação nem lock: as consultas HTTP (GET /wallets/:id).
export abstract class WalletReader {
  abstract findById(id: string): Promise<Wallet | undefined>;
}
