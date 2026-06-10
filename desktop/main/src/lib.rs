// august_desktop_lib — Tauri 2 app entry
//
// Folder map (apps/desktop/):
//   main/  ← this crate: Rust shell + Node supervisor
//   ui/    ← webview content (synced from ../proxy/src/web-dist)

use tauri::Manager;

mod backend;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1) Try to start (or reuse) the Node backend at :8085
            backend::ensure_running(app.handle());

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
            backend::restart_proxy,
            backend::proxy_status,
            backend::select_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
