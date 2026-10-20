// Account-aware OFX/QFX parser.
//
// Actual's built-in OFX parser flattens every statement in a file into one
// list, which loses which account a transaction belongs to. Banks such as RBC
// export several accounts in one file, so this parser keeps each statement
// (one per account) separate. It accepts both OFX 1.x (SGML, no closing tags
// on leaf elements) and OFX 2.x (XML).

export type OfxTransaction = {
  fitId: string | null;
  type: string | null;
  /** YYYY-MM-DD */
  date: string;
  /** Raw TRNAMT string as found in the file */
  amount: string;
  /** NAME and MEMO keep their leading whitespace; see describe.ts */
  name: string | null;
  memo: string | null;
  checkNumber: string | null;
};

export type OfxStatement = {
  kind: 'bank' | 'creditcard';
  accountId: string;
  bankId: string | null;
  accountType: string | null;
  currency: string | null;
  ledgerBalance: { amount: string; asOf: string | null } | null;
  transactions: OfxTransaction[];
};

type OfxNode = {
  name: string;
  value: string | null;
  children: OfxNode[];
};

export class OfxParseError extends Error {}

export function decodeOfxBuffer(buffer: Buffer): string {
  const head = buffer.subarray(0, 1024).toString('latin1');
  const isUtf8 =
    /ENCODING:\s*UTF-?8/i.test(head) || /encoding="utf-?8"/i.test(head);
  if (isUtf8) {
    return buffer.toString('utf8');
  }
  try {
    return new TextDecoder('windows-1252').decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

export function parseOfx(content: string): OfxStatement[] {
  const start = content.search(/<OFX>/i);
  if (start === -1) {
    throw new OfxParseError('Not an OFX file: no <OFX> element found');
  }

  const root = buildTree(content.slice(start));

  if (findAll(root, 'INVSTMTRS').length > 0) {
    throw new OfxParseError(
      'Investment statements (INVSTMTRS) are not supported',
    );
  }

  const statements = [
    ...findAll(root, 'STMTRS').map(node => readStatement(node, 'bank')),
    ...findAll(root, 'CCSTMTRS').map(node => readStatement(node, 'creditcard')),
  ];

  if (statements.length === 0) {
    throw new OfxParseError(
      'OFX file contains no bank or credit card statements',
    );
  }
  return statements;
}

function buildTree(sgml: string): OfxNode {
  const root: OfxNode = { name: '#root', value: null, children: [] };
  const stack: OfxNode[] = [root];
  const tokenRe = /<(\/?)([A-Za-z0-9._]+)>([^<]*)/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(sgml)) !== null) {
    const [, slash, rawName, content] = match;
    const name = rawName.toUpperCase();
    const parent = stack[stack.length - 1];

    if (slash) {
      // Close the nearest open aggregate with this name. Closing tags of
      // leaf elements (XML style) were already consumed with the leaf.
      const index = stack.map(n => n.name).lastIndexOf(name);
      if (index > 0) {
        stack.length = index;
      }
      continue;
    }

    if (content.trim() !== '') {
      // Keep leading spaces: BMO continues a description from NAME into
      // MEMO, and a leading space in MEMO is the word break between them.
      const value = content.replace(/^[\r\n]+/, '').trimEnd();
      parent.children.push({
        name,
        value: decodeEntities(value),
        children: [],
      });
      // Skip an immediately following matching close tag (OFX 2.x leaf).
      const closeTag = `</${rawName}>`;
      if (
        sgml
          .slice(tokenRe.lastIndex, tokenRe.lastIndex + closeTag.length)
          .toUpperCase() === closeTag.toUpperCase()
      ) {
        tokenRe.lastIndex += closeTag.length;
      }
    } else {
      const node: OfxNode = { name, value: null, children: [] };
      parent.children.push(node);
      stack.push(node);
    }
  }

  return root;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function findAll(node: OfxNode, name: string): OfxNode[] {
  const found: OfxNode[] = [];
  for (const child of node.children) {
    if (child.name === name) {
      found.push(child);
    } else {
      found.push(...findAll(child, name));
    }
  }
  return found;
}

function child(node: OfxNode | undefined, name: string): OfxNode | undefined {
  return node?.children.find(c => c.name === name);
}

function text(node: OfxNode | undefined, name: string): string | null {
  const value = child(node, name)?.value?.trim();
  return value == null || value === '' ? null : value;
}

/** Like text(), but keeps leading whitespace (used for NAME and MEMO). */
function rawText(node: OfxNode | undefined, name: string): string | null {
  const value = child(node, name)?.value;
  return value == null || value.trim() === '' ? null : value;
}

function readStatement(
  node: OfxNode,
  kind: OfxStatement['kind'],
): OfxStatement {
  const from = child(node, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM');
  const accountId = text(from, 'ACCTID');
  if (!accountId) {
    throw new OfxParseError('Statement is missing its account id (ACCTID)');
  }

  const ledger = child(node, 'LEDGERBAL');
  const ledgerAmount = text(ledger, 'BALAMT');

  const tranList = child(node, 'BANKTRANLIST');
  const transactions = (tranList?.children ?? [])
    .filter(c => c.name === 'STMTTRN')
    .map(t => readTransaction(t, accountId));

  return {
    kind,
    accountId,
    bankId: text(from, 'BANKID'),
    accountType: text(from, 'ACCTTYPE'),
    currency: text(node, 'CURDEF'),
    ledgerBalance: ledgerAmount
      ? { amount: ledgerAmount, asOf: parseOfxDate(text(ledger, 'DTASOF')) }
      : null,
    transactions,
  };
}

function readTransaction(node: OfxNode, accountId: string): OfxTransaction {
  const date = parseOfxDate(text(node, 'DTPOSTED'));
  const amount = text(node, 'TRNAMT');
  if (!date || !amount) {
    throw new OfxParseError(
      `Transaction in account ${accountId} is missing DTPOSTED or TRNAMT` +
        ` (FITID ${text(node, 'FITID') ?? 'none'})`,
    );
  }

  return {
    fitId: text(node, 'FITID'),
    type: text(node, 'TRNTYPE'),
    date,
    amount,
    name: rawText(node, 'NAME') ?? rawText(child(node, 'PAYEE'), 'NAME'),
    memo: rawText(node, 'MEMO'),
    checkNumber: text(node, 'CHECKNUM'),
  };
}

/** OFX dates look like YYYYMMDD[HHMMSS[.XXX]][[offset:TZ]]; keep the day. */
export function parseOfxDate(value: string | null): string | null {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${y}-${m}-${d}`;
}
