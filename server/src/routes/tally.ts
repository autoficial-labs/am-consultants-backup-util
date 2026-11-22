import type { Hono } from 'hono';
import type { AppEnv, AuthUser } from '../types';
import { requireAuth, requireWrite } from '../lib/auth';
import { badRequest, forbidden, hashParam, int, notFound, optionalInt, readJson, str } from '../lib/http';
import { canRead, canWrite, normalizeRelPath } from '../lib/paths';

export const tallyKey = (hash: string) => `tally/${hash}.json.gz`;
const MAX_SNAPSHOT_BYTES = 60 * 1024 * 1024;

interface SnapshotRow {
  id: number;
  company_key: string;
  company_name: string;
  folder: string | null;
  captured_at: number;
  hash: string;
  raw_size: number;
  stored_size: number;
  ledgers: number;
  vouchers: number;
  last_voucher: string | null;
  device: string | null;
}

/** A snapshot is visible to whoever may read its company folder; unlinked ones only to the administrator. */
function mayRead(user: AuthUser, folder: string | null) {
  return user.role === 'superadmin' || (folder !== null && canRead(user, folder));
}

const view = (r: SnapshotRow) => ({
  id: r.id,
  companyKey: r.company_key,
  companyName: r.company_name,
  folder: r.folder,
  capturedAt: r.captured_at,
  hash: r.hash,
  rawSize: r.raw_size,
  storedSize: r.stored_size,
  ledgers: r.ledgers,
  vouchers: r.vouchers,
  lastVoucher: r.last_voucher,
  device: r.device,
});

export function registerTally(app: Hono<AppEnv>) {
  // Snapshot data, gzip-compressed by the app. Stored once per content hash.
  app.put('/api/tally/data/:hash', requireAuth, requireWrite, async (c) => {
    const hash = hashParam(c.req.param('hash'));
    const length = int(c.req.header('content-length'), 'Content-Length header', { min: 1, max: MAX_SNAPSHOT_BYTES });
    const raw = int(c.req.header('x-raw-size'), 'X-Raw-Size header', { min: 1 });
    if (!c.req.raw.body) throw badRequest('Upload body is empty.');
    const key = tallyKey(hash);
    if (await c.env.BUCKET.head(key)) {
      await c.req.raw.body.cancel();
      return c.json({ ok: true, stored: false });
    }
    await c.env.BUCKET.put(key, c.req.raw.body, {
      httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      customMetadata: { rawSize: String(raw), storedSize: String(length) },
    });
    return c.json({ ok: true, stored: true });
  });

  app.post('/api/tally/snapshots', requireAuth, requireWrite, async (c) => {
    const user = c.get('user');
    const b = await readJson(c);
    const hash = hashParam(b.hash);
    const companyName = str(b.companyName, 'Company name', { min: 1, max: 200 });
    const companyKey = str(b.companyKey, 'Company key', { min: 1, max: 200 });
    const folder = b.folder === null || b.folder === undefined || b.folder === '' ? null : normalizeRelPath(b.folder, 'Company folder');
    if (folder ? !canWrite(user, folder) : user.role !== 'superadmin') throw forbidden('You cannot back up that company folder.');
    const head = await c.env.BUCKET.head(tallyKey(hash));
    if (!head) throw badRequest('Upload the snapshot data first.');
    const capturedAt = int(b.capturedAt, 'Captured at', { min: 0 });
    const lastVoucher = typeof b.lastVoucher === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.lastVoucher) ? b.lastVoucher : null;
    const res = await c.env.DB.prepare(
      `INSERT INTO tally_snapshots (company_key, company_name, folder, captured_at, hash, raw_size, stored_size, ledgers, vouchers, last_voucher, device, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        companyKey,
        companyName,
        folder,
        Math.min(capturedAt, Date.now() + 60_000),
        hash,
        Number(head.customMetadata?.rawSize ?? 0),
        head.size,
        int(b.ledgers ?? 0, 'Ledgers', { min: 0 }),
        int(b.vouchers ?? 0, 'Vouchers', { min: 0 }),
        lastVoucher,
        c.req.header('x-device')?.slice(0, 80) ?? null,
        user.id,
      )
      .run();
    return c.json({ id: Number(res.meta.last_row_id) });
  });

  /** Companies that have snapshots, newest first. */
  app.get('/api/tally/companies', requireAuth, async (c) => {
    const user = c.get('user');
    const { results } = await c.env.DB.prepare(
      `SELECT s.company_key, s.company_name, s.folder, s.captured_at AS latest, s.vouchers, s.ledgers, s.last_voucher,
              agg.n, agg.first
         FROM tally_snapshots s
         JOIN (SELECT company_key, COUNT(*) AS n, MIN(captured_at) AS first, MAX(id) AS last_id FROM tally_snapshots GROUP BY company_key) agg
           ON agg.last_id = s.id
        ORDER BY s.company_name COLLATE NOCASE`,
    ).all<{
      company_key: string;
      company_name: string;
      folder: string | null;
      latest: number;
      vouchers: number;
      ledgers: number;
      last_voucher: string | null;
      n: number;
      first: number;
    }>();
    return c.json({
      companies: results
        .filter((r) => mayRead(user, r.folder))
        .map((r) => ({
          companyKey: r.company_key,
          companyName: r.company_name,
          folder: r.folder,
          snapshots: r.n,
          firstAt: r.first,
          latestAt: r.latest,
          ledgers: r.ledgers,
          vouchers: r.vouchers,
          lastVoucher: r.last_voucher,
        })),
    });
  });

  app.get('/api/tally/snapshots', requireAuth, async (c) => {
    const user = c.get('user');
    const company = str(c.req.query('company'), 'Company', { min: 1, max: 200 });
    const limit = optionalInt(c.req.query('limit'), 'limit', 500, { min: 1, max: 2000 });
    const { results } = await c.env.DB.prepare('SELECT * FROM tally_snapshots WHERE company_key = ? ORDER BY captured_at DESC, id DESC LIMIT ?')
      .bind(company, limit)
      .all<SnapshotRow>();
    return c.json({ snapshots: results.filter((r) => mayRead(user, r.folder)).map(view) });
  });

  app.get('/api/tally/snapshots/:id/data', requireAuth, async (c) => {
    const user = c.get('user');
    const id = int(Number(c.req.param('id')), 'Snapshot', { min: 1 });
    const row = await c.env.DB.prepare('SELECT * FROM tally_snapshots WHERE id = ?').bind(id).first<SnapshotRow>();
    if (!row || !mayRead(user, row.folder)) throw notFound('That Tally snapshot does not exist.');
    const obj = await c.env.BUCKET.get(tallyKey(row.hash));
    if (!obj) throw notFound('The snapshot data is missing from storage.');
    // Already gzip-compressed: pass it through untouched; clients decompress it transparently.
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': 'private, max-age=31536000, immutable',
      },
      encodeBody: 'manual',
    });
  });
}
