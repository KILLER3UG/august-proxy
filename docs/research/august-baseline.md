# August baseline — what this harness actually does today

**Purpose.** Every proposal in `docs/research/AUGUST-IMPROVEMENTS.md` is checked
against this page. If August already does the thing, the proposal is dropped; if
August *looks* like it does the thing but does not, that is recorded here as
**COSMETIC** so the proposal can say what is actually missing.

**Date:** 2026-10-22 · **Commit:** `bc531b2e` (research-only work — but see the
correction below) · **Method:** first-hand reading of the live tree, cross-
checked against three prior August audits already in the repo
(`docs/research/2026-10-21-deep-dive-and-cleanup.md`,
`docs/research/2026-10-21-simulide-and-pi-harness.md`,
`docs/plans/2026-10-05-harness-pattern-gap-analysis.md`).

> **Corrections, same day (2026-10-22, later).** This baseline is a snapshot and
> several of its counts moved within hours of being written. The loop bounds are
> now ARMED by default (150 rounds; runaway 25/40), six Settings doors were
> removed (with `turn-limits` and `tools-connections` among them), a cross-chat
> `/artifacts` page exists, tool arguments go through one salvage door, and the
> thinking card lost its per-thought header. A first-hand re-check also corrected
> these counts: **41** routers (not 37), **152** `register(` sites (not 153), and
> **14** names in `_BARE_TOOL_ALLOW` (not 16 — the extra two were quoted in the
> comment). Treat any number here as a claim about that afternoon, and re-derive
> it from the tree before planning against it. The research commits also deleted
> two source files by accident (`TurnLimitsSection.tsx`,
> `AISetupWizardSection.tsx`) despite this page saying no source was modified;
> the settings round removed their now-dangling imports.

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

- **153 registered tools** (AST scan of every `tool_registry.register(` call —
  152 literal names plus one dynamic), across **22 registration groups**
  (`tool_registrations/__init__.py:10` `register_all()`), entered at
  `app/services/tool_definitions.py:39` `registerAll()`. Schemas are **not**
  duplicated at registration. **REAL.**
- **Progressive disclosure is real, not aspirational.** `tool_search` /
  `tool_describe` / `tool_call` (`services/tools/tool_bridges.py:42,90,113`)
  reach tools outside the advertised slice, and `tool_call` re-runs
  `_checkToolGuard` (`tool_bridges.py:138`, **fails closed** on exception for a
  mutating tool), applies the sub-agent deny set (`:156-178`), and dispatches
  through the **real** `_executeTool` so hooks, spill and the mutation log
  apply. Raw registry dispatch is only a fallback with no session bound.
  **Activation is a token budget** (10 % of the model window), not a tool count.
- **Two wire formats, one source.** `toolDefinitions` (`workbench.py:1369`) and
  `openaiToolDefinitions` (`workbench.py:1479`) — both must stay in sync; both
  honour the per-model capability profile in `loop/surface.py`; both sort the
  bare-essential tools **first**, so a self-heal downgrade yields a *prefix*
  and the Anthropic cache breakpoint on the tools array survives.
- **Per-model surface narrowing.** `loop/surface.py:60` `_BARE_TOOL_ALLOW`
  (16 names), applied at `surface.py:203` and at `workbench.py:3550, 5685, 5714`.
  A bare surface still carries the memory CRUD tools (`remember` / `list_facts` /
  `forget`) so a weak model can correct what it remembers instead of only
  accumulating. **REAL** and deliberate.
- **`_executeTool` does NOT call `_checkToolGuard`** — each dispatch path
  invokes it itself (main loop `workbench.py:5032`, bridge
  `tool_bridges.py:138`, code bridge `kernel.py:847`, worker
  `subagent.py:1303`). That is the "gate participation" discipline the repo
  enforces by audit.
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

> The phrase "five-layer memory" appears only in three June-2026 design specs
> (`docs/superpowers/specs/2026-06-29-cognitive-architecture-remediation-design.md:47`,
> `…-v2-phases-8-10-bringup-design.md:51`, `…-v3-brain-dashboard-design.md:41`).
> `cognitive_config.py:217` **deletes** `cognitive_layers` from config, and
> `cognitive_boot.py:3` says the layers were removed. **The five-layer model is
> a DOC CLAIM, not an implementation.** Re-verified 2026-10-22 by two
> independent reads.
>
> The only "five" that is real is `facts.kind`'s five-value enum
> (`memory_store/rest.py:29-30`: `fact | lesson | preference | skill-note |
> profile`) — and those are **row labels, not tiers**. `skill-note` is a
> **declared enum member with no writer**.

What exists instead — **one SQLite file with seven surfaces**:

| Surface | Where | Entered context via | Gate |
|---|---|---|---|
| `kind='profile'` facts | `facts` table | **every turn**, always-in lane | none |
| BM25 keyword recall | `facts` table | per-turn `<memory>` block | `memoryAutoInject` — **DEFAULT OFF** |
| Boot index (≤40 facts + ≤10 notes + ≤5 timeline) | `brain_index_snippet` | system prompt `<intake>`, **frozen per session** | none |
| KV notes | `memory_store` table | boot index, `brain_query store=memory` | — |
| Machine state | `internal_state` table | never surfaced to the model | — |
| Project memory `<ws>/.aug/memory/*.md` | markdown files | boot index + `<memory>` tail | `projectMemory` (default on) |
| Transcripts / episodes | `messages`, `sessions`, `episodes` | history only | — |

- **21 SQLite tables** in `services/memory_schema.py`; **55 migrations**
  (`001_baseline.sql` → `055_fact_lineage_and_signals.sql`).
- **Recall is real Okapi BM25** (`services/tools/retrieval.py:42-90`,
  `k1=1.5, b=0.75`) over a **per-scope cached corpus**
  (`memory_store/fact_retrieval.py:121-205`). Scoring: BM25 + a prior-turn term,
  × a confidence factor (`_CONF_FLOOR = 0.85`), + a decayed usage boost, − a
  disuse penalty. **The index IS rebuilt on write** — `invalidate_fact_index`
  is called from `save_fact`, `update_fact_value`, `delete_fact` and every
  consolidation mutation. `facts` has **no FTS5 index** (only `memory_store`
  and `messages` do), so facts search falls back to a LIKE scan.
- **The `<memory>` tail is gated OFF by default.** `memoryAutoInject` default
  `False` (`brain_config_service.py:272`); read at `workbench.py:3044`. In that
  state the per-turn block is **the profile lane only** (`workbench.py:3150`).
  Recall therefore happens when the model calls `brain_query`. **REAL but
  unreachable by default.**
- **`kind='profile'` is an always-in lane** — 600-char cap
  (`fact_retrieval.py:54`), built from the *same* cached corpus under the *same*
  visibility rule, and **excluded from the BM25 corpus** (not from the result)
  so a rich profile set cannot starve keyword recall. Dropped facts are NAMED
  in a `profile lane partial: N omitted for budget: …` receipt.
- **Read-before-write is enforced.** `remember` refuses its first write in a
  turn until `list_facts` (or a `brain_query` over a memory store) has run once
  that turn — and never when the store is empty or `modelMemoryRead` is off.
  A **separate, stricter** duplicate door refuses an *exact normalised* repeat
  under a different key and names the offending key (`existingKey`).
- **The boot memory index is frozen per session** (`workbench.py:968-981`) to
  protect the provider prefix cache, and capped at **40 facts + 10 notes + 5
  timeline** rows. So anything saved after the session opened is invisible
  until the model re-reads `list_facts`.
- **Consolidation is real and propose-only where it matters** — a scheduled
  job (default every 24 h) that expires, merges, supersedes, and *proposes*
  retirement; a human decides. Merges snapshot the absorbed row into
  `lifecycle` before deleting it. Contradictions are split by word overlap
  (≥0.5 → `superseded`, <0.5 → `contested` + mutual `contradicts`).
- **Durable memory survives independently of recall**: `services/brain_backup.py`
  takes online SQLite backups through the backup API against a read-only
  handle, runs `PRAGMA integrity_check` on every copy, and restores **staged
  for the next launch** (`apply_pending_restore()` in `main.py`), never in
  place. **REAL.**
- **`AGENTS.md`/`docs/ARCHITECTURE.md` say "the parent turn is the single memory
  write door." Read as the MODEL door, that is true — sub-agents cannot write.
  It is not the only code path: `save_fact(` has **9 call sites**
  (`routers/august.py:629,804`; `harness_promote.py:370`;
  `skill_distiller.py:1220`; `rollback_store.py:283,296,305`;
  `turn_outcomes.py:1100`; `session_tools.py:631`).

## 5. Skills and skill evolution

- Format: folder + `SKILL.md` with YAML frontmatter
  (`services/skill_service.py:306`). Four roots with a fixed precedence:
  **bot** `<dataDir>/bots/<id>/skills` → **project** `<ws>/.aug/skills` → **agent**
  `<dataDir>/skills` → **bundled** `<repo>/skills` (8 bundled skills).
- **`_DESCRIPTIONMax = 500`** (`skill_service.py:219`) — *raised from 60 after
  the 2026-10-05 gap analysis; that finding is closed.* The description is the
  TRIGGER, so a skill states the capability, the situations, and when NOT to
  fire. The validator also enforces a **marketing-word denylist**.
- **Canonical body sections:** Title, When to Use, When NOT to Use,
  Prerequisites, How to Run, Quick Reference, Procedure, Output format, Examples,
  Pitfalls, Verification, Reference files — spec in `docs/SKILL_AUTHORING.md`.
  **Bar-raising sections:** When to Use, Procedure, Pitfalls, Verification.
- **Evolution is human-gated.** The distiller drafts; `skill_distiller.py:637-667`
  `save_proposal(kind='skill_create'|'skill_patch')`; a human decides in the
  review inbox. Proposals are **JSON files on disk**, not rows, and a
  **rollback is mandatory** on every proposal. `harness_rails.py` allows auto-
  apply for `skill_create`/`skill_patch` only, and `armed_kinds()` intersects
  the config with the code allow-list so **no config can widen it**.
  Autonomy is off by default. **REAL** — a deliberate gate, not a bug.
- **A learned skill is a procedure, not a rule.** Two-stage bar: a description
  bar (failing it converts the verdict to a memory lesson, so the skill path is
  never taken) and a **body-substance** bar measured **BEFORE**
  `_ensure_canonical_body` pads it — "padding is exactly what let a one-line
  rule pass for a skill". A section whose text equals the placeholder counts as
  **missing**, so the template cannot pass the bar.
- **The positive trigger is opt-in.** `skill_distiller.run_review_pass()` reads
  one session per pass and is gated by brain-config `memoryReview` (**default
  OFF**). Progress is a **per-session cursor map** (capped at 500 entries,
  evicted by lowest cursor), plus a **second cursor for archived messages**
  because compaction deletes the middle it folded away.
- **The usage counter** is `<dataDir>/skills/<name>/.usage.json`, always in the
  data-dir root whatever root the skill resolved from, so user state never
  lands in the install tree.

## 6. System prompt architecture

- `workbench.py:739` `buildSystemPrompt`. XML-tagged segments, each conditional
  on the tools actually offered; an `<intake>` manifest enumerating exactly what
  the context carries; a **byte-stable `<session>` block** so provider prefix
  caching keeps working. **REAL.**
- **Size — use the honest range, not the old headline.** The 2026-10-05 gap
  analysis says "9 422 ch ≈ 2 355 tok (38 tools)" but its own breakdown sums to
  **13 256**, so that number is not a reliable source. A fresh AST measurement
  of the static literal text inside `buildSystemPrompt` gives **2 316 ch**, and
  with the dynamic blocks (`<capabilities>` 3 644 ch at 114 tools + 20 skills,
  tool buckets 1 826, agents 983, skill index 745) the assembled prompt is
  **~10–14 k chars ≈ 2.5–3.5 k tokens**. The `workbench.py:1050` "~29k-char"
  figure is asserted by no gate — **UNVERIFIED, do not quote it**.
- **The tool-definition array is the bigger cost, not the prompt.** Measured
  **27 647 ch ≈ 6 911 tok — 3× the system prompt** (the untrimmed registry; the
  activated disclosure path trims to core + 10 + 3).
- **Progressive disclosure activates on a TOKEN BUDGET, not a tool count.**
  `assembleToolDefs` (`tools/model_tools.py:133,145`) sets
  `thresholdTokens = contextLength × 10 %` against the session model's real
  window. The bridge comment claiming "≥ 200 tools" is **false**.
- **Byte-stability / prefix cache — REAL.** `<session>` was deliberately
  emptied of volatile state (`workbench.py:1043-1057`); the per-turn tail
  (`<memory>`, `<relevant_skills>`, `<session_state>`, `<memory_nudge>`,
  `<workspace_map>`, `<plan_state>`) is patched onto the **last user message**
  and stripped before persistence. The VCS block, the memory index and the
  project index are **frozen per session**. The prompt is built once per turn
  and rebuilt only on a surface/mode change. Anthropic cache breakpoints are
  applied *after* messages and tools are final.
- **Three tiers of skills reach the prompt.** Tier 1 `<skills>` is
  **name-only**; descriptions ride per-turn `<relevant_skills>` (top-5 BM25,
  1 400-char cap); Tier 3 is `load_skill` on demand. **A skill nobody mentions
  by keyword is unreachable from the prompt** — `list_skills` returns full
  descriptions on demand.
- Known prompt defects: `<capabilities>` is **double-wrapped**
  (`capabilities_prompt.py:459,478` returns it already wrapped, so every prompt
  has literal nested tags) and the assembled prompt contains **zero worked
  examples**.

## 7. Provider / model routing and model compatibility

- `services/workbench/providers/api_format.py` (195 lines) — `VALID_API_FORMATS`
  = `openaiChat | anthropicMessages | openaiResponses`; **30+ legacy aliases**
  mapped; an unknown value logs a warning rather than failing silently.
  `normalize_provider_base_url` strips only leaf endpoints and **never invents
  `/v1`** — exactly the rule in `AGENTS.md`.
- A provider-level format **plus a per-model override**
  (`providers/resolver.py:49` `apply_model_format_override`, which returns a
  **copy** of the provider dict rather than mutating the shared record). Two
  write doors: `routers/providers.py:813-817` (provider-scoped, correct) and
  `config_service.apply_model_tool_surface:110` (**NOT provider-scoped** — the
  first provider with a matching model id wins, so with two providers sharing a
  model id the probe's "Apply" can land on the wrong provider).
- **Upstream body hygiene is a serializer-layer fix.**
  `models/openai.py:67` `dump_openai_upstream_body` (`exclude_none`; strips
  August-only keys) and `models/anthropic.py:61`. This is the 0.12.21
  `session_id: null` fix. **REAL.**
- **Transport scrub.** `providers/clients/base.py:401` `wireBody` wraps both
  httpx sends, so the credential scrub (matched **by value**, not pattern) covers
  every provider path — workbench, Test button and `/v1` adapters. **REAL.**
- **Per-model capability profile.** `loop/surface.py:130`
  `_modelCapabilityProfile` → `toolSurface` (full/reduced/bare), `maxTools`,
  `maxToolResultChars`, memoised on a 5 s TTL and returning a **copy** so a
  caller cannot write through the memo. `text` mode is fully implemented
  (zero native tools + the `[TOOLCALL]` protocol + an auto-downgrade after a
  tool refusal) — **but it is NOT user-selectable**: the Model-settings
  dropdown offers only Full/Reduced/Bare, and `text` is reachable only through
  the probe's one-click apply.
- **Per-model pricing.** `priceInPerM` / `priceOutPerM` / `free`;
  `cost_estimator.price_for_model` is the **only** pricing source. `0.0` is a
  price, not an absence — only `None` means unset, so nothing on this path may
  use `value or default`. **REAL.**
- **The reasoning-model split is real and concrete.** Anthropic: a thinking
  budget that is a **fraction of the model's own max output** (low .05 /
  medium .15 / high .35 / max .75, with 25 % answer headroom) plus
  `temperature=1`. OpenAI: `reasoning_effort` attached only when the provider
  accepts it (per-model override → format → provider heuristics → family
  table), capped by the model's own max, and **dropped and retried once** when
  the gateway rejects the hint. Reasoning text is **always** preserved across
  tool-loop re-sends even when the UI hides it — required for DeepSeek/Kimi.
  Anthropic's `signature_delta` is captured and re-sent.
- **TWO model resolvers exist with different orders.**
  `providers/model_resolver.py` (alias-first) serves the `/v1` proxy path;
  `workbench/providers.py:355` `resolve_chat_llm` (provider-first) serves chat.
  A plausible divergence.
- **There is NO automatic turn rerouting.** `routing_evidence` is written by the
  Arena/Debate verdict endpoint and read back for ranking; the old
  `AUGUST_AUTO_ROUTE` / `routingSuggestion`-SSE claims were never wired and
  have been removed. **A doc claim that was corrected — do not propose it back.**

## 8. Sandbox

- `services/sandbox/hardline.py` (882 lines) — mode-immune machine rules:
  `_PROTECTED_WRITE_PATTERN` (`:58`), `_CREDENTIAL_READ_PATTERN` (`:103`),
  `_CREDENTIAL_DIRECTORIES` (`:115`), `_CREDENTIAL_STORES` (`:148`),
  `_SSH_PUBLIC_MEMBERS` (`:122`), `check_hardline_command` (`:813`),
  `check_hardline_path` (`:858`), `is_credential_directory` (`:493`), one
  tokenizer `_tokenize` (`:594`), and `_agent_state_reason` (`:275`) which
  covers `.aug/skills`, `.aug/kernel`, `mcp-servers.json`, `automations.json`,
  the brain DB and the proposal store. `check_hardline_command` runs **first**
  in `run_with_best_backend` — before any backend and before the Full-Access
  short-circuit.
- **One tokenizer.** `_tokenize` is the only splitter; `_is_write_intent`,
  `_enumerates_a_directory` and `check_hardline_command` all read through
  `_segments`. A second splitter is a defect, not a refactor.
- **Seven listing doors** must clear the directory before listing
  (`sandbox/paths.py` `listable_root` / `listable_entry` / `listable_child`).
  An eighth door is how the seventh was found. **All seven verified live.**
- **The terminal is gated in both directions**: `writeTerminalInput` runs the
  hardline list on **every** line, outside the workspace test; the `cd `/single-
  token exemption exists only in `_interactive_needs_preflight` (the *soft*
  preflight), never in the hardline gate.
- **The soft layer is substantial, not a stub.** `sandbox/backends/fallback.py`
  has a whole PowerShell-aware policy layer (`_POWERSHELL_EXECUTION_COMMANDS`,
  `_PS_READ_ONLY_CMDLETS`, encoded-payload fail-closed), a segment-scoped path
  containment scan with an app-logs exemption, and a redirect-target check.
  `sandbox/egress.py` is a **real loopback HTTP proxy** that refuses CONNECT
  with 403 when `network=False`, with DNS pinning.
- **On Windows the sandbox is SOFT.** `sandbox/backends/windows.py:207-227`
  always delegates to `run_soft` and forces `enforcement='soft'`; the
  docstring records the OS rejecting `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
  **And there is a reporting bug**: `select_backend_name()` can still report
  `'windows-appcontainer'`, so `enforcement_report()` can claim
  `strong=True, degraded=False` while every command runs as a string-analyzed
  preflight. (Owner decision, 2026-10-21: keep soft, AppContainer opt-in.)
- **The code-mode sandbox is a PORT** of the hardline guard, rendered into every
  code run because it cannot import `app`: `workbench/code_runner.py:413`
  `_GUARD_TEMPLATE` with **26 live tables injected** from the real module
  (`build_runner_source` `:840-891`), probing the **resolved** path. **The
  parity gate that used to check this is GONE** — `AGENTS.md` cites
  `tests/test_code_runner_hardline.py`, deleted with the suite on 2026-10-17.
  A new hardline table missing from the injected list is now **silently absent
  from code mode**. This is a live, un-gated drift risk.

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
- **One policy, one call site.** `compressMessages` has **exactly ONE** call
  site in the whole backend — `loop/recovery.py:202`, inside `_compactionCall`
  (`:150-220`) — reached by **five** paths: the pre-turn auto-compact
  (`workbench.py:2957`), the budget ladder's middle rung (`recovery.py:625`),
  the reactive overflow rescue (`recovery.py:247`), the manual "Free up memory"
  endpoint (`workbench/sessions.py:1618`), and a sub-agent compacting mid-run
  (`workbench/subagent.py:917`). All five pass the same argument list.
- **The cut point is MIXED, and this is the weak spot:**
  - *threshold* (when) is **token-based** — 55 % of the window
    (`recovery.py:120-131`, floor 4096);
  - *head* (what is kept verbatim at the front) is a **FIXED 4 MESSAGES**,
    not scaled to the window (`context_compressor.py:17`) — 4 messages can be a
    third of a 128k budget and 1 % of an 8k one;
  - *tail* is **token-budgeted** at 16 % of the window when the window is
    known, and **count-budgeted (6 messages)** when it is not — the manual
    button deliberately passes `context_window=0`.
- **Kept verbatim:** system messages; the head units; ≤4 **landmark pins**
  matched by unit (the latest `update_state` transition and the latest failing
  receipt); a verbatim **replay of the newest user messages** out of the
  summarized middle under the 12 KiB budget (whole messages only, tool results
  never replayed); the tail. The middle is split into **tool-pair-safe units**
  so a result is never orphaned from its call.
- **The shipped compactor is DETERMINISTIC.** The LLM summarizer is gated on
  the `llm_compactor` feature, **default OFF** (`cognitive_config.py:38`). The
  deterministic summarizer emits a fixed schema and literally writes
  `'- Key decisions: (uncaptured)'` and `'## Next\n(uncaptured)'`
  (`context_compressor.py:641,662`). **In the shipped configuration the
  compaction boundary drops decisions and next steps.**
- **Two routes, chosen from state.** `reliefStrategy` returns `rotate` only when
  brain-config `contextReliefRotate` is armed **and** a `<<compressed_summary`
  note already exists. **`contextReliefRotate` defaults to False**, so the
  rotate route never runs in the shipped configuration.
- **Note-on-note loss** is a stated limit: each note carries its predecessors
  as **600 chars** of prose, and rotate does not fix it.

## 12. Settings and UI shell

- `frontend/desktop/src/settings/settings-registry.ts` declares **45 sections**
  in 4 categories, with `tier: 'basic' | 'hidden'` (19 basic, 26 hidden).
  `auditRegistry()` (`:893`) is a **runtime invariant that throws** — duplicate
  id, invalid tier, a keyword claimed by two sections, a legacy alias claimed
  twice, or an **icon shared by two sections** all fail loudly.
  **All 45 registry ids have an implementation** — `SettingsPage.tsx:365`
  `SECTION_COMPONENTS` has 45 keys, one per id (verified by count). Sections
  are lazy-loaded so the shell does not pull ~30 section modules into the cold
  path.
  `docs/ROADMAP.md:171`, `docs/ARCHITECTURE.md:529` and
  `docs/GAPS_AND_BUGS.md:73` disagree with each other and with the code (they
  say 44/43 and 17/18 basic). **STALE — not this task's problem.**
- `npm run check:design` is **a ratchet, not a linter**: 6 regex families
  (px-type, hex-color, raw-button, raw-fetch, inline-style, raw-status-color)
  diffed against `scripts/design-baseline.json`, whose entries are keyed
  `path:match#occurrence-index` (the index was added because the previous key
  collapsed N identical violations in one file into one entry — appending 8 raw
  `<button>`s to a file still printed "ok"). Current debt: **871 baselined
  violations** (485 raw `<button>`, 97 `style={{`, ~289 hex colours). The gate
  blocks NEW drift only.
- Gates that catch what other gates cannot: `check:sse` (frame vocabulary **and
  handler supply** — the emitter set is *discovered* by scanning for `emit(`
  calls rather than listed by hand, and a comment-only handler body does not
  count as supply), `check:truncate` (TS-compiler-API AST), `check:brain-config`
  (asks the backend which keys it accepts), `check:docs`, `check:design`,
  `check:naming`, `check:api`, `check:api-index`, `check:version`,
  `check:doc-links`, `check:minisign`, `lint:ratchet`, plus `e2e:smoke` — which
  imports the real app, runs its lifespan and asks fifteen questions against a
  **throwaway** data directory.
- `DisclosureRow` genuinely owns its body via the `content` prop at **all five**
  call sites, so the trigger advertises a real `aria-controls` in both states.
  `ActivityGroup` does **not** — its header carries `aria-expanded` with no
  `aria-controls` and the body has no id. A real, still-open inconsistency.
- **There is no test suite** (removed 2026-10-17 at the owner's request).
  Every `tests/…` path in any document is **historical**; verify a claim by
  reading the code it names. Two gates that AGENTS.md still cites as live are
  in that category: `tests/test_code_runner_hardline.py` and
  `tests/test_tool_listing_doors.py`.

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

**1. Memory recall — the weak spot is PLUMBING, not ranking.** The BM25 lane is
complete, correct, cached and invalidated correctly on every write. The
problems are all about whether the model ever *sees* it:
- `memoryAutoInject` defaults **off**, so the per-turn `<memory>` block is the
  **profile lane only** — the whole keyword lane is unreachable in the shipped
  configuration.
- The boot index is **frozen per session** and capped at **40 facts**, so a
  fact written mid-session is invisible until the model calls `list_facts`.
- The write door dedupes on **exact** normalised text; consolidation merges at
  BM25 ≥ 0.85. A **paraphrase is accepted at write time and not merged at
  consolidation time** — it shows twice in recall.
- `_PAIR_SCAN_CAP = 500` — above 500 active facts the duplicate-merge pass
  **returns immediately** and no dedupe happens at all; and the semantic BM25
  pass runs **only if** the cheap key-slug pass found no pairs, so one slug
  collision suppresses the semantic pass for the whole store.
- `use_count` is a **substring test** on the assistant's final message (a fact
  acted on without being quoted never bumps; a fact whose title happens to
  appear in prose bumps falsely).
- `injected_count` only increments on the keyword lane, so with auto-inject off
  the disuse penalty is **always zero** — a real feature on a default-off path.
- `recall_quality` is computed and **never shown**: its only consumer,
  `GET /api/brain/memory/preview`, has no frontend caller.
- `facts` has no FTS index, so a facts search that misses BM25 falls back to a
  LIKE scan.

**2. Tool-call hangs / streaming.** A wedged tool shows a live 8 s heartbeat for
up to **300 s** before the `asyncio.wait_for` fires. A **mid-stream** upstream
stall is bounded only by the 300 s httpx timeout — the 45 s TTFB watchdog is
explicitly **pre-first-token only**, because "once any event was yielded, chunk
gaps mid-generation are never interrupted". The 30 s SSE keepalive keeps the
connection alive but carries **no information**, so the client's idle timers
never fire on a stalled upstream: the user sees activity with no progress. The
per-step shadow-git snapshot is **awaited on the turn's critical path** (up to
~4 × 60 s) to preserve round order.

**3. Subagent scalability.** The deny set, the lineage ceiling and the
permission inheritance are sound and **armed by default**. The gaps are: the
deny set is computed **once at spawn time** and goes stale on a mid-run
permission change; the worker prompt says "do not spawn further sub-agents"
while `_blocked_tools` only withholds the spawn tools when `maxDepth < 2`; a
worker **shares the parent session object**, so two concurrent workers can both
queue an approval banner; and the code-mode `call_tool` bridge reaches the
**full** managed tool surface **without** the sub-agent deny set (safe today
only because code mode is parent-only). The fan-out budget
(`workbench/subagent_fanout.py`) is real — concurrency 4/8, children 8/24,
aggregate round budget 240/2000, slot timeout 600 s — and is undocumented in
`AGENTS.md`.

**4. System prompt bloat.** ~2.5–3.5 k tokens of prompt, and **6 911 tok of
tool definitions — 3× the prompt.** Any idea that trims the prompt but not the
tool surface moves the wrong number. The prompt is string-rebuilt on every
mid-turn surface change, there is no measured ceiling gate, `<capabilities>` is
double-wrapped, and the assembled prompt contains **zero worked examples**.

**5. Model compatibility.** Per-model `apiFormat` and the capability profile
are real and honoured by both wire formats and the `/v1` adapters. The
remaining holes: the **profile write door is not provider-scoped**; **two model
resolvers** with different orders exist; `toolSurface: 'text'` is implemented
but not user-selectable; `/v1/responses` native streaming **does not intercept
managed tools**; and the OpenAI→Anthropic bridge cannot execute managed tools.
Tool arguments are covered by one parse door, but **one of the four
accumulators** (`stream_translate.py:167`) uses `salvage_json_object` directly
and hand-rolls the `{'_raw': raw}` fallback — same effect, **a second door**.

**6. Un-gated drift (a new class).** The **code-mode ↔ hardline parity gate is
gone**. The port is real; the check that the port matches the source is not.
A new hardline table is silently absent from code mode.

**7. Stale comments that would mislead a reader** (each verified against the
code it describes):
- `loop/guards.py:45-46` and `:81-83` say `MAX_MANAGED_TOOL_ROUNDS` is 0
  (uncapped). It is **150**.
- `workbench.py:5848-5852` says the git subprocesses were unbounded. They are
  bounded by `_GIT_TIMEOUT_S` (60 s) at `shadow_git.py:105-120`.
- `settings-registry.ts:7` says 44 sections. There are **45**.
- `workbench.py:1050` says "~29k-char prompt". Not reproducible; unverified.

---

## 15. Prior research this study builds on

| Document | Covers | Status |
|---|---|---|
| `docs/research/2026-10-21-simulide-and-pi-harness.md` | Two full passes over SimulIDE + pi, with corrections and a "must NOT be copied" list | **Reused.** The Phase 2 shards re-read both repos in full, but the ideas below are not re-derived from scratch. |
| `docs/research/2026-10-21-deep-dive-and-cleanup.md` | August architecture, tool/permission stack, memory, gates, dead code | **Reused**, and its 2026-10-21 findings were themselves fixed the same day. |
| `docs/plans/2026-10-05-harness-pattern-gap-analysis.md` | 33-row gap table vs the reference harnesses | **Reused with a 17-day staleness discount.** `MAX_MANAGED_TOOL_ROUNDS` and `_DESCRIPTIONMax` have since changed. |
| `docs/plans/ui-refactor/research/2026-10-03-reference-deepseek-harness.md` | DSH **UI** study from the local install | **Reused for UI claims only** — it is a UI study, not a source read. |
| `docs/plans/2026-10-15-harness-reference-dsbot-abacus.md` | DS Bot + abacus reference dive | **Read in Phase 0**; DSH itself was not read from source until this study. |
