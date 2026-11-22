import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Subtitle2,
  Text,
  Title2,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { errorMessage } from '../lib/backend';

const useStyles = makeStyles({
  page: {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '28px 36px 48px',
  },
  pageInner: {
    maxWidth: '1120px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '32px',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '16px',
    flexWrap: 'wrap',
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  headerDesc: { color: tokens.colorNeutralForeground2, maxWidth: '68ch' },
  headerActions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  // Cards in a group stack with the same gap as option cards sit side by side.
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge },
  groupTitle: { marginBottom: '0px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
  groupDesc: { color: tokens.colorNeutralForeground3, marginTop: '-4px', marginBottom: '4px', maxWidth: '72ch' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    columnGap: '16px',
    minHeight: '64px',
    boxSizing: 'border-box',
    padding: '12px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  rowNoIcon: { gridTemplateColumns: '1fr auto' },
  rowIcon: { color: tokens.colorNeutralForeground2, display: 'flex', fontSize: '20px' },
  rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  rowDesc: { color: tokens.colorNeutralForeground3 },
  rowControl: { display: 'flex', alignItems: 'center', gap: '8px', justifySelf: 'end' },
  rowBody: {
    gridColumn: '1 / -1',
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
  },
  panelPad: { padding: '20px' },
  options: { display: 'grid', gap: tokens.spacingHorizontalMNudge },
  option: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: '12px',
    alignItems: 'start',
    textAlign: 'left',
    padding: '14px 16px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transitionProperty: 'border-color, background-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1Hover) },
    ':active': { backgroundColor: tokens.colorNeutralBackground1Pressed },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  optionSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    boxShadow: `inset 0 0 0 1px ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  optionDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  optionIcon: { fontSize: '24px', color: tokens.colorNeutralForeground2, display: 'flex', paddingTop: '1px' },
  optionIconSelected: { color: tokens.colorBrandForeground1 },
  optionText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  optionDesc: { color: tokens.colorNeutralForeground3 },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: '8px',
    padding: '40px 24px',
    color: tokens.colorNeutralForeground2,
  },
  emptyIcon: { fontSize: '40px', color: tokens.colorNeutralForeground3, display: 'flex', marginBottom: '4px' },
  emptyBody: { maxWidth: '46ch', color: tokens.colorNeutralForeground3 },
  center: { display: 'grid', placeItems: 'center', padding: '48px' },
});

export function Page({ children }: { children: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.page}>
      <div className={s.pageInner}>{children}</div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  const s = useStyles();
  return (
    <header className={s.header}>
      <div className={s.headerText}>
        <Title2 as="h1">{title}</Title2>
        {description ? <Body1 className={s.headerDesc}>{description}</Body1> : null}
      </div>
      {actions ? <div className={s.headerActions}>{actions}</div> : null}
    </header>
  );
}

/** A titled group of setting rows, in the style of Windows 11 Settings. */
export function Group({ title, description, aside, children }: { title?: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const s = useStyles();
  return (
    <section className={s.group}>
      {title ? (
        <div className={s.groupTitle}>
          <Subtitle2 as="h2">{title}</Subtitle2>
          {aside}
        </div>
      ) : null}
      {description ? <Caption1 className={s.groupDesc}>{description}</Caption1> : null}
      {children}
    </section>
  );
}

export function Row({
  icon,
  label,
  description,
  control,
  children,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const s = useStyles();
  return (
    <div className={mergeClasses(s.row, !icon && s.rowNoIcon, className)}>
      {icon ? <span className={s.rowIcon} aria-hidden>{icon}</span> : null}
      <div className={s.rowText}>
        <Text weight="semibold">{label}</Text>
        {description ? <Caption1 className={s.rowDesc}>{description}</Caption1> : null}
      </div>
      <div className={s.rowControl}>{control}</div>
      {children ? <div className={s.rowBody}>{children}</div> : null}
    </div>
  );
}

export function Panel({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  const s = useStyles();
  return <div className={mergeClasses(s.panel, pad && s.panelPad, className)}>{children}</div>;
}

export interface OptionDef<T extends string> {
  value: T;
  title: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Radio group drawn as cards: the user picks an outcome instead of typing a value. */
export function OptionCards<T extends string>({
  label,
  options,
  value,
  onChange,
  columns = 2,
}: {
  label: string;
  options: OptionDef<T>[];
  value: T;
  onChange: (v: T) => void;
  columns?: number;
}) {
  const s = useStyles();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    let n = i;
    for (let k = 0; k < options.length; k++) {
      n = (n + dir + options.length) % options.length;
      if (!options[n]!.disabled) break;
    }
    refs.current[n]?.focus();
    onChange(options[n]!.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={s.options} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={o.disabled || undefined}
            tabIndex={selected ? 0 : -1}
            className={mergeClasses(s.option, selected && s.optionSelected, o.disabled && s.optionDisabled)}
            onClick={() => !o.disabled && onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.icon ? <span className={mergeClasses(s.optionIcon, selected && s.optionIconSelected)} aria-hidden>{o.icon}</span> : <span />}
            <span className={s.optionText}>
              <Text weight="semibold">{o.title}</Text>
              {o.description ? <Caption1 className={s.optionDesc}>{o.description}</Caption1> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.empty}>
      {icon ? <span className={s.emptyIcon} aria-hidden>{icon}</span> : null}
      <Subtitle2>{title}</Subtitle2>
      {body ? <Body1 className={s.emptyBody}>{body}</Body1> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const s = useStyles();
  return (
    <div className={s.center} role="status">
      <Spinner size="small" label={label} />
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && !busy && onCancel()} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{children}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={onConfirm}
              disabled={busy}
              icon={busy ? <Spinner size="tiny" /> : undefined}
              style={danger ? { backgroundColor: tokens.colorStatusDangerBackground3, color: tokens.colorNeutralForegroundOnBrand } : undefined}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Loads data with loading/error state and a reload function. */
export function useLoader<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await run();
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(errorMessage(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
