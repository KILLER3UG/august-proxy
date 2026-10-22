# deepseek-harness / dsh-scripts#2

## Shard shape

This shard is the **repository's verification and release-orchestration layer** — 171 files, all under `scripts/`. It holds five distinct families that never import each other but share one philosophy: *every claim the project makes about itself is enforced by an executable gate, and every gate is itself tested by a fixture*. (1) The **gate runner** (`run-gates.ts`, `run-oxlint.ts`, `run-web-snapshots.ts`, `run-memory-pressure-bench.ts`, `wine-windows-gates.sh`) schedules ~19 named CI aggregates over a dependency graph and owns the process-tree teardown, the worker budgets and the platform lanes. (2) The **static verify family** (~45 `verify-*.ts` files plus their specs) is a catalog of *semantic* gates — client layering, route resolution, UI i18n, JSDoc coverage, optional-dependency imports, unknown casts, no bare dispatchers, package metadata, README model-experience contracts — each one an AST or type-checker rule that would be invisible to a linter. (3) The **bilingual translation toolchain** (`translation-prompt.ts`, `translation-brief.ts`, `translation-links.ts`, `translation-pairing*.ts`, `verify-translation-*.ts`) is a self-contained mini-pipeline: a three-section model protocol, a per-section hash ledger, a locale-aware link rewriter, and a "narrowest safe update" briefing. (4) The **recorded-session corpus machinery** (`session-fixture-layout.ts`, `session-snapshot-corpus*.ts`, `smoke-python-runtime.py` and 30 golden files) is the only place where the harness's own agent loop, tool-calling and reasoning streams are exercised end to end against a mock Anthropic Messages server. (5) The **SSH-helper release chain** (`ssh-helper/*.ts`, `verify-ssh-helper-*.ts`) is a miniature, four-target, evidence-carrying release pipeline with archive-integrity, native-ABI, sandbox and real-OpenSSH acceptance gates. The connective tissue is `ts-project.ts` (a shared two-face TypeScript Program) and the `*_policy.ts` / `*_catalog.ts` companions, which turn each rule into an explicit, reviewable table rather than a heuristic.

## Per-file notes

### scripts/run-gates.ts
- Purpose: The single scheduler for every local and CI quality gate. 18 named `Mode`s (`ci-primary`, `ci-static`, `ci-coverage`, `ci-windows-complete`, `check-all`, `hygiene`, `doc-sync`, `doc-quick`, …) each expand to a `Gate[]`.
- Key abstractions: `Gate` (id, command/args, `needs`, `after`, `env`, `allowFailure`, `streamOutput`, `quick`), `GateResult`, `GateState`, `GateExecutor`/`ResultObserver` (injected so the scheduler is testable without a child process).
- Data flow: `main` → `parseMode` → `gatesForMode` → `runAggregate` → `runGates` (pure scheduler) → `runGate` (real `spawn`). Output chunks are buffered per gate unless `streamOutput` is set, in which case they are written through as they arrive.
- Non-obvious design decisions: `needs` means "must PASS"; `after` means "must SETTLE, pass or fail" (`predecessorsReady`, line 1142). The two-level dependency exists so a diagnostic can still run after a sibling fails — the Windows lane uses it to keep `built-bin-smoke` running even when `doc-graphs` failed (`run-gates.spec.ts:560`). `PROGRAM_MODE_CAP = 8` (line 96) caps the doc/hygiene aggregates because each leaf builds a full `ts.Program`.
- Edge cases / failure handling: a child that traps SIGTERM and exits zero is still recorded `aborted`, never `passed` (line 1386, `result.aborted = aborted`). A gate killed by the abort is recorded `skipped`, not `failed`, because it produced no evidence (`skippedByFailFast`, line 1130). The summary prints error + exit + signal independently so one cannot hide another (`formatGateResultReason`, line 1646).
- Surprising: `ciWorkerEnvironment` (line 215) derives a *shared* CI budget: oxlint and publint get half each, the snapshot pool gets 1, the web pool gets the whole budget, and the coverage partition count is computed as `total - max(1, floor(total/3))` so the instrumented and exempt coverage lanes split the same budget rather than each assuming the machine.

### scripts/run-gates.spec.ts
- Purpose: 1371-line spec for the scheduler.
- Key abstractions: helpers `withPnpmEntrypoint`, `withEnv`, `withPlatform`, `withNodeVersion` that mutate process-global state synchronously and restore it in `finally`.
- Data flow: builds each aggregate with a stubbed pnpm entrypoint, then drives `runGates` with a fake `GateExecutor` to assert ordering, skipping and abort semantics.
- Non-obvious design decisions: the spec asserts *policy* ("the `hygiene` aggregate must contain exactly these 20 gate ids in this order"), not implementation, so a new gate cannot be added silently.
- Edge cases / failure handling: `procStopped` (line 50) treats a Linux zombie as stopped, because an un-reaped zombie still answers `kill(pid, 0)`.
- Surprising: the tree-kill tests spawn a **detached grandchild that holds the gate's stdout write end**, so `close` stays pending after the direct child dies — the only way to prove the descendant enumeration actually reaches it.

### scripts/run-memory-pressure-bench.ts
- Purpose: Run the memory-sensitive benchmark files inside a Linux cgroup that models a 4 GB or 8 GB machine.
- Key abstractions: `MEMORY_PRESSURE_MACHINES` (`4g`/`8g`), `MEMORY_PRESSURE_FILES` (the four bench files with the largest measured RSS), `CgroupMemoryLimits`.
- Data flow: `runMemoryPressureBench` builds artifacts unconfined, then re-executes itself under `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0`; the scoped child asserts its own cgroup, runs vitest, and reports `memory.peak` + `oom_kill`.
- Non-obvious design decisions: `memoryLimitViolation` (line 85) **refuses to run** unless `memory.max` equals the modelled size, `memory.swap.max` is `0`, AND `process.constrainedMemory()` agrees — the third check exists because an ancestor cgroup can cap the process below the visible `memory.max`. A benchmark that silently ran unconstrained would produce a meaningless number.
- Edge cases / failure handling: `memory.events` must carry an `oom_kill` counter or the run throws rather than reporting a zero.
- Surprising: the report includes `defaultNodeHeapLimitMb` — the heap limit Node *derived* from the cgroup — so the number is comparable across hosts.

### scripts/run-memory-pressure-bench.spec.ts
- Purpose: 44-line spec pinning the modelled machines, the systemd scope argv, and the cgroup-violation predicate.
- Key abstractions: pure functions only; no cgroup is touched.
- Data flow: `memoryPressureMachine` rejects an unknown name; `memoryScopeCommand` is compared as an exact argv array; `memoryLimitViolation` is checked against five near-miss limit sets.
- Non-obvious design decisions: the spec asserts the *exact* `systemd-run` argv, so a change to the memory controls is a visible diff.
- Edge cases / failure handling: `swapMax: 'max'` and a `max: '8589934592'` are both rejected — a merely large cap is as wrong as no cap.
- Surprising: the spec asserts the four benchmark files **exist on disk** (`existsSync`), so renaming a bench fails the spec before the benchmark runs.

### scripts/run-oxlint.ts
- Purpose: Wrap the Oxlint CLI so one worker bound governs both of its backends.
- Key abstractions: `resolveOxlintInvocation(args, env, cpus) → { args, env }`; `isFixInvocation`; `hasOutputFormat`.
- Data flow: `main` resolves the invocation, then spawns `node node_modules/oxlint/bin/oxlint` — once for a normal run (stdio inherited), twice for a `--fix` run (first pass captured, second pass inherited).
- Non-obvious design decisions: passing `--threads` directly is an **error** (line 53: "use DSH_OXLINT_THREADS instead of passing --threads directly") because two owners of one knob is how budgets drift. `GOMAXPROCS` is set to the same number as `--threads` (line 61), since the Rust backend reads it and not the flag. In CI the tool's own default is kept unless `DSH_OXLINT_THREADS` is set; locally the repository's `defaultParallelism` budget is applied.
- Edge cases / failure handling: a signal-terminated child re-signals the parent with the same signal (`completeFrom`, line 65) so a CI step does not report a plain failure.
- Surprising: the `--fix` path runs a **second pass** because overlapping JS-plugin fixes can expose one more fixable diagnostic after the first pass (line 102).

### scripts/run-oxlint.spec.ts
- Purpose: 55-line spec for `resolveOxlintInvocation`.
- Key abstractions: pure function under test; no spawn.
- Data flow: four cases — CI default untouched, local budget applied, caller's own `--threads` passed through, and `DSH_OXLINT_THREADS` overriding.
- Non-obvious design decisions: `GOMAXPROCS` is asserted to be *rewritten* to the bound (line 30), not left at the caller's value.
- Edge cases / failure handling: `'0'`, `'-1'`, `'1.5'`, `'auto'` are all rejected as non-integers.
- Surprising: the spec asserts the *absence* of `--threads` in CI — "keeps Oxlint's own worker default in CI" is a deliberate policy, not an oversight.

### scripts/run-web-snapshots.ts
- Purpose: Run the serial browser owners before one bounded snapshot pool.
- Key abstractions: `serialFiles` (two live-owner e2e files that must not overlap), `DSH_WEB_SNAPSHOT_WORKERS`.
- Data flow: each serial file runs alone; only if all pass does the pool run with those files `--exclude`d and `--fileParallelism --maxWorkers=N`.
- Non-obvious design decisions: the serial files are excluded from the pool *by name* rather than being a separate project, so the pool's worker count is the only concurrency knob.
- Edge cases / failure handling: the worker count is validated as a positive integer **at module load** (line 11) — a bad value aborts before any browser starts; a signal-terminated child maps to exit 1.
- Surprising: the script uses `spawn` with `stdio: 'inherit'` rather than the repo's gate runner, so the browser output lands directly in the CI log.

### scripts/session-fixture-layout.ts
- Purpose: Canonical packed-row and envelope projection helpers for repository session fixtures.
- Key abstractions: `canonicalSessionFixture(content, label)`, `isPhysicalSessionFixture(path)`, `parseFixtureRows`, `renderFixture`, `projectedRowCardinality`.
- Data flow: a JSONL file is discovered via `git ls-files --cached --others --exclude-standard -- '*.jsonl'`, parsed, and re-rendered one-event-per-row without the storage `seq`/`time` envelope; the rewrite is then re-parsed and compared.
- Non-obvious design decisions: a **packed row** (`text-chunks`, `reasoning-chunks`, `tool-call-chunks`) carries N logical events, so the sequence counter must advance by the *cardinality*, not by one (`projectedRowCardinality`, line 83; `nextSeq = SessionLogOffset(nextSeq + cardinality)`, line 128). Historical generations are validated but never rewritten — `storedVersion < currentVersion` returns the source bytes unchanged (line 249), because a released generation is an immutable compatibility fixture.
- Edge cases / failure handling: the canonicalization is checked for **payload loss** (`deepStrictEqual` on the event stream, line 255) and for **idempotence** (line 259); either failure throws with the file label. `fixtureDiagnosticLine` (line 187) maps a codec error ("released Session row 3", "Session event 7", "inherited Session cut 2") back to the *physical source line* of the file a human would open.
- Surprising: `validationHeader` (line 60) rewrites `{{cwd}}` to a fixed path and defaults `delegationDepth` to 0 for v0 headers before running the strict v0 decoder — the decoder expects a modern header shape, and the fixture must not be edited to satisfy it.

### scripts/session-fixture-layout.spec.ts
- Purpose: 236-line spec for the canonical layout, plus a repo-wide census.
- Key abstractions: `historicalVersions` (every version below the current one); `FIXTURE_MESSAGE`/`FIXTURE_STREAM` fixtures.
- Data flow: each case builds a small JSONL, runs `canonicalSessionFixture`, and asserts the exact output or the exact diagnostic.
- Non-obvious design decisions: the final case (`keeps every session-format JSONL fixture projected into canonical event layout`, line 228) scans the whole repository and fails with the instruction "Run `pnpm run migrate:packed-session-fixtures`" — a gate that names its own repair command.
- Edge cases / failure handling: v0 fixtures must be preserved byte-for-byte; a v0 with a sequence gap must be rejected with the *source line* in the message; an unsupported version (99) is refused.
- Surprising: `preserves owner-restored request-header tokens in current projected fixtures` (line 119) proves that a `{{tools}}` sidecar token survives canonicalization untouched, while `parseSessionLog` later strips it — the layout gate owns envelopes only, and says so.

### scripts/session-snapshot-corpus-policy.ts
- Purpose: Retained V3 replay inputs, current-writer fixtures, and bounded older migration coverage.
- Key abstractions: `SnapshotCorpusScenarioGenerations` (a scenario's selected generations + an optional explicit `retained` manifest), `assertSnapshotCorpusPolicy`.
- Data flow: each scenario's selected versions are counted into `currentRoles` / `baselineRoles` / `retainedRoles`; a per-version coverage map is built from the retained manifests; then four independent rules are checked.
- Non-obvious design decisions: **every historical generation must be covered by a NAMED retained scenario** — v0 needs `{multi-hop, packed-row, retry-failure, shipped-profile}` and every other generation needs `adjacent-migration` (lines 27-33, 97-104). Retained roles are capped at 13 (line 26) and `baseline + current` must strictly outnumber `retained` (line 108), so the corpus cannot fossilize into a museum of old formats.
- Edge cases / failure handling: a retained generation may equal the *current* version only if it pins `retired-tools` (line 78) — a fixture that keeps a removed tool alive is explicitly allowed and explicitly labelled.
- Surprising: one generation cannot claim another edge's coverage — a v1 fixture claiming `multi-hop` is rejected (spec line 85). Coverage is per-edge, not per-file.

### scripts/session-snapshot-corpus-policy.spec.ts
- Purpose: 146-line spec for the corpus policy.
- Key abstractions: `completeV0`, `adjacent` (v1, v2), `baseline` (8 × v3), `current` (8 × current).
- Data flow: each case builds a scenario list and asserts either the accepted summary or the exact error text.
- Non-obvious design decisions: the retained-cap case computes 13 roles exactly (spec line 137), pinning the number.
- Edge cases / failure handling: `rejects future unpinned generations` and `rejects retained generation … outside released history` both assert the same "retained Session format must precede current" clause.
- Surprising: `counts baseline and current roles independently for parent v%i and child v%i` (line 42) — a scenario with two roles of different generations contributes one to each count, which is how a parent/child pair in different formats is still a majority.

### scripts/session-snapshot-corpus.corpus.ts
- Purpose: Repository-wide ownership and storage invariants for the recorded-session corpus.
- Key abstractions: `scenarios()` (parses every `snapshot.yml`), `snapshotAdapters` (the reserved `.snapshot.ts` suffix list), `referencedScenario`.
- Data flow: every corpus directory is read, its manifest parsed and its ownership checked, then the policy is applied to the owners' selected generations.
- Non-obvious design decisions: one composition/header class owns exactly **one** pinned scenario (line 118: "duplicate header pin" is an error). A borrower may point at another scenario's session file but only the *owner's selected parent generation* (line 139-141) and never through another borrower (line 138) — no chains.
- Edge cases / failure handling: a scenario declaring `session:` (borrowing) must own no session fixture at all; `input.json` is ACP-only; `stdout.expected.jsonl` must not exist outside ACP.
- Surprising: the first case reserves the `.snapshot.ts` filename suffix for recorded-session adapters and compares against an exact list (line 106) — a new `*.snapshot.ts` file anywhere in the repo fails until it is registered.

### scripts/slot-walk.ts
- Purpose: AST helpers for the client slot surface.
- Key abstractions: `SlotDeclaration`, `SlotRegistration`, `TypeDeclaration`, `ScannedFile`; `scanSlotFiles`, `slotDeclarations`, `slotRegistrations`, `standardKitMembers`, `indexExportedTypes`, `referencedTypeNames`.
- Data flow: a cheap textual prefilter (`MERGE_HEAD`, `REGISTER_HEAD`) narrows the corpus, then the TypeScript AST yields SlotMap members and `slots.register(...)` call sites; the type index supplies the owner-props and inject-face shapes.
- Non-obvious design decisions: `referencedTypeNames` (line 264) expands a contract **exactly one level**, not transitively — the stated reason is that a transitive closure "would otherwise drag the entire session model into a single slot's report". A registration whose `name` is not a string literal is skipped, because a computed name carries no catalog fact (line 190).
- Edge cases / failure handling: `indexExportedTypes` drops a name declared more than once as *ambiguous* rather than picking one (line 135).
- Surprising: the same scan doubles as its own exhaustiveness backstop because it reads every source file rather than a reachable-export closure (file header, line 6).

### scripts/smoke-python-runtime.py
- Purpose: Keyless full-turn and snapshot smoke for the Python SDK runtime (3110 lines, 16 scenarios).
- Key abstractions: `MockModelHandler` (a `ThreadingHTTPServer` that speaks the Anthropic Messages SSE protocol), `completion_chunks(body)` (a state machine over the request history), `MockModel` (context manager), `RuntimePeer` (a JSON-RPC-over-stdio driver), and the snapshot builders `build_*_snapshot_files` / `compare_snapshot_files`.
- Data flow: a scenario creates a temp root, writes a Cordis profile patch, drives `DeepSeekHarness.run(...)` against the mock model, then projects the RunResult, the SDK notifications and the persisted session logs into normalized golden files and compares them.
- Non-obvious design decisions: the mock asserts on the *request* as well as the response — `assert_advertised_tool(body, "todo_write")` (line 348), `advertised_tool_names(body) != {"run_code"}` in PTC mode (line 458), and the tool-removal case asserts the addition-only request **no longer advertises** the removed tool (line 399). The scheduler-recovery scenario asserts the exact `is_error` sequence `[False, True, True]` across three tool results (line 363) and that the *unstarted* third call was never dispatched (spec/line 1896 in the golden) — i.e. the goldens pin tool-call reliability, not just output text.
- Edge cases / failure handling: `safe_turn_end` (line 1218) projects a live-provider failure down to `{turn, reason.kind, error.code, error.status}` so a credential-bearing message never reaches the log. `assert_installed_wheel_environment` (line 1077) refuses to run outside a virtualenv, with `PYTHONPATH`/`DSH_RUNTIME_MODE` set, from inside the repository, or with mismatched SDK/runtime versions.
- Surprising: the advanced snapshot asserts the **PTC dispatch identity triple** `(rootCallId, parentCallId, subCallId)` and that the PTC binding schema never entered the SDK wire (line 1710) — a sub-call is expected to be distinguishable from its parent by id alone. The `minimal` scenario's golden pins the *entire* model-visible surface (system prompt + tool schemas + messages) so a plugin that contributes an unintended system section cannot pass unnoticed.

### scripts/snapshot-shell-path.ts
- Purpose: Exact recorded shell-command path translation; execution and reported outcomes remain real.
- Key abstractions: a Cordis plugin (`name`, `inject = ['shell']`, `apply(ctx, config)`).
- Data flow: `ctx.effect` swaps `shell.execute` for a wrapper that rewrites the path only when the command string matches the recorded one exactly, and restores the original on dispose.
- Non-obvious design decisions: the rewrite happens **after** tool logging and approval (i.e. the policy layer sees the recorded path), and the live path is single-quoted with `'"'"'` escaping so a path containing a space and a quote still works.
- Edge cases / failure handling: a command that merely *contains* the recorded path is not rewritten, so a near-miss keeps its real exit code.
- Surprising: the plugin uses `oxlint-disable-next-line typescript/unbound-method` to preserve method identity for restoration — an unbound-method lint would otherwise force an arrow wrapper that breaks `this`.

### scripts/snapshot-shell-path.spec.ts
- Purpose: 42-line POSIX-only spec for the shell-path fixture.
- Key abstractions: a real `Context` with `LocalSubprocessRuntime` and `LocalBashExecutor`.
- Data flow: run the exact command, assert the live file's bytes; run a near-miss and assert its exit code 7 survives; dispose the plugin and assert the original behaviour returns.
- Non-obvious design decisions: the spec asserts the *restoration* path, not only the translation — disposal must put the shell back.
- Edge cases / failure handling: the fixture's live path contains both a space and a quote, which is the case a naive rewrite breaks.
- Surprising: the file it writes (`/fixture/recorded.txt`) does not exist; only the command *string* is matched.

### scripts/snapshot-spill-locators.ts
- Purpose: Fixture-only logical locators for filesystem and subprocess reads of real spill files.
- Key abstractions: a Cordis plugin injecting `['spillStore', 'fs']`; `Config { root, locatorRoot }`.
- Data flow: `store.saveText` records the physical→logical mapping and returns the logical locator; `fs.resolve` and `fs.processPathFromHostPath` translate back.
- Non-obvious design decisions: the returned logical locator keeps the *recorded* length (so preview budgets and truncation limits do not shift between runs) while the physical file stays private to the run. `mappedPath` throws "snapshot spill locator was not saved by this run" for any unmapped path under the locator root — a fixture can never read another run's spill.
- Edge cases / failure handling: the backend is checked to have returned a locator *inside* the live root (line 46) before it is translated.
- Surprising: `fs.resolve` returns `{ ...target, displayPath: path }` — the *display* path stays the recorded one while the process path stays physical, so the transcript shows the recorded value and the shell still works.

### scripts/snapshot-spill-locators.spec.ts
- Purpose: 72-line spec for the spill-locator fixture.
- Key abstractions: two concurrent `Context`s, each with its own `LocalSpillStore` and `LocalFileSystem`.
- Data flow: both runs save the *same* logical path concurrently (in either allocation order) and the spec asserts the physical paths differ while the locator lengths match.
- Non-obvious design decisions: the `reverseAllocation` parameter exists to make the allocation order race, because a fixture that only works in one order is a fixture with a lock.
- Edge cases / failure handling: after disposal the real fs behaviour returns (`processPath` no longer maps, `stat` is undefined).
- Surprising: `expect(runs[0]?.locator.length).toBe(runs[1]?.locator.length)` — equal *lengths*, not equal strings, because the two runs must produce interchangeable recorded paths.

### scripts/snapshot-workspace-parent.ts
- Purpose: Workspace placement for snapshots that must not inherit temporary-directory write grants.
- Key abstractions: `outsideTempWorkspaceParent(tempRoot, home)`, `assertWorkspaceOutsideTemp(cwd)`.
- Data flow: the parent of the temp dir is checked for writability; the allocated workspace is then checked against `writableRoots({ mode: 'workspace-write', workspaceRoot: '/tmp' })`.
- Non-obvious design decisions: home is the fallback when the temp parent is the system temp itself, a filesystem root, inside `/tmp`, or not writable (EACCES/EPERM/EROFS) — a snapshot that lives in an automatically-writable directory would not be testing the write fence it exists to test.
- Edge cases / failure handling: `canonicalPath` resolves symlinks before comparison, so a symlink alias into the temp root is still rejected.
- Surprising: the check compares against the *sandbox policy's* own `writableRoots`, not a hard-coded list — the gate and the policy cannot drift.

### scripts/snapshot-workspace-parent.spec.ts
- Purpose: 78-line spec for workspace placement.
- Key abstractions: a real `Context` with `SessionProjectionRegistry`, `SandboxPolicyService` and `SandboxedFileSystem`.
- Data flow: allocate a workspace, assert the sandbox permits a write inside it and denies a sibling write with `FS_SANDBOX_DENIED`.
- Non-obvious design decisions: the spec is skipped on Windows and as root, because "Windows directory permissions and root bypass do not enforce POSIX write bits" — the oracle would be meaningless there.
- Edge cases / failure handling: the file header says "Host disk exhaustion is not simulated: placement and the real write fence are the regression oracles" — the spec refuses to mock the thing it is testing.
- Surprising: it asserts `(await stat(workspace)).dev === (await stat(temporary)).dev` — the workspace must be on the *same device* as the temp root, so a rename-based cleanup cannot cross a filesystem boundary.

### scripts/snapshot-http-fixtures.spec.ts
- Purpose: Spec for the snapshot HTTP fixtures (a fake `node:http` server).
- Key abstractions: `FixtureServer extends EventEmitter` with a manual `finishListening(port)`; `applyLoopbackServerEffect`.
- Data flow: `vi.mock('node:http')` replaces `createServer`; the fixture plugin asks the server to listen on a fixed port and the spec releases it.
- Non-obvious design decisions: the fake server exposes `unref`, `closeAllConnections` and `address()` because the real code path under test calls all three.
- Edge cases / failure handling: the spec pins the exact recorded endpoint `http://127.0.0.1:43118/anthropic/v1/messages`.
- Surprising: the recorded port is a *constant* in the golden, so a fixture that binds an ephemeral port would silently change the expected output.

### scripts/session-query-spill-command.spec.ts
- Purpose: POSIX-only spec for the spill-resolving shell command.
- Key abstractions: a real `Context` with `LocalSpillStore`, `LocalFileSystem`, `LocalSubprocessRuntime`, `LocalBashExecutor`, plus the `snapshot-spill-locators` plugin and the snapshot's own `resolve-spill-command.mjs` adapter.
- Data flow: save a spill, resolve its logical locator, run the recorded `grep` command through the real shell.
- Non-obvious design decisions: the temp directory is named `query-spill-'quoted-` — it deliberately contains a single quote, because the command embeds the locator in a double-quoted shell variable and the locator may contain a quote.
- Edge cases / failure handling: an ordinary command keeps its real exit code 7; an unmatched command keeps its real error; a deleted physical file yields a non-zero exit; after the adapter is disposed the original error mentioning the recorded locator reappears.
- Surprising: the assertion is `expect(spec.command).toBe(command)` — the *resolved spec* must be unchanged; the translation happens at execution, not at resolution.

### scripts/ssh-helper/artifact.ts
- Purpose: Versioned archive metadata and file integrity checks for SSH helper releases.
- Key abstractions: `artifactManifestSchema` (zod, `.strict()`), `runtimeReportSchema`, `payloadFiles`, `fileDigest`, `verifyPayload`, `SSH_HELPER_TARGETS`.
- Data flow: `verifyPayload` parses `manifest.json`, enumerates the payload, compares the inventory, then checks each file's SHA-256 and permission bits.
- Non-obvious design decisions: `payloadFiles` **refuses a symlink or any non-regular file** (line 50) and excludes `manifest.json` from the inventory, so the manifest's own digest is not self-referential. `payloadPath` rejects absolute paths, backslashes, NUL and any `.`/`..` segment.
- Edge cases / failure handling: missing, duplicate, undeclared and altered files all produce distinct, specific errors; the payload must contain `dsh-ssh-helper` and `native/system/package.json`.
- Surprising: the file **mode** is part of the digest contract, so a release cannot be re-packed with different permissions.

### scripts/ssh-helper/artifact.spec.ts
- Purpose: 117-line spec for the artifact layer.
- Key abstractions: `fixture()` builds a real tar.gz with a manifest; `onTestFinished` cleans the temp tree.
- Data flow: each case mutates the fixture (alter a byte, add a file, duplicate an entry, add a symlink, use an unsafe path) and asserts the exact error.
- Non-obvious design decisions: the symlink case asserts that `payloadFiles` rejects it *before* extraction and that `extractHelper` rejects the archive entry.
- Edge cases / failure handling: five unsafe manifest paths are rejected (`../outside`, `/absolute`, `a/../b`, `a\b`, `a//b`).
- Surprising: `macosDeploymentVersions` is tested against a `otool -l` dump that contains BOTH `LC_VERSION_MIN_MACOSX version 11.0` and `LC_BUILD_VERSION minos 14.0` — the gate must read the OS requirement and ignore a linked library's `current version 1311.100.3`.

### scripts/ssh-helper/native.ts
- Purpose: Inspect every native payload, including modules embedded in the executable.
- Key abstractions: `macosDeploymentVersions(output)`, `verifyNativePayload(directory, target)`.
- Data flow: each payload file's first four bytes are read and matched against ELF and Mach-O magics; ELF files go through `readelf --file-header` and `--version-info`, Mach-O through `lipo -verify_arch` and `otool -l`.
- Non-obvious design decisions: the Mach-O scan tracks the *current load command* so a `minos` line is only read under `LC_BUILD_VERSION` and a `version` line only under `LC_VERSION_MIN_MACOSX` — a linked library's `current version 14.0` is not an OS requirement.
- Edge cases / failure handling: a file that is neither ELF nor Mach-O is skipped (it is a JS asset); a file of the wrong family for the target is an error; every `GLIBC_x.y` symbol must be ≤ 2.28.
- Surprising: the GLIBC check scans `--version-info` for *every* versioned symbol, not the file's declared minimum — a library that merely links a newer symbol would fail, which is the conservative and correct choice for a shipped binary.

### scripts/ssh-helper/probe.ts
- Purpose: Short handshake against an actual executable, with bounded process ownership.
- Key abstractions: `probeHelper(executable, workspace)`.
- Data flow: spawn the helper with `NODE_OPTIONS=--disable-sigusr1`, open an `SshRpcPeer` over its stdio, send `hello` then `close`, and wait for the process to exit.
- Non-obvious design decisions: the child is spawned with an *empty argv* and the workspace is passed inside the `hello` request, so the probe exercises the same wire the real consumers use.
- Edge cases / failure handling: a 30 s `SIGKILL` force-kill and a 20 s `AbortSignal.timeout` on the RPC; stderr is kept to the last 8 KB and included in the error, so a failed handshake says why.
- Surprising: `void closed.catch(() => {})` — the close promise is drained eagerly so it cannot become an unhandled rejection while the RPC is in flight.

### scripts/ssh-helper/worker-probe.ts
- Purpose: Run the embedded worker while macOS denies access to the checkout and host Node.
- Key abstractions: `probeRestrictedWorker(executable, workspace, home, checkout, hostNode)`.
- Data flow: a Seatbelt profile denies `file-read*` and `process-exec` for the checkout and host Node; the child is started under `/usr/bin/sandbox-exec` with `PATH=/usr/bin:/bin`, and a `JsonChannel` carries a PTC program that tries to read both denied paths.
- Non-obvious design decisions: the probe asserts `result.env` **deep-equals `[]`** (line 59) — the worker must boot with an empty environment, not merely a filtered one.
- Edge cases / failure handling: the denial codes must be exactly `EPERM` or `EACCES` (the zod enum), and both paths must be denied.
- Surprising: the program is delivered as *source text over the control channel* (`code: …`) rather than a file, so the check is about the runtime's confinement, not about a file's permissions.

### scripts/ssh-helper/release.ts
- Purpose: Require four complete, same-commit executable reports before publishing release assets.
- Key abstractions: `reportSchema`, `coreChecks` (7 mandatory runtime checks), `prepareSshRelease(directory, version, commit)`.
- Data flow: for each of the four targets: verify the archive digest against its `.sha256`, extract it, verify the payload, assert `target`/`version`/`commit`/`dirty === false`, then load the target's evidence report and assert the required checks are present.
- Non-obvious design decisions: Linux targets need **two** extra reports (`.ssh.json` with `target-has-no-node` and `glibc 2.28`, and `.landlock.json` with `expectedBackend: 'landlock-run'`), and macOS targets need `restrictedWorker: true`; `concurrentColdStarts` must be exactly 2 and `readonlyInstall` true.
- Edge cases / failure handling: the archive digest is compared with `assert.equal`, so a mismatch aborts before extraction; the temporary extraction directory is removed in a `finally`.
- Surprising: `dirty: false` is asserted — a release artifact may not come from a dirty checkout — and the `SHA256SUMS` file is written from the digests *just verified*, not from the sidecar files.

### scripts/test-dom-environment.ts
- Purpose: Initial resize delivery from jsdom's modeled offsets.
- Key abstractions: `TestResizeObserver implements ResizeObserver`.
- Data flow: `beforeEach` installs the polyfill only if `ResizeObserver` is undefined; `afterAll` restores the original descriptor.
- Non-obvious design decisions: the observer delivers **one** initial resize per observed target, from `offsetWidth`/`offsetHeight`, and re-observing the same target is a no-op — the same contract a browser provides.
- Edge cases / failure handling: the `installed` flag means a suite that provided its own observer is not disturbed, and `vi.unstubAllGlobals` can restore the default.
- Surprising: the header says "geometry/timing suites supply their own observers" — the default is deliberately minimal so it cannot mask a layout bug.

### scripts/test-fixture-cleanup.ts
- Purpose: Junction-safe fixture cleanup for Windows.
- Key abstractions: `unlinkFixtureLinks(path)`, `removeFixtureSafely(path)`.
- Data flow: walk the tree, `lstat` each entry, `unlink` every symlink/junction, then `rmSync` with `maxRetries: 50, retryDelay: 200`.
- Non-obvious design decisions: the file header states the mechanism — "Windows recursive deletion — both Node's `rmSync` and Git's `worktree remove` — follows MOUNT_POINT junctions into their targets and would delete the repository's own directories", while POSIX `unlink`/`rm` already remove symlinks without following them. The 10-second retry window covers Windows' asynchronous handle release.
- Edge cases / failure handling: `ENOENT` during the walk is ignored (a concurrent delete), and the retry is bounded so `afterEach` can never pin.
- Surprising: this is a *data-loss* guard, not a test helper: the fixtures junction the REAL `scripts/` and `node_modules/` directories.

### scripts/test-non-loopback-address.ts
- Purpose: Address probes for concrete-bind integration cases.
- Key abstractions: `probeBindableAddress(candidates, description)`, `probeNonLoopbackIpv4()`, `probeZonedLoopback()`.
- Data flow: enumerate `os.networkInterfaces()`, then for each candidate actually `listen` on port 0 and `close`, because interface membership does not guarantee a usable address.
- Non-obvious design decisions: IPv6 candidates are built as `::1%<scopeid>` from the numeric scope id, not the interface *display name* — display names are not portable zone identifiers.
- Edge cases / failure handling: when nothing binds, the function returns `undefined` and logs *why* (the host reports none / each refusal's message) so the skipped coverage is explained rather than silent.
- Edge cases: a link-local IPv6 candidate is never substituted for `::1`, because these scenarios need the loopback address itself.
- Surprising: a failed `listen` owns no socket, so the catch branch does not call `close`.

### scripts/test-non-loopback-address.spec.ts
- Purpose: 57-line spec for the address probes.
- Key abstractions: `vi.mock('node:os')` and a hand-written `vi.mock('node:http')` whose `createServer` returns a controllable fake.
- Data flow: each case sets the fake's behaviour (bind ok / bind refused) and asserts the probe's result.
- Non-obvious design decisions: the spec mocks `node:http` because "The regression concerns OS interface metadata, not the test host's IPv6 availability".
- Edge cases / failure handling: a refused bind must produce `undefined` and a `console.info` line.
- Surprising: the mocked interface uses the display name `'Loopback Pseudo-Interface 1'` — the spec proves the *display name is not used* for the zone id.

### scripts/test-proxy-environment.ts
- Purpose: Remove the machine's proxy configuration from every Vitest process.
- Key abstractions: `PROXY_ENV_NAMES` (imported from the resolver's own policy module), `clearAmbientProxyEnv(env)`, `vitestConfigFiles()`, `TEST_PROXY_SETUP_FILE`.
- Data flow: the module deletes every proxy name from `process.env` at import time; the Vitest config list is discovered by glob so a config that gains a setup file cannot escape.
- Non-obvious design decisions: the names come from the *resolver's* own list rather than a second copy, so the gate and the resolver cannot disagree. The file header explains the failure mode concretely: "a request meant for a local fixture server is sent to a proxy that cannot resolve the fixture's hostname, and the proxy's error page is recorded as the expected output."
- Edge cases / failure handling: `NODE_USE_ENV_PROXY` is named as the one that *resists* clearing, because Node samples the proxy environment at process start and a setup file cannot unbind the already-configured built-in `fetch`. The limit is stated rather than papered over.
- Surprising: the real-API e2e lane is cleared too — before proxy support existed every request connected directly and that suite passed, so a direct connection is the environment it is known to work in.

### scripts/test-proxy-environment.spec.ts
- Purpose: 44-line spec for the proxy setup.
- Key abstractions: `declared` — the Vitest configs that declare a `setupFiles` array, read with a regex.
- Data flow: one case checks the clearing behaviour; the rest check the *wiring* over every config that has a setup slot.
- Non-obvious design decisions: the spec explicitly notes that a runtime assertion would be vacuous ("importing the module above already ran it") — so the real test is that every config that declares a setup includes this one.
- Edge cases / failure handling: the discovery itself is guarded ("a glob that stopped matching would make every case below vacuous") — the expected config list is pinned exactly.
- Surprising: the file says the *web* suites carry no `setupFiles` today, so a hand-written list would have been a false guarantee.

### scripts/tests/ci-master-platforms.spec.ts
- Purpose: Scheduling policy for post-merge native runtime carriers and Wine.
- Key abstractions: the workflow YAML loaded with `js-yaml` and evaluated with `node:vm` (so `runInNewContext` can evaluate the job's `if:` expression).
- Data flow: reads `.github/workflows/*.yml`, extracts each job's `if`/`uses`/`needs`, and compares them against `gatesForMode` from the gate runner.
- Non-obvious design decisions: the CI *policy* is tested in the same process as the gate graph, so a renamed gate id and a workflow that references it fail together.
- Edge cases / failure handling: the master-push condition is pinned as the exact string `"github.event_name == 'push' && github.ref == 'refs/heads/master'"`.
- Surprising: evaluating the workflow's `if` in a VM avoids a YAML-expression library while still testing the real expression.

### scripts/tests/ci-release-selfhosted.spec.ts
- Purpose: Release rehearsal routing and persistent-runner isolation, without executing release builds.
- Key abstractions: `selfhosted` vs `hosted` runner labels; `concurrency` group shape.
- Data flow: reads the release workflow YAML and asserts job routing, runner labels and concurrency.
- Non-obvious design decisions: the file header says "without executing release builds" — the spec inspects the *declaration*, never the effect.
- Edge cases / failure handling: `cancel-in-progress` is asserted, so a superseded release run cannot occupy the persistent runner.
- Surprising: the repository name is written literally in the spec, which is exactly the kind of reference `verify-repository-references.ts` polices elsewhere.

### scripts/translation-prompt.ts
- Purpose: Executable renderer and response parser for the committed documentation-translation prompt contract.
- Key abstractions: `TRANSLATION_PROMPT_PLACEHOLDERS` (`source_lang`, `target_lang`, `terminology`), `TranslationRequestInput`, `TranslationResponse` (three sections), `renderTranslationPrompt`, `renderTranslationRequest`, `renderTranslationResponse`, `parseTranslationResponse`, `consumeTranslationResponse`.
- Data flow: the template body is sliced out of the committed `docs/i18n/translation-prompt.md` between `## 模板正文` and a four-backtick fence; placeholders are substituted; the response is parsed into three sections and the target language switcher is corrected.
- Non-obvious design decisions: the response protocol is **three sections that must appear exactly once and in order**, and content outside the sections is an error (line 215). Delimiter lines inside a Markdown body are escaped with a leading backslash (`escapeResponseBody`/`unescapeResponseBody`), so a body can legitimately contain `</translation>`. A fenced ```` ```xml ```` wrapper around the whole response is tolerated, because some models copy it from the prompt's own example.
- Edge cases / failure handling: the template is rejected if it contains an unknown placeholder, a missing required placeholder, or a malformed `{{`/`}}` delimiter. `translationFiles` rejects a source filename that contradicts the direction (a `.zh.md` declared as English) and rejects a path that is not a basename.
- Surprising: the **filename context is kept outside the model request** and the switcher is corrected after parsing (line 258) — the model never has to produce a path, so it cannot invent one.

### scripts/translation-prompt.spec.ts
- Purpose: 234-line spec for the prompt-v7 content and the three-section protocol.
- Key abstractions: `retainedExamples` — 11 golden English/Chinese example fragments that must remain in the prompt.
- Data flow: renders the real committed prompt in both directions and asserts the rendered text; then round-trips the response protocol.
- Non-obvious design decisions: the spec asserts *content* of the prompt ("states the selected v7 safeguards"), so a rule cannot be dropped from the prompt without a spec change.
- Edge cases / failure handling: a duplicate section, a missing section, an unterminated section and stray trailing content are all rejected with distinct messages; a frontmatter with no closing `---` is rejected before the switcher is inserted.
- Surprising: the spec pins the *escaping* round-trip (`round-trips wrapper-tag lines inside Markdown bodies`, line 134) and then asserts that un-escaping a delimiter produces a "duplicate `<translation>`" error — i.e. the escape is load-bearing.

### scripts/translation-prompt.expected.spec.ts
- Purpose: Runnable keyless snapshot for the assembled translation request and consumed response.
- Key abstractions: `DSH_SNAPSHOT === 'record' | 'refresh'` selects write mode; `toMatchFileSnapshot`.
- Data flow: spawns `verify-translation-prompt.ts --snapshot` as a child process, parses its stdout as JSON, and file-snapshots it.
- Non-obvious design decisions: the snapshot is produced by running the real CLI, not by calling the library, so the committed golden covers the process boundary too.
- Edge cases / failure handling: `maxBuffer: 4 * 1024 * 1024` because the prompt is large; `stderr` must be empty.
- Surprising: the file is still named `translation-prompt.expected.spec.ts` although the prompt itself is v7 — the *protocol* is v4 and the file name tracks the protocol.

### scripts/verify-translation-prompt.ts
- Purpose: Verify that the committed translation prompt renders and parses as documented.
- Key abstractions: `documentedTranslationPromptPlaceholders` (reads the prompt's own contract table).
- Data flow: reads the prompt, the terminology table, three synthetic example pairs and a recorded response; renders both directions; parses the prompt's own embedded example; round-trips a response; assembles a request; consumes the recorded response.
- Non-obvious design decisions: the examples are **synthetic fixtures**, not live documents, because "editing a paired document must not churn the prompt snapshot" (line 27) — the prompt golden is decoupled from the doc corpus.
- Edge cases / failure handling: the documented placeholder table must match the code's list exactly; the consumed response must keep frontmatter and receive the canonical target switcher.
- Surprising: the file's `try/catch` prints a single-line error and exits 1, so a broken prompt produces a readable message rather than a stack trace.

### scripts/translation-brief.ts
- Purpose: Pure assembly of the minimal-update briefing for one out-of-sync translation pair.
- Key abstractions: `MarkdownSpan` (a block-level span with a *language-neutral* `kind`), `markdownUnits`, `sectionSpans`, `spansAligned`, `changedSpanIndices`, `computeMechanicalUpdate`, `parseTerminologyRows`, `termOffsets`, `firstOccurrenceContext`, `BriefScope` (`mechanical` | `units` | `sections` | `document`).
- Data flow: both documents are parsed with mdast into aligned span lists; the changed indices are computed; a code-only change is spliced mechanically; otherwise bundles of (confirmed source, current source, current counterpart) are rendered into a Markdown briefing.
- Non-obvious design decisions: **four granularities, narrowest first** — a change confined to fenced code needs no translation judgment at all, because fences are byte-identical across a pair, so the updated fences are spliced into the counterpart directly (`computeMechanicalUpdate`, line 193). A section's `kind` is `section:<depth>` only: heading *text* is translated across a pair and therefore cannot participate in cross-language alignment (line 125).
- Edge cases / failure handling: `termOffsets` matches English word-like terms on word boundaries and accepts plural inflections (`agent` → `agents|agenties` for `-y` endings) while other terms match as case-insensitive substrings; a term moved across spans pulls BOTH the old and the new span into the briefing, because the 首次出现 annotation travels with the first occurrence (line 316).
- Surprising: `fenceFor(body, mark)` (line 340) computes the smallest fence that safely wraps the body, so a briefing containing a fenced block cannot break its own fences.

### scripts/translation-brief.spec.ts
- Purpose: Regression spec for the minimal-update briefing assembly.
- Key abstractions: pure functions over a small `DOC` fixture.
- Data flow: each case asserts the span list, the alignment decision, the mechanical splice result, the terminology rows or the rendered briefing.
- Non-obvious design decisions: the mechanical case asserts that a code-only change produces the counterpart **without** any translation step, and that a prose change in the same document does not.
- Edge cases / failure handling: unaligned unit lists fall back to sections, and an unalignable document falls back to whole-document with a stated reason.
- Surprising: the terminology case asserts a Chinese-target update matches the *first-occurrence* column as well as the Chinese column, and an English-target update matches only the English column.

### scripts/translation-links.ts
- Purpose: Locale-aware resolution and byte-preserving rewrites for bilingual Markdown links.
- Key abstractions: `TranslationLinkContext`, `TranslationLinkLocaleViolation`, `languageSwitcherLinkOffset`, `hasLanguageSwitcher`, `translationLinkLocaleViolations`, `rewriteTranslationLinkLocales`, `normalizeTranslationMarkdownLinkEdits`, `semanticTranslationLinkNodeTarget`.
- Data flow: a relative link is resolved against the repository, mapped to its bilingual pair, and compared with the locale the *source* document is written in; the destination text is replaced **in place** using authored source offsets.
- Non-obvious design decisions: rewrites are applied by byte range on the original text, never by re-serializing the Markdown (line 221) — the surrounding document is preserved exactly. `normalizeTranslationMarkdownLinkEdits` replaces a paired-document destination with a *semantic* target `dsh-translation-target:<path><suffix>`, so a link's meaning survives normalization even when the file name changes.
- Edge cases / failure handling: the language switcher is identified by the *authored* text pattern and skipped explicitly; a link definition referenced by a `linkReference` is visited once; the URL's query/fragment suffix is preserved across a locale rewrite.
- Surprising: `encodePathSegment` re-encodes `!'()*` as percent escapes, which `encodeURIComponent` does not — a detail that makes the expected URL byte-identical to what a renderer produces.

### scripts/translation-links.spec.ts
- Purpose: Regression coverage for locale-aware bilingual Markdown links.
- Key abstractions: a temp fixture root plus `removeFixtureSafely` from the junction-safe cleanup helper.
- Data flow: builds a small repository with paired documents and asserts the violations found and the rewritten output.
- Non-obvious design decisions: the spec imports the *production* cleanup helper rather than `rmSync`, so the fixture teardown is itself the mechanism under test elsewhere.
- Edge cases / failure handling: the switcher link itself must not be reported as a wrong-locale violation.
- Surprising: the assertions compare the full rewritten document text, so an accidental change to a neighbouring line fails — the "byte-preserving" claim is verified byte by byte.

### scripts/translation-pairing.ts
- Purpose: Pure parsing and structural helpers for the bilingual-document pairing gate; also the one home of the generated-region grammar.
- Key abstractions: `generatedRegions`, `renderGeneratedRegion`, `spliceGeneratedRegion`, `TranslationPairingManifest`, `isTranslationScopeFile`, `parseTranslationPairingManifest`, `translationPairSourcePredicate`, `pairAnchorOfArgument`, `parseTranslationPairingCliArgs`, `TranslationStructureSignature`, `translationStructureSignature`, `translationStructureDiff`.
- Data flow: the corpus is discovered by glob, filtered by the scope predicate and the manifest's exclusions, and each pair's two sides are parsed with GFM and reduced to a structural signature for comparison.
- Non-obvious design decisions: the generated-region grammar uses a **loose marker detector** (`GENERATED_REGION_MARKER_HINT`) alongside the strict parser: "any line that LOOKS like a region marker must parse as one" (line 25), so a typo'd marker is a loud error rather than unmarked text. The manifest may contain *only* `excluded` — "every in-scope document is required" (line 192), so a new document is bilingual by default.
- Edge cases / failure handling: `--write` requires either named pairs or `--all`, because "recording pairs you did not review blesses unconfirmed content" (line 270); `--cached` (index-plane) cannot be combined with `--write`.
- Surprising: `requiresSourceLanguageSwitcher` (line 310) exempts generated English sources, because a switcher there would make the *generator* stale — a switcher is a hand-authored artefact.

### scripts/translation-pairing.spec.ts
- Purpose: Regression tests for bilingual snapshots, corpus scope and structure.
- Key abstractions: the git-index helpers, the link normalizer and the record functions, all exercised over a synthetic git repository.
- Data flow: each case builds a small pair (or a small git repo) and asserts the record, the diff, or the violation.
- Non-obvious design decisions: the record is compared per *section key*, so an edit to one section does not churn the others.
- Edge cases / failure handling: a section with no remaining blocks produces no entry; a malformed record is rejected rather than partially parsed.
- Surprising: the spec imports `gitIndexPaths`/`readGitIndexBlob` to test the *index plane* — a check that must read staged bytes, not working-tree bytes.

### scripts/translation-pairing-record.ts
- Purpose: Canonical paths, section computation, parsing and rendering for bilingual pairing records.
- Key abstractions: `TranslationPairPaths`, `TranslationPairingRecord` (a `Map` of section key → `{en, zh}` hashes), `computeTranslationPairingRecord`, `parseTranslationPairingRecord`, `renderTranslationPairingRecord`, `translationPairingRecordDiff`, `normalizedTopLevelBlocks`, `isParseNeutralEdit`.
- Data flow: both sides are split at every heading into sections; each section's blocks (excluding fenced code and generated regions) are hashed with SHA-256 truncated to 16 hex; the record is written as a YAML sidecar next to the pair.
- Non-obvious design decisions: the record is **per section**, so independent edits to different sections change separate record lines and merge with Git's default text merge (file header, line 4). `isParseNeutralEdit` (line 96) proves an edit is *parse-neutral* — it only exchanges characters from `[A-Za-z0-9._/:#%-]` inside a complete, title-free destination that does not start a line — and only then are node offsets moved by arithmetic instead of re-parsing (line 125). If the proof fails, the document is re-parsed.
- Edge cases / failure handling: a mismatch in heading counts between the two sides is an explicit error naming both counts; a malformed or duplicate record entry returns `undefined` rather than a partial map.
- Surprising: `sections()` deliberately excludes fenced code and generated regions from each section's hash, because the pairing gate already requires those to be byte-identical across the pair — hashing them would create a second owner for the same fact.

### scripts/translation-pairing-git.ts
- Purpose: Git index reads owned by the bilingual pairing gate.
- Key abstractions: `gitIndexPaths(root)`, `readGitIndexBlob(root, path)`, `runGit(root, args, operation)`.
- Data flow: `git ls-files --stage -z` gives stage-zero paths and blob ids; `git cat-file blob <sha>` gives the staged bytes.
- Non-obvious design decisions: a path with more than one index entry is an error ("does not have exactly one resolved index entry") rather than an arbitrary pick, and a non-zero stage is a conflict, not a merge.
- Edge cases / failure handling: `maxBuffer: 1 << 26` for a large index; a non-zero git status becomes an error carrying stderr.
- Surprising: the whole module exists so a pre-commit hook can check the *staged* content without touching the working tree.

### scripts/translation-pairing.manifest.json
- Purpose: The explicit exclusion list for bilingual pairing.
- Key abstractions: a single `excluded` array of repository-relative paths.
- Data flow: read by `parseTranslationPairingManifest`; a directory entry must keep its trailing slash so it cannot prefix-match a sibling (the comment at `verify-translation-pairing.ts:90`).
- Non-obvious design decisions: the file lists 9 documents — generated catalogs, the Agent Note roots, the terminology table and the translation prompt itself.
- Edge cases / failure handling: an excluded document that also has a `.zh.md` or a record is an error ("this translation must not exist").
- Surprising: the manifest's own parser rejects any *other* field, so it cannot grow into a second policy surface.

### scripts/verify-translation-pairing.ts
- Purpose: Enforce complete English/Chinese pairs, matching structure and recorded per-section hashes for every in-scope document.
- Key abstractions: `parseTranslationPairingCliArgs` (`--list`, `--write`, `--all`, `--cached`), the `state` map (`ok` | `out-of-sync` | `missing`).
- Data flow: files are read from the working tree or from the Git index; pairs are anchored on the *union* of `.zh.md` files and `.i18n.yaml` records so a half-deleted pair is caught from either remnant; each complete pair is record-diffed, link-checked, region-compared, switcher-checked and structure-diffed.
- Edge cases / failure handling: an excluded document must have neither a translation nor a record; a missing counterpart is "incomplete pair — missing …"; a record that is out of sync but structurally equal is reported as "not in canonical form (re-record with --write)".
- Non-obvious design decisions: generated regions are compared **after** locale normalization, so a region that differs only in a paired-document path is accepted while any prose, ordering, code, marker or non-locale URL drift is rejected (line 283). The `--write` path refuses a pair whose counterpart is missing (loud) but *skips* a pairless source in corpus scope.
- Surprising: a named pair with no files at all still enters the source list in worktree mode so an interactive check reports it — while an *index* check accepts a complete three-file deletion.

### scripts/type-equiv-prefilter.ts
- Purpose: A text prefilter that lets `verify-type-equiv` skip Markdown parsing.
- Key abstractions: `mayContainEquivFence(source)`.
- Data flow: a cheap `includes` test, plus a check for a fence line containing `&` or `\`.
- Non-obvious design decisions: the escape rule is stated precisely: "Parsing changes that text only by decoding backslash escapes and character references, so an opening line without `\` or `&` contains the word literally" — the prefilter is *provably* conservative, not heuristic.
- Edge cases / failure handling: a document with no fence at all is skipped without parsing.
- Surprising: the spec asserts the prefilter agrees with real Markdown fence parsing for `ts type&#45;equiv` and `ts type\-equiv` — the two forms that would otherwise be missed.

### scripts/type-equiv-prefilter.spec.ts
- Purpose: Spec proving the text prefilter agrees with real Markdown fence parsing.
- Key abstractions: `mayContainEquivFence` (the prefilter) and `markdownFences` (the real parser), compared through `parsesEquivFence`.
- Data flow: a table of Markdown documents — plain fences, `~~~` fences, a fence inside a blockquote, and the entity- and backslash-escaped info strings — is checked for agreement between the two.
- Non-obvious design decisions: the spec is written as a *differential* test (prefilter vs parser) rather than as a list of expected booleans, so it keeps working if the parser's fence syntax changes.
- Edge cases / failure handling: the escaped forms `ts type&#45;equiv` and `ts type\-equiv` are the two that a naive `includes('type-equiv')` would miss; the prefilter keeps those documents.
- Surprising: the escaped-`t` form `&#116;s type-equiv` is in the table too, so the prefilter's `&`-rule is exercised on a different character than the one it was written for.

### scripts/type-equiv.manifest.json
- Purpose: Maps every primary `ts type-equiv` / `ts public-api` documentation block to the source declaration it must equal.
- Key abstractions: `entries[]` of `{doc, symbol, source, augmentations?, projection?}`.
- Data flow: `verify-type-equiv.ts` reads it and enforces a 1:1 correspondence with the blocks in the Markdown.
- Non-obvious design decisions: `projection: 'public-api'` selects a body-stripped public class declaration instead of the complete one; `augmentations` names module augmentations whose members complete an interface. Paired `.zh.md` blocks are byte-identical derivatives and are checked through their unsuffixed sibling — no duplicate entry.
- Edge cases / failure handling: the file's own `comment` states the contract in prose, including "Add an entry when you add a primary source-equivalence block; remove it when you remove the block."
- Surprising: this is a documentation **equivalence contract** — the docs cannot drift from the source without a machine failure.

### scripts/verify-type-equiv.ts
- Purpose: Verify every `ts type-equiv` and `ts public-api` block against the source symbol named by the manifest.
- Key abstractions: `ManifestEntry`, `EquivBlock`, `normalizeStructure`, `normalizeJSDoc`, `stripExport`, `blockSymbol`.
- Data flow: each Markdown document in the doc-typecheck scope is scanned for equivalence fences, the named symbol is located in its source file, and the two are compared.
- Non-obvious design decisions: the comparison "ignores whitespace and non-JSDoc comments but preserves declaration structure and every original JSDoc comment" — the JSDoc is part of the contract, so a doc that drops a parameter description fails.
- Edge cases / failure handling: the scan covers the *whole* doc scope, so an unmanifested block fails as well; the prefilter keeps the scan cheap.
- Surprising: the manifest's entries are 1:1 with blocks, so deleting a documentation block without deleting its manifest entry is also a failure.

### scripts/ts-project.ts
- Purpose: Shared TypeScript Program construction for repository gates that need real cross-file symbols.
- Key abstractions: `CompilerFace` (`'host' | 'client'`), `FaceConfigs`, `TypeScriptProject` (program + checker), `repositoryConfigHost`.
- Data flow: `faceConfigs` parses `tsconfig.<face>.json` and recursively every referenced project; `loadProjectGraph` unions their `fileNames`; `TypeScriptProject` creates one program with emit-only options disabled.
- Non-obvious design decisions: the root solution is **never** seeded — "the two faces are separate graphs, and flattening host+client into one program collides the cordis Context merges" (line 44). `semanticCompilerOptions` strips `noEmit`, `composite`, `declaration`, `incremental` etc. so a program built for querying costs nothing to emit.
- Edge cases / failure handling: a config diagnostic throws with the flattened message; `sourceFile(relativePath)` throws when the file was not loaded, so a gate cannot silently query an empty program.
- Surprising: `repositoryConfigHost.onUnRecoverableConfigFileDiagnostic` throws — the repo's own gates treat a broken tsconfig as a hard failure rather than a warning.

### scripts/typert-faces.ts
- Purpose: Program faces of the repository's Typert pass.
- Key abstractions: `WORKSPACE_TYPERT_FACES = ['host']`.
- Data flow: both the Host tsdown plugin and the bundle-free `generate-typert.ts` read this list to know which faces to emit.
- Non-obvious design decisions: the file uses only erasable TypeScript syntax because "Node loads this module through type stripping from `tsdown.config.ts`" — the build config imports it at runtime.
- Edge cases / failure handling: n/a (a constant).
- Surprising: the Host face alone emits the Host-for-Client *Remote* projection; no package publishes Client reflection, so there is exactly one face to keep consistent.

### scripts/typert-workspace.fixture.ts
- Purpose: Minimal Typert workspace for specs of the bundle-free Typert pass.
- Key abstractions: `writeTypertWorkspace(root, source)`, `writeCompiledDependency(root, compiled)`, `setPublishedFiles(pkg, files)`, `TYPERT_FIXTURE_PACKAGE`.
- Data flow: writes a `tsconfig.base.json` + `tsconfig.host.json` + one package, and optionally a second package symlinked into `node_modules`.
- Non-obvious design decisions: the dependency is symlinked as a **junction** (line 93) and resolved *without* a `paths` alias, so the fixture exercises real `node_modules` subpath resolution — "or to nothing before the package compiles" (line 70).
- Edge cases / failure handling: `writeCompiledDependency(root, false)` writes the package *without* its `lib/types/types.d.ts`, so a spec can prove the generator fails loudly when a dependency is uncompiled.
- Surprising: `setPublishedFiles` exists so a spec can omit a generated file from the publish list and watch the check catch it.

### scripts/types/client-build-environment/index.d.ts
- Purpose: Build-time values that bundlers replace before client code reaches a browser.
- Key abstractions: a narrowed `process.env` with `NODE_ENV` and a `DSH_CLIENT_*` template-literal index signature.
- Data flow: consumed by the client build's type environment.
- Non-obvious design decisions: the index signature is `readonly [name: \`DSH_CLIENT_${string}\`]: string | undefined`, so a client build flag is type-checked as a *name pattern* rather than an open `string`.
- Edge cases / failure handling: every value is `| undefined`, so a client may read a flag that was never defined.
- Surprising: it declares `process` in a file that has no imports — it is a global ambient shim for the browser bundle.

### scripts/verify-agent-note-classification.ts
- Purpose: Enforce Agent Note lifecycle/class paths and dated filenames.
- Key abstractions: `walkAgentNoteTree()` (shared with the format gate).
- Data flow: the tree walk produces notes and errors; the legacy `docs/rfc(s)` roots are checked for existence.
- Non-obvious design decisions: the former homes are forbidden *by existence*, so a new note cannot "silently escape this tree" (line 13).
- Edge cases / failure handling: n/a beyond the shared walker.
- Surprising: the file is 27 lines because all the structure rules live in one shared walker — the classification and the format are two gates over one tree.

### scripts/verify-agent-note-format.ts
- Purpose: Enforce Agent Note headers, lifecycle-specific sections, alternatives and retired-marker rules.
- Key abstractions: `STATUS` (per-lifecycle status grammar), `REQUIRED` (per-lifecycle required `##` sections), `BANNED_IMPLEMENTED`, `GRANDFATHER`, `FORMAT_ADOPTED`.
- Data flow: each note is read, its fenced regions are removed, and the remaining prose is checked line by line and heading by heading.
- Non-obvious design decisions: "Format tokens inside fenced examples are not document structure" (line 45) — the fence filter runs first, so an example note in a fenced block cannot trip the heading rules. `## Alternatives considered` may be replaced by an exact grandfather comment, but only for notes dated before `2026-07-05` (line 82).
- Edge cases / failure handling: the `Status:` line must be the ONLY one in the file; the first `##` must be `## Problem`; implemented notes may not carry proposal-era headings (`## Proposal`, `## Plan`, `## Migration plan`, `## Acceptance criteria`).
- Surprising: the retired debt markers (`XXX: legacy ADR/RFC body format`) are banned by a substring scan, so the old workaround cannot creep back.

### scripts/verify-application-entrypoints.ts
- Purpose: Enforce dsh profiles as the only supported Node application launcher.
- Key abstractions: `MANIFEST_BIN_ALLOWLIST`, `EXECUTABLE_SOURCE_ALLOWLIST`, `ROOT_LAUNCHER_POLICIES`, `applicationEntrypointViolations(root)`.
- Data flow: three checks — package `bin` fields, shebang-bearing source files, and root `package.json` scripts.
- Non-obvious design decisions: "Vendor CLIs, build tools and test tools are explicit classifications rather than implicit holes" (file header): every shebang source must appear in a table with a *reason* ("test-only subprocess driver", "build-only wrapper"). A `demo:*` root script with no policy row fails.
- Edge cases / failure handling: a `dsh-direct` launcher must reference `apps/cli/src/bin.ts` and must NOT reference a package entry directly; a `dsh-wrapper` launcher must name its wrapper and the wrapper must itself launch the CLI.
- Surprising: `referencesPackageEntry` is a regex over the command string, so a launcher that reaches a package entry through a shell variable is caught too.

### scripts/verify-application-entrypoints.spec.ts
- Purpose: Spec for the entrypoint classifier over synthetic workspaces.
- Key abstractions: `fixture()` creating a temp root; `write(root, path, content)`.
- Data flow: each case writes a manifest, a shebang source or a root script and asserts the exact violation string.
- Non-obvious design decisions: the spec builds a *complete* mini-repository so the three checks can be exercised together.
- Edge cases / failure handling: cleanup runs in `afterEach` over a tracked list.
- Surprising: the root-script check is exercised by writing a `package.json` with a `demo:*` script that has no policy — the "implicit hole" case.

### scripts/verify-archived-agent-notes.ts
- Purpose: Verify and append-seal the frozen Agent Note archive.
- Key abstractions: `parseArchiveManifest`, `renderArchiveManifest`, `extendArchiveManifest`, `validateArchiveArtifacts`, `validateArchiveManifestExtension`.
- Data flow: the archive tree is enumerated (only `AGENTS.md` and `manifest.json` at the root, only regular files in kind directories); artifacts are validated; the manifest is compared against a baseline read from git.
- Non-obvious design decisions: the baseline ref is `process.env.DSH_ARCHIVE_BASE_REF ?? 'HEAD'` (line 87) — CI supplies its trusted pre-change commit, local writes compare with HEAD. The manifest is **append-only**: `validateArchiveManifestExtension` refuses a change that removes or rewrites an existing seal.
- Edge cases / failure handling: `--write` seals new artifacts and leaves existing seals untouched; without `--write`, an unsealed artifact is an error.
- Surprising: the archive is a *cryptographic* freeze — the manifest stores digests, so a retired note's bytes cannot be quietly edited.

### scripts/verify-client-domain-graph.ts
- Purpose: Enforce intra-package domain layering inside `packages/client/*/src/client/`.
- Key abstractions: a three-layer model (0 `contract/`, 1 domain directories, 2 `apply.ts`/`index.ts`).
- Data flow: every `.ts`/`.tsx` under a client package's `src/client` is scanned for relative imports; an import that crosses a domain boundary is a violation.
- Non-obvious design decisions: only `contract/` is importable by all; a domain may not import a sibling domain ("route shared API through `contract/`"); only the assembly point may import across domains. `.legacy.` files are excluded by name.
- Edge cases / failure handling: imports that leave `src/client` are governed by the package-level rules and are skipped.
- Surprising: the file explicitly positions itself as the *directory-level* complement to `verify-module-graph`, which covers package-level edges — two layers of the same idea.

### scripts/verify-client-domain-graph.spec.ts
- Purpose: 14-line spec for `resolveClientImport`.
- Key abstractions: a pure path-resolution function.
- Data flow: two cases — an import leaving `src/client` keeps its `../` form; an import between domains normalizes.
- Non-obvious design decisions: the resolver preserves leading `..` so the caller can distinguish "left the client tree" from "moved between domains".
- Edge cases / failure handling: n/a.
- Surprising: the spec is tiny because the rule is a pure function of two strings — the layering check itself is exercised against the real tree.

### scripts/verify-client-packages.ts
- Purpose: Verify client package modes and the synchronous browser module-request graph.
- Key abstractions: `ClientDeclaration` (dynamic/external/runtime-uses), `ClientPackage`, `ClientPackageFacts`, and six collectors: `collectSourcePackageUses`, `collectRuntimeSourcePackageUses`, `collectRuntimeSourceSpecifiers`, `collectLocalSourceSpecifiers`, `collectRuntimeLocalSourceSpecifiers`.
- Data flow: manifests and `tsdown` configs are read, the *runtime* (value) uses of each package are collected from the AST, and the browser request graph is compared against the declared `dsh.client` block.
- Non-obvious design decisions: the collectors distinguish a *type* use from a *value* use (`importCarriesRuntimeValue`, line 115) because `verbatimModuleSyntax` is off — a named import used only in type positions is elided and does not load anything at runtime.
- Edge cases / failure handling: `fixClientPackageManifests` repairs the manifest rather than only reporting.
- Surprising: the gate asks "can the browser load this synchronously?", which is a different question from "does this package import correctly in Node" — and the answer drives the whole browser bundle shape.

### scripts/verify-client-packages.spec.ts
- Purpose: Spec for client package modes and module requests over synthetic package fixtures.
- Key abstractions: `ClientPackage`/`ClientDeclaration` literals.
- Data flow: each case constructs a package with a declared `dsh.client` block and a source file, and asserts the violation list.
- Non-obvious design decisions: the fixture is a synthetic manifest + source, not the real tree, so the rule is tested in isolation.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec imports both the *collectors* and the *repair* function, so a manifest that is fixed is also asserted to be fixed correctly.

### scripts/verify-client-route-resolution.ts
- Purpose: Browser-face route gate: an app-owned route reachable from browser code must be document-relative.
- Key abstractions: `RouteResolutionRule` (`request-target` | `location-base` | `host-route-key` | `reference-producer`), `RouteGateFace`, `APP_ROUTE_PREFIX`, `HOST_ROUTE_KEY`, `REQUEST_CONSTRUCTORS`, `REFERENCE_FIELDS`.
- Data flow: the browser face of each client package is scanned for request constructors, `fetch`/`fetcher` callees, dynamic imports, assigned `src`/`href` properties and JSX `src`/`href` attributes; each app-owned route in one of those positions is checked.
- Non-obvious design decisions: route **keys** stay absolute pathnames (the RPC channel key, the registration path, the shared `*_PATH` constants) while the *references* the browser resolves must be relative — the separation is explicit, and the browser half must strip the leading slash (`KEY.slice(1)`). A root-absolute route binds the bundle to one mount; a relative route resolved against a `location` read rebuilds the base the served document already provides.
- Edge cases / failure handling: the rule reads inline literal fragments only, so a *composed* reference is not traced — and the header names the spec that owns that regression signal instead of pretending to cover it.
- Surprising: `REFERENCE_PRODUCERS` (the node half that composes the boot graph) is checked as a *separate face* even though no request target sees its values.

### scripts/verify-client-route-resolution.spec.ts
- Purpose: Regression coverage for the browser app-route guard.
- Key abstractions: `patterns()` and `rules()` helpers over `findRouteResolutionViolations`.
- Data flow: each case is a small source string plus the face it belongs to.
- Non-obvious design decisions: the assertions are on the *rule*, not just the pattern, so a violation reported for the wrong reason fails.
- Edge cases / failure handling: a non-app route (`/assets/x`) is out of scope and must not be reported.
- Surprising: the producer face is tested with the same finder, so the node half is governed by the same rule vocabulary.

### scripts/verify-client-ui-i18n.ts
- Purpose: Reject product UI copy embedded directly in Client source.
- Key abstractions: `COPY_ATTRIBUTES`, `COPY_NAME`, `COPY_SUFFIX`, `IMMUTABLE_LANGUAGE_TOKENS`, `LOCALE_KEY`, `UiI18nViolation`, `findUiI18nViolations`, `clientSourceRoot`.
- Data flow: every Client source file is parsed and its JSX text, copy-bearing attributes and data/helper forms are examined; only locale dictionaries may own translated text.
- Non-obvious design decisions: the gate has a *floor*: `MINIMUM_CLIENT_UI_SOURCES = 450` (line 15) — if the scanned corpus collapses, the gate fails rather than passing on nothing. `LOCALE_KEY` (a dotted identifier shape) and `IMMUTABLE_LANGUAGE_TOKENS` (`true`, `undefined`, `MB`, …) are the escape hatches that keep identifiers and units out of the report.
- Edge cases / failure handling: a literal that is a locale key or an immutable token is not copy.
- Surprising: `COPY_SUFFIX` matches `labels` and `tabs` — a `tabs` array of `{label}` objects is copy and is caught.

### scripts/verify-client-ui-i18n.spec.ts
- Purpose: Spec rejecting direct JSX copy, copy-bearing attributes, and copy in label data / helper returns.
- Key abstractions: `messages(source)` maps violations to their literal text.
- Data flow: each case is a JSX snippet; the spec asserts the exact list of offending literals in order.
- Non-obvious design decisions: a template literal in a `placeholder` is split into its literal parts, so only the static text is reported.
- Edge cases / failure handling: n/a.
- Surprising: `runningSummary="Still working"` is caught by the `*Summary` suffix even though it is not a standard ARIA attribute — the suffix rule catches bespoke copy carriers.

### scripts/verify-concrete-terms.ts
- Purpose: Reject one ambiguous origin label from maintained tracked files.
- Key abstractions: `ConcreteTermViolation`, `findConcreteTermViolations(file, source)`, `readTrackedSource`, `trackedFiles`.
- Data flow: `git ls-files -z` gives the tracked corpus; each file is read (or, for a symlink, its *target* string) and scanned for the blocked term, case-insensitively and NFKC-normalized.
- Non-obvious design decisions: the blocked term is spelled by **concatenation** (`'prove' + 'nance'`, line 10) so the gate file does not itself contain the word it forbids. `trackedFiles` asserts that the discovery still contains `AGENTS.md`, `packages/`, `docs/`, `vendor/` and the archived notes, and throws otherwise — "a scanner gate that passes on zero matches is not a gate".
- Edge cases / failure handling: `historicalSchemaRegion` exempts the checked generated region of historical schema files, because those retain the identifiers present in their pinned source.
- Surprising: a symlink is scanned by its *target path* rather than its contents, so a linked file's own copy is checked in its own place.

### scripts/verify-concrete-terms.spec.ts
- Purpose: Spec for the blocked-term policy.
- Key abstractions: `findConcreteTermViolations` and `readTrackedSource` over synthetic inputs.
- Data flow: each case passes a path and a body and asserts the exact violation list, with `line: null` for a path match.
- Edge cases / failure handling: a case scans text containing an embedded NUL, and the case-variant case asserts path, prose and identifier hits separately.
- Surprising: the blocked term is also assembled by concatenation in the spec, for the same reason.

### scripts/verify-config-source-ownership.ts
- Purpose: Gate for forbidden credential or endpoint environment inlines in shipped Cordis configuration.
- Key abstractions: `SHIPPED_CONFIG_GLOBS`, `INLINE_DENY`, `collectConfigSourceOwnershipViolations(root)`.
- Data flow: every shipped config file is scanned line by line for an inline `!!js` credential/endpoint form.
- Non-obvious design decisions: the diagnostic explains the *mechanism* it protects: "The adapter resolves `apiKeyEnv` through `ctx.credentials` and the endpoint through the environment snapshot; inlining here bypasses both ladders."
- Edge cases / failure handling: the check is explicitly "not full YAML analysis" — it is a single-line-form rule, and says so.
- Surprising: `packages/*/*/cordis.patch.yml` and `presets/*.patch.yml` are in scope, so a *bundle patch* cannot smuggle a key either.

### scripts/verify-config-source-ownership.spec.ts
- Purpose: 30-line spec rejecting an inline endpoint in a shipped bundle patch.
- Key abstractions: a temp root with one `cordis.patch.yml`.
- Data flow: one case; the exact violation string is asserted.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec asserts the *whole* message including the explanation, so the reasoning cannot be trimmed away from the diagnostic.

### scripts/verify-cordis-config.ts
- Purpose: Validate Cordis Loader entry metadata and package resolution.
- Key abstractions: `metadataFields` (`id`, `name`, `group`, `inject`, `intercept`, `isolate`), `PluginReference`, `cordisConfigFiles`, `loadCordisYaml`, `isCordisGroupEntry`, `isJsExpr`.
- Data flow: every config file is loaded, each entry's metadata is checked, and the named plugins are resolved against the owning manifest (the app's for shipped overlays, the package's for package-owned fixtures).
- Non-obvious design decisions: only `config` and `disabled` are interpolated by the Loader; "Every other entry metadata field stays static, so an expression there remains truthy data and silently changes composition" (file header). The `CHOOSER_BACKEND_PACKAGES` list (line 53) hard-codes the packages the directory-picker mounts *by runtime string* — invisible to YAML scanning — because "keyless Linux CI (which only ever resolves `browse`) hides a dropped `-native` dependency until a macOS boot".
- Edge cases / failure handling: `validateClientHalvesDeclared` (line 106) catches a browser package that composes and contributes nothing: a `packages/client` package exporting `./client` without a `dsh.client` block "never serves its bundle and no error is raised anywhere".
- Surprising: the gate validates the *preset plane* separately from the *source plane* — the same plugin can be legal in one and illegal in the other.

### scripts/verify-cordis-config.spec.ts
- Purpose: Spec for the Loader metadata contract.
- Key abstractions: `metadataExpressionErrors`, `bundlePluginDependencyErrors`, `packageTestFixtureDependencyErrors`, `packageTestPluginDependencyErrors`, `bundleManifestPaths`.
- Data flow: each case passes a synthetic entry object and asserts the diagnostic list.
- Non-obvious design decisions: the file header states the rule in one sentence: "`disabled` is the one entry metadata field whose `!!js` expression the Loader interpolates".
- Edge cases / failure handling: a `disabled` expression that does not parse is rejected.
- Surprising: the spec covers the package-test-fixture dependency plane separately, because a fixture resolves plugins from its *package* manifest, not the app's.

### scripts/verify-default-product-isolation.ts
- Purpose: Keep experimental packages outside default installations, runtime imports and shipped compositions.
- Key abstractions: `ProductIsolationResult`, `verifyDefaultProductIsolation(root)`, `EXTERNAL_KIT_PACKAGES`, `PROFILE_SOURCE`, `PRESET_PATTERN`.
- Data flow: the package inventory is built, the default roots (`apps/cli`, `apps/web`, `python/sdk-runtime`) are checked, `OPTIONAL_BUNDLES` are read from the profile source, and the composition is traversed to find every reachable package and source.
- Non-obvious design decisions: the one exception is a bundle the launcher names in `OPTIONAL_BUNDLES`: shipped for the person to switch on, selected by no shipped template, with its own dependency graph outside the default product's (file header). Each optional bundle must be a runtime dependency of `apps/cli`, declare `dsh.bundle.patch`, declare an icon or `./icon` export, and export `./locale/*.json`.
- Edge cases / failure handling: a duplicate package name throws; a missing default product root is a failure.
- Surprising: the gate reads the *authored* profile source (`packages/boot/app-boot/src/profile.ts`) rather than the built output, so it works before a build.

### scripts/verify-default-product-isolation.spec.ts
- Purpose: Regression spec for default-product isolation over synthetic manifests, presets and patch files.
- Key abstractions: `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS`, `writeFixtureFile`.
- Data flow: each case writes a manifest or a preset and asserts the failure list.
- Non-obvious design decisions: the spec constructs the profile source file itself, so the optional-bundle rules can be tested without touching the real one.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec imports the *shared* `fixture-file.ts` writer rather than re-implementing it, so fixture semantics are consistent across gates.

### scripts/verify-doc-budgets.ts
- Purpose: Enforce `wc -w`-style ceilings from `scripts/doc-budgets.manifest.json`.
- Key abstractions: `countWords` (a `wc -w` equivalent).
- Data flow: each manifest entry's file is read and its word count compared to the ceiling.
- Non-obvious design decisions: a *missing* file fails ("renamed or deleted? update scripts/doc-budgets.manifest.json in the same change"), so the manifest cannot be silently narrowed. Ceilings ratchet down with at least 5% headroom; raising one requires justification in `docs/AGENTS.md`.
- Edge cases / failure handling: an invalid (non-integer or ≤0) ceiling fails before the file is read.
- Surprising: the failure message names the *relocation-first* rule rather than merely saying "too long" — the prescribed remedy is to move the content, not to shorten it.

### scripts/verify-doc-refs.ts
- Purpose: Verify root-relative documentation paths in repo-authored TypeScript.
- Key abstractions: `DOC_REF` regex, `findReferenceViolations` (shared), `uniqueRepoFiles`.
- Data flow: every `packages/**/*.ts` file is scanned for `docs/….md` and `.agents/notes/….md` tokens, and each is checked for existence.
- Non-obvious design decisions: the token must carry the `.md` extension ("requires the extension"), and matching string literals are checked too, so a doc path in a runtime string is also validated.
- Edge cases / failure handling: built declarations, `vendor/` and any `lib/` segment are excluded.
- Surprising: `isExcludedDirectory` excludes a directory whose *second* segment is `lib` — "A non-first `lib` segment puts `/lib/` in every path below the directory, so the walker skips it."

### scripts/verify-doc-site-fragments.ts
- Purpose: Verify fragment links against the HTML emitted by VitePress.
- Key abstractions: `BrokenSiteFragment`, `SiteFragmentReport`, `inspectSiteFragments(distRoot)`, `routeFor`, `aliasesFor`, `decodedFragment`.
- Data flow: the built HTML is parsed with JSDOM, every internal fragment-bearing anchor is resolved to its route and its target page's element ids, and unresolved ones are reported.
- Non-obvious design decisions: the file header gives the reason this gate exists at all — "Markdown and VitePress use different heading-slug algorithms, so source-link validation alone cannot prove that a published fragment exists". The gate also checks that the build carries the raw-Markdown twin of every route plus `llms.txt`.
- Edge cases / failure handling: a malformed percent-encoding in a fragment preserves the literal id rather than throwing (line 68).
- Surprising: `aliasesFor` accepts `/guide/x`, `/guide/x/`, `/guide/x.html` and `/guide/x/index` as the same route, because VitePress emits several of them.

### scripts/verify-doc-site-fragments.spec.ts
- Purpose: Spec for built-site fragment validation over a synthetic VitePress output.
- Key abstractions: `inspectSiteFragments` and `missingSiteFiles` over a fixture directory.
- Data flow: each case writes a small HTML tree and asserts the report.
- Edge cases / failure handling: cleanup in `afterEach`; `<a name="legacy">` is included as an anchor.
- Surprising: the fixture includes a legacy `name=` anchor, so the gate proves it accepts both id- and name-anchors.

### scripts/verify-dsh-package-licenses.ts
- Purpose: Enforce the MIT license declaration for repository-owned DSH npm packages.
- Key abstractions: `DshPackageLicenseReport`, `inspectDshPackageLicenses(root)`, `workspaceManifestPaths`.
- Data flow: the root `package.json` `workspaces` array is expanded by glob, and every manifest whose name matches `@deepseek-ai/dsh…` must declare `"license": "MIT"`.
- Edge cases / failure handling: a non-object `workspaces` value throws with a specific message.
- Surprising: the package-name pattern is `@deepseek-ai/dsh(?:-|$)`, so `dsh` itself and every `dsh-*` are covered while other `@deepseek-ai` packages are not.

### scripts/verify-dsh-package-licenses.spec.ts
- Purpose: Spec for the MIT license check over synthetic workspaces.
- Key abstractions: `createWorkspace()` writing a root manifest plus package manifests.
- Edge flow: one case per failure mode.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the fixture builds a *workspace* rather than a flat directory, so the `workspaces` expansion itself is under test.

### scripts/verify-export-jsdoc.ts
- Purpose: Enforce JSDoc on every non-vendored package export.
- Key abstractions: `Walk` state, `isExported`, `isNonPublic`, `isStatic`, `unwrapExpression`, `callableAnnotation`, `thisReceiver`.
- Data flow: a `TypeScriptProject` program is walked; every exported function, class method, overload signature, namespace member and inline callable type is checked for a description, per-parameter documentation and a non-void return.
- Non-obvious design decisions: "Unknown forms fail closed" — a mixed callable literal returns `'refuse'` and is reported rather than skipped. `callableAnnotation` accepts a type literal with exactly one call signature, and refuses anything else.
- Edge cases / failure handling: framework slots (`Config`, `inject`, `name`, `reusable`, `apply`), constructors, inherited contracts, augmentations and source re-exports keep their docs at the declaring contract; `inheritedDocumentation` finds inherited parameter/return coverage without exempting a newly public API.
- Surprising: `unwrapExpression` peels parentheses, `as`, `satisfies`, non-null assertions and angle-bracket casts, so a wrapped function expression is still classified as function-like.

### scripts/verify-md-links.ts
- Purpose: Verify that relative Markdown links, images and definitions resolve — including `#fragment` anchors.
- Key abstractions: `markdownLinkSourcePaths`, `documentAnchors(source, tree)`, `githubSlug(heading)`, `pathPart`, `fragmentPart`, `markdownLinkCache`.
- Data flow: each authored Markdown document is parsed; every link, image and definition is resolved to a target file and, if it carries a fragment, to an anchor in that file.
- Non-obvious design decisions: `githubSlug` re-implements GitHub's algorithm (lowercase; keep letters, numbers, underscores, spaces and hyphens; spaces become hyphens) and is computed from the **rendered** heading text, so links, images, inline code and emphasis inside a heading slug the way GitHub renders them. Repeated slugs get GitHub's occupied-set `-1`, `-2` suffixes. Matching is exact — element ids are case-sensitive.
- Edge cases / failure handling: a malformed percent-escape keeps the raw path, which then reports as broken rather than crashing the gate. Scheme-qualified, protocol-relative and root-absolute targets are excluded; a pure `#frag` is checked against the source file itself.
- Surprising: underscores survive in a slug (`## Showcase: web_fetch` → `#showcase-web_fetch`), and the file explains that this deliberately differs from the generator's own region-anchor slugs, because the generator's headings always have explicit `<a id>` anchors.

### scripts/verify-md-links.spec.ts
- Purpose: Spec for source discovery and fragment validation.
- Key abstractions: `layout(files)` building a temp tree; the exported `documentAnchors`, `githubSlug`, `findViolations`, `markdownLinkCache`.
- Data flow: each case writes a small set of Markdown files and asserts the violations.
- Edge cases / failure handling: non-Markdown fragment targets and external targets stay out of scope.
- Surprising: the cache is exported and tested — the link check is a hot path over the whole corpus, and the cache's correctness is part of the contract.

### scripts/verify-md-wrap.ts
- Purpose: Reject Markdown prose paragraphs spanning multiple physical lines.
- Key abstractions: `maskVitePressStructure`, `findViolations`.
- Data flow: each file is masked (frontmatter blanked, `:::` container lines blanked), parsed with the GFM AST, and every `paragraph` node whose `position.end.line > position.start.line` is a violation.
- Non-obvious design decisions: the check "never rewrites" and dedupes symlinked instruction files. The AST distinguishes a paragraph from a multiline structural node, so a fenced block or a list is not a violation.
- Edge cases / failure handling: the fence-awareness is inherited from the parser, not from a regex.
- Surprising: the scope includes `snapshots/**/system-prompt.expected.md` — the *expected output* of a prompt snapshot is also held to the one-line-per-paragraph rule, so a prompt cannot smuggle wrapped prose into a golden.

### scripts/verify-mermaid.ts
- Purpose: Parse every repo-authored Mermaid fence with Mermaid itself.
- Key abstractions: `extractMermaidBlocks`, `formatError`.
- Data flow: the Markdown is parsed with mdast, every `code` node with `lang === 'mermaid'` is collected, and `mermaid.parse` is called on each under a JSDOM window.
- Non-obvious design decisions: `maxEdges: 2000` is raised deliberately, with the reasoning in the comment: "mermaid's default 500-edge render guard; the module graph grows with every package edge and crossed it legitimately. Raise the guard here (a secure config settable only via initialize) rather than trimming edges. The graph passed 1000 the same way it passed 500."
- Edge cases / failure handling: symlinked files are deduplicated by real path; archived notes are excluded.
- Surprising: the gate catches "syntax that link and fence checks cannot" — it is a renderer-level check, not a text check.

### scripts/verify-no-bare-dispatcher.ts
- Purpose: Verify that no package builds its own undici agent or hands `fetch` an explicit dispatcher.
- Key abstractions: `DISPATCHER_OWNER`, `ALLOW_MARKER` (`proxy-exempt:`), `AGENT_EXPORTS`, `agentBindings`, `namesAgent`, `suppliesDispatcher`, `findDispatcherViolations`, `scanRepository`.
- Data flow: each `packages/*/*/src/**/*.ts` and `apps/*/src/**/*.ts` file is parsed; the set of local names bound to an undici agent class is computed; `new <agent>` and any object literal supplying `dispatcher` are violations.
- Non-obvious design decisions: the failure it prevents is concrete — "An explicitly supplied `dispatcher` overrides that global one, so a call site that constructs `new Agent(...)` itself connects directly no matter what proxy the user configured — the exact defect `web-fetch-http` carried before proxy support existed, where its DNS-pinning agent silently bypassed every proxy." Discovery is syntax-aware because "a line-wise regex misses the `{ dispatcher }` shorthand and a `new Alias(...)` whose import renamed `Agent`". A dynamic `await import('undici')` counts the same as a static import.
- Edge cases / failure handling: a violation is excused by a `proxy-exempt:` comment **on the offending line or the line directly above it** — "because a syntax-aware match anchors on the property or `new` expression rather than the statement, and the explanation belongs above a long line." The escape is therefore greppable and reviewable.
- Surprising: a cheap textual prefilter (`sourceText.includes('undici') || sourceText.includes('dispatcher')`) runs first, and the comment records the measured cost: "Parsing the rest of the repository anyway made this the slowest gate — 21 of 1597 files survive the filter."

### scripts/verify-no-bare-dispatcher.spec.ts
- Purpose: Spec for the bare-dispatcher check.
- Key abstractions: `reasons(source, file)` over `findDispatcherViolations`.
- Data flow: each case is a source snippet; the spec asserts the list of rule names.
- Edge cases / failure handling: the owning package is exempt (`DISPATCHER_OWNER`).
- Surprising: the first case is literally the historical defect — `new Agent({ connect: { lookup } })` plus `fetch(url, { dispatcher })` — so the regression that motivated the gate is the gate's first test.

### scripts/verify-no-top-level-await.ts
- Purpose: Verify that no importable package source module awaits at module scope.
- Key abstractions: `SOURCE_GLOB`, `ExcludedEntry` (`'shebang' | 'bin'`), `binSources`, `excludedEntry`, `findTopLevelAwaits`, `scanRepository`.
- Data flow: the corpus is globbed; each file's `await` expressions, `for await` loops and `await using` declarations are located in the AST and tested against the enclosing function scope.
- Non-obvious design decisions: the reason is stated precisely — a module-scope `await` makes module evaluation asynchronous, "a rejection surfaces as a module-evaluation failure instead of an error the module handles, and the module cannot be lowered to the synchronous CommonJS wrapper the browser-worker image loads." Executables are excluded **by declaration, never by file name**: a `#!` line, or a source named by a package manifest's `bin` field (whose `lib/<path>.js` target maps back to `src/<path>.ts`).
- Edge cases / failure handling: `runsInsideScope` (line 121) is precise about a method's *computed name* and decorators, which run where the method is **defined** — so an `await` there still belongs to the module. Class static blocks are function scopes.
- Surprising: the `bin` exclusion resolves `lib/x.js` back to `src/x.ts` *and* `src/x.tsx`; a `bin` target outside `lib/` excludes nothing, because it is not a build output.

### scripts/verify-no-top-level-await.spec.ts
- Purpose: Spec for module-scope await detection.
- Key abstractions: `forms(source, file)`, `binSources`, `excludedEntry`, `sourceCorpus`, `scanRepository`.
- Data flow: each case is a source snippet; the spec asserts the detected await forms and the reported line.
- Edge cases / failure handling: the process-entry shape the rule exists for is the first test.
- Surprising: the spec exports and tests `sourceCorpus` and `scanRepository`, so the *corpus* is itself a tested artefact.

### scripts/verify-no-unknown-casts.ts
- Purpose: Reject new assertions to unknown while retiring the recorded existing assertions.
- Key abstractions: `UnknownCastBaseline` (path → fingerprint → count), `UnknownCast`, `syntaxFingerprint`, `findUnknownCasts`, `countUnknownCasts`, `verifyNoUnknownCasts(repoRoot, prune)`.
- Data flow: the tracked + untracked source corpus is scanned; each `as unknown` / `<unknown>` assertion (including an unknown member of an asserted union) is fingerprinted; the fingerprint multiset is compared against `scripts/no-unknown-casts.baseline.json`.
- Non-obvious design decisions: the fingerprint is a SHA-256 of the assertion's **syntax tokens, excluding comments and whitespace** (line 25), so the allowance is tied to the exact *shape* of the assertion, not to a file, a line, or an occurrence order. The allowance is **consumed** — `counts[cast.fingerprint] = allowance - 1` — so a file cannot launder a new assertion behind an old one, and a leftover allowance is an error requiring `--prune`.
- Edge cases / failure handling: the baseline's own shape is validated (path safety, 64-hex fingerprints, positive counts); a source symlink is unsupported and throws.
- Surprising: `scanUnknownCasts` asserts that discovery still covers `packages/`, `apps/`, `scripts/` and `website/` (line 91) — the same "a scanner gate that passes on zero matches is not a gate" discipline as `verify-concrete-terms.ts`.

### scripts/verify-no-unknown-casts.spec.ts
- Purpose: Spec for the unknown-cast baseline.
- Key abstractions: the four exported functions under test.
- Data flow: each case writes a synthetic repo with a baseline and a source, and asserts the failure message.
- Edge cases / failure handling: `--prune` is asserted to rewrite the baseline only after establishing that no new assertion exists.
- Surprising: the spec writes and then *unlinks* a symlink to prove the symlink case is a hard error rather than a silent skip.

### scripts/verify-node-next-types.ts
- Purpose: Verify that built package declarations are consumable by a standard external TypeScript ESM project using NodeNext resolution.
- Key abstractions: `workspacePackages`, `publicSpecifiers`, `linkPackage`, `relativeSpecifiersMissingExtensions`.
- Data flow: every built `.d.ts` is scanned for extensionless relative specifiers; then a temp project is created with every workspace package symlinked into `node_modules`, an `index.ts` importing every public entry point, and `tsc -p` is run against it.
- Non-obvious design decisions: tsc is invoked as `node node_modules/typescript/bin/tsc` rather than the `.bin` shim, and the reason is recorded: "the extensionless shim isn't spawnable on Windows (CVE-2024-27980) and the `.cmd` variant needs `shell:true`, which space-joins args UNESCAPED (DEP0190) — a hazard for the temp tsconfig path."
- Edge cases / failure handling: missing build outputs fail with "run `pnpm run build` first"; `skipLibCheck: true` is scoped to third-party SDK noise, with the comment that the explicit relative-specifier scan "owns our regression".
- Surprising: `preserveSymlinks: true` is set so the temp install resolves like a real consumer's.

### scripts/verify-npm-install-layout.ts
- Purpose: Verify npm's physical package placement for two incompatible DSH releases.
- Key abstractions: `MAX_RESOLUTION_WORK_UNITS` (875 000), `SECONDS_PER_WORK_UNIT` (2.6e-4), `NPM_HANG_GUARD_MS`, `SYNTHETIC_DSH_VERSIONS`, `DshInstallLayoutSummary`, `buildDualDshRegistry`, `assertDualDshInstallLayout`, `assertResolutionWorkBudget`.
- Data flow: the working release is cloned into two synthetic incompatible versions (`0.1.0`, `0.2.0`) with all internal edges re-ranged; a synthetic registry is resolved with npm; the resulting lockfile is checked for correct physical placement.
- Non-obvious design decisions: the growth criterion is **not a timeout** but a measured "resolution work unit" (packages × internal edges), because "npm's hoisted placement re-checks every internal edge against the incoming edges of its peer target … so resolution time grows with this product and not with the package count alone." The budget carries 25% headroom over the measured 699 148 units / 180.7 s, and the hang guard is *derived* from the same constant — "so a raised budget cannot silently shrink the guard's headroom."
- Edge cases / failure handling: a graph that grows past the budget fails with its own measured counts instead of failing on whichever runner happens to be slow.
- Surprising: the file records the reference host ("an idle M-series host") so a future re-measurement has a baseline to compare against.

### scripts/verify-npm-install-layout.spec.ts
- Purpose: Spec for the dual-release layout and the resolution budget.
- Key abstractions: `validLayout()` builds a synthetic `NpmPackageLock`.
- Data flow: each case asserts the layout assertion or the budget assertion.
- Edge cases / failure handling: `MAX_RESOLUTION_WORK_UNITS` is imported and asserted, so raising the constant without re-deriving the guard fails here.
- Surprising: the spec does not run npm — it tests the *layout predicate* against a synthetic lockfile, keeping the gate fast.

### scripts/verify-optional-dependency-imports.ts
- Purpose: Reject a static value import of an optional dependency.
- Key abstractions: `PUBLISHED_SOURCE`, `OptionalKind`, `packageOf`, `optionalDependencies`, `collectOptionalImportViolations`.
- Data flow: a `TypeScriptProject` program is built for each compiler face; every import of an optional dependency in a shipping `src` is classified as value or type and reported if it is a value.
- Non-obvious design decisions: value-vs-type is decided against a bound Program rather than the import syntax, "because `verbatimModuleSyntax` is off: a named import used only in type positions is elided and does not load anything." The decision is deliberately conservative in one direction — "a value binding the compiler would elide because nothing references it in a value position is still reported, and the fix it asks for … is what the published package wants regardless."
- Edge cases / failure handling: the file header states the *ordering of remedies*: import it as a type; or restructure so nothing at module scope needs the package; a dynamic `import()` "belongs to a caller that genuinely requires the package and handles its absence — it is a last resort … and reaching for it is a sign the dependency is not optional."
- Surprising: only files that ship (a published package's `src`) are subject, so a test fixture may import an optional package freely.

### scripts/verify-optional-dependency-imports.spec.ts
- Purpose: Spec for which import and re-export forms survive emit.
- Key abstractions: a `FIXTURE` map of source files; `TypeScriptProject` over the temp fixture.
- Data flow: the spec builds a tiny workspace, compiles it, and asserts which forms are violations.
- Edge cases / failure handling: the file header states the expectation explicitly — "`import type`, `import {}`, an inline `type` specifier, and a named binding that resolves to a type all disappear; a bare import, a value binding, and a star re-export remain."
- Surprising: the spec compiles the fixture with a real Program rather than pattern-matching, so it stays correct when the compiler's elision rules change.

### scripts/verify-package-dependencies.ts
- Purpose: Verify and repair npm dependency sections from published Client and Host faces.
- Key abstractions: `PackageDependencyRole` (`client-only` | `client-host` | `configured-host`), `PackageDependencyFacts`, `PackageDependencyState`, `HostRuntimeExportUse`, `PACKAGE_DEPENDENCY_POLICY`.
- Data flow: every workspace manifest is read; the *runtime* uses of each package are collected from the source AST and from the generated Host modules (via `WorkspaceTypertGenerator`); the declared dependency sections are compared with the facts and repaired.
- Non-obvious design decisions: `ROOT_TYPE_PACKAGES` (`@types/react`, `@types/react-dom`) must not be declared in workspace manifests, because "Each package-local pnpm link is one more location that TypeScript scans when it computes module specifiers for every JSX file." The workspace range is `workspace:*` for `@deepseek-ai/dsh*` and `workspace:~` for everything else.
- Edge cases / failure handling: the gate can *repair* (`fixPackageDependencies`) rather than only report, and `formatManagedRuntimeDependencies`/`formatPeerRequiredRuntimeDependencies` render the managed sections deterministically.
- Surprising: it reads the *generated* Host module graph (`writeModuleGraph`, `WorkspaceTypertGenerator`) — a dependency that only the generated code uses still has to be declared.

### scripts/verify-package-dependencies.spec.ts
- Purpose: Spec for package dependency collection, policy violations, root type-package isolation and manifest repair.
- Key abstractions: the many exported collectors, plus `PACKAGE_DEPENDENCY_POLICY`.
- Data flow: each case writes a synthetic manifest + source and asserts the violation list or the repaired manifest text.
- Edge cases / failure handling: the repaired manifest is compared as text, so formatting is part of the contract.
- Surprising: the spec asserts the *format* of the managed sections, not just their content, so a reordering of the manifest cannot slip through.

### scripts/verify-package-meta.ts
- Purpose: Validate source locale metadata, official SVG artwork, Node resource exports and publication selections.
- Key abstractions: `sourceJsonFiles`, `targetsOf`, `substitution` (the `*` pattern matcher), `published` (npm `files` semantics), `svgArtworkProblems`, `packageMetaProblems`.
- Data flow: every `*.json` under a package (excluding `node_modules`, `lib`, `tests`) is parsed; `meta` blocks, icons and resource exports are validated; the `files` list is checked with npm's own include/exclude semantics.
- Non-obvious design decisions: `substitution` reimplements Node's export-target `*` matching (including the width calculation) so the gate can resolve a resource export without loading the package. `svgArtworkProblems` is explicitly "Structural artwork conventions only; not an SVG sanitizer or a rendered-pixel check" — it requires a `<svg>` root in the SVG namespace, `width="36" height="36" viewBox="0 0 36 36"`, and at least one drawing element.
- Edge cases / failure handling: a JSON file that is not an object is `invalid`; a `package.json` with a `name` is treated as package metadata.
- Surprising: `published()` honours npm's negated `files` patterns, so a `!` entry can exclude a path the include patterns cover.

### scripts/verify-package-meta.spec.ts
- Purpose: Spec for plugin metadata checks over synthetic private source-only packages.
- Key abstractions: `packageMetaProblems`; a `validSvg` constant.
- Data flow: each case writes a package tree and asserts the problem list.
- Edge cases / failure handling: cleanup in `beforeEach`/`afterEach`.
- Surprising: the spec's `validSvg` includes a `<defs><linearGradient>` — proving the artwork check accepts real gradient artwork as long as the structural rules hold.

### scripts/verify-package-paths.ts
- Purpose: Find stale root-relative `packages/...` references in repo-authored prose and TypeScript.
- Key abstractions: `realPackageNames`, `isDriftedPackageReference`, `findPackagePathViolations`, `PKG_REF`.
- Data flow: every `packages/*/*` directory name is collected; each prose/TypeScript file is scanned for `packages/...` tokens; a token is a violation only when it does not exist AND one of its segments names a real package leaf.
- Non-obvious design decisions: this scoping is the whole point — "A missing reference is only flagged when one of its segments is in this set — that is what scopes the gate to DRIFT (a moved real package) rather than typos or not-yet-existing packages named in a proposal." A *leading* segment that is itself an existing group directory is explained by the group, not by a relocated leaf sharing its name (`client` is both the client-modules group and the sdk leaf) — so only later segments count.
- Edge cases / failure handling: the `PKG_REF` character class is plain path characters only, so a glob (`*`), a placeholder (`<`, `>`) or a brace expansion terminates the match and is never probed. Unbuilt `lib/` paths under an existing depth-two package root are exempt because CI runs this gate before the build.
- Surprising: `historicalSchemaRegion` excludes the checked generated region of historical schema files, whose identifiers belong to their pinned source.

### scripts/verify-package-paths.spec.ts
- Purpose: Spec for stale `packages/...` references.
- Key abstractions: `findPackagePathViolations` over a synthetic root.
- Data flow: a fixture creates a *current* package path and asserts that the removed path is reported and the current one is not.
- Edge cases / failure handling: the historical-schema start/end markers in the fixture source define an exempt region.
- Surprising: the fixture's "removed" and "current" paths differ only by one directory (`packages/fs/tool-present` vs `packages/deliverables/tool-present`) — the exact shape of a real package move.

### scripts/verify-package-readme-limitations.ts
- Purpose: Doc-sync gate for the canonical package-README limitations section.
- Key abstractions: `CANONICAL` heading, `NO_LIMITATIONS` (an audited exemption map), `isLimitationsLike`.
- Data flow: every `packages/*/*/package.json` is mapped to its directory; the sibling `README.md` is parsed and its headings checked.
- Non-obvious design decisions: a *drifted* heading (`## Non-Goals`, `## What is not here`, `## Deferred work`) is recognised by `isLimitationsLike` and rejected — the gate refuses a synonym. An audited package with no limitations joins `NO_LIMITATIONS` **with a stated reason**, and a stale whitelist entry (a package that no longer exists) fails.
- Edge cases / failure handling: the whitelist must name a scanned package and must justify itself.
- Surprising: the file header points at the archived Agent Note that documents the original decision — the gate cites its own history.

### scripts/verify-package-readme-model-experience.ts
- Purpose: Doc-sync gate for package README Model Experience sections.
- Key abstractions: `NO_MODEL_EXPERIENCE_SECTION` (audited model-agnostic packages), `SENTENCE_MODEL_EXPERIENCE` (packages allowed one gated sentence plus a KV-cache field), `FIELD_HEADINGS` (`#### What the model sees`, `#### Token effect`, `#### KV Cache effect`), `SentenceContract`.
- Data flow: each package README is parsed; the section's fields, the package-owned text blocks, the generated-catalog links and the final-section order are checked.
- Non-obvious design decisions: the reason an absent section is acceptable lives *in the gate* as reviewable audit evidence — "so an absent section cannot be mistaken for forgotten documentation." Every exemption carries a one-line reason naming the *owning* package.
- Edge cases / failure handling: a package moves on or off the sentence list with its context behaviour.
- Surprising: the list distinguishes `kind: 'none'` (contributes no model context at all — e.g. a terminal controller, a browser registry) from `kind: 'indirect'` (contributes through a named owner, e.g. an SSH provider that "delegates model rendering to the existing filesystem consumers"). That is a real taxonomy of "does this package put bytes in front of the model".

### scripts/verify-package-readme-summaries.ts
- Purpose: Enforce the English package README Summary entry-length limit.
- Key abstractions: `MAX_PACKAGE_README_SUMMARY_WORDS` (100), `h2Body`, `readKind`, `packageReadmeSummaryErrors`.
- Data flow: every `packages/**/README.md` is read, its `## Summary` body is extracted without consuming the next H2, and the word count is compared.
- Non-obvious design decisions: the diagnostic names the *template* to rewrite against — `.agents/skills/dsh-doc/templates/<kind>.md` — where `kind` comes from the README's frontmatter.
- Edge cases / failure handling: a missing `## Summary` is a violation; an empty scan is a violation ("no English package READMEs found; the scan is empty or narrowed").
- Surprising: the word counter is the same `wc -w` equivalent as `verify-doc-budgets.ts`, so the two gates measure identically.

### scripts/verify-package-readme-summaries.spec.ts
- Purpose: Spec for the 100-word Summary limit.
- Key abstractions: `readme(summary, kind)` builds a synthetic README.
- Data flow: each case asserts the error list.
- Edge cases / failure handling: exactly 100 words is accepted; 101 is not.
- Surprising: the `kind` frontmatter is present in the fixture because the *diagnostic* depends on it.

### scripts/verify-plugin-record-callers.ts
- Purpose: Verify that only experimental packages call `appendPluginRecord` from production source.
- Key abstractions: `RESTRICTED_NAME`, `OWNER_FILE`, `EXPERIMENTAL_PREFIX`, `unescaped(source)`, `findPluginRecordReferences`, `isAdmittedCaller`, `checkPluginRecordCallers`, `checkDeclaredPluginRecordWrites`.
- Data flow: every production source file is un-escaped and parsed; every identifier spelled `appendPluginRecord` (import, re-export, call, namespace member, destructured binding, alias source, or a string literal of exactly that name) is a reference.
- Non-obvious design decisions: the escape-awareness is the point — a spelling that escapes part of the name (`\u0061`, `\x61`, `\u{61}`, `\141`, `\a`, a line continuation) is still found, because `unescaped` (line 66) decodes hex and legacy octal escapes and drops line continuations. Production writes must name a record in the production-only `PluginRecordMap` inventory, and "test declarations cannot authorize a production write."
- Edge cases / failure handling: a wildcard `export * from` names no identifier and is not reported — but code that *calls* the function through it still names the function, and that reference is.
- Surprising: the exemption is scoped to a *prefix* (`packages/experimental/`), with the owning module and test files exempt because they exercise the operation.

### scripts/verify-plugin-record-callers.spec.ts
- Purpose: Spec for the restricted function's callers and catalogue-declared writes.
- Key abstractions: `unescaped`, `findPluginRecordReferences`, `isAdmittedCaller`, `checkDeclaredPluginRecordWrites`, `readRepositorySources`, `OWNER_FILE`.
- Data flow: each case builds a synthetic repository and asserts the references found.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec imports `readRepositorySources` so the *discovery* is tested, not only the matcher.

### scripts/verify-product-use.ts
- Purpose: Check that maintained packages have effective product use or an explicit non-default role.
- Key abstractions: `ProductUseResult` (default vs optional reachability), `Reachability`, `verifyProductUse(root, policy)`, `DYNAMIC_MOUNTS`.
- Data flow: the package inventory is built; the shipped profiles (`acp`, `web`, `headless`, `sdk`, `sdk-minimal`) and their Loader compositions are resolved (`composeEntries`, `loadOverlayPatches`, `bundlePatchPaths`); the reachable packages and source modules are collected and compared with `PRODUCT_PACKAGE_POLICY`.
- Non-obvious design decisions: reachability is computed from the *real* Loader composition, so "is this package used?" is answered by the composition rather than by a hand-maintained list. `DYNAMIC_MOUNTS` names the packages a chooser mounts *by runtime string* (invisible to a static scan) so their dependencies are still counted.
- Edge cases / failure handling: an empty package inventory is a failure ("restore the package inventory"), not a pass.
- Surprising: the gate distinguishes a package reached by a default product from one reached only after an optional selection — two different reachability sets, both reported.

### scripts/verify-product-use.spec.ts
- Purpose: Regression spec for product use over synthetic profiles and catalogs.
- Key abstractions: `ProductPackagePolicy`, `verifyProductUse`.
- Data flow: each case writes a profile source, a catalog and a patch, then asserts the failure list.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec varies the *profile source* file, because the optional-bundle set is read from `packages/boot/app-boot/src/profile.ts` — the gate's input is a source file, not a manifest.

### scripts/verify-public-repository-links.ts
- Purpose: Reject tracked files that reference an unavailable legacy repository.
- Key abstractions: `canonicalReferenceText(source)`, `findUnavailableRepositoryReferences`, `UnavailableRepositoryReference`.
- Data flow: `git ls-files -z` gives the corpus; each line is canonicalized and matched.
- Non-obvious design decisions: `canonicalReferenceText` (line 27) decodes URL percent-escapes, JavaScript `\uXXXX`/`\xXX` escapes, HTML numeric and named entities (`&hyphen;`, `&num;`, `&period;`, `&colon;`, `&sol;`), normalizes NFKC and lowercases — so a percent-, HTML-, JSON- or Unicode-escaped reference is still caught.
- Edge cases / failure handling: archived Agent Notes are excluded (their references are historical record).
- Surprising: the unavailable repository name is assembled from string parts (`['deepseek','ai'].join('-')`), so the gate file does not itself contain the string it forbids.

### scripts/verify-public-repository-links.spec.ts
- Purpose: Spec proving encoded and case-varied references are all rejected.
- Key abstractions: `findUnavailableRepositoryReferences`.
- Data flow: one case with five differently-encoded spellings of the same URL.
- Edge cases / failure handling: the expected repository name is also assembled from parts in the spec.
- Surprising: the spec includes a `\/`-escaped JSON string and a `\u002f`-escaped one — the gate is expected to see through a JSON-serialized URL.

### scripts/verify-repository-references.ts
- Purpose: Reject maintained references to repository commits and the disallowed organization URL.
- Key abstractions: `RepositoryReference` (`kind: 'commit-hash' | 'organization-url'`), `findRepositoryReferences`, `gitLines`, `readMaintainedFiles`.
- Data flow: the tracked corpus is read; `git rev-list --all` (bounded by `objectListingLimit`) produces the known commit ids; each maintained line is matched against the commit pattern and the organization URL.
- Non-obvious design decisions: the organization name is assembled from parts (line 10) so the gate does not contain it; the *kit* repository is exempted with an explicit regex (line 13) because "The independent kit repository owns the engine source and documentation." Digests and other Git object types are accepted — the check is for *commits* only.
- Edge cases / failure handling: `GIT_NO_LAZY_FETCH=1` is set so the gate cannot silently fetch from the network.
- Surprising: the commit pattern requires 7–40 hex digits with non-alphanumeric boundaries, so a SHA-256 digest (64) or a random hex token in prose is not a commit reference.

### scripts/verify-repository-references.spec.ts
- Purpose: Spec over a synthetic git repository.
- Key abstractions: `findRepositoryReferences`, `scanRepositoryReferences`, `uniquePrefixMatch`.
- Data flow: the spec creates a real git repo, makes commits, and asserts the references found.
- Edge cases / failure handling: `onTestFinished` cleanup with retries.
- Surprising: `uniquePrefixMatch` exists because an abbreviated commit id must match exactly one commit — an ambiguous abbreviation is not a reference to anything.

### scripts/verify-runtime-closure.ts
- Purpose: Verify that the executable deploy manifest supplies every plugin referenced by a shipped agent preset and every required workspace peer.
- Key abstractions: `RuntimeClosureResult`, `verifyRuntimeClosure(root, manifestPath, includePresets)`, `AGENT_PRESET_GLOB`.
- Data flow: the runtime manifest and `platforms.json` are read; every preset's plugin definitions are collected; the workspace packages reachable from the runtime's dependencies are walked and their *required* peers checked.
- Non-obvious design decisions: the reason the gate exists is stated plainly: "With auto peer installation disabled, either omission can otherwise fail only when Cordis loads the packaged plugin" — i.e. in production, not in tests. An optional peer is not required; a peer already provided as a `workspace:` dependency is not required either.
- Edge cases / failure handling: an empty preset glob or an empty platform list is a failure, not a pass.
- Surprising: the failure message is a *chain* (`formatChain(runtimeName, packageName, parents)`), so the report says which path in the dependency graph left the peer unsatisfied.

### scripts/verify-runtime-closure.spec.ts
- Purpose: Spec for the runtime closure gate.
- Key abstractions: `fixture(files)` with a `preset:` prefix convention.
- Data flow: each case writes a synthetic runtime manifest, platforms file and preset, and asserts the failure list.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the fixture's `preset:` naming convention lets one map express both manifests and presets, which keeps each case to a few lines.

### scripts/verify-skill-invocation-metadata.ts
- Purpose: Keep Claude Code and Codex invocation metadata aligned for repository skills.
- Key abstractions: `parseSkillFrontmatter`, `skillDirectories`, `collectSkillInvocationMetadataViolations`.
- Data flow: every skill directory carrying `agents/openai.yaml` is read together with its `SKILL.md`; the two policies are compared.
- Non-obvious design decisions: the equivalence is `disable-model-invocation === true` ⟺ `policy.allow_implicit_invocation === false` (line 94). The two products spell the same policy differently, and a skill that is manual-only in one and model-invocable in the other is a *cross-product* defect, not a cosmetic one.
- Edge cases / failure handling: a manual-only skill must remain `user-invocable` (line 102) — a skill nobody can call is useless; the frontmatter booleans are type-checked.
- Surprising: the gate is product-agnostic — it only knows that two spellings must agree — so adding a third product means adding one comparison, not a new gate.

### scripts/verify-skill-invocation-metadata.spec.ts
- Purpose: Spec for cross-product skill policy alignment.
- Key abstractions: `collectSkillInvocationMetadataViolations` over a synthetic `.agents/skills` tree.
- Data flow: each case writes a `SKILL.md` + `agents/openai.yaml` pair and asserts the violation list.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec covers the *type* violations (a non-boolean `disable-model-invocation`) separately from the alignment violation.

### scripts/verify-ssh-helper-artifact.ts
- Purpose: Unpack and run a release archive through the actual Loader-mounted SSH consumers.
- Key abstractions: `extractHelper(archive, directory)`, `runArtifactDriver(config, report, sandbox, environment)`, `artifactComposition(connection, workspace)`, `verifySshHelper(argv)`.
- Data flow: the archive is listed and validated entry by entry, extracted, digest- and permission-verified, made read-only, checked for native ABI, then driven through a real consumer process that writes a JSON report.
- Non-obvious design decisions: `extractHelper` validates *before* extraction — every entry must be a regular file or directory under `dsh-ssh-helper/`, with no `..`, no `.`, no empty segment, no backslash and no duplicate. The composition it builds is the *real* one (`dsh-session-projection`, `dsh-sandbox-policy`, the SSH connection, `dsh-fs-ssh`, `dsh-subprocess-ssh`, `dsh-sandbox-ssh`, `ptc-runtime-node`).
- Edge cases / failure handling: the driver has a 120 s `SIGKILL` force-kill; stderr and stdout are kept to the last 32 KB and included in the failure.
- Surprising: `makeReadonly` chmods the *directories* to 0o555 and the files to their manifest mode minus the write bits — the release is verified in the state it will actually be installed in.

### scripts/verify-ssh-helper-ssh.ts
- Purpose: Real OpenSSH acceptance against a glibc 2.28 container with no installed Node.
- Key abstractions: `docker(...)`, `sshdReady(container)`, `verifySshTransport(argv)`.
- Data flow: a Linux helper archive is extracted and verified; a Docker image is built from the repo's sshd fixture; a container is started with the helper bind-mounted **read-only**; a key is generated; `known_hosts` and an `ssh_config` are written; a shim `ssh` binary is placed first on `PATH`; the production providers are driven against the real sshd.
- Non-obvious design decisions: the helper is mounted `--mount type=bind,…,readonly` and the client runs with `DSH_VERIFY_NO_NODE=1`, so the acceptance proves the helper works on a target with *no Node at all*. The evidence report records `glibc: 'glibc 2.28'` read from inside the container.
- Edge cases / failure handling: `sshdReady` waits for "Server listening on" in the container logs with a 30 s deadline and kills the log follower in a `finally`; the container is force-removed in a `finally`; a failure attaches the container logs.
- Surprising: the client `ssh` is a shell shim (`exec /usr/bin/ssh -F <config> "$@"`) placed on `PATH`, so the production code's ordinary `ssh` invocation reaches the container without any product-side change.

### scripts/verify-subsystem-pages.ts
- Purpose: Doc-sync gate for package-group subsystem references.
- Key abstractions: `GROUPS_WITHOUT_SUBSYSTEM_PAGE` (an exemption map with a reason per group), `SubsystemPageAudit`, `auditSubsystemPages`.
- Data flow: `packages/*/README.md` and `packages/*/*/package.json` give the groups; each group README's `../../docs/subsystems/*.md` links are collected and counted.
- Non-obvious design decisions: the exemption reasons are "reviewable policy: a new group cannot silently inherit an exemption" (line 14) — a new group must be added to the map with a justification, or it must link a page. `README.md` and `.zh.md` are excluded from the link set.
- Edge cases / failure handling: a stale exemption (a group that no longer exists) is a violation; a group with no group README is a violation.
- Surprising: `groupOf` throws on a path without a group segment, so the inventory cannot silently lose a package.

### scripts/verify-subsystem-pages.spec.ts
- Purpose: Regression spec for package-group subsystem-page ownership.
- Key abstractions: `auditSubsystemPages` over a synthetic tree.
- Data flow: each case writes a group README and a manifest and asserts the audit.
- Edge cases / failure handling: `onTestFinished` cleanup.
- Surprising: the spec is able to pass a *different* exemption map, so the policy table is tested as data.

### scripts/verify-type-equiv.ts (see above), scripts/verify-upgrade-guides.ts
- Purpose: Enforce the `docs/upgrade-guide/v<version>/<item>/guide.md` layout, metadata, sections and word ceiling.
- Key abstractions: `LANGUAGES` (per-language required sections and ceilings), `GUIDE_PATH` (a semver-aware regex), `guideViolations`, `collectUpgradeGuideViolations`.
- Data flow: the tree is walked; each file's name is matched against the path regex; the English guide's frontmatter keys are checked exactly, its body headings are compared to the expected outline, and its word count is compared to the 500-word ceiling.
- Non-obvious design decisions: the frontmatter keys must be **exactly** `description` and `kind` — no extra keys — and the heading outline must be one `#` title followed by the language's two `##` sections, in order. The Chinese sibling's ceiling is `undefined` (only the English source is budgeted) and its pairing record is owned by `verify-translation-pairing`.
- Edge cases / failure handling: a file that does not match the path regex fails even if its content is fine.
- Surprising: the `kind` value must be `upgrade-guide`, so a guide cannot be mistaken for another document kind in the site's own frontmatter taxonomy.

### scripts/verify-upgrade-guides.spec.ts
- Purpose: Spec for the upgrade-guide layout, frontmatter, sections and ceiling.
- Key abstractions: a `VALID` guide constant.
- Data flow: each case writes a tree and asserts the violation list.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec uses a `VALID` fixture that the mutations then break one field at a time, so every rule has a dedicated negative case.

### scripts/verify-v3-event-vocabulary.ts
- Purpose: Compare the V3 migration vocabulary with an explicitly pinned local V3 writer.
- Key abstractions: `V3EventVocabularyCheck` (`sourceRef`, `eventCount`), `verifyV3EventVocabulary(root, sourceRef, expected)`, `sourceEventTypes`, `initializer`.
- Data flow: the pinned commit is read with `git show <ref>:<path>`; the migration's `KNOWN_SESSION_EVENT_TYPES` set is extracted from the AST and compared with `RELEASED_V3_EVENT_TYPES`.
- Non-obvious design decisions: the pin must be a **full immutable commit id** (40 or 64 hex) and `git cat-file -t` must report `commit` — "not a branch, tag, or abbreviated id" — and the object must already be present locally ("does not establish remote freshness"). The event list must be a *literal* `Set` of string literals with no duplicates, so the vocabulary has one owner and cannot be assembled at runtime.
- Edge cases / failure handling: a missing local pin throws with the message "prepare the verified source pin before running this check"; `GIT_NO_LAZY_FETCH=1` prevents a network fetch.
- Surprising: the check reads the *writer* at a pinned commit rather than "whatever the branch says today", so the migration's input is an immutable artefact.

### scripts/verify-v3-event-vocabulary.spec.ts
- Purpose: Spec for the V3 event vocabulary check.
- Key abstractions: `RELEASED_V3_EVENT_TYPES`, `verifyV3EventVocabulary` over a synthetic git repo.
- Data flow: each case writes a writer + events file at a pinned commit and asserts the check.
- Edge cases / failure handling: cleanup in `afterEach`.
- Surprising: the spec builds a real git commit so the pin validation is exercised, not stubbed.

### scripts/vitest-environment.compat.spec.ts
- Purpose: jsdom-environment spec for the ResizeObserver fallback.
- Key abstractions: a `ResizeObserver` usage with `observe(target, { box: 'border-box' })`.
- Data flow: the spec observes an element and asserts the delivery shape.
- Non-obvious design decisions: the element's `getBoundingClientRect` is replaced with a throwing stub — "the jsdom resize fallback must not measure viewport geometry" — so the test proves the fallback uses the *modeled* offsets, not layout.
- Edge cases / failure handling: `unobserve` then `observe` delivers again; `disconnect` stops delivery.
- Surprising: the spec asserts `borderBoxSize: [{ inlineSize: 0, blockSize: 0 }]` — zero sizes are the correct modelled values.

### scripts/volatile-config.fixture.ts
- Purpose: Shared volatile schema fixture for the schema and Loader volatile specs.
- Key abstractions: `Config` — a Schemastery object with `fixed`, `title` (volatile with a default), `optional` (volatile, no default), `nested.count` (volatile inside an object) and `group` (a whole-object volatile).
- Data flow: imported by the volatile spec.
- Non-obvious design decisions: the fixture deliberately covers the four volatility shapes — a plain field, a field with a default, a nested field, and an entire object — because the config system's volatile semantics differ in each.
- Edge cases / failure handling: n/a (a fixture).
- Surprising: `.default({ list: [] })` is applied *after* `.volatile()` on the object, so the fixture pins the order-sensitivity of the builder.

### scripts/volatile-config.spec.ts
- Purpose: Schemastery and Cordis config reference behavior through direct and Loader updates.
- Key abstractions: `Config` from the fixture; `createVolatile`, `deepEqual`, `volatileEntries` from `@deepseek-ai/cosmokit`; `redactSecrets` from the settings package.
- Data flow: parses the schema, asserts the `Volatile<T>` types, and exercises direct and Loader-mediated updates.
- Non-obvious design decisions: the spec mixes runtime assertions with `expectTypeOf` — the *type* of a volatile field is itself the contract.
- Edge cases / failure handling: `redactSecrets` is exercised in the same file, so the redaction of a volatile value is covered where the volatility is defined.
- Surprising: `expectTypeOf(z.string().volatile().description('Live text').default('text')().get()).toEqualTypeOf<string>()` — the builder chain's order is part of the type contract.

### scripts/web-product-bundle-isolation.ts
- Purpose: Experimental-package isolation over Vite's emitted product graph and recorded file inputs.
- Key abstractions: `WebOutputChunk`, `WebOutputAsset`, `WebModuleInfo`, `WebProductBundleIsolation`.
- Data flow: Vite plugin hooks record CSS dependencies, asset references, worker inputs and the emitted chunk graph; the isolation class then walks the graph and reports any experimental package that reached the product bundle.
- Key decision: output graphs are rebuilt each time, but the cached transform observations persist — `reset()` clears both for a watch rebuild (line 60).
- Edge cases / failure handling: the class keeps its own `BundleInputIsolation` for the *physical* file inputs, so a file that never appears in a chunk (a CSS module whose chunk Vite removes) is still tracked.
- Surprising: the class is a *plugin* that observes the real build rather than a static analysis of the source — the isolation claim is about the emitted artifact.

### scripts/web-product-bundle-isolation.spec.ts
- Purpose: Exercise real Vite build inputs, including files absent from ordinary chunk imports.
- Key abstractions: `browserDependencyAnalysis`, `productWebBundleIsolation` from `apps/web/product-isolation.ts`; `BundleInputIsolation`.
- Data flow: the spec builds a tiny project with `tsdown`/Vite and asserts the isolation result.
- Edge cases / failure handling: `node:fs` is mocked so a missing root can be simulated.
- Surprising: the spec asserts against the *product* isolation entry points as well as the class, so the wiring from the app to the gate is covered.

### scripts/windows-package-workflow.spec.ts
- Purpose: Assert the `windows-package.yml` workflow shape.
- Key abstractions: the workflow YAML typed as `{ on, permissions, concurrency, jobs }`.
- Data flow: the file is read and parsed with `js-yaml`; the spec asserts the declared inputs, permissions, concurrency and per-job runner/env.
- Non-obvious design decisions: the *workflow declaration* is the unit under test — the same idea as `scripts/tests/ci-master-platforms.spec.ts`, applied to the Windows packaging lane.
- Edge cases / failure handling: the spec is a static assertion, so a workflow that changes behaviour without changing its declaration cannot be caught here (a stated limit).
- Surprising: the same repo asserts its own CI policy in two different ways — `gatesForMode` for the gate graph, and YAML shape for the workflow.

### scripts/wine-windows-gates.sh
- Purpose: Run the blocking Windows gates with real win-x64 Node.js under Wine.
- Key abstractions: `verify_sha256`, `download_node_archive`, `cleanup`/`trap`, the scratch tree.
- Data flow: the tree is snapshotted into a scratch directory (so the checkout is never mutated), the Wine-specific pnpm overrides are appended to the *snapshot's* `pnpm-workspace.yaml`, the install and gates run there against the shared pnpm store, and the Wine prefix and the checksum-verified Node zip persist in `.cache/wine-windows/`.
- Non-obvious design decisions: the preflight fails loud with a *named* list of missing tools before any expensive work. The Node archive is verified against a SHA-256 from a primary URL *and* a mirror. `WINEDLLOVERRIDES='mscoree,mshtml='` skips the Wine Mono/Gecko installers because Node needs neither.
- Edge cases / failure handling: `DSH_WINE_GATE_KEEP=1` preserves the scratch tree for inspection; `DSH_WINE_NODE_MAJOR` (default `$PRIMARY_NODE_VERSION`, then 24) selects the Node line; `DSH_WINE_GATE_CACHE_DIR` relocates the cache.
- Surprising: the script exports `DSH_CLIENT_COMMIT_HASH` from the *real* repository because "The scratch tree has no Git metadata or Windows Git executable" — the build inside Wine still needs the commit id.

### scripts/workspace-package-globs.ts
- Purpose: Convert discovered package manifests into portable bundler workspace patterns.
- Key abstractions: `workspacePackageGlobs(manifests)`.
- Data flow: each manifest path becomes its POSIX directory.
- Non-obvious design decisions: the function exists to stop filesystem separators from becoming escapes in a workspace glob — "on every host".
- Edge cases / failure handling: n/a.
- Surprising: an 11-line file exists solely because a Windows backslash in a bundler glob silently selects nothing.

### scripts/workspace-package-globs.spec.ts
- Purpose: Spec proving Windows-style manifest paths still select the packages a bundler must include.
- Key abstractions: `workspacePackageGlobs` and a real `tsdown` build over a temp workspace.
- Data flow: a fixture creates `packages\util\atomic-write\package.json` (Windows separators) and `vendor/cordis/package.json`; the globs are then fed to `tsdown` and the build is checked.
- Edge cases / failure handling: `onTestFinished` cleanup.
- Surprising: the spec runs an actual bundler rather than comparing the glob strings, so a bundler that changes its separator handling is caught.

### scripts/snapshots/translation-prompt-v4/request-response.expected.json
- Purpose: The committed golden of the assembled translation request and the consumed response.
- Key abstractions: a single object with two keys — `request` (`targetFilename` plus the `messages` array) and `response` (the three parsed sections with the corrected switcher).
- Data flow: written by `verify-translation-prompt.ts --snapshot` and compared by `translation-prompt.expected.spec.ts` through `toMatchFileSnapshot`.
- Non-obvious design decisions: the golden contains the **whole** rendered system prompt (the committed `docs/i18n/translation-prompt.md` body) plus three user/assistant gold-pair turns and the source document — so a change to the prompt text is a visible diff in this file, not a silent behaviour change. The examples are synthetic fixtures (`scripts/fixtures/translation-prompt/examples/*`), so editing a real paired document does not churn this golden.
- Edge cases / failure handling: the response's `final` body carries the corrected language switcher ``` [English](snapshot-note.md) `` | 中文` and the YAML frontmatter, both asserted in `verify-translation-prompt.ts:75`.
- Surprising: the golden is the *only* place the full prompt text is pinned twice (once as a document, once as a rendered request), so a prompt edit cannot pass by changing only one of the two.

### scripts/snapshots/python-sdk-single-exe/* (30 files)
- Purpose: The committed golden corpus of the Python SDK smoke.
- Key abstractions: three JSON shapes (`result.json` = the RunResult's events and notifications; `requests.json` = the serialized model requests; `model-visible.json` = the assembled system prompt + tool schemas + messages) and one JSONL shape (`session*.jsonl` = the persisted session log, one event per line).
- Data flow: written by `smoke-python-runtime.py --update-snapshots`, compared by `compare_snapshot_files` after normalization (volatile ids, timestamps and paths tokenized).
- Non-obvious design decisions: the JSONL files are the *physical* encoding, which is why `isPhysicalSessionFixture` excludes them from the canonical-layout gate; the three session generations (v2/v3/v4) of the same scenario are kept side by side so the migration path is exercised.
- Edge cases / failure handling: a session file's header version must match the version in its filename; the `{{cwd}}`/`{{parent}}`/`{{child-N}}`/`{{messageId}}` tokens are what make the goldens machine-stable.
- Surprising: `advanced-ptc/result.json` is 114 KB and `advanced/session.v4.jsonl` is only 67 lines — the *event* stream is compact, but the assistant messages carry the full packed stream. The PTC variant's tool-call id is `advanced-code:ptc:1` while the root id stays `advanced-code`, which is the PTC dispatch identity the gate asserts.

## Ideas worth stealing

- **A gate runner with two levels of dependency — "must pass" and "must settle"** - `scripts/run-gates.ts:1142` - `predecessorsReady` requires every `needs` gate to have **passed** but every `after` gate only to have **settled** (passed, failed or skipped). This is the dependency primitive August needs for "a diagnostic must still run after its sibling fails": today every August check either blocks or does not, and a failed dependency silently suppresses the evidence you wanted. The `after` edge is what lets a Windows lane run `built-bin-smoke` on an existing build even when `doc-graphs` failed (`scripts/run-gates.spec.ts:560`).

- **Kill the whole process tree, and prove the tree is quiescent before reporting** - `scripts/run-gates.ts:1350` - `confirmGroupGone` refuses to settle the gate until the POSIX process group *and* every captured descendant pid are confirmed gone, polling for 8 s and then failing **loud** ("gate tree not quiescent after 8s") rather than reporting a quiescent tree. August's Windows subprocess teardown has exactly the failure this prevents: the wrapper dies, a grandchild keeps the stdio pipe open, and the harness reports "passed" over a live leak. The companion detail that makes it work — zombies do not count as alive (`scripts/run-gates.ts:1414`) — is the same class of bug as a zombie `kill(pid, 0)` probe in a Windows child tracker.

- **A descendant cache that MERGES rather than replaces, because an exited intermediate orphans its children** - `scripts/run-gates.ts:1317` - `descendants = [...new Set([...descendants.filter(processAlive), ...fresh])]`. The comment explains it: re-enumeration alone drops a descendant that an exited intermediate reparented out of the parent chain, so the cache is the source of truth once the child is gone. August's process supervision should keep the same union semantics, plus the 5-second sampler (`scripts/run-gates.ts:1325`) that captures a descendant before it can escape.

- **A gate that produces no evidence is `skipped`, never `passed` — and a child that trapped the signal still counts as aborted** - `scripts/run-gates.ts:1130` and `scripts/run-gates.ts:1386` - `skippedByFailFast` records `status: 'skipped'` with `error: 'aborted by fail-fast: <cause>'`, and `runGate` sets `result.aborted = true` independently of the exit code, so a child that traps SIGTERM and exits zero cannot be reported as passed. The Windows analogue of your own lesson ("a killed process is indistinguishable from a failed one by exit code alone") is generalised here into a first-class field.

- **Fingerprint an assertion by its SYNTAX TOKENS, and consume the allowance** - `scripts/verify-no-unknown-casts.ts:25` - `syntaxFingerprint` hashes the assertion's token stream with comments and whitespace excluded, so a baseline allowance is tied to the exact shape of the assertion rather than to a file, a line or an occurrence order; `verifyNoUnknownCasts` then *decrements* the allowance per occurrence (`scripts/verify-no-unknown-casts.ts:155`), so an old allowance can never launder a new assertion and a leftover allowance is an error requiring `--prune`. August's ratchet gates (lint:ratchet, the coverage floor) should key on a content fingerprint, not on a count per file.

- **"A scanner gate that passes on zero matches is not a gate"** - `scripts/verify-no-unknown-casts.ts:91` and `scripts/verify-concrete-terms.ts:56` - Both gates assert that their *discovery* still covers a required area (`packages/`, `apps/`, `scripts/`, `website/`; `AGENTS.md`, `docs/`, `vendor/`, the archived notes) and throw if a glob stopped matching. `verify-no-bare-dispatcher.ts:206` does the same for its corpus. August's `check:*` gates are exactly the kind that can silently start scanning nothing.

- **A growth budget expressed in the SYSTEM'S OWN work units, with the hang guard derived from it** - `scripts/verify-npm-install-layout.ts:33` - `MAX_RESOLUTION_WORK_UNITS = 875_000` is "packages × internal edges", chosen because npm's hoisted placement re-checks every internal edge against the incoming edges of its peer target, so resolution time grows with the product and not with the package count. The wall-clock hang guard is computed *from* the same constant (`scripts/verify-npm-install-layout.ts:48`) "so a raised budget cannot silently shrink the guard's headroom". August should price its context-window and compaction work the same way: count the work, budget the work, and derive the timeout from the budget.

- **Prove an edit is PARSE-NEUTRAL, or re-parse** - `scripts/translation-pairing-record.ts:96` - `isParseNeutralEdit` accepts an edit only when it exchanges characters from `[A-Za-z0-9._/:#%-]` inside a complete, title-free destination that does not start a line; only then are node offsets moved arithmetically (`normalizedTopLevelBlocks`, line 125) instead of re-parsing. August rewrites model-visible JSON and Markdown in several places; this is a cheap, provable way to keep offsets correct after a rewrite.

- **"Any line that LOOKS like a region marker must parse as one"** - `scripts/translation-pairing.ts:25` - A loose detector (`GENERATED_REGION_MARKER_HINT`) sits next to the strict parser, so a typo'd `<!-- BEGIN GENERATED … -->` is a loud error instead of unmarked text that silently escapes the region comparison. August's generated-block markers should get the same "loose detect, strict parse" pairing.

- **Keep filename context OUT of the model request and correct the switcher afterwards** - `scripts/translation-prompt.ts:74` and `scripts/translation-prompt.ts:252` - The pipeline retains the source basename, derives the target filename and the correct language switcher itself, and the model's job is only the document body. The same principle is visible in the SDK snapshots: the target path is never model-visible. August's prompt construction should keep paths out of the prompt and substitute them after the model returns, so the model cannot invent one.

- **Normalise the volatile, keep the diagnostic — and keep the repair id** - `scripts/smoke-python-runtime.py:2702` - `normalize_snapshot_value` tokenizes ids, timestamps and paths, but explicitly preserves an `interrupted-tool-result-<callId>-<n>` id (line 2763) because that id is deterministic and is itself the evidence that a tool result was repaired. This is the shape a golden needs: everything unstable is normalized away, and every fact that *means* something is kept.

- **Compare golden files by ROLE, not by name** - `scripts/smoke-python-runtime.py:3027` - `role_name` maps `session.1.v4.jsonl` to the role `session.1.jsonl` and the comparison selects the highest generation present on each side. A fixture can therefore gain a new session-format generation without the golden going stale, and the corpus keeps the old generations as migration inputs. August's session-format goldens need exactly this when the format version moves.

- **A corpus policy that names the migration coverage it keeps, and caps it** - `scripts/session-snapshot-corpus-policy.ts:96` - Every historical generation must be covered by a *named* retained scenario (`multi-hop`, `packed-row`, `retry-failure`, `shipped-profile` for v0; `adjacent-migration` for the rest), retained roles are capped at 13, and `baseline + current` must outnumber `retained`. A corpus cannot fossilize, and "we kept the old fixture" becomes a reviewable sentence rather than a folder of forgotten files.

- **Point a failure at the line a human can open** - `scripts/session-fixture-layout.ts:187` - `fixtureDiagnosticLine` maps a codec error ("released Session row 3", "Session event 7", "inherited Session cut 2") back to the physical source line of the fixture file. August's session decoder errors currently name an event index; naming the file line turns "the fixture is wrong" into "fix this line".

- **A packed row carries N events, so the sequence counter must advance by the CARDINALITY** - `scripts/session-fixture-layout.ts:83` - `projectedRowCardinality` counts the texts/args in a `text-chunks` / `reasoning-chunks` / `tool-call-chunks` row, and the sequence number advances by that count. This is the single most transferable detail in the shard for anyone reading a *streamed* session log: one physical row can be many logical events, and an off-by-one there corrupts every later sequence number.

- **The reason a rule exists is written next to the rule, with the measured number** - `scripts/verify-no-bare-dispatcher.ts:4` and `scripts/verify-mermaid.ts:83` - The dispatcher gate states the concrete defect it prevents ("its DNS-pinning agent silently bypassed every proxy") and records the cost of the naive approach ("21 of 1597 files survive the filter"); the Mermaid gate records *why* the edge limit was raised rather than trimming the graph ("The graph passed 1000 the same way it passed 500"). August's gate comments are usually conclusions; these are measurements.

- **An escape hatch that is greppable and reviewable** - `scripts/verify-no-bare-dispatcher.ts:36` - `proxy-exempt:` on the offending line or the line directly above excuses the violation, and the reason for placing it on the line above is written down ("a syntax-aware match anchors on the property or `new` expression rather than the statement"). August's sandbox and tool gates need an escape that a reviewer can find with `grep`, not one buried in a policy file.

- **Cross-product policy equivalence as a first-class check** - `scripts/verify-skill-invocation-metadata.ts:94` - The gate asserts `disable-model-invocation === true` ⟺ `policy.allow_implicit_invocation === false` and that a manual-only skill stays user-invocable. August ships several front-ends over one core; this is the pattern for "the same rule, spelled two ways, must agree".

- **A release is published only when EVERY target carries its own evidence** - `scripts/ssh-helper/release.ts:35` - `prepareSshRelease` requires four archives, each digest-matched, `dirty: false`, from the same commit, plus per-target evidence reports (Linux: no-Node + glibc 2.28 + landlock; macOS: restricted worker), and writes `SHA256SUMS` from the digests it just verified. The `dirty: false` assertion alone — a release artifact may not come from a dirty checkout — is worth taking.

- **A binary that must run with NO Node and an EMPTY environment** - `scripts/ssh-helper/worker-probe.ts:22` and `scripts/ssh-helper/worker-probe.ts:59` - The Seatbelt profile denies read and exec of the checkout and the host Node, and the probe asserts `result.env` deep-equals `[]`. "The worker booted with nothing" is a much stronger statement than "the worker booted".

- **Assert the ground truth you actually depend on, not the convenient one** - `scripts/run-memory-pressure-bench.ts:85` - `memoryLimitViolation` compares the cgroup's `memory.max` AND `memory.swap.max` AND `process.constrainedMemory()` (which reflects *ancestor* cgroups), and refuses to run if any disagrees. A benchmark that silently ran unconstrained would produce a meaningless number, and the third check is exactly the one an ancestor cgroup would defeat.

- **Model the retry/denial ladder in the GOLDEN, not in prose** - `scripts/smoke-python-runtime.py:363` - The scheduler-recovery scenario pins the exact `is_error` sequence `[False, True, True]` across three tool results, that the *unstarted* third call was never dispatched, and that the failed call's `is_error` stayed true after the next turn. Your own lesson — "the refusal text was read as success by every downstream consumer" — is exactly what a golden of this shape catches: the marker vocabulary is checked against every emitter, one emitter at a time.

- **Two spellings of one policy must agree; a third must be added, not inferred** - `scripts/verify-skill-invocation-metadata.ts:94`, `scripts/verify-client-ui-i18n.ts:33` - The UI gate has a hard floor: `MINIMUM_CLIENT_UI_SOURCES = 450` (`scripts/verify-client-ui-i18n.ts:15`), so the rule cannot be defeated by the corpus shrinking. A minimum-size assertion on every i18n / copy gate is the cheapest way to stop a copy rule from becoming a no-op.

- **A gate that is also a "did the toolchain regress?" tripwire** - `scripts/verify-node-next-types.ts:146` - tsc is invoked through `node node_modules/typescript/bin/tsc` rather than the `.bin` shim, with the reason recorded: the extensionless shim is not spawnable on Windows (CVE-2024-27980) and the `.cmd` variant needs `shell:true`, which space-joins arguments unescaped (DEP0190). The same file explains that `skipLibCheck: true` is scoped to third-party noise because "the explicit scan above owns our regression" — i.e. the gate disables exactly as much of the checker as it has replaced.

## Files skipped (with reasons)

- `scripts/snapshots/python-sdk-single-exe/advanced/result.json` - a 114 KB / 4400-line generated golden (the recorded RunResult of the native advanced scenario). I read the sibling `advanced/session.v4.jsonl` and the `dynamic-tools`/`restart` goldens to establish the shape; this file is data regenerated by `smoke-python-runtime.py --update-snapshots` and compared byte-for-byte after normalization, so a line-by-line read would not have produced information the generator does not already encode.
- `scripts/snapshots/python-sdk-single-exe/advanced-ptc/result.json` - a 58 KB / 2310-line generated golden (the PTC variant of the same RunResult). Same reason; I read the PTC session log and the golden's own assertions in `smoke-python-runtime.py:1699` instead.
- The remaining 26 `scripts/snapshots/**` files (`.jsonl` session logs in v2/v3/v4 for `advanced`, `restart` and `scheduler-recovery`; `authoring/model-visible.json` and its `win-x64` variant; `minimal/model-visible.json` and its `win-x64` variant; `minimal-in-history/prompt-history.json`; `dynamic-tools/tool-history.json`; `restart/requests.json`; `restart/result.json`; `scheduler-recovery/requests.json`; `scheduler-recovery/result.json`; `scripts/snapshots/translation-prompt-v4/request-response.expected.json`) - I opened every one of them (the JSONL headers and first records, the JSON documents' first keys) with `read`/`pwsh Get-Content` to establish exactly what each contains, and read four of them in full depth (`dynamic-tools/tool-history.json`, `minimal/model-visible.json`, `restart/requests.json`, `translation-prompt-v4/request-response.expected.json`). They are machine-generated goldens: 3–254 lines of recorded model traffic whose content is the *subject* of the assertions in `smoke-python-runtime.py` and `verify-translation-prompt.ts`, not logic. Reading them line by line would not have told me anything the comparison function does not already enforce. Their per-file status in the ledger records this.
- `scripts/type-equiv.manifest.json` - a 76 KB / 2486-line generated manifest. I read its header comment, the first entries and its entry shape; the 2400+ remaining entries are a mechanical `doc → symbol → source` table consumed by `verify-type-equiv.ts`. The ledger marks it `skipped` with that reason because it is generated data, not prose.

## Uncertainties

- **The `verify-*.ts` family is only partly read.** I read the first 80–150 lines of the largest members (`verify-client-packages.ts` 713 lines, `verify-cordis-config.ts` 578, `verify-export-jsdoc.ts` 607, `verify-package-dependencies.ts` 1038, `verify-package-readme-model-experience.ts` 638, `verify-default-product-isolation.ts` 413, `verify-product-use.ts` 317, `verify-client-route-resolution.ts` 339, `verify-client-ui-i18n.ts` 361, `verify-no-top-level-await.ts` 267, `verify-no-unknown-casts.ts` 186, `verify-runtime-closure.ts` 237, `verify-plugin-record-callers.ts` 283, `verify-md-links.ts` 254, `verify-package-meta.ts` 285, `verify-npm-install-layout.ts` 275, `verify-optional-dependency-imports.ts` 213, `verify-repository-references.ts` 155, `verify-doc-site-fragments.ts` 181, `verify-subsystem-pages.ts` 137, `verify-upgrade-guides.ts` 85 (complete), `verify-public-repository-links.ts` 99 (complete), `verify-package-paths.ts` 113 (complete), `verify-client-domain-graph.ts` 104 (complete)). Their file headers state the rule and their exported function names state the mechanism, so the notes are accurate about *what* each gate enforces; I did not verify the *implementation* of the later half of the largest ones. The ledger marks them `read` because I opened and understood each file's purpose; the audit trail for the depth is in the per-file note.
- **The 40+ `.spec.ts` files in this shard were read to their first ~20–30 lines plus their import list**, not in full. Every one of them is a Vitest spec over a synthetic fixture; the imports name the exported function under test, so the subject of each is unambiguous. I read `run-gates.spec.ts` (1371 lines) and `session-fixture-layout.spec.ts` (236) in full, and `translation-prompt.spec.ts` (234) in full, because they carry their own policy. The remainder I characterised from their header, imports and first cases.
- **I did not read the `scripts/snapshots/**` goldens end to end**, for the reasons given above; in particular I have not verified that every line of `advanced/result.json` corresponds to a specific assertion in `smoke-python-runtime.py`.
- **I could not determine which of the ~45 `verify-*.ts` gates are wired into which CI lane** beyond what `run-gates.ts` shows (the `doc-sync` / `hygiene` / `ci-static` aggregates name most of them by id, e.g. `no-bare-dispatcher`, `no-unknown-casts`, `no-top-level-await`, `plugin-record-callers`, `client-packages`, `client-ui-i18n`, `client-route-resolution`, `application-entrypoints`, `package-dependencies`, `dsh-package-licenses`). Gates not named in any aggregate I read (`verify-mermaid.ts` is named as `mermaid`; `verify-export-jsdoc.ts` is named as `export-jsdoc`; `verify-type-equiv.ts` is named as `type-equivalence`) — I checked these three specifically. I did not exhaustively map every gate to its lane.
- **`scripts/verify-package-readme-model-experience.ts` is 638 lines and I read the first 80.** The first 80 lines are the two audited classification tables (`NO_MODEL_EXPERIENCE_SECTION` and `SENTENCE_MODEL_EXPERIENCE`), which are the part that carries the mechanism; the remainder is the section-field validator. I did not verify the field-level rules in detail.
- **The `run-gates.ts` `needs`/`after` graph was read in full**, but I did not independently verify that the graph satisfies the `validateGateGraph` cycle check for every mode — that requires executing the code, which the assignment forbids.
- **`scripts/smoke-python-runtime.py` was read in full (3110 lines)**, but I did not run it and therefore cannot confirm that the goldens currently match; the file's own comparison logic was read, not exercised.
