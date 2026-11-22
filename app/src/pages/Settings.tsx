import {
  Badge,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Desktop20Regular,
  DarkTheme20Regular,
  ErrorCircle16Filled,
  Globe20Regular,
  Info16Regular,
  Key20Regular,
  Person20Regular,
  Power20Regular,
  SignOut20Regular,
  Warning16Filled,
  WindowArrowUp20Regular,
  FolderOpen20Regular,
  Shield20Regular,
} from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { ConfirmDialog, Group, Page, PageHeader, Row, useLoader } from '../components/ui';
import { api, autostart, backend, errorMessage } from '../lib/backend';
import { ago, when } from '../lib/format';
import type { AuditEvent, LogLine } from '../lib/types';
import { useApp } from '../state';

const useStyles = makeStyles({
  inline: { display: 'flex', gap: '8px', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  log: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '280px',
    overflowY: 'auto',
    gap: '2px',
  },
  logLine: { display: 'grid', gridTemplateColumns: '18px 150px minmax(0, 1fr)', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
  logIcon: { display: 'flex', alignSelf: 'center' },
  seg: { display: 'flex', gap: '4px' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px' },
});

const AUDIT_TEXT: Record<string, string> = {
  'setup.admin_created': 'Administrator account created',
  'setup.admin_password_reset': 'Administrator password reset with the setup key',
  'auth.login': 'Signed in',
  'auth.locked': 'Sign-in locked after repeated wrong passwords',
  'account.password_changed': 'Changed their password',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'user.deleted': 'Deleted a user',
  'settings.updated': 'Changed backup settings',
  'full.completed': 'Complete backup finished',
  'full.deleted': 'Deleted a complete backup',
  'maintenance.run': 'Ran storage clean-up',
};

function auditDetail(e: AuditEvent): string {
  try {
    const d = e.detail ? JSON.parse(e.detail) : null;
    if (!d) return '';
    if (d.username && e.action.startsWith('user.')) return d.username;
    if (d.device) return `on ${d.device}`;
    if (e.action === 'full.completed') return `${d.fileCount} files`;
  } catch {
    /* ignore */
  }
  return '';
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useStyles();
  const { notify } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    if (next.length < 8) return setError('Use at least 8 characters for the new password.');
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', '/api/me', { currentPassword: current, newPassword: next });
      notify('success', 'Password changed', 'Other computers signed in to your account were signed out.');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && !busy && onClose()}>
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <DialogTitle>Change your password</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                <Field label="Current password" required>
                  <Input type="password" value={current} onChange={(_, d) => setCurrent(d.value)} autoComplete="current-password" autoFocus />
                </Field>
                <Field label="New password" required hint="At least 8 characters">
                  <Input type="password" value={next} onChange={(_, d) => setNext(d.value)} autoComplete="new-password" />
                </Field>
                {error ? (
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                ) : null}
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={busy || !current || !next} icon={busy ? <Spinner size="tiny" /> : undefined}>
                Change password
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

export default function Settings() {
  const s = useStyles();
  const app = useApp();
  const { config, isAdmin, notify, info } = app;
  const user = config.user!;
  const [name, setName] = useState(user.displayName);
  const [device, setDevice] = useState(config.deviceName);
  const [pwOpen, setPwOpen] = useState(false);
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  const [confirmServer, setConfirmServer] = useState(false);
  const logs = useLoader(() => backend.getLogs(), []);
  const audit = useLoader(() => (isAdmin ? api<{ events: AuditEvent[] }>('GET', '/api/audit?limit=40').then((r) => r.events) : Promise.resolve([])), [isAdmin]);

  useEffect(() => {
    autostart()
      .then((a) => a.isEnabled())
      .then(setAutoOn, () => setAutoOn(false));
  }, []);

  const saveName = async () => {
    try {
      await api('PATCH', '/api/me', { displayName: name.trim() });
      await backend.refreshSession();
      await app.refreshConfig();
      notify('success', 'Name updated');
    } catch (e) {
      notify('error', 'Could not update your name', errorMessage(e));
    }
  };

  const prefs = async (p: { closeToTray?: boolean; theme?: string; deviceName?: string }) => {
    app.setConfig(await backend.setPreferences(p));
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      const a = await autostart();
      if (on) await a.enable();
      else await a.disable();
      setAutoOn(on);
    } catch (e) {
      notify('error', 'Could not change start-up setting', errorMessage(e));
    }
  };

  const env = config.serverUrl?.includes('localhost') || config.serverUrl?.includes('127.0.0.1') ? 'Test server on this computer' : 'Online server';

  return (
    <Page>
      <PageHeader title="Settings" />

      <Group title="Your account">
        <Row
          icon={<Person20Regular />}
          label="Name"
          description={`Signed in as ${user.username}`}
          control={
            <div className={s.inline}>
              <Input value={name} onChange={(_, d) => setName(d.value)} aria-label="Your name" style={{ width: 220 }} />
              <Button onClick={saveName} disabled={!name.trim() || name.trim() === user.displayName}>
                Save
              </Button>
            </div>
          }
        />
        <Row icon={<Key20Regular />} label="Password" description="Changing it signs out your other computers." control={<Button onClick={() => setPwOpen(true)}>Change password</Button>} />
        <Row
          icon={<SignOut20Regular />}
          label="Sign out of AM Backup"
          description="Backups on this computer stop until someone signs in again."
          control={
            <Button
              onClick={async () => {
                await backend.logout();
                await app.refreshConfig();
              }}
            >
              Sign out
            </Button>
          }
        />
      </Group>

      <Group title="This computer">
        <Row
          icon={<Desktop20Regular />}
          label="Computer name"
          description="Shown in the backup history so you can tell computers apart."
          control={
            <div className={s.inline}>
              <Input value={device} onChange={(_, d) => setDevice(d.value)} aria-label="Computer name" style={{ width: 220 }} maxLength={60} />
              <Button onClick={() => void prefs({ deviceName: device }).then(() => notify('success', 'Computer name saved'))} disabled={!device.trim() || device.trim() === config.deviceName}>
                Save
              </Button>
            </div>
          }
        />
        <Row
          icon={<Power20Regular />}
          label="Start AM Backup when I sign in to Windows"
          description="Recommended, so backups never stop after a restart. It starts quietly in the notification area."
          control={<Switch checked={Boolean(autoOn)} disabled={autoOn === null} onChange={(_, d) => void toggleAutostart(d.checked)} aria-label="Start with Windows" />}
        />
        <Row
          icon={<WindowArrowUp20Regular />}
          label="Keep backing up when the window is closed"
          description="Closing the window leaves AM Backup running in the notification area. Quit it from the tray icon."
          control={<Switch checked={config.closeToTray} onChange={(_, d) => void prefs({ closeToTray: d.checked })} aria-label="Keep running when closed" />}
        />
        <Row
          icon={<DarkTheme20Regular />}
          label="Appearance"
          control={
            <div className={s.seg} role="radiogroup" aria-label="Appearance">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <ToggleButton key={t} size="small" role="radio" aria-checked={config.theme === t} checked={config.theme === t} onClick={() => void prefs({ theme: t })}>
                  {t === 'system' ? 'Match Windows' : t === 'light' ? 'Light' : 'Dark'}
                </ToggleButton>
              ))}
            </div>
          }
        />
      </Group>

      <Group title="Backup server">
        <Row
          icon={<Globe20Regular />}
          label={<span className="selectable">{config.serverUrl}</span>}
          description={env}
          control={
            <>
              <Badge appearance="tint" color={env.startsWith('Test') ? 'warning' : 'success'}>
                {env.startsWith('Test') ? 'Testing' : 'Production'}
              </Badge>
              <Button onClick={() => setConfirmServer(true)}>Change server…</Button>
            </>
          }
        />
      </Group>

      <Group
        title="Activity on this computer"
        aside={
          info?.logDir ? (
            <Button size="small" appearance="subtle" icon={<FolderOpen20Regular />} onClick={() => void backend.openPath(info.logDir!)}>
              Open log folder
            </Button>
          ) : undefined
        }
      >
        <Row icon={<Info16Regular />} label="Recent events" description="Newest last. The full log is kept in the log folder.">
          <div className={s.log} role="log" aria-label="Recent events">
            {(logs.data ?? []).slice(-60).map((l: LogLine, i) => (
              <div key={`${l.at}-${i}`} className={s.logLine}>
                <span className={s.logIcon} aria-label={l.level}>
                  {l.level === 'error' ? (
                    <ErrorCircle16Filled color={tokens.colorStatusDangerForeground1} />
                  ) : l.level === 'warn' ? (
                    <Warning16Filled color={tokens.colorStatusWarningForeground1} />
                  ) : (
                    <Info16Regular color={tokens.colorNeutralForeground3} />
                  )}
                </span>
                <Caption1 className={`${s.muted} tabular`}>{when(l.at)}</Caption1>
                <Caption1 className="selectable">{l.message}</Caption1>
              </div>
            ))}
            {logs.data && logs.data.length === 0 ? <Caption1 className={s.muted}>Nothing yet.</Caption1> : null}
          </div>
        </Row>
      </Group>

      {isAdmin ? (
        <Group title="Account activity" description="Sign-ins and changes made by anyone, kept for a year.">
          <Row icon={<Shield20Regular />} label="Latest events">
            <div className={s.log} role="log" aria-label="Account activity">
              {(audit.data ?? []).map((e) => (
                <div key={e.id} className={s.logLine}>
                  <span />
                  <Caption1 className={`${s.muted} tabular`}>{ago(e.at)}</Caption1>
                  <Caption1>
                    <Text size={200} weight="semibold">
                      {e.username ?? 'Someone'}
                    </Text>{' '}
                    {(AUDIT_TEXT[e.action] ?? e.action).toLowerCase()} {auditDetail(e)}
                  </Caption1>
                </div>
              ))}
              {audit.data && audit.data.length === 0 ? <Caption1 className={s.muted}>No activity yet.</Caption1> : null}
            </div>
          </Row>
        </Group>
      ) : null}

      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <ConfirmDialog
        open={confirmServer}
        title="Change the backup server?"
        confirmLabel="Sign out and change"
        onCancel={() => setConfirmServer(false)}
        onConfirm={async () => {
          await backend.logout();
          await app.refreshConfig();
        }}
      >
        You'll be signed out and asked which server to connect to. Backups already on the current server stay there.
      </ConfirmDialog>
    </Page>
  );
}
