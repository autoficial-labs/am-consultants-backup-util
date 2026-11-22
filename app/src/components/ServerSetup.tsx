// Built-in server setup: creates or updates the AM Backup server in the office's own Cloudflare
// account, with the steps and links the administrator needs to get a Cloudflare token.
// Used from the sign-in screen (new server), the Server page (update) and the password
// reset screen (new setup key when the old one is lost).
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Subtitle1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  CheckmarkCircle20Filled,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Circle20Regular,
  Copy20Regular,
  DismissCircle20Filled,
  Eye20Regular,
  EyeOff20Regular,
  Key20Regular,
  Open16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { backend, errorMessage, listen } from '../lib/backend';
import type { CfAccount, ConfigView, DeployOutcome, Preflight, ServerNames, ServerSetupInfo, SetupStepEvent, SetupStepId } from '../lib/types';
import { useApp } from '../state';

const SIGN_UP_URL = 'https://dash.cloudflare.com/sign-up';
const R2_URL = 'https://dash.cloudflare.com/?to=/:account/r2/overview';
const TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';
const R2_PRICING_URL = 'https://developers.cloudflare.com/r2/pricing/';

const PERMISSIONS = ['Account Settings: Read', 'Workers Scripts: Edit', 'D1: Edit', 'Workers R2 Storage: Edit'];

const STEP_LABELS: Record<SetupStepId, string> = {
  check: 'Check the Cloudflare account',
  database: 'Create the database',
  tables: 'Create the database tables',
  storage: 'Create the file storage',
  upload: 'Upload the server program',
  schedule: 'Turn on nightly cleanup',
  address: 'Publish the web address',
  online: 'Wait for the server to answer',
  access: 'Prepare the administrator sign-up',
};
const RUN_ORDER: SetupStepId[] = ['check', 'database', 'tables', 'storage', 'upload', 'schedule', 'address', 'online'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  top: { display: 'flex', flexDirection: 'column', gap: '6px' },
  stepper: { display: 'flex', gap: '6px', alignItems: 'center' },
  pip: { height: '4px', flex: 1, borderRadius: '2px', backgroundColor: tokens.colorNeutralStroke2 },
  pipOn: { backgroundColor: tokens.colorBrandBackground },
  eyebrow: { color: tokens.colorNeutralForeground3 },
  muted: { color: tokens.colorNeutralForeground3 },
  body2: { color: tokens.colorNeutralForeground2 },
  list: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '10px', color: tokens.colorNeutralForeground2 },
  need: {
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr)',
    columnGap: '10px',
    rowGap: '14px',
    alignItems: 'start',
  },
  needNum: {
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  needText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  box: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  actionsRight: { display: 'flex', gap: '8px', marginLeft: 'auto' },
  checks: { display: 'flex', flexDirection: 'column', gap: '2px' },
  check: {
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr)',
    columnGap: '10px',
    padding: '10px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  checkText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  bad: { color: tokens.colorPaletteRedForeground1 },
  idle: { color: tokens.colorNeutralForeground4 },
  detail: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  detailBad: { color: tokens.colorPaletteRedForeground1, overflowWrap: 'anywhere' },
  names: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' },
  toggle: { alignSelf: 'flex-start', marginLeft: '-8px' },
  key: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase400,
    letterSpacing: '0.04em',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
  url: { fontFamily: tokens.fontFamilyMonospace, overflowWrap: 'anywhere', userSelect: 'all' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px' },
});

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link as="button" inline onClick={() => void backend.openUrl(href)} style={{ fontSize: 'inherit', lineHeight: 'inherit' }}>
      {children} <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
    </Link>
  );
}

function Secret({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <Input
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(_, d) => onChange(d.value)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      contentBefore={<Key20Regular />}
      contentAfter={
        <Button appearance="transparent" size="small" icon={show ? <EyeOff20Regular /> : <Eye20Regular />} aria-label={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} />
      }
    />
  );
}

function StateIcon({ state }: { state?: SetupStepEvent['state'] }) {
  const s = useStyles();
  if (state === 'done') return <CheckmarkCircle20Filled className={s.ok} />;
  if (state === 'failed') return <DismissCircle20Filled className={s.bad} />;
  if (state === 'running' || state === 'waiting') return <Spinner size="extra-tiny" style={{ width: 20, height: 20 }} />;
  return <Circle20Regular className={s.idle} />;
}

/** Copyable box with the setup key and why it matters. */
export function SetupKeyBox({ value, intro }: { value: string; intro: ReactNode }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  return (
    <div className={s.box}>
      <div className={s.row}>
        <Key20Regular />
        <Text weight="semibold">Setup key</Text>
      </div>
      <Caption1 className={s.body2}>{intro}</Caption1>
      <div className={s.key} aria-label="Setup key">
        {value}
      </div>
      <div className={s.row}>
        <Button size="small" icon={<Copy20Regular />} onClick={() => (copy(value), setCopied(true))}>
          {copied ? 'Copied' : 'Copy key'}
        </Button>
      </div>
    </div>
  );
}

type Mode = 'setup' | 'recover';
type Screen = 'intro' | 'token' | 'confirm' | 'run' | 'done';

export interface ServerSetupProps {
  mode?: Mode;
  /** Worker to give a new setup key to (recover mode). */
  workerName?: string;
  /** New server: the administrator was created and is now signed in. */
  onSignedIn?: (c: ConfigView) => void;
  /** The server already has an administrator: continue to sign in. */
  onSignIn?: () => void;
  /** Recover mode: a new setup key was set. */
  onNewKey?: (key: string) => void;
  /** Update finished (signed-in administrator) or the user closed the wizard. */
  onClose: () => void;
}

export function ServerSetup({ mode = 'setup', workerName, onSignedIn, onSignIn, onNewKey, onClose }: ServerSetupProps) {
  const s = useStyles();
  const { config, setConfig } = useApp();
  const updating = config.signedIn;
  const [screen, setScreen] = useState<Screen>(mode === 'recover' || updating ? 'token' : 'intro');
  const [info, setInfo] = useState<ServerSetupInfo | null>(null);
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<CfAccount[] | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [names, setNames] = useState<ServerNames | null>(null);
  const [subdomain, setSubdomain] = useState('');
  const [showNames, setShowNames] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Partial<Record<SetupStepId, SetupStepEvent>>>({});
  const [outcome, setOutcome] = useState<DeployOutcome | null>(null);
  const [recoveredKey, setRecoveredKey] = useState<string | null>(null);
  const [recoverWorker, setRecoverWorker] = useState(workerName ?? config.serverDeploy?.worker ?? 'am-backup-api');
  // administrator form
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [urlCopied, setUrlCopied] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void backend.serverSetupInfo().then((i) => {
      setInfo(i);
      setNames((n) => n ?? (config.serverDeploy ? { worker: config.serverDeploy.worker, database: config.serverDeploy.database, bucket: config.serverDeploy.bucket } : i.defaults));
    });
    let off: (() => void) | undefined;
    void listen<SetupStepEvent>('server-setup', (e) => mounted.current && setEvents((prev) => ({ ...prev, [e.step]: e }))).then((u) => (off = u));
    return () => {
      mounted.current = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const account = accounts?.find((a) => a.id === accountId) ?? null;
  const steps = 4;
  const stepIndex = { intro: 1, token: 2, confirm: 3, run: 4, done: 4 }[screen];

  const runPreflight = async (acc: CfAccount, wanted: ServerNames) => {
    setBusy(true);
    setError(null);
    try {
      const p = await backend.cfPreflight(token.trim(), acc, wanted);
      setPre(p);
      setNames(p.names);
      setSubdomain((cur) => cur || p.suggestedSubdomain);
      setScreen('confirm');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const checkToken = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!token.trim()) return setError('Paste the token from Cloudflare first.');
    setBusy(true);
    setError(null);
    try {
      const list = await backend.cfAccounts(token.trim());
      setAccounts(list);
      const chosen = list.length === 1 ? list[0]! : (list.find((a) => a.id === config.serverDeploy?.accountId) ?? null);
      setAccountId(chosen?.id ?? null);
      setBusy(false);
      if (chosen && mode === 'setup') await runPreflight(chosen, names ?? info!.defaults);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const makeKey = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const key = await backend.cfNewSetupKey(token.trim(), account.id, recoverWorker.trim());
      setRecoveredKey(key);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deploy = async () => {
    if (!account || !names || !pre) return;
    setScreen('run');
    setEvents({});
    setError(null);
    setBusy(true);
    try {
      const o = await backend.cfDeploy(token.trim(), { account, names, subdomain: pre.subdomain ? null : subdomain.trim().toLowerCase() });
      setOutcome(o);
      setConfig(await backend.getConfig());
      setScreen('done');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (!outcome || !account) return;
    setBusy(true);
    setError(null);
    try {
      const h = await backend.checkServer(outcome.serverUrl);
      let key = outcome.setupKey;
      if (h.needsSetup && !key) key = await backend.cfNewSetupKey(token.trim(), account.id, outcome.names.worker);
      setOutcome({ ...outcome, online: true, needsSetup: h.needsSetup, setupKey: key });
    } catch {
      setError('The address is not answering yet. Wait one or two minutes, then try again.');
    } finally {
      setBusy(false);
    }
  };

  const createAdmin = async (e: FormEvent) => {
    e.preventDefault();
    if (!outcome?.setupKey) return;
    if (password.length < 8) return setError('Choose a password with at least 8 characters.');
    setBusy(true);
    setError(null);
    try {
      const c = await backend.setupAdmin(outcome.setupKey, username, displayName || 'Administrator', password, true);
      onSignedIn?.(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'recover'
      ? 'Make a new setup key'
      : screen === 'intro'
        ? 'Set up your backup server'
        : screen === 'token'
          ? 'Connect to your Cloudflare account'
          : screen === 'confirm'
            ? pre?.workerExists
              ? 'Update the server'
              : 'Check and confirm'
            : screen === 'run'
              ? pre?.workerExists
                ? 'Updating the server'
                : 'Setting up the server'
              : outcome?.needsSetup && outcome.online
                ? 'Create the administrator account'
                : outcome?.online
                  ? updating
                    ? 'The server is up to date'
                    : 'The server is ready'
                  : 'Almost ready';

  const errorBar = error ? (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>That did not work</MessageBarTitle>
        {error}
      </MessageBarBody>
    </MessageBar>
  ) : null;

  const header = (
    <div className={s.top}>
      {mode === 'setup' ? (
        <>
          <div className={s.stepper} aria-hidden>
            {Array.from({ length: steps }, (_, i) => (
              <span key={i} className={mergeClasses(s.pip, i < stepIndex && s.pipOn)} />
            ))}
          </div>
          <Caption1 className={s.eyebrow}>
            Step {stepIndex} of {steps}
          </Caption1>
        </>
      ) : null}
      <Subtitle1 as="h1">{title}</Subtitle1>
    </div>
  );

  // ---- screens ----------------------------------------------------------------------

  if (screen === 'intro') {
    return (
      <div className={s.root}>
        {header}
        <Body1 className={s.body2}>
          AM Backup keeps your files in your office's own Cloudflare account. This app makes the server for you. Do this one time, on the administrator's computer. It takes about
          10 minutes.
        </Body1>
        <div className={s.need}>
          <span className={s.needNum}>1</span>
          <div className={s.needText}>
            <Text weight="semibold">A Cloudflare account</Text>
            <Caption1 className={s.muted}>
              The free plan is enough. <ExternalLink href={SIGN_UP_URL}>Create an account</ExternalLink>
            </Caption1>
          </div>
          <span className={s.needNum}>2</span>
          <div className={s.needText}>
            <Text weight="semibold">R2 storage turned on</Text>
            <Caption1 className={s.muted}>
              In Cloudflare, open R2 and turn it on. R2 includes free storage each month; Cloudflare can ask for a payment card first.{' '}
              <ExternalLink href={R2_URL}>Open R2</ExternalLink> · <ExternalLink href={R2_PRICING_URL}>R2 prices</ExternalLink>
            </Caption1>
          </div>
          <span className={s.needNum}>3</span>
          <div className={s.needText}>
            <Text weight="semibold">An access token</Text>
            <Caption1 className={s.muted}>The next step shows you how to make it. The app uses it only during setup and does not save it.</Caption1>
          </div>
        </div>
        <div className={s.box}>
          <Text weight="semibold">The app makes these items in your account</Text>
          <ul className={s.list}>
            <li>The server program (a Cloudflare Worker) with a web address that ends in workers.dev</li>
            <li>A database for users and the list of backed-up files (D1)</li>
            <li>File storage for the backed-up data (R2)</li>
            <li>A nightly cleanup job that removes old history</li>
          </ul>
        </div>
        <div className={s.actions}>
          <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onClose}>
            Back
          </Button>
          <Button appearance="primary" onClick={() => setScreen('token')}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (screen === 'token') {
    const multi = accounts && accounts.length > 1;
    return (
      <form className={s.root} onSubmit={checkToken}>
        {header}
        {mode === 'recover' ? (
          <Body1 className={s.body2}>
            Use this when the administrator password and the setup key are both lost. The app gives the server a new setup key. Then you can choose a new administrator password.
          </Body1>
        ) : updating ? (
          <Body1 className={s.body2}>
            This app contains server version {info?.version ?? '…'}. The update keeps all users, settings and backed-up files.
          </Body1>
        ) : null}
        <div className={s.need}>
          <span className={s.needNum}>1</span>
          <div className={s.needText}>
            <Text weight="semibold">Open the token page</Text>
            <Caption1 className={s.muted}>Sign in to Cloudflare if it asks. The page opens with the correct permissions already selected:</Caption1>
            <div className={s.chips} style={{ marginTop: 6 }}>
              {PERMISSIONS.map((p) => (
                <Badge key={p} appearance="tint" color="informative" shape="rounded">
                  {p}
                </Badge>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <Button icon={<Open16Regular />} onClick={() => info && void backend.openUrl(info.tokenUrl)} disabled={!info}>
                Open Cloudflare token page
              </Button>
            </div>
          </div>
          <span className={s.needNum}>2</span>
          <div className={s.needText}>
            <Text weight="semibold">Create the token</Text>
            <Caption1 className={s.muted}>
              Scroll to the bottom of the page. Select <b>Continue to summary</b>, then select <b>Create Token</b>.
            </Caption1>
          </div>
          <span className={s.needNum}>3</span>
          <div className={s.needText}>
            <Text weight="semibold">Copy the token and paste it here</Text>
            <Caption1 className={s.muted}>Cloudflare shows the token one time only. Select Copy next to it.</Caption1>
          </div>
        </div>
        <Field label="Cloudflare token" required>
          <Secret value={token} onChange={(v) => (setToken(v), setAccounts(null), setError(null))} placeholder="Paste the token" autoFocus />
        </Field>
        {multi ? (
          <Field label="Cloudflare account" hint="This token can see more than one account. Choose the office account.">
            <Dropdown
              placeholder="Choose an account"
              value={account?.name ?? ''}
              selectedOptions={accountId ? [accountId] : []}
              onOptionSelect={(_, d) => setAccountId(d.optionValue ?? null)}
            >
              {accounts!.map((a) => (
                <Option key={a.id} value={a.id} text={a.name}>
                  {a.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
        ) : null}
        {mode === 'recover' ? (
          <Field label="Server name in Cloudflare" hint="The Worker name. It is the first part of a workers.dev address.">
            <Input value={recoverWorker} onChange={(_, d) => setRecoverWorker(d.value.toLowerCase())} spellCheck={false} />
          </Field>
        ) : null}
        <Caption1 className={s.muted}>
          The link does not work? In Cloudflare, go to <b>My Profile › API Tokens › Create Token › Create Custom Token</b> and add the four permissions above.{' '}
          <ExternalLink href={TOKENS_URL}>Open API Tokens</ExternalLink>
        </Caption1>
        {recoveredKey ? (
          <SetupKeyBox value={recoveredKey} intro="This is the new setup key. Keep a copy in a safe place. You need it again only if the administrator password is lost." />
        ) : null}
        {errorBar}
        <div className={s.actions}>
          <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => (mode === 'recover' || updating ? onClose() : setScreen('intro'))} disabled={busy}>
            {mode === 'recover' || updating ? 'Cancel' : 'Back'}
          </Button>
          <div className={s.actionsRight}>
            {recoveredKey ? (
              <Button appearance="primary" onClick={() => onNewKey?.(recoveredKey)}>
                Continue to new password
              </Button>
            ) : mode === 'recover' && accounts && account ? (
              <Button appearance="primary" onClick={makeKey} disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined}>
                Make a new setup key
              </Button>
            ) : multi && account && mode === 'setup' ? (
              <Button appearance="primary" onClick={() => void runPreflight(account, names ?? info!.defaults)} disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined}>
                Continue
              </Button>
            ) : (
              <Button appearance="primary" type="submit" disabled={busy || !info} icon={busy ? <Spinner size="tiny" /> : undefined}>
                {busy ? 'Checking' : 'Check token'}
              </Button>
            )}
          </div>
        </div>
      </form>
    );
  }

  if (screen === 'confirm' && pre && names && account) {
    const r2Missing = pre.checks.some((c) => c.id === 'r2' && !c.ok && c.detail.includes('not turned on'));
    const url = pre.subdomain ? `${names.worker}.${pre.subdomain}.workers.dev` : `${names.worker}.${subdomain || '…'}.workers.dev`;
    return (
      <div className={s.root}>
        {header}
        <Body1 className={s.body2}>
          Account: <b>{account.name}</b>.{' '}
          {pre.workerExists
            ? 'This account already has the AM Backup server. The app uploads the new server program and keeps all data.'
            : 'The app checked what the token can do in this account.'}
        </Body1>
        <div className={s.checks} role="list">
          {pre.checks.map((c) => (
            <div key={c.id} className={s.check} role="listitem">
              {c.ok ? <CheckmarkCircle20Filled className={s.ok} /> : <DismissCircle20Filled className={s.bad} />}
              <div className={s.checkText}>
                <Text weight="semibold">{c.label}</Text>
                <Caption1 className={c.ok ? s.detail : s.detailBad}>{c.detail}</Caption1>
              </div>
            </div>
          ))}
        </div>
        {r2Missing ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Turn on R2 first</MessageBarTitle>
              Open R2 in Cloudflare and follow the steps to turn it on. Then select Check again.
            </MessageBarBody>
            <MessageBarActions>
              <Button size="small" icon={<Open16Regular />} onClick={() => void backend.openUrl(R2_URL)}>
                Open R2
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}
        {!pre.subdomain && pre.ready ? (
          <Field
            label="Your workers.dev name"
            hint="Part of the server address. Cloudflare uses the same name for all Workers in this account."
            validationState={subdomain && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ? 'error' : 'none'}
            validationMessage={subdomain && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain) ? 'Use lowercase letters, numbers and dashes.' : undefined}
          >
            <Input value={subdomain} onChange={(_, d) => setSubdomain(d.value.toLowerCase())} contentAfter={<Caption1 className={s.muted}>.workers.dev</Caption1>} />
          </Field>
        ) : null}
        {pre.ready ? (
          <div className={s.box}>
            <Caption1 className={s.muted}>Server address</Caption1>
            <Text className={s.url}>https://{url}</Text>
          </div>
        ) : null}
        {!pre.workerExists ? (
          <>
            <Button
              className={s.toggle}
              appearance="subtle"
              size="small"
              icon={showNames ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
              iconPosition="after"
              onClick={() => setShowNames(!showNames)}
            >
              Names in Cloudflare
            </Button>
            {showNames ? (
              <div className={s.names}>
                <Field label="Server (Worker)" size="small">
                  <Input size="small" value={names.worker} onChange={(_, d) => setNames({ ...names, worker: d.value.toLowerCase() })} />
                </Field>
                <Field label="Database (D1)" size="small">
                  <Input size="small" value={names.database} onChange={(_, d) => setNames({ ...names, database: d.value.toLowerCase() })} />
                </Field>
                <Field label="Storage (R2)" size="small">
                  <Input size="small" value={names.bucket} onChange={(_, d) => setNames({ ...names, bucket: d.value.toLowerCase() })} />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}
        {errorBar}
        <div className={s.actions}>
          <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => setScreen('token')} disabled={busy}>
            Back
          </Button>
          <div className={s.actionsRight}>
            <Button icon={<ArrowClockwise20Regular />} onClick={() => void runPreflight(account, names)} disabled={busy}>
              Check again
            </Button>
            <Button appearance="primary" onClick={deploy} disabled={busy || !pre.ready || (!pre.subdomain && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))}>
              {pre.workerExists ? 'Update server' : 'Set up server'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'run') {
    const shown = [...RUN_ORDER, ...(events.access ? (['access'] as SetupStepId[]) : [])];
    return (
      <div className={s.root}>
        {header}
        <Body1 className={s.body2}>Keep this window open. Each step is safe to repeat if something stops.</Body1>
        <div className={s.checks} role="list" aria-live="polite">
          {shown.map((id) => {
            const ev = events[id];
            return (
              <div key={id} className={s.check} role="listitem">
                <StateIcon state={ev?.state} />
                <div className={s.checkText}>
                  <Text weight={ev?.state === 'running' ? 'semibold' : 'regular'} className={ev ? undefined : s.muted}>
                    {STEP_LABELS[id]}
                  </Text>
                  {ev?.detail ? <Caption1 className={ev.state === 'failed' ? s.detailBad : s.detail}>{ev.detail}</Caption1> : null}
                </div>
              </div>
            );
          })}
        </div>
        {errorBar}
        {!busy && error ? (
          <div className={s.actions}>
            <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => setScreen('confirm')}>
              Back
            </Button>
            <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={deploy}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (screen === 'done' && outcome) {
    const share = (
      <div className={s.box}>
        <Text weight="semibold">Connect the other computers</Text>
        <Caption1 className={s.body2}>
          Install AM Backup on each computer. On the first screen, choose <b>Online server</b> and enter this address:
        </Caption1>
        <div className={s.row}>
          <Text className={s.url}>{outcome.serverUrl}</Text>
          <Button size="small" icon={<Copy20Regular />} onClick={() => (copy(outcome.serverUrl), setUrlCopied(true))}>
            {urlCopied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    );

    if (!outcome.online) {
      return (
        <div className={s.root}>
          {header}
          <Body1 className={s.body2}>
            The server is set up, but its new address does not answer yet. A new Cloudflare address can take a few minutes to start. You can close this window and come back: the
            app remembers the address.
          </Body1>
          {errorBar}
          <div className={s.actions}>
            <span />
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />} onClick={checkAgain} disabled={busy}>
              Check again
            </Button>
          </div>
        </div>
      );
    }

    if (outcome.needsSetup && outcome.setupKey) {
      return (
        <form className={s.root} onSubmit={createAdmin} noValidate>
          {header}
          <Body1 className={s.body2}>The server is ready at {outcome.serverUrl.replace('https://', '')}. Now make the administrator account. The administrator manages users, folders and restores.</Body1>
          <SetupKeyBox
            value={outcome.setupKey}
            intro="Keep a copy of this key in a safe place, for example a password manager. You need it only if the administrator password is lost."
          />
          <div className={s.form}>
            <Field label="Your name">
              <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="Administrator" autoComplete="name" />
            </Field>
            <Field label="Username" required hint="Letters, numbers, dots, dashes and underscores">
              <Input value={username} onChange={(_, d) => setUsername(d.value)} autoComplete="username" spellCheck={false} />
            </Field>
            <Field label="Password" required hint="At least 8 characters">
              <Input type="password" value={password} onChange={(_, d) => setPassword(d.value)} autoComplete="new-password" />
            </Field>
          </div>
          {errorBar}
          <div className={s.actions}>
            <span />
            <Button appearance="primary" type="submit" disabled={busy} icon={busy ? <Spinner size="tiny" /> : undefined}>
              {busy ? 'Creating' : 'Create administrator'}
            </Button>
          </div>
        </form>
      );
    }

    return (
      <div className={s.root}>
        {header}
        <MessageBar intent="success">
          <MessageBarBody>
            {updating ? `The server now runs version ${info?.version ?? ''} from this app.` : 'This account already has an administrator. Sign in with that account.'}
          </MessageBarBody>
        </MessageBar>
        {share}
        <div className={s.actions}>
          <span />
          <Button appearance="primary" onClick={() => (updating ? onClose() : onSignIn?.())}>
            {updating ? 'Done' : 'Go to sign in'}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
