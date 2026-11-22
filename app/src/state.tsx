import { createContext, useContext } from 'react';
import type { AppInfo, ConfigView, EngineStatus } from './lib/types';

export type PageId = 'overview' | 'restore' | 'history' | 'tally' | 'backup' | 'users' | 'server' | 'settings' | 'about';

export type RestoreIntent =
  | { kind: 'pointInTime'; at: number }
  | { kind: 'full'; id: number }
  /** Open Tally data comparing two snapshots of a company. */
  | { kind: 'tallyCompare'; companyKey: string; baseId: number; compareId: number };

export interface AppContextValue {
  config: ConfigView;
  status: EngineStatus;
  info: AppInfo | null;
  dark: boolean;
  page: PageId;
  intent: RestoreIntent | null;
  go: (page: PageId, intent?: RestoreIntent | null) => void;
  setConfig: (c: ConfigView) => void;
  refreshConfig: () => Promise<void>;
  setStatus: (s: EngineStatus) => void;
  notify: (intent: 'success' | 'error' | 'info' | 'warning', title: string, body?: string) => void;
  isAdmin: boolean;
  canWrite: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

export const EMPTY_STATUS: EngineStatus = {
  phase: 'starting',
  message: '',
  job: null,
  progress: null,
  lastSyncAt: null,
  lastSyncSummary: null,
  lastFullAt: null,
  nextFullAt: null,
  changesPending: false,
  tallyRunning: null,
  paused: false,
  watchedFolder: null,
  lastError: null,
  busyFiles: [],
};
