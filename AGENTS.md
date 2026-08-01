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

**Verifier enforcement is opt-in per session** (`verifierEnforced`, composer
shield toggle / session creation). While on, the final answer is withheld
until `update_state(phase='complete')` passes; a `verifierBlocked` SSE event
drives the amber banner. Casual chat (flag off) is unaffected.

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

**Fast path for backend-only changes:**

```bash
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q
```

## Version files to bump together on desktop ship

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
