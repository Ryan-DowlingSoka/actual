import fs from 'fs';
import path from 'path';

import { loadConfig } from './config';
import { formatCents, log } from './format';
import { decodeOfxBuffer, parseOfx } from './ofx';
import { maskAccountId, parseAmountToCents } from './plan';

// The API is loaded lazily so `inspect` works without it.
const loadRun = () => import('./run');

const USAGE = `usage:
  bank-importer run [--dry-run] [--watch <seconds>]   import files from <root>/inbox
  bank-importer inspect <file...>                       show the accounts and dates in OFX/QFX files
  bank-importer accounts                                list the Actual accounts (names and ids)
  bank-importer status                                  per mapped account: transaction count, last date, last bank-imported date

options:
  --config <path>   config file (default: $BANK_IMPORTER_CONFIG or /import/config.json)

environment:
  ACTUAL_PASSWORD             server password (required for run/accounts)
  ACTUAL_SERVER_URL           overrides serverUrl from the config
  ACTUAL_ENCRYPTION_PASSWORD  budget encryption password, if the budget is encrypted`;

type Args = {
  command: string;
  files: string[];
  configPath: string;
  dryRun: boolean;
  watchSeconds: number | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: '',
    files: [],
    configPath: process.env.BANK_IMPORTER_CONFIG || '/import/config.json',
    dryRun: false,
    watchSeconds: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--config') {
      args.configPath = argv[++i];
    } else if (arg === '--watch') {
      args.watchSeconds = Number(argv[++i]);
      if (!Number.isFinite(args.watchSeconds) || args.watchSeconds < 10) {
        throw new Error('--watch needs a number of seconds (at least 10)');
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    } else if (!args.command) {
      args.command = arg;
    } else {
      args.files.push(arg);
    }
  }
  return args;
}

function inspect(files: string[]) {
  for (const file of files) {
    console.log(path.basename(file));
    const statements = parseOfx(decodeOfxBuffer(fs.readFileSync(file)));
    for (const s of statements) {
      const dates = s.transactions.map(t => t.date).sort();
      const balance = s.ledgerBalance
        ? parseAmountToCents(s.ledgerBalance.amount)
        : null;
      console.log(
        `  ofxAccountId ${s.accountId} (${s.kind}${s.accountType ? `, ${s.accountType}` : ''}, ${s.currency ?? '?'}): ` +
          `${s.transactions.length} transactions` +
          (dates.length ? ` ${dates[0]} .. ${dates[dates.length - 1]}` : '') +
          (balance != null
            ? `, balance ${formatCents(balance)} as of ${s.ledgerBalance?.asOf ?? '?'}`
            : ''),
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'inspect':
      if (args.files.length === 0) throw new Error('inspect needs a file');
      inspect(args.files);
      return;

    case 'accounts': {
      const config = loadConfig(args.configPath);
      const { getActualAccounts, withBudget } = await loadRun();
      await withBudget(config, async () => {
        for (const a of await getActualAccounts()) {
          console.log(`${a.id}  ${a.name}${a.closed ? ' (closed)' : ''}`);
        }
      });
      return;
    }

    case 'status': {
      const config = loadConfig(args.configPath);
      const { getAccountStatus, withBudget } = await loadRun();
      const statuses = await withBudget(config, () => getAccountStatus(config));
      for (const s of statuses) {
        console.log(
          `${maskAccountId(s.ofxAccountId)} -> "${s.actualAccount}": ` +
            `${s.transactions} transactions, last ${s.lastTransaction ?? 'none'}, ` +
            `last bank-imported ${s.lastBankImported ?? 'none'}; ` +
            (s.importFrom ? `importFrom ${s.importFrom}` : 'no importFrom'),
        );
      }
      return;
    }

    case 'run': {
      const { listInbox, runOnce } = await loadRun();
      let stopping = false;
      let running = false;
      const stop = () => {
        stopping = true;
        if (!running) process.exit(0);
        log('Stopping after the current run finishes');
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);

      const watchMs =
        args.watchSeconds == null ? null : args.watchSeconds * 1000;
      let failed = false;
      let lastMode = '';
      let lastDryRunInbox = '';
      do {
        running = true;
        try {
          // Re-read every cycle so edits on the NAS (account mapping,
          // dryRun) take effect without restarting the container.
          const config = loadConfig(args.configPath);
          const dryRun = args.dryRun || config.dryRun;
          const mode =
            `${dryRun ? 'DRY RUN (nothing imported or moved) ' : ''}` +
            `watching ${path.join(config.rootDir, 'inbox')} for accounts ` +
            config.accounts.map(a => maskAccountId(a.ofxAccountId)).join(', ');
          if (mode !== lastMode) log(mode);
          lastMode = mode;

          // A dry run leaves files in the inbox; report them once, not
          // every cycle, until the inbox changes.
          const inbox = path.join(config.rootDir, 'inbox');
          const signature = listInbox(inbox)
            .map(f => `${f}:${fs.statSync(f).mtimeMs}`)
            .join('|');
          if (dryRun && signature === lastDryRunInbox) {
            failed = false;
          } else {
            const result = await runOnce(config, { dryRun });
            failed = !!result?.files.some(f => f.status === 'failed');
            lastDryRunInbox = dryRun ? signature : '';
          }
        } catch (err) {
          failed = true;
          log(
            `ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
        }
        running = false;
        if (stopping) break;
        if (watchMs != null) {
          await new Promise(r => setTimeout(r, watchMs));
        }
      } while (watchMs != null && !stopping);

      process.exitCode = failed ? 1 : 0;
      return;
    }

    default:
      console.error(USAGE);
      process.exitCode = args.command ? 1 : 0;
  }
}

// When a sync fails, the API rejects an internal promise nobody awaits as
// well as the one we await. Node would crash on it; log it instead and let
// the caller's own error handling (sync retries) decide.
process.on('unhandledRejection', err => {
  log(
    `Unhandled rejection inside the API: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
});

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
