//! Detects whether Tally is running, so backups can wait until its files are closed.

use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

pub struct TallyDetector {
    sys: System,
    last_check: Option<Instant>,
    last: Option<String>,
}

impl Default for TallyDetector {
    fn default() -> Self {
        Self { sys: System::new(), last_check: None, last: None }
    }
}

impl TallyDetector {
    /// Returns the name of a running Tally process, if any. Results are cached for a few seconds.
    pub fn running(&mut self, names: &[String]) -> Option<String> {
        if names.is_empty() {
            return None;
        }
        if self.last_check.is_some_and(|t| t.elapsed() < Duration::from_secs(4)) {
            return self.last.clone();
        }
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let wanted: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
        let found = self.sys.processes().values().find_map(|p| {
            let name = p.name().to_string_lossy().to_lowercase();
            let bare = name.trim_end_matches(".exe");
            wanted.iter().find(|w| **w == name || w.trim_end_matches(".exe") == bare).map(|_| p.name().to_string_lossy().to_string())
        });
        self.last_check = Some(Instant::now());
        self.last = found.clone();
        found
    }

    pub fn invalidate(&mut self) {
        self.last_check = None;
    }
}
