// Local stand-in for Tally's XML server (TallyPrime / Tally.ERP 9, "acts as Server", port 9000).
// Answers the three collection requests AM Backup sends, with Tally's quirks: UTF-16 output for
// vouchers, an invalid &#4; character reference, leading spaces in numbers, LINEERROR replies.
//
//   node tests/mock-tally.mjs                  (listens on http://127.0.0.1:9900)
//   POST /__control {"reset":true,"run":"abc"} resets the data; {"addVoucher":{...}}, {"alter":"<guid>"}, {"remove":"<guid>"}
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9900);
let run = 'x';
let companies;
let ledgers;
let vouchers;
let alter = 100;

function reset(r = run) {
  run = r;
  companies = [
    { name: `Shree Ganesh Traders ${run}`, number: `t${run}1`, guid: `g-${run}-1`, start: '20250401', books: '20230401' },
    { name: `Mehta & Sons ${run}`, number: `t${run}2`, guid: `g-${run}-2`, start: '20250401', books: '20250401' },
  ];
  ledgers = {
    [companies[0].name]: [
      { name: 'Cash', parent: 'Cash-in-Hand', opening: '-25000.00', closing: '-41250.00' },
      { name: 'HDFC Bank', parent: 'Bank Accounts', opening: '-150000.00', closing: '-98500.00' },
      { name: 'Mehta Stores', parent: 'Sundry Debtors', opening: '0', closing: '-11800.00' },
      { name: 'Sales Accounts', parent: 'Sales Accounts', opening: '0', closing: '86400.00' },
      { name: 'Output CGST', parent: 'Duties & Taxes', opening: '0', closing: '3888.00' },
    ],
    [companies[1].name]: [{ name: 'Cash', parent: 'Cash-in-Hand', opening: '-500.00', closing: '-500.00' }],
  };
  const d = (offset) => {
    const t = new Date(Date.now() - offset * 86_400_000);
    return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
  };
  vouchers = {
    [companies[0].name]: [
      { guid: `v-${run}-1`, master: 1, alter: 11, date: d(20), type: 'Sales', number: '101', party: 'Mehta Stores', amount: '-11800.00', narration: 'Invoice for cotton bales' },
      { guid: `v-${run}-2`, master: 2, alter: 12, date: d(12), type: 'Receipt', number: '45', party: 'Mehta Stores', amount: '5000.00', narration: 'Part payment&#4; received' },
      { guid: `v-${run}-3`, master: 3, alter: 13, date: d(3), type: 'Payment', number: '77', party: 'HDFC Bank', amount: '2500.00', narration: 'Shop rent', cancelled: true },
      // Far outside the requested period: must be ignored.
      { guid: `v-${run}-old`, master: 4, alter: 14, date: '20190105', type: 'Journal', number: '1', party: '', amount: '0', narration: 'Old' },
    ],
    [companies[1].name]: [],
  };
}
reset();

const esc = (s) => String(s).replace(/&(?!#\d+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const envelope = (inner) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
const lineError = (msg) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>${esc(msg)}</LINEERROR></DATA></BODY></ENVELOPE>`;
const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1];

function answer(xml) {
  const id = tag(xml, 'ID');
  const company = tag(xml, 'SVCURRENTCOMPANY') && unescape(tag(xml, 'SVCURRENTCOMPANY'));
  if (id === 'AMBCompanies') {
    return envelope(
      companies
        .map(
          (c) =>
            `<COMPANY NAME="${esc(c.name)}" RESERVEDNAME=""><NAME TYPE="String">${esc(c.name)}</NAME><COMPANYNUMBER TYPE="String">${c.number}</COMPANYNUMBER>` +
            `<GUID TYPE="String">${c.guid}</GUID><STARTINGFROM TYPE="Date">${c.start}</STARTINGFROM><BOOKSFROM TYPE="Date">${c.books}</BOOKSFROM></COMPANY>`,
        )
        .join(''),
    );
  }
  if (!companies.some((c) => c.name === company)) return lineError(`Could not set 'SVCurrentCompany' to '${company}'`);
  if (id === 'AMBLedgers') {
    return envelope(
      ledgers[company]
        .map(
          (l) =>
            `<LEDGER NAME="${esc(l.name)}" RESERVEDNAME=""><PARENT TYPE="String">${esc(l.parent)}</PARENT>` +
            `<OPENINGBALANCE TYPE="Amount">${l.opening}</OPENINGBALANCE><CLOSINGBALANCE TYPE="Amount">${l.closing}</CLOSINGBALANCE></LEDGER>`,
        )
        .join(''),
    );
  }
  if (id === 'AMBVouchers') {
    return envelope(
      vouchers[company]
        .map(
          (v) =>
            `<VOUCHER REMOTEID="${v.guid}" VCHTYPE="${esc(v.type)}" ACTION="Create"><DATE TYPE="Date">${v.date}</DATE><GUID TYPE="String">${v.guid}</GUID>` +
            `<NARRATION TYPE="String">${esc(v.narration)}</NARRATION><VOUCHERTYPENAME TYPE="String">${esc(v.type)}</VOUCHERTYPENAME>` +
            `<VOUCHERNUMBER TYPE="String">${esc(v.number)}</VOUCHERNUMBER><PARTYLEDGERNAME TYPE="String">${esc(v.party)}</PARTYLEDGERNAME>` +
            `<ISCANCELLED TYPE="Logical">${v.cancelled ? 'Yes' : 'No'}</ISCANCELLED><ISOPTIONAL TYPE="Logical">No</ISOPTIONAL>` +
            `<AMOUNT TYPE="Amount">${v.amount}</AMOUNT><MASTERID TYPE="Number"> ${v.master}</MASTERID><ALTERID TYPE="Number"> ${v.alter}</ALTERID></VOUCHER>`,
        )
        .join(''),
    );
  }
  return `<RESPONSE>Unknown Request, cannot be processed</RESPONSE>`;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/__control') {
      const b = JSON.parse(body || '{}');
      if (b.reset) reset(b.run ?? run);
      const list = vouchers[companies[0].name];
      if (b.addVoucher) list.push({ master: list.length + 10, alter: ++alter, cancelled: false, ...b.addVoucher });
      if (b.alter) {
        const v = list.find((x) => x.guid === b.alter);
        if (v) Object.assign(v, { alter: ++alter, amount: b.amount ?? v.amount });
      }
      if (b.remove) vouchers[companies[0].name] = list.filter((x) => x.guid !== b.remove);
      if (b.closing) ledgers[companies[0].name].find((l) => l.name === b.closing.name).closing = b.closing.value;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, companies }));
    }
    const out = answer(body);
    // Vouchers come back as UTF-16 with a byte-order mark, as some Tally releases do.
    if (tag(body, 'ID') === 'AMBVouchers') {
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-16' });
      return res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(out, 'utf16le')]));
    }
    res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
    res.end(out);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock Tally XML server on http://127.0.0.1:${PORT}`));
