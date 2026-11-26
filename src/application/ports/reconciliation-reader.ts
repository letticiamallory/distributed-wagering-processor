// O que o banco diz de UMA wallet, lido de um único instante (um snapshot): o saldo guardado, o
// que o ledger reconstrói, e se a corrente de lançamentos fecha. Os valores monetários são
// strings decimais com 2 casas, calculadas pelo próprio banco (NUMERIC): nunca number, e a
// aplicação não faz conta com eles.
export interface ReconciliationFacts {
  currency: string;
  storedBalance: string;
  storedVersion: number;
  // soma(CREDIT) - soma(DEBIT) de todos os lançamentos
  calculatedBalance: string;
  // stored - calculated, com sinal ("0.00" quando fecha)
  difference: string;
  checkedEntries: number;
  // Lançamentos cujo balance_before não é o balance_after do anterior (o primeiro parte de 0).
  chainBreaks: number;
  // Pares de lançamentos vizinhos cujas versões não são consecutivas.
  versionGaps: number;
  // A maior wallet_version do ledger (ausente se não há lançamentos).
  lastVersion?: number;
}

export abstract class ReconciliationReader {
  // Lê tudo numa transação REPEATABLE READ READ ONLY: saldo e ledger do MESMO instante, sem travar
  // ninguém e sem poder gravar. undefined se a wallet não existe.
  abstract snapshot(walletId: string): Promise<ReconciliationFacts | undefined>;
}
