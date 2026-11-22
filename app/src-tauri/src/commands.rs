//! Tauri commands invoked by the UI.

use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::api::{normalize_base, Api, ApiError, Health, LoginResponse};
use crate::cloudflare::{self, Cf, CfAccount, CfAccountIn, DeployOutcome, DeployRequest, Preflight, ServerNames};
use crate::config::{ConfigView, ServerDeploy};
use crate::engine::{tally_confirmation, CmdResult, Engine, EngineStatus};
use crate::fsutil::{self, FolderSummary};
use crate::full::FullReport;
use crate::logger::{self, LogLine};
use crate::model::Policy;
use crate::restore::{RestorePlan, RestoreReport, RestoreSource};
use crate::sync::SyncReport;
use crate::log_info;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallError {
    status: u16,
    code: String,
    message: String,
}

impl From<String> for CallError {
    fn from(message: String) -> Self {
        CallError { status: 0, code: "client".into(), message }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    device_name: String,
    data_dir: String,
    log_dir: Option<String>,
}

#[tauri::command]
pub fn app_info(engine: State<'_, Engine>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        device_name: engine.config().device_name,
        data_dir: engine.0.dirs.data.display().to_string(),
        log_dir: logger::log_dir().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn app_ready(app: AppHandle) {
    crate::on_frontend_ready(&app);
}

#[tauri::command]
pub fn get_config(engine: State<'_, Engine>) -> ConfigView {
    engine.view()
}

#[tauri::command]
pub async fn check_server(engine: State<'_, Engine>, url: String) -> CmdResult<Health> {
    engine.anonymous_api(&url).health().await.map_err(|e| e.to_string())
}

/// Saves the server address after confirming it answers like an AM Backup server.
#[tauri::command]
pub async fn connect_server(engine: State<'_, Engine>, url: String) -> CmdResult<Health> {
    let base = normalize_base(&url);
    let health = engine.anonymous_api(&base).health().await.map_err(|e| e.to_string())?;
    let changed = engine.config().server_url.as_deref() != Some(base.as_str());
    engine.update_config(|c| {
        if changed {
            c.token = None;
            c.user = None;
            c.policy = None;
        }
        c.server_url = Some(base.clone());
    });
    log_info!("Using server {base} ({})", health.environment.clone().unwrap_or_default());
    Ok(health)
}

async fn finish_login(engine: &Engine, login: LoginResponse) -> CmdResult<ConfigView> {
    engine.update_config(|c| {
        c.token = Some(login.token);
        c.user = Some(login.user.clone());
    });
    log_info!("Signed in as {}", login.user.username);
    let view = engine.refresh_session().await?;
    engine.mark_dirty();
    engine.wake();
    Ok(view)
}

#[tauri::command]
pub async fn login(engine: State<'_, Engine>, username: String, password: String) -> CmdResult<ConfigView> {
    let api = engine.api()?;
    let anon = engine.anonymous_api(api.base());
    let res: LoginResponse = anon.post("/api/auth/login", &json!({ "username": username.trim(), "password": password })).await.map_err(|e| e.to_string())?;
    finish_login(&engine, res).await
}

/// Posts to a setup endpoint. Right after the built-in server setup gives the server a new
/// setup key, Cloudflare can take a few seconds to start using it, so `wait_for_key` retries a
/// "key not correct" answer for up to a minute.
async fn post_setup<T: serde::de::DeserializeOwned>(anon: &Api, path: &str, body: &Value, wait_for_key: bool) -> CmdResult<T> {
    let start = std::time::Instant::now();
    loop {
        match anon.post::<T, _>(path, body).await {
            Err(ApiError::Server { status: 403, .. }) | Err(ApiError::Server { status: 503, .. })
                if wait_for_key && start.elapsed() < std::time::Duration::from_secs(60) =>
            {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            other => return other.map_err(|e| e.to_string()),
        }
    }
}

#[tauri::command]
pub async fn setup_admin(
    engine: State<'_, Engine>,
    setup_key: String,
    username: String,
    display_name: String,
    password: String,
    wait_for_key: Option<bool>,
) -> CmdResult<ConfigView> {
    let api = engine.api()?;
    let anon = engine.anonymous_api(api.base());
    let body = json!({ "setupKey": setup_key.trim(), "username": username.trim(), "displayName": display_name.trim(), "password": password });
    let res: LoginResponse = post_setup(&anon, "/api/setup", &body, wait_for_key.unwrap_or(false)).await?;
    finish_login(&engine, res).await
}

#[tauri::command]
pub async fn reset_admin(engine: State<'_, Engine>, setup_key: String, password: String, wait_for_key: Option<bool>) -> CmdResult<String> {
    let api = engine.api()?;
    let anon = engine.anonymous_api(api.base());
    let body = json!({ "setupKey": setup_key.trim(), "password": password });
    let res: Value = post_setup(&anon, "/api/setup/reset-admin", &body, wait_for_key.unwrap_or(false)).await?;
    Ok(res.get("username").and_then(|v| v.as_str()).unwrap_or("admin").to_string())
}

#[tauri::command]
pub async fn logout(engine: State<'_, Engine>) -> CmdResult<()> {
    if let Ok(api) = engine.api() {
        if api.has_token() {
            let _ = api.call(Method::POST, "/api/auth/logout", None).await;
        }
    }
    engine.update_config(|c| {
        c.token = None;
        c.user = None;
        c.policy = None;
    });
    engine.stop_watching();
    engine.wake();
    log_info!("Signed out");
    Ok(())
}

#[tauri::command]
pub async fn refresh_session(engine: State<'_, Engine>) -> CmdResult<ConfigView> {
    engine.refresh_session().await
}

/// Generic authenticated request to the server for the management screens.
#[tauri::command]
pub async fn api_call(engine: State<'_, Engine>, method: String, path: String, body: Option<Value>) -> Result<Value, CallError> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err("Invalid request path".to_string().into());
    }
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        _ => return Err("Unsupported method".to_string().into()),
    };
    let api = engine.api()?;
    match api.call(method, &path, body.as_ref()).await {
        Ok(v) => Ok(v),
        Err(e) => {
            let (status, code) = match &e {
                ApiError::Unauthorized(_) => (401, "unauthorized".to_string()),
                ApiError::Server { status, code, .. } => (*status, code.clone()),
                ApiError::Network(_) => (0, "network".to_string()),
            };
            let message = engine.map_api_err(e);
            Err(CallError { status, code, message })
        }
    }
}

#[tauri::command]
pub async fn set_watched_folder(engine: State<'_, Engine>, path: Option<String>) -> CmdResult<ConfigView> {
    if let Some(p) = &path {
        let pb = PathBuf::from(p);
        if !pb.is_dir() {
            return Err("That folder does not exist or cannot be opened.".into());
        }
        if pb.parent().is_none() {
            return Err("Please choose a folder rather than a whole drive.".into());
        }
    }
    engine.update_config(|c| c.watched_folder = path.clone());
    engine.stop_watching();
    engine.mark_dirty();
    engine.wake();
    log_info!("Backup folder set to {}", path.as_deref().unwrap_or("(none)"));
    Ok(engine.view())
}

#[tauri::command]
pub async fn scan_folder(path: String, excludes: Option<Vec<String>>) -> CmdResult<FolderSummary> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&path);
        let scan = fsutil::scan(root, &excludes.unwrap_or_default()).map_err(|e| e.to_string())?;
        Ok(fsutil::summarize(root, &scan.files))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn engine_status(engine: State<'_, Engine>) -> EngineStatus {
    engine.status()
}

#[tauri::command]
pub async fn sync_now(engine: State<'_, Engine>, force: bool) -> CmdResult<SyncReport> {
    tally_confirmation(&engine, force)?;
    engine.run_sync().await
}

#[tauri::command]
pub async fn full_backup_now(engine: State<'_, Engine>, force: bool) -> CmdResult<FullReport> {
    tally_confirmation(&engine, force)?;
    engine.run_full("manual").await
}

#[tauri::command]
pub fn set_paused(engine: State<'_, Engine>, paused: bool) -> EngineStatus {
    engine.set_paused(paused);
    engine.status()
}

#[tauri::command]
pub fn cancel_job(engine: State<'_, Engine>) {
    engine.cancel_job();
}

#[tauri::command]
pub fn tally_status(engine: State<'_, Engine>) -> Option<String> {
    engine.tally_running()
}

#[tauri::command]
pub async fn restore_plan(engine: State<'_, Engine>, source: RestoreSource, dest: String, include: Vec<String>) -> CmdResult<RestorePlan> {
    engine.plan_restore(source, dest, include).await
}

#[tauri::command]
pub async fn restore_execute(
    engine: State<'_, Engine>,
    plan_id: String,
    paths: Option<Vec<String>>,
    remove_extras: bool,
) -> CmdResult<RestoreReport> {
    engine.execute_restore(plan_id, paths, remove_extras).await
}

#[tauri::command]
pub fn policy_changed(engine: State<'_, Engine>, policy: Policy) {
    engine.set_policy(policy);
}

#[tauri::command]
pub fn set_preferences(
    engine: State<'_, Engine>,
    close_to_tray: Option<bool>,
    theme: Option<String>,
    device_name: Option<String>,
) -> ConfigView {
    engine.update_config(|c| {
        if let Some(v) = close_to_tray {
            c.close_to_tray = v;
        }
        if let Some(t) = theme.filter(|t| ["system", "light", "dark"].contains(&t.as_str())) {
            c.theme = t;
        }
        if let Some(d) = device_name.map(|d| d.trim().to_string()).filter(|d| !d.is_empty() && d.len() <= 60) {
            c.device_name = d;
        }
    });
    engine.view()
}

#[tauri::command]
pub fn get_logs() -> Vec<LogLine> {
    logger::recent()
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String, reveal: Option<bool>) -> CmdResult<()> {
    let opener = app.opener();
    let res = if reveal.unwrap_or(false) { opener.reveal_item_in_dir(&path) } else { opener.open_path(&path, None::<&str>) };
    res.map_err(|e| format!("Could not open {path}: {e}"))
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    if !url.starts_with("https://") {
        return Err("Only secure links can be opened.".into());
    }
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// ---- built-in server setup (Cloudflare) -------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSetupInfo {
    version: String,
    build: String,
    token_url: String,
    defaults: ServerNames,
}

#[tauri::command]
pub fn server_setup_info() -> ServerSetupInfo {
    let b = cloudflare::bundle();
    ServerSetupInfo { version: b.version.clone(), build: b.build.clone(), token_url: cloudflare::TOKEN_TEMPLATE_URL.into(), defaults: ServerNames::default() }
}

#[tauri::command]
pub async fn cf_accounts(token: String) -> CmdResult<Vec<CfAccount>> {
    cloudflare::list_accounts(&Cf::new(&token)).await
}

#[tauri::command]
pub async fn cf_preflight(token: String, account: CfAccountIn, names: ServerNames) -> CmdResult<Preflight> {
    let account = CfAccount { id: account.id, name: account.name };
    cloudflare::preflight(&Cf::new(&token), &account, names).await
}

/// Creates or updates the server, reporting each step as a `server-setup` event, then points
/// this app at it. The token is used for this call only and is never saved.
#[tauri::command]
pub async fn cf_deploy(app: AppHandle, engine: State<'_, Engine>, token: String, request: DeployRequest) -> CmdResult<DeployOutcome> {
    let cf = Cf::new(&token);
    let emitter = app.clone();
    let emit = move |ev: cloudflare::StepEvent| {
        let _ = emitter.emit("server-setup", ev);
    };
    log_info!("Server setup started for {} in account {}", request.names.worker, request.account.id);
    let outcome = match cloudflare::deploy(&cf, &request, &emit).await {
        Ok(o) => o,
        Err(e) => {
            log_info!("Server setup stopped: {e}");
            return Err(e);
        }
    };
    let url = outcome.server_url.clone();
    let changed = engine.config().server_url.as_deref() != Some(url.as_str());
    engine.update_config(|c| {
        if changed {
            c.token = None;
            c.user = None;
            c.policy = None;
        }
        c.server_url = Some(url.clone());
        c.server_deploy = Some(ServerDeploy {
            account_id: request.account.id.clone(),
            account_name: request.account.name.clone(),
            worker: outcome.names.worker.clone(),
            database: outcome.names.database.clone(),
            database_id: outcome.database_id.clone(),
            bucket: outcome.names.bucket.clone(),
            url: url.clone(),
            build: outcome.build.clone(),
            deployed_at: chrono::Utc::now().timestamp_millis(),
        });
    });
    log_info!("Server setup finished: {url} (build {}, online: {})", outcome.build, outcome.online);
    if changed {
        engine.stop_watching();
        engine.wake();
    }
    Ok(outcome)
}

/// Gives the server a new setup key (for example when the administrator password and the
/// old key are both lost). Needs the same Cloudflare token as the setup.
#[tauri::command]
pub async fn cf_new_setup_key(token: String, account_id: String, worker: String) -> CmdResult<String> {
    let key = cloudflare::new_setup_key();
    cloudflare::put_setup_key(&Cf::new(&token), &account_id, &worker, &key).await?;
    log_info!("A new setup key was set on {worker}");
    Ok(key)
}

// ---- Tally data (via Tally's XML server on this computer) --------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TallyCheck {
    port: u16,
    reachable: bool,
    tally_running: Option<String>,
    companies: Vec<crate::tally_data::TallyCompany>,
    error: Option<String>,
}

/// Is Tally's XML server answering here, and which companies are open?
#[tauri::command]
pub async fn tally_check(engine: State<'_, Engine>) -> CmdResult<TallyCheck> {
    let client = engine.tally_client();
    let running = engine.tally_running();
    match client.companies().await {
        Ok(companies) => Ok(TallyCheck { port: client.port, reachable: true, tally_running: running, companies, error: None }),
        Err(e) => Ok(TallyCheck { port: client.port, reachable: false, tally_running: running, companies: vec![], error: Some(e.to_string()) }),
    }
}

/// The company's data as Tally has it now (not saved), for comparing with a snapshot.
#[tauri::command]
pub async fn tally_live(engine: State<'_, Engine>, company: String) -> CmdResult<crate::tally_data::Snapshot> {
    let client = engine.tally_client();
    let companies = client.companies().await.map_err(|e| e.to_string())?;
    let c = companies
        .into_iter()
        .find(|c| c.name == company || c.number.as_deref() == Some(company.as_str()))
        .ok_or_else(|| format!("\"{company}\" is not open in Tally on this computer."))?;
    client.snapshot(&c, chrono::Local::now().date_naive()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tally_capture_now(engine: State<'_, Engine>) -> CmdResult<Vec<crate::tally_data::SavedSnapshot>> {
    engine.capture_tally(true).await
}
