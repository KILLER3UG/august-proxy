# August baseline — what this harness actually does today

**Purpose.** Every proposal in `docs/research/AUGUST-IMPROVEMENTS.md` is checked
against this page. If August already does the thing, the proposal is dropped; if
August *looks* like it does the thing but does not, that is recorded here as
**COSMETIC** so the proposal can say what is actually missing.

**Date:** 2026-10-22 · **Commit:** `bc531b2e` (research-only work; no August
source was modified) · **Method:** first-hand reading of the live tree, cross-
checked against three prior August audits already in the repo
(`docs/research/2026-10-21-deep-dive-and-cleanup.md`,
`docs/research/2026-10-21-simulide-and-pi-harness.md`,
`docs/plans/2026-10-05-harness-pattern-gap-analysis.md`).

> **The three prior audits are 17 days old and the tree has moved.** Numbers
> quoted there are stale in ways that matter. This page is the current truth.
> Example: the gap analysis (2026-10-05) records `MAX_MANAGED_TOOL_ROUNDS = 0`
> ("nothing bounds a turn") and `_DESCRIPTIONMax = 60`; today it is **150** and
> **500**. Both were fixed in the interval. Anything else that reads like a
> "known gap" in that document must be re-verified before it is proposed again.

---

## 0. Surface map

Tauri v2 desktop shell (Rust, `frontend/desktop/src-tauri/`) wrapping a FastAPI
backend (`backend-py/app/`, ~344 modules) and a React SPA
(`frontend/desktop/src/`, ~507 files). The app factory is `main.py:435` with
`lifespan=main.py:135`; 37 routers register at `main.py:530-574`.

The turn is one function: `services/workbench/workbench.py:2419`
`_sendWorkbenchMessageStreamImpl` (~3 400 lines). `services/workbench/loop/`
(`exec.py`, `guards.py`, `recovery.py`, `events.py`, `prompt.py`, `surface.py`)
is an **unfinished extraction** — those modules are *called by* that function;
the function body was never decomposed.

---

## 1. Chat / proxy loop

- **Producer/consumer split.** `POST /api/workbench/chat`
  (`routers/workbench.py:475`) returns immediately; the client subscribes to a
  per-session event log (`GET /chat/stream`). This is what makes reconnect,
  cancel and the phone companion work without a second protocol. **REAL.**
- **Proxy adapters.** `/v1/chat/completions` (`routers/proxy.py:462`),
  `/v1/messages` (`:408`), `/v1/responses` (`:497`), `/v1/models` (`:585`) —
  all `Depends(require_gateway_key)`. Their managed tools now route through
  `loop/exec.py::_executeTool` with a synthetic session, so the PRE/POST hook
  stack, the stale-write hash gate and the tool timeout apply. **REAL** (fixed
  after the 2026-10-21 audit found the bypass).
- **Non-streaming model calls:** `/v1/responses` supports `stream: true` by
  upstream-native pass-through.

## 2. Tool loop and tool registry

- ~180 tools registered once via
  `tool_registry.register(name, description, handler, schema)` across 19
  modules under `services/tool_registrations/`; entry point
  `tool_registrations/__init__.py:39` `register_all()`. Schemas are **not**
  duplicated at registration. **REAL.**
- **Progressive disclosure is real, not aspirational.** `tool_search` /
  `tool_describe` / `tool_call` (`services/tools/tool_bridges.py:207-240`) reach
  tools outside the advertised slice, and `tool_call` re-runs `_checkToolGuard`
  (`tool_bridges.py:138`) before dispatching. **REAL.**
- **Two wire formats, one source.** `toolDefinitions` (`workbench.py:1369`) and
  `openaiToolDefinitions` (`workbench.py:1479`) — both must stay in sync; both
  honour the per-model capability profile in `loop/surface.py`.
- **Per-model surface narrowing.** `loop/surface.py:60` `_BARE_TOOL_ALLOW`,
  applied at `surface.py:203` and at `workbench.py:3550, 5685, 5714`. A bare
  surface still carries the memory CRUD tools (`remember` / `list_facts` /
  `forget`) so a weak model can correct what it remembers instead of only
  accumulating. **REAL** and deliberate.
- **Parallel tool execution** is shipped: a batch is gathered when every call is
  on `parallel_tools.PARALLEL_SAFE_TOOLS` and run serially otherwise; default
  ON via `AUGUST_P1_PARALLEL_TOOLS`. **REAL** (the 2026-10-21 report had this
  wrong in both directions; it was corrected in `1f67fb0e`).

## 3. Subagent spawn and UI

- `services/workbench/subagent.py:369` `executeSubAgent`.
- **Enforcement is a deny set, not a withheld surface.**
  `subagent.py:52` `_SUBAGENT_NEVER_TOOLS`, `subagent.py:316`
  `_workerDeniedNames`, published at `subagent.py:818` as `currentSubagentDenied`
  (`workbench/context.py:54`), read at `tool_bridges.py:156-165`. A worker
  calling `write_file` is blocked **before** dispatch. **REAL** — and it is the
  single strongest idea in August's security model.
- **Inheritance cannot widen.** `tools/agent_registry.py:184`
  `_effectivePermissions` applies the parent's bound even to a child declaring
  `'all'`. A dangling `parentId` means *no restriction* (reachable by ordinary
  use); a `parentId` **cycle** fails closed. Both directions are deliberate.
- **Capability definitions are not model-writable.** `self_config_tools.py:37`
  `_authority_refusal` rejects `permissions` / `tools` / `modelAlias` at the
  handler; the human door (`PUT /api/agents/{id}`) still owns the registry.
  **REAL.**
- **Bot-to-bot has its own ceiling** (`bot_mode/dm.py`), because every loop guard
  is per-turn and a hop is a fresh turn in a different session. It reads the
  **persisted** `messages` table, not in-memory state, so a restart cannot
  launder a runaway. **REAL.**

## 4. Memory — there is no "five-layer" model in code

> The phrase "five-layer memory" appears only in
> `docs/superpowers/specs/2026-06-29-v3-brain-dashboard-design.md:41` and two
> sibling specs. `cognitive_layers` was deleted from config
> (`cognitive_config.py:209`) and `cognitive_boot.py:3` says the layers were
> removed. **The five-layer model is a DOC CLAIM, not an implementation.**
> (Recorded 2026-10-05; still true on 2026-10-22 — re-verified.)

What exists instead:

- **21 SQLite tables** in `services/memory_schema.py` (the "brain"): `facts`,
  `messages`, `sessions`, `proposals`, `episodic_timeline`,
  `learned_heuristics`, `blackboard`, `scratchpad`, `usage_events`,
  `tool_guardrail_log`, `lifecycle`, `daemons`, `session_topics`, `execution_state`,
  `config_audit`, `exam_*` (3), `memory_store`, `exam_attempts`. A flat store
  space, not layers.
- **Recall is BM25** over the `facts` table
  (`services/memory_store/fact_retrieval.py:458` `retrieve_relevant_facts`).
- **The `<memory>` tail is gated OFF by default.** `memoryAutoInject` default
  `False` (`brain_config_service.py:272`); the gate is read at
  `workbench.py:940, 3044` and `fact_retrieval.py:971`. Recall therefore happens
  when the model calls `brain_query`. **REAL but off by default** — this is the
  single most important "off by default" in the product.
- **`kind='profile'` is an always-in lane** (rendered first, ~600-char budget,
  injected even with auto-inject off) — this is what makes August remember *who
  you are* without a keyword coincidence. **REAL.**
- **Read-before-write is enforced.** `remember` refuses its first write in a
  turn until `list_facts` (or a `brain_query` over a memory store) has run once
  that turn — and never when the store is empty or `modelMemoryRead` is off, so
  a gate the model cannot satisfy cannot make memory unwritable.
- **A fact dropped for budget is NAMED** in a `recall partial:` line rather than
  vanishing.
- **The boot memory index is frozen per session** to protect the provider prefix
  cache, so `<memory_policy>` tells the model to re-read `list_facts` after
  writing rather than trusting the index. **REAL** — a deliberate
  cache-stability trade, documented in `AGENTS.md`.
- **Durable memory survives independently of recall**: `services/brain_backup.py`
  takes online SQLite backups, runs `PRAGMA integrity_check` on every copy, and
  restores **staged for the next launch** (`apply_pending_restore()` in
  `main.py`), never in place. **REAL.**

## 5. Skills and skill evolution

- Format: folder + `SKILL.md` with YAML frontmatter
  (`services/skill_service.py:306`). Bundled layer at repo `skills/`, project
  layer at `<workspace>/.aug/skills/`, bot layer at `<dataDir>/bots/<id>/skills/`.
- **`_DESCRIPTIONMax = 500`** (`skill_service.py:219`) — *raised from 60 after
  the 2026-10-05 gap analysis; that finding is closed.* The description is the
  TRIGGER, so a skill states the capability, the situations, and when NOT to
  fire.
- **Canonical body sections:** Title, When to Use, When NOT to Use,
  Prerequisites, How to Run, Quick Reference, Procedure, Output format, Examples,
  Pitfalls, Verification, Reference files — spec in `docs/SKILL_AUTHORING.md`.
- **Evolution is human-gated.** The distiller drafts; `skill_distiller.py:637-667`
  `save_proposal(kind='skill_create'|'skill_patch')`; a human decides in the
  review inbox. `harness_promote.py:340` likewise. **REAL** — a deliberate gate,
  not a bug.
- **A learned skill is a procedure, not a rule.** `skill_service.bodySubstance`
  measures what was drafted *before* `_ensure_canonical_body` pads it; below the
  bar the verdict becomes a memory lesson instead of a padded skill.
- **The positive trigger is opt-in.** `skill_distiller.run_review_pass()` reads
  one session per pass — the most recently active with unreviewed messages — and
  is gated by brain-config `memoryReview` (**default OFF**). Progress is a
  **per-session cursor map**, not one global high-water id.

## 6. System prompt architecture

- `workbench.py:739` `buildSystemPrompt`. XML-tagged segments, each conditional
  on the tools actually offered; an `<intake>` manifest enumerating exactly what
  the context carries; a **byte-stable `<session>` block** so provider prefix
  caching keeps working. **REAL.**
- **Measured at 2026-10-05 (default config, 38 tools):** system prompt
  **9 422 ch ≈ 2 355 tok**; **tool definitions 27 647 ch ≈ 6 911 tok — 3× the
  system prompt.** Descriptions 9 385 ch; `remember` alone 853 ch. The largest
  reducible block in the product is therefore **not the prompt**.
- Known prompt defects from 2026-10-05, still worth re-checking:
  `<capabilities>` double-wrapped (`capabilities_prompt.py:459,478` returns it
  already wrapped, so every prompt has literal nested tags) and **zero worked
  examples** in the assembled prompt.

## 7. Provider / model routing and model compatibility

- `services/workbench/providers/api_format.py` + `model_resolver.py:70`. A
  provider-level format **plus a per-model override** — which is what lets one
  gateway serve Claude via `v1/messages` and GPT via `chat/completions`.
- **Upstream body hygiene is a serializer-layer fix.**
  `models/openai.py:67` `dump_openai_upstream_body` (`exclude_none`; strips
  August-only keys) and `models/anthropic.py:61`. Applied in the workbench, the
  model Test button and the `/v1` adapters. This is the 0.12.21
  `session_id: null` fix. **REAL.**
- **Transport scrub.** `providers/clients/base.py:399` `wireBody` wraps both
  httpx sends, so the credential scrub (matched **by value**, not pattern) covers
  every provider path. **REAL.**
- **Per-model capability profile.** `loop/surface.py:130`
  `_modelCapabilityProfile` → `toolSurface` (full/reduced/bare), `maxTools`,
  `maxToolResultChars`, set in Model settings. **REAL.**
- **Per-model pricing.** `priceInPerM` / `priceOutPerM` / `free`;
  `cost_estimator.price_for_model` is the **only** pricing source. `0.0` is a
  price, not an absence — only `None` means unset, so nothing on this path may
  use `value or default`. **REAL.**
- **There is NO automatic turn rerouting.** `routing_evidence` is written by the
  Arena/Debate verdict endpoint and read back for ranking; the old
  `AUGUST_AUTO_ROUTE` / `routingSuggestion`-SSE claims were never wired and
  have been removed. **A doc claim that was corrected — do not propose it back.**

## 8. Sandbox

- `services/sandbox/hardline.py` — matches on the token the shell *would follow*,
  not the string the model typed; refuses credential stores **by directory, not
  by filename** (because `config.json` is secret inside `.docker` and ordinary in
  any project). `{dataDir}/config.json` and `secrets.json` join by absolute path.
- **One tokenizer.** `_tokenize` is the only splitter; `_is_write_intent`,
  `_enumerates_a_directory` and `check_hardline_command` all read through
  `_segments`. A second splitter is a defect, not a refactor.
- **Seven listing doors** must clear the directory before listing
  (`sandbox/paths.py` `listable_root` / `listable_entry` / `listable_child`).
  An eighth door is how the seventh was found.
- **The terminal is gated in both directions**: `writeTerminalInput` runs the
  hardline list on **every** line, not only the interactive preflight subset.
- **The Windows sandbox is SOFT by default** — the child process is not
  OS-confined; enforcement is by inspection in the parent. (Owner decision,
  2026-10-21: keep soft, AppContainer opt-in.)
- **The code-mode sandbox is a PORT** of the hardline guard, rendered into every
  code run because it cannot import `app`. A new table or predicate in
  `sandbox/hardline.py` must be injected there too — `tests/test_code_runner_hardline.py`
  (historical) fails on the drift.

## 9. Streaming and terminal responsiveness

- `services/workbench/stream_translate.py:44` translates upstream SSE into the
  app's frame vocabulary. `loop/events.py` owns the emitter set.
- **The error string is extracted at ONE place** — `stream_translate.py:21`
  `_errorEventText` — and every consumer (`classify_error`, the deterministic-400
  replay decision, the stuck-request ladder, the user-facing receipt) reads
  that one string. It flattens a nested envelope, so
  `{"error":{"type","message"}}` is no longer stringified to nothing. **REAL.**
- **Cancellation** exists at `loop/exec.py:196` (tool timeout) and
  `routers/workbench.py:587` (`POST /chat/stop`).
- **A run of tool calls is ONE transcript line.** A render-time arrangement
  (`components/chat/ActivityGroup.tsx` + `lib/tool-summary.ts`); the transcript
  still stores one block per call, so a reload reproduces the grouping and the
  backend knows nothing about it. A run containing a failure opens by default
  and carries a "failed" marker.

## 10. Turn bounds, stalls and self-correction

- `MAX_MANAGED_TOOL_ROUNDS = 150` (`workbench.py:97`) — an **armed ceiling**;
  brain-config `maxWorkbenchToolLoops` overrides it and `0` = uncapped. **The
  "uncapped by default" claim in the 2026-10-05 gap analysis is stale.**
- **Two independent bounds:** a no-progress stop (stall counter, reflection nudge
  at 8+ stalled rounds) and an absolute ceiling counted on **world delta alone**
  (`runawayNudgeRounds` 25 / `runawayStopRounds` 40), which neither argument
  variety nor a flat `update_state` can move. At the ceiling the turn spends one
  tool-free summary round and ends `cap`.
- **Every turn ends with `turn_end {reason, rounds, error}`** in the session log
  — `finished | length | cap | stall-stop | budget | error | interrupted |
  awaiting-input` — and the same reason is persisted on the `turn_outcomes` row
  (migration 046). **The best operability decision in the repo**: "why did it
  stop" is answerable before auditing code.
- **A refusal must not read as progress.** The repeat guardrail's `Blocked:`
  text is now a registered denial and `_marker_form` strips one leading
  capability tag before matching, so `[sandbox:seatbelt] Blocked: …` reads as
  the refusal it is. The general rule: *a marker table has to be checked against
  every emitter, not just the ones that inspired it.*
- **Tool arguments are parsed at ONE door.** `json_salvage.parse_tool_arguments`
  is strict parse → salvage → `{'_raw': text}`, and all four stream-delta
  accumulators route through it.
- **A request the provider refuses on shape is repaired, not replayed.**
  `_stuckRequestEscape` escalates across turns off the `turn_outcomes` strike
  ledger: first refusal left alone, second flattens the tool pairing into text,
  third sends only the newest ask, fourth fails honestly. Every rung archives
  what it replaces first.
- **Overflow keeps its own ladder** — `classify_error` matches
  `context_overflow` before `bad_request`, and the shape-repair branch
  additionally refuses anything `_isContextOverflowError` claims.

## 11. Context relief (compaction)

- `services/workbench/context_compressor.py:17` `DEFAULT_HEAD_COUNT = 4`;
  `:53` `REPLAY_USER_BUDGET_BYTES = 12 * 1024`.
- **Two routes, chosen from state, not by a model.** `reliefStrategy` returns
  `rotate` only when brain-config `contextReliefRotate` is armed **and** a
  `<<compressed_summary` note already exists — the first relief never rotates,
  because before a note exists the verbatim head *is* the live task.
- **Five paths compact and they are reconciled by a census, not by trust**:
  `_compactionCall` is the single shared site (the pre-turn auto-compact, the
  budget ladder's middle rung, the reactive overflow rescue, the manual "Free
  up memory" endpoint, and a subagent compacting mid-run).
- **The cut point is a fixed head count plus a token-budgeted tail** — *not* a
  legality rule over the message sequence. This is the known weak spot: a cut
  can land where it separates a tool call from its result.

## 12. Settings and UI shell

- `frontend/desktop/src/settings/settings-registry.ts` declares **45 sections**
  (19 `tier: 'basic'`, 26 `tier: 'hidden'`). `docs/ROADMAP.md:171`,
  `docs/ARCHITECTURE.md:529` and `docs/GAPS_AND_BUGS.md:73` disagree with each
  other and with the code (they say 44/43 and 17/18 basic). **STALE — but not
  this task's problem.**
- Gates that catch what other gates cannot: `check:sse` (frame vocabulary **and
  handler supply**), `check:truncate` (TS-compiler-API AST), `check:brain-config`
  (asks the backend which keys it accepts), `check:docs`, `check:design`,
  `check:naming`, `check:api`, `check:api-index`, `check:version`,
  `check:doc-links`, `check:minisign`, `lint:ratchet`, plus `e2e:smoke` — which
  imports the real app, runs its lifespan and asks fifteen questions against a
  **throwaway** data directory.
- **There is no test suite** (removed 2026-10-17 at the owner's request).
  Every `tests/…` path in any document is **historical**; verify a claim by
  reading the code it names.

---

## 13. What August already does that the references do not

Recorded so no proposal re-derives it:

| August's mechanism | Where | The reference's posture |
|---|---|---|
| Deny-set enforcement for subagents | `subagent.py:316,818` | pi has **no** permission model at all |
| Read-before-edit gate | `services/workbench/read_before_edit.py` | pi has none (verified by absence) |
| Length-stop fails the whole tool batch | `workbench.py:4655-4698` | pi has the same rule, independently |
| Spill with a retrieval route | `loop/prompt.py:220-300` | pi spills unconditionally to a temp file; August refuses when the offered surface cannot read it back |
| Outbound credential scrub at the transport | `providers/clients/base.py:399` | pi has no equivalent |
| Guard modes, hardline shell policy, seven listing doors | `services/sandbox/` | pi declines to have a permission model — do not "simplify" toward it |
| Turn outcome ledger with a stop-reason vocabulary | `turn_outcomes.py:249` | pi has no turn bound and trusts the context window |
| Human-gated skill evolution | `skill_distiller.py:637-667` | Hermes writes to the skill store directly with a human as opt-in curator — deliberately **weaker** |
| Per-model capability profile narrowing the tool surface | `loop/surface.py:130` | pi has a `compat` table but it *degrades* rather than narrowing |

## 14. Known weak spots, in the order the task names them

1. **Memory recall** — the BM25 tail is **off by default**; the shipped default
   is "the model asks". The boot index is frozen per session, so a fact written
   this turn is invisible to the prompt until the model re-reads `list_facts`.
2. **Tool-call hangs / streaming** — a tool timeout exists
   (`loop/exec.py:196`) but the *shape* of a stuck stream (provider stalls
   mid-SSE, no error, no frame) is not obviously bounded; the stalled-round
   counter needs a round to complete before it can fire.
3. **Subagent scalability** — the deny set, lineage ceiling and permission
   inheritance are sound; the *concurrency* of subagents is not addressed by
   anything in the tree.
4. **System prompt bloat** — 2 355 tok of system prompt and **6 911 tok of tool
   definitions**; the tool definitions are 3× the prompt.
5. **Model compatibility** — per-model `apiFormat` and capability profiles
   exist, but a *malformed* model output has one repair path
   (`json_salvage`), one salvage path, and one refusal ladder. There is no
   provider-boundary normalisation of a torn history before a request.

---

## 15. Prior research this study builds on

| Document | Covers | Status |
|---|---|---|
| `docs/research/2026-10-21-simulide-and-pi-harness.md` | Two full passes over SimulIDE + pi, with corrections and a "must NOT be copied" list | **Reused.** The Phase 2 shards re-read both repos in full, but the ideas below are not re-derived from scratch. |
| `docs/research/2026-10-21-deep-dive-and-cleanup.md` | August architecture, tool/permission stack, memory, gates, dead code | **Reused**, and its 2026-10-21 findings were themselves fixed the same day. |
| `docs/plans/2026-10-05-harness-pattern-gap-analysis.md` | 33-row gap table vs the reference harnesses | **Reused with a 17-day staleness discount.** `MAX_MANAGED_TOOL_ROUNDS` and `_DESCRIPTIONMax` have since changed. |
| `docs/plans/ui-refactor/research/2026-10-03-reference-deepseek-harness.md` | DSH **UI** study from the local install | **Reused for UI claims only** — it is a UI study, not a source read. |
| `docs/plans/2026-10-15-harness-reference-dsbot-abacus.md` | DS Bot + abacus reference dive | **Read in Phase 0**; DSH itself was not read from source until this study. |
