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

**Harness budgets & self-correction (0.12.55)** — `MAX_MANAGED_TOOL_ROUNDS`
defaults to 25 (brain-config `maxWorkbenchToolLoops` overrides); a turn whose
`update_state` phase/step never advances across 8+ rounds gets a reflection
nudge, then hard-stops. Malformed tool JSON never executes as `{}` — the loop
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

- Version files (see below) — must stay in sync across 4 files.
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

All 7 sources must match (`scripts/check-version-sync.mjs` verifies):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (august-desktop entry)
- `package-lock.json` (root + `packages['frontend/desktop']`)
