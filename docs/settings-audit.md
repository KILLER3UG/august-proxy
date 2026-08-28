# Settings IA Audit & Migration Notes

> **Source of truth:** `frontend/desktop/src/settings/settings-registry.ts`.
> **Current (2026-08-28+): 3 header groups — Settings / Agent Capabilities / Data & Statistics — with an inline tree rail.**
> Headers are the left rail; the active header expands its sections as tree rows (no pill tab strip). Hidden ids (`ui-designer`, `ai-setup`, `agent-board`, `tool-grants`, `python-sandbox`, `backend-monitor`, `health-simulator`) resolve via `railCanonicalId`; `ui-designer` additionally renders as a visible tree grandchild under Appearance via `RAIL_CHILDREN`.

## Why this document exists

Records the settings IA so future contributors can extend without re-deriving. Deep links keep working via `legacyAliases` + `LEGACY_HUB_MAP` (`system→settings`, `intelligence→capabilities`, `insights→data`, `tools→tools-connections`, `access/security→agent-sandbox`).

---

## Current IA (verified 2026-08-28)

**38 sections across 3 header groups.** The rail is a tree: header → sections → (optional) grandchildren. `tier: 'hidden'` ids are interior views, not separate rail items. Default landing section is `general`.

| Header | Sections (rail order) | Concern |
|--------|----------------------|---------|
| **Settings** `settings` (8) | General, System Status, Account, Data & Privacy, Updates, Appearance (+ UI Designer grandchild), AI Setup (hidden) | Profile, preferences, notifications, health, account, retention, theme/colors |
| **Agent Capabilities** `capabilities` (22) | Models & Providers, All Models, Model Fleet, Background Review & Reflection, Live (STT/TTS), Aliases, Fallback, Quotas, Memories, Facts & Rules, Skills, Prompt Templates, Integrations, Desktop Automation, Reminders, Automations, Agent Board (hidden), Files & Shell Access, Path Permissions (hidden), Python Sandbox (hidden), Desktop App Permissions, External API Access | Models, memory, skills, tools, automations, access |
| **Data & Statistics** `data` (8) | Usage & Limits, Activity Log, Conversations, Request Inspector, Feature Flow, Harness Improvements, Backend Monitor (hidden), Provider Health Simulator (hidden) | Usage, telemetry, traces, diagnostics |

### Rail mechanics

`WorkspaceShell.tsx` left rail = 3 header rows (`CATEGORY_ICONS`: `Settings2/BrainCircuit/LineChart`). The active header expands its non-hidden sections inline (folder ▸ files pattern); `RAIL_CHILDREN` (`appearance → ['ui-designer']`) renders a second indented level while the parent section is active. Search bypasses headers and surfaces matching sections grouped by category; hidden sections never appear as search or rail rows. `SettingsPage.tsx` resolves `:section` via `LEGACY_HUB_MAP` → `resolveLegacyTab`, rewrites bare/legacy URLs to the canonical section, and lazy-loads the section component (`SECTION_COMPONENTS`).

### New sections (2026-08-28)

- `general` (General) — replaces the old `profile-preferences` section (id kept as a `legacyAlias`). Content: Profile (avatar, call-you, work description, instructions-for-August), Preferences (chat font, reduce motion, voice language/style/speed), Notifications (response completions + job complete), Text size, Experience presets, Keyboard shortcuts, Onboarding, About card. State lives in `src/lib/preferences.ts` (localStorage blob `august.preferences`, `data-chat-font` / `data-reduce-motion` attributes applied to `<html>`; boot-applied in `main.tsx`).
- `appearance` (Appearance) — theme picker (light/dark/system) + the UI Designer embedded below (`#settings-colors`); `/settings/ui-designer` scrolls the designer into view. The old `theme` alias now resolves here.

### Section inventory (excerpt)

| id | Label | header | tier |
|----|-------|--------|------|
| `general` | General | settings | basic |
| `system-health` | System Status | settings | basic |
| `account` | Account | settings | basic |
| `privacy` | Data & Privacy | settings | basic |
| `appearance` | Appearance | settings | basic |
| `ui-designer` | UI Designer | settings | hidden (grandchild of `appearance`) |
| `model-providers` | Models & Providers | capabilities | basic |
| `model-fleet` | Model Fleet | capabilities | advanced |
| `model-reflection` | Background Review & Reflection | capabilities | advanced |
| `model-live` | Live (STT/TTS) | capabilities | basic |
| `memory-knowledge` | Memories | capabilities | basic |
| `memory-facts` | Facts & Rules | capabilities | basic |
| `usage` | Usage & Limits | data | basic |
| `observability` | Activity Log | data | advanced |
| `api-access` | External API Access | capabilities | basic |

`tier` is retained for `hidden` interior views and future `advanced` gating; the rail itself shows all non-hidden sections of the active header.

### Subagent harness

Delegation config: `delegation: {maxConcurrent:5, maxIterations:50, maxDepth:1, worktreeIsolation:false}` in `workbench.metadata.delegation` (`POST /api/subagents/config`). Statuses `queued/running/stalling/completed/failed` with queue position `queuePosition/queueTotal`, `lastActivityAt/apiCalls` for stall monitor (>90s → `stalling`), `isStalling`. `result_full` 20k blob + `cache/delegation/<taskId>.jsonl` live transcript via `GET /{taskId}/transcript`.

---

## Extending Settings

1. Add a section object to `SETTINGS_SECTIONS` with the correct `category` header; array order = rail order within the header.
2. Keep `id` stable; use `legacyAliases` for old deep links (and `LEGACY_HUB_MAP` for header renames).
3. Keywords must not collide (registry `auditRegistry()` validates).
4. Prefer lazy-loaded section components (`SettingsPage.tsx:lazySection`).
5. Nested tree items go in `RAIL_CHILDREN` (parent section id → child section ids); keep the child `tier: 'hidden'` and map it in `RAIL_PARENT`.
6. Update this file when adding/removing sections or headers.

## Migration notes

- v3 → 0.16.5: 5 categories → 8 hubs; `general→system`, `intelligence→models`, `activity→insights`, `security→access`; `conversations-history→insights`; `agent-sandbox→access`.
- `Show advanced` toggle removed — `WorkspaceShell.tsx` no longer uses `useSettingsAdvancedPreference`.
- 2026-08-26: `memory` hub restored as its own top-level category (dropped in the 0.17.0 IA reorg) and split into four store-scoped sub-tabs — Memories (`memory-knowledge`: autoMemories + kv), Facts & Rules (`memory-facts`: facts + heuristics), Timeline (`memory-timeline`: timeline + blackboard), Sessions (`memory-sessions`: sessions + messages + exams) — all rendered by one `MemorySection` component backed by `GET /api/brain/stores[/{name}]`. Data & Privacy stays in `system`.
- 2026-08-26 (memory humanization): `MemorySection` rewritten from a raw table browser to human-readable titled **entry cards** (facts grouped under category headers), a **detail view** (Markdown body, provenance line, Delete via confirm dialog, inline edit over a per-store field whitelist → `PATCH /api/brain/stores/{name}/{id}`), a Claude-style **add-box** (`POST /api/memory/manage`, `source='user'`), two **model-memory toggles** (`modelMemoryWrites`, `memorySensitiveTopics` → `PUT /api/brain/config`), and per-entry / per-store **Markdown export**. `heuristics` + `autoMemories` render as read-only **Legacy** stores. Section ids, icons, and keywords are unchanged.
- 2026-08-28 (Part 15.2): `memory-timeline` + `memory-sessions` sub-tabs deleted — the `episodic_timeline` table has no live writer, and the sessions/messages/exams stores duplicate the sidebar, chat, and exam UIs (all were read-only). The Memory hub keeps two sections (Memories, Facts & Rules); the deleted ids survive as `legacyAliases` on `memory-knowledge` so stale deep links land on Memories. 39 → 37 sections.
- 2026-08-28 (UI enhancement request): 8 hubs → **3 header groups** (`settings` / `capabilities` / `data`); every section reassigned, no section deleted. `profile-preferences` replaced by new `general` (old id kept as alias); new `appearance` section hosts the theme picker and the UI Designer as a `RAIL_CHILDREN` grandchild (item: "Move the UI Designer into a sub-tab under Appearance"). `model-reflection` relabeled "Background Review & Reflection". Old hub ids resolve via `LEGACY_HUB_MAP` (`system→settings`, `intelligence→capabilities`, `insights→data`, `tools→tools-connections`, `access/security→agent-sandbox`) or existing aliases (`models→model-providers`, `memory→memory-knowledge`, `automations→agents-automation`, `activity→observability`). Default landing section `system` → `general`. `ProfilePreferencesSection.tsx` + orphaned `WorkspaceGeneralSection.tsx` deleted, replaced by `GeneralSection.tsx` + `AppearanceSection.tsx`. 37 → 38 sections.
