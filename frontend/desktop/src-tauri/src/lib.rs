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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 1) Try to start (or reuse) the Node backend at :8085
            backend::ensureRunning(app.handle());

            // 2) Install the system tray (Show / Hide / Quit)
            tray::install(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide-to-tray on close (X) instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend::restartProxy,
            backend::proxyStatus,
            backend::selectDirectory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
