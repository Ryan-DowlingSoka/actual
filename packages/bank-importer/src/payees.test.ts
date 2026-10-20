import {
  buildPayeeIndex,
  fallbackPayeeName,
  lookupPayee,
  lookupTransfer,
  payeeKey,
} from './payees';

describe('payeeKey', () => {
  it.each([
    ['AMZN Mktp CA*XY9ZW8VU7 TORONTO ON', 'AMZN MKTP CA TORONTO ON'],
    ['SHOPPERS DRUG MART #22 VANCOUVER', 'SHOPPERS DRUG MART VANCOUVER'],
    [
      'INTERAC ETRNSFR SENT BOUNCE GYM 20260000003KLMNO',
      'INTERAC ETRANSFER SENT BOUNCE GYM',
    ],
    ['[Dn]Bmo Inv Inc.    Inv/Pla', 'BMO INV INC INV PLA'],
    ['SQ *SALON Vancouver BC', 'SQ SALON VANCOUVER BC'],
    ['20260000003', ''],
  ])('%s -> %s', (text, key) => {
    expect(payeeKey(text)).toBe(key);
  });
});

describe('lookupPayee', () => {
  const index = buildPayeeIndex([
    {
      accountId: 'card',
      date: '2026-01-01',
      payeeId: 'old-name',
      transferAccountId: null,
      texts: ['PREMIUM PLAN'],
    },
    {
      accountId: 'card',
      date: '2026-03-01',
      payeeId: 'bank-fee',
      transferAccountId: null,
      texts: ['Premium Plan', 'PREMIUM PLAN'],
    },
    {
      accountId: 'savings',
      date: '2026-04-01',
      payeeId: 'savings-interest',
      transferAccountId: null,
      texts: ['IN'],
    },
    {
      accountId: 'chequing',
      date: '2026-05-01',
      payeeId: 'chequing-interest',
      transferAccountId: null,
      texts: ['IN'],
    },
  ]);

  it('follows the most recent payee for a description', () => {
    expect(lookupPayee(index, 'card', 'PREMIUM PLAN')).toBe('bank-fee');
  });

  it('prefers the same account, then any account', () => {
    expect(lookupPayee(index, 'savings', 'IN')).toBe('savings-interest');
    expect(lookupPayee(index, 'other', 'IN')).toBe('chequing-interest');
  });

  it('matches regardless of reference numbers and order codes', () => {
    expect(lookupPayee(index, 'card', 'PREMIUM PLAN 2026')).toBe('bank-fee');
  });

  it('treats the bank and SimpleFIN spellings of e-transfer alike', () => {
    const etransfer = buildPayeeIndex([
      {
        accountId: 'joint',
        date: '2026-05-01',
        payeeId: 'jin',
        transferAccountId: null,
        texts: ['Interac Etransfer Sent Bounce Gym'],
      },
    ]);
    expect(
      lookupPayee(
        etransfer,
        'joint',
        'INTERAC ETRNSFR SENT BOUNCE GYM 20260000004PQRST',
      ),
    ).toBe('jin');
  });

  it('returns null for unseen or number-only descriptions', () => {
    expect(lookupPayee(index, 'card', 'NEW SHOP')).toBeNull();
    expect(lookupPayee(index, 'card', '12345')).toBeNull();
  });
});

describe('fallbackPayeeName', () => {
  it.each([
    [
      'INTERAC ETRNSFR AD RECVD JANE EXAMPLE 202600000001ABCDE',
      'INTERAC ETRANSFER AD RECVD JANE EXAMPLE',
    ],
    ['AMZN Mktp CA*AB1CD2EF3 TORONTO O', 'AMZN Mktp CA TORONTO O'],
    ['SHOPPERS DRUG MART #22 VANCOUVER', 'SHOPPERS DRUG MART #22 VANCOUVER'],
    ['202600000001ABCDE', '202600000001ABCDE'],
    [
      'INTERAC ETRNSFR SENT ALEX SMITH 20260000004PQRST',
      'INTERAC ETRANSFER SENT ALEX SMITH',
    ],
  ])('%s -> %s', (description, name) => {
    expect(fallbackPayeeName(description)).toBe(name);
  });
});

describe('transfers', () => {
  const index = buildPayeeIndex([
    {
      accountId: 'joint',
      date: '2026-06-01',
      payeeId: 'to-mastercard',
      transferAccountId: 'mastercard',
      texts: ['Tf', 'TF 0005500000000001111'],
    },
    {
      accountId: 'mastercard',
      date: '2026-06-01',
      payeeId: 'to-mastercard',
      transferAccountId: 'mastercard',
      texts: ['PAYMENT TO SELF'],
    },
  ]);

  it('finds a transfer on an exact match in the same account', () => {
    expect(
      lookupTransfer(index, 'joint', '[CW] TF 0005500000000001111'),
    ).toEqual({ payeeId: 'to-mastercard', transferAccountId: 'mastercard' });
    expect(lookupTransfer(index, 'joint', 'TF')).not.toBeNull();
  });

  it('never matches a transfer on merchant words alone', () => {
    // "TF 0456#2222-222" has the same words as "TF 0005..." once digits go.
    expect(lookupTransfer(index, 'joint', 'TF 0456#2222-222')).toBeNull();
    expect(lookupPayee(index, 'joint', 'TF 0456#2222-222')).toBeNull();
  });

  it('never returns a transfer as an ordinary payee', () => {
    expect(lookupPayee(index, 'joint', 'TF 0005500000000001111')).toBeNull();
  });

  it('only reuses transfers within the same account', () => {
    expect(
      lookupTransfer(index, 'savings', 'TF 0005500000000001111'),
    ).toBeNull();
  });

  it('never creates a transfer to the account itself', () => {
    expect(lookupTransfer(index, 'mastercard', 'PAYMENT TO SELF')).toBeNull();
  });
});
