// Folder-tree helpers shared by the permission picker and the restore scope picker.

export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  parent: string | null;
  children: FolderNode[];
  files: number;
  bytes: number;
}

export const isUnder = (path: string, folder: string) => {
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
};

/** Builds a sorted folder tree from folder paths (with optional stats). */
export function buildTree(folders: { path: string; files?: number; bytes?: number }[]): FolderNode[] {
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  const ensure = (path: string): FolderNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const i = path.lastIndexOf('/');
    const parentPath = i < 0 ? null : path.slice(0, i);
    const node: FolderNode = { path, name: i < 0 ? path : path.slice(i + 1), depth: 0, parent: parentPath, children: [], files: 0, bytes: 0 };
    byPath.set(path, node);
    if (parentPath) {
      const parent = ensure(parentPath);
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    return node;
  };
  for (const f of folders) {
    if (!f.path) continue;
    const n = ensure(f.path);
    if (f.files !== undefined) n.files = Math.max(n.files, f.files);
    if (f.bytes !== undefined) n.bytes = Math.max(n.bytes, f.bytes);
  }
  const sort = (list: FolderNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Folder list (with file counts and sizes) derived from file paths. */
export function foldersFromFiles(files: { path: string; size: number }[]) {
  const map = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const segs = f.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      const agg = map.get(p) ?? { files: 0, bytes: 0 };
      agg.files += 1;
      agg.bytes += f.size;
      map.set(p, agg);
    }
  }
  return [...map.entries()].map(([path, a]) => ({ path, ...a }));
}

export function flatten(nodes: FolderNode[], open: Set<string>, out: FolderNode[] = []): FolderNode[] {
  for (const n of nodes) {
    out.push(n);
    if (open.has(n.path)) flatten(n.children, open, out);
  }
  return out;
}

export function findNode(nodes: FolderNode[], path: string): FolderNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (isUnder(path, n.path)) return findNode(n.children, path);
  }
  return undefined;
}

/** Keeps only top-most folders (a selected parent covers its children). */
export function compact(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of sorted) if (!out.some((o) => isUnder(p, o))) out.push(p);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export type CheckState = boolean | 'mixed';

export function checkState(path: string, selected: string[]): CheckState {
  if (selected.some((s) => isUnder(path, s))) return true;
  if (selected.some((s) => isUnder(s, path))) return 'mixed';
  return false;
}

/**
 * Toggles a folder in a selection of top-most folders. Unchecking a folder whose ancestor is
 * selected expands that ancestor into its other children; checking every child of a folder
 * collapses the selection back into the parent.
 */
export function toggleFolder(roots: FolderNode[], selected: string[], path: string): string[] {
  const state = checkState(path, selected);
  if (state === true) {
    const ancestor = selected.find((s) => isUnder(path, s))!;
    let next = selected.filter((s) => s !== ancestor);
    // Walk from the selected ancestor down to `path`, keeping every sibling branch.
    let node = findNode(roots, ancestor);
    while (node && node.path !== path) {
      const step = node.children.find((c) => isUnder(path, c.path));
      for (const c of node.children) if (c !== step) next.push(c.path);
      node = step;
    }
    next = next.filter((s) => !isUnder(s, path));
    return compact(next);
  }
  let next = compact([...selected.filter((s) => !isUnder(s, path)), path]);
  // Collapse upward when all siblings are selected.
  let node = findNode(roots, path);
  while (node?.parent) {
    const parent = findNode(roots, node.parent);
    if (!parent || !parent.children.every((c) => next.includes(c.path))) break;
    // A parent with files of its own is not fully covered by its subfolders.
    const childFiles = parent.children.reduce((s, c) => s + c.files, 0);
    if (parent.files > childFiles) break;
    next = compact([...next.filter((s) => !isUnder(s, parent.path)), parent.path]);
    node = parent;
  }
  return next;
}
