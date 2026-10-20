// Matching file transactions to ones an earlier bank sync (SimpleFIN)
// brought in. Those carry the bank sync's own ids, which never equal the
// bank file's ids, and Actual's duplicate detection will not match two
// transactions whose ids differ. Without this, every day both sources cover
// would be imported twice.

export type FileTransaction = {
  date: string;
  /** Integer cents */
  amount: number;
  importedId?: string;
  payee?: string;
};

export type ExistingTransaction = {
  id: string;
  date: string;
  amount: number;
  importedId: string | null;
  payee: string | null;
  /** True when bank sync created it (it has raw_synced_data) */
  fromBankSync: boolean;
};

/** Bank sync and the bank's own export can date a transaction differently. */
export const BANK_SYNC_WINDOW_DAYS = 3;

function daysBetween(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    86_400_000
  );
}

/**
 * For each file transaction (by index) the bank-sync transaction it
 * duplicates. Transactions whose bank id is already in the account are left
 * to Actual. Preference: same date, then same payee, then nearest date; a tie
 * between equally good candidates on different dates is left unmatched
 * rather than guessed.
 */
export function matchBankSyncTransactions(
  file: FileTransaction[],
  existing: ExistingTransaction[],
): Map<number, ExistingTransaction> {
  const knownIds = new Set(existing.map(e => e.importedId).filter(Boolean));
  const fileIds = new Set(file.map(t => t.importedId).filter(Boolean));
  const candidates = existing.filter(
    e => e.fromBankSync && !(e.importedId && fileIds.has(e.importedId)),
  );
  const used = new Set<string>();
  const matches = new Map<number, ExistingTransaction>();

  const order = file
    .map((t, i) => i)
    .sort((a, b) => file[a].date.localeCompare(file[b].date));

  for (const i of order) {
    const t = file[i];
    if (t.importedId && knownIds.has(t.importedId)) continue;

    const scored = candidates
      .filter(
        c =>
          !used.has(c.id) &&
          c.amount === t.amount &&
          daysBetween(c.date, t.date) <= BANK_SYNC_WINDOW_DAYS,
      )
      .map(c => ({
        c,
        // Lower is better: date distance first, payee agreement breaks ties.
        score:
          daysBetween(c.date, t.date) * 2 +
          (t.payee && c.payee === t.payee ? 0 : 1),
      }))
      .sort((a, b) => a.score - b.score);

    if (scored.length === 0) continue;
    const best = scored.filter(s => s.score === scored[0].score);
    // Equally good candidates on the same date are interchangeable (bank
    // sync sometimes recorded a transaction twice); take the first by id.
    // On different dates they are different transactions: don't guess.
    if (best.some(s => s.c.date !== best[0].c.date)) continue;
    const pick = best.map(s => s.c).sort((a, b) => a.id.localeCompare(b.id))[0];

    used.add(pick.id);
    matches.set(i, pick);
  }
  return matches;
}
