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

1. **[V, shipped today — deterministic, not model-chosen] Two-route context relief.**
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
7. **[V, shipped today] Secrets scrubbed out of every outbound model request** (`src/host/secrets.js` header: a
   value lives in `secrets.json` mode 600, tool results lose it before they are saved, and every
   request has it replaced by `[secret:<NAME>]`). August's guard is tool-boundary-scoped
   (`secret_guard.py` PRE_TOOL_USE scans write args, POST_TOOL_USE redacts reads on protected paths),
   so a secret arriving through another tool result reaches the provider. **Cost:** one function on
   the `dump_*_upstream_body` path. **Adopt with care** — AGENTS.md marks those two functions
   high-risk ("a wrong key breaks all chat"), so it needs a test on the serialized body, not only
   the helper.
8. **[V, shipped today] A key-free labelled eval plus a scripted provider** (`ds-bot/dev/steward-eval.mjs` — 21
   cases, `--runs`, a score; `dev/mock-llm.mjs` logs system-prompt/tool hashes to confirm shared
   prefix reuse; `dev/bench.sh` forces overflow via `CONTEXT_WINDOW`). August removed harness evals
   by request (`AGENTS.md`), so the only measurement left is telemetry-shaped
   (`turn_outcomes.skill_lift`). **Adopt the shape, dev-only**: it is also the honest way to test
   item 1, which otherwise ships a model-chosen context policy with no measurement behind it.
   *(Shipped as `scripts/harness_eval.py` — rails + `--judge`, no scripted provider; see "Shipped"
   below, which records the defect it found on its first run.)*

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

## Reviewer round on the first two shipped items

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

## Shipped: the outbound credential scrub

`app/services/hooks/secret_guard.py` gained `scrubOutboundBody`, wired into BOTH serialization doors
(`models/openai.py` / `models/anthropic.py` `dump_*_upstream_body`). It replaces every credential
value this install holds with `[secret:<NAME>]`, longest value first, walking string leaves only.

Why the tool-boundary guard wasn't enough: it denies a secret-shaped *write* and redacts a
protected-path *read*, but a key that reaches the transcript by any other route — pasted by the
user, quoted from a log, printed by a command whose path looked harmless — is then re-sent to
whichever gateway is active on every later turn. That is the loop the reference closes at the
request door.

**Matched by value, never by pattern**, and that is the load-bearing choice: this is the one
serialization path every chat request takes (AGENTS.md: "a wrong key breaks all chat"), so a
pattern scrub would rewrite key-shaped text a user pasted precisely to ask why their own key 401s.
`test_key_shaped_text_the_user_pasted_survives` is the control for that;
`test_an_install_with_no_credentials_is_byte_identical` is the control for inertness;
`test_a_credential_shorter_than_the_floor_is_ignored` is the control against substring mangling.
Reads that fail are logged at warning rather than swallowed — a gate that silently saw no
credentials is the same blindness class as the error envelope fixed above. The cache busts through
the store's own invalidation callback (`saveProvidersStore` already fires it), tested by writing a
rotated key through the real door, not by clearing the cache by hand.

**What was not copied:** the reference keeps its secrets in one `secrets.json` with a name per
entry, so a name-based replace is exact there. August's credentials live in `providers.json` (one
key per provider), `settings.gatewayApiKey` and dev-installed env vars, so the door enumerates
values from three sources and names each label by the provider the user chose. A key held only in
an OS keyring is out of reach here — the door scrubs what the app can actually read, and says so in
its docstring rather than claiming a guarantee it cannot make.

New `tests/test_outbound_secret_scrub.py` (10), asserting on the **serialized body**. **Red-proved**:
with the OpenAI door's call removed, 5 fail (and only the OpenAI-side ones — the two Anthropic-door
cases keep passing, which is the correct shape for a one-door toggle), while the three negative
controls still pass. `ruff check .` and `mypy app/` clean; `test_dump_upstream_body` goldens
unaffected; whole backend suite 5416 passed / 5 skipped in 21m34s, with the 200 MB paging test
included and green this time.

## Second reviewer round: the door was in the wrong place

A second pair of agents reviewed the ceiling and the scrub. Six claims were
verified in the code and fixed; each is now pinned by a test that fails when the
fix is reverted (revert-toggle runs recorded below).

1. **The scrub's door was the serializer, and the main path does not pass through
   it.** The workbench calls `dump_openai_upstream_body(ChatCompletionRequest(model))`
   — an empty skeleton — and assigns `body['messages']` afterwards
   (`workbench/providers.py:731-735`); the `/v1` proxy appends tool results after
   its dump and re-sends; `buildAnthropicUpstreamRequest` never calls the dump at
   all. `BaseProviderClient` has exactly two `self.client` calls, so the door moved
   to `wireBody` at those two sends and the dump-level calls were removed. Red-proof:
   with `wireBody` unwired, 9 tests fail — and the 7 that still pass are exactly the
   negative controls. Tests now drive a real client through `httpx.MockTransport`
   and assert what the provider would receive, plus a case reproducing the
   assign-after-dump shape that defeated the first version.
2. **A per-leaf `os.stat`:** the cache stamp was read inside the recursion, so on a
   641 KB body with 1,001 string leaves the scrub cost **419.6 ms** against
   **1.94 ms** once the set is resolved once per body (both measured here, same
   fixture; the `json.dumps` that follows the dump costs 5.9 ms).
3. **The gateway key's rotation busted nothing.** It is minted through
   `saveConfig`, which fires no invalidation callback and does not touch
   providers.json, so a rotated key would ship forever. The stamp now covers
   providers.json AND config.json; and because `saveProvidersStore`'s callback is
   the only other trigger, an EMPTY result is no longer cached — a transient read
   failure used to switch the gate off silently until restart.
4. **A two-way "Bot or human?" read disarmed the ceiling.** Compaction writes its
   `<<compressed_summary` block as a **user** row with no `source`, so the summary
   counted as the human having spoken — in exactly the long chats compaction
   exists for. `_turnAuthor` is now tri-state (a machine row neither counts nor
   resets). Red-proof: making machine rows fall through breaks precisely the two
   tests that pin it.
5. **The env sweep was too wide to ship.** Including `*_PASSWORD`/`*_SECRET`
   rewrote a database password the user pasted *on purpose* (write this into my
   .env) out of every later request. Collection is `*_API_KEY` only;
   `test_a_database_password_in_the_env_is_deliberately_NOT_scrubbed` pins the
   reason.
6. **`_extract_upstream_error_message` could return nothing.** `as_str` on a
   doubly-nested envelope is `''`, so the user got `Upstream provider error` for a
   refusal that had named its reason, and the shape ladder saw no marker. It now
   serializes the envelope instead of returning empty.

Checked and **not** acted on: that the scrub should also cover base64/escaped
forms, and that a model can quote `[secret:NAME]` into a file — both are now stated
as limits in the docstring and AGENTS.md rather than papered over, because closing
the first means rewriting sibling leaves and the second is already blocked at the
write door. `provider_credentials.invalidate()` genuinely does not fire callbacks
(documented in the stamp comment); `saveProvidersStore` is the only providers.json
writer (16 call sites measured, all through it).

Verification of this round: the whole backend suite green on its own marker —
5424 passed, 5 skipped in 29m19s on `-n 8` (`-n auto` had oversubscribed the
machine while the two review agents ran and killed an xdist worker on the 200 MB
paging fixture; the same test passes alone in 242 s, and it is in the suite's
green run here). `ruff check .` and `mypy app/` (339 files) clean, `check:design`
unchanged at the 964 baseline, `check:docs` 6/6.

## Shipped: the dev-only eval (DS Bot item 8)

`backend-py/scripts/harness_eval.py` — 13 labelled cases, run through
`parse_verdicts` then `apply_verdict` in an isolated data directory, scored on
BOTH the returned label and the side effect (proposals filed, facts written),
reported as per-case **count deltas** rather than absolute counts so the fixtures
can share one store. `rails` mode is the default and costs zero tokens;
`--judge --provider X --model Y --confirm-tokens` sends the real
`build_judge_prompt` for the same cases through `call_judge` and scores the
model's action against the label — opt-in twice over, because it spends a real
key, and it overrides `sd.resolve_judge` in-process rather than inventing an env
var. A flipped case there is a prompt-contract change, not a test failure.

It paid for itself on the first run: `memory-secret` crashed the pass instead of
returning `rejected-write-door`. `save_fact`'s refusal is a `ValueError`, and
both batch callers loop `for v in applicable: apply_verdict(...)` with no
try/except of their own, so one secret-shaped lesson used to take the rest of the
batch with it AND skip the state each loop writes afterwards — the review pass's
`_setReviewCursor`, the episode pass's `set_judge_verdict` — leaving the same
window unreviewed and re-crashing on every future pass. `apply_verdict` now
catches it, notes the drop through `_noteMemoryDrop` and returns
`rejected-write-door`, so one bad verdict costs exactly one verdict, which is the
rule `parse_verdicts` already holds at every other door.
`tests/test_memory_secret_door.py::test_a_refused_lesson_costs_one_verdict_not_the_whole_batch`
pins it; red-proof: swapping the clause to `except ZeroDivisionError` makes the
`ValueError` escape and that test fail, and the restore was verified by hash.

The same sweep touched `harness_promote.apply_promotion`, and the honest framing
matters: that one is **not** a crash fix. A function-wide `except Exception`
already caught the refusal and returned `{'ok': False}`, so all the new inner
clause does is name the door (`stores refused the write: …`) instead of dropping
a refused credential into the same `promotion failed: …` bucket as an absent
workspace. The inbox row a human reads is the surface that benefits, and
`test_a_refused_promotion_names_the_door_not_the_generic_failure` says so.

Verification of this item: `13/13 cases behaved as labelled` (exit 0),
`tests/test_memory_secret_door.py` 6 passed, `ruff check .` and `mypy app/`
clean.

## Shipped: two-route context relief (DS Bot item 1)

`reliefStrategy` returns `compact` or `rotate`. The strategy is read from state,
not from a model asked to judge its own conversation: DS Bot's `steward.js` hands
the model the switch/compact choice, but in August the two signals that decision
needs are already on disk — whether a `<<compressed_summary` note exists, and the
token ratio. A model-chosen route would also have to be trusted not to rotate
mid-task, where the mid-task detail is exactly what the lossy note loses.

Compact-in-place kept the first four messages verbatim **forever**. From the
second relief onward that means the note's `Goal` is built from a follow-up turn
(the original ask is outside the summarized span) while earlier decisions survive
only as the 600 characters of prose the previous note squeezed out of itself —
loss applied to loss. Rotating keeps no head, so the opening moves into the
span the note is summarized from and names the task again; the ask itself is
claimed back verbatim first, inside the existing `REPLAY_USER_BUDGET_BYTES`, and
the newest turns are what a mid-task rotation actually needs. Both halves of that
trade are pinned, including the case where the opening alone exhausts the budget.

**Built the census, not the claim.** `_compactionCall` documents itself as "THE
compaction policy — one site, shared by every path that compacts". Writing the
gate that counts its call sites found **four** paths, not three: the pre-turn
auto-compact called `compressMessages` inline with the same arguments (faithful,
but a duplicate nobody reconciled — and the existing parity test could never see
it because it compared the two recovery paths against *each other*), the manual
"Free up memory" endpoint passed only threshold/head/tail, and a subagent
compacting mid-run passed only a threshold and the pin predicates. So a subagent
got the heuristic summarizer, a count-budgeted tail, no tool-output prune, no
landmark pins and no verbatim replay of the user's own words, and the button a
human presses produced a different summary than the loop would have. All five now
share the site; the button's deliberate `threshold=0` forcing is preserved through
`thresholdOverride`. The gate's first assertion is that the census is non-empty,
because a scanner that matches nothing passes. It measured 3 sites before the
consolidation and 1 after — that failing run is the red proof.

Also fixed on the way: the budget path reported `compressedCount` as the messages
*remaining* while the pre-turn path reported those *removed*, and the chat card
renders that number as "summarized N messages".

**Needs review (yours to decide, not built):** the route has **no Settings
switch** — `contextReliefRotate` is armed by editing `{appData}/data/config.json`
only, verified by 0 frontend references to the key. Boolean brain keys are
hand-written switches in `MemorySection.tsx`, not generated from `fieldTable`, so
this needs a placement decision: a switch beside the memory gates, one beside the
composer's context readout, or nothing (a developer-only knob, like the eval). The
`compaction` frame also carries a new `relief` field that the zod schema strips
(z.object is not `.strict()`, so nothing breaks but the card cannot show the
route); surfacing "re-anchored on a fresh note" instead of "kept the first 0"
requires the schema + `streamEvents` + `CompactionNoticeCard` edit and a
running-app check.

Verification: `ruff`, `mypy` (339 files) clean; `tests/test_context_relief_rotate.py`
14 passed, `test_compaction_policy_parity.py` 10, `test_brain_config.py` +
`test_turn_limits_fields.py` + subagent/session-ops/policy files green. Two
fixtures were caught asserting on a transcript that never compacted at all — a
20-turn/1200-char fixture and an explicit `len(out) < len(msgs)` guard is now the
house rule in this file.

## Third reviewer round: on the eval itself

A design-quality agent and a runtime-correctness agent reviewed the eval and the
write-door fixes. Everything below was re-derived in code before being acted on;
two of their claims did not survive that check and are recorded as disproved.

Fixed, each verified by running it:

1. **A typo in `--only` was a green run that measured nothing.** `return 0 if
   passed == len(results)` made an empty selection print
   `0/0 cases behaved as labelled` and exit 0. Now an unknown case id lists the
   known ones and exits 2, and a run with zero executed cases exits 2 rather than
   reporting success.
2. **`--judge` had never reached a model.** It ran inside the same throwaway data
   dir as rails mode, so the provider store it needs was empty, `resolver.resolve`
   returned None and every case came back `no-answer` — a harness that looks like
   it is scoring a model while scoring its own isolation. Judge mode writes nothing
   (it reads config, asks one question, scores the answer), so it no longer
   isolates.
3. **Judge mode had nothing to judge.** `_episode()` fed every case the same
   placeholder excerpt (`case thin-rule: the ask, in the user's words`), so the
   model was asked to distil a stub. Each judged case now carries its own events,
   and a case whose subject is a door or a mode is reported `SKIP … not judgeable`
   instead of being scored as noise.
4. **`python scripts/harness_eval.py` died.** The `sys.path` bootstrap sat at the
   end of `main()`, *after* `_isolateData()` had already imported `app.config` —
   dead for `-m`, a `ModuleNotFoundError` for the direct form. Moved to module
   scope, and the script is wired as `npm run eval:harness`, because the repo's
   own convention is that an unprefixed `scripts/*.py` is npm-wired and a `_`
   prefix marks an unwired one.
5. **21 leaked temp dirs.** The throwaway home was deleted with
   `ignore_errors=True`, and on Windows an open SQLite handle makes `rmtree` fail
   *silently*. Measured: 22 dirs survived. Closing the store before the delete
   fixes it (verified: the count no longer grows) and the path is now printed if a
   handle still wins, so a leak is visible rather than inferred.
6. **One event class, three labels.** `apply_verdict` returned
   `rejected-write-door` for a refused memory verdict while two proposal doors
   returned bare `'refused'` for the identical event (a `ValueError` from a store
   write). Unified to one label; `learning_scheduler`'s `kept` counter is an
   allowlist of `memory-saved`/`proposal-filed`, so no consumer read the old name.
   The two proposal sites have no test of their own — the rename is not covered by
   a case that makes `save_proposal` raise.

Disproved, and left alone:

- **"The two modes encode opposite correctness, so judge mode passes a wrong
  answer."** For `thin-rule` they are both right at different layers: the judge
  *should* answer `create_skill` (drafting is its job) and the door *should*
  downgrade the thin draft to a memory. The eval now says exactly that in the
  case's own note rather than forcing one expectation on both.
- **"Rails mode may not isolate the brain DB."** It does. The reviewer's premise
  about the real data dir was also wrong — it is `C:/Dev/august-proxy/data` (from
  `_findProjectRoot()`), not `backend-py/data`, which does not exist. Verified the
  strong way: all 315 files under the real dir hashed before and after a run, no
  change; then a decoy `AUGUST_DATA_DIR` with `app.config` and four service
  modules imported *first* still produced zero files in the decoy, and
  `AUGUST_BRAIN_SQLITE_FILE` — a separate key the review flagged as possibly
  missed — is set by `_isolateData()`.

Verification of this round: `ruff` and `mypy` (339 files) clean, 13/13 rails via
`npm run eval:harness`, `--only thin-rules` exits 2, direct invocation exits 0,
temp dirs no longer accumulate, and 129 distiller/quality/secret-door/learning
tests pass.

## Fourth reviewer round: the consolidation was not actually one policy

Two agents reviewed the rotate commit. Five claims were verified in code and acted
on; the commit's own sentence "All five now share the site" turned out to be true
about the CALL and false about the POLICY, which is the kind of thing a site census
cannot see.

1. **The manual endpoint passed `context_window=0`** while being consolidated, and
   `0` is not "size unknown" downstream — `_compactionCall` maps it to
   `contextWindow=None`, which selects the count-budgeted six-message tail instead
   of the token-budgeted tail every automatic path uses. So the button ran a second
   policy *through* the shared site. It now resolves the model's window. The census
   gate counted 1 site and the parity assertions compared the two recovery paths;
   neither could see it, so the new gate reads ARGUMENTS
   (`test_no_path_hands_the_shared_site_a_zero_context_window`) — proven red by
   putting `context_window=0` back, restore verified by hash.
2. **Rotate carried an oversized opening regardless of the replay budget.** The byte
   guard only gated the *newest* turns, so a pasted spec larger than
   `REPLAY_USER_BUDGET_BYTES` was kept verbatim, bought the whole budget, replayed
   nothing else and could leave the relief freeing too little to be worth running.
   Now such an ask stays in the summarized span (and still reaches the note's Goal).
   Proven red by neutralizing the cap.
3. **The pre-turn path archived the transcript AFTER the projection prune** — found
   while checking the reviewer's claim about double pruning. `archive_messages`
   stores exactly what it is handed, so the snapshot held
   `[Old tool result content cleared]` where the old tool outputs had been, and
   compaction then persisted the reduced list. The content existed in neither place
   while `CompactionNoticeCard` tells the user "The full transcript is archived".
   It now archives the unpruned list; the projection prune still applies to the
   turn, and the second prune inside `_compactionCall` is idempotent by design.
   No test drives the pre-turn function, so this is pinned by a source-ordering gate
   with an explicit "the gate lost its target line" guard on both lookups.
4. **Two limits of the route are now stated in `reliefStrategy` instead of implied**:
   it resets head staleness, not note-on-note loss (each note still carries its
   predecessors as 600 characters of prose — closing that needs a durable handoff
   store, not a flag), and because `_isSummaryMessage` matches the fenced shape in
   any role, a transcript that pastes a genuine note rotates on its first relief.
5. **`reliefHeadCount(rotate) == 0` is reported to the frame while the opening is
   present verbatim**, so the number is "messages kept from the head span", not
   "verbatim messages". Left as-is and named, because changing it would make the
   frame disagree with the `head_count` the compressor actually received.

Verification of this round: `ruff` clean, `mypy` (339 files) clean, rotate + parity
gates 27 passed, and the full backend suite re-run after these edits (the earlier
run was invalidated by them).

## Shipped: the review pass can read the transcript compaction erased (abacus item 4)

The hole, confirmed by reading the save path rather than trusting the plan: compaction
persists the reduced projection through `saveSessions()`, and
`memory_store/sessions.py:200-216` states that a row the snapshot no longer contains
**is deleted**. The review pass read `messages WHERE id > cursor`. So the middle every
compaction folded away was deleted from the only table the pass could read, while the
archive that still holds it was read by exactly one HTTP route. A long session was
learned from only at its head and tail — the two regions compaction never touches.

**What made this tractable was the archive fix two commits back.** Reviewing an archive
of already-pruned projections would have taught the loop from
`[Old tool result content cleared]`.

Design, chosen to preserve the two invariants the review pass already owns (`messages`
stays the single transcript authority; an empty window still advances its cursor):

* `archivedMessages()` gives every archived message a **stable synthetic id** — its
  running position across appended snapshots, negated. The archive is append-only with
  no delete and no rotation, so the position is identical on every read; negating it
  makes collision with `messages.id` (a positive INTEGER primary key) impossible, so no
  consumer has to be taught which kind it holds.
* A **second per-session cursor** (`skill_distiller:review:archive_cursors`) counting
  archived messages, read and written through the *same* `_reviewCursors(key)` /
  `_setReviewCursor(key)` functions. The eviction rule exists once; a second copy would
  have been a second rule to forget.
* A session qualifies on **either** channel and live content wins, so the same window is
  never judged through two doors in one pass. Reading an archive means parsing every
  snapshot, so the archive scan is capped at 8 sessions against the live scan's 50,
  behind a `hasArchive()` size check.
* Consecutive snapshots **overlap** — each holds the whole projection at that moment,
  not only what was removed — so the window dedupes on normalized text while the cursor
  still advances over the repeats. Without that, one lesson is offered once per snapshot
  it survived in and the only thing between that and duplicate memories is the dedupe
  door.

Not built, and stated: `_evidenceWindow` does not yet resolve a negative id from the
archive, so a skill drafted from archived content still ships without the evidence line a
human should see before approving. That is the same pre-existing gap the review pass has
always had (a review verdict has no `episodes` row), and the reviewer was right that
`review:<sessionId>` fingerprinting deserves a look before the archive widens it.

## Next, in value-per-risk order

1. **Evidence for an archive-drafted proposal.** `apply_verdict` still resolves a
   verdict's evidence from the `episodes` table, so a draft distilled from archived
   content — a negative episode id — ships with an empty evidence line. The archive
   lookup exists (`archivedMessage`); wiring it into `_evidenceWindow` is a few lines,
   and a reviewer approving a skill should see the span that produced it.
2. **A Settings switch for the rotate route** (see "Needs review" under the shipped
   section) — the knob exists in `config.json` and nowhere else, so today only a
   developer can arm it. Decide placement before building; do not add a switch that
   leads nowhere.
3. **The two DS Bot chain budgets deliberately not built** (item 4, Needs review): a travelling
   `MAX_HOPS` counter — the ceiling above bounds the same class without it, and a hop count cannot be
   derived from `bot_dm` because the sender wake is not a DM row (it would have to be threaded through
   `deliver()` and tagged); and `MAX_UNREAD_REQUESTS`, because an unread DM backlog in August is a
   queue depth rather than a runaway, and arming it would refuse *delivery* instead of refusing
   *work*. Say so if you want either anyway.
4. **A scripted provider inside the eval** (the other half of DS Bot item 8, not built):
   `scripts/harness_eval.py` scores the doors and the judge, but nothing here drives the *loop*, so
   the rescue ladders — the stuck-request escape, the budget rungs, the runaway backstop — still have
   no measurement. `ds-bot/dev/mock-llm.mjs` logs system-prompt and tool-definition hashes to prove
   shared-prefix reuse, and `dev/bench.sh` forces an overflow by shrinking `CONTEXT_WINDOW`; the
   August equivalent is a scripted `BaseProviderClient` that replays a recorded tool-call sequence
   against a temp session, which would also let the shape ladder be tested without eight real 400s.
   `tests/test_stuck_request_escape.py` currently reaches the ladder by calling the rescue functions
   directly, so it pins the rungs, not the wiring that decides to take them.
