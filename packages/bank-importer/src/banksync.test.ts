import { matchBankSyncTransactions } from './banksync';
import type { ExistingTransaction, FileTransaction } from './banksync';

function synced(
  id: string,
  overrides: Partial<ExistingTransaction> = {},
): ExistingTransaction {
  return {
    id,
    date: '2026-04-17',
    amount: 2500,
    importedId: `TRN-${id}`,
    payee: 'payee-a',
    fromBankSync: true,
    ...overrides,
  };
}

function fileTx(overrides: Partial<FileTransaction> = {}): FileTransaction {
  return {
    date: '2026-04-17',
    amount: 2500,
    importedId: 'S001AAAA',
    payee: 'payee-a',
    ...overrides,
  };
}

describe('matchBankSyncTransactions', () => {
  it('matches the same transaction from bank sync', () => {
    const existing = [synced('a')];
    expect(matchBankSyncTransactions([fileTx()], existing).get(0)).toBe(
      existing[0],
    );
  });

  it('tolerates the two sources dating it a few days apart', () => {
    const existing = [synced('a', { date: '2026-04-15' })];
    expect(matchBankSyncTransactions([fileTx()], existing).size).toBe(1);
    expect(
      matchBankSyncTransactions(
        [fileTx()],
        [synced('a', { date: '2026-04-13' })],
      ).size,
    ).toBe(0);
  });

  it.each([
    ['manual entries (Actual matches those itself)', { fromBankSync: false }],
    ['a different amount', { amount: 3546 }],
  ])('ignores %s', (_, overrides) => {
    expect(
      matchBankSyncTransactions([fileTx()], [synced('a', overrides)]).size,
    ).toBe(0);
  });

  it('leaves transactions whose bank id is already present to Actual', () => {
    const existing = [
      synced('ours', { importedId: 'S001AAAA', fromBankSync: false }),
      synced('simplefin'),
    ];
    expect(matchBankSyncTransactions([fileTx()], existing).size).toBe(0);
  });

  it('pairs each bank-sync transaction once, nearest date first', () => {
    const existing = [synced('apr17'), synced('apr18', { date: '2026-04-18' })];
    const matches = matchBankSyncTransactions(
      [
        fileTx({ importedId: 'X1' }),
        fileTx({ importedId: 'X2', date: '2026-04-18' }),
      ],
      existing,
    );
    expect(matches.get(0)?.id).toBe('apr17');
    expect(matches.get(1)?.id).toBe('apr18');
  });

  it('prefers the candidate with the same payee', () => {
    const existing = [
      synced('other', { payee: 'someone-else' }),
      synced('same'),
    ];
    expect(matchBankSyncTransactions([fileTx()], existing).get(0)?.id).toBe(
      'same',
    );
  });

  it('refuses to guess between equally good candidates', () => {
    const existing = [
      synced('before', { date: '2026-04-16' }),
      synced('after', { date: '2026-04-18' }),
    ];
    expect(matchBankSyncTransactions([fileTx()], existing).size).toBe(0);
  });

  it('picks either of two identical same-day candidates (a bank sync duplicate)', () => {
    const existing = [synced('b'), synced('a')];
    expect(matchBankSyncTransactions([fileTx()], existing).get(0)?.id).toBe(
      'a',
    );
  });

  it('a second file transaction with the same amount is imported, not merged', () => {
    const matches = matchBankSyncTransactions(
      [fileTx({ importedId: 'X1' }), fileTx({ importedId: 'X2' })],
      [synced('only-one')],
    );
    expect(matches.size).toBe(1);
  });
});
