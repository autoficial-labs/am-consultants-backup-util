import { Caption1, Caption1Strong, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { count, dayLabel, time } from '../lib/format';

const useStyles = makeStyles({
  chart: { position: 'relative', outline: 'none', borderRadius: tokens.borderRadiusMedium },
  chartFocus: { ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '4px' } },
  plot: {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  col: {
    flex: '1 1 0',
    height: '100%',
    display: 'flex',
    alignItems: 'flex-end',
    cursor: 'pointer',
    minWidth: 0,
  },
  bar: {
    width: '100%',
    borderRadius: '4px 4px 0 0',
    backgroundColor: tokens.colorBrandBackground,
    transitionProperty: 'background-color, height',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveDecelerateMid,
  },
  barActive: { backgroundColor: tokens.colorBrandBackgroundHover },
  barMuted: { backgroundColor: tokens.colorNeutralStroke1 },
  barMutedActive: { backgroundColor: tokens.colorNeutralStrokeAccessible },
  grid: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTop: `1px dashed ${tokens.colorNeutralStroke2}`,
    pointerEvents: 'none',
  },
  gridLabel: { position: 'absolute', right: 0, top: '-18px', color: tokens.colorNeutralForeground3 },
  ticks: { position: 'relative', height: '20px', marginTop: '6px' },
  tick: { position: 'absolute', top: 0, transform: 'translateX(-50%)', color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  tickStart: { transform: 'none' },
  tickEnd: { transform: 'translateX(-100%)' },
  tooltip: {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    transform: 'translateX(-50%)',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow16,
    borderRadius: tokens.borderRadiusMedium,
    padding: '6px 10px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  tooltipHint: { color: tokens.colorNeutralForeground3 },
  undoZone: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: tokens.colorBrandBackground2,
    borderTopRightRadius: tokens.borderRadiusMedium,
    pointerEvents: 'none',
  },
  marker: {
    position: 'absolute',
    top: '-30px',
    bottom: '-1px',
    width: '2px',
    marginLeft: '-1px',
    backgroundColor: tokens.colorNeutralForeground1,
    pointerEvents: 'none',
  },
  handle: {
    position: 'absolute',
    top: '-34px',
    transform: 'translateX(-50%)',
    padding: '3px 10px',
    width: 'max-content',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralForeground1,
    color: tokens.colorNeutralBackground1,
    whiteSpace: 'nowrap',
    cursor: 'grab',
    boxShadow: tokens.shadow4,
    outline: 'none',
    ':focus-visible': { boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}, 0 0 0 4px ${tokens.colorStrokeFocus2}` },
  },
  scrubArea: { touchAction: 'none', cursor: 'col-resize' },
  segBar: { display: 'flex', gap: '2px', height: '8px', width: '100%' },
  seg: {
    height: '100%',
    minWidth: '4px',
    ':first-child': { borderTopLeftRadius: '4px', borderBottomLeftRadius: '4px' },
    ':last-child': { borderTopRightRadius: '4px', borderBottomRightRadius: '4px' },
  },
  segEmpty: { flex: '1 1 0', height: '100%', borderRadius: '4px', backgroundColor: tokens.colorNeutralStroke2 },
});

function bucketize(events: { at: number }[], from: number, to: number, buckets: number) {
  const size = (to - from) / buckets;
  const counts = new Array<number>(buckets).fill(0);
  for (const e of events) {
    if (e.at <= from || e.at > to) continue;
    const i = Math.min(buckets - 1, Math.floor((e.at - from) / size));
    counts[i]! += 1;
  }
  return { counts, size, max: Math.max(1, ...counts) };
}

function niceMax(max: number) {
  if (max <= 5) return max;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function tickLabel(ms: number, rangeMs: number) {
  return rangeMs <= 36 * 3_600_000 ? time(ms) : dayLabel(ms);
}

/** Change activity over a recent window. Click (or Enter on) a bar to jump to that moment. */
export function ActivityChart({
  events,
  hours = 24,
  buckets = 48,
  height = 112,
  onPick,
  label,
}: {
  events: { at: number }[];
  hours?: number;
  buckets?: number;
  height?: number;
  onPick?: (at: number) => void;
  label: string;
}) {
  const s = useStyles();
  // Re-anchor the window whenever new data arrives, so a long-open window never goes stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [events]);
  const from = now - hours * 3_600_000;
  const { counts, size, max } = useMemo(() => bucketize(events, from, now, buckets), [events, from, now, buckets]);
  const top = niceMax(max);
  const [active, setActive] = useState<number | null>(null);
  const total = counts.reduce((a, b) => a + b, 0);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(buckets - 1, (a ?? buckets - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if ((e.key === 'Enter' || e.key === ' ') && active !== null && onPick) {
      e.preventDefault();
      onPick(Math.round(from + (active + 1) * size));
    }
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div
      className={mergeClasses(s.chart, s.chartFocus)}
      tabIndex={0}
      role="group"
      aria-label={`${label}: ${count(total)} changes. Use arrow keys to explore, Enter to restore to that time.`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
    >
      <div className={s.plot} style={{ height }} onPointerLeave={() => setActive(null)}>
        {top > 0 ? (
          <div className={s.grid} style={{ top: 0 }}>
            <Caption1 className={mergeClasses(s.gridLabel, 'tabular')}>{count(top)}</Caption1>
          </div>
        ) : null}
        {counts.map((c, i) => (
          <div
            key={i}
            className={s.col}
            onPointerEnter={() => setActive(i)}
            onClick={() => onPick?.(Math.round(from + (i + 1) * size))}
            aria-hidden
          >
            {c > 0 ? (
              <div className={mergeClasses(s.bar, active === i && s.barActive)} style={{ height: `${Math.max(4, (c / top) * 100)}%` }} />
            ) : null}
          </div>
        ))}
        {active !== null ? (
          <div className={s.tooltip} style={{ left: `${((active + 0.5) / buckets) * 100}%` }} role="tooltip">
            <Caption1Strong>
              {time(from + active * size)} – {time(from + (active + 1) * size)}
            </Caption1Strong>
            <Caption1>{counts[active] ? `${count(counts[active]!)} file change${counts[active] === 1 ? '' : 's'}` : 'No changes'}</Caption1>
            {onPick ? <Caption1 className={s.tooltipHint}>Click to restore to this time</Caption1> : null}
          </div>
        ) : null}
      </div>
      <div className={s.ticks} aria-hidden>
        {ticks.map((t, i) => (
          <Caption1
            key={t}
            className={mergeClasses(s.tick, i === 0 && s.tickStart, i === ticks.length - 1 && s.tickEnd)}
            style={{ left: `${t * 100}%` }}
          >
            {t === 1 ? 'Now' : time(from + t * (now - from))}
          </Caption1>
        ))}
      </div>
    </div>
  );
}

/**
 * Restore-point picker drawn over the change history: bars to the right of the marker are the
 * changes the restore will undo. Drag the marker or use the arrow keys.
 */
export function TimelineScrubber({
  from,
  to,
  events,
  value,
  onChange,
  min,
  buckets = 72,
  height = 96,
}: {
  from: number;
  to: number;
  events: { at: number }[];
  value: number;
  onChange: (v: number) => void;
  min?: number | null;
  buckets?: number;
  height?: number;
}) {
  const s = useStyles();
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const { counts, size, max } = useMemo(() => bucketize(events, from, to, buckets), [events, from, to, buckets]);
  const top = niceMax(max);
  const lo = Math.max(from, min ?? from);
  const clamp = (v: number) => Math.round(Math.min(to, Math.max(lo, v)) / 60_000) * 60_000;
  const pos = ((Math.min(to, Math.max(from, value)) - from) / (to - from)) * 100;
  const undone = events.filter((e) => e.at > value && e.at <= to).length;

  const fromPointer = (e: PointerEvent) => {
    const rect = plotRef.current!.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    return from + (x / rect.width) * (to - from);
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 3_600_000 : 5 * 60_000;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    if (e.key === 'PageDown') next = value - 6 * 3_600_000;
    if (e.key === 'PageUp') next = value + 6 * 3_600_000;
    if (e.key === 'Home') next = lo;
    if (e.key === 'End') next = to;
    if (next !== null) {
      e.preventDefault();
      onChange(clamp(next));
    }
  };

  const range = to - from;
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const hoverIdx = hover !== null && !dragging ? Math.min(buckets - 1, Math.floor((hover - from) / size)) : null;

  return (
    <div className={s.chart} style={{ paddingTop: 40 }}>
      <div
        ref={plotRef}
        className={mergeClasses(s.plot, s.scrubArea)}
        style={{ height }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          onChange(clamp(fromPointer(e)));
        }}
        onPointerMove={(e) => {
          if (dragging) onChange(clamp(fromPointer(e)));
          else setHover(fromPointer(e));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
      >
        <div className={s.undoZone} style={{ left: `${pos}%` }} />
        {counts.map((c, i) => {
          const after = from + i * size >= value;
          return (
            <div key={i} className={s.col} style={{ cursor: 'inherit', position: 'relative', zIndex: 1 }} aria-hidden>
              {c > 0 ? (
                <div
                  className={mergeClasses(s.bar, !after && s.barMuted, hoverIdx === i && (after ? s.barActive : s.barMutedActive))}
                  style={{ height: `${Math.max(4, (c / top) * 100)}%` }}
                />
              ) : null}
            </div>
          );
        })}
        <div className={s.marker} style={{ left: `${pos}%`, zIndex: 2 }} />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Restore point"
          aria-valuemin={lo}
          aria-valuemax={to}
          aria-valuenow={value}
          aria-valuetext={`${dayLabel(value)} at ${time(value)}. ${undone} later change${undone === 1 ? '' : 's'} will be undone.`}
          className={s.handle}
          style={{ left: `clamp(48px, ${pos}%, calc(100% - 48px))`, zIndex: 3 }}
          onKeyDown={onKey}
        >
          <Caption1Strong className="tabular">{range > 36 * 3_600_000 ? `${dayLabel(value)} ${time(value)}` : time(value)}</Caption1Strong>
        </div>
        {hoverIdx !== null ? (
          <div className={s.tooltip} style={{ left: `${((hoverIdx + 0.5) / buckets) * 100}%`, bottom: 'calc(100% + 40px)' }} role="tooltip">
            <Caption1Strong>
              {time(from + hoverIdx * size)} – {time(from + (hoverIdx + 1) * size)}
            </Caption1Strong>
            <Caption1>{counts[hoverIdx] ? `${count(counts[hoverIdx]!)} change${counts[hoverIdx] === 1 ? '' : 's'}` : 'No changes'}</Caption1>
            <Caption1 className={s.tooltipHint}>Click or drag to choose</Caption1>
          </div>
        ) : null}
      </div>
      <div className={s.ticks} aria-hidden>
        {ticks.map((t, i) => (
          <Caption1
            key={t}
            className={mergeClasses(s.tick, i === 0 && s.tickStart, i === ticks.length - 1 && s.tickEnd)}
            style={{ left: `${t * 100}%` }}
          >
            {t === 1 ? 'Now' : tickLabel(from + t * range, range)}
          </Caption1>
        ))}
      </div>
    </div>
  );
}

export interface Segment {
  key: string;
  value: number;
  color: string;
  label: string;
}

/** Thin part-to-whole bar; identity is carried by the legend beside it, never by colour alone. */
export function SegmentBar({ segments, label }: { segments: Segment[]; label: string }) {
  const s = useStyles();
  const total = segments.reduce((a, b) => a + b.value, 0);
  return (
    <div className={s.segBar} role="img" aria-label={`${label}: ${segments.map((g) => `${g.value} ${g.label}`).join(', ')}`}>
      {total === 0 ? (
        <div className={s.segEmpty} />
      ) : (
        segments
          .filter((g) => g.value > 0)
          .map((g) => <div key={g.key} className={s.seg} style={{ flex: `${g.value} 1 0`, backgroundColor: g.color }} title={`${g.label}: ${g.value}`} />)
      )}
    </div>
  );
}
