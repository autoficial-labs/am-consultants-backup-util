//! The background engine: watches the folder, decides when to back up, runs one job at a time
//! and reports its status to the UI and the tray.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::api::{Api, ApiError, MeResponse};
use crate::config::{ConfigView, LocalConfig};
use crate::fsutil::TMP_SUFFIX;
use crate::full::{self, FullOptions, FullReport};
use crate::index::index_path;
use crate::model::{now_ms, Policy, Progress, ProgressFn, UserInfo};
use crate::restore::{self, ExecuteOptions, RestorePlan, RestoreReport, RestoreSource};
use crate::sync::{self, SyncOptions, SyncReport};
use crate::fsutil::ChangedDuringCopy;
use crate::tally::TallyDetector;
use crate::tally_data::{self, SavedSnapshot, TallyClient};
use crate::{log_error, log_info, log_warn, schedule};

const TICK: Duration = Duration::from_secs(3);
const POLICY_REFRESH_MS: i64 = 5 * 60_000;
const SAFETY_SCAN_MS: i64 = 30 * 60_000;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Starting,
    SignedOut,
    NotConfigured,
    ReadOnly,
    Idle,
    Scanning,
    Uploading,
    WaitingTally,
    WaitingQuiet,
    FullBackup,
    Restoring,
    Paused,
    Offline,
    Error,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub phase: Phase,
    pub message: String,
    pub job: Option<String>,
    pub progress: Option<Progress>,
    pub last_sync_at: Option<i64>,
    pub last_sync_summary: Option<String>,
    pub last_full_at: Option<i64>,
    pub next_full_at: Option<i64>,
    pub changes_pending: bool,
    pub tally_running: Option<String>,
    pub paused: bool,
    pub watched_folder: Option<String>,
    pub last_error: Option<String>,
    pub busy_files: Vec<String>,
}

pub struct Dirs {
    pub config_file: PathBuf,
    pub data: PathBuf,
    pub staging: PathBuf,
}

pub struct Inner {
    app: AppHandle,
    pub dirs: Dirs,
    config: RwLock<LocalConfig>,
    status: Mutex<EngineStatus>,
    job: tokio::sync::Mutex<()>,
    dirty: AtomicBool,
    last_change: AtomicI64,
    wake: Notify,
    watcher: Mutex<Option<(String, RecommendedWatcher)>>,
    plans: Mutex<VecDeque<RestorePlan>>,
    cancel: Mutex<Arc<AtomicBool>>,
    tally: Mutex<TallyDetector>,
    tally_was_running: AtomicBool,
    tally_closed_at: AtomicI64,
    last_policy_refresh: AtomicI64,
    last_scan_at: AtomicI64,
    sync_failures: AtomicU32,
    retry_sync_at: AtomicI64,
    retry_full_at: AtomicI64,
    last_emit: Mutex<Instant>,
    /// Per company: when its last Tally snapshot was taken and the hash of its data.
    tally_snaps: Mutex<HashMap<String, (i64, String)>>,
    tally_capturing: AtomicBool,
    tally_warned_at: AtomicI64,
}

#[derive(Clone)]
pub struct Engine(pub Arc<Inner>);

/// Errors shown to the UI; `TALLY_RUNNING:` prefixed messages ask the user to confirm.
pub type CmdResult<T> = Result<T, String>;

fn describe_sync(r: &SyncReport) -> String {
    let mut parts = Vec::new();
    if r.added > 0 {
        parts.push(format!("{} new", r.added));
    }
    if r.modified > 0 {
        parts.push(format!("{} changed", r.modified));
    }
    if r.deleted > 0 {
        parts.push(format!("{} removed", r.deleted));
    }
    if parts.is_empty() {
        "Everything was already backed up".into()
    } else {
        format!("Backed up {}", parts.join(", "))
    }
}

fn same_folder(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

impl Engine {
    pub fn new(app: AppHandle, dirs: Dirs) -> Self {
        let mut cfg = LocalConfig::load(&dirs.config_file);
        if cfg.device_name.trim().is_empty() {
            cfg.device_name = sysinfo::System::host_name().unwrap_or_else(|| "This computer".into());
        }
        let status = EngineStatus {
            paused: cfg.paused,
            last_sync_at: cfg.last_sync_at,
            last_sync_summary: cfg.last_sync_summary.clone(),
            last_full_at: cfg.last_full_at,
            watched_folder: cfg.watched_folder.clone(),
            ..Default::default()
        };
        let _ = std::fs::remove_dir_all(&dirs.staging);
        let _ = cfg.save(&dirs.config_file);
        Engine(Arc::new(Inner {
            app,
            dirs,
            config: RwLock::new(cfg),
            status: Mutex::new(status),
            job: tokio::sync::Mutex::new(()),
            dirty: AtomicBool::new(true),
            last_change: AtomicI64::new(0),
            wake: Notify::new(),
            watcher: Mutex::new(None),
            plans: Mutex::new(VecDeque::new()),
            cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            tally: Mutex::new(TallyDetector::default()),
            tally_was_running: AtomicBool::new(false),
            tally_closed_at: AtomicI64::new(0),
            last_policy_refresh: AtomicI64::new(0),
            last_scan_at: AtomicI64::new(0),
            sync_failures: AtomicU32::new(0),
            retry_sync_at: AtomicI64::new(0),
            retry_full_at: AtomicI64::new(0),
            last_emit: Mutex::new(Instant::now()),
            tally_snaps: Mutex::new(HashMap::new()),
            tally_capturing: AtomicBool::new(false),
            tally_warned_at: AtomicI64::new(0),
        }))
    }

    // ---- configuration --------------------------------------------------------------

    pub fn config(&self) -> LocalConfig {
        self.0.config.read().clone()
    }

    pub fn view(&self) -> ConfigView {
        ConfigView::from(&*self.0.config.read())
    }

    pub fn update_config(&self, f: impl FnOnce(&mut LocalConfig)) {
        let mut cfg = self.0.config.write();
        f(&mut cfg);
        if let Err(e) = cfg.save(&self.0.dirs.config_file) {
            log_error!("Could not save settings: {e}");
        }
    }

    pub fn api(&self) -> CmdResult<Api> {
        let cfg = self.0.config.read();
        let server = cfg.server_url.clone().ok_or("Choose a backup server first.")?;
        Ok(Api::new(&server, cfg.token.clone(), &cfg.device_name))
    }

    pub fn anonymous_api(&self, server: &str) -> Api {
        Api::new(server, None, &self.0.config.read().device_name)
    }

    pub fn close_to_tray(&self) -> bool {
        self.0.config.read().close_to_tray
    }

    /// Clears the local session after the server rejected it.
    pub fn sign_out_locally(&self, reason: &str) {
        let was_signed_in = self.0.config.read().token.is_some();
        self.update_config(|c| {
            c.token = None;
            c.user = None;
        });
        *self.0.watcher.lock() = None;
        if was_signed_in {
            log_warn!("Signed out: {reason}");
            let _ = self.0.app.emit("session-expired", reason.to_string());
        }
        self.set_phase(Phase::SignedOut, "Sign in to start backing up");
    }

    /// Converts an error for the UI, signing out if the session is no longer valid.
    pub fn map_err(&self, e: anyhow::Error) -> String {
        if let Some(ApiError::Unauthorized(msg)) = e.downcast_ref::<ApiError>() {
            self.sign_out_locally(msg);
            return msg.clone();
        }
        e.to_string()
    }

    pub fn map_api_err(&self, e: ApiError) -> String {
        self.map_err(anyhow::Error::new(e))
    }

    pub async fn refresh_session(&self) -> CmdResult<ConfigView> {
        self.0.last_policy_refresh.store(now_ms(), Ordering::Relaxed);
        let api = self.api()?;
        if !api.has_token() {
            return Err("Not signed in.".into());
        }
        let me: MeResponse = api.get("/api/me").await.map_err(|e| self.map_api_err(e))?;
        let is_admin = me.user.is_admin();
        self.update_config(|c| {
            c.user = Some(me.user);
            c.policy = Some(me.policy);
        });
        // Learn about complete backups made by another computer (or before a reinstall),
        // so the schedule does not start an unnecessary one.
        if is_admin {
            if let Ok(stats) = api.get::<serde_json::Value>("/api/stats").await {
                if let Some(t) = stats.get("lastFull").and_then(|f| f.get("created_at")).and_then(|v| v.as_i64()) {
                    let newer = self.config().last_full_at.is_none_or(|l| l < t);
                    if newer {
                        self.update_config(|c| c.last_full_at = Some(t));
                        self.set_status(|s| s.last_full_at = Some(t));
                    }
                }
            }
        }
        Ok(self.view())
    }

    pub fn set_policy(&self, policy: Policy) {
        self.update_config(|c| c.policy = Some(policy));
        self.wake();
    }

    pub fn wake(&self) {
        self.0.wake.notify_one();
    }

    pub fn mark_dirty(&self) {
        self.0.dirty.store(true, Ordering::Relaxed);
        self.0.last_change.store(now_ms(), Ordering::Relaxed);
    }

    // ---- status ---------------------------------------------------------------------

    pub fn status(&self) -> EngineStatus {
        self.0.status.lock().clone()
    }

    fn emit(&self, force: bool) {
        let mut last = self.0.last_emit.lock();
        if !force && last.elapsed() < Duration::from_millis(150) {
            return;
        }
        *last = Instant::now();
        drop(last);
        let status = self.status();
        let _ = self.0.app.emit("engine-status", &status);
        crate::update_tray(&self.0.app, &status);
    }

    fn set_status(&self, f: impl FnOnce(&mut EngineStatus)) {
        let changed = {
            let mut s = self.0.status.lock();
            let before = (s.phase, s.message.clone(), s.tally_running.clone(), s.paused, s.next_full_at, s.changes_pending);
            f(&mut s);
            before != (s.phase, s.message.clone(), s.tally_running.clone(), s.paused, s.next_full_at, s.changes_pending)
        };
        if changed {
            self.emit(true);
        }
    }

    fn set_phase(&self, phase: Phase, message: &str) {
        self.set_status(|s| {
            s.phase = phase;
            s.message = message.to_string();
            if !matches!(phase, Phase::Scanning | Phase::Uploading | Phase::FullBackup | Phase::Restoring) {
                s.progress = None;
                s.job = None;
            }
        });
    }

    fn progress_fn(&self, phase: Phase) -> ProgressFn {
        let engine = self.clone();
        Arc::new(move |p: Progress| {
            let stage_changed = {
                let mut s = engine.0.status.lock();
                let changed = s.progress.as_ref().map(|o| o.stage != p.stage).unwrap_or(true);
                s.phase = phase;
                s.message = p.stage.clone();
                s.progress = Some(p);
                changed
            };
            engine.emit(stage_changed);
        })
    }

    fn new_cancel(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.0.cancel.lock() = flag.clone();
        flag
    }

    pub fn cancel_job(&self) {
        self.0.cancel.lock().store(true, Ordering::Relaxed);
    }

    pub fn set_paused(&self, paused: bool) {
        self.update_config(|c| c.paused = paused);
        self.set_status(|s| s.paused = paused);
        log_info!("Automatic backups {}", if paused { "paused" } else { "resumed" });
        self.wake();
    }

    pub fn tally_running(&self) -> Option<String> {
        let names = self.config().policy.unwrap_or_default().sync.tally_processes;
        let mut t = self.0.tally.lock();
        t.invalidate();
        t.running(&names)
    }

    // ---- folder watching ------------------------------------------------------------

    fn ensure_watcher(&self, folder: &str) {
        let mut slot = self.0.watcher.lock();
        if slot.as_ref().is_some_and(|(f, _)| f == folder) {
            return;
        }
        *slot = None;
        let engine = self.clone();
        let handler = move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Access(_)) {
                    return;
                }
                if !ev.paths.is_empty() && ev.paths.iter().all(|p| p.to_string_lossy().ends_with(TMP_SUFFIX)) {
                    return;
                }
                engine.mark_dirty();
            }
        };
        match notify::recommended_watcher(handler) {
            Ok(mut w) => match w.watch(Path::new(folder), RecursiveMode::Recursive) {
                Ok(()) => {
                    log_info!("Watching {folder}");
                    *slot = Some((folder.to_string(), w));
                }
                Err(e) => log_warn!("Live watching is unavailable for {folder} ({e}); checking on a timer instead"),
            },
            Err(e) => log_warn!("Could not start the folder watcher: {e}"),
        }
    }

    pub fn stop_watching(&self) {
        *self.0.watcher.lock() = None;
    }

    // ---- scheduler --------------------------------------------------------------------

    pub fn start(&self) {
        let engine = self.clone();
        tauri::async_runtime::spawn(async move {
            log_info!("AM Backup engine started (version {})", env!("CARGO_PKG_VERSION"));
            loop {
                engine.tick().await;
                tokio::select! {
                    _ = tokio::time::sleep(TICK) => {}
                    _ = engine.0.wake.notified() => {}
                }
            }
        });
    }

    async fn tick(&self) {
        if self.0.job.try_lock().is_err() {
            return; // a job is running and owns the status
        }
        let now = now_ms();
        let cfg = self.config();
        let Some(user) = cfg.user.clone().filter(|_| cfg.token.is_some() && cfg.server_url.is_some()) else {
            self.set_phase(Phase::SignedOut, "Sign in to start backing up");
            return;
        };
        if now - self.0.last_policy_refresh.load(Ordering::Relaxed) >= POLICY_REFRESH_MS {
            if let Err(e) = self.refresh_session().await {
                log_warn!("Could not refresh account details: {e}");
            }
            if self.0.config.read().token.is_none() {
                return;
            }
        }
        let cfg = self.config();
        let user = cfg.user.clone().unwrap_or(user);
        let policy = cfg.policy.clone().unwrap_or_default();

        let Some(folder) = cfg.watched_folder.clone() else {
            self.stop_watching();
            if user.can_write_any() {
                self.set_phase(Phase::NotConfigured, "Choose the folder to back up");
            } else {
                self.set_phase(Phase::ReadOnly, "You can browse and restore backed-up files");
            }
            return;
        };
        self.set_status(|s| s.watched_folder = Some(folder.clone()));
        if !user.can_write_any() {
            self.stop_watching();
            self.set_phase(Phase::ReadOnly, "You can browse and restore backed-up files");
            return;
        }
        if !Path::new(&folder).is_dir() {
            self.stop_watching();
            self.set_phase(Phase::Error, &format!("The backup folder is not available: {folder}"));
            return;
        }
        self.ensure_watcher(&folder);

        // Tally detection (also shown on the dashboard when not waiting).
        let tally = self.0.tally.lock().running(&policy.sync.tally_processes);
        if tally.is_some() {
            self.0.tally_was_running.store(true, Ordering::Relaxed);
        } else if self.0.tally_was_running.swap(false, Ordering::Relaxed) {
            self.0.tally_closed_at.store(now, Ordering::Relaxed);
            log_info!("Tally closed");
        }
        let in_grace = now - self.0.tally_closed_at.load(Ordering::Relaxed) < policy.sync.grace_seconds as i64 * 1000;
        // "close" mode: nothing runs while Tally is open. "quiet" mode (default): back up while
        // Tally is open, but only after its files have been quiet for a while; every copy is checked.
        let blocked = policy.sync.waits_for_close() && (tally.is_some() || in_grace);
        let tally_quiet_mode = !policy.sync.waits_for_close() && tally.is_some();
        let quiet_ms = if tally_quiet_mode { policy.sync.tally_quiet_seconds.max(policy.sync.quiet_seconds) } else { policy.sync.quiet_seconds } as i64 * 1000;
        let quiet_ok = now - self.0.last_change.load(Ordering::Relaxed) >= quiet_ms;
        let quiet_label = if quiet_ms >= 120_000 { format!("{} minutes", quiet_ms / 60_000) } else { format!("{} seconds", quiet_ms / 1000) };
        let pending = self.0.dirty.load(Ordering::Relaxed);
        self.set_status(|s| {
            s.tally_running = tally.clone();
            s.changes_pending = pending;
            s.paused = cfg.paused;
        });

        if cfg.paused {
            self.set_phase(Phase::Paused, "Automatic backups are paused");
            return;
        }

        if user.is_admin() {
            let next = schedule::next_due(&policy.full, cfg.last_full_at, chrono::Local::now());
            self.set_status(|s| s.next_full_at = next);
            if schedule::is_due(&policy.full, cfg.last_full_at, chrono::Local::now()) && now >= self.0.retry_full_at.load(Ordering::Relaxed) {
                if blocked {
                    self.set_phase(Phase::WaitingTally, "The complete backup will start after Tally closes");
                    return;
                }
                if tally_quiet_mode && !quiet_ok {
                    self.set_phase(Phase::WaitingQuiet, &format!("Tally is open; the complete backup starts when its files have been quiet for {quiet_label}"));
                    return;
                }
                let _ = self.run_full("scheduled").await;
                return;
            }
        }

        let backoff_ok = now >= self.0.retry_sync_at.load(Ordering::Relaxed);
        // While Tally is open, even timed backups and safety scans wait for a quiet moment.
        let tally_ok = !tally_quiet_mode || quiet_ok;
        let due = backoff_ok
            && tally_ok
            && match policy.sync.mode.as_str() {
                "manual" => false,
                "interval" => cfg.last_sync_at.is_none_or(|t| now - t >= policy.sync.interval_minutes as i64 * 60_000),
                _ => (pending && quiet_ok) || now - self.0.last_scan_at.load(Ordering::Relaxed) >= SAFETY_SCAN_MS,
            };
        if due {
            if blocked {
                let msg = if tally.is_some() { "Waiting for Tally to close before backing up" } else { "Tally just closed; starting shortly" };
                self.set_phase(Phase::WaitingTally, msg);
                return;
            }
            let _ = self.run_sync().await;
            return;
        }

        match policy.sync.mode.as_str() {
            "auto" | "interval" if pending && !quiet_ok && tally_quiet_mode => {
                self.set_phase(Phase::WaitingQuiet, &format!("Tally is open; backing up when its files have been quiet for {quiet_label}"))
            }
            "auto" if pending && !quiet_ok => self.set_phase(Phase::WaitingQuiet, "Changes detected; backing up when files settle"),
            "manual" => self.set_phase(Phase::Idle, "Backups run when you start them"),
            _ => {
                let cur = self.status();
                if !(cur.phase == Phase::Offline || cur.phase == Phase::Error) || backoff_ok {
                    self.set_phase(Phase::Idle, "Your files are protected");
                }
            }
        }
    }

    // ---- jobs ---------------------------------------------------------------------------

    fn job_context(&self) -> CmdResult<(Api, LocalConfig, UserInfo, String)> {
        let api = self.api()?;
        let cfg = self.config();
        let user = cfg.user.clone().ok_or("Sign in first.")?;
        let folder = cfg.watched_folder.clone().ok_or("Choose the folder to back up first.")?;
        if !Path::new(&folder).is_dir() {
            return Err(format!("The backup folder is not available: {folder}"));
        }
        Ok((api, cfg, user, folder))
    }

    pub async fn run_sync(&self) -> CmdResult<SyncReport> {
        let Ok(_guard) = self.0.job.try_lock() else {
            return Err("Another backup or restore is already running.".into());
        };
        let (api, cfg, user, folder) = self.job_context()?;
        if !user.can_write_any() {
            return Err("Your account has read-only access.".into());
        }
        let policy = cfg.policy.clone().unwrap_or_default();
        self.0.dirty.store(false, Ordering::Relaxed);
        self.set_status(|s| {
            s.phase = Phase::Scanning;
            s.message = "Checking for changes".into();
            s.job = Some("sync".into());
            s.progress = None;
            s.busy_files.clear();
        });
        let opts = SyncOptions {
            root: PathBuf::from(&folder),
            excludes: policy.exclude.clone(),
            index_path: index_path(&self.0.dirs.data, api.base(), &folder),
            staging: self.0.dirs.staging.clone(),
            user,
            device: cfg.device_name.clone(),
        };
        let cancel = self.new_cancel();
        let result = sync::run_sync(&api, &opts, &self.progress_fn(Phase::Uploading), &cancel).await;
        let now = now_ms();
        self.0.last_scan_at.store(now, Ordering::Relaxed);
        match result {
            Ok(report) => {
                self.0.sync_failures.store(0, Ordering::Relaxed);
                self.0.retry_sync_at.store(0, Ordering::Relaxed);
                let summary = describe_sync(&report);
                if report.changed() > 0 {
                    log_info!("{summary} ({} uploaded)", report.uploaded_bytes);
                }
                if !report.busy.is_empty() {
                    log_warn!("{} file(s) were in use and will be retried: {}", report.busy.len(), report.busy.join(", "));
                    self.mark_dirty();
                }
                if report.deletions_deferred {
                    log_warn!("Some files could not be read, so deletions were not recorded this time");
                }
                if !report.retried_folders.is_empty() {
                    log_info!(
                        "Files in {} changed while they were copied (Tally saved something). That copy was discarded; it is taken again when the files are quiet.",
                        report.retried_folders.join(", ")
                    );
                    self.mark_dirty();
                }
                self.update_config(|c| {
                    c.last_sync_at = Some(now);
                    c.last_sync_summary = Some(summary.clone());
                });
                if report.changed() > 0 && policy.tally.snapshots && self.tally_running().is_some() {
                    let engine = self.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = engine.capture_tally(false).await {
                            let now = now_ms();
                            // Do not fill the log when Tally's XML server is simply turned off.
                            if now - engine.0.tally_warned_at.swap(now, Ordering::Relaxed) > 6 * 3_600_000 {
                                log_warn!("Tally snapshot not saved: {e}");
                            }
                        }
                    });
                }
                self.set_status(|s| {
                    s.phase = Phase::Idle;
                    s.message = "Your files are protected".into();
                    s.job = None;
                    s.progress = None;
                    s.last_sync_at = Some(now);
                    s.last_sync_summary = Some(summary);
                    s.last_error = None;
                    s.busy_files = report.busy.clone();
                    s.changes_pending = self.0.dirty.load(Ordering::Relaxed);
                });
                Ok(report)
            }
            Err(e) => {
                self.0.dirty.store(true, Ordering::Relaxed);
                let failures = self.0.sync_failures.fetch_add(1, Ordering::Relaxed) + 1;
                let wait = (30_000i64 << failures.min(4)).min(10 * 60_000);
                self.0.retry_sync_at.store(now + wait, Ordering::Relaxed);
                let offline = e.downcast_ref::<ApiError>().is_some_and(|a| matches!(a, ApiError::Network(_)));
                let msg = self.map_err(e);
                log_error!("Backup failed: {msg}");
                if self.0.config.read().token.is_some() {
                    self.set_status(|s| {
                        s.phase = if offline { Phase::Offline } else { Phase::Error };
                        s.message = msg.clone();
                        s.job = None;
                        s.progress = None;
                        s.last_error = Some(msg.clone());
                    });
                }
                Err(msg)
            }
        }
    }

    pub async fn run_full(&self, origin: &'static str) -> CmdResult<FullReport> {
        let Ok(_guard) = self.0.job.try_lock() else {
            return Err("Another backup or restore is already running.".into());
        };
        let (api, cfg, user, folder) = self.job_context()?;
        if !user.is_admin() {
            return Err("Only the administrator can run complete backups.".into());
        }
        let policy = cfg.policy.clone().unwrap_or_default();
        let started = now_ms();
        self.set_status(|s| {
            s.phase = Phase::FullBackup;
            s.message = "Starting complete backup".into();
            s.job = Some("full".into());
            s.progress = None;
        });
        log_info!("Complete backup started ({origin}, {} compression)", policy.full.level);
        let snapshot_first = self.tally_running().is_some();
        if snapshot_first {
            log_info!("Tally is open, so the folder is copied and checked before it is compressed");
        }
        let opts = FullOptions {
            root: PathBuf::from(&folder),
            excludes: policy.exclude.clone(),
            staging: self.0.dirs.staging.clone(),
            level: policy.full.zstd_level(),
            origin,
            snapshot_first,
        };
        let cancel = self.new_cancel();
        let result = full::run_full_backup(&api, &opts, &self.progress_fn(Phase::FullBackup), &cancel).await;
        match result {
            Ok(report) => {
                self.0.retry_full_at.store(0, Ordering::Relaxed);
                log_info!(
                    "Complete backup #{} finished: {} files, {} → {} bytes in {}s",
                    report.id,
                    report.file_count,
                    report.original_size,
                    report.compressed_size,
                    report.seconds
                );
                if !report.skipped.is_empty() {
                    log_warn!("Skipped (in use): {}", report.skipped.join(", "));
                }
                self.update_config(|c| c.last_full_at = Some(started));
                let next = schedule::next_due(&policy.full, Some(started), chrono::Local::now());
                self.set_status(|s| {
                    s.phase = Phase::Idle;
                    s.message = "Your files are protected".into();
                    s.job = None;
                    s.progress = None;
                    s.last_full_at = Some(started);
                    s.next_full_at = next;
                    s.last_error = None;
                });
                Ok(report)
            }
            Err(e) if e.downcast_ref::<ChangedDuringCopy>().is_some() => {
                // Not a failure: Tally saved something during the copy. Try again when quiet.
                self.0.retry_full_at.store(now_ms() + 2 * 60_000, Ordering::Relaxed);
                self.0.last_change.store(now_ms(), Ordering::Relaxed);
                let msg = e.to_string();
                log_info!("Complete backup postponed: {msg}");
                self.set_status(|s| {
                    s.phase = Phase::WaitingQuiet;
                    s.message = "Tally saved files during the complete backup; it starts again when the files are quiet".into();
                    s.job = None;
                    s.progress = None;
                });
                Err(msg)
            }
            Err(e) => {
                self.0.retry_full_at.store(now_ms() + 15 * 60_000, Ordering::Relaxed);
                let msg = self.map_err(e);
                log_error!("Complete backup failed: {msg}");
                if self.0.config.read().token.is_some() {
                    self.set_status(|s| {
                        s.phase = Phase::Error;
                        s.message = format!("Complete backup failed: {msg}");
                        s.job = None;
                        s.progress = None;
                        s.last_error = Some(msg.clone());
                    });
                }
                Err(msg)
            }
        }
    }

    pub async fn plan_restore(&self, source: RestoreSource, dest: String, include: Vec<String>) -> CmdResult<RestorePlan> {
        let api = self.api()?;
        let cfg = self.config();
        let user = cfg.user.clone().ok_or("Sign in first.")?;
        if dest.trim().is_empty() {
            return Err("Choose where to restore the files.".into());
        }
        let excludes = cfg.policy.clone().unwrap_or_default().exclude;
        let plan = restore::build_plan(&api, source, Path::new(&dest), include, excludes, &user).await.map_err(|e| self.map_err(e))?;
        let mut plans = self.0.plans.lock();
        plans.push_back(plan.clone());
        while plans.len() > 3 {
            plans.pop_front();
        }
        Ok(plan)
    }

    pub async fn execute_restore(&self, plan_id: String, paths: Option<Vec<String>>, remove_extras: bool) -> CmdResult<RestoreReport> {
        let plan = self.0.plans.lock().iter().find(|p| p.id == plan_id).cloned().ok_or("This comparison has expired. Please compare again.")?;
        let Ok(_guard) = self.0.job.try_lock() else {
            return Err("Another backup or restore is already running.".into());
        };
        let api = self.api()?;
        self.set_status(|s| {
            s.phase = Phase::Restoring;
            s.message = "Preparing restore".into();
            s.job = Some("restore".into());
            s.progress = None;
        });
        log_info!("Restore started into {}", plan.dest);
        let opts = ExecuteOptions { paths: paths.map(|p| p.into_iter().collect::<HashSet<_>>()), remove_extras };
        let cancel = self.new_cancel();
        let result = restore::execute(&api, &plan, &opts, &self.0.dirs.staging, &self.progress_fn(Phase::Restoring), &cancel).await;
        let into_watched = self.config().watched_folder.as_deref().is_some_and(|w| same_folder(w, &plan.dest));
        if into_watched {
            // Record the restored state as the latest backup on the next run.
            self.mark_dirty();
        }
        self.set_status(|s| {
            s.phase = Phase::Idle;
            s.message = "Your files are protected".into();
            s.job = None;
            s.progress = None;
        });
        match result {
            Ok(r) => {
                log_info!("Restore finished: {} restored, {} removed, {} failed", r.restored, r.removed, r.failed.len());
                for f in r.failed.iter().take(20) {
                    log_warn!("Could not restore {}: {}", f.path, f.error);
                }
                Ok(r)
            }
            Err(e) => {
                let msg = self.map_err(e);
                log_error!("Restore failed: {msg}");
                Err(msg)
            }
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.0.app
    }

    // ---- Tally data snapshots ---------------------------------------------------------------

    pub fn tally_client(&self) -> TallyClient {
        TallyClient::new(self.config().policy.unwrap_or_default().tally.port)
    }

    /// Reads every company open in Tally and saves a snapshot for each one that is due
    /// (or all of them when `force`). Unchanged data is not recorded again.
    pub async fn capture_tally(&self, force: bool) -> CmdResult<Vec<SavedSnapshot>> {
        if self.0.tally_capturing.swap(true, Ordering::SeqCst) {
            return Err("A Tally snapshot is already being saved.".into());
        }
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.0.tally_capturing);

        let api = self.api()?;
        let cfg = self.config();
        let user = cfg.user.clone().ok_or("Sign in first.")?;
        let root = PathBuf::from(cfg.watched_folder.clone().ok_or("Choose the folder to back up first.")?);
        let policy = cfg.policy.clone().unwrap_or_default();
        let client = TallyClient::new(policy.tally.port);
        let companies = client.companies().await.map_err(|e| e.to_string())?;
        if companies.is_empty() {
            return Err("Tally is answering, but no company is open in it.".into());
        }
        let today = chrono::Local::now().date_naive();
        let mut saved = Vec::new();
        for company in companies {
            let key = tally_data::company_key(&company);
            let (r, c) = (root.clone(), company.clone());
            let folder = tokio::task::spawn_blocking(move || tally_data::company_folder(&r, &c)).await.ok().flatten();
            let allowed = match &folder {
                Some(f) => user.can_write(f),
                None => user.is_admin(),
            };
            if !allowed {
                continue;
            }
            let mut last = self.0.tally_snaps.lock().get(&key).cloned();
            if last.is_none() {
                let path = format!("/api/tally/snapshots?company={}&limit=1", crate::api::encode_segment(&key));
                if let Ok(v) = api.get::<serde_json::Value>(&path).await {
                    last = v["snapshots"].get(0).and_then(|s| Some((s["capturedAt"].as_i64()?, s["hash"].as_str()?.to_string())));
                }
            }
            let now = now_ms();
            if !force && last.as_ref().is_some_and(|(t, _)| now - t < policy.tally.every_minutes as i64 * 60_000) {
                continue;
            }
            let snap = match client.snapshot(&company, today).await {
                Ok(s) => s,
                Err(e) => {
                    log_warn!("Could not read {} from Tally: {e}", company.name);
                    continue;
                }
            };
            let result = tally_data::save(&api, &snap, folder, now, last.as_ref().map(|(_, h)| h.as_str())).await.map_err(|e| e.to_string())?;
            if result.recorded {
                log_info!("Saved Tally snapshot of {}: {} vouchers, {} ledgers", result.company_name, result.vouchers, result.ledgers);
            }
            self.0.tally_snaps.lock().insert(key, (now, result.hash.clone()));
            saved.push(result);
        }
        Ok(saved)
    }
}

/// Helper used by commands that must not run while Tally holds files open.
pub fn tally_confirmation(engine: &Engine, force: bool) -> CmdResult<()> {
    if force {
        return Ok(());
    }
    let policy = engine.config().policy.unwrap_or_default();
    if !policy.sync.waits_for_close() {
        // Quiet mode: copies taken while Tally is open are checked, so no confirmation is needed.
        return Ok(());
    }
    match engine.tally_running() {
        Some(name) => Err(format!("TALLY_RUNNING:{name}")),
        None => Ok(()),
    }
}

pub fn app_engine(app: &AppHandle) -> Engine {
    app.state::<Engine>().inner().clone()
}
