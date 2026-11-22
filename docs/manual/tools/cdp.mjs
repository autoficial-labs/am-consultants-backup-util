// Minimal Chrome DevTools Protocol driver for headless Microsoft Edge / Chrome (no dependencies).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const exe = CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('No Edge or Chrome found. Set BROWSER_PATH.');
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'am-manual-'));
  // A throw-away profile that never signs in, syncs or loads extensions: Edge can otherwise sign a
  // fresh profile in to the Windows account automatically and pull in its extensions and data.
  const flags = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-features=msImplicitSignin,msEdgeSyncConsent,msShowFirstRunExperience',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ];
  const proc = spawn(exe, flags, {
    stdio: 'ignore',
  });
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json(), () => null);
  }
  if (!version) throw new Error('Browser did not start');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const cb of listeners.get(msg.method)) cb(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const once = (method) =>
    new Promise((resolve) => {
      const list = listeners.get(method) ?? [];
      const cb = (p) => {
        listeners.set(method, (listeners.get(method) ?? []).filter((x) => x !== cb));
        resolve(p);
      };
      list.push(cb);
      listeners.set(method, list);
    });
  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const navigate = async (url) => {
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url });
    await loaded;
  };
  const close = async () => {
    try {
      await send('Browser.close');
    } catch {
      /* already closed */
    }
    proc.kill();
    // Remove the temporary profile; retry while the browser's helper processes exit.
    for (let i = 0; i < 20 && fs.existsSync(profile); i++) {
      await sleep(500);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* still locked */
      }
    }
  };
  return { send, evaluate, navigate, close, sleep };
}
