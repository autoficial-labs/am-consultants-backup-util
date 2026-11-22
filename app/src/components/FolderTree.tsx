import {
  Caption1,
  FlatTree,
  FlatTreeItem,
  TreeItemLayout,
  makeStyles,
  tokens,
  type TreeCheckedChangeData,
  type TreeOpenChangeData,
} from '@fluentui/react-components';
import { Folder20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import { bytes, count } from '../lib/format';
import { checkState, flatten, toggleFolder, type FolderNode } from '../lib/tree';

const useStyles = makeStyles({
  wrap: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    overflowY: 'auto',
    padding: '4px',
  },
  aside: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  empty: { padding: '16px', color: tokens.colorNeutralForeground3 },
});

/**
 * Folder tree with tri-state checkboxes. `selected` holds top-most chosen folders; ticking every
 * subfolder collapses into the parent, unticking inside a chosen parent keeps its other children.
 */
export function FolderTree({
  roots,
  selected,
  onChange,
  maxHeight = 320,
  label,
  emptyText = 'No folders yet.',
  disabled,
}: {
  roots: FolderNode[];
  selected: string[];
  onChange: (next: string[]) => void;
  maxHeight?: number;
  label: string;
  emptyText?: string;
  disabled?: boolean;
}) {
  const s = useStyles();
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.length === 1 ? [roots[0]!.path] : []));

  // Reveal chosen folders when the tree first gets data.
  useEffect(() => {
    if (!roots.length) return;
    setOpen((prev) => {
      if (prev.size) return prev;
      const next = new Set<string>();
      if (roots.length === 1) next.add(roots[0]!.path);
      for (const sel of selected) {
        const segs = sel.split('/');
        for (let i = 1; i < segs.length; i++) next.add(segs.slice(0, i).join('/'));
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  const visible = useMemo(() => flatten(roots, open), [roots, open]);
  const checked = useMemo(() => visible.map((n) => [n.path, checkState(n.path, selected)] as [string, boolean | 'mixed']), [visible, selected]);

  if (!roots.length) return <div className={s.wrap}><Caption1 className={s.empty}>{emptyText}</Caption1></div>;

  const siblingsOf = (n: FolderNode) => (n.parent ? visible.find((v) => v.path === n.parent)?.children ?? [] : roots);

  return (
    <div className={s.wrap} style={{ maxHeight }}>
      <FlatTree
        aria-label={label}
        selectionMode="multiselect"
        openItems={open}
        checkedItems={checked}
        onOpenChange={(_, d: TreeOpenChangeData) => setOpen(new Set(d.openItems as Iterable<string>))}
        onCheckedChange={(_, d: TreeCheckedChangeData) => {
          if (!disabled) onChange(toggleFolder(roots, selected, String(d.value)));
        }}
        size="small"
      >
        {visible.map((n) => {
          const sibs = siblingsOf(n);
          const isOpen = open.has(n.path);
          return (
            <FlatTreeItem
              key={n.path}
              value={n.path}
              parentValue={n.parent ?? undefined}
              aria-level={n.depth + 1}
              aria-setsize={sibs.length}
              aria-posinset={sibs.indexOf(n) + 1}
              itemType={n.children.length ? 'branch' : 'leaf'}
            >
              <TreeItemLayout
                iconBefore={isOpen && n.children.length ? <FolderOpen20Regular /> : <Folder20Regular />}
                aside={
                  n.files ? (
                    <Caption1 className={`${s.aside} tabular`}>
                      {count(n.files)} files · {bytes(n.bytes)}
                    </Caption1>
                  ) : undefined
                }
              >
                {n.name}
              </TreeItemLayout>
            </FlatTreeItem>
          );
        })}
      </FlatTree>
    </div>
  );
}
