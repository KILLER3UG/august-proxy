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
| **B4's `<DisclosureRow>` consumers.** Five call sites; only `HandoffNoticeCard` passed the `content` prop, so four still owned their bodies as siblings — and the trigger of a closed one advertised no `aria-controls`. | **fixed for three of the four** — `ThinkingDisclosure`, `tool/ToolCallItem` and `CompactionNoticeCard` now pass `content`, so every one of them advertises a real `aria-controls` and `aria-expanded` in BOTH states; `ChangesCard` is the last, and it belongs to the changes-card work. The trap was **measured, not assumed**: with the motion element mounted eagerly, `forceMount`+`hidden` plays the mount animation inside a `display:none` region, so the row opens on an element already at its final state (opacity flat at 1.000, measured in Chromium). Mounted lazily — created in the same commit that un-hides the region — the animation plays (opacity 0.000 → 1.000). The EXIT collapse needed a second fix: the region's `hidden` must not land on the frame the exit starts, so a body that leaves on its own keeps the region rendered until it reports that it is gone (`DisclosureBodyApi`). |
| **The Settings scrim.** `components/workspace/WorkspaceShell.tsx:277-287` says the reference "floats over a completely unchanged app — sidebar, transcript and composer all stay at full brightness" and deliberately drops the tint. | **The code is wrong and the comment is wrong with it.** The repo's own capture says the opposite, twice: `docs/plans/2026-10-11-ui-reference-capture.md:20` — "A **centred modal** on a dimmed chat behind it" — and `:252` — "The chat is dimmed behind it". Being fixed. |
| **The jobs tray.** `components/shell/RightDrawerJobsSection.tsx:100-102` renders `useBackgroundTasksStore`, and `store/background-tasks.ts` has no `persist` — so the tray is in-memory and empties on every reload. | **open** — "move it to a global surface" is a FEATURE (persistence + a surface that survives a reload), not a relocation. The audit's premise was wrong and the measurement says what the feature is. |
| **The composer row and the sidebar density.** No measured target exists. | **open** — an owner's-eye judgement against the reference, not a defect list. |
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
