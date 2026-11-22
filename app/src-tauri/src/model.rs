//! Shared data types mirrored from the server, plus progress reporting.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::fsutil::is_under;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub access: String,
    pub scope_mode: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

impl UserInfo {
    pub fn is_admin(&self) -> bool {
        self.role == "superadmin"
    }
    pub fn can_write_any(&self) -> bool {
        self.is_admin() || (self.access == "write" && self.scope_mode != "none")
    }
    pub fn scope_allows(&self, rel: &str) -> bool {
        if self.is_admin() {
            return true;
        }
        match self.scope_mode.as_str() {
            "all" => true,
            "include" => self.paths.iter().any(|f| is_under(rel, f)),
            "exclude" => !self.paths.iter().any(|f| is_under(rel, f)),
            _ => false,
        }
    }
    pub fn can_write(&self, rel: &str) -> bool {
        (self.is_admin() || self.access == "write") && self.scope_allows(rel)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncPolicy {
    pub mode: String,
    pub quiet_seconds: u64,
    pub interval_minutes: u64,
    /// "quiet": back up while Tally is open once its files have not changed for
    /// `tally_quiet_seconds` (every copy is checked); "close": wait until Tally closes.
    pub tally_mode: String,
    pub tally_quiet_seconds: u64,
    pub grace_seconds: u64,
    pub tally_processes: Vec<String>,
}

impl SyncPolicy {
    /// Backups wait for Tally to close (instead of backing up between Tally entries).
    pub fn waits_for_close(&self) -> bool {
        self.tally_mode == "close"
    }
}

impl Default for SyncPolicy {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            quiet_seconds: 60,
            interval_minutes: 30,
            tally_mode: "quiet".into(),
            tally_quiet_seconds: 180,
            grace_seconds: 30,
            tally_processes: vec!["tally.exe".into(), "tallyprime.exe".into(), "tallyprimeserver.exe".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FullPolicy {
    pub schedule: String,
    pub time: String,
    pub every_hours: i64,
    pub weekday: u32,
    pub level: String,
    pub keep: u32,
}

impl Default for FullPolicy {
    fn default() -> Self {
        Self { schedule: "daily".into(), time: "20:00".into(), every_hours: 12, weekday: 5, level: "maximum".into(), keep: 14 }
    }
}

impl FullPolicy {
    pub fn zstd_level(&self) -> i32 {
        match self.level.as_str() {
            "balanced" => 9,
            "high" => 15,
            _ => 19,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RetentionPolicy {
    pub version_days: u32,
}

/// Tally data snapshots read from Tally's XML server when company files are backed up.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TallyPolicy {
    pub snapshots: bool,
    pub port: u16,
    pub every_minutes: u64,
}

impl Default for TallyPolicy {
    fn default() -> Self {
        Self { snapshots: true, port: 9000, every_minutes: 60 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    pub sync: SyncPolicy,
    pub full: FullPolicy,
    pub retention: RetentionPolicy,
    pub tally: TallyPolicy,
    pub exclude: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            sync: SyncPolicy::default(),
            full: FullPolicy::default(),
            retention: RetentionPolicy { version_days: 30 },
            tally: TallyPolicy::default(),
            exclude: vec!["*.tmp".into(), "~$*".into(), "Thumbs.db".into(), "desktop.ini".into(), ".DS_Store".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub done_files: u64,
    pub total_files: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub current: Option<String>,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

pub fn noop_progress() -> ProgressFn {
    Arc::new(|_| {})
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(mode: &str, access: &str, paths: &[&str]) -> UserInfo {
        UserInfo {
            id: 2,
            username: "u".into(),
            display_name: "U".into(),
            role: "user".into(),
            access: access.into(),
            scope_mode: mode.into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn scopes() {
        let inc = user("include", "read", &["Data/10001"]);
        assert!(inc.scope_allows("Data/10001/x.900"));
        assert!(inc.scope_allows("data/10001"));
        assert!(!inc.scope_allows("Data/100011/x"));
        assert!(!inc.can_write("Data/10001/x.900"));
        let exc = user("exclude", "write", &["Data/Secret"]);
        assert!(exc.can_write("Data/1/x"));
        assert!(!exc.can_write("Data/Secret/x"));
        assert!(!user("none", "write", &[]).scope_allows("a"));
        assert!(!user("none", "write", &[]).can_write_any());
    }

    #[test]
    fn policy_defaults_fill_missing_fields() {
        let p: Policy = serde_json::from_str(r#"{"sync":{"mode":"manual"}}"#).unwrap();
        assert_eq!(p.sync.mode, "manual");
        assert_eq!(p.sync.quiet_seconds, 60);
        assert_eq!(p.full.zstd_level(), 19);
    }
}
