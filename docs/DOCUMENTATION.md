# August Proxy — Documentation

## Current documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [**README.md**](../README.md) | Everyone | Project overview, highlights, repo layout, quick start |
| [**SETUP.md**](SETUP.md) | All users | Installation (Docker & local), first-run, connecting a client |
| [**CONFIGURATION.md**](CONFIGURATION.md) | Operators | `config.json` / `providers.json` / `.env` reference |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, memory, gateway, data persistence |
| [**API_REFERENCE.md**](API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes, SSE events |
| [**DEVELOPER_GUIDE.md**](DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, conventions, extending the codebase |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | All users | Common issues and fixes |

### Refactor program

| Document | Audience | Contents |
|----------|----------|----------|
| [**REFACTOR_PROGRESS.md**](REFACTOR_PROGRESS.md) | Contributors | **Live tracker** — phases, bug ledger, what's next |
| [**REFACTOR_HANDOFF_PROMPT.md**](REFACTOR_HANDOFF_PROMPT.md) | New sessions | Pasteable handoff; verify against repo before coding |
| [**FEATURE_INVENTORY_TEST_MATRIX.md**](FEATURE_INVENTORY_TEST_MATRIX.md) | QA / Phase 7 | Feature inventory → automated coverage map |
| [**PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md**](PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md) | Archaeology | Schema rename — **CLOSED** (snake-only DB) |
| [**PHASE_PERF_AND_FLEXIBILITY_PLAN.md**](PHASE_PERF_AND_FLEXIBILITY_PLAN.md) | Archaeology | Phase P performance plan — **CLOSED** |

### Product history (not refactor trackers)

| Path | Contents |
|------|----------|
| [`design/`](design/) | Cognitive architecture design notes |
| [`releases/`](releases/) | Release notes by version |
| [`superpowers/`](superpowers/) | Historical feature plans and specs |

Start with [SETUP.md](SETUP.md) if you are new, [ARCHITECTURE.md](ARCHITECTURE.md) if
you are contributing, or [REFACTOR_PROGRESS.md](REFACTOR_PROGRESS.md) for refactor status.

**Backend:** Python 3.12+ FastAPI in [`backend-py/`](../backend-py/) (CI pins 3.12).
**Frontend:** Tauri + React 19 desktop SPA; Expo mobile companion.
