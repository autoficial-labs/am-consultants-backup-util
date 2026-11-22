// The backup policy is stored centrally so every installation follows the same rules.

export type SyncMode = 'auto' | 'interval' | 'manual';
export type FullSchedule = 'daily' | 'hours' | 'weekly' | 'off';
export type FullLevel = 'balanced' | 'high' | 'maximum';
export type TallyMode = 'quiet' | 'close';

export interface Policy {
  sync: {
    /** auto: back up shortly after files stop changing; interval: on a fixed timer; manual: only on demand. */
    mode: SyncMode;
    quietSeconds: number;
    intervalMinutes: number;
    /**
     * quiet: back up while Tally is open, once its files have not changed for tallyQuietSeconds
     *        (for computers where Tally is never closed); every copy is checked for changes.
     * close: wait until Tally is closed (plus graceSeconds).
     */
    tallyMode: TallyMode;
    tallyQuietSeconds: number;
    /** Seconds to wait after Tally closes before reading its files (close mode). */
    graceSeconds: number;
    tallyProcesses: string[];
  };
  full: {
    schedule: FullSchedule;
    /** 24h local time "HH:MM" for daily and weekly schedules. */
    time: string;
    everyHours: number;
    /** 0 = Sunday … 6 = Saturday. */
    weekday: number;
    level: FullLevel;
    keep: number;
  };
  retention: {
    /** Days of change history kept for point-in-time restore. 0 keeps everything. */
    versionDays: number;
  };
  tally: {
    /** Save Tally data snapshots (companies, ledgers, vouchers) read from Tally's XML server. */
    snapshots: boolean;
    /** Port of Tally's XML server on the backup computer (Tally default: 9000). */
    port: number;
    /** At most one snapshot per company in this many minutes. */
    everyMinutes: number;
  };
  exclude: string[];
}

export const DEFAULT_POLICY: Policy = {
  sync: {
    mode: 'auto',
    quietSeconds: 60,
    intervalMinutes: 30,
    tallyMode: 'quiet',
    tallyQuietSeconds: 180,
    graceSeconds: 30,
    tallyProcesses: ['tally.exe', 'tallyprime.exe', 'tallyprimeserver.exe'],
  },
  full: { schedule: 'daily', time: '20:00', everyHours: 12, weekday: 5, level: 'maximum', keep: 14 },
  retention: { versionDays: 30 },
  tally: { snapshots: true, port: 9000, everyMinutes: 60 },
  exclude: ['*.tmp', '~$*', 'Thumbs.db', 'desktop.ini', '.DS_Store'],
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const cleanList = (v: unknown, fallback: string[], max = 40) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= 120))].slice(0, max)
    : fallback;

/** Merges any partial/legacy input onto the defaults and clamps every value into a safe range. */
export function sanitizePolicy(input: unknown): Policy {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const s = (src.sync ?? {}) as Record<string, unknown>;
  const f = (src.full ?? {}) as Record<string, unknown>;
  const r = (src.retention ?? {}) as Record<string, unknown>;
  const t = (src.tally ?? {}) as Record<string, unknown>;
  const d = DEFAULT_POLICY;
  const time = typeof f.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.time) ? f.time : d.full.time;
  return {
    sync: {
      mode: pick(s.mode, ['auto', 'interval', 'manual'] as const, d.sync.mode),
      quietSeconds: clampInt(s.quietSeconds, 10, 3600, d.sync.quietSeconds),
      intervalMinutes: clampInt(s.intervalMinutes, 5, 1440, d.sync.intervalMinutes),
      // Older settings had a waitForTally switch; the quiet mode replaces it as the safe default.
      tallyMode: pick(s.tallyMode, ['quiet', 'close'] as const, d.sync.tallyMode),
      tallyQuietSeconds: clampInt(s.tallyQuietSeconds, 30, 3600, d.sync.tallyQuietSeconds),
      graceSeconds: clampInt(s.graceSeconds, 0, 600, d.sync.graceSeconds),
      tallyProcesses: [...new Set(cleanList(s.tallyProcesses, d.sync.tallyProcesses, 12).map((p) => p.toLowerCase()))],
    },
    full: {
      schedule: pick(f.schedule, ['daily', 'hours', 'weekly', 'off'] as const, d.full.schedule),
      time,
      everyHours: clampInt(f.everyHours, 1, 168, d.full.everyHours),
      weekday: clampInt(f.weekday, 0, 6, d.full.weekday),
      level: pick(f.level, ['balanced', 'high', 'maximum'] as const, d.full.level),
      keep: clampInt(f.keep, 1, 365, d.full.keep),
    },
    retention: { versionDays: clampInt(r.versionDays, 0, 3650, d.retention.versionDays) },
    tally: {
      snapshots: typeof t.snapshots === 'boolean' ? t.snapshots : d.tally.snapshots,
      port: clampInt(t.port, 1, 65535, d.tally.port),
      everyMinutes: clampInt(t.everyMinutes, 15, 1440, d.tally.everyMinutes),
    },
    exclude: cleanList(src.exclude, d.exclude, 60),
  };
}

export async function loadPolicy(db: D1Database): Promise<Policy> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'policy'").first<{ value: string }>();
  if (!row) return DEFAULT_POLICY;
  try {
    return sanitizePolicy(JSON.parse(row.value));
  } catch {
    return DEFAULT_POLICY;
  }
}

export async function savePolicy(db: D1Database, policy: Policy): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(JSON.stringify(policy), Date.now())
    .run();
}
