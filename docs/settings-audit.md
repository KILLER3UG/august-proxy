# Settings IA Audit & Migration Notes

> **Source of truth:** `frontend/desktop/src/settings/settings-registry.ts`.
> **Current (0.16.5+): 8 category hubs with inner pill tabs — no long scroll, no `Show advanced` gate.**
> Hubs are the left rail; each hub stacks only its related sections as pills. Hidden ids (`ui-designer`, `ai-setup`, `agent-board`, `tool-grants`, `python-sandbox`, `backend-monitor`, `health-simulator`) live inside parent hubs via `railCanonicalId`.

## Why this document exists

Records the settings IA so future contributors can extend without re-deriving. Deep links keep working via `legacyAliases` + `LEGACY_HUB_MAP` (`general→system`, `intelligence→models`, etc.).

---

## Current IA (verified 2026-08-26)

**37 sections across 8 hubs.** No `advanced` gate — hubs + pills give progressive disclosure. `tier: 'hidden'` ids are interior tabs, not separate rail items.

| Hub | Sections (related data) | Concern |
|-----|------------------------|---------|
| **System** `system` (4) | System Health, Account, Updates, Data & Privacy | Health, profiles, updater, retention |
| **Appearance** `appearance` (2) | Appearance & Behavior, UI Designer | Theme, text size, colors |
| **Models** `models` (9) | Models & Providers, All Models, Aliases, Fallback, Live (STT/TTS), Quotas, Background & Reflection, Model Fleet, AI Setup | Providers, catalog, routing |
| **Memory** `memory` (2) | Memories, Facts & Rules | Human-readable entry cards, detail + delete + edit, add-box, model-memory toggles, Markdown export |
| **Automations** `automations` (3) | Reminders, Automations, Agent Board | Agents, kanban, cron |
| **Tools & Skills** `tools` (4) | Integrations, Skills, Desktop Automation, Prompt Templates | MCP, skills, computer use |
| **Access** `access` (5) | Files & Shell Access, Path Permissions, Python Sandbox, Desktop App Permissions, External API Access | Sandbox + gating |
| **Insights** `insights` (8) | Activity Log, Usage & Limits, Harness Improvements, Request Inspector, Feature Flow, Conversations, Backend Monitor, Health Simulator | Telemetry, cost, traces |

Sub-agent drawer is **drawer-only** (no inline `SubagentLaunchList` pill in transcript); `ChatRunHeader` is 4 segments (Mode · Wave · live · ctx). Artifacts gallery (`files/images/links`) + `TimelineRail` (≥5 prompts) + `CommandPalette` `Recent chats` merge session search.

### Hub tabs (no long scroll)

`SettingsPage.tsx:CategoryHub` renders one hub header + pill tabs per section (active `bg-foreground text-background`, rest `bg-muted/40`). Content is **one active tab** via `Suspense`, not a stacked long column. `WorkspaceShell.tsx` left rail = 8 hub buttons (`CATEGORY_ICONS`: `Activity/Palette/Boxes/BrainCircuit/Bot/Wrench/ShieldCheck/LineChart`). Search bypasses hubs and surfaces matching sections grouped by category; hidden sections never appear as rail rows.

### Section inventory (excerpt)

| id | Label | hub | tier |
|----|-------|-----|------|
| `system-health` | System Status | system | basic |
| `account` | Account | system | basic |
| `profile-preferences` | Appearance & Behavior | appearance | basic |
| `model-providers` | Models & Providers | models | basic |
| `memory-knowledge` | Memories | memory | basic |
| `memory-facts` | Facts & Rules | memory | basic |
| `privacy` | Data & Privacy | system | basic |
| `observability` | Activity Log | insights | advanced |
| `api-access` | External API Access | access | basic |

`tier` is retained for `hidden` interior tabs only; `advanced` no longer gates the rail.

### Subagent harness

Hermes-structured: `delegation: {maxConcurrent:5, maxIterations:50, maxDepth:1, worktreeIsolation:false}` in `workbench.metadata.delegation` (`POST /api/subagents/config`). Statuses `queued/running/stalling/completed/failed` with queue position `queuePosition/queueTotal`, `lastActivityAt/apiCalls` for stall monitor (>90s → `stalling`), `isStalling`. `result_full` 20k blob + `cache/delegation/<taskId>.jsonl` live transcript via `GET /{taskId}/transcript`.

---

## Extending Settings

1. Add a section object to `SETTINGS_SECTIONS` with correct `category` hub.
2. Keep `id` stable; use `legacyAliases` for old deep links (and `LEGACY_HUB_MAP` for category renames).
3. Keywords must not collide (registry `auditRegistry()` validates).
4. Prefer lazy-loaded section components (`SettingsPage.tsx:lazySection`).
5. Update this file when adding/removing sections or hubs.

## Migration notes

- v3 → 0.16.5: 5 categories → 8 hubs; `general→system`, `intelligence→models`, `activity→insights`, `security→access`; `conversations-history→insights`; `agent-sandbox→access`.
- `Show advanced` toggle removed — `WorkspaceShell.tsx` no longer uses `useSettingsAdvancedPreference`; `workspace-shell-tier-filter.test.tsx` now asserts 5→8 hubs.
- 2026-08-26: `memory` hub restored as its own top-level category (dropped in the 0.17.0 IA reorg) and split into four store-scoped sub-tabs — Memories (`memory-knowledge`: autoMemories + kv), Facts & Rules (`memory-facts`: facts + heuristics), Timeline (`memory-timeline`: timeline + blackboard), Sessions (`memory-sessions`: sessions + messages + exams) — all rendered by one `MemorySection` component backed by `GET /api/brain/stores[/{name}]`. Data & Privacy stays in `system`.
- 2026-08-26 (memory humanization): `MemorySection` rewritten from a raw table browser to human-readable titled **entry cards** (facts grouped under category headers), a **detail view** (Markdown body, provenance line, Delete via confirm dialog, inline edit over a per-store field whitelist → `PATCH /api/brain/stores/{name}/{id}`), a Claude-style **add-box** (`POST /api/memory/manage`, `source='user'`), two **model-memory toggles** (`modelMemoryWrites`, `memorySensitiveTopics` → `PUT /api/brain/config`), and per-entry / per-store **Markdown export**. `heuristics` + `autoMemories` render as read-only **Legacy** stores. Section ids, icons, and keywords are unchanged.
- 2026-08-28 (Part 15.2): `memory-timeline` + `memory-sessions` sub-tabs deleted — the `episodic_timeline` table has no live writer, and the sessions/messages/exams stores duplicate the sidebar, chat, and exam UIs (all were read-only). The Memory hub keeps two sections (Memories, Facts & Rules); the deleted ids survive as `legacyAliases` on `memory-knowledge` so stale deep links land on Memories. 39 → 37 sections.
