# Agent notes (August Proxy)

August is a **local AI gateway and agentic workbench**. The product is the
**Tauri desktop app** (`frontend/desktop/` + bundled `backend-py/`); `web-dist/`
is the Vite artifact packaged into it, not a separate web product. Verify
fixes in the desktop app, and ship backend changes with every desktop release.

This file is the contract. The reasoning, edge cases and defect history behind
each rule live in `docs/agent/` — read the area file before changing code in
that area.

## Read first

| Area | Read before touching |
|---|---|
| How to work, gates, no-test policy | [docs/agent/workflow.md](docs/agent/workflow.md) |
| Branches, commits, staging, release flow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Desktop shell, update flow, chat UI | [docs/agent/product.md](docs/agent/product.md) |
| Providers, wire formats, pricing | [docs/agent/providers.md](docs/agent/providers.md) |
| Upstream quirks, workarounds and removal gates | [docs/agent/compatibility.md](docs/agent/compatibility.md) |
| Turn loop, budgets, subagents, bots | [docs/agent/harness.md](docs/agent/harness.md) |
| Memory, recall, backups, mirror | [docs/agent/memory.md](docs/agent/memory.md) |
| Skills, learning, review pass | [docs/agent/skills.md](docs/agent/skills.md) |
| Sandbox, path doors, secrets | [docs/agent/security.md](docs/agent/security.md) |
| Versions, OpenAPI, tag flow | [docs/agent/release.md](docs/agent/release.md) |

The index is [docs/agent/README.md](docs/agent/README.md).

## Non-negotiables

- **The desktop app is the product.** Do not QA product work against a raw
  Vite tab. `web-dist/` is a build artifact.
- **There is no test suite.** It was deleted on 2026-10-17 at the owner's
  request. Do not add test files, test runners or a `test` script. What
  verifies a change is the static gate set, `e2e:smoke`, and a human running
  the app ([workflow.md](docs/agent/workflow.md)).
- **The two install guards stay.** A new download must start with an empty
  memory; an update must keep everything. Never stage runtime user state into
  the installer payload, and never let `wipeStaleTree` delete outside
  `backend-runtime/` ([product.md](docs/agent/product.md)).
- **An update is in-place, silent, and restarts itself.** The download is
  automatic; the restart is the user's click.
- **One memory store.** `facts` is the system of record. There is no vector
  store, no graph store, and no second memory database. Do not add one without
  deleting the file that says not to ([memory.md](docs/agent/memory.md)).
- **No verifier gate.** Nothing withholds a final answer.
  `update_state(phase=…)` is progress tracking only.
- **Provider base URLs are used exactly as pasted.** August appends only the
  format leaf; it never invents `/v1` ([providers.md](docs/agent/providers.md)).
- **The parent turn is the only model-facing memory write door.** Sub-agents
  read and recall, never write ([memory.md](docs/agent/memory.md)).
- **Both tool surfaces stay in sync** — the Anthropic and OpenAI tool
  definitions must return the same ordered name list.
- **A capability the model cannot use is not advertised.** A knob that always
  refuses is a lie ([security.md](docs/agent/security.md)).
- **Delete your scratch files before you commit**, and **never mint a new
  "Part N+"** — the numbered series is closed
  ([workflow.md](docs/agent/workflow.md)).
- **Stage by path, not by tree.** Never `git add -A`; never commit a
  gitignored path. Commit messages state the why, not the diff.

## What verifies a change

Run the gate set for the area you touched. The full list, the smoke check and
the reason each gate exists are in [workflow.md](docs/agent/workflow.md).

```bash
npm run gates:all
# or the group you touched: gates:static / gates:backend / gates:frontend / gates:mobile
```

## Directory map

| Area | Owns | Validate with |
|---|---|---|
| `backend-py/` | FastAPI proxy, workbench, brain, memory, skills, tools | ruff + mypy |
| `frontend/desktop/` | Tauri shell, React UI, Vite build | tsc + eslint + `check:design` |
| `frontend/mobile/` | Expo companion | its own typecheck + parity audit |
| `scripts/` | Build, release, gates | run it |
| `docs/` | Reference, specs, state map | `check:doc-links`, `check:docs` |
| `skills/` | Bundled SKILL.md packs | the skill doors |

## Goal, status and memory/skills UX

- The product goal, users, principles and what a good memory/skills UX looks
  like: [docs/PRODUCT.md](docs/PRODUCT.md).
- What is shipped, what is next and what is waiting on an owner decision:
  [docs/STATUS.md](docs/STATUS.md).
- The current memory and skills specification, including open UX items:
  [docs/specs/memory-and-skills.md](docs/specs/memory-and-skills.md).
- The in-app system map (a live product feature, not just docs) is
  `docs/state/`; it is validated by the backend and browsable in the app.

## Version and release

All 9 version sources must match; regenerate the OpenAPI spec and the typed
client in order; the release is built in CI, never locally. The list and the
tag flow are in [release.md](docs/agent/release.md).
