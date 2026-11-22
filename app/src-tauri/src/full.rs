//! Complete backups: the whole folder as one highly compressed tar.zst archive.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::api::Api;
use crate::fsutil::{self, is_locked, rel_to_path, ChangedDuringCopy, FileEntry};
use crate::model::{now_ms, Progress, ProgressFn};

pub struct FullOptions {
    pub root: PathBuf,
    pub excludes: Vec<String>,
    pub staging: PathBuf,
    pub level: i32,
    pub origin: &'static str,
    /// Tally is open: copy the folder to the staging area first (seconds), check that nothing
    /// changed during the copy, then compress the copy. Compressing straight from the live
    /// folder can take minutes, which is too long a window while Tally can save at any time.
    pub snapshot_first: bool,
}

/// Removes a staging folder when dropped, even on errors.
struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copies the files to `dest` (same relative paths and modified times). Returns the copied
/// files and the ones skipped because another program had them locked.
fn copy_snapshot(root: &Path, files: &[FileEntry], dest: &Path, cancel: &AtomicBool) -> Result<(Vec<FileEntry>, Vec<String>)> {
    let mut copied = Vec::with_capacity(files.len());
    let mut skipped = Vec::new();
    for f in files {
        if cancel.load(Ordering::Relaxed) {
            bail!("Complete backup was stopped.");
        }
        let src = rel_to_path(root, &f.rel)?;
        let dst = rel_to_path(dest, &f.rel)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::copy(&src, &dst) {
            Ok(_) => {
                let meta = fs::metadata(&dst)?;
                let _ = fsutil::set_mtime(&dst, f.mtime);
                copied.push(FileEntry { rel: f.rel.clone(), size: meta.len(), mtime: f.mtime });
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) if is_locked(&e) || e.kind() == io::ErrorKind::PermissionDenied => skipped.push(f.rel.clone()),
            Err(e) => return Err(e).with_context(|| format!("Cannot copy \"{}\"", f.rel)),
        }
    }
    Ok((copied, skipped))
}

/// Files whose size or modified time is no longer what the scan saw.
fn changed_files(root: &Path, files: &[FileEntry]) -> Vec<String> {
    files
        .iter()
        .filter(|f| match rel_to_path(root, &f.rel).ok().and_then(|p| fs::metadata(p).ok()) {
            Some(m) => m.len() != f.size || fsutil::mtime_ms(&m) != f.mtime,
            None => true,
        })
        .map(|f| f.rel.clone())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullReport {
    pub id: i64,
    pub file_count: u64,
    pub original_size: u64,
    pub compressed_size: u64,
    pub skipped: Vec<String>,
    pub seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub created_at: i64,
    pub level: i32,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub skipped: Vec<String>,
}

#[derive(Deserialize)]
struct Created {
    id: i64,
    key: String,
}

/// Reads exactly `size` bytes (zero-padding if the file shrank) and hashes them,
/// so a file changing mid-backup can never corrupt the tar stream.
struct ExactReader<R: Read> {
    inner: R,
    remaining: u64,
    hasher: Sha256,
    counter: Arc<AtomicU64>,
    short: bool,
}

impl<R: Read> Read for ExactReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = (buf.len() as u64).min(self.remaining) as usize;
        let n = if self.short { 0 } else { self.inner.read(&mut buf[..want])? };
        let n = if n == 0 {
            self.short = true;
            buf[..want].fill(0);
            want
        } else {
            n
        };
        self.hasher.update(&buf[..n]);
        self.remaining -= n as u64;
        self.counter.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

fn build_archive(
    root: &Path,
    files: &[FileEntry],
    out: &Path,
    level: i32,
    counter: Arc<AtomicU64>,
    cancel: &AtomicBool,
) -> Result<(Vec<ManifestFile>, Vec<String>)> {
    let file = File::create(out).with_context(|| format!("Cannot create {}", out.display()))?;
    let mut enc = zstd::stream::write::Encoder::new(BufWriter::with_capacity(4 << 20, file), level)?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).clamp(1, 8);
    enc.multithread(threads as u32)?;
    enc.long_distance_matching(true)?;
    enc.window_log(27)?;
    enc.include_checksum(true)?;
    let mut tar = tar::Builder::new(enc);

    let mut manifest = Vec::with_capacity(files.len());
    let mut skipped = Vec::new();
    for f in files {
        if cancel.load(Ordering::Relaxed) {
            bail!("Complete backup was stopped.");
        }
        let path = rel_to_path(root, &f.rel)?;
        let handle = match File::open(&path) {
            Ok(h) => h,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) if is_locked(&e) || e.kind() == io::ErrorKind::PermissionDenied => {
                skipped.push(f.rel.clone());
                counter.fetch_add(f.size, Ordering::Relaxed);
                continue;
            }
            Err(e) => return Err(e).with_context(|| format!("Cannot read \"{}\"", f.rel)),
        };
        let meta = handle.metadata()?;
        let size = meta.len();
        let mtime = fsutil::mtime_ms(&meta);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(size);
        header.set_mode(0o644);
        header.set_mtime((mtime.max(0) / 1000) as u64);
        let mut reader = ExactReader { inner: handle, remaining: size, hasher: Sha256::new(), counter: counter.clone(), short: false };
        tar.append_data(&mut header, &f.rel, &mut reader).with_context(|| format!("Cannot archive \"{}\"", f.rel))?;
        // Correct the progress estimate when the file size differs from the scan.
        if size < f.size {
            counter.fetch_add(f.size - size, Ordering::Relaxed);
        }
        if reader.short {
            skipped.push(f.rel.clone());
        }
        manifest.push(ManifestFile { path: f.rel.clone(), size, mtime, sha256: hex::encode(reader.hasher.finalize()) });
    }
    let enc = tar.into_inner()?;
    let mut w = enc.finish()?;
    w.flush()?;
    w.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok((manifest, skipped))
}

pub async fn run_full_backup(api: &Api, opts: &FullOptions, progress: &ProgressFn, cancel: &Arc<AtomicBool>) -> Result<FullReport> {
    let started = Instant::now();
    progress(Progress { stage: "Listing files".into(), ..Default::default() });
    let root = opts.root.clone();
    let excludes = opts.excludes.clone();
    let scan = tokio::task::spawn_blocking(move || fsutil::scan(&root, &excludes)).await??;
    if scan.files.is_empty() {
        bail!("The backup folder is empty, so there is nothing to back up.");
    }
    let total_files = scan.files.len() as u64;
    let total_bytes: u64 = scan.files.iter().map(|f| f.size).sum();

    // While Tally is open: take a quick, checked copy first, before anything is recorded.
    let mut snapshot_guard = None;
    let mut copy_skipped = Vec::new();
    let (archive_root, archive_files) = if opts.snapshot_first {
        progress(Progress { stage: "Copying files".into(), total_files, total_bytes, ..Default::default() });
        fs::create_dir_all(&opts.staging)?;
        let dir = opts.staging.join(format!("snapshot-{}", now_ms()));
        snapshot_guard = Some(DirGuard(dir.clone()));
        let (root, files, dest, cancel2) = (opts.root.clone(), scan.files.clone(), dir.clone(), cancel.clone());
        let (copied, skipped) = tokio::task::spawn_blocking(move || copy_snapshot(&root, &files, &dest, &cancel2)).await??;
        let (root, files) = (opts.root.clone(), scan.files.clone());
        let changed = tokio::task::spawn_blocking(move || changed_files(&root, &files)).await?;
        if !changed.is_empty() {
            let mut folders: Vec<String> = changed.iter().map(|r| fsutil::unit_of(r).to_string()).collect();
            folders.dedup();
            return Err(ChangedDuringCopy(folders).into());
        }
        copy_skipped = skipped;
        (dir, copied)
    } else {
        (opts.root.clone(), scan.files.clone())
    };

    let created: Created = api
        .post(
            "/api/full-backups",
            &json!({ "origin": opts.origin, "fileCount": total_files, "originalSize": total_bytes, "level": opts.level }),
        )
        .await?;
    fs::create_dir_all(&opts.staging)?;
    let archive = opts.staging.join(format!("full-{}.tar.zst", created.id));

    let result = async {
        let counter = Arc::new(AtomicU64::new(0));
        let done = Arc::new(AtomicBool::new(false));
        // Report compression progress while the blocking archiver runs.
        let ticker = {
            let counter = counter.clone();
            let done = done.clone();
            let progress = progress.clone();
            tokio::spawn(async move {
                while !done.load(Ordering::Relaxed) {
                    progress(Progress {
                        stage: "Compressing".into(),
                        done_files: 0,
                        total_files,
                        done_bytes: counter.load(Ordering::Relaxed).min(total_bytes),
                        total_bytes,
                        current: None,
                    });
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            })
        };
        let root = archive_root.clone();
        let files = archive_files.clone();
        let out = archive.clone();
        let level = opts.level;
        let built = tokio::task::spawn_blocking({
            let counter = counter.clone();
            let cancel = cancel.clone();
            move || build_archive(&root, &files, &out, level, counter, &cancel)
        })
        .await;
        done.store(true, Ordering::Relaxed);
        let _ = ticker.await;
        let (files, mut skipped) = built??;
        skipped.extend(copy_skipped.iter().cloned());

        let manifest = Manifest { version: 1, created_at: now_ms(), level: opts.level, files, skipped: skipped.clone() };
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        let _: serde_json::Value = api.put_bytes(&format!("/api/full-backups/{}/manifest", created.id), manifest_bytes, &[]).await?;

        let compressed = fs::metadata(&archive)?.len();
        let on_bytes = {
            let progress = progress.clone();
            move |sent: u64| {
                progress(Progress {
                    stage: "Uploading archive".into(),
                    done_files: total_files,
                    total_files,
                    done_bytes: sent,
                    total_bytes: compressed,
                    current: None,
                })
            }
        };
        on_bytes(0);
        api.upload_file(&archive, &created.key, &format!("/api/full-backups/{}/data", created.id), &[], json!({}), &on_bytes)
            .await?;
        let original: u64 = manifest.files.iter().map(|f| f.size).sum();
        let _: serde_json::Value = api
            .post(
                &format!("/api/full-backups/{}/complete", created.id),
                &json!({ "fileCount": manifest.files.len(), "originalSize": original }),
            )
            .await?;
        Ok::<_, anyhow::Error>(FullReport {
            id: created.id,
            file_count: manifest.files.len() as u64,
            original_size: original,
            compressed_size: compressed,
            skipped,
            seconds: started.elapsed().as_secs(),
        })
    }
    .await;

    let _ = fs::remove_file(&archive);
    drop(snapshot_guard);
    if let Err(e) = &result {
        let _ = api.post::<serde_json::Value, _>(&format!("/api/full-backups/{}/fail", created.id), &json!({ "message": e.to_string() })).await;
    }
    result
}

/// The list of files inside a complete backup, without downloading the archive.
pub async fn fetch_manifest(api: &Api, id: i64) -> Result<Manifest> {
    Ok(api.get(&format!("/api/full-backups/{id}/manifest")).await?)
}
