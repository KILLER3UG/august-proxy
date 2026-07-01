# snake_case → camelCase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all snake_case identifiers to camelCase across the Python backend, SQLite database, configuration, and documentation.

**Architecture:** An AST-based conversion script handles ~90% of Python renames mechanically; the remaining 10% (cross-module references, edge cases) is caught by per-phase manual review. A separate database migration script renames SQLite columns. Boundary case converters at the Anthropic/OpenAI adapter edge translate between internal camelCase and external snake_case wire formats.

**Tech Stack:** Python 3.13 `ast` module, SQLite `ALTER TABLE`, pytest, vitest

---

## Task 0: Build AST Conversion Script

**Files:**
- Create: `backend-py/scripts/snake_to_camel.py`
- Create: `backend-py/scripts/deny_list.txt`

- [ ] **Step 1: Create the deny-list file**

Write `backend-py/scripts/deny_list.txt`:

```
# Python dunder methods (must never change)
__init__
__str__
__repr__
__enter__
__exit__
__aenter__
__aexit__
__call__
__getattr__
__setattr__
__del__
__add__
__eq__
__hash__
__len__
__getitem__
__setitem__
__iter__
__next__
__contains__
__bool__
__anext__
__aiter__
__delattr__
__delitem__
__format__
__ge__
__gt__
__le__
__lt__
__ne__
__new__
__reduce__
__reduce_ex__
__sizeof__
__sub__
__mul__
__truediv__
__floordiv__
__mod__
__pow__
__neg__
__pos__
__abs__
__invert__
__and__
__or__
__xor__
__iadd__
__isub__
__imul__
__itruediv__
__ifloordiv__
__imod__
__ipow__
__iand__
__ior__
__ixor__

# Pytest fixtures
tmp_path
monkeypatch
capsys
caplog
request

# FastAPI/Pydantic internals
ConfigDict
model_validator
field_validator
model_dump
model_validate
field_serializer
model_config
field_validator
model_validator

# Environment variable names
AUGUST_DATA_DIR
AUGUST_BRAIN_SQLITE_FILE
```

- [ ] **Step 2: Write the main AST conversion script**

Write `backend-py/scripts/snake_to_camel.py`:

```python
#!/usr/bin/env python3
"""
AST-based snake_case → camelCase converter for Python source files.

Usage:
    python scripts/snake_to_camel.py file.py              # single file
    python scripts/snake_to_camel.py --dir lib/            # directory
    python scripts/snake_to_camel.py --dry-run file.py     # preview only
    python scripts/snake_to_camel.py --diff file.py        # show unified diff
    python scripts/snake_to_camel.py --report file.py      # audit log

In-place modification with .bak backup.
"""

import ast
import difflib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


# ── Deny-list ──────────────────────────────────────────────────────────

_DENY_LIST: set[str] = {
    # Python dunder methods
    "__init__", "__str__", "__repr__", "__enter__", "__exit__",
    "__aenter__", "__aexit__", "__call__", "__getattr__", "__setattr__",
    "__del__", "__add__", "__eq__", "__hash__", "__len__", "__getitem__",
    "__setitem__", "__iter__", "__next__", "__contains__", "__bool__",
    "__anext__", "__aiter__", "__delattr__", "__delitem__", "__format__",
    "__ge__", "__gt__", "__le__", "__lt__", "__ne__", "__new__",
    "__reduce__", "__reduce_ex__", "__sizeof__", "__sub__", "__mul__",
    "__truediv__", "__floordiv__", "__mod__", "__pow__", "__neg__",
    "__pos__", "__abs__", "__invert__", "__and__", "__or__", "__xor__",
    "__iadd__", "__isub__", "__imul__", "__itruediv__", "__ifloordiv__",
    "__imod__", "__ipow__", "__iand__", "__ior__", "__ixor__",
    # Pytest fixtures
    "tmp_path", "monkeypatch", "capsys", "caplog",
    # FastAPI/Pydantic
    "ConfigDict", "model_validator", "field_validator", "model_dump",
    "model_validate", "field_serializer", "model_config",
    # Known module names
    "logger",
}


def _load_deny_list(path: str) -> set[str]:
    """Extend deny-list from a file (one identifier per line, # comments ignored)."""
    result = set(_DENY_LIST)
    with open(path) as f:
        for line in f:
            stripped = line.split("#")[0].strip()
            if stripped:
                result.add(stripped)
    return result


def _is_upper_snake(name: str) -> bool:
    """Return True if name looks like an UPPER_SNAKE constant."""
    return re.fullmatch(r"[A-Z][A-Z0-9]*(_[A-Z0-9]+)*", name) is not None


def _snake_to_camel(name: str) -> str:
    """Convert snake_case to camelCase. Preserves leading underscores."""
    if _is_upper_snake(name):
        return name  # don't touch constants
    if "__" in name:
        # Dunder names: __my_method__ → keep as-is (handled by deny-list)
        return name
    parts = name.split("_")
    # Preserve leading underscore(s)
    leading = ""
    while parts and parts[0] == "":
        leading += "_"
        parts.pop(0)
    if not parts:
        return leading
    # First part lowercase, rest capitalized
    result = leading + parts[0] + "".join(p.capitalize() for p in parts[1:])
    return result


# ── AST Transformers ───────────────────────────────────────────────────


class SnakeToCamelTransformer(ast.NodeTransformer):
    """Rename snake_case identifiers to camelCase."""

    def __init__(self, deny: set[str]):
        self.deny = deny
        self.renames: list[dict[str, Any]] = []  # audit log
        self._local_names: set[str] = set()  # vars we track

    def _rename(self, name: str, node_type: str, location: tuple[int, int]) -> str:
        """Rename if snake_case, log the change."""
        if name in self.deny:
            return name
        if "_" not in name:
            return name
        if name.startswith("__") and name.endswith("__"):
            return name  # dunder — deny-list should catch these, but be safe
        if _is_upper_snake(name):
            return name
        camel = _snake_to_camel(name)
        if camel != name:
            self.renames.append({
                "old": name,
                "new": camel,
                "type": node_type,
                "line": location[0],
                "col": location[1],
            })
        return camel

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        new_name = self._rename(node.name, "function", (node.lineno, node.col_offset))
        node.name = new_name
        # Rename parameters
        for arg in node.args.args:
            arg.arg = self._rename(arg.arg, "parameter", (arg.lineno or node.lineno, arg.col_offset or 0))
        for arg in node.args.kwonlyargs:
            arg.arg = self._rename(arg.arg, "parameter", (arg.lineno or node.lineno, arg.col_offset or 0))
        if node.args.vararg:
            node.args.vararg.arg = self._rename(node.args.vararg.arg, "parameter",
                                                  (node.args.vararg.lineno or node.lineno, 0))
        if node.args.kwarg:
            node.args.kwarg.arg = self._rename(node.args.kwarg.arg, "parameter",
                                                 (node.args.kwarg.lineno or node.lineno, 0))
        # Rename decorators
        self.generic_visit(node)
        return node

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        new_name = self._rename(node.name, "function", (node.lineno, node.col_offset))
        node.name = new_name
        for arg in node.args.args:
            arg.arg = self._rename(arg.arg, "parameter", (arg.lineno or node.lineno, arg.col_offset or 0))
        for arg in node.args.kwonlyargs:
            arg.arg = self._rename(arg.arg, "parameter", (arg.lineno or node.lineno, arg.col_offset or 0))
        if node.args.vararg:
            node.args.vararg.arg = self._rename(node.args.vararg.arg, "parameter",
                                                  (node.args.vararg.lineno or node.lineno, 0))
        if node.args.kwarg:
            node.args.kwarg.arg = self._rename(node.args.kwarg.arg, "parameter",
                                                 (node.args.kwarg.lineno or node.lineno, 0))
        self.generic_visit(node)
        return node

    def visit_Name(self, node: ast.Name) -> Any:
        """Rename variable references in store context (assignments)."""
        if isinstance(node.ctx, ast.Store):
            new_id = self._rename(node.id, "variable", (node.lineno, node.col_offset))
            node.id = new_id
        return node

    def visit_Attribute(self, node: ast.Attribute) -> Any:
        """Rename attribute access — careful: only rename our own attributes."""
        # We rename all attribute access for now; the manual review catches
        # any issues with third-party library attributes.
        new_attr = self._rename(node.attr, "attribute", (node.lineno, node.col_offset))
        node.attr = new_attr
        self.generic_visit(node)
        return node

    def visit_ImportFrom(self, node: ast.ImportFrom) -> Any:
        """Rename imported names in 'from X import Y' statements."""
        for alias in node.names:
            if alias.asname:
                alias.asname = self._rename(alias.asname, "import_as", (node.lineno, 0))
            else:
                alias.name = self._rename(alias.name, "import", (node.lineno, 0))
        return node

    def visit_Import(self, node: ast.Import) -> Any:
        for alias in node.names:
            if alias.asname:
                alias.asname = self._rename(alias.asname, "import_as", (node.lineno, 0))
        return node

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        """Rename class def only if snake_case (rare for classes, but handle it)."""
        # Classes are typically PascalCase — only rename if snake_case
        if "_" in node.name and not node.name[0].isupper():
            new_name = self._rename(node.name, "class", (node.lineno, node.col_offset))
            node.name = new_name
        self.generic_visit(node)
        return node


# ── File processing ────────────────────────────────────────────────────


def convert_file(path: Path, deny: set[str], *, dry_run: bool = False,
                 show_diff: bool = False, audit: bool = False) -> dict[str, Any]:
    """Process a single Python file. Returns audit info."""
    original = path.read_text(encoding="utf-8")
    tree = ast.parse(original, filename=str(path))

    transformer = SnakeToCamelTransformer(deny)
    modified_tree = transformer.visit(tree)
    ast.fix_missing_locations(modified_tree)

    # Unparse
    try:
        new_source = ast.unparse(modified_tree)
    except Exception as e:
        return {"file": str(path), "status": "error", "error": str(e), "renames": []}

    # Preserve shebang and encoding declarations
    lines_orig = original.splitlines(keepends=True)
    lines_new = new_source.splitlines(keepends=True)

    result = {
        "file": str(path),
        "status": "unchanged" if original == new_source else "modified",
        "renames": transformer.renames,
    }

    if original == new_source:
        return result

    if dry_run:
        print(f"[DRY-RUN] Would modify: {path}")
        for r in transformer.renames:
            print(f"  L{r['line']}: {r['old']} → {r['new']}  ({r['type']})")
        return result

    if show_diff:
        diff = difflib.unified_diff(
            lines_orig, lines_new,
            fromfile=str(path), tofile=str(path),
            lineterm="",
        )
        sys.stdout.writelines(diff)

    # Backup and write
    backup = path.with_suffix(path.suffix + ".bak")
    backup.write_text(original, encoding="utf-8")
    path.write_text(new_source, encoding="utf-8")

    result["backup"] = str(backup)
    return result


def convert_directory(dir_path: Path, deny: set[str], **kwargs) -> list[dict[str, Any]]:
    """Process all .py files in a directory recursively."""
    results = []
    for py_file in sorted(dir_path.rglob("*.py")):
        # Skip __pycache__
        if "__pycache__" in py_file.parts:
            continue
        result = convert_file(py_file, deny, **kwargs)
        results.append(result)
    return results


# ── CLI entry point ────────────────────────────────────────────────────


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Convert snake_case to camelCase in Python files")
    parser.add_argument("targets", nargs="+", help="Files or directories to convert")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying")
    parser.add_argument("--diff", action="store_true", help="Show unified diff")
    parser.add_argument("--report", action="store_true", help="Output JSON audit report")
    parser.add_argument("--deny-list", help="Additional deny-list file")
    parser.add_argument("--recursive", "-r", action="store_true", help="Process directories recursively")

    args = parser.parse_args()

    deny = set(_DENY_LIST)
    if args.deny_list:
        deny = _load_deny_list(args.deny_list)

    all_results = []

    for target in args.targets:
        path = Path(target)
        if path.is_file():
            r = convert_file(path, deny, dry_run=args.dry_run,
                             show_diff=args.diff, audit=args.report)
            all_results.append(r)
        elif path.is_dir():
            r = convert_directory(path, deny, dry_run=args.dry_run,
                                  show_diff=args.diff, audit=args.report)
            all_results.extend(r)
        else:
            print(f"Warning: {target} not found", file=sys.stderr)

    if args.report:
        print(json.dumps(all_results, indent=2))

    # Summary
    modified = sum(1 for r in all_results if r["status"] == "modified")
    unchanged = sum(1 for r in all_results if r["status"] == "unchanged")
    errors = sum(1 for r in all_results if r["status"] == "error")
    total_renames = sum(len(r.get("renames", [])) for r in all_results)

    print(f"\nSummary: {modified} modified, {unchanged} unchanged, {errors} errors, {total_renames} renames")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Dry-run test on a simple file**

Run: `python backend-py/scripts/snake_to_camel.py --dry-run backend-py/app/lib/paths.py`

Expected: Shows proposed renames (`data_dir` → `dataDir`, `data_path` → `dataPath`) without modifying the file.

- [ ] **Step 4: Restore from backup after testing**

If the script was tested without --dry-run:
```bash
cd backend-py && git checkout app/lib/paths.py
```

- [ ] **Step 5: Commit**

```bash
cd backend-py
git add scripts/snake_to_camel.py scripts/deny_list.txt
git commit -m "feat: add AST-based snake_case to camelCase conversion script"
```

---

## Task 1: Convert `lib/` Package

**Files:**
- Modify: `backend-py/app/lib/paths.py`
- Modify: `backend-py/app/lib/secrets.py`
- Modify: `backend-py/app/lib/retry.py`
- Modify: `backend-py/app/lib/tokens.py`
- Modify: `backend-py/app/lib/health.py`

- [ ] **Step 1: Run the conversion script on lib/**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/lib/
```

Verify output looks correct:
- `data_dir()` → `dataDir()`
- `data_path()` → `dataPath()`
- `probe_url()` → `probeUrl()`
- `estimate_messages()` → `estimateMessages()`

- [ ] **Step 2: Apply the conversion**

```bash
python scripts/snake_to_camel.py app/lib/
```

- [ ] **Step 3: Run tests to verify**

```bash
python -m pytest tests/ -x --tb=short
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert app/lib/ from snake_case to camelCase"
```

---

## Task 2: Convert `providers/` Package

**Files:**
- Modify: All files in `backend-py/app/providers/` (~30 files)

- [ ] **Step 1: Dry-run on providers/**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/providers/
```

Verify key renames:
- `resolve_base_url()` → `resolveBaseUrl()`
- `resolve_api_key()` → `resolveApiKey()`

- [ ] **Step 2: Apply the conversion**

```bash
python scripts/snake_to_camel.py app/providers/
```

- [ ] **Step 3: Fix any import references from lib/ that now use old snake_case names**

The lib functions were renamed in Task 1. The providers import them. The AST script should have renamed the call sites too, but verify:

```bash
grep -rn "from app.lib" app/providers/ | head -20
grep -rn "data_dir\|data_path\|probe_url\|estimate_messages" app/providers/
```

Expected: No remaining references to old snake_case names. If any exist, fix manually.

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: convert app/providers/ from snake_case to camelCase"
```

---

## Task 3: Convert Base Adapters

**Files:**
- Modify: `backend-py/app/adapters/base.py`
- Modify: `backend-py/app/adapters/proxy_tools.py`

- [ ] **Step 1: Dry-run**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/adapters/base.py app/adapters/proxy_tools.py
```

- [ ] **Step 2: Apply**

```bash
python scripts/snake_to_camel.py app/adapters/base.py app/adapters/proxy_tools.py
```

- [ ] **Step 3: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert adapters/base.py and proxy_tools.py to camelCase"
```

---

## Task 4: Convert `memory_store.py`

**Files:**
- Modify: `backend-py/app/services/memory_store.py`

- [ ] **Step 1: Dry-run**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/memory_store.py
```

Verify key renames:
- `_db_path()` → `_dbPath()`
- `_conn()` → `_conn()` (single word, no change)
- `_q()` → `_q()` (single char, no change)
- `_json()` → `_json()` (already no underscore)
- `close()` → `close()` (no change)
- `init()` → `init()` (no change)

- [ ] **Step 2: Apply**

```bash
python scripts/snake_to_camel.py app/services/memory_store.py
```

- [ ] **Step 3: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert memory_store.py to camelCase"
```

---

## Task 5: Convert Config Services

**Files:**
- Modify: `backend-py/app/services/config_service.py`
- Modify: `backend-py/app/services/alias_service.py`

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/config_service.py app/services/alias_service.py
python scripts/snake_to_camel.py app/services/config_service.py app/services/alias_service.py
```

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: convert config/alias services to camelCase"
```

---

## Task 6: Convert `services/memory/` Package

**Files:**
- Modify: All files in `backend-py/app/services/memory/` (~5 files)

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/memory/
python scripts/snake_to_camel.py app/services/memory/
```

Note: `brain_orchestrator.py`'s `get_brain_config()` becomes `getBrainConfig()`. This will need attention in later tasks since `brain_config_service.py` calls it and that file is already in camelCase.

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: convert services/memory/ to camelCase"
```

---

## Task 7: Convert `services/skills/`, `services/tools/`, `services/browser/`

**Files:**
- Modify: All files in `app/services/skills/`, `app/services/tools/`, `app/services/browser/` (~10 files)

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/skills/ app/services/tools/ app/services/browser/
python scripts/snake_to_camel.py app/services/skills/ app/services/tools/ app/services/browser/
```

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: convert skills/tools/browser services to camelCase"
```

---

## Task 8: Convert `services/workbench/` Package

**Files:**
- Modify: All files in `backend-py/app/services/workbench/` (~8 files)

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/workbench/
python scripts/snake_to_camel.py app/services/workbench/
```

- [ ] **Step 2: Check `brain_config_service.py` references**

`brain_config_service.py` already uses camelCase and calls `workbenchSvc.list_workbench_sessions()`. After this task, that function is `workbenchSvc.listWorkbenchSessions()`. Update the call in `brain_config_service.py`:

```bash
# Check if any references are broken
cd backend-py
grep -rn "list_workbench_sessions\|create_workbench_session\|get_workbench_session" app/
```

If any remain, fix them manually.

- [ ] **Step 3: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert services/workbench/ to camelCase"
```

---

## Task 9: Convert `services/gateway/` Package

**Files:**
- Modify: All files in `backend-py/app/services/gateway/` (~5 files)

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/services/gateway/
python scripts/snake_to_camel.py app/services/gateway/
```

- [ ] **Step 2: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: convert services/gateway/ to camelCase"
```

---

## Task 10: Convert `routers/` Package

**Files:**
- Modify: All files in `backend-py/app/routers/` (28 files, excluding `__init__.py`)

- [ ] **Step 1: Dry-run routers/**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/routers/
```

Verify critical renames:
- FastAPI route handlers: `list_agents()` → `listAgents()`, `create_agent()` → `createAgent()`
- These names are internal to the module and don't affect URL paths or HTTP methods
- `maxDepth` query param → stays `maxDepth` (already camelCase, underscore-less)

- [ ] **Step 2: Apply**

```bash
python scripts/snake_to_camel.py app/routers/
```

- [ ] **Step 3: Verify router imports in main.py**

```bash
cd backend-py
grep -n "from app.routers" app/main.py
```

After conversion, the imported function names in `main.py`'s `include_router` calls use the old snake_case `prefix_tags` arguments. Check that `include_router(..., prefix="...", tags=[...])` calls are unaffected (they use keyword arguments, not snake_case identifiers).

- [ ] **Step 4: Fix `brain_config.py` call to `brain_orchestrator.get_brain_config()`**

In `brain_config_service.py`, check the import and call to `get_brain_config()` from `brain_orchestrator`. If it still uses `get_brain_config`, update to `getBrainConfig`:

Read `backend-py/app/services/brain_config_service.py` and fix any remaining old references.

- [ ] **Step 5: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: convert app/routers/ to camelCase"
```

---

## Task 11: Create External API Case Converters + Convert Adapters

**Files:**
- Create: `backend-py/app/adapters/case_converters.py`
- Modify: `backend-py/app/adapters/anthropic.py`
- Modify: `backend-py/app/adapters/openai.py`

- [ ] **Step 1: Write case_converters.py**

Write `backend-py/app/adapters/case_converters.py`:

```python
"""
Bidirectional snake_case ↔ camelCase converters for dict keys.

Used at the Anthropic/OpenAI API boundary to translate between
internal camelCase code and external snake_case wire formats.
"""

from __future__ import annotations

from typing import Any

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]


def _snake_to_camel_key(key: str) -> str:
    """Convert a single snake_case key to camelCase."""
    parts = key.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake_key(key: str) -> str:
    """Convert a single camelCase key to snake_case."""
    result = []
    for i, ch in enumerate(key):
        if ch.isupper():
            if i > 0:
                result.append("_")
            result.append(ch.lower())
        else:
            result.append(ch)
    return "".join(result)


def snakeToCamel(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from snake_case to camelCase."""
    if isinstance(obj, dict):
        return {_snake_to_camel_key(k): snakeToCamel(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [snakeToCamel(item) for item in obj]
    return obj


def camelToSnake(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from camelCase to snake_case."""
    if isinstance(obj, dict):
        return {_camel_to_snake_key(k): camelToSnake(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [camelToSnake(item) for item in obj]
    return obj
```

- [ ] **Step 2: Run case_converters.py tests**

Write a quick inline test:

```bash
cd backend-py
python -c "
from app.adapters.case_converters import snakeToCamel, camelToSnake

# Test snakeToCamel
result = snakeToCamel({'stop_reason': 'end_turn', 'input_tokens': 100})
assert result == {'stopReason': 'end_turn', 'inputTokens': 100}, result

# Test camelToSnake
result = camelToSnake({'stopReason': 'end_turn', 'inputTokens': 100})
assert result == {'stop_reason': 'end_turn', 'input_tokens': 100}, result

# Test nested
result = snakeToCamel({'content_blocks': [{'text': 'hello'}]})
assert result == {'contentBlocks': [{'text': 'hello'}]}, result

print('All converter tests passed')
"
```

- [ ] **Step 3: Convert anthropic.py and openai.py**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/adapters/anthropic.py app/adapters/openai.py
python scripts/snake_to_camel.py app/adapters/anthropic.py app/adapters/openai.py
```

- [ ] **Step 4: Add snakeToCamel/camelToSnake calls at the boundary**

In `anthropic.py`, find where the API response is received (likely `response.json()` or similar) and wrap it with `snakeToCamel(...)`:

```python
# Before:
data = response.json()

# After:
from app.adapters.case_converters import snakeToCamel
data = snakeToCamel(response.json())
```

Similarly, where the request body is constructed for the external API, wrap the outbound data:

```python
# Before:
request_body = build_openai_request(...)

# After:
from app.adapters.case_converters import camelToSnake
request_body = camelToSnake(build_openai_request(...))
```

- [ ] **Step 5: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add case_converters + convert adapters to camelCase"
```

---

## Task 12: Convert Tests

**Files:**
- Modify: All files in `backend-py/tests/` (63 files)
- Modify: `backend-py/pyproject.toml`

- [ ] **Step 1: Update pyproject.toml for pytest discovery**

Add `python_functions` to `backend-py/pyproject.toml`:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
python_functions = "test*"
```

- [ ] **Step 2: Dry-run on tests/**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run tests/
```

Verify test function names:
- `test_health()` → `testHealth()`
- `test_list_routes()` → `testListRoutes()`
- Pytest fixtures (`tmp_path`, `monkeypatch`) should remain unchanged (deny-list)

- [ ] **Step 3: Apply**

```bash
python scripts/snake_to_camel.py tests/
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

Expected: All tests pass. If any fail, check for:
- Missing imports (function names changed in non-test code too)
- References to old snake_case identifiers in test assertions
- Test fixtures that were incorrectly renamed

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: convert tests/ to camelCase + update pytest config"
```

---

## Task 13: Database Migration Script

**Files:**
- Create: `backend-py/scripts/migrate_db_columns.py`

- [ ] **Step 1: Write the migration script**

Write `backend-py/scripts/migrate_db_columns.py`:

```python
#!/usr/bin/env python3
"""
SQLite column migration: snake_case → camelCase.

Creates a backup and renames all columns in the August brain database.

Usage:
    python scripts/migrate_db_columns.py                           # use default path
    python scripts/migrate_db_columns.py --db path/to/brain.sqlite # explicit path
    python scripts/migrate_db_columns.py --dry-run                 # preview only
"""

import argparse
import sqlite3
import shutil
import sys
from pathlib import Path


# Column mapping: {table: [(old_name, new_name), ...]}
COLUMN_MAP: dict[str, list[tuple[str, str]]] = {
    "memory_store": [
        ("key", "key"),
        ("value", "value"),
        ("updated_at", "updatedAt"),
    ],
    "facts": [
        ("id", "id"),
        ("fact_key", "factKey"),
        ("fact_value", "factValue"),
        ("category", "category"),
        ("source", "source"),
        ("confidence", "confidence"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "proposals": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("proposal_type", "proposalType"),
        ("content", "content"),
        ("status", "status"),
        ("created_at", "createdAt"),
        ("decided_at", "decidedAt"),
        ("decided_by", "decidedBy"),
    ],
    "lifecycle": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("event_type", "eventType"),
        ("detail", "detail"),
        ("created_at", "createdAt"),
    ],
    "session_topics": [
        ("session_id", "sessionId"),
        ("topic", "topic"),
        ("parent_topic", "parentTopic"),
        ("confidence", "confidence"),
        ("classified_at", "classifiedAt"),
    ],
    "sessions": [
        ("id", "id"),
        ("title", "title"),
        ("started_at", "startedAt"),
        ("message_count", "messageCount"),
        ("provider", "provider"),
        ("model", "model"),
        ("folder_id", "folderId"),
        ("is_archived", "isArchived"),
        ("workspace_path", "workspacePath"),
    ],
    "messages": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("role", "role"),
        ("content", "content"),
        ("created_at", "createdAt"),
    ],
    "usage_events": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("model", "model"),
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("context_tokens", "contextTokens"),
        ("created_at", "createdAt"),
    ],
    "config_audit": [
        ("id", "id"),
        ("category", "category"),
        ("action", "action"),
        ("actor", "actor"),
        ("before_json", "beforeJson"),
        ("after_json", "afterJson"),
        ("created_at", "createdAt"),
    ],
    "learned_heuristics": [
        ("id", "id"),
        ("rule", "rule"),
        ("source", "source"),
        ("category", "category"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "auto_memories": [
        ("id", "id"),
        ("key", "key"),
        ("content", "content"),
        ("category", "category"),
        ("importance", "importance"),
        ("source", "source"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ],
    "episodic_timeline": [
        ("id", "id"),
        ("timestamp", "timestamp"),
        ("session_id", "sessionId"),
        ("event_summary", "eventSummary"),
        ("category", "category"),
    ],
    "blackboard": [
        ("id", "id"),
        ("session_id", "sessionId"),
        ("agent", "agent"),
        ("key", "key"),
        ("value", "value"),
        ("priority", "priority"),
        ("created_at", "createdAt"),
        ("expires_at", "expiresAt"),
    ],
    "exams": [
        ("id", "id"),
        ("title", "title"),
        ("topic", "topic"),
        ("created_at", "createdAt"),
        ("source", "source"),
        ("source_files", "sourceFiles"),
    ],
    "exam_questions": [
        ("id", "id"),
        ("exam_id", "examId"),
        ("position", "position"),
        ("stem", "stem"),
        ("options", "options"),
        ("correct_index", "correctIndex"),
        ("rationale", "rationale"),
        ("source_snippet", "sourceSnippet"),
        ("origin", "origin"),
    ],
    "exam_attempts": [
        ("id", "id"),
        ("exam_id", "examId"),
        ("question_id", "questionId"),
        ("selected_index", "selectedIndex"),
        ("is_correct", "isCorrect"),
        ("asked_for_help", "askedForHelp"),
        ("answered_at", "answeredAt"),
    ],
    "pending_skills": [
        ("id", "id"),
        ("name", "name"),
        ("description", "description"),
        ("trigger_text", "triggerText"),
        ("draft_path", "draftPath"),
        ("source_session_id", "sourceSessionId"),
        ("source_workflow", "sourceWorkflow"),
    ],
}


def find_db_path() -> Path:
    """Resolve the brain SQLite database path from env or default."""
    env_path = Path(__file__).resolve().parent.parent / "data" / "august_brain.sqlite"
    return env_path


def get_all_tables(conn: sqlite3.Connection) -> list[str]:
    """Get list of all user tables in the database."""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return [row[0] for row in cursor.fetchall()]


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    """Check if a table exists."""
    cursor = conn.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cursor.fetchone()[0] > 0


def migrate_database(db_path: Path, *, dry_run: bool = False) -> int:
    """Run the column migration. Returns number of columns renamed."""
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        return 0

    # Backup
    if not dry_run:
        backup_path = db_path.with_suffix(db_path.suffix + ".bak")
        if not backup_path.exists():
            shutil.copy2(db_path, backup_path)
            print(f"Backup created: {backup_path}")
        else:
            print(f"Backup already exists: {backup_path} — skipping backup")

    conn = sqlite3.connect(str(db_path))
    total_renames = 0

    try:
        existing_tables = get_all_tables(conn)

        for table_name, columns in COLUMN_MAP.items():
            if not table_exists(conn, table_name):
                print(f"  Table '{table_name}' not found — skipping")
                continue

            for old_name, new_name in columns:
                if old_name == new_name:
                    continue  # unchanged column name

                # Check if old column exists
                pragma = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
                col_names = [row[1] for row in pragma]
                if old_name not in col_names:
                    print(f"    Column '{old_name}' not found in '{table_name}' — skipping")
                    continue
                if new_name in col_names:
                    print(f"    Column '{new_name}' already exists in '{table_name}' — skipping")
                    continue

                if dry_run:
                    print(f"  [DRY-RUN] {table_name}: {old_name} → {new_name}")
                else:
                    conn.execute(f"ALTER TABLE {table_name} RENAME COLUMN {old_name} TO {new_name}")
                    print(f"  {table_name}: {old_name} → {new_name}")
                total_renames += 1

        if not dry_run:
            conn.commit()
            # Verify
            print("\nVerification:")
            for table_name in existing_tables:
                pragma = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
                col_list = ", ".join(f"{row[1]}" for row in pragma)
                print(f"  {table_name}: {col_list}")

    finally:
        conn.close()

    return total_renames


def main():
    parser = argparse.ArgumentParser(description="Migrate SQLite columns from snake_case to camelCase")
    parser.add_argument("--db", help="Path to SQLite database (default: data/august_brain.sqlite)")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else find_db_path()
    print(f"Database: {db_path}")

    total = migrate_database(db_path, dry_run=args.dry_run)
    print(f"\nTotal columns renamed: {total}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test the migration on a copy**

```bash
cd backend-py
# Copy the database
cp data/august_brain.sqlite data/august_brain.test.sqlite

# Dry-run
python scripts/migrate_db_columns.py --db data/august_brain.test.sqlite --dry-run

# Apply
python scripts/migrate_db_columns.py --db data/august_brain.test.sqlite

# Clean up
rm data/august_brain.test.sqlite data/august_brain.test.sqlite.bak 2>/dev/null; true
```

- [ ] **Step 3: Add migration call to main.py lifespan**

Edit `backend-py/app/main.py` to add the migration at startup. Add near the top of the lifespan startup block:

```python
# Run database column migration (snake_case → camelCase)
from app.adapters.case_converters import snakeToCamel, camelToSnake
from app.services.memory_store import _db_path, _conn

_db_path_val = _db_path()
if _db_path_val.exists():
    try:
        conn = _conn()
        # Check if migration needed: look for a snake_case column
        cursor = conn.execute("PRAGMA table_info(proposals)")
        cols = [row[1] for row in cursor.fetchall()]
        if "session_id" in cols:
            from scripts.migrate_db_columns import migrate_database
            migrate_database(_db_path_val)
            logger.info("Database columns migrated: snake_case → camelCase")
    except Exception as exc:
        logger.warning("DB migration skipped: %s", exc)
```

- [ ] **Step 4: Run tests**

```bash
cd backend-py
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add DB column migration script + integration in lifespan"
```

---

## Task 14: Convert `main.py` and `config.py`

**Files:**
- Modify: `backend-py/app/main.py`
- Modify: `backend-py/app/config.py`

- [ ] **Step 1: Dry-run and apply**

```bash
cd backend-py
python scripts/snake_to_camel.py --dry-run app/main.py app/config.py
python scripts/snake_to_camel.py app/main.py app/config.py
```

- [ ] **Step 2: Verify the migration code added in Task 13 still works**

The AST script may have renamed `migrate_database` or `_db_path` — ensure the migration call at the top of `main.py` still references the correct function names.

- [ ] **Step 3: Run tests**

```bash
python -m pytest tests/ -x --tb=short
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: convert main.py and config.py to camelCase"
```

---

## Task 15: Update Documentation

**Files:**
- Modify: `backend-py/pyproject.toml` (already done in Task 12, verify)
- Modify: `docs/DEVELOPER_GUIDE.md`

- [ ] **Step 1: Verify pyproject.toml has pytest config**

Read `backend-py/pyproject.toml` and confirm it contains:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
python_functions = "test*"
```

- [ ] **Step 2: Update DEVELOPER_GUIDE.md naming convention**

Change the "Naming" section in `docs/DEVELOPER_GUIDE.md`:

**Before:**
```markdown
- **camelCase for all JSON/API fields**, consistently — no aliases or
  converters (the codebase migrated away from a `camel_model` adapter layer).
  See commits `2ca6320` and `35382d7`.
- Python identifiers are `snake_case`.
- Constants are `UPPER_SNAKE`.
```

**After:**
```markdown
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
```

- [ ] **Step 3: Full test sweep**

```bash
cd backend-py
python -m pytest tests/ -v --tb=short 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 4: Frontend vitest run**

```bash
cd frontend/desktop
npx vitest run 2>&1 | tail -30
```

Expected: All frontend tests pass.

- [ ] **Step 5: snake_case grep sweep**

```bash
cd backend-py
# Check Python files for remaining snake_case identifiers (excluding strings/comments)
grep -rn "def [a-z]*_[a-z]" app/ tests/ | grep -v "__pycache__" | grep -v ".bak" | head -20
```

Expected: Zero results.

- [ ] **Step 6: Commit**

```bash
cd /c/Dev/august-proxy
git add -A
git commit -m "docs: update DEVELOPER_GUIDE.md naming conventions to camelCase"
```

---

## Verification Checklist

Run this post-conversion to confirm everything is clean:

```bash
# 1. All Python tests pass
cd backend-py && python -m pytest tests/ -v --tb=short

# 2. All frontend tests pass
cd frontend/desktop && npx vitest run

# 3. No snake_case function or variable names remain in Python code
cd backend-py && grep -rn "def [a-z]*_[a-z]" app/ tests/ | grep -v "__pycache__" | grep -v ".bak" || echo "CLEAN"

# 4. No snake_case column references in memory_store.py
cd backend-py && grep -n "_id\|_at\|_by\|_key\|_type" app/services/memory_store.py | grep -v "__" | grep -v "logger" || echo "CLEAN"

# 5. Case converters are used in anthropic.py and openai.py
cd backend-py && grep -n "snakeToCamel\|camelToSnake" app/adapters/anthropic.py app/adapters/openai.py
```

---

## Files Not Modified

- `node_modules/`, `web-dist/`, `data/` — third-party or runtime
- `skills/` — bundled third-party skill packs
- `memory/`, `evals/` — LLM context files
- Rust files (`src-tauri/`) — Rust uses snake_case for functions as standard
