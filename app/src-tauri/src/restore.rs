//! Restore planning (what will change) and execution, from a point in time or a complete backup.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncWriteExt;

use crate::api::Api;
use crate::fsutil::{self, is_locked, is_under, path_key, rel_to_path, set_mtime, temp_sibling, unpack_file, FileEntry};
use crate::full::fetch_manifest;
use crate::model::{now_ms, Progress, ProgressFn, UserInfo};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestoreSource {
    #[serde(rename = "pointInTime")]
    PointInTime { at: i64 },
    #[serde(rename = "full")]
    Full { id: i64 },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    /// Missing at the destination; will be brought back.
    Restore,
    /// Present but different; will be replaced with the backed-up version.
    Overwrite,
    /// Already identical; nothing to do.
    Same,
    /// Only exists at the destination (e.g. created after the restore point).
    Extra,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub path: String,
    pub status: ItemStatus,
    pub size: u64,
    pub mtime: i64,
    pub hash: Option<String>,
    pub changed_at: Option<i64>,
    pub local_size: Option<u64>,
    pub local_mtime: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub restore: u64,
    pub overwrite: u64,
    pub same: u64,
    pub extra: u64,
    pub download_bytes: u64,
    pub total_files: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub id: String,
    pub source: RestoreSource,
    pub dest: String,
    pub created_at: i64,
    pub include: Vec<String>,
    pub items: Vec<PlanItem>,
    pub summary: PlanSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedItem {
    pub path: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: u64,
    pub removed: u64,
    pub bytes: u64,
    pub failed: Vec<FailedItem>,
    pub seconds: u64,
    pub cancelled: bool,
}

struct SourceFile {
    path: String,
    size: u64,
    mtime: i64,
    hash: Option<String>,
    changed_at: Option<i64>,
}

#[derive(Deserialize)]
struct Snapshot {
    files: Vec<SnapFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapFile {
    path: String,
    hash: String,
    size: u64,
    mtime: i64,
    changed_at: Option<i64>,
}

async fn source_files(api: &Api, source: &RestoreSource) -> Result<Vec<SourceFile>> {
    Ok(match source {
        RestoreSource::PointInTime { at } => {
            let snap: Snapshot = api.get(&format!("/api/snapshot?at={at}")).await?;
            snap.files
                .into_iter()
                .map(|f| SourceFile { path: f.path, size: f.size, mtime: f.mtime, hash: Some(f.hash), changed_at: f.changed_at })
                .collect()
        }
        RestoreSource::Full { id } => {
            let m = fetch_manifest(api, *id).await?;
            m.files
                .into_iter()
                .map(|f| SourceFile { path: f.path, size: f.size, mtime: f.mtime, hash: Some(f.sha256), changed_at: None })
                .collect()
        }
    })
}

/// Compares the backup with the destination folder so the user can see every difference before anything is written.
pub async fn build_plan(
    api: &Api,
    source: RestoreSource,
    dest: &Path,
    include: Vec<String>,
    excludes: Vec<String>,
    user: &UserInfo,
) -> Result<RestorePlan> {
    let in_scope = |rel: &str| include.is_empty() || include.iter().any(|i| is_under(rel, i));
    let files: Vec<SourceFile> =
        source_files(api, &source).await?.into_iter().filter(|f| in_scope(&f.path) && user.scope_allows(&f.path)).collect();

    let local: Vec<FileEntry> = if dest.is_dir() {
        let d = dest.to_path_buf();
        tokio::task::spawn_blocking(move || fsutil::scan(&d, &excludes)).await??.files
    } else {
        Vec::new()
    };
    let local_map: HashMap<String, &FileEntry> = local.iter().map(|f| (path_key(&f.rel), f)).collect();

    // Files with equal size but different timestamps need a content check.
    let mut to_hash: Vec<(usize, PathBuf)> = Vec::new();
    let mut items: Vec<PlanItem> = Vec::with_capacity(files.len());
    for f in &files {
        let l = local_map.get(&path_key(&f.path));
        let status = match l {
            None => ItemStatus::Restore,
            Some(l) if l.size != f.size => ItemStatus::Overwrite,
            Some(l) if l.mtime == f.mtime => ItemStatus::Same,
            Some(l) => {
                to_hash.push((items.len(), rel_to_path(dest, &l.rel)?));
                ItemStatus::Same
            }
        };
        items.push(PlanItem {
            path: f.path.clone(),
            status,
            size: f.size,
            mtime: f.mtime,
            hash: f.hash.clone(),
            changed_at: f.changed_at,
            local_size: l.map(|l| l.size),
            local_mtime: l.map(|l| l.mtime),
        });
    }
    if !to_hash.is_empty() {
        let hashes = tokio::task::spawn_blocking(move || {
            to_hash.into_iter().map(|(i, p)| (i, fsutil::sha256_file(&p).ok())).collect::<Vec<_>>()
        })
        .await?;
        for (i, h) in hashes {
            let item = &mut items[i];
            if h.is_none() || h != item.hash {
                item.status = ItemStatus::Overwrite;
            }
        }
    }

    let source_keys: HashSet<String> = files.iter().map(|f| path_key(&f.path)).collect();
    for l in &local {
        if !source_keys.contains(&path_key(&l.rel)) && in_scope(&l.rel) && user.scope_allows(&l.rel) {
            items.push(PlanItem {
                path: l.rel.clone(),
                status: ItemStatus::Extra,
                size: 0,
                mtime: 0,
                hash: None,
                changed_at: None,
                local_size: Some(l.size),
                local_mtime: Some(l.mtime),
            });
        }
    }
    items.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));

    let mut summary = PlanSummary::default();
    for i in &items {
        match i.status {
            ItemStatus::Restore => summary.restore += 1,
            ItemStatus::Overwrite => summary.overwrite += 1,
            ItemStatus::Same => summary.same += 1,
            ItemStatus::Extra => summary.extra += 1,
        }
        if matches!(i.status, ItemStatus::Restore | ItemStatus::Overwrite) {
            summary.download_bytes += i.size;
        }
        if i.status != ItemStatus::Extra {
            summary.total_files += 1;
            summary.total_bytes += i.size;
        }
    }

    Ok(RestorePlan {
        id: format!("plan-{}", now_ms()),
        source,
        dest: dest.display().to_string(),
        created_at: now_ms(),
        include,
        items,
        summary,
    })
}

/// Moves a finished temp file over the target, clearing a read-only flag if needed.
fn replace_file(tmp: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(tmp, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied && target.exists() => {
            if let Ok(meta) = fs::metadata(target) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(target, perms);
                }
            }
            fs::rename(tmp, target)
        }
        Err(e) => Err(e),
    }
}

fn friendly_io(e: &anyhow::Error) -> String {
    if let Some(io) = e.downcast_ref::<io::Error>() {
        if is_locked(io) || io.kind() == io::ErrorKind::PermissionDenied {
            return "The file is in use or protected. Close Tally and try again.".into();
        }
    }
    e.to_string()
}

struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct ExecuteOptions {
    /// Limit the restore to these paths; `None` restores everything that differs.
    pub paths: Option<HashSet<String>>,
    /// Send files that did not exist in the backup to the Recycle Bin.
    pub remove_extras: bool,
}

pub async fn execute(
    api: &Api,
    plan: &RestorePlan,
    opts: &ExecuteOptions,
    staging: &Path,
    progress: &ProgressFn,
    cancel: &Arc<AtomicBool>,
) -> Result<RestoreReport> {
    let started = Instant::now();
    let dest = PathBuf::from(&plan.dest);
    fs::create_dir_all(&dest).with_context(|| format!("Cannot create the folder {}", dest.display()))?;
    let chosen = |p: &str| opts.paths.as_ref().is_none_or(|set| set.contains(p));
    let todo: Vec<PlanItem> = plan
        .items
        .iter()
        .filter(|i| matches!(i.status, ItemStatus::Restore | ItemStatus::Overwrite) && chosen(&i.path))
        .cloned()
        .collect();
    let work = staging.join(format!("restore-{}", now_ms()));
    fs::create_dir_all(&work)?;
    let _guard = DirGuard(work.clone());

    let mut report = match &plan.source {
        RestoreSource::PointInTime { .. } => restore_from_blobs(api, &dest, todo, &work, progress, cancel).await?,
        RestoreSource::Full { id } => restore_from_archive(api, *id, &dest, todo, &work, progress, cancel).await?,
    };

    if opts.remove_extras && !cancel.load(Ordering::Relaxed) {
        let extras: Vec<PathBuf> = plan
            .items
            .iter()
            .filter(|i| i.status == ItemStatus::Extra && chosen(&i.path))
            .filter_map(|i| rel_to_path(&dest, &i.path).ok())
            .filter(|p| p.exists())
            .collect();
        if !extras.is_empty() {
            let n = extras.len() as u64;
            match tokio::task::spawn_blocking(move || trash::delete_all(&extras)).await? {
                Ok(()) => report.removed = n,
                Err(e) => report.failed.push(FailedItem { path: "(extra files)".into(), error: format!("Could not move to Recycle Bin: {e}") }),
            }
        }
    }
    report.cancelled = cancel.load(Ordering::Relaxed);
    report.seconds = started.elapsed().as_secs();
    Ok(report)
}

async fn restore_from_blobs(
    api: &Api,
    dest: &Path,
    todo: Vec<PlanItem>,
    work: &Path,
    progress: &ProgressFn,
    cancel: &Arc<AtomicBool>,
) -> Result<RestoreReport> {
    let total_files = todo.len() as u64;
    let total_bytes: u64 = todo.iter().map(|i| i.size).sum();
    let done_files = Arc::new(AtomicU64::new(0));
    let done_bytes = Arc::new(AtomicU64::new(0));
    progress(Progress { stage: "Restoring files".into(), total_files, total_bytes, ..Default::default() });

    let results: Vec<(String, Result<u64>)> = stream::iter(todo.into_iter().enumerate().map(|(n, item)| {
        let done_files = done_files.clone();
        let done_bytes = done_bytes.clone();
        let progress = progress.clone();
        async move {
            if cancel.load(Ordering::Relaxed) {
                return (item.path.clone(), Err(anyhow!("Cancelled")));
            }
            let res = async {
                let hash = item.hash.clone().ok_or_else(|| anyhow!("No data recorded for this file"))?;
                let packed = work.join(format!("{n}.zst"));
                let res = api.download(&format!("/api/blobs/{hash}"), None).await?;
                let mut out = tokio::fs::File::create(&packed).await?;
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    out.write_all(&chunk.map_err(|e| anyhow!("Download interrupted: {e}"))?).await?;
                }
                out.flush().await?;
                drop(out);
                let target = rel_to_path(dest, &item.path)?;
                let mtime = item.mtime;
                tokio::task::spawn_blocking(move || -> Result<u64> {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let tmp = temp_sibling(&target);
                    let size = unpack_file(&packed, &tmp, &hash)?;
                    let _ = fs::remove_file(&packed);
                    set_mtime(&tmp, mtime)?;
                    replace_file(&tmp, &target).inspect_err(|_| {
                        let _ = fs::remove_file(&tmp);
                    })?;
                    Ok(size)
                })
                .await?
            }
            .await;
            let files = done_files.fetch_add(1, Ordering::Relaxed) + 1;
            let bytes = done_bytes.fetch_add(item.size, Ordering::Relaxed) + item.size;
            progress(Progress {
                stage: "Restoring files".into(),
                done_files: files,
                total_files,
                done_bytes: bytes,
                total_bytes,
                current: Some(item.path.clone()),
            });
            (item.path, res)
        }
    }))
    .buffer_unordered(4)
    .collect()
    .await;

    let mut report = RestoreReport::default();
    for (path, r) in results {
        match r {
            Ok(bytes) => {
                report.restored += 1;
                report.bytes += bytes;
            }
            Err(e) if cancel.load(Ordering::Relaxed) && e.to_string() == "Cancelled" => {}
            Err(e) => report.failed.push(FailedItem { path, error: friendly_io(&e) }),
        }
    }
    Ok(report)
}

fn tar_rel(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

async fn download_archive(api: &Api, id: i64, target: &Path, progress: &ProgressFn, cancel: &Arc<AtomicBool>) -> Result<()> {
    let url = format!("/api/full-backups/{id}/download");
    let mut offset = 0u64;
    let mut total = 0u64;
    let mut attempts = 0;
    let mut file = tokio::fs::File::create(target).await?;
    loop {
        let result: Result<()> = async {
            let res = api.download(&url, Some(offset)).await?;
            let partial = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            if !partial && offset > 0 {
                // Server ignored the range: start over.
                file.set_len(0).await?;
                offset = 0;
            }
            total = offset + res.content_length().unwrap_or(0);
            let mut body = res.bytes_stream();
            while let Some(chunk) = body.next().await {
                if cancel.load(Ordering::Relaxed) {
                    bail!("Cancelled");
                }
                let chunk = chunk.map_err(|e| anyhow!("Download interrupted: {e}"))?;
                file.write_all(&chunk).await?;
                offset += chunk.len() as u64;
                progress(Progress {
                    stage: "Downloading backup".into(),
                    done_bytes: offset,
                    total_bytes: total.max(offset),
                    ..Default::default()
                });
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => break,
            Err(e) if attempts < 5 && !cancel.load(Ordering::Relaxed) && !e.to_string().contains("not available") => {
                attempts += 1;
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempts)).await;
            }
            Err(e) => return Err(e),
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(())
}

async fn restore_from_archive(
    api: &Api,
    id: i64,
    dest: &Path,
    todo: Vec<PlanItem>,
    work: &Path,
    progress: &ProgressFn,
    cancel: &Arc<AtomicBool>,
) -> Result<RestoreReport> {
    let mut report = RestoreReport::default();
    if todo.is_empty() {
        return Ok(report);
    }
    let archive = work.join(format!("full-{id}.tar.zst"));
    download_archive(api, id, &archive, progress, cancel).await?;

    let dest = dest.to_path_buf();
    let progress = progress.clone();
    let cancel = cancel.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<RestoreReport> {
        let total_files = todo.len() as u64;
        let total_bytes: u64 = todo.iter().map(|i| i.size).sum();
        let mut wanted: HashMap<String, PlanItem> = todo.into_iter().map(|i| (i.path.clone(), i)).collect();
        let mut rep = RestoreReport::default();
        let mut dec = zstd::stream::read::Decoder::new(File::open(&archive)?)?;
        dec.window_log_max(31)?;
        let mut ar = tar::Archive::new(dec);
        for entry in ar.entries()? {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let mut entry = entry?;
            let Some(rel) = entry.path().ok().and_then(|p| tar_rel(&p)) else { continue };
            let Some(item) = wanted.remove(&rel) else { continue };
            let one = (|| -> Result<u64> {
                let target = rel_to_path(&dest, &rel)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                let tmp = temp_sibling(&target);
                let mut out = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
                let mut hasher = Sha256::new();
                let mut buf = vec![0u8; 1 << 20];
                let mut size = 0u64;
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                    out.write_all(&buf[..n])?;
                    size += n as u64;
                }
                out.flush()?;
                drop(out);
                if let Some(expected) = &item.hash {
                    if &hex::encode(hasher.finalize()) != expected {
                        let _ = fs::remove_file(&tmp);
                        bail!("The archived copy failed its integrity check");
                    }
                }
                set_mtime(&tmp, item.mtime)?;
                replace_file(&tmp, &target).inspect_err(|_| {
                    let _ = fs::remove_file(&tmp);
                })?;
                Ok(size)
            })();
            match one {
                Ok(size) => {
                    rep.restored += 1;
                    rep.bytes += size;
                }
                Err(e) => rep.failed.push(FailedItem { path: rel.clone(), error: friendly_io(&e) }),
            }
            progress(Progress {
                stage: "Restoring files".into(),
                done_files: rep.restored + rep.failed.len() as u64,
                total_files,
                done_bytes: rep.bytes,
                total_bytes,
                current: Some(rel),
            });
            if wanted.is_empty() {
                break;
            }
        }
        if !cancel.load(Ordering::Relaxed) {
            for (path, _) in wanted {
                rep.failed.push(FailedItem { path, error: "Not found in the archive".into() });
            }
        }
        Ok(rep)
    })
    .await??;
    report.restored = result.restored;
    report.bytes = result.bytes;
    report.failed = result.failed;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tar_paths() {
        assert_eq!(tar_rel(Path::new("a/b/c.900")).as_deref(), Some("a/b/c.900"));
        assert_eq!(tar_rel(Path::new("./a")).as_deref(), Some("a"));
        assert_eq!(tar_rel(Path::new("../a")), None);
    }

    #[test]
    fn source_serde() {
        let s: RestoreSource = serde_json::from_str(r#"{"kind":"pointInTime","at":5}"#).unwrap();
        assert_eq!(s, RestoreSource::PointInTime { at: 5 });
        let f: RestoreSource = serde_json::from_str(r#"{"kind":"full","id":7}"#).unwrap();
        assert_eq!(f, RestoreSource::Full { id: 7 });
    }
}
