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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_PROXY_PORT: u16 = 8085;

/// When true, the watchdog must not respawn the backend (update/install in progress).
static UPDATE_HOLDOFF: AtomicBool = AtomicBool::new(false);

pub struct BackendProcess(pub Mutex<Option<Child>>, pub Mutex<Option<String>>);

/// Live setup phase for the desktop UI overlay (pollable via `backend_setup_status`).
pub struct BackendSetupStatus(pub Mutex<SetupPhase>);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPhase {
    /// idle | copying | creating_venv | installing | starting | ready | error | updating
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
    // Tauri preserves the path relative to src-tauri/ from bundle.resources.
    // We stage under `resources/…`, so prefer that prefix; also try the bare
    // relative path for older layouts / alternate configs.
    let candidates = [format!("resources/{rel}"), rel.to_string()];
    for c in &candidates {
        if let Ok(p) = app.path().resolve(c, tauri::path::BaseDirectory::Resource) {
            if p.exists() {
                return Some(p);
            }
        }
    }
    // Last resort: join against the resource directory itself.
    if let Ok(dir) = app.path().resource_dir() {
        for c in &candidates {
            let p = dir.join(c);
            if p.exists() {
                return Some(p);
            }
        }
        let bare = dir.join(rel);
        if bare.exists() {
            return Some(bare);
        }
    }
    None
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
    applyNoWindow(&mut cmd);
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
        // No stamp → unpackaged / dev checkout. Prefer silent skip unless
        // other backend pieces are present without a stamp (broken install).
        if resolveResource(app, "backend-py/app/main.py").is_some()
            || resolveResource(app, "python/python.exe").is_some()
        {
            return Err(
                "bundled backend resources found but backend-runtime.stamp is missing"
                    .into(),
            );
        }
        return Ok(());
    };
    let Some(bundled_main) = resolveResource(app, "backend-py/app/main.py") else {
        return Err(format!(
            "bundled backend-py missing (stamp={stamp}) — reinstall the desktop app"
        ));
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
    let pid = child.id();
    // Kill the whole process tree — uvicorn/python often leave children that
    // survive a plain Child::kill() and keep :8085 occupied after Quit.
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        applyNoWindow(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    // Wait until the OS reaps the process so DLL / .pyd handles are released
    // before NSIS tries to overwrite bundled Python files.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.wait();
                break;
            }
        }
    }
}

pub fn updateHoldoffActive() -> bool {
    UPDATE_HOLDOFF.load(Ordering::SeqCst)
}

/// Stop the supervised backend and keep the watchdog from respawning it.
/// Used on Quit and before the Windows updater/NSIS install step so bundled
/// `resources/python/*.pyd` files are not locked.
pub fn stopBackendForUpdate(app: &AppHandle) {
    stopBackend(app, "update");
}

/// Full backend teardown for app Quit — same kill path as update holdoff.
pub fn stopBackendOnQuit(app: &AppHandle) {
    stopBackend(app, "quit");
}

fn stopBackend(app: &AppHandle, reason: &str) {
    // Prevent watchBackend from respawning while we tear down.
    UPDATE_HOLDOFF.store(true, Ordering::SeqCst);
    let detail = if reason == "quit" {
        "Stopping backend…"
    } else {
        "Stopping backend for update…"
    };
    setSetupPhase(app, "updating", Some(detail.into()));
    killStoredChild(app);
    #[cfg(windows)]
    killAugustPythonOrphans(app);
    #[cfg(not(windows))]
    killProxyPortListeners();
    // Brief settle so Windows releases mapped DLLs before the installer runs.
    std::thread::sleep(Duration::from_millis(400));
    log::info!("[backend] stopped for {reason} (holdoff on)");
}

/// Best-effort: terminate leftover python/node that lock bundled
/// `resources/python/*.pyd`. Matches install-dir python, AppData venv, and
/// uvicorn command lines (orphans often survive after tray quit).
///
/// Important: do **not** Stop-Process August itself here — when invoked from
/// Quit, that kills this PowerShell mid-script and leaves the backend alive.
#[cfg(windows)]
fn killAugustPythonOrphans(app: &AppHandle) {
    let _ = app;
    let port = proxyPort();
    // Prefer -File over -Command so quoting/`\\?\` paths stay reliable.
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
function Stop-AugustBackends {{
  Get-CimInstance Win32_Process | Where-Object {{
    $_.Name -match '^(python|pythonw|node)(\.exe)?$' -and (
      ($_.ExecutablePath -and (
        $_.ExecutablePath -match '[\\/]August([\\/]|$)' -or
        $_.ExecutablePath -match 'com\.august\.proxy' -or
        $_.ExecutablePath -match 'backend-runtime'
      )) -or
      ($_.CommandLine -and (
        $_.CommandLine -match '[\\/]August([\\/]|$)' -or
        $_.CommandLine -match 'com\.august\.proxy' -or
        $_.CommandLine -match 'uvicorn.*app\.main' -or
        $_.CommandLine -match 'AUGUST_PROXY'
      ))
    )
  }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}
  foreach ($port in {port}, 8787) {{
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}
  }}
}}
Stop-AugustBackends
Start-Sleep -Milliseconds 500
Stop-AugustBackends
"#
    );
    let dir = std::env::temp_dir();
    let path = dir.join(format!("august-stop-backend-{}.ps1", std::process::id()));
    if std::fs::write(&path, script).is_err() {
        log::warn!("[backend] could not write orphan-kill script");
        return;
    }
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &path.to_string_lossy(),
    ]);
    applyNoWindow(&mut cmd);
    match cmd.status() {
        Ok(st) => log::info!("[backend] orphan python/node sweep exit={st}"),
        Err(e) => log::warn!("[backend] orphan python/node sweep failed: {e}"),
    }
    let _ = std::fs::remove_file(&path);
}

/// Best-effort: free the proxy listen port on macOS/Linux after Quit.
#[cfg(not(windows))]
fn killProxyPortListeners() {
    let port = proxyPort().to_string();
    // lsof -ti tcp:PORT | xargs kill -9
    if let Ok(output) = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for pid in stdout.split_whitespace() {
                let _ = Command::new("kill").args(["-9", pid]).status();
            }
        }
    }
}

/// Hide console windows for long-lived backend processes on Windows.
/// `python.exe` / `node.exe` are console subsystem binaries — without this,
/// each spawn allocates a visible terminal even when stdio is redirected.
fn applyNoWindow(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd;
}

/// Drop a stored Child that has already exited so we can respawn cleanly.
fn reclaimDeadChild(app: &AppHandle) {
    let Some(state) = app.try_state::<BackendProcess>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let dead = match guard.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => true,
        },
        None => false,
    };
    if dead {
        let _ = guard.take();
    }
}

/// Kill any Child we still hold (e.g. before a forced respawn).
fn killStoredChild(app: &AppHandle) {
    let Some(state) = app.try_state::<BackendProcess>() else {
        return;
    };
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut c) = guard.take() {
            killChild(&mut c);
        }
    };
}

fn storeChild(app: &AppHandle, child: Child) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            // Replace any prior handle — caller should have killed it first.
            if let Some(mut old) = guard.take() {
                killChild(&mut old);
            }
            *guard = Some(child);
            return;
        }
    }
    app.manage(BackendProcess(Mutex::new(Some(child)), Mutex::new(None)));
}

/// Serialize ensureRunning so the setup thread and sync_backend_deps cannot
/// both spawn uvicorn (which produced two console windows on Windows).
static ENSURE_LOCK: Mutex<()> = Mutex::new(());

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
    let _lock = ENSURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensureRunningLocked(app)
}

fn ensureRunningLocked(app: &AppHandle) -> bool {
    reclaimDeadChild(app);

    if updateHoldoffActive() {
        log::info!("[backend] update holdoff — skip ensureRunning");
        return false;
    }

    if isProxyUp() {
        log::info!("[backend] proxy already up on :{}", proxyPort());
        setSetupPhase(app, "ready", Some("Backend ready".into()));
        return true;
    }

    // Stale child still running but not answering health — replace it.
    killStoredChild(app);

    setSetupPhase(app, "starting", Some("Looking for backend…".into()));

    // Installed builds: materialize AppData runtime from bundled python + wheels.
    if let Err(e) = bootstrapBundledBackend(app) {
        let msg = format!("[backend] bundled runtime bootstrap failed: {e}");
        log::error!("{msg}");
        setLastError(app, msg.clone());
        setSetupPhase(app, "error", Some(msg));
        // Packaged installs must not silently fall through — the UI gate
        // needs a hard error so the user can Retry.
        if bundledStamp(app).is_some() {
            return false;
        }
        // Dev checkout without a stamp: keep trying system/repo Python.
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

            let mut cmd = Command::new(&python);
            cmd.arg("-m")
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
                .stderr(Stdio::from(logFile));
            applyNoWindow(&mut cmd);

            match cmd.spawn() {
                Ok(c) => {
                    storeChild(app, c);
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
                    // Kill the hung/unhealthy python child before Node fallback.
                    killStoredChild(app);
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
        let msg = "[backend] could not find Python or Node backend runtime".to_string();
        log::error!("{msg}");
        setLastError(app, msg.clone());
        setSetupPhase(app, "error", Some(msg));
        return false;
    };

    let Some(entry) = resolveNodeBackend(app) else {
        let msg = "[backend] could not resolve backend/index.js".to_string();
        log::error!("{msg}");
        setLastError(app, msg.clone());
        setSetupPhase(app, "error", Some(msg));
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

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&projectRoot)
        .env("AUGUST_PROXY_PORT", proxyPort().to_string())
        .env("AUGUST_PROXY_ROOT", projectRoot)
        .env("AUGUST_DATA_DIR", dataDir)
        .env("AUGUST_PROXY_DESKTOP", "1")
        .stdout(Stdio::from(logFile.try_clone().unwrap_or_else(|_| {
            File::create(devNullPath()).expect("failed to open null")
        })))
        .stderr(Stdio::from(logFile));
    applyNoWindow(&mut cmd);

    match cmd.spawn() {
        Ok(c) => {
            storeChild(app, c);
            log::info!("[backend] node proxy spawned (fallback) — waiting for /api/health");
            if waitUntilProxyUp(Duration::from_secs(20)) {
                log::info!("[backend] node proxy healthy on :{}", proxyPort());
                setSetupPhase(app, "ready", Some("Backend ready".into()));
                true
            } else {
                log::error!("[backend] node proxy spawned but /api/health not ready");
                let msg = format!(
                    "[backend] node proxy not healthy on :{} after spawn",
                    proxyPort()
                );
                setLastError(app, msg.clone());
                setSetupPhase(app, "error", Some(msg));
                false
            }
        }
        Err(e) => {
            let msg = format!("[backend] node spawn failed: {e}");
            log::error!("{msg}");
            setLastError(app, msg.clone());
            setSetupPhase(app, "error", Some(msg));
            false
        }
    }
}

/// Background supervisor: if /api/health goes down (or the child exits),
/// restart the backend automatically so the desktop app self-heals.
pub fn watchBackend(app: &AppHandle) {
    let mut backoff = Duration::from_secs(3);
    loop {
        std::thread::sleep(backoff);
        reclaimDeadChild(app);
        if isProxyUp() {
            backoff = Duration::from_secs(3);
            continue;
        }

        // Avoid thrashing while the user is mid-bootstrap (copy/pip) or updating.
        if updateHoldoffActive() {
            continue;
        }
        if let Some(state) = app.try_state::<BackendSetupStatus>() {
            if let Ok(guard) = state.0.lock() {
                let phase = guard.phase.as_str();
                if matches!(
                    phase,
                    "copying" | "creating_venv" | "installing" | "updating"
                ) {
                    continue;
                }
            }
        }

        log::warn!("[backend] proxy down — restarting");
        setSetupPhase(app, "starting", Some("Restarting backend…".into()));
        killStoredChild(app);
        if ensureRunning(app) {
            backoff = Duration::from_secs(3);
        } else {
            backoff = (backoff.saturating_mul(2)).min(Duration::from_secs(30));
            log::warn!(
                "[backend] restart failed — next attempt in {}s",
                backoff.as_secs()
            );
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

/// Kill the backend (and Windows orphans locking bundled Python) before NSIS runs.
#[tauri::command]
pub fn stop_backend_for_update(app: AppHandle) -> Result<String, String> {
    stopBackendForUpdate(&app);
    Ok("stopped".into())
}

/// Schedule a detached relaunch after the Windows updater quits this process.
///
/// On Windows, `update.install()` exits the app before JS can call `relaunch()`.
/// Silent NSIS installs also skip the normal "run app" step. NSIS POSTINSTALL
/// relaunches when possible; this is a safety net if that path is skipped.
#[tauri::command]
pub fn schedule_post_update_relaunch() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().replace('\'', "''");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS — survive August.exe exit
        // and PREINSTALL taskkill (which only targets August / python / node).
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        let script = format!(
            "$ErrorActionPreference='SilentlyContinue'; \
             Start-Sleep -Seconds 8; \
             if (-not (Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue)) {{ \
               Start-Process -FilePath '{exe_str}' \
             }}"
        );
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| e.to_string())?;
        log::info!("[update] scheduled post-update relaunch of {}", exe.display());
        return Ok("scheduled".into());
    }

    #[cfg(not(windows))]
    {
        let _ = exe_str;
        Ok("noop".into())
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

/// Sync / bootstrap backend deps, then ensure the proxy is running.
///
/// Packaged installs: blocking AppData bootstrap from bundled wheels, then
/// uvicorn. Dev: editable pip install when the app version stamp changed.
///
/// Returns `"up-to-date"` | `"synced"` | `"needs_setup"` | `"error: ..."`.
#[tauri::command]
pub async fn sync_backend_deps(app: AppHandle) -> String {
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || {
        setSetupPhase(&app2, "starting", Some("Preparing backend…".into()));
        if let Err(e) = bootstrapBundledBackend(&app2) {
            let msg = format!("bootstrap failed: {e}");
            setLastError(&app2, msg.clone());
            setSetupPhase(&app2, "error", Some(msg.clone()));
            return format!("error: {msg}");
        }

        // Packaged runtime: bootstrap already installed wheels; just start.
        if bundledStamp(&app2).is_some() {
            if ensureRunning(&app2) {
                if let Some(p) = versionStampPath(&app2) {
                    let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
                    let _ = std::fs::write(p, app2.package_info().version.to_string());
                }
                return "up-to-date".into();
            }
            let err = app2
                .try_state::<BackendProcess>()
                .and_then(|s| s.1.lock().ok().and_then(|g| g.clone()))
                .unwrap_or_else(|| "backend failed to start".into());
            return format!("error: {err}");
        }

        let Some(backendMain) = resolvePythonBackend(&app2) else {
            return "error: backend-py not found — reinstall August or run from a repo with backend-py/".into();
        };
        let Some(backendPyRoot) = projectRootFor(&backendMain) else {
            return "error: cannot resolve backend root".into();
        };
        let repoRoot = backendPyRoot
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| backendPyRoot.clone());

        let venvPy = if cfg!(windows) {
            backendPyRoot.join(".venv/Scripts/python.exe")
        } else {
            backendPyRoot.join(".venv/bin/python")
        };
        if !venvPy.exists() {
            return "needs_setup".into();
        }

        let app_version = app2.package_info().version.to_string();
        let stamp = versionStampPath(&app2);
        let current = stamp
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if current != app_version {
            setSetupPhase(
                &app2,
                "installing",
                Some("Updating Python dependencies…".into()),
            );
            let data_dir = appDataDir(&app2);
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            let log_path = data_dir.join("logs").join("pip-sync.log");
            if let Err(e) = runPythonSilent(
                &venvPy,
                &["-m", "pip", "install", "-e", "."],
                &backendPyRoot,
                &log_path,
            ) {
                let msg = format!("pip install failed: {e}");
                setLastError(&app2, msg.clone());
                setSetupPhase(&app2, "error", Some(msg.clone()));
                return format!("error: {msg}");
            }
            let _ = repoRoot; // keep env-compatible layout
            if let Some(p) = stamp {
                let _ = std::fs::create_dir_all(p.parent().unwrap_or(&backendPyRoot));
                let _ = std::fs::write(p, &app_version);
            }
        }

        if ensureRunning(&app2) {
            "synced".into()
        } else {
            "error: backend failed to start after sync".into()
        }
    })
    .await
    {
        Ok(s) => s,
        Err(e) => format!("error: sync task failed: {e}"),
    }
}
