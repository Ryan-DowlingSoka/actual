# Bank importer

Imports bank statement files (OFX / QFX) dropped into a folder into the Actual
budget. Imports go through `@actual-app/api` `importTransactions`, the same
reconcile, duplicate-detection and rules path as importing a file in the app,
and changes reach the server as normal sync messages. Nothing touches the
SQLite files directly.

## Folder layout

Everything lives under one root folder (`/import` in the container; the folder
containing `config.json`):

| Path          | Purpose                                                           |
| ------------- | ----------------------------------------------------------------- |
| `config.json` | Account mapping (below)                                           |
| `inbox/`      | Drop `.ofx` / `.qfx` files here                                   |
| `processed/`  | Files that imported successfully, prefixed with a timestamp       |
| `failed/`     | Files that were rejected; the reason is in the log and the report |
| `reports/`    | One JSON report per run                                           |
| `cache/`      | The API's local copy of the budget (safe to delete)               |
| `state/`      | `bank-balances.json`: as-of date of each account's bank balance   |

Files are only picked up once they have not changed for 15 seconds, and only
moved out of `inbox/` after the import has synced to the server.

## Config

```json
{
  "serverUrl": "http://actual:5006",
  "syncId": "<your budget sync id>",
  "defaultCleared": false,
  "checkBalances": true,
  "accounts": [
    {
      "ofxAccountId": "5500000000001111",
      "actualAccount": "Mastercard",
      "currency": "CAD"
    },
    { "ofxAccountId": "000000002222", "actualAccount": "Savings" },
    { "ofxAccountId": "000000010133", "ignore": true }
  ]
}
```

- `ofxAccountId`: the `ACCTID` in the file. Run `inspect` on a file to list them.
- `actualAccount`: the Actual account name (case-insensitive) or id. Run
  `accounts` to list them.
- `currency` (optional): reject the file if the statement currency differs.
- `importFrom` (optional, rarely needed): ignore transactions before this
  date. Not needed when switching over from SimpleFIN: transactions SimpleFIN
  already brought in are recognised (see "Bank sync overlap" below).
- `ignore`: skip an account that appears in the bank's export but is not
  tracked in Actual.

Pending transactions are never imported: OFX keeps them in a separate
pending list, which is ignored (BMO and RBC downloads leave them out anyway).

A file is rejected as a whole, with nothing imported, if any account in it is
not in the config, maps to a missing, closed or ambiguous Actual account, or has
an unreadable amount.

Secrets come from the environment, not the config: `ACTUAL_PASSWORD` (required),
`ACTUAL_ENCRYPTION_PASSWORD` (only for end-to-end encrypted budgets).
`ACTUAL_SERVER_URL` and `ACTUAL_SYNC_ID` override the config values.

## What each transaction gets

- **Notes and imported payee**: the bank's full description. BMO splits long
  descriptions across the OFX `NAME` and `MEMO` fields behind a type code such
  as `[CW]`; these are joined back together and the code dropped, giving the
  same text bank sync used to put in the notes.
- **Payee**: chosen from the budget's own history. If the same description
  (ignoring reference numbers, order codes like `*XY9ZW8VU7` and store
  numbers) was imported before, the payee of the most recent such transaction
  is reused, preferring the same account. Renaming a payee in Actual
  therefore carries forward to later imports. History includes the raw text
  bank sync kept (`raw_synced_data`), so rules that rewrote notes don't hide
  it. A description never seen before becomes the payee name, minus reference
  numbers. Your rules then run as usual (most set categories by payee).
- **Transfers**: if the exact description (account numbers included) was a
  transfer last time in this account, the new transaction becomes a transfer
  too. When the other account already has the other side (from its own bank
  file, opposite amount, within 7 days) the two are linked, as the app's
  "Make transfer" does; otherwise Actual creates the other side, which that
  account's file later matches instead of duplicating. If two candidates are
  equally close, nothing is linked and a warning is logged. Link a new kind of
  transfer by hand once and later ones follow.

## Bank balance (reconciling)

Each statement's closing balance (`LEDGERBAL`) becomes the account's bank
balance, the value bank sync used to store. The reconcile menu shows it as
"Last Balance from Bank", with "Use last synced total" to fill it in. It is
only updated from a statement at least as recent as the one last used
(tracked in `state/bank-balances.json`, so re-importing an old file never
rolls it back), and never from a statement with no transactions, since BMO
reports 0.00 for accounts without activity in the download window.

## Bank sync overlap (switching from SimpleFIN)

Transactions SimpleFIN brought in carry SimpleFIN's ids, never the bank's, so
Actual's own duplicate detection would import them again. Before importing,
each file transaction whose bank id is not already in the account is compared
with the account's bank-sync transactions (those with `raw_synced_data`):
same amount, dated within 3 days, preferring the same date and then the same
payee. The best match is treated as already present, and the bank's id is
recorded on it so later imports recognise it directly. Equally good
candidates on different dates are not guessed between (the transaction is
imported and the duplicate warning may fire); identical ones on the same date
are interchangeable. Manual entries are left to Actual's own matching.

## Commands

```sh
bank-importer inspect <file...>             # accounts, date range and balance in a file (no server needed)
bank-importer accounts                      # Actual account names and ids
bank-importer status                        # per mapped account: transaction count, last date, last bank-imported date
bank-importer run --dry-run                 # what would be added; nothing imported or moved
bank-importer run                           # import once
bank-importer run --watch 300               # import, then check the inbox every 5 minutes (container default)
```

Each account line in the log shows how many transactions were in the file,
how many were skipped by `importFrom`, how many were added and how many were
already present. After a real import, the importer compares Actual's account
balance with the statement balance and logs a warning if they differ. Statements with no
transactions are not checked: BMO reports a 0.00 balance for accounts that had
no activity in the download window.

## Downloading from the banks

- **BMO**: download as OFX / Quicken. BMO's `ACCTID` is not the account number
  (it is the client card number plus an index), so map accounts using `inspect`
  plus the balance or transfer descriptions, e.g. `TF 0123#1111-111`.
- **RBC**: download from each account's own page, one account per file:
  open the account, filter the transactions to the date range, then use the
  download button on that page and choose Quicken (`.qfx`). This export
  includes e-transfer sender names in `MEMO`. The site-wide "Download
  Transactions" page does not (only `E-TRF AUTODEPOSIT`).
  **Always use the per-account download**: RBC gives the same transaction a
  different id in each export, so mixing them imports everything twice. The
  importer warns ("may be a duplicate") when a new transaction has the same
  date and amount as an earlier import with a different id. Overlapping date
  ranges are otherwise harmless.

## Development

```sh
yarn workspace @actual-app/bank-importer test
yarn workspace @actual-app/bank-importer typecheck
yarn build:api && yarn workspace @actual-app/bank-importer build
node packages/bank-importer/dist/index.js inspect some-file.qfx
```

Local Docker test stack (server on a copy of the data + importer):
see `local-test.compose.yml` at the repo root.
