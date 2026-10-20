import fs from 'fs';
import path from 'path';

export type AccountMapping = {
  /** ACCTID from the OFX file (account or card number) */
  ofxAccountId: string;
  /** Actual account name or id. Not needed when `ignore` is set. */
  actualAccount: string | null;
  /** Skip this account's statements entirely (e.g. accounts not tracked in Actual) */
  ignore?: boolean;
  /**
   * Ignore transactions dated before this day (YYYY-MM-DD). Used at cutover so
   * transactions already brought in by another source (e.g. SimpleFIN, whose
   * imported ids differ) are not imported a second time.
   */
  importFrom?: string;
  /** Expected CURDEF; files with a different currency are rejected. */
  currency?: string;
};

export type ImporterConfig = {
  serverUrl: string;
  password: string;
  syncId: string;
  encryptionPassword?: string;
  /** Root folder holding inbox/, processed/, failed/, reports/ and cache/ */
  rootDir: string;
  /** Mark newly imported transactions as cleared */
  defaultCleared: boolean;
  /** Warn when Actual's balance differs from the statement balance */
  checkBalances: boolean;
  /** Report what would happen without importing or moving files */
  dryRun: boolean;
  accounts: AccountMapping[];
};

export class ConfigError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ImporterConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `Config file ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return validateConfig(raw, path.dirname(path.resolve(configPath)), env);
}

export function validateConfig(
  raw: Record<string, unknown>,
  defaultRootDir: string,
  env: NodeJS.ProcessEnv = {},
): ImporterConfig {
  const serverUrl = env.ACTUAL_SERVER_URL || stringField(raw, 'serverUrl');
  const syncId = env.ACTUAL_SYNC_ID || stringField(raw, 'syncId');
  const password = env.ACTUAL_PASSWORD;

  if (!serverUrl) throw new ConfigError('serverUrl is required');
  if (!syncId) throw new ConfigError('syncId is required');
  if (!password) {
    throw new ConfigError(
      'ACTUAL_PASSWORD environment variable is required (the server password)',
    );
  }

  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    throw new ConfigError('accounts must be a non-empty array');
  }

  const accounts = raw.accounts.map((entry, i): AccountMapping => {
    const where = `accounts[${i}]`;
    if (typeof entry !== 'object' || entry == null) {
      throw new ConfigError(`${where} must be an object`);
    }
    const a: Record<string, unknown> = { ...entry };
    const ofxAccountId = stringField(a, 'ofxAccountId');
    const actualAccount = stringField(a, 'actualAccount');
    if (!ofxAccountId) {
      throw new ConfigError(`${where}.ofxAccountId is required`);
    }
    const ignore = a.ignore === true;
    if (!actualAccount && !ignore) {
      throw new ConfigError(
        `${where}.actualAccount is required (or set "ignore": true)`,
      );
    }
    const importFrom = stringField(a, 'importFrom');
    if (importFrom != null && !DATE_RE.test(importFrom)) {
      throw new ConfigError(`${where}.importFrom must be YYYY-MM-DD`);
    }
    const currency = stringField(a, 'currency');
    return {
      ofxAccountId,
      actualAccount,
      ...(ignore && { ignore }),
      ...(importFrom != null && { importFrom }),
      ...(currency != null && { currency: currency.toUpperCase() }),
    };
  });

  const seen = new Set<string>();
  for (const a of accounts) {
    if (seen.has(a.ofxAccountId)) {
      throw new ConfigError(`ofxAccountId ${a.ofxAccountId} is mapped twice`);
    }
    seen.add(a.ofxAccountId);
  }

  return {
    serverUrl,
    password,
    syncId,
    ...(env.ACTUAL_ENCRYPTION_PASSWORD && {
      encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
    }),
    rootDir: stringField(raw, 'rootDir') ?? defaultRootDir,
    defaultCleared: raw.defaultCleared === true,
    checkBalances: raw.checkBalances !== false,
    dryRun: raw.dryRun === true,
    accounts,
  };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ConfigError(`${key} must be a string`);
  }
  return value.trim() === '' ? null : value.trim();
}
