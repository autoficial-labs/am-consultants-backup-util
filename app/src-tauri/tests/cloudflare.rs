//! Built-in server setup against the local Cloudflare API stand-in (tests/mock-cloudflare.mjs).
//! Skipped unless AM_CF_MOCK is set, for example:
//!   node tests/mock-cloudflare.mjs
//!   $env:AM_CF_MOCK="http://127.0.0.1:8899"; cargo test --test cloudflare -- --nocapture

use am_backup_lib::cloudflare::{self, Cf, CfAccount, CfAccountIn, DeployRequest, ServerNames, StepEvent};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const TOKEN: &str = "test-token-0123456789abcdefghijklmnopqrstuv";

fn mock() -> Option<String> {
    std::env::var("AM_CF_MOCK").ok().map(|s| s.trim_end_matches('/').to_string())
}

async fn control(base: &str, body: Value) {
    reqwest::Client::new().post(format!("{base}/__control")).json(&body).send().await.unwrap();
}

async fn mock_state(base: &str) -> Value {
    let v: Value = reqwest::get(format!("{base}/__state")).await.unwrap().json().await.unwrap();
    v["result"].clone()
}

fn cf(base: &str, token: &str) -> Cf {
    Cf::with_base(&format!("{base}/client/v4"), token, Some(format!("{base}/__worker/am-backup-api")))
}

#[tokio::test]
async fn server_setup_end_to_end() {
    let Some(base) = mock() else {
        eprintln!("AM_CF_MOCK not set; skipping");
        return;
    };
    control(&base, json!({ "reset": true, "r2Enabled": false })).await;

    // Token checks
    let err = cloudflare::list_accounts(&cf(&base, "short")).await.unwrap_err();
    assert!(err.contains("does not look like"), "{err}");
    let err = cloudflare::list_accounts(&cf(&base, "wrong-token-0123456789abcdefghijklmnop")).await.unwrap_err();
    assert!(err.contains("did not accept"), "{err}");
    let api = cf(&base, TOKEN);
    let accounts = cloudflare::list_accounts(&api).await.unwrap();
    assert_eq!(accounts.len(), 1);
    let account = CfAccount { id: accounts[0].id.clone(), name: accounts[0].name.clone() };

    // R2 not turned on yet -> clear guidance, not ready
    let pre = cloudflare::preflight(&api, &account, ServerNames::default()).await.unwrap();
    assert!(!pre.ready);
    let r2 = pre.checks.iter().find(|c| c.id == "r2").unwrap();
    assert!(!r2.ok && r2.detail.contains("R2 storage is not turned on"), "{}", r2.detail);
    assert!(pre.subdomain.is_none());
    println!("preflight (R2 off): {:?}", pre.checks.iter().map(|c| (c.id, c.ok)).collect::<Vec<_>>());

    control(&base, json!({ "r2Enabled": true })).await;
    let pre = cloudflare::preflight(&api, &account, ServerNames::default()).await.unwrap();
    assert!(pre.ready, "{:?}", pre.checks);
    assert!(!pre.worker_exists && pre.database_id.is_none() && !pre.bucket_exists);

    // First attempt fails at the address step (name taken); a retry with another name must
    // pick up the half-made server instead of duplicating anything.
    let events: Arc<Mutex<Vec<StepEvent>>> = Arc::default();
    let sink = events.clone();
    let emit = move |e: StepEvent| sink.lock().unwrap().push(e);
    let mut req = DeployRequest {
        account: CfAccountIn { id: account.id.clone(), name: account.name.clone() },
        names: ServerNames::default(),
        subdomain: Some("taken-name".into()),
    };
    let err = cloudflare::deploy(&api, &req, &emit).await.unwrap_err();
    assert!(err.contains("already taken"), "{err}");
    assert!(events.lock().unwrap().iter().any(|e| e.step == "address" && e.state == "failed"));
    let st = mock_state(&base).await;
    assert!(st["workers"]["am-backup-api"]["secrets"]["SETUP_KEY"].is_string(), "a new server is uploaded with a setup key");

    events.lock().unwrap().clear();
    req.subdomain = Some("am-true-tax-test".into());
    let out = cloudflare::deploy(&api, &req, &emit).await.unwrap();
    println!("setup after retry: {} created={} online={} needsSetup={}", out.server_url, out.created_worker, out.online, out.needs_setup);
    assert_eq!(out.server_url, "https://am-backup-api.am-true-tax-test.workers.dev");
    assert!(!out.created_worker && out.online && out.needs_setup);
    let key1 = out.setup_key.clone().expect("server without administrator gets a key we know");
    let steps: Vec<String> = events.lock().unwrap().iter().filter(|e| e.state == "done").map(|e| e.step.to_string()).collect();
    assert_eq!(steps, ["check", "database", "tables", "storage", "upload", "schedule", "address", "online", "access"]);

    let st = mock_state(&base).await;
    let w = &st["workers"]["am-backup-api"];
    assert_eq!(w["secrets"]["SETUP_KEY"], json!(key1));
    assert_eq!(w["schedules"], json!(["17 3 * * *"]));
    assert_eq!(w["subdomainEnabled"], json!(true));
    let bindings = w["metadata"]["bindings"].as_array().unwrap();
    let find = |n: &str| bindings.iter().find(|b| b["name"] == n).cloned().unwrap();
    assert_eq!(find("DB")["id"], json!(out.database_id));
    assert_eq!(find("BUCKET")["bucket_name"], json!("am-backup-files"));
    assert_eq!(find("APP_ENV")["text"], json!("production"));
    assert_eq!(find("SERVER_BUILD")["text"], json!(cloudflare::bundle().build));
    let db = &st["dbs"][out.database_id.as_str()];
    assert_eq!(db["migrations"], json!(cloudflare::bundle().migrations.iter().map(|m| m.name.clone()).collect::<Vec<_>>()));
    for t in ["users", "sessions", "versions", "blobs", "full_backups", "audit_log", "tally_snapshots"] {
        assert!(db["tables"].as_array().unwrap().contains(&json!(t)), "table {t} missing: {}", db["tables"]);
    }

    // Running it again before the administrator exists: nothing duplicated, new key we know
    events.lock().unwrap().clear();
    let out2 = cloudflare::deploy(&api, &req, &emit).await.unwrap();
    assert!(!out2.created_worker && out2.needs_setup);
    assert_eq!(out2.database_id, out.database_id);
    let key2 = out2.setup_key.clone().expect("server without administrator gets a key we know");
    assert_ne!(key1, key2);
    let st = mock_state(&base).await;
    assert_eq!(st["dbs"].as_object().unwrap().len(), 1, "a second database was created");
    assert_eq!(st["workers"]["am-backup-api"]["secrets"]["SETUP_KEY"], json!(key2));
    assert_eq!(st["dbs"][out.database_id.as_str()]["migrations"], json!(cloudflare::bundle().migrations.iter().map(|m| m.name.clone()).collect::<Vec<_>>()), "migrations are not applied twice");

    // Update after the administrator exists: the setup key is kept, no new one is made
    control(&base, json!({ "adminCreated": true })).await;
    let out3 = cloudflare::deploy(&api, &req, &emit).await.unwrap();
    assert!(!out3.needs_setup && out3.setup_key.is_none());
    let st = mock_state(&base).await;
    assert_eq!(st["workers"]["am-backup-api"]["secrets"]["SETUP_KEY"], json!(key2), "update must keep the existing setup key");
    assert_eq!(st["workers"]["am-backup-api"]["uploads"], json!(4), "failed attempt + retry + 2 updates");

    // An existing server is matched by its bindings even when other names are typed
    let pre = cloudflare::preflight(&api, &account, ServerNames { database: "other_db".into(), bucket: "other-bucket".into(), ..Default::default() })
        .await
        .unwrap();
    assert!(pre.worker_exists);
    assert_eq!(pre.database_id.as_deref(), Some(out.database_id.as_str()));
    assert_eq!(pre.names.database, "am_backup");
    assert_eq!(pre.names.bucket, "am-backup-files");

    // Recovery: a new setup key can be set with the token
    let key4 = cloudflare::new_setup_key();
    cloudflare::put_setup_key(&api, &account.id, "am-backup-api", &key4).await.unwrap();
    let st = mock_state(&base).await;
    assert_eq!(st["workers"]["am-backup-api"]["secrets"]["SETUP_KEY"], json!(key4));
    println!("calls made: {}", st["log"].as_array().unwrap().len());
}
