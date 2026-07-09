# Setup Script, Live Monitor, Backend Supervisor & Auto-Update — Implementation Plan

> **For agentic workers:** Use subagent-driven development or execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not bundle `backend-py/**/*` or `.venv` into Tauri resources.

**Goal:** Make first-run and desktop startup reliable, stream real backend events into Settings → Backend Monitor, keep Python deps in sync with the app version, and fix latent supervisor / schema / packaging bugs that would still break the product after the first revised plan.

**Scope for this plan:** Developer desktop (clone → install → `npm run dev:desktop`) and local packaged builds where `backend-py` is adjacent or discoverable. Full end-user MSI with embedded Python is **Phase F (optional follow-up)** — called out explicitly so it is not silently assumed.

**Architecture:**
1. **Setup scripts** create a validated `backend-py/.venv` and install editable deps (pip or uv).
2. **Tauri supervisor** resolves Python (`.venv` → `py -3` → real `python`), probes **`/api/health`**, spawns uvicorn, and optionally syncs deps in the background.
3. **Backend** exposes `WS /api/logs/stream`, thread-safe fan-out, correct event schema, and instrumentation so proxy/memory/scheduler events actually appear.
4. **Frontend** proxies WS in Vite, builds WS URLs via `whenReady()`, aligns category keys with snake_case, and surfaces backend setup/sync status in Settings.

**Tech stack:** PowerShell / Bash · Rust (Tauri 2) · Python 3.12+ (FastAPI / uvicorn) · TypeScript / React / Vite

---

## Issues This Plan Addresses

### A — Confirmed from prior plan review (runtime breakers)

| # | Issue | Impact if unfixed |
|---|--------|-------------------|
| A1 | Frontend WS path `/ui/logs/stream`; monitoring router is `prefix='/api'` | 404 on connect |
| A2 | Vite proxies `/api` as string only; no `ws: true` | Dev-mode WS fails |
| A3 | Bundling `backend-py/**/*` would ship `.venv` (~500MB+) | Bloated / broken installer |
| A4 | Sync `pip install` inside Tauri `setup` / `ensureRunning` | UI freeze for minutes |
| A5 | `emitLogEvent` calls `ws.send_json` without await/task | RuntimeError / silent drop |
| A6 | `CATEGORY_META` camelCase vs `LogCategory` snake_case | Filters hide everything |
| A7 | Windows Store `python` stub; no `py` / `.venv` preference | Backend spawn fails |

### B — Additional critical findings (must fix in this plan)

| # | Issue | Impact if unfixed |
|---|--------|-------------------|
| B1 | Rust probes `http://127.0.0.1:{port}/health`; app only has `/api/health` | `isProxyUp` / `proxy_status` always false → `whenReady()` never sets `baseUrl` in Tauri |
| B2 | Install stamp at repo `data/backend-version.txt` vs Tauri `appDataDir()/data` | Sync always wrong path |
| B3 | `emitLogEvent` never called; only activity/request trackers fire | Monitor empty except generic logs |
| B4 | Default category `general` not in filter set | Events hidden even if emitted |
| B5 | Logging-handler `create_task` not thread-safe | Dropped / racy WS sends |
| B6 | `getRecentLogEvents` returns oldest N of deque | Snapshot/backfill wrong |
| B7 | Production MSI still has no `backend-py` next to exe | Packaged app has no backend (document + optional Phase F) |
| B8 | First-run race: spawn uvicorn before deps installed | Dead backend until manual restart |

### C — Schema / UX / DX improvements (this plan)

| # | Improvement |
|---|-------------|
| C1 | Normalize `LogEvent` to `{ id, timestampMs, category, level, message, metadata, raw }` |
| C2 | Boot-time backend dep check (not only Updates page) + Backend Monitor status strip |
| C3 | Backend process status: port, pid, last spawn error, path to `backend.log` |
| C4 | Install scripts: uv-aware, validate imports, reject Store stubs, write stamp correctly |
| C5 | README / SETUP / TROUBLESHOOTING updates for desktop path |
| C6 | Automated tests: health probe contract, log event shape, WS snapshot frame, category keys |
| C7 | Optional SSE fallback for environments where WS is blocked |
| C8 | Rate-limit / sample high-volume debug categories; redact secrets in metadata |
| C9 | Align `start-backend.mjs` Python resolution with Rust (shared policy) |
| C10 | CSP / connect-src already allows `ws://127.0.0.1:*` — verify after WS URL change |

---

## Non-Goals (this iteration)

- Shipping a full portable Python runtime inside the MSI (Phase F).
- Replacing Tauri's binary updater (already works via `UpdateSection` + plugin).
- Migrating remaining `/ui/terminal/*` REST calls (out of scope; terminal **WS** already uses `/api/terminal/connect`).
- Rewriting the Node fallback backend (directory removed; keep graceful error messaging only).

---

## File Structure

### New
| Path | Role |
|------|------|
| `install.ps1` | Windows one-shot setup (venv + deps + stamp + next steps) |
| `install.sh` | macOS/Linux equivalent |
| `scripts/resolve-python.mjs` | Shared Node helper for `start-backend.mjs` (optional extract) |
| `backend-py/app/services/logStream.py` | Thread-safe WS hub + event ring buffer (or expand `logger.py`) |
| `backend-py/tests/testLogStream.py` | Snapshot frame, newest-first, schema |
| `frontend/desktop/src/hooks/useBackendStatus.ts` | Poll `proxy_status` + optional `sync_backend_deps` status |
| `docs/SETUP.md` | Desktop section updates |
| `docs/TROUBLESHOOTING.md` | Backend spawn / WS / Store Python tips |

### Modify
| Path | Role |
|------|------|
| `frontend/desktop/src-tauri/src/backend.rs` | Health URL, Python resolve, spawn, sync command, status |
| `frontend/desktop/src-tauri/src/lib.rs` | Register commands |
| `frontend/desktop/src-tauri/tauri.conf.json` | **No** `backend-py` resource glob; keep `binaries/*` only |
| `backend-py/app/routers/monitoring.py` | `WS /logs/stream` |
| `backend-py/app/services/logger.py` | Safe emit, schema, recent order; thin wrappers |
| `backend-py/app/main.py` | Register WS log handler / lifespan hooks |
| `backend-py/app/routers/proxy.py` | Emit categorized log events on request lifecycle |
| (selected) scheduler / security / memory services | Emit high-value categories |
| `frontend/desktop/vite.config.ts` | `/api` proxy object + `ws: true` |
| `frontend/desktop/src/hooks/useLogStream.ts` | URL via `whenReady`, path `/api/logs/stream` |
| `frontend/desktop/src/sections/settings/BackendMonitorSection.tsx` | snake_case categories; status; export |
| `frontend/desktop/src/sections/settings/UpdateSection.tsx` | Backend sync indicator (secondary) |
| `frontend/desktop/src/api/api-client.ts` | `LogEvent` timestamp type / fields |
| `frontend/desktop/src/api/client.ts` | Rely on fixed `proxy_status` |
| `scripts/start-backend.mjs` | Prefer `.venv`, `py -3`, no Store stub |
| `package.json` | Optional `postinstall` or `setup` script pointer |
| `README.md` | Desktop quick start |

---

## Implementation Sequencing

```text
Phase 0  Health + Python resolve + spawn correctness          (desktop boots)
Phase 1  Install scripts + version stamp + docs               (first-run DX)
Phase 2  Log stream hub + WS endpoint + schema                (pipe works)
Phase 3  Instrumentation + category UI + Vite/hook            (monitor useful)
Phase 4  Dep sync command + boot UX + UpdateSection           (auto-update deps)
Phase 5  Tests + verification + polish polish                    (ship-ready)
Phase F  Optional: package backend for release builds         (follow-up)
```

Implement in order; do not start Phase 3 UI polish before Phase 0 health is green.

---

## Phase 0 — Backend supervisor correctness

### Task 0.1: Fix health probe to `/api/health`

**Files:** `frontend/desktop/src-tauri/src/backend.rs`

- [ ] Change `proxyUrl()` and `proxyStatus` URL from `…/health` to `…/api/health`.
- [ ] Optionally accept either path for a short transition (not required if only Python backend exists).
- [ ] Log probe failures at debug with status code body snippet.

```rust
fn proxyUrl() -> String {
    format!("http://127.0.0.1:{}/api/health", proxyPort())
}
```

**Acceptance:** With uvicorn already running, `isProxyUp()` is true and `proxy_status` returns `ok:8085`. Frontend `whenReady()` sets `baseUrl`.

---

### Task 0.2: Resolve Python — `.venv` → `py -3` → real interpreter

**Files:** `frontend/desktop/src-tauri/src/backend.rs`

- [ ] After resolving `backend-py/app/main.py`, prefer:
  - Windows: `backend-py/.venv/Scripts/python.exe`
  - Unix: `backend-py/.venv/bin/python`
- [ ] Else Windows: locate `py.exe` and invoke with extra args `["-3", "-m", "uvicorn", …]` (not bare `python` from WindowsApps).
- [ ] Else `python3` / `python`, but **reject** paths containing `WindowsApps` (Store alias).
- [ ] Optional: run `python -c "import uvicorn"` as a quick preflight; on failure return clear log and skip spawn.

```rust
fn resolveVenvPython(backendMain: &Path) -> Option<PathBuf> {
    // …/backend-py/app/main.py → …/backend-py/.venv/...
    let backendPy = backendMain.parent()?.parent()?;
    let candidate = if cfg!(windows) {
        backendPy.join(".venv/Scripts/python.exe")
    } else {
        backendPy.join(".venv/bin/python")
    };
    candidate.exists().then_some(candidate)
}
```

**Acceptance:** On a machine with only Store stubs + a real `.venv`, spawn uses `.venv`. On a clean machine with `py -3` and installed deps, spawn succeeds without Store stubs.

---

### Task 0.3: Spawn reliability + surface errors

**Files:** `backend.rs`, optionally new Tauri commands

- [ ] Keep cwd = `backend-py` project root from `projectRootFor(main.py)` (already two parents up — correct for `uvicorn app.main:app`).
- [ ] Ensure log file at `{dataDir}/logs/backend.log` (already present); on spawn failure write reason to log and store last error string in process state.
- [ ] New command `backend_last_error() -> String` (or fold into richer `proxy_status` JSON later).
- [ ] If spawn returns Ok but health still fails after N polls (e.g. 5s), log "process died" and read last lines of backend.log into last_error.
- [ ] Do **not** run pip in this path (Phase 4).

**Acceptance:** Failed spawn leaves a readable error in UI (Phase 4 hookup) or at least `backend.log` + Rust log.

---

### Task 0.4: Align Node starter (DX parity)

**Files:** `scripts/start-backend.mjs` (optional `scripts/resolve-python.mjs`)

- [ ] Prefer `backend-py/.venv/Scripts/python.exe` (or Unix bin) before hardcoded user paths.
- [ ] Prefer `py -3` on Windows before PATH `python`.
- [ ] Skip WindowsApps paths.
- [ ] Keep `--app-dir backend-py` / cwd behavior working.

**Acceptance:** `npm run start` uses the same interpreter as Tauri after install script.

---

## Phase 1 — Setup scripts & docs

### Task 1.1: `install.ps1` (Windows)

**Files:** Create `install.ps1` at repo root

Behavior:

1. Resolve Python ≥ 3.12: `py -3` → `py` → `python3` → `python`; reject WindowsApps; print version.
2. Create `backend-py/.venv` if missing **or** invalid (missing python.exe or `import fastapi` fails).
3. Install deps:
   - If `uv` on PATH and `backend-py/uv.lock` exists: `uv sync` (or `uv pip install -e ".[dev]"` from `backend-py`) — preferred.
   - Else: `backend-py\.venv\Scripts\pip install -e ".[dev]"` from `backend-py`.
4. Write version stamp to **both** (or document single source — prefer runtime path used by Tauri):
   - Dev convenience: `data/backend-version.txt` under repo (app version from root `package.json` or `tauri.conf.json`).
   - Document that Tauri **copies/reads** stamp under `AUGUST_DATA_DIR` on first run (Task 4.1).
5. Print next steps: `npm install` (if needed), `npm run dev:desktop`.

- [ ] Idempotent re-runs.
- [ ] Exit non-zero with clear message on failure.
- [ ] Never commit `.venv`.

---

### Task 1.2: `install.sh` (macOS/Linux)

**Files:** Create `install.sh`

- [ ] `python3` primary; version gate ≥ 3.12.
- [ ] `python3 -m venv backend-py/.venv`; install via uv or pip same as PS1.
- [ ] `chmod +x` in docs.
- [ ] Same stamp behavior.

---

### Task 1.3: Docs & package scripts

**Files:** `docs/SETUP.md`, `README.md`, `docs/TROUBLESHOOTING.md`, optional root `package.json` script `"setup": "…"`

- [ ] Document Windows: `.\install.ps1` then `npm run dev:desktop`.
- [ ] Document health: `curl http://127.0.0.1:8085/api/health`.
- [ ] Troubleshooting: Store Python, missing uvicorn, port in use, WS not connecting, where logs live.
- [ ] State packaging non-goal: release MSI still expects dev-layout backend until Phase F.

---

## Phase 2 — Log stream hub, WS endpoint, schema

### Task 2.1: Canonical log event schema

**Contract (backend + frontend must match):**

```ts
interface LogEvent {
  id: string;
  timestamp: number;      // epoch ms
  category: LogCategory | string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  raw: string | null;
}

// WS frames
{ type: 'snapshot'; events: LogEvent[] }
{ type: 'event'; event: LogEvent }
// optional later: { type: 'ping' } / { type: 'error'; message: string }
```

**Categories (snake_case only):**

`proxy_incoming` · `proxy_upstream` · `proxy_debug` · `proxy_model_route` · `proxy_context` · `proxy_tools` · `proxy_system_prompt` · `auto_memory` · `scheduler` · `security` · `error` · `info`

- [ ] Update `emitLogEvent` to always produce this shape.
- [ ] Default category: `info` (not `general`) so default filter chips include it.
- [ ] Redact metadata keys matching `/key|token|secret|password|authorization|cookie/i` before broadcast/store.

---

### Task 2.2: Thread-safe WebSocket hub

**Files:** Prefer `backend-py/app/services/logStream.py` (or harden `logger.py`)

Design:

1. Ring buffer `deque(maxlen=5000)` — **newest first** (`appendleft`).
2. Client set of WebSockets (or weak refs).
3. Main-loop broadcaster:
   - `emitLogEvent` may run from any thread → `loop.call_soon_threadsafe(queue.put_nowait, frame)` or asyncio.Queue.
   - Single task drains queue and `await ws.send_json(frame)` per client; on failure remove client.
4. Never call `create_task(send_json)` from a logging handler on a random thread.

- [ ] `addLogWsClient` / `removeLogWsClient` / `getRecentLogEvents(limit)` newest-first.
- [ ] `getRecentLogEvents` returns `list(buffer)[:limit]` after `appendleft`.

---

### Task 2.3: FastAPI WebSocket route

**Files:** `backend-py/app/routers/monitoring.py`

```python
@router.websocket('/logs/stream')
async def logsStream(websocket: WebSocket):
    await websocket.accept()
    recent = getRecentLogEvents(500) or []
    await websocket.send_json({'type': 'snapshot', 'events': recent})
    addLogWsClient(websocket)
    try:
        while True:
            # Client may send pings; ignore payload
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        removeLogWsClient(websocket)
```

- [ ] Path final: **`/api/logs/stream`** (router prefix `/api` + `/logs/stream`).
- [ ] Do not add a second `/ui` route for this feature.

---

### Task 2.4: Optional logging bridge (low-noise)

**Files:** `logger.py`, `main.py` lifespan

- [ ] `WebSocketLogHandler` maps stdlib levels → `debug|info|warn|error`.
- [ ] Category `info` by default; optional map by logger name prefix (`uvicorn.error` → `error`, etc.).
- [ ] Handler level default `INFO` (not DEBUG) to avoid flooding the monitor.
- [ ] Register once in lifespan; remove on shutdown.

---

### Task 2.5: Tests

**Files:** `backend-py/tests/testLogStream.py`

- [ ] Newest-first recent list after N emits.
- [ ] Frame shape includes `type` + `event` / `events`.
- [ ] Timestamp is int ms.
- [ ] Redaction strips `apiKey` in metadata.
- [ ] REST `GET /api/logs/recent` returns same schema wrapper `{ events, count }`.

---

## Phase 3 — Instrumentation, frontend monitor, Vite

### Task 3.1: Emit real proxy categories

**Files:** `backend-py/app/routers/proxy.py` (and any shared proxy helper)

At minimum:

| Moment | category | level | message / metadata |
|--------|----------|-------|--------------------|
| Request accepted | `proxy_incoming` | info | method, path, model, sessionId |
| Upstream selected | `proxy_model_route` | info | provider, model, alias |
| Upstream call start/end | `proxy_upstream` | info/warn | durationMs, status, tokens |
| Tool loop / tools | `proxy_tools` | info | tool names |
| Errors | `error` or `proxy_upstream` | error | error string (redacted) |

- [ ] Reuse existing `startRequest` / `endRequest` data where possible (thin emit alongside).
- [ ] Keep volume reasonable (one incoming + one complete per request; debug behind category `proxy_debug`).

---

### Task 3.2: Other high-value emitters

- [ ] Scheduler tick / job run → `scheduler`
- [ ] Auto-memory write → `auto_memory`
- [ ] Security / gateway auth failures → `security`
- [ ] Skip pure noise (every DB read).

If a subsystem is hard to wire, document as follow-up rather than fake categories from the logging bridge.

---

### Task 3.3: Vite WebSocket proxy

**Files:** `frontend/desktop/vite.config.ts`

```ts
proxy: {
  '/api': {
    target: process.env.AUGUST_PROXY_URL || 'http://localhost:8085',
    ws: true,
    changeOrigin: true,
  },
  '/v1': {
    target: process.env.AUGUST_PROXY_URL || 'http://localhost:8085',
    changeOrigin: true,
  },
},
```

---

### Task 3.4: `useLogStream` URL construction

**Files:** `frontend/desktop/src/hooks/useLogStream.ts`

- [ ] `await whenReady()` before first connect.
- [ ] If `baseUrl` set (Tauri): `ws://127.0.0.1:{port}/api/logs/stream` (derive host from baseUrl; force `ws` for loopback HTTP).
- [ ] Else (browser Vite): `${ws|wss}//${location.host}/api/logs/stream`.
- [ ] Keep exponential backoff; reset on open.
- [ ] Prefer **either** WS snapshot **or** REST backfill as primary; if both, keep id-dedupe (already present).
- [ ] Guard against parallel `connect()` while awaiting `whenReady`.

---

### Task 3.5: Backend Monitor UI categories + polish

**Files:** `BackendMonitorSection.tsx`, `api-client.ts`

- [ ] Rename `CATEGORY_META` keys to snake_case (full list in Task 2.1).
- [ ] Stats that filter `proxy_upstream` / `auto_memory` / `scheduler` now receive real data after 3.1–3.2.
- [ ] Unknown categories: style as `info` **and** still show in the list (either add to enabled set dynamically or `enabled.has(cat) || !KNOWN.has(cat)` with default show).
- [ ] Optional: “Clear filters” / “Only errors” quick actions.
- [ ] Optional: pause still drops live frames (current behavior) — document in UI tooltip; consider buffer-while-paused later.

---

### Task 3.6: Optional SSE fallback (stretch)

**Files:** monitoring router + hook

- [ ] `GET /api/logs/sse` text/event-stream emitting same frames if WS blocked.
- [ ] Hook tries WS first; on repeated failure offer SSE — only if time permits after core WS works.

---

## Phase 4 — Backend dependency sync & status UX

### Task 4.1: Version stamp path policy

**Single runtime stamp path:**

```text
{appDataDir}/backend-version.txt
# where appDataDir is the same directory used for AUGUST_DATA_DIR parent
# (backend.rs already uses app.path().appDataDir().join("data"))
```

- [ ] On first successful ensureRunning / sync, write stamp there.
- [ ] Install scripts write repo `data/backend-version.txt` for non-Tauri / docker parity **and** document that desktop copies or re-stamps into app data.
- [ ] Compare stamp to `app.package_info().version` (Tauri), not `pyproject` version (`0.1.0`).

---

### Task 4.2: Tauri command `syncBackendDeps`

**Files:** `backend.rs`, `lib.rs`

```rust
#[tauri::command]
pub async fn syncBackendDeps(app: AppHandle) -> String {
    // "up-to-date" | "synced" | "syncing" | "error:…"
}
```

Logic:

1. Resolve venv pip / `python -m pip`.
2. If stamp matches app version → `up-to-date`.
3. Else spawn **background** install:  
   `python -m pip install -e "{backend-py}"` (or uv) with stdout/stderr to `{dataDir}/logs/pip-sync.log`.
4. On success write stamp; return `synced`.
5. Never block the UI thread with multi-minute pip (async + `spawn_blocking` / detached child with poll).

**First-run gate (B8):**

- [ ] If `.venv` missing or `import uvicorn` fails: **do not** claim healthy; either  
  - run a blocking-but-reported install once with frontend toast, **or**  
  - return structured status `needs_setup` and show Settings banner pointing at `install.ps1`.  
- Prefer: attempt one automated venv create + pip if Python found; on failure, `needs_setup`.

Windows: use creation flags so console windows do not flash (`CREATE_NO_WINDOW`).

---

### Task 4.3: Register commands & boot hook

**Files:** `lib.rs`, frontend bootstrap

- [ ] Register `syncBackendDeps` (IPC name `sync_backend_deps`).
- [ ] After `ensureRunning`, fire-and-forget version check (or invoke from frontend once on app mount).
- [ ] Do **not** only call sync from `UpdateSection` mount.

---

### Task 4.4: Settings UX

**Files:** `UpdateSection.tsx`, `BackendMonitorSection.tsx`, optional `useBackendStatus.ts`

- [ ] Backend Monitor header: Live | Disconnected | **Backend: up / down / setting up** (from `proxy_status`).
- [ ] Updates page: secondary card “Backend dependencies: up to date | Syncing… | error” with manual “Sync now”.
- [ ] Link or path hint to `backend.log` / `pip-sync.log` when error.

---

## Phase 5 — Verification, tests, polish

### Task 5.1: Automated / scripted checks

- [ ] Clean clone simulation: run `install.ps1` / `install.sh` → venv import fastapi/uvicorn OK.
- [ ] `curl http://127.0.0.1:8085/api/health` → includes `python: true` (or status ok).
- [ ] pytest `testLogStream.py` green.
- [ ] Optional vitest: category keys snake_case; WS URL builder unit test with mocked `whenReady`.

### Task 5.2: Manual verification checklist

- [ ] `npm run dev:desktop` → Vite + Tauri + backend on `:8085`.
- [ ] Settings → Backend Monitor: events appear when sending a chat / proxy request; chips filter; search; pause; export.
- [ ] Corrupt stamp to `0.0.0` → sync runs → stamp updated → no hang on startup.
- [ ] Tauri updater still checks releases (existing path).
- [ ] Kill backend process → UI shows disconnected / down → restart from existing restart command if available.

### Task 5.3: Docs final pass

- [ ] SETUP, README, TROUBLESHOOTING, this plan’s Phase F note.
- [ ] Developer guide: preferred Python resolution order.

---

## Phase F — Optional packaging (follow-up plan)

> Not required to close this plan. Track separately if shipping store/MSI to non-dev users.

| Option | Pros | Cons |
|--------|------|------|
| F1 Bundle `backend-py` sources **without** `.venv`; require system Python 3.12+ | Smaller | User must install Python |
| F2 Bundle embeddable CPython + wheels | Works offline | Large; maintenance |
| F3 Docker-only desktop companion | Simple server | Not native |
| F4 Keep Node sidecar for UI-only + remote API | No local Python | Loses local agent features |

If F1 is chosen later: Tauri resources include `backend-py/**` with **explicit excludes** for `.venv`, `__pycache__`, `tests`, `.pytest_cache`, `*.pyc`; install script runs on first app launch into app-local venv under `appDataDir`.

---

## Design Decisions (locked)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Log WS path | `/api/logs/stream` | Matches monitoring prefix + terminal WS pattern |
| Bundle backend in Tauri resources | **No** (this plan) | Avoids `.venv` bloat; dev uses adjacent tree |
| Pip in `ensureRunning` | **Never** | UI freeze |
| Category naming | snake_case | Matches `LogCategory` type |
| Health URL | `/api/health` | Only real endpoint on Python server |
| Default log category | `info` | Visible under default filters |
| Broadcast model | Queue + main-loop task | Thread-safe from logging / sync code |
| Stamp vs app version | Tauri package version | Aligns with native updater |

---

## Risk Register

| Risk | Mitigation |
|------|------------|
| High-volume logs freeze UI | Cap buffer 10k client / 5k server; default handler INFO; virtualized list already present |
| Secrets in metadata | Redact on emit; export uses existing `redactForCopy` |
| Detached pip never finishes | Timeout + `pip-sync.log` + UI error state |
| Multiple uvicorn instances | Fixed health probe + single `BackendProcess` mutex |
| Store Python still selected | Explicit path reject + prefer `.venv` / `py -3` |
| Packaged app without backend | Phase F or clear first-run error `needs_setup` |

---

## Implementation Task Checklist (summary)

### Phase 0
- [ ] 0.1 Health → `/api/health`
- [ ] 0.2 Python resolve (venv / py -3 / reject Store)
- [ ] 0.3 Spawn errors + backend.log visibility
- [ ] 0.4 Align `start-backend.mjs`

### Phase 1
- [ ] 1.1 `install.ps1`
- [ ] 1.2 `install.sh`
- [ ] 1.3 Docs + package script

### Phase 2
- [ ] 2.1 Event schema + redaction
- [ ] 2.2 Thread-safe hub + newest-first buffer
- [ ] 2.3 WS `/api/logs/stream`
- [ ] 2.4 Optional stdlib log bridge (INFO)
- [ ] 2.5 pytest log stream

### Phase 3
- [ ] 3.1 Proxy instrumentation
- [ ] 3.2 Scheduler / memory / security emits
- [ ] 3.3 Vite `ws: true`
- [ ] 3.4 `useLogStream` + `whenReady`
- [ ] 3.5 Monitor UI categories + unknown visibility
- [ ] 3.6 (Stretch) SSE fallback

### Phase 4
- [ ] 4.1 Stamp path = app data dir
- [ ] 4.2 `syncBackendDeps` + first-run gate
- [ ] 4.3 Register + boot invoke
- [ ] 4.4 Settings status UX

### Phase 5
- [ ] 5.1 Automated checks
- [ ] 5.2 Manual checklist
- [ ] 5.3 Docs final pass

### Phase F (optional)
- [ ] Packaging decision + exclude-aware resources + first-launch venv

---

## Appendix A — Current-code anchors (as of plan date)

| Item | Location |
|------|----------|
| Health (correct) | `backend-py/app/main.py` → `@app.get('/api/health')` |
| Health (wrong probe) | `backend.rs` → `…/health` |
| Python resolve (incomplete) | `backend.rs` `resolvePython` |
| `emitLogEvent` (sync send) | `backend-py/app/services/logger.py` |
| Recent logs REST | `monitoring.py` `GET /logs/recent` |
| WS client URL (wrong path) | `useLogStream.ts` → `/ui/logs/stream` |
| Categories camelCase | `BackendMonitorSection.tsx` `CATEGORY_META` |
| LogCategory snake_case | `api-client.ts` |
| Tauri resources | `tauri.conf.json` → `binaries/*` only |
| `whenReady` / baseUrl | `frontend/desktop/src/api/client.ts` |
| Terminal WS (good pattern) | `RightDrawerTerminalSection.tsx` → `/api/terminal/connect` |

---

## Appendix B — Prior plan bugs (do not reintroduce)

1. Do not connect to `/ui/logs/stream` for this feature.
2. Do not add `"../../../backend-py/**/*"` to Tauri resources without excludes and a packaging plan.
3. Do not `pip install` synchronously inside Tauri `setup`.
4. Do not `await`-less `send_json` from sync contexts.
5. Do not use camelCase category keys in the monitor.
6. Do not prefer WindowsApps `python.exe`.
7. Do not probe `/health` while the server only serves `/api/health`.

---

## Appendix C — Nice-to-have backlog (after Phase 5)

- Ring-buffer “pause retains X seconds of events” for Backend Monitor.
- Per-category sampling rates in config.json.
- Open `backend.log` in system editor from Settings.
- Graphite/structured logs export (NDJSON).
- Health “detailed” panel fields: python path, venv path, last sync at, app version stamp.
- Share Python resolution unit tests between Rust (integration) and `resolve-python.mjs`.
- Mobile parity for log stream (out of scope for desktop plan).

---

**End of plan.** Implement Phase 0 first; nothing else is trustworthy until `/api/health` and Python resolution work on Windows.
