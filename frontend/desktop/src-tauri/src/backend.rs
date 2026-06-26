// backend.rs — Rust-side backend supervisor
//
// Owns the August Proxy backend process. On Tauri startup we:
//   1) Poll http://127.0.0.1:8085/health
//   2) If down, locate Python (preferred) or Node (fallback)
//   3) Spawn the backend with an app-data data directory
//   4) Kill the process on app drop

use std::env;
use std::fs::File;
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

// ── Python backend resolution (preferred) ───────────────────────────

fn python_binary_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["python.exe", "python3.exe", "py.exe"]
    } else {
        &["python3", "python"]
    }
}

fn resolve_python(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    for name in python_binary_names() {
        candidates.push(app.path().resolve(name, tauri::path::BaseDirectory::Resource).ok());
    }
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .or_else(|| which::which("python3").ok())
        .or_else(|| which::which("python").ok())
}

fn resolve_python_backend(app: &AppHandle) -> Option<PathBuf> {
    let candidates = vec![
        app.path()
            .resolve("backend-py/app/main.py", tauri::path::BaseDirectory::Resource)
            .ok(),
        env::current_dir().ok().map(|cwd| cwd.join("backend-py/app/main.py")),
        env::current_dir().ok().map(|cwd| cwd.join("../backend-py/app/main.py")),
    ];
    candidates.into_iter().flatten().find(|path| path.is_file())
}

// ── Node.js backend resolution (fallback) ───────────────────────────

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
    }

    if let Ok(binaries_dir) = app.path().resolve("binaries", tauri::path::BaseDirectory::Resource) {
        if let Ok(entries) = std::fs::read_dir(binaries_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("node-") {
                            candidates.push(Some(path));
                        }
                    }
                }
            }
        }
    }

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .or_else(|| which::which("node").ok())
}

fn resolve_node_backend(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("AUGUST_PROXY_BACKEND") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    let candidates = vec![
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
    candidates.into_iter().flatten().find(|path| path.is_file())
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

fn dev_null_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("NUL")
    } else {
        PathBuf::from("/dev/null")
    }
}

fn is_proxy_up() -> bool {
    reqwest::blocking::Client::new()
        .get(proxy_url())
        .timeout(Duration::from_millis(400))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Try to bring up the backend. Tries Python first, falls back to Node.js.
pub fn ensure_running(app: &AppHandle) -> bool {
    if is_proxy_up() {
        log::info!("[backend] proxy already up on :{}", proxy_port());
        return true;
    }

    // Try Python backend first
    if let Some(python) = resolve_python(app) {
        if let Some(py_entry) = resolve_python_backend(app) {
            let Some(project_root) = project_root_for(&py_entry) else {
                log::error!("[backend] could not resolve project root for {}", py_entry.display());
                return false;
            };

            let data_dir = app_data_dir(app);
            log::info!(
                "[backend] spawning python backend (uvicorn) at {} (data={})",
                py_entry.display(),
                data_dir.display()
            );

            let log_dir = data_dir.join("logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("backend.log");
            let log_file = File::create(&log_path).unwrap_or_else(|e| {
                log::warn!("[backend] could not create {}: {e}", log_path.display());
                File::create(dev_null_path()).expect("failed to open null")
            });

            let child = Command::new(python)
                .arg("-m")
                .arg("uvicorn")
                .arg("app.main:app")
                .arg("--port")
                .arg(proxy_port().to_string())
                .arg("--host")
                .arg("127.0.0.1")
                .current_dir(&project_root)
                .env("AUGUST_PROXY_PORT", proxy_port().to_string())
                .env("AUGUST_PROXY_ROOT", project_root)
                .env("AUGUST_DATA_DIR", data_dir)
                .env("AUGUST_PROXY_DESKTOP", "1")
                .stdout(Stdio::from(log_file.try_clone().unwrap_or_else(|_| {
                    File::create(dev_null_path()).expect("failed to open null")
                })))
                .stderr(Stdio::from(log_file))
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
                    log::info!("[backend] python proxy spawned");
                    return true;
                }
                Err(e) => {
                    log::error!("[backend] python spawn failed: {e} — falling back to Node.js");
                }
            }
        }
    }

    // Fallback: Node.js backend
    let Some(node) = resolve_node(app) else {
        log::error!("[backend] could not find `node` on PATH or in bundled resources");
        return false;
    };

    let Some(entry) = resolve_node_backend(app) else {
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

    let log_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("backend.log");
    let log_file = File::create(&log_path).unwrap_or_else(|e| {
        log::warn!("[backend] could not create {}: {e}", log_path.display());
        File::create(dev_null_path()).expect("failed to open null")
    });

    let child = Command::new(node)
        .arg(&entry)
        .current_dir(&project_root)
        .env("AUGUST_PROXY_PORT", proxy_port().to_string())
        .env("AUGUST_PROXY_ROOT", project_root)
        .env("AUGUST_DATA_DIR", data_dir)
        .env("AUGUST_PROXY_DESKTOP", "1")
        .stdout(Stdio::from(log_file.try_clone().unwrap_or_else(|_| {
            File::create(dev_null_path()).expect("failed to open null")
        })))
        .stderr(Stdio::from(log_file))
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
            log::info!("[backend] node proxy spawned (fallback)");
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
pub async fn proxy_status() -> String {
    let port = proxy_port();
    let url = format!("http://127.0.0.1:{}/health", port);
    let result = tokio::task::spawn_blocking(move || {
        reqwest::blocking::Client::new()
            .get(&url)
            .timeout(Duration::from_millis(400))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if result {
        format!("ok:{}", port)
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
