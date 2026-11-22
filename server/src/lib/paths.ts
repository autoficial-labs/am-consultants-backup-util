import type { AuthUser, ScopeMode } from '../types';
import { badRequest } from './http';

/**
 * Normalises a path relative to the backup root: forward slashes, no leading or
 * trailing slash, and no "." / ".." segments, so it can never escape the root.
 */
export function normalizeRelPath(input: unknown, what = 'Path'): string {
  if (typeof input !== 'string') throw badRequest(`${what} must be text.`);
  const p = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) throw badRequest(`${what} cannot be empty.`);
  if (p.length > 1024) throw badRequest(`${what} is too long.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) throw badRequest(`${what} contains invalid characters.`);
  if (/^[a-zA-Z]:/.test(p)) throw badRequest(`${what} must be relative to the backup folder.`);
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') throw badRequest(`${what} cannot contain "." or ".." segments.`);
  }
  return p;
}

/** True when `path` is `folder` itself or anywhere inside it. Case-insensitive, like Windows. */
export function isUnder(path: string, folder: string): boolean {
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(b + '/');
}

/** Removes folders already covered by a parent folder in the same list. */
export function compactFolders(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of unique) if (!out.some((o) => isUnder(p, o))) out.push(p);
  return out.sort((a, b) => a.localeCompare(b));
}

export function scopeAllows(mode: ScopeMode, folders: string[], path: string): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'include':
      return folders.some((f) => isUnder(path, f));
    case 'exclude':
      return !folders.some((f) => isUnder(path, f));
  }
}

export function canRead(user: AuthUser, path: string): boolean {
  if (user.role === 'superadmin') return true;
  return scopeAllows(user.scopeMode, user.paths, path);
}

export function canWrite(user: AuthUser, path: string): boolean {
  if (user.role === 'superadmin') return true;
  return user.access === 'write' && scopeAllows(user.scopeMode, user.paths, path);
}

export function filterReadable<T extends { path: string }>(user: AuthUser, rows: T[]): T[] {
  if (user.role === 'superadmin' || user.scopeMode === 'all') return rows;
  if (user.scopeMode === 'none') return [];
  return rows.filter((r) => canRead(user, r.path));
}
