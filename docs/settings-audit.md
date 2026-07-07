# Settings IA Audit & Migration Notes

## Why this document exists

The settings-registry header comment used to promise a
`docs/settings-audit.md` that never got written. After the v3 IA
reorganization (commit `git log --grep 'settings IA'`), this document
finally exists.

The Settings left-rail had grown into a sprawl: 7 categories, one of
which (`advanced`) was a junk drawer with 5 mixed sections, plus a
singleton `memory` and singleton `activity` category, plus 3 sections
sharing the `Brain` icon. Renaming a section was a high-risk
operation because every section id was locked behind deep-link
back-compat.

This document records the current IA + the historical migration so
future contributors can extend without re-deriving.

---

## Current IA (v3, 2026-07)

**17 sections across 5 categories. No singleton categories.**

| Category | Sections | Owner concern |
|----------|---------:|---------------|
| **General** (3) | System & Health, Profile & Preferences, Conversations | App-level basics, visual chrome, history |
| **Intelligence** (3) | Model Providers, Brain Orchestrator, Memory & Knowledge | The cognitive core: providers + reasoning + memory |
| **Tools & Skills** (5) | MCP & Connections, Skill Catalogue, Skill Authoring, Computer Use, Agents & Automation | All capabilities the agent can use |
| **Activity** (3) | Observability, Conversation Inspector, Backend Monitor | Telemetry and observability |
| **Security & Access** (3) | Computer Access, API Access, Developer Console | All gating surfaces |

---

## v3 Migration Table

| Section | v2 category | v3 category | Notes |
|---------|-------------|-------------|-------|
| `system-health` | general | **General** | stays |
| `profile-preferences` | general | **General** | stays |
| `conversations-history` | chat | **General** | moved — it's an archive, not a chat config surface |
| `model-providers` | chat | **Intelligence** | category renamed from "Chat & Models" |
| `brain-orchestrator` | chat | **Intelligence** | category dissolved in v2, reinstated in v3 |
| `memory-knowledge` | memory | **Intelligence** | singleton `memory` category dissolved |
| `tools-connections` | tools | **Tools & Skills** | relabelled "MCP & Connections" |
| `skill-curator` | tools | **Tools & Skills** | relabelled "Skill Catalogue" |
| `skills-authoring` | tools | **Tools & Skills** | distinct icon (Pencil vs BookOpen) |
| `computer-use` | advanced | **Tools & Skills** | siphoned from Advanced |
| `agents-automation` | advanced | **Tools & Skills** | siphoned from Advanced |
| `observability` | activity | **Activity** | singleton `activity` category renamed |
| `conversation-inspector` | debug | **Activity** | moved from Debugging |
| `backend-monitor` | debug | **Activity** | moved from Debugging; `activity` category dissolved in v2 |
| `computer-access` | advanced | **Security & Access** | siphoned from Advanced |
| `api-access` | advanced | **Security & Access** | siphoned from Advanced |
| `developer-console` | advanced | **Security & Access** | siphoned from Advanced; was the only "Advanced" legacy-alias target |

The `advanced` category no longer exists; its 5 sections were
distributed into three coherent homes. The legacy alias `advanced →
developer-console` is preserved.

---

## IA invariants (enforced by `auditRegistry()`)

The v3 rewrite adds a runtime integrity check at the bottom of
`settings-registry.ts`. It throws on any of these:

1. **Duplicate section id** — every section has a unique id.
2. **Duplicate icon** — every section uses a unique lucide icon.
   This existed as a visual smell in v2 (3× Brain, 2× Plug, 2×
   BookOpen). v3 fixes by giving each section its own icon.
3. **Keyword uniqueness** — every keyword is owned by exactly one
   section. (In v2, `observability` claimed 20 terms including
   `usage`, `error`, `host`, `health` that semantically belonged to
   other sections.) v3 redistributes these and provides an explanatory
   comment next to any section whose keyword list is non-obvious.
4. **Legacy alias uniqueness** — every legacy alias resolves to
   exactly one section (first-writer-wins insertion order).
5. **Category references valid** — every section's `category` field
   references a declared `SETTINGS_CATEGORIES` entry.

### What the keyword-uniqueness rule costs

A few legitimate overlaps had to be resolved by *moving* the keyword
to the better owner and leaving a comment. Examples:

- `gateway` — moved from `system-health` to `api-access`. Searching
  for "gateway" now opens the API Access page where the user
  actually toggles gateway state.
- `memory` (RAM) — moved from `system-health` to keyword `ram`. The
  two sections both legitimately used "memory" but for different
  concepts; "ram" disambiguates without losing discoverability.
- `usage` — owned by `model-providers` (token cost). Skill-usage
  in `skill-curator` was reached via `lifecycle`.
- `archive` — owned by `conversations-history`. Skill archive in
  `skill-curator` was reached via `stale` or `curator`.
- `screenshot` — owned by `computer-use`. Post-observation
  screenshots in `observability` was reached via `observation`.
- `console` — owned by `developer-console`. Backend Monitor was
  reached via `monitor` and `stream`.

The audit caught real overlaps during the v3 development (10+ rounds
of fixes). It's worth keeping.

---

## Legacy deep-link preservation

All 36 legacy alias strings from v2 are still valid:

```
'services'         → 'tools-connections'   (hard-coded special case)
'mcp', 'skills',
'commands',
'connections',
'services'         → 'tools-connections'
'health'           → 'system-health'
'appearance',
'theme',
'shortcuts',
'hotkeys'          → 'profile-preferences'
'archive',
'conversations',
'chat-history',
'session-history'  → 'conversations-history'
'models',
'providers'        → 'model-providers'
'brain'            → 'brain-orchestrator'
'memory',
'semantic-facts',
'vector-db'        → 'memory-knowledge'
'agents',
'agent-permissions',
'automations',
'terminal'         → 'agents-automation'
'inspector',
'conversation',
'thinking'         → 'conversation-inspector'
'traffic-activity',
'overview',
'logs',
'traffic',
'activity',
'usage',
'artifacts',
'audit',
'rollback',
'observations'     → 'observability'
'advanced'         → 'developer-console'
```

`/dashboard → /settings/traffic-activity` deep links still resolve.

---

## Section-label renames (ids unchanged)

Some labels were tightened in v3 for grammar consistency. The section
**id** is unchanged so all deep links still work; only the displayed
label changed:

- `tools-connections` label: "Tools & Connections" → "MCP & Connections"
- `skill-curator` label: "Skill Curator" → "Skill Catalogue"
- `conversation-inspector` label: same (still "Conversation Inspector")
- `conversations-history` label: "Conversations & History" → "Conversations"

All other v2 labels survive unchanged.

---

## Workspace registry consolidation

The chat-side `workspace-registry.ts` used to maintain a parallel IA
with id collisions (`memory`, `traffic`, `inspector`, `models`,
`general`). v3 changes `workspace-registry.ts` to be a thin filter
over `settings-registry.ts`. It:

1. Sources section metadata from the unified registry.
2. Re-applies a workspace-specific icon override per section.
3. Re-categorises sections into the chat-side 3-category layout
   (`general`, `chat`, `monitoring`) for visual consistency with
   older versions.
4. Has no duplicate keyword/icon/id definitions.

Eliminates ~70 lines of parallel duplication and prevents future drift.

---

## Open follow-ups (intentionally not done in v3)

- The `Skills` subtab in `ConversationsHistorySection` is still
  collapsed into the same component as `conversations-history` and
  the new "Conversations" label may surprise users who navigated via
  the old "Conversations & History" label. Monitor the
  `/settings/conversations-history` traffic after release and add a
  clarifying tooltip if needed.
- The "Activity" category is the dominant data-dense surface
  (Observability has 6 subtabs, Backend Monitor is a live stream,
  Conversation Inspector has 3). Consider promoting activity to a
  "Watch" or "Telemetry" namespace in v4 if these continue growing.
- The `Brain Orchestrator` icon (`Cpu`) is currently distinct from
  `Memory & Knowledge` (`Network`) but they're both literally about
  cognition. Consider deriving a shared "cognition" subtree icon
  family if either section grows another tab.
- The `Audit & Rollback` subtabs inside `observability` were
  originally claimed by the empty `activity` category. With v3, they
  might feel stranded under the broader "Activity" header. Consider
  splitting observability's subtabs into a separate `Audit &
  Rollback` section if user research shows friction.
