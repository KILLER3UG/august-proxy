# Part 27 — Subagent & transcript UI parity, memory/skills readability, bots UI, test-data hygiene

Date: 2026-09-05 · Status: **IMPLEMENTED (A,B,C,D,E,G + F1–F5) — F6 deferred** · Owner: desktop frontend + backend-py

## Implementation status (2026-09-05)

- **Done & validated** (frontend 988/988, backend targeted green: migrations + bot-mode
  phase D + agents/rooms router; ruff+mypy clean): Part A (A1 inline `SubagentDelegateRow`,
  A2 task-titled tab strip + search dropdown, A3 "Working for …" header, A4 Progress popover,
  A5 transcript replay via the existing endpoint, A6 dead-code purge), Part B (B1
  `ExploreGroup`, B2 composer copy), Part C (C1 migration 037 + privacy keep-list + flag
  retire, C2 KV browse denylist, C3 KV summary render, C4 in-memory capped jobs ledger),
  Part D (D1 centered detail, D2 humanized episodes, D3 plain learning header, D4
  disambiguated scope labels + temp-dir filter), Part E (E1 leaked-fixture purge migration +
  session sweep, E2 `dataDir()` pytest guard), Part G (G1 grouped mentions + junk filter,
  G2 thinking/row reveal), and Part F's F1 (rail search/bell/"+" menu), F2 (`BotCreateModal`
  face picker), F3 (rooms reachable via a rail overlay + reference room layout: member tab
  strip, Activity row, collapsible threads, reply-in-thread, new-thread composer, room
  header), F4 (migration 038 `thread_id` + rooms.py threading + router), F5 (bot profile
  landing — row click opens the profile, "Open chat" enters the session).
- **Deferred — F6 "Action needed" escalation card.** The login-wall detection + screenshot
  capture + resume signal land in the sandbox/tool-execution path that AGENTS.md flags as a
  high-risk coordination point, and the resume loop can't be validated without live
  computer-use runs. Shipping a card that can't actually resume is worse than not shipping
  it; the plan text for F6 stands as the next slice.

## 0. Goal

Four outcomes, one plan:

1. **Subagent visibility** — every subagent gets a first-class row in the transcript, opens as a
   titled tab in the right pane, and replays its full work log (reverses the "drawer-only"
   decision of `265ba24a`, 2026-08-21, which made worker failures invisible).
2. **Transcript language** — grouped Explore rows + queue-follow-up composer copy.
3. **Human-readable surfaces** — the Memory tab, the Skills/Learning panel, and the scope
   selector currently dump raw machine data (a 29 KB JSON blob, `tool-error:august-harness-loop`,
   seven identical "proj" entries, a phantom "Test plan"). August should *learn internally* and
   render only what a human can act on. Root cause of most of it: **pytest fixtures leaked into
   the live dev stores** — fixed at the source, not just cosmetically.
4. **Bots as teammates** — the Bots rail, New Bot flow, rooms, and bot chat adopt the
   reference layout: searchable rail with previews, an avatar-picker creation modal, rooms
   threaded inline with an Activity row, a bot profile landing, and an "Action needed"
   escalation card when a Bot's computer-use run hits a login wall.

## 1. Verified current state (anchors, 2026-09-05 @ b39c5cde)

### 1a. Subagent surfaces

| Fact | Anchor |
|---|---|
| Subagent tool-call blocks silently consumed — nothing renders inline | `frontend/desktop/src/sections/chat/message/AssistantBlockTimeline.tsx:536-551` |
| Only trace: non-clickable "· N workers" tally | `components/chat/ActivitySummary.tsx:99-101`, fed at `AssistantBlockTimeline.tsx:995` |
| Drawer roster + internal tab strip (role-only labels, no elapsed/icon/search, only after selecting) | `components/shell/RightDrawerSubagentsSection.tsx:299-336, 428-493`; disambiguation `:208-228` |
| Selected-view header has no running timer | `RightDrawerSubagentsSection.tsx:343-351` |
| Per-agent todo card (inline, not popover) | `RightDrawerSubagentsSection.tsx:114-153` |
| Steer box | `RightDrawerSubagentsSection.tsx:396-422` |
| Live transcript body already shares chat row language | `components/chat/SubagentTimeline.tsx:227-310` |
| Auto-open once per run + badge | `components/shell/ChatLayout.tsx:284-303, 618` |
| Live state in-memory SSE only (lost on reload) | `sections/chat/stream/apply-subagent-event.ts`; `types/chat.ts:243-260` |
| Roster poll 2 s/10 s; persisted runs w/ result_full + todos | `RightDrawerSubagentsSection.tsx:180-201`; `api/workbench.ts:356-369` |
| Backend transcript endpoint EXISTS, frontend never calls it | `backend-py/app/routers/subagent.py:306-317` |
| Dead components, zero importers | `SubagentRow.tsx`, `SubagentLaunchList.tsx`, `SubagentDetailModal.tsx`; stale comment `AssistantBlockTimeline.tsx:208` |
| Focus→drawer plumbing already written | `SubagentLaunchList.tsx:39-49` |

Already at parity — no work: `EditRailRow` + `DiffCodePanel` (expanded diff with line numbers),
`ThoughtStep`, `ToolStepRow`, `QueuePills` (drag/edit/cancel/promote-steer; mounted
`ChatThreadComposer.tsx:396`).

### 1b. Memory tab (the pasted blob)

| Fact | Anchor |
|---|---|
| The blob = KV row `agent_jobs` (28,887 chars dev / 44,667 prod), one JSON array of 30 legacy registry jobs, 2026-07-14→08-16 | `C:\Dev\august-proxy\data\august_brain.sqlite` + `AppData\Roaming\com.august.proxy\data\august_brain.sqlite`, `memory_store` table |
| Written by the legacy agent-registry ledger, not the current orchestrator (`subagent_runs` is the live one) | `backend-py/app/services/tools/agent_registry.py:18, 196-245`; `app/services/subagent_orchestrator.py:127-193` |
| `save_internal` docstring: KV is "machine state … not user-visible memory" — but the tab shows it anyway | `app/services/memory_store/kv.py:19-31` |
| Memories tab lists the KV store and renders the whole raw value as the row summary | `sections/settings/MemorySection.tsx:99-102` (SCOPES), `:192-198` (`STORE_META.memory.summary`) |
| Tab claims machine state is "only ever visible [in Raw state lookup] — never in Memory itself"; exclusion covers only `cognitive:*` | `MemorySection.tsx:1502-1504` |
| Privacy purge explicitly KEEPS `agent_jobs`; no cap on growth; feature flag registered | `app/routers/privacy.py:67`; `agent_registry.py:204-218`; `app/services/brain_config_service.py:83` |
| Does NOT leak into prompts — `<memory>` block is facts-only | `app/services/memory_store/fact_retrieval.py:108, 292` |

### 1c. Skills / Learning / scope

| Fact | Anchor |
|---|---|
| "tool-error:august-harness-loop failure_recovery · resolved score 0.60" = raw `episodes` row (id=2): fingerprint + kind + outcome + tier1 score rendered verbatim | `sections/settings/LearningPanel.tsx:212-218`; DB `episodes` table; writer `app/services/episode_miner.py` (Part 16) |
| Header chips are internal telemetry jargon: "Episodes 3 · Tier 2 1 · Judged 0 · Fingerprints 2 · Resolved 0 · Precision —" | `LearningPanel.tsx:117-123` |
| Skill detail view is `max-w-3xl` with no `mx-auto` → left-aligned, dead right margin | `sections/settings/SkillsSection.tsx:373` |
| Scope dropdown = workbench sessions' distinct `workspacePath` basenames → 7× "proj" + "testWorkspaceBlockCarriesTheMa0" (verified live on :8085) | `backend-py/app/routers/august.py:352-389`; `SkillsSection.tsx:314-327` |

### 1d. Test-data leakage (root cause, verified live)

The running dev backend's stores contain pytest fixtures:

- 6 sessions whose plan bodies are literally `{"plan":"Test plan","steps":["Step 1"]}`,
  `{"plan":"My plan"}`, `{"plan":"Test"}`, `{"plan":"1. write the file"}` — from
  `tests/test_workbench.py` + `tests/test_workbench_plan_routes.py`. When one of these sessions
  is open, the Plan drawer auto-opens showing the test plan (the user's "sometimes the right
  side panel shows up with a test plan").
- 11 empty "New chat" sessions bound to `%TEMP%\tmpXXXX\proj` dirs → the 7 "proj" scope entries.
- `agent_jobs` July entries whose errors contain `<MagicMock name='mock.model'>` — registry
  tests dispatched jobs against the shared dev DB.
- `episodes` id=3 with `session_id='s1'`, `fingerprint_id='fp1'`, `scope='bot:alpha'` —
  bot-mode test fixtures in the learning corpus.

### 1e. Bots UI (current vs reference)

| Fact | Anchor |
|---|---|
| Rail rows already match the reference format: identicon avatar + title + timeAgo + last-message preview + presence dot + "Active now" strip | `components/sidebar/BotsRail.tsx:210-267, 384-404`; avatar hash `lib/bot-avatar.ts` (8-color palette, name+salt → SVG) |
| No rail search, no notification bell; "+" toggles an inline 2-field form (Name + Display title) — no Description, no avatar picker, no modal | `BotsRail.tsx:373-430` |
| Avatar randomize exists only as a row-menu action (salt bump) | `BotsRail.tsx:74-77` |
| Rooms are a separate two-pane page (room list + flat log), NOT mixed into the Bots rail; header is name + trash only; composer is one flat input; no threads, no Activity row, no member tab strip | `components/sidebar/RoomView.tsx:104-224` (list `:107-172`, header `:182-191`, flat log `:193-197`, composer `:198-219`) |
| Clicking a rail row opens the chat directly — no bot profile landing | `BotsRail.tsx:314-321` (`ensureBotChat` → `onOpenSession`) |
| Bot chat = regular workbench session (`canonicalBotChat`), so Thought disclosures + rich markdown already render there | `RightDrawer.tsx:473-482`; sessions `canonicalBotChat` flag |
| No "Action needed" escalation card anywhere — the only "handoff" surface is model-switch (`HandoffNoticeCard.tsx`); sandbox approvals exist as `pendingApproval` on tool rows | `sections/chat/message/HandoffNoticeCard.tsx`; `components/chat/tool/ToolCallItemBody.tsx` (pendingApproval) |

### 1f. Composer mentions & streaming reveal

| Fact | Anchor |
|---|---|
| Mention sources all exist (skills, static tools, MCP, files, conversations, bots, lanes/routines) but merge into ONE flat list — no section headers, no kind badges; order `harness, bots, skills, tools, mcp, files, conversations` buries the useful entities under file noise | `sections/chat/composer/useComposerPopovers.ts:251`; `composer-mentions.ts:53-97` |
| File listing returns OS/git junk when the session is home-anchored (the Tasks group anchors at `Path.home()`): `@ntuser.dat.LOG2`, `@NTUSER.DAT{…}`, `@post-checkout`, `@post-commit` — verified in the user's screenshot | `composer-mentions.ts:54-73` (`/api/workbench/workspace/files`); home-anchor `august-task-group-home-workspace` |
| Streaming fade exists ONLY for the answer's last markdown block: `.md-live-tail` 0.14 s (0.42→1) + `.markdown-content--settle` 0.16 s; the trailing-edge mask was deliberately removed (hid the final answer's tail) | `styles.css:756-800`; `sections/chat/ChatMarkdown.tsx:447,456` |
| Thinking has no reveal animation at all (`aria-live` only); tool/subagent output rows pop raw | `components/chat/ThoughtStep.tsx:159`; `SubagentTimeline.tsx` |

## 2. Part A — Subagent surfaces

### A1 · Inline delegate row (keystone)

Replace the silent consumption (`AssistantBlockTimeline.tsx:536-551`) with **one row per
launched agent**, emitted at the consumed block's position so ordering vs thinking/text holds:

```
⧉ SubAgent  general-purpose · Audit Part 17 memory plan        Failed
⧉ SubAgent  general-purpose · Audit Part 22 research plan      ⟳ 3m 12s
```

- Bold `SubAgent`, role in accent color, muted task, right-aligned status (`Failed`/`Cancelled`
  underlined muted-red; running = spinner + live elapsed).
- Click → `setFocusedSubagent(jobId…)` + `addRightDrawerSection('subagents')` + select that tab
  (plumbing exists at `SubagentLaunchList.tsx:39-49`; wire `focused.jobId` → `setSelectedTaskId`,
  half-done at `RightDrawerSubagentsSection.tsx:169-172`).
- One spawn call fanning out to N agents → N rows (entries keyed by `parentToolId`).
- Source of truth: `subagentBlocks` (live) merged with roster rows (settled/reloaded) — same
  union as the drawer's `entries` (`:230-267`).
- **Earns it:** delegation is currently invisible in the thread; failures invisible until the
  user finds a drawer they may not know exists.

### A2 · Worker tab strip upgrade

`RightDrawerSubagentsSection.tsx:299-336` → browser-style tabs:
- Label = **task title truncated** + `· 25m` elapsed + status glyph + `×`.
- Chevron opens a **"Search tabs…" dropdown** listing open tabs (title + elapsed + ×);
  filter-as-you-type; click selects.
- Strip visible whenever ≥1 agent exists (not only after selection).

### A3 · "Working for 31m 19s" live header

Selected-view header (`:343-351`) gains a ticking elapsed while running, frozen after settle
("Worked for …"). Lift the timer + seconds-vs-ms normalization from dead `SubagentRow.tsx:50-62`.

### A4 · Progress popover

Replace the inline "Worker plan" card with a header chip `Progress 7/10 ⌄` opening a popover:
`✓ 7 completed` collapsed group, `→` current, `○` pending. Row rendering reused from
`TodoProgress` (`:129-150`); live-vs-persisted todos precedence (`:359-365`) unchanged.

### A5 · Transcript replay for settled agents

After reload a tab shows only final text (`:381-385`). Add `getSubagentTranscript(taskId)` to
`api/subagents.ts` hitting the existing endpoint (`subagent.py:306-317`); on tab open with no
live block, fetch and map events → `MessageBlock[]` → `SubagentTimeline`.
**Earns it:** every worker's full work log stays reviewable per tab.

### A6 · Dead-code resolution

Delete `SubagentRow.tsx`, `SubagentLaunchList.tsx` (plumbing moves into A1's component),
`SubagentDetailModal.tsx` (drawer tabs supersede it); fix stale comment
`AssistantBlockTimeline.tsx:208`; delete `SubagentLaunchList.test.tsx`, add
`SubagentDelegateRow.test.tsx`, extend `RightDrawerSubagentsSection.test.tsx`.

## 3. Part B — Transcript row language

### B1 · Explore grouping row

Consecutive **read-only** tool rows (searches, file reads, read-only terminals — `view` bucket +
search in `lib/tool-classify.ts`) collapse under one parent:

```
🔍 Explore · 3 searches, 1 file        ⌄
     Terminal  cd backend-py && grep -n "def _openaiContentToText" …
     Read  🐍 providers.py  backend-py/app/services/workbench/
```

- Counts: "N searches, M files" / "N files" / "1 search, 1 file".
- Open while running; auto-collapse when the next non-read step lands (same settle rule as
  `ActivitySummary collapseWhen`); manual toggle persists per turn.
- Edits, memory writes, side-effect commands, subagent rows stay individual. Extends Part 15 §4
  same-file `×N` consolidation to mixed read clusters (single-file repeats keep `×N`).
- **Earns it:** research turns flood the thread with 10–30 flat rows; identical information at
  one row's height.

### B2 · Queue-follow-up composer copy

Streaming placeholder `Add a direction while the assistant works…`
(`ChatThreadComposer.tsx:440-442`) → `Keep typing to queue follow-up changes`. Behavior already
matches (`QueuePills` + `→` pill). One-line copy change.

## 4. Part C — Memory tab hygiene

### C1 · Purge the `agent_jobs` blob

Delete the `agent_jobs` KV row from both DBs (one-shot boot migration keyed on the legacy
registry's own marker, or a maintenance script). It is dead legacy data — the live history is
`subagent_runs`. Remove `agent_jobs` from `_KV_KEEP_KEYS` (`privacy.py:67`) so future purges
collect it, and retire the `agentJobs` flag (`brain_config_service.py:83`).

### C2 · Machine-state keys never render in Memories

Extend the exclusion that today covers only `cognitive:*` (`MemorySection.tsx:1502-1504`) to a
shared backend denylist (`agent_registry`, `agent_jobs`, `diff_learn:*`, `internal:*`): the
`/api/brain/stores/memory` browse filters them out; they remain reachable via Raw state lookup.
The tab's own copy already promises this — make it true.

### C3 · KV notes render human-first

For the remaining note-like KV rows, `STORE_META.memory` (`:192-198`) shows `key` as title and a
**summarized** value (first line, ≤160 chars, JSON pretty-printed only in the expanded body) —
never a raw 29 KB blob as a one-line summary.

### C4 · Cap the registry ledger (if kept)

If `list_agent_jobs`/`/api/agents/jobs` stays registered, cap `createJob` history to the last 50
jobs (`agent_registry.py:204-218`); otherwise delete the jobs half of the module and keep only
the roster (`agent_registry` is still used by Bot Mode Phase B — do NOT delete that).

## 5. Part D — Skills & Learning readability

Design rule (user directive): **August learns internally; the UI shows only what a human can
act on.** The learning corpus (`episodes`, fingerprints, tiers) stays model-facing; the panel
translates it.

### D1 · Center the skill detail view

`SkillsSection.tsx:373` `max-w-3xl` → `mx-auto max-w-3xl` (kills the dead right margin in the
detail screenshot).

### D2 · Humanize flagged-episode rows

`LearningPanel.tsx:212-218` renders the raw fingerprint mono string. Map to a sentence:
`tool-error:august-harness-loop` + `failure_recovery` + `resolved` + `0.60` →
**"Recovered from a tool error while using the august-harness skill · resolved · confidence 0.60"**.
Kind→phrase table (`failure_recovery`→"recovered from a failure", `correction_accepted`→
"you corrected it and it adapted", …); fingerprint→skill/tool name extraction; score→"confidence".
Raw key stays in a `title` tooltip.

### D3 · Plain-language learning header

Replace the six telemetry chips (`LearningPanel.tsx:117-123`) with one sentence —
"August has learned from 3 recent sessions · 2 patterns tracked · nothing promoted yet" —
with the raw counts behind a small expand ("Details"). `Run learning pass` / `Curate skills
(dry run)` buttons stay.

### D4 · Scope selector labels

After Part E's purge the junk entries are gone; additionally: when two workspaces share a
basename, label shows `name (parent)`; full path in the option's `title`; and the endpoint
(`august.py:352-389`) skips paths under the system temp dir (defense-in-depth — a temp dir is
never a real project).

## 6. Part E — Test-data isolation (root cause)

### E1 · One-shot purge of leaked fixtures

Boot migration (or `scripts/` maintenance command) deleting from the LIVE stores:
sessions whose plan body matches known fixture strings (`"Test plan"`, `"My plan"`, `"Test"`,
`"1. write the file"`) or whose `workspacePath` is under the temp dir; the `s1/fp1/bot:alpha`
episode row; `agent_jobs` (covered by C1). Guarded: only deletes rows matching the fixture
signatures, never real chats.

### E2 · Stop the leak at the source

The fixture sessions/jobs/episodes prove some tests write to the shared dev data dir. Fix:
`conftest.py` session fixture forcing `AUGUST_DATA_DIR` (and the brain DB env) to a per-run
tmp dir for every test that touches `save_sessions`/`save_internal`/`episode_miner`; plus a
hard guard — those writers raise (logged, non-fatal under pytest) when `PYTEST_CURRENT_TEST`
is set and the resolved data dir is not under the tmp basetemp. This is the same trap family
as the pytest basetemp PermissionErrors — one root, many symptoms.

## 7. Part F — Bots UI (teammate layout)

Design rule: a Bot reads like a coworker in a chat app — face, name, what it last did, and a
way to hand it the keyboard when it gets stuck. Rail rows already match the reference format
(§1e); the gaps are the creation flow, rooms, the profile landing, and the escalation card.

### F1 · Rail chrome: search + bell + "+" menu

- Search input above the roster ("Search bots…") filtering by name/title/description.
- Bell toggle (mute all Bot notifications) beside the "+" — persists to `uiMeta`/config.
- "+" becomes a dropdown: **New Bot** / **New Group Chat** (opens F2 modal / F3 create),
  replacing the inline 2-field form (`BotsRail.tsx:373-430`).

### F2 · New Bot modal with avatar picker

Centered modal (Cancel / Create Bot): live avatar preview; tabs **Shapes · Shuffle · Upload**
(August-native for the reference's Bot/Generate/Upload/Pet); a grid of fixed face shapes
(solid color from the existing palette) vs the hash blob; **Randomize** and **Lock face**
toggles; hint "Face follows the name" (unlocked avatars re-derive from name edits); fields
Name / Title / Description; **Advanced** disclosure (model, skills, memory scope — the
existing Bot fields). `uiMeta.avatar` gains `{shape, locked}` alongside the salt
(`BotsRail.tsx:74-77` randomize stays as the Shuffle action).

### F3 · Rooms inline in the rail + room header

Rooms render as rail rows mixed with Bots (group icon, `"Name1, Name2, …"` title,
`"You: …"` preview, timestamp, amber needs-you dot — data already in `RoomView`'s
`needs_you` `:167`). The separate two-pane page goes away; selecting a room row swaps the
main pane. Room header: group icon + member names + `N bots` + settings gear (rename,
members, round caps) + delete. Member tab strip (uppercase names) under the tab row.

### F4 · Room threads + Activity row

- **Activity row** at top: `> Activity  <bot> is working… · 3 sec. ago` — collapsible, fed by
  the room driver's round state (rooms.py rounds; poll or reuse the session-stream store).
- **Threads**: messages group into threads (first message + replies); thread card shows
  `⌄ Collapse thread`, the `You` bubble, `Reply in thread`; live `"<bot> is thinking…"`
  italic row while a round runs. Composer placeholder: `New thread in <room>… (@name to
  direct, @everyone for all)` + **New Thread** button. Needs a `thread_id` on `RoomMessage`
  (backend `bot_mode/rooms.py` + migration) — the one schema touch in Part F.

### F5 · Bot profile landing

Rail-row click opens a profile pane before the chat: large avatar, name, `Bot · @handle`,
device line ("This device"), description, and copy — *"Open this bot's continuous chat. Its
background work keeps running when you switch away."* — with an **Open chat** button
(`ensureBotChat` → session). One extra click; the profile also hosts the row-menu actions
(randomize, hide, duplicate, delete) so the rail stays quiet.

### F6 · "Action needed" escalation card (computer-use handoff)

When a Bot's computer-use/browser run hits a credential wall (login page, 2FA, captcha),
post a card into the bot chat instead of failing the turn:

```
Computer                                   ⚵ Action needed
Sign in to <site> so I can see your accounts.
[ screenshot thumbnail ]
[ Take over ]  [ I'm done ]
```

- **Take over** → focuses the Browser/Computer Use panel on that window (user drives).
- **I'm done** → resumes the run from the same session (the tool call retries once).
- Reuses the existing capture path (ffmpeg-dshow screenshot pattern from the camera feature)
  and the sandbox `pendingApproval` mechanism — new `escalation` kind on the approval channel.
- Backend: emit `action_needed` (screenshot path + resume token) from the computer-use tool
  wrapper when a login form is detected; frontend renders the card in `MessageBubble`'s
  block pipeline.

## 8. Part G — Composer mentions & streaming reveal

### G1 · Mention picker: grouped, labeled, skills/tools/chats first

The @ picker already knows about skills, tools, plugins, chats, bots, and files — but renders
them as one flat list where home-dir file noise (`@ntuser.dat.LOG2`, `@post-checkout`,
`@NTUSER.DAT{…}`) dominates and the useful entities sink. Rework the dropdown
(`useComposerPopovers.ts:251`, `ComposerMentionsDropdown.tsx`):

- **Grouped sections with headers + kind badges**: Skills · Tools · Plugins · Chats · Bots ·
  Lanes & Routines · Files. Keyboard nav walks groups; each row shows its type badge
  (the `desc` field already carries "Workspace file" / "Past conversation · model" — promote
  it to a chip).
- **Empty-query defaults**: skills + tools + recent chats surface first (the entities the user
  asked to be visible); files only when the query matches a path prefix.
- **Junk filter** for file results: drop `NTUSER.DAT*`, `ntuser.dat*`, `*.LOG*`, `.git/`
  internals (hooks like `post-checkout`/`post-commit`), `AppData\Local\Temp\*`, and dotfiles —
  client-side denylist in `fetchFileMentions` (`composer-mentions.ts:54-73`) plus a backend
  skip in the workspace-files listing. Home-anchored Task sessions (the group anchors at
  `Path.home()`) currently make every file mention a Windows-registry artifact.
- **Earns it:** the screenshot shows the picker unusable at empty query; grouping makes
  skills/tools/chats discoverable in one glance.

### G2 · Smooth-but-fast streaming reveal (answer + thinking + tool output)

Today only the answer's last markdown block fades (`.md-live-tail` 0.14 s,
`ChatMarkdown.tsx:456`); thinking and tool/subagent output pop in raw. Extend the same
one-shot, newly-mounted-node pattern:

- **Thinking**: `ThoughtStep`/`ThinkingDisclosure` live text gets the tail fade (same
  0.42→1, 0.14 s ease-out) on each newly-appended paragraph — animate only the new node,
  never re-animate settled text on token flushes.
- **Tool/subagent output rows**: new rows inside `SubagentTimeline`/`ToolStepRow` bodies get
  a 120–160 ms rise (opacity + 2 px translate-y), matching `chat-final-stream-enter`.
- **Constraints**: fast (≤160 ms), one-shot per node, no trailing-edge mask (it was removed
  for hiding the final answer's tail — `styles.css:759-764`), all under the existing
  `prefers-reduced-motion` block (`styles.css:796-806`), and zero effect on the settle path
  (final parse stays byte-identical — `ChatMarkdown.tsx:305`).
- **Earns it:** the current hard-pop reads as a render glitch on every model; a sub-200 ms
  fade is perceived as continuous ink without adding latency.

## 9. Non-goals

- No changes to steer/stop/queue semantics or the orchestrator.
- No reintroduction of the expanded inline chat card — the drawer tab is the detail surface.
- No prompt-path changes (the blob never reached prompts — verified `fact_retrieval.py:108,292`).
- No version bump here (ship-time concern, per AGENTS.md 7-file sync).

## 10. Validation

- `npm run test:frontend` + `tsc` (eslint has pre-existing errors at HEAD — compare, don't blame).
- New tests: A1 row render/click/fan-out; A2 labels + search dropdown; A5 event→block mapping;
  B1 grouping boundaries; C2 denylist browse filter; D2 kind/fingerprint mapping; E2 guard
  (a test that tries to write the live dir under pytest must fail); F2 avatar picker
  (shape/lock/salt round-trip through `uiMeta`); F3 rooms-in-rail rendering + needs-you dot;
  F4 thread grouping + `thread_id` migration; F6 escalation card render + resume signal;
  G1 grouped mention sections + junk denylist; G2 fade applied once per new node (no
  re-animation on token flush — assert with a streaming test).
- Backend: `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q`
  (E2 touches conftest + writers; C1/E1 are migrations — test them against a copied fixture DB).
- Manual (`npm run dev:desktop`): spawn 3 workers, kill one → rows show Failed; reload → tabs
  replay; Memory tab shows no `agent_jobs`; Skills scope dropdown lists only real projects;
  opening any session never shows "Test plan"; create a Bot via the new modal (pick a shape,
  lock it, reload — face persists); open a room → threads + Activity row; drive a Bot into a
  login wall → "Action needed" card, Take over works, I'm done resumes.

## 11. Open questions (recommendations — confirm or overrule)

| # | Question | Recommendation |
|---|---|---|
| OQ1 | A1: one row per agent, or per spawn call with ×N? | Per agent — matches reference, keeps failures attributable |
| OQ2 | A4: popover replaces the inline card entirely? | Yes — one affordance, header chip |
| OQ3 | B1: group across interleaved thinking? | No — consecutive tool rows only; thinking stays on the rail |
| OQ4 | A6: delete `SubagentDetailModal` or keep as fallback? | Delete — drawer tabs cover it |
| OQ5 | A2: tab strip visible even in roster (unselected) view? | Yes — strip always present when ≥1 agent |
| OQ6 | C4: keep the legacy registry jobs surface at all? | Delete jobs, keep roster (`agent_registry` feeds Bot Mode) |
| OQ7 | E1 purge mechanism: boot migration vs manual script? | Boot migration, idempotent, signature-matched only |
| OQ8 | D3: hide the learning panel behind a toggle? | No — keep visible but plain-language; it's proof August learns |
| OQ9 | F5: profile landing or keep direct-open? | Profile landing — matches reference; double-click / "Open chat" is one extra click but gives Bots an identity surface |
| OQ10 | F4: threads client-side (group by round) or backend `thread_id`? | Backend `thread_id` — client grouping breaks across reloads and needs-you routing |
| OQ11 | F6: escalation card for browser-use only, or any sandbox approval? | Computer/browser use first (login walls are the common case); generic approvals stay as tool-row pills |
| OQ12 | G1: keep files in the @ picker at all for home-anchored Task sessions? | Yes but query-gated (path-prefix match only) — at empty query, skills/tools/chats own the list |
| OQ13 | G2: per-sentence reveal for thinking, or per-paragraph? | Per paragraph — sentence-level splits fight markdown re-parse and cost cache-neutral render churn |

## 12. Provenance (record area only — not implementation input)

References: user-supplied screenshots (2026-08-27→2026-09-05) of external harness UIs — an
agent-workbench app (inline SubAgent rows, tabbed worker pane + search dropdown, progress
popover, grouped Explore rows, queue composer) and a bot-teammate app (rail with search/bell,
avatar-picker New Bot modal, rooms with member tabs + threads + Activity row, bot profile
landing, "Computer / Action needed / Take over / I'm done" escalation card) — plus screenshots
of August's own Skills/Memory tabs showing the unreadable states described in §1b–§1d. All
features above carry August-native names; implementation follows this text alone.
