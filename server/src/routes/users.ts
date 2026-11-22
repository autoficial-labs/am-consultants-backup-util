import type { Hono } from 'hono';
import type { Access, AppEnv, ScopeMode, UserRow } from '../types';
import { audit, requireAdmin, requireAuth } from '../lib/auth';
import { hashPassword } from '../lib/crypto';
import { badRequest, conflict, forbidden, int, notFound, oneOf, readJson, str } from '../lib/http';
import { compactFolders, normalizeRelPath } from '../lib/paths';
import { validatePassword, validateUsername } from './auth';

const ACCESS = ['read', 'write'] as const;
const SCOPES = ['all', 'include', 'exclude', 'none'] as const;

interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  access: Access;
  scopeMode: ScopeMode;
  paths: string[];
  disabled: boolean;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  activeSessions: number;
}

function parseFolders(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest('Folders must be a list.');
  if (value.length > 500) throw badRequest('Too many folders selected.');
  return compactFolders(value.map((v) => normalizeRelPath(v, 'Folder')));
}

async function listUsers(db: D1Database): Promise<PublicUser[]> {
  const now = Date.now();
  const [users, paths, sessions] = await db.batch([
    db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'superadmin' THEN 0 ELSE 1 END, display_name COLLATE NOCASE"),
    db.prepare('SELECT user_id, path FROM user_paths ORDER BY path'),
    db.prepare('SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id').bind(now),
  ]);
  const pathMap = new Map<number, string[]>();
  for (const p of (paths!.results as { user_id: number; path: string }[])) {
    const list = pathMap.get(p.user_id) ?? [];
    list.push(p.path);
    pathMap.set(p.user_id, list);
  }
  const sessionMap = new Map((sessions!.results as { user_id: number; n: number }[]).map((s) => [s.user_id, s.n]));
  return (users!.results as unknown as UserRow[]).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    access: u.role === 'superadmin' ? 'write' : u.access,
    scopeMode: u.role === 'superadmin' ? 'all' : u.scope_mode,
    paths: pathMap.get(u.id) ?? [],
    disabled: Boolean(u.disabled),
    locked: u.locked_until > now,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
    activeSessions: sessionMap.get(u.id) ?? 0,
  }));
}

function pathStatements(db: D1Database, userId: number, mode: ScopeMode, folders: string[]) {
  const stmts = [db.prepare('DELETE FROM user_paths WHERE user_id = ?').bind(userId)];
  if (mode === 'include' || mode === 'exclude') {
    for (const f of folders) stmts.push(db.prepare('INSERT INTO user_paths (user_id, path) VALUES (?, ?)').bind(userId, f));
  }
  return stmts;
}

export function registerUsers(app: Hono<AppEnv>) {
  app.get('/api/users', requireAuth, requireAdmin, async (c) => c.json({ users: await listUsers(c.env.DB) }));

  app.post('/api/users', requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const username = validateUsername(body.username);
    const displayName = str(body.displayName, 'Name', { min: 1, max: 80 });
    const password = validatePassword(body.password);
    const access = oneOf(body.access ?? 'read', 'Access', ACCESS);
    const scopeMode = oneOf(body.scopeMode ?? 'none', 'Folder access', SCOPES);
    const folders = parseFolders(body.paths);
    if ((scopeMode === 'include' || scopeMode === 'exclude') && folders.length === 0) {
      throw badRequest(scopeMode === 'include' ? 'Choose at least one folder to share.' : 'Choose at least one folder to exclude.');
    }
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exists) throw conflict(`The username "${username}" is already taken.`);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, access, scope_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
    )
      .bind(username, displayName, await hashPassword(password), access, scopeMode, now, now)
      .run();
    const id = Number(res.meta.last_row_id);
    await c.env.DB.batch(pathStatements(c.env.DB, id, scopeMode, folders));
    await audit(c.env, c.get('user'), 'user.created', { id, username, access, scopeMode, folders });
    const users = await listUsers(c.env.DB);
    return c.json({ user: users.find((u) => u.id === id) }, 201);
  });

  app.patch('/api/users/:id', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'User id', { min: 1 });
    const body = await readJson(c);
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
    if (!row) throw notFound('That user no longer exists.');
    const isSuper = row.role === 'superadmin';
    const sets: string[] = [];
    const binds: unknown[] = [];
    const stmts: D1PreparedStatement[] = [];
    let signOut = false;
    const changes: Record<string, unknown> = {};

    if (body.displayName !== undefined) {
      sets.push('display_name = ?');
      binds.push(str(body.displayName, 'Name', { min: 1, max: 80 }));
      changes.displayName = true;
    }
    if (body.password !== undefined) {
      sets.push('password_hash = ?', 'failed_logins = 0', 'locked_until = 0');
      binds.push(await hashPassword(validatePassword(body.password)));
      signOut = true;
      changes.password = 'reset';
    }
    if (body.unlock === true) {
      sets.push('failed_logins = 0', 'locked_until = 0');
      changes.unlocked = true;
    }
    if (body.access !== undefined) {
      if (isSuper) throw forbidden("The administrator's access cannot be changed.");
      const access = oneOf(body.access, 'Access', ACCESS);
      sets.push('access = ?');
      binds.push(access);
      changes.access = access;
    }
    if (body.disabled !== undefined) {
      if (isSuper) throw forbidden('The administrator account cannot be revoked.');
      const disabled = body.disabled === true;
      sets.push('disabled = ?');
      binds.push(disabled ? 1 : 0);
      if (disabled) signOut = true;
      changes.disabled = disabled;
    }
    if (body.scopeMode !== undefined || body.paths !== undefined) {
      if (isSuper) throw forbidden('The administrator always has access to every folder.');
      const scopeMode = oneOf(body.scopeMode ?? row.scope_mode, 'Folder access', SCOPES);
      const folders = parseFolders(body.paths ?? []);
      if ((scopeMode === 'include' || scopeMode === 'exclude') && folders.length === 0) {
        throw badRequest(scopeMode === 'include' ? 'Choose at least one folder to share.' : 'Choose at least one folder to exclude.');
      }
      sets.push('scope_mode = ?');
      binds.push(scopeMode);
      stmts.push(...pathStatements(c.env.DB, id, scopeMode, folders));
      changes.scopeMode = scopeMode;
      changes.folders = folders;
    }
    if (body.signOut === true) {
      signOut = true;
      changes.signedOut = true;
    }
    if (!sets.length && !stmts.length && !signOut) throw badRequest('Nothing to update.');
    if (sets.length) {
      sets.push('updated_at = ?');
      binds.push(Date.now(), id);
      stmts.unshift(c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds));
    }
    if (signOut) stmts.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
    await c.env.DB.batch(stmts);
    await audit(c.env, c.get('user'), 'user.updated', { id, username: row.username, ...changes });
    const users = await listUsers(c.env.DB);
    return c.json({ user: users.find((u) => u.id === id) });
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'User id', { min: 1 });
    const row = await c.env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(id).first<UserRow>();
    if (!row) throw notFound('That user no longer exists.');
    if (row.role === 'superadmin') throw forbidden('The administrator account cannot be deleted.');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM user_paths WHERE user_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    await audit(c.env, c.get('user'), 'user.deleted', { id, username: row.username });
    return c.json({ ok: true });
  });
}
