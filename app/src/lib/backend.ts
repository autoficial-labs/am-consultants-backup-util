// Bridge to the Rust side. Inside the desktop app this calls Tauri commands; in a plain
// browser (design preview with `npm run dev`) it falls back to a preview shim.
import type {
  AppInfo,
  CfAccount,
  ConfigView,
  DeployOutcome,
  EngineStatus,
  FolderSummary,
  FullReport,
  Health,
  LogLine,
  Policy,
  Preflight,
  RestorePlan,
  RestoreReport,
  RestoreSource,
  ServerNames,
  ServerSetupInfo,
  SyncReport,
  TallyCheck,
  TallySaved,
  TallySnapshotData,
} from './types';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Unlisten = () => void;
type ListenFn = <T>(event: string, cb: (payload: T) => void) => Promise<Unlisten>;

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let bridge: Promise<{ invoke: InvokeFn; listen: ListenFn }> | null = null;

function load() {
  if (!bridge) {
    bridge = isTauri
      ? Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(([core, ev]) => ({
          invoke: core.invoke as InvokeFn,
          listen: (async (event: string, cb: (p: unknown) => void) => ev.listen(event, (e) => cb(e.payload))) as ListenFn,
        }))
      : import('./preview').then((m) => ({ invoke: m.previewInvoke as InvokeFn, listen: m.previewListen as ListenFn }));
  }
  return bridge;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await load();
  return b.invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  const b = await load();
  return b.listen<T>(event, cb);
}

/** Readable message from anything a command or request can throw. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return 'Something went wrong. Please try again.';
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}

/** Authenticated call to the backup server through the app (the session token never reaches the UI). */
export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  try {
    return await invoke<T>('api_call', { method, path, body: body ?? null });
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) {
      const err = e as { status: number; code: string; message: string };
      throw new ApiError(err.message, err.status, err.code);
    }
    throw new ApiError(errorMessage(e), 0, 'client');
  }
}

export const backend = {
  appInfo: () => invoke<AppInfo>('app_info'),
  appReady: () => invoke<void>('app_ready'),
  getConfig: () => invoke<ConfigView>('get_config'),
  checkServer: (url: string) => invoke<Health>('check_server', { url }),
  connectServer: (url: string) => invoke<Health>('connect_server', { url }),
  login: (username: string, password: string) => invoke<ConfigView>('login', { username, password }),
  setupAdmin: (setupKey: string, username: string, displayName: string, password: string, waitForKey = false) =>
    invoke<ConfigView>('setup_admin', { setupKey, username, displayName, password, waitForKey }),
  resetAdmin: (setupKey: string, password: string, waitForKey = false) => invoke<string>('reset_admin', { setupKey, password, waitForKey }),
  logout: () => invoke<void>('logout'),
  refreshSession: () => invoke<ConfigView>('refresh_session'),
  setWatchedFolder: (path: string | null) => invoke<ConfigView>('set_watched_folder', { path }),
  scanFolder: (path: string, excludes: string[]) => invoke<FolderSummary>('scan_folder', { path, excludes }),
  engineStatus: () => invoke<EngineStatus>('engine_status'),
  syncNow: (force: boolean) => invoke<SyncReport>('sync_now', { force }),
  fullBackupNow: (force: boolean) => invoke<FullReport>('full_backup_now', { force }),
  setPaused: (paused: boolean) => invoke<EngineStatus>('set_paused', { paused }),
  cancelJob: () => invoke<void>('cancel_job'),
  tallyStatus: () => invoke<string | null>('tally_status'),
  restorePlan: (source: RestoreSource, dest: string, include: string[]) => invoke<RestorePlan>('restore_plan', { source, dest, include }),
  restoreExecute: (planId: string, paths: string[] | null, removeExtras: boolean) =>
    invoke<RestoreReport>('restore_execute', { planId, paths, removeExtras }),
  policyChanged: (policy: Policy) => invoke<void>('policy_changed', { policy }),
  setPreferences: (prefs: { closeToTray?: boolean; theme?: string; deviceName?: string }) =>
    invoke<ConfigView>('set_preferences', { closeToTray: prefs.closeToTray ?? null, theme: prefs.theme ?? null, deviceName: prefs.deviceName ?? null }),
  getLogs: () => invoke<LogLine[]>('get_logs'),
  openPath: (path: string, reveal = false) => invoke<void>('open_path', { path, reveal }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  serverSetupInfo: () => invoke<ServerSetupInfo>('server_setup_info'),
  cfAccounts: (token: string) => invoke<CfAccount[]>('cf_accounts', { token }),
  cfPreflight: (token: string, account: CfAccount, names: ServerNames) => invoke<Preflight>('cf_preflight', { token, account, names }),
  cfDeploy: (token: string, request: { account: CfAccount; names: ServerNames; subdomain: string | null }) =>
    invoke<DeployOutcome>('cf_deploy', { token, request }),
  cfNewSetupKey: (token: string, accountId: string, worker: string) => invoke<string>('cf_new_setup_key', { token, accountId, worker }),
  tallyCheck: () => invoke<TallyCheck>('tally_check'),
  tallyLive: (company: string) => invoke<TallySnapshotData>('tally_live', { company }),
  tallyCaptureNow: () => invoke<TallySaved[]>('tally_capture_now'),
};

/** Native folder picker. Returns null when cancelled. */
export async function pickFolder(title: string, defaultPath?: string | null): Promise<string | null> {
  if (!isTauri) {
    const { previewPickFolder } = await import('./preview');
    return previewPickFolder(title);
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ directory: true, multiple: false, title, defaultPath: defaultPath ?? undefined });
  return typeof result === 'string' ? result : null;
}

export async function autostart() {
  if (!isTauri) {
    let on = false;
    return { isEnabled: async () => on, enable: async () => void (on = true), disable: async () => void (on = false) };
  }
  return import('@tauri-apps/plugin-autostart');
}
