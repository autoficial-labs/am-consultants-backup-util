// Browser-only stand-in for the Rust side, used when the UI is opened with `npm run dev`
// outside the desktop shell (design review, screenshots). Server calls go to the real local
// Worker; local-only operations (folder scans, restores) are simulated.
import type { ConfigView, EngineStatus, Policy, RestorePlan, SnapshotFile, UserInfo, PlanItem, Manifest, ServerDeploy, SetupStepEvent, SetupStepId } from './types';

const SERVER: string = (import.meta.env.VITE_PREVIEW_SERVER as string | undefined) ?? 'http://localhost:8787';
const KEY = 'am-backup-preview';

interface PreviewState {
  serverUrl: string | null;
  token: string | null;
  user: UserInfo | null;
  policy: Policy | null;
  watchedFolder: string | null;
  theme: 'system' | 'light' | 'dark';
  closeToTray: boolean;
  paused: boolean;
  serverDeploy?: ServerDeploy | null;
}

function load(): PreviewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return { serverUrl: SERVER, token: null, user: null, policy: null, watchedFolder: 'C:\\TallyPrime\\Data', theme: 'system', closeToTray: true, paused: false };
}
let state = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

const DEFAULT_POLICY: Policy = {
  sync: { mode: 'auto', quietSeconds: 60, intervalMinutes: 30, tallyMode: 'quiet', tallyQuietSeconds: 180, graceSeconds: 30, tallyProcesses: ['tally.exe', 'tallyprime.exe', 'tallyprimeserver.exe'] },
  full: { schedule: 'daily', time: '20:00', everyHours: 12, weekday: 5, level: 'maximum', keep: 14 },
  retention: { versionDays: 30 },
  tally: { snapshots: true, port: 9000, everyMinutes: 60 },
  exclude: ['*.tmp', '~$*', 'Thumbs.db', 'desktop.ini', '.DS_Store'],
};

function view(): ConfigView {
  return {
    serverUrl: state.serverUrl,
    signedIn: Boolean(state.token && state.user),
    user: state.user,
    policy: state.policy ?? DEFAULT_POLICY,
    watchedFolder: state.watchedFolder,
    deviceName: 'OFFICE-PC',
    closeToTray: state.closeToTray,
    theme: state.theme,
    defaultServer: null,
    serverDeploy: state.serverDeploy ?? null,
  };
}

/** Screenshots of a "production" server: any workers.dev address is served by the local Worker. */
const target = (url: string | null) => (!url || url.includes('.workers.dev') ? SERVER : url);

async function http<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(target(state.serverUrl) + path, {
      method,
      headers: {
        ...(body !== undefined && body !== null ? { 'content-type': 'application/json' } : {}),
        ...(auth && state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { status: 0, code: 'network', message: "Can't reach the backup server. Check the internet connection and server address." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) {
      state.token = null;
      state.user = null;
      save();
    }
    throw { status: res.status, code: data.code ?? 'error', message: data.error ?? `The server answered ${res.status}.` };
  }
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function fakeLocal(files: { path: string; size: number; mtime: number; hash: string | null; changedAt: number | null }[]): PlanItem[] {
  const items: PlanItem[] = files.map((f) => {
    const r = hashOf(f.path);
    if (r < 0.14) return { ...f, status: 'restore', localSize: null, localMtime: null };
    if (r < 0.32) return { ...f, status: 'overwrite', localSize: Math.round(f.size * (0.8 + r)), localMtime: f.mtime + 3_600_000 * (1 + r * 5) };
    return { ...f, status: 'same', localSize: f.size, localMtime: f.mtime };
  });
  const extras = files.filter((f) => hashOf(f.path + 'x') < 0.06).map<PlanItem>((f) => ({
    path: f.path.replace(/[^/]+$/, 'Backup-copy.tmp.900'),
    status: 'extra',
    size: 0,
    mtime: 0,
    hash: null,
    changedAt: null,
    localSize: 40_960,
    localMtime: Date.now() - 1_800_000,
  }));
  return [...items, ...extras].sort((a, b) => a.path.localeCompare(b.path));
}

const status = (): EngineStatus => ({
  phase: state.paused ? 'paused' : 'idle',
  message: state.paused ? 'Automatic backups are paused' : 'Your files are protected',
  job: null,
  progress: null,
  lastSyncAt: Date.now() - 4 * 60_000,
  lastSyncSummary: 'Backed up 3 changed',
  lastFullAt: Date.now() - 18 * 3_600_000,
  nextFullAt: (() => {
    const d = new Date();
    d.setHours(20, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  })(),
  changesPending: false,
  tallyRunning: new URLSearchParams(location.search).has('tally') ? 'tally.exe' : null,
  paused: state.paused,
  watchedFolder: state.watchedFolder,
  lastError: null,
  busyFiles: [],
});

export async function previewInvoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  const r = await (async (): Promise<unknown> => {
    switch (cmd) {
      case 'app_info':
        return { version: '1.0.0', os: 'windows x86_64 (preview)', deviceName: 'OFFICE-PC', dataDir: 'C:\\Users\\Office\\AppData\\Roaming\\ltd.autoficial.ambackup', logDir: null };
      case 'app_ready':
        return null;
      case 'get_config':
        return view();
      case 'check_server':
      case 'connect_server': {
        const url = String(args.url).replace(/\/+$/, '');
        const prev = state.serverUrl;
        state.serverUrl = url.startsWith('http') ? url : `https://${url}`;
        try {
          const h = await http<Record<string, unknown>>('GET', '/api/health', undefined, false);
          if (cmd === 'check_server') state.serverUrl = prev;
          save();
          return String(args.url).includes('.workers.dev') ? { ...h, environment: 'production', build: '1.0.0+preview' } : h;
        } catch (e) {
          state.serverUrl = prev;
          throw (e as { message: string }).message;
        }
      }
      case 'login': {
        const res = await http<{ token: string; user: UserInfo }>('POST', '/api/auth/login', { username: args.username, password: args.password }, false).catch((e) => {
          throw e.message;
        });
        state.token = res.token;
        state.user = res.user;
        const me = await http<{ user: UserInfo; policy: Policy }>('GET', '/api/me');
        state.policy = me.policy;
        save();
        return view();
      }
      case 'setup_admin': {
        const res = await http<{ token: string; user: UserInfo }>('POST', '/api/setup', args, false).catch((e) => {
          throw e.message;
        });
        state.token = res.token;
        state.user = res.user;
        save();
        return view();
      }
      case 'reset_admin': {
        const res = await http<{ username: string }>('POST', '/api/setup/reset-admin', args, false).catch((e) => {
          throw e.message;
        });
        return res.username;
      }
      case 'logout':
        state.token = null;
        state.user = null;
        save();
        return null;
      case 'refresh_session': {
        const me = await http<{ user: UserInfo; policy: Policy }>('GET', '/api/me').catch((e) => {
          throw e.message;
        });
        state.user = me.user;
        state.policy = me.policy;
        save();
        return view();
      }
      case 'api_call':
        return http(args.method, args.path, args.body);
      case 'set_watched_folder':
        state.watchedFolder = args.path;
        save();
        return view();
      case 'scan_folder': {
        const f = await http<{ totalFiles: number; totalBytes: number; folders: { path: string; files: number; bytes: number }[] }>('GET', '/api/folders');
        return { root: args.path, ...f };
      }
      case 'engine_status':
        return status();
      case 'set_paused':
        state.paused = Boolean(args.paused);
        save();
        return status();
      case 'sync_now':
        await sleep(1200);
        return { added: 0, modified: 2, deleted: 0, unchanged: 120, uploadedBytes: 182_000, busy: [], batchId: null, deletionsDeferred: false };
      case 'full_backup_now':
        await sleep(2000);
        return { id: 0, fileCount: 124, originalSize: 812_000_000, compressedSize: 96_000_000, skipped: [], seconds: 41 };
      case 'tally_status':
        return status().tallyRunning;
      case 'set_preferences':
        if (args.theme) state.theme = args.theme;
        if (typeof args.closeToTray === 'boolean') state.closeToTray = args.closeToTray;
        save();
        return view();
      case 'policy_changed':
        state.policy = args.policy;
        save();
        return null;
      case 'restore_plan': {
        const source = args.source as RestorePlan['source'];
        let files: { path: string; size: number; mtime: number; hash: string | null; changedAt: number | null }[];
        if (source.kind === 'pointInTime') {
          const snap = await http<{ files: SnapshotFile[] }>('GET', `/api/snapshot?at=${source.at}`);
          files = snap.files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, hash: f.hash, changedAt: f.changedAt }));
        } else {
          const m = await http<Manifest>('GET', `/api/full-backups/${source.id}/manifest`);
          files = m.files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, hash: f.sha256, changedAt: null }));
        }
        const include: string[] = args.include ?? [];
        files = files.filter((f) => !include.length || include.some((i) => f.path === i || f.path.startsWith(`${i}/`)));
        const items = fakeLocal(files);
        const summary = { restore: 0, overwrite: 0, same: 0, extra: 0, downloadBytes: 0, totalFiles: 0, totalBytes: 0 };
        for (const i of items) {
          summary[i.status]++;
          if (i.status === 'restore' || i.status === 'overwrite') summary.downloadBytes += i.size;
          if (i.status !== 'extra') {
            summary.totalFiles++;
            summary.totalBytes += i.size;
          }
        }
        await sleep(500);
        return { id: `plan-${Date.now()}`, source, dest: args.dest, createdAt: Date.now(), include, items, summary } satisfies RestorePlan;
      }
      case 'restore_execute':
        await sleep(1800);
        return { restored: args.paths?.length ?? 12, removed: args.removeExtras ? 2 : 0, bytes: 4_200_000, failed: [], seconds: 6, cancelled: false };
      case 'get_logs':
        return [
          { at: Date.now() - 3_600_000, level: 'info', message: 'AM Backup engine started (version 1.0.0)' },
          { at: Date.now() - 3_500_000, level: 'info', message: 'Watching C:\\TallyPrime\\Data' },
          { at: Date.now() - 600_000, level: 'warn', message: '1 file(s) were in use and will be retried: Data/10001/TranMgr.1800' },
          { at: Date.now() - 240_000, level: 'info', message: 'Backed up 3 changed (182 KB uploaded)' },
        ];
      case 'open_url':
        window.open(String(args.url), '_blank', 'noopener');
        return null;
      // Built-in server setup, simulated (a token starting with "demo" is accepted).
      case 'server_setup_info':
        return {
          version: '1.0.0',
          build: '1.0.0+preview',
          tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
          defaults: { worker: 'am-backup-api', database: 'am_backup', bucket: 'am-backup-files' },
        };
      case 'cf_accounts':
        await sleep(700);
        if (!String(args.token).startsWith('demo')) throw 'Cloudflare did not accept this token. Check that you copied all of it, and that it is not deleted or expired.';
        return [{ id: 'f3a1c0de9b8e4d2a', name: 'AM True Tax' }];
      case 'cf_preflight': {
        await sleep(900);
        const r2Off = String(args.token).includes('nor2');
        return {
          checks: [
            { id: 'workers', label: 'Workers (runs the server)', ok: true, detail: 'Allowed' },
            { id: 'd1', label: 'D1 database (users and file list)', ok: true, detail: 'Allowed' },
            r2Off
              ? { id: 'r2', label: 'R2 storage (backed-up files)', ok: false, detail: 'R2 storage is not turned on for this Cloudflare account yet. Open R2 in the Cloudflare dashboard, turn it on (the free plan is enough), then try again.' }
              : { id: 'r2', label: 'R2 storage (backed-up files)', ok: true, detail: 'Allowed' },
            { id: 'address', label: 'Web address', ok: true, detail: 'This account has no workers.dev name yet. One will be created.' },
          ],
          ready: !r2Off,
          names: args.names,
          workerExists: false,
          databaseId: null,
          bucketExists: false,
          subdomain: null,
          suggestedSubdomain: 'am-true-tax-7k2m',
          serverUrl: null,
          bundledBuild: '1.0.0+preview',
        };
      }
      case 'cf_deploy': {
        const order: [SetupStepId, string | null][] = [
          ['check', null],
          ['database', `Created "${args.request.names.database}"`],
          ['tables', '1 update(s) applied'],
          ['storage', `Created "${args.request.names.bucket}"`],
          ['upload', 'Version 1.0.0'],
          ['schedule', null],
          ['address', `${args.request.names.worker}.${args.request.subdomain}.workers.dev`],
          ['online', null],
        ];
        const hold = new URLSearchParams(location.search).get('deployHold');
        for (const [step, detail] of order) {
          emit('server-setup', { step, state: 'running', detail: step === 'online' ? 'A new address can take a few minutes to start working.' : null });
          if (hold === step) return new Promise(() => undefined);
          await sleep(step === 'online' ? 1600 : 650);
          emit('server-setup', { step, state: 'done', detail });
        }
        return {
          serverUrl: `https://${args.request.names.worker}.${args.request.subdomain}.workers.dev`,
          createdWorker: true,
          setupKey: 'K7QM-2XRA-9DPF-W4HN-B6TC-Q8ZJ-M3EV-R5YG',
          online: true,
          needsSetup: true,
          build: '1.0.0+preview',
          names: args.request.names,
          databaseId: '5c1f0b7e-8a2d-4e6b-9f3c-0d1e2a3b4c5d',
        };
      }
      // Tally's XML server is not available in a browser; ?tallylive pretends it is.
      case 'tally_check':
        return new URLSearchParams(location.search).has('tallylive')
          ? { port: 9000, reachable: true, tallyRunning: 'tally.exe', companies: [{ name: 'Shree Ganesh Traders', number: '10001', guid: null, startingFrom: '2026-04-01', booksFrom: '2024-04-01' }], error: null }
          : { port: 9000, reachable: false, tallyRunning: null, companies: [], error: 'Tally is not answering on port 9000. Open Tally and turn on its XML server (Client/Server configuration).' };
      case 'tally_capture_now':
        await sleep(900);
        return [{ companyKey: '10001', companyName: 'Shree Ganesh Traders', folder: 'Data/10001', hash: 'x', ledgers: 22, vouchers: 140, recorded: false }];
      case 'tally_live': {
        const snaps = await http<{ snapshots: { id: number }[] }>('GET', '/api/tally/snapshots?company=10001');
        return http('GET', `/api/tally/snapshots/${snaps.snapshots[0]!.id}/data`);
      }
      case 'cf_new_setup_key':
        await sleep(800);
        return 'P4TW-8RKD-X2MB-H7QN-C9VF-J3EA-Z6YS-G5NM';
      default:
        return null;
    }
  })();
  return r as T;
}

const listeners = new Map<string, Set<(p: unknown) => void>>();

function emit(event: string, payload: SetupStepEvent) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

export async function previewListen(event: string, cb: (p: unknown) => void): Promise<() => void> {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)?.delete(cb);
}

export async function previewPickFolder(_title: string): Promise<string | null> {
  return 'D:\\Restored\\Tally';
}
