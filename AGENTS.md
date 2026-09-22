# Agent notes (August Proxy)

## Product surface

**The product is the Tauri desktop app** (`frontend/desktop/` + bundled `backend-py/`).

- Verify and ship fixes in the **desktop app**, not by treating August as a standalone browser/web product.
- `web-dist/` is the Vite build artifact that Tauri packages into the desktop shell (and that FastAPI can serve for local backend-only runs). It is **not** a separate “web app” to QA against for product work.
- Prefer `npm run dev:desktop` / packaged MSI·NSIS installs when checking UI + workbench behavior.
- Installed production builds copy bundled `backend-py` into AppData from the installer stamp — **desktop releases must include backend changes**, not UI-only rebuilds.
- Provider **baseUrl** is used exactly as pasted; August only appends the API format leaf (`chat/completions` / `v1/messages` / `responses` / `models`). It never invents `/v1` on the base — Anthropic’s format already includes `v1` in the leaf; OpenAI-compatible hosts include `/v1` in the paste when needed.

## Recent desktop fix (0.12.21)

**OpenCode / OpenAI-compatible gateways rejected chat with:**

`[400] session_id: Invalid input: expected string, received null`

**Cause:** `ChatCompletionRequest.model_dump()` forwarded `session_id: null` (and other nulls) upstream. Free DeepSeek Flash often still worked; stricter Console models failed. Test button used the same path.

**Fix (desktop-bundled backend + UI):**

- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — `exclude_none` + strip August-only keys before upstream calls
- Used by workbench chat, model Test button, and `/v1/chat/completions` · `/v1/messages` proxy adapters
- API format dropdown labels simplified to `chat/completions` / `messages` / `responses`

## Multi-format gateways (per-model apiFormat)

**OpenCode Zen** lists all models via `GET …/models`, but each family needs a
different wire path (`/chat/completions`, `/v1/messages`, `/responses`). One
provider-level `apiFormat` cannot serve Claude+GPT+DeepSeek from the same Zen
entry, so model entries may carry their **own** `apiFormat` (set in Model
settings → pencil-edit model → Wire format dropdown; the UI suggests
`v1/messages` for `claude-`-prefixed ids). The override wins over the provider
format and is honored by workbench chat, the Test button, Live/BTW, and the
`/v1` proxy adapters (OpenAI→Anthropic body+SSE translation exists for Claude
models reached via `/v1/chat/completions`). See `docs/TROUBLESHOOTING.md` and
`docs/CONFIGURATION.md`.

**No verifier gate exists (removed 2026-08-24).** There is no final-answer
review step, no verifier skill, and nothing that withholds answers — the
opt-in `verifierEnforced` gate, the `/api/workbench/verifier` endpoints, and
the `AUGUST_VERIFIER_REVIEWER` critic were removed by user request.
`update_state(phase=…)` exists purely as progress tracking, and
`run_command` still surfaces exit codes (zero included) in results.

**Harness budgets & self-correction** — `MAX_MANAGED_TOOL_ROUNDS` defaults to
**0 = uncapped** (a cap is opt-in via brain-config `maxWorkbenchToolLoops`;
the "defaults to 25" claim was stale since `38944632`). A turn whose
`update_state` phase/step never advances across 8+ stalled rounds gets a
reflection nudge, then hard-stops. Repetition is judged on a **canonical
sorted-key identity** of the call (reordered argument keys are not new work),
with a `(tool, target)` polling guard so re-reading one file at shifting
offsets counts as spinning, and an eight-family error taxonomy (`timeout |
rate_limit | auth | permission | not_found | network | invalid_argument |
process_exit`) that steers once per family even when each call differs. Every
`[Proxy Self-Heal]` reminder is runtime-only and says so, so it does not get
filed back as a durable memory. Every turn ends with a `turn_end
{reason, rounds}` event in the session log (`finished | length | cap |
stall-stop | error | interrupted | awaiting-input`) — read that before
auditing code for "why did it stop"; the same reason plus round/malformed/
downgrade/edit-verify/guardrail counters are persisted on the `turn_outcomes`
row (migration 046), where NULL means unrecorded, not zero. Numbers in this file that duplicate code
constants are guarded by `npm run check:docs`. Malformed tool JSON never executes as `{}` — the loop
returns a `[Validation Error] … Do NOT stop` self-heal and downgrades to the
bare tool surface after 3 consecutive failures. Stream rules flag
tool-call *narration* ("I'll use the X tool", code-fenced JSON) but defer
the verdict to end-of-turn: a flag is cancelled the moment a real tool
call arrives, and only a narration with NO tool call triggers the
reminder + retry. Per-model capability profiles
(`toolSurface` full/reduced/bare, `maxTools`, `maxToolResultChars` in Model
settings) are honored by both tool-definition paths and result truncation.
Routing evidence (`routing_evidence`) is written by the Arena/Debate verdict
endpoint (`POST /api/brain/routing/arena`, `source='arena'`) and read back by
`GET /api/brain/routing/arena` (archive) + `GET /api/brain/routing/suggestions`
(per-model win-rate ranking). There is NO automatic turn rerouting — the old
`AUGUST_AUTO_ROUTE` / `routingSuggestion`-SSE / per-turn auto-route claims were
never wired into the loop and have been removed (Part 25 Phase 4). Sub-agents
inherit the parent retry policy, compact mid-run, and support `yieldSchema` for
structured results.

**Durable memory** — the `<memory>` tail is BM25 over the brain `facts` table,
gated by brain-config `memoryAutoInject` (**default OFF**: recall happens when
the model calls `brain_query`). Two things are true regardless of that gate:
`kind='profile'` facts are an always-in lane (rendered first, ~600-char budget,
injected even with auto-inject off — this is what makes August remember *who
you are* without a keyword coincidence), and a fact dropped for budget is
**named** in a `recall partial:` line rather than vanishing. DB scopes are
`global` and `bot:<agentId>` only; `project:<path>` is refused at the write door
on purpose, because workspace memory is the separate `.aug/memory` markdown
layer that the tail already carries. `skill_delete` proposals, `patchSkill` and
the usage counter all key on `SKILL.md`, never on directory existence — skill
usage lives at `<dataDir>/skills/<name>/.usage.json` and the install tree must
stay free of it.

**Model-managed memory (CRUD is a set)** — `remember` (write/update by key),
`list_facts` (enumerate keys) and `forget` (retire) are all **core** tools: they
are in `AUGUST_CORE_TOOLS` so progressive disclosure can never hide the key
lookup that `remember`'s own instructions depend on, and in `_BARE_TOOL_ALLOW`
so a weak/downgraded model can still correct what it remembers instead of only
accumulating. `retrieve_relevant_facts(min_query_chars=…)` splits the two
callers: the automatic tail keeps the 8-character floor (a 4-character message
must not spend context), while a deliberate `brain_query(store='facts')` search
answers even for `"gpu"`. The boot memory index is **frozen per session** to
protect the provider prefix cache, so `<memory_policy>` tells the model to
re-read `list_facts` after writing rather than trusting that index — keep the
prompt text and that behaviour in step if either changes. Sub-agents read and
recall but never write; the parent turn is the single memory write door.

**Agent modes (0.12.55+)** — `set_agent_mode(chat|agent|code|orchestrator)`
(`planner` is an alias for `orchestrator`) switches the
session: `chat` blocks tool calls (text only), `agent` is native tool calling
(default), `code` executes a fenced ```python block through the existing
sandboxed `run_command` with a workspace-bound tool API (`read_file`,
`write_file`, `run_command`, `list_files` — see
`app/services/workbench/code_runner.py`), `orchestrator` dispatches workstreams
with no shell/edit.
`/v1/responses` supports `stream: true` via upstream-native pass-through.
(The former "loop-level golden evals in `tests/test_harness_evals.py` feeding
`GET /api/brain/harness/evals`" were removed; that file and endpoint no longer
exist — corrected Part 25 Phase 7.1.)

## Directory map & validation routing

| Area | Owns | Validate with |
|------|------|---------------|
| `backend-py/` | FastAPI proxy, workbench, Brain, MCP, tools | `cd backend-py && uv run pytest -q` |
| `frontend/desktop/` | Tauri shell, React UI, Vite build | `npm run test:frontend` |
| `frontend/mobile/` | Expo mobile app | `npm run test -w frontend/mobile` |
| `scripts/` | Build/release orchestration (Node) | manual — no test suite |
| `docs/` | User-facing docs, specs, troubleshooting | n/a |

**High-risk coordination points** (touch carefully, validate both layers):

- Version files (see below) — must stay in sync across all 8 checked desktop sources.
- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — upstream serialization; a wrong key breaks all chat.
- `backend-py/app/services/sandbox/` — permission policy; changes affect tool execution safety.
- `_executeTool` hash-anchored edits + `toolDefinitions`/`openaiToolDefinitions`
  capability filtering — both wire formats must stay in sync.
- `adapters/stream_state.py` `AnthropicNativeStreamState` — tool_use input
  accumulation; a regression re-runs managed tools with empty args.

**Fast path for backend-only changes:**

```bash
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q
```

## Version files to bump together on desktop ship

All 8 sources must match (`scripts/check-version-sync.mjs` verifies):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (august-desktop entry)
- `package-lock.json` (root + `packages['frontend/desktop']`)
