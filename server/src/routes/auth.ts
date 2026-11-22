import type { Hono } from 'hono';
import type { AppEnv, UserRow } from '../types';
import { audit, createSession, deviceName, requireAuth, toAuthUser } from '../lib/auth';
import { constantTimeEqualText, dummyVerify, hashPassword, verifyPassword } from '../lib/crypto';
import { ApiError, badRequest, conflict, forbidden, readJson, str, unauthorized } from '../lib/http';
import { loadPolicy } from '../lib/policy';

export const API_VERSION = '1.0.0';
const MAX_FAILED = 5;
const LOCK_MS = 5 * 60 * 1000;
export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,39}$/;

export function validatePassword(value: unknown, name = 'Password'): string {
  if (typeof value !== 'string') throw badRequest(`${name} is required.`);
  if (value.length < 8) throw badRequest(`${name} must be at least 8 characters.`);
  if (value.length > 200) throw badRequest(`${name} is too long.`);
  return value;
}

export function validateUsername(value: unknown): string {
  const u = str(value, 'Username', { min: 2, max: 40 });
  if (!USERNAME_RE.test(u)) throw badRequest('Usernames can use letters, numbers, dots, dashes and underscores.');
  return u;
}

async function superAdminExists(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

function checkSetupKey(expected: string | undefined, given: unknown) {
  if (!expected) {
    throw new ApiError(503, 'The server has no SETUP_KEY configured. Set it with "wrangler secret put SETUP_KEY".', 'setup_key_missing');
  }
  if (typeof given !== 'string' || !constantTimeEqualText(given, expected)) throw forbidden('The setup key is not correct.');
}

export function registerAuth(app: Hono<AppEnv>) {
  app.get('/api/health', async (c) => {
    return c.json({
      ok: true,
      service: 'am-backup',
      version: API_VERSION,
      build: c.env.SERVER_BUILD ?? null,
      environment: c.env.APP_ENV,
      needsSetup: !(await superAdminExists(c.env.DB)),
      setupKeyConfigured: Boolean(c.env.SETUP_KEY),
      serverTime: Date.now(),
    });
  });

  // One-time creation of the super-admin account.
  app.post('/api/setup', async (c) => {
    const body = await readJson(c);
    checkSetupKey(c.env.SETUP_KEY, body.setupKey);
    if (await superAdminExists(c.env.DB)) throw conflict('The administrator account already exists. Sign in instead.');
    const username = validateUsername(body.username);
    const displayName = str(body.displayName, 'Name', { max: 80, optional: true }) || 'Administrator';
    const password = validatePassword(body.password);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, access, scope_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'superadmin', 'write', 'all', ?, ?)`,
    )
      .bind(username, displayName, await hashPassword(password), now, now)
      .run();
    const id = Number(res.meta.last_row_id);
    await audit(c.env, { id, username }, 'setup.admin_created');
    const session = await createSession(c.env, id, deviceName(c));
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
    return c.json({ token: session.token, expiresAt: session.expiresAt, user: await toAuthUser(c.env.DB, row!) });
  });

  // Recovery path for a forgotten administrator password.
  app.post('/api/setup/reset-admin', async (c) => {
    const body = await readJson(c);
    checkSetupKey(c.env.SETUP_KEY, body.setupKey);
    const password = validatePassword(body.password, 'New password');
    const admin = await c.env.DB.prepare("SELECT id, username FROM users WHERE role = 'superadmin' LIMIT 1").first<{ id: number; username: string }>();
    if (!admin) throw badRequest('There is no administrator account yet. Run the first-time setup instead.');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = 0, disabled = 0, updated_at = ? WHERE id = ?').bind(
        await hashPassword(password),
        Date.now(),
        admin.id,
      ),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(admin.id),
    ]);
    await audit(c.env, admin, 'setup.admin_password_reset');
    return c.json({ ok: true, username: admin.username });
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const username = str(body.username, 'Username', { max: 40 });
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw badRequest('Enter your username and password.');
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
    const now = Date.now();
    if (!row) {
      await dummyVerify(password);
      throw unauthorized('That username and password do not match.');
    }
    if (row.locked_until > now) {
      const mins = Math.ceil((row.locked_until - now) / 60000);
      throw new ApiError(429, `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'locked');
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      const failed = row.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? now + LOCK_MS : 0;
      await c.env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .bind(lock ? 0 : failed, lock, row.id)
        .run();
      if (lock) await audit(c.env, row, 'auth.locked');
      throw unauthorized('That username and password do not match.');
    }
    if (row.disabled) throw forbidden('Your access has been revoked. Contact your administrator.');
    await c.env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = ? WHERE id = ?').bind(now, row.id).run();
    const session = await createSession(c.env, row.id, deviceName(c));
    await audit(c.env, row, 'auth.login', { device: deviceName(c) });
    return c.json({ token: session.token, expiresAt: session.expiresAt, user: await toAuthUser(c.env.DB, row) });
  });

  app.post('/api/auth/logout', requireAuth, async (c) => {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('tokenHash')).run();
    return c.json({ ok: true });
  });

  app.get('/api/me', requireAuth, async (c) => {
    return c.json({ user: c.get('user'), policy: await loadPolicy(c.env.DB), serverTime: Date.now() });
  });

  app.patch('/api/me', requireAuth, async (c) => {
    const me = c.get('user');
    const body = await readJson(c);
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.displayName !== undefined) {
      sets.push('display_name = ?');
      binds.push(str(body.displayName, 'Name', { min: 1, max: 80 }));
    }
    let passwordChanged = false;
    if (body.newPassword !== undefined) {
      const next = validatePassword(body.newPassword, 'New password');
      const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(me.id).first<{ password_hash: string }>();
      if (!row || !(await verifyPassword(String(body.currentPassword ?? ''), row.password_hash))) {
        throw badRequest('Your current password is not correct.');
      }
      sets.push('password_hash = ?');
      binds.push(await hashPassword(next));
      passwordChanged = true;
    }
    if (!sets.length) throw badRequest('Nothing to update.');
    sets.push('updated_at = ?');
    binds.push(Date.now(), me.id);
    const stmts = [c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds)];
    // Changing the password signs out every other device.
    if (passwordChanged) stmts.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(me.id, c.get('tokenHash')));
    await c.env.DB.batch(stmts);
    if (passwordChanged) await audit(c.env, me, 'account.password_changed');
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first<UserRow>();
    return c.json({ user: await toAuthUser(c.env.DB, row!) });
  });
}
