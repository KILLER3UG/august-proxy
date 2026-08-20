# Settings IA Audit & Migration Notes

> **Source of truth:** `frontend/desktop/src/settings/settings-registry.ts`.
> **Current (0.16.5+): 8 category hubs with inner pill tabs — no long scroll, no `Show advanced` gate.**
> Hubs are the left rail; each hub stacks only its related sections as pills. Hidden ids (`ui-designer`, `recalled-memory`, `tool-grants`, `python-sandbox`, `backend-monitor`, `health-simulator`) live inside parent hubs via `railCanonicalId`.

## Why this document exists

Records the settings IA so future contributors can extend without re-deriving. Deep links keep working via `legacyAliases` + `LEGACY_HUB_MAP` (`general→system`, `intelligence→models`, etc.).

---

## Current IA (verified 2026-08-21)

**32 sections across 8 hubs.** No `advanced` gate — hubs + pills give progressive disclosure. `tier: 'hidden'` ids are interior tabs, not separate rail items.

| Hub | Sections (related data) | Concern |
|-----|------------------------|---------|
| **System** `system` (4) | System Health, Account, Updates, Data & Privacy | Health, profiles, updater, retention |
| **Appearance** `appearance` (2) | Appearance & Behavior, UI Designer | Theme, text size, colors |
| **Models** `models` (2) | Models & Providers, AI Setup | Providers, catalog, wizard |
| **Memory** `memory` (4) | Memory, Recalled Memory, Added Memory, Project Memories, Prompt Templates | Planes + templates |
| **Automations** `automations` (3) | Automations, Agent Board, Reminders | Agents, kanban, cron |
| **Tools & Skills** `tools` (3) | Integrations, Skills, Desktop Automation | MCP, skills, computer use |
| **Access** `access` (3) | Files & Shell Access, Path Permissions, Desktop App Permissions, External API Access | Sandbox + gating |
| **Insights** `insights` (6) | Activity Log, Usage & Limits, Request Inspector, Feature Flow, Reliability, Conversations, Backend Monitor, Health Simulator | Telemetry, cost, traces |

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
| `memory-knowledge` | Memory | memory | basic |
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
