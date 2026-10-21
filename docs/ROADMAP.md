# Roadmap — deferred work, and the decisions behind it

This file records what was **deliberately not done**, and why. Everything
here was seen, evaluated, and left alone on purpose — it is not a backlog of
forgotten things. If you pick something up, move it out of here and into a
commit message.

The reference for the chat surface is Claude Code / ChatGPT. The table below
is the gap between what the reference shows and what August shows now.

## Shipped in this round

| Change | Where |
|---|---|
| A run of tool calls collapses into one activity line + a bordered card | `components/chat/ActivityGroup.tsx`, `lib/tool-summary.ts` |
| **A run of tool calls collapses into ONE line whatever the kind** — reads, commands, edits, memory writes, plain tool calls. A MIXED run (a read, a command, a read) is one line, and the phrase names each kind. The `ExploreGroup` and its "Explore · 2 searches, 3 files" vocabulary are gone, merged into the activity line. | `components/chat/ActivityGroup.tsx`, `lib/tool-summary.ts`, `sections/chat/message/AssistantBlockTimeline.tsx` |
| **A run containing a FAILURE is grouped too, and the group OPENS on it** — the line is marked and the red is on screen without a click. The old rule kept a failure out of the group so it could never be hidden; opening the group answers that objection without giving up the grouping. | `components/chat/ActivityGroup.tsx`, `sections/chat/message/AssistantBlockTimeline.tsx` |
| The run phrase ("Ran 4 commands", "Ran 4 commands, read a file", "Ran a command, edited a file") | `lib/tool-summary.ts` |
| **The disclosure owns its body** — the trigger advertises a real `aria-controls` and `aria-expanded` in BOTH states, and the body is mounted-and-hidden rather than absent from the DOM. `ThinkingDisclosure`, `tool/ToolCallItem` and `CompactionNoticeCard` pass `content`; `ChangesCard` is the last. | `components/chat/DisclosureRow.tsx` |
| The self-correction frame is visible in the transcript | `lib/recovery-copy.ts`, `makeStreamHandlers.ts` |
| The model list no longer paints a long id over its own badges | `sections/workspace/models/ModelRow.tsx` |
| **The All-models tab is a LIST, not a card grid** — one row per model: the display name (the id in mono when there is no name), a context-window chip, the state chips, and the reference's right-aligned **pin · test · edit · delete** cluster. The tab could pin a model before and could not test, edit or remove one, while the provider list beside it could do all four. Both lists now sort by ONE comparator, so a model pinned in one is in the same place in the other | `sections/workspace/models/AllModelsTab.tsx`, `sections/workspace/models/ModelRow.tsx`, `sections/workspace/models/modelSettingsShared.ts` |
| The tool label is ONE span that is not dimmed, and the dots beside it animate | `components/chat/tool/ToolCallItem.tsx` |
| The update is an in-place silent replace, and the app restarts itself — **implemented, NOT yet verified on a packaged install** | `src-tauri/windows/installer.nsi`, `hooks.nsh`, `src/backend.rs` |
| The download is automatic; the restart is still the user's click | `hooks/useAppUpdate.ts`, `lib/preferences.ts` |
| The updater signature verifier matches the format the APP verifies with, and the two sources of the trusted key are checked against each other | `scripts/minisign-verify.mjs`, `scripts/check-minisign.mjs` |
| `/mcp/harness` is behind the gateway key | `routers/harness_mcp.py` |
| Four more data-directory paths are closed to the model | `services/sandbox/hardline.py` |
| Three gates for defects that were invisible | `scripts/check-{brain-config,truncate}.mjs`, `check-sse-parity.mjs` |

## Deferred — reference-app chrome

These are visible in the reference and are **not** in August. Each is listed
with the reason it was left, so the next person does not have to rediscover
the analysis.

| Feature | Why it was deferred |
|---|---|
| **An inline terminal in the tool card.** The reference renders a terminal *inside* the tool call, live, as the command's own output. | August has a live terminal — `components/shell/BottomTerminalDock.tsx`, mounted by `ChatLayout.tsx` — and it is a separate surface on purpose. Merging the two would mean one component owns two very different lifecycles: a dock that outlives the turn, and a card that dies with it. The reference has only the inline one because it has no dock. If August's dock is ever retired, the inline terminal becomes the natural replacement. |
| **Copy / re-run affordances on a tool row.** The reference puts a copy button and a re-run button on each command. | Re-run needs a product decision: re-running a command from last week means resolving the workspace, the guard mode and the approval state **as they are now**, not as they were. A re-run that silently picks up today's sandbox settings is a different command. Worth doing; not worth doing wrong. |
| **A diff view inline in the tool card.** | The reference shows a coloured diff in the card. August shows a `±N` stat on the edit rail row and opens the full `DiffView` on demand. The full diff is richer than the reference's; the rail is quieter. Merging them is a layout change, not a new capability. |
| **Per-token cost and duration on the activity line.** | August shows the run's total elapsed time. Per-token cost needs the run to be attributed to a cost, and the budget ladder can re-price a turn after the fact (`cost_estimator.price_for_model` is the only source, and it is not necessarily the price at call time). Showing a number that later changes is worse than showing none. |
| **A "you have N new versions" badge in the sidebar.** | The update check already runs on launch and on window focus, and the download is now automatic. A badge would be a second signal for a thing the app already acts on. |
| **Keyboard-driven collapsing of the activity card.** | The card is a disclosure with a button; it is reachable by Tab. A shortcut is a nicety, and every added shortcut is a key the composer might want. |

## Deferred — with a decision needed first

These are not deferred because they are hard. They are deferred because the
**product decision** has not been made, and guessing would bake the guess
into the code.

| Decision | The question | What it affects |
|---|---|---|
| **Group across a turn boundary.** | Today a run is a run of *consecutive* blocks. A turn that reads a file, answers, and reads another file is two groups, because the answer is between them. | Grouping across an answer would put unrelated work under one line, and the elapsed time would be the sum of two things that never ran together. |
| **Apply the update without a restart.** | The download is automatic; the restart is the user's click, because it interrupts whatever is running. | Restarting on idle ("no turn has run for 60 s") is possible, and is the natural next step. It needs the app to know it is idle, which it partly does (`liveActivity`). |
| **Update on a schedule, not on launch.** | The download starts 60 s after launch. | A scheduled check (nightly) would find builds published while the app was closed. It needs a task scheduler, which the app does not have on the desktop. |
| **`/mcp/harness` by default.** | It is closed unless the user enables external access. | An outer agent that drives August needs the key. If August is meant to be a harness for other agents, closing it by default is wrong — and the default is a one-line change. |

### Decided this round — and no longer open

Two of the three chat-surface decisions are now made and implemented, so they
have left the table above. The owner's direction was the reference's own
behaviour: **collapse everything, and open on a failure.** The reasoning is
kept here because the code's shape depends on it:

- **"Group every tool kind, not just commands"** — DECIDED: a run of tool
  calls collapses into ONE line whatever the kind, and the phrase names each
  kind. The `ExploreGroup` and its "Explore" vocabulary are gone; the Explore
  group's own search/file split went with them, so a run of web searches now
  reads as "read N files".
- **"Should a failed command be grouped at all?"** — DECIDED: yes, and the
  group OPENS on a failure. The old rule kept a failure out of the group
  because "a failure hidden behind a collapsed line is one nobody sees" — and
  opening the group answers that objection instead of giving up the grouping.
  The line is marked as failed, and the failing row opens with it.
- **"Group across a turn boundary"** is still open, and is deliberately so: a
  run is still a run of *consecutive* blocks, and the answer between two reads
  is still two groups.

## NEXT — after this round: the mobile companion

**Once the work in this round has shipped, the next build is the mobile
companion.** This is stated here so it is not lost between rounds. The
plan for it is `docs/plans/2026-10-20-after-this-round.md`.

The mobile app already exists in the tree — `frontend/mobile/` is an Expo
app with its own `tsc --noEmit` and a parity audit (`npm run test -w
frontend/mobile`) — and it is currently the smallest of the three frontends.
What the desktop round changes that the mobile app has to pick up:

- **The per-install token.** The desktop shell generates it and hands it to
  the backend over the Tauri IPC. A phone has no Tauri IPC, so it needs its
  own way to authenticate to the backend it talks to. The gate is a no-op
  where no token is configured, so the mobile app keeps working — but if it
  ever talks to a token-configured backend, it needs a token.
- **The activity-line grouping** is a render-time arrangement, so the mobile
  transcript can adopt the same contract from the same block stream.
- **The recovery notice** is a persisted system block, so it survives a
  reload and a phone's backgrounding.

The decision that is still open: **is the mobile app a second client of the
user's own backend** (the phone drives the desktop install over the network,
and the token decides who may), **or a full local install** (the phone runs
its own backend and its own brain)? The first is a remote-control surface
and is much smaller; the second is a second August. The second is the one
that needs a per-install token on a phone.

## NEXT — the board workbench (SimulIDE's idea, August's tools)

The circuit workbench already has the loop that matters:
`firmware_compile` (arduino-cli → HEX) → `firmware_run` (avr8js emulation)
→ `firmware_stimulus` (pin timeline → ngspice PWL sources) →
`circuit_simulate` (the real engine). That is firmware-in-the-schema, and it
works without a board on the desk.

What it does NOT have is the **board**: a physical Arduino with a port, an
FQBN, a pin map and a serial line. SimulIDE's appeal is that the thing you
are simulating is a board you recognise.

| Piece | What it does | State |
|---|---|---|
| `board_list` | Enumerate the boards attached to this machine, with their FQBN, port, protocol, VID/PID, **pin map** and the installed cores | **shipped** |
| `board_flash` | Build a sketch for a chosen FQBN and flash it to the attached board | **shipped** — confirm-gated and plan-blocked |
| `board_monitor` | Read the board's serial output for a bounded window | **shipped** |
| **The board's pin map feeding the deck** | The board's pins become named ngspice nodes, so a sketch's PWM output drives a real filter in the sim | **shipped** — `circuit_board` (the board as a component) and `circuit_add_board` (it lands in the deck as a `.subckt` + `X` instance whose nets ARE the board's pins). `firmware_stimulus` now names the node `D5`, not `N5`. The remaining piece: the board is drawn with the GENERIC subckt symbol, because a real board outline lives in `services/tools/schematic.py` |

The naming is `board_flash`, not `board_upload`: the tool does the whole
journey (resolve the source → materialise the sketch → compile for the FQBN
→ upload), and a name that says "upload" would suggest it takes a prebuilt
artifact. There is no separate `board_compile`: `firmware_compile` already
takes a board, and a second compile tool would be the same tool with a
different name.

The pin map is what is still missing, and it is the interesting half.
`firmware_stimulus` already turns a pin timeline into PWL sources
(`Vp13 D13 0 PWL(...)` - the node is the BOARD's pin), so the wiring exists — what does not is the other
direction: taking a **board's** pins and laying them out as a schematic
element, so the deck says "D5 drives this filter" and the filter's input
is the board's pin, not a name the user invented. That is a
`circuit_read_schematic` shape (a board as a component with named pins),
and it is the piece that would make August's circuit workbench read like
SimulIDE rather than like a compiler with a simulator bolted on.

The engine choice is `arduino-cli`, for the same reason ngspice was chosen
for the analog half: it is scriptable, it is what `firmware_compile` already
drives, and its output is machine-readable. The Arduino **IDE** (`arduino.exe`)
is a GUI around the same toolchain, so `arduino-cli` is the one to drive —
but the IDE's board list and its core installs are the same files, so a
board the IDE can flash is a board `board_upload` can flash.

**The licence and safety shape matters more here than the feature does:**
flashing a board is a physical side effect, so `board_upload` is
confirm-gated and never auto-run by the harness loop. And a board is not a
credential store, but `board_monitor` reads a serial line that a sketch may
be printing a WiFi password on — so the monitor's output is subject to the
same outbound scrub as anything else the transcript carries.

## Open — carried over from the UI parity round (2026-10-14)

The parity plan (`docs/plans/2026-10-14-harness-ui-claude-parity.md` §8b)
left these open, and they lived ONLY in its status file. They live here
now, because a list that exists in one place and not another is a list
that disappears. Each is re-measured against the tree on 2026-10-20, so
the state below is the tree's, not the plan's memory.

| Item | State on 2026-10-20 |
|---|---|
| **B4's `<DisclosureRow>` consumers.** Five call sites; only `HandoffNoticeCard` passed the `content` prop, so four still owned their bodies as siblings — and the trigger of a closed one advertised no `aria-controls`. | **fixed for three of the four** — `ThinkingDisclosure`, `tool/ToolCallItem` and `CompactionNoticeCard` now pass `content`, so every one of them advertises a real `aria-controls` and `aria-expanded` in BOTH states; `ChangesCard` was the last, and it is migrated too - so every call site advertises a real `aria-controls` and `aria-expanded` in BOTH states. The trap was **measured, not assumed**: with the motion element mounted eagerly, `forceMount`+`hidden` plays the mount animation inside a `display:none` region, so the row opens on an element already at its final state (opacity flat at 1.000, measured in Chromium). Mounted lazily — created in the same commit that un-hides the region — the animation plays (opacity 0.000 → 1.000). The EXIT collapse needed a second fix: the region's `hidden` must not land on the frame the exit starts, so a body that leaves on its own keeps the region rendered until it reports that it is gone (`DisclosureBodyApi`). |
| **The Settings scrim.** `components/workspace/WorkspaceShell.tsx:277-287` says the reference "floats over a completely unchanged app — sidebar, transcript and composer all stay at full brightness" and deliberately drops the tint. | **The code is wrong and the comment is wrong with it.** The repo's own capture says the opposite, twice: `docs/plans/2026-10-11-ui-reference-capture.md:20` — "A **centred modal** on a dimmed chat behind it" — and `:252` — "The chat is dimmed behind it". **fixed** - the backdrop now carries `bg-scrim` (measured `rgba(0,0,0,0.55)` in dark), and the comment says what the capture says and cites it. |
| **The jobs tray.** `components/shell/RightDrawerJobsSection.tsx:100-102` renders `useBackgroundTasksStore`, and `store/background-tasks.ts` has no `persist` — so the tray is in-memory and empties on every reload. | **built as a FEATURE** — the store persists in the repo's own hand-rolled idiom (copied from `sections/chat/offline-queue-store.ts`; the three stores that persist here all do it by hand and a fourth style would be the odd one out), and a quiet titlebar button (`components/shell/BackgroundJobsButton.tsx`) is the global surface: no button at all when there are no jobs, a spinner and a count while one runs, a muted dot for a finished one. A job that was running when the app closed comes back **cancelled** — "Interrupted — August was closed while this was running" — rather than falsely "running". The panel reuses the drawer's own row, so a job has one rendering, not two. |
| **The composer row and the sidebar density.** No measured target exists. | **the sidebar half is DONE** — the project group header was `uppercase tracking-wide` while every other rail label is sentence case (the reference says "small, muted, sentence case — NOT uppercase"), and the three nav blocks were 24px of chrome above the first chat, now 8px. **The composer half is NOT done, and the brief pointed at the wrong directory**: there is no composer in `components/shell/**` — it is `sections/chat/ChatThreadComposer.tsx` + `sections/chat/composer/ComposerToolbar.tsx`. It remains an owner's-eye judgement against the reference, not a defect list. |
| **26 of 44 settings sections are `tier: 'hidden'`.** (18 basic, 26 hidden — re-measured, and the 27/45 figure in the old audit was wrong on all three numbers.) | **open** — a decision about the intended depth of Settings. |
| **Two live readouts still on screen**: `N t/s` (`sections/chat/message/AssistantMessageContent.tsx:158`) and `answered via {model}` (`:182`). | **open** |
| **Three chat-surface font sizes exist only as un-tokenised rem literals** — `text-[0.71875rem]`, `text-[0.65625rem]`, `text-[0.8125rem]` (e.g. `components/chat/tool/CommandOutputPane.tsx:131,177`, `components/chat/git/ChangesPill.tsx:142`). | **open** |
| **`components/overlays/Backdrop.tsx:26-38`** — the scrim has click-dismiss but no Escape, no `role="dialog"`, no `aria-modal`, and no focus trap of its own. | **open** |
| **`components/shell/SessionSidebar.tsx:73`** — the resize separator carries only an `aria-label`: no `tabIndex`, no `onKeyDown`, no `aria-valuenow/min/max`. `role="separator"` appears nowhere in `frontend/desktop/src` any more. A keyboard user cannot resize the sidebar. | **open** |
| **`components/chat/ClarifyTool.tsx:162`** — binds a document-wide `keydown` listener while the dialog is `aria-modal={false}` (`:258`). | **open** |
| **`sections/workspace/models/ModelRow.tsx:251-252`** — a modal with `role="dialog" aria-modal="true"` and no focus trap and no initial focus. | **open** |
| **A finished turn's todos are rendered nowhere.** `sections/chat/ChatThreadMessagePane.tsx:348` gates the todo strip on `streaming`, and the timeline never reads `todos` — so the state a turn produced is visible only in the right-drawer tasks section. | **open** |
| **Two dead context stores**: `store/promptCacheLive.ts` and `store/contextSectionsLive.ts` have no consumer outside the stream handlers that write to them. | **open** — delete, or re-mount onto something. The ring they fed is gone, so there is nothing to re-mount onto. |

Two items from the same list turned out to be **already done** and are
recorded here so nobody repeats them: `ChangesCard`'s three type sizes and
three nested borders (fixed in `0c641143` — the card is now uniformly
`text-2xs` with one border level) and the four native `<select>`s in
`GeneralSection` (migrated to `SettingsSelect` in `c365c586`).

## What shipped in the round of 2026-10-20

Eight tracks, each shipped as its own commit with its own gate list. The
items below are the ones that were OPEN before it and are CLOSED now, or
that a track discovered along the way.

| Item | State |
|---|---|
| **The board is a schematic element.** Its pins ARE the deck's nodes, so a stimulus lands on a board pin and the SVG says `X1 UNO`. | **done** - and a live bug fixed with it: the logic levels were keyed by short name, so a `firmware_stimulus(board="arduino:renesas_uno:unor4")` fell through to 5.0 V for a 3.3 V board. |
| **`board_flash` was not actually confirm-gated.** It sat in the prompt-write bucket instead of the plan-blocked one, so plan and ask modes waved a real board flash through. | **done** - the same trap caught a second time, independently, for `circuit_add_board`. A tool in `_PROMPT_WRITE` alone is only *described* as a write. |
| **One activity line for everything.** A mixed run (read, command, read) was three rows; the reference says one. | **done** - one line whose phrase names each kind, and a run containing a FAILURE opens by default with a "failed" marker, because a failure hidden behind a collapsed line is one nobody sees. The Explore group's vocabulary went with it: a run of web searches now reads "read N files". |
| **The disclosure owns its body.** Five `DisclosureRow` call sites; only one passed `content`, so a closed row advertised no `aria-controls`. | **done, all five** - and the `forceMount`+`hidden` trap measured in Chromium, including the eager-mount counterfactual that reproduces the flat opacity curve. |
| **The Settings panel could not be clicked at all.** The cause was not the controls: the first-run checklist's backdrop claimed the same `z-50` as the settings panel and mounted later. | **done at the cause** - a layer ladder (`components/overlays/modal-layers.ts`) plus the app-owned surfaces YIELDING (not just a z-order change: a live focus trap under a panel the user cannot tab out of is its own bug). |
| **The jobs tray.** In-memory, and it emptied on every reload. | **done as a FEATURE** - persistence plus a quiet global surface. |
| **`react-icons/si`.** One 4.9 MB barrel, ~3,000 icons, for ~12 glyphs. | **done** - the 80 marks in use live in `lib/icons.tsx`, extracted verbatim, and all 80 were rendered through `react-dom/server` and compared attribute-by-attribute: **80/80 byte-identical**. The shipped-byte win is only ~8 kB (Rollup was already tree-shaking); the real win is build and parse cost. |
| **The phone could not chat in LAN mode.** The raw `fetch()` calls in `api/workbench/stream.ts`, `api/workbench.ts` and `api/liveClient.ts` never sent the token, because only `api/client.ts` attached it. | **done** - the fetch patch now carries the token on every `/api` request, and only when the backend is NOT on loopback, which is the same rule the backend itself applies. The desktop pays nothing. |
| **The phone's two live streams could not reach the door.** An `EventSource` cannot set a header - there is no browser API for it. | **done** - the token rides in the query string for the two named stream paths, and the backend accepts it there and NOWHERE else. Exempting them would have been worse: a same-origin GET carries no `Origin`, so the origin guard cannot tell the phone's stream from a script on the LAN. |
| **The manual "Free up memory" left no trace.** It compacted outside any turn, so the per-turn handler was not attached and no card appeared. | **done** - the durable subscriber renders the frame now. The two paths are mutually exclusive by construction (`ensureSessionSubscriber` returns early when a per-turn stream owns the SSE), so nothing renders twice. |
| **One aggregation for `skill_lift`.** The Skills UI and the demotion prior could disagree about the same skill. | **done** - one `skill_lift_detail`. Measured: the old `COUNT(*)` denominator was 4 where `COUNT(ok)` was 3, so a row with `ok IS NULL` was counted by one and not the other. |
| **The memory store had no lineage and no signals.** | **done** - `superseded_by`/`supersedes` on both sides (and deleting a winner RESTORES what it replaced), `verified_at`, a `contested` status for a genuine contradiction, an injection/disuse signal, a store budget (default OFF - archiving a user's memories on the day they upgrade is a destructive default), a source stamp, and an assistant-output scrubber for the `<memory>` fence. |
| **LAN access.** Opt-in, off by default, with a warning. | **done** - and the reason the token had to widen is in the code: the trusted-origin guard is NOT a LAN boundary, because a request with no `Origin` and no `Sec-Fetch-Site` is a non-browser client and passes untouched. In LAN mode the token covers the whole management API, fails CLOSED with no token configured, and a WebSocket may present the token OR a trusted browser origin - because a browser's handshake cannot set a header. |
| **The phone pairing.** The per-install token reaches the phone. | **done** - the token travels in a URL FRAGMENT (never sent to the server, never in a `Referer`), is rewritten out of the address bar with `history.replaceState`, and is held in ONE module-level variable - not in storage, not in the URL. |

### Still open after this round

- **The composer row** - `sections/chat/**`, and the brief pointed at
  `components/shell/**`, which has no composer. An owner's-eye judgement
  against the reference, not a defect list.
- **The four double-mounted settings sections** the Learning plan targets:
  `MemorySection.tsx`, `SkillsSection.tsx`, `HarnessImprovementsSection.tsx`
  and `LearningPanel.tsx`. Another track owns `sections/settings/**`.
- **The sidebar section header's THREE icons** against the reference's two.
  Two of them are the only door to their capability, and removing a
  capability's only door is the owner's call.
- **The phone re-pairs after a restart.** `frontend/mobile` has no
  `expo-secure-store` and no `@react-native-async-storage`, and a
  dependency cannot be added without the owner, so the token and the
  address are held in MEMORY ONLY. The UI says so.
- **The token in a URL.** The two `EventSource` streams carry it in the
  query string, because that transport cannot set a header. The backend
  accepts it for those two paths ONLY.
- **The WebSocket's residual hole.** A socket from the network may present
  a trusted browser origin, and a script can forge an `Origin` header.
  That is the trust the origin guard has always given a browser request;
  the HTTP half of the terminal is behind the token.

## The round after that: a census, and what it found

A census is not an argument check. A scanner gate that passes on zero
matches is not a gate, and a plan that says "this key is written but
nothing reads it" is a claim until it is re-measured. So the two
write-only facts and the write-only stores were counted, and the
count was checked against the tree one key at a time.

### Shipped

| Item | State |
|---|---|
| **The notifications bell showed "What's New" and the chat's own notifications went nowhere.** `pushNotification` writes a turn failure, an arena lane that finished and a reminder into `useNotificationsStore` -- and NOTHING read that store. The panel it was written for had become the What's New list, so the store's own docstring ("a small bell fed by notable events from the chat stream") described a feature that did not exist. | **done** -- the bell is the inbox it was meant to be: the local notifications render first (they are the events the user just caused), with the error tone distinct, and opening the panel marks them read. |
| **A docstring that names an event nothing emits.** `POST /api/models/profile` said the suggestion came from a `modelProfileSuggestion` SSE frame -- and because a FastAPI docstring becomes the OpenAPI description, the phantom was PUBLISHED: a client reading the served schema was told to wait for an event that does not exist. The name survives in one comment in the web client, saying the same wrong thing. | **done** -- the description now names the probe endpoint that actually produces the suggestion, and the client's comment says the same thing. |
| **The web branch of `search()` handed the model a truncated JSON blob.** `_webSearch` returns a JSON DOCUMENT; the branch did `str(wres)[:6000]`, so the model read escaped quotes, a raw `results` array, and whichever half of the document survived the cut -- and had to parse escaped JSON to learn a title and a URL. | **done** -- the document is parsed and each result renders as one readable line (title - url: snippet). A result that is not the expected shape (a timeout note, an instant answer) still falls through to the old text path. |
| **Two `internal_state` keys written and never read.** `memory:recall:last_turn` is written on EVERY turn -- a DB upsert for a value nobody reads -- and `consolidation:last_run` is written by the consolidation pass. The metrics route read the accumulated `totals` instead, so the per-turn number its own docstring promised was never returned. | **done** -- both are read by `GET /api/brain/memory/metrics` now, which is where a user of the memory system would look for them. The per-turn write stops being a write to nowhere. |
| **The OAuth tokens were plaintext in `config.json`.** | **done** -- Windows DPAPI via `ctypes` (no new dependency), a `<dataDir>/secrets.json` store beside `providers.json`, a lazy idempotent migration on the read path, and a labelled plaintext fallback off Windows so the Docker deployment keeps working. On Windows there is no fallback: a failed encryption leaves the plaintext exactly where it was. |
| **A new secret store that could be listed.** | **done** -- the store is refused by the listing doors and by the shell gate, and the code-mode port carries the rule with it. |

### Still open, and named

- **The composer had NO live context meter.** `store/contextLive.ts`,
  `store/promptCacheLive.ts` and `store/contextSectionsLive.ts` were all
  written on every turn -- and all three were read by NOTHING. The
  `estimateContextBreakdown` helper, the `ContextBreakdown` type and the
  `ChatComposer.tsx` shim that exists only to export them were all
  unreachable too. The pieces of a context breakdown were all present; the
  reader that would render it was never written. The composer showed COST
  from the persisted session-usage poll, not context.
  **done** -- the composer's row under the card now carries the
  reference's right-aligned context percentage, rendered from the
  backend's own per-turn `contextPressure` measurement. The absence rule
  is the part that matters: no measurement renders NOTHING, never `0%`,
  because `Number(null)` is `0` and a missing measurement must not become
  a confident "0% used". The two stores that feed the detail panel are
  kept, each with exactly one reader; the ESTIMATOR and the shim were
  deleted, because they split a total the backend measures exactly into
  rows the backend never measures, and the capture shows no per-category
  breakdown.
- **The provider API keys WERE still PLAINTEXT** in `data/providers.json`
  and are now in the store. `provider_credentials.py` owns the file end to
  end and returns a MERGED view, so the ~15 readers that pull
  `entry['apiKey']` straight out of the dict are unchanged. The file's
  `defaultHeaders` map can still carry an `Authorization: Bearer` value
  in the clear: a credential-shaped MAP cannot be split without a new
  per-field convention.
- **`mcpGlobalEnv` HELD a real `GOOGLE_OAUTH_CLIENT_SECRET` in plaintext**
  and no longer does. The map is split BY NAME: a sensitive name goes to
  the store, a public name stays in `config.json`. The premise turned out
  to be wrong in an interesting way: the secret NEVER reached an MCP
  child's environment -- `noninteractive_env()` drops every
  credential-shaped name -- so only the PERSISTENCE moved.
- **The outbound scrubber had NEVER known about the service-connection
  tokens** and now does. The encrypted store is a fourth source, read
  after the providers so a key in both is labelled with its provider. A
  Google refresh token pasted into a transcript no longer rides out on
  every later turn.
- **`GITHUB_TOKEN` / `SLACK_BOT_TOKEN` are exported to `os.environ`** by
  the connect handlers, so they are in the process environment and in
  every child process.
- **The second plaintext copy of the Google token** at
  `~/.google_workspace_mcp/credentials/` is the credential-store contract
  of a THIRD-PARTY tool that cannot decrypt DPAPI. It could not be
  solved. What changed: the copy is now DERIVED (August can rewrite it
  from the encrypted store at any time), and the eager write is GATED on
  workspace-mcp actually being installed -- a user who never installs it
  gets no plaintext copy at all.
- **A DOWNGRADE to an older August is not survivable** for the service
  connections: the old build reads `config.json` only and will show the
  connection as disconnected. Upgrade is fine.

### Four claims that turned out NOT to be defects

Recorded so nobody re-opens them. Each was measured, not argued:

- **`browserAllowlist` is "a reader with no writer"** -- FALSE. It is a
  USER-SET `config.json` key, documented as one in `CONFIGURATION.md`.
  There is no writer by design, because the user writes it.
- **`GET/PUT /api/config/web` does not exist** -- FALSE. It exists, at
  `backend-py/app/routers/config.py:501` and `:509`. A grep for the
  full path misses it, because the route is declared as `@router.get('/web')`
  on a router that carries the `/api/config` prefix.
- **`_SKILLS_OVERFLOW_STATE_KEY` is written and never read** -- FALSE. The
  curator report reads it BY VALUE (`get_internal_state('skillsIndexOverflow')`),
  not by the constant, and a grep for the constant name misses it.
- **A finished turn's todos are rendered nowhere** -- FALSE. They render
  in the layout-level Workbench sidebar.

And one that is real but was re-scoped: **the sidebar's resize separator**
carries only an `aria-label` -- but `SessionSidebar.tsx` is now 2.5 KB
and the separator is not in it, so the claim describes a file that no
longer holds it. The accessibility track is told to re-measure before
it "fixes" it.

## The round after that: a second census, and the one that mattered

The first census counted STORES with no reader. The second counted
STYLESHEETS with no cascade — and found that the app's own stylesheet
had been overriding Tailwind across the whole product.

### The one that was app-wide

**`base.css` had a rule that beat every border utility in August.**

    .border, .border-t, .border-b, .border-l, .border-r {
      border-color: var(--dt-border);
    }

It exists to catch the bare `.border` utility that carries no colour
argument, and its comment says that dropping `!important` "lets the
`!important`-free Tailwind utilities win on source order". That was the
wrong reason. `styles.css` imports `tokens.css` first, and `tokens.css`
holds the `@tailwind` directives — so Tailwind's utilities live in
`@layer utilities`, and a rule that is **not in a layer** beats every
layered rule regardless of where it appears in the file.

Measured in Chromium against this app's own **production** CSS bundle
(`vite build`, which is what ships), before and after:

| class | before | after |
|---|---|---|
| `border border-transparent` | `rgb(236,236,234)` opaque | `rgba(0, 0, 0, 0)` |
| `border border-border/50` | `rgb(236,236,234)` | `rgba(236,236,234, 0.5)` |
| `border border-border/60` | `rgb(236,236,234)` | `rgba(236,236,234, 0.6)` |
| `border border-warning/30` | `rgb(236,236,234)` | `color(srgb .788 .541 .078 / 0.3)` |
| `border border-white/[0.06]` | `rgb(236,236,234)` | `rgba(255, 255, 255, 0.06)` |
| bare `border` (the guard's purpose) | `rgb(236,236,234)` | `rgb(236,236,234)` |

So every tinted border in the product was painted one flat colour, the
app's "transparent border" chips had a visible edge, and the `white/[0.06]`
hairlines were not faint — they were full-strength lines. The
`divide-y divide-border/60` hairlines were never affected, because the
divider's own selector outranks `.border`, which is why some hairlines
looked right and others did not.

**The fix is one line of CSS**: the rule moves into `@layer base`. Inside a
layer, source order decides again — `tokens.css` is imported first, so the
rule still beats Tailwind's preflight and still catches the bare `.border`,
while the utilities in a later layer win, and win with their alpha.

**Why it hid for so long:** the dev server and the production build
disagree. The dev server keeps the layers, and the unlayered rule wins
there too; the production build flattens them and hoists the unlayered
rule to the end of the bundle, where it wins by source order. Both were
broken. A defect that behaves differently in the two environments is a
defect that is easy to misattribute — the earlier "white/[0.0x] is
invisible in light mode" reading was WRONG: the hairline was not
invisible, it was a full-strength line in both themes.

### Also found in this round

- **The provider API keys, the MCP env secret and the outbound scrubber**
  were three plaintext holes left open by the secret-store round. All
  three are closed; see "Still open, and named" above for what each one
  was.
- **The composer had no context percentage**, and the three stores that
  hold the data were written every turn and read by nothing. The reader
  is written; the estimator that could not be honest is deleted.
- **The focus trap read its root once** and went dead if the root was
  replaced; five dialogs claimed `aria-modal` without having a trap, and
  one claimed nothing at all. The model editor's hardcoded `z-[80]` also
  put it above the prompt rung, so a confirmation raised over it rendered
  UNDERNEATH the editor's own scrim and was invisible.
- **The Integrations panel promised a list it did not have.**
  `GET /api/mcp/servers` never carries a per-server `tools` array, so the
  catalog fallback always won and the "Tools" list on a RUNNING server was
  the CATALOG's. The pane now says which list it is.
- **Installing Workspace MCP silently enabled three Google facets.**
  The key it wrote is read by nothing outside its own file, so it could
  not have been what made the server work.
- **The four double-mounted sections** (Memory, Skills, Harness
  Improvements, Learning) were reworked to the reference's density, and
  the Skills detail's "Review inbox" link used to throw the reader out of
  the Learning hub into the Settings overlay.

### Still open, and named after this round

- **`mcp-servers.json`'s per-server `env` map** can hold a token in the
  clear. A different file, with different consumers, not yet absorbed.
- **`providers.json`'s `defaultHeaders`** can carry an
  `Authorization: Bearer` value in the clear. A credential-shaped MAP
  cannot be split without a new per-field convention.
- **`GITHUB_TOKEN` / `SLACK_BOT_TOKEN`** are still exported to
  `os.environ` by the connect handlers, so they are in the process
  environment and in every child process.
- **`~/.google_workspace_mcp/credentials/<account>.json`** is a third-party
  format and stays plaintext. It is now a DERIVED copy, which is the
  honest description of it.
- **A DOWNGRADE to an older August** shows a provider as having no key
  and a service connection as disconnected: the old build reads
  `providers.json` and `config.json` only. Upgrade is fine.
- **The `services/settings` header grammar** is now ONE component, but
  `DecisionsSection` still owns its own heading rather than the shared
  one. Its icon is gone; the shared component is not yet adopted there.

## The round after that: the app, RUN, against the reference

The two censuses before this one read the source. This one ran the app.
A dev server on `127.0.0.1:5173` against a backend on a throwaway
`AUGUST_DATA_DIR`, driven by Chromium over the DevTools protocol, and
every surface captured and compared with the Claude screenshots -- the
chat (with a seeded transcript), Runs, Board, History, Automations,
Learning, the Live surface, and the Settings panel.

Running the product is what found the scrim. The source said the scrim
had "a tint"; the screen said the tint was a 40% wash of the
FOREGROUND colour, which is near-white in dark mode, so a dark app
behind a modal was bleached to pale grey. The app already had the right
token (`--dt-overlay-scrim`, exposed as `bg-scrim`, and already used by
the settings panel's own backdrop); the `Backdrop` primitive was the one
surface that had invented its own. Fixed at the cause.

### Fixed in this round

- **The modal scrim** bleached the app instead of dimming it. `bg-scrim`.
- **The composer had no voice glyph and no chevron** at the right of the
  card, where the reference has both. The mic is a real affordance:
  August's voice input lived two levels down in the `+` menu.
- **The activity header's chevron was stranded at the far right** of the
  content column. The reference keeps the header a compact run -- "Ran 4
  commands, read a file  9s >" -- with the chevron right after the
  duration. The title was also bright white and bold where the
  reference's is muted.
- **The Learning route's title bar** said "August" (and so did the OS
  window title), because `/learning` was missing from the route-label
  table.

### Looked at, and deliberately NOT changed

- **The reference's idle composer has no send circle** -- it appears only
  as the stop button while generating. August keeps its own up-arrow
  circle. Removing a send button from a desktop app is a product
  decision, not a UI fix, so it is named here rather than taken.
- **The blue mark at the right edge of the transcript** is the
  checkpoint pill, and its 16x6 size is deliberate ("the mark is 8x4; the
  target should not be" -- `chat.css`). It looked like a rendering
  artifact until it was measured.
- **The surfaces that sit on a skeleton for several seconds** are the
  dev server compiling on demand, not a stuck loader: at 16 s the Runs
  page is fully rendered and the network log shows every endpoint
  answering 200. The packaged app does not pay this.
- **The todo checklist was named by the MODEL.** Both surfaces that show
  it took their name from the model's OPTIONAL list title -- free text the
  model writes -- so the same feature could be headed "RESEARCH", "PLAN",
  "PLANNED STEPS" or "FIX THE CHARTS" depending on the turn, and the
  two surfaces did not even agree on the fallback ("Plan" in the working
  indicator, "Planned Steps" in the floating pill). It is now called
  "Todo" in both, and the model's title is demoted to a muted subject
  line under the name. The collapsed pill shows the CURRENT STEP, which
  is the reference's shape ("Fathoming  21s" -- the work there is the
  todo item).
- **The `update_state` phase reached the screen raw**, in two places: the
  working indicator's fallback pill rendered it verbatim in caps, so the
  pill literally read "RESEARCH", and the plan tree's group heading
  rendered the raw enum value, so a group read "research". A bookkeeping
  phase was wearing the costume of a feature name. Both now go through
  one translation (`lib/phase-labels.ts`), so the raw value cannot leak
  again.

  The phase VOCABULARY is unchanged on purpose:
  `research | plan | implement | review | complete` is the tool contract
  -- it is in the tool's schema enum, in the error the model reads back
  when it guesses wrong, and in the system prompt. Renaming a phase
  breaks every session already carrying one, and "research -> plan ->
  implement -> review -> complete" describes the work better than "todo
  -> plan -> implement -> review -> complete" does: a todo is not a
  phase of work. Changing the contract is a separate change and it is
  the owner's to call.

## The round after that: the settings PANEL, measured against the reference

The owner sent the Claude and ChatGPT settings captures and asked how
August's should look. The cause was not the memory component. It was the
panel the component lives in.

**The settings panel was 920x680, and the reference is ~1600 wide.** The
shell's comment said "920x680 -- the reference panel's exact measured
size", and it was -- for the reference dialog as it was measured THEN.
The reference the owner attached is a different shape: a ~1600px panel,
a ~1290px content column, three-column rows at ONE type size, and a
value column of ~690px.

The panel is 1440px now (inside the reference's own 860-1600px range),
the content column 1080px, and the memory list's rows span it: 1032px
wide, a FIXED 208px name column so every value starts at the same x, and
a 703px value column -- the reference's ~690px, measured. The name and
the value are both 13px; only the date is muted, which is what the
reference does.

**Nine sections carried their own width cap** and were left stranded in
the wider column -- a 672px card at the left of a 1080px column with
400px of dead space beside it. Their caps came off. The reference's
settings rows SPAN the content column: the label on the left, the
control on the right, one straight edge down the page.

**The memory list carried prose the reference does not have.** The "You"
header held a thirteen-word sentence where the "Topics" header beside it
held a bare number. The header carries a count now; the sentence is one
muted line under the section.

**The detail view put two lines of bookkeeping in front of the fields**
and printed `source: user` twice. The reference goes title, "Last
updated", "Summary", "Details" and nothing between; it does that now.

**The profile-lane button was the only violet control in the app** -- the
one hardcoded hue outside the palette. It is `primary` now.

### Still open, and named after this round

- **The settings panels use three to six font sizes each**, measured per
  panel (Turn Limits 4, General 5, Model providers 6, Memory 7 before
  this round, Agents & automation 3). The reference uses about two: a
  body size and a metadata size. Collapsing the scale is a whole-app
  change and it is not done.
- **Turn Limits carries six explanatory paragraphs** of 150-465
  characters. They explain backstops that can end a turn, which is real
  information, and the reference's rule of low text volume argues
  against them. A judgement call, not a defect, and they were left.
- **Settings still shows N bordered cards** ("Profile", "Preferences",
  "Notifications") where the reference's rule is one rounded container
  with hairline children. The memory panel is a list and reads that way;
  the form panels are still cards.

## The round after that: EVERY settings panel, against the reference

The memory panel was one panel. The owner asked about the other tabs, so
every one of the nineteen was captured, audited and compared - the rail
walked tab by tab, with the DOM measured rather than eyeballed.

**THE PAGE HEADER WAS FOUR SIZES AND TWO WEIGHTS.** General and
Appearance rolled their own 18px title, Browser Use and Computer Use
their own 24px one with a coloured glyph, Usage stats a 24px BOLD one,
and the Memory panel opened with an `<h3>` sitting ABOVE its `<h2>`
section headers. The reference's settings page header is one shape, and
now every panel is 20px semibold with one 13px muted subtitle and no
icon - the nav item already carries the icon, and the repo's own
`SectionHeader` has said so since it was written. Measured across all
nineteen: 20px on every one.

**"BORDERS ARE HAIRLINES, NEVER BOXES" was the most-violated rule in
the app.** General was six bordered cards, Appearance three, Computer
Use eight, Phone pairing four, Usage stats eight, the Agent Board a
box inside a box, Model settings two boxes with a second nav column
inside them. They are one container each now, with hairline-separated
children.

**THE ROWS ARE ONE GRAMMAR.** The reference's settings row is a NAME,
a VALUE at THE SAME TYPE SIZE, and a muted third column, with the
control at the right edge. The Browser Use rows set 14px against 12px
and cut the descriptions mid-word at 110 characters; the Review Inbox
set 14px against 10px; the Memory panel had two row grammars in one
panel. One grammar now, and the hard cut is a real CSS ellipsis.

### Three real bugs, found by reading the panels rather than the code

- **The Computer Use stat cards accepted a `tone` prop and discarded
  it** (`tone: _tone` in the signature), so Status, Health, Backend and
  Platform all rendered in the same white although the caller had
  computed good/warn/muted for each.
- **The Usage stats' refresh button was `fixed` to the WINDOW**, not to
  the panel, so it was painted at the window's bottom-right, outside
  the settings modal, over the dimmed app - measured at ≈1840,1157
  while the panel ends at x=1680.
- **The Notification permission was the raw DOM enum** in a monospace
  badge, so the word "default" sat in the card's top-right as if it
  were a value.

### Also

- **The nav search is a pill.** The app had THREE shapes for one thing:
  the nav's was a rounded box, the Memory panel's own search was a
  pill, and the Integrations tab's was a box again.
- **The selected nav row's icon was the accent blue.** The reference's
  nav row is monochrome and the selection is the lighter fill, so the
  selection was two signals at once.
- **The card's icon tile was a bordered box** around a glyph.
- **The Skills catalogue cell had LOST its rounded icon tile** while
  the Plugins tab's copy of the same grid still had one, so the two
  tabs disagreed with each other.
- **Four native `<select>` elements in the Memory filters and two in
  the Skills tab** rendered the OS popup, which the repo's own
  `SettingsSelect` header calls the loudest element on a page that is
  supposed to be four quiet rows.
- **The Turn Limits rows printed the value TWICE** - the number box and
  a smaller caption under it - in two type sizes.
- **The Onboard wizard's "Next" landed in the MIDDLE of its row**,
  because the row was `justify-between` with three children.
- **The Agent Board's kanban cards had no boundary** - only a hairline
  and a hover fill, as the reference's list grammar has it.

### Still open, and named after this round

- **Turn Limits keeps its Save button**, moved out of the card into the
  header's actions slot. The reference's panel has no Save because its
  values commit as they change; making August's brain-config writes
  commit on blur needs a draft flush on unmount (a focused field can
  be removed from the DOM without a blur), and that is a rewrite of a
  save path, not a cosmetic change. It is the owner's call.
- **Three prose blocks survive in Browser Use** - the tool
  descriptions, which are the row's value column and are truncated
  with an ellipsis - and two in Phone pairing (the verdict detail and
  the empty state), and one in Memory (the memory-budget note).
- **The panels still use four to eight font sizes each.** The
  reference uses about two: a body size and a metadata size. The page
  HEADER is one size now, and the rows are one grammar, but the type
  scale inside a panel is still the app's whole scale.
- **The `SettingsSelect` listbox has a visible chevron**, and the
  reference's value control is chevron-less. `ValuePill` is the
  chevron-less primitive and the Skills tab uses it; the rest use the
  listbox, which is a real trade and not yet settled.

## The round after that: what the chat looks like WHILE it is working

The owner sent a capture of Claude's own transcript doing exactly the
job August does - fixing a schematic - and asked what August's UI
should look like "when thinking or outputing output". The same capture
was the chance to check the memory loop, which the Settings rewrite had
touched the top of.

**THE MEMORY LOOP WAS INTACT, AND THE AUDIT FOUND A REAL BUG IN IT.**
The write, read, always-in lane, consolidation, recall and paging doors
all still round-trip. But the human write door accepted a `details`
field and then dropped it silently - the response said `{"ok": true}`
and the stored value was the bare sentence. A fact renders its Details
section only when its stored value is the JSON object `{"fact": ...,
"details": ...}`, and the MODEL's own `remember` tool stores exactly
that shape - so the same fact written by the model had a details body
and the same fact written by a human did not. The door now stores the
shape the read side already understands, and the edit form grew a
Details box so a person can fill one in at all.

**THE ACTIVITY LINE SAID "TASK COMPLETED  1 COMMAND".** A status and a
count, and neither of them a description of what happened. The
reference's line reads "Running a command  1m 18s", and this repo's own
rule says the line is "a warm dot, one phrase, the elapsed time, a
chevron". The line now carries the phrase the turn's tools already had
("Ran a command, edited a file") and the elapsed time - which the
header could not show before, because it read the wall-clock span of
the tools' `startedAt` while the group below it read the tools' own
durations, so a transcript with one and not the other showed a
duration inside the card and nothing on the line above it.

**THE THINKING CARD SHOWED ONE LINE WHERE THE REFERENCE SHOWS A
LIST.** The reference's card is the model's sentences, one per line.
August distilled the whole thought to a single line; the card now
lists the distilled sentences, and "Show full reasoning" still reaches
the raw prose.

**THE ACTIVITY CARD HELD A BOX INSIDE A BOX.** The run of tool calls
brought its own rounded border and background - the same "N bordered
cards" shape the Settings round had just removed, in the one place a
user reads a turn.

**THE ARTIFACT CARD EXISTS NOW.** A file a turn produced is one compact
card under the answer - a borderless tinted icon tile, a bold name, a
muted kind line, a filled Download and a chevron - and it does not
render the payload. The preview reuses the right drawer, which already
IS the reference's preview panel (the eye and `</>` toggle, Copy, zoom
in/out/fit, the fullscreen icon and the ✕ over a canvas that renders an
image, a live SVG, Markdown, text and a paged PDF); a second floating
panel would be a second viewer of the same file. The produced file
also appeared TWICE for a moment - the changes card's document row and
the new artifact card - so the changes card is now the diff list it
always meant to be and the artifact card owns the deliverables.

### Still open, and named after this round

- **A produced file only gets a card when the tool that made it was
  edit-classified.** A file written by a tool August does not classify
  as an edit is invisible to the card, because the collector reads the
  tool's ARGUMENTS and a general result-side collector does not exist
  yet. The circuit family solved it by reading the tool RESULT.
- **The circuit cards are mounted in a different component from the
  general ones**, so a turn that produced both reads as answer →
  general artifacts → changes → circuit artifacts. Moving the two
  mounts together is a two-line change.
- **The preview panel has no caption.** The reference's carried "Wires
  that cross without a dot are not connected; a dot marks a
  connection." - a line of prose from the producing tool, and the app
  has no field that carries one.
- **The reference's message footer is a row of borderless action icons**
  (copy, speak, approve, reject, regenerate) beside the timestamp.
  August's `AssistantMessageActions` already renders that row under the
  message body; the artifact card inherits it by sitting at the end of
  the body rather than duplicating it.


**`/anatomy` IS NOW A COMMAND, AND IT LASTS ONE TURN.** The `anatomy` skill has
always shipped in the bundled layer (it is the first row of the live catalogue,
and the installer stages all eight of its files), but reaching it depended on
BM25 happening to rank it for the message. A leading `/name` now pins that skill
into THIS turn's `<relevant_skills>` — first line, marked "the user asked for
this one by name", with its own footer telling the model to `load_skill(name)`
and follow it — and writes nothing to the session, so the next message is
ranked on its own again. A pinned name that isn't in the catalogue is dropped
silently rather than becoming a claim, and the pin survives even with
`skillRelevance` switched off, because an explicit request is not automatic
injection. The pinned skill also lands in `turn_outcomes.skills_injected`, so
the skill-lift ledger credits the turns the user asked for.

**Why the skill was NOT re-ported to upstream v1.1.0.** August's copy is a
deliberate trim of `wheresryan22/anatomy` (MIT), and two things in upstream must
stay out of a shipped app: `scripts/publish.mjs` does `git fetch` on a third
party repo and then **`git push --force`** to it (requiring an authenticated
`gh`) — a bundled skill's procedure is followed by whichever model is talking, so
shipping it hands the agent a documented remote write; and the skill's own
`compatibility:` line requires **Chrome/Chromium** for every check, which the
installer does not ship (it ships ngspice and arduino-cli). A v1.1.0 body would
therefore instruct a verification loop that cannot run in the packaged app.

**THE 3D BOARD STAGE IS AN OWNER DECISION, AND IT IS NOW MADE.** The reference
(`learn-arduino-red.vercel.app`, no public repo, no licence statement) is
three.js r186 with an **orthographic** camera, **procedural** geometry only (zero
model files — every "texture" is a runtime canvas), a hand-written outline
post-pass, and a named easing table; the knob is `rotation.y =
-(pot/1023*270 - 135)°` dragged at ≈3.78 units/degree with no tween. August's
`circuit_render_3d` is a static matplotlib PNG and cannot carry that. The owner
chose to add `three` as a dependency and build the live stage in the drawer from
the measured spec — never from their bundles — which means a lockfile change for
the release gate and a token/excuse path for `check:design` (it bans inline
`style={{` and hex literals in `.tsx`, and the reference does both).

**SHIPPED (2026-10-22).** `three@0.186` (the reference's own revision) is now a
desktop dependency and the stage lives in the circuit drawer beside the
schematic editor: `components/shell/CircuitBreadboard3D.tsx` draws the deck's
own `SchematicGraph` — the same payload the editor edits — as procedural solids
on a hole-textured slab, orthographic camera, back-face hull outline, drag to
turn with a quarter-turn ratchet on release, scroll to zoom clamped 3.2–22,
idle auto-rotate after 4.5 s, per-part enter stagger on `outCubic`/`outBack`,
hover lift, and a readout naming the part's ref, value and nets. Timing lives in
`lib/circuit-motion.ts`, colour in `--cb3d-*` in `tokens.css` (read through
`getComputedStyle`, so the stylesheet stays the only place a part's colour is
set and the hex ban holds with zero new baseline entries).

Two defects were caught by LOOKING at the render, not by reading it: every part
was built around its own pin centroid but never placed AT it, so the whole board
drew as one stack; and the frustum was a fixed half-extent, so a twenty-pin
board filled the frame and pushed the filter off-screen. Both are the argument
for the throwaway-entry screenshot pass over a type check — `tsc` was clean
throughout, and the picture was wrong.

## Deliberately not done

- **No test suite was restored.** The suite was removed on 2026-10-17 at the
  owner's request. What replaced it is static: three new gates, each
  negative-tested against the exact defect it catches, plus the gates that
  were already there. See the gate list in `AGENTS.md`.
- **No history rewrite.** The 85.6 MB Node binary is in the history and nine
  tags pin it. Rewriting would change every tag; the cost is higher than the
  saving.
- **The `data/` directory was never touched.** It is the user's memory
  (1.58 GB in this checkout). Nothing in this round read from it or wrote to
  it, and the `AUGUST_DATA_DIR` overrides in the gates point at throwaway
  temp directories.

## The round after that: the reference's OWN capture of the same job

The owner sent more captures - Claude doing exactly what August does,
writing a decoder and presenting the files - and this is the round that
matches them rather than the reference's general shape.

**A PRODUCED FILE ONLY GOT A CARD WHEN THE TOOL WAS EDIT-CLASSIFIED.**
The collector read the tool's ARGUMENTS, so a file a tool said it had
saved was invisible. There is a RESULT-side collector now, the way the
circuit family did it: the path is read out of the tool's RESULT, never
out of its arguments, so a `read_file` can never become an artifact. A
result that carries the file's CONTENT is a read whatever else it says
- and the circuit collector had the same hole, turning a circuit READ
into a deliverable.

**AND A TOOL THAT REPORTS A FILE IS DELIVERING IT.** The result side
is not kind-filtered: a tool that says "I saved decoder_3to8.v" is
delivering that file, whatever the extension list knows about .v. The
argument side still is - a path in an edit call is a diff as often as
it is a deliverable, and a source file the agent edited stays the
changes card's row.

**THE TILE IS A FILLED ACCENT SQUARE WITH A WHITE GLYPH** - purple for
an image, blue for a document - so the accent belongs in the FILL, not
in the glyph. **"DOWNLOAD ALL"** sits above the cards when a turn
produced two or more. **THE ACTIVITY PHRASE NAMES THE FILES** - "Ran 4
commands, shared files" - and "shared" means a DELIVERABLE, so a turn
that edited a source file does not claim to have shared it. **THE TWO
MOUNTS ARE TOGETHER**, so a turn's artifacts read as one list. **THE
PREVIEW PANEL CAN CARRY A CAPTION**, which is the producing tool's own
prose, and nothing is invented when the tool wrote none.

**AND THE ROUTER WAS BROKEN IN A WAY NOBODY NOTICED.** An unknown URL
- a stale bookmark, a mistyped path - loaded the app shell with NO chat
in it. React Router had been warning about it the whole time ("the
parent won't match anymore and therefore the child routes will never
render"), and it was right twice: the catch-all was nested under a
route whose element never renders (ChatLayout has no `<Outlet/>` - the
surfaces come from its own `<Routes>`), and the descendant `<Routes>`
could not match deeper locations because the parent's path did not end
in a splat. The catch-all is in the `<Routes>` that actually render, the
layout route's path ends in `*` and its children are relative, and an
unknown URL goes home.

### The four that were open, and are now closed

- **THE SETTLED ACTIVITY LINE CARRIES NO ELAPSED TIME.** Every duration
  in the reference's captures is on a LIVE line ("Running a command
  1m 18s") - a completed run reads "Ran 4 commands, read a file" with
  no time. The line now shows its time only while the turn is running,
  and the run's own time is in the card, on the group row, where the
  reference puts it too. The repo's own rule (AGENTS.md) said otherwise
  and has been corrected to match the reference.
- **"Presented N files"** - the reference's expanded card carries a row
  naming how many files the turn presented, and the card has it: the
  row sits under the calls, in the group, and reads "Presented 3 files".
  The count is `countSharedFiles`, which reads the SAME rule the
  artifact card reads, so the row and the cards cannot disagree.
- **A `.v` file written by `write_file` GETS A CARD.** The extension
  list cannot tell a source file the user asked for from a source file
  the agent merely edited, but the TOOL can: a write creates, a patch
  changes. So a file the turn CREATED is a deliverable, whatever its
  extension, and it appears as an artifact card with a Download - the
  reference's own shape for a Verilog deliverable. A file the turn
  CHANGED stays a diff, in the changes card.
- **THE TWO COPIES OF THE PRODUCED-PATH RULE ARE ONE.** `collectProducedFiles`
  and `producedFilePath` held the same rule twice, and agreed by luck.
  `collectProducedFiles` now delegates.

### And what the split cost the changes card

The changes card gave up the files the artifact card owns - a document,
an image, and now a source file the turn created. Its header counts
the files it LISTS, so it never says "2 files changed" above an empty
list; when it lists nothing, it shows the chevron and Undo alone. The
Undo is the one thing a turn of pure deliverables would otherwise lose,
so the card still renders.

### Still open, and named after this round

- **A DEEP-DIVE REVIEW OF THE WHOLE APP IS ON THE TABLE.** See
  `docs/research/2026-10-21-deep-dive-and-cleanup.md` - a read-only
  review with a seven-batch manifest. Its three HIGH findings share
  one root cause: the safety-critical guards live in one function and
  three other paths reach the tool registry without passing through it
  (the `/v1` proxy, and the MCP tool paths). The fix is structural -
  route every path through `exec.py` - and the individual MCP items
  (the lifecycle hooks and the mutating classification) are the
  smallest high-value change in it.

### Resolved after the deep-dive (2026-10-21)

- MCP calls now run PRE/POST lifecycle hooks and are classified as
  mutating; `/v1` managed tools route through `_executeTool` and get the
  hook stack and timeout (guard modes/approvals remain a gateway-key
  surface).
- `needs_approval_in` was deleted; `docs/ARCHITECTURE_FLOW.md` now names
  `_checkToolGuard` as the live authority.
- Tool arguments are scrubbed at both brain-write boundaries, and the
  secret-guard matcher covers the four missing write tools and MCP.
- Owner decision (2026-10-21): keep the `full` default guard mode, keep the
  soft Windows sandbox with AppContainer opt-in, and keep the gateway key as
  the `/v1` boundary with the full tool surface. The packaged NSIS matrix
  remains unrun; 0.18.19 is the signed build to run it against, on a
  throwaway Windows account or VM.

## The round after that: the board table, audited against the core it claims

Two deep dives (SimulIDE, and the `pi` harness) turned up defects in August's
own tables rather than in the reference repos, which is the usual outcome.

**THE BOARD PIN TABLE SAID THE PRO MINI WAS A MEGA.** `_BOARD_PINS` carried
`arduino:avr:pro` as 54 digital + 16 analog — the Mega's row — while the
installed core says `pro.build.variant=eightanaloginputs`, whose header raises
`NUM_ANALOG_INPUTS` to 8 on top of `standard`'s 14 digital pins and puts
`PIN_A0` at 14. So `circuit_add_board` wrote a `.subckt` with 70 pins for a
22-pin board, 40 of them invented, and `firmware_stimulus` named Arduino pin
14 `D14` when the core calls that pin `A0`. `arduino:renesas_uno:unor4` said
27+12 against its own `variants/MINIMA/pins_arduino.h` (20u digital, 6u
analog, `PIN_A0 (14u)`) → 14+6. And `arduino:avr:micro` said 14 digital while
its header is `#include "../leonardo/pins_arduino.h"` whole — two boards
sharing one header cannot have different counts, so Micro is 20+12 like the
Leonardo row beside it. **Fixed**, with the source of each count named next to
the row: the table is now checked against a platform, not remembered.

**A MENU-QUALIFIED FQBN WAS READ AS A BOARD.** arduino-cli takes
`arduino:avr:pro:cpu=8MHzatmega328` — the 3.3 V Pro Mini — and the compiler
path must keep that whole string. The board's FACTS are filed under the first
three segments, so the qualified string missed both tables: `board_logic_level`
fell through to its 5.0 default and stepped every PWL source on the wrong rail
(the exact failure the UNO R4 fix recorded, reachable a second way),
`board_pin_list` returned nothing, `board_short_name` answered
`cpu=8mhzatmega328`, and a deck named its SPICE block `CPU_8MHZATMEGA328`
instead of `PRO`. `board_base_fqbn` + `_board_row` resolve exact-then-base, a
variant row carries its own rail, and `_BOARD_LOGIC_LEVELS` no longer repeats
the rails the pin rows already state — one fact, one place. Measured after the
fix: the qualified Pro resolves 14+8 pins, 3.3 V, block `PRO`, pin 14 → `A0`.

**THE TOOL DESCRIPTIONS HAD STALE BOARD LISTS.** Six of them named
`uno/nano/mega/leonardo/unor4` while the table carried seven boards, so a model
was told `micro` and `pro` do not exist. They interpolate
`firmware_tools.board_names()` now, which derives from the one table.

**`BEGIN` WAS THE WRONG TRANSACTION FOR A READ-THEN-WRITE.** The sessions
domain opens a transaction, reads `is_archived` (a column the wire does not
carry, so the save keeps it), then upserts. A deferred `BEGIN` takes only a
READ snapshot; once another connection commits, SQLite refuses the upgrade with
`database is locked` IMMEDIATELY — `busy_timeout=10000` buys nothing, because
waiting never makes a stale snapshot writable. Measured on a throwaway
database, against the shipped `_begin_txn`: deferred read→write with one commit
interleaved fails in 0.000 s; the same sequence under `BEGIN IMMEDIATE` writes
in 0.005 s and the other connection just waits for the lock. `e2e:smoke` had
caught it as a real `SQLite session write failed` ERROR at boot (310 ms after a
migration wrote), which is how a durability loss in the session snapshot gets
seen at all. The deferred form was restored in-tree to prove the red before the
one-line change was kept.

**A PAGED READ DID NOT SAY WHERE TO CONTINUE.** The receipt said
`[lines 120-319 of 4200]` — the model had to compute the next offset and often
re-read a window it already had. It now says `use offset=320`, and drops the
clause at end-of-file so a complete read claims nothing is left. Same
discipline as the spill note and the too-large error, and the reason the pi dive
was worth running: its truncation receipts are actionable, and ours nearly were.

**FROM THE REFERENCE DIVES, NOT COPIED:** SimulIDE is AGPLv3, so its mechanisms
are readable and its code is not — and three of the four `pi` ideas that looked
new turned out to be shipped already (length-stop fails the whole tool batch at
`workbench.py:4661`, spill receipts name the path, read-before-edit is a gate).
The open list from both dives lives in
`docs/research/2026-10-21-simulide-and-pi-harness.md`.

