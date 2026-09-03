# Part 22 — Capability research: the next expansion batch

Status: **RESEARCH + recommendations — RULINGS RECORDED 2026-09-04 (§9); user approved the
OQ dossier (`2026-09-04-oq-recommendations.md`) as recommended.** Written 2026-09-01. Every August
claim is file:line-verified against this tree; reference mechanics come from an installed
open-source desktop agent scanned the same day (Appendix A.1 — provenance only, not needed to
implement). Web research: Appendix A.2.

This report answers seven "how would we build it" questions, maps each against what August
already has (several are further along than assumed), and proposes concrete, scored items.
Feed-forward: **§5 → Part 21 (M-11/M-12 added there)**, §2/§3 → candidate Part 23 (agent
control plane), §4 → candidate Part 24 (Microsoft connectors), §6 → Part 19 Phase D
amendment, §7 cross-cuts Parts 19/20/21/22. Companions: `2026-09-01-bot-mode.md` (Part 19),
`2026-09-01-messaging-gateway.md` (Part 20), `2026-09-01-memory-enhancements.md` (Part 21).

## 0. Verdicts at a glance

| Area | August today | Verdict |
|---|---|---|
| Automatic token optimization | budgets + compaction + 64 KiB truncation | **mostly built**; adopt spillover + micro-compaction (T-1/T-2) |
| Steer/stop subagents | steer queues for next round; terminate exists | **skeleton built**; finish control plane (D-1/D-2) |
| Agents control the browser | full Playwright tool family + SSRF + allowlist | **built**; harden (B-1..B-3) |
| Microsoft Outlook/Calendar/OneDrive | absent (Google/GitHub/Slack only) | **greenfield** — candidate Part 24; the reference has no personal-account MS tools either |
| Persistent memory for cron jobs | `lastResult` (1 KB) only | **missing** → Part 21 M-11 (runs ledger + notepad + incidents) |
| Group collaboration / peer review | Part 19 Phase D planned; blackboard exists | **amend Phase D** with the review-loop pattern (G-1/G-3) |
| Security hardenings | sandbox modes, SSRF per-hop, URL allowlist | **strong base**; add unattended deny + injection scan (S-1/S-2) |

---

## 1. Automatic token optimization [num]

**August today (verified):** per-model token estimators + budget/critical thresholds
(`workbench/token_budget.py:24,48,65,128-201`); tool-output pruning, schema-safe
summarization, and full compaction with lock + handoff schema
(`workbench/context_compressor.py:209,390,618`; Part 18 handoff landed in 07d87d75); hard
truncation cap `MAX_TOOL_RESULT_CHARS = 64 KiB` (`workbench/workbench.py:97,1723`); tool-round
cap 25 (`workbench.py:73`); usage payloads with cache-split variants already captured per turn
(`workbench/providers.py:744-766` — `prompt_cache_hit_tokens` / `cached_tokens`); Part 18
landed the cache-sentinel scenarios and skills-index budget.

**Reference mechanics worth adopting** (mechanics; provenance A.1):

1. **Spillover instead of hard truncation** — a tool result over the cap is written to a
   cache/spillover file and replaced in-context by head+tail preview + a path reference, so
   the model can re-read the full output through the file tools when it actually needs it.
2. **Micro-compaction** — after each completed turn, fold the *single oldest not-yet-absorbed*
   exchange into a rolling summary (one exchange per turn, amortized; opt-in; config shows
   defaults false / every-n-turns 1 / defrag threshold 2 000 tokens). Contrast: August's
   compaction is threshold-triggered and whole-context.
3. **Per-request context view** — an engine hook that can hand the provider a *modified*
   message list for one call without touching the persisted transcript (keeps cache prefix
   and history honest).
4. Centralized tool-output limit registry (August's cap lives in one constant — fine; skip).

**Proposals (candidate Part 23 §A):**

- **T-1 · Spillover tier [num: no more silent 64 KiB information loss]** — in the truncation
  seam (`workbench.py:1723` path), results > `MAX_TOOL_RESULT_CHARS` spill to
  `data/spillover/<turnId>-<toolUseId>.txt` (head+tail preview inline, ~4 KiB + path); file
  tools can read it back; sweep with turn_outcomes 30-day lifecycle. Test: over-cap result →
  preview + path in transcript, full text on disk, read-back works.
- **T-2 · Micro-compaction mode [num: long sessions stay under budget without a visible
  compaction stall]** — after turn end (idle, never mid-stream), if estimated context >
  soft threshold, fold the oldest pre-summary exchange into the rolling summary. Reuses
  `context_compressor` summarizers; opt-in brain-config `microCompact.enabled` (default
  **off** until measured — Part 18 §6 gate discipline). Calibrations from §8: guarantee a
  small N-user-message tail is never folded; per-model absolute-token threshold (not just a
  ratio). Cache rule: folding touches only messages *before* the cache breakpoint, so the
  warm prefix survives (same rule Part 18 established; assert via cache-sentinel scenarios).
- **T-3 · Cache-split surfacing [rel: make the 08-29 cache work visible]** —
  `providers.py:744-766` already records OpenAI-style cache splits; verify the
  Anthropic-format fields (`cache_read_input_tokens` / `cache_creation_input_tokens`) are
  captured on that path too, and add cacheRead/cacheWrite to the per-turn perf trace + the
  usage dashboard's existing day/hour shapes. Small; closes the "no TTFT telemetry" gap's
  sibling.
- **T-4 · Web-result TTL cache [num: repeated fetches stop re-paying tokens]** — short-TTL
  in-memory cache (e.g. 15 min) for `web_search`/fetch results keyed by URL, so a session
  that revisits a page doesn't re-burn fetch + tokens. Small; reference ships the same
  (v0.20.6, A.2).
- **Non-goals:** Anthropic context-editing API (compaction covers it), token-cost routing
  (routing evidence already exists), prompt-cache-boundary registry (Part 18's sentinel work
  already enforces the invariant differently).

## 2. Subagent steer/stop — finish the control plane [feat/rel]

**August today (verified):** steering = enqueue for the worker's *next round*
(`routers/subagent.py:455-459` → `subagent_orchestrator.py:575`, drained at
`workbench/subagent.py:612`; docstring: "does not interrupt"); stop = `terminate(taskId)`
(`subagent_orchestrator.py:592`) + session-wide `terminateForSession` (`:444`); per-task
transcripts (`:57-101`); spawn waves + approvals via `tools/spawn_subagents_tool.py`;
`yieldSchema` structured results already exist (AGENTS.md, 0.12.55).

**Reference mechanics worth adopting:**

1. **Missed-steer preservation** — if a steering message arrives while the child is finishing,
   it is not dropped: it is stored on the completion entry and the parent sees it alongside
   the result.
2. **Stop delivers the partial result** — a stopped worker's transcript-so-far is folded into
   a completion message back to the parent ("stopped by user; partial findings: …"), instead
   of today's bare `cancelled` status.
3. **Interrupt-vs-queue duality** — steer has two modes: queue-for-next-round (August today)
   and *interrupt at the next iteration boundary* (cooperative stop-flag the worker checks
   between steps, propagating into in-flight tools). A parent that says "stop doing X, do Y
   instead" needs the second.
4. **Delegation ledger** — fire-and-forget delegations persist to SQLite; completions surface
   as a new turn when the parent is idle; undelivered completions survive restarts with a
   staleness cap (48 h in the reference); orphans recovered at boot.

**Proposals (candidate Part 23 §B):**

- **D-1 · Missed-steer preservation [rel: steering never silently lost]** — in
  `drainMailbox`/worker completion path, if the worker already finished, attach the queued
  text to the completion event (`missedSteer: true`). Small.
- **D-2 · Stop → partial result [rel: a stopped subagent's work isn't wasted]** —
  `terminate` collects the task transcript and emits a synthetic completion event with the
  partial findings + `stopped` status. Small-medium.
- **D-3 · Interrupt-mode steer [feat: true mid-run control]** — per-task `interrupt` flag
  checked at the worker's round boundary (`subagent.py:612` neighborhood); when set, the
  mailbox text is injected as a user-role nudge into the *running* turn instead of waiting
  for natural round end. Opt-in per spawn (`acceptsInterrupt`), default off first.
- **D-4 · Delegation ledger [rel: survive restarts]** — persist spawn requests + completion
  delivery in SQLite (reuse `bot_dm` shape from Part 19 Phase C — one table, two users);
  boot recovery re-delivers completions younger than a staleness cap. **Defer** unless Bot
  Mode routines make async delegation common (ruling).
- **User-side parity check:** the Runs UI already lists active tasks; add Steer (textbox) and
  Stop buttons against the existing endpoints (`routers/subagent.py:455, :279`) — no new
  backend. Verify current Runs tab state before scoring (frontend check at implementation).

## 3. Agents control the browser — built; harden [rel]

**August today (verified):** Playwright headless Chromium with per-session pages
(`services/browser/session_manager.py:52-101`); nine model tools — open/click/type/select/
scroll/wait/screenshot/evaluate/getContent with `[@eN]` element refs
(`tool_registrations/web_tools.py:443-533+`, `services/browser/handlers.py:143-298`); URL
allowlist (`handlers.py:106`); page snapshot text (`browser/snapshot.py`); SSRF guard shared
with web fetch, per-hop redirect re-checked (`web_tools.py:108-162`).

**Gaps worth closing** (reference has: CDP passthrough escape hatch, dialog supervisor,
vision fallback on screenshots, persistent per-profile browser directories, cloud backends):

- **B-1 · Dialog handling [rel: a modal blocks the whole session today]** — auto-answer
  JS dialogs with a configurable policy (accept/dismiss/ask) folded into snapshot output.
- **B-2 · Persistent browser profile [feat: logins survive; OAuth sites become
  automatable]** — opt-in per-Bot or global browser data dir, behind explicit consent with
  a visible "browsing as you" state and an approval-gated close flow (the reference's
  v0.20.6 pattern, A.2). Cookies are credentials: never mounted into remote execution
  contexts; unattended contexts (S-1) get the isolated profile only.
- **B-3 · `browser_vision` fallback [feat: canvas-heavy pages the DOM can't crack]** —
  screenshot → existing vision model path → click-at-coordinates. Only if B-1/B-2 prove
  insufficient in dogfooding (defer ruling).
- **Non-goals:** CDP passthrough (evaluate + screenshot already cover the escape hatch need),
  cloud browser backends (single-machine desktop), anti-detection forks (out of scope).

## 4. Microsoft connectors: Outlook, Calendar, OneDrive [feat — candidate Part 24]

**August today (verified):** service-connection layer = Google (gmail/calendar/drive facets
with per-facet scope checking, `services/service_connections.py:29-105`), GitHub, Slack
(`:105-145`); model-driven setup tools with secrets kept out of model reasoning
(`integration_tools.py:5-9,174-201`); OAuth via auth-URL + token exchange, masked cards
(`:169-175`); internal calendar only (`routers/calendar.py:26` — no external events). No
Microsoft anywhere.

**Google integration deep-read (2026-09-01, verified — this is the pattern Part 24 mirrors):**
the Google integration is a **two-layer architecture** — August-native OAuth + MCP-delegated
tools:

- **Auth layer (native, complete, well-tested):** PKCE flow with August's own callback
  (`google_oauth_callback:812-1005`; verifier stored server-side, stale-state purge `:612`),
  per-facet scopes gmail→`gmail.modify`, calendar→`calendar`, drive→`drive.readonly` with
  alias sets counting as authorized (`:33-51`), BYO client id/secret or
  `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID`, PKCE-without-secret supported (`:439-461,586`),
  token refresh with degraded marking on revoked grants (`:489-584`), per-facet disconnect
  preserving other facets (`:1141-1164`). 12 Google tests
  (`test_service_connections_api.py:161-508`: state mismatch, refresh, revoked→degraded,
  per-facet scopes, PKCE, exchange).
- **Tool layer (delegated):** no August-native Google API tools exist — Gmail/Calendar/Drive
  reach the model via the **workspace-mcp** MCP server (catalog `routers/mcp.py:63-69`,
  `uvx workspace-mcp --tool-tier core`). August bridges OAuth into it by writing
  workspace-mcp-format credential files (0600, `~/.google_workspace_mcp/credentials/`) with
  client id/secret + refresh token (`_write_workspace_mcp_credentials:1073-1105`), refreshing
  August's copy first so the file isn't born stale (`sync_google_tokens_to_workspace_mcp:1023-1071`,
  comment: otherwise workspace-mcp "silently 401s ~1 h after connect while the UI still
  claims connected"). The MCP server's own `start_google_auth` is **intercepted**
  (`tools/mcp_client.py:1254-1287`) because its URLs bounce to August's callback without the
  PKCE verifier (`invalid_grant`) — the intercept re-routes through native OAuth and syncs.
- **UI bridging is asymmetric:** installing workspace-mcp auto-enables all three Google
  facets (`useIntegrations.ts:384-388`), but **signing in does NOT install the MCP server** —
  connect-first users get a "connected" card and zero model tools until they separately add
  workspace-mcp from the catalog (the chat calendar card shows only internal events with a
  hint in that state, `CalendarCard.tsx:7-15`). Production today has **no Google connection
  at all** (`serviceConnections` empty in the production config) — the whole surface is live
  code, unused.
- **Consequences for Part 24:** mirror the auth layer (facets+aliases, PKCE, degraded
  marking, per-facet disconnect, credential bridge) — it is proven. For the tool layer,
  Part 24's **native thin tools** are the right call rather than copying the delegation
  layer: Graph is one consistent REST surface, native tools keep the approval gates (S-1)
  in-process, and the delegation route brings the two known liabilities above (setup
  ordering trap, dual token owners refreshing the same grant). Record workspace-mcp-style
  delegation as the fallback if Graph surface maintenance proves heavy.

**Reference reality check:** the scanned reference has **no** personal-account Microsoft tools
— only app-only client-credentials auth for a Teams bot platform and Graph webhooks
(A.1 §4; explicit negatives for mail/OneDrive/calendar `/me` endpoints; the plugin directory
on GitHub confirms it). The "Bots read/write/act across your Microsoft accounts" move is
**Grok Bot's** (2026-08-31, unverified community post — §8). So this is greenfield
differentiation for August.

**Proposed shape (mirror the Google facet pattern exactly):**

- **Provider `microsoft` in `SERVICE_META`** with three facets: `outlook`
  (`Mail.ReadWrite`, `Mail.Send`), `calendar` (`Calendars.ReadWrite`), `onedrive`
  (`Files.ReadWrite`), all + `offline_access` for refresh tokens. Personal accounts use the
  `consumers`/`common` authority; **delegated user auth** (device-code flow as fallback for
  headless/desktop, auth-code like Google as primary — exact flow choice is OQ, see §8/A.2
  for what web research confirms about personal-account Graph app policy).
- **Tool surface (thin, ~8 tools):** `mail_search`, `mail_read`, `mail_send_draft`,
  `mail_send` (approval-gated), `events_list`, `events_upsert`, `files_list`, `files_read`,
  `files_upload` (approval-gated on overwrite). One generic Graph client with pagination +
  401-refresh (the reference's client shape, A.1 §4, is the minimal version of this).
- **Scope gates:** token cache in the existing credentials store (masked cards like
  `:169-199`); `mail_send`/`files_upload`/event-delete are **consequential actions** →
  existing approval/consent gate; egress pinned to `graph.microsoft.com` (browser/fetch
  allowlist untouched); per-Bot token sharing follows the Part 19 credentials-shared rule.
- **Memory tie-in:** mail/event summaries flow through the normal tool-result path →
  Part 21 M-2 scope stamps them; scheduled briefings ("summarize my inbox every morning")
  become Phase B routines whose runs land in the Part 21 M-11 ledger.

**Score [feat]:** unlocks the daily-briefing dogfood the Bot Mode plan names as its Phase B
goal; every item above reuses an existing August pattern (facets, masked cards, approval
gate, routine delivery).

## 5. Persistent memory for cron jobs → Part 21 M-11 [feat/rel]

**August today (verified):** automations live in atomic JSON (`automations_store.py:1-50`);
workbench jobs stamp `agentId` (default `'build'`, `automations_store.py:575,621`) and run
through the session bridge; standalone scheduler jobs record only `lastRun` / `lastResult`
(truncated to 1 000 chars) / `lastError` (500) (`scheduler.py:149-153`). **No run history, no
per-job state, no chaining, no failure dedup** — every run starts amnesiac.

**Reference mechanics (A.1 §5):**

1. **Notepad** — per-job durable KV scratchpad, prompt-injected into every wake, hard-capped
   (16 KB/key, 64 KB/job) *because* it re-injects each run; jobs keep cursors/watermarks.
2. **`context_from` chaining** — a job can name other jobs; their most recent outputs are
   injected before its run (job A finds data, job B processes it).
3. **Executions ledger** — durable per-attempt records with immutable terminal states, capped.
4. **Incidents** — failures grouped by `(job, error-signature)` with
   detected→alerted→closed lifecycle, so identical failures don't re-ping daily.
5. **Monitor mode** — cheap source hashed each tick; unchanged → no LLM run at all; changed →
   run with a unified diff of what changed injected.
6. **Suggestions never auto-create** — proposed jobs need one-tap acceptance.
7. **Continuity + delivery** — a `continuity` flag carries each run's output into the next
   run's context, and a job can deliver its output into a bot's canonical chat *where the
   bot then responds* (§8) — this last one is exactly Part 19 Phase B's `deliver:
   "bot-chat"` and makes routines conversational rather than fire-and-forget.

**Adopted as Part 21 M-11** (full SQL + injection contract there); **M-11a runs ledger +
notepad + incidents** are the core; **R-2 monitor mode** (hash-gate, works for `http`/`shell`
jobs without any LLM call), **R-3 `context_from` chaining**, and **R-6 suggestion flow** are
candidate Part 23 §C items — they earn their place only if Bot Mode routines (Part 19 Phase B)
make unattended jobs a first-class surface.

## 6. Group collaboration & peer review — amend Part 19 Phase D [feat]

**August today (verified):** Part 19 Phase D rooms = bounded round-robin conversation;
blackboard = session-scoped TTL'd notes (`blackboard_service.py:52-143`); code-review
findings parser with tags/severity/anchors (`code_review.py:84-203`); Part 16 background
review config (`background_review_service.py:36-58`); board section (kanban work surface).

**Reference collaboration pattern beyond round-robin** (A.1 §6): a durable **shared task
board** is the collaboration substrate (not the chat log): implementer moves a card to a
first-class *review* phase with a durable summary; a **named reviewer profile** gets the
handoff; verdict routes back to the implementer for changes; blocked tasks escalate to the
human with a recurrence limit (same cause blocked >2 → forced triage); comment threads are
durable context for respawned workers. Plus an LLM "goal judge" (done/continue/wait verdicts)
and a post-turn self-critique fork (August already has the Part 16 analog).

**Proposals:**

- **G-1 · Room review rounds [feat: "checking each other's work" made mechanical]** —
  amendment to Phase D's deterministic driver: a member may end its turn with
  `request_review(@reviewer, summary)` instead of prose; the driver then runs ONE extra
  round where only the named reviewer speaks, whose verdict (`approve` / `changes: …`)
  is appended as a room row and (on changes) triggers one more round by the original
  member. Still deterministic, still capped (review rounds count against the 3-round cap,
  +1 allowance). No new send path — rooms already feed members only new messages.
- **G-2 · Escalation parity [rel: stuck rooms can't spin]** — a member that would block
  twice for the same cause in one room session flips the room to **needs you** automatically
  (extends the existing `@user` badge mechanic; deterministic, no LLM).
- **G-3 · Board as the durable substrate — NO for now** (value check): porting the reference's
  kanban DB duplicates August's existing board section; if dogfooding shows rooms need
  durable handoffs, bind room deliverables to existing board cards instead of a new store.
  Recorded so it doesn't creep back.
- **Non-goals:** mixture-of-agents virtual provider (different feature — model quality, not
  collaboration), moderator LLM-router in rooms (violates the deterministic-driver ruling).

## 7. Security hardenings (cross-cutting) [rel]

**August today (verified):** sandbox modes with protected-path deny even in full access and
soft-enforcement approval asks (`sandbox/policy.py:91-150`); SSRF guard with per-hop redirect
re-check (`web_tools.py:108-162`); browser URL allowlist (`handlers.py:106`); sensitive-code
hook (`hooks/sensitive_code.py`); automation spec gate (`automation_gate.py:18`); Part 20
Phase 0 carries the gateway trust gate (ship blocker).

**Reference mechanics worth adopting** (A.1 §7): approval *taxonomy* — one source of truth
for dangerous-command detection with per-context defaults, where **unattended contexts
(cron/single-query) default to DENY**; a shared threat-pattern library (prompt-injection and
exfiltration regexes, scoped all/context/strict) applied at context assembly and to tool
results; an opt-in write-approval gate for memory/skill writes from both foreground and
background forks; static-analysis guard for externally installed plugins/skills; egress
proxy with opaque tokens (single-machine desktop: non-goal); secret managers (non-goal).

**Proposals:**

- **S-1 · Unattended default-deny [rel: routines and DMs run while you sleep]** — approval
  policy gains a context axis: `interactive` (today) vs `unattended` (automations, Bot
  routines, DM deliveries, group-room turns). Unattended runs execute under read-only-ish
  tool posture; anything needing consent is recorded as a **blocked step** in the run's
  result (Part 21 M-11 ledger row + Bot Chat notice), never auto-approved. This is the
  single most important hardening before Part 19 Phase B makes jobs autonomous.
- **S-2 · Ingestion threat scan [rel: closes the loop M-6 opens]** — the M-6 scrubber strips
  *our* fences; S-2 scans ingested web/browser/fetch content for injection/exfiltration
  patterns (delimiter spoofing, "ignore instructions", credential-shaped strings) and wraps
  the result in a marked boundary before it enters the transcript (and therefore the BM25
  memory corpus). Shared regex module, scoped `strict` for browser/fetch results.
- **S-3 · Instruction-file write approval, always-on [rel: a prompt-injected agent must not
  rewrite its own standing orders]** — writes to skill files, project `.aug/` instruction
  files, and the memory store go through a pending-approval step (one-tap keep/drop in the
  Learning panel) **even in interactive sessions**; in unattended contexts (S-1) they are
  refused outright, not queued. The reference made exactly this rule always-on in
  v0.21.0 (§8) — opt-in was the earlier draft of this item and is deliberately dropped.
  Default: on for skills/instructions; memory `remember` writes keep the existing
  modelMemoryWrites door plus this approval for *file-shaped* memory (project md) only.
- **S-4 · Skill import scan [rel]** — static check at skill import/clone (Bots clone skills!
  Part 19 Phase E): flag dynamic-exec patterns and instructions-to-exfiltrate in SKILL.md
  bodies; warn + require confirm, never silent. Small; extends existing skill hygiene tests.
- **Non-goals:** egress proxy, external secret managers, multi-tenant isolation.

## 8. Latest reference updates + Grok-bot pattern (web-verified 2026-09-01)

**The reference agent's v0.21.0 "Pantheon" release (published 2026-08-31, one day before this
report) is the direct template for Parts 19/21/23** — it validates the Part 19 design nearly
point-for-point and adds calibrations:

- **Bot Mode bundled, default-on:** named profiles, deterministic avatar faces
  (randomize/lock), shared roster, Discord-style group rooms with @-mentions and editable
  room names/pictures. Patch train confirms the rollout order Part 19 uses: bundled plugin +
  teammate protocol first, then a **tabbed SESSIONS|BOTS sidebar** with per-bot hide/unhide,
  then group-room threads + foldable summaries + blob avatars + attachments.
- **Agent-to-agent DMs ("peer" command):** any agent can message any other by handle across
  profiles/gateways; **replies land in each agent's canonical Bot Chat, durable and
  inspectable** — exactly Part 19 Phase C's delivery shape (wake-the-sender, append-only).
  Sub-features: attributed agent-to-agent message cards, sender-side delivery notices,
  a Routines pane (Part 19 Phase B planned the same pane).
- **Cron jobs that remember:** agents load/update persistent memory across runs, a
  `continuity` flag carries each run's output into the next run, per-job durable notepad,
  monitor mode skips the LLM when nothing changed, and **cron output can land in a bot's
  canonical chat where the bot then responds** — this is Part 21 M-11 + Part 19 Phase B
  delivery, validated.
- **Subagent live control:** list running children, steer mid-flight with a course
  correction, stop early **keeping the partial result**, optional JSON-schema validation of
  child outputs, per-delegation cost surfaced in results, defaults raised to 250 iterations /
  10 concurrent children. Validates D-1/D-2/D-3; the JSON-schema part already exists in
  August (`yieldSchema`).
- **Security rule worth copying verbatim:** writes to protected agent-instruction files
  (AGENTS.md-class files, skills, memory stores) **always require write approval — so a
  prompt-injected agent cannot quietly rewrite its own standing orders**. This upgrades
  S-3 from opt-in to a mandatory rule for *instruction/skill/memory files*, while S-1 keeps
  the broader unattended-deny posture. Same release: deep redaction sweep (terminal errors,
  .env reads, checkpoints, logs), Windows destructive-command approval coverage, macOS TCC
  signing identity so permission grants survive updates. A follow-up commit (2026-09-01) also
  made `/stop` interrupt active turns.
- **Compression tuning (v0.20.0/v0.20.6):** per-turn micro-compaction with a **guaranteed
  N-user-message tail**, per-model absolute-token thresholds, proactive tool-result pruning
  for large-window models, lean-tail compression default, and oversized tool results **spill
  to cache instead of being truncated** — calibrates T-1/T-2.
- **Browser (v0.21.0 + v0.20.6):** the agent drives the desktop's own browser window;
  consent-gated "real profile" browsing of the user's default Chromium with a
  close-with-approval flow; TTL result caching for web search/extract. Calibrates B-2/T-4.
  Explicitly *reverted* in the same release: a Model-Council mode and a context-engine
  rewrite — cautionary signal against §6's MoA non-goal.

**Grok Bot (beta 2026-08-11) validates the category from the consumer side and is the actual
source of the Microsoft-plugins move:** xAI markets its bots as **"AI teammates"** that share
a cloud computer, sign into apps/tools/websites, run simultaneously and message each other
(Wikipedia; single source, flagged). Community posts (2026-08-26→31, unverified signals):
**"Grok Bot can now read, write, and act across your Microsoft accounts"** (2026-08-31), a
bot marketplace + an instruction-preview-before-install tool, a "meeting-prep bot calls my
slides bot" workflow (user-level chaining — cf. R-3), and a WhatsApp account-suspension
warning. The @grok-in-X-group-chats pattern could not be verified this session. So the
Outlook/Calendar/OneDrive plugin set (§4) is a **Grok-competitive feature**; the reference
agent ships none of it — the slot is open.

**Microsoft Graph plumbing (MS Learn, fetched):** auth-code flow is primary for desktop
public clients (no client secret; native redirect), device-code is the headless fallback
(user code + verification URI, 15-min expiry, poll with `authorization_pending`); the
`offline_access` scope is **required** or there is no refresh token; refresh tokens are
**rotated on every use and must be persisted**; access tokens ~1 h; personal accounts use
the `consumers`/`common` authority; consumer tokens may be encrypted — parse nothing but the
claimed identity. §4's tool surface and OQ stand; scope strings (`Mail.ReadWrite` etc.) are
standard but flagged unverified in A.2.

**Industry calibration for the control plane:** Claude Code background agents surface
partial results "marked as partial" with resume, and steer via a per-fork panel; the
OpenClaw task system is a push-driven **activity ledger**
(`queued → running → succeeded|failed|timed_out|cancelled|lost`, cancel kills the child,
completion wakes the requester, 7-day prune) — D-2/D-4 and Part 19's typed `reason_code`
match this shape; LangGraph formalizes interrupt/resume with a checkpointer (re-executes
node logic on resume — note for D-3: August's mailbox nudge avoids that class of
re-execution surprise). Anthropic's context-editing guidance now names **server-side
compaction the primary strategy**, with tool-result clearing (trigger ~100 k input tokens,
keep 3 most recent tool pairs) as the fine-grained tier, and **automatic prompt caching**
with a single moving breakpoint — August's Part 18 sentinel work implements the same
invariant client-side; T-2/T-1 stay client-side and provider-neutral.

## 9. Recommended sequencing (needs ruling)

1. **Part 21** as amended (M-1/M-10/M-4 first, + M-11) — foundation everything else reads.
2. **T-1 + T-3 + D-1/D-2** (small, high-value, no new surfaces) — fold into Part 23 with B-1.
3. **Part 19 Phases A–E** as planned, with Phase D amended by G-1/G-2.
4. **Part 24 Microsoft connectors** after Part 19 Phase B (routines give the briefing
   dogfood somewhere to land) — S-1 must land before it (mail is unattended-action territory).
5. **S-2/S-4** ride along with the parts that add ingestion/clone surfaces.

Ruling asks: (a) approve Part 21 amendments (M-11/M-12, §below); (b) charter Part 23
(agent control plane) with T/D/B items; (c) charter Part 24 (Microsoft) with device-code
vs auth-code flow OQ; (d) Part 19 Phase D amendment G-1/G-2; (e) S-1 as gate for Part 19
Phase B.

> **RULING RECORD (2026-09-04) — user approved the OQ dossier
> (`2026-09-04-oq-recommendations.md`) as recommended. Verdicts per ask:**
>
> - **(a) Part 21 amendments — APPROVED with a split:** M-11 already landed (cb626b40),
>   acknowledged, no ruling needed. M-12: approved, land together with S-2 (shared corpus
>   write path; one migration, not two). Note: no `source` stamp on episodes/turn_outcomes
>   yet (`turn_outcomes.py:101-122`) — that stamp ships with the M-12+S-2 batch.
> - **(b) Part 23 — CHARTERED SLIM** as `2026-09-04-part23-control-plane.md`: build list =
>   T-2 micro-compaction, T-3-residual (cache-split aggregates in `routers/usage.py:39-110`),
>   T-4 web-result TTL cache, B-1 browser dialog handling (`browser/session_manager.py:96`
>   has only a console listener), B-2 persistent browser profile (after S-1; unattended
>   contexts keep the isolated profile). **Dropped as already landed (cb626b40):** T-1
>   spillover (`_spillToolResult` `workbench.py:361`), D-1 (`subagent_orchestrator.py:604-614`),
>   D-2 (`:617-641`). **Deferred with recorded triggers:** D-4 delegation ledger, B-3 vision.
> - **(c) Part 24 — CHARTERED with auth-code + PKCE as the resolved flow**
>   (`2026-09-04-part24-microsoft.md`), mirroring the Google auth layer (loopback callback
>   `service_connections.py:595-609`, refresh rotation `:571-573`, degraded-on-invalid_grant
>   `:489-584`); authority `login.microsoftonline.com/consumers`; `offline_access` mandatory;
>   refresh tokens rotate on use; redirect URI = `http://localhost` loopback variant;
>   device-code recorded as a non-goal headless fallback. No MS code exists yet (build is L).
> - **(d) G-1/G-2 — APPROVED into the Phase D charter text now** (Phase D was unbuilt at
>   ruling time): review rounds count against the 3-round cap (+1 allowance); escalation
>   reuses the `@user` badge; two consecutive same-cause blocks flip the room to needs-you.
>   Landed with Phase D on 2026-09-04.
> - **(e) S-1 — APPROVED as a rider, not a gate** (Phase B already shipped). The verified
>   hole: `_approval_never_ask` (`workbench.py:5429-5446`) never consulted
>   `session.headless` and `setDaemonContext` had zero callers, so unattended routine runs
>   executed under the interactive ask policy. **Landed 2026-09-04, before any Phase C/D
>   surface:** `_approval_never_ask` consults the session's headless flag; denied asks
>   become blocked-step rows in the M-11 ledger + a Bot Chat notice; denial extended to the
>   mutation-gate path (`permissions.py:467-474` conversion seam).

---

## Appendix A — Provenance only (external systems; not needed to implement)

### A.1 Installed reference agent (open-source desktop app; source read 2026-09-01)

Install: `%LOCALAPPDATA%\hermes\hermes-agent` (project name **Hermes Agent**, Nous Research).
Shallow clone, branch `main`, HEAD `d63f996a7` "feat(photon): read-receipt toggle…" committed
**2026-08-30** — current as of 2 days ago; no CHANGELOG file. Paths below relative to repo root.

§1 Token/context: `agent/context_engine.py:89,230-260,287` (ContextEngine ABC +
per-request select_context, no-op preserves cache prefix); `agent/context_compressor.py:2185,2238-2244,3341` + `agent/turn_finalizer.py:416-440` + `hermes_cli/config_defaults.py:879-898`
(micro-compaction: one-oldest-exchange per turn, defaults off/1/2000; `_SUMMARY_RATIO` 0.20
at :728; lean budgets 24 000 chars :954 / 4 000 tok :1067); `docs/micro-compaction.md`
(401 lines incl. cache tradeoffs); `agent/prompt_cache_boundary.py:1-20` +
`agent/agent_runtime_helpers.py:2365` (cache breakpoints at static/volatile boundary);
`tools/tool_output_limits.py:1-50` (50 000 B / 2 000 line caps) + `tools/tool_result_storage.py:1-35`
(spillover to `$HERMES_HOME/cache/spillover/{tool_use_id}.txt`, preview + path in context).

§2 Steer/stop: `tools/delegate_tool.py:266-285` (interrupt at iteration boundary, recurses to
grandchildren), `:290-334` + `:242-261,311` (steer a running child; missed steer preserved on
completion), `:403,466-560` (control plane: action ∈ list/steer/stop, ownership scoping
:380-426, stop returns interrupt_requested + partial result promised, `accepting_steer: True`
:215), `:78-105` (per-subagent approval callbacks); `tools/async_delegation.py:9-24,81-98,343`
(SQLite-persisted async delegations, completion queue surfaces when parent idle, 48 h retry,
orphan recovery); `tools/delegation_output_schema.py:1-30` (JSON-schema output contract, one
bounded retry); `tools/subagent_worktree.py` (git-worktree isolation); TUI steer modes
`tui_gateway/server.py:10051,10077-10079,2942`.

§3 Browser: `tools/browser_tool.py:1-30,2648-2805` (agent-browser CLI; backends: Browser Use
cloud / Browserbase / local Chromium; aria-snapshot `@e` refs; tools incl. `browser_vision`,
`browser_console`); `tools/browser_cdp_tool.py:1-15` (raw CDP passthrough);
`tools/browser_supervisor.py:1-15` (persistent CDP supervisor: dialogs, OOPIF frames);
`tools/browser_dialog_tool.py`; `tools/browser_camofox.py:1-12` + `browser_camofox_state.py:1-8`
(anti-detection backend + persistent profiles); `plugins/browser/{browser_use,browserbase,firecrawl}`;
`tools/computer_use/` (separate OS-level surface via external cua-driver).

§4 Microsoft: `tools/microsoft_graph_auth.py:1-50` (app-only client-credentials via
`MSGRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, `.default` scope, 120 s skew refresh);
`tools/microsoft_graph_client.py:46-69` (generic Graph client, pagination, 401 refresh);
`plugins/platforms/teams/adapter.py:1-16`; `plugins/teams_pipeline/meetings.py:1-20`;
`website/docs/user-guide/messaging/msgraph-webhook.md:1-40`. **Explicit negatives:** greps for
`sendMail`, `/me/messages`, `/me/drive`, `/me/events` return nothing — no personal-account
mail/calendar/OneDrive tools exist in this codebase.

§5 Cron memory: `cron/notepad.py:1-25` (per-job SQLite KV, prompt-injected, 16 KB/key /
64 KB/job); `cron/jobs.py:2233-2246` (`context_from` job chaining; workdir AGENTS.md
injection; script stdout as context); `cron/executions.py:1-21` (attempt ledger, immutable
terminal states, cap 1000); `cron/incidents.py:1-18` (dedup by `(job_id, error signature)`,
detected→alerted→closed); `cron/monitor.py:1-33` (hash-gated ticks, no_change suppression,
diff injection); `cron/suggestions.py:1-20` (one-tap acceptance, never auto-create);
`plugins/cron_providers/chronos/__init__.py:1-20` (external one-shot arming — non-goal).

§6 Collaboration: `tools/kanban_tools.py:1-17,898-973` (request_review → first-class review
phase + named reviewer profile, LLM-judge handoff gate at :943), `:977-1005` (request_changes
routes back); `website/docs/user-guide/features/kanban.md:44-52,64,280-305` (workers vs
anonymous children; comment threads as respawn context; block escalation, recurrence limit
default 2 → triage); `gateway/kanban_watchers.py:1-12`; `hermes_cli/goals.py:54-186`
(LLM goal judge: done/continue/wait); `agent/background_review.py:1-16`; `agent/curator.py:422,461-556`;
`website/docs/user-guide/features/mixture-of-agents.md:1-30` (MoA virtual provider — noted,
non-goal).

§7 Security: `tools/approval.py:1-10` (dangerous-pattern approval, smart auto-approve via aux
LLM, persistent allowlists); `website/docs/user-guide/security.md:16-33` (eight-layer model;
approvals smart|manual|off; cron_mode/single_query_mode/unattended_mode default **deny**);
`tools/tirith_security.py:1-20` (external pre-exec content scan, SHA-256-verified install,
fail_open config); `tools/threat_patterns.py:1-19` (shared injection/exfiltration regexes,
scoped all/context/strict, consumed by prompt_builder + memory_tool); `tools/write_approval.py:1-25`
(memory/skill write pending store); `tools/url_safety.py:1-15` (SSRF + DNS-rebinding
TCP-connect recheck, metadata blocked always); `tools/website_policy.py:1-10`;
`tools/plugin_guard.py:1-16` + `tools/skills_guard.py` + `tools/skills_ast_audit.py:1-10`;
`tools/environments/` (docker/modal/ssh/… backends) + `tools/credential_files.py:1-15`;
`website/docs/user-guide/egress/index.md:1-6` (egress proxy, opaque tokens — non-goal).

### A.2 Web sources (fetched 2026-09-01)

- **Reference releases:** `api.github.com/repos/NousResearch/hermes-agent` (repo pushed
  2026-09-01; homepage hermes-agent.nousresearch.com) + `/releases` — v0.21.0 "The Pantheon
  Release" (tag v2026.8.31): Bot Mode bundled default-on (#87886, #88243, #89386, #96726);
  `hermes peer` durable bot-to-bot DMs (#88725, #88178, #91487); cron continuity + notepad +
  monitor + bot-chat delivery (#91447, #80774, #81138, #81139); delegate_task live
  steer/stop/partial + schema validation + per-delegation cost (#85232, #81144, #81142);
  MCP command center (#87525); agent drives the desktop browser (#90197, #89366);
  protected-instruction-file write approval (#81152), deep redaction (#80965), Windows
  destructive-command approvals (#84428), macOS TCC signing (#95091); a2a message cards
  (#85855), delivery notices (#85888), Routines pane (#88731); reverted: /council, DCP
  context engine, WS-only gateway. Patches: v0.20.3 (2026-08-17) bot-mode plugin + teammate
  protocol; v0.20.4 (08-18) tabbed SESSIONS|BOTS sidebar + hide/unhide; v0.20.5 (08-21)
  group threads, foldable summaries, blob avatars, attachments; v0.20.6 (08-27)
  consent-gated real-profile browsing + web TTL cache + lean-tail default + keychain
  encryption; v0.20.0 (08-03) tail-guaranteed micro-compaction + tool-result pruning.
- **Grok:** `en.wikipedia.org/wiki/Grok_(chatbot)` — Grok Bot beta 2026-08-11, "AI
  teammates", shared cloud computer, bots message each other (**single source**); Grok Build
  (2026-05, Apache-licensed 2026-07-16); companions timeline. Reddit r/GrokBot RSS
  (2026-08-26→31, **unverified post titles**): Microsoft-accounts announcement (08-31),
  Cursor Pro bundling, bot.store marketplace, xbot.team instruction preview, meeting-prep→
  slides chaining, WhatsApp suspension warning. NOT confirmed: @grok in X group chats/DMs
  (help.x.com 403; Verge/TechCrunch searches empty).
- **Microsoft Graph:** `learn.microsoft.com/en-us/graph/auth-v2-user` (ms.date 2025-08-29)
  + `learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code` (2026-06-15;
  the `/azure/active-directory/develop/…` path times out — use `/entra/identity-platform/`).
  Delegated scope strings (`Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite`) are
  standard but **not verified on the fetched pages** — treat as implementation-time verify.
- **Browser control:** `raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md`
  (accessibility-tree snapshots; "coding agents increasingly favor CLI-based workflows
  exposed as SKILLs over MCP"; persistent profile default, `--extension`, `--cdp-endpoint`,
  `--caps vision`); `api.github.com/repos/browser-use/browser-use` (111.9 k stars).
- **Steering:** `code.claude.com/docs/en/sub-agents.md` (background agents, partial results
  marked partial + resume, steer panel, Ctrl+B); `raw.githubusercontent.com/openclaw/openclaw/
  main/docs/automation/tasks.md` (activity ledger lifecycle, cancel kills child,
  push-driven completion, 7-day prune); LangGraph `langgraph/types.py` (interrupt/
  Command(resume=…), checkpointer required, node logic re-executes on resume).
- **Token optimization:** `platform.claude.com/docs/en/build-with-claude/context-editing`
  (server-side compaction primary — `compact_20260112`; tool-result clearing
  `clear_tool_uses_20250919`: trigger 100 000 input tokens, keep 3 most recent tool pairs,
  clear_at_least, exclude_tools; thinking clearing) + `…/prompt-caching` (automatic caching,
  single moving breakpoint, 5-min/1-h TTL, ~512-token minimum) and
  `platform.openai.com/docs/guides/prompt-caching` (KV-tensor cache, up to 90 % discount).
- **Fetch failures this session:** help.x.com, techmeme (403); The Verge (JS-rendered
  empty); r/Twitter RSS (429); one MS Learn path + LangGraph docs site (timeout/redirect);
  Claude Code + Anthropic doc pages recovered via raw `.md` endpoints.

### A.3 August file:line index (this tree, verified 2026-09-01)

- Token/budget/compaction: `backend-py/app/services/workbench/token_budget.py:24,48,65,128-201`;
  `context_compressor.py:52,63,126,209,390,515,618`; `workbench.py:73,97,576,1723`;
  `providers.py:526,693-766,857,917`; `subagent.py:59-612`.
- Subagents: `subagent_orchestrator.py:57-101,206-265,310-322,444-468,515-609,786`;
  `subagent_worker.py:25-100`; `routers/subagent.py:272-283,327,414-459`; `routers/harness_mcp.py:109`;
  `tool_registrations/agent_tools.py:229`; `tools/spawn_subagents_tool.py:64-371,427-678`.
- Browser: `services/browser/session_manager.py:28-129`; `handlers.py:38-298`
  (allowlist `:106`, tools `:143-298`); `snapshot.py`; `element_resolver.py`;
  `tool_registrations/web_tools.py:31,108-162,395,443-533`; `routers/browser.py`.
- Integrations: `service_connections.py:29-105,126-145,147-249`;
  `integration_tools.py:5-9,57-80,99-201,204-310`; `routers/service_connections.py:25-102`;
  `routers/calendar.py:26`.
- Automations: `automations_store.py:1-50,110-229,490-516,575-621,764-822`;
  `scheduler.py:31-171,221-325`; `automation_gate.py:18-65`.
- Security: `sandbox/policy.py:71-150`; `hooks/sensitive_code.py`;
  `services/tool_policy.py`; `routers/mcp.py`; `tools/mcp_client.py`.
- Collaboration: `blackboard_service.py:21-169`; `code_review.py:84-302`;
  `background_review_service.py:36-58`.
