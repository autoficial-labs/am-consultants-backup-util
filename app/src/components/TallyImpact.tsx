// Restore review: what the restore means in Tally terms, from the saved Tally data of the
// companies whose folders are being restored.
import { Body1, Button, Caption1, Spinner, Subtitle2, Text, makeStyles, tokens } from '@fluentui/react-components';
import { BookOpen20Regular } from '@fluentui/react-icons';
import { Panel, useLoader } from './ui';
import { api } from '../lib/backend';
import { count, when } from '../lib/format';
import { diffSnapshots } from '../lib/tally';
import type { FullBackup, RestorePlan, TallyCompanyRow, TallySnapshotData, TallySnapshotRow } from '../lib/types';
import { useApp } from '../state';

const useStyles = makeStyles({
  head: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
  rows: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '12px',
    alignItems: 'center',
    paddingTop: '12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  text: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface Impact {
  company: TallyCompanyRow;
  point: TallySnapshotRow | null;
  latest: TallySnapshotRow;
  removed: number;
  back: number;
  changed: number;
  ledgers: number;
}

/** "today at 4:11 am" inside a sentence. */
const inline = (ms: number) => when(ms).replace(/^(Today|Yesterday)/, (m) => m.toLowerCase());

const unitOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function TallyImpact({ plan }: { plan: RestorePlan }) {
  const s = useStyles();
  const { go } = useApp();

  const impact = useLoader(async (): Promise<Impact[]> => {
    const { companies } = await api<{ companies: TallyCompanyRow[] }>('GET', '/api/tally/companies');
    const touched = new Set(plan.items.filter((i) => i.status !== 'same').map((i) => unitOf(i.path)));
    const relevant = companies.filter((c) => c.folder && [...touched].some((u) => u === c.folder || u.startsWith(`${c.folder}/`))).slice(0, 6);
    if (!relevant.length) return [];
    let at: number;
    if (plan.source.kind === 'pointInTime') at = plan.source.at;
    else {
      const id = plan.source.id;
      const { backups } = await api<{ backups: FullBackup[] }>('GET', '/api/full-backups');
      at = backups.find((b) => b.id === id)?.created_at ?? plan.createdAt;
    }
    const out: Impact[] = [];
    for (const company of relevant) {
      const { snapshots } = await api<{ snapshots: TallySnapshotRow[] }>('GET', `/api/tally/snapshots?company=${encodeURIComponent(company.companyKey)}`);
      if (!snapshots.length) continue;
      const latest = snapshots[0]!;
      const point = snapshots.find((x) => x.capturedAt <= at) ?? null;
      if (!point || point.id === latest.id) {
        out.push({ company, point, latest, removed: 0, back: 0, changed: 0, ledgers: 0 });
        continue;
      }
      const [now, then] = await Promise.all([
        api<TallySnapshotData>('GET', `/api/tally/snapshots/${latest.id}/data`),
        api<TallySnapshotData>('GET', `/api/tally/snapshots/${point.id}/data`),
      ]);
      const d = diffSnapshots(now, then);
      out.push({ company, point, latest, removed: d.removed, back: d.added, changed: d.changed, ledgers: d.ledgers.length });
    }
    return out;
  }, [plan.id]);

  if (impact.loading) {
    return (
      <Panel>
        <Spinner size="tiny" label="Checking the saved Tally data" labelPosition="after" />
      </Panel>
    );
  }
  if (impact.error || !impact.data?.length) return null;
  const changed = impact.data.filter((i) => i.point && i.point.id !== i.latest.id);
  const same = impact.data.filter((i) => i.point && i.point.id === i.latest.id);
  const unknown = impact.data.filter((i) => !i.point);

  return (
    <Panel>
      <div className={s.head}>
        <BookOpen20Regular />
        <Subtitle2 as="h2">In Tally</Subtitle2>
      </div>
      <Caption1 className={s.muted}>From the Tally data saved with the backups. It compares the restored moment with the newest saved Tally data.</Caption1>
      <div className={s.rows} style={{ marginTop: 8 }}>
        {changed.map((i) => {
          const parts: string[] = [];
          if (i.removed) parts.push(`${count(i.removed)} ${i.removed === 1 ? 'voucher' : 'vouchers'} entered later will be gone`);
          if (i.back) parts.push(`${count(i.back)} deleted ${i.back === 1 ? 'voucher comes' : 'vouchers come'} back`);
          if (i.changed) parts.push(`${count(i.changed)} ${i.changed === 1 ? 'voucher goes' : 'vouchers go'} back to an earlier version`);
          if (i.ledgers) parts.push(`${count(i.ledgers)} ledger ${i.ledgers === 1 ? 'balance changes' : 'balances change'}`);
          return (
            <div key={i.company.companyKey} className={s.row}>
              <div className={s.text}>
                <Text weight="semibold">{i.company.companyName}</Text>
                <Body1>
                  The books go back to {inline(i.point!.capturedAt)}. Compared with {inline(i.latest.capturedAt)}: {parts.length ? parts.join('; ') : 'no vouchers change'}.
                </Body1>
              </div>
              <Button onClick={() => go('tally', { kind: 'tallyCompare', companyKey: i.company.companyKey, baseId: i.latest.id, compareId: i.point!.id })}>
                See the vouchers
              </Button>
            </div>
          );
        })}
        {same.length ? (
          <Caption1 className={s.muted}>No voucher changes for {same.map((i) => i.company.companyName).join(', ')}.</Caption1>
        ) : null}
        {unknown.length ? (
          <Caption1 className={s.muted}>No Tally data was saved before this moment for {unknown.map((i) => i.company.companyName).join(', ')}.</Caption1>
        ) : null}
      </div>
    </Panel>
  );
}
