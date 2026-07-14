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

pub struct BackendProcess(pub Mutex<Option<Child>>, pub Mutex<Option<String>>);

fn proxyPort() -> u16 {
    std::env::var("AUGUST_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PROXY_PORT)
}

fn proxyUrl() -> String {
    format!("http://127.0.0.1:{}/api/health", proxyPort())
}

// ── Python backend resolution (preferred) ───────────────────────────

fn pythonBinaryNames() -> &'static [&'static str] {
    if cfg!(windows) {
        &["python.exe", "python3.exe", "py.exe"]
    } else {
        &["python3", "python"]
    }
}

/// Resolve the `.venv` Python interpreter for a discovered backend entry
/// (`backend-py/app/main.py`). Returns `…/backend-py/.venv/{Scripts/python.exe|bin/python}`.
fn resolveVenvPython(backendMain: &Path) -> Option<PathBuf> {
    let backendPy = backendMain.parent()?.parent()?; // …/backend-py/app/main.py → …/backend-py
    let candidate = if cfg!(windows) {
        backendPy.join(".venv/Scripts/python.exe")
    } else {
        backendPy.join(".venv/bin/python")
    };
    candidate.exists().then_some(candidate)
}

/// True if a path points at the Windows Store Python alias stub
/// (`WindowsApps/python.exe`), which is a dead-end redirect, not a real interpreter.
fn isStoreStub(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
        .contains("windowsapps")
}

fn resolvePython(app: &AppHandle) -> Option<PathBuf> {
    // 1. If we located the backend, prefer its bundled `.venv` interpreter.
    if let Some(backendMain) = resolvePythonBackend(app) {
        if let Some(venv) = resolveVenvPython(&backendMain) {
            return Some(venv);
        }
    }
    // 2. Prefer the Windows launcher `py` (or `py -3`) on Windows, then
    //    system python3/python — but never the Microsoft Store alias stub.
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    if cfg!(windows) {
        candidates.push(which::which("py").ok());
    }
    candidates.push(which::which("python3").ok());
    candidates.push(which::which("python").ok());
    candidates
        .into_iter()
        .flatten()
        .filter(|p| !isStoreStub(p))
        .find(|path| path.exists())
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

/// Record the most recent backend spawn error so the UI can surface it.
fn setLastError(app: &AppHandle, msg: String) {
    if let Some(state) = app.tryState::<BackendProcess>() {
        if let Ok(mut guard) = state.1.lock() {
            *guard = Some(msg);
        }
    }
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

/// Poll health until success or timeout (used after spawn, not only "already up").
fn waitUntilProxyUp(timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let step = Duration::from_millis(250);
    while std::time::Instant::now() < deadline {
        if isProxyUp() {
            return true;
        }
        std::thread::sleep(step);
    }
    isProxyUp()
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
                        app.manage(BackendProcess(Mutex::new(Some(c)), Mutex::new(None)));
                    } else if let Some(state) = app.tryState::<BackendProcess>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(c);
                        }
                    }
                    log::info!("[backend] python proxy spawned — waiting for /api/health");
                    // Do not return success on spawn alone: cold start can take seconds
                    // (import + schema). Poll health so the webview does not thrash.
                    if waitUntilProxyUp(Duration::from_secs(20)) {
                        log::info!("[backend] python proxy healthy on :{}", proxyPort());
                        return true;
                    }
                    log::error!(
                        "[backend] python proxy spawned but /api/health not ready within timeout"
                    );
                    setLastError(
                        app,
                        format!(
                            "[backend] python proxy not healthy on :{} after spawn",
                            proxyPort()
                        ),
                    );
                    // Fall through to Node fallback only if Python never answered.
                }
                Err(e) => {
                    let msg = format!("[backend] python spawn failed: {e} — falling back to Node.js");
                    log::error!("{msg}");
                    setLastError(app, msg);
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
                app.manage(BackendProcess(Mutex::new(Some(c)), Mutex::new(None)));
            } else if let Some(state) = app.tryState::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(c);
                }
            }
            log::info!("[backend] node proxy spawned (fallback) — waiting for /api/health");
            if waitUntilProxyUp(Duration::from_secs(20)) {
                log::info!("[backend] node proxy healthy on :{}", proxyPort());
                true
            } else {
                log::error!("[backend] node proxy spawned but /api/health not ready");
                setLastError(
                    app,
                    format!(
                        "[backend] node proxy not healthy on :{} after spawn",
                        proxyPort()
                    ),
                );
                false
            }
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
    let url = format!("http://127.0.0.1:{}/api/health", port);
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

#[tauri::command]
pub fn backend_last_error(app: AppHandle) -> Option<String> {
    if let Some(state) = app.tryState::<BackendProcess>() {
        if let Ok(guard) = state.1.lock() {
            return guard.clone();
        }
    }
    None
}

/// Version stamp lives in the app-data `data` dir (same parent used for
/// `AUGUST_DATA_DIR`), so it tracks the Tauri package version rather than
/// the repo's `data/backend-version.txt` (a dev-only convenience copy).
fn versionStampPath(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("data").join("backend-version.txt"))
}

/// Sync backend Python deps when the app version changed.
///
/// Returns `"up-to-date"` | `"synced"` | `"syncing"` | `"needs_setup"` |
/// `"error: ..."`. The pip install runs as a **detached, non-blocking**
/// child (with `CREATE_NO_WINDOW` on Windows) so the UI never freezes.
#[tauri::command]
pub async fn syncBackendDeps(app: AppHandle) -> String {
    let Some(backendMain) = resolvePythonBackend(&app) else {
        return "error: backend-py not found".into();
    };
    let Some(backendRoot) = projectRootFor(&backendMain) else {
        return "error: cannot resolve backend root".into();
    };
    // Pick the venv pip (or `python -m pip`) to install into.
    let venvPy = if cfg!(windows) {
        backendRoot.join("backend-py/.venv/Scripts/python.exe")
    } else {
        backendRoot.join("backend-py/.venv/bin/python")
    };
    let pip = if venvPy.exists() {
        venvPy
    } else {
        // No venv yet — cannot safely install. Signal first-run setup.
        return "needs_setup".into();
    };

    let app_version = app.package_info().version.to_string();
    let stamp = versionStampPath(&app);
    let current = stamp
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if current == app_version {
        return "up-to-date".into();
    }

    // Spawn detached pip install into the venv.
    let data_dir = appDataDir(&app);
    let _ = std::fs::create_dir_all(data_dir.join("logs"));
    let log_path = data_dir.join("logs").join("pip-sync.log");
    let log_file = File::create(&log_path).unwrap_or_else(|_| File::create(devNullPath()).expect("null"));

    let mut cmd = Command::new(&pip);
    cmd.arg("-m").arg("pip").arg("install").arg("-e").arg("backend-py");
    if cfg!(windows) {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.current_dir(&backendRoot)
        .env("AUGUST_PROXY_ROOT", &backendRoot)
        .stdout(Stdio::from(log_file.try_clone().unwrap_or_else(|_| File::create(devNullPath()).expect("null"))))
        .stderr(Stdio::from(log_file));

    match cmd.spawn() {
        Ok(mut child) => {
            // Detach: we don't await — poll-free background install.
            let _ = child.id();
            std::mem::forget(child);
            // Best-effort: write the new stamp now so we don't re-trigger
            // immediately; a failed install is caught on next launch.
            if let Some(p) = stamp {
                let _ = std::fs::create_dir_all(p.parent().unwrap_or(&backendRoot));
                let _ = std::fs::write(p, &app_version);
            }
            "syncing".into()
        }
        Err(e) => format!("error: pip spawn failed: {e}"),
    }
}
