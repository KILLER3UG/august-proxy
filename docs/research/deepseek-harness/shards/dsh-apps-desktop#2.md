# deepseek-harness / dsh-apps-desktop#2

## Shard shape

This shard is the **Electron main process and preload surface of the DeepSeek Harness desktop app** — 69 files, all under `apps/desktop/src/`. It is not the agent loop; it is the *shell that supervises* the agent loop. The architecture is a three-tier process model: (1) an Electron main process (`main.ts` and friends) that owns windows, menus, tray, updates, and the account/Platform surfaces; (2) a **child "Host" process** (`host-process.ts`) that runs the real `dsh` web backend under the Electron binary in Node mode, spoken to over a Node IPC channel with a small hand-validated event protocol; and (3) sandboxed renderer documents loaded over a private `dsh-app://` scheme, with a *separate* native welcome-window React renderer (`client/WelcomePage.tsx`) and a *separate* shell-owned update/mandatory-update modal document. The main process is the trust boundary: every renderer IPC handler asserts the exact sender frame and origin (`ipc.ts::assertDesktopSender`, `main.ts::assertProductSender`, `main.ts::assertMainApplication`), the Host's IPC messages are structurally validated before they are acted on (`host-process.ts::isDesktopHostEvent`), and webviews are handed out as per-workspace leases with a fixed isolation policy (`browser-guests.ts`). Two large subsystems dominate the file count: the **update/policy machinery** (coordinator, schedule, journal, channel, HTTP executor, presentation, dialog, mandatory-update policy + window + overlay, attention) and the **install/CLI command management** (installation, management, entry worker). Configuration is split between shell-local settings (`settings.ts`, `duration-env.ts`, `update-channel.ts`, `mandatory-update-policy.ts`) and environment-variable overrides. There is **no test file in this shard** — the desktop suite lives in `apps/desktop/tests/` (owned by another shard).

## Per-file notes

### apps/desktop/src/main.ts
- Purpose: The Electron entry point and application controller — single-instance claim, window creation, protocol routing, IPC registration, menus, tray, and the whole boot/quit lifecycle.
- Key abstractions: `createWindow` (one shape of BrowserWindow per platform), `navigateMain` (dedupes concurrent loads of the same URL and swallows `ERR_ABORTED`), `publishUpdate` (the single fan-out point for update state), `reconcileBackend` (one-shot startup promise).
- Data flow: `app.whenReady()` → `claimDesktopSingleInstance` → `main()` → `protocol.handle('dsh-app')` serves shell documents and forwards `/app/*` to the Host with the Host's cookie → `DesktopBackendController.start` spawns the Host → the renderer calls `DESKTOP_IPC.boot` and receives `{injections, streamBaseUrl}` → `openInitialWindow` decides welcome vs. workspace → `before-quit` runs the quit confirmation.
- Non-obvious design decisions: closing the main window **hides** rather than destroys it, so the page and the Host keep running and the next show resumes the same document (`main.ts:1078-1088`). `backendReady` is deliberately frozen during shutdown so a failure while tearing down a ready backend still reports as `running` (`main.ts:74-79`). The update-install handoff is ordered carefully: `host.updateTasks('lock')` → `platformView.closeAndWait()` (the embedded Platform document holds credentials issued by the Host that is about to stop) → `requireCleanStop = true` → `backend.stop()`, and the `updateStopFailure` reset is re-read *after* the await because the backend's async cleanup callback can assign it afterwards (`main.ts:616-637`). A failed install that had already stopped the Host **restarts it** rather than leaving a dead app (`main.ts:538-558`).
- Edge cases / failure handling: `assertProductSender` rejects IPC from any renderer that is not the primary window's main frame (`main.ts:421-427`); `did-fail-load` ignores code `-3` (ERR_ABORTED); `render-process-gone` ignores `clean-exit`; a failed update check is silent by default and only visible on a manual check.
- Surprising: `platformView` is created with a *locale resolver closure* that returns `zh_CN`/`en_US`, and the WebSocket origin rewrite at `main.ts:715-726` refuses any `ws://` request whose `Origin` is not `dsh-app://app` — the host URL's port must match exactly or the request is cancelled.

### apps/desktop/src/host-process.ts
- Purpose: Owns the lifecycle of the child "Host" process (the real `dsh` web backend) and the request/response protocol used to interrogate it.
- Key abstractions: `DesktopHostEvent` (a discriminated union: `ready | fatal | platform-session | shutdown-complete | update-tasks | quit-inspection`), `DesktopHostFatalError` (keeps the Host's inspected diagnostic in a **private** field behind a getter so `util.inspect` does not re-escape it), `DesktopHostUncleanExitError`.
- Data flow: `spawn(node, ['--expose-internals', entry, runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin], {stdio: ['ignore','pipe','pipe','ipc']})` → the child sends `ready {url, injections}` → the shell authenticates the URL for a cookie → later `control()` calls send `{type, requestId}` and correlate answers by `requestId`.
- Non-obvious design decisions: every incoming IPC message is validated by `isDesktopHostEvent` (line 53) before it is trusted, and an invalid message **kills the child** rather than being ignored. The `platform-session` validation rejects request headers named `authorization`, `x-dsh-auth-token`, `host`, `content-length`, `transfer-encoding`, `connection`, `content-type` and any header whose name is not already lowercase or whose value contains CR/LF (lines 69-73), and the origin must be HTTPS or HTTP on loopback. Stderr is kept as a **bounded 64 KiB tail** (`MAX_HOST_DIAGNOSTIC_CHARS`) so a chatty child cannot grow the parent's memory without limit. `stop()` escalates SIGTERM → SIGKILL with three separate `exitsWithin` deadlines (10 s / 5 s / 5 s) and, when `requireGraceful` is set, refuses the update if the child did not acknowledge the shutdown *and* exit 0.
- Edge cases / failure handling: `exitsWithin` (line 93) uses `timer.unref()` so a pending deadline never keeps the Electron process alive. `stop()` throwing `DesktopHostUncleanExitError` is distinguished from a general failure: the message says "confirmed exit but refuses installation" and deliberately contains no subprocess stderr ("This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials", line 305).
- Surprising: the child is launched with the **Electron executable** in Node mode (`ELECTRON_RUN_AS_NODE=1`), not a separate Node binary, so the shipped app has exactly one runtime to sign and ship.

### apps/desktop/src/backend-controller.ts
- Purpose: Owns one backend startup and its quiescent teardown, independently of any window.
- Key abstractions: `DesktopBackendState` (`starting | ready | error`), `Attempt` (a per-start generation with `cancelled`, `failure`, `host`, `cleanup`).
- Data flow: `start(prepare)` → awaits the previous attempt's cleanup → `prepare()` → `createHost(onFailure)` → `host.start()` → publish `ready`. `stop()` marks the attempt cancelled and awaits `Promise.allSettled([cleanup, pending])`.
- Non-obvious design decisions: the `attempt` object is a **generation token**; `failed()` ignores a failure whose attempt is no longer current (`if (this.attempt !== attempt || attempt.cancelled) return`, line 139), so a child that dies after its replacement started cannot poison the new state. `stop()` can cancel an attempt *while preparation is pending* and *while the child starts*, which is why the `attempt.cancelled` checks are re-read after every `await` (lines 73-84). A startup failure and its cleanup failure are merged into an `AggregateError` rather than one being swallowed (line 90).
- Edge cases / failure handling: `publish` exceptions are caught and logged, never allowed to break the controller (line 153). `close()` is permanent: it sets `closed`, and `host` getter returns `undefined` whenever closed.
- Surprising: `start()` while `stopping` **rejects** rather than queueing ("desktop backend is stopping"), so a caller that races an update install gets a hard error instead of a silent no-op.

### apps/desktop/src/account-backend.ts
- Purpose: Native account commands and the Gateway state stream; no renderer ever receives credentials.
- Key abstractions: `accountView(value)` — a **whitelist re-projection** of the wire state that drops unknown fields and throws on an unexpected shape; `DesktopAccountBackend` with `state/start/cancel/signOut/watch`.
- Data flow: unary RPC (`account/getState`, `account/startSignIn`, …) for commands; a WebSocket to `REMOTE_STREAM_MUX_PATH` multiplexes **three** logical streams on one socket (`account/watch`, `account/watchExpiry`, `productAnalytics/watchPolicy`), each with its own `streamId`, and every frame is routed by `frame.streamId`.
- Non-obvious design decisions: `validateBrowserDestination` (line 48) permits only HTTPS, or HTTP on `localhost`/`127.0.0.1`/`[::1]`, and rejects any URL carrying `username`/`password` — a URL that leaves the native app must be a clean destination. The `watch` socket carries `maxPayload: 65_536` and re-connects after 1 s on close, and a reconnect explicitly publishes `onAnalyticsEnabledChanged(false)` because "a disconnected stream publishes false".
- Edge cases / failure handling: an unexpected `streamId` on the socket throws, which closes the socket (line 121-124) — a multiplexed stream that delivers a frame on the wrong id is treated as corruption, not as data. The `failed` callback is explicitly documented as "the stream reconnects; a transport failure does not change account state" (`main.ts:487-489`).
- Surprising: the account `attempt.phase` vocabulary is a closed list of seven values checked in `accountView`; an unknown phase is a hard error, not a passthrough.

### apps/desktop/src/background-notice.ts
- Purpose: One-time Windows confirmation before hiding the application to the tray.
- Key abstractions: `DesktopBackgroundNotice` with a persistent marker file and an in-memory `acknowledged` flag.
- Data flow: `close(hide)` → if the marker file exists, hide immediately; otherwise show the dialog → on confirm, write the marker under Electron `userData` and hide.
- Non-obvious design decisions: the marker lives under `userData`, so "updates retain it and uninstall removes it" (`main.ts:1000`) — the user is asked once per installation, not once per session. Repeated close requests while the prompt is open **focus** the existing prompt rather than stacking a second one (line 32).
- Edge cases / failure handling: a cancelled prompt leaves the acknowledgement unset, so the next close asks again; a write failure to the marker is logged as a warning and does not prevent the hide.
- Surprising: `dispose()` makes late dialog responses inert ("Ignore late dialog responses after application shutdown begins", line 38) — the app can be quitting while the native box is still open.

### apps/desktop/src/browser-guests.ts
- Purpose: Main-process ownership and a fixed isolation policy for Sidebar webview guests.
- Key abstractions: `DesktopBrowserGuests` (partition-per-workspace, lease-per-tab), `GuestLease` (`owner`, `partition`, `attached`, `guest`, `releaseInput`).
- Data flow: the renderer calls `browserAcquire(workspace)` → the main process mints a random `partition` and a random `lease` → the renderer creates a `<webview>` whose `src` is `about:blank#<lease>` → `will-attach-webview` validates the lease, owner, `attached` flag and partition, and **overwrites** the preferences with the fixed policy → `dom-ready` binds the guest.
- Non-obvious design decisions: the attach check runs *before* the renderer can navigate the ready guest, and the first document is an inert `about:blank` carrying the approved lease (line 96-98). The `will-attach-webview` handler **deletes every preference key except `disablePopups`** and then assigns the allowlist (lines 82-91) — a renderer-supplied preference can never widen the policy. The guest session denies all permission requests, display media and downloads, and its `onBeforeRequest` cancels any network URL with embedded credentials and any URL pointing at the application's own Host (lines 141-153).
- Edge cases / failure handling: `release()` refuses a lease owned by another window; guests are closed with `waitForBeforeUnload: false`; a main-frame navigation of the owner, a renderer crash, or window destruction releases every lease.
- Surprising: `isApplicationHost` compares **port** plus a hostname/loopback alias set, so a guest cannot navigate to the Host even when the Host is on `localhost` and the guest is on `127.0.0.1` (line 163-169).

### apps/desktop/src/client-metadata.ts
- Purpose: Desktop client identity for one Platform account call.
- Key abstractions: `desktopClientVersion()` and `desktopClientMetadata(locale)`.
- Data flow: `DSH_CLIENT_VERSION` (inlined by the Desktop build) → `{version, locale, timezoneOffsetSeconds}` sent with every Platform request.
- Non-obvious design decisions: a missing `DSH_CLIENT_VERSION` **throws** instead of reporting a guessed version ("instead of reporting a guessed one", line 7) — the shell refuses to talk to Platform with an unknown identity.
- Edge cases / failure handling: none beyond the throw; the value is read fresh each call.
- Surprising: `timezoneOffsetSeconds` is computed as `-getTimezoneOffset() * 60` because `getTimezoneOffset` reports minutes *west* of UTC while Platform wants seconds *east* (line 26-27).

### apps/desktop/src/client/styles.d.ts
- Purpose: Ambient declaration for CSS imports in the standalone Welcome renderer.
- Key abstractions: `declare module '*.css'`.
- Data flow: TypeScript only.
- Non-obvious design decisions: the comment pins this to the *standalone* Welcome renderer, distinguishing it from the main Web app's build.
- Edge cases / failure handling: none.
- Surprising: it is the only `.d.ts` in the shard, and it exists only so `import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'` type-checks.

### apps/desktop/src/client/welcome.tsx
- Purpose: Mounts the local React renderer before Electron reveals the welcome window.
- Key abstractions: `createRoot` + `flushSync` so the first paint already has content; a `data-ds-dark-theme` body attribute driven by `matchMedia('(prefers-color-scheme: dark)')`.
- Data flow: imports the design-platform and gradient-shadow-text stylesheets → renders `<Welcome api={window.dshWelcome} />` → the API object is injected by the preload, not by the page.
- Non-obvious design decisions: `flushSync` around `root.render` (line 24) — the window is shown by the main process immediately after `loadFile` resolves, so a half-painted React tree would flash. The `matchMedia` listener is removed on `pagehide` and the root is unmounted there too, so a reloaded welcome window does not leak a stale root.
- Edge cases / failure handling: a missing `#root` throws immediately rather than rendering into nothing.
- Surprising: this renderer does **not** use the shared theme bootstrap; it re-implements the dark-mode attribute locally so the native window's acrylic background matches.

### apps/desktop/src/client/WelcomePage.tsx
- Purpose: The standalone welcome flow (sign in / API key / skip) — the only first-run UI in the shard.
- Key abstractions: `Page = 'entry' | 'key' | 'account'`, a `revision` counter as a **stale-response guard**, and refs mirroring state (`pageRef`, `attemptRef`, `busyRef`) so async callbacks can read the current truth without re-subscribing.
- Data flow: `api.onAccountState` pushes a new `AccountView` → `showAccount(state)` decides entry vs. account page → the shell's `watch` stream is the only source of truth; the renderer never polls.
- Non-obvious design decisions: every async action captures `const current = ++revision.current` and only applies its result `if (mounted.current && revision.current === current)` (lines 133-139, 144-147, 156-162) — a sign-in response that arrives after a cancel cannot resurrect a stale attempt. The API-key validator rejects anything outside `[\x21-\x7e]`, rejects `NAME=value` prefixes, and rejects a quoted value (lines 93-94), so a pasted `export OPENAI_API_KEY="..."` is refused with a specific message. `busyRef` (a ref, not state) gates double-submits synchronously, before React re-renders. The account page is `aria-live="polite"`, and the "ongoing" state renders a `StateDot` spinner *inside a disabled button* rather than a separate spinner element.
- Edge cases / failure handling: a closed Welcome IPC channel is caught and ignored (line 59-61) — "A closed Welcome IPC channel must not interrupt the sign-in page." `cancel()` deliberately leaves the current attempt visible on failure so the user can retry.
- Surprising: `document.title` and `document.documentElement.lang` are set from the injected locale in an effect, so the native window's title and the accessibility language are owned by the shell's copy, not by the page.

### apps/desktop/src/command-installation.ts
- Purpose: Reversible command-link ownership for the `dsh` CLI entry; operations never follow or overwrite a changed command entry.
- Key abstractions: `Entry` (kind + fingerprint + target), `Receipt` (the on-disk ownership record), `CommandInspection` (the state shown to the user), `CommandInstallationError` with codes `EOWNERSHIP | ESTALE | EUNSUPPORTED | ENOENT`.
- Data flow: `inspectFileCommand` → `readSnapshot` reads the destination entry and the receipt → a `fingerprint` is the digest of `{entry.fingerprint, receipt}` → the user's confirmation is bound to that fingerprint → `installFileCommand(options, expected)` re-reads under a file lock and refuses if the fingerprint moved.
- Non-obvious design decisions: the fingerprint is built from `lstat` fields (`dev, ino, mode, uid, gid, size, mtimeNs`) plus the symlink target, so a replaced file is detected even when its content is identical (lines 65-71). The previous entry is **renamed** aside to `.dsh-command-backup-<uuid>` rather than deleted, and the rename is re-verified afterwards: if the fingerprint changed during the rename the backup is restored and the operation fails with `ESTALE` (lines 165-177). macOS needs a `linkat` helper because Node's `link()` follows symlinks (line 160-163). The receipt is written with `writeFileAtomic` under a `withFileLock`, and the receipt itself is schema-validated on every read, refusing a file over 8192 bytes or a backup name that does not match `\.dsh-command-backup-[a-f0-9-]{36}$`.
- Edge cases / failure handling: every failure path restores the previous entry; a failure to restore raises an `AggregateError` naming the preserved path ("The previous command is preserved at " + moved), so a user is never left guessing where their old command went. When another installer owns the current entry, `removeFileCommand` keeps it and only deletes the receipt (line 260-263).
- Surprising: `installFileCommand` is *idempotent-ish by content, not by path* — a managed entry that is unchanged is re-linked and the old backup is retained, and the result can carry a `preservedBackup` path when an external replacement happened.

### apps/desktop/src/command-management.ts
- Purpose: The native "Manage dsh Command…" dialog; only fixed installation locations reach the worker.
- Key abstractions: `presentCommandManagement(state, messages, platform)` (pure, returns `MessageBoxOptions`), `DesktopCommandManager` with a single `operation` promise, `CommandWorkerError` with a `code`.
- Data flow: `show()` → `inspect()` (runs the worker, plus a `shellCommand()` probe on macOS) → a native dialog → the chosen operation is run by the worker with the observed `fingerprint` → a re-inspect → a result dialog.
- Non-obvious design decisions: the worker is a **separate bundled Node process**, and the parent strips `KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$` from the child environment (line 148-149) so no credential reaches the mutation path. On macOS an `EACCES`/`EPERM` from the unelevated worker is retried **elevated** through `osascript` with administrator privileges (line 164-166), and the elevated path is only entered for a mutation, never for `inspect`. `shellCommand()` runs `command -v dsh` in an interactive login shell with a NUL-delimited marker to discover which `dsh` actually wins on PATH (line 112-121), and a failure there yields `selectionUnknown` rather than a diagnostic.
- Edge cases / failure handling: `ESTALE` maps to "The command or PATH changed while this dialog was open" and `EOWNERSHIP` to "The command registration or backup changed. No unrelated command was removed." (locale strings) — distinct user-facing outcomes for distinct machine states. `ECANCELED` (the user dismissed the macOS elevation prompt) exits silently.
- Surprising: `parseState` rewrites the destination on Windows to `join(value.directory, 'dsh.cmd')` and the launcher to the destination — the worker returns a *directory* on Windows and the shell does the OS-specific composition (lines 57-59).

### apps/desktop/src/command-manager-entry.ts
- Purpose: The private command-management worker entry point; macOS mutation targets are fixed before elevation.
- Key abstractions: the `operation`/`expected` argv pair, and per-platform branches.
- Data flow: argv → validate `operation ∈ {inspect, install, remove}` and (for mutations) a 64-hex fingerprint → macOS: call `inspectFileCommand`/`installFileCommand`/`removeFileCommand` with **hard-coded** `/usr/local/bin/dsh` and bundled `launcher`/`linkHelper` paths; Windows: pipe the request as JSON on stdin to a bundled `command-path.ps1`; anything else: `EUNSUPPORTED`.
- Non-obvious design decisions: the mutation destination is a **constant in the worker**, so nothing a caller passes can steer it — the elevated `osascript` invocation in `command-management.ts` passes `operation` and `expected` as argv to a worker that then resolves the path itself, meaning the elevation prompt can never be talked into touching a different path. The worker sets `process.umask(0o022)` on macOS "This dedicated worker writes public command ownership metadata, not user secrets" (line 11-12). The response is written to **stdout** as a single JSON line, and the parent tolerates the JSON on stdout even when the child exited non-zero (line 157 of `command-management.ts`).
- Edge cases / failure handling: "osascript preserves stdout only when the command exits successfully; the response owns operation failures" (line 40) — so failures are reported through the JSON envelope, not the exit code.
- Surprising: the Windows path never touches the filesystem from Node at all; it delegates to a PowerShell script through stdin, because the Windows install is a `.cmd` shim plus a PATH edit rather than a symlink.

### apps/desktop/src/core-package-set.ts
- Purpose: The signed local npm package set that supplies the Desktop-owned `dsh` runtime and the private Host package.
- Key abstractions: `DesktopCorePackageSet` (schemaVersion 1 + sorted package records), `DesktopCorePackageRecord` (`name, version, file, bytes, integrity`).
- Data flow: `readDesktopCorePackageSet(projectDir)` → `parseDesktopCorePackageSet` validates every record against name/version/file/integrity regexes and enforces **sorted-by-name** ordering → `desktopCorePackageOverrides` maps every package to a `file:./desktop-packages/<file>` spec → `verifyDesktopCorePackageSet` re-hashes every tarball.
- Non-obvious design decisions: the descriptor must be sorted by name (`if (JSON.stringify(sorted) !== JSON.stringify(packages)) throw`) — a canonical form so two descriptors for the same set are byte-identical. `verifyDesktopCorePackageSet` compares the **directory listing** with the descriptor's file list, so an extra file in the package directory is a failure even if every listed tarball is intact (lines 137-146). The integrity string is `sha512-<base64>` and the byte count is checked too.
- Edge cases / failure handling: `expectedReleaseVersion` binds `@deepseek-ai/dsh` and `@deepseek-ai/dsh-desktop-host` to the exact Desktop version, so a mismatched pair fails at the boundary.
- Surprising: `verifyDesktopCoreLockfile` (line 170) regex-scans the generated pnpm lockfile for any `name@version:` registry resolution and refuses it — the check that keeps the bundled runtime off the network at install time.

### apps/desktop/src/crash-report.ts
- Purpose: Write the complete diagnostic of one fatal failure to a file *before* the recovery dialog, so the dialog can name the file.
- Key abstractions: `RendererConsoleTail` (a bounded tail of error-level renderer output), `renderCrashReport(input)`, `writeCrashReport`, `pruneCrashReports`.
- Data flow: `main.ts::persistCrashReport` → `writeCrashReport(app.getPath('logs'), {source, phase, error, hostDiagnostic, rendererConsole, app, time})` → a `crash-<ISO>-<source>.log` file written with `flag: 'wx'` and mode `0600` → `pruneCrashReports` keeps the newest 10.
- Non-obvious design decisions: the file name is **sortable by time** (ISO with `:` and `.` replaced by `-`) and the pruner matches a strict regex `^crash-\d{4}-…-(host|web-boot|renderer|main)\.log$` so it can only ever delete its own reports and leaves every other file in the logs directory alone (line 47, 175). The error section is `util.inspect(error, {depth: 6, maxStringLength: 64 KiB, maxArrayLength: 100})` and is then cut at 256 KiB with a visible "… cut at N characters" marker. The renderer console tail drops lines from the *head* but always keeps one oversized line whole, "so a long stack is never cut mid-line" (lines 60-61).
- Edge cases / failure handling: writing the report is best effort — a failure logs and yields `undefined`, and the recovery dialog proceeds without a path rather than failing over a diagnostic aid.
- Surprising: `phase` is `startup` or `running`, and the `phase` recorded is the shell's belief about the backend, not the error's own phase.

### apps/desktop/src/device-info.ts
- Purpose: A local machine description attached to the Desktop feedback questionnaire.
- Key abstractions: `readDeviceInfo()` and a `collect(fields, name, read)` helper.
- Data flow: `platform` → `os` → `app_arch` → `cpu` → `memory_gib`, joined as `name=value` pairs separated by `; `.
- Non-obvious design decisions: each field is collected independently and **omitted** when its source throws or is empty ("A refused or unsupported source omits only its own field", line 30), so one missing fact never blanks the whole description. The doc comment in `ipc.ts` states the contract explicitly: "no hostname, user name, or serial number".
- Edge cases / failure handling: `cpus()[0]?.model` may be undefined; `totalmem` may be unavailable.
- Surprising: memory is total physical memory in GiB with one decimal, and the field order is fixed by the code rather than sorted — the format is asserted by a sibling spec file.

### apps/desktop/src/directory-picker.ts
- Purpose: Window-owned workspace directory dialogs for the local Desktop renderer.
- Key abstractions: a `WeakMap<BrowserWindow, Promise<string|null>>` of in-flight picks.
- Data flow: `ipcMain.handle(DESKTOP_IPC.directoryPick)` → owner/frame check → if a pick is already pending for this window, **return the same promise** → `dialog.showOpenDialog(window, {properties: ['openDirectory','createDirectory']})`.
- Non-obvious design decisions: the pending promise is per-window and is reused, so a second request joins the first instead of opening a second native dialog (lines 19-20). The window is restored, shown and focused before the dialog opens, so the dialog is not opened behind a minimized window.
- Edge cases / failure handling: a destroyed window or a cancelled dialog yields `null`; the `finally` removes the pending entry so a later request can open a fresh dialog.
- Surprising: `assertDesktopSender(event, ['app'])` is called *after* the frame check, so a request from a shell document is refused for two independent reasons.

### apps/desktop/src/duration-env.ts
- Purpose: Read a millisecond duration from the process environment without clamping.
- Key abstractions: `resolveDurationMs(env, name, fallback)`.
- Data flow: `Number(env[name] ?? fallback)` → range check → the value or a thrown error.
- Non-obvious design decisions: the bounds are exactly `setTimeout`'s: 1000 through 2147483647. Out-of-range values **throw** rather than being clamped, and the error message names the offending variable ("`DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS` must be an integer from 1000 through 2147483647").
- Edge cases / failure handling: a non-integer, a NaN, or an out-of-range value is a startup failure, not a silent default — a misconfigured timeout should not become a 1 ms poll.
- Surprising: this 16-line helper is the shared validator behind four separate duration settings (login shell, update interval, update backoff, policy interval/timeout), which is why the same range appears in `mandatory-update-policy.ts` and `update-http-executor.ts`.

### apps/desktop/src/fatal-recovery.ts
- Purpose: Native recovery for the *first* fatal failure in one Desktop process.
- Key abstractions: `RecoveryOperations` (messages / show / stop / disablePlugins / exit / restart / writeReport), `DesktopFatalRecovery` with a one-way `reported` flag.
- Data flow: `report(error, source)` → `persist()` writes the crash report with a 1 s cap → `dialogDetail()` composes the dialog text → the user picks Exit / Restart / Disable-third-party-plugins → the chosen operation runs, and a failure inside it **re-loops the dialog** with `recoveryOperationFailed` copy.
- Non-obvious design decisions: only the **first** fatal report is shown ("later reports cannot replace it or open another dialog", line 58) — the process is already in a broken state, and a second dialog would be a second owner. The crash report is written *first* and the dialog names the file, but the report write is bounded by `CRASH_REPORT_WAIT_MS = 1000` so a slow disk cannot delay the user's recovery. The dialog's detail is budgeted to 1200 characters: the last 8 lines of the error, the report path, and a reinstall hint, with the tail cut from the *front* (line 39) — the most recent stack frames survive. An `EADDRINUSE` match in the message swaps in a specific copy and drops the "disable plugins" button, because "Another DSH instance (such as dsh web or the desktop app) is running" is a different failure class.
- Edge cases / failure handling: a lone leading surrogate is stripped after slicing (`replace(/^[\uDC00-\uDFFF]/u, '')`) so a cut emoji does not render as a replacement glyph. A failure in the recovery operation itself re-prompts rather than exiting silently.
- Surprising: the "disable third-party plugins" path backs up the profile patch and **restarts** the app — the recovery action is a remediation, not an exit.

### apps/desktop/src/host-protocol.ts
- Purpose: Release metadata for the Desktop Host lifecycle protocol.
- Key abstractions: `DESKTOP_HOST_PROTOCOL_VERSION = 4`.
- Data flow: consumed by `release.ts::parseDesktopRelease`, which refuses a descriptor whose `hostProtocolVersion` does not equal the constant.
- Non-obvious design decisions: the version is a **compile-time literal** (`as const`) rather than a runtime field, so the shell and its bundled Host must agree by construction; a mismatched Host is a validation failure at read time, not a negotiation.
- Edge cases / failure handling: `parseDesktopRelease` throws "invalid desktop release metadata" for any mismatch.
- Surprising: it is four lines and is a whole file, because it is the single point of truth for a cross-process contract version.

### apps/desktop/src/ipc.ts
- Purpose: The typed preload operations exposed only by the Electron shell.
- Key abstractions: `DESKTOP_IPC` (the channel-name constant), `DesktopUpdateState` / `DesktopUpdatePresentation` / `DesktopUpdateFailureKind`, `DshDesktopProductApi` (the renderer's view of the shell), `SCHEME = 'dsh-app'`, `assertDesktopSender`.
- Data flow: the preload invokes a named channel; the main process asserts the sender and answers with a `DesktopUpdatePresentation` (semantic status only, never raw diagnostics).
- Non-obvious design decisions: `DesktopUpdatePresentation` deliberately carries **no** version-bearing URL, no package URL and no installation authorization: "Product documents cannot supply update versions, package URLs, or installation authorization" (line 71). `assertDesktopSender` checks the frame's URL protocol *and* hostname against an allowlist — a frame with no `senderFrame` is rejected outright.
- Edge cases / failure handling: `technicalDetails` on `DesktopUpdateState` is documented as "Main-owned diagnostics without subprocess output or credentials; hidden until expanded" — the shell chooses what is safe to show.
- Surprising: the same file mixes the renderer's public API type and the main-process sender assertion, so the contract and its enforcement live in one place.

### apps/desktop/src/keybindings.ts
- Purpose: Device-local shortcut preferences in Electron `userData`; writes share one serialized coordinator.
- Key abstractions: `desktopKeybindings(userData, platform, publish)` → a `ShortcutPersistence` from the shared client package.
- Data flow: `read` returns `null` on ENOENT (meaning "no file yet", not an error) → `write` uses `writeFileAtomic(path, raw, {mode: 0o600, dirMode: 0o700})`.
- Non-obvious design decisions: the path is `join(userData, 'keybindings.json')` where `userData` is "Electron-owned userData directory, never a Renderer-supplied path" (line 10) — the renderer cannot choose where preferences live. The persistence is constructed with `'desktop'` as the scope and `false` for a flag, and the `publish` callback is invoked **after commit** ("updates the native binding index and trusted product page after commit").
- Edge cases / failure handling: a missing file is distinguished from a read error, so first run is a normal path.
- Surprising: the actual conflict detection, revision handling and normalization live in the shared `@deepseek-ai/dsh-client-shortcuts/protocol` package; this file is only the platform binding.

### apps/desktop/src/keyboard.ts
- Purpose: Product-window preference IPC and native menu interception during physical-key dispatch and recording.
- Key abstractions: `installDesktopShortcuts(...)` returning `{fileMenu, sendEditingKey, attach, attachGuest, dispose}`, and a per-contents `attachInput` closure holding the chord state (`deadKey`, `held`, `consumed`).
- Data flow: the renderer asks for definitions → `persistence.readCurrent()` → `publish(snapshot)` computes the effective binding set → `before-input-event` intercepts physical keys and forwards a normalized `{kind, revision, frameName, code, secondCode, repeat, control/alt/shift/meta}` to the renderer.
- Non-obvious design decisions: the interceptor distinguishes four input kinds — `keyboard` (main frame), `iframe`, `webview`, and `menu` — and the **preload** re-verifies the frame: for an iframe it requires the active element to be an `HTMLIFrameElement` matching `iframe[data-sidebar-browser-frame], iframe[data-html-preview]` with a matching `name` (`preload-app.ts:22-32`), so a key aimed at an unrelated frame is dropped. A **chord** (two physical keys) is supported on desktop platforms: the held set is sorted and matched as a `secondCode` pair (lines 174-178). `editingInput` is a bypass used by the native Edit menu — Electron's `sendInputEvent` is synchronous for these keys, so the code sets `editingInput = contents`, sends keyDown+keyUp, and restores it in a `finally` (lines 225-240). Chords require the key *release* to reach the same handler that consumed the press, because "a chord's first key reached the renderer, so its release must reach the same input handlers" (line 163) — the code therefore tracks a `consumed` map of press/repeat and calls `preventDefault()` on the matching keyUp.
- Edge cases / failure handling: `setIgnoreMenuShortcuts` is toggled to `true` whenever the renderer owns the key (matching binding, recording, or the close-page menu match) and back to `false` on every exit path. Auto-repeat is suppressed unless the key is bound. Dead keys, IME composition and AltGr all clear the held set instead of being interpreted as chords.
- Surprising: the overlay revision is polled on every input event — `if (overlay.revision !== overlayRevision) { resetInput(); overlayRevision = overlay.revision }` — so an update overlay opening mid-chord resets the chord state rather than leaving a half-pressed key set.

### apps/desktop/src/locale.ts
- Purpose: Typed English and Chinese copy owned by the Electron shell.
- Key abstractions: `en` and `zh` as `as const` objects, `DesktopMessages` (a mapped type requiring every English key), `DesktopLocale` (`{id, messages}`).
- Data flow: `resolveDesktopLocale(locale)` picks the dictionary → `resolveDesktopStartupLocale(preference, languages)` picks the preference, then the OS language list → `formatDesktopMessage(message, values)` substitutes `{path}`-style placeholders → the copy reaches menus, dialogs and the Welcome renderer.
- Non-obvious design decisions: `zh` is declared `as const satisfies DesktopMessages`, so the type system guarantees the Chinese dictionary has **every** key the English one has and no extra — a missing translation is a compile error, not a runtime `undefined`. The placeholder substituter leaves an unknown `{placeholder}` **in place** rather than rendering `undefined` (line 376) — a missing value is visible in the UI instead of silently becoming the string "undefined".
- Edge cases / failure handling: `resolveDesktopLocale` treats anything not starting with `zh` as English.
- Surprising: `desktopUpdateReadyConfirmation` (line 386) picks a *different* detail string on Windows, because the Windows installer is a visible in-place replace while the macOS one is not — the same message needs different words per platform.

### apps/desktop/src/login-shell-environment.ts
- Purpose: Read the user's login-shell environment once, for POSIX launches that inherit only the session manager's environment.
- Key abstractions: `DesktopLoginShellConfig` (one timeout), `DesktopLoginShellResult` (environment + per-candidate failures), `parseLoginShellOutput`, `mergeLoginShellEnvironment`, `loginShellCandidates`.
- Data flow: `readDesktopLoginShellEnvironment(base, config, {signal})` → for each candidate shell, `spawn(shell, ['-ilc', DUMP], {detached: true})` → the dump prints `printf '\0<delimiter>\0'; command env -0; printf '\0<delimiter>\0'` → the output between the two NUL-delimited markers is parsed into variables → merged over the inherited environment.
- Non-obvious design decisions: the candidate list is "the account record's login shell (**not** `$SHELL`), then fixed system shells" (line 62) — `$SHELL` is the user's *interactive* shell and may be a wrapper; `userInfo().shell` is the real login shell. The read completes at the **closing delimiter**, not at `close`, because "Background children started by rc files inherit stdout and can hold it open long after the shell exits" (lines 130-132); the parser therefore counts delimiter markers in a sliding window across chunk boundaries. The probe runs with `DISABLE_AUTO_UPDATE`/`ZSH_TMUX_AUTOSTARTED` set so oh-my-zsh's update prompt and tmux's autostart plugin cannot block a non-terminal read. `mergeLoginShellEnvironment` drops probe-session variables (`PWD`, `OLDPWD`, `SHLVL`, `_`) and anything starting with `DSH_` or `ELECTRON_` — "Desktop resolves paths such as `DSH_HOME` before the read, so the Host keeps the same inherited values" (line 16). The probe runs in its **own process group** (`detached: true`) so it can be killed as a group on timeout or abort.
- Edge cases / failure handling: the function **never rejects** — each failing candidate is recorded with a reason (`exit <code>`, signal name, spawn error, `timeout`, `aborted`, `unparsed`) and the next is tried; `base` is returned if all fail. `win32` returns `base` unchanged, because "Windows GUI launches already inherit the registry environment".
- Surprising: the probe environment is set on the *child* only, and the `stop()` helper kills the whole process group with `process.kill(-pid, 'SIGKILL')` — but the code notes that members which left the group can keep stdout open, so the read resolves without waiting for `close`.

### apps/desktop/src/mandatory-update-ipc.ts
- Purpose: Dependency-free IPC names shared with the sandboxed mandatory-update preload.
- Key abstractions: `MANDATORY_IPC` = `{status, state, action}`.
- Data flow: the preload calls `MANDATORY_IPC.status` / `.action`; the main process pushes `MANDATORY_IPC.state`.
- Non-obvious design decisions: the file is deliberately dependency-free so the *sandboxed* preload can import it without pulling the main-process graph in — the preload runs in an isolated world.
- Edge cases / failure handling: none.
- Surprising: the same pattern appears for `PLATFORM_IPC` and `UPDATE_DIALOG_IPC` — three separate "private channel name" modules so that each preload's import graph is minimal.

### apps/desktop/src/mandatory-update-policy.ts
- Purpose: The mandatory-update policy — a server-driven "you must update" decision, independent of the local business traffic and of updater artifacts.
- Key abstractions: `DesktopPolicyConfig` (origin, allowed page/auth origins, interval/timeout/backoff, jitter, authentication mode), `DesktopPolicyState` (`blocking`, `checking`, title/detail/page, error), `DesktopMandatoryUpdatePolicy`.
- Data flow: `check(scenario, manual)` → `GET {origin}/api/v0/check_client_update?scenario=...` with `platformClientHeaders` plus `x-client-arch`, `x-client-update-channel`, `x-client-bundled-dsh-version` → `parsePolicy` reads `code === 40005` (mandatory) or `code === 0 && biz_code === 0 && biz_data === null` (no force) → a backoff timer schedules the next check.
- Non-obvious design decisions: **"A known block survives transport and parsing failures, but not a fresh no-force success"** (line 26) — the catch block increments `failures` and sets `error: 'unavailable'` while *retaining* `blocking: true` from the previous decision, so a network blip can never unblock a mandatory update. The backoff is exponential on the failure count and capped at `maxBackoffMs`, with jitter applied to the *final* delay (`base * (1 + random() * jitter)`, line 215). Concurrent callers **share one request** (`if (this.pending !== undefined) return this.pending`) even for a manual check — "manual bypasses interval/backoff without bypassing request coalescing" (line 172). `dispose()` aborts the in-flight request and awaits settlement so a late response cannot publish or reschedule. `desktopPolicyPage` re-validates the policy's own page URL against the deployment allowlist *immediately before* the browser or clipboard uses it (line 96) — the policy server is not trusted to name an arbitrary destination.
- Edge cases / failure handling: a `401` with `error.code === 'UNAUTHENTICATED'` in the `feishu-test` mode is distinguished from a transport failure and surfaces as `error: 'authentication-required'`, which is what triggers the sign-in prompt. `redirect: 'error'` is set on the request, and `credentials` is `include` only for the authenticated mode.
- Surprising: `resolveDesktopPolicyConfig` refuses to accept `allowedAuthOrigins` at all in `anonymous` mode ("anonymous policy must not configure allowedAuthOrigins", line 81) — the configuration itself is prevented from describing an authentication flow it cannot use.

### apps/desktop/src/mandatory-update-window.ts
- Purpose: The shell-owned modal policy UI; only explicit actions authorize downloads or browser navigation.
- Key abstractions: `MandatoryUpdateAction` (`refresh|download|install|later|page|copy`), `MandatoryUpdateView` (locale + policy + update + confirmation + deferred + restart + navigation), `DesktopMandatoryUpdateWindow`.
- Data flow: the shell publishes `MANDATORY_IPC.state` to the overlay or the modal document → the document calls `action(action, version, confirmationRevision)` → the main process validates the action against the *current* policy and, for `install`/`later`, against the live confirmation revision.
- Non-obvious design decisions: the confirmation is **revisioned** — a stale `install` from an old prompt is rejected with "stale installation confirmation" (line 84), so a dialog that was replaced while the user was reading it cannot install. `later` is refused outright when no confirmation is open ("no installation confirmation", line 92) and refused again when the confirmation says there are no tasks to defer ("no task deferral is offered", line 86). On Windows the modal is **embedded in the main window** rather than being a separate `BrowserWindow` (`this.embedded = process.platform === 'win32'`), and the embedded path re-publishes on the parent's `did-finish-load` so a reloaded main window re-blocks. The overlay window's `close` event is turned into `app.quit()` while the policy is still blocking (line 197) — the user cannot dismiss the block by closing it. `navigate('copy')` **reads the clipboard back** and fails if it did not retain the address ("clipboard did not retain download address", line 286), because a silent copy failure would leave the user with no download link.
- Edge cases / failure handling: a failed document load leaves the parent blocked and retitles the window to `mandatoryActionFailed` rather than letting the user proceed (line 203-210). `navigationEpoch` invalidates a late navigation result after `clearNavigation()`.
- Surprising: the policy's `page` URL is re-validated against `allowedPageOrigins` inside `navigate()` even though it was already validated when the policy arrived — defence in depth at the point of use.

### apps/desktop/src/microphone-permissions.ts
- Purpose: Microphone access belongs to the primary application frame and the operating system.
- Key abstractions: `applicationFrame(url)`, `installMicrophonePermissions(session, primary)`.
- Data flow: `setPermissionCheckHandler` and `setPermissionRequestHandler` both require `contents === primary()`, `details.isMainFrame`, the `dsh-app://app` origin, and `mediaType === 'audio'`.
- Non-obvious design decisions: on macOS the check handler additionally requires `systemPreferences.getMediaAccessStatus('microphone') === 'granted'`, and the request handler calls `askForMediaAccess` — the OS prompt is the real gate, and the app's own check mirrors it. Non-media permissions are passed through (`callback(true)`) so Electron's defaults still apply to everything else.
- Edge cases / failure handling: `mediaTypes` must have exactly one entry, `audio` — a request for audio+video is refused. A failing `askForMediaAccess` resolves `callback(false)`.
- Surprising: the request handler asserts `details.mediaTypes.length === 1` while the check handler asserts `details.mediaType === 'audio'`; the two paths answer slightly different questions (one is "is this permission granted", the other "should we grant it now").

### apps/desktop/src/node-environment.ts
- Purpose: Electron Node-mode startup, with private shell launchers scoped to package installation.
- Key abstractions: `desktopNodeEnvironment(executable, bin, environment)`.
- Data flow: returns `{...environment, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE, PATH: bin + delimiter + PATH}`.
- Non-obvious design decisions: `ELECTRON_RUN_AS_NODE=1` is what turns the Electron binary into a plain Node runtime, so the shipped app carries one executable. The `bin` directory is **prepended** to `PATH` so a bundled `node` shim wins over any system Node — and `DSH_DESKTOP_NODE_EXECUTABLE` records which executable the launcher is for.
- Edge cases / failure handling: when `bin` is undefined the PATH and the executable variable are omitted entirely rather than set to empty strings.
- Surprising: the Host is launched with `bin: undefined` (`host-process.ts:199`) — the *Host* gets the plain Electron-as-Node environment, while package operations get the shim-scoped one.

### apps/desktop/src/owned-directory.ts
- Purpose: Desktop transaction cleanup that unlinks directory links without visiting their targets.
- Key abstractions: `removeOwnedDirectory(path)`.
- Data flow: `lstatSync(path, {throwIfNoEntry: false})` → missing → return; symlink → `unlinkSync` (the **target is preserved**); directory → recurse over `readdirSync(withFileTypes)`, unlinking files and recursing into directories, then `rmdirSync(path)`.
- Non-obvious design decisions: the reason for the hand-rolled recursion is stated in the comment: "Electron's recursive rm follows nested Windows junctions into installed resources" (line 19). A non-directory, non-symlink root is a **throw**, not a silent skip.
- Edge cases / failure handling: a junction inside the tree is `isDirectory()` but is followed by `readdirSync`… the code relies on `entry.isDirectory()` being false for a symlink and unlinking it, so a *directory symlink* is unlinked rather than traversed.
- Surprising: the whole file exists because a generic recursive delete was one recursive delete away from deleting an installed application tree.

### apps/desktop/src/paths.ts
- Purpose: Filesystem ownership for the Electron-managed desktop installation.
- Key abstractions: `DesktopPaths` (`profile`, `lock`), `resolveDesktopPaths(dshHome = resolveDshHome())`.
- Data flow: `<dshHome>/profiles/desktop` and `<dshHome>/profiles/desktop/lock`.
- Non-obvious design decisions: the desktop profile lives **under the shared Harness home**, so the npm-installed `dsh` and the desktop app share one home; the comment says "Resolve every Electron-owned path without changing the shared data roots".
- Edge cases / failure handling: none; the path set is a pure function of the home directory.
- Surprising: the lock path is part of the same `DesktopPaths` object, which means the profile lock is a **named, reserved** file rather than a convention spread across the code.

### apps/desktop/src/platform-ipc.ts
- Purpose: Shared names for the desktop Platform bridge.
- Key abstractions: `PLATFORM_IPC` = `{bootstrap, localeChanged, open, bounds, close}`, `PlatformLocale` = `'en_US' | 'zh_CN'`.
- Data flow: the Platform preload sends `bootstrap` synchronously (`ipcRenderer.sendSync`) and receives `{origin, token, locale}`; the main process sends `localeChanged` when the desktop language changes.
- Non-obvious design decisions: the Platform locale vocabulary is `en_US`/`zh_CN` (underscore, as the Platform service expects), while the desktop locale vocabulary is `en`/`zh-CN` (hyphen) — `main.ts:443-444` translates between them, and the translation is done in the main process, not in the preload.
- Edge cases / failure handling: none.
- Surprising: `bootstrap` is the only **synchronous** IPC in the shard; everything else is `invoke` or `send`.

### apps/desktop/src/platform-view.ts
- Purpose: Isolated Platform documents (usage / top-up) owned by the desktop account lifetime.
- Key abstractions: `DesktopPlatformView` with a `generation` counter, a `storageCleanup` map of in-flight cleanups, and `PlatformBounds` decoding.
- Data flow: the Host's `platform-session` event → `setSession(next)` → the renderer asks to open a page → a `WebContentsView` is created in an account-scoped partition → `onBeforeSendHeaders` injects the deployment headers and the platform client headers **only** on requests to `account.origin` → the view is loaded and made visible.
- Non-obvious design decisions: the partition name is `persist:dsh-platform-<sha256(origin,userId)>` for a known account and a random, non-persistent partition when the account id is unknown (line 101-102) — "account-scoped persistent storage, or temporary storage when the account ID is unavailable". `setSession` compares the *whole* session (token, origin, embeddedPageDist, requestHeaders, userId) and only keeps an open document when the identity is unchanged; a changed identity **closes** the view first (lines 59-70). Header injection is origin-scoped: a redirected subresource to another origin has the injected header names **stripped** (lines 132-135), tracked by request id so only the request that received them is cleaned up. The storage cleanup is awaited before an installer takes over (`closeAndWait`), and a failure is aggregated so the install can refuse. `ERR_ABORTED` from `loadURL` is tolerated, because a Platform document may replace its own URL before the first load settles (lines 172-181).
- Edge cases / failure handling: `preload-error` and `render-process-gone` both close the view. The `will-navigate` / `will-redirect` handlers only allow the account origin with no embedded credentials. External payment and documentation pages open in the OS browser, never in the embedded session.
- Surprising: `open()` calls `cleanStorage` *before* the view loads — "Sanitize persisted authentication even after an unclean previous process exit" (line 104) — so a killed process cannot leave a stale session in the persistent partition.

### apps/desktop/src/policy-test-auth.ts
- Purpose: Isolated, process-lifetime Feishu cookies for explicitly configured test policy requests.
- Key abstractions: `DesktopPolicyTestAuth` with a nonpersistent `session.fromPartition('dsh-policy-auth-<uuid>', {cache: false})`, and a `request` function that is itself the policy's `fetch`.
- Data flow: `login()` → a `BrowserWindow` loads a local placeholder → then the remote origin → `did-navigate` to the origin root or `/feishu_auth_callback` resolves `returned`; a disallowed navigation, a failed main-frame load, or a renderer crash resolves `failed`; closing the window resolves `cancelled`.
- Non-obvious design decisions: the `request` property is the **authenticated transport** — it refuses any URL that is not `{origin}/api/v0/check_client_update` and always uses `credentials: 'include', redirect: 'error', cache: 'no-store'`, so the login session can be used for exactly one endpoint and never follows a redirect (lines 55-62). The window shows a **local placeholder document first** and only then the remote page: "The remote page can take seconds to paint… the window shows local feedback immediately and the first committed remote document replaces it" (lines 122-128). The request filter cancels any *document* request outside the allowed origins, and cancelling it also resolves the login as failed. `isLoadingDocument` recognizes the placeholder by `file:` protocol + filename, and is accepted **only** by the request filter and the load-failure handler — "navigation events still require `allowed`, so the remote page cannot steer the window back to a local file" (lines 149-152).
- Edge cases / failure handling: `window.on('page-title-updated')` prevents the remote page from rewriting the title; `will-attach-webview` and the `login` event are both prevented; F12 is intercepted to open detached devtools; `dispose()` clears storage and the auth cache after the pending login settles.
- Surprising: the same class both *presents* the login window and *performs* the authenticated request, so the cookies never leave Chromium.

### apps/desktop/src/preload-app.ts
- Purpose: The product preload — origin-scoped boot, native directory selection, host paths of picked files, and update presentation.
- Key abstractions: `createProductApi()` returning `DshDesktopProductApi`, and several narrow `contextBridge.exposeInMainWorld` surfaces (`dshOnboarding`, `__DSH_DIRECTORY_PICKER__`, `__DSH_HOST_PATHS__`, `dshDesktopBoot`, `dshPlatform`, `__DSH_LOCALE__`, `dshDesktop`).
- Data flow: the renderer's `dshDesktopBoot.ready()` → `DESKTOP_IPC.boot` → the main process returns `{injections, streamBaseUrl}`; `dshDesktop.updates.subscribe(...)` → `DESKTOP_IPC.updatesPresentation`.
- Non-obvious design decisions: every exposed surface is **gated on the document's own origin and frame**: `if (location.protocol === 'dsh-app:' && location.hostname === 'app')` for the app-only surfaces, and the full product API is exposed only when the origin matches *and* `process.isMainFrame` (line 100) — a subframe gets `{protocolVersion: 1}` and nothing else. The `keyboard.subscribe` handler re-verifies the target frame in the renderer as well (the `iframe[data-sidebar-browser-frame], iframe[data-html-preview]` match, lines 22-32), so a key forwarded for one frame is not applied to another. `__DSH_HOST_PATHS__.pathFor(file)` uses `webUtils.getPathForFile` so a dropped file becomes an `@path` reference instead of an upload; "a File without one (pasted bytes) answers `''` and uploads as before" (`main.ts` comment). `dshOnboarding.setActive` resizes the window's minimum to 960 px while onboarding is on screen.
- Edge cases / failure handling: `DESKTOP_IPC.bootFailed` is the renderer's way to report a boot failure back to the shell, which turns it into a fatal report.
- Surprising: the `enterWorkspace` handler briefly sets `body.tabIndex = -1` and focuses the body — a focus move so the workspace's first input is not pre-filled with the previous window's selection.

### apps/desktop/src/preload-browser.ts
- Purpose: Lease-scoped browser operations and one main-process event subscription per window.
- Key abstractions: `createDesktopBrowserBridge()` — a `Map<lease, Set<listener>>` of open-request callbacks.
- Data flow: `acquire(workspace)` → `DESKTOP_IPC.browserAcquire` → `{lease, partition}`; the main process pushes `DESKTOP_IPC.browserOpenRequested` → the preload routes it to the listeners registered for that lease.
- Non-obvious design decisions: the bridge exposes neither IPC nor Electron objects to the page — only `acquire`, `release`, `onOpenRequested`. The payload is validated (`lease` and `url` must be strings) before it is dispatched, and each callback is invoked inside a `try/catch` so one failing listener does not stop the others.
- Edge cases / failure handling: an unknown lease simply drops the event; the listener set is deleted when its last listener unsubscribes.
- Surprising: the subscription is **per window** (one `ipcRenderer.on` for all leases) rather than one subscription per lease.

### apps/desktop/src/preload-mandatory-overlay.ts
- Purpose: Mounts the shell-owned Windows update document inside the main window's content area.
- Key abstractions: `installMandatoryUpdateOverlay()` with a `host` div, a **closed** shadow root, an `iframe`, and a `MessagePort` channel.
- Data flow: `MANDATORY_IPC.state` → `receive` → `render` → if blocking, create the host + iframe → on iframe `load`, open a `MessageChannel` and `postMessage` the port to `dsh-app://shell` → the shell document posts actions back over the port → the overlay forwards them via `ipcRenderer.invoke(MANDATORY_IPC.action, ...)`.
- Non-obvious design decisions: the shadow root is `mode: 'closed'` and the host is positioned with `z-index: 2147483647` at `top: WINDOWS_TITLEBAR_HEIGHT` — the overlay covers the content area but **not** the native caption. The action channel is a `MessageChannel` rather than the shared `ipcRenderer`, and the comment says why: "Keep update actions on a private channel to the shell frame; the shared product DOM is not a tamper-proof display" (line 7). Every action carries an `id` and the result is posted back with `ok: true|false`, so the shell document can correlate a click with its outcome. A capture-phase `keydown` listener **blocks all background keys** while the block is active — except keys whose composed path includes an element with `data-windows-menu`, so the native caption menu still works (lines 62-68).
- Edge cases / failure handling: the overlay is removed 150 ms after the policy clears (a fade), and `pagehide` removes the host, closes the port, detaches the IPC listener and removes the key listener.
- Surprising: the initial state is fetched with `ipcRenderer.invoke(MANDATORY_IPC.status)` and a rejection is swallowed — "Development may omit policy configuration; a later main-frame load still resynchronizes configured policy" (line 73).

### apps/desktop/src/preload-mandatory.ts
- Purpose: The isolated bridge for the shell-owned mandatory-update modal only.
- Key abstractions: the `MandatoryUpdateApi` object (`status`, `action`, `subscribe`).
- Data flow: `ipcRenderer.invoke(MANDATORY_IPC.status | .action)`; the main process pushes `MANDATORY_IPC.state`.
- Non-obvious design decisions: the bridge is exposed **only** when `location.href === 'dsh-app://shell/mandatory-update.html'` — an exact match, not a prefix or an origin check, so no other document can obtain the API.
- Edge cases / failure handling: none; the main process independently re-checks the sender frame and URL (`mandatory-update-window.ts::assertSender`).
- Surprising: the same file is a full-page bridge and yet uses `contextBridge` — the point is that the API surface is small and the document is fixed.

### apps/desktop/src/preload-menu.ts
- Purpose: Windows caption menu labels and native popup anchors, isolated from the Web client.
- Key abstractions: `installWindowsMenu()` returning `{update, dispose}`; a shadow-DOM host with `data-windows-menu`.
- Data flow: a click on a menu button → `ipcRenderer.invoke(DESKTOP_IPC.windowsMenu, name, rect.left, rect.bottom)` → the main process pops a native `Menu` at that anchor.
- Non-obvious design decisions: the host is a **shadow root** (`mode: 'open'`) so the Web app's CSS cannot restyle the caption menu, and it is `-webkit-app-region: no-drag` so the caption remains draggable. Before opening the menu the code **restores the editor's focus and selection**: a `focusout` capture listener records the focused input/textarea/contenteditable's selection (including `selectionStart`/`selectionEnd`/`selectionDirection` and cloned `Range`s), and `restoreEditor()` puts it back — so opening a native menu does not steal the caret. `pointerdown` and `mousedown` are both `preventDefault`ed to keep the editor focused.
- Edge cases / failure handling: the mount is gated on `[data-shell-overlay]` being present, because "AppFrame owns this seat; boot readiness alone precedes the rendered application" (line 90) — a `MutationObserver` waits for it. The menu implements roving-tabindex arrow navigation and `ArrowDown` opens it. `dispose()` disconnects the observer, removes the listener and removes the host.
- Surprising: `:host-context(html[data-input-modality='pointer'])` removes the focus ring when the user last used a pointer — a keyboard/pointer modality distinction in the caption menu.

### apps/desktop/src/preload-platform-account.ts
- Purpose: Platform initialization copies credentials once; token getters never perform IPC.
- Key abstractions: the `dsh` bridge object with `getLocale`, `onLocaleChange`, `getAuthToken`.
- Data flow: the origin is read from the `--dsh-platform-origin=` argument → `ipcRenderer.sendSync(PLATFORM_IPC.bootstrap)` → `{token, origin, locale}` → stored in closure variables → `getAuthToken()` returns the stored value.
- Non-obvious design decisions: the bootstrap is **synchronous** and the token is cached, so the page can call `getAuthToken()` synchronously in its own initialization without an IPC round trip. The bridge is exposed only when `process.isMainFrame && location.origin === allowedOrigin` — the page's own origin must equal the origin the main process named. A failed bootstrap leaves the bridge in "embedded mode" so Platform cannot fall back to browser credentials ("Initialization failure retains embedded mode so Platform cannot use browser credentials", line 27).
- Edge cases / failure handling: `getAuthToken()` and `getLocale()` **throw** if initialization failed rather than returning `undefined` — a missing token is a loud error.
- Surprising: the main process re-checks the sender frame and the origin before answering `bootstrap` (`platform-view.ts:193-201`), so a page that somehow obtained the bridge still cannot read another account's token.

### apps/desktop/src/preload-platform.ts
- Purpose: Mark the document root with the host platform and mirror the fullscreen state.
- Key abstractions: `markDocumentPlatform()` (sets `html[data-platform]`), `syncWindowFullscreen()` (sets/removes `html[data-fullscreen]`).
- Data flow: the preload runs **before** the document root exists, so both functions handle a null `documentElement` — `markDocumentPlatform` waits for `DOMContentLoaded`, and `syncWindowFullscreen` simply drops the update if the root is null.
- Non-obvious design decisions: the fullscreen listener is installed only on darwin/win32, because "The main process sends this IPC only on macOS and Windows" (line 25). The main process re-sends the fullscreen state on `did-finish-load`, so a reload inside a fullscreen window does not fall back to windowed CSS (`main.ts:254`).
- Edge cases / failure handling: the comment explains the null check is a type-system artifact — "lib.dom types documentElement non-null, but a preload runs before the document root exists" (line 12).
- Surprising: `data-platform` is how the *shared* Web UI scopes desktop-only CSS without a build-time flag.

### apps/desktop/src/preload-theme.ts
- Purpose: Mirror the Web UI's theme source into Electron's native theme so native chrome and Platform login pages follow the app palette.
- Key abstractions: `syncNativeTheme()` watching `html[data-ds-theme-source]`.
- Data flow: a `MutationObserver` on the attribute → `ipcRenderer.send(DESKTOP_IPC.nativeThemeSet, value)` → the main process sets `nativeTheme.themeSource` → `nativeTheme.shouldUseDarkColors` changes → the Windows title-bar overlay color and the macOS vibrancy follow.
- Non-obvious design decisions: the preload is the **only** bridge, and it forwards only `light | dark | system` (the main process validates the value). The last sent value is remembered (`sent`) so an unchanged attribute does not produce IPC traffic. `system` is passed through unchanged, so the OS appearance still wins in that mode.
- Edge cases / failure handling: the observer is installed on `DOMContentLoaded` because "the theme bootstrap script writes the attribute before DOMContentLoaded" (line 30) — installing earlier would miss the initial value, so `send()` is also called once at observe time.
- Surprising: the same value is read back by the main process as `shouldUseDarkColors` when a Platform login link needs the resolved palette — a round trip from the renderer's own theme state.

### apps/desktop/src/preload-update-dialog.ts
- Purpose: An isolated, response-only bridge for shell-owned update dialogs.
- Key abstractions: the `UpdateDialogApi` (`status`, `respond`, `subscribe`).
- Data flow: `ipcRenderer.invoke(UPDATE_DIALOG_IPC.status | .respond, revision, index)`; the main process pushes `UPDATE_DIALOG_IPC.changed` (or `null` to dismiss).
- Non-obvious design decisions: the bridge is exposed only when `location.href === 'dsh-app://shell/update-dialog.html'` (exact URL). The document may only `respond` with a **revision and a displayed index**; it cannot name a version or a URL.
- Edge cases / failure handling: `subscribe` returns a disposer that removes the listener with `removeListener` (not `off`, so the exact function identity is required).
- Surprising: the same file pattern (`contextBridge` + exact-URL gate) appears in three preloads — welcome, mandatory, update dialog — each isolating a different shell-owned document.

### apps/desktop/src/preload-welcome.ts
- Purpose: Localized welcome copy and write-only credential actions.
- Key abstractions: the `WelcomeApi` object built from `resolveDesktopLocale(locale)` plus the operations.
- Data flow: the locale is read from the `--dsh-welcome-locale=` argument → `resolveDesktopLocale(locale)` → the copy is injected into the page; actions are `ipcRenderer.invoke` on the `WELCOME_IPC` channels.
- Non-obvious design decisions: a missing locale argument **throws at preload time** ("desktop welcome: missing window locale", line 10) rather than defaulting — the window is created by the shell, so the argument is always present, and its absence means the window was created by the wrong path. `analytics` is gated on a second IPC (`analyticsEnabled`) so the collection policy is checked *at the moment of the event*, not at preload time.
- Edge cases / failure handling: the API exposes no account credentials at all — only safe `AccountView` snapshots.
- Surprising: the localized copy is delivered *through the preload* rather than fetched by the page, so the window can paint its text before any network round trip.

### apps/desktop/src/preload-windows.ts
- Purpose: Synchronize Windows context menus and caption colors with the application document.
- Key abstractions: `syncWindowsAppearance()` — marks `html[data-windows-titlebar]`, sets the `--dsh-windows-titlebar-height` CSS variable, installs the caption menu, and measures the palette.
- Data flow: a hidden probe `<span>` styled with `var(--dsw-specific-sidebar-fill)` is painted into a 1×1 canvas → `getImageData` → the computed `rgba(...)` is sent to the main process as the native title-bar color; a `MutationObserver` on `html[lang]`, `body[data-ds-dark-theme|style]` and `head` re-measures on change.
- Non-obvious design decisions: the palette is **measured from the renderer's own CSS**, not hardcoded, so a custom theme produces matching native chrome; the main process validates the color strings against a strict regex before passing them to `setTitleBarOverlay` (`main.ts:1057-1059`). The conversion from `rgb()` to `rgba()` via a canvas exists because Electron's `setTitleBarOverlay` wants an alpha-aware color and `getComputedStyle` returns `rgb(...)`; the canvas read yields the alpha channel too. The previous measurement is cached as a JSON string and the send is skipped when unchanged.
- Edge cases / failure handling: a null 2D context throws ("Desktop caption requires a 2D canvas context"); `pagehide` disconnects the observers, disposes the menu and removes the probe.
- Surprising: the observer watches `document.head` with `childList + subtree + characterData` — stylesheets injected later change the measured palette, so the caption must be re-measured when the head changes.

### apps/desktop/src/project-manager.ts
- Purpose: Desktop profile initialization and native recovery.
- Key abstractions: `DesktopProjectManager` (`applyRelease`, `disableAllPlugins`, `withLock`), plus the metadata writers `createRuntimeProjectMetadata`, `createDevelopmentProjectMetadata`, `createPluginProfile`.
- Data flow: `applyRelease()` → `withLock` → `readDesktopRuntime(runtime.dsh)` (validation only) → `migrateProfileSettings` → `createPluginProfile` → `removeLinkProjections`.
- Non-obvious design decisions: the profile is protected by a **pid lock file** created with `openSync(lockPath, 'wx', 0o600)`; a stale lock is detected by `process.kill(owner, 0)` and the `ESRCH` code specifically ("another profile operation is active" vs. reclaim) (lines 105-115). The lock file must be a **regular file**: a symlink at the lock path is refused ("profile lock is not a regular file"). The lock is written with the pid and `fsyncSync`'d before the operation runs. `workspaceFile()` writes a pnpm workspace with `nodeLinker: hoisted`, `autoInstallPeers: false` and an explicit `allowBuilds` allowlist (node-pty, koffi, fs-ext true; `@google/genai`, `protobufjs`, `node-addon-require-builtin` false) — build scripts are opt-in per package.
- Edge cases / failure handling: `disableAllPlugins` backs up the profile patch and writes it under the same lock; the caller must stop the Host first. `migrateProfileSettings` rewrites a legacy `pnpm-workspace.yaml` only when it matches the legacy text exactly.
- Surprising: `applyRelease` deliberately does **not** install anything — "Load application metadata and prepare the external plugin profile without installing packages" — the runtime is verified, not fetched.

### apps/desktop/src/quit-confirmation.ts
- Purpose: Native quit confirmation; quitting proceeds silently only when the Host reports nothing to interrupt.
- Key abstractions: `resolveDesktopQuitPrompt(inspection | 'unknown')` → a locale key or `undefined`; `DesktopQuitConfirmation` with a single `pending` promise.
- Data flow: `confirm()` → `options.inspect()` → `host.inspectQuit()` (bounded by `QUIT_INSPECTION_DEADLINE_MS = 2000`) → a prompt key or none → a native message box → `true`/`false`.
- Non-obvious design decisions: an **unknown** inspection result (timeout or error) produces the *active tasks* warning rather than a silent quit ("an unknown state warns about running tasks rather than quitting silently", line 13) — the failure mode is chosen conservatively. The inspection runs **once per decision**: "work that starts or ends while the confirmation is open does not change its copy, and approval never re-inspects" (line 46). Button order is platform-specific: macOS lays buttons out right-to-left from index 0, so "Quit" sits right of "Cancel"; Windows keeps array order, so "Quit" is left of "Cancel" (lines 79-80) — the same array, the opposite reading order.
- Edge cases / failure handling: `dispose()` (used by crash-recovery exit, the installer handoff and the development restart) makes a pending decision resolve `false` without opening a box, and later requests do the same. The comment notes that an already-open native box has no close API and disappears with the process.
- Surprising: on Windows the dialog uses `type: 'none'` with an explicit application icon, because the task dialog draws its main icon at the system icon size and the multi-size ICO yields that size directly (the main-process comment in `main.ts:1012-1013`).

### apps/desktop/src/release.ts
- Purpose: Immutable version identity shared by one Electron shell and its bundled `dsh` runtime.
- Key abstractions: `DesktopRelease` (`schemaVersion, version, hostProtocolVersion, nodeVersion, pnpmVersion`), `parseDesktopRelease(value)`.
- Data flow: the bundled runtime descriptor's `release` object → `parseDesktopRelease` → the shell's own version and the Host's version are compared.
- Non-obvious design decisions: every field is validated with `semver.valid`, and `hostProtocolVersion` must equal the compile-time constant — the shell and the Host cannot disagree about the lifecycle protocol. The `version` field is documented as "Exact version used by both Electron and `@deepseek-ai/dsh`".
- Edge cases / failure handling: any mismatch throws "invalid desktop release metadata".
- Surprising: `nodeVersion` and `pnpmVersion` are part of the release identity, so a runtime carrying a different Node or pnpm is a different release even at the same product version.

### apps/desktop/src/runtime-tree.ts
- Purpose: Relocatable, integrity-recorded production packages carried by one Desktop release.
- Key abstractions: `DesktopRuntimeDescriptor` (`release`, `platform`, `arch`, `sharedPackages`, `files`), `DesktopRuntimeFile` (`path, bytes, sha256, executable`), `runtimePath(root, path)`.
- Data flow: `writeDesktopRuntime(root, release, sharedNames)` → inventory every file under the root (excluding the descriptor) → hash each → write `desktop-runtime.json` → `verifyDesktopRuntime(root, expectedVersion)` re-inventories and compares.
- Non-obvious design decisions: `runtimePath` rejects any path that is absolute, contains a backslash or a colon, or contains an empty/`.`/`..` segment (lines 52-57) — the durable metadata is treated as untrusted input. The inventory **does not follow links**: a non-file, non-directory entry is a hard error ("unsupported filesystem entry"), and the executable bit is recorded as `false` on Windows because "Windows has no portable Unix executable permission bits" (lines 78-79). Verification compares the *deserialized* inventory to a fresh one, and on Windows it strips the `executable` field from both sides before comparing (lines 207-209) rather than forcing it to false. `inventoryRuntimeForVerification` runs up to 8 concurrent readers and uses `Promise.allSettled` so "Failure returns only after every outstanding file read has closed its descriptor" (line 110).
- Edge cases / failure handling: `readDesktopRuntime` requires `@deepseek-ai/dsh` and `@deepseek-ai/dsh-desktop-host` to be present as shared packages at exactly the release version, and each shared package's `package.json` is re-read and compared against the descriptor.
- Surprising: the whole point of the descriptor is that the runtime tree is **relocatable** — the same bytes verify at any path, so an installed update can be checked without knowing where it was unpacked.

### apps/desktop/src/settings.ts
- Purpose: Local Electron shell settings, loaded once per process independently of the Host.
- Key abstractions: `DesktopSettings` (`updates.allowTestAuthPopupWindow`), `readDesktopSettings(userData)`.
- Data flow: `<userData>/desktop/settings.json` → JSON → validated → `{updates: {allowTestAuthPopupWindow}}`.
- Non-obvious design decisions: the default document is created **only when the file is missing**, with `flag: 'wx'` and mode `0600`, and an `EEXIST` on the create is treated as success ("An existing document belongs to the user, including one created during initialization", line 34). Any read, parse or validation failure falls back to the defaults with a warning and **does not block startup** — "changes require a restart" is the documented consequence. The settings live under Electron's `userData`, "independent of DSH_HOME".
- Edge cases / failure handling: the diagnostic `console.warn` is itself wrapped in a `try/catch` with a TODO, so a failure to log cannot make optional settings fatal.
- Surprising: the only setting is a *test* switch — `allowTestAuthPopupWindow` — which gates the Feishu sign-in popup for the mandatory-update policy. It is off by default.

### apps/desktop/src/single-instance.ts
- Purpose: Electron single-instance ownership before any Desktop profile lifecycle begins.
- Key abstractions: `DesktopSingleInstanceApplication` (a three-method interface), `claimDesktopSingleInstance(application, focusOwner)`.
- Data flow: `requestSingleInstanceLock()` → false → `quit()` and return false; true → register `second-instance` → focus the owner.
- Non-obvious design decisions: the lock is claimed at **module scope**, before `app.whenReady()`, so the losing process never touches the profile. The interface is minimal by design (`requestSingleInstanceLock`, `quit`, `on`) so the ownership rule is testable without Electron.
- Edge cases / failure handling: the second instance quits immediately and the first focuses its window.
- Surprising: `main.ts` calls `claimDesktopSingleInstance` at module level (line 1343) and only then enters `app.whenReady().then(main)` — the ordering is the whole point of the file.

### apps/desktop/src/startup-error.ts
- Purpose: Serializable Desktop failure diagnostics.
- Key abstractions: `desktopErrorState(error)` → `{phase: 'error', message}`.
- Data flow: an `Error` or `AggregateError` → a flat message string → sent to a renderer or shown in a dialog.
- Non-obvious design decisions: an `AggregateError` is **flattened** into its sub-messages joined by newlines, so a nested cleanup failure is visible in the UI rather than hidden behind "AggregateError: 2 errors occurred" (lines 9-11).
- Edge cases / failure handling: a non-Error value is stringified.
- Surprising: it is 13 lines and the only place in the shard where an error is flattened for a renderer; the *original* error is preserved alongside it in `DesktopBackendState.failure` ("`message` is the rendered text; `failure` is the original error so a crash report keeps its stack, properties, and cause", `backend-controller.ts:9`).

### apps/desktop/src/tray.ts
- Purpose: The Windows system tray — the always-present way back to a hidden window and the explicit quit entry.
- Key abstractions: `DesktopTray` with `relabel()`, `dispose()`.
- Data flow: `new Tray(nativeImage.createFromPath(iconPath))` → a click opens the primary window → a context menu with Open and Quit → `relabel()` rebuilds the tooltip and menu in the current locale.
- Non-obvious design decisions: the tray is created for the **whole run**, not only while the window is hidden ("Tray icon present for the whole run, not only while the window is hidden", line 17) — the comment in `main.ts` explains why: "The tray is the way back to a hidden window; without it, relaunching the application still focuses it." The icon is a multi-size ICO rendered by `scripts/render-tray-icon.ts` so Windows can pick the bitmap for the display scale.
- Edge cases / failure handling: `main.ts` wraps tray construction in a `try/catch` and logs a warning if the tray is unavailable, so a missing tray never stops the app. `dispose()` is called only once the quit is confirmed, "so no dead icon outlives the process".
- Surprising: the tray's Quit goes through the *same* `app.quit()` path as the menu, and therefore through the same quit confirmation — the comment says "Request quit through the same confirmation as every other quit entry."

### apps/desktop/src/update-attention.ts
- Purpose: Best-effort background attention that never grants update or task-stop authorization.
- Key abstractions: `DesktopUpdateAttention` with `ready(version, parent, modal, returnToConfirmation)`, `clear()`, `reset()`.
- Data flow: `ready()` → if neither window is focused → `parent.flashFrame(true)` (Windows) or `app.dock.bounce('informational')` (macOS) → a silent `Notification` → clicking it calls `returnToConfirmation()`, which re-checks the policy and returns to the UI **without installing**.
- Non-obvious design decisions: one reminder per downloaded version — `if (this.version === version) return` (line 24) — and `reset()` is called at the start of a new download episode. The attention is *cleared* the moment either window takes focus, so the reminder does not keep bouncing after the user comes back. The `stop` closure removes the focus listeners and cancels the dock bounce.
- Edge cases / failure handling: every native call is wrapped in a `try/catch` with a warning ("attention unavailable"); `Notification.isSupported()` is checked; a failed notification removes its listeners.
- Surprising: the notification is `silent: true` — the attention is visual (taskbar flash / dock bounce) plus a system notification, and it never carries an action button that could install.

### apps/desktop/src/update-channel.ts
- Purpose: Resolve the update channel sealed into the installed application manifest.
- Key abstractions: `DesktopUpdateChannel` = `'nightly' | 'latest'`, `desktopUpdateChannel(manifest)`.
- Data flow: the packaged `package.json` → `manifest.dshDesktopUpdateChannel` → the channel passed to the updater and to the policy identity.
- Non-obvious design decisions: an **absent** key means `nightly` ("older manifests retain their existing nightly behavior"), but an **invalid** explicit value throws rather than falling back ("Invalid explicit values reject instead of changing feeds", line 9) — a typo must not silently switch the feed.
- Edge cases / failure handling: a non-object manifest throws.
- Surprising: the channel is a property of the *installer*, not of the release version or the upload environment.

### apps/desktop/src/update-coordinator.ts
- Purpose: User-authorized downloads and separate installation of one version-bound Desktop release.
- Key abstractions: `DesktopUpdateCoordinator` with `check`, `download`, `install`; the injected `updater` (default `autoUpdater`), `enabled`, `currentVersion`, `downloadResult`, `channel`.
- Data flow: `check()` → `updater.checkForUpdates()` → a candidate version is accepted only if `gt(version, currentVersion())` → `download(version)` → `updater.downloadUpdate()` → `install(version)` → `beforeRestart()` (task lock + host shutdown) → `updater.quitAndInstall(true, true)`.
- Non-obvious design decisions: `autoDownload = false` and `autoInstallOnAppQuit = false` — nothing is downloaded or installed without an explicit user action. `allowDowngrade = false` and `allowPrerelease = (channel === 'nightly')` are set explicitly, because "Selecting a channel can enable downgrade in electron-updater" (line 73). The `latest` channel refuses a feed version containing a prerelease marker (line 192). The transport is replaced with a custom `DesktopUpdateHttpExecutor` through an **undeclared** internal property (`httpExecutor`), with a comment saying so. `download()` requires the version to equal the checked candidate ("download confirmation is stale", line 110) and `install()` requires the exact downloaded version ("confirmed target is not ready", line 133) — a renderer cannot install anything it did not see confirmed.
- Edge cases / failure handling: a failed *download* resets `downloaded = false` so a retry is possible; a silent automatic check failure stays invisible (`if (manual && result.phase === 'error') this.setState(result)`), while a manual check publishes the error. `dispose()` awaits all pending operations before removing the `error` listener, because "Pending updater promises can still emit EventEmitter errors during shutdown" (line 154).
- Surprising: `onDownloaded` only accepts an event whose version equals the candidate; a download of a different version is ignored rather than adopted.

### apps/desktop/src/update-dialog.ts
- Purpose: Main-owned update confirmations; closing or replacing a dialog never grants installation permission.
- Key abstractions: `UpdateDialogView` (revision, locale, title, message, detail, buttons, cancelId, closeLabel, technicalDetails), `UpdateDialogOptions`, `DesktopUpdateDialog`.
- Key abstraction detail: `show(parent, options)` returns a `Promise<MessageBoxReturnValue>`; `respond(revision, index)` is the only action the document can take.
- Data flow: the main process calls `show()` → an overlay window is created (or reused) and the view is pushed over `UPDATE_DIALOG_IPC.changed` → the document calls `respond(revision, index)` → the main process validates the revision and the index → the promise resolves.
- Non-obvious design decisions: every prompt carries a **revision**, and a response with a stale revision is rejected ("stale dialog response", line 65) — a user who clicks a button on a replaced dialog does not answer the new one. The response index must be either the `cancelId` or a valid button index, and it must be an integer. A prompt can be **replaced** in place (`this.active?.finish(this.active.view.cancelId, true)` retains the window and swaps the content), and the window is destroyed 150 ms after the last prompt so the backdrop can fade. An `AbortSignal` on the options lets the mandatory policy cancel every ordinary prompt at once (the main process keeps a set of `AbortController`s for this).
- Edge cases / failure handling: `show()` on a disposed dialog, an aborted signal, or a destroyed parent resolves with the cancel index instead of throwing. A load failure or a renderer crash cancels the prompt. `owned(event)` requires the sender to be the dialog window's main frame **with the exact page URL**.
- Surprising: `technicalDetails` is a separate field, displayed only when expanded — "Main-owned diagnostics without subprocess output or credentials; hidden until expanded" (`ipc.ts:43`).

### apps/desktop/src/update-error.ts
- Purpose: Localized update preparation failures with separately displayed diagnostics.
- Key abstractions: `DesktopUpdatePreparationError` with a `kind` (`stop-failed | tasks-changed | tasks-unavailable`), a locale-owned `message`, and an optional `technicalDetails`.
- Data flow: thrown by the install preparation → caught by the coordinator → `failure()` puts `preparationFailure` and `technicalDetails` on the state → `presentDesktopUpdate` maps the kind to a `DesktopUpdateFailureKind` → the UI shows the localized summary and keeps the details collapsed.
- Non-obvious design decisions: the error's `kind` is the **stable contract** shared by the native and Web presentations, while `message` is locale copy and `technicalDetails` is main-owned facts — "excluding raw subprocess output and credentials" (line 9).
- Edge cases / failure handling: `technicalDetails` is optional; the kind is what the classification logic keys on.
- Surprising: 12 lines that separate three concerns (stable kind, user-facing copy, diagnostics) that are usually collapsed into one string.

### apps/desktop/src/update-http-executor.ts
- Purpose: Electron-native inactivity deadlines for updater checks, full downloads and blockmap requests.
- Key abstractions: `DesktopUpdateHttpExecutor extends ElectronHttpExecutor`, overriding `addErrorAndTimeoutHandlers`.
- Data flow: the updater issues a request → the override installs an idle timer → the timer is **refreshed on every response chunk** → on expiry the request is aborted and the promise rejects with `code: 'ETIMEDOUT'`.
- Non-obvious design decisions: the deadline is an **inactivity** deadline, not a total download deadline ("Maximum silence before headers or between response chunks, not a total download deadline", line 8) — a large but progressing download is never killed. The upstream Node socket timer is not usable because "Electron ClientRequest has response/close events instead" (line 19), so the override re-implements the refresh loop on `response`/`data`. It also handles the Electron 44 quirk where "writable close" is emitted after finish but before the response headers arrive (line 48) — the `abort` and `error` listeners stop the timer so a late abort cannot reject an already-settled request.
- Edge cases / failure handling: the timeout is validated to 1000–2147483647 ms in the constructor. `stop()` removes every listener it added, so no listener leaks on the request.
- Surprising: the default idle timeout is 60 s, read from `DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` (`update-coordinator.ts:65`) — a silent connection is the failure mode this exists for.

### apps/desktop/src/update-journal.ts
- Purpose: Opt-in qualification evidence outside the installation directory; no raw diagnostics or request data.
- Key abstractions: `DesktopUpdateJournalAction` (a closed vocabulary of 11 milestones), `desktopUpdateJournalState(state)` (the whitelist), `DesktopUpdateJournal` (JSONL appender).
- Data flow: `action(milestone)` / `state(updateState)` → one JSON line each → `<dir>/<timestamp>-<uuid>.jsonl`, written with `flag: 'wx'`, mode `0600` and `flush: true`.
- Non-obvious design decisions: the journal is a **whitelist**: only phase, target version, integer percent, failed operation and a fixed error *classification* survive — "neither error text nor unexpected object fields survive" (line 15). The error code is chosen from a closed list of eight known codes and otherwise becomes `UNCLASSIFIED` (line 27). Duplicate states are dropped by comparing the encoded JSON with the previous one. The journal directory must be **absolute** and is created with `mkdirSync`; "creation errors stop qualification".
- Edge cases / failure handling: `action()` failures **propagate** so "incomplete qualification is never reported as traced" (line 51) — the journal is evidence, and a broken journal must fail loudly rather than produce a gap.
- Surprising: the journal is enabled only when `DSH_DESKTOP_UPDATE_JOURNAL_DIR` is set (`main.ts:320-321`), and it lives *outside* the installation directory so it survives an uninstall.

### apps/desktop/src/update-overlay.ts
- Purpose: Shell-owned modal windows that cover the parent's content without replacing its native window controls.
- Key abstractions: `DesktopUpdateOverlays` with a `WeakMap<BrowserWindow, {revision, active, blocked}>` of input states.
- Data flow: `create(parent, preload, title, nativeModal)` → a transparent, frameless child window that mirrors the parent's content bounds → `input(parent)` reports `{revision, blocked}` → the keyboard layer consults it and refuses to dispatch while an overlay is up.
- Non-obvious design decisions: the overlay is a **child window**, not a DOM overlay, so it survives a renderer reload of the product page. It follows the parent's `move`/`resize` and re-shows when the parent shows. The input state is a **counter** (`active`) with a `blocked` getter, so nested overlays behave correctly, and the `revision` changes on every open/close so the keyboard layer can detect the change and reset its chord state. On macOS a non-native overlay **prepends** a `before-input-event` listener on the parent ("Shell dialogs block input before product shortcut listeners can dispatch it", line 41) — prepending is the whole trick, since ordinary listeners run first.
- Edge cases / failure handling: `skipTaskbar`, `resizable: false`, `minimizable: false`, `maximizable: false`, `hasShadow: false`; the window is destroyed on close and every listener is removed.
- Surprising: `nativeModal` defaults to true but the update dialogs pass `false` so they stay out of macOS sheets ("false keeps overlays out of macOS sheets", line 22) — a modal sheet would animate the whole viewport.

### apps/desktop/src/update-presentation.ts
- Purpose: Semantic content for the Web-localized optional Desktop status indicator.
- Key abstractions: `desktopUpdateFailureKind(state)`, `desktopUpdateErrorSummary(state, messages)`, `presentDesktopUpdate(state)`.
- Data flow: a `DesktopUpdateState` → a `DesktopUpdateFailureKind` (one of nine) → a localized summary string; `presentDesktopUpdate` produces the renderer's `DesktopUpdatePresentation` (phase, version, integer percent, failure kind).
- Non-obvious design decisions: the classification is **regex over the message** for the network family (`ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT`), producing a `-network` variant of the operation so the user gets "check your connection" wording. A preparation failure short-circuits to its own kind. The presentation carries **no** raw diagnostics and no installation controls.
- Edge cases / failure handling: an unknown message falls back to the plain operation kind.
- Surprising: the same `desktopUpdateErrorSummary` is used by the native dialog and by the Web status indicator, so the two surfaces cannot disagree about what went wrong.

### apps/desktop/src/update-schedule.ts
- Purpose: Ordinary feed polling; policy queries and user-authorized transfers keep their own lifetimes.
- Key abstractions: `DesktopUpdateScheduleConfig` (interval, maxBackoff, jitter), `DesktopUpdateSchedule` with a completion-based deadline.
- Data flow: `check(manual, force)` → the coordinator's `check` → `complete(failed)` → `schedule(failed)` → a jittered timer → `check(false, true)`.
- Non-obvious design decisions: the deadline is **completion-based**, not a fixed period: the next check is scheduled when the previous one *finishes* ("One completion-based deadline shared by periodic, foreground, resume, and explicit checks", line 29), so a slow check cannot stack up behind itself. A failed check doubles the delay up to `maxBackoffMs`; a success resets it to `intervalMs`. The jitter is applied as a symmetric band `[delay*(1-jitter), delay*(1+jitter)]` with a uniform sample, and the lower bound is clamped to 1000 ms. The clock is **monotonic** (`performance.now()`, line 48) — "independent of wall-clock corrections".
- Edge cases / failure handling: `activeChecks` counts concurrent callers so the delay advances once per *completed* round even when several manual callers joined ("Joined manual callers publish through the coordinator but advance the retry delay only once", line 87). `dispose()` prevents a late completion from rearming the timer.
- Surprising: `check(manual, force)` has two separate flags — `manual` controls *visibility of a failure* and `force` controls *bypassing the deadline*; a policy arrival forces the check without making its failure user-visible.

### apps/desktop/src/web-document.ts
- Purpose: Serve the local Web document and forward authenticated HTTP to the application window.
- Key abstractions: `serveWebDocument(request, root)`, `authenticateWebHost(url)`, `forwardWebRequest(request, host, cookie)`, the MIME table, the withheld-response-header list.
- Data flow: `protocol.handle('dsh-app')` → `dsh-app://shell/*` is served from the bundle, `dsh-app://app/*` is either served from the packaged Web dist (`/`, `/index.html`, `/assets/*`, favicon, manifest) or **forwarded** to the Host with the Host's cookie.
- Non-obvious design decisions: the index document is rewritten on the fly to inject `<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>` (line 10) — a boot gate the Web app can await, because the shell has to supply asynchronous Host injections. The path is resolved and checked to be under the root (`target.startsWith(directory + sep)`) before the file is read — a traversal attempt gets a 403. `authenticateWebHost` performs the launch-URL exchange and requires a **303** with a `set-cookie` ("Desktop Host authentication failed" otherwise), and takes only the cookie value before the first `;`. `forwardWebRequest` strips `host`, `origin`, `cookie` and `sec-fetch-site` from the request and sets the Host's cookie, uses `duplex: 'half'` to stream the body, and forwards the response body as a stream. The response's `set-cookie` is **withheld** so the Host's auth cookie never reaches the page's cookie jar, and the hop-by-hop headers are withheld because "Chromium never sees" the Node `fetch` connection.
- Edge cases / failure handling: a non-GET/HEAD method is 405; an undecodable path is 400; a missing file is 404; a request whose `Origin` is present and not `dsh-app://app` is 403.
- Surprising: plugin bundle responses have their `cache-control` rewritten to `no-store` (lines 65, 91) because the Host marks them immutable under a revision that changes every launch — Chromium's disk cache would otherwise accumulate bundles no later launch can reuse. This is a deliberate *cache-defeat* for a versioning scheme that is not content-addressed.

### apps/desktop/src/welcome-api.ts
- Purpose: The operations available to the isolated native welcome renderer.
- Key abstractions: `WELCOME_IPC` (nine private channels), `WelcomeApi` (locale + operations + `onAccountState`), `WelcomeAuthentication` (`loggedIn`, `hasApiKey`), `needsWelcome(auth)`.
- Data flow: the renderer's calls map one-to-one onto the `WELCOME_IPC` channels; the main process pushes `WELCOME_IPC.state`.
- Non-obvious design decisions: `needsWelcome` is true only when **neither** authentication route is configured — "true only when neither authentication route is configured" (line 71) — so an account login and an API key are two independent ways past the welcome, and the shell asks again if the user signs out and has no key. `WelcomeSaveResult` is `{ok: true} | {ok: false}` — "Credential writes return a safe outcome without exposing Host diagnostics."
- Edge cases / failure handling: the analytics event names are a closed union (`auth_page_view | auth_page_click | api_key_save_click`).
- Surprising: `WelcomeNotice = 'session-expired'` is a **one-time** notification "retained by the main process until Welcome receives it" — it survives the sign-out that caused it.

### apps/desktop/src/welcome-backend.ts
- Purpose: Native welcome operations using the shared Web authentication and RPC APIs.
- Key abstractions: `DesktopWelcomeBackend` (`read`, `readLocalePreference`, `save`, `analyticsEnabled`, `report`, `account`), and an `invoke(namespace, method, args)` RPC helper.
- Data flow: `connectDesktopWelcome(authenticatedUrl, send, cookies)` → an authenticated `GET` of the launch URL → `invoke()` posts `{type: 'client-request', rpcId, method, payload: {args}}` to `/api/<namespace>/<method>` → the response envelope must be `{type: 'server-response', rpcId: <the same id>, result: {ok: true, value}}`.
- Non-obvious design decisions: the `rpcId` is a fresh UUID per request and the response's `rpcId` must match — a mismatched or malformed envelope is an error, so a stale response cannot be applied to the wrong call. The credential read is done in **batches of 64** because "credentials.describe accepts at most 64 references per request" (line 109). `read()` discovers which credential references exist by walking the provider directory (`llm.listConfigurableProviders`) and the settings namespaces, and the official DeepSeek reference comes from the `llm-deepseek` namespace's `apiKeyEnv`. The analytics calls are bounded by `AbortSignal.timeout(1000)` so a hung analytics intake cannot delay the welcome window.
- Edge cases / failure handling: `save()` re-validates the key with `/^[\x21-\x7e]+$/`, and any failure is swallowed into `{ok: false}` — "Provider diagnostics may contain credentials; the native form owns failure copy" (line 145). `readLocalePreference()` reads only the settings namespace, "without account or provider requests".
- Surprising: the welcome window's *entire* understanding of the product's credential state is derived from the provider registry and the settings namespaces — it never reads a credential value, only a `configured` boolean.

### apps/desktop/src/welcome-window.ts
- Purpose: The native welcome window and its presentation-only renderer.
- Key abstractions: `welcomeWindowOptions(platform, locale)`, `openWelcomeWindow(locale, operations)`.
- Data flow: `openWelcomeWindow` → a `BrowserWindow` with a locale-only preload → the `WELCOME_IPC` handlers are installed → `loadFile(renderer/welcome.html)` → the window is shown and an `auth_page_view` is reported.
- Non-obvious design decisions: the IPC handlers are **removed and re-installed** on every window ("Replaces IPC ownership immediately"), and a module-level `disposeActiveHandlers` ensures the previous window's handlers are gone before the new ones exist — so two welcome windows can never both answer. `assertSender` requires the exact window's `webContents` **and** main frame. The window is fixed-size, non-resizable, centred, with macOS `vibrancy: 'menu'` and Windows acrylic. The locale is passed as a **preload argument** (`--dsh-welcome-locale=`), not fetched, so the page renders its text immediately.
- Edge cases / failure handling: a failed `loadFile` destroys the window and rethrows. `will-navigate` is always prevented and `setWindowOpenHandler` denies all popups. The analytics handler validates the event name *and* the attribute shape, and only forwards the two approved `button_name` values (line 88-93) — an unknown event or an extra attribute is an error, not a silent drop.
- Surprising: `window.show()` happens only after the document has loaded, so the user never sees an empty acrylic rectangle.

### apps/desktop/src/windows-layout.ts
- Purpose: Shared geometry for the Windows main-window caption.
- Key abstractions: `WINDOWS_TITLEBAR_HEIGHT = 40`.
- Data flow: used by `main.ts` (the `titleBarOverlay` height), `preload-windows.ts` (the CSS variable) and `preload-mandatory-overlay.ts` (the overlay's `top`).
- Non-obvious design decisions: one constant, imported by three layers, so the native caption, the CSS clearance and the overlay's offset cannot drift apart.
- Edge cases / failure handling: none.
- Surprising: 4 lines, one number, three consumers on two sides of the process boundary.

## Ideas worth stealing

- **Validate every message that crosses a process boundary before you act on it, and kill the peer if it is malformed** — `apps/desktop/src/host-process.ts:53-91` (`isDesktopHostEvent`). The Host's `platform-session` event is re-validated down to the request-header allowlist, the lowercase-only rule and the CR/LF ban, and the origin must be HTTPS or HTTP on loopback. *Why it matters for the August harness*: the same discipline applies to a tool result, a stream frame or a subagent message — a malformed frame is a protocol violation, not data, and the cheapest correct response is to refuse it rather than to coerce it.

- **A diagnostic must be written to disk BEFORE the dialog that names it, and the write must be time-bounded** — `apps/desktop/src/fatal-recovery.ts:106-119` (`persist`) with `CRASH_REPORT_WAIT_MS = 1000`, and `apps/desktop/src/crash-report.ts:147-157` (write with `flag: 'wx'`, mode `0600`, failure yields `undefined` and the dialog proceeds). *Why it matters*: an August turn that fails fatally should leave a complete artifact (stack, cause chain, enumerable properties, recent renderer output) that the user can send, and a slow disk must not become an additional failure.

- **Bound the diagnostic tail from the FRONT, not the back, and keep one oversized entry whole** — `apps/desktop/src/crash-report.ts:60-86` (`RendererConsoleTail`) and `apps/desktop/src/fatal-recovery.ts:34-41` (the 1200-character budget, the last 8 lines, the lone-surrogate strip). *Why it matters*: when an August turn's error is rendered into a toast, a status line or a tool receipt, the most recent frames and the *last* log lines are the useful ones; truncating from the end silently drops the cause.

- **Bind a user decision to a fingerprint of the observed state, and refuse the action if the state moved** — `apps/desktop/src/command-installation.ts:116-128` (`readSnapshot` → fingerprint over the `lstat` fields and the receipt) and `:189` (`if (state.fingerprint !== expected) throw new CommandInstallationError('ESTALE', ...)`). The fingerprint uses `dev, ino, mode, uid, gid, size, mtimeNs` plus the symlink target, so a replaced file is detected even with identical content. *Why it matters*: this is exactly the shape an August approval needs — "the tool call you approved was for this exact file state" — and the same pattern generalises to a diff, a plan and a config edit.

- **Preserve, never destroy, on a failed mutation: rename the old entry aside and re-verify it afterwards** — `apps/desktop/src/command-installation.ts:165-177` (`withdraw`) and `:203-218` (the rollback that restores the previous entry, aggregating failures and naming the preserved path). *Why it matters*: when an August tool call fails halfway, the user's file must be exactly as it was, and the error message must say where the old version is — not "operation failed".

- **Do not let a later, unrelated failure replace the first fatal one** — `apps/desktop/src/fatal-recovery.ts:65-67` (`if (this.reported) return`; "later reports cannot replace it or open another dialog") plus `apps/desktop/src/backend-controller.ts:138-142` (the attempt-generation guard `if (this.attempt !== attempt || attempt.cancelled) return`). *Why it matters*: in a long August turn, a cascade of secondary errors must not bury the root cause; the first failure owns the report and the recovery.

- **Give every long-running operation a deadline, and treat a timeout as an UNKNOWN state that fails conservatively, not as success** — `apps/desktop/src/host-process.ts:49` (`QUIT_INSPECTION_DEADLINE_MS = 2000`) with `apps/desktop/src/quit-confirmation.ts:15-21` (`'unknown'` → the "tasks are running" warning, not a silent quit); and `apps/desktop/src/update-http-executor.ts:18-52` (an *inactivity* deadline that is refreshed on every chunk, so a large but progressing download is never killed). *Why it matters*: the same rule applies to a provider call, a subprocess and a subagent: a hung call must surface as "unknown, assume the worst", and a long-but-alive call must not be killed by a total-duration timeout.

- **Escalate a child's shutdown: request → wait → SIGTERM → wait → SIGKILL, and treat "not acknowledged" as a different failure from "did not exit"** — `apps/desktop/src/host-process.ts:288-308` (`stop(requireGraceful)`) with the separate `DesktopHostUncleanExitError` ("confirmed exit but refuses installation"). *Why it matters*: an August turn that spawns a subprocess or a subagent needs the same three-stage teardown, and needs to distinguish "it exited but did not finish cleanly" (refuse to continue) from "it is still running" (a different error entirely).

- **Keep the "affordance" and the "authorization" apart: the UI may offer a button, but the main process owns the target and re-validates it at the moment of use** — `apps/desktop/src/mandatory-update-policy.ts:101-107` (`desktopPolicyPage` re-validates the server-supplied page against the deployment allowlist immediately before the browser or clipboard uses it) and `apps/desktop/src/mandatory-update-window.ts:82-86` (a stale confirmation revision is refused). *Why it matters*: in August, a model-produced URL or a renderer-supplied path must be re-validated at the point of use, not only when it was rendered.

- **Strip the ambient environment before spawning a privileged helper** — `apps/desktop/src/command-management.ts:148-149` (drop `KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$` from the child env) and `apps/desktop/src/command-manager-entry.ts:11-12` (`process.umask(0o022)` on macOS because the worker writes *public* metadata, not secrets). *Why it matters*: an August tool that spawns a subprocess inherits the whole parent environment, which may carry provider keys; scrubbing the child env at the spawn door is cheap and total.

- **Make the failure classification a closed vocabulary, and derive the user-facing wording from the classification rather than from the raw error** — `apps/desktop/src/update-presentation.ts:12-38` (`desktopUpdateFailureKind` → nine `DesktopUpdateFailureKind`s → localized summaries) with `apps/desktop/src/update-journal.ts:20-30` (the same idea for evidence: eight known error codes, else `UNCLASSIFIED`, and no raw message on disk). *Why it matters*: an August turn-end record should classify the failure into a small taxonomy (timeout, rate limit, auth, …) so the transcript, the metrics and the receipt cannot disagree.

- **Model "the user is doing something else right now" as first-class state** — `apps/desktop/src/host-process.ts:59-64` (a `platform-session` may carry a `null` session: "a null session is allowed") and `apps/desktop/src/account-backend.ts:120` (an `account/watchExpiry` frame carries the literal `'session-expired'`, which the shell turns into a welcome-window notice). *Why it matters*: an August session that is interrupted, cancelled or handed to another window needs the same distinction between "the model has no credentials" and "the credentials expired mid-turn".

- **A background service that must not interrupt the user needs a *visible* state, not a silent one** — `apps/desktop/src/background-notice.ts:30-36` (one acknowledgement, persisted under `userData`, cancelled prompts stay eligible) with `apps/desktop/src/update-attention.ts:23-57` (one reminder per downloaded version, cleared on focus, never authorizing anything). *Why it matters*: an August background job (a scheduled task, a long tool run) should tell the user exactly once that it is still running and offer a way back, and the reminder must never be a shortcut for the real action.

- **Expose a *narrow, semantic* status to the renderer and keep the raw diagnostics on the main side** — `apps/desktop/src/ipc.ts:39-69` (`DesktopUpdateState` vs. `DesktopUpdatePresentation`: "Product documents cannot supply update versions, package URLs, or installation authorization") and `apps/desktop/src/update-presentation.ts:44-51` (`presentDesktopUpdate` returns phase, version, percent and a failure kind — no diagnostics, no controls). *Why it matters*: the same split — a semantic status for the UI, the full diagnostic for the report — is what an August turn-end frame should look like, and it is what keeps a renderer from being able to *ask* for something it should only *report*.

- **Rewrite a stale boundary explicitly: an overlay's `revision` counter makes consumers reset their own state instead of guessing** — `apps/desktop/src/update-overlay.ts:8-16` (`input(parent)` returns `{revision, blocked}`) consumed at `apps/desktop/src/keyboard.ts:128-131` (`if (overlay.revision !== overlayRevision) { resetInput(); overlayRevision = overlay.revision }`). *Why it matters*: an August turn that is superseded (a new user message, a policy change, a compaction) needs the same explicit epoch so the old turn's partial state is discarded rather than merged.

- **Do the work in a child process so the privileged step has a fixed, non-negotiable target** — `apps/desktop/src/command-manager-entry.ts:17-22` (the destination is a constant in the worker, so the elevation prompt in the parent cannot be steered) and `apps/desktop/src/command-manager-entry.ts:23-35` (the Windows path pipes JSON to a bundled PowerShell script through stdin instead of touching the filesystem from Node). *Why it matters*: an August tool that needs elevation (installing a skill, touching a protected path) should take its target from a constant, not from a model-authored argument.

- **Deny a whole class of navigation, not just the dangerous URL** — `apps/desktop/src/browser-guests.ts:141-169` (the guest session cancels any network request with embedded credentials, cancels any request to the app's own Host, denies all permission requests, display media and downloads, and refuses navigation to the Host by port+loopback alias). *Why it matters*: a model that can open a browser must not be able to reach the harness's own API, its own credentials, or a `user:pass@host` URL — a class-level deny is easier to audit than a per-URL allowlist.

- **Make the copy a type-level contract, and keep an unknown placeholder visible instead of rendering "undefined"** — `apps/desktop/src/locale.ts:172` (`DesktopMessages` is a mapped type over every English key), `:340` (`zh ... satisfies DesktopMessages`) and `:376` (`values[key] ?? placeholder` leaves an unknown `{name}` in the text). *Why it matters*: an August UI surface (a status line, a receipt, a tool summary) should have the same guarantee — a missing translation or a missing value is a compile error or a visible marker, never a silent `undefined`.

- **Present progress as a state machine the user can interrupt, with a named reason for every stop** — `apps/desktop/src/ipc.ts:39-49` (phases `idle|checking|available|downloading|verifying|installing|ready|error`, with `failedOperation` naming *which* step failed and `preparationFailure` naming the preparation cause) and `apps/desktop/src/update-journal.ts:8-10` (a closed vocabulary of milestones, flushed per record). *Why it matters*: the August turn should publish the same shape — a phase, a percentage, a named failed operation — so a stuck turn says which phase it is stuck in.

- **Make a stale cached credential set impossible by stamping the cache on every file that can hold one** — `apps/desktop/src/platform-view.ts:101-102` (a per-account persistent partition hashed from origin+userId, and a random non-persistent partition when the account id is unknown) with `apps/desktop/src/platform-view.ts:104-110` (the storage is sanitized *before* the view loads, "even after an unclean previous process exit"). *Why it matters*: an August install that caches a provider key in memory or on disk must re-stamp its cache on every file that can change it, or a "fixed" install keeps using the old key for the life of the process.

## Files skipped (with reasons)

None. Every one of the 69 files in the shard was opened and read in full. No file in this shard is generated, vendored, binary, or large-data; the largest are `main.ts` (1356 lines), `locale.ts` (395 lines, two parallel string dictionaries) and `host-process.ts` (322 lines), all of which were read end to end. `locale.ts` lines 201-300 (the middle of the Chinese dictionary) were read in a second pass after the first read covered 1-200 and 300-395.

## Uncertainties

- **The agent loop, tool-calling flow, reasoning/thinking streaming, prompt construction and cache strategy, context compaction, model-specific fallbacks, memory/learning, and subagent parallelism are NOT in this shard.** I checked by listing the manifest rows for `dsh-apps-desktop#2` (all 69 are under `apps/desktop/src/`), by listing `apps/desktop/` (subdirectories: `cli`, `config`, `installer`, `packaging`, `publishing`, `renderer`, `resources`, `scripts`, `src`, `tests`, `windows-signing`), and by globbing `apps/desktop/**/*.{test,spec}.*` (no matches under `src/`). The Host that actually runs the agent loop is a separate process (`@deepseek-ai/dsh-desktop-host`, referenced as `DESKTOP_HOST_PACKAGE` in `core-package-set.ts:14` and spawned from `host-process.ts:188`); its source is not in this clone's desktop app. Every statement I make about the agent loop in this report is therefore an *inference from the shell's contract with the Host*, not a reading of the loop itself. The one place the shell observes agent-loop behaviour is the Host's `update-tasks` / `quit-inspection` control messages (`host-process.ts:243-258`), which tell us the Host has active tasks and scheduled tasks — but not what they are.
- **The Host's IPC event vocabulary is only half-specified here.** `host-process.ts` validates and handles six event types; I could not find, in this shard, the code that *emits* them. The `platform-session` shape is the best documented (lines 61-79) but the `PlatformSession` type itself comes from the external package `@deepseek-ai/dsh-deepseek-account`, which I did not read.
- **`apps/desktop/tests/` is not in my shard** (I confirmed ~180 spec/e2e files and a `tests/expected/` snapshot tree exist there via a directory listing only; I did not read them). So my statement that the desktop suite exists and is large rests on that listing, not on reading the tests. The `apps/desktop/package.json` I read has no generic `test` script — only `test:installer` and `test:updates:local` — so the spec files are presumably run by a root-level runner I did not inspect.
- **`electron-updater` internals.** `update-coordinator.ts:60-68` reaches into `updater.httpExecutor`, a property the library does not declare; I read the comment and the surrounding code but did not verify the library's behaviour. `update-http-executor.ts` depends on `electron-updater/out/electronHttpExecutor.js` being importable at that exact path — I took the comment at line 19 ("The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead") at face value.
- **The `dsh-app://` protocol handler's static-document set.** `main.ts:667-682` serves `dsh-app://shell/*` from `join(app.getAppPath(), 'renderer')` and `dsh-app://app/*` from the packaged Web dist; the `renderer/` directory's contents are not in this shard, so I could not confirm which shell documents exist (I know of `welcome.html`, `update-dialog.html`, `mandatory-update.html` and `policy-login-loading.html` from the code that loads them).
- **`main.ts` is 1356 lines and I read all of it, but the `main()` function is dense.** A handful of its interactions (notably the `publishUpdate` → restore-host path at lines 538-558 and the `before-quit` branches at lines 1266-1288) I traced carefully; the `openUpdatePrompt` state machine at lines 802-868 I traced once and could have mis-sequenced a branch. I did not find an accompanying spec in this shard that would confirm my reading of that machine.
