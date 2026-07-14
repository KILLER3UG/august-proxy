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
13. [Phase P performance knobs](#phase-p-performance-knobs)

---

## Repository layout

```text
backend-py/
├── app/
│   ├── main.py              # FastAPI app + lifespan
│   ├── config.py            # Settings (config.json + providers.json + .env)
│   ├── adapters/            # Anthropic/OpenAI translation, proxy tools, classification
│   ├── providers/           # Built-in provider defs, clients, resolvers
│   ├── routers/             # HTTP routes (/api/* and /v1/*)
│   ├── services/            # workbench, gateway, memory, skills, tools, browser
│   └── lib/                 # paths, secrets, retry, tokens, health, identity
├── tests/                   # pytest suite
├── scripts/                 # gen_providers, gen_phase8, migrate_guidelines_to_skills
└── pyproject.toml
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces interact.

---

## Dev environment setup

Requires **Python 3.13+**.

```bash
cd backend-py
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

# Optional extras
pip install -e ".[ml]"           # sentence-transformers + numpy for embeddings
python -m playwright install chromium   # browser automation
```

The dev extra installs `pytest`, `pytest-asyncio`, `httpx`, and `watchfiles`.

---

## Running the server

```bash
uvicorn app.main:app --reload --port 8085
```

`--reload` watches `app/` for changes and restarts. The dashboard is served
from `web-dist/` if present; otherwise run the Vite dev server for the frontend
in parallel and proxy `/api` to `:8085`.

For production-style runs (no reload):

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8085
```

---

## Running the tests

```bash
pytest                         # full suite
pytest -q                      # quiet
pytest tests/test_workbench.py # one file
pytest -k plan_mode            # by name pattern
pytest --lf                    # re-run only last failures
```

The suite uses `asyncio_mode = "auto"` (see `pyproject.toml`), so `async def
test_*` functions run without an explicit marker.

### Fixtures

- `isolated_data` — redirects `data/` and the brain SQLite to a temp path so
  tests that mutate aliases / fallback / agents never touch real state.
  Opt-in (not autouse).
- `isolated_skills` — redirects both skill roots to temp dirs.

### Coverage notes

The suite is strong on session CRUD, guard-mode logic, adapters, gateway
concurrency, skill curator, and memory. Gaps to be aware of (see the review
report):

- The workbench model-call streaming paths (`_call_anthropic_workbench`,
  `_call_openai_workbench`) are **not** exercised end-to-end — they require a
  live or mocked upstream stream.
- The `/api/health` route collision (registered by both `main.py` and
  `monitoring.py`) is not covered because the test client resolves it
  differently than the live app.

---

## Project conventions

### Naming

- **camelCase for all identifiers** throughout the codebase: Python function
  names, variables, parameters, class attributes, and JSON/API fields.
- Constants are `UPPER_SNAKE`.
- Private-by-convention names use a leading underscore (`_privateName`).
- External API boundary files (`adapters/`) translate between internal
  `camelCase` and the external wire format via `case_converters.py`.
- **Underscores are NOT used as word separators** in Python code.
  Notable exceptions (never renamed):
  - Python dunder methods: `__init__`, `__str__`, etc.
  - Pytest test discovery: `test` prefix (e.g., `testHealth`)
  - Environment variable names: `AUGUST_DATA_DIR`

### Structure

- Routers live in `app/routers/` and are registered in `main.py`.
- Services live in `app/services/`; large subsystems get a subpackage
  (`workbench/`, `gateway/`, `browser/`, `memory/`, `skills/`, `tools/`).
- Heavy cross-module imports are done lazily (inside functions) to avoid
  circular-import problems — especially `workbench.py`, which is imported by
  `subagent.py`, `session_bridge.py`, and several routers.

### Error handling

- Service-layer mutating functions raise `ValueError` / `KeyError` /
  `SkillValidationError`; routers translate these to HTTP 400/404.
- Tool handlers return JSON strings (`{"status": "success|error", ...}`),
  never raise — the workbench loop stringifies and feeds results back to the
  model.
- Background fire-and-forget tasks wrap their bodies in `try/except` so a
  failure in self-evolution or auto-memory never breaks the chat response.

### Persistence

- Config/aliases/fallback: `data/config.json` (JSON, atomically rewritten).
- Sessions: in-memory + `data/workbench-sessions.json` (last 50).
- Memory: `data/august_brain.sqlite` (SQLite, thread-local connection).
- Every config mutation is recorded via `memory_store.record_config_audit`.

### Datetimes

`datetime.utcnow().isoformat() + "Z"` is the established pattern (see
`workbench._now`, `scheduler._now`). Note: `utcnow()` is deprecated in Python
3.12+; new code should prefer `datetime.now(timezone.utc)`.

### Type safety

- **Python — no `Any` in new code.** Use `TypedDict` from
  `app/type_aliases.py` for JSON row shapes, `JsonValue` for genuinely
  heterogeneous JSON, and concrete primitives / `datetime` /
  Pydantic models where they apply. The repo runs `mypy` in CI;
  warnings block merge.
- **TypeScript — no `any` in new code.** ESLint
  (`@typescript-eslint/no-explicit-any: error`) blocks new `any`
  in CI. Use `unknown` + narrowing for runtime data, concrete
  interfaces from `@/types/*`, and Zod schemas at the API boundary.
- **`catch (e: any)` is forbidden.** Always `catch (e)` (which is
  `unknown` under strict mode) and narrow with `instanceof Error`:
  ```ts
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    toast.error('...', { description: message });
  }
  ```
- **AbortError detection** uses `e instanceof Error && e.name === 'AbortError'`.
- **Vendor globals** (`SpeechRecognition`, `__TAURI_INTERNALS__`,
  `hljs`) live in `src/types/dom.d.ts` as `Window` augmentations.
  Never use `(window as any).X` — import the augmentation.
- **Shared domain types** live in `src/types/chat.ts`,
  `src/types/workbench.ts`, and `src/api/schemas/*.ts`. Don't
  duplicate definitions — import and (if needed) re-export.
- **Zod schemas at the API boundary.** When you write a new fetcher
  in `src/api/*`, add a Zod schema in `src/api/schemas/*` and call
  `safeParse` to log drift warnings. Drift warnings are the signal
  to update either the schema or the TS interface.
- **Workbench SSE events** must round-trip through
  `WorkbenchEventSchema` (see `src/api/schemas/workbench.ts`). The
  schema and the `WorkbenchEvent` type are kept in sync by hand;
  adding a new variant requires updating both.

---

## Adding a new provider

1. Create `app/providers/<name>.py` with a provider definition dict (`name`,
   `base_url`, `api_mode`, `env_vars`, `model_profiles`).
2. Register it in `app/providers/builtin.py`.
3. If it needs a bespoke client, add `app/providers/clients/<name>.py`
   subclassing `BaseProviderClient`; otherwise the generic OpenAI/Anthropic
   client is used via `getClient` (clients are pooled by id + apiMode + baseUrl).
4. Run `python scripts/gen_providers.py` to regenerate catalog data if needed.
5. Add the API-key env var to `.env.example`.
6. Add a unit test that `getClient({...})` returns the expected class.

See `app/providers/anthropic.py` and `app/providers/openai_api.py` for examples.

---

## Adding a new workbench tool

1. Prefer a new (or existing) module under
   `app/services/tool_registrations/<group>_tools.py`.
2. Write an **async** handler that returns a **string** (JSON or plain text).
   Pattern: `app/services/tool_registrations/skill_tools.py`.
3. In that module's `register()`, call `tool_registry.register(name, description,
   parameters=<JSON Schema>, handler=...)`.
4. Ensure `tool_registrations/__init__.py` → `register_all()` calls your group
   (already true for the standard groups).
5. **Do not** edit the workbench chat loop for normal tools — dispatch is
   registry-based. Only orchestration-only hooks belong in `workbench.py`.
6. If the tool is **mutating**, ensure plan/ask guards cover it
   (`_checkToolGuard` / managed tool policy).
7. If it is **read-only** and safe for concurrent rounds, consider adding the
   name to `PARALLEL_SAFE_TOOLS` in `workbench/parallel_tools.py`.
8. Add tests under `tests/` (handler + optional registry round-trip).
9. Tool JSON caches invalidate via `tool_registry.generation()` — no manual
   cache bust required after `register`/`unregister`.

---

## Adding a new gateway platform

1. Create `app/services/gateway/platforms/<name>.py` subclassing
   `BasePlatformAdapter`. Implement `connect`, `disconnect`, `send_message`,
   `get_chat_info`, and `normalize` (raw platform payload → `MessageEvent`).
2. Register the factory in `app/routers/gateway.py` (wrap in `try/except
   ImportError` so the app still boots without the SDK).
3. Add any webhook route if the platform is webhook-based (see the Telegram
   webhook route for the pattern).
4. Add bot-token env vars to `.env.example` and document the config block in
   `CONFIGURATION.md`.
5. Add tests modelled on `tests/test_gateway_base.py` and
   `tests/test_gateway_telegram.py`.

The base class provides the two-guard ingest dispatch (queueing + bypass
commands) and the session bridge wiring, so subclasses only implement the
platform surface.

---

## Adding a UI panel / settings section

1. **Settings section:** add an entry to
   `frontend/desktop/src/settings/settings-registry.ts`
   (`id`, `label`, `icon`, component). Routes and sidebar derive from the registry.
2. **Full section route:** add a lazy-loaded page under `sections/` and register
   it in `frontend/desktop/src/routes.ts` (prefer `lazy(() => import(...))` so
   chat stays on the critical path).
3. **API:** add a router under `backend-py/app/routers/` and include it from
   `main.py` if new HTTP surface is required.
4. **State:** use a dedicated Zustand slice or React Query keys; avoid
   subscribing components to the entire sessions store.
5. **Types:** Zod schema in `src/api/schemas/*` + TS types; no new `any`.
6. Smoke: open the route in dev, confirm code-split chunk loads and panel renders.

---

## Adding a background daemon

1. Implement a tick/handler module (see existing daemons under
   `app/services/` and `daemon_manager`).
2. Register with `daemon_manager` and gate behind a config flag.
3. Respect the session/daemon **cap** and backoff schedule (load-tested;
   do not raise caps without a new contention check).
4. Writes go through `db_writer` / memory_store APIs — no ad-hoc SQLite writers.
5. Add a unit test for registration + one tick in isolation.

---

## Extension checklists (≤30 min stubs)

Use these as a stub exercise when adding an extension point. Target: a no-op
feature in under half an hour without touching the chat loop body.

### Checklist — stub tool

- [ ] New handler in `tool_registrations/*_tools.py` (or temp test register)
- [ ] `tool_registry.register(...)` with JSON Schema
- [ ] `pytest` that `dispatch` / handler returns expected string
- [ ] (Optional) add name to `PARALLEL_SAFE_TOOLS` only if read-only
- [ ] No edits to `workbench.py` chat loop

**Exercised:** `tests/test_phase_p_remaining.py` + tool registry generation /
cache tests prove register → list → invalidate without chat-loop edits.

### Checklist — stub provider client

- [ ] Client class or reuse OpenAI/Anthropic via `apiMode`
- [ ] Builtin entry + `getClient` returns type
- [ ] Pool reuse: two `getClient` same key → same instance
- [ ] Test in `tests/test_clients.py` style

**Exercised:** `test_client_pool_reuses_instance` in `test_phase_p_remaining.py`.

### Checklist — stub settings panel

- [ ] Registry entry + lazy section component
- [ ] No change to ChatThread
- [ ] Path appears under `/settings/:section`

**Exercised:** settings routes already registry-driven; Settings/Brain/Live are
lazy-loaded in `routes.ts`.

---

## Debugging

- **Request inspector**: `GET /api/requests` and `/api/requests/{id}` show
  tracked request bodies, responses, thinking, and tool calls.
- **Activity log**: `GET /api/activity`.
- **Event log files**: `data/chat_events_<session>.log` hold the raw SSE
  events per workbench session.
- **Verbose uvicorn logs**: `uvicorn app.main:app --log-level debug`.
- **Stale state**: delete `data/workbench-sessions.json` to reset workbench
  sessions, or `data/august_brain.sqlite` to reset memory (the DB is recreated
  on next start).
- **Perf traces:** `GET /api/perf/recent` when `AUGUST_PERF_TIMING=1`.
- **Frontend stream marks:** `localStorage.august_stream_perf=1`.

---

## Performance knobs

| Env / flag | Effect |
|---|---|
| `AUGUST_PERF_TIMING=1` | Structured workbench timings + `/api/perf/recent` |
| `AUGUST_P1_TOOL_CACHE=0` | Disable tool definition list cache |
| `AUGUST_P1_PROMPT_CACHE=0` | Disable prompt segment / skills catalogue cache |
| `AUGUST_P1_PARALLEL_TOOLS=0` | Force serial tool execution (no read-only gather) |
| `AUGUST_SQLITE_CACHE_KB` | **Opt-in** page cache KiB (unset = SQLite default; no silent NORMAL/sync change) |
| `AUGUST_SQLITE_MMAP_MB` | **Opt-in** mmap MiB |
| `AUGUST_SQLITE_SYNC` | **Opt-in** only: `NORMAL` / `FULL` / `OFF`. Default leaves SQLite **FULL**. `NORMAL` under WAL can lose the last uncheckpointed txn on hard power loss — measure before enabling |
| `AUGUST_DB_WRITER_LOW_DROP_S` | Age (seconds) before low-pri queue items are dropped |

Stage boundaries: `app/services/workbench/chat_stages.py` (tool batch + post-turn).
SSE coalesce: `app/lib/batched_emit.py` (first token immediate; later chunks by size **or** ~12 ms).
DB writer lag: `GET /api/perf/db-writer`.
FTS: use table-level `MATCH` (see `search_memory` / auto_memory JOIN).
