pub mod api;
pub mod cloudflare;
mod commands;
pub mod config;
pub mod engine;
pub mod fsutil;
pub mod full;
pub mod index;
pub mod logger;
pub mod model;
pub mod restore;
pub mod schedule;
pub mod sync;
pub mod tally;
pub mod tally_data;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent, Wry};
use tauri_plugin_autostart::MacosLauncher;

use engine::{app_engine, Dirs, Engine, EngineStatus, Phase};

static STARTED_HIDDEN: AtomicBool = AtomicBool::new(false);
static WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

struct TrayItems {
    pause: MenuItem<Wry>,
    sync: MenuItem<Wry>,
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        WINDOW_SHOWN.store(true, Ordering::Relaxed);
    }
}

/// Called once the UI has rendered, so the window never flashes blank.
pub fn on_frontend_ready(app: &AppHandle) {
    if !STARTED_HIDDEN.load(Ordering::Relaxed) && !WINDOW_SHOWN.load(Ordering::Relaxed) {
        show_main_window(app);
    }
}

fn tray_text(s: &EngineStatus) -> String {
    let headline = match s.phase {
        Phase::Idle => "Protected",
        Phase::Scanning | Phase::Uploading => "Backing up…",
        Phase::FullBackup => "Running a complete backup…",
        Phase::Restoring => "Restoring…",
        Phase::WaitingTally => "Waiting for Tally to close",
        Phase::WaitingQuiet => "Changes detected",
        Phase::Paused => "Paused",
        Phase::Offline => "Offline — will retry",
        Phase::Error => "Needs attention",
        Phase::SignedOut => "Signed out",
        Phase::NotConfigured => "Choose a folder to back up",
        Phase::ReadOnly => "Restore only",
        Phase::Starting => "Starting…",
    };
    format!("AM Backup — {headline}")
}

pub fn update_tray(app: &AppHandle, status: &EngineStatus) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tray_text(status)));
    }
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.pause.set_text(if status.paused { "Resume automatic backups" } else { "Pause automatic backups" });
        let _ = items.sync.set_enabled(status.job.is_none() && !matches!(status.phase, Phase::SignedOut | Phase::NotConfigured | Phase::ReadOnly));
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open AM Backup", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Back up now", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause automatic backups", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AM Backup", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &sync, &pause, &sep2, &quit])?;
    app.manage(TrayItems { pause, sync });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("AM Backup")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "sync" => {
                let engine = app_engine(app);
                tauri::async_runtime::spawn(async move {
                    let _ = engine.run_sync().await;
                });
            }
            "pause" => {
                let engine = app_engine(app);
                let paused = engine.status().paused;
                engine.set_paused(!paused);
            }
            "quit" => {
                app_engine(app).cancel_job();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// "Start with Windows" is on by default: the first time an installed copy runs, it registers
/// itself to start (quietly, in the notification area) when the user signs in. Done once, so
/// turning it off in Settings is respected. Development builds never register themselves.
fn enable_autostart_once(app: &AppHandle, engine: &Engine) {
    if engine.config().autostart_initialized || cfg!(debug_assertions) {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    match app.autolaunch().enable() {
        Ok(()) => log_info!("Start with Windows turned on"),
        Err(e) => log_warn!("Could not turn on start with Windows: {e}"),
    }
    engine.update_config(|c| c.autostart_initialized = true);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED_HIDDEN.store(std::env::args().any(|a| a == "--minimized"), Ordering::Relaxed);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            logger::init(&app.path().app_log_dir().unwrap_or_else(|_| data.join("logs")));
            std::fs::create_dir_all(&data)?;
            std::fs::create_dir_all(&config_dir)?;
            let dirs = Dirs { config_file: config_dir.join("config.json"), staging: data.join("staging"), data };
            let engine = Engine::new(app.handle().clone(), dirs);
            app.manage(engine.clone());
            build_tray(app)?;
            enable_autostart_once(app.handle(), &engine);
            engine.start();

            // Safety net: show the window even if the UI never reports ready.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(6)).await;
                on_frontend_ready(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && app_engine(window.app_handle()).close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_ready,
            commands::get_config,
            commands::check_server,
            commands::connect_server,
            commands::login,
            commands::setup_admin,
            commands::reset_admin,
            commands::logout,
            commands::refresh_session,
            commands::api_call,
            commands::set_watched_folder,
            commands::scan_folder,
            commands::engine_status,
            commands::sync_now,
            commands::full_backup_now,
            commands::set_paused,
            commands::cancel_job,
            commands::tally_status,
            commands::restore_plan,
            commands::restore_execute,
            commands::policy_changed,
            commands::set_preferences,
            commands::get_logs,
            commands::open_path,
            commands::open_url,
            commands::server_setup_info,
            commands::cf_accounts,
            commands::cf_preflight,
            commands::cf_deploy,
            commands::cf_new_setup_key,
            commands::tally_check,
            commands::tally_live,
            commands::tally_capture_now,
        ])
        .run(tauri::generate_context!())
        .expect("AM Backup failed to start");
}
