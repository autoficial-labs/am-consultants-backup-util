export type Role = 'superadmin' | 'user';
export type Access = 'read' | 'write';
export type ScopeMode = 'all' | 'include' | 'exclude' | 'none';

export interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  access: Access;
  scopeMode: ScopeMode;
  paths: string[];
}

export interface Policy {
  sync: {
    mode: 'auto' | 'interval' | 'manual';
    quietSeconds: number;
    intervalMinutes: number;
    /** quiet: back up while Tally is open once its files are quiet; close: wait until Tally closes. */
    tallyMode: 'quiet' | 'close';
    tallyQuietSeconds: number;
    graceSeconds: number;
    tallyProcesses: string[];
  };
  full: {
    schedule: 'daily' | 'hours' | 'weekly' | 'off';
    time: string;
    everyHours: number;
    weekday: number;
    level: 'balanced' | 'high' | 'maximum';
    keep: number;
  };
  retention: { versionDays: number };
  tally: { snapshots: boolean; port: number; everyMinutes: number };
  exclude: string[];
}

export interface ConfigView {
  serverUrl: string | null;
  signedIn: boolean;
  user: UserInfo | null;
  policy: Policy;
  watchedFolder: string | null;
  deviceName: string;
  closeToTray: boolean;
  theme: 'system' | 'light' | 'dark';
  defaultServer: string | null;
  serverDeploy: ServerDeploy | null;
}

/** What the built-in server setup created (no secrets). */
export interface ServerDeploy {
  accountId: string;
  accountName: string;
  worker: string;
  database: string;
  databaseId: string;
  bucket: string;
  url: string;
  build: string;
  deployedAt: number;
}

export interface ServerNames {
  worker: string;
  database: string;
  bucket: string;
}

export interface ServerSetupInfo {
  version: string;
  build: string;
  tokenUrl: string;
  defaults: ServerNames;
}

export interface CfAccount {
  id: string;
  name: string;
}

export interface SetupCheck {
  id: 'workers' | 'd1' | 'r2' | 'address';
  label: string;
  ok: boolean;
  detail: string;
}

export interface Preflight {
  checks: SetupCheck[];
  ready: boolean;
  names: ServerNames;
  workerExists: boolean;
  databaseId: string | null;
  bucketExists: boolean;
  subdomain: string | null;
  suggestedSubdomain: string;
  serverUrl: string | null;
  bundledBuild: string;
}

export type SetupStepId = 'check' | 'database' | 'tables' | 'storage' | 'upload' | 'schedule' | 'address' | 'online' | 'access';

export interface SetupStepEvent {
  step: SetupStepId;
  state: 'running' | 'done' | 'failed' | 'waiting';
  detail: string | null;
}

export interface DeployOutcome {
  serverUrl: string;
  createdWorker: boolean;
  setupKey: string | null;
  online: boolean;
  needsSetup: boolean;
  build: string;
  names: ServerNames;
  databaseId: string;
}

export interface Health {
  ok: boolean;
  service?: string;
  version?: string;
  build?: string | null;
  environment?: string;
  needsSetup: boolean;
  setupKeyConfigured?: boolean;
  serverTime?: number;
}

export interface AppInfo {
  version: string;
  os: string;
  deviceName: string;
  dataDir: string;
  logDir: string | null;
}

export interface Progress {
  stage: string;
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
  current: string | null;
}

export type Phase =
  | 'starting'
  | 'signedOut'
  | 'notConfigured'
  | 'readOnly'
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'waitingTally'
  | 'waitingQuiet'
  | 'fullBackup'
  | 'restoring'
  | 'paused'
  | 'offline'
  | 'error';

export interface EngineStatus {
  phase: Phase;
  message: string;
  job: 'sync' | 'full' | 'restore' | null;
  progress: Progress | null;
  lastSyncAt: number | null;
  lastSyncSummary: string | null;
  lastFullAt: number | null;
  nextFullAt: number | null;
  changesPending: boolean;
  tallyRunning: string | null;
  paused: boolean;
  watchedFolder: string | null;
  lastError: string | null;
  busyFiles: string[];
}

export interface FolderInfo {
  path: string;
  files: number;
  bytes: number;
}

export interface FolderSummary {
  root?: string;
  totalFiles: number;
  totalBytes: number;
  folders: FolderInfo[];
}

export type ItemStatus = 'restore' | 'overwrite' | 'same' | 'extra';

export interface PlanItem {
  path: string;
  status: ItemStatus;
  size: number;
  mtime: number;
  hash: string | null;
  changedAt: number | null;
  localSize: number | null;
  localMtime: number | null;
}

export type RestoreSource = { kind: 'pointInTime'; at: number } | { kind: 'full'; id: number };

export interface RestorePlan {
  id: string;
  source: RestoreSource;
  dest: string;
  createdAt: number;
  include: string[];
  items: PlanItem[];
  summary: {
    restore: number;
    overwrite: number;
    same: number;
    extra: number;
    downloadBytes: number;
    totalFiles: number;
    totalBytes: number;
  };
}

export interface RestoreReport {
  restored: number;
  removed: number;
  bytes: number;
  failed: { path: string; error: string }[];
  seconds: number;
  cancelled: boolean;
}

export interface SyncReport {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  uploadedBytes: number;
  busy: string[];
  batchId: number | null;
  deletionsDeferred: boolean;
}

export interface FullReport {
  id: number;
  fileCount: number;
  originalSize: number;
  compressedSize: number;
  skipped: string[];
  seconds: number;
}

export interface SnapshotFile {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  versionId: number;
  changedAt: number;
}

export interface TimelineEvent {
  id: number;
  path: string;
  op: 'add' | 'modify' | 'delete';
  hash: string | null;
  size: number;
  mtime: number;
  created_at: number;
  batch_id: number | null;
}

export interface Timeline {
  from: number;
  to: number;
  earliest: number | null;
  latest: number | null;
  truncated: boolean;
  events: TimelineEvent[];
}

export interface FileVersion {
  id: number;
  op: 'add' | 'modify' | 'delete';
  hash: string | null;
  size: number;
  mtime: number;
  created_at: number;
  batch_id: number | null;
}

export interface Batch {
  id: number;
  device: string | null;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'done' | 'failed';
  added: number;
  modified: number;
  deleted: number;
  bytes_uploaded: number;
  message: string | null;
  username: string | null;
  display_name: string | null;
}

export interface FullBackup {
  id: number;
  status: 'uploading' | 'complete' | 'failed';
  origin: 'manual' | 'scheduled';
  file_count: number;
  original_size: number;
  compressed_size: number;
  level: number | null;
  created_at: number;
  completed_at: number | null;
  device: string | null;
  note: string | null;
  username: string | null;
}

export interface Manifest {
  version: number;
  createdAt: number;
  level: number;
  files: { path: string; size: number; mtime: number; sha256: string }[];
  skipped: string[];
}

export interface ManagedUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  access: Access;
  scopeMode: ScopeMode;
  paths: string[];
  disabled: boolean;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  activeSessions: number;
}

export interface Stats {
  files: number;
  bytes: number;
  lastSync: { id: number; started_at: number; finished_at: number | null; status: string; added: number; modified: number; deleted: number } | null;
  lastFull: { id: number; created_at: number; completed_at: number; compressed_size: number; original_size: number; file_count: number } | null;
  fullBackups: number | null;
  storedBytes: number | null;
  versions: number | null;
  earliestVersion: number | null;
  activeUsers: number | null;
  recentChanges: { path: string; op: 'add' | 'modify' | 'delete'; at: number }[];
}

export interface AuditEvent {
  id: number;
  at: number;
  username: string | null;
  action: string;
  detail: string | null;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ---- Tally data (read from Tally's XML server at backup time) --------------------------------

export interface TallyCompanyInfo {
  name: string;
  number: string | null;
  guid: string | null;
  startingFrom: string | null;
  booksFrom: string | null;
}

export interface TallyLedger {
  name: string;
  group: string;
  /** Tally convention: debit balances are negative, credit positive. */
  opening: number;
  closing: number;
}

export interface TallyVoucher {
  guid: string;
  masterId: number;
  alterId: number;
  date: string;
  type: string;
  number: string;
  party: string;
  amount: number;
  narration: string;
  cancelled: boolean;
  optional: boolean;
}

export interface TallySnapshotData {
  version: number;
  company: TallyCompanyInfo;
  period: { from: string; to: string };
  ledgers: TallyLedger[];
  vouchers: TallyVoucher[];
}

export interface TallyCompanyRow {
  companyKey: string;
  companyName: string;
  folder: string | null;
  snapshots: number;
  firstAt: number;
  latestAt: number;
  ledgers: number;
  vouchers: number;
  lastVoucher: string | null;
}

export interface TallySnapshotRow {
  id: number;
  companyKey: string;
  companyName: string;
  folder: string | null;
  capturedAt: number;
  hash: string;
  ledgers: number;
  vouchers: number;
  lastVoucher: string | null;
  device: string | null;
}

export interface TallyCheck {
  port: number;
  reachable: boolean;
  tallyRunning: string | null;
  companies: TallyCompanyInfo[];
  error: string | null;
}

export interface TallySaved {
  companyKey: string;
  companyName: string;
  folder: string | null;
  hash: string;
  ledgers: number;
  vouchers: number;
  recorded: boolean;
}
