# Harness reference dive — DeepSeek-Bot and abacus (2026-10-15)

Two read-only `Explore` subagents, one per repo, then **every load-bearing citation re-opened by
hand** before anything here was written. Clones live outside the checkout
(`%LOCALAPPDATA%/Temp/dsbot-scan`, `%LOCALAPPDATA%/Temp/abacus-scan`) — never inside the repo, and
nothing from either was executed.

| Repo | What it is | Licence | Verdict for us |
|---|---|---|---|
| `Fei2411/DeepSeek-Bot` | "DS Bot" v0.1-preview, ~54k lines JS — a **plugin for DeepSeek Harness (DSH)** that turns DSH into user-created bots and group chats | Apache-2.0 **with a real `NOTICE` file** | ideas freely portable; porting *code* carries the NOTICE |
| `empero-org/abacus` | Rust TUI coding agent, ~55.7k lines | "Modified MIT with **Attribution Requirement**" — un-removable visible credit | read for design only; vendoring needs an owner decision (recorded 2026-10-14) |

## Confidence labels, used on every row below

- **[V] verified** — I opened the file and read the lines.
- **[R] reported** — the subagent cited it and I did not re-open it. Treat as a lead, not a fact.

## DS Bot mechanisms, ranked for August

1. **[V] Two-route context relief, model chooses the *strategy*, never the permission.**
   `ds-bot/src/host/steward.js` — `linesFor({window, reserve, checkRatio})` computes
   `usable = declared − reserve`, `hard = floor(usable × HARD_SHARE)`, `check = min(usable × ratio, hard)`,
   and `STEWARD_SYSTEM` asks the model to pick `"switch"` (work reached a stopping point → start a
   fresh part with a handoff note) or `"compact"` (half-done → summarize in place). August has one
   deterministic route: `backend-py/app/services/workbench/context_compressor.py:38`
   `COMPACT_TRIGGER_RATIO = 0.80`, applied at `workbench.py:2756` — always summarize in place, so a
   long chat re-summarizes its own summaries. **Delta:** a second "rotate to a fresh session opened
   with a structured handoff note" route. **Cost:** one decision function + one note prompt + one
   brain-config key. **Adopt the design.**
2. **[R] Per-bot working folder gated as a capability widening** (`src/host/folders.js` —
   `cleanWorkDir` resolves with `realpath`, demands an absolute path and a directory, and refuses a
   guarded path; an approval step asks *before* the change lands). August's `create_bot`
   (`bot_mode/roster.py:89-138`) has no work dir; `sandbox/policy.py:90-97` roots at the session
   workspace. **Cost:** one record field + one approval call. **Adopt.**
3. **[R] Deterministic role authority over shared capability definitions**
   (`src/host/capabilities.js` — a non-Main creator may not rewrite something a Main Bot runs).
   August already wrote this and wires it only for subagents:
   `app/services/tools/agent_registry.py:147 evaluateAgentTool`, `:166 _effectivePermissions`,
   imported at `app/services/workbench/subagent.py:25`. The main loop gives every bot the full
   surface. **Cost:** one call in the surface builder. **Adopt — but decide the semantics first**:
   a bot's *conversations* are first-class user-facing sessions in August, not child tasks.
4. **[V, shipped today] Chain budgets on bot-to-bot work.** `src/host/constants.js`: `MAX_HOPS = 6`,
   `MAX_UNATTENDED_MESSAGES = 40` ("reset only by a human"), `MAX_UNREAD_REQUESTS = 10`. August
   caps per-send rounds/messages (`app/services/bot_mode/rooms.py:45` `MAX_ROUNDS = 3`) but carries
   no hop count across forwards and has no team-wide ceiling. **Cost:** one column + two checks.
   **Adopt** — this is the runaway class our loop guards already cover for one agent, not for a
   conversation between agents. *(Shipped as the per-chat unattended ceiling rather than a hop
   column — see "Shipped" below and the decision note there.)*
5. **[V, shipped today] Poisoned-history escape hatch.** `src/host/parts.js` `agent/request-error`: a stuck code,
   or a *second consecutive* `INVALID_REQUEST`, starts a fresh part instead of replaying the same
   history; a `bare` rescue mode drops the newest messages outright. August treats
   `invalid_request_error` as an overflow string only (`app/services/workbench/loop/recovery.py:59`)
   and replays. **Cost:** a counter + one branch. **Adopt** — a session that can never send again is
   a hard user failure, and today it is unrecoverable without manual clearing.
6. **[V, implemented today] Credential-shaped refusal at the memory write door.**
   `ds-bot/src/host/memory.js` keeps `KEY_PATTERNS` and refuses secret-shaped content in a memory
   entry; August already had the same detector — `app/services/hooks/secret_guard.py:14-27`
   `scan_secrets()` — but used it only on tool writes/reads, not on durable memory. A fact is
   re-injected into later turns by the `<memory>` tail and the always-in profile lane, so storing a
   key there publishes it onward indefinitely. Now refused at `memory_store/rest.py save_fact`, the
   one door every fact write passes (the same door that already refuses `project:` scopes and
   cross-scope overwrites), labels never values. See "Shipped" below.
7. **[R] Secrets scrubbed out of every outbound model request** (`src/host/secrets.js` header: a
   value lives in `secrets.json` mode 600, tool results lose it before they are saved, and every
   request has it replaced by `[secret:<NAME>]`). August's guard is tool-boundary-scoped
   (`secret_guard.py` PRE_TOOL_USE scans write args, POST_TOOL_USE redacts reads on protected paths),
   so a secret arriving through another tool result reaches the provider. **Cost:** one function on
   the `dump_*_upstream_body` path. **Adopt with care** — AGENTS.md marks those two functions
   high-risk ("a wrong key breaks all chat"), so it needs a test on the serialized body, not only
   the helper.
8. **[V] A key-free labelled eval plus a scripted provider** (`ds-bot/dev/steward-eval.mjs` — 21
   cases, `--runs`, a score; `dev/mock-llm.mjs` logs system-prompt/tool hashes to confirm shared
   prefix reuse; `dev/bench.sh` forces overflow via `CONTEXT_WINDOW`). August removed harness evals
   by request (`AGENTS.md`), so the only measurement left is telemetry-shaped
   (`turn_outcomes.skill_lift`). **Adopt the shape, dev-only**: it is also the honest way to test
   item 1, which otherwise ships a model-chosen context policy with no measurement behind it.

## Rejected, with reasons

- **[R] Non-blocking group rounds / mid-turn step posting** — right idea, but it needs a
  waiter-registry subsystem; August's `rooms.py` awaits each member deliberately.
- **[R] A synthetic relay turn fabricated inside the stream layer** — assumes a plugin stream hook;
  unsafe in August's SSE path.
- **[R] Model-authored stdio MCP servers behind an approval card** — August refuses that file as
  agent-writable state (`sandbox/hardline.py` `_PROTECTED_WRITE_PATTERN`, `hooks.json` precedent).
- **[R] Group sessions reusing the private chat's prefix to share cache** — leaks private context
  into a room.
- **[R] Single-writer `state.json` lock** — replaces our SQLite source of truth.
- **Licence/safety read [V on files, R on findings]:** no `postinstall`/install hook, no
  `curl | sh`, no telemetry, one delayed opt-out-able version check; **no model-judged permission —
  models choose strategy and memory content only.** That matches our stricter invariant
  (`workbench/permissions.py`: a model flag can force an ask, never an allow), which must stay.

## abacus, re-checked against today's tree

| Item | Verdict | Evidence / where it lands |
|---|---|---|
| `eval --state both` (measured lift) | **PARTIAL** | `turn_outcomes.py:622 skill_lift()` already computes ok-rate-with minus without from real turns ("no evidence ≠ 0.0"), consumed by `capabilities_prompt.py:334` and pinned by `tests/test_skill_relevance_prior.py:227`; `app/bench/cli.py` runs one task in one memory state. So the *measurement shape* exists; the two-arm suite does not, and golden harness evals were removed by request. |
| Microcompact, subject recoverable | **PARTIAL** | `context_compressor.py:209 pruneToolOutputs` blanks old results; `_splitUnits:270` keeps the assistant call+args verbatim, so tool *calls* survive. Gap: `CLEARED_MARKER:33` names nothing, and no model-facing tool resolves `tool_call_id` → archived bytes. |
| Append-only per-layer context with `(cleared…)` markers | **ABSENT — deliberate** | August freezes the boot index and volatile-tails the rest on purpose (`workbench.py:954-1049`, `prompt_segments_cache.py:70-74`, `tests/test_prompt_cache_stability.py`); item 3 would re-read ~29k cached prompt bytes per turn. Decline. |
| Reflection **before** compaction erases evidence | **PARTIAL, real gap** | **[V] Verified by me:** compaction does `session.messages = list(compressed)` + `saveSessions()` (`workbench.py:2819-2826`) and `memory_store/sessions.py:212` states "A row the snapshot no longer contains IS deleted"; meanwhile `skill_distiller._reviewWindow:1539` reads `messages WHERE id > cursor`. An append-only archive of exactly that content already exists (`app/services/transcript_archive.py`, written at `workbench.py:2778`) but only `routers/workbench.py:2248` reads it. So a review pass over a compacted session silently skips the erased middle. |
| Cheap gate before the expensive proposal call | **PARTIAL** | Deterministic pre-filters exist (`consolidation.py:956`, `skill_distiller.py:1677/1812` cooldown, `episode_miner.py:593`); a cheap *model* gate does not exist, and `_cooldown_batch`/`_record_judge_success` assume one call per batch. |
| Tripwires recalled into the tool result with decay | **ABSENT** | Result injection exists (`workbench.py:5080`, `tool_guardrails.py:115`); decay lives in prompt layers on purpose (`fact_retrieval.py:238`). Highest risk of the six: the episode miner's injection filter is prefix-only (`episode_miner.py:147`), so a mid-result tripwire would be mined as model content and re-filed. |

**Subagent citation errors I caught and fixed:** it placed the archive at
`app/services/workbench/transcript_archive.py` (it is `app/services/transcript_archive.py`), and
described `secret_guard` as "path-scoped and post-tool only" when it also scans **write**
arguments pre-tool. Both corrected above; neither is a small class of mistake — one is a path that
would not import, the other understates an existing control before proposing a new one.

## Shipped from this dive

`backend-py/app/services/memory_store/rest.py` — `save_fact` now refuses secret-shaped content at
the door, reusing `hooks/secret_guard.scan_secrets`, raising `ValueError` like the door's two
existing refusals so every caller (the memory route, the batch route at `routers/august.py:739`,
`harness_promote.py:357`) already handles it. New `tests/test_memory_secret_door.py`: refuses value,
title and description shapes; still accepts ordinary content; and the message never echoes the
secret. **Red-proved**: with the guard short-circuited, 3 of the 4 fail; restored, 4 pass.
Neighbours unaffected — `test_memory_review_pass`, `test_skill_relevance_prior`,
`test_prune_then_compact`, `test_gate_participation` 90 passed. `ruff` and `mypy` clean on both
files.

`backend-py/app/services/workbench/loop/recovery.py` + `workbench.py` — **DS Bot item 5, the
poisoned-history escape hatch.** August already kept a deterministic 400 out of the retry policy,
which is the correct half and the reason the other half was invisible: an identical request would
fail identically, but the *next turn* sends the same `session.messages`, so one orphaned
`tool_use_id` surviving into persisted history bricked the chat and only deleting the session
escaped it. The ladder is a function of data the loop already writes — the trailing run of
`ok=0, error_class='bad_request'` rows for that session in `turn_outcomes` — so it needs no new
column, no new state key and it survives a restart. Refusal 1 is left alone (the reference's own
rule: "a provider may turn down one request for reasons of its own"); refusal 2 flattens the tool
pairing into text and keeps the whole conversation; refusal 3 sends only the newest user ask; at 4
nothing fires, so the turn fails honestly rather than discarding more transcript. The archive is
written before every rung, each emits `recovery {kind:'stuck-request', outcome, degraded:true}`
plus a warning whose refusal count is computed from the ledger rather than asserted, and
`_stripToolsFromHistory` gained one `note=` parameter rather than a second copy — the two rescues
must not tell the model the same thing, since one drops the tool surface and the other keeps it.
Overflow stays on its own ladder: `classify_error` matches `context_overflow` before
`bad_request`, and the branch additionally refuses anything `_isContextOverflowError` claims.
New `tests/test_stuck_request_escape.py` (17): streak semantics (a clean turn, a rate limit and a
sub-agent fan-out row each behave as documented), the two surface builders, the four-step
escalation bound, plus a real managed-loop case that asserts on the **retry wire body** (no
`tool_use_id`, no tool-role message, the receipt text still present) and that the reduced surface
was persisted so the next turn cannot re-send the poison. Its control case asserts that a single
refusal still ends as an ordinary error with no reshape. **Red-proved**: with the branch condition
forced False, the loop case fails at `callCount == 1` — one refusal and no repair — and the two
control cases still pass; restored, all 17 pass. Neighbours: compaction-parity, runaway-backstop,
overflow-probe, turn-ok and gate-participation together 104 passed. `ruff check .` and
`mypy app/` (339 files) clean. Whole backend suite: 5380 passed, 5 skipped, 20m38s on 16 cores.

`backend-py/app/services/bot_mode/dm.py` + `brain_config_service.py` + the Settings panel — **DS Bot
item 4, the chain budget for bot-to-bot work.** Measured before writing: August had two caps and
neither covers the class. `has_inflight(from→to)` bounds one *pair* of concurrent DMs,
`rooms.MAX_ROUNDS` bounds one *user send* in a group room, and the loop's stall/runaway guards count
world delta inside **one turn** — while every DM hop is a fresh turn in a **different session**, so
`A→B→C→A` is none of the three and every turn in it ends `finished`. Only the prompt forbade it
(`message_agent`'s own description: "Do not ping-pong"), which is nondeterminism on the runaway path.

**Decision, flagged for the owner:** the reference's `MAX_HOPS` needs a counter that *travels with
the message*, and August's wake is not a DM row — the sender-wake turn is appended text inside the
same chat, so a hop count cannot be derived from `bot_dm` without threading depth through
`deliver()` and tagging the wake. The **per-chat unattended ceiling** (the reference's
`MAX_UNATTENDED_MESSAGES`, whose comment is the whole design: "reset only by a human") bounds the
same class with no new column: every hop is a turn in some Bot's chat, and a chat that may not keep
working unattended stops the chain wherever it arrives. Cost: one brain key, one read door, one
check. `MAX_UNREAD_REQUESTS` (an inbox backlog ceiling) is **not** built — an unread DM backlog in
August is a queue depth, not a runaway, and arming it would refuse delivery rather than refuse work.

`_unattendedRun` reads the persisted `messages` table (the arriving Bot message is already flushed
at the model-dispatch barrier, so the guard sees the turn it is being asked about, and a restart
cannot launder a runaway), stops at the first human row, and scans at most `ceiling` rows. A row is
Bot-authored when it starts with `BOT_TURN_PREFIX` — now the single constant both the DM body and
the sender wake are built from, so a new inbound author kind that skips it silently never counts — or
when `messages.source` names a machine source (migration 049). The content column is JSON-encoded,
so it is decoded first: a raw prefix comparison would find no human row ever and turn a guard into a
lockout — the trap AGENTS.md already records for the fact/KV read doors, and its own test case here.
The ceiling guards the **model's** send door, not the store: `POST /api/agents/dm` delivers what a
human asked for and a human send is the reset, so gating the route would be a lockout;
`test_the_human_route_is_never_gated` pins that asymmetry.

`maxUnattendedTurns` is registered through all three doors a numeric brain key needs — `numKeys`, a
`fieldTable` entry defaulting to `None` (absent, not 0, so an armed ceiling is distinguishable from
a disarmed one) and an explicit `unattendedTurnsRange` branch, because the validator's fallback
range starts at 1 and would make the disarming write invalid. That is the exact defect
`tests/test_turn_limits_fields.py` exists to catch, and it now pins the new key against the Settings
panel (`TurnLimitsSection.tsx` + the `BrainConfig` TS field) rather than trusting the copy.
New `tests/test_bot_unattended_ceiling.py` (18) covers the counting semantics (five provenance
cases including the JSON-encoding control and a human quoting a Bot), the writer/reader prefix
parity, the door at 2/3/9 turns, the human reset, the ungated human route, and **reachability
end-to-end through `saveBrainConfig`** — a guard nobody can arm is a guard that does not exist.
**Red-proved**: with the door's ceiling forced to 0, exactly the three enforcement cases fail and
the measurement cases still pass; restored, all 18 pass.

## Reviewer round on the two shipped items

Two review agents (design quality + runtime correctness) were pointed at both
changes; every claim was re-checked in the code before acting. Four were real and
are fixed, and each is now pinned by a test that fails when the fix is reverted.

1. **The provider's reason was being thrown away before the loop saw it**
   (`stream_translate.py`). `as_str` returns `''` for a dict and the standard
   `{'error': {'type': ..., 'message': ...}}` envelope nests, so the aggregator
   produced `Stream error HTTP 400: ` with an empty body — and that single string
   is everything `classify_error`, the deterministic-400 replay decision, the new
   ladder and the user's receipt read. Found because the shipped loop test
   stopped repairing: with no marker in the text the ladder correctly declined.
   `_errorEventText` now flattens dict/list bodies. (This is why the reviewer's
   "the ledger sees a flat field while the detector sees a nested one" claim was
   half right: the nesting was being lost one layer earlier, at extraction.)
2. **Flattening an assistant round that was only tool calls left `content: []`,**
   which `translateMessagesToAnthropic` re-renders as an empty text block — an
   upstream 400. So the flatten rung would ship a request refused for a *new*
   shape reason and, being once per turn, could not try again. Fixed inside
   `_stripToolsFromHistory` via `_isBlankAssistantContent`, which repairs the
   pre-existing tools-fallback path too (it had the same hole).
3. **`MACHINE_SOURCES` includes `queued_user`, which IS the human speaking**
   (mid-turn queued text wrapped in `<queued_message>`). Reusing that set meant a
   human reply would *extend* the unattended run it exists to end. Replaced with
   a declared `_NON_HUMAN_SOURCES` subset, so a new plumbing source defaults to
   "human" (lenient) rather than to lockout.
4. **Two precision defects in the ladder's inputs:** the scan window is rows, not
   turns, and sub-agent fan-out rows share the session id, so eight of them newer
   than the refused turns read "not stuck" and an orchestrator chat never
   repaired (window widened, count short-circuits at 3); and `classify_error`'s
   bare `400` arm makes a bad model name or an oversized image look like a broken
   pairing, so the shape marker table is now a second required leg — which meant
   moving `_DETERMINISTIC_400_MARKERS` into `loop/recovery.py` (one table, two
   doors: the retry policy re-exports it).

Claim checked and **not** acted on: that `deliver()` and `POST /api/agents/dm`
bypass the ceiling. They do not start Bot-initiated hops — the turn they run
still has to call `message_agent`, which is the gated door — and the human route
is the reset by definition, so gating it would be a lockout. The reviewer's
related point that `automation_memory.deliver_to_bot_chat` can keep a Bot chat
busy without any DM is **true and out of this item's scope**: the ceiling bounds
Bot→Bot chains, not scheduled routines. Also true and unfixed by design here:
`subagent.py` runs its own retry loop with no shape repair, so a poisoned
*sub-agent* history still just fails.

Wording fixed after measuring, not assuming: the warning no longer claims
"nothing was deleted". The reduced surface is what turn close persists, so after
the bare rung the older turns stop being sent *and* stop being shown in this
chat; they survive in `transcript_archive`, which this chat does not render.

Verification after this round: the two feature files plus the neighbours that
read the same code (`error_families`, `overflow_probe_shapes`, `turn_ok`,
`part26_wave2`, `workbench_retry`, `compaction_policy_parity`,
`runaway_backstop`, `bot_mode_phase_c`, `gate_participation`, `log_stream`,
`dump_upstream_body`, `brain_config`, `turn_limits_fields`) — 206 passed.
`ruff check .` and `mypy app/` (339 files) clean; `check:design` unchanged at the
964 baseline; `check:docs` 6/6; the Settings panel test 6 passed. Whole backend
suite: **5406 passed, 5 skipped, 1 test recorded as failed by a crashed xdist
worker** — `test_remaining_regressions.py::test_a_large_file_does_not_arrive_whole`
writes a 200 MB fixture and measured **241.7 s passing on its own**, so under
`-n auto` on this machine the worker dies on resources, not on this diff (no
changed file is on the `read_file` paging path). Flagged because a green suite is
the claim this project makes about itself, and this one was not green: it is a
load-sensitivity bug in that test, the same class AGENTS.md already documents for
the WAL and round-snapshot races.

## Next, in value-per-risk order

1. **Review-from-archive** (abacus item 4) — **attempted today, larger than it reads, and that is
   the finding.** The hole is confirmed: `workbench.py:2819-2826` writes the compacted projection
   through `saveSessions()`, `memory_store/sessions.py:212` states that a row the snapshot no
   longer contains **is deleted**, and `skill_distiller.py:1539 _reviewWindow` reads
   `messages WHERE id > cursor` — so the erased middle is never reviewed, while the archive that
   holds it (`app/services/transcript_archive.py`, written at `workbench.py:2778`) is read only by
   `routers/workbench.py:2248`. But the review pass is **id-keyed end to end**, in three places that
   a fallback has to satisfy at once: `_reviewTarget` selects a session only when
   `MAX(messages.id) > cursor` (so a session whose unread content lives only in the archive is never
   even chosen); the rendered lines carry `[message id]` markers the judge is told to return as
   `episode`s; and `apply_verdict` fingerprints `review:<sessionId>` per episode. Archived
   snapshots are `{reason, count, messages}` dicts with **no ids**, so a real fix needs a durable
   per-session archive position *and* a synthetic-episode namespace that cannot collide with
   message ids — a cursor-semantics change, not a fallback branch. Next attempt should start from
   `parse_verdicts`/`apply_verdict` (`skill_distiller.py:1591-1612`) and the migration that would
   carry the archive watermark, and must preserve the two stated invariants: an empty window still
   advances the cursor, and the `messages` table stays the single transcript authority.
2. **Rotate-vs-compact steward** (DS Bot item 1) — and build item 8's dev-only eval **first**, so a
   model-chosen context policy ships with a measurement rather than a vibe.
3. **The two DS Bot chain budgets deliberately not built** (item 4, Needs review): a travelling
   `MAX_HOPS` counter — the ceiling above bounds the same class without it, and a hop count cannot be
   derived from `bot_dm` because the sender wake is not a DM row (it would have to be threaded through
   `deliver()` and tagged); and `MAX_UNREAD_REQUESTS`, because an unread DM backlog in August is a
   queue depth rather than a runaway, and arming it would refuse *delivery* instead of refusing
   *work*. Say so if you want either anyway.
4. **Outbound secret scrub** (DS Bot item 7), tested on the serialized body.
