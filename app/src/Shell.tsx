import {
  Avatar,
  Caption1,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  NavDrawer,
  NavDrawerBody,
  NavDrawerFooter,
  NavDrawerHeader,
  NavItem,
  NavSectionHeader,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowCounterclockwise20Filled,
  ArrowCounterclockwise20Regular,
  BookOpen20Filled,
  BookOpen20Regular,
  CloudArrowUp20Filled,
  CloudArrowUp20Regular,
  History20Filled,
  History20Regular,
  Home20Filled,
  Home20Regular,
  Info20Filled,
  Info20Regular,
  People20Filled,
  People20Regular,
  Server20Filled,
  Server20Regular,
  Settings20Filled,
  Settings20Regular,
  SignOut20Regular,
  bundleIcon,
} from '@fluentui/react-icons';
import { lazy, Suspense } from 'react';
import { backend } from './lib/backend';
import { useApp, type PageId } from './state';
import { Loading } from './components/ui';
import { StatusGlyph, phaseInfo } from './components/status';
import { AppMark } from './components/AppMark';

const Overview = lazy(() => import('./pages/Overview'));
const Restore = lazy(() => import('./pages/Restore'));
const History = lazy(() => import('./pages/History'));
const TallyData = lazy(() => import('./pages/TallyData'));
const BackupSettings = lazy(() => import('./pages/BackupSettings'));
const Users = lazy(() => import('./pages/Users'));
const Server = lazy(() => import('./pages/Server'));
const Settings = lazy(() => import('./pages/Settings'));
const About = lazy(() => import('./pages/About'));

const HomeIcon = bundleIcon(Home20Filled, Home20Regular);
const RestoreIcon = bundleIcon(ArrowCounterclockwise20Filled, ArrowCounterclockwise20Regular);
const HistoryIcon = bundleIcon(History20Filled, History20Regular);
const TallyIcon = bundleIcon(BookOpen20Filled, BookOpen20Regular);
const BackupIcon = bundleIcon(CloudArrowUp20Filled, CloudArrowUp20Regular);
const UsersIcon = bundleIcon(People20Filled, People20Regular);
const ServerIcon = bundleIcon(Server20Filled, Server20Regular);
const SettingsIcon = bundleIcon(Settings20Filled, Settings20Regular);
const AboutIcon = bundleIcon(Info20Filled, Info20Regular);

const useStyles = makeStyles({
  shell: { display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground2 },
  nav: { flexShrink: 0, borderRight: `1px solid ${tokens.colorNeutralStroke2}` },
  brand: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 4px 2px' },
  brandText: { display: 'flex', flexDirection: 'column', lineHeight: 1.15 },
  brandSub: { color: tokens.colorNeutralForeground3 },
  main: { flex: 1, minWidth: 0, height: '100%' },
  footer: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 4px 12px' },
  statusLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
  statusText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 },
  user: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    width: '100%',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}` },
  },
});

export function Shell() {
  const s = useStyles();
  const app = useApp();
  const { page, go, config, status, isAdmin, canWrite } = app;
  const user = config.user!;
  const info = phaseInfo(status);

  const signOut = async () => {
    await backend.logout();
    await app.refreshConfig();
  };

  const content = (() => {
    switch (page) {
      case 'restore':
        return <Restore />;
      case 'history':
        return <History />;
      case 'tally':
        return <TallyData />;
      case 'backup':
        return <BackupSettings />;
      case 'users':
        return <Users />;
      case 'server':
        return <Server />;
      case 'settings':
        return <Settings />;
      case 'about':
        return <About />;
      default:
        return <Overview />;
    }
  })();

  return (
    <div className={s.shell}>
      <NavDrawer
        open
        type="inline"
        className={`${s.nav} app-chrome`}
        selectedValue={page}
        onNavItemSelect={(_, d) => go(d.value as PageId)}
        density="medium"
      >
        <NavDrawerHeader>
          <div className={s.brand}>
            <AppMark size={32} />
            <div className={s.brandText}>
              <Text weight="semibold" size={400}>
                AM Backup
              </Text>
              <Caption1 className={s.brandSub}>Tally data protection</Caption1>
            </div>
          </div>
        </NavDrawerHeader>
        <NavDrawerBody>
          <NavItem value="overview" icon={<HomeIcon />}>
            Overview
          </NavItem>
          <NavItem value="restore" icon={<RestoreIcon />}>
            Restore files
          </NavItem>
          <NavItem value="history" icon={<HistoryIcon />}>
            Backup history
          </NavItem>
          <NavItem value="tally" icon={<TallyIcon />}>
            Tally data
          </NavItem>
          {canWrite || isAdmin ? <NavSectionHeader>Manage</NavSectionHeader> : null}
          {canWrite ? (
            <NavItem value="backup" icon={<BackupIcon />}>
              Backup settings
            </NavItem>
          ) : null}
          {isAdmin ? (
            <NavItem value="users" icon={<UsersIcon />}>
              Users & access
            </NavItem>
          ) : null}
          {isAdmin ? (
            <NavItem value="server" icon={<ServerIcon />}>
              Server
            </NavItem>
          ) : null}
          <NavSectionHeader>App</NavSectionHeader>
          <NavItem value="settings" icon={<SettingsIcon />}>
            Settings
          </NavItem>
          <NavItem value="about" icon={<AboutIcon />}>
            About
          </NavItem>
        </NavDrawerBody>
        <NavDrawerFooter>
          <div className={s.footer}>
            <button type="button" className={s.statusLine} onClick={() => go('overview')} aria-label={`Backup status: ${info.title}`}>
              <StatusGlyph status={status} size={20} />
              <span className={s.statusText}>
                <Text size={200} weight="semibold">
                  {info.title}
                </Text>
                <Caption1 className={s.ellipsis}>{info.short}</Caption1>
              </span>
            </button>
            <Menu positioning="above-start">
              <MenuTrigger disableButtonEnhancement>
                <button type="button" className={s.user} aria-label={`Account: ${user.displayName}`}>
                  <Avatar name={user.displayName} size={28} color="colorful" />
                  <span className={s.statusText}>
                    <Text size={200} weight="semibold" truncate wrap={false}>
                      {user.displayName}
                    </Text>
                    <Caption1 className={s.ellipsis}>
                      {isAdmin ? 'Administrator' : user.access === 'write' ? 'Can back up and restore' : 'Can restore'}
                    </Caption1>
                  </span>
                </button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<SettingsIcon />} onClick={() => go('settings')}>
                    Account settings
                  </MenuItem>
                  <MenuItem icon={<SignOut20Regular />} onClick={signOut}>
                    Sign out
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        </NavDrawerFooter>
      </NavDrawer>
      <main className={s.main}>
        <Suspense fallback={<Loading />}>{content}</Suspense>
      </main>
    </div>
  );
}
