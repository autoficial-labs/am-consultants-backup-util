import type { Env } from './types';
import { chunk } from './lib/http';
import { loadPolicy } from './lib/policy';
import { blobKey } from './routes/files';
import { tallyKey } from './routes/tally';

const DAY = 86_400_000;

/**
 * Nightly housekeeping. Safe to run any time; each step is idempotent.
 *  - drops expired sessions
 *  - trims change history older than the retention window, while keeping the newest
 *    version before the cut-off so every moment inside the window stays restorable
 *  - deletes file data no longer referenced by any version (after a 1-day grace period)
 *  - fails sync runs and complete backups that never finished
 *  - trims Tally snapshots to the same window (the newest per company is always kept)
 */
export async function runMaintenance(env: Env) {
  const db = env.DB;
  const now = Date.now();
  const policy = await loadPolicy(db);
  const report = { sessions: 0, versions: 0, tombstones: 0, blobs: 0, staleBatches: 0, staleFull: 0, audit: 0, tallySnapshots: 0, tallyData: 0 };

  report.sessions = (await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run()).meta.changes ?? 0;

  if (policy.retention.versionDays > 0) {
    const cutoff = now - policy.retention.versionDays * DAY;
    report.versions =
      (
        await db
          .prepare(
            `DELETE FROM versions WHERE created_at < ?1
               AND id NOT IN (SELECT MAX(id) FROM versions WHERE created_at < ?1 GROUP BY path)`,
          )
          .bind(cutoff)
          .run()
      ).meta.changes ?? 0;
    // Files deleted before the window began no longer need any history.
    const res = await db.batch([
      db.prepare('DELETE FROM versions WHERE path IN (SELECT path FROM files WHERE deleted = 1 AND updated_at < ?)').bind(cutoff),
      db.prepare('DELETE FROM files WHERE deleted = 1 AND updated_at < ?').bind(cutoff),
    ]);
    report.tombstones = res[1]?.meta.changes ?? 0;
  }

  for (let round = 0; round < 10; round++) {
    const { results } = await db
      .prepare(
        `SELECT hash FROM blobs b WHERE b.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.hash = b.hash) LIMIT 500`,
      )
      .bind(now - DAY)
      .all<{ hash: string }>();
    if (!results.length) break;
    await env.BUCKET.delete(results.map((r) => blobKey(r.hash)));
    await db.batch(results.map((r) => db.prepare('DELETE FROM blobs WHERE hash = ?').bind(r.hash)));
    report.blobs += results.length;
  }

  report.staleBatches =
    (
      await db
        .prepare("UPDATE batches SET status = 'failed', message = 'Interrupted', finished_at = ? WHERE status = 'running' AND started_at < ?")
        .bind(now, now - DAY)
        .run()
    ).meta.changes ?? 0;

  const { results: stale } = await db
    .prepare("SELECT id, r2_key FROM full_backups WHERE status = 'uploading' AND created_at < ?")
    .bind(now - 2 * DAY)
    .all<{ id: number; r2_key: string }>();
  for (const row of stale) {
    await env.BUCKET.delete([row.r2_key, `full/${row.id}.manifest.json`]);
    await db.prepare("UPDATE full_backups SET status = 'failed', note = 'Interrupted', completed_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  report.staleFull = stale.length;
  // Failed attempts are only interesting for a week.
  await db.prepare("DELETE FROM full_backups WHERE status = 'failed' AND created_at < ?").bind(now - 7 * DAY).run();

  report.audit = (await db.prepare('DELETE FROM audit_log WHERE at < ?').bind(now - 365 * DAY).run()).meta.changes ?? 0;

  if (policy.retention.versionDays > 0) {
    report.tallySnapshots =
      (
        await db
          .prepare('DELETE FROM tally_snapshots WHERE captured_at < ? AND id NOT IN (SELECT MAX(id) FROM tally_snapshots GROUP BY company_key)')
          .bind(now - policy.retention.versionDays * DAY)
          .run()
      ).meta.changes ?? 0;
  }
  // Snapshot data no snapshot points to any more (a day's grace covers uploads still being recorded).
  let cursor: string | undefined;
  for (let round = 0; round < 10; round++) {
    const page = await env.BUCKET.list({ prefix: 'tally/', cursor, limit: 500 });
    const old = page.objects.filter((o) => o.uploaded.getTime() < now - DAY);
    const hashes = old.map((o) => o.key.slice('tally/'.length, -'.json.gz'.length));
    if (hashes.length) {
      const used = new Set<string>();
      for (const part of chunk(hashes, 90)) {
        const { results } = await db
          .prepare(`SELECT DISTINCT hash FROM tally_snapshots WHERE hash IN (${part.map(() => '?').join(',')})`)
          .bind(...part)
          .all<{ hash: string }>();
        for (const r of results) used.add(r.hash);
      }
      const unused = hashes.filter((h) => !used.has(h));
      if (unused.length) await env.BUCKET.delete(unused.map(tallyKey));
      report.tallyData += unused.length;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return report;
}
