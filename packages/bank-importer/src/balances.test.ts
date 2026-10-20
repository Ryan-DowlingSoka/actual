import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  loadBalanceState,
  saveBalanceState,
  shouldUpdateBalance,
} from './balances';

const statement = {
  balance: -12345,
  asOf: '2026-10-19',
  transactionsInFile: 521,
};
const previous = { asOf: '2026-10-12', balance: -1000, file: 'old.ofx' };

describe('shouldUpdateBalance', () => {
  it('updates when there is no earlier balance', () => {
    expect(shouldUpdateBalance(undefined, statement)).toBe(true);
  });

  it('updates from a newer or same-day statement', () => {
    expect(shouldUpdateBalance(previous, statement)).toBe(true);
    expect(
      shouldUpdateBalance({ ...previous, asOf: '2026-10-19' }, statement),
    ).toBe(true);
  });

  it('never replaces a newer balance with an older statement', () => {
    expect(
      shouldUpdateBalance({ ...previous, asOf: '2026-10-20' }, statement),
    ).toBe(false);
  });

  it('skips statements without a balance or without transactions', () => {
    expect(
      shouldUpdateBalance(undefined, { ...statement, balance: null }),
    ).toBe(false);
    expect(shouldUpdateBalance(undefined, { ...statement, asOf: null })).toBe(
      false,
    );
    expect(
      shouldUpdateBalance(undefined, { ...statement, transactionsInFile: 0 }),
    ).toBe(false);
  });
});

describe('balance state file', () => {
  it('round-trips and starts empty when missing or corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balances-'));
    const file = path.join(dir, 'state', 'bank-balances.json');
    expect(loadBalanceState(file)).toEqual({});

    saveBalanceState(file, { acct: previous });
    expect(loadBalanceState(file)).toEqual({ acct: previous });

    fs.writeFileSync(file, '{not json');
    expect(loadBalanceState(file)).toEqual({});
    fs.rmSync(dir, { recursive: true });
  });
});
