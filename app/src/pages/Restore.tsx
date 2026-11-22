import {
  Badge,
  Body1,
  Button,
  Caption1,
  Caption1Strong,
  Checkbox,
  Dropdown,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  ProgressBar,
  Radio,
  RadioGroup,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Spinner,
  Subtitle2,
  Tab,
  TabList,
  Text,
  ToggleButton,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Archive24Regular,
  ArrowDownload16Regular,
  ArrowLeft20Regular,
  ArrowSwap16Regular,
  Calendar20Regular,
  CheckmarkCircle16Regular,
  CheckmarkCircle48Filled,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Clock24Regular,
  Delete16Regular,
  Document20Regular,
  Folder16Regular,
  Folder24Regular,
  FolderOpen20Regular,
  FolderArrowLeft24Regular,
  Warning20Filled,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SegmentBar, TimelineScrubber } from '../components/charts';
import { FolderTree } from '../components/FolderTree';
import { TallyImpact } from '../components/TallyImpact';
import { ConfirmDialog, EmptyState, OptionCards, Page, PageHeader, Panel, useLoader } from '../components/ui';
import { api, backend, errorMessage, pickFolder } from '../lib/backend';
import { ago, bytes, count, dayLabel, onDay, plural, shortWhen, splitPath, time, when } from '../lib/format';
import { buildTree, foldersFromFiles } from '../lib/tree';
import type { FileVersion, FullBackup, ItemStatus, Manifest, PlanItem, RestorePlan, RestoreReport, SnapshotFile, Timeline } from '../lib/types';
import { useApp } from '../state';
import { diffColors } from '../theme';

const HOUR = 3_600_000;
const PRESETS = [2, 4, 6, 8] as const;
const WINDOWS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];
const PAGE_ROWS = 400;

const useStyles = makeStyles({
  sectionHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' },
  stepNo: {
    display: 'inline-grid',
    placeItems: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    marginRight: '10px',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    verticalAlign: 'middle',
  },
  muted: { color: tokens.colorNeutralForeground3 },
  presetRow: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '8px' },
  presetSpacer: { flex: 1 },
  legend: { display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  callout: {
    marginTop: '16px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 14px',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  calloutIcon: { color: tokens.colorBrandForeground1, display: 'flex' },
  fullList: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '340px', overflowY: 'auto', paddingRight: '4px' },
  dest: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', minWidth: 0 },
  destPath: {
    flex: 1,
    minWidth: 0,
    padding: '7px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actionBar: {
    position: 'sticky',
    bottom: '-48px',
    marginBottom: '-20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '14px 20px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    zIndex: 5,
    flexWrap: 'wrap',
  },
  actionInfo: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  actionButtons: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  // review
  summary: { display: 'flex', flexDirection: 'column', gap: '14px' },
  chips: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px' },
  chip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  chipOff: { opacity: 0.55 },
  chipTop: { display: 'flex', alignItems: 'center', gap: '6px' },
  chipCount: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightBase500 },
  reviewGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 320px',
    gap: '16px',
    alignItems: 'start',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  listPanel: { padding: 0, overflow: 'hidden' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 14px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
  },
  list: { maxHeight: 'calc(100vh - 430px)', minHeight: '260px', overflowY: 'auto' },
  groupRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '8px 14px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: 'none',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: tokens.colorNeutralForeground2,
    textAlign: 'left',
    position: 'sticky',
    top: 0,
    zIndex: 1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  groupCounts: { marginLeft: 'auto', display: 'flex', gap: '10px' },
  fileRow: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 14px 4px 10px',
    minHeight: '44px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  fileRowActive: { backgroundColor: tokens.colorSubtleBackgroundSelected, ':hover': { backgroundColor: tokens.colorSubtleBackgroundSelected } },
  fileName: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusTag: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  numCol: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', textAlign: 'right', color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' },
  detail: { display: 'flex', flexDirection: 'column', gap: '16px' },
  compare: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  compareCell: {
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  sizeBar: { height: '6px', borderRadius: '3px', backgroundColor: tokens.colorNeutralStroke2, overflow: 'hidden' },
  sizeFill: { height: '100%', borderRadius: '3px' },
  versions: { display: 'flex', flexDirection: 'column', position: 'relative', paddingLeft: '18px' },
  versionLine: { position: 'absolute', left: '5px', top: '6px', bottom: '6px', width: '2px', backgroundColor: tokens.colorNeutralStroke2 },
  version: { position: 'relative', display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '5px 0' },
  dot: {
    position: 'absolute',
    left: '-17px',
    top: '9px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `2px solid ${tokens.colorNeutralStrokeAccessible}`,
    boxSizing: 'border-box',
  },
  dotChosen: { backgroundColor: tokens.colorBrandBackground, border: `2px solid ${tokens.colorBrandBackground}` },
  pointMarker: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', color: tokens.colorBrandForeground1 },
  pointRule: { flex: 1, height: '0', borderTop: `2px dashed ${tokens.colorBrandStroke1}` },
  done: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '10px', padding: '40px 24px' },
  doneIcon: { color: tokens.colorStatusSuccessForeground1, display: 'flex' },
  failList: { textAlign: 'left', maxHeight: '220px', overflowY: 'auto', width: '100%', maxWidth: '720px' },
});

type Stage = 'setup' | 'review' | 'done';

const STATUS_META: Record<ItemStatus, { label: string; short: string; icon: ReactElement }> = {
  restore: { label: 'Will be restored', short: 'Restore', icon: <ArrowDownload16Regular /> },
  overwrite: { label: 'Will be replaced', short: 'Replace', icon: <ArrowSwap16Regular /> },
  extra: { label: 'Only in destination', short: 'Not in backup', icon: <Delete16Regular /> },
  same: { label: 'Already identical', short: 'Identical', icon: <CheckmarkCircle16Regular /> },
};

function sameFolder(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const n = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

export default function Restore() {
  const s = useStyles();
  const app = useApp();
  const { intent, isAdmin, canWrite, config, status, dark, notify } = app;
  const colors = dark ? diffColors.dark : diffColors.light;

  const [mode, setMode] = useState<'pointInTime' | 'full'>(intent?.kind === 'full' && isAdmin ? 'full' : 'pointInTime');
  const [now, setNow] = useState(() => Date.now());
  const [windowHours, setWindowHours] = useState(() => {
    if (intent?.kind === 'pointInTime') {
      const age = (Date.now() - intent.at) / HOUR;
      return WINDOWS.find((w) => w.hours >= age + 1)?.hours ?? 720;
    }
    return 24;
  });
  const [at, setAt] = useState<number>(() => (intent?.kind === 'pointInTime' ? intent.at : Math.round((Date.now() - 2 * HOUR) / 60000) * 60000));
  const [fullId, setFullId] = useState<number | null>(intent?.kind === 'full' ? intent.id : null);
  const [scopeAll, setScopeAll] = useState(true);
  const [scope, setScope] = useState<string[]>([]);
  const originalAvailable = canWrite && Boolean(config.watchedFolder);
  const [destKind, setDestKind] = useState<'original' | 'other'>('other');
  const [otherDest, setOtherDest] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>('setup');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Set<ItemStatus>>(new Set(['restore', 'overwrite', 'extra']));
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<PlanItem | null>(null);
  const [removeExtras, setRemoveExtras] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [rows, setRows] = useState(PAGE_ROWS);

  // Re-apply navigation intents (e.g. clicking a bar on the overview).
  useEffect(() => {
    if (!intent || intent.kind === 'tallyCompare') return;
    setStage('setup');
    if (intent.kind === 'pointInTime') {
      setMode('pointInTime');
      setAt(intent.at);
    } else if (isAdmin) {
      setMode('full');
      setFullId(intent.id);
    }
  }, [intent, isAdmin]);

  const from = now - windowHours * HOUR;
  const timeline = useLoader(() => api<Timeline>('GET', `/api/timeline?from=${from}&to=${now}`), [from, now]);
  const earliest = timeline.data?.earliest ?? null;
  const fulls = useLoader(() => (isAdmin ? api<{ backups: FullBackup[] }>('GET', '/api/full-backups') : Promise.resolve({ backups: [] })), [isAdmin]);
  const completeFulls = useMemo(() => (fulls.data?.backups ?? []).filter((b) => b.status === 'complete'), [fulls.data]);
  useEffect(() => {
    if (mode === 'full' && fullId === null && completeFulls[0]) setFullId(completeFulls[0].id);
  }, [mode, fullId, completeFulls]);

  // Files at the chosen moment (for the folder picker and totals), debounced while dragging.
  const [debouncedAt, setDebouncedAt] = useState(at);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAt(at), 350);
    return () => window.clearTimeout(t);
  }, [at]);
  const contents = useLoader(async () => {
    if (mode === 'full') {
      if (fullId === null) return [] as { path: string; size: number }[];
      const m = await api<Manifest>('GET', `/api/full-backups/${fullId}/manifest`);
      return m.files.map((f) => ({ path: f.path, size: f.size }));
    }
    const snap = await api<{ files: SnapshotFile[] }>('GET', `/api/snapshot?at=${debouncedAt}`);
    return snap.files.map((f) => ({ path: f.path, size: f.size }));
  }, [mode, fullId, debouncedAt]);
  const folderRoots = useMemo(() => buildTree(foldersFromFiles(contents.data ?? [])), [contents.data]);
  const totals = useMemo(() => {
    const files = contents.data ?? [];
    return { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
  }, [contents.data]);

  const events = useMemo(() => (timeline.data?.events ?? []).map((e) => ({ at: e.created_at })), [timeline.data]);
  const undone = useMemo(() => (timeline.data?.events ?? []).filter((e) => e.created_at > at), [timeline.data, at]);
  const undoneFiles = useMemo(() => new Set(undone.map((e) => e.path)).size, [undone]);

  const dest = destKind === 'original' && originalAvailable ? config.watchedFolder : otherDest;
  const intoLive = sameFolder(dest, config.watchedFolder);

  const choosePreset = (hours: number) => {
    const n = Date.now();
    setNow(n);
    if (hours * HOUR > windowHours * HOUR * 0.95) setWindowHours(WINDOWS.find((w) => w.hours > hours)?.hours ?? 720);
    setAt(Math.round((n - hours * HOUR) / 60000) * 60000);
  };

  const compare = async () => {
    if (!dest) {
      setPlanError('Choose where the files should be restored.');
      return;
    }
    if (mode === 'full' && fullId === null) {
      setPlanError('Choose a complete backup to restore.');
      return;
    }
    if (!scopeAll && scope.length === 0) {
      setPlanError('Tick at least one folder, or choose "Everything".');
      return;
    }
    setPlanning(true);
    setPlanError(null);
    try {
      const source = mode === 'full' ? ({ kind: 'full', id: fullId! } as const) : ({ kind: 'pointInTime', at } as const);
      const p = await backend.restorePlan(source, dest, scopeAll ? [] : scope);
      setPlan(p);
      setSelected(new Set(p.items.filter((i) => i.status === 'restore' || i.status === 'overwrite').map((i) => i.path)));
      setFilters(new Set(p.summary.restore + p.summary.overwrite + p.summary.extra > 0 ? ['restore', 'overwrite', 'extra'] : ['same']));
      setActive(p.items.find((i) => i.status === 'overwrite') ?? p.items.find((i) => i.status === 'restore') ?? null);
      setRemoveExtras(false);
      setSearch('');
      setCollapsed(new Set());
      setRows(PAGE_ROWS);
      setStage('review');
    } catch (e) {
      setPlanError(errorMessage(e));
    } finally {
      setPlanning(false);
    }
  };

  const execute = async () => {
    if (!plan) return;
    setRunning(true);
    try {
      const extras = removeExtras ? plan.items.filter((i) => i.status === 'extra').map((i) => i.path) : [];
      const r = await backend.restoreExecute(plan.id, [...selected, ...extras], removeExtras);
      setReport(r);
      setStage('done');
      setConfirming(false);
      if (r.failed.length) notify('warning', `Restored ${plural(r.restored, 'file')}`, `${plural(r.failed.length, 'file')} could not be restored.`);
      else notify('success', `Restored ${plural(r.restored, 'file')}`);
    } catch (e) {
      notify('error', 'Restore failed', errorMessage(e));
      setConfirming(false);
    } finally {
      setRunning(false);
    }
  };

  // ---------------------------------------------------------------- review data
  const items = plan?.items ?? [];
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => filters.has(i.status) && (!q || i.path.toLowerCase().includes(q)));
  }, [items, filters, search]);
  const groups = useMemo(() => {
    const map = new Map<string, PlanItem[]>();
    for (const i of visible.slice(0, rows)) {
      const { folder } = splitPath(i.path);
      const list = map.get(folder) ?? [];
      list.push(i);
      map.set(folder, list);
    }
    return [...map.entries()];
  }, [visible, rows]);
  const actionable = items.filter((i) => i.status === 'restore' || i.status === 'overwrite');
  const selectedItems = actionable.filter((i) => selected.has(i.path));
  const selectedBytes = selectedItems.reduce((a, i) => a + i.size, 0);
  const extrasCount = plan?.summary.extra ?? 0;
  const willChange = selectedItems.length + (removeExtras ? extrasCount : 0);
  const overwriteSelected = selectedItems.filter((i) => i.status === 'overwrite').length;

  const visibleActionable = visible.filter((i) => i.status === 'restore' || i.status === 'overwrite');
  const allVisibleSelected = visibleActionable.length > 0 && visibleActionable.every((i) => selected.has(i.path));
  const someVisibleSelected = visibleActionable.some((i) => selected.has(i.path));

  const versions = useLoader(
    () =>
      active && plan?.source.kind === 'pointInTime' && active.status !== 'extra'
        ? api<{ versions: FileVersion[] }>('GET', `/api/versions?path=${encodeURIComponent(active.path)}`).then((r) => r.versions)
        : Promise.resolve([] as FileVersion[]),
    [active?.path, plan?.id],
  );

  const sourceLabel = plan
    ? plan.source.kind === 'pointInTime'
      ? `${onDay(plan.source.at)} at ${time(plan.source.at)}`
      : `in the complete backup from ${when(completeFulls.find((f) => f.id === (plan.source as { id: number }).id)?.created_at ?? plan.createdAt)}`
    : '';

  const progress = status.job === 'restore' ? status.progress : null;

  // ---------------------------------------------------------------- render
  if (stage === 'done' && report && plan) {
    return (
      <Page>
        <PageHeader title="Restore files" />
        <Panel>
          <div className={s.done}>
            <span className={s.doneIcon} aria-hidden>
              {report.failed.length ? <Warning20Filled style={{ color: tokens.colorStatusWarningForeground1, fontSize: 48 }} /> : <CheckmarkCircle48Filled />}
            </span>
            <Subtitle2 as="h2" style={{ fontSize: tokens.fontSizeBase500 }}>
              {report.cancelled ? 'Restore stopped' : report.failed.length ? 'Restore finished with problems' : 'Restore complete'}
            </Subtitle2>
            <Body1 className={s.muted}>
              {plural(report.restored, 'file')} restored ({bytes(report.bytes)})
              {report.removed ? `, ${plural(report.removed, 'file')} moved to the Recycle Bin` : ''} in {report.seconds < 60 ? `${Math.max(1, report.seconds)} s` : `${Math.round(report.seconds / 60)} min`}.
              <br />
              Files now match how they were {sourceLabel}.
            </Body1>
            {report.failed.length ? (
              <MessageBar intent="warning" layout="multiline" className={s.failList}>
                <MessageBarBody>
                  <MessageBarTitle>{plural(report.failed.length, 'file')} could not be restored</MessageBarTitle>
                  {report.failed.slice(0, 30).map((f) => (
                    <div key={f.path}>
                      <strong>{f.path}</strong>: {f.error}
                    </div>
                  ))}
                </MessageBarBody>
              </MessageBar>
            ) : null}
            <div className={s.actionButtons} style={{ marginTop: 8 }}>
              <Button appearance="primary" icon={<FolderOpen20Regular />} onClick={() => void backend.openPath(plan.dest)}>
                Open folder
              </Button>
              <Button onClick={() => (setStage('setup'), setPlan(null), setReport(null))}>Restore something else</Button>
            </div>
          </div>
        </Panel>
      </Page>
    );
  }

  if (stage === 'review' && plan) {
    const chip = (key: ItemStatus, value: number, extra?: string) => {
      const meta = STATUS_META[key];
      const on = filters.has(key);
      return (
        <button
          type="button"
          className={mergeClasses(s.chip, !on && s.chipOff)}
          aria-pressed={on}
          onClick={() => {
            const next = new Set(filters);
            if (on) next.delete(key);
            else next.add(key);
            setFilters(next);
            setRows(PAGE_ROWS);
          }}
        >
          <span className={s.chipTop}>
            <span className={s.swatch} style={{ backgroundColor: colors[key] }} />
            <Caption1Strong>{meta.label}</Caption1Strong>
          </span>
          <span className={`${s.chipCount} tabular`}>{count(value)}</span>
          <Caption1 className={s.muted}>{extra}</Caption1>
        </button>
      );
    };

    return (
      <Page>
        <PageHeader
          title="Review changes"
          description={
            <>
              Restoring files as they were <strong>{sourceLabel}</strong> into <strong className="selectable">{plan.dest}</strong>. Nothing changes until you confirm.
            </>
          }
          actions={
            <Button icon={<ArrowLeft20Regular />} onClick={() => setStage('setup')} disabled={running}>
              Change selection
            </Button>
          }
        />

        <Panel className={s.summary}>
          <SegmentBar
            label="Comparison summary"
            segments={(['restore', 'overwrite', 'extra', 'same'] as ItemStatus[]).map((k) => ({
              key: k,
              value: plan.summary[k],
              color: colors[k],
              label: STATUS_META[k].label,
            }))}
          />
          <div className={s.chips} role="group" aria-label="Show files by change">
            {chip('restore', plan.summary.restore, `Missing at destination · ${bytes(plan.items.filter((i) => i.status === 'restore').reduce((a, i) => a + i.size, 0))}`)}
            {chip('overwrite', plan.summary.overwrite, 'Different at destination')}
            {chip('extra', plan.summary.extra, 'Kept unless you remove them')}
            {chip('same', plan.summary.same, 'Skipped')}
          </div>
        </Panel>

        {plan.summary.restore + plan.summary.overwrite + plan.summary.extra === 0 ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Nothing to restore</MessageBarTitle>
              Every file in the destination already matches the backup.
            </MessageBarBody>
          </MessageBar>
        ) : null}

        <TallyImpact plan={plan} />

        <div className={s.reviewGrid}>
          <Panel className={s.listPanel} pad={false}>
            <div className={s.toolbar}>
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? 'mixed' : false}
                disabled={!visibleActionable.length}
                onChange={() => {
                  const next = new Set(selected);
                  if (allVisibleSelected) visibleActionable.forEach((i) => next.delete(i.path));
                  else visibleActionable.forEach((i) => next.add(i.path));
                  setSelected(next);
                }}
                label={`${count(selectedItems.length)} of ${count(actionable.length)} selected`}
              />
              <span style={{ flex: 1 }} />
              <SearchBox placeholder="Find a file" value={search} onChange={(_, d) => (setSearch(d.value), setRows(PAGE_ROWS))} size="small" style={{ width: 220 }} />
            </div>
            <div className={s.list} role="list" aria-label="Files">
              {groups.length === 0 ? (
                <EmptyState title="No files match" body="Change the filters above or clear the search." />
              ) : (
                groups.map(([folder, list]) => {
                  const isCollapsed = collapsed.has(folder);
                  const counts = list.reduce<Record<string, number>>((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + 1), acc), {});
                  return (
                    <div key={folder || '/'}>
                      <button
                        type="button"
                        className={s.groupRow}
                        aria-expanded={!isCollapsed}
                        onClick={() => {
                          const next = new Set(collapsed);
                          if (isCollapsed) next.delete(folder);
                          else next.add(folder);
                          setCollapsed(next);
                        }}
                      >
                        {isCollapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
                        <Folder16Regular />
                        <Caption1Strong className={s.ellipsis}>{folder || 'Top folder'}</Caption1Strong>
                        <span className={s.groupCounts}>
                          {(['restore', 'overwrite', 'extra', 'same'] as ItemStatus[])
                            .filter((k) => counts[k])
                            .map((k) => (
                              <Caption1 key={k} className={s.statusTag} style={{ color: tokens.colorNeutralForeground2 }}>
                                <span className={s.swatch} style={{ backgroundColor: colors[k] }} />
                                {counts[k]}
                              </Caption1>
                            ))}
                        </span>
                      </button>
                      {!isCollapsed
                        ? list.map((i) => {
                            const meta = STATUS_META[i.status];
                            const actionableRow = i.status === 'restore' || i.status === 'overwrite';
                            const { name } = splitPath(i.path);
                            return (
                              <div
                                key={i.path}
                                role="listitem"
                                className={mergeClasses(s.fileRow, active?.path === i.path && s.fileRowActive)}
                                onClick={() => setActive(i)}
                              >
                                <span onClick={(e) => e.stopPropagation()}>
                                  {actionableRow ? (
                                    <Checkbox
                                      aria-label={`Restore ${name}`}
                                      checked={selected.has(i.path)}
                                      onChange={(_, d) => {
                                        const next = new Set(selected);
                                        if (d.checked) next.add(i.path);
                                        else next.delete(i.path);
                                        setSelected(next);
                                      }}
                                    />
                                  ) : null}
                                </span>
                                <span className={s.fileName}>
                                  <Text className={mergeClasses(s.ellipsis, 'selectable')} title={i.path}>
                                    {name}
                                  </Text>
                                  <Caption1 className={s.statusTag} style={{ color: tokens.colorNeutralForeground2 }}>
                                    <span style={{ color: colors[i.status], display: 'flex' }}>{meta.icon}</span>
                                    {meta.short}
                                  </Caption1>
                                </span>
                                <span className={s.numCol}>
                                  <Caption1 className="tabular" title={i.status === 'overwrite' ? 'Size now → size in backup' : undefined}>
                                    {i.status === 'overwrite' ? `${bytes(i.localSize)} → ${bytes(i.size)}` : i.status === 'extra' ? bytes(i.localSize) : bytes(i.size)}
                                  </Caption1>
                                  <Caption1 className={s.muted}>
                                    {i.status === 'extra' ? `Changed ${ago(i.localMtime)}` : `Modified ${shortWhen(i.mtime)}`}
                                  </Caption1>
                                </span>
                              </div>
                            );
                          })
                        : null}
                    </div>
                  );
                })
              )}
              {visible.length > rows ? (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <Button size="small" onClick={() => setRows(rows + PAGE_ROWS)}>
                    Show more ({count(visible.length - rows)} more)
                  </Button>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            {active ? (
              <div className={s.detail}>
                <div>
                  <Caption1 className={s.statusTag} style={{ color: tokens.colorNeutralForeground2 }}>
                    <span style={{ color: colors[active.status], display: 'flex' }}>{STATUS_META[active.status].icon}</span>
                    {STATUS_META[active.status].label}
                  </Caption1>
                  <Subtitle2 as="h3" className={mergeClasses(s.ellipsis, 'selectable')} style={{ display: 'block', marginTop: 4 }} title={active.path}>
                    {splitPath(active.path).name}
                  </Subtitle2>
                  <Caption1 className={mergeClasses(s.muted, 'selectable')}>{splitPath(active.path).folder || 'Top folder'}</Caption1>
                </div>
                <div className={s.compare}>
                  {[
                    { title: 'Backup copy', size: active.status === 'extra' ? null : active.size, time: active.status === 'extra' ? null : active.mtime, color: colors[active.status === 'extra' ? 'same' : active.status] },
                    { title: 'In destination now', size: active.localSize, time: active.localMtime, color: colors.same },
                  ].map((c) => {
                    const maxSize = Math.max(active.size || 0, active.localSize || 0, 1);
                    return (
                      <div key={c.title} className={s.compareCell}>
                        <Caption1 className={s.muted}>{c.title}</Caption1>
                        {c.size == null ? (
                          <Text weight="semibold">Not there</Text>
                        ) : (
                          <>
                            <Text weight="semibold" className="tabular">
                              {bytes(c.size)}
                            </Text>
                            <div className={s.sizeBar} aria-hidden>
                              <div className={s.sizeFill} style={{ width: `${(c.size / maxSize) * 100}%`, backgroundColor: c.color }} />
                            </div>
                            <Caption1 className={s.muted}>Modified {c.time ? when(c.time) : '—'}</Caption1>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {plan.source.kind === 'pointInTime' && active.status !== 'extra' ? (
                  <div>
                    <Caption1Strong>Saved versions</Caption1Strong>
                    {versions.loading ? (
                      <Skeleton aria-label="Loading versions">
                        <SkeletonItem style={{ height: 80, marginTop: 8 }} />
                      </Skeleton>
                    ) : (
                      <div className={s.versions} style={{ marginTop: 8 }}>
                        <span className={s.versionLine} aria-hidden />
                        {(() => {
                          const point = (plan.source as { at: number }).at;
                          const list = versions.data ?? [];
                          const chosen = list.find((v) => v.created_at <= point && v.op !== 'delete');
                          let markerShown = false;
                          const out: ReactElement[] = [];
                          list.slice(0, 12).forEach((v) => {
                            if (!markerShown && v.created_at <= point) {
                              markerShown = true;
                              out.push(
                                <div key="marker" className={s.pointMarker}>
                                  <Caption1Strong>Restore point · {time(point)}</Caption1Strong>
                                  <span className={s.pointRule} />
                                </div>,
                              );
                            }
                            out.push(
                              <div key={v.id} className={s.version}>
                                <span className={mergeClasses(s.dot, chosen?.id === v.id && s.dotChosen)} aria-hidden />
                                <span style={{ display: 'flex', flexDirection: 'column' }}>
                                  <Caption1 style={{ fontWeight: chosen?.id === v.id ? 600 : 400 }}>
                                    {v.op === 'add' ? 'First backed up' : v.op === 'modify' ? 'Changed' : 'Removed'}
                                    {chosen?.id === v.id ? ' · this copy' : ''}
                                  </Caption1>
                                  <Caption1 className={s.muted}>{when(v.created_at)}</Caption1>
                                </span>
                                <Caption1 className={mergeClasses(s.muted, 'tabular')}>{v.op === 'delete' ? '' : bytes(v.size)}</Caption1>
                              </div>,
                            );
                          });
                          if (!markerShown)
                            out.push(
                              <div key="marker" className={s.pointMarker}>
                                <Caption1Strong>Restore point · {time(point)}</Caption1Strong>
                                <span className={s.pointRule} />
                              </div>,
                            );
                          return out;
                        })()}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState icon={<Document20Regular />} title="Select a file" body="See how the backup copy compares with the file in the destination." />
            )}
          </Panel>
        </div>

        <div className={s.actionBar}>
          {progress ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ProgressBar value={progress.totalBytes ? progress.doneBytes / progress.totalBytes : undefined} thickness="large" aria-label="Restore progress" />
              <Caption1 className={s.muted}>
                {progress.stage}
                {progress.totalFiles ? ` · ${count(progress.doneFiles)} of ${count(progress.totalFiles)} files` : progress.totalBytes ? ` · ${bytes(progress.doneBytes)} of ${bytes(progress.totalBytes)}` : ''}
              </Caption1>
            </div>
          ) : (
            <div className={s.actionInfo}>
              {extrasCount > 0 ? (
                <Checkbox
                  checked={removeExtras}
                  onChange={(_, d) => setRemoveExtras(Boolean(d.checked))}
                  label={extrasCount === 1 ? "Also move the file that wasn't in the backup to the Recycle Bin" : `Also move the ${count(extrasCount)} files that weren't in the backup to the Recycle Bin`}
                />
              ) : (
                <Caption1 className={s.muted}>Files already identical are skipped.</Caption1>
              )}
            </div>
          )}
          <div className={s.actionButtons}>
            <Caption1 className={`${s.muted} tabular`}>
              {plural(selectedItems.length, 'file')} · {bytes(selectedBytes)}
            </Caption1>
            {running ? (
              <Button onClick={() => void backend.cancelJob()}>Stop</Button>
            ) : (
              <Button appearance="primary" disabled={willChange === 0 || Boolean(status.job)} onClick={() => (overwriteSelected || removeExtras || intoLive ? setConfirming(true) : void execute())}>
                {willChange === 0 ? 'Nothing selected' : `Restore ${plural(selectedItems.length, 'file')}`}
              </Button>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={confirming}
          title={intoLive ? 'Restore into your live Tally folder?' : 'Replace files in the destination?'}
          confirmLabel={running ? 'Restoring…' : 'Restore now'}
          danger={intoLive || removeExtras}
          busy={running}
          onCancel={() => setConfirming(false)}
          onConfirm={execute}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Body1>
              {overwriteSelected ? `${plural(overwriteSelected, 'file')} in ${plan.dest} will be replaced with the backup copy. ` : ''}
              {selectedItems.length - overwriteSelected ? `${plural(selectedItems.length - overwriteSelected, 'missing file')} will be brought back. ` : ''}
              {removeExtras ? `${plural(extrasCount, 'file')} will be moved to the Recycle Bin.` : ''}
            </Body1>
            {intoLive && status.tallyRunning ? (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Close Tally first</MessageBarTitle>
                  Tally is open and may overwrite restored files or fail to read them.
                </MessageBarBody>
              </MessageBar>
            ) : intoLive ? (
              <Caption1 className={s.muted}>
                The current versions stay in your backup history, so you can undo this restore later by restoring to {time(Date.now())}.
              </Caption1>
            ) : null}
          </div>
        </ConfirmDialog>
      </Page>
    );
  }

  // ---------------------------------------------------------------- setup
  const windowLabel = WINDOWS.find((w) => w.hours === windowHours)?.label ?? 'Last 24 hours';
  return (
    <Page>
      <PageHeader title="Restore files" description="Bring files back exactly as they were. You'll see every difference before anything is changed." />

      <Panel>
        <div className={s.sectionHead}>
          <Subtitle2 as="h2">
            <span className={s.stepNo}>1</span>Restore from
          </Subtitle2>
          {isAdmin ? (
            <TabList selectedValue={mode} onTabSelect={(_, d) => setMode(d.value as 'pointInTime' | 'full')} size="small">
              <Tab value="pointInTime" icon={<Clock24Regular />}>
                A moment in time
              </Tab>
              <Tab value="full" icon={<Archive24Regular />}>
                A complete backup
              </Tab>
            </TabList>
          ) : null}
        </div>

        {mode === 'pointInTime' ? (
          <>
            <div className={s.presetRow} role="group" aria-label="Quick choices">
              {PRESETS.map((h) => {
                const value = Math.round((now - h * HOUR) / 60000) * 60000;
                return (
                  <ToggleButton key={h} size="small" shape="circular" checked={Math.abs(at - value) < 60_000} onClick={() => choosePreset(h)}>
                    {h} hours ago
                  </ToggleButton>
                );
              })}
              <ToggleButton size="small" shape="circular" checked={Math.abs(at - now) < 60_000} onClick={() => choosePreset(0)}>
                Latest backup
              </ToggleButton>
              <span className={s.presetSpacer} />
              <Tooltip content="Pick an exact date and time" relationship="description">
                <Input
                  type="datetime-local"
                  size="small"
                  contentBefore={<Calendar20Regular />}
                  aria-label="Exact date and time"
                  value={(() => {
                    const d = new Date(at - new Date(at).getTimezoneOffset() * 60000);
                    return d.toISOString().slice(0, 16);
                  })()}
                  max={new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 16)}
                  onChange={(_, d) => {
                    const v = new Date(d.value).getTime();
                    if (!Number.isFinite(v)) return;
                    const clamped = Math.min(Date.now(), v);
                    const age = (Date.now() - clamped) / HOUR;
                    setNow(Date.now());
                    setWindowHours(WINDOWS.find((w) => w.hours >= age + 1)?.hours ?? 720);
                    setAt(clamped);
                  }}
                />
              </Tooltip>
              <Dropdown
                size="small"
                aria-label="Timeline range"
                value={windowLabel}
                selectedOptions={[String(windowHours)]}
                onOptionSelect={(_, d) => {
                  const h = Number(d.optionValue);
                  setNow(Date.now());
                  setWindowHours(h);
                  if (at < Date.now() - h * HOUR) setAt(Math.round((Date.now() - Math.min(2, h) * HOUR) / 60000) * 60000);
                }}
                style={{ minWidth: 150 }}
              >
                {WINDOWS.map((w) => (
                  <Option key={w.hours} value={String(w.hours)}>
                    {w.label}
                  </Option>
                ))}
              </Dropdown>
            </div>
            {timeline.loading && !timeline.data ? (
              <Skeleton aria-label="Loading timeline">
                <SkeletonItem style={{ height: 150 }} />
              </Skeleton>
            ) : timeline.error ? (
              <MessageBar intent="error">
                <MessageBarBody>{timeline.error}</MessageBarBody>
                <MessageBarActions>
                  <Button size="small" onClick={timeline.reload}>
                    Try again
                  </Button>
                </MessageBarActions>
              </MessageBar>
            ) : (
              <TimelineScrubber from={from} to={now} events={events} value={at} onChange={setAt} min={earliest} />
            )}
            <div className={s.legend}>
              <span className={s.legendItem}>
                <span className={s.swatch} style={{ backgroundColor: tokens.colorBrandBackground }} />
                <Caption1>Changes after this point: undone ({count(undone.length)})</Caption1>
              </span>
              <span className={s.legendItem}>
                <span className={s.swatch} style={{ backgroundColor: tokens.colorNeutralStroke1 }} />
                <Caption1>Changes before: kept</Caption1>
              </span>
              {earliest && earliest > from ? <Caption1 className={s.muted}>History starts {when(earliest)}</Caption1> : null}
            </div>
            <div className={s.callout}>
              <span className={s.calloutIcon}>
                <Clock24Regular />
              </span>
              <div>
                <Text weight="semibold">
                  Files as they were {onDay(at)} at {time(at)}
                </Text>
                <br />
                <Caption1 className={s.muted}>
                  {contents.loading ? 'Counting files…' : `${plural(totals.files, 'file')} · ${bytes(totals.bytes)}`}
                  {undone.length ? ` · undoes ${plural(undone.length, 'change')} to ${plural(undoneFiles, 'file')} made since` : ' · no changes since then'}
                </Caption1>
              </div>
            </div>
          </>
        ) : fulls.loading ? (
          <Skeleton aria-label="Loading complete backups">
            <SkeletonItem style={{ height: 60, marginBottom: 6 }} />
            <SkeletonItem style={{ height: 60 }} />
          </Skeleton>
        ) : completeFulls.length === 0 ? (
          <EmptyState
            icon={<Archive24Regular />}
            title="No complete backups yet"
            body="Complete backups run on the schedule in Backup settings. You can also run one from the Overview."
          />
        ) : (
          <div className={s.fullList}>
            <OptionCards
              label="Complete backup"
              columns={1}
              value={String(fullId ?? '')}
              onChange={(v) => setFullId(Number(v))}
              options={completeFulls.map((f) => ({
                value: String(f.id),
                title: `${when(f.created_at)}${f.origin === 'scheduled' ? '' : ' · started manually'}`,
                description: `${plural(f.file_count, 'file')} · ${bytes(f.original_size)} compressed to ${bytes(f.compressed_size)}${f.device ? ` · from ${f.device}` : ''}`,
                icon: <Archive24Regular />,
              }))}
            />
          </div>
        )}
      </Panel>

      <Panel>
        <div className={s.sectionHead}>
          <Subtitle2 as="h2">
            <span className={s.stepNo}>2</span>What to restore
          </Subtitle2>
        </div>
        <RadioGroup value={scopeAll ? 'all' : 'some'} onChange={(_, d) => setScopeAll(d.value === 'all')} layout="horizontal">
          <Radio value="all" label={`Everything${contents.data ? ` (${plural(totals.files, 'file')}, ${bytes(totals.bytes)})` : ''}`} />
          <Radio value="some" label="Only the folders I choose" />
        </RadioGroup>
        {!scopeAll ? (
          <div style={{ marginTop: 12 }}>
            {contents.loading && !contents.data ? (
              <Skeleton aria-label="Loading folders">
                <SkeletonItem style={{ height: 160 }} />
              </Skeleton>
            ) : (
              <FolderTree
                roots={folderRoots}
                selected={scope}
                onChange={setScope}
                label="Folders to restore"
                emptyText="No folders were backed up at this moment."
              />
            )}
            <Caption1 className={s.muted} style={{ display: 'block', marginTop: 8 }}>
              {scope.length ? `${plural(scope.length, 'folder')} chosen: ${scope.slice(0, 4).join(', ')}${scope.length > 4 ? '…' : ''}` : 'Tick the folders to bring back.'}
            </Caption1>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <div className={s.sectionHead}>
          <Subtitle2 as="h2">
            <span className={s.stepNo}>3</span>Where to put the files
          </Subtitle2>
        </div>
        <OptionCards
          label="Restore destination"
          value={destKind}
          onChange={setDestKind}
          options={[
            {
              value: 'other',
              title: 'A different folder',
              description: 'Safest: compare or copy files back yourself. Nothing in Tally changes.',
              icon: <FolderArrowLeft24Regular />,
            },
            {
              value: 'original',
              title: 'The original folder',
              description: originalAvailable ? `Puts files back in ${config.watchedFolder}` : 'Available on the computer that backs up the folder',
              icon: <Folder24Regular />,
              disabled: !originalAvailable,
            },
          ]}
        />
        {destKind === 'other' ? (
          <div className={s.dest}>
            <Text className={mergeClasses(s.destPath, 'selectable')} title={otherDest ?? ''} style={{ color: otherDest ? undefined : tokens.colorNeutralForeground3 }}>
              {otherDest ?? 'No folder chosen'}
            </Text>
            <Button
              icon={<FolderOpen20Regular />}
              onClick={async () => {
                const p = await pickFolder('Choose where to restore the files', otherDest);
                if (p) {
                  setOtherDest(p);
                  setPlanError(null);
                }
              }}
            >
              {otherDest ? 'Change…' : 'Browse…'}
            </Button>
          </div>
        ) : intoLive && status.tallyRunning ? (
          <MessageBar intent="warning" style={{ marginTop: 12 }}>
            <MessageBarBody>Tally is open. Close it before restoring into the original folder.</MessageBarBody>
          </MessageBar>
        ) : null}
        {sameFolder(otherDest, config.watchedFolder) && destKind === 'other' ? (
          <Caption1 className={s.muted} style={{ display: 'block', marginTop: 8 }}>
            This is your backup folder, so the restore will change your live files.
          </Caption1>
        ) : null}
      </Panel>

      <div className={s.actionBar}>
        <div className={s.actionInfo}>
          {planError ? (
            <Caption1 style={{ color: tokens.colorStatusDangerForeground1 }} role="alert">
              {planError}
            </Caption1>
          ) : (
            <>
              <Text weight="semibold">
                {mode === 'full'
                  ? fullId !== null
                    ? `Complete backup from ${when(completeFulls.find((f) => f.id === fullId)?.created_at ?? null)}`
                    : 'Choose a complete backup'
                  : `${dayLabel(at)} at ${time(at)}`}
                {' → '}
                {dest ?? 'choose a destination'}
              </Text>
              <Caption1 className={s.muted}>Comparing doesn't change any files.</Caption1>
            </>
          )}
        </div>
        <Button appearance="primary" onClick={compare} disabled={planning || Boolean(status.job && status.job !== 'sync')} icon={planning ? <Spinner size="tiny" /> : undefined}>
          {planning ? 'Comparing…' : 'Compare and review'}
        </Button>
      </div>
      {fulls.error && mode === 'full' ? (
        <Badge color="danger" appearance="tint">
          {fulls.error}
        </Badge>
      ) : null}
    </Page>
  );
}
