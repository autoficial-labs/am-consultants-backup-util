//! File-system helpers: scanning, exclusion patterns, hashing, compression and safe paths.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Suffix for files being written by a restore; always ignored by scans.
pub const TMP_SUFFIX: &str = ".amtmp";
const BUF_SIZE: usize = 1 << 20;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Path relative to the root, with forward slashes.
    pub rel: String,
    pub size: u64,
    /// Modification time in Unix milliseconds.
    pub mtime: i64,
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub files: Vec<FileEntry>,
    /// Entries that could not be read (permissions, vanished mid-scan, odd names).
    pub errors: usize,
}

pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Converts an absolute path under `root` into a forward-slash relative path.
pub fn to_rel(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Turns a relative backup path into a real path under `root`, refusing anything that could escape it.
pub fn rel_to_path(root: &Path, rel: &str) -> Result<PathBuf> {
    let mut p = root.to_path_buf();
    if rel.is_empty() {
        bail!("Empty path in backup");
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\') || seg.contains(':') || seg.contains('\0') {
            bail!("Unsafe path in backup: {rel}");
        }
        p.push(seg);
    }
    Ok(p)
}

/// Case-insensitive wildcard match supporting `*` and `?`.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            pi += 1;
            mark = ti;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// A pattern without "/" matches any file or folder name; with "/" it matches from the root.
pub fn is_excluded(rel: &str, patterns: &[String]) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name.ends_with(TMP_SUFFIX) {
        return true;
    }
    patterns.iter().any(|raw| {
        let pat = raw.trim().trim_matches('/');
        if pat.is_empty() {
            return false;
        }
        if pat.contains('/') {
            glob_match(pat, rel) || glob_match(&format!("{pat}/*"), rel)
        } else {
            rel.split('/').any(|seg| glob_match(pat, seg))
        }
    })
}

/// Lists every regular file under `root`, skipping excluded names and symlinks.
pub fn scan(root: &Path, excludes: &[String]) -> Result<ScanResult> {
    if !root.is_dir() {
        bail!("The folder \"{}\" is not available.", root.display());
    }
    let mut out = ScanResult::default();
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        if e.depth() == 0 || !e.file_type().is_dir() {
            return true;
        }
        match to_rel(root, e.path()) {
            Some(rel) => !is_excluded(&rel, excludes),
            None => false,
        }
    });
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                out.errors += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(rel) = to_rel(root, entry.path()) else {
            out.errors += 1;
            continue;
        };
        if is_excluded(&rel, excludes) {
            continue;
        }
        match entry.metadata() {
            Ok(m) => out.files.push(FileEntry { rel, size: m.len(), mtime: mtime_ms(&m) }),
            Err(_) => out.errors += 1,
        }
    }
    out.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    pub root: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub folders: Vec<FolderInfo>,
}

/// Aggregates file counts and sizes per folder (used by the folder pickers).
pub fn summarize(root: &Path, files: &[FileEntry]) -> FolderSummary {
    let mut map: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for f in files {
        let segs: Vec<&str> = f.rel.split('/').collect();
        for i in 1..segs.len() {
            let e = map.entry(segs[..i].join("/")).or_default();
            e.0 += 1;
            e.1 += f.size;
        }
    }
    FolderSummary {
        root: root.display().to_string(),
        total_files: files.len() as u64,
        total_bytes: files.iter().map(|f| f.size).sum(),
        folders: map.into_iter().map(|(path, (files, bytes))| FolderInfo { path, files, bytes }).collect(),
    }
}

/// True when another program holds the file open without sharing (e.g. Tally writing to it).
pub fn is_locked(err: &io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        let _ = err;
        false
    }
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut f = BufReader::with_capacity(BUF_SIZE, fs::File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF_SIZE];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[derive(Debug, Clone)]
pub struct Packed {
    pub hash: String,
    pub size: u64,
    pub packed_size: u64,
}

/// Reads `src` once, hashing it (SHA-256) and writing a zstd-compressed copy to `dst`.
pub fn pack_file(src: &Path, dst: &Path, level: i32) -> io::Result<Packed> {
    let mut input = fs::File::open(src)?;
    let out = BufWriter::with_capacity(BUF_SIZE, fs::File::create(dst)?);
    let mut enc = zstd::stream::write::Encoder::new(out, level)?;
    enc.include_checksum(true)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF_SIZE];
    let mut size = 0u64;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        enc.write_all(&buf[..n])?;
        size += n as u64;
    }
    let mut w = enc.finish()?;
    w.flush()?;
    drop(w);
    let packed_size = fs::metadata(dst)?.len();
    Ok(Packed { hash: hex::encode(hasher.finalize()), size, packed_size })
}

/// Decompresses a packed file to `dst`, verifying its SHA-256. Returns the byte count.
pub fn unpack_file(packed: &Path, dst: &Path, expected_hash: &str) -> Result<u64> {
    let input = BufReader::with_capacity(BUF_SIZE, fs::File::open(packed)?);
    let mut dec = zstd::stream::read::Decoder::with_buffer(input)?;
    dec.window_log_max(31)?;
    let mut out = BufWriter::with_capacity(BUF_SIZE, fs::File::create(dst).with_context(|| format!("Cannot write {}", dst.display()))?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF_SIZE];
    let mut size = 0u64;
    loop {
        let n = dec.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        size += n as u64;
    }
    out.flush()?;
    drop(out);
    let actual = hex::encode(hasher.finalize());
    if actual != expected_hash {
        let _ = fs::remove_file(dst);
        bail!("Downloaded data failed its integrity check");
    }
    Ok(size)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp-write");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Path for a temporary sibling of `target` used while writing it.
pub fn temp_sibling(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(TMP_SUFFIX);
    target.with_file_name(name)
}

pub fn set_mtime(path: &Path, mtime_ms: i64) -> io::Result<()> {
    if mtime_ms <= 0 {
        return Ok(());
    }
    let when = UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms as u64);
    fs::File::options().write(true).open(path)?.set_modified(when)
}

/// Lower-cased comparison key, since Windows paths are case-insensitive.
pub fn path_key(rel: &str) -> String {
    rel.to_lowercase()
}

pub fn is_under(path: &str, folder: &str) -> bool {
    let a = path.to_lowercase();
    let b = folder.to_lowercase();
    a == b || a.starts_with(&format!("{b}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_basics() {
        assert!(glob_match("*.tmp", "file.TMP"));
        assert!(glob_match("~$*", "~$book.xlsx"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("*.tmp", "file.tmpx"));
        assert!(glob_match("*", ""));
        assert!(glob_match("data*", "Data10001"));
    }

    #[test]
    fn exclusions() {
        let pats = vec!["*.tmp".to_string(), "Thumbs.db".to_string(), "Data/Old".to_string(), "Logs".to_string()];
        assert!(is_excluded("a/b/x.tmp", &pats));
        assert!(is_excluded("thumbs.db", &pats));
        assert!(is_excluded("Data/Old/a.900", &pats));
        assert!(!is_excluded("Data/Older/a.900", &pats));
        assert!(is_excluded("x/Logs/y.txt", &pats));
        assert!(is_excluded("x/y.900.amtmp", &pats));
        assert!(!is_excluded("Data/10001/Company.900", &pats));
    }

    #[test]
    fn safe_paths() {
        let root = Path::new("C:/root");
        assert!(rel_to_path(root, "a/b.txt").is_ok());
        assert!(rel_to_path(root, "../x").is_err());
        assert!(rel_to_path(root, "a//b").is_err());
        assert!(rel_to_path(root, "C:/x").is_err());
        assert!(rel_to_path(root, "a\\..\\b").is_err());
    }

    #[test]
    fn pack_roundtrip() {
        let dir = std::env::temp_dir().join(format!("amb-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &data).unwrap();
        let packed = pack_file(&src, &dir.join("p.zst"), 3).unwrap();
        assert_eq!(packed.size, data.len() as u64);
        assert!(packed.packed_size < packed.size);
        assert_eq!(packed.hash, sha256_file(&src).unwrap());
        let out = dir.join("out.bin");
        unpack_file(&dir.join("p.zst"), &out, &packed.hash).unwrap();
        assert_eq!(fs::read(&out).unwrap(), data);
        assert!(unpack_file(&dir.join("p.zst"), &dir.join("bad.bin"), &"0".repeat(64)).is_err());
        assert!(!dir.join("bad.bin").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn folder_summary() {
        let files = vec![
            FileEntry { rel: "Data/1/a".into(), size: 10, mtime: 0 },
            FileEntry { rel: "Data/2/b".into(), size: 5, mtime: 0 },
            FileEntry { rel: "top".into(), size: 1, mtime: 0 },
        ];
        let s = summarize(Path::new("/r"), &files);
        assert_eq!(s.total_files, 3);
        let data = s.folders.iter().find(|f| f.path == "Data").unwrap();
        assert_eq!((data.files, data.bytes), (2, 15));
    }
}


/// Another program (usually Tally) changed files while they were being copied, so the copy
/// was discarded. Not a failure: the engine tries again when the files are quiet.
#[derive(Debug, Clone)]
pub struct ChangedDuringCopy(pub Vec<String>);

impl std::fmt::Display for ChangedDuringCopy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Files changed while they were copied ({}). The copy was discarded and will be taken again when the files are quiet.", self.0.join(", "))
    }
}

impl std::error::Error for ChangedDuringCopy {}

/// The folder part of a relative path ("" for files directly in the backup folder).
/// For Tally data this is the company folder, whose files must be copied as one consistent set.
pub fn unit_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// Size and modified time of every backed-up file directly inside one folder.
pub fn folder_state(root: &Path, unit: &str, excludes: &[String]) -> std::collections::HashMap<String, (u64, i64)> {
    let mut out = std::collections::HashMap::new();
    let dir = if unit.is_empty() {
        root.to_path_buf()
    } else {
        match rel_to_path(root, unit) {
            Ok(p) => p,
            Err(_) => return out,
        }
    };
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if unit.is_empty() { name } else { format!("{unit}/{name}") };
            if !is_excluded(&rel, excludes) {
                out.insert(rel, (m.len(), mtime_ms(&m)));
            }
        }
    }
    out
}

/// Files of `before` that are gone or different now.
pub fn changed_since(before: &std::collections::HashMap<String, (u64, i64)>, after: &std::collections::HashMap<String, (u64, i64)>) -> Vec<String> {
    let mut v: Vec<String> = before.iter().filter(|(k, st)| after.get(*k) != Some(*st)).map(|(k, _)| k.clone()).collect();
    v.sort();
    v
}
