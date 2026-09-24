# August App Lifecycle Audit

**Date:** 2026-09-24
**Scope:** launch → run → supervise → close → update → relaunch for the shipped product, the Tauri desktop app (`frontend/desktop/src-tauri/`, Rust) plus the bundled FastAPI backend (`backend-py/`), its installer templates, and the release/version tooling.
**Method:** read-only source review. Nothing was built, installed, or run; the test suite was not executed; no existing file was modified. Every claim carries `file:line` evidence.
**Note on WIP:** the working tree carries uncommitted user changes, including `frontend/desktop/src-tauri/src/backend.rs`. Line numbers in this report refer to the **current working tree**, not to `HEAD`. Findings that depend on a WIP edit are marked **[WIP]**.

---

## 0. Executive summary

The desktop shell is unusually well-defended for a local-first app: identity-checked health probing, a real single-instance lock with recycled-PID handling, a port fallback sweep, a content-hash stamp that forces a backend re-bootstrap when the bundled payload changes, a self-healing watchdog, and an installer that never silently runs a stale backend. The architecture is sound.

The failures are concentrated in three places:

1. **Quit is a hard kill, not a shutdown.** `taskkill /F` means the FastAPI lifespan teardown — the code that explicitly exists to flush debounced session saves, deferred DB commits and the SSE event log — never executes on a normal Quit. Every one of those flushes is dead code on the desktop path.
2. **Observability is missing where it matters.** The Rust crate depends on `log` and makes 45 `log::*` calls, but **no logger is ever installed**, so every one of them is discarded. The child process's own stdout is the only trace, and the supervisor truncates that file on every respawn.
3. **A hard kill of `August.exe` + an upgrade can leave the new UI talking to the old, orphaned backend indefinitely** — and then stamp the AppData runtime as current, poisoning every subsequent launch.

---

## 1. Launch

### 1.1 Startup sequence — SOLID

- `main.rs:4-6` calls `august_desktop_lib::run()`; `lib.rs:35-40` claims the AUMID `com.august.proxy` **before** any window exists so WebView2 children group under the August node in Task Manager. This is the right order.
- `lib.rs:42-47` registers the five plugins; `lib.rs:48-108` is the setup closure. Order inside setup is deliberate and correct: acquire the instance lock **first** (`lib.rs:53-56`), and on refusal `exit(0)` before any managed state or window work.
- Supervisor state is registered **even when the first spawn will fail** (`lib.rs:58-68`), so `restart_proxy` has a target. The comment at `lib.rs:58` is accurate.
- The backend start is pushed to a worker thread (`lib.rs:82-85`) so the webview paints immediately; the main thread only does the WebView2 context-menu hardening (`lib.rs:96-105`).

### 1.2 Health/readiness gating — SOLID (with one hard timing defect)

- The health probe is **identity-checked**, not just "any 2xx": `healthOkOnPort` requires `status == "ok"` **and** `python == true` (`backend.rs:1241-1257`), which is what the desktop comment at `backend.rs:1235-1240` claims. A foreign service on 8085 cannot be mistaken for August.
- The UI is genuinely gated. `BackendBootstrapGate` does not mount `children` until `proxyUp && convDone` (`BackendBootstrapGate.tsx:152-154`), so the user never lands in a dead UI.
- Failure is visible, not silent: `setup.phase === 'error'` renders a **"Backend setup failed"** card with the last error, common fixes, and a Retry button that calls `restart_proxy` + `sync_backend_deps` (`BackendBootstrapGate.tsx:183-219`, `128-143`). `markProxyPort` clears the stale error on recovery (`backend.rs:1307-1311`) so "up" never sits next to a stale error.
- A single 8s nudge asks the supervisor to restart once (`BackendBootstrapGate.tsx:86-104`) without racing the Rust startup thread — and the comment at `84-85` records exactly the double-console bug it avoids.

- **DEFECT (P1) — the 45 s per-port health budget covers the entire Python boot, and uvicorn binds only after `lifespan` startup completes.** `waitForProxy(app, port, Duration::from_secs(45))` (`backend.rs:1465`) is the whole allowance. But the `/api/health` route cannot answer until every `lifespan` startup step has run (`backend-py/app/main.py:114-253`): logging, builtin+user hooks, health monitor, `settings.reload()`, OAuth env mirror, log hub, `tool_definitions.registerAll()`, `brain_backup.apply_pending_restore()`, `memory_store.init()` (**full schema + migrations**), `migrate_storage_keys`, bot roster, `start_cognitive_services`, `startGateway`, orchestrator, learning scheduler. On a cold machine, a large brain DB, or an AV scan, that can exceed 45 s — and the supervisor then kills a perfectly healthy backend and moves to the next port.
  - **Amplifier:** a port conflict is only discovered at *bind* time, which uvicorn reaches **after** the whole boot. So each of the 11 candidate ports pays a full Python boot before the bind fails. `storedChildAlive` (`backend.rs:1266-1278`) bails early only for instant spawn failures, not for a post-boot bind error.
  - **Worst case:** 11 × (full boot + 45 s) ≈ 8 minutes of visible thrash, after which `force_reinstall` (`backend.rs:1499-1511`) wipes the AppData runtime and re-runs `pip install` from the 119 MB wheel set — turning a transient port conflict or a slow disk into a multi-minute reinstall.
  - **Fix:** raise the per-port budget substantially, and/or make uvicorn bind before `lifespan` (`--lifespan on` with an early `/api/health`, or a tiny always-on startup route registered outside the lifespan gate), and/or surface a "still starting" progress line from the child. The supervisor should also stop escalating to a destructive reinstall when the failure is "port busy", not "code is broken".
  - **Effort M, risk M** (touching the boot ordering touches readiness for every caller).

### 1.3 Port selection — SOLID

- `portCandidates()` returns `8085..=8095` unless `AUGUST_PROXY_PORT` is set, in which case the override is the *only* candidate and disables the sweep (`backend.rs:111-117`, `95-99`).
- `ACTIVE_PROXY_PORT` is the single source of truth reported to the UI and used by the orphan sweep (`backend.rs:40`, `105-107`), and is written only on a verified health pass (`markProxyPort`, `backend.rs:1302-1303`).
- The frontend never guesses 8085. `initBaseUrl` polls `proxy_status` up to 120 times with capped linear backoff and only then patches fetch (`api/client.ts:53-79`). The comment at `57-60` names the exact failure it prevents.

### 1.4 Splash / loading state — SOLID, minor gap

- `LaunchConversation` is driven by the same `SetupPhase` stream the Rust side emits (`backend.rs:75-91`), polled at 750 ms and event-pushed (`useBackendSetup.ts:48-75`).
- Degradation is time-based: 10 s → "taking longer than usual", 30 s → "much longer than expected" with a fix list (`BackendBootstrapGate.tsx:121-126`, `200-210`).
- **Weakness (P2): the native window is created visible** (`tauri.conf.json:12-25` has no `"visible": false`). The React overlay is the only splash. If `web-dist` fails to load or the JS bundle throws before mount, the user gets an empty dark window with no explanation rather than a splash. A `visible: false` window shown on first `backend-setup`/`ready` event (or on webview `DOMContentLoaded`) would close this. **Effort S, risk S.**

### 1.5 Bundled-runtime bootstrap — SOLID

- First launch / stamp mismatch copies `backend-py` + bundled skills into `{appData}/backend-runtime` and builds a venv from the portable Python with an **offline** `pip install --no-index --find-links wheels --upgrade august-proxy` (`backend.rs:607-767`). The `--upgrade` and the offline/binary-only posture are the correct calls for reusing a venv across an app update.
- **The runtime stamp is deliberately not written on pip success** — only after the first identity-checked health probe (`backend.rs:762-765`, `1312-1319`). A broken wheel set therefore cannot stamp itself healthy forever. This is a genuinely good invariant and is exactly the right defence against "UI upgraded, backend stale".
- `runtimePayloadComplete` / `bundledPayloadComplete` (`backend.rs:310-379`) verify the whole payload, not just the stamp. A stamp alone never declares health.
- Wipe failures degrade to a warning instead of trapping the user on a Retry gate, with a rename-aside fallback for Windows file locks (`wipeStaleTree`, `backend.rs:540-603`, and the four unit tests at `2430-2594`). The degraded message names exactly what was left behind. Good.
- **Weakness (P2): every version bump destroys and rebuilds the venv.** `wipeStaleTree(&runtime_backend)` removes `backend-py` *including* `.venv` (`backend.rs:685`, and `copyDirRecursive` skips `.venv` on the way back in at `454-455`), so the `if !venv_py.is_file()` guard at `705` can only ever be false on a stamp mismatch. The result is a guaranteed multi-minute cold path (37 MB tree + venv creation + 119 MB offline wheel install) on **every** update, not just first launch. Preserving the venv across a stamp change (the pip `--upgrade` step is already written to handle that — see the comment at `734-740`) would cut update boot to seconds. **Effort M, risk M** (a preserved venv is exactly the update-skew failure the current code is defending against, so this needs the force-reinstall path kept intact as the escape hatch).

---

## 2. Backend supervision

### 2.1 The watchdog — SOLID

- `watchBackend` (`backend.rs:1621-1660`) is a genuine supervisor: 3 s poll, `reclaimDeadChild`, identity-checked health, exponential backoff to a 30 s ceiling on repeated failure, and it deliberately stands down while the setup phase is `copying`/`creating_venv`/`installing`/`updating` or the update holdoff is set (`1632-1645`).
- `setSetupPhase(app, "starting", "Restarting backend…")` at `1648` means the UI *is* told — but see 2.4.
- `reclaimDeadChild` (`1158-1176`) drops the dead handle rather than leaking zombies, and `storeChild` (`1190-1212`) refuses to store a child spawned during a teardown, killing it instead. That closes the "respawn races the quit" window properly.

### 2.2 stdio and logs — WEAKNESS

- Child stdout/stderr go to `{appData}/data/logs/backend.log` (`backend.rs:1397-1400`, `1412`, `1431-1434`). Correct location, and `applyNoWindow` (`backend.rs:1109-1115`) suppresses the console window flash.
- **DEFECT (P1) — every supervisor log line is discarded.** `backend.rs` makes 45 `log::info!` / `warn!` / `error!` calls. `Cargo.toml:29` depends on `log = "0.4"`, but **no logger is ever installed** — there is no `tauri-plugin-log` in `Cargo.toml:16-30`, no `env_logger`, no `impl log::Log`, and tauri 2.11.2 core installs none either. The `log` facade with no logger set is a silent no-op. So the single-instance refusal (`backend.rs:259-262`), every supervisor warning, every spawn failure, and the orphan-sweep exit code (`backend.rs:1082-1083`) all vanish. The comment at `lib.rs:50` ("The guard logs and exits") describes behaviour that does not happen. **Fix:** add `tauri-plugin-log` (or a 15-line file logger) writing to `{appData}/data/logs/desktop.log` with rotation. **Effort S, risk S.**
- **DEFECT (P2) — `backend.log` is truncated on every respawn.** `File::create(&logPath)` (`backend.rs:1412`, and again at `1558` for the Node path) truncates. So the moment the watchdog restarts a crashed backend — precisely when you need the crash output — the previous run's log is gone. Use `OpenOptions::new().append(true)`, or rotate to `backend.<n>.log` per spawn. **Effort S, risk S.** (`runPythonSilent` has the same truncate-per-call shape at `backend.rs:490`; the code already documents the consequence for the wipe warnings at `747-749`.)

### 2.3 Orphan / zombie risk on Windows — MOSTLY SOLID, one hole

- Teardown is layered: `taskkill /PID /T /F` on the stored child (`backend.rs:946-952`), a 5 s reaper loop that waits for the OS so `.pyd` handles are released before NSIS copies (`957-971`), then a PowerShell sweep scoped to August-marked python/node and August-marked port owners (`killAugustPythonOrphans`, `1022-1086`). The scoping is the important part — it will not kill a dev server that happens to hold 8085 (`1028-1030`).
- The sweep runs twice with a 500 ms gap and the teardown adds a further 400 ms settle (`backend.rs:1061-1062`, `1012`) before the installer runs. That is well-tuned for the `.pyd` lock problem the comments describe.
- The single-instance guard's teardown skip is correct and subtle: a launch refused by the guard must not sweep "orphans", or it would kill the *first* instance's uvicorn (`backend.rs:45-49`, `992-997`). This is the exact bug the guard exists to prevent, and it is defended.
- The recycled-PID hazard is handled properly: `processAlive` requires both an exact PID match and an August image name via `tasklist /FO CSV` parsing (`backend.rs:202-245`), with four unit tests pinning it (`2306-2341`). "Unanswerable is treated as not alive" (`213-214`) is the right bias.

- **DEFECT (P1) — a force-killed `August.exe` can leave an orphan that the next launch adopts as its own healthy backend, and then stamps the runtime as current.** Sequence:
  1. User (or an over-eager tool) force-kills `August.exe`. The Python child is never reaped — nothing runs the sweep, because the sweep only runs from `stopBackend` (`backend.rs:991-1014`) or from the NSIS pre-install hook. The orphan keeps serving 8085.
  2. The user upgrades and relaunches. `ensureRunningLocked` sees `isProxyUp()` true at `1343`, compares the stamp at `1344`, sees a mismatch, logs a warning, and calls `killStoredChild` at `1354` — **which is a no-op, because the healthy process is an orphan we never spawned and therefore never stored.**
  3. The new child is spawned on 8085, `waitForProxy` polls, and the **old** process answers `status:ok / python:true` within 250 ms (`1286-1288`), so the supervisor declares victory at `1465-1469`.
  4. `markProxyPort` then **writes the new bundled stamp over the runtime stamp** (`1312-1319`) even though the process serving that port is running the old code. Every subsequent launch now matches, so the AppData runtime is never re-bootstrapped again.
  - Net effect: **new UI, old backend, permanently**, with the stamp asserting the opposite. This is precisely the "UI upgraded, bundled backend stale" failure the stamp mechanism was built to prevent, and it defeats it.
  - **Fix:** when the stamp is stale and the proxy is up, identify the PID owning the port and kill it (or refuse to adopt a proxy whose `/api/health` `version` does not match the bundled manifest) instead of calling the stored-child killer. Guard the stamp write so it cannot advance while the serving process predates it.
  - **Effort M, risk M** (killing by port owner must keep the August-marker scoping or it becomes a data-loss/collateral-damage bug).

### 2.4 Crash-while-running UX — DEFECT (P1)

- A mid-session backend crash is **invisible**. `watchBackend` sets the setup phase to `starting` / "Restarting backend…" (`backend.rs:1648`), but `BackendBootstrapGate` only re-gates when `failed || materializing || !unlocked` (`BackendBootstrapGate.tsx:152`). Once `unlocked` is true in `sessionStorage` (`17`, `51`), a crash does **not** re-show anything — the gate is open, `gated` is false, and `children` render. There is no global offline/banner anywhere in `components/` (searched).
- So the user sees a fully normal UI whose every request is failing, for 3–30 s, with no explanation. The only signal is the phase field nothing renders.
- **Fix:** a small global banner bound to `backend-setup` phase `starting` + `proxy_status` down, with a Retry affordance. **Effort S, risk S.**

### 2.5 Shutdown flush — DEFECT (P0)

- **The FastAPI lifespan teardown never runs on a normal desktop Quit.** `lifespan`'s post-`yield` block (`backend-py/app/main.py:254-332`) does a great deal of deliberate durability work, each in its own guarded `try`:
  - cancel the learning scheduler (`255-259`)
  - tear down the log hub and root handler (`261-268`)
  - `stop_cognitive_services()` (`269-274`) and `shutdown_runtime_services()` (`275-280`)
  - `flush_pending_saves()` — explicitly "the daemon timer dies with the process, so edits inside the debounce window would be lost (audit finding)" (`281-289`)
  - `flush_thread_pending()` — explicitly "turn outcomes / lifecycle / internal_state inside the ≤2s window would otherwise be lost on shutdown" (`290-298`)
  - `event_log.flush(timeout=10.0)` — "buffered SSE events would otherwise be lost to restart-replay" (`299-306`)
  - gateway stop, browser sessions close, daemon shutdown (`307-323`)
  - `save_sessions_now()` — "a quit landing inside the 150ms window would otherwise lose the last turn's messages, and the user's chat history must survive every restart" (`324-332`)
- **And none of it executes.** Quit goes `QuitConfirmModal` → `confirm_quit` (`QuitConfirmModal.tsx:79`) → `stopBackendOnQuit` (`lib.rs:24`) → `stopBackend` → `killChild` → **`taskkill /PID <pid> /T /F`** (`backend.rs:948-951`). `/F` is `TerminateProcess`: no signal, no chance for uvicorn to run lifespan shutdown. The non-Windows branch is `child.kill()` (`954-956`), which is `SIGKILL` — identical outcome. There is no `/api/shutdown` endpoint and no `CTRL_BREAK_EVENT` anywhere in the tree (searched).
- **Concrete loss on every single Quit:**
  - `deferred_writes` holds commits for up to `WINDOW_S = 2.0` s and at most `_MAX_HOLD_S = 10.0` s (`backend-py/app/services/deferred_writes.py:35,37`). Callers include `turn_outcomes` (`turn_outcomes.py:257`) — the per-turn verdict ledger, migration 046 — plus `automation_memory`, `memory_store/kv.set_internal_state`, and `memory_store/rest`. A quit inside that window silently loses the last turn's `turn_end` row and any internal-state bookkeeping.
  - The workbench session snapshot save is debounced by `_SAVE_DEBOUNCE_S = 0.15` (`workbench/sessions.py:602`), so `flush_pending_saves` matters.
  - The SSE `event_log` persistence queue is off-thread with a bounded buffer (`event_log.py:19`); unflushed entries are lost from restart-replay.
- **What survives, and why this is survivable but not correct:** the chat transcript is protected by a separate, synchronous, fail-closed durability barrier. `flush_session_barrier` (`workbench/durability.py:69-100`) sets `turnOpen = True` and calls `save_workbench_session_sot` — an immediate write — at three barriers (model dispatch, before a top-level tool side effect, and at each step boundary; `durability.py:3-8`). On relaunch, `WorkbenchSession.fromDict` sees `turnOpen` and closes the orphaned turn with a synthetic `[interrupted]` user marker without truncating the transcript (`workbench/sessions.py:205-228`). WAL + default `synchronous=FULL` (`memory_conn.py:38-52`) means committed barriers survive even a power cut. So **conversation content is safe and recovery is graceful.** What is lost is telemetry, internal state, the event-log tail, and anything the debounce/defer windows were holding.
- **Fix:** before killing, have the child shut down gracefully.
  - Cheapest: add a `POST /api/shutdown` (or a `shutdown_backend` Tauri command that GETs a local endpoint) which returns 200 and then triggers uvicorn's own exit; Rust then escalates to `taskkill /F` after a bounded grace period (2–5 s).
  - Or: spawn the child in a new process group and `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`, which uvicorn handles as a shutdown signal; fall back to `/F` on timeout.
  - Or: drop `defer_commit` and the debounced session save on the desktop data path (cost: write amplification).
  - **Effort M, risk M** (a new local HTTP shutdown endpoint is a security surface — it must sit behind the existing `TrustedOriginGuard` and refuse non-loopback callers, like every other mutating route).

---

## 3. Closing

### 3.1 Close vs quit — SOLID

- Window X and Alt+F4 do **not** close. `on_window_event` intercepts `CloseRequested`, calls `api.prevent_close()`, re-shows, focuses, and emits `quit-requested` (`lib.rs:109-118`). Close-to-tray exists **only** as an explicit tray item (`tray.rs:25-29`); the comment at `lib.rs:110-111` is accurate.
- Tray Quit shows and focuses the window before emitting the same event (`tray.rs:30-38`), so the confirm modal is always visible. Left-click on the tray also shows/focuses (`tray.rs:41-53`).
- AUMID taskbar identity and a right-click-free webview are both set up (`lib.rs:35-40`, `96-105`), matching the "custom AUMID, no context menu" product note.

### 3.2 "Are you sure" on active turns — SOLID, with a coverage caveat

- `QuitConfirmModal` merges both the sessions store and the active-chat-streams store and looks up status under **both** the local id and the `wb_*` workbench id, specifically so background work is not missed (`QuitConfirmModal.tsx:30-41`). The comment at `36-37` records the audit finding that motivated it.
- The copy is honest when a turn is live: "Stopping now will cancel the current task." (`QuitConfirmModal.tsx:108`) and the modal lists the named sessions (`112-126`). Escape cancels (`60-67`).
- The modal is mounted **outside** the bootstrap gate (`App.tsx:110-114`), with a comment explaining exactly why: a backend that never started must still leave the user a way to close the window. That is a real, correctly-solved edge case.
- **Weakness (P2): the active-turn list is frontend state, so it is only as good as the realtime bridge.** The detection reads `useActiveChatStreamsStore` and `sessions.sessionStates`, which are fed by the SSE bridge. A turn that started before a bridge reconnect, or a backend-started auto-turn on a non-chat route, is only covered because of the app-global resync registered in `App.tsx:44-46`. The window between "backend began a turn" and "the bridge told the webview" is a real but small gap; the backend's own `turnOpen` flag is not consulted. **Effort M, risk S.**

### 3.3 Cancellation of in-flight turns — BY FORCE, NOT BY PROTOCOL

- Quit does not send a cancel to the workbench. `confirm_quit` → `stopBackendOnQuit` → `taskkill /F`. The in-process cancel path exists (`_isCancelled()` → `turnEndReason = 'interrupted'`, `workbench.py:3766-3768`) and is what produces a clean `turn_end` event, but the desktop never uses it on quit.
- Consequence: no `turn_end {reason:'interrupted'}` row, no `turn_outcomes` row (deferred anyway, see 2.5), and the transcript is recovered via the `turnOpen` barrier instead. The user-visible outcome is acceptable ("[interrupted] The previous turn was interrupted…"), but the telemetry ledger under-reports every force-quit.
- **Improvement (P1, cheap):** add a `cancel_all_turns` Tauri command (or an endpoint) that the quit handler awaits *before* killing, with a short timeout, falling back to the hard kill. This makes the telemetry honest and lets the loop write its own closure.

### 3.4 Data-loss window on force-close

| Window | Mechanism | Survives `taskkill /F`? |
|---|---|---|
| Chat transcript | synchronous durability barriers (`durability.py:69-100`), WAL + `synchronous=FULL` (`memory_conn.py:52`) | **Yes** |
| Turn-end / lifecycle / internal_state rows | `defer_commit`, 2–10 s hold (`deferred_writes.py:35,37`) | **No** |
| Last ≤150 ms of session snapshot | debounced save (`sessions.py:602`) | **No** |
| SSE event-log tail | off-thread queue (`event_log.py:19`) | **No** |
| Memory facts / durable memory | committed SQLite writes | **Yes** |
| Tool side effects on disk | already applied; never rolled back | n/a (inherent) |

- **The DB-close ordering question has a clean answer:** there is no DB close to order. `memory_store.close()` closes only a thread-local connection (`memory_conn.py:126-133`), and nothing in the lifespan teardown calls it. A hard kill is safe *because* WAL is crash-tolerant and the schema is idempotent (`memory_schema.ensure_schema` is a warm-path no-op when `user_version` matches — `memory_schema.py:556-620`).
- **The P0 is not lost bytes; it is that the code which was written to prevent lost bytes never runs.** See 2.5.

---

## 4. Updating

### 4.1 Update flow — SOLID, with a dead safety net

- Windows deliberately does **not** use Tauri's in-place patch updater. It downloads the real NSIS setup from the release and runs it with `/UPDATE` (`useAppUpdate.ts:110-118`, `backend.rs:2036-2084`). The comment at `backend.rs:1893-1897` states the reason: a full installer guarantees bundled backend changes always land. This is the right call for this product and matches the `AGENTS.md` rule that a desktop release must carry backend changes.
- **Signature verification is real and layered.** The download is streamed to a `.part`, size-checked (`<1 MB` is rejected as a probable error page, `backend.rs:1980-1983`), the `.sig` is fetched, decoded through the base64-wrapper path that Tauri's own asset uses (`decodeInstallerSignature`, `1876-1888`, with four unit tests at `2683-2734`), and verified against an embedded minisign public key (`verifyInstallerSignature`, `1848-1863`; key at `backend.rs:28`).
- **The launch door re-verifies, it does not trust memory.** `launch_installer_and_exit` canonicalises the path, requires it to equal the recorded `VERIFIED_INSTALLER` path, and **re-runs `verifyInstallerSignature` a second time** before spawning (`backend.rs:2055-2069`). A swapped file on disk between download and launch is refused. This is exactly right.
- The updater public key in `tauri.conf.json:58` and the embedded copy in `backend.rs:28` are the same key; the base64 payload decodes to an "untrusted comment" public key.
- `.part` files are removed on every error branch including verification (`2006-2008`), and cancel is honoured mid-stream (`1957-1960`, `2030-2034`).

- **Weakness (P2): `schedule_post_update_relaunch` is never called on Windows.** The function exists to arm a detached PowerShell waiter that polls for the NSIS completion marker (`backend.rs:1729-1816`), and `useAppUpdate.ts:122` calls it only on the **non-Windows** branch. The Windows branch (`110-118`) goes straight to `launch_installer_and_exit`. The waiter therefore only ever matters for macOS/Linux, where the comment at `backend.rs:1732-1738` describes a Windows problem. In practice the non-silent NSIS POSTINSTALL does the relaunch, so the net behaviour is correct — but the documented safety net is not armed, and if `ExecShell` fails the user is never relaunched and nothing waits.
- **Weakness (P2): POSTINSTALL's relaunch and the (non-Windows) waiter can both fire.** The single-instance lock absorbs the second launch (`lib.rs:53-56`), so the outcome is safe, but the reliance is implicit.
- **Weakness (P2): the silent-install relaunch path is broken but currently unreachable.** `hooks.nsh:129` (`IfSilent 0 august_postinstall_skip`) skips both the marker write and the relaunch for silent installs. The waiter's 180 s loop only relaunches early when the marker exists, so a silent install would wait out the full 3 minutes before the deadline branch fires. Nothing on Windows takes that path today (`tauri.conf.json:63` sets updater `installMode: "quiet"`, but the Windows UI never calls the native updater), so this is a latent trap for whoever wires it up. **Effort S, risk S** — either write the marker before the `IfSilent` or shorten the deadline.

### 4.2 Bundling and stamping — SOLID

- `prepare-desktop-backend.mjs --release` stages the portable CPython (pinned version **and** SHA-256, `54-60`, verified on every reuse, `198-208`), builds wheels from the frozen `uv export --require-hashes --only-binary=:all:` graph (`300-325`), builds the project wheel in a pinned isolated build env (`327-345`), and writes a runtime manifest carrying the source SHA, branch, and dirty flag (`357-391`). Release mode **fails closed** without git provenance (`368-370`).
- The release stamp is a content hash over the Python version/build, the **entire staged payload** (backend, skills, wheels, portable Python, canonical manifest — including the `npm ci`-installed sidecar `node_modules`), and the package version (`392-407`). That is a real content stamp, not a build counter: a dev-mode `prepare` writes `dev-placeholder` instead, which `bundledStamp` filters out (`backend.rs:283-288`) so a dev checkout is never flipped into packaged mode. Excellent boundary discipline.
- The Rust side honours it end to end: stamp mismatch re-bootstraps even when the proxy is already healthy (`backend.rs:1343-1355`), the stamp is only written after a verified health probe (`1312-1319`), and a stamped-but-never-healthy runtime gets exactly one clean wipe-and-reinstall (`1499-1511`). The comment at `1494-1498` correctly explains why `runtimeStampMatches` is deliberately *not* the gate there.
- The one hole in this whole chain is 2.3 (an adopted orphan lets a stale process stamp itself current).

### 4.3 Version sync — SOLID

- All 8 sources currently agree at `0.18.11` (verified by reading each: `package.json`, `frontend/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` `august-desktop` entry, and the three `package-lock.json` sites).
- `check-version-sync.mjs` checks exactly those 8, and compares against the **majority** version rather than the first file found, so one stray file is not treated as correct (`check-version-sync.mjs:88-96`, and the rationale at `9-12`). A parse error is a hard failure, not a skip (`82-85`).
- The release script runs the check **before and after** mutating versions (`release-desktop.mjs:272`, `310`), updates all 8 including both lockfile sites (`271-312`), and throws if the `Cargo.toml` or `Cargo.lock` regex fails to match rather than silently skipping a source (`291`, `307`).
- **Weakness (P2): nothing runs the check in CI on a normal PR.** It is wired to `npm run check:version` and invoked by the release script, but a UI-only PR that forgets to bump would only be caught at release time — after the commit is tagged. A cheap CI job calling `scripts/check-version-sync.mjs` on changed desktop files would move it left. **Effort S, risk S.**

### 4.4 Update-failure recovery — SOLID

- If the installer is cancelled or fails, the app exits and the next launch reconciles: a stamp mismatch or a non-healthy runtime triggers the wipe-and-reinstall path (`1499-1511`), and the bootstrap log carries any degraded wipe warnings forward (`750-760`).
- The trap the old code had — a cancelled install leaving `UPDATE_HOLDOFF` on forever with every respawn silently skipped — has an explicit recovery door: `restart_proxy` clears the holdoff first, and the comment at `backend.rs:1702-1707` says so. Good self-correction.

---

## 5. Single-instance, multi-window, recovery

### 5.1 Second launch — DEFECT (P1)

- The guard is a lock file holding the owner PID, with a live-and-August-owned liveness probe (`acquireInstanceLock`, `backend.rs:249-270`). A crashed instance's lock is reclaimed (`256-266`), and `create_dir_all` on the parent means a fresh install does not silently no-op the guard (`251-255`) — a subtle failure that is explicitly handled.
- **But a refused second launch exits completely silently** (`lib.rs:53-56`). The user double-clicks the shortcut while August is already running to the taskbar or tray, and *nothing happens at all* — no window, no notification, no focus of the existing instance. The log that would explain it is discarded (2.2). The user will file this as "August doesn't launch".
- **Fix:** use `tauri-plugin-single-instance` (the standard, atomic, cross-platform solution that also delivers the argument/deep-link hand-off), or at minimum have the second process show/focus the first window and post a short toast. **Effort S (toast) / M (plugin migration), risk S–M.**

- **Weakness (P2): the lock acquisition is not atomic.** It is a read-then-write with no `O_EXCL`/exclusive create (`backend.rs:256-267`). Two simultaneous cold starts (a double-click, or a relaunch racing the previous instance's teardown) can both read an absent lock, both write, and both proceed — producing exactly the shared-backend corruption the guard exists to prevent. The window is small, but it is the one class of bug this mechanism must not have. A `create_new(true)` lock file closes it.

### 5.2 Deep links — NOT IMPLEMENTED

- No `tauri-plugin-deep-link` in `Cargo.toml:16-30`; no `deep-link` config in `tauri.conf.json`; no `deep_link_protocols` in the bundle block, so the NSIS `{{#each deep_link_protocols}}` loops (`installer.nsi:734-740`, `869-875`) iterate over an empty set. The Windows custom AUMID exists but is used for Task Manager grouping only.
- This is consistent and harmless today (there is nothing to route), but it is a gap against the single-instance hand-off story in 5.1: there is currently no way to route an inbound URL to the running instance.

### 5.3 Session restore on relaunch — PARTIAL

- **Chat state restores well**, and this is the strongest part of the recovery story: sessions come from SQLite via the `turnOpen` crash-recovery path (`workbench/sessions.py:205-228`), and the app-global SSE resync reconnects anything the backend still reports as streaming (`App.tsx:44-46`), which explicitly covers backend-started auto-turns on routes where `ChatThread` is not mounted.
- **The UI route does not restore.** `BrowserRouter` with no basename and no persisted last location (`main.tsx:48-51`); the `*` route redirects to `/` (`App.tsx:99`). Every relaunch lands on the tasks home regardless of where the user was. A `lastRoute` in the existing `sessionStorage`/`localStorage` preferences layer would fix it in a few lines. **Effort S, risk S.**

### 5.4 Crash recovery for an interrupted turn — SOLID

- Covered in 2.5: the barrier writes `turnOpen = True` synchronously, and `fromDict` closes the orphaned turn with a synthetic `[interrupted]` marker **without truncating** (`workbench/sessions.py:209-227`). The design comment at `durability.py:1-17` is accurate about the three barriers and about never truncating. The user can continue in the session; the marker tells the model to verify state rather than assume. This is the right answer and it survives a hard kill.

---

## 6. Startup performance and resource hygiene

### 6.1 What runs before the app is usable

Ordered by measured cost on the packaged path:

1. **AppData runtime bootstrap** (only on first launch or stamp mismatch): recursive copy of a **37 MB** `backend-py` tree — of which **33 MB is `sidecar/node_modules`** (measured in the staged resources) — plus a venv build and an offline install from a **119 MB** wheel set (`backend.rs:685-745`). Minutes. UI is honest about it (`copying` → `creating_venv` → `installing`), which is the right mitigation.
2. **The whole FastAPI `lifespan` startup** before the socket accepts anything (`main.py:114-253`). See 1.2 — this is the real cold-start cost and the reason the 45 s budget is unsafe.
3. **Every launch, unconditionally:** `memory_store.init()` → `ensure_schema` (`main.py:185`, `memory_schema.py:556-620`). The warm path is well-built — it early-outs on `PRAGMA user_version` and then runs only additive `ensure_column` calls, index creation, FTS sync repair, and the migration runner. That is the right shape.
4. **`migrate_storage_keys` opens a second connection to the live brain DB on the boot path** (`main.py:196-201`, `storage_key_migration.py:66-80`). It is cheap (a handful of fixed keys) and WAL-safe, but it is a second writer-capable handle to the live file during startup, and it runs *after* the primary connection is open. **Weakness (P2):** fold it into the schema transaction or defer it to a thread. **Effort S, risk S.**
5. `brain_backup.ensure_current_backup` is correctly off the critical path — `asyncio.to_thread` after migrations, with the reason documented (`main.py:186-189`: the backup API needs a read lock that a migration transaction holds). Same for `refreshMcpTools` (`202-207`) and the learning scheduler (`243-250`). These are all right.
6. `tool_definitions.registerAll()` (`main.py:176-178`) is a registration pass, not a scan of the filesystem. Fine.

### 6.2 Scanning that does *not* happen at boot — GOOD

- **Skills are scanned lazily.** `skill_service` resolves `SKILLS_DIR` and roots (`skill_service.py:25`, `83`, `537`) but nothing walks the tree during startup; listing is a per-request path. This matters because a packaged install copies the bundled skills tree on every stamp mismatch (`backend.rs:696-703`).
- **No brain index build at boot.** The per-session memory index is built per session, not per process, which is also what keeps the provider prefix cache stable (`AGENTS.md:138-142`). Correct design.
- **Deferred frontend work is genuinely deferred.** `katex` CSS and the voice builtins load in `requestIdleCallback` with a 2 s timeout, after first paint (`main.tsx:63-70`). Theme, UI customisation and preferences are applied synchronously *before* `createRoot` (`main.tsx:36-41`) to avoid FOUC. Both are right.

### 6.3 Hot-path waste — DEFECT (P2)

- `flush_session_barrier` calls `memory_store.init()` on **every** durability barrier — i.e. at model dispatch, before every top-level tool side effect, and at every step boundary (`durability.py:90-92`). `init()` is `ensure_schema(_conn())` (`memory_store/kv.py:15-17`), so each barrier re-runs the full warm-path column/index/FTS/migration pass. On a long tool-using turn that is dozens of redundant schema passes per turn, each touching the live DB.
- The `init()` call is there to guarantee the table exists before the write, which is defensible. But the warm path is not free, and a one-time `functools.lru_cache`/module-level "schema is current for this connection" guard would remove the repetition without weakening the guarantee. **Effort S, risk S** (must not skip the *first* call, and must not cache across a process that reopens the DB).

### 6.4 Update check at startup

- `useAppUpdate` runs a network `check()` on mount and again on every window focus (`useAppUpdate.ts:92-99`, `275-283`), with a 30-minute `staleTime`. Reasonable, but `refetchOnWindowFocus` on a local desktop app that gets focus constantly means a GitHub request on most window switches that outlive the stale time. `updater` requests hit `github.com/.../latest.json` directly (`tauri.conf.json:59-61`). Minor bandwidth/noise; a focus-gated interval would be tidier. **P2, S, S.**

---

## 7. Signing and packaging

### 7.1 Installer types and update artifacts — SOLID

- Targets are `msi` and `nsis` (`tauri.conf.json:32-35`), `createUpdaterArtifacts: true` (`36`). The product name is `August` with `mainBinaryName: "August"` (`3`, `6`), identifier `com.august.proxy` (`5`) — matching the AUMID set at `lib.rs:39`.
- The updater endpoint is the GitHub `latest.json` for `windows-x86_64` (`tauri.conf.json:59-61`), generated by the release script **from the real `.sig` file** rather than hand-written: `buildLatestJsonFromSignatures` reads the NSIS `.sig` and then `validateLatestManifest` re-reads the file and asserts the manifest's version, the platform entry, the exact public URL, and that the embedded signature is byte-identical to the file (`release-desktop.mjs:348-385`).
- `exactNsisArtifact` / `exactMsiArtifact` fail closed if the expected filename is missing, duplicated, or unsigned (`314-340`). `releaseAssets` asserts every asset is a non-empty regular file before publish (`463-476`, `171-181`).
- `assertReleaseTagMatchesCurrentCommit` and the publish-time re-check prevent a release from being tagged against a different commit than the one being built (`530-536`, `547-555`).
- A failed Tauri build restores the previous signed installer pair from a `.prev` backup rather than leaving a half-cleaned bundle dir (`391-423`, `446-461`). Thoughtful.

### 7.2 Update-signature verification — SOLID

- Both paths verify: Tauri's own updater plugin verifies its `latest.json` artifacts against the configured pubkey, and the Windows full-installer path re-verifies independently in `backend.rs:1848-1863` + `2069`. Defence in depth.
- The embedded key at `backend.rs:28` matches `tauri.conf.json:58`. The release script requires the signing key to be present, and `signingEnv()` deliberately sets an **empty** password rather than letting PowerShell delete the variable (which would make `tauri build` block on an interactive prompt) — `release-desktop.mjs:438-444`, with the reason in the comment.

### 7.3 Gaps

- **DEFECT (P1) — no Authenticode code signing anywhere.** There is no certificate, no `signtool` invocation, and no `certificateThumbprint`/publisher config in `tauri.conf.json` or in `release-desktop.mjs`. The installers are **minisign-signed** (an update-channel integrity mechanism) but not **Authenticode-signed** (the Windows trust mechanism). Practical consequences: SmartScreen "Windows protected your PC" on first run for every user, an "Unknown publisher" UAC prompt, and no tamper evidence on the installed binaries themselves. The minisign signature protects the *download*; nothing protects the *executed* image on disk. **Fix:** acquire an EV/OV code-signing cert, sign `August.exe`, the MSI and the NSIS setup in `release-desktop.mjs` after bundling, and record the thumbprint. **Effort M (process) / S (code), risk M** (a mis-signed artifact bricks every install — needs a canary release first).
- **Weakness (P2): two installer formats are shipped and only one is exercised by the updater.** The MSI is built, signed and published (`release-desktop.mjs:328-340`, `471-473`) but the in-app updater only handles the NSIS setup, and the NSIS template's reinstall-page logic contains WiX-migration handling (`installer.nsi:229-256`) that a WiX-installed user can hit. Fine as shipped, but the MSI/NSIS split doubles the signed-artifact surface for no updater benefit.
- **Weakness (P2): `createUpdaterArtifacts: true` plus the custom full-installer flow means the `latest.json` the app checks is only used for *version discovery* on Windows.** The download is re-derived from a constructed URL (`expectedReleaseUrl`, `backend.rs:1844-1846`) and the version is validated against a strict `x.y.z` shape (`validateReleaseVersion`, `1826-1837`). The construction is safe (alphanumeric + `.`/`-`/`+` only, so no URL injection), but the app is verifying a URL it built rather than the one the signed manifest declared. Reusing the `latest.json` URL would tie the download to the signed manifest end to end. **Effort M, risk M** (changes the update contract; needs a manifest-version compatibility check).
- **Weakness (P2): `resources/**/*` and `binaries/*` are bundled wholesale** (`tauri.conf.json:37-40`), which is what puts 295 MB of python+wheels in the installer. Not wrong for an offline-capable local app, but it means every release ships a large delta with no differential update. Expected; noted for completeness.

---

## 8. Ranked findings

### P0

| # | Finding | Evidence | Effort | Risk |
|---|---|---|---|---|
| P0-1 | **Quit hard-kills the backend, so the entire lifespan teardown is dead code.** `taskkill /F` (`backend.rs:948-951`) / `SIGKILL` (`954-956`) means `flush_pending_saves`, `flush_thread_pending` (2–10 s of `turn_outcomes` / lifecycle / internal_state), `event_log.flush`, `stop_cognitive_services` and `save_sessions_now` in `main.py:254-332` never run. Chat transcripts are safe (synchronous barriers + WAL), but the telemetry ledger silently under-reports every force-quit and the last ≤150 ms / ≤2 s of state is lost on every exit. Add a graceful shutdown door (endpoint or `CTRL_BREAK_EVENT`) with a bounded `/F` fallback. | `backend.rs:942-972`; `main.py:254-332`; `deferred_writes.py:35,37`; `sessions.py:602` | M | M |

### P1

| # | Finding | Evidence | Effort | Risk |
|---|---|---|---|---|
| P1-1 | **No logger is installed, so all 45 supervisor log lines are discarded** — including the single-instance refusal and every spawn failure. Add `tauri-plugin-log` or a file logger. | `Cargo.toml:29`; `backend.rs` (45 `log::` calls); `lib.rs:50` | S | S |
| P1-2 | **An adopted orphan poisons the stamp: new UI + old backend, permanently.** A force-killed `August.exe` leaves python on 8085; the next launch sees health, finds a stamp mismatch, calls the no-op `killStoredChild`, adopts the orphan, and writes the *new* stamp. | `backend.rs:1343-1355`, `1465-1469`, `1312-1319` | M | M |
| P1-3 | **45 s per-port health budget vs a boot that runs the whole lifespan before binding.** 11 ports × (full boot + 45 s) ≈ 8 min, ending in a destructive AppData wipe + offline reinstall. Raise the budget and/or bind before lifespan. | `backend.rs:1465`, `1499-1511`; `main.py:114-253` | M | M |
| P1-4 | **Second launch exits with zero user feedback** — no window, no notification, no focus of the running instance. Migrate to `tauri-plugin-single-instance` or at least surface the existing window. | `lib.rs:53-56`; `backend.rs:249-270` | S–M | S–M |
| P1-5 | **A mid-session backend crash is a silent dead UI.** The gate stays unlocked, the watchdog announces a restart that nothing renders, and every request fails for 3–30 s. Add a global backend-down banner. | `BackendBootstrapGate.tsx:152`; `backend.rs:1648` | S | S |
| P1-6 | **No Authenticode signing.** Minisign protects the download channel; nothing protects the installed image. SmartScreen + "Unknown publisher" on every install. | `tauri.conf.json` (no cert config); `release-desktop.mjs` (no signtool) | M | M |
| P1-7 | **Quit does not cancel in-flight turns through the protocol**, so no `turn_end {reason:'interrupted'}` row is ever written on a desktop exit. Add a best-effort `cancel_all_turns` before the hard kill. | `lib.rs:22-26`; `workbench.py:3766-3768` | S–M | S |

### P2

| # | Finding | Evidence | Effort | Risk |
|---|---|---|---|---|
| P2-1 | `backend.log` is truncated (`File::create`) on every respawn, destroying the crash output exactly when it is needed. Append or rotate. | `backend.rs:1412`, `1558` | S | S |
| P2-2 | Every version bump destroys and rebuilds the venv (wipe includes `.venv`; the copy skips it), forcing a multi-minute cold path on every update. Preserve the venv and keep the force-reinstall escape hatch. | `backend.rs:685`, `705`, `454-455` | M | M |
| P2-3 | `schedule_post_update_relaunch` is never called on the Windows branch, so the documented post-update safety net is not armed. | `useAppUpdate.ts:110-122`; `backend.rs:1729-1816` | S | S |
| P2-4 | The NSIS silent-install branch skips both the completion marker and the relaunch, which would leave the waiter waiting out its full 180 s. Latent today; a trap for whoever wires silent updates. | `hooks.nsh:129`; `backend.rs:1756-1788` | S | S |
| P2-5 | Instance-lock acquisition is read-then-write with no exclusive create — two simultaneous cold starts can both win. | `backend.rs:256-267` | S | S |
| P2-6 | `memory_store.init()` (full warm-path schema pass) runs on *every* durability barrier, i.e. dozens of redundant passes per tool-using turn. | `durability.py:90-92`; `memory_store/kv.py:15-17` | S | S |
| P2-7 | `migrate_storage_keys` opens a second connection to the live brain DB on the boot path. Fold into the schema transaction or defer. | `main.py:196-201`; `storage_key_migration.py:66-80` | S | S |
| P2-8 | The native window is created visible with no `visible: false`, so a webview that fails to load shows an unexplained empty window instead of a splash. | `tauri.conf.json:12-25` | S | S |
| P2-9 | The UI route is not restored on relaunch — `BrowserRouter` with no persisted last location; `*` always redirects to `/`. | `main.tsx:48-51`; `App.tsx:99` | S | S |
| P2-10 | The quit-confirm active-turn list is frontend-only and does not consult the backend's authoritative `turnOpen`; there is a small window between "turn started" and "bridge told the webview". | `QuitConfirmModal.tsx:30-41`; `sessions.py:88-90` | M | S |
| P2-11 | `sync` commands block the Tauri main thread: `confirm_quit` (taskkill + up to 5 s reaper + PowerShell sweep + 400 ms) and `launch_installer_and_exit` (full installer read + minisign verify + teardown + 600 ms) are sync commands, unlike their `spawn_blocking` siblings. | `lib.rs:22-26`; `backend.rs:2054-2084`, `991-1014`; cf. `backend.rs:1697-1720` | S | S |
| P2-12 | `refetchOnWindowFocus` on the update check fires a GitHub request on most window switches that outlive the 30-minute stale time. | `useAppUpdate.ts:92-99`, `275-283` | S | S |
| P2-13 | The Windows updater re-derives the installer URL instead of using the signed `latest.json` URL, so the download is pinned to a locally-constructed string rather than the signed manifest. | `backend.rs:1844-1846`, `1826-1837` | M | M |
| P2-14 | `check-version-sync.mjs` is only invoked at release time; a PR that forgets a version bump is caught only after tagging. | `check-version-sync.mjs`; `release-desktop.mjs:272,310` | S | S |
| P2-15 | `pip install --upgrade` never uninstalls packages the new build dropped, so the AppData venv accumulates orphans across updates. | `backend.rs:725-745` | M | M |

---

## 9. What is genuinely solid

Worth stating plainly, because these are the parts a rewrite would be most likely to regress:

- **Identity-checked health** rather than a bare 2xx (`backend.rs:1241-1257`) — the single most valuable invariant in the supervisor.
- **The stamp discipline**: written only after a verified health probe, never after pip success; content-hashed over the whole payload; compared even when the proxy is already healthy; backed by a one-shot wipe-and-reinstall that deliberately does *not* gate on `runtimeStampMatches` (`backend.rs:1312-1319`, `1343-1355`, `1494-1511`; `prepare-desktop-backend.mjs:392-414`).
- **The updater's double verification** — signature checked at download and re-checked against a canonicalised path at launch (`backend.rs:1848-1863`, `2055-2069`).
- **The crash-recovery transcript contract**: synchronous fail-closed barriers plus a never-truncate `turnOpen` closure (`durability.py`; `workbench/sessions.py:205-228`).
- **The guard/teardown interaction**: a lock-refused launch must not run the orphan sweep (`backend.rs:45-49`, `992-997`) — a subtle trap that is both documented and defended.
- **Windows file-lock handling on the install path**: layered kill → rename-aside → retry → a plain-language Retry prompt that is suppressed for silent installs so an update can never strand itself (`hooks.nsh:17-139`; `backend.rs:540-603`).
- **Degraded-not-fatal wipe semantics**, with the rationale in the code and four unit tests pinning it (`backend.rs:520-603`, `2430-2594`).
- **The bootstrap gate living outside the quit modal's blocker** — the "backend never started, now I can't close the window" failure is explicitly designed out (`App.tsx:110-114`).
- **The release script's failure modes**: unsigned artifact = build failure; manifest/signature mismatch = build failure; version regex miss = throw, not skip; a failed build restores the previous signed pair (`release-desktop.mjs:314-340`, `348-364`, `291-308`, `391-461`).
