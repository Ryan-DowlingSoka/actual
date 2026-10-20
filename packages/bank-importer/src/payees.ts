// Chooses payees from the budget's own history: if a bank description has
// been seen before, use the payee of the most recent transaction with that
// description (so renames and corrections carry forward). Deterministic,
// and it improves as payees are corrected in Actual.

export type HistoryTransaction = {
  accountId: string;
  date: string;
  payeeId: string;
  /** Account the payee transfers to, if it is a transfer payee */
  transferAccountId: string | null;
  /** Texts that described the transaction: imported payee, notes, ... */
  texts: string[];
};

type Entry = {
  date: string;
  payeeId: string;
  transferAccountId: string | null;
};

export type PayeeIndex = {
  /** Whole description (digits kept), per account; includes transfers */
  exactByAccount: Map<string, Entry>;
  /** Merchant words only (see payeeKey); never transfers */
  byAccount: Map<string, Entry>;
  global: Map<string, Entry>;
};

// Spellings that differ between the bank's own export and older imports.
const WORD_ALIASES: Record<string, string> = { ETRNSFR: 'ETRANSFER' };

function words(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/^\s*\[[A-Z]{2}\]/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => WORD_ALIASES[word] ?? word);
}

/** The whole description, case- and spacing-insensitive. */
export function exactKey(text: string): string {
  return words(text).join(' ');
}

/**
 * Normalises a description to the words that identify the merchant: drops
 * BMO type codes, order codes like "*XY9ZW8VU7", and any token with a digit
 * (reference numbers, store numbers, dates).
 */
export function payeeKey(text: string): string {
  return words(text.replace(/\*\S*\d\S*/g, ' '))
    .join(' ')
    .split(/[^A-Z0-9&']+/)
    .filter(token => token !== '' && !/\d/.test(token))
    .join(' ');
}

const scoped = (accountId: string, key: string) => `${accountId}\u0000${key}`;

export function buildPayeeIndex(history: HistoryTransaction[]): PayeeIndex {
  const index: PayeeIndex = {
    exactByAccount: new Map(),
    byAccount: new Map(),
    global: new Map(),
  };
  const keep = (map: Map<string, Entry>, key: string, entry: Entry) => {
    const existing = map.get(key);
    if (!existing || existing.date <= entry.date) map.set(key, entry);
  };

  for (const t of history) {
    const entry = {
      date: t.date,
      payeeId: t.payeeId,
      transferAccountId: t.transferAccountId,
    };
    for (const key of new Set(t.texts.map(exactKey))) {
      if (key !== '') {
        keep(index.exactByAccount, scoped(t.accountId, key), entry);
      }
    }
    // Transfers depend on the account numbers in the text, which payeeKey
    // throws away, so they are only ever reused on an exact match.
    if (t.transferAccountId) continue;
    for (const key of new Set(t.texts.map(payeeKey))) {
      if (key === '') continue;
      keep(index.byAccount, scoped(t.accountId, key), entry);
      keep(index.global, key, entry);
    }
  }
  return index;
}

/**
 * The ordinary (non-transfer) payee for a description. Transfers are handled
 * separately after import (see transfers.ts) so the other side of a transfer
 * that is already in the budget gets linked instead of duplicated.
 */
export function lookupPayee(
  index: PayeeIndex,
  accountId: string,
  description: string,
): string | null {
  const exact = index.exactByAccount.get(
    scoped(accountId, exactKey(description)),
  );
  if (exact) {
    return exact.transferAccountId ? null : exact.payeeId;
  }

  const key = payeeKey(description);
  if (key === '') return null;
  return (
    index.byAccount.get(scoped(accountId, key))?.payeeId ??
    index.global.get(key)?.payeeId ??
    null
  );
}

/**
 * If this exact description was last a transfer in this account, the
 * transfer payee and the account it goes to.
 */
export function lookupTransfer(
  index: PayeeIndex,
  accountId: string,
  description: string,
): { payeeId: string; transferAccountId: string } | null {
  const exact = index.exactByAccount.get(
    scoped(accountId, exactKey(description)),
  );
  if (!exact?.transferAccountId || exact.transferAccountId === accountId) {
    return null;
  }
  return { payeeId: exact.payeeId, transferAccountId: exact.transferAccountId };
}

/**
 * Payee name for a description never seen before: the description without
 * order codes and trailing reference numbers (e.g. Interac confirmation
 * codes), so repeat merchants share one payee.
 */
export function fallbackPayeeName(description: string): string {
  const cleaned = description
    .replace(/\*\S*\d\S*/g, ' ')
    .split(' ')
    .filter(token => !(token.length >= 10 && /\d/.test(token)))
    .map(token => WORD_ALIASES[token.toUpperCase()] ?? token)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || description;
}
