//! Settings stored on this computer (server address, session, watched folder, preferences).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::fsutil::atomic_write;
use crate::model::{Policy, UserInfo};

/// Baked in at build time so installed copies can open straight on the production server.
pub const DEFAULT_SERVER: Option<&str> = option_env!("AM_BACKUP_SERVER_URL");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalConfig {
    pub server_url: Option<String>,
    pub token: Option<String>,
    pub user: Option<UserInfo>,
    pub policy: Option<Policy>,
    pub watched_folder: Option<String>,
    pub device_name: String,
    pub close_to_tray: bool,
    pub theme: String,
    pub paused: bool,
    pub last_sync_at: Option<i64>,
    pub last_sync_summary: Option<String>,
    pub last_full_at: Option<i64>,
    /// Where this app created the server, when the built-in server setup was used here.
    pub server_deploy: Option<ServerDeploy>,
    /// "Start with Windows" is switched on once, the first time the app runs.
    pub autostart_initialized: bool,
}

/// Record of the Cloudflare resources the built-in server setup created or updated.
/// Contains no secrets: the Cloudflare token is never stored.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerDeploy {
    pub account_id: String,
    pub account_name: String,
    pub worker: String,
    pub database: String,
    pub database_id: String,
    pub bucket: String,
    pub url: String,
    pub build: String,
    pub deployed_at: i64,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER.map(str::to_string),
            token: None,
            user: None,
            policy: None,
            watched_folder: None,
            device_name: String::new(),
            close_to_tray: true,
            theme: "system".into(),
            paused: false,
            last_sync_at: None,
            last_sync_summary: None,
            last_full_at: None,
            server_deploy: None,
            autostart_initialized: false,
        }
    }
}

impl LocalConfig {
    pub fn load(path: &Path) -> Self {
        fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        atomic_write(path, &serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?)
    }
}

/// What the UI may see: everything except the session token.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub server_url: Option<String>,
    pub signed_in: bool,
    pub user: Option<UserInfo>,
    pub policy: Policy,
    pub watched_folder: Option<String>,
    pub device_name: String,
    pub close_to_tray: bool,
    pub theme: String,
    pub default_server: Option<String>,
    pub server_deploy: Option<ServerDeploy>,
}

impl From<&LocalConfig> for ConfigView {
    fn from(c: &LocalConfig) -> Self {
        Self {
            server_url: c.server_url.clone(),
            signed_in: c.token.is_some() && c.user.is_some(),
            user: c.user.clone(),
            policy: c.policy.clone().unwrap_or_default(),
            watched_folder: c.watched_folder.clone(),
            device_name: c.device_name.clone(),
            close_to_tray: c.close_to_tray,
            theme: c.theme.clone(),
            default_server: DEFAULT_SERVER.map(str::to_string),
            server_deploy: c.server_deploy.clone(),
        }
    }
}
