# August Harness Master Plan — 2026-08-23

> **North star (`IDEA.md`):** an agent harness in the class of Codex, Hermes agent, DeepSeek harness, and Claude Code. Every phase below is judged against that bar.
>
> **Scope:** this document merges **all** planning output produced in the 2026-08-22/23 engagement: the repo deep-scan, the tool-registry audit, the external research digest (Claude memory tool, Hermes agent), the code review of `8d87989c..84282706`, and the phased improvement plan. It **supersedes** the chat-delivered plan of 2026-08-22. It does **not** replace `docs/BETTER_HARNESS_PLAN.md`, which remains the shipped 46-feature record.
>
> **Status:** SHIPPED 0.16.6 (2026-08-23) — P0 verified+landed; P1 recall ritual, P2 nudge, P4 prompt hygiene, P5 context popover (+ MCP token split + snake/camel capabilities fix) landed; self-improvement loop (`harness_introspect`/`harness_propose` + deterministic applier + `/api/brain/harness/proposals*`) landed; U2 commit composer, U3 interactive checklist, U5 graph filters landed; U1 find-in-transcript verified pre-existing. **Open:** P3 skills maturity items. Details in `CHANGELOG.md` §0.16.6.
>
> **Validation bar for every phase:** `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q`, then `npm run test:frontend`; live smoke via `npm run dev:desktop` for anything touching prompt/UI. (Known noise: partial pytest runs exit 1 due to the repo coverage gate `fail-under=55` and pytest's Windows temp-symlink cleanup bug — not real failures.)

---

## Part I — Evidence base (what this engagement established)

### I.A Subsystem map (verified anchors)

| Subsystem | Entry points / anchors | Notes |
|---|---|---|
| Turn flow | `workbench.py` `_sendWorkbenchMessageStreamImpl` (~2600 lines) | SSE pipeline; managed tool loop inside |
| System prompt | `context_builder.py` — `buildTier1` :268, `buildTier2` :331, `buildTier3` :392, `buildSystemPrompt` :655, `AUGUST_PLATFORM` const | 3-tier XML; T1/T2 content-hash cached, T3 volatile per-turn |
| Recall gate | `workbench.py` `_shouldAutoRecall` :1185-1222; probe regex `_PROBES_PAST_RE` :224 | Requires `pressure in ('low','medium')` **and** `remaining >= 6000`; later turns fire on every-3rd-user-turn cadence or probe verbs only |
| Memory store | SQLite brain store; TTL + 30-day half-life decay; background review; consolidation daemon; episode summarization; diff learning; budget-gated auto-recall | Vector mirror reconciled in sleep cycle (✅) |
| Auto-memory writes | `auto_memory.py` todos merge `_syncTodos…` region :1430-1460; `workbench.py` `_syncAutoMemory` :4670 | See defect P0.2 |
| Skills | 77 bundled SKILL.md + agent-authored; curator lifecycle 30d stale / 60d archive; usage sidecar `.usage.json` (`SkillUsageRecord`, `skills/curator.py` :27); relevance-matched injection + usage telemetry ✅ | Failure-awareness missing (→ P3.1) |
| Curation ledger | migration `022_curation_ledger.sql`; writers: reflection / sleep cycle / model review / promotion / curator; readers: `/api/brain/curation/ledger`, `/api/brain/learning` | One journal for every loop ✅; `target_key` prefixes inconsistent (→ P4) |
| Tool layer | registry boot audited by `backend-py/scripts/_audit_tool_registry.py`; bare surface allowlist `_BARE_TOOL_ALLOW` `workbench.py` ~:1379; capability filtering `toolDefinitions` :1286 / `openaiToolDefinitions`; MCP defs via `_mcpToolDefinitions*` | 92 tools registered, handlers/schemas OK, zero broken |

### I.B Tool-registry audit (2026-08-23)

Booted the actual registry via `backend-py/scripts/_audit_tool_registry.py` (landed as commit `84282706`). Result: **92 tools**, all handlers callable, all JSON schemas valid, bucket classification sane. No broken registrations — so the "fix broken tools" item closed with zero fixes needed beyond the phantom-name cleanup in `fffbc798`.

Measured description bloat (feeds P4): `remember` **717ch**, `setup_provider` **666ch**, `customize_ui` **611ch** — all over the 300ch target.

### I.C External research digest — what we borrow, what we skip

**Claude memory tool (`memory_20250818`)**
- File-system metaphor under `/memories`: `view / create / str_replace / insert / delete / rename`. Client-side storage; the API only ships the protocol.
- The decisive trick is **protocol injection**: Anthropic auto-appends "ALWAYS consult your memory directory before doing anything else" and keeps a tiny directory listing always visible. Retrieval is just-in-time, not bulk-preloaded.
- Pairs with context editing that excludes the memory tool's contents.
- **Borrow:** always-visible memory pointer + unconditional early recall (P1), mid-task persistence nudge concept (P2). **Skip:** literal `/memories` file tool — August's typed stores + vector search are richer.

**Hermes agent (NousResearch)**
- `MEMORY.md` / `USER.md` always in-context; SQLite FTS5 recall; pluggable `MemoryProvider` ABC with a `prefetch` hook.
- Mid-task persistence nudges during long runs.
- Failure-aware skill improvement (errors recorded against skill usage); `.bundled_manifest` origin hashes protect user-modified bundled skills; per-skill slash commands (max 5 stacked).
- **Borrow:** pointer-in-context pattern (P1.2), nudge (P2), failure-aware usage + origin hashes + `/skill` invocation (P3). **Skip:** provider ABC — August has one store with one interface.

### I.D Code review verdict — `8d87989c..84282706` (7 commits)

| Commit | Verdict |
|---|---|
| `2b42e782` round-4 loop audit (TTL sweep, vector-mirror reconcile, honest health) | Solid |
| `497e533e` async EventLog persistence | Solid — but see shutdown-ordering minor below |
| `463fb698` batched vector search + 10x ceiling | Solid |
| `d598c0a2` unified curation ledger | Solid — `target_key` prefix drift noted (P4) |
| `fffbc798` phantom-name fix + regression test | Solid — one ghost survived in telemetry (minor below) |
| `84282706` audit script | Fine |

Defects found → **P0.1, P0.2** below (both verified still present at `84282706`).

---

## Part II — Ground truth: already shipped, do NOT re-implement

| Original proposal item | Status |
|---|---|
| Unified curation journal ("why did the harness change its memory?") | ✅ `curation_ledger` (migration 022), all five writer loops wired, surfaced via `/api/brain/curation/ledger` + `/api/brain/learning` |
| Cross-loop awareness (loops must not contradict) | ✅ Ledger summary rides in consolidation prompt + model-review payload |
| Vector-mirror drift repair | ✅ `vector_mirror.reconcile_vector_mirror()` in sleep cycle + `POST /api/brain/memory/reconcile` |
| TTL sweep on idle stores | ✅ `runConsolidation` sweeps expired rows, reports `pruned_expired` |
| Honest degradation signals | ✅ `_last_skip_reason` persisted + surfaced; brain events on degraded runs |
| Async EventLog persistence | ✅ Writer thread, `flush()` drain, sync escape hatch |
| Batched vector search + 20k ceiling | ✅ Version-keyed parsed-row bundle, numpy matmul w/ Python fallback |
| Bare-surface allowlist fix | ✅ `fffbc798` incl. regression guard `tests/test_harness_fixes.py::test_bare_tool_allowlist_matches_registry` |
| Scratchpad readability | Non-issue — confirmed `summarize_session(include_scratchpad=True)` + `<working_memory>` Tier-3 injection already exist |

---

## Part III — Workstreams

Execution order: **P0 → P5 → P1 → P2 → P3 → P4** (defects first; self-contained UI with exact spec; then highest-leverage behavior; skills builds on P1 plumbing; polish last).

---

### P0 — Defects from the review (fix first, ~1h)

#### P0.1 False `archive_skill` ledger entries + inflated removal count
**Where:** `backend-py/app/services/memory/memory_review.py:333-351` (model-review `delete` action).

**Problem:** `shared_curator().archive(name)` refuses by **returning `False`** (bundled / pinned / unsafe name) — it does not raise. Current code:

```python
try:
    shared_curator().archive(name)
    archived = True          # ← unconditional
except Exception:
    archived = False
    ...
    _ss4.deleteSkill(name)
applied['removed'] += 1      # ← inflated even when refused
```

Consequences: a refused archive still records `'archive_skill'` in the curation ledger (contradicting the curator's own accurate entry), bumps `applied['removed']`, and the `deleteSkill` fallback can never fire.

**Fix:**

```python
archived = shared_curator().archive(name)
if archived is False:
    _ss4.deleteSkill(name)   # may itself fail → outer try handles
applied['removed'] += 1 only if (archived or deleted)
_ledger('model_review', 'archive_skill' if archived else 'delete_skill', 'skill', name)
```

Only count `removed` when an actual archive/delete succeeded; only write a ledger row on success.

**Tests:** extend `tests/test_curation_ledger.py` — pinned-skill and bundled-skill delete actions assert: no ledger row, `applied['removed'] == 0`.

**Acceptance:** refusing paths produce zero ledger rows and zero counter bumps; succeeding paths unchanged.

#### P0.2 Checked-off todos re-save + re-embed every turn
**Where:** `backend-py/app/services/memory/auto_memory.py:1453-1459`.

**Problem:** save gate

```python
if doneSet or len(keptPrior) != len(prior) or todos:
    merged = list(dict.fromkeys(keptPrior + todos))
    saveAutoMemory('todos', merged, ...)
```

stays true forever once any `- [x]` exists in history (`doneSet` never empties) → identical `todos` row rewritten **every turn**, each write fanning out to a vector-mirror `upsert` + a fresh `_embed()` call of the full text.

**Fix:** compute `merged` unconditionally, then save only on real change:

```python
merged = list(dict.fromkeys(keptPrior + todos))
if merged != prior:
    saveAutoMemory('todos', merged, category='tasks', importance=0.8, source='auto', session_id=session_id)
return todos
```

**Tests:** `tests/test_memory_loop_round4_fixes.py` — monkeypatch counter on `saveAutoMemory`; second call with unchanged history asserts zero invocations.

**Acceptance:** no write (hence no embed/upsert) when merged content equals prior; first-ever todo and genuine transitions still write.

---

### P5 — Context-ring popover redesign (match provided screenshot; ~half day)

Reference: user-provided screenshot — "Context windows" popover showing header `461.4K/1M (46.1%)` above a full-width progress bar; dot-labeled rows with share-of-used percentages (Messages 94.8 / System tools 4.2 / System prompt 0.4 / Skills 0.3 / MCP tools 0.3 / Meta 0); footer "Average cache hit rate 97.2%".

**Target layout for `frontend/desktop/src/sections/chat/ContextRing.tsx` hover card:**

1. **Header:** title + right-aligned `used/limit (pct%)`, above a full-width rounded progress bar (accent fill = used).
2. **Rows** — dot + label left, share-of-*used* % right: Messages (thinking folded in or kept as sub-row), System tools, System prompt, Skills, **MCP tools (new)**, Meta context.
3. **Footer below divider:** average cache hit rate (already plumbed: `promptCache.hitRate`, `ContextRing.tsx` :32/:46; goal-rate delta coloring optional per current taste).
4. Trigger stays the ~22px danger/warning-toned donut; keep the "Compact now" action row.

**Backend:** the capabilities endpoint behind `listWorkbenchCapabilities()` (consumed at `ChatThread.tsx:457-462`) gains `mcpToolTokenEstimate` (+ optionally `mcpToolCount`), computed wherever the existing `toolTokenEstimate` is serialized — the backend already separates MCP defs via `_mcpToolDefinitions*`, so the token split is a measurement beside the existing one, not new plumbing.

**Frontend changes:**
- `context-breakdown.ts`: `ContextBreakdown` gains `mcpTools: number`; `systemTools` becomes built-ins only. Both fields participate in the `scaleToTotal` proportional scaling; the exact-sum correction currently folds rounding remainder + `meta` into messages — keep one fold point so `sum(rows) === scaleToTotal` exactly.
- `ContextRing.tsx`: popover markup per layout above; row order fixed; percent = `row / sum(rows)` (share of *used*, matching the screenshot).
- Tests: update `__tests__/ContextRing.test.tsx` (new rows/header/footer assertions) and `__tests__/context-breakdown.test.ts` (mcpTools scaling case + assertion that scaled rows sum ≈ `scaleToTotal`).

**Acceptance:** popover visually matches the screenshot structure; rows sum exactly to the ring numerator; MCP row shows 0 cleanly when no MCP servers configured; existing donut trigger behavior unchanged.

---

### P1 — Claude-style recall ritual (~1-2 days)

Problem today: `_shouldAutoRecall` (`workbench.py:1185`) requires low/medium attention pressure **and** ≥6000-token headroom — so a fresh session under pressure gets **zero** recall, and nothing tells the model memory exists at all. Claude's mechanism works because the protocol makes memory impossible to forget; August should too.

#### P1.1 Unconditional capped turn-1 recall
Turn 1 (or `user_turns <= 1` in the session scan) always recalls **when durable memories exist**, regardless of pressure/headroom. Under pressure the *cap shrinks* instead of dropping to zero:

- Add a cheap existence check (cached store-count flag; refresh on write hooks) so the empty-store case stays free.
- Cap sizing moves to the recall builder: e.g. pressure low → normal budget, medium → ~60%, high → ~25%, never 0 on turn 1. Later turns keep today's cadence/probe gating.
- Keep the function pure-ish: either widen the return to a small struct (`{fire: bool, cap_tokens: int}`) or keep bool and expose `_recall_cap(pressure)` for the caller — whichever touches fewer call sites.

#### P1.2 Always-visible memory pointer (one line, every turn)
Append to `buildTier3` (`context_builder.py:392`) a single bounded line, e.g. `<memory_pointer>durable memories: N · last session: "<topic>" · use memory_search to pull specifics</memory_pointer>`.

- **Cache-key policy (hard constraint):** T1/T2 are content-hash cached; Tier 3 is volatile by design. The pointer must live **only** in Tier 3 and must **not** enter any content-hash cache input — otherwise every turn invalidates the cached prefix and destroys the 97% cache-hit economics.
- Content sources: store count + newest session topic (already computed for episode summarization) + the search verb. Optional garnish: cite the newest curation-ledger entry ("harness last learned X") as a trust signal.

#### P1.3 Probe-recall caching
Cache probe-triggered recalls per session, keyed `(session_id, normalized_probe_text)` (lowercased, collapsed whitespace), invalidated by a generation counter bumped on any memory write (`remember`, `saveAutoMemory`, consolidation mutations). Prevents repeated "what did I say about X" turns from refetching identical vectors. In-process dict with per-session eviction is sufficient; no new table.

**Tests:** gate unit tests (pressure × headroom × turn-number matrix incl. turn-1-under-pressure); pointer presence + cache-key exclusion test (two consecutive prompts differing only in pointer must not change the hashed prefix inputs); probe-cache hit test (second identical probe hits cache; write bumps generation and misses).

**Acceptance:** fresh session under high pressure still sees recall + pointer; cache hit-rate telemetry does not regress in a manual two-session smoke.

---

### P2 — Mid-task persistence nudge (~1 day)

Background review runs post-turn; lessons spoken mid-run are lost until then (and sometimes forever). Hermes solves this with mid-task nudges.

**Design:** inside the managed tool loop (same round accounting that drives `MAX_MANAGED_TOOL_ROUNDS`), after **N** rounds (start with 6):
- Fire conditions (all required): correction/preference pattern detected in recent exchanges (reuse the correction-supersession signals from the round-2 loop audit / `evidence.py` mutation regexes), **no `remember` call yet this turn**, cognitive pressure < high.
- Injection: one-shot per turn, bounded length (~2 lines), rendered as a `<memory_nudge>` system reminder attached to the next tool-result envelope — same channel as existing stream-rule reminders, so it can't fork message formats.
- Never repeats after the first fire even if conditions persist.

**Tests:** loop-level scenario in `tests/test_harness_evals.py` style — scripted model that states a preference mid-run: assert exactly one `<memory_nudge>`, absent when a `remember` already fired, absent at high pressure.

**Acceptance:** zero behavioral change on casual chats; one bounded nudge max per qualifying turn.

---

### P3 — Skills-loop maturity (~2 days)

#### P3.1 Failure-aware skill usage
Today usage telemetry only `bump_use`s. Extend the `.usage.json` `SkillUsageRecord` schema (`skills/curator.py` :27) with `failure_count`, `last_failure_at`, `last_failure_summary`.
- Wire-up: turn-end outcome recording already exists for routing evidence (`ok` = no turn error) — hook the loaded-skills set there; on turn error/refusal, record failure against each loaded skill.
- Curator review treats repeated failures as patch candidates: propose body/description fixes surfaced in Brain UI (endpoint first; UI row later) instead of blind promotion.
- Schema is additive with defaults → old sidecars load unchanged.

#### P3.2 Bundled-skill origin hashes
Record SHA-256 of each bundled skill's content at bundle time (manifest keyed by skill dir). On bundle refresh: if the on-disk copy's hash ≠ recorded origin hash, the user modified it → **skip overwrite**, log + ledger entry instead. First verify `_copyOnWrite` actually covers the update path (it protects first edits; wholesale re-bundle may bypass it — that's the gap). Reference design: Hermes `.bundled_manifest`.

#### P3.3 Composer `/skill-name` invocation
Composer parses leading `/token`s (max 5 stacked, Hermes parity), validates against the skill catalogue, sends them as part of the message payload; backend preloads those skill bodies into the turn's skills block ahead of relevance matching. Frontend affordance over existing `load_skills`; unknown tokens fall through as plain text. (Autocomplete popup = follow-up, not in scope.)

**Tests:** curator failure-record unit test; origin-hash conflict test (modified bundled skill survives re-bundle); composer parse unit tests (stacking cap, unknown token passthrough).

---

### P4 — Prompt & ledger polish (low risk, opportunistic)

- **Conditional policy blocks:** emit `<clarify_policy>` / `<bulk_tools>` / `<web_research>` only when the corresponding tools are actually offered to the model (the offer-set is known inside `buildSystemPrompt`'s flow — gate there).
- **Trim tool descriptions ≤300ch:** `remember` 717 → keep semantics, move worked examples into the memory SKILL doc; same pass for `setup_provider` 666 and `customize_ui` 611. Pure wins: these ride in every request's tool array.
- **Normalize curation-ledger `target_key`:** actors currently mix `memory:{id}`, raw keys, and unprefixed names. Adopt `memory:{id}` / `skill:{name}` / `store:{key}`; normalize at the `_ledger()` helper so all five writers inherit it. Log-only history stays as-is (no data migration).
- **Minor A:** remove ghost `edit_file` from `_MUTATING_TOOLS` (`workbench.py:5824`) — registry name `edit_lines` already present; cosmetic only.
- **Minor B:** shutdown ordering in `main.py` lifespan — `event_log.flush(timeout=10)` at :254 runs **before** `_gateway` teardown at :257, so events emitted during gateway shutdown land after the final drain and are lost. Move the flush after gateway/browser/daemon teardown, last step before exit.

---

## Part IV — Suggested execution order & protocol

1. **P0.1 + P0.2** (~1h) — surgical fixes + named regression tests.
2. **P5** (~½ day) — self-contained UI/backend snapshot work with exact spec.
3. **P1** (1-2 days) → **P2** (1 day) → **P3** (2 days) → **P4** (opportunistic).

Every phase lands green under the validation bar above before the next starts; report after each phase with what shipped, what was skipped, and the recommended next chunk.
