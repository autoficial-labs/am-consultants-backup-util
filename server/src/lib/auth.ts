import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, AuthUser, Env, UserRow } from '../types';
import { randomToken, sha256Hex } from './crypto';
import { forbidden, unauthorized } from './http';

const SLIDE_AFTER_MS = 10 * 60 * 1000;

export function sessionDays(env: Env): number {
  const n = Number(env.SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function loadUserPaths(db: D1Database, userId: number): Promise<string[]> {
  const { results } = await db.prepare('SELECT path FROM user_paths WHERE user_id = ? ORDER BY path').bind(userId).all<{ path: string }>();
  return results.map((r) => r.path);
}

export async function toAuthUser(db: D1Database, row: UserRow): Promise<AuthUser> {
  const needsPaths = row.scope_mode === 'include' || row.scope_mode === 'exclude';
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    access: row.role === 'superadmin' ? 'write' : row.access,
    scopeMode: row.role === 'superadmin' ? 'all' : row.scope_mode,
    paths: needsPaths && row.role !== 'superadmin' ? await loadUserPaths(db, row.id) : [],
  };
}

export async function createSession(env: Env, userId: number, device: string | null): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + sessionDays(env) * 86_400_000;
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, device, now, now, expiresAt)
    .run();
  return { token, expiresAt };
}

export function deviceName(c: Context): string | null {
  const d = c.req.header('x-device');
  return d ? d.slice(0, 120) : null;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(header);
  if (!match) throw unauthorized();
  const tokenHash = await sha256Hex(match[1]!);
  const row = await c.env.DB.prepare(
    `SELECT u.*, s.expires_at AS s_expires, s.last_seen_at AS s_seen
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<UserRow & { s_expires: number; s_seen: number }>();
  const now = Date.now();
  if (!row || row.s_expires < now) throw unauthorized('Your session has ended. Please sign in again.');
  if (row.disabled) throw unauthorized('Your access has been revoked. Contact your administrator.');

  if (now - row.s_seen > SLIDE_AFTER_MS) {
    const expires = now + sessionDays(c.env) * 86_400_000;
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').bind(now, expires, tokenHash).run(),
    );
  }
  c.set('user', await toAuthUser(c.env.DB, row));
  c.set('tokenHash', tokenHash);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'superadmin') throw forbidden('Only the administrator can do that.');
  await next();
};

export const requireWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = c.get('user');
  if (u.role !== 'superadmin' && u.access !== 'write') throw forbidden('Your account has read-only access.');
  await next();
};

export async function audit(env: Env, user: { id: number; username: string } | null, action: string, detail?: unknown) {
  await env.DB.prepare('INSERT INTO audit_log (at, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), user?.id ?? null, user?.username ?? null, action, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
