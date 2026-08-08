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
- **Parked, still open**: Data & Privacy center, provider health simulator,
  first-run safety choice, image attachment source-path preservation.

## Done in the wizard + privacy + simulator pass

- **AI Setup wizard** — new `/settings/ai-setup` section (Essentials, basic
  tier) that becomes the landing section for bare `/settings` while first-run
  setup is incomplete (no provider + workspace yet; same state that drives the
  onboarding checklist). Six guided steps: add provider (embeds the real
  `AddProviderForm`) → test connection (strict "Connected!" probe) → discover
  models → pick default model (`august_last_model`) → **safety mode choice**
  (`read-only` / `workspace-write` / `danger-full-access`, persisted to
  `august_last_sandbox_mode` — the same key new sessions read, so the
  first-run safety choice is live) + workspace folder picker → start chatting
  (marks onboarding done). "Skip setup" leaves the landing.
- **Data & Privacy center** — new `/settings/privacy` section (Essentials)
  backed by a new `app/routers/privacy.py`:
  - `GET /api/privacy/summary` — counts of facts, auto-memories, heuristics,
    proposals, timeline, sessions, messages, usage events, audit events,
    routing evidence, sub-agent runs, observation screenshots, DB size.
  - `POST /api/privacy/export` — one readable JSON bundle (memories, usage
    by model, sessions, messages) written to the backend data dir.
  - `POST /api/privacy/purge-memories` — erase the agent's memory of you
    (facts/auto-memories/heuristics/proposals/timeline; system KV kept).
  - `POST /api/privacy/clear-logs` — audit/config/guardrail/consolidation/
    friction tables + observation PNGs.
  - `POST /api/privacy/delete-usage` and `POST /api/privacy/delete-sessions`
    (the latter cascade-aware through `delete_workbench_session`).
  - UI: storage stat cards + confirm-gated action rows that report exactly
    what was removed.
- **Provider Health Simulator** — new `/settings/health-simulator` section
  (Diagnostics, advanced) + `POST /api/providers/simulate`: three real probes
  (connectivity via the shared strict probe, tool support via a
  `probe_ping` tool call, fallback route via `resolve_or_fallback`).
  `testModel` now shares `_probe_connectivity` (behavior unchanged).
- **Debate verdicts feed the evidence loop** — finished debates get a "who
  made the better case?" winner row that POSTs to `/api/brain/routing/arena`
  (winner ok=1, losers ok=0), so judged debates count like arena comparisons
  in the reliability dashboard + arena archive.
- **Parked, still open**: image attachment source-path preservation (needs
  Tauri dialog plumbing).

## Done in the self-improvement + evals + bug pass

- **Self-improvement loop (turn-level lessons)** — failed turns now record
  `provider_reliability` heuristics (upstream errors, stall hard-stops,
  format rejections) and verifier blocks record `verifier` correction
  heuristics — merged/confidence-bumped on repeats, scrubbed of secrets,
  injected into future system prompts (top-N by confidence) with
  rollback/suppress UI already in the Brain You tab. Verified end-to-end
  via the eval scenarios.
- **Scheduled golden evals** — `run_turn` now works without pytest
  (`_DirectPatch` stand-in), so the 7-scenario golden suite runs in the
  background every 6h from app boot (`scheduled_evals_loop`) and on demand
  via `POST /api/brain/harness/evals/run` — with a **"Run evals now"**
  button in the Reliability dashboard. Verified 7/7 passing through the
  real loop.
- **Arena replay + history** — migration `011` adds a `prompt` column to
  `routing_evidence`; verdicts store the original prompt, the archive
  groups rows per verdict with winner/loser chips, and **Replay** re-runs
  the same lanes on the stored prompt (shared `launchArenaRun` extracted
  from ChatThread so replay uses the exact launch path). Old rows (no
  prompt) show a hint instead of a dead button.
- **Bug & UX batch** —
  - `GET /api/providers/health` now returns the `{results, at}` shape the
    desktop polls (was `{'status':'ok'}` — the Health dot never rendered);
    the health monitor diff-syncs the provider store so probes self-heal.
  - Right drawer capped at 60% of the viewport (was 80% — at minimum
    window widths it swallowed the conversation).
  - New shared `useFocusTrap` applied to CommandPalette, Shortcuts,
    Conversation Search, Onboarding, and Quit-Confirm (focus moves in on
    open, Tab is contained, focus restores on close).
  - Image attachments preserve their **source path**: dropped files in
    Tauri are read via a new `read_file_base64` shell command and the
    attachment keeps its real path (`FileAttachment.path`).
- **Parked, still open**: none of the roadmap items remain — future work
  is new territory (guided AI Setup landing was folded into the wizard).
