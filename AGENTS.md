# Agent notes (August Proxy)

## There is no test suite (removed 2026-10-17, at the owner's request)

Every test file in this repo was deleted on 2026-10-17 — `backend-py/tests/`
(1,690 files), the 235 frontend `*.test.ts(x)` files with their `__tests__`
directories, `frontend/desktop/e2e/`, `scripts/desktop-backend-payload.test.mjs`
and the `test_mapping` hook whose only input was the test tree. The CI jobs, npm
scripts, `pytest` configuration, coverage floor/ratchet and the tooling that
served them went with them — but NOT the dependencies: the pytest-* dev
dependencies in `backend-py/pyproject.toml` and the vitest/playwright packages
in the frontend `package.json` all stay, because `uv lock --check` and the npm
lockfile gate the release job and a removed dep is a lockfile change. `npm
test` does not exist any more, on purpose; the 5 inline Rust `#[cfg(test)]`
blocks in `src-tauri/` were left in place (they compile to nothing outside
`cargo test`, and nothing runs it).

**Every `tests/…` path named anywhere below is historical.** A sentence that
says a rule "is pinned by `tests/test_x.py`" is no longer pinned by anything —
the file it names is gone. Those sentences are the record of *why* the code has
its shape, so they were kept rather than rewritten; verify a claim by reading the
code it names, never by looking for a test. Nothing turns red for a missing
test: the gates that remain are static.

What verifies a change now: `npm run check:docs`, `check:design`,
`check:naming`, `check:api`, `check:api-index`, `check:sse`, `check:version`,
`check:doc-links`, `check:minisign`, `check:truncate`, `check:brain-config`,
`lint:ratchet`; `uv run ruff check .` + `uv run mypy app/`
for the backend; `npm run check -w frontend/desktop` (tsc + eslint) for the
desktop app; `npm run e2e:smoke`, which starts the backend against a
THROWAWAY data directory and asks its basic doors a question; `Type check` on
every push; and a human running the app.

The static gates cannot see whether the app **starts** — a module that fails
to import, a migration that does not apply, a lifespan hook that raises and a
router that fails to register are all invisible to a linter and fatal at
launch. `e2e:smoke` is the floor under that, and it is deliberately not a
behaviour test: it imports the real app, runs its lifespan, and asks ten
questions — six read-only doors, one config write, the closed MCP door, and
the local door twice (once without the per-install token, which must be
refused, and once with it, which must get past the door). It never touches the user's data
directory — that holds their brain database and their keys — and it points
`AUGUST_DATA_DIR` at a temp directory that is removed afterwards.

Three of those gates exist because the defect they catch is INVISIBLE to
every other gate, and each has already caught a live bug:

- **`check:sse` also checks handler SUPPLY.** The frame-parity checks are
  about the frame vocabulary and cannot see a dispatcher that calls
  `handlers.onX?.(...)` when nothing supplies `onX` — the optional call is a
  no-op, so the frame validates, reaches the handler and vanishes. That is
  exactly what `recovery` did: emitted, schematised, dispatched, and
  invisible, so every self-correction the harness performed shipped as a
  normal-looking answer.
- **`check:truncate`** reads the source with the TypeScript compiler API
  and fails when a `truncate` sits on an element that cannot truncate.
  `overflow: hidden` and `text-overflow: ellipsis` do not apply to an inline
  box, so `truncate` on a bare `<span>` is inert and the text paints over
  whatever is beside it. Only the AST can tell a flex CONTAINER from a flex
  ITEM (`flex-1` is item sizing, not a container) and can see a className
  written as a template literal or a `cn(...)` call.
- **`check:brain-config`** asks the backend which keys it accepts and what
  ranges they take, and fails when the Settings panel writes a key it does
  not, or offers a value it refuses. It has caught a key with a
  `fieldTable` entry but no writable-set entry (every PUT naming it was
  rejected) and a backend range that started at 1 while the panel's own
  default was 0.

## Two standing rules (moved here from `docs/plans/2026-09-05-harness-maintenance.md`)

These two rules used to live only in that one plan file, and nowhere in the
tree or in this file — so a session that never opened the plan never saw
them. They are rules about HOW to work, not about a feature, so this is where
they belong.

**Delete your scratch files before you commit.** When you finish a session,
delete the scratch files *you* created — scan outputs, generator scripts,
unused drafts, probe scripts left in the tree. The repo carries no `_*.py` /
`*.txt` scratch artifacts on purpose; a leftover probe is debris, and the
next reader cannot tell it from a real module. (Source: §6b of the harness
maintenance plan, where the rule was first written down.)

**New work rides under existing part numbers — never mint a new "Part N+".**
The numbered Part series (Part 1–27) is CLOSED. A change whose scope fits
an existing part's area ships under that part's number; a change that fits
none of them gets a plan doc under `docs/plans/<date>-<slug>.md` with a
descriptive slug, and code and commit messages reference that plan **by
slug, never by number**. Comments and identifiers describe what the code
does and why, not which plan document created it — so "Part 28" appearing
in a comment or a commit message is a defect, not a citation. (Source: §8
of the harness maintenance plan, which is why the numbered series stopped
at 27.)

## Product surface

**The product is the Tauri desktop app** (`frontend/desktop/` + bundled `backend-py/`).

- Verify and ship fixes in the **desktop app**, not by treating August as a standalone browser/web product.
- `web-dist/` is the Vite build artifact that Tauri packages into the desktop shell (and that FastAPI can serve for local backend-only runs). It is **not** a separate “web app” to QA against for product work.
- Prefer `npm run dev:desktop` / packaged MSI·NSIS installs when checking UI + workbench behavior.
- Installed production builds copy bundled `backend-py` into AppData from the installer stamp — **desktop releases must include backend changes**, not UI-only rebuilds.
- **Two guards carry the whole install/update promise** (don't relax either to make a build pass): a new download must start with an empty memory, and an update must keep everything. `{appData}/data` holds everything a user owns (brain DB, `providers.json`, learned skills, sessions, backups) and `{appData}/backend-runtime` holds the re-extractable copy of the payload — siblings, never nested. `scripts/desktop-backend-payload.mjs` therefore refuses to stage runtime user state (`data/`, `*.sqlite*`, `providers.json`, `config.json`, `.env`, `.usage.json`), because staging reads from a working checkout and one stray `AUGUST_DATA_DIR` run would otherwise ship a developer's memory and API keys to every user. And `wipeStaleTree` in `backend.rs` — the only recursive delete the update path performs — refuses any target that is not inside `backend-runtime/`. Uninstall deleting app data is deliberately opt-in AND suppressed under `/UPDATE`.
- **An update is an IN-PLACE, SILENT replace, and the app restarts itself.**
  The Windows update path is a custom one (`backend.rs::launch_installer_and_exit`),
  not the plugin's, because the desktop release must carry backend changes.
  Four things have to line up or the app never comes back: the installer is
  launched with `/UPDATE /S` (silent, and routed to `reinst_done` so the OLD
  uninstaller is never run — the user sees no uninstall wizard); the app
  schedules the detached waiter (`schedule_post_update_relaunch`) BEFORE
  launching the installer; the NSIS POSTINSTALL writes the completion marker
  UNCONDITIONALLY and skips its own `ExecShell` under `/UPDATE`, so the
  waiter is the single owner of the relaunch; and the waiter waits for **the
  pid that scheduled it** to exit before it starts looking for the marker.
  That last one is not a detail. "August is running" does not mean "no
  update is in progress" — it means the opposite, because at the moment the
  waiter starts the old app is ALWAYS still alive. A waiter that treated
  "August is running" as "nothing to do" exited on its first iteration,
  every iteration, and the update left a DEAD APP. The stale marker is
  deleted when the waiter is SCHEDULED, not by the waiter: by the time the
  waiter starts, the installer may already have written a fresh one.
  The waiter always relaunches at its 180 s deadline, so a failed update
  leaves a dead app rather than an app that never returns. The DOWNLOAD is
  automatic (Settings → About → "Download updates automatically", on by
  default, 60 s after launch); the RESTART never is — it interrupts whatever
  is running, so it stays the user's click.
  `npm run check:minisign` proves the VERIFIER matches the format the app
  verifies with (it checks the `minisign-verify` crate's own published
  vector, so a verifier and a signer cannot agree on a mistake) and that the
  key in `tauri.conf.json` and the key hardcoded in `backend.rs` are the
  SAME key — they are two sources of truth for "the key the user trusts"
  and nothing held them together. The RELEASE is what verifies the
  published signature, against the bytes it is about to publish.
  The whole flow is unverified on a packaged NSIS install: the matrix in
  `docs/UPDATE_VERIFICATION.md` is the check, and it has not been run.
- **A run of COMMANDS is ONE line in the transcript, not N.** The
  reference transcript collapses consecutive tool calls into an activity line
  — a warm dot, one phrase ("Ran 4 commands"), the elapsed time, a chevron —
  and reveals them in a bordered card. That grouping is a RENDER-TIME
  arrangement (`components/chat/ActivityGroup.tsx` + `lib/tool-summary.ts`),
  not a new persisted block kind: the transcript still stores one block per
  tool call, so a reload produces the same grouping and the backend knows
  nothing about it. **Commands only, for now**: a run of READS keeps the
  Explore group it already had, and a run of edits, memory writes, search
  hits or subagents keeps its own row. Grouping every kind is the open
  decision in `docs/ROADMAP.md` — the reference collapses everything into
  one line, and merging the two groupings means dropping the Explore
  group's own vocabulary. A command that FAILED, is waiting for approval, or
  carries an action widget stays on its own — a group collapses to a single
  line, and a failure hidden behind a collapsed line is one nobody sees.
  The live indicator (`WorkingIndicator`) and the persisted activity line are
  BOTH kept: one is what is happening, the other is what happened.
- Provider **baseUrl** is used exactly as pasted; August only appends the API format leaf (`chat/completions` / `v1/messages` / `responses` / `models`). It never invents `/v1` on the base — Anthropic’s format already includes `v1` in the leaf; OpenAI-compatible hosts include `/v1` in the paste when needed.

## Recent desktop fix (0.12.21)

**OpenCode / OpenAI-compatible gateways rejected chat with:**

`[400] session_id: Invalid input: expected string, received null`

**Cause:** `ChatCompletionRequest.model_dump()` forwarded `session_id: null` (and other nulls) upstream. Free DeepSeek Flash often still worked; stricter Console models failed. Test button used the same path.

**Fix (desktop-bundled backend + UI):**

- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — `exclude_none` + strip August-only keys before upstream calls
- Used by workbench chat, model Test button, and `/v1/chat/completions` · `/v1/messages` proxy adapters
- API format dropdown labels simplified to `chat/completions` / `messages` / `responses`

## Multi-format gateways (per-model apiFormat)

**OpenCode Zen** lists all models via `GET …/models`, but each family needs a
different wire path (`/chat/completions`, `/v1/messages`, `/responses`). One
provider-level `apiFormat` cannot serve Claude+GPT+DeepSeek from the same Zen
entry, so model entries may carry their **own** `apiFormat` (set in Model
settings → pencil-edit model → Wire format dropdown; the UI suggests
`v1/messages` for `claude-`-prefixed ids). The override wins over the provider
format and is honored by workbench chat, the Test button, Live/BTW, and the
`/v1` proxy adapters (OpenAI→Anthropic body+SSE translation exists for Claude
models reached via `/v1/chat/completions`). See `docs/TROUBLESHOOTING.md` and
`docs/CONFIGURATION.md`.

**No verifier gate exists (removed 2026-08-24).** There is no final-answer
review step, no verifier skill, and nothing that withholds answers — the
opt-in `verifierEnforced` gate, the `/api/workbench/verifier` endpoints, and
the `AUGUST_VERIFIER_REVIEWER` critic were removed by user request.
`update_state(phase=…)` exists purely as progress tracking, and
`run_command` still surfaces exit codes (zero included) in results.

**Harness budgets & self-correction** — `MAX_MANAGED_TOOL_ROUNDS` defaults to
**0 = uncapped** (a cap is opt-in via brain-config `maxWorkbenchToolLoops`;
the "defaults to 25" claim was stale since `38944632`). A turn whose
`update_state` phase/step never advances across 8+ stalled rounds gets a
reflection nudge, then hard-stops. Flat phase/step is **not** proof of
spinning on its own: argument novelty on the assistant surface and world
delta (a path the turn had not touched before, or a `(tool, target)` that
was failing with a known family now returning clean — `_recordWorldDelta`)
both reset the counter, so self-report is a tie-breaker, not the arbiter.
Repetition is judged on a **canonical
sorted-key identity** of the call (reordered argument keys are not new work),
with a `(tool, target)` polling guard so re-reading one file at shifting
offsets counts as spinning, and an eight-family error taxonomy (`timeout |
rate_limit | auth | permission | not_found | network | invalid_argument |
process_exit`) that steers once per family even when each call differs. Every
`[Proxy Self-Heal]` reminder is runtime-only and says so, so it does not get
filed back as a durable memory. Every turn ends with a `turn_end
{reason, rounds, error}` event in the session log (`finished | length | cap |
stall-stop | budget | error | interrupted | awaiting-input`) — read that before
auditing code for "why did it stop"; the transcript also renders it as an
amber stop-reason badge for any non-`finished` stop, so a stalled turn says so
in the chat itself. The same reason plus round/malformed/
downgrade/edit-verify/guardrail counters are persisted on the `turn_outcomes`
row (migration 046), where NULL means unrecorded, not zero. **The turn budget
ladder is a separate, all-off opt-in** (`budgetSoftUsd` /
`budgetSoftTokens` / `budgetWallClockSec`, each 0 = off): a breach spends ONE
rung per round — bare tool surface, then compaction, then one tool-free answer
— emitting `recovery {kind: 'budget', attempt, outcome, degraded}` each time,
and the turn then ends as `budget`. It is priced through
`cost_estimator.price_for_model` like everything else, so the budget arm and
the Usage page cannot disagree; the wall-clock arm is `time.monotonic()`, not
`time.time()`. Numbers in this file that duplicate code
constants are guarded by `npm run check:docs`.

**Nothing bounds a turn by default, and that is deliberate — with one opt-in
backstop.** `MAX_MANAGED_TOOL_ROUNDS` 0 plus the ladder off leaves the stall
counter as the only bound, and the stall counter resets on argument novelty. A
model that calls a *different* `(tool, target)` every round — `tool_describe`,
`brain_query`, `search`, anything taking no path argument — is permanently
novel, so it never stalls, never gets the reflection nudge, and was bounded
only by overflowing the context window. `_runawayBudget` counts on **world
delta alone** (`runawayNudgeRounds` / `runawayStopRounds`; nudge 25, stop 40),
which neither argument variety nor a flat `update_state` can move; it emits
`recovery {kind: 'runaway'}` and reuses the `stall-stop` reason so the reason
vocabulary the frontend badge, `turn_outcomes` and these docs all read stays
unchanged. **An absent key means OFF, not the shipped constants** — a rule that
ends a turn early is opt-in here, the way `verifierEnforced` was before it was
removed. Two neighbours it must not be confused with, both pinned by
`tests/test_runaway_backstop.py`: re-reading one file at shifting offsets is
caught by the `(tool, target)` polling guard and is *not* the runaway case,
and a fresh path each round is real progress and resets the counter.
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
nothing), the third sends only the newest
user ask, and at a fourth nothing fires — the turn fails honestly rather than
eating more of the transcript. Every rung archives the surface it is replacing
through `transcript_archive` first, so nothing is deleted, and each emits
`recovery {kind: 'stuck-request', outcome: flattened|bare, degraded: true}` plus
a warning naming the refusal count. Overflow keeps its own ladder:
`classify_error` matches `context_overflow` before `bad_request`, and the branch
additionally refuses anything `_isContextOverflowError` claims, so a too-long
prompt can never be routed to a shape repair. Pinned by
`tests/test_stuck_request_escape.py`, whose control case asserts that a single
refusal still produces an ordinary error and no reshape. One more refusal leg isrequired beyond the class: the marker table must match too, because
`classify_error`'s bare `400` arm makes a bad model name, an oversized image and
a broken tool pairing look identical, and only the last is fixed by reshaping
history. That leg is only reachable because
`stream_translate._errorEventText` now flattens a nested envelope — `as_str`
returns '' for a dict, and the standard `{'error': {'type', 'message'}}` shape
was being stringified to nothing, so the loop's ONE error string read
`Stream error HTTP 400: ` with the provider's reason discarded. Every consumer
reads that one string (`classify_error`, the deterministic-400 replay decision,
this ladder, and the receipt the user sees), so an error envelope that nests is
a silent-blindness bug at the extractor, not a formatting detail.
**Bot-to-Bot work needs its own ceiling, because every loop guard is per-turn.**
`message_agent` runs one headless turn in the recipient's chat and its reply
wakes the sender, so a hop is a *fresh turn in a different session*: the stall
counter and the runaway backstop (which count one turn's world delta) cannot see
a chain, `has_inflight` bounds one (from→to) pair, and `rooms.MAX_ROUNDS` bounds
one user send. An A→B→C→A cycle is none of those, and every turn in it ends
`finished`. `bot_mode/dm.py _unattendedRun` therefore counts what a chain
actually does to a chat — the trailing run of Bot-authored user rows since the
last human one — read off the **persisted** `messages` table (the arriving
message is flushed at the model-dispatch barrier, so the row this turn is
reacting to is already there, and a restart cannot launder a runaway). A row is
Bot-authored when it starts with `BOT_TURN_PREFIX` — the one constant both the
DM body and the sender wake are built from (the `/api/agents/dm` route too), so a
new inbound author kind that skips it silently never counts — or when
`messages.source` names a non-human source. `_turnAuthor` returns three values,
not two, because a two-way read is wrong in the dangerous direction: compaction
writes its `<<compressed_summary` block as a **user** row with no provenance, so
"Bot or human?" calls that row a human and disarms the ceiling in exactly the long
chats where compaction runs. A machine row neither counts nor resets. `source`
membership is an explicitly declared subset, not `MACHINE_SOURCES`: that set
includes `queued_user`, which IS the human typing mid-turn, and counting it would
make the message that should end the run extend it. The content column is
JSON-encoded, so it is decoded before the prefix test; comparing the raw column
would find no human row ever and turn a runaway ceiling into a lockout. Opt-in like every rule here that can stop work:
`maxUnattendedTurns` absent/0 = off, and 0 must stay writable or an armed
ceiling can never be disarmed. The ceiling guards the **model's** send door, not
the store: `POST /api/agents/dm` delivers what a human asked for and a human send
is the reset, so gating it would be a lockout. A new numeric brain key needs all
three of `numKeys`, a `fieldTable` entry defaulting to `None` (absent, not 0) and
an explicit range branch — the validator's fallback branch is
`maxWorkbenchLoopsRange` (0–500), so a key that means "0 = off" must name its
own branch rather than inherit that one. `npm run check:brain-config` is what
now holds this: it asks the backend which keys it accepts and what ranges they
take, and fails when the Settings panel writes a key the backend rejects or
offers a value outside the backend's range. It has already caught a key with a
`fieldTable` entry but no writable-set entry (`decisionJournal` — every PUT
naming it was rejected, so the switch that promotes `record_decision` into the
core tool set could never be moved).
**The outbound body is scrubbed of this install's own credentials.** A key that
rides into the transcript once — pasted by the user, quoted by a log line, printed
by a command whose path looked harmless — is re-sent to whichever gateway is
active on EVERY later turn, which is why the tool-boundary guard
(`hooks/secret_guard.py`: deny secret-shaped writes, redact protected-path reads)
was not enough. `scrubOutboundBody` runs at the **transport**:
`BaseProviderClient.wireBody(body)` wraps its two `self.client` calls
(`requestJson`, `streamSse`), which is the only place that sees every body. It is
NOT in the `dump_*_upstream_body` serializers, and a review round proved why: the
workbench dumps an empty `ChatCompletionRequest` and assigns `body['messages']`
afterwards (`workbench/providers.py`), and the `/v1` proxy appends tool results and
re-sends after its dump — a serializer door covered neither, while the auth header
(where a key legitimately belongs) stays untouched at either.
**Matched by VALUE, never by pattern**: a pattern scrub would rewrite
key-shaped text a user pasted to ask why their own key 401s —
`test_key_shaped_text_the_user_pasted_survives` is that control, and
`test_a_database_password_in_the_env_is_deliberately_NOT_scrubbed` the other:
env collection is `*_API_KEY` only, because a DB password the user is working WITH
must stay visible while a provider key the install works FROM must not. Values come
from the providers store, `settings.gatewayApiKey` and those env vars; anything
under 12 characters is ignored (a 3-char "key" would substring-mangle prose). The
cache is stamped on **both** `providers.json` and `config.json` — the gateway key is
minted through `saveConfig`, which fires no invalidation callback at all — and the
stat is taken once per body, never per leaf: on a 641 KB body with 1,001 string
leaves the per-leaf stamp cost 419.6 ms against 1.94 ms hoisted (the `json.dumps`
that follows costs 5.9 ms). An EMPTY result is never cached, so a transient read
failure cannot switch the gate off silently; failed reads log at warning. Stated limits: a value
that arrives already escaped (`\u0073k-…`, base64 of the transcript) does not match,
and a keyring-held credential is out of reach. Tests drive a real client through an
`httpx.MockTransport` and assert on what the provider would receive.
**An agent's capability definition is not model-writable.** `create_agent`,
`update_agent` and `delete_agent` are ordinary registered tools, so whichever
model is talking could pass `agentId` plus `permissions: ['all']` for any agent —
measured before the fix: a turn holding `['read_file']` wrote itself `['all']`,
rewrote an unrelated agent's permissions *and* model routing, and deleted both
that stranger and its own root. Guard modes do not cover this: `needs_approval_in`
returns False for `full`, and **every Bot DM and room session is created with
`guardMode='full'`** (`rooms.py`), and no session is even required. So
`_authority_refusal` rejects `permissions` / `tools` / `modelAlias` at the handler
(they are gone from the advertised schemas too — a knob that always refuses is a
lie), the descriptive fields stay writable, and the registry's own write stays
open for the human door (`PUT /api/agents/{id}`, `actor='ui'`). `delete_agent` now
routes through `roster.delete_bot` like the UI route always has, whose docstring
names the reason: only that path refuses the default assistant Bot and cascades a
deleted Bot's private footprint; a bare registry delete left the facts, DM rows,
room memberships and canonical chat behind and `ensure_default_bot` re-minted a
NEW id for `assistant`, stranding every chat bound to the old one. On top of that
a turn may not delete itself, an ancestor, or a branch that still has children.
`tests/test_agent_authority_door.py` pins all of it, including that no session
bound is not a free pass.
**An absent capability definition means inherit, and inheritance cannot widen.**
`permissions: []` was read as "allowed nothing", which is why `evaluateAgentTool`
denied every tool to a roster-created Bot — measured: a delegated worker kept **0
of 6** tools, while the sibling controls (`['all']` → 6, prefix `read_` → 1) proved
the probe could tell. Both real agents in this install's store are `[]`, and
`create_bot` never sets the field, so the empty list is the ABSENCE of a
definition, not a grant of nothing; `_declaredPermissions` says so once and
`evaluateAgentTool`, `_effectivePermissions` and the spawn surface all read it.
Inheriting is safe because a worker's names are always drawn from
`toolDefinitions(session)` — the PARENT's list — so it cannot exceed the turn that
spawned it. `_effectivePermissions` now applies the parent's bound even to a child
declaring `'all'`, because otherwise `'all'` launders the restriction away, and
`deriveChildPermissions` — which existed, was called, and had its result
discarded behind a guard reading `session.agent_id` while the field is `agentId`,
so it never ran — is now the spawn-time ceiling in `_lineageCeiling`.
**Enforcement is the deny set, not the withheld surface**: `tool_call` dispatches
an arbitrary name through the real executor, so a worker spawned read-only could
still `write_file` by naming it. `_workerDeniedNames` (tier, restricted set,
never-tools, lineage ceiling, a declared list) is published on
`currentSubagentDenied`, read by both the worker's dispatch guard and the bridge.
It is a DENY set on purpose — the offered list is a progressive-disclosure slice
and `tool_search` → `tool_call` is the documented route to a tool outside it, so
gating on that slice would break delegation for weak models. `update_agent` and
`delete_agent` were added to `_SUBAGENT_NEVER_TOOLS`, which had only `create_agent`
despite its own comment naming all three doors. **The bridge decides "am I inside a
worker" from the deny set's presence, never from `currentSubagentDepth > 0`** — a
worker's runtime depth is `max(depth, agent.depth)` and every roster-created Bot has
depth 0, so the depth test skipped both the never-tool gate and the deny set for every
real subagent (`tool_call('remember')` executed), while a root turn publishes no deny
set at all. **Two unresolvable lineages resolve in opposite directions on purpose**: a
dangling `parentId` is reachable by ordinary use (the UI delete has no children check)
and means *no restriction* — the parent's bound left with the record, and reading it as
`set()` collapsed every such worker to zero tools — whereas a `parentId` **cycle** is
not reachable by a model turn (`update_agent` no longer writes `parentId`, and
`create_agent` sets it only on a freshly minted id) so it fails closed; before the walk
was bounded it raised `RecursionError`, which the ceiling swallowed into "no ceiling",
i.e. the fail-OPEN direction (measured, at `agent_registry._effectivePermissions`).
`POST /api/august/agents/manage` now deletes through `roster.delete_bot` like
`DELETE /api/agents/{id}`, because only that path refuses the default Bot, cascades the
Bot's private footprint, and names the actor in the audit.
**Context relief has two routes, and the route is chosen from state, not by a
model.** Compact-in-place keeps the first `DEFAULT_HEAD_COUNT` (4) messages
verbatim *forever* and summarizes what follows, so from the second relief onward
the note's `Goal` is built from a follow-up turn — the original ask sits outside
the summarized span — and earlier decisions survive only as the 600 chars of prose
the previous note squeezed out of itself. `reliefStrategy` therefore returns
`rotate` only when the brain key `contextReliefRotate` is armed **and** a
`<<compressed_summary` note already exists: the first relief never rotates, even
armed, because before a note exists the verbatim head IS the live task and
folding it into a summary whose own footer says "decisions, constraints and next
steps were not analyzed" trades a fact for a guess. Rotating keeps no head, so the
opening moves into the summarized span (the note names the task again) and is
claimed back verbatim FIRST inside the existing `REPLAY_USER_BUDGET_BYTES` —
which is the stated trade: the opening spends budget the newest turns would
otherwise get, and the newest turns are what a mid-task rotation actually needs,
so both are pinned (`test_the_opening_spends_budget_the_newest_turns_would_have_used`).
Replaying the ask out of the span is also what feeds `goalHint` on the fallback
path, or the Goal silently reverts to a follow-up. Absent key = today's route;
`reliefHeadCount` is the single map between a route and the head count a frame
may report. **Five paths compact, and they were reconciled by a census, not by
trust**: the pre-turn auto-compact, the budget ladder's middle rung, the reactive
overflow rescue, the manual "Free up memory" endpoint (its `threshold=0` forcing is
preserved through `thresholdOverride`), and a subagent compacting mid-run.
`_compactionCall` documents itself as the single shared site; the pre-turn path
called `compressMessages` inline anyway and the manual endpoint and subagent each
carried their own argument list, so a subagent got the heuristic summarizer, a
count-budgeted tail, no tool-output prune, no landmark pins and no verbatim replay.
The parity test could not see this because it compared the two recovery paths
against *each other*. `test_exactly_one_site_builds_a_compaction_request` now
counts the call sites in the package (it read 3 before the fix, 1 after), and its
first assertion is that the census is non-empty — a scanner gate that passes on
zero matches is not a gate. The budget path also reported `compressedCount` as the
messages *remaining* while the pre-turn path reported those *removed*, and the card
renders that number as "summarized N messages". **A site census is not an argument
check:** the consolidated manual endpoint still passed `context_window=0`, which is
not "size unknown" downstream — `_compactionCall` turns it into `contextWindow=None`
and that selects the count-budgeted tail. On the MANUAL button that is correct and on
every automatic path it is not, so the gate is now per-route
(`test_only_the_manual_path_may_use_the_count_budgeted_tail`): the button's
`context_window=0` must stay paired with `thresholdOverride=0`. "Fixing" the button by
giving it the model's real window measured 71 messages → 71 and 0 tokens freed on a
128k window — a token tail of 16% exceeds a short transcript, so the control silently
stopped doing anything while reporting "Context is already compact enough". Related,
and found the same way: the pre-turn path archived the transcript AFTER
`pruneToolOutputs`, so the snapshot held `[Old tool result content cleared]` where old
tool outputs had been while compaction then persisted the reduced list — the content
was in neither place, while the chat card tells the user "The full transcript is
archived". It now archives the unpruned list (the projection prune still applies to
the turn itself, and re-pruning inside `_compactionCall` is idempotent by design). Rotate also refuses to carry an opening
that alone exceeds `REPLAY_USER_BUDGET_BYTES`, because claiming it would spend the
whole budget on one message and can leave the relief freeing too little to be worth
running; such a spec stays in the summarized span and still reaches the note's Goal.
Two limits of the route are stated in `reliefStrategy` rather than fixed: it resets
head staleness, not note-on-note loss (each note still carries its predecessors as
600 characters of prose), and its predicate is "a fenced summary block is present",
so a transcript that pastes a genuine handoff note rotates on its first relief
(pinned as a documented limit, because tightening the detector would stop legacy
notes being recognized at all).
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
production arguments and the test green-lights the defect it names. `tailCount` is now
the split the compressor used (`reliefStats` flows out of `_compactionCall`): three
emitters had hardcoded the defaults `4`/`6` while the tail is token-budgeted, so the
card asserted "kept the first 4 and last 6 messages" about a compaction that had kept
120 verbatim. Where a path genuinely never learns its split — the reactive overflow
rescue — the field is OMITTED, not zeroed: `Number(undefined) || 0` in the stream
reader used to fold absence into a fact, and the card now renders the count clause only
when both numbers exist. The zod schema marks them optional for the same reason — the
validator only warns and never discards, but a required field made a legitimate frame
look like contract drift and dulled the warning for real drift.
Malformed tool JSON never executes as `{}` — the loop
returns a `[Validation Error] … Do NOT stop` self-heal and downgrades to the
bare tool surface after 3 consecutive failures. Stream rules flag
tool-call *narration* ("I'll use the X tool", code-fenced JSON) but defer
the verdict to end-of-turn: a flag is cancelled the moment a real tool
call arrives, and only a narration with NO tool call triggers the
reminder + retry. Per-model capability profiles
(`toolSurface` full/reduced/bare, `maxTools`, `maxToolResultChars` in Model
settings) are honored by both tool-definition paths and result truncation.
**Per-model pricing** follows the same pattern: `priceInPerM` / `priceOutPerM`
(and the pre-existing `free` flag) are set in Model settings, and
`cost_estimator.price_for_model` is the ONLY pricing source — resolve order is
env override → the model's own price → `free` → family table → default, and it
returns `estimated: True` for the last two so a readout can tell a fact from a
guess (`~$0.41`). Do not add a second rate table or a flat-rate computation:
`logger.get_stats` used to bill every token at 3.0/15.0 regardless of model and
disagreed with the composer chip. **0.0 is a price, not an absence** — only
`None` means unset, so nothing on this path may use `value or default`. The
price index is stamped on `(mtime, size)` and busted by `saveProvidersStore`;
`getProvidersStore()` re-reads its file on every call, and the usage endpoint
sums cost across up to 500 events, so an uncached lookup is a per-event file
read. `getProvidersAsModels()` and `_provider_to_dict` rebuild model entries
field by field, so a new per-model field must be named in BOTH or it is
silently dropped on read (write-only).
Routing evidence (`routing_evidence`) is written by the Arena/Debate verdict
endpoint (`POST /api/brain/routing/arena`, `source='arena'`) and read back by
`GET /api/brain/routing/arena` (archive) + `GET /api/brain/routing/suggestions`
(per-model win-rate ranking). There is NO automatic turn rerouting — the old
`AUGUST_AUTO_ROUTE` / `routingSuggestion`-SSE / per-turn auto-route claims were
never wired into the loop and have been removed (Part 25 Phase 4). Sub-agents
inherit the parent retry policy, compact mid-run, and support `yieldSchema` for
structured results.

**Durable memory** — the `<memory>` tail is BM25 over the brain `facts` table,
gated by brain-config `memoryAutoInject` (**default OFF**: recall happens when
the model calls `brain_query`). Two things are true regardless of that gate:
`kind='profile'` facts are an always-in lane (rendered first, ~600-char budget,
injected even with auto-inject off — this is what makes August remember *who
you are* without a keyword coincidence), and a fact dropped for budget is
**named** in a `recall partial:` line rather than vanishing. DB scopes are
`global` and `bot:<agentId>` only; `project:<path>` is refused at the write door
on purpose, because workspace memory is the separate `.aug/memory` markdown
layer that the tail already carries. `skill_delete` proposals, `patchSkill` and
the usage counter all key on `SKILL.md`, never on directory existence — skill
usage lives at `<dataDir>/skills/<name>/.usage.json` and the install tree must
stay free of it. Two serialization traps on this path: a fact/KV value is
**stored JSON-encoded**, so every read door must decode it or the human browse
list shows `“"a sentence"”` where the boot index shows the sentence (and the
edit field re-encodes it on every save) — `memory_store.brain_browse` decodes a
JSON *string* and leaves an object verbatim, because unwrapping one would drop
`details` on the next save. And `_apply_approved` **rewrites SKILL.md
frontmatter wholesale**, so any field a `skill_patch` proposal does not restate
is gone: `supersedes`, `origin`, `learned_from` and `trigger` are therefore read
back off the existing file before the write. Losing `trigger` is not cosmetic —
it is what per-turn relevance matching reads, so a silent patch would retire a
skill from recall. **A learned skill is a procedure, not a rule**: the distiller
drafts section fields (`steps`, `pitfalls`, `verification`, …) that
`skill_service.renderSkillBody` renders, and `skill_service.bodySubstance`
measures **what was drafted before `_ensure_canonical_body` pads it** (two steps,
one pitfall that happened, one verification, one situation to use it in). Below
the bar the verdict becomes a memory lesson instead of a padded skill — the
padding is what used to let a one-sentence rule ship with every heading present.
`amend_trigger` carries no body, so it must ship the target's current body
through: normalizing the empty one wrote placeholders over a real skill on
approval. **The skill format is the Claude/Hermes merge and
`docs/SKILL_AUTHORING.md` is its spec**: the `description` (≤
`_DESCRIPTIONMax` chars) is the TRIGGER — it names the capability, the
situations, and when NOT to fire, because a future agent sees only name +
description before loading; the body's canonical sections are Title, When to
Use, When NOT to Use, Prerequisites, How to Run, Quick Reference, Procedure,
Output format, Examples, Pitfalls, Verification, Reference files, with
bundled (hand-written) skills passing through the normalizer untouched. The
frontmatter parser also reads the nested Hermes `metadata.hermes` block, and
unknown keys round-trip through every patch.

**Memory survives independently of recall** — `app/services/brain_backup.py`
takes online copies through SQLite's backup API (read-only handle, no write lock
on the live file), runs `PRAGMA integrity_check` on every copy before trusting
it, and prunes to a verified rolling set; `GET /api/brain/integrity` is the
health read. **Settings → Memory no longer shows either of them:** the 0.18
restyle removed the "Memory files" card (backups, integrity, restore, raw-state
lookup and the model-context preview all lived in it), so a restore is staged
through `POST /api/brain/backups/restore` and nothing in the UI lists or stages
it — `api/api-client/brain-backup.ts` is the surviving client if the card is
ever rebuilt. **A restore is staged and applied at
the next launch, never in place:** `memory_store.close()` closes only a
thread-local connection while other threads still hold the live file, so an
in-process swap yields a half-old database (and fails to rename on Windows).
`apply_pending_restore()` therefore runs in `main.py` before the store
initializes and keeps what it replaced as `.pre-restore`; the pending marker is
a file, not a row, because the case needing a restore is one where the database
may not open. A copy on a newer schema is refused using the migration runner's
own version discovery. Do not add an in-process swap or a second version
constant. The old "import a legacy DB via Settings → Memory" instruction was
false and is now the real restore route (name the file exactly as
`docs/API_REFERENCE.md` specifies, or it is not listed).

**Model-managed memory (CRUD is a set)** — `remember` (write/update by key),
`list_facts` (enumerate keys) and `forget` (retire) are all **core** tools: they
are in `AUGUST_CORE_TOOLS` so progressive disclosure can never hide the key
lookup that `remember`'s own instructions depend on, and in `_BARE_TOOL_ALLOW`
so a weak/downgraded model can still correct what it remembers instead of only
accumulating. `retrieve_relevant_facts(min_query_chars=…)` splits the two
callers: the automatic tail keeps the 8-character floor (a 4-character message
must not spend context), while a deliberate `brain_query(store='facts')` search
answers even for `"gpu"`. The boot memory index is **frozen per session** to
protect the provider prefix cache, so `<memory_policy>` tells the model to
re-read `list_facts` after writing rather than trusting that index — keep the
prompt text and that behaviour in step if either changes. Sub-agents read and
recall but never write; the parent turn is the single memory write door.

**That read is now enforced, and the read is now complete.** `remember` refuses
its first write in a turn until `list_facts` (or `brain_query` over a memory
store) has run once that turn — only when the store actually holds something to
check, and never when `modelMemoryRead` is off, since a gate the model cannot
satisfy would make memory unwritable. A sentence already stored under a
different key is refused with that key in the result (`existingKey`), because
"update, don't duplicate" was advice, not a mechanism. On the read side
`list_facts` takes `offset` and reports `total`/`hasMore` — it used to be hard
capped at the 50 newest rows, so a store the model could write to was one it
could only partly read back — and `include_retired` exposes the rows
consolidation parked, which recall skips but which are still stored memory.
`brain_query` advertises the `memory` (KV notes) store for the same reason:
reachable-but-unadvertised is a door the model has to guess at.

**The loop's only positive trigger is opt-in** — every other learning pass is
started by something going wrong (a flagged episode, a filed observation, a
failing automation), so nothing ever read a session that went *well*.
`skill_distiller.run_review_pass()` does: one session per pass, the most recently
active one that still has unreviewed messages, rendered as a message-id'd window
and judged with `_REVIEW_SYSTEM` — an extension of `_JUDGE_SYSTEM`, not a second
copy, because "prefer none" must be said once. Verdicts go through the SAME
`apply_verdict` door as episode verdicts, so the memory bar and the dedupe cannot
disagree with themselves by call site, and the fingerprint is `review:<sessionId>`
(a bare message id collides with the `episodes` id space and would let two
sessions silence each other's drafts). Review progress is a **per-session cursor
map** (`internal_state` key `skill_distiller:review:cursors`, JSON dict, capped at
500 entries by lowest cursor) — NOT one global high-water id: work in A, open B,
return to A and A's message ids sit on both sides of B's, so a single cursor
reviews B and then jumps past all of A, which is exactly the "only one session
ever gets learned from" failure the pass exists to fix. An empty window still
advances that session's cursor, so tool-ack-only rows are never re-read. Gated by
brain-config `memoryReview` (**default OFF** — absent key = off, like the runaway
backstop) and scheduled as the `review` job in `learning_scheduler`, so it has its
own ledger row, cadence (`reviewIntervalHours`) and run-now button. Its job
adapter **must drop `results`** before returning: `_finish_run` truncates the
serialized detail at 2000 chars, a 60-entry list measured 2994, and a half-JSON
blob parses to `{}` in `scheduler_status` — a successful review would report as an
unexplained one. Settings → Memory is where the switch is; the Learning panel's
job row names that switch when it is off, so an armed-but-idle loop and a
never-armed one do not look identical.

**Agent modes (0.12.55+)** — `set_agent_mode(chat|agent|code|orchestrator)`
(`planner` is an alias for `orchestrator`) switches the
session: `chat` blocks tool calls (text only), `agent` is native tool calling
(default), `code` executes a fenced ```python block through the existing
sandboxed `run_command` with a workspace-bound tool API (`read_file`,
`write_file`, `run_command`, `list_files` — see
`app/services/workbench/code_runner.py`), `orchestrator` dispatches workstreams
with no shell/edit.
`/v1/responses` supports `stream: true` via upstream-native pass-through.
(The former "loop-level golden evals in `tests/test_harness_evals.py` feeding
`GET /api/brain/harness/evals`" were removed; that file and endpoint no longer
exist — corrected Part 25 Phase 7.1.)

## Directory map & validation routing

| Area | Owns | Validate with |
|------|------|---------------|
| `backend-py/` | FastAPI proxy, workbench, Brain, MCP, tools | `cd backend-py && uv run ruff check . && uv run mypy app/` |
| `frontend/desktop/` | Tauri shell, React UI, Vite build | `npm run check -w frontend/desktop` (tsc + eslint) + `npm run check:design` |
| `frontend/mobile/` | Expo mobile app | `npm run test -w frontend/mobile` (its own `tsc --noEmit` + parity audit — no test files, and none were there to delete) |
| `scripts/` | Build/release orchestration (Node) | run it; `node --check <script>` for syntax |
| `docs/` | User-facing docs, specs, troubleshooting | `npm run check:doc-links` · `npm run check:docs` |

**High-risk coordination points** (touch carefully, validate both layers):

- Version files (see below) — must stay in sync across all 9 checked desktop sources.
- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — upstream serialization; a wrong key breaks all chat.
- **File-read ceilings** — `read_file` refuses a file over `_MAXFileSize` (**20 MB**)
  and tells you to page it. Paging is the documented escape hatch and works up
  to `_MAXPageFileSize` (**200 MB**), which is higher *on purpose* so a large log
  is still readable — but it is finite, because the paged branch reads the file
  twice (text, then raw bytes for the `fileHash` the edit gate needs). Both
  numbers are guarded by `npm run check:docs`.
- **Listing doors** — a credential store is **unlistable**, and that one rule is
  asked at seven doors today: `security.py::workspace_files` (the route the composer's
  @-mention picker and the session list call), `workbench.py::workspaceFiles`,
  `file_tools._listDirectory`, `file_tools._searchFiles` (its root **and** every
  result line), `file_tools._pySearchFilesSync` (the no-`rg` fallback), the
  code-mode `list_files` in `workbench/code_runner.py`, and
  `workbench/module_context._describe_directory`. Each calls
  `sandbox.paths.listable_root` (a directory that is or lives inside a store) then
  `listable_entry` / `listable_child` per entry — `is_credential_directory` matches
  **any whole path component**, so `~/.ssh/keys` is refused, not just `~/.ssh`.
  The file rule is name matching without a resolve, and it is safe **only** because
  every lister clears its directory first; `tests/test_tool_listing_doors.py` pins
  that boundary with a directory link, so a door that lists files without clearing
  its directory fails there rather than in review. An eighth door is how the seventh
  was found — do not add one, call the two helpers.
- **Shell doors and the `.ssh` asymmetry** — `check_hardline_command` refuses a store
  path only for a command that **enumerates** (`_ENUMERATING_COMMANDS`), because
  `.ssh` is deliberately readable at its **public** members while its contents may
  never be walked. That exception is an ALLOW list, `_SSH_PUBLIC_MEMBERS`
  (`config`, `authorized_keys`, `known_hosts`, plus any `*.pub`), judged by
  `_ssh_member_reason` on a DIRECT member — it used to be a deny list (`id_\w+`
  in the read pattern), and `cat ~/.ssh/work_github`, a hand-named identity key,
  read clean through every door. `id_rsa.pub` was refused by the same defect:
  `(?:^|/)id_\w+` matched `id_rsa` inside it, so the `.pub` exemption sits
  immediately after `id_` where backtracking cannot defeat it. Globbing
  (`~/.ssh/*`) and copying a subtree out (`cp -r ~/.ssh/keys /tmp`) are already
  refused by the read/write patterns, not by the store rule — measured, and the
  tests name which rule holds. `backend-py/app/services/workbench/code_runner.py`
  carries a **port** of this guard rendered into every code run (it cannot import
  `app`); a new table or predicate in `sandbox/hardline.py` must be injected there
  too, and `tests/test_code_runner_hardline.py` fails on the drift. The port must
  probe the **resolved** path like `bind_path` does, or a workspace link into a
  store reads the token. Parity is not proof: a corpus entry both copies miss is
  green, which is why that file also asserts the port's own verdicts.
- **One tokenizer, and what it must survive** — `_tokenize` is the only splitter for
  a command line: `_is_write_intent`, `_enumerates_a_directory` and
  `check_hardline_command` all read through `_segments`, because when each had its
  own `re.split(r'\s+')` they disagreed and `ls${IFS}~/.ssh` was one word for the
  enumeration rule and two for every other rule. It splits on shell terminators
  (`; && | < > ( ) ` newline {}`) and expands `${IFS}`, and it must: a glued
  terminator compared the component `.ssh;`, which is not `.ssh`, and
  `bash -c "ls -la ~/.ssh;"` printed the store's whole key inventory. Store
  components are also matched after `_strip_dangling_dots`, because NTFS drops a
  trailing dot or space from the component it opens — `.aws./sso/cache/<hash>.json`
  **is** the SSO cache and leaked a token while `is_credential_directory`, which
  resolves, kept refusing it. Do not add a second split or a second form: the
  parity corpus only catches a blind spot the two copies do not share.
- **The terminal is a gated shell, in both directions** —
  `writeTerminalInput` (the REST route and the drawer's WebSocket both reach it)
  runs the hardline list on **every** line, not on the
  `_interactive_needs_preflight` subset: that predicate exempts anything starting
  with `cd `, which let `cd ~/.ssh/keys && cat id_work` type a private key into a
  buffer readable through `GET /api/terminal/buffer`, and exempts any single
  whitespace token, which let `ls${IFS}~/.ssh` through unchecked. The exemption
  stays only for the soft workspace preflight, whose subject is escaping a
  workspace. `createTerminalSession` additionally refuses a `cwd` inside a store,
  because `session['cwd']` is the launch directory and is never updated — a bare
  `ls` names nothing for the line gate, and the store's contents are the secret
  set. A human who wants their own `cd ~/.ssh` has a terminal outside the app.
- **Hooks are execution policy, so the write door owns them** —
  `<dataDir>/hooks.json` loads with **no** trust decision (the trust gate in
  `user_hooks` keys on a *workspace* origin, and the user-level file has none), and
  the data directory is an allowed root for an absolute `write_file` path. So a
  model could install a shell command for August to run on the next event,
  persistently. `hooks\.json$` is in `_PROTECTED_WRITE_PATTERN` (both the
  user-level and the `.aug/` path); reads stay allowed because a hook definition
  is not a secret. `tests/test_gate_participation.py` exempts the hook engine from
  the shell-spawn scan and now asserts the two doors that make the exemption true,
  so removing either fails there instead of silently re-opening this.
- **Instruction and execution state is a write-door rule, not a proposal rule** —
  `skill_service._skillRoots` reads `<workspace>/.aug/skills`, `<dataDir>/skills`
  and `<dataDir>/bots/<id>/skills` as live layers, `list_all` takes any
  `dir/SKILL.md` in them, and `catalogue()` — the one door every prompt surface
  reads — renders the name and description into the NEXT turn. So `write_file`
  into that layer is installing an instruction: measured at 'Successfully wrote
  209 bytes' with a payload telling the agent to exfiltrate `providers.json`,
  with a `run.sh` beside it, bypassing the proposal, the approval and the content
  rails in `harness_rails` that the learning pipeline is held to. `_agent_state_reason`
  closes the two agent layers plus `mcp-servers.json` (launches a process per
  entry), `automations.json` (`jobType: 'shell'` with its command),
  `<workspace>/.aug/kernel/**` (`run_command` is exempted to EXECUTE that venv's
  interpreter, so a module dropped into its `site-packages` runs on the next
  cell) and the brain database itself (from `AUGUST_BRAIN_SQLITE_FILE` **or** the
  data-dir default — naming only the default protects a file that may not exist).
  The door is fed `_store_match_form`, not `_canonical`: its comparisons are
  lower-cased, so the raw spelling left every data-directory rule inert on
  Windows. Reads stay
  allowed; the sanctioned writers (`skill_service`, `harness_self_improve`) use
  `Path.write_text` and are deliberately NOT behind the door, which is what makes
  the proposal route the only one a model can take. The BUNDLED layer
  (`<repo>/skills`) and a workspace's own `AGENTS.md` stay writable on purpose:
  that is a developer's checkout, reviewed in a diff, not app state a model owns.
  Code mode has its own `write_file`, so the port carries the rule by injection.
- **Heading demotion postprocesses HTML** — `frontend/desktop/src/lib/
  markdownHeadings.ts` shifts `<h1>`–`<h5>` in the rendered string, after `marked`
  has decided what the headings are. It used to rewrite the markdown SOURCE, and a
  fuzz against `marked` (217,831 documents) found 12 ways that second parser
  disagreed with the real one — h1s escaping into the dialog and non-headings being
  rewritten in the same pass, including every CRLF document being re-ended. Do not
  move the decision back to the source: the live block cache also keys on the
  flag, because the same streamed block renders at two levels on two surfaces.
- **Gate participation** — every sandbox / permission / URL guard is an inline
  `if toolName in (...)` prologue at one call site, so an **alias or aggregate
  entry point is unguarded by default**. `bulk` routes `operation=<x>` to the
  same handler as `x`. When you add a tool, a bulk operation, or a new router,
  assert it is claimed by a gate: `tests/test_gate_participation.py` fails with a
  table of unclaimed entry points. Five real guards were missing this way
  (audit 2026-09-27 #2, #6, #8, #22, #30).
- `backend-py/app/services/sandbox/` — permission policy; changes affect tool execution safety.
- `_executeTool` hash-anchored edits + `toolDefinitions`/`openaiToolDefinitions`
  capability filtering — both wire formats must stay in sync.
- `adapters/stream_state.py` `AnthropicNativeStreamState` — tool_use input
  accumulation; a regression re-runs managed tools with empty args.

**Fast path for backend-only changes:**

```bash
cd backend-py && uv run ruff check . && uv run mypy app/
```

That is the whole local gate for backend work. It used to be followed by
`uv run pytest -q -n auto` — a ~2h serial suite of ~4,970 tests, of which the slow
ones shelled out to real external toolchains (Quartus, arduino-cli, ngspice) in
independent temp dirs. All of it, the `-n auto` advice, the 55% coverage floor
and the harness-core ratchet were retired on 2026-10-17 (see the note at the
top). Nothing below is a command you can run any more; it is here because it
explains why some code is shaped defensively.

**The release job builds; it does not test.** `release-desktop.yml` checks
`uv lock --check`, ruff and mypy, then produces the signed installer, and `Type
check` runs the static gate set on every push to every BRANCH. A tag push does
NOT trigger `Type check` — the workflow filters on `branches`, not `tags` — so
the tag's commit was checked when it was pushed to the branch, and publication
does not wait for that check. **Confirm it is green before pushing the tag** —
`git push origin master v0.18.16` does not wait for it.

Two mechanism notes the deleted suite paid for, both still true of the code:
`PRAGMA journal_mode=WAL` is the one SQLite statement that gets no busy handler
(so `connect(timeout=)` does not cover it — `memory_conn.apply_conn_pragmas`
retries), and a baseline written off the event loop and joined best-effort means
`done` never meant "landed". A statement with no busy handler and a deliberately
asynchronous contract both surface as load-dependent failures; fix the mechanism.

## Version files to bump together on desktop ship

All 9 sources must match (`scripts/check-version-sync.mjs` verifies):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (august-desktop entry)
- `package-lock.json` (root + `packages['frontend/desktop']`)
- `docs/api/openapi.json` (`info.version`)

**The OpenAPI spec is a version source because the app serves it.** The schema's
`info.version` is `backend_version()` (`backend-py/app/version.py`), which reads
the root `package.json` in a checkout — so a bump moves the served schema too.
Regenerate it in this order, or the release's own drift gate fails:

```bash
npm run gen:openapi   # docs/api/openapi.json from the app
npm run gen:api       # frontend/desktop/src/api/gen/openapi.ts from the spec
```

`npm run gen:api` is a no-op for a version-only bump (the version is not in the
typed client), but the spec must be regenerated first or `npm run check:api`
fails with a one-line version diff. The `check-version-sync.mjs` gate now
catches it before the release job does.
