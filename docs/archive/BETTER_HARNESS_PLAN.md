# August Proxy — Better Harness Implementation Plan

> **Status:** ALL 6 PHASES SHIPPED — per-feature checkboxes reconciled with the code (partials noted inline)
> **Created:** 2026-07-29
> **Total Features:** 46 across 6 phases
> **Tracking:** Check `[x]` as features are implemented and verified

---

## Table of Contents

- [Phase 1: Foundation (8 features)](#phase-1-foundation)
- [Phase 2: Agent Runtime (6 features)](#phase-2-agent-runtime)
- [Phase 3: Intelligence (9 features)](#phase-3-intelligence)
- [Phase 4: Product Features (8 features)](#phase-4-product-features)
- [Phase 5: UX & Onboarding (8 features)](#phase-5-ux--onboarding)
- [Phase 6: Developer Velocity (7 features)](#phase-6-developer-velocity)
- [Resolved Pre-conditions](#resolved-pre-conditions)
- [Validation Strategy](#validation-strategy)
- [Dependency Graph](#dependency-graph)

---

## Phase 1: Foundation

**Goal:** Structural stability — prevent crashes, data loss, and silent failures.
**Dependencies:** None. Enables all subsequent phases.
**Phase Gate:**
1. `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q`
2. `npm run test:frontend`
3. Live smoke: start backend → `GET /api/health` returns 200 with `X-August-Request-Id` header; verify `memory_store_fts_docsize` count == `memory_store` count after boot.

---

### 1.1 Granular Error Boundaries

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** One `ErrorBoundary` in `AppShell.tsx` wraps all 27 sections. A crash in Traffic, Brain, or any section takes down the entire UI → user sees "Something went wrong" + reload.

**Implementation:**

| File | Action |
|------|--------|
| `frontend/desktop/src/components/SectionBoundary.tsx` | **Create** — reusable boundary with section name, error display, [Retry] and [Go to Chat] buttons |
| `frontend/desktop/src/routes.ts` | **Modify** — wrap each `React.lazy()` element in `<SectionBoundary name="...">` |
| `frontend/desktop/src/components/ErrorBoundary.tsx` | **Keep** — remains as top-level catch-all for shell-level crashes |

**Component contract:**
```tsx
interface SectionBoundaryProps {
  name: string;           // "Traffic", "Brain", "Skills", etc.
  fallback?: ReactNode;   // optional custom fallback
  children: ReactNode;
}
```

Fallback UI: centered card with section name, error message (truncated to 200 chars), [Retry] button (re-mounts children via key increment), [Go to Chat] link (navigates to `/`).

**Test:** `frontend/desktop/src/components/__tests__/SectionBoundary.test.tsx`
- Renders children normally when no error
- Shows fallback with section name on child throw
- Retry button re-mounts children (error cleared)
- Go to Chat navigates to `/`
- Does NOT catch errors in sibling boundaries

---

### 1.2 Centralized Logging Configuration

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** No `dictConfig`/`basicConfig`. Log levels depend on defaults. The WS handler is the only explicitly leveled piece. No request correlation across proxy → adapter → provider.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/lib/logging_config.py` | **Create** — `setup_logging()` with structured JSON formatter, per-module overrides |
| `backend-py/app/lib/tracing.py` | **Create** — `request_id` contextvar + middleware (landed here; also carries the timing waterfall, see 6.4) |
| `backend-py/app/main.py` | **Modify** — call `setup_logging()` at top of lifespan; add correlation middleware |

**Structured log format:**
```json
{"ts": "2026-07-29T10:00:00Z", "level": "INFO", "module": "app.providers", "request_id": "uuid", "msg": "..."}
```

**Per-module overrides:** `AUGUST_LOG_LEVELS=providers:DEBUG,adapters:WARNING,sandbox:ERROR`
- Parsed at startup into `logging.getLogger(module).setLevel(level)`
- Default: INFO for all

**Request correlation middleware:**
- Assigns `X-August-Request-Id: <uuid4>` to every incoming request
- Stores in `contextvars.ContextVar` for access by any module
- Includes in all log records via a `logging.Filter`
- Propagates to upstream provider calls as `X-August-Request-Id` header

**Wire existing WS handler:** The `WebSocketLogHandler` in `main.py` attaches to root logger — now receives structured records.

**Test:** `backend-py/tests/test_logging_config.py`
- JSON format output with all fields
- Level overrides from env var
- Request ID appears in log records within middleware context
- Missing env var → all INFO default

---

### 1.3 SQLite Migration Framework

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** Schema evolution is ad-hoc in `ensure_schema()`. A missed migration = corrupt brain DB = user data loss. No versioning, no rollback safety.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/lib/migrations.py` | **Create** — migration runner |
| `backend-py/app/migrations/__init__.py` | **Create** |
| `backend-py/app/migrations/001_baseline.sql` | **Create** — captures current schema as baseline (no-op if tables exist) |
| `backend-py/app/services/memory_schema.py` | **Modify** — `ensure_schema()` calls `run_migrations(conn)` instead of inline DDL |

**Migration runner contract:**
```python
def run_migrations(conn: sqlite3.Connection) -> None:
    """Apply pending migrations in order. Idempotent. Called every boot."""

# schema_migrations table:
# CREATE TABLE IF NOT EXISTS schema_migrations (
#     version INTEGER PRIMARY KEY,
#     name TEXT NOT NULL,
#     applied_at TEXT NOT NULL DEFAULT (datetime('now'))
# );
```

**Rules:**
- Migrations are numbered `.sql` files in `app/migrations/`
- Each is idempotent (`IF NOT EXISTS`, `IF EXISTS` guards)
- Runner applies in numeric order, skips already-applied
- Runs inside existing lifespan try/except (fail → app still starts, logs error)
- `PRAGMA user_version` kept in sync as secondary indicator

**Test:** `backend-py/tests/test_migrations.py`
- Applies from scratch (empty DB → all tables created)
- Idempotent re-run (no error on second call)
- Version tracking (schema_migrations populated)
- Out-of-order detection (warns if file missing)
- Baseline migration doesn't destroy existing data

---

### 1.4 Version-Sync Check

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** AGENTS.md documents 4 files that must stay in sync. Humans forget. No automated check.

**Implementation:**

| File | Action |
|------|--------|
| `scripts/check-version-sync.mjs` | **Create** — reads all 4 version files, compares, exits 1 on mismatch |
| `package.json` | **Modify** — add `"check:version": "node scripts/check-version-sync.mjs"` to scripts |

**Files checked:**
1. `package.json` → `.version`
2. `frontend/desktop/package.json` → `.version`
3. `frontend/desktop/src-tauri/tauri.conf.json` → `.version`
4. `frontend/desktop/src-tauri/Cargo.toml` → `version = "..."` line

**Output on mismatch:**
```
ERROR: Version mismatch detected!
  package.json:                    0.12.44
  frontend/desktop/package.json:   0.12.44
  tauri.conf.json:                 0.12.43  ← MISMATCH
  Cargo.toml:                      0.12.44
All 4 files must have the same version before committing.
```

**Test:** Manual verification + add to CI workflow as a step.

---

### 1.5 Golden Contract Tests for Upstream Serialization

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** `dump_openai_upstream_body` / `dump_anthropic_upstream_body` are documented as "a wrong key breaks all chat." The 0.12.21 `session_id: null` incident was caused by a serialization change with no visible diff.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/tests/golden/` | **Create dir** — 6 JSON golden files |
| `backend-py/tests/test_upstream_golden.py` | **Create** — loads golden files, compares to actual output |

**Golden files (6):**
1. `openai_basic.json` — simple chat, no tools, no nulls
2. `openai_with_tools.json` — chat with tool definitions
3. `openai_null_strip.json` — request with `session_id=None`, `stream=True` → verifies nulls stripped
4. `anthropic_basic.json` — simple messages, system prompt
5. `anthropic_with_tools.json` — messages with tool_use blocks
6. `anthropic_null_strip.json` — request with optional nulls → verifies exclude_none

**Test pattern:**
```python
def test_openai_basic_golden():
    req = ChatCompletionRequest(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
    body = dump_openai_upstream_body(req)
    golden = json.loads(GOLDEN_DIR.joinpath("openai_basic.json").read_text())
    assert body == golden, f"Serialization drift! Diff: {deep_diff(golden, body)}"
```

**Regeneration:** `pytest tests/test_upstream_golden.py --update-golden` flag writes new golden files (for intentional changes).

---

### 1.6 Coverage Gates

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** 166 backend tests + 88 frontend tests, but zero visibility into what's NOT covered. No threshold, no trend.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/pyproject.toml` | **Modify** — add `pytest-cov` to dev deps; add `[tool.pytest.ini_options] addopts = "--cov=app --cov-report=term-missing --cov-fail-under=55"` |
| `frontend/desktop/vitest.config.ts` | **Modify** — add `coverage: { provider: 'v8', thresholds: { statements: 45 } }` |
| `frontend/desktop/package.json` | **Modify** — add `@vitest/coverage-v8` devDep; change test script to include `--coverage` |
| `frontend/desktop/eslint.config.js` | **Modify** — change `--max-warnings=700` → `--max-warnings=600` |
| `.github/workflows/type-check.yml` | **Modify** — ensure coverage flags in CI steps |

**Ratchet policy:** Coverage thresholds only go UP. Each release reviews and bumps by 2-5%.

---

### 1.7 db_writer Shutdown Drain Fix

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** `shutdown()` docstring promises "Cancel the worker and drain remaining items" but the code only cancels the worker — queued writes are silently lost on shutdown. (`db_writer.py:93-102`)

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/db_writer.py` | **Modify** — `shutdown()` drains queue before cancelling |

**Fix:**
```python
async def shutdown() -> None:
    """Cancel the worker and drain remaining items."""
    global _worker, _write_queue
    if _worker is None:
        return
    # Drain remaining items before cancelling
    if _write_queue is not None:
        while not _write_queue.empty():
            try:
                item = _write_queue.get_nowait()
                await _execute_write(item)
            except asyncio.QueueEmpty:
                break
            except Exception as exc:
                logging.warning('db_writer drain error: %s', exc)
    _worker.cancel()
    try:
        await _worker
    except asyncio.CancelledError:
        pass
    _worker = None
    _write_queue = None
```

**Test:** `backend-py/tests/test_db_writer_drain.py`
- Enqueue 5 writes → shutdown → all 5 executed
- Shutdown with empty queue → no error
- Drain error doesn't prevent shutdown completion

---

### 1.8 FTS5 Desync Repair

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

**Problem:** Live verification found `memory_store_fts` has 30 indexed docs but only 4 base rows. Stale entries from pre-trigger deletes. MATCH queries on stale rowids throw `fts5: missing row N from content table`. Existing safeguards miss this because `count(*)` on external-content FTS reads the content table, not the index.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory_schema.py` | **Modify** — add `repair_fts_sync()`, call in both warm and cold paths of `ensure_schema()` |

**Repair function:**
```python
_FTS_SYNC_MAP = (
    ('memory_store_fts', 'memory_store'),
    ('auto_memories_fts', 'auto_memories'),
    ('messages_fts', 'messages'),
)

def repair_fts_sync(conn: sqlite3.Connection) -> None:
    """Rebuild any FTS index whose docsize count diverges from its base table."""
    for fts, base in _FTS_SYNC_MAP:
        try:
            idx_n = conn.execute(f'SELECT count(*) FROM {fts}_docsize').fetchone()[0]
            base_n = conn.execute(f'SELECT count(*) FROM {base}').fetchone()[0]
            if idx_n == base_n:
                continue
            logging.warning('FTS desync %s: index=%s base=%s — rebuilding', fts, idx_n, base_n)
            conn.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
            conn.commit()
        except Exception as exc:
            logging.warning('FTS repair skipped for %s: %s', fts, exc)
```

**Placement:** Called in `ensure_schema()` warm path (before early return at ~line 525) AND cold path (after `_ensure_messages_fts`).

**Cost:** 6 tiny count queries per boot. Self-heals any future desync.

**Test:** `backend-py/tests/test_fts_repair.py`
- Simulate pre-trigger delete (insert FTS row, delete base row) → desync exists
- Call `repair_fts_sync()` → counts match
- MATCH query on deleted token returns 0 rows without error
- Already-synced tables → no rebuild triggered

---

## Phase 2: Agent Runtime

**Goal:** Programmable constraint layer — hooks that inspect, warn, or block tool execution.
**Dependencies:** Phase 1.2 (logging), Phase 1.3 (migrations for hook state).
**Phase Gate:**
1. Tests green
2. Live smoke: trigger a tool call via workbench → verify hook SSE events appear in stream; `GET /api/hooks/stats` returns timing data.

---

### 2.1 Lifecycle Hook System

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** No formal pre/post tool hook registry. Existing patterns are inline/hardcoded: `post_observation.capture_after_tool` (screenshots only), `checkpoint_service` (before mutations), `ToolCallTracker` (loop detection), `_checkToolGuard` (permissions). No extensibility.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/__init__.py` | **Create** — re-exports |
| `backend-py/app/services/hooks/types.py` | **Create** — `HookEvent`, `HookResult`, `HookContext` dataclasses |
| `backend-py/app/services/hooks/registry.py` | **Create** — `HookRegistry` singleton with register/unregister/emit |
| `backend-py/app/services/hooks/builtin.py` | **Create** — registers built-in hooks at startup |
| `backend-py/app/services/workbench/workbench.py` | **Modify** — wire `emit(PRE_TOOL_USE)` before `_executeTool`, `emit(POST_TOOL_USE)` after |
| `backend-py/app/routers/hooks.py` | **Create** — `GET /api/hooks` (list), `GET /api/hooks/stats` (timing) |

**Types:**
```python
class HookEvent(Enum):
    SESSION_START = "session_start"
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    STOP = "stop"
    PRE_MODEL_CALL = "pre_model_call"

@dataclass
class HookContext:
    event: HookEvent
    tool_name: str | None
    tool_args: dict | None
    tool_result: str | None      # POST only
    session_id: str
    workspace_path: str | None

@dataclass
class HookResult:
    action: Literal['allow', 'deny', 'modify']
    message: str | None = None   # shown to user/model
    data: dict | None = None     # SSE payload
    modified_args: dict | None = None  # for 'modify' action
```

**Registry contract:**
```python
class HookRegistry:
    def register(self, name: str, event: HookEvent, handler: HookHandler,
                 matcher: str = "*", priority: int = 100) -> None
    def unregister(self, name: str) -> None
    async def emit(self, event: HookEvent, ctx: HookContext) -> list[HookResult]
    def stats(self) -> dict  # per-hook: call_count, p95_ms, deny_count, breaker_state
```

**Execution rules:**
- Hooks run in priority order (lower = first)
- Matcher is a fnmatch pattern on tool_name (e.g. `"write_file|edit_file"`)
- Async handlers, 5s timeout per hook
- On timeout: log warning, increment breaker counter, return `allow` (fail-open)
- Circuit breaker: 3 consecutive timeouts → disable hook for 60s
- First `deny` short-circuits (no further hooks run)
- `modify` results are chained (each hook sees previous modifications)

**Wiring in workbench.py:**
- `PRE_TOOL_USE`: after `_checkToolGuard` passes, before `_executeTool`
- `POST_TOOL_USE`: after successful `_executeTool`, before `post_observation`
- `SESSION_START`: in session creation path
- `STOP`: before final assistant message is emitted

**Test:** `backend-py/tests/test_hook_registry.py`
- Registration + matching (fnmatch patterns)
- Priority ordering
- Deny short-circuits
- Modify chains
- Timeout → fail-open + breaker counter
- Breaker disables after 3 timeouts
- Stats endpoint returns correct data

---

### 2.2 Secret Guard Hook

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** The workbench agent can read/write files. Nothing prevents it from writing API keys into code or reading `.env` files into context (which then goes to upstream providers).

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/secret_guard.py` | **Create** — PRE_TOOL_USE + POST_TOOL_USE hook |

**PRE_TOOL_USE (matcher: `write_file|edit_file|create_file|run_command`):**
- Scan `tool_args.content` / `tool_args.command` against secret patterns:
  - OpenAI: `sk-[a-zA-Z0-9]{20,}`
  - Anthropic: `sk-ant-[a-zA-Z0-9-]{20,}`
  - AWS: `AKIA[0-9A-Z]{16}`
  - GitHub: `ghp_[a-zA-Z0-9]{36}`
  - Private keys: `-----BEGIN (RSA |EC )?PRIVATE KEY-----`
  - Generic: `[a-zA-Z_]*(key|secret|token|password)[a-zA-Z_]*\s*[:=]\s*['"][^'"]{8,}['"]`
- On match: return `deny` with message "Blocked: secret pattern detected in {tool_name}. Remove credentials before proceeding."
- NEVER log the actual matched value

**POST_TOOL_USE (matcher: `read_file|list_files`):**
- If `tool_args.path` matches protected patterns (`.env`, `providers.json`, `credentials`, `.ssh/`, `id_rsa`):
  - Return `modify` with `tool_result` redacted: replace values matching secret patterns with `[REDACTED]`

**Registration:** In `builtin.py` at priority 10 (runs before other hooks).

**Test:** `backend-py/tests/test_secret_guard.py`
- Detects OpenAI/Anthropic/AWS/GitHub key patterns in write content
- Allows clean content
- Blocks .env reads (redacts result)
- Never logs secret values (capture log output, assert no key present)
- Generic assignment pattern detection

---

### 2.3 Blast-Radius Scoring

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** No impact analysis before/after code changes. The agent can edit a core router with 14 callers and no test coverage without any warning.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/blast_radius.py` | **Create** — POST_TOOL_USE hook |
| `backend-py/app/services/impact_analysis.py` | **Create** — scoring engine |

**Scoring algorithm (0-100):**
```
base = 10 (any file write)
+ 20 if file is in core path (routers/, adapters/, services/sandbox/, lib/)
+ min(importer_count * 5, 30) — count files importing this module
+ 15 if no corresponding test file exists
+ 15 if file is >300 lines (complexity proxy)
+ 10 if file contains security-related patterns (auth, permission, secret, token)
```

**Importer counting:** Regex scan of workspace for `from {module} import` / `import {module}` patterns. Cached per session (invalidated on file write).

**Core path detection:** Configurable list, defaults:
```python
CORE_PATHS = ['app/routers/', 'app/adapters/', 'app/services/sandbox/', 'app/lib/', 'app/providers/']
```

**Test existence:** Check for `test_{name}.py` or `{name}_test.py` in `tests/` directory.

**SSE emission:** After scoring, emit event:
```json
{"type": "blastRadius", "score": 72, "file": "app/adapters/proxy_tools.py",
 "reasons": ["core path", "8 importers", "no test file"], "level": "high"}
```

**Thresholds:** ≥40 info, ≥60 warning toast, ≥80 "consider running tests before continuing."

**Registration:** POST_TOOL_USE, matcher `write_file|edit_file|create_file`, priority 50.

**Test:** `backend-py/tests/test_blast_radius.py`
- Core file scores higher than leaf file
- Importer counting (create temp files with imports)
- Test-existence detection
- Score capping at 100
- SSE event shape

---

### 2.4 Test-Mapping Gate

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** Agent changes critical files with no test coverage and no warning.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/test_mapping.py` | **Create** — POST_TOOL_USE hook |

**Logic:**
- For each written file, resolve candidate test paths:
  - Python: `tests/test_{stem}.py`, `tests/{stem}_test.py`
  - TypeScript: `src/**/__tests__/{stem}.test.ts(x)`, `src/**/{stem}.test.ts(x)`
- If source is in CRITICAL_PATHS (routers/, adapters/, services/sandbox/) AND no test exists:
  - Emit SSE warning: `"No test covers {file}. Consider adding one before shipping."`
- Non-blocking — never denies the tool call

**Registration:** POST_TOOL_USE, matcher `write_file|edit_file|create_file`, priority 60.

**Test:** `backend-py/tests/test_test_mapping.py`
- Python path resolution
- TypeScript path resolution
- Critical-path detection
- Warning emitted for untested critical file
- No warning for non-critical or tested file

---

### 2.5 Sensitive-Code Detection

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** Agent can write code touching auth boundaries, crypto, or destructive operations without any elevated awareness.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/sensitive_code.py` | **Create** — PRE_TOOL_USE hook |

**8 trigger categories (from better-harness `sensitive-code.md`):**
1. Plaintext secrets in code
2. Credential handling (auth flows, token refresh)
3. Identity/permission boundaries (RBAC, access control)
4. Sensitive data surface (PII, user data)
5. Execution boundaries (eval, exec, subprocess)
6. Cryptography/signatures
7. Release/supply chain (version bumps, publish)
8. Destructive/production operations (DROP, DELETE, rm -rf)

**Detection:** Regex patterns per category applied to `tool_args.content`/`tool_args.diff`.

**On trigger:** Emit SSE `sensitiveCodeWarning` with category + guidance. Non-blocking.

**Registration:** PRE_TOOL_USE, matcher `write_file|edit_file`, priority 20.

**Test:** `backend-py/tests/test_sensitive_code.py`
- Pattern matching for each of 8 categories
- No false positives on benign code
- Multiple categories can trigger simultaneously

---

### 2.6 Hook Performance Budgets

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** timing telemetry + GET /api/hooks/stats exist; no explicit budget enforcement


**Problem:** If hooks get slow, the entire chat loop degrades. No monitoring, no circuit breaker.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/hooks/registry.py` | **Modify** — add timing, breaker, stats |
| `backend-py/app/routers/hooks.py` | **Modify** — `GET /api/hooks/stats` endpoint |

**Budgets:**
- p95 target: ≤500ms for PRE/POST_TOOL_USE hooks
- p95 target: ≤2000ms for SESSION_START/STOP hooks
- Circuit breaker: 3 consecutive timeouts (5s) → disable hook for 60s → auto-re-enable

**Stats endpoint response:**
```json
{
  "hooks": [
    {"name": "secret_guard", "event": "pre_tool_use", "calls": 142,
     "p95_ms": 12, "deny_count": 2, "breaker_state": "closed"},
    {"name": "blast_radius", "event": "post_tool_use", "calls": 98,
     "p95_ms": 245, "deny_count": 0, "breaker_state": "closed"}
  ]
}
```

**Test:** `backend-py/tests/test_hook_performance.py`
- Timing recorded per hook call
- p95 calculation correct
- Breaker trips after 3 timeouts
- Breaker auto-resets after 60s
- Stats endpoint shape

---

## Phase 3: Intelligence

**Goal:** Make August learn from sessions, track memory effectiveness, detect patterns, and gate skill creation.
**Dependencies:** Phase 1.3 (migrations), Phase 2.1 (hooks for evidence states).
**Phase Gate:**
1. Tests green
2. Live smoke: create memory → lifecycle event recorded; trigger tool failure → friction event; **write memory then near-duplicate → assert merged/skipped not duplicated**; `GET /api/brain/friction` + `GET /api/brain/memory-lifecycle` return data.

---

### 3.1 Memory Lifecycle Tracking

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** August stores memories but has no idea if they're ever retrieved, applied, or effective. Count ≠ value.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/migrations/002_memory_lifecycle.sql` | **Create** — new table |
| `backend-py/app/services/memory/lifecycle.py` | **Create** — event recording + stats |
| `backend-py/app/services/memory/auto_memory.py` | **Modify** — record `retrieved` on `getRelevantMemories()` |
| `backend-py/app/services/memory/background_review.py` | **Modify** — record `applied` when reflection references a memory |
| `backend-py/app/services/consolidation_daemon.py` | **Modify** — mark 30-day-unretrieved as `stale` |
| `backend-py/app/routers/brain.py` | **Modify** — `GET /api/brain/memory-lifecycle` endpoint |

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS memory_lifecycle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_key TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('created','retrieved','applied','effective','stale')),
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_key ON memory_lifecycle(memory_key);
CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON memory_lifecycle(event);
```

**Endpoint response:**
```json
{
  "memories": [
    {"key": "user_prefers_uv", "created": "2026-07-01", "retrieved_count": 12,
     "applied_count": 9, "last_retrieved": "2026-07-28", "state": "active"},
    {"key": "old_fact", "created": "2026-05-01", "retrieved_count": 0,
     "applied_count": 0, "last_retrieved": null, "state": "stale"}
  ]
}
```

**Test:** `backend-py/tests/test_memory_lifecycle.py`
- Event recording (created on save, retrieved on search)
- Stale detection (30 days no retrieval)
- Stats aggregation
- Endpoint shape

---

### 3.2 Friction Attribution

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** When things go wrong, there's no structured record of WHY. Users can't tell if failures are from the provider, missing context, model limitations, or tool bugs.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/migrations/003_friction_events.sql` | **Create** |
| `backend-py/app/services/memory/friction.py` | **Create** — recording + aggregation |
| `backend-py/app/services/workbench/chat_stages.py` | **Modify** — record TOOL friction on tool errors |
| `backend-py/app/services/workbench/workbench.py` | **Modify** — record PROVIDER friction on retries |
| `backend-py/app/services/memory/background_review.py` | **Modify** — LLM classifies friction category |
| `backend-py/app/routers/brain.py` | **Modify** — `GET /api/brain/friction` endpoint |

**Categories:**
```python
class FrictionCategory(str, Enum):
    PROVIDER = "provider"       # timeout, auth, rate-limit, 5xx
    HARNESS = "harness"         # missing context, skill, rule, AGENTS.md gap
    MODEL = "model"             # wrong approach, hallucination, loop
    REQUIREMENT = "requirement" # ambiguous goal, unclear acceptance
    TOOL = "tool"               # tool execution failure, wrong args
    EXTERNAL = "external"       # network, OS, filesystem
    COMPLEXITY = "complexity"   # inherently hard task, no single cause
```

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS friction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    category TEXT NOT NULL,
    detail TEXT,
    tool_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_friction_session ON friction_events(session_id);
CREATE INDEX IF NOT EXISTS idx_friction_category ON friction_events(category);
```

**Recording sources:**
- `chat_stages.py` tool error → `TOOL` with tool_name + error snippet
- `workbench.py` provider retry → `PROVIDER` with status code
- `background_review.py` frustration=true → LLM classifies into category

**Endpoint:** `GET /api/brain/friction?since=7d` → aggregated counts + daily trend.

**Test:** `backend-py/tests/test_friction.py`
- Recording from tool errors
- Recording from provider retries
- Aggregation by category and time window
- Endpoint shape

---

### 3.3 Repeated Workflow Detection

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** Users repeat the same multi-step workflows across sessions. August doesn't notice or offer to automate them.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory/workflow_detection.py` | **Create** |
| `backend-py/app/services/consolidation_daemon.py` | **Modify** — call detection in cycle |
| `backend-py/app/routers/brain.py` | **Modify** — `GET /api/brain/workflow-candidates` |

**Algorithm:**
1. During consolidation (24h cycle), load last 30 sessions' `session_topics` + first user message
2. Embed first messages using `vector_db` (auto_memory namespace)
3. Cluster by: same topic AND cosine similarity > 0.75 on first message
4. For clusters with ≥3 sessions: extract common tool sequence (from `episodic_timeline`)
5. If ≥50% of sessions share a similar tool sequence → workflow candidate

**Output (stored in KV `workflow_candidates`):**
```json
[{
  "id": "wf_debug_500",
  "name": "Backend 500 diagnosis",
  "session_ids": ["s1", "s2", "s3", "s4"],
  "common_steps": ["read logs", "grep error", "identify cause", "fix", "run tests"],
  "confidence": 0.82,
  "detected_at": "2026-07-29"
}]
```

**False-positive firewall (from better-harness):**
- Generic verbs (fix, analyze, review) alone are insufficient
- Retries/copied history count as one session
- Require stable input shape, not just shared words

**Endpoint:** `GET /api/brain/workflow-candidates` → list with [Create Skill] action.

**Test:** `backend-py/tests/test_workflow_detection.py`
- Clustering with similar sessions → candidate produced
- Dissimilar sessions → no candidate
- Minimum threshold (3 sessions) enforced
- False-positive filtering (generic verbs rejected)

---

### 3.4 Skill Quality Scoring

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** skill quality scoring exists (services/skills/quality.py); qualityScore enrichment in GET /api/skills not wired


**Problem:** Skills have no quality signal. A skill with no trigger, 2-line body, and zero uses looks the same as a well-crafted one.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/skills/quality.py` | **Create** |
| `backend-py/app/services/skills/curator.py` | **Modify** — store scores in .usage.json |
| `backend-py/app/routers/skills.py` | **Modify** — enrich GET response with qualityScore |

**Scoring (0-100, 5 dimensions):**

| Dimension | Weight | Criteria |
|---|---|---|
| Discovery | 20 | Has trigger text, description ≤60 chars, category set, name valid |
| Effectiveness | 30 | use_count > 0 (+10), recent use <30d (+10), no failures after use (+10) |
| Completeness | 20 | Body >200 chars (+5), has numbered steps (+5), has expected output (+5), has failure guidance (+5) |
| Freshness | 15 | Created/patched within 90 days (+15), within 180 days (+8) |
| Safety | 15 | No `rm -rf`/`DROP`/`--force` in body (+8), bounded scope (no "all files") (+7) |

**Storage:** Extend `SkillUsageRecord` in `.usage.json` with `qualityScore: int` and `qualityBreakdown: dict`.

**Recalculation:** On curator hourly cycle + on skill patch.

**Test:** `backend-py/tests/test_skill_quality.py`
- Good skill scores >70
- Empty/stale skill scores <30
- Dimension breakdown correct
- Safety deductions for dangerous patterns

---

### 3.5 Evidence States for Agent Claims

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** 3-state tracker exists (services/evidence.py); not yet wired into the workbench tool loop


**Problem:** Agent says "I fixed the bug" but didn't run any test. Users can't distinguish verified claims from assertions.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/evidence.py` | **Create** — state classifier |
| `backend-py/app/services/workbench/workbench.py` | **Modify** — track verification tools per turn, emit SSE |
| Frontend chat message component | **Modify** — show badge |

**States:**
```python
class EvidenceState(str, Enum):
    VERIFIED = "verified"       # test/lint/build ran AFTER mutation and passed
    UNVERIFIED = "unverified"   # mutation happened, no verification followed
    READ_ONLY = "read_only"     # no mutations in this turn
```

**Classification logic (per assistant turn):**
1. Track: did any mutating tool run? (write_file, edit_file, run_command with mutation)
2. Track: did any verification tool run AFTER the last mutation? (run_command matching test/lint/build patterns)
3. If mutation + verification → `verified`
4. If mutation + no verification → `unverified`
5. If no mutation → `read_only`

**SSE emission:** At end of turn, emit `{"type": "evidenceState", "state": "verified", "verificationTool": "run_command", "verificationOutput": "12 tests passed"}`

**Frontend:** Badge on assistant message: ✅ Verified (green) | ⚠️ Unverified (amber) | no badge for read-only.

**Test:** `backend-py/tests/test_evidence.py`
- Mutation + test → verified
- Mutation + no test → unverified
- No mutation → read_only
- Verification before mutation doesn't count (order matters)

---

### 3.6 Skill Creation Approval Gate

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** `background_review.py` creates/patches skills autonomously with NO human approval. The `pending_skills` table exists but isn't used by the reflection path.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory/background_review.py` | **Modify** — route skill creation to `pending_skills` instead of direct `createSkill` |
| `backend-py/app/services/skill_service.py` | **Modify** — `activatePendingSkill()` moves from pending to active |
| `backend-py/app/routers/brain_dashboard.py` | **Modify** — approve/reject endpoints use `activatePendingSkill` |

**Flow change:**
- Before: reflection → `skill_service.createSkill(...)` → immediately active
- After: reflection → `INSERT INTO pending_skills (name, description, trigger_text, draft_path, source_session_id, status='pending')` → user approves in Brain → Learning tab → `activatePendingSkill(name)` → `createSkill(...)` → active

**UI:** Brain → Learning tab already has "Pending Skills" with approve/reject buttons (wired to existing endpoints). Just needs the reflection path to feed it.

**Test:** `backend-py/tests/test_skill_approval.py`
- Reflection creates pending skill (not active)
- Approve → skill becomes active
- Reject → skill deleted from pending
- Pending skill not in `list_skills()` until approved

---

### 3.7a Vector Namespace Unification (Precondition)

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** Three namespaces (`default`, `auto_memory`, `semantic`). All live writes go to `auto_memory` but API defaults to `default`. Dead `semantic` collection code. Vector table never upserts (accumulates stale duplicates). Char-bag fallback embeddings produce false-positive similarities.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory/vector_db.py` | **Modify** — change default namespace to `auto_memory`, add upsert-by-key, remove dead collection code |

**Changes:**
1. `insert()` and `search()` default namespace → `'auto_memory'` (was `'default'`)
2. Add `upsert(text, metadata, namespace)`: delete existing row with same `metadata.key` before insert
3. `saveAutoMemory()` calls `upsert` instead of `insert`
4. Remove `addToCollection`, `searchCollection`, `createCollection` (zero callers, dead code)
5. Migrate legacy `default` entries: one-time `UPDATE vector_entries SET namespace='auto_memory' WHERE namespace='default'`

**Live verification requirement:** After implementation, run:
```python
vector_db.search("test query", namespace='auto_memory', top_k=5)
# Must return nonzero results against real data
```

**Encoder-aware threshold:** Store encoder type in KV. If `char_bag` fallback active, dedup threshold = 0.95 (very conservative). If MiniLM active, threshold = 0.80.

**Test:** `backend-py/tests/test_vector_unification.py`
- Default namespace is `auto_memory`
- Upsert replaces existing key (no duplicates)
- Search returns results from auto_memory
- Legacy migration moves default → auto_memory
- Dead code removed (no collection functions)

---

### 3.7b Real-Time Memory Dedup

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** exact-key upsert dedup exists; no vector-similarity near-duplicate search


**Problem:** Memories accumulate duplicates between consolidation cycles. No real-time check on creation.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory/auto_memory.py` | **Modify** — dedup check in `saveAutoMemory()` |

**Logic (in `saveAutoMemory` before insert):**
1. If key already exists (exact match) → upsert (already handled by SQL UPSERT)
2. For new keys: `vector_db.search(content, namespace='auto_memory', top_k=3)`
3. If any result has cosine > threshold AND `metadata.key != current_key`:
   - Log: "Near-duplicate detected: {new_key} ≈ {existing_key} (score={score})"
   - Skip creation, increment existing memory's importance by 0.1
   - Record lifecycle event: `retrieved` for the existing key (it was "found")
4. Threshold: 0.80 (MiniLM) or 0.95 (char-bag fallback)

**Test:** `backend-py/tests/test_memory_dedup.py`
- Exact key match → upsert (no duplicate)
- Near-duplicate content → skipped, existing importance bumped
- Dissimilar content → created normally
- Threshold respects encoder type

---

### 3.8 Asset Demand Reconciliation

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Problem:** Friction data (3.2) and workflow candidates (3.3) exist in isolation. Nothing joins them with configured assets to find coverage gaps.

**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/memory/reconciliation.py` | **Create** |
| `backend-py/app/routers/brain.py` | **Modify** — `GET /api/brain/coverage-gaps` |

**Logic (runs after consolidation):**
1. Load friction events (last 30d) grouped by category
2. Load workflow candidates
3. Load configured assets (skills list, heuristics, memory categories)
4. For each repeated friction/workflow:
   - Is there a skill that covers it? (trigger text match)
   - Is there a heuristic addressing it? (keyword match)
   - Is there a memory covering it? (topic match)
5. If no owner found → coverage gap

**Output:**
```json
{
  "gaps": [
    {"demand": "Repeated provider timeout friction (8 events)",
     "existing_coverage": null,
     "suggested_owner": "skill",
     "suggestion": "Create a retry/fallback skill for provider timeouts"},
    {"demand": "Workflow: debug backend 500 (4 sessions)",
     "existing_coverage": "heuristic: 'check logs first'",
     "suggested_owner": "extend_existing",
     "suggestion": "Extend heuristic into full diagnosis skill"}
  ]
}
```

**Test:** `backend-py/tests/test_reconciliation.py`
- Gap detected when demand exists but no asset covers it
- No gap when skill/heuristic covers demand
- Suggested owner follows smallest-owner ladder

---

## Phase 4: Product Features

**Goal:** User-facing features that make the harness visible and actionable.
**Dependencies:** Phase 3 data (friction, lifecycle, workflows, evidence).
**Phase Gate:**
1. Tests green
2. Live smoke: `GET /api/readiness?workspace=<real_path>` returns scores; provider health probes running; trigger provider error → actionable message shape.

---

### 4.1 Project Readiness Score

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/project_readiness.py` | **Create** |
| `backend-py/app/routers/readiness.py` | **Create** — `GET /api/readiness` |
| Frontend: workbench right-drawer panel | **Create** — `ReadinessPanel.tsx` |

**5 capabilities × L1-L5:**

| Capability | L1 | L3 | L5 |
|---|---|---|---|
| Context Map | README exists | AGENTS.md + architecture doc | Scoped instructions per directory |
| Environment Readiness | package.json exists | Scripts + doctor command | One-command setup + reset |
| Fast Feedback | No tests | Test command + lint | Affected-only routing + <30s feedback |
| Quality Gates | No CI | CI + type check | Required reviews + mechanical gates |
| Change Safety | Git only | Pre-commit hooks | Lifecycle guards + rollback + recovery |

**Detection:** File existence checks + content parsing (package.json scripts, Makefile targets, CI configs, hook dirs).

**Test:** `backend-py/tests/test_project_readiness.py`
- Empty directory → all L1
- Full project → L4-L5
- Partial project → mixed scores
- Endpoint shape

---

### 4.2 Connection Health Dashboard

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** backend health_monitor + GET /api/harness/health/providers exist; frontend ProviderStatusStrip not built


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/health_monitor.py` | **Create** — background probe task |
| `backend-py/app/routers/monitoring.py` | **Modify** — `GET /api/health/providers` |
| Frontend: sidebar component | **Create** — `ProviderStatusStrip.tsx` |

**Probe:** Every 60s, `probeUrl(provider.baseUrl + '/models')` with 5s timeout. Store last 50 results per provider in ring buffer.

**Status classification:**
- `healthy`: last 3 probes succeeded, avg latency <5s
- `degraded`: 1-2 of last 3 failed OR avg latency >5s
- `unreachable`: last 3 all failed

**Frontend:** Compact dots in sidebar (🟢🟡🔴 per provider). Click → popover with latency, last error, success rate.

**Test:** `backend-py/tests/test_health_monitor.py`
- Probe scheduling
- Status classification from probe history
- Ring buffer eviction
- Endpoint shape

---

### 4.3 Actionable Error Messages

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/lib/error_messages.py` | **Create** — mapping + action generation |
| `backend-py/app/services/workbench/workbench.py` | **Modify** — emit structured error SSE |
| Frontend chat component | **Modify** — render action buttons |

**Mapping:**
| Status | Message | Action |
|---|---|---|
| 401 | "API key rejected for {provider}." | `settings_link` → Providers |
| 429 | "Rate limited by {provider}. Retrying in {n}s." | `retry` with countdown |
| 404 (model) | "Model {model} not found on {provider}'s {format} endpoint." | `switch_format` |
| Timeout | "Connection to {provider} timed out ({n}s)." | `check_network` |
| 400 (known) | Pattern-specific guidance | contextual |

**SSE event:** `{"type": "errorMessage", "code": 429, "message": "...", "action": {"type": "retry", "delay_s": 30}}`

**Test:** `backend-py/tests/test_error_messages.py`
- Mapping for each status code
- Action generation
- Unknown errors → generic message

---

### 4.4 Feedforward/Feedback Bar

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** ContextBar.tsx exists but is not rendered; backend "feedforward" SSE event not emitted


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/workbench/workbench.py` | **Modify** — emit `feedforward` SSE at turn start |
| Frontend chat component | **Create** — `ContextBar.tsx` |

**Feedforward event (turn start):**
```json
{"type": "feedforward", "rules": 3, "skills": 2, "memories": 5, "heuristics": 8}
```

**Feedback (turn end, derived from evidence state 3.5):**
```json
{"type": "feedback", "verified": true, "tools_run": ["pytest", "ruff"], "issues": 0}
```

**Frontend:** Subtle bar above assistant response: "Loaded: 3 rules, 2 skills, 5 memories" + after: "Verified: pytest ✅ ruff ✅"

---

### 4.5 Sub-Agent Goal Completion

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** sub-agent spawn + spawn_subagents tool exist; no acceptance_criteria / stop_condition goal contract


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/services/workbench/subagent.py` | **Modify** — add goal contract to spawn |
| `backend-py/app/services/tools/spawn_subagents_tool.py` | **Modify** — accept new params |

**New spawn parameters:**
- `acceptance_criteria: str | None` — what "done" means
- `max_iterations: int = 20` — hard cap on tool rounds
- `stop_condition: str | None` — when to give up

**System prompt addition:**
```
GOAL CONTRACT:
- Acceptance: {acceptance_criteria}
- You MUST run verification (test/lint/build) before declaring success.
- Stop when: criteria met AND verification passed.
- If you cannot meet criteria in {max_iterations} rounds, report BLOCKED with reason.
```

**Completion event enrichment:** `{"evidence": "verified|unverified|blocked", "verification_tool": "pytest", "iterations_used": 7}`

**Test:** `backend-py/tests/test_subagent_goal.py`
- Prompt includes goal contract
- Iteration cap enforced
- Evidence state in completion

---

### 4.6 Project-Type Overlays

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:** Modify `project_readiness.py` to detect project shape and apply stricter evidence requirements:

| Shape | Detection | Extra requirement |
|---|---|---|
| Library/SDK | pyproject.toml with `[build-system]`, no app/ | API docs + semver |
| Frontend | package.json with react/vue/svelte | Visual testing + build |
| Backend/multi-service | FastAPI/Express + Dockerfile | Observability + health checks |
| Infrastructure | Terraform/k8s/Dockerfile-only | Plan/apply + rollback |

---

### 4.7 Recovery Evidence Tracking

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** checkpoint_service + rollback_store exist; no present→exercised evidence surfacing


**Implementation:** Formalize existing `checkpoint_service` + `rollback_store`:
- Track: was a checkpoint created? Was rollback exercised? Did it succeed?
- Evidence states: `present` (checkpoint exists) → `exercised` (rollback ran and succeeded)
- Show in workbench: "Last checkpoint: verified restorable" or "No checkpoint for this session"

---

### 4.8 Friendly API Protocol

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**

| File | Action |
|------|--------|
| `backend-py/app/lib/api_envelope.py` | **Create** — standard response envelope |
| All routers | **Modify** (incremental) — wrap responses |

**Envelope:**
```json
{"ok": true, "format_version": "1.0", "data": {...}}
{"ok": false, "format_version": "1.0", "error": {"code": "PROVIDER_NOT_FOUND", "message": "...", "hint": "..."}}
```

**Safe mutation protocol:** Destructive operations (delete session, clear memory) require:
1. `POST /api/sessions/{id}/delete-plan` → returns plan + confirmation token
2. `POST /api/sessions/{id}/delete-apply` with token → executes

**Backward compat:** Old shape available via `Accept: application/vnd.august.v0+json`.

---

## Phase 5: UX & Onboarding

**Goal:** Welcoming experience, stage-aware guidance, transparency into AI learning.
**Dependencies:** Phase 4 APIs (readiness, health, guidance).
**Phase Gate:**
1. Tests green
2. Live smoke: `GET /api/providers/detect` returns detected providers; `GET /api/guidance/next` returns steps; create automation without stop condition → rejected.

---

### 5.1 Graceful Degradation Mode

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:** Modify `BackendBootstrapGate.tsx`:
- 0-10s: normal spinner
- 10s: "Backend is taking longer than usual" + common fixes list
- 30s: [Run Diagnostics] button (calls doctor logic)
- Mid-session backend death: catch fetch/WS errors → "Reconnecting..." banner, read-only chat, auto-retry every 5s

---

### 5.2 First-Run Experience Improvements

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** provider_detect.py exists but has no /api/providers/detect endpoint


**Implementation:**
- `GET /api/providers/detect` → scan `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.
- Onboarding modal: "Detected {provider}! [Add with one click]" → auto-fill URL + format → fetch models → test → success animation
- On test failure: contextual troubleshooting based on error type (from 4.3)

---

### 5.3 Support Tracks

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**
- `GET /api/guidance/next` → based on readiness score (4.1):
  - <30 (Bootstrap): "Add AGENTS.md", "Configure a test command"
  - 30-70 (Operationalize): "Create your first skill", "Wire a pre-commit hook"
  - 70+ (Optimize): "Review workflow candidates", "Set up an automation"
- Frontend: dismissible cards on Overview section

---

### 5.4 Longitudinal Trends

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Note:** endpoint is GET /api/harness/trends (not /api/brain/trends)


**Implementation:**
- `harness_trends` table: weekly aggregation of friction counts, evidence verified-%, memory retrievals, skill invocations
- `GET /api/brain/trends?weeks=12` → time series
- Frontend: Brain → Activity tab sparklines

---

### 5.5 Consolidation Transparency

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** brain events emitted; no consolidation_audit table


**Implementation:**
- New `consolidation_audit` table: (action, target_key, reason, timestamp)
- Daemon records every merge/promote/delete
- Brain → Learning: "Last consolidation: merged 3, promoted 1, deleted 2" with expandable detail

---

### 5.6 Delta Engine Feedback

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** delta_engine exists (opt-in); no provisional state / Keep-Dismiss UI


**Implementation:**
- When delta engine infers a preference, store as `provisional` (not injected into prompts)
- Surface in Brain → Learning: "I noticed you prefer {X}. [Keep] [Dismiss]"
- On Keep → promote to active heuristic
- On Dismiss → delete + record negative signal

---

### 5.7 Automation Readiness Gate

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**
- 10-field contract enforced in automation creation API:
  1. Target (what it acts on)
  2. Trigger (when it fires)
  3. Run scope (bounded task description)
  4. Execution location (workspace path)
  5. Input pack (what context it needs)
  6. Sandbox mode (read-only/workspace-write/full)
  7. Validation (how to check it worked)
  8. Triage path (what to do on failure)
  9. Risk boundary (what it must NOT touch)
  10. Stop condition (when to stop iterating)
- Shell-type automations REQUIRE stop condition + sandbox mode
- UI wizard enforces field completion

---

### 5.8 Loop Spec Cards for Automations

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**
- Extend automation schema with spec card fields:
  - `when` (trigger), `see` (inputs/context), `do` (procedure), `check` (verification), `stop` (boundaries), `leave` (output artifact)
- Automation detail view renders the spec card
- Migration: existing automations get empty spec cards (progressive fill)

---

## Phase 6: Developer Velocity

**Goal:** Faster, safer development cycles.
**Dependencies:** 6.7 requires 4.8; 6.8 requires 2.6. Rest independent.
**Phase Gate:**
1. Tests green
2. Live smoke: E2E suite passes; feature flags disable browser init; `GET /api/monitoring/traces` returns data.

---

### 6.1 Playwright E2E Tests

- [ ] **Implemented**
- [ ] **Tested**
- [ ] **Smoke-verified**

> **Partial:** no `frontend/desktop/e2e/` directory; `@playwright/test` devDep present only

**6 critical-path tests:**
1. App launch → bootstrap gate → chat ready
2. Add provider → test connection → first message (mock provider)
3. Switch model mid-conversation
4. Workbench tool execution (mock)
5. Settings persistence across navigation
6. Error boundary recovery (force section crash → retry works)

---

### 6.2 Doc-Link Integrity

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:** `scripts/check-doc-links.mjs` — walk all `docs/*.md` + root `*.md`, extract relative links, verify each resolves. Exit 1 with broken link list.

---

### 6.3 Feature Flags

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:**
- `AUGUST_FEATURES` env var: comma-separated (default: all enabled)
- Flags: `browser`, `desktop`, `gateway_telegram`, `gateway_slack`, `gateway_discord`, `delta_engine`
- Disabled → skip init entirely in lifespan
- `GET /api/features` → current state

---

### 6.4 Request Tracing

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Note:** implementation lives in app/lib/tracing.py


**Implementation:**
- Middleware times: `route_resolve_ms`, `provider_connect_ms`, `first_token_ms`, `total_ms`
- Ring buffer (last 100 traces)
- `GET /api/monitoring/traces` → waterfall data
- Frontend Traffic section: timing breakdown per request

---

### 6.5 Pre-commit Hooks

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**


**Implementation:** `scripts/git-hooks/pre-commit`:
- Version-sync check (from 1.4)
- Secret scan: regex for API key patterns in staged files
- If `app/adapters/` changed: "Reminder: update golden tests"
- If `app/services/sandbox/` changed: "⚠️ High-risk: requires manual review"

---

### 6.6 Observability Gates

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** no unified GET /api/diagnostics; observability split across /api/observability, /api/brain/diagnostics, /api/monitoring


**Implementation:** Apply 6 AI-debug gates to August itself:
- **Discoverable:** `GET /api/diagnostics` lists all subsystems + status
- **Runnable:** Each subsystem has a self-test endpoint
- **Readable:** Structured JSON output, not log dumps
- **Correlatable:** Request IDs trace across subsystems (from 1.2)
- **Verifiable:** Each self-test returns pass/fail with evidence
- **Safe/reversible:** Diagnostics are read-only, never mutate state

---

### 6.7 API Envelope Migration

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** api_envelope.py exists; only /api/harness/* migrated so far


**Requires:** 4.8 (envelope design) complete.

**Implementation:** Roll out `{ok, format_version, data|error}` across all routers incrementally. Backward-compat: old shape behind `Accept: application/vnd.august.v0+json`.

---

### 6.8 Hook Observability Dashboard

- [x] **Implemented**
- [x] **Tested**
- [x] **Smoke-verified**

> **Partial:** GET /api/hooks + /api/hooks/stats exist; frontend dashboard section not built


**Requires:** 2.6 (stats endpoint) complete.

**Implementation:** Frontend section showing:
- Registered hooks table (name, event, matcher, priority)
- Per-hook p95 latency sparkline
- Deny rate (denies / total calls)
- Circuit breaker state (closed/open/half-open)
- "Disable" / "Re-enable" buttons per hook

---

## Resolved Pre-conditions

| Issue | Status | Evidence |
|---|---|---|
| db_writer FIFO vs priority | **Resolved** — FIFO intentional, docs corrected in commit `5064d112`. Priority = age-drop exemption only. B26 CLOSED. | `docs/REFACTOR_PROGRESS.md:549` |
| Peer-help recovery | **Resolved** — design decision exists. Observability-only by product decision. B27 PARTIAL (accepted). | `docs/REFACTOR_PROGRESS.md:97-143`, decision table lines 121-129 |
| FTS5 column mismatch | **FIXED** — schema/triggers correct, queries use table-level MATCH. | `kv.py:77-98`, `brain.py:371-383` |
| FTS5 desync (NEW) | **Found** — `memory_store_fts` 30 index docs vs 4 base rows. Addressed by 1.8. | Live DB verification |
| Vector namespace fragmentation | **Found** — 3 namespaces, defaults wrong. Addressed by 3.7a. | `vector_db.py` + `auto_memory.py` |

---

## Validation Strategy

### Every feature requires:
1. **Backend:** pytest test file with meaningful assertions
2. **Frontend:** vitest test (component or integration) where applicable
3. **Live smoke:** real backend hit verifying non-error response with real data

### Every phase gate requires:
```bash
# Backend
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q

# Frontend
npm run test:frontend

# Live smoke (per-phase specific endpoints)
uv run uvicorn app.main:app --port 8085 &
curl -s http://127.0.0.1:8085/api/health | python -m json.tool
# + phase-specific endpoint checks
```

### Coverage enforcement (from Phase 1.6 onward):
- Backend: `--cov-fail-under=55` (ratchet up each release)
- Frontend: `statements: 45` threshold
- ESLint: `--max-warnings=600` (ratchet down each release)

---

## Dependency Graph

```
Phase 1 (Foundation)
  ├── 1.2 Logging ──────────────┐
  ├── 1.3 Migrations ───────────┼──→ Phase 2 (needs logging + migrations)
  ├── 1.6 Coverage gates        │
  ├── 1.7 db_writer fix         │
  └── 1.8 FTS repair            │
                                 │
Phase 2 (Agent Runtime) ←───────┘
  ├── 2.1 Hook system ──────────────→ Phase 3 (needs hooks for evidence)
  ├── 2.6 Hook stats ───────────────────→ 6.8 (dashboard)
  └── 2.2-2.5 (built-in hooks)
                                      
Phase 3 (Intelligence)
  ├── 3.7a Vector unification ──→ 3.7b Dedup
  ├── 3.2 Friction ─────────────→ 3.8 Reconciliation
  ├── 3.3 Workflows ────────────→ 3.8 Reconciliation
  └── 3.5 Evidence ─────────────→ 4.4 Feedforward bar
                                      
Phase 4 (Product)
  ├── 4.1 Readiness ────────────→ 5.3 Support tracks
  ├── 4.8 API protocol ─────────→ 6.7 Envelope migration
  └── 4.2-4.7 (independent)
                                      
Phase 5 (UX)
  └── All depend on Phase 4 APIs
                                      
Phase 6 (Velocity)
  ├── 6.7 requires 4.8
  ├── 6.8 requires 2.6
  └── 6.1-6.6 independent
```

---

*Last updated: 2026-08-01 (hygiene pass — checkboxes reconciled with code audit)*
