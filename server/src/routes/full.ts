import type { Hono } from 'hono';
import type { AppEnv, Env } from '../types';
import { audit, deviceName, requireAdmin, requireAuth } from '../lib/auth';
import { ApiError, badRequest, conflict, int, notFound, oneOf, readJson } from '../lib/http';
import { loadPolicy } from '../lib/policy';

const fullKey = (id: number) => `full/${id}.tar.zst`;
const manifestKey = (id: number) => `full/${id}.manifest.json`;

interface FullRow {
  id: number;
  r2_key: string;
  status: string;
  origin: string;
  file_count: number;
  original_size: number;
  compressed_size: number;
  compression: string;
  level: number | null;
  created_at: number;
  completed_at: number | null;
  device: string | null;
  note: string | null;
  username?: string | null;
}

async function deleteFull(env: Env, row: Pick<FullRow, 'id' | 'r2_key'>) {
  await env.BUCKET.delete([row.r2_key, manifestKey(row.id)]);
  await env.DB.prepare('DELETE FROM full_backups WHERE id = ?').bind(row.id).run();
}

/** Keeps only the newest `keep` complete backups. */
export async function enforceFullRetention(env: Env, keep: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key FROM full_backups WHERE status = 'complete' ORDER BY created_at DESC LIMIT -1 OFFSET ?",
  )
    .bind(keep)
    .all<Pick<FullRow, 'id' | 'r2_key'>>();
  for (const row of results) await deleteFull(env, row);
  return results.length;
}

function parseRange(header: string | undefined): { offset: number; length?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const offset = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  return end !== undefined && end >= offset ? { offset, length: end - offset + 1 } : { offset };
}

export function registerFull(app: Hono<AppEnv>) {
  app.get('/api/full-backups', requireAuth, requireAdmin, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT f.*, u.username FROM full_backups f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.status = 'complete' OR f.created_at > ?
        ORDER BY f.created_at DESC LIMIT 500`,
    )
      .bind(Date.now() - 7 * 86_400_000)
      .all<FullRow>();
    return c.json({ backups: results });
  });

  app.post('/api/full-backups', requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const origin = oneOf(body.origin ?? 'manual', 'origin', ['manual', 'scheduled'] as const);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO full_backups (r2_key, status, origin, file_count, original_size, level, created_at, user_id, device, note)
       VALUES ('', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        origin,
        int(body.fileCount ?? 0, 'fileCount', { min: 0 }),
        int(body.originalSize ?? 0, 'originalSize', { min: 0 }),
        body.level === undefined ? null : int(body.level, 'level', { min: 1, max: 22 }),
        now,
        c.get('user').id,
        deviceName(c),
        typeof body.note === 'string' ? body.note.slice(0, 200) : null,
      )
      .run();
    const id = Number(res.meta.last_row_id);
    await c.env.DB.prepare('UPDATE full_backups SET r2_key = ? WHERE id = ?').bind(fullKey(id), id).run();
    return c.json({ id, key: fullKey(id) });
  });

  /** Single-request upload for archives up to ~90 MB; bigger ones use /api/uploads with the returned key. */
  app.put('/api/full-backups/:id/data', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const row = await c.env.DB.prepare('SELECT status FROM full_backups WHERE id = ?').bind(id).first<{ status: string }>();
    if (!row) throw notFound('That backup no longer exists.');
    if (row.status !== 'uploading') throw conflict('That backup is already finished.');
    if (!c.req.raw.body) throw badRequest('Upload body is empty.');
    int(c.req.header('content-length'), 'Content-Length header', { min: 1 });
    await c.env.BUCKET.put(fullKey(id), c.req.raw.body, { httpMetadata: { contentType: 'application/zstd' } });
    return c.json({ ok: true });
  });

  app.put('/api/full-backups/:id/manifest', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const row = await c.env.DB.prepare('SELECT id FROM full_backups WHERE id = ?').bind(id).first();
    if (!row) throw notFound('That backup no longer exists.');
    const text = await c.req.text();
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.files)) throw new Error('files missing');
    } catch {
      throw badRequest('The manifest must be JSON with a "files" list.');
    }
    await c.env.BUCKET.put(manifestKey(id), text, { httpMetadata: { contentType: 'application/json' } });
    return c.json({ ok: true });
  });

  app.post('/api/full-backups/:id/complete', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const body = await readJson(c);
    const row = await c.env.DB.prepare('SELECT * FROM full_backups WHERE id = ?').bind(id).first<FullRow>();
    if (!row) throw notFound('That backup no longer exists.');
    if (row.status !== 'uploading') throw conflict('That backup is already finished.');
    const head = await c.env.BUCKET.head(row.r2_key);
    if (!head) throw new ApiError(409, 'The archive was not uploaded.', 'missing_data');
    const fileCount = body.fileCount === undefined ? row.file_count : int(body.fileCount, 'fileCount', { min: 0 });
    const originalSize = body.originalSize === undefined ? row.original_size : int(body.originalSize, 'originalSize', { min: 0 });
    await c.env.DB.prepare(
      "UPDATE full_backups SET status = 'complete', compressed_size = ?, file_count = ?, original_size = ?, completed_at = ? WHERE id = ?",
    )
      .bind(head.size, fileCount, originalSize, Date.now(), id)
      .run();
    const policy = await loadPolicy(c.env.DB);
    const removed = await enforceFullRetention(c.env, policy.full.keep);
    await audit(c.env, c.get('user'), 'full.completed', { id, fileCount, originalSize, compressedSize: head.size, origin: row.origin, removed });
    return c.json({ ok: true, compressedSize: head.size, removedOld: removed });
  });

  app.post('/api/full-backups/:id/fail', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
    const row = await c.env.DB.prepare('SELECT * FROM full_backups WHERE id = ?').bind(id).first<FullRow>();
    if (!row) throw notFound('That backup no longer exists.');
    await c.env.BUCKET.delete([row.r2_key, manifestKey(id)]);
    await c.env.DB.prepare("UPDATE full_backups SET status = 'failed', note = ?, completed_at = ? WHERE id = ?")
      .bind(typeof body.message === 'string' ? body.message.slice(0, 300) : 'Failed', Date.now(), id)
      .run();
    return c.json({ ok: true });
  });

  app.get('/api/full-backups/:id/manifest', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const obj = await c.env.BUCKET.get(manifestKey(id));
    if (!obj) throw notFound('This backup has no file list.');
    return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
  });

  app.get('/api/full-backups/:id/download', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const row = await c.env.DB.prepare("SELECT r2_key FROM full_backups WHERE id = ? AND status = 'complete'").bind(id).first<{ r2_key: string }>();
    if (!row) throw notFound('That backup is not available.');
    const range = parseRange(c.req.header('range'));
    const obj = await c.env.BUCKET.get(row.r2_key, range ? { range } : undefined);
    if (!obj) throw notFound('The archive is missing from storage.');
    const headers = new Headers({ 'content-type': 'application/zstd', 'accept-ranges': 'bytes' });
    if (range) {
      const start = range.offset;
      const length = range.length ?? obj.size - start;
      headers.set('content-range', `bytes ${start}-${start + length - 1}/${obj.size}`);
      headers.set('content-length', String(length));
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set('content-length', String(obj.size));
    return new Response(obj.body, { headers });
  });

  app.delete('/api/full-backups/:id', requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param('id'), 'Backup id', { min: 1 });
    const row = await c.env.DB.prepare('SELECT id, r2_key FROM full_backups WHERE id = ?').bind(id).first<FullRow>();
    if (!row) throw notFound('That backup no longer exists.');
    await deleteFull(c.env, row);
    await audit(c.env, c.get('user'), 'full.deleted', { id });
    return c.json({ ok: true });
  });
}
