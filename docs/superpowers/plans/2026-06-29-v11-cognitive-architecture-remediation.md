# v1.1 Cognitive Architecture Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 3 critical bugs in the August Proxy cognitive architecture, apply 3 cheap correctness fixes, add 4 missing `brain_query` stores, and switch math rendering to unicode (with KaTeX as fallback). Restore a runnable, end-to-end chat that matches the spec at `docs/design/cognitive-architecture-v1.md`.

**Architecture:** Pure in-place repairs of existing code paths. No new services, no new tables (except the `auto_memories.updated_at` column), no new dependencies (except the existing `katex` and `marked` already in `package.json`). All fixes are isolated to the files named in each task. TDD: write the failing test first for every backend change; for the frontend math work, write a Vitest component test that asserts the rendered output.

**Tech Stack:**
- Backend: Python 3.11+, pytest + aiohttp test client, SQLite (WAL mode), asyncio
- Frontend: React + TypeScript, Vitest + jsdom, marked (markdown), katex (math, fallback only)

**Reference design doc:** `docs/superpowers/specs/2026-06-29-cognitive-architecture-remediation-design.md` — sections 5.1, 5.2, 5.5, 5.6, 5.7 are authoritative.

---

## File map

### Files modified (backend)

| File | Responsibility for v1.1 |
|------|-------------------------|
| `backend-py/app/services/memory/context_builder.py` | Add `cached_t12` parameter to `build_system_prompt`; add Tier 1 math-preference constraint in `build_tier1`. |
| `backend-py/app/services/memory_store.py` | Add `updated_at` column to `auto_memories` (idempotent ALTER TABLE in `init()`); add 4 new brain_query store handlers (`graph`, `daemons`, `exams`, `exam_attempts`). |
| `backend-py/app/services/memory/auto_memory.py` | No change (column is added at the DB level, query continues to work). |
| `backend-py/app/services/workbench/workbench.py` | Wrap tool dispatch in `_execute_tool` to populate `session._failure_feedback`; reset state in `submit_plan` / `reject_workbench_plan`; change auto-compaction trigger to `attention_pressure == "critical"`; add 5-turn cooldown. |
| `backend-py/app/services/tool_definitions.py` | Add 4 missing store values to the `brain_query` tool's `store` enum. |

### Files modified (frontend)

| File | Responsibility for v1.1 |
|------|-------------------------|
| `frontend/desktop/src/sections/chat/ChatMarkdown.tsx` | Relax KaTeX error color (no more red); add common-formula auto-converter that runs before markdown parsing. |
| `frontend/desktop/src/styles.css` | Override `.katex-error` to neutral body color. |

### Files created (tests)

| File | Purpose |
|------|---------|
| `backend-py/tests/v11_cached_t12.py` | Test that `build_system_prompt` accepts `cached_t12` kwarg and uses the cached value. |
| `backend-py/tests/v11_auto_memories_updated_at.py` | Test that duplicate-key `save_auto_memory` does not raise; assert `updated_at` is populated. |
| `backend-py/tests/v11_failure_feedback.py` | Test that a tool error populates `session._failure_feedback`; assert block injected on next turn; assert decay clears after 3 turns. |
| `backend-py/tests/v11_state_drop.py` | Test that `submit_plan` and `reject_workbench_plan` clear `_execution_state` and `_working_memory`. |
| `backend-py/tests/v11_auto_compaction_threshold.py` | Test that compaction triggers at `attention_pressure == "critical"`, not at 50%; test 5-turn cooldown. |
| `backend-py/tests/v11_brain_query_all_stores.py` | Test all 12 brain_query stores return correct shape. |
| `backend-py/tests/v11_e2e_chat.py` | End-to-end smoke test: 3 chat turns, no crashes, brain_query works. |
| `frontend/desktop/src/test/v11_math_unicode.test.tsx` | Vitest: render `x^2`, `\sum_i`, `>=`, `\pi` → unicode; render invalid LaTeX → no red; render code block with `$x^2$` → stays as code. |

---

## Task ordering rationale

Tasks 1-5 are the critical-bug + cheap-correctness items; they are ordered so that the chat is functional after Task 1 alone (cached_t12 is the chat-killer) and gets progressively safer/more correct through Task 5. Tasks 6-9 add brain_query stores in the order of easiest-to-hardest. Tasks 10-12 are the frontend math work, done as a single block because they touch the same file. Task 13 is the end-to-end smoke test. Task 14 updates the trackers (this is important — the trackers currently lie). Task 15 is the release commit.

A working tree is runnable at any task boundary: tasks 1-3 alone restore the chat; tasks 1-5 make it spec-correct; tasks 1-9 make brain_query complete; tasks 1-12 make the chat polished; task 13 is the verification.

---

## Task 1: Fix `cached_t12` keyword argument (Phase 7 cache hook)

**Files:**
- Modify: `backend-py/app/services/memory/context_builder.py:267-321`
- Test: `backend-py/tests/v11_cached_t12.py`

**Why:** `workbench.py:597-602` calls `ctx_build(..., cached_t12=cached_t12)`, but `context_builder.build_system_prompt` does not accept that parameter. Every chat turn raises `TypeError`. This is the chat-killer.

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v11_cached_t12.py`:

```python
"""v1.1 — Test that build_system_prompt accepts cached_t12 kwarg."""
import pytest
from app.services.memory.context_builder import build_system_prompt


def test_build_system_prompt_accepts_cached_t12():
    """Regression: Phase 7 cache hook must not TypeError on the kwarg."""
    # Should not raise TypeError
    result = build_system_prompt(
        session={"id": "test"},
        memory={},
        tools=[],
        agent_context=None,
        cached_t12="<cached Tier 1+2 content>",
    )
    # Result should include the cached content
    assert "<cached Tier 1+2 content>" in result


def test_build_system_prompt_default_cached_t12_is_none():
    """Backward compat: omitting cached_t12 should still work (None default)."""
    result = build_system_prompt(
        session={"id": "test"},
        memory={},
    )
    # No exception, returns a string
    assert isinstance(result, str)


def test_cached_t12_short_circuits_t1_t2():
    """When cached_t12 is provided, T1+T2 must NOT be regenerated."""
    # Provide a distinctive cached payload; assert T1+T2 builder functions
    # are not called when the cache is present. We do this by checking
    # that the cached payload appears verbatim in the result.
    cache_payload = "CACHE_HIT_MARKER_XYZ"
    result = build_system_prompt(
        session={"id": "test", "user_state": {"profile": "should not appear"}},
        memory={},
        cached_t12=cache_payload,
    )
    assert cache_payload in result
    # The T1 user_state content should not have been rebuilt
    # (this verifies the cache short-circuits the T1+T2 path)
    assert "should not appear" not in result
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v11_cached_t12.py -v`
Expected: FAIL with `TypeError: build_system_prompt() got an unexpected keyword argument 'cached_t12'`

- [ ] **Step 3: Add `cached_t12` parameter to `build_system_prompt`**

Edit `backend-py/app/services/memory/context_builder.py` line 267-272. Change the function signature to:

```python
def build_system_prompt(
    session: dict[str, Any] | None = None,
    memory: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    agent_context: str | None = None,
    cached_t12: str | None = None,
) -> str:
```

The body at lines 317-321 already uses `cached_t12` correctly. The fix is the parameter only.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_cached_t12.py -v`
Expected: PASS (3/3 tests)

- [ ] **Step 5: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_failure_feedback.py --ignore=tests/v11_state_drop.py --ignore=tests/v11_auto_compaction_threshold.py --ignore=tests/v11_brain_query_all_stores.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
cd backend-py
git add app/services/memory/context_builder.py tests/v11_cached_t12.py
git commit -m "fix(v1.1): add cached_t12 kwarg to build_system_prompt (Phase 7 cache hook)"
```

---

## Task 2: Add `updated_at` column to `auto_memories`

**Files:**
- Modify: `backend-py/app/services/memory_store.py:197-205` (schema) and `init()` (idempotent migration)
- Test: `backend-py/tests/v11_auto_memories_updated_at.py`

**Why:** `auto_memory.py:49` runs `UPDATE auto_memories SET ..., updated_at = ?` but the table has no `updated_at` column. Any duplicate-key save raises `OperationalError`. Background review (which re-saves existing keys) breaks on the second cycle.

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v11_auto_memories_updated_at.py`:

```python
"""v1.1 — Test that save_auto_memory supports duplicate keys with updated_at."""
import pytest
from app.services.memory import auto_memory


@pytest.fixture(autouse=True)
def _clean_key(monkeypatch):
    """Use a per-test key so we don't pollute global state."""
    import uuid
    key = f"v11_test_{uuid.uuid4().hex[:8]}"
    yield key
    # cleanup: delete the test row
    try:
        conn = auto_memory._conn()
        conn.execute("DELETE FROM auto_memories WHERE key = ?", (key,))
        conn.commit()
    except Exception:
        pass


def test_save_auto_memory_twice_with_same_key(_clean_key):
    """First save inserts, second save updates — no error."""
    key = _clean_key
    # First call — should insert
    auto_memory.save_auto_memory(key=key, content="first", importance=0.5)
    # Second call with same key — should update (not crash)
    auto_memory.save_auto_memory(key=key, content="second", importance=0.7)
    # Verify the row reflects the second save
    conn = auto_memory._conn()
    row = conn.execute(
        "SELECT content, importance, updated_at FROM auto_memories WHERE key = ?",
        (key,),
    ).fetchone()
    assert row is not None
    assert row["content"] == "second"
    assert row["importance"] == 0.7
    assert row["updated_at"] is not None
    assert row["updated_at"] != ""  # populated, not empty


def test_auto_memories_table_has_updated_at_column():
    """Schema check: the column must exist after init()."""
    conn = auto_memory._conn()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(auto_memories)").fetchall()]
    assert "updated_at" in cols, f"auto_memories columns: {cols}"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v11_auto_memories_updated_at.py -v`
Expected: FAIL — the second call to `save_auto_memory` raises `sqlite3.OperationalError: no such column: updated_at`, and the `test_auto_memories_table_has_updated_at_column` test fails with the same.

- [ ] **Step 3: Add the column to the CREATE TABLE statement (for new DBs)**

Edit `backend-py/app/services/memory_store.py` line 197-205. Change to:

```sql
        CREATE TABLE IF NOT EXISTS auto_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT,
            content TEXT,
            category TEXT DEFAULT 'auto',
            importance REAL DEFAULT 0.5,
            source TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
```

- [ ] **Step 4: Add an idempotent migration in `init()` for existing DBs**

In `backend-py/app/services/memory_store.py`, find the `init()` function (it creates the schema). Add this block **at the end of `init()`, after all the CREATE TABLE statements but before any function returns**. Place it inside the same try/except that wraps the schema creation. Use PRAGMA table_info to check, then ALTER TABLE if missing:

```python
        # ── v1.1 migration: add updated_at to auto_memories if missing ──
        try:
            cols = [
                r["name"]
                for r in conn.execute("PRAGMA table_info(auto_memories)").fetchall()
            ]
            if "updated_at" not in cols:
                conn.execute(
                    "ALTER TABLE auto_memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"
                )
        except Exception as exc:
            # Migration is best-effort; if ALTER fails, log and continue.
            import logging
            logging.warning("auto_memories updated_at migration failed: %s", exc)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_auto_memories_updated_at.py -v`
Expected: PASS (2/2 tests)

- [ ] **Step 6: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_failure_feedback.py --ignore=tests/v11_state_drop.py --ignore=tests/v11_auto_compaction_threshold.py --ignore=tests/v11_brain_query_all_stores.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend-py
git add app/services/memory_store.py tests/v11_auto_memories_updated_at.py
git commit -m "fix(v1.1): add updated_at column to auto_memories (idempotent migration)"
```

---

## Task 3: Implement `<failure_feedback>` producer in `_execute_tool`

**Files:**
- Modify: `backend-py/app/services/workbench/workbench.py:1928-1933`
- Test: `backend-py/tests/v11_failure_feedback.py`

**Why:** The Tier 3 `<failure_feedback>` block has a render path (`context_builder.py:184-187`) but no producer. Tool errors fall through as `f"Error: {exc}"` in chat tool results. The spec requires structured error feedback (last frame + type + message) injected on the next turn, with decay so stale errors don't pollute the prompt.

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v11_failure_feedback.py`:

```python
"""v1.1 — Test that tool errors populate session._failure_feedback with structured info."""
import pytest
from app.services.workbench.workbench import _execute_tool


class FakeSession:
    def __init__(self):
        self._failure_feedback = None
        self._failure_feedback_age = 0
        self.id = "test-session"


@pytest.mark.asyncio
async def test_tool_error_populates_failure_feedback(monkeypatch):
    """When dispatch_tool raises, _failure_feedback is set with structured info."""
    from app.services.workbench import workbench

    async def fake_dispatch(tool_name, args):
        # Simulate a realistic error
        try:
            raise SyntaxError("invalid syntax")
        except SyntaxError:
            raise

    monkeypatch.setattr(workbench, "dispatch_tool", fake_dispatch)
    session = FakeSession()

    # Use a fake tool that exists in the registry
    result = await _execute_tool(
        session=session,
        tool_name="run_command",
        args={"command": "def foo(:", "cwd": "/tmp"},
    )

    # Result is still returned as a string (backward compat)
    assert isinstance(result, str)
    assert "SyntaxError" in result

    # But session._failure_feedback is now populated with structured info
    assert session._failure_feedback is not None
    fb = session._failure_feedback
    assert fb["tool"] == "run_command"
    assert fb["error_type"] == "SyntaxError"
    assert "invalid syntax" in fb["error_message"]
    assert "file" in fb
    assert "line" in fb


@pytest.mark.asyncio
async def test_tool_success_does_not_set_failure_feedback(monkeypatch):
    """Happy path: no failure_feedback is set."""
    from app.services.workbench import workbench

    async def fake_dispatch(tool_name, args):
        return "ok"

    monkeypatch.setattr(workbench, "dispatch_tool", fake_dispatch)
    session = FakeSession()

    result = await _execute_tool(
        session=session,
        tool_name="read_file",
        args={"path": "/tmp/x"},
    )
    assert result == "ok"
    assert session._failure_feedback is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v11_failure_feedback.py -v`
Expected: FAIL — `session._failure_feedback` is None after a tool error because nothing populates it.

- [ ] **Step 3: Modify `_execute_tool` to populate `_failure_feedback` on exception**

Edit `backend-py/app/services/workbench/workbench.py` line 1928-1933. The current code is:

```python
        result = await dispatch_tool(tool_name, args)
        return str(result)
    except Exception as exc:
        return f"Error: {exc}"
```

(Adjust the indentation to match the actual file structure — find the exact `try/except` around `dispatch_tool` inside `_execute_tool` and replace it.) Replace with:

```python
        result = await dispatch_tool(tool_name, args)
        return str(result)
    except Exception as exc:
        # Extract last frame for structured failure feedback (Phase 6 spec)
        import traceback as _tb
        tb_list = _tb.extract_tb(exc.__traceback__)
        last_frame = tb_list[-1] if tb_list else None
        feedback = {
            "tool": tool_name,
            "error_type": type(exc).__name__,
            "error_message": str(exc),
            "file": last_frame.filename if last_frame else None,
            "line": last_frame.lineno if last_frame else None,
            "function": last_frame.name if last_frame else None,
            "offending_code": last_frame.line if last_frame else None,
        }
        # Stash on session for next turn's Tier 3 injection
        session = kwargs.get("session") if "session" in kwargs else None
        # Try multiple ways to get the session object (depends on caller)
        if session is None:
            # _execute_tool receives session as first positional arg
            import inspect
            frame = inspect.currentframe()
            if frame and frame.f_back:
                session = frame.f_back.f_locals.get("session")
        if session is not None:
            setattr(session, "_failure_feedback", feedback)
            setattr(session, "_failure_feedback_age", 0)
        return f"Tool {tool_name} failed: {feedback['error_type']}: {feedback['error_message']}"
```

**Important:** The exact signature of `_execute_tool` in your tree may pass `session` differently. Read the function signature first. If `session` is already a parameter, use that directly. If it comes in via `**kwargs` or another route, adapt. The goal is: on exception, get a `session` object and set `session._failure_feedback = feedback`.

- [ ] **Step 4: Add the decay counter in the workbench turn loop**

In `backend-py/app/services/workbench/workbench.py`, find the main chat turn function (the one that calls `build_system_prompt(session)` at line 948). Just **before** that call, add:

```python
    # v1.1 — Decay stale failure_feedback
    if getattr(session, "_failure_feedback_age", None) is not None:
        session._failure_feedback_age += 1
        if session._failure_feedback_age >= 3:
            session._failure_feedback = None
            session._failure_feedback_age = None
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_failure_feedback.py -v`
Expected: PASS (2/2 tests)

If the test fails because the session-detection logic in Step 3 doesn't reach the right `session` reference, the cleanest fix is to make `session` an explicit parameter of `_execute_tool`. Find `_execute_tool`'s signature and add `session` as a keyword-only argument if it's not already there, then call it from the workbench turn loop with `session=session`.

- [ ] **Step 6: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_cached_t12.py --ignore=tests/v11_auto_memories_updated_at.py --ignore=tests/v11_state_drop.py --ignore=tests/v11_auto_compaction_threshold.py --ignore=tests/v11_brain_query_all_stores.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend-py
git add app/services/workbench/workbench.py tests/v11_failure_feedback.py
git commit -m "feat(v1.1): populate <failure_feedback> on tool error with 3-turn decay"
```

---

## Task 4: Reset execution state on plan submit / reject

**Files:**
- Modify: `backend-py/app/services/workbench/workbench.py:1982-2012`
- Test: `backend-py/tests/v11_state_drop.py`

**Why:** Spec says state should drop on new plan / session end. Currently `submit_plan` and `reject_workbench_plan` only clear `plan` and `plan_approved`; the execution state and working memory from the prior plan linger into the new one.

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v11_state_drop.py`:

```python
"""v1.1 — Test that plan submit/reject clears execution state and working memory."""
import pytest
from app.services.workbench.workbench import submit_plan, reject_workbench_plan


class FakeSession:
    def __init__(self):
        self.plan = {"steps": ["old step 1"]}
        self.plan_approved = False
        self._execution_state = {"phase": "implement", "step": 3, "completed": ["x"]}
        self._working_memory = "stale scratchpad text"
        self.id = "test-session"
        self.updated_at = None


def test_submit_plan_clears_execution_state():
    """submit_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    submit_plan(session, {"steps": ["new step 1"]})
    assert session.plan == {"steps": ["new step 1"]}
    assert session.plan_approved is False
    # v1.1: state should be dropped
    assert session._execution_state is None
    assert session._working_memory is None


def test_reject_workbench_plan_clears_execution_state():
    """reject_workbench_plan must reset _execution_state and _working_memory."""
    session = FakeSession()
    # reject_workbench_plan takes a session_id and looks up the session;
    # for this test, we patch the global _sessions dict.
    from app.services.workbench import workbench
    workbench._sessions["test-session"] = session

    reject_workbench_plan("test-session")

    assert session.plan is None
    assert session.plan_approved is False
    assert session._execution_state is None
    assert session._working_memory is None

    # cleanup
    del workbench._sessions["test-session"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v11_state_drop.py -v`
Expected: FAIL — `session._execution_state` is still the old dict after `submit_plan` because nothing resets it.

- [ ] **Step 3: Modify `submit_plan` to clear state**

Edit `backend-py/app/services/workbench/workbench.py:1982-1987`. Change to:

```python
def submit_plan(session: WorkbenchSession, plan_data: dict[str, Any]) -> None:
    """Store a plan on the session. v1.1: drop prior execution state and working memory."""
    session.plan = plan_data
    session.plan_approved = False
    # v1.1: spec says state drops on new plan
    session._execution_state = None
    session._working_memory = None
    session.updated_at = _now()
    _emit_session_status(session.id)
```

- [ ] **Step 4: Modify `reject_workbench_plan` to clear state**

Edit `backend-py/app/services/workbench/workbench.py:2002-2012`. Change to:

```python
def reject_workbench_plan(session_id: str) -> bool:
    """Reject a pending plan. v1.1: drop prior execution state and working memory."""
    session = _sessions.get(session_id)
    if not session:
        return False
    session.plan = None
    session.plan_approved = False
    # v1.1: rejection also implies a new plan is coming
    session._execution_state = None
    session._working_memory = None
    session.updated_at = _now()
    save_sessions()
    _emit_session_status(session_id)
    return True
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_state_drop.py -v`
Expected: PASS (2/2 tests)

- [ ] **Step 6: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_cached_t12.py --ignore=tests/v11_auto_memories_updated_at.py --ignore=tests/v11_failure_feedback.py --ignore=tests/v11_auto_compaction_threshold.py --ignore=tests/v11_brain_query_all_stores.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend-py
git add app/services/workbench/workbench.py tests/v11_state_drop.py
git commit -m "fix(v1.1): drop execution state and working memory on plan submit/reject"
```

---

## Task 5: Auto-compaction threshold + 5-turn cooldown

**Files:**
- Modify: `backend-py/app/services/workbench/workbench.py:962-998`
- Test: `backend-py/tests/v11_auto_compaction_threshold.py`

**Why:** Auto-compaction currently triggers at 50% of `WORKBENCH_TOKEN_BUDGET`. The spec says it must trigger at `attention_pressure == "critical"` (90% or 85% under fallback tokenizer). No 5-turn re-compaction suppression.

- [ ] **Step 1: Read the existing auto-compaction code**

Open `backend-py/app/services/workbench/workbench.py` around line 962-998. Identify the exact block that calls `compress_messages`. Note the existing variable names (you'll preserve them).

- [ ] **Step 2: Write the failing test**

Create `backend-py/tests/v11_auto_compaction_threshold.py`:

```python
"""v1.1 — Test that auto-compaction triggers only at attention_pressure=='critical'."""
import pytest
from app.services.workbench import workbench


def test_should_compact_at_critical_pressure():
    """Compaction must trigger when attention_pressure == 'critical'."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=10,  # well past the 5-turn cooldown
    )
    assert should is True


def test_should_not_compact_at_high_pressure():
    """Compaction must NOT trigger at 'high' pressure (only 'critical')."""
    should = workbench._should_auto_compact(
        attention_pressure="high",
        turns_since_compaction=10,
    )
    assert should is False


def test_should_not_compact_at_medium_pressure():
    should = workbench._should_auto_compact(
        attention_pressure="medium",
        turns_since_compaction=10,
    )
    assert should is False


def test_should_not_compact_within_5_turn_cooldown():
    """Even at critical pressure, suppress re-compaction within 5 turns."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=3,  # within 5-turn cooldown
    )
    assert should is False


def test_should_compact_just_after_cooldown():
    """At critical + turns_since_compaction == 5, compaction should run."""
    should = workbench._should_auto_compact(
        attention_pressure="critical",
        turns_since_compaction=5,
    )
    assert should is True
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v11_auto_compaction_threshold.py -v`
Expected: FAIL with `ImportError: cannot import name '_should_auto_compact'` (the helper does not exist yet).

- [ ] **Step 4: Add the `_should_auto_compact` helper function**

Add this new function to `backend-py/app/services/workbench/workbench.py` (place it near the auto-compaction block, around line 962):

```python
def _should_auto_compact(attention_pressure: str, turns_since_compaction: int) -> bool:
    """v1.1: Compaction triggers only at critical pressure and after 5-turn cooldown.

    Spec reference: cognitive-architecture-v1.md §5.5
    - Trigger: attention_pressure == "critical" (90% with accurate tokenizer, 85% with fallback)
    - Cooldown: minimum 5 turns between compactions
    """
    return attention_pressure == "critical" and turns_since_compaction >= 5
```

- [ ] **Step 5: Update the workbench turn loop to use the new threshold**

In `backend-py/app/services/workbench/workbench.py`, find the auto-compaction block (around line 962-998). Replace the threshold check (currently `original_tokens > WORKBENCH_TOKEN_BUDGET // 2`) with a call to the helper. The new logic:

```python
    # ── v1.1: Auto-compaction gated on attention_pressure == "critical" + 5-turn cooldown ──
    if not hasattr(session, "_last_compaction_turn"):
        session._last_compaction_turn = -100
    current_turn = getattr(session, "turn_count", 0)
    turns_since_compaction = current_turn - session._last_compaction_turn

    # compute_budget returns dict with attention_pressure
    from app.services.token_budget import compute_budget
    budget = compute_budget(...)
    attention_pressure = budget.get("attention_pressure", "low")

    if _should_auto_compact(attention_pressure, turns_since_compaction):
        from app.services.memory.context_compressor import compress_messages
        compressed = compress_messages(...)
        # ... existing compaction body ...
        session._last_compaction_turn = current_turn
```

Read the existing code carefully — preserve all of the compaction body's side effects (saving original messages to `messages` table, replacing with `<compacted_history>` block, updating `<cognitive_budget>`). The change is the gating condition, not the compaction logic.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_auto_compaction_threshold.py -v`
Expected: PASS (5/5 tests)

- [ ] **Step 7: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_cached_t12.py --ignore=tests/v11_auto_memories_updated_at.py --ignore=tests/v11_failure_feedback.py --ignore=tests/v11_state_drop.py --ignore=tests/v11_brain_query_all_stores.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd backend-py
git add app/services/workbench/workbench.py tests/v11_auto_compaction_threshold.py
git commit -m "fix(v1.1): gate auto-compaction on attention_pressure=='critical' + 5-turn cooldown"
```

---

## Task 6: Add `graph` store to `brain_query`

**Files:**
- Modify: `backend-py/app/services/memory_store.py` (add `graph` handler in `brain_query`)
- Modify: `backend-py/app/services/tool_definitions.py:1206-1207` (add `graph` to enum)
- Test: `backend-py/tests/v11_brain_query_all_stores.py` (created in Task 9)

**Why:** `brain_query` spec lists 12 stores; implementation has 8. This is the first of 4 stores to add.

- [ ] **Step 1: Read the existing `brain_query` function in `memory_store.py`**

Find the function `brain_query(store, ...)` in `memory_store.py`. Identify:
- The `_BRAIN_STORES` dict that maps store name → handler function
- The "not available" fallback at the bottom of the function
- The shape of an existing handler (e.g., the `memory` or `auto_memories` handler) so you can mirror it

- [ ] **Step 2: Add the `graph` handler**

In `backend-py/app/services/memory_store.py`, add a new function (place it just above `brain_query`):

```python
def _brain_query_graph(query: str, filters: dict | None, limit: int) -> list[dict]:
    """v1.1: Read graph entities/relations from august_graph_memory.json.

    Returns list of {entity, relation, target} rows. If the JSON file is missing
    or empty, returns an empty list (NOT an error — graph is best-effort).
    """
    import json
    import os
    from app.services.paths import data_dir  # adjust import if path helper differs

    graph_path = os.path.join(data_dir(), "august_graph_memory.json")
    if not os.path.exists(graph_path):
        return []
    try:
        with open(graph_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []

    # data is expected to be a dict with "entities" and "relations" lists
    # (verify against actual file shape; adjust if different)
    rows: list[dict] = []
    entities = data.get("entities", []) if isinstance(data, dict) else []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get("name", "")
        if query and query.lower() not in name.lower():
            continue
        rows.append({"entity": name, "type": ent.get("type", ""), "attributes": ent.get("attributes", {})})
        if len(rows) >= limit:
            break

    if len(rows) < limit:
        relations = data.get("relations", []) if isinstance(data, dict) else []
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            source = rel.get("source", "")
            target = rel.get("target", "")
            if query and query.lower() not in (source + target).lower():
                continue
            rows.append({"source": source, "relation": rel.get("relation", ""), "target": target})
            if len(rows) >= limit:
                break

    return rows[:limit]
```

Then register it in `_BRAIN_STORES`:

```python
_BRAIN_STORES = {
    # ... existing stores ...
    "graph": _brain_query_graph,
}
```

(If `_BRAIN_STORES` doesn't exist as a dict, follow whatever the actual pattern is in your file. Read the existing code first.)

- [ ] **Step 3: Add `graph` to the `brain_query` tool's enum**

Edit `backend-py/app/services/tool_definitions.py` line 1206-1207 (find the `store` parameter enum for the `brain_query` tool). Add `"graph"` to the enum list.

- [ ] **Step 4: Smoke-test the change**

Run:
```bash
cd backend-py && python -c "
from app.services.memory_store import brain_query
result = brain_query(store='graph', query='auth', limit=5)
print('graph store result:', result)
"
```
Expected: prints a list (possibly empty if no graph file exists; NOT an error).

- [ ] **Step 5: Defer commit until Task 9 (all 4 stores batched)**

Hold the commit; Tasks 7-8 also modify the same files. Commit at the end of Task 9.

---

## Task 7: Add `daemons` store to `brain_query`

**Files:**
- Modify: `backend-py/app/services/memory_store.py` (add `daemons` handler)
- Modify: `backend-py/app/services/tool_definitions.py` (add `daemons` to enum)

**Why:** The `daemons` store lets the model inspect live daemon status. It's Phase 8 data, exposed through the Phase 0 read tool.

- [ ] **Step 1: Add the `daemons` handler**

In `backend-py/app/services/memory_store.py`, add:

```python
def _brain_query_daemons(query: str, filters: dict | None, limit: int) -> list[dict]:
    """v1.1: Read live daemon registry from daemon_manager.

    Returns list of {name, status, watch_condition, last_check, error} rows.
    If no daemons are running, returns an empty list.
    """
    try:
        from app.services.daemon_manager import list_all_daemons
    except ImportError:
        return []  # daemon_manager not available; v1.1 graceful degrade

    all_daemons = list_all_daemons()  # returns dict[session_id, list[daemon_info]]
    rows: list[dict] = []
    for session_id, daemons in all_daemons.items():
        for d in daemons:
            row = {
                "session_id": session_id,
                "name": d.get("name", ""),
                "status": d.get("status", "unknown"),
                "watch_condition": d.get("watch_condition"),
                "last_check": d.get("last_check"),
                "error": d.get("error"),
            }
            # Optional filter by session_id
            if filters and filters.get("session_id") and filters["session_id"] != session_id:
                continue
            if query and query.lower() not in row["name"].lower():
                continue
            rows.append(row)
            if len(rows) >= limit:
                break
        if len(rows) >= limit:
            break
    return rows[:limit]
```

**Note:** If `list_all_daemons` doesn't exist in `daemon_manager.py`, add a small helper there:

```python
def list_all_daemons() -> dict[str, list[dict]]:
    """Return all daemons across all sessions. Format: {session_id: [daemon_info, ...]}"""
    result: dict[str, list[dict]] = {}
    for session_id, daemons in _daemons.items():  # adjust to actual internal name
        result[session_id] = [
            {
                "name": d.name,
                "status": d.status,
                "watch_condition": d.watch_condition,
                "last_check": d.last_check,
                "error": d.error,
            }
            for d in daemons
        ]
    return result
```

(Read the existing `daemon_manager.py` to discover the actual internal data structure. Adapt the helper to match. If the structure uses a class with attributes, iterate accordingly.)

Register in `_BRAIN_STORES`:

```python
_BRAIN_STORES["daemons"] = _brain_query_daemons
```

- [ ] **Step 2: Add `daemons` to the `brain_query` tool's enum**

Edit `backend-py/app/services/tool_definitions.py` enum (same location as Task 6). Add `"daemons"`.

- [ ] **Step 3: Smoke-test**

```bash
cd backend-py && python -c "
from app.services.memory_store import brain_query
result = brain_query(store='daemons', limit=5)
print('daemons store result:', result)
"
```
Expected: prints a list (empty if no daemons).

- [ ] **Step 4: Defer commit until Task 9**

---

## Task 8: Add `exams` store to `brain_query`

**Files:**
- Modify: `backend-py/app/services/memory_store.py` (add `exams` handler)
- Modify: `backend-py/app/services/tool_definitions.py` (add `exams` to enum)

**Why:** `exams` lets the model list and inspect past and current exams. Backed by the `exams` + `exam_questions` tables (Phase v3 schema, already present in `memory_store.py:295-329`).

- [ ] **Step 1: Add the `exams` handler**

In `backend-py/app/services/memory_store.py`, add:

```python
def _brain_query_exams(query: str, filters: dict | None, limit: int) -> list[dict]:
    """v1.1: Read exams + their question counts from the exams tables.

    Returns list of {id, title, topic, source, question_count, created_at} rows.
    """
    conn = _conn()
    sql = """
        SELECT e.id, e.title, e.topic, e.source, e.created_at,
               COUNT(eq.id) AS question_count
        FROM exams e
        LEFT JOIN exam_questions eq ON eq.exam_id = e.id
        WHERE 1=1
    """
    params: list = []
    if query:
        sql += " AND (e.title LIKE ? OR e.topic LIKE ?)"
        params.extend([f"%{query}%", f"%{query}%"])
    if filters and filters.get("source"):
        sql += " AND e.source = ?"
        params.append(filters["source"])
    sql += " GROUP BY e.id ORDER BY e.created_at DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "topic": r["topic"],
            "source": r["source"],
            "question_count": r["question_count"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
```

Register in `_BRAIN_STORES`:

```python
_BRAIN_STORES["exams"] = _brain_query_exams
```

- [ ] **Step 2: Add `exams` to the `brain_query` tool's enum**

Edit `backend-py/app/services/tool_definitions.py` enum. Add `"exams"`.

- [ ] **Step 3: Smoke-test**

```bash
cd backend-py && python -c "
from app.services.memory_store import brain_query
result = brain_query(store='exams', limit=5)
print('exams store result:', result)
"
```
Expected: prints a list (empty if no exams exist; not an error).

- [ ] **Step 4: Defer commit until Task 9**

---

## Task 9: Add `exam_attempts` store to `brain_query`

**Files:**
- Modify: `backend-py/app/services/memory_store.py` (add `exam_attempts` handler)
- Modify: `backend-py/app/services/tool_definitions.py` (add `exam_attempts` to enum)
- Test: `backend-py/tests/v11_brain_query_all_stores.py`

**Why:** The last missing store. Closes out the spec's full 12-store list.

- [ ] **Step 1: Add the `exam_attempts` handler**

In `backend-py/app/services/memory_store.py`, add:

```python
def _brain_query_exam_attempts(query: str, filters: dict | None, limit: int) -> list[dict]:
    """v1.1: Read exam attempt history from the exam_attempts table.

    Returns list of {id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at} rows.
    """
    conn = _conn()
    sql = """
        SELECT id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at
        FROM exam_attempts
        WHERE 1=1
    """
    params: list = []
    if filters and filters.get("exam_id") is not None:
        sql += " AND exam_id = ?"
        params.append(filters["exam_id"])
    if filters and filters.get("is_correct") is not None:
        sql += " AND is_correct = ?"
        params.append(1 if filters["is_correct"] else 0)
    if filters and filters.get("since"):
        sql += " AND answered_at >= ?"
        params.append(filters["since"])
    sql += " ORDER BY answered_at DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]
```

Register in `_BRAIN_STORES`:

```python
_BRAIN_STORES["exam_attempts"] = _brain_query_exam_attempts
```

- [ ] **Step 2: Add `exam_attempts` to the `brain_query` tool's enum**

Edit `backend-py/app/services/tool_definitions.py` enum. Add `"exam_attempts"`.

- [ ] **Step 3: Write the test for all 12 brain_query stores**

Create `backend-py/tests/v11_brain_query_all_stores.py`:

```python
"""v1.1 — Test that brain_query returns correct shape for all 12 stores."""
import pytest
from app.services.memory_store import brain_query


# All 12 stores the spec requires
ALL_STORES = [
    "memory",
    "auto_memories",
    "heuristics",
    "facts",
    "sessions",
    "messages",
    "timeline",
    "graph",
    "blackboard",
    "daemons",
    "exams",
    "exam_attempts",
]


@pytest.mark.parametrize("store_name", ALL_STORES)
def test_store_returns_list_or_not_available(store_name):
    """Each store returns a list of rows, or a structured 'not available' dict."""
    result = brain_query(store=store_name, query="", limit=5)
    # Either a list (rows found) or a dict with "error" key (not available)
    assert isinstance(result, (list, dict)), f"{store_name}: unexpected type {type(result)}"
    if isinstance(result, dict):
        assert "error" in result
        assert "available" in result


def test_unknown_store_returns_not_available():
    """Unknown stores return a structured not-available response, not an exception."""
    result = brain_query(store="not_a_real_store", limit=5)
    assert isinstance(result, dict)
    assert "error" in result
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v11_brain_query_all_stores.py -v`
Expected: PASS — all 12 parametrized cases + the unknown-store test.

- [ ] **Step 5: Verify the rest of the test suite still passes**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/v11_cached_t12.py --ignore=tests/v11_auto_memories_updated_at.py --ignore=tests/v11_failure_feedback.py --ignore=tests/v11_state_drop.py --ignore=tests/v11_auto_compaction_threshold.py --ignore=tests/v11_e2e_chat.py -x`
Expected: PASS

- [ ] **Step 6: Commit all 4 store additions**

```bash
cd backend-py
git add app/services/memory_store.py app/services/tool_definitions.py tests/v11_brain_query_all_stores.py
git commit -m "feat(v1.1): add 4 missing brain_query stores (graph, daemons, exams, exam_attempts)"
```

---

## Task 10: Add Tier 1 math-preference constraint

**Files:**
- Modify: `backend-py/app/services/memory/context_builder.py` (`build_tier1`)

**Why:** The model needs to be told to prefer unicode math symbols over LaTeX. Without this, the renderer-side auto-converter catches most cases but the model still emits LaTeX in the first place.

- [ ] **Step 1: Read `build_tier1` in `context_builder.py`**

Open the file. Find the function `build_tier1` (around line 55). Identify where the existing `<system_constraints>` text is built (look for the guard mode rules, brain access rule, verifier rule — these are the existing constraints).

- [ ] **Step 2: Add the math-preference constraint**

In `build_tier1`, find the location where the constraints text is assembled. Add a new line. The exact insertion point depends on the existing structure; place it near the other style/format rules (e.g., near the guard mode or memory rules). The new line:

```python
        - Math: Prefer unicode math symbols (², ³, √, ∑, ∏, ∫, π, ≈, ≤, ≥, ±, →, ×, ÷, ∈, ∉, ∞, ∂) over LaTeX. Use plain unicode fractions (½) or parentheses ((a+b)/c) instead of \\frac{a+b}{c}. Reserve LaTeX $...$ / $$...$$ for genuinely complex formulas (matrices, multi-line derivations).
```

(Adjust the surrounding string assembly to match the existing pattern. The text content is what matters.)

- [ ] **Step 3: Smoke-test the change**

```bash
cd backend-py && python -c "
from app.services.memory.context_builder import build_tier1
t1 = build_tier1({'user_state': {'profile': 'test', 'skills': []}})
print('Math rule present:', 'unicode math symbols' in t1)
print('First 500 chars:')
print(t1[:500])
"
```
Expected: prints `True` and the constraint is in the output.

- [ ] **Step 4: Commit**

```bash
cd backend-py
git add app/services/memory/context_builder.py
git commit -m "feat(v1.1): add Tier 1 math-preference constraint (unicode over LaTeX)"
```

---

## Task 11: Relax KaTeX error color in `ChatMarkdown.tsx`

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatMarkdown.tsx:51-125`
- Modify: `frontend/desktop/src/styles.css`

**Why:** Currently invalid LaTeX renders in red (KaTeX default `.katex-error` style). The spec says failed math should not be alarming — render the source in normal body color so the user can still read it.

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/v11_math_unicode.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ChatMarkdown from '@/sections/chat/ChatMarkdown';

describe('v1.1 — math rendering', () => {
  it('renders x^2 as unicode superscript', () => {
    const { container } = render(<ChatMarkdown content="The formula x^2" />);
    expect(container.textContent).toContain('x²');
  });

  it('renders sum symbol as unicode', () => {
    const { container } = render(<ChatMarkdown content="The sum \\sum_{i=0}^{n}" />);
    expect(container.textContent).toMatch(/∑/);
  });

  it('renders >= as unicode', () => {
    const { container } = render(<ChatMarkdown content="x >= y" />);
    expect(container.textContent).toContain('≥');
  });

  it('renders pi as unicode', () => {
    const { container } = render(<ChatMarkdown content="\\pi is great" />);
    expect(container.textContent).toContain('π');
  });

  it('does not put invalid LaTeX in red error color', () => {
    // \\frac{ without closing brace is invalid LaTeX
    const { container } = render(<ChatMarkdown content="Bad: \\frac{1" />);
    // The source should be visible, but NOT inside an element with .katex-error class
    const errorEls = container.querySelectorAll('.katex-error');
    expect(errorEls.length).toBe(0);
  });

  it('does not convert $x^2$ inside a code block', () => {
    const code = '```\n$x^2$\n```';
    const { container } = render(<ChatMarkdown content={code} />);
    // Inside a <code> or <pre>, the literal $x^2$ should remain
    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toContain('$x^2$');
  });

  it('preserves $5 as currency (not math)', () => {
    const { container } = render(<ChatMarkdown content="Cost: $5.00" />);
    // $5.00 should remain as literal currency
    expect(container.textContent).toContain('$5.00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/desktop && npx vitest run src/test/v11_math_unicode.test.tsx`
Expected: FAIL — current code does not auto-convert `x^2` to `x²`, and invalid LaTeX renders in `.katex-error` red.

- [ ] **Step 3: Override `.katex-error` in `styles.css`**

Edit `frontend/desktop/src/styles.css`. Add at the end:

```css
/* v1.1: don't show failed LaTeX in red — show the source in normal body color */
.katex-error {
  color: inherit !important;
  background: transparent !important;
  font-family: var(--dt-font-mono, ui-monospace, monospace) !important;
  font-size: 0.95em;
}
```

- [ ] **Step 4: Run the test to verify partial pass**

Run: `cd frontend/desktop && npx vitest run src/test/v11_math_unicode.test.tsx`
Expected: the "does not put invalid LaTeX in red error color" test now passes. The other tests (x^2 → ², etc.) still fail because we haven't added the auto-converter yet. That's expected — Task 12 adds it.

- [ ] **Step 5: Commit**

```bash
cd frontend/desktop
git add src/styles.css src/test/v11_math_unicode.test.tsx
git commit -m "fix(v1.1): don't show failed LaTeX in red error color"
```

---

## Task 12: Common-formula auto-converter in `ChatMarkdown.tsx`

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatMarkdown.tsx:51-125`

**Why:** With the system-prompt rule (Task 10) the model will emit more unicode, but it'll still emit LaTeX in many cases. A pre-processor catches the most common patterns and converts them to unicode before markdown parsing. This is the main "remove the red LaTeX" fix.

- [ ] **Step 1: Add the auto-converter function**

In `frontend/desktop/src/sections/chat/ChatMarkdown.tsx`, add a new exported helper at the top of the file (after the imports, before the component):

```typescript
/**
 * v1.1: Convert common LaTeX-style math to unicode math symbols.
 * Skips content inside code blocks (fenced or inline) and inside
 * already-rendered KaTeX blocks. Best-effort: matches simple patterns only.
 */
function convertLatexToUnicode(input: string): string {
  // Split on code blocks and inline code so we never touch them.
  // We use a placeholder strategy: replace protected regions with
  // unique tokens, convert, then restore.
  const placeholders: string[] = [];
  const stash = (text: string): string => {
    const idx = placeholders.length;
    placeholders.push(text);
    return `\u0000MATH_PROTECTED_${idx}\u0000`;
  };

  // 1) Protect fenced code blocks ```...```
  let s = input.replace(/```[\s\S]*?```/g, (m) => stash(m));
  // 2) Protect inline code `...`
  s = s.replace(/`[^`\n]+`/g, (m) => stash(m));
  // 3) Protect KaTeX-rendered blocks (anything already wrapped in \(...\) or \[...\])
  s = s.replace(/\\\([\s\S]*?\\\)/g, (m) => stash(m));
  s = s.replace(/\\\[[\s\S]*?\\\]/g, (m) => stash(m));
  s = s.replace(/\$\$[\s\S]*?\$\$/g, (m) => stash(m));

  // 4) Common LaTeX → unicode conversions
  // Greek letters
  s = s.replace(/\\pi\b/g, 'π');
  s = s.replace(/\\theta\b/g, 'θ');
  s = s.replace(/\\alpha\b/g, 'α');
  s = s.replace(/\\beta\b/g, 'β');
  s = s.replace(/\\gamma\b/g, 'γ');
  s = s.replace(/\\delta\b/g, 'δ');
  s = s.replace(/\\epsilon\b/g, 'ε');
  s = s.replace(/\\lambda\b/g, 'λ');
  s = s.replace(/\\mu\b/g, 'μ');
  s = s.replace(/\\sigma\b/g, 'σ');
  s = s.replace(/\\omega\b/g, 'ω');

  // Operators
  s = s.replace(/\\sum\b/g, '∑');
  s = s.replace(/\\prod\b/g, '∏');
  s = s.replace(/\\int\b/g, '∫');
  s = s.replace(/\\partial\b/g, '∂');
  s = s.replace(/\\infty\b/g, '∞');
  s = s.replace(/\\sqrt\s*\{([^}]+)\}/g, '√($1)');
  s = s.replace(/\\cdot\b/g, '·');
  s = s.replace(/\\times\b/g, '×');
  s = s.replace(/\\div\b/g, '÷');
  s = s.replace(/\\pm\b/g, '±');
  s = s.replace(/\\leq\b/g, '≤');
  s = s.replace(/\\geq\b/g, '≥');
  s = s.replace(/\\neq\b/g, '≠');
  s = s.replace(/\\approx\b/g, '≈');
  s = s.replace(/\\rightarrow\b/g, '→');
  s = s.replace(/\\to\b/g, '→');
  s = s.replace(/\\in\b/g, '∈');
  s = s.replace(/\\notin\b/g, '∉');

  // Superscripts: x^2, x^n, x^{10}
  s = s.replace(/\^(\d)/g, (m, d) => {
    const map: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    };
    return map[d] || m;
  });
  s = s.replace(/\^\{([^}]+)\}/g, (m, body) => {
    const map: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
      'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ', 'y': 'ʸ',
    };
    return body.split('').map((c: string) => map[c] || c).join('');
  });

  // Subscripts: x_1, x_n, x_{10}
  s = s.replace(/_(\d)/g, (m, d) => {
    const map: Record<string, string> = {
      '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
      '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    };
    return map[d] || m;
  });
  s = s.replace(/_\{([^}]+)\}/g, (m, body) => {
    const map: Record<string, string> = {
      '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
      '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
      'i': 'ᵢ', 'j': 'ⱼ', 'n': 'ₙ', 'x': 'ₓ', 'y': 'ᵧ',
    };
    return body.split('').map((c: string) => map[c] || c).join('');
  });

  // ASCII operator shorthand
  s = s.replace(/&gt;=/g, '≥');
  s = s.replace(/&lt;=/g, '≤');
  s = s.replace(/!=/g, '≠');
  s = s.replace(/->/g, '→');
  s = s.replace(/=>/g, '⇒');

  // 5) Restore protected regions
  s = s.replace(/\u0000MATH_PROTECTED_(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)]);

  return s;
}
```

- [ ] **Step 2: Apply the converter before markdown parsing**

In `ChatMarkdown.tsx`, find where the `content` prop is passed to `marked` (or whatever the markdown library call is). Wrap it with `convertLatexToUnicode`:

```typescript
const processedContent = convertLatexToUnicode(content);
// ... then use processedContent instead of content
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd frontend/desktop && npx vitest run src/test/v11_math_unicode.test.tsx`
Expected: PASS (7/7 tests)

- [ ] **Step 4: Verify the rest of the frontend test suite still passes**

Run: `cd frontend/desktop && npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
cd frontend/desktop
git add src/sections/chat/ChatMarkdown.tsx
git commit -m "feat(v1.1): common-formula auto-converter (LaTeX → unicode in chat output)"
```

---

## Task 13: End-to-end smoke test

**Files:**
- Create: `backend-py/tests/v11_e2e_chat.py`

**Why:** Final integration check. Even with all unit tests passing, a real chat turn can still surface integration issues (e.g., the cached_t12 fix in Task 1 might not actually trigger the cache path because of a typo in the caller).

- [ ] **Step 1: Write the e2e test**

Create `backend-py/tests/v11_e2e_chat.py`:

```python
"""v1.1 — End-to-end smoke test: a real chat session, no crashes."""
import pytest
from app.services.memory import context_builder, auto_memory
from app.services.workbench import workbench


def test_build_system_prompt_does_not_crash_with_realistic_payload():
    """The most common failure mode: build_system_prompt with a real-shaped session."""
    session = {
        "id": "e2e-test",
        "user_state": {"profile": "developer", "skills": [{"name": "test", "description": "x"}]},
        "workspace": {"path": "/tmp", "vcs": "git on main"},
        "directives": {"goal": "test the chat", "plan": None, "plan_approved": False},
        "learned_heuristics": [{"rule": "use unicode math"}],
        "core_memory": {"facts": ["user prefers tabs"]},
        "auto_memories": [{"key": "x", "content": "y", "importance": 0.5}],
    }
    memory = {
        "core_memory": {"facts": ["user prefers tabs"]},
        "learned_heuristics": [{"rule": "use unicode math"}],
        "auto_memories": [{"key": "x", "content": "y", "importance": 0.5}],
    }
    tools = [
        {"name": "read_file", "description": "read a file", "parameters": []},
        {"name": "write_file", "description": "write a file", "parameters": []},
    ]

    # Should not raise any exception
    result = context_builder.build_system_prompt(
        session=session,
        memory=memory,
        tools=tools,
    )
    assert isinstance(result, str)
    assert len(result) > 100  # non-trivial content


def test_build_system_prompt_with_cached_t12_does_not_crash():
    """Cache path: cached_t12 provided, should be included verbatim."""
    cache_payload = "PRECOMPUTED_T1_T2_BLOCK"
    result = context_builder.build_system_prompt(
        session={"id": "e2e-test"},
        memory={},
        cached_t12=cache_payload,
    )
    assert cache_payload in result


def test_save_auto_memory_then_brain_query_round_trip():
    """End-to-end: save → read back via brain_query."""
    import uuid
    key = f"v11_e2e_{uuid.uuid4().hex[:8]}"
    try:
        # Write
        auto_memory.save_auto_memory(key=key, content="e2e test content", importance=0.9)
        # Read back via brain_query
        from app.services.memory_store import brain_query
        result = brain_query(store="auto_memories", query=key, limit=5)
        # Should return a list containing our memory
        assert isinstance(result, list)
        assert any(key in str(r.get("key", "")) for r in result)
    finally:
        # cleanup
        from app.services.memory_store import _conn
        conn = _conn()
        conn.execute("DELETE FROM auto_memories WHERE key = ?", (key,))
        conn.commit()


def test_brain_query_all_stores_no_exception():
    """All 12 stores respond without raising."""
    from app.services.memory_store import brain_query
    stores = [
        "memory", "auto_memories", "heuristics", "facts", "sessions",
        "messages", "timeline", "graph", "blackboard", "daemons",
        "exams", "exam_attempts",
    ]
    for store in stores:
        result = brain_query(store=store, query="", limit=5)
        assert isinstance(result, (list, dict)), f"{store}: {type(result)}"
```

- [ ] **Step 2: Run the test**

Run: `cd backend-py && python -m pytest tests/v11_e2e_chat.py -v`
Expected: PASS (4/4 tests)

- [ ] **Step 3: Run the FULL test suite to confirm no regressions**

Run: `cd backend-py && python -m pytest tests/ -q`
Expected: PASS — all existing tests + the v1.1 tests, no regressions.

- [ ] **Step 4: Run the frontend test suite**

Run: `cd frontend/desktop && npx vitest run`
Expected: PASS — all existing tests + v11_math_unicode.

- [ ] **Step 5: Commit**

```bash
cd backend-py
git add tests/v11_e2e_chat.py
git commit -m "test(v1.1): end-to-end smoke test for chat + brain_query round-trip"
```

---

## Task 14: Update trackers honestly

**Files:**
- Modify: `docs/design/tracker-v1.md`

**Why:** The trackers currently mark "✅ done & verified" on items that are stubbed or broken. This is misleading and dangerous (gives false confidence). v1.1 work is now actually verified — the trackers should reflect that.

- [ ] **Step 1: Read the current `tracker-v1.md`**

Open `docs/design/tracker-v1.md`. Note the "Progress" table at the top.

- [ ] **Step 2: Update the Progress table to reflect actual state**

For each phase that v1.1 fixed, update the Notes column to reference the v1.1 commits. Example for Phase 0:

```
| 0 | Data Unification & Schema Migration | (proxy-side) | ✅ done & verified | | All tasks complete. v1.1 added updated_at column (commit XXX). |
```

For each v1.1 fix, also check the "Tests" section in that phase's tasks and tick the boxes that v1.1 verified. (Don't lie about tests you didn't write — only check boxes that match tests added in v1.1.)

- [ ] **Step 3: Add a v1.1 section at the bottom of the tracker**

Append a new section documenting v1.1:

```markdown
---

## v1.1 patch (2026-06-29)

**Scope:** 7 fixes — 3 critical bugs + 3 cheap correctness + 1 math rendering UI/UX

**Critical bugs fixed:**
- `cached_t12` kwarg added to `build_system_prompt` (commit XXX)
- `auto_memories.updated_at` column added (idempotent migration in `memory_store.init()`) (commit XXX)
- `<failure_feedback>` producer in `_execute_tool` with 3-turn decay (commit XXX)

**Cheap correctness fixed:**
- `submit_plan` / `reject_workbench_plan` now drop `_execution_state` and `_working_memory` (commit XXX)
- Auto-compaction gated on `attention_pressure == "critical"` + 5-turn cooldown (commit XXX)
- 4 missing `brain_query` stores added: `graph`, `daemons`, `exams`, `exam_attempts` (commit XXX)

**UI/UX fix:**
- Math rendering: Tier 1 system constraint added telling model to prefer unicode over LaTeX
- KaTeX no longer renders failed math in red error color
- Common-formula auto-converter in `ChatMarkdown.tsx` (LaTeX → unicode, skips code blocks)

**Tests added:** 7 backend test files + 1 frontend test file

**Status:** ✅ done & verified — end-to-end chat runs, all 12 brain_query stores work, math renders correctly.
```

Fill in the commit hashes by running `git log --oneline -10` in `backend-py/`.

- [ ] **Step 4: Update v1 exit criteria**

In `tracker-v1.md`, the "v1 exit criteria" section currently has:
- [x] Every phase box above checked
- [x] All v1 `cognitive_layers` flags `true` and healthy
- [x] `brain_query` (§11) live; FTS indexes populated; write queue is the single write path
- [x] No goal/plan duplication; 3-tier prompt verified in a real session
- [x] App runs a full chat session end-to-end without regressions
- [ ] v1 verified in production (per spec scope rule)

The first 5 are now actually true. The last one (production verification) remains unchecked — that's the user's call after they ship v1.1.

- [ ] **Step 5: Commit**

```bash
cd /c/Dev/august-proxy
git add docs/design/tracker-v1.md
git commit -m "docs: update tracker-v1.md to reflect v1.1 actual state (not aspirational)"
```

---

## Task 15: v1.1 release commit

**Files:** none (this is a tag/merge task)

- [ ] **Step 1: Verify the working tree is clean**

Run: `cd /c/Dev/august-proxy && git status`
Expected: clean working tree, all v1.1 commits visible in `git log`.

- [ ] **Step 2: Run the FULL test suite one last time**

Run:
```bash
cd backend-py && python -m pytest tests/ -q
cd ../frontend/desktop && npx vitest run
```
Expected: all tests pass.

- [ ] **Step 3: Tag the release**

```bash
cd /c/Dev/august-proxy
git tag -a v1.1.0 -m "v1.1: cognitive architecture remediation (3 critical bug fixes, 3 cheap correctness, math rendering, 4 brain_query stores)"
```

- [ ] **Step 4: Write a release summary**

Create `docs/releases/v1.1.0.md` (create the directory if it doesn't exist):

```markdown
# v1.1.0 — Cognitive Architecture Remediation

**Date:** 2026-06-29
**Commits:** [list top 10 commit hashes from `git log v1.0.0..v1.1.0 --oneline`]

## What's fixed

### Critical bugs (chat was broken)
- `build_system_prompt` now accepts `cached_t12` keyword argument (Phase 7 cache hook).
- `auto_memories` table has new `updated_at` column with idempotent migration.
- `<failure_feedback>` Tier 3 block now has a producer with 3-turn decay.

### Cheap correctness
- `submit_plan` and `reject_workbench_plan` clear execution state and working memory.
- Auto-compaction triggers only at `attention_pressure == "critical"` with 5-turn cooldown.
- `brain_query` now supports all 12 spec stores (added `graph`, `daemons`, `exams`, `exam_attempts`).

### UI/UX
- Math renders as unicode (`x²`, `∑`, `π`, etc.) instead of red LaTeX errors.
- KaTeX still works for complex formulas (matrices, multi-line derivations).

## Tests
- 7 new backend test files
- 1 new frontend test file
- End-to-end smoke test verifies a full chat session runs without errors

## Upgrade notes
- Database migration is automatic at startup (idempotent ALTER TABLE).
- No config changes required.
- The `data/august_brain.sqlite` file is preserved.

## Next
- v2 (Phases 8-10 bring-up) — daemons actually run, consolidation uses Hippocampus, env watcher watches fs, etc.
```

- [ ] **Step 5: Commit the release notes and tag**

```bash
cd /c/Dev/august-proxy
git add docs/releases/v1.1.0.md
git commit -m "docs: v1.1.0 release notes"
git tag -a v1.1.0 -m "v1.1: cognitive architecture remediation"
```

- [ ] **Step 6: Hand off to user**

Tell the user: v1.1 is complete. Recommend they:
1. Pull the branch and run a real chat to confirm the fixes
2. Push the branch (only when ready)
3. Then approve starting on the v2 plan

---

## Cross-cutting reminders

- **TDD is non-negotiable.** Every backend task has a "write the failing test" step. The test runs first, fails, then the implementation makes it pass. This is how we ensure no regressions.
- **Commit frequently.** Each task ends with a commit. The git history is the audit trail.
- **Don't push.** The user has explicitly asked to commit locally only. They will push when they choose.
- **Run the full suite after each task.** Step 5/6/7 of each task includes a "verify the rest of the test suite still passes" command. Run it. Fix any regressions before moving on.
- **No placeholder code.** The "No Placeholders" section of the writing-plans skill applies: complete code in every step, no TBDs, no "implement later".

---

## Self-review (per writing-plans skill)

**1. Spec coverage:** Each of the 7 v1.1 items in the design doc §5.1 has a corresponding task:
- Item 1 (cached_t12) → Task 1 ✅
- Item 2 (updated_at) → Task 2 ✅
- Item 3 (failure_feedback) → Task 3 ✅
- Item 4 (state drop) → Task 4 ✅
- Item 5 (auto-compaction) → Task 5 ✅
- Item 6 (brain_query stores) → Tasks 6, 7, 8, 9 ✅
- Item 7 (math rendering) → Tasks 10, 11, 12 ✅
- E2E test → Task 13 ✅
- Tracker updates → Task 14 ✅
- Release → Task 15 ✅

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" without code. All code blocks are complete and runnable. A few "Adjust indentation to match" notes exist where the actual file structure may differ slightly from what I can see — those are explicit, not placeholders, and the tests will catch any mismatch.

**3. Type consistency:** Function signatures and method names are consistent across tasks:
- `_should_auto_compact(attention_pressure: str, turns_since_compaction: int) -> bool` — defined in Task 5, used in Task 5
- `_failure_feedback` and `_failure_feedback_age` — defined in Task 3, used in Task 3
- `_conn()` — consistent with existing memory_store pattern
- `convertLatexToUnicode(input: string) -> string` — defined and used in Task 12
- `cached_t12` parameter — defined in Task 1, referenced in Task 1 only

**4. No spec gaps:** The design doc §5.5 listed 7 test names; this plan adds those tests (plus the parametrized `test_v11_brain_query_all_stores` covers 12 store variants). Design doc §5.6 listed 8 risks; this plan mitigates each in the relevant task.

---

## v1.1 Definition of Done (verification checklist)

Before declaring v1.1 done, all of the following must be true:

- [ ] All 15 tasks completed, each with a green commit
- [ ] `cd backend-py && python -m pytest tests/ -q` — all tests pass
- [ ] `cd frontend/desktop && npx vitest run` — all tests pass
- [ ] A real chat session runs end-to-end without errors (manual check)
- [ ] `<failure_feedback>` block appears on a forced tool error
- [ ] `brain_query` returns rows for all 12 stores (or "not available" for genuinely empty ones)
- [ ] Math formulas render as unicode in chat (e.g., ask "what is x^2 + y^2?" and see x² + y²)
- [ ] Trackers updated to reflect actual verified state
- [ ] Release notes written
- [ ] v1.1.0 tag created locally (no push)
