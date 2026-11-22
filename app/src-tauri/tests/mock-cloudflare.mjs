// Local stand-in for the parts of the Cloudflare REST API the built-in server setup uses.
// It checks request shapes (multipart upload, bindings, cron, secrets), runs the D1 migration
// SQL in a real SQLite database, and answers the server's health check.
//
//   node tests/mock-cloudflare.mjs            (listens on http://127.0.0.1:8899)
//   $env:AM_CF_MOCK="http://127.0.0.1:8899"; cargo test --test cloudflare -- --nocapture
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8899);
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
const ACCOUNT = { id: 'acc0123456789', name: 'AM True Tax' };

let state;
function reset() {
  state = { r2Enabled: true, subdomain: null, adminCreated: false, workers: new Map(), dbs: new Map(), buckets: new Set(), log: [] };
}
reset();

const ok = (result) => ({ status: 200, body: { success: true, errors: [], messages: [], result } });
const fail = (status, code, message) => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });

function splitSql(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let quote = null;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i = sql.indexOf('*/', i + 2);
      i = i < 0 ? sql.length : i + 2;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function handle(method, path, query, req, rawBody) {
  const json = () => JSON.parse(rawBody.toString('utf8') || 'null');

  // Test controls and the deployed server's health endpoint (no Cloudflare auth).
  if (path === '/__control' && method === 'POST') {
    const b = json() ?? {};
    if (b.reset) reset();
    for (const k of ['r2Enabled', 'subdomain', 'adminCreated']) if (k in b) state[k] = b[k];
    return ok(null);
  }
  if (path === '/__state') {
    const workers = Object.fromEntries([...state.workers].map(([k, w]) => [k, { ...w, script: `${w.script.length} bytes` }]));
    const dbs = Object.fromEntries(
      [...state.dbs].map(([id, d]) => [
        id,
        {
          name: d.name,
          tables: d.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name),
          migrations: d.db.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").all().length
            ? d.db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name)
            : [],
        },
      ]),
    );
    return ok({ workers, dbs, buckets: [...state.buckets], subdomain: state.subdomain, log: state.log });
  }
  const health = path.match(/^\/__worker\/([^/]+)\/api\/health$/);
  if (health) {
    const w = state.workers.get(health[1]);
    if (!w) return { status: 404, body: { error: 'Not found' } };
    const build = w.metadata.bindings.find((b) => b.name === 'SERVER_BUILD')?.text ?? null;
    return { status: 200, body: { ok: true, service: 'am-backup', version: '1.0.0', build, environment: 'production', needsSetup: !state.adminCreated, setupKeyConfigured: Boolean(w.secrets.SETUP_KEY) } };
  }

  if (!path.startsWith('/client/v4/')) return fail(404, 7003, 'No route');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(400, 9109, 'Invalid access token');
  const p = path.slice('/client/v4'.length);
  state.log.push(`${method} ${p}`);

  if (p === '/accounts' && method === 'GET') return ok([ACCOUNT]);
  const m = p.match(/^\/accounts\/([^/]+)(\/.*)$/);
  if (!m) return fail(404, 7003, 'No route');
  if (m[1] !== ACCOUNT.id) return fail(403, 10000, 'Authentication error');
  const rest = m[2];

  // Workers
  if (rest === '/workers/scripts' && method === 'GET') return ok([...state.workers.keys()].map((id) => ({ id })));
  let w = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)(\/.*)?$/);
  if (w) {
    const [, name, sub] = w;
    const worker = state.workers.get(name);
    if (!sub && method === 'PUT') {
      const form = await new Request('http://x/', { method: 'PUT', headers: { 'content-type': req.headers['content-type'] }, body: rawBody }).formData();
      const metaPart = form.get('metadata');
      const metadata = JSON.parse(typeof metaPart === 'string' ? metaPart : await metaPart.text());
      const mod = form.get(metadata.main_module);
      if (!mod || typeof mod === 'string') return fail(400, 10021, `Missing module part ${metadata.main_module}`);
      if (mod.type !== 'application/javascript+module') return fail(400, 10021, `Module part has type ${mod.type}`);
      const script = await mod.text();
      if (!/export\s*\{[^}]*as default/.test(script)) return fail(400, 10021, 'No default export');
      if (!metadata.compatibility_date) return fail(400, 10021, 'compatibility_date missing');
      for (const b of metadata.bindings) {
        if (b.type === 'd1' && !state.dbs.has(b.id)) return fail(400, 10021, `D1 database ${b.id} not found`);
        if (b.type === 'r2_bucket' && !state.buckets.has(b.bucket_name)) return fail(400, 10085, `R2 bucket ${b.bucket_name} not found`);
      }
      const secrets = {};
      if (worker && (metadata.keep_bindings ?? []).includes('secret_text')) Object.assign(secrets, worker.secrets);
      for (const b of metadata.bindings.filter((b) => b.type === 'secret_text')) secrets[b.name] = b.text;
      const bindings = metadata.bindings.filter((b) => b.type !== 'secret_text');
      state.workers.set(name, {
        metadata: { ...metadata, bindings },
        script,
        secrets,
        schedules: worker?.schedules ?? [],
        subdomainEnabled: worker?.subdomainEnabled ?? false,
        uploads: (worker?.uploads ?? 0) + 1,
      });
      return ok({ id: name });
    }
    if (!worker) return fail(404, 10007, 'This Worker does not exist on your account.');
    if (sub === '/settings' && method === 'GET') {
      return ok({ bindings: [...worker.metadata.bindings, ...Object.keys(worker.secrets).map((n) => ({ type: 'secret_text', name: n }))] });
    }
    if (sub === '/schedules' && method === 'PUT') {
      const body = json();
      if (!Array.isArray(body) || body.some((s) => typeof s.cron !== 'string')) return fail(400, 10021, 'Bad schedules body');
      worker.schedules = body.map((s) => s.cron);
      return ok({ schedules: body });
    }
    if (sub === '/subdomain' && method === 'POST') {
      const body = json();
      if (!state.subdomain) return fail(400, 10007, 'Account has no workers.dev subdomain');
      worker.subdomainEnabled = body.enabled === true;
      return ok({ enabled: worker.subdomainEnabled, previews_enabled: body.previews_enabled });
    }
    if (sub === '/secrets' && method === 'PUT') {
      const body = json();
      if (body.type !== 'secret_text' || !body.name || !body.text) return fail(400, 10021, 'Bad secret');
      worker.secrets[body.name] = body.text;
      return ok({ name: body.name, type: body.type });
    }
  }
  if (rest === '/workers/subdomain') {
    if (method === 'GET') return state.subdomain ? ok({ subdomain: state.subdomain }) : fail(404, 10007, 'workers.dev subdomain not found');
    if (method === 'PUT') {
      const { subdomain } = json();
      if (subdomain === 'taken-name') return fail(409, 10036, 'Subdomain is already taken');
      state.subdomain = subdomain;
      return ok({ subdomain });
    }
  }

  // D1
  if (rest === '/d1/database' && method === 'GET') {
    const name = query.get('name');
    return ok([...state.dbs].filter(([, d]) => !name || d.name === name).map(([uuid, d]) => ({ uuid, name: d.name })));
  }
  if (rest === '/d1/database' && method === 'POST') {
    const { name } = json();
    if ([...state.dbs.values()].some((d) => d.name === name)) return fail(400, 7502, 'A database with that name already exists');
    const uuid = randomUUID();
    state.dbs.set(uuid, { name, db: new DatabaseSync(':memory:') });
    return ok({ uuid, name, created_at: new Date().toISOString() });
  }
  w = rest.match(/^\/d1\/database\/([0-9a-f-]+)(\/query)?$/);
  if (w) {
    const d = state.dbs.get(w[1]);
    if (!d) return fail(404, 7404, 'Database not found');
    if (!w[2] && method === 'GET') return ok({ uuid: w[1], name: d.name });
    if (w[2] && method === 'POST') {
      const { sql } = json();
      const results = [];
      try {
        d.db.exec('BEGIN');
        for (const st of splitSql(sql)) {
          if (/^\s*(SELECT|PRAGMA)/i.test(st)) results.push({ results: d.db.prepare(st).all(), success: true, meta: {} });
          else {
            d.db.prepare(st).run();
            results.push({ results: [], success: true, meta: {} });
          }
        }
        d.db.exec('COMMIT');
      } catch (e) {
        d.db.exec('ROLLBACK');
        return fail(400, 7500, `${e.message}`);
      }
      return ok(results);
    }
  }

  // R2
  if (rest.startsWith('/r2/')) {
    if (!state.r2Enabled) return fail(403, 10042, 'Please enable R2 through the Cloudflare Dashboard.');
    if (rest === '/r2/buckets' && method === 'GET') return ok({ buckets: [...state.buckets].map((name) => ({ name })) });
    if (rest === '/r2/buckets' && method === 'POST') {
      const { name } = json();
      if (state.buckets.has(name)) return fail(409, 10004, 'The bucket you tried to create already exists, and you own it.');
      state.buckets.add(name);
      return ok({ name });
    }
  }
  return fail(404, 7003, `No route for ${method} ${p}`);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let out;
    try {
      out = await handle(req.method, url.pathname, url.searchParams, req, Buffer.concat(chunks));
    } catch (e) {
      out = fail(500, 10013, `Mock error: ${e.message}`);
    }
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock Cloudflare API on http://127.0.0.1:${PORT}`));
