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
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_PROXY_PORT: u16 = 8085;

pub struct BackendProcess(pub Mutex<Option<Child>>, pub Mutex<Option<String>>);

/// Live setup phase for the desktop UI overlay (pollable via `backend_setup_status`).
pub struct BackendSetupStatus(pub Mutex<SetupPhase>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPhase {
    /// idle | copying | creating_venv | installing | starting | ready | error
    pub phase: String,
    pub detail: Option<String>,
}

impl Default for SetupPhase {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            detail: None,
        }
    }
}

fn setSetupPhase(app: &AppHandle, phase: &str, detail: Option<String>) {
    if let Some(state) = app.try_state::<BackendSetupStatus>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = SetupPhase {
                phase: phase.into(),
                detail: detail.clone(),
            };
        }
    }
    let _ = app.emit(
        "backend-setup",
        SetupPhase {
            phase: phase.into(),
            detail,
        },
    );
}

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

fn resolveResource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    app.path()
        .resolve(rel, tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Writable AppData tree used for the installed (bundled) backend runtime.
/// Layout: `{appData}/backend-runtime/backend-py/{app,.venv,…}`
fn runtimeRoot(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("backend-runtime")
}

fn runtimeBackendMain(app: &AppHandle) -> PathBuf {
    runtimeRoot(app).join("backend-py/app/main.py")
}

fn runtimeStampPath(app: &AppHandle) -> PathBuf {
    runtimeRoot(app).join("runtime.stamp")
}

fn bundledStamp(app: &AppHandle) -> Option<String> {
    resolveResource(app, "backend-runtime.stamp")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "dev-placeholder")
}

fn bundledPython(app: &AppHandle) -> Option<PathBuf> {
    let rel = if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3"
    };
    resolveResource(app, rel).or_else(|| resolveResource(app, "python/python.exe"))
}

fn bundledWheelsDir(app: &AppHandle) -> Option<PathBuf> {
    resolveResource(app, "wheels")
}

fn copyDirRecursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {e}", from.display()))?;
        if ft.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "__pycache__"
                || name == ".venv"
                || name == ".mypy_cache"
                || name == ".ruff_cache"
                || name == "tests"
            {
                continue;
            }
            copyDirRecursive(&from, &to)?;
        } else if ft.is_file() {
            if let Some(ext) = from.extension() {
                if ext == "pyc" {
                    continue;
                }
            }
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::copy(&from, &to)
                .map_err(|e| format!("copy {} → {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

fn runPythonSilent(python: &Path, args: &[&str], cwd: &Path, log_path: &Path) -> Result<(), String> {
    let log_file = File::create(log_path).unwrap_or_else(|_| {
        File::create(devNullPath()).expect("failed to open null")
    });
    let mut cmd = Command::new(python);
    cmd.args(args)
        .current_dir(cwd)
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdout(Stdio::from(log_file.try_clone().unwrap_or_else(|_| {
            File::create(devNullPath()).expect("failed to open null")
        })))
        .stderr(Stdio::from(log_file));
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let status = cmd
        .status()
        .map_err(|e| format!("{} {} failed to start: {e}", python.display(), args.join(" ")))?;
    if !status.success() {
        return Err(format!(
            "{} {} exited with {}",
            python.display(),
            args.join(" "),
            status
        ));
    }
    Ok(())
}

/// First-launch (or stamp mismatch): copy bundled backend-py into AppData,
/// create a venv with the portable Python, install offline from wheels.
fn bootstrapBundledBackend(app: &AppHandle) -> Result<(), String> {
    let Some(stamp) = bundledStamp(app) else {
        return Ok(()); // Dev / unpackaged: nothing to bootstrap
    };
    let Some(bundled_main) = resolveResource(app, "backend-py/app/main.py") else {
        return Ok(());
    };
    let Some(bundled_py_root) = projectRootFor(&bundled_main) else {
        return Err("bundled backend-py root missing".into());
    };
    let Some(base_python) = bundledPython(app) else {
        return Err("bundled portable python missing".into());
    };
    let Some(wheels) = bundledWheelsDir(app) else {
        return Err("bundled wheels/ missing".into());
    };

    let runtime = runtimeRoot(app);
    let runtime_backend = runtime.join("backend-py");
    let runtime_main = runtimeBackendMain(app);
    let stamp_path = runtimeStampPath(app);
    let current = std::fs::read_to_string(&stamp_path)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let venv_py = if cfg!(windows) {
        runtime_backend.join(".venv/Scripts/python.exe")
    } else {
        runtime_backend.join(".venv/bin/python")
    };

    if current == stamp && runtime_main.is_file() && venv_py.is_file() {
        log::info!("[backend] AppData runtime up-to-date ({})", stamp);
        return Ok(());
    }

    log::info!(
        "[backend] bootstrapping AppData runtime → {}",
        runtime.display()
    );
    setSetupPhase(
        app,
        "copying",
        Some("Preparing backend files…".into()),
    );
    let log_dir = appDataDir(app).join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let bootstrap_log = log_dir.join("backend-bootstrap.log");

    // Refresh sources (keep existing .venv if present until recreate)
    if runtime_backend.exists() {
        let _ = std::fs::remove_dir_all(runtime_backend.join("app"));
    }
    std::fs::create_dir_all(&runtime_backend)
        .map_err(|e| format!("mkdir runtime: {e}"))?;
    copyDirRecursive(&bundled_py_root, &runtime_backend)?;

    if !venv_py.is_file() {
        setSetupPhase(
            app,
            "creating_venv",
            Some("Creating Python environment…".into()),
        );
        if runtime_backend.join(".venv").exists() {
            let _ = std::fs::remove_dir_all(runtime_backend.join(".venv"));
        }
        runPythonSilent(
            &base_python,
            &["-m", "venv", ".venv"],
            &runtime_backend,
            &bootstrap_log,
        )?;
    }

    let wheels_str = wheels.to_string_lossy().to_string();
    setSetupPhase(
        app,
        "installing",
        Some("Installing backend dependencies (first launch)…".into()),
    );
    runPythonSilent(
        &venv_py,
        &[
            "-m",
            "pip",
            "install",
            "--no-index",
            "--find-links",
            &wheels_str,
            "august-proxy",
        ],
        &runtime_backend,
        &bootstrap_log,
    )?;

    let _ = std::fs::write(&stamp_path, format!("{stamp}\n"));
    log::info!("[backend] AppData runtime ready");
    Ok(())
}

fn resolvePython(app: &AppHandle) -> Option<PathBuf> {
    // 1. Prefer AppData runtime venv (installed builds).
    let runtime_main = runtimeBackendMain(app);
    if runtime_main.is_file() {
        if let Some(venv) = resolveVenvPython(&runtime_main) {
            return Some(venv);
        }
    }
    // 2. Prefer `.venv` next to whatever backend sources we found (dev).
    if let Some(backendMain) = resolvePythonBackend(app) {
        if let Some(venv) = resolveVenvPython(&backendMain) {
            return Some(venv);
        }
    }
    // 3. Bundled portable Python (bootstrap only — deps live in the venv).
    if let Some(bundled) = bundledPython(app) {
        return Some(bundled);
    }
    // 4. System Python — never the Microsoft Store alias stub.
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
    // Prefer writable AppData copy (after bootstrap).
    let runtime_main = runtimeBackendMain(app);
    if runtime_main.is_file() {
        return Some(runtime_main);
    }

    let mut candidates: Vec<Option<PathBuf>> = vec![
        resolveResource(app, "backend-py/app/main.py"),
        env::current_dir().ok().map(|cwd| cwd.join("backend-py/app/main.py")),
        env::current_dir().ok().map(|cwd| cwd.join("../backend-py/app/main.py")),
    ];

    // Walk up from the executable so release/dev builds find a repo checkout
    // (e.g. …/src-tauri/target/release/august-desktop.exe → …/august-proxy/backend-py).
    if let Ok(exe) = env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..10 {
            let Some(d) = dir else { break };
            candidates.push(Some(d.join("backend-py/app/main.py")));
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

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
        if let Ok(entries) = std::fs::read_dir(binariesDir) {
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
    entry.parent()?.parent().map(Path::to_path_buf)
}

fn appDataDir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("data")
}

fn killChild(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Record the most recent backend spawn error so the UI can surface it.
fn setLastError(app: &AppHandle, msg: String) {
    if let Some(state) = app.try_state::<BackendProcess>() {
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
        setSetupPhase(app, "ready", Some("Backend ready".into()));
        return true;
    }

    setSetupPhase(app, "starting", Some("Looking for backend…".into()));

    // Installed builds: materialize AppData runtime from bundled python + wheels.
    if let Err(e) = bootstrapBundledBackend(app) {
        let msg = format!("[backend] bundled runtime bootstrap failed: {e}");
        log::error!("{msg}");
        setLastError(app, msg.clone());
        setSetupPhase(app, "error", Some(msg));
        // Continue — maybe a repo checkout .venv is available for dev.
    }

    // Try Python backend first
    if let Some(python) = resolvePython(app) {
        if let Some(pyEntry) = resolvePythonBackend(app) {
            setSetupPhase(
                app,
                "starting",
                Some("Starting backend…".into()),
            );
            let Some(backendPyRoot) = projectRootFor(&pyEntry) else {
                log::error!("[backend] could not resolve project root for {}", pyEntry.display());
                return false;
            };
            let repoRoot = backendPyRoot
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| backendPyRoot.clone());

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
                .current_dir(&backendPyRoot)
                .env("AUGUST_PROXY_PORT", proxyPort().to_string())
                .env("AUGUST_PROXY_ROOT", &repoRoot)
                .env("AUGUST_DATA_DIR", dataDir)
                .env("AUGUST_PROXY_DESKTOP", "1")
                .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
                .stdout(Stdio::from(logFile.try_clone().unwrap_or_else(|_| {
                    File::create(devNullPath()).expect("failed to open null")
                })))
                .stderr(Stdio::from(logFile))
                .spawn();

            match child {
                Ok(c) => {
                    if let Some(state) = app.try_state::<BackendProcess>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(c);
                        }
                    } else {
                        app.manage(BackendProcess(Mutex::new(Some(c)), Mutex::new(None)));
                    }
                    log::info!("[backend] python proxy spawned — waiting for /api/health");
                    // Do not return success on spawn alone: cold start can take seconds
                    // (import + schema). Poll health so the webview does not thrash.
                    if waitUntilProxyUp(Duration::from_secs(45)) {
                        log::info!("[backend] python proxy healthy on :{}", proxyPort());
                        setSetupPhase(app, "ready", Some("Backend ready".into()));
                        return true;
                    }
                    log::error!(
                        "[backend] python proxy spawned but /api/health not ready within timeout"
                    );
                    setLastError(
                        app,
                        format!(
                            "[backend] python proxy not healthy on :{} after spawn — see {}",
                            proxyPort(),
                            logPath.display()
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
        .stdout(Stdio::from(logFile.try_clone().unwrap_or_else(|_| {
            File::create(devNullPath()).expect("failed to open null")
        })))
        .stderr(Stdio::from(logFile))
        .spawn();

    match child {
        Ok(c) => {
            if let Some(state) = app.try_state::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(c);
                }
            } else {
                app.manage(BackendProcess(Mutex::new(Some(c)), Mutex::new(None)));
            }
            log::info!("[backend] node proxy spawned (fallback) — waiting for /api/health");
            if waitUntilProxyUp(Duration::from_secs(20)) {
                log::info!("[backend] node proxy healthy on :{}", proxyPort());
                setSetupPhase(app, "ready", Some("Backend ready".into()));
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
pub async fn proxy_status() -> String {
    let port = proxyPort();
    let url = format!("http://127.0.0.1:{}/api/health", port);
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
pub fn select_directory(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    // Use the dialog plugin (not raw rfd) so the picker is parented to the
    // Tauri window. Plain rfd::FileDialog often fails to appear on Windows
    // when invoked from a command worker thread.
    app.dialog()
        .file()
        .set_title("Select workspace folder")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|path| path.to_string_lossy().to_string().replace('\\', "/"))
}

#[tauri::command]
pub fn backend_setup_status(app: AppHandle) -> SetupPhase {
    if let Some(state) = app.try_state::<BackendSetupStatus>() {
        if let Ok(guard) = state.0.lock() {
            return guard.clone();
        }
    }
    SetupPhase::default()
}

#[tauri::command]
pub fn backend_last_error(app: AppHandle) -> Option<String> {
    if let Some(state) = app.try_state::<BackendProcess>() {
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
pub async fn sync_backend_deps(app: AppHandle) -> String {
    // Prefer materializing the bundled runtime (installed builds).
    if let Err(e) = bootstrapBundledBackend(&app) {
        // If we have a bundled stamp, bootstrap failure is fatal for sync.
        if bundledStamp(&app).is_some() {
            return format!("error: bootstrap failed: {e}");
        }
    }

    let Some(backendMain) = resolvePythonBackend(&app) else {
        return "error: backend-py not found".into();
    };
    // backend-py/app/main.py → backend-py
    let Some(backendPyRoot) = projectRootFor(&backendMain) else {
        return "error: cannot resolve backend root".into();
    };
    // Repo / runtime root is the parent of backend-py.
    let repoRoot = backendPyRoot
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| backendPyRoot.clone());

    // Pick the venv interpreter inside backend-py/.venv.
    let venvPy = if cfg!(windows) {
        backendPyRoot.join(".venv/Scripts/python.exe")
    } else {
        backendPyRoot.join(".venv/bin/python")
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
    cmd.arg("-m").arg("pip").arg("install");
    if let Some(wheels) = bundledWheelsDir(&app) {
        // Offline install from packaged wheels (release builds).
        cmd.arg("--no-index")
            .arg("--find-links")
            .arg(wheels)
            .arg("august-proxy");
    } else {
        // Dev: editable install from source.
        cmd.arg("-e").arg(".");
    }
    if cfg!(windows) {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.current_dir(&backendPyRoot)
        .env("AUGUST_PROXY_ROOT", &repoRoot)
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .stdout(Stdio::from(log_file.try_clone().unwrap_or_else(|_| File::create(devNullPath()).expect("null"))))
        .stderr(Stdio::from(log_file));

    match cmd.spawn() {
        Ok(child) => {
            // Detach: we don't await — poll-free background install.
            let _ = child.id();
            std::mem::forget(child);
            // Best-effort: write the new stamp now so we don't re-trigger
            // immediately; a failed install is caught on next launch.
            if let Some(p) = stamp {
                let _ = std::fs::create_dir_all(p.parent().unwrap_or(&backendPyRoot));
                let _ = std::fs::write(p, &app_version);
            }
            "syncing".into()
        }
        Err(e) => format!("error: pip spawn failed: {e}"),
    }
}
