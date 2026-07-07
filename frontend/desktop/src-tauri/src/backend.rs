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

fn proxyPort() -> u16 {
    std::env::var("AUGUST_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PROXY_PORT)
}

fn proxyUrl() -> String {
    format!("http://127.0.0.1:{}/health", proxyPort())
}

// ── Python backend resolution (preferred) ───────────────────────────

fn pythonBinaryNames() -> &'static [&'static str] {
    if cfg!(windows) {
        &["python.exe", "python3.exe", "py.exe"]
    } else {
        &["python3", "python"]
    }
}

fn resolvePython(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    for name in pythonBinaryNames() {
        candidates.push(app.path().resolve(name, tauri::path::BaseDirectory::Resource).ok());
    }
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .or_else(|| which::which("python3").ok())
        .or_else(|| which::which("python").ok())
}

fn resolvePythonBackend(app: &AppHandle) -> Option<PathBuf> {
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

fn nodeBinaryNames() -> &'static [&'static str] {
    if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    }
}

fn resolveNode(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("AUGUST_DESKTOP_NODE") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    for name in nodeBinaryNames() {
        candidates.push(app.path().resolve(name, tauri::path::BaseDirectory::Resource).ok());
    }

    if let Ok(binariesDir) = app.path().resolve("binaries", tauri::path::BaseDirectory::Resource) {
        if let Ok(entries) = std::fs::readDir(binariesDir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.fileName().and_then(|n| n.toStr()) {
                        if name.startsWith("node-") {
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

fn resolveNodeBackend(app: &AppHandle) -> Option<PathBuf> {
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

fn projectRootFor(entry: &Path) -> Option<PathBuf> {
    entry.parent()?.parent().map(Path::toPathBuf)
}

fn appDataDir(app: &AppHandle) -> PathBuf {
    app.path()
        .appDataDir()
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("data")
}

fn killChild(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn devNullPath() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("NUL")
    } else {
        PathBuf::from("/dev/null")
    }
}

fn isProxyUp() -> bool {
    reqwest::blocking::Client::new()
        .get(proxyUrl())
        .timeout(Duration::from_millis(400))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Try to bring up the backend. Tries Python first, falls back to Node.js.
pub fn ensureRunning(app: &AppHandle) -> bool {
    if isProxyUp() {
        log::info!("[backend] proxy already up on :{}", proxyPort());
        return true;
    }

    // Try Python backend first
    if let Some(python) = resolvePython(app) {
        if let Some(pyEntry) = resolvePythonBackend(app) {
            let Some(projectRoot) = projectRootFor(&pyEntry) else {
                log::error!("[backend] could not resolve project root for {}", pyEntry.display());
                return false;
            };

            let dataDir = appDataDir(app);
            log::info!(
                "[backend] spawning python backend (uvicorn) at {} (data={})",
                pyEntry.display(),
                dataDir.display()
            );

            let logDir = dataDir.join("logs");
            let _ = std::fs::create_dir_all(&logDir);
            let logPath = logDir.join("backend.log");
            let logFile = File::create(&logPath).unwrap_or_else(|e| {
                log::warn!("[backend] could not create {}: {e}", logPath.display());
                File::create(devNullPath()).expect("failed to open null")
            });

            let child = Command::new(python)
                .arg("-m")
                .arg("uvicorn")
                .arg("app.main:app")
                .arg("--port")
                .arg(proxyPort().to_string())
                .arg("--host")
                .arg("127.0.0.1")
                .current_dir(&projectRoot)
                .env("AUGUST_PROXY_PORT", proxyPort().to_string())
                .env("AUGUST_PROXY_ROOT", projectRoot)
                .env("AUGUST_DATA_DIR", dataDir)
                .env("AUGUST_PROXY_DESKTOP", "1")
                .stdout(Stdio::from(logFile.tryClone().unwrap_or_else(|_| {
                    File::create(devNullPath()).expect("failed to open null")
                })))
                .stderr(Stdio::from(logFile))
                .spawn();

            match child {
                Ok(c) => {
                    if app.tryState::<BackendProcess>().is_none() {
                        app.manage(BackendProcess(Mutex::new(Some(c))));
                    } else if let Some(state) = app.tryState::<BackendProcess>() {
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
    let Some(node) = resolveNode(app) else {
        log::error!("[backend] could not find `node` on PATH or in bundled resources");
        return false;
    };

    let Some(entry) = resolveNodeBackend(app) else {
        log::error!("[backend] could not resolve backend/index.js");
        return false;
    };

    let Some(projectRoot) = projectRootFor(&entry) else {
        log::error!("[backend] could not resolve project root for {}", entry.display());
        return false;
    };

    let dataDir = appDataDir(app);
    log::info!(
        "[backend] spawning {} {} (data={})",
        node.display(),
        entry.display(),
        dataDir.display()
    );

    let logDir = dataDir.join("logs");
    let _ = std::fs::create_dir_all(&logDir);
    let logPath = logDir.join("backend.log");
    let logFile = File::create(&logPath).unwrap_or_else(|e| {
        log::warn!("[backend] could not create {}: {e}", logPath.display());
        File::create(devNullPath()).expect("failed to open null")
    });

    let child = Command::new(node)
        .arg(&entry)
        .current_dir(&projectRoot)
        .env("AUGUST_PROXY_PORT", proxyPort().to_string())
        .env("AUGUST_PROXY_ROOT", projectRoot)
        .env("AUGUST_DATA_DIR", dataDir)
        .env("AUGUST_PROXY_DESKTOP", "1")
        .stdout(Stdio::from(logFile.tryClone().unwrap_or_else(|_| {
            File::create(devNullPath()).expect("failed to open null")
        })))
        .stderr(Stdio::from(logFile))
        .spawn();

    match child {
        Ok(c) => {
            if app.tryState::<BackendProcess>().is_none() {
                app.manage(BackendProcess(Mutex::new(Some(c))));
            } else if let Some(state) = app.tryState::<BackendProcess>() {
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
                killChild(&mut c);
                log::info!("[backend] proxy killed");
            }
        }
    }
}

// ── Tauri commands callable from the webview ─────────────────────────────

#[tauri::command]
pub async fn proxyStatus() -> String {
    let port = proxyPort();
    let url = format!("http://127.0.0.1:{}/health", port);
    let result = tokio::task::spawnBlocking(move || {
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
pub fn restartProxy(app: AppHandle, state: State<'_, BackendProcess>) -> String {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut c) = guard.take() {
            killChild(&mut c);
        }
    }

    if ensureRunning(&app) {
        "restarted".into()
    } else {
        "restart_failed".into()
    }
}

#[tauri::command]
pub fn selectDirectory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string().replace('\\', "/"))
}
