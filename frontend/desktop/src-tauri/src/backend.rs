// backend.rs — Rust-side Node supervisor
//
// Owns the August Proxy Node process. On Tauri startup we:
//   1) Poll http://127.0.0.1:8085/health
//   2) If down, locate a bundled node binary or `node` on PATH
//   3) Spawn backend/index.js with an app-data data directory
//   4) Kill the Node process on app drop

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const DEFAULT_PROXY_PORT: u16 = 8085;

pub struct BackendProcess(pub Mutex<Option<Child>>);

fn proxy_port() -> u16 {
    std::env::var("AUGUST_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PROXY_PORT)
}

fn proxy_url() -> String {
    format!("http://127.0.0.1:{}/health", proxy_port())
}

fn node_binary_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    }
}

fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("AUGUST_DESKTOP_NODE") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    for name in node_binary_names() {
        candidates.push(app.path().resolve(name, tauri::path::BaseDirectory::Resource).ok());
        candidates.push(
            app.path()
                .resolve(Path::new("binaries").join("node").join(name), tauri::path::BaseDirectory::Resource)
                .ok(),
        );
    }

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .or_else(|| which::which("node").ok())
}

fn resolve_backend_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("AUGUST_PROXY_BACKEND") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates = vec![
        app.path()
            .resolve("backend/index.js", tauri::path::BaseDirectory::Resource)
            .ok(),
        app.path()
            .resolve("../../backend/index.js", tauri::path::BaseDirectory::Resource)
            .ok(),
        env::current_dir().ok().map(|cwd| cwd.join("backend/index.js")),
        env::current_dir().ok().map(|cwd| cwd.join("../backend/index.js")),
        env::current_dir().ok().map(|cwd| cwd.join("../../backend/index.js")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}

fn project_root_for(entry: &Path) -> Option<PathBuf> {
    entry.parent()?.parent().map(Path::to_path_buf)
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("data")
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn is_proxy_up() -> bool {
    reqwest::blocking::Client::new()
        .get(proxy_url())
        .timeout(Duration::from_millis(400))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Try to bring up the Node backend. Idempotent — if it's already up, does nothing.
pub fn ensure_running(app: &AppHandle) -> bool {
    if is_proxy_up() {
        log::info!("[backend] proxy already up on :{}", proxy_port());
        return true;
    }

    let Some(node) = resolve_node(app) else {
        log::error!("[backend] could not find `node` on PATH or in bundled resources");
        return false;
    };

    let Some(entry) = resolve_backend_entry(app) else {
        log::error!("[backend] could not resolve backend/index.js");
        return false;
    };

    let Some(project_root) = project_root_for(&entry) else {
        log::error!("[backend] could not resolve project root for {}", entry.display());
        return false;
    };

    let data_dir = app_data_dir(app);
    log::info!(
        "[backend] spawning {} {} (data={})",
        node.display(),
        entry.display(),
        data_dir.display()
    );

    let child = Command::new(node)
        .arg(&entry)
        .current_dir(&project_root)
        .env("AUGUST_PROXY_PORT", proxy_port().to_string())
        .env("AUGUST_PROXY_ROOT", project_root)
        .env("AUGUST_DATA_DIR", data_dir)
        .env("AUGUST_PROXY_DESKTOP", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match child {
        Ok(c) => {
            if app.try_state::<BackendProcess>().is_none() {
                app.manage(BackendProcess(Mutex::new(Some(c))));
            } else if let Some(state) = app.try_state::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(c);
                }
            }
            log::info!("[backend] proxy spawned");
            true
        }
        Err(e) => {
            log::error!("[backend] spawn failed: {e}");
            false
        }
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut c) = guard.take() {
                kill_child(&mut c);
                log::info!("[backend] proxy killed");
            }
        }
    }
}

// ── Tauri commands callable from the webview ─────────────────────────────

#[tauri::command]
pub fn proxy_status() -> String {
    if is_proxy_up() {
        format!("ok:{}", proxy_port())
    } else {
        "down".into()
    }
}

#[tauri::command]
pub fn restart_proxy(app: AppHandle, state: State<'_, BackendProcess>) -> String {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut c) = guard.take() {
            kill_child(&mut c);
        }
    }

    if ensure_running(&app) {
        "restarted".into()
    } else {
        "restart_failed".into()
    }
}

#[tauri::command]
pub fn select_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string().replace('\\', "/"))
}
