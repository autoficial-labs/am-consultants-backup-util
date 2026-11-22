//! Tally data snapshots against the Tally stand-in (tests/mock-tally.mjs) and the local server.
//!   node tests/mock-tally.mjs
//!   $env:AM_TALLY_MOCK="http://127.0.0.1:9900"; $env:AM_E2E_SERVER="http://localhost:8787"
//!   cargo test --test tally -- --nocapture

use am_backup_lib::api::{Api, LoginResponse};
use am_backup_lib::model::now_ms;
use am_backup_lib::tally_data::{self, TallyClient};
use serde_json::{json, Value};
use std::fs;

async fn control(base: &str, body: Value) -> Value {
    reqwest::Client::new().post(format!("{base}/__control")).json(&body).send().await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn tally_snapshots_end_to_end() {
    let Ok(mock) = std::env::var("AM_TALLY_MOCK") else {
        eprintln!("AM_TALLY_MOCK not set; skipping");
        return;
    };
    let run = format!("{}", now_ms() % 1_000_000_000);
    control(&mock, json!({ "reset": true, "run": run })).await;
    let tally = TallyClient::with_url(&mock, 9900);

    // Companies, with an "&" in a name and the company number that names its data folder
    let companies = tally.companies().await.expect("companies");
    assert_eq!(companies.len(), 2);
    let c = companies[0].clone();
    assert_eq!(c.number.as_deref(), Some(format!("t{run}1").as_str()));
    assert_eq!(c.starting_from.as_deref(), Some("2025-04-01"));
    assert!(companies[1].name.starts_with("Mehta & Sons"), "{}", companies[1].name);

    // Ledgers and vouchers (vouchers arrive as UTF-16 with an invalid &#4; reference)
    let today = chrono::Local::now().date_naive();
    let snap = tally.snapshot(&c, today).await.expect("snapshot");
    println!("snapshot: {} ledgers, {} vouchers, period {}..{}", snap.ledgers.len(), snap.vouchers.len(), snap.period.from, snap.period.to);
    assert_eq!(snap.ledgers.len(), 5);
    let cash = snap.ledgers.iter().find(|l| l.name == "Cash").unwrap();
    assert_eq!((cash.opening, cash.closing), (-25000.0, -41250.0));
    assert_eq!(snap.vouchers.len(), 3, "the 2019 voucher is outside the period");
    let receipt = snap.vouchers.iter().find(|v| v.kind == "Receipt").unwrap();
    assert_eq!(receipt.narration, "Part payment received");
    assert_eq!((receipt.master_id, receipt.alter_id, receipt.amount), (2, 12, 5000.0));
    assert!(snap.vouchers.iter().any(|v| v.cancelled), "cancelled flag read");

    // A company that is not open gives Tally's error text
    let missing = tally.ledgers("No Such Company", &snap.period.from, &snap.period.to).await.unwrap_err();
    assert!(missing.to_string().contains("Could not set"), "{missing}");

    // Not answering: a clear message
    let off = TallyClient::with_url("http://127.0.0.1:9", 9).companies().await.unwrap_err();
    assert!(off.to_string().contains("not answering on port 9"), "{off}");

    // ---- Saving to the server -------------------------------------------------------------
    let Ok(server) = std::env::var("AM_E2E_SERVER") else {
        eprintln!("AM_E2E_SERVER not set; skipping the saving part");
        return;
    };
    let setup_key = std::env::var("AM_E2E_SETUP_KEY").unwrap_or_else(|_| "local-setup-key".into());
    let anon = Api::new(&server, None, "tally-test");
    let password = "e2e-admin-pass-1";
    let r: Value = anon.post("/api/setup/reset-admin", &json!({ "setupKey": setup_key, "password": password })).await.unwrap();
    let login: LoginResponse = anon.post("/api/auth/login", &json!({ "username": r["username"], "password": password })).await.unwrap();
    let api = Api::new(&server, Some(login.token), "tally-test");

    // The company folder is found by its number
    let root = std::env::temp_dir().join(format!("amb-tally-{run}"));
    fs::create_dir_all(root.join(format!("Data/t{run}1"))).unwrap();
    let folder = tally_data::company_folder(&root, &c);
    assert_eq!(folder.as_deref(), Some(format!("Data/t{run}1").as_str()));

    let first = tally_data::save(&api, &snap, folder.clone(), now_ms(), None).await.expect("save");
    assert!(first.recorded);
    // Same data again: nothing new is recorded
    let snap_again = tally.snapshot(&c, today).await.unwrap();
    let same = tally_data::save(&api, &snap_again, folder.clone(), now_ms(), Some(&first.hash)).await.unwrap();
    assert!(!same.recorded && same.hash == first.hash, "unchanged data is not recorded twice");

    // A new voucher, a changed one and a removed one make a new snapshot
    let d = today.format("%Y%m%d").to_string();
    control(&mock, json!({ "addVoucher": { "guid": format!("v-{run}-new"), "date": d, "type": "Sales", "number": "102", "party": "Cash", "amount": "-2360.00", "narration": "Counter sale" } })).await;
    control(&mock, json!({ "alter": format!("v-{run}-1"), "amount": "-12980.00" })).await;
    control(&mock, json!({ "remove": format!("v-{run}-3") })).await;
    control(&mock, json!({ "closing": { "name": "Cash", "value": "-43610.00" } })).await;
    let snap2 = tally.snapshot(&c, today).await.unwrap();
    let second = tally_data::save(&api, &snap2, folder.clone(), now_ms(), Some(&first.hash)).await.unwrap();
    assert!(second.recorded && second.hash != first.hash);

    let key = tally_data::company_key(&c);
    let list: Value = api.get(&format!("/api/tally/snapshots?company={}", am_backup_lib::api::encode_segment(&key))).await.unwrap();
    let rows = list["snapshots"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "two snapshots recorded: {rows:?}");
    assert_eq!(rows[0]["folder"], json!(format!("Data/t{run}1")));
    assert_eq!(rows[0]["vouchers"], json!(3));

    // The data comes back (gzip on the wire, decoded by the client) exactly as saved
    let back: tally_data::Snapshot = serde_json::from_value(api.get(&format!("/api/tally/snapshots/{}/data", rows[0]["id"])).await.unwrap()).unwrap();
    assert_eq!(back.vouchers, snap2.vouchers);
    assert_eq!(back.ledgers, snap2.ledgers);
    let added: Vec<_> = back.vouchers.iter().filter(|v| !snap.vouchers.iter().any(|o| o.guid == v.guid)).collect();
    assert_eq!(added.len(), 1);
    let changed = back.vouchers.iter().find(|v| v.guid == format!("v-{run}-1")).unwrap();
    assert_eq!(changed.amount, -12980.0);
    println!("saved {} and {}; second has {} vouchers", &first.hash[..12], &second.hash[..12], back.vouchers.len());
    fs::remove_dir_all(&root).ok();
}
