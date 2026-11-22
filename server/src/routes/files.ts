import type { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { requireAuth, requireWrite } from '../lib/auth';
import { ApiError, badRequest, chunk, conflict, forbidden, hashParam, int, notFound, optionalInt, readJson } from '../lib/http';
import { canRead, canWrite, filterReadable, normalizeRelPath } from '../lib/paths';

export const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}`;
export const FULL_KEY_RE = /^full\/(\d+)\.tar\.zst$/;
const BLOB_KEY_RE = /^blobs\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const MAX_CHANGES_PER_CALL = 200;

interface SnapshotRow {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  version_id: number;
  created_at: number;
}

async function existingBlobs(db: D1Database, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk([...new Set(hashes)], 90)) {
    const { results } = await db
      .prepare(`SELECT hash FROM blobs WHERE hash IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<{ hash: string }>();
    for (const r of results) found.add(r.hash);
  }
  return found;
}

/** Validates an R2 multipart key and checks that the caller may write to it. */
async function authorizeUploadKey(c: { env: AppEnv['Bindings']; get: (k: 'user') => AuthUser }, key: unknown) {
  if (typeof key !== 'string') throw badRequest('Upload key is required.');
  const user = c.get('user');
  const blob = BLOB_KEY_RE.exec(key);
  if (blob) {
    if (blob[1] !== blob[2]!.slice(0, 2)) throw badRequest('Invalid upload key.');
    if (user.role !== 'superadmin' && user.access !== 'write') throw forbidden('Your account has read-only access.');
    return { kind: 'blob' as const, key, hash: blob[2]! };
  }
  const full = FULL_KEY_RE.exec(key);
  if (full) {
    if (user.role !== 'superadmin') throw forbidden('Only the administrator can upload complete backups.');
    const row = await c.env.DB.prepare('SELECT status FROM full_backups WHERE id = ?').bind(Number(full[1])).first<{ status: string }>();
    if (!row) throw notFound('That backup no longer exists.');
    if (row.status !== 'uploading') throw conflict('That backup is already finished.');
    return { kind: 'full' as const, key, id: Number(full[1]) };
  }
  throw badRequest('Invalid upload key.');
}

async function recordBlob(db: D1Database, hash: string, size: number, storedSize: number) {
  await db
    .prepare('INSERT INTO blobs (hash, size, stored_size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING')
    .bind(hash, size, storedSize, Date.now())
    .run();
}

export function registerFiles(app: Hono<AppEnv>) {
  // ---- Browsing ----------------------------------------------------------------

  /** Folders that currently hold backed-up files, with aggregate counts (for folder pickers). */
  app.get('/api/folders', requireAuth, async (c) => {
    const { results } = await c.env.DB.prepare('SELECT path, size FROM files WHERE deleted = 0').all<{ path: string; size: number }>();
    const rows = filterReadable(c.get('user'), results);
    const folders = new Map<string, { files: number; bytes: number }>();
    for (const r of rows) {
      const segs = r.path.split('/');
      for (let i = 1; i < segs.length; i++) {
        const f = segs.slice(0, i).join('/');
        const agg = folders.get(f) ?? { files: 0, bytes: 0 };
        agg.files += 1;
        agg.bytes += r.size;
        folders.set(f, agg);
      }
    }
    return c.json({
      totalFiles: rows.length,
      totalBytes: rows.reduce((s, r) => s + r.size, 0),
      folders: [...folders.entries()].map(([path, a]) => ({ path, ...a })).sort((a, b) => a.path.localeCompare(b.path)),
    });
  });

  /** Every file as it existed at a moment in time (defaults to now). */
  app.get('/api/snapshot', requireAuth, async (c) => {
    const at = optionalInt(c.req.query('at'), 'at', Date.now(), { min: 0 });
    const { results } = await c.env.DB.prepare(
      `SELECT v.path, v.hash, v.size, v.mtime, v.id AS version_id, v.created_at
         FROM versions v
         JOIN (SELECT MAX(id) AS id FROM versions WHERE created_at <= ? GROUP BY path) last ON last.id = v.id
        WHERE v.op != 'delete'
        ORDER BY v.path`,
    )
      .bind(at)
      .all<SnapshotRow>();
    const files = filterReadable(c.get('user'), results).map((r) => ({
      path: r.path,
      hash: r.hash,
      size: r.size,
      mtime: r.mtime,
      versionId: r.version_id,
      changedAt: r.created_at,
    }));
    return c.json({ at, files });
  });

  /** Change events in a time window, for the restore timeline and diff view. */
  app.get('/api/timeline', requireAuth, async (c) => {
    const now = Date.now();
    const to = optionalInt(c.req.query('to'), 'to', now, { min: 0 });
    const from = optionalInt(c.req.query('from'), 'from', to - 7 * 86_400_000, { min: 0 });
    if (from > to) throw badRequest('"from" must be before "to".');
    const limit = optionalInt(c.req.query('limit'), 'limit', 20000, { min: 1, max: 50000 });
    const [events, bounds] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT id, path, op, hash, size, mtime, created_at, batch_id
           FROM versions WHERE created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?`,
      ).bind(from, to, limit),
      c.env.DB.prepare('SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM versions'),
    ]);
    const rows = filterReadable(c.get('user'), events!.results as { path: string }[]);
    const b = (bounds!.results[0] ?? {}) as { earliest: number | null; latest: number | null };
    return c.json({ from, to, earliest: b.earliest, latest: b.latest, truncated: events!.results.length >= limit, events: rows });
  });

  /** Full history of one file. */
  app.get('/api/versions', requireAuth, async (c) => {
    const path = normalizeRelPath(c.req.query('path'));
    if (!canRead(c.get('user'), path)) throw forbidden('You do not have access to that file.');
    const { results } = await c.env.DB.prepare(
      'SELECT id, op, hash, size, mtime, created_at, batch_id FROM versions WHERE path = ? ORDER BY id DESC LIMIT 500',
    )
      .bind(path)
      .all();
    return c.json({ path, versions: results });
  });

  // ---- File data (R2) -----------------------------------------------------------

  app.post('/api/blobs/missing', requireAuth, requireWrite, async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.hashes) || body.hashes.length > 1000) throw badRequest('Send between 0 and 1000 hashes.');
    const hashes = body.hashes.map((h) => hashParam(h));
    const found = await existingBlobs(c.env.DB, hashes);
    return c.json({ missing: [...new Set(hashes)].filter((h) => !found.has(h)) });
  });

  /** Single-request upload for compressed data up to ~90 MB. Larger data uses /api/uploads. */
  app.put('/api/blobs/:hash', requireAuth, requireWrite, async (c) => {
    const hash = hashParam(c.req.param('hash'));
    const size = int(c.req.header('x-raw-size'), 'X-Raw-Size header', { min: 0 });
    const length = int(c.req.header('content-length'), 'Content-Length header', { min: 1 });
    if (!c.req.raw.body) throw badRequest('Upload body is empty.');
    await c.env.BUCKET.put(blobKey(hash), c.req.raw.body, {
      httpMetadata: { contentType: 'application/zstd' },
      customMetadata: { rawSize: String(size) },
    });
    await recordBlob(c.env.DB, hash, size, length);
    return c.json({ ok: true, hash });
  });

  app.get('/api/blobs/:hash', requireAuth, async (c) => {
    const hash = hashParam(c.req.param('hash'));
    const user = c.get('user');
    if (user.role !== 'superadmin') {
      const { results } = await c.env.DB.prepare('SELECT DISTINCT path FROM versions WHERE hash = ? LIMIT 200').bind(hash).all<{ path: string }>();
      if (!results.some((r) => canRead(user, r.path))) throw forbidden('You do not have access to that file.');
    }
    const obj = await c.env.BUCKET.get(blobKey(hash));
    if (!obj) throw notFound('That file data is missing from storage.');
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/zstd',
        'content-length': String(obj.size),
        'x-raw-size': obj.customMetadata?.rawSize ?? '',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

  // ---- Multipart uploads (file data and complete backups larger than one request) ----

  app.post('/api/uploads', requireAuth, async (c) => {
    const body = await readJson(c);
    const target = await authorizeUploadKey(c, body.key);
    const upload = await c.env.BUCKET.createMultipartUpload(target.key, {
      httpMetadata: { contentType: 'application/zstd' },
      customMetadata: target.kind === 'blob' ? { rawSize: String(int(body.size, 'size', { min: 0 })) } : {},
    });
    return c.json({ key: upload.key, uploadId: upload.uploadId });
  });

  app.put('/api/uploads/:uploadId/parts/:part', requireAuth, async (c) => {
    const target = await authorizeUploadKey(c, c.req.query('key'));
    const part = int(c.req.param('part'), 'Part number', { min: 1, max: 10000 });
    if (!c.req.raw.body) throw badRequest('Upload body is empty.');
    const upload = c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param('uploadId'));
    try {
      const uploaded = await upload.uploadPart(part, c.req.raw.body);
      return c.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    } catch (err) {
      throw new ApiError(400, `Upload part failed: ${(err as Error).message}`, 'upload_failed');
    }
  });

  app.post('/api/uploads/:uploadId/complete', requireAuth, async (c) => {
    const body = await readJson(c);
    const target = await authorizeUploadKey(c, body.key);
    if (!Array.isArray(body.parts) || body.parts.length === 0) throw badRequest('Parts are required.');
    const parts = body.parts.map((p: any) => ({ partNumber: int(p?.partNumber, 'partNumber', { min: 1 }), etag: String(p?.etag ?? '') }));
    const upload = c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param('uploadId'));
    let obj: R2Object;
    try {
      obj = await upload.complete(parts);
    } catch (err) {
      throw new ApiError(400, `Could not finish the upload: ${(err as Error).message}`, 'upload_failed');
    }
    if (target.kind === 'blob') await recordBlob(c.env.DB, target.hash, int(body.size, 'size', { min: 0 }), obj.size);
    return c.json({ ok: true, size: obj.size });
  });

  app.delete('/api/uploads/:uploadId', requireAuth, async (c) => {
    const target = await authorizeUploadKey(c, c.req.query('key'));
    try {
      await c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param('uploadId')).abort();
    } catch {
      /* already gone */
    }
    return c.json({ ok: true });
  });

  // ---- Sync runs ------------------------------------------------------------------

  app.post('/api/batches', requireAuth, requireWrite, async (c) => {
    const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
    const device = typeof body.device === 'string' ? body.device.slice(0, 120) : c.req.header('x-device')?.slice(0, 120) ?? null;
    const res = await c.env.DB.prepare("INSERT INTO batches (user_id, device, started_at, status) VALUES (?, ?, ?, 'running')")
      .bind(c.get('user').id, device, Date.now())
      .run();
    return c.json({ id: Number(res.meta.last_row_id) });
  });

  app.post('/api/batches/:id/changes', requireAuth, requireWrite, async (c) => {
    const user = c.get('user');
    const id = int(c.req.param('id'), 'Batch id', { min: 1 });
    const batch = await c.env.DB.prepare('SELECT user_id, status FROM batches WHERE id = ?').bind(id).first<{ user_id: number; status: string }>();
    if (!batch) throw notFound('That sync run no longer exists.');
    if (batch.user_id !== user.id && user.role !== 'superadmin') throw forbidden();
    if (batch.status !== 'running') throw conflict('That sync run has already finished.');

    const body = await readJson(c);
    if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > MAX_CHANGES_PER_CALL) {
      throw badRequest(`Send between 1 and ${MAX_CHANGES_PER_CALL} changes per request.`);
    }
    const byPath = new Map<string, { path: string; op: 'upsert' | 'delete'; hash: string | null; size: number; mtime: number }>();
    for (const raw of body.changes as any[]) {
      const path = normalizeRelPath(raw?.path);
      if (!canWrite(user, path)) throw forbidden(`You cannot back up "${path}".`);
      const op = raw?.op === 'delete' ? 'delete' : raw?.op === 'upsert' ? 'upsert' : null;
      if (!op) throw badRequest('Each change needs op "upsert" or "delete".');
      byPath.set(path, {
        path,
        op,
        hash: op === 'upsert' ? hashParam(raw.hash) : null,
        size: op === 'upsert' ? int(raw.size, 'size', { min: 0 }) : 0,
        mtime: int(raw.mtime ?? 0, 'mtime', { min: 0 }),
      });
    }
    const changes = [...byPath.values()];
    const needed = changes.filter((ch) => ch.hash).map((ch) => ch.hash!);
    const present = await existingBlobs(c.env.DB, needed);
    const absent = needed.filter((h) => !present.has(h));
    if (absent.length) throw new ApiError(409, `File data for ${absent.length} file(s) has not been uploaded yet.`, 'missing_blobs');

    const current = new Map<string, { hash: string | null; deleted: number }>();
    for (const part of chunk(changes.map((ch) => ch.path), 90)) {
      const { results } = await c.env.DB.prepare(`SELECT path, hash, deleted FROM files WHERE path IN (${part.map(() => '?').join(',')})`)
        .bind(...part)
        .all<{ path: string; hash: string | null; deleted: number }>();
      for (const r of results) current.set(r.path, r);
    }

    const db = c.env.DB;
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    const counts = { add: 0, modify: 0, delete: 0, skipped: 0 };
    for (const ch of changes) {
      const cur = current.get(ch.path);
      const live = cur && !cur.deleted;
      let op: 'add' | 'modify' | 'delete';
      if (ch.op === 'delete') {
        if (!live) {
          counts.skipped++;
          continue;
        }
        op = 'delete';
      } else if (live && cur!.hash === ch.hash) {
        stmts.push(db.prepare('UPDATE files SET mtime = ? WHERE path = ?').bind(ch.mtime, ch.path));
        counts.skipped++;
        continue;
      } else {
        op = live ? 'modify' : 'add';
      }
      counts[op]++;
      stmts.push(
        db
          .prepare('INSERT INTO versions (path, op, hash, size, mtime, created_at, batch_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(ch.path, op, ch.hash, ch.size, ch.mtime, now, id, user.id),
        db
          .prepare(
            `INSERT INTO files (path, hash, size, mtime, deleted, version_id, updated_at)
             VALUES (?, ?, ?, ?, ?, (SELECT MAX(id) FROM versions WHERE path = ?), ?)
             ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
               deleted = excluded.deleted, version_id = excluded.version_id, updated_at = excluded.updated_at`,
          )
          .bind(ch.path, ch.hash, ch.size, ch.mtime, op === 'delete' ? 1 : 0, ch.path, now),
      );
    }
    stmts.push(
      db.prepare('UPDATE batches SET added = added + ?, modified = modified + ?, deleted = deleted + ? WHERE id = ?').bind(counts.add, counts.modify, counts.delete, id),
    );
    await db.batch(stmts);
    return c.json({ recorded: counts.add + counts.modify + counts.delete, ...counts });
  });

  app.post('/api/batches/:id/finish', requireAuth, requireWrite, async (c) => {
    const user = c.get('user');
    const id = int(c.req.param('id'), 'Batch id', { min: 1 });
    const body = await readJson(c);
    const batch = await c.env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first<{
      user_id: number;
      status: string;
      added: number;
      modified: number;
      deleted: number;
    }>();
    if (!batch) throw notFound('That sync run no longer exists.');
    if (batch.user_id !== user.id && user.role !== 'superadmin') throw forbidden();
    const status = body.status === 'failed' ? 'failed' : 'done';
    const message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;
    const bytes = typeof body.bytesUploaded === 'number' && body.bytesUploaded >= 0 ? Math.round(body.bytesUploaded) : 0;
    if (status === 'done' && batch.added + batch.modified + batch.deleted === 0) {
      // Nothing changed: keep history clean.
      await c.env.DB.prepare('DELETE FROM batches WHERE id = ?').bind(id).run();
      return c.json({ ok: true, empty: true });
    }
    await c.env.DB.prepare('UPDATE batches SET status = ?, message = ?, bytes_uploaded = ?, finished_at = ? WHERE id = ?')
      .bind(status, message, bytes, Date.now(), id)
      .run();
    return c.json({ ok: true });
  });

  app.get('/api/batches', requireAuth, async (c) => {
    const before = optionalInt(c.req.query('before'), 'before', Number.MAX_SAFE_INTEGER, { min: 1 });
    const limit = optionalInt(c.req.query('limit'), 'limit', 50, { min: 1, max: 200 });
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.device, b.started_at, b.finished_at, b.status, b.added, b.modified, b.deleted, b.bytes_uploaded, b.message,
              u.username, u.display_name
         FROM batches b LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id < ? ORDER BY b.id DESC LIMIT ?`,
    )
      .bind(before, limit)
      .all();
    return c.json({ batches: results });
  });

  app.get('/api/batches/:id/changes', requireAuth, async (c) => {
    const id = int(c.req.param('id'), 'Batch id', { min: 1 });
    const { results } = await c.env.DB.prepare(
      'SELECT id, path, op, hash, size, mtime, created_at FROM versions WHERE batch_id = ? ORDER BY path LIMIT 5000',
    )
      .bind(id)
      .all<{ path: string }>();
    return c.json({ changes: filterReadable(c.get('user'), results) });
  });
}
