# Developer Guide

This guide is for contributors. It covers dev environment setup, project
conventions, the test suite, and how to extend the codebase.

---

## Table of Contents

1. [Repository layout](#repository-layout)
2. [Dev environment setup](#dev-environment-setup)
3. [Running the server](#running-the-server)
4. [Running the tests](#running-the-tests)
5. [Project conventions](#project-conventions)
6. [Adding a new provider](#adding-a-new-provider)
7. [Adding a new workbench tool](#adding-a-new-workbench-tool)
8. [Adding a new gateway platform](#adding-a-new-gateway-platform)
9. [Adding a UI panel / settings section](#adding-a-ui-panel--settings-section)
10. [Adding a background daemon](#adding-a-background-daemon)
11. [Extension checklists (≤30 min stubs)](#extension-checklists-30-min-stubs)
12. [Debugging](#debugging)
13. [Performance knobs](#performance-knobs)

---

## Repository layout

```text
august-proxy/
├── backend-py/
│   ├── app/
│   │   ├── main.py              # FastAPI app + lifespan + /api/health
│   │   ├── config.py            # Settings (config.json + providers.json + .env)
│   │   ├── adapters/            # Anthropic/OpenAI translation, proxy tools
│   │   ├── providers/           # clients, resolvers, api_format aliases
│   │   ├── routers/             # HTTP routes (/api/* and /v1/*)
│   │   ├── migrations/          # numbered brain SQLite .sql migrations (NNN_name.sql)
│   │   ├── services/            # workbench, gateway, memory, skills, tools, …
│   │   │   ├── memory_store/    # brain SQLite domain package
│   │   │   └── memory_conn.py   # thread-local conn + PRAGMA defaults
│   │   └── lib/                 # paths, secrets, retry, tokens, health
│   ├── tests/                   # pytest suite (isolatedData autouse)
│   ├── scripts/                 # one-off verification, generators, codemods
│   └── pyproject.toml           # ruff + pytest; requires-python >=3.12
├── frontend/
│   ├── desktop/                 # React + Vite + Tauri SPA
│   └── mobile/                  # Expo companion
├── web-dist/                    # Vite output packaged into Tauri (not a product QA target)
├── data/                        # Runtime config + brain DB (gitignored secrets)
├── skills/                      # Bundled SKILL.md packs
└── docs/                        # Documentation
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces interact.

---

## Dev environment setup

Requires **Python 3.12+** (`backend-py/pyproject.toml` `requires-python`, Docker
image, and `main.py` fail-fast). Prefer `backend-py/.venv` or `uv`.

```bash
cd backend-py
uv sync --group dev
# or:
# python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
# pip install -e ".[dev]"

# Optional extras
uv sync --extra ml                 # sentence-transformers + numpy
uv run playwright install chromium # browser automation

# Optional repo-root git hooks (ruff on backend-py)
# Windows Device Guard-safe installer:
#   PowerShell:  .\scripts\install-git-hooks.ps1
# Stock alternative:
pre-commit install
```

Frontend (repo root):

```bash
npm install
npm run dev:web        # Vite
npm run dev:desktop    # Tauri + backend orchestration
```

The dev extra installs `pytest`, `pytest-asyncio`, `httpx`, `watchfiles`,
`mypy`, `ruff`, and `pre-commit`.

---

## Running the server

```bash
cd backend-py
uv run uvicorn app.main:app --reload --port 8085
```

`--reload` watches `app/` for changes. Prefer **`npm run dev:desktop`** for UI
work. `web-dist/` is packaging output; `npm run dev:web` is only useful as a
Vite sidecar, not product QA.

Production-style:

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8085
```

Docker: `docker compose up --build -d` (port `8085:8085`).

---

## Running the tests

```bash
cd backend-py
uv run pytest -q -n auto
uv run pytest tests/test_workbench.py --no-cov -n auto
uv run pytest -k plan_mode --no-cov -n auto
uv run pytest --lf

# Always pass -n auto. The serial suite is ~2h across ~4,970 tests because the
# slow ones shell out to real external toolchains (Quartus, arduino-cli, ngspice)
# in independent temp dirs; -n auto measured 2.6x on 4 workers (8m22s on 16
# cores). A test that only passes serially is load-sensitive — fix the test.
#
# Full suite applies --cov-fail-under=55. A single file will miss that floor
# unless you pass --no-cov.

# From repo root
npm run test:backend
npm run test:frontend
npm run test
```

The suite uses `asyncio_mode = "auto"` (`pyproject.toml`), so `async def test_*`
functions run without an explicit marker.

### Fixtures

- **`isolatedData` (autouse)** — every test gets a temp `AUGUST_DATA_DIR` and
  brain SQLite path so nothing touches live `data/`. Request the fixture if you
  need the `Path`; isolation still applies if you omit it. **Do not remove
  `autouse=True` without a safety review.**
- Skill isolation fixtures redirect skill roots where needed.

### Coverage notes

Strong coverage on session CRUD, guard-mode, adapters, gateway concurrency,
skill curator, memory/FTS, Phase 7 inventory gate, and many UI vitest suites.

Gaps to be aware of:

- End-to-end workbench model streaming against a live upstream needs mocks or
  env-gated real-LLM tests.
- Live Slack/Discord *network* bots and real provider keys are env-gated.
- Residual camelCase **parameter** names in some snake_case modules (wire keys
  stay camelCase by design).

---

## Project conventions

### Naming

- **JSON/API wire: camelCase** for request/response fields.
- **Python modules / functions:** mixed history — prefer **snake_case** for new
  Python defs (`save_memory`, `enqueue_write`). Many older call sites and
  **parameters** still use camelCase (`sessionId`); do not mass-rename without a
  plan.
- Constants: `UPPER_SNAKE`.
- Private-by-convention: leading underscore.
- External API boundary (`adapters/`) translates formats via case helpers where needed.
- Never rename Python dunders, pytest `test*` discovery, or env var names.

### Structure

- Routers live in `app/routers/` and are registered in `main.py`.
- Services live in `app/services/`; large subsystems get a subpackage
  (`workbench/`, `gateway/`, `browser/`, `memory/`, `skills/`, `tools/`).
- Heavy cross-module imports are done lazily (inside functions) to avoid
  circular imports — especially workbench, gateway, and tools.

### Error handling

- Service-layer mutations raise `ValueError` / `KeyError` / validation errors;
  routers map to HTTP 400/404.
- Tool handlers return **strings** (JSON or plain text), never raise into the
  model loop.
- Background fire-and-forget tasks wrap bodies in `try/except`.
- **A swallow must be named.** New best-effort blocks go through
  `with best_effort('session.title-backfill'):` (`app/services/best_effort.py`)
  instead of a bare `except Exception: pass`, so `rg 'best_effort\['` finds
  every one and each logs with a traceback. Set `AUGUST_STRICT_BEST_EFFORT=1`
  in test runs and the same block re-raises instead — what production would
  have eaten then fails the suite. The ruff `BLE001` ratchet keeps new blind
  excepts out while the existing ones migrate file by file.

### Design conventions (enforced by `npm run check:design`)

`scripts/check-design.mjs` is a **ratchet**, not a cleanup: it fails only on
violations missing from `scripts/design-baseline.json`, so existing debt stays
visible and shrinkable while new drift cannot merge. It walks
`frontend/desktop/src/**/*.{ts,tsx}` for five habits:

| Rule | What it catches | Why |
|------|-----------------|-----|
| `px-type` | `text-[12px]`, `text-[10.5px]` | px font sizes ignore the `data-text-size` root scaling in `styles.css`. Use the rem scale (`text-3xs` / `text-2xs` / `text-xs` / …) or an exact rem value. eslint bans this too |
| `hex-color` | `#[0-9a-fA-F]{6}` / 8-digit | Use theme tokens so light and dark stay in step |
| `raw-button` | `<button` outside `src/components/ui/` | Use the `Button` primitive — focus ring, variants, size scale |
| `raw-fetch` | `fetch(` outside `src/api/` | Use `api.get` / `api.post` — it owns base URL, auth, error normalization |
| `inline-style` | `style={{` | Inline objects cannot use theme tokens or the variant system |

Baseline identity is `path:match` **without** the line number, so an unrelated
edit above a baselined violation cannot fail an unrelated PR; the failure
output still prints the line. Use `--update` only after an intentional sweep,
never to silence a finding.

### Persistence

- Config / aliases / fallback: `data/config.json` (atomic rewrite).
- Sessions: **SQLite SoT** (`memory_store.save_workbench_session_sot`); optional
  JSON export.
- Memory / audit / kv / episodes: `data/august_brain.sqlite` (no graph or vector tables — removed in v10).
- Config mutations: `memory_store.record_config_audit` (and related audit APIs).

### Datetimes

Prefer `datetime.now(timezone.utc)` for new code. Older code may use
`datetime.utcnow().isoformat() + "Z"`.

### Type safety

- **Python — no `Any` in new code.** Use `TypedDict` / `JsonValue` /
  Pydantic. `mypy` in CI.
- **TypeScript — no `any` in new code.** ESLint
  `@typescript-eslint/no-explicit-any` for new code. Prefer `unknown` + narrow.
- **`catch (e: any)` forbidden.** Use `instanceof Error`.
- Shared types: `frontend/desktop/src/types/*` and Zod schemas under
  `src/api/schemas/*`. Workbench SSE events should round-trip through
  `WorkbenchEventSchema`.

---

## Adding a new provider

There is **no template catalog**. Users configure providers fully:

1. UI: **Add Provider** (name, base URL, API format, key), or
   `POST /api/providers` with those fields, or edit `data/providers.json`.
2. Agent tool: `setup_provider` (requires `baseUrl` for creates).
3. Bespoke HTTP behaviour only if needed: extend a client under
   `app/providers/clients/` subclassing `BaseProviderClient`; generic OpenAI /
   Anthropic clients cover most gateways via `apiFormat`.
4. Tests: `tests/test_providers.py` style create/list with baseUrl.

### Naming boundary (intentional dual surface)

| Layer | Convention |
|-------|------------|
| Python function names | `snake_case` |
| SQLite tables/columns | `snake_case` |
| HTTP path params / JSON wire | **camelCase** (frontend contract) |
| Pydantic API models | snake fields + camel JSON via `CamelModel` |

Do **not** mass-rename path params or wire keys. New service APIs should use
snake_case parameters; routers may keep camelCase path params to match URLs.

---

## Adding a new workbench tool

1. Prefer a module under `app/services/tool_registrations/<group>_tools.py`.
2. Write an **async** handler that returns a **string**.
3. In `register()`, call `tool_registry.register(name, description,
   parameters=<JSON Schema>, handler=...)`.
4. Ensure `tool_registrations/__init__.py` → `register_all()` includes your group.
5. **Do not** edit the workbench chat loop for normal tools.
6. Mutating tools: ensure plan/ask guards and managed tool policy cover them.
7. Read-only tools safe for concurrency: consider `PARALLEL_SAFE_TOOLS` in
   `workbench/parallel_tools.py`.
8. Add tests under `tests/`. Tool JSON caches invalidate via
   `tool_registry.generation()`.

> **Execution state:** the `update_state` system tool
> (`tool_registrations/system_tools.py`) tracks a multi-phase state
> (`research → plan → implement → review → complete`); phase/step changes
> stream to the UI as `executionState` SSE events (the old verifier gate was
> removed — see [`ARCHITECTURE.md`](ARCHITECTURE.md)). Token usage is
> recorded per turn and surfaced via `/api/usage/*`; the `done` SSE event
> carries a `usage` field when tracking is on.

---

## Adding a new gateway platform

1. Create `app/services/gateway/platforms/<name>.py` subclassing
   `BasePlatformAdapter` (`connect`, `disconnect`, `send_message`,
   `get_chat_info`, `normalize`).
2. Register the factory in `app/routers/gateway.py` with `try/except ImportError`
   so missing SDKs do not block boot.
3. Add webhook routes if needed (Telegram pattern).
4. Document env vars in `.env.example` and [`CONFIGURATION.md`](CONFIGURATION.md).
5. Tests modelled on `tests/test_gateway_base.py` and `tests/test_gateway_telegram.py`.

---

## Adding a UI panel / settings section

1. **Prefer a hub, not a new rail tab.** Memory, Appearance, and Files & Shell
   Access already stack related pages. Add `tier: 'hidden'` + `railCanonicalId`
   so deep links highlight the parent. Source of truth:
   `frontend/desktop/src/settings/settings-registry.ts`.
2. **Full section route:** lazy-loaded page under `sections/` + register in
   desktop routes (prefer `lazy(() => import(...))`).
3. **API:** router under `backend-py/app/routers/` + `include_router` in `main.py`.
4. **State:** dedicated Zustand slice or React Query keys.
5. **Types:** Zod schema + TS types; no new `any`.
6. Smoke the route in `npm run dev:desktop` (not a raw Vite browser tab).
7. Chat chrome (run header, Brain review, worker lanes) lives next to
   `ChatThread.tsx` — do not add a Settings tab for those.

---

## Adding a background daemon

1. Implement a tick/handler module under `app/services/` (see existing daemons +
   `daemon_manager`).
2. Register with `daemon_manager` and gate behind cognitive / config flags.
3. Respect session/daemon caps and backoff (load-tested — do not raise caps
   without a new contention check).
4. Writes go through `memory_store` — no ad-hoc SQLite writers on
   new paths without review.
5. Unit test registration + one tick in isolation.

Note: prefer direct `memory_store` transactions for user-facing SoT.

---

## Extension checklists (≤30 min stubs)

### Checklist — stub tool

- [ ] Handler in `tool_registrations/*_tools.py`
- [ ] `tool_registry.register(...)` with JSON Schema
- [ ] pytest that dispatch returns expected string
- [ ] Optional `PARALLEL_SAFE_TOOLS` only if read-only
- [ ] No edits to workbench chat loop body

### Checklist — stub provider

- [ ] Custom entry or template JSON + key resolution
- [ ] Client reuse via `apiFormat` / `getClient` pool
- [ ] Test list/resolve/alias path

### Checklist — stub settings panel

- [ ] Registry entry + lazy section **or** stack into an existing hub
- [ ] No change to ChatThread critical path
- [ ] Hidden children use `railCanonicalId`
- [ ] `npm run check:version` still green if you did not intend a ship

---

## Debugging

- **Request inspector:** `GET /api/requests`, `/api/requests/{id}`, `/api/detail/{id}`
- **Activity:** `GET /api/activity`
- **Logs:** `GET /api/logs/recent`, `WS /api/logs/stream`
- **Feature flow:** `GET /api/monitor/events` (+ stream)
- **Brain:** `GET /api/brain/config`, `/api/brain/stores` (+ `/stores/{name}`),
  `GET /api/brain/integrity` (memory health), `/api/brain/backups`,
  `/api/brain/turn-outcomes`, `/api/brain/memory/metrics`,
  `/api/brain/memory/preview`, `/api/brain/state-lookup`,
  `/api/brain/consolidation/log`
- **Perf:** `GET /api/perf/recent` with `AUGUST_PERF_TIMING=1`
- **Frontend stream marks:** `localStorage.august_stream_perf=1`
- **Stale workbench state:** sessions live in SQLite; optional delete of
  `data/workbench-sessions.json` only affects JSON export. Resetting brain wipes
  memory/sessions (`data/august_brain.sqlite*`) — stop server first.
- **Verbose uvicorn:** `--log-level debug`

---

## Performance knobs

| Env / flag | Effect |
|---|---|
| `AUGUST_PERF_TIMING=1` | Structured workbench timings + `/api/perf/recent` |
| `AUGUST_P1_TOOL_CACHE=0` | Disable tool definition list cache |
| `AUGUST_P1_PROMPT_CACHE=0` | (removed — never read; Part 25 Phase 7.2) |
| `AUGUST_P1_PARALLEL_TOOLS=0` | Force serial tool execution |
| `AUGUST_SQLITE_CACHE_KB` | Opt-in page cache KiB |
| `AUGUST_SQLITE_MMAP_MB` | Opt-in mmap MiB |
| `AUGUST_SQLITE_SYNC` | Opt-in only: `NORMAL` / `FULL` / `OFF` (default leaves SQLite FULL) |
| `AUGUST_SESSION_JSON_EXPORT` | Session JSON backup toggle |
| `AUGUST_TOOL_TIMEOUT_S` | Per-tool execution timeout |
| `AUGUST_CONNECT_TIMEOUT_S` / `AUGUST_TTFB_TIMEOUT_S` | Upstream connect / time-to-first-byte |
| `AUGUST_ANTHROPIC_CACHE=0` | Master kill-switch for Anthropic prompt caching |
| `AUGUST_STRICT_BEST_EFFORT=1` | Make `best_effort(...)` swallows **re-raise** so tests surface what production would eat |
| `AUGUST_CORS_ORIGINS` | Extra explicit origins (the default allowlist is localhost/tauri only) |
| `AUGUST_ENABLE_DOCS` | Serve FastAPI `/docs` |
| `AUGUST_HEADLESS` | Run without a UI surface |

> `AUGUST_DB_WRITER_LOW_DROP_S` is **gone** — there is no `db_writer` queue and no
> priority/age-drop parameter. Commit batching is
> `services/deferred_writes.defer_commit(conn, window_s=…)`; see
> [`ARCHITECTURE.md`](ARCHITECTURE.md).

Stage boundaries: `app/services/workbench/chat_stages.py`.
SSE coalesce: `app/lib/batched_emit.py`.
FTS: use table-level `MATCH` (see search / auto_memory JOIN patterns).
