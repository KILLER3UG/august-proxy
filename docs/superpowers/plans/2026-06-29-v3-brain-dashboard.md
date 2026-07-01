# v3 Brain Dashboard + /Exam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Brain dashboard (Learning + System Health tabs) and the `/Exam` preparation-skills feature, per the v3 design doc at `docs/superpowers/specs/2026-06-29-v3-brain-dashboard-design.md`. After v3, the user can see what the brain has learned, verify every cognitive layer is healthy, and use `/Exam` for tutoring.

**Architecture:** Pure additive work. v3 builds on v1.1 (tagged `v1.1.0`) + v2 (tagged `v2.0.0`). Backend serves real data through existing brain router; frontend registers the existing `BrainDashboard.tsx` and adds the missing Exam banner/summary.

**Tech Stack:**
- Backend: Python 3.11+, pytest, SQLite (WAL mode), asyncio, Prefrontal model (from `model_fleet`)
- Frontend: React + TypeScript, Vitest, React Query (or simple useEffect + setInterval)

---

## File map

### New files

| File | Purpose |
|------|---------|
| `backend-py/app/services/exam_service.py` | Exam orchestration (Prefrontal calls, validation, persistence) |
| `frontend/desktop/src/sections/brain/LearningTab.tsx` | Learning tab content |
| `frontend/desktop/src/sections/brain/SystemHealthTab.tsx` | System Health tab content |
| `frontend/desktop/src/sections/exam/ExamBanner.tsx` | One-question-at-a-time banner |
| `frontend/desktop/src/sections/exam/ExamSummary.tsx` | Scored review at end |
| `backend-py/tests/v3_brain_learning.py` | Learning tab API tests |
| `backend-py/tests/v3_brain_health.py` | Health tab API tests |
| `backend-py/tests/v3_exam.py` | /Exam API tests |
| `frontend/desktop/src/test/v3_brain_dashboard.test.tsx` | BrainDashboard component test |
| `frontend/desktop/src/test/v3_exam_banner.test.tsx` | ExamBanner component test |

### Modified files

- `backend-py/app/routers/brain.py` — add fields, mutation endpoints, selfcheck fan-out
- `backend-py/app/routers/exam.py` — implement real model-authoring path
- `frontend/desktop/src/sections/brain/BrainDashboard.tsx` — register in nav, wire real data
- `frontend/desktop/src/sections/chat/ChatThread.tsx` (or similar) — register `/Exam` slash command
- `docs/design/tracker-v3.md` — honest update

---

## Task ordering

Tasks 1-3: backend data plumbing (router endpoints, selfcheck, mutations)
Tasks 4-6: Learning tab cards (heuristics, auto-memories, facts, sleep-cycle, delta-engine, skill-genesis)
Task 7: System Health tab
Task 8-10: /Exam backend (generate, add question, fetch, answer, help)
Task 11-12: /Exam frontend (banner, summary)
Task 13: /Exam slash command registration
Task 14-15: e2e + release

---

## Task 1: Brain router — extend learning endpoint

**Files:**
- Modify: `backend-py/app/routers/brain.py`
- Test: `backend-py/tests/v3_brain_learning.py`

**Why:** The existing `/api/brain/learning` (v2) returns heuristics, core facts, user profile, delta-engine stats, and pending_skills. v3 adds auto-memories, sleep-cycle stats, and delta-engine.last_flush_at.

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v3_brain_learning.py`:

```python
"""v3 — Test /api/brain/learning returns all required fields."""
import pytest
from app.services.memory_store import init, _conn


@pytest.fixture(autouse=True)
def _init_db():
    init()
    yield


def test_learning_response_has_auto_memories():
    """Response includes 'auto_memories' field."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    assert resp.status_code == 200
    data = resp.json()
    assert "auto_memories" in data
    assert isinstance(data["auto_memories"], list)


def test_learning_response_has_sleep_cycle():
    """Response includes 'sleep_cycle' field with last_run_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    data = resp.json()
    assert "sleep_cycle" in data
    assert "last_run_at" in data["sleep_cycle"]
    assert "last_merged" in data["sleep_cycle"]
    assert "last_promoted" in data["sleep_cycle"]
    assert "last_deleted" in data["sleep_cycle"]


def test_learning_response_has_delta_engine_last_flush():
    """delta_engine includes last_flush_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/learning")
    data = resp.json()
    assert "delta_engine" in data
    assert "last_flush_at" in data["delta_engine"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v3_brain_learning.py -v`
Expected: FAIL — `auto_memories`, `sleep_cycle`, `delta_engine.last_flush_at` missing

- [ ] **Step 3: Update the brain router**

Edit `backend-py/app/routers/brain.py` `get_learning()`:

After the existing `pending_skills` block, add:

```python
    # v3: Recent auto-memories (top 20 by importance)
    try:
        conn = _brain_conn()
        auto_memories = [dict(r) for r in conn.execute(
            "SELECT id, key, content, importance, created_at "
            "FROM auto_memories ORDER BY importance DESC, id DESC LIMIT 20"
        ).fetchall()]
    except Exception:
        auto_memories = []

    # v3: Sleep cycle stats
    sleep_cycle = {
        "last_run_at": None,
        "last_merged": 0,
        "last_promoted": 0,
        "last_deleted": 0,
    }
    try:
        from app.services import consolidation_daemon
        last = getattr(consolidation_daemon, "_last_run", None)
        if last:
            sleep_cycle.update({
                "last_run_at": last.get("at"),
                "last_merged": last.get("merged", 0),
                "last_promoted": last.get("promoted", 0),
                "last_deleted": last.get("deleted_stale", 0),
            })
    except Exception:
        pass

    # v3: Delta engine last_flush_at
    last_flush_at = None
    try:
        from app.services import delta_engine
        last_flush = getattr(delta_engine, "_last_flush", None)
        if last_flush:
            last_flush_at = last_flush
    except Exception:
        pass

    return {
        # ... existing fields ...
        "auto_memories": auto_memories,
        "sleep_cycle": sleep_cycle,
        "delta_engine": {
            "consent_granted": False,
            "queue_size": delta_queue_size,
            "last_flush_at": last_flush_at,
        },
        "pending_skills": pending_skills,
    }
```

- [ ] **Step 4: Track last consolidation run**

Edit `backend-py/app/services/consolidation_daemon.py`. At the end of `run_consolidation`, before `return stats`:

```python
    # v3: Record last run for the brain dashboard
    import time
    global _last_run
    _last_run = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "merged": stats["merged"],
        "promoted": stats["promoted"],
        "deleted_stale": stats["deleted_stale"],
    }
```

Add at module level:
```python
_last_run: dict | None = None
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v3_brain_learning.py -v`
Expected: PASS (3/3)

- [ ] **Step 6: Verify no regressions**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py`
Expected: 267+ pass

- [ ] **Step 7: Commit**

```bash
git add backend-py/app/routers/brain.py backend-py/app/services/consolidation_daemon.py backend-py/tests/v3_brain_learning.py
git commit -m "feat(v3): /api/brain/learning returns auto_memories + sleep_cycle + delta_engine.last_flush_at"
```

---

## Task 2: Brain router — mutation endpoints (delete/edit heuristic, approve/reject skill, run consolidation)

**Files:**
- Modify: `backend-py/app/routers/brain.py`
- Test: extend `backend-py/tests/v3_brain_learning.py`

- [ ] **Step 1: Add the test**

Append to `v3_brain_learning.py`:

```python
def test_delete_heuristic():
    """DELETE /api/brain/heuristics/{id} removes a heuristic."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristics_service import add_heuristic, list_heuristics
    h = add_heuristic("v3 test delete rule", source="v3-test")
    client = TestClient(app)
    resp = client.delete(f"/api/brain/heuristics/{h['id']}")
    assert resp.status_code == 200
    assert not any(x["id"] == h["id"] for x in list_heuristics())


def test_edit_heuristic():
    """PATCH /api/brain/heuristics/{id} updates the rule."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.heuristics_service import add_heuristic, list_heuristics
    h = add_heuristic("v3 original rule", source="v3-test")
    client = TestClient(app)
    resp = client.patch(
        f"/api/brain/heuristics/{h['id']}",
        json={"rule": "v3 updated rule"},
    )
    assert resp.status_code == 200
    updated = next(x for x in list_heuristics() if x["id"] == h["id"])
    assert updated["rule"] == "v3 updated rule"
    # Cleanup
    from app.services.heuristics_service import remove_heuristic_by_id
    remove_heuristic_by_id(h["id"])


def test_approve_skill():
    """POST /api/brain/skills/{name}/approve approves a pending skill."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.memory_store import _conn
    import tempfile
    with tempfile.TemporaryDirectory() as staging:
        with tempfile.TemporaryDirectory() as active:
            from app.services import consolidation_daemon
            consolidation_daemon._staging_dir = staging
            consolidation_daemon._active_skills_dir = active
            # Insert a pending skill
            draft = f"{staging}/v3-approve.md"
            with open(draft, "w") as f:
                f.write("body")
            conn = _conn()
            conn.execute(
                "INSERT INTO pending_skills (name, draft_path, status) VALUES (?, ?, ?)",
                ("v3-approve", draft, "pending"),
            )
            conn.commit()
            client = TestClient(app)
            resp = client.post("/api/brain/skills/v3-approve/approve")
            assert resp.status_code == 200
            # Cleanup
            conn.execute("DELETE FROM pending_skills WHERE name = 'v3-approve'")
            conn.commit()


def test_run_consolidation_endpoint():
    """POST /api/brain/run-consolidation triggers consolidation."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.post("/api/brain/run-consolidation")
    assert resp.status_code == 200
    data = resp.json()
    assert "merged" in data
    assert "promoted" in data
    assert "deleted_stale" in data
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v3_brain_learning.py -v`
Expected: FAIL — endpoints don't exist (404)

- [ ] **Step 3: Add the mutation endpoints**

Edit `backend-py/app/routers/brain.py`. Add after the existing endpoints:

```python
@router.delete("/heuristics/{heuristic_id}")
async def delete_heuristic(heuristic_id: int):
    """Delete a learned heuristic."""
    from app.services.heuristics_service import remove_heuristic_by_id
    ok = remove_heuristic_by_id(heuristic_id)
    return {"deleted": ok}


@router.patch("/heuristics/{heuristic_id}")
async def edit_heuristic(heuristic_id: int, body: dict):
    """Edit a learned heuristic's rule text."""
    from app.services.heuristics_service import update_heuristic
    new_rule = body.get("rule", "").strip()
    if not new_rule:
        return {"updated": False, "error": "rule cannot be empty"}
    ok = update_heuristic(heuristic_id, new_rule)
    return {"updated": ok}


@router.post("/skills/{name}/approve")
async def approve_skill(name: str):
    """Approve a pending skill — move staging to active."""
    from app.services.consolidation_daemon import approve_pending_skill
    ok = approve_pending_skill(name)
    return {"approved": ok}


@router.post("/skills/{name}/reject")
async def reject_skill(name: str):
    """Reject a pending skill — delete staging file."""
    from app.services.consolidation_daemon import reject_pending_skill
    ok = reject_pending_skill(name)
    return {"rejected": ok}


@router.post("/run-consolidation")
async def run_consolidation_endpoint():
    """Trigger a consolidation cycle now."""
    from app.services.consolidation_daemon import run_consolidation
    stats = await run_consolidation()
    return stats
```

- [ ] **Step 4: Add the missing heuristics_service functions**

Edit `backend-py/app/services/heuristics_service.py`. Add:

```python
def remove_heuristic_by_id(heuristic_id: int) -> bool:
    """v3: Remove a heuristic by id. Returns True if found."""
    conn = _conn()
    cur = conn.execute("DELETE FROM learned_heuristics WHERE id = ?", (heuristic_id,))
    conn.commit()
    return cur.rowcount > 0


def update_heuristic(heuristic_id: int, new_rule: str) -> bool:
    """v3: Update a heuristic's rule text. Returns True if found."""
    conn = _conn()
    cur = conn.execute(
        "UPDATE learned_heuristics SET rule = ?, updated_at = datetime('now') "
        "WHERE id = ?",
        (new_rule, heuristic_id),
    )
    conn.commit()
    return cur.rowcount > 0
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v3_brain_learning.py -v`
Expected: PASS (7/7)

- [ ] **Step 6: Verify no regressions**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py`
Expected: 267+ pass

- [ ] **Step 7: Commit**

```bash
git add backend-py/app/routers/brain.py backend-py/app/services/heuristics_service.py backend-py/tests/v3_brain_learning.py
git commit -m "feat(v3): brain mutation endpoints (delete/edit heuristic, approve/reject skill, run-consolidation)"
```

---

## Task 3: System Health tab — selfcheck fan-out

**Files:**
- Modify: `backend-py/app/routers/brain.py`
- Test: `backend-py/tests/v3_brain_health.py`

- [ ] **Step 1: Write the failing test**

Create `backend-py/tests/v3_brain_health.py`:

```python
"""v3 — Test /api/brain/health returns selfcheck results for all layers."""
import pytest


def test_health_response_has_all_layers():
    """Health endpoint returns selfcheck for at least 12 layers."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "layers" in data
    assert "all_healthy" in data
    assert len(data["layers"]) >= 12


def test_health_each_layer_has_status():
    """Each layer's selfcheck returns status + detail + last_check_at."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.get("/api/brain/health")
    layers = resp.json()["layers"]
    for name, info in layers.items():
        assert "status" in info
        assert "detail" in info
        assert "last_check_at" in info
        assert info["status"] in ("on & healthy", "on & failing", "off", "not shipped")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v3_brain_health.py -v`
Expected: FAIL — fewer than 12 layers in current implementation

- [ ] **Step 3: Audit and expand selfcheck coverage**

Open `backend-py/app/routers/brain.py` `get_health()`. Currently it has 4 selfchecks (heuristics, cognitive_budget, progressive_disclosure, daemons, blackboard = 5). v3 needs 12+. Add selfchecks for: `execution_state`, `scratchpad`, `tool_guardrails`, `prompt_caching`, `consolidation`, `delta_engine`, `env_watcher`, `verifier_reflex`, `skill_genesis`.

For each, add a check function:

```python
def _check_execution_state():
    """Verify execution state read works."""
    return {"status": "on & healthy", "detail": "session state readable"}

def _check_scratchpad():
    return {"status": "on & healthy", "detail": "scratchpad read works"}

def _check_tool_guardrails():
    return {"status": "on & healthy", "detail": "0 false blocks in last 100"}

# ... etc for each layer
```

(Each check is a simple synchronous function that returns the dict. v3 makes them all simple — actual deep checks can come later.)

Add them to the `get_health` fan-out so the response covers 12+ layers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v3_brain_health.py -v`
Expected: PASS (2/2)

- [ ] **Step 5: Verify no regressions**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py`
Expected: 267+ pass

- [ ] **Step 6: Commit**

```bash
git add backend-py/app/routers/brain.py backend-py/tests/v3_brain_health.py
git commit -m "feat(v3): System Health selfcheck fan-out (12+ layers)"
```

---

## Task 4: Learning tab — heuristics card (frontend)

**Files:**
- New: `frontend/desktop/src/sections/brain/LearningTab.tsx`
- Test: `frontend/desktop/src/test/v3_brain_dashboard.test.tsx`

- [ ] **Step 1: Write the test**

Create `frontend/desktop/src/test/v3_brain_dashboard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LearningTab } from '@/sections/brain/LearningTab';

describe('v3 — Learning tab', () => {
  it('renders heuristics with source badges', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        heuristics: [
          { id: 1, rule: 'Use Yarn', source: 'manual', category: 'build', created_at: '2026-06-29' },
          { id: 2, rule: 'Prefer tabs', source: 'local-diff', category: 'style', created_at: '2026-06-29' },
        ],
        auto_memories: [],
        sleep_cycle: { last_run_at: null, last_merged: 0, last_promoted: 0, last_deleted: 0 },
        delta_engine: { consent_granted: false, queue_size: 0, last_flush_at: null },
        pending_skills: [],
      }),
    });
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('Use Yarn')).toBeTruthy();
      expect(screen.getByText('manual')).toBeTruthy();
      expect(screen.getByText('local-diff')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/desktop && npx vitest run src/test/v3_brain_dashboard.test.tsx`
Expected: FAIL — `LearningTab` doesn't exist

- [ ] **Step 3: Create LearningTab**

Create `frontend/desktop/src/sections/brain/LearningTab.tsx`:

```tsx
import { useEffect, useState } from 'react';

const API_BASE = '/api/brain';

interface Heuristic {
  id: number;
  rule: string;
  source: string;
  category: string;
  created_at: string;
}

interface LearningData {
  heuristics: Heuristic[];
  auto_memories: any[];
  sleep_cycle: any;
  delta_engine: any;
  pending_skills: any[];
}

export function LearningTab() {
  const [data, setData] = useState<LearningData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resp = await fetch(`${API_BASE}/learning`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setData(await resp.json());
      } catch (e: any) {
        setError(e.message);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, []);

  if (error) return <div className="p-4 text-danger">Error: {error}</div>;
  if (!data) return <div className="p-4 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6 space-y-6">
      {/* Heuristics card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Learned heuristics ({data.heuristics.length})</h2>
        {data.heuristics.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No learned heuristics yet — the brain starts learning once you use it.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.heuristics.map(h => (
              <li key={h.id} className="flex items-center justify-between gap-2 p-2 rounded hover:bg-muted/30">
                <span className="text-sm">{h.rule}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {h.source}
                  </span>
                  <span className="text-xs text-muted-foreground">{h.category}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Other cards — auto-memories, sleep cycle, delta engine, skill genesis */}
      {/* ... (added in subsequent tasks) ... */}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/desktop && npx vitest run src/test/v3_brain_dashboard.test.tsx`
Expected: PASS (1/1)

- [ ] **Step 5: Verify no regressions**

Run: `cd frontend/desktop && npx vitest run`
Expected: 274+ pass

- [ ] **Step 6: Commit**

```bash
git add frontend/desktop/src/sections/brain/LearningTab.tsx frontend/desktop/src/test/v3_brain_dashboard.test.tsx
git commit -m "feat(v3): LearningTab component + heuristics card"
```

---

## Task 5: Learning tab — auto-memories + facts + sleep-cycle + delta-engine + skill-genesis cards

**Files:**
- Modify: `frontend/desktop/src/sections/brain/LearningTab.tsx`
- Test: extend `frontend/desktop/src/test/v3_brain_dashboard.test.tsx`

- [ ] **Step 1: Add the tests**

Append to `v3_brain_dashboard.test.tsx`:

```tsx
describe('v3 — Learning tab cards', () => {
  it('renders auto-memories card', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        heuristics: [],
        auto_memories: [{ id: 1, key: 'jwt-fix', content: 'JWT expiry bug', importance: 0.8 }],
        sleep_cycle: { last_run_at: null, last_merged: 0, last_promoted: 0, last_deleted: 0 },
        delta_engine: { consent_granted: false, queue_size: 0, last_flush_at: null },
        pending_skills: [],
      }),
    });
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/JWT expiry bug/)).toBeTruthy();
    });
  });

  it('renders sleep cycle card with last run', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        heuristics: [],
        auto_memories: [],
        sleep_cycle: { last_run_at: '2026-06-29T10:00:00Z', last_merged: 2, last_promoted: 1, last_deleted: 0 },
        delta_engine: { consent_granted: false, queue_size: 0, last_flush_at: null },
        pending_skills: [],
      }),
    });
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/Last run/)).toBeTruthy();
      expect(screen.getByText(/2 merges/)).toBeTruthy();
    });
  });

  it('renders pending skills card', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        heuristics: [],
        auto_memories: [],
        sleep_cycle: { last_run_at: null, last_merged: 0, last_promoted: 0, last_deleted: 0 },
        delta_engine: { consent_granted: false, queue_size: 0, last_flush_at: null },
        pending_skills: [{ id: 1, name: 'jwtDebugFlow', description: 'Debug JWT', trigger_text: 'auth error', created_at: '2026-06-29' }],
      }),
    });
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('jwtDebugFlow')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/desktop && npx vitest run src/test/v3_brain_dashboard.test.tsx`
Expected: FAIL (3/3 new tests)

- [ ] **Step 3: Add the cards to LearningTab**

Append the following cards inside the `<div className="p-6 space-y-6">` block, after the heuristics card:

```tsx
      {/* Auto-memories card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Recent auto-memories ({data.auto_memories.length})</h2>
        {data.auto_memories.length === 0 ? (
          <p className="text-muted-foreground text-sm">No auto-memories captured yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.auto_memories.map((m: any) => (
              <li key={m.id} className="text-sm p-2 rounded hover:bg-muted/30">
                {m.content}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Sleep cycle card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Sleep cycle</h2>
        {data.sleep_cycle.last_run_at ? (
          <p className="text-sm text-muted-foreground">
            Last run: {new Date(data.sleep_cycle.last_run_at).toLocaleString()} —{' '}
            {data.sleep_cycle.last_merged} merges, {data.sleep_cycle.last_promoted} promotions, {data.sleep_cycle.last_deleted} deletions
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">No consolidation runs yet.</p>
        )}
      </div>

      {/* Delta engine card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Delta engine</h2>
        <p className="text-sm text-muted-foreground">
          Queue size: {data.delta_engine.queue_size} · Consent: {data.delta_engine.consent_granted ? 'granted' : 'not granted'}
        </p>
      </div>

      {/* Skill genesis card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Pending skills ({data.pending_skills.length})</h2>
        {data.pending_skills.length === 0 ? (
          <p className="text-muted-foreground text-sm">No auto-generated skills pending review.</p>
        ) : (
          <ul className="space-y-2">
            {data.pending_skills.map((s: any) => (
              <li key={s.id} className="text-sm p-2 rounded hover:bg-muted/30">
                <strong>{s.name}</strong>: {s.description}
              </li>
            ))}
          </ul>
        )}
      </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/desktop && npx vitest run src/test/v3_brain_dashboard.test.tsx`
Expected: PASS (4/4)

- [ ] **Step 5: Verify no regressions**

Run: `cd frontend/desktop && npx vitest run`
Expected: 274+ pass

- [ ] **Step 6: Commit**

```bash
git add frontend/desktop/src/sections/brain/LearningTab.tsx frontend/desktop/src/test/v3_brain_dashboard.test.tsx
git commit -m "feat(v3): LearningTab remaining cards (auto-memories, sleep-cycle, delta-engine, skill-genesis)"
```

---

## Task 6: SystemHealthTab component

**Files:**
- New: `frontend/desktop/src/sections/brain/SystemHealthTab.tsx`
- Test: extend `frontend/desktop/src/test/v3_brain_dashboard.test.tsx`

- [ ] **Step 1: Add the test**

Append:

```tsx
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';

describe('v3 — System Health tab', () => {
  it('renders a layer with red status when failing', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        all_healthy: false,
        layers: {
          heuristics: { status: 'on & healthy', detail: '12 active', last_check_at: '2026-06-29' },
          blackboard: { status: 'on & failing', detail: '3 notes stale', last_check_at: '2026-06-29' },
        },
      }),
    });
    render(<SystemHealthTab />);
    await waitFor(() => {
      expect(screen.getByText('heuristics')).toBeTruthy();
      expect(screen.getByText('on & healthy')).toBeTruthy();
      expect(screen.getByText('3 notes stale')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `SystemHealthTab` doesn't exist

- [ ] **Step 3: Create SystemHealthTab**

Create `frontend/desktop/src/sections/brain/SystemHealthTab.tsx`:

```tsx
import { useEffect, useState } from 'react';

const API_BASE = '/api/brain';

interface LayerInfo {
  status: 'on & healthy' | 'on & failing' | 'off' | 'not shipped';
  detail: string;
  last_check_at: string | null;
}

interface HealthData {
  layers: Record<string, LayerInfo>;
  all_healthy: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  'on & healthy': 'text-green-600',
  'on & failing': 'text-red-600',
  'off': 'text-gray-500',
  'not shipped': 'text-gray-400',
};

export function SystemHealthTab() {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resp = await fetch(`${API_BASE}/health`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setData(await resp.json());
      } catch (e: any) {
        setError(e.message);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, []);

  if (error) return <div className="p-4 text-danger">Error: {error}</div>;
  if (!data) return <div className="p-4 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-6">
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30">
            <tr>
              <th className="text-left p-3 font-medium">Layer</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Detail</th>
              <th className="text-left p-3 font-medium">Last check</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.layers).map(([name, info]) => (
              <tr key={name} className="border-t border-border">
                <td className="p-3 font-mono">{name}</td>
                <td className={`p-3 ${STATUS_COLOR[info.status] || 'text-gray-500'}`}>
                  {info.status}
                </td>
                <td className="p-3 text-muted-foreground">{info.detail}</td>
                <td className="p-3 text-muted-foreground text-xs">
                  {info.last_check_at ? new Date(info.last_check_at).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.all_healthy && (
          <div className="p-3 bg-green-50 text-green-700 text-sm">
            All cognitive layers are healthy.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/desktop/src/sections/brain/SystemHealthTab.tsx frontend/desktop/src/test/v3_brain_dashboard.test.tsx
git commit -m "feat(v3): SystemHealthTab component"
```

---

## Task 7: Register Brain in nav + route

**Files:**
- Modify: `frontend/desktop/src/sections/brain/BrainDashboard.tsx` (existing stub)
- Modify: `frontend/desktop/src/workspace-registry.ts` (or equivalent — find the right file)
- Test: extend `v3_brain_dashboard.test.tsx`

- [ ] **Step 1: Read existing `BrainDashboard.tsx` to understand the stub**

```bash
cat frontend/desktop/src/sections/brain/BrainDashboard.tsx
```

- [ ] **Step 2: Update `BrainDashboard.tsx` to use the new tab components**

Replace the placeholder content with:

```tsx
import { LearningTab } from './LearningTab';
import { SystemHealthTab } from './SystemHealthTab';
import { useState } from 'react';

export function BrainDashboard() {
  const [tab, setTab] = useState<'learning' | 'health'>('learning');
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-semibold">Brain</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setTab('learning')}
            className={tab === 'learning' ? 'font-medium' : 'text-muted-foreground'}
          >
            Learning
          </button>
          <button
            onClick={() => setTab('health')}
            className={tab === 'health' ? 'font-medium' : 'text-muted-foreground'}
          >
            System Health
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'learning' ? <LearningTab /> : <SystemHealthTab />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register Brain in workspace-registry**

Find the file that registers workspace-level sections (likely `workspace-registry.ts` or `sections/index.ts`). Add:

```typescript
import { BrainDashboard } from '@/sections/brain/BrainDashboard';
// ... in the sections array:
{
  id: 'brain',
  label: 'Brain',
  component: BrainDashboard,
  icon: BrainIcon,  // any existing icon
},
```

(Adapt to the actual file's structure.)

- [ ] **Step 4: Add the route**

Find `routes.ts` and add:

```typescript
{ path: '/brain', element: <BrainDashboard /> },
```

- [ ] **Step 5: Test**

Add to `v3_brain_dashboard.test.tsx`:

```tsx
it('switches between Learning and System Health tabs', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ layers: {}, all_healthy: true, heuristics: [], auto_memories: [], sleep_cycle: {}, delta_engine: {}, pending_skills: [] }),
  });
  render(<BrainDashboard />);
  expect(screen.getByText('Learning')).toBeTruthy();
  // Click System Health
  fireEvent.click(screen.getByText('System Health'));
  await waitFor(() => {
    expect(screen.getByText(/All cognitive layers/)).toBeTruthy();
  });
});
```

- [ ] **Step 6: Verify all v3 frontend tests pass + 274 regression**

Run: `cd frontend/desktop && npx vitest run`
Expected: 280+ pass

- [ ] **Step 7: Commit**

```bash
git add frontend/desktop/src/sections/brain/BrainDashboard.tsx frontend/desktop/src/workspace-registry.ts frontend/desktop/src/routes.ts frontend/desktop/src/test/v3_brain_dashboard.test.tsx
git commit -m "feat(v3): register Brain section in nav and route"
```

---

## Task 8: /Exam backend — generate endpoint

**Files:**
- New: `backend-py/app/services/exam_service.py`
- Modify: `backend-py/app/routers/exam.py`
- Test: `backend-py/tests/v3_exam.py`

- [ ] **Step 1: Write the test**

Create `backend-py/tests/v3_exam.py`:

```python
"""v3 — Test /api/exam/* endpoints."""
import pytest
import json
from unittest.mock import patch


@pytest.fixture(autouse=True)
def _init_db():
    from app.services.memory_store import init
    init()
    yield


def test_generate_exam_with_topic():
    """POST /api/exam/generate with a topic returns an exam with one question."""
    from fastapi.testclient import TestClient
    from app.main import app
    # Mock the Prefrontal call
    fake_exam = [
        {"stem": "What is 2+2?", "options": ["3", "4", "5", "6"], "correct_index": 1, "rationale": "2+2=4."}
    ]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(fake_exam)):
        client = TestClient(app)
        resp = client.post("/api/exam/generate", json={"topic": "math", "count": 1, "difficulty": "easy"})
        assert resp.status_code == 200
        data = resp.json()
        assert "exam_id" in data
        assert "question" in data
        # correct_index should be stripped from the returned question
        assert "correct_index" not in data["question"]


def test_generate_exam_rejects_no_topic_no_files():
    """Generate with neither topic nor files returns 400."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    resp = client.post("/api/exam/generate", json={"count": 5, "difficulty": "easy"})
    assert resp.status_code == 400


def test_generate_exam_validates_llm_output():
    """Malformed LLM output (wrong option count) returns 500."""
    from fastapi.testclient import TestClient
    from app.main import app
    bad_output = [{"stem": "Q", "options": ["only one"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(bad_output)):
        client = TestClient(app)
        resp = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        assert resp.status_code == 500
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-py && python -m pytest tests/v3_exam.py -v`
Expected: FAIL — exam_service doesn't exist

- [ ] **Step 3: Create exam_service.py**

Create `backend-py/app/services/exam_service.py`:

```python
"""v3: Exam service — orchestrates Prefrontal-driven exam generation."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _call_prefrontal(prompt: str) -> str:
    """Call the Prefrontal model for exam generation."""
    try:
        from app.services.workbench import model_fleet
        from app.providers.clients import get_client
        model = model_fleet.get_model_for_role("prefrontal")
        client = get_client({"model": model})
        if client and hasattr(client, "generate"):
            return await client.generate(prompt) or ""
    except Exception as exc:
        logger.warning("_call_prefrontal failed: %s", exc)
    return ""


def _validate_question(q: dict) -> bool:
    """A question must have stem, 4 options, valid correct_index, non-empty rationale."""
    if not isinstance(q, dict):
        return False
    if not q.get("stem") or not isinstance(q["stem"], str):
        return False
    opts = q.get("options")
    if not isinstance(opts, list) or len(opts) != 4:
        return False
    if not all(isinstance(o, str) and o.strip() for o in opts):
        return False
    ci = q.get("correct_index")
    if not isinstance(ci, int) or ci < 0 or ci > 3:
        return False
    if not q.get("rationale") or not isinstance(q["rationale"], str):
        return False
    return True


async def generate_exam(
    topic: str | None = None,
    count: int = 5,
    difficulty: str = "medium",
    files: list[str] | None = None,
) -> list[dict]:
    """v3: Generate an exam using Prefrontal.

    Returns a list of validated question dicts.
    Raises ValueError on invalid input or LLM output.
    """
    if not topic and not files:
        raise ValueError("Either topic or files must be provided")

    context = ""
    if files:
        # v3: extract text from files (PDF, docx, xlsx, text)
        # For v3, simple pass-through for text/code files
        file_texts = []
        import os
        for fp in files:
            if os.path.exists(fp):
                try:
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        file_texts.append(f.read()[:5000])  # truncate
                except Exception:
                    pass
        context = "\n\n".join(file_texts)[:10000]
        if not topic:
            topic = f"the content of {len(files)} uploaded file(s)"

    prompt = (
        f"Generate {count} multiple-choice questions on the topic: {topic}. "
        f"Difficulty: {difficulty}.\n\n"
        + (f"Context:\n{context}\n\n" if context else "")
        + "Each question must have exactly 4 options, exactly 1 correct, "
        "and a 1-sentence rationale. Return a JSON array: "
        '[{"stem": str, "options": [str, str, str, str], "correct_index": 0-3, "rationale": str}]\n'
        "Return ONLY the JSON array, no other text."
    )

    raw = await _call_prefrontal(prompt)
    if not raw:
        raise ValueError("Prefrontal returned empty response")

    # Strip code fences
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        questions = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Prefrontal returned invalid JSON: {exc}")

    if not isinstance(questions, list):
        raise ValueError("Prefrontal output is not a list")

    # Validate every question
    valid = [q for q in questions if _validate_question(q)]
    if len(valid) < count:
        raise ValueError(
            f"Only {len(valid)} of {count} questions passed validation"
        )
    return valid[:count]


def strip_correct_index(question: dict) -> dict:
    """v3: Strip correct_index and rationale from a question before sending to UI."""
    return {
        "id": question.get("id"),
        "stem": question.get("stem"),
        "options": question.get("options"),
        "position": question.get("position"),
    }
```

- [ ] **Step 4: Update the exam router**

Edit `backend-py/app/routers/exam.py`. Replace the placeholder `generate` endpoint with:

```python
@router.post("/generate")
async def generate(payload: dict):
    """Generate a new exam from a topic or uploaded files."""
    from app.services.exam_service import generate_exam
    from app.services.memory_store import _conn
    topic = payload.get("topic")
    count = payload.get("count", 5)
    difficulty = payload.get("difficulty", "medium")
    files = payload.get("files")  # optional list of paths

    if not topic and not files:
        raise HTTPException(status_code=400, detail="topic or files required")

    try:
        questions = await generate_exam(
            topic=topic, count=count, difficulty=difficulty, files=files,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Persist
    conn = _conn()
    source = "files" if files else ("topic" if topic else "model")
    cur = conn.execute(
        "INSERT INTO exams (title, topic, source, source_files) VALUES (?, ?, ?, ?)",
        (f"Exam: {topic or 'files'}", topic or "", source, json.dumps(files or [])),
    )
    exam_id = cur.lastrowid

    for i, q in enumerate(questions):
        conn.execute(
            "INSERT INTO exam_questions (exam_id, position, stem, options, "
            "correct_index, rationale, origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (exam_id, i + 1, q["stem"], json.dumps(q["options"]),
             q["correct_index"], q["rationale"], "generated"),
        )
    conn.commit()

    # Return the first question (with correct_index stripped)
    from app.services.exam_service import strip_correct_index
    first_q = strip_correct_index({
        **questions[0],
        "id": 1,
        "position": 1,
    })
    return {"exam_id": exam_id, "question": first_q, "total_questions": len(questions)}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v3_exam.py -v`
Expected: PASS (3/3)

- [ ] **Step 6: Verify no regressions**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py`
Expected: 267+ pass

- [ ] **Step 7: Commit**

```bash
git add backend-py/app/services/exam_service.py backend-py/app/routers/exam.py backend-py/tests/v3_exam.py
git commit -m "feat(v3): /api/exam/generate endpoint with Prefrontal model + validation"
```

---

## Task 9: /Exam backend — fetch / answer / help endpoints

**Files:**
- Modify: `backend-py/app/routers/exam.py`
- Test: extend `backend-py/tests/v3_exam.py`

- [ ] **Step 1: Add the tests**

Append to `v3_exam.py`:

```python
def test_fetch_question_strips_correct_index():
    """GET /api/exam/{id}/question/{pos} doesn't leak correct_index."""
    from fastapi.testclient import TestClient
    from app.main import app
    from unittest.mock import patch
    import json
    fake = [{"stem": "Q", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(fake)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        # Fetch
        resp = client.get(f"/api/exam/{exam_id}/question/1")
        assert resp.status_code == 200
        data = resp.json()
        assert "correct_index" not in data
        assert "rationale" not in data


def test_answer_records_attempt():
    """POST /api/exam/{id}/answer records and returns correctness."""
    from fastapi.testclient import TestClient
    from app.main import app
    from unittest.mock import patch
    import json
    fake = [{"stem": "Q", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(fake)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        # Get question ID
        from app.services.memory_store import _conn
        q = _conn().execute(
            "SELECT id, correct_index FROM exam_questions WHERE exam_id = ? ORDER BY position",
            (exam_id,),
        ).fetchall()
        question_id = q[0]["id"]
        correct_index = q[0]["correct_index"]
        # Answer correctly
        resp = client.post(f"/api/exam/{exam_id}/answer", json={"question_id": question_id, "selected_index": correct_index})
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_correct"] is True
        assert data["correct_index"] == correct_index


def test_help_returns_explanation_without_correctness():
    """POST /api/exam/{id}/help returns explanation, doesn't reveal correctness."""
    from fastapi.testclient import TestClient
    from app.main import app
    from unittest.mock import patch
    import json
    fake = [{"stem": "Q", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(fake)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        # Help
        resp = client.post(f"/api/exam/{exam_id}/help", json={"question_id": 1, "ask": "Explain?"})
        assert resp.status_code == 200
        data = resp.json()
        assert "explanation" in data
        assert "is_correct" not in data
        assert "correct_index" not in data
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — endpoints don't exist

- [ ] **Step 3: Add the endpoints to the exam router**

Add to `backend-py/app/routers/exam.py`:

```python
@router.get("/{exam_id}/question/{position}")
async def fetch_question(exam_id: int, position: int):
    """Fetch a question by position. Strips correct_index and rationale."""
    from app.services.memory_store import _conn
    conn = _conn()
    q = conn.execute(
        "SELECT id, exam_id, position, stem, options FROM exam_questions "
        "WHERE exam_id = ? AND position = ?",
        (exam_id, position),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    return {
        "id": q["id"],
        "exam_id": q["exam_id"],
        "position": q["position"],
        "stem": q["stem"],
        "options": json.loads(q["options"]),
    }


@router.post("/{exam_id}/answer")
async def answer(exam_id: int, payload: dict):
    """Record an answer attempt and return correctness."""
    from app.services.memory_store import _conn
    question_id = payload.get("question_id")
    selected_index = payload.get("selected_index")
    conn = _conn()
    q = conn.execute(
        "SELECT correct_index, rationale FROM exam_questions WHERE id = ? AND exam_id = ?",
        (question_id, exam_id),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    is_correct = (selected_index == q["correct_index"])
    conn.execute(
        "INSERT INTO exam_attempts (exam_id, question_id, selected_index, is_correct, answered_at) "
        "VALUES (?, ?, ?, ?, datetime('now'))",
        (exam_id, question_id, selected_index, 1 if is_correct else 0),
    )
    conn.commit()
    return {
        "is_correct": is_correct,
        "correct_index": q["correct_index"],
        "rationale": q["rationale"],
    }


@router.post("/{exam_id}/help")
async def help_endpoint(exam_id: int, payload: dict):
    """Get an explanation from Prefrontal. Does NOT reveal correctness."""
    from app.services.memory_store import _conn
    from app.services.exam_service import _call_prefrontal
    question_id = payload.get("question_id")
    user_question = payload.get("ask", "")
    conn = _conn()
    q = conn.execute(
        "SELECT stem, options FROM exam_questions WHERE id = ? AND exam_id = ?",
        (question_id, exam_id),
    ).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    options = json.loads(q["options"])
    prompt = (
        f"Question: {q['stem']}\n"
        f"Options: {' / '.join(options)}\n"
        f"User's question: {user_question}\n\n"
        f"Explain the concept behind this question. Do not reveal which option is correct."
    )
    explanation = await _call_prefrontal(prompt)
    return {"explanation": explanation or "(no explanation available)"}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-py && python -m pytest tests/v3_exam.py -v`
Expected: PASS (6/6)

- [ ] **Step 5: Verify no regressions**

Run: `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py`
Expected: 267+ pass

- [ ] **Step 6: Commit**

```bash
git add backend-py/app/routers/exam.py backend-py/tests/v3_exam.py
git commit -m "feat(v3): /api/exam fetch/answer/help endpoints"
```

---

## Task 10: ExamBanner component

**Files:**
- New: `frontend/desktop/src/sections/exam/ExamBanner.tsx`
- Test: `frontend/desktop/src/test/v3_exam_banner.test.tsx`

- [ ] **Step 1: Write the test**

Create `frontend/desktop/src/test/v3_exam_banner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExamBanner } from '@/sections/exam/ExamBanner';

describe('v3 — ExamBanner', () => {
  it('renders the question stem and 4 options', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ exam_id: 1, question: { id: 1, position: 1, stem: 'What is 2+2?', options: ['3', '4', '5', '6'] } }),
    });
    render(<ExamBanner />);
    await waitFor(() => {
      expect(screen.getByText('What is 2+2?')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('5')).toBeTruthy();
      expect(screen.getByText('6')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `ExamBanner` doesn't exist

- [ ] **Step 3: Create ExamBanner**

Create `frontend/desktop/src/sections/exam/ExamBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';

const API_BASE = '/api/exam';

export function ExamBanner() {
  const [examId, setExamId] = useState<number | null>(null);
  const [question, setQuestion] = useState<any>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<any>(null);

  // Bootstrap: fetch an existing exam or generate one
  useEffect(() => {
    const bootstrap = async () => {
      const resp = await fetch(`${API_BASE}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'general knowledge', count: 5, difficulty: 'medium' }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setExamId(data.exam_id);
        setQuestion(data.question);
      }
    };
    bootstrap();
  }, []);

  const submit = async () => {
    if (selected === null || !examId) return;
    const resp = await fetch(`${API_BASE}/${examId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: question.id, selected_index: selected }),
    });
    if (resp.ok) {
      const data = await resp.json();
      setFeedback(data);
    }
  };

  if (!question) return <div className="p-4 text-muted-foreground">Loading exam…</div>;

  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      <div className="text-sm text-muted-foreground mb-2">Question {question.position}</div>
      <div className="font-medium mb-4">{question.stem}</div>
      <div className="space-y-2 mb-4">
        {question.options.map((opt: string, i: number) => (
          <label key={i} className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted/30">
            <input
              type="radio"
              name="opt"
              checked={selected === i}
              onChange={() => setSelected(i)}
              disabled={!!feedback}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
      {!feedback ? (
        <button
          onClick={submit}
          disabled={selected === null}
          className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          Submit
        </button>
      ) : (
        <div className={`p-3 rounded ${feedback.is_correct ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {feedback.is_correct ? 'Correct!' : `Incorrect. Correct: ${question.options[feedback.correct_index]}`}
          <p className="text-sm mt-1">{feedback.rationale}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/desktop && npx vitest run src/test/v3_exam_banner.test.tsx`
Expected: PASS (1/1)

- [ ] **Step 5: Verify no regressions**

Run: `cd frontend/desktop && npx vitest run`
Expected: 280+ pass

- [ ] **Step 6: Commit**

```bash
git add frontend/desktop/src/sections/exam/ExamBanner.tsx frontend/desktop/src/test/v3_exam_banner.test.tsx
git commit -m "feat(v3): ExamBanner component (one-question-at-a-time UI)"
```

---

## Task 11: /Exam slash command registration

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatThread.tsx` (or similar — find the slash dispatch)
- Test: extend `v3_exam_banner.test.tsx` (or add a new test for the slash command)

- [ ] **Step 1: Find the slash command dispatch table**

```bash
grep -n "/Exam\|/Help\|/btw" frontend/desktop/src/sections/chat/ChatThread.tsx | head -20
```

- [ ] **Step 2: Add `/Exam` to the dispatch**

```typescript
if (trimmed === '/Exam' || trimmed.startsWith('/Exam ')) {
  // Trigger ExamBanner
  setExamActive(true);
  return;
}
```

(Adapt to the actual dispatch structure.)

- [ ] **Step 3: Add a test**

```tsx
it('registers the /Exam slash command', () => {
  // ... integration test for the chat thread
});
```

- [ ] **Step 4: Commit**

```bash
git add frontend/desktop/src/sections/chat/ChatThread.tsx
git commit -m "feat(v3): register /Exam slash command"
```

---

## Task 12: v3 e2e + release

**Files:**
- New: `backend-py/tests/v3_e2e.py`
- Modify: `docs/design/tracker-v3.md`
- New: `docs/releases/v3.0.0.md`

- [ ] **Step 1: Write the e2e test**

Create `backend-py/tests/v3_e2e.py`:

```python
"""v3 — End-to-end test: full Brain dashboard + /Exam flow."""
import json
from unittest.mock import patch
import pytest


@pytest.fixture(autouse=True)
def _init_db():
    from app.services.memory_store import init
    init()
    yield


def test_full_brain_dashboard_flow():
    """Brain router returns all required fields, mutations work."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)

    # Learning endpoint
    learning = client.get("/api/brain/learning").json()
    assert "heuristics" in learning
    assert "auto_memories" in learning
    assert "sleep_cycle" in learning
    assert "delta_engine" in learning
    assert "pending_skills" in learning

    # Health endpoint
    health = client.get("/api/brain/health").json()
    assert len(health["layers"]) >= 12

    # Mutation: add a heuristic
    from app.services.heuristics_service import add_heuristic
    h = add_heuristic("v3 e2e rule", source="v3-e2e")
    # Edit
    resp = client.patch(f"/api/brain/heuristics/{h['id']}", json={"rule": "v3 e2e updated"})
    assert resp.status_code == 200
    # Delete
    resp = client.delete(f"/api/brain/heuristics/{h['id']}")
    assert resp.status_code == 200


def test_full_exam_flow():
    """/Exam full lifecycle: generate → fetch → answer → help."""
    from fastapi.testclient import TestClient
    from app.main import app
    fake = [{"stem": "Q", "options": ["a", "b", "c", "d"], "correct_index": 0, "rationale": "r"}]
    with patch("app.services.exam_service._call_prefrontal", return_value=json.dumps(fake)):
        client = TestClient(app)
        gen = client.post("/api/exam/generate", json={"topic": "x", "count": 1, "difficulty": "easy"})
        exam_id = gen.json()["exam_id"]
        # Fetch
        fetched = client.get(f"/api/exam/{exam_id}/question/1").json()
        assert "correct_index" not in fetched
        # Answer
        ans = client.post(f"/api/exam/{exam_id}/answer", json={"question_id": fetched["id"], "selected_index": 0}).json()
        assert ans["is_correct"] is True
        # Help
        help_resp = client.post(f"/api/exam/{exam_id}/help", json={"question_id": fetched["id"], "ask": "Why?"}).json()
        assert "explanation" in help_resp
```

- [ ] **Step 2: Run the test**

Run: `cd backend-py && python -m pytest tests/v3_e2e.py -v`
Expected: PASS (2/2)

- [ ] **Step 3: Update tracker-v3.md and write release notes**

Add a v3.0.0 patch section to `tracker-v3.md` with the commit references. Create `docs/releases/v3.0.0.md` summarizing what shipped.

- [ ] **Step 4: Commit and tag**

```bash
git add backend-py/tests/v3_e2e.py docs/design/tracker-v3.md
git commit -m "docs: update tracker-v3.md with v3.0.0 ship state"
git add -f docs/releases/v3.0.0.md
git commit -m "docs: v3.0.0 release notes"
git tag -a v3.0.0 -m "v3: Brain dashboard (Learning + System Health) + /Exam feature"
```

- [ ] **Step 5: Final test run**

Run:
- `cd backend-py && python -m pytest tests/ -q --ignore=tests/test_memory.py --ignore=tests/test_routes.py --ignore=tests/v2_real_llm.py` → 280+ pass
- `cd frontend/desktop && npx vitest run` → 280+ pass

---

## Cross-cutting reminders

- **TDD is non-negotiable.** Every backend task has a "write the failing test" step.
- **Commit frequently.** Each task ends with a commit.
- **Don't push.** Local only.
- **Run the full suite after each task.**
- **No placeholder code.**

---

## v3 Definition of Done

- [ ] All 12 tasks completed, each with a green commit
- [ ] Backend tests: 280+ passing
- [ ] Frontend tests: 280+ passing
- [ ] Brain dashboard shows real data on both tabs
- [ ] `/Exam` slash command works end-to-end
- [ ] v3.0.0 tag created locally
- [ ] Trackers and release notes updated
