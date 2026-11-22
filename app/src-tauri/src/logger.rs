//! Tiny file logger with an in-memory tail for the Activity view.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_RECENT: usize = 400;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub at: i64,
    pub level: &'static str,
    pub message: String,
}

struct Logger {
    file: Option<PathBuf>,
    recent: Mutex<VecDeque<LogLine>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let _ = LOGGER.set(Logger { file: Some(dir.join("am-backup.log")), recent: Mutex::new(VecDeque::new()) });
}

pub fn log(level: &'static str, message: String) {
    let logger = LOGGER.get_or_init(|| Logger { file: None, recent: Mutex::new(VecDeque::new()) });
    let at = chrono::Utc::now().timestamp_millis();
    if cfg!(debug_assertions) {
        eprintln!("[{level}] {message}");
    }
    let mut recent = logger.recent.lock();
    if let Some(path) = &logger.file {
        if fs::metadata(path).map(|m| m.len() > MAX_FILE).unwrap_or(false) {
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let _ = writeln!(f, "{stamp} [{level}] {message}");
        }
    }
    recent.push_back(LogLine { at, level, message });
    while recent.len() > MAX_RECENT {
        recent.pop_front();
    }
}

pub fn recent() -> Vec<LogLine> {
    LOGGER.get().map(|l| l.recent.lock().iter().cloned().collect()).unwrap_or_default()
}

pub fn log_dir() -> Option<PathBuf> {
    LOGGER.get().and_then(|l| l.file.as_ref()).and_then(|f| f.parent().map(Path::to_path_buf))
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logger::log("info", format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logger::log("warn", format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logger::log("error", format!($($arg)*)) };
}
