import { ConfigError, validateConfig } from './config';

const env = { ACTUAL_PASSWORD: 'secret' };
const base = {
  serverUrl: 'http://actual:5006',
  syncId: 'sync-1',
  accounts: [{ ofxAccountId: '1111', actualAccount: 'Visa' }],
};

describe('validateConfig', () => {
  it('applies defaults', () => {
    expect(validateConfig(base, '/import', env)).toEqual({
      serverUrl: 'http://actual:5006',
      password: 'secret',
      syncId: 'sync-1',
      rootDir: '/import',
      defaultCleared: false,
      checkBalances: true,
      dryRun: false,
      accounts: [{ ofxAccountId: '1111', actualAccount: 'Visa' }],
    });
  });

  it('lets the environment override server and sync id', () => {
    const config = validateConfig(base, '/import', {
      ...env,
      ACTUAL_SERVER_URL: 'http://localhost:5016',
      ACTUAL_SYNC_ID: 'other',
    });
    expect(config.serverUrl).toBe('http://localhost:5016');
    expect(config.syncId).toBe('other');
  });

  it.each([
    ['missing password', base, {}, /ACTUAL_PASSWORD/],
    ['no accounts', { ...base, accounts: [] }, env, /non-empty/],
    [
      'bad importFrom',
      {
        ...base,
        accounts: [{ ...base.accounts[0], importFrom: '21/08/2026' }],
      },
      env,
      /YYYY-MM-DD/,
    ],
    [
      'duplicate mapping',
      { ...base, accounts: [base.accounts[0], base.accounts[0]] },
      env,
      /mapped twice/,
    ],
    [
      'missing actualAccount',
      { ...base, accounts: [{ ofxAccountId: '1' }] },
      env,
      /actualAccount is required/,
    ],
  ])('rejects %s', (_, raw, rawEnv, error) => {
    expect(() => validateConfig(raw, '/import', rawEnv)).toThrow(ConfigError);
    expect(() => validateConfig(raw, '/import', rawEnv)).toThrow(error);
  });

  it('allows ignore without actualAccount', () => {
    const config = validateConfig(
      { ...base, accounts: [{ ofxAccountId: '1', ignore: true }] },
      '/import',
      env,
    );
    expect(config.accounts[0]).toEqual({
      ofxAccountId: '1',
      actualAccount: null,
      ignore: true,
    });
  });
});
