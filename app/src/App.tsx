import {
  FluentProvider,
  Spinner,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backend, errorMessage, listen } from './lib/backend';
import type { AppInfo, ConfigView, EngineStatus } from './lib/types';
import { AppContext, EMPTY_STATUS, type AppContextValue, type PageId, type RestoreIntent } from './state';
import { darkTheme, lightTheme } from './theme';
import { AuthScreen } from './pages/Auth';
import { Shell } from './Shell';

const useStyles = makeStyles({
  boot: {
    height: '100vh',
    display: 'grid',
    placeItems: 'center',
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

function useSystemDark() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

function Root({ config, setConfig, info, dark }: { config: ConfigView; setConfig: (c: ConfigView) => void; info: AppInfo | null; dark: boolean }) {
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS);
  const [page, setPage] = useState<PageId>('overview');
  const [intent, setIntent] = useState<RestoreIntent | null>(null);
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null);

  const notify = useCallback<AppContextValue['notify']>(
    (kind, title, body) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{title}</ToastTitle>
          {body ? <ToastBody>{body}</ToastBody> : null}
        </Toast>,
        { intent: kind, timeout: kind === 'error' ? 8000 : 4000, position: 'bottom-end' },
      );
    },
    [dispatchToast],
  );

  const refreshConfig = useCallback(async () => {
    setConfig(await backend.getConfig());
  }, [setConfig]);

  // Engine status: pushed by events, with a slow poll as a safety net.
  useEffect(() => {
    let alive = true;
    const unsubs: (() => void)[] = [];
    backend.engineStatus().then((s) => alive && setStatus(s), () => {});
    listen<EngineStatus>('engine-status', (s) => alive && setStatus(s)).then((u) => unsubs.push(u));
    listen<string>('session-expired', (reason) => {
      if (!alive) return;
      setExpiredMessage(reason);
      void backend.getConfig().then(setConfig);
    }).then((u) => unsubs.push(u));
    const poll = window.setInterval(() => {
      backend.engineStatus().then((s) => alive && setStatus(s), () => {});
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      unsubs.forEach((u) => u());
    };
  }, [setConfig]);

  const go = useCallback((p: PageId, i: RestoreIntent | null = null) => {
    setIntent(i);
    setPage(p);
  }, []);

  const user = config.user;
  const isAdmin = user?.role === 'superadmin';
  const canWrite = Boolean(user && (isAdmin || (user.access === 'write' && user.scopeMode !== 'none')));

  // Keep the page valid for the role (e.g. after signing in as a different user).
  useEffect(() => {
    if (!isAdmin && (page === 'users' || (page === 'backup' && !canWrite))) setPage('overview');
  }, [isAdmin, canWrite, page]);

  const value = useMemo<AppContextValue>(
    () => ({ config, status, info, dark, page, intent, go, setConfig, refreshConfig, setStatus, notify, isAdmin, canWrite }),
    [config, status, info, dark, page, intent, go, setConfig, refreshConfig, notify, isAdmin, canWrite],
  );

  return (
    <AppContext.Provider value={value}>
      {config.signedIn && config.serverUrl ? (
        <Shell />
      ) : (
        <AuthScreen
          expiredMessage={expiredMessage}
          onSignedIn={(c) => {
            setExpiredMessage(null);
            setConfig(c);
            setPage('overview');
          }}
        />
      )}
      <Toaster toasterId={toasterId} position="bottom-end" />
    </AppContext.Provider>
  );
}

export function App() {
  const styles = useStyles();
  const systemDark = useSystemDark();
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const readySent = useRef(false);

  useEffect(() => {
    backend.getConfig().then(setConfig, (e) => setBootError(errorMessage(e)));
    backend.appInfo().then(setInfo, () => {});
  }, []);

  useEffect(() => {
    if ((config || bootError) && !readySent.current) {
      readySent.current = true;
      requestAnimationFrame(() => void backend.appReady().catch(() => {}));
    }
  }, [config, bootError]);

  const dark = config?.theme === 'dark' || (config?.theme !== 'light' && systemDark);
  const theme = dark ? darkTheme : lightTheme;

  return (
    <FluentProvider theme={theme} style={{ height: '100%', background: tokens.colorNeutralBackground2 }}>
      {config ? (
        <Root config={config} setConfig={setConfig} info={info} dark={dark} />
      ) : (
        <div className={styles.boot} role="status" aria-live="polite">
          {bootError ? <span>{bootError}</span> : <Spinner label="Starting AM Backup" />}
        </div>
      )}
    </FluentProvider>
  );
}
