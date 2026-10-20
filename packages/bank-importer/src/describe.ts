// Turns a statement line's NAME / MEMO into one readable description.

import type { OfxTransaction } from './ofx';

export type Description = {
  /** Full bank description, single-spaced, without the BMO type code */
  text: string;
  /** BMO transaction type code such as CW, DN, PR (null for other banks) */
  bankCode: string | null;
};

// BMO chequing/savings exports prefix NAME with a two-letter type code and
// cut it at 32 characters, continuing the rest of the description in MEMO.
const BMO_CODE_RE = /^\s*\[([A-Z]{2})\]/;

export function describeTransaction(t: OfxTransaction): Description {
  const name = t.name ?? '';
  const memo = t.memo ?? '';

  const code = name.match(BMO_CODE_RE);
  if (code) {
    // Join exactly as the bank split it: a word break, if any, is the
    // leading space of MEMO ("...SENT PAT" + " LEE" vs "...VAN" + "COUVER").
    return {
      text: squash(name.slice(code[0].length) + memo),
      bankCode: code[1],
    };
  }

  const parts = [squash(name), squash(memo)].filter(Boolean);
  // Some banks repeat NAME in MEMO; don't say it twice.
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return { text: parts.join(' '), bankCode: null };
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
