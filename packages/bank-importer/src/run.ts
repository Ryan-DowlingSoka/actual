import fs from 'fs';
import path from 'path';

import * as api from '@actual-app/api';

import {
  loadBalanceState,
  saveBalanceState,
  shouldUpdateBalance,
} from './balances';
import { BANK_SYNC_WINDOW_DAYS, matchBankSyncTransactions } from './banksync';
import type { ImporterConfig } from './config';
import { formatCents, log } from './format';
import { decodeOfxBuffer, parseOfx } from './ofx';
import { buildPayeeIndex, lookupTransfer } from './payees';
import type { HistoryTransaction, PayeeIndex } from './payees';
import { buildPlan, maskAccountId } from './plan';
import type { ActualAccount, ImportBatch, ImportPlan } from './plan';
import { syncWithRetry } from './sync';
import {
  findCounterpart,
  findProbableDuplicates,
  shiftDate,
  TRANSFER_WINDOW_DAYS,
} from './transfers';

const SUPPORTED_EXTENSIONS = new Set(['.ofx', '.qfx']);
// Files modified more recently than this may still be being copied in.
const SETTLE_MS = 15_000;

export type FileResult = {
  file: string;
  status: 'imported' | 'dry-run' | 'failed';
  errors: string[];
  warnings: string[];
  transfers: { linked: number; created: number };
  accounts: Array<{
    ofxAccount: string;
    actualAccount: string;
    inFile: number;
    skippedBeforeImportFrom: number;
    payeesFromHistory: number;
    matchedBankSync: number;
    added: number;
    matchedExisting: number;
    statementBalance: number | null;
    statementBalanceDate: string | null;
    /** True when the statement balance became the account's bank balance */
    bankBalanceUpdated: boolean;
    actualBalance: number | null;
  }>;
};

export type RunResult = {
  startedAt: string;
  dryRun: boolean;
  files: FileResult[];
};

export function dirs(config: ImporterConfig) {
  return {
    inbox: path.join(config.rootDir, 'inbox'),
    processed: path.join(config.rootDir, 'processed'),
    failed: path.join(config.rootDir, 'failed'),
    reports: path.join(config.rootDir, 'reports'),
    cache: path.join(config.rootDir, 'cache'),
    state: path.join(config.rootDir, 'state'),
  };
}

/** Lists inbox files that are ready to import, oldest first. */
export function listInbox(inboxDir: string, now = Date.now()): string[] {
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => path.join(inboxDir, e.name))
    .filter(f => now - fs.statSync(f).mtimeMs >= SETTLE_MS)
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

// The API's server handle, for the one internal call the public API lacks
// (linking two existing transactions as a transfer). Taken from init()'s
// return value: the module's `internal` export is captured as null by ESM.
let internal: Awaited<ReturnType<typeof api.init>> | null = null;

export async function withBudget<T>(
  config: ImporterConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const cacheDir = dirs(config).cache;
  fs.mkdirSync(cacheDir, { recursive: true });

  internal = await api.init({
    serverURL: config.serverUrl,
    password: config.password,
    dataDir: cacheDir,
  });
  try {
    await api.downloadBudget(config.syncId, {
      password: config.encryptionPassword,
    });
    return await fn();
  } finally {
    await api.shutdown();
    internal = null;
  }
}

/**
 * Every transaction with a payee, for choosing payees. Transfer payees are
 * included with the account they transfer to; payees.ts only reuses them on
 * an exact description match in the same account.
 */
export async function loadPayeeIndex(
  accounts: ActualAccount[],
): Promise<PayeeIndex> {
  const payees = await api.getPayees();
  const transferAccount = new Map(
    payees.filter(p => p.transfer_acct).map(p => [p.id, p.transfer_acct]),
  );
  const today = new Date().toISOString().slice(0, 10);
  const history: HistoryTransaction[] = [];

  for (const account of accounts) {
    const transactions = await api.getTransactions(
      account.id,
      '1970-01-01',
      today,
    );
    for (const t of transactions) {
      if (!t.payee) continue;
      history.push({
        accountId: account.id,
        date: t.date,
        payeeId: t.payee,
        transferAccountId: transferAccount.get(t.payee) ?? null,
        texts: [
          t.imported_payee,
          t.notes,
          ...syncedTexts(t.raw_synced_data),
        ].filter((x): x is string => typeof x === 'string' && x !== ''),
      });
    }
  }
  return buildPayeeIndex(history);
}

/**
 * The bank's original wording kept by bank sync (SimpleFIN) in
 * raw_synced_data. Rules often rewrite notes, so this is the only place the
 * original text of those transactions survives.
 */
export function syncedTexts(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data == null) return [];
    const notes = 'notes' in data ? data.notes : null;
    const payeeName = 'payeeName' in data ? data.payeeName : null;
    return [notes, payeeName].filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export async function getActualAccounts(): Promise<ActualAccount[]> {
  const accounts = await api.getAccounts();
  return accounts.map(a => ({ id: a.id, name: a.name, closed: !!a.closed }));
}

/**
 * Processes every ready file in the inbox. Each file is validated as a whole
 * (every statement must map to an account) before anything is imported.
 */
export async function runOnce(
  config: ImporterConfig,
  { dryRun }: { dryRun: boolean },
): Promise<RunResult | null> {
  const d = dirs(config);
  for (const dir of Object.values(d)) fs.mkdirSync(dir, { recursive: true });

  const files = listInbox(d.inbox);
  if (files.length === 0) {
    return null;
  }

  const result: RunResult = {
    startedAt: new Date().toISOString(),
    dryRun,
    files: [],
  };

  try {
    await withBudget(config, async () => {
      const accounts = await getActualAccounts();
      const payeeIndex = await loadPayeeIndex(accounts);

      for (const file of files) {
        const fileResult = await processFile(
          file,
          config,
          accounts,
          payeeIndex,
          dryRun,
        );
        result.files.push(fileResult);
        logFileResult(fileResult);

        if (!dryRun) {
          // Move each file only once its changes have reached the server
          // (a failed file may have imported some accounts, so sync it too).
          // If the sync fails, this file and the rest stay in the inbox and
          // are retried next run; re-importing them is safe.
          await syncWithRetry(() => api.sync());
          moveFile(
            file,
            fileResult.status === 'failed' ? d.failed : d.processed,
          );
        }
      }
    });
  } finally {
    const reportName = `${result.startedAt.replace(/[:.]/g, '-')}${dryRun ? '-dry-run' : ''}.json`;
    fs.writeFileSync(
      path.join(d.reports, reportName),
      JSON.stringify(result, null, 2),
    );
  }
  return result;
}

async function processFile(
  file: string,
  config: ImporterConfig,
  accounts: ActualAccount[],
  payeeIndex: PayeeIndex,
  dryRun: boolean,
): Promise<FileResult> {
  const fileResult: FileResult = {
    file: path.basename(file),
    status: dryRun ? 'dry-run' : 'imported',
    errors: [],
    warnings: [],
    transfers: { linked: 0, created: 0 },
    accounts: [],
  };
  const fail = (message: string) => {
    fileResult.status = 'failed';
    fileResult.errors.push(message);
    return fileResult;
  };

  if (!SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    return fail(
      `Unsupported file type ${path.extname(file) || '(none)'}; only .ofx and .qfx are supported`,
    );
  }

  let plan: ImportPlan;
  try {
    const statements = parseOfx(decodeOfxBuffer(fs.readFileSync(file)));
    plan = buildPlan(statements, config.accounts, accounts, payeeIndex);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  fileResult.warnings.push(...plan.warnings);
  if (plan.errors.length > 0) {
    fileResult.status = 'failed';
    fileResult.errors.push(...plan.errors);
    return fileResult;
  }

  const addedIds = new Map<string, string[]>();
  for (const batch of plan.batches) {
    try {
      const { summary, added } = await importBatch(batch, config, dryRun);
      fileResult.accounts.push(summary);
      addedIds.set(batch.account.id, added);
    } catch (err) {
      return fail(
        `Import into "${batch.account.name}" failed: ${err instanceof Error ? err.message : String(err)}` +
          (fileResult.accounts.length > 0
            ? ' (earlier accounts in this file were imported; re-running the file is safe)'
            : ''),
      );
    }
  }

  if (!dryRun) {
    try {
      await linkTransfers(addedIds, payeeIndex, fileResult);
    } catch (err) {
      return fail(
        `Linking transfers failed: ${err instanceof Error ? err.message : String(err)}` +
          ' (the transactions were imported; fix the transfers by hand)',
      );
    }
    await warnAboutProbableDuplicates(addedIds, fileResult);
    await updateBankBalances(config, plan, fileResult);
    for (const [i, batch] of plan.batches.entries()) {
      fileResult.accounts[i].actualBalance = await api.getAccountBalance(
        batch.account.id,
      );
    }
  }

  for (const a of fileResult.accounts) {
    if (
      config.checkBalances &&
      !dryRun &&
      // BMO reports a 0.00 balance for accounts with no transactions in the
      // download window, so a statement without transactions proves nothing.
      a.inFile > 0 &&
      a.statementBalance != null &&
      a.actualBalance != null &&
      a.statementBalance !== a.actualBalance
    ) {
      fileResult.warnings.push(
        `"${a.actualAccount}" balance is ${formatCents(a.actualBalance)} in Actual ` +
          `but ${formatCents(a.statementBalance)} on the statement ` +
          `(difference ${formatCents(a.actualBalance - a.statementBalance)})`,
      );
    }
  }

  return fileResult;
}

async function importBatch(
  batch: ImportBatch,
  config: ImporterConfig,
  dryRun: boolean,
): Promise<{ summary: FileResult['accounts'][number]; added: string[] }> {
  const summary = {
    ofxAccount: maskAccountId(batch.ofxAccountId),
    actualAccount: batch.account.name,
    inFile: batch.transactions.length + batch.skippedBeforeImportFrom,
    skippedBeforeImportFrom: batch.skippedBeforeImportFrom,
    payeesFromHistory: batch.payeesFromHistory,
    matchedBankSync: 0,
    added: 0,
    matchedExisting: 0,
    statementBalance: batch.statementBalance,
    statementBalanceDate: batch.statementBalanceDate,
    bankBalanceUpdated: false,
    actualBalance: null as number | null,
  };

  const transactions = await withoutBankSyncDuplicates(batch, dryRun);
  summary.matchedBankSync = batch.transactions.length - transactions.length;

  if (transactions.length > 0) {
    const res = await api.importTransactions(batch.account.id, transactions, {
      defaultCleared: config.defaultCleared,
      dryRun,
    });
    if (res.errors && res.errors.length > 0) {
      throw new Error(res.errors.map(e => e.message).join('; '));
    }
    summary.added = res.added.length;
    summary.matchedExisting = transactions.length - res.added.length;
    return { summary, added: dryRun ? [] : res.added };
  }
  return { summary, added: [] };
}

/**
 * Records each statement's closing balance as the account's bank balance,
 * shown as "Last Balance from Bank" when reconciling. See balances.ts.
 */
async function updateBankBalances(
  config: ImporterConfig,
  plan: ImportPlan,
  fileResult: FileResult,
) {
  const stateFile = path.join(dirs(config).state, 'bank-balances.json');
  const state = loadBalanceState(stateFile);

  for (const [i, batch] of plan.batches.entries()) {
    const summary = fileResult.accounts[i];
    const statement = {
      balance: batch.statementBalance,
      asOf: batch.statementBalanceDate,
      transactionsInFile: summary.inFile,
    };
    if (!shouldUpdateBalance(state[batch.account.id], statement)) continue;

    await api.updateAccount(batch.account.id, {
      balance_current: statement.balance,
    });
    state[batch.account.id] = {
      asOf: statement.asOf,
      balance: statement.balance,
      file: fileResult.file,
    };
    summary.bankBalanceUpdated = true;
  }
  saveBalanceState(stateFile, state);
}

/**
 * Drops file transactions that an earlier bank sync (SimpleFIN) already
 * brought in, and records the bank's id on those transactions so later
 * imports recognise them directly. See banksync.ts.
 */
async function withoutBankSyncDuplicates(
  batch: ImportBatch,
  dryRun: boolean,
): Promise<ImportBatch['transactions']> {
  if (batch.transactions.length === 0) return [];
  const dates = batch.transactions.map(t => t.date).sort();
  const existing = (
    await api.getTransactions(
      batch.account.id,
      shiftDate(dates[0], -BANK_SYNC_WINDOW_DAYS),
      shiftDate(dates[dates.length - 1], BANK_SYNC_WINDOW_DAYS),
    )
  ).map(t => ({
    id: t.id,
    date: t.date,
    amount: t.amount,
    importedId: t.imported_id ?? null,
    payee: t.payee ?? null,
    fromBankSync: !!t.raw_synced_data,
  }));

  const matches = matchBankSyncTransactions(
    batch.transactions.map(t => ({
      date: t.date,
      amount: t.amount,
      importedId: t.imported_id,
      payee: t.payee,
    })),
    existing,
  );

  if (!dryRun) {
    for (const [i, match] of matches) {
      const importedId = batch.transactions[i].imported_id;
      if (importedId) {
        await api.updateTransaction(match.id, { imported_id: importedId });
      }
    }
  }
  return batch.transactions.filter((_, i) => !matches.has(i));
}

async function warnAboutProbableDuplicates(
  addedIds: Map<string, string[]>,
  fileResult: FileResult,
) {
  for (const [accountId, ids] of addedIds) {
    if (ids.length === 0) continue;
    const wanted = new Set(ids);
    const all = (
      await api.getTransactions(accountId, '1970-01-01', '9999-12-31')
    ).map(t => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      importedId: t.imported_id ?? null,
      description: t.imported_payee ?? '',
    }));
    const pairs = findProbableDuplicates(
      all.filter(t => wanted.has(t.id)),
      all,
    );
    for (const { added } of pairs) {
      fileResult.warnings.push(
        `${added.date} ${formatCents(added.amount)} "${added.description}" may be a ` +
          'duplicate: an earlier import has the same date and amount under a ' +
          'different bank id. If so, the bank changed its ids (download the ' +
          'same way each time) - delete the extra one in Actual.',
      );
    }
  }
}

/**
 * Turns newly added transactions into transfers where history says this
 * exact description was a transfer. If the other account already holds the
 * other side (imported from its own bank file), the two are linked; if not,
 * Actual creates the other side, which that account's file later matches.
 */
async function linkTransfers(
  addedIds: Map<string, string[]>,
  payeeIndex: PayeeIndex,
  fileResult: FileResult,
) {
  const payees = await api.getPayees();
  const transferPayees = new Set(
    payees.filter(p => p.transfer_acct).map(p => p.id),
  );
  const payeeForAccount = new Map(
    payees.filter(p => p.transfer_acct).map(p => [p.transfer_acct, p.id]),
  );
  const used = new Set<string>();

  for (const [accountId, ids] of addedIds) {
    if (ids.length === 0) continue;
    const wanted = new Set(ids);
    const added = (
      await api.getTransactions(accountId, '1970-01-01', '9999-12-31')
    )
      .filter(t => wanted.has(t.id))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const t of added) {
      const transfer = lookupTransfer(
        payeeIndex,
        accountId,
        t.imported_payee ?? '',
      );
      const fromPayee = payeeForAccount.get(accountId);
      if (!transfer || !fromPayee || t.is_parent || t.transfer_id) continue;

      const candidates = (
        await api.getTransactions(
          transfer.transferAccountId,
          shiftDate(t.date, -TRANSFER_WINDOW_DAYS),
          shiftDate(t.date, TRANSFER_WINDOW_DAYS),
        )
      ).map(c => ({
        id: c.id,
        date: c.date,
        amount: c.amount,
        transferId: c.transfer_id ?? null,
        isParent: !!c.is_parent,
        isTransfer: !!c.payee && transferPayees.has(c.payee),
      }));
      const counterpart = findCounterpart(t, candidates, used);

      if (counterpart === 'ambiguous') {
        fileResult.warnings.push(
          `${t.date} ${formatCents(t.amount)} "${t.imported_payee}": several ` +
            'possible other sides of this transfer; left as a normal transaction',
        );
      } else if (counterpart) {
        used.add(counterpart.id);
        // The same update the app's "Make transfer" action sends. Actual
        // clears a category by storing null, which the entity type does not
        // model, hence the one assertion.
        const noCategory = null as unknown as undefined;
        if (!internal) {
          throw new Error('The API is not initialised');
        }
        await internal.send('transactions-batch-update', {
          updated: [
            {
              id: t.id,
              payee: transfer.payeeId,
              transfer_id: counterpart.id,
              category: noCategory,
            },
            {
              id: counterpart.id,
              payee: fromPayee,
              transfer_id: t.id,
              category: noCategory,
            },
          ],
          runTransfers: false,
        });
        fileResult.transfers.linked++;
      } else {
        await api.updateTransaction(t.id, { payee: transfer.payeeId });
        fileResult.transfers.created++;
      }
    }
  }
}

function moveFile(file: string, destDir: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, path.join(destDir, `${stamp}_${path.basename(file)}`));
}

function logFileResult(r: FileResult) {
  log(`${r.file}: ${r.status}`);
  if (r.transfers.linked + r.transfers.created > 0) {
    log(
      `  transfers: ${r.transfers.linked} linked to the other account's existing transaction, ` +
        `${r.transfers.created} created`,
    );
  }
  for (const a of r.accounts) {
    log(
      `  ${a.ofxAccount} -> "${a.actualAccount}": ${a.inFile} in file, ` +
        (a.skippedBeforeImportFrom > 0
          ? `${a.skippedBeforeImportFrom} before importFrom, `
          : '') +
        `${a.added} ${r.status === 'dry-run' ? 'would be added' : 'added'}, ` +
        `${a.matchedExisting + a.matchedBankSync} already present` +
        (a.matchedBankSync > 0
          ? ` (${a.matchedBankSync} of them from SimpleFIN)`
          : '') +
        '; ' +
        `${a.payeesFromHistory} payees from history` +
        (a.bankBalanceUpdated && a.statementBalance != null
          ? `; bank balance ${formatCents(a.statementBalance)} as of ${a.statementBalanceDate}`
          : ''),
    );
  }
  for (const w of r.warnings) log(`  WARNING: ${w}`);
  for (const e of r.errors) log(`  ERROR: ${e}`);
}

export type AccountStatus = {
  ofxAccountId: string;
  actualAccount: string;
  importFrom: string | null;
  transactions: number;
  lastTransaction: string | null;
  lastBankImported: string | null;
};

/**
 * For each mapped account: how many transactions it has, the latest one,
 * and the latest that came from a bank import or bank sync (has an
 * imported id).
 */
export async function getAccountStatus(
  config: ImporterConfig,
): Promise<AccountStatus[]> {
  const accounts = await getActualAccounts();
  const today = new Date().toISOString().slice(0, 10);
  const statuses: AccountStatus[] = [];

  for (const mapping of config.accounts) {
    if (mapping.ignore) continue;
    const name = mapping.actualAccount ?? '';
    const account =
      accounts.find(a => a.id === name) ??
      accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (!account) {
      throw new Error(`Actual account "${name}" was not found`);
    }

    const transactions = await api.getTransactions(
      account.id,
      '1970-01-01',
      today,
    );
    const dates = transactions.map(t => t.date).sort();
    const bankDates = transactions
      .filter(t => t.imported_id)
      .map(t => t.date)
      .sort();
    const lastBankImported = bankDates[bankDates.length - 1] ?? null;

    statuses.push({
      ofxAccountId: mapping.ofxAccountId,
      actualAccount: account.name,
      importFrom: mapping.importFrom ?? null,
      transactions: transactions.length,
      lastTransaction: dates[dates.length - 1] ?? null,
      lastBankImported,
    });
  }
  return statuses;
}
