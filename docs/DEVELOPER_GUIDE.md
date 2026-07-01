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
9. [Debugging](#debugging)

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
  `app/typeAliases.py` for JSON row shapes, `JsonValue` for genuinely
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
   client is used.
4. Run `python scripts/gen_providers.py` to regenerate catalog data if needed.
5. Add the API-key env var to `.env.example`.

See `app/providers/anthropic.py` and `app/providers/openai_api.py` for examples.

---

## Adding a new workbench tool

1. Write an async handler returning a JSON string (see
   `app/services/browser/handlers.py` for the `_ok`/`_err` pattern).
2. Register it in a `register()` function called from
   `app/services/tool_definitions.py` → `register_all()` (invoked at startup
   in `main.py` lifespan). Provide a name, description, handler, and JSON-Schema
   `parameters`.
3. If the tool is mutating, decide whether it should be blocked in plan/ask
   mode and update `is_plan_mode_blocked()` in `workbench.py` accordingly.
4. Add tests under `tests/`.

Tools are dispatched by `app/services/tool_registry.dispatch(name, args)`; the
workbench sets `current_session_id` before dispatch so per-session state (e.g.
browser page) is available via `workbench/context.py`.

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
