# The harness: turns, bounds and self-correction

This is the detail behind `AGENTS.md`'s harness rules. Read it before changing
the tool loop, a budget, a stop reason, subagent dispatch or context relief.

## No verifier gate

**No verifier gate exists (removed 2026-08-24).** There is no final-answer
review step, no verifier skill, and nothing that withholds answers — the
opt-in `verifierEnforced` gate, the `/api/workbench/verifier` endpoints, and
the `AUGUST_VERIFIER_REVIEWER` critic were removed by user request.
`update_state(phase=…)` exists purely as progress tracking, and `run_command`
still surfaces exit codes (zero included) in results.

## Budgets and self-correction

`MAX_MANAGED_TOOL_ROUNDS` defaults to **150** (an armed ceiling; brain-config
`maxWorkbenchToolLoops` overrides it and `0` = uncapped). A turn whose
`update_state` phase/step never advances across 8+ stalled rounds gets a
reflection nudge, then hard-stops. Flat phase/step is **not** proof of spinning
on its own: argument novelty on the assistant surface and world delta (a path
the turn had not touched before, or a `(tool, target)` that was failing with a
known family now returning clean — `_recordWorldDelta`) both reset the counter,
so self-report is a tie-breaker, not the arbiter.

Repetition is judged on a **canonical sorted-key identity** of the call
(reordered argument keys are not new work), with a `(tool, target)` polling
guard so re-reading one file at shifting offsets counts as spinning, and an
eight-family error taxonomy (`timeout | rate_limit | auth | permission |
not_found | network | invalid_argument | process_exit`) that steers once per
family even when each call differs. Every `[Proxy Self-Heal]` reminder is
runtime-only and says so, so it does not get filed back as a durable memory.

Every turn ends with a `turn_end {reason, rounds, error}` event in the session
log (`finished | length | cap | stall-stop | budget | error | interrupted |
awaiting-input`) — read that before auditing code for "why did it stop"; the
transcript also renders it as an amber stop-reason badge for any non-`finished`
stop, so a stalled turn says so in the chat itself. The same reason plus
round/malformed/downgrade/edit-verify/guardrail counters are persisted on the
`turn_outcomes` row (migration 046), where NULL means unrecorded, not zero.

**The turn budget ladder is a separate, all-off opt-in**
(`budgetSoftUsd` / `budgetSoftTokens` / `budgetWallClockSec`, each 0 = off): a
breach spends ONE rung per round — bare tool surface, then compaction, then one
tool-free answer — emitting `recovery {kind: 'budget', attempt, outcome,
degraded}` each time, and the turn then ends as `budget`. It is priced through
`cost_estimator.price_for_model` like everything else, so the budget arm and the
Usage page cannot disagree; the wall-clock arm is `time.monotonic()`, not
`time.time()`.

**A server-requested wait above the ceiling is refused, not absorbed**
(`_retryWaitRefusalMs`): clamping `Retry-After` to 30 s and then retrying
`maxRetries=10` times turned one stubborn 429 into five minutes of sleeping
inside a single round — every loop counter frozen, no event to show, and a
spinner that is really a wait list. Measured both ways with the scripted
provider: refused turns fail in 0.5 s naming the 3600 s the gateway asked for;
with the predicate disabled the turn was still asleep at 45 s.

## Two bounds are armed by default

Until 2026-10-22 nothing bounded a turn at all — `MAX_MANAGED_TOOL_ROUNDS` 0,
the budget ladder off, and the runaway backstop shipped *disarmed* — and the
reported symptom was a model that loops forever. The stall counter alone cannot
be that bound: it resets on argument novelty, so a model that calls a *different*
`(tool, target)` every round — `tool_describe`, `brain_query`, `search`,
anything taking no path argument — is permanently novel, so it never stalls and
never gets the reflection nudge.

`_runawayBudget` counts on **world delta alone** (`runawayNudgeRounds` /
`runawayStopRounds`; nudge 25, stop 40), which neither argument variety nor a
flat `update_state` can move; it emits `recovery {kind: 'runaway'}` and reuses
the `stall-stop` reason so the reason vocabulary the frontend badge,
`turn_outcomes` and these docs all read stays unchanged.

**An absent key means ARMED at those shipped constants; `0` means off** and stays
writable so an armed ceiling can always be disarmed — the old "absent = OFF"
rule is what made the bound invisible on an install that never opened Settings,
and the Settings panel used to render `0 = off` for a backstop that was counting
rounds. **That panel is gone (2026-10-22):** the Turn limits door was removed
with four others, so these keys are set in the config file only. Do not tell a
user to open a Settings section for them.

World delta can still be re-armed honestly (a model touching a genuinely new
path every round *is* working), so the second bound is counted on `modelRounds`
— requests that actually left the process — not `toolRound`, which the
self-heal legs decrement with `toolRound -= 1` and which a failing model could
therefore re-arm indefinitely. At the ceiling the turn spends ONE tool-free
summary round (`_roundCapFinalFired`, the same shape as the budget ladder's last
rung) and ends `cap`, so 150 rounds of work are delivered as a report instead of
vanishing behind an error. The reference harness pi has **no** turn bound and
trusts the model plus the context window; August keeps its own because it runs
cheap local models and an unattended Bot path that no human is watching.

Two neighbours the runaway case must not be confused with: re-reading one file
at shifting offsets is caught by the `(tool, target)` polling guard and is *not*
the runaway case, and a fresh path each round is real progress and resets the
counter — which is exactly what the ceiling exists to bound.

**The bound was defeated by the harness's own refusal text.** The repeat
guardrail emits `Blocked: 'x' has failed N times.` while the receipt vocabulary
registered `[Blocked]` with brackets, so from the 8th failure on every round of
a stuck model was a receipt that `tool_result_failed`, `receipt_tone`, the
durable `is_error` and the world-delta credit ALL read as success. The probe
measured it: 60 rounds of one blocked tool, 52 credited as progress,
`turn_end {reason: 'finished'}` at 61 rounds after the script ran out.
`Blocked:` is now a registered denial and `_marker_form` strips one leading
capability tag before matching, so `[sandbox:seatbelt] Blocked: …` (a denial
whose tag must stay first because `CommandOutputPane.tsx`'s regex is anchored
on it) reads as the refusal it is. The rule this generalises: **a marker table
has to be checked against every emitter, not just the ones that inspired it** —
`sandbox/policy.py::as_tool_text` was already writing a tagged denial and had
been invisible to `is_error` the whole time.

## Tool arguments and bad requests

**Tool arguments are parsed at one door now.** `json_salvage.parse_tool_arguments`
is strict parse → salvage → `{'_raw': text}`, and the four accumulators that turn
stream deltas into a tool call route through it. Three of them held a bare
`json.loads` with no salvage (the Anthropic-native accumulator, the OpenAI→Anthropic
bridge, and one leg that swallowed into `args = {}` — the exact phantom-argument
execution the loop documents against), so a Windows path written with one backslash
failed on the Anthropic wire and succeeded on the OpenAI one for the same model.
The repair is decided **per string literal**: a body containing an escape JSON
cannot read proves the model wrote raw backslashes in that value, so every
backslash in *that* body is doubled, while a body whose escapes are all valid is
left alone — otherwise the common `write_file` case, a `content` field carrying
real `\n` escapes, would ship a file full of literal two-character backslash-ns.
Stated limit: `C:\new\file` is a valid JSON escape sequence and stays a newline;
that document also parses strictly, so it was never the repair's to touch.

**A request the provider refuses on shape is repaired, not replayed.** A
deterministic 400 is already kept out of the retry policy (an identical request
would fail identically), but that left the harder case: `session.messages` is
what the NEXT turn sends, so one orphaned `tool_use_id` surviving into persisted
history bricked the chat — every turn failed the same way and only deleting the
session escaped it. `_stuckRequestEscape` now escalates across turns off
`turn_outcomes` (the ledger `turn_close` already writes; the strike count is the
trailing run of `ok=0, error_class='bad_request'` rows for that session, so it
needs no new state and survives a restart): the first refusal is left alone (one
bad 400 may be the provider's own bad day), the second flattens the tool pairing
into text while keeping the whole conversation (or goes straight to the bare rung
if the history carries no tool pairing to flatten, because that rung would buy
nothing), the third sends only the newest user ask, and at a fourth nothing fires
— the turn fails honestly rather than eating more of the transcript. Every rung
archives the surface it is replacing through `transcript_archive` first, so
nothing is deleted, and each emits `recovery {kind: 'stuck-request', outcome:
flattened|bare, degraded: true}` plus a warning naming the refusal count.

Overflow keeps its own ladder: `classify_error` matches `context_overflow` before
`bad_request`, and the branch additionally refuses anything `_isContextOverflowError`
claims, so a too-long prompt can never be routed to a shape repair. One more
refusal leg is required beyond the class: the marker table must match too,
because `classify_error`'s bare `400` arm makes a bad model name, an oversized
image and a broken tool pairing look identical, and only the last is fixed by
reshaping history. That leg is only reachable because
`stream_translate._errorEventText` flattens a nested envelope — `as_str`
returns '' for a dict, and the standard `{'error': {'type', 'message'}}` shape
was being stringified to nothing, so the loop's ONE error string read
`Stream error HTTP 400: ` with the provider's reason discarded. Every consumer
reads that one string (`classify_error`, the deterministic-400 replay decision,
this ladder, and the receipt the user sees), so an error envelope that nests is
a silent-blindness bug at the extractor, not a formatting detail.

## Bot-to-Bot work

**Bot-to-Bot work needs its own ceiling, because every loop guard is per-turn.**
`message_agent` runs one headless turn in the recipient's chat and its reply
wakes the sender, so a hop is a *fresh turn in a different session*: the stall
counter and the runaway backstop (which count one turn's world delta) cannot see
a chain, `has_inflight` bounds one (from→to) pair, and `rooms.MAX_ROUNDS` bounds
one user send. An A→B→C→A cycle is none of those, and every turn in it ends
`finished`.

`bot_mode/dm.py _unattendedRun` therefore counts what a chain actually does to a
chat — the trailing run of Bot-authored user rows since the last human one —
read off the **persisted** `messages` table (the arriving message is flushed at
the model-dispatch barrier, so the row this turn is reacting to is already there,
and a restart cannot launder a runaway). A row is Bot-authored when it starts
with `BOT_TURN_PREFIX` — the one constant both the DM body and the sender wake
are built from (the `/api/agents/dm` route too), so a new inbound author kind
that skips it silently never counts — or when `messages.source` names a
non-human source. `_turnAuthor` returns three values, not two, because a two-way
read is wrong in the dangerous direction: compaction writes its
`<<compressed_summary` block as a **user** row with no provenance, so "Bot or
human?" calls that row a human and disarms the ceiling in exactly the long chats
where compaction runs. A machine row neither counts nor resets. `source`
membership is an explicitly declared subset, not `MACHINE_SOURCES`: that set
includes `queued_user`, which IS the human typing mid-turn, and counting it would
make the message that should end the run extend it. The content column is
JSON-encoded, so it is decoded before the prefix test; comparing the raw column
would find no human row ever and turn a runaway ceiling into a lockout.

Opt-in like every rule here that can stop work: `maxUnattendedTurns` absent/0 =
off, and 0 must stay writable or an armed ceiling can never be disarmed. The
ceiling guards the **model's** send door, not the store: `POST /api/agents/dm`
delivers what a human asked for and a human send is the reset, so gating it
would be a lockout. A new numeric brain key needs all three of `numKeys`, a
`fieldTable` entry defaulting to `None` (absent, not 0) and an explicit range
branch — the validator's fallback branch is `maxWorkbenchLoopsRange` (0–500),
so a key that means "0 = off" must name its own branch rather than inherit that
one. `npm run check:brain-config` is what now holds this: it asks the backend
which keys it accepts and what ranges they take, and fails when the Settings
panel writes a key the backend rejects or offers a value outside the backend's
range. It has already caught a key with a `fieldTable` entry but no writable-set
entry (`decisionJournal` — every PUT naming it was rejected, so the switch that
promotes `record_decision` into the core tool set could never be moved).

## Context relief and compaction

**Context relief has two routes, and the route is chosen from state, not by a
model.** Compact-in-place keeps a verbatim head *forever* — a floor of
`DEFAULT_HEAD_COUNT` (4) messages, grown while the head fits
`COMPACT_HEAD_RATIO` (0.10, a tenth of the model window) and always leaving a
middle unit to summarize — and summarizes what follows, so from the second relief
onward the note's `Goal` is built from a follow-up turn — the original ask sits
outside the summarized span — and earlier decisions survive only as the 600 chars
of prose the previous note squeezed out of itself.

`reliefStrategy` therefore returns `rotate` only when the brain key
`contextReliefRotate` is armed **and** a `<<compressed_summary` note already
exists: the first relief never rotates, even armed, because before a note exists
the verbatim head IS the live task and folding it into a summary whose own footer
says "decisions and constraints were not analyzed" trades a fact for a guess.
Rotating keeps no head, so the opening moves into the summarized span (the note
names the task again) and is claimed back verbatim FIRST inside the existing
`REPLAY_USER_BUDGET_BYTES` — which is the stated trade: the opening spends budget
the newest turns would otherwise get, and the newest turns are what a mid-task
rotation actually needs. Replaying the ask out of the span is also what feeds
`goalHint` on the fallback path, or the Goal silently reverts to a follow-up.
Absent key = today's route; `reliefHeadCount` is the single map between a route
and the head count a frame may report.

**Five paths compact, and they were reconciled by a census, not by trust**: the
pre-turn auto-compact, the budget ladder's middle rung, the reactive overflow
rescue, the manual "Free up memory" endpoint (its `threshold=0` forcing is
preserved through `thresholdOverride`), and a subagent compacting mid-run.
`_compactionCall` documents itself as the single shared site; the pre-turn path
called `compressMessages` inline anyway and the manual endpoint and subagent each
carried their own argument list, so a subagent got the heuristic summarizer, a
count-budgeted tail, no tool-output prune, no landmark pins and no verbatim
replay. The parity test could not see this because it compared the two recovery
paths against *each other*. The budget path also reported `compressedCount` as
the messages *remaining* while the pre-turn path reported those *removed*, and
the card renders that number as "summarized N messages".

**A site census is not an argument check:** the consolidated manual endpoint
still passed `context_window=0`, which is not "size unknown" downstream —
`_compactionCall` turns it into `contextWindow=None` and that selects the
count-budgeted tail. On the MANUAL button that is correct and on every automatic
path it is not, so the gate is per-route: the button's `context_window=0` must
stay paired with `thresholdOverride=0`. "Fixing" the button by giving it the
model's real window measured 71 messages → 71 and 0 tokens freed on a 128k
window — a token tail of 16% exceeds a short transcript, so the control silently
stopped doing anything while reporting "Context is already compact enough".

The pre-turn path archived the transcript AFTER `pruneToolOutputs`, so the
snapshot held `[Old tool result content cleared]` where old tool outputs had been
while compaction then persisted the reduced list — the content was in neither
place, while the chat card tells the user "The full transcript is archived". It
now archives the unpruned list (the projection prune still applies to the turn
itself, and re-pruning inside `_compactionCall` is idempotent by design). Rotate
also refuses to carry an opening that alone exceeds `REPLAY_USER_BUDGET_BYTES`,
because claiming it would spend the whole budget on one message and can leave the
relief freeing too little to be worth running; such a spec stays in the
summarized span and still reaches the note's Goal.

Two limits of the route are stated in `reliefStrategy` rather than fixed: it
resets head staleness, not note-on-note loss (each note still carries its
predecessors as 600 characters of prose), and its predicate is "a fenced summary
block is present", so a transcript that pastes a genuine handoff note rotates on
its first relief (pinned as a documented limit, because tightening the detector
would stop legacy notes being recognized at all).

**Pins are unit-safe, and a pairing test that omits them proves nothing.** A later
round found the projection could open with a `role: tool` result right after the
system message: the landmark-pin loop walked FLATTENED messages while every other
boundary is unit-safe, so a predicate matching a result whose `read_file` call
matched nothing pinned the result and summarized its call. That 400s every provider
and, because the projection is what gets persisted, bricks every later turn — the
exact failure the stuck-request ladder exists to escape. It was already reachable in
the compact route (reproduced on the parent commit); rotate made the opening pair
newly reachable. The shipped pairing test passed because it called the compressor
WITHOUT `pin_predicates`, which `_compactionCall` always supplies — omit the
production arguments and the test green-lights the defect it names.

`tailCount` is now the split the compressor used (`reliefStats` flows out of
`_compactionCall`): three emitters had hardcoded the defaults `4`/`6` while the
tail is token-budgeted, so the card asserted "kept the first 4 and last 6
messages" about a compaction that had kept 120 verbatim. Where a path genuinely
never learns its split — the reactive overflow rescue — the field is OMITTED, not
zeroed: `Number(undefined) || 0` in the stream reader used to fold absence into a
fact, and the card now renders the count clause only when both numbers exist. The
zod schema marks them optional for the same reason — the validator only warns and
never discards, but a required field made a legitimate frame look like contract
drift and dulled the warning for real drift.

## Tool surface and modes

Malformed tool JSON never executes as `{}` — the loop returns a `[Validation
Error] … Do NOT stop` self-heal and downgrades to the bare tool surface after 3
consecutive failures. Stream rules flag tool-call *narration* ("I'll use the X
tool", code-fenced JSON) but defer the verdict to end-of-turn: a flag is
cancelled the moment a real tool call arrives, and only a narration with NO tool
call triggers the reminder + retry. Per-model capability profiles
(`toolSurface` full/reduced/bare, `maxTools`, `maxToolResultChars` in Model
settings) are honored by both tool-definition paths and result truncation.

**Agent modes (0.12.55+)** — `set_agent_mode(chat|agent|code|orchestrator)`
(`planner` is an alias for `orchestrator`) switches the session: `chat` blocks
tool calls (text only), `agent` is native tool calling (default), `code`
executes a fenced ```python block through the existing sandboxed `run_command`
with a workspace-bound tool API (`read_file`, `write_file`, `run_command`,
`list_files` — see `app/services/workbench/code_runner.py`), `orchestrator`
dispatches workstreams with no shell/edit.

`/v1/responses` supports `stream: true` via upstream-native pass-through.

Sub-agents inherit the parent retry policy, compact mid-run, and support
`yieldSchema` for structured results.
