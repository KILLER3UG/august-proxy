# August Proxy — Documentation

> **Note:** This file has been superseded by a modular documentation set.
> The contents below previously described the legacy Node.js HTTP bridge
> (`bridge.js`, `adapters/*.js`, `utils/*.js`, `claude`/`codex` profiles,
> the fake model list, and `launch.js`/`.bat` scripts). **That architecture
> no longer exists.** The server is now a Python 3.13 FastAPI application in
> [`backend-py/`](../backend-py/). The historical text is preserved at the
> bottom of this file for reference only — treat the active docs below as
> authoritative.

---

## Current documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [**README.md**](../README.md) | Everyone | Project overview, highlights, repo layout, quick start |
| [**SETUP.md**](SETUP.md) | All users | Installation (Docker & local), first-run, connecting a client |
| [**CONFIGURATION.md**](CONFIGURATION.md) | Operators | `config.json` / `providers.json` / `.env` reference |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, memory, gateway |
| [**API_REFERENCE.md**](API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes, SSE events |
| [**DEVELOPER_GUIDE.md**](DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, conventions, extending the codebase |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | All users | Common issues and fixes |

Start with [SETUP.md](SETUP.md) if you are new to the project, or
[ARCHITECTURE.md](ARCHITECTURE.md) if you are contributing.

---

## What changed and why

The earlier single-file documentation described a Node.js proxy that has since
been rewritten in Python. Specifically, the following concepts are **gone** or
**changed**:

| Old concept | Current reality |
|-------------|-----------------|
| `bridge.js` HTTP server | `backend-py/app/main.py` (FastAPI) |
| `adapters/anthropic.js`, `adapters/openai.js` | `backend-py/app/adapters/anthropic.py`, `openai.py` |
| `utils/*.js` (config, logger, models, tokens, selfheal, inspector) | `backend-py/app/services/*` and `app/lib/*` |
| `claude` / `codex` profiles in `config.json` | Unified provider model + `modelAliases` + `activeProvider` |
| Hardcoded fake `/v1/models` list | Dynamic catalog from built-in + custom providers + aliases |
| `launch.js` + `claude-local.bat` / `codex-local.bat` | Point clients at `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` directly |
| `august__bash`, `august__read_file` … managed tools | Workbench tool registry (`app/services/tool_registry.py`) |
| `august__submit_plan` execution gate | Workbench `submit_plan` + `plan`/`full`/`ask` guard modes |
| Single `ui.html` | React + Vite + TypeScript SPA served from `web-dist/` |
| No gateway | Telegram / Slack / Discord platform adapters |
| No skills/curator | Skill system + lifecycle curator |

For the full current architecture, read [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Historical reference (deprecated)

The text below documents the **legacy Node.js implementation** and is retained
for historical context only. It does **not** reflect the running code. Do not
follow its instructions; use [SETUP.md](SETUP.md) instead.

<!-- The legacy content has been intentionally collapsed. If you need the
     original prose for archaeology, see git history for this file. -->

* Legacy architecture diagram, fake model list, model hijacking, tool ID
  base64url mapping, context compaction, self-healing, request inspector,
  profile system, Dockerfile, `launch.js`, `ui.html`, and the 2026-05
  changelog entries — all describe the retired Node.js proxy and are
  superseded by the documents listed above.
