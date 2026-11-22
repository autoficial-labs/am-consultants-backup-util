// Formatting and comparison of Tally snapshots (companies, ledgers, vouchers).
import type { TallyLedger, TallySnapshotData, TallyVoucher } from './types';

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1,180.00 (no sign). */
export function amount(v: number): string {
  return money.format(Math.abs(v));
}

/** Tally balance: debit is negative. "41,250.00 Dr", "86,400.00 Cr", "0.00". */
export function balance(v: number): string {
  if (Math.abs(v) < 0.005) return '0.00';
  return `${money.format(Math.abs(v))} ${v < 0 ? 'Dr' : 'Cr'}`;
}

/** Signed change in a balance, in Tally terms ("+1,200.00 Dr"). */
export function balanceDelta(before: number, after: number): string {
  const d = after - before;
  if (Math.abs(d) < 0.005) return '0.00';
  return `${money.format(Math.abs(d))} ${d < 0 ? 'Dr' : 'Cr'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-20" -> "20 Nov 2026". */
export function tallyDate(d: string | null | undefined): string {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export type VoucherChangeKind = 'added' | 'removed' | 'changed';

export interface VoucherChange {
  kind: VoucherChangeKind;
  before: TallyVoucher | null;
  after: TallyVoucher | null;
  /** Fields that differ, for changed vouchers. */
  fields: string[];
}

export interface LedgerChange {
  name: string;
  group: string;
  before: number | null;
  after: number | null;
}

export interface SnapshotDiff {
  vouchers: VoucherChange[];
  ledgers: LedgerChange[];
  added: number;
  removed: number;
  changed: number;
}

const FIELD_LABELS: [keyof TallyVoucher, string][] = [
  ['date', 'date'],
  ['amount', 'amount'],
  ['party', 'party'],
  ['number', 'number'],
  ['type', 'type'],
  ['narration', 'narration'],
  ['cancelled', 'cancelled'],
];

/** What changes when going from `from` to `to`. */
export function diffSnapshots(from: TallySnapshotData, to: TallySnapshotData): SnapshotDiff {
  const before = new Map(from.vouchers.map((v) => [v.guid, v]));
  const after = new Map(to.vouchers.map((v) => [v.guid, v]));
  // Vouchers older than the start of either snapshot's period are not in both lists.
  const start = from.period.from > to.period.from ? from.period.from : to.period.from;
  const vouchers: VoucherChange[] = [];
  for (const [guid, b] of after) {
    const a = before.get(guid);
    if (!a) {
      if (b.date >= start) vouchers.push({ kind: 'added', before: null, after: b, fields: [] });
      continue;
    }
    const fields = FIELD_LABELS.filter(([k]) => (k === 'amount' ? Math.abs(a.amount - b.amount) >= 0.005 : a[k] !== b[k])).map(([, l]) => l);
    if (fields.length || a.alterId !== b.alterId) vouchers.push({ kind: 'changed', before: a, after: b, fields });
  }
  for (const [guid, a] of before) {
    if (!after.has(guid) && a.date >= start) vouchers.push({ kind: 'removed', before: a, after: null, fields: [] });
  }
  const order = { added: 0, changed: 1, removed: 2 };
  vouchers.sort((x, y) => order[x.kind] - order[y.kind] || ((y.after ?? y.before)!.date).localeCompare((x.after ?? x.before)!.date));

  const lb = new Map(from.ledgers.map((l) => [l.name, l]));
  const la = new Map(to.ledgers.map((l) => [l.name, l]));
  const ledgers: LedgerChange[] = [];
  for (const name of new Set([...lb.keys(), ...la.keys()])) {
    const b = lb.get(name);
    const a = la.get(name);
    if (b && a && Math.abs(b.closing - a.closing) < 0.005) continue;
    ledgers.push({ name, group: (a ?? b)!.group, before: b?.closing ?? null, after: a?.closing ?? null });
  }
  ledgers.sort((x, y) => Math.abs((y.after ?? 0) - (y.before ?? 0)) - Math.abs((x.after ?? 0) - (x.before ?? 0)));
  return {
    vouchers,
    ledgers,
    added: vouchers.filter((v) => v.kind === 'added').length,
    removed: vouchers.filter((v) => v.kind === 'removed').length,
    changed: vouchers.filter((v) => v.kind === 'changed').length,
  };
}

export interface TypeTotal {
  type: string;
  count: number;
  total: number;
}

export function totalsByType(vouchers: TallyVoucher[]): TypeTotal[] {
  const m = new Map<string, TypeTotal>();
  for (const v of vouchers) {
    if (v.cancelled) continue;
    const t = m.get(v.type) ?? { type: v.type || 'Other', count: 0, total: 0 };
    t.count++;
    t.total += Math.abs(v.amount);
    m.set(v.type, t);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export function cashAndBank(ledgers: TallyLedger[]): TallyLedger[] {
  return ledgers.filter((l) => /cash|bank/i.test(l.group)).sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));
}
