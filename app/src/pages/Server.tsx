// Administrator page for the Cloudflare server: status, version, how other computers connect,
// and "Update server" (the built-in setup, run again with the server program in this app).
import { Badge, Button, Caption1, DrawerBody, OverlayDrawer, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  Building20Regular,
  Copy20Regular,
  Database20Regular,
  Globe20Regular,
  Open16Regular,
  PlugConnected20Regular,
  Server20Regular,
  Storage20Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import { ServerSetup } from '../components/ServerSetup';
import { Group, Page, PageHeader, Panel, Row, useLoader } from '../components/ui';
import { backend } from '../lib/backend';
import { when } from '../lib/format';
import { useApp } from '../state';

const DASHBOARD_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

const useStyles = makeStyles({
  inline: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
  url: { fontFamily: tokens.fontFamilyMonospace, overflowWrap: 'anywhere' },
  steps: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: tokens.colorNeutralForeground2 },
  muted: { color: tokens.colorNeutralForeground3 },
  drawer: { padding: '28px 28px 32px' },
});

export default function Server() {
  const s = useStyles();
  const { config, refreshConfig } = useApp();
  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = config.serverUrl ?? '';
  const deploy = config.serverDeploy?.url === url ? config.serverDeploy : null;
  const local = url.includes('localhost') || url.includes('127.0.0.1');

  const info = useLoader(() => backend.serverSetupInfo(), []);
  const health = useLoader(() => backend.checkServer(url), [url]);

  const running = health.data?.build ?? null;
  const bundled = info.data?.build ?? null;
  const upToDate = Boolean(running && bundled && running === bundled);

  const programStatus = local
    ? 'This is the test server on this computer. It runs the server program from the project folder.'
    : health.loading
    ? 'Checking…'
    : health.error
      ? 'Not known while the server does not answer.'
      : upToDate
        ? `Up to date (version ${info.data?.version ?? ''}).`
        : running
          ? `This app has a newer server program (version ${info.data?.version ?? ''}). Update to get the newest fixes.`
          : 'The version is not known: the server was set up without this app. Update it once to manage it from here.';

  const copyUrl = () => {
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    setCopied(true);
  };

  return (
    <Page>
      <PageHeader title="Server" description="The AM Backup server in your office's Cloudflare account. Every computer connects to it to back up and restore." />

      <Group title="Status">
        <Row
          icon={<Globe20Regular />}
          label="Address"
          description={<span className={`${s.url} selectable`}>{url}</span>}
          control={
            <Button icon={<Copy20Regular />} onClick={copyUrl}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          }
        />
        <Row
          icon={<PlugConnected20Regular />}
          label="Connection"
          description={
            health.loading ? 'Checking…' : health.error ? health.error : `Answering normally${health.data?.environment === 'local' ? ' (test server on this computer)' : ''}.`
          }
          control={
            health.loading ? (
              <Spinner size="tiny" />
            ) : health.error ? (
              <div className={s.inline}>
                <Badge appearance="tint" color="danger">
                  Not answering
                </Badge>
                <Button onClick={() => void health.reload()}>Try again</Button>
              </div>
            ) : (
              <Badge appearance="tint" color="success">
                Online
              </Badge>
            )
          }
        />
        <Row
          icon={<ArrowSync20Regular />}
          label="Server program"
          description={programStatus}
          control={
            local ? (
              <Caption1 className={s.muted}>Test server</Caption1>
            ) : (
              <Button appearance={upToDate || health.loading ? 'secondary' : 'primary'} onClick={() => setUpdating(true)}>
                Update server
              </Button>
            )
          }
        />
      </Group>

      <Group title="Connect other computers" description="Each person needs their own user account. Make accounts in Users & access.">
        <Panel>
          <ol className={s.steps}>
            <li>Install AM Backup on the computer.</li>
            <li>
              On the first screen, choose <b>Online server</b> and enter the address <span className={`${s.url} selectable`}>{url.replace(/^https?:\/\//, '')}</span>.
            </li>
            <li>Sign in with the user account you made for that person.</li>
          </ol>
        </Panel>
      </Group>

      {!local ? (
        <Group
          title="Cloudflare"
          description={
            deploy
              ? `Set up from this computer ${when(deploy.deployedAt)}. The Cloudflare token is not saved; the app asks for one again when you update.`
              : 'This computer did not set up the server, so it does not know the Cloudflare details. Update the server once to show them here.'
          }
          aside={
            <Button appearance="subtle" size="small" icon={<Open16Regular />} iconPosition="after" onClick={() => void backend.openUrl(DASHBOARD_URL)}>
              Open Cloudflare
            </Button>
          }
        >
          {deploy ? (
            <>
              <Row icon={<Building20Regular />} label="Account" description={deploy.accountName} />
              <Row icon={<Server20Regular />} label="Server program (Worker)" description={deploy.worker} />
              <Row icon={<Database20Regular />} label="Database (D1)" description={deploy.database} />
              <Row icon={<Storage20Regular />} label="File storage (R2)" description={deploy.bucket} />
            </>
          ) : null}
          <Caption1 className={s.muted} style={{ marginTop: 8 }}>
            To use your own domain name, add a Custom Domain to the Worker in Cloudflare. Then sign in again on each computer with the new address.
          </Caption1>
        </Group>
      ) : null}

      <OverlayDrawer open={updating} position="end" size="medium" onOpenChange={(_, d) => !d.open && setUpdating(false)}>
        <DrawerBody className={s.drawer}>
          {updating ? (
            <ServerSetup
              onClose={() => {
                setUpdating(false);
                void refreshConfig();
                void health.reload();
              }}
              onSignIn={() => setUpdating(false)}
            />
          ) : null}
        </DrawerBody>
      </OverlayDrawer>
    </Page>
  );
}
