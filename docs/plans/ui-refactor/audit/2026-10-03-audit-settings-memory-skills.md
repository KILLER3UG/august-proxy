# Current-state audit — settings IA, memory & knowledge, skills, model/provider settings

Stage 1 evidence for the 2026-10-03 UI/UX refactor spec. Read-only audit by a subagent on
2026-10-03 of `C:\Dev\august-proxy\frontend\desktop`. All paths relative to
`frontend/desktop/src`; line numbers 1-based as read that day.

---

# August Proxy — Current-State UI Audit: Settings IA, Memory & Knowledge, Skills, Model/Provider Settings

## 1. Registry inventory (`settings/settings-registry.ts`, 803 lines)

**Verified counts** (script-parsed, `settings/settings-registry.ts:141-682`):

| Metric | Current value | Prior doc claim | Verdict |
|---|---|---|---|
| Registered sections | **45** | 45 | correct |
| Categories | 3 (`basics` 11, `capabilities` 25, `data` 9) — `settings-registry.ts:111-127` | 3 | correct |
| Tiers | **15 basic / 2 advanced / 28 hidden** | 15/2/28 | correct |
| Implemented in `SECTION_COMPONENTS` | **43 of 45** (`pages/SettingsPage.tsx:338-393`); unimplemented: `hooks`, `indexing` | 43 | correct |
| Rail rows (non-search) | **17** = 14 grouped (15 basic − `ai-setup`, excluded at `WorkspaceShell.tsx:210`) + 2 advanced + 1 standalone Onboard (`WorkspaceShell.tsx:242-260`) | "only 17 visible" | number right, composition different |
| Search keywords | **304** (+86 legacy aliases) | ~250 | stale low |
| Settings-surface files | **70 files / 20,044 lines** (`sections/settings` incl. `integrations/` + `components/settings` + `settings/`, excl. `__tests__`) | 60 files / 21,974 | changed |
| `MemorySection.tsx` | **2,196 lines** | 2,196 | exact match |
| Interactive controls (all settings .tsx) | **219** (`<button\|input\|select\|textarea\|SettingsToggle\|role="switch"` per file) | 103 | does not reproduce |
| Files with zero controls | **16** (incl. 3 primitives + SettingsPage itself) | 20 of 60 | changed |
| MemorySection controls | **41** | 14 | does not reproduce |

Full section table (id · label · category · tier · component · controls):

**Basics** — `general` General · basic · `GeneralSection.tsx` · real (8 raw + SettingsToggle/SettingsCard). `appearance` Appearance · basic · `AppearanceSection.tsx` (97 ln, 0 raw controls, uses SettingsCard) + `ui-designer` UI Designer · hidden · `UiDesignerSection.tsx` (392 ln, 3). `model-providers` Model settings · basic · `workspace/models/ProvidersTab.tsx` · real CRUD (see §6). `browser-use` · basic · `CapabilitySections.tsx` (4). `computer-use` · basic · `ComputerUseSection.tsx` (204 ln, 4). `system-health` System Status · hidden · `SystemHealthSection.tsx` (384 ln, 1). `account` Account · hidden · `AccountSection.tsx` (324 ln). `privacy` Data & Privacy · hidden · `PrivacySection.tsx` · 5 actions (§4). `app-updates` About · basic · `UpdateSection.tsx` (279 ln). `ai-setup` Onboard · basic · `AISetupWizardSection.tsx` (488 ln, 12).

**Agent capabilities** — `memory-knowledge` Memory · basic · `MemorySection.tsx` · 41 controls (§4). `subagents` · basic · `CapabilitySections.tsx`. `turn-limits` Turn Limits · **advanced** · `TurnLimitsSection.tsx` (288 ln, 2). `plugins` · basic · `CapabilitySections.tsx`. `tools-connections` MCP Servers · basic · `IntegrationsSection.tsx` (438 ln) + `IntegrationDetail.tsx` (656) + `integrations/` (700) + `CustomIntegrationForm.tsx` (215). `skills` · basic · `SkillsSection.tsx` (932 ln, 14) (§5). `prompt-templates` Commands · basic · `PromptTemplatesSection.tsx` (8). `hooks` · hidden · **no component** (not in `SECTION_COMPONENTS`, `SettingsPage.tsx:338-393`). `model-catalog` All Models · hidden · `workspace/models/AllModelsTab.tsx` (338). `model-fleet` · hidden · `workspace/ModelFleetTab.tsx` (255). `model-reflection` · hidden · `workspace/models/BackgroundReflectionTab.tsx` (159). `model-live` Live (STT/TTS) · hidden · `workspace/LiveSettingsTab.tsx` (247). `model-aliases` · hidden · `workspace/models/AliasesTab.tsx` (239). `model-fallback` · hidden · `workspace/models/FallbackTab.tsx` (187). `model-quotas` Quotas · hidden · `workspace/models/QuotasTab.tsx` (9 ln → wraps `QuotasPanel.tsx`, 151 ln, 0 controls — read-only). `memory-facts` Facts & Rules · hidden · **same MemorySection** (alias, `SettingsPage.tsx:386-387`). `recurring-tasks` Reminders · hidden · `RecurringTasksSection.tsx` (5). `agents-automation` Automations · hidden · `AgentsAutomationSection.tsx` (70 ln, 0 controls — thin). `agent-board` · hidden · `KanbanSection.tsx` (6). `agent-sandbox` / `tool-grants` / `python-sandbox` · hidden · all → `AccessHubSection.tsx` (53 ln) branching on id. `computer-access` Desktop App Permissions · hidden · `ComputerAccessSettings.tsx` (10). `api-access` External API Access · hidden · `ExternalAccessSection.tsx` (3). `model-families` · **advanced** · `ModelFamiliesSection.tsx` (8).

**Data and statistics** — `indexing` · hidden · **no component**. `usage` Usage stats · basic · `workspace/WorkspaceUsageSection.tsx`. `observability` Activity Log · hidden · `ObservabilitySection.tsx` (0 controls; sub-tabs `LogsSubtab` 4, `TrafficSubtab`, `AuditTimeline`, `RollbackHistory`, `ObservationGallery`, `ObservabilityOverview`). `conversations-history` Conversations · hidden · `ConversationsHistorySection.tsx` (**25 ln, 0 controls — the thinnest "implemented" section**). `conversation-inspector` · hidden · `workspace/WorkspaceInspectorSection.tsx`. `feature-flow` · hidden · `FeatureFlowSection.tsx` (4) + `FeatureFlowCanvas.tsx`. `harness-improve` Review Inbox · **basic** (comment `settings-registry.ts:638-642` explains the promotion) · `HarnessImprovementsSection.tsx` (14). `backend-monitor` · hidden · `BackendMonitorSection.tsx` (4). `health-simulator` · hidden · `HealthSimulatorSection.tsx` (3).

## 2. Shell & nav

- **It is a modal, not a page.** `components/workspace/WorkspaceShell.tsx:147-151` — `fixed inset-0 z-50 … bg-black/55` backdrop with `max-w-[1180px]` panel. `pages/SettingsPage.tsx:1` comment says "full-screen settings page (replaces modal)" and `WorkspaceShell.tsx:144-146` says "floating over the workspace" — the comments contradict each other; behavior = modal over scrim.
- **Search**: `WorkspaceShell.tsx:102-117` — `String.toLowerCase().includes` over exactly three fields (label, description, keywords); keywords come from the registry (`WorkspaceShell.tsx:88-89`). Search bypasses tiers entirely (`visibleForSearch = decorated`, :100) so hidden/advanced sections are reachable via search only.
- **"N of M sections" counter**: `WorkspaceShell.tsx:156-160` — `{totalShown} of {decorated.length} sections`; `decorated` is fed `implementedSections` from `SettingsPage.tsx:169-175`, so M is 43 and `hooks`/`indexing` can never appear. Confirmed. `CommandPalette.tsx:45` duplicates the unimplemented set (`['hooks','indexing']`) as a hard-coded second source of truth.
- **Deep linking**: route `/settings/:section` with `?tab=` rewriting and legacy aliases (`SettingsPage.tsx:132-154`, `resolveLegacyTab` `settings-registry.ts:697-701`); unknown/unimplemented ids fall back to the category's first visible section (`SettingsPage.tsx:119-124`); landing = `general`, or `ai-setup` while onboarding is pending (`SettingsPage.tsx:43-53`).
- **Close/back**: close button top-right `WorkspaceShell.tsx:277-286`; Escape closes via `window` keydown `WorkspaceShell.tsx:135-141`; the return path is `sessionStorage['pre-settings-path']` (`WorkspaceShell.tsx:128-130`, set at `components/shell/ChatLayout.tsx:580` and `components/sidebar/SessionList.tsx:143`). Note: the Escape effect has **no dependency array** (:141 `});`) — it resubscribes on every render (works, but is a smell).
- **Stale self-documentation**: `settings-registry.ts:6` says "44 sections" (now 45). `settings-registry.ts:72-73, 89-93, 136-137` say advanced is "hidden until the user toggles 'Show advanced'" — **no such toggle exists in the shell**; `WorkspaceShell.tsx:94-99` states "no tier filter" and :210 filters only `tier !== 'hidden'`. The `august-settings-advanced` key is written only by `hooks/useSettingsAdvancedPreference.ts:9,28`, which has **zero consumers** outside its own test (`test/useSettingsAdvancedPreference.test.ts`). `RAIL_CHILDREN` (`settings-registry.ts:719-721`) is exported but never imported — the comment at `AppearanceSection.tsx:4` ("rendered as a tree sub-item") is false; UI Designer is hidden-tier and rail-invisible. `SettingsPage.tsx:1` "full-screen page" comment (above).

## 3. Row primitive

- `components/settings/SettingsSectionShell.tsx:21-51` provides title/subtitle/actions/toolbar/scroll body. **Exactly one consumer**: `sections/settings/AccessHubSection.tsx:4,17,31,40`. Prior doc confirmed.
- Every other section hand-rolls its header. Worst hand-rollers: `MemorySection.tsx:822-825` (own h1) plus its own `PaneHeader` primitive at `MemorySection.tsx:1288-1324`; `SkillsSection.tsx:341-373` (own header + back button); `PrivacySection.tsx:177-185`; `HarnessImprovementsSection.tsx` (own header); `SkillsSection`/`MemorySection` each re-implement scoped search inputs (`SkillsSection.tsx:354-366`, `MemorySection.tsx:901-914`) instead of `components/settings/SettingsSearch.tsx`; `MemorySection.tsx:1665-1692` re-implements a chip/pill primitive; `SkillsSection.tsx:574-588` re-implements a switch with `role="switch"` while other sections use `components/settings/SettingsToggle.tsx`.
- Shared primitives exist but are thinly adopted: `SettingsCard` used by 9 files, `SettingsToggle` by 6 (`AppearanceSection`, `CapabilitySections`, `ComputerAccessSettings`, `ExternalAccessSection`, `GeneralSection`, `MemorySection`).

## 4. Memory & Knowledge deep-dive (`MemorySection.tsx`, 2,196 lines)

- **Panes**: union `Pane = list | global | project | file` (`MemorySection.tsx:95-99`, switched at :788-820). Scope is **global vs project workspace**, not `bot:<id>` — the DB scopes in AGENTS.md (`global`, `bot:<agentId>`) never surface; project memory goes through the `.aug/memory` markdown door (`/api/august/memory/manage` with `scope:'project'`, `MemorySection.tsx:1392-1396`), and the global add-box posts with no scope (`MemorySection.tsx:760-769`).
- **Browse list**: one flat chronological merge of the three browsable stores `['facts','memory','heuristics']` (`MemorySection.tsx:126`, merged :587-615), kind chips (profile/fact/lesson/pref/note, :254-274), server-side category/source/confidence filters + sort (:916-976), 200-row fetch cap with pager (:1140-1174), bulk select/delete/export (:1027-1049, :701-735), expired-row separation (:634-640).
- **Fact CRUD**: add via bottom bar (:1619-1663), edit over backend whitelist (`STORE_META.editable`, :215-248), delete with confirm (:682-697), per-row/bulk Markdown export (:728-753), profile-lane promote/demote via PATCH `kind` (:562-573, menu item :1904-1915).
- **The four memory-model gates**: `MemorySection.tsx:844-875` — `modelMemoryRead` (:845, default ON via `?? true`), `memoryAutoInject` (:853, **default OFF confirmed** `?? false`), `modelMemoryWrites` (:861), `memorySensitiveTopics` (:869). **The whole "Memory behavior" group is conditionally rendered with `{pane.kind !== 'global' && …}` at `MemorySection.tsx:840`** — i.e., opening the Global memory pane hides all four gates. `test/MemorySection.layout.test.tsx` **pins the vanishing as intended**: line 123 `expect(screen.queryByTestId('memory-group-behavior')).toBeNull();` after clicking `memory-global-row` (:120).
- **JSON-encoding handling**: `parseFactValue` unwraps facts stored as `{"fact","details"}` (`MemorySection.tsx:180-195`, wired into `STORE_META.facts` :219-220); `summarizeKvValue` clamps KV values to a first line and pretty-prints JSON details (:197-213); the detail pane re-displays raw keys under the human title (:2029-2059). The browse list does decode, and the edit field round-trips raw values via `str(row[toCamel(f)])` (:662-670), which re-encodes on save through the PATCH path.
- **Purge as the only memory-data action**: `PrivacySection.tsx:213-230` — "Purge memory" (title at :215) is the only bulk memory-erase action in Settings; the other four actions are export/logs/usage/sessions (:205-284). Confirmed. (MemorySection itself has per-row and bulk delete/export, but those are entry-level.)
- **`api/api-client/brain-backup.ts` is unwired**: exactly 98 lines (:1-98), five functions (`getBrainIntegrity` :79, `listBrainBackups` :83, `createBrainBackup` :87, `stageBrainRestore` :91, `cancelBrainRestore` :95). Production call sites: **zero** — only the barrel re-export `api/api-client.ts:22`. Test files mock the raw URLs (`sections/settings/__tests__/MemorySection.layout.test.tsx:90-91`, `MemorySection.profileKind.test.tsx:147-148`) but no component calls them; no Settings UI lists backups, integrity, or stages a restore.
- **Where "Knowledge" lives**: there is **no Knowledge section**. Registry-wise, the word only appears as a keyword on `memory-facts` (`settings-registry.ts:489`) and in `indexing`'s description ("semantic knowledge cache", `settings-registry.ts:576`) — which is unimplemented. Grep for "Knowledge" hits only `components/overlays/CommandPalette.tsx:298` (a command-palette group heading "Knowledge & runs") and `sections/settings/integrationDirectory.ts:215` ("Knowledge Graph Memory" — a directory entry for an MCP integration, not a UI surface). Knowledge-adjacent content renders inside MemorySection as the `facts`/`heuristics` stores.

## 5. Skills UI (`SkillsSection.tsx`, 932 lines)

- **List view**: hairline rows grouped by scope `SKILL_SCOPE_GROUPS` — project / agent / bundled / other (:846+, grouping :177-181, render :466-489); workspace scope selector with shadowing note (:415-445, :664-671); debounced search (:97-110); error-vs-empty distinction (:196-199, :484-491).
- **Detail pane**: facts strip (usage, trigger, origin, lineage/supersedes, open learning proposals linking to Review Inbox) over rendered SKILL.md (:599-661); enable/disable is a `role="switch"` button PATCHing `disabled` (:574-588, :306-322); edit form and create form (:324-338, :663-700+); delete button gated to non-bundled/project-scoped skills (:383-401) with an inline confirm state `confirmDelete` (:111, :735-770). **No undo after delete; no bulk actions** — only single-row operations (`handleDelete` :281-296). `SkillVersionsPanel` (audit history, :666) and `SkillPacksPanel` (install-from-remote, :416) plus `LearningPanel` (:419) mount inside the section.
- **Suggestions endpoint**: `GET /api/brain/skills/suggestions` is specced in `api/gen/openapi.ts:1289` (response documents `okRateWith`/`okRateWithout`/`lift`, see description at openapi.ts:1304), but **no frontend code fetches or renders it** — grep for `skills/suggestions` outside `gen/` returns nothing, and `okRate|ok_rate|lift` appear nowhere in app code. Prior doc claim **confirmed**: computed server-side, invisible in the UI.

## 6. Model / provider settings (`sections/workspace/models/`)

- **Provider CRUD**: two-pane `ProvidersTab.tsx` (:23-135) — left rail (`ProviderListRail.tsx`), right pane. Create via `AddProviderForm.tsx` (127 ln); edit/delete in `ProviderDetailForm.tsx`: name (inline pencil, :134-155), Base URL with the "used exactly as pasted" hint (:201-211), API format dropdown (3 options, `modelSettingsShared.ts:16-20` — `Chat completions · chat/completions`, `Messages · v1/messages`, `Responses · responses`), API key write-only with masked proof (:225-246), enable/disable (:168-179), delete with confirm (:180-196), model discovery toggle + refresh (`ModelDiscoveryActions.tsx`, :248-257), provider quota config (`ProviderQuotaConfig.tsx`, :259-263).
- **Per-model pencil-edit** (`ModelRow.tsx`): modal with Display name (:274-283), **Context window** (:284-295), Max output tokens (:296-307), input/output modality pills (:308-309), and an "Advanced settings" disclosure (:313-491) containing: Probe capabilities button (:318-333), reasoning checkbox (:334-337), **per-model apiFormat override** with the Claude-family suggestion banner (:338-368, `suggestModelApiFormat` :34-40), `reasoning_effort` support (:369-392), **toolSurface** full/reduced/bare (:393-405), **maxTools** (:406-417), **maxToolResultChars** (:418-429), max effort (:430-443), **free flag** (:447-455) and **priceInPerM/priceOutPerM** with the 0-is-a-price handling (:92-99, :456-488, `parsePriceInput` :45-51). No dead fields observed; every field maps into the PATCH body (:499-523).
- **Test button**: plug-icon per-row connection test (`ModelRow.tsx:596-608`, strict success check :185-207, result rendered :636-667); probe result offers "Apply {surface}" one-click fix (:668-701, :226-229).
- **Presentation**: model-level settings are reached by pencil-editing a row inside a provider (model-providers section), or read-only catalog via hidden `model-catalog`. `SectionHeader` in `SettingsPage.tsx:206-226` renders h1s for the model tabs because they don't render their own.

## 7. localStorage keys (settings-relevant)

Distinct keys touched by the settings surface and its direct dependencies (~24-27 depending on whether chat-composer keys count):

- Theme/appearance: `august.theme`, `august.textSize`, `august.preferences`, `august.uiCustomization.v1`
- Model/composer defaults written by AI Setup wizard: `august_last_model` (`AISetupWizardSection.tsx:143`), `august_last_sandbox_mode` (:149,159), `august_last_effort`, `august_last_workbench_guard_mode`
- Sandbox: `august_sandbox_network_default` (`AgentSandboxSection.tsx:61,174`)
- Integrations: `august-enabled-integrations-v1` (`integrationDirectory.ts:67-80`)
- Prompt templates: `august_prompt_templates`
- Accounts: `august-active-account`, `august-accounts-v1`
- Onboarding: `august_onboarding_done`, `august-onboarding-skipped`, `august-setup-checklist-done`, `august.lastSeenVersion`
- Notifications: `august-os-notify-enabled`
- Hidden models: `august-hidden-models` (`components/overlays/ModelVisibilityModal.tsx:34,41`)
- **Dead**: `august-settings-advanced` (written only by the unconsumed `hooks/useSettingsAdvancedPreference.ts:9`), `august_preset` (referenced only in a comment, `GeneralSection.tsx:289`)

## 8. Keyboard / focus

- **No focus trap in the settings modal**: `WorkspaceShell.tsx:147-151` is a plain div with no `role="dialog"`, no `aria-modal`, no focus capture, no `aria-hidden` on the chat behind it; the backdrop (`:148`) has no click-to-close either. Tab order can walk into the obscured chat beneath the scrim.
- **Escape double-fire bug**: `WorkspaceShell.tsx:135-141` listens on `window` and closes the whole settings panel; nested surfaces also listen for Escape — `ConfirmDialog` on `window` (`components/overlays/ConfirmDialog.tsx:36-41`, calls only `preventDefault`, not `stopPropagation`), `ModelRow`'s edit modal on `document` (`ModelRow.tsx:232-241`), `MemorySection`'s row menu on `document` (`MemorySection.tsx:1874-1878`). Events bubble document→window, so **one Escape press in any confirm dialog, model-edit modal, or row menu simultaneously cancels the nested surface AND navigates out of Settings**.
- `ModelRow`'s modal is the best-behaved dialog in the surface: `role="dialog" aria-modal="true"` + labelled (`ModelRow.tsx:246-251`) — but still no focus trap/initial focus.
- `ConfirmDialog` focuses its confirm button on open (`ConfirmDialog.tsx:45-47`) — good; no focus return.
- Rail links are real buttons (`components/workspace/WorkspaceNavLink.tsx:39-46`) but carry **no `aria-current`** for the active section; active state is visual only (:32-36).
- MemorySection is strong by contrast: selects have `aria-label` (:924,939,955,971), row menu uses `role="menu"`/`menuitem` with `aria-expanded` (:1890-1915), checkbox has `aria-label` (:1740), edit fields have `htmlFor` labels (:2127-2150). Skill toggle has `aria-checked`/`aria-labelledby` (`SkillsSection.tsx:575-588`).

---

## Consolidated lists

### 1. Inconsistencies
- `pages/SettingsPage.tsx:1` says "full-screen settings page (replaces modal)" vs `WorkspaceShell.tsx:144-151` modal-over-scrim with `max-w-[1180px]` — comments disagree; modal wins.
- `settings/settings-registry.ts:6` "44 sections" vs actual 45 (:141-682).
- `settings/settings-registry.ts:72-73,89-93,136-137` "advanced hidden until 'Show advanced' toggle" vs `WorkspaceShell.tsx:94-99,210` — no toggle exists; advanced always shown.
- `sections/settings/AppearanceSection.tsx:4` + `settings-registry.ts:717-721` claim ui-designer is a rail tree child — `RAIL_CHILDREN` is imported nowhere; ui-designer is rail-invisible.
- Registry claims "every keyword owned by exactly one section" (audit :764-773) yet the registry test (`test/settings-registry-audit.test.ts:40-45`) only bounds total sections 18-50, not the shipped counts — the doc-facing numbers (44, ~250 keywords) rot silently.
- Unimplemented-section knowledge duplicated: `pages/SettingsPage.tsx:391-393` (derived) vs hard-coded `components/overlays/CommandPalette.tsx:45` `['hooks','indexing']`.
- Scope vocabulary: AGENTS.md memory scopes are `global`/`bot:<agentId>`, but the UI's scope axis is global vs project workspace (`MemorySection.tsx:95-99,1392-1396`) — two different "scopes" share the word.
- Prior-doc numbers vs measured: 103 controls (→219), MemorySection 14 (→41), 20/60 zero-control files (→16 of 70), 60 files/21,974 lines (→70/20,044), ~250 keywords (→304).

### 2. Dead UI / hardcoded or fake status
- `api/api-client/brain-backup.ts:79-97` — five functions, 98 lines, zero production call sites (only barrel `api/api-client.ts:22`); backup/restore/integrity has no UI.
- `/api/brain/skills/suggestions` (`api/gen/openapi.ts:1289-1304`) — okRateWith/okRateWithout/lift computed backend-side, fetched and rendered nowhere.
- `hooks/useSettingsAdvancedPreference.ts:9,28` — persists `august-settings-advanced` for a toggle that no component reads or renders.
- `settings-registry.ts:719-721` `RAIL_CHILDREN` — exported, never imported.
- `settings-registry.ts:403-411` (`hooks`) and `:573-582` (`indexing`) — registered, keyword-owning sections with no component; reachable only as deep-link fallbacks to another section (`SettingsPage.tsx:119-124`).
- `sections/settings/ConversationsHistorySection.tsx` (25 lines, 0 controls) and `sections/settings/AgentsAutomationSection.tsx` (70 lines, 0 controls) — implemented in name only; near-stub sections behind real registry entries.
- `sections/settings/SettingsPage.tsx:169-175` — the "N of M sections" denominator excludes unimplemented sections by construction, so search can never reveal `hooks`/`indexing` even as errors.
- `august_preset` — referenced only in a comment about its own removal (`GeneralSection.tsx:289`).

### 3. Accessibility gaps
- `components/workspace/WorkspaceShell.tsx:147-151` — settings modal has no `role="dialog"`, no `aria-modal`, no focus trap, no click-to-close on the scrim; background chat is not inert.
- `components/workspace/WorkspaceShell.tsx:135-141` + `components/overlays/ConfirmDialog.tsx:36-41` + `sections/workspace/models/ModelRow.tsx:232-241` + `sections/settings/MemorySection.tsx:1874-1878` — uncoordinated Escape handlers; one press closes nested dialog *and* the whole panel (also `preventDefault` without `stopPropagation` in ConfirmDialog).
- `components/workspace/WorkspaceNavLink.tsx:32-46` — no `aria-current="page"` on the active rail item; active state is color-only.
- `MemorySection.tsx:1677-1691` KindChip and `MemorySection.tsx:1002-1050` filter chips — toggle buttons without `aria-pressed`.
- `MemorySection.tsx:903-913` (memory search) — text input without `aria-label` (SkillsSection has one at :358).
- `MemorySection.tsx:1800-1810` row menu closes on outside `mousedown` only — no focus return to the trigger button after close.
- `ModelRow.tsx:243-251` — dialog has correct roles but no initial focus and no focus trap.
- `PrivacySection.tsx:95-107` ActionRow buttons — destructive actions distinguished by color only; no `aria-label` carrying consequence beyond visible text (acceptable but thin given the confirm dialogs do carry it).
