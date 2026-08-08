# Settings & UX Redesign Roadmap (from the 2026-08 external audit)

Diagnosis + recommended structure. Implementation is staged; this document is
the source of truth for the redesign.

## Current problems

- 27 registered settings sections (15 basic, 12 advanced); docs/comments
  still reference 26 / 18 / 10.
- "Show advanced" only hides rail items — basic screens still contain
  advanced concepts (wire formats, capability profiles, quotas).
- **Bug:** the active `profile-preferences` route renders
  `WorkspaceGeneralSection`, where the presets + onboarding switch are
  visually interactive but nonfunctional — the older functional preferences
  component is not mounted (`SettingsPage.tsx` → `WorkspaceGeneralSection`).
- Onboarding is duplicated (App.tsx mounts checklist + tour overlays) and
  backdrop clicks can dismiss setup accidentally.
- Onboarding links are wrong: "Open a project folder" navigates to `/`
  instead of the folder picker; Google integration points to
  `/settings/integrations` (not canonical).
- Opening Settings hides the session sidebar; "Back to workspace" always
  goes to `/`, losing the exact chat context.
- Send stays enabled before a usable model exists (fixed in 0.12.55:
  `canSend` requires `selectedModel`).
- Errors reduce to "Chat failed" — no Retry / Switch model / Open provider
  settings actions.
- Dialogs lack consistent focus trapping/restoration; some collapsible rows
  are clickable `<div>`s; some controls lack accessible names.
- Right drawer can consume most of the chat area at minimum window width.
- Static "File / Edit / View / Help" menu labels are nonfunctional.

## Target structure (5 groups)

1. **Essentials** — AI setup · Appearance & behavior · Account ·
   Conversations · Integrations
2. **AI** — Models & providers · Memory & saved knowledge · Voice input &
   output
3. **Capabilities** — Skills · Automations · Desktop automation
4. **Permissions** — Files & shell access · Desktop app permissions ·
   External API access · Approval behavior
5. **Diagnostics & Developer** — System status · Usage & limits · Activity
   log · Raw request inspector · Backend monitor · Feature flow · Developer
   console

Move **Agent Board** into the main workspace (a work surface, not a setting).

## Beginner flow

`/settings` opens a guided **AI Setup** page:

1. Add provider
2. Test connection
3. Discover or add models
4. Choose default chat model
5. Choose safety mode and workspace
6. Send a first test message

Keep the provider form minimal (name, endpoint, API key, request format,
test connection); move wire-format overrides, capability profiles, tool
limits, fallback routing, quotas, and raw protocol details under a
"Developer overrides" collapsible.

## Terminology

| Current | Proposed |
|---|---|
| Intelligence | AI & Memory |
| Model Fleet | Model roles |
| Fallback | Backup model |
| Tool Reach | Files & shell access |
| Observability | Diagnostics |
| Wire format | Request format |
| STT/TTS | Voice input/output |

Search results should visibly label Advanced and Developer settings.

## Product opportunities (parked)

- Unified **Runs** view: active / queued / paused / failed / completed agent
  work with resume / retry / cancel from durable checkpoints.
- **Reliability dashboard**: provider latency, failures, cost, fallback
  usage, tool success, verification receipts (data feeds exist: usage,
  routing evidence, harness evals).
- **Data & Privacy center**: API keys, exports, log retention, screenshots,
  memory purge, cleanup.
- **Provider health simulator**: test provider + model + format + tool
  support + fallback route before using it.
- First-run **safety choice** instead of defaulting new sessions to full
  tool access.
- Canonicalize top-level Brain / Skills / Automations / Live / Settings
  routes (dedupe destinations).

## Done in 0.12.55 (this pass)

- Version sync incl. lock files; backend health reports the real version;
  detailed health reflects background-service issues.
- Code-mode hardening (`python -I`, secret env scrubbing) + documented trust
  parity with run_command; no-workspace file writes gated to temp;
  scheduled shell automations routed through the sandbox.
- `/v1/responses` double-translation fixed; `list_available` honors
  env-backed credentials; verifier requires the DECLARED verification
  command (echo ok no longer satisfies it); double `message_stop` removed;
  malformed-tool counter is turn-scoped.
- SSE schema + dispatcher accept `aborted` / `retrying` / legacy
  `final_output`.
- Send disabled until a usable model is selected.

## Done in the restructure pass (0.12.55)

- **5-group rail implemented** — categories renamed (Essentials, AI & Memory,
  Capabilities, Permissions, Diagnostics) and every section re-tagged;
  `Usage & Limits` section added; Agent Board hidden from the rail
  (`tier: 'hidden'`, deep links still resolve).
- **Section labels renamed** per the terminology table (Models & Providers,
  Appearance & Behavior, Files & Shell Access, Activity Log, Request
  Inspector, System Status, Desktop App Permissions, External API Access,
  Memory & Saved Knowledge, Automations, Desktop Automation).
- **Advanced chip** on rail items so advanced surfaces are visibly labeled.
- **Back to workspace** returns to the exact chat the user came from
  (`pre-settings-path`), not always `/`.
- **Appearance & Behavior** now mounts the functional
  `ProfilePreferencesSection`; presets persist (localStorage) and the
  privacy preset applies (tour off, OS notifications off).
- **Onboarding**: the setup checklist is no longer backdrop-dismissible;
  "Open a project folder" launches the real folder picker
  (`august:open-folder` event → `openFolderViaTauri`); Google integration
  links to the canonical `/settings/tools-connections`.
- **"Wire format" → "Request format"** in the model editor.
- **Chat errors are actionable**: Retry (re-sends the message) + Provider
  settings in the failure toast.

## Done in the runs + reliability pass

- **Runs view** — new top-level `/runs` surface (sidebar nav + command
  palette entry): workbench sessions as a run tracker with stat strip
  (total / active / awaiting approval / completed / tokens·cost), status
  filter chips, per-run model · provider · messages · turns · tokens ·
  cost · duration, and one-click jump back into the chat. Polls fast while
  anything is live. Backend: `summarize_session` now carries
  `turnCount` / `totalInputTokens` / `totalOutputTokens` / `totalCost`
  (additive; `GET /api/workbench/sessions` unchanged shape otherwise).
- **Reliability dashboard** — new Diagnostics section (`/settings/reliability`,
  advanced tier): eval pass rate, fleet win rate, weighted latency, and
  avg tokens per turn cards; per-model track-record table with win-rate
  tones; 14-day turn-volume/win-rate bars; recent harness eval runs
  (PASS/FAIL). Empty states explain the data sources instead of dead
  charts. Fed by `/api/brain/harness/trends` + `/api/brain/harness/evals`.
- **Parked, still open**: guided AI Setup wizard as the `/settings` landing,
  Data & Privacy center, provider health simulator, first-run safety
  choice, image attachment source-path preservation.
