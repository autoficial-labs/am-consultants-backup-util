import {
  Badge,
  Button,
  Caption1,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Tab,
  TabList,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Archive20Regular,
  ArrowCounterclockwise20Regular,
  ArrowSync20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Delete20Regular,
  DocumentAdd16Regular,
  DocumentDismiss16Regular,
  DocumentEdit16Regular,
  ErrorCircle20Regular,
  MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { ConfirmDialog, EmptyState, Page, PageHeader, Panel, useLoader } from '../components/ui';
import { api, errorMessage } from '../lib/backend';
import { bytes, count, dayLabel, percent, plural, time } from '../lib/format';
import type { Batch, FullBackup, Manifest, TimelineEvent } from '../lib/types';
import { useApp } from '../state';

const useStyles = makeStyles({
  day: { display: 'flex', flexDirection: 'column', gap: '8px' },
  dayLabel: { color: tokens.colorNeutralForeground2, padding: '0 4px' },
  entry: { padding: 0, overflow: 'hidden' },
  head: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '14px', alignItems: 'center', padding: '14px 16px' },
  icon: { width: '36px', height: '36px', borderRadius: tokens.borderRadiusLarge, display: 'grid', placeItems: 'center' },
  iconFull: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1 },
  iconSync: { backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2 },
  iconFail: { backgroundColor: tokens.colorStatusDangerBackground1, color: tokens.colorStatusDangerForeground1 },
  title: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  ops: { display: 'inline-flex', gap: '12px', marginLeft: '2px' },
  op: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: tokens.colorNeutralForeground2 },
  actions: { display: 'flex', gap: '4px', alignItems: 'center' },
  ratio: { height: '6px', borderRadius: '3px', backgroundColor: tokens.colorNeutralStroke2, overflow: 'hidden', width: '140px', marginTop: '6px' },
  ratioFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: '3px' },
  body: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, padding: '10px 16px 14px 66px', backgroundColor: tokens.colorNeutralBackground2 },
  fileList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflowY: 'auto' },
  fileLine: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: '8px', alignItems: 'center' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '4px' },
});

type Entry = { kind: 'full'; at: number; full: FullBackup } | { kind: 'sync'; at: number; batch: Batch };

const OP_ICON = {
  add: <DocumentAdd16Regular />,
  modify: <DocumentEdit16Regular />,
  delete: <DocumentDismiss16Regular />,
};

function ExpandFiles({ entry }: { entry: Entry }) {
  const s = useStyles();
  const data = useLoader(async () => {
    if (entry.kind === 'sync') {
      const r = await api<{ changes: TimelineEvent[] }>('GET', `/api/batches/${entry.batch.id}/changes`);
      return r.changes.map((c) => ({ path: c.path, op: c.op, size: c.size }));
    }
    const m = await api<Manifest>('GET', `/api/full-backups/${entry.full.id}/manifest`);
    return m.files.map((f) => ({ path: f.path, op: 'add' as const, size: f.size }));
  }, [entry]);
  if (data.loading) {
    return (
      <Skeleton aria-label="Loading files">
        <SkeletonItem style={{ height: 60 }} />
      </Skeleton>
    );
  }
  if (data.error) return <Caption1 style={{ color: tokens.colorStatusDangerForeground1 }}>{data.error}</Caption1>;
  const files = data.data ?? [];
  if (!files.length) return <Caption1 className={s.meta}>No files you can see were part of this backup.</Caption1>;
  return (
    <div className={s.fileList} role="list">
      {files.slice(0, 500).map((f) => (
        <div key={f.path} className={s.fileLine} role="listitem">
          <span style={{ display: 'flex', color: tokens.colorNeutralForeground3 }} aria-label={f.op === 'add' ? 'added' : f.op === 'modify' ? 'changed' : 'removed'}>
            {OP_ICON[f.op]}
          </span>
          <Caption1 className={mergeClasses(s.ellipsis, 'selectable')} title={f.path}>
            {f.path}
          </Caption1>
          <Caption1 className={`${s.meta} tabular`}>{f.op === 'delete' ? 'removed' : bytes(f.size)}</Caption1>
        </div>
      ))}
      {files.length > 500 ? <Caption1 className={s.meta}>…and {count(files.length - 500)} more</Caption1> : null}
    </div>
  );
}

export default function History() {
  const s = useStyles();
  const { isAdmin, go, notify } = useApp();
  const [filter, setFilter] = useState<'all' | 'full' | 'sync'>('all');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [moreBatches, setMoreBatches] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<FullBackup | null>(null);
  const [busy, setBusy] = useState(false);

  const first = useLoader(async () => {
    const [b, f] = await Promise.all([
      api<{ batches: Batch[] }>('GET', '/api/batches?limit=50'),
      isAdmin ? api<{ backups: FullBackup[] }>('GET', '/api/full-backups') : Promise.resolve({ backups: [] as FullBackup[] }),
    ]);
    setBatches(b.batches);
    setMoreBatches(b.batches.length === 50);
    return f.backups;
  }, [isAdmin]);

  const loadMore = async () => {
    const last = batches[batches.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const b = await api<{ batches: Batch[] }>('GET', `/api/batches?limit=50&before=${last.id}`);
      setBatches((prev) => [...prev, ...b.batches]);
      setMoreBatches(b.batches.length === 50);
    } catch (e) {
      notify('error', 'Could not load older history', errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    if (filter !== 'sync') for (const f of first.data ?? []) list.push({ kind: 'full', at: f.created_at, full: f });
    if (filter !== 'full') for (const b of batches) if (b.status !== 'running') list.push({ kind: 'sync', at: b.finished_at ?? b.started_at, batch: b });
    return list.sort((a, b) => b.at - a.at);
  }, [first.data, batches, filter]);

  const days = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const key = dayLabel(e.at);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries]);

  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api('DELETE', `/api/full-backups/${deleting.id}`);
      notify('success', 'Complete backup deleted');
      setDeleting(null);
      void first.reload();
    } catch (e) {
      notify('error', 'Could not delete the backup', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Backup history"
        description="Every backup run, newest first. Restore any of them into a folder you choose."
        actions={
          isAdmin ? (
            <TabList selectedValue={filter} onTabSelect={(_, d) => setFilter(d.value as typeof filter)} size="small">
              <Tab value="all">All</Tab>
              <Tab value="full">Complete backups</Tab>
              <Tab value="sync">File changes</Tab>
            </TabList>
          ) : undefined
        }
      />

      {first.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{first.error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={first.reload}>
              Try again
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : first.loading && !first.data ? (
        <Skeleton aria-label="Loading history">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonItem key={i} style={{ height: 68, marginBottom: 8 }} />
          ))}
        </Skeleton>
      ) : entries.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ArrowSync20Regular />}
            title={filter === 'full' ? 'No complete backups yet' : 'No backups yet'}
            body={filter === 'full' ? 'Complete backups run on the schedule set in Backup settings.' : 'Backups appear here as soon as the first files are uploaded.'}
          />
        </Panel>
      ) : (
        days.map(([day, list]) => (
          <section key={day} className={s.day} aria-label={day}>
            <Subtitle2 as="h2" className={s.dayLabel}>
              {day}
            </Subtitle2>
            {list.map((e) => {
              const key = e.kind === 'full' ? `f${e.full.id}` : `b${e.batch.id}`;
              const isOpen = open.has(key);
              if (e.kind === 'full') {
                const f = e.full;
                const failed = f.status === 'failed';
                const uploading = f.status === 'uploading';
                return (
                  <Panel key={key} className={s.entry} pad={false}>
                    <div className={s.head}>
                      <span className={mergeClasses(s.icon, failed ? s.iconFail : s.iconFull)} aria-hidden>
                        {failed ? <ErrorCircle20Regular /> : <Archive20Regular />}
                      </span>
                      <div>
                        <div className={s.title}>
                          <Text weight="semibold">Complete backup</Text>
                          <Badge appearance="tint" color={failed ? 'danger' : uploading ? 'informative' : f.origin === 'scheduled' ? 'brand' : 'subtle'} size="small">
                            {failed ? 'Failed' : uploading ? 'In progress' : f.origin === 'scheduled' ? 'Scheduled' : 'Manual'}
                          </Badge>
                        </div>
                        <Caption1 className={s.meta}>
                          {time(f.created_at)} · {plural(f.file_count, 'file')}
                          {failed ? ` · ${f.note ?? 'Did not finish'}` : ` · ${bytes(f.original_size)} → ${bytes(f.compressed_size)} (${percent(f.compressed_size, f.original_size)})`}
                          {f.device ? ` · ${f.device}` : ''}
                        </Caption1>
                        {!failed && !uploading ? (
                          <div className={s.ratio} title={`Compressed to ${percent(f.compressed_size, f.original_size)} of the original size`}>
                            <div className={s.ratioFill} style={{ width: `${Math.min(100, (f.compressed_size / Math.max(1, f.original_size)) * 100)}%` }} />
                          </div>
                        ) : null}
                      </div>
                      <div className={s.actions}>
                        {!failed && !uploading ? (
                          <>
                            <Button size="small" icon={isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />} appearance="subtle" onClick={() => toggle(key)} aria-expanded={isOpen}>
                              Files
                            </Button>
                            <Button size="small" icon={<ArrowCounterclockwise20Regular />} onClick={() => go('restore', { kind: 'full', id: f.id })}>
                              Restore…
                            </Button>
                          </>
                        ) : null}
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="More actions" />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem icon={<Delete20Regular />} onClick={() => setDeleting(f)}>
                                Delete this backup
                              </MenuItem>
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      </div>
                    </div>
                    {isOpen ? (
                      <div className={s.body}>
                        <ExpandFiles entry={e} />
                      </div>
                    ) : null}
                  </Panel>
                );
              }
              const b = e.batch;
              const failed = b.status === 'failed';
              return (
                <Panel key={key} className={s.entry} pad={false}>
                  <div className={s.head}>
                    <span className={mergeClasses(s.icon, failed ? s.iconFail : s.iconSync)} aria-hidden>
                      {failed ? <ErrorCircle20Regular /> : <ArrowSync20Regular />}
                    </span>
                    <div>
                      <div className={s.title}>
                        <Text weight="semibold">{failed ? 'Backup interrupted' : 'Backed up changes'}</Text>
                        <span className={s.ops}>
                          {b.added ? (
                            <Caption1 className={s.op}>
                              <DocumentAdd16Regular /> {count(b.added)} new
                            </Caption1>
                          ) : null}
                          {b.modified ? (
                            <Caption1 className={s.op}>
                              <DocumentEdit16Regular /> {count(b.modified)} changed
                            </Caption1>
                          ) : null}
                          {b.deleted ? (
                            <Caption1 className={s.op}>
                              <DocumentDismiss16Regular /> {count(b.deleted)} removed
                            </Caption1>
                          ) : null}
                        </span>
                      </div>
                      <Caption1 className={s.meta}>
                        {time(e.at)}
                        {b.display_name ? ` · ${b.display_name}` : ''}
                        {b.device ? ` on ${b.device}` : ''}
                        {b.bytes_uploaded ? ` · ${bytes(b.bytes_uploaded)} uploaded` : ''}
                        {failed && b.message ? ` · ${b.message}` : ''}
                      </Caption1>
                    </div>
                    <div className={s.actions}>
                      <Button size="small" icon={isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />} appearance="subtle" onClick={() => toggle(key)} aria-expanded={isOpen}>
                        Files
                      </Button>
                      <Button size="small" icon={<ArrowCounterclockwise20Regular />} onClick={() => go('restore', { kind: 'pointInTime', at: e.at })}>
                        Restore to this moment
                      </Button>
                    </div>
                  </div>
                  {isOpen ? (
                    <div className={s.body}>
                      <ExpandFiles entry={e} />
                    </div>
                  ) : null}
                </Panel>
              );
            })}
          </section>
        ))
      )}

      {filter !== 'full' && moreBatches && entries.length > 0 ? (
        <div className={s.more}>
          <Button onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show older backups'}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this complete backup?"
        confirmLabel="Delete backup"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={remove}
      >
        The archive from {deleting ? `${dayLabel(deleting.created_at)} at ${time(deleting.created_at)}` : ''} ({bytes(deleting?.compressed_size ?? 0)}) will be permanently removed from the
        server. Your file-by-file history is not affected.
      </ConfirmDialog>
    </Page>
  );
}
