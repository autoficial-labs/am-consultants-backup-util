// Seeds the LOCAL development server with realistic demo data:
//  - a Tally-style data folder on disk (demo-data/TallyData) with six companies
//  - five days of backed-up changes (backdated), including a deletion
//  - two complete backups, three users with different access
//  - Tally data snapshots (ledgers and vouchers) that match the backed-up history
//
//   npm run dev                      (in another terminal; or: npx localflare)
//   node scripts/seed-demo.mjs       (wipes the LOCAL database first)
//
// Sign in afterwards as  admin / admin12345.
// Never point this at production: it refuses any non-localhost API_URL.
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API_URL ?? 'http://localhost:8787';
const SETUP_KEY = process.env.SETUP_KEY ?? 'local-setup-key';
const ROOT = path.resolve(process.env.DEMO_DIR ?? path.join(here, '..', '..', 'demo-data', 'TallyData'));
const ADMIN_PASSWORD = 'admin12345';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error('Refusing to seed a non-local server:', BASE);
  process.exit(1);
}

const HOUR = 3_600_000;
const now = Date.now();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const zstd = (b, level = 3) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const words = 'Sales Purchase Receipt Payment Journal Contra Debit Credit Ledger Voucher GST IGST CGST SGST Stock Godown Party Cash Bank Rent Salary Freight Discount Invoice'.split(' ');
function ledgerBytes(size) {
  const parts = [];
  let n = 0;
  while (n < size) {
    const line = `${words[Math.floor(rand() * words.length)]}|${Math.floor(rand() * 99999)}|${(rand() * 100000).toFixed(2)}|${randomBytes(5).toString('hex')}\n`;
    parts.push(line);
    n += line.length;
  }
  return Buffer.from(parts.join('')).subarray(0, size);
}

async function api(method, p, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function d1(sql) {
  const file = path.join(here, '.seed.sql');
  fs.writeFileSync(file, sql);
  try {
    execSync(`npx wrangler d1 execute am_backup --local --file="${file}"`, { cwd: path.join(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---- minimal ustar writer -------------------------------------------------------
function tarHeader(name, size, mtimeSec) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtimeSec, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function buildArchive(files) {
  const chunks = [];
  for (const f of files) {
    chunks.push(tarHeader(f.path, f.data.length, Math.floor(f.mtime / 1000)), f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return zstd(Buffer.concat(chunks), 19);
}

// ---- local folder ------------------------------------------------------------------
const local = new Map(); // rel -> { data, mtime }
function writeLocal(rel, data, mtime) {
  const full = path.join(ROOT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  fs.utimesSync(full, new Date(mtime), new Date(mtime));
  local.set(rel, { data, mtime });
}
function removeLocal(rel) {
  fs.rmSync(path.join(ROOT, ...rel.split('/')), { force: true });
  local.delete(rel);
}

// ------------------------------------------------------------------------------------
console.log(`Seeding demo data into ${BASE}\nDemo folder: ${ROOT}\n`);
await api('GET', '/api/health');

console.log('1/6 Resetting the local database');
d1(
  [
    'DELETE FROM versions;',
    'DELETE FROM files;',
    'DELETE FROM batches;',
    'DELETE FROM blobs;',
    'DELETE FROM full_backups;',
    'DELETE FROM sessions;',
    'DELETE FROM user_paths;',
    "DELETE FROM users WHERE role != 'superadmin';",
    'DELETE FROM audit_log;',
    'DELETE FROM settings;',
    'DELETE FROM tally_snapshots;',
  ].join('\n'),
);

console.log('2/6 Administrator account');
const health = await api('GET', '/api/health');
let token;
if (health.needsSetup) {
  token = (await api('POST', '/api/setup', { body: { setupKey: SETUP_KEY, username: 'admin', displayName: 'Office Administrator', password: ADMIN_PASSWORD } })).token;
} else {
  const r = await api('POST', '/api/setup/reset-admin', { body: { setupKey: SETUP_KEY, password: ADMIN_PASSWORD } });
  token = (await api('POST', '/api/auth/login', { body: { username: r.username, password: ADMIN_PASSWORD } })).token;
  await api('PATCH', '/api/me', { token, body: { displayName: 'Office Administrator' } });
}

console.log('3/6 Building the Tally data folder');
fs.rmSync(ROOT, { recursive: true, force: true });
const companies = [
  { id: '10001', ext: '1800' },
  { id: '10002', ext: '1800' },
  { id: '10003', ext: '900' },
  { id: '10004', ext: '1800' },
  { id: '10005', ext: '1800' },
];
const start = now - 5 * 24 * HOUR;
for (const c of companies) {
  for (const [name, size] of [
    ['Company', 180_000 + Math.floor(rand() * 200_000)],
    ['CmpSave', 60_000],
    ['LinkMgr', 90_000 + Math.floor(rand() * 60_000)],
    ['Manager', 260_000 + Math.floor(rand() * 300_000)],
    ['TranMgr', 900_000 + Math.floor(rand() * 2_400_000)],
  ]) {
    writeLocal(`Data/${c.id}/${name}.${c.ext}`, ledgerBytes(size), start - Math.floor(rand() * 40) * 24 * HOUR);
  }
}
writeLocal('Data/10004/CmpSave_old.1800', ledgerBytes(48_000), start - 90 * 24 * HOUR);
writeLocal('Config/tally.ini', Buffer.from('[Tally]\nUser TDL=No\nData=C:\\TallyPrime\\Data\nDefault Companies=10001,10002\n'), start - 120 * 24 * HOUR);
writeLocal('Config/tallycfg.tsf', ledgerBytes(12_000), start - 60 * 24 * HOUR);

const sql = [];
const known = new Set();
async function sync(at, paths, deletes = []) {
  const b = await api('POST', '/api/batches', { token, body: { device: 'OFFICE-PC' } });
  const changes = [];
  const fresh = [];
  for (const rel of paths) {
    const f = local.get(rel);
    const hash = sha(f.data);
    if (!known.has(hash)) {
      known.add(hash);
      const packed = zstd(f.data);
      await api('PUT', `/api/blobs/${hash}`, { token, raw: packed, headers: { 'x-raw-size': String(f.data.length) } });
      fresh.push(packed.length);
    }
    changes.push({ path: rel, op: 'upsert', hash, size: f.data.length, mtime: f.mtime });
  }
  for (const rel of deletes) changes.push({ path: rel, op: 'delete' });
  for (let i = 0; i < changes.length; i += 200) await api('POST', `/api/batches/${b.id}/changes`, { token, body: { changes: changes.slice(i, i + 200) } });
  const uploaded = fresh.reduce((a, n) => a + n, 0);
  await api('POST', `/api/batches/${b.id}/finish`, { token, body: { status: 'done', bytesUploaded: uploaded } });
  sql.push(
    `UPDATE versions SET created_at = ${at} WHERE batch_id = ${b.id};`,
    `UPDATE batches SET started_at = ${at - 4000}, finished_at = ${at} WHERE id = ${b.id};`,
    `UPDATE files SET updated_at = ${at} WHERE version_id IN (SELECT id FROM versions WHERE batch_id = ${b.id});`,
  );
}

async function fullBackup(at) {
  const files = [...local.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, f]) => ({ path: p, data: f.data, mtime: f.mtime }));
  const original = files.reduce((a, f) => a + f.data.length, 0);
  const archive = buildArchive(files);
  const created = await api('POST', '/api/full-backups', { token, body: { origin: 'scheduled', fileCount: files.length, originalSize: original, level: 19 }, headers: { 'x-device': 'OFFICE-PC' } });
  await api('PUT', `/api/full-backups/${created.id}/data`, { token, raw: archive });
  const manifest = { version: 1, createdAt: at, level: 19, files: files.map((f) => ({ path: f.path, size: f.data.length, mtime: f.mtime, sha256: sha(f.data) })), skipped: [] };
  await api('PUT', `/api/full-backups/${created.id}/manifest`, { token, raw: JSON.stringify(manifest) });
  await api('POST', `/api/full-backups/${created.id}/complete`, { token, body: {} });
  sql.push(`UPDATE full_backups SET created_at = ${at}, completed_at = ${at + 95_000} WHERE id = ${created.id};`);
  return { original, compressed: archive.length };
}

// ---- Tally books for the demo companies (what Tally's XML server would report) -------------
const TALLY_NAMES = {
  '10001': 'Shree Ganesh Traders',
  '10002': 'Mehta Textiles Pvt Ltd',
  '10003': 'Kapoor & Sons',
  '10004': 'Sai Krupa Enterprises',
  '10005': 'Verma Medical Agency',
  '10006': 'Sunrise Exports',
};
const PARTIES = ['Mehta Stores', 'Gupta General Store', 'Patel Brothers', 'Sharma Agencies', 'Rao Distributors', 'Khan Traders', 'Iyer & Co', 'Desai Retail'];
const SUPPLIERS = ['Reliable Mills', 'Om Packaging', 'Bharat Transport'];
const EXPENSES = ['Shop Rent', 'Electricity Charges', 'Salaries', 'Telephone Charges', 'Freight Inward'];
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const books = new Map();
function ledgerOf(b, name) {
  return b.ledgers.find((l) => l.name === name);
}
function post(b, at, type, party, amount, narration) {
  b.master++;
  b.alter++;
  const no = (b.numbers[type] = (b.numbers[type] ?? 0) + 1);
  const v = { guid: `${b.guid}-${b.master}`, masterId: b.master, alterId: b.alter, date: ymd(at), type, number: String(no), party, amount: 0, narration, cancelled: false, optional: false };
  const dr = (n, a) => (ledgerOf(b, n).closing -= a);
  const cr = (n, a) => (ledgerOf(b, n).closing += a);
  if (type === 'Sales') {
    const tax = Math.round(amount * 0.18 * 100) / 100;
    dr(party, amount + tax);
    cr('Sales Accounts', amount);
    cr('Output GST', tax);
    v.amount = -(amount + tax);
  } else if (type === 'Receipt') {
    dr(rand() < 0.5 ? 'Cash' : 'HDFC Bank', amount);
    cr(party, amount);
    v.amount = amount;
  } else if (type === 'Payment') {
    dr(party, amount);
    cr(rand() < 0.4 ? 'Cash' : 'HDFC Bank', amount);
    v.amount = amount;
  } else {
    dr('Purchase Accounts', amount);
    cr(party, amount);
    v.amount = amount;
  }
  b.vouchers.push(v);
  return v;
}
function randomVoucher(b, at) {
  const r = rand();
  const amt = Math.round((2000 + rand() * 60000) / 10) * 10;
  if (r < 0.45) return post(b, at, 'Sales', PARTIES[Math.floor(rand() * PARTIES.length)], amt, `Invoice ${['cotton bales', 'yarn', 'fabric rolls', 'medicines', 'packing material'][Math.floor(rand() * 5)]}`);
  if (r < 0.7) return post(b, at, 'Receipt', PARTIES[Math.floor(rand() * PARTIES.length)], Math.round(amt / 2), 'Payment received');
  if (r < 0.88) return post(b, at, 'Payment', EXPENSES[Math.floor(rand() * EXPENSES.length)], Math.round(amt / 4), 'Paid by bank');
  return post(b, at, 'Purchase', SUPPLIERS[Math.floor(rand() * SUPPLIERS.length)], amt, 'Goods received');
}
function booksFor(id, at) {
  if (books.has(id)) return books.get(id);
  const b = { id, guid: `demo-${id}`, master: 0, alter: 0, numbers: {}, vouchers: [], ledgers: [] };
  const add = (name, group, opening = 0) => b.ledgers.push({ name, group, opening, closing: opening });
  add('Cash', 'Cash-in-Hand', -45000);
  add('HDFC Bank', 'Bank Accounts', -320000);
  add('Capital Account', 'Capital Account', 365000);
  add('Sales Accounts', 'Sales Accounts');
  add('Purchase Accounts', 'Purchase Accounts');
  add('Output GST', 'Duties & Taxes');
  for (const p of PARTIES) add(p, 'Sundry Debtors');
  for (const p of SUPPLIERS) add(p, 'Sundry Creditors');
  for (const e of EXPENSES) add(e, 'Indirect Expenses');
  // Earlier months of the year.
  for (let i = 0; i < 90 + Math.floor(rand() * 60); i++) randomVoucher(b, at - (120 - i) * 24 * HOUR);
  for (const l of b.ledgers) l.opening = l.opening; // opening stays as entered
  books.set(id, b);
  return b;
}
const lastTally = new Map();
async function saveTally(id, at, force = false) {
  if (!force && lastTally.has(id) && at - lastTally.get(id) < HOUR) return;
  const b = booksFor(id, at);
  if (lastTally.has(id)) {
    for (let i = 0, n = 2 + Math.floor(rand() * 5); i < n; i++) randomVoucher(b, at);
    if (rand() < 0.3) {
      const v = b.vouchers[b.vouchers.length - 1 - Math.floor(rand() * 8)];
      v.alterId = ++b.alter;
      v.amount = Math.round(v.amount * 1.1 * 100) / 100;
      v.narration += ' (corrected)';
    }
    if (rand() < 0.15) b.vouchers.splice(b.vouchers.length - 1 - Math.floor(rand() * 5), 1);
  }
  lastTally.set(id, at);
  const fy = new Date(at).getMonth() >= 3 ? new Date(at).getFullYear() : new Date(at).getFullYear() - 1;
  const snapshot = {
    version: 1,
    company: { name: TALLY_NAMES[id], number: id, guid: b.guid, startingFrom: `${fy}-04-01`, booksFrom: `${fy - 2}-04-01` },
    period: { from: ymd(at - 395 * 24 * HOUR), to: ymd(at) },
    ledgers: b.ledgers.map((l) => ({ name: l.name, group: l.group, opening: Math.round(l.opening * 100) / 100, closing: Math.round(l.closing * 100) / 100 })),
    vouchers: b.vouchers.map((v) => ({ ...v })),
  };
  const raw = Buffer.from(JSON.stringify(snapshot));
  const hash = sha(raw);
  await api('PUT', `/api/tally/data/${hash}`, { token, raw: zlib.gzipSync(raw), headers: { 'x-raw-size': String(raw.length) } });
  await api('POST', '/api/tally/snapshots', {
    token,
    body: {
      hash,
      companyKey: id,
      companyName: TALLY_NAMES[id],
      folder: `Data/${id}`,
      capturedAt: at,
      ledgers: snapshot.ledgers.length,
      vouchers: snapshot.vouchers.length,
      lastVoucher: snapshot.vouchers.map((v) => v.date).sort().pop(),
    },
  });
}

console.log('4/6 Replaying five days of work');
await sync(start, [...local.keys()]);
const daily = (d, h) => {
  const t = new Date(now - d * 24 * HOUR);
  t.setHours(h, 0, 0, 0);
  return t.getTime();
};
const touch = (rel, at, grow = 4000 + Math.floor(rand() * 60_000)) => {
  const f = local.get(rel);
  const data = Buffer.concat([f.data.subarray(0, Math.max(0, f.data.length - 2000)), ledgerBytes(grow)]);
  writeLocal(rel, data, at);
  return rel;
};
const work = [];
for (let d = 4; d >= 1; d--) for (const h of [10, 12, 15, 17, 19]) work.push(daily(d, h) + Math.floor(rand() * 40) * 60_000);
const nowH = new Date(now).getHours();
for (let h = Math.max(9, nowH - 10); h < nowH; h++) work.push(daily(0, h) + Math.floor(rand() * 50) * 60_000);
work.push(now - 22 * 60_000, now - 9 * 60_000);
let fulls = 0;
for (const c of companies) await saveTally(c.id, start + HOUR, true);
for (const at of work.filter((t) => t > start && t < now).sort((a, b) => a - b)) {
  if (fulls < 2 && at > daily(2 - fulls, 20) && daily(2 - fulls, 20) < now) {
    const r = await fullBackup(daily(2 - fulls, 20));
    console.log(`   complete backup ${fulls + 1}: ${(r.original / 1e6).toFixed(1)} MB -> ${(r.compressed / 1e6).toFixed(1)} MB`);
    fulls++;
  }
  const c = companies[Math.floor(rand() * companies.length)];
  const changed = [touch(`Data/${c.id}/TranMgr.${c.ext}`, at), touch(`Data/${c.id}/Manager.${c.ext}`, at, 2000)];
  if (rand() < 0.35) changed.push(touch(`Data/${c.id}/LinkMgr.${c.ext}`, at, 1500));
  if (rand() < 0.2) changed.push(touch(`Data/${c.id}/Company.${c.ext}`, at, 800));
  await sync(at, changed);
  await saveTally(c.id, at + 30_000);
}
// A new company two days ago, and an old file removed three hours ago.
const newAt = daily(2, 11) + 7 * 60_000;
for (const name of ['Company', 'CmpSave', 'LinkMgr', 'Manager', 'TranMgr']) writeLocal(`Data/10006/${name}.1800`, ledgerBytes(80_000 + Math.floor(rand() * 400_000)), newAt);
await sync(newAt, ['Company', 'CmpSave', 'LinkMgr', 'Manager', 'TranMgr'].map((n) => `Data/10006/${n}.1800`));
await saveTally('10006', newAt + 30_000, true);
removeLocal('Data/10004/CmpSave_old.1800');
await sync(now - 3 * HOUR - 12 * 60_000, [], ['Data/10004/CmpSave_old.1800']);

console.log('5/6 Users');
for (const u of [
  { username: 'priya', displayName: 'Priya Sharma', access: 'read', scopeMode: 'include', paths: ['Data/10001', 'Data/10002'] },
  { username: 'rahul', displayName: 'Rahul Verma', access: 'write', scopeMode: 'exclude', paths: ['Data/10006'] },
  { username: 'neha', displayName: 'Neha Kapoor', access: 'read', scopeMode: 'all', paths: [] },
]) {
  await api('POST', '/api/users', { token, body: { ...u, password: 'user12345' } });
}

console.log('6/6 Backdating history');
d1(sql.join('\n'));

console.log(`\nDone. ${local.size} files in ${ROOT}`);
console.log('Sign in as admin / admin12345 (users priya, rahul, neha use user12345).');
