// Turns parsed statements into per-account import batches. Pure (no API
// calls) so every decision the importer makes can be unit tested.

import type { AccountMapping } from './config';
import { describeTransaction } from './describe';
import type { OfxStatement } from './ofx';
import { fallbackPayeeName, lookupPayee } from './payees';
import type { PayeeIndex } from './payees';

export type ActualAccount = {
  id: string;
  name: string;
  closed: boolean;
};

export type ImportTx = {
  account: string;
  date: string;
  /** Integer cents */
  amount: number;
  /** Existing payee chosen from history; overrides payee_name */
  payee?: string;
  payee_name: string;
  imported_payee: string;
  imported_id?: string;
  notes?: string;
};

export type ImportBatch = {
  ofxAccountId: string;
  account: ActualAccount;
  transactions: ImportTx[];
  skippedBeforeImportFrom: number;
  /** Transactions whose payee was taken from an earlier transaction */
  payeesFromHistory: number;
  /** Integer cents, from LEDGERBAL */
  statementBalance: number | null;
  statementBalanceDate: string | null;
};

export type ImportPlan = {
  batches: ImportBatch[];
  ignoredAccounts: string[];
  errors: string[];
  warnings: string[];
};

export function buildPlan(
  statements: OfxStatement[],
  mappings: AccountMapping[],
  actualAccounts: ActualAccount[],
  payeeIndex: PayeeIndex | null = null,
): ImportPlan {
  const plan: ImportPlan = {
    batches: [],
    ignoredAccounts: [],
    errors: [],
    warnings: [],
  };

  for (const statement of statements) {
    const label = `account ${maskAccountId(statement.accountId)}`;
    const mapping = mappings.find(
      m => m.ofxAccountId.trim() === statement.accountId.trim(),
    );

    if (!mapping) {
      plan.errors.push(
        `${label} (${statement.kind}, ${statement.currency ?? 'no currency'}) ` +
          `is not in the config. Add an "accounts" entry with ` +
          `"ofxAccountId": "${statement.accountId}".`,
      );
      continue;
    }
    if (mapping.ignore) {
      plan.ignoredAccounts.push(statement.accountId);
      continue;
    }

    const account = resolveAccount(mapping.actualAccount ?? '', actualAccounts);
    if (typeof account === 'string') {
      plan.errors.push(`${label}: ${account}`);
      continue;
    }

    if (
      mapping.currency &&
      statement.currency &&
      mapping.currency !== statement.currency.toUpperCase()
    ) {
      plan.errors.push(
        `${label}: statement currency ${statement.currency} does not match ` +
          `configured currency ${mapping.currency}`,
      );
      continue;
    }

    const transactions: ImportTx[] = [];
    const fitIdCounts = new Map<string, number>();
    let skippedBeforeImportFrom = 0;
    let payeesFromHistory = 0;
    let badAmount = false;

    for (const t of statement.transactions) {
      if (mapping.importFrom && t.date < mapping.importFrom) {
        skippedBeforeImportFrom++;
        continue;
      }

      const amount = parseAmountToCents(t.amount);
      if (amount == null) {
        plan.errors.push(
          `${label}: cannot parse amount "${t.amount}" on ${t.date}`,
        );
        badAmount = true;
        continue;
      }

      const description = describeTransaction(t).text;
      const payeeId = payeeIndex
        ? lookupPayee(payeeIndex, account.id, description)
        : null;
      if (payeeId) payeesFromHistory++;

      let importedId: string | undefined;
      if (t.fitId) {
        // Banks occasionally repeat a FITID within one statement. Without a
        // suffix the second transaction would be matched to the first and
        // silently dropped.
        const seen = fitIdCounts.get(t.fitId) ?? 0;
        fitIdCounts.set(t.fitId, seen + 1);
        importedId = seen === 0 ? t.fitId : `${t.fitId}-${seen + 1}`;
        if (seen > 0) {
          plan.warnings.push(
            `${label}: duplicate FITID ${t.fitId} on ${t.date}; imported as ${importedId}`,
          );
        }
      }

      transactions.push({
        account: account.id,
        date: t.date,
        amount,
        ...(payeeId && { payee: payeeId }),
        payee_name: fallbackPayeeName(description),
        imported_payee: description,
        ...(importedId && { imported_id: importedId }),
        // The full bank description, as SimpleFIN put it in the notes.
        ...(description && { notes: description }),
      });
    }

    if (badAmount) {
      continue;
    }

    const balanceCents = statement.ledgerBalance
      ? parseAmountToCents(statement.ledgerBalance.amount)
      : null;

    plan.batches.push({
      ofxAccountId: statement.accountId,
      account,
      transactions,
      skippedBeforeImportFrom,
      payeesFromHistory,
      statementBalance: balanceCents,
      statementBalanceDate: statement.ledgerBalance?.asOf ?? null,
    });
  }

  return plan;
}

function resolveAccount(
  nameOrId: string,
  accounts: ActualAccount[],
): ActualAccount | string {
  const byId = accounts.find(a => a.id === nameOrId);
  const byName = accounts.filter(
    a => a.name.trim().toLowerCase() === nameOrId.trim().toLowerCase(),
  );
  const match = byId ?? (byName.length === 1 ? byName[0] : null);

  if (!match) {
    return byName.length > 1
      ? `Actual account name "${nameOrId}" is ambiguous; use the account id`
      : `Actual account "${nameOrId}" was not found`;
  }
  if (match.closed) {
    return `Actual account "${match.name}" is closed`;
  }
  return match;
}

/** Converts an OFX amount string to integer cents without float drift. */
export function parseAmountToCents(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '');
  let negative = false;

  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Some banks use a decimal comma.
  if (!s.includes('.') && /^\d+,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return null;
  }

  const [whole, frac = ''] = s.split('.');
  const cents =
    Number(whole) * 100 +
    Number((frac + '00').slice(0, 2)) +
    (Number(frac[2] ?? '0') >= 5 ? 1 : 0);
  return negative && cents !== 0 ? -cents : cents;
}

export function maskAccountId(id: string): string {
  return id.length > 4 ? `…${id.slice(-4)}` : id;
}
