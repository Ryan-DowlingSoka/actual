import { describeTransaction } from './describe';
import type { OfxTransaction } from './ofx';

function tx(name: string | null, memo: string | null): OfxTransaction {
  return {
    fitId: 'F',
    type: 'DEBIT',
    date: '2026-10-05',
    amount: '-1.00',
    name,
    memo,
    checkNumber: null,
  };
}

describe('describeTransaction', () => {
  it.each([
    // BMO: the MEMO continues NAME mid-word...
    [
      '[PR]SQ *SUNNY BERRY FARM VAN',
      'COUVER BC CAN ',
      'SQ *SUNNY BERRY FARM VANCOUVER BC CAN',
      'PR',
    ],
    // ...or after a word break, carried as MEMO's leading space
    [
      '[CW]INTERAC ETRNSFR SENT PAT',
      " LEE -ALEX'S MOM 20260000002FGHIJ ",
      "INTERAC ETRNSFR SENT PAT LEE -ALEX'S MOM 20260000002FGHIJ",
      'CW',
    ],
    ['[DN]BMO INV INC.    INV/PLA', null, 'BMO INV INC. INV/PLA', 'DN'],
    ['[CW] TF 0005500000000001111', null, 'TF 0005500000000001111', 'CW'],
  ])('BMO %s + %s', (name, memo, text, code) => {
    expect(describeTransaction(tx(name, memo))).toEqual({
      text,
      bankCode: code,
    });
  });

  it('joins NAME and MEMO with a space for other banks', () => {
    expect(
      describeTransaction(
        tx('Transfer                ', 'WWW TRANSFER - 1234 '),
      ),
    ).toEqual({ text: 'Transfer WWW TRANSFER - 1234', bankCode: null });
  });

  it('does not repeat a MEMO that equals NAME', () => {
    expect(describeTransaction(tx('SHOP', 'SHOP')).text).toBe('SHOP');
  });

  it('handles a missing NAME', () => {
    expect(describeTransaction(tx(null, 'E-TRANSFER')).text).toBe('E-TRANSFER');
  });
});
