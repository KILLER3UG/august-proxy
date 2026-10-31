# August Harness

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
  thread is idle). Agent modes: `chat` | `agent` | `code` | `orchestrator`
  (`planner` is an alias). There is **no verifier gate** — nothing withholds a
  final answer, and `update_state(phase=…)` is progress tracking only.
- **Dual API surface** — `POST /v1/chat/completions`, `POST /v1/messages`,
  `POST /v1/responses` (streaming pass-through where the upstream supports it),
  with format translation. Provider **baseUrl** is used as pasted; August only
  appends the format leaf. Models may override **wire format** (`apiFormat`)
  when one gateway lists mixed families (e.g. OpenCode Zen).
- **User-configured providers** — Settings → Model settings, or
  `data/providers.json`. Aliases map a chat-picker name to provider + model.
- **Managed tools** — files, shell/PTY, web search/fetch, Playwright browser,
  desktop automation, memory, MCP, skills, sub-agents, sandbox-gated
  `run_command`.
- **Brain & memory** — SQLite core with BM25/FTS recall. **No vector store and no
  graph store** — `fact_retrieval.py`, `tools/retrieval.py` and
  `text_similarity.py` each say so; do not add one without deleting those.
  Settings **Memory** is one flat chronological list across kinds with filter
  chips (no tabs, no meters). The "Memory files" card the 0.18 restyle removed is
  back, as **Backups & restore** — see Settings → Memory.
  The model manages memory through the `remember` / `list_facts` / `forget` core
  tools. Automatic recall is gated by `memoryAutoInject` (**armed by default
  since 2026-10-24**; an explicit stored `false` wins), but
  `kind='profile'` facts always ride in — that is what makes August remember who
  you are without a keyword coincidence. Proposals that need a human surface on
  the decide queue; approving a retire keeps the row, so it is reversible.
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
augustHarness/
├── backend-py/                 # FastAPI server (Python ≥ 3.12)
│   ├── app/
│   │   ├── main.py             # App, lifespan, router registration
│   │   ├── config.py           # config.json + providers.json + .env
│   │   ├── adapters/           # OpenAI ↔ Anthropic + dump_*_upstream_body
│   │   ├── providers/          # HTTP clients, resolvers, api_format aliases
│   │   ├── routers/            # /api/* and /v1/*
│   │   └── services/           # workbench, harness, memory, skills, tools, …
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
| `backend-py/` | Proxy, workbench, brain, MCP, tools | `cd backend-py && uv run ruff check . && uv run mypy app/` |
| `frontend/desktop/` | Tauri UI | `npm run check -w frontend/desktop` (tsc + eslint) |
| `frontend/mobile/` | Expo | `npm run test -w frontend/mobile` (tsc + parity audit, no test files) |
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

Start with [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md). The product goal and the
current round are in [`docs/PRODUCT.md`](docs/PRODUCT.md) and
[`docs/STATUS.md`](docs/STATUS.md).
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the request-flow map.

### Chat UI map (desktop)

Composer sits at the bottom of [`ChatThread.tsx`](frontend/desktop/src/sections/chat/ChatThread.tsx).
Above it, in order: memory-save chips, curator / sub-agent proposal bars,
then the composer island. Worker lanes: inline sub-agent rows
([`SubagentTimeline.tsx`](frontend/desktop/src/components/chat/SubagentTimeline.tsx))
→ right drawer `subagents`.



### Settings

Rail lives in [`settings-registry.ts`](frontend/desktop/src/settings/settings-registry.ts).
**Do not add a new left-rail tab** for a slice of an existing hub. Prefer a
stacked hub + `tier: 'hidden'` + `railCanonicalId` so deep links still work.
Memory / Access / Appearance already follow that pattern.

### Verifying a change

One list drives everything: [`scripts/gates.mjs`](scripts/gates.mjs).

```bash
npm run gates:all                 # the whole gate set CI runs
npm run gates:static              # Node-only checks
npm run gates:backend             # OpenAPI, brain-config, ruff + mypy, smoke
npm run gates:frontend            # truncate/design/ratchet, tsc, build, gen:api
npm run gates:mobile              # Expo typecheck + parity audit
```

CI and the release workflow call the same groups, so a gate added to the list
cannot be skipped by a workflow that forgot to name it.

**There is no test suite.** Every test file (backend `tests/`, the frontend
`*.test.ts(x)` and `e2e/` suites, the payload-integrity test) was deleted on
2026-10-17 at the owner's request, along with the CI jobs, npm scripts, pytest
configuration and coverage ratchet that ran them. `npm test` does not exist, and
`pyproject.toml` keeps no pytest configuration; what remains is the gate set
above and a human running the app.

### High-risk files

Touch carefully; regressions break all chat or safety:

- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` (never send
  `null` August-only keys upstream)
- `backend-py/app/services/sandbox/`
- Tool definitions (OpenAI + Anthropic surfaces must stay in sync)
- `adapters/stream_state.py` (`AnthropicNativeStreamState`)

### Version + GitHub release

On desktop ship, **nine** sources must match (`npm run check:version`):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (`augustharness` entry)
- `package-lock.json` — top-level `version`, `packages['']`, and
  `packages['frontend/desktop']` (three separate checks, one file)

Do not bump these unless you are shipping. Release: push the **tag**
(`git push origin master v0.18.16`) — `release-desktop.yml` triggers on
`v*.*.*` tag pushes, with a `workflow_dispatch` fallback that takes the version
without the `v`. Two things to know before you push it:

- The release job **builds; it does not test**. It depends on the same reusable
  CI workflow every branch push runs (`.github/workflows/ci.yml`), then runs
  `uv lock --check`, the tag-vs-package version assertion, and produces the
  signed installer. The pytest suite, the vitest suite, the payload-integrity
  test and `check:coverage` were deleted on 2026-10-17 along with the whole test
  tree (see "Verifying a change" above).
- CI runs on every branch push and pull request. The release job calls the same
  workflow with `needs: ci`, so a tag cannot publish a commit whose gates never
  ran — but confirm the branch's CI is green before pushing the tag anyway.

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
