# Remaining mypy Fixes — Prompt for AI Agent

> **⚠️ STALE — DO NOT FOLLOW ⚠️**
>
> This document is from an earlier session and the **numbers it cites are wrong**.
> At time of writing (2026-07-12 session), the master branch already had
> `mypy 0 errors / 174 source files` — verified live on `master @ 762f33b`.
>
> What changed since this doc was written:
> - **All snake_case renames landed** (PRs #7–13), plus B21 app file renames
>   (`typeAliases.py` → `type_aliases.py`, `modelResolver.py` →
>   `model_resolver.py`, `routeResolver.py` → `route_resolver.py`). The
>   "Top 30 files to fix" table below still references many pre-rename
>   camelCase paths (`memoryStore.py`, `backgroundReview.py`,
>   `toolDefinitions.py`, etc.) — treat those rows as historical labels,
>   not current paths.
> - **The `alias_generator=to_camel` pattern (PRs #11–12)** resolved many
>   `arg-type` and `union-attr` errors that this doc tries to fix manually
>   with `as_*` helpers.
> - **`fix-mypy-properly` branch doesn't exist** — neither locally nor on
>   origin. The actual mypy-cleanup branch is `fix/mypy-green` (still
>   unmerged; pre-merge review pending per step 5 of the refactor plan).
> - **mypy runs on Python 3.12+** per `pyproject.toml` `requires-python`. The
>   doc's claim about "blocked by Python 3.10 syntax" is wrong.
>
> **The Core Fix Pattern section** (80% of errors, `dict.get()` → `as_*`)
> remains useful as a reference for the underlying pattern, but most of the
> specific call sites it lists have since been resolved.
>
> Preserved here for archaeology; not authoritative.

You are tasked with fixing **1,002 mypy errors across 85 files** in the `backend-py/app/` directory. Do NOT use `# type: ignore` or `ignore_errors = True` — fix them properly.

## Repository Location
`C:\Dev\august-proxy\` (branch: `fix-mypy-properly`)

## How to Run mypy
```bash
cd backend-py
python -m mypy app/
```
(Python 3.12+ required — CI uses `ubuntu-latest` with Python 3.12)

## Error Distribution

| Count | Error Code | Meaning |
|-------|-----------|---------|
| ~600 | `union-attr` | Accessing attribute on `JsonValue` union (str/int/float/bool/None/list/dict) |
| ~200 | `attr-defined` | `object` has no attribute — variable typed as `object` |
| ~100 | `arg-type` | Wrong argument type passed to function |
| ~50 | `operator` | Using `in`, `+`, `[]` on `JsonValue` |
| ~50 | `return-value` | Return type incompatible |
| ~2 | `misc` | Misc |

## Top 30 Files to Fix (1002 total errors)

| Errors | File | Likely Fix Pattern |
|--------|------|-------------------|
| 100 | `services/workbench/workbench.py` | `JsonValue` `.get()` → `as_*`, function return types |
| 73 | `routers/providers.py` | `.get()` on provider dict → `as_str/as_dict/as_list` |
| 60 | `routers/config.py` | `.get()` on config dict → `as_str/as_dict/as_list` |
| 54 | `services/memory/backgroundReview.py` | `.get()` on dict values → `as_str/as_list` |
| 48 | `services/providerSetupTool.py` | `.get()` on result dicts → `as_str/as_dict` |
| 46 | `adapters/openai.py` | `JsonValue` access → `as_str/as_dict` |
| 37 | `services/workbench/subagent.py` | `.get()` on subagent dicts → `as_str/as_dict` |
| 28 | `providers/clients/base.py` | `.get()` on client config → `as_str/as_dict/as_int` |
| 26 | `routers/proxy.py` | `.get()` on request/response dicts → `as_str/as_dict` |
| 24 | `services/memory/knowledgeTree.py` | `.get()` on tree dicts → `as_*` |
| 24 | `services/toolDefinitions.py` | `.get()` on tool result dicts → `as_str/as_dict/as_list` |
| 23 | `services/browser/handlers.py` | Playwright `"object"` type → `cast(Page, ...)` |
| 23 | `services/tools/agentRegistry.py` | `getMemory()` returns `object` → `cast()` |
| 21 | `services/memory/graphMemory.py` | `.get()` on graph dicts → `as_str/as_list/as_int` |
| 21 | `services/workbench/terminalService.py` | `.get()` on session dicts → `as_str/as_bool` |
| 21 | `providers/route_resolver.py` (was `routeResolver.py`) | `.get()` on provider profiles → `as_list/as_dict` |
| 19 | `services/logger.py` | `.get()` on log entries → `as_str/as_int/as_float` |
| 18 | `services/memoryStore.py` | `.get()` on store dicts → `as_str/as_list` |
| 17 | `providers/resolver.py` | `.get()` on provider configs → `as_str/as_dict/as_list` |
| 17 | `services/daemonManager.py` | `info.get('result')` → `cast(DaemonResult, ...)` |
| 17 | `services/memory/vectorDb.py` | `.get()` on vector entries → `as_str/as_list/as_float` |
| 15 | `services/aliasService.py` | `.get()` on alias dict → `as_str` |
| 12 | `services/gateway/platforms/telegram.py` | `.get()` on message dict → `as_str/as_int` |
| 12 | `services/gateway/platforms/discord.py` | `.get()` on event dict → `as_str/as_dict` |
| 11 | `services/providerCredentials.py` | `.get()` on credential dicts → `as_str/as_dict` |
| 11 | `services/modelFleetService.py` | `.get()` on fleet config → `as_str/as_int/as_list` |
| 11 | `services/liveConfigService.py` | `.get()` on live config → `as_str/as_dict` |
| 10 | `services/browser/sessionManager.py` | Playwright session type → `cast()` |
| 10 | `services/consolidationDaemon.py` | `.get()` on result dict → `as_str/as_int` |
| 9 | `services/modelService.py` | `.get()` on model dicts → `as_str/as_int/as_bool` |

## The Core Fix Pattern (80% of errors)

The problem: `dict[str, JsonValue].get('key', default)` returns `JsonValue` — a union type `str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]`. mypy rejects using this return value with operators (`in`, `+`, `[]`) or passing to typed functions.

The fix: wrap every `.get()` call on a `JsonValue`-typed dict with the appropriate narrowing helper from `app.jsonUtils`:

```python
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float

# BEFORE (mypy error):
if 'text' in block.get('content', ''):
    text = d.get('text', '')
val = d.get('count', 0) + 1
items = d.get('results', [])
for item in items:

# AFTER:
if 'text' in as_str(block.get('content'), ''):
    text = as_str(d.get('text'), '')
val = as_int(d.get('count'), 0) + 1
items = as_list(d.get('results'), [])
for item in items:
```

## Additional Fix Patterns

### 1. `"object" has no attribute` (Playwright browser automation)
Files: `services/browser/snapshot.py`, `services/browser/elementResolver.py`, `services/browser/handlers.py`
Fix: `page` parameter is typed as `object`. Use `cast(Page, page)` or add proper type annotation:
```python
from playwright.async_api import Page
# ...
async def handle(page: Page):  # instead of `page: object`
    await page.evaluate(script)
```

### 2. `"AssemblyResult" has no attribute`
File: `services/tools/modelTools.py`
Fix: The `AssemblyResult` dataclass fields use camelCase (`thresholdTokens`, `toolDefs`) but the code accesses them as snake_case (`threshold_tokens`, `tool_defs`). Fix all field name accesses to match the dataclass definition.

### 3. `Module has no attribute` (camelCase vs snake_case)
Files: `app/main.py`, various
Fix: Change `close_all` → `closeAll`, `max_workers` → `maxWorkers` to match the actual exported names.

### 4. `Incompatible return value type`
Fix: The function return type annotation expects one type but the actual return constructs a different type. Fix either the annotation or the return value.

### 5. `Argument 1 to "as_str" has incompatible type`
Some `as_str()` calls were added incorrectly — the argument is already a `str` type, or the `.get()` is on a non-JsonValue dict. Remove the unnecessary `as_str()` wrapper.

### 6. TypedDict vs dict access
Some files define TypedDicts but access them with `.get()` instead of direct attribute access. Change `d.get('key')` to `d['key']` for TypedDict instances.

## Helper Functions Available

These are in `app/jsonUtils.py`:
- `as_str(value: object, default: str = '') -> str` — narrow to str
- `as_dict(value: object, default: dict | None = None) -> dict[str, JsonValue]` — narrow to dict
- `as_list(value: object, default: list | None = None) -> list[JsonValue]` — narrow to list
- `as_int(value: object, default: int = 0) -> int` — narrow to int (excludes bool)
- `as_float(value: object, default: float = 0.0) -> float` — narrow to float/int (excludes bool)
- `as_bool(value: object, default: bool = False) -> bool` — narrow to bool

## CI Workflow

The `type-check.yml` runs on push/PR to `master`. To verify your fixes:
1. Push to a branch
2. The `Backend — mypy` job will run and report errors
3. Check the job log for the `Found N errors in M files` line

## Goal
**0 errors.** No `ignore_errors = True` in `mypy.ini` for any app module (except `app.scripts.*` and `tests.*` which are already exempt).
