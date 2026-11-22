import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { audit, requireAdmin, requireAuth } from '../lib/auth';
import { optionalInt, readJson } from '../lib/http';
import { filterReadable } from '../lib/paths';
import { loadPolicy, sanitizePolicy, savePolicy } from '../lib/policy';
import { runMaintenance } from '../maintenance';
import { enforceFullRetention } from './full';

export function registerAdmin(app: Hono<AppEnv>) {
  app.get('/api/settings', requireAuth, async (c) => c.json({ policy: await loadPolicy(c.env.DB) }));

  app.put('/api/settings', requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const policy = sanitizePolicy(body.policy ?? body);
    await savePolicy(c.env.DB, policy);
    await enforceFullRetention(c.env, policy.full.keep);
    await audit(c.env, c.get('user'), 'settings.updated', policy);
    return c.json({ policy });
  });

  app.get('/api/stats', requireAuth, async (c) => {
    const user = c.get('user');
    const db = c.env.DB;
    const since = Date.now() - 86_400_000;
    const [files, lastBatch, lastFull, fullAgg, blobAgg, versionsAgg, recent, users] = await db.batch([
      db.prepare('SELECT path, size FROM files WHERE deleted = 0'),
      db.prepare("SELECT id, started_at, finished_at, status, added, modified, deleted, message FROM batches WHERE status != 'running' ORDER BY id DESC LIMIT 1"),
      db.prepare("SELECT id, created_at, completed_at, compressed_size, original_size, file_count FROM full_backups WHERE status = 'complete' ORDER BY created_at DESC LIMIT 1"),
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(compressed_size), 0) AS bytes FROM full_backups WHERE status = 'complete'"),
      db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stored_size), 0) AS bytes FROM blobs'),
      db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS earliest FROM versions'),
      db.prepare('SELECT path, op, created_at FROM versions WHERE created_at > ? ORDER BY id DESC LIMIT 5000').bind(since),
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled = 0'),
    ]);
    const visible = filterReadable(user, files!.results as { path: string; size: number }[]);
    const recentVisible = filterReadable(user, recent!.results as { path: string; op: string; created_at: number }[]);
    const isAdmin = user.role === 'superadmin';
    const full = fullAgg!.results[0] as { n: number; bytes: number };
    const blobs = blobAgg!.results[0] as { n: number; bytes: number };
    const versions = versionsAgg!.results[0] as { n: number; earliest: number | null };
    return c.json({
      files: visible.length,
      bytes: visible.reduce((s, f) => s + f.size, 0),
      lastSync: lastBatch!.results[0] ?? null,
      lastFull: isAdmin ? (lastFull!.results[0] ?? null) : null,
      fullBackups: isAdmin ? full.n : null,
      storedBytes: isAdmin ? blobs.bytes + full.bytes : null,
      versions: isAdmin ? versions.n : null,
      earliestVersion: versions.earliest,
      activeUsers: isAdmin ? (users!.results[0] as { n: number }).n : null,
      recentChanges: recentVisible.map((r) => ({ path: r.path, op: r.op, at: r.created_at })),
    });
  });

  app.get('/api/audit', requireAuth, requireAdmin, async (c) => {
    const limit = optionalInt(c.req.query('limit'), 'limit', 100, { min: 1, max: 500 });
    const before = optionalInt(c.req.query('before'), 'before', Number.MAX_SAFE_INTEGER, { min: 1 });
    const { results } = await c.env.DB.prepare('SELECT id, at, username, action, detail FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
      .bind(before, limit)
      .all();
    return c.json({ events: results });
  });

  app.post('/api/maintenance', requireAuth, requireAdmin, async (c) => {
    const report = await runMaintenance(c.env);
    await audit(c.env, c.get('user'), 'maintenance.run', report);
    return c.json(report);
  });
}
