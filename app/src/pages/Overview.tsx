import {
  Body1,
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
  MessageBarTitle,
  ProgressBar,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Archive20Regular,
  ArrowCounterclockwise20Regular,
  ArrowSync20Regular,
  DocumentAdd20Regular,
  DocumentDismiss20Regular,
  DocumentEdit20Regular,
  Folder20Regular,
  FolderOpen20Regular,
  MoreHorizontal20Regular,
  Pause20Regular,
  Play20Regular,
  Stop20Regular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { ActivityChart } from '../components/charts';
import { StatusGlyph, phaseInfo, toneBackground } from '../components/status';
import { ConfirmDialog, EmptyState, Page, Panel, useLoader } from '../components/ui';
import { api, backend, errorMessage } from '../lib/backend';
import { ago, bytes, count, percent, plural, splitPath, until, when } from '../lib/format';
import type { Stats } from '../lib/types';
import { useApp } from '../state';

const useStyles = makeStyles({
  hero: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    gap: '20px',
    padding: '24px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  glyph: { width: '56px', height: '56px', borderRadius: '50%', display: 'grid', placeItems: 'center' },
  heroText: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  heroFacts: { color: tokens.colorNeutralForeground2 },
  heroActions: { display: 'flex', gap: '8px', alignItems: 'center' },
  progress: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' },
  progressLine: { display: 'flex', justifyContent: 'space-between', gap: '12px', color: tokens.colorNeutralForeground2 },
  current: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  sectionHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '16px' },
  muted: { color: tokens.colorNeutralForeground3 },
  two: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: '16px' },
  facts: { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: '20px', rowGap: '10px', alignItems: 'baseline' },
  factLabel: { color: tokens.colorNeutralForeground3 },
  path: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    marginBottom: '16px',
    minWidth: 0,
  },
  pathText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column' },
  item: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '12px',
    padding: '9px 4px',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    ':first-child': { borderTop: 'none' },
  },
  opIcon: { display: 'flex' },
  name: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headActions: { display: 'flex', gap: '4px' },
});

const OP = {
  add: { label: 'Added', icon: <DocumentAdd20Regular />, color: tokens.colorPaletteGreenForeground1 },
  modify: { label: 'Changed', icon: <DocumentEdit20Regular />, color: tokens.colorBrandForeground1 },
  delete: { label: 'Removed', icon: <DocumentDismiss20Regular />, color: tokens.colorPaletteRedForeground1 },
} as const;

export default function Overview() {
  const s = useStyles();
  const app = useApp();
  const { status, config, isAdmin, canWrite, go, notify } = app;
  const info = phaseInfo(status);
  const stats = useLoader(() => api<Stats>('GET', '/api/stats'), [status.lastSyncAt, status.lastFullAt]);
  const [confirm, setConfirm] = useState<null | { kind: 'sync' | 'full'; tally: string }>(null);
  const [starting, setStarting] = useState<'sync' | 'full' | null>(null);

  const events = useMemo(() => (stats.data?.recentChanges ?? []).map((c) => ({ at: c.at })), [stats.data]);
  const changedFiles = useMemo(() => new Set((stats.data?.recentChanges ?? []).map((c) => c.path)).size, [stats.data]);

  const run = async (kind: 'sync' | 'full', force = false) => {
    setStarting(kind);
    try {
      if (kind === 'sync') {
        const r = await backend.syncNow(force);
        const changed = r.added + r.modified + r.deleted;
        notify('success', changed ? `Backed up ${plural(changed, 'change')}` : 'Everything is already backed up', r.busy.length ? `${plural(r.busy.length, 'file')} in use will be retried.` : undefined);
      } else {
        const r = await backend.fullBackupNow(force);
        notify('success', 'Complete backup finished', `${plural(r.fileCount, 'file')}, ${bytes(r.originalSize)} compressed to ${bytes(r.compressedSize)}.`);
      }
      setConfirm(null);
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.startsWith('TALLY_RUNNING:')) setConfirm({ kind, tally: msg.slice('TALLY_RUNNING:'.length) });
      else {
        setConfirm(null);
        notify('error', kind === 'sync' ? 'Backup failed' : 'Complete backup failed', msg);
      }
    } finally {
      setStarting(null);
    }
  };

  const busy = Boolean(status.job) || starting !== null;
  const p = status.progress;
  const pct = p && p.totalBytes > 0 ? Math.min(1, p.doneBytes / p.totalBytes) : undefined;

  const headline = (() => {
    switch (status.phase) {
      case 'idle':
        return 'Your files are protected';
      case 'notConfigured':
        return 'Choose the folder to back up';
      case 'readOnly':
        return 'Your shared folders are ready to restore';
      case 'paused':
        return 'Automatic backups are paused';
      case 'waitingTally':
        return 'Waiting for Tally to close';
      case 'waitingQuiet':
        return 'New changes will be backed up shortly';
      case 'offline':
        return "Can't reach the backup server";
      case 'error':
        return 'Backups need your attention';
      default:
        return info.title;
    }
  })();

  const facts = (() => {
    if (status.phase === 'notConfigured') return 'Pick your Tally data folder and AM Backup will start protecting it right away.';
    if (status.phase === 'readOnly') return stats.data ? `${plural(stats.data.files, 'file')} in your folders · ${bytes(stats.data.bytes)}` : 'Loading your folders…';
    if (status.phase === 'error' || status.phase === 'offline') return status.message;
    const parts = [status.lastSyncAt ? `Last backup ${ago(status.lastSyncAt)}` : 'No backup yet'];
    if (stats.data) parts.push(`${plural(stats.data.files, 'file')}`, bytes(stats.data.bytes));
    return parts.join(' · ');
  })();

  const recent = (stats.data?.recentChanges ?? []).slice(0, 8);

  return (
    <Page>
      <section className={s.hero} aria-live="polite">
        <div className={s.glyph} style={{ backgroundColor: toneBackground[info.tone] }}>
          <StatusGlyph status={status} size={28} />
        </div>
        <div className={s.heroText}>
          <Title3 as="h1">{headline}</Title3>
          <Body1 className={s.heroFacts}>{facts}</Body1>
        </div>
        <div className={s.heroActions}>
          {status.phase === 'notConfigured' ? (
            <Button appearance="primary" icon={<Folder20Regular />} onClick={() => go('backup')}>
              Choose folder
            </Button>
          ) : status.phase === 'readOnly' || !canWrite ? (
            <Button appearance="primary" icon={<ArrowCounterclockwise20Regular />} onClick={() => go('restore')}>
              Restore files
            </Button>
          ) : status.job ? (
            <Button icon={<Stop20Regular />} onClick={() => void backend.cancelJob()}>
              Stop
            </Button>
          ) : (
            <>
              <Button appearance="primary" icon={<ArrowSync20Regular />} disabled={busy} onClick={() => run('sync')}>
                {starting === 'sync' ? 'Starting…' : 'Back up now'}
              </Button>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button icon={<MoreHorizontal20Regular />} aria-label="More backup actions" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {isAdmin ? (
                      <MenuItem icon={<Archive20Regular />} disabled={busy} onClick={() => run('full')}>
                        Run a complete backup now
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      icon={status.paused ? <Play20Regular /> : <Pause20Regular />}
                      onClick={async () => app.setStatus(await backend.setPaused(!status.paused))}
                    >
                      {status.paused ? 'Resume automatic backups' : 'Pause automatic backups'}
                    </MenuItem>
                    {config.watchedFolder ? (
                      <MenuItem icon={<FolderOpen20Regular />} onClick={() => void backend.openPath(config.watchedFolder!)}>
                        Open backup folder
                      </MenuItem>
                    ) : null}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </>
          )}
        </div>
        {status.job && p ? (
          <div className={s.progress}>
            <ProgressBar value={pct} thickness="large" aria-label={p.stage} />
            <div className={s.progressLine}>
              <Caption1 className={s.current}>
                {p.stage}
                {p.current ? ` · ${p.current}` : ''}
              </Caption1>
              <Caption1 className="tabular">
                {p.totalBytes > 0 ? `${bytes(p.doneBytes)} of ${bytes(p.totalBytes)}` : p.totalFiles > 0 ? `${count(p.doneFiles)} of ${count(p.totalFiles)} files` : ''}
              </Caption1>
            </div>
          </div>
        ) : null}
      </section>

      {status.tallyRunning && canWrite && config.policy.sync.tallyMode === 'close' && !status.job ? (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Tally is open</MessageBarTitle>
            Backups wait until Tally closes so company files are never copied half-written.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => run('sync', true)} disabled={busy}>
              Back up anyway
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      {status.busyFiles.length > 0 && !status.job ? (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{plural(status.busyFiles.length, 'file')} could not be read</MessageBarTitle>
            Another program was using {status.busyFiles.length === 1 ? 'it' : 'them'}. AM Backup will try again automatically: {status.busyFiles.slice(0, 3).join(', ')}
            {status.busyFiles.length > 3 ? '…' : ''}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <Panel>
        <div className={s.sectionHead}>
          <Subtitle2 as="h2">Changes in the last 24 hours</Subtitle2>
          <Caption1 className={s.muted}>
            {stats.data ? `${plural(events.length, 'change')} to ${plural(changedFiles, 'file')} · click a bar to restore to that time` : ' '}
          </Caption1>
        </div>
        {stats.loading && !stats.data ? (
          <Skeleton aria-label="Loading activity">
            <SkeletonItem style={{ height: 112 }} />
          </Skeleton>
        ) : (
          <ActivityChart events={events} label="Changes in the last 24 hours" onPick={(at) => go('restore', { kind: 'pointInTime', at })} />
        )}
      </Panel>

      <div className={s.two}>
        <Panel>
          <div className={s.sectionHead}>
            <Subtitle2 as="h2">{canWrite ? 'Backup folder' : 'Your folders'}</Subtitle2>
            {canWrite ? (
              <Button size="small" appearance="subtle" onClick={() => go('backup')}>
                Change
              </Button>
            ) : null}
          </div>
          {canWrite ? (
            config.watchedFolder ? (
              <>
                <div className={s.path}>
                  <Folder20Regular />
                  <Text className={`${s.pathText} selectable`} title={config.watchedFolder}>
                    {config.watchedFolder}
                  </Text>
                  <Button size="small" appearance="transparent" icon={<FolderOpen20Regular />} aria-label="Open backup folder" onClick={() => void backend.openPath(config.watchedFolder!)} />
                </div>
                <div className={s.facts}>
                  <Caption1 className={s.factLabel}>Backed up</Caption1>
                  <Text className="tabular">{stats.data ? `${plural(stats.data.files, 'file')} · ${bytes(stats.data.bytes)}` : '—'}</Text>
                  <Caption1 className={s.factLabel}>Backs up</Caption1>
                  <Text>
                    {config.policy.sync.mode === 'auto'
                      ? 'Automatically, as files change'
                      : config.policy.sync.mode === 'interval'
                        ? `Every ${config.policy.sync.intervalMinutes >= 60 ? plural(config.policy.sync.intervalMinutes / 60, 'hour') : `${config.policy.sync.intervalMinutes} minutes`}`
                        : 'Only when you click Back up now'}
                  </Text>
                  <Caption1 className={s.factLabel}>Tally</Caption1>
                  <Text>
                    {status.tallyRunning ? `Open (${status.tallyRunning})` : 'Not running'}
                    {status.tallyRunning ? (config.policy.sync.tallyMode === 'close' ? ' · backups wait for it to close' : ' · backups run when its files are quiet') : ''}
                  </Text>
                </div>
              </>
            ) : (
              <EmptyState
                icon={<Folder20Regular />}
                title="No folder chosen yet"
                body="Choose the Tally data folder to start backing it up."
                action={
                  <Button appearance="primary" onClick={() => go('backup')}>
                    Choose folder
                  </Button>
                }
              />
            )
          ) : (
            <div className={s.facts}>
              <Caption1 className={s.factLabel}>Access</Caption1>
              <Text>{config.user?.scopeMode === 'all' ? 'Every folder' : config.user?.scopeMode === 'none' ? 'No folders yet' : plural(config.user?.paths.length ?? 0, 'folder')}</Text>
              {config.user?.scopeMode === 'include'
                ? config.user.paths.slice(0, 5).map((p) => (
                    <span key={p} style={{ display: 'contents' }}>
                      <Folder20Regular className={s.factLabel} />
                      <Text className="selectable">{p}</Text>
                    </span>
                  ))
                : null}
            </div>
          )}
        </Panel>

        {isAdmin ? (
          <Panel>
            <div className={s.sectionHead}>
              <Subtitle2 as="h2">Complete backups</Subtitle2>
              <Button size="small" appearance="subtle" onClick={() => go('history')}>
                View history
              </Button>
            </div>
            <div className={s.facts}>
              <Caption1 className={s.factLabel}>Last</Caption1>
              <Text>{stats.data?.lastFull ? when(stats.data.lastFull.created_at) : 'None yet'}</Text>
              {stats.data?.lastFull ? (
                <>
                  <Caption1 className={s.factLabel}>Size</Caption1>
                  <Text className="tabular">
                    {bytes(stats.data.lastFull.original_size)} → {bytes(stats.data.lastFull.compressed_size)}
                    <span className={s.muted}> · {percent(stats.data.lastFull.compressed_size, stats.data.lastFull.original_size)} of original</span>
                  </Text>
                </>
              ) : null}
              <Caption1 className={s.factLabel}>Next</Caption1>
              <Text>{config.policy.full.schedule === 'off' ? 'Turned off' : until(status.nextFullAt)}</Text>
              <Caption1 className={s.factLabel}>Kept</Caption1>
              <Text>
                {stats.data?.fullBackups != null ? `${count(stats.data.fullBackups)} of up to ${config.policy.full.keep}` : '—'}
                {stats.data?.storedBytes != null ? <span className={s.muted}> · {bytes(stats.data.storedBytes)} stored in total</span> : null}
              </Text>
            </div>
          </Panel>
        ) : (
          <Panel>
            <div className={s.sectionHead}>
              <Subtitle2 as="h2">Restore</Subtitle2>
            </div>
            <Body1 className={s.muted}>Bring back files from any moment in the last {config.policy.retention.versionDays || 'many'} days, into a folder you choose.</Body1>
            <div style={{ marginTop: 16 }}>
              <Button icon={<ArrowCounterclockwise20Regular />} onClick={() => go('restore')}>
                Restore files
              </Button>
            </div>
          </Panel>
        )}
      </div>

      <Panel>
        <div className={s.sectionHead}>
          <Subtitle2 as="h2">Latest changes</Subtitle2>
          <div className={s.headActions}>
            <Button size="small" appearance="subtle" onClick={() => go('history')}>
              See all
            </Button>
          </div>
        </div>
        {stats.error ? (
          <MessageBar intent="error">
            <MessageBarBody>{stats.error}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={stats.reload}>
                Try again
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : recent.length ? (
          <div className={s.list} role="list">
            {recent.map((c, i) => {
              const { folder, name } = splitPath(c.path);
              const op = OP[c.op];
              return (
                <div key={`${c.path}-${c.at}-${i}`} className={s.item} role="listitem">
                  <span className={s.opIcon} style={{ color: op.color }} aria-hidden>
                    {op.icon}
                  </span>
                  <span className={s.name}>
                    <Text className={mergeClasses(s.ellipsis, 'selectable')}>{name}</Text>
                    <Caption1 className={mergeClasses(s.ellipsis, s.muted)}>
                      {op.label} · {folder || 'Top folder'}
                    </Caption1>
                  </span>
                  <Caption1 className={s.muted}>{ago(c.at)}</Caption1>
                </div>
              );
            })}
          </div>
        ) : stats.loading ? (
          <Skeleton aria-label="Loading changes">
            <SkeletonItem style={{ height: 36, marginBottom: 6 }} />
            <SkeletonItem style={{ height: 36, marginBottom: 6 }} />
            <SkeletonItem style={{ height: 36 }} />
          </Skeleton>
        ) : (
          <EmptyState title="No changes in the last 24 hours" body="When files in the backup folder change, they appear here within a minute or two." />
        )}
      </Panel>

      <ConfirmDialog
        open={confirm !== null}
        title="Tally is open"
        confirmLabel={confirm?.kind === 'full' ? 'Run complete backup anyway' : 'Back up anyway'}
        busy={starting !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm.kind, true)}
      >
        Tally ({confirm?.tally}) is running and may be writing to company files. A copy taken now could be incomplete. For the safest backup, close Tally first.
      </ConfirmDialog>
    </Page>
  );
}
