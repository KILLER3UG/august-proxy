# August improvements — evidence-based proposals from three harnesses

**Date:** 2026-10-22. **Research only** — nothing in this document has been
implemented, and no August source was modified to produce it.

**Sources.** Three repos, shallow-cloned read-only into
`%LOCALAPPDATA%\Temp\harness-research\`, never built and never executed:

| Repo | Commit | Tracked files | Shards read |
|---|---|---|---|
| `github.com/earendil-works/pi` (MIT) | `58c0b02` | 1 987 | 17 / 17 |
| `github.com/Arcachofo/SimulIDE-dev` (AGPLv3) | `a7d9fc9` | 1 359 | 10 / 10 |
| `github.com/deepseek-ai/deepseek-harness` (MIT) | `687f282` | 16 297 | see `STATUS.md` |

Every proposal below was checked against **`docs/research/august-baseline.md`**
first, so that nothing August already does is proposed back, and so that a
knob which is *declared but off* is described as off rather than as present.
The consolidated raw material is `docs/research/IDEAS.md` (every "ideas worth
stealing" extracted from every shard report, with its `file:line`).

**Verdict vocabulary.** **ADOPT** — do it, as described. **ADAPT** — do it, but
the shape has to change to fit August. **SKIP** — do not do it; the reason is
recorded, because a rejected idea with a stated reason is worth as much as an
adopted one.

---

## The five I would implement first, in order

These are ranked, not listed. The order is the recommendation.

| # | Proposal | Source | Effort | Why now |
|---|---|---|---|---|
| **1** | **The tool array must be append-only, and the model must be told when it changes** | DSH + pi (**convergent**) | M | The tool array is **6 911 tok — 3× the system prompt** and is the single largest cost in the harness. Today it is re-sorted by name and re-derived by BM25 *every round*, so it can change without the model, and the model is never told. |
| **2** | **A liveness signal that counts progress, not just pings** | DSH | S–M | A wedged tool shows a live heartbeat for **300 s**; a stalled upstream shows a keepalive that carries no information. The user cannot tell "slow" from "wedged". |
| **3** | **A memory delta in the tail, so a fact written this turn is visible this turn** | DSH + pi (**convergent**) | M | The single most-cited weak spot. The BM25 lane is **off by default** and the boot index is **frozen per session** and capped at 40 facts, so a fact the model just wrote is invisible to it. |
| **4** | **A token-budgeted, legal compaction cut — and a summariser that can read the plan** | pi | M | The cut is a **fixed 4 messages** regardless of window, and the shipped deterministic summariser writes literally `Key decisions: (uncaptured)` / `Next: (uncaptured)`. |
| **5** | **Model-authored dictionaries get a null prototype and a reserved-key guard** | DSH + pi (**convergent**) | S | August has **no** `__proto__` guard anywhere, in either language, and it round-trips **unknown frontmatter keys** by design. |

**Why this order.** 1 and 3 are the two biggest *costs* in the harness (the
tool array, the context window) and both are cache-shaped, so they compound
every turn rather than once. 2 is the one users feel immediately and it is
cheap. 4 is the next-largest recurring cost and the one with the clearest
defect. 5 is small and prevents a class rather than a bug.

---

# The proposals

## 1. The tool array must be append-only, and the model must be told when it changes

**Verdict: ADOPT.**
**Source:** DeepSeek harness — `apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:142-163`;
pi — `packages/agent/src/agent-loop.ts:342-372` (the same concern, arrived at
independently: DSH solves it at the wire, pi solves it in the transcript).

**Convergence is the signal here.** Two repos, unrelated codebases, both
concluded that *the tool set is a thing the model must be told about and a
thing the provider cache must not be surprised by*.

**What August does today** (from the baseline, verified first-hand):

- `workbench.py:1369` `toolDefinitions` and `:1479` `openaiToolDefinitions`
  build the wire array and then **sort it by name**:
  `tools.sort(key=lambda t: (0 if name in _BARE_TOOL_ALLOW else 1, name))`
  (`:1417-1419`).
- The **base** conversion is cached (`tool_defs_cache.get_or_build`, `:1422`),
  but the **progressive disclosure** runs *outside* that cache:
  `assembleToolDefs` at `:1438` re-ranks by BM25 against the session's own
  messages, on every round.
- The per-model capability profile is applied *after* the sort
  (`_finalize_session_tools`, `:1474`).

**What is already good, and must not be broken:** the downgrade path is
deliberately prefix-preserving. The comment at `:1411-1416` says so: a
self-heal downgrade to the bare surface yields a **prefix** of the full list,
so the Anthropic cache breakpoint on the tools array survives; and `maxTools`
truncation cuts non-essential tools first rather than by registry position.

**The gap.** Two things can still change the array *in the middle*, and both
are silent:

1. **A tool added mid-session** (an MCP server that starts, a skill that
   registers a tool) is name-sorted into the array. A tool named `aaa…` lands
   at the front of the non-bare group and shifts every later tool — the array
   is no longer a prefix extension, and the provider's tool-array cache
   breakpoint is busted.
2. **The BM25 disclosure re-ranks every round.** A tool that fell out of the
   top-k in one round and back in the next moves **position**, not just
   membership. The set is a function of the transcript, so the *array* is a
   function of the transcript — which is exactly the thing a prefix cache
   cannot survive.

And in both cases **the model is never told**. The only signal it gets is a
tool call that now fails, or a `tool_search` that no longer returns the tool
it used last turn.

**The proposed change**

1. **Append, never re-sort.** The order of the tool array becomes a function
   of *the session's tool set*, not of the current round. Once a tool has a
   slot, it keeps it. New tools are appended at the end. A tool that leaves
   the offered set is *removed*, and the removal is announced — never
   reordered in place.
2. **The disclosure result is cached for the session, not recomputed per
   round.** `assembleToolDefs` currently runs outside
   `tool_defs_cache`; it should run inside it, keyed on the session's tool
   set, so the array is stable unless the *set* changes.
3. **When the set changes, say so.** pi's mechanism: a system message
   carrying `toolsAdded` / `toolsRemoved`, inserted or merged into a pending
   system message before the next request (`agent-loop.ts:342-372`). August
   already patches the per-turn tail onto the last user message and strips it
   before persistence, so there is a place to put this that costs no prefix.
4. **Derive the "tools changed" fact from the wire, not from the model.**
   DSH's rule: "a model-chosen extra add/remove cycle changes both sides or
   neither" — the history is computed as the **diff of consecutive request
   headers**, not from call counts. A model that never called a tool still
   gets the honest diff.

**Concrete August files/modules**

- `backend-py/app/services/workbench/workbench.py` — `toolDefinitions` (`:1369`),
  `openaiToolDefinitions` (`:1479`), the sort at `:1417-1419`, the
  `assembleToolDefs` call at `:1438` / `:1554`.
- `backend-py/app/services/workbench/tool_defs_cache.py` — the cache key must
  include the *session's* tool set, not only `tool_registry.generation()`.
- `backend-py/app/services/tools/model_tools.py` — `assembleToolDefs` (`:116`).
- `backend-py/app/services/workbench/loop/prompt.py` — the tail that would
  carry the `toolsAdded`/`toolsRemoved` line.
- `backend-py/app/services/workbench/stream_translate.py` / the SSE schema —
  if the change is surfaced in the UI as well as to the model.

**Expected benefit.** The tool array is **6 911 tok** — the largest single
cost in the harness and 3× the system prompt. A stable, append-only array is
the difference between a provider prefix-cache hit and a miss on *every* turn.
It also removes a class of "the model called a tool that worked last turn and
now doesn't", which is a model-compatibility failure with a misleading
symptom.

**Effort:** M. **Risk:** M — the disclosure cache becomes a correctness
surface (a tool that *should* be re-ranked would not be). Mitigate by keying
the cache on the session's tool set and by keeping the BM25 re-rank as the
thing that *changes the set*, not the order.

**How we would verify it, not just review it.** The **scripted provider**
already exists (`4d457356 feat(bench): a scripted provider, so the loop can be
driven with no API credit`) and the bench harness already measures
`maxConcurrent`. Two assertions:

1. Drive a two-round turn with a transcript long enough to re-rank the
   disclosure, and assert that the `tools` array in round 2 is a **byte-prefix
   of round 1's** plus appended entries — no reordering.
2. Start an MCP server between rounds and assert that the second request
   carries a `toolsAdded` line naming it, and that the provider's
   `cacheReadTokens` for round 2 still covers round 1's prefix.

---

## 2. A liveness signal that counts progress, not just pings

**Verdict: ADOPT.**
**Source:** DeepSeek harness — `packages/api/gateway/src/stream-server.ts:114`
("A liveness signal that counts buffered writes, not just pings") and
`:61` ("Every stream carries a byte-bounded inbox and overflow fails the
stream, not the process").

**What August does today**

- The tool heartbeat fires **every 8 s** whether the tool is alive or wedged:
  `workbench.py:355-357`, emitted at `:5383-5399` as "Still working on X…".
  The real bound is the 300 s `asyncio.wait_for` in `loop/exec.py:203`.
- The 45 s **TTFB watchdog is pre-first-token only** — `clients/base.py:737-748`
  says so in the code: "once any event was yielded, chunk gaps mid-generation
  are never interrupted". A mid-stream stall is therefore bounded only by the
  300 s httpx timeout.
- The 30 s SSE keepalive (`services/event_log.py:197-200`) keeps the
  connection open but **carries no information**, so the client's idle timers
  never fire on a stalled upstream: the user sees activity and no progress.
- The 8 s command beat (`:5327-5354`) warns "may be waiting for interactive
  input" — a good idea, but it fires on a timer, not on evidence.

**The gap.** Three separate "the system is alive" signals, none of which
carries information about *progress*. The result is the worst possible
failure shape: a wedged tool or a stalled gateway looks exactly like slow
work, for five minutes.

**The proposed change**

1. **The heartbeat carries the last observed change.** Not "still working" —
   "no new output for 24 s", with the last output's timestamp and size. The
   *absence of change* becomes the signal, which is the only honest one.
2. **A byte-bounded inbox with a named overflow failure.** A tool that
   produces output faster than the model consumes it needs a hard ceiling and
   a *named* failure, not an unbounded queue (DSH's
   `gateway/uplink-overflow`).
3. **The SSE keepalive carries the same last-change timestamp**, so the client
   can distinguish "alive but slow" from "wedged" without a second channel.
4. **A stalled tool is reported as stalled**, and the 300 s bound becomes a
   *consequence* the user was told about in advance, not a surprise.

**Concrete August files/modules**

- `backend-py/app/services/workbench/workbench.py` — the heartbeat constants
  (`:355-357`) and the two emitters (`:5327-5354`, `:5383-5399`).
- `backend-py/app/services/workbench/loop/exec.py` — the 300 s `wait_for`
  (`:203`) and the per-tool result cap.
- `backend-py/app/services/event_log.py` — the keepalive frame (`:197-200`).
- `backend-py/app/services/workbench/clients/base.py` — the TTFB watchdog
  (`:737-748`).
- `frontend/desktop/src/api/stream.ts` — the 30 s / 120 s idle timers and the
  `WorkingIndicator`.

**Expected benefit.** The user learns the truth in 8 s instead of 300 s, and
the "hanging tool call" weak spot stops being a five-minute silence. It also
gives the runaway backstop a better signal to work with: `_recordWorldDelta`
already distinguishes "new path" from "same call again", and a *stall* is a
third thing it cannot currently see.

**Effort:** S–M. **Risk:** S — a new field on a heartbeat frame, and the
`check:sse` gate will insist the schema and the dispatcher agree (which is
the point).

**How we would verify it.** A tool that sleeps for 90 s with no output must
produce a heartbeat sequence that says *"no new output"* rather than
*"still working"*, and the run must surface a **stalled** marker in the
transcript. A tool that produces output every 5 s must not. Both are
observable in the bench harness with the scripted provider.

---

## 3. A memory delta in the tail, so a fact written this turn is visible this turn

**Verdict: ADAPT.**
**Source:** DeepSeek harness — the projection rules in
`packages/api/session-controller/src/client/sessions/` ("higher-seq-wins for
projections, and a cached value never outranks a connected Host");
pi — `packages/coding-agent/src/core/session-manager.ts`, where the model
context is a **projection computed from the append-only tree**, never a frozen
copy.

**Convergence:** both repos treat the *cached* view as a cache and the
*source* as the truth. August has the source and a cache — but the cache is
never invalidated within a session.

**What August does today**

- The BM25 keyword lane is **off by default** (`memoryAutoInject` default
  `False`, `brain_config_service.py:272`), so in the shipped configuration the
  per-turn `<memory>` block is the **profile lane only**
  (`workbench.py:3150`).
- The **boot memory index is frozen per session** (`workbench.py:968-981`) and
  capped at **40 facts** (`brain.py:757`). It is frozen deliberately, to
  protect the provider prefix cache, and `<memory_policy>` tells the model to
  re-read `list_facts` after writing rather than trusting the index.
- The `<memory>` tail is patched onto the **last user message**
  (`workbench.py:3216-3230`) and stripped before persistence
  (`durability.py:140`).
- A fact written this turn is therefore **invisible to the model** unless it
  calls `list_facts` or `brain_query` — and the model is told to do that
  in prose, which a small model may not do.

**The gap.** The advice in the prompt ("re-read `list_facts`") is a
*substitute* for a mechanism, and August has a mechanism available for free:
the tail already exists, rides the last user message, and is stripped before
persistence — so putting a delta there costs **no prefix cache at all**.

**The proposed change**

1. **The frozen index stays frozen.** The prefix is untouched.
2. **The tail carries a `new:` section**: the facts written *since the
   session opened*, by key and value, in the same shape the model already
   reads. A fact becomes visible in the same turn it was written, with zero
   effect on the cached prefix.
3. **The delta is a projection, not a second store.** It is derived from the
   facts table by a version/sequence number, so it is idempotent and cannot
   disagree with the store. (DSH: "higher-seq-wins for projections, and a
   cached value never outranks a connected Host.")
4. **`memoryAutoInject` stays off by default.** This proposal is about the
   *write* path being visible, not about turning on keyword recall. Turning
   the lane on is a separate decision and a separate proposal.

**Concrete August files/modules**

- `backend-py/app/services/memory_store/fact_retrieval.py` — the block
  builder (`build_memory_block`, `:832`; `build_profile_memory_block`,
  `:755`).
- `backend-py/app/services/workbench/workbench.py` — the tail patch
  (`:3216-3230`), the frozen index (`:968-981`), and the `<memory_policy>`
  text that currently tells the model to re-read instead.
- `backend-py/app/services/memory_store/rest.py` — the fact write path
  (`save_fact`, `:47`) needs to stamp a monotonically increasing version.
- `backend-py/app/services/memory_schema.py` — a `version` column, or reuse
  `updated_at` as the free token the 2026-10-05 gap analysis already
  identified.

**Expected benefit.** The memory weak spot the brief names first is a
*plumbing* problem, not a ranking problem — and this is a plumbing fix. The
model stops having to remember to ask for what it just wrote, which is
exactly the behaviour a small local model will not produce.

**Effort:** M. **Risk:** S — the tail is already the place volatile state
rides, and the delta is derived, so there is no second source of truth.

**How we would verify it.** With the scripted provider: a turn that calls
`remember` and then a second turn that asks for the fact by name. Assert the
fact's key and value appear in the **second request's tail**, that the
**system prompt is byte-identical** across the two turns, and that the
provider's `cacheReadTokens` still covers the prefix.

---

## 4. A token-budgeted, legal compaction cut — and a summariser that can read the plan

**Verdict: ADAPT.**
**Source:** pi —
`packages/coding-agent/src/core/compaction/compaction.ts:446-501` (cut
selection) and `:351-364` (legality).

**What August does today**

- **One** `compressMessages` call site in the whole backend
  (`loop/recovery.py:202`, inside `_compactionCall`), reached by **five**
  paths. That is a strength and it is already shipped.
- The threshold is **token-based** (55 % of the window, `recovery.py:120-131`).
- The **head is a FIXED 4 MESSAGES** (`context_compressor.py:17`
  `DEFAULT_HEAD_COUNT = 4`), not scaled to the window. On a 128k window four
  messages can be a third of the budget; on an 8k window they can be 1 %.
- The **tail** is token-budgeted at 16 % of the window, or count-budgeted
  (6 messages) when the window is unknown — the manual button deliberately
  passes `context_window=0`.
- The middle is split into **tool-pair-safe units** (`_splitUnits`), so a
  result is never orphaned from its call. **This is already the legality rule
  pi implements** — and August has it.
- The shipped summariser is **deterministic** (the LLM compactor is behind
  `llm_compactor`, **default off**), and it literally writes
  `'- Key decisions: (uncaptured)'` (`:641`) and `'## Next\n(uncaptured)'`
  (`:662`).

**The gap, stated honestly.** August already has the *pairing* legality pi
has. What August does **not** have is:

1. a **token-budgeted head** — the fixed 4 is arbitrary with respect to the
   window, and it is the one part of the cut that is not scaled;
2. a summariser that can **capture decisions and next steps at all**.

Point 2 is the bigger one, and it is not solved by switching the LLM compactor
on (that costs an API call on every compaction). It is solved by noticing
that August already *has* the decisions in a machine-readable place: the
`update_state` phase/step transitions, which the deterministic summariser
already scrapes for `Done`/`Blocked`/`In progress`. The decision is what to
do with them.

**The proposed change**

1. **Token-budget the head.** Replace the fixed count with a window-relative
   budget (with the current count as a *floor*, so a short transcript is
   unchanged). The head is what the model reads as "the original ask"; today
   on a large window it is either too small to matter or, after a rotation,
   too large to leave room for the tail.
2. **Make the legality rule explicit and asserted**, rather than implicit in
   `_splitUnits`. pi states it as a rule ("legal means never a `toolResult`")
   and its cut *snaps forward* to the nearest legal point after a token walk.
   August's unit splitter gives the same result, but nothing says so, and
   nothing would catch a regression that broke it.
3. **Let the summariser read the plan.** `update_state` transitions are
   already scraped; make the summariser emit a *decision* and a *next step*
   derived from the **latest** transition and the **failing receipt**, and
   only say `(uncaptured)` when there genuinely was none. A turn that never
   called `update_state` should be *told* to, at the point where it matters
   — not silently compacted into a summary that admits it lost the thread.
4. **Do not turn the LLM compactor on.** It stays behind `llm_compactor`
   (default off) for the cases that want it.

**Concrete August files/modules**

- `backend-py/app/services/workbench/context_compressor.py` —
  `DEFAULT_HEAD_COUNT` (`:17`), `schemaSummarize` (`:533-687`), the
  `(uncaptured)` lines (`:641`, `:662`), `_splitUnits` (`:413-436`).
- `backend-py/app/services/workbench/loop/recovery.py` — `_compactionCall`
  (`:150-220`), `reliefHeadCount` (`:100-107`), the threshold (`:120-131`).
- `backend-py/app/services/workbench/loop/prompt.py` — the
  `update_state` pin predicates.

**Expected benefit.** Compaction is the mechanism that decides how much of the
task survives the boundary. Today the boundary drops decisions and next steps
*by construction* in the shipped configuration. This proposal keeps the
deterministic, free summariser and makes it able to carry the two things
that matter.

**Effort:** M. **Risk:** M — a change to the compaction projection affects
every long session, and the tail is what the model reads.

**How we would verify it.** A scripted compaction over a synthetic transcript
with a known shape: assert (a) the head's share of the window is within the
budget, (b) no tool call is separated from its result across the cut, and
(c) a transcript containing `update_state` transitions yields a summary whose
`Next` is **not** `(uncaptured)`. The bench harness can drive all three with
no API credit.

---

## 5. Model-authored dictionaries get a null prototype and a reserved-key guard

**Verdict: ADAPT** (narrower than the references need it to be — see below).
**Source:** DeepSeek harness —
`packages/acp/acp/src/mcp.ts:82-84`:

> "Valid environment and header names include `__proto__`; a null prototype
> keeps that entry as data instead of invoking Object.prototype's setter."

pi — `packages/chord/src/delta/index.ts:120-131`:

> "`JSON.parse` is safe on its own — it makes `__proto__` an own property.
> What is not safe is `parent[key] = value`, which is exactly what an applier
> does, and paths are data […] Ops arrive from a facet, a plugin compartment,
> or a tool whose details may echo model output, so none of it is trusted
> input."
> `RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])`

**Convergence, and the two repos state the rule differently on purpose.** DSH
*allows* `__proto__` and makes it safe. pi *rejects* it as a path segment.
Both agree the value is untrusted.

**What August does today**

- **No `__proto__`, no `Object.create(null)`, no reserved-key guard, anywhere**
  — verified by grep across `backend-py/app` and `frontend/desktop/src`: zero
  matches for `__proto__`, `Object.create(null)`, `prototype pollution`,
  `SAFE_KEY`.
- The **Python** backend is not exposed to JavaScript prototype pollution
  (`d['__proto__'] = v` on a Python dict is an ordinary key), but August
  **round-trips unknown frontmatter keys by design** — `skill_service.py:370`
  (`meta = {k: v for k, v in frontmatter.items() if k not in known}`) and
  `_renderSkillMd` (`:1151`) write them back out, and the comment at `:386`
  calls this a feature ("M6 item 3 — unrecognized frontmatter survives").
- The **TypeScript** frontend parses model-authored dictionaries with
  `z.record(z.unknown())` (`api/schemas/workbench.ts:19`).

**The honest scoping.** The exposure in August is **narrower** than in the
references: the doors that would carry model-authored *environment* or
*header* names are closed (`mcp-servers.json` is a protected write path), and
the Python side is not affected. The live surfaces are the frontend's
`z.record` parse and the frontmatter round-trip.

**The proposed change**

1. **Parse model-authored dictionaries with a null prototype** where the
   result is used as a map — `Object.create(null)` in the frontend, and a
   dict-with-no-`__proto__` convention in Python where the value is later
   serialised into JS.
2. **Keep the round-trip.** Do **not** start rejecting unknown frontmatter
   keys — that would break a documented feature. Make the round-trip safe
   instead, which is DSH's choice rather than pi's: allow the key, keep it
   as data, never let it reach a prototype chain.
3. **Add the reserved-segment list** to the one place in August where a
   *path* is data: the skill/project-memory entry names and the artifact
   path maps.

**Concrete August files/modules**

- `frontend/desktop/src/api/schemas/workbench.ts` — the `z.record` schema
  (`:19`).
- `backend-py/app/services/skill_service.py` — `_parse_frontmatter_block`
  (`:404`), the unknown-key round-trip (`:370`), `_renderSkillMd` (`:1151`).
- `backend-py/app/services/memory_store/kv.py` and
  `backend-py/app/services/project_memory.py` — the key-shaped stores.

**Expected benefit.** Small, but it is a *class* fix, and August writes
model-authored content into JSON stores by design.

**Effort:** S. **Risk:** S.

**How we would verify it.** A skill whose frontmatter contains
`__proto__:` and `constructor:` must round-trip to the file and back without
ever touching a prototype, and a crafted SSE frame carrying a `__proto__` key
must not alter the parsed object's prototype.

---

# Considered and rejected

Recorded with the reason, because these are the ideas a later reader would
otherwise re-propose.

| Idea | Source | Why rejected |
|---|---|---|
| **A tool call cut off by the output-token limit is failed, never executed** | pi `agent-loop.ts:274-279` | **ALREADY SHIPPED.** August's length-stop fails the whole tool batch at `workbench.py:4661`, and a truncated generation's tool calls all fail unexecuted. This was already checked in the 2026-10-21 round and recorded in `docs/ROADMAP.md:955`. |
| **Provider-boundary repair of a torn history** | pi `transform-messages.ts:180-256` | **ALREADY SHIPPED** — `workbench/message_pairing.py`, applied at the three workbench seams (`docs/ROADMAP.md:966`, commit `d1e1744c`). |
| **A merge contract for the summariser prompt, and a file-op ledger across compaction** | pi `compaction.ts:540-575` | **ALREADY SHIPPED** — `schemaSummarize` folds prior notes into Context with carried `<read-files>` tags stripped, and keeps the ledger, deterministically and with no extra LLM call (`docs/ROADMAP.md:969`). |
| **Parallel tool execution with two orders** | pi `agent-loop.ts:640-670` | **ALREADY SHIPPED** — `chat_stages.run_regular_tools_stage` gathers a batch when every call is on `parallel_tools.PARALLEL_SAFE_TOOLS` and runs it serially if any call mutates. Measured through the bench harness (`docs/ROADMAP.md:970`, commit `1f67fb0e`). |
| **Circuits as fixtures (a folder of decks that asserts itself)** | SimulIDE `batchtest.cpp:20-58` | **ALREADY SHIPPED** — `circuit_batch_test` walks a folder of decks and asserts each deck's own `* expect v(out) ~= 5.0 ±0.05` cards (`docs/ROADMAP.md:967`, commit `60a55a5e`). |
| **Change-sampled `(value, simTime)` circular buffers** | SimulIDE `plotbase.cpp:28` | **ALREADY SHIPPED** — `_signal_edges` change-samples a trace off the full run, with a digital lane gated on a real swing (`docs/ROADMAP.md:968`, commit `48eefe1c`). |
| **The MCU as an XML data file read at load** | SimulIDE `mcucreator.cpp:107,163,447-517` | **PARTIALLY SHIPPED, and the rest is a DECISION, not a defect.** `a534f235 feat(circuit): learn a board variant's rail from the installed core` reads the variant's rail from the installed core. The remaining question — how much of the chip definition to move from `_BOARD_PINS` into a data file — is a product decision the owner has to make, and the shape (a chip is data the tool reads) is already established. |
| **A two-method "accelerator" interface the host installs at runtime** | SimulIDE `angelscript.h:1211-1218` | **SKIP.** Elegant, but August has no hot path that needs a compiled fast path. The *shape* — a tiny optional interface the host installs — is worth remembering if August ever wants a native fast path; the concrete proposal is not. |
| **A marker instruction that lets a fast path and a slow path coexist** | SimulIDE `as_compiler.cpp:132-133` | **SKIP.** Same reason, plus it needs an intermediate representation August does not have. |
| **Compile-time feature removal, not runtime guarding** | SimulIDE `as_config.h:77` | **SKIP.** It presumes a build matrix per configuration. August ships one desktop build; a runtime capability profile (`loop/surface.py`) is the right shape for it. |
| **The build configuration as a queryable runtime string** | SimulIDE `as_scriptengine.cpp:73-128` | **ADOPT-LATER, not now.** The idea is right — one line that says exactly which features, paths and models were in effect — and August is close (`enforcement_report()`), but it is a diagnostics feature, not a weak spot. Noted, not proposed. |
| **Every diagnostic as a named constant in one file** | SimulIDE `as_texts.h:40+` | **PARTLY ADOPTED ALREADY.** August has the eight-family error taxonomy in `app/services/error_families.py`, which is the same idea, and it is a *closed allowlist* with the documented failure mode: a new denial spelling that is not in the table reads as success. Extending the table to every emitter is a real task, but it is a known, recorded risk rather than a new discovery. |
| **A vendored dependency's licence file says it was modified** | SimulIDE `src/angel/src/COPYING:31-34` | **SKIP as a proposal; KEEP as a practice.** August vendors nothing it has forked. The practice is already in `AGENTS.md`'s spirit. |
| **A garbage collector that does bounded work per allocation** | SimulIDE `as_gc.h:78-94` | **SKIP.** August's memory is SQLite with explicit lifetimes; there is no cycle to collect and no allocation hot path. |
| **Reference counting split into "the engine owns it" and "someone outside holds it"** | SimulIDE `as_typeinfo.cpp:44-45` | **SKIP.** August's stores are process-lifetime and its connections are thread-local; the two-counter distinction has no consumer. |
| **pi's durable harness** | pi `packages/durable/` | **SKIP — deliberately.** It self-describes as experimental, "the API changes without notice", and admits "this is not exactly-once execution", and `pi-coding-agent` **does not depend on it at all**. August's crash story is the interrupted-turn marker, and that is a better trade for a product that must not surprise its user. This was recorded in the 2026-10-21 round and has not changed. |
| **pi's `ToolExposure` five-way split (`direct|model-only|codemode|deferred|hidden`)** | pi | **SKIP.** It hides a tool by projecting its name out of the transcript's tool deltas, so the tool **stays callable**. August's stated rule is the opposite — *enforcement is the deny set, not the withheld surface* (`subagent.py:316`). Copying the projection trick for *display* only would be defensible; copying it as a permission model would be a security regression. |
| **`context_edit` as a rewrite primitive** | pi `session-manager.ts` | **SKIP.** August's transcript is append-only **and archived**; omission deltas would be a second source of truth for "what was really sent", which is exactly the property the archive exists to protect. |
| **pi's cache warmer (refresh at 90 % TTL when expected savings ≥ $0.05)** | pi | **SKIP.** August's pricing is per-model `priceForModel` and models no provider TTL. There is nothing to warm against. |
| **A prompt-cache TTL warmer for the Anthropic path** | — | **SKIP.** Same reason, stated by the 2026-10-21 round. August's cache discipline is *prefix stability*, which proposal 1 attacks directly and far more cheaply. |
| **The dense N×N matrix with unpivoted Crout, and the fixed-point companion iteration** | SimulIDE `circmatrix.cpp:22-35` | **SKIP — and do not regress.** ngspice does trapezoid/Gear with truncation control. August delegates solving to ngspice and must not regress. |
| **The solver's discarded `isOk`** | SimulIDE `simulator.cpp:66-74` | **SKIP — this is the failure mode to avoid, not to copy.** A solver whose silence looks like an answer is precisely what August's `circuit_simulate` lint and SOA warnings exist to prevent. |
| **`uint64` picosecond absolute time with integer `time/m_steps`** | SimulIDE `e-reactive.cpp:92-97` | **SKIP.** A rewind-on-past-event and a zero-delay hazard. SimulIDE's own one-event-per-element guard is a *mitigation* for a design August should not adopt. |
| **The vendored AngelScript + x86-64 JIT** | SimulIDE `src/angel/` | **SKIP.** A whole compiler is a scale August has not chosen, and the AGPLv3 licence means the code is not vendorable regardless. |
| **The `QtConcurrent` sim thread racing GUI reads** | SimulIDE | **SKIP — this is the failure mode.** `src/` contains zero `QMutex|std::mutex` hits while the sim runs on a `QtConcurrent` thread. August's durability barriers and thread-local connections are the answer to the same problem. |
| **One `QGraphicsScene` per circuit and 18 `::self()` singletons** | SimulIDE | **SKIP.** One circuit per process does not scale to a multi-session desktop app. |
| **`rev=` as a build date rather than a schema version** | SimulIDE | **SKIP — and keep away.** Anything August persists must be readable across versions; a build date in a saved file is a lesson, not a mechanism. |
| **The whole AngelScript fast-path/slow-path handoff protocol** | SimulIDE `as_jit.cpp:738-741` | **SKIP.** The handoff shape (one small, explicit, versioned struct) is a good idea for any resume-able execution, but August has no such execution to resume. |

---

# What I did not propose, and why

Some of the most interesting findings in the three repos are **not**
August improvements, and it is worth saying so explicitly rather than letting
them look like omissions.

- **August's security model is stronger than both references in the areas
  that matter.** pi has **no approval gate anywhere in the core** by design
  (`SECURITY.md`: "pi runs with the user's own permissions; containerize it
  if you need more"), and **no read-before-edit gate** (verified as an
  absence). SimulIDE has a **soft** sandbox posture in a different sense —
  zero mutexes in `src/` while the sim runs on a `QtConcurrent` thread. August's
  deny-set enforcement, seven listing doors, hardline shell policy and
  transport-level credential scrub are all stronger. **Do not "simplify"
  toward either reference.**
- **August's turn-outcome ledger is better than either reference.** `turn_end
  {reason, rounds, error}` on every turn, persisted on `turn_outcomes`, is the
  best operability decision in the repo, and neither reference has anything
  like it. pi has a turn bound only in its experimental `durable` package, and
  SimulIDE has no concept of one.
- **August's compaction *architecture* is better than pi's.** One
  `compressMessages` call site reached by five paths, reconciled by a census
  rather than by trust, is a stronger design than pi's per-caller compaction
  hooks. The proposals above change the *cut rule* and the *summariser*, not
  the architecture.
- **August's SSE gate is stronger than anything the references have.**
  `check:sse` *discovers* the emitter set by scanning for `emit(` calls rather
  than listing it by hand, and it checks **handler supply** — a comment-only
  handler body does not count. A hand-written emitter list is exactly how a
  frame once hid; both references would benefit from the same gate.
- **DSH's plugin/everything-is-a-plugin architecture and its `dsh` client
  plugin ecosystem** are not proposals for August. August's tool registry,
  skill layer and MCP door are a different and more constrained shape, and
  the brief's goal is a minimalist desktop app, not a plugin platform.
