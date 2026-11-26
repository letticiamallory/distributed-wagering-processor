import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

// O ledger é append-only: existe só o append, nunca update nem delete.
export abstract class LedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;
}
