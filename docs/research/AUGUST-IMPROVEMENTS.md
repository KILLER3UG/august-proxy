# August improvements — evidence-based proposals from three harnesses

**Date:** 2026-10-22, updated 2026-10-23. **Research first, then shipped** —
each proposal was written against the baseline before any August source
changed; the ones that have since shipped carry a **Shipped** note naming what
changed and what remains open.

**Sources.** Three repos, shallow-cloned read-only into
`%LOCALAPPDATA%\Temp\harness-research\`, never built and never executed:

| Repo | Commit | Tracked files | Shards read | Coverage |
|---|---|---|---|---|
| `github.com/earendil-works/pi` (MIT) | `58c0b02` | 1 987 | 17 / 17 | 1 962 read · 25 skipped · **0 unresolved** |
| `github.com/Arcachofo/SimulIDE-dev` (AGPLv3) | `a7d9fc9` | 1 359 | 10 / 10 | 1 348 read · 11 skipped · **0 unresolved** |
| `github.com/deepseek-ai/deepseek-harness` (MIT) | `687f282` | 16 297 | 88 / 88 | 16 139 read · 158 skipped · **0 unresolved** |

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

This is a ranking, not a list. The order is the recommendation, and it is the
order I would ship them in.

| # | Proposal | Source | Effort | Why this position |
|---|---|---|---|---|
| **1** | **The tool array is the tool list. Stop duplicating it in the prompt, and stop re-ordering it.** | DSH + pi (**convergent**) | M | The tool array is **6 911 tok — 3× the system prompt** and the single largest cost in the harness. Today it is name-sorted and re-derived by BM25 *every round*, the prompt duplicates it as a name index, and the intake line points the model at that index for "details" that are not there. |
| **2** | **Injected content must reach the model verbatim; the caller owns the framing.** | DSH | S–M | DSH recorded a model **refusing** a `<steering>` instruction because the XML tag made it look like third-party metadata. August's prompt is built from twenty-odd XML tags, and the same failure would be invisible. |
| **3** | **A liveness signal that counts progress, not just pings.** | DSH | S–M | A wedged tool shows a live heartbeat for **300 s**; a stalled upstream shows a keepalive that carries no information. The user cannot tell "slow" from "wedged". |
| **4** | **A memory delta in the tail, so a fact written this turn is visible this turn.** | DSH + pi (**convergent**) | M | The weak spot the brief names first. The BM25 lane is **off by default** and the boot index is **frozen per session** and capped at 40 facts, so a fact the model just wrote is invisible to it. |
| **5** | **A token-budgeted, legal compaction cut — and a summariser that can read the plan.** | pi | M | The cut is a **fixed 4 messages** regardless of the window, and the shipped deterministic summariser literally writes `Key decisions: (uncaptured)` / `Next: (uncaptured)`. |

**Why this order.** 1 and 2 are the two places where August pays on **every
turn** — the tool array and the injected blocks — and 2 is cheap. 3 is the one
users feel immediately. 4 is the largest recurring *correctness* gap. 5 is the
next-largest recurring cost and the one with the clearest defect.

Three further proposals follow in §7–§9 (the tool-failure verdict, the
delegation contract, and the output-limit notice). They are real and cheap,
but each is smaller than the five above, and two of them are "close a hole in
a table" rather than "fix a mechanism".

---

# 1. The tool array is the tool list

**Verdict: ADOPT.**
**Sources:** DeepSeek harness —
`apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:142-163`,
`packages/core/system-prompt/src/index.ts:674` (`orderTools`),
`packages/core/agent-loop/src/runtime-context.ts:88`;
pi — `packages/agent/src/agent-loop.ts:342-372`.

**Convergence is the signal.** Two unrelated codebases concluded the same
three things: *the tool order must be canonical*, *a tool that changes must be
appended and the change must be logged*, and *the model must be told*.

**What August does today** (baseline-verified first-hand):

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
- **The prompt duplicates the list.** `build_capabilities_block(tool_names, …)`
  (`:1111`) puts a **name index** of every offered tool into `<capabilities>` —
  and the intake line at `:1019` tells the model
  `- Tools: {N} registered this turn (details in <capabilities>).`
  **`<capabilities>` contains no details** — the schemas are in the wire `tools`
  array the model already receives. The line points at a place where the
  promised thing is not.

**What is already good, and must not be broken.** The downgrade path is
deliberately prefix-preserving — the comment at `:1411-1416` says so: a
self-heal downgrade to the bare surface yields a **prefix** of the full list,
so the Anthropic cache breakpoint on the tools array survives; and `maxTools`
truncation cuts non-essential tools first rather than by registry position.
pi's own rule is the same: `orderTools` canonicalises the order so
"registering `zulu, alpha, mike` in any order produces the same header and the
same dispatched request".

**The gap.** Three things can still change the array *in the middle*, and all
three are silent:

1. **A tool added mid-session** (an MCP server that starts, a skill that
   registers one) is name-sorted into the array. A tool named `aaa…` lands at
   the front of the non-bare group and shifts every later tool — the array is
   no longer a prefix extension, and the provider's tool-array cache
   breakpoint is busted.
2. **The BM25 disclosure re-ranks every round.** A tool that fell out of the
   top-k in one round and back in the next moves **position**, not just
   membership. The array is a function of the transcript, which is exactly
   what a prefix cache cannot survive.
3. **The prompt carries a second copy** of the list, and misdescribes it.

And in every case **the model is never told**. The only signal it gets is a
tool call that now fails, or a `tool_search` that no longer returns the tool
it used last turn.

**The proposed change**

1. **Append, never re-sort.** The order of the tool array becomes a function
   of *the session's tool set*, not of the current round. Once a tool has a
   slot it keeps it; new tools are appended at the end; a tool that leaves is
   removed and the removal is announced, never reordered in place.
2. **The disclosure result is cached for the session**, not recomputed per
   round — `assembleToolDefs` currently runs outside `tool_defs_cache`; it
   should run inside it, keyed on the session's tool set, so the array is
   stable unless the *set* changes.
3. **Delete the duplicate.** The `<capabilities>` **tool** index goes; the
   schemas are already in the wire array. Keep the *skill* index (skills are
   not in the wire array) and fix the intake line to say what is true.
4. **When the set changes, say so.** pi's mechanism: a system message carrying
   `toolsAdded` / `toolsRemoved`, merged into a pending system message before
   the next request (`agent-loop.ts:342-372`). August already patches the
   per-turn tail onto the last user message and strips it before persistence,
   so there is a place to put this that costs no prefix.
5. **Derive the "tools changed" fact from the wire, not from the model.** DSH's
   rule: the registry history is computed as the **diff of consecutive request
   headers** — "a model-chosen extra add/remove cycle changes both sides or
   neither" — not from call counts.

**Concrete August files/modules**

- `backend-py/app/services/workbench/workbench.py` — `toolDefinitions` (`:1369`),
  `openaiToolDefinitions` (`:1479`), the sort (`:1417-1419`), the
  `assembleToolDefs` calls (`:1438`, `:1554`), the `<capabilities>` block
  (`:1092-1126`), the intake line (`:1019`).
- `backend-py/app/services/workbench/tool_defs_cache.py` — the cache key must
  include the *session's* tool set, not only `tool_registry.generation()`.
- `backend-py/app/services/tools/model_tools.py` — `assembleToolDefs` (`:116`).
- `backend-py/app/services/capabilities_prompt.py` — `build_capabilities_block`
  and `format_skill_index` (`:376`).
- `backend-py/app/services/workbench/loop/prompt.py` — the tail that would
  carry the `toolsAdded`/`toolsRemoved` line.

**Expected benefit.** The tool array is **6 911 tok** — the largest single
cost in the harness, 3× the system prompt. A stable, append-only array is the
difference between a provider prefix-cache hit and a miss on *every* turn.
Deleting the `<capabilities>` tool index removes a second, redundant copy of
the same list from every request and removes a prompt line that points the
model at a place with no details.

**Effort:** M. **Risk:** M — the disclosure cache becomes a correctness
surface. Mitigate by keying it on the session's tool set and by keeping the
BM25 re-rank as the thing that *changes the set*, not the order.

**How we would verify it, not just review it.** The **scripted provider**
already exists (`4d457356`) and the bench harness already measures
`maxConcurrent`. Three assertions:

1. Drive a two-round turn with a transcript long enough to re-rank the
   disclosure, and assert the `tools` array in round 2 is a **byte-prefix of
   round 1's** plus appended entries — no reordering.
2. Start an MCP server between rounds; assert the second request carries a
   `toolsAdded` line naming it, and that the provider's `cacheReadTokens` for
   round 2 still covers round 1's prefix.
3. **The assertion DSH uses, verbatim in spirit**
   (`apps/web/tests/chat-continuous-conversation.e2e.ts:341-342`): *"a prefix
   that must stay cache-stable must be asserted as stable."* Assert the
   request header is byte-identical across twelve turns.

**Shipped (2026-10-23), in part.** The discovery catalog now retains the
registration keywords that provider-format conversion had dropped, and ranks
against schema property descriptions and enum values as well as names. This
improves finding a deferred capability by what it accepts and does. Session
tool ordering is append-stable (`_applySessionStableOrder`), so a new tool
does not re-sort existing names; a runtime-only tail now names additions and
removals on the next turn. The main prompt's duplicate tool-name index is gone;
the `<capabilities>` block keeps category/safety guidance and the skill index.

---

# 2. Injected content must reach the model verbatim; the caller owns the framing

**Verdict: ADAPT.**
**Source:** DeepSeek harness —
`.agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.md:19`
(an implemented Agent Note).

**The note, in full.** Two families of injected session content were rendered
into the model transcript wrapped in XML envelopes — `steering/message` as
`<steering source="…">…</steering>` and `context/message` as
`<context source="…">…</context>`. The envelopes aimed to tell the model "this
is injected, not the user speaking". The recorded failure:

> "**No model is trained on these tags.** `<steering>` and `<context>` are
> arbitrary markup no model was taught to read, so the framing adds tokens
> without a reliable effect and can actively mislead — recorded transcripts
> show a model treating a `<steering>` instruction as third-party metadata
> **and refusing it** while answering only the original prompt." (`:14`)

And the second half of the decision:

> "**The session surface is the wrong layer for framing.** The surface
> projects the durable log into the model transcript; deciding how content is
> worded is not its job. A caller that wants a particular frame formats its own
> content before injecting it." (`:15`)

The consequence they accepted: "Mid-turn steering and injected context reach
the model with the same weight as an ordinary user prompt." (`:33`)

**What August does today.** August's system prompt is assembled from
twenty-odd XML-tagged blocks — `<core>`, `<completion_checklist>`, `<intake>`,
`<harness_guide>`, `<workspace>`, `<aug_directives>`, `<session>`, `<agent>`,
`<capabilities>`, `<clarify_policy>`, `<bulk_tools>`, `<web_research>`,
`<memory_policy>`, `<effort>`, `<model_handoff>`, `<tool_protocol>`,
`<agent_mode>` — and the per-turn tail adds `<memory>`, `<relevant_skills>`,
`<workspace_map>`, `<plan_state>`, `<session_state>`, `<memory_nudge>`.

August's tags are **not** arbitrary in the same way DSH's were: they are
*section headers inside one prompt*, not per-message envelopes, and the
content between them is the harness speaking to the model. That is a
different shape, and the proposal has to respect the difference. But two
things carry over exactly:

1. **The tail blocks are injected content riding a user message.**
   `<memory>…</memory>` is appended to the **last user message**
   (`workbench.py:3216-3230`). A model that reads the tag as "quoted
   third-party content" will discount the memory — and August's whole answer
   to "memory that actually remembers" depends on that block being read.
2. **August's own note in the baseline says the tag is not the only thing
   keeping the prefix stable** — the `<session>` block was deliberately
   emptied of volatile state, and the tail was moved off the system prompt
   *precisely* so the prefix would stay byte-stable. The framing question was
   never asked.

**The proposed change**

1. **The tail blocks keep their names; the *content* stops being wrapped.**
   `<memory>` becomes a short, plain header line ("Relevant memory:") followed
   by the entries, or — better — the entries alone, in the same shape the
   model already reads elsewhere. The framing is the producer's, which is
   DSH's rule.
2. **The system-prompt section headers are a separate question and are not
   touched here.** A section header inside one prompt is not a per-message
   envelope, and removing them would cost the prompt's readability for no
   recorded benefit. **This proposal is about the tail, not the prompt.**
3. **A measurement, not an opinion.** DSH did not guess: they had a recorded
   transcript of a model refusing a steering instruction, and they re-recorded
   the ACP snapshots because "the old recordings captured the model refusing
   steering as third-party metadata, the fix's exact failure mode" (`:35`).
   August should do the same: a scripted-provider fixture that puts a memory
   fact in the tail and asks for it, plus a real-model run, and see whether
   the model reads the block.

**Concrete August files/modules**

- `backend-py/app/services/workbench/loop/prompt.py` — the tail assembly
  (`:3007-3229`) and the tail markers.
- `backend-py/app/services/memory_store/fact_retrieval.py` — the `<memory>`
  block builder (`build_memory_block`, `:832`; `build_profile_memory_block`,
  `:755`).
- `backend-py/app/services/capabilities_prompt.py` — `<relevant_skills>`
  (`:539`).
- `backend-py/app/services/workbench/workbench.py` — the `<memory_policy>`
  text (`:940-957`).

**Expected benefit.** The memory tail becomes something the model reliably
reads, which is the precondition for proposal 4 working. And the "no model is
trained on these tags" argument is the same argument that removes the
`<capabilities>` duplicate in proposal 1.

**Effort:** S–M. **Risk:** S — the tail is already the place volatile state
rides, and the change is a re-shape of one block.

**How we would verify it.** A scripted-provider fixture: a turn that writes a
fact, then a turn that asks for that fact by name, with the memory block
present in the tail. Assert the model-facing text no longer wraps the entries
in a tag, and — on a real model — that the answer uses the fact. A/B the two
prompt shapes.

---

# 3. A liveness signal that counts progress, not just pings

**Verdict: ADOPT.**
**Source:** DeepSeek harness — `packages/api/gateway/src/stream-server.ts:114`
("A liveness signal that counts buffered writes, not just pings") and `:61`
("Every stream carries a byte-bounded inbox and overflow fails the stream, not
the process").

**What August does today**

- The tool heartbeat fires **every 8 s** whether the tool is alive or wedged:
  `workbench.py:355-357`, emitted at `:5383-5399` as "Still working on X…".
  The real bound is the 300 s `asyncio.wait_for` in `loop/exec.py:203`.
- The 45 s **TTFB watchdog is pre-first-token only** — `clients/base.py:737-748`
  says so in the code: "once any event was yielded, chunk gaps mid-generation
  are never interrupted". A mid-stream stall is bounded only by the 300 s
  httpx timeout.
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
   consequence the user was told about in advance, not a surprise.

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
gives the runaway backstop a better signal: `_recordWorldDelta` already
distinguishes "new path" from "same call again", and a *stall* is a third
thing it cannot currently see.

**Effort:** S–M. **Risk:** S — a new field on a heartbeat frame, and
`check:sse` will insist the schema and the dispatcher agree (which is the
point).

**How we would verify it.** A tool that sleeps for 90 s with no output must
produce a heartbeat sequence that says *"no new output"* rather than
*"still working"*, and the run must surface a **stalled** marker in the
transcript. A tool that produces output every 5 s must not. Both are
observable in the bench harness with the scripted provider.

**Shipped (2026-10-23), in part.** The heartbeats carry `elapsedSec`, and the
command path also `idleSec`; the live status line appends "no output for Ns"
(or "Ns elapsed" where no output flow exists) once the evidence passes the
stall hint. The SSE keepalive carries `lastEventAt`, `lastSeq` and `idleSec`,
so a live but quiet session is distinguishable from one that has not changed.
Each subscriber inbox is bounded by both event count and encoded bytes; on
overflow the server sends a named `stream_overflow` notice, closes that stream,
and gives the client the cursor from which to replay. The hard tool-timeout path
now emits `status: stalled` on its tool result; the transcript preserves that
status and opens the tool row with a warning label. The failure receipt remains
an error for the model and durable tool-result accounting.

---

# 4. A memory delta in the tail, so a fact written this turn is visible this turn

**Verdict: ADAPT.**
**Sources:** DeepSeek harness — the projection rules in
`packages/api/session-controller/src/client/sessions/` ("higher-seq-wins for
projections, and a cached value never outranks a connected Host"); pi —
`packages/coding-agent/src/core/session-manager.ts`, where the model context
is a **projection computed from the append-only tree**, never a frozen copy.

**Convergence:** both repos treat the *cached* view as a cache and the
*source* as the truth. August has the source and a cache — but the cache is
never invalidated within a session.

**What August does today**

- The BM25 keyword lane is **off by default** (`memoryAutoInject` default
  `False`, `brain_config_service.py:272`), so in the shipped configuration the
  per-turn `<memory>` block is the **profile lane only** (`workbench.py:3150`).
- The **boot memory index is frozen per session** (`workbench.py:968-981`) and
  capped at **40 facts** (`brain.py:757`). It is frozen deliberately, to
  protect the provider prefix cache, and `<memory_policy>` tells the model to
  re-read `list_facts` after writing rather than trusting the index.
- The `<memory>` tail is patched onto the **last user message**
  (`workbench.py:3216-3230`) and stripped before persistence
  (`durability.py:140`).
- A fact written this turn is therefore **invisible to the model** unless it
  calls `list_facts` or `brain_query` — and the model is told to do that in
  prose, which a small model may not do.

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
  builder (`build_memory_block`, `:832`; `build_profile_memory_block`, `:755`).
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

**Shipped (2026-10-23).** `build_memory_delta_block` appends a plain
`new in memory since this chat opened:` section to the tail for facts whose
`updated_at` is newer than the session's creation stamp. It is a live
projection over the facts table — no cursor, no second store — so an UPDATE to
an old key is delivered like a new write, a retired fact cannot reappear, and
a key the recall lane already rendered is skipped. A bad session stamp
returns nothing rather than dumping the store. Probe: a pre-session fact stays
out, a fresh write appears, an update appears, a retired row does not, and an
excluded key drops. Not yet measured: a real-model turn reading the fact
without calling `list_facts`.

---

# 5. A token-budgeted, legal compaction cut — and a summariser that can read the plan

**Verdict: ADAPT.**
**Source:** pi —
`packages/coding-agent/src/core/compaction/compaction.ts:446-501` (cut
selection) and `:351-364` (legality). DeepSeek harness — the same rule as a
*seam*: `packages/compaction/` owns the "tool-pairing boundary helpers" and
the `compact-checkpoint` marker, and the shipped backend uses a
**bracket-first region transaction**.

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
  pi and DSH implement** — August has it.
- The shipped summariser is **deterministic** (the LLM compactor is behind
  `llm_compactor`, **default off**), and it literally writes
  `'- Key decisions: (uncaptured)'` (`:641`) and `'## Next\n(uncaptured)'`
  (`:662`).

**The gap, stated honestly.** August already has the *pairing* legality. What
it does **not** have is:

1. a **token-budgeted head** — the fixed 4 is arbitrary with respect to the
   window, and it is the one part of the cut that is not scaled;
2. a summariser that can **capture decisions and next steps at all**.

Point 2 is the bigger one, and it is not solved by switching the LLM compactor
on (an API call on every compaction). It is solved by noticing that August
already *has* the decisions in a machine-readable place: the `update_state`
phase/step transitions, which the deterministic summariser already scrapes for
`Done`/`Blocked`/`In progress`. The decision is what to do with them.

**The proposed change**

1. **Token-budget the head.** Replace the fixed count with a window-relative
   budget (with the current count as a *floor*, so a short transcript is
   unchanged). The head is what the model reads as "the original ask"; today
   on a large window it is either too small to matter or, after a rotation,
   too large to leave room for the tail.
2. **Make the legality rule explicit and asserted**, rather than implicit in
   `_splitUnits`. pi states it as a rule ("legal means never a `toolResult`")
   and its cut *snaps forward* to the nearest legal point after a token walk;
   DSH brackets the region by its boundaries before cutting. August's unit
   splitter gives the same result, but nothing says so, and nothing would
   catch a regression that broke it.
3. **Let the summariser read the plan.** `update_state` transitions are
   already scraped; make the summariser emit a *decision* and a *next step*
   derived from the **latest** transition and the **failing receipt**, and
   only say `(uncaptured)` when there genuinely was none. A turn that never
   called `update_state` should be *told* to, at the point where it matters —
   not silently compacted into a summary that admits it lost the thread.
4. **Do not turn the LLM compactor on.** It stays behind `llm_compactor`
   (default off) for the cases that want it.

**Concrete August files/modules**

- `backend-py/app/services/workbench/context_compressor.py` —
  `DEFAULT_HEAD_COUNT` (`:17`), `schemaSummarize` (`:533-687`), the
  `(uncaptured)` lines (`:641`, `:662`), `_splitUnits` (`:413-436`).
- `backend-py/app/services/workbench/loop/recovery.py` — `_compactionCall`
  (`:150-220`), `reliefHeadCount` (`:100-107`), the threshold (`:120-131`).
- `backend-py/app/services/workbench/loop/prompt.py` — the `update_state`
  pin predicates.

**Expected benefit.** Compaction is the mechanism that decides how much of the
task survives the boundary. Today the boundary drops decisions and next steps
*by construction* in the shipped configuration. This proposal keeps the
deterministic, free summariser and makes it able to carry the two things that
matter.

**Effort:** M. **Risk:** M — a change to the compaction projection affects
every long session, and the tail is what the model reads.

**How we would verify it.** A scripted compaction over a synthetic transcript
with a known shape: assert (a) the head's share of the window is within the
budget, (b) no tool call is separated from its result across the cut, and
(c) a transcript containing `update_state` transitions yields a summary whose
`Next` is **not** `(uncaptured)`. The bench harness can drive all three with
no API credit.

**Shipped (2026-10-23), in part.** `## Next` names the loop's own
`phase/step` resume point instead of `(uncaptured)`, and the footer now says
decisions and constraints — not next steps — are the fields the deterministic
compactor does not analyze. The head is token-budgeted too: `COMPACT_HEAD_RATIO`
(10 % of the model window) above a floor of `DEFAULT_HEAD_COUNT` messages, with
the TAIL taken first so a middle unit always survives — a head-first walk let a
large window eat the transcript, leave the tail loop nothing, and return the
input UNCHANGED. Still open: a "Key decisions" line the compactor can honestly
extract — `update_state` carries position, not the rationale a decision
needs.

---

# 6. One frozen shape for every tool failure

**Verdict: ADAPT.**
**Source:** DeepSeek harness — `packages/core/tools/src/index.ts:1917`
(`toolErrorResult`).

> "The content is exactly `Error: <message>`; the structured name/code live
> **beside** it, never in the model-visible text. Unknown tools, throwing
> tools, hostile thrown values, wrapper failures, post-policy failures and
> timeouts all resolve to an `isError` result."

**What August does today.** August's verdict is a **closed prefix allowlist**
(`workbench/tool_protocol.py:69` `RECEIPT_TONE`): `'Error'`,
`'[Validation Error]'`, `'[Blocked]'`, `'Blocked:'`, and the synthetic-result
prefix — plus a second shape rule for `Exit code: N` (`:115`) and a third for
a JSON `ok:false` receipt. `_marker_form` (`:97`) strips one leading
capability tag first.

**The gap is documented by August itself.** The comment at `:73-80` records
the incident: the repeat guardrail's own spelling was not in the vocabulary,
"so every round a blocked tool spent after the 8th failure read as a SUCCESS:
`is_error` False in the ledger, tone 'none' in the transcript, and — the part
that mattered — a fresh world-delta credit that reset the runaway backstop
forever." And `AGENTS.md` states the general rule: *"a marker table has to be
checked against every emitter, not just the ones that inspired it."*

**The proposed change.** Move the verdict from the **text** to a **field**.

1. Every tool result carries a structured `is_error` and a `tone`
   (`failure` | `denial` | `none`) that the **producer** sets. It already
   almost does: `tool_protocol.py:329` computes
   `out['is_error'] = bool(out.get('is_error', False)) or tool_result_failed(text)` —
   the text is a *fallback*, not the authority.
2. The text fallback stays, for the tools that are not under August's
   control (an MCP server, a script) — but it becomes a *secondary* path whose
   misses are logged, so a new emitter that says something unusual shows up as
   a logged miss rather than as a silent success.
3. **The model-visible text is one shape**: `Error: <message>`, with the
   structured code beside it. That is DSH's rule, and it means a denial with a
   capability tag (`[sandbox:seatbelt] Blocked: …`) no longer needs the
   `_marker_form` tag-stripping hack — the tag is metadata, not the verdict.

**Concrete August files/modules**

- `backend-py/app/services/workbench/tool_protocol.py` — `RECEIPT_TONE` (`:69`),
  `_marker_form` (`:97`), `tool_result_failed` (`:171`), the `is_error`
  computation (`:329`), `normalize_tool_result` (`:264`).
- `backend-py/app/services/sandbox/policy.py` — `as_tool_text` (`:122`), the
  second known emitter.
- `backend-py/app/services/tool_registrations/` — the producers that would
  need to set the field.

**Expected benefit.** The failure class August has already been bitten by
becomes structurally impossible rather than table-maintained.

**Effort:** M. **Risk:** M — the verdict feeds the episode miner and the
runaway backstop, so a mistake here is expensive. The mitigation is the
existing ledger: `turn_outcomes.guardrail_classes` and `error_families` will
show a change immediately.

**How we would verify it.** A tool that fails with a message no prefix
matches must still record `is_error: true`. A denial from a *new* emitter
must record `is_error: true` and `tone: 'denial'` without touching the
allowlist. Both are observable in the ledger and in the transcript.

---

# 7. A delegated child must not see the delegation tools — and the prompt must not state a rule the mechanism does not enforce

**Verdict: ADOPT** (two small changes).
**Source:** DeepSeek harness — `packages/bundle/web-app/README.md:60`.

> "The `tool-subagent` and `tool-subagent-fork` rows in those presets **deny**
> the four tools, so a delegated child's scope never lists them."

DSH denies at the **advertisement** level, "rather than at call time … [so]
a delegated child's scope never lists them", and its companion rule is that
"subagent locality is decided by one snapshotted flag, never by names or
lineage" (`packages/sdk/server/src/server.ts:129-147`).

**What August does today, and the two defects this exposes.**

1. **The worker prompt states a rule the mechanism does not enforce.**
   `subagent.py:752` — the worker's system prompt says *"Do not spawn further
   sub-agents."* But `_blocked_tools` (`:105-118`) **offers** the spawn tools
   whenever `may_spawn_children()` is true, and the code comment at `:108-112`
   says that is deliberate: "Subtracting the spawn tools unconditionally made
   `delegation.maxDepth` dead configuration above 1: the child was never
   offered the tool, so the orchestrator's own depth check could not run."
   **So the prompt tells the model one thing and the mechanism does another.**
   August's own rule is that the *mechanism* is the authority — "enforcement is
   the deny set, not the withheld surface" — which means the **prompt** is the
   thing that is wrong.
2. **The deny set carries a name that does not exist.**
   `subagent.py:69` — `_SPAWN_TOOLS = frozenset({'spawn_subagent',
   'spawn_subagents'})`. `'spawn_subagent'` (singular) is **never registered**;
   the tool is `spawn_subagents`. A grep for `'spawn_subagent'` across
   `backend-py/app` returns exactly one hit: the deny set itself. A dead name
   in a *security* table is exactly the defect the repo's own marker-table
   rule exists to catch.

**Shipped (2026-10-23).** Both defects are fixed. `_spawnRule` derives the
worker prompt's spawn sentence from the same `allowedNames` list that filters
its surface, so it permits a spawn exactly when a spawn tool is offered; at
the default `maxDepth=1` the worker text is unchanged. `_SPAWN_TOOLS` now
names only `spawn_subagents` — confirmed against the populated registry (152
tools registered; `spawn_subagents` present, the singular absent), and the
stale "use spawn_subagent instead" docstrings were corrected. The shared
capabilities block's blanket "do NOT spawn further subagents" line was
dropped, because it rendered into worker prompts too and would have
contradicted the new conditional sentence. The advertisement-level narrowing
(change 3) was already true: a child at the depth cap is never offered the
tool. The gate that remained open now exists: `e2e:smoke` checks every name in
`_SUBAGENT_NEVER_TOOLS | _SPAWN_TOOLS` against the POPULATED registry, reports
how many tools it checked, and fails on a name no registry can match (152
tools at the recorded run).

**The proposed change**

1. **Make the prompt and the mechanism agree.** Either the worker prompt
   states the real rule ("you may spawn a sub-agent only if the depth cap
   allows it — here it does / does not"), or the spawn tools join
   `_SUBAGENT_NEVER_TOOLS` and `delegation.maxDepth > 1` becomes a different
   feature (the orchestrator's own depth check, which the comment says it
   runs). **Pick one and make both say it.** A prompt that lies to the model
   is a defect whether the lie is about a rule or about a fact.
2. **Drop the dead name** and add a gate that asserts every name in
   `_SUBAGENT_NEVER_TOOLS` and `_SPAWN_TOOLS` is either a registered tool or an
   explicitly-declared dead name — the same "every emitter must be in the
   table" discipline August already applies to the receipt-tone table.
3. **DSH's advertisement-level denial, adapted.** August's rule is to deny at
   call time (the deny set), which is *stronger* and is right. But the
   *advertised* surface can still narrow: a child at the depth cap should not
   be **offered** the spawn tool, so its schema is smaller and its scope
   unambiguous. DSH's wording — "never lists them" — is about the schema, not
   about the permission, and the two are compatible.

**Concrete August files/modules**

- `backend-py/app/services/workbench/subagent.py` — `_SUBAGENT_NEVER_TOOLS`
  (`:52`), `_SPAWN_TOOLS` (`:69`), `_blocked_tools` (`:105-118`), the worker
  prompt (`:749-757`).
- `backend-py/app/services/tool_registrations/agent_tools.py` — the
  registration, for the gate.
- A new static gate in the shape of `check:sse` — "a name in a denial table
  must be a real tool".

**Expected benefit.** Two small, real defects closed, and the subagent
surface stops advertising a capability the prompt says does not exist.

**Effort:** S. **Risk:** S.

**How we would verify it.** Spawn a worker at `maxDepth = 2` and assert (a)
the tool list it receives does not contain the spawn tool, or that its prompt
says it may spawn, consistently with the mechanism, and (b) the gate fails
when a name is added to a denial table that is not a registered tool.

---

# 8. The output-limit notice should name the recovery verb and promise the earlier output survived

**Verdict: ADOPT.**
**Source:** DeepSeek harness —
`apps/web/tests/expected/max-tokens-notice/history-turn.expected.txt:1-3`:
*"The reply was cut off; earlier output is preserved in the conversation. Send
"continue" to let the model resume."*

**What August does today.** The backend **does** auto-continue: `_MAX_LENGTH_CONTINUATIONS
= 2` (`workbench.py:3321`) with a "continue exactly where you stopped" retry
(`:3319`), and when the budget is spent it tells the *model* "ask for the
rest" (`:4717`). The user is told only this
(`sections/chat/message/AssistantMessageContent.tsx:222-226`):

> "cut off at the output limit — the answer above is incomplete"

**The gap.** The notice tells the user the answer is incomplete and stops
there. It does not say (a) that the earlier output is preserved, or (b) that
there is a word to type to resume. DSH's "the transferable half" is exactly
that: *the contract with the user*.

**The proposed change.** One line, in the same place, saying both: that the
earlier output is preserved in the conversation, and that "continue" resumes
the model. This is the cheapest proposal in this document and it closes a
real hole: a user whose answer was cut off currently has no idea that
"continue" is a thing.

**Concrete August files/modules**

- `frontend/desktop/src/sections/chat/message/AssistantMessageContent.tsx` —
  the notice (`:222-226`).
- `backend-py/app/services/workbench/workbench.py` — the continuation
  mechanics (`:3321`, `:4665-4717`), so the wording matches what the backend
  actually does.

**Effort:** S. **Risk:** S.

**How we would verify it.** A scripted-provider turn that hits the output cap:
assert the transcript shows the recovery verb, and that sending "continue"
resumes.

---

# 9. Model-authored dictionaries get a null prototype and a reserved-key guard

**Verdict: ADAPT** (narrower than the references need it to be).
**Sources:** DeepSeek harness — `packages/acp/acp/src/mcp.ts:82-84`:

> "Valid environment and header names include `__proto__`; a null prototype
> keeps that entry as data instead of invoking Object.prototype's setter."

pi — `packages/chord/src/delta/index.ts:120-131`:

> "`JSON.parse` is safe on its own — it makes `__proto__` an own property. What
> is not safe is `parent[key] = value`, which is exactly what an applier does,
> and paths are data […] Ops arrive from a facet, a plugin compartment, or a
> tool whose details may echo model output, so none of it is trusted input."
> `RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])`

**Convergence, and the two repos state the rule differently on purpose.** DSH
*allows* `__proto__` and makes it safe. pi *rejects* it as a path segment.
Both agree the value is untrusted.

**What August does today.** **No `__proto__`, no `Object.create(null)`, no
reserved-key guard, anywhere** — verified by grep across `backend-py/app` and
`frontend/desktop/src`: zero matches for `__proto__`, `Object.create(null)`,
`prototype pollution`, `SAFE_KEY`.

The **Python** backend is not exposed to JavaScript prototype pollution
(`d['__proto__'] = v` on a Python dict is an ordinary key), but August
**round-trips unknown frontmatter keys by design** — `skill_service.py:370`
(`meta = {k: v for k, v in frontmatter.items() if k not in known}`) and
`_renderSkillMd` (`:1151`) write them back out, and the comment at `:386`
calls this a feature ("M6 item 3 — unrecognized frontmatter survives"). The
**TypeScript** frontend parses model-authored dictionaries with
`z.record(z.unknown())` (`api/schemas/workbench.ts:19`).

**The honest scoping.** The exposure in August is **narrower** than in the
references: the doors that would carry model-authored *environment* or
*header* names are closed (`mcp-servers.json` is a protected write path), and
the Python side is not affected. The live surfaces are the frontend's
`z.record` parse and the frontmatter round-trip.

**The proposed change**

1. **Parse model-authored dictionaries with a null prototype** where the
   result is used as a map — `Object.create(null)` in the frontend.
2. **Keep the round-trip.** Do **not** start rejecting unknown frontmatter
   keys — that would break a documented feature. Make the round-trip safe
   instead, which is DSH's choice rather than pi's: allow the key, keep it
   as data, never let it reach a prototype chain.
3. **Add the reserved-segment list** to the one place in August where a
   *path* is data: skill and project-memory entry names, and the artifact
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

**How we would verify it.** A skill whose frontmatter contains `__proto__:`
and `constructor:` must round-trip to the file and back without ever touching
a prototype, and a crafted SSE frame carrying a `__proto__` key must not alter
the parsed object's prototype.

---

# Considered and rejected

Recorded with the reason, because these are the ideas a later reader would
otherwise re-propose. **Everything in this table was checked against August's
current code first**, and the "already shipped" rows are the ones that would
have cost the most to get wrong.

| Idea | Source | Why rejected |
|---|---|---|
| **A tool call cut off by the output-token limit is failed, never executed** | pi `agent-loop.ts:274-279` | **ALREADY SHIPPED.** August's length-stop fails the whole tool batch at `workbench.py:4661`; a truncated generation's tool calls all fail unexecuted. Recorded in `docs/ROADMAP.md:955`. |
| **Provider-boundary repair of a torn history** | pi `transform-messages.ts:180-256` | **ALREADY SHIPPED** — `workbench/message_pairing.py`, applied at the three workbench seams (`docs/ROADMAP.md:966`, commit `d1e1744c`). |
| **A merge contract for the summariser prompt, and a file-op ledger across compaction** | pi `compaction.ts:540-575` | **ALREADY SHIPPED** — `schemaSummarize` folds prior notes into Context with carried `<read-files>` tags stripped, and keeps the ledger, deterministically and with no extra LLM call (`docs/ROADMAP.md:969`). |
| **Parallel tool execution with two orders** | pi `agent-loop.ts:640-670` | **ALREADY SHIPPED** — `chat_stages.run_regular_tools_stage` gathers a batch when every call is on `parallel_tools.PARALLEL_SAFE_TOOLS` and runs it serially if any call mutates. Measured through the bench harness (`docs/ROADMAP.md:970`, commit `1f67fb0e`). |
| **Circuits as fixtures (a folder of decks that asserts itself)** | SimulIDE `batchtest.cpp:20-58` | **ALREADY SHIPPED** — `circuit_batch_test` walks a folder of decks and asserts each deck's own `* expect v(out) ~= 5.0 ±0.05` cards (`docs/ROADMAP.md:967`, commit `60a55a5e`). |
| **Change-sampled `(value, simTime)` circular buffers** | SimulIDE `plotbase.cpp:28` | **ALREADY SHIPPED** — `_signal_edges` change-samples a trace off the full run, with a digital lane gated on a real swing (`docs/ROADMAP.md:968`, commit `48eefe1c`). |
| **Surface the provider cache-hit rate next to the token totals** | DSH `apps/web/tests/expected/cordis-history/ui.expected.md:73` | **ALREADY SHIPPED, and better.** August's `ContextUsageReadout` (`sections/chat/composer/ContextUsageReadout.tsx`) already shows the context percentage under the composer and, on hover, the token counts **and the prompt-cache split** — and its comment records the honesty rules ("NO measurement, NO number"). |
| **A "context used" meter as a compaction trigger** | DSH `apps/web/tests/expected/skill-user-invoke/ui.expected.md:27-28` | **ALREADY SHIPPED** — the same readout. |
| **Reasoning content preserved across tool loops even when the UI hides it** | DSH `packages/core/agent-loop` | **ALREADY SHIPPED** — `providers.py:896-902` and `:1004-1007` always accumulate `reasoning_content`; Anthropic's `signature_delta` is captured and re-sent (`stream_translate.py:143-148`). |
| **A drop-and-retry when a gateway rejects a reasoning hint** | DSH `packages/core/llm` | **ALREADY SHIPPED** — `providers.py:685` `_reasoning_effort_rejected` drops the hint and retries once. |
| **A per-model capability profile that narrows the tool surface** | DSH `packages/core/tools` | **ALREADY SHIPPED, and more detailed** — `loop/surface.py:130` `_modelCapabilityProfile` (full/reduced/bare/text), `maxTools`, `maxToolResultChars`, with a 5 s memo that returns a copy. |
| **A turn bound and a stop-reason vocabulary** | DSH `packages/core/agent-loop` | **ALREADY SHIPPED, and better** — `MAX_MANAGED_TOOL_ROUNDS = 150`, the world-delta runaway backstop armed at 25/40, and a `turn_end {reason}` vocabulary of eight values persisted on `turn_outcomes`. pi has a turn bound only in its experimental `durable` package. |
| **A request header logged as a full canonical snapshot, only when it changed** | DSH `packages/core/agent-loop` | **PARTLY ADOPTED, and the rest is a product decision.** August's `event_log` is a durable JSONL with a `sinceSeq` cursor and a ring; it is not a request-header log, and building one is a diagnostics feature rather than a weak-spot fix. Noted in proposal 1's verification, not proposed as its own item. |
| **A canonical tool order that registration order cannot leak into** | DSH `packages/core/system-prompt/src/index.ts:674` | **ALREADY SHIPPED** — August sorts by name (`workbench.py:1417-1419`). The *stability across rounds* is proposal 1. |
| **The MCU as an XML data file read at load** | SimulIDE `mcucreator.cpp:107,163,447-517` | **PARTIALLY SHIPPED, and the rest is a DECISION, not a defect.** `a534f235 feat(circuit): learn a board variant's rail from the installed core` already reads the variant's rail from the installed core. How much of the chip definition to move out of `_BOARD_PINS` into a data file is a product decision the owner has to make. |
| **A two-method "accelerator" interface the host installs at runtime** | SimulIDE `angelscript.h:1211-1218` | **SKIP.** Elegant, but August has no hot path that needs a compiled fast path. The *shape* — a tiny optional interface the host installs — is worth remembering; the concrete proposal is not. |
| **A marker instruction that lets a fast path and a slow path coexist** | SimulIDE `as_compiler.cpp:132-133` | **SKIP.** Same reason, plus it needs an intermediate representation August does not have. |
| **Compile-time feature removal, not runtime guarding** | SimulIDE `as_config.h:77` | **SKIP.** It presumes a build matrix per configuration. August ships one desktop build; a runtime capability profile is the right shape for it. |
| **The build configuration as a queryable runtime string** | SimulIDE `as_scriptengine.cpp:73-128` | **NOTED, NOT PROPOSED.** The idea is right — one line that says exactly which features, paths and models were in effect — and August is close (`enforcement_report()`), but it is a diagnostics feature, not a weak spot. |
| **Every diagnostic as a named constant in one file** | SimulIDE `as_texts.h:40+` | **PARTLY ADOPTED ALREADY.** August has the eight-family error taxonomy in `app/services/error_families.py`, and the receipt-tone table in `tool_protocol.py`. Proposal 6 changes the *mechanism* rather than extending the table. |
| **A vendored dependency's licence file says it was modified** | SimulIDE `src/angel/src/COPYING:31-34` | **SKIP as a proposal; KEEP as a practice.** August vendors nothing it has forked. |
| **A garbage collector that does bounded work per allocation** | SimulIDE `as_gc.h:78-94` | **SKIP.** August's memory is SQLite with explicit lifetimes; there is no cycle to collect and no allocation hot path. |
| **Reference counting split into "the engine owns it" and "someone outside holds it"** | SimulIDE `as_typeinfo.cpp:44-45` | **SKIP.** August's stores are process-lifetime and its connections are thread-local; the two-counter distinction has no consumer. |
| **pi's durable harness** | pi `packages/durable/` | **SKIP — deliberately.** It self-describes as experimental, "the API changes without notice", and admits "this is not exactly-once execution", and `pi-coding-agent` **does not depend on it at all**. August's crash story is the interrupted-turn marker, and that is a better trade for a product that must not surprise its user. Recorded in the 2026-10-21 round; unchanged. |
| **pi's `ToolExposure` five-way split (`direct\|model-only\|codemode\|deferred\|hidden`)** | pi | **SKIP.** It hides a tool by projecting its name out of the transcript's tool deltas, so the tool **stays callable**. August's stated rule is the opposite — *enforcement is the deny set, not the withheld surface* (`subagent.py:316`). Copying the projection trick for *display* only would be defensible; copying it as a permission model would be a security regression. |
| **`context_edit` as a rewrite primitive** | pi `session-manager.ts` | **SKIP.** August's transcript is append-only **and archived**; omission deltas would be a second source of truth for "what was really sent", which is exactly the property the archive exists to protect. DSH's *event-sourced log with a migration chain* is the better version of this idea, and it is a product decision, not a defect fix. |
| **pi's cache warmer (refresh at 90 % TTL when expected savings ≥ $0.05)** | pi | **SKIP.** August's pricing is per-model `priceForModel` and models no provider TTL. There is nothing to warm against. |
| **A prompt-cache TTL warmer for the Anthropic path** | — | **SKIP.** Same reason, stated by the 2026-10-21 round. August's cache discipline is *prefix stability*, which proposal 1 attacks directly and far more cheaply. |
| **The dense N×N matrix with unpivoted Crout, and the fixed-point companion iteration** | SimulIDE `circmatrix.cpp:22-35` | **SKIP — and do not regress.** ngspice does trapezoid/Gear with truncation control. August delegates solving to ngspice and must not regress. |
| **The solver's discarded `isOk`** | SimulIDE `simulator.cpp:66-74` | **SKIP — this is the failure mode to avoid, not to copy.** A solver whose silence looks like an answer is precisely what August's `circuit_simulate` lint and SOA warnings exist to prevent. |
| **`uint64` picosecond absolute time with integer `time/m_steps`** | SimulIDE `e-reactive.cpp:92-97` | **SKIP.** A rewind-on-past-event and a zero-delay hazard. SimulIDE's own one-event-per-element guard is a *mitigation* for a design August should not adopt. |
| **The vendored AngelScript + x86-64 JIT** | SimulIDE `src/angel/` | **SKIP.** A whole compiler is a scale August has not chosen, and the AGPLv3 licence means the code is not vendorable regardless. |
| **The `QtConcurrent` sim thread racing GUI reads** | SimulIDE | **SKIP — this is the failure mode.** `src/` contains zero `QMutex\|std::mutex` hits while the sim runs on a `QtConcurrent` thread. August's durability barriers and thread-local connections are the answer to the same problem. |
| **One `QGraphicsScene` per circuit and 18 `::self()` singletons** | SimulIDE | **SKIP.** One circuit per process does not scale to a multi-session desktop app. |
| **`rev=` as a build date rather than a schema version** | SimulIDE | **SKIP — and keep away.** Anything August persists must be readable across versions. DSH's *format chain* is the right answer; a build date is the wrong one. |
| **The whole AngelScript fast-path/slow-path handoff protocol** | SimulIDE `as_jit.cpp:738-741` | **SKIP.** The handoff shape (one small, explicit, versioned struct) is a good idea for any resume-able execution, but August has no such execution to resume. |
| **DSH's whole plugin architecture as a model for August** | DSH `packages/extensions/` | **SKIP.** August's tool registry, skill layer and MCP door are a different and more constrained shape, and the brief's goal is a minimalist desktop app, not a plugin platform. Two *rules* from it are adopted (proposals 7 and 9); the architecture is not. |
| **DSH's `rejected/` notes directory as a design element** | DSH `.agents/notes/` | **NOTED, NOT PROPOSED — but it is the single most transferable *practice* in the three repos.** August has `docs/plans/` and `docs/research/`; a `rejected/` class with the same closed note format would mean the *declined* options stay on file instead of being re-proposed every quarter. This document's own "Considered and rejected" table is a step in that direction. |

---

# What I did not propose, and why

Some of the most interesting findings in the three repos are **not** August
improvements, and it is worth saying so explicitly rather than letting them
look like omissions.

- **August's security model is stronger than both references in the areas
  that matter.** pi has **no approval gate anywhere in the core** by design
  (`SECURITY.md`: "pi runs with the user's own permissions; containerize it if
  you need more"), and **no read-before-edit gate** (verified as an absence).
  SimulIDE races its own simulation thread against the GUI with zero mutexes
  in `src/`. August's deny-set enforcement, seven listing doors, hardline
  shell policy and transport-level credential scrub are all stronger.
  **Do not "simplify" toward either reference.**
- **August's turn-outcome ledger is better than either reference.**
  `turn_end {reason, rounds, error}` on every turn, persisted on
  `turn_outcomes`, is the best operability decision in the repo, and neither
  reference has anything like it. DSH's `packages/core/agent/src/consumed-work.ts`
  is the closest analogue and it is per-turn, not persisted.
- **August's compaction *architecture* is better than pi's.** One
  `compressMessages` call site reached by five paths, reconciled by a census
  rather than by trust, is a stronger design than pi's per-caller compaction
  hooks. Proposal 5 changes the *cut rule* and the *summariser*, not the
  architecture.
- **August's SSE gate is stronger than anything the references have.**
  `check:sse` *discovers* the emitter set by scanning for `emit(` calls rather
  than listing it by hand, and it checks **handler supply** — a comment-only
  handler body does not count. A hand-written emitter list is exactly how a
  frame once hid; both references would benefit from the same gate.
- **DSH's decision-record corpus is the best artefact in any of the three
  repos, and it is prose, not code.** 87 shipped architecture notes, each
  with its *alternatives considered* and its *consequences*, sealed with a
  SHA-256 manifest, and a `rejected/` class that keeps the declined options
  on file. August's own documentation is stronger than most, but it does not
  record what it *declined*.
