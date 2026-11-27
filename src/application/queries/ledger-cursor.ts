import { invalidPayload } from '../commands/command-parsing.js';

// O cursor do extrato é OPACO para o cliente: base64url de um JSON versionado
// ({ v: 2, walletId, walletVersion }). O cliente só o devolve; não monta nem lê. Se o formato mudar,
// sobe o `v`, e os cursores antigos viram 400 em vez de uma página errada (os de v: 1, sem walletId,
// já são recusados).
//
// Por que `walletVersion` serve de cursor: é único por wallet e só cresce, então "os lançamentos
// com versão MENOR que esta" é uma fronteira estável: lançamentos novos entram do lado de cima e
// nunca fazem uma entrada aparecer duas vezes nem sumir entre páginas (diferente de OFFSET).
//
// Por que o `walletId` vai junto: um cursor emitido para uma wallet não pode ser usado em outra
// (seria pular para uma versão qualquer dela). Sem assinatura, de propósito (ADR-0015): forjar um
// cursor da PRÓPRIA wallet só leva a uma página que o extrato já mostra.
const FORMAT_VERSION = 2;
const MAX_WALLET_VERSION = 2_147_483_647; // o INTEGER do Postgres
const MAX_CURSOR_LENGTH = 300;

export function encodeLedgerCursor(
  walletId: string,
  walletVersion: number,
): string {
  if (
    !Number.isInteger(walletVersion) ||
    walletVersion < 1 ||
    walletVersion > MAX_WALLET_VERSION
  ) {
    throw new Error(
      `cannot build a cursor for version ${String(walletVersion)}`,
    );
  }
  return Buffer.from(
    JSON.stringify({ v: FORMAT_VERSION, walletId, walletVersion }),
  ).toString('base64url');
}

// Devolve a wallet_version "antes da qual" a próxima página começa. Lança InvalidCommandError
// (400) para qualquer coisa que não seja um cursor que nós mesmos emitimos PARA ESTA wallet. A
// mensagem nunca repete o que veio.
export function decodeLedgerCursor(cursor: string, walletId: string): number {
  const invalid = () =>
    invalidPayload([{ path: 'cursor', message: 'is not a valid cursor' }]);
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalid();
  }
  const {
    v,
    walletId: owner,
    walletVersion,
  } = parsed as Record<string, unknown>;
  if (
    v !== FORMAT_VERSION ||
    owner !== walletId ||
    typeof walletVersion !== 'number' ||
    !Number.isInteger(walletVersion) ||
    walletVersion < 1 ||
    walletVersion > MAX_WALLET_VERSION
  ) {
    throw invalid();
  }
  return walletVersion;
}
