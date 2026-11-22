//! Built-in server setup.
//!
//! Creates or updates the AM Backup server in the office's own Cloudflare account through the
//! Cloudflare REST API, so one installer covers both the backup app and the server. Nothing else
//! (Node.js, Wrangler) is needed: the Worker and its D1 migrations are packed into the app at
//! build time by `server/scripts/bundle.mjs`.
//!
//! Every step is idempotent. Running it again finds the existing database, storage bucket and
//! Worker, applies only new database migrations and uploads the Worker code from this app version.

use reqwest::{multipart, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const WORKER_JS: &str = include_str!("../worker/index.js");
const WORKER_META: &str = include_str!("../worker/worker.json");
const CF_API: &str = "https://api.cloudflare.com/client/v4";

/// Opens the Cloudflare token form with exactly the permissions the setup needs.
pub const TOKEN_TEMPLATE_URL: &str = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=AM%20Backup%20server%20setup";

#[derive(Debug, Clone, Deserialize)]
pub struct Migration {
    pub name: String,
    pub sql: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerBundle {
    pub version: String,
    pub build: String,
    pub compatibility_date: String,
    pub compatibility_flags: Vec<String>,
    pub crons: Vec<String>,
    pub vars: BTreeMap<String, String>,
    pub migrations: Vec<Migration>,
}

pub fn bundle() -> &'static WorkerBundle {
    static B: OnceLock<WorkerBundle> = OnceLock::new();
    B.get_or_init(|| serde_json::from_str(WORKER_META).expect("packed worker.json is valid"))
}

// ---- errors ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CfError {
    pub status: u16,
    pub code: i64,
    pub message: String,
}

impl CfError {
    fn network(e: reqwest::Error) -> Self {
        let message = if e.is_connect() || e.is_timeout() {
            "Can't reach Cloudflare. Check the internet connection and try again.".to_string()
        } else {
            format!("Network problem while talking to Cloudflare: {e}")
        };
        CfError { status: 0, code: 0, message }
    }
    pub fn is_auth(&self) -> bool {
        matches!(self.status, 401 | 403) || matches!(self.code, 1000 | 6003 | 6111 | 9106 | 9109 | 10000 | 10001)
    }
    pub fn r2_not_enabled(&self) -> bool {
        self.code == 10042 || self.message.to_ascii_lowercase().contains("enable r2")
    }
    pub fn not_found(&self) -> bool {
        self.status == 404
    }
}

impl std::fmt::Display for CfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.code > 0 {
            write!(f, "{} (Cloudflare code {})", self.message, self.code)
        } else {
            write!(f, "{}", self.message)
        }
    }
}

/// Turns a Cloudflare error into a sentence an office user can act on.
fn explain(what: &str, needs: &str, e: &CfError) -> String {
    if e.r2_not_enabled() {
        return "R2 storage is not turned on for this Cloudflare account yet. Open R2 in the Cloudflare dashboard, turn it on (the free plan is enough), then try again.".into();
    }
    if e.is_auth() {
        return format!("The token is not allowed to {what}. Create the token again with the button in step 2 so it has \"{needs}\".");
    }
    format!("Could not {what}: {e}")
}

// ---- client ---------------------------------------------------------------------------

pub struct Cf {
    client: Client,
    base: String,
    token: String,
    /// Tests point the "is the server online" check at a local stand-in.
    health_override: Option<String>,
}

impl Cf {
    pub fn new(token: &str) -> Self {
        Self::with_base(CF_API, token, None)
    }

    pub fn with_base(base: &str, token: &str, health_override: Option<String>) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("AMBackup/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client");
        Self { client, base: base.trim_end_matches('/').to_string(), token: token.trim().to_string(), health_override }
    }

    async fn parse(res: reqwest::Response) -> Result<Value, CfError> {
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let success = body.get("success").and_then(Value::as_bool).unwrap_or(status < 300);
        if success && status < 300 {
            return Ok(body.get("result").cloned().unwrap_or(Value::Null));
        }
        let first = body.get("errors").and_then(|e| e.get(0));
        let code = first.and_then(|e| e.get("code")).and_then(Value::as_i64).unwrap_or(0);
        let message = first
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Cloudflare answered {status}"));
        Err(CfError { status, code, message })
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, CfError> {
        let mut attempt = 0;
        loop {
            let mut rb = self.client.request(method.clone(), format!("{}{}", self.base, path)).bearer_auth(&self.token);
            if let Some(b) = &body {
                rb = rb.json(b);
            }
            let result = match rb.send().await {
                Ok(res) => Self::parse(res).await,
                Err(e) => Err(CfError::network(e)),
            };
            match result {
                Err(e) if attempt < 3 && (e.status == 0 || e.status == 429 || e.status >= 500) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(800 * attempt)).await;
                }
                other => return other,
            }
        }
    }

    async fn get(&self, path: &str) -> Result<Value, CfError> {
        self.call(Method::GET, path, None).await
    }
}

// ---- token and account ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CfAccount {
    pub id: String,
    pub name: String,
}

pub async fn list_accounts(cf: &Cf) -> Result<Vec<CfAccount>, String> {
    if cf.token.len() < 20 || cf.token.contains(char::is_whitespace) {
        return Err("That does not look like a Cloudflare token. Copy the whole token (about 40 letters and numbers) and paste it again.".into());
    }
    let result = cf.get("/accounts?per_page=50").await.map_err(|e| {
        if e.is_auth() {
            "Cloudflare did not accept this token. Check that you copied all of it, and that it is not deleted or expired.".to_string()
        } else {
            e.to_string()
        }
    })?;
    let accounts: Vec<CfAccount> = result
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    Some(CfAccount { id: x.get("id")?.as_str()?.to_string(), name: x.get("name").and_then(Value::as_str).unwrap_or("Cloudflare account").to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    if accounts.is_empty() {
        return Err("This token cannot see any Cloudflare account. When you create it, keep \"All accounts\" (or your account) under Account Resources.".into());
    }
    Ok(accounts)
}

// ---- names ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerNames {
    pub worker: String,
    pub database: String,
    pub bucket: String,
}

impl Default for ServerNames {
    fn default() -> Self {
        Self { worker: "am-backup-api".into(), database: "am_backup".into(), bucket: "am-backup-files".into() }
    }
}

fn valid_label(s: &str, allow_underscore: bool, min: usize, max: usize) -> bool {
    let b = s.as_bytes();
    b.len() >= min
        && b.len() <= max
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || (allow_underscore && *c == b'_'))
}

impl ServerNames {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_label(&self.worker, false, 1, 63) {
            return Err("The server name can use lowercase letters, numbers and dashes (up to 63).".into());
        }
        if !valid_label(&self.database, true, 1, 63) {
            return Err("The database name can use lowercase letters, numbers, dashes and underscores.".into());
        }
        if !valid_label(&self.bucket, false, 3, 63) {
            return Err("The storage name needs 3 to 63 lowercase letters, numbers or dashes.".into());
        }
        Ok(())
    }
}

pub fn valid_subdomain(s: &str) -> bool {
    valid_label(s, false, 1, 63)
}

/// A workers.dev name derived from the account name, used when the account has none yet.
pub fn suggest_subdomain(account_name: &str) -> String {
    let mut s: String = account_name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-');
    let s: String = s.chars().take(40).collect::<String>().trim_matches('-').to_string();
    let base = if s.len() < 3 { "am-backup".to_string() } else { s };
    format!("{base}-{}", random_code(4).to_ascii_lowercase())
}

// ---- checks before setup --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub checks: Vec<Check>,
    pub ready: bool,
    pub names: ServerNames,
    pub worker_exists: bool,
    pub database_id: Option<String>,
    pub bucket_exists: bool,
    pub subdomain: Option<String>,
    pub suggested_subdomain: String,
    pub server_url: Option<String>,
    pub bundled_build: String,
}

fn bindings_of(settings: &Value) -> Vec<Value> {
    settings.get("bindings").and_then(Value::as_array).cloned().unwrap_or_default()
}

async fn account_subdomain(cf: &Cf, account: &str) -> Result<Option<String>, CfError> {
    match cf.get(&format!("/accounts/{account}/workers/subdomain")).await {
        Ok(v) => Ok(v.get("subdomain").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)),
        Err(e) if e.not_found() || e.code == 10007 => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn workers_dev_url(worker: &str, subdomain: &str) -> String {
    format!("https://{worker}.{subdomain}.workers.dev")
}

pub async fn preflight(cf: &Cf, account: &CfAccount, wanted: ServerNames) -> Result<Preflight, String> {
    wanted.validate()?;
    let a = &account.id;
    let mut names = wanted.clone();
    let mut checks = Vec::new();

    // Workers
    let mut worker_exists = false;
    let mut bound_db: Option<String> = None;
    match cf.get(&format!("/accounts/{a}/workers/scripts")).await {
        Ok(list) => {
            worker_exists = list
                .as_array()
                .map(|l| l.iter().any(|s| s.get("id").and_then(Value::as_str) == Some(names.worker.as_str())))
                .unwrap_or(false);
            if worker_exists {
                // Reuse whatever database and storage the existing server is connected to.
                if let Ok(settings) = cf.get(&format!("/accounts/{a}/workers/scripts/{}/settings", names.worker)).await {
                    for b in bindings_of(&settings) {
                        let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                        if ty == "d1" && name == "DB" {
                            bound_db = b.get("id").or_else(|| b.get("database_id")).and_then(Value::as_str).map(str::to_string);
                        }
                        if ty == "r2_bucket" && name == "BUCKET" {
                            if let Some(bucket) = b.get("bucket_name").and_then(Value::as_str) {
                                names.bucket = bucket.to_string();
                            }
                        }
                    }
                }
            }
            checks.push(Check {
                id: "workers",
                label: "Workers (runs the server)",
                ok: true,
                detail: if worker_exists { format!("Found the server \"{}\". It will be updated.", names.worker) } else { "Allowed".into() },
            });
        }
        Err(e) => checks.push(Check { id: "workers", label: "Workers (runs the server)", ok: false, detail: explain("manage Workers", "Workers Scripts: Edit", &e) }),
    }

    // D1
    let mut database_id = None;
    let d1 = match &bound_db {
        Some(id) => cf.get(&format!("/accounts/{a}/d1/database/{id}")).await.map(|v| vec![v]),
        None => cf
            .get(&format!("/accounts/{a}/d1/database?name={}&per_page=100", names.database))
            .await
            .map(|v| v.as_array().cloned().unwrap_or_default()),
    };
    match d1 {
        Ok(list) => {
            let found = list.iter().find(|d| bound_db.is_some() || d.get("name").and_then(Value::as_str) == Some(names.database.as_str()));
            if let Some(d) = found {
                database_id = d.get("uuid").and_then(Value::as_str).map(str::to_string);
                if let Some(n) = d.get("name").and_then(Value::as_str) {
                    names.database = n.to_string();
                }
            }
            checks.push(Check {
                id: "d1",
                label: "D1 database (users and file list)",
                ok: true,
                detail: if database_id.is_some() { format!("Found \"{}\". It will be kept.", names.database) } else { "Allowed".into() },
            });
        }
        Err(e) => checks.push(Check { id: "d1", label: "D1 database (users and file list)", ok: false, detail: explain("manage D1 databases", "D1: Edit", &e) }),
    }

    // R2
    let mut bucket_exists = false;
    match cf.get(&format!("/accounts/{a}/r2/buckets?per_page=1000")).await {
        Ok(v) => {
            bucket_exists = v
                .get("buckets")
                .and_then(Value::as_array)
                .map(|l| l.iter().any(|b| b.get("name").and_then(Value::as_str) == Some(names.bucket.as_str())))
                .unwrap_or(false);
            checks.push(Check {
                id: "r2",
                label: "R2 storage (backed-up files)",
                ok: true,
                detail: if bucket_exists { format!("Found \"{}\". It will be kept.", names.bucket) } else { "Allowed".into() },
            });
        }
        Err(e) => checks.push(Check { id: "r2", label: "R2 storage (backed-up files)", ok: false, detail: explain("manage R2 storage", "Workers R2 Storage: Edit", &e) }),
    }

    // workers.dev address
    let mut subdomain = None;
    match account_subdomain(cf, a).await {
        Ok(s) => {
            subdomain = s;
            checks.push(Check {
                id: "address",
                label: "Web address",
                ok: true,
                detail: match &subdomain {
                    Some(s) => workers_dev_url(&names.worker, s).replace("https://", ""),
                    None => "This account has no workers.dev name yet. One will be created.".into(),
                },
            });
        }
        Err(e) => checks.push(Check { id: "address", label: "Web address", ok: false, detail: explain("read the workers.dev address", "Workers Scripts: Edit", &e) }),
    }

    let ready = checks.iter().all(|c| c.ok);
    Ok(Preflight {
        ready,
        server_url: subdomain.as_deref().map(|s| workers_dev_url(&names.worker, s)),
        suggested_subdomain: suggest_subdomain(&account.name),
        names,
        worker_exists,
        database_id,
        bucket_exists,
        subdomain,
        checks,
        bundled_build: bundle().build.clone(),
    })
}

// ---- setup ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pub step: &'static str,
    pub state: &'static str,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRequest {
    pub account: CfAccountIn,
    pub names: ServerNames,
    /// Only used when the account has no workers.dev name yet.
    pub subdomain: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfAccountIn {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployOutcome {
    pub server_url: String,
    pub created_worker: bool,
    /// Set when this run gave the server a new setup key (new server, or one waiting for its administrator).
    pub setup_key: Option<String>,
    pub online: bool,
    pub needs_setup: bool,
    pub build: String,
    pub names: ServerNames,
    pub database_id: String,
}

/// Readable one-time key, for example `K7QM-2XRA-…` (32 characters of base32).
pub fn random_code(chars: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // no I, L, O, U
    let mut bytes = vec![0u8; chars];
    getrandom::fill(&mut bytes).expect("system random generator");
    bytes.iter().map(|b| ALPHABET[(*b as usize) % 32] as char).collect()
}

pub fn new_setup_key() -> String {
    let raw = random_code(32);
    raw.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

fn query_rows(result: &Value, statement: usize) -> Vec<Value> {
    result
        .as_array()
        .and_then(|a| a.get(statement))
        .and_then(|r| r.get("results"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub async fn put_setup_key(cf: &Cf, account: &str, worker: &str, key: &str) -> Result<(), String> {
    cf.call(
        Method::PUT,
        &format!("/accounts/{account}/workers/scripts/{worker}/secrets"),
        Some(json!({ "name": "SETUP_KEY", "text": key, "type": "secret_text" })),
    )
    .await
    .map(|_| ())
    .map_err(|e| explain("set the setup key", "Workers Scripts: Edit", &e))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthLite {
    pub ok: bool,
    pub service: Option<String>,
    pub build: Option<String>,
    pub needs_setup: bool,
}

/// Waits until the server answers at its address, ideally with the code just uploaded.
pub async fn wait_online(health_url: &str, build: &str, limit: Duration) -> Option<HealthLite> {
    let client = Client::builder().timeout(Duration::from_secs(10)).build().ok()?;
    let start = Instant::now();
    let mut last_ok: Option<HealthLite> = None;
    while start.elapsed() < limit {
        if let Ok(res) = client.get(health_url).header("cache-control", "no-cache").send().await {
            if let Ok(h) = res.json::<HealthLite>().await {
                if h.ok && h.service.as_deref() == Some("am-backup") {
                    if h.build.as_deref() == Some(build) {
                        return Some(h);
                    }
                    // An older copy can answer for a few seconds after an update.
                    if start.elapsed() > Duration::from_secs(40) {
                        return Some(h);
                    }
                    last_ok = Some(h);
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    last_ok
}

pub async fn deploy(cf: &Cf, req: &DeployRequest, emit: &(dyn Fn(StepEvent) + Send + Sync)) -> Result<DeployOutcome, String> {
    let b = bundle();
    let a = req.account.id.as_str();
    let account = CfAccount { id: req.account.id.clone(), name: req.account.name.clone() };
    let step = |step: &'static str, state: &'static str, detail: Option<String>| emit(StepEvent { step, state, detail });
    let fail = |step_id: &'static str, msg: String| {
        emit(StepEvent { step: step_id, state: "failed", detail: Some(msg.clone()) });
        msg
    };

    step("check", "running", None);
    let pre = preflight(cf, &account, req.names.clone()).await.map_err(|m| fail("check", m))?;
    if let Some(bad) = pre.checks.iter().find(|c| !c.ok) {
        return Err(fail("check", bad.detail.clone()));
    }
    let names = pre.names.clone();
    step("check", "done", None);

    // 1. Database
    step("database", "running", None);
    let database_id = match pre.database_id.clone() {
        Some(id) => {
            step("database", "done", Some(format!("Using the existing database \"{}\"", names.database)));
            id
        }
        None => {
            let created = cf
                .call(Method::POST, &format!("/accounts/{a}/d1/database"), Some(json!({ "name": names.database })))
                .await
                .map_err(|e| fail("database", explain("create the database", "D1: Edit", &e)))?;
            let id = created
                .get("uuid")
                .and_then(Value::as_str)
                .ok_or_else(|| fail("database", "Cloudflare created the database but did not return its ID. Try again.".into()))?
                .to_string();
            step("database", "done", Some(format!("Created \"{}\"", names.database)));
            id
        }
    };

    // 2. Tables (same bookkeeping table as `wrangler d1 migrations apply`)
    step("tables", "running", None);
    let q = format!("/accounts/{a}/d1/database/{database_id}/query");
    cf.call(
        Method::POST,
        &q,
        Some(json!({ "sql": "CREATE TABLE IF NOT EXISTS d1_migrations(\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT UNIQUE,\n  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);" })),
    )
    .await
    .map_err(|e| fail("tables", explain("prepare the database", "D1: Edit", &e)))?;
    let applied = cf
        .call(Method::POST, &q, Some(json!({ "sql": "SELECT name FROM d1_migrations ORDER BY id;" })))
        .await
        .map_err(|e| fail("tables", explain("read the database", "D1: Edit", &e)))?;
    let done: Vec<String> = query_rows(&applied, 0).iter().filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_string)).collect();
    let mut count = 0;
    for m in b.migrations.iter().filter(|m| !done.contains(&m.name)) {
        let mut sql = m.sql.trim_end().to_string();
        if !sql.ends_with(';') {
            sql.push(';');
        }
        sql.push_str(&format!("\nINSERT INTO d1_migrations (name) VALUES ('{}');", m.name.replace('\'', "''")));
        cf.call(Method::POST, &q, Some(json!({ "sql": sql })))
            .await
            .map_err(|e| fail("tables", format!("Could not update the database tables ({}): {e}", m.name)))?;
        count += 1;
    }
    step("tables", "done", Some(if count == 0 { "Already up to date".into() } else { format!("{count} update(s) applied") }));

    // 3. File storage
    step("storage", "running", None);
    if pre.bucket_exists {
        step("storage", "done", Some(format!("Using the existing storage \"{}\"", names.bucket)));
    } else {
        match cf.call(Method::POST, &format!("/accounts/{a}/r2/buckets"), Some(json!({ "name": names.bucket }))).await {
            Ok(_) => step("storage", "done", Some(format!("Created \"{}\"", names.bucket))),
            Err(e) if e.code == 10004 || e.status == 409 => step("storage", "done", Some(format!("Using the existing storage \"{}\"", names.bucket))),
            Err(e) => return Err(fail("storage", explain("create the file storage", "Workers R2 Storage: Edit", &e))),
        }
    }

    // 4. Server code
    step("upload", "running", None);
    let new_key = if pre.worker_exists { None } else { Some(new_setup_key()) };
    let mut bindings = vec![
        json!({ "type": "d1", "name": "DB", "id": database_id }),
        json!({ "type": "r2_bucket", "name": "BUCKET", "bucket_name": names.bucket }),
    ];
    for (k, v) in &b.vars {
        bindings.push(json!({ "type": "plain_text", "name": k, "text": v }));
    }
    bindings.push(json!({ "type": "plain_text", "name": "SERVER_BUILD", "text": b.build }));
    if let Some(key) = &new_key {
        bindings.push(json!({ "type": "secret_text", "name": "SETUP_KEY", "text": key }));
    }
    let metadata = json!({
        "main_module": "index.js",
        "compatibility_date": b.compatibility_date,
        "compatibility_flags": b.compatibility_flags,
        "bindings": bindings,
        "keep_bindings": ["secret_text"],
    });
    let form = multipart::Form::new()
        .part("metadata", multipart::Part::text(metadata.to_string()).mime_str("application/json").expect("mime"))
        .part("index.js", multipart::Part::text(WORKER_JS).file_name("index.js").mime_str("application/javascript+module").expect("mime"));
    let res = cf
        .client
        .put(format!("{}/accounts/{a}/workers/scripts/{}", cf.base, names.worker))
        .bearer_auth(&cf.token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| fail("upload", CfError::network(e).message))?;
    Cf::parse(res).await.map_err(|e| fail("upload", explain("upload the server", "Workers Scripts: Edit", &e)))?;
    step("upload", "done", Some(format!("Version {}", b.version)));

    // 5. Nightly housekeeping
    step("schedule", "running", None);
    let crons: Vec<Value> = b.crons.iter().map(|c| json!({ "cron": c })).collect();
    cf.call(Method::PUT, &format!("/accounts/{a}/workers/scripts/{}/schedules", names.worker), Some(Value::Array(crons)))
        .await
        .map_err(|e| fail("schedule", explain("turn on nightly housekeeping", "Workers Scripts: Edit", &e)))?;
    step("schedule", "done", None);

    // 6. Web address
    step("address", "running", None);
    let subdomain = match pre.subdomain.clone() {
        Some(s) => s,
        None => {
            let wanted = req.subdomain.clone().unwrap_or_else(|| pre.suggested_subdomain.clone()).trim().to_ascii_lowercase();
            if !valid_subdomain(&wanted) {
                return Err(fail("address", "The workers.dev name can use lowercase letters, numbers and dashes.".into()));
            }
            let v = cf
                .call(Method::PUT, &format!("/accounts/{a}/workers/subdomain"), Some(json!({ "subdomain": wanted })))
                .await
                .map_err(|e| {
                    fail(
                        "address",
                        if e.status == 409 || e.message.to_ascii_lowercase().contains("taken") || e.message.to_ascii_lowercase().contains("exists") {
                            format!("The workers.dev name \"{wanted}\" is already taken. Choose another name and try again.")
                        } else {
                            explain("create the workers.dev address", "Workers Scripts: Edit", &e)
                        },
                    )
                })?;
            v.get("subdomain").and_then(Value::as_str).unwrap_or(&wanted).to_string()
        }
    };
    cf.call(
        Method::POST,
        &format!("/accounts/{a}/workers/scripts/{}/subdomain", names.worker),
        Some(json!({ "enabled": true, "previews_enabled": false })),
    )
    .await
    .map_err(|e| fail("address", explain("publish the address", "Workers Scripts: Edit", &e)))?;
    let server_url = workers_dev_url(&names.worker, &subdomain);
    step("address", "done", Some(server_url.replace("https://", "")));

    // 7. Online check
    step("online", "running", Some("A new address can take a few minutes to start working.".into()));
    let health_url = match &cf.health_override {
        Some(h) => format!("{}/api/health", h.trim_end_matches('/')),
        None => format!("{server_url}/api/health"),
    };
    let health = wait_online(&health_url, &b.build, Duration::from_secs(if cf.health_override.is_some() { 20 } else { 240 })).await;
    let online = health.is_some();
    let needs_setup = health.as_ref().map(|h| h.needs_setup).unwrap_or(new_key.is_some());
    step("online", if online { "done" } else { "waiting" }, if online { None } else { Some("Not answering yet".into()) });

    // 8. An existing server that still has no administrator gets a fresh setup key we know.
    let mut setup_key = new_key;
    if online && needs_setup && setup_key.is_none() {
        step("access", "running", None);
        let key = new_setup_key();
        put_setup_key(cf, a, &names.worker, &key).await.map_err(|m| fail("access", m))?;
        setup_key = Some(key);
        step("access", "done", None);
    }

    Ok(DeployOutcome { server_url, created_worker: !pre.worker_exists, setup_key, online, needs_setup, build: b.build.clone(), names, database_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_worker_is_present() {
        let b = bundle();
        assert!(WORKER_JS.contains("export"), "worker bundle is empty");
        assert!(!b.migrations.is_empty());
        assert!(b.build.starts_with(&b.version));
    }

    #[test]
    fn names_validate() {
        assert!(ServerNames::default().validate().is_ok());
        assert!(ServerNames { worker: "Bad Name".into(), ..Default::default() }.validate().is_err());
        assert!(ServerNames { bucket: "ab".into(), ..Default::default() }.validate().is_err());
        assert!(ServerNames { database: "am_backup_2".into(), ..Default::default() }.validate().is_ok());
    }

    #[test]
    fn setup_key_shape() {
        let k = new_setup_key();
        assert_eq!(k.len(), 39);
        assert_eq!(k.matches('-').count(), 7);
        assert_ne!(k, new_setup_key());
    }

    #[test]
    fn subdomain_suggestion() {
        let s = suggest_subdomain("AM True Tax's Account");
        assert!(s.starts_with("am-true-tax-s-account-"), "{s}");
        assert!(valid_subdomain(&s));
        assert!(valid_subdomain(&suggest_subdomain("!!")));
    }
}
