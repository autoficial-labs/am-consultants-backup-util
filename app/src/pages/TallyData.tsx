// Tally data: companies, ledgers and vouchers saved with the backups (read from Tally's XML
// server at backup time), with a comparison of two moments, or of a moment and Tally now.
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  Option,
  OptionGroup,
  SearchBox,
  Spinner,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Add16Regular,
  ArrowRight16Regular,
  ArrowSwap20Regular,
  BookOpen24Regular,
  Camera20Regular,
  Edit16Regular,
  PlugConnected20Regular,
  PlugDisconnected20Regular,
  Subtract16Regular,
} from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Group, Loading, Page, PageHeader, Panel, useLoader } from '../components/ui';
import { api, backend, errorMessage } from '../lib/backend';
import { count, when } from '../lib/format';
import { amount, balance, balanceDelta, cashAndBank, diffSnapshots, tallyDate, totalsByType, type VoucherChange } from '../lib/tally';
import type { TallyCompanyRow, TallySnapshotData, TallySnapshotRow } from '../lib/types';
import { diffColors } from '../theme';
import { useApp } from '../state';

const PAGE = 200;
type TabId = 'summary' | 'vouchers' | 'ledgers' | 'changes';
type Target = number | 'live' | null;

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  label: { color: tokens.colorNeutralForeground3 },
  pick: { minWidth: '240px', maxWidth: '100%' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '14px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  tileValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', alignItems: 'start' },
  tools: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  numHead: { '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end', textAlign: 'right' } },
  muted: { color: tokens.colorNeutralForeground3 },
  narr: { color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '320px' },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '10px' },
  status: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  dot: { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 },
  kind: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  from: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: tokens.colorNeutralForeground2 },
  steps: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px', color: tokens.colorNeutralForeground2, textAlign: 'left' },
  help: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '72ch' },
  strike: { textDecorationLine: 'line-through', color: tokens.colorNeutralForeground3 },
  scroll: { overflowX: 'auto' },
});

const dataCache = new Map<number, Promise<TallySnapshotData>>();
function loadSnapshot(id: number) {
  if (!dataCache.has(id)) {
    const p = api<TallySnapshotData>('GET', `/api/tally/snapshots/${id}/data`);
    p.catch(() => dataCache.delete(id));
    dataCache.set(id, p);
  }
  return dataCache.get(id)!;
}

function snapshotLabel(s: TallySnapshotRow) {
  return `${when(s.capturedAt)} · ${count(s.vouchers)} vouchers`;
}

export function TallyHelp() {
  const s = useStyles();
  return (
    <div className={s.help}>
      <Body1>AM Backup reads Tally data through Tally's XML server, on the computer where Tally runs. Turn it on one time:</Body1>
      <ol className={s.steps}>
        <li>
          <b>TallyPrime:</b> press F1 (Help) › Settings › Connectivity › Client/Server configuration. Set <b>TallyPrime acts as</b> to <b>Both</b> and <b>Port</b> to 9000.
        </li>
        <li>
          <b>Tally.ERP 9:</b> press F12 (Configure) › Advanced Configuration. Set <b>Tally.ERP 9 is acting as</b> to <b>Both</b> and <b>Port</b> to 9000.
        </li>
        <li>Accept the change and restart Tally. Keep the companies open as usual.</li>
      </ol>
      <Caption1 className={s.muted}>
        After that, AM Backup saves the companies' ledgers and vouchers each time it backs up their files (at most once an hour per company). Data from before that day is not
        available.
      </Caption1>
    </div>
  );
}

function VoucherTable({ vouchers }: { vouchers: TallySnapshotData['vouchers'] }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [type, setType] = useState<string>('all');
  const [rows, setRows] = useState(PAGE);
  const types = useMemo(() => [...new Set(vouchers.map((v) => v.type))].sort(), [vouchers]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...vouchers]
      .reverse()
      .filter((v) => (type === 'all' || v.type === type) && (!needle || `${v.party} ${v.number} ${v.narration} ${v.type}`.toLowerCase().includes(needle)));
  }, [vouchers, q, type]);
  return (
    <>
      <div className={s.tools}>
        <SearchBox placeholder="Search party, number or narration" value={q} onChange={(_, d) => (setQ(d.value), setRows(PAGE))} style={{ minWidth: 280 }} />
        <Dropdown
          aria-label="Voucher type"
          value={type === 'all' ? 'All voucher types' : type}
          selectedOptions={[type]}
          onOptionSelect={(_, d) => (setType(d.optionValue ?? 'all'), setRows(PAGE))}
          style={{ minWidth: 200 }}
        >
          <Option value="all">All voucher types</Option>
          {types.map((t) => (
            <Option key={t} value={t}>
              {t}
            </Option>
          ))}
        </Dropdown>
        <Caption1 className={s.muted}>{count(list.length)} vouchers</Caption1>
      </div>
      <div className={s.scroll}>
        <Table size="small" aria-label="Vouchers">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 110 }}>Date</TableHeaderCell>
              <TableHeaderCell style={{ width: 120 }}>Type</TableHeaderCell>
              <TableHeaderCell style={{ width: 70 }}>No.</TableHeaderCell>
              <TableHeaderCell>Party</TableHeaderCell>
              <TableHeaderCell style={{ width: 130 }} className={s.numHead}>
                Amount
              </TableHeaderCell>
              <TableHeaderCell>Narration</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.slice(0, rows).map((v) => (
              <TableRow key={v.guid}>
                <TableCell>{tallyDate(v.date)}</TableCell>
                <TableCell>
                  {v.type}
                  {v.cancelled ? (
                    <Badge size="small" appearance="tint" color="subtle" style={{ marginLeft: 6 }}>
                      Cancelled
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{v.number}</TableCell>
                <TableCell>{v.party || '—'}</TableCell>
                <TableCell className={mergeClasses(s.num, v.cancelled && s.strike)}>{amount(v.amount)}</TableCell>
                <TableCell>
                  <span className={s.narr} title={v.narration}>
                    {v.narration}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {list.length > rows ? (
        <div className={s.more}>
          <Button onClick={() => setRows(rows + PAGE)}>Show {Math.min(PAGE, list.length - rows)} more</Button>
        </div>
      ) : null}
    </>
  );
}

function LedgerTable({ ledgers }: { ledgers: TallySnapshotData['ledgers'] }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const groups = useMemo(() => [...new Set(ledgers.map((l) => l.group))].sort(), [ledgers]);
  const list = ledgers.filter((l) => (group === 'all' || l.group === group) && (!q.trim() || l.name.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <>
      <div className={s.tools}>
        <SearchBox placeholder="Search ledgers" value={q} onChange={(_, d) => setQ(d.value)} style={{ minWidth: 240 }} />
        <Dropdown aria-label="Group" value={group === 'all' ? 'All groups' : group} selectedOptions={[group]} onOptionSelect={(_, d) => setGroup(d.optionValue ?? 'all')} style={{ minWidth: 200 }}>
          <Option value="all">All groups</Option>
          {groups.map((g) => (
            <Option key={g} value={g}>
              {g}
            </Option>
          ))}
        </Dropdown>
        <Caption1 className={s.muted}>{count(list.length)} ledgers</Caption1>
      </div>
      <div className={s.scroll}>
        <Table size="small" aria-label="Ledgers">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Ledger</TableHeaderCell>
              <TableHeaderCell>Group</TableHeaderCell>
              <TableHeaderCell className={s.numHead}>Opening balance</TableHeaderCell>
              <TableHeaderCell className={s.numHead}>Closing balance</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((l) => (
              <TableRow key={l.name}>
                <TableCell>{l.name}</TableCell>
                <TableCell className={s.muted}>{l.group}</TableCell>
                <TableCell className={s.num}>{balance(l.opening)}</TableCell>
                <TableCell className={s.num}>{balance(l.closing)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

const KIND_META = {
  added: { label: 'Added', icon: <Add16Regular />, color: 'restore' as const },
  changed: { label: 'Changed', icon: <Edit16Regular />, color: 'overwrite' as const },
  removed: { label: 'Removed', icon: <Subtract16Regular />, color: 'extra' as const },
};

export function Changes({ from, to, fromLabel, toLabel, onSwap }: { from: TallySnapshotData; to: TallySnapshotData; fromLabel: string; toLabel: string; onSwap?: () => void }) {
  const s = useStyles();
  const { dark } = useApp();
  const palette = dark ? diffColors.dark : diffColors.light;
  const diff = useMemo(() => diffSnapshots(from, to), [from, to]);
  const [rows, setRows] = useState(PAGE);
  const v = (c: VoucherChange) => (c.after ?? c.before)!;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className={s.from}>
        <Text weight="semibold">{fromLabel}</Text>
        <ArrowRight16Regular />
        <Text weight="semibold">{toLabel}</Text>
        {onSwap ? (
          <Tooltip content="Swap the two moments" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSwap20Regular />} onClick={onSwap} />
          </Tooltip>
        ) : null}
      </div>
      <div className={s.chips}>
        {(['added', 'changed', 'removed'] as const).map((k) => (
          <span key={k} className={s.chip}>
            <span className={s.dot} style={{ backgroundColor: palette[KIND_META[k].color] }} />
            <Text weight="semibold">{count(diff[k])}</Text>
            <Caption1>{KIND_META[k].label.toLowerCase()} vouchers</Caption1>
          </span>
        ))}
        <span className={s.chip}>
          <span className={s.dot} style={{ backgroundColor: palette.same }} />
          <Text weight="semibold">{count(diff.ledgers.length)}</Text>
          <Caption1>ledger balances changed</Caption1>
        </span>
      </div>

      {diff.vouchers.length === 0 && diff.ledgers.length === 0 ? (
        <Panel>
          <Body1>No differences. The vouchers and ledger balances are the same at both moments.</Body1>
        </Panel>
      ) : null}

      {diff.vouchers.length ? (
        <Group title="Vouchers">
          <div className={s.scroll}>
            <Table size="small" aria-label="Changed vouchers">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: 110 }}>Change</TableHeaderCell>
                  <TableHeaderCell style={{ width: 110 }}>Date</TableHeaderCell>
                  <TableHeaderCell style={{ width: 150 }}>Voucher</TableHeaderCell>
                  <TableHeaderCell>Party</TableHeaderCell>
                  <TableHeaderCell className={s.numHead} style={{ width: 210 }}>
                    Amount
                  </TableHeaderCell>
                  <TableHeaderCell>What changed</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.vouchers.slice(0, rows).map((c) => (
                  <TableRow key={`${c.kind}-${v(c).guid}`}>
                    <TableCell>
                      <span className={s.kind} style={{ color: palette[KIND_META[c.kind].color] }}>
                        {KIND_META[c.kind].icon}
                        {KIND_META[c.kind].label}
                      </span>
                    </TableCell>
                    <TableCell>{tallyDate(v(c).date)}</TableCell>
                    <TableCell>
                      {v(c).type} {v(c).number}
                    </TableCell>
                    <TableCell>{v(c).party || '—'}</TableCell>
                    <TableCell className={s.num}>
                      {c.kind === 'changed' && c.fields.includes('amount') ? (
                        <>
                          <span className={s.strike}>{amount(c.before!.amount)}</span> {amount(c.after!.amount)}
                        </>
                      ) : (
                        amount(v(c).amount)
                      )}
                    </TableCell>
                    <TableCell className={s.muted}>{c.kind === 'changed' ? (c.fields.length ? c.fields.join(', ') : 'saved again, same values') : v(c).narration}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {diff.vouchers.length > rows ? (
            <div className={s.more}>
              <Button onClick={() => setRows(rows + PAGE)}>Show more</Button>
            </div>
          ) : null}
        </Group>
      ) : null}

      {diff.ledgers.length ? (
        <Group title="Ledger balances">
          <div className={s.scroll}>
            <Table size="small" aria-label="Changed ledger balances">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Ledger</TableHeaderCell>
                  <TableHeaderCell>Group</TableHeaderCell>
                  <TableHeaderCell className={s.numHead}>Before</TableHeaderCell>
                  <TableHeaderCell className={s.numHead}>After</TableHeaderCell>
                  <TableHeaderCell className={s.numHead}>Change</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.ledgers.map((l) => (
                  <TableRow key={l.name}>
                    <TableCell>{l.name}</TableCell>
                    <TableCell className={s.muted}>{l.group}</TableCell>
                    <TableCell className={s.num}>{l.before === null ? 'Not there' : balance(l.before)}</TableCell>
                    <TableCell className={s.num}>{l.after === null ? 'Not there' : balance(l.after)}</TableCell>
                    <TableCell className={s.num}>{balanceDelta(l.before ?? 0, l.after ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Group>
      ) : null}
    </div>
  );
}

export default function TallyData() {
  const s = useStyles();
  const { intent, canWrite, notify } = useApp();
  const compareIntent = intent?.kind === 'tallyCompare' ? intent : null;
  const companies = useLoader(() => api<{ companies: TallyCompanyRow[] }>('GET', '/api/tally/companies').then((r) => r.companies), []);
  const check = useLoader(() => backend.tallyCheck(), []);
  const [companyKey, setCompanyKey] = useState<string | null>(compareIntent?.companyKey ?? null);
  const [baseId, setBaseId] = useState<number | null>(compareIntent?.baseId ?? null);
  const [target, setTarget] = useState<Target>(compareIntent?.compareId ?? null);
  const [tab, setTab] = useState<TabId>(compareIntent ? 'changes' : 'summary');
  // asc: older moment first (what happened since); desc: newer first (what a restore would undo).
  const [order, setOrder] = useState<'asc' | 'desc'>(compareIntent ? 'desc' : 'asc');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!compareIntent) return;
    setCompanyKey(compareIntent.companyKey);
    setBaseId(compareIntent.baseId);
    setTarget(compareIntent.compareId);
    setTab('changes');
    setOrder('desc');
  }, [compareIntent]);

  useEffect(() => {
    if (!companyKey && companies.data?.length) setCompanyKey(companies.data[0]!.companyKey);
  }, [companies.data, companyKey]);

  const company = companies.data?.find((c) => c.companyKey === companyKey) ?? null;
  const snapshots = useLoader(
    () => (companyKey ? api<{ snapshots: TallySnapshotRow[] }>('GET', `/api/tally/snapshots?company=${encodeURIComponent(companyKey)}`).then((r) => r.snapshots) : Promise.resolve([])),
    [companyKey],
  );
  useEffect(() => {
    const list = snapshots.data;
    if (list?.length && (baseId === null || !list.some((x) => x.id === baseId))) setBaseId(list[0]!.id);
  }, [snapshots.data, baseId]);

  const live = check.data?.reachable ? check.data.companies.find((c) => c.number === companyKey || c.name === company?.companyName) : undefined;
  const base = useLoader(() => (baseId ? loadSnapshot(baseId) : Promise.resolve(null)), [baseId]);
  const other = useLoader(
    () => (target === 'live' && live ? backend.tallyLive(live.number ?? live.name) : typeof target === 'number' ? loadSnapshot(target) : Promise.resolve(null)),
    [target, live?.name],
  );

  const row = (id: number | null) => snapshots.data?.find((x) => x.id === id) ?? null;
  const baseRow = row(baseId);
  const targetLabel = target === 'live' ? 'Tally now' : row(typeof target === 'number' ? target : null) ? when(row(target as number)!.capturedAt) : '';

  const saveNow = async () => {
    setSaving(true);
    try {
      const saved = await backend.tallyCaptureNow();
      const recorded = saved.filter((x) => x.recorded);
      notify(
        'success',
        recorded.length ? `Saved Tally data of ${recorded.length} ${recorded.length === 1 ? 'company' : 'companies'}` : 'No changes in Tally since the last snapshot',
        saved.map((x) => x.companyName).join(', '),
      );
      await companies.reload();
      await snapshots.reload();
    } catch (e) {
      notify('error', 'Could not save Tally data', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const connection = check.loading ? (
    <Spinner size="tiny" label="Looking for Tally" />
  ) : check.data?.reachable ? (
    <Badge appearance="tint" color="success" icon={<PlugConnected20Regular />}>
      Connected to Tally (port {check.data.port})
    </Badge>
  ) : (
    <Tooltip content={check.data?.error ?? 'Tally is not answering on this computer.'} relationship="description">
      <Badge appearance="tint" color="subtle" icon={<PlugDisconnected20Regular />}>
        Tally not connected
      </Badge>
    </Tooltip>
  );

  const actions = (
    <div className={s.status}>
      {connection}
      {canWrite && check.data?.reachable ? (
        <Button icon={saving ? <Spinner size="tiny" /> : <Camera20Regular />} onClick={saveNow} disabled={saving}>
          Save Tally data now
        </Button>
      ) : null}
    </div>
  );

  if (companies.loading && !companies.data) return <Loading label="Loading Tally data" />;

  if (!companies.data?.length) {
    return (
      <Page>
        <PageHeader title="Tally data" description="Companies, ledgers and vouchers saved with your backups." actions={actions} />
        {companies.error ? (
          <Panel>
            <Body1>{companies.error}</Body1>
          </Panel>
        ) : (
          <EmptyState
            icon={<BookOpen24Regular />}
            title="No Tally data saved yet"
            body={<TallyHelp />}
            action={
              <Button onClick={() => void check.reload()} disabled={check.loading}>
                Check the connection again
              </Button>
            }
          />
        )}
      </Page>
    );
  }

  const data = base.data;
  return (
    <Page>
      <PageHeader title="Tally data" description="Companies, ledgers and vouchers as Tally had them when each backup was made. Compare two moments to see what changed." actions={actions} />

      <div className={s.bar}>
        <div className={s.field}>
          <Caption1 className={s.label}>Company</Caption1>
          <Dropdown
            className={s.pick}
            aria-label="Company"
            value={company?.companyName ?? ''}
            selectedOptions={companyKey ? [companyKey] : []}
            onOptionSelect={(_, d) => {
              setCompanyKey(d.optionValue ?? null);
              setBaseId(null);
              setTarget(null);
            }}
          >
            {companies.data.map((c) => (
              <Option key={c.companyKey} value={c.companyKey} text={c.companyName}>
                {c.companyName}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Caption1 className={s.label}>Moment</Caption1>
          <Dropdown
            className={s.pick}
            aria-label="Moment"
            value={baseRow ? snapshotLabel(baseRow) : ''}
            selectedOptions={baseId ? [String(baseId)] : []}
            onOptionSelect={(_, d) => setBaseId(Number(d.optionValue))}
            disabled={!snapshots.data?.length}
          >
            {(snapshots.data ?? []).map((x) => (
              <Option key={x.id} value={String(x.id)} text={snapshotLabel(x)}>
                {snapshotLabel(x)}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={s.field}>
          <Caption1 className={s.label}>Compare with</Caption1>
          <Dropdown
            className={s.pick}
            aria-label="Compare with"
            value={target === null ? 'Nothing' : target === 'live' ? 'Tally now (live)' : targetLabel}
            selectedOptions={[String(target)]}
            onOptionSelect={(_, d) => {
              const v = d.optionValue === 'null' ? null : d.optionValue === 'live' ? 'live' : Number(d.optionValue);
              setTarget(v);
              setTab(v === null ? 'summary' : 'changes');
            }}
          >
            <Option value="null">Nothing</Option>
            {live ? <Option value="live">Tally now (live)</Option> : null}
            <OptionGroup label="Saved moments">
              {(snapshots.data ?? [])
                .filter((x) => x.id !== baseId)
                .map((x) => (
                  <Option key={x.id} value={String(x.id)} text={when(x.capturedAt)}>
                    {snapshotLabel(x)}
                  </Option>
                ))}
            </OptionGroup>
          </Dropdown>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)}>
        <Tab value="summary">Summary</Tab>
        <Tab value="vouchers">Vouchers{data ? ` (${count(data.vouchers.length)})` : ''}</Tab>
        <Tab value="ledgers">Ledgers{data ? ` (${count(data.ledgers.length)})` : ''}</Tab>
        {target !== null ? <Tab value="changes">Changes</Tab> : null}
      </TabList>

      {base.loading || !data ? (
        base.error ? (
          <Panel>
            <Body1>{base.error}</Body1>
          </Panel>
        ) : (
          <Loading label="Opening the saved data" />
        )
      ) : tab === 'summary' ? (
        <>
          <div className={s.tiles}>
            <div className={s.tile}>
              <Caption1 className={s.label}>Vouchers</Caption1>
              <span className={s.tileValue}>{count(data.vouchers.length)}</span>
              <Caption1 className={s.muted}>
                {tallyDate(data.period.from)} to {tallyDate(data.period.to)}
              </Caption1>
            </div>
            <div className={s.tile}>
              <Caption1 className={s.label}>Latest voucher</Caption1>
              <span className={s.tileValue}>{tallyDate(data.vouchers.reduce((m, v) => (v.date > m ? v.date : m), '') || null)}</span>
            </div>
            <div className={s.tile}>
              <Caption1 className={s.label}>Ledgers</Caption1>
              <span className={s.tileValue}>{count(data.ledgers.length)}</span>
            </div>
            <div className={s.tile}>
              <Caption1 className={s.label}>Saved</Caption1>
              <span className={s.tileValue} style={{ fontSize: tokens.fontSizeBase400 }}>
                {baseRow ? when(baseRow.capturedAt) : '—'}
              </span>
              <Caption1 className={s.muted}>{baseRow?.device ? `From ${baseRow.device}` : ''}</Caption1>
            </div>
          </div>
          <div className={s.two}>
            <Group title="Vouchers by type">
              <Table size="small" aria-label="Vouchers by type">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell className={s.numHead}>Count</TableHeaderCell>
                    <TableHeaderCell className={s.numHead}>Total</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {totalsByType(data.vouchers).map((t) => (
                    <TableRow key={t.type}>
                      <TableCell>{t.type}</TableCell>
                      <TableCell className={s.num}>{count(t.count)}</TableCell>
                      <TableCell className={s.num}>{amount(t.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
            <Group title="Cash and bank">
              <Table size="small" aria-label="Cash and bank balances">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Ledger</TableHeaderCell>
                    <TableHeaderCell className={s.numHead}>Closing balance</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cashAndBank(data.ledgers).map((l) => (
                    <TableRow key={l.name}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell className={s.num}>{balance(l.closing)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
          </div>
        </>
      ) : tab === 'vouchers' ? (
        <VoucherTable key={baseId ?? 0} vouchers={data.vouchers} />
      ) : tab === 'ledgers' ? (
        <LedgerTable key={baseId ?? 0} ledgers={data.ledgers} />
      ) : other.loading ? (
        <Loading label={target === 'live' ? 'Reading the data from Tally' : 'Opening the saved data'} />
      ) : other.error ? (
        <Panel>
          <Body1>{other.error}</Body1>
        </Panel>
      ) : other.data && baseRow ? (
        (() => {
          const targetAt = target === 'live' ? Number.MAX_SAFE_INTEGER : (row(target as number)?.capturedAt ?? 0);
          const baseFirst = (baseRow.capturedAt <= targetAt) === (order === 'asc');
          const a = { data, label: when(baseRow.capturedAt) };
          const b = { data: other.data, label: targetLabel };
          const [from, to] = baseFirst ? [a, b] : [b, a];
          return (
            <Changes
              from={from.data}
              to={to.data}
              fromLabel={from.label}
              toLabel={to.label}
              onSwap={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
            />
          );
        })()
      ) : null}
    </Page>
  );
}
