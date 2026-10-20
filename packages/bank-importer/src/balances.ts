// The bank's own balance for each account ("Last Balance from Bank" in the
// reconcile menu, stored in the account's balance_current like bank sync
// does). Files can arrive out of order, so the as-of date of the balance last
// written is kept in the importer's own state file, and an older statement
// never replaces a newer one.

import fs from 'fs';
import path from 'path';

export type BalanceRecord = {
  /** YYYY-MM-DD the bank reported the balance as of */
  asOf: string;
  /** Integer cents */
  balance: number;
  file: string;
};

export type BalanceState = Record<string, BalanceRecord>;

export function shouldUpdateBalance(
  previous: BalanceRecord | undefined,
  statement: {
    balance: number | null;
    asOf: string | null;
    transactionsInFile: number;
  },
): statement is { balance: number; asOf: string; transactionsInFile: number } {
  if (statement.balance == null || statement.asOf == null) return false;
  // BMO reports 0.00 for accounts with no activity in the download window.
  if (statement.transactionsInFile === 0) return false;
  // Same day: the file processed later (newer download) wins.
  return !previous || previous.asOf <= statement.asOf;
}

export function loadBalanceState(file: string): BalanceState {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data === 'object' && data != null ? { ...data } : {};
  } catch {
    return {};
  }
}

export function saveBalanceState(file: string, state: BalanceState) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
