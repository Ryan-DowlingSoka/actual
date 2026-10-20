import fs from 'fs';
import path from 'path';

import { decodeOfxBuffer, OfxParseError, parseOfx, parseOfxDate } from './ofx';

function fixture(name: string) {
  return decodeOfxBuffer(
    fs.readFileSync(path.join(__dirname, '__fixtures__', name)),
  );
}

describe('parseOfx', () => {
  it('reads a BMO-style SGML credit card statement', () => {
    const [statement, ...rest] = parseOfx(fixture('bmo-creditcard.ofx'));
    expect(rest).toHaveLength(0);
    expect(statement).toMatchObject({
      kind: 'creditcard',
      accountId: '5500000000001111',
      currency: 'CAD',
      ledgerBalance: { amount: '-123.45', asOf: '2026-10-19' },
    });
    expect(statement.transactions).toHaveLength(4);
    expect(statement.transactions[0]).toEqual({
      fitId: '5500000000002222202609211655474',
      type: 'DEBIT',
      date: '2026-09-21',
      amount: '-190.00',
      name: 'NORTH CLINIC VANCOUVBC',
      memo: null,
      checkNumber: null,
    });
    expect(statement.transactions[1].name).toBe('BEER & WINE- VANCO');
  });

  it('keeps each account of an RBC-style multi-account QFX separate', () => {
    const statements = parseOfx(fixture('rbc-multi-account.qfx'));
    expect(
      statements.map(s => [s.accountId, s.accountType, s.currency]),
    ).toEqual([
      ['000000001111', 'CHECKING', 'USD'],
      ['000000002222', 'SAVINGS', 'CAD'],
    ]);
    expect(statements[0].transactions).toHaveLength(1);
    expect(statements[1].transactions).toHaveLength(3);
    expect(statements[1].transactions[0]).toMatchObject({
      type: 'CHECK',
      checkNumber: '000101',
      date: '2026-07-21',
    });
    expect(statements[1].transactions[1]).toMatchObject({
      name: 'Transfer',
      memo: 'WWW TRANSFER - 1234',
    });
    expect(statements[1].ledgerBalance).toEqual({
      amount: '2000.00',
      asOf: '2026-10-18',
    });
  });

  it('reads OFX 2.x XML with a nested PAYEE and UTF-8 text', () => {
    const [statement] = parseOfx(fixture('ofx2-xml.ofx'));
    expect(statement.accountId).toBe('9999');
    expect(statement.transactions).toEqual([
      {
        fitId: 'A1',
        type: 'DEBIT',
        date: '2026-10-01',
        amount: '-12.5',
        name: 'Café Olé',
        memo: 'Latte',
        checkNumber: null,
      },
    ]);
  });

  it('ignores pending transactions (OFX 2 BANKTRANLISTP)', () => {
    const [statement] = parseOfx(
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>1</BANKACCTFROM>' +
        '<BANKTRANLIST><STMTTRN><DTPOSTED>20261001<TRNAMT>-1.00<FITID>A</STMTTRN></BANKTRANLIST>' +
        '<BANKTRANLISTP><STMTTRNP><DTTRAN>20261002<TRNAMT>-2.00<NAME>PENDING</STMTTRNP></BANKTRANLISTP>' +
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    );
    expect(statement.transactions.map(t => t.fitId)).toEqual(['A']);
  });

  it('rejects files that are not OFX', () => {
    expect(() => parseOfx('Date,Amount\n2026-01-01,5')).toThrow(OfxParseError);
  });

  it('rejects investment statements instead of ignoring them', () => {
    expect(() =>
      parseOfx('<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>CAD'),
    ).toThrow(/Investment/);
  });

  it('rejects transactions without a date or amount', () => {
    expect(() =>
      parseOfx(
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>1</BANKACCTFROM>' +
          '<BANKTRANLIST><STMTTRN><TRNAMT>-1.00<FITID>X</STMTTRN></BANKTRANLIST></STMTRS>',
      ),
    ).toThrow(/missing DTPOSTED/);
  });
});

describe('parseOfxDate', () => {
  it.each([
    ['20261019224917.946[-5:EDT]', '2026-10-19'],
    ['20261018', '2026-10-18'],
    ['20261301', null],
    ['', null],
    [null, null],
  ])('%s -> %s', (input, expected) => {
    expect(parseOfxDate(input)).toBe(expected);
  });
});
