import { z } from 'zod';
import type { Money } from '../../domain/money/money.js';
import {
  detailsOf,
  invalidPayload,
  moneyInput,
  toMoney,
  uuid,
} from './command-parsing.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

const schema = z.object({
  playerId: uuid,
  initialBalance: moneyInput,
});

export function parseCreateWalletCommand(input: unknown): CreateWalletCommand {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalidPayload(detailsOf(parsed.error));
  }
  return {
    playerId: parsed.data.playerId,
    initialBalance: toMoney(parsed.data.initialBalance, 'initialBalance'),
  };
}
