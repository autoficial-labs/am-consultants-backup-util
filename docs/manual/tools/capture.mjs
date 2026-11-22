// Captures light-theme screenshots of the AM Backup UI for the user manual, plus the positions of
// the elements the manual points at (for numbered callouts).
//
// Needs: the local Worker with demo data (server: npm run dev; node scripts/seed-demo.mjs)
//        and the UI dev server (app: npm run dev → http://localhost:1420).
//   node docs/manual/tools/capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'shots');
const UI = process.env.UI_URL ?? 'http://localhost:1420/';
const API = process.env.API_URL ?? 'http://localhost:8787';
fs.mkdirSync(OUT, { recursive: true });

async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const { token, user } = await res.json();
  const me = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  return { token, user: me.user, policy: me.policy };
}

const HELPERS = `
window.__norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
window.__q = (text, sel) => [...document.querySelectorAll(sel || 'button,[role=radio],[role=tab],[role=treeitem],a,label,[role=menuitem],[role=slider],h1,h2,h3,section,input')].find((e) => { const t = __norm(e.textContent || e.getAttribute('aria-label') || ''); return t.startsWith(text) || t.replace(/^\\d+/, '').startsWith(text) || (e.getAttribute('aria-label') || '') === text; });
window.__click = (text, sel) => { const e = __q(text, sel); if (!e) throw new Error('not found: ' + text); e.scrollIntoView({ block: 'center' }); e.click(); return true; };
window.__rect = (spec) => {
  let el = null;
  if (spec.re) el = [...document.querySelectorAll(spec.sel || 'button')].find((e) => new RegExp(spec.re).test(__norm(e.textContent)));
  else if (spec.css) el = document.querySelectorAll(spec.css)[spec.index || 0];
  else el = __q(spec.text, spec.sel);
  if (!el) return null;
  if (spec.up) for (let i = 0; i < spec.up; i++) el = el.parentElement;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};
`;

const shots = {};
const b = await launch();
try {
  const { send, evaluate, navigate, sleep, close } = b;
  const viewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  };
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });

  const admin = await login('admin', 'admin12345');
  const state = (signedIn, extra = {}) =>
    JSON.stringify({
      serverUrl: API,
      token: signedIn ? admin.token : null,
      user: signedIn ? admin.user : null,
      policy: admin.policy,
      watchedFolder: 'C:\\TallyPrime\\Data',
      theme: 'light',
      closeToTray: true,
      paused: false,
      ...extra,
    });

  const open = async (signedIn, query = '', extra = {}) => {
    await navigate('about:blank');
    await navigate(UI + query);
    await evaluate(`localStorage.setItem('am-backup-preview', ${JSON.stringify(state(signedIn, extra))}); true`);
    await navigate(UI + query);
    await sleep(2200);
    await evaluate(HELPERS + 'true');
  };

  const shot = async (name, marks = [], clip = null) => {
    await sleep(500);
    await evaluate(HELPERS + 'true');
    const rects = [];
    for (const [i, m] of marks.entries()) {
      const r = await evaluate(`__rect(${JSON.stringify(m)})`);
      if (!r) console.warn(`  ! ${name}: mark ${i + 1} not found (${m.text ?? m.css})`);
      rects.push(r ? { n: i + 1, ...r } : null);
    }
    const size = await evaluate('({ w: innerWidth, h: innerHeight })');
    const params = { format: 'png', captureBeyondViewport: false };
    let base = { x: 0, y: 0, w: size.w, h: size.h };
    if (clip) {
      const c = typeof clip === 'object' && 'css' in clip || 'text' in clip ? await evaluate(`__rect(${JSON.stringify(clip)})`) : clip;
      const pad = clip.pad ?? 12;
      base = { x: Math.max(0, c.x - pad), y: Math.max(0, c.y - pad), w: Math.min(size.w, c.w + pad * 2), h: c.h + pad * 2 };
      params.clip = { x: base.x, y: base.y, width: base.w, height: base.h, scale: 1 };
    }
    const { data } = await send('Page.captureScreenshot', params);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    shots[name] = {
      file: `shots/${name}.png`,
      width: base.w,
      height: base.h,
      marks: rects.filter(Boolean).map((r) => ({ n: r.n, x: r.x - base.x, y: r.y - base.y, w: r.w, h: r.h })),
    };
    console.log(`  ✓ ${name}`);
  };
  const click = async (text, sel) => {
    await evaluate(`__click(${JSON.stringify(text)}, ${JSON.stringify(sel ?? null)})`);
    await sleep(700);
  };

  // ---- Sign in --------------------------------------------------------------------
  await viewport(1180, 760);
  await open(false);
  await shot('signin', [
    { text: 'Username', sel: 'input', css: 'input[autocomplete=username]' },
    { css: 'input[autocomplete=current-password]' },
    { text: 'Sign in', sel: 'button[type=submit]' },
    { text: 'Forgot the administrator password?', sel: 'button' },
  ]);
  await click('Use a different server', 'button');
  await shot('server', [
    { text: 'Online server', sel: '[role=radio]' },
    { text: 'Test server on this computer', sel: '[role=radio]' },
    { text: 'Set up a new server', sel: '[role=radio]' },
    { text: 'Connect', sel: 'button[type=submit]' },
  ]);

  // ---- Server setup (built-in, simulated in the preview) ---------------------------------------
  const typeText = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); true`);
    await send('Input.insertText', { text });
    await sleep(300);
  };
  // Crop the wizard screenshots to the card (the step caption sits three levels inside it).
  const CARD = { text: 'Step', sel: 'span', up: 3, pad: 16 };
  const startSetup = async (query) => {
    await open(false, query, { serverUrl: null });
    await click('Set up a new server', '[role=radio]');
    await click('Start setup', 'button');
    await click('Continue', 'button');
  };
  await viewport(1180, 900);
  await startSetup('?deployHold=online');
  await shot('setup-token', [
    { text: 'Open Cloudflare token page', sel: 'button' },
    { css: 'input[placeholder="Paste the token"]' },
    { text: 'Check token', sel: 'button' },
  ], CARD);
  await typeText('input[placeholder="Paste the token"]', 'demo-token');
  await click('Check token', 'button');
  await sleep(2200);
  await shot('setup-confirm', [{ css: '[role=list]' }, { text: 'Your workers.dev name', sel: 'label', up: 1 }, { text: 'Set up server', sel: 'button' }], CARD);
  await click('Set up server', 'button');
  await sleep(5600);
  await shot('setup-progress', [], CARD);
  await startSetup('');
  await typeText('input[placeholder="Paste the token"]', 'demo-token');
  await click('Check token', 'button');
  await sleep(2200);
  await click('Set up server', 'button');
  await sleep(8600);
  await shot('setup-admin', [{ css: '[aria-label="Setup key"]' }, { text: 'Copy key', sel: 'button' }, { text: 'Create administrator', sel: 'button' }], CARD);

  // ---- Server page (as on a Cloudflare server) -----------------------------------------------------
  const prodUrl = 'https://am-backup-api.am-true-tax.workers.dev';
  await viewport(1240, 1100);
  await open(true, '', {
    serverUrl: prodUrl,
    serverDeploy: {
      accountId: 'f3a1c0de9b8e4d2a',
      accountName: 'AM True Tax',
      worker: 'am-backup-api',
      database: 'am_backup',
      databaseId: '5c1f0b7e-8a2d-4e6b-9f3c-0d1e2a3b4c5d',
      bucket: 'am-backup-files',
      url: prodUrl,
      build: '1.0.0+preview',
      deployedAt: Date.now() - 6 * 86_400_000,
    },
  });
  await click('Server', 'button,a,[role=tab]');
  await sleep(1600);
  await shot('server-page', [
    { text: 'Copy', sel: 'button' },
    { css: '.fui-Badge' },
    { text: 'Update server', sel: 'button' },
    { text: 'Connect other computers', sel: 'h2', up: 2 },
    { text: 'Cloudflare', sel: 'h2', up: 2 },
  ]);

  // ---- Overview ---------------------------------------------------------------------
  await viewport(1240, 900);
  await open(true);
  await shot('overview', [
    { css: 'main section' },
    { text: 'Back up now', sel: 'button' },
    { css: 'button[aria-label="More backup actions"]' },
    { text: 'Changes in the last 24 hours', sel: 'h2', up: 2 },
    { text: 'Backup folder', sel: 'h2', up: 2 },
    { text: 'Complete backups', sel: 'h2', up: 2 },
    { css: 'nav, .fui-NavDrawer' },
    { css: 'button[aria-label^="Backup status"]' },
  ]);
  await click('More backup actions', 'button');
  await shot('overview-menu', [], { css: 'main section', pad: 16 });

  // ---- Restore -------------------------------------------------------------------------
  await viewport(1240, 1000);
  await open(true);
  await click('Restore files', '[role=tab],button,a');
  await sleep(1200);
  await click('4 hours ago', 'button');
  await sleep(900);
  await shot('restore-when', [
    { text: 'A moment in time', sel: '[role=tab]' },
    { text: '2 hours ago', sel: 'button', up: 1 },
    { css: 'input[type=datetime-local]' },
    { css: '[role=slider]' },
    { text: 'Changes after this point', sel: 'span', up: 1 },
    { text: 'Files as they were', sel: 'span', up: 2 },
  ]);
  await click('Only the folders I choose', 'label');
  await sleep(800);
  await click('Data', '[role=treeitem]');
  await sleep(500);
  await evaluate(`(() => { const t = [...document.querySelectorAll('[role=treeitem]')].find(e => __norm(e.textContent).startsWith('10001')); t.querySelector('input[type=checkbox]').click(); return true; })()`);
  await sleep(500);
  await evaluate(`(() => { const t = [...document.querySelectorAll('[role=treeitem]')].find(e => __norm(e.textContent).startsWith('10002')); t.querySelector('input[type=checkbox]').click(); return true; })()`);
  await sleep(600);
  await shot('restore-what', [{ text: 'Only the folders I choose', sel: 'label' }, { css: '[role=tree]' }], { text: 'What to restore', sel: 'h2', up: 2, pad: 14 });
  await click('Browse…', 'button');
  await sleep(600);
  await shot('restore-where', [{ text: 'A different folder', sel: '[role=radio]' }, { text: 'The original folder', sel: '[role=radio]' }, { text: 'Change…', sel: 'button' }], {
    text: 'Where to put the files',
    sel: 'h2',
    up: 2,
    pad: 14,
  });
  await viewport(1240, 1300);
  await click('Compare and review', 'button');
  await sleep(1800);
  await shot('restore-review', [
    { css: '[role=img][aria-label^="Comparison summary"]' },
    { css: '[aria-label="Show files by change"]' },
    { css: '[role=list][aria-label=Files]' },
    { text: 'Backup copy', sel: 'span', up: 2 },
    { text: 'Saved versions', sel: 'span', up: 1 },
    { re: '^Restore \\d+ files?$', sel: 'button' },
  ]);
  await sleep(1500);
  await shot('restore-tally', [{ text: 'See the vouchers', sel: 'button' }], { text: 'In Tally', sel: 'h2', up: 2, pad: 14 });
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => /^Restore \\d/.test(__norm(e.textContent))); b.click(); return true; })()`);
  await sleep(900);
  const dialog = await evaluate(`!!document.querySelector('[role=alertdialog]')`);
  if (dialog) {
    await shot('restore-confirm', [], { css: '[role=alertdialog]', pad: 24 });
    await click('Restore now', 'button');
  }
  await sleep(2600);
  await shot('restore-done', [{ text: 'Open folder', sel: 'button' }, { text: 'Restore something else', sel: 'button' }], { text: 'Restore complete', sel: 'h2', up: 2, pad: 20 });

  // Complete backup source
  await click('Restore something else', 'button');
  await sleep(800);
  await click('A complete backup', '[role=tab]');
  await sleep(1400);
  await shot('restore-full', [{ text: 'A complete backup', sel: '[role=tab]' }, { css: '[role=radiogroup][aria-label="Complete backup"]' }], { text: 'Restore from', sel: 'h2', up: 2, pad: 14 });

  // ---- History ---------------------------------------------------------------------------
  await viewport(1240, 960);
  await open(true);
  await click('Backup history', 'button,a,[role=tab]');
  await sleep(1500);
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => __norm(e.textContent) === 'Files'); b.click(); return true; })()`);
  await sleep(1200);
  await shot('history', [
    { css: '[role=tablist]' },
    { text: 'Files', sel: 'button' },
    { text: 'Restore to this moment', sel: 'button' },
    { text: 'Restore…', sel: 'button' },
  ]);

  // ---- Backup settings -----------------------------------------------------------------------
  await viewport(1240, 1960);
  await open(true);
  await click('Backup settings', 'button,a,[role=tab]');
  await sleep(1800);
  await shot('settings-backup', [
    { text: 'Change folder…', sel: 'button' },
    { css: '[role=radiogroup][aria-label="When to back up"]' },
    { text: 'Wait for files to settle', sel: 'span', up: 2 },
    { css: '[role=radiogroup][aria-label="When Tally is open"]' },
    { text: 'Names of the Tally programs', sel: 'span', up: 2 },
    { text: 'Save Tally data with backups', sel: 'span', up: 2 },
    { text: 'How often', sel: 'span', up: 2 },
    { text: 'Compression', sel: 'span', up: 2 },
    { text: 'Keep the latest', sel: 'span', up: 2 },
    { text: 'Keep every change for', sel: 'span', up: 2 },
    { text: 'Skipped file types', sel: 'span', up: 2 },
  ]);

  await viewport(1240, 900);
  await open(true);
  await click('Backup settings', 'button,a,[role=tab]');
  await sleep(1600);
  await shot(
    'settings-tally',
    [
      { text: 'Back up between Tally entries', sel: '[role=radio]' },
      { text: 'Wait until Tally closes', sel: '[role=radio]' },
      { text: 'Quiet time before a backup', sel: 'span', up: 2 },
      { text: 'Save Tally data with backups', sel: 'span', up: 2 },
    ],
    { text: 'Tally', sel: 'h2', up: 2, pad: 14 },
  );

  // ---- Tally data ---------------------------------------------------------------------------------
  await viewport(1240, 900);
  await open(true, '?tallylive');
  await click('Tally data', 'button,a,[role=tab]');
  await sleep(2200);
  await shot('tally-data', [
    { css: '[aria-label=Company]' },
    { css: '[aria-label=Moment]' },
    { css: '[aria-label="Compare with"]' },
    { css: '[role=tablist]' },
    { text: 'Save Tally data now', sel: 'button' },
  ]);
  await evaluate(`document.querySelector('[aria-label="Compare with"]').click(); true`);
  await sleep(600);
  await evaluate(`(() => { const o = [...document.querySelectorAll('[role=option]')]; o[o.length - 1].click(); return o.length; })()`);
  await sleep(2000);
  await shot('tally-changes', [
    { css: 'button[aria-label="Swap the two moments"]', up: 1 },
    { css: 'button[aria-label="Swap the two moments"]' },
    { text: 'added vouchers', sel: 'span', up: 1 },
    { css: 'table[aria-label="Changed vouchers"]' },
  ]);

  // ---- Users ----------------------------------------------------------------------------------
  await viewport(1240, 760);
  await open(true);
  await click('Users & access', 'button,a,[role=tab]');
  await sleep(1500);
  await shot('users', [
    { text: 'Add user', sel: 'button' },
    { text: 'Read only', sel: '.fui-Badge' },
    { text: 'Only Data/', sel: 'span' },
    { text: 'Active', sel: '.fui-Badge' },
    { css: 'button[aria-label^="Edit Priya"]' },
    { css: 'button[aria-label^="More actions for Priya"]' },
  ]);
  await evaluate(`document.querySelector('button[aria-label^="More actions for Priya"]').click(); true`);
  await sleep(700);
  await shot('users-menu', [], { css: '[role=menu]', pad: 10 });
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await viewport(1240, 1220);
  await open(true);
  await click('Users & access', 'button,a,[role=tab]');
  await sleep(1400);
  await evaluate(`document.querySelector('button[aria-label^="Edit Priya"]').click(); true`);
  // Wait for the drawer's slide-in animation to finish before measuring and capturing it.
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const ready = await evaluate(`(() => { const d = document.querySelector('.fui-OverlayDrawer'); if (!d) return false; const s = getComputedStyle(d); const r = d.getBoundingClientRect(); return s.opacity === '1' && Math.abs(r.right - innerWidth) < 2 && !!d.querySelector('[role=tree]'); })()`);
    if (ready) break;
  }
  await sleep(800);
  await shot('user-editor', [
    { text: 'Name', sel: 'label' },
    { text: 'Reset password', sel: 'button' },
    { css: '[role=radiogroup][aria-label="Access level"]' },
    { css: '[role=radiogroup][aria-label="Folder access"]' },
    { css: '[role=tree]' },
    { text: 'Save changes', sel: 'button' },
  ]);

  // ---- Settings and About ------------------------------------------------------------------------
  await viewport(1240, 1500);
  await open(true);
  await click('Settings', 'button,a,[role=tab]');
  await sleep(1600);
  await shot('settings', [
    { text: 'Change password', sel: 'button' },
    { text: 'Sign out', sel: 'button' },
    { css: 'input[aria-label="Start with Windows"], [aria-label="Start with Windows"]' },
    { css: 'input[aria-label="Keep running when closed"], [aria-label="Keep running when closed"]' },
    { css: '[role=radiogroup][aria-label=Appearance]' },
    { text: 'Change server…', sel: 'button' },
  ]);
  await viewport(1240, 1000);
  await open(true);
  await click('About', 'button,a,[role=tab]');
  await sleep(1400);
  await shot('about', []);

  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(shots, null, 2));
  await close();
  console.log(`\nSaved ${Object.keys(shots).length} screenshots to ${OUT}`);
} catch (e) {
  console.error('Capture failed:', e.message);
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(shots, null, 2));
  await b.close();
  process.exit(1);
}
