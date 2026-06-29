# Cognitive Architecture Remediation — Design Doc

**Date:** 2026-06-29
**Status:** Draft for review
**Scope:** Full remediation of the August Proxy cognitive architecture per `docs/design/cognitive-architecture-v1.md` (v1/v2/v3/v4)
**Delivery shape:** One design doc (this) + four sequenced implementation plans (v1.1 → v2 → v3 → v4)

---

## 1. Background and problem statement

A verification pass on 2026-06-29 reviewed the implementation of the cognitive architecture spec (Phases 0–10 + v3 + v4) against the code in `backend-py/app/` and `frontend/desktop/src/`. The pass found:

- **3 critical bugs that break or corrupt the main chat path:**
  1. `context_builder.py:319` references an undefined `cached_t12` (Phase 7 cache hook is wired in `workbench.py:596-602` but never threaded into the builder signature).
  2. `auto_memory.py:49` UPDATE references `updated_at` column that does not exist on `auto_memories` (Phase 0 schema missing column).
  3. Phase 6 `<failure_feedback>` Tier 3 block has a render path but no producer — errors fall through as raw strings into chat tool results.

- **9 spec deviations / incorrect logic items** (auto-compaction triggers at 50% not 90%; state not dropped on plan submit; `brain_query` missing 4 of 12 stores; daemons never call any model; daemon tool allowlist is plumbed but not enforced; no `[CRITICAL]` prefix; no `<verifier_gate>` injection; blackboard missing adaptive TTL + ack; environment watcher is a stub).

- **~15 stubbed features** marked "✅ done & verified" in the trackers but actually skeletal (consolidation_daemon has no Hippocampus call, no scheduler, no skill genesis, no `pending_skills` table; delta_engine LLM path returns `None`; blackboard Tier 3 not injected; environment_watcher is `pass`; live.py is placeholder; entire August Live frontend is missing; Brain dashboard is unreferenced; `/Exam` slash command not registered; exam authoring returns placeholders; exam summary view missing).

- **UI redesign gaps** (user message still has a bubble; composer is 16px not 14px; no caps role label; density toggle scales font-size only; tailwind radius scale skips 10px; Tauri mic capability absent).

**Root cause of the gap:** the trackers' "✅ done & verified" boxes were marked optimistically. The chat path was never run end-to-end (the `cached_t12` bug would have crashed the first turn). Many v2 features shipped as scaffolding without the dynamic behavior the spec calls for.

**This design doc defines a four-phase remediation that brings every shipped feature to working state, in an order that keeps the chat path runnable after every step.**

---

## 2. Goals and non-goals

### Goals

- Bring the main chat path to a runnable, tested state in v1.1.
- Bring every Phase 8-10 feature to working state in v2 (no more skeletons).
- Ship the v3 user-facing surface (Brain dashboard + /Exam) end-to-end.
- Ship the v4 user-facing surface (August Live + UI redesign) end-to-end.
- Keep the system runnable after every individual plan ships.

### Non-goals

- No architecture rewrites. All changes are surgical fixes + bringing stubs to working state.
- No new features beyond the spec. The spec is the source of truth.
- No new cognitive layers. The five-layer model (conscious / subconscious / maintenance / metacognition / brain) is fixed.
- No new model providers. The fleet is Cortex / Cerebellum / Hippocampus / Prefrontal; users can override but the tiers are fixed.

---

## 3. Architecture

The architecture does not change. This remediation restores the spec-defined architecture that the code only partially implemented. The five-layer model:

```
┌──────────────────────────────────────────────────────────────┐
│                      THE JARVIS BRAIN                         │
├──────────────────────────────────────────────────────────────┤
│  CONSCIOUS (per turn)                                         │
│    workbench chat loop                                        │
│      → build_system_prompt (3-tier XML, Phase 7 cache)        │
│      → execute_tool loop (tool_guardrails pre-flight)         │
│      → inject Tier 3 (state, scratchpad, feedback, etc.)      │
│                                                               │
│  SUBCONSCIOUS (background daemons)                            │
│    daemon_manager (Phase 8)                                   │
│      → spawn_daemon / list_daemons / kill_daemon              │
│      → restricted read-only tools, Cerebellum model           │
│      → blackboard coordination                                │
│                                                               │
│  MAINTENANCE (idle / daily)                                   │
│    consolidation_daemon (9a) — Hippocampus LLM                │
│    delta_engine (9b) — local + opt-in LLM                     │
│    episodic_timeline (9c) — temporal search                   │
│    environment_watcher (10.2) — passive fs/git/terminal      │
│                                                               │
│  METACOGNITION (proxy-side, per turn)                         │
│    cognitive_budget (Phase 2)                                 │
│    verifier_reflex (10.3)                                     │
│    skill_genesis (10.4) — Prefrontal LLM, staged for review  │
│                                                               │
│  BRAIN (storage + access)                                     │
│    august_brain.sqlite (Phase 0) — single source of truth     │
│    brain_query (§11) — read-only core tool                    │
│    db_writer (Phase 0) — single async write queue             │
└──────────────────────────────────────────────────────────────┘
```

No new components. Every service that exists in the code today reaches working state.

---

## 4. Delivery plan (4 phased implementation plans)

| Plan | Scope | Estimated effort | Exit criteria |
|------|-------|------------------|---------------|
| **v1.1** | 3 critical bugs + 3 cheap correctness items + math rendering fix (unicode instead of LaTeX) | 3–5 days | A real chat session runs end-to-end without error, prompts are correct, state drops on plan submit, brain_query returns rows for all 12 stores, math renders as unicode (no red LaTeX). |
| **v2** | Bring Phases 8–10 to working state (daemons call Cerebellum; consolidation calls Hippocampus; env watcher watches fs; blackboard adaptive TTL + ack + injection; verifier_gate injected; skill genesis → staging). | 2–3 weeks | All Phase 8-10 features work as the spec describes. No stubs. `pending_skills` table exists. Daemons actually run models. |
| **v3** | Brain dashboard (Learning + System Health) registered in nav with real data; `/Exam` slash command registered; exam authoring uses Prefrontal; exam summary/review view; pending_skills UI. | 2 weeks | User opens Brain section, sees learned data + green health board. User types `/Exam <topic>`, gets a tutor session, ends with scored review. |
| **v4** | August Live (backend reuses workbench turn engine; STT/TTS adapters; /live route; orb + captions + tool rail + approval cards; Tauri mic capability). UI redesign (bubble-less user; caps role label; 14px composer; tailwind 10px step; density toggle maps to turn-gap + composer padding). | 2–3 weeks | User holds a spoken conversation; mutating tools require spoken+visual approval; no regressions to chat. UI matches spec §15 reference feel. |

After each plan ships, we re-verify in production before starting the next. v1.1 must be in production before v2 begins. v2 must be in production before v3. v3 must be in production before v4.

---

## 5. v1.1 design — Surgical fix (the FIRST implementation plan)

The first plan is the most important. It must be reviewable in a single sitting, shippable in under a week, and produce a runnable chat.

### 5.1 Scope

**In scope (7 items):**

1. **Critical bug: `cached_t12` undefined** (`context_builder.py:319`, `workbench.py:602`)
2. **Critical bug: `auto_memories.updated_at` column missing** (`memory_store.py:197-205`, `auto_memory.py:49`)
3. **Critical bug: `<failure_feedback>` has no producer** (`workbench.py:1928-1933`)
4. **Cheap correctness: state drop on new plan submit** (`workbench.py:1982-2012`)
5. **Cheap correctness: auto-compaction threshold** (`workbench.py:972` — change from 50% to attention_pressure==critical; keep `local_summarize` heuristic; add 5-turn re-compaction suppression)
6. **Cheap correctness: 4 missing `brain_query` stores** (graph, daemons, exams, exam_attempts)
7. **UI/UX: math rendering uses unicode math symbols instead of LaTeX** (the model currently emits LaTeX which the KaTeX renderer either fails on or shows in red error color; replace the primary path with unicode)

**Out of scope (deferred to v2/v3/v4):**
- Wiring Hippocampus LLM into auto-compaction (deferred to v2 with consolidation_daemon upgrade).
- Wiring the Cerebellum model into daemons (deferred to v2).
- All other Phase 8-10 stubs (deferred to v2).
- All v3/v4 frontend work.

### 5.2 Component design — bug fixes

#### Fix 1: `cached_t12` keyword argument

**Files:** `backend-py/app/services/memory/context_builder.py`, `backend-py/app/services/workbench/workbench.py`

**Problem:** `workbench.py:597-602` calls `ctx_build(..., cached_t12=cached_t12)`, but `context_builder.build_system_prompt` (line 267-272) has signature `(session, memory, tools, agent_context)` — it does not accept `cached_t12`. Every chat turn raises `TypeError`.

**Solution:** Add `cached_t12: str | None = None` to `context_builder.build_system_prompt` signature. The body at line 319-321 already has the right structure — it just needs the parameter. Test the cached path: when `cached_t12` is provided, skip T1+T2 generation and append the cached string.

**Verification:** Run a chat session; observe no TypeError; observe `prompt_cache` hit on the second turn (check logs).

#### Fix 2: `auto_memories.updated_at` column

**Files:** `backend-py/app/services/memory_store.py`, `backend-py/app/services/memory/auto_memory.py`

**Problem:** `auto_memories` schema (memory_store.py:197-205) lacks `updated_at`, but `save_auto_memory` (auto_memory.py:49) writes to it. Any duplicate-key save raises `OperationalError`.

**Solution:** Add `updated_at TEXT DEFAULT (datetime('now'))` to the `CREATE TABLE` statement. The existing `auto_memories_au` trigger does not reference `updated_at` so it remains correct.

**Migration concern:** The table already exists with the old schema. SQLite supports `ALTER TABLE ADD COLUMN` but not with a `DEFAULT` in older versions. Use a one-time migration at app startup that checks for the column (PRAGMA table_info) and runs `ALTER TABLE auto_memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))` if missing. Idempotent.

**Verification:** Save the same auto-memory key twice in a test; observe no error; observe `updated_at` populated.

#### Fix 3: `<failure_feedback>` producer

**Files:** `backend-py/app/services/workbench/workbench.py`, `backend-py/app/services/memory/context_builder.py`

**Problem:** The render path at `context_builder.py:184-187` exists but nothing populates `session._failure_feedback`. `workbench.py:1928-1933` returns `f"Error: {exc}"` as raw text in the tool result, contradicting the spec.

**Solution:** Wrap the tool dispatch in `workbench._execute_tool` to extract the last frame and format a structured dict:

```python
import traceback

try:
    result = await dispatch_tool(tool_name, args)
    return str(result)
except Exception as exc:
    tb_list = traceback.extract_tb(exc.__traceback__)
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
    if session is not None:
        session._failure_feedback = feedback
        # Counter for auto-decay
        session._failure_feedback_age = 0
    return f"Tool {tool_name} failed: {feedback['error_type']}: {feedback['error_message']}"
```

**Decay:** A counter `session._failure_feedback_age` increments every turn; once `>= 3`, the feedback is cleared (so the prompt doesn't show stale failures). Add the increment to the workbench turn loop.

**Verification:** Trigger a tool error (e.g., call `write_file` to a non-existent directory). On the next turn, the prompt should contain a `<failure_feedback>` block with the structured info.

#### Fix 4: State drop on plan submit / reject

**Files:** `backend-py/app/services/workbench/workbench.py` (`submit_plan`, `reject_workbench_plan`)

**Problem:** State persists across plans; the spec says it should drop on new plan or session end.

**Solution:**

```python
def submit_plan(session: WorkbenchSession, plan_data: dict[str, Any]) -> None:
    session.plan = plan_data
    session.plan_approved = False
    # Drop execution state and working memory — new plan starts fresh
    session._execution_state = None
    session._working_memory = None
    session.updated_at = _now()
    _emit_session_status(session.id)


def reject_workbench_plan(session_id: str) -> bool:
    session = _sessions.get(session_id)
    if not session:
        return False
    session.plan = None
    session.plan_approved = False
    # Rejection also implies a new plan is coming
    session._execution_state = None
    session._working_memory = None
    session.updated_at = _now()
    save_sessions()
    _emit_session_status(session_id)
    return True
```

**Verification:** Submit a plan; observe execution state cleared. Test rejection: reject a plan, observe state cleared.

#### Fix 5: Auto-compaction threshold + cooldown

**Files:** `backend-py/app/services/workbench/workbench.py` (`run_chat_turn` near line 962-998)

**Problem:** Triggers at 50% of `WORKBENCH_TOKEN_BUDGET`; spec says trigger at `attention_pressure == "critical"`. No 5-turn re-compaction suppression.

**Solution:**

```python
# In run_chat_turn, before the main loop:
budget = compute_budget(...)
attention_pressure = budget.get("attention_pressure", "low")

# Track last compaction
if not hasattr(session, "_last_compaction_turn"):
    session._last_compaction_turn = -100
current_turn = session.turn_count  # assume this exists
turns_since_compaction = current_turn - session._last_compaction_turn

should_compact = (
    attention_pressure == "critical"
    and turns_since_compaction >= 5
)

if should_compact:
    compressed = compress_messages(messages, target_tokens=budget["remaining_tokens"])
    # Replace last 10 messages with compacted_history block
    ...
    session._last_compaction_turn = current_turn
    session._last_compaction_status = "1 turn ago"
```

Update `compute_budget` so that when the heuristic fallback is in use, the critical threshold is 85% (already implemented in `token_budget.py:23-25, 63-67` — verify it's wired).

**Verification:** Force context to 95% (e.g., long conversation), observe auto-compaction. Force 50%, observe no compaction. Force compaction, then immediately check next turn: no re-compaction.

#### Fix 6: Missing brain_query stores

**Files:** `backend-py/app/services/tool_definitions.py` (add to enum at line 1206-1207), `backend-py/app/services/memory_store.py` (add store handlers)

**Problem:** `brain_query` enum has 8 stores; spec lists 12.

**Solution:** Add the 4 missing stores with handlers in `memory_store.brain_query`:

| Store | Source | Implementation |
|-------|--------|----------------|
| `graph` | `august_graph_memory.json` (JSON file) | Read JSON, filter by `query` (substring on entity name/relation), return rows capped at `limit`. If file missing or empty, return empty list with note. |
| `daemons` | Live daemon registry (Phase 8) | Call `daemon_manager.list_daemons(session_id=...)` if available; return daemon entries. If no daemons, return empty list. |
| `exams` | `exams` + `exam_questions` tables | JOIN on `exams.id = exam_questions.exam_id`, filter by topic LIKE or title LIKE, return rows. |
| `exam_attempts` | `exam_attempts` table | Filter by exam_id, date range, is_correct, return rows. |

For each, follow the existing pattern: `if store not in _BRAIN_STORES: return {"error": ..., "available": [...]}`.

Update the `brain_query` tool's `store` enum in `tool_definitions.py:1206-1207` to include all 4.

**Verification:** Call `brain_query(store="graph", query="auth")` → returns graph entities. Call `brain_query(store="exams", query="oauth")` → returns matching exams. Call `brain_query(store="daemons")` → returns live daemons.

#### Fix 7: Math rendering uses unicode math symbols (UI/UX)

**Files:** `frontend/desktop/src/sections/chat/ChatMarkdown.tsx`, `frontend/desktop/src/main.tsx`, `backend-py/app/services/memory/context_builder.py` (system constraint)

**Problem:** The model frequently emits math formulas. Currently the rendering path tries to parse them as LaTeX via KaTeX (registered in `ChatMarkdown.tsx:51-125`, $`-guard, mathInline/mathBlock extensions). When the model writes a formula that doesn't match a registered KaTeX delimiter, the LaTeX source falls through to the markdown renderer, which displays it as raw text in the code/error color (red). The user reports this is the visible behavior today — formulas appear in red rather than rendering.

**Root cause:** The model doesn't reliably use the registered KaTeX delimiters (`\( \)`, `\[ \]`, `$ $`, `$$ $$`). It often writes things like `x^2`, `sqrt(x)`, `sum_i a_i`, or `a/b` which neither KaTeX nor markdown handles well, so they end up in red error state. Forcing everything through LaTeX is the wrong default — it puts a heavy cognitive load on the model to remember delimiters, and any mistake degrades the user experience.

**Solution:** Make unicode math symbols the primary path. KaTeX remains for genuinely complex formulas (block-level integrals, matrices) but the common case (superscripts, fractions, summations, common operators) is handled by inline unicode glyphs that render correctly in any font.

**Three-part change:**

1. **System constraint (Tier 1, in `context_builder.py`):** Add a one-line rule instructing the model to prefer unicode math symbols over LaTeX:
   ```text
   - Math: Prefer unicode math symbols (², ³, √, ∑, ∏, ∫, π, ≈, ≤, ≥, ±, →, ×, ÷, ∈, ∉, ∞, ∂) over LaTeX. Use plain unicode fractions (½) or parentheses ((a+b)/c) instead of \frac{a+b}{c}. Reserve LaTeX $...$ for genuinely complex formulas (matrices, multi-line derivations).
   ```

2. **Renderer: stop showing failed LaTeX in red error color.** In `ChatMarkdown.tsx:51-125`, the current `katex.renderToString({throwOnError: false, ...})` returns a placeholder in red when the LaTeX is invalid. Change the strategy:
   - If the delimiters match and KaTeX parses successfully → render the math.
   - If the delimiters match but KaTeX throws → render the **source** (not in red error color — in normal body color with a subtle code font) so the user can read it.
   - If the LaTeX contains a `$` currency context (the spec's existing guard at `ChatMarkdown.tsx` already handles this) → do not attempt to render.

3. **Common-formula auto-conversion (optional, but high-value):** Add a lightweight pre-processor in `ChatMarkdown.tsx` that catches the most common "model emitted raw LaTeX outside delimiters" patterns and converts them to unicode. Examples:
   - `x^2`, `x^n` → `x²`, `xⁿ`
   - `x_1`, `x_n` → `x₁`, `xₙ`
   - `\sqrt{x}` → `√x`
   - `\sum_{i=0}^{n}`, `\sum_i` → `∑ᵢ₌₀ⁿ` or `∑ᵢ`
   - `\int`, `\int_a^b` → `∫`, `∫ₐᵇ`
   - `\pi`, `\theta`, `\alpha` → `π`, `θ`, `α`
   - `\frac{a}{b}` (when not in a code block) → `(a/b)` or `a/b`
   - `a \cdot b`, `a \times b` → `a · b`, `a × b`
   - `>=`, `<=`, `!=` → `≥`, `≤`, `≠`

   The conversion is best-effort, applied before markdown parsing, and **skips content inside code blocks** (triple-backtick fences and inline backticks). It also **skips content inside KaTeX-rendered blocks** (so it doesn't double-process the same span).

**Why unicode, not just "fix the LaTeX path":**
- Unicode math symbols are native to all modern fonts. No library, no parser, no error states.
- The model can be taught to emit them in one system-prompt line. LaTeX requires delimiter discipline.
- The user gets readable math in the common case. KaTeX is reserved for the long tail.
- Removes the "red LaTeX" failure mode entirely.

**Files to touch:**
- `frontend/desktop/src/sections/chat/ChatMarkdown.tsx` — relax KaTeX error color; add unicode auto-converter
- `backend-py/app/services/memory/context_builder.py` — add the Tier 1 math preference constraint in `build_tier1` (alongside the existing guard-mode and verifier rules)
- `frontend/desktop/src/styles.css` — confirm `.katex-error` no longer applies red (or override to normal body color)

**Verification:** Ask the model to "calculate (3+2)² and the sum of 1 to 10". Observe: `(3+2)²` and `∑ᵢ₌₁¹⁰ i` render correctly in the body (not red). Ask "show me the quadratic formula" — observe the model emits unicode (or falls back to KaTeX correctly). No "red LaTeX" output in either case.

### 5.3 Data flow

No data flow changes. All fixes are in-place repairs of existing code paths.

### 5.4 Error handling

The `<failure_feedback>` producer (Fix 3) is itself an error-handling change. It is a hardening of the existing error path — the previous behavior (raw string in tool result) is preserved as a fallback string returned to the model, so no exception is raised. Decay counter prevents stale failures from polluting long sessions.

### 5.5 Testing strategy for v1.1

| Test | What it verifies |
|------|------------------|
| `test_v11_cached_t12.py` | Run two chat turns; assert the second turn's prompt contains the cached T1+T2 portion. |
| `test_v11_auto_memories_updated_at.py` | Save auto-memory twice with same key; assert no error; assert `updated_at` populated. |
| `test_v11_failure_feedback.py` | Trigger a tool error; assert `session._failure_feedback` populated; assert next-turn prompt contains the block; assert block clears after 3 turns. |
| `test_v11_state_drop.py` | Set execution state; submit plan; assert state cleared. |
| `test_v11_auto_compaction_threshold.py` | Force attention_pressure=critical; assert compaction runs. Force pressure=high; assert no compaction. Force compaction; assert 5-turn cooldown enforced. |
| `test_v11_brain_query_all_stores.py` | For each of 12 stores, call brain_query; assert correct shape (rows or "not available"). |
| `test_v11_math_unicode.py` | Render `x^2`, `\sum_i`, `>=`, `\pi` through ChatMarkdown; assert unicode output. Render invalid LaTeX (e.g., `\frac{`); assert it appears in normal body color, not red error color. Render a code block containing `$x^2$`; assert it stays as code (no conversion). |
| `test_v11_e2e_chat.py` | End-to-end: user sends "Hello", model responds, second turn "What did I say?", model uses brain_query(history) to recall. No crashes. |

Add tests as `backend-py/tests/v11_*.py` and `frontend/desktop/src/__tests__/v11_*.test.tsx` using pytest + Vitest respectively. They should run in <30s total and require no real model API.

### 5.6 Risk register for v1.1

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `cached_t12` fix breaks the prompt cache (T1+T2 still regenerated when it should be cached) | Low | Medium | Add explicit test for cache hit on turn 2. |
| `updated_at` ALTER TABLE fails on existing DB (older SQLite) | Low | High | Wrap in `try/except`; fall back to recreating the table if ALTER fails. Log a warning. |
| `<failure_feedback>` producer breaks the chat loop on a tool error | Low | High | The producer only stores on session; the tool result is still returned. Test the happy path and a forced error. |
| Auto-compaction now happens mid-conversation unexpectedly | Medium | Low | The threshold (90%) is high; the cooldown (5 turns) prevents thrash. Test with 80% context — no compaction. |
| `brain_query(store="graph")` reads large JSON file and stalls | Medium | Medium | Cap result rows; if JSON >1MB, return error. |
| Unicode auto-converter breaks code blocks (e.g., converts `$x^2$` inside a fenced block) | Medium | High | Auto-converter explicitly skips content inside backtick fences and inline backticks. Test with code samples. |
| System-prompt rule "use unicode math" is ignored by the model in practice | Medium | Low | Even if ignored, the renderer-side auto-converter catches the most common patterns. Belt + suspenders. |
| The math-rendering change introduces a new "false positive" conversion (e.g., `$5.00` becoming `5.00` instead of staying as currency) | Low | Low | The existing `$`-currency guard in `ChatMarkdown.tsx` already handles the `$` boundary. Auto-converter is conservative (only acts on clear LaTeX-shaped input). |

### 5.7 v1.1 Definition of Done

- All 7 bugs fixed and committed.
- All 7 tests pass (`pytest backend-py/tests/v11_*.py` + `vitest run frontend/desktop/src/__tests__/v11_*.test.tsx`).
- A real chat session runs end-to-end without errors or warnings related to the fixes.
- Trackers `tracker-v1.md` updated to reflect actual state (not aspirational).
- The chat log shows `<failure_feedback>` working on a forced error.
- `brain_query` returns rows for all 12 stores (or "not available" for genuinely unshipped ones).
- Math in user-facing chat renders as unicode in the common case; no "red LaTeX" output; KaTeX still works for complex formulas.

---

## 6. v2 design — Phases 8-10 bring-up (high-level roadmap)

The detailed v2 plan is written after v1.1 ships. This section is a signpost.

### 6.1 Scope

- **Phase 8 daemons actually run:** create `app/services/workbench/model_fleet.py` exposing `get_model_for_role(role)`. Wire daemon_manager to use Cerebellum. Enforce tool allowlist in `_run_once`. Add `[CRITICAL]` prefix logic. Add truncated traceback on error.
- **Phase 9a consolidation actually consolidates:** wire Hippocampus LLM call. Add scheduler (e.g., asyncio task that runs every 24h, also triggered on idle detection). Use `db_writer.enqueue_write` for all writes.
- **Phase 9b delta engine actually infers rules:** implement `_call_hippocampus` to call model with batched diffs. Subscribe to env-watcher events.
- **Phase 9c timeline:** add hourly sweep task. Wire `search_timeline` core tool (via `brain_query(store="timeline")`).
- **Phase 10.1 blackboard:** adaptive TTL `max(poll_interval×2, 60s)` or 3 turns. Add `ack=True` parameter to `read_blackboard`. Inject `<blackboard_state>` Tier 3 in workbench.
- **Phase 10.2 environment watcher:** use `watchdog` library. Watch fs mods (ignore .pyc/node_modules/.git/objects), git branch, terminal activity. Rate-limit 1 update / 2s. Emit file-change events. Inject `<environment>` into `<runtime_context>`.
- **Phase 10.3 verifier reflex:** inject `<verifier_gate>` Tier 3 on `update_state(phase="review|complete")`. Re-gate on failure.
- **Phase 10.4 skill genesis:** add `pending_skills` table. Add `data/skills/staging/` directory. Wire consolidation_daemon to draft SKILL.md using Prefrontal. Quality guard (≥3 uses, max 1/day, `created_by: auto-gen` tag). Surface in Brain dashboard.

### 6.2 Key new files

- `backend-py/app/services/workbench/model_fleet.py` (Cortex/Cerebellum/Hippocampus/Prefrontal)
- `backend-py/app/services/scheduler.py` (consolidation + timeline sweep + skill genesis)
- `data/skills/staging/` directory
- New table: `pending_skills` in memory_store

### 6.3 Tests for v2

- `test_v2_daemon_cerebellum.py` — daemon actually invokes model (mock Cerebellum)
- `test_v2_daemon_tool_allowlist.py` — tools=[] disables; restricted default enforced
- `test_v2_consolidation_hippocampus.py` — Hippocampus called with batch prompt
- `test_v2_delta_engine_llm.py` — LLM path returns heuristic rules
- `test_v2_blackboard_adaptive_ttl.py` — TTL computes correctly for various poll intervals
- `test_v2_blackboard_ack.py` — ack=True deletes note
- `test_v2_env_watcher_fs.py` — fs modification triggers event
- `test_v2_verifier_gate.py` — phase=review injects gate; verification_command renders specific
- `test_v2_skill_genesis.py` — quality guard prevents single-use skill; staging dir created
- `test_v2_selfcheck.py` — each layer exposes selfcheck()

### 6.4 v2 Definition of Done

- Every Phase 8-10 feature works as spec describes
- `selfcheck()` on each layer returns `ok` for healthy state
- No stubs remain in v2 services
- A real chat with daemons running shows `<subconscious_updates>` from triggered daemons
- A real chat with consolidation enabled shows heuristic merges/promotions in `learned_heuristics` / `facts`
- `pending_skills` table populates when consolidation finds a multi-use success

---

## 7. v3 design — Brain dashboard + /Exam (high-level roadmap)

### 7.1 Scope

- **Brain dashboard frontend:** register `BrainDashboard.tsx` in `workspace-registry.ts` (workspace-level item) and `routes.ts`. Wire `/api/brain/learning` + `/api/brain/health` to the two tabs.
- **Brain dashboard Learning tab:** add cards for recent auto-memories, delta-engine activity, sleep-cycle log, skill genesis. Per-heuristic delete/edit. Per-pending-skill approve/edit/reject.
- **Brain dashboard System Health tab:** per-phase board with flag value, status, last self-check. Failing layer turns red with detail.
- **/Exam slash command:** add to `ChatThread.tsx:1173-1249` dispatch table.
- **/Exam authoring:** wire Prefrontal model call. Server validates `{stem, options[3..5], correct_index, rationale}`. Reject malformed output.
- **/Exam summary/review view:** show score, per-question review (revealing correct_index + rationale + source_snippet for file-seeded). Regenerate/retry button.
- **/Exam file upload:** reuse chat attachment pipeline (PDF/docx/xlsx).
- **Brain selfcheck improvements:** 12/12 layers have real selfchecks (not "on & healthy" fallthrough).

### 7.2 v3 Definition of Done

- User opens Brain section, sees real learned data and a green health board.
- User types `/Exam <topic>`, gets a tutor session (banner + modal + summary).
- Exam questions authored by Prefrontal model (not placeholders).
- User can request a specific question mid-exam; model appends.
- User can ask for help; banner stays; help in modal.
- User finishes exam, sees scored review.
- All UX invariants from tracker-v3.md hold.

---

## 8. v4 design — August Live + UI redesign (high-level roadmap)

### 8.1 Scope

- **August Live backend:** `live.py` reuses workbench turn engine (not a placeholder). `POST /api/live/turn` runs the existing workbench tool loop, streams same SSE events. `GET/PUT /api/config/live` for STT/TTS provider+model+voice. Reasoning model = Cortex.
- **STT/TTS adapters:** provider-agnostic (Whisper/gpt-4o-transcribe/Deepgram/local for STT; OpenAI TTS/ElevenLabs/Piper for TTS). Browser `SpeechRecognition`/`speechSynthesis` fallback.
- **August Live frontend:** `/live` route, animated orb/waveform (idle/listening/thinking/speaking), large rolling captions, tool activity rail, approval cards (Approve/Deny), Mute + End + push-to-talk/continuous toggle, barge-in.
- **Tauri mic capability:** add `core:audio:*` (or equivalent) to `src-tauri/capabilities/default.json`.
- **Command-exec safety:** guard mode applies identically to voice; mutating tools → pending mutation with spoken+visual approval; destructive verbs never auto-run; "stop" / "August stop" cancels.
- **UI redesign:** bubble-less user message (caps role label "YOU" / "AUGUST" + color differentiation, no colored bubble). Composer radius 14px (rounded-[14px] not rounded-2xl). Tailwind config add `10` step. Density toggle maps to turn-gap + composer padding (not just font-size). Body line-height 1.6 already done.
- **Mandatory security review:** run `/security-review` on the Live diff. Sign-off recorded.

### 8.2 v4 Definition of Done

- User holds a spoken conversation with August in a polished Live surface.
- Mutating voice commands require spoken+visual approval (no voice bypass).
- Barge-in pauses TTS; mute halts capture immediately.
- Every Live turn persisted to `messages` (auditable via `brain_query`).
- UI matches spec §15 reference feel (dark default, calm content-first, no regressions).
- Security review signed off.

---

## 9. Cross-cutting concerns (apply to every phase)

### 9.1 Testing

- Each phase ships with its own test suite (`backend-py/tests/v{N}_*.py`).
- Tests must run in <30s and require no real model API (mock all model calls).
- Every fix to an existing code path includes a regression test (red-green-refactor: write the failing test, fix the code, verify pass).
- E2E smoke test per phase (`test_v{N}_e2e.py`): one full chat session, asserts no crashes, no warnings from the phase's changes.

### 9.2 Feature flags

The `data/config.json → cognitive_layers` flags remain the toggle for each phase. v1.1 doesn't add new flags (it fixes existing). v2 adds flags for `daemons`, `blackboard`, `env_watcher`, `verifier_reflex`, `skill_genesis` (all default `false` until DoD met). v3 adds `brain_dashboard`, `exam`. v4 adds `live` (default `false` until security review signed off).

### 9.3 Tracker hygiene

Each phase updates its tracker (`tracker-v1.md` etc.) to reflect actual verified state. Boxes go from `[ ]` → `[x]` only when the test for that box passes. The "done & verified" column requires evidence (test name + output), not assertion.

### 9.4 Documentation

The spec is the source of truth. If reality diverges from the spec, the spec is updated first, then the implementation. Any deviation from the spec in this remediation is documented as an explicit decision in the relevant phase's tracker notes.

### 9.5 Backwards compatibility

All DB schema changes (Fix 2 in v1.1, new tables in v2/v3) are backward-compatible: existing rows are preserved, new columns/tables are added with sensible defaults. The migration scripts (`scripts/migrate_*.py`) are idempotent and have `--dry-run` flags.

---

## 10. Success criteria (overall)

The remediation is complete when:

1. **v1.1 exit criteria met** (3 bugs fixed, chat runs, 4 missing brain_query stores work).
2. **v2 exit criteria met** (no Phase 8-10 stubs, all features work as spec).
3. **v3 exit criteria met** (Brain dashboard + /Exam end-to-end).
4. **v4 exit criteria met** (August Live + UI redesign, security review signed off).
5. **The trackers accurately reflect state** (no aspirational boxes).
6. **The chat runs end-to-end with all features on** (a stress test: 20-turn session with daemons, consolidation, env watcher, blackboard, brain dashboard reachable, /Exam, August Live surface open — nothing crashes, no warnings).

---

## 11. Open questions (to resolve in v1.1 implementation plan)

These are deliberately left for the implementation plan to resolve, not for this design doc:

- **Hippocampus model config:** what's the default Hippocampus model for users who don't configure one? (Spec says Haiku, but cost-conscious users may want local.)
- **Skill genesis cooldown:** 30-day stale-with-zero-signal is the spec; is this the right number? (Could be configurable.)
- **Density toggle default:** Comfortable or Compact? (Spec is silent.)
- **August Live barge-in timeout:** how long after user starts speaking should TTS pause? (Spec says "immediately" but practical systems have a 200-500ms grace.)
- **`/Exam` authoring model:** the spec says Prefrontal; do we add a user-configurable override?

These will be resolved in the writing-plans step.

---

## 12. Glossary

- **Cortex** — main session model, high reasoning, 200K+ ctx (Sonnet 4, GPT-4o)
- **Cerebellum** — fast cheap model for daemons (Haiku, GPT-4o-mini)
- **Hippocampus** — moderate model for consolidation (Haiku)
- **Prefrontal** — high-reasoning model for skill genesis (Sonnet 4, Opus)
- **Tier 1/2/3** — system prompt structure (identity / environment / runtime)
- **FTS5** — SQLite full-text search version 5
- **Daemon** — background async task with read-only tools
- **Subagent** — synchronous delegation to Cortex with full tools
- **Blackboard** — inter-agent shared notes (session-scoped)
- **Heuristic** — short persistent rule the model has learned

---

**End of design doc. After your review, I will invoke the writing-plans skill to produce the v1.1 implementation plan.**
