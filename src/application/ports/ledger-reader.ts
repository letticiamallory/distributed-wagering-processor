import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

// Leitura SEM transação: o extrato de uma wallet, da versão mais nova para a mais antiga.
export abstract class LedgerReader {
  // Até `limit` lançamentos com wallet_version MENOR que `beforeVersion` (ou os mais novos, se
  // não houver). Quem pagina pede `limit + 1` para saber se existe a próxima página.
  abstract page(
    walletId: string,
    options: { beforeVersion?: number; limit: number },
  ): Promise<WalletLedgerEntry[]>;
}
