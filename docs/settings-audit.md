# Settings IA Audit & Migration Notes

## Why this document exists

The settings-registry header comment used to promise a
`docs/settings-audit.md` that never got written. After the v3 IA
reorganization, this document records the settings left-rail so future
contributors can extend without re-deriving.

Source of truth for section **ids** and categories:
`frontend/desktop/src/settings/settings-registry.ts`.

---

## Current IA (verified 2026-07-15)

**22 sections across 5 categories.** Some sections use `tier: 'advanced'`
and are hidden until the user enables “Show advanced.”

| Category | Sections | Owner concern |
|----------|---------:|---------------|
| **General** (4) | System & Health, Profile & Preferences, UI Designer, Conversations | App chrome, history |
| **Intelligence** (3) | Model Providers, Brain Orchestrator, Memory & Knowledge | Providers + cognitive + memory |
| **Tools & Skills** (6) | Integrations (MCP & OAuth), Skills, Computer Use, Agents & Automation, Agent Board, Python Sandbox | Agent capabilities |
| **Activity** (5) | Observability, Conversation Inspector, Backend Monitor, Feature Flow, Plans & Todos | Telemetry and artifacts |
| **Security & Access** (4) | Path Permissions, Computer Access, API Access, Developer Console | Gating surfaces |

### Section id inventory

| id | Label | category | tier |
|----|-------|----------|------|
| `system-health` | System & Health | general | basic |
| `profile-preferences` | Profile & Preferences | general | basic |
| `ui-designer` | UI Designer | general | basic |
| `conversations-history` | Conversations | general | basic |
| `model-providers` | Model Providers | intelligence | basic |
| `brain-orchestrator` | Brain Orchestrator | intelligence | advanced |
| `memory-knowledge` | Memory & Knowledge | intelligence | advanced |
| `tools-connections` | Integrations | tools | basic |
| `skills` | Skills | tools | basic |
| `computer-use` | Computer Use | tools | advanced |
| `agents-automation` | Agents & Automation | tools | advanced |
| `agent-board` | Agent Board | tools | basic |
| `python-sandbox` | Python Sandbox | tools | advanced |
| `observability` | Observability | activity | advanced |
| `conversation-inspector` | Conversation Inspector | activity | advanced |
| `backend-monitor` | Backend Monitor | activity | advanced |
| `feature-flow` | Feature Flow | activity | advanced |
| `plans` | Plans & Todos | activity | advanced |
| `tool-grants` | Path Permissions | security | basic |
| `computer-access` | Computer Access | security | advanced |
| `api-access` | API Access | security | basic |
| `developer-console` | Developer Console | security | advanced |

**Note:** Section `id` values are immutable (deep links + `legacyAliases`).
Rename via `label` only; add old labels to `legacyAliases`.

---

## v3 Migration Table (historical)

| Section | v2 category | v3 category | Notes |
|---------|-------------|-------------|-------|
| `system-health` | general | **General** | stays |
| `profile-preferences` | general | **General** | stays |
| `conversations-history` | chat | **General** | archive surface |
| `model-providers` | chat | **Intelligence** | |
| `brain-orchestrator` | chat | **Intelligence** | |
| `memory-knowledge` | memory | **Intelligence** | singleton dissolved |
| `tools-connections` | tools | **Tools** | label **Integrations** |
| skill curator + authoring | tools | **Tools** | merged into `skills` |
| `computer-use` | advanced | **Tools** | |
| `agents-automation` | advanced | **Tools** | |
| traffic / logs / audit | various | **Activity → Observability** | consolidated |
| `computer-access` | security | **Security** | |
| `api-access` | security | **Security** | external gateway |
| `developer-console` | advanced | **Security** | |

### Added after original v3 audit

| id | Notes |
|----|-------|
| `ui-designer` | Live theme/color customization |
| `agent-board` | Kanban multi-agent board |
| `python-sandbox` | Sandboxed Python cell |
| `feature-flow` | Live feature pipeline viz |
| `plans` | `.aug` plans & todos |
| `tool-grants` | Path permission grants |

---

## Extending Settings

1. Add a section object to `SETTINGS_SECTIONS` in `settings-registry.ts`.
2. Keep `id` stable; use `legacyAliases` for old deep links.
3. Keywords must not collide across sections (registry validates).
4. Prefer lazy-loaded section components.
5. Update this document’s inventory table when adding/removing sections.
