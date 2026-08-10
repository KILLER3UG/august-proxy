# August Proxy — Changelog

## 0.14.0 (2026-08-10)

Personal-assistant memory, harness model-agnosticism, and cache observability.

**Memory — a real user model**
- Deterministic preference capture: "I prefer X" / "my favorite Y" / "never Z"
  folds into the user profile the same turn (no LLM); communication-style
  inference; structured `<user_profile>` prompt block; stale facts excluded.
- In-chat 🧠 memory notices when August remembers / updates / forgets /
  learns a preference.
- Memory browse by project (Settings → Project Memories); `source_session_id`
  serialized + folder/session filters.
- Vector hybrid recall (FTS + embeddings); consolidation sleep cycle archives
  stale auto-memories (deterministic guard + timeline trail); per-model
  memory injection budgets (32k gets half of a 128k model's payload);
  `session_topics` finally written; cross-session recall in memory_search +
  recent-chat titles in Tier 3.

**Harness — handles every model**
- Text tool protocol: `toolSurface='text'` or automatic downgrade after a
  second refusal — non-tool-calling models work via `[TOOLCALL] name|json`.
- Tolerant JSON salvage (fences/prose/truncation) before self-heal rounds;
  sub-agent malformed-JSON parity; refusal detection with one reminder retry.
- Graded turn outcomes (error | refusal | thinking_only | tool_error |
  verified | ok) feeding routing evidence; per-turn trace store + model drift
  alerts; per-model capability fingerprints → automatic profile suggestions.
- Universal prompt caching: Anthropic `cache_control` breakpoints on every
  Anthropic-format call; OpenAI-compatible prefix stability; cache hit rate
  captured from both wire formats and shown in the context ring.

**Chat UX**
- Streaming scroll fix: you can scroll up and read while the model works.
- In-thread search jumps through the virtualizer; error blocks gain
  Retry / Switch model; styled confirm dialogs everywhere; grouped task
  sections; @conversation mentions; sub-agent reasoning effort; recurring
  tasks with custom models; automation minute presets + model/agent display;
  reconnect transcript hydration (no more blank conversations).

**Under the hood**
- Tool-loop caps wired (`maxWorkbenchToolLoops`), fallback-chain wire-format
  recompute, hardline `sed -i`/`find -delete` guard, sandboxed cron jobs,
  verifier asymmetries fixed, npm audit critical fixed (desktop workspace 0
  vulnerabilities), pytest-timeout, ~60 new tests.

## 0.13.1 (2026-08-09)

Bug fixes and pipeline completion since 0.13.0:

**Context & warnings**
- Fixed the false "⚠️ Context window nearly full" alarm — the backend emits a
  `contextPressure` frame every turn as a live meter; the warning now appears
  only on genuine high/critical pressure (a fresh session no longer screams
  "999,805 tokens left").
- SSE `lastSeq` is persisted by the per-turn stream consumer, so reconnects
  (mid-stream reload, auto-turns) resume from the right position instead of
  replaying from zero.

**Sub-agents**
- Background sub-agent completions that settle after the parent turn now
  trigger a coalesced, capped auto-turn — the parent model actually receives
  the result instead of waiting for the next user message.
- Live sub-agent output (text / tool calls / tool results) streams to the
  chat instead of only start + done.
- `subagentStart` carries the parent tool-use id, so nested checklist rows
  render under the parent tool call.
- Honest statuses: `error` / `blocked` / `partial` / `recovered` pass
  through instead of masquerading as `completed`; failure reasons are shown.
- `spawn_subagents(mode='proposed')` shows an inline approval bar above the
  composer (Launch / Reject).
- Provider calls and orchestrator slots have timeouts — hung workers can no
  longer block all spawns forever. Clean tool-only sub-agents no longer
  tally as failures. API agent jobs appear in the Runs tab. Recurring-task
  sub-agents are concurrency-capped.
- Durable per-session SSE subscriber wired (subagent/browser/queue events
  stay visible across tab switches; app-global focus/visibility resync).

**Sessions & modes**
- `agentMode` (chat/agent/code) and `turnCount` persist across restarts.
- Entering plan mode no longer permanently clobbers the agent role — it is
  stashed and restored on exit.
- Queued messages drain in arrival order (steers no longer jump the queue at
  send time; steer priority is applied when the turn is formatted).
- Stop button no longer inserts a dummy user turn on idle sessions.
- Removed the inert automatic sub-agent git-worktree creation (tool dispatch
  is workspace-bound); the manual worktree endpoint remains.
- Interactive terminal input in a workspace-bound terminal gets the same
  soft sandbox as one-shot commands (navigation and single-token inputs
  pass through).

**Integrations**
- MCP servers can now be edited in place (`PATCH /api/mcp/servers/{id}` +
  Edit-config form in Settings → Integrations); add/remove/start/stop were
  already available.

**Performance**
- Backend cold start: `httpx` is fully lazy-imported (zero imports while
  the app module loads).
- Frontend bundle: katex, xlsx, xterm, highlight.js, marked/mammoth and
  zod/zustand split into their own cached chunks — the main entry dropped
  from 2.58 MB to 0.69 MB.

**Reliability dashboard**
- Harness eval pass-rate trend strip (per-day bars) above the eval history,
  alongside the existing Run-now button and 6h auto-run loop.

**Internal cleanup**
- UTC-consistent cutoffs in memory lifecycle / friction / trends (were
  naive-local ISO compared against SQLite UTC timestamps — shifted windows).
- Skill quality scoring parses epoch-float and ISO timestamps (effectiveness
  and freshness previously never scored).
- Removed the legacy `/api/subagents/stream` endpoint, worker dead-letter
  bus topics, and the dead SubagentPanel/useSubagentStream frontend chain.
- Cron parsing consolidated onto one implementation; duplicate `_BRAINStores`
  catalog removed.
- Release script prefers the current-version artifact and cleans stale
  bundles; all demo/mock data removed from fresh installs.

## 0.13.0 (2026-08-08)

- Harness budgets & self-correction: managed tool-round caps, stall
  detection, malformed-JSON self-heal with tool-surface downgrade, stream
  rules that abort narrated tool calls, per-model capability profiles
  (`toolSurface`, `maxTools`, `maxToolResultChars`).
- Evidence-driven auto-routing v2: routing evidence records real outcomes,
  `routingSuggestion` SSE events, opt-in auto-route with flap guard.
- Agent modes: `set_agent_mode(chat | agent | code)` with the sandboxed
  fenced-python code runner.
- Verifier gate with deterministic receipts; optional one-shot reviewer
  critique; golden eval harness with scheduled 6h loop.
- Multi-agent teams, Agent Board workspace tab, Runs retry/cancel/resume,
  sub-agent launcher, debate presets.
- AI Setup wizard, Data & Privacy center, Health simulator, Arena replay +
  archive, Scheduled golden evals.
- Prompt templates, in-thread search, PDF export, edit history, provider
  availability, onboarding, daemon control.
- Full-repo sweep: P0 sandbox escape + regenerate-wipe fixes, 30+ P1 fixes,
  dead code and test cleanup (1367 backend tests, 736 frontend).
