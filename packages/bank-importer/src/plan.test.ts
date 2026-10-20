import type { AccountMapping } from './config';
import type { OfxStatement, OfxTransaction } from './ofx';
import { buildPayeeIndex } from './payees';
import { buildPlan, parseAmountToCents } from './plan';
import type { ActualAccount } from './plan';

const accounts: ActualAccount[] = [
  { id: 'acc-visa', name: 'BMO Mastercard', closed: false },
  { id: 'acc-chq', name: 'RBC Chequing', closed: false },
  { id: 'acc-old', name: 'Old Account', closed: true },
  { id: 'acc-dup1', name: 'Dup', closed: false },
  { id: 'acc-dup2', name: 'dup', closed: false },
];

function tx(overrides: Partial<OfxTransaction> = {}): OfxTransaction {
  return {
    fitId: 'F1',
    type: 'DEBIT',
    date: '2026-09-01',
    amount: '-10.00',
    name: 'SHOP',
    memo: null,
    checkNumber: null,
    ...overrides,
  };
}

function statement(
  transactions: OfxTransaction[],
  overrides: Partial<OfxStatement> = {},
): OfxStatement {
  return {
    kind: 'creditcard',
    accountId: '1111',
    bankId: null,
    accountType: null,
    currency: 'CAD',
    ledgerBalance: { amount: '-123.45', asOf: '2026-10-19' },
    transactions,
    ...overrides,
  };
}

const mapping: AccountMapping = {
  ofxAccountId: '1111',
  actualAccount: 'BMO Mastercard',
};

describe('buildPlan', () => {
  it('maps transactions to the configured Actual account', () => {
    const plan = buildPlan(
      [statement([tx({ name: '  SHOP   ONE  ', memo: 'ref 9' })])],
      [mapping],
      accounts,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].account.id).toBe('acc-visa');
    expect(plan.batches[0].statementBalance).toBe(-12345);
    expect(plan.batches[0].transactions).toEqual([
      {
        account: 'acc-visa',
        date: '2026-09-01',
        amount: -1000,
        payee_name: 'SHOP ONE ref 9',
        imported_payee: 'SHOP ONE ref 9',
        imported_id: 'F1',
        notes: 'SHOP ONE ref 9',
      },
    ]);
  });

  it('resolves accounts by id and by case-insensitive name', () => {
    const plan = buildPlan(
      [
        statement([tx()]),
        statement([tx()], { accountId: '2222', kind: 'bank' }),
      ],
      [mapping, { ofxAccountId: '2222', actualAccount: 'acc-chq' }],
      accounts.map(a =>
        a.id === 'acc-visa' ? { ...a, name: 'bmo MASTERCARD' } : a,
      ),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.batches.map(b => b.account.id)).toEqual([
      'acc-visa',
      'acc-chq',
    ]);
  });

  it('fails the file for an account that is not configured', () => {
    const plan = buildPlan(
      [statement([tx()]), statement([tx()], { accountId: '3333' })],
      [mapping],
      accounts,
    );
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toMatch(/"ofxAccountId": "3333"/);
  });

  it('skips accounts marked ignore', () => {
    const plan = buildPlan(
      [statement([tx()], { accountId: '3333' })],
      [{ ofxAccountId: '3333', actualAccount: null, ignore: true }],
      accounts,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.batches).toEqual([]);
    expect(plan.ignoredAccounts).toEqual(['3333']);
  });

  it.each([
    ['Missing', /was not found/],
    ['Old Account', /is closed/],
    ['Dup', /ambiguous/],
  ])('rejects Actual account %s', (actualAccount, error) => {
    const plan = buildPlan(
      [statement([tx()])],
      [{ ofxAccountId: '1111', actualAccount }],
      accounts,
    );
    expect(plan.batches).toEqual([]);
    expect(plan.errors[0]).toMatch(error);
  });

  it('rejects a currency mismatch', () => {
    const plan = buildPlan(
      [statement([tx()], { currency: 'USD' })],
      [{ ...mapping, currency: 'CAD' }],
      accounts,
    );
    expect(plan.errors[0]).toMatch(/currency USD/);
  });

  it('drops transactions before importFrom', () => {
    const plan = buildPlan(
      [
        statement([
          tx({ fitId: 'A', date: '2026-08-20' }),
          tx({ fitId: 'B', date: '2026-08-21' }),
          tx({ fitId: 'C', date: '2026-09-01' }),
        ]),
      ],
      [{ ...mapping, importFrom: '2026-08-21' }],
      accounts,
    );
    expect(plan.batches[0].skippedBeforeImportFrom).toBe(1);
    expect(plan.batches[0].transactions.map(t => t.imported_id)).toEqual([
      'B',
      'C',
    ]);
  });

  it('keeps repeated FITIDs distinct so neither is dropped', () => {
    const plan = buildPlan(
      [statement([tx(), tx({ amount: '-3.00' }), tx({ amount: '-4.00' })])],
      [mapping],
      accounts,
    );
    expect(plan.batches[0].transactions.map(t => t.imported_id)).toEqual([
      'F1',
      'F1-2',
      'F1-3',
    ]);
    expect(plan.warnings).toHaveLength(2);
  });

  it('falls back to the memo when there is no name', () => {
    const plan = buildPlan(
      [
        statement([
          tx({ name: null, memo: 'E-TRANSFER' }),
          tx({ fitId: null }),
        ]),
      ],
      [mapping],
      accounts,
    );
    const [first, second] = plan.batches[0].transactions;
    expect(first.payee_name).toBe('E-TRANSFER');
    expect(first.notes).toBe('E-TRANSFER');
    expect(second.imported_id).toBeUndefined();
  });

  it('joins a BMO description split across NAME and MEMO', () => {
    const plan = buildPlan(
      [
        statement([
          tx({
            name: '[CW]INTERAC ETRNSFR AD RECVD JAN',
            memo: 'E EXAMPLE 202600000001ABCDE',
          }),
        ]),
      ],
      [mapping],
      accounts,
    );
    expect(plan.batches[0].transactions[0]).toMatchObject({
      payee_name: 'INTERAC ETRANSFER AD RECVD JANE EXAMPLE',
      imported_payee: 'INTERAC ETRNSFR AD RECVD JANE EXAMPLE 202600000001ABCDE',
      notes: 'INTERAC ETRNSFR AD RECVD JANE EXAMPLE 202600000001ABCDE',
    });
  });

  it('uses the payee from history when the description was seen before', () => {
    const index = buildPayeeIndex([
      {
        accountId: 'acc-visa',
        date: '2026-05-01',
        payeeId: 'payee-amazon',
        transferAccountId: null,
        texts: ['AMZN Mktp CA*XY9ZW8VU7 TORONTO ON'],
      },
    ]);
    const plan = buildPlan(
      [
        statement([
          tx({ name: 'AMZN Mktp CA*AB1CD2EF3 TORONTO ON' }),
          tx({ fitId: 'F2', name: 'NEW SHOP VANCOUVER' }),
        ]),
      ],
      [mapping],
      accounts,
      index,
    );
    const [amazon, other] = plan.batches[0].transactions;
    expect(amazon.payee).toBe('payee-amazon');
    expect(amazon.notes).toBe('AMZN Mktp CA*AB1CD2EF3 TORONTO ON');
    expect(other.payee).toBeUndefined();
    expect(other.payee_name).toBe('NEW SHOP VANCOUVER');
    expect(plan.batches[0].payeesFromHistory).toBe(1);
  });

  it('fails the account on an unparseable amount', () => {
    const plan = buildPlan(
      [statement([tx({ amount: 'abc' })])],
      [mapping],
      accounts,
    );
    expect(plan.batches).toEqual([]);
    expect(plan.errors[0]).toMatch(/cannot parse amount "abc"/);
  });
});

describe('parseAmountToCents', () => {
  it.each([
    ['-190.00', -19000],
    ['0.25', 25],
    ['6975', 697500],
    ['+12.5', 1250],
    ['(30.00)', -3000],
    ['-0.01', -1],
    ['1,50', 150],
    ['19.995', 2000],
    ['0.10', 10],
    ['-1234567.89', -123456789],
    [' -9.04 ', -904],
    ['abc', null],
    ['1.2.3', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });
});
