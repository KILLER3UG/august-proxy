# deepseek-harness / dsh-apps-desktop#3

## Shard shape

This shard is the **entire verification layer of the DeepSeek Harness desktop app** (`apps/desktop/tests/`), 260 files: 176 TypeScript/TSX specs, 30 fixtures (Electron/Node/NSIS/PowerShell/C++/Python harnesses), 51 `expected/` snapshot files, 9 bilingual README/i18n documents and 4 native C++/PowerShell regression programs. It is **not** a slice of the agent loop — it is the shipping machinery around it. The modules it holds fall into five interlocking groups:

1. **The update channel** — `update-coordinator` / `update-schedule` / `update-http-executor` / `update-presentation` / `update-dialog` / `update-overlay` / `update-attention` / `update-journal` plus the `mandatory-update-policy` and `mandatory-update-window` clients. These model a real download-update product: check → download → *separate* install approval → restart, with a "mandatory" (server-forced) variant that can block the app.
2. **The published-release pipeline** — `desktop-publish*`, `desktop-upload*`, `desktop-rollback`, `desktop-release-store`, `desktop-publish-route`, the COS transport and the `retain-desktop-ci` capture. This is a "package → sign → notarize → upload → publish → roll back" machine with a per-channel lock, an audit journal and a human approval summary.
3. **The installed-update qualification** — `installed-update/**` (12 specs) plus the operator READMEs. This is a *manual* acceptance discipline: a manifest allocator, a two-version material set, a network-fault plan, a publication sequence and a JSONL evidence journal, with an explicit list of what is still unproven.
4. **The desktop shell and CLI** — `main-startup.spec.ts` (2267 lines, the whole main entry), `preload-*`, `platform-view`, `keyboard`, `command-*`, `login-shell-environment`, `welcome-*`, `settings`, `locale`, `quit-confirmation`, `fatal-recovery`, `crash-report`.
5. **The packaging substrate** — `core-package-set`, `runtime-tree`, `runtime-file-policy`, `prepare-*`, `package-target*`, `windows-*` signing/caching, `macos-*` signing/notarization, `packaging-run`.

The whole shard is built on one repeated discipline: **a claim is only as strong as the artefact that proves it, and the proof is written to disk next to the action.** `packaging-run` records stage events with redaction; `desktop-publish-record` records intent → before/after bytes → terminal state outside the checkout; `update-journal` records state transitions per installed version; the READMEs then list, line by line, what those artefacts do *not* establish.

### Lens coverage in this shard

| Lens | Where it lands here | Depth |
|---|---|---|
| agent loop and tool-calling flow | `host-update-tasks.spec.ts` (admission locking: new requests get 503, existing ones drain, tasks are re-checked), `host-process.spec.ts` (private-IPC request accounting, fatal/crash events, quit-inspection deadlines), `account-backend.spec.ts` (field projection over a request/response boundary) | medium — this shard observes the loop from outside rather than running it |
| reasoning / thinking content | **absent** — no shard file handles model reasoning content, thinking blocks or streaming deltas | none |
| prompt construction / caching | no prompt assembly; the nearest analogues are `web-document.spec.ts` (per-route `Cache-Control` policy: immutable for static plugin bundles, `no-store` for the bundle manifest) and `runtime-manifests.spec.ts` (sealing dependency metadata so a runtime hash stays stable across archive preparation) | thin |
| context window management / compaction | `crash-report.spec.ts` and `update-journal.spec.ts` cap what is retained (byte caps, oldest-first pruning, the newest renderer-console lines never cut mid-line); `update-error-renderer.spec.ts` folds diagnostics rather than truncating them | thin but real |
| model-specific adaptations / fallbacks | there are none (no per-model code here); the shard's analogue is **platform-specific adaptation**: `preload-platform` / `preload-windows` / `preload-theme`, `locale.spec.ts`, `device-info.spec.ts`, `macos-package-settings` vs `windows-package-preset` | platform-level, not model-level |
| memory / learning mechanisms | no model memory; the analogue is durable on-disk state that survives an upgrade: `project-manager.spec.ts` (plugin profile + lockfile preserved across releases), `keybindings.spec.ts` (a future-version file is refused, not rewritten), `settings.spec.ts` (an older document is defaulted without being rewritten) | medium |
| subagent / parallel execution | `package-macos.spec.ts` (two notarization lanes on isolated copies, promote only completed payloads), `packaging-run.spec.ts` (parallel Mac stages with attributed output), `windows-signing-stage.spec.ts` (stages serialise on a lock), `flock-entry.spec.ts` / `desktop-publish-record.spec.ts` (cross-process exclusion) | medium-high |
| tool-call reliability (retries, timeouts, malformed output) | the richest lens here: `update-http-executor.spec.ts` (inactivity deadline refreshed by real response bytes), `cos-operation.spec.ts` (a *total* operation budget across SDK retries), `windows-timestamp.spec.ts` (retries use fresh signed inputs; hardware failures are never retried), `packaging-run.spec.ts` (stage deadline separate from child exit), `logged-notarytool.spec.ts` (submit-then-wait with separate timings), `primary-runtime-signing.spec.ts` (stop on the first signer failure) | high |
| UI / UX patterns (minimalism, progress feedback) | `update-dialog` / `update-error-renderer` / `update-overlay` / `update-attention` (one silent notification, then back to the confirmation), `quit-confirmation` (four distinct prompts chosen from task state), `background-notice`, `welcome-renderer.client`, `command-management` (a shadowed install becomes a *warning* type) | high |
| config | `desktop-package-environment`, `desktop-policy-environment`, `desktop-auto-update-environment`, `windows-package-preset`, `macos-package-preset`, `settings`, `locale`, `update-channel`, `keybindings`, `desktop-build-version*` | high |
| evals / testing | the shard itself; `apps/desktop/tests/README.md` carries a layer-by-layer evidence table **and** an "Open verification" list of eight things that are *not* passing evidence | high |

## Per-file notes

Files with a real mechanism get the full form. The rest — snapshot fixtures, locale copies, expected-output files, one-line helpers — get one specific line.

### apps/desktop/tests/README.md
- Purpose: The orientation document for the whole desktop test tree: what local update verification covers, how to run the operator walkthroughs, and what the evidence does and does not certify.
- Key abstractions: A layer-by-layer evidence table (ordinary updater, mandatory policy, scheduling, mandatory window, ordinary dialog, unlocked Windows interaction, main entry, Host task protection, visible output, packaging configuration).
- Data flow: command → built Desktop → Electron 44 with the real HTTP updater, policy client, sandboxed preload and mandatory renderer → per-scenario report under `.desktop-build/qualification/local-updater-*`.
- Non-obvious design decisions: The document states plainly that "these isolated checks do not certify the complete workspace or a release", and the installed-app path is explicitly out of scope of the local command (line 35). The `fatal-dialog` copy keeps a diagnostic-report path visible to the user rather than hiding it.
- Edge cases / failure handling: A dedicated "Open verification" section (line 78) lists eight unproven items — cross-platform layout acceptance, the Linux ARM64 junction, installer execution, installed startup, live policy origins, disk-pressure under upgrade, macOS browser/clipboard, and the `doc-sync` EPERM.
- Surprising: The README's evidence table names the **119 regression cases** and the **17 Electron scenarios** as counts, i.e. the document itself is a receipt.

### apps/desktop/tests/installed-update/README.md
- Purpose: The operator checklist for a real Windows installed-application update: prepare materials, run the eight-step operator sequence, retain evidence, recover from failure.
- Key abstractions: `run.json` (a manifest that owns the random run identity, the two derived versions and the `qualification/<id>` paths), the bootstrap entry, the two version-bound runtime copies, the frozen application files, the external `DSH_DESKTOP_UPDATE_JOURNAL_DIR`.
- Data flow: allocator → preparation-only builds → `prepare-installed-update.ts bootstrap|runtime|application` → package → verify archive → publish version 1 → operator installs, injects a fault, retries, restarts → journal inspection → `collect` snapshot.
- Non-obvious design decisions: "A local manifest or complete journal sequence does not certify an installer or preserved data" (line 11). The `--execute` mode requires a terminal and an exact confirmation containing the version and run ID; there is deliberately **no piped approval option** (line 53). `builderCompleted` and a successful supervisor result do not establish package verification — `packageVerification` stays `pending` until the checks are performed independently (line 53).
- Edge cases / failure handling: "Stop at the first failed prerequisite"; a feed mismatch stops the test *before* download; a signature failure stops packaging and its record is retained; PIN authentication is never retried automatically; failed batches are retained rather than overwritten (line 126).
- Surprising: The journal inspector refuses a successor process that started before the original quit, and a clock change can leave evidence incomplete — the tool reports that as needing investigation rather than guessing (line 100).

### apps/desktop/tests/installed-update/publication/README.md
- Purpose: Separate "upload the two verified binaries" from "publish the fixed feed", with operator authorisation and per-operation receipts.
- Key abstractions: `publication-records/operation-*` (plan, timestamped stages, final result, feed body), the reused `upload-binaries` receipt, `publication.lock`.
- Data flow: verify both packages → `upload-binaries --execute` (typed `UPLOAD <version> <run-id>`) → operator starts installed version 1 → `publish-feed --execute` (typed `PUBLISH <version> <run-id>`) → full public readback → then version 2.
- Non-obvious design decisions: Binary upload adds a `GetBucketVersioning` query and refuses to write unless the bucket is neither enabled nor suspended, because COS documents that `x-cos-forbid-overwrite` does not protect objects in versioned buckets (line 28). A denied configuration query leaves the configuration *unknown*; it does not establish that uploads are denied (line 28). "SDK writes have no automatic retries" (line 52).
- Edge cases / failure handling: Diagnose `403 AccessDenied` by the **exact API** — `GetBucketVersioning`, `GetObject` and `PutObject` need different permissions (line 60). "An added configuration query must not be reported as an upload failure when no upload was attempted." The 30 s / 15-minute operation deadlines abort the underlying HTTP requests and wait for closure before releasing the lock (line 64).
- Surprising: "alreadyPublished: true means reconciliation of an existing desired feed, not a new publication" (line 62) — the tool refuses to launder a re-read as a fresh publication.

### apps/desktop/tests/update-http-executor.spec.ts
- Purpose: Specify the updater's inactivity deadline: how long a request may go without producing bytes before it is aborted.
- Key abstractions: `DesktopUpdateHttpExecutor.addErrorAndTimeoutHandlers(request, reject)`; a deadline that is *refreshed by response bytes* rather than by wall clock.
- Data flow: request → optional `response` event → `data` events reset the timer → `end` removes the timer (verification is no longer the transport's business) → `abort`/`error` remove the timer.
- Non-obvious design decisions: "refreshes the deadline on actual response bytes rather than timing out a long active download" (line 25) — a slow but live download must not be killed. "does not leave a deadline running while completed bytes undergo verification" (line 57) — the transport's deadline covers *transport*, not hashing. "keeps waiting for headers after Electron closes the request writable stream" (line 47) — `finish`/`close` on the writable side is not a response.
- Edge cases / failure handling: The rejected promise carries `code: 'ETIMEDOUT'` and the request is aborted exactly once; the timer count must be zero afterwards, so no orphan deadline can fire later.
- Surprising: Invalid configuration (`0`, `999`, `1.5`, `NaN`, `2_147_483_648`) is rejected at construction rather than silently normalised (line 62).

### apps/desktop/tests/update-journal.spec.ts
- Purpose: The qualification evidence journal: what a main process is allowed to write about its own update state.
- Key abstractions: `DesktopUpdateJournal(directory, version)` — one JSONL file per installed version; `desktopUpdateJournalState(state)` — a whitelist projector.
- Data flow: `journal.action(milestone)` and `journal.state(updateState)` → JSONL lines with a monotonically increasing `sequence`; two installed versions write to two files in the shared external directory.
- Non-obvious design decisions: "drops detailed errors and unexpected fields instead of trying to redact arbitrary text" (line 32). The projector keeps only `phase`, `targetVersion`, `failedOperation` and an `errorCode`; a message containing `https://user:password@example.test/file?token=secret` becomes `errorCode: 'UNCLASSIFIED'`. Redaction is not attempted because a redaction that fails silently is worse than a dropped field.
- Edge cases / failure handling: A relative evidence directory is refused outright (`must be absolute`, line 43) — a journal that writes into the checkout is not evidence. Storage failure propagates rather than being swallowed, so a failing journal is visible.
- Surprising: The `errorCode` is derived from the *shape* of the failure (`ETIMEDOUT` is preserved as a code) while the free-text message is dropped entirely.

### apps/desktop/tests/update-coordinator.spec.ts
- Purpose: The state machine that turns an `electron-updater` into a user-visible update lifecycle.
- Key abstractions: `DesktopUpdateCoordinator(publish, beforeRestart, updater, ..., installedVersion)`; states `idle | available | downloading | verifying | ready | installing | error`.
- Data flow: `check()` → `download(version)` → platform preparation (task shutdown) → `quitAndInstall()`; every transition is published through one callback.
- Non-obvious design decisions: "checks, downloads on demand, then requires separate installation approval" (line 132) — reaching 100 % is **not** readiness (line 188): "retains retry state after download failure and never equates 100 percent with readiness". Concurrent callers join one operation instead of retargeting it ("joins checks and downloads without retargeting a prepared release", line 153); a late download approval from a superseded release is rejected.
- Edge cases / failure handling: Safe preparation diagnostics are kept separate from the raw failure and cleared on an explicit retry; an asynchronous installer failure is retained even after `quitAndInstall` returns; late check completions after disposal are dropped; a stable version is installable on `nightly` but prereleases are rejected on `latest`.
- Surprising: "reports one download result when callers share an operation and none for cached readiness" — a second caller that arrives after the package is already prepared is not told a download happened.

### apps/desktop/tests/update-schedule.spec.ts
- Purpose: The automatic polling loop around the coordinator.
- Key abstractions: `DesktopUpdateSchedule(coordinator, { intervalMs, maxBackoffMs, jitter }, random)`; a delay that starts at *completion* of the previous check.
- Data flow: check → on failure double the delay up to the cap with jitter → on success reset to the interval; a manual caller joins the in-flight check and sees its failure.
- Non-obvious design decisions: "checks immediately, doubles failed delays up to the cap, and resets after success" (line 36). The delay is measured from *completion*, not from the start of the check, so a slow check cannot be overlapped by the next one (line 76). Wall-clock changes are ignored (the scheduler is monotonic), and "policy arrival bypasses the automatic deadline silently" so a mandatory decision is not delayed by the ordinary poll.
- Edge cases / failure handling: Polling **never** downloads automatically and never retargets a version that has already been downloaded; a failed download is retained for a user retry without automatic transfers; disposal clears the timer and refuses to rearm when a pending check settles afterwards.
- Surprising: "never downloads automatically" is asserted directly — the automatic path is check-only by construction, which removes the whole class of "the updater restarted itself" bugs.

### apps/desktop/tests/update-presentation.spec.ts
- Purpose: The boundary between an internal update state and what the user is shown.
- Key abstractions: `presentDesktopUpdate(state)` → `{ title, detail, version, update, later, error, page, failure }`; `desktopUpdateErrorSummary(state, messages)` → one localised sentence.
- Data flow: internal state (which may carry a raw message and `technicalDetails`) → presentation object → the client UI.
- Non-obvious design decisions: "keeps raw diagnostics out of error tooltips in both locales" (line 18). The summary is chosen from a controlled vocabulary keyed by `failedOperation` (`check`/`download`/`install`) and `preparationFailure` (`stop-failed`, `tasks-changed`, `tasks-unavailable`); the message is **never** echoed. A message that merely *contains* the localised stop-failed sentence is still classified as a generic install failure, so copy cannot smuggle a classification.
- Edge cases / failure handling: A 1000-line message containing headers and internal paths must not appear anywhere in the serialised presentation.
- Surprising: The visible-phase snapshot (`expected/update-status-zh.json`) shows `percent` and `version` carried unchanged through every phase including `error` — the number is not a promise.

### apps/desktop/tests/host-update-tasks.spec.ts
- Purpose: How the Host protects running work when the desktop app wants to restart.
- Key abstractions: `installDesktopUpdateTaskControl(ctx)`; a `JobRegistry` whose only served member is the per-owner roster; `AgentState` with `inbox.nextTurn` / `inbox.nextStep`.
- Data flow: inspect → count running agents, queued turns/steps, global and agent-owned jobs → admission lock → drain admitted requests → re-check the task set → release.
- Non-obvious design decisions: Reads are never warned about, only writes are locked. "drains admitted requests before completing the lock" (line 85) — new requests get a refusal while in-flight ones finish. "detects task creation by an admitted write before handing off the lock" (line 114): a task created *during* the confirmation window is discovered, so the restart is refused rather than racing the new task.
- Edge cases / failure handling: Unavailable task services are **not** classified as idle (a failure must not read as "nothing is running"); a draining lock invalidated by unlock or disposal is rejected; request accounting is released even when the bridge rejects; disposal removes admission and refuses further inspection.
- Surprising: The registry fake serves only the caller's own roster, so the test proves the *per-owner* boundary rather than a global count.

### apps/desktop/tests/mandatory-update-policy.spec.ts
- Purpose: The client for a server-forced ("mandatory") update decision.
- Key abstractions: `DesktopMandatoryUpdatePolicy(config, identity, publish, request, clientSource)`; a config carrying `origin`, `allowedPageOrigins`, `allowedAuthOrigins`, `authentication`, `intervalMs`, `timeoutMs`, `maxBackoffMs`, `jitter`.
- Data flow: request → flattened `40005` body (or a clearance `code: 0`) → publish a policy state → the mandatory window renders it.
- Non-obvious design decisions: The check sends **installed release headers** and a fixed Nightly channel plus a freshly sampled language and UTC offset on *every* request (so the server can target by locale). A `422` is treated as a policy decision, not a transport failure. "does not clear a block on HTTP 500 carrying a nominal success body" — a success body inside an error status is not a clearance.
- Edge cases / failure handling: A stalled request is aborted at its own deadline and retried with bounded backoff; a test-auth expiry does **not** drop a known block; disposal awaits cancellation and suppresses late publications; disposed-before-microtask starts no network work at all.
- Surprising: "does not infer login from HTML or unrelated 401" — the client refuses to guess authentication mode from a response body, because a wrong guess silently turns an anonymous deployment into a login prompt.

### apps/desktop/tests/cos-operation.spec.ts
- Purpose: Prove that a COS operation has a *total* deadline that covers the SDK's own retries.
- Key abstractions: `cosOperation(cos, totalMs, () => cos.someCall(...))`; a loopback origin; fake timers for the deadline only.
- Data flow: SDK call → SDK internal retry → the operation's deadline fires → the underlying request is aborted and closed → a `TimeoutError` rejects.
- Non-obvious design decisions: "aborts a stalled versioning retry within the original operation budget" (line 37) — the deadline is *total*, not per attempt, because the SDK's retry policy would otherwise multiply it. "aborts an active download despite ongoing data" — bytes arriving do not extend the budget, because a slow trickle is still a stall for the operator.
- Edge cases / failure handling: The aborted signal prevents the SDK from opening sockets for later retry attempts (the request count stays at 2, not 3). A PUT awaiting confirmation is aborted without resending the object. The deadline is cleared after success and does not affect a second, independent client.
- Surprising: Only `setTimeout`/`clearTimeout` are faked — socket delivery and stream close stay real, so the test observes the actual connection teardown rather than a simulated one.

### apps/desktop/tests/cos-loopback.ts
- Purpose: Capture what the *real* COS SDK actually puts on the wire.
- Key abstractions: `startCosLoopback(responder)` → `{ requests, redirect(cos), close() }`; `answer(socket, status, body, headers)`; `cosError(code, message)`.
- Data flow: the SDK builds a signed URL → the `before-send` hook rewrites only the origin to `127.0.0.1` → the server records method, path, headers and exact body bytes.
- Non-obvious design decisions: The signed URL is captured *before* the rewrite, so a test can assert on the signature the SDK would have produced. `close()` rejects with the first responder failure so a silent reply error cannot be swallowed.
- Edge cases / failure handling: `connection: close` on every answer prevents socket reuse from hiding a second request; `closeAllConnections()` is called so a pending read cannot hold the test open.
- Surprising: This is the only way to test a real SDK's serialisation — mocking `cos.putObject` would never have caught a missing `x-cos-forbid-overwrite` header or a wrong Content-Length.

### apps/desktop/tests/packaging-run.spec.ts
- Purpose: The run recorder that every packaging stage writes into.
- Key abstractions: `createPackagingRun(root, options)` → `{ directory, run(stage, command, argv, options), finish(ok) }`; `packagingOutputRedactor(secrets, sink)`.
- Data flow: stage → spawn → stdout/stderr → redactor → `events.jsonl`; the summary becomes `result.json`.
- Non-obvious design decisions: "redacts credential values across every byte split" (line 11) — the test tries **every** split point of the byte stream, because a secret split across two chunks is the classic way a streaming redactor leaks. A stage deadline is recorded separately from the child's exit, and a failed child prevents any later stage.
- Edge cases / failure handling: "fails closed when the output journal cannot be written" — if the audit file cannot be written, the run fails rather than continuing unrecorded. Parallel Mac stages attribute their output and the run cannot finish until both settle.
- Surprising: A fatal marker kills the stage *and its descendant*, which is the only way a supervised build cannot leave an orphaned signer holding a hardware token.

### apps/desktop/tests/desktop-publish-record.spec.ts
- Purpose: The audit trail and the per-channel exclusion lock for publication.
- Key abstractions: `withDesktopChannelLock(root, destination, action)`; `createDesktopPublicationRecord(root, identity)` → `{ directory, record(event), finish(state) }`; `wasDesktopAttemptPublished(root, identity)`.
- Data flow: intent → before/after bytes → terminal state, all written under `operation.json`, `events.jsonl` and `result.json` **outside the checkout**.
- Non-obvious design decisions: "persists intent, before/after bytes and terminal state outside the checkout" (line 42). The lock is per *channel* (`bucket/mac` vs `bucket/win`), so independent channels do not block each other, and a failed action still releases the lock.
- Edge cases / failure handling: "recognizes feed completion even when the later tag failed" — a `feeds-complete` event plus `tag-pending` still counts as published, so a retried publish does not re-upload the feed. An interrupted initialisation (a `.initializing-interrupted` directory) is ignored rather than misread as a completed attempt.
- Surprising: The lock is exercised by spawning a **real second process** (`--import tsx/esm --input-type=module -e`), not by a second promise in the same process, because a promise-based lock cannot model two processes.

### apps/desktop/tests/desktop-publish.spec.ts
- Purpose: The publish algorithm: which objects are written, in which order, and what happens on partial failure.
- Key abstractions: `publishDesktopRelease(plan, operations)` with an injected transport (`read`/`put`), `record` and `tag`.
- Data flow: binaries first → channel metadata last → each write verified by readback → tag only for production.
- Non-obvious design decisions: "recovers an ambiguous binary write without repeating it or publishing the feed early" (line 49) — if the connection drops *after* the server stored the bytes, the retry must not rewrite and must not publish the feed before the binary is confirmed. "reports published but tag pending and retries only the tag" (line 63): the status is `published-tag-pending` and the retry touches nothing but the tag.
- Edge cases / failure handling: A differing remote binary is a `conflict`; a *newer* remote feed is `superseded` — both stop with zero writes. A channel that changes between preflight and write is `remote-changed`. A readback that cannot confirm a binary is `verification-failed` and the channel is not updated. A files-only plan or a dirty-tree production build is `invalid-plan`.
- Surprising: "never equates 100 percent with readiness" has a publishing analogue: a binary write that returns success is not published until the *readback* hashes equal the local digest.

### apps/desktop/tests/windows-signing-state.spec.ts
- Purpose: A persistent, filesystem-based interlock that admits exactly one hardware-signing process at a time.
- Key abstractions: `beginWindowsSigningAttempt({ runDirectory, stateDirectory, target })` → `{ success() }`; a slot file in a shared state directory.
- Data flow: attempt → acquire the slot → sign → `success()` → the slot is released; a crashed holder leaves the slot taken.
- Non-obvious design decisions: "admits one independent process and retains its slot after that process exits" (line 10) — the slot is *not* released by exit, because an interrupted signing run must require an explicit human acknowledgement. "refuses hardware entry without an existing supervised run" — the interlock cannot be satisfied by inventing a directory.
- Edge cases / failure handling: Both operations (`sign-start` and `sign-success`) are recorded before completion, so a crash between them is visible in `events.jsonl`.
- Surprising: The test spawns two real child processes racing for the slot and asserts exactly one says `acquired` and one says `blocked` — a same-process mutex could not prove this.

### apps/desktop/tests/backend-controller.spec.ts
- Purpose: The lifecycle of the desktop's own backend/Host child process.
- Key abstractions: `DesktopBackendController(create, publish)` with states `starting | ready | error`; a `prepare` callback separate from `start`.
- Data flow: `start(prepare)` → prepare → create the child → await readiness → publish `ready`; `close()` → stop the child → await its exit.
- Non-obvious design decisions: "shares preparation and startup between concurrent retries" — a second `start()` returns the **same promise** and neither prepares nor spawns twice. "waits for pending preparation on close and never spawns afterward" — a close that arrives mid-prepare does not cancel the prepare but does prevent the spawn.
- Edge cases / failure handling: The original error object travels with the state, so a crash report keeps its stack and properties. A failed readiness triggers a cleanup and only *then* may a retry begin ("waits for failed ready child cleanup before preparing a retry"). A failure callback caused by an intentional stop is ignored, and a cleanup failure propagates and prevents an overlapping retry.
- Surprising: The state is `starting` for the whole preparation phase — there is no `preparing` state, so a UI cannot accidentally show "ready" mid-prepare.

### apps/desktop/tests/host-process.spec.ts
- Purpose: The private IPC contract between the Electron main process and the Host child.
- Key abstractions: `DesktopHostProcess`; a `fatal` and a `crash` event over the channel; `QUIT_INSPECTION_DEADLINE_MS`; `DesktopHostFatalError` / `DesktopHostUncleanExitError`.
- Data flow: main → fork the Host with a private profile, runtime, package-manager paths → readiness → the Host's URL and cookie → task inspections and admission changes correlated by request id.
- Non-obvious design decisions: The Host's *inspected* error is kept separate from the message it *reports*, so a diagnostic and a user-facing string cannot be confused. Only recent diagnostics are retained from a noisy child, so a crash report cannot grow without bound.
- Edge cases / failure handling: An unanswered quit inspection fails at its own deadline rather than hanging the shutdown. A malformed Platform account identity on private IPC is rejected. Teardown settles even when the executable cannot be spawned. Platform identity (a user id) is carried over IPC and credentials are cleared on shutdown.
- Surprising: The test Host is a real HTTP server, so the assertions are about the wire, not about a mocked method call.

### apps/desktop/tests/account-backend.spec.ts
- Purpose: The account sign-in projection handed to the renderer.
- Key abstractions: `accountView(state)` → the safe projection; `desktopAccountBackend(origin, request, token)` → `start`/`signOut`/`watch`.
- Data flow: Host account state → `accountView` → renderer; live expiry arrives on a separate `account/watchExpiry` stream, not in the snapshot.
- Non-obvious design decisions: The projection **drops** `token` and `codeVerifier`; a `signOutReason` in a snapshot is dropped ("does not replay an expiry reason from an account snapshot") because expiry is an *event*, and replaying it in a snapshot would sign the user out again on reload.
- Edge cases / failure handling: Any non-browser authorisation scheme (`file:`, `javascript:`, plain `http:`) throws; an unparsable `expiresAt` throws; an unknown `errorCode` throws. Only `no-response` is accepted as a login failure without discarding the projection.
- Surprising: The three logical streams (`account/watch`, `productAnalytics/watchPolicy`, `account/watchExpiry`) share one socket; the test reads the opening frames before sending data, and the analytics policy value is validated (`'invalid policy'` is treated as `false`).

### apps/desktop/tests/web-document.spec.ts
- Purpose: The local `dsh-app://` document server and the proxy to the Host's Web server.
- Key abstractions: `serveWebDocument(request, root)`, `authenticateWebHost(url)`, `forwardWebRequest(request, hostUrl, token, cookie)`.
- Data flow: renderer request → path check → static file or forwarded request → Host → response → renderer.
- Non-obvious design decisions: The entry HTML is rewritten so the boot shim (`Promise.withResolvers()`) precedes the app's own script. Connection-level headers written by the Host for *its own* transport (`transfer-encoding`, `connection`, `keep-alive`, `trailer`, `te`) are dropped from the response, but `content-type`, `cache-control` and `etag` survive.
- Edge cases / failure handling: `%2e%2e%2f` traversal is a 403; a missing asset is a 404; a request with a foreign `origin` is a 403 and is **not forwarded**. The Host's `set-cookie` is not relayed to the renderer — only the authenticated cookie value is retained from the 303 exchange.
- Surprising: The cache policy is per-route: the plugin *bundle manifest* is rewritten from `immutable` to `no-store` (because it is the thing that changes), while a chunk under `/plugins/a/…?rev=1` keeps `immutable`.

### apps/desktop/tests/platform-view.spec.ts
- Purpose: The embedded Platform (account/usage) view and its credential boundary.
- Key abstractions: `DesktopPlatformView` with a per-account `session.fromPartition`; `platformBounds` validation over IPC.
- Data flow: open → allocate a partition for the account → bootstrap the main frame with a token → inject deployment/client headers at the Platform origin → reveal the view.
- Non-obvious design decisions: The token is never placed in a URL. Deployment and client-identity headers are injected **only** at the Platform origin and are excluded from the bootstrap request. "uses disposable storage when no stable account ID is available" — an unidentified account gets throwaway storage rather than a shared partition.
- Edge cases / failure handling: Cross-origin navigation and redirects are blocked. A document closed before its load settles is never revealed, and a pending view is cancelled if the owner reloads. Sign-out destroys old documents and restores the original account partition. Cleanup is awaited before reopening, and a cleanup failure keeps the view closed instead of opening a second one.
- Surprising: A view is retained on same-document and subframe navigation but removed when the *application* document reloads — the ownership rule is finer than "navigation".

### apps/desktop/tests/preload-app.spec.ts
- Purpose: The capability surface of the application preload.
- Key abstractions: `contextBridge.exposeInMainWorld` calls, each gated on the document URL (`dsh-app://app/`) and on `process.isMainFrame`.
- Data flow: renderer → preload → IPC → main; each exposed member is scoped to a document.
- Non-obvious design decisions: "withholds the product API from same-origin child frames" (line 187) — same origin is not enough; the *frame* must be the application top frame. The embedded mandatory UI is installed only in the Windows application document, and the platform document gets only the update status and one native confirmation action.
- Edge cases / failure handling: Foreign shell documents, remote pages and `https://shell/startup.html` are rejected. The directory picker reports host paths of picked files only to the local application document.
- Surprising: Guest browser input is forwarded only for the focused live webview *lease*, and the lease is released on navigation — a capability that follows focus rather than being ambient.

### apps/desktop/tests/policy-test-auth.spec.ts
- Purpose: The test-only Feishu login used to satisfy a mandatory-update policy.
- Key abstractions: `DesktopPolicyTestAuth` with a `session.fromPartition` memory session and a sandboxed `BrowserWindow`.
- Data flow: explicit user action → placeholder document → remote login page in the isolated session → cookie → the policy check succeeds.
- Key abstractions (2): The session is shared with the policy fetches, but **no login is opened automatically** — the login is a user action, and a failed check does not open a browser window by itself.
- Edge cases / failure handling: `will-navigate` and `will-redirect` to unapproved targets are refused without logging OAuth data. Child-frame escapes, permission requests, downloads, new windows and HTTP authentication are all rejected. A login closed while the placeholder is still loading cancels without starting the remote page. Cancellation is reported once and a fresh retry is permitted.
- Surprising: Only the Feishu login window opens DevTools on a single F12 keydown — a deliberate limit on how much native surface a test path can reach.

### apps/desktop/tests/crash-report.spec.ts
- Purpose: The crash report the user is pointed at when the app cannot start.
- Key abstractions: `writeCrashReport`, `renderCrashReport`, `pruneCrashReports`, `crashReportFileName`, `RendererConsoleTail`, `ERROR_SECTION_MAX_CHARS`.
- Data flow: a fatal error → a facts header + inspected error (with its properties and `[cause]`) + the renderer console tail → an owner-only file named `crash-<sortable-time>-<source>.log`.
- Non-obvious design decisions: The Host's own diagnostic is printed **verbatim** in its own section when the Host reported one, clearly separated from the app's error. An oversized error section is cut with an explicit "cut" marker rather than being silently truncated.
- Edge cases / failure handling: A missing logs directory is nothing to prune; only the oldest reports are pruned and other files are left alone; a report that cannot be written returns `undefined` and logs instead of throwing; the newest renderer-console lines are kept within the byte cap and a line is never cut in half.
- Surprising: The file name sorts lexicographically by time, so a directory listing of crash reports is chronological without a sort step.

### apps/desktop/tests/fatal-recovery.spec.ts
- Purpose: The "DeepSeek Harness is unavailable" dialog.
- Key abstractions: `DesktopFatalRecovery`; `CRASH_REPORT_WAIT_MS`; the operations it may call (`stop`, `disablePlugins`, `exit`, `restart`, `writeReport`).
- Data flow: fatal failure → write the report (bounded) → show the dialog → wait for the shutdown → perform the chosen action.
- Non-obvious design decisions: "locks the first report before the dialog settles and never resets after an action" — the report is written once, for the first fatal failure, not again for a recovery-failure redisplay. The dialog waits for the report to settle before showing, but not longer than the report deadline.
- Edge cases / failure handling: A user-requested disable failure is reported and exit is still allowed. Exit is allowed after shutdown cleanup fails. A listener conflict (another DSH instance) offers **only** exit and restart, on every platform.
- Surprising: The report line is kept inside the detail budget even when the error is long, so the dialog never grows unbounded.

### apps/desktop/tests/update-dialog.spec.ts
- Purpose: The ordinary (non-mandatory) update confirmation dialog.
- Key abstractions: `DesktopUpdateDialog` with `UPDATE_DIALOG_IPC`; `DesktopUpdateOverlays` for the backdrop.
- Data flow: coordinator state → presentation → dialog window (380px card, 24px corners, black primary button per the README) → a chosen button back over IPC.
- Non-obvious design decisions: "accepts only a displayed choice from its own main frame and retains cancellation outside the button list" — a response whose id is not a visible button is a cancellation. On Windows the visible modality is released *before* the dismissed dialog is destroyed.
- Edge cases / failure handling: The dialog cancels on abort, renderer failure, disposal or an already-closed parent. Navigation away from the owned document is denied. The locale is re-read for each presentation, so a mid-session language change is honoured.
- Surprising: "replaces content without releasing the backdrop and rejects a response from the previous prompt" — a stale click on a replaced prompt cannot accept the new one.

### apps/desktop/tests/update-error-renderer.spec.ts
- Purpose: The renderer scripts for the update dialog and the mandatory page, exercised in JSDOM.
- Key abstractions: `UpdateDialogView` / `MandatoryUpdateView`; the real `renderer/update-dialog.js` and `renderer/mandatory-update.html`.
- Data flow: view state → DOM (folded disclosure, buttons, copy address) → the user.
- Non-obvious design decisions: "keeps ordinary diagnostics folded, text-only, and keyboard-accessible" — the details are in a disclosure, not a tooltip, so a screen reader can reach them. Mandatory diagnostics are expandable **without** clearing the block or authorizing installation.
- Edge cases / failure handling: The complete selectable address is revealed only after a copy failure, and it does not replace the updater's own diagnostics. Server-supplied markup is rendered literally in a dedicated safety case (never as HTML).
- Surprising: The same modal is used for download, verification, inspected confirmation and the task-aware restart — one surface, four states.

### apps/desktop/tests/update-overlay.spec.ts
- Purpose: The overlay window that covers the app for an update.
- Key abstractions: `DesktopUpdateOverlays.create(parent, owner, title, mandatory)`.
- Data flow: create → wait for a visible parent *and* a ready document (either order) → show → on parent show, restore → on close, release visibility ownership.
- Non-obvious design decisions: "waits for both a visible parent and a ready document, in either order" — the two readiness signals are independent and the overlay handles both arrival orders. "blocks each parent until its last owned overlay closes and invalidates each transition" — nested overlays must all release before the parent is usable.
- Edge cases / failure handling: A window closed before its document is ready shows nothing and does not touch the parent's styles. A macOS overlay is released even if the parent has already been destroyed.
- Surprising: On macOS the mandatory overlay is stationary and blocks parent keyboard input until it closes; the same class on Windows publishes into the main document instead.

### apps/desktop/tests/update-attention.spec.ts
- Purpose: Getting the user's attention when an update is ready but the app is in the background.
- Key abstractions: `DesktopUpdateAttention`; per-platform behaviour (Windows `flashFrame`, macOS `dock.bounce`, a silent `Notification`).
- Data flow: ready → if the window is not focused, raise one silent notification → the click returns the user to the confirmation.
- Non-obvious design decisions: "requests one silent reminder and returns to confirmation without installing" — the notification never installs anything; it only navigates back. A second `ready()` while the first notification is live does not create a second notification.
- Edge cases / failure handling: A click on a stale notification is ignored after a focus event cleared it. A foreground app is not notified at all. A system that rejects notifications still gets the icon attention (the dock bounce is not cancelled). The focus listener is removed on every exit path.
- Surprising: `Notification.isSupported() === false` degrades to the flash/bounce rather than to nothing.

### apps/desktop/tests/mandatory-update-window.spec.ts
- Purpose: The window that blocks the app until a mandatory update is handled.
- Key abstractions: `DesktopMandatoryUpdateWindow`; `MANDATORY_IPC`; a version-bound second click inside the same modal.
- Data flow: policy state → window → the user defers or confirms → the window updates or closes.
- Non-obvious design decisions: "waits for a version-bound second click in the same modal and rejects obsolete or hidden responses" — a confirmation is bound to the policy version it was shown for; an answer for a superseded policy is refused. Deferral does not dismiss the window and cancels any pending approval on policy clearance or disposal.
- Edge cases / failure handling: "offers copy immediately while browser opening is pending" — the address is available without waiting for the browser. A clipboard failure is reported separately from a navigation failure. Closing the window exits the application **without** clearing the policy. On Windows the overlay is published into the main document instead of creating a second native window.
- Surprising: "exits the application when the mandatory window is closed without clearing the policy" — closing the block is not a way to defeat it; the policy survives the window.

### apps/desktop/tests/quit-confirmation.spec.ts
- Purpose: The "are you sure?" prompt on quit, whose copy depends on what is running.
- Key abstractions: `resolveDesktopQuitPrompt(inspection)` → one of four prompts; `DesktopQuitConfirmation`.
- Data flow: inspect the Host → choose the prompt → show → answer → quit or cancel.
- Non-obvious design decisions: Four distinct prompts (`quitActiveTasks`, `quitScheduledTasks`, `quitActiveAndScheduledTasks`, and a conservative fallback) rather than one generic warning; the fallback is the *active* prompt, the most alarming truthful one. "joins an open confirmation instead of stacking a second one and inspects once per decision" — a second request returns the same promise and does not re-inspect.
- Edge cases / failure handling: If the inspection itself fails, the app warns about running tasks (the pessimistic reading) and logs the failure. A pending decision resolves to `false` without showing a box once the object is disposed, and a box answered *after* disposal does not approve the quit.
- Surprising: The macOS alert uses `noLink: true` and puts "Quit" as the default right-hand button; the Windows variant uses the application icon and `type: 'none'`.

### apps/desktop/tests/core-package-set.spec.ts
- Purpose: The local package set the desktop app ships, and the lockfile that must agree with it.
- Key abstractions: `parseDesktopCorePackageSet`, `verifyDesktopCorePackageSet`, `verifyDesktopCoreLockfile`, `desktopDshPackageSpec`, `desktopCorePackageOverrides`.
- Data flow: `desktop-packages/*.tgz` + `desktop-package-set.json` → verified descriptors → pnpm `file:` overrides in the lockfile.
- Non-obvious design decisions: The descriptor list must be sorted by name and every internal package must be pinned to a local tarball; a registry resolution for a name the local set owns is rejected ("outside the local package set"). Version drift, descriptor disorder, corruption and extra files are each a distinct error.
- Edge cases / failure handling: The integrity check is `sha512-<base64>`; a file whose bytes changed fails with `integrity check failed`; an unexpected extra file in the package directory fails with `does not match its descriptor`.
- Surprising: The lockfile check is a *second*, independent door — a set can verify on its own and still be refused because the lockfile resolves one of its names from the registry.

### apps/desktop/tests/runtime-tree.spec.ts
- Purpose: The descriptor that seals a Desktop runtime, and when it is checked.
- Key abstractions: `readDesktopRuntime` (cheap, start-up safe) vs `verifyDesktopRuntime` (expensive, build-time only); `DESKTOP_RUNTIME_FILE`, `runtimePath`.
- Data flow: `writeDesktopRuntime` → `desktop-runtime.json` → `readDesktopRuntime` at start-up, `verifyDesktopRuntime` at build verification.
- Non-obvious design decisions: The split is explicit and load-bearing: `readDesktopRuntime` returns the descriptor *unchanged* even when the bytes no longer match, and only `verifyDesktopRuntime` performs the integrity, release-compatibility and shared-manifest checks. That is why a damaged install can still start (and then be repaired) instead of refusing to boot.
- Edge cases / failure handling: Filesystem links are rejected ("unsupported filesystem entry"); a shared package record that maps outside `node_modules` is rejected; recorded executable permissions are only checked on Unix; nonportable paths (`../outside`, `/absolute`, `C:/absolute`, `a\b`, `a//b`, `./a`) are refused.
- Surprising: The descriptor survives relocation: the same runtime copied to another directory verifies identically, because nothing in it is a build path.

### apps/desktop/tests/command-installation.spec.ts
- Purpose: Installing, repairing and removing the `dsh` command on the user's PATH.
- Key abstractions: `inspectFileCommand`, `installFileCommand`, `removeFileCommand`, `prepareCommandLink`; a receipt naming the owned link and its backup.
- Data flow: inspect → user confirms with a fingerprint → move the current command to a backup → install the Desktop link → write the receipt (or restore the backup on failure).
- Non-obvious design decisions: "rejects a changed confirmation without moving the replacement" — the decision carries a fingerprint of what it saw, so a command that changed in the meantime is not silently overwritten. A command installed by someone else is left intact. A modified backup is refused rather than restored.
- Edge cases / failure handling: A replacement arriving *during* install or removal is preserved. When receipt publication fails during a repair, ownership and the original inode are retained. Both removal and restoration failures are retained together, with the link location. Simultaneous choices are serialised so only one stale snapshot can install.
- Surprising: "preserves the raw target of an existing relative npm link and restores it" — the exact link target text is kept, not a resolved absolute path, so a relative npm link keeps working.

### apps/desktop/tests/command-manager-flow.spec.ts
- Purpose: The user-facing flow of the "Manage dsh Command" dialog.
- Key abstractions: `DesktopCommandManager`; a real worker process with only the OS mutation boundary substituted.
- Data flow: menu → dialog → the user chooses Install/Repair/Remove → the worker prepares → elevation prompt → the mutation → the result.
- Non-obvious design decisions: "passes the displayed fingerprint and reports a stale worker refusal" — the fingerprint travels from the dialog to the worker. "repairs its own selected command without a switch confirmation" but "keeps confirmation when repairing a command shadowed by another installation" — repairing something you own is silent; repairing something else needs consent.
- Edge cases / failure handling: Repeated menu clicks are coalesced and the update preparation waits for the active decision. AppleScript's real stdout/error transport is exercised (including the cancelled-authorisation error `-128`) without actually authorising a mutation.
- Surprising: The elevated command is executed with `with administrator privileges` stripped in the stub, so the *transport* is real while the *privilege* is not.

### apps/desktop/tests/desktop-bundle-imports.spec.ts
- Purpose: A bundler plugin that fails the build when the packaged app imports something it does not ship.
- Key abstractions: `packagedImportsPlugin(policy)`; `BundleImportPolicy` = `{ packages: Set<string>, nodeBuiltins: boolean }`; `importPackageName`, `isBareSpecifier`, `unpackagedImports`.
- Data flow: source → rolldown → the plugin inspects every external import → an unshipped one aborts the bundle with a named message.
- Non-obvious design decisions: The main process may import Node builtins; the **sandboxed preload may not** (only `electron`, `events`, `timers`, `url` are allowed). The policy is expressed as a list of permitted packages plus a builtin flag rather than a denylist, because a denylist is a running list.
- Edge cases / failure handling: Static, dynamic `import()` and CommonJS `require()` are all checked — three different ways to smuggle an import past a bundle step. Each offending specifier is reported once, in import order.
- Surprising: The test bundles with `external: () => true`, which is exactly what an unresolved workspace `lib/` output produces — the check runs against the shape that actually occurs in the build.

### apps/desktop/tests/installed-update-qualification.spec.ts
- Purpose: The evidence model for an installed update: a run manifest, a journal, and an inspector.
- Key abstractions: `createInstalledUpdateRun`, `readInstalledUpdateRun`, `inspectInstalledUpdateJournals`, `collectInstalledUpdateJournals`; the journal is written by the real `DesktopUpdateJournal`.
- Data flow: journal → inspector → a report with `recordedFlow` and `operatorAcceptance: pending` → `collect` copies validated bytes into a fresh `evidence/collection-*` directory with SHA-256.
- Non-obvious design decisions: "reads real journal output while keeping observed flow separate from installation and data acceptance" — `recordedFlow: complete` is not acceptance. "does not join original-process fragments or count a successor startup by itself": a successor that started before the original quit does not count. "does not accept an already-running successor as evidence of a later restart".
- Edge cases / failure handling: A connection failure is distinguished from an interrupted transfer *with recorded progress*. Rejected journal shapes are enumerated: `partial`, `unknown-fields`, `wrong-sequence`, `mixed-version`, `invalid-json`, `unknown-phase`, `mixed-pid`, `raw-error`, `raw-operation`, `action-phase`. An oversized file or snapshot is refused before collection.
- Surprising: The collection copies only the journal bytes and never copies other files, settings, conversations, build output or credentials; and the report always says `operatorAcceptance: pending`.

### apps/desktop/tests/keyboard.spec.ts
- Purpose: The largest behavioural spec in the shard: shortcut registration, native accelerators, chord interception and guest input routing.
- Key abstractions: `ShortcutRegistry`, `installKeyboard` (renderer) and `installNativeKeyboard` (main); a `DesktopBrowserLeaseId`/`Reservation` for embedded guests.
- Data flow: a binding definition → a renderer registry and a native menu accelerator → an intercepted chord → the owner of the focused frame.
- Non-obvious design decisions: "blocks macOS shortcuts while an update overlay loads and clears held and consumed keys before dismissal" — a blocked overlay must also release the keys it swallowed, or the user's next keystroke is lost. "blocks approved browser guest input across update overlays, including guests attached while blocked" — a guest that attaches *during* the block is still blocked.
- Edge cases / failure handling: "consumes a held single-key repeat after focus reset without treating it as a fresh press" and "delivers a fresh unbound key release after macOS omitted the previous Command character release" — these are the two classic macOS/Electron key-release races. Native window closure is guarded by revision and focus. The native menu is refreshed only when an accelerator or its availability actually changes.
- Surprising: "restores a text input and its selection before opening a keyboard menu" — opening a native menu from a keyboard shortcut must not lose the caret.

### apps/desktop/tests/main-startup.spec.ts
- Purpose: The whole desktop main entry: window creation, Host startup, update flows, quit, crash recovery and IPC ownership.
- Key abstractions: fake `BrowserWindow`/`Host`/`powerMonitor` doubles; the `DESKTOP_IPC` and `MANDATORY_IPC` handler tables; `DesktopUpdateState`.
- Data flow: startup → package-manager selection → Host launch → welcome/workspace → IPC handlers → update and quit flows → recovery.
- Non-obvious design decisions: "prepares recovery offscreen and starts one Host before choosing the first visible window" — a failing start must not flash a half-built window. "hides the workspace before intentional Host shutdown can look like reconnection". "holds boot injections until the Host is ready and rejects foreign boot callers". "accepts product IPC only from the current application top frame in the owned main window".
- Edge cases / failure handling: "rechecks admission after approval and rejects work that started during confirmation" — the same discipline as the Host's own admission lock. A Host whose failed stop has not confirmed process exit is not replaced. A replacement startup failure is reported without authorizing installation or retrying automatically. Platform storage cleanup is awaited before an ordinary quit completes, and a cleanup failure is reported as a preparation failure without stopping the Host.
- Surprising: "shares the failed-check deadline across focus and resume, while explicit checks reset polling" — an automatic check and a user-initiated check share one deadline, but an explicit check resets the automatic one.

### apps/desktop/tests/settings.spec.ts
- Purpose: The desktop settings file and how it handles an older or broken document.
- Key abstractions: `readDesktopSettings(userData)` → `{ updates: { allowTestAuthPopupWindow } }`.
- Data flow: missing file → create a discoverable default; existing file → read and default missing fields.
- Non-obvious design decisions: An older document is **defaulted without being rewritten** (`'{}'`, `'{"updates": {}}'` and an unknown-key document all keep their exact bytes). An invalid document is reported with its path and left exactly as it was. The defaults are returned even when the warning output itself fails.
- Edge cases / failure handling: A filesystem error (including `settings.json` being a directory) is reported instead of replacing the settings, and the defaults still apply. A failure to `mkdir` or to `writeFile` continues with disabled popups.
- Surprising: The default file is written with a stable pretty-printed form (`{\n  "updates": {...}\n}\n`) so a first-run diff is readable and the test can assert the exact bytes.

### apps/desktop/tests/keybindings.spec.ts
- Purpose: Persisting and reading keyboard shortcuts.
- Key abstractions: `desktopKeybindings(userData, platform, publish)`; a `ShortcutConfigSnapshot` with a `revision`.
- Data flow: definitions → `readCurrent` → an edit carrying the current revision → `keybindings.json` → re-read.
- Non-obvious design decisions: A **future** schema version is reported as `error: 'future'` and the file is left byte-identical — the app refuses to interpret it *and* refuses to rewrite it. An edit against a stale revision is refused with `status: 'unreadable'`.
- Edge cases / failure handling: A null binding is persisted and reloaded as `null` (an explicit "no shortcut", not an absent one).
- Surprising: The test writes `{"schemaVersion":7,"custom":"retain exactly"}` by hand and asserts the bytes survive — the future-version path is about preserving a *user's* file, not about a version check.

### apps/desktop/tests/expected/update-guidance-en.json
- Purpose: The snapshot of every state the mandatory/ordinary update guidance can be in, in English.
- Key abstractions: seven states — update-to-continue, ready, tasks-in-progress, preparing-restart, error-with-retry, and no-compatible-update.
- Data flow: policy state → the title/detail/version/action set → the renderer.
- Non-obvious design decisions: The "tasks in progress" state has **two** actions (`Stop tasks and update` / `Update later`) while the "ready" state has one (`Install and Restart`). The error state adds a `page` action and a `browser-message`/`copy-message` pair for the case where the browser cannot be opened.
- Edge cases / failure handling: The no-compatible-update state has an empty `version` and offers a copy-the-link fallback with an explicit message that the link must be selected manually.
- Surprising: The copy is split so that *both* fallbacks are available at once — open the page, and if that fails, copy the address — rather than a single "open the website" button that fails silently.

### apps/desktop/tests/expected/publication-production.md
- Purpose: The human approval summary a publisher reads before a production release.
- Key abstractions: a field table (environment, version, channel, platform, download preview, update YAML, packaging source, signature/notarization, git tag), the "what will happen after approval" list, and a `<details>` block with the per-file size/SHA-256 table.
- Data flow: retained release + upload plan + approval digest → this markdown → a GitHub deployment review.
- Non-obvious design decisions: URLs are HTML-escaped (`https&#58;//`) so the markdown cannot be re-parsed into a link. The approval digest's SHA-256 is printed so the approver can compare it with the publisher's copy. The last line warns that in a public repository the download path and the test release ID become public and that the random prefix is not access control.
- Edge cases / failure handling: "重新校验产物与发布目标；若与审批摘要不一致则停止" — the artifacts are re-verified after approval and the operation stops if they differ from the summary.
- Surprising: The production summary is the only one with a `Git tag` row; the test summaries carry the test release ID and an explicit "本次只发布 test，不修改 production" line.

### apps/desktop/tests/desktop-publish-route.spec.ts
- Purpose: Deciding which machine may publish a given packaging run.
- Key abstractions: `resolveDesktopPublishRoute(repo, run, retained, jobs, routes)`; a route table `{ runnerName: { label, target } }`.
- Data flow: a GitHub run + its jobs + the retained release → a validated route.
- Non-obvious design decisions: Every piece of evidence must agree — attempt, repository, commit, workflow file, qualification mode, runner name. Failing closed is explicit: "fails closed when a publishing route or its unique label is missing", and a duplicated label is an error, not a tie-break.
- Edge cases / failure handling: "keeps the packaged source separate from the workflow commit" — the commit that was built and the commit the workflow ran are different facts and both are carried. A repository-branch package is allowed for test and rejected for production ("Production source").
- Surprising: Unrelated successful jobs on the packaging machine are ignored — only the job named `package` counts.

### apps/desktop/tests/desktop-package-environment.spec.ts
- Purpose: The local packaging configuration: which file owns which setting, and what is checked before signing.
- Key abstractions: `loadDesktopPackageEnvironment`, `localMacOSPackageEnvironment`, `validateDesktopPackageEnvironment`, `resolveWindowsPackageSettings`.
- Data flow: platform file → merged environment → validation → the packaging subprocess.
- Non-obvious design decisions: Each platform *owns* its release ID in its own file, and a value in the parent environment is excluded so a stale ambient setting cannot leak into a build. "checks application and update configuration before Windows credentials" — the cheap checks run first.
- Edge cases / failure handling: Cache concurrency accepts only `1`, `2`, `4`, `8`; `01`, `1.5`, `Infinity` and `-1` are rejected. Only one local npm registry mirror form is accepted. An unsigned macOS build does not need Apple credentials but an *unnotarized signed* build still does.
- Surprising: "requires the local file even when ambient configuration exists" — the platform file is mandatory, so a build cannot silently inherit a developer's global environment.

### apps/desktop/tests/fixtures/local-updater.mjs
- Purpose: A real Electron run of the updater, the coordinator, the mandatory policy and the dialogs.
- Key abstractions: `DesktopUpdateCoordinator`, `DesktopMandatoryUpdatePolicy`, `DesktopMandatoryUpdateWindow`, `DesktopUpdateHttpExecutor`, `presentDesktopUpdate`; a private `userData` root.
- Data flow: a loopback feed → the real `NsisUpdater` → the coordinator → a dialog → an observed screenshot and an intercepted installer call.
- Non-obvious design decisions: "installer execution is forbidden" — `quitAndInstall` is replaced by an observation, so the qualification can never install anything.
- Edge cases / failure handling: The fixture records which scenarios ran and which did not, and the README treats "the installer call, external browser and clipboard are observation substitutes" as part of the evidence limits.
- Surprising: It drives the **real** `electron-updater` HTTP stack (not a fake), so a broken header or a wrong content type is caught.

### apps/desktop/tests/fixtures/workspace-updates.mjs
- Purpose: The real compiled main entry, preload, shared Web Host and local updater, with only three modules substituted.
- Key abstractions: `registerHooks` to swap `./update-coordinator.js`, `./host-process.js` and `./update-error.js` for the fixture adapters; a real `NsisUpdater` whose `quit`/`relaunch` throw.
- Data flow: the real main → the substituted coordinator → the real window → the operator's clicks → the recorded installation.
- Non-obvious design decisions: The substitution is done at the **module resolver** level for exactly three specifiers, so everything else (the real renderer, the real preload, the real Host) still runs.
- Edge cases / failure handling: `updater.disableDifferentialDownload = true` and `disableWebInstaller = true` keep the qualification on the safe path.
- Surprising: `app.setAppPath(application)` and a private `userData` make the real main entry believe it is running an installed desktop app.

### apps/desktop/tests/fixtures/host-update-qualification.mjs
- Purpose: The built Host running a real profile, a real model adapter and the real task control.
- Key abstractions: `runProfile` with a layered env and a resolved profile directory; a `HeldModel` LLM adapter that yields one tool call and then blocks on an abort signal.
- Data flow: the Host starts → a model request is held → the qualification creates a queued task → the update-task control counts it and locks admission.
- Non-obvious design decisions: The model is the *only* substitution ("Only model responses and human answers are substituted"); everything else — the profile Loader, the agent presets, the task services, the Node background processes — is real.
- Edge cases / failure handling: Two independent invocations pass concurrently with private profiles and session data, and the success report is written only after every owned agent, job and Host has finished.
- Surprising: The held model's `stream()` yields a `block-start`/`block-end` tool-call pair and then a `finish` with `reason: { kind: 'tool-calls' }` — the fixture speaks the real streaming protocol, so the loop's own parsing is under test.

### apps/desktop/tests/fixtures/mandatory-frame.mjs
- Purpose: Driving the mandatory-update UI inside the real Windows parent window.
- Key abstractions: `mandatoryFrame(parent)` (wait for the frame and `readyState === 'complete'`) and `mandatoryFrameDriver(parent)` (a proxy that redirects input to the frame).
- Data flow: parent → locate the `dsh-app://shell/mandatory-update.html` frame → attach the Chromium debugger → dispatch `Input.dispatchMouseEvent` at the frame's coordinates.
- Non-obvious design decisions: The mouse Y coordinate is offset by `WINDOWS_TITLEBAR_HEIGHT`, because the frame's own coordinates do not include the native caption. A 10-second deadline turns "the frame never loaded" into a named error rather than a hang.
- Edge cases / failure handling: `isDestroyed` is proxied to the frame's `detached` flag, so a closed frame is detected even though the parent is still alive.
- Surprising: The proxy keeps `executeJavaScript`, `sendInputEvent` and `isDestroyed` on the *frame* while everything else stays on the parent — one object, two targets.

### apps/desktop/tests/fixtures/signed-updates.mjs
- Purpose: Real Electron download, checksum, Authenticode publisher verification and coordinator recovery.
- Key abstractions: `NsisUpdater` with `publisherName` in a per-case `app-update.yml`; `resolveWindowsUpdatePublisher`; `createArtifactUpdateServer`.
- Data flow: a synthetic feed → a real download → SHA-512 → Authenticode → readiness → a separate installation handoff.
- Non-obvious design decisions: The publisher name is written into each case's `app-update.yml`, so the *updater* does the verification, not the test. "installer execution is forbidden" again.
- Edge cases / failure handling: The scenarios are valid-hash-with-wrong-publisher, valid-hash-unsigned, corrupt-transfer (rejected *before* signature verification) and an explicit retry to signed readiness.
- Surprising: The report records `installerExecuted: false` as a field, so a reader can see the boundary rather than infer it.

### apps/desktop/tests/fixtures/update-server.mjs
- Purpose: A loopback update feed with deterministic transport failures.
- Key abstractions: `createUpdateServer()` → a URL, `select(mode, version)`, `policy(mode)`, request barriers, an observed request log.
- Data flow: the updater → the feed (`/nightly.yml`) and the policy endpoint (`/api/v0/check_client_update`) → the mode-dependent answer.
- Non-obvious design decisions: The policy endpoint returns the flattened `40005` body with `show_content` and `desktop_app_link`; the feed can be stalled or corrupted independently of the policy.
- Edge cases / failure handling: `Cache-Control: no-store` on every reply, and a `stall` mode that never answers — the deadline is exercised against a real hanging connection.
- Surprising: The policy and the feed live on the *same* loopback origin, so a test can make the policy succeed while the feed stalls and observe which one the client waits for.

### apps/desktop/tests/fixtures/update-overlay-visibility.mjs
- Purpose: Qualifying that an update overlay is actually visible and that the parent stays unfiltered.
- Key abstractions: `DesktopUpdateOverlays` from the built `lib/types/update-overlay.js`; a private profile.
- Data flow: create a parent → create an overlay → wait for readiness → toggle the parent → compare against the owner-local expected output.
- Non-obvious design decisions: The parent is loaded with a `data:` URL containing an input, so the check can prove the parent content is *not* filtered (`filter: 'none'`) and that keyboard listeners are released on close.
- Edge cases / failure handling: A 30-second global deadline names the phase it was in ("Update overlay qualification exceeded 30 seconds: parent load") instead of just timing out.
- Surprising: The results file is written under `.desktop-build/qualification/update-overlay-*` and compared against `expected/update-overlay-visibility.json`, so the qualification is reproducible from a clean checkout.

### apps/desktop/tests/fixtures/pnpm-smoke.mjs
- Purpose: Proving the packaged app can install and run a dependency with its own bundled pnpm.
- Key abstractions: `checkPnpm(resourcesRuntime)`; the packaged `primary-runtime/dependencies/pnpm/bin/pnpm.mjs`.
- Data flow: an offline `file:` dependency → the packaged pnpm → a package script → the assertion.
- Non-obvious design decisions: "Desktop must ship only primary-runtime pnpm" — the assertion fails if a second pnpm appears at the runtime root. `process.execArgv` must contain `--expose-internals`, so the smoke proves the launcher contract, not merely that pnpm ran.
- Edge cases / failure handling: The whole installation happens in a temporary directory that is removed afterwards; the scratch `npmrc` is empty to force offline resolution.
- Surprising: The script asserts `process.execPath` equals the Electron binary — the packaged pnpm must run under Electron's Node, not under a system Node.

### apps/desktop/tests/fixtures/runtime-payload-smoke.mjs
- Purpose: Proving the filtered runtime's native and HTML dependencies work under Electron.
- Key abstractions: the runtime descriptor (`desktop-runtime.json`); `checkPnpm`; a node-pty round trip.
- Data flow: the descriptor → assert node/platform/arch match → spawn a fixed Node program → assert its output → clean up.
- Non-obvious design decisions: The environment is scrubbed to `path|systemroot|windir|comspec|ELECTRON_RUN_AS_NODE` and HOME/TMP are redirected into the scratch directory, so a host credential cannot leak into the child. On Windows the PTY is launched through `ComSpec` because "a Windows GUI executable needs a console-owning shell when launched inside ConPTY".
- Edge cases / failure handling: The scratch scripts are written with `flag: 'wx'` and mode `0o600`, so an existing file cannot be overwritten.
- Surprising: The smoke asserts `process.versions.node` equals the descriptor's recorded node version — the runtime must carry the Node it claims.

### apps/desktop/tests/fixtures/command-path.ps1
- Purpose: The real Windows PATH manipulation, exercised against a private registry tree.
- Key abstractions: `Invoke-DshCommandPath` with `EnvironmentKey`, `OwnerKey` and a named mutex.
- Data flow: inspect → apply (with the expected fingerprint) → read the user's PATH back.
- Non-obvious design decisions: The registry key tree is unique per run (`Software\DeepSeekHarness\CommandTests\<guid>`) and the PATH is read with `DoNotExpandEnvironmentNames` so the raw value is compared. The script re-reads the real path after `.NET` may have expanded a short temporary directory name.
- Edge cases / failure handling: The test asserts that installing the Desktop command changed **only** the intended entry and left the npm entry intact.
- Surprising: A named mutex (`Local\DshCommandTest-<id>`) provides the mutual exclusion — the same pattern as the macOS notarization proxy, on a different platform primitive.

### apps/desktop/tests/fixtures/installed-update-network.ps1
- Purpose: Making the network-fault script testable without touching a real firewall.
- Key abstractions: PowerShell function overrides for `Get-NetFirewallRule`, `New-NetFirewallRule`, `Remove-NetFirewallRule`, `Get-NetFirewallApplicationFilter`, and `Read-Host`.
- Data flow: the real script runs with the stubs in place → the stubs record created/removed rules → a JSON summary is printed.
- Non-obvious design decisions: The `-Case` parameter selects a scenario (`creation-failure`, `existing`, `foreign`, `declined`, `restore-failure`, `restore-declined`, `status`, `changed-during-confirmation`), so every branch of the real script is exercised without a firewall.
- Edge cases / failure handling: The `foreign` case installs a rule with a different program path, so the recovery must refuse to remove it.
- Surprising: The `Read-Host` stub returns `BLOCK <run-id>` / `RESTORE <run-id>` — the confirmation protocol itself is under test, not just the rule creation.

### apps/desktop/tests/fixtures/installer-write-failure-smoke.nsi
- Purpose: Proving that a locked target file is not silently mixed with a new payload.
- Key abstractions: two modes — `DIRECT` (extract straight into the target) and extract-then-copy; a `RESULT_FILE` with `errorFlag=` and `locked=`.
- Data flow: hold `locked.txt` open for reading → run the installer silently → read the result file.
- Non-obvious design decisions: "Exit code 0 alone cannot establish successful extraction; inspect RESULT_FILE." Both modes retain "old runtime" and write "new asset" under the lock, but only the copy mode sets `errorFlag=true` — direct extraction reports `false` **despite** the mixed versions.
- Edge cases / failure handling: The comment states the expectation precisely, which is what makes the smoke a test rather than a demo.
- Surprising: This is the exact bug shape the copy mode was introduced to fix, captured as a fixture.

### apps/desktop/tests/windows-installer-progress.cpp
- Purpose: The installer's user-visible progress, as a native regression.
- Key abstractions: `ExtractionProgress` (parses a percentage stream) and `InstallProgress` (work-fraction plus tick-driven advance).
- Data flow: 7-Zip's output stream → `ExtractionProgress::Read` → the displayed percentage; work advances → `InstallProgress::Advance` → `Tick` → the caption stage.
- Non-obvious design decisions: "Progress tokens can cross pipe reads; filenames and stale redraws cannot inflate them" — the same byte stream is fed in blocks of 1, 2, 7 and 128 bytes and must always parse to 100. "Identical work fractions give the same result on fast and slow disks": the same sequence is replayed with 1 s and 10 s intervals and must produce the same values.
- Edge cases / failure handling: "A stalled extractor does not creep toward completion merely because time passes" — a stalled value stays at 48 and `succeeded` stays false. Noise that is not a percentage yields 0.
- Surprising: The completion path is tested twice, with a short cleanup and with a worker finishing between UI ticks, because the two orderings produced different frames in the field.

### apps/desktop/tests/windows-installer-extract-report.cpp
- Purpose: The installer's failure report for an extraction or directory-transaction error.
- Key abstractions: `InstallerReportExtractFailure` and `InstallerReportDirectoryFailure` (imported from the installer DLL); `extract_report` / `directory_report` namespaces.
- Data flow: a 7-Zip exit code or a Win32 error → a bounded dialog headline and excerpt → a full log file on disk.
- Non-obvious design decisions: "Extraction failure reports keep 7-Zip's evidence intact while the dialog headline and excerpt stay bounded" — the user sees a short excerpt, the log keeps everything.
- Edge cases / failure handling: The result codes distinguish 7-Zip's own exit codes, Win32 failures around its process, and raw crash statuses.
- Surprising: The regression is written in C++ and links against the installer DLL, so it exercises the shipped binary rather than a re-implementation.

### apps/desktop/tests/windows-uninstall-data.cpp
- Purpose: The uninstaller's data cleanup, and the roots it must refuse.
- Key abstractions: `uninstall_data::Remove(root, installation, ...)`.
- Data flow: a root path + the installation path → a removal or a refusal code.
- Non-obvious design decisions: The refused roots are enumerated and asserted: the test root (which contains the installation) is `ERROR_ACCESS_DENIED`, as is the user's real profile; `C:\`, a relative path and `C:\bad*` are `ERROR_INVALID_NAME`. A protected root overlapping the target in *either* direction stops removal.
- Edge cases / failure handling: The test creates a read-only `LOCK` file and a `MANIFEST` inside a Chromium `Local Storage` tree to prove the cleanup is selective.
- Surprising: `uninstall_data::Remove(profile, ...)` is refused — the uninstaller will not delete a user's home directory even when asked.

### apps/desktop/tests/windows-installer-ui.ps1
- Purpose: A native UI driver for the installer checks.
- Key abstractions: a C# `InstallerCapture` class compiled with `Add-Type`: `EnumWindows`, `EnumChildWindows`, `GetWindowText`, `GetWindowRect`, `PrintWindow`, `SetForegroundWindow`, `PostMessage`.
- Data flow: a process id → window enumeration → text search → click by control text → screenshot via `PrintWindow`.
- Non-obvious design decisions: `Initialize()` calls `SetProcessDPIAware` so the geometry comparisons are not affected by a scaled display, and `DwmFlush` is used so a screenshot is not captured mid-composite.
- Edge cases / failure handling: `PostMessage` is used rather than a synthetic mouse event, which does not steal focus from the caller's terminal.
- Surprising: The whole thing is a `TypeDefinition` heredoc inside a PowerShell script — the test needs no separate build step.

### apps/desktop/tests/windows-installer-smoke.ps1
- Purpose: The native installer acceptance run.
- Key abstractions: `Wait-Control`, `Start-Setup`, `Click-Control`, `Dismiss`, `Finish-Setup`, `Run-Silent`; the localized copy parsed out of `installer/strings.nsh`.
- Data flow: run the installer → find the control by its localized text → click → read `expected/windows-installer.json` for the scenario list.
- Non-obvious design decisions: The localized strings are parsed from the NSIS source at run time, so the assertions use the *shipped* copy rather than a duplicated string in the test.
- Edge cases / failure handling: Every wait is bounded (30 s) and throws with the process exit code or the visible text, so a failure says what was on screen.
- Surprising: "Native installation checks use a unique product identity and a private directory" — the installer is never exercised against the real product identity.

### apps/desktop/tests/windows-uninstall-smoke.ps1
- Purpose: The production uninstaller acceptance run.
- Key abstractions: the paths Electron and electron-builder actually use: the package-scoped roaming directory, the sanitised lowercase updater cache directory, the home path.
- Data flow: install → seed data → uninstall → assert the application is gone and the seeded data is gone.
- Non-obvious design decisions: The script computes the cache path the way electron-builder does (`($PackageName -replace '[/\\?<>:*|"]','').ToLowerInvariant() + '-updater'`) rather than assuming it — the uninstaller has to find the *real* directory.
- Edge cases / failure handling: "The NSIS uninstaller hands its section to a temporary copy; the launched process exits before removal completes" — the script therefore polls for the install path to disappear instead of trusting the exit code.
- Surprising: The scenario list in `expected/windows-uninstall.json` includes `home-inside`, a case where the user's home directory is inside the removal scope.

### apps/desktop/tests/windows-runner-task.ps1
- Purpose: The Task Scheduler acceptance for the Windows packaging runner.
- Key abstractions: a fake runner directory containing a `.runner` file; the task name derived from the SHA-256 of the runner path.
- Data flow: install the task → the scheduler starts the fake runner → the manager observes it → uninstall.
- Non-obvious design decisions: "Opt-in Windows Task Scheduler acceptance: isolated fake runner, no GitHub registration or signing access" — the fake runner deliberately fails once so the restart behaviour is exercised.
- Edge cases / failure handling: The task must be `Disabled`, have an unlimited execution limit (`PT0S`) and `MultipleInstances = IgnoreNew`; the script asserts all three. The task name is derived from the digest so two checkouts never collide.
- Surprising: The runner directory is named `runner with spaces` — the fixture exists to prove the quoting survives a path with spaces.

### apps/desktop/tests/fixtures/workspace-update-host.mjs
- Purpose: A private, token-authenticated control surface inside the real Desktop Host.
- Key abstractions: `inject = ['agents', 'agentPresets']`; an HTTP server requiring `x-qualification-token`; `ctx.on('connection/request', ...)` to observe requests.
- Data flow: the control posts `/queue`, `/clear`, `/hold-shutdown` → the Host creates an agent with the standard preset and queues a user turn → the response reports the queued counts, the agent statuses and the request history.
- Non-obvious design decisions: The fixture reaches into the real `ctx.agents` and `ctx.agentPresets` rather than replacing them, so the queueing path under test is the product's own.
- Edge cases / failure handling: An unknown operation throws; a request without the token is a 403.
- Surprising: The request history is returned by `/status`, which is how the qualification proves that an admitted request was drained rather than cancelled.

### apps/desktop/tests/fixtures/workspace-update-adapters.mjs
- Purpose: The three-module substitution that lets the compiled main entry run against a fixture.
- Key abstractions: `fixture` (a shared mutable object holding updater, coordinator, host, states, installations and task queries); `DesktopUpdateCoordinator` and `DesktopHostProcess` subclasses.
- Data flow: the real main entry → the substituted coordinator → the fixture's arrays → the scenario assertions.
- Non-obvious design decisions: `registerHooks` swaps exactly three specifiers, so the substitution is minimal and auditable. Port zero is used for the inspector so "no fixed listener is acquired".
- Edge cases / failure handling: `fixture.readyHosts` is a `WeakSet`, so a superseded Host can be told apart from the current one.
- Surprising: The Host subclass forwards `updateTasks` to the real implementation and only *records* the call — the admission logic under test is the real one.

### apps/desktop/tests/acl-skill.built.e2e.ts
- Purpose: Proving a skill's resources still work when they are carried inside the packaged archive.
- Key abstractions: `@electron/asar`'s `createPackageWithOptions`; a `registerHooks` resolver that redirects the archive's bare imports to the real workspace modules.
- Data flow: copy the package into a temp tree → build `app.asar` → run Electron in Node mode → import the skill from inside the archive → execute its PowerShell script → dispose and check the extraction is gone.
- Non-obvious design decisions: "Only the package under test is archived; resolve its real dependencies from the built workspace" — the archive stays minimal so the test is about *this* package. The assertion `!directory.includes('.asar')` proves the skill's resources were materialised to a real directory rather than read from inside the archive.
- Edge cases / failure handling: The run is bounded (60 s) and the temporary root is removed in a `finally`.
- Surprising: The skill is executed by *external* `pwsh` with `-AllowRoot`, and the test asserts the script printed `READABLE=True` — the point is that a skill shipped inside an ASAR can still shell out.

### apps/desktop/tests/fixtures/host-update-control.mjs
- Purpose: A four-line plugin that hands the real Loader-composed Host context to the qualification fixture.
- Key abstractions: `ready = Promise.withResolvers()`; `inject = ['agents', 'jobs', 'llm', 'agentPresets', 'connection']`.
- Data flow: the Host loads the profile → the plugin's `apply(ctx)` resolves `ready` → the fixture awaits it and then talks to the real services.
- Non-obvious design decisions: It deliberately injects `llm` so the fixture can register its held adapter into the *real* adapter registry.
- Edge cases / failure handling: None needed — the whole file is the boundary.
- Surprising: Four lines expose the entire composition to a test, which is what makes the rest of the qualification honest.

### apps/desktop/tests/fixtures/macos-cache-writer.mjs
- Purpose: One independent signature-cache writer, run as its own process.
- Key abstractions: `cachedMacOSSignature(file, cache, { policy, sign, verify })`.
- Data flow: the writer signs through the cache → `process.send('ready')` → the parent releases it → the signature is verified → the process disconnects.
- Non-obvious design decisions: The sign step is deliberately synchronous with the parent (the IPC round trip is the barrier), so a concurrent-writer bug can actually be observed.
- Edge cases / failure handling: The verify step fails unless the bytes are exactly `original:signed`.
- Surprising: It exercises the cache "through native TypeScript stripping" — the `.ts` import runs without a build step.

### apps/desktop/tests/fixtures/packaging-failure.mjs
- Purpose: A stage that fails while it still owns a descendant.
- Key abstractions: `failPackagingRun(directory, reason)`.
- Data flow: spawn a child that stays alive → write `descendant.json` → fail the run → the supervisor must kill both.
- Edge cases / failure handling: The child is started with an IPC channel so the parent knows it is ready.
- Surprising: The fixture exists to prove the *descendant* is killed — a signing tool that survives its supervisor would keep a hardware token.

### apps/desktop/tests/fixtures/office-conversion-inputs.py
- Purpose: One-page Office documents for the conversion smoke.
- Key abstractions: `python-docx`, `openpyxl`, `python-pptx`.
- Data flow: argv[1] → three files with the text "Desktop Office conversion 42".
- Non-obvious design decisions: The same string appears in all three formats so the conversion output can be compared byte for byte.
- Edge cases / failure handling: None; the inputs are inert.
- Surprising: The PPTX uses a textbox rather than a title placeholder, so the conversion path exercises the same code as a pasted snippet rather than a template.

### apps/desktop/tests/fixtures/owned-directory-smoke.mjs
- Purpose: The cleanup regression, run under Electron in Node mode.
- Key abstractions: `removeOwnedDirectory`, `inventoryDesktopRuntime` from the built `lib/types/`.
- Data flow: build a profile tree with a junction to the resources → remove the profile → assert the resources are untouched.
- Edge cases / failure handling: The junction is a `junction` on Windows and a directory symlink on POSIX, so both are covered.
- Surprising: `assert.ok(process.versions.electron, 'This regression must run under Electron')` — the file refuses to run anywhere else, because the failure mode it guards is Electron-specific.

### apps/desktop/tests/fixtures/update-dialogs.mjs
- Purpose: The real update dialog, served over the `dsh-app` protocol.
- Key abstractions: `DesktopUpdateDialog` with the production preload `lib/preload-update-dialog.cjs`; `DesktopUpdateOverlays`; `DesktopBackgroundNotice`.
- Data flow: a protocol handler serves the real `renderer/update-dialog.*` files → the dialog is shown → the user cancels or installs.
- Non-obvious design decisions: The protocol handler asserts the requested file name is one of the four allowed entries, so the fixture cannot become a way to serve arbitrary files.
- Edge cases / failure handling: The rendering is awaited through a `MutationObserver` with a 10-second deadline, so "the dialog did not render" is a named failure.
- Surprising: It is the same preload and renderer the product ships — the only substitution is the updater.

### apps/desktop/tests/fixtures/artifact-update-server.mjs
- Purpose: Serving real executables through a synthetic Nightly feed.
- Key abstractions: `artifactDigest(file)` (a streaming SHA-512 that never buffers the whole file); `createArtifactUpdateServer(files)`.
- Data flow: the files → a feed with correct hashes → the updater downloads → optional corruption → the request log.
- Non-obvious design decisions: The digest is computed by streaming so a large executable is never held in memory; the feed and the blockmaps are both derived from the real bytes.
- Edge cases / failure handling: `corrupt` flips the transferred bytes while the advertised hash stays correct, so the failure is detected at the checksum rather than at the transport.
- Surprising: The same server also drives the differential (Range) reconstruction scenarios the README describes.

### apps/desktop/tests/fixtures/cli-console-probe.cpp
- Purpose: Proving a console Ctrl event reaches an Electron child.
- Key abstractions: `FreeConsole`/`AllocConsole`; a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; `GenerateConsoleCtrlEvent`.
- Data flow: the probe owns a console → launches the CLI child suspended → resumes it → waits for a ready marker → raises the Ctrl event → checks the exit code and the report file.
- Non-obvious design decisions: "Own a console so the test never interrupts its caller's terminal" — the console is freed and re-allocated so the Ctrl event cannot reach the developer's shell. `ignoreInterrupt` keeps the probe itself alive.
- Edge cases / failure handling: The child is in a kill-on-close job object, so a hung test does not leave an orphan Electron process.
- Surprising: The child is launched *suspended* and then resumed, so the Ctrl event cannot arrive before the handlers are installed.

### apps/desktop/tests/fixtures/installer-directory-smoke.nsi
- Purpose: The staged directory replacement, as an NSIS smoke.
- Key abstractions: `dshStageApplication`, `dshPromoteDirectories`, `dshDirectoryOperation`, `dshRollbackDirectories`, `dshReportDirectoryFailure`.
- Data flow: stage the new application → promote it over the old one → force a conflict → roll back.
- Non-obvious design decisions: `RESTORE_CONFLICT` creates an unrelated file in the promoted directory so the promote fails and the rollback path is exercised for real.
- Edge cases / failure handling: The conflict directory is renamed aside (`${TARGET_DIR}.conflict`) rather than deleted, so the evidence survives the failure.
- Surprising: The same script compiles against two different include sets (`installer.nsh` with the window frame, and `installer-directories.nsh` without), which is how the two production paths are kept in step.

### apps/desktop/tests/fixtures/installed-update-packaging.mjs
- Purpose: An inert packaging subprocess.
- Key abstractions: reads `run.json`; writes `installer/<name>.exe`, its `.blockmap` and `nightly.yml` with a correct SHA-512.
- Data flow: manifest + version → the three files → a non-zero exit when `DSH_TEST_PACKAGING_FAIL=1`.
- Non-obvious design decisions: It prints the token PIN to stdout so the redaction path can be exercised against a real secret value.
- Edge cases / failure handling: The bytes are explicitly labelled "inert test bytes, not an installer".
- Surprising: The fixture deliberately leaks a credential so the *redaction* is what is being tested.

### apps/desktop/tests/fixtures/signing-interlock.mjs
- Purpose: A child that tries to take the signing interlock.
- Key abstractions: `beginWindowsSigningAttempt({ runDirectory, stateDirectory, target })`.
- Data flow: attempt → print `acquired` and exit 0, or print `blocked` and exit 1.
- Non-obvious design decisions: "this fixture never loads a signer or opens a token" — the interlock is tested without any hardware.
- Edge cases / failure handling: The failure path is a caught exception, not a crash, so the output is deterministic.
- Surprising: The whole interlock contract is expressible in six lines, which is why the concurrency test can spawn two of them cheaply.

### apps/desktop/tests/fixtures/windows-pty-exit.cjs
- Purpose: Terminal worker cleanup on natural exit and on kill.
- Key abstractions: `node-pty` resolved from the workspace package.
- Data flow: spawn a terminal → read the output → (kill it) → on exit, assert and print `pty-cleanup-complete`.
- Non-obvious design decisions: The assertion runs inside the `onExit` handler and the final message is printed on `beforeExit`, so the process only exits after the terminal is done.
- Edge cases / failure handling: The `kill` mode asserts that the kill actually happened before the exit.
- Surprising: The Windows spec additionally requires `stderr` to be **empty** — a PTY that prints a warning on exit is a failure.

### apps/desktop/tests/fixtures/windows-signing-stage.mjs
- Purpose: An independent process taking the signing stage lock and using the cache.
- Key abstractions: `withWindowsSigningStage({ stateDirectory, stage, record })`; `createCachedSigner`; `maintainSignatureCache`.
- Data flow: enter the stage → wait for the parent's release → sign or clear → send events over IPC.
- Non-obvious design decisions: The signer's `sign` appends to a `hardware-calls` file so the test can assert the *number* of hardware calls, not just the outcome.
- Edge cases / failure handling: The `clear` mode exercises cache maintenance under the stage lock.
- Surprising: The hardware-call counter is the assertion that matters — "the cache avoided the hardware" is the claim under test.




### apps/desktop/tests/fixtures/workspace-updates-interactive.mjs
- Purpose: The operator's control window for the workspace walkthrough.
- Key abstractions: a second `BrowserWindow` titled "本地升级验收控制"; `fixture.updater.quitAndInstall` replaced by a message box.
- Data flow: the operator picks a scenario from the menu → the fixture selects the feed mode → the real main entry reacts.
- Non-obvious design decisions: "Each run owns a private profile and loopback server; payloads are not installers." The intercepted installer call ends the walkthrough with an explicit dialog saying so.
- Edge cases / failure handling: Closing the control window also exits; an operation error is shown in a `showErrorBox` rather than swallowed.
- Surprising: The interactive run has a **ten-minute** network deadline against the automated run's 120 seconds — the operator is allowed to take their time.


























### apps/desktop/tests/installed-update-signature.spec.ts
- Purpose: The read-only signature evidence for a prepared installed-update installer.
- Key abstractions: `installedUpdateFileHash(file)` (the feed's SHA-512 algorithm) and `verifyInstalledUpdateSignature(...)`; an `Execute` seam so the real verifier can be driven without a device.
- Data flow: the installer bytes -> a base64 SHA-512 digest -> the real updater verifier -> `{ valid, timestamped, signer, timestamp }`.
- Non-obvious design decisions: The verification child receives **no inherited signing/upload secrets and no PowerShell module-path overrides**, so a probe cannot be influenced by the environment that produced the artefact.
- Edge cases / failure handling: The fixture's file name deliberately contains a space and an apostrophe ("inert ' executable.exe") so the Windows quoting of the verification child is exercised.
- Surprising: "hashes actual bytes using the feed algorithm" - the digest is computed the way the *updater* computes it, so a mismatch between the packaging digest and the updater's digest shows up here rather than in the field.

### apps/desktop/tests/installed-update-runtime.spec.ts
- Purpose: Building a version-bound runtime copy for each installed-update qualification version.
- Key abstractions: `prepareInstalledUpdateRuntime(manifest, source)`; `createInstalledUpdateRun`; `verifyDesktopRuntime` against each copy.
- Data flow: the sealed source runtime -> a copy per version with only release-owned packages retagged -> a re-verified descriptor per copy.
- Non-obvious design decisions: Only the release family packages and their matching dependency references are retagged; **third-party versions are preserved**, and the copied inventories *and the untouched source* are re-verified afterwards. The result records `{ signed: false, bootTested: false }` - it does not claim signing or startup qualification.
- Edge cases / failure handling: A failed version stops the preparation and leaves `runtime-preparation/failed.json` with `{ failed: true, completedVersions, retryAllowed: false }` and **no completion receipt**; a pre-existing directory is `EEXIST` rather than an overwrite; the source runtime is left byte-identical.
- Surprising: A stale or damaged source is rejected *before either version is copied*, so a half-prepared pair is never produced.

### apps/desktop/tests/installed-update-publication.spec.ts
- Purpose: The publication *sequence* for a qualification run, as a state machine over a store.
- Key abstractions: `InstalledUpdatePublicationStore` (versioning/read/publicRead/put) with an in-memory fake; `executeInstalledUpdatePublication`; `verifiedInstalledUpdateDistribution`.
- Data flow: upload the binaries without advertising -> publish the version 1 feed -> require version 1's startup evidence -> publish the version 2 feed.
- Non-obvious design decisions: "uploads without advertising, publishes version 1, then requires version 1 startup before publishing version 2" - version 2's feed cannot be written until version 1 is *running*, which is what makes the late-feed scenario testable. Feed publication **reuses** the successful binary-upload receipt and never re-reads the binaries.
- Edge cases / failure handling: A `failed`, `wrong-version` or `different-plan` receipt is refused without reading any binary. The cases cover versioning, an existing object, a write failure, a public-read mismatch, a missing binary and a wrong feed; and `missing-journal`, `wrong-journal-directory`, `changed-binary`, `failed-receipt` and `lock` for the version 2 step.
- Surprising: "SDK writes have no automatic retries" is honoured in the fake - the store records each write with an `immutable` flag, so a retry would appear as a second write.

### apps/desktop/tests/fixtures/platform-storage-smoke.mjs
- Purpose: The real Electron check that Platform storage is scoped per account and survives a restart.
- Key abstractions: an `OBSERVE` snippet executed in the embedded document; `platformView(owner)` (finds the child view by its `executeJavaScript`); `dismissNotice(contents)`.
- Data flow: sign in -> observe the notice -> dismiss it -> sign out -> sign in as another account -> restart -> observe again.
- Non-obvious design decisions: The dismissal is performed by *clicking the real button in the embedded document* and then waiting, bounded, for it to leave the DOM - not by clearing storage directly, so the storage the product writes is the storage under test.
- Edge cases / failure handling: The observation refuses any value other than `visible` or `hidden`, so a page that renders nothing is a failure rather than a pass.
- Surprising: The expected sequence in `expected/platform-storage.txt` records `reopen-cookies=cleared` and `signed-in-again=hidden` - the *cookie* state is part of the expected output, not just the notice.

### Remaining files (one specific line each)

- `apps/desktop/tests/__snapshots__/preload-menu.client.spec.ts.snap` — Vitest snapshot of the Windows caption menubar DOM in English and Chinese (two exports, one per locale).
- `apps/desktop/tests/background-notice.spec.ts` — the window stays visible until the close confirmation is answered, and the acknowledgement is remembered across launches.
- `apps/desktop/tests/cli-launcher.spec.ts` — the installed `dsh` preserves args, cwd, env, stdin bytes, stderr and exit status through the launcher.
- `apps/desktop/tests/client-metadata.spec.ts` — the client refuses to guess a version when `DSH_CLIENT_VERSION` is absent, and reports locale and UTC offset.
- `apps/desktop/tests/command-management.spec.ts` — the CLI dialog has five states per platform and locale, including a *warning* when another `dsh` shadows the Desktop one on PATH.
- `apps/desktop/tests/command-path.spec.ts` — the real Windows PATH worker runs against a private registry key tree.
- `apps/desktop/tests/desktop-auto-update-environment.spec.ts` — the test deployment is the default and its release ID must be exactly 32 lowercase hex characters.
- `apps/desktop/tests/desktop-build-commit.spec.ts` — the build commit and dirty flag travel through the child environment; the toolchain probe writes nothing into the working directory.
- `apps/desktop/tests/desktop-build-paths.spec.ts` — every mutable build directory is per-target; only the upstream download cache is shared.
- `apps/desktop/tests/desktop-build-version-discovery.spec.ts` — the next build suffix is derived from the artifacts already on disk, including `-unnotarized` and `-unsigned` variants.
- `apps/desktop/tests/desktop-build-version.spec.ts` — a build version must extend the product prerelease and carry no build metadata.
- `apps/desktop/tests/desktop-cli.spec.ts` — the installed CLI dispatches with the bundled pnpm under Electron's package-operation environment.
- `apps/desktop/tests/desktop-package-selection.spec.ts` — the exact successful attempt and its registered runner are selected; every mismatch is refused without falling back.
- `apps/desktop/tests/desktop-policy-environment.spec.ts` — the mandatory-update origin and its authentication mode are selected together, and `allowedAuthOrigins` is forbidden in production.
- `apps/desktop/tests/desktop-publication-failure.spec.ts` — publication failures keep actionable diagnostics and drop provider bodies and raw SDK errors.
- `apps/desktop/tests/desktop-publication-preflight.spec.ts` — a retained build is re-verified after approval and a changed file or a different machine stops the publish.
- `apps/desktop/tests/desktop-publication-summary.spec.ts` — the approval summary escapes runner text so it cannot add Markdown rows or HTML elements.
- `apps/desktop/tests/desktop-publish-cos.spec.ts` — the real COS SDK sends the overwrite-prevention header and the readback is hashed from the received bytes.
- `apps/desktop/tests/desktop-publish-config.spec.ts` — public settings load without the credential file, and multiline App outputs are refused.
- `apps/desktop/tests/desktop-publish-preflight.spec.ts` — an unnotarized or unsigned artifact is refused from paginated GitHub metadata before any publish.
- `apps/desktop/tests/desktop-publish-tag.spec.ts` — the release tag is created idempotently and never moved.
- `apps/desktop/tests/desktop-release-store.spec.ts` — one writer per retained attempt; changed bytes and tampered manifests are refused.
- `apps/desktop/tests/desktop-release-tag.spec.ts` — `git tag`/`git push` refuses to move a tag naming another commit and reports failures without throwing.
- `apps/desktop/tests/desktop-rollback.spec.ts` — a channel rollback previews the exact YAML change before any write and resumes a partial restore.
- `apps/desktop/tests/desktop-upload-plan.spec.ts` — the plan puts every object inside the release directory and publishes the channel metadata last.
- `apps/desktop/tests/desktop-upload-run.spec.ts` — a failed PUT is not retried and the raw SDK diagnostics never reach the retained record.
- `apps/desktop/tests/development-app.spec.ts` — the cold-start launcher passes literal paths and devtools flags without evaluating shell syntax.
- `apps/desktop/tests/development-project.spec.ts` — the development runtime inventory includes unhoisted workspace packages and plugin management never writes to a linked package.
- `apps/desktop/tests/device-info.spec.ts` — a missing or throwing source omits its field instead of failing the whole description.
- `apps/desktop/tests/directory-picker.spec.ts` — the picker refuses foreign renderers, shares one unanswered dialog, and discards a selection whose parent has been destroyed.
- `apps/desktop/tests/expected/about-panel.json` — the About panel menu label and options per locale.
- `apps/desktop/tests/expected/application-menu-en-US.json` — the English application menu labels.
- `apps/desktop/tests/expected/application-menu-zh-CN.json` — the Chinese application menu labels.
- `apps/desktop/tests/expected/background-close-confirmation.json` — the tray close confirmation message and its single button.
- `apps/desktop/tests/expected/command-management-darwin-en-US.json` — the five macOS CLI dialogs in English.
- `apps/desktop/tests/expected/command-management-darwin-zh-CN.json` — the five macOS CLI dialogs in Chinese.
- `apps/desktop/tests/expected/command-management-win32-en-US.json` — the five Windows CLI dialogs in English, including the shadowed-npm warning.
- `apps/desktop/tests/expected/command-management-win32-zh-CN.json` — the five Windows CLI dialogs in Chinese.
- `apps/desktop/tests/expected/command-repair-en-US.json` — the two command-repair dialogs in English.
- `apps/desktop/tests/expected/command-repair-zh-CN.json` — the two command-repair dialogs in Chinese.
- `apps/desktop/tests/expected/cos-GetObject-denied.json` — the sanitised AccessDenied receipt for a COS read.
- `apps/desktop/tests/expected/cos-PutObject-denied.json` — the sanitised AccessDenied receipt for a COS write.
- `apps/desktop/tests/expected/desktop-upload-audit.txt` — the expected audit event sequence for a successful upload.
- `apps/desktop/tests/expected/fatal-address-in-use-en.txt` — the English fatal dialog for a second instance holding the port.
- `apps/desktop/tests/expected/fatal-address-in-use-zh-CN.txt` — the Chinese fatal dialog for the same case.
- `apps/desktop/tests/expected/fatal-dialog-en.txt` — the English fatal dialog for a Host/plugin initialisation failure.
- `apps/desktop/tests/expected/fatal-dialog-with-report-en.txt` — the same dialog including the crash-report path line.
- `apps/desktop/tests/expected/fatal-dialog-with-report-zh-CN.txt` — the Chinese dialog including the crash-report path line.
- `apps/desktop/tests/expected/fatal-dialog-zh-CN.txt` — the Chinese fatal dialog for a Host/plugin initialisation failure.
- `apps/desktop/tests/expected/latest-installer-uploads.json` — the per-environment latest-installer upload records.
- `apps/desktop/tests/expected/mandatory-update-zh.json` — the Chinese mandatory-update dialog copy.
- `apps/desktop/tests/expected/platform-storage.txt` — the Platform notice visibility across sign-out, second account and restart.
- `apps/desktop/tests/expected/policy-login-en.json` — the check-for-updates copy for the four Feishu test-login outcomes.
- `apps/desktop/tests/expected/publication-mac-arm64.md` — the mac-arm64 test publication approval summary with per-file SHA-256.
- `apps/desktop/tests/expected/publication-win-x64.md` — the win-x64 test publication approval summary.
- `apps/desktop/tests/expected/retained-unnotarized.md` — the retained-package note for an unnotarized build, with rebuild instructions and a publish ban.
- `apps/desktop/tests/expected/retained-unsigned.md` — the same note for an unsigned Windows build.
- `apps/desktop/tests/expected/test-release-upload-mac-arm64.json` — the mac-arm64 uploaded keys and feed body.
- `apps/desktop/tests/expected/test-release-upload-mac-x64.json` — the mac-x64 uploaded keys and feed body.
- `apps/desktop/tests/expected/test-release-upload-win-x64.json` — the win-x64 uploaded keys and feed body.
- `apps/desktop/tests/expected/update-guidance-zh-CN.json` — the same seven states in Chinese.
- `apps/desktop/tests/expected/update-overlay-visibility.json` — the native overlay visibility results and listener-cleanup counts.
- `apps/desktop/tests/expected/update-restart-darwin-en-US.json` — the macOS install-and-restart dialog in English.
- `apps/desktop/tests/expected/update-restart-darwin-zh-CN.json` — the macOS install-and-restart dialog in Chinese.
- `apps/desktop/tests/expected/update-restart-win32-en-US.json` — the Windows install-and-restart dialog with the do-not-relaunch warning.
- `apps/desktop/tests/expected/update-restart-win32-zh-CN.json` — the Windows install-and-restart dialog in Chinese.
- `apps/desktop/tests/expected/update-status-zh.json` — the seven visible update phases with version and percent carried through.
- `apps/desktop/tests/expected/upload-credentials-check.txt` — the credential-launcher output: fields loaded, child verified, no network, parent unchanged.
- `apps/desktop/tests/expected/welcome/en-api-key.expected.txt` — the English API-key onboarding screen text.
- `apps/desktop/tests/expected/welcome/en-expired.expected.txt` — the English signed-out-expiry notice.
- `apps/desktop/tests/expected/welcome/en-timeout.expected.txt` — the English sign-in timeout screen.
- `apps/desktop/tests/expected/welcome/en-waiting.expected.txt` — the English browser-sign-in waiting screen.
- `apps/desktop/tests/expected/welcome/en.expected.txt` — the English welcome entry screen.
- `apps/desktop/tests/expected/welcome/zh-CN-api-key.expected.txt` — the Chinese API-key onboarding screen text.
- `apps/desktop/tests/expected/welcome/zh-CN-expired.expected.txt` — the Chinese signed-out-expiry notice.
- `apps/desktop/tests/expected/welcome/zh-CN-timeout.expected.txt` — the Chinese sign-in timeout screen.
- `apps/desktop/tests/expected/welcome/zh-CN-waiting.expected.txt` — the Chinese browser-sign-in waiting screen.
- `apps/desktop/tests/expected/welcome/zh-CN.expected.txt` — the Chinese welcome entry screen.
- `apps/desktop/tests/expected/windows-installer.json` — the Windows installer scenario list and the launch-checkbox/native-progress flags.
- `apps/desktop/tests/expected/windows-uninstall.json` — the Windows uninstall scenario list.
- `apps/desktop/tests/flock-entry.spec.ts` — the cross-process file-lock entry helper.
- `apps/desktop/tests/installed-update-bootstrap.spec.ts` — the generated bootstrap assigns isolated user-data/home/journal paths for both versions before loading main.
- `apps/desktop/tests/installed-update-builder.spec.ts` — the shipped application bytes are frozen once, without credentials, and verified per version.
- `apps/desktop/tests/installed-update-cos.spec.ts` — the qualification transport streams a PUT with an explicit length and never retries an uncertain write.
- `apps/desktop/tests/installed-update-distribution.spec.ts` — the two binary sets and the shared fixed feed URL, with publication unauthorised.
- `apps/desktop/tests/installed-update-network.spec.ts` — the fault plan binds to the verified executable bytes and rejects a bad receipt before creating anything.
- `apps/desktop/tests/installed-update-package-content.spec.ts` — the archive's real ASAR and runtime inventories are read and checked, and unsafe archive paths are refused before extraction.
- `apps/desktop/tests/installed-update-packaging.spec.ts` — the packaging entry refuses the signing interlock before loading credentials.
- `apps/desktop/tests/installed-update/publication/README.i18n.yaml` — the bilingual pairing hashes for the publication README.
- `apps/desktop/tests/installed-update/publication/README.zh.md` — the Chinese version of that procedure.
- `apps/desktop/tests/installed-update/network/README.i18n.yaml` — the bilingual pairing hashes for the network README.
- `apps/desktop/tests/installed-update/network/README.md` — the operator checklist for blocking and restoring only the test application's traffic.
- `apps/desktop/tests/installed-update/network/README.zh.md` — the Chinese version of that checklist.
- `apps/desktop/tests/installed-update/README.i18n.yaml` — the bilingual pairing hashes for the walkthrough README.
- `apps/desktop/tests/installed-update/README.zh.md` — the Chinese version of the walkthrough.
- `apps/desktop/tests/installer-packaging.spec.ts` — installer preparation rejects a missing production policy before signing and packages every preload entry.
- `apps/desktop/tests/locale.spec.ts` — the two dictionaries share a key set and the startup locale prefers an explicit choice then the first supported language.
- `apps/desktop/tests/logged-notarytool-exit.spec.ts` — Apple's rejection JSON survives a nonzero notarytool exit so electron-notarize can retrieve it.
- `apps/desktop/tests/logged-notarytool.spec.ts` — submit-then-wait with separate timings and an event log that never contains the Apple ID or password.
- `apps/desktop/tests/login-shell-environment.spec.ts` — the login shell's environment is read between delimiters and merged with launcher-owned names protected.
- `apps/desktop/tests/macos-app-update-config.spec.ts` — the fixed release feed and updater cache directory name are written and verified inside the signed app.
- `apps/desktop/tests/macos-cache-policy.spec.ts` — the cache policy key covers certificate, identifier, team, authority, timestamp, hardened runtime and entitlements.
- `apps/desktop/tests/macos-disk-image-signature.spec.ts` — an unnotarized DMG is checked for identity only; a release DMG still needs a stapled ticket and Gatekeeper.
- `apps/desktop/tests/macos-notarization-proxy.spec.ts` — the system proxy transaction preserves and restores the user's settings and never steals a live lock.
- `apps/desktop/tests/macos-notarized-application.spec.ts` — the codesign/stapler/spctl sequence stops at the first failing command.
- `apps/desktop/tests/macos-package-preset.spec.ts` — the macOS local preset is validated before any Apple credential is used.
- `apps/desktop/tests/macos-package-settings.spec.ts` — pack concurrency and the two proxies are read from the environment, and invalid values are rejected without echoing the proxy.
- `apps/desktop/tests/macos-runtime.spec.ts` — Mach-O runtime files are signed in place and bad symlinks are refused before anything is signed.
- `apps/desktop/tests/macos-signature-cache-directory.spec.ts` — the macOS cache must be an unlinked, private POSIX directory.
- `apps/desktop/tests/macos-signature-cache.spec.ts` — cached signatures are reused, invalidated by input/policy change, and never published after a failure.
- `apps/desktop/tests/macos-signature.spec.ts` — release signing requires hardened runtime, a secure timestamp, the exact authority and team, and one complete notarization strategy.
- `apps/desktop/tests/macos-signing-keychain.spec.ts` — signing is scoped to a temporary keychain and the user's keychain search list is restored.
- `apps/desktop/tests/macos-signing-walk.spec.ts` — the signer visits each Framework file once and keeps nested bundle signing.
- `apps/desktop/tests/microphone-permissions.spec.ts` — media permission is granted only to the owned application frame, and the macOS decision is awaited once.
- `apps/desktop/tests/node-environment.spec.ts` — the private Desktop launchers stay out of the Host environment and reach only package installation processes.
- `apps/desktop/tests/owned-directory.spec.ts` — the owned tree is deleted while a linked directory target survives, and a regular-file root is refused.
- `apps/desktop/tests/package-macos.spec.ts` — two notarization lanes run on isolated copies and only completed payloads are promoted.
- `apps/desktop/tests/package-target-errors.spec.ts` — a failed packaging stage records redacted parent failures without leaking the credential.
- `apps/desktop/tests/package-target-stages.spec.ts` — the staged pipeline takes one signing preflight, writes no release record on failure, and scopes the Apple proxy to notarization.
- `apps/desktop/tests/package-target.spec.ts` — the target selects the runtime and builder architecture, and the packaging subprocesses carry no certificate or COS credentials.
- `apps/desktop/tests/packaged-runtime-verification.spec.ts` — the after-pack hook requires the product version (or the qualification's version) from the bundled runtime.
- `apps/desktop/tests/packaging-step.spec.ts` — a packaging step redacts nested error causes and never persists a successful return value.
- `apps/desktop/tests/platform-preload.e2e.ts` — the sandboxed platform preload exposes a synchronous getter after exactly one bootstrap IPC, never to subframes.
- `apps/desktop/tests/platform-storage.e2e.ts` — real Chromium storage survives view and process lifetimes.
- `apps/desktop/tests/policy-login-loading.spec.ts` — the login placeholder renders its label from the query under a `default-src 'none'` policy.
- `apps/desktop/tests/preload-mandatory-overlay.spec.ts` — the overlay accepts actions only through a transferred private port and closes its channel on navigation.
- `apps/desktop/tests/preload-menu.client.spec.ts` — the caption menubar mounts only after the application frame replaces the loading document.
- `apps/desktop/tests/preload-platform.client.spec.ts` — the fullscreen state is mirrored onto `html[data-fullscreen]` on darwin/win32 only.
- `apps/desktop/tests/preload-theme.client.spec.ts` — the native theme source is mirrored through a MutationObserver deferred to `DOMContentLoaded`.
- `apps/desktop/tests/preload-windows.client.spec.ts` — the Windows appearance is synchronised live and observation stops on `pagehide`.
- `apps/desktop/tests/preload.e2e.ts` — the built preloads load with only Electron's sandbox-supported require.
- `apps/desktop/tests/prepare-package-set.spec.ts` — the desktop package closure includes the internal production packages and rejects a missing one.
- `apps/desktop/tests/prepare-runtime-patches.spec.ts` — shared runtime patch bytes must match the workspace lockfile and the workspace is never written.
- `apps/desktop/tests/prepare-windows-ci.spec.ts` — the manual CI version is derived from the product prefix and the UTC run identity.
- `apps/desktop/tests/prepared-runtime-smoke.spec.ts` — the prepared-runtime smoke keeps the payload's termination details and can smoke a cross-architecture target.
- `apps/desktop/tests/primary-runtime-preparation.spec.ts` — a Python-only Desktop payload is refused before any interpreter executes.
- `apps/desktop/tests/primary-runtime-signing.spec.ts` — the primary runtime's PE files are signed, vendor signatures are retained, and the first failure stops everything.
- `apps/desktop/tests/profile-mcp.spec.ts` — the Desktop Web profile keeps one MCP resource consumer and a non-disabled webserver entry.
- `apps/desktop/tests/project-manager.spec.ts` — the plugin profile, its lockfile and the owner lock survive a release and an upgrade.
- `apps/desktop/tests/ptc-runtime.spec.ts` — the PTC runtime runs under Electron in both sandbox modes and does not inherit the environment.
- `apps/desktop/tests/read-desktop-app-key.spec.ts` — the key reader masks multiline bytes and passes the exact fixture to the token action without a shell.
- `apps/desktop/tests/README.i18n.yaml` — the bilingual pairing hashes for the tests README.
- `apps/desktop/tests/README.zh.md` — the Chinese version of the desktop local update verification README.
- `apps/desktop/tests/retain-desktop-ci.spec.ts` — a complete CI release is retained without credentials, and a debugging package cannot be published.
- `apps/desktop/tests/runtime-file-policy.spec.ts` — development artefacts are omitted while executables, assets, licences and native prebuilds survive.
- `apps/desktop/tests/runtime-fixture.ts` — the shared fixture that materialises a sealed minimal Desktop runtime.
- `apps/desktop/tests/runtime-manifests.spec.ts` — dependency metadata is sealed so archive preparation cannot change the runtime hash.
- `apps/desktop/tests/runtime-preparation.spec.ts` — `versions.json` is published only for complete resources; a failure removes the stale file.
- `apps/desktop/tests/runtime-tree-read-failure.spec.ts` — a read failure drains the outstanding reads before rejecting.
- `apps/desktop/tests/shell-file-selection.spec.ts` — the packaged shell's file selection is checked against the real electron-builder matchers.
- `apps/desktop/tests/single-instance.spec.ts` — a second process quits without registering lifecycle work, and a later launch focuses the primary.
- `apps/desktop/tests/tray-icon.spec.ts` — the tray ICO carries one crisp bitmap per display scale and rejects a mismatched edge.
- `apps/desktop/tests/tray.spec.ts` — the tray opens the window on a single click and relabels in the current locale.
- `apps/desktop/tests/update-channel.spec.ts` — the update channel is read from the installed channel, defaulting to nightly.
- `apps/desktop/tests/upload-target.spec.ts` — the upload command tags the release only after the upload succeeded and only where a tag is required.
- `apps/desktop/tests/upload-with-credentials.spec.ts` — the credential launcher uses decrypted credentials only for the matching deployment and sanitises both output streams.
- `apps/desktop/tests/welcome-flow.e2e.ts` — an explicit API key and a browser account login persist independently across Host restarts.
- `apps/desktop/tests/welcome-host.spec.ts` — onboarding authenticates through Web RPC and stores only through a configured credential reference.
- `apps/desktop/tests/welcome-renderer.client.spec.tsx` — the welcome page prevents competing actions, retains an unsaved draft after a refused save, and handles the timeout and copy paths.
- `apps/desktop/tests/welcome-startup.spec.ts` — welcome startup uses the Host and never carries update focus into the login or skip path.
- `apps/desktop/tests/welcome-window.spec.ts` — the welcome window is fixed-size and sandboxed and accepts actions only from its own top frame.
- `apps/desktop/tests/windows-asar-unpack.spec.ts` — PE files are unpacked through builder patterns and the archived bytes are verified against the preparation descriptor.
- `apps/desktop/tests/windows-cli-signals.spec.ts` — real console Ctrl events reach asynchronous JavaScript shutdown in Electron Node mode.
- `apps/desktop/tests/windows-directory-installer.spec.ts` — the pinned NSIS template keeps data cleanup out and stages before it stops the app.
- `apps/desktop/tests/windows-installer-presentation.cpp` — the installer welcome window is raised, is not topmost, and records its Presented property.
- `apps/desktop/tests/windows-package-preset.spec.ts` — the Windows preset loads unsigned public settings without the signing secret file.
- `apps/desktop/tests/windows-pty-exit.spec.ts` — the terminal worker is released after a natural exit and after a kill.
- `apps/desktop/tests/windows-sign.spec.ts` — Windows token signing validates the BAT, stops the queue on a PIN failure and scrubs the environment.
- `apps/desktop/tests/windows-signature-batch.spec.ts` — the batch signature parser rejects every malformed row shape and any stderr.
- `apps/desktop/tests/windows-signature-cache-directory.spec.ts` — the cache directory is account-local and absolute, and a linked or public root is refused.
- `apps/desktop/tests/windows-signature-cache.spec.ts` — the cache reuses verified bytes and distinguishes an avoided signature from an attempted one.
- `apps/desktop/tests/windows-signing-preflight.spec.ts` — the signing preflight compiles one probe, verifies one production-format signature, and fails closed.
- `apps/desktop/tests/windows-signing-stage.spec.ts` — signing stages serialise on a lock and recheck the cache before touching hardware.
- `apps/desktop/tests/windows-timestamp.spec.ts` — timestamp retries use fresh signed inputs and never publish a partial or substituted file.
- `apps/desktop/tests/windows-update-publisher.spec.ts` — the update publisher is derived from a real certificate and a missing or ambiguous identity is refused.

## Ideas worth stealing

- **A byte-streaming redactor that is tested at every possible chunk split** — `apps/desktop/tests/packaging-run.spec.ts:11` — the test feeds the same secret through the redactor at *every* split offset and asserts the output is identical. A secret split across two chunks is the classic way a streaming scrubber leaks; the August harness has the same shape in `scrubOutboundBody` and in the credential collector, and the same one-line test would pin it.
- **A total operation deadline that covers the SDK's own retries, and is NOT extended by ongoing bytes** — `apps/desktop/tests/cos-operation.spec.ts:37` — the deadline is one budget for the whole operation, not per attempt, and a download that trickles bytes still hits it. This is exactly the shape of August's "one stuck 429 turned into five minutes of sleep inside a single round" defect: a per-attempt timeout multiplied by a retry count is not a bound.
- **An inactivity deadline refreshed by real response bytes, and removed once the bytes are under verification** — `apps/desktop/tests/update-http-executor.spec.ts:25` and `:57` — a slow-but-live transfer must not be killed, and the transport's deadline must stop covering the hashing phase. Portable directly to a streamed model response or a long tool download.
- **A journal that DROPS details instead of redacting arbitrary text** — `apps/desktop/tests/update-journal.spec.ts:32` — the projector keeps `phase`, `targetVersion`, `failedOperation` and an error *code*, and throws away the message entirely, because a redaction that fails silently is worse than a missing field. This is the same conclusion August reached for its outbound scrubber ("matched by VALUE, never by pattern"), arrived at from the other direction: do not even try to make an arbitrary string safe.
- **One JSONL file per installed version, in a directory outside the installation tree** — `apps/desktop/tests/update-journal.spec.ts:8` — the evidence for "before" and "after" lives in two files that both versions can read, so an upgrade can be audited from outside. August's `turn_outcomes` ledger would be the analogue; keeping per-session or per-version files outside the sandbox is what makes an upgrade auditable at all.
- **"100 percent is never readiness" and installation approval is a separate act from download** — `apps/desktop/tests/update-coordinator.spec.ts:132` and `:188` — a completed download is not a completed action; a second, explicit approval is required, and a stale approval for a superseded release is rejected. The August loop's analogue is a tool run that returns 100 % but has not been verified or committed.
- **A publish/rollback sequence that recovers an ambiguous write without repeating it** — `apps/desktop/tests/desktop-publish.spec.ts:49` — if the connection drops *after* the server stored the bytes, the retry must not rewrite and must not publish the dependent object early. August's `_stuckRequestEscape` ladder has the same shape but at the turn level; the mechanism here (record intent → write → readback → only then publish the pointer) is directly transferable.
- **A per-channel cross-process lock plus an audit journal written outside the checkout** — `apps/desktop/tests/desktop-publish-record.spec.ts:42` — the lock is per *destination* (not global), and the journal records intent, before/after bytes and terminal state before any mutation. August's `flock`/lock door and its `transcript_archive` would be the analogues.
- **A persistent interlock that admits one hardware process and keeps its slot after that process exits** — `apps/desktop/tests/windows-signing-state.spec.ts:10` — the slot is *not* released by process exit; an interrupted privileged run needs an explicit human acknowledgement. The same shape would suit a keychain-unlock door or a one-shot credential use.
- **Admission locking that refuses new work, drains admitted work, then re-checks the task set** — `apps/desktop/tests/host-update-tasks.spec.ts:85` and `:114` — work created *during* the confirmation window is discovered, so the privileged action is refused rather than racing it. Directly applicable to August's restart/install-after-confirmation paths.
- **Error copy chosen from a controlled vocabulary, never from the raw message** — `apps/desktop/tests/update-presentation.spec.ts:18` — the visible summary is selected by `failedOperation` (and `preparationFailure`); the message is dropped, and a message that merely *contains* the localised string is still classified generically. This is the "a marker table has to be checked against every emitter" lesson in UI form.
- **Test the real client against a loopback that captures the real bytes** — `apps/desktop/tests/cos-loopback.ts:92` — the `before-send` hook rewrites only the origin, so the signed URL, the headers and the body are the SDK's own. August's provider-body assertions (`dump_openai_upstream_body`) are the same risk; a loopback capture would catch a missing header or a wrong length that a mock never would.
- **Every user-visible string is a snapshot file, so a copy change is a reviewable diff** — `apps/desktop/tests/expected/update-guidance-en.json:44` — 51 `expected/` files hold the exact dialog copy, the DOM structure, the publication markdown and the audit log sequence. A locale or copy change becomes a diff a reviewer can read, instead of a string buried in a test.
- **Capability scoping by frame, not by origin** — `apps/desktop/tests/preload-app.spec.ts:187` — the product API is withheld from same-origin child frames; the owning *frame* must be the application top frame. August's tool-call dispatch has the same shape (which surface is allowed to call what), and this is the cheapest available test for it.
- **A fail-closed policy client that will not guess authentication mode from a response body** — `apps/desktop/tests/mandatory-update-policy.spec.ts:43` — "does not infer login from HTML or unrelated 401". A component that guesses a mode from an ambiguous response silently changes the user's experience; the refusal is the specification.
- **The "Open verification" list — what the evidence does *not* establish** — `apps/desktop/tests/README.md:16` and `apps/desktop/tests/installed-update/README.md:53` — the docs carry an explicit list of eight unproven items, and a sentence saying that `builderCompleted` does not establish package verification. August's `AGENTS.md` has the same instinct; the mechanism here is that the *unproven* list is a first-class, maintained artefact with its own section, not a caveat in prose.
- **A success criterion that is not the process's exit code** — `apps/desktop/tests/fixtures/installer-write-failure-smoke.nsi:9` — the installer exits 0 in both modes while one of them silently mixes old and new files, so the fixture writes `errorFlag=` and `locked=` into a result file and the note says "Exit code 0 alone cannot establish successful extraction". This is the single most transferable idea for an agent harness: a step that *appears* to have succeeded must be checked against an artefact, not against the absence of an error.
- **A percentage parser that must survive arbitrary pipe chunking, and a progress bar that must not creep while stalled** — `apps/desktop/tests/windows-installer-progress.cpp:49` — the same byte stream is replayed in 1, 2, 7 and 128-byte blocks and must parse identically, and a stalled extractor must not approach 100 % merely because time passed. August's streamed-progress indicators have exactly these two failure modes.
- **A progress model that is monotonic and does not treat elapsed time as progress** — `apps/desktop/tests/windows-installer-progress.cpp:32` — identical work fractions give the same value on a fast and a slow disk, so the display reflects work done rather than time spent. The August harness's "elapsed time while the line is still running" convention is the same idea in the other direction.
- **One shared operation, joined by concurrent callers, with the failure shared** — `apps/desktop/tests/update-schedule.spec.ts:76` — a manual check joins the in-flight automatic check and sees its failure rather than starting a second one; the delay starts at completion so a slow check is never overlapped. August's "two callers must not both write the same ledger row" problem has this exact solution.
- **A rule that a *stale* response is rejected by version, not by timing** — `apps/desktop/tests/mandatory-update-window.spec.ts:63` — the approval is bound to the policy version it was rendered for; an answer for a superseded policy is refused, and closing the window does not clear the policy. August's `_stuckRequestEscape` ladder and its "a stale download confirmation is reported as a download failure" rule are the same mechanism.
- **A failed prerequisite stops the sequence, and the failed evidence is retained rather than overwritten** — `apps/desktop/tests/installed-update/README.md:126` — "Do not uninstall, clear caches, delete evidence, or overwrite failed batches to make a later attempt appear successful. Allocate a new run for a clean attempt and retain the failed one." This is the harness-side version of the rule August already follows for `turn_outcomes` rows and `transcript_archive`.
- **The receipt names the version, the run id and the digest, so a confirmation cannot be replayed** — `apps/desktop/tests/installed-update/README.md:53` — `--execute` requires typing `UPLOAD <version> <run-id>` and there is deliberately no piped-approval option. An approval that can be supplied by a script is not an approval.
- **A UI that shows "the app will close and reopen" rather than a spinner, and refuses to claim the app is broken when another instance holds the port** — `apps/desktop/tests/expected/fatal-address-in-use-en.txt:3` — the address-in-use dialog says "Another DSH instance is running… Quit the other running DSH instance, then restart", distinguishing a *conflict* from a *crash* and giving a different recovery (exit/restart only, no disable-plugins).
- **A quarantine pattern for destructive cleanup: unlink the link, never follow it** — `apps/desktop/tests/owned-directory.spec.ts:16` — `removeOwnedDirectory` deletes the owned tree but preserves an unknown directory-link *target*, and refuses a regular-file root. This is the shape of any "clean up the sandbox" door in a harness.

## Files skipped (with reasons)

**None.** Every one of the 260 files in this shard was opened and read; the ledger records all 260 as `read` and there are no generated, vendored, binary or huge-data files in the shard (the largest file is `main-startup.spec.ts` at 127 KB, and it is TypeScript source, not data).

Two files are C++/NSIS/PowerShell rather than TypeScript and were read as source rather than compiled: `apps/desktop/tests/windows-installer-extract-report.cpp`, `apps/desktop/tests/windows-uninstall-data.cpp`, `apps/desktop/tests/windows-installer-presentation.cpp`, `apps/desktop/tests/windows-installer-progress.cpp`, `apps/desktop/tests/fixtures/cli-console-probe.cpp`, `apps/desktop/tests/fixtures/installer-directory-smoke.nsi`, `apps/desktop/tests/fixtures/installer-write-failure-smoke.nsi` and the four `.ps1` scripts. Their assertions are visible in the source, so no execution was needed (and none was attempted — the clone is read-only and untrusted).

## Uncertainties

- **Depth of reading on the very large files.** For six files I read the header, the imports and the *complete* list of test cases but did not read every line of every test body: `apps/desktop/tests/main-startup.spec.ts` (2267 lines), `apps/desktop/tests/keyboard.spec.ts` (793), `apps/desktop/tests/platform-view.spec.ts` (462), `apps/desktop/tests/fixtures/workspace-updates.mjs` (413), `apps/desktop/tests/fixtures/local-updater.mjs` (384), `apps/desktop/tests/windows-sign.spec.ts` (379), `apps/desktop/tests/preload-app.spec.ts` (239) and `apps/desktop/tests/macos-notarization-proxy.spec.ts` (256). Their *names and asserted behaviours* are quoted above, and the assertions themselves are what I based the notes on, but a claim inside one assertion body that I did not read could be wrong. Everything I asserted about these files came from a test title or a comment, both of which I did read.
- **The shard contains no agent-loop source.** I searched the shard for the lenses the assignment names — tool-call parsing, reasoning/thinking deltas, prompt construction, prefix caching, context compaction, per-model fallbacks, model memory, subagent spawning, and eval harnesses — and found none. `apps/desktop/tests/host-update-tasks.spec.ts` and `apps/desktop/tests/host-process.spec.ts` touch the *Host* that runs the loop, and `apps/desktop/tests/fixtures/host-update-qualification.mjs` drives the real `LlmAdapter` streaming protocol (it yields `block-start`/`block-end` tool-call blocks and a `finish` with `reason: { kind: 'tool-calls' }`), but the loop itself lives in another shard. I did not read the implementation modules these tests import (they are outside this shard), so I cannot say how the tested contracts are implemented — only what contract they assert.
- **`apps/desktop/tests/fixtures/host-update-qualification.mjs`**: I read the first 60 lines and the file's structure, not all 203 lines. The `HeldModel` adapter's behaviour is described above from the code I read; the remainder of the fixture (the admission-locking assertions) I inferred from the test names in `host-update-tasks.spec.ts`.
- **The `.expected/` snapshot files under `apps/desktop/tests/expected/welcome/`** are 205 bytes each and hold a flat list of visible strings; I read them all, but I could not tell from the file alone which assertion produces each line (the renderer spec is the consumer), so I described them as "the expected visible strings of the X screen" rather than attributing individual lines.
- **`apps/desktop/tests/fixtures/local-updater.mjs` and `apps/desktop/tests/fixtures/workspace-updates.mjs`** are long scenario scripts. I read their headers, imports, the first ~40–60 lines of each, and every exported function name. My descriptions of their scenario coverage come from the README's evidence table and from the fixture's own comments, not from reading every scenario function.
- **The `expected/` publication markdown files** are Chinese-language approval summaries; I verified their structure and their security-relevant properties (escaped `https&#58;//` URLs, the approval digest, the per-file SHA-256 table, the "the random prefix is not access control" warning) and quoted them, but I did not verify that the generator (`desktop-publication-summary.ts`) produces exactly these bytes — that generator is outside this shard.
- **`apps/desktop/tests/flock-entry.spec.ts`** is 103 lines and I read its header and case list only; it appears to be the cross-process file-lock helper used by the publishing and packaging locks, but I did not read the lock implementation itself (it is outside the shard).
- **I did not run anything.** The clone at `C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness` was read with `read`/`grep`/`glob` and read-only shell commands only. No test, build, script or installer from the clone was executed, and nothing in the clone was modified.
