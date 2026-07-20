# Agent notes (August Proxy)

## Product surface

**The product is the Tauri desktop app** (`frontend/desktop/` + bundled `backend-py/`).

- Verify and ship fixes in the **desktop app**, not by treating August as a standalone browser/web product.
- `web-dist/` is the Vite build artifact that Tauri packages into the desktop shell (and that FastAPI can serve for local backend-only runs). It is **not** a separate “web app” to QA against for product work.
- Prefer `npm run dev:desktop` / packaged MSI·NSIS installs when checking UI + workbench behavior.
- Installed production builds copy bundled `backend-py` into AppData from the installer stamp — **desktop releases must include backend changes**, not UI-only rebuilds.

## Recent desktop fix (0.12.21)

**OpenCode / OpenAI-compatible gateways rejected chat with:**

`[400] session_id: Invalid input: expected string, received null`

**Cause:** `ChatCompletionRequest.model_dump()` forwarded `session_id: null` (and other nulls) upstream. Free DeepSeek Flash often still worked; stricter Console models failed. Test button used the same path.

**Fix (desktop-bundled backend + UI):**

- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — `exclude_none` + strip August-only keys before upstream calls
- Used by workbench chat, model Test button, and `/v1/chat/completions` · `/v1/messages` proxy adapters
- API format dropdown labels simplified to `chat/completions` / `messages` / `responses`

**Still open (not fixed in 0.12.21):** OpenCode Zen lists all models via `GET …/models`, but each family needs a different wire path (`/chat/completions`, `/messages`, `/responses`, Gemini Google-style). One provider `apiFormat` cannot serve Claude+GPT+DeepSeek from the same Zen entry — expect **404 Not Found** for wrong-format models. See `docs/TROUBLESHOOTING.md` and `docs/CONFIGURATION.md`.

## Version files to bump together on desktop ship

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
