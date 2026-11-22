const LOCALE = 'en-IN';

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(LOCALE, { maximumFractionDigits: v >= 100 ? 0 : digits })} ${units[i]}`;
}

export function count(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString(LOCALE);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const fullFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function time(ms: number): string {
  return timeFmt.format(ms);
}

function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", or "Sat, 21 Nov". */
export function dayLabel(ms: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dayFmt.format(ms);
}

/** "Today at 2:05 pm", "Yesterday at 9:40 am", "Sat, 21 Nov at 4:00 pm". */
export function when(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'Never';
  return `${dayLabel(ms, now)} at ${time(ms)}`;
}

/** For use inside a sentence: "today", "yesterday", "on Sat, 21 Nov". */
export function onDay(ms: number, now = Date.now()): string {
  const d = dayLabel(ms, now);
  return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : `on ${d}`;
}

/** Compact date for dense lists: "2:39 pm", "Yesterday 9:10 am", "29 Oct". */
export function shortWhen(ms: number, now = Date.now()): string {
  const d = dayLabel(ms, now);
  if (d === 'Today') return time(ms);
  if (d === 'Yesterday') return `yesterday ${time(ms)}`;
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }).format(ms);
}

export function fullDate(ms: number): string {
  return fullFmt.format(ms);
}

/** "just now", "4 minutes ago", "3 hours ago", else a day label. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24 && dayLabel(ms, now) === 'Today') return `${h} hour${h === 1 ? '' : 's'} ago`;
  return when(ms, now);
}

/** Time until a future moment: "in 3 hours", "tonight at 8:00 pm". */
export function until(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'Not scheduled';
  if (ms <= now + 30_000) return 'Now';
  const m = Math.round((ms - now) / 60000);
  if (m < 60) return `In ${m} minute${m === 1 ? '' : 's'}`;
  return when(ms, now);
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function hoursLabel(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export function secondsLabel(s: number): string {
  if (s === 0) return 'No wait';
  if (s < 60) return `${s} seconds`;
  const m = s / 60;
  return `${m % 1 === 0 ? m : m.toFixed(1)} minute${m === 1 ? '' : 's'}`;
}

export function percent(part: number, whole: number): string {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export function splitPath(p: string): { folder: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { folder: '', name: p } : { folder: p.slice(0, i), name: p.slice(i + 1) };
}

/** Converts "20:00" to "8:00 pm". */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return timeFmt.format(d);
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}
