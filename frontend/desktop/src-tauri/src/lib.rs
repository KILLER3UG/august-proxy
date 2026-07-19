// august_desktop_lib — Tauri 2 app entry
//
// Folder map:
//   src-tauri/ ← this crate: Rust shell + Node supervisor
//   webview content comes from ../../web-dist during desktop builds
//
// Crate-wide lint suppressions: after the snake_case → camelCase migration
// we keep these identifiers as `camelCase` to align with the rest of the
// codebase. Function names, struct fields, and locals are intentional —
// not to be re-renamed.

#![allow(non_camel_case_types)]
#![allow(non_snake_case)]


mod backend;
mod tray;

use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// Confirmed quit from the webview modal (tray Quit → quit-requested → UI).
/// Stops the local backend first so the next launch starts a fresh process.
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    backend::stopBackendOnQuit(&app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Always register supervisor state so restart_proxy can run even
            // when the first spawn attempt fails (missing venv, etc.).
            app.manage(backend::BackendProcess(
                std::sync::Mutex::new(None),
                std::sync::Mutex::new(None),
            ));
            app.manage(backend::BackendSetupStatus(std::sync::Mutex::new(
                backend::SetupPhase {
                    phase: "starting".into(),
                    detail: Some("Starting backend…".into()),
                },
            )));

            // Clear leftover quiet-update marker from NSIS POSTINSTALL.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let marker = dir.join(".august-update-complete");
                    let _ = std::fs::remove_file(marker);
                }
            }

            // Start the backend off the UI thread so the webview can show a
            // setup overlay while first-launch bootstrap / uvicorn warm-up runs.
            // Then keep a watchdog that restarts if the process dies.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                backend::ensureRunning(&handle);
                backend::watchBackend(&handle);
            });

            // 2) Install the system tray (Show / Hide / Quit)
            tray::install(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Window X / Alt+F4 → full quit (same confirm modal as tray Quit).
            // Hide-to-tray remains available from the tray menu only.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.app_handle().emit("quit-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend::restart_proxy,
            backend::proxy_status,
            backend::select_directory,
            backend::backend_last_error,
            backend::backend_setup_status,
            backend::sync_backend_deps,
            backend::stop_backend_for_update,
            backend::schedule_post_update_relaunch,
            confirm_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Any exit path (tray Quit, updater, taskkill) must stop the
            // backend and release resources\python\*.pyd locks.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                backend::stopBackendOnQuit(app_handle);
            }
        });
}
