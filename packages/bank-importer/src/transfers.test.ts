import {
  findCounterpart,
  findProbableDuplicates,
  shiftDate,
} from './transfers';
import type { LedgerTransaction } from './transfers';

function ledger(overrides: Partial<LedgerTransaction>): LedgerTransaction {
  return {
    id: 'c1',
    date: '2026-10-07',
    amount: 250000,
    transferId: null,
    isParent: false,
    isTransfer: false,
    ...overrides,
  };
}

const payment = { date: '2026-10-06', amount: -250000 };

describe('findCounterpart', () => {
  it('finds the opposite amount within the window, closest date first', () => {
    const near = ledger({ id: 'near', date: '2026-10-07' });
    const far = ledger({ id: 'far', date: '2026-10-11' });
    expect(findCounterpart(payment, [far, near], new Set())).toBe(near);
  });

  it.each([
    ['same sign', { amount: -250000 }],
    ['different amount', { amount: 396165 }],
    ['already a transfer', { transferId: 'x' }],
    ['transfer payee', { isTransfer: true }],
    ['split parent', { isParent: true }],
    ['outside the window', { date: '2026-10-14' }],
  ])('ignores a candidate with %s', (_, overrides) => {
    expect(findCounterpart(payment, [ledger(overrides)], new Set())).toBeNull();
  });

  it('does not reuse a candidate linked earlier in the run', () => {
    expect(findCounterpart(payment, [ledger({})], new Set(['c1']))).toBeNull();
  });

  it('refuses to guess between two equally close candidates', () => {
    expect(
      findCounterpart(
        payment,
        [
          ledger({ id: 'a', date: '2026-10-05' }),
          ledger({ id: 'b', date: '2026-10-07' }),
        ],
        new Set(),
      ),
    ).toBe('ambiguous');
  });
});

describe('shiftDate', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDate('2026-12-29', 7)).toBe('2027-01-05');
    expect(shiftDate('2026-03-03', -7)).toBe('2026-02-24');
  });
});

describe('findProbableDuplicates', () => {
  const tx = (id: string, importedId: string | null, overrides = {}) => ({
    id,
    date: '2026-10-16',
    amount: 2500,
    importedId,
    description: 'e-Transfer - Autodeposit',
    ...overrides,
  });

  it('flags a new transaction matching an earlier one with another bank id', () => {
    const added = [tx('new', 'S001AAAA0001')];
    const existing = [...added, tx('old', 'S001BBBB0002')];
    expect(findProbableDuplicates(added, existing)).toEqual([
      { added: added[0], existing: existing[1] },
    ]);
  });

  it('ignores same-day transactions added together, and other amounts', () => {
    const added = [tx('a', 'X1'), tx('b', 'X2')];
    const existing = [...added, tx('c', 'X3', { amount: 1000 })];
    expect(findProbableDuplicates(added, existing)).toEqual([]);
  });

  it('ignores earlier transactions without a bank id', () => {
    const added = [tx('new', 'X1')];
    expect(
      findProbableDuplicates(added, [...added, tx('manual', null)]),
    ).toEqual([]);
  });

  it('pairs each earlier transaction at most once', () => {
    const added = [tx('n1', 'A'), tx('n2', 'B')];
    const existing = [...added, tx('old', 'C')];
    expect(findProbableDuplicates(added, existing)).toHaveLength(1);
  });
});
