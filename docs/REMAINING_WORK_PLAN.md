# August Proxy — Remaining Work Plan

> **Status:** Ready for implementation
> **Created:** 2026-07-30
> **Prerequisite:** All 6 phases of BETTER_HARNESS_PLAN.md complete (1167 backend + 716 frontend tests green)

---

## Table of Contents

- [Sprint A: Frontend UX Completion](#sprint-a-frontend-ux-completion)
- [Sprint B: E2E Testing & API Migration](#sprint-b-e2e-testing--api-migration)
- [Sprint C: Dependency Security](#sprint-c-dependency-security)
- [Sprint D: Deep Better-Harness Alignment (Phase 7)](#sprint-d-deep-better-harness-alignment-phase-7)

---

## Sprint A: Frontend UX Completion

**Goal:** Finish the user-facing features that need frontend component work.
**Estimated effort:** 3-4 hours
**Dependencies:** None

### A.1 Graceful Degradation Mode (Plan item 5.1)

- [ ] **Implemented**
- [ ] **Tested**

**File:** `frontend/desktop/src/components/overlays/BackendBootstrapGate.tsx`

**Current behavior:** Polls `proxy_status` every 1s, auto-restarts after 8s, shows error card with retry.

**Target behavior:**
1. **0-10s:** Normal spinner ("Starting August backend...")
2. **10s:** Show "Taking longer than usual" + common fixes list:
   - Port 8085 already in use (close other apps)
   - Python version mismatch (requires 3.12+)
   - Antivirus blocking uvicorn
3. **30s:** Show [Run Diagnostics] button that:
   - Checks port availability (`netstat`)
   - Checks Python version
   - Checks disk space
   - Shows results inline
4. **Mid-session backend death:**
   - Catch WebSocket disconnect + fetch failures in `realtime/` bridge
   - Show "Reconnecting..." banner (amber, non-blocking)
   - Preserve chat UI in read-only mode (disable composer)
   - Auto-retry every 5s; on success → restore full interactivity + toast "Reconnected"

**Implementation steps:**
1. Add `phase` state to BackendBootstrapGate: `'loading' | 'slow' | 'critical' | 'error'`
2. Timer at 10s → set phase to `'slow'`, render fixes list
3. Timer at 30s → set phase to `'critical'`, render diagnostics button
4. Diagnostics: call existing Tauri `check_backend_health` command or run doctor logic
5. In `src/realtime/bridge.ts`: add `onDisconnect` callback → emit event
6. In `ChatLayout.tsx`: listen for disconnect event → show banner, disable composer
7. On reconnect: emit event → hide banner, re-enable composer

**Test:** `BackendBootstrapGate.test.tsx` — phase transitions at 10s/30s, diagnostics render, retry works.

---

### A.2 Feedforward/Feedback Bar (Plan item 4.4)

- [ ] **Implemented**
- [ ] **Tested**

**Files:**
- Backend: `app/services/workbench/workbench.py` (emit SSE event at turn start)
- Frontend: `src/components/chat/ContextBar.tsx` (new)

**Backend change:**
At the start of each assistant turn in `sendWorkbenchMessageStream`, emit:
```python
await emit({'type': 'feedforward', 'rules': N, 'skills': N, 'memories': N, 'heuristics': N})
```
Source counts from: loaded heuristics count, skills manifest count, auto_memories injected count.

At turn end (after evidence classification), emit:
```python
await emit(tracker.to_dict())  # Already designed in evidence.py
```

**Frontend component:**
```tsx
// ContextBar.tsx — subtle bar above assistant response
<div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-1">
  {feedforward && <span>Loaded: {rules} rules, {skills} skills, {memories} memories</span>}
  {evidence?.state === 'verified' && <Badge variant="outline">✅ Verified</Badge>}
  {evidence?.state === 'unverified' && <Badge variant="outline" className="text-amber-500">⚠️ Unverified</Badge>}
</div>
```

**Implementation steps:**
1. In workbench.py, count loaded context items at turn start → emit `feedforward` SSE
2. Wire `TurnEvidenceTracker` into the tool loop (record each tool, classify at end)
3. Emit `evidenceState` SSE at turn end
4. Create `ContextBar.tsx` component
5. Render in `ChatThread` message list: above each assistant message that has feedforward/evidence data
6. Store feedforward/evidence in the message metadata (workbench blob)

**Test:** Backend: verify SSE events emitted. Frontend: `ContextBar.test.tsx` renders badges correctly.

---

## Sprint B: E2E Testing & API Migration

**Goal:** Automated regression net for critical paths + consistent API shape.
**Estimated effort:** 8-10 hours
**Dependencies:** Sprint A complete (for degradation testing)

### B.1 Playwright E2E Tests (Plan item 6.1)

- [ ] **Implemented**
- [ ] **Tested**

**Files:**
- `frontend/desktop/e2e/` (new directory)
- `frontend/desktop/playwright.config.ts` (new)
- `backend-py/tests/mock_provider.py` (new — fake OpenAI-compatible server)

**6 critical-path tests:**

| # | Test | What it verifies |
|---|---|---|
| 1 | App launch → chat ready | Bootstrap gate passes, chat composer visible |
| 2 | Add provider → test → first message | Provider CRUD + model fetch + streaming response |
| 3 | Switch model mid-conversation | Model picker works, next response uses new model |
| 4 | Workbench tool execution | Agent calls a tool, result renders in chat |
| 5 | Settings persistence | Change setting → navigate away → come back → still changed |
| 6 | Error boundary recovery | Force section crash → retry → section recovers |

**Mock provider:**
```python
# mock_provider.py — minimal OpenAI-compatible server for E2E
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
app = FastAPI()

@app.get("/v1/models")
async def models():
    return {"data": [{"id": "mock-gpt-4o", "object": "model"}]}

@app.post("/v1/chat/completions")
async def chat(request: dict):
    if request.get("stream"):
        return StreamingResponse(sse_generator(), media_type="text/event-stream")
    return {"choices": [{"message": {"role": "assistant", "content": "Mock response"}}]}
```

**CI integration:**
```yaml
# .github/workflows/e2e.yml
- run: npx playwright install chromium
- run: python backend-py/tests/mock_provider.py &
- run: npx playwright test --project=chromium
```

**Implementation steps:**
1. `npm i -D @playwright/test` in frontend/desktop
2. Create `playwright.config.ts` (baseURL: http://localhost:5173, webServer: vite dev)
3. Create mock provider (FastAPI, port 9999)
4. Write 6 test files in `e2e/`
5. Add `test:e2e` script to package.json
6. Add CI workflow (optional — can run locally first)

---

### B.2 API Envelope Migration (Plan item 6.7)

- [ ] **Implemented**
- [ ] **Tested**

**File:** All files in `backend-py/app/routers/`

**Strategy:** Incremental rollout with backward compatibility.

**Phase 1 (this sprint):** Migrate the new `/api/harness/*` endpoints to use the envelope (they're new, no compat risk).

**Phase 2 (next release):** Add envelope to `/api/brain/*`, `/api/skills/*`, `/api/sessions/*`.

**Phase 3 (following release):** Migrate `/api/workbench/*`, `/api/providers/*`.

**Backward compatibility:**
```python
# Clients that send Accept: application/vnd.august.v0+json get the old shape.
# Default (no header) gets the new envelope.
def wants_legacy(request: Request) -> bool:
    return 'vnd.august.v0' in request.headers.get('accept', '')
```

**Implementation steps:**
1. Update `app/routers/harness.py` to wrap all responses in `success()`/`error()`
2. Add `Accept` header check utility to `app/lib/api_envelope.py`
3. Migrate 5 routers per sprint, updating frontend API clients to unwrap `.data`
4. Add test: each migrated endpoint returns `{ok: true, formatVersion: "1.0", data: ...}`

---

## Sprint C: Dependency Security

**Goal:** Eliminate known vulnerabilities.
**Estimated effort:** 2-3 hours
**Dependencies:** None (independent)

### C.1 Replace `xlsx` (SheetJS)

- [ ] **Implemented**
- [ ] **Tested**

**Problem:** `xlsx` has Prototype Pollution + ReDoS vulnerabilities with **no fix available**.

**Steps:**
1. Find all usages: `grep -rn "xlsx\|XLSX\|SheetJS" frontend/ --include="*.ts" --include="*.tsx" | grep -v node_modules`
2. Evaluate replacements:
   - `exceljs` — maintained, similar API, larger bundle
   - `xlsx-js-style` — fork with fixes, drop-in replacement
   - Remove entirely if only used for simple CSV export
3. Replace import + adjust API calls
4. Run `npm audit` → verify vulnerability count drops
5. Run frontend tests

### C.2 Fix remaining audit issues

- [ ] **Implemented**
- [ ] **Tested**

**Steps:**
1. `npm audit fix` (safe fixes)
2. For `@expo/prebuild-config` chain: update Expo SDK in mobile workspace
3. Verify: `npm audit --omit=dev` reports 0 critical/high
4. Run `npm run test:verify` (backend + frontend + mobile)

---

## Sprint D: Deep Better-Harness Alignment (Phase 7)

**Goal:** Close the conceptual gaps between our implementation and better-harness's review methodology.
**Estimated effort:** 2-3 days
**Dependencies:** All previous sprints complete

### D.1 Seven-State Evidence Ladder

- [ ] **Implemented**
- [ ] **Tested**

**Current:** 3 states (verified/unverified/read_only) — per-turn only.

**Target:** 7 states across the full lifecycle:
```
Present → Wired → Exercised → Outcome-supported
Missing | Unobserved | Not applicable
```

**Implementation:**
1. New table `evidence_states` (capability, state, session_id, timestamp, evidence_ref)
2. Track per-capability (not per-turn):
   - `Present`: config/file exists (detected by readiness scan)
   - `Wired`: connected to a trigger (hook registered, skill has trigger text)
   - `Exercised`: used in a real session (hook fired, skill loaded, test ran)
   - `Outcome-supported`: later comparable session shows improvement
3. Score ceilings: Missing/Unobserved → 59, Present → 74, Wired → 84, Exercised → 94, Outcome-supported → 100
4. Endpoint: `GET /api/harness/evidence-states` → per-capability ladder
5. Frontend: show ladder in readiness panel (colored dots per state)

**Key rule:** "A configured capability is not observed use." Presence of a hook file proves `Present`; only a hook firing in a real session proves `Exercised`.

---

### D.2 Ten-Question Loop Discovery Gate

- [ ] **Implemented**
- [ ] **Tested**

**Current:** `workflow_detection.py` promotes from title overlap + session count (better-harness explicitly forbids this).

**Target:** Replace with the 10-question decision gate before promoting any candidate:

| # | Question | Evidence source |
|---|---|---|
| 1 | Repeated intent? | ≥2 distinct sessions with same goal (not just title) |
| 2 | Existing coverage? | Check skills/heuristics/rules for overlap |
| 3 | Stable input shape? | First-message structure repeats (not just words) |
| 4 | Repeatable procedure? | Ordered tool sequence repeats across sessions |
| 5 | Verification present? | Sessions include test/lint/build after mutations |
| 6 | Stop condition definable? | Clear completion signal exists |
| 7 | Safety boundary? | No production/credential/destructive ops in procedure |
| 8 | State contract? | Inputs/outputs are serializable (can pause/resume) |
| 9 | Observability? | Progress is trackable (tool calls, SSE events) |
| 10 | Evaluation? | Success is measurable (test pass, output matches) |

**Implementation:**
1. Rewrite `workflow_detection.py`:
   - Phase 1: Cluster by first-message embedding (use vector_db, not title words)
   - Phase 2: For each cluster ≥2, run the 10-question gate
   - Only promote if ≥7/10 answers are concrete (not "needs more evidence")
2. Add `existing_coverage` check: query skills + heuristics for keyword overlap
3. Add `tool_sequence` extraction from `episodic_timeline` or message tool_calls
4. Output: candidates with per-question evidence, not just confidence score
5. False-positive firewall: reject if only evidence is title similarity or session count

**Key rule:** "Do not promote a loop from file age, line count, churn, cache paths, titles, or counts alone."

---

### D.3 Tree-Sitter Blast Radius

- [ ] **Implemented**
- [ ] **Tested**

**Current:** Regex grep for importers (depth 1, 8KB cap, single file).

**Target:** Multi-metric framework with real parsing:

| Metric | Warn | High | Critical |
|---|---|---|---|
| Changed files | 8 | 16 | 30 |
| Changed lines | 250 | 700 | 1500 |
| Changed symbols | 6 | 14 | 30 |
| Caller count | 6 | 20 | 50 |
| Impacted symbols (depth 2) | 10 | 30 | 80 |
| Impacted files | 4 | 10 | 20 |

**Implementation:**
1. Add `tree-sitter` + `tree-sitter-python` + `tree-sitter-typescript` to backend deps
2. New `app/services/impact_analysis.py`:
   - `build_code_graph(workspace)` → symbol table + caller/callee edges
   - `map_changed_symbols(diff)` → which functions/classes changed
   - `compute_impact_radius(symbols, depth=2)` → BFS on caller graph
   - `score_changeset(metrics)` → multi-tier score per metric
3. Change hook from per-file to per-turn (accumulate all writes in a turn, score the changeset)
4. Config override: `.august/blast-radius.json` for custom thresholds/ignore globs
5. Security removal detection: flag when auth/permission code is *deleted* (not just modified)

---

### D.4 Ownership Routing Taxonomy

- [ ] **Implemented**
- [ ] **Tested**

**Current:** No routing layer. Detected work (workflow candidates, friction, coverage gaps) has no structured path to a durable owner.

**Target:** Route by ownership before choosing a vendor-specific feature:

| Owner | Responsibility | When to use |
|---|---|---|
| Rule/AGENTS.md | Facts + soft constraints | Project-specific context the agent can't infer |
| Skill | Repeatable how-to procedure | Stable trigger + ordered steps + output + stop |
| Hook | Deterministic lifecycle check | Must run every time, blocking or logging |
| Memory | Observed preferences/corrections | Repeated correction across ≥2 sessions |
| Script/Automation | Scheduled or event-driven work | Explicit cadence + bounded scope |
| Custom Agent | Role-isolated delegation | Focused task with bounded tools |
| MCP | External access | API/tool access without reusable procedure |

**Implementation:**
1. New `app/services/ownership_router.py`:
   - `suggest_owner(demand: dict) -> OwnerRecommendation`
   - Applies the coverage ladder: observed → built-in → configured → extend → create → needs evidence
   - Returns: suggested owner, existing coverage, creation criteria
2. Wire into reconciliation.py: coverage gaps get owner suggestions
3. Wire into workflow_detection.py: promoted candidates get owner route
4. Endpoint: `GET /api/harness/ownership-suggestions`
5. Frontend: show owner suggestion in Brain → Learning tab alongside candidates

---

## Priority & Scheduling

| Sprint | Priority | Effort | Can parallelize? |
|---|---|---|---|
| **A** (Frontend UX) | High | 3-4h | Independent |
| **B** (E2E + API) | Medium | 8-10h | After A |
| **C** (Dependencies) | Medium | 2-3h | Independent |
| **D** (Phase 7) | Low (strategic) | 2-3 days | After A+B |

**Recommended order:** A → C → B → D

Sprint A gives immediate user-facing value. Sprint C is quick security hygiene. Sprint B builds the regression net. Sprint D is the deep methodological alignment that makes August a true harness-aware product rather than a harness-instrumented one.

---

*Last updated: 2026-07-30*
