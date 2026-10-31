# Release

## Version sources

All 9 sources must match (`scripts/check-version-sync.mjs` verifies):

- `package.json`
- `frontend/desktop/package.json`
- `frontend/desktop/src-tauri/tauri.conf.json`
- `frontend/desktop/src-tauri/Cargo.toml`
- `frontend/desktop/src-tauri/Cargo.lock` (`august-harness` entry)
- `package-lock.json` (root + `packages['frontend/desktop']`)
- `docs/api/openapi.json` (`info.version`)

**The OpenAPI spec is a version source because the app serves it.** The
schema's `info.version` is `backend_version()`
(`backend-py/app/version.py`), which reads the root `package.json` in a
checkout — so a bump moves the served schema too. Regenerate it in this order,
or the release's own drift gate fails:

```bash
npm run gen:openapi   # docs/api/openapi.json from the app
npm run gen:api       # frontend/desktop/src/api/gen/openapi.ts from the spec
```

`npm run gen:api` is a no-op for a version-only bump (the version is not in the
typed client), but the spec must be regenerated first or `npm run check:api`
fails with a one-line version diff.

Do not bump these unless you are shipping.

## What the release does

The release is built in GitHub Actions, never on a developer machine. Push the
**tag** (`git push origin master v0.18.16`) — `release-desktop.yml` triggers on
`v*.*.*` tag pushes, with a `workflow_dispatch` fallback that takes the version
without the `v`. The job:

1. verifies the working tree is clean (release provenance);
2. depends on the reusable CI workflow (`ci.yml`), which runs the same gate
   groups every branch push runs;
3. checks `uv lock --check` and that the tag matches `package.json`;
4. builds the web UI and the Rust shell;
5. signs the installer with the key from CI secrets and publishes the assets.

**The release job builds; it does not test.** The test suite was deleted on
2026-10-17, so there is nothing to test. What remains is the gate set, the
reusable CI workflow, and a human running the app.

**A desktop release must include backend changes.** Installed apps copy bundled
`backend-py` into AppData from the installer stamp; a UI-only rebuild does not
update the runtime.

## The gate before the tag

CI runs on every **branch** push and pull request. The release job calls the
same reusable workflow with `needs: ci`, so a tag cannot publish a commit whose
gates never ran — including a tag pushed onto a commit that never went through
a branch push. Confirm the branch's CI is green before tagging anyway:
`git push origin master v0.18.16` does not wait for a separate check.

There is no second gate list. If you add a gate, add it to
`scripts/gates.mjs`; CI and the release pick it up.


## Install and update

The installer/update rules — the two guards, the in-place silent replace, the
relaunch waiter and the signing key — are in [product.md](product.md). The
manual matrix that no static gate can replace is `docs/UPDATE_VERIFICATION.md`.
