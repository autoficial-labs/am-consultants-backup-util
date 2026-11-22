//! Incremental backup: upload new and changed files, record deletions.

use anyhow::{anyhow, bail, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::api::Api;
use crate::fsutil::{self, changed_since, folder_state, is_locked, mtime_ms, pack_file, rel_to_path, unit_of, FileEntry};
use crate::index::{IndexEntry, LocalIndex};
use crate::model::{Progress, ProgressFn, UserInfo};

const GROUP_FILES: usize = 64;
const GROUP_BYTES: u64 = 256 * 1024 * 1024;
const COMMIT_CHUNK: usize = 200;
const PACK_LEVEL: i32 = 3;
/// Folders up to this size are copied as one checked set (all files staged, then verified that
/// nothing in the folder changed during the copy). Larger folders are streamed group by group.
const CONSISTENT_MAX_FILES: usize = 2000;
const CONSISTENT_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub struct SyncOptions {
    pub root: PathBuf,
    pub excludes: Vec<String>,
    pub index_path: PathBuf,
    pub staging: PathBuf,
    pub user: UserInfo,
    pub device: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
    pub unchanged: u32,
    pub uploaded_bytes: u64,
    /// Files skipped because another program was using them; retried next time.
    pub busy: Vec<String>,
    pub batch_id: Option<i64>,
    /// Deletions were not recorded because the folder could not be fully read.
    pub deletions_deferred: bool,
    /// Folders whose files changed while they were copied (Tally saved something); the copy
    /// was discarded and is taken again when the files are quiet.
    pub retried_folders: Vec<String>,
}

impl SyncReport {
    pub fn changed(&self) -> u32 {
        self.added + self.modified + self.deleted
    }
}

#[derive(Deserialize)]
struct CommitResult {
    add: u32,
    modify: u32,
    delete: u32,
}

#[derive(Deserialize)]
struct Missing {
    missing: Vec<String>,
}

enum PackOutcome {
    Ready { entry: FileEntry, hash: String, packed: PathBuf, packed_size: u64 },
    Busy(String),
    Gone,
}

/// Deletes the staging folder when dropped, even on errors.
struct StagingGuard(PathBuf);
impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pack_group(root: &Path, staging: &Path, group: &[FileEntry]) -> Result<Vec<PackOutcome>> {
    let mut out = Vec::with_capacity(group.len());
    for (i, f) in group.iter().enumerate() {
        let src = rel_to_path(root, &f.rel)?;
        let before = match fs::metadata(&src) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                out.push(PackOutcome::Gone);
                continue;
            }
            Err(_) => {
                out.push(PackOutcome::Busy(f.rel.clone()));
                continue;
            }
        };
        let dst = staging.join(format!("{i}.zst"));
        match pack_file(&src, &dst, PACK_LEVEL) {
            Ok(p) => {
                // If the file changed while we read it, the copy may be torn: try again later.
                let after = fs::metadata(&src).ok();
                let stable = after.as_ref().is_some_and(|a| a.len() == before.len() && mtime_ms(a) == mtime_ms(&before)) && p.size == before.len();
                if !stable {
                    let _ = fs::remove_file(&dst);
                    out.push(PackOutcome::Busy(f.rel.clone()));
                    continue;
                }
                out.push(PackOutcome::Ready {
                    entry: FileEntry { rel: f.rel.clone(), size: p.size, mtime: mtime_ms(&before) },
                    hash: p.hash,
                    packed: dst,
                    packed_size: p.packed_size,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => out.push(PackOutcome::Gone),
            Err(e) if is_locked(&e) || e.kind() == std::io::ErrorKind::PermissionDenied => out.push(PackOutcome::Busy(f.rel.clone())),
            Err(e) => return Err(anyhow!("Could not read \"{}\": {e}", f.rel)),
        }
    }
    Ok(out)
}

fn groups(files: Vec<FileEntry>) -> Vec<Vec<FileEntry>> {
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut bytes = 0u64;
    for f in files {
        if !cur.is_empty() && (cur.len() >= GROUP_FILES || bytes + f.size > GROUP_BYTES) {
            out.push(std::mem::take(&mut cur));
            bytes = 0;
        }
        bytes += f.size;
        cur.push(f);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub async fn run_sync(api: &Api, opts: &SyncOptions, progress: &ProgressFn, cancel: &AtomicBool) -> Result<SyncReport> {
    progress(Progress { stage: "Checking for changes".into(), ..Default::default() });
    let root = opts.root.clone();
    let excludes = opts.excludes.clone();
    let scan = tokio::task::spawn_blocking(move || fsutil::scan(&root, &excludes)).await??;
    let root_str = opts.root.display().to_string();
    let mut index = LocalIndex::load(&opts.index_path, &root_str);

    let current: Vec<FileEntry> = scan.files.into_iter().filter(|f| opts.user.can_write(&f.rel)).collect();
    let present: HashSet<&str> = current.iter().map(|f| f.rel.as_str()).collect();
    let mut report = SyncReport::default();
    let mut candidates = Vec::new();
    for f in &current {
        match index.files.get(&f.rel) {
            Some(e) if e.size == f.size && e.mtime == f.mtime => report.unchanged += 1,
            _ => candidates.push(f.clone()),
        }
    }
    let mut deletions: Vec<String> =
        index.files.keys().filter(|k| !present.contains(k.as_str()) && opts.user.can_write(k)).cloned().collect();
    // Never mistake an unreadable or missing folder for "everything was deleted".
    if !deletions.is_empty() && (scan.errors > 0 || current.is_empty()) {
        deletions.clear();
        report.deletions_deferred = true;
    }
    if candidates.is_empty() && deletions.is_empty() {
        return Ok(report);
    }

    let batch: crate::api::IdResponse = api.post("/api/batches", &json!({ "device": opts.device })).await?;
    report.batch_id = Some(batch.id);
    let staging = opts.staging.join(format!("sync-{}", batch.id));
    fs::create_dir_all(&staging)?;
    let _guard = StagingGuard(staging.clone());

    let outcome = process(api, opts, batch.id, &staging, &mut index, candidates, deletions, &mut report, progress, cancel).await;
    let save = index.save(&opts.index_path);
    match outcome {
        Ok(()) => {
            save?;
            let _: serde_json::Value = api
                .post(&format!("/api/batches/{}/finish", batch.id), &json!({ "status": "done", "bytesUploaded": report.uploaded_bytes }))
                .await?;
            Ok(report)
        }
        Err(e) => {
            let _ = api
                .post::<serde_json::Value, _>(
                    &format!("/api/batches/{}/finish", batch.id),
                    &json!({ "status": "failed", "message": e.to_string(), "bytesUploaded": report.uploaded_bytes }),
                )
                .await;
            Err(e)
        }
    }
}

type Ready = (FileEntry, String, PathBuf, u64);

/// Sorts packed files into "upload" and "nothing to do", updating the counters.
fn sort_packed(packed: Vec<PackOutcome>, index: &mut LocalIndex, report: &mut SyncReport, done_files: &mut u64, done_bytes: &AtomicU64) -> Vec<Ready> {
    let mut ready = Vec::new();
    for p in packed {
        match p {
            PackOutcome::Ready { entry, hash, packed, packed_size } => {
                if index.files.get(&entry.rel).is_some_and(|e| e.hash == hash) {
                    // Only the timestamp changed; nothing to upload or record.
                    index.files.insert(entry.rel.clone(), IndexEntry { size: entry.size, mtime: entry.mtime, hash });
                    report.unchanged += 1;
                    let _ = fs::remove_file(&packed);
                    done_bytes.fetch_add(entry.size, Ordering::Relaxed);
                    *done_files += 1;
                } else {
                    ready.push((entry, hash, packed, packed_size));
                }
            }
            PackOutcome::Busy(rel) => {
                *done_files += 1;
                report.busy.push(rel);
            }
            PackOutcome::Gone => *done_files += 1,
        }
    }
    ready
}

/// Uploads the data that the server does not have yet, then records the new versions.
#[allow(clippy::too_many_arguments)]
async fn upload_and_commit(
    api: &Api,
    opts: &SyncOptions,
    commit_url: &str,
    ready: Vec<Ready>,
    index: &mut LocalIndex,
    report: &mut SyncReport,
    done_files: &mut u64,
    done_bytes: &AtomicU64,
) -> Result<()> {
    for chunk in ready.chunks(COMMIT_CHUNK) {
        let hashes: Vec<&String> = chunk.iter().map(|r| &r.1).collect();
        let missing: Missing = api.post("/api/blobs/missing", &json!({ "hashes": hashes })).await?;
        let missing: HashSet<String> = missing.missing.into_iter().collect();
        // Owned values keep the upload futures free of borrowed lifetimes (they run on a spawned task).
        let mut uploads: HashMap<String, (FileEntry, PathBuf, u64)> = HashMap::new();
        for (entry, hash, packed, packed_size) in chunk {
            if missing.contains(hash) {
                uploads.entry(hash.clone()).or_insert_with(|| (entry.clone(), packed.clone(), *packed_size));
            }
        }
        let uploaded = Arc::new(AtomicU64::new(0));
        stream::iter(uploads.into_iter().map(|(hash, (entry, packed, packed_size))| {
            let uploaded = uploaded.clone();
            async move {
                let packed = &packed;
                let key = format!("blobs/{}/{}", &hash[..2], hash);
                api.upload_file(
                    packed,
                    &key,
                    &format!("/api/blobs/{hash}"),
                    &[("x-raw-size", entry.size.to_string())],
                    json!({ "size": entry.size }),
                    &|_| {},
                )
                .await
                .map_err(|e| anyhow!("Upload of \"{}\" failed: {e}", entry.rel))?;
                uploaded.fetch_add(packed_size, Ordering::Relaxed);
                Ok::<_, anyhow::Error>(())
            }
        }))
        .buffer_unordered(3)
        .try_collect::<Vec<_>>()
        .await?;
        report.uploaded_bytes += uploaded.load(Ordering::Relaxed);

        let changes: Vec<_> = chunk
            .iter()
            .map(|(e, hash, _, _)| json!({ "path": e.rel, "op": "upsert", "hash": hash, "size": e.size, "mtime": e.mtime }))
            .collect();
        let r: CommitResult = api.post(commit_url, &json!({ "changes": changes })).await?;
        report.added += r.add;
        report.modified += r.modify;
        for (e, hash, packed, _) in chunk {
            index.files.insert(e.rel.clone(), IndexEntry { size: e.size, mtime: e.mtime, hash: hash.clone() });
            let _ = fs::remove_file(packed);
            done_bytes.fetch_add(e.size, Ordering::Relaxed);
            *done_files += 1;
        }
        index.save(&opts.index_path)?;
    }
    Ok(())
}

async fn pack_blocking(opts: &SyncOptions, staging: &Path, group: Vec<FileEntry>, offset: usize) -> Result<Vec<PackOutcome>> {
    let root = opts.root.clone();
    let stage_dir = staging.join(format!("g{offset}"));
    fs::create_dir_all(&stage_dir)?;
    tokio::task::spawn_blocking(move || pack_group(&root, &stage_dir, &group)).await?
}

#[allow(clippy::too_many_arguments)]
async fn process(
    api: &Api,
    opts: &SyncOptions,
    batch_id: i64,
    staging: &Path,
    index: &mut LocalIndex,
    candidates: Vec<FileEntry>,
    deletions: Vec<String>,
    report: &mut SyncReport,
    progress: &ProgressFn,
    cancel: &AtomicBool,
) -> Result<()> {
    let commit_url = format!("/api/batches/{batch_id}/changes");

    for chunk in deletions.chunks(COMMIT_CHUNK) {
        let changes: Vec<_> = chunk.iter().map(|p| json!({ "path": p, "op": "delete" })).collect();
        let r: CommitResult = api.post(&commit_url, &json!({ "changes": changes })).await?;
        report.deleted += r.delete;
        for p in chunk {
            index.files.remove(p);
        }
        index.save(&opts.index_path)?;
    }

    let total_files = candidates.len() as u64;
    let total_bytes: u64 = candidates.iter().map(|f| f.size).sum();
    let done_bytes = AtomicU64::new(0);
    let mut done_files = 0u64;
    let emit = |stage: &str, done_files: u64, current: Option<String>, done: u64| {
        progress(Progress { stage: stage.into(), done_files, total_files, done_bytes: done, total_bytes, current });
    };

    // One folder at a time: for Tally, each company folder must be backed up as a consistent set.
    let mut units: BTreeMap<String, Vec<FileEntry>> = BTreeMap::new();
    for f in candidates {
        units.entry(unit_of(&f.rel).to_string()).or_default().push(f);
    }
    let mut offset = 0usize;
    for (unit, files) in units {
        if cancel.load(Ordering::Relaxed) {
            bail!("Backup was stopped.");
        }
        let unit_bytes: u64 = files.iter().map(|f| f.size).sum();
        let checked = files.len() <= CONSISTENT_MAX_FILES && unit_bytes <= CONSISTENT_MAX_BYTES;

        if !checked {
            for group in groups(files) {
                if cancel.load(Ordering::Relaxed) {
                    bail!("Backup was stopped.");
                }
                emit("Preparing files", done_files, group.first().map(|f| f.rel.clone()), done_bytes.load(Ordering::Relaxed));
                offset += group.len();
                let packed = pack_blocking(opts, staging, group, offset).await?;
                let ready = sort_packed(packed, index, report, &mut done_files, &done_bytes);
                upload_and_commit(api, opts, &commit_url, ready, index, report, &mut done_files, &done_bytes).await?;
                emit("Uploading changes", done_files, None, done_bytes.load(Ordering::Relaxed));
            }
            continue;
        }

        let (root, ex, u) = (opts.root.clone(), opts.excludes.clone(), unit.clone());
        let before = tokio::task::spawn_blocking(move || folder_state(&root, &u, &ex)).await?;
        let mut packed = Vec::new();
        for group in groups(files.clone()) {
            if cancel.load(Ordering::Relaxed) {
                bail!("Backup was stopped.");
            }
            emit("Preparing files", done_files, group.first().map(|f| f.rel.clone()), done_bytes.load(Ordering::Relaxed));
            offset += group.len();
            packed.extend(pack_blocking(opts, staging, group, offset).await?);
        }
        let (root, ex, u) = (opts.root.clone(), opts.excludes.clone(), unit.clone());
        let after = tokio::task::spawn_blocking(move || folder_state(&root, &u, &ex)).await?;
        let changed = changed_since(&before, &after);
        if !changed.is_empty() {
            // Something in this folder was saved while we copied it: drop the whole set.
            for p in &packed {
                if let PackOutcome::Ready { packed, .. } = p {
                    let _ = fs::remove_file(packed);
                }
            }
            done_files += files.len() as u64;
            done_bytes.fetch_add(unit_bytes, Ordering::Relaxed);
            report.retried_folders.push(if unit.is_empty() { "the backup folder".into() } else { unit.clone() });
            continue;
        }
        let ready = sort_packed(packed, index, report, &mut done_files, &done_bytes);
        upload_and_commit(api, opts, &commit_url, ready, index, report, &mut done_files, &done_bytes).await?;
        index.save(&opts.index_path)?;
        emit("Uploading changes", done_files, None, done_bytes.load(Ordering::Relaxed));
    }
    Ok(())
}
