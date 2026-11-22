import {
  Badge,
  Body1,
  Button,
  Caption1,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  ProgressBar,
  Spinner,
  Subtitle1,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeft20Regular, CloudAdd24Regular, Desktop24Regular, Eye20Regular, EyeOff20Regular, Globe24Regular, Server24Regular } from '@fluentui/react-icons';
import { useEffect, useState, type FormEvent } from 'react';
import { AppMark } from '../components/AppMark';
import { ServerSetup } from '../components/ServerSetup';
import { OptionCards } from '../components/ui';
import { backend, errorMessage } from '../lib/backend';
import type { ConfigView, Health } from '../lib/types';
import { useApp } from '../state';

const LOCAL_URL = 'http://localhost:8787';

const useStyles = makeStyles({
  screen: {
    height: '100vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '56px 24px 32px',
    boxSizing: 'border-box',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  brand: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' },
  brandName: { display: 'flex', flexDirection: 'column' },
  muted: { color: tokens.colorNeutralForeground3 },
  card: {
    width: '100%',
    maxWidth: '460px',
    boxSizing: 'border-box',
    padding: '28px 32px 32px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  },
  wide: { maxWidth: '560px' },
  wizard: { maxWidth: '640px' },
  heading: { display: 'flex', flexDirection: 'column', gap: '6px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginTop: '4px' },
  server: { display: 'flex', alignItems: 'center', gap: '8px', color: tokens.colorNeutralForeground3, minWidth: 0 },
  serverText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  footer: { marginTop: 'auto', paddingTop: '32px', color: tokens.colorNeutralForeground3 },
  strength: { display: 'flex', flexDirection: 'column', gap: '4px' },
  back: { alignSelf: 'flex-start', marginLeft: '-8px', marginBottom: '-8px' },
});

type Step = 'checking' | 'server' | 'setup' | 'signin' | 'reset' | 'deploy' | 'recover';

/** The Worker name, read from a workers.dev address (worker.account.workers.dev). */
function workerFromUrl(url: string | null): string | undefined {
  const host = url?.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  return host.endsWith('.workers.dev') ? host.split('.')[0] : undefined;
}

function strength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  return { score: pw.length < 8 ? 0 : score, label: pw.length < 8 ? 'Use at least 8 characters' : labels[score]! };
}

function PasswordInput({ value, onChange, autoComplete, id }: { value: string; onChange: (v: string) => void; autoComplete: string; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Input
      id={id}
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(_, d) => onChange(d.value)}
      autoComplete={autoComplete}
      contentAfter={
        <Button
          appearance="transparent"
          size="small"
          icon={show ? <EyeOff20Regular /> : <Eye20Regular />}
          aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow(!show)}
        />
      }
    />
  );
}

function StrengthMeter({ password }: { password: string }) {
  const s = useStyles();
  const { score, label } = strength(password);
  if (!password) return null;
  const color = score <= 1 ? 'error' : score <= 2 ? 'warning' : 'success';
  return (
    <div className={s.strength} aria-live="polite">
      <ProgressBar value={Math.max(0.08, score / 5)} color={color} thickness="medium" aria-label="Password strength" />
      <Caption1 className={s.muted}>{label}</Caption1>
    </div>
  );
}

export function AuthScreen({ onSignedIn, expiredMessage }: { onSignedIn: (c: ConfigView) => void; expiredMessage: string | null }) {
  const s = useStyles();
  const { config, setConfig } = useApp();
  const [step, setStep] = useState<Step>(config.serverUrl ? 'checking' : 'server');
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(expiredMessage);
  const [busy, setBusy] = useState(false);

  // server step
  const [serverChoice, setServerChoice] = useState<'default' | 'local' | 'online' | 'new'>(
    config.defaultServer ? 'default' : config.serverUrl && !config.serverUrl.includes('localhost') ? 'online' : 'local',
  );
  const [onlineUrl, setOnlineUrl] = useState(config.serverUrl && !config.serverUrl.includes('localhost') ? config.serverUrl : '');

  // account fields
  const [username, setUsername] = useState(config.user?.username ?? '');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [setupKey, setSetupKey] = useState('');
  // A setup key that was just changed in Cloudflare can take a few seconds to apply.
  const [waitForKey, setWaitForKey] = useState(false);

  useEffect(() => setNotice(expiredMessage), [expiredMessage]);

  const check = async () => {
    if (!config.serverUrl) return setStep('server');
    setStep('checking');
    setError(null);
    try {
      const h = await backend.checkServer(config.serverUrl);
      setHealth(h);
      setStep(h.needsSetup ? 'setup' : 'signin');
    } catch (e) {
      setError(errorMessage(e));
      setStep('signin');
    }
  };

  useEffect(() => {
    if (config.serverUrl) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (serverChoice === 'new') {
      setError(null);
      return setStep('deploy');
    }
    const url = serverChoice === 'local' ? LOCAL_URL : serverChoice === 'default' ? config.defaultServer! : onlineUrl.trim();
    if (!url) return setError('Enter the address of your backup server.');
    setBusy(true);
    setError(null);
    try {
      const h = await backend.connectServer(url);
      setHealth(h);
      setConfig(await backend.getConfig());
      setStep(h.needsSetup ? 'setup' : 'signin');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'signin') {
        if (!username.trim() || !password) throw 'Enter your username and password.';
        onSignedIn(await backend.login(username, password));
      } else if (step === 'setup') {
        if (!setupKey.trim()) throw 'Enter the setup key from the server configuration.';
        if (strength(password).score === 0) throw 'Choose a password with at least 8 characters.';
        onSignedIn(await backend.setupAdmin(setupKey, username, displayName || 'Administrator', password));
      } else if (step === 'reset') {
        if (strength(password).score === 0) throw 'Choose a password with at least 8 characters.';
        const name = await backend.resetAdmin(setupKey, password, waitForKey);
        setUsername(name);
        setPassword('');
        setSetupKey('');
        setNotice(`Password changed. Sign in as "${name}" with your new password.`);
        setStep('signin');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const serverLabel = config.serverUrl?.replace(/^https?:\/\//, '') ?? '';
  const isLocal = config.serverUrl?.includes('localhost') || config.serverUrl?.includes('127.0.0.1');

  const serverLine = (
    <div className={s.server}>
      {isLocal ? <Desktop24Regular fontSize={16} /> : <Globe24Regular fontSize={16} />}
      <Caption1 className={s.serverText} title={config.serverUrl ?? ''}>
        {serverLabel}
      </Caption1>
      {health?.environment === 'local' ? <Badge appearance="tint" color="warning" size="small">Test server</Badge> : null}
    </div>
  );

  return (
    <div className={`${s.screen} app-chrome`}>
      <div className={s.brand}>
        <AppMark size={44} />
        <div className={s.brandName}>
          <Text size={600} weight="semibold">
            AM Backup
          </Text>
          <Caption1 className={s.muted}>Tally data, safely backed up</Caption1>
        </div>
      </div>

      {step === 'checking' ? (
        <div className={s.card} role="status">
          <Spinner label="Connecting to your backup server" />
        </div>
      ) : null}

      {step === 'server' ? (
        <form className={`${s.card} ${s.wide}`} onSubmit={connect}>
          <div className={s.heading}>
            <Subtitle1 as="h1">Connect to your backup server</Subtitle1>
            <Body1 className={s.muted}>Backups are stored on a Cloudflare server set up for your office. Choose where it runs.</Body1>
          </div>
          <OptionCards
            label="Backup server"
            columns={1}
            value={serverChoice}
            onChange={(v) => {
              setServerChoice(v);
              setError(null);
            }}
            options={[
              ...(config.defaultServer
                ? [{ value: 'default' as const, title: 'Office backup server', description: config.defaultServer.replace(/^https?:\/\//, ''), icon: <Server24Regular /> }]
                : []),
              { value: 'online', title: 'Online server', description: 'The Cloudflare address your administrator gave you', icon: <Globe24Regular /> },
              { value: 'local', title: 'Test server on this computer', description: 'For trying things out with Localflare (localhost:8787)', icon: <Desktop24Regular /> },
              { value: 'new', title: 'Set up a new server', description: 'Administrator only: make the office server in your Cloudflare account', icon: <CloudAdd24Regular /> },
            ]}
          />
          {serverChoice === 'online' ? (
            <Field label="Server address" hint="For example: am-backup-api.your-team.workers.dev">
              <Input
                value={onlineUrl}
                onChange={(_, d) => setOnlineUrl(d.value)}
                placeholder="https://"
                contentBefore={<Globe24Regular fontSize={16} />}
                autoFocus
                spellCheck={false}
              />
            </Field>
          ) : null}
          {error ? (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={s.actions}>
            <span />
            <Button appearance="primary" type="submit" disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined}>
              {serverChoice === 'new' ? 'Start setup' : busy ? 'Connecting' : 'Connect'}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'deploy' ? (
        <div className={`${s.card} ${s.wizard}`}>
          <ServerSetup
            onClose={() => setStep('server')}
            onSignedIn={onSignedIn}
            onSignIn={() => {
              setPassword('');
              void check();
            }}
          />
        </div>
      ) : null}

      {step === 'recover' ? (
        <div className={`${s.card} ${s.wizard}`}>
          <ServerSetup
            mode="recover"
            workerName={config.serverDeploy?.worker ?? workerFromUrl(config.serverUrl)}
            onClose={() => setStep('reset')}
            onNewKey={(key) => {
              setSetupKey(key);
              setWaitForKey(true);
              setError(null);
              setNotice('The server has a new setup key. Now choose the new administrator password.');
              setStep('reset');
            }}
          />
        </div>
      ) : null}

      {step === 'setup' || step === 'signin' || step === 'reset' ? (
        <form className={s.card} onSubmit={submit} noValidate>
          {step === 'reset' ? (
            <Button className={s.back} appearance="subtle" size="small" icon={<ArrowLeft20Regular />} onClick={() => setStep('signin')}>
              Back to sign in
            </Button>
          ) : null}
          <div className={s.heading}>
            <Subtitle1 as="h1">
              {step === 'setup' ? 'Create the administrator account' : step === 'reset' ? 'Reset the administrator password' : 'Sign in'}
            </Subtitle1>
            <Body1 className={s.muted}>
              {step === 'setup'
                ? 'This is a one-time step. The administrator manages users, folders and restores.'
                : step === 'reset'
                  ? 'Use the setup key from the server configuration to choose a new password.'
                  : 'Use the account your administrator created for you.'}
            </Body1>
          </div>
          {notice ? (
            <MessageBar intent={notice.startsWith('Password changed') || notice.startsWith('The server has a new') ? 'success' : 'warning'}>
              <MessageBarBody>{notice}</MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={s.form}>
            {step !== 'signin' ? (
              <Field label="Setup key" hint="The SETUP_KEY secret set on the server" required>
                <PasswordInput value={setupKey} onChange={setSetupKey} autoComplete="off" />
              </Field>
            ) : null}
            {step === 'setup' ? (
              <Field label="Your name">
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="Administrator" autoComplete="name" />
              </Field>
            ) : null}
            {step !== 'reset' ? (
              <Field label="Username" required hint={step === 'setup' ? 'Letters, numbers, dots, dashes and underscores' : undefined}>
                <Input value={username} onChange={(_, d) => setUsername(d.value)} autoComplete="username" autoFocus={step === 'signin'} spellCheck={false} />
              </Field>
            ) : null}
            <Field label={step === 'signin' ? 'Password' : 'New password'} required>
              <PasswordInput value={password} onChange={setPassword} autoComplete={step === 'signin' ? 'current-password' : 'new-password'} />
            </Field>
            {step !== 'signin' ? <StrengthMeter password={password} /> : null}
          </div>
          {error ? (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>{step === 'signin' ? "Couldn't sign in" : "That didn't work"}</MessageBarTitle>
                {error}
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={s.actions}>
            {serverLine}
            <Button appearance="primary" type="submit" disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined}>
              {step === 'setup' ? 'Create administrator' : step === 'reset' ? 'Change password' : busy ? 'Signing in' : 'Sign in'}
            </Button>
          </div>
          {step === 'reset' ? (
            <Caption1 className={s.muted}>
              Lost the setup key too?{' '}
              <Link as="button" onClick={() => (setError(null), setNotice(null), setStep('recover'))}>
                Make a new one with your Cloudflare account
              </Link>
            </Caption1>
          ) : null}
          {step === 'signin' ? (
            <Caption1 className={s.muted}>
              <Link as="button" onClick={() => (setError(null), setNotice(null), setPassword(''), setStep('reset'))}>
                Forgot the administrator password?
              </Link>
              {' · '}
              <Link as="button" onClick={() => (setError(null), setStep('server'))}>
                Use a different server
              </Link>
              {error && !health ? (
                <>
                  {' · '}
                  <Link as="button" onClick={check}>
                    Try again
                  </Link>
                </>
              ) : null}
            </Caption1>
          ) : null}
        </form>
      ) : null}

      <Caption1 className={s.footer}>
        Developed by{' '}
        <Link as="button" onClick={() => void backend.openUrl('https://autoficial.ltd')}>
          AFLABS
        </Link>
      </Caption1>
    </div>
  );
}
