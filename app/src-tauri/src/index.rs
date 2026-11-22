//! Local record of what this computer has already backed up, so only changes are uploaded
//! and files that disappear can be recorded as deletions.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::fsutil::atomic_write;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexEntry {
    pub size: u64,
    pub mtime: i64,
    pub hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LocalIndex {
    pub root: String,
    pub files: BTreeMap<String, IndexEntry>,
}

/// One index per (server, folder) pair, so switching either starts fresh.
pub fn index_path(data_dir: &Path, server: &str, root: &str) -> PathBuf {
    let mut h = Sha256::new();
    h.update(server.trim_end_matches('/').to_lowercase().as_bytes());
    h.update(b"\n");
    h.update(root.to_lowercase().as_bytes());
    data_dir.join("index").join(format!("{}.json", &hex::encode(h.finalize())[..20]))
}

impl LocalIndex {
    pub fn load(path: &Path, root: &str) -> Self {
        match fs::read(path).ok().and_then(|b| serde_json::from_slice::<LocalIndex>(&b).ok()) {
            Some(idx) if idx.root.eq_ignore_ascii_case(root) => idx,
            _ => LocalIndex { root: root.to_string(), files: BTreeMap::new() },
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        atomic_write(path, &bytes)
    }
}
