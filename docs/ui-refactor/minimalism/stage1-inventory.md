# Minimalism — Stage 1 inventory (2026-10-05)

**Design principle, overriding everything else:** August's UI shows only what the user needs to
know or act on *right now*. Anything interesting only to a developer does not belong in the main
UI. Less text, fewer badges, fewer persistent indicators, more whitespace. Telemetry is **not**
deleted from the product — it moves behind an opt-in "Developer details" setting (off by default)
or into a dedicated debug view.

**Stage 1 is analysis only.** One code change was made, because it was a required change and it
was mine to undo: the composer metrics strip added earlier today is **fully reverted** —
`ChatThreadComposer.tsx` and `hooks/useChatUsage.ts` are byte-identical to HEAD.

---

## 1. Method

Three independent sources, so the numbers are measured rather than eyeballed:

1. **DOM census.** Headless Chromium at a fixed 1440×900 against the running dev server
   (`:5173`) + real backend (`:8085`), visiting 13 routes and counting visible leaf-text nodes,
   buttons, icons, timestamp-shaped strings and long copy per screen. Script:
   `census.cjs`; raw strings: `census-strings.txt` (333 unique visible strings product-wide).
2. **Four source-read inventories** — chat surface, shell + drawer, settings, secondary routes —
   each element cited to `file:line`.
3. **Before screenshots**, one per screen, in `../minimalism/before/`.

Two agents disagreed with each other and with me; both disagreements are recorded in §7 rather
than smoothed over.

### Measured census (before)

| screen | leaf text | buttons | icons | timestamp strings | copy > 8 words |
|---|---|---|---|---|---|
| chat, empty | 107 | 108 | 111 | 42 | 4 |
| chat, thread open | 140 | 163 | 161 | 42 | 5 |
| runs | 263 | 163 | 273 | 44 | 2 |
| history | 267 | 179 | 179 | 42 | 3 |
| board | 110 | 101 | 102 | 42 | 5 |
| live | 103 | 104 | 102 | 42 | 2 |
| automations | 100 | 100 | 99 | 42 | 3 |
| learning | 110 | 107 | 103 | 43 | 4 |
| settings · general | 81 | 34 | 34 | 0 | 10 |
| settings · memory | 49 | 32 | 27 | 0 | 7 |
| settings · skills | 45 | 32 | 32 | 0 | 9 |
| settings · providers | 29 | 25 | 26 | 0 | 1 |
| settings · about | 26 | 23 | 27 | 0 | 0 |

The 42 timestamps on every chat-adjacent screen are the sidebar session list, not the transcript —
worth knowing before "reduce timestamps" is read as "de-tokenise the conversation".

---

## 2. Reference evidence — what is verified and what is not

Verified locally, on this machine, this session or 2026-10-03:

| reference | how verified | minimalism evidence it supports |
|---|---|---|
| **Claude Desktop** | local MSIX, asar-extracted tokens | Sidebar is nav + pinned + recents + one account row. Developer affordances live in an **out-of-band file** (`developer_settings.json`, `{"allowDevTools": true}`) — dev detail is not in the UI by default at all. Message actions are hover-revealed, 100 ms in / instant out. |
| **DeepSeek Harness** | local install v0.2.0-rc.2, driven over CDP + MIT repo | A **"Work details" dial: Compact / Standard / Detailed / Verbose** — progressive disclosure as a single user setting, which is the closest existing shape to "Developer details". Scrollbar thumbs go transparent when the pointer leaves the column. Reasoning is collapsed by default as one quiet line. |
| **Hermes Desktop** | local checkout v0.21.5 + live Electron | "No greeting, composer, Skip setup, or statusbar appears early… never fabricate progress." Unfocused-and-unhovered panes recede 20 %. Composer status groups start collapsed except todos; a centred ridge hides the whole stack, persisted per conversation. Background events update badges, never the foreground. |
| **ChatGPT desktop** | official docs + Store API only | UNVERIFIED beyond docs (no local install). Its sidebar behaviour is cited in the Stage 1 spec only where documented. |

**Cannot verify here — stated plainly, not guessed:** Codex, Cursor, Goose, OpenCode*, Cline,
LM Studio. None are installed except **OpenCode**, which *is* present at
`%LOCALAPPDATA%/Programs/@opencodedesktop/OpenCode.exe` and can be driven over CDP the same way
DeepSeek Harness was if you want it in the evidence set. I have not run it, so I make no claim
about its UI.

Your second attachment is a different agent session's window; I can see its regions (a bottom
strip with workspace · Local · branch · a context percentage) but I have not identified the
product, so I have not cited it as a reference. The FPS/GPU/CPU overlay on both attachments is a
hardware monitor, not app chrome, and is excluded.

---

## 3. Per-screen inventory

ESSENTIAL / ON DEMAND / NOISE. Only NOISE and ON DEMAND rows are listed — ESSENTIAL rows stay and
are counted, not enumerated.

### 3.1 Chat surface — 213 elements: 82 ESSENTIAL, 92 ON DEMAND, 39 NOISE

| element | where | class | decision | reason |
|---|---|---|---|---|
| Hero glow ellipse | `ChatEmptyState.tsx:49` | NOISE | remove | decoration competing with whitespace |
| "Orchestrator" pill | `ChatEmptyState.tsx:71` | NOISE | remove | duplicates the toolbar mode chip |
| "in ⟨project⟩ — you stay here, workers edit and run." | `ChatEmptyState.tsx:78` | NOISE | remove | folder shown one row below; rest is claim copy |
| Plan → Dispatch → Review stepper | `ChatEmptyState.tsx:82` | NOISE | remove | re-draws the headline |
| Example hint subtext | `ChatEmptyState.tsx:100` | NOISE | remove | the label already says it |
| Hero subtitle (the tagline added today) | `ChatEmptyState.tsx:139` | NOISE | remove | capability claims; discoverable in one turn |
| "in ⟨project⟩" mono path | `ChatEmptyState.tsx:142` | NOISE | remove | same folder again below |
| Asterisk mark (wordmark only) | `ChatEmptyState.tsx:122` | ON DEMAND | wordmark, drop mark | mark is decorative, name is in the titlebar |
| Toast "Attached N file(s)" | `ChatThread.tsx:222` | NOISE | remove | the chips row lists each file already |
| "Sub-agent status is temporarily unavailable — retrying." | `ChatThread.tsx:1612` | NOISE | remove | self-retries every 10 s, nothing to do |
| "Queued — this runs when the current response finishes." | `AssistantMessageContent.tsx:89` | NOISE | remove | QueuePills carries the same state |
| "Queued" dot + word in the user bubble | `UserMessageBubble.tsx:67` | NOISE | remove | third place this state appears |
| Message timestamp | `UserMessageBubble.tsx:118` | NOISE | hover only | never changes what you do |
| Regenerate on the user bubble | `UserMessageBubble.tsx:179` | NOISE | remove | the assistant row's Retry is the same action |
| "Unknown card: {commandId}" | `MessageBubble.tsx:175` | NOISE | remove | raw identifier in chat |
| Streaming spinner in the send slot | `ComposerToolbar.tsx:315` | NOISE | remove | Stop + WorkingIndicator already say it |
| "(i/N)" ordinal on queue pills | `QueuePills.tsx:178` | NOISE | remove | vertical order encodes it |
| Live pulse dot on the activity pack | `ActivitySummary.tsx:265` | NOISE | remove | spinner + label carry liveness |
| "Task completed" text | `ActivitySummary.tsx:241` | ON DEMAND | icon or drop | the finished answer above says so |
| "Done" rail row | `RailDoneRow.tsx:29` | NOISE | remove (keep "Finished with errors") | pack header already closes the turn |
| TaskItem "Done" row | `ToolStepRow.tsx:74` | NOISE | remove | duplicates ±N and the rail marker |
| ExploreGroup "working…" | `ExploreGroup.tsx:59` | NOISE | remove | pack header already shows the live line |
| TaskProgressPill "N files changed +A −R" | `TaskProgressPill.tsx:101` | NOISE | remove | third copy of the same totals |
| "Changes +N −M" corner pill | `ChangesPill.tsx:106` | NOISE | merge into one control | same totals again |
| ClarifyTool eyebrow "Clarification needed" | `ClarifyTool.tsx:268` | NOISE | remove | the question is the label |
| ClarifyTool keyboard-hint footer | `ClarifyTool.tsx:449` | NOISE | remove | duplicates the ↵ key |
| "Projects" section header in the folder popover | `ComposerWorkspaceChips.tsx:167` | NOISE | remove | the list is self-evident |
| Raw history-load error string | `ChatThread.tsx:1643` | ON DEMAND | Developer details | debug artifact |
| Stream-reconnect "(attempt N)" | `StreamLinkBanner.tsx:20` | ON DEMAND | icon + tooltip | not actionable; attempt # is telemetry |
| Cost ceiling "~$0.123 · cap" | `CostCeilingChip.tsx:56` | ON DEMAND | Developer details (keep the cap action) | spend is telemetry |
| Context-ring breakdown rows + "Average cache hit rate" + "not measured" | `ContextRing.tsx:218-252` | ON DEMAND | Developer details | pure telemetry; keep the ring |
| Rate chip "N t/s" | `AssistantMessageContent.tsx:143` | NOISE | Developer details | throughput, no action |
| Raw "turn_end: ⟨reason⟩" line | `AssistantMessageContent.tsx:221` | NOISE | Developer details | wire token |
| TurnProvenanceChip "N skills · N facts · N failures" | `TurnProvenanceChip.tsx:40` | ON DEMAND | Developer details | shell accounting |
| Compaction token math "12k → 4k (−8k)" | `CompactionNoticeCard.tsx:60` | NOISE | Developer details | |
| Activity counts "thought · viewed · edited · ran · used · workers · memories" | `ActivitySummary.tsx:305` | ON DEMAND | Developer details | internal buckets |
| durationLabel "1m 06s" | `ActivitySummary.tsx:274` | NOISE | Developer details | |
| Live tool timer "· 12s" / read duration "1.2s" | `ToolStepRow.tsx:169, 332` | NOISE | Developer details | |
| Subagent elapsed timer | `SubagentDelegateRow.tsx:153` | NOISE | Developer details | |
| PromptDisclosure "SUB-AGENT PROMPT · ⟨id⟩ · ~N tokens" | `PromptDisclosure.tsx:23,41,48` | NOISE | Developer details | raw prompt + token count |
| Recalled-memories block "💭 Recalled N (M project)" | `AssistantBlockTimeline.tsx:1071` | ON DEMAND | Developer details | recall internals |
| "Thought for Xs" | `ThinkingDisclosure.tsx:77` | NOISE | Developer details | duration is telemetry |
| ToolCallItem backend stage chip / "stalled" | `tool/ToolCallItem.tsx:205,217` | NOISE | Developer details | |
| CommandOutputPane "truncated" pill + dropped-output line | `CommandOutputPane.tsx:137,175` | NOISE | Developer details | |
| Arena lane "N tok" | `ArenaPane.tsx:128` | NOISE | Developer details | |
| WorkingIndicator "· step N" + 3-line activity stack | `WorkingIndicator.tsx:195,203` | ON DEMAND | keep one line | three dimmed lines duplicate the pack's live label |
| Upload progress "N%" | `ComposerAttachmentChips.tsx:97` | ON DEMAND | spinner, no % | |
| Attachment "size · truncated" line | `ComposerAttachmentChips.tsx:205` | ON DEMAND | tooltip | truncation matters, byte count doesn't |
| Full mono path on recent-folder rows | `ComposerWorkspaceChips.tsx:199` | ON DEMAND | tooltip | |
| ProjectRulesBadge "Rules from: AUG.md +1" | `ProjectRulesBadge.tsx:34` | ON DEMAND | icon + tooltip | proves a file loaded, no action |
| MemoryEditRow raw key | `MemoryEditRow.tsx:130` | ON DEMAND | drop the key | identifier is not a label |
| EditRailRow directory suffix | `EditRailRow.tsx:143` | ON DEMAND | tooltip | |
| SearchResultsCard "· N results" | `SearchResultsCard.tsx:147` | ON DEMAND | drop count | |
| "Steering ⟨ws⟩ (live)" line | `ChatThreadComposer.tsx:470` | ON DEMAND | icon + tooltip | the send-button title already carries mode |
| Disclaimer under the composer | `ChatThreadComposer.tsx:587` | ON DEMAND | **decision needed** | may be a policy requirement, not a UI element |

### 3.2 Shell + drawer — ~45 elements at rest; 12 NOISE, 12 ON DEMAND

| element | where | class | decision | reason |
|---|---|---|---|---|
| Folder chip (workspace basename) | `ChatTitlebar.tsx:234` | NOISE | remove | third copy of the workspace (sidebar brand, branch chip) |
| "Artifacts" text button in the titlebar | `ChatTitlebar.tsx:261` | NOISE | remove | duplicate of sidebar nav + drawer tab |
| "Share" button | `ChatTitlebar.tsx:271` | NOISE | remove | copies `window.location.href` — a localhost URL |
| Copy workspace path | `ChatTitlebar.tsx:211` | ON DEMAND | Developer details | |
| Branch chip + Git Graph + SHA column + ↑n ↓n | `WorkspaceBranchChip.tsx:256,307,333` | ON DEMAND | collapse / Developer details | an IDE shell living in a chat titlebar |
| Workers count badge | `RightDrawerLauncher.tsx:47` | ON DEMAND | reduce to a dot | mixes "running" telemetry with "needs you" |
| Bots count chip | `SessionList.tsx:649` | NOISE | remove | roster size is not actionable |
| Group counts (Pinned / Chats and tasks / folder / Tasks) | `FolderTree.tsx:43,150` | NOISE | remove | a count of your own list |
| `shown/total` captions | `SessionList.tsx:81` | ON DEMAND | **contested — see §7** | |
| Hollow ring dot when idle | `SessionRow.tsx:502` | NOISE | remove | persists, carries zero information |
| Folder icon on a row already inside a folder | `SessionRow.tsx:506` | NOISE | remove | |
| "Needs handoff" amber badge + count | `SessionRow.tsx:527` | NOISE | remove | exact duplicate of the attention lane |
| Row timestamp | `SessionRow.tsx:536` | ON DEMAND | hover | rarely changes next action |
| "Done" sub-line (model · Done) | `SessionRow.tsx:573` | NOISE | dot only | second rendering of the same fact |
| Model name on live/error sub-lines | `SessionRow.tsx:547,581` | ON DEMAND | keep the headline, drop the model | **decision needed** |
| Preview card "N messages" | `SessionRow.tsx:310` | NOISE | remove | |
| Sort toggle "Recent/Name" | `SessionList.tsx:655` | ON DEMAND | move to menu | |
| Search empty hint (2 lines) | `SessionList.tsx:704,710` | ON DEMAND | one line | teaches "session ids", a dev concept |
| "Active now" pill strip | `BotsRail.tsx:571` | NOISE | remove | duplicate of the rows' own pulse dot |
| Bot row time + last-message preview | `BotsRail.tsx:325,331` | ON DEMAND | hover | two lines per row turns a list into a feed |
| Room member count renders "3b" | `BotsRail.tsx:656` | NOISE | **bug — fix or remove** | literal `b` suffix |
| "Hidden:" rail + restore chips | `RightDrawer.tsx:232` | NOISE | menu, not a rail | exposes parked-pane/polling semantics |
| Tab "–" park vs "×" close | `RightDrawer.tsx:369,382` | ON DEMAND | merge | two close-ish glyphs per tab |
| Chooser subtitle | `RightDrawer.tsx:443` | NOISE | remove | restates the heading |
| Resize `aria-valuetext` pixel readout | `RightDrawer.tsx:176` | NOISE | remove the number | |
| Artifacts "ARTIFACTS" label + "N items" | `RightDrawerArtifactsSection.tsx:107,108` | NOISE | remove | the tab says it; chips carry the counts |
| Artifact row clock + timeAgo | `RightDrawerArtifactsSection.tsx:170` | NOISE | remove | |
| Browser URL line | `RightDrawerBrowserSection.tsx:91` | ON DEMAND | Developer details | |
| Diff per-file status badge (M/A) | `RightDrawerDiffSection.tsx:267` | NOISE | remove | +N/−N already says it |
| Diff manual Refresh | `RightDrawerDiffSection.tsx:134` | NOISE | remove | already auto-polled |
| Findings P0–P3 tag+count pairs | `ReviewFindingsPanel.tsx:100-107` | ON DEMAND | collapse to worst tag | 8 chips for one summary |
| File zoom "100%" readout | `RightDrawerFileSection.tsx:244` | NOISE | remove the % | |
| Jobs "Idle" | `RightDrawerJobsSection.tsx:129` | NOISE | show only when running | a persistent non-status |
| Jobs elapsed timer + its 1 s ticker | `RightDrawerJobsSection.tsx:81,32` | ON DEMAND | Developer details | the ticker exists only to update this |
| Notes "N words" | `RightDrawerNotesSection.tsx:80` | NOISE | remove | |
| Notes "Saved" / "Autosaves as you type" | `RightDrawerNotesSection.tsx:101` | NOISE | remove | one is a non-status, one is a promise |
| Plan `planPath` mono line | `RightDrawerPlanSection.tsx:43` | ON DEMAND | Developer details | |
| Preview `session.id` badge, cwd, logLength, whole Network list | `RightDrawerPreviewSection.tsx:161,164,225,278` | ON DEMAND | Developer details | |
| Subagent tab elapsed "31m 19s" | `RightDrawerSubagentsSection.tsx:565` | ON DEMAND | Developer details | |
| Terminal dock "TERMINAL" label | `BottomTerminalDock.tsx:315` | NOISE | remove | the tab strip names it |
| "Starting real terminal…" / "Connecting to shell…" | `BottomTerminalDock.tsx:405` | NOISE | spinner only | status text with no action; "real" is dev phrasing |
| A second terminal in the drawer | `RightDrawerTerminalSection.tsx:299` | NOISE | **decision needed** | two shells for one feature |
| Palette "Copy current path" / "Refresh all data" | `CommandPalette.tsx:371,351` | ON DEMAND | Developer details | |
| Palette recent-chat rows show `s.id.slice(0,8)` | `CommandPalette.tsx:445` | NOISE | remove | identifier beside a title that already identifies it |
| Palette kbd footer (4 hints) | `CommandPalette.tsx:452` | NOISE | remove | teaches what every palette does |
| Shortcuts modal "Ctrl = ⌘ on macOS" | `ShortcutsModal.tsx:143` | NOISE | remove | on Windows it reads as a wrong claim |

### 3.3 Settings — rail-visible ≈714 → ≈360 (−50 %)

| screen/section | element | where | class | decision | reason |
|---|---|---|---|---|---|
| Shell | "N of M sections" counter | `WorkspaceShell.tsx:194-198` | NOISE | remove or re-label | M = 43 implemented, the rail shows 17 — the denominator is unreconcilable |
| Shell | "App" group header | `WorkspaceShell.tsx:283` | NOISE | drop header | one child (`app-updates`) |
| Shell | profile email / @username line | `WorkspaceShell.tsx:408` | NOISE | remove | also on General → Profile and Account |
| Shell | profile gear icon | `WorkspaceShell.tsx:412` | NOISE | remove | decorative on a row that is already a button |
| Shell | "Up to date / Update available · v…" row | `WorkspaceShell.tsx:416-434` | NOISE | remove | third render of the update state |
| Shell | search-result group-header icon | `WorkspaceShell.tsx:209-215` | NOISE | keep label | `CATEGORY_ICONS` has no `app` key → the App group renders a **Globe** |
| General | Profile card | `GeneralSection.tsx:113-124` | NOISE | remove card | read-only echo; its three editable fields were already deleted |
| General | "About August" card | `GeneralSection.tsx:339-349` | NOISE | remove | verbatim duplicate of the text-size preview copy |
| General | Voice language select (one option: `en`) | `GeneralSection.tsx:170-179` | NOISE | **decision** | a selector the user cannot act on |
| General | Text size `<Badge>{textSize}</Badge>` | `GeneralSection.tsx:243` | NOISE | remove | the segment already shows which is active |
| General | Notifications permission badge | `GeneralSection.tsx:206-209` | ON DEMAND | Developer details | browser-state telemetry |
| General | Keyboard shortcuts card (6 rows) | `GeneralSection.tsx:298-321` | ON DEMAND | collapse | reference, not a setting |
| **Appearance** | **Entire embedded UI Designer** | `AppearanceSection.tsx:65` → `UiDesignerSection.tsx` | ON DEMAND | collapse behind "Colour designer" | `ui-designer` is `tier:'hidden'` (`settings-registry.ts:328`) yet renders **126 colour controls** inside a basic-tier page — the single largest count on any screen: **181 → 42** |
| Appearance | `{themeMode}` badge | `AppearanceSection.tsx:50` | NOISE | remove | repeats the selected segment |
| Appearance | per-token description + "custom" tag ×18 | `UiDesignerSection.tsx:227,232` | ON DEMAND | hover | 6 nodes per token, 108 of them |
| Appearance | "unsaved draft" + "previewing/in sync" badges | `UiDesignerSection.tsx:109,275` | NOISE | one indicator | same fact twice |
| Model settings | Enabled/Disabled pill next to Enable/Disable button | `ProviderDetailForm.tsx:158-179` | NOISE | keep the button | state and its inverse action side by side |
| Model settings | "Stored: ⟨masked⟩" line | `ProviderDetailForm.tsx:241-243` | NOISE | remove | the masked placeholder already proves it |
| Model settings | ModelRow ctx + `source` chips | `ModelRow.tsx:545-578` | ON DEMAND | hover | `source: fetched` is provenance the row cannot change |
| Memory | HealthFooter "expired · 0 · duplicates merged · 0 · last consolidation" | `MemorySection.tsx:1973-1998` | ON DEMAND | Developer details (keep "Run now") | three numbers with no action on a read/edit page |
| Memory | Global-group aside "N memories · updated …" | `MemorySection.tsx:887-889` | NOISE | remove | third render of the same count |
| Memory | 4 server-side selects | `MemorySection.tsx:904-949` | ON DEMAND | "Filters" popover | a query builder on a browse page |
| Memory | Edit labels `fact_value` / `expires_at` | `MemorySection.tsx:2134-2141` | NOISE | human-label | DB column names as user labels |
| Memory | Provenance line `source · confidence · created · updated` | `MemorySection.tsx:2191-2199` | ON DEMAND | behind "Details" | raw snake_case is debug output |
| Skills | LearningPanel telemetry (Turn verdicts, Details chips, jobs ledger, refine journal) | `LearningPanel.tsx:445-806` | ON DEMAND | Developer details | ~40 elements; only Auto-refine, two model pins, run-now and rollback are actionable |
| Skills | SkillPacks panel above the list | `SkillPacksPanel.tsx:76-131` | ON DEMAND | collapse | an install-from-URL tool on every visit |
| Skills | three scope-group explanatory notes | `SkillsSection.tsx:1015-1028` | NOISE | keep at most one | |
| Skills | Version-history 7-char sha | `SkillVersionsPanel.tsx:144-151` | ON DEMAND | drop | its own comment says it belongs in a bug report |
| Turn Limits | `formatValue` caption under each input | `TurnLimitsSection.tsx:210-222` | NOISE | remove | restates the number in the box below the box |
| MCP Servers | "N connected" + "N MCP running" badges | `IntegrationsSection.tsx:346,349` | NOISE | remove | re-shown as the two section counts |
| Commands | Page title "Prompt Templates" ≠ rail label "Commands" | `PromptTemplatesSection.tsx:80` | NOISE | align | two names for one thing |
| **Model Families** | **No page title at all** | `SettingsPage.tsx:226` + `ModelFamiliesSection.tsx:154` | NOISE | **add h1** | `SectionHeader` renders only for ids *in* `HEADERLESS_SECTION_IDS`; `model-families` is not in it and the component has no `<h1>` → the rail opens an untitled page |
| Review Inbox | 5 chips per row (status/kind/regression/queue/age) | `HarnessImprovementsSection.tsx:505-571` | NOISE | 1 chip + hover | a badge wall before the sentence you came to read |
| Review Inbox | raw proposal id in mono | `HarnessImprovementsSection.tsx:345` | NOISE | remove | an id is never a label |
| Usage stats | "App usage" pill | `WorkspaceUsageSection.tsx:105-108` | NOISE | remove | labels a page already titled |
| Usage stats | Peak tokens + Longest streak cards | `WorkspaceUsageSection.tsx:122-143` | ON DEMAND | Developer details | streaks are gamified telemetry with no action |
| Usage stats | Floating bottom-right Refresh | `WorkspaceUsageSection.tsx:250-258` | NOISE | remove | a 30 s-polling dashboard does not need a pinned button |
| Browser Use | Read-only tool registry (snake_case + 110-char descriptions) | `CapabilitySections.tsx:340-346` | ON DEMAND | Developer details | nothing here is settable |
| Subagents | "No subagents running." | `CapabilitySections.tsx:180` | NOISE | remove | the header count already says it |
| Plugins | MCP-servers + Skills roster cards | `CapabilitySections.tsx:240-282` | NOISE | **decision** | a rail row whose content is a worse copy of two other pages |
| Computer Use | Backend + Platform status cards, "How it works" | `ComputerUseSection.tsx:52-75,163-177` | ON DEMAND | Developer details | diagnostics and marketing inside a settings page |
| About | "Automatic updates" note | `UpdateSection.tsx:200-208` | NOISE | remove | explains behaviour with no control |
| About | BackendDepsCard | `UpdateSection.tsx:256-321` | ON DEMAND | Developer details | only "Sync now" is actionable |
| Onboard | h1 "AI Setup" vs rail label "Onboard" | `AISetupWizardSection.tsx:176` vs `settings-registry.ts:334` | NOISE | one name | |
| Files & Shell Access | **4 stacked headings for one page** | `AccessHubSection.tsx:21-52` + three child sections | NOISE | one heading | shell title + subtitle (verbatim registry copy) + each child re-titling itself |

### 3.4 Secondary routes — 218 → 164 element classes (−25 %)

| element | where | class | decision | reason |
|---|---|---|---|---|
| Runs: page subtitle | `RunsPage.tsx:247` | NOISE | remove | restates the stat strip + chips below it |
| Runs: "Total runs" / "Completed" / "Tokens · cost" cards | `RunsPage.tsx:265-272` | NOISE | remove 3 of 4 | terminal counts you never act on; cost duplicates Usage stats |
| Runs: "Live"/"Refreshing…" spinner | `RunsPage.tsx:293` | NOISE | remove | poll state is not actionable |
| Runs: 5 metric clusters per row | `RunsPage.tsx:352-369` | ON DEMAND | keep cost + duration | `Last updated` on a recency-sorted list is noise |
| Runs: goal fallback shows a filesystem path | `RunsPage.tsx:348-350` | NOISE | remove fallback | |
| Board: second header inside the page | `KanbanSection.tsx:65-73` | NOISE | remove | page already has one |
| Board: free-text "Agent" id input | `BoardPage.tsx:179-185` | NOISE | **replace with a dropdown** | asks the user to type an identifier while the bots list is already fetched (`:46-54`) |
| Board: `agentId` in mono on every row | `BoardPage.tsx:214-215` | NOISE | drop | identifier as a second label |
| Board: trailing "No agent runs yet…" | `BoardPage.tsx:234-239` | NOISE | remove | fires with cards on the board; a footnote about a different object |
| Automations: `paused` + `limit reached` badges | `Automations.tsx:806-821` | NOISE | remove | the StatusPill at `:839-850` renders the same words |
| Automations: always-expanded prompt `<pre>` | `Automations.tsx:886-890` | ON DEMAND | collapse | the payload is not needed to triage |
| Automations: raw `agentId` | `Automations.tsx:857-871` | ON DEMAND | hide | |
| Automations: placeholder "0 = keep running" | `Automations.tsx:692` | NOISE | remove | says the label again |
| Live: **"Continuous / Push-to-talk" toggle** | `LiveControls.tsx:35-47` | NOISE | **remove — it is dead** | handler is `() => {}` and `continuousMode={false}` is hard-coded at `LiveSurface.tsx:172,190`; it advertises a gesture that does not exist |
| Live: tool rail prints raw JSON args | `LiveToolRail.tsx:39` | ON DEMAND | strip JSON | |
| Live: **`error` maps to `CheckCircle2`** | `LiveToolRail.tsx:8-12` | — | **bug** | failures render with a tick |
| History: row "N msgs" | `HistoryPage.tsx:131` | NOISE | remove | |
| History: always-visible trash one row below "open chat" | `HistoryPage.tsx:134-143` | ON DEMAND | gate to hover | destructive next to navigational |
| Learning: Skills tab embeds the Scheduler panel | `SkillsSection.tsx:558` | NOISE | **decision** | two doors, one panel |
| ⌘K: "Settings tabs" group lists **all 43** sections | `routes.ts:149` → `CommandPalette.tsx:394` | NOISE | **filter by tier** | see §4 — this is a gate leak, not a copy problem |

---

## 4. Gate defect found during the pass (not a minimalism call — a correctness bug)

`WorkspaceShell.tsx:276-279` hides `tier:'hidden'` sections from the settings rail.
`routes.ts:149-154` builds `SETTINGS_TABS` from **every** registry section with no tier filter, and
`CommandPalette.tsx:394` renders all of them under "Settings tabs". `SettingsSearch` matches
`decorated` = every implemented section (`WorkspaceShell.tsx:115`).

**Result: 27 `tier:'hidden'` developer surfaces are one keystroke away in the main UI**, defeating
the only visibility gate the registry has. The comment above `SETTINGS_TABS` even claims the
sidebar, routes and palette "all stay in sync" — they are in sync on membership and out of sync on
visibility. This is the split-funnel pattern again: the guard sits on one branch, not where the
entry points converge.

Related, same family: `settings-registry.ts:352` advertises "Auto-recall memories each session"
while `MemorySection.tsx:858` renders "Auto-inject relevant memories each turn", and the mismatch
is compensated for by **string scoring** in `hooks/useSettingsFieldLink.ts:52-62`. Fixing the
string is the fix; scoring around a name mismatch is the failure mode.

Also dead chrome found: `FolderTree.tsx:50` gates the sort button on `onToggleSort`, which
`SessionList.tsx:780` never passes, so it can never render; `FolderTree.tsx:109` destructures
`hasActiveSession: _hasActiveSession` (discarded) while `SessionList.tsx:800` computes it;
`FolderTree.tsx:48` gates a group's action buttons on the literal header string.

---

## 5. Removal list for your approval

Grouped so you can approve a phase without approving all of it. Nothing here deletes data or
logging — NOISE rows are removed from view, "Dev" rows move behind the toggle in §6.

**Phase M1 — defects and lies (6 items, no design taste involved)**
1. `BotsRail.tsx:656` renders "3b" for a room member count — fix or remove.
2. `LiveToolRail.tsx:8-12` renders failures with a tick icon.
3. `LiveControls.tsx:35-47` Continuous/Push-to-talk toggle wired to a no-op.
4. `ChatTitlebar.tsx:271` "Share" copies a localhost URL.
5. `ShortcutsModal.tsx:143` "Ctrl = ⌘ on macOS" shown on Windows.
6. `routes.ts:149` palette leaks 27 hidden settings surfaces; `useSettingsFieldLink.ts` scores
   around a label mismatch instead of fixing `settings-registry.ts:352`.

**Phase M2 — duplicates (one fact, one place) — 14 items**
Workspace name (3 places → 1) · Artifacts entry point (3 → 1, **borderline**) · update state (3 →
badge + About) · profile identity (3 → rail + Account) · queue state (3 → QueuePills) · files
changed (3 → **borderline**) · provider enabled (pill + button) · API key stored (3) · global
memory count (3) · turn-limit value (input + caption + unit) · integration counts (badges +
section counts) · draft/applied state (3 indicators → 1) · Plugins page re-listing MCP + Skills ·
`memory-facts` / `ui-designer` resolving to pages already in the list (double search hits).

**Phase M3 — persistent non-statuses and idle chrome — 12 items**
"Idle" (Jobs) · "Saved"/"Autosaves as you type" (Notes) · "No subagents running." · "Task
completed" text · RailDoneRow "Done" · TaskItem "Done" · ExploreGroup "working…" · streaming
spinner in the send slot · hollow idle ring dot · "local preview" badge · "No diff loaded yet" ·
upload percentage readout.

**Phase M4 — telemetry → Developer details — 24 items**
Listed exhaustively in §3.1/§3.3: every duration, token count, cache-hit figure, step count,
attempt number, sha, session id, cwd, endpoint URL, raw JSON payload, backend stage chip, tool
registry, Network list, LearningPanel ledger, Usage streaks, Computer Use diagnostics, About
BackendDeps, Memory HealthFooter.

**Phase M5 — copy reduction — see §7.** ~140 strings over 8 words; the worst 40 are listed.

**Borderline, flagged rather than decided for you**
- Composer disclaimer `ChatThreadComposer.tsx:587` — Claude Desktop ships the same line, so it may
  be a policy requirement rather than UI. **Keep pending your call.**
- Empty-state brand mark + tagline (`ChatEmptyState.tsx:122,139`) — **both added today at your
  request**, and both are NOISE under this principle. I am not removing them unilaterally twice.
- Model name on sidebar rows (`SessionRow.tsx:547,581`) — for a multi-session agent list this may
  be the point of the row.
- `shown/total` captions (`SessionList.tsx:81`) — see §7.
- Arena / Debate / Circuit cards in the general transcript — first-class or opt-in surfaces.
- Terminal: dock *and* drawer variant; one surface or two.
- Preview (dev server) section: core coding surface or developer tool.
- Voice language select with a single option.

---

## 6. "Developer details" — what requirement 4 implies, specified not assumed

No such toggle exists today (`grep` for `developer details|developerDetails|devMode` across `src`
returns nothing; `settings-registry.ts:150-152` records that the old "Show advanced" toggle was
removed 2026-10-03). So this is new surface, and the references disagree about its shape:

- **Claude Desktop** puts dev affordances in an out-of-band JSON file — invisible to a user, no UI
  cost, no discoverability.
- **DeepSeek Harness** puts it in the UI as one **4-position dial** (Compact / Standard / Detailed
  / Verbose) that controls process-group folding without ever hiding the answer.

A boolean is the weakest version of both. My recommendation for your decision, not a unilateral
call: **one tri-state in General — Quiet · Standard · Developer** — where Quiet/Standard govern
transcript process detail (which is what DSH's dial actually does and maps cleanly onto August's
existing `toolSurface` profiles and `/verbose`) and Developer additionally reveals the 24 telemetry
items in §3. It should be one control, not a per-page scatter of toggles, and the transcript must
keep a single unambiguous "is it working or hung" indicator at every setting — the streaming spinner
in the send slot can go *because* Stop and the WorkingIndicator already carry it, not because
indicators are noise. Hiding liveness is what made the long `web_search` waits unreadable.

Where the moved detail lives: **Backend Monitor already is that view** (`BackendMonitorSection.tsx`
— live event feed, category chips, expandable raw payloads). It should be promoted to the
destination rather than a parallel debug surface being built.

---

## 7. Where the evidence disagrees

**Between my own two agents.** The sidebar agent added `shown/total` captions as a Hermes-parity
win; the shell agent independently classified the same element as virtualisation telemetry for the
Developer toggle. Both are defensible — Hermes shows `150/884` and it *is* a count of things you
can't act on. Flagged, not resolved.

**Between an agent's reasoning and the code.** The settings agent's Model Families conclusion is
right but worth stating precisely, because `HEADERLESS_SECTION_IDS` reads backwards:
`SettingsPage.tsx:226` renders the auto header only for ids *in* the set (the set means "this
component has no header, so add one"). `model-families` is absent from it and the component has no
`<h1>` — so the page is genuinely untitled. `account` *is* in the set while `AccountSection.tsx:129`
also renders its own heading, which is how the title ends up twice with two different descriptions.

**Between a reference and August's reality.** Hermes' pinned empty state reads "Shift-click a chat
to pin · drag to reorder". Neither gesture exists in August's sidebar — no `shiftKey`, no
`draggable` — so the copy added today says "Right-click a chat to pin it · or use its three-dots
menu", which does match `SessionRow.tsx:475`. Under this principle that 12-word line is itself
NOISE and should shrink to "Right-click to pin" or move to a tooltip.

---

## 8. Copy pass — worst offenders (of ~140 strings over 8 words)

| where | current | proposed |
|---|---|---|
| `HarnessImprovementsSection.tsx:257` | 51 words | "Proposals and memory retirements waiting on you. Nothing applies until you approve." |
| `TurnLimitsSection.tsx:97` | 48 words | "End a turn after N rounds that keep changing their arguments. 0 = off." |
| `PrivacySection.tsx:216` | 48 words | "Erase N memory entries and KV notes. System config is kept." |
| `IntegrationDetail.tsx:342` | 46 words | "Create a Desktop OAuth client in Google Cloud Console and paste its Client ID." |
| `AgentSandboxSection.tsx:80` | 46 words (plus a second card saying it again) | "Agent mode asks *should it act?* Tool reach asks *where can it touch?*" |
| `ImportMemoryDialog.tsx:597` | 45 words | "Drop a .md or .json export. AI arrange merges and decides; Parse locally just reads." |
| `RecurringTasksSection.tsx:74` | 40-word grammar block | `Trigger: "every 2 hours" or "when I open <repo>".` |
| `MemorySection.tsx:859` | 41 words | "Off: August looks a memory up when it needs one. On: relevant memories are added to every message." |
| `ObservabilityOverview.tsx:76` | 38-word cross-link paragraph | REMOVE (both targets are already in search) |
| `LearningPanel` / `FeatureFlowSection.tsx:162` | 27 words naming `/api/monitor/events` | REMOVE the endpoint |
| `ComputerAccessSettings.tsx:197` | 60 words of camera copy | "Lets camera_snapshot use your webcam unprompted. Frames are deleted after the model describes them. Off by default." |
| `UiDesignerSection.tsx:104` | 30 words | "Colours update the preview live. Press Apply to make them real." |
| `ProviderQuotaConfig.tsx:116` | 34 words | "Optional. August shows a provider quota only when the provider reports one." |
| `ModelFamiliesSection.tsx:157` | 42 words | "August sends a model only the wire parameters its family accepts. A family matches by substring on the model id." |
| `BackendMonitorSection.tsx:285` | 19 words describing four labelled buttons | REMOVE |
| `RightDrawerJobsSection.tsx:119` | "No background jobs. Long-running work started from Settings or an overflowing queue appears here." | "No jobs." |
| `RightDrawerSubagentsSection.tsx:721` | "No subagents yet. Delegate a task and it will show up here like a second conversation." | "No subagents yet." |
| `RightDrawerArtifactsSection.tsx:153` | "Files you edit and links the agent shares will appear here for quick jump-back." | REMOVE |
| `ChatEmptyState.tsx:139` | 22-word tagline added today | REMOVE (flagged borderline) |
| `ChatThreadComposer.tsx:588` | "August is an AI assistant and can make mistakes. Please double-check responses." | KEEP pending policy call |
| `StreamLinkBanner.tsx:20` | 24 words | "Reconnecting" (tooltip) |
| `SavePointChip.tsx:58` | 26 words | "Rewinds N files to before this turn. Chat unchanged." |
| `SessionList.tsx:98` | "Right-click a chat to pin it · or use its three-dots menu" | "Right-click to pin" |
| `AISetupWizardSection.tsx:178` | "… You can always change these later in Settings." | drop the clause (repeated at `:435`) |

Kept deliberately: `WorkspaceUsageSection.tsx:117` "The numbers below are withheld — the request
failed, so these are not zero-usage readings." and `QueryErrorState` blocks generally. Brevity that
turns a failed read into a plausible zero is worse than a long honest sentence.

---

## 9. Counts, summarised

| surface | before | after | Δ |
|---|---|---|---|
| Chat surface (elements) | 213 | 174 | −39 NOISE; 92 move to on-demand/dev |
| Shell at rest (titlebar + sidebar chrome + 1 row + drawer header) | ~45 | ~18 | Claude-Desktop parity is ~18 |
| Settings, rail-visible | ≈714 | ≈360 | −50 % |
| — Appearance + UI Designer alone | 181 | 42 | the single largest win |
| — Memory | 96 | 50 | |
| — General | 59 | 28 | |
| Secondary routes (element classes) | 218 | 164 | −25 % |
| Unique visible strings, product-wide | 333 | ~190 | copy pass + de-duplication |

---

## 10. Stage 2 plan (for approval, not started)

Small phases, each ending with screenshots of the changed screens and a re-run of the census so
the reduction is measured, not asserted. After every phase, confirm by clicking: **send, stop,
switch model, attach a file, approve a tool call, answer an `ask_user_input`, see an error.**
Approvals, clarifications and destructive confirmations are ESSENTIAL by definition and are never
moved behind a toggle.

1. **M1 defects** — 6 items, no taste involved, do first.
2. **Gate fix** — filter `SETTINGS_TABS` by tier at the source so rail, routes and palette cannot
   diverge; replace the `useSettingsFieldLink` scoring with the corrected registry string.
3. **M3 non-statuses + M2 duplicates** — the visible-clutter win, low risk.
4. **Developer details tri-state** + move the 24 telemetry items (§3.1, §3.3) behind it, with
   Backend Monitor as the destination.
5. **Appearance / UI Designer collapse** — biggest single count reduction, isolated to two files.
6. **M5 copy pass** — mechanical, string-only, one commit.
7. **Borderline decisions from §5** — only after you have ruled on each.
