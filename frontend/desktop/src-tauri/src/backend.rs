// backend.rs — Rust-side backend supervisor
//
// Owns the August Proxy backend process. On Tauri startup we:
//   1) Poll http://127.0.0.1:8085/api/health — identity-checked: a 2xx alone
//      is not enough, the body must carry August's status/python fields
//   2) If down (or the runtime stamp differs from the bundled stamp), locate
//      Python (preferred) or Node (fallback)
//   3) Spawn the backend on 8085, falling back through 8086..8095 when the
//      port is taken or the backend never comes up healthy
//   4) Kill the process on app drop

use std::env;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_PROXY_PORT: u16 = 8085;

/// Last port of the spawn fallback range (8085..=8095 inclusive). Tried in
/// order when `AUGUST_PROXY_PORT` is not set: if the backend cannot bind (the
/// port is held by a foreign process) or never answers identity-checked
/// health, the next port is tried.
const PROXY_PORT_RANGE_END: u16 = DEFAULT_PROXY_PORT + 10;

/// The port the proxy is actually healthy on. Only consulted when
/// `AUGUST_PROXY_PORT` is unset; updated when a fallback port wins.
static ACTIVE_PROXY_PORT: AtomicU16 = AtomicU16::new(DEFAULT_PROXY_PORT);

/// When true, the watchdog must not respawn the backend (update/install in progress).
static UPDATE_HOLDOFF: AtomicBool = AtomicBool::new(false);
/// Set by the UI when the user cancels the visible installer download.
static UPDATE_DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

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

/// `AUGUST_PROXY_PORT` env override — when set it is the ONLY port tried
/// (no fallback range) and every surface reports it.
fn envPortOverride() -> Option<u16> {
    std::env::var("AUGUST_PROXY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
}

/// The port the webview should talk to: the env override when set, otherwise
/// the active port selected during the spawn fallback sweep. This is the
/// single source of truth surfaced to the UI (`proxy_status`) and used by the
/// orphan sweep.
fn proxyPort() -> u16 {
    envPortOverride().unwrap_or_else(|| ACTIVE_PROXY_PORT.load(Ordering::SeqCst))
}

/// Ports probed in order when spawning the backend. The env override disables
/// the fallback range entirely.
fn portCandidates() -> Vec<u16> {
    if let Some(p) = envPortOverride() {
        vec![p]
    } else {
        (DEFAULT_PROXY_PORT..=PROXY_PORT_RANGE_END).collect()
    }
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

// ── Single-instance guard ──────────────────────────────────────────────────
// A lock file in the AppData tree holds the PID of the owning instance.
// Without one, two instances (double-click, relaunch before exit) attach to
// the same backend by design, and quitting either one kills the shared
// backend mid-request (audit finding). Implemented with a plain lock file +
// PID liveness probe — no external crate (offline build).
const INSTANCE_LOCK_NAME: &str = "august.instance.lock";

fn instanceLockPath(app: &AppHandle) -> PathBuf {
    runtimeRoot(app).join(INSTANCE_LOCK_NAME)
}

#[cfg(windows)]
fn processAlive(pid: u32) -> bool {
    use std::process::Command;
    let filter = format!("PID eq {}", pid);
    match Command::new("tasklist").args(["/FI", &filter, "/NH"]).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn processAlive(pid: u32) -> bool {
    use std::process::Command;
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Try to acquire the single-instance lock. Returns true when THIS process
/// owns it (lock free, stale from a crashed instance, or just created).
pub fn acquireInstanceLock(app: &AppHandle) -> bool {
    let path = instanceLockPath(app);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if let Ok(pid) = existing.trim().parse::<u32>() {
            if pid != std::process::id() && processAlive(pid) {
                log::warn!(
                    "[backend] single-instance guard: another August instance is running (pid {}) — exiting",
                    pid
                );
                return false;
            }
        }
    }
    let _ = std::fs::write(&path, std::process::id().to_string());
    true
}

/// Remove the lock — only when this process owns it (a crashed instance's
/// stale lock is reclaimed by the next launch via the liveness check).
fn releaseInstanceLock(app: &AppHandle) {
    let path = instanceLockPath(app);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if existing.trim() == std::process::id().to_string() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn bundledStamp(app: &AppHandle) -> Option<String> {
    resolveResource(app, "backend-runtime.stamp")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "dev-placeholder")
}

/// True when the AppData runtime stamp matches the bundled stamp AND the
/// runtime main.py + venv exist (i.e. the bootstrap "up-to-date" check would
/// pass). Used to detect a stale-but-healthy backend at startup (must be
/// re-bootstrapped) and a stamped-but-broken runtime (must be reinstalled).
fn runtimeStampMatches(app: &AppHandle) -> bool {
    let Some(bundled) = bundledStamp(app) else {
        return true; // dev checkout — nothing to compare
    };
    let current = std::fs::read_to_string(runtimeStampPath(app))
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    current == bundled
        && runtimeBackendMain(app).is_file()
        && resolveVenvPython(&runtimeBackendMain(app))
            .map(|p| p.is_file())
            .unwrap_or(false)
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

    // Bundled skills (D16): skill_service resolves SKILLS_DIR to
    // {appData}/backend-runtime/skills — copy the staged skills tree so
    // installed builds ship the built-in skill catalog.
    if let Some(bundled_skills) = resolveResource(app, "skills") {
        let runtime_skills = runtime.join("skills");
        let _ = std::fs::create_dir_all(&runtime_skills);
        let _ = copyDirRecursive(&bundled_skills, &runtime_skills);
        log::info!("[backend] bundled skills copied → {}", runtime_skills.display());
    }

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

    // NOTE: the runtime stamp is deliberately NOT written here. It is written
    // only after the first successful identity-checked health probe (see
    // markProxyPort), so a broken wheel set cannot stamp success forever.
    log::info!("[backend] AppData runtime installed (stamp deferred until healthy)");
    Ok(())
}

/// Probe a Python interpreter for the >= 3.12 floor that every other launcher
/// enforces (bundled python and project venvs are known-good; system Python is
/// not — an old interpreter can silently break the backend at runtime).
fn pythonVersionOk(path: &Path) -> bool {
    match Command::new(path)
        .args(["-c", "import sys; print(sys.version_info >= (3, 12))"])
        .output()
    {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim() == "True"
        }
        _ => false,
    }
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
    // 4. System Python — never the Microsoft Store alias stub, and never an
    //    interpreter below 3.12 (reject with a log so the failure is visible).
    let mut candidates: Vec<Option<PathBuf>> = Vec::new();
    if cfg!(windows) {
        candidates.push(which::which("py").ok());
    }
    candidates.push(which::which("python3").ok());
    candidates.push(which::which("python").ok());
    for path in candidates.into_iter().flatten().filter(|p| !isStoreStub(p)) {
        if !path.exists() {
            continue;
        }
        if !pythonVersionOk(&path) {
            log::warn!(
                "[backend] system python {} is older than 3.12 — skipping",
                path.display()
            );
            continue;
        }
        return Some(path);
    }
    None
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
    releaseInstanceLock(app);
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
    //
    // The port-listener kill is scoped to owners whose path/command line also
    // match the August markers — an unrelated service (e.g. a dev server)
    // holding a probed port must never be killed by our teardown.
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
function Test-AugustBackend($p) {{
  return ($p.Name -match '^(python|pythonw|node)(\.exe)?$' -and (
    ($p.ExecutablePath -and (
      $p.ExecutablePath -match '[\\/]August([\\/]|$)' -or
      $p.ExecutablePath -match 'com\.august\.proxy' -or
      $p.ExecutablePath -match 'backend-runtime'
    )) -or
    ($p.CommandLine -and (
      $p.CommandLine -match '[\\/]August([\\/]|$)' -or
      $p.CommandLine -match 'com\.august\.proxy' -or
      $p.CommandLine -match 'uvicorn.*app\.main' -or
      $p.CommandLine -match 'AUGUST_PROXY'
    ))
  ))
}}
function Stop-AugustBackends {{
  Get-CimInstance Win32_Process | Where-Object {{ Test-AugustBackend $_ }} |
    ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}
  foreach ($port in {port}, 8085, 8787) {{
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object {{
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
        if ($owner -and (Test-AugustBackend $owner)) {{ Stop-Process -Id $owner.ProcessId -Force }}
      }}
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
    // Quit/update holdoff can race an in-flight respawn from watchBackend: the
    // child is spawned after stopBackend's kill + sweep already ran, so it
    // would orphan a fresh backend. Never let a child survive a teardown —
    // kill it immediately instead of storing it.
    if UPDATE_HOLDOFF.load(Ordering::SeqCst) {
        let mut c = child;
        log::warn!("[backend] update holdoff active — killing freshly spawned backend");
        killChild(&mut c);
        return;
    }
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

/// Identity-checked health probe for a specific port. A plain 2xx is NOT
/// enough — a foreign service answering on a probed port must not count as
/// "up". The backend's `/api/health` (backend-py/app/main.py) returns
/// `{'status': 'ok', 'version': …, 'python': True, 'port': …, 'uptime': …}`;
/// we require the stable `status == "ok"` and `python == true` fields as the
/// August marker.
fn healthOkOnPort(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    let resp = match reqwest::blocking::Client::new()
        .get(&url)
        .timeout(Duration::from_millis(400))
        .send()
    {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let body: serde_json::Value = match resp.json() {
        Ok(b) => b,
        Err(_) => return false,
    };
    body.get("status").and_then(|s| s.as_str()) == Some("ok")
        && body.get("python").and_then(|p| p.as_bool()) == Some(true)
}

fn isProxyUp() -> bool {
    healthOkOnPort(proxyPort())
}

/// True while the child we just spawned is still running (has not exited).
/// Lets the port-fallback loop bail out immediately on a bind failure instead
/// of burning the full per-port timeout.
fn storedChildAlive(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<BackendProcess>() else {
        return true;
    };
    let alive = match state.0.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(c) => !matches!(c.try_wait(), Ok(Some(_))),
            None => false,
        },
        Err(_) => true,
    };
    alive
}

/// Poll identity-checked health on `port` until success or timeout. Bails
/// early when the spawned child exits (e.g. the port was already taken by a
/// foreign process), so the fallback range does not stall per candidate.
fn waitForProxy(app: &AppHandle, port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let step = Duration::from_millis(250);
    while std::time::Instant::now() < deadline {
        if healthOkOnPort(port) {
            return true;
        }
        if !storedChildAlive(app) {
            return false;
        }
        std::thread::sleep(step);
    }
    healthOkOnPort(port)
}

/// Record the port the proxy is healthy on (so port reporting and the orphan
/// sweep follow the active port) and, for packaged installs, write the runtime
/// stamp — only here, after the first successful identity-checked health
/// probe, never after pip-install alone.
fn markProxyPort(port: u16, app: &AppHandle) {
    ACTIVE_PROXY_PORT.store(port, Ordering::SeqCst);
    if let Some(stamp) = bundledStamp(app) {
        let stamp_path = runtimeStampPath(app);
        if let Some(parent) = stamp_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&stamp_path, format!("{stamp}\n"));
        log::info!("[backend] runtime stamp written after healthy health check");
    }
    setSetupPhase(app, "ready", Some("Backend ready".into()));
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

    // Even when the proxy already answers, compare the bundled stamp against
    // the AppData runtime stamp: a stale backend from an older install keeps
    // serving old code after an update unless we tear it down and re-bootstrap
    // here, regardless of health.
    if isProxyUp() {
        let stale = bundledStamp(app).is_some() && !runtimeStampMatches(app);
        if !stale {
            log::info!("[backend] proxy already up on :{}", proxyPort());
            setSetupPhase(app, "ready", Some("Backend ready".into()));
            return true;
        }
        log::warn!(
            "[backend] proxy up on :{} but runtime stamp differs from bundled — re-bootstrapping",
            proxyPort()
        );
        killStoredChild(app);
    }

    // Stale child still running but not answering health — replace it.
    killStoredChild(app);

    setSetupPhase(app, "starting", Some("Looking for backend…".into()));

    // Installed builds: materialize AppData runtime from bundled python + wheels.
    // The runtime stamp is written only AFTER the first successful health
    // check (markProxyPort), never on pip-install success alone — a broken
    // wheel set must not stamp success forever. If a previously-stamped
    // runtime never comes up healthy, we wipe it and reinstall once below.
    let mut force_reinstall = false;
    loop {
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

        // Try Python backend first (port fallback range).
        if let Some(python) = resolvePython(app) {
            if let Some(pyEntry) = resolvePythonBackend(app) {
                let Some(backendPyRoot) = projectRootFor(&pyEntry) else {
                    log::error!(
                        "[backend] could not resolve project root for {}",
                        pyEntry.display()
                    );
                    return false;
                };
                let repoRoot = backendPyRoot
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| backendPyRoot.clone());

                let dataDir = appDataDir(app);
                let logDir = dataDir.join("logs");
                let _ = std::fs::create_dir_all(&logDir);
                let logPath = logDir.join("backend.log");

                for port in portCandidates() {
                    if updateHoldoffActive() {
                        return false;
                    }
                    log::info!(
                        "[backend] spawning python backend (uvicorn) at {} (data={})",
                        pyEntry.display(),
                        dataDir.display()
                    );

                    let logFile = File::create(&logPath).unwrap_or_else(|e| {
                        log::warn!("[backend] could not create {}: {e}", logPath.display());
                        File::create(devNullPath()).expect("failed to open null")
                    });

                    let mut cmd = Command::new(&python);
                    cmd.arg("-m")
                        .arg("uvicorn")
                        .arg("app.main:app")
                        .arg("--port")
                        .arg(port.to_string())
                        .arg("--host")
                        .arg("127.0.0.1")
                        .current_dir(&backendPyRoot)
                        .env("AUGUST_PROXY_PORT", port.to_string())
                        .env("AUGUST_PROXY_ROOT", &repoRoot)
                        .env("AUGUST_DATA_DIR", &dataDir)
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
                            log::info!(
                                "[backend] python proxy spawned on :{port} — waiting for /api/health"
                            );
                            // Do not return success on spawn alone: cold start can take
                            // seconds (import + schema). Poll identity-checked health so
                            // the webview does not thrash.
                            if waitForProxy(app, port, Duration::from_secs(45)) {
                                log::info!("[backend] python proxy healthy on :{port}");
                                markProxyPort(port, app);
                                return true;
                            }
                            log::error!(
                                "[backend] python proxy spawned but /api/health not ready on :{port}"
                            );
                            setLastError(
                                app,
                                format!(
                                    "[backend] python proxy not healthy on :{port} after spawn — see {}",
                                    logPath.display()
                                ),
                            );
                            // Kill the hung/unhealthy python child before the next port.
                            killStoredChild(app);
                        }
                        Err(e) => {
                            let msg = format!("[backend] python spawn failed on :{port}: {e}");
                            log::error!("{msg}");
                            setLastError(app, msg);
                        }
                    }
                }

                // Self-heal: a runtime that was previously stamped healthy
                // (matching the bundled stamp) but never comes up must be
                // wiped and reinstalled — a corrupted AppData runtime would
                // otherwise loop on 45s health timeouts forever.
                if !force_reinstall && bundledStamp(app).is_some() && runtimeStampMatches(app) {
                    log::warn!(
                        "[backend] runtime stamped healthy but proxy never up — wiping AppData runtime for clean reinstall"
                    );
                    force_reinstall = true;
                    let runtime = runtimeRoot(app);
                    let _ = std::fs::remove_dir_all(runtime.join("backend-py"));
                    let _ = std::fs::remove_file(runtimeStampPath(app));
                    continue;
                }
            }
        }
        break;
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
    let logDir = dataDir.join("logs");
    let _ = std::fs::create_dir_all(&logDir);
    let logPath = logDir.join("backend.log");

    for port in portCandidates() {
        if updateHoldoffActive() {
            return false;
        }
        log::info!(
            "[backend] spawning {} {} (data={})",
            node.display(),
            entry.display(),
            dataDir.display()
        );

        let logFile = File::create(&logPath).unwrap_or_else(|e| {
            log::warn!("[backend] could not create {}: {e}", logPath.display());
            File::create(devNullPath()).expect("failed to open null")
        });

        let mut cmd = Command::new(&node);
        cmd.arg(&entry)
            .current_dir(&projectRoot)
            .env("AUGUST_PROXY_PORT", port.to_string())
            .env("AUGUST_PROXY_ROOT", &projectRoot)
            .env("AUGUST_DATA_DIR", &dataDir)
            .env("AUGUST_PROXY_DESKTOP", "1")
            .stdout(Stdio::from(logFile.try_clone().unwrap_or_else(|_| {
                File::create(devNullPath()).expect("failed to open null")
            })))
            .stderr(Stdio::from(logFile));
        applyNoWindow(&mut cmd);

        match cmd.spawn() {
            Ok(c) => {
                storeChild(app, c);
                log::info!(
                    "[backend] node proxy spawned on :{port} (fallback) — waiting for /api/health"
                );
                if waitForProxy(app, port, Duration::from_secs(20)) {
                    log::info!("[backend] node proxy healthy on :{port}");
                    markProxyPort(port, app);
                    return true;
                }
                log::error!("[backend] node proxy spawned but /api/health not ready on :{port}");
                let msg = format!("[backend] node proxy not healthy on :{port} after spawn");
                setLastError(app, msg.clone());
                killStoredChild(app);
            }
            Err(e) => {
                let msg = format!("[backend] node spawn failed on :{port}: {e}");
                log::error!("{msg}");
                setLastError(app, msg.clone());
            }
        }
    }

    let msg = format!(
        "[backend] proxy could not be started on any port in {}..={}",
        DEFAULT_PROXY_PORT, PROXY_PORT_RANGE_END
    );
    log::error!("{msg}");
    setLastError(app, msg.clone());
    setSetupPhase(app, "error", Some(msg));
    false
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
pub async fn restart_proxy(app: AppHandle) -> String {
    let app2 = app.clone();
    // The kill + ensureRunning path can take up to ~65s (killChild wait +
    // 45s health poll) — never block the Tauri main thread on it.
    match tokio::task::spawn_blocking(move || {
        killStoredChild(&app2);
        if ensureRunning(&app2) {
            "restarted".into()
        } else {
            "restart_failed".into()
        }
    })
    .await
    {
        Ok(s) => s,
        Err(e) => format!("restart_failed: {e}"),
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
/// relaunches when possible; this waiter is a safety net if that path is skipped.
///
/// Important: do **not** use a fixed short sleep — large `resources/python`
/// copies often take longer than 8s. Relaunching mid-copy causes file-lock
/// errors and half-written binaries. Wait for `.august-update-complete`
/// (written in NSIS POSTINSTALL) or a long timeout with the exe present.
#[tauri::command]
pub fn schedule_post_update_relaunch() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    let dir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| exe.clone());
    let dir_str = dir.to_string_lossy().replace('\'', "''");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS — survive August.exe exit
        // and PREINSTALL taskkill (which only targets August / python / node).
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        // Poll up to ~3 minutes for large Python resource bundles.
        let script = format!(
            "$ErrorActionPreference='SilentlyContinue'; \
             $exe = '{exe_str}'; \
             $dir = '{dir_str}'; \
             $marker = Join-Path $dir '.august-update-complete'; \
             $deadline = (Get-Date).AddSeconds(180); \
             while ((Get-Date) -lt $deadline) {{ \
               if (Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue) {{ \
                 if (Test-Path -LiteralPath $marker) {{ Remove-Item -LiteralPath $marker -Force }}; \
                 exit 0 \
               }}; \
               $installerBusy = @(Get-Process | Where-Object {{ \
                 $_.ProcessName -match '^(Aug|august).*-setup' -or \
                 $_.Path -like '*nsis*' -or \
                 ($_.Path -and $_.Path -like '*\\AppData\\Local\\Temp\\*' -and $_.ProcessName -match '^(Aug|august)') \
               }}); \
               if ($installerBusy.Count -gt 0) {{ Start-Sleep -Seconds 2; continue }}; \
               if ((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $exe)) {{ \
                 Start-Sleep -Milliseconds 600; \
                 if (-not (Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue)) {{ \
                   Start-Process -FilePath $exe \
                 }}; \
                 Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue; \
                 exit 0 \
               }}; \
               Start-Sleep -Seconds 2 \
             }}; \
             if (-not (Get-Process -Name 'August','august-desktop' -ErrorAction SilentlyContinue) \
                 -and (Test-Path -LiteralPath $exe)) {{ \
               Start-Process -FilePath $exe \
             }}; \
             if (Test-Path -LiteralPath $marker) {{ Remove-Item -LiteralPath $marker -Force }}"
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
        log::info!(
            "[update] scheduled post-update relaunch waiter for {}",
            exe.display()
        );
        return Ok("scheduled".into());
    }

    #[cfg(not(windows))]
    {
        let _ = (exe_str, dir_str);
        Ok("noop".into())
    }
}

/// Progress payload emitted while streaming a release installer to disk.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallerDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

/// Stream a GitHub release installer into `{temp}/august-updates/{filename}`,
/// emitting `update-download-progress` events for the webview progress bar.
/// Returns the absolute path of the downloaded installer.
///
/// Used by the full-installer update flow: instead of a quiet in-place patch,
/// the app downloads the real NSIS setup from the latest GitHub release and
/// runs it with its normal wizard — the same experience as a first install,
/// so bundled backend changes always land.
#[tauri::command]
pub async fn download_release_installer(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    UPDATE_DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};

        let dir = std::env::temp_dir().join("august-updates");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not prepare the download folder: {e}"))?;
        let safe: String = filename
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        let dest = dir.join(if safe.is_empty() {
            "august-setup.exe".to_string()
        } else {
            safe
        });
        if dest.exists() {
            let _ = std::fs::remove_file(&dest);
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(900))
            .user_agent("august-desktop-updater")
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "download failed: release file not found (HTTP {})",
                resp.status()
            ));
        }
        let total = resp.content_length();
        let mut file = File::create(&dest)
            .map_err(|e| format!("could not create {}: {e}", dest.display()))?;

        let emit = |downloaded: u64, total: Option<u64>| {
            let _ = app.emit(
                "update-download-progress",
                InstallerDownloadProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                },
            );
        };
        emit(0, total);

        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        // reqwest's blocking Response implements std::io::Read — the async
        // `.chunk()` API does not exist on it, so read into a fixed buffer.
        let mut buf = [0u8; 64 * 1024];
        loop {
            if UPDATE_DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(&dest);
                return Err("update download cancelled".into());
            }
            let n = resp
                .read(&mut buf)
                .map_err(|e| format!("download interrupted: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("could not write the installer file: {e}"))?;
            downloaded += n as u64;
            if last_emit.elapsed() >= Duration::from_millis(150) {
                emit(downloaded, total);
                last_emit = std::time::Instant::now();
            }
        }
        let _ = file.flush();
        emit(downloaded, total.or(Some(downloaded)));

        // A real installer is tens of MB — anything tiny is an error page.
        if downloaded < 1024 * 1024 {
            let _ = std::fs::remove_file(&dest);
            return Err(
                "downloaded file is too small — the release asset may be missing".into(),
            );
        }
        log::info!(
            "[update] installer downloaded → {} ({} bytes)",
            dest.display(),
            downloaded
        );
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("download task failed: {e}"))?
}

/// Stop an in-flight Windows installer download started by the update dialog.
#[tauri::command]
pub fn cancel_update_download() -> String {
    UPDATE_DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    "cancel_requested".into()
}

/// Launch the downloaded installer in **update mode**, then exit August so the
/// installer can replace files.
///
/// Passes `/UPDATE` (no `/S`, no `/P`) so that:
///   - NSIS `PageLeaveReinstall` hits `${If} $UpdateMode = 1` → `Goto
///     reinst_uninstall` and `ExecWait`s the OLD `uninstall.exe` — the
///     uninstall wizard pops up first (confirm + progress pages). `/UPDATE`
///     is forwarded to it so it never deletes app data, and its app-data
///     checkbox is hidden in update mode.
///   - `$PassiveMode` stays 0, so `SkipIfPassive` does NOT hide the install
///     pages — after the uninstall wizard finishes, the user sees the install
///     wizard (welcome / directory / instfiles) exactly like a first-time
///     install. See the checked-in `windows/installer.nsi` template, which
///     also auto-skips the maintenance radio page under `$UpdateMode = 1`
///     and quits the update if the uninstall is cancelled.
///
/// NSIS PREINSTALL (in `windows/hooks.nsh`) still sweeps stray August/python
/// processes so locked `resources/python/*.pyd` files don't abort the copy.
#[tauri::command]
pub fn launch_installer_and_exit(app: AppHandle, path: String) -> Result<String, String> {
    let installer = PathBuf::from(&path);
    if !installer.is_file() {
        return Err(format!("installer not found: {path}"));
    }
    // Release python/.pyd locks before NSIS copies over the install dir.
    stopBackendForUpdate(&app);
    Command::new(&installer)
        .arg("/UPDATE")
        .spawn()
        .map_err(|e| format!("could not launch the installer: {e}"))?;
    log::info!(
        "[update] installer launched ({}) — exiting August",
        installer.display()
    );
    // Give the installer process a beat to start before we release our handles.
    std::thread::sleep(Duration::from_millis(600));
    app.exit(0);
    Ok("exiting".into())
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

/// Base64 payload for a file read (image attachments preserve their
/// source path — see the desktop drag-drop handler).
#[derive(serde::Serialize)]
pub struct FileData {
    ok: bool,
    data: String,
    name: String,
    path: String,
}

/// Read a user-dropped file's bytes as base64 so the webview can attach it
/// while keeping the real source path (drag-drop events only hand us paths).
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<FileData, String> {
    use base64::Engine;

    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(FileData {
        ok: true,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        name,
        path,
    })
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
