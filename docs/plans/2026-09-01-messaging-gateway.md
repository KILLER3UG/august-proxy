# Part 20 — Messaging Gateway: August present in chat platforms

Status: **Phase 0 (trust gate) IMPLEMENTED 2026-09-02 (committed cb626b40)** — allowlist
(`gateway.allowedUsers` config + `{PLATFORM}_ALLOWED_USERS` env, default-deny),
pairing codes (8-char CSPRNG, salted-SHA-256 storage, 1 h TTL, rate limits,
per-platform lockout after 5 failed approvals), group silence, and the
`/api/gateway/pairing*` endpoints (`app/services/gateway/pairing.py`, gate in
`base.dispatch` before the bypass-command check, `tests/test_gateway_pairing.py`
13 tests). **Rulings recorded 2026-09-04 (§6): OQ1–OQ5 all approved as recommended.**
Per the dossier: OQ1 = Telegram only for v1; OQ2 = long-polling default, webhook opt-in —
**already the shipped behavior** (`telegram.py:102-162`), no action; OQ3 = mentionOnly;
OQ4 = `full` guard in paired-owner DMs + Phase 6 `reduced` toolSurface + plan-mode in
groups, **never `ask` until remote approval cards exist** (desktop-only approval prompts
would soft-lock remote turns), plus the cheap hardening of stamping `neverAsk` approval
metadata on gateway sessions (landed with the 2026-09-04 S-1 rider — headless/DM run
contexts consult the unattended policy); OQ5 = `/tts` per-chat opt-in. Written 2026-08-31/09-01
against the
installed reference implementation (Appendix A, file:line) and this repo's
tree. **Implementation status (corrected 2026-09-02):** the skeleton + platform
adapters + tests are already live and green (`backend-py/app/services/gateway/
{base.py, session_bridge.py, runner.py, platforms/*}`, `routers/gateway.py`,
4 test suites). Scope note: in the reference product this is the
**gateway/messaging** feature — distinct from its "Bot Mode", which is the desktop roster of
named Bots and is planned separately in `2026-09-01-bot-mode.md` (Part 19).

Design target: the user chats with August from Telegram (then Discord/Slack) the way one chats
with a person — instant-feeling replies that stream live into the chat, voice notes understood,
photos looked at, files sent back, scheduled briefings delivered unprompted, and a personality
that is the same August they know from the desktop. The desktop app remains the cockpit: pairing
approvals, platform setup, and the transcript of every bot conversation all live there.

---

## 1. What "bot mode" means, mechanically

A bot mode is five mechanisms bolted onto an existing agent loop. Everything else is polish:

1. **Ingress** — a long-lived listener per platform (Telegram long-poll, Discord gateway WS)
   normalizes inbound payloads into one internal `MessageEvent` shape.
2. **Session identity** — a deterministic key per conversation (`platform:chat[:user]` in groups)
   mapped 1:1 onto a real agent session, so context persists across messages and restarts.
3. **Serialization** — one in-flight agent turn per conversation; later messages queue; control
   commands (`/stop`, `/new`) bypass the queue and cancel the running turn.
4. **Egress** — replies must survive platform limits (length, markdown dialect) and feel live
   (progressive edit of one message while the turn runs, typing indicator, final edit).
5. **Trust** — default-deny: only paired/approved users may command the agent; the agent's
   outbound messaging is handled outside the tool loop (the model never gets a raw "send message
   to anyone" tool).

Proactive delivery (cron results, background-process completions pushed into a chat) is the
feature that turns "remote control" into "companion", and it needs a durability ledger so a
restart never silently drops or double-sends an answer.

## 2. Current state in this repo (verified)

August already has a working skeleton — it was modeled on the reference gateway and covers
mechanisms 1–3:

| Piece | File | State |
|---|---|---|
| Base adapter: queue, bypass cmds, session key | `backend-py/app/services/gateway/base.py` | works; `buildSessionKey` gives per-user group sessions (`base.py:61-69`); `/stop /new /reset /approve /deny /status` (`base.py:28`) |
| Session bridge → workbench | `backend-py/app/services/gateway/session_bridge.py` | works; maps key→workbench session, persists `gateway/session_map.json` + `metadata.gatewayKey` (`session_bridge.py:95-133`); runs turns via `sendWorkbenchMessageStream` (`workbench.py:2299`) |
| Runner + config | `backend-py/app/services/gateway/runner.py` | works; boots from `config.json → gateway` (`runner.py:42-68`), wired in lifespan `main.py:186-191` |
| Telegram adapter | `backend-py/app/services/gateway/platforms/telegram.py` | webhook w/ secret-token verify (`telegram.py:94-132`) + long-poll fallback (`telegram.py:139-162`); **text-only** — non-text messages dropped at `telegram.py:188-190` |
| Slack / Discord adapters | `platforms/slack.py`, `platforms/discord.py` | present, optional SDKs (`pip install -e ".[gateway]"`) |
| Routes | `backend-py/app/routers/gateway.py` | `POST /api/gateway/telegram/webhook`, `GET /api/gateway/status` |
| Tests | `tests/test_gateway_base.py`, `test_gateway_telegram.py`, `test_gateway_final_output.py`, `test_gateway_status_availability.py` | green |

Primitives that already exist and get reused (no new subsystems):

- **Per-delta text events already flow to the bridge.** `sendWorkbenchMessageStream` emits
  `finalOutput` chunks batched at 256 chars / 12 ms with immediate first flush
  (`app/lib/batched_emit.py:24-39`, call site `workbench.py:3207-3226`); the bridge's
  `onEvent` parameter (`session_bridge.py:140`) is plumbed but **unused** — the consumer for
  live chat editing can be built entirely gateway-side.
- **STT + TTS**: `app/services/live_speech.py` (`transcribe_audio` :72, `synthesize_speech` :122).
- **Scheduled agent turns**: `automations_store.py` job types `shell|workbench|http|noop`
  (`automations_store.py:37`), ticker in `scheduler.py:171`.
- **Personas**: agents carry `role`/`description`/`toolsets`/`model` (`routers/agents.py:24-36`);
  the bridge already accepts `agentId` (`runner.py:49`).
- **Capability profiles**: per-model `toolSurface` full/reduced/bare (0.12.55 harness work).

Gaps (each becomes a phase below): no authz at all (anyone who can DM the bot commands a
full-tool workbench session on the user's machine — and `/approve` is in the bypass set,
`base.py:28`); no length chunking (a >4096-char reply 400s at the Telegram API and the answer
is lost); no markdown dialect handling; no streaming; no media in/out; no proactive delivery
path; no UI (the settings "Gateway" section is the *proxy* API key — `ExternalAccessSection.tsx`
— a naming collision); disabled by default with no config surface.

## 3. Phases

Every item lists its score: **[bug]** verified defect, **[num]** measured/known number it
improves, **[rel]** reliability, **[feat]** capability that earns its place. Items that fail
the value check are in §5 Non-goals instead.

### Phase 0 — Trust gate (ship blocker; nothing else enables until this lands) [bug]

Verified defect: `dispatch()` (`base.py:113-126`) runs any sender's text through the agent with
`guardMode` from config (default `full`, `runner.py:51`), and `/approve`/`/deny` bypass the
queue (`base.py:180-195`) — a stranger who discovers the bot username can approve workbench
plans and drive tools on the user's PC.

Spec:

- **Allowlist, default-deny.** `gateway.allowedUsers: {platform: [user_id…]}` in config.json +
  env `{PLATFORM}_ALLOWED_USERS` (comma list). Check in `BasePlatformAdapter.dispatch` before
  anything else; unauthorized → optional canned reply, else silence.
- **Pairing codes.** Unknown DM while `gateway.pairing: true` → bot answers "pairing code
  `XKQP7HBM` — approve it in August → Settings → Bot mode". Codes: 8 chars from unambiguous
  32-char alphabet (no 0/O/1/I), CSPRNG, stored as salted SHA-256 (never plaintext), TTL 1 h,
  1 request per user per 10 min, max 3 pending per platform, lockout 1 h after 5 failed
  approvals, store `0600`. Approval endpoint `POST /api/gateway/pairing/approve` consumes the
  code and appends the user id to the allowlist in config.json (live effect, no restart).
  Revocation: `DELETE /api/gateway/pairing/users/{platform}/{user_id}` + UI list.
- **Group chats**: unauthorized users in a group are silently ignored (never issue codes in
  groups — that leaks pairing into public channels).
- **Webhook hardening stays** (secret token verify, `telegram.py:117-132`); polling mode is
  the desktop default (§OQ2) since the desktop sits behind NAT.

Tests: pairing lifecycle (issue/approve/expire/lockout/rate-limit), allowlist precedence,
group silence, `/approve` from unpaired user rejected. Files: new `app/services/gateway/pairing.py`,
`base.py` dispatch guard, `routers/gateway.py` endpoints, `tests/test_gateway_pairing.py`.

### Phase 1 — Delivery correctness [bug]

Verified defects: `sendMessage` posts raw text with no length guard (`telegram.py:164-175`,
same pattern in `discord.py:117`, `slack.py:127`) — Telegram caps at 4096 chars, Discord 2000;
long agent answers fail silently today. Markdown from the model renders as literal noise on
Telegram (needs MarkdownV2 escaping) and Slack (needs mrkdwn).

Spec:

- `splitMessage(text, limit)` — paragraph-first, then line, then word; code-fence-aware (never
  split inside a fence; if a fence exceeds the limit, close+reopen it). Adapter declares
  `maxMessageLength` (4096/2000/4000).
- Per-platform formatter: Telegram MarkdownV2 escape set; Discord keeps MD but escapes @everyone/@here;
  Slack converts `**`→`*`, links to `<url|text>`. Fallback: on a parse-mode 400, resend as plain text.
- Reply anchoring: first chunk `reply_to_message_id` the user's message (already plumbed,
  `telegram.py:166-168`); subsequent chunks plain.
- Typing indicator: Telegram `sendChatAction` refreshed every 4 s while a turn runs; Discord
  `channel.typing()` context. Start on dispatch, stop on final send.

Tests: splitter property tests (fences, CJK, limit±1), formatter golden strings, 400-fallback
path. Files: new `app/services/gateway/formatting.py`, `base.py` send path, adapter edits.

### Phase 2 — Live streaming into the chat [num: perceived TTFT from minutes → ~1 s]

Today the user waits the whole turn (multi-minute tool loops) for one message. The bridge
already receives per-delta `finalOutput` events via `onEvent` (`session_bridge.py:140,148-158`)
and discards them. Spec a gateway-side consumer mirroring the reference design:

- **Progressive edit**: buffer deltas; every `edit_interval` (default 1.0 s) edit the in-flight
  chat message to `accumulated + " ▉"` cursor. Adaptive backoff: on flood-control 429, double
  the interval (cap 10 s); after 3 strikes disable edits for the rest of the stream and send
  the final as a fresh message. Skip redundant edits (text unchanged since last send).
- **Segment breaks**: a `toolCall`/`toolResult` boundary flushes the current message and starts
  a new one, so tool chatter never rewrites delivered text. Optional `toolProgress: concise`
  mode posts one status line per tool ("running tests…") — default on, off via config.
- **Final edit** applies platform formatting (Telegram only formats correctly on final edit —
  adapter flag `requiresEditFinalize`).
- Config: `gateway.streaming: true`, `gateway.streamingEditIntervalS`, `gateway.toolProgress`.

Tests: fake-clock consumer (edit cadence, backoff doubling, strike-out, fence-safe flush),
integration test through `SessionBridge` with a scripted runner emit sequence. Files: new
`app/services/gateway/stream_consumer.py`, `session_bridge.py` (pass `onEvent`), `base.py`.

### Phase 3 — Voice and media [feat: messaging without a keyboard is the point of bot mode]

Inbound (normalize() currently drops everything non-text, `telegram.py:188-190`):

- **Voice notes / audio**: download (size cap 20 MB), `live_speech.transcribe_audio`, transcript
  becomes the turn text with prefix `[voice note] `; optional echo of the transcript back
  (`gateway.sttEchoTranscripts`, default off). Failure → `[voice message could not be
  transcribed]` turn note, never a silent drop.
- **Photos**: download to `dataDir/gateway/media/<chat>/`, turn text gets
  `[image attached: /abs/path]` and the agent reads it with existing vision/file tools
  (same pattern as the camera-snapshot flow). Size cap + extension whitelist.
- **Documents**: save to the session workspace + context note ("user sent report.pdf at
  <path> — extract it with your tools").

Outbound:

- **`MEDIA:<abs-path>` directive**: the final assistant text is scanned for `MEDIA:` tags
  (whitelisted extensions, path must resolve under an allowed dir — workspace ∪ gateway media
  dir ∪ temp; strict mode default). Tags are stripped from displayed text; the file is sent
  via `sendDocument`/`sendPhoto`; audio files route as voice notes (Telegram `sendVoice` needs
  Ogg/Opus — transcode via ffmpeg when available, else document).
- **`/tts on|off` per chat**: when on, the final reply is also synthesized through
  `live_speech.synthesize_speech` and sent as a voice note. Persisted per chat id.

Tests: normalize() for each media type (fake payloads), path-traversal rejection on MEDIA:,
transcode fallback, TTS toggle persistence. Files: `base.py` (media pipeline), adapters
(send_document/send_photo/send_voice), `session_bridge.py` (attachment context lines).

### Phase 4 — Proactive delivery: cron, automations, completions [feat: the companion half]

August already runs scheduled workbench jobs (`automations_store.py:37`) whose results land
only in the desktop. Spec:

- **Delivery targets**: job gains `deliver: "telegram:<chat_id>" | "home" | ""`. Home channel
  set in UI (`gateway.homeChannel`), resolved at send time. New
  `app/services/gateway/delivery.py`: `deliver(text, target)` routes to a live adapter or
  records failure; truncates to `MAX_PLATFORM_OUTPUT = 4000` with "…(truncated, full result in
  August)" footer; suppresses delivery when the job output is exactly `[SILENT]`.
- **Delivery ledger** [rel]: durable obligation rows (SQLite, `dataDir/gateway/ledger.db`) —
  `pending → attempting → delivered | failed`. On boot, sweep: `pending` rows resend plainly;
  `attempting`/`failed` resend with a visible `⟳ recovered reply` marker (honest at-least-once,
  never silent duplicates). Caps: 3 attempts, 24 h stale, 7 d retention.
- **Completion wake**: when a background process or subagent run tied to a gateway session
  finishes, deliver a short notification into that chat via the same ledger path (reuse
  `agent_message_bus` / hooks — wire, don't rebuild).
- `/remind me to …` needs no new subsystem: it is the existing automations store with a
  `deliver` field; the bot-mode prompt hint tells the model the tool exists.

Tests: ledger crash-resume matrix (kill at each state), home-channel resolution, [SILENT],
truncation footer. Files: new `delivery.py`, `ledger.py`, `automations_store.py` (deliver
field), `scheduler.py` hook.

### Phase 5 — Desktop UI: Settings → Bot mode [feat: currently unreachable without hand-editing config.json]

- New settings section **"Bot mode"** (Data and statistics hub? no — Agent capabilities hub,
  beside Automations): enable per platform, paste bot token (stored `.env`, never config —
  same rule as provider keys), pairing queue with approve/deny, allowed-users list, home
  channel picker (list recent chats from `GET /api/gateway/chats`), streaming/tool-progress
  toggles, per-chat TTS list.
- Rename the existing "Gateway" surface copy to **"External API access"** in UI strings only
  (route ids unchanged) to kill the collision with chat-gateway.
- Gateway sessions appear in the desktop chat list titled `Telegram · <chat name>` (session
  factory already supports titles via `task` param, `sessions.py:887-888`; bridge passes
  platform+chat name on create) with a small platform badge; opening one shows the same
  minimal-output transcript as any chat — because it *is* a normal workbench session.
- `GET /api/gateway/status` extended: per-adapter connected, last inbound, pending pairings,
  ledger depth. Poll in the section (reuse the store pattern from `store/gateway.ts` — rename
  that store `proxyGateway.ts` for clarity).

Tests: vitest for the section (pairing approve flow, token save redaction); tsc clean.
Files: `frontend/desktop/src/sections/settings/BotModeSection.tsx`, settings-registry entry,
`routers/gateway.py`.

### Phase 6 — Persona + chat-safe tool surface [feat: same August personality in chat; smaller blast radius]

- Bot sessions bind to an **agent** (`gateway.agentId`, already plumbed `runner.py:49`); the
  agent's `role`/`description` is the persona. UI: dropdown of existing agents in the Bot mode
  section. No new persona subsystem.
- **Chat tool surface**: gateway-created sessions default to `toolSurface: reduced` (no
  desktop-automation, no browser-takeover tools; files/commands/memory/skills stay) — reuse
  the 0.12.55 capability-profile mechanism, set at session create in `session_bridge.py`.
- **Platform hint line**: one sentence in the session's system context ("You are answering in
  a Telegram chat; keep replies short; send files with MEDIA:<path>") — appended to the
  session goal, not the frozen system block (prompt-cache rule from the 08-29 cache work).

Tests: reduced surface honored on a gateway session; hint present in first turn only.

## 4. Order and gates

Phase 0 is a hard gate (never enable a platform without it). 1→2→3 are one adapter's
completion arc; 4 and 5 can parallel after 1; 6 last. Each phase ships with tests green
(`uv run pytest -q tests/test_gateway*`), ruff+mypy clean, and a desktop smoke: real Telegram
bot, one pairing, one streamed reply.

## 5. Non-goals (value check failed — recorded so they don't creep back)

- **WhatsApp / Signal**: no official bot API without business approval / daemon bridging;
  adapter base makes them addable later. Cut.
- **Relay / multi-tenant connector** (Appendix A.10): solves server-fleet hosting; August is
  a desktop app that dials out directly. Cut.
- **Scale-to-zero / Fly self-suspend**: cloud-deploy concern, irrelevant locally. Cut.
- **Multi-agent "bot rooms"** (several personas in one group chat, Appendix A.6): genuinely
  cool, but it is a multi-agent orchestration feature, not bot mode; August's subagents cover
  the useful half. Deferred — separate plan if ruled.
- **Kanban dispatcher** (board-driven worker spawning, Appendix A.4): overlaps August's
  automations + subagents; revisit only if dogfooding demands it. Deferred.
- **Token-level SSE plumbing changes to the workbench**: unnecessary — BatchedEmit already
  delivers ~256-char deltas to the bridge (§2). No workbench edits in this plan.

## 6. Open questions — need rulings

> **RULING RECORD (2026-09-04) — user approved the OQ dossier
> (`2026-09-04-oq-recommendations.md`) as recommended.**
>
> - **OQ1 — Ruled: Telegram only** for v1 (the only unconditionally-registered adapter,
>   `routers/gateway.py:27-38`; Slack/Discord need the optional `[gateway]` extra).
> - **OQ2 — ALREADY THE SHIPPED BEHAVIOR**: long-polling default, webhook opt-in when
>   `baseUrl` is set (`telegram.py:102-162`). No action. Hardening note carried: the poll
>   loop hard-stops after 5 consecutive failures (`telegram.py:159-161`) — adopt a resilient
>   restart if that bites in dogfood.
> - **OQ3 — Ruled: mentionOnly** group policy (respond only to @mention / reply-to-bot /
>   slash command; matches Phase 0's fail-closed posture, `pairing.py:224-236`).
> - **OQ4 — Ruled: `full` in paired-owner DMs** (the allowlist IS the authz boundary) +
>   Phase 6 `reduced` toolSurface + plan-mode in groups. **Never `ask` until remote approval
>   cards exist.** The cheap hardening (stamp `neverAsk`/unattended approval metadata on
>   gateway run contexts) landed with the 2026-09-04 S-1 rider (`_approval_never_ask` now
>   consults headless run contexts).
> - **OQ5 — Ruled: `/tts` per-chat opt-in**, persisted per chat id; mp3-as-document first,
>   Ogg/Opus when ffmpeg is present.

## 7. Verification / measurement

- Evals: extend `tests/test_harness_evals.py` pattern with a scripted gateway scenario
  (fake adapter → bridge → scripted model): pairing → message → streamed edits → final.
- Dogfood gate: run the Telegram bot against a free model for a week; success = replies feel
  live (first visible token < 2 s), zero lost long replies, zero unpaired commands executed.
- Telemetry: `perf_timing` already traces `gateway_invoke` (`session_bridge.py:169-173`);
  add TTFT-to-first-chat-edit span.

---

## Appendix A — Provenance only (external systems; not needed to implement)

### A.1 Reference implementation (Hermes Agent, Nous Research — installed copy scanned
`%LOCALAPPDATA%\hermes\hermes-agent`, all claims spot-verified at line level 2026-08-31)

- Gateway = one process for all platforms: `gateway/run.py:32501` `main()` → `start_gateway()`
  (:31710); `GatewayRunner` composes authz/kanban/slash mixins (:7002); shares `state.db` with
  CLI/desktop (`hermes_state.py:362`); desktop is Electron spawning headless `hermes serve
  --port 0` per profile (`apps/desktop/electron/main.ts:12017`).
- Pipeline `_handle_message` (`gateway/run.py:17506`): auth → commands → interrupt → session →
  context → agent → response; ContextVar session identity (`gateway/session_context.py`).
- Streaming: `gateway/stream_consumer.py` — deltas → queue → async task edits one message;
  `edit_interval 0.8 s`, buffer threshold 24, cursor `" ▉"` (`gateway/config.py:768-770`);
  adaptive doubling to 10 s, 3 flood strikes → edits off (`stream_consumer.py:205-207,3430`);
  Telegram final-edit formatting flag + MarkdownV2 (`plugins/platforms/telegram/adapter.py:615-620`).
- Sessions: `build_session_key` SoT (`gateway/session.py:1090-1213`), per-user group isolation
  default, reset policies daily/idle (`gateway/config.py:554-556`), turn lease serializing
  load→run→flush (`gateway/turn_lease.py:1-48`).
- Pairing: 8-char unambiguous alphabet, salted SHA-256, TTL 1 h, 1/10 min, 3 pending, 5-fail
  lockout (`gateway/pairing.py:45-58`); authz order allow-all→env→pairing→deny
  (`gateway/authz_mixin.py:383-400`); slash ACL second axis (`gateway/slash_access.py:1-33`).
- Toolsets: all platforms share core tools; **no agent-callable send_message** — outbound is
  gateway-side (`toolsets.py:410-416`); per-platform bundles (:489-560).
- Media: inbound caps + STT auto-transcribe (`gateway/run.py:25870-25990`), image placeholders
  for vision (:3270-3286), sticker vision-describe + cache (`gateway/sticker_cache.py`);
  outbound `MEDIA:<path>` tags + strict path policy (`gateway/platforms/base.py:1986-2181`,
  `gateway/media_policy.py`), ffmpeg → Ogg/Opus voice notes (`base.py:68-72`).
- Proactivity: `gateway/wake.py` synthetic internal events resume sessions; cron ticker in
  gateway (`run.py:31437`), `_deliver_result` prefers live adapters (`cron/scheduler.py:3069`);
  `gateway/delivery.py` target routing + `MAX_PLATFORM_OUTPUT=4000` (:24-29); delivery ledger
  at-least-once with `RECOVERED_REPLY` marker (`gateway/delivery_ledger.py:14-45`).
- Hooks: `~/.hermes/hooks/<name>/HOOK.yaml+handler.py`, events `session:*`, `agent:*`,
  `command:*`, `pre_gateway_dispatch` skip/rewrite/allow (`gateway/hooks.py:1-40`,
  `run.py:17604-17640`).
- Personality: `SOUL.md` one-paragraph brevity doctrine (runtime + repo byte-identical);
  three-tier cache-stable system prompt — stable/context/volatile, skills index first in
  volatile, date-only timestamp (`agent/system_prompt.py:435-448,883-906,946-1000`); stored
  prompt reused verbatim per session for prefix-cache hits (`agent/conversation_loop.py:915-1045`).
- Profiles: fully isolated homes under `profiles/<name>/`; `profile_routes` multiplex one
  gateway across personas (`docs/profile-routing.md`); "bot rooms" = group chats of several
  profiles (`profile.yaml → ui_meta.hermes-bots`, e.g. a 6-agent trading desk with moderator).
- Kanban: shared `kanban.db`, gateway dispatcher spawns `hermes -p <assignee> chat -q` per
  ready task, claim locks + failure circuit breaker, `review_dispatch` auto-claims review
  column (`hermes_cli/kanban_db.py:1333-1427`, `config_defaults.py:2800-2824`).
- Self-improvement shared across surfaces: post-turn background-review fork writes
  memory/skills (`agent/background_review.py:1-15`), idle curator (`agent/curator.py:1-20`),
  learning graph for desktop (`agent/learning_graph.py:1-14`).
- Relay (`gateway/relay/`): WS-out to a multi-tenant connector owning platform SDKs;
  capability descriptor; HMAC auth; trust flag `delivered_via_upstream_relay`.

### A.2 Grok bot research

Live web sources were unreachable on 2026-09-01 (timeouts/CAPTCHA); pattern notes are in
`2026-09-01-bot-mode.md` Appendix A.2. The Grok-bot UX patterns this plan encodes: instant
perceived response (Phase 2), media-native conversation (Phase 3), unprompted delivery
(Phase 4), personality-forward replies (Phase 6).
