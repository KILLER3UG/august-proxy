# Anatomy + ManimGX integration, preceded by a branch reconcile

Date: 2026-10-13 · Status: **executed 2026-10-14** (Stages 0–4 landed in `19847e98`…`0421fa12`); the open
defects found while reviewing that landing are now listed in §7 of
`docs/plans/2026-10-14-harness-ui-claude-parity.md`, which also carries the follow-on UI work.

Supersedes the verbal plan reviewed on 2026-10-13. That plan's Phase 1–4 content was checked line by line
against the working tree; five of its claims were false or insufficient, and the reorder below is the result.
Evidence for every claim is in the row that makes it.

---

## Stage 0 — Reconcile the branches (do this first; it gates everything else)

The request was "merge all branches". **Measured: there is nothing to merge.** Every branch is already an
ancestor of `master`, each with 0 unique commits:

| Ref | Tip | ahead / behind `master` | Ancestor of master |
|---|---|---|---|
| `harness-skill-autonomy` | `05632551` | 0 / 77 | YES |
| `master-merge` | `0980f3f1` | 0 / 85 | YES |
| `master-ready` (worktree `C:/Dev/august-harness-wt`) | `60bb43bb` | 0 / 55 | YES |
| `backup/harness-autonomy-premerge` | `3d0763ad` | 0 / 114 | YES |
| `origin/harness-skill-autonomy` | `453c706b` | 0 / 87 | YES |

`august-worktree-branches-20260925_0104.bundle` — 17 heads: 16 are ancestors of `master`. The one exception,
`agent-audit-1-backend` (`178b4bca`, "audit(agent-1): backend core findings", 2026-08-11), is not, and
`git cherry master 178b4bca` returns `+` (patch not in master). It is deliberately kept out: the tag
`archive-superseded-agent-audit-1-backend` points at that same commit.

So a merge would be a no-op, and the work that actually protects this repo is a **reconcile**: three things
must land, and two residual populations must be dispositioned.

### 0.1 Land the in-flight consolidation fix (blocking)

Uncommitted on `master` right now, and it is not scratch — it carries a written correctness rationale:

- `backend-py/app/services/memory_store/consolidation.py` (+38): `apply_retire_decision` no longer runs
  `RELEASE SAVEPOINT` before `brain_commit`. The stated reason: releasing first pops the savepoint while the
  writes are still uncommitted, so a commit that then fails on a busy database leaves a spent `approved` claim
  on the thread-local handle for the *next unrelated commit* to publish — the exact state the
  claim-before-write design exists to prevent. The handler also gains an `conn.in_transaction` probe to decide
  what to report when the undo itself fails.
- `backend-py/tests/test_memory_part21_oq5_retire.py` (+94).

Steps: read both diffs end to end, run `uv run pytest tests/test_memory_part21_oq5_retire.py -q`, then the full
backend suite with `-n auto`, then commit it **on its own** with a message about the savepoint ordering. Prove it
red by restoring the pre-fix `RELEASE`-then-`commit` shape and showing the test fails, then revert back
(`feedback-prove-red-by-reverting`). Do not fold this into any Anatomy work.

Note: both files report `LF will be replaced by CRLF` — `master-merge` (`0980f3f1` "force LF on the generated
API artifacts") is already in master, so check `.gitattributes` covers `backend-py/app/**` before committing,
or the diff shape will lie on the next Windows checkout.

### 0.2 Resolve the collected scratch test (blocking for Stage 1's frontend numbers)

`frontend/desktop/src/test/scratch_r7_headings.test.tsx` is untracked and 74 lines, and it **is collected**:
`vitest.config.ts` never sets `include`, only `exclude: [...configDefaults.exclude, 'e2e/**']`, so the default
`**/*.{test,spec}.?(c|m)[jt]s?(x)` catches it. Its cases (CRLF fences, setext-after-`<div>`, `#######`, table-then-
`===`) are the probes behind HEAD's own commit message ("four more h1 escape routes"). Either fold the cases into
the real heading test file or delete the scratch file — but decide before Stage 1 reports a frontend test count,
because until then `npm run test:frontend` counts a file that was never meant to ship.

### 0.3 Residual populations needing a content verdict (not a merge)

- **8 `archive-superseded-*` tag tips are NOT ancestors of `master`**, so commits exist that only tags reach:
  `agent-audit-1-backend`, `camelmodel-desktop-automation`, `phase3-extract-anthropic-sse`,
  `phase3-extract-memory-schema`, `phase3-extract-openai-sse`, `phase3-extract-workbench-sessions`,
  `phase4-busy-timeout-and-schema-plan`, `phase4-missing-indexes`, `phase4-zustand-pilot`.
  "Superseded" is a claim in a tag name, not a proof. For each: name the files it touched, then check whether
  the change is in `master` by *any* route (`git log master -- <file>`, grep the symbol). Emit one row per tag:
  `content present via <commit>` / `genuinely absent — needs decision` / `obsolete by design`.
- **7 stashes.** `git apply --reverse --check` is inconclusive for all 7 (the tree moved 100+ commits under them),
  so that test proves nothing and I am not reporting it as a result. One spot-check is informative: `stash@{0}`
  (2026-09-09, `ChatThreadComposer.tsx`) has its added comment lines absent from the file while
  `<ComposerWorkspaceChips` is present → **partially superseded**, needs a real read. The other 6 are from
  2026-07-14 and sit on the `refactor/phase3-*` / `phase4-*` / `b21-app-file-renames` branches whose tips survive
  only as the archived tags above — they ride on 0.3's verdicts.

Read-only until the table is signed off. This stage produces a report, not commits, except 0.1.

### 0.4 Cleanup, only after 0.3 is dispositioned and approved

`git worktree remove C:/Dev/august-harness-wt` (0 unique commits, 55 behind); delete the 4 local ancestor
branches; delete `origin/harness-skill-autonomy` (contained, so a **shared-state action needing explicit OK**);
keep the 55 MB bundle until 0.3 says nothing depends on it, then it is the recovery artifact and its own keeper.

---

## Stage 1 — Make interactive artifact HTML actually run

**This moved ahead of the Anatomy port, because the reviewed plan had the order backwards.** The old plan called
Phase 1 "independent, ships alone" while its own validation step was "one live Figure render in the desktop app",
which is exactly what the current shell cannot do. Anatomy's verbatim description is "interactive isometric SVG
figures … WebGL shaders and parts that turn in true 3D" — inert without running script.

Why the reviewed fix (`sandbox="allow-scripts"` on the existing iframe) is a **no-op**, measured:

- `RightDrawerFileSection.tsx:121-126` renders HTML as `srcDoc={liveSrcDoc}` with `sandbox=""`.
- A `srcdoc` document **inherits the parent document's CSP**. Tauri's is `script-src 'self'`
  (`tauri.conf.json:27`), so agent-authored inline script stays blocked after the sandbox change. The figure
  renders, nothing moves, no error surfaces.
- `blob:` URLs do not escape it either — a blob URL keeps the creator's origin and CSP.
- The route the old plan pointed at does not serve HTML: `workbench.py:869-890` `/files/raw` is waveform-only —
  `_WAVEFORM_MIME` (`:865`) maps `.vcd/.fst/.ghw` and every other suffix to `application/octet-stream`, i.e. the
  browser downloads it. It adds no CSP header and resolves through the read-only `_resolve_shared_read_file`.
  `routers/preview.py` is dev-server session CRUD, not artifact serving.
- `FileAttachment.previewUrl` is an object URL from the chat-attachment path, not a backend URL, so there is no
  existing same-purpose route to reuse.

### Design: serve the document from its own origin, keep the shell CSP intact

1. **Measure first (10 min, decides everything below):** confirm the packaged app's backend really is a different
   origin from the Tauri shell (frontend calls `http://127.0.0.1:<port>`; Tauri assets are `http://tauri.localhost`).
   If they were the same origin, a response CSP would not override the injected app CSP and step 2 fails.
2. **New route** `GET /api/workbench/artifact/html` in `app/routers/workbench.py`: bind through the *existing*
   `_resolve_shared_read_file` (hardline + workspace/temp roots + size cap — reuse, do not write a second path
   policy), refuse anything that is not `.html`/`.svg`, respond with `Content-Type: text/html; charset=utf-8` and
   a document-scoped CSP — `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:`.
   Because the response is a different origin, Tauri's asset CSP does not apply to it, and **the app-wide
   `script-src 'self'` stays as is.**
3. **Frontend:** in the HTML branch, `srcDoc` → `src={artifactUrl(file)}` with `sandbox="allow-scripts"` and
   **no `allow-same-origin`** (opaque origin ⇒ no parent read, no Tauri IPC reach). Leave `showSource` alone.
   Note the Surfer embed at `CircuitWaveformViewer.tsx:192` does use `allow-same-origin` (for
   `https://app.surfer-project.org/`, a genuinely foreign origin — harmless there, and its own comment on `:191`
   says the opposite of its code). Do not copy that pattern; `RightDrawerPreviewSection.tsx:177` is a dev-server
   URL, also not this case.
4. **Rewrite the comment at `:84-86`**, which currently states the shell CSP blocks inline scripts so a live
   preview cannot be advertised. That reasoning is what made this a dead preview; after step 2 it is false, and a
   comment that encodes the old defect is how the next session re-breaks it.
5. **Setting** — ON by default for files the session produced, OFF for arbitrary opened files. Use the existing
   workbench-preferences path; do not add a store. The distinction is load-bearing: the flag must key on
   provenance (session-authored), not on extension.

**Tests:** frontend — HTML branch renders `src=` to the artifact route, `sandbox` contains `allow-scripts` and
does **not** contain `allow-same-origin` (extend `__tests__/RightDrawerFileSection.test.tsx`, which already
mounts the component). Backend — route refuses outside-root paths, refuses non-HTML, and the response carries the
CSP header. Then prove red: put `sandbox=""` + `srcDoc` back and show both tests fail.

`create_html_artifact` (`artifact_tools.py:409`, registered `tool_registrations/artifact_tools.py:105`) benefits
identically — it is the other half of the motivation, and today its output has the same dead preview.

---

## Stage 2 — Port Anatomy as a bundled skill

Content claims in the reviewed plan verified true against the source (repo `wheresryan22/anatomy`, MIT, tag
`v1.0.0` with an attached `anatomy.zip`): steps 1–10 match verbatim (*Size it before you start / Truth first /
Invent the object / Parts list / Plan the world / Build geometry once / Paint back to front, bottom to top /
Frame it / Make it live / Verify like a critic*); tiers Figure 30–90 min, Hero 2–4 h, Epic 6 h+; minimum 40 parts;
examples include `dial-indicator`, `test-rig`, `raptor-engine`, `ripple-tank`, `arcade-cabinet`,
`desk-computer`, `spot-plate`, `turning-dial`.

1. `skills/anatomy/SKILL.md` — correct location: `skill_service.py:5-6` declares `BUNDLED — <repo>/skills/` and
   `:26` resolves `SKILLS_DIR` to it (siblings: `charts`, `tutor`, `circuit-sim`, `august-tools`).
2. `description` ≤ **500** chars — verified, `_DESCRIPTIONMax = 500` (`skill_service.py:219`), enforced at `:347`
   with `SkillValidationError`. Names the capability, the situations, and when NOT to fire (a quick box-and-arrow
   sketch → `charts`).
3. Body in the canonical section set from `docs/SKILL_AUTHORING.md`, rendering the 10 steps and the truth-first
   model. Bundled skills pass through `_ensure_canonical_body` untouched, so the prose must be right on arrival.
4. `references/` carries the 2–3 smallest examples. **Cap the directory at 25 entries** —
   `skill_tools.py:74` `_MAX_SKILL_FILES = 25`, and beyond that the model only gets
   "_N more not listed_" (`:106-107`). Confirm whether the examples are self-contained single files or need
   sibling assets before choosing; `raptor-engine` stays out of the payload as planned.
5. **Add the MIT attribution** (`LICENSE` text + a source/provenance line naming the repo and tag). The reviewed
   plan omitted it; MIT's only condition is preserving the copyright notice, and this ships in an installer.
6. Do not rely on `test_skill_service_hygiene.py` as the conformance gate — reviewed and rejected: it covers
   frontmatter round-trip, disabled-skill refusal, the `relevant_skills` block,
   `no_literal_quotes_in_descriptions`, `bundled_tutor_skill_present`. Nothing validates bundled-skill format, and
   no `scripts/check*skill*` exists. Write the small test that is actually missing: anatomy is discovered, its
   description ≤ 500, `load_skill` lists its `references/` entries.
7. Validation: `load_skill` round-trip, the skill visible in the Skills UI, and one live Figure rendered in the
   desktop app through Stage 1's route — which is only possible after Stage 1.

---

## Stage 3 — Screenshot verification for HTML (closes "verify like a critic")

`artifact_judge.py` verified as described: `judge_artifact` at `:252` runs one vision pass
`_vision_describe(pngs[0], question, extra_images=pngs[1:])` at `:281`, `_JUDGE_PAGE_CAP = 8`, DPI clamped
`72–200`, PNGs to `<dataDir>/render-cache` never the workspace — and `_DOC_EXT/_IMG_EXT/_PDF_EXT` (`:34-36`)
have **no `.html`**, so the gap is real.

1. Route `playwright` through the **existing** browser layer instead of booting a second engine: August's
   navigation guard is the load-bearing part (`_installNavigationGuard`, `session_manager.py:114+`, whose docstring
   records that `page.route` does *not* fire for 3xx hops and that `assertFinalUrlAllowed` is the control that
   actually closes the redirect case). A judge-local `async_playwright().start()` would silently re-open that hole.
   `file://` is also a refusal to decide: use the Stage 1 route URL, so the judge screenshots exactly what the
   user sees, same CSP, same origin.
2. **The reviewed plan's error claim is false and fixing it is a separate, real bug.** `BrowserUnavailableError`
   is raised only when the *playwright python package* fails to import (`session_manager.py:57-62`), and
   `handlers.py:129` catches only that type. Playwright is a declared dependency (`pyproject.toml:18`), so the
   common failure is the opposite case: package installed, **chromium binary absent** — then `launch()` at `:84`
   raises Playwright's own `Executable doesn't exist`, un-wrapped, in both the browser tools and the new judge.
   Add: a binary-presence probe plus wrap launch failures into `BrowserUnavailableError` with the
   `uv run playwright install chromium` guidance. Commit this on its own; it fixes existing browser tools, not
   just Stage 3.
3. `render_pages` gains HTML → page image(s) through that engine; `judge_artifact` unchanged otherwise. Still a
   review step, never a gate — the 2026-08-24 no-gates ruling holds.
4. Tests with a stubbed renderer; assert the verdict shape and that HTML now reaches the vision call.

---

## Stage 4 — ManimGX track (opt-in, after a real trial)

The reviewed plan's key detail is **more right than it knew**:

- `venv_python()` is exactly at `kernel.py:608-619` and finds
  `<ws>/.aug/kernel/venv/{Scripts/python.exe|bin|python}`; `_KERNEL_SUBDIR = '.aug/kernel'` at `:50`. A
  pre-seed package list exists at `:595-604`, and **nothing provisions it** — no `ensurepip`, no venv creation
  anywhere in `backend-py/app`. So the discovery half is done and the write half is the work. Correct as planned.
- manimgx 0.1.1: `requires_python >=3.13`; the `win_amd64` wheel is **`cp313 abi3`**, classifiers list 3.13 and 3.14.
  So the rule is **`>=3.13`**, not "3.13" — abi3 means 3.14 works too.
- **A download is unavoidable, and here is the proof:** the desktop payload ships a portable CPython **3.12.9**
  (`prepare-desktop-backend.mjs:55`, python-build-standalone, `install_only`), staged and hashed as a payload root
  (`desktop-backend-payload.mjs:207-211`), and the runtime venv is built from it (`backend.rs:122-128`
  `backend-py/.venv`). 3.12.9 < 3.13, so the app's own interpreter cannot host manimgx and there is no
  reuse-the-bundled-python shortcut. `uv` is not in the payload.
- **The licensing guardrail is real, not theoretical, and the reviewed plan understated it:**
  `desktop-backend-payload.mjs:195` stages and hashes `wheels` as a payload root — so a manimgx wheel dropped
  there *would* ship in the installer. `userStateSuffixes` (`:33-35`) has `.sqlite/.db/.key/.pem` but no `.whl`,
  and `userStateDirs` (`:28-30`) has no `venv`/`site-packages`. Add `.whl` (+ `venv`/`site-packages` dirs) and a
  `test:packaging` case that plants one and asserts the build refuses. My earlier read — that the guard only
  defended against a mis-set `AUGUST_DATA_DIR` — was wrong; correct it in any write-up that repeats it.
  Imprecise in the old plan too: x264 is **GPL-2.0-or-later**; the GPL-3.0 element in manimgx's bundled license
  expression (`MIT AND GPL-2.0-or-later AND LGPL-2.1-or-later … GPL-3.0-or-later WITH Font-exception-2.0 …`) comes
  from the font exception. Either way: per-user install only, never staged.
1. Provisioning action (Settings/Workbench) creating `<ws>/.aug/kernel/venv` from an interpreter `>=3.13`,
   then `pip install` of the chosen set. Network + consent happen backend-side and are **distinct from the
   `sandboxNetwork` session flag** (`workbench.py:332,380,2353-2354`) — say so in the UI copy and log the grant.
   No such Settings action exists today; check how existing privileged one-shot backend installs are surfaced
   before inventing a pattern.
2. Bundled skill `math-animation`: typed API, 2D+3D, Typst text; the render → `manimgx inspect` storyboard → fix
   loop; final MP4 verified through `analyze_media` (`media_tools.py:231`) frame extraction.
3. Scenes run through `run_command` against `venv_python()`'s interpreter; the MP4 lands in the workspace and the
   existing file card + drawer + artifacts gallery handle it. Confirm `run_command`'s permission tier allows
   executing that interpreter path before writing the skill — that tier is the risk, not the venv.
4. Defer a native `render_animation` tool until the trial shows usage.

---

## Validation

| Stage | Command |
|---|---|
| 0.1 | `cd backend-py && uv run pytest tests/test_memory_part21_oq5_retire.py -q` then `-q -n auto` full suite |
| 0.2 | `npm run test:frontend` — and the suite must still pass with the scratch file gone |
| 1 | `npm run test:frontend` + backend route tests; **desktop smoke via `npm run dev:desktop` is mandatory** — the proof is a figure that animates, and a passing jsdom test proves nothing about CSP |
| 2 | targeted skill tests + `load_skill` in the app |
| 3 | `uv run pytest tests/test_*artifact_judge* -q`, then full backend |
| 4 | provisioning run on a real workspace, one manimgx render to MP4, `test:packaging` refusal case |

Always `-n auto`. `ruff` + `mypy app/` before every backend commit. `npm run check:docs` if any constant in
`agents.md` moves. Ship = desktop release including backend changes, 8 version files via `npm run check:version`,
and **confirm `Type check` CI is green before pushing the tag** — the release job builds but does not test, and
`git push origin master v0.x.y` does not wait for it.

## Decisions I need from you

1. **Stage 0.3 dispositions** — the 8 archived tag tips and 7 stashes: merge, keep as archive, or delete. I will
   produce the content-reachability table; I will not delete or merge any of it on an assumption.
2. **Stage 1 route vs CSP relaxation.** The route (option above) keeps `script-src 'self'` on the shell. The
   alternative — `'unsafe-inline'` in `tauri.conf.json` — is one line and no backend work, and weakens every page
   in the app. I recommend the route; the choice is yours because it is a security posture change either way.
3. **Does Stage 2 ship before Stage 1?** If yes, Anatomy figures visibly do nothing in the drawer. I recommend 1 → 2.
4. **`scratch_r7_headings.test.tsx`** — fold into the real heading test, or delete?
