// Packs the Worker for the desktop app's built-in server setup.
//
// Writes app/src-tauri/worker/index.js (the bundled Worker, exactly what `wrangler deploy` uploads)
// and app/src-tauri/worker/worker.json (compatibility settings, cron, variables and D1 migrations).
// The Rust side embeds both, so one installer can create or update the Cloudflare server with
// nothing else installed. Run with `npm run bundle` (the app's build scripts run it for you).
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(serverDir, '../app/src-tauri/worker');
const tmpDir = join(serverDir, '.wrangler', 'bundle');

rmSync(tmpDir, { recursive: true, force: true });
execSync(`npx wrangler deploy --dry-run --env production --outdir "${tmpDir}"`, { cwd: serverDir, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_LOG: "error" } });

const script = readFileSync(join(tmpDir, 'index.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');

const toml = readFileSync(join(serverDir, 'wrangler.toml'), 'utf8');
const section = (name) => {
  const start = toml.indexOf(`[${name}]`);
  if (start < 0) return '';
  const rest = toml.slice(start + name.length + 2);
  const end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
};
const topLevel = toml.slice(0, toml.search(/^\[/m));
const str = (src, key) => src.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const arr = (src, key) => {
  const m = src.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
};

const vars = {};
for (const m of section('env.production.vars').matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)) vars[m[1]] = m[2];

const migrationsDir = join(serverDir, 'migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }));

const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const meta = {
  version: pkg.version,
  compatibilityDate: str(topLevel, 'compatibility_date'),
  compatibilityFlags: arr(topLevel, 'compatibility_flags'),
  crons: arr(section('env.production.triggers'), 'crons'),
  vars,
  migrations,
};
if (!meta.compatibilityDate) throw new Error('compatibility_date not found in wrangler.toml');

const hash = createHash('sha256').update(script).update(JSON.stringify(meta)).digest('hex');
const out = { ...meta, build: `${pkg.version}+${hash.slice(0, 12)}` };

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.js'), script);
writeFileSync(join(outDir, 'worker.json'), JSON.stringify(out, null, 2) + '\n');
rmSync(tmpDir, { recursive: true, force: true });
console.log(`Worker packed for the app: build ${out.build}, ${(script.length / 1024).toFixed(0)} KB, ${migrations.length} migration(s).`);
