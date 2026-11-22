// End-to-end test of the AM Backup API against a running local server.
//   npm run dev        (or: npx localflare)   — in another terminal
//   npm test
// Safe to run repeatedly: it uses unique usernames and file paths per run.
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, zstdCompressSync } from 'node:zlib';

const BASE = process.env.API_URL ?? 'http://localhost:8787';
const SETUP_KEY = process.env.SETUP_KEY ?? 'local-setup-key';
const RUN = Date.now().toString(36);
const ROOT = `itest-${RUN}`;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function api(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadBlob(token, content) {
  const hash = sha(content);
  const packed = zstdCompressSync(content);
  const r = await api('PUT', `/api/blobs/${hash}`, { token, raw: packed, headers: { 'x-raw-size': String(content.length) } });
  if (r.status !== 200) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.data)}`);
  return { hash, size: content.length };
}

const state = {};

console.log(`AM Backup API integration test against ${BASE}\n`);

await test('health responds', async () => {
  const r = await api('GET', '/api/health');
  eq(r.status, 200, 'status');
  assert(r.data.ok === true, 'ok flag');
  state.needsSetup = r.data.needsSetup;
});

await test('setup rejects a wrong setup key', async () => {
  const r = await api('POST', '/api/setup', { body: { setupKey: 'nope', username: 'admin', password: 'password123' } });
  assert(r.status === 403 || r.status === 409, `expected 403/409, got ${r.status}`);
});

await test('super-admin exists (created now or reset with setup key)', async () => {
  if (state.needsSetup) {
    const r = await api('POST', '/api/setup', {
      body: { setupKey: SETUP_KEY, username: 'admin', displayName: 'Administrator', password: 'admin-pass-123' },
    });
    eq(r.status, 200, `setup ${JSON.stringify(r.data)}`);
    eq(r.data.user.role, 'superadmin', 'role');
    const again = await api('POST', '/api/setup', { body: { setupKey: SETUP_KEY, username: 'admin2', password: 'password123' } });
    eq(again.status, 409, 'second setup');
  } else {
    const r = await api('POST', '/api/setup/reset-admin', { body: { setupKey: SETUP_KEY, password: 'admin-pass-123' } });
    eq(r.status, 200, `reset ${JSON.stringify(r.data)}`);
    state.adminName = r.data.username;
  }
});

await test('login fails with a wrong password, succeeds with the right one', async () => {
  const name = state.adminName ?? 'admin';
  const bad = await api('POST', '/api/auth/login', { body: { username: name, password: 'wrong-password' } });
  eq(bad.status, 401, 'bad login');
  const ok = await api('POST', '/api/auth/login', { body: { username: name, password: 'admin-pass-123' }, headers: { 'x-device': 'itest' } });
  eq(ok.status, 200, `login ${JSON.stringify(ok.data)}`);
  state.admin = ok.data.token;
  eq(ok.data.user.scopeMode, 'all', 'admin scope');
});

await test('/me returns the user and the backup policy', async () => {
  const r = await api('GET', '/api/me', { token: state.admin });
  eq(r.status, 200, 'status');
  assert(r.data.policy.sync.mode, 'policy present');
});

await test('unauthenticated and garbage tokens are rejected', async () => {
  eq((await api('GET', '/api/me')).status, 401, 'no token');
  eq((await api('GET', '/api/me', { token: 'x'.repeat(43) })).status, 401, 'bad token');
});

await test('admin creates users with folder scopes', async () => {
  const mk = async (u, access, scopeMode, paths) => {
    const r = await api('POST', '/api/users', {
      token: state.admin,
      body: { username: `${u}-${RUN}`, displayName: u, password: 'user-pass-123', access, scopeMode, paths },
    });
    eq(r.status, 201, `create ${u}: ${JSON.stringify(r.data)}`);
    return r.data.user;
  };
  state.reader = await mk('reader', 'read', 'include', [`${ROOT}/Data/10001`, `${ROOT}/Data/10001/Sub`]);
  eq(state.reader.paths, [`${ROOT}/Data/10001`], 'nested folders are compacted');
  state.writer = await mk('writer', 'write', 'exclude', [`${ROOT}/Data/Secret`]);
  state.nobody = await mk('nobody', 'read', 'none', []);
  const dup = await api('POST', '/api/users', {
    token: state.admin,
    body: { username: `reader-${RUN}`, displayName: 'x', password: 'user-pass-123' },
  });
  eq(dup.status, 409, 'duplicate username');
  const badScope = await api('POST', '/api/users', {
    token: state.admin,
    body: { username: `e-${RUN}`, displayName: 'x', password: 'user-pass-123', scopeMode: 'include', paths: [] },
  });
  eq(badScope.status, 400, 'include without folders');
  const traversal = await api('POST', '/api/users', {
    token: state.admin,
    body: { username: `t-${RUN}`, displayName: 'x', password: 'user-pass-123', scopeMode: 'include', paths: ['../etc'] },
  });
  eq(traversal.status, 400, 'path traversal rejected');
});

await test('users can sign in', async () => {
  for (const k of ['reader', 'writer', 'nobody']) {
    const r = await api('POST', '/api/auth/login', { body: { username: state[k].username, password: 'user-pass-123' } });
    eq(r.status, 200, `${k} login`);
    state[`${k}Token`] = r.data.token;
  }
});

const files = {
  a: { path: `${ROOT}/Data/10001/Company.900`, content: randomBytes(40_000) },
  b: { path: `${ROOT}/Data/10001/TranMgr.900`, content: Buffer.from(`tran v1 ${RUN} `.repeat(500)) },
  c: { path: `${ROOT}/Data/10002/Company.900`, content: Buffer.from(`other company ${RUN} `.repeat(400)) },
  s: { path: `${ROOT}/Data/Secret/Payroll.900`, content: Buffer.from(`secret ${RUN} `.repeat(100)) },
};

await test('missing-blob check and upload', async () => {
  const hashes = Object.values(files).map((f) => sha(f.content));
  const r = await api('POST', '/api/blobs/missing', { token: state.admin, body: { hashes } });
  eq(r.status, 200, 'status');
  eq(r.data.missing.length, 4, 'all missing at first');
  for (const f of Object.values(files)) f.blob = await uploadBlob(state.admin, f.content);
  const r2 = await api('POST', '/api/blobs/missing', { token: state.admin, body: { hashes } });
  eq(r2.data.missing.length, 0, 'none missing after upload');
});

await test('committing changes refuses unknown file data', async () => {
  const b = await api('POST', '/api/batches', { token: state.admin, body: { device: 'itest' } });
  const r = await api('POST', `/api/batches/${b.data.id}/changes`, {
    token: state.admin,
    body: { changes: [{ path: `${ROOT}/x.bin`, op: 'upsert', hash: 'a'.repeat(64), size: 1, mtime: 1 }] },
  });
  eq(r.status, 409, 'missing blob rejected');
  await api('POST', `/api/batches/${b.data.id}/finish`, { token: state.admin, body: { status: 'done' } });
});

await test('first sync run records adds', async () => {
  const b = await api('POST', '/api/batches', { token: state.admin, body: { device: 'itest' } });
  eq(b.status, 200, 'batch');
  const changes = Object.values(files).map((f) => ({ path: f.path, op: 'upsert', hash: f.blob.hash, size: f.blob.size, mtime: 1_700_000_000_000 }));
  const r = await api('POST', `/api/batches/${b.data.id}/changes`, { token: state.admin, body: { changes } });
  eq(r.status, 200, `commit ${JSON.stringify(r.data)}`);
  eq(r.data.add, 4, 'adds');
  const again = await api('POST', `/api/batches/${b.data.id}/changes`, { token: state.admin, body: { changes } });
  eq(again.data.skipped, 4, 'identical re-commit is skipped');
  const fin = await api('POST', `/api/batches/${b.data.id}/finish`, { token: state.admin, body: { status: 'done', bytesUploaded: 1234 } });
  eq(fin.status, 200, 'finish');
  state.batch1 = b.data.id;
});

await sleep(30);
state.t1 = Date.now();
await sleep(30);

await test('second sync run records modify and delete', async () => {
  files.b.content = Buffer.from(`tran v2 ${RUN} `.repeat(600));
  files.b.blob = await uploadBlob(state.admin, files.b.content);
  const b = await api('POST', '/api/batches', { token: state.admin });
  const r = await api('POST', `/api/batches/${b.data.id}/changes`, {
    token: state.admin,
    body: {
      changes: [
        { path: files.b.path, op: 'upsert', hash: files.b.blob.hash, size: files.b.blob.size, mtime: 1_700_000_100_000 },
        { path: files.c.path, op: 'delete' },
        { path: `${ROOT}/never-existed.txt`, op: 'delete' },
      ],
    },
  });
  eq([r.data.modify, r.data.delete, r.data.skipped], [1, 1, 1], 'modify/delete/skip counts');
  await api('POST', `/api/batches/${b.data.id}/finish`, { token: state.admin, body: { status: 'done' } });
});

await test('point-in-time snapshot shows the earlier state', async () => {
  const now = await api('GET', '/api/snapshot', { token: state.admin });
  const mine = now.data.files.filter((f) => f.path.startsWith(ROOT));
  eq(mine.length, 3, 'current file count');
  eq(mine.find((f) => f.path === files.b.path).hash, files.b.blob.hash, 'current has v2');
  const then = await api('GET', `/api/snapshot?at=${state.t1}`, { token: state.admin });
  const old = then.data.files.filter((f) => f.path.startsWith(ROOT));
  eq(old.length, 4, 'earlier file count includes the deleted file');
  assert(old.find((f) => f.path === files.b.path).hash !== files.b.blob.hash, 'earlier has v1');
});

await test('timeline and per-file history', async () => {
  const t = await api('GET', `/api/timeline?from=${state.t1 - 60_000}`, { token: state.admin });
  eq(t.status, 200, 'timeline');
  assert(t.data.events.filter((e) => e.path.startsWith(ROOT)).length >= 6, 'events present');
  const v = await api('GET', `/api/versions?path=${encodeURIComponent(files.b.path)}`, { token: state.admin });
  eq(v.data.versions.map((x) => x.op), ['modify', 'add'], 'history order');
});

await test('read-only user sees only shared folders', async () => {
  const snap = await api('GET', '/api/snapshot', { token: state.readerToken });
  const paths = snap.data.files.map((f) => f.path);
  assert(paths.length > 0 && paths.every((p) => p.startsWith(`${ROOT}/Data/10001/`) || !p.startsWith(ROOT)), 'scoped');
  assert(!paths.some((p) => p.startsWith(ROOT) && !p.startsWith(`${ROOT}/Data/10001/`)), 'no other folders');
  const folders = await api('GET', '/api/folders', { token: state.readerToken });
  assert(folders.data.folders.every((f) => !f.path.includes('Secret')), 'folders scoped');
});

await test('read-only user can download allowed data but not other data', async () => {
  const ok = await api('GET', `/api/blobs/${files.a.blob.hash}`, { token: state.readerToken });
  eq(ok.status, 200, 'allowed download');
  eq(ok.headers.get('x-raw-size'), String(files.a.content.length), 'raw size header');
  const denied = await api('GET', `/api/blobs/${files.s.blob.hash}`, { token: state.readerToken });
  eq(denied.status, 403, 'denied download');
});

await test('read-only user cannot upload', async () => {
  const r = await api('POST', '/api/batches', { token: state.readerToken });
  eq(r.status, 403, 'batch denied');
  const p = await api('PUT', `/api/blobs/${'b'.repeat(64)}`, { token: state.readerToken, raw: Buffer.from('x'), headers: { 'x-raw-size': '1' } });
  eq(p.status, 403, 'upload denied');
});

await test('writer can back up allowed folders but not excluded ones', async () => {
  const content = Buffer.from(`writer file ${RUN}`);
  const blob = await uploadBlob(state.writerToken, content);
  const b = await api('POST', '/api/batches', { token: state.writerToken });
  const ok = await api('POST', `/api/batches/${b.data.id}/changes`, {
    token: state.writerToken,
    body: { changes: [{ path: `${ROOT}/Data/10002/Notes.txt`, op: 'upsert', hash: blob.hash, size: blob.size, mtime: 5 }] },
  });
  eq(ok.status, 200, 'allowed write');
  const denied = await api('POST', `/api/batches/${b.data.id}/changes`, {
    token: state.writerToken,
    body: { changes: [{ path: `${ROOT}/Data/Secret/x.txt`, op: 'upsert', hash: blob.hash, size: blob.size, mtime: 5 }] },
  });
  eq(denied.status, 403, 'excluded write');
  await api('POST', `/api/batches/${b.data.id}/finish`, { token: state.writerToken, body: { status: 'done' } });
});

await test('user with no folders sees nothing', async () => {
  const snap = await api('GET', '/api/snapshot', { token: state.nobodyToken });
  eq(snap.data.files.length, 0, 'no files');
});

await test('non-admins cannot manage users or settings', async () => {
  eq((await api('GET', '/api/users', { token: state.writerToken })).status, 403, 'list users');
  eq((await api('PUT', '/api/settings', { token: state.writerToken, body: {} })).status, 403, 'settings');
  eq((await api('GET', '/api/full-backups', { token: state.readerToken })).status, 403, 'full backups');
});

await test('multipart upload of large file data', async () => {
  const content = randomBytes(6 * 1024 * 1024 + 123);
  const hash = sha(content);
  const key = `blobs/${hash.slice(0, 2)}/${hash}`;
  const start = await api('POST', '/api/uploads', { token: state.admin, body: { key, size: content.length } });
  eq(start.status, 200, `create ${JSON.stringify(start.data)}`);
  const partSize = 5 * 1024 * 1024;
  const parts = [];
  for (let i = 0, n = 1; i < content.length; i += partSize, n++) {
    const r = await api('PUT', `/api/uploads/${encodeURIComponent(start.data.uploadId)}/parts/${n}?key=${encodeURIComponent(key)}`, {
      token: state.admin,
      raw: content.subarray(i, i + partSize),
    });
    eq(r.status, 200, `part ${n}: ${JSON.stringify(r.data)}`);
    parts.push(r.data);
  }
  const done = await api('POST', `/api/uploads/${encodeURIComponent(start.data.uploadId)}/complete`, {
    token: state.admin,
    body: { key, parts, size: content.length },
  });
  eq(done.status, 200, `complete ${JSON.stringify(done.data)}`);
  const missing = await api('POST', '/api/blobs/missing', { token: state.admin, body: { hashes: [hash] } });
  eq(missing.data.missing.length, 0, 'blob registered');
  const badKey = await api('POST', '/api/uploads', { token: state.admin, body: { key: '../../etc/passwd', size: 1 } });
  eq(badKey.status, 400, 'bad key rejected');
});

await test('complete backup lifecycle: create, upload, manifest, list, ranged download, delete', async () => {
  const archive = zstdCompressSync(Buffer.from('pretend tar archive '.repeat(1000)));
  const c = await api('POST', '/api/full-backups', { token: state.admin, body: { origin: 'manual', fileCount: 4, originalSize: 20000, level: 19 } });
  eq(c.status, 200, 'create');
  const id = c.data.id;
  const early = await api('POST', `/api/full-backups/${id}/complete`, { token: state.admin, body: {} });
  eq(early.status, 409, 'cannot complete before upload');
  eq((await api('PUT', `/api/full-backups/${id}/data`, { token: state.admin, raw: archive })).status, 200, 'data');
  eq(
    (await api('PUT', `/api/full-backups/${id}/manifest`, { token: state.admin, raw: JSON.stringify({ files: [{ path: 'a', size: 1 }] }) })).status,
    200,
    'manifest',
  );
  const done = await api('POST', `/api/full-backups/${id}/complete`, { token: state.admin, body: {} });
  eq(done.status, 200, `complete ${JSON.stringify(done.data)}`);
  eq(done.data.compressedSize, archive.length, 'size recorded');
  const list = await api('GET', '/api/full-backups', { token: state.admin });
  assert(list.data.backups.some((b) => b.id === id && b.status === 'complete'), 'listed');
  const full = await api('GET', `/api/full-backups/${id}/download`, { token: state.admin });
  eq(Buffer.from(full.data).equals(archive), true, 'download matches');
  const part = await api('GET', `/api/full-backups/${id}/download`, { token: state.admin, headers: { range: 'bytes=10-' } });
  eq(part.status, 206, 'range status');
  eq(Buffer.from(part.data).equals(archive.subarray(10)), true, 'range content');
  const man = await api('GET', `/api/full-backups/${id}/manifest`, { token: state.admin });
  eq(man.data.files.length, 1, 'manifest content');
  eq((await api('DELETE', `/api/full-backups/${id}`, { token: state.admin })).status, 200, 'delete');
});

await test('settings are sanitised and saved', async () => {
  const r = await api('PUT', '/api/settings', {
    token: state.admin,
    body: { policy: { sync: { mode: 'interval', intervalMinutes: 1, tallyProcesses: ['Tally.EXE', '', 'tally.exe'] }, full: { time: '25:99', keep: 999 } } },
  });
  eq(r.status, 200, 'save');
  eq(r.data.policy.sync.intervalMinutes, 5, 'interval clamped');
  eq(r.data.policy.sync.tallyProcesses, ['tally.exe'], 'process names lower-cased and de-duplicated');
  eq(r.data.policy.sync.tallyMode, 'quiet', 'Tally mode defaults to backing up while Tally is open');
  const close = await api('PUT', '/api/settings', { token: state.admin, body: { policy: { sync: { tallyMode: 'close', tallyQuietSeconds: 5 } } } });
  eq([close.data.policy.sync.tallyMode, close.data.policy.sync.tallyQuietSeconds], ['close', 30], 'Tally mode saved and quiet time clamped');
  const bogus = await api('PUT', '/api/settings', { token: state.admin, body: { policy: { sync: { tallyMode: 'bogus' } } } });
  eq(bogus.data.policy.sync.tallyMode, 'quiet', 'unknown Tally mode falls back to quiet');
  eq(r.data.policy.full.time, '20:00', 'invalid time replaced');
  eq(r.data.policy.full.keep, 365, 'keep clamped');
  // restore defaults
  await api('PUT', '/api/settings', { token: state.admin, body: { policy: {} } });
});

await test('Tally snapshots: upload, record, permissions, download', async () => {
  const snap = {
    version: 1,
    capturedAt: Date.now(),
    company: { name: `Shree Traders ${RUN}`, number: '10001' },
    ledgers: [{ name: 'Cash', group: 'Cash-in-Hand', opening: -1000, closing: -2500 }],
    vouchers: [{ guid: 'g1', alterId: 5, date: '2026-11-20', type: 'Sales', number: '1', party: 'Cash', amount: 1180 }],
  };
  const raw = Buffer.from(JSON.stringify(snap));
  const hash = sha(raw);
  const gz = gzipSync(raw);
  const up = await api('PUT', `/api/tally/data/${hash}`, { token: state.writerToken, raw: gz, headers: { 'x-raw-size': String(raw.length) } });
  eq(up.status, 200, 'upload snapshot data');
  const again = await api('PUT', `/api/tally/data/${hash}`, { token: state.writerToken, raw: gz, headers: { 'x-raw-size': String(raw.length) } });
  eq(again.data.stored, false, 'same data is stored once');
  const ro = await api('PUT', `/api/tally/data/${hash}`, { token: state.readerToken, raw: gz, headers: { 'x-raw-size': String(raw.length) } });
  eq(ro.status, 403, 'read-only user cannot upload snapshot data');
  const key = `t-${RUN}`;
  const noData = await api('POST', '/api/tally/snapshots', {
    token: state.writerToken,
    body: { hash: sha(Buffer.from(`none-${RUN}`)), companyKey: key, companyName: 'x', folder: `${ROOT}/Data/10001`, capturedAt: Date.now() },
  });
  eq(noData.status, 400, 'a snapshot needs its data uploaded first');
  const denied = await api('POST', '/api/tally/snapshots', {
    token: state.writerToken,
    body: { hash, companyKey: key, companyName: 'x', folder: `${ROOT}/Data/Secret`, capturedAt: Date.now() },
  });
  eq(denied.status, 403, 'writer cannot record a snapshot for an excluded folder');
  const rec = await api('POST', '/api/tally/snapshots', {
    token: state.writerToken,
    body: { hash, companyKey: key, companyName: snap.company.name, folder: `${ROOT}/Data/10001`, capturedAt: snap.capturedAt, ledgers: 1, vouchers: 1, lastVoucher: '2026-11-20' },
  });
  eq(rec.status, 200, `record snapshot: ${JSON.stringify(rec.data)}`);
  const comps = await api('GET', '/api/tally/companies', { token: state.readerToken });
  assert(comps.data.companies.some((c) => c.companyKey === key && c.snapshots === 1 && c.vouchers === 1), 'reader sees the company of a shared folder');
  const none = await api('GET', '/api/tally/companies', { token: state.nobodyToken });
  assert(!none.data.companies.some((c) => c.companyKey === key), 'user without folders does not see it');
  const list = await api('GET', `/api/tally/snapshots?company=${encodeURIComponent(key)}`, { token: state.readerToken });
  eq(list.data.snapshots.length, 1, 'snapshot listed');
  const id = list.data.snapshots[0].id;
  const data = await api('GET', `/api/tally/snapshots/${id}/data`, { token: state.readerToken });
  eq(data.status, 200, 'download');
  eq(data.data.vouchers?.[0]?.guid, 'g1', 'gzip data arrives as JSON');
  const hidden = await api('GET', `/api/tally/snapshots/${id}/data`, { token: state.nobodyToken });
  eq(hidden.status, 404, 'hidden from users without access');
});

await test('stats and audit log', async () => {
  const s = await api('GET', '/api/stats', { token: state.admin });
  eq(s.status, 200, 'stats');
  assert(s.data.files >= 3, 'file count');
  const a = await api('GET', '/api/audit', { token: state.admin });
  assert(a.data.events.some((e) => e.action === 'user.created'), 'audit has user.created');
  const rs = await api('GET', '/api/stats', { token: state.readerToken });
  eq(rs.data.storedBytes, null, 'reader does not see storage totals');
});

await test('changing a user scope takes effect immediately', async () => {
  const r = await api('PATCH', `/api/users/${state.nobody.id}`, { token: state.admin, body: { scopeMode: 'include', paths: [`${ROOT}/Data/10002`] } });
  eq(r.status, 200, 'patch');
  const snap = await api('GET', '/api/snapshot', { token: state.nobodyToken });
  assert(snap.data.files.length > 0 && snap.data.files.every((f) => f.path.startsWith(`${ROOT}/Data/10002/`)), 'new scope applied');
});

await test('revoking access signs the user out', async () => {
  const r = await api('PATCH', `/api/users/${state.reader.id}`, { token: state.admin, body: { disabled: true } });
  eq(r.status, 200, 'revoke');
  eq((await api('GET', '/api/me', { token: state.readerToken })).status, 401, 'token rejected');
  const login = await api('POST', '/api/auth/login', { body: { username: state.reader.username, password: 'user-pass-123' } });
  eq(login.status, 403, 'login blocked');
  await api('PATCH', `/api/users/${state.reader.id}`, { token: state.admin, body: { disabled: false } });
  const back = await api('POST', '/api/auth/login', { body: { username: state.reader.username, password: 'user-pass-123' } });
  eq(back.status, 200, 'restored access');
});

await test('administrator cannot be revoked or deleted', async () => {
  const me = await api('GET', '/api/me', { token: state.admin });
  eq((await api('PATCH', `/api/users/${me.data.user.id}`, { token: state.admin, body: { disabled: true } })).status, 403, 'revoke admin');
  eq((await api('DELETE', `/api/users/${me.data.user.id}`, { token: state.admin })).status, 403, 'delete admin');
});

await test('password change requires the current password', async () => {
  const bad = await api('PATCH', '/api/me', { token: state.writerToken, body: { currentPassword: 'nope', newPassword: 'new-pass-1234' } });
  eq(bad.status, 400, 'wrong current');
  const ok = await api('PATCH', '/api/me', { token: state.writerToken, body: { currentPassword: 'user-pass-123', newPassword: 'new-pass-1234' } });
  eq(ok.status, 200, 'changed');
  const login = await api('POST', '/api/auth/login', { body: { username: state.writer.username, password: 'new-pass-1234' } });
  eq(login.status, 200, 'login with new password');
});

await test('lockout after repeated failures', async () => {
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { body: { username: state.nobody.username, password: 'bad-password' } });
  const r = await api('POST', '/api/auth/login', { body: { username: state.nobody.username, password: 'user-pass-123' } });
  eq(r.status, 429, 'locked');
  const unlock = await api('PATCH', `/api/users/${state.nobody.id}`, { token: state.admin, body: { unlock: true } });
  eq(unlock.status, 200, 'unlock');
  eq((await api('POST', '/api/auth/login', { body: { username: state.nobody.username, password: 'user-pass-123' } })).status, 200, 'login after unlock');
});

await test('maintenance runs', async () => {
  const r = await api('POST', '/api/maintenance', { token: state.admin });
  eq(r.status, 200, `maintenance ${JSON.stringify(r.data)}`);
});

await test('deleting users', async () => {
  for (const k of ['reader', 'writer', 'nobody']) {
    eq((await api('DELETE', `/api/users/${state[k].id}`, { token: state.admin })).status, 200, `delete ${k}`);
  }
  const r = await api('POST', '/api/auth/login', { body: { username: state.reader.username, password: 'user-pass-123' } });
  eq(r.status, 401, 'deleted user cannot sign in');
});

await test('logout ends the session', async () => {
  eq((await api('POST', '/api/auth/logout', { token: state.admin })).status, 200, 'logout');
  eq((await api('GET', '/api/me', { token: state.admin })).status, 401, 'token dead');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
