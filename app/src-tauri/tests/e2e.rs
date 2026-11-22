//! End-to-end test of the backup engine against a running local server.
//!
//!   cd server && npm run dev            (or: npx localflare)
//!   cd app/src-tauri
//!   AM_E2E_SERVER=http://localhost:8787 cargo test --test e2e -- --nocapture
//!
//! Skipped unless AM_E2E_SERVER is set. Uses the setup key to (re)set the admin password.

use am_backup_lib::api::{Api, LoginResponse};
use am_backup_lib::fsutil::ChangedDuringCopy;
use am_backup_lib::full::{run_full_backup, FullOptions};
use am_backup_lib::model::{noop_progress, now_ms};
use am_backup_lib::restore::{build_plan, execute, ExecuteOptions, ItemStatus, RestoreSource};
use am_backup_lib::sync::{run_sync, SyncOptions};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn write(root: &Path, rel: &str, data: &[u8]) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, data).unwrap();
}

fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x & 0xff) as u8
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn backup_and_restore_roundtrip() {
    let Ok(server) = std::env::var("AM_E2E_SERVER") else {
        eprintln!("AM_E2E_SERVER not set; skipping end-to-end test");
        return;
    };
    let setup_key = std::env::var("AM_E2E_SETUP_KEY").unwrap_or_else(|_| "local-setup-key".into());
    let anon = Api::new(&server, None, "e2e");
    let health = anon.health().await.expect("server reachable");
    let password = "e2e-admin-pass-1";
    if health.needs_setup {
        let _: serde_json::Value = anon
            .post("/api/setup", &json!({ "setupKey": setup_key, "username": "admin", "displayName": "Administrator", "password": password }))
            .await
            .unwrap();
    } else {
        let _: serde_json::Value = anon.post("/api/setup/reset-admin", &json!({ "setupKey": setup_key, "password": password })).await.unwrap();
    }
    let admin_name = {
        // reset-admin tells us the admin username
        let r: serde_json::Value = anon.post("/api/setup/reset-admin", &json!({ "setupKey": setup_key, "password": password })).await.unwrap();
        r["username"].as_str().unwrap().to_string()
    };
    let login: LoginResponse = anon.post("/api/auth/login", &json!({ "username": admin_name, "password": password })).await.unwrap();
    let api = Api::new(&server, Some(login.token), "e2e");

    let base = std::env::temp_dir().join(format!("amb-e2e-{}", now_ms()));
    let run = format!("e2e{}", now_ms());
    let root = base.join("source").join(&run); // unique top folder keeps runs independent on the shared server
    let src_root = base.join("source");
    fs::create_dir_all(&root).unwrap();
    write(&root, "Data/10001/Company.900", &pseudo_random(200_000, 1));
    write(&root, "Data/10001/TranMgr.900", "transactions v1 ".repeat(20_000).as_bytes());
    write(&root, "Data/10002/Company.1800", "second company ".repeat(10_000).as_bytes());
    write(&root, "Data/10002/empty.txt", b"");
    write(&root, "Config/tally.ini", b"[Tally]\nData=C:\\TallyData\n");
    write(&root, "Data/10001/junk.tmp", b"excluded");
    // Larger than one request: exercises the multipart path.
    write(&root, "Data/Big/Archive.bin", &pseudo_random(50 * 1024 * 1024, 7));

    let excludes = vec!["*.tmp".to_string()];
    let opts = SyncOptions {
        root: src_root.clone(),
        excludes: excludes.clone(),
        index_path: base.join("index.json"),
        staging: base.join("staging"),
        user: login.user.clone(),
        device: "e2e".into(),
    };
    let cancel = AtomicBool::new(false);
    let progress = noop_progress();

    let r1 = run_sync(&api, &opts, &progress, &cancel).await.expect("first sync");
    println!("sync 1: {r1:?}");
    assert_eq!(r1.added, 6, "six files added (junk.tmp excluded)");
    assert!(r1.uploaded_bytes > 0);

    let r_again = run_sync(&api, &opts, &progress, &cancel).await.expect("idle sync");
    assert_eq!(r_again.changed(), 0, "nothing changed");
    assert!(r_again.batch_id.is_none(), "no batch created when idle");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let t1 = now_ms();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    write(&root, "Data/10001/TranMgr.900", "transactions v2 changed ".repeat(25_000).as_bytes());
    fs::remove_file(root.join("Data/10002/Company.1800")).unwrap();
    write(&root, "Data/10003/New.900", b"brand new company");
    let r2 = run_sync(&api, &opts, &progress, &cancel).await.expect("second sync");
    println!("sync 2: {r2:?}");
    assert_eq!((r2.added, r2.modified, r2.deleted), (1, 1, 1));

    // Touching a file without changing it is not a new version.
    let f = fs::File::options().write(true).open(root.join("Config/tally.ini")).unwrap();
    f.set_modified(std::time::SystemTime::now()).unwrap();
    drop(f);
    let r3 = run_sync(&api, &opts, &progress, &cancel).await.expect("touch sync");
    assert_eq!(r3.changed(), 0, "timestamp-only change is not uploaded");

    // ---- Point-in-time restore of the state at t1 into an empty folder ----
    let dest = base.join("restore-pit");
    let include = vec![run.clone()];
    let plan = build_plan(&api, RestoreSource::PointInTime { at: t1 }, &dest, include.clone(), excludes.clone(), &login.user)
        .await
        .expect("plan");
    assert_eq!(plan.summary.restore, 6, "six files existed at t1");
    assert_eq!(plan.summary.overwrite + plan.summary.extra, 0);
    let staging = base.join("staging");
    let cancel_arc = Arc::new(AtomicBool::new(false));
    let rep = execute(&api, &plan, &ExecuteOptions { paths: None, remove_extras: false }, &staging, &progress, &cancel_arc)
        .await
        .expect("restore");
    assert!(rep.failed.is_empty(), "failures: {:?}", rep.failed);
    assert_eq!(rep.restored, 6);
    let restored = dest.join(&run);
    assert_eq!(fs::read(restored.join("Data/10001/TranMgr.900")).unwrap(), "transactions v1 ".repeat(20_000).as_bytes());
    assert!(restored.join("Data/10002/Company.1800").exists(), "deleted file is back");
    assert!(!restored.join("Data/10003/New.900").exists(), "later file absent");
    assert_eq!(fs::read(restored.join("Data/Big/Archive.bin")).unwrap(), pseudo_random(50 * 1024 * 1024, 7));
    let src_mtime = fs::metadata(root.join("Data/10001/Company.900")).unwrap().modified().unwrap();
    let dst_mtime = fs::metadata(restored.join("Data/10001/Company.900")).unwrap().modified().unwrap();
    let diff = src_mtime.duration_since(dst_mtime).unwrap_or_else(|e| e.duration()).as_millis();
    assert!(diff < 2, "modification time preserved");

    // ---- Comparing the current state against the restored folder shows differences ----
    let plan2 = build_plan(&api, RestoreSource::PointInTime { at: now_ms() }, &dest, include.clone(), excludes.clone(), &login.user)
        .await
        .unwrap();
    let status = |p: &str| plan2.items.iter().find(|i| i.path == format!("{run}/{p}")).map(|i| i.status);
    assert_eq!(status("Data/10001/TranMgr.900"), Some(ItemStatus::Overwrite));
    assert_eq!(status("Data/10003/New.900"), Some(ItemStatus::Restore));
    assert_eq!(status("Data/10002/Company.1800"), Some(ItemStatus::Extra));
    assert_eq!(status("Data/10001/Company.900"), Some(ItemStatus::Same));
    let rep2 = execute(&api, &plan2, &ExecuteOptions { paths: None, remove_extras: true }, &staging, &progress, &cancel_arc).await.unwrap();
    assert!(rep2.failed.is_empty(), "failures: {:?}", rep2.failed);
    assert_eq!(rep2.removed, 1, "extra file moved to the Recycle Bin");
    assert!(!restored.join("Data/10002/Company.1800").exists());

    // ---- Complete backup and restore from the archive ----
    let full = run_full_backup(
        &api,
        &FullOptions { root: root.clone(), excludes: excludes.clone(), staging: staging.clone(), level: 19, origin: "manual", snapshot_first: false },
        &progress,
        &cancel_arc,
    )
    .await
    .expect("complete backup");
    println!("full: {full:?}");
    assert_eq!(full.file_count, 6);
    assert!(full.compressed_size > 0);

    let dest_full = base.join("restore-full");
    write(&dest_full, "Data/10001/Company.900", b"stale local copy");
    let plan3 = build_plan(&api, RestoreSource::Full { id: full.id }, &dest_full, vec![], excludes.clone(), &login.user).await.unwrap();
    assert_eq!(plan3.summary.overwrite, 1);
    assert_eq!(plan3.summary.restore, 5);
    let rep3 = execute(&api, &plan3, &ExecuteOptions { paths: None, remove_extras: false }, &staging, &progress, &cancel_arc).await.unwrap();
    assert!(rep3.failed.is_empty(), "failures: {:?}", rep3.failed);
    assert_eq!(rep3.restored, 6);
    assert_eq!(fs::read(dest_full.join("Data/10001/TranMgr.900")).unwrap(), "transactions v2 changed ".repeat(25_000).as_bytes());
    assert_eq!(fs::read(dest_full.join("Data/10001/Company.900")).unwrap(), pseudo_random(200_000, 1));
    assert_eq!(fs::read(dest_full.join("Data/10002/empty.txt")).unwrap(), b"");

    // Selective restore restores only the chosen file.
    let dest_sel = base.join("restore-selected");
    let plan4 = build_plan(&api, RestoreSource::Full { id: full.id }, &dest_sel, vec![], excludes.clone(), &login.user).await.unwrap();
    let only = std::collections::HashSet::from(["Config/tally.ini".to_string()]);
    let rep4 = execute(&api, &plan4, &ExecuteOptions { paths: Some(only), remove_extras: false }, &staging, &progress, &cancel_arc).await.unwrap();
    assert_eq!(rep4.restored, 1);
    assert!(dest_sel.join("Config/tally.ini").exists());
    assert!(!dest_sel.join("Data").exists());

    // ---- Tally open: a company folder that changes while it is copied is never recorded half-done ----
    write(&root, "Data/10004/Company.900", &pseudo_random(30 * 1024 * 1024, 11));
    write(&root, "Data/10004/TranMgr.900", b"start");
    let start_writer = || {
        let stop = Arc::new(AtomicBool::new(false));
        let path = root.join("Data/10004/TranMgr.900");
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            let mut n = 0usize;
            while !flag.load(Ordering::Relaxed) {
                n += 1;
                let _ = fs::write(&path, format!("voucher {n};").repeat(n % 40 + 1));
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        });
        (stop, handle)
    };
    let (stop, handle) = start_writer();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let busy_run = run_sync(&api, &opts, &progress, &cancel).await.expect("sync while Tally writes");
    stop.store(true, Ordering::Relaxed);
    handle.join().unwrap();
    println!("sync while writing: retried={:?} busy={:?}", busy_run.retried_folders, busy_run.busy);
    assert!(busy_run.retried_folders.iter().any(|f| f.ends_with("Data/10004")), "changing folder must be retried");
    let now_plan = build_plan(&api, RestoreSource::PointInTime { at: now_ms() }, &base.join("probe"), vec![format!("{run}/Data/10004")], excludes.clone(), &login.user)
        .await
        .unwrap();
    assert_eq!(now_plan.items.len(), 0, "nothing from the changing folder was recorded");

    let quiet_run = run_sync(&api, &opts, &progress, &cancel).await.expect("sync when quiet");
    println!("sync when quiet: {quiet_run:?}");
    assert!(quiet_run.retried_folders.is_empty());
    assert_eq!(quiet_run.added, 2, "both files of the folder backed up together");

    // Complete backup while Tally is open: the copy-first check refuses a changing folder...
    let snap_opts = FullOptions { root: root.clone(), excludes: excludes.clone(), staging: staging.clone(), level: 9, origin: "manual", snapshot_first: true };
    let (stop, handle) = start_writer();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let refused = run_full_backup(&api, &snap_opts, &progress, &cancel_arc).await;
    stop.store(true, Ordering::Relaxed);
    handle.join().unwrap();
    let err = refused.expect_err("complete backup must not take a changing folder");
    assert!(err.downcast_ref::<ChangedDuringCopy>().is_some(), "unexpected error: {err}");
    println!("complete backup while writing: {err}");

    // ...and takes it when the files are quiet, from the checked copy.
    let snap_full = run_full_backup(&api, &snap_opts, &progress, &cancel_arc).await.expect("complete backup from a checked copy");
    println!("full from copy: {snap_full:?}");
    assert_eq!(snap_full.file_count, 8);
    let dest_snap = base.join("restore-snapshot");
    let plan5 = build_plan(&api, RestoreSource::Full { id: snap_full.id }, &dest_snap, vec![], excludes.clone(), &login.user).await.unwrap();
    assert_eq!(plan5.summary.restore, 8);
    let rep5 = execute(&api, &plan5, &ExecuteOptions { paths: None, remove_extras: false }, &staging, &progress, &cancel_arc).await.unwrap();
    assert!(rep5.failed.is_empty(), "failures: {:?}", rep5.failed);
    assert_eq!(fs::read(dest_snap.join("Data/10004/TranMgr.900")).unwrap(), fs::read(root.join("Data/10004/TranMgr.900")).unwrap());
    let staged_left = fs::read_dir(&staging).map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("snapshot-")).count()).unwrap_or(0);
    assert_eq!(staged_left, 0, "the temporary copy is removed");

    let _: serde_json::Value = api.call(reqwest::Method::DELETE, &format!("/api/full-backups/{}", snap_full.id), None).await.unwrap();
    let _: serde_json::Value = api.call(reqwest::Method::DELETE, &format!("/api/full-backups/{}", full.id), None).await.unwrap();
    fs::remove_dir_all(&base).ok();
    let _ = PathBuf::new();
}
