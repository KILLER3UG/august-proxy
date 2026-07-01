# Full Codebase snake_case → camelCase Migration

**Date:** 2026-06-30
**Status:** Design — Approved for Implementation

## Overview

Convert all `snake_case` identifiers across the entire August Proxy codebase to `camelCase`. This is a one-time mechanical refactoring covering the Python backend, SQLite database schema, configuration files, and documentation.

### Motivation

- The frontend (TypeScript/React) already uses `camelCase` universally.
- The `DEVELOPER_GUIDE.md` documented mixed conventions: "`camelCase` for JSON/API fields" but "`snake_case` for Python identifiers." Since the entire system is increasingly unified around the JavaScript ecosystem (React frontend, JSON wire format), `camelCase` everywhere eliminates cognitive friction.
- The `brain_config_service.py` module already demonstrated the conversion pattern — this project extends it to the whole backend.

### Non-Goals

- No behavioral changes — only identifier renames.
- No architectural refactoring (file splits, module moves, interface changes).
- External API wire formats (Anthropic, OpenAI) remain `snake_case` as required by those services — converters at the boundary handle translation.

---

## Approach: Hybrid Script-Assisted Conversion

**Approach C:** Use a Python `ast`-based conversion script for the mechanical ~90% of renames, with manual review per phase.

## Conversion Phases

All phases execute in strict dependency order. Each phase is a separate commit so individual phases can be reverted.

| # | Phase | Files | Verification |
|---|-------|-------|-------------|
| 0 | Build AST script + deny-list | `scripts/snake_to_camel.py` | Dry-run on lib/ |
| 1 | `lib/` | `paths.py`, `secrets.py`, `retry.py`, `tokens.py`, `health.py` | Tests pass |
| 2 | `providers/` | ~30 provider definitions & clients | Tests pass |
| 3 | `adapters/base.py` + `proxy_tools.py` | 2 files | Tests pass |
| 4 | `services/memory_store.py` | 1 file | Tests pass |
| 5 | `config_service.py`, `alias_service.py` | 2 files | Tests pass |
| 6 | `services/memory/` | ~5 files (brain_orchestrator, etc.) | Tests pass |
| 7 | `services/skills/`, `services/tools/`, `services/browser/` | ~10 files | Tests pass |
| 8 | `services/workbench/` | ~8 files | Tests pass |
| 9 | `services/gateway/` | ~5 files | Tests pass |
| 10 | `routers/` | 28 route files | Tests pass |
| 11 | `adapters/anthropic.py` + `adapters/openai.py` | 2 files (+ `case_converters.py`) | Tests pass |
| 12 | `tests/` | 63 test files | Full test suite |
| 13 | DB migration script | 1 script | Schema verification |
| 14 | `main.py`, `config.py` | 2 files | Smoke test |
| 15 | `DEVELOPER_GUIDE.md`, `pyproject.toml` | 2 files | — |

---

## AST Conversion Script Design

**File:** `backend-py/scripts/snake_to_camel.py`

Parses each `.py` file into an AST, walks with a custom `NodeTransformer`, renames matching `snake_case` identifiers to `camelCase`, and unparses back to source.

### Transformation Rules

| AST Node | Action |
|----------|--------|
| `FunctionDef.name` | Rename unless on deny-list |
| `arg.arg` (parameters) | Rename |
| `Name.id` in `Store` context (assignment targets) | Rename |
| `Call.func` as `Name` | Rename |
| `Attribute.attr` (our own modules) | Rename (with scope tracking) |

### Deny-List (Never Rename)

- Python dunder methods: `__init__`, `__str__`, `__repr__`, `__enter__`, `__exit__`, `__aenter__`, `__aexit__`, `__call__`, `__getattr__`, `__setattr__`, `__del__`, `__add__`, `__eq__`, `__hash__`, `__len__`, `__getitem__`, `__setitem__`, `__iter__`, `__next__`, `__contains__`, `__bool__`, `__anext__`, `__aiter__`
- Pytest internals: `tmp_path`, `monkeypatch`, `capsys`, `caplog`, `request` (fixture)
- FastAPI/Pydantic internals: `ConfigDict`, `model_validator`, `field_validator`, `model_dump`, `model_validate`, `field_serializer`, `model_config`
- Standard library modules (may be imported): `os`, `sys`, `json`, `time`, `re`, `pathlib`, etc.
- Environment variable names: `AUGUST_DATA_DIR`, `AUGUST_BRAIN_SQLITE_FILE`, etc.
- Module-level `UPPER_SNAKE` constants (detected by pattern)
- Single-letter variables (`i`, `j`, `k`, `v`, `x`, `y`, `z`)

### Script Features

- **Dry-run mode** (`--dry-run`): Prints changes without modifying files
- **Audit report** (`--report`): Produces a JSON log of every rename per file
- **Diff output** (`--diff`): Shows unified diff for each modified file
- **Deny-list file** (`--deny-list FILE`): Load additional deny-list entries
- **Per-file conversion**: Process individual files or directories
- **Backup** (`.bak`): Original file saved before modification

### Conversion Convention

Standard camelCase rules:
- `snake_case` → `snakeCase`
- `_leading_underscore` → `_leadingUnderscore` (private by convention)
- `__dunder_name` → `__dunderName` (name mangling — but most are on the deny-list)
- `UPPER_SNAKE` → keep as-is (constants)
- `test_something` → `testSomething` (pytest configured to discover)

---

## Database Migration

**Script:** `backend-py/scripts/migrate_db_columns.py`

### Process

1. **Backup:** Copy `*.sqlite` → `*.sqlite.bak` before migration.
2. **Transaction:** All `ALTER TABLE ... RENAME COLUMN` statements in a single transaction.
3. **Verify:** `PRAGMA table_info(tablename)` to confirm new column names.
4. **Log:** Migration result logged to stdout.

### Column Mapping (Partial)

| Old | New | Tables |
|-----|-----|--------|
| `session_id` | `sessionId` | proposals, lifecycle, messages, usage_events, blackboard, session_topics |
| `created_at` | `createdAt` | All tables |
| `updated_at` | `updatedAt` | All tables |
| `event_type` | `eventType` | lifecycle, usage_events |
| `message_count` | `messageCount` | sessions |
| `fact_key` | `factKey` | facts |
| `fact_value` | `factValue` | facts |
| `proposal_type` | `proposalType` | proposals |
| `folder_id` | `folderId` | sessions |
| `is_archived` | `isArchived` | sessions |
| `workspace_path` | `workspacePath` | sessions |
| `decided_at` | `decidedAt` | proposals |
| `decided_by` | `decidedBy` | proposals |

Full mapping covers all ~20 tables. The migration runs as part of the app startup (lifespan hook), gated on a schema version check.

---

## External API Boundary Converters

**File:** `backend-py/app/adapters/case_converters.py`

### Type Definition

```python
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
```

### Functions

```python
def snakeToCamel(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from snake_case to camelCase."""

def camelToSnake(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from camelCase to snake_case."""
```

### Application Points

- **Inbound** (API response → internal): `snakeToCamel(response.json())` in `anthropic.py` and `openai.py`
- **Outbound** (internal → API request): `camelToSnake(request_body)` before sending

These converters handle only dict keys — values pass through unchanged.

---

## Testing Strategy

### Pre-Conversion Baseline
```
cd backend-py && python -m pytest tests/ -v --tb=short
```

### Per-Phase Verification
```
cd backend-py && python -m pytest tests/ -x --tb=short
```

### Post-Conversion
- Full test suite (all 63 test files)
- Frontend vitest suite: `cd frontend/desktop && npx vitest run`
- Manual smoke test of key API endpoints

### Pytest Configuration
```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
python_functions = "test*"
```

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| AST script renames wrong identifiers | Dry-run mode; deny-list; audit report; per-phase review |
| Cross-module reference mismatch | Dependency-ordered phases catch mismatches at import time |
| Name collisions | Phase ordering prevents most; manual review catches edge cases |
| DB migration failure | Pre-migration backup; schema verification after |
| Wire format breakage | `case_converters.py` at the adapter boundary |
| Missed snake_case in JS/TS/JSON | Post-conversion grep sweep |

---

## Files Not Modified

- `node_modules/`, `web-dist/`, `data/` — third-party or runtime
- `skills/` — bundled third-party skill packs
- `memory/`, `evals/` — LLM context files
- Rust files (`src-tauri/`) — Rust conventions are snake_case for functions, which is standard
