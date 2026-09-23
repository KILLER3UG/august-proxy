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

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_PROXY_PORT: u16 = 8085;
const UPDATER_PUBLIC_KEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDVFRjVGM0E1RTlDMkUzNTAKUldSUTQ4THBwZlAxWHFoMTRFVXUvNldiaC9vTGVHRFlNdGxXZkpSZk5zN3Y4ckY1VkFidlp5ZDEK";
const RELEASE_REPOSITORY: &str = "KILLER3UG/august-proxy";
static VERIFIED_INSTALLER: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

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

/// True only for the process that actually owns the single-instance lock.
/// A launch that was refused by the guard must never run backend teardown: its
/// exit fires `ExitRequested`, and the orphan sweep would kill the *first*
/// instance's uvicorn mid-request — the exact failure the guard exists to stop.
static INSTANCE_LOCK_OWNED: AtomicBool = AtomicBool::new(false);
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

/// True only when `pid` is a live *August* process. A bare liveness check is
/// not enough: after a force-kill the recorded PID can be recycled by an
/// unrelated program, which would lock every later launch out of the app.
#[cfg(windows)]
fn processAlive(pid: u32) -> bool {
    use std::process::Command;
    let filter = format!("PID eq {}", pid);
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &filter, "/NH", "/FO", "CSV"]);
    applyNoWindow(&mut cmd);
    match cmd.output() {
        Ok(out) => isAugustRow(&String::from_utf8_lossy(&out.stdout), pid),
        // Unanswerable is treated as "not alive": refusing to launch at all is
        // the worse failure, and a second instance still falls back down the
        // probe port range rather than corrupting the first one's state.
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn processAlive(pid: u32) -> bool {
    use std::process::Command;
    // `ps -p <pid> -o comm=` already scopes to the PID, so only the image name
    // needs checking here.
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .to_ascii_lowercase()
                .contains("august")
        })
        .unwrap_or(false)
}

/// Parse a `tasklist /FO CSV` row — `"image.exe","20528",…` — requiring both an
/// exact PID match and an August image name.
#[cfg(windows)]
fn isAugustRow(output: &str, pid: u32) -> bool {
    output.lines().any(|line| {
        let mut cols = line.split("\",\"");
        let image = cols.next().unwrap_or("").trim_matches('"');
        let row_pid = cols.next().unwrap_or("").trim();
        row_pid == pid.to_string() && image.to_ascii_lowercase().contains("august")
    })
}

/// Try to acquire the single-instance lock. Returns true when THIS process
/// owns it (lock free, stale from a crashed instance, or just created).
pub fn acquireInstanceLock(app: &AppHandle) -> bool {
    let path = instanceLockPath(app);
    if let Some(parent) = path.parent() {
        // A fresh install has no runtime dir yet. Without this the write below
        // fails and the guard silently no-ops for the whole session.
        let _ = std::fs::create_dir_all(parent);
    }
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
    INSTANCE_LOCK_OWNED.store(true, Ordering::SeqCst);
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

fn directoryHasFiles(path: &Path) -> bool {
    fn contains_file(path: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(path) else {
            return false;
        };
        entries.into_iter().any(|entry| {
            let Ok(entry) = entry else {
                return false;
            };
            let child = entry.path();
            if child.is_dir() {
                contains_file(&child)
            } else {
                child.is_file()
            }
        })
    }
    path.is_dir() && contains_file(path)
}

fn bundledPayloadComplete(app: &AppHandle) -> bool {
    let Some(stamp) = bundledStamp(app) else {
        return false;
    };
    let Some(main) = resolveResource(app, "backend-py/app/main.py") else {
        return false;
    };
    let Some(python) = bundledPython(app) else {
        return false;
    };
    let Some(wheels) = bundledWheelsDir(app) else {
        return false;
    };
    let Some(skills) = resolveResource(app, "skills") else {
        return false;
    };
    let Some(manifest) = resolveResource(app, "backend-runtime.json") else {
        return false;
    };
    let Some(node) = bundledNode(app) else {
        return false;
    };
    let backend = match projectRootFor(&main) {
        Some(path) => path,
        None => return false,
    };
    let sidecar = backend.join("sidecar");
    main.is_file()
        && backend.join("pyproject.toml").is_file()
        && sidecar.join("package.json").is_file()
        && sidecar.join("package-lock.json").is_file()
        && sidecar.join("firmware-runner.mjs").is_file()
        && directoryHasFiles(&sidecar.join("node_modules"))
        && python.is_file()
        && wheels.is_dir()
        && directoryHasFiles(&wheels)
        && skills.is_dir()
        && directoryHasFiles(&skills)
        && manifest.is_file()
        && node.is_file()
        && !stamp.is_empty()
}

/// True when the complete AppData runtime payload is present, including the
/// backend entry points, sidecar dependencies, skills, and runtime manifest.
fn runtimePayloadComplete(app: &AppHandle) -> bool {
    let runtime = runtimeRoot(app);
    let main = runtimeBackendMain(app);
    let venv_python = resolveVenvPython(&main);
    let skills = runtime.join("skills");
    let manifest = runtime.join("backend-runtime.json");
    let backend = match main.parent().and_then(|path| path.parent()) {
        Some(path) => path,
        None => return false,
    };
    let sidecar = backend.join("sidecar");
    main.is_file()
        && venv_python
            .as_ref()
            .map(|path| path.is_file())
            .unwrap_or(false)
        && backend.join("pyproject.toml").is_file()
        && sidecar.join("package.json").is_file()
        && sidecar.join("package-lock.json").is_file()
        && sidecar.join("firmware-runner.mjs").is_file()
        && directoryHasFiles(&sidecar.join("node_modules"))
        && skills.is_dir()
        && directoryHasFiles(&skills)
        && manifest.is_file()
}

/// True when the AppData runtime stamp matches the bundled stamp AND the
/// complete runtime payload is present. A stamp alone is never enough to
/// declare an installed backend healthy.
fn runtimeStampMatches(app: &AppHandle) -> bool {
    let Some(bundled) = bundledStamp(app) else {
        return true; // dev checkout — nothing to compare
    };
    let current = std::fs::read_to_string(runtimeStampPath(app))
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    current == bundled && runtimePayloadComplete(app) && bundledPayloadComplete(app)
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
    let wheels = resolveResource(app, "wheels")?;
    (wheels.is_dir() && directoryHasFiles(&wheels)).then_some(wheels)
}

fn bundledNode(app: &AppHandle) -> Option<PathBuf> {
    let binaries = resolveResource(app, "binaries")?;
    let expected = if cfg!(windows) {
        "node-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "node-aarch64-apple-darwin"
        } else {
            "node-x86_64-apple-darwin"
        }
    } else if cfg!(target_arch = "aarch64") {
        "node-aarch64-unknown-linux-gnu"
    } else {
        "node-x86_64-unknown-linux-gnu"
    };
    let exact = binaries.join(expected);
    exact.is_file().then_some(exact)
}

fn copyDirRecursive(src: &Path, dst: &Path, excludeTests: bool) -> Result<(), String> {
    copyDirRecursiveAt(src, dst, excludeTests, 0)
}

fn copyDirRecursiveAt(
    src: &Path,
    dst: &Path,
    excludeTests: bool,
    depth: usize,
) -> Result<(), String> {
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
            // `build`/`dist`/egg-info are this package's own setuptools output and
            // only ever sit at the payload root. Applied at depth they also delete
            // every dependency's compiled entry point under sidecar/node_modules
            // (avr8js, jimp, …), which the runtime then cannot import.
            let rootOnlyArtifact = depth == 0
                && (name == "build" || name == "dist" || name == "august_proxy.egg-info");
            if name == "__pycache__"
                || name == ".venv"
                || name == ".mypy_cache"
                || name == ".ruff_cache"
                || name == ".pytest_cache"
                || (excludeTests && name == "tests")
                || rootOnlyArtifact
            {
                continue;
            }
            copyDirRecursiveAt(&from, &to, excludeTests, depth + 1)?;
        } else if ft.is_file() {
            if from.file_name().and_then(|name| name.to_str()) == Some(".usage.json") {
                continue;
            }
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

fn runPythonSilent(
    python: &Path,
    args: &[&str],
    cwd: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let log_file = File::create(log_path)
        .unwrap_or_else(|_| File::create(devNullPath()).expect("failed to open null"));
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
    let status = cmd.status().map_err(|e| {
        format!(
            "{} {} failed to start: {e}",
            python.display(),
            args.join(" ")
        )
    })?;
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

/// Outcome of wiping a stale bootstrap tree. A wipe that cannot finish is
/// never fatal on its own: `Degraded` carries the warning to surface while
/// boot continues.
enum WipeOutcome {
    /// Tree removed (or already absent): boot continues onto a fresh copy.
    Clean,
    /// Removal stayed blocked; the message says what was left behind.
    Degraded(String),
}

/// Windows locks (an antivirus scan, a lingering python.exe) make deletion
/// fail transiently, so retry a few times with a short pause before falling
/// back — the stale tree only needs the lock to drop for a moment.
const WIPE_RETRIES: u32 = 3;
const WIPE_RETRY_DELAY_MS: u64 = 300;

/// Best-effort wipe of a stale runtime tree (backend sources + `.venv`, or
/// skills): retry, then rename to a `.old` sibling, then leave it in place.
/// Only a genuinely blocked removal reaches the fallbacks — a normal wipe
/// still returns `Clean`, so a fresh tree (and rebuilt venv) is the rule.
fn wipeStaleTree(path: &Path) -> WipeOutcome {
    wipeStaleTreeWith(
        path,
        |p| std::fs::remove_dir_all(p),
        |from, to| std::fs::rename(from, to),
        WIPE_RETRIES,
        WIPE_RETRY_DELAY_MS,
    )
}

/// `wipeStaleTree` with the filesystem operations injected, so tests can
/// simulate a locked directory without locking one.
fn wipeStaleTreeWith(
    path: &Path,
    mut remove: impl FnMut(&Path) -> std::io::Result<()>,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    retries: u32,
    retry_delay_ms: u64,
) -> WipeOutcome {
    if !path.exists() {
        return WipeOutcome::Clean;
    }
    let mut remove_err: Option<String> = None;
    for attempt in 0..=retries {
        if attempt > 0 && retry_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(retry_delay_ms));
        }
        match remove(path) {
            Ok(()) => return WipeOutcome::Clean,
            // A failed pass already deleted everything it reached, so a
            // retry continues where the last one stopped instead of
            // starting over.
            Err(e) => remove_err = Some(e.to_string()),
        }
    }
    let remove_err = remove_err.unwrap_or_else(|| "unknown error".into());

    // Deletion is what Windows locks block; renaming the directory usually
    // still succeeds with files inside it open, and moving it aside gives the
    // fresh copy (and its rebuilt venv) a clean path to land on.
    let stale_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "stale".into());
    let aside = path.with_file_name(format!("{stale_name}.old"));
    if aside.exists() {
        // A leftover `.old` from an earlier blocked boot would make the
        // rename fail (destination exists) — clear it best-effort first.
        let _ = std::fs::remove_dir_all(&aside);
    }
    let warning = match rename(path, &aside) {
        Ok(()) => format!(
            "stale {} could not be removed ({remove_err}) — renamed it to {} instead; boot continues",
            path.display(),
            aside.display()
        ),
        Err(rename_err) => format!(
            "stale {} could not be removed ({remove_err}) or renamed aside ({rename_err}) — left in place; boot continues with a possibly stale tree",
            path.display()
        ),
    };
    log::warn!("[backend] WARNING: {warning}");
    WipeOutcome::Degraded(warning)
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
                "bundled backend resources found but backend-runtime.stamp is missing".into(),
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
        return Err("bundled wheels/ missing or empty".into());
    };
    let Some(bundled_skills) = resolveResource(app, "skills") else {
        return Err("bundled skills/ missing".into());
    };
    let Some(bundled_manifest) = resolveResource(app, "backend-runtime.json") else {
        return Err("bundled backend-runtime.json missing".into());
    };

    let runtime = runtimeRoot(app);
    let runtime_backend = runtime.join("backend-py");
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

    // Build provenance for the running backend (audit finding 2026-09-15 #7):
    // the staged manifest tells app/lib/build_info.py which commit this copy
    // came from, and it looks for the file BESIDE backend-py/ — which nothing
    // used to copy here, so installed builds reported `Runtime code: unknown`
    // forever. Stage it before the up-to-date early return so installs
    // bootstrapped before this fix self-heal on their next launch.
    std::fs::create_dir_all(&runtime).map_err(|e| format!("mkdir runtime: {e}"))?;
    let runtime_manifest = runtime.join("backend-runtime.json");
    std::fs::copy(&bundled_manifest, &runtime_manifest)
        .map_err(|e| format!("stage backend-runtime.json: {e}"))?;

    if current == stamp && runtimePayloadComplete(app) {
        log::info!("[backend] AppData runtime up-to-date ({})", stamp);
        return Ok(());
    }

    log::info!(
        "[backend] bootstrapping AppData runtime → {}",
        runtime.display()
    );
    setSetupPhase(app, "copying", Some("Preparing backend files…".into()));
    let log_dir = appDataDir(app).join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let bootstrap_log = log_dir.join("backend-bootstrap.log");

    // Replace the complete runtime trees. Partial cleanup leaves stale skills,
    // metadata, or virtualenv files after an update and can mask a bad payload.
    // But a wipe blocked by a Windows lock degrades to a warning instead of an
    // error: the stale tree is harmless, while aborting here traps packaged
    // installs on the Retry gate over a tree that did nothing wrong.
    let mut wipe_warnings: Vec<String> = Vec::new();
    if let WipeOutcome::Degraded(warning) = wipeStaleTree(&runtime_backend) {
        wipe_warnings.push(warning);
    }
    let runtime_skills = runtime.join("skills");
    if let WipeOutcome::Degraded(warning) = wipeStaleTree(&runtime_skills) {
        wipe_warnings.push(warning);
    }
    std::fs::create_dir_all(&runtime_backend).map_err(|e| format!("mkdir runtime: {e}"))?;
    copyDirRecursive(&bundled_py_root, &runtime_backend, true)?;

    // Bundled skills (D16): skill_service resolves SKILLS_DIR to
    // {appData}/backend-runtime/skills — copy the staged skills tree so
    // installed builds ship the built-in skill catalog.
    std::fs::create_dir_all(&runtime_skills).map_err(|e| format!("mkdir runtime skills: {e}"))?;
    copyDirRecursive(&bundled_skills, &runtime_skills, false)?;
    log::info!(
        "[backend] bundled skills copied → {}",
        runtime_skills.display()
    );

    if !venv_py.is_file() {
        setSetupPhase(
            app,
            "creating_venv",
            Some("Creating Python environment…".into()),
        );
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
            // --upgrade: on an app update we reuse the existing AppData venv
            // but the BUNDLED wheels are the new pinned set. Without it pip
            // reports every requirement "already satisfied" and installs
            // nothing — fresh backend code then runs against stale libraries,
            // dies at import, and the supervisor reports "not healthy after
            // spawn" exactly after updates.
            "--upgrade",
            "august-proxy",
        ],
        &runtime_backend,
        &bootstrap_log,
    )?;

    // runPythonSilent recreates the bootstrap log on every invocation, so the
    // wipe warnings are only appended once the last of those runs has finished
    // — earlier they would be truncated away by the next venv/pip step.
    if !wipe_warnings.is_empty() {
        if let Ok(mut log_file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&bootstrap_log)
        {
            for warning in &wipe_warnings {
                let _ = writeln!(log_file, "WARNING: {warning}");
            }
        }
    }

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
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() == "True",
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
        env::current_dir()
            .ok()
            .map(|cwd| cwd.join("backend-py/app/main.py")),
        env::current_dir()
            .ok()
            .map(|cwd| cwd.join("../backend-py/app/main.py")),
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

fn existingAbsolutePath(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return None;
    }
    path.canonicalize().ok().filter(|path| path.is_file())
}

fn resolveNode(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("AUGUST_DESKTOP_NODE") {
        if let Some(path) = existingAbsolutePath(&path) {
            return Some(path);
        }
    }

    if let Some(node) = bundledNode(app) {
        return Some(node);
    }

    let mut candidates = Vec::new();
    for name in nodeBinaryNames() {
        candidates.push(
            app.path()
                .resolve(name, tauri::path::BaseDirectory::Resource)
                .ok(),
        );
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
            .resolve(
                "../../backend/index.js",
                tauri::path::BaseDirectory::Resource,
            )
            .ok(),
        env::current_dir()
            .ok()
            .map(|cwd| cwd.join("backend/index.js")),
        env::current_dir()
            .ok()
            .map(|cwd| cwd.join("../backend/index.js")),
        env::current_dir()
            .ok()
            .map(|cwd| cwd.join("../../backend/index.js")),
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
    if !INSTANCE_LOCK_OWNED.load(Ordering::SeqCst) {
        // A launch refused by the single-instance guard shares no backend with
        // us: killing "orphans" here would tear down the owning instance.
        log::info!("[backend] teardown skipped — not the lock owner ({reason})");
        return;
    }
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
    // The supervisor recovered (possibly after retried ports or a
    // wipe-and-reinstall) — clear the stale spawn error so the UI never shows
    // "Backend: up" alongside "Last error: … not healthy on :8085 after spawn".
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.1.lock() {
            *guard = None;
        }
    }
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
                    // The AppData backend has no checkout-relative binaries tree.
                    // Hand the firmware sidecar our bundled Node path so a clean
                    // install does not require Node on PATH. Preserve valid overrides.
                    let sidecarNode = env::var("AUGUST_NODE_EXE")
                        .ok()
                        .and_then(|path| existingAbsolutePath(&path))
                        .or_else(|| resolveNode(app));
                    if let Some(node) = sidecarNode {
                        cmd.env("AUGUST_NODE_EXE", node);
                    }
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

                // Self-heal: an installed runtime that never comes up healthy
                // must be wiped and reinstalled — a corrupted or update-skewed
                // AppData runtime would otherwise loop on 45s health timeouts
                // forever. The stamp file only advances after a healthy probe,
                // so a FAILED update keeps the OLD stamp: requiring
                // runtimeStampMatches here would skip recovery in exactly the
                // case it exists for. Any packaged install whose runtime was
                // materialized but never boots gets one clean rebuild.
                if !force_reinstall
                    && bundledStamp(app).is_some()
                    && runtimeBackendMain(app).is_file()
                {
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
        log::error!(
            "[backend] could not resolve project root for {}",
            entry.display()
        );
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
        // An explicit user Retry overrides the update/quit holdoff: a cancelled
        // or failed installer leaves holdoff on forever (stopBackend is the only
        // writer), and ensureRunning would then silently skip every respawn —
        // both here and in the watchdog — with no recovery path short of a
        // reboot. This command is the recovery door: clear it first.
        UPDATE_HOLDOFF.store(false, Ordering::SeqCst);
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

fn validateReleaseVersion(version: &str) -> Result<(), String> {
    let valid = !version.is_empty()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
        && version.split('.').count() == 3;
    if valid {
        Ok(())
    } else {
        Err(format!("invalid release version: {version}"))
    }
}

fn expectedReleaseFilename(version: &str) -> Result<String, String> {
    validateReleaseVersion(version)?;
    Ok(format!("August_{version}_x64-setup.exe"))
}

fn expectedReleaseUrl(version: &str, filename: &str) -> String {
    format!("https://github.com/{RELEASE_REPOSITORY}/releases/download/v{version}/{filename}")
}

fn verifyInstallerSignature(installer: &Path, signature_text: &str) -> Result<(), String> {
    let public_key_text = String::from_utf8(
        STANDARD
            .decode(UPDATER_PUBLIC_KEY_B64)
            .map_err(|e| format!("invalid embedded updater public key: {e}"))?,
    )
    .map_err(|e| format!("invalid embedded updater public key encoding: {e}"))?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|e| format!("invalid embedded updater public key: {e}"))?;
    let signature = decodeInstallerSignature(signature_text)?;
    let installer_bytes = std::fs::read(installer)
        .map_err(|e| format!("could not read the downloaded installer: {e}"))?;
    public_key
        .verify(&installer_bytes, &signature, true)
        .map_err(|e| format!("installer signature verification failed: {e}"))
}

/// Unwrap the `.sig` asset into something `minisign_verify::Signature::decode`
/// accepts.
///
/// Tauri signs with **one base64 line** that wraps the four-line minisign text
/// (`untrusted comment:` / signature / `trusted comment:` / signature), and
/// `Signature::decode` reads all four lines — so feeding the raw asset straight
/// in failed 100% of downloads with `InvalidEncoding` and made in-app updates
/// impossible. Tauri's own updater base64-decodes first
/// (`tauri-plugin-updater/src/updater.rs` → `verify_signature`), which is the
/// step that was missing here. Plain unwrapped minisign text is still accepted
/// so a hand-made `.sig` verifies too.
fn decodeInstallerSignature(signature_text: &str) -> Result<Signature, String> {
    let trimmed = signature_text.trim();
    let unwrapped = STANDARD
        .decode(trimmed)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok());
    if let Some(text) = unwrapped {
        if let Ok(signature) = Signature::decode(&text) {
            return Ok(signature);
        }
    }
    Signature::decode(trimmed).map_err(|e| format!("invalid installer signature: {e}"))
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
pub async fn download_release_installer(app: AppHandle, version: String) -> Result<String, String> {
    UPDATE_DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
    let filename = expectedReleaseFilename(&version)?;
    let url = expectedReleaseUrl(&version, &filename);
    let signature_url = format!("{url}.sig");
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};

        let dir = app
            .path()
            .temp_dir()
            .map_err(|e| format!("could not resolve the temp directory: {e}"))?
            .join("august-updates");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not prepare the download folder: {e}"))?;
        let dest = dir.join(&filename);
        let partial = dir.join(format!(".{filename}.part"));
        let _ = std::fs::remove_file(&partial);
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
        let mut file = File::create(&partial)
            .map_err(|e| format!("could not create {}: {e}", partial.display()))?;

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
                let _ = std::fs::remove_file(&partial);
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
        drop(file);
        emit(downloaded, total.or(Some(downloaded)));

        // A real installer is tens of MB — anything tiny is an error page.
        if downloaded < 1024 * 1024 {
            let _ = std::fs::remove_file(&partial);
            return Err("downloaded file is too small — the release asset may be missing".into());
        }

        let mut signature_resp = client
            .get(&signature_url)
            .send()
            .map_err(|e| format!("signature download failed: {e}"))?;
        if !signature_resp.status().is_success() {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "signature download failed (HTTP {})",
                signature_resp.status()
            ));
        }
        let mut signature_text = String::new();
        signature_resp
            .read_to_string(&mut signature_text)
            .map_err(|e| format!("could not read the installer signature: {e}"))?;
        if signature_text.trim().is_empty() || signature_text.len() > 1024 * 1024 {
            let _ = std::fs::remove_file(&partial);
            return Err("release signature is missing or unexpectedly large".into());
        }
        if let Err(message) = verifyInstallerSignature(&partial, signature_text.trim()) {
            // Every other error branch below already removes the partial file;
            // verification must not be the one that leaves `.part` behind.
            let _ = std::fs::remove_file(&partial);
            return Err(message);
        }

        std::fs::rename(&partial, &dest)
            .map_err(|e| format!("could not finalize the installer download: {e}"))?;
        let canonical_dest = std::fs::canonicalize(&dest)
            .map_err(|e| format!("could not resolve the installer path: {e}"))?;
        if let Ok(mut verified) = VERIFIED_INSTALLER.lock() {
            *verified = Some((canonical_dest.clone(), signature_text));
        }
        log::info!(
            "[update] verified installer downloaded → {} ({} bytes)",
            dest.display(),
            downloaded
        );
        Ok(canonical_dest.to_string_lossy().to_string())
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
    let supplied = PathBuf::from(&path);
    let installer =
        std::fs::canonicalize(&supplied).map_err(|_| format!("installer not found: {path}"))?;
    let verified = VERIFIED_INSTALLER
        .lock()
        .map_err(|_| "installer verification state is unavailable".to_string())?
        .clone();
    let Some((verified_path, signature_text)) = verified else {
        return Err("installer has not been downloaded and verified by August".into());
    };
    if installer != verified_path {
        return Err("installer path does not match the verified download".into());
    }
    verifyInstallerSignature(&installer, signature_text.trim())?;
    // Release python/.pyd locks before NSIS copies over the install dir.
    stopBackendForUpdate(&app);
    Command::new(&installer)
        .arg("/UPDATE")
        .spawn()
        .map_err(|e| format!("could not launch the installer: {e}"))?;
    log::info!(
        "[update] verified installer launched ({}) — exiting August",
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

/// Reveal a file in the OS file manager — Explorer with the file selected
/// on Windows, Finder on macOS, parent folder on Linux. Best-effort: the
/// UI falls back to opening the file directly if this errors.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        // explorer parses `/select,<path>` as one token; quote so paths
        // with spaces (and commas) select correctly.
        cmd.arg(format!("/select,\"{}\"", path.replace('"', "")));
        match cmd.spawn() {
            Ok(_) => Ok("revealed".into()),
            Err(e) => Err(format!("explorer failed: {e}")),
        }
    }
    #[cfg(target_os = "macos")]
    {
        match std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
        {
            Ok(_) => Ok("revealed".into()),
            Err(e) => Err(format!("open -R failed: {e}")),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        match std::process::Command::new("xdg-open").arg(parent).spawn() {
            Ok(_) => Ok("revealed".into()),
            Err(e) => Err(format!("xdg-open failed: {e}")),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        Err("reveal unsupported on this platform".into())
    }
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

#[cfg(all(test, windows))]
mod instance_lock_tests {
    use super::isAugustRow;

    const CSV_HEAD: &str = "\"Image Name\",\"PID\",\"Session Name\",\"Session#\",\"Mem Usage\"";

    fn row(image: &str, pid: u32) -> String {
        format!("{CSV_HEAD}\r\n\"{image}\",\"{pid}\",\"Console\",\"1\",\"123 K\"")
    }

    #[test]
    fn treats_a_recycled_non_august_pid_as_dead() {
        // The real-world lockout: the recorded PID was reused by another app.
        assert!(!isAugustRow(&row("Qoder.exe", 20528), 20528));
    }

    #[test]
    fn recognises_both_the_packaged_and_dev_image_names() {
        assert!(isAugustRow(&row("August.exe", 20528), 20528));
        assert!(isAugustRow(&row("august-desktop.exe", 20528), 20528));
    }

    #[test]
    fn requires_an_exact_pid_match_not_a_substring() {
        // tasklist output for 20528 must not satisfy a query for 2052.
        assert!(!isAugustRow(&row("August.exe", 20528), 2052));
    }

    #[test]
    fn treats_no_matching_process_as_dead() {
        assert!(!isAugustRow(
            "INFO: No tasks are running which match the specified criteria.",
            20528
        ));
    }
}

#[cfg(test)]
mod copy_payload_tests {
    use super::copyDirRecursive;
    use std::fs;
    use std::path::PathBuf;

    /// Each test gets its own scratch tree so it never touches a real payload.
    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "august-copy-test-{}-{}-{}-{}",
            std::process::id(),
            tag,
            nanos,
            SEQ.fetch_add(1, Ordering::SeqCst),
        ));
        fs::create_dir_all(&dir).expect("create scratch");
        dir
    }

    fn touch(root: &PathBuf, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdirs");
        fs::write(&path, "x").expect("write");
    }

    #[test]
    fn keeps_dependency_dist_but_drops_root_build_artifacts() {
        let src = scratch("src");
        let dst = scratch("dst");
        // The package's own setuptools output at the payload root.
        touch(&src, "dist/august_proxy.pth");
        touch(&src, "build/lib/x.py");
        touch(&src, "august_proxy.egg-info/PKG-INFO");
        // Dependency entry points live in dist/ one level deeper.
        touch(&src, "sidecar/node_modules/avr8js/dist/cjs/index.js");
        touch(&src, "sidecar/node_modules/jimp/dist/index.js");
        touch(&src, "sidecar/firmware-runner.mjs");

        copyDirRecursive(&src, &dst, true).expect("copy");

        assert!(!dst.join("dist").exists(), "root dist must be skipped");
        assert!(!dst.join("build").exists(), "root build must be skipped");
        assert!(
            !dst.join("august_proxy.egg-info").exists(),
            "root egg-info must be skipped"
        );
        assert!(
            dst.join("sidecar/node_modules/avr8js/dist/cjs/index.js")
                .is_file(),
            "dependency dist output must survive — the sidecar imports it"
        );
        assert!(dst
            .join("sidecar/node_modules/jimp/dist/index.js")
            .is_file());
        assert!(dst.join("sidecar/firmware-runner.mjs").is_file());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn still_drops_regenerable_caches_at_any_depth() {
        let src = scratch("cache-src");
        let dst = scratch("cache-dst");
        touch(&src, "app/__pycache__/mod.pyc");
        touch(&src, "app/services/__pycache__/deep.pyc");
        touch(&src, "app/main.py");

        copyDirRecursive(&src, &dst, true).expect("copy");

        assert!(!dst.join("app/__pycache__").exists());
        assert!(!dst.join("app/services/__pycache__").exists());
        assert!(dst.join("app/main.py").is_file());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}

#[cfg(test)]
mod wipe_stale_tree_tests {
    use super::{copyDirRecursive, wipeStaleTreeWith, WipeOutcome};
    use std::cell::Cell;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    /// Each test gets its own scratch tree so it never touches a real payload.
    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "august-wipe-test-{}-{}-{}-{}",
            std::process::id(),
            tag,
            nanos,
            SEQ.fetch_add(1, Ordering::SeqCst),
        ));
        fs::create_dir_all(&dir).expect("create scratch");
        dir
    }

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdirs");
        fs::write(&path, "x").expect("write");
    }

    /// The Windows lock this whole path exists for: deletion of a tree with a
    /// file held open (AV scan, lingering python.exe) raises PermissionError
    /// on every attempt.
    fn permission_denied(_: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "file locked by another process",
        ))
    }

    /// Sibling path that `wipeStaleTree` renames a blocked tree into.
    fn asidePath(tree: &Path) -> PathBuf {
        tree.with_file_name(format!(
            "{}.old",
            tree.file_name().unwrap().to_string_lossy()
        ))
    }

    /// Regression: a removal that keeps failing must degrade to a warning and
    /// let bootstrap continue — never raise into the hard Retry error gate.
    /// Rename is the fallback that usually succeeds (Windows blocks deletion,
    /// not directory renames), so this covers the clean-path outcome too: the
    /// stale venv moves aside and the fresh tree carries none, i.e. it is
    /// rebuilt exactly as a normal wipe would rebuild it.
    #[test]
    fn blocked_removal_renames_aside_with_warning_and_boot_continues() {
        let stale = scratch("stale");
        touch(&stale, ".venv/Scripts/python.exe");
        touch(&stale, "app/main.py");
        let fresh = scratch("fresh");
        touch(&fresh, "app/main.py");

        let attempts = Cell::new(0u32);
        let outcome = wipeStaleTreeWith(
            &stale,
            |p| {
                attempts.set(attempts.get() + 1);
                permission_denied(p)
            },
            |from, to| fs::rename(from, to),
            3,
            0, // no sleeping in tests
        );

        let warning = match outcome {
            WipeOutcome::Degraded(w) => w,
            WipeOutcome::Clean => panic!("a blocked wipe must not report Clean"),
        };
        assert!(
            warning.contains(".old"),
            "warning names the leftover: {warning}"
        );
        assert_eq!(attempts.get(), 4, "retries before any fallback");

        assert!(!stale.exists(), "stale tree moved aside");
        assert!(asidePath(&stale).join(".venv/Scripts/python.exe").is_file());
        // What bootstrapBundledBackend does next: mkdir + copy over a clean
        // path, with no stale venv left to be reused.
        fs::create_dir_all(&stale).expect("recreate runtime dir");
        copyDirRecursive(&fresh, &stale, true).expect("boot continues");
        assert!(stale.join("app/main.py").is_file());
        assert!(!stale.join(".venv").exists(), "venv gets rebuilt");

        let _ = fs::remove_dir_all(&stale);
        let _ = fs::remove_dir_all(&asidePath(&stale));
        let _ = fs::remove_dir_all(&fresh);
    }

    /// When even the rename is blocked, the stale tree stays where it is and
    /// boot still continues over it — degraded, but running.
    #[test]
    fn blocked_removal_and_rename_leave_tree_in_place_and_boot_continues() {
        let stale = scratch("locked");
        touch(&stale, ".venv/Scripts/python.exe");
        touch(&stale, "app/old.py");
        let fresh = scratch("fresh2");
        touch(&fresh, "app/main.py");

        let outcome = wipeStaleTreeWith(
            &stale,
            |_| -> io::Result<()> { permission_denied(&stale) },
            |_, _| -> io::Result<()> { permission_denied(&stale) },
            3,
            0,
        );

        let warning = match outcome {
            WipeOutcome::Degraded(w) => w,
            WipeOutcome::Clean => panic!("a blocked wipe must not report Clean"),
        };
        assert!(
            warning.contains("left in place"),
            "warning states the tree survives: {warning}"
        );
        assert!(stale.join(".venv/Scripts/python.exe").is_file());
        // Bootstrap's copy merges the fresh sources over the stale tree and
        // the pip --upgrade step then repairs the venv in place.
        copyDirRecursive(&fresh, &stale, true).expect("boot continues");
        assert!(stale.join("app/main.py").is_file());
        assert!(stale.join("app/old.py").is_file());

        let _ = fs::remove_dir_all(&stale);
        let _ = fs::remove_dir_all(&fresh);
    }

    /// The semantics the fallback must NOT weaken: as long as removal works,
    /// the wipe is a plain clean wipe and no rename ever runs.
    #[test]
    fn healthy_removal_still_yields_a_clean_tree() {
        let tree = scratch("healthy");
        touch(&tree, ".venv/Scripts/python.exe");

        let outcome = wipeStaleTreeWith(
            &tree,
            |p| fs::remove_dir_all(p),
            |_, _| -> io::Result<()> { panic!("rename must not run when removal works") },
            3,
            0,
        );
        assert!(matches!(outcome, WipeOutcome::Clean));
        assert!(!tree.exists(), "normal run still ends with a fresh tree");

        // An absent tree is trivially clean and never touches the fs ops.
        let missing = tree.join("never-created");
        let outcome = wipeStaleTreeWith(
            &missing,
            |_| -> io::Result<()> { panic!("no removal attempt on an absent tree") },
            |_, _| -> io::Result<()> { panic!("no rename on an absent tree") },
            3,
            0,
        );
        assert!(matches!(outcome, WipeOutcome::Clean));
    }
}

#[cfg(test)]
mod update_signature_tests {
    use super::{decodeInstallerSignature, STANDARD};
    use base64::Engine;

    /// The four-line minisign text `Signature::decode` is built for: bin1 is
    /// algorithm (2) + key id (8) + signature (64) = 74 bytes, bin2 is the
    /// 64-byte global signature — the exact lengths `decode` enforces.
    fn minisignText() -> String {
        let bin1 = [b"Ed".as_slice(), &[7u8; 8], &[9u8; 64]].concat();
        let bin2 = [3u8; 64];
        format!(
            "untrusted comment: signature from tauri secret key\n{}\n\
             trusted comment: timestamp:1757800000\tfile:August_0.18.11_x64-setup.exe\n{}",
            STANDARD.encode(bin1),
            STANDARD.encode(bin2),
        )
    }

    #[test]
    fn the_sig_asset_is_one_base64_line_wrapping_the_minisign_text() {
        // The shape of the asset on disk (420 chars, no newline).
        let asset = STANDARD.encode(minisignText());
        assert!(!asset.contains('\n'), "Tauri's .sig asset is a single line");
        assert!(
            decodeInstallerSignature(&asset).is_ok(),
            "the shipped asset must decode to a signature"
        );
    }

    #[test]
    fn the_base64_step_is_what_the_update_path_was_missing() {
        let asset = STANDARD.encode(minisignText());
        assert!(
            minisign_verify::Signature::decode(&asset).is_err(),
            "pinned: the raw asset fed to Signature::decode fails (it reads lines 2 \
             and 4 of a single-line file) — base64 must be stripped first"
        );
    }

    #[test]
    fn plain_minisign_text_is_still_accepted() {
        assert!(decodeInstallerSignature(&minisignText()).is_ok());
        assert!(decodeInstallerSignature(&format!("{}\n", minisignText())).is_ok());
    }

    #[test]
    fn something_that_is_not_a_signature_is_refused() {
        assert!(decodeInstallerSignature("").is_err());
        assert!(decodeInstallerSignature("not a signature at all").is_err());
        assert!(decodeInstallerSignature(&STANDARD.encode(b"junk")).is_err());
    }
}
