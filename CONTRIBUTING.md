# Contributing

The short version: `master` is always releasable; branch for anything that
takes more than one commit; write a commit message that says why; stage files
by path; run the gate group for what you touched; release only from a green
tag.

## Branches

- `master` is the trunk. A commit on `master` should be green on its own.
- Branch when the work spans more than one commit, or when you cannot keep
  each commit green. Name it `<type>/<slug>` using the same types as commits:
  `fix/`, `feat/`, `docs/`, `chore/`, `refactor/`, `ci/`.
- Merge back with a merge commit (do not rebase published history). Delete the
  branch after it merges.
- A branch older than two weeks is resolved, not carried: land it, or delete
  it and record why in the issue or the commit that supersedes it. Stale
  branches accumulate real unmerged work and a merge cost that grows daily.

## Commits

Header: `<type>(<scope>): <sentence>` — for example
`fix(ui): a dropped local request stopped being reported as a provider rejection`.

- The header says what changed in one sentence. The body says **why**, what was
  measured, and what was rejected. A diff already shows the what.
- One logical change per commit. If a commit needs "and" twice in its header,
  it is probably two commits.
- Reference a plan by slug, never by number. The numbered Part series is
  closed; do not mint "Part 28+".
- No third-party attribution trailers. A `Co-authored-by:` or `Generated with:`
  line naming an AI tool or a service account is never added, and never carried
  over from a tool's default commit template — the commit is the owner's. GitHub
  resolves each such email into a listed contributor on the repository, so this is
  visibility, not etiquette.
- Never commit generated artifacts except the ones the gates own
  (`docs/api/openapi.json`, `docs/API_INDEX.md`,
  `frontend/desktop/src/api/gen/openapi.ts`). Regenerate them with the
  commands in [`docs/agent/release.md`](docs/agent/release.md).

## Staging

- `git add <path>` / `git add <dir>` — **never `git add -A` or `git add .`**.
- Check `git status` before and after staging. A gitignored path in an
  `add && commit` chain aborts the whole chain, and a broad add can sweep in
  another session's in-flight work.
- Do not revert shared files to HEAD to "clean up". Scope by pathspec and
  leave unrelated hunks alone.
- Delete your scratch files before you commit. The repo carries no `_*.py` /
  `*.txt` probe artifacts on purpose.

## Before you commit

Install the hook once (Windows, Device Guard safe):

```powershell
.\scripts\install-git-hooks.ps1
```

The hook runs ruff on backend changes. It is a fast local aid, **not** the
gate. Run the group for what you touched:

```bash
npm run gates:static     # docs, links, naming, SSE, version, tool registration
npm run gates:backend    # OpenAPI, brain-config, ruff + mypy, startup smoke
npm run gates:frontend   # truncate/design/ratchet, tsc + eslint, build, gen:api
npm run gates:mobile     # Expo typecheck + parity audit
npm run gates:all        # everything, before a broad push or a release
```

The gate list is [`scripts/gates.mjs`](scripts/gates.mjs). Do not hand-list
gates in a workflow or a doc.

There is **no test suite** (deleted 2026-10-17 at the owner's request). Do not
add test files, a test runner or a `npm test` script. What verifies a change is
the gate set, `e2e:smoke`, and a human running the desktop app.

## Before you push

- Confirm the branch's `CI` run is green. CI runs on every branch push and pull
  request; the release job calls the same workflow, so a tag cannot publish a
  commit whose gates never ran.
- If the change touched a high-risk area, name it in the PR or commit body and
  run `gates:all` rather than one group. The list is in
  [`AGENTS.md`](AGENTS.md) and [`docs/agent/`](docs/agent/README.md).

## Pull requests

Use a PR when you want review. CI runs on PRs. Keep the description focused on
why and what was measured; the diff shows the rest. A PR that changes behavior
should say how it was verified in the desktop app, and name anything it did
**not** verify.

## Releasing

1. Bump the nine version sources together (`npm run check:version` lists them).
2. Regenerate in order: `npm run gen:openapi`, then `npm run gen:api`.
3. Commit `chore(release): <version>` on `master`.
4. Wait for CI on that commit to be green.
5. Push the tag: `git push origin master v<version>`.

The release is built in GitHub Actions, never on a developer machine. The
release job depends on the same CI workflow and produces the signed installer.
See [`docs/agent/release.md`](docs/agent/release.md).

## Where to read next

- [`AGENTS.md`](AGENTS.md) — the binding contract.
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — what August is and what good looks
  like.
- [`docs/STATUS.md`](docs/STATUS.md) — what is shipped and what is next.
- [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) — the full index.
