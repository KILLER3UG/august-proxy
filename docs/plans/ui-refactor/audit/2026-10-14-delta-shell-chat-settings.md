# Audit delta — shell, chat, settings, drawer (2026-10-14)

Read-only pass. Companion to `docs/plans/2026-10-14-harness-ui-claude-parity.md`. This **deltas** the five
2026-10-03 audits rather than replacing them; where an old item is listed as reversed or done, the old file
is now historical for that item.

Method: three read-only agents inventoried the surfaces; every number and every claim below that I did not
re-measure myself is marked. Two claims I had previously reported to the user were **wrong** and are corrected
in §0.

## 0. Corrections to what I told you on 2026-10-14

1. **`SkillEvolvedChip` does exist** — `sections/chat/SkillEvolvedChip.tsx:58`, mounted at
   `sections/chat/ComposerDecisionStack.tsx:18`. I earlier said it didn't; I had grepped `components/chat/`
   and it lives in `sections/chat/`. `SkillReceiptChip.tsx:10` even names the difference: the receipt is not
   the autonomy notice.
2. **The composer's context/cache readout is not on screen.** `ContextRing` is defined
   (`sections/chat/ContextRing.tsx:11`) and re-exported (`ChatComposer.tsx:9`), but **nothing mounts it** —
   the only non-test references are that re-export and prose in comments. Verified by me directly. Three
   comments still assert it is visible (`makeStreamHandlers.ts:127`, `:908`, `store/contextLive.ts:8`,
   `store/promptCacheLive.ts:6`), and `ContextRing.test.ts*` keeps passing against an unmounted component.

Consequence for the brief: "remove the step/token/cache-hit readout under the composer" is **already true for
cache-hit**, and the thing you are actually seeing is a different component — see §1.2.

## 1. Chat surface

### 1.1 Composer, top to bottom (`ChatThreadComposer.tsx`)
hidden file input → mentions/commands dropdowns (`:351`/`:371`) → `StreamLinkBanner` (`:385`) → offline
banner (`:391`) → `QueuePills` (`:412`) → **centered `TaskProgressPill` (`:423`)** → composer card with
`ScrollToBottomButton` straddling its top border (`:436`) → textarea (`:467`) → live-preview (`:494`) →
`ComposerToolbar` (`:509`) → footer disclaimer + `ModelEffortMenu` (`:593`). The model+effort row and the
`handoffPreparing` spinner are gone (`ComposerToolbar.tsx:318`, `:351`).

### 1.2 Numbers the user did not ask for (all live unless noted)
| Readout | Site | Note |
|---|---|---|
| `Step X/Y · N files +A−B` | `TaskProgressPill.tsx:92-116`, mounted `ChatThreadComposer.tsx:423` | **this is the "step" readout** |
| Session `$` / estimated `~$` | `CostCeilingChip` in `ComposerToolbar.tsx:264` | only opt-in cost surface |
| `N t/s` | `AssistantMessageContent.tsx:150-158` | latency telemetry |
| `· N rounds` on turn_end | `AssistantMessageContent.tsx:196-255` | stop-reason badge — actionable, keep |
| `answered via {model}` | `AssistantMessageContent.tsx:174` | |
| live tool timer / duration | `ToolStepRow.tsx:180`, `:347` | |
| context % + avg cache hit | `ContextRing.tsx` | **unmounted — dead code** |

### 1.3 Tool steps and paths
Canonical transcript renderer is `ToolStepRow` (+ `ToolCallItemBody`). Paths are **already basename-only** via
`pathBasename`/`getToolLabel` (`tool-labels.ts:343`), with the full path in a `title` tooltip
(`ToolStepRow.tsx:315`; `ToolCallItemBody.tsx:248`, `:264`; edit pill `:63-64`). The one real leak: **command
rows print `tool.context` verbatim** (`ToolStepRow.tsx:304`, `CommandOutputPane.tsx:135`), which can contain
absolute paths. So brief item "filenames only" is mostly done; the remaining work is the command line, and it
must not be solved by hiding what the model actually ran.

### 1.4 Four competing expansion patterns (converge on the Task one)
(a) Task disclosure, chevron rotate, seeds from parent, never force-closes — `ToolStepRow`;
(b) portal popover — `ContextRing`, `TaskProgressPill`;
(c) `SettingsTooltip` hover-only — `SavePointChip`, `SkillReceiptChip`, `TurnProvenanceChip`;
(d) native `<details>` — turn_end badge, `CommandOutputPane` toggle.
`HarnessModeChip.tsx` is a **type-only module with no chip** (confirmed still-true from the 2026-10-03 audit) —
misnamed.

### 1.5 Scroll — the forced-bottom mechanism
rAF **lerp** while `streaming && pinned` (`useStickToBottomScroll.ts:223-275`); the pin is a **ref**, not
state (`pinnedToBottomRef`, `ChatThread.tsx:400`). Release fires **only** on `wheel deltaY<0`, touch, PageUp,
Home, ArrowUp (`:176-203`). Streaming may only unpin, never re-pin (`:468-473`).
→ **Cause:** dragging the scrollbar or a trackpad gesture that emits no `wheel` event never releases the pin,
so the lerp keeps pulling `scrollTop → scrollHeight`. A new turn also force-pins
(`setPinned(true)+scrollToBottomImmediate`, `:859`), and idle drift >4px snaps (`:285`).
No regression test exists for this (`useStickToBottomScroll.test` covers helpers only).

## 2. Navigation and Settings

- **Destinations:** `SECTION_ROUTES` has 8 entries, **7 with `nav: true`** (Chat, Automations, Runs, Board,
  Live, History, Learning) — verified by me (`routes.ts:87-143`) — plus the Settings dialog and a dev-only
  `/_design`. The sidebar surfaces only **3** rows: Automations, Board, Learning
  (`SessionListNav.tsx:50-54`, `163-176`). Everything else is ⌘K-only.
- **Settings:** **44 registered sections = 17 basic + 27 hidden**, all 44 implemented
  (`settings-registry.ts:157-808`, `SettingsPage.tsx:361-413`). Verified by me by counting `tier:` assignments
  outside the comment at `:150`. The rail shows 16 grouped + standalone Onboard = 17 rows
  (`WorkspaceShell.tsx:333-374`); **27 sections are reachable only by search or deep link** (search bypasses
  tier). All labels are human text — no raw-key labels. Stale: `:71-72` and `:88-92` still describe a
  "Show advanced" toggle that `:150-153` records as removed. `turn-limits` and `model-families` were
  **promoted** to basic (`:413-419`, `:773-778`) — a reversal of the earlier minimalism call.
- **Six "settings" sections are actually feature pages** wearing settings clothes (they write real workbench
  state, not config): Memory (`MemorySection.tsx:500-624`), Skills (`SkillsSection.tsx:133-427`),
  MCP/Integrations (`IntegrationsSection.tsx:133-153`), Review Inbox (`HarnessImprovementsSection.tsx:238-320`),
  Reminders (`RecurringTasksSection.tsx:31-51`), Learning (`LearningPanel.tsx:332-439`). Pure config: Privacy,
  Turn Limits, Model Families, the access hub (`ToolGrantsSection.tsx:22`, `KernelVenvSection.tsx:47`).
- **Sidebar orphans:** the `Sessions|Terminal|Bots` strip is gone (`SessionList.tsx:718-735`) but
  `railTab==='bots'` still renders `BotsRail` from a persisted localStorage key **with no way to set it**
  (`:165-167`, `:1019-1032`). Date headers are off by default (`:461-462`). Per-row token delta deleted
  (`SessionRow.tsx:557-571`) — a reversal of the old audit's L4.
- **Icons:** lucide-react only (217 imports / 213 files); `react-icons/si` for brand logos in 5 files; the 7
  inline `<svg>` sites are functional renderers (gauges, charts, schematic), not icons. The registry enforces
  one unique icon per section (`settings-registry.ts:881-914`). **Rules are being followed — no icon work needed.**

## 3. Right drawer

13 sections (`RightDrawerState.ts:8-21`) + `routines`. Single active view with a Zed-style tab strip, cap
`MAX_SECTIONS = 4` (`:42`). `openRightDrawer` toasts when the cap drops something (`:126-132`) but the chooser
path `addRightDrawerSection` **drops the oldest silently** (`:310`). Auto-opens: subagents once/run, tasks on
todos, plan on plan (`ChatLayout.tsx:268-312`).

| Section | Current-chat tied? | Verdict |
|---|---|---|
| tasks (todos), plan, subagents, artifacts, circuit, file, diff, notes | yes | **keep** |
| routines | bot chat | keep for bot chats only |
| jobs | filtered by session, machine tray | move to a global surface |
| terminal, preview, browser | **no — machine state** | remove from the chat drawer (duplicates `BottomTerminalDock`) |

**Multi-subagent scaling, measured:** 1 agent → strip + list. 4 → strip is `tabs.slice(-5)` (`:519`) + full
roster (`:734`). **12 → the strip shows only the last 5 (+selected); the other 7 are reachable only by
scrolling the roster or via `TabSearchDropdown`.** No pagination, no virtualization, no height cap. Per-worker
todos exist (`SessionAgentRow.todos` / `AgentRunRecord.todos`, `:50`) but render **only inside the selected
worker's `ProgressPopover` (`:642`)** — there is no `x/y` badge in the roster, so spec §3.4 item 7 is
unimplemented.

**§3.4 status:** the no-op "Remove view" × is **fixed** (real `dismissed` set at `:424`, `:591`, filtered
`:509-512`, pinned by `RightDrawerSubagentsSection.test.tsx:105-110`). Unseen-count badge (`:576`),
`role=tablist`+arrows (`:532`, `:556`), `LiveElapsed` (`:315`) are **done**. Roster-strip item is **partial**
(the roster replaces the detail instead of sitting beside it). Item 8 — chooser order vs `SECTION_ORDER`
mismatch (`State.ts:43-54` vs `RightDrawer.tsx:327-340`) — **still true**.

## 4. Conflicts recorded (do not re-decide silently)

1. `2026-10-03-ui-ux-refactor-spec.md` §3.4 decided "one detail pane + always-visible compact roster strip";
   the tree implemented the strip but the roster still replaces the detail → the decision is **partially
   unimplemented**, not reversed.
2. `2026-10-10-minimalist-ui-redesign-spec.md` §4.1 owns the Settings IA; its section counts (43) and the old
   audit's (45) are both stale — **44 now**, because `kernel-venv` was added (`registry:668-677`).
3. The same spec's minimalism pass demoted things to `hidden`; `turn-limits` and `model-families` have since
   been promoted back to `basic` — an unrecorded reversal that needs a decision, not a cleanup.
4. Brief says memory/recall **backend logic** is out of scope, but the Memory list's summary column is blocked
   by a read-door field omission (`memory_store/brain.py:31-34` drops `description`). Treated as presentation
   plumbing → in scope; retrieval/BM25/`memoryAutoInject`/consolidation → out.
5. Brief asks for `status/ui-audit.md`; no `status/` dir exists — this file follows the established
   `docs/plans/ui-refactor/audit/` convention instead.

## 5. Needs review (decisions I did not make for you)

1. Which readout did you mean? `TaskProgressPill` (`Step X/Y · N files`) is the live one; cache-hit is already
   invisible. Options: remove the pill, demote it into the Task disclosure, or keep step and drop the file
   delta.
2. `ContextRing` + its tests: delete the dead component and correct the four comments that claim it is
   mounted, or re-mount it somewhere the user pulls (Usage page)?
3. `N t/s`, `answered via {model}`, live tool timers — remove all three, or keep the timer during long tools?
4. Removing terminal/preview/browser from the chat drawer is a real capability change for circuit and dev-server
   work — confirm the `BottomTerminalDock` is the right home before I wire them off.
5. 27 settings sections reachable only by search: is that the intended depth, or should the rail grow groups?
