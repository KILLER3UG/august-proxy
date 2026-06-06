// backend.rs — Rust-side Node supervisor
//
// Owns the August Proxy Node process. On Tauri startup we:
//   1) Poll http://127.0.0.1:8085/health
//   2) If down, locate `node` on PATH and `../proxy/src/index.js` next to the app
//   3) Spawn the Node process detached; kill it on app drop

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const PROXY_PORT: u16 = 8085;
const PROXY_URL: &str = "http://127.0.0.1:8085/health";

pub struct BackendProcess(pub Mutex<Option<Child>>);

fn is_proxy_up() -> bool {
    reqwest::blocking::Client::new()
        .get(PROXY_URL)
        .timeout(Duration::from_millis(400))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Try to bring up the Node backend. Idempotent — if it's already up, does nothing.
pub fn ensure_running(app: &AppHandle) {
    if is_proxy_up() {
        log::info!("[backend] proxy already up on :{}", PROXY_PORT);
        return;
    }
    let node = match which::which("node") {
        Ok(p) => p,
        Err(e) => {
            log::error!("[backend] could not find `node` on PATH: {e}");
            return;
        }
    };
    // apps/desktop/main/src-tauri/target/release/august-desktop.exe
    //   → resolve up to apps/proxy/src/index.js
    let entry = app
        .path()
        .resolve("../../../proxy/src/index.js", tauri::path::BaseDirectory::Resource)
        .ok();
    let Some(entry) = entry else {
        log::error!("[backend] could not resolve ../../../proxy/src/index.js");
        return;
    };
    log::info!("[backend] spawning {} {}", node.display(), entry.display());
    let child = Command::new(node)
        .arg(entry)
        .current_dir(std::env::current_dir().unwrap_or_default())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(c) => {
            app.manage(BackendProcess(Mutex::new(Some(c))));
            log::info!("[backend] proxy spawned");
        }
        Err(e) => log::error!("[backend] spawn failed: {e}"),
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                log::info!("[backend] proxy killed");
            }
        }
    }
}

// ── Tauri commands callable from the webview ─────────────────────────────

#[tauri::command]
pub fn proxy_status() -> String {
    if is_proxy_up() {
        format!("ok:{}", PROXY_PORT)
    } else {
        "down".into()
    }
}

#[tauri::command]
pub fn restart_proxy(state: State<'_, BackendProcess>) -> String {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
        }
    }
    // The next poll cycle (or the webview's manual retry) will respawn.
    "restarted".into()
}
