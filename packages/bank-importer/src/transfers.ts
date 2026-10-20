// Choosing the other side of a transfer. When a newly imported transaction
// is (by history) a transfer to another account, that account may already
// hold the other side from its own bank file. Linking the two avoids the
// duplicate Actual would otherwise create.

export type LedgerTransaction = {
  id: string;
  date: string;
  /** Integer cents */
  amount: number;
  transferId: string | null;
  isParent: boolean;
  /** True when the payee is already a transfer payee */
  isTransfer: boolean;
};

/** How far apart the two sides of a transfer may post. */
export const TRANSFER_WINDOW_DAYS = 7;

function daysBetween(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    86_400_000
  );
}

/**
 * The unlinked transaction with the opposite amount closest in date, or
 * 'ambiguous' when two are equally close (rather than guess).
 */
export function findCounterpart(
  transaction: Pick<LedgerTransaction, 'date' | 'amount'>,
  candidates: LedgerTransaction[],
  alreadyUsed: Set<string>,
): LedgerTransaction | 'ambiguous' | null {
  const matches = candidates
    .filter(
      c =>
        c.amount === -transaction.amount &&
        !c.transferId &&
        !c.isParent &&
        !c.isTransfer &&
        !alreadyUsed.has(c.id) &&
        daysBetween(c.date, transaction.date) <= TRANSFER_WINDOW_DAYS,
    )
    .map(c => ({ c, distance: daysBetween(c.date, transaction.date) }))
    .sort((x, y) => x.distance - y.distance);

  if (matches.length === 0) return null;
  if (matches.length > 1 && matches[1].distance === matches[0].distance) {
    return 'ambiguous';
  }
  return matches[0].c;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ImportedTransaction = {
  id: string;
  date: string;
  amount: number;
  importedId: string | null;
  description: string;
};

/**
 * Newly added transactions that look like one imported earlier: same day,
 * same amount, a bank id that differs. That pattern means the bank changed
 * its transaction ids between downloads (e.g. a different download method),
 * which the duplicate detection cannot see through.
 */
export function findProbableDuplicates(
  added: ImportedTransaction[],
  existing: ImportedTransaction[],
): Array<{ added: ImportedTransaction; existing: ImportedTransaction }> {
  const addedIds = new Set(added.map(t => t.id));
  const earlier = existing.filter(t => !addedIds.has(t.id) && t.importedId);
  const pairs: Array<{
    added: ImportedTransaction;
    existing: ImportedTransaction;
  }> = [];
  const used = new Set<string>();

  for (const t of added) {
    if (!t.importedId) continue;
    const match = earlier.find(
      e =>
        !used.has(e.id) &&
        e.date === t.date &&
        e.amount === t.amount &&
        e.importedId !== t.importedId,
    );
    if (match) {
      used.add(match.id);
      pairs.push({ added: t, existing: match });
    }
  }
  return pairs;
}
