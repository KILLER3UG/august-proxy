# deepseek-harness / dsh-notes-archived-rest#2

## Shard shape

This shard is **not source code** — it is the repository's frozen **decision archive**: 260 markdown/YAML files under `.agents/notes/archived/` in the `deepseek-harness` repo, split into two families. `process/` (102 files, 34 English notes × {`.md`, `.zh.md`, `.i18n.yaml`}) records *implemented process decisions* — CI topology, runner sizing, release/version policy, GitHub Issue/PR governance, i18n pairing. `simplification/` (158 files here) records *deletion decisions* — the archive of what was removed from the DSH harness and why; the sibling shard `dsh-notes-archived-rest#3` carries the remaining 118 `simplification/` files, and the split lands in the middle of one bilingual pair (`2026-08-04-remove-tui-package.zh.md` is filed under #3 while its English side and hash record are here). Every note follows one rigid house format (`Problem → Decision → Alternatives considered → Verification → Consequences`) plus a status line, an archive date, and a bilingual cross-link; each pair carries a machine-checked `.i18n.yaml` **consistency record** holding the git blob hash of both language sides (the archived whole-file sealed form — the per-heading section-keyed record belongs to the evolving `docs/` tree, not to this frozen archive). The two families fit together as an *append-only reasoning log*: the `simplification` notes are the "what we removed" half of the same discipline the `process` notes apply to "what we decided", and several process notes explicitly amend or supersede simplification notes (and vice versa). Mechanically, the notes are the load-bearing inputs to the repo's own doc gates (`verify-translation-pairing`, `verify-archived-agent-notes`, `verify-md-links`, `verify-repository-references`) and to the skills `dsh-find-simplifications` / `dsh-speed-up-perf`, which cite them by path as historical evidence. For the August harness this shard is valuable less as a feature map than as a **methodology map**: it shows how this codebase decides, gates, and remembers.

**Coverage: all 260 files in the shard now carry a per-file note below.** The `simplification/` family (158 files) is dominated by *deletion* decisions, and the deletions cluster into four recurring shapes worth naming for the August harness: (a) *no-consumer cuts* — an event, field or dialect variant with no production listener is deleted rather than kept as contract surface (`llm/adapter-change`, `skill/provider-added`, `HookDialect.'native'`, `suppressOutput`, `GenerateOptions.prefill`); (b) *single-owner merges* — two services or two representations of one fact are collapsed into one (`ctx.subagentControl` into `ctx.subagents`, two `SurfaceManager`s into one, two stop verbs into one `cancel()`, the delta codec into full header snapshots); (c) *surface-honesty cuts* — a UI affordance or API path that no configuration could reach is removed instead of left as a lie (`/cancel`, the ACP branding knobs, the user-message edit stub, the sidebar pill); and (d) *framing and delivery corrections* — where injected content is projected, how titles are produced, how the model is told what it may do, and how the loop reports its own state. The house format itself is the transferable artefact: every note states the *alternatives rejected and why*, which is what makes the archive usable as evidence rather than as changelog.

## Per-file notes

### .agents/notes/archived/process/2026-08-28-ci-node-compile-cache-data-disk.i18n.yaml
Bilingual-pair consistency record: the git blob hashes of the English and Chinese sides of the NODE_COMPILE_CACHE note, plus the `pnpm run verify-translation-pairing --write` command that re-records them.

### .agents/notes/archived/process/2026-08-28-ci-node-compile-cache-data-disk.md
- Purpose: Move Node's V8 compile cache off the self-hosted CI root partition.
- Key abstractions: `NODE_COMPILE_CACHE`, `${{ runner.temp }}`, `$GITHUB_ENV` injection.
- Data flow: a step after `actions/checkout` writes `NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache` into `$GITHUB_ENV`, so every later step (pnpm setup, install, Playwright) inherits it.
- Non-obvious design decisions: injection rather than job-level `env` (the `runner` context evaluates to empty at job level) and rather than a step-level env on the gate alone (earlier pnpm calls would still write to `/tmp`); the confined bwrap/Landlock child silently skips caching rather than failing, because Node's compile cache is best-effort.
- Edge cases / failure handling: a bwrap profile that does not grant `runner.temp` — `node` still exits 0, verified on the VM; only `mkdtemp` hard-fails on a read-only filesystem.
- Surprising: measured **697,389 inodes / 9.2 GB** of compile cache on the shared VM, with 34,110 files under one hour old — the cache grew on every run and was never cleaned.

### .agents/notes/archived/process/2026-08-28-ci-node-compile-cache-data-disk.zh.md
Chinese translation of the NODE_COMPILE_CACHE note; same decision, verification probes and consequence list.

### .agents/notes/archived/process/2026-08-28-test-temp-dir-self-cleanup.i18n.yaml
Consistency record: blob hashes of the English/Chinese test-temp-dir cleanup note.

### .agents/notes/archived/process/2026-08-28-test-temp-dir-self-cleanup.md
- Purpose: Make unit tests delete the `/tmp/dsh-*` directories they create, instead of relying on an after-the-fact sweep.
- Key abstractions: `mkdtemp(join(tmpdir(),'dsh-*'))`, module-level root registry, `afterEach`/`afterAll` teardown, `privateSpillDir` exit cleanup.
- Data flow: root-creating helpers (`tmp()`, `tempDir()`, `fakeLauncher()`) register each created root at creation; teardown removes the registry, so every caller is covered at one point.
- Non-obvious design decisions: the file list came from an *observed-residue histogram* on the CI host — only specs whose dirs actually appeared were treated as leak sources; the product-side cleanup is limited to a per-process spill dir holding **no completed spill file**, because completed spill files are recovery artifacts.
- Edge cases / failure handling: ENOENT/ENOTEMPTY/EBUSY/EPERM must not change the exit code; a SIGKILLed process cannot run any in-process teardown, so the machine-side `dsh-tmp-sweep` timer stays as the backstop.
- Surprising: **92% of sampled `dsh-subprocess-*` residue dirs were empty** — the dominant shape was a directory that never spilled.

### .agents/notes/archived/process/2026-08-28-test-temp-dir-self-cleanup.zh.md
Chinese translation of the test-temp-dir self-cleanup note.

### .agents/notes/archived/process/2026-08-30-windows-refs-store-block-clone-install.i18n.yaml
Consistency record for the Windows ReFS block-clone install note.

### .agents/notes/archived/process/2026-08-30-windows-refs-store-block-clone-install.md
- Purpose: Make the self-hosted Windows CI install work on a ReFS volume.
- Key abstractions: `fs.realpathSync.native`, pnpm `package-import-method=clone`, `@reflink/reflink`, `PNPM_CONFIG_STORE_DIR`.
- Data flow: the Windows install step branches on the workspace volume's filesystem; on ReFS it runs `corepack pnpm install --frozen-lockfile --package-import-method=clone`.
- Non-obvious design decisions: block cloning gives each `node_modules` file an independent path (so native realpath cannot resolve it back into the store) while sharing physical blocks — this fixes TS6231 without a copy cost; `corepack pnpm` is used because `pnpm/action-setup`'s dest build omits the `@reflink` native module; `.npmrc`/`npm_config_*` are ignored by pnpm 11.7.0 on Windows, so the CLI flag is the only honored channel.
- Edge cases / failure handling: NTFS rejects copy-on-write (`ERR_PNPM_LINKING_FAILED ... Source volume does not support copy-on-write`), so clone is gated on the ReFS check; hosted runners keep the default import method.
- Surprising: **TypeScript's native realpath resolves a hardlink into the pnpm store's content-addressed path**, so bare imports failed with TS6231 — while JS `realpathSync` did not, which is why only the compiler tooling broke.

### .agents/notes/archived/process/2026-08-30-windows-refs-store-block-clone-install.zh.md
Chinese translation of the Windows ReFS block-clone install note.

### .agents/notes/archived/process/2026-08-31-pr-opened-issue-start-dates.i18n.yaml
Consistency record for the PR-opened Issue start-date note.

### .agents/notes/archived/process/2026-08-31-pr-opened-issue-start-dates.md
- Purpose: Initialize an organization Issue's `Start date` when a PR that references it opens.
- Key abstractions: GitHub GraphQL `updateIssueFieldValue`, Project items, Project time zone.
- Data flow: on `pull_request.opened` the workflow reads the live PR body, keeps every same-repo reference resolving to an Issue, converts `created_at` to a calendar date in the configured Project time zone, ensures the Issue is a Project item, and writes the field **only when the current value is empty**.
- Non-obvious design decisions: the write is empty-value-gated so a later PR never overwrites a manually planned date or one recorded by an earlier PR; Status transitions stay owned by the separate event-directed review-status decision; informational references count too, because both relations mark the start of repository work.
- Edge cases / failure handling: missing configuration fails at policy-module load; a missing field, a non-Date or Project-local field, an invalid timestamp or a failed API request fails the first relevant PR.
- Surprising: the mutation has **no compare-and-set precondition**, so two PRs referencing the same empty Issue can both write and last-one-wins.

### .agents/notes/archived/process/2026-08-31-pr-opened-issue-start-dates.zh.md
Chinese translation of the PR-opened Issue start-date note.

### .agents/notes/archived/process/2026-08-31-serial-windows-notices-timeout-budget.i18n.yaml
Consistency record for the serial-windows notices timeout-budget note.

### .agents/notes/archived/process/2026-08-31-serial-windows-notices-timeout-budget.md
- Purpose: Fix the flaky `gen-third-party-notices` coverage test and align the serial-windows lane's per-test budget.
- Key abstractions: `loadWorkspaceManifests()`, `DSH_COVERAGE_MAX_WORKERS`, `DSH_COVERAGE_TEST_TIMEOUT_MS`.
- Data flow: `render()` now loads the workspace manifests **once** and threads the map through `collectNpmDeps` → `installedMetadata` → `installedManifest` → `workspaceLinkedManifest`, instead of reloading per external dependency name.
- Non-obvious design decisions: explicit threading was chosen over a module-level cache, to keep the single-load contract visible at the call site and avoid a second hidden cache beside `workspaceLinkedManifestCache`; raising the budget alone was rejected because it would mask the O(names × manifests) reload for every lane running the generator.
- Edge cases / failure handling: the name-keyed linked-manifest cache is cleared at the start of each `render()` so it cannot outlive the map it was resolved from; output bytes are unchanged, verified by diffing before/after.
- Surprising: the cold path was **130 names × 270 manifests ≈ 35k file operations**, and the fix took `render()` from ~893 ms to ~86 ms.

### .agents/notes/archived/process/2026-08-31-serial-windows-notices-timeout-budget.zh.md
Chinese translation of the serial-windows notices timeout-budget note.

### .agents/notes/archived/process/2026-08-31-windows-coverage-flaky-test-budgets.i18n.yaml
Consistency record for the Windows coverage flaky-budgets note.

### .agents/notes/archived/process/2026-08-31-windows-coverage-flaky-test-budgets.md
- Purpose: Make the `windows node 24 / coverage` lane deterministic so it can rejoin `all-checks-passed.needs`.
- Key abstractions: `vi.waitFor` polling, `disposeGraceMs`/`disposeEofGraceMs`, `DEFAULT_SHUTDOWN_TIMEOUT_MS`, `TSX_TSCONFIG_PATH`.
- Data flow: fixed `settle()` waits are replaced by `vi.waitFor(() => expect(warn).toHaveBeenCalledWith(...), { timeout: 5_000 })`; dispose-ladder tests that spawn a real child now pass the **product default** budgets (3,000 ms) instead of test-only 100–300 ms values.
- Non-obvious design decisions: the polling assertion still fails on timeout, so the fail-soft contract is not weakened; the negative case (an impossible warning string) is asserted to time out and fail.
- Edge cases / failure handling: the fake-child negative cases at 10 ms still prove a truly stuck child fails the ladder; a historical coverage gap in `workflow-worker-thread` was traced to a **DSH session environment artifact** (`TSX_TSCONFIG_PATH` pointing at the staging checkout's tsconfig) rather than a code defect — with it unset the spec passes 54/54.
- Surprising: the two "flaky" cache tests asserted a durable outcome after a fixed **40 ms** settle on a fire-and-forget write.

### .agents/notes/archived/process/2026-08-31-windows-coverage-flaky-test-budgets.zh.md
Chinese translation of the Windows coverage flaky-budgets note.

### .agents/notes/archived/process/2026-09-02-project-local-issue-planning-fields.i18n.yaml
Consistency record for the Project-local planning-fields note.

### .agents/notes/archived/process/2026-09-02-project-local-issue-planning-fields.md
- Purpose: Move Issue planning metadata (Priority, Severity, Cost, Start/Target Date) from organization Issue fields into Project-local custom fields.
- Key abstractions: `updateProjectV2ItemFieldValue`, `Legacy ...` migration sources, separate `GITHUB_TOKEN` vs App-token credentials.
- Data flow: the PR policy workflow uses the repository `GITHUB_TOKEN` for REST Issue/PR reads and a read-only App token for ProjectV2 queries; lifecycle mutations use the write-capable App token.
- Non-obvious design decisions: organization Issue fields require a **separate App permission** from organization Projects, so mixing storage systems made one policy depend on two independently administered permission sets; dual-write was rejected because mirrored fields drift.
- Edge cases / failure handling: a field rename or type change fails the workflow rather than falling back to legacy fields; removing an organization field requires comparing every legacy value with its Project value, including archived Project items.
- Surprising: the note explicitly states that empty-value reads make retries idempotent but **Project field updates have no compare-and-set precondition**, so concurrent PRs can both write.

### .agents/notes/archived/process/2026-09-02-project-local-issue-planning-fields.zh.md
Chinese translation of the Project-local planning-fields note.

### .agents/notes/archived/process/2026-09-03-semantic-issue-templates-and-policy.i18n.yaml
Consistency record for the semantic Issue templates note.

### .agents/notes/archived/process/2026-09-03-semantic-issue-templates-and-policy.md
- Purpose: Stop treating Markdown presentation as repository metadata.
- Key abstractions: Issue templates (Bug/Feature/Task), frontmatter (`name`/`about`/`type` only), PR template sections.
- Data flow: the policy module validates semantic metadata only; the templates supply the structure through headings and HTML comments.
- Non-obvious design decisions: `details` presentation, visible-body length, title language, title prefixes and `Owner:` body lines are **not** policy checks — each of those rules failed otherwise-actionable Issues without naming a missing semantic decision; Idea and Research were folded into Task because they established no distinct lifecycle.
- Edge cases / failure handling: every other policy check, warning, lifecycle operation, workflow trigger and PR-enforcement exemption is unchanged; the change adds no metadata repair, Issue classification, data migration or workflow capability.
- Surprising: the note is explicit that it does **not** rewrite legacy labels, choose missing Issue Types, synchronize Priority, or migrate existing data.

### .agents/notes/archived/process/2026-09-03-semantic-issue-templates-and-policy.zh.md
Chinese translation of the semantic Issue templates note.

### .agents/notes/archived/process/2026-09-03-workspace-version-coherence-gate.i18n.yaml
Consistency record for the workspace version coherence gate note.

### .agents/notes/archived/process/2026-09-03-workspace-version-coherence-gate.md
- Purpose: Make the shared dsh version a static, always-run gate over the whole family.
- Key abstractions: `check-workspace-constraints`, `checkDshFamilyVersion`, the `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` name predicate.
- Data flow: any scanned workspace manifest whose name matches must carry the workspace root's version; the rule is name-based, so it covers `packages/` (publishable and private/experimental), `apps/`, and the root manifest.
- Non-obvious design decisions: importing the release family's `members()` was rejected (it discovers only publishable members, while the invariant also covers private packages) — a name predicate states the whole boundary once; the gate is placed in the always-run static lane so the failure lands on the standard PR panel instead of only the release lane.
- Edge cases / failure handling: the gate **cannot prevent a stale-base merge** — it observes only the snapshot its run was triggered against; branch protection requiring an up-to-date base remains the complementary half.
- Surprising: the 2026-09-03 incident — `packages/util/http-proxy` merged with `0.1.2-alpha.5` after the family had bumped to `0.1.2-rc.1`, reddening every PR based on the broken master, and the introducing PR's last CI run had predated the bump.

### .agents/notes/archived/process/2026-09-03-workspace-version-coherence-gate.zh.md
Chinese translation of the workspace version coherence gate note.

### .agents/notes/archived/process/2026-09-06-evidence-driven-performance-skill.i18n.yaml
Consistency record for the evidence-driven performance skill note.

### .agents/notes/archived/process/2026-09-06-evidence-driven-performance-skill.md
- Purpose: Define a performance-optimization workflow that requires evidence rather than a copy-pasted old PR.
- Key abstractions: the `dsh-speed-up-perf` skill, focused attribution + independently timed backend/browser endpoints, synthetic workload distributions, cold/warm comparability, negative controls for tightened budgets.
- Data flow: a survey narrows to bounded, measured user paths; each optimization PR carries its own tightened budget, and a preceding benchmark layer may protect the measured baseline and stay independently mergeable.
- Non-obvious design decisions: the historical-evidence table deliberately distinguishes **merged implementations, superseded proposals, author-reported measurements, and estimates** — "historical evidence generates hypotheses; current production paths and fresh measurements decide whether a change applies"; behaviour evidence (model-visible logs, durable generation/publication rules, stream ordering, cancellation, disposal) is required *independently of timing*.
- Edge cases / failure handling: authorized private corpus inspection yields only aggregate workload inspiration; committed inputs and published artifacts must contain synthetic material; the finite scenario/fix scope prevents a broad performance request becoming an unrelated architectural rewrite.
- Surprising: the table records that deferral is **not** virtualization (visited token DOM stays retained) and that attribution estimates overlap and cannot be added.

### .agents/notes/archived/process/2026-09-06-evidence-driven-performance-skill.zh.md
Chinese translation of the evidence-driven performance skill note.

### .agents/notes/archived/process/2026-09-06-master-only-platform-ci.i18n.yaml
Consistency record for the master-only platform CI note.

### .agents/notes/archived/process/2026-09-06-master-only-platform-ci.md
- Purpose: Move paid platform coverage (macOS Intel/ARM, Linux ARM64, Wine) from every PR to master pushes only.
- Key abstractions: reusable Python runtime builder, `ci: true` + explicit external API secret, Wine as a separate hosted Ubuntu master job.
- Data flow: `ci.yml` requires Python runtime validation on Linux x64 and Windows x64; `ci-master.yml` selects the three other carriers on master pushes only.
- Non-obvious design decisions: Wine stays hosted to avoid shared-host apt transactions and shared Wine-prefix cleanup on the persistent Linux VM; its existing image-keyed apt cache restore/save also produces the default-branch cache, so no separate cache-seeding job is needed.
- Edge cases / failure handling: fork and Dependabot PRs stay keyless; runner trust and fallback selectors are unchanged; a master push schedules all three carriers but does not guarantee every intermediate commit reaches a result.
- Surprising: the decision **explicitly accepts post-merge discovery** for these four checks; master failures remain ordinary failing jobs, not `continue-on-error`.

### .agents/notes/archived/process/2026-09-06-master-only-platform-ci.zh.md
Chinese translation of the master-only platform CI note.

### .agents/notes/archived/process/2026-09-06-node-compatibility-selfhosted.i18n.yaml
Consistency record for the self-hosted Node compatibility note.

### .agents/notes/archived/process/2026-09-06-node-compatibility-selfhosted.md
- Purpose: Run the Node 22/24/26 compatibility jobs on the existing self-hosted Linux pool without colliding tool directories.
- Key abstractions: `DSH_CI_FAILOVER_LINUX`, a setup-node-only ESM preload (`scripts/ci-compatible-toolcache.mjs`), per-runner `_temp/node-compat-toolcache`.
- Data flow: the ESM preload assigns the tool cache inside the action process, because the Actions runner overwrites reserved env vars after reading step configuration; an executed path check rejects installations outside runner temp.
- Non-obvious design decisions: the trust predicates (non-Dependabot author, non-fork head repo matching the current repo) are stated **explicitly** rather than inherited, so the restriction survives a repository-settings change; the `blacksmith` failover branch drops them because it targets ephemeral runners.
- Edge cases / failure handling: compatibility processes do not inherit the preload; hosted jobs keep their tool/package caching while self-hosted jobs neither restore nor upload hosted package caches; no global Node symlink or system package change is introduced.
- Surprising: "31 Linux registrations" is reported as **not 31 independent machines** — one VM hosts 32 runners.

### .agents/notes/archived/process/2026-09-06-node-compatibility-selfhosted.zh.md
Chinese translation of the self-hosted Node compatibility note.

### .agents/notes/archived/process/2026-09-06-preview-hosted-runner-sizing.i18n.yaml
Consistency record for the hosted preview runner-sizing note.

### .agents/notes/archived/process/2026-09-06-preview-hosted-runner-sizing.md
- Purpose: Pick the runner size for PR preview builds on measured cost, not sticker price.
- Key abstractions: `ubuntu-24.04` standard vs 4/8/16-core larger runners; GitHub's per-job minute rounding.
- Data flow: experiment 34012729982 measured all eight size/cache combinations with the same revision, Node 24.19.0, pnpm 11.7.0 and identical commands; warm jobs restore one run-private pnpm cache, cold jobs skip restoration.
- Non-obvious design decisions: **GitHub rounds each job up to whole minutes**, so a cheaper per-minute runner can cost more; the standard 2-vCPU runner measured $0.024 vs $0.126 for 16-core — 80.95% cheaper — for 78 extra seconds.
- Edge cases / failure handling: the comparison fixes source, lockfile, commands and runtime versions but **not** physical CPUs or image release; one sample per cache state, so it measures the offered labels, not isolated CPU scaling.
- Surprising: GNU-time RSS is explicitly flagged as *not* simultaneous process-tree memory, and the standard runner's 7.75 GiB is reported against a 2.86 GiB workspace peak RSS.

### .agents/notes/archived/process/2026-09-06-preview-hosted-runner-sizing.zh.md
Chinese translation of the hosted preview runner-sizing note.

### .agents/notes/archived/process/2026-09-06-release-rehearsal-selfhosted.i18n.yaml
Consistency record for the self-hosted release rehearsal note.

### .agents/notes/archived/process/2026-09-06-release-rehearsal-selfhosted.md
- Purpose: Run dependency-layout and release-pack rehearsals on the persistent Linux pool when an operator opts in.
- Key abstractions: `DSH_CI_FAILOVER_LINUX=selfhosted`, runner labels `[self-hosted, linux, x64, vm-backup]`, `TMPDIR` → `runner.temp`, a pnpm setup destination qualified by run/attempt/job.
- Data flow: the selector requires the canonical repository and a non-Dependabot actor, then admits only master pushes or same-repo non-fork PRs; manual dispatch always selects `ubuntu-24.04`.
- Non-obvious design decisions: rehearsals **intentionally share** the Linux switch with main CI (one switch routes both workloads, not releases independently); `TMPDIR` points into runner temp so a killed process's scratch stays inside runner cleanup even without `finally`; checkout explicitly cleans ignored and untracked output before immutable install, because a warm pnpm store must not substitute workspace links for a real tarball payload.
- Edge cases / failure handling: the packed-install verifier creates a fresh consumer outside the checkout, removes inherited Node resolution hooks, and deletes the consumer in `finally`; unsetting the variable is the operator-selected fallback, not automatic runner-health failover, and queued jobs are not re-routed.
- Surprising: the rehearsal workflows never save remote caches, and neither manual publish workflow gains credentials.

### .agents/notes/archived/process/2026-09-06-release-rehearsal-selfhosted.zh.md
Chinese translation of the self-hosted release rehearsal note.

### .agents/notes/archived/process/2026-09-07-selective-issue-policy-evaluation.i18n.yaml
Consistency record for the selective Issue policy evaluation note.

### .agents/notes/archived/process/2026-09-07-selective-issue-policy-evaluation.md
- Purpose: Spend credentials and runner time only on PRs that can actually fail policy.
- Key abstractions: a selective-preflight capability marker checked in the trusted checkout, informational vs resolving Issue references, runner-level event filtering.
- Data flow: enforcement eligibility is decided **first** (draft PRs, Bot/App authors, human PRs with no review requests and no submitted reviews are exempt); only then are references resolved, via repository REST reads, and only Issues named by *resolving* references require a Project Priority read.
- Non-obvious design decisions: a checkout **without** the preflight marker falls back to full legacy validation, and *execution errors* never select the fallback (so a crash cannot silently downgrade enforcement); informational references prove Issue identity without needing Project access at all.
- Edge cases / failure handling: the required policy job still allocates a runner — this is not a zero-cost required check; preflight and final validation each read live REST state, duplicating repository requests rather than caching a verdict; omitted lifecycle events cannot repair stale Project state.
- Surprising: "avoiding Project reads and token creation does not guarantee fewer total API requests."

### .agents/notes/archived/process/2026-09-07-selective-issue-policy-evaluation.zh.md
Chinese translation of the selective Issue policy evaluation note.

### .agents/notes/archived/process/2026-09-08-browser-third-party-build-inputs.i18n.yaml
Consistency record for the browser third-party build-inputs note.

### .agents/notes/archived/process/2026-09-08-browser-third-party-build-inputs.md
- Purpose: Stop installers from downloading a second copy of libraries the browser artifact already inlines.
- Key abstractions: `devDependencies` for browser-only inputs, the dependency classifier, `publishConfig.access`, dynamic-plugin inlining vs static browser libraries.
- Data flow: the classifier collects build inputs from source imports and JSX; Host-runtime-reachable libraries take precedence as `dependencies`; type-only references create no Host runtime dependency.
- Non-obvious design decisions: npm sections do **not** select bundling behavior; license classification follows **distributed content**, so a library resolved by the real browser build configuration stays a runtime disclosure even when the manifest declares it for development; static packages are Web-shell build inputs, not independently installable libraries.
- Edge cases / failure handling: dual-face packages still load Host libraries (`fflate` for ZIP, `zod` for RPC) and those installation relationships must remain; classification is source-based and license resolution must not depend on existing `lib/` files.
- Surprising: the concrete trigger was React being declared only for development, letting the installer select a *different* React version than the browser artifact uses — even though `use-sync-external-store@1.2.0` and `@tanstack/react-virtual@3.14.9` both support React 18.

### .agents/notes/archived/process/2026-09-08-browser-third-party-build-inputs.zh.md
Chinese translation of the browser third-party build-inputs note.

### .agents/notes/archived/process/2026-09-08-package-index-link-discovery.i18n.yaml
Consistency record for the package-index link discovery note.

### .agents/notes/archived/process/2026-09-08-package-index-link-discovery.md
- Purpose: Make `verify-md-links` actually check `packages/README.md` and its Chinese counterpart.
- Key abstractions: `verify-md-links`, `scripts/repo-files.ts` source discovery.
- Data flow: `packages/*.md` is added to the existing source discovery; the command and its tests share that discovery function.
- Non-obvious design decisions: repairing individual links was rejected because it leaves the discovery omission in place; a separate package-inventory checker was rejected because index completeness and link validity are different requirements.
- Edge cases / failure handling: symlink deduplication and frozen-Agent-Note exclusion stay owned by `repo-files`.
- Surprising: nested group/package globs could not match the index files at all, so broken links in either index escaped validation entirely.

### .agents/notes/archived/process/2026-09-08-package-index-link-discovery.zh.md
Chinese translation of the package-index link discovery note.

### .agents/notes/archived/process/2026-09-08-playwright-video-gif.i18n.yaml
Consistency record for the Playwright video/GIF note.

### .agents/notes/archived/process/2026-09-08-playwright-video-gif.md
- Purpose: Capture continuous browser demos rather than a screenshot storyboard.
- Key abstractions: `recordVideo`, one encoder accepting either a video file or a screenshot directory, WebM → GIF encoding.
- Data flow: when the browser-control workflow exposes `recordVideo`, video captures intermediate frames in the same controlled context; otherwise screenshots are taken; the recorder retains the page video, awaits context closure, and saves the completed WebM before encoding; video input selects one continuous interval, applies a declared playback multiplier and extends its final frame.
- Non-obvious design decisions: viewport and recording dimensions are set **explicitly** to avoid Playwright's default scaling to fit 800×800; "trimming and speed never establish model response latency".
- Edge cases / failure handling: mode-inappropriate options and invalid intervals fail; the JSON summary records source duration, interval, speed, final hold and encoded dimensions/duration/frames/size; failed recordings cannot contribute frames to a successful run.
- Surprising: the encoder's local Python unittest suite invokes real ffmpeg/ffprobe and is **not** provisioned by repository CI.

### .agents/notes/archived/process/2026-09-08-playwright-video-gif.zh.md
Chinese translation of the Playwright video/GIF note.

### .agents/notes/archived/process/2026-09-09-blocked-weighted-approvals-remain-pending.i18n.yaml
Consistency record for the blocked-approvals-pending note.

### .agents/notes/archived/process/2026-09-09-blocked-weighted-approvals-remain-pending.md
- Purpose: Keep an unmet merge condition distinguishable from a failed policy evaluation.
- Key abstractions: weighted approval points, effective `CHANGES_REQUESTED` reviews, commit statuses `pending`/`success`/`error`.
- Data flow: a completed evaluation publishes `pending` when the PR is a draft, is short of the required points, or has an effective blocking review from a write-capable reviewer; a blocking review **dominates** the point total; `success` requires ready + threshold met + no blocker.
- Non-obvious design decisions: publishing `failure` for a blocking review was rejected because it represents a reversible merge condition as a malfunction and conflates policy outcome with publisher health; letting points override a blocker would permit success while a reviewer still requests changes.
- Edge cases / failure handling: an evaluation failure publishes an `error` commit status and fails the separate `weighted approval publisher` job, so the operational signal survives.
- Surprising: required-status branch rules still block the PR, because `pending` does not satisfy a required status.

### .agents/notes/archived/process/2026-09-09-blocked-weighted-approvals-remain-pending.zh.md
Chinese translation of the blocked-approvals-pending note.

### .agents/notes/archived/process/2026-09-09-cancel-superseded-ci.i18n.yaml
Consistency record for the cancel-superseded-CI note.

### .agents/notes/archived/process/2026-09-09-cancel-superseded-ci.md
- Purpose: Spend runner capacity on the newest validation, not on superseded revisions.
- Key abstractions: `cancel-in-progress: true` with the group key `${{ github.workflow }}-${{ github.ref }}`, `${{ !inputs.release }}`, `${{ !cancelled() && github.event_name == 'pull_request' }}`.
- Data flow: CI, CI master, real-API e2e and the credential-free dsh/vendor pack validations cancel older runs in the same workflow/ref group; different refs and different workflows never cancel each other; event type is deliberately **not** part of the group.
- Non-obvious design decisions: the PR aggregate uses an explicit status function so it still evaluates after failed/skipped dependencies rather than accepting GitHub's success-only default; coverage history uses `!cancelled()` so a *failed* coverage run still uploads its measurements while a cancelled one does not; Wine's `always()` cleanup is retained as resource cleanup, not bookkeeping.
- Edge cases / failure handling: release-owned builds are exempt because they belong to an intentional publication transaction; cancellation is a request to GitHub Actions, not a guarantee of immediate termination; standby drills can now be repeatedly cancelled, so operators must check the age and commit of the last completed drill.
- Surprising: the note explicitly **reverses** the cancellation exemption in the failover runbook, master-only platform CI and real-API e2e decisions.

### .agents/notes/archived/process/2026-09-09-cancel-superseded-ci.zh.md
Chinese translation of the cancel-superseded-CI note.

### .agents/notes/archived/process/2026-09-10-approval-review-workflow-identity.i18n.yaml
Consistency record for the approval review workflow identity note.

### .agents/notes/archived/process/2026-09-10-approval-review-workflow-identity.md
- Purpose: Identify the review-event workflow reliably even when GitHub expands `run-name`.
- Key abstractions: `workflow_run.path`, `workflow_run.display_title`, `pull_requests` array.
- Data flow: the publisher matches the exact `workflow_run.path`, requires a successful `pull_request_review` run, parses the PR number from `display_title`, validates any supplied PR association, and compares the current PR head with the reviewed head before evaluating approvals.
- Non-obvious design decisions: accepting a name prefix was rejected because a display name does not identify the workflow file and another workflow can share the title; the numbered run title was kept because it supplies the PR number when GitHub returns an empty `pull_requests` array.
- Edge cases / failure handling: an unexpected workflow file still fails validation; moving the review-event workflow requires updating the publisher's expected path.
- Surprising: the whole bug was that GitHub can populate a run's `name` with its expanded `run-name`, so a static-name comparison rejected valid review events.

### .agents/notes/archived/process/2026-09-10-approval-review-workflow-identity.zh.md
Chinese translation of the approval review workflow identity note.

### .agents/notes/archived/process/2026-09-11-independent-libreoffice-package.i18n.yaml
Consistency record for the independent LibreOffice package note.

### .agents/notes/archived/process/2026-09-11-independent-libreoffice-package.md
- Purpose: Distribute a precompiled LibreOffice engine without making every build compile it.
- Key abstractions: `native/libreoffice-wasm` with its own version and an asset-only manifest export, an out-of-workspace source directory, a build receipt.
- Data flow: installation has no lifecycle hook and packaging verifies an existing successful build without compiling; the release workflow compiles only on explicit dispatch and requires a matching engine version tag plus the protected npm environment.
- Non-obvious design decisions: each tarball carries the engine manifest and assets, the source pins, patches, the **full source diff**, and the built distribution's license and notices — so a consumer can audit the artifact's provenance.
- Edge cases / failure handling: packaging rejects mismatched build receipts, modified assets, unlisted engine files, missing notices and bundled fonts; a failure never triggers compilation automatically; a source tree differing from its recorded recipe cannot produce a release tarball.
- Surprising: the package exposes *files* rather than a conversion API — the provider retains runtime ownership.

### .agents/notes/archived/process/2026-09-11-independent-libreoffice-package.zh.md
Chinese translation of the independent LibreOffice package note.

### .agents/notes/archived/process/2026-09-11-production-blame-approval-weight.i18n.yaml
Consistency record for the blame-weighted approval note.

### .agents/notes/archived/process/2026-09-11-production-blame-approval-weight.md
- Purpose: Scale an approval's weight by how much of the changed production code the reviewer authored.
- Key abstractions: `min(2, 1 + 4 × ownedLines / totalLines)`, merge-base blame, a maintained comment/code lexer, batched commit-author lookups.
- Data flow: the merge base supplies both classification and blame; GitHub associates blame commits with reviewer accounts; ownership of 0% gives one point, 12.5% gives 1.5, ≥25% gives two; scores are not rounded before the two-point comparison.
- Non-obvious design decisions: the publisher marks the head **pending before dependency setup and evaluation**, so an interrupted history fetch cannot preserve an earlier success; unlinked authors stay in the denominator; additions have no prior owner and contribute no lines, so an empty denominator produces no boost.
- Edge cases / failure handling: full history is required before selecting the merge base, because a shallow apparent ancestor could exclude changes from the denominator; evaluation errors retain the `error` status rather than silently awarding or withholding the boost; blame measures last-touch authorship, not review quality.
- Surprising: author lookups were done by matching display names or emails — rejected, because display names are not account identifiers and one account can own commits under several emails.

### .agents/notes/archived/process/2026-09-11-production-blame-approval-weight.zh.md
Chinese translation of the blame-weighted approval note.

### .agents/notes/archived/process/2026-09-12-experimental-publication-denylist.i18n.yaml
Consistency record for the experimental publication denylist note.

### .agents/notes/archived/process/2026-09-12-experimental-publication-denylist.md
- Purpose: Make experimental packages publish by default, with an explicit private exception list.
- Key abstractions: `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` (`scripts/experimental-package-policy.ts`), the `@deepseek-ai/dsh-experimental-*` npm prefix.
- Data flow: the local npm baseline publisher and the public dsh release family discover experimental packages by default; workspace constraints require public packages to omit `private` and set `publishConfig.access: public`.
- Non-obvious design decisions: the default is inverted from "allowlist" to "denylist" — a *public allowlist* was rejected because every new public experimental package needs a policy edit even though the default publication path can discover it; the denylist is currently empty.
- Edge cases / failure handling: adding a private prototype requires a denylist entry **and** a private manifest; workspace validation rejects manifests that disagree with the policy.
- Surprising: publication grants neither stability nor a support promise.

### .agents/notes/archived/process/2026-09-12-experimental-publication-denylist.zh.md
Chinese translation of the experimental publication denylist note.

### .agents/notes/archived/process/2026-09-12-maintained-repository-references.i18n.yaml
Consistency record for the maintained repository references note.

### .agents/notes/archived/process/2026-09-12-maintained-repository-references.md
- Purpose: Keep concrete commit hashes and organization URLs out of maintained files.
- Key abstractions: `scripts/verify-repository-references.ts`, git object-type verification, `native/system/scripts/pack-release.mjs` workflow-repository projection.
- Data flow: the gate scans tracked files and nonignored new files, resolves hexadecimal candidates against the local git object database, and rejects only unambiguous **commit** identities; release tags and PR/run/job ids are used for historical evidence; relative links are used for current repository files.
- Non-obvious design decisions: rejecting every hex string was rejected (persistence schemas and bilingual pairing legitimately use hashes); checking only new diff lines was rejected because the policy applies to every maintained file; during workflow packing the native packer projects the workflow repository into disposable inputs so npm trusted publishing can still verify identity without the source literal.
- Edge cases / failure handling: the gate disables network fetching including git partial-clone lazy fetching, so absent objects cannot match; a checkout with extra PR objects can therefore detect references CI's full-history clone would miss.
- Surprising: hex **branch names** that resolve to a different object identity remain valid, and blob-identifying pairing hashes are explicitly allowed.

### .agents/notes/archived/process/2026-09-12-maintained-repository-references.zh.md
Chinese translation of the maintained repository references note.

### .agents/notes/archived/process/2026-09-12-publish-all-experimental-packages.i18n.yaml
Consistency record for the publish-all-experimental-packages note.

### .agents/notes/archived/process/2026-09-12-publish-all-experimental-packages.md
- Purpose: Give npm consumers the experimental packages without promoting their APIs.
- Key abstractions: packed-consumer tests, `lib/worker.js` in the Inspector tarball, the WebWorker packer's module-proxy tables.
- Data flow: every package under `packages/experimental/` publishes with `private` omitted and `publishConfig.access: public`; the built-artifact test packs and extracts the package *before* starting the Worker, and the packed-consumer test imports both extracted tarballs under plain Node.
- Non-obvious design decisions: "source-checkout tests alone do not establish that their tarballs contain the runtime files and imports needed by installed consumers" — so the checks are done against the **packed** artifact, not the source tree.
- Edge cases / failure handling: the CPython PTC backend still needs a supported external interpreter on Unix; the packer's repository CLI still requires its documented built checkout; publication adds nothing to any shipped profile.
- Surprising: changing only the manifest access fields would have shipped an Inspector without its Worker and a WebWorker packer importing source files absent from the runtime tarball.

### .agents/notes/archived/process/2026-09-12-publish-all-experimental-packages.zh.md
Chinese translation of the publish-all-experimental-packages note.

### .agents/notes/archived/process/2026-09-15-pr-approval-delegation.i18n.yaml
Consistency record for the PR approval delegation note.

### .agents/notes/archived/process/2026-09-15-pr-approval-delegation.md
- Purpose: Let a reviewer hand their decision to another reviewer for one PR without inflating the score.
- Key abstractions: `/delegate @username` in PR comments, the sender's weight applied to the recipient's effective approval, once, GitHub review dismissal.
- Data flow: the latest surviving eligible command in comment-creation order picks the recipient; edited commands require the latest editor's immutable account id to equal the author's; every evaluation reconciles active eligible commands, dismissing prior decision reviews and requesting recipients who have not already approved or been requested.
- Non-obvious design decisions: received points **cannot be forwarded** (otherwise a recipient could transfer another person's points to an account that person never named); the sender's prior reviews are *dismissed through GitHub* rather than merely ignored in the score, so native review state stays consistent with the handoff; delegation does not persist outside comments because comments already provide an inspectable record that recomputes on edits and deletions.
- Edge cases / failure handling: a self-delegation or a later submitted review restores the sender's own decision; comment-only reviews reclaim the points, pending ones do not; equal timestamps favour the review; dismissal failures fail evaluation while request failures are logged and retried later; closed/merged PRs are skipped before status writes.
- Surprising: dismissal "retains the old submission timestamps and cannot cancel delegation", and removing the recipient's approval removes the counted points while retaining the delegation for their next approval.

### .agents/notes/archived/process/2026-09-15-pr-approval-delegation.zh.md
Chinese translation of the PR approval delegation note.

### .agents/notes/archived/process/2026-09-16-author-approval-credit.i18n.yaml
Consistency record for the author approval credit note.

### .agents/notes/archived/process/2026-09-16-author-approval-credit.md
- Purpose: Let an established author's contribution history contribute approval points.
- Key abstractions: `0.011` points per merged PR, capped at `1.1` after 100 PRs.
- Data flow: history lookup stops at 100 matching PRs; the credit is added to the approval score.
- Non-obvious design decisions: the previous 0.6-point cap at 150 PRs was rejected because it could not combine with an ordinary one-point review to meet the two-point requirement.
- Edge cases / failure handling: author credit alone remains insufficient and blocking reviews still prevent approval; the lower counting cap limits required history traversal for prolific authors.
- Surprising: at 91 merged PRs one ordinary approval meets the requirement, at 90 it yields only 1.99 — and the policy test covers "below-threshold scores whose display rounds to two".

### .agents/notes/archived/process/2026-09-16-author-approval-credit.zh.md
Chinese translation of the author approval credit note.

### .agents/notes/archived/process/2026-09-16-desktop-release-version-derivation.i18n.yaml
Consistency record for the Desktop release version derivation note.

### .agents/notes/archived/process/2026-09-16-desktop-release-version-derivation.md
- Purpose: Name Desktop test builds without losing the base release identity.
- Key abstractions: `.YYYYMMDD.index` (prerelease base) and `-test.YYYYMMDD.index` (stable base); a fixed Nightly feed address.
- Data flow: production publishes the dsh base; a test build derives a dated, indexed version from that base, and the derived version is passed to packaging as an argument rather than written into manifests.
- Non-obvious design decisions: replacing `alpha`/`beta`/`rc` with `nightly` was rejected because it discards the base prerelease and can sort above later releases, blocking updates to the intended line; the feed is a **distribution address, independent of version derivation**, so installed clients keep using it.
- Edge cases / failure handling: enabling a global downgrade to repair a mis-numbered release was rejected as an ordinary-update-safety change — affected installations use a manual installer.
- Surprising: a date alone cannot distinguish multiple test builds of the same base, hence the index.

### .agents/notes/archived/process/2026-09-16-desktop-release-version-derivation.zh.md
Chinese translation of the Desktop release version derivation note.

### .agents/notes/archived/process/2026-09-19-evidence-led-simplification-surveys.i18n.yaml
Consistency record for the evidence-led simplification survey note.

### .agents/notes/archived/process/2026-09-19-evidence-led-simplification-surveys.md
- Purpose: Replace call-count-driven simplification with producer-to-outcome tracing, and measure whether the new skill actually finds more.
- Key abstractions: the `dsh-find-simplifications` skill, an optional `references/historical-patterns.md`, bounded survey arms (baseline vs revised) over three owner domains, SHA-256-pinned frozen inputs.
- Data flow: each arm uses fresh agents with the same inherited model and reasoning effort, identical owner domains, a time cap and at most four submissions per domain; discovery agents cannot see other outputs; review applies the same criteria to every submission and distinguishes local edits from durable decisions.
- Non-obvious design decisions: the author derived the revision from historical notes while **isolated from current candidates**, and the coordinator accepted it unchanged; candidate packets hid arm labels from the reviewer, although the coordinator's integration was not blind; a third exploratory domain was added *after* the initial results and is kept separate from the declared two-domain comparison.
- Edge cases / failure handling: the sample shows **no higher durable-proposal yield** from the revision, so the revision is not claimed superior; the union of both arms (nine distinct durable proposals) is the deliverable; one behaviour reduction was deferred because a prior budget decision had fixed a real problem and no new workload evidence justified reversing it.
- Surprising: the note states plainly that "one discovery run per version/domain, no randomized order or repetition, unequal actual elapsed time within equal caps, and subjective review" — the results establish neither statistical superiority nor reproducible speedup.

### .agents/notes/archived/process/2026-09-19-evidence-led-simplification-surveys.zh.md
Chinese translation of the evidence-led simplification survey note.

### .agents/notes/archived/process/2026-09-21-desktop-build-version-as-input.i18n.yaml
Consistency record for the Desktop build-version-as-input note.

### .agents/notes/archived/process/2026-09-21-desktop-build-version-as-input.md
- Purpose: Make a build's version an input rather than a repository mutation.
- Key abstractions: `--build-version`, `--build-version auto`, electron-builder `extraMetadata`, `dshBuildCommit` / `dshBuildDirty`, `semver.gt`.
- Data flow: the version reaches electron-builder, the update feed and the upload validation as one input; manifests keep the product version, so no packaging run modifies tracked files; the upload reads the published version from the completion record packaging wrote, not from a variable.
- Non-obvious design decisions: rewriting manifests and reverting was rejected because a revert races anything else reading the workspace and leaves the published artifacts describing a state the repository no longer has; `auto` prints what it chose rather than being the default, because operators confirm the version with the user first.
- Edge cases / failure handling: `auto` contacts the destination bucket even under `--check` and falls back to the local output directory when the listing cannot complete in time — a **partial listing is discarded** rather than risking a reused index overwriting a published installer; a failed tag step reports the command to run by hand instead of failing an upload that already completed; a dirty checkout is not tagged.
- Surprising: the old flow rewrote the version in **295 files** (release-family manifests plus the lockfile) for every test build and left the tree dirty.

### .agents/notes/archived/process/2026-09-21-desktop-build-version-as-input.zh.md
Chinese translation of the Desktop build-version-as-input note.

### .agents/notes/archived/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.i18n.yaml
Consistency record for the Desktop main-bundle ordering note.

### .agents/notes/archived/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.md
- Purpose: Stop a clean checkout from producing a Desktop main bundle with three unresolved imports.
- Key abstractions: the root tsdown `workspace` list, `Promise.all` over resolved configs (tsdown 0.22), the `desktop-bundle-imports` rolldown plugin, electron-builder's `dependencies`-only `app.asar/node_modules` copy.
- Data flow: `apps/desktop` leaves the root tsdown list; `build:lib:host` runs the Host pass then `pnpm --filter @deepseek-ai/dsh-desktop run bundle`, so the main bundle resolves workspace `lib/` outputs that already exist; the plugin's `moduleParsed` hook fails the build when a module imports a bare specifier the packaged app cannot resolve (static import, dynamic `import()`, or `require()`).
- Non-obvious design decisions: the plugin reads each module's **import records** (external imports keep a bare specifier, bundled ones carry an absolute id) because chunk metadata (`imports`/`dynamicImports`) omits external `import()`/`require()` targets; the check names the *requirement* rather than the symptom, so it also catches a workspace package misdeclared as a devDependency and a broken `exports` entry; declaring the three packages as runtime `dependencies` was rejected because `dsh-app-boot` would duplicate a large tree already inside the packed dsh runtime.
- Edge cases / failure handling: `clean: false` in both configs is what hid the defect on previously-built trees; a rejected bundle writes no output; the sandboxed preload is allowed only `electron`, `events`, `timers`, `url`.
- Surprising: the broken bundle was **smaller** (189 KB vs 315 KB) and the packaging run still passed every existing check, because the runtime-payload smoke exercises the dsh runtime, not the Electron main process.

### .agents/notes/archived/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.zh.md
Chinese translation of the Desktop main-bundle ordering note.

### .agents/notes/archived/process/2026-09-22-workspace-release-ranges.i18n.yaml
Consistency record for the workspace release ranges note.

### .agents/notes/archived/process/2026-09-22-workspace-release-ranges.md
- Purpose: Pick the published dependency range per release family.
- Key abstractions: `workspace:*` for DSH targets, `workspace:~` for `vendor/` and the `native/system` family.
- Data flow: packing substitutes the target package's current version — `workspace:~` becomes `~4.0.3` for Cordis at `4.0.3` and `~0.1.2` for Node Addon System at `0.1.2`; DSH references stay exact.
- Non-obvious design decisions: caret ranges were rejected because they also admit later minor versions for stable packages like Cordis; exact ranges were rejected because each patch release would need a consumer declaration change; directory placement never exempts a consumer.
- Edge cases / failure handling: the workspace gate rejects DSH tilde ranges and vendor/native caret or exact ranges; packed-manifest tests check the emitted versions.
- Surprising: native family members still share one release version while an installed entry may resolve a later platform patch.

### .agents/notes/archived/process/2026-09-22-workspace-release-ranges.zh.md
Chinese translation of the workspace release ranges note.

### .agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.i18n.yaml
Consistency record for the section-keyed translation pairing note.

### .agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.md
- Purpose: Make the bilingual consistency record merge cleanly under Git's default text merge.
- Key abstractions: `foo.i18n.yaml` with one entry per heading section, English heading-slug path keys (`/plugin-config-catalog/loadable-plugins-with-no-config`, `/`, `~2`, `~3`), 16-hex SHA-256 prefixes, three-line entries (key / `en:` / `zh:`), generated regions, `scripts/translation-pairing-record.ts`.
- Data flow: both sides are split at every heading; section `i` of English corresponds to section `i` of Chinese; a heading-count mismatch is a structure error; each side's hash covers the section's top-level blocks after paired-document link localization, excluding fenced code blocks and generated regions; generators write their data into regions and into both pages, so regeneration changes neither the record nor the Chinese prose.
- Non-obvious design decisions: whole-file hashes plus a local merge driver were rejected (≈1,400 lines to maintain, and GitHub never runs the driver, so PRs still showed conflicts); positional keys (`h2[3]`) were rejected because insertion renumbers every later key; hosted automation was rejected because a record Git's default text merge composes needs no credentials; byte-identical blocks were *not* excluded, because that would silently exempt untranslated English paragraphs.
- Edge cases / failure handling: a record conflict now requires both branches to change hashed content **in the same section**; archived Agent Notes keep their sealed whole-file records under `verify-archived-agent-notes`.
- Surprising: the note reports a **replayed measurement** over 2,016 merge commits: the old format conflicted in 2,950 pair merges, the section-keyed format in 1,586 (a 46% reduction per pair); merge commits whose only conflicts were records fell from 512 to 257.

### .agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.zh.md
Chinese translation of the section-keyed translation pairing note.

### .agents/notes/archived/simplification/2026-06-19-drop-mutable-session-summary.i18n.yaml
Consistency record for the mutable-session-summary deletion note.

### .agents/notes/archived/simplification/2026-06-19-drop-mutable-session-summary.md
- Purpose: Delete a mutable session-summary layer that no production code used.
- Key abstractions: `SessionHeader` vs `SessionSummary`, `SessionMeta = SessionHeader & SessionSummary`, `SessionPersistence.update(id, summary)`, the JSONL `.summary.json` sidecar.
- Data flow: each backend implemented the mutable store its own way (JSONL sidecar with temp-write + rename, SQLite columns bumped inside the append transaction); the removal narrows the public contract and the JSONL on-disk format to `SessionHeader` plus the append-only log.
- Non-obvious design decisions: the removal is justified by an **audit of the whole repo** — `SessionPersistence.update()` had zero production callers (every `.update(` hit was `createHash().update()` or a test), `firstPrompt` was never read, and `Session.header` was already typed `SessionHeader`, so the summary never existed on the live session object.
- Edge cases / failure handling: no migration path exists because the shipped provider never wrote a mutable summary; the JSONL-only persistence decision owns the compatibility cut for databases written by the removed provider.
- Surprising: the note records the transferable principle — "**a passing test pins current behavior, not necessarily correct behavior; behavior can be an artifact of a past compromise**" — now a standalone convention in the root AGENTS.md.

### .agents/notes/archived/simplification/2026-06-19-drop-mutable-session-summary.zh.md
Chinese translation of the mutable-session-summary deletion note.

### .agents/notes/archived/simplification/2026-06-20-collapse-trace-only-session-events.i18n.yaml
Consistency record for the trace-only session event collapse note.

### .agents/notes/archived/simplification/2026-06-20-collapse-trace-only-session-events.md
- Purpose: Fold trace-only session events into the load-bearing events consumers already read.
- Key abstractions: `assistant/message { turn, step, content, usage? }`, `turn/end.reason { kind: 'error', step, message, code? }`, `deriveMessages()`.
- Data flow: successful-step usage folds into the matching `assistant/message`; a failed/aborted step with usage but no content carries the usage on an empty-content `assistant/message { content: [], usage }`; the standalone `error` event's step number folds into `turn/end.reason`.
- Non-obvious design decisions: the simplification is explicitly "not to record less information" — `deriveMessages()` skips empty-content assistant messages so the empty event does not inject a spurious content-less assistant turn into the provider transcript, and a regression test asserts usage stays represented *and* derived history stays uncorrupted.
- Edge cases / failure handling: `agent/error` and logging stay for live diagnostics; there is no second session-log error record after `turn/end`.
- Surprising: `usage` already existed as a model stream chunk, so the loop was recording the same fact twice.

### .agents/notes/archived/simplification/2026-06-20-collapse-trace-only-session-events.zh.md
Chinese translation of the trace-only session event collapse note.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.i18n.yaml
Consistency record for the `llm/adapter-change` deletion note.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md
- Purpose: Remove a declared-and-emitted event with no production listener.
- Key abstractions: `LlmService.registerAdapter()`, the effect-generator rollback disposer, the `dsh-llm` `interface Events` taxonomy.
- Data flow: `registerAdapter()` used to yield its rollback disposer *before* emitting so a throwing listener would unwind the mutation instead of leaking an adapter entry; with the event gone the disposer stays (for HMR/disposal) but the listener-throw ordering goes.
- Non-obvious design decisions: `tools/change` and `system-prompt/change` are deliberately **kept** even though they are also unconsumed — they are plausible registry-change signals for a future live tool/prompt UI, whereas adapter registration is a boot-time implementation detail and the real interception seam is `llm/stream`.
- Edge cases / failure handling: the adapter-disposer test now asserts the disposer removes the adapter without subscribing; the listener-throw rollback test is removed with its subject.
- Surprising: "declared and emitted" is not "consumed" — and the removal retires a standing correctness invariant that guards a consumer that does not exist.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.zh.md
Chinese translation of the `llm/adapter-change` deletion note.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-assembled-surfaces.i18n.yaml
Consistency record for the assembled LLM surface deletion note.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-assembled-surfaces.md
- Purpose: Reduce the LLM service to one public call surface.
- Key abstractions: `stream()` vs `streamBlocks()` vs `generate()`, the `llm/stream` and `llm/generate` waterfalls, `BlockAssembler`.
- Data flow: the agent loop is the only production consumer and uses `stream()` exclusively — feeding raw chunks through its **own** `BlockAssembler` so it can log chunks for replay fidelity while assembling in parallel.
- Non-obvious design decisions: keeping `generate()` as a test-only convenience was rejected — adapter tests hand-draining `stream()` exercise the same path production uses, and "a public method whose only callers are tests is exactly the dead-surface shape" the summary precedent retired; the twin-adapter design is untouched because both twins shed the surface together.
- Edge cases / failure handling: `BlockAssembler` retains only the operations with production consumers (`push`/`message`/`usage`/`finish`); the `flushReady`/`flushRemaining` helpers and the `flushed` cursor exist only for `streamBlocks`.
- Surprising: the ACP snapshot expected outputs are unchanged by the removal, i.e. the loop's behaviour is byte-identical.

### .agents/notes/archived/simplification/2026-06-20-drop-unconsumed-llm-assembled-surfaces.zh.md
Chinese translation of the assembled LLM surface deletion note.

### .agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.i18n.yaml
Consistency record for the dead seam-method pruning note.

### .agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.md
- Purpose: Remove capability-seam methods that no consumer programs against.
- Key abstractions: `SessionPersistence` (`create`/`append`/`load`/`list`/`has`/`delete`), `PersistenceBackend.deleteStored`, the dual-backend design.
- Data flow: `has()` added a tracked-vs-untracked coordinator probe and a contract branch although `loadStored(id)` already owns durable existence checks; `delete()` dragged a backend hook every backend had to implement.
- Non-obvious design decisions: "the seam should be complete" was explicitly rejected as the speculative completeness the pre-release stance warns against — `delete()` is one method to re-add the day a consumer needs it, designed against that UI's real needs (soft-delete? cascade? confirmation?), and re-adding against a live consumer is better because the consumer pins the contract.
- Edge cases / failure handling: `BashExecutor.get()`/`.list()` were **kept** (their removal needed substantially more completion-tracking machinery in consumers); the removal is confined to the seam, its impl and its tests.
- Surprising: the note's implementation note is a miniature scope audit — the proposed change was larger than the shipped change.

### .agents/notes/archived/simplification/2026-06-20-prune-dead-seam-methods.zh.md
Chinese translation of the dead seam-method pruning note.

### .agents/notes/archived/simplification/2026-06-20-public-agent-stop-api.i18n.yaml
Consistency record for the single-stop-primitive note.

### .agents/notes/archived/simplification/2026-06-20-public-agent-stop-api.md
- Purpose: Collapse two overlapping stop verbs into one.
- Key abstractions: `Agent.cancel(cause, options?)` with typed `user`/`parent` causes and `keepInbox`, `AgentHandle.dispose()`, `Agent.whenIdle()`.
- Data flow: the loop owns one private cancellation holder for the whole turn; `cancel`'s broad default drops pending input while `keepInbox` aborts the active turn and retains pending work; the disposer is async and waits for the loop to stop.
- Non-obvious design decisions: `whenIdle()` is **retained** — the original proposal removed it, and that was reversed on validating the premise against the code, because it is a load-bearing quiescence primitive that safely handles waiter-settlement and replacement-turn races; the production ACP bridge owns its agents and tears them down through `AgentHandle.dispose()`, so `packages/acp/acp/src` itself never calls `whenIdle()`.
- Edge cases / failure handling: tests exercise cancellation through the public typed cause and explicit signal APIs rather than reaching into the holder; a plugin can no longer abort only one model/tool step while leaving the turn running.
- Surprising: the delivery surface ends as `followup()`, `steer()`, `inject()`; stopping and observation are `cancel()` and `whenIdle()`.

### .agents/notes/archived/simplification/2026-06-20-public-agent-stop-api.zh.md
Chinese translation of the single-stop-primitive note.

### .agents/notes/archived/simplification/2026-06-20-remove-agent-boundary-mirror-events.i18n.yaml
Consistency record for the agent boundary-mirror removal note.

### .agents/notes/archived/simplification/2026-06-20-remove-agent-boundary-mirror-events.md
- Purpose: Make the session log the single source of truth for turn/step boundaries.
- Key abstractions: `session/event` as the one live transcript stream; the mirrors `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`.
- Data flow: consumers render turns, tool calls, results, assistant messages and durable boundaries from `session/event`; a UI needing the live handle retains the target object from `agent/created`/`agent/disposed` and compares its session directly (`dsh-ui-stdio` labels the app-owned agent `[main turn N]`).
- Non-obvious design decisions: the note finishes a job its predecessor deferred — the earlier decision kept the turn mirrors because "the stdio UI needed the `Agent` handle", and that is rejected here because `dsh-ui-stdio` is a disposable test REPL; `agent/queued` is deliberately **live-only** because it fires before any durable event exists (cancelled queued work may never enter the log).
- Edge cases / failure handling: the duplicate boundary events made failure ordering subtle — a turn can be durably closed before a live `agent/turn-end` listener runs, so a post-boundary listener failure has no valid in-log position and must be reported out of band.
- Surprising: every lifecycle change had to update the session event, the mirror event, docs, invariants, tests and snapshot expectations.

### .agents/notes/archived/simplification/2026-06-20-remove-agent-boundary-mirror-events.zh.md
Chinese translation of the agent boundary-mirror removal note.

### .agents/notes/archived/simplification/2026-06-26-fsspec-style-fs-seam.i18n.yaml
Consistency record for the fsspec-style filesystem seam note.

### .agents/notes/archived/simplification/2026-06-26-fsspec-style-fs-seam.md
- Purpose: Split the filesystem seam into tool / policy / provider-contract / provider layers.
- Key abstractions: `dsh-tool-fs` (executor), `dsh-fs-observation-policy` (gate plugin), `dsh-fs` (provider contract), `dsh-fs-local` (provider); `FsWriteIntent` = `createIfAbsent` | `replaceIfVersion`; `FsInfo { version, type, size }`.
- Data flow: a mutation dispatches `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` → `ctx.fs.writeText(target, content, intent)` → `ctx.emit('fs/observed', …)`; the plugin answers `fs/write-intent` with an intent, `fs/edit-intent` with the observed version, and records `fs/observed` in a `WeakMap<owner, Map<targetKey, FsVersion>>`.
- Non-obvious design decisions: the seam is deliberately a **text-storage** seam, half a level above byte-level fsspec, so UTF-8 decoding, binary/NUL rejection and guarded mutations live once in the provider; the plugin registers no `ctx.*` key and injects nothing, so `dsh-tool-fs` is not method-coupled to it and the whole policy layer vanishes when the plugin is absent; the stale check happens **before** literal matching so an old read reports `FS_STALE_VERSION` rather than `FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT`.
- Edge cases / failure handling: in-process updates and creates are serialized by a per-target mutation lock (one-wins/one-stale); cross-process creates are best-effort only, and cross-process writes are `mtime:size` freshness plus atomic replacement, so same-tick same-size writes can be missed; a direct `ctx.fs.readText` emits no `fs/observed`, so a later `edit` rejects with `FS_NOT_OBSERVED` until the file is read through the `read` tool.
- Surprising: the old `full`/`partial` view rule created a UX dead end — a model reading lines 100–150 of a large file could not edit line 120 because a partial view could not authorize an edit.

### .agents/notes/archived/simplification/2026-06-26-fsspec-style-fs-seam.zh.md
Chinese translation of the fsspec-style filesystem seam note.

### .agents/notes/archived/simplification/2026-07-02-remove-stream-chunk-mirror.i18n.yaml
Consistency record for the stream-chunk mirror removal note.

### .agents/notes/archived/simplification/2026-07-02-remove-stream-chunk-mirror.md
- Purpose: Stop mirroring the token stream as a live agent event.
- Key abstractions: durable `assistant/chunk { turn, step, chunk }` vs live `agent/stream-chunk(agent, turn, step, chunk)`, `session/event`.
- Data flow: the loop appended the durable chunk event and, one line later, emitted the identical payload as a Cordis event; the token stream is now read off `session/event` and filtered for `assistant/chunk`.
- Non-obvious design decisions: the two lines sat **one line apart** in `packages/core/agent-loop/src/agent.ts`; the mirror's only added value was the live `Agent` handle and its sole consumer discarded it (`(_agent, _turn, _step, chunk)`); the inverse cut — stop persisting chunks — was rejected because high-fidelity replay, partial failed streams and snapshot replay all depend on the persisted feed.
- Edge cases / failure handling: the automation-only ACP bridge emits committed `assistant/message` text rather than raw chunks, so it needs neither event; plugins needing the live object look it up via `ctx.agents.get(session.id)`.
- Surprising: `agent/steering` was explicitly out of scope for this decision and was removed by its own follow-up — the notes are careful to bound their own cut.

### .agents/notes/archived/simplification/2026-07-02-remove-stream-chunk-mirror.zh.md
Chinese translation of the stream-chunk mirror removal note.

### .agents/notes/archived/simplification/2026-07-04-drop-image-content-block.i18n.yaml
Consistency record for the image-content-block deletion note.

### .agents/notes/archived/simplification/2026-07-04-drop-image-content-block.md
- Purpose: Remove a content-block type no path could honour.
- Key abstractions: `ImageBlock`, `ContentBlockMap`, the DeepSeek adapter serializer, the pi-ai converter, the compaction estimator.
- Data flow: the DeepSeek serializer skipped image blocks (a documented MVP limitation), the pi-ai converter skipped them as unrepresentable, the compaction estimator charged a flat token constant and rendered `[image]`, and ACP independently rejected image prompt content.
- Non-obvious design decisions: the vocabulary advertised a capability no path honoured — "the silent-data-loss shape AGENTS.md's defensive patterns warn against"; the documented fallback if the slot returns is to keep `ImageBlock` but replace every silent skip with a **loud rejection**.
- Edge cases / failure handling: unknown extension blocks still exercise default branches, covered by plugin-defined block types; ACP's inbound-image rejection stays tested independently.
- Surprising: the only constructors of `ImageBlock` anywhere were tests pinning the skip/drop/estimate branches.

### .agents/notes/archived/simplification/2026-07-04-drop-image-content-block.zh.md
Chinese translation of the image-content-block deletion note.

### .agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.i18n.yaml
Consistency record for the inert request-knob deletion note.

### .agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md
- Purpose: Delete two request knobs that rode the whole pipeline but could do nothing.
- Key abstractions: `GenerateOptions.prefill`, `ToolSchema.strict`, the twin-adapter design, `agent/request` waterfall.
- Data flow: `prefill` had no production setter and both adapters threw `LlmError('UNSUPPORTED')` on it; `strict` was threaded through `defineTool`, the registry's `schemas()` allowlist, the deepseek wire mapping, a pi-ai payload-patching pass and the tool-catalog renderer — but no shipped tool set it (`rg` over every `tool-*` package found zero producers).
- Non-obvious design decisions: an explicit UNSUPPORTED throw is "honest contract behavior", but deleting the knob **upgrades the failure mode** from a runtime throw to a compile error; `temperature`/`stop`/`maxTokens` are deliberately untouched because they are honoured end-to-end and are the natural first targets of an `agent/request` mutating hook.
- Edge cases / failure handling: pi-ai stamps `strict: false` on every serialized tool, so the unconditional scrub survives for wire parity, pinned by the serializer test; the type-equiv manifest keeps both symbols since each type survives minus a field.
- Surprising: DeepSeek's chat-prefix completion is a Beta feature on a base URL **neither adapter targets**.

### .agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.zh.md
Chinese translation of the inert request-knob deletion note.

### .agents/notes/archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.i18n.yaml
Consistency record for the web observation-surface deletion note.

### .agents/notes/archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.md
- Purpose: Remove the web seam's unconsumed observation surface.
- Key abstractions: `web/providers-change`, `searchStatus()`/`fetchStatus()`, `WebCapabilityStatus`, `WebError` codes.
- Data flow: `dsh-tool-web` executes through `ctx.web.search()`/`fetch()` and surfaces unavailability as the structured `WebError` codes the seam throws at execution time; provider selection resolves at execution time and is never cached.
- Non-obvious design decisions: the seam's own design starved both surfaces — registration follows product ENABLEMENT, not provider availability, so there is no cache to invalidate, no registration set to recompute and no caller that needs an availability probe distinct from executing and routing the structured error; the README sentence claiming the tool "reads only the aggregated `searchStatus()`/`fetchStatus()`" had **drifted** because nothing checks prose against call sites.
- Edge cases / failure handling: HMR cleanup is carried by the effect disposers themselves, so removing the rollback-before-emit ordering loses nothing.
- Surprising: this is the same judgment as the `llm/adapter-change` removal applied to a pull surface instead of a push surface, and the note cites AGENTS.md's "Agent Notes are proposals, not golden truth".

### .agents/notes/archived/simplification/2026-07-04-drop-unconsumed-web-observation-surface.zh.md
Chinese translation of the web observation-surface deletion note.

### .agents/notes/archived/simplification/2026-07-04-fold-stdio-ui-helper.i18n.yaml
Consistency record for the stdio-UI-helper fold note.

### .agents/notes/archived/simplification/2026-07-04-fold-stdio-ui-helper.md
- Purpose: Move a single-consumer helper package into the app that owns its front door.
- Key abstractions: `@deepseek-ai/dsh-ui-stdio` → `@deepseek-ai/dsh-stdio`, `createStdioChat`, the `StdioRuntime` test seam, the `name`/`inject`/`Config`/`apply` plugin export shape.
- Data flow: the examples reach the readline UI by loading the app, never by composing the helper; every other reference (manifest/tsconfig entries, module-graph rows, dependency-graph and README rows) existed *because* the package boundary existed.
- Non-obvious design decisions: promotion to `ui/` was rejected because the readline UI is not independently swappable and has no second composer; re-extraction stays cheap pre-release — split it out again when a second product app wants it.
- Edge cases / failure handling: EOF handling, rendering, disposal and piped-vs-TTY behaviour stay under the per-file coverage gate without hijacking process globals; the leaf `cordis.yml` still loads one app package.
- Surprising: the note is superseded by the later removal of the stdio and echo agents, which deletes the folded package entirely — archived notes are allowed to carry a superseding banner.

### .agents/notes/archived/simplification/2026-07-04-fold-stdio-ui-helper.zh.md
Chinese translation of the stdio-UI-helper fold note.

### .agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.i18n.yaml
Consistency record for the producer-less vocabulary pruning note.

### .agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md
- Purpose: Enforce the repository's own admission policy on merge-extensible vocabulary maps.
- Key abstractions: `TurnEndReasonMap` (the stated policy: a variant like `refusal` is "deliberately omitted until" an adapter or loop first emits it), `CacheHint` + `cache?: CacheHint`, `MessageSourceMap.agent`, `TurnTriggerMap.continuation`.
- Data flow: nothing constructed a block with `cache:` and neither adapter read `.cache` (DeepSeek caching is automatic, so the adapters map `prompt_cache_hit_tokens` *out* of responses but never send a hint *in*); the subagent backends send the parent's prompt with no `source`, so it logs as `{ kind: 'user' }`; the loop structurally cannot emit `continuation` because continuation happens *within* a turn as further steps.
- Non-obvious design decisions: reserved slots are contract surface every implementation and consumer must consider ("must my adapter honor `cache`? must my renderer route `agent` sources?") — so the bar is "if it is in the map, something produces it"; each variant returns the day it gains a real producer.
- Edge cases / failure handling: the one writer of `continuation` was a hand-built test fixture needing an arbitrary non-message trigger, which an `injection` trigger serves equally; the type-equiv manifest keeps both symbols since each map survives minus a member.
- Surprising: the `agent` message-source was a *silent* mis-attribution — the subagent's turn was logged as coming from a human.

### .agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.zh.md
Chinese translation of the producer-less vocabulary pruning note.

### .agents/notes/archived/simplification/2026-07-04-prune-write-only-fs-surface.i18n.yaml
Consistency record for the write-only fs surface pruning note.

### .agents/notes/archived/simplification/2026-07-04-prune-write-only-fs-surface.md
- Purpose: Remove fields populated on every call and read by nobody.
- Key abstractions: `STREAM_MIN_SIZE` / `FsIoInternals.streamMinSize`, `FsTarget.inputPath`, `FsEditOutcome.replacements`/`.replaceAll`, `FileReadOutcome.limit`/`.version`.
- Data flow: the fs seam split moved read routing into `dsh-tool-fs`, so the backend's copy of the 10 MiB bound was dead while the real one (`readStreamMinSize` compared against `info.size`) lives in the consumer; `inputPath` was a "diagnostics only" field every backend and test fake had to fabricate, while the policy plugin and every error message use `targetKey`/`displayPath`.
- Non-obvious design decisions: `FsEditOutcome` shrinks to `{ version, before, after }`, parallel to `FsWriteOutcome`'s genuinely backend-discovered fields; `replaceAll` is passed to `formatEditOutput` from the parsed args rather than echoed back from the backend.
- Edge cases / failure handling: the single-match policy stays — it is enforced by `FS_AMBIGUOUS_EDIT`/`FS_EDIT_NOT_FOUND` inside the backend, whose message keeps the internal count; `formatEditOutput`'s emitted text is unchanged for both `replace_all` branches, so no snapshot churned.
- Surprising: `listDir` exposed the semantic wobble — directory children got the bare entry name, which was nobody's "input".

### .agents/notes/archived/simplification/2026-07-04-prune-write-only-fs-surface.zh.md
Chinese translation of the write-only fs surface pruning note.

### .agents/notes/archived/simplification/2026-07-04-remove-agent-steering-mirror.i18n.yaml
Consistency record for the `agent/steering` mirror removal note.

### .agents/notes/archived/simplification/2026-07-04-remove-agent-steering-mirror.md
- Purpose: Remove the last transient mirror of a durable session event.
- Key abstractions: durable `steering/message { turn, content, source }` vs live `agent/steering(agent, turn, content, source)`, `agent/queued`.
- Data flow: the loop's steering drain appended the durable event and, on the very next line, emitted the identical payload; steering carries real traffic (the hook bridges' turn-continuation reasons land as durable `steering/message` events that hook-matrix expected outputs pin) and every one of those consumers observes the durable event.
- Non-obvious design decisions: the taxonomy's operative distinction is *mirrored-vs-live-only*, not control-vs-boundary — "it is a control signal, not a boundary" does not rescue a mirror; `agent/queued` remains live-only because it fires before persistence and covers work that may be cancelled before entering the log.
- Edge cases / failure handling: three implemented Agent Notes were amended to point at this removal, so the archive does not hold contradictory retention claims; the retargeted test now pins source preservation on the durable event.
- Surprising: the rejected "retire mid-turn steering" proposal defended the steering *capability* (`steer()`, the durable event, continuation forcing) — all of which this removal leaves untouched.

### .agents/notes/archived/simplification/2026-07-04-remove-agent-steering-mirror.zh.md
Chinese translation of the `agent/steering` mirror removal note.

### .agents/notes/archived/simplification/2026-07-04-share-app-bin-boot-glue.i18n.yaml
Generated bilingual-pair consistency record: the git blob hash of `2026-07-04-share-app-bin-boot-glue.md` and of its `.zh.md` twin, re-recorded with `pnpm run verify-translation-pairing --write`; it is the sealed whole-file form of the pairing record that proves the English and Chinese blocks match, and the pair is complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-04-share-app-bin-boot-glue.md
- Purpose: Deduplicate the environment-loading, fail-loud and boot glue that the `stdio` and `acp` bins had each copied, so the two copies cannot drift apart again.
- Key abstractions: `@deepseek-ai/dsh-app-boot` (`packages/ui/app-boot`) holding `resolveConfigPath`, `loadEnv`, `installFailLoud`, `assertEntriesLoaded` and `boot`, each parameterized by the bin's diagnostic prefix and injectable at its side-effect seams (the warn sink, the process slice).
- Data flow: each `bin.ts` becomes a thin self-executing composition over the shared helpers plus its own app lifecycle (the ACP bin adds replay-mode env skipping and the stdin-EOF dispose; the stdio bin adds nothing); the published-artifact smokes still run each bin under plain node in a node_modules-shaped temp dir and still assert the missing-config non-zero exit.
- Non-obvious design decisions: the package sits in the `ui` group, not `support/`, because the bins are published artifacts and their runtime dependency must itself be published; the helpers are made injectable at their side-effect seams so the unit suite can cover every branch, including `boot()` driven in-process against the real Loader with relative-specifier configs.
- Edge cases / failure handling: the self-executing bin files are excluded from unit coverage, so the only nontrivial runtime logic in the repo sat outside the per-file 100% gate — the shared package carries that gate instead, and the "real entry path means the published artifact" defensive pattern is kept.
- Surprising: the recorded fallback (extract only the pure logic into per-app modules) would have ended the coverage exemption but kept two homes for the loader-failure lore.

### .agents/notes/archived/simplification/2026-07-04-share-app-bin-boot-glue.zh.md
Chinese translation of `2026-07-04-share-app-bin-boot-glue.md` — a paired rendering of that note, carrying the same `Problem → Decision → Alternatives considered → Consequences` record (the `app-boot` package, the injectable seams, the coverage-gate argument) and linking back to the English side.

### .agents/notes/archived/simplification/2026-07-04-tighten-hook-protocol-contract.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the hook-protocol tightening note plus the `verify-translation-pairing --write` command that re-records them; the sealed whole-file hash pair proving the English and Chinese blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-04-tighten-hook-protocol-contract.md
- Purpose: Apply the repo's own "drop a field that has no consumer" discipline to four pieces of the `dsh-hook-protocol`/bridge contract.
- Key abstractions: `HookDialect` (`'claude' | 'codex'`), `HookOutput.suppressOutput`, `DEFAULT_HOOK_TIMEOUT_MS` / `DEFAULT_STDERR_SUMMARY_MAX_CHARS`, `HookResultRecord` / `appendHookResult`, `BLOCKING_EXIT_CODE`.
- Data flow: the bridges stamp the dialect, parse the output and emit `hook/result`; after the change the protocol library owns the stderr summarization and the decision-string derivation for both bridges, while bridge-specific payload construction stays in each bridge.
- Non-obvious design decisions: `HookDialect`'s `'native'` variant went because no model was trained on a made-up tag — and `durationMs` survived for the same reason (an invented tag is not a contract, but a real field with no consumer is); the `600_000` default had two homes per bridge (a schema `.default(...)` plus a `??` fallback), so the knob stayed but the literal got one home; `suppressOutput` was structurally meaningless because hook stdout never enters a transcript at all.
- Edge cases / failure handling: `durationMs` remains durable audit timing and is normalized only in snapshots; the per-hook timeout override still applies; `BLOCKING_EXIT_CODE` becomes codec-internal.
- Surprising: the note applies a rule from a *different* feature note (the subagent-observe-enrich decision that dropped `agentType` for lacking a consumer) and finds four more violations of it in the hook surface.

### .agents/notes/archived/simplification/2026-07-04-tighten-hook-protocol-contract.zh.md
Chinese translation of `2026-07-04-tighten-hook-protocol-contract.md` — a paired rendering of that note (same four defects, the same dialect/semantics decision and the same verification list), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-04-trim-acp-bridge-unreachable-surface.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the ACP bridge trimming note plus the re-record command; a sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-04-trim-acp-bridge-unreachable-surface.md
- Purpose: Remove two pieces of `dsh-acp` surface that no shipped configuration could reach.
- Key abstractions: `AcpConfig.agentName` / `agentVersion`, the `toolKindFor` name heuristic, the hardcoded handshake `{ name: 'deepseek-harness-acp', version: '0.0.1' }`.
- Data flow: the only production config surface is a leaf `cordis.yml`, and the shipped app package hands the bridge only its agent target, so the branding knobs were settable solely by direct-mounting the bridge (which only a unit test did); every expected output pins the schema defaults.
- Non-obvious design decisions: the `toolKindFor` arms special-cased `bash*`/`read*`/`write`/`edit*` names, but the bridge's own module doc states the rule it broke — "the bridge never special-cases tool names" — and since the render-intent union every first-party tool ships its own `presentCall`; branding may return when the app package exposes it to deployments.
- Edge cases / failure handling: the arms were reachable only when a tool declined to present its own call (a `presentCall` that throws, or arguments that fail the tool schema) — and ACP no longer projects tool cards at all, so the fallback left the transport entirely.
- Surprising: the pair carried a live `TODO(double-default)` — the literals existed twice — so the "unreachable config" was also a duplicated-default bug waiting to be fixed by whichever surface set it.

### .agents/notes/archived/simplification/2026-07-04-trim-acp-bridge-unreachable-surface.zh.md
Chinese translation of `2026-07-04-trim-acp-bridge-unreachable-surface.md` — a paired rendering of that note (the unreachable branding knobs, the kind-sniffing heuristic and the hardcoded handshake), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-12-drop-unconsumed-skill-provider-events.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the skill-provider-event deletion note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-12-drop-unconsumed-skill-provider-events.md
- Purpose: Delete two skill-registry notifications that are produced but never consumed.
- Key abstractions: `skill/provider-added` and `skill/provider-removed`, the skill registry's provider map, completed-catalog invalidation, and the generated event catalog / producer-consumer matrix.
- Data flow: provider registration synchronously clears completed catalogs, discovery reads the current provider map on demand, and the post-await revision check stops stale discovery entering the cache — so a push signal would add nothing.
- Non-obvious design decisions: `tools/change` and `system-prompt/change` are explicitly out of scope because earlier simplification decisions retained them as intentional observation points for live tool/prompt UIs, and `subagent/provider-added`/`removed` stay because `tool-subagent` has a real lifecycle consumer — the bar is "if it is in the map, something produces it", not "nothing consumes it today".
- Edge cases / failure handling: listener-triggered rollback disappears with the events; tests observe cleanup through provider lookup and collected output instead.
- Surprising: the live `subagent/provider-added` consumer tolerates concurrent sibling loading — the exact readiness semantics a future skill consumer would have to re-invent rather than borrow.

### .agents/notes/archived/simplification/2026-07-12-drop-unconsumed-skill-provider-events.zh.md
Chinese translation of `2026-07-12-drop-unconsumed-skill-provider-events.md` — a paired rendering of that note (same two events, same scope carve-outs for `tools/change` and the subagent events), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-12-prune-unused-web-seam-fields.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the web-seam field pruning note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-12-prune-unused-web-seam-fields.md
- Purpose: Shrink the web capability seam to the fields production code actually reads.
- Key abstractions: `WebSearchResult.providerId` / `.query`, `WebFetchResult.providerId`, `WebFetchRequest.timeoutMs`, `maxTimeoutMs`, `WebExecContext`, provider `reason` on `WebProviderStatus`.
- Data flow: `tool-web` formats only content/sources/truncation and final URL/status/body/truncation; provider availability is checked on the boolean `available` alone, and every provider immediately unwrapped `exec?.signal` from the one-field wrapper.
- Non-obvious design decisions: the unused per-request override forced `web-fetch-local` to expose `maxTimeoutMs`, clamp two timeout sources and document a precedence no product path can select — so the local provider keeps its configured default and the tool keeps its own deadline; result echoes were dropped because "callers already own the request and provider selection".
- Edge cases / failure handling: provider fallback, abort behaviour, the configured timeout backstop, truncation and citations all stay covered — the simplification removes configurability rather than a safety bound.
- Surprising: search providers return a `reason` on their status, but resolution checks only `available` and emits a generic unavailable diagnostic — the reason was carried and never shown.

### .agents/notes/archived/simplification/2026-07-12-prune-unused-web-seam-fields.zh.md
Chinese translation of `2026-07-12-prune-unused-web-seam-fields.md` — a paired rendering of that note (the dropped echoes, the removed timeout override and the `WebExecContext` unwrap), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-12-simplify-session-log-representation.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the session-log representation note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-12-simplify-session-log-representation.md
- Purpose: Collapse two over-engineered session-log representations down to one each.
- Key abstractions: `SurfaceManager.nodes` (a `readonly number[]`), the removed `SurfaceNode` links and seq-to-node map, `foldSurface()`, `request/header` full snapshots, and the deleted `SystemDelta` / `ToolsDelta` codec with its durable `request/header-delta` variant.
- Data flow: request reconstruction now selects the latest full snapshot — the initial/resume anchors stay full snapshots even when unchanged, an in-instance change appends another full header with reason `change`, and an unchanged envelope starting a declared message series or following a surface replacement appends one with reason `series`; later turns, steps and retries in that series inherit the latest snapshot.
- Non-obvious design decisions: the pseudo-linked surface was kept because "a pseudo-linked surface might be constant-time" — but production read neither link, and replacement already used `indexOf`, so a seq array has the *same* asymptotic cost with one representation to validate; the header deltas went because their own contract said deltas are an encoding optimization, not a reconstructability requirement.
- Edge cases / failure handling: the frozen v0-to-v1 edge owns the explicit refusal of the historical `request/header-delta` and `fallback` forms before a current Session is constructed; accepted historical normalizations are limited to separately enumerated lossless shapes; `sourceEventSeqs` and the `tool/call` seq cited by crash-repaired results survive because they have an audit/interception role.
- Surprising: the codec's individual arms were not judged invalid — "codec-only vocabulary disappears with the codec, not because its individual arms were invalid".

### .agents/notes/archived/simplification/2026-07-12-simplify-session-log-representation.zh.md
Chinese translation of `2026-07-12-simplify-session-log-representation.md` — a paired rendering of that note (the seq-array surface and the full-snapshot header scheme), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-19-retire-subagent-mock-package.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the subagent-mock retirement note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-19-retire-subagent-mock-package.md
- Purpose: Delete a configurable test double that was packaged as a deployable workspace plugin.
- Key abstractions: `@deepseek-ai/dsh-subagent-mock`, `packages/subagent/tool-subagent/tests/scripted-provider.ts`, the tool-catalog generator's minimal local `SubagentProvider` descriptor.
- Data flow: the scripted child behaviour now lives in the `tool-subagent` test suite, where tests mount the real `SubagentService`, provider registry, tool implementation and task runtime while replacing only the nondeterministic child boundary; the catalog generator registers a minimal provider descriptor before mounting `ToolSubagent` or the workflow engine.
- Non-obvious design decisions: hand-constructing or importing schemas instead of mounting production consumers was rejected — that would weaken the very catalog check the real registry and tool composition exist to expose, so the descriptor "cannot start a child; it exists only to satisfy production load-time dependencies while harvesting schemas".
- Edge cases / failure handling: package-specific Schemastery and Loader-export tests disappear because the fixture is no longer a deployable plugin; the catalog output stays byte-for-byte unchanged.
- Surprising: the narrow fixture carried a manifest, peer and dev dependencies, project references, a README obligation, Loader composition tests, module-graph membership and documentation exceptions — a test fixture that looked like a supported backend.

### .agents/notes/archived/simplification/2026-07-19-retire-subagent-mock-package.zh.md
Chinese translation of `2026-07-19-retire-subagent-mock-package.md` — a paired rendering of that note (the deleted mock package, the local scripted provider and the catalog-generator descriptor), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-19-use-one-session-surface-manager.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the single-surface-manager note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-19-use-one-session-surface-manager.md
- Purpose: Stop `Session` from maintaining two `SurfaceManager` instances over the same append-only event log.
- Key abstractions: `SessionSurface { readonly nodes: readonly number[]; readonly replaceGeneration: number }`, `validateNext()`, `foldSurface()`.
- Data flow: one eagerly constructed manager serves both seed/append acceptance (`validateNext()` before committing an event) and `session.surface`; the candidate enters manager state only after `log.push()` and the next delta synchronization, so a validation failure or a pre-commit `internal/dispatch` veto leaves no phantom node or replacement generation.
- Non-obvious design decisions: separate instances "appeared to isolate public reads from validation", but callers already receive borrowed surface state and the declared readonly contract prevents ordinary mutation — duplicating the manager was not a runtime trust boundary; recomputing the surface from the full log on every access was rejected because it gave up incremental derivation and made request construction scale with complete session history.
- Edge cases / failure handling: a hostile cast can still corrupt borrowed state — JavaScript callers that deliberately bypass the readonly contract stay outside the supported same-process boundary; `foldSurface()` remains the detached replay path and agrees with the live manager for every committed prefix without sharing mutable state.
- Surprising: the whole point is that a second lazily-created projection was advancing duplicate node and replacement-generation state for every later event — extra work that created no separate authority or failure boundary.

### .agents/notes/archived/simplification/2026-07-19-use-one-session-surface-manager.zh.md
Chinese translation of `2026-07-19-use-one-session-surface-manager.md` — a paired rendering of that note (the shared manager, the atomic candidate validation and the detached `foldSurface()`), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-20-remove-stdio-and-echo-agents.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the stdio/Echo agent removal note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-20-remove-stdio-and-echo-agents.md
- Purpose: Remove two redundant product agents (a line-oriented stdio agent and a mock-model Echo agent) that sat beside the TUI and headless coding agents.
- Key abstractions: `@deepseek-ai/dsh-tui` (TTY-only, rejects non-TTY streams before Loader boot), `dsh --profile headless`, `dsh --profile acp`, `@deepseek-ai/dsh-sdk-jsonrpc-server`, the `apps/cli/config/base.cordis.yml` + `tui.cordis.yml` composition.
- Data flow: the stdio UI/app packages, `examples/repl-agent`, `examples/echo-agent`, `demo:repl` and `demo:echo` are deleted without compatibility packages, modes, commands or aliases; each remaining application role now has exactly one owner and one runnable coding leaf.
- Non-obvious design decisions: standard input/output remain *protocol* boundaries for ACP, JSON-RPC, MCP and child processes, and deterministic model adapters remain valid inside tests — those mechanisms do not justify a line-oriented or mock-only product agent; keeping Echo as the keyless quick start was rejected because the first product experience should exercise the real model.
- Edge cases / failure handling: keyless validation is test-owned (the headless Loader smoke uses a fixture adapter, the built-bin suite pins the published one-shot entry, the product headless snapshot pins persistence, the PTY shutdown e2e pins signal escalation) — no runnable mock agent survives; existing stdio-agent configurations and Echo commands fail instead of being translated.
- Surprising: "the repository has no keyless user-facing agent demo; local agent demos require `DEEPSEEK_API_KEY`" — CI keeps keyless coverage through test fixtures instead of a product command.

### .agents/notes/archived/simplification/2026-07-20-remove-stdio-and-echo-agents.zh.md
Chinese translation of `2026-07-20-remove-stdio-and-echo-agents.md` — a paired rendering of that note (the deleted agents, the surviving TUI/headless/ACP/JSON-RPC roles and the test-owned keyless validation), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-20-retire-readline-front-door.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the readline front-door retirement note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-20-retire-readline-front-door.md
- Purpose: Delete the readline interactive front door and the repl-agent example, leaving three front-door archetypes: interactive TUI, one-shot CLI and servers.
- Key abstractions: `@deepseek-ai/dsh-tui` (TTY-only, fails loud on pipes), the one-shot `dsh-cli-demo` with `-p/--prompt`, the `TerminalMode` / `resolveTerminalMode` / `ui.mode` selection seam that is deleted, ACP / JSON-RPC servers.
- Data flow: the bin refuses non-TTY streams *before booting the Loader* — a compose-time throw inside a Loader tree is logged per-entry, not rethrown, so a piped launch would otherwise settle into an idle, UI-less process instead of exiting nonzero; the SDK wizard's `stdio` run interface became `tui` with the same pre-boot TTY guard.
- Non-obvious design decisions: the duplication was structural, not cosmetic — ~1,000 lines of readline unit tests, a readline transcript grammar (`[tool call] …` lines) that the CI demo smoke and two built-bin e2es grepped, and an *inverted* example composition where the flagship `tui-agent` leaf was defined as an include-patch over the `repl-agent` leaf it superseded; PTY-driven subprocess tests are sanctioned only where the subject is the TUI itself, because PTY is the flakier medium and is reserved for the one surface pipes cannot prove.
- Edge cases / failure handling: two accepted losses are stated — piped multi-turn in one process (now covered by `RESUME_SESSION_ID`/resume e2es and the TUI's scripted PTY conversation) and non-TTY `ask_user_question` (a headless or ACP run whose model calls it fails unless its composition supplies a provider; Web owns the shipped non-terminal provider).
- Surprising: nesting overlays as includes was rejected elsewhere in the same archive because "patches do not cross an include boundary" — the same one-level include rule that shapes config composition also decided the example-leaf inversion here.

### .agents/notes/archived/simplification/2026-07-20-retire-readline-front-door.zh.md
Chinese translation of `2026-07-20-retire-readline-front-door.md` — a paired rendering of that note (the three archetypes, the pre-boot TTY guard, the PTY-only testing policy and the two accepted losses), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the injected-envelope removal note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.md
- Purpose: Project injected session content verbatim into the model transcript instead of wrapping it in XML envelopes.
- Key abstractions: `deriveEventMessage`, the `<steering source="…">` and `<context source="…">` envelopes, the removed `ContextEnvelope` type and every `envelope` field (`InjectOptions`, `HookContext`, the `context/message` event, the loop), `context/message.meta`.
- Data flow: `user/message` content blocks render to the model unchanged; `source` stays in the durable event log but no longer renders, and `context/message.meta` still carries durable, model-hidden JSON state.
- Non-obvious design decisions: no model was trained on these tags, so the framing added tokens without a reliable effect — recorded transcripts show a model treating a `<steering>` instruction as third-party metadata and refusing it while answering only the original prompt; the framing decision belongs to the caller, and the one heavy producer (`agent-instructions`) already owned a complete `<system-reminder>` frame and opted out of the wrapper with `envelope: 'raw'`.
- Edge cases / failure handling: the `hook-{cc,codex}-stop-continue` ACP snapshots were re-recorded, because the old recordings captured the model refusing steering as third-party metadata — the fix's exact failure mode; per-adapter divergence was rejected, since the canonical projection is the model-visible contract ("model-visible ⟺ logged").
- Surprising: the note records the two framing paths that existed — caller-baked (`agent-instructions`'s `<system-reminder>`) and surface-level wrapping — and says the change removes the second, leaving only caller-owned framing; if labelled framing is wanted again it should be declared in `meta` and applied by one renderer.

### .agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.zh.md
Chinese translation of `2026-07-20-unwrap-injected-content-envelopes.md` — a paired rendering of that note (the verbatim projection, the deleted `ContextEnvelope` machinery and the caller-owned framing rule), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-21-tui-remove-cancel-command.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the TUI `/cancel` removal note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-21-tui-remove-cancel-command.md
- Purpose: Remove one of two identical ways to cancel a running turn in the TUI.
- Key abstractions: the `Esc` / `Ctrl+C` keybinding, `agent.cancel('cancelled from terminal')`, the `baseCommands` autocomplete entry, the `case '/cancel'` branch in the editor submit handler, the `/help` shortcut list.
- Data flow: cancelling a turn is now keybinding-only; the running status line already advertises it ("Enter sends steering, Esc cancels"), and typing `/cancel` falls through to the generic `Unknown command:` warning like any other unrecognized slash input.
- Non-obvious design decisions: a slash command requires editor submission, which a keystroke does not — so the command was "a second, less discoverable path to the same effect, surface area with no behavior of its own"; every other slash command (`/help`, `/clear`, `/reasoning`, `/tools`, `/redraw`, `/reload`, `/resume`, `/exit`, `/skill:<name>`) is unchanged.
- Edge cases / failure handling: when idle, `/cancel` used to print an "already idle" notice while the keybindings stayed silent — that notice went with it; the TUI spec asserts `agent.cancelled` contains `'cancelled from terminal'`, driven by the keystrokes, and the `errors-and-help` / `disposed-terminal` snapshots pin the `/help` line without `/cancel`.
- Surprising: the note ties the removal to the single-primitive shape the rest of the stop surface already follows — the same reasoning that collapsed the two stop verbs into one `cancel()`.

### .agents/notes/archived/simplification/2026-07-21-tui-remove-cancel-command.zh.md
Chinese translation of `2026-07-21-tui-remove-cancel-command.md` — a paired rendering of that note (the keybinding-only cancellation and the removed idle notice); note that the H1 title is left in English in this file, unlike the rest of the pair.

### .agents/notes/archived/simplification/2026-07-21-tui-todo-write-opt-in.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the `todo_write` opt-in note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-21-tui-todo-write-opt-in.md
- Purpose: Stop shipping `todo_write` in the default TUI tool list and make it a one-line opt-in.
- Key abstractions: the tui-agent `cordis.yml`, the `code-mode.cordis.yml` overlay, the `TodoItem` type and the `todo/write` session event in `@deepseek-ai/dsh-session`, `TodoComponent.render`.
- Data flow: the base composition no longer loads `tool-todo`, and the overlay inherits it so its generated SDK drops the tool too; enabling it is one entry (`@deepseek-ai/dsh-tool-todo` in `cordis.yml` or a `~/.dsh` personal overlay), after which the model logs the whole-list `todo/write` snapshot and the TUI renders the plan unchanged.
- Non-obvious design decisions: the tool is a task-tracking convenience, not a core affordance like `bash` or the fs tools, and shipping it enlarges the wire tool list and system prompt for every turn; the TUI's plan rendering is event-driven and returns nothing when the list is empty, so the front door already tolerated the plugin's absence with no runtime coupling — which is why both the disabled and enabled paths stayed first-class.
- Edge cases / failure handling: the snapshot mounts `ToolTodo` only when a scenario sets `enableTodo` (only `todo-plan` does), the with-key todo e2e drives the real tool, and the keyless smoke boots the real `cordis.yml` and asserts nothing about todo, so the default boot is unaffected.
- Surprising: the sibling acp-agent, headless-agent and jsonrpc-agent examples still ship the tool — the decision removes it from one product surface, not from the repository.

### .agents/notes/archived/simplification/2026-07-21-tui-todo-write-opt-in.zh.md
Chinese translation of `2026-07-21-tui-todo-write-opt-in.md` — a paired rendering of that note (the opt-in `todo_write`, the unchanged plan rendering and the two first-class paths); note that the H1 title is left in English in this file, unlike the rest of the pair.

### .agents/notes/archived/simplification/2026-07-22-plan-specific-collaboration-state.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the plan-mode state note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-22-plan-specific-collaboration-state.md
- Purpose: Replace a generic named-mode registry with one plan-specific product package, because only `plan` ever shipped.
- Key abstractions: `@deepseek-ai/dsh-plan-mode`, the durable fact `plan/mode: { active: boolean }`, `planProjectionDefinition.apply`, `ctx.sessionProjections.stateOf(session, 'plan')`, `ctx.planMode.get/set`, the `plan:policy` section, `/plan [message]`, `/plan off`, `exit_plan_mode`.
- Data flow: the plan projection unit folds committed events (empty log folds to inactive) and every projection unit is persisted uniformly since the `persist` option was removed; the active state contributes the deployment's section at first-party prompt order 500; `exit_plan_mode` stays registered in both states so a transition changes the logged request header but not the native tool schemas or the PTC mode SDK.
- Non-obvious design decisions: "mode" spans unrelated domains — sandbox mode is an enforcing policy owned by `ctx.sandboxPolicy` and logged as `sandbox/mode`, plan mode is a collaboration stance — so treating both as instances of one abstraction would obscure their independent ownership; the durable stance is log-only and non-surface, so resume, fork and compaction recover it without a live mirror, and a spawned agent begins inactive because there is no creation-time plan option.
- Edge cases / failure handling: pending user selections flush before the affected request assembly at initial or continuation pre-step, or on a request-recovery retry, and a failed durable append leaves the intent pending for a later boundary; an absent or failed user-questions provider, a failed review, or plugin disposal while a review is pending fails closed, leaving manual `/plan off` as the human escape path; an idle pending selection is lost if the process exits before the next boundary.
- Surprising: the reviewed exit requires a non-empty markdown plan beginning with a heading, and *only* one `Approve` selection with no custom text consents — every other answer stays in plan mode and returns corrective feedback to the model; the note also states plainly that plan mode is guidance, not a security boundary, because a model that ignores the guidance can still mutate unless the deployment configures sandbox, approval or filesystem policy independently.

### .agents/notes/archived/simplification/2026-07-22-plan-specific-collaboration-state.zh.md
Chinese translation of `2026-07-22-plan-specific-collaboration-state.md` — a paired rendering of that note (the `plan/mode` durable fact, the reviewed exit and the deleted generic registry), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-22-tui-titles-from-session-title-service.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the session-title note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-22-tui-titles-from-session-title-service.md
- Purpose: Make the log-backed session-title service the only title source, instead of a TUI-local model call beside it.
- Key abstractions: `foldSessionTitle`, `runtime.terminal.setTitle`, the terminal-safe OSC 0 path, `@deepseek-ai/dsh-session-title-first-message-llm`, the deterministic fallback from `dsh-agent-spine-demo`'s bundled `SessionTitleService`.
- Data flow: the TUI holds no `autoTitle` config, title-model request, latch, abort controller, prompt or output cap; it folds the latest logged title on mount, renders it as the banner subtitle, and sets `<session title> — <configured title>` on every accepted `session/title` event; the model-made title is a *composition* choice mounted in `examples/tui-agent/cordis.yml`.
- Non-obvious design decisions: keeping both pipelines and letting the logged title win was the first merge resolution — it preserved behaviour but doubled the model calls on every fresh session and left the TUI's title unobservable in the log, violating "model-visible ⟺ logged" in spirit; porting auto-title's prompt and cap in as a third provider was rejected because the first-message-llm provider already has the same cadence, a reviewed prompt contract, durable request records and supersession fencing.
- Edge cases / failure handling: auxiliary title latency must stay off the interaction critical path, so a deployment without the provider keeps the deterministic fallback; the same OSC 0 path handles the configured fallback, resumed sessions and live revisions without renaming tmux windows; the log-backed decision owns provider, persistence, resume, fork, cancellation and stale-completion coverage.
- Surprising: renaming a tmux window or introducing a second terminal-control API was rejected — the existing adapter's OSC 0 path labels the pane or tab without acquiring tmux ownership.

### .agents/notes/archived/simplification/2026-07-22-tui-titles-from-session-title-service.zh.md
Chinese translation of `2026-07-22-tui-titles-from-session-title-service.md` — a paired rendering of that note (one durable title pipeline, the composition-owned model provider and the OSC 0 title shape), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-23-collapse-persistence-flush-state.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the persistence-flush collapse note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-23-collapse-persistence-flush-state.md
- Purpose: Collapse the persistence coordinator's separate buffer, initialization and retirement containers into one lifecycle entry per live session.
- Key abstractions: the per-session write controller owning `pending`, the fixed batching timer, the optional active write, the automatic-retry pause and the shared flush barrier; `session/flush`; the per-id operation chain; `SessionState.meta`.
- Data flow: a `session/event` listener copies the frozen event into `pending`; the first event starts a fixed deadline and later events join without resetting it; a write takes one stable pending prefix and events admitted during it remain pending for a separately bounded follow-up batch; `session/flush` waits for initialization, cancels the timer, joins any active attempt and drains pending events including those admitted while the barrier runs.
- Non-obvious design decisions: the checkpoint-only drain kept every event volatile until another plugin requested `session/flush`, even though the backend could begin durability work without blocking the synchronous producer — bounded background scheduling coalesces bursts and persists progress between mandatory barriers; a background failure is logged without rejecting the synchronous event producer, restores the complete ordered batch and pauses automatic retry, because latching the error permanently would prevent the teardown retry from recovering a transient storage failure.
- Edge cases / failure handling: crash repair is cold-only — for a live identity `load(id)` snapshots the authoritative in-memory events before awaiting their flush and rejects an open turn without reading or repairing storage; the live-controller map doubles as the retirement registry, so backend teardown stops admission, flushes every controller still present, awaits remaining per-id operations and closes the backend.
- Surprising: the per-id operation chain stays separate from the live controller because detached public `create`/`append`/`load` calls can race without a `Session` object and still need identity-level serialization; the note is superseded on cadence by the bounded write-batching decision but its ownership and failure-retention decisions remain current.

### .agents/notes/archived/simplification/2026-07-23-collapse-persistence-flush-state.zh.md
Chinese translation of `2026-07-23-collapse-persistence-flush-state.md` — a paired rendering of that note (the single write controller, the flush barrier semantics and the cold-only crash repair), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-24-agent-loop-observable-state-machine.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the observable-state-machine note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-24-agent-loop-observable-state-machine.md
- Purpose: Shrink the agent loop's public event surface to four orthogonal state dimensions and four extension points.
- Key abstractions: `agent/created` → `agent/disposed` (registration lifetime), `AgentStatus = 'idle' | 'running'` (whole-agent activity), `agent/inbox/inserted` / `claimed` / `discarded` with `MessageId`, `agent/settled` (turn settlement); and the four machine events `agent/pre-step`, `agent/request`, `agent/request-error`, `agent/turn-stopping`.
- Data flow: a claimed turn passes through pre-step entry and zero or more request steps; an automatic retry closes the failed turn and immediately opens another, and `agent/settled` reports only the terminal turn in that chain; continuation and termination are *data* — tool calls and accepted steering require another step, and a tool result carrying `concludesTurn` ends the tool loop at its step.
- Non-obvious design decisions: the old events made internal phases public even though the durable session log already owned the turn and step facts, and mixed two extension models (observe-and-command vs return-a-control-decision); `agent/settled` does **not** imply `agent.status === 'idle'` — it reports the terminal turn of one drain chain while `agent/status` reports whether the whole agent is active; retry is not another step inside the failed turn but a new turn opened over the repaired state.
- Edge cases / failure handling: the loop re-reads the turn signal when consuming a request-error action, so cancellation or disposal during recovery prevents the retry; a thrown recovery never produces an action; `agent/error` remains the live error notification for consumers that report failures independently of turn settlement; durable turn and step boundaries stay session events, and the durable turn/step mirrors are not restored.
- Surprising: an accepted inbox item can be discarded without ever opening a turn, and one turn can settle while later work keeps the agent active — which is exactly why "one status or one linear callback sequence" made ordinary questions ambiguous.

### .agents/notes/archived/simplification/2026-07-24-agent-loop-observable-state-machine.zh.md
Chinese translation of `2026-07-24-agent-loop-observable-state-machine.md` — a paired rendering of that note (the four state dimensions, the four extension events and the data-not-enums continuation rule), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-26-consolidate-gate-scripts-on-existing-deps.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the gate-script consolidation note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-26-consolidate-gate-scripts-on-existing-deps.md
- Purpose: Replace the last hand-rolled scanners, argv parsers and directory walks in `scripts/` with the dependencies and builtins sibling gates already use.
- Key abstractions: `markdownFences` in `scripts/markdown.ts` (visits mdast `code` nodes for language, full info string, body and 1-based opening-fence line), `node:util` `parseArgs`, `globSync` from `node:fs`.
- Data flow: `doc-typecheck.ts` and `verify-type-equiv.ts` now extract fences through the shared mdast helper, `md-fences.ts` and `extractEquivBlocks` are deleted, `markdownProseLines` derives fenced lines from parsed `code` node positions, both CLIs parse argv via `parseArgs`, and the five straggler walks use `globSync`.
- Non-obvious design decisions: the regex scanners only recognized backtick fences at column 0, so they silently disagreed with the mdast-based gates on tilde and indented fences — "two drifting copies of a parser beside a third correct implementation"; no new dependency was needed anywhere, and a new glob/walking package was rejected because the builtin had already won repo-wide.
- Edge cases / failure handling: `verify-type-equiv` still rejects an unterminated type-equivalence fence because mdast silently closes an unterminated block at end-of-file, so the shared helper reports whether a closing delimiter exists; the walks in `check-workspace-constraints.ts` and `clean.ts` stay because they need dirent-level detail to diagnose malformed trees; `parseArgs` keeps the last value of a duplicated option instead of erroring — an accepted dev-tool edge case in exchange for deleting two bespoke parsers.
- Surprising: every rewritten gate was run before and after the swap with byte-identical output — the duplication had been invisible to the whole docs tree because it contained no fence shape the regex scanners mishandled.

### .agents/notes/archived/simplification/2026-07-26-consolidate-gate-scripts-on-existing-deps.zh.md
Chinese translation of `2026-07-26-consolidate-gate-scripts-on-existing-deps.md` — a paired rendering of that note (the shared mdast fence helper, `parseArgs` and `globSync`), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the SSE parser replacement note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md
- Purpose: Replace `llm-deepseek`'s hand-written SSE parser with the maintained `eventsource-parser` library, keeping only the DeepSeek protocol shim.
- Key abstractions: `EventSourceParserStream` from `eventsource-parser/stream`, `TextDecoderStream`, `pipeThrough`, the `data:` payload, the `[DONE]` sentinel, `LlmError('STREAM_CLOSED')`.
- Data flow: `parseSse` pipes the response body through a `TextDecoderStream` and then an `EventSourceParserStream`, yields each event's `data`, terminates on `[DONE]` and throws `STREAM_CLOSED` when the stream ends without the sentinel; `adapter.ts` still does `yield* translate(parseSse(response.body))`.
- Non-obvious design decisions: the twin-adapters decision calls the DeepSeek adapter the hand-rolled twin of the pi-ai adapter, but its load-bearing distinction is owning the fetch/translate internals versus delegating to a full provider SDK — a ~700-byte SSE micro-parser is transport plumbing, not the design under verification; the library was already in the lockfile transitively via `@modelcontextprotocol/sdk`, so adopting it directly added no new supply-chain surface in practice.
- Edge cases / failure handling: one deliberate robustness deviation is dropped — the hand-rolled parser flushed a final event block lacking its terminating blank line, so a trailing `data: [DONE]` without `\n\n` yielded DONE; the library is spec-strict, so that shape is now `STREAM_CLOSED`, and the new truncation verdict is pinned; the library also strips a leading BOM (the old parser would fail to match `data:` after one) and offers `maxBufferSize` hardening the old parser lacked.
- Surprising: ~67 lines of implementation plus ~108 lines of dedicated spec-conformance tests were re-proving behaviour a maintained parser already guarantees — all of it deleted, leaving `tests/sse.spec.ts` pinning only the `[DONE]`/`STREAM_CLOSED`/EOF contract.

### .agents/notes/archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.zh.md
Chinese translation of `2026-07-26-eventsource-parser-for-deepseek-sse.md` — a paired rendering of that note (the library-framed SSE stream, the surviving DeepSeek shim and the dropped trailing-event robustness), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-26-merge-subagent-control-service.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the subagent-control merge note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-26-merge-subagent-control-service.md
- Purpose: Merge the separate `ctx.subagentControl` orchestration service into the `ctx.subagents` provider contract, leaving one public subagent service.
- Key abstractions: `SubagentRuntime` with `start(name, request)`, `startContinuable(spec)` and `followup(...)`; the internal continuation manager created through `ctx.inject(['tasks', 'agents'], ...)`; the `SubagentError` code taxonomy; the `backgroundMode: 'one-shot' | 'continuable'` tool configuration.
- Data flow: provider resume dispatch stays private to the continuation manager; the injected Cordis child fiber owns the Task completion listener and teardown effects, so loading the provider registry does not require Jobs or persistence; `startContinuable` allocates the durable child id, creates the Task and returns both ids synchronously while startup continues inside the Task, while raw `start` awaits provider publication and transfers a holder-owned run.
- Non-obvious design decisions: method presence correctly states cold-resume *capability* but not deployment *policy* — inferring continuable mode from `provider.resume` forced every resumable provider into continuable background semantics and made missing sibling plugins a runtime error, so `backgroundMode` is explicit configuration and `provider.resume` is only the capability check; `startContinuable` stays a distinct method because folding it onto `start` through flags or return unions would broaden the low-level contract.
- Edge cases / failure handling: continuable mode fails at provider mount when the configured provider lacks `resume`, while missing Jobs, Agents or persistence fail at the earliest operation that needs them; the optional `dsh-tool-subagent-control` package injects `ctx.subagents` directly, so follow-up delivery stays optional and loading or omitting `send_message` neither enables nor disables `startContinuable`.
- Surprising: the split had made *sibling plugin presence decide execution semantics* — the delegation tool had to infer policy from `provider.resume` and from whether the control service and `send_message` tool happened to be loaded.

### .agents/notes/archived/simplification/2026-07-26-merge-subagent-control-service.zh.md
Chinese translation of `2026-07-26-merge-subagent-control-service.md` — a paired rendering of that note (the merged `SubagentRuntime`, the internal continuation manager and the explicit `backgroundMode` policy), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-26-turndown-for-tool-web-html-markdown.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the turndown conversion note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-26-turndown-for-tool-web-html-markdown.md
- Purpose: Replace `tool-web`'s regex HTML-to-markdown converter with the maintained `turndown` library, because the converter's output is model-visible on every fetched page.
- Key abstractions: a module-level `turndown` instance (`headingStyle: 'atx'`, `codeBlockStyle: 'fenced'`, `bulletListMarker: '-'`), the `@joplin/turndown-plugin-gfm` composite `gfm` plugin, `remove(['script', 'style', 'noscript'])`, `fetchMaxOutputChars` (default 200,000), `src/turndown-plugin-gfm.d.ts`.
- Data flow: `formatFetchOutput` limits both the source prefix converted synchronously and the complete rendered output with `fetchMaxOutputChars`, so a custom provider cannot make conversion work unbounded before the output cap applies; the HTML arm guards conversion twice — a conservative linear lexical pass (skips raw-text bodies, honours quoted tag text, passes a body through raw when its stack crosses 512 levels) plus a try/catch that falls back to raw HTML when turndown rejects markup the guard cannot model.
- Non-obvious design decisions: the presentation options are fixed model-facing constants, not deployment tunables; the GFM cell rule is overridden to ignore `colspan`, because Markdown cannot represent it and an untrusted numeric attribute must not be able to synthesize arbitrary empty cells; the Joplin fork of the GFM plugin was chosen because the original is unmaintained (last publish 2018).
- Edge cases / failure handling: overlong input is converted only through a bounded prefix, pathological nesting falls back to raw HTML, and spanning table cells are flattened because GFM has no corresponding syntax; the previously-missing keyless `web_fetch` snapshot ships with the change as the acp-agent scenario `web-fetch`, driving a real loopback HTTP fixture so the new output is pinned.
- Surprising: the dependency-weight objection was answered with arithmetic — ~6 MB of the ~7.9 MB packed footprint is `@mixmark-io/domino`'s **test corpus**, with runtime `lib/` at ~550 KB against a ~174 MB artifact, under 0.5% either way; and no keyless snapshot had exercised `web_fetch` before, so nothing pinned the old output.

### .agents/notes/archived/simplification/2026-07-26-turndown-for-tool-web-html-markdown.zh.md
Chinese translation of `2026-07-26-turndown-for-tool-web-html-markdown.md` — a paired rendering of that note (the turndown instance, the bounded conversion and the raw-HTML fallbacks), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-27-copyable-transcript-no-gutter-bar.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the copyable-transcript note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-27-copyable-transcript-no-gutter-bar.md
- Purpose: Make a terminal drag-select over the TUI scrollback copy exactly the message text.
- Key abstractions: `UserMessageComponent`, the shared `messageHeader` helper, `GutterBox` (deleted), tool-card title/status colouring, the `Text` component at terminal width.
- Data flow: messages are separated only by a bold, underlined role header in the role colour plus blank-line spacing, both of which the terminal already inserts around each block; user/steering prompts, assistant blocks and tool cards all render at column 0, and the card status glyph (`◌` / `✕` / `✓`) plus the title share one colour.
- Non-obvious design decisions: the gutter bar was the transcript's only per-message separator, so it could not simply be dropped without another way to tell messages apart — the underline gives each role a distinct visual band without a background fill, so it reads on any terminal theme; indenting instead of a bar was explicitly ruled out because leading spaces still enter the clipboard.
- Edge cases / failure handling: body lines still pass through `Text` at the terminal width so overlong raw tool output wraps rather than overflowing; box-drawing borders on transient overlays (status panel, model selector, resume list) are untouched because they are not scrollback content and are rarely copied.
- Surprising: the affected keyless TUI `*.expected.txt` snapshots were re-recorded by fixture replay with no API key — the recorded LLM sessions are unchanged, only the render differs; the change was verified interactively in tmux.

### .agents/notes/archived/simplification/2026-07-27-copyable-transcript-no-gutter-bar.zh.md
Chinese translation of `2026-07-27-copyable-transcript-no-gutter-bar.md` — a paired rendering of that note (the removed gutter bar and indent, the underlined role headers and the re-recorded snapshots), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-27-intent-named-subagent-continuation-operations.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the intent-named continuation note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-27-intent-named-subagent-continuation-operations.md
- Purpose: Split the merged subagent service by *caller intent* instead of exposing provider dispatch, and collapse two durability-barrier methods into one.
- Key abstractions: `start(name, request)`, `startContinuable(spec)`, `sendMessage(sender, targetId, content, { signal })`; `SubagentStartRequest` vs `ResolvedSubagentStartRequest` vs `ContinuableCreateRequest`; `SubagentProvider.prepareContinuable?()`; `SessionStore.flush(session): Promise<boolean>`.
- Data flow: the message operation derives attribution from the exact live sender and owns adjacency checks, cold resume and fixed Steer scheduling; the single model-facing `send_message({ agent_id, message })` tool delegates to it in either direction; `flush` resolves `true` after at least one scoped listener participates successfully, `false` for an empty listener snapshot, and rejects with the first registered listener failure after all listeners settle.
- Non-obvious design decisions: `SubagentRuntime.resume()` and provider resume dispatch are absent — no production caller outside the continuation manager owns descriptor lookup, direct-parent authorization, Agent materialization, Activation ownership and child-first teardown, so providers instead contribute detached first-creation data through `prepareContinuable`; direction-specific `followup`/`reportFrom` were rejected because they duplicate authority, attribution and delivery behaviour and make the vocabulary depend on direction.
- Edge cases / failure handling: participation cannot identify whether a selected persistence backend stored the state, so ordinary checkpoints may ignore the boolean while the continuation manager treats its final flush as a best-effort barrier — it logs rejection and still disposes the child and releases ownership; cancellation travels in one options object and owns work only until inbox acceptance.
- Surprising: the durability boundary had exposed both `flush()` and `flushRequired()`, which performed the same scoped parallel dispatch and differed only in whether an empty listener snapshot was accepted — one consumer's policy encoded as a second operation.

### .agents/notes/archived/simplification/2026-07-27-intent-named-subagent-continuation-operations.zh.md
Chinese translation of `2026-07-27-intent-named-subagent-continuation-operations.md` — a paired rendering of that note (the three caller intents, the private resume path and the single boolean-returning flush barrier), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-27-request-error-retry-action.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the request-error retry-action note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-27-request-error-retry-action.md
- Purpose: Move the model-request recovery decision out of a public agent command and into the waterfall result that already owns it.
- Key abstractions: `agent/request-error` returning `RequestErrorAction` with `{ kind: 'retry' }`, the default `undefined` (terminal), `Agent`/`ReactLoopAgent` without `retry()`, `followup()` / `steer()` / `inject()`.
- Data flow: the loop reads the action after the waterfall settles, closes the failed turn and opens one retry turn from durable history; it rechecks the turn signal when consuming the action, so cancellation or disposal during recovery prevents the retry even if a listener returns it afterward; a thrown recovery never produces an action.
- Non-obvious design decisions: `Agent.retry()` was valid during one narrow waterfall window *and* while idle, rejected other running states, and forced `ReactLoopAgent` to retain a mutable retry window beside the waterfall result — the recovery plugins were its only production callers, so the wider live-agent capability exposed states and behaviour unrelated to their policy decision; `undefined` was chosen over an explicit `{ kind: 'fail' }` because it already represents the waterfall's unhandled default and composes through `next()`.
- Edge cases / failure handling: a listener that does not own the failure calls `next()`; a listener that owns it performs any awaited repair and returns the retry action without delegating; callers cannot restart arbitrary failed non-request work without submitting a later prompt, while transient and context-overflow policies retain numbered retry turns, durable-history reconstruction, finite private budgets and cancellation precedence.
- Surprising: the note's verification is a set of suites, not one test — the llm-retry and compaction-basic suites pin their policy-owned action returns, and the ACP, goal-round-driver and plan-mode integrations pin successor-turn adoption.

### .agents/notes/archived/simplification/2026-07-27-request-error-retry-action.zh.md
Chinese translation of `2026-07-27-request-error-retry-action.md` — a paired rendering of that note (the `RequestErrorAction` return path and the removed `Agent.retry()` window), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-28-local-json-tree-renderer.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the JSON tree renderer note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-28-local-json-tree-renderer.md
- Purpose: Replace a patched third-party JSON viewer with a source-level tree renderer the team owns.
- Key abstractions: `JsonTree` in `dsh-client-ui-primitives`, per-row value and property paths, `expandTopLevel`, a single tabbable expander with roving focus, the ARIA tree structure.
- Data flow: object keys and array indexes extend the path during recursion, so a copy action reads the real data path and never reconstructs application data from rendered DOM text; expandable rows render a compact preview locally and mount child rows only while expanded; pointer activation claims the one tab stop, Up/Down move it cyclically, Left/Right collapse or expand the focused node.
- Non-obvious design decisions: `react-json-view-lite` exposes neither custom node rendering nor row identity, so satisfying the requirements through it required a package-manager patch against *compiled distribution files* plus DOM traversal that rebuilt data paths from visible labels — an untyped fork whose source maps and upstream source stayed unchanged; injecting previews after render was rejected because effects would depend on the same private DOM structure while splitting one row between React ownership and imperative mutation.
- Edge cases / failure handling: the package is deliberately read-only and limited to the preview, navigation and copy behaviour current consumers use; a larger JSON viewer was rejected because editing, search and theme systems are outside the contract.
- Surprising: the whole feature existed because the dependency needed patching to expose row identity — and the patch "behaves as an untyped fork while its source maps and upstream source remain unchanged", i.e. the fork was invisible in review.

### .agents/notes/archived/simplification/2026-07-28-local-json-tree-renderer.zh.md
Chinese translation of `2026-07-28-local-json-tree-renderer.md` — a paired rendering of that note (the owned recursive renderer, the real data paths and the roving focus), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-29-shared-base-config-overlays.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the shared-base-config note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-29-shared-base-config-overlays.md
- Purpose: Collapse two config trees that were 43 rows the same into one shared base plus one patch overlay per surface.
- Key abstractions: `apps/cli/config/base.cordis.yml`, `apps/cli/config/tui.cordis.yml` and `web.cordis.yml` as **patch lists**, the Include patch algorithm (last write wins per row), `--config <path>` (overlay) vs `--config-replace <path>` (whole tree), `CONFIGURED_AGENT_IDENTITIES_KEY`.
- Data flow: the launcher includes the base once and applies every overlay as a sibling patch list at **one** include level; precedence is list order — base, then the surface overlay, then either a `--config` overlay or the personal `~/.dsh/config.yaml`, then the launcher's own flag and profile patches; `--config` replaces the personal overlay so a test tree never inherits the user's provider and model, and both flags survive the `/resume` execve handoff.
- Non-obvious design decisions: nesting the overlays as includes was rejected *after testing the Loader* — patches do not cross an include boundary, so the outer file's patches are dropped with only a warning, a three-level chain left `tools` unpatchable, and a base behind one include made every personal patch a silent no-op; a patch replaces the target row's whole `config` rather than merging, so a row whose value differs per surface lives in the overlays, never in the base; a patch whose `id` matches no row stays a no-op rather than an error, because one personal overlay is shared across surfaces and `insert` rows match nothing by design.
- Edge cases / failure handling: session identity cannot ride a config key at all — it moved to `dsh-agent-loop`'s `CONFIGURED_AGENT_IDENTITIES_KEY`; the TUI query index uses a unique process-local temporary database because the SQLite backend requires one writer owner, and `/resume` lists the underlying corpus directly so it does not depend on index reuse; composition is verified by booting each tree through the real Loader and inspecting settled entries, not by reading YAML.
- Surprising: the duplication had inverted a default — `composeTuiApp` read `config.goals ?? {}`, so the shipped TUI mounted goals, `tool-goal`, `goal-round-driver` and `/goal` although no config key requested them; flattening the trees also surfaced three latent defects (a `sessionQuery` mount race that could permanently disable `/resume`, a session-store root reverting to `./.sessions`, and `--config-replace` being dropped by the resume handoff).

### .agents/notes/archived/simplification/2026-07-29-shared-base-config-overlays.zh.md
Chinese translation of `2026-07-29-shared-base-config-overlays.md` — a paired rendering of that note (the base-plus-overlays composition, the one-level include rule and the precedence order), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-29-simplify-web-image-input-v1.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the web image-input note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-29-simplify-web-image-input-v1.md
- Purpose: Cut the first durable Web image-input slice down to what the current product actually decides on.
- Key abstractions: ordered image batches with per-message count and aggregate-byte limits, per-image byte and pixel limits, storage-free `validateImage` / `saveImage` / `readImage`, `ImageBlock` with an optional display name, `host.describe` without a policy snapshot.
- Data flow: the browser rejects unsupported declared formats before preview allocation; the host authoritatively decodes the complete batch, checks the current deployment bounds, validates every image **without storage writes** and only then saves every image while preserving submitted order in the resulting durable blocks; request buffering derives directly from the attachment service's aggregate image-byte limit.
- Non-obvious design decisions: speculative surfaces for arbitrary CLI provider mounting, output-modality discovery, alternative text, provider-neutral visual token pricing and browser lifecycle APIs were removed because they "would turn unchosen future behavior into public contracts"; a hard-coded provider-neutral image estimate "would look authoritative while being wrong", so provider usage stays the accounting source; validation atomicity is preserved without a batch transaction or rollback protocol, because storage-free validation already prevents a malformed later member from leaving earlier valid members unreferenced.
- Edge cases / failure handling: provider/model selection remains configuration and profile state — the CLI adds no image-specific flags, does not inspect the yml provider roster and does not dynamically mount an adapter; pre-request token pressure keeps the structural heuristic only on routes without declared image pricing, with the route-priced estimator supplying the provider-aware figure and reported usage staying exact.
- Surprising: the alternative of accepting only one image was rejected because comparing or combining several images is a current product requirement — the count and aggregate-byte bounds keep that path finite without reducing it to a single image.

### .agents/notes/archived/simplification/2026-07-29-simplify-web-image-input-v1.zh.md
Chinese translation of `2026-07-29-simplify-web-image-input-v1.md` — a paired rendering of that note (the batch bounds, the storage-free validation and the removed speculative surfaces), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-30-private-agent-send.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the private-agent-send note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-30-private-agent-send.md
- Purpose: Hide the concrete loop's routing matrix behind three semantic delivery operations.
- Key abstractions: `Agent.followup()`, `Agent.steer()`, `Agent.inject()`; the private `ReactLoopAgent.send()` helper; the removed exported `SendTarget` / `SendOptions`.
- Data flow: a follow-up always requests execution, steering requests the nearest step, and injection supplies model-facing context without requesting execution; the three public methods share the private routing mechanics.
- Non-obvious design decisions: the public `Agent.send()` exposed the routing matrix even though production callers use only the semantic operations, and its fourth combination (`next-turn` with `wakeup: false`) had no consumer beyond tests — keeping that latent capability public forced alternate `Agent` implementations and test fakes to accept implementation-level routing policy; a named public quiet-queue method was rejected too, since no production workflow needs work that stays parked until an unrelated delivery wakes it.
- Edge cases / failure handling: the removed quiet-queue capability can return only with a named consumer and explicit lifecycle semantics; `cancel({ keepInbox: true })` still preserves work already pending through the supported delivery paths; the Cordis API catalog no longer advertises `send`, `SendTarget` or `SendOptions`.
- Surprising: this partially supersedes the unified-delivery decision while *retaining* its internal routing and unified `user/message` representation — the change is about the public surface only.

### .agents/notes/archived/simplification/2026-07-30-private-agent-send.zh.md
Chinese translation of `2026-07-30-private-agent-send.md` — a paired rendering of that note (the three semantic delivery operations and the private routing helper), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-30-sidebar-resize-without-visible-pill.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the sidebar-resize note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-30-sidebar-resize-without-visible-pill.md
- Purpose: Remove the visible floating resize pill from the sidebar column border while keeping the resize interaction.
- Key abstractions: `AppFrame`, the sidebar's 8px resize hit strip, the `col-resize` cursor, pointer capture, animation-frame throttling, the handle pill pseudo-element.
- Data flow: the sidebar keeps the hit strip, cursor, pointer capture, frame throttling and width updates but no longer generates the pill pseudo-element; the details boundary keeps both its hit strip and its floating pill.
- Non-obvious design decisions: removing the drag interaction along with the pill was rejected because "the requested change is visual" — removing a working geometry control would unnecessarily narrow the interaction; a smaller or lower-contrast pill was rejected too, because any pill leaves an unwanted object on the boundary.
- Edge cases / failure handling: the layout component test still pins sidebar dragging and both handles' collapse lifecycle; a keyless browser scenario reads the generated pseudo-elements from the shipped composition and drags the invisible sidebar boundary to prove the interaction remains live.
- Surprising: the note is the shortest in this archive (26 lines) and still carries a full verification pair — a component test *and* a keyless browser scenario — because an invisible affordance is exactly what a screenshot-led review would miss.

### .agents/notes/archived/simplification/2026-07-30-sidebar-resize-without-visible-pill.zh.md
Chinese translation of `2026-07-30-sidebar-resize-without-visible-pill.md` — a paired rendering of that note (the retained hit strip and the removed pill pseudo-element), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the capability-neutral sandbox policy note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.md
- Purpose: Replace the sandbox policy's enforced-family and escalatable-family registries with one capability-neutral policy sentence.
- Key abstractions: the `sandbox:policy` context in `dsh-sandbox-policy`, `resolve({ session })`, the three mode wordings (`read-only`, `workspace-write`, `danger-full-access`).
- Data flow: the context derives its text only from `resolve({ session })` — there is no backend or tool family registration API, contribution map, ordering rule or registration-driven prompt invalidation; the filesystem, one-shot bash and terminal implementations continue to resolve and enforce the same per-call policy.
- Non-obvious design decisions: the inventory "was neither needed to state the file policy nor authoritative for model-visible capability" — a backend contribution could name a family whose model-facing tool was absent or hidden by request scope, while the tool schemas already tell the model which exact operations are available; the model therefore gets one standing file-policy statement, with tool schemas as the authority on availability and tool results as the authority on denials and approved wider retries.
- Edge cases / failure handling: omitting the context unless a backend advertises enforcement was rejected because it recreates the registration problem and makes policy visibility depend on optional contributors — the conditional wording stays truthful even when no applicable operation is available; capability additions and removals no longer churn the runtime-context snapshot, while mode and workspace changes still do.
- Surprising: the combinatorial family tests "reflected the design cost; they did not create it" — deleting the registries deletes the whole test matrix with them, which is the note's cleanest argument for why the registry was never a real feature.

### .agents/notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.zh.md
Chinese translation of `2026-07-31-capability-neutral-sandbox-policy-context.md` — a paired rendering of that note (the capability-neutral context, the three mode wordings and the tool-schema authority), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-31-drop-user-message-edit-stub.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the user-message edit-stub note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-31-drop-user-message-edit-stub.md
- Purpose: Remove a user-bubble edit button that nothing backed.
- Key abstractions: `MessageIconActions` (now clock / copy / branch only), the removed `edit` prop, `MessageItem`, the package README's Known Limitations, the web message-actions golden.
- Data flow: the button had no click handler, no client mutation and no host operation for resending an edited message; the row composes its actions from props, so reintroduction is a UI-only change once the mutation exists.
- Non-obvious design decisions: disabling the button with a tooltip was rejected — "a visible-but-dead control still advertises editing and costs the same explaining; removal is the honest state"; wiring it to the queue editor was rejected because the queue edits a message that has not been sent, while a settled user message is already in the transcript and in the model's context, so reusing that editor would silently mean something else.
- Edge cases / failure handling: the common locale keeps its generic `edit` term, which is shared vocabulary rather than this component's copy; the user bubble and the assistant chrome now differ only by clock side.
- Surprising: the note frames the gap as a *capability* question, not a UI one — reintroducing the control requires deciding "what the edited message does to the turn that already consumed it", which the August harness would face identically.

### .agents/notes/archived/simplification/2026-07-31-drop-user-message-edit-stub.zh.md
Chinese translation of `2026-07-31-drop-user-message-edit-stub.md` — a paired rendering of that note (the removed edit stub and the recorded missing capability), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the one-workspace-route note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md
- Purpose: Give Workspace creation one route (pick a host directory, new or existing) instead of two overlapping entries.
- Key abstractions: `menu.addWorkspace`, the `addIsTheOnlyEntry` predicate, `WorkspaceCreateFlow` renamed `WorkspacePickFlow` with a `createOnly` → `addOnly` prop, the injected `createWorkspace` narrowed from `{ name } | { path }` to `{ path }`, `workspace.create` / `WorkspaceCreateInput` / `WorkspaceRuntime.create` / `intentName`.
- Data flow: the create-by-name dialog and its `create.*` / `menu.createWorkspace` / `workspace.new` strings are gone; `--config-replace`-style CLI flags (`--workspace-root`) are gone too; the gateway has no `workspaceRoot` config, so the picker's configured reach defines the available host filesystem and there is no separate configured parent.
- Non-obvious design decisions: the stated rule is "**a menu exists to disambiguate between targets**" — when the add action is the only entry, the anchor gesture *is* that action, the flow opens directly and no popover renders, and consistency is the rule (menu ⇔ a choice exists), not the widget; the label names the outcome, not the mechanism, because it is now the only door to that outcome.
- Edge cases / failure handling: while `phase` is `pending` the hero keeps its menu and loading status rather than jumping into a flow the arriving workspaces would have made unnecessary; with the directory-flow occupant gone, the sidebar header renders no button at all rather than a dead one; the direct-open path carries the busy rule, so the anchor gesture is held exactly as the menu entry is disabled while a pick is being adopted.
- Surprising: the honest inconsistency is recorded rather than papered over — the hero chip still announces `aria-haspopup="menu"` while the direct-open path raises a dialog, because the flow owns the decision and the chip owns the announcement and they sit in different packages, so it is a named follow-up.

### .agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.zh.md
Chinese translation of `2026-07-31-one-route-to-add-a-workspace.md` — a paired rendering of that note (the single pick route, the `addIsTheOnlyEntry` rule and the deleted create-by-name branch), linked back to the English side.

### .agents/notes/archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the web steer-chrome note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md
- Purpose: Remove the Web UI's half-built steering surface while keeping host and runtime steering intact.
- Key abstractions: `InputMachine` / `SessionInput` / `InputActions.submit` / hub `defaultSink` (queue-only), `ConversationService.send(text)`, the durable `user/message` steer bubble, the `message.steering` locale strings.
- Data flow: the input machine always calls `session.prompt(..., 'queue')` and `ConversationService.send(text)` drops its mode argument; durable steer content renders as a plain right-aligned bubble (no badge, no user IconActions) so an externally submitted steer stays truthful on replay; host steering ownership — the agent-loop drain, session events and the wire mode — remains load-bearing for ACP, automation and non-Web clients.
- Non-obvious design decisions: the Web product had already locked the composer while a turn runs and never shipped a queue/steer menu, so the surviving `'queue' | 'steer'` mode was pure dead API surface and the interjection badge was a product label for a gesture users could not perform; hiding durable steer content was rejected because it would lie on replay when an external client steers.
- Edge cases / failure handling: the web steering e2e still POSTs `mode:'steer'` over `/api/session.prompt` and asserts durable **and** model-visible obedience — the capability is proven even though the chrome is gone; non-user next-step items (`agent.inject` context: approval notices, task completion, attached snapshots) broadcast with the `context` placement and never render as pending steering bubbles.
- Surprising: the note is explicitly "superseded in part" — composer steering shipped later and the context-source/steer-marks decision now owns the caption, so the recorded bullets describe a state that master has already moved past.

### .agents/notes/archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.zh.md
Chinese translation of `2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md` — a paired rendering of that note (the queue-only composer, the plain steer bubble and the retained host steering), linked back to the English side.

### .agents/notes/archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the explicit-config entrypoint note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md
- Purpose: Make raw executable use explicit — `dsh --config <path>` — instead of letting bare `dsh` select a product TUI implicitly.
- Key abstractions: `apps/cli/config/base.cordis.yml` (the neutral base), the required Include patch list, `--dump-default-config`, `--config <path> --dump-config`, `dsh web`, `dsh -p`, the `meta` / `upgrade` subcommands.
- Data flow: the named file must be an Include patch list applied directly over the base at the same include level; it is required for boot, is not a complete replacement tree, does not inherit `web.cordis.yml` or `$DSH_HOME/config.yaml`, and resolves relative paths from the invoking directory; the dumps use the Include implementation's own patch algorithm and YAML dialect.
- Non-obvious design decisions: the shared base "provides capabilities but creates no startup agent or interaction front door", so booting it bare was rejected — "a process that settles successfully but has no usable entry point hides a missing deployment decision"; keeping bare `dsh` as a TUI plus an explicit config subcommand was rejected because the CLI would then own two unrelated application policies.
- Edge cases / failure handling: boot errors fail loud and SIGINT/SIGTERM dispose the root before exit; built-bin acceptance runs the published JavaScript entry without tsx, checks both dump shapes and drives an invalid raw provider overlay to prove a boot failure settles and exits rather than hanging; the `--config` flag must survive the `/resume` handoff or resuming would silently change the agent.
- Surprising: this decision deletes the CLI's TUI application outright — overlay, launcher, first-run onboarding assets, app-level TUI fixtures, PTY harness, terminal journeys and snapshots — and it initially declined to delete the reusable TUI *package*; that package was deleted a day later by a separate note.

### .agents/notes/archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.zh.md
Chinese translation of `2026-08-03-explicit-config-dsh-entrypoint.md` — a paired rendering of that note (the required `--config` overlay, the deleted TUI product application and the neutral base), linked back to the English side.

### .agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the omit-invariants note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.md
- Purpose: Keep the optional invariant diagnostics out of both shipped `dsh` configuration trees.
- Key abstractions: `@deepseek-ai/dsh-invariants`, package-owned `./invariant` companions, the always-on session validation/snapshotting/freezing rules, the built CLI config-dump test.
- Data flow: the shipped trees under `apps/cli/config/` mount neither the service nor any `@deepseek-ai/dsh-*/invariant` entry, and the CLI package therefore carries no direct dependency on the invariant service; the built config-dump test rejects either entry for both surfaces.
- Non-obvious design decisions: the shipped TUI mounted the service and four stateful companions while the shipped Web tree omitted them, so the two product surfaces had different diagnostic cost and failure behavior — and a relational assertion failure could terminate an ordinary TUI run even though the always-on product boundary remained responsible for session validation and immutable history; mounting it with `enabled: false` was rejected because the shipped tree and CLI dependency would still carry diagnostics that install no checks.
- Edge cases / failure handling: invariant support stays available for focused tests, example bundles, generated SDK compositions and custom deployments that opt in explicitly; removing it from the repository entirely was rejected because package-owned checks remain useful there — only the default product config is out of scope.
- Surprising: the note draws the line at the *product* boundary, not at the feature — the capability survives in the repo and is simply not in the shipped default, which is the same "shipped config is a product decision" pattern the TUI-`todo_write` note uses.

### .agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.zh.md
Chinese translation of `2026-08-03-omit-invariants-from-shipped-config.md` — a paired rendering of that note (the diagnostics omitted from both shipped trees and the still-available opt-in path), linked back to the English side.

### .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the PowerShell picker-fallback note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — pair complete (both sides recorded, both files present).

### .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md
- Purpose: Delete the two-tier PowerShell fallback under the win32 native directory picker.
- Key abstractions: the koffi `IFileOpenDialog` child process, `@koromix/koffi-win32-x64`, the WinForms script with its `SetProcessDPIAware` opt-in, `pickNativeDirectory`, the `browse` backend chosen once at boot by `directory-picker-auto`.
- Data flow: the win32 tier is exactly the koffi child process and any failure surfaces as-is; the `pwsh.exe` → `powershell.exe` cascade, the DPI-corrected WinForms script and the triple-miss `AggregateError` are gone, so `pickNativeDirectory`'s win32 branch is a single call.
- Non-obvious design decisions: the stated criterion is "**a fallback tier exists only for tools the OS/desktop environment provides and may omit** (zenity → kdialog on Linux), while tools our own package ships (koffi) fail loud" — every trigger the cascade plausibly protected was a failure of our own packaging or deployment, not of the operating system, and a koffi/COM defect crashes only the dialog child process, so the correct response to our own bug is a surfaced failure.
- Edge cases / failure handling: callers now see the real cause (koffi load failure, COM refusal, dialog crash) instead of a chain-aggregated error whose most actionable entry was a PowerShell host; the `zenity` → `kdialog` Linux fallback and the boot-time probe stay; macOS `osascript` stays fallback-free.
- Surprising: the note preserves the real facts the deleted chain taught (PowerShell 7 renders the modern `IFileDialog` picker where 5.1 is hardwired to the legacy `SHBrowseForFolder` tree; a resolvable PowerShell 6 has no WinForms and exits 1 rather than failing with `ENOENT`) — and then deletes the mechanism anyway, because "our own packaged dependency" is the wrong thing to defend with a fallback.

### .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.zh.md
Chinese translation of `2026-08-04-drop-windows-powershell-picker-fallback.md` — a paired rendering of that note (the koffi-only win32 tier and the fallback criterion), linked back to the English side.

### .agents/notes/archived/simplification/2026-08-04-remove-tui-package.i18n.yaml
Generated bilingual-pair consistency record: the git blob hashes of both language sides of the TUI-package removal note plus the re-record command; the sealed whole-file hash pair proving the two blocks match — the pair is complete on disk (both sides recorded and both files present), but note that the Chinese side `2026-08-04-remove-tui-package.zh.md` is assigned to shard `dsh-notes-archived-rest#3` in the manifest, so it is narrated there rather than here.

### .agents/notes/archived/simplification/2026-08-04-remove-tui-package.md
- Purpose: Delete the `@deepseek-ai/dsh-tui` package once removing the implicit `dsh` terminal application left it without a shipped composition.
- Key abstractions: `packages/ui/tui` (renderer, interactive command and question adapters, extension overlays, snapshot fixtures, the patched `pi-tui` dependency, SDK scaffolding), the provider-neutral `dsh-user-questions` / `dsh-commands` / presentation services.
- Data flow: the package is deleted without a compatibility package or alias — source, package tests, terminal snapshots, dependency declarations, the patched `pi-tui` artifact, workspace references, the generated service catalog entry and documentation all go together; generic host and agent-loop capabilities are unchanged, so a host application can still mount the provider-neutral command, user-questions, approval and tool-presentation services directly.
- Non-obvious design decisions: keeping the package unshipped was rejected because that preserves the maintenance cost and keeps presenting an unsupported terminal frontend as reusable product surface without a real composition proving its lifecycle; moving it to examples or experimental was rejected because "moving code does not provide a current product need, a maintained deployment, or assembled acceptance"; keeping the SDK option was rejected because the generator would then be the package's only in-repository consumer, scaffolding an application the repository no longer accepts end to end.
- Edge cases / failure handling: existing imports and `cordis.yml` rows that depend on the package fail instead of being translated; the SDK project toolchain that remained as the package's final consumer is deleted by a separate note; repository searches and generated catalogs must contain no TUI package, dependency patch, service key or package link.
- Surprising: the note consolidates the deleted package-only records that could not stay current — session identity visible during long conversations, duplicate model labels removed, elapsed timing and phase status attached to messages, workspace and branch context beside the prompt, and conservative parsing of complete XML wrappers for human-readable fallback output — with the standing rule that "a future XML fallback must still use a real parser rather than regular expressions".

## Ideas worth stealing

- **Model-request recovery is a waterfall return value, not a public agent command** - `.agents/notes/archived/simplification/2026-07-27-request-error-retry-action.md:14` - `agent/request-error` returns `{ kind: 'retry' }` and the loop reads it *after* the waterfall settles, re-checking the turn signal so cancellation during recovery wins. August's loop keeps a mutable retry window beside a public `retry()`; returning the action removes the window, the idle-resummon capability and the extra public method in one move.
- **Injected content reaches the model verbatim; the caller owns the framing** - `.agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.md:19` - DSH deleted the `<steering>`/`<context>` envelopes because "no model is trained on these tags", and recorded that a model actually *refused* a `<steering>` instruction as third-party metadata. August injects guidance and skill context through its own envelope machinery; the same argument applies — the projection should be a pass-through and the producer should own its frame.
- **Tool schemas are the authority on available capability; the policy context states one conditional fact** - `.agents/notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.md:20` - DSH replaced two sandbox capability registries with one sentence per mode and deleted the whole combinatorial test matrix with them. August maintains a per-tool listing-door and capability inventory for the same purpose; the registry is where approximation lives.
- **A menu exists to disambiguate between targets — if there is one entry, there is no menu** - `.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md:18` - One predicate (`addIsTheOnlyEntry`) removed a duplicated Workspace-creation route, the create-by-name dialog and its duplicate-name rule, and the wire's `name` member. August's composer has several multi-entry popovers that could take the same predicate.
- **A flush barrier should report participation, not invent a second method** - `.agents/notes/archived/simplification/2026-07-27-intent-named-subagent-continuation-operations.md:22` - `SessionStore.flush(session)` returns `Promise<boolean>` (true = at least one listener participated) instead of offering `flush()` *and* `flushRequired()`, which differed only in whether an empty listener snapshot was acceptable. August's compaction and persistence paths carry similar policy-shaped second methods.
- **Config overlays patch rows; they never nest** - `.agents/notes/archived/simplification/2026-07-29-shared-base-config-overlays.md:20` - "include patches never cross an include boundary", so base + overlays must be applied as sibling patch lists at one level, and a patch replaces a row's whole `config` rather than merging. August's per-agent config overlays should be checked against this exact failure mode.

## Files skipped (with reasons)

- No manifest row for `dsh-notes-archived-rest#2` was skipped. All 260 have a per-file note: the previous pass covered 150 (the 102 `process/` files plus the 48 `simplification/` files up to `2026-07-04-remove-agent-steering-mirror.zh.md`), and this pass added the remaining 110 — 37 English `simplification/` notes in full form, 36 `simplification/` translations and 37 `simplification/` hash records — for 260 in total.
- `.agents/notes/archived/simplification/2026-08-04-remove-tui-package.zh.md` is **not** in this shard — the manifest assigns it to `dsh-notes-archived-rest#3` — but it is referenced from the `2026-08-04-remove-tui-package.i18n.yaml` note in this shard, and the on-disk pair is complete.

## Uncertainties

- The brief describes the `.i18n.yaml` sidecars as "per-heading hash records". For the **archived** notes they are the older **whole-file git blob hash** pair (two hashes, one per language side); the per-heading/section-keyed format is the *evolving* `docs/` variant described in `.agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.md:57`, which explicitly states that archived Agent Notes keep their sealed whole-file records. The notes in this shard use the accurate whole-file wording.
- The archived hash records are *sealed* snapshots ("as of the last confirmed-consistent state"), not live proofs. I could not re-run `verify-archived-agent-notes` or `verify-translation-pairing` (the clone is read-only and nothing may be executed), so "pair complete" in these notes means **structurally** complete: both sides recorded in the record and both files present on disk. Whether the recorded hashes still match the current file contents was not verified.
- Two translations keep the English H1 title verbatim (`.agents/notes/archived/simplification/2026-07-21-tui-todo-write-opt-in.zh.md:1`, `.agents/notes/archived/simplification/2026-07-21-tui-remove-cancel-command.zh.md:1`); the body is translated. Flagged in those two notes.
- The "Shard shape" section keeps the previous pass's description of the two families (its process/simplification counts, 102 + 158, still match the manifest) and was extended with the cross-shard split note and a summary of the four recurring deletion shapes in the `simplification/` family.
