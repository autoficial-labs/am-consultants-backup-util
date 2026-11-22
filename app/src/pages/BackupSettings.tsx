import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Slider,
  SpinButton,
  Switch,
  Spinner,
  Text,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  Archive20Regular,
  ArrowSyncCircle24Regular,
  CalendarClock20Regular,
  Checkmark16Regular,
  Clock20Regular,
  CursorClick24Regular,
  DocumentDismiss20Regular,
  Folder20Regular,
  FolderOpen20Regular,
  History20Regular,
  HourglassHalf20Regular,
  BookOpen20Regular,
  PlugConnected20Regular,
  Timer20Regular,
  DocumentCheckmark24Regular,
  LockClosed24Regular,
  Timer24Regular,
  ArrowMinimize24Regular,
  DataBarVertical24Regular,
  ArrowMaximize24Regular,
  WindowApps20Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog, Group, OptionCards, Page, PageHeader, Row, useLoader } from '../components/ui';
import { api, backend, errorMessage, pickFolder } from '../lib/backend';
import { bytes, clockLabel, plural, secondsLabel, until, WEEKDAYS } from '../lib/format';
import type { FolderSummary, Policy } from '../lib/types';
import { useApp } from '../state';

const QUIET_STEPS = [15, 30, 60, 120, 300, 600, 900];
const GRACE_STEPS = [0, 15, 30, 60, 120, 300];
const TALLY_QUIET_STEPS = [60, 120, 180, 300, 600, 900];
const TALLY_EVERY = [15, 30, 60, 120, 240, 480];
const everyLabel = (m: number) => (m >= 60 ? plural(m / 60, 'hour') : `${m} minutes`);
const INTERVALS = [15, 30, 60, 120, 240, 480, 720, 1440];
const EVERY_HOURS = [2, 3, 4, 6, 8, 12, 24];
const RETENTION = [7, 14, 30, 60, 90, 180, 365, 0];
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const TALLY_KNOWN = [
  { name: 'tally.exe', label: 'TallyPrime / Tally.ERP 9' },
  { name: 'tallyprime.exe', label: 'TallyPrime (alternate)' },
  { name: 'tallyprimeserver.exe', label: 'TallyPrime Server' },
];
const EXCLUDE_KNOWN = [
  { pattern: '*.tmp', label: 'Temporary files' },
  { pattern: '~$*', label: 'Office lock files' },
  { pattern: 'Thumbs.db', label: 'Windows thumbnails' },
  { pattern: 'desktop.ini', label: 'Folder settings' },
  { pattern: '.DS_Store', label: 'Mac folder files' },
  { pattern: '*.bak', label: 'Backup copies (.bak)' },
  { pattern: '*.log', label: 'Log files' },
];

const useStyles = makeStyles({
  chips: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  addRow: { display: 'flex', gap: '8px', marginTop: '12px', maxWidth: '420px' },
  muted: { color: tokens.colorNeutralForeground3 },
  sliderWrap: { display: 'flex', alignItems: 'center', gap: '12px', minWidth: '320px' },
  sliderValue: { minWidth: '92px', textAlign: 'right' },
  days: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
  saveBar: {
    position: 'sticky',
    bottom: '-48px',
    marginBottom: '-20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px 20px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    zIndex: 5,
  },
  saveActions: { display: 'flex', gap: '8px' },
  folderPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '520px', display: 'block' },
  compression: { width: '100%' },
});

function StepSlider({ steps, value, onChange, format, label, disabled }: { steps: number[]; value: number; onChange: (v: number) => void; format: (v: number) => string; label: string; disabled?: boolean }) {
  const s = useStyles();
  const idx = Math.max(0, steps.findIndex((v) => v >= value));
  return (
    <div className={s.sliderWrap}>
      <Slider
        min={0}
        max={steps.length - 1}
        step={1}
        value={idx}
        onChange={(_, d) => onChange(steps[d.value]!)}
        aria-label={label}
        aria-valuetext={format(steps[idx]!)}
        style={{ flex: 1 }}
        disabled={disabled}
      />
      <Text className={`${s.sliderValue} tabular`}>{format(steps[idx]!)}</Text>
    </div>
  );
}

function ChipToggles({ items, value, onChange, disabled }: { items: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const s = useStyles();
  const lower = value.map((v) => v.toLowerCase());
  return (
    <div className={s.chips}>
      {items.map((it) => {
        const on = lower.includes(it.key.toLowerCase());
        return (
          <ToggleButton
            key={it.key}
            size="small"
            shape="circular"
            checked={on}
            disabled={disabled}
            icon={on ? <Checkmark16Regular /> : undefined}
            onClick={() => onChange(on ? value.filter((v) => v.toLowerCase() !== it.key.toLowerCase()) : [...value, it.key])}
          >
            {it.label}
          </ToggleButton>
        );
      })}
    </div>
  );
}

function AddCustom({ placeholder, onAdd, disabled, validate }: { placeholder: string; onAdd: (v: string) => void; disabled?: boolean; validate?: (v: string) => string | null }) {
  const s = useStyles();
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const t = v.trim();
    if (!t) return;
    const e = validate?.(t) ?? null;
    if (e) return setErr(e);
    onAdd(t);
    setV('');
    setErr(null);
  };
  return (
    <div>
      <div className={s.addRow}>
        <Input
          size="small"
          value={v}
          onChange={(_, d) => (setV(d.value), setErr(null))}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          style={{ flex: 1 }}
          aria-label={placeholder}
        />
        <Button size="small" icon={<Add20Regular />} onClick={add} disabled={disabled || !v.trim()}>
          Add
        </Button>
      </div>
      {err ? <Caption1 style={{ color: tokens.colorStatusDangerForeground1 }}>{err}</Caption1> : null}
    </div>
  );
}

export default function BackupSettings() {
  const s = useStyles();
  const app = useApp();
  const { config, status, isAdmin, notify } = app;
  const remote = useLoader(() => api<{ policy: Policy }>('GET', '/api/settings').then((r) => r.policy), []);
  const [policy, setPolicy] = useState<Policy>(config.policy);
  const [saved, setSaved] = useState<Policy>(config.policy);
  const [saving, setSaving] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<{ path: string; summary: FolderSummary } | null>(null);

  useEffect(() => {
    if (remote.data) {
      setPolicy(remote.data);
      setSaved(remote.data);
    }
  }, [remote.data]);

  const summary = useLoader(
    () => (config.watchedFolder ? backend.scanFolder(config.watchedFolder, policy.exclude) : Promise.resolve(null)),
    [config.watchedFolder, saved.exclude.join('|')],
  );

  const dirty = useMemo(() => JSON.stringify(policy) !== JSON.stringify(saved), [policy, saved]);
  const readOnly = !isAdmin;
  const set = <K extends keyof Policy>(k: K, v: Partial<Policy[K]>) => setPolicy((p) => ({ ...p, [k]: Array.isArray(v) ? v : { ...(p[k] as object), ...v } }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<{ policy: Policy }>('PUT', '/api/settings', { policy });
      setPolicy(res.policy);
      setSaved(res.policy);
      await backend.policyChanged(res.policy);
      await app.refreshConfig();
      notify('success', 'Backup settings saved');
    } catch (e) {
      notify('error', 'Could not save settings', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const chooseFolder = async () => {
    const path = await pickFolder('Choose the folder to back up', config.watchedFolder);
    if (!path) return;
    setFolderBusy(true);
    try {
      const sum = await backend.scanFolder(path, policy.exclude);
      setPendingFolder({ path, summary: sum });
    } catch (e) {
      notify('error', 'Cannot use that folder', errorMessage(e));
    } finally {
      setFolderBusy(false);
    }
  };

  const confirmFolder = async () => {
    if (!pendingFolder) return;
    setFolderBusy(true);
    try {
      app.setConfig(await backend.setWatchedFolder(pendingFolder.path));
      notify('success', 'Backup folder set', 'The first backup starts in a moment.');
      setPendingFolder(null);
    } catch (e) {
      notify('error', 'Cannot use that folder', errorMessage(e));
    } finally {
      setFolderBusy(false);
    }
  };

  const fullDesc = (() => {
    const f = policy.full;
    if (f.schedule === 'off') return 'Turned off';
    if (f.schedule === 'hours') return `Every ${f.everyHours} hours`;
    if (f.schedule === 'weekly') return `Every ${WEEKDAYS[f.weekday]} at ${clockLabel(f.time)}`;
    return `Every day at ${clockLabel(f.time)}`;
  })();

  const tallyItems = [...TALLY_KNOWN.map((t) => ({ key: t.name, label: `${t.name} · ${t.label}` }))];
  for (const p of policy.sync.tallyProcesses) if (!tallyItems.some((t) => t.key === p)) tallyItems.push({ key: p, label: p });
  const excludeItems = EXCLUDE_KNOWN.map((e) => ({ key: e.pattern, label: `${e.label} (${e.pattern})` }));
  for (const p of policy.exclude) if (!excludeItems.some((e) => e.key.toLowerCase() === p.toLowerCase())) excludeItems.push({ key: p, label: p });

  return (
    <Page>
      <PageHeader
        title="Backup settings"
        description={isAdmin ? 'These rules apply to every computer that backs up with AM Backup.' : 'Your administrator sets these rules. You can choose the folder this computer backs up.'}
      />

      <Group title="Backup folder" description={isAdmin ? 'Usually the Tally data folder, which holds one subfolder per company.' : 'The folder on this computer that you back up.'}>
        <Row
          icon={<Folder20Regular />}
          label={
            config.watchedFolder ? (
              <span className={`${s.folderPath} selectable`} title={config.watchedFolder}>
                {config.watchedFolder}
              </span>
            ) : (
              'No folder chosen'
            )
          }
          description={
            config.watchedFolder
              ? summary.loading
                ? 'Counting files…'
                : summary.data
                  ? `${plural(summary.data.totalFiles, 'file')} · ${bytes(summary.data.totalBytes)} · ${status.phase === 'paused' ? 'paused' : 'watched for changes'}`
                  : summary.error ?? ''
              : 'Choose a folder to start protecting it.'
          }
          control={
            <>
              {config.watchedFolder ? (
                <Button appearance="subtle" icon={<FolderOpen20Regular />} onClick={() => void backend.openPath(config.watchedFolder!)}>
                  Open
                </Button>
              ) : null}
              <Button appearance={config.watchedFolder ? 'secondary' : 'primary'} onClick={chooseFolder} disabled={folderBusy} icon={folderBusy ? <Spinner size="tiny" /> : undefined}>
                {config.watchedFolder ? 'Change folder…' : 'Choose folder…'}
              </Button>
            </>
          }
        />
      </Group>

      {readOnly ? (
        <MessageBar intent="info">
          <MessageBarBody>The schedule below is managed by your administrator.</MessageBarBody>
        </MessageBar>
      ) : null}

      <Group title="When to back up">
        <OptionCards
          label="When to back up"
          columns={3}
          value={policy.sync.mode}
          onChange={(v) => !readOnly && set('sync', { mode: v })}
          options={[
            { value: 'auto', title: 'As files change', description: 'Recommended. Starts shortly after work is saved.', icon: <ArrowSyncCircle24Regular /> },
            { value: 'interval', title: 'On a timer', description: 'Checks for changes at a fixed interval.', icon: <Timer24Regular /> },
            { value: 'manual', title: 'Only when I ask', description: 'Nothing happens until you click Back up now.', icon: <CursorClick24Regular /> },
          ]}
        />
        {policy.sync.mode === 'auto' ? (
          <Row
            icon={<HourglassHalf20Regular />}
            label="Wait for files to settle"
            description="Backs up once files have stopped changing for this long, so a busy save is copied once, complete."
            control={<StepSlider steps={QUIET_STEPS} value={policy.sync.quietSeconds} onChange={(v) => set('sync', { quietSeconds: v })} format={secondsLabel} label="Settle time" disabled={readOnly} />}
          />
        ) : null}
        {policy.sync.mode === 'interval' ? (
          <Row
            icon={<Clock20Regular />}
            label="Back up every"
            control={
              <Dropdown
                aria-label="Backup interval"
                disabled={readOnly}
                value={INTERVALS.includes(policy.sync.intervalMinutes) ? (policy.sync.intervalMinutes >= 60 ? plural(policy.sync.intervalMinutes / 60, 'hour') : `${policy.sync.intervalMinutes} minutes`) : `${policy.sync.intervalMinutes} minutes`}
                selectedOptions={[String(policy.sync.intervalMinutes)]}
                onOptionSelect={(_, d) => set('sync', { intervalMinutes: Number(d.optionValue) })}
              >
                {INTERVALS.map((m) => (
                  <Option key={m} value={String(m)}>
                    {m >= 60 ? plural(m / 60, 'hour') : `${m} minutes`}
                  </Option>
                ))}
              </Dropdown>
            }
          />
        ) : null}
      </Group>

      <Group title="Tally" aside={<Badge appearance="tint" color={status.tallyRunning ? 'warning' : 'subtle'}>{status.tallyRunning ? `Running now (${status.tallyRunning})` : 'Not running now'}</Badge>}>
        <OptionCards
          label="When Tally is open"
          columns={2}
          value={policy.sync.tallyMode}
          onChange={(v) => !readOnly && set('sync', { tallyMode: v })}
          options={[
            {
              value: 'quiet',
              title: 'Back up between Tally entries',
              description: 'Recommended, also when Tally never closes. Waits until Tally has not saved anything for a few minutes, then checks every copy.',
              icon: <DocumentCheckmark24Regular />,
            },
            {
              value: 'close',
              title: 'Wait until Tally closes',
              description: 'Only if you close Tally every day. Nothing is backed up while Tally is open.',
              icon: <LockClosed24Regular />,
            },
          ]}
        />
        {policy.sync.tallyMode === 'quiet' ? (
          <Row
            icon={<HourglassHalf20Regular />}
            label="Quiet time before a backup"
            description="While Tally is open, a backup starts after Tally has saved nothing for this long. If Tally saves during the copy, that company is copied again later."
            control={
              <StepSlider steps={TALLY_QUIET_STEPS} value={policy.sync.tallyQuietSeconds} onChange={(v) => set('sync', { tallyQuietSeconds: v })} format={secondsLabel} label="Quiet time" disabled={readOnly} />
            }
          />
        ) : (
          <Row
            icon={<HourglassHalf20Regular />}
            label="After Tally closes, wait"
            description="Gives Tally time to finish writing before files are read."
            control={<StepSlider steps={GRACE_STEPS} value={policy.sync.graceSeconds} onChange={(v) => set('sync', { graceSeconds: v })} format={secondsLabel} label="Wait after Tally closes" disabled={readOnly} />}
          />
        )}
        <Row icon={<WindowApps20Regular />} label="Names of the Tally programs" description="AM Backup uses these names to see whether Tally is open.">
          <ChipToggles items={tallyItems} value={policy.sync.tallyProcesses} onChange={(v) => set('sync', { tallyProcesses: v })} disabled={readOnly} />
          {!readOnly ? (
            <AddCustom
              placeholder="Another program, e.g. tallyserver.exe"
              onAdd={(v) => set('sync', { tallyProcesses: [...policy.sync.tallyProcesses, v.toLowerCase()] })}
              validate={(v) => (/^[\w .()-]+$/.test(v) ? (policy.sync.tallyProcesses.includes(v.toLowerCase()) ? 'Already in the list.' : null) : 'Enter just the program file name.')}
            />
          ) : null}
        </Row>
        <Row
          icon={<BookOpen20Regular />}
          label="Save Tally data with backups"
          description="When a company is backed up, AM Backup reads its ledgers and vouchers from Tally's XML server. You can then view and compare them in Tally data."
          control={<Switch checked={policy.tally.snapshots} disabled={readOnly} onChange={(_, d) => set('tally', { snapshots: d.checked })} aria-label="Save Tally data with backups" />}
        />
        {policy.tally.snapshots ? (
          <>
            <Row
              icon={<Timer20Regular />}
              label="Save Tally data at most every"
              description="Reading a large company can make Tally pause for a moment, so it is not done at every backup."
              control={
                <StepSlider steps={TALLY_EVERY} value={policy.tally.everyMinutes} onChange={(v) => set('tally', { everyMinutes: v })} format={everyLabel} label="Tally data interval" disabled={readOnly} />
              }
            />
            <Row
              icon={<PlugConnected20Regular />}
              label="Port of Tally's XML server"
              description="The port set in Tally under Client/Server configuration. Tally uses 9000 unless someone changed it."
              control={
                <SpinButton
                  aria-label="Port of Tally's XML server"
                  value={policy.tally.port}
                  min={1}
                  max={65535}
                  disabled={readOnly}
                  style={{ width: 120 }}
                  onChange={(_, d) => {
                    const v = d.value ?? Number(d.displayValue);
                    if (Number.isFinite(v) && v >= 1 && v <= 65535) set('tally', { port: Math.round(v) });
                  }}
                />
              }
            />
          </>
        ) : null}
      </Group>

      {isAdmin ? (
        <Group
          title="Complete backups"
          description="A full, highly compressed copy of the whole folder, kept alongside the file-by-file history."
          aside={policy.full.schedule !== 'off' ? <Caption1 className={s.muted}>Next: {until(status.nextFullAt)}</Caption1> : undefined}
        >
          <Row
            icon={<CalendarClock20Regular />}
            label="How often"
            description={fullDesc}
            control={
              <Dropdown
                aria-label="Complete backup frequency"
                value={{ daily: 'Every day', hours: 'Every few hours', weekly: 'Once a week', off: 'Off' }[policy.full.schedule]}
                selectedOptions={[policy.full.schedule]}
                onOptionSelect={(_, d) => set('full', { schedule: d.optionValue as Policy['full']['schedule'] })}
              >
                <Option value="daily">Every day</Option>
                <Option value="hours">Every few hours</Option>
                <Option value="weekly">Once a week</Option>
                <Option value="off">Off</Option>
              </Dropdown>
            }
          >
            {policy.full.schedule === 'daily' || policy.full.schedule === 'weekly' ? (
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                {policy.full.schedule === 'weekly' ? (
                  <div className={s.days} role="radiogroup" aria-label="Day of the week">
                    {WEEKDAYS.map((d, i) => (
                      <ToggleButton key={d} size="small" checked={policy.full.weekday === i} role="radio" aria-checked={policy.full.weekday === i} onClick={() => set('full', { weekday: i })}>
                        {d.slice(0, 3)}
                      </ToggleButton>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text>at</Text>
                  <Dropdown
                    aria-label="Time of day"
                    value={clockLabel(policy.full.time)}
                    selectedOptions={[policy.full.time]}
                    onOptionSelect={(_, d) => set('full', { time: d.optionValue! })}
                    style={{ minWidth: 120 }}
                    listbox={{ style: { maxHeight: 280 } }}
                  >
                    {TIMES.map((t) => (
                      <Option key={t} value={t}>
                        {clockLabel(t)}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
                <Caption1 className={s.muted}>If the computer is off then, it runs at the next chance. While Tally is open, it starts when Tally's files are quiet.</Caption1>
              </div>
            ) : policy.full.schedule === 'hours' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text>Every</Text>
                <Dropdown
                  aria-label="Hours between complete backups"
                  value={`${policy.full.everyHours} hours`}
                  selectedOptions={[String(policy.full.everyHours)]}
                  onOptionSelect={(_, d) => set('full', { everyHours: Number(d.optionValue) })}
                  style={{ minWidth: 120 }}
                >
                  {EVERY_HOURS.map((h) => (
                    <Option key={h} value={String(h)}>{`${h} hours`}</Option>
                  ))}
                </Dropdown>
              </div>
            ) : undefined}
          </Row>
          {policy.full.schedule !== 'off' ? (
            <>
              <Row icon={<Archive20Regular />} label="Compression" description="Higher compression makes smaller backups but takes longer to create.">
                <div className={s.compression}>
                  <OptionCards
                    label="Compression"
                    columns={3}
                    value={policy.full.level}
                    onChange={(v) => set('full', { level: v })}
                    options={[
                      { value: 'balanced', title: 'Balanced', description: 'Quick to create', icon: <ArrowMaximize24Regular /> },
                      { value: 'high', title: 'High', description: 'Smaller, a little slower', icon: <DataBarVertical24Regular /> },
                      { value: 'maximum', title: 'Maximum', description: 'Smallest; best for storage', icon: <ArrowMinimize24Regular /> },
                    ]}
                  />
                </div>
              </Row>
              <Row
                icon={<History20Regular />}
                label="Keep the latest"
                description="Older complete backups are deleted automatically."
                control={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SpinButton
                      value={policy.full.keep}
                      min={1}
                      max={365}
                      onChange={(_, d) => {
                        const v = d.value ?? Number(d.displayValue);
                        if (Number.isFinite(v) && v >= 1 && v <= 365) set('full', { keep: Math.round(v) });
                      }}
                      aria-label="Number of complete backups to keep"
                      style={{ width: 90 }}
                    />
                    <Text>backups</Text>
                  </div>
                }
              />
            </>
          ) : null}
        </Group>
      ) : null}

      {isAdmin ? (
        <Group title="History">
          <Row
            icon={<History20Regular />}
            label="Keep every change for"
            description="How far back point-in-time restore can go. Longer history uses more storage."
            control={
              <Dropdown
                aria-label="Keep change history for"
                value={policy.retention.versionDays === 0 ? 'Forever' : policy.retention.versionDays >= 365 ? '1 year' : `${policy.retention.versionDays} days`}
                selectedOptions={[String(policy.retention.versionDays)]}
                onOptionSelect={(_, d) => set('retention', { versionDays: Number(d.optionValue) })}
              >
                {RETENTION.map((d) => (
                  <Option key={d} value={String(d)}>
                    {d === 0 ? 'Forever' : d >= 365 ? '1 year' : `${d} days`}
                  </Option>
                ))}
              </Dropdown>
            }
          />
        </Group>
      ) : null}

      <Group title="Skip these files" description="Matching files and folders are never backed up.">
        <Row icon={<DocumentDismiss20Regular />} label="Skipped file types">
          <ChipToggles items={excludeItems} value={policy.exclude} onChange={(v) => set('exclude', v)} disabled={readOnly} />
          {!readOnly ? (
            <AddCustom
              placeholder="Another pattern, e.g. *.xlsx or Old Data"
              onAdd={(v) => set('exclude', [...policy.exclude, v])}
              validate={(v) => (v.length > 120 ? 'That pattern is too long.' : policy.exclude.some((p) => p.toLowerCase() === v.toLowerCase()) ? 'Already in the list.' : null)}
            />
          ) : null}
        </Row>
      </Group>

      {dirty && !readOnly ? (
        <div className={s.saveBar} role="region" aria-label="Unsaved changes">
          <Text weight="semibold">You have unsaved changes</Text>
          <div className={s.saveActions}>
            <Button onClick={() => setPolicy(saved)} disabled={saving}>
              Discard
            </Button>
            <Button appearance="primary" onClick={save} disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingFolder !== null}
        title={config.watchedFolder ? 'Switch the backup folder?' : 'Back up this folder?'}
        confirmLabel={config.watchedFolder ? 'Switch folder' : 'Start backing up'}
        busy={folderBusy}
        onCancel={() => setPendingFolder(null)}
        onConfirm={confirmFolder}
      >
        <Text className="selectable" weight="semibold">
          {pendingFolder?.path}
        </Text>
        <br />
        {pendingFolder ? `${plural(pendingFolder.summary.totalFiles, 'file')} in ${plural(pendingFolder.summary.folders.filter((f) => !f.path.includes('/')).length, 'folder')} · ${bytes(pendingFolder.summary.totalBytes)}.` : ''}
        {config.watchedFolder ? ' Files already backed up from the old folder stay in the history.' : ' The first backup uploads everything; later backups only send what changed.'}
      </ConfirmDialog>
    </Page>
  );
}
