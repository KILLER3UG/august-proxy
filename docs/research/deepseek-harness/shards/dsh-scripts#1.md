# deepseek-harness / dsh-scripts#1

## Shard shape

This shard is the repository's **build, gate, catalog-generation and release tooling** — 242 files under `scripts/`, split roughly evenly between executable gate/build scripts (`.ts`, `.mjs`, `.py`, `.sh`) and the Vitest specs that pin them. It contains no agent-loop code at all: the harness's runtime (the Cordis plugin graph, the LLM loop, tools, memory) lives elsewhere. What lives here is the machinery that *verifies* that runtime. Four clusters dominate:

1. **Build and packaging orchestration** — `build.ts` composes the repository's artifact/type-check steps into a dependency graph; `compile-referenced-projects.ts` defines the package build steps; `client-build-environment.ts` fixes the public `DSH_CLIENT_*` values embedded in browser artifacts; `build-exe-for-python-sdk*.ts` / `build-python-release.py` / `primary-runtime/*` build the single-file Node executable, the pinned Python runtime payload and the Python wheels; `local-bundle-registry.ts` + `dev-bundle-registry.ts` pack and serve a loopback npm registry.
2. **Static gates** — `check-workspace-constraints.ts` (package manifest policy), `repo-files.ts` (own glob walker), `gen-*-catalog.ts` (six documentation catalogs generated from source), `persistence-*` (an entire schema-fingerprint and compatibility-history subsystem), `coverage-*` (partitioned coverage), `oxlint-contract.spec.ts`, `doc-standard.spec.ts`, `jsdoc.ts` (JSDoc completeness).
3. **Release** — `release/families.ts` defines two independent publish sequences; `release/pack.ts` produces tarballs credential-free, `release/publish.ts` publishes them, `release/bump.ts` versions them, `release/verify-packed-install.ts` installs them into a throwaway consumer.
4. **Documentation-site projection and i18n** — `project-doc-site.ts` projects canonical repo Markdown into VitePress, `gen-translation-brief.ts` / `paired-markdown-derivatives.ts` keep the English/Chinese pair in sync, and `translation-pairing*` records consistency.

The cluster that a harness research effort should care most about is **not** the packaging one but the *failure-semantics* one: this repo encodes a consistent house style of "fail loudly, fail closed, name the defect, aggregate violations, never silently narrow a corpus" — and several of those mechanisms (idempotent publish with registry re-read, LPT-weighted test partitioning, coverage-location canonicalisation before a blob merge, an independent AST backstop that cross-checks a generator, cleanup that refuses to delete on any doubt) transfer directly to an agent harness.

## Per-file notes

### scripts/AGENTS.md
- Purpose: The five-line policy governing everything in `scripts/`.
- Key abstractions: none (prose).
- Data flow: n/a.
- Non-obvious design decisions: "Gate scripts invoke pnpm shell-free" and "keep platform adaptation in the gate that needs it instead of a shared platform layer" — the stated reason is that a shared platform layer becomes a second source of truth.
- Edge cases / failure handling: "Source-ownership gates use syntax-aware discovery, guard against an empty or narrowed corpus" — a gate whose corpus silently shrinks is treated as a defect.
- Surprising: "A spec that passes only when it runs alone is a defect in the spec" — because specs run in forked workers *beside* other gate processes in their job, so a spec must own every port, temp path and child process it acquires.

### scripts/agent-note-tree.ts
- Purpose: The shared structural source of truth for the `.agents/notes` tree.
- Key abstractions: `AGENT_NOTE_LIFECYCLES` (proposed/implemented/rejected), `AGENT_NOTE_CLASSES` (feature/bug-fix/simplification/architecture/process/testing), `walkAgentNoteTree(): { notes, errors }`.
- Data flow: reads the notes root, globs `<lifecycle>/**/*.md`, sorts, then checks depth, class folder and the `yyyy-mm-dd-topic.md` filename.
- Non-obvious design decisions: the lifecycle set is *closed* too — an unknown directory under `.agents/notes/` is an error, not a new lifecycle; the stated reason is that it "would otherwise hold Agent Notes invisible to the walk".
- Edge cases / failure handling: `.zh.md` counterparts are skipped (indexed via their English sibling); `AGENTS.md`/`CLAUDE.md` are allowlisted at a lifecycle root; a central `INDEX.md` is explicitly forbidden.
- Surprising: the caller treats a non-empty `errors` array as fatal — the walker returns problems rather than throwing, so one run can report every structural violation.

### scripts/archived-agent-notes.ts
- Purpose: Pure helpers for the frozen archive of historical Agent Notes.
- Key abstractions: `ArchiveManifest { version: 1, files }`, `gitBlobHash`, `parseArchiveManifest`, `renderArchiveManifest`, `validateArchiveManifestExtension`, `validateArchiveArtifacts`, `extendArchiveManifest`.
- Data flow: reads a manifest plus the artifact buffers, groups artifacts into `{kind}/yyyy-mm-dd-topic` triplets, and requires each triplet to be complete.
- Non-obvious design decisions: the manifest uses SHA-256 content hashes while the bilingual sidecar uses **Git blob hashes** — the repo's Git object format is deliberately not depended upon for the manifest, but the sidecar is written to be readable by Git tooling.
- Edge cases / failure handling: `validateArchiveManifestExtension` rejects any change to a sealed path *except* three hard-coded, exact before/after hash pairs for one authorised Figma-link removal — the "authorised transition" pattern.
- Surprising: `renderArchiveManifest` sorts paths with `localeCompare` so the committed manifest is byte-stable.

### scripts/archived-agent-notes.spec.ts
- Purpose: Spec pinning the archive manifest schema, triplet completeness and seal immutability.
- Key abstractions: a `fixture()` helper building one complete triplet.
- Data flow: constructs in-memory `Map<string, Buffer>` artifacts and asserts on the error strings.
- Non-obvious design decisions: it asserts the *direction* of the authorised transition — `before→after` is allowed, `after→before` is not — so the exception cannot be reused as a general escape hatch.
- Edge cases / failure handling: covers missing triplets, invalid archive dates (`2026-02-30`), an archive date predating the note filename, and divergent English/Chinese archive dates.
- Surprising: it also asserts that historical formatting is preserved — a note titled `# Historical decision` rather than `# Agent Note: …` still validates.

### scripts/attribute-chunk-bytes.mjs
- Purpose: Attributes a built chunk's minified bytes back to source npm packages / workspace dirs via its sourcemap.
- Key abstractions: a zero-dependency VLQ decoder (`B64` table, `charToInt` map).
- Data flow: reads `<chunk>.js` and `<chunk>.js.map`, walks `map.mappings` line by line, and accumulates bytes per source.
- Non-obvious design decisions: written as plain `.mjs` with no dependencies because it is the companion to the shell chunk-layout decision; the stated purpose is verifying vendor/index membership after changing `VENDOR_PACKAGES`.
- Edge cases / failure handling: unmapped lines are counted separately so a partial map is visible rather than silently redistributed.
- Surprising: the read tool classifies this UTF-8 file as binary (likely due to the `/**…*/` comment content); I read it via shell `Get-Content` instead.

### scripts/benchmark-next-package-dependency.ts
- Purpose: Benchmarks *which additional Host package most reduces npm peer resolution*.
- Key abstractions: `applyFactsToRegistry`, `discoverBenchmarkCandidates`, `parseNextPackageBenchmarkOptions`, `Measurement`.
- Data flow: clones an in-memory registry index, applies one candidate's source-derived dependency facts, then measures `npm install --package-lock-only` against a loopback registry.
- Non-obvious design decisions: a two-stage search — a cheap coarse pass over all candidates, then a more repetitions for the top N finalists — so the expensive measurement is only spent where it decides something.
- Edge cases / failure handling: refuses a candidate that is not actually a reachable unconfigured Host package; throws if the registry has no entry for the candidate's workspace version.
- Surprising: candidates are discovered by *reachability* from the CLI package through non-optional peer edges, so an unreachable package can never be nominated.

### scripts/benchmark-next-package-dependency.spec.ts
- Purpose: Spec for the candidate-selection benchmark.
- Key abstractions: a hand-built `PackageDependencyFacts` fixture with `hostRuntimeSourceUses` / `hostRuntimeExportUses` maps.
- Data flow: applies facts to an in-memory registry and asserts on the resulting manifest fields.
- Non-obvious design decisions: asserts the *filesystem is untouched* — the benchmark is an in-memory operation.
- Edge cases / failure handling: checks that a type-only dependency does not become a runtime `dependencies` entry.
- Surprising: the fixture distinguishes `hostRuntimeSourceUses` from `allSourceUses`, which is how the policy knows a peer is genuinely a runtime import.

### scripts/benchmark-npm-resolution.ts
- Purpose: Benchmark npm's dependency-tree resolution against an all-local registry.
- Key abstractions: `buildRegistryIndex`, `resolveNpmPackageLock`, `benchmarkNpmResolution`, `runCommandWithTimeout`, `publishWorkspaceRange`.
- Data flow: serves package metadata from a loopback HTTP server that 404s unknown names and 500s any `/tarballs/` request (proving the measurement is metadata-only), then parses the resulting `package-lock.json`.
- Non-obvious design decisions: `workspace:*` / `workspace:^` / `workspace:~` ranges are *projected* to the real published version — because `pnpm pack` substitutes the member's version, and a hand-written range would name a version that does not exist.
- Edge cases / failure handling: `runCommandWithTimeout` sends SIGTERM, waits a grace period, then SIGKILL, and on Windows kills the whole tree with `taskkill /T`; it throws if a timed-out tree does not exit after SIGKILL.
- Surprising: `runNpm` strips **every** inherited `npm_config_*` variable and writes its own `.npmrc`, because a user's global `legacy-peer-deps=true` would silently change the measurement.

### scripts/benchmark-npm-resolution.spec.ts
- Purpose: Spec proving the benchmark is isolated and metadata-only.
- Key abstractions: a `processCanExecute` helper that reads `/proc/<pid>/stat` on Linux.
- Data flow: builds fake registries in temp dirs and runs real npm against them.
- Non-obvious design decisions: includes a *hostile* inherited npm config (`.npmrc` with `legacy-peer-deps=true` and `omit=peer`) and asserts the benchmark still resolves the peer — the isolation is a tested property, not an assumption.
- Edge cases / failure handling: the SIGKILL test is `skipIf(win32)` because the Linux `/proc` probe is used.
- Surprising: it asserts `result.archiveRequests === 0` on every case — if npm ever asks for a tarball, the metadata-only premise has broken.

### scripts/browser-bundled-externals.ts
- Purpose: Resolve the *direct* third-party inputs of the shipping browser builds, without emitting files.
- Key abstractions: `browserPackageOfFile`, `browserSourceAliases`, `browserBundledExternals`.
- Data flow: runs each package's real `tsdown.config.ts` through Rolldown and each app's real `vite.config.ts` through Vite with a `resolveId` plugin that marks workspace packages external and records the owning npm package of every direct import.
- Non-obvious design decisions: `realpathSync.native(root)` before anything else — the comment says Vite resolves through native realpath including Windows 8.3 alias expansion, so the root must be canonicalised the same way.
- Edge cases / failure handling: an unresolved runtime import **throws** rather than being skipped; a package declaring `dsh.client` without a browser build config throws.
- Surprising: it deliberately does *not* follow an upstream implementation's own imports — "Notices disclose direct dependencies; upstream implementation imports stay in the lockfile."

### scripts/browser-bundled-externals.spec.ts
- Purpose: Spec proving the browser dependency walk is accurate and side-effect free.
- Key abstractions: a `vi.mock('node:fs')` hook that lets the spec preserve a fake 8.3 alias.
- Data flow: builds fixture packages, runs the walk, asserts the recorded set.
- Non-obvious design decisions: the mock exists solely to reproduce Windows' realpath-vs-Vite-resolution difference — the spec is a portability regression test, not a unit test.
- Edge cases / failure handling: asserts that `lib/` and `apps/web/dist` are *not* created (no output) and that a `dist/sentinel.txt` is untouched.
- Surprising: it runs the whole matrix for both Rollup and Rolldown, detecting which engine Vite actually used via `this.meta.rolldownVersion`.

### scripts/build.ts
- Purpose: Build artifacts, type-check the aggregate programs, or both.
- Key abstractions: `BuildScope = 'complete' | 'artifacts' | 'check' | 'typecheck'`, `buildGates(root, scope, environment): Gate[]`.
- Data flow: parses `--scope`/`--profile`, builds a gate dependency graph, runs it through `runAggregate`, and writes a client build record.
- Non-obvious design decisions: the `typecheck` scope replaces the Host *bundle* with the bundle-free Typert pass, so declarations exist without emitting a bundle — and the comment states why the checks do not overlap: "No Host aggregate file imports a generated `/typert` or `/remote` subpath, so host-check never reads what a concurrent host-typert step writes."
- Edge cases / failure handling: refuses `--profile` with `--scope check|typecheck`; fails early with a named cause if Node's TypeScript type stripping is unavailable.
- Surprising: `environmentOverlay` computes an overlay that *removes* parent keys absent from the child (`undefined` entries), so a step cannot inherit a stale build variable.

### scripts/build.spec.ts
- Purpose: Spec pinning the build CLI's scopes and graphs.
- Key abstractions: an `artifactGraph` literal naming the serial order.
- Data flow: calls `buildGates` and compares the `needs` edges.
- Non-obvious design decisions: the sentinel test spawns Node with `--no-experimental-strip-types` and asserts the build refuses *before any step runs*.
- Edge cases / failure handling: also pins the removed `--artifacts-only` flag so it cannot come back.
- Surprising: the artifact order is `native → host-src → host-bundle → desktop-bundle → client-src → client-bundle → web`, and the aggregate checks are attached to their own face's compilation only in `complete`/`typecheck`.

### scripts/build-exe-for-python-sdk.ts
- Purpose: Build the `dsh` single-file executables and the dev Node carrier for the Python runtime wheel.
- Key abstractions: a `Target` class parsing `<nodeRange>-<platform>-<arch>`, `ASSET_GLOBS`, `PLATFORMS`/`ARCHES`.
- Data flow: validate the closure → build → deploy → stage → `pkg --sea` → copy into the Python package.
- Non-obvious design decisions: whole-tree assets cover Cordis's runtime *bare-package* imports, "which pkg's static analysis cannot see" — so `package.json` files are included explicitly because bare-name resolution depends on them.
- Edge cases / failure handling: Windows supports x64 only (rejected before any build step); the whole closure is verified before deploying.
- Surprising: the file is 622 lines; I read lines 1–130 plus the symbol scan, so the pkg invocation body was surveyed rather than read line by line.

### scripts/build-exe-for-python-sdk.spec.ts
- Purpose: Spec driving the builder CLI end to end with a fake pnpm.
- Key abstractions: an `isolatedPnpmEnvironment` that strips `npm_execpath`/`PNPM_HOME`.
- Data flow: points `npm_execpath` at a script that appends its argv to a JSONL file, then asserts the recorded command sequence.
- Non-obvious design decisions: the spec asserts the *order* — closure verification first, then build, then deploy — because that order is the safety property.
- Edge cases / failure handling: asserts that a failed closure check stops before artifact building or deployment, and that the rejected-flag path produces **no stdout at all**.
- Surprising: it also asserts the dispatcher stays on the Python packaging surface (`runtime-bootstrap.mjs`), i.e. `apps/cli/src/runtime-bootstrap.ts` must not exist.

### scripts/build-exe-for-python-sdk-staging.ts
- Purpose: Prepare a symlink-free executable runtime payload with shared workspace module instances.
- Key abstractions: `deduplicateStagedWorkspacePackages`, `materializeStagedLinks`.
- Data flow: reads pnpm's `.modules.yaml` `hoistedLocations`, then either removes duplicate copies or dereferences links.
- Non-obvious design decisions: duplicates are shared only when the **dependency identity** matches (`name@file:` with the same peer set) — different peer resolutions and third-party packages keep their installed locations, because sharing them would break `instanceof` checks.
- Edge cases / failure handling: all metadata paths are validated *before* any deletion; a path outside the deployed `node_modules` throws.
- Surprising: one link is not a package — when the deploy target sits inside the deployed project, pnpm links that project into its own `node_modules`; dereferencing it would copy the payload into itself, so the entry is dropped.

### scripts/build-exe-for-python-sdk-staging.spec.ts
- Purpose: Spec for the symlink-free staging.
- Key abstractions: a `listSymlinks` helper proving no symlink survives.
- Data flow: builds symlink fixtures and runs the two functions.
- Non-obvious design decisions: the dedupe test uses `createRequire` to prove the *resolved module identity* is shared for one peer set and distinct for another — behaviour, not file layout.
- Edge cases / failure handling: invalid `.modules.yaml` metadata must throw before anything is removed.
- Surprising: the `.bin` command-shim directory is removed entirely, not dereferenced.

### scripts/build-exe-for-python-sdk-office.ts
- Purpose: Keep LibreOffice workers, prebuilt engines and their dependencies on the real filesystem.
- Key abstractions: `runtimeNpmArchive`, `officeSidecarArchives`, `downloadOfficeSidecar`, `OFFICE_ASSET_IGNORES`.
- Data flow: reads `pnpm-lock.yaml` for the SHA-512 integrity, then downloads each pinned tarball into the sidecar.
- Non-obvious design decisions: integrity comes from the **workspace lock**, not from a registry query — so the build does not depend on registry metadata being available or stable.
- Edge cases / failure handling: a package directory must be relative and inside `node_modules/`; absolute paths or `..` segments are rejected.
- Surprising: `pkg` exclusions are applied to dependency `files` as well as root asset globs, so the Office kit is never inlined into the executable.

### scripts/build-exe-for-python-sdk-office.spec.ts
- Purpose: Spec for the Office sidecar.
- Key abstractions: fixture staged closures per platform.
- Data flow: resolves installed optionals and downloads pinned packages.
- Non-obvious design decisions: a platform's native package is required even when a WASM engine is staged — "declared" beats "present".
- Edge cases / failure handling: an incomplete installed optional is an error, not an omission; an ancestor dependency outside the closure is rejected.
- Surprising: the npm integrity is asserted to come from the workspace lock *without* querying registry metadata.

### scripts/build-exe-for-python-sdk-resources.ts
- Purpose: Copy SDK runtime products while preserving relocatable resource links.
- Key abstractions: `syncPythonRuntimeProduct(source, destination)`.
- Data flow: stats the source, `rm`+`cp` with `verbatimSymlinks: true` for a directory, `copyFile` for a file, then re-applies the mode.
- Non-obvious design decisions: `verbatimSymlinks` preserves the *relative* `python`/`python3` aliases so the payload stays relocatable after the build output is deleted.
- Edge cases / failure handling: the destination is removed first so an obsolete product cannot linger.
- Surprising: the executable permission is re-applied from the source's mode bits after the copy.

### scripts/build-exe-for-python-sdk-resources.spec.ts
- Purpose: Spec for the resource copy.
- Key abstractions: a `resolvePrimaryRuntime` import proving the alias is usable afterwards.
- Data flow: copies, deletes `dist-exe`, then resolves the interpreter paths.
- Non-obvious design decisions: the POSIX symlink test is skipped on Windows ("Windows uses python.exe and does not require POSIX file symlink privileges").
- Edge cases / failure handling: a stale file in the destination must be gone after the sync.
- Surprising: it asserts the alias still resolves *after the build output directory is deleted*, which is the actual relocatability property.

### scripts/build-exe-for-python-sdk-native-pty.spec.ts
- Purpose: Spec for the node-pty addon resolution.
- Key abstractions: `resolveLinuxNodePtyAddon`, `resolveWindowsNodePtyAddons`.
- Data flow: creates fake addon files and asserts the chosen path.
- Non-obvious design decisions: the manylinux build wins over the target prebuild, because the release workflow's build is the one that will be shipped.
- Edge cases / failure handling: the error names *both* expected Linux locations.
- Surprising: Windows requires **two** ConPTY addons (`conpty.node` and `conpty_console_list.node`), and the error lists every missing one.

### scripts/build-exe-for-python-sdk-assets.spec.ts
- Purpose: Spec asserting the pkg asset globs.
- Key abstractions: a dry-run invocation of the builder.
- Data flow: runs the builder with `--dry-run --skip-build` and inspects stdout.
- Non-obvious design decisions: asserts `skill-badge/assets/**/*` is absent while `dsh-*/**/*.{svg,png,...}` is present — the per-package asset list is intentionally narrower than the wildcard.
- Edge cases / failure handling: `.py` files must not enter the Node payload.

### scripts/build-exe-for-ssh-helper.ts
- Purpose: Build a relocatable, native-host SSH helper archive with its private Node workers.
- Key abstractions: `buildSshHelper(argv)`, plus `ssh-helper/artifact.ts`, `ssh-helper/probe.ts`, `ssh-helper/native.ts`.
- Data flow: verify the runtime closure → bundle → stage → archive → verify the payload → probe the helper.
- Non-obvious design decisions: it reuses the *same* staging helpers as the Python SDK builder, so both carriers get identical symlink-free semantics.
- Edge cases / failure handling: the artifact manifest schema and a native payload probe gate the archive.
- Surprising: read the 22-line header and the symbol scan; the 11 KB implementation body was surveyed, not read line by line.

### scripts/build-python-release.py
- Purpose: Stage and build one Python wheel at the repository version.
- Key abstractions: `load_platforms`, `pep440_version`, `stage_sdk`, `stage_runtime`, `verify_wheel`.
- Data flow: stage a copy of `python/sdk` or `python/sdk-runtime`, rewrite the version, run `uv build --wheel`, then verify the produced wheel's contents.
- Non-obvious design decisions: the wheel filename uses the **PEP 440** spelling (`0.0.1rc1`) while the repository and the git tag use `0.0.1-rc.1` — "comparing them against the repository spelling would reject every prerelease build."
- Edge cases / failure handling: the wheel is re-opened as a zip and checked for the exact WHEEL tag, version, distribution name, MIT license expression, license file list, runtime payload contents and — on non-Windows — the executable bit on every runtime file.
- Surprising: the runtime payload's own `_resources.py` validator is executed *against the wheel archive* via `runpy`, so the wheel's download manifest is validated by the same code that will consume it.

### scripts/builtin-plugin-preview.spec.ts
- Purpose: Assert every built-in plugin illustration is one self-contained 640×300 SVG per required UI language.
- Key abstractions: a TypeScript-AST reader for `BUNDLE_PREVIEWS` in `PluginManagerPage.tsx`, plus a JSDOM `DOMParser`.
- Data flow: parses the page's AST, resolves each `import` to an `./assets/*-preview(.zh).svg` path, reads the file and parses it as XML.
- Non-obvious design decisions: the SVG is validated as an *attacker-controlled document* — no `script`, `style`, `foreignObject`, `text` or animation elements, no `on*` attributes, and every `url(#…)`/`href` reference must resolve to an id that exists in the same file (a `data:` image is the only permitted external reference).
- Edge cases / failure handling: the English and Chinese variants must differ in bytes, and the pair must stay under 1 MiB.
- Surprising: the spec imports the bundle list from `OPTIONAL_BUNDLES` so a new bundle without a preview fails the gate rather than shipping a broken illustration.

### scripts/bundle-input-isolation.ts
- Purpose: Assert the actual filesystem and package ownership of every input supplied to a bundler.
- Key abstractions: `BundleInputIsolation` (with a per-build package-name cache) and `physicalBundleInput(id)`.
- Data flow: for each recorded input, resolve it to a physical path, canonicalise it through `realpath`, then look up the nearest owning `package.json` and check its name against the experimental policy.
- Non-obvious design decisions: canonicalisation walks *up* to the nearest existing ancestor before `realpath`, because a virtual or not-yet-written path may have a symlinked ancestor — "a symlink in an ancestor would make deletion cross the repository boundary" (the same reasoning as `clean.ts`).
- Edge cases / failure handling: `assertSourceMapInput` allows a missing source (dependency tarballs may omit their upstream sources) while `assertInput` requires the file to exist; an id with no physical path (a purely virtual module) is allowed through.
- Surprising: the class caches package identities per build and exposes `reset()` for a watch rebuild — otherwise every rebuild would re-stat the whole `node_modules` tree.

### scripts/change-scope.ts
- Purpose: Report the explicit committed and worktree scope of a repository change.
- Key abstractions: `ChangeScopeReport`, `ChangeScopeOptions`, `renderChangeScope(args, cwd)`.
- Data flow: resolves base/head to single commits, computes the unique merge base, then collects four *independent* path sets (committed between merge-base and head, staged, unstaged, untracked).
- Non-obvious design decisions: every Git invocation runs with `-c core.fsmonitor=false` and `GIT_OPTIONAL_LOCKS=0` — "does not execute a configured filesystem monitor" and does not take the index lock, so the report cannot mutate repository state.
- Edge cases / failure handling: `rev-parse --verify --end-of-options` plus `core.warnAmbiguousRefs=true` turns an ambiguous ref into a named error instead of a silent pick; paths are parsed with `-z` and decoded with a **fatal** UTF-8 decoder so a non-UTF-8 path fails loudly rather than corrupting the report.
- Surprising: `--no-renames` and `--no-textconv` are passed so the reported path set is stable regardless of Git's rename detection and any configured text filter.

### scripts/change-scope.spec.ts
- Purpose: Spec proving change-scope reports each path class independently and mutates nothing.
- Key abstractions: a `fixture()` that builds a bare origin plus a worktree, and a `repositoryState()` snapshot (status, HEAD, refs, index bytes, config bytes).
- Data flow: drives the report against real Git repositories in temp dirs.
- Non-obvious design decisions: the spec compares the **index and config files byte-for-byte** before and after the report, so "did not mutate state" is asserted rather than assumed.
- Edge cases / failure handling: covers a fresh branch with no same-name remote, a stacked base above a non-master branch, a trailing-space worktree path, a non-UTF-8 Git path, an ambiguous branch/tag collision, and a blob used as a ref.
- Surprising: it asserts the report is *deterministic* — two invocations produce byte-identical JSON.

### scripts/check-expected-filenames.sh
- Purpose: Reject tracked non-vendor filenames containing "golden".
- Key abstractions: a `git ls-files -z` with `:(icase,glob)` pathspecs.
- Data flow: collects the candidate paths into a temp file, then prints them with a suggested remedy.
- Non-obvious design decisions: the exclusion `':(exclude,glob)vendor/**'` honours "Vendored upstream paths follow vendor/README.md instead of repository naming policy."
- Edge cases / failure handling: the glob is case-insensitive (`icase`), and a null-delimited read handles paths with spaces; the script exits 0 with an explicit message when there are no violations.
- Surprising: the gate is about *naming honesty* — "Rename each file with an accurate term such as 'expected'." — it refuses the word "golden" because it implies a fixture is an expectation when it may not be.

### scripts/check-macos-deployment-target.py
- Purpose: Reject runtime executables that require a newer macOS than their wheel tag claims.
- Key abstractions: `parse_version`, `claimed_version`, `parse_otool_deployment_target`, `deployment_target`, `ensure_compatible`, `validate_deployment_targets`.
- Data flow: reads the platform table out of `build-python-release.py` via `runpy`, runs `otool -l` on each executable, parses the load commands, and compares the newest deployment target with the wheel tag.
- Non-obvious design decisions: both `LC_BUILD_VERSION` (`minos`) and the older `LC_VERSION_MIN_MACOSX` (`version`) forms are handled, and the *newest* target across all Mach-O slices wins — a universal binary with one older slice is still a problem.
- Edge cases / failure handling: the comparison is zero-padded tuple comparison, so `11.0` and `11` compare correctly; an `otool` output with no deployment-target load command is an error rather than a pass.
- Surprising: the platform table is imported from the release builder rather than duplicated, so the check cannot drift from the tags it is validating.

### scripts/check-vendor-manifest.sh
- Purpose: Enforce the vendoring discipline — a staged change under `vendor/*/src` or a vendored `bin.js` must come with a `vendor/README.md` change.
- Key abstractions: none (17 lines).
- Data flow: reads `git diff --cached --name-only` and greps for the two path shapes.
- Non-obvious design decisions: the contract is the manifest's *local-modification log* — "any staged change under vendor/*/src or a vendored bin.js must come with a vendor/README.md change in the same commit".
- Edge cases / failure handling: the guard fires only when a vendored source changed **and** the manifest did not; `grep ... || true` keeps `set -euo pipefail` from aborting on a no-match.
- Surprising: it inspects the *staged* set, so it is a pre-commit gate rather than a post-hoc audit — the log cannot drift from the diff it describes.

### scripts/check-workspace-constraints.ts
- Purpose: The workspace package invariant gate.
- Key abstractions: `expectedDshPackageFiles(manifest)`, `checkWorkspaceManifest`, `checkWorkspaceProtocol`, `checkExperimentalManifest`, `checkExperimentalDependencyIsolation`, `checkHierarchyShape`.
- Data flow: reads every workspace manifest (root + `pnpm-workspace.yaml` members), then compares each against a computed expectation.
- Non-obvious design decisions: the expected `files[]` list is **computed from the package's own exports** — icons, exported locale JSON, `./worker`, `./client`, `./loader`, `./store`, `./startup`, the Typert pairs, plus a per-package extras table — so a new export automatically changes the required payload.
- Edge cases / failure handling: ranges must be *exact*: `workspace:*` for the dsh family, `workspace:~` for vendored/native packages, and any other hand-written range is an error ("a hand-written range says nothing about the version the workspace actually carries, and `pnpm pack` leaves it alone").
- Surprising: the experimental-package rule allows the CLI package to depend on the launcher's named `OPTIONAL_BUNDLES` and *nothing else* experimental — the optional bundles ship switched off, so they are not a requirement.

### scripts/check-workspace-constraints.spec.ts
- Purpose: Spec for the workspace invariant gate (surveyed by its test names; ~40 cases).
- Key abstractions: fixture manifests built in temp roots.
- Data flow: runs each exported check against crafted manifests.
- Non-obvious design decisions: asserts the exact expected `files[]` for several real packages (Agent Team icon, Office skill bodies, the local speech worker, the Inspector worker and DevTools resources) — the payload list is pinned, not merely "some files".
- Edge cases / failure handling: covers the private plugin-market generator being exempt only in its own directory, and locale publication entries without their resource exports being rejected.
- Surprising: it asserts the current experimental publication set is *unrestricted* — a deliberate statement that the denylist is empty today.

### scripts/ci-compatible-toolcache.mjs
- Purpose: Redirect the Actions tool cache into runner temp.
- Key abstractions: none (8 lines).
- Data flow: asserts `RUNNER_TEMP` is absolute, then sets `RUNNER_TOOL_CACHE`.
- Non-obvious design decisions: it must run *inside* the setup-node process (`--import`), so the redirection affects only that step.
- Edge cases / failure handling: a missing or relative `RUNNER_TEMP` aborts with a named message.
- Surprising: the reason is stated: "The Actions runner exports RUNNER_TOOL_CACHE after step env. Run inside the setup-node process so version installs use runner temp rather than shared state."

### scripts/ci-compatible-selfhosted.spec.ts
- Purpose: Spec asserting the CI workflow's self-hosted routing rules.
- Key abstractions: an `evaluate()` that runs the workflow expression in a `node:vm` sandbox.
- Data flow: parses `.github/workflows/ci.yml` as YAML and evaluates `runs-on` under several contexts.
- Non-obvious design decisions: the comment states the limitation plainly — "Actions compares strings case-insensitively; JavaScript does not. This is not an Actions evaluator" — so the fixtures use equal-typed canonical-case values.
- Edge cases / failure handling: covers fork PRs, dependabot, empty repository names, unknown modes, and the `blacksmith` special case.
- Surprising: it spawns real Node children to prove the preload redirects `RUNNER_TOOL_CACHE` for setup-node but leaves later processes alone.

### scripts/ci-workflow.spec.ts
- Purpose: The 87 KB CI-contract spec (surveyed by its ~60 test names).
- Key abstractions: per-workflow YAML assertions.
- Data flow: reads the workflow files and asserts job/step structure.
- Non-obvious design decisions: "keeps at most ten worker jobs active", "retains aggregate diagnostics in required builds and protected publication", "cancels reusable CI builds without cancelling release-owned builds" — the spec encodes a resource and cancellation budget for the whole pipeline.
- Edge cases / failure handling: asserts the SSH native matrix is validated *before* allocating runners, and that a wheel's publication is separate from its complete validation.
- Surprising: it asserts that inserting a line above a recorded symbol makes a generated catalog stale — the "reads like a snapshot regression rather than a missing regeneration" trap is documented in `gen-cordis-catalog.ts`.

### scripts/clean.ts
- Purpose: Plan and remove repository-owned build output without crossing the repository boundary.
- Key abstractions: `RepositoryCleaner` with `plan()` and `clean()`.
- Data flow: walks the root `tsconfig.json` project-reference graph, collects each emitting project's `outDir` root, adds known residue paths, and deletes.
- Non-obvious design decisions: deletion targets are **derived from the project graph**, not from a hard-coded list, so a new package's output cannot be forgotten.
- Edge cases / failure handling: a manifest-less package directory is only removed when every remaining entry is known residue; one unknown file makes the *entire* clean fail ("Planning validates every target first, so an unsafe orphan prevents all deletion").
- Surprising: it resolves the *parent* of a target rather than the target itself, because `rm` unlinks a final symlink but a symlink in an ancestor would make deletion cross the repository boundary.

### scripts/clean.spec.ts
- Purpose: Spec for `RepositoryCleaner`.
- Key abstractions: an `addProject` fixture helper.
- Data flow: creates fake project graphs and asserts on what survives.
- Non-obvious design decisions: asserts that a package directory with an unknown file blocks deletion *of other targets too*.
- Edge cases / failure handling: the symlink-outside-the-repository case must refuse and leave the external project intact.

### scripts/client-build-environment.ts
- Purpose: Own the public `DSH_CLIENT_*` values embedded in browser artifacts.
- Key abstractions: `CLIENT_BUILD_PROFILE_SELECTOR`, `CLIENT_BUILD_RECORD_PATH`, `repositoryCommitHash`, `repositoryVersion`, `clientBuildProcessEnvironment`, `writeClientBuildRecord`.
- Data flow: resolves the profile, commit and version, applies them as a process-environment overlay, and records the result in `.dsh-build/client-build-environment.json`.
- Non-obvious design decisions: the record binds a *complete set of client artifacts* — the commit hash is embedded in the browser bundle, so a dirty worktree is recorded as dirty rather than silently embedded.
- Edge cases / failure handling: an explicit `DSH_CLIENT_COMMIT_HASH` that is not a Git hash is rejected rather than truncated.
- Surprising: `repositoryCommitHash` validates `/^[0-9a-f]{7,40}$/` and then slices to 7 characters — a full SHA is accepted but only the short form is published.

### scripts/client-build-environment.client.spec.ts
- Purpose: Spec for the client build environment (surveyed by test names).
- Key abstractions: fixture roots with a `package.json` and a client artifact tree.
- Data flow: resolves the environment and asserts on the recorded values.
- Non-obvious design decisions: "defines only public client values over a non-enumerable fallback" — the fallback exists so an absent value does not become a public empty string.
- Edge cases / failure handling: asserts dirty metadata is omitted when repository metadata is unavailable.

### scripts/client-bundle-css.spec.ts
- Purpose: Spec that CSS/image plugins register their physical files as watch dependencies.
- Key abstractions: a `bundlePlugin()` helper that pulls a plugin out of the real client config.
- Data flow: calls `resolveId` then `load` with a fake `addWatchFile`.
- Non-obvious design decisions: the plugin is fetched from the **real** `clientBundle()` config, so the spec fails if the plugin is removed from the build.
- Edge cases / failure handling: the inline (`?inline`) CSS loader must not emit the side-effect `data-plugin-css` marker.
- Surprising: without `addWatchFile`, a stylesheet edit silently does nothing in dev — the whole point of the spec.

### scripts/client-bundle-purity.spec.ts
- Purpose: The 28 KB client bundle purity spec (surveyed by test names).
- Key abstractions: per-kind fixture bundles (static/dynamic).
- Data flow: builds client bundles and inspects the emitted output.
- Non-obvious design decisions: the gate is an *allowlist*: only the pure spill notice entry may inline, exact generated Remote contributions may inline, and **any other `@deepseek-ai` leak throws**. Cross-plugin value imports throw too — bare names and `/client` subpaths alike.
- Edge cases / failure handling: experimental inputs are rejected even when hidden behind an import alias, behind a CSS virtual loader, or preserved only by an emitted source map.
- Surprising: one case "proves the static library otherwise hides the experimental input in its emitted JavaScript" — i.e. the gate has to look at the *resolved* module, not the import specifier.

### scripts/client-tsconfig.spec.ts
- Purpose: Spec that the client aggregate loads package CSS declarations.
- Key abstractions: `clientCssDeclarations()` mirroring the package layout.
- Data flow: parses `tsconfig.client.json` with the TypeScript API and compares the loaded `css-modules.d.ts` set.
- Non-obvious design decisions: the assertion is about *loading without workspace-link realpaths*, which is what breaks on Windows junctions.

### scripts/compile-referenced-projects.ts
- Purpose: Compile and bundle package projects without repeating aggregate typechecks.
- Key abstractions: `LibraryStep`, `LibraryStepId`, `referencedProjectsCompilerArgs`, `runPnpmCommand`.
- Data flow: reads `tsconfig.<face>.json`, resolves its project references, and emits a `tsc -b` invocation.
- Non-obvious design decisions: project paths are passed **relative** to the root — "Relative arguments keep the complete workspace graph below Windows' command-line limit."
- Edge cases / failure handling: requires `noEmit: true` on the aggregate ("to exclude its aggregate program") and non-empty references; an invalid config throws with flattened diagnostics.
- Surprising: there is a `benchmark-emit` mode that passes `--noCheck`, deferring semantic diagnostics to the required full builds — a real speed/faithfulness trade with its own spec.

### scripts/compile-referenced-projects.spec.ts
- Purpose: Spec for the build order and the bundle-free Host contracts (surveyed by test names).
- Key abstractions: fixture project graphs.
- Data flow: drives the compiler in a temp workspace.
- Non-obvious design decisions: the bundle-free Typert pass "writes Typert declarations from source **when Host compilation fails**", and "fails when the Typert pass rejects a contributor while Host compilation completes" — the two failures are reported independently.
- Edge cases / failure handling: benchmark emission must not change artifact bytes, and semantic errors must be re-checked afterwards without forcing a rebuild.

### scripts/cordis-config-files.ts
- Purpose: Cordis Loader configuration file discovery.
- Key abstractions: `cordisConfigFiles(root)`.
- Data flow: globs `**/*cordis*.yml|yaml`, excluding `.claude`, `node_modules`, `vendor` and `**/*.i18n.yaml`.
- Non-obvious design decisions: the `*.i18n.yaml` exclusion is explicit in the docstring: "Translation consistency records are YAML sidecars, never Loader inputs."
- Edge cases / failure handling: n/a (pure discovery).

### scripts/cordis-config-files.spec.ts
- Purpose: Spec for the discovery.
- Key abstractions: a temp tree with decoy directories.
- Data flow: asserts the exact returned list.
- Non-obvious design decisions: the fixture deliberately includes `docs/cordis-primer.i18n.yaml` to prove the sidecar exclusion.

### scripts/cordis-core-api.ts
- Purpose: Generate detailed Cordis core API pages from the pinned vendor declarations.
- Key abstractions: `CORDIS_CORE_API_PAGES` (five curated pages), `renderCordisCoreApiPage`.
- Data flow: parses the vendored `context.ts`, `events.ts`, `fiber.ts`, `registry.ts`, `service.ts` with the TypeScript API, extracts members (including `Pick<>` heritage), and renders Markdown.
- Non-obvious design decisions: `heritageMembers` follows `Pick<Class, 'a'|'b'>` clauses so the interface merge and the class contribute the *same* member group and share one JSDoc.
- Edge cases / failure handling: a public member with no JSDoc prose is a *violation*, collected and thrown as one aggregate error.
- Surprising: `stripBodies` removes function bodies from pasted declarations so a pasted `Effect` shows its shape, not its implementation.

### scripts/cordis-core-api.spec.ts
- Purpose: Spec for the core API pages.
- Key abstractions: a fixture vendor tree with one undocumented class.
- Data flow: renders the real pages and asserts on their content.
- Non-obvious design decisions: asserts the exact prose of the `Effect` member ("Register a cleanup-aware effect on this fiber.") — the generator reproduces the source JSDoc verbatim.
- Edge cases / failure handling: the undocumented class must throw naming the class.

### scripts/cordis-walk.ts
- Purpose: AST helpers shared by the Cordis generators.
- Key abstractions: `contextMergeFiles`, `cordisModuleBody`, `contextKeyMap`, `eventNameList`.
- Data flow: a cheap textual prefilter (`MERGE_HEAD`) then an AST match on `stmt.name.text`.
- Non-obvious design decisions: one file may legally hold **several** `declare module '@deepseek-ai/cordis'` blocks, so the exhaustiveness scan must read them all — the module-local helper returns every block while the vendor renderer takes only the first.
- Edge cases / failure handling: `eventNameList` reads method and property members alike "so a declaration form the projector would reject still enters the exhaustiveness scan" — the scan is deliberately more permissive than the projector.
- Surprising: the prefilter is quote-style agnostic because the AST match never sees the quotes.

### scripts/cordis-yaml.ts
- Purpose: Cordis YAML parsing and Loader-entry classification.
- Key abstractions: `loadCordisYaml`, `isJsExpr`, `isCordisGroupEntry`, `isAgentPresetEntry`, `presetDefinitions`.
- Data flow: parses YAML with a custom `tag:yaml.org,2002:js` type whose `construct` returns `{ __jsExpr: data }`.
- Non-obvious design decisions: the `!!js` tag is **preserved as data instead of executed** — a Loader config is untrusted input and must never evaluate.
- Edge cases / failure handling: a non-scalar `!!js` value throws a `TypeError`.
- Surprising: `presetDefinitions` recurses into `insert` and group `config` arrays, so agent presets nested inside ordinary groups are still found.

### scripts/coverage-canonical-locations.ts
- Purpose: Canonicalise coverage locations inside a partition, before its blob is written.
- Key abstractions: `END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER`, `canonicalizeEndOfLineColumns`, a default-export Vitest reporter.
- Data flow: rewrites every non-finite `end.column` in the istanbul map in place.
- Non-obvious design decisions: `ast-v8-to-istanbul` ends a whole-line statement at column `Infinity`, which the blob's JSON hop turns into `null`; `istanbul-lib-coverage` reconciles the per-environment spellings of one statement only through **numeric** columns, so a `null` column leaves a client-only spelling behind as a phantom uncovered statement.
- Edge cases / failure handling: throws if the payload carries no istanbul `data` record — "a Vitest change that stops handing reporters that map fails the partition instead of leaving every location uncanonicalized."
- Surprising: the fix is a finite stand-in for `Infinity` that keeps the line-end meaning and keys identically in every blob, so the merge attributes the coverage one process would have.

### scripts/coverage-exempt.ts
- Purpose: The list of heavy suites run uninstrumented beside the instrumented gate.
- Key abstractions: `CoverageExemptSuite { filter, exclude }`, `COVERAGE_EXEMPT_ENV`.
- Data flow: `vitest.config.ts` drops the excluded suites when the env var is set.
- Non-obvious design decisions: membership requires that "every coverage-measured file it executes in-process is already fully covered by other suites, so removing it from the instrumented run changes no threshold outcome" — correctness signal is unchanged; only the v8 instrumentation tax is dropped.
- Edge cases / failure handling: CLI `--exclude` cannot express this because it does not reach per-project include resolution, hence the env var.
- Surprising: the `scripts/install-lefthook.spec.ts`, `oxlint-contract.spec.ts` and `change-scope.spec.ts` entries are exempt because they spawn real child processes.

### scripts/coverage-exempt.spec.ts
- Purpose: Mechanical guard for the exempt roster.
- Key abstractions: a spec inventory mirrored from `vitest.config.ts`.
- Data flow: globs each entry's exclude glob and compares with the filter's prefix match.
- Non-obvious design decisions: the guard exists so "a renamed suite cannot silently fall out of the uninstrumented gate while its exclude goes stale."
- Edge cases / failure handling: asserts the two selectors always agree and that entries never overlap (no suite is double-run or double-excluded).

### scripts/coverage-file-times.ts
- Purpose: Record coverage partition file costs without retaining test results or coverage maps.
- Key abstractions: a Vitest reporter writing `outputFile.fileTimes`.
- Data flow: `onTestRunEnd` sums environmentSetup + prepare + setup + collect + duration per module.
- Non-obvious design decisions: it reads only `moduleId` and `diagnostic()` — the Vitest module retains tests and coverage through its project, so serialising it would be catastrophic.
- Edge cases / failure handling: `onInit` throws when `outputFile.fileTimes` is absent.

### scripts/coverage-file-times.spec.ts
- Purpose: Spec for the timing reporter.
- Key abstractions: a module double whose `toJSON` throws.
- Data flow: asserts the JSON output and its newline.
- Non-obvious design decisions: the double *throws on serialisation* — proving the reporter never touches the module beyond path and diagnostics.
- Edge cases / failure handling: an empty run writes `[]\n`.

### scripts/coverage-fork-diagnostics.ts
- Purpose: Add exit metadata without changing Vitest's fork scheduling or failure handling.
- Key abstractions: `DiagnosticForkWorker extends ForksPoolWorker`, `coverageForkPool`.
- Data flow: hooks the child's `exit` event and logs a JSON record.
- Non-obvious design decisions: an orderly stop silences the record, but a worker that **errored** keeps its code and signal — because "a channel that closed under a send means the worker is not shutting down orderly, so the exit that follows keeps its code and signal."
- Edge cases / failure handling: a stop requested before the error still silences that exit; the request is cleared on `testfileFinished` so a later exit is not attributed to a finished file.
- Surprising: `deserialize` is overridden to detect the completion response — the diagnostics hook has to understand Vitest's worker protocol to avoid a false attribution.

### scripts/coverage-fork-diagnostics.spec.ts
- Purpose: Spec for the diagnostic fork pool (surveyed by test names).
- Key abstractions: a real forked Vitest run with the diagnostic pool.
- Data flow: spawns the fixture config and inspects the emitted log.
- Non-obvious design decisions: the negative control "observes the same child failure **without** diagnostics under the stock pool" — proving the extra output comes from the patch and not from Vitest.
- Edge cases / failure handling: "retains an unexpected zero exit instead of interpreting it as suite success" and "records an exit before any file request without inventing a file owner".

### scripts/coverage-partitions.ts
- Purpose: Coordinate single-worker Vitest coverage partitions and one merged report.
- Key abstractions: `CoveragePartitionCoordinator`, `assignWeightedPartitions`, `parseFileInventory`, `coverageTestTimeoutOptions`, `partitionConfigSource`.
- Data flow: collect the inventory with `vitest list --filesOnly`, drop the exempt suites, assign files to partitions by longest-processing-time, write one narrowed Vitest config per partition, run them concurrently, validate the blob set and the test-file inventory, then merge once.
- Non-obvious design decisions: the per-project split is preserved — the `thread-safe` and `process-bound` projects are mutually exclusive, so handing the whole partition list to every project "would run plain files twice".
- Edge cases / failure handling: durations are persisted *before* blob validation ("a missing blob aborts the run, but the completed partitions' timings are still worth keeping"); a failed run retains inventories, configs and reports under `coverage/.partitioned`.
- Surprising: the lane budget travels in the **config**, not a CLI flag — Vitest forwards a fixed list of CLI overrides into projects and `--hookTimeout` / `--expect.poll.timeout` are not on it, so the config is the only route that works.

### scripts/coverage-partitions.spec.ts
- Purpose: The 32 KB partitioned-coverage spec (surveyed by test names).
- Key abstractions: an injected `runCommand` so the coordinator can be driven without real processes.
- Data flow: asserts on the commands issued and the configs written.
- Non-obvious design decisions: "starts the heaviest partition first for fail-fast" — the LPT assignment's ordering is used for latency, not just balance.
- Edge cases / failure handling: refuses omitted/unexpected/duplicate/malformed/missing-report test results "even when every partition exits successfully"; waits for every partition after one spawn failure; reports signal termination before missing-blob validation.
- Surprising: one case asserts a link-shaped coverage path is unlinked **without touching its target**.

### scripts/coverage-uncovered-locations.cjs
- Purpose: Istanbul reporter printing one clickable `path:line:col` per uncovered statement, branch path and function.
- Key abstractions: `UncoveredLocationsReport extends ReportBase`.
- Data flow: `onDetail` collects uncovered items per file, `onEnd` prints them.
- Non-obvious design decisions: the file is **CommonJS by requirement** — `istanbul-reports` loads custom reporters with a bare `require()` outside the tsx/ESM pipeline, so it can be neither TypeScript nor ESM; and it is wired in by absolute path because `require()` would resolve a relative specifier against istanbul-reports' own directory.
- Edge cases / failure handling: files at 100% print nothing, so a green run stays silent; a branch arm with an empty location falls back to the branch's own span.
- Surprising: columns are 1-based for the editor even though istanbul is 0-based, and the "to line:col" suffix degrades to line-only for whole-line statements.

### scripts/demo-ptc.mjs
- Purpose: Run one headless task through the shipped PTC mode composition.
- Key abstractions: none.
- Data flow: spawns `apps/cli/src/bin.ts --profile headless <task>` with `DSH_TOOLS_MODE=ptc`.
- Non-obvious design decisions: the default task is a self-inspection prompt, so the demo needs no argument.
- Edge cases / failure handling: the child's exit code is propagated; a signal becomes exit 1.

### scripts/dependency-catalog/package-lock.json
- Purpose: The recorded public npm resolution of `@deepseek-ai/dsh` used to generate the dependency catalog.
- Key abstractions: npm `lockfileVersion: 3` metadata.
- Data flow: consumed by `gen-dependency-catalog.ts`.
- Non-obvious design decisions: it is committed so the catalog can be regenerated without the network.
- Edge cases / failure handling: `gen-dependency-catalog.spec.ts` rejects a missing, edited or stale copy.
- Surprising: 344 KB / 8,539 lines of generated npm metadata — I opened the first 12 lines and confirmed the structure rather than reading it line by line.

### scripts/dependency-catalog/resolution.json
- Purpose: The environment the resolution was captured under.
- Key abstractions: nine lines of metadata.
- Data flow: compared by the freshness check.
- Non-obvious design decisions: the npm/node/platform/arch/strategy tuple is recorded so a different resolver configuration invalidates the catalog.
- Edge cases / failure handling: `gen-dependency-catalog.spec.ts` asserts the checked-in JSON stays synchronised with it.

### scripts/desktop-package-source.spec.ts
- Purpose: Spec proving desktop packaging's source-selection rules.
- Key abstractions: a temp git repo with tags and branches.
- Data flow: extracts the `node -e "..."` program out of the workflow and runs it with `DSH_PACKAGING_PRESET`/`PACKAGE_SOURCE_REF`.
- Non-obvious design decisions: the spec *runs the workflow's inline program* rather than re-implementing it.
- Edge cases / failure handling: production from a feature branch is refused; a SHA or PR ref is refused ("Select a branch in this repository, not a SHA or PR ref"); a stale version adapter makes even a matching tag fail.
- Surprising: the `test` preset accepts a feature branch — testing branches is allowed, publishing them is not.

### scripts/desktop-publish-workflow.spec.ts
- Purpose: Spec for the desktop publish workflow.
- Key abstractions: YAML job/step structure assertions.
- Data flow: reads `.github/workflows/desktop-publish.yml`.
- Non-obvious design decisions: the approval digest is prepared **without an Environment** and bound to the publish job, so no secret is exposed before approval; secrets are gated by the production Environment instead.
- Edge cases / failure handling: asserts the step order `check → key → app → publish` and that `key`/`app` are production-only.

### scripts/dev-bundle-registry.ts
- Purpose: Build, pack and serve the Official bundles' local dependency closure as a loopback registry.
- Key abstractions: `Interrupted`, `runStep`, `printSummary`, `runId`.
- Data flow: catalog → selection → build → pack into an immutable run directory → write the manifest → serve → wait for a signal.
- Non-obvious design decisions: the manifest is the **completion marker** — "only a fully packed run has one"; and the summary is printed only after the registry is actually listening ("the summary is never printed for a registry that did not listen").
- Edge cases / failure handling: a second signal during shutdown forces `process.exit(130)` instead of falling back to the default kill; a signal that stopped packing is reported as the same stop as a stopped build step.
- Surprising: each run gets an immutable, timestamped directory, so "a later run never overwrites these bytes".

### scripts/dev-web.spec.ts
- Purpose: Spec for the dev web loop.
- Key abstractions: a `fakeStage` double and a `StageSupervisor`.
- Data flow: drives the supervisor with double stages and runs a real tsdown watch.
- Non-obvious design decisions: the supervisor reports **no** stage as stale when every survivor exited, and waits for stages the terminal already interrupted before signalling survivors.
- Edge cases / failure handling: a malformed `--poll` is rejected with the offending value in the message.

### scripts/dev-web.ts
- Purpose: The Web development loop: build once, serve, keep every browser artifact rebuilt.
- Key abstractions: `StageSupervisor`, `StageHandle`, `parseDevWebArguments`, `discoverPluginDirs`, `discoverLibraryDirs`, `watchClientPlugins`, `devWebBuildEnvironment`.
- Data flow: one build stage, then three watchers (`tsc -b --watch`, `tsdown watch`, `vite build --watch`) and `dsh web`.
- Non-obvious design decisions: "A missing watcher does not fail — it silently shows the previous artifact, so an edit appears to do nothing; any stage exiting on its own therefore stops the loop with exit code 1." And reload signaling is deliberately *not* this script's business: the host webserver stat-polls the bundles and broadcasts `rebuilt` itself.
- Edge cases / failure handling: the script states it MUST NOT run beside `pnpm run build` because they write the same trees.
- Surprising: the 19 KB body was surveyed via the header and symbol scan.

### scripts/doc-budgets.manifest.json
- Purpose: Line budgets for the key documentation files.
- Key abstractions: a path → line-count map.
- Data flow: consumed by a documentation-size gate.
- Non-obvious design decisions: budgets differ per file (AGENTS.md 2080 vs packages/README.md 994) — budget is allocated by role, not uniformly.
- Edge cases / failure handling: n/a.

### scripts/doc-standard.spec.ts
- Purpose: The 25 KB documentation-standard spec (surveyed by test names).
- Key abstractions: document-kind and template maps.
- Data flow: reads the `dsh-doc` skill and the README set.
- Non-obvious design decisions: "defines controlled English as a precision-preserving review discipline" — the style rule is a skill, not a lint.
- Edge cases / failure handling: rejects missing/duplicated/unclosed/malformed release records and URL-injecting evidence tags; requires exact English/Chinese physical line alignment for the reference-example pair.

### scripts/doc-typecheck-paths.ts
- Purpose: Map one workspace source alias target to its declaration-build target.
- Key abstractions: `builtDeclarationPath(candidate)`.
- Data flow: string rewriting from `/src` → `/lib/types`.
- Non-obvious design decisions: example plugin entries ship no declarations, so they are left as authored ("a documentation fence never imports them").
- Edge cases / failure handling: throws for an alias with no supported source target.

### scripts/doc-typecheck-paths.spec.ts
- Purpose: Spec for the alias mapping.
- Key abstractions: four literal expectations.
- Data flow: asserts the exact mapped paths.

### scripts/doc-typecheck.ts
- Purpose: Type-check Markdown `ts` fences against the workspace API.
- Key abstractions: `BlockKind = 'check' | 'ignore' | 'type-equiv' | 'cordis-catalog' | 'persistence-catalog' | 'config-catalog'`, `KIND_BY_INFO`.
- Data flow: extracts fences with `markdownFences`, redirects the host aggregate's `paths` to built declarations via `builtDeclarationPath`, and compiles.
- Non-obvious design decisions: `ignore-check` fences are *counted* in an opt-out ratio — an unchecked sketch is a measured budget, not a free pass; the catalog and type-equivalence variants are excluded from that ratio because their owning gates verify them.
- Edge cases / failure handling: byte-identical `.zh.md` copies reuse their unsuffixed sibling's check via `partitionPairedMarkdownDerivatives`.

### scripts/executable-native-pty.ts
- Purpose: Resolve the native node-pty input for the SDK and SSH executable builders.
- Key abstractions: `resolveLinuxNodePtyAddon`, `resolveWindowsNodePtyAddons`.
- Data flow: existence-checks the built addon, then the target prebuild.
- Edge cases / failure handling: names every missing Windows addon.

### scripts/executable-packaging.ts
- Purpose: Shared production-deploy preparation for the SDK and SSH executable carriers.
- Key abstractions: `pnpmInvocation`, `restoreLegacyHoists`.
- Data flow: restores direct dependencies pnpm's legacy hoister omitted, copying them without their nested `node_modules`.
- Non-obvious design decisions: the copy filter excludes nested module trees explicitly — copying them would shadow the shared instance and break identity checks.
- Edge cases / failure handling: a dependency absent from both the staged tree and the source throws; the function re-checks that nothing remains missing afterwards.
- Surprising: `pnpmInvocation` here (unlike `pnpm-invocation.ts`) also resolves `PNPM_HOME` and refuses to fall back to a bare `pnpm` on Windows, because a `.cmd` shim cannot be spawned without a shell.

### scripts/executable-packaging.spec.ts
- Purpose: Spec for the hoist restoration and staging materialisation.
- Key abstractions: a temp source/staging pair.
- Data flow: asserts the restored set and that nested instances are absent.
- Edge cases / failure handling: a missing dependency must be rejected "instead of packaging an incomplete graph".

### scripts/experimental-package-policy.ts
- Purpose: Experimental package identities, publication policy and retained npm names.
- Key abstractions: `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS`, `EXPERIMENTAL_PACKAGE_NAME_PREFIX`, `isExperimentalPackageName`, `hasExperimentalPackageReference`, `experimentalPackageRecordNamespace`, `isPublicExperimentalPackageDirectory`.
- Data flow: a name → identity lookup.
- Non-obvious design decisions: `hasExperimentalPackageReference` matches a *delimited* package name in any module id, path, subpath or npm alias — so the bundler isolation gate can recognise an experimental package regardless of how it is spelled.
- Edge cases / failure handling: the record namespace is derived from the capability suffix, so a retained npm name does not leak into the persisted record name.
- Surprising: the retained-name table exists so already-published npm names (`@deepseek-ai/dsh-cua`, `-dsh-tool-terminal`, …) keep working while the code lives under `packages/experimental/`.

### scripts/experimental-package-policy.spec.ts
- Purpose: Spec for the experimental identities.
- Key abstractions: table-driven cases.
- Data flow: asserts across many reference spellings.
- Non-obvious design decisions: asserts the exception is not *extended* to a near-miss name (`name-unrelated`, `other-name`, a different scope) — a prefix match would have leaked the exception.

### scripts/fixture-file.ts
- Purpose: File creation shared by repository scanner fixtures.
- Key abstractions: `writeFixtureFile(root, path, value)`.
- Data flow: writes text or JSON, creating parent directories.
- Surprising: one of only two 15-line files in the shard; it exists so several specs do not each re-implement `mkdirSync(dirname(...))`.

### scripts/fixtures/coverage-fork-exit.cjs
- Purpose: Preserve Node's exit before Vitest installs its test-level exit guard.
- Key abstractions: `globalThis.__dshCoverageFixtureExit`.
- Data flow: two lines.
- Surprising: the fixture needs the *real* `process.exit` to test that the diagnostic pool reports an abnormal exit.

### scripts/fixtures/coverage-fork.config.ts
- Purpose: Vitest config fixture selecting the diagnostic or stock pool.
- Key abstractions: `DSH_TEST_FORK_CACHE`, `DSH_TEST_FORK_POOL`.
- Data flow: requires a private cache dir, sets `execArgv` to the exit-preserving preload.
- Edge cases / failure handling: throws when the cache dir is absent, so the fixture cannot pollute the developer's cache.

### scripts/fixtures/coverage-fork.fixture.ts
- Purpose: The fixture executed inside the configured pool.
- Key abstractions: `globalThis.__dshCoverageFixtureExit(23)`.
- Data flow: writes its pid to stderr, optionally exits 23, then asserts `2 + 2 === 4`.
- Surprising: it exits 23 *after* a passing assertion, so the failure is in the worker's lifetime, not in the test.

### scripts/fixtures/lane-test-budget.fixture.ts
- Purpose: Waits that end only through the lane budget in force.
- Key abstractions: three cases (per-test, poll, hook).
- Data flow: sleeps 600 ms; the poll case counts attempts instead of reading a clock.
- Non-obvious design decisions: "The predicate counts attempts instead of reading a clock, so a host stall cannot turn a budget-ended poll into a pass."
- Surprising: the poll's target (10,000) is unreachable on purpose — only the budget can end it.

### scripts/fixtures/office-render.py
- Purpose: Office content checks for the installed Python runtime tests.
- Key abstractions: `workspace`, `copy_documents`, `check_image`, `check_render_manifest`, `render_cli`.
- Data flow: copies the Kit's colour-block fixtures, renders them through the real CLI, and inspects the PNGs.
- Non-obvious design decisions: `check_image` composites transparency onto white and requires red/blue/black/nonwhite pixel ratios, *and* that the red block's mean x is left of the blue block's — so a reversed or overlapping render is caught, not just a blank one.
- Edge cases / failure handling: errors are collected per extension and reported together rather than aborting at the first failure.

### scripts/fixtures/office-render/color-blocks.docx
- Purpose: The one-page colour-block Word fixture.
- Key abstractions: n/a (binary OOXML).
- Data flow: converted to PDF/PNG by the Office render check.
- Edge cases / failure handling: the render check verifies visible colour blocks and text.
- Surprising: 1082 bytes, ZIP magic `50 4b 03 04` — read the first bytes and classified it as a binary Office package rather than reading it line by line.

### scripts/fixtures/office-render/color-blocks.pptx
- Purpose: The colour-block PowerPoint twin.
- Key abstractions: n/a (binary OOXML).
- Data flow: same as the docx twin.
- Edge cases / failure handling: the chart round-trip is verified by `primary-runtime/smoke.py`.
- Surprising: 1787 bytes of binary OOXML — inspected via its first bytes only.

### scripts/fixtures/office-render/color-blocks.xlsx
- Purpose: The colour-block Excel twin.
- Key abstractions: n/a (binary OOXML).
- Data flow: rendered from the `Render` sheet, range `A1:B2`.
- Edge cases / failure handling: the spreadsheet is reopened with `openpyxl` and read back.
- Surprising: 2202 bytes of binary OOXML — inspected via its first bytes only.

### scripts/fixtures/python-sdk-dynamic-tools.mjs
- Purpose: Add a native tool after a file read and unregister it after its first execution.
- Key abstractions: `name`, `inject: ['tools']`, `apply(ctx)`.
- Data flow: hooks `tools/post-execute`, registering `snapshot_ping` on the `read` of `dynamic-tool-task.txt` and removing it on the next execution.
- Non-obvious design decisions: the tool's `execute` is wrapped in `ctx.effect(...)` so the disposer is scoped to the fiber — the tool disappears with its owner.
- Surprising: this is a *runtime-registered* tool, i.e. the tool surface is dynamic, not a static list.

### scripts/fixtures/python-sdk-in-history-prompt.mjs
- Purpose: Change one ordinary system-prompt section after a successful persistent shell call.
- Key abstractions: `inject: ['systemPrompt']`.
- Data flow: `ctx.systemPrompt.section({ name, order, text: () => … })` whose text reads a mutable version counter.
- Non-obvious design decisions: the section's text is a **function**, so the prompt changes without the section being re-registered.
- Surprising: the fixture proves the prompt is rebuilt per turn from live state — the version bump happens after `bash`/`pwsh` succeeds.

### scripts/fixtures/python-sdk-office.mjs
- Purpose: Exercise the wheel's Office API and model-shell commands from a shipped profile.
- Key abstractions: `name`, `apply(ctx, config)`.
- Data flow: reads the CLI paths out of the `office-export-pdf` skill body, runs `capabilities --json` and `convert`, then renders images through the Kit.
- Non-obvious design decisions: the CLI paths are extracted from the *skill's* JSON tail with a regex — the skill is the source of truth for where the binaries are.
- Edge cases / failure handling: the produced PDF is checked for the `%PDF-` magic bytes; the converter is disposed in a `finally`.

### scripts/fixtures/python-snapshot-image-offload.mjs
- Purpose: One admitted image and one authored failure for the Python SDK event snapshot.
- Key abstractions: `inject: ['attachments','agents','llm']`.
- Data flow: `agent/pre-step` admits a 1×1 PNG into the messages; `llm/stream` then yields a `finish` with an `IMAGE_OFFLOAD_REQUIRED` failure.
- Non-obvious design decisions: the failure is *authored* by the fixture rather than produced by the real pipeline — so the snapshot's error shape is deterministic.
- Surprising: the decision hook checks `decision.kind === 'reject'` so it never injects into a rejected step.

### scripts/fixtures/python-snapshot-tool.mjs
- Purpose: Deterministic job-backed tool and denial fixture for the packaged SDK snapshot.
- Key abstractions: `inject: ['tools','jobs']`.
- Data flow: `tools/pre-execute` denies `value === -1`; otherwise the tool starts a `ctx.jobs` job, waits for it and reads the result.
- Non-obvious design decisions: the denial carries a raw `\r\n`-laden reason string, so the snapshot proves the reason is normalised.
- Surprising: the job's `toolCall` records both `callId` and `rootCallId` — the job is attributable to the call that started it.

### scripts/fixtures/python-snapshot-workflow-order.mjs
- Purpose: Order child execution after the advanced parent records its corresponding handoff.
- Key abstractions: `pending` waiters, `started` set, `directStep`/`directDelivered` flags.
- Data flow: `agent/pre-step` blocks a child until the parent's `session/event` stream shows either `tool-workflow/agent-start` for that child, or (for the direct case) a `step/start` plus a `session-log-deepseek/delivery-accepted` at or beyond the direct result's seq.
- Non-obvious design decisions: the direct case waits on *delivery acceptance*, not on the event being produced — the parent must have consumed it.
- Edge cases / failure handling: every waiter is abort-aware (`signal.addEventListener('abort')`) and the effect's disposer rejects all pending waits so disposal cannot hang.

### scripts/fixtures/translation-prompt/examples/agent-note.md
- Purpose: English example Agent Note for the translation prompt.
- Key abstractions: n/a.
- Data flow: fed to the translation prompt as a few-shot example.
- Non-obvious design decisions: the headings are Problem/Decision/Consequences — the same shape across examples so the model learns consistency, not per-file quirks.
- Surprising: the language switcher line `English | [中文](agent-note.zh.md)` is part of the example, so the model learns to emit it.

### scripts/fixtures/translation-prompt/examples/agent-note.zh.md
- Purpose: The Chinese counterpart of the example Agent Note.
- Key abstractions: n/a.
- Data flow: the paired side of the few-shot example.
- Non-obvious design decisions: the switcher is flipped (`[English](agent-note.md) | 中文`) — the example teaches the *asymmetry* of the switcher.

### scripts/fixtures/translation-prompt/examples/product.md
- Purpose: Product README example for the translation prompt.
- Key abstractions: n/a.
- Data flow: few-shot example.
- Non-obvious design decisions: it contains a shell fence, an inline URL and a bullet list — the three shapes the prompt must preserve.
- Surprising: the URL `http://127.0.0.1:3080` is deliberately a local address to prove URLs are never translated.

### scripts/fixtures/translation-prompt/examples/product.zh.md
- Purpose: The Chinese counterpart of the product example.
- Key abstractions: n/a.
- Data flow: few-shot example.
- Non-obvious design decisions: the first occurrence of a technical term gets a parenthetical gloss (`agent harness（智能体框架）`) — the example teaches the glossing convention.

### scripts/fixtures/translation-prompt/examples/rules.md
- Purpose: Pairing-rules example for the translation prompt.
- Key abstractions: a MUST/SHOULD table.
- Data flow: few-shot example.
- Non-obvious design decisions: the rules are stated as propositions to preserve ("Preserve every proposition of the source", "Keep code spans verbatim") — the example teaches the *invariant*, not a phrasing.

### scripts/fixtures/translation-prompt/examples/rules.zh.md
- Purpose: The Chinese counterpart of the pairing-rules example.
- Key abstractions: n/a.
- Data flow: few-shot example.
- Non-obvious design decisions: MUST/SHOULD are left untranslated — the convention is demonstrated, not just described.

### scripts/fixtures/translation-prompt/response.txt
- Purpose: The expected model response envelope for the translation prompt.
- Key abstractions: `<translation>`, `<review>`, `<final>` blocks.
- Data flow: the reference output shape.
- Non-obvious design decisions: the three-block envelope gives the reviewer a separate section, so a revision can be distinguished from the answer.
- Surprising: the example response uses a technical gloss (`agent（智能体）`) and the layout frontmatter is preserved verbatim.

### scripts/fixtures/translation-prompt/snapshot-note.md
- Purpose: A minimal doc-frontmatter fixture for the translation prompt.
- Key abstractions: `layout: doc` frontmatter.
- Data flow: input to the prompt.
- Non-obvious design decisions: it is the smallest possible document that still carries frontmatter — so the prompt's frontmatter handling is exercised by a tiny input.

### scripts/gen-cli-help.ts
- Purpose: Generate paired CLI references by invoking the shipped launcher and profile help.
- Key abstractions: `parseCliHelp`, `topLevelHelpArgs`, `prefetchHelp`, `collectCliHelp`, `HelpPage`.
- Data flow: boots `apps/cli/src/bin.ts --help` for the launcher, `plugin`, and each profile in both shorthand and `--profile` forms, then walks the `Commands:` section recursively.
- Non-obvious design decisions: `prefetchHelp` starts the known top-level invocations immediately but serves them in *request* order, sharing one FIFO concurrency limit with on-demand reads — the consumer is sequential, so prefetching is free latency. Each invocation boots against its own empty `DSH_HOME`/`DSH_AGENTS_HOME`, so one boot cannot see another's state.
- Edge cases / failure handling: `close()` aborts the shared signal and awaits every started read, including unconsumed ones — an unconsumed rejection is observed only there.
- Surprising: `addAlias` propagates an alias down the child tree but stops when it reaches a page already on the current path, "which keeps alias propagation finite"; a `help [command]` row prints its parent's help, so a page can list itself as a child.

### scripts/gen-cli-help.spec.ts
- Purpose: Spec for CLI help discovery and prefetch.
- Key abstractions: `controlledReads()` (a read function whose calls stay pending).
- Data flow: settles the controlled reads and asserts the visit order and the served order.
- Non-obvious design decisions: the visit order is asserted exactly (`['', 'plugin', 'web', 'web nested', '--profile web']`), because the generated document's ordering is a function of it.
- Edge cases / failure handling: blank help is rejected; a failed prefetched read reaches the consumer only when its invocation is requested.

### scripts/gen-client-catalog.ts
- Purpose: Generate the model-facing client slot catalog consumed by `cordis_inspect what:"client"`.
- Key abstractions: `SlotEntry`, `collectSlotEntries`, `oversizedSlotReports`, `validateSlotContracts`, `resolveSlotEntries`, `renderClientCatalog`.
- Data flow: reads slot facts **lexically** (no type-checker program) from the shipped web bundle's declarations and emits a data module inside `tool-cordis`.
- Non-obvious design decisions: the point is that the host-side toolset teaches the browser surface "without importing a single client runtime module" — the catalog is data, not code.
- Edge cases / failure handling: a slot with no registrant-facing prose is rejected and the error names the writing template; a slot registered into an undeclared slot is a "scan blind spot" and is rejected.
- Surprising: `oversizedSlotReports` rejects a slot whose report a model could not finish reading — a *budget* on documentation, not just on code.

### scripts/gen-client-catalog.spec.ts
- Purpose: Spec for the slot catalog (surveyed by test names).
- Key abstractions: fixture slot declarations.
- Data flow: validates contracts and renders reports.
- Non-obvious design decisions: "warns that a single seat with a shipped occupant is replaced, not shared" — cardinality is part of the contract the model reads.
- Edge cases / failure handling: the real workspace surface must collect every declared slot (30 s timeout).

### scripts/gen-config-catalog.ts
- Purpose: Generate `docs/config-catalog.md` from package entry points, config types, JSDoc and static Schemastery schemas.
- Key abstractions: `CatalogEntry`, `collectConfigCatalog`, `render`, `computeConfigCatalogOutputs`.
- Data flow: reads each package's public entry, follows renamed named imports through public source subpaths, and resolves the config type.
- Non-obvious design decisions: "External and dynamic types stay unknown" — the generator refuses to guess; a dynamic schema factory is rejected rather than having its keys dropped.
- Edge cases / failure handling: a schema field absent from the shared config type is an error, as is a type-only import used as a runtime schema, a private subpath, or a source mapping into another package.
- Surprising: 52 KB; I read the header and the export scan, so the per-package walk body was surveyed rather than read line by line.

### scripts/gen-config-catalog.spec.ts
- Purpose: Spec for the config catalog (surveyed by test names).
- Key abstractions: fixture packages with local schema aliases.
- Data flow: asserts the collector's behaviour on each rejection case.
- Non-obvious design decisions: "follows a local const alias without treating a completed branch as a cycle" — alias resolution must not false-positive on cycles.
- Edge cases / failure handling: the rendering spec keeps package data in generated regions shared by both languages and leaves the consistency record unchanged when only package data changes.

### scripts/gen-cordis-api.ts
- Purpose: Compatibility entry point for the unified Typert-backed Cordis catalog projection.
- Key abstractions: none (nine lines).
- Data flow: calls `main()` from `gen-cordis-catalog.ts`.
- Non-obvious design decisions: the generated API module keeps this command name in its banner while all extraction, validation and rendering live in one implementation — one owner, two command names.

### scripts/gen-cordis-catalog.ts
- Purpose: Generate the per-subsystem Cordis service/event reference regions from the Typert catalog projection.
- Key abstractions: `SERVICE_PAGE`, `SERVICE_WALK_EXEMPTIONS`, `EVENT_SCOPE_PAGE`, `EVENT_WALK_EXEMPTIONS`, `LINK_MAP`, `CORDIS_CATALOG_POLICY`, `walkPartitionProblems`, `spliceRegion`.
- Data flow: projects the Cordis catalog, injects each page's reference between GENERATED markers into both language sides, and re-records the `.i18n.yaml` only when nothing outside the region changed.
- Non-obvious design decisions: `walkPartitionProblems` is an **independent backstop**: it cross-checks the projection's rendered surface against a separate AST scan of the source merges, and requires every declared key/event to be either rendered or covered by a named exemption — and every exemption to be live in both directions.
- Edge cases / failure handling: the backstop reports which side is wrong: "ctx.llm is rendered by the projection but the independent scan finds no Context merge declaring it" names the *scan* as the defect, not the projection.
- Surprising: the file's own header documents the staleness trap: generated regions embed `file:line` pointers, so inserting a line above a recorded symbol makes the committed output stale "even though nothing about the symbol changed" — and the failure surfaces as a byte-for-byte reproduction test, which "reads like a snapshot regression rather than a missing regeneration". 68 KB; read the header and export scan, so the projection body was surveyed.

### scripts/gen-cordis-catalog-partition.spec.ts
- Purpose: Spec for the cordis-surface partition backstop.
- Key abstractions: a `baseline()` fixture with rendered/declared maps and exemption maps.
- Data flow: mutates one facet at a time and asserts the problem strings.
- Non-obvious design decisions: every assertion checks the *message*, not just the count, so a regression cannot pass with a different wording.
- Edge cases / failure handling: covers stale exemptions, exemptions naming an undeclared event, and mapped pages for services the projection does not discover.

### scripts/gen-cordis-inspect-catalog.ts
- Purpose: Generate the model-visible Host/Client Service and Event inspect catalogs.
- Key abstractions: `CLIENT_SERVICES` (an explicit per-service method allowlist), `CLIENT_EVENTS` (four names), `clientModel`.
- Data flow: projects the Cordis catalog with a 4096-character runtime declaration limit, filters to the allowlist, and rewrites the generated module's provenance strings.
- Non-obvious design decisions: the allowlist is **explicit** — a service missing an allowlisted method is an error naming the method, so the model-facing surface cannot silently grow.
- Edge cases / failure handling: `--check` refuses a stale catalog rather than rewriting it.

### scripts/gen-dependency-catalog.ts
- Purpose: Generate the README npx dependency catalog from a recorded public npm resolution.
- Key abstractions: `DependencyRow`, `collectDependencies`, `deduplicateDependencies`, `computeDependencyCatalog`, `isDependencyCatalogCurrent`, `createNpmResolutionEnvironment`.
- Data flow: reads the recorded `package-lock.json`, turns it into rows, and writes `docs/dependency-catalog.json`.
- Non-obvious design decisions: `createNpmResolutionEnvironment` isolates the registry, resolver settings and caches from the user's global and environment configuration — a resolution captured under a different resolver is not the same resolution.
- Edge cases / failure handling: an invalid or unrelated resolution fails loud rather than producing an incomplete catalog.

### scripts/gen-dependency-catalog.spec.ts
- Purpose: Spec for the dependency catalog (surveyed by test names).
- Key abstractions: fixture lockfiles.
- Data flow: asserts rows, ordering and dedupe.
- Non-obvious design decisions: "sorts packages independently of lockfile object order and keeps duplicate installation locations" — the output must be reproducible from a reordered lockfile.
- Edge cases / failure handling: rejects missing, edited or stale JSON *without rewriting it*; rejects non-public package sources.

### scripts/gen-doc-graphs.ts
- Purpose: Generate the relationship layer above the module, Cordis and tool catalogs.
- Key abstractions: `PackageSource`, `EventRelationCollector`, `collectPackageSources`, `withMemoizedFileSystemProbes`.
- Data flow: builds a TypeScript program over the workspace, collects package sources and event relations, and renders hybrid (source-derived + curated) graphs.
- Non-obvious design decisions: `withMemoizedFileSystemProbes` memoises `ts.System` file probes and *restores the system* even when the run throws — the memoisation is a performance optimisation that must not leak state.
- Edge cases / failure handling: a helper is only accepted as local when locality is *proven*; global script files are rejected for the single-file fast path.
- Surprising: 84 KB; read the header and export scan, so the graph body was surveyed.

### scripts/gen-doc-graphs.spec.ts
- Purpose: Spec for the doc-graph generator (surveyed by test names).
- Key abstractions: a memoising system double.
- Data flow: asserts probe counts and restoration.
- Non-obvious design decisions: "records no result for a throwing probe and restores the system when the run throws" — a failed probe must not poison the cache.

### scripts/gen-module-graph.ts
- Purpose: Generate the paired shared-instance package graph from workspace peer dependencies.
- Key abstractions: `renderModuleGraph`, `computeModuleGraphOutputs`, `writeModuleGraph`, `GROUP_ORDER`.
- Data flow: reads the peer edges, renders a Mermaid flowchart grouped by `packages/<group>/<pkg>`, and writes the pair plus its consistency record.
- Non-obvious design decisions: `GROUP_ORDER` is an explicit visual priority list — the same graph can be ordered differently by different documents, so each caller supplies its own order.
- Edge cases / failure handling: `--check` reports drift without writing.

### scripts/gen-official-bundle-catalog.ts
- Purpose: Embed package-owned display metadata for Official bundles whose providers install on demand.
- Key abstractions: `generateOfficialBundleCatalog`, `renderOfficialBundleCatalog`, `syncOfficialBundleCatalog`.
- Data flow: reads each bundle package's manifest and resources without importing provider code.
- Non-obvious design decisions: "reads package resources without evaluating native provider entries or pinning a version" — the catalog must be buildable offline.
- Edge cases / failure handling: the admission list must be distinct and non-empty.

### scripts/gen-official-bundle-catalog.spec.ts
- Purpose: Spec for the bundle catalog (surveyed by test names).
- Key abstractions: fixture packages with bundle metadata.
- Data flow: asserts admission, metadata and staleness.
- Non-obvious design decisions: "rejects stale output when package-owned display text changes" and "does not rewrite an already current catalog during explicit generation".
- Edge cases / failure handling: missing `icon`/`en`/`zh` metadata is rejected; metadata fallback text is not accepted.

### scripts/gen-persistence-catalog.ts
- Purpose: Generate `docs/persistence-catalog.md` from every `SessionEventMap` merge and the owning event-envelope types.
- Key abstractions: `render`, `renderKnownEventTypes`, `persistenceCatalogArtifacts`, `renderPluginRecordCatalog`.
- Data flow: discovers events, validates them, and renders the bilingual pair plus the known-event module and the machine schema inventory.
- Non-obvious design decisions: "This is the durable-record vocabulary, not the live Cordis bus" — the catalog is explicitly *not* the event bus; surface events produce model history, log-only events do not.
- Edge cases / failure handling: event declarations must be unique, explicitly typed, documented, inheritance-free and free of Cordis-only `@mode` tags.
- Surprising: experimental plugin records get a *separate* catalog and stay outside the known-event set, the persistence fingerprints and the compatibility history.

### scripts/gen-plugin-packages.ts
- Purpose: Generate the loadable-plugin package list shipped inside the `cordis-composition-reference` skill.
- Key abstractions: `rows`, `render`.
- Data flow: reads the config-catalog classification and each package's description.
- Non-obvious design decisions: "Seams are abstract Service Definitions and libraries export no plugin; neither is a Loader row" — the list only contains things a Loader row can actually name.
- Edge cases / failure handling: `--check` exits 1 on a stale file; a missing file is treated as stale with the same remedy.

### scripts/gen-session-format-catalog.ts
- Purpose: Generate the build-static Session format catalog from edge package metadata.
- Key abstractions: `readCurrentSessionFormatVersion`, `collectSessionFormatMigrations`, `renderSessionFormatCatalog`.
- Data flow: discovers `packages/session/session-format-vN-to-vM/package.json`, validates the chain, and renders direct imports.
- Non-obvious design decisions: "The direct imports make historical readability independent of mounted plugins" — the catalog imports each migration package *statically* rather than resolving it through the plugin registry, so reading a v0 session never depends on a plugin being mounted.
- Edge cases / failure handling: exactly one adjacent package per version is required, the chain must end exactly at the current writer, each package's `sourceCodec` must continue the previous `targetCodec`, and the catalog must share the Session package through peer **and** dev dependencies.
- Surprising: the package name must itself identify the edge (`@deepseek-ai/dsh-session-format-v3-to-v4`), and the directory must match — a rename cannot silently move a version boundary.

### scripts/gen-session-format-catalog.spec.ts
- Purpose: Spec for the format catalog generator.
- Key abstractions: fixture migration packages.
- Data flow: asserts the discovered chain and the rendered imports.
- Non-obvious design decisions: the spec normalises Windows separators in discovered manifest paths before validation — a corpus-level portability fix.
- Edge cases / failure handling: a missing adjacent edge, a non-continuing codec and a wrong package name are each refused.

### scripts/gen-third-party-notices.ts
- Purpose: Generate `THIRD_PARTY_NOTICES.md` from the workspace manifests.
- Key abstractions: `tierExternalDeps`, `parseVendoredRows`, `parsePyprojectRequirements`, `collectPythonDependencies`, `collectBundledPythonDependencies`, `isPermissive`, `virtualManifest`, `manifestPatterns`, `claudeDistributionFromManifest`.
- Data flow: reads workspace manifests, the vendored manifest table, the Python `pyproject.toml` files, the shared Python lock and the pnpm patch list; npm metadata comes from the installed store.
- Non-obvious design decisions: tiering is "by declaring area, not by the declaring section name" — the *area* (runtime, browser, dev) decides the tier, so moving a dependency between `dependencies` and `devDependencies` cannot change its disclosure.
- Edge cases / failure handling: `isPermissive` fails closed for malformed expressions, additions and unknown licences, and requires every operand of an AND so a copyleft conjunct cannot ride along.
- Surprising: `virtualManifest` falls back to a content scan when pnpm 11 truncates the store directory name — a real-world workaround for a package-manager change. 43 KB; read the header and export scan, so the tiering body was surveyed.

### scripts/gen-third-party-notices.spec.ts
- Purpose: The 22 KB notices spec (surveyed by test names).
- Key abstractions: `parseVendoredRows`, `parsePyprojectRequirements`, `isPermissive` cases.
- Data flow: asserts the licence policy and the parsers.
- Non-obvious design decisions: "keeps browser-bundled development dependencies in runtime disclosures" — a dev-declared package that ends up in the browser bundle is disclosed as runtime.
- Edge cases / failure handling: "yields nothing when the table columns change, so the generator fails loud" and "covers every vendored directory, so no package can drop out of the notices".

### scripts/gen-tool-catalog.ts
- Purpose: Generate `docs/tool-catalog.md` from schemas collected by booting each tool plugin.
- Key abstractions: `ToolPackage`, `ToolCatalog`, `assertManifestComplete`, `assertToolsHarvested`, `collectToolCatalog`, `render`.
- Data flow: boots the LLM, agent, session, goal, prompt and tools plugins in a real Cordis `Context` and harvests the **runtime-registered** schemas.
- Non-obvious design decisions: "Runtime registration is the source of truth for computed schemas" — the catalog cannot drift from the tool surface, because it *is* the tool surface. The manifest is then checked against every on-disk `tool-*` package, so a package that exists but is not in the manifest fails.
- Edge cases / failure handling: `assertToolsHarvested` compares the harvested count to the manifest, so a plugin that registers fewer tools than it claims fails the gate.
- Surprising: 46 KB; read the header and export scan, so the harvesting body was surveyed.

### scripts/gen-translation-brief.ts
- Purpose: Print the minimal-update briefing for out-of-sync translation pairs.
- Key abstractions: the briefing rules live in `scripts/translation-brief.ts`; this is the consuming workflow.
- Data flow: discovers out-of-sync pairs (or takes explicit pair paths) and maps each change at the narrowest safe granularity.
- Non-obvious design decisions: `--apply` writes only for pairs whose change is **code-fence-only** — a prose change must be retranslated by a model, not spliced.
- Edge cases / failure handling: it "fails loud on in-sync, incomplete, or out-of-scope requests" rather than guessing which pair was meant.

### scripts/gen-tsconfig-paths.ts
- Purpose: Expand the workspace path aliases that a wildcard would otherwise resolve by probing every package group in turn.
- Key abstractions: `collectPackageAliases`, `collectPackageNames`, `mappedSpecifiers`, `uncoveredPackages`, `renderAliases`, `writeRegion`.
- Data flow: reads `tsconfig.base.json`, writes one explicit entry per package into a marked region, and leaves every hand-written alias and comment outside that region untouched.
- Non-obvious design decisions: the stated cost is "a specifier whose package sits late in the list pays for every earlier miss. Under tsx's ESM hook each miss is an `ERR_MODULE_NOT_FOUND` that Node decorates with a full CommonJS resolution walk, which dominated source-launch boot."
- Edge cases / failure handling: `--check` reports drift instead of writing, so a new package needing an alias fails a gate rather than silently resolving through a fallback.

### scripts/gen-tsconfig-paths.spec.ts
- Purpose: Spec for the alias generator.
- Key abstractions: a fixture tsconfig.
- Data flow: asserts the generated region covers every package and preserves hand-written entries.

### scripts/gen-workflow-guest.ts
- Purpose: Bundle the workflow guest as source data.
- Key abstractions: `bundleWorkflowGuest`, `generateWorkflowGuest`.
- Data flow: bundles `packages/workflow/workflow-ptc/src/guest.ts` with Rolldown into one ESM module and stores it as a string constant.
- Non-obvious design decisions: `treeshake: { moduleSideEffects: false }` because "the guest imports pure helpers from package barrels, without mounting their services"; and `UNRESOLVED_IMPORT` is turned into a thrown error so the guest can never ship an unavailable dependency.
- Edge cases / failure handling: the bundle must produce **exactly one** module and have no non-builtin imports.
- Surprising: the result is embedded as a JSON string constant and transported into the mounted PTC runtime — the guest is code-as-data.

### scripts/gen-workflow-guest.spec.ts
- Purpose: Spec for the guest bundler.
- Key abstractions: a fixture guest entry.
- Data flow: bundles, deletes the sources, then imports the bundle from a `data:` URL.
- Non-obvious design decisions: deleting the sources before importing is the actual test — the guest must be self-contained.
- Edge cases / failure handling: `--check` must not rewrite a stale output.

### scripts/generate-typert.ts
- Purpose: Generate the repository's Typert artifacts without bundling.
- Key abstractions: `TypertGenerationError` with stages `locate | generate | write`, `generateWorkspaceTypert`, `formatGenerationFailure`, `GENERATION_OPTIONS`.
- Data flow: find the workspace root, generate the contributors' artifacts, write them.
- Non-obvious design decisions: the pass "fails when the Host program would load a package's `lib/` output, so it can run beside Host package compilation" — `rejectBuildOutputs: true` is what makes the parallelisation safe.
- Edge cases / failure handling: the failure message states exactly what state the tree is in — a failed `write` leaves "packages written before the failure with new files and the rest with their previous files", i.e. a possibly mixed generation.
- Surprising: it skips TypeScript diagnostics because Host compilation owns them, but "Typert's own checks still fail the pass" — the division of labour is explicit.

### scripts/generate-typert.spec.ts
- Purpose: Spec for the bundle-free Typert pass (surveyed by test names).
- Key abstractions: a fixture workspace with contributor packages.
- Data flow: runs the generator in-process and inspects the written artifacts.
- Non-obvious design decisions: "writes the files the workspace-mode tsdown plugin writes" — the two paths must agree byte for byte, and the spec asserts it.
- Edge cases / failure handling: rejects a Host program that loads a compiled workspace declaration and *names the missing alias*, for both a real and a linked root spelling.

### scripts/historical-schema-region.ts
- Purpose: Identify the checked generated schema lines in canonical historical Session format references.
- Key abstractions: `historicalSchemaRegion(file, source)`.
- Data flow: matches the exact marker pair and returns the line range.
- Edge cases / failure handling: returns `undefined` for a path outside the canonical pattern or for a malformed marker set (exactly two markers required).

### scripts/install-lefthook.mjs
- Purpose: Install Git hooks worktree-locally.
- Key abstractions: `MINIMUM_GIT = [2, 26, 0]`, `HOOKS_DIRECTORY = 'dsh-hooks'`, `OWNERSHIP_MARKER`, `OWNERSHIP_MARKER_VERSION`.
- Data flow: locates the worktree root, installs Lefthook into a worktree-local hook path under a lock, and marks the path it owns.
- Non-obvious design decisions: an ownership *marker* file records which paths the installer owns, so it can repair a moved checkout and refuse to touch a user-owned path.
- Edge cases / failure handling: refuses dormant repository extensions before upgrading the repository format; refuses a direct `core.worktree` before enabling worktree config; does not release a lock whose ownership changed.
- Surprising: 28 KB; read the 22-line header (constants) — the implementation body was surveyed, not read line by line. The spec below is the better record of the behaviour.

### scripts/install-lefthook.spec.ts
- Purpose: The 42 KB installer spec (surveyed by its ~30 test names).
- Key abstractions: real git worktrees in temp dirs.
- Data flow: installs, moves the checkout, injects lock failures, and inspects the resulting hook paths.
- Non-obvious design decisions: "never overrides a command-scoped hook path" and "never overrides a hook path included by worktree config" — the installer refuses to shadow configuration it does not own.
- Edge cases / failure handling: stale and invalid installer locks are *left* for explicit recovery rather than cleaned up automatically; a failed install restores the previous hook lookup, and a rollback failure is reported *together* with the install failure.

### scripts/jsdoc.ts
- Purpose: Shared JSDoc parsing and completeness checks.
- Key abstractions: `pointer`, `rawJsDoc`, `parseJsDoc`, `parseTags`, `checkParams`, `checkReturns`, `reportViolations`, `Mode`.
- Data flow: reads a JSDoc block, splits it into prose/paragraphs/lists and block tags.
- Non-obvious design decisions: `reportViolations` aggregates every violation into one error — "a remediation pass sees the whole list at once instead of replaying the gate once per offender."
- Edge cases / failure handling: `checkParams` rejects binding-pattern parameters (so `@param` can name them), rejects empty descriptions, and rejects *stale* tags that match no parameter.
- Surprising: `checkReturns` requires an explicit return-type annotation — "a pure-AST walk cannot classify an inferred return" — so an inferred return is a violation, not an exemption.

### scripts/lane-test-budget.spec.ts
- Purpose: Spec proving one configured budget ends per-test, hook and `expect.poll` waits.
- Key abstractions: a spawned Vitest child running the lane fixture.
- Data flow: sets the env var and measures the child's duration.
- Non-obvious design decisions: the assertion is on the *budget* ending the wait, which is why the fixture counts attempts rather than reading a clock.
- Edge cases / failure handling: a malformed budget fails at config load before any test runs.

### scripts/libreoffice-engine.spec.ts
- Purpose: Spec for `selectOfficeEngine`.
- Key abstractions: a table of platform/arch pairs.
- Data flow: asserts the selected engine suffix.
- Non-obvious design decisions: a declared Linux native target is selected "without an OS-specific policy change" — the rule is "the manifest declares it", not "the platform is in a list".
- Edge cases / failure handling: WASM is the fallback whenever no native target is declared.

### scripts/libreoffice-packages.d.mts
- Purpose: Type declarations for `libreoffice-packages.mjs`.
- Key abstractions: `selectOfficeEngine`, `officePackageDirectories`.
- Data flow: none (types only).
- Non-obvious design decisions: the `.d.mts` companion exists because the `.mjs` is consumed from TypeScript.
- Surprising: 17 lines of pure declarations.

### scripts/libreoffice-packages.mjs
- Purpose: Locate the complete installed Office package closure used by standalone CLI processes.
- Key abstractions: `selectOfficeEngine`, `officePackageDirectories`, `supports`.
- Data flow: walks `dependencies`, `optionalDependencies` and `peerDependencies` from each package's own `require.resolve.paths`, so the *installed* resolution is used rather than a recomputed tree.
- Non-obvious design decisions: optional peers are skipped; optional dependencies whose `os`/`cpu` do not support the target are skipped rather than failing.
- Edge cases / failure handling: a required dependency missing from the closure throws; a dependency resolving outside the staging root throws.

### scripts/lint-rule-fingerprint.spec.ts
- Purpose: Spec pinning the Oxlint repository rule contract.
- Key abstractions: named rule profiles.
- Data flow: compares the committed configuration against a fingerprint.
- Non-obvious design decisions: "pins every override field" and each profile — the lint contract is a *pinned artifact*, so a rule cannot change silently.

### scripts/loader-config-diff.spec.ts
- Purpose: Spec for the loader config diff.
- Key abstractions: raw vs schema-based comparison.
- Data flow: compares two configs with and without a schema.
- Non-obvious design decisions: volatile fields are ignored "without running schema callbacks" — the diff must not execute user configuration code.
- Edge cases / failure handling: absent objects equal defaults, but ordinary field differences survive; raw values are compared strictly without a schema.

### scripts/loader-volatile-update.spec.ts
- Purpose: The 31 KB volatile-update spec (surveyed by test names).
- Key abstractions: config references, update hooks, Group/Include custom updates.
- Data flow: applies updates and inspects what was committed.
- Non-obvious design decisions: "commits all references before one local event without remounting" — a volatile change updates in place, while an ordinary change remounts the plugin.
- Edge cases / failure handling: "remounts when changed expressions resolve to ordinary values different from the live config"; "keeps an ordinary plugin mounted when an absent object becomes its explicit default"; "isolates a failing notification listener".

### scripts/local-bundle-registry.ts
- Purpose: Pack the local dependency closure of the Official bundles and serve it as a loopback npm registry.
- Key abstractions: `selectBundleDependencies`, `packBundleArtifacts`, `createRegistryManifest`, `startBundleRegistry`, `readWorkspacePackages`, `verifyBuiltBundles`.
- Data flow: resolve the closure → pack each member → write a manifest naming every served archive with its integrity → serve packuments, version documents and tarballs.
- Non-obvious design decisions: "the plugin manager asks a custom registry *alone*" — so every transitive dependency of the packed bundles must be answerable by this process. Repository-owned packages come from the run's own artifacts; genuinely external packages keep npm's real metadata and bytes through a fixed redirect.
- Edge cases / failure handling: a required edge targeting another platform fails naming the path; an optional-only foreign-target member is kept and *reported*.
- Surprising: 37 KB; read the header and export scan, so the HTTP body was surveyed.

### scripts/local-bundle-registry.spec.ts
- Purpose: The 29 KB registry spec (surveyed by test names).
- Key abstractions: a real loopback server.
- Data flow: drives packuments, tarballs and the run record over HTTP.
- Non-obvious design decisions: "keeps a repository-owned miss local and redirects only external packages" — a 404 for a repo package must not leak to npm.
- Edge cases / failure handling: "keeps serving after a client abandons a tarball request"; rejects out-of-namespace, malformed and non-GET requests, then stops listening; rejects a packed manifest that keeps a `workspace:` protocol.

### scripts/locale-dictionary-parity.spec.ts
- Purpose: Spec asserting the shipped locale dictionaries declare the same keys.
- Key abstractions: the zh and en dictionaries.
- Data flow: compares key sets.
- Non-obvious design decisions: "so the single fallback locale always resolves" — parity is a correctness property of the fallback chain, not a style preference.

### scripts/macos-package-workflow.spec.ts
- Purpose: Spec confining signed Mac packaging.
- Key abstractions: the macOS packaging workflow.
- Data flow: asserts the trigger and the runner labels.
- Non-obvious design decisions: notarization is the default and the explicit debugging option is labelled — so a debug package is visibly distinguishable.

### scripts/markdown.ts
- Purpose: Shared Markdown parsing and depth-first traversal for documentation gates.
- Key abstractions: `parseMarkdown`, `visitMarkdown`, `markdownFences`, `markdownHeadingLines`, `markdownProseLines`, `markdownDestination`.
- Data flow: parses with GFM, then walks the mdast tree.
- Non-obvious design decisions: `markdownDestination` locates a parsed destination in the **original source** by computing its absolute offsets rather than reserialising the node — so a rewrite never reformats the file around it.
- Edge cases / failure handling: `MarkdownFence.closed` records whether a closing delimiter terminated the block, because "mdast silently closes an unterminated fence at end of file."
- Surprising: `markdownProseLines` excludes lines that are only HTML comments, computing the comment ranges per line and checking whether any visible text remains.

### scripts/markdown.spec.ts
- Purpose: Spec proving the parse can be reused across the helpers.
- Key abstractions: one fixture document.
- Data flow: compares supplied-parse results with own-parse results.
- Non-obvious design decisions: asserts the tree is *not mutated* by the helpers — a structuredClone comparison.

### scripts/migrate-packed-session-fixtures.ts
- Purpose: Rewrite packed session fixtures into their canonical projected layout.
- Key abstractions: `inspectSessionFixtureLayouts`.
- Data flow: compares each fixture's source with its canonical form and rewrites only the changed ones.
- Edge cases / failure handling: takes no arguments (a stray argument throws).
- Surprising: it references a *proposed* agent note, so the command is explicitly temporary.

### scripts/migrate-sessions-to-v4.ts
- Purpose: One-time contributor command publishing V4 session successors through JSONL persistence.
- Key abstractions: `runMigrationJobs`, `Candidate`, `OutcomeCounts`, `summarizeFailures`, `directoryId`.
- Data flow: discover session directories → open each in read or write mode through a real Cordis `Context` hosting the JSONL persistence plugin → record converted/already-V4/failed/skipped.
- Non-obvious design decisions: `runMigrationJobs` runs bounded parallel jobs and then a **single serial retry pass** for inputs deferred because their source changed — "An unexpected visit rejection drains active workers and aborts the retry pass."
- Edge cases / failure handling: failures never stop subsequent sessions; `directoryId` re-encodes the directory name and rejects a noncanonical one; symbolic links are not traversed.
- Surprising: it asserts `SESSION_FORMAT_VERSION === 4` and that the format catalog's current version is 4 — "this one-time command requires a V4 Session writer" — so the tool refuses to run against a moved target. No model or API key is used.

### scripts/migrate-sessions-to-v4.spec.ts
- Purpose: The 23 KB migration spec (surveyed by test names).
- Key abstractions: fixture session trees with `none`/`zstd` compression.
- Data flow: runs the migration and inspects the resulting generations.
- Non-obvious design decisions: "publishes successors, preserves sources and current bytes on rerun" — the migration is idempotent by construction, not by cleanup.
- Edge cases / failure handling: drains ten thousand immediate inputs without exceeding the worker limit; groups matching failures by source version while retaining each input's own diagnostic; "opens an existing V4 torn tail without repairing its bytes" — the tool reports, it does not heal.

### scripts/migration-failure-summary.ts
- Purpose: Structured facts extracted from existing migration diagnostics.
- Key abstractions: `MigrationFailureDiagnostic` with a closed `reason` vocabulary, `classifyMigrationFailure`.
- Data flow: matches the error message and error name against known patterns.
- Non-obvious design decisions: "classification never changes migration admission" — the classifier is a *reporting* layer, so a wrong classification cannot change what gets migrated.
- Edge cases / failure handling: distinguishes a direct field refusal from a child prerequisite failure via the `child Session ` prefix; keeps the sequence coordinates of a gap rather than collapsing them.
- Surprising: unrecognised text is preserved verbatim rather than being replaced by a generic message.

### scripts/migration-failure-summary.spec.ts
- Purpose: Spec for the classifier.
- Key abstractions: a `failure(name, message)` helper.
- Data flow: asserts the exact diagnostic object.
- Edge cases / failure handling: non-`Error` failures become `reason: 'other', errorName: 'NonError'` rather than throwing.

### scripts/no-unknown-casts.baseline.json
- Purpose: The ratchet baseline of accepted unknown-cast fingerprints per source file.
- Key abstractions: a map of file path → fingerprint → count.
- Data flow: compared against a fresh scan by the type-check gate.
- Non-obvious design decisions: it is a *baseline*, so the gate is "no new unknown casts", not "no unknown casts".
- Edge cases / failure handling: 116 KB / 2,127 lines of generated data — I opened the first 12 lines and confirmed the structure rather than reading it line by line.

### scripts/npm-baseline-packages.ts
- Purpose: Manifest discovery for the npm baseline's vendor, harness and application packages.
- Key abstractions: `discoverNpmBaselineManifests(root, privateDirectories)`.
- Data flow: globs `vendor/*`, `packages/*/*` and `apps/*` manifests, excluding the private experimental directories.
- Edge cases / failure handling: an empty set is returned to the caller, which rejects it — the discovery function does not decide.

### scripts/npm-baseline-packages.spec.ts
- Purpose: Spec for the baseline discovery.
- Key abstractions: fixture manifest trees.
- Data flow: asserts the discovered set.
- Non-obvious design decisions: asserts an *exact* excluded directory does not exclude nearby names (`internal` vs `internal-tools`).

### scripts/optional-bundles.spec.ts
- Purpose: Spec for optional bundles (surveyed by test names).
- Key abstractions: `OPTIONAL_BUNDLES` from the boot profile.
- Data flow: composes each bundle over the Web profile and inspects the result.
- Non-obvious design decisions: "contributes global tools from Host rows with independently isolated services" — a bundle's tools are global but its services are per-instance.
- Edge cases / failure handling: "delivers the Schedule service and task page without a Host clock row" — the dependency is satisfied by the bundle, not by the base profile.

### scripts/oxlint-contract.spec.ts
- Purpose: The 19 KB Oxlint contract spec (surveyed by test names).
- Key abstractions: per-file-class project attribution.
- Data flow: runs Oxlint over the workspace and asserts the contract.
- Non-obvious design decisions: "discovers the owning TypeScript project for every file class" — a lint rule needs the right tsconfig to be meaningful.
- Edge cases / failure handling: "allows Session history reads only in tests or with existing-call waivers" — a narrow, explicitly-enumerated exception rather than a blanket disable.

### scripts/package-dependency-policy.ts
- Purpose: Explicit exceptions and Host packages for the published dependency policy.
- Key abstractions: `PACKAGE_DEPENDENCY_POLICY`, `hasClientDeclaration`.
- Data flow: consumed by the dependency verifier and the benchmark.
- Non-obvious design decisions: `SAFE_HOST_DEPENDENCY_EXPORTS` is documented with a rule attached — "New entries are forbidden by default. Automated agents must not add an exception; every addition requires explicit human review and a dedicated, prominent heading in the pull request description."
- Edge cases / failure handling: `PEER_REQUIRED_HOST_EXPORTS` names the exports that need every consumer to resolve the provider's shared peer instance (e.g. `instanceof` checks).

### scripts/package-graph.ts
- Purpose: Shared workspace-package graph discovery and Mermaid identifier helpers.
- Key abstractions: `PackageGraphNode`, `collectPackageGraph`, `graphNodeId`, `escapeMermaidLabel`.
- Data flow: reads every `packages/*/*/package.json`, keeps the in-repo peer edges, and topologically sorts.
- Non-obvious design decisions: the sort uses Tarjan's SCC algorithm (`sinkCycles`) so a dependency **cycle** is emitted as one stable block rather than making the sort fail.
- Edge cases / failure handling: a peer naming a missing in-repo package is an error naming the consumer and the missing peer.
- Surprising: each caller supplies its own `groupOrder` because the documents use different visual priorities.

### scripts/package-graph.spec.ts
- Purpose: Spec for the package graph and the module-graph renderer.
- Key abstractions: a fixture package tree.
- Data flow: asserts the ordering and the rendered Mermaid edge.

### scripts/paired-markdown-derivatives.ts
- Purpose: Separate byte-identical Chinese Markdown code blocks from the primary checks on their English siblings.
- Key abstractions: `MarkdownDerivativePartition`, `partitionPairedMarkdownDerivatives`.
- Data flow: groups blocks per document, compares each `.zh.md` block to its unsuffixed sibling's block at the same index by a caller-supplied fingerprint.
- Non-obvious design decisions: a **partial or reordered** match stays primary "so the caller fails closed; the translation-pairing gate reports the cross-language mismatch" — the derivative optimisation can never hide a translation defect.
- Edge cases / failure handling: the fingerprint must match the *kind* as well as the body, so a `type-equiv` block paired with a `public-api` block is not treated as identical.

### scripts/paired-markdown-derivatives.spec.ts
- Purpose: Spec for the derivative partition.
- Key abstractions: a `Block { doc, kind, code }` fixture type.
- Data flow: asserts the primary/derivative split for changed, reordered, partial and orphan sequences.
- Surprising: the orphan case (a Chinese block with no English sibling) is explicitly tested — it stays primary.

### scripts/parallelism.ts
- Purpose: The default worker budget shared by gates, builds, linters and Vitest configurations.
- Key abstractions: `LOCAL_PARALLELISM_CAP = 12`, `LOCAL_TEST_PARALLELISM_CAP = 48`, `defaultParallelism`, `describeDefaultParallelism`.
- Data flow: `env.CI === 'true'` selects the CPU count; otherwise the count is capped.
- Non-obvious design decisions: the cap exists because "`os.availableParallelism()` reports host CPUs rather than a container's CPU quota and local runs share the workstation." Vitest forks get a larger cap (48) because they are heavier per worker.
- Edge cases / failure handling: each tool's explicit override (`DSH_GATE_CONCURRENCY`, `DSH_OXLINT_THREADS`, `DSH_COVERAGE_MAX_WORKERS`, `--maxWorkers`) still wins.
- Surprising: `describeDefaultParallelism` exists so the scheduler's start line can say *why* it chose that budget — "12 local default worker(s) of 256 CPU(s)".

### scripts/parallelism.spec.ts
- Purpose: Spec for the worker budget.
- Key abstractions: three cases.
- Data flow: asserts the cap and the description strings.

### scripts/persistence-artifacts.ts
- Purpose: Render complete persistence documentation pairs without Git or file mutation.
- Key abstractions: `PersistenceArtifact`, `renderPersistencePair`.
- Data flow: checks both language switchers, compares the bilingual structure signatures, computes the pairing record, and returns three artifacts (en, zh, i18n).
- Non-obvious design decisions: "Link existence remains the Markdown gate's responsibility" — a strict division of concerns between the structural gate and the link gate.
- Edge cases / failure handling: a missing switcher on either side throws naming the source document.

### scripts/persistence-catalog-source.ts
- Purpose: Source discovery and declaration validation shared by the persistence documentation and schemas.
- Key abstractions: `LogEventEntry`, `AnnotatedLogEventEntry`, `EventEnvelopeTypeEntry`, `collectLogEvents`, `collectEventEnvelopeTypes`, `collectSurfaceEventTypes`, `annotateSurface`.
- Data flow: scans the Session package's `SessionEventMap` merges and the envelope type declarations.
- Non-obvious design decisions: `annotateSurface` separates **surface** events (which produce model history) from **log-only** events (which do not) — a distinction the live Cordis bus does not make.
- Edge cases / failure handling: JSDoc completeness is enforced through `reportViolations`, so one event's missing prose fails the whole catalog.

### scripts/persistence-catalog-text.ts
- Purpose: The authored English/Chinese prose for the generated persistence reference.
- Key abstractions: `persistenceCatalogText = { en, zh }`, `PersistenceCatalogLocale`.
- Data flow: the generators import the locale object and index it by key.
- Non-obvious design decisions: the Chinese object is typed `Record<keyof typeof english, string>` — "adding an English key requires its Chinese counterpart", so a missing translation is a type error, not a runtime hole.
- Surprising: the prose explicitly states what the fingerprints do *not* cover (comments, source locations, alias names, erased brands, readonly markers, harmless reordering) and what they do (tuple order, property names, value types, optionality).

### scripts/persistence-changes.ts
- Purpose: Verify and acknowledge persistence type changes from current-tree schema history.
- Key abstractions: `PersistenceDecision = 'same-version' | 'version-bump'`, `PersistenceTypeChange`, `classifyPersistenceChange`, `validatePersistenceHistory`, `loadPersistenceHistory`, `verifyPersistenceChanges`, `parsePersistenceProse`.
- Data flow: reads the current schema, compares it with the recorded history, and requires every transition to carry an explanation and validation evidence.
- Non-obvious design decisions: the classifier is authoritative and the prose is not — "Human explanations cannot override the unchanged classifier results carried per root."
- Edge cases / failure handling: the `TODO: explain this change.` / `TODO: record validation evidence.` placeholders are detected explicitly.
- Surprising: 54 KB; read the header and export scan, so the history-walk body was surveyed.

### scripts/persistence-changes.spec.ts
- Purpose: The 70 KB persistence-change spec (surveyed by test names).
- Key abstractions: fixture inventories and histories.
- Data flow: asserts classification, validation and acknowledgement.
- Edge cases / failure handling: covers digest mismatches, an unchanged transition, an unacknowledged after-root, and a missing baseline.

### scripts/persistence-developer.spec.ts
- Purpose: Spec for developer-role field compatibility.
- Key abstractions: a developer-message source declaration.
- Data flow: classifies a field change on the developer message type.
- Non-obvious design decisions: "requires compatibility review before a future declaration can use the rejected inline tool field" — a rejected field stays rejected for the role that rejected it.
- Edge cases / failure handling: an optional tool-addition field classified as such is accepted.

### scripts/persistence-epoch-header.spec.ts
- Purpose: Spec requiring review before request headers carry retired system text.
- Key abstractions: the request-header source declaration.
- Data flow: classifies the change and asserts the decision.
- Surprising: 60 s timeout — the case compiles the real workspace.

### scripts/persistence-finalization.ts
- Purpose: Accepted declared Session baselines and immutable acknowledgements.
- Key abstractions: `PersistenceFinalizationCheckpoint`, `PersistenceFinalization`, `createPersistenceFinalizationCheckpoint`, `loadPersistenceFinalization`.
- Data flow: hashes each accepted record semantically, writes a version-named checkpoint, then re-validates the retained checkpoints against the current history.
- Non-obvious design decisions: `recordDigest` hashes a *semantic* projection of the record (id, baseline, sorted changes, snapshot roots) rather than the file bytes — so reformatting the document does not break the seal, but changing a decision does.
- Edge cases / failure handling: a checkpoint whose locked record was removed or changed throws "was removed or changed"; the checkpoint's roots must match the complete accepted history; the accepted `SessionHeader.version` must equal the captured version.
- Surprising: `status()` reads the version out of a **Markdown** fenced YAML block in `docs/session-format-status.md` — the published document is the source of the machine state, in both languages, and they must agree.

### scripts/persistence-format-facts.ts
- Purpose: Render historical format references from complete, validated in-tree schemas.
- Key abstractions: `replaceRegion`, `historicalSchema`, `formatIndex`, `persistenceFormatFactArtifacts`.
- Data flow: replaces the content between the `<!-- persistence-format-schema:start -->` markers and the index between its own markers.
- Non-obvious design decisions: the region replacement refuses to run unless there is exactly one start and one end marker, so a duplicated marker fails loudly instead of producing a half-updated document.
- Edge cases / failure handling: authored prose outside the markers is preserved byte-for-byte.

### scripts/persistence-formats.ts
- Purpose: Archive and verify complete Session format references through the current writer.
- Key abstractions: `PersistenceFormatEntry`, `PersistenceFormats`, `loadPersistenceFormats`-style readers.
- Data flow: reads the archive directory, the machine records embedded in each version's Markdown, and the schema inventories.
- Non-obvious design decisions: historical evidence "must omit line numbers" — a source coordinate in a historical reference is rejected because it would silently rot.
- Edge cases / failure handling: the archive must be contiguous and end at the source-declared writer version; a gap is refused even if every other version has complete companions.
- Surprising: the format record is embedded as a fenced YAML block inside the *human-readable* document, so the machine contract travels with the prose.

### scripts/persistence-formats.spec.ts
- Purpose: The 29 KB format spec (surveyed by test names).
- Key abstractions: fixture archives.
- Data flow: asserts archive creation and reference loading.
- Edge cases / failure handling: refuses to overwrite an existing archive; refuses `--archive` with `--write`; "refuses to refresh facts until every format reference passes validation".

### scripts/persistence-release-facts.ts
- Purpose: Render bounded release facts from validated offline records while preserving authored prose.
- Key abstractions: `structuralChanges`, `persistenceReleaseFactArtifacts`, `replaceFacts`.
- Data flow: computes root/type counts and the changed-root table, then splices them into the release documents' fact regions.
- Non-obvious design decisions: the review-requirement column is computed "using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility" — and the prose says so.
- Edge cases / failure handling: `replaceFacts` requires exactly one marker pair.

### scripts/persistence-releases.ts
- Purpose: Verify the pinned prerelease archive without Git, network access or source extraction.
- Key abstractions: `PersistenceRelease`, `PersistenceReleaseManifest`, `PersistenceReleaseEntry`, `PersistenceReleases`, `loadPersistenceReleases`, `runPersistenceReleases`.
- Data flow: reads the manifest and each tag's four companions, reconstructs the adjacent root state from the recorded schemas, and classifies each transition.
- Non-obvious design decisions: the archive must be *complete* — "any unreferenced persistence release artefact: …" is an error, so a stray file cannot hide in the tree.
- Edge cases / failure handling: tags must be unique and in semantic-version order; the bilingual machine records must be byte-identical; an unchanged transition is refused.
- Surprising: `runPersistenceReleases` refuses to refresh stale facts with a message naming the remedy command.

### scripts/persistence-releases.spec.ts
- Purpose: The 22 KB release-archive spec (surveyed by test names).
- Key abstractions: fixture archives with manifest and companions.
- Data flow: asserts reconstruction, digest matching and fact refresh.
- Edge cases / failure handling: "does not write anything when machine data is corrupt or a later pair cannot be rendered"; "reconstructs deletions without requiring an after schema or a historical version increase".

### scripts/persistence-review.ts
- Purpose: Read-only structural explanations alongside the authoritative persistence classification.
- Key abstractions: `PersistenceReviewEvidence`, `PersistenceReview`, `reviewPersistenceSchemas`, `renderPersistenceReview`, `runPersistenceReview`.
- Data flow: walks two canonical schemas in parallel, emitting evidence keyed by before/after digests, and renders a Markdown report.
- Non-obvious design decisions: the explanation is explicitly *not* a decision — "Ambiguous alternatives remain separate additions and removals; this explanation does not decide compatibility." The classifier's per-root result is carried through unchanged.
- Edge cases / failure handling: recursion is bounded by a visited-pair set so a recursive schema terminates; union arms are matched by a **unique** discriminator selector, and an ambiguous match is reported as an addition plus a removal rather than a guessed rename.
- Surprising: the report renders each evidence item inside a `<details>` block with full fingerprints, so the summary stays readable while the detail remains available.

### scripts/persistence-review.spec.ts
- Purpose: Spec for the review (surveyed by test names).
- Key abstractions: fixture schema pairs.
- Data flow: asserts the evidence and the per-root assessment.
- Non-obvious design decisions: "never renames unchanged ordinal 107 alternatives" — a numeric alternative is not identified by its ordinal.

### scripts/persistence-schema-model.ts
- Purpose: Source-independent JSON type graphs and canonical persistence fingerprints.
- Key abstractions: `SchemaNode`, `CanonicalSchema`, `PersistenceRoot`, `PersistenceType`, `PersistenceSchemaInventory`, `canonicalizeSchema`, `schemaDigest`, `reachableSchemaTypes`.
- Data flow: takes a node-indexed graph, canonicalises it and hashes it.
- Non-obvious design decisions: "Numeric references are local to one graph; names and source locations are metadata" — the digest is over *structure*, so renaming a type or moving a declaration does not change it, but reordering a tuple does.
- Edge cases / failure handling: `canonicalizeSchema` minimises differently factored recursive aliases to the same graph; unproductive union cycles are rejected.
- Surprising: `SourceCompatibility` is part of the schema model — the *reader promise* is fingerprinted alongside the shape, so weakening the promise changes the digest.

### scripts/persistence-schema-model.spec.ts
- Purpose: Spec for the canonical graphs (surveyed by test names).
- Key abstractions: fixture type graphs.
- Data flow: asserts canonicalisation and digests.
- Non-obvious design decisions: "ignores source ordering and shared versus duplicated subtypes" and "minimizes differently factored recursive aliases to the same graph" — the fingerprint is semantic, not syntactic.
- Edge cases / failure handling: "rejects missing references and unproductive union cycles".

### scripts/persistence-schema.ts
- Purpose: Extract complete persistent Session record types from one source-only compiler program.
- Key abstractions: `PersistenceSchemaError`, `extractPersistenceSchema(root)`.
- Data flow: builds a source-only TS program over the workspace, finds the header, envelope and event roots, and extracts their reachable types.
- Non-obvious design decisions: the program is source-only and rejects build outputs — the same rule that lets `generate-typert.ts` run beside Host compilation.
- Edge cases / failure handling: "rejects invalid reachable declaration files despite inherited skipLibCheck" — a broken `.d.ts` in the graph is fatal, not skipped.
- Surprising: 26 KB; read the header and export scan, so the extractor body was surveyed.

### scripts/persistence-schema.spec.ts
- Purpose: The 34 KB extraction spec (surveyed by test names).
- Key abstractions: fixture source trees and `@persistenceSource` / `@persistenceAttribution` annotations.
- Data flow: extracts and compares inventories.
- Non-obvious design decisions: "keeps authored names and anonymous declaration locations without synthesized traversal names"; "discovers plugin event merges and keeps ordinary event additions out of the envelope digest".
- Edge cases / failure handling: rejects an event map whose compiler vocabulary exceeds the discovered source corpus; rejects the reserved producer kinds (`auto-review`, `compact-basic`, `ptc-mode`) as new attributions.

### scripts/persistence-schema-snapshot.spec.ts
- Purpose: Spec for the compact snapshot (surveyed by test names).
- Key abstractions: a compact inventory.
- Data flow: asserts storage and restoration.
- Non-obvious design decisions: "stores only root graphs and restores shared recursive definitions without changing reports" — the compact form is a storage optimisation that must not change a single reported fact.
- Edge cases / failure handling: rejects a compact digest that identifies no root subgraph; still validates explicit legacy graphs instead of replacing them.

### scripts/persistence-source-annotations.ts
- Purpose: Resolve producer opt-ins and core-owned source bindings before schema extraction.
- Key abstractions: `sourceCompatibilityAnnotations(root, program)`.
- Data flow: scans the program for `@persistenceSource` and `@persistenceAttribution` tags and resolves them against the `MessageSourceMap`.
- Non-obvious design decisions: the binding tag is only legal on the *core* `MessageBase.source` property and only with `user`/`developer` roles — anything else throws with the file path.
- Edge cases / failure handling: a role list with duplicates or an unknown role is rejected; a conflicting attribution for one wire kind is rejected; a qualification that does not resolve to exactly one literal wire kind is rejected.
- Surprising: the attribution set is derived from the *type* of each `MessageSourceMap` property, so a producer must mark the property and the kind is then read from the declaration — the model cannot lie about the kind.

### scripts/persistence-source-metadata.ts
- Purpose: Stable source-file metadata for saved persistence inventories.
- Key abstractions: `withoutPersistenceSourceLines(inventory)`.
- Data flow: strips `:line:col` / `#L1-L2` suffixes from every source pointer and de-duplicates.
- Non-obvious design decisions: "without changing schemas, names, or fingerprints" — the source line is metadata, not identity.

### scripts/persistence-source-policy.ts
- Purpose: Literal source groups and the supported reader promise saved in schema history.
- Key abstractions: `RESERVED_SOURCE_KINDS`, `sourceKindGroups`, `validSourceCompatibility`, `matchingSourceCompatibility`.
- Data flow: groups union alternatives by their required literal `kind` discriminator and compares the recorded promises.
- Non-obvious design decisions: the reserved-kind set prevents a producer from claiming a kind that already means something else — "Existing kinds outside this set also reject retroactive qualification during comparison."
- Edge cases / failure handling: `matchingSourceCompatibility` requires the *same* kinds to be qualified before and after, so an existing kind cannot silently become qualified (or stop being qualified).
- Surprising: the policy only applies to the `user` and `developer` roles' `source` property — every other source stays strict.

### scripts/plugin-record-catalog.ts
- Purpose: Discover package-owned experimental Session records without adding persistence schema roots.
- Key abstractions: `PluginRecordEntry`, `collectPluginRecords(scanRoot)`.
- Data flow: scans experimental packages for `plugin:…` record declarations in the `PluginRecordMap` merge.
- Non-obvious design decisions: the payload annotation is kept **unexpanded** ("Payload annotations link to their owning source without expanding referenced types") so an experimental record cannot destabilise the core schema.
- Edge cases / failure handling: records outside experimental production source are rejected; the record name must match `plugin:<ns>/<name>`.

### scripts/plugin-record-catalog.spec.ts
- Purpose: Spec for the plugin-record catalogue (surveyed by test names).
- Key abstractions: fixture record declarations.
- Data flow: asserts discovery and rendering.
- Edge cases / failure handling: rejects missing prose, Cordis mode tags, inheritance and duplicate names; requires one empty exported map in the session package.

### scripts/pnpm-invocation.ts
- Purpose: Resolve shell-free child-process invocations for the pnpm process that launched a package script.
- Key abstractions: `pnpmInvocation(args, environment)`.
- Data flow: reads `npm_execpath` and returns a command plus arguments.
- Non-obvious design decisions: a `.js/.cjs/.mjs` entrypoint is run through `process.execPath` — "the entry that launched this script when a run-script did" — because `spawnSync` cannot run a Windows `.cmd` shim without a shell.
- Edge cases / failure handling: an absent `npm_execpath` throws with "invoke the script through pnpm run" rather than falling back to a bare `pnpm`.

### scripts/pnpm-invocation.spec.ts
- Purpose: Spec for the pnpm invocation.
- Key abstractions: table-driven entrypoint spellings.
- Data flow: asserts the returned command and arguments.
- Non-obvious design decisions: the fixtures include hostile paths (spaces, `$pnpm;`, non-ASCII) to prove the invocation is argument-array based, not shell-interpolated.

### scripts/prepare-ci-bubblewrap.sh
- Purpose: Install a pinned bubblewrap build into the CI runner's temp directory.
- Key abstractions: `BUBBLEWRAP_VERSION`, `BUBBLEWRAP_SHA256`, `BUBBLEWRAP_URL`.
- Data flow: curl → `sha256sum --check` → `dpkg-deb --extract` → append to `GITHUB_PATH` → functional probe.
- Non-obvious design decisions: Ubuntu's package transaction "scans the hosted image's full dpkg database and runs post-install hooks", so the signed archive is extracted by hand instead.
- Edge cases / failure handling: Linux x86_64 only; the AppArmor knob is best-effort ("the functional probe decides") and the real gate is `bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true`.

### scripts/prepare-linux-node-pty.sh
- Purpose: Compile the node-pty addon against glibc 2.28.
- Key abstractions: the manylinux image selection.
- Data flow: generate node-gyp's Makefile on the runner, then compile inside the manylinux container as the invoking user.
- Non-obvious design decisions: the build runs in a container so the artifact links against an older glibc than the runner's.
- Edge cases / failure handling: unsupported architectures exit 1; `readelf --version-info` is printed for inspection.

### scripts/preview-workflow.spec.ts
- Purpose: Spec on the PR preview workflow.
- Key abstractions: the workflow YAML.
- Data flow: asserts the runner, the cache policy and the comment step.
- Non-obvious design decisions: "keeps the immutable complete artifact build and restore-only dependency cache" — the cache can be restored but never written, so a preview build is always from source.

### scripts/primary-runtime/lock.json
- Purpose: The pinned interpreter and wheel lock.
- Key abstractions: `nodeVersion`, `pythonVersion`, `pythonRelease`, `targets`, `wheels`, `pythonPackages`.
- Data flow: `prepare.ts` reads it to choose every download URL and digest.
- Non-obvious design decisions: per-target Node/Python archive SHA-256 *and* per-wheel SHA-256 — nothing is fetched without a pinned digest.
- Edge cases / failure handling: `primary-runtime/prepare.spec.ts` asserts every SDK wheel target is covered by the shared lock and that a stale payload is refused before execution.
- Surprising: the wheels are pinned by full pythonhosted URL, so the digest is checked against the exact artefact rather than a version string.

### scripts/primary-runtime/prepare.ts
- Purpose: Prepare pinned, relocatable script interpreters without installing into the build host.
- Key abstractions: `downloadPrimaryRuntimeAsset`, `downloadRuntimeNpmPackage`, `downloadNodeRuntime`, `unpackPrimaryRuntimeWheel`, `prepareOfficeSkillAssets`, `primaryRuntimePayloadDigest`, `preparePrimaryRuntime`, `smokePrimaryRuntime`.
- Data flow: hash-verified download → extract → stage → write `runtime.json` → copy into place → smoke-test the native payload.
- Non-obvious design decisions: `downloadPrimaryRuntimeAsset` writes to a temporary name and *renames* into the digest-named cache path, so a concurrent download publishes exactly one complete cache entry. A checksum mismatch deletes the cache file and throws.
- Edge cases / failure handling: wheel entries needing an installation scheme other than `scripts` are rejected; `smokePrimaryRuntime` refuses to run when the distribution metadata is missing.
- Surprising: the smoke runs with a **credential-scrubbed environment** (any name matching `KEY|SECRET|TOKEN|PASSWORD` is removed) and uses `-I -B` so the payload's Python ignores the user's site-packages.

### scripts/primary-runtime/prepare.spec.ts
- Purpose: Spec for the primary runtime (surveyed by test names).
- Key abstractions: fixture lock targets.
- Data flow: asserts payload identity and download behaviour.
- Non-obvious design decisions: "keeps a target payload identity independent of other target archives" and "gives Python-only payloads a distinct identity" — the digest must not change because an unrelated target's lock changed.
- Edge cases / failure handling: a large deflate-compressed wheel entry must be fully extracted; missing distribution metadata is reported *before* trying to execute a stale payload.

### scripts/primary-runtime/prune-python-tests.ts
- Purpose: Remove upstream Python test suites from the staged primary runtime.
- Key abstractions: `prunePrimaryRuntimePythonTests(sitePackages)`.
- Data flow: removes `tests/` directories and rewrites the wheel `RECORD`.
- Non-obvious design decisions: the RECORD rows are rewritten so `pip check` still passes — a pruned wheel whose RECORD still lists the deleted files is broken.
- Edge cases / failure handling: a missing or malformed RECORD throws.

### scripts/primary-runtime/prune-python-tests.spec.ts
- Purpose: Spec for the pruning.
- Key abstractions: a fake site-packages tree.
- Data flow: asserts the removal and the RECORD rewrite.
- Edge cases / failure handling: malformed RECORD rows (`"unterminated,,`, `numpy/tests/test_numpy.py,`) are refused.

### scripts/primary-runtime/smoke.py
- Purpose: Exercise the relocated Office payload with its own isolated interpreter.
- Key abstractions: `check_interpreters`, `main`.
- Data flow: checks the interpreter aliases, builds a venv, compares installed distributions with the lock, and round-trips docx/pptx/xlsx files.
- Non-obvious design decisions: "Only pip belongs to the interpreter baseline; all other distributions must be declared" — an *extra* distribution in the payload is a failure, not a tolerance.
- Edge cases / failure handling: it asserts `numpy._core._multiarray_tests` still imports ("NumPy testing helpers require this native extension even without upstream test directories") and that no `tests` directory remains under either library.
- Surprising: the RECORD of every distribution is re-read and each listed file is asserted to exist — the prune step is verified from the Python side.

### scripts/product-package-policy.ts
- Purpose: The table of non-default package roles.
- Key abstractions: `ProductPackageCategory`, `ProductPackagePolicy`, `PRODUCT_PACKAGE_POLICY`.
- Data flow: consulted by the reachability and publication gates.
- Non-obvious design decisions: every entry carries a **reason** string — the policy is a documented exception list, not a silent allowlist.
- Edge cases / failure handling: the categories distinguish `sdk`, `build`, `test`, `web-distribution` and `declarations` from `optional`, so "not default runtime" is not one undifferentiated bucket.

### scripts/project-doc-site.ts
- Purpose: Build-time projection from canonical repository Markdown into VitePress.
- Key abstractions: `rewriteMarkdown`, `addProjectionFrontmatter`, `projectedPageContent`, `publishableImage`, `docsSourceFiles`, `projectDocs`, `emitRawMarkdownPages`, `rawMarkdownRoute`, `llmsTxt`, `resolveRepositoryRef`.
- Data flow: reads the canonical `docs/` tree, rewrites cross-source links per locale, places images, and writes both the VitePress tree and a raw-Markdown twin of every route.
- Non-obvious design decisions: "The generated tree is disposable: sources stay in their owning `docs/` tier, while this adapter rewrites cross-source links for the public site" — the projection is a *view*, never an edit of the source.
- Edge cases / failure handling: `publishableImage` refuses a target whose real path escapes the repository; the site root itself can never be removed; a link-shaped output is unlinked without removing its target.
- Surprising: the raw-Markdown twin means "a page's URL, minus any trailing slash, plus `.md` serves it as plain Markdown" — the same content is available to agents without a browser.

### scripts/project-doc-site.spec.ts
- Purpose: The 36 KB site-projection spec (surveyed by test names).
- Key abstractions: fixture doc trees and manifests.
- Data flow: asserts rewriting, routing and emission.
- Non-obvious design decisions: "does not rewrite Markdown-looking text inside code fences" — the rewriter is syntax-aware, not regex-based.
- Edge cases / failure handling: "fails loud when a relative target is missing"; every published route must resolve every relative link inside the emitted tree (60 s).

### scripts/project-reference-faces.ts
- Purpose: Validate compiler-face isolation across workspace Project Reference graphs.
- Key abstractions: `collectProjectReferenceFaceViolations(root)`.
- Data flow: walks from `tsconfig.host.json` and `tsconfig.client.json`, resolving each config's face through its `extends` chain.
- Non-obvious design decisions: "A single-config project is neutral and may participate in either graph. Once a package declares both face configs, every reachable reference must name the leaf matching the aggregate from which traversal began."
- Edge cases / failure handling: a reference into a split project from a config with *no* face is reported separately, because that is a different mistake.
- Surprising: the split roots are sorted longest-path-first so the innermost containing root wins.

### scripts/project-reference-faces.spec.ts
- Purpose: Spec for the face isolation.
- Key abstractions: fixture project graphs.
- Data flow: asserts the violation strings.

### scripts/publication-payload.ts
- Purpose: Publication payload policy shared by static manifests and packed tarballs.
- Key abstractions: `hasTypertRemoteNavigation`, `isForbiddenPublicationFile`, `validateTarballPayload`.
- Data flow: classifies manifest paths and tarball members.
- Non-obvious design decisions: "Maps serve editor navigation during development, where a workspace consumer resolves their source through the package link; a published map resolves nothing, so no payload publishes one."
- Edge cases / failure handling: the `package/` prefix is stripped before classification, so the same rule applies to a manifest path and a tarball member.

### scripts/publication-payload.spec.ts
- Purpose: Spec for the payload policy.
- Key abstractions: fixture manifests and member lists.
- Data flow: asserts the rejections and the single acceptance.
- Surprising: it asserts that *only* the canonical Host-for-Client export pair is recognised — a near-miss export is not.

### scripts/publint-all.ts
- Purpose: Run publint over the exact manifest-declared publication view of every package.
- Key abstractions: `CONCURRENCY_ENV`, the publication-view builder.
- Data flow: builds an in-memory view of each package's declared files and lints it.
- Non-obvious design decisions: publint runs against the *manifest-declared* view rather than the working tree, so an unbuilt or stale `lib/` cannot pass.
- Edge cases / failure handling: `isBrowserBundleFormatFalsePositive` filters one known-wrong verdict; every other diagnostic remains fatal.
- Surprising: the file's own header (11 KB body) was surveyed via the header and import list.

### scripts/publint-all.spec.ts
- Purpose: Spec for the publint runner (surveyed by test names).
- Key abstractions: a cancellation signal per case.
- Data flow: lints in-memory publication views.
- Non-obvious design decisions: "reports deadline cancellation after every owned child closes" — the runner must not abandon a child process.
- Edge cases / failure handling: "rejects an export that exists in the workspace but is not published" and "rejects a public export whose built file is missing".

### scripts/publint-browser-format.ts
- Purpose: The single false-positive predicate for publint's browser format verdict.
- Key abstractions: `isBrowserBundleFormatFalsePositive(message)`.
- Data flow: inspects one publint diagnostic.
- Non-obvious design decisions: "Browser Client and Worker artifacts run outside Node's ESM loader, so their CommonJS-format verdict is false; a Node Client entry must never be exempt."
- Edge cases / failure handling: the exemption is keyed on the *file path* (`lib/client.js`, `lib/client.browser.js`, `lib/worker.js`) or on the `./worker` export key — narrow on purpose.

### scripts/publish-npm-baseline.ts
- Purpose: Build, publish and verify one commit-addressed npm workspace baseline.
- Key abstractions: the baseline manifest and the per-commit address.
- Data flow: discovers the baseline manifests, packs them, publishes them, and verifies the published set against the commit.
- Non-obvious design decisions: the baseline is *commit-addressed*, so the published artifact set is reproducible from a git SHA rather than from "whatever the workspace looks like".
- Edge cases / failure handling: `validateTarballPayload` is applied to each packed tarball before it is published.
- Surprising: 38 KB; read the 22-line header and import list — the implementation body was surveyed, not read line by line.

### scripts/python-runtime-download.spec.ts
- Purpose: Spec for the Python runtime download (surveyed by test names).
- Key abstractions: a fake download server.
- Data flow: starts, downloads one resource, reuses the cache, and races two processes.
- Non-obvious design decisions: "publishes one complete cache when two processes download concurrently" — the atomic-rename pattern is asserted at the spec level.
- Edge cases / failure handling: a failed staging is cleaned and an explicit retry is allowed; an invalid private download selector is rejected while ordinary CLI arguments are left alone.

### scripts/python-snapshot-workflow-order.spec.ts
- Purpose: Spec for the advanced snapshot workflow ordering (surveyed by test names).
- Key abstractions: fixture parent/child agents.
- Data flow: asserts the child's first model request is blocked until the parent's event arrives.
- Non-obvious design decisions: "waits for the parent to consume the direct start and acknowledge its request log" — the barrier is delivery, not production.
- Edge cases / failure handling: cancellation detaches the waiter; "settles pending waits before disposal completes and removes both listeners".

### scripts/release/bump.ts
- Purpose: Bump one release family's version and commit it.
- Key abstractions: `compareVersions`, `nextVendorVersion`, `reachesPayload`, `planShared`.
- Data flow: computes the next version, writes it into the manifests, updates the lockfile, and commits.
- Non-obvious design decisions: "The version lands in the manifests, the lockfile follows, and a human creates the tag after the commit merges. CI never writes to the repository."
- Edge cases / failure handling: the vendored family has one version line per package, but "every release advances and publishes the complete family so the next release never reuses an unchanged member's existing version from a different repository state."
- Surprising: `reachesPayload` decides whether a change actually reaches the published payload — a version bump that changes nothing publishable is handled differently.

### scripts/release/families.ts
- Purpose: The two release sequences this repository publishes from.
- Key abstractions: `PublishPlan`, `ReleaseMember`, `InstalledEntry`, `releaseFamily`, `tarballName`.
- Data flow: discovers members, computes the publish order, and applies the payload policy.
- Non-obvious design decisions: "Each family carries its own version baseline, tag naming, and publish set, so releasing one never republishes another"; and "The family dimension lives here only. A new sequence adds a subclass and a `releaseFamilies()` entry; nothing else in the release scripts branches on it."
- Edge cases / failure handling: a runtime dependency cycle is reported rather than producing an arbitrary order; a peer cycle is *ordered around* and the dropped edge is reported.
- Surprising: on-demand catalog members are published before dsh "without adding installed dependencies".

### scripts/release/families.spec.ts
- Purpose: The 24 KB families spec (surveyed by test names).
- Key abstractions: fixture member sets.
- Data flow: asserts membership, ordering, tags and payload policy.
- Non-obvious design decisions: "publishes a peer before its consumer" and "orders around a peer cycle rather than refusing to publish, and reports the edge it dropped" — npm treats an unmet peer as a warning, so ordering is a best effort that is *reported*.
- Edge cases / failure handling: "refuses an order that would publish a consumer before a dependency it installs"; devDependencies are ignored when ordering.

### scripts/release/installed-product-isolation.ts
- Purpose: Experimental-package isolation for the installed default product's dependency graph.
- Key abstractions: `verifyInstalledProductIsolation(directory, optionalBundles)`.
- Data flow: BFS over the *installed* dependency graph, resolving each dependency through the package's own ancestor `node_modules`.
- Non-obvious design decisions: "Other packages installed beside the entry and development dependencies do not join its graph" — the walk starts at the entry package and follows only its own dependencies.
- Edge cases / failure handling: a missing required dependency throws; optional packages and optional peers may be absent.
- Surprising: an optional bundle listed by the launcher must be *installed* — its absence is an error, because the launcher will select it.

### scripts/release/installed-product-isolation.spec.ts
- Purpose: Spec for the installed-product walk.
- Key abstractions: fixture installed trees.
- Data flow: asserts the accepted and rejected graphs.
- Edge cases / failure handling: "follows nested installations rather than an unrelated hoisted package" and "rejects experimental npm aliases even when an optional package is omitted".

### scripts/release/pack.ts
- Purpose: Pack one release family's whole publish set into a single directory.
- Key abstractions: `validatePackedMember`, `packMembers`, `parseConcurrency`.
- Data flow: verify build artifacts → verify versions → pack → validate each tarball's payload and manifest → write `publish-order.txt`.
- Non-obvious design decisions: "The pack step is the release boundary: it runs without credentials, produces every tarball from one commit, and hands the publish step exactly those bytes."
- Edge cases / failure handling: concurrency 1 packs serially in publish order; an explicitly parallel pack uses pnpm's bounded scheduler but still validates every tarball before the order is recorded.
- Surprising: the default `--concurrency` is 1, "exactly as the credentialed publish workflows run it."

### scripts/release/pack.spec.ts
- Purpose: The 17 KB pack spec (surveyed by test names).
- Key abstractions: fixture packs.
- Data flow: asserts the tarballs and the recorded order.
- Edge cases / failure handling: "does not broaden an empty parallel family to the whole workspace"; a failing hook leaves no publish-order file; "stops the ready pack hook and its stalled descendant before fixture cleanup".

### scripts/release/process.ts
- Purpose: Process helpers shared by the release scripts.
- Key abstractions: `RunOptions`, `CommandResult`, `attempt`, `attemptEchoed`, `capture`, `runConcurrent`, `isEntry`, `pnpmCommand`.
- Data flow: the three failure behaviours the release steps need — capture and judge, capture and fail, run concurrently and fail.
- Non-obvious design decisions: `pnpmCommand` refuses a bare `pnpm` on Windows with a named error rather than failing later: "Windows resolves a bare `pnpm` to a batch shim that spawnSync cannot start, so say that rather than fail later."
- Edge cases / failure handling: `runConcurrent` inherits stdio so concurrent children interleave at line granularity without buffering.

### scripts/release/process.spec.ts
- Purpose: Spec for the process helpers.
- Key abstractions: the tarball readers.
- Data flow: asserts the pnpm resolution and the archive reads.

### scripts/release/publish.ts
- Purpose: Publish one packed release family from the tarballs the pack step produced.
- Key abstractions: `registryState`, `isTransientFailure`, `verifyDistTag`, `publishTarball`, `publishRelease`, `TRANSIENT_PUBLISH_CODES`, `PUBLISH_ATTEMPTS`, `PUBLISH_SPACING_MS`.
- Data flow: for each member, ask the registry whether the version exists; absent → publish, same integrity → skip, different integrity → fail; on failure classify the code and retry with exponential backoff.
- Non-obvious design decisions: "Publication is decided per package against the registry, never from a list of 'what this release includes'"; and "Skipping on identical integrity is what makes re-running the publish step over the same artifact safe."
- Edge cases / failure handling: every retry **re-reads the registry first**, because "`E409` can answer a write that landed anyway: republishing a version that now exists fails permanently, so the same integrity appearing under the failed attempt counts as success." Transient codes are separated from rejected payloads ("`E403` over an existing version, a malformed manifest … never clears on a retry and must surface").
- Surprising: the publish gap is inserted only *between* actual publishes ("a run that only skips does not wait at all"), and the dist-tag is validated across the whole batch *before* the first upload so a later conflict cannot leave a half-published release.

### scripts/release/publish.spec.ts
- Purpose: The release publication spec (surveyed by test names).
- Key abstractions: a fake registry.
- Data flow: drives channel checks and the publish loop.
- Edge cases / failure handling: "stops before the first upload when a later published version has no custom channel" and "rejects different bytes already published at the requested version" — the run refuses rather than partially publishing.

### scripts/release/tarball.ts
- Purpose: Reading packed npm tarballs and the order file that accompanies them.
- Key abstractions: `PUBLISH_ORDER_FILE`, `PackedIdentity`, `tarballFiles`, `packedManifest`, `packedIdentity`, `readPublishOrder`.
- Data flow: reads the archive with `tar`.
- Non-obvious design decisions: "The release steps after pack treat a directory of tarballs as the unit of work, so they read what a tarball declares rather than what the checkout currently says."
- Edge cases / failure handling: `tar` runs with `cwd` set to the tarball's directory because "GNU tar reads the colon in a Windows drive path as a remote-host separator".

### scripts/release/verify-packed-install.ts
- Purpose: Install packed tarballs into a throwaway consumer outside the repository and drive the installed executable with plain Node.
- Key abstractions: the install-and-run harness.
- Data flow: create a temp consumer, install from `--from`, run the entry.
- Non-obvious design decisions: "Every tarball the installed tree needs comes from `--from`, so the only registry traffic is for external dependencies" — because a dsh verification may need the *vendored* family's tarballs, which are published on a different schedule.
- Edge cases / failure handling: the npm cache belongs to the consumer and is removed with it on completion or failure.
- Surprising: "What this proves is that `files` selected a complete payload and that the published dependency ranges resolve. A workspace link or a stale `lib/` in the checkout cannot stand in for a missing file here."

### scripts/release/verify-packed-install.spec.ts
- Purpose: Spec for the packed-install verification (surveyed by test names).
- Key abstractions: the three outcomes.
- Data flow: drives success, install failure and entry failure.
- Surprising: the three outcomes are distinguished rather than collapsed into "failed".

### scripts/release/verify.ts
- Purpose: Verify a release family's version baseline and, when publishing, its tag and publishability.
- Key abstractions: `reportPublishOrder`, `verifyPublishable`, `verifyTag`.
- Data flow: resolves the publish order and prints it.
- Non-obvious design decisions: the publish order is printed on **every pull request** — "printing it on every pull request is what makes a change to the order reviewable rather than only observable during a publication."
- Edge cases / failure handling: the order is resolved *before* the build, "an install-edge cycle makes the order unrepresentable, and that has to surface at the first gate rather than when pack is already writing tarballs."
- Surprising: dropped peer edges are printed explicitly with the reason that npm treats an unmet peer as a warning.

### scripts/render-persistence-schema.ts
- Purpose: Readable, linked persistence schemas rendered from the fingerprint inventory.
- Key abstractions: `PersistenceSchemaRendering = 'current' | 'historical'`, `renderPersistenceSchemaIndex`, `renderPersistenceSchemaDefinitions`.
- Data flow: walks the canonical graph and renders an index plus per-type definitions.
- Non-obvious design decisions: the rendering mode changes the output — "shows recorded source policies only in the current catalog and preserves their fields" — because a historical reference must show what was true then.
- Edge cases / failure handling: recursion is rendered once through a finite self-reference; an inventory that omits a referenced definition is refused.
- Surprising: labels are intrinsic to the scalar ("uses intrinsic scalar labels even when an alias or reference supplied a name"), so renaming an alias does not change the published label.

### scripts/render-persistence-schema.spec.ts
- Purpose: The 20 KB rendering spec (surveyed by test names).
- Key abstractions: fixture inventories.
- Data flow: renders and asserts the Markdown.
- Non-obvious design decisions: "keeps the captured historical Markdown byte-for-byte in both historical call forms" — the renderer must not touch a historical document.
- Edge cases / failure handling: ambiguous aliases are omitted while colliding labels stay linked to distinct definitions.

### scripts/repo-files.ts
- Purpose: Shared repository file discovery and line-oriented reference scanning.
- Key abstractions: `RepoFile`, `ReferenceViolation`, `isArchivedAgentNotePath`, `uniqueRepoFiles`.
- Data flow: walks the tree with its own glob semantics and canonicalises matches through `realpath`.
- Non-obvious design decisions: the repository has its own walker because "node's internal glob, from some 24.x releases, lstat-probes `<matched>/<next segment>` for symlinked files while expanding `**` and throws ENOTDIR instead of skipping (observed on node 24.13.0)"; the walker's contract is "decides directoryhood from dirent types and stat results, never by probing a path under a file".
- Edge cases / failure handling: `UNSUPPORTED_GLOB` makes the walker throw on glob syntax it does not model — "expanding those silently as literals would match nothing and quietly shrink a gate's corpus, so a pattern segment using them fails loudly instead."
- Surprising: wildcard segments never enter symlinked directories and never match dot names, while a *literal* segment naming a symlinked directory does enter it — node's `follow: false` is documented only for `**`, so the wildcard-side behaviour is the walker's own contract, pinned by the spec.

### scripts/repo-files.spec.ts
- Purpose: Spec for the walker (surveyed by test names).
- Key abstractions: fixture trees with symlinks and dot names.
- Data flow: asserts the enumerated set.
- Non-obvious design decisions: "fails loudly on a broken symlink instead of shrinking the corpus" and "rejects a trailing `**` segment instead of silently returning nothing".

### scripts/request-input-types.spec.ts
- Purpose: Spec accepting mixed requests while refusing lightweight inputs at durable message writes (surveyed by test names).
- Key abstractions: a request input union.
- Data flow: type-checks the request shape against the durable write door.
- Edge cases / failure handling: 60 s timeout because the case compiles the real workspace.
- Surprising: the gate is at the *durable message write*, so a lightweight input is legal everywhere else.

### scripts/rescope-vendor.ts
- Purpose: Rescope the vendored Cordis packages into the `@deepseek-ai` scope, and undo it with `--reverse`.
- Key abstractions: `isRescopeExcluded`, `exactEditState`, `EXACT_EDITS`.
- Data flow: rewrites delimited, complete package-name tokens in code, YAML, Markdown fences and `docs/` prose.
- Non-obvious design decisions: the generic pass rewrites **only** quoted tokens (plus a YAML `name:` scalar), which excludes `cordis.yml`, the Loader's `cordis:` builtin prefix, `cordis-config-entry`, `@deepseek-ai/dsh-tool-cordis` and `cordiverse/cordis` — and it makes the rewrite idempotent because the scoped name's `cordis` is preceded by `/`.
- Edge cases / failure handling: sites the token rule cannot express (dot-notation access, unquoted object keys, regex literals, the vendored-manifest table) are listed in `EXACT_EDITS` with an **exact hit count**, so an upstream change to one of them fails loudly instead of being silently skipped.
- Surprising: Markdown follows the rename inside every fence and in `docs/` prose too — "a tutorial that teaches an unresolvable name is wrong, while prose elsewhere records what was true when it was written." 34 KB; read the header and symbol scan, so the rewrite body was surveyed.

### scripts/rescope-vendor.spec.ts
- Purpose: Spec for the rescope selection and exact edits.
- Key abstractions: `exactEditState` cases.
- Data flow: asserts the recorded npm resolution is preserved and each edit's classification.
- Non-obvious design decisions: "classifies an insertion by its target form, so a duplicate is invalid" — the target must not already exist.

### scripts/run-ci-bench.ts
- Purpose: Build benchmark artifacts, then run the benchmark suite.
- Key abstractions: `buildCiBenchArtifacts`, `runCiBench`.
- Data flow: native → libraries (benchmark-emit) → benchmark workers → Web assets → the benchmark suite.
- Non-obvious design decisions: the library step uses the `benchmark-emit` mode, "TypeScript diagnostics owned by required full builds" — the benchmark lane does not pay for a full type check.

### scripts/run-coverage-partitions.ts
- Purpose: CLI entry for partitioned Vitest coverage.
- Key abstractions: the environment contract.
- Data flow: parses the partition count, builds the coordinator, runs it.
- Edge cases / failure handling: both the partition count and a pnpm package-script invocation are *required* — "partitioned coverage must be invoked through a pnpm package script", because the coordinator needs pnpm's JavaScript entrypoint.

## Ideas worth stealing

- **Re-read the registry before every retry, and treat "identical integrity already present" as success** — `scripts/release/publish.ts:137` (the retry loop) and `scripts/release/publish.ts:152` (`const settled = registryState(name, version)`). The mechanism: a publish that reports `E409` may have *landed*; re-publishing a version that now exists fails permanently. So every retry re-reads the registry, and the same integrity appearing under the failed attempt counts as success. The same file separates **transient** registry codes (`E409`, `E429`, `E5xx`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`) from rejected payloads (`E403` over an existing version, a malformed manifest), which never clear on a retry — `scripts/release/publish.ts:32`. **Why it transfers to August:** any agent action that mutates external state (writing a memory, creating a branch, publishing a record) needs the same shape: classify the failure as "did not land" vs "was refused", re-read the state, and treat "already in the desired state" as success rather than an error. Without it, a retried tool call either duplicates the effect or fails a turn that actually succeeded.

- **Decide publication per item against the registry, never against a manifest of "what this release includes"** — `scripts/release/publish.ts:193` (the per-member loop). Three outcomes: absent → publish; present with identical integrity → skip; present with different integrity → fail loudly with "Bump the version, or investigate why the build is not reproducible." **Why it transfers:** the August harness's agent loop and its memory store have exactly the same hazard — a write that *looks* like it failed but landed, and a write that would silently overwrite. Making the "already in the desired state" case a first-class skip (rather than an error) is what makes a retried turn idempotent.

- **Split the publish order into a credential-free step and a credentialed step, and hand the second the exact bytes** — `scripts/release/pack.ts:6` ("The pack step is the release boundary: it runs without credentials, produces every tarball from one commit, and hands the publish step exactly those bytes") and `scripts/release/pack.ts:103` (writing `publish-order.txt`). The same repository applies it to the desktop installer (`scripts/release/verify-packed-install.ts:12`) — a throwaway consumer outside the repo installs from the packed output and is driven with plain Node. **Why it transfers:** an August "skill update" or "plugin install" flow can be split the same way: build and verify the artefact offline, then hand the verified artefact to the installing step. This is what makes a failed install retryable without re-running the risky part.

- **Weigh the test partition by measured duration and start the heaviest first** — `scripts/coverage-partitions.ts:342` (`assignWeightedPartitions`, a longest-processing-time assignment over a min-heap) and `scripts/coverage-partitions.spec.ts:618` ("starts the heaviest partition first for fail-fast"). The mechanism: recorded per-file durations seed the heaviest files into the currently lightest partition, with a min-heap so each placement is O(log partitions); equal sums prefer the leaner bucket so a duration-sparse inventory still balances file count. **Why it transfers:** an August agent evaluation suite has the same shape — a fixed wall-clock budget across heterogeneous test files — and an unweighted split puts the slow integration tests in one bucket and blows the budget. The "heaviest first" ordering is free fail-fast latency on top of the balance.

- **Canonicalise a numeric field before merging partitions, or the merge invents work that was never uncovered** — `scripts/coverage-canonical-locations.ts:24` (`END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER`) and `scripts/coverage-canonical-locations.ts:35` (`canonicalizeLocation`). The mechanism: `ast-v8-to-istanbul` ends a whole-line statement at column `Infinity`; the blob's JSON hop turns that into `null`; `istanbul-lib-coverage` reconciles the per-environment spellings of one statement only through *numeric* columns, so a `null` column leaves a client-only spelling behind as a phantom uncovered statement. The fix is a finite stand-in that preserves the line-end meaning and keys identically in every blob. **Why it transfers:** this is exactly the "one record, two spellings" failure that any August harness hits when the same logical event is written by two code paths (a host-side and a browser-side writer, say). If the merge key is numeric, one side's `null` silently creates a phantom duplicate. The general rule: **find the field where the merge is numeric-only, and replace the unrepresentable value with a finite stand-in before the serialisation hop.**

- **Aggregate gate violations into one error instead of failing fast** — `scripts/jsdoc.ts:195` (`reportViolations`) and `scripts/gen-cordis-catalog.ts:1131` (`walkPartitionProblems`). The stated reason is practical: "a remediation pass sees the whole list at once instead of replaying the gate once per offender." The cordis variant goes further — it is an **independent backstop** that cross-checks a generator's output against a separate AST scan, and when they disagree it names *which side* is wrong: "ctx.llm is rendered by the projection but the independent scan finds no Context merge declaring it." **Why it transfers:** an August harness with an inventory of tools, skills, or memory schemas needs the same two-layer structure — a generator and a *separate* reader that verifies the generator — and the error message must attribute the defect rather than just say "mismatch". A gate that says "inconsistent" costs a human an hour; one that says "the scan is blind" costs thirty seconds.

- **Refuse to delete anything when one target is unsafe, and derive the deletion set from the build graph rather than a list** — `scripts/clean.ts:111` (the unsafe-orphan abort) and `scripts/clean.ts:121` (`buildOutputDirectories`, which walks the `tsconfig` project-reference graph). The mechanism: every candidate is planned and validated *first*; one package directory with an unknown file aborts the whole clean. The comment is explicit about why: "Planning validates every target first, so an unsafe orphan prevents all deletion." **Why it transfers:** any August "clean up the workspace" or "reset the session store" action needs this. Partial deletion is worse than no deletion, because it leaves state that nobody can reason about.

- **Fail loudly on glob syntax a walker does not model, rather than matching nothing** — `scripts/repo-files.ts:62` (`UNSUPPORTED_GLOB`). The reason is stated: "expanding those silently as literals would match nothing and quietly shrink a gate's corpus, so a pattern segment using them fails loudly instead." The same repository applies the rule to *empty* results: `scripts/coverage-exempt.spec.ts` asserts each exempt entry's filter and exclude select the same **non-empty** spec set. **Why it transfers:** this is the August equivalent of "a skill scan found zero skills" — the most dangerous failure mode of any agent inventory. A gate that reports zero matches must distinguish "there are none" from "my matcher is broken", and the only way to do that is to require the corpus to be non-empty and to reject patterns the matcher does not implement.

- **Make a workspace dependency range EXACT, and compute the expected published payload from the package's own exports** — `scripts/check-workspace-constraints.ts:628` (`checkWorkspaceProtocol`) and `scripts/check-workspace-constraints.ts:259` (`expectedDshPackageFiles`). The first mechanism: a hand-written range (`^0.0.1`) says nothing about the version the workspace actually carries, and `pnpm pack` leaves it alone, so the range must be the `workspace:` protocol and the packer substitutes the real version. The second: the expected `files[]` list is *computed* from the package's exports, icons, exported locale JSON, worker/client/loader/store subpaths and Typert pairs — so a new export automatically changes the required payload and a stale `files[]` fails. **Why it transfers:** an August plugin/skill registry has the same two hazards — a dependency range that lies about the installed version, and a payload list that silently omits a newly added artefact. Deriving the expected list from the artefact's own metadata turns both into automatic failures.

- **Keep a semantic seal over a decision record, so reformatting is allowed but changing the decision is not** — `scripts/persistence-finalization.ts:44` (`recordDigest`). The digest is taken over a *semantic projection* of the acknowledgement (id, baseline, sorted changes, snapshot roots), not over the document bytes, so rewriting the prose does not break the seal while changing a recorded decision does ("was removed or changed"). The same subsystem separately hashes the *schema* over structure only, so renaming a type or moving a declaration does not change the fingerprint (`scripts/persistence-schema-model.ts:282`). **Why it transfers:** August's durable memory and its session persistence both need "the same decision, reformatted" to be a no-op and "a different decision" to be detected. A byte hash cannot express that; a semantic projection can.

- **Make the reader promise part of the persisted schema, and refuse to weaken it retroactively** — `scripts/persistence-source-policy.ts:64` (`matchingSourceCompatibility`) and `scripts/persistence-source-annotations.ts:15` (`sourceCompatibilityAnnotations`). The mechanism: an explicit `@persistenceSource` binding (restricted to the core `MessageBase.source` property and the `user`/`developer` roles) records which wire kinds the reader will preserve; `@persistenceAttribution` marks a producer's own kind. The rule then forbids an existing kind from *changing* qualification between versions, and a set of reserved kinds (`user`, `model`, `tool`, `system-prompt`, `compact-checkpoint`, …) cannot be claimed by a new producer. **Why it transfers:** this is the durable-memory equivalent of "a new memory format may add a kind, but may not repurpose an existing one". August's memory store and its session log both need to know which older records a newer reader will still understand — and the answer has to be recorded, not inferred.

- **Boot the real plugins and harvest the runtime-registered schemas, then check the harvested count against the declared manifest** — `scripts/gen-tool-catalog.ts:759` (`collectToolCatalog`) and `scripts/gen-tool-catalog.ts:744` (`assertToolsHarvested`). The mechanism: the catalog is produced by booting the LLM, agent, session, goal, prompt and tools plugins in a real Cordis `Context` and reading what they actually registered — "Runtime registration is the source of truth for computed schemas" — and a plugin that registers fewer tools than its manifest claims fails the gate. **Why it transfers:** an August harness advertising its tools to a model must derive the list the same way, otherwise the model's view and the runtime's view diverge, and the model will call a tool that does not exist or miss one that does. Booting the real registry and diffing against a declared manifest is the cheap, high-value consistency check.

- **Bound the documentation a model must read, and reject a slot whose report it could not finish** — `scripts/gen-client-catalog.ts:159` (`oversizedSlotReports`) and `scripts/gen-client-catalog.ts:183` (`validateSlotContracts`). The mechanism: the model-facing client catalog is generated from the shipped web bundle's declarations *lexically* (no type-checker, no client runtime import), and each slot must carry registrant-facing prose, a declared registration and a unique key — plus a *size budget*, because "a slot whose report a model could not finish reading" is rejected. **Why it transfers:** this is the progressive-disclosure discipline applied to a *generated* surface. Any August surface a model reads (tool descriptions, skill headers, workspace overviews) needs the same three properties: it must be derived from the real registration, it must be unique, and it must be bounded. The size budget is the part that is usually missing.

- **Give the model a machine-readable inventory of its own configuration surface, and make every schema field provably exist** — `scripts/gen-config-catalog.ts:686` (`collectConfigCatalog`) with `scripts/gen-config-catalog.spec.ts` asserting "a schema field absent from the shared config type" is rejected. The mechanism: each package's public entry is followed through renamed named imports and public source subpaths to its config type, and the static Schemastery schema is checked field by field against that type; a type-only import used as a runtime schema, a private subpath, or a dynamic schema factory is **rejected** rather than having its keys dropped. **Why it transfers:** an August settings panel or a model's view of the tool configuration is the same surface. "External and dynamic types stay unknown" is the honest answer; silently dropping a dynamic factory's keys is how a model ends up unable to configure anything and does not know why.

- **Kill a runaway child process tree deliberately, and never let a measurement inherit the user's npm configuration** — `scripts/benchmark-npm-resolution.ts:309` (`runCommandWithTimeout`) and `scripts/benchmark-npm-resolution.ts:375` (`runNpm`). The mechanism: the timeout sends SIGTERM, waits a grace period, then SIGKILLs, and on Windows uses `taskkill /T`; it throws if a timed-out tree does not exit after SIGKILL. Separately, every inherited `npm_config_*` variable is stripped and a private `.npmrc` is written, because a user's global `legacy-peer-deps=true` would silently change the result. **Why it transfers:** August runs model calls and shell tools as child processes; a leaked process tree is a resource leak the user cannot see, and an inherited environment variable can silently change the behaviour of a measurement or a gate. Both are the same habit: control the child's environment and its lifetime explicitly.

- **Generate the session-format catalog by direct import so historical readability never depends on a mounted plugin** — `scripts/gen-session-format-catalog.ts:180` (the direct imports) and `scripts/gen-session-format-catalog.ts:126` (exactly one adjacent migration package per version). The mechanism: each version boundary is a separate package (`session-format-v3-to-v4`) that declares its codecs in its manifest; the generator validates that there is exactly one edge per version, that the chain ends exactly at the current writer, and that each edge's `sourceCodec` continues the previous edge's `targetCodec`; then it emits *static* imports so a v0 session can be read without any plugin being mounted. **Why it transfers:** this is the session-format/versioning design August would want for its own persistence. Two pieces transfer directly: (a) a version boundary is a **package with a manifest**, not a `switch` statement, so it can be versioned and published independently; (b) the migration chain is validated by a generator that refuses a gap or a non-continuing codec, rather than by the runtime when it fails.

- **Make the failure of a batch migration a structured, grouped report rather than a log line** — `scripts/migrate-sessions-to-v4.ts:60` (`summarizeFailures`) and `scripts/migration-failure-summary.ts:23` (`classifyMigrationFailure`). The mechanism: failures are classified into a **closed** reason vocabulary (`unexpected_member`, `unknown_event`, `sequence_gap`, `source_changed`, `write_locked`, `unsupported_input`, `corrupt_log`, `other`) by matching the diagnostic text, and the report groups them while retaining each input's own diagnostic. The docstring states the boundary: "classification never changes migration admission." **Why it transfers:** this is the shape an August tool-failure report should take. A model that sees "seven sessions failed" learns nothing; a model that sees "three failed with `sequence_gap`, two with `write_locked`, one `unknown_event`" can act. And the rule that classification must not gate admission is what keeps the reporter from becoming a new way to lose data.

- **Defer the inputs that lost a race, and retry them exactly once after the initial pass drains** — `scripts/migrate-sessions-to-v4.ts:148` (`runMigrationJobs`). The mechanism: bounded workers pull indices from a shared cursor; a worker that hits a source-changed error returns `true` and its index is pushed to a deferred list; after every worker has settled, the deferred indices are retried **serially**, in order. An unexpected rejection drains the workers and aborts the retry pass. **Why it transfers:** this is a precise pattern for the August agent loop. A tool call that races another writer (a file being edited, a memory being updated) should not be retried blindly in parallel — defer it, let the initial pass drain, then retry once. And a genuine crash must abort the retry pass rather than silently half-finishing.

- **Refuse to trust a search that returns nothing, and require the corpus to be non-empty** — `scripts/check-workspace-constraints.ts:593` (`checkExperimentalDependencyIsolation`, where an optional bundle may be depended on only if the launcher names it) and `scripts/gen-cordis-catalog.ts:1131` (the walk backstop requiring every declared key to be rendered *or* exempted). The pattern: an allowlist with a *named* exemption for each absence, and an exemption that must be live in both directions (an exemption for something that is now rendered is an error). **Why it transfers:** in August, "the tool exists but is not advertised" and "the tool is advertised but does not exist" are the two failure modes that make a model loop. An exemption table that must be maintained in both directions is the cheapest way to keep an inventory honest.

- **Isolate the tool cache, the interpreter and the credentials of a child process from the host** — `scripts/ci-compatible-toolcache.mjs:6` (the `RUNNER_TOOL_CACHE` redirect), `scripts/primary-runtime/prepare.ts:245` (`smokePrimaryRuntime`'s credential-scrubbed environment) and `scripts/benchmark-npm-resolution.ts:375` (the stripped `npm_config_*` set). The mechanism in all three: the child's environment is constructed explicitly, not inherited by accident. **Why it transfers:** an August agent that spawns a shell tool must scrub the parent's credential-shaped variables from the child's environment. The August backend already has a precedent for this (the tool-boundary secret guard), but the *reverse* direction — not letting the agent's subprocess read the harness's own secrets — needs the same explicit-environment discipline at every spawn site.

- **Fail the build when a plugin registers fewer tools than it claims** — `scripts/gen-tool-catalog.ts:744` (`assertToolsHarvested`) and `scripts/gen-tool-catalog.ts:718` (`assertManifestComplete`, which checks the manifest against every on-disk `tool-*` package). The mechanism: the manifest is a *claim*; the runtime registration is the *fact*; the gate compares them in both directions. **Why it transfers:** the same two-direction check belongs on August's tool registry — every tool the harness advertises to the model must exist at runtime, and every tool that exists must be advertised (or explicitly withheld). The check is nearly free and catches the two most expensive agent failures: a model calling a missing tool, and a model never discovering an existing one.

## Files skipped (with reasons)

- `scripts/dependency-catalog/package-lock.json` — 344 KB / 8,539-line generated npm `lockfileVersion: 3` lockfile recording the public resolution of `@deepseek-ai/dsh`. I opened its first 12 lines and confirmed the structure (`name: dsh-dependency-catalog`, `lockfileVersion: 3`, one root dependency on `@deepseek-ai/dsh`) and read the generator that consumes it (`gen-dependency-catalog.ts`) and its spec, which assert what the file must contain. It is machine-generated npm metadata with no authored content, so it was not read line by line.
- `scripts/no-unknown-casts.baseline.json` — 116 KB / 2,127-line generated ratchet baseline mapping each source file to the SHA-256 fingerprints of its accepted unknown casts. I opened its first 12 lines and confirmed the shape (file path → fingerprint → count) and that it is machine-generated data consumed by the type-check gate. Not read line by line.
- `scripts/fixtures/office-render/color-blocks.docx` — 1,082-byte binary OOXML package (ZIP magic `50 4b 03 04`). I confirmed the binary header and the companion `office-render.py` that consumes it; the file is a one-page colour-block Word document, not text.
- `scripts/fixtures/office-render/color-blocks.pptx` — 1,787-byte binary OOXML package; the PowerPoint twin of the same fixture set, verified through the magic bytes and the render check.
- `scripts/fixtures/office-render/color-blocks.xlsx` — 2,202-byte binary OOXML package; the Excel twin, verified through the magic bytes and the render check.

## Uncertainties

- **Sixteen large source files were surveyed rather than read end to end** (read the header plus the exported-symbol scan, or their test names, instead of every line): `scripts/build-exe-for-python-sdk.ts` (622 lines), `scripts/dev-web.ts`, `scripts/gen-client-catalog.ts`, `scripts/gen-config-catalog.ts` (52 KB), `scripts/gen-cordis-catalog.ts` (68 KB), `scripts/gen-doc-graphs.ts` (84 KB), `scripts/gen-third-party-notices.ts` (43 KB), `scripts/gen-tool-catalog.ts` (46 KB), `scripts/install-lefthook.mjs` (28 KB), `scripts/local-bundle-registry.ts` (37 KB), `scripts/persistence-changes.ts` (54 KB), `scripts/persistence-schema.ts`, `scripts/project-doc-site.ts`, `scripts/publish-npm-baseline.ts` (38 KB), `scripts/release/bump.ts`, `scripts/release/families.ts`, `scripts/render-persistence-schema.ts`, `scripts/rescope-vendor.ts` (34 KB). For each I read the file's own header (which in this repository carries the design rationale) and listed its exported symbols, so the note describes what the file *is*; I did not verify the internal algorithm of every one. The per-file ledger says which files were surveyed this way.
- **The very large spec files were surveyed by their test names** (the `describe`/`it` titles with line numbers), not by reading every assertion: `ci-workflow.spec.ts` (87 KB), `client-bundle-purity.spec.ts` (28 KB), `coverage-partitions.spec.ts` (32 KB), `doc-standard.spec.ts` (25 KB), `gen-third-party-notices.spec.ts` (22 KB), `install-lefthook.spec.ts` (42 KB), `loader-volatile-update.spec.ts` (31 KB), `local-bundle-registry.spec.ts` (29 KB), `migrate-sessions-to-v4.spec.ts` (23 KB), `oxlint-contract.spec.ts` (19 KB), `persistence-changes.spec.ts` (70 KB), `persistence-formats.spec.ts` (29 KB), `persistence-releases.spec.ts` (22 KB), `persistence-schema.spec.ts` (34 KB), `project-doc-site.spec.ts` (36 KB), `release/families.spec.ts` (24 KB), `render-persistence-schema.spec.ts` (20 KB). I read the full text of every spec ≤ ~14 KB.
- **Lenses I could not cover from this shard.** The shard contains no agent loop, no tool-calling runtime, no reasoning/thinking streaming, no context-window management, and no model-provider code — the harness's `packages/llm`, `packages/core/session`, `packages/agent` and `packages/tools` trees are owned by other shards. What this shard contributes to those lenses is indirect: the persistence subsystem (`persistence-*.ts`) is the *durable* half of context management, the session-format catalog is the versioned half of session storage, and `gen-tool-catalog.ts` / `gen-client-catalog.ts` are the *inventory* halves of tool calling. I have not verified how the runtime actually uses any of it.
- **Two files I could not fully reconcile.** `scripts/build-exe-for-python-sdk.ts` imports `./verify-runtime-closure.ts`, `./typert-faces.ts`, `./ssh-helper/artifact.ts`, `./ssh-helper/probe.ts` and `./ssh-helper/native.ts`; those files are not in this shard, so I could not confirm what the closure verification actually checks. Similarly, `scripts/publish-npm-baseline.ts` and `scripts/local-bundle-registry.ts` both delegate their registry mechanics to the same `pnpmInvocation` family, but I did not read the code paths that decide a package's publish eligibility beyond the exported-symbol scan.
- **What I could not establish about CI.** `scripts/ci-workflow.spec.ts` is the only view I had of `.github/workflows/*`; I did not read the workflow YAML itself (it is not in this shard), so the spec's assertions are the only evidence I have of the pipeline's actual structure. Where the spec and my reading of the scripts disagreed, I did not resolve it.
- **A note on `scripts/attribute-chunk-bytes.mjs`.** The read tool classified this 4 KB UTF-8 JavaScript file as binary; I read it with the read-only shell `Get-Content` instead and confirmed its contents are a complete, coherent script (a VLQ sourcemap decoder with a documented usage banner). I do not know why the classifier rejected it — possibly a non-UTF-8 byte in the comment block — and I did not chase that down, because it does not affect the file's content.
