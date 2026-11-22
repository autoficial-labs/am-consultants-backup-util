import { Body1, Caption1, Link, Subtitle2, Text, Title2, makeStyles, tokens } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { AppMark } from '../components/AppMark';
import { Page, Panel } from '../components/ui';
import { backend } from '../lib/backend';
import { useApp } from '../state';

const useStyles = makeStyles({
  hero: { display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' },
  heroText: { display: 'flex', flexDirection: 'column', gap: '6px' },
  muted: { color: tokens.colorNeutralForeground3 },
  credit: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    flexWrap: 'wrap',
  },
  creditText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  facts: { display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', rowGap: '10px', columnGap: '16px' },
  how: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: tokens.colorNeutralForeground2, maxWidth: '72ch' },
});

export default function About() {
  const s = useStyles();
  const { info, config } = useApp();
  return (
    <Page>
      <div className={s.hero}>
        <AppMark size={72} />
        <div className={s.heroText}>
          <Title2 as="h1">AM Backup</Title2>
          <Body1 className={s.muted}>Backup and restore for Tally data folders · Version {info?.version ?? '1.0.0'}</Body1>
        </div>
      </div>

      <Panel>
        <div className={s.credit}>
          <div className={s.creditText}>
            <Subtitle2 as="h2">Developed by AFLABS</Subtitle2>
            <Caption1 className={s.muted}>Made for AM True Tax.</Caption1>
          </div>
          <Link as="button" onClick={() => void backend.openUrl('https://autoficial.ltd')}>
            autoficial.ltd <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
          </Link>
        </div>
      </Panel>

      <Panel>
        <Subtitle2 as="h2" style={{ display: 'block', marginBottom: 12 }}>
          How your files are protected
        </Subtitle2>
        <ul className={s.how}>
          <li>New and changed files are uploaded to your Cloudflare storage shortly after they're saved. Files that haven't changed are never sent twice.</li>
          <li>Tally can stay open all day. Backups run when Tally hasn't saved anything for a few minutes, and each copy is checked, so company files are never copied half-written.</li>
          <li>Each version is kept, so you can restore everything as it was at any moment in the history window.</li>
          <li>Complete backups add a highly compressed copy of the whole folder on the schedule you choose.</li>
          <li>Nothing is overwritten during a restore until you've reviewed the differences and confirmed.</li>
        </ul>
      </Panel>

      <Panel>
        <Subtitle2 as="h2" style={{ display: 'block', marginBottom: 12 }}>
          This installation
        </Subtitle2>
        <div className={s.facts}>
          <Caption1 className={s.muted}>Server</Caption1>
          <Text className="selectable">{config.serverUrl}</Text>
          <Caption1 className={s.muted}>Computer</Caption1>
          <Text>{config.deviceName}</Text>
          <Caption1 className={s.muted}>System</Caption1>
          <Text>{info?.os ?? '—'}</Text>
          <Caption1 className={s.muted}>App data</Caption1>
          <Text className="selectable" style={{ wordBreak: 'break-all' }}>
            {info?.dataDir ?? '—'}
          </Text>
        </div>
      </Panel>

      <Caption1 className={s.muted}>
        © 2026–2027{' '}
        <Link as="button" onClick={() => void backend.openUrl('https://autoficial.ltd')}>
          AFLABS
        </Link>
      </Caption1>
    </Page>
  );
}
