# How to work in this repository

`AGENTS.md` states the non-negotiables. This file is the workflow detail: what
verifies a change, what is deliberately absent, and where each kind of work
belongs.

## There is no test suite (removed 2026-10-17, at the owner's request)

Every test file in this repo was deleted on 2026-10-17 — `backend-py/tests/`
(1,690 files), the 235 frontend `*.test.ts(x)` files with their `__tests__`
directories, `frontend/desktop/e2e/`, `scripts/desktop-backend-payload.test.mjs`
and the `test_mapping` hook whose only input was the test tree. The CI jobs, npm
scripts, `pytest` configuration, coverage floor/ratchet and the tooling that
served them went with them — but NOT the dependencies: the pytest-* dev
dependencies in `backend-py/pyproject.toml` and the vitest/playwright packages
in the frontend `package.json` all stay, because `uv lock --check` and the npm
lockfile gate the release job and a removed dep is a lockfile change. `npm
test` does not exist any more, on purpose; the 5 inline Rust `#[cfg(test)]`
blocks in `src-tauri/` were left in place (they compile to nothing outside
`cargo test`, and nothing runs it).

**Every `tests/…` path named anywhere in these docs is historical.** A sentence
that says a rule "is pinned by `tests/test_x.py`" is no longer pinned by
anything — the file it names is gone. Those sentences are the record of *why*
the code has its shape, so they were kept rather than rewritten; verify a claim
by reading the code it names, never by looking for a test. Nothing turns red
for a missing test: the gates that remain are static.

## What verifies a change

One list drives everything: `scripts/gates.mjs`. CI, the release workflow and a
developer's terminal run the same groups.

```
npm run gates:static    # cross-cutting Node checks
npm run gates:backend   # needs the backend interpreter
npm run gates:frontend  # needs npm dependencies
npm run gates:mobile    # Expo typecheck + parity audit
npm run gates:smoke     # startup smoke only (the Windows job)
npm run gates:all       # static + backend + frontend + mobile
```

Inside the groups:

```
check:docs          # numbers in the agent docs match the code
check:design        # px/hex/raw button/drift ratchet
check:naming        # no new camelCase service params
check:api           # committed OpenAPI matches the app
check:api-index     # generated API index is current
check:sse           # backend frames vs schema vs dispatcher, incl. supply
check:version       # 9 version sources agree
check:doc-links     # relative links resolve
check:minisign      # verifier matches the app's format and key
check:truncate      # truncate sits on an element that can truncate
check:brain-config  # Settings keys/ranges exist in the backend
check:tool-registration  # every register() module is claimed
check:skills        # every bundled SKILL.md parses and matches its directory
lint:ratchet        # eslint warnings do not grow
```

The backend group also runs `uv run ruff check .` and `uv run mypy app/` (or
`python -m ruff` / `python -m mypy` where uv is absent), and the frontend group
runs `tsc` + `eslint`, the Vite build and the generated-API-types diff.

`e2e:smoke` is the floor under everything a linter cannot see. A module that
fails to import, a migration that does not apply, a lifespan hook that raises
and a router that fails to register are all invisible to static analysis and
fatal at launch. The smoke imports the real app, runs its lifespan, and asks
its doors a question: read-only doors, one config write, the closed MCP door,
the local door twice (without the per-install token, which must be refused, and
with it, which must get past), policy/secret checks (every file/config-writing
tool is classified as mutating, every sub-agent deny-set name is a registered
tool, the terminal environment carries no app credential, the token is not left
in `os.environ`, and the chat and terminal token doors refuse an unauthenticated
caller), and prompt/surface invariants (no `__PLACEHOLDER__` survives in the
rendered code-mode child source, the Anthropic and OpenAI tool builders return
the same ordered name list, and `buildSystemPrompt` for one session is
byte-identical across rebuilds — the prefix-cache claim, computed). It never
touches the user's data directory — that holds their brain database and their
keys — and it points `HARNESS_DATA_DIR` at a temp directory that is removed
afterwards.

Three gates exist because the defect they catch is INVISIBLE to every other
gate, and each has already caught a live bug:

- **`check:sse` also checks handler SUPPLY.** The frame-parity checks are about
  the frame vocabulary and cannot see a dispatcher that calls
  `handlers.onX?.(...)` when nothing supplies `onX` — the optional call is a
  no-op, so the frame validates, reaches the handler and vanishes. That is
  exactly what `recovery` did: emitted, schematised, dispatched, and invisible,
  so every self-correction the harness performed shipped as a normal-looking
  answer.
- **`check:truncate`** reads the source with the TypeScript compiler API and
  fails when a `truncate` sits on an element that cannot truncate.
  `overflow: hidden` and `text-overflow: ellipsis` do not apply to an inline
  box, so `truncate` on a bare `<span>` is inert and the text paints over
  whatever is beside it. Only the AST can tell a flex CONTAINER from a flex
  ITEM (`flex-1` is item sizing, not a container) and can see a className
  written as a template literal or a `cn(...)` call.
- **`check:brain-config`** asks the backend which keys it accepts and what
  ranges they take, and fails when the Settings panel writes a key it does not,
  or offers a value it refuses. It has caught a key with a `fieldTable` entry
  but no writable-set entry (every PUT naming it was rejected) and a backend
  range that started at 1 while the panel's own default was 0.

`check:skills` covers the same blind spot at the skill layer: discovery skips
a malformed `SKILL.md` with a runtime warning, so without a static scan a
bundled skill can disappear from the catalogue with nothing red. It is
preventive — the shipped tree is green today — and it also refuses a
frontmatter name that disagrees with its directory or two bundled skills that
share a name.

The static gates cannot see whether the app **starts**. `e2e:smoke` is that
floor, and it is deliberately not a behaviour test.

## Two standing rules

The branch, commit and staging flow — naming, what goes in a commit message,
what to stage, when to merge and when to tag — is
[CONTRIBUTING.md](../../CONTRIBUTING.md). The two rules below are the ones an
agent is most likely to break.

**Delete your scratch files before you commit.** When you finish a session,
delete the scratch files *you* created — scan outputs, generator scripts,
unused drafts, probe scripts left in the tree. The repo carries no `_*.py` /
`*.txt` scratch artifacts on purpose; a leftover probe is debris, and the next
reader cannot tell it from a real module.

**New work rides under existing part numbers — never mint a new "Part N+".**
The numbered Part series (Part 1–27) is CLOSED. A change whose scope fits an
existing part's area ships under that part's number; a change that fits none of
them gets a plan doc under `docs/plans/<date>-<slug>.md` with a descriptive
slug, and code and commit messages reference that plan **by slug, never by
number**. Comments and identifiers describe what the code does and why, not
which plan document created it — so "Part 28" appearing in a comment or a
commit message is a defect, not a citation.

## Directory map and validation routing

| Area | Owns | Validate with |
|------|------|---------------|
| `backend-py/` | FastAPI proxy, workbench, Brain, MCP, tools | `cd backend-py && uv run ruff check . && uv run mypy app/` |
| `frontend/desktop/` | Tauri shell, React UI, Vite build | `npm run check -w frontend/desktop` (tsc + eslint) + `npm run check:design` |
| `frontend/mobile/` | Expo mobile app | `npm run test -w frontend/mobile` (its own `tsc --noEmit` + parity audit) |
| `scripts/` | Build/release orchestration (Node) | run it; `node --check <script>` for syntax |
| `docs/` | User-facing docs, specs, troubleshooting | `npm run check:doc-links` · `npm run check:docs` |

**High-risk coordination points** (touch carefully, validate both layers):

- Version files — must stay in sync across all 9 checked desktop sources
  ([release.md](release.md)).
- `dump_openai_upstream_body` / `dump_anthropic_upstream_body` — upstream
  serialization; a wrong key breaks all chat ([providers.md](providers.md)).
- Provider base URLs and per-model wire formats ([providers.md](providers.md)).
- Sandbox, permission policy and the listing/shell/write doors — changes affect
  tool execution safety ([security.md](security.md)).
- `_executeTool` hash-anchored edits + `toolDefinitions`/`openaiToolDefinitions`
  capability filtering — both wire formats must stay in sync
  ([harness.md](harness.md)).
- `adapters/stream_state.py` `AnthropicNativeStreamState` — tool_use input
  accumulation; a regression re-runs managed tools with empty args
  ([harness.md](harness.md)).

## Where a change lands

| If the change is about… | Read first | Then validate |
|---|---|---|
| a turn, a tool loop, a budget, a stop reason | [harness.md](harness.md) | `uv run ruff check . && uv run mypy app/`, `npm run e2e:smoke` |
| a provider, a model, a wire format, pricing | [providers.md](providers.md) | `npm run check:api`, the app's Test button |
| memory, recall, backups, the memory mirror | [memory.md](memory.md) | the memory spec, `npm run check:brain-config` |
| a skill, the learning pipeline, the review pass | [skills.md](skills.md) | `npm run check:skills`, `npm run check:docs`, `check:brain-config` |
| a sandbox rule, a path door, a secret | [security.md](security.md) | `uv run mypy app/`, the smoke's policy checks |
| the desktop shell, the chat surface, the update flow | [product.md](product.md) | `npm run check -w frontend/desktop`, a human running the app |
| the version number, a release, the OpenAPI artifacts | [release.md](release.md) | `npm run check:version`, `gen:openapi`, `gen:api` |

The user-facing goal, the UX principles and the current round are in
[docs/PRODUCT.md](../PRODUCT.md) and [docs/STATUS.md](../STATUS.md); this file
does not duplicate them.
