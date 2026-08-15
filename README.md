# August Proxy

August is a **local AI gateway and agentic workbench**. The user-facing product
is the **Tauri desktop app** ([`frontend/desktop/`](frontend/desktop) + bundled
[`backend-py/`](backend-py)). It also exposes OpenAI- and Anthropic-compatible
HTTP APIs so other clients (Claude Code, Codex, Cline, bots) can use the same
providers, tools, and memory.

The server is **Python 3.12+** (FastAPI). `web-dist/` is the Vite SPA **build
artifact** packaged into Tauri (FastAPI can serve it for backend-only runs). It
is **not** a separate web product to QA against — use `npm run dev:desktop` or
a packaged installer.

It is the successor to an earlier Node.js HTTP bridge. A companion Expo app
lives in [`frontend/mobile/`](frontend/mobile).

---

## Highlights

- **Desktop chat / workbench** — streaming turns with a multi-round tool loop,
  composer Send / Dispatch, mid-run Steer / Stop, checkpoints, context
  compression, and a sticky run header (mode, harness waves, context %, dirty
  Continue).
- **Harness / orchestrator** — Plan → Dispatch, named workstreams, **episode
  cards** (summary / next / unmet acceptance), spawn DAG with per-lane
  running/done/skipped/failed pills, worker lanes, skills carried on Continue,
  harness jobs. Composer Steer targets the focused worker (or Continue if that
  thread is idle). Agent modes: `chat` | `agent` | `code`. Verifier is **opt-in**.
- **Dual API surface** — `POST /v1/chat/completions`, `POST /v1/messages`,
  `POST /v1/responses` (streaming pass-through where the upstream supports it),
  with format translation. Provider **baseUrl** is used as pasted; August only
  appends the format leaf. Models may override **wire format** (`apiFormat`)
  when one gateway lists mixed families (e.g. OpenCode Zen).
- **User-configured providers** — Settings → Models & Providers, or
  `data/providers.json`. Aliases map a chat-picker name to provider + model.
- **Managed tools** — files, shell/PTY, web search/fetch, Playwright browser,
  desktop automation, memory, MCP, skills, sub-agents, sandbox-gated
  `run_command`.
- **Brain & memory** — SQLite core / semantic / vector / graph store. Settings
  **Memory** is one hub (Saved / Recalled / Projects / Store). Chat: `/remember`
  (pins as always-include), always-include chips above the composer, “Used N
  memories”, **Review what I remember** (apply only on confirm), Save-this?
  chips on preference **and correction** phrasing, and Keep/Discard when the
  sleep-cycle distill proposes cleanup (idle consolidation no longer silent-applies).
- **Live / voice** — browser speech by default; optional server STT/TTS;
  `/api/live`.
- **Platform gateways** — Telegram, Slack, Discord (`/stop`, `/new`, `/approve`, …).
- **Integrations** — MCP (`mcp-servers.json`), Google OAuth connections, cron /
  automations, exam flow, git helpers.
- **Settings IA** — fewer rail tabs. Appearance stacks Behavior + UI Designer;
  Access stacks sandbox + path grants + Python cell; Usage is heatmap +
  per-model (not a second Activity Log). Backend Monitor and provider preflight
  are folded into Activity Log / System Status (deep links still work).
- **Desktop shell** — Tauri launches the bundled Python backend; Windows
  auto-update downloads the GitHub-release NSIS installer.

---

## Repository layout

```text
august-proxy/
├── backend-py/                 # FastAPI server (Python ≥ 3.12)
│   ├── app/
│   │   ├── main.py             # App, lifespan, router registration
│   │   ├── config.py           # config.json + providers.json + .env
│   │   ├── adapters/           # OpenAI ↔ Anthropic + dump_*_upstream_body
│   │   ├── providers/          # Templates, HTTP clients, resolvers
│   │   ├── routers/            # /api/* and /v1/*
│   │   └── services/           # workbench, harness, memory, skills, tools, …
│   ├── tests/                  # pytest (isolatedData autouse)
│   └── pyproject.toml
├── frontend/
│   ├── desktop/                # Product UI: React + Vite + Tauri
│   └── mobile/                 # Expo companion
├── web-dist/                   # Vite output packaged into the desktop app
├── data/                       # Runtime state (gitignored secrets)
├── skills/                     # Bundled SKILL.md packs
├── docs/                       # Setup, architecture, API, troubleshooting
├── scripts/                    # Dev, version sync, desktop release
├── AGENTS.md                   # Contract for coding agents (read this)
├── Dockerfile
└── docker-compose.yml
```

**Who owns what (and how to check it):**

| Area | Owns | Validate with |
|------|------|----------------|
| `backend-py/` | Proxy, workbench, brain, MCP, tools | `cd backend-py && uv run pytest -q` |
| `frontend/desktop/` | Tauri UI | `npm run test:frontend` |
| `frontend/mobile/` | Expo | `npm run test -w frontend/mobile` |
| `scripts/` | Install / release | manual |
| Version files | Desktop ship number | `npm run check:version` |

A **desktop release must include backend changes**. Installed apps copy bundled
`backend-py` into AppData from the installer stamp; a UI-only rebuild does not
update the runtime.

---

## Quick start

### Prerequisites

- Python **3.12+** (or Docker)
- Node 22+ for the desktop UI
- An API key for at least one Anthropic- or OpenAI-compatible provider

### Product UI (preferred)

```bash
# Windows
.\install.ps1
# macOS / Linux
./install.sh

npm install
npm run dev:desktop      # Tauri shell + backend
```

QA workbench and settings here, not in a raw Vite browser tab.

### Backend only

```bash
cd backend-py
uv sync --group dev
uv run uvicorn app.main:app --reload --port 8085
```

API: **http://localhost:8085**.

### Docker

```bash
cp .env.example .env          # add keys
docker compose up --build -d
```

Same port **8085**. Still use the desktop app for product UI.

### Point a client at the proxy

```bash
export ANTHROPIC_BASE_URL=http://localhost:8085
claude

export OPENAI_BASE_URL=http://localhost:8085
export OPENAI_API_KEY=dummy   # proxy uses the key from your config
codex
```

The `dummy` key is accepted only when **external access** is on (Settings →
External API Access). Otherwise `/v1/*` returns 403 — see
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Configuration

| File | Purpose |
|------|---------|
| `data/config.json` | Keys, aliases, cognitive/harness flags, security, gateway |
| `data/providers.json` | User providers (name, base URL, API format, models) |
| `data/mcp-servers.json` | MCP servers |
| `data/august_brain.sqlite` | Brain / sessions / memory / audit |
| `.env` | Keys and runtime env (Compose + Pydantic Settings) |

Keys resolve: `config.json → {provider}.apiKey`, then declared env vars, then
`{NAME}_API_KEY`. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

**Per-model wire format:** if a gateway lists Claude + GPT + DeepSeek on one
`/models` URL, set **Wire format** on the model (not only on the provider).
The override wins in workbench, Test, Live, and `/v1` adapters.

---

## For contributors

Start with [`AGENTS.md`](AGENTS.md) and [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the request-flow map.

### Chat UI map (desktop)

Composer sits at the bottom of [`ChatThread.tsx`](frontend/desktop/src/sections/chat/ChatThread.tsx).
Above it, in order: memory-save chips, **Brain review**
([`BrainReviewBar.tsx`](frontend/desktop/src/sections/chat/BrainReviewBar.tsx)),
curator / sub-agent proposal bars, then the composer island. Run chrome is
[`ChatRunHeader.tsx`](frontend/desktop/src/components/chat/ChatRunHeader.tsx).
Worker lanes: [`SubagentLaunchList.tsx`](frontend/desktop/src/components/chat/SubagentLaunchList.tsx)
→ right drawer `subagents`.

Memory review: `POST /api/memory/review` (plan only) and
`POST /api/memory/review/apply` (user-accepted actions). Implementation:
[`memory_review.py`](backend-py/app/services/memory/memory_review.py).

### Settings

Rail lives in [`settings-registry.ts`](frontend/desktop/src/settings/settings-registry.ts).
**Do not add a new left-rail tab** for a slice of an existing hub. Prefer a
stacked hub + `tier: 'hidden'` + `railCanonicalId` so deep links still work.
Memory / Access / Appearance already follow that pattern.

### Tests

```bash
cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q
npm run test:frontend
```

`pyproject.toml` sets `--cov-fail-under=55` on the **full** suite. A single
test file will fail that floor; use `uv run pytest tests/test_foo.py -q --no-cov`
for a focused run.

### High-risk files

Touch carefully; regressions break all chat or safety:

- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` (never send
  `null` August-only keys upstream)
- `backend-py/app/services/sandbox/`
- Tool definitions (OpenAI + Anthropic surfaces must stay in sync)
- `adapters/stream_state.py` (`AnthropicNativeStreamState`)

### Version + GitHub release

On desktop ship, **seven** sources must match (`npm run check:version`):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (`august-desktop` entry)
- `package-lock.json` (root + `packages['frontend/desktop']`)

Do not bump these unless you are shipping. Release: push `master`, then
GitHub Actions **Release desktop** (`workflow_dispatch`, version without `v`).
That job typechecks the SPA (`tsc -b && vite build`), so a missing import
fails the whole installer.

Known product gap: one provider `apiFormat` cannot serve mixed families on
OpenCode Zen without per-model overrides — details in `AGENTS.md` and
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [`AGENTS.md`](AGENTS.md) | Agents / contributors | Desktop product rules, harness notes, version files |
| [`docs/SETUP.md`](docs/SETUP.md) | All users | Installation, first-run, clients |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Operators | Config / providers / env |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Developers | Request flow, workbench, brain, gateway |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Integrators | HTTP + SSE |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) | Contributors | Tests, adding providers / tools / settings |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | All users | Common failures |
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | Everyone | Full doc index |

---

## License

MIT — see [`LICENSE`](LICENSE).
