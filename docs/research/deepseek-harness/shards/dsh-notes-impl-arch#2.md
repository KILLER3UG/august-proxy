# deepseek-harness / dsh-notes-impl-arch#2

## Shard shape

This shard is the *architecture* slice of DeepSeek Harness's implemented agent notes: 88 ADR-style notes, each shipped as a triplet — an English `NNN-SLUG.md`, a Chinese `NNN-SLUG.zh.md` translation, and an `NNN-SLUG.i18n.yaml` pairing record that stores a per-heading-section hash of the English and Chinese blocks. 260 files, 1.45 MB. The notes are not prose about the product; they are *decisions with a Problem / Decision / Alternatives considered / Consequences shape*, each naming the packages that own the behaviour, the alternatives that were rejected with the reason, and the limits the shipped mechanism does not claim. The 88 notes cover seven connected clusters: (1) the **execution world** — sandboxed Node PTC (per-call and persistent-in-memory), the POSIX SSH helper, the subprocess control pipe on fd 7, workflow PTC reuse, the profile module-resolution interception layer, and the LibreOffice kit split out of the monorepo; (2) the **agent loop and tool surface** — first-class `role: 'tool'` messages, three-phase tool calls (preparing/start/result) keyed by callId, incremental tool-argument scanning, `developer/message` records for dynamic tool changes, and the tool-history projection that keeps provider prefix caches alive; (3) **the Remote/Gateway transport** — the duplex stream with a bounded uplink inbox, the Peer/principal split with method-level RBAC, peer-scoped connect handshakes, and binary workspace-file transfer over multipart; (4) **Session lifecycle and persistence** — projection-cache read vs fold identity, V4 relationship validation, blank-session writer acquisition, source-attribution compatibility, explicit-history migration, and the retained draft/reference model; (5) **the Client UI** — conversation group definitions, group-tree positions and exchanges, the single fold motion, the reasoning Body Slot / Content Factory split, image Slots, the composer command chip, and window-drag coverage as an executable contract; (6) **configuration and packaging** — profile-owned live config, volatile config references, current-profile plugin management, guided install, install registries, package refresh and module replacement, on-demand bundles, and the naming-exception map; (7) **platform surfaces** — DeepSeek account login/sign-out, stored-credential precedence, native CUA (object API, consent, shared helper), the user terminal's permission model, the Web listener's bind address and TLS, and the Desktop's shell config, fatal recovery, and quit confirmation. The two largest notes (`peer-principal-and-remote-access` at 675 lines, `remote-duplex-stream` at 616) are where the design is most complete and are the most transferable. The `.zh.md` files are exact section-aligned translations (the i18n hashes prove the pairing) and carry no information the English does not; the `.i18n.yaml` files are pure machine records.

## Per-file notes

### .agents/notes/implemented/architecture/2026-09-11-plugin-owned-message-projections.zh.md
- Purpose: Chinese translation of the plugin-owned message projections note (its English `.md` and `.i18n.yaml` sit in shard #1, this shard owns only the translation).
- Key abstractions: `SessionMessageProjection` (one event type + a synchronous interpreter of preceding history), `@messageProjection` tag on a `SessionEventMap` member generating a required-interpreter inventory, `ctx.sessions.registerMessageProjection()`.
- Data flow: plugin registers a pure handler → Session atomically accepts, folds live and detached → content-generation cache invalidation on removal.
- Non-obvious design decisions: the ordinary session-projection registry is explicitly *not* reused (lines 25-27) because its folds expose domain state after commit and cannot veto an invalid append; "detached readers pass definitions explicitly" (line 19) rather than relying on a process-global registry.
- Edge cases / failure handling: missing interpreters reject append, seeded creation, restore and pure folding; a rejected uncommitted candidate retains no interpreter dependency (line 17).
- Surprising: a projection event may not also declare a surface operation (line 15).

### .agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.i18n.yaml
- Purpose: bilingual pairing record for the POSIX SSH runtime note; eight section hashes (problem, decision, decision/helper-deployment, alternatives-considered, consequences, verification, deferred-work).
- Key abstractions: per-heading-section en/zh digest pairs, keyed by the note's slug path.
- Data flow: `pnpm run verify-translation-pairing --write <note>.md` recomputes and records the digests after either side is edited.
- Non-obvious design decisions: hashes cover only text *outside* code blocks and generated regions (line 2), so fenced examples do not have to be translated.
- Edge cases / failure handling: a stale hash is the only failure signal — the file carries no status field.
- Surprising: it is a *consistency* record, not a translation aid: nothing in it tells a reader what the note says.

### .agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md
- Purpose: how a remote POSIX host is made to look like the local execution world — files, Bash, terminals, LSPs and Node programs over SSH.
- Key abstractions: a deployment-owned OpenSSH alias to an installed helper; filesystem/subprocess/sandbox providers share that helper; the Harness keeps Cordis objects, model transport, permissions and Session persistence.
- Data flow: policy is resolved *asynchronously inside the running helper* through its loaded sandbox provider, then the subprocess provider receives literal argv (line 17); private admin RPC and each program stream use independent SSH channels; each stream gets a fresh 256-bit TLS-PSK before it may publish.
- Non-obvious design decisions: TLS 1.2 `PSK-AES256-GCM-SHA384` with the key delivered over the admin RPC and never as a stream preface (line 21) — socket permissions alone are insufficient because file-effect confinement can permit same-user connections or pathname replacement; `SIGUSR1` is disabled in the helper because confinement can still permit same-user signals.
- Edge cases / failure handling: connection loss invalidates pending operations with no reconnect or replay (line 23); a lease expiry is not an observed successful termination — an interrupted write or launch may have an unknown outcome.
- Surprising: stdout/stderr cannot carry admin replies and pausing one output channel does not consume fd 7's flow-control window (line 19); the packaged unit is a whole archive directory, not a single executable, because Landlock and the macOS PTY launcher must be real files.

### .agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md
- Purpose: Chinese translation of the POSIX SSH runtime note; section-for-section equivalent to the English (problem, decision, helper-deployment, alternatives, consequences, verification, deferred work).
- Key abstractions: same SSH-helper-provider model, TLS-PSK stream keys, `launch.kind` of `node-script` or `executable`.
- Data flow: same — policy resolution inside the helper, separate admin and program channels, per-stream PSK.
- Non-obvious design decisions: the four release targets cover Linux/macOS x64+arm64 only; pkg/SEA is chosen because it preserves the package directory tree and dynamic module resolution without a static plugin registry (zh line 15).
- Edge cases / failure handling: unchanged — unknown outcomes on interrupted writes, no replay, cleanup on EOF/signal/heartbeat-lease.
- Surprising: same as English — the helper's own digest (and a script deployment's bootstrap digest) is verified, which pins deployment artifacts but does not authenticate a malicious remote OS.

### .agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.i18n.yaml
- Purpose: pairing record for the sandboxed Node PTC note; nine section hashes including three nested decision subsections.
- Key abstractions: en/zh digests under `/agent-note-sandboxed-node-execution-for-ptc/...`.
- Data flow: `verify-translation-pairing --write` writes the digests.
- Non-obvious design decisions: subsection keys (`/decision/resolved-inputs-and-policy`, `/decision/control-and-lifetime`, `/decision/resource-limits`) are hashed separately, so a translation that merges two subsections fails the pairing gate.
- Edge cases / failure handling: any digest mismatch is the failure signal.
- Surprising: the record proves section *structure* parity, not semantic parity.

### .agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md
- Purpose: how model-written Node code (PTC) runs under the Session's OS sandbox rather than in an in-process worker.
- Key abstractions: `dsh-ptc-runtime-node` in default `per-call` mode — one fresh Node process per program; `PtcRuntime.resolve(request)` → `PtcRunSpec`; `PtcRunResult.sandbox` carries file mode, observed denials and enforcement completeness separately from the program outcome.
- Data flow: host resolves execution choices, confines the launch through the same `ctx.sandbox` as Bash, gives process lifetime to `ctx.subprocess`; the child evaluates erasable TypeScript with an empty model environment and host-provided async bindings (line 15).
- Non-obvious design decisions: a Node *worker* is rejected because tool checks cannot intercept direct `import` of `fs`/`child_process` (line 41); the host preserves `ELECTRON_RUN_AS_NODE` for child startup but the bootstrap strips it before evaluation, so model-visible `process.env` stays empty (line 17).
- Edge cases / failure handling: restricted execution fails if the required sandbox backend cannot launch; program success does not prove full enforcement (line 23); a denial or transport failure never automatically replays a program whose effects may already have occurred (line 31).
- Surprising: the default elapsed deadline is 120 s capped at 600 s, and it *includes* runtime setup and nested tool/approval waits; the heap limit excludes native allocations and descendant memory, and elapsed time is explicitly not a process-tree CPU budget (line 35).

### .agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md
- Purpose: Chinese translation of the sandboxed Node PTC note; mirrors the English's nine hashed sections.
- Key abstractions: `per-call` PTC mode, `PtcRuntime.resolve`/`run`, `PtcRunResult.sandbox`.
- Data flow: identical — host resolves, sandbox confines, subprocess owns lifetime.
- Non-obvious design decisions: the same rejection of the worker model and the same `ELECTRON_RUN_AS_NODE` handling (zh lines 41, 17).
- Edge cases / failure handling: same — no replay after denial, sandbox-backend failure fails the call.
- Surprising: same — elapsed deadline includes nested approval waits; "程序成功不证明完整强制能力" (program success does not prove full enforcement).

### .agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.i18n.yaml
- Purpose: pairing record for the subprocess control pipe note; five section hashes (problem, decision, alternatives-considered, consequences).
- Key abstractions: en/zh digests under `/agent-note-subprocess-control-pipe`.
- Data flow: written by `verify-translation-pairing --write`.
- Non-obvious design decisions: the "decision" hash spans one very long paragraph, so the pairing gate is per-heading, not per-sentence.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the smallest of the seven records for the same note family — its note has no verification subsection.

### .agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.md
- Purpose: a dedicated binary channel for host↔managed-Node control traffic that does not share stdout/stderr.
- Key abstractions: `stdio.control: 'pipe'` yields a raw `Duplex` as `handle.control`; the target opens **fd 7** via `@deepseek-ai/dsh-subprocess/control`; the provider owns the environment marker, the child helper consumes it.
- Data flow: POSIX launchers preserve fd 7 across exec; Windows ordinary-Job and restricted-token launchers place the pipe at slot 7 in the CRT startup descriptor table, preserve standard handles, leave slots 3-6 closed, and each wrapper closes its carrier after transferring ownership (line 15).
- Non-obvious design decisions: Node's `overlapped` stdio disposition is used because it equals `pipe` on POSIX and creates `FILE_FLAG_OVERLAPPED` handles on Windows — needed so a child can send its first message before the host sends anything (line 17); a *late* Windows descriptor replacement is rejected because Node may already own the descriptor (line 31).
- Edge cases / failure handling: handle inheritance is enabled only around process creation; the channel grants no host capability — every host tool request still needs its usual dispatch and approval checks (line 15).
- Surprising: the Windows managed-range proof observes the runner process exit and its private IPC result *independently of caller stream drains*, so paused control output cannot delay disposal (line 19).

### .agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.zh.md
- Purpose: Chinese translation of the subprocess control pipe note; five hashed sections.
- Key abstractions: `stdio.control: 'pipe'`, `handle.control`, fd 7 as the fixed slot on every platform.
- Data flow: identical — POSIX preserves fd 7 across exec, Windows uses CRT slot 7, wrappers close their carrier after transfer (zh line 15).
- Non-obvious design decisions: the same "one fixed slot also allows remote providers to preserve the same child API" argument (zh line 33).
- Edge cases / failure handling: same — no host capability conferred; inheritance only around process creation.
- Surprising: same — the channel is explicitly *not* a JavaScript security boundary; the OS sandbox and managed process owner still own confinement and teardown.

### .agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.i18n.yaml
- Purpose: pairing record for the browser-use provider registration note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-browser-use-provider-registration-and-session-ownership`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the slug in the key includes the "and Session ownership" half, matching the note's full title rather than its filename.
- Edge cases / failure handling: digest mismatch only.
- Surprising: identical file size to the computer-use sibling despite a much longer note — the note's paragraphs are dense, not numerous.

### .agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md
- Purpose: how browser-control backends plug in without dictating a common action API, and who owns the browser.
- Key abstractions: `dsh-browser-use` owns `ctx.browserUse`, a *name-only* registry: "registers one provider-owned name and returns its effect disposer. A second registration fails regardless of its name" (line 13). The service contains no browser object, operation type, dispatch method, lifecycle or selector.
- Data flow: Playwright MCP, Chrome DevTools MCP and native Stagehand own their own tools and integrate through the normal DSH tool pipeline; DSH owns task planning and the task loop (line 15).
- Non-obvious design decisions: browser resources belong to the *exact live Agent and Session*, not merely a reusable Session id, and a reload or fork does not inherit a launched profile (line 17); the provider host uses `@puppeteer/browsers` to own launched Chromium and its temp profile *before* CDP or SDK readiness (line 21), because Stagehand's SDK init can time out before its cleanup settles.
- Edge cases / failure handling: failed SDK drain blocks reuse while Chromium stays alive; a failed drain during attachment, failed Worker termination, or failed owned-process cleanup *retains* the reservation (line 21); the host kills only its own Chromium and waits for child closure before removing the profile.
- Surprising: cancelling a caller's acquisition wait leaves initialization and its reservation owned by the Session (line 19); an active operation's Agent-disposal cancellation starts resource shutdown *before* the Agent waits for idle.

### .agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.zh.md
- Purpose: Chinese translation of the browser-use provider registration note; five hashed sections.
- Key abstractions: same name-only `ctx.browserUse` registry.
- Data flow: same — three providers own their tools, DSH owns the task loop.
- Non-obvious design decisions: same — resources belong to the exact live Agent and Session; `@puppeteer/browsers` owns Chromium before readiness.
- Edge cases / failure handling: same — reservation retained on failed drain or failed Worker termination.
- Surprising: same — MCP client activation may complete before any Session exists, so each provider waits once on the serial `agent/created` event (zh line 25).

### .agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.i18n.yaml
- Purpose: pairing record for the computer-use provider registration note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-computer-use-provider-registration`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the slug is the bare capability name, without "provider registration" — the same pattern as `browser-use`.
- Edge cases / failure handling: digest mismatch only.
- Surprising: structurally identical to the browser-use record (same size class), because both notes have exactly the same five headings.

### .agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md
- Purpose: registration rules for desktop-control providers (Cua Driver over MCP and native).
- Key abstractions: `dsh-computer-use` owns `ctx.computerUse`, again a name-only registry where a second registration fails regardless of name (line 13); the service holds no provider object, shared operation type, dispatch method, Session lock or runtime selector.
- Data flow: the native provider uses `tools/execute` to share cancellation across native calls and screenshot admission while preserving execution identity (line 19).
- Non-obvious design decisions: MCP result conversion stays in `dsh-mcp-client` — the computer-use service has *no dependency* on that adapter or on either provider (line 17); concurrent Sessions are left caller-coordinated because a provider registration does not own an observe-act-verify workflow (line 19).
- Edge cases / failure handling: provider teardown retains the registration until tool admission stops and owned work and resources close; a grouped Cordis effect orders that cleanup, separate effects may dispose concurrently (line 19).
- Surprising: cancellation stops waiting and propagates to the driver but "does not promise rollback of delivered desktop input" (line 35); macOS cursor-overlay hosting and the dedicated Desktop permission UI are explicitly deferred.

### .agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.zh.md
- Purpose: Chinese translation of the computer-use provider registration note; five hashed sections.
- Key abstractions: same name-only `ctx.computerUse` registry.
- Data flow: same — `tools/execute` shares cancellation between native calls and screenshot admission.
- Non-obvious design decisions: same — MCP result conversion lives in `dsh-mcp-client`, and the service depends on neither.
- Edge cases / failure handling: same — teardown retains registration until admission stops and resources close.
- Surprising: same — "不承诺回滚已交付的桌面输入" (no rollback of delivered desktop input is promised).

### .agents/notes/implemented/architecture/2026-09-13-session-working-directory.i18n.yaml
- Purpose: pairing record for the Session working directory note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-session-working-directory`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: same five-heading shape as the other single-decision notes.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's own text is about a *single* owner of a mutable value — and the i18n record is the simplest possible mechanism for keeping a second language in step with it.

### .agents/notes/implemented/architecture/2026-09-13-session-working-directory.md
- Purpose: one authoritative, changeable working directory per Session.
- Key abstractions: `dsh-working-directory` owns *one logged effective directory* per Session; its projection initializes from the immutable original project and folds `working-directory/change` (line 13).
- Data flow: the tool reads or changes the Session directory so every Agent preset can select or recover it, including presets with no file-editing tools (line 15); changes validate through the filesystem provider, serialize within the Session, and publish only after the new directory is available.
- Non-obvious design decisions: mutable directory information is deliberately kept *out* of the system prompt, because that would change the reusable prompt prefix (line 9); the original project is the recovery destination, and the Session header is immutable identity metadata used by storage, grouping and permission roots (line 33).
- Edge cases / failure handling: a missing recovery destination produces an error; when both the current directory and its recovery destination are unavailable, prompt assembly *rejects model turns* (line 45); cancellation or disposal may discard unadmitted notices while the directory event survives.
- Surprising: existing processes, terminals and persistent shells keep their process-local directory — a Session change affects only new directory-based operations (line 19); `{{cwd}}` has no loop-provided value, so custom personas relying on it fail strict interpolation.

### .agents/notes/implemented/architecture/2026-09-13-session-working-directory.zh.md
- Purpose: Chinese translation of the Session working directory note; five hashed sections.
- Key abstractions: same single directory owner and `working-directory/change` fold.
- Data flow: same — validate, serialize within the Session, publish only when available.
- Non-obvious design decisions: same — mutable context belongs after retained history, not in the system prompt.
- Edge cases / failure handling: same — prompt assembly rejects model turns when both directory and recovery destination are gone.
- Surprising: same — a shell's own `cd` stays local to that process.

### .agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.i18n.yaml
- Purpose: pairing record for the workflow PTC reuse note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-reuse-the-ptc-node-sandbox-for-workflows`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the digest key uses the note's *title* ("Reuse the PTC Node sandbox for workflows"), not its filename slug.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the key and the filename diverge, so a mechanical filename→key mapping is wrong — the tool derives the key from the H1.

### .agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md
- Purpose: run model-written workflow scripts in the same sandboxed Node runtime as `run_code`, instead of a worker thread.
- Key abstractions: `dsh-workflow-ptc` implements `WorkflowEngine` through the shared Node `PtcRuntime`; host bindings connect the guest to the configured subagent provider and workflow observers (line 13).
- Data flow: the VM defines the helper API and cooperative concurrency, total-agent and item caps; the VM "is not a security boundary, and those counters are not host-enforced security quotas" (line 15).
- Non-obvious design decisions: workflow execution passes `timeoutMs: null`, explicitly disabling the elapsed timer, while omitted and numeric PTC requests keep their defaults and caps (line 17) — a workflow may await a long series of subagents, so the deadline is caller-controlled rather than arbitrary.
- Edge cases / failure handling: cancellation aborts the PTC process and the signal shared by pending and active child agents; the adapter awaits pending starts and child disposal *including a child that publishes after cancellation* (line 19).
- Surprising: the Node bootstrap keeps its control pipe open after sending the terminal frame until the host closes it, because unawaited binding replies may still be in flight and eager child-side close would race an already-completed program with an `EPIPE` (line 23).

### .agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md
- Purpose: Chinese translation of the workflow PTC reuse note; five hashed sections.
- Key abstractions: same `WorkflowEngine`-over-`PtcRuntime` composition.
- Data flow: same — VM helpers and caps, PTC owns confinement.
- Non-obvious design decisions: same — `timeoutMs: null` as an explicit caller-controlled lifetime.
- Edge cases / failure handling: same — await child disposal including post-cancellation publications.
- Surprising: same — the `EPIPE` race and the deliberate late close of the control pipe.

### .agents/notes/implemented/architecture/2026-09-14-current-profile-plugin-management.i18n.yaml
- Purpose: pairing record for the current-profile plugin management note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-current-profile-plugin-management-shares-cli-transactions`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key captures the whole title including "shares CLI transactions", documenting *why* the note exists in the key itself.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the same key convention recurs across the shard, making the i18n directory a de-facto index of decision titles.

### .agents/notes/implemented/architecture/2026-09-14-current-profile-plugin-management.md
- Purpose: one package-installation implementation shared by the CLI, the Web controls and the agent tool, without clobbering user YAML.
- Key abstractions: `ctx.profileContext` is *pure data* (profile and resolution locations, startup bundles, invocation overlays) with no callbacks or mutation methods (line 13); CLI and service mutations hold the profile manifest's writer lock; DSH HMR serialises module replacement, Include refresh, profile recomposition and manager config changes through one queue.
- Data flow: HMR registers profile watches during its own init then waits for application readiness before processing edits; the final YAML composition decides whether HMR runs, and the launcher installs no fallback (line 13).
- Non-obvious design decisions: Chokidar's *ordinary* change handler discards a second event within 50 ms, so a write right after activation can leave the previous bundle running — the note therefore uses **write stabilization** and observes the final file, while direct manager transactions skip the delay (line 15). Manifest notifications compare only the ordered bundle list, so dependency-only changes do not trigger a config reload.
- Edge cases / failure handling: a service removal applies the composition without the bundle and waits for old fibers to finish before deleting the dependency; a failed removal preserves the actual partial state and a diagnostic path, while a failed/cancelled install restores the profile files it snapshotted (line 17).
- Surprising: build approvals update pnpm 11's unresolved `allowBuilds` entries under the same profile lock and *reject anchors and aliases* inside `allowBuilds`, so a shared YAML node cannot change unrequested permissions (line 23); HMR does not take the package writer lock, so installation cannot block unrelated file-driven config changes.

### .agents/notes/implemented/architecture/2026-09-14-current-profile-plugin-management.zh.md
- Purpose: Chinese translation of the current-profile plugin management note; five hashed sections.
- Key abstractions: same data-only `ctx.profileContext`, same single package-operation module.
- Data flow: same — HMR serialises through one queue; the YAML composition decides whether HMR runs.
- Non-obvious design decisions: same — the 50 ms Chokidar window is why write stabilization is required (zh line 15).
- Edge cases / failure handling: same — partial state preserved on failed removal; failed/cancelled install restores snapshotted profile files.
- Surprising: same — the `allowBuilds` anchor/alias rejection.

### .agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.i18n.yaml
- Purpose: pairing record for the DeepSeek account browser login note; seven section hashes (adds verification and related).
- Key abstractions: en/zh digests under `/agent-note-deepseek-account-browser-login`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: this note has more headings than the standard five because it also records verification and cross-links.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the digest count is a cheap proxy for how much a note actually commits to.

### .agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md
- Purpose: browser-based DeepSeek account login with local cancellation, PKCE, and a Host-owned loopback callback.
- Key abstractions: the account Service Definition separates UI/model consumers from the platform protocol; the platform provider registers an AuthorizationFlow and persists an owner-scoped GrantRecord; account presence is *derived* from storage (line 15).
- Data flow: the authenticated initiating client supplies its browser-accessible loopback HTTP origin (including any local SSH forwarding port); authorization registers a temporary `/oauth/callback` route on the Host webServer; the callback redirects to `auth_exchange.biz_data.authorized_url` only after authorization settlement confirms storage (line 17).
- Non-obvious design decisions: **local cancellation is authoritative** — the provider stops callbacks and ignores late exchange results, and `auth_cancel` invalidates the remote application and unexchanged code using `authorize_id` and the original PKCE verifier (line 17). `session.commit` admits persistence *synchronously before its first await* and rejects an already-cancelled flow, so a cancel cannot win a race it should lose. Non-loopback reverse proxies are unsupported.
- Edge cases / failure handling: model and file request tokens resolve only for the configured `inferenceOrigin` (default `https://api.deepseek.com`) and redirects are refused; an explicit alternate origin requires grants from the configured Platform issuer, so changing the endpoint alone never forwards account credentials; development loopback grants cannot authenticate production requests (line 19).
- Surprising: the five Platform client headers are derived *per call* from the calling UI's client version, language and UTC offset plus the composed native platform — and client-identity headers override same-named deployment headers, so one Host shared by several callers reports the UI that made each request rather than the last one it saw (line 23).

### .agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md
- Purpose: Chinese translation of the DeepSeek account login note; seven hashed sections.
- Key abstractions: same Service Definition / platform provider split, same owner-scoped GrantRecord.
- Data flow: same — temporary `/oauth/callback`, redirect only after storage is confirmed.
- Non-obvious design decisions: same — local cancellation is authoritative and `session.commit` admits persistence synchronously before its first await (zh line 17).
- Edge cases / failure handling: same — inferenceOrigin confinement, no redirects, dev grants cannot authenticate production.
- Surprising: same — per-call client-identity headers override deployment headers so a shared Host reports the actual caller (zh line 23); the Platform embed reads the token *synchronously* after a one-time preload IPC.

### .agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.i18n.yaml
- Purpose: pairing record for the LibreOffice kit ownership note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-independent-libreoffice-kit-ownership`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: key derived from the title "Independent LibreOffice kit ownership".
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's subject — splitting a heavyweight engine out of the monorepo — is mirrored by the repo's own i18n discipline about keeping the heavy artifact (the binary) out of the app workspace.

### .agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md
- Purpose: move LibreOffice compilation, patches and binary releases into their own repository.
- Key abstractions: `deepseek-harness/libreoffice-kit` owns the `@deepseek-ai/libreoffice-kit` Node API, its Worker, font handling, engine selection, build recipes, patches, tests and releases; **the API has no Cordis dependency** (line 13).
- Data flow: Harness owns only the adapter from its `OfficeToPdf` service to that API, plus Session authorization, conversion lifetime, transport, Web UI and packaging; Harness consumes an *exact* npm version and commits resolution in `pnpm-lock.yaml` (line 15).
- Non-obvious design decisions: kit releases are independent of Harness releases, both API and engine packages publish at a shared version starting at `0.0.1`; the platform engine is an *optional* dependency, and Python sidecars keep the Worker, engine and dependency closure on the real filesystem, outside the executable's virtual filesystem (line 17).
- Edge cases / failure handling: a missing required npm package fails installation — Harness does not compile an engine to recover (line 29); the redistribution-notice check accepts only the exact API/WASM/macOS-ARM64/x64/Windows-ARM64/x64 package identities at MPL-2.0.
- Surprising: Harness "retains these materials when packaging them" (MPL-2.0 source availability), so a repo split does not shed the licence obligations.

### .agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.zh.md
- Purpose: Chinese translation of the LibreOffice kit ownership note; five hashed sections.
- Key abstractions: same API/Worker split, same "no Cordis dependency" rule.
- Data flow: same — Harness owns the adapter and packaging only.
- Non-obvious design decisions: same — exact npm version pinned in the lockfile; engines are optional dependencies.
- Edge cases / failure handling: same — missing package fails install, no engine compiled as recovery.
- Surprising: same — the licence-material retention obligation travels with the split.

### .agents/notes/implemented/architecture/2026-09-14-session-log-upload-default.i18n.yaml
- Purpose: pairing record for the session-log upload default note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-default-deepseek-session-log-upload`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *default*, which is the decision's whole point.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the file omits the blank line after the language links that the note itself has — a reminder that these are separate files with separate formatting rules.

### .agents/notes/implemented/architecture/2026-09-14-session-log-upload-default.md
- Purpose: session-log contribution to DeepSeek requests is ON by default, so ordinary product requests supply the full canonical trajectory.
- Key abstractions: `session-log-deepseek.Config.enabled` defaults to `true` in every process; a resolved `enabled: false` disables it and configuration precedence picks the winner (line 12).
- Data flow: the `enabled` value is read *per request through a volatile reference*, so a saved preference takes effect without restarting the plugin (line 14).
- Non-obvious design decisions: the plugin does **not** inspect test-runner or snapshot environment variables, because doing so would also change downstream SDK behaviour for callers that inherit those variables (line 20); disabling upload leaves the acceptance watermark unchanged because it records provider acceptance, not user eligibility — so re-enabling sends the unaccepted suffix, including events recorded while disabled.
- Edge cases / failure handling: already-prepared requests retain their payload; the headless and ACP corpus base patches and Web scaffold explicitly disable upload, and later scenario patches can re-enable it (line 16).
- Surprising: the SDK text-turn recording *omits* the setting and therefore exercises the shipped default, including durable acceptance events (line 16).

### .agents/notes/implemented/architecture/2026-09-14-session-log-upload-default.zh.md
- Purpose: Chinese translation of the session-log upload default note; five hashed sections.
- Key abstractions: same `Config.enabled` default-true and volatile per-request read.
- Data flow: same — volatile reference so no plugin restart is needed.
- Non-obvious design decisions: same — no test-environment sniffing.
- Edge cases / failure handling: same — the acceptance watermark tracks provider acceptance, not eligibility.
- Surprising: same — the SDK recording deliberately omits the setting to test the real default.

### .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.i18n.yaml
- Purpose: pairing record for the document-relative app routes note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-web-app-owned-routes-are-document-relative`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key again uses the note's title, which differs from the filename ("Web app-owned routes are document-relative").
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's central claim is that the *document* is the authority on its own mount — and the i18n record shows the same instinct: the note title, not the filename, is the identity.

### .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md
- Purpose: make one Web bundle serve both the origin root and any prefix-stripping proxy mount.
- Key abstractions: the served HTTP shell owns its document base; the index carries exactly one `<base href="./">`, spliced in after the opening head tag once the index taps have run, so it precedes the boot manifest, every plugin-resource row, and any tap-inserted markup (line 15). Server route *keys* stay absolute pathnames; browser *references* are document-relative (`api/x`, `plugins/x`).
- Data flow: the Host composes browser references in one place per producer; the source-map trailer carries the combo query alone because a script's source-map resolves against that script's own directory, not the document (line 19).
- Non-obvious design decisions: the mount **cannot** be recovered from the transport — a configured base URL is deployment input, forwarded-prefix inference makes a request header authoritative for routing, and proxy rewriting reimplements the fact in fragments (line 11). The document is the only place that already knows the mount, so the base freezes the entry directory and a later in-page `pushState` does not move it.
- Edge cases / failure handling: only the dist root and the configured index path are supported entries; a bare mount still needs the proxy's own slash normalisation; a reload of a deep in-page path re-enters at that path rather than the frozen one (line 39).
- Surprising: shared constants naming a route key (`*_PATH`, `*_ENDPOINT`) are stripped at the boundary (`KEY.slice(1)`) before browser code uses them, and the browser form lives beside it as `*_ROUTE` (line 17) — one constant, two spellings, one conversion point.

### .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.zh.md
- Purpose: Chinese translation of the document-relative app routes note; six hashed sections.
- Key abstractions: same single `<base href="./">` in the served index.
- Data flow: same — one composition point per producer, absolute server keys vs relative browser references.
- Non-obvious design decisions: same — the mount is not recoverable from the transport, so the document owns it.
- Edge cases / failure handling: same — limited supported entries, proxy slash normalisation required.
- Surprising: same — the `KEY.slice(1)` boundary strip and the `*_ROUTE` sibling constant.

### .agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.i18n.yaml
- Purpose: pairing record for the bounded Office conversion note; seven section hashes (adds related).
- Key abstractions: en/zh digests under `/agent-note-bounded-shared-office-conversion`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the "related" heading is hashed too, so a broken cross-link in one language fails the pairing.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's own "Related" section points at a *proposed* note that questions the need for the implemented behaviour — the pairing record keeps both sides of that argument in step.

### .agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.md
- Purpose: one shared, bounded Office→PDF conversion queue that serves preview, QA and speculative background work without letting speculation starve the user.
- Key abstractions: the Host provider owns a shared conversion queue and a transient content cache; **authorized source metadata enters admission before source bytes are loaded** (line 15); the source callback receives reserved byte capacity and returns its read version, and changed sources fail without publishing aliases.
- Data flow: a bounded source-version index avoids repeated reads after authorization, but the *digest* remains the identity for sharing a conversion across distinct paths (line 17) — content hashing, not path, is the sharing key.
- Non-obvious design decisions: foreground preview and explicit QA requests precede background work; removing a queued foreground blocker immediately admits eligible background work; a foreground join promotes a prewarm and the final foreground cancellation demotes it (line 19). A speculative admission stays occupied through settlement, so promotion cannot admit more speculation into capacity reserved for user work.
- Edge cases / failure handling: readers, queue, source-byte and conversion limits all apply *before* work completes; each active source locator belongs to live readers, so cancellation cannot grow retained source metadata independently of reader admission; unknown source sizes reserve the input cap (line 17).
- Surprising: each converter lifetime adds a generation, so an engine/font/config replacement invalidates reuse (line 15); the cache owns private output bytes and returns a *copy* to each caller.

### .agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.zh.md
- Purpose: Chinese translation of the bounded Office conversion note; seven hashed sections.
- Key abstractions: same shared queue + transient cache with content-hash identity.
- Data flow: same — admission before bytes, digest for cross-path sharing.
- Non-obvious design decisions: same — foreground/background priority and speculative occupancy held through settlement.
- Edge cases / failure handling: same — per-reader source-locator ownership, unknown sizes reserve the cap.
- Surprising: same — a converter generation invalidates reuse on engine/font/config change.

### .agents/notes/implemented/architecture/2026-09-15-client-session-references.i18n.yaml
- Purpose: pairing record for the Client Session references note; six section hashes.
- Key abstractions: en/zh digests under `/agent-note-client-session-references-reference-sources-and-ui-status`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key embeds three title fragments, showing the tool derives keys from the H1 rather than the filename.
- Edge cases / failure handling: digest mismatch only.
- Surprising: this is one of the shard's longest notes (226 lines) yet its pairing record is only ~2.6 KB — the digests are per-section, not per-line.

### .agents/notes/implemented/architecture/2026-09-15-client-session-references.md
- Purpose: explicit, reference-counted ownership of Client Session objects, with consumer-source metadata, so components stop acting on "the current session".
- Key abstractions: `SessionTarget` (a known id or a durable `SubagentAddress`) identifies what to acquire and owns nothing; `SessionBinding` is the shared Client *generation* (sessionId + face + event source + scoped Context); `SessionReference` owns one use of one exact generation, exposing read-only `sessionId`/`binding`, a `ready` Promise, and idempotent `release()`/`Symbol.dispose` (line 41).
- Data flow: acquisition resolves the target synchronously, creates the local Session/Context/fiber/binding, records a reference with its source count, starts the generation's shared first history open, and returns; concurrent acquisitions share the open but get independent references (line 58).
- Non-obvious design decisions: the reference count identifies ongoing use but *not its consumers* — main-area highlighting, Sidebar ownership and background operations need consumer-source information, so each source's count is tracked and exposed as `retainedBy` (line 74). `current` is merely the fact that the `mainView` source count is positive, not a separate `sessions.current` service (line 80). Business caches key on the *binding* via `WeakMapWithValues<SessionBinding, Value>`, not on the Session id, because the same id can have two live generations (line 127).
- Edge cases / failure handling: the `ready` Promise resolves even when the open failed with `openState: 'error'` — it means the *attempt* settled, not that the session is open (line 64); cancelling one waiter does not cancel the shared open; releasing the last reference withdraws that generation's admission and id mapping before cleanup, and an old generation's cleanup must not remove its replacement (line 66).
- Surprising: a metadata-only fork sends the rename directly and applies the returned projection *without acquiring a Client reference or doing history I/O*, so it cannot create a temporary list row or switch the main view (line 224); `SessionReference` acquisition creates no persistent Session and does not start, stop or hold a Host Agent.

### .agents/notes/implemented/architecture/2026-09-15-client-session-references.zh.md
- Purpose: Chinese translation of the Client Session references note; six hashed sections.
- Key abstractions: same Target/Binding/Reference split and `retainedBy` source counts.
- Data flow: same — synchronous acquisition, shared first history open, independent references.
- Non-obvious design decisions: same — `current` is derived from the `mainView` count, not a separate selection service; caches key on the binding via a weak map.
- Edge cases / failure handling: same — `ready` means the attempt settled, even on an error state; old generation cleanup must not remove its replacement.
- Surprising: same — metadata-only fork does no Client reference or history I/O (zh line 224).

### .agents/notes/implemented/architecture/2026-09-15-desktop-native-fatal-recovery.i18n.yaml
- Purpose: pairing record for the native Desktop fatal recovery note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-native-desktop-fatal-recovery`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the title, not the filename ("Native Desktop fatal recovery").
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about *not* having a recovery document, and the i18n record is itself a small example of a shared record that every reader can consult.

### .agents/notes/implemented/architecture/2026-09-15-desktop-native-fatal-recovery.md
- Purpose: a fatal-failure path that works even when the renderer and preload — the components a recovery page would need — are exactly what failed.
- Key abstractions: Electron owns *one* native fatal dialog per application process; the first report claims presentation before awaiting the dialog and later reports stay in logs (line 15).
- Data flow: explicit main-window creation, document-load, preload, renderer, Web init and backend failures enter this path; expected cancellation and shutdown do not; no elapsed-time heuristic classifies a slow startup as fatal (line 13).
- Non-obvious design decisions: the dialog bounds the first diagnostic to its final eight lines and the complete detail to 1,200 UTF-16 code units (including truncation notice, report path and reinstall advice) *because native dialogs cannot scroll* (line 15). Recovery calls the shared `sanitizeProfile` under the existing profile lock after Host shutdown; that function restores caller-supplied bundles and renames the profile patch to a unique backup **without parsing it**, requiring runtime init, or deleting installed files (line 15).
- Edge cases / failure handling: a malformed home-level patch still blocks startup after profile recovery and requires manual repair; backups accumulate without automatic pruning; invalid profile JSON can prevent disabling plugins, but exit and restart remain available after the operation reports its failure (line 29).
- Surprising: the Web document stays in place and the boot page keeps its spinner — only the *primary application frame* may report a Web boot failure (line 17).

### .agents/notes/implemented/architecture/2026-09-15-desktop-native-fatal-recovery.zh.md
- Purpose: Chinese translation of the native Desktop fatal recovery note; five hashed sections.
- Key abstractions: same one-dialog-per-process native fatal path.
- Data flow: same — first report claims presentation; later reports go to logs.
- Non-obvious design decisions: same — the 1,200-code-unit cap exists because native dialogs cannot scroll (zh line 15).
- Edge cases / failure handling: same — malformed home patch still blocks; backups accumulate.
- Surprising: same — the Web boot page keeps its spinner; only the primary frame may report.

### .agents/notes/implemented/architecture/2026-09-15-first-class-tool-role-messages.i18n.yaml
- Purpose: pairing record for the first-class tool-role messages note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-first-class-tool-role-messages`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: same standard five-heading shape.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about the *persisted role* of a tool result, and the pairing record's own role — proving the Chinese block corresponds to the English one — is the same kind of structural guarantee.

### .agents/notes/implemented/architecture/2026-09-15-first-class-tool-role-messages.md
- Purpose: stop storing tool results inside a user-role `tool-result` block and make `role: 'tool'` a first-class persisted message.
- Key abstractions: Session format V4 stores one tool result as a `role: 'tool'` message whose `toolCallId`, source call id, result content and optional error flag are validated together (line 13).
- Data flow: the V3→V4 edge lifts exactly one released wrapper and refuses nested wrappers *before* publication, retaining the source generation; current V4 decoding is native-only (line 13).
- Non-obvious design decisions: when a historical wrapper is removed, message and result extension fields keep distinct `plugin:message:` and `plugin:result:` names and the *complete* original field name in the suffix, so nothing collides and no core metadata field is added (line 15). The wrapper alone supplies the interpreted call id and error flag; an old outer field with the same spelling stays opaque.
- Edge cases / failure handling: the **conversation role map is closed** — a model-visible role must have a persisted Session event and an adapter projection, so adapters cannot silently turn an unlogged extension role into user text (line 17).
- Surprising: duplicate values from distinct owners are deliberately retained ("opaque retention avoids inventing a shared field owner when the wrapper disappears") and plugin consumers must migrate to the V4 names (line 15).

### .agents/notes/implemented/architecture/2026-09-15-first-class-tool-role-messages.zh.md
- Purpose: Chinese translation of the first-class tool-role messages note; five hashed sections.
- Key abstractions: same V4 `role: 'tool'` message with jointly validated fields.
- Data flow: same — one-wrapper migration edge, native-only current decoding.
- Non-obvious design decisions: same — `plugin:message:` / `plugin:result:` naming with full original field names in the suffix.
- Edge cases / failure handling: same — closed role map; malformed nested wrappers refused.
- Surprising: same — duplicate values from distinct owners are kept on purpose.

### .agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.i18n.yaml
- Purpose: pairing record for the guided plugin installation note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-guided-plugin-installation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: same five-plus-testing shape as the other install notes.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's key insight — that a red exit code cannot tell a typo from an outage — is exactly what a hash record prevents in the doc set.

### .agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.md
- Purpose: turn a raw `pnpm add` terminal into an inspect-first, classified, cancellable install flow.
- Key abstractions: `PluginManager.inspect` sorts the spec (registry name, absolute path, git address, tarball), refuses what pnpm or the registry would refuse, and asks for name/version/description/bundle declaration *before* installing; a package without a bundle patch is refused here, before pnpm runs (line 13).
- Data flow: `installBundle` snapshots `package.json` and `pnpm-lock.yaml` before pnpm runs and puts them back when pnpm fails, when the run is cancelled, or when the added package declares no bundle patch (line 15).
- Non-obvious design decisions: this **reverses** the manager's general "retain partial changes" decision, for installations only — "an installation that did not produce a usable bundle must not leave a dependency the page cannot show" (line 15). `classifyInstallFailure` reads how the run ended and what pnpm printed into `packageResult.kind`; a run the manager terminated is classified `timeout` *whatever exit status the signal left behind*, so installation restores the files and removal reports failure instead of reading it as a success (line 17).
- Edge cases / failure handling: GitHub connection failures get their own short budget — a read-only `git ls-remote` with credential helpers and prompts disabled, default `githubConnectionTimeoutMs` of 5000 ms — so authentication cannot consume the connection budget, and only network failures and timeouts prevent pnpm from starting (line 19). Cancellation is the manager's, not the signal's: `cancelInstall` answers only after pnpm exited and the files are back (line 21).
- Surprising: pnpm 11 leaves dependency scripts undecided; the failed-run surface lists them and offers "allow these scripts and retry", and the store re-runs with the same checked subject and an `approvedBuilds` — which is why `pnpm-workspace.yaml` is *not* among the restored files (line 27).

### .agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.zh.md
- Purpose: Chinese translation of the guided plugin installation note; six hashed sections.
- Key abstractions: same inspect-before-install and failure-kind classification.
- Data flow: same — snapshot/restore of `package.json` + `pnpm-lock.yaml` on failure or cancellation.
- Non-obvious design decisions: same — the deliberate reversal of the "retain partial changes" rule for installs only (zh line 15); a manager-terminated run is always `timeout`.
- Edge cases / failure handling: same — the 5 s `git ls-remote` budget with credential helpers disabled; cancellation answered only after cleanup.
- Surprising: same — the `approvedBuilds` retry path and why `pnpm-workspace.yaml` is excluded from restoration (zh line 27).

### .agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.i18n.yaml
- Purpose: pairing record for the Creator-mode persistent plugin note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-creator-mode-installs-persistent-plugin-bundles`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key captures "Creator mode installs persistent plugin bundles" — the mechanism, not the topic.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note describes a *second* plugin lifecycle being folded into the first; the i18n record shows the repo's preference for a single record per note.

### .agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md
- Purpose: let an agent install capabilities and use them in the same conversation, without inventing a second plugin lifecycle.
- Key abstractions: Creator mode enables the existing `plugin_manager` tool; agents author packages and Loader YAML patches as workspace files and install them through `install_bundle` (line 13).
- Data flow: profile locking, package installation, enablement and HMR stay owned by the existing manager.
- Non-obvious design decisions: the **entire** management tool requires `danger-full-access` or approval for one call, because "profile changes can load code with host permissions and affect other sessions"; each execution, including inventory reads, uses the shared sandbox escalation helper and approval service before touching the manager (line 13). A grant does not change session permissions, but its profile changes persist — so shell-equivalent Host access is explicit without permanently elevating the session.
- Edge cases / failure handling: under lower sandbox modes `ask` requests approval and `never` denies; a full-access session needs no extra approval. Installed package *replacement* requires restart while HMR activates new bundles on live profiles (line 29).
- Surprising: the model sees only two read-only Cordis inspection tools — the generated-code define/run/stop/undefine and dynamic self-inspection tool APIs are absent, superseding only the model-facing mutation workflow of the self-referential toolset reference (line 15); historical Cordis sessions declare `retired-tools` coverage at their exact format version, even when it equals the current writer.

### .agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.zh.md
- Purpose: Chinese translation of the Creator-mode persistent plugin note; five hashed sections.
- Key abstractions: same `plugin_manager` tool and `install_bundle` path.
- Data flow: same — manager keeps locking, install, enablement, HMR.
- Non-obvious design decisions: same — full-access-or-approval for every execution including reads; a grant does not change session permissions but its profile changes persist (zh line 13).
- Edge cases / failure handling: same — `ask`/`never` semantics under lower sandbox modes; package replacement needs restart.
- Surprising: same — the model-facing generated-code tool APIs are removed; only two read-only inspection tools remain.

### .agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.i18n.yaml
- Purpose: pairing record for the experimental voice input note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-experimental-voice-input-with-explicit-recognition-providers`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the full title with the "explicit recognition providers" clause.
- Edge cases / failure handling: digest mismatch only.
- Surprising: "explicit providers" in the title is the whole safety claim — no fallback is allowed.

### .agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.md
- Purpose: optional, default-off local dictation that never silently changes where audio is processed.
- Key abstractions: five packages under `packages/experimental/` compose one optional bundle; Service Definition, SenseVoice Provider and Remote Consumer are separate (line 13).
- Data flow: provider ids select exact registrations; resolution captures an instance and deregistration closes admission, cancels and joins accepted work. Recordings and transcripts stay transient until the user submits ordinary text — recognition does not start an agent turn or create an audio Session event (line 17).
- Non-obvious design decisions: **there is no provider fallback**: a local failure cannot authorize uploading speech to a cloud service (line 15). Readiness follows *disk contents* rather than a Provider instance's lifetime, so a cancelled active inference loses the warm worker and the next request reloads it (line 19). Preparation is owned by the Host, independent of the view that started it, via an ordered step list that survives view remounts.
- Edge cases / failure handling: changed drafts retain the recognized text for explicit insertion instead of replacing later edits; session changes and plugin disposal invalidate late results; capture failures notify the current recording activity immediately, independent of resource-close latency; cancellation, failure and plugin withdrawal join one release promise, so ownership lasts until the AudioContext closes (line 17).
- Surprising: the model is told nothing about the recording; only submitted text reaches the model (line 31). INT8 is the default to reduce download and storage cost, and public English/bilingual samples show word differences between precisions, so quantization is *not* treated as accuracy-equivalent (line 35).

### .agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.zh.md
- Purpose: Chinese translation of the experimental voice input note; five hashed sections.
- Key abstractions: same five-package optional bundle split.
- Data flow: same — transient recordings, no agent turn, no audio Session event.
- Non-obvious design decisions: same — no provider fallback; readiness follows disk contents.
- Edge cases / failure handling: same — one shared release promise; late results invalidated on session change or disposal.
- Surprising: same — INT8 default with a stated non-equivalence to FP32.

### .agents/notes/implemented/architecture/2026-09-16-host-schedule-storage.i18n.yaml
- Purpose: pairing record for the Host-owned scheduled messages note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-host-owned-scheduled-messages`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: same standard five-heading shape.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's subject is *storage authority*; the record is a second, smaller authority for the text.

### .agents/notes/implemented/architecture/2026-09-16-host-schedule-storage.md
- Purpose: make scheduled messages survive restart without loading every Session, and make the management record survive delivery.
- Key abstractions: the Schedule package owns one Host storage domain holding each task's original Session id, reminder record, `active`/`inactive` status, latest delivery receipt and saved delivery history; the domain is authoritative for retained tasks (line 13).
- Data flow: the Host scheduler restores timers only for active tasks; a due task uses the Session controller's existing resolution operation and queues an ordinary follow-up in the original Session. A plugin-sourced `followup()` synchronously appends to the Session inbox, and a successful Session flush acknowledges durable delivery (line 19).
- Non-obvious design decisions: the task domain declares the **whole-unit layout**, so the JSON backend rejects an unreadable file, malformed document, unsupported version or invalid task as a *complete load failure* rather than interpreting it as deletion — and failed recovery leaves `schedule.json` unchanged (line 15). Dispatch admission is separate from initialization: an ancestor can close Agent admission after a task mutation commits but before runtime cleanup starts, and that refusal is logged without automatic retry and does not turn the persisted mutation into a failed management result.
- Edge cases / failure handling: stored records lacking status normalize to `active` without scanning or recreating historical Sessions; the Host record decoder requires a stored `title` that is non-empty after trimming, already trimmed and at most 120 characters, and the strict task schema rejects the whole domain open rather than dropping such a task — while the *historical* change decoder tolerates an absent `title` so an already-written Session log stays readable (line 17).
- Surprising: delivery history is in *append order, not wall-clock order*, "so a clock rollback does not reverse the order of acknowledged deliveries" (line 19); Every/Daily/Weekly/Cron all use one recurring framing and one follow-up message per due occasion, sharing its real message id.

### .agents/notes/implemented/architecture/2026-09-16-host-schedule-storage.zh.md
- Purpose: Chinese translation of the Host-owned scheduled messages note; five hashed sections.
- Key abstractions: same version-1 whole-unit task domain.
- Data flow: same — timers restored for active tasks only; delivery via the Session controller and inbox flush.
- Non-obvious design decisions: same — whole-unit load failure semantics, dispatch admission separate from initialization.
- Edge cases / failure handling: same — strict `title` rules for the Host decoder, lenient for the historical decoder.
- Surprising: same — append-order history immune to clock rollback; the Weekday set is stored canonicalised and validated on decode.

### .agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.i18n.yaml
- Purpose: pairing record for the user-terminal permissions note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-user-terminal-permissions`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key uses the bare concept name.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is a *permission* decision, and the record keeps a second rendering of that permission decision in step.

### .agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.md
- Purpose: let a human run commands themselves without widening the Agent's sandbox, and without a retained shell blocking later mode changes.
- Key abstractions: the Web sidebar terminal runs directly through the Session's subprocess provider with the execution environment's system-user permissions; it neither confines the shell through the Agent sandbox nor requests Agent approval (line 13).
- Data flow: Session identity owns access, process cleanup and the initial directory; sandbox policy supplies only the configured directory fallback when the Session has no cwd.
- Non-obvious design decisions: sharing the Agent's sandbox mode would force a user to widen Agent access for manual work, and retaining an interactive shell prevents later mode changes because its process confinement cannot follow a new Session setting (line 9). Agent permission changes leave user terminals running; Agent-owned shell and terminal tools keep their own sandbox enforcement (line 15).
- Edge cases / failure handling: operating-system permissions, container isolation and the provider's credential-environment scrubbing still apply; user terminal input and output create no model input and no Session events (line 15).
- Surprising: the note cites OpenCode's `packages/core/src/pty.ts` as *adjacent evidence* that an interactive terminal should create a PTY directly with the selected shell and working directory (line 17).

### .agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.zh.md
- Purpose: Chinese translation of the user-terminal permissions note; five hashed sections.
- Key abstractions: same system-user terminal outside the Agent sandbox.
- Data flow: same — Session owns access/cleanup/initial dir; sandbox only supplies a fallback dir.
- Non-obvious design decisions: same — a retained shell would block later mode changes.
- Edge cases / failure handling: same — OS permissions, container isolation and credential scrubbing still apply; no model input, no Session events.
- Surprising: same — the OpenCode PTY citation.

### .agents/notes/implemented/architecture/2026-09-17-account-provider-signout.i18n.yaml
- Purpose: pairing record for the account provider / sign-out cancellation note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-account-provider-and-active-request-cancellation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the cancellation behaviour, not "sign-out".
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's real subject — cancelling in-flight work by *reading a logged value* rather than maintaining a second field — is a generalisable pattern.

### .agents/notes/implemented/architecture/2026-09-17-account-provider-signout.md
- Purpose: sign out must stop account-dependent work without misclassifying requests whose settings changed mid-flight.
- Key abstractions: `deepseek-official` and `deepseek-account` are independent routes sharing the DeepSeek protocol implementation; each adapter has exactly one credential resolver and authentication header mode, and neither route falls back to the other credential (line 13).
- Data flow: account cancellation reads each running Agent's latest `Session.requestContext()` instead of maintaining another provider field; that logged value survives through tools and retries and follows the next bound request (line 15).
- Non-obvious design decisions: idle Agents are excluded; during a new turn's *first preparation* the context can still name the previous turn's account route, so sign-out can also interrupt an API-key turn that has not bound its new request yet (line 15). Cancellation preserves queued input without waking it automatically.
- Edge cases / failure handling: a missing account credential rejects a first request without a previous context *before transport*; each registered child is classified independently, and parent-owned cancellation still applies to children whose lifetime is attached to a cancelled parent (line 17).
- Surprising: the recorded hook reason produces a localized conversation notice *without changing durable event types* (line 25).

### .agents/notes/implemented/architecture/2026-09-17-account-provider-signout.zh.md
- Purpose: Chinese translation of the account provider / sign-out note; five hashed sections.
- Key abstractions: same two independent routes with separate credential resolvers.
- Data flow: same — cancellation reads the latest `Session.requestContext()`.
- Non-obvious design decisions: same — no second provider field, no module-global map.
- Edge cases / failure handling: same — first preparation can still name the previous route; pre-transport rejection.
- Surprising: same — the localized notice without a durable event change.

### .agents/notes/implemented/architecture/2026-09-17-developer-session-changes.i18n.yaml
- Purpose: pairing record for the developer message note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-developer-messages-for-incremental-session-changes`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *mechanism* ("Developer messages for incremental session changes").
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note formalises a durable record type that the i18n file itself embodies — a machine-checkable statement of a change.

### .agents/notes/implemented/architecture/2026-09-17-developer-session-changes.md
- Purpose: record tool-set changes as durable, ordered, structured records so providers can keep their cached conversation prefix while tools change.
- Key abstractions: `DeveloperMessage` records admitted model-visible session changes in conversation order; additions store only `toolName`, and the containing event's `headerSeq` selects an earlier full `request/header` with exactly one schema for each added name — **one event binds all its additions to one header revision** (line 13).
- Data flow: the loop compares names against the preceding header and emits one `developer/message` with additions and removals under the `tool-registry` source; the adapter translates the projected updates into provider-specific blocks.
- Non-obvious design decisions: schema duplication is avoided by *reference* — a historical reference preserves same-name replacement identity, whereas binding to the latest header or registry would reinterpret older additions (line 29). Combining additions from different header revisions requires separate events, and empty developer content retains its surface position without adding a model message or shadowing the protected system head (line 15).
- Edge cases / failure handling: native readers and Session admission reject missing, forward, unknown, non-header and ambiguous schema references, incomplete referenced definitions, and retired inline definitions, while preserving unrelated JSON fields; forks retain the referenced prefix and compaction does not delete header events (line 15).
- Surprising: `ToolAdditionBlock.tool` is declared as optional `never` with `@persistenceReserved` — the schema *history* records the rejected field, so permitting a value later is a value-type change requiring a format bump, while unrelated optional metadata stays additive (line 17). `deferLoading` is a separate fact from dynamic addition, so a predeclared deferred tool needs no fabricated addition record.

### .agents/notes/implemented/architecture/2026-09-17-developer-session-changes.zh.md
- Purpose: Chinese translation of the developer message note; five hashed sections.
- Key abstractions: same `headerSeq`-referencing addition records.
- Data flow: same — one developer message per header delta.
- Non-obvious design decisions: same — reference instead of duplicate; one header revision per event.
- Edge cases / failure handling: same — ambiguous/forward/unknown references rejected; compaction keeps header events.
- Surprising: same — `@persistenceReserved` on the forbidden `tool` field.

### .agents/notes/implemented/architecture/2026-09-17-experimental-cua-object-api.i18n.yaml
- Purpose: pairing record for the native CUA object API note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-native-cua-objects-independent-of-evaluator-ownership`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key captures the independence claim.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the title itself is the design principle, and the record preserves it in both languages.

### .agents/notes/implemented/architecture/2026-09-17-experimental-cua-object-api.md
- Purpose: give computer-use programs consistent app/window objects without binding them to a CUA-specific interpreter.
- Key abstractions: the shared `cua` library owns application/window objects, consent and logged dispatch; `cua-macos` owns the Swift helper, its build and its local connection lifecycle; providers pass a prepared executable and a connection factory to the shared installer (line 13).
- Data flow: the facade accepts an operation dispatcher, and its tool adapter resolves the current tool binding *for each operation*, preserving normal authorization, logging and image admission (line 17).
- Non-obvious design decisions: the execution host owns variable persistence and completion serialization — CUA defines no persistence directive, worker or `run_code` replacement (line 17). App handles bind process identity *and kernel start time*, so replacing the process or helper never revives old handles (line 19). AX snapshots are scoped to an app and optional window, so independent window observations remain usable.
- Edge cases / failure handling: clipboard paste is distinct from Unicode key input, because Return and Tab can trigger actions instead of inserting text; after successful command dispatch, `pasteReadTimeoutMs` (default 1000 ms) bounds waiting for a data request, and expiry returns `PASTE_NOT_CONSUMED`, closes the data provider against late delivery, and restores the clipboard only while still owned (line 23).
- Surprising: the failure reports *no read within that interval*; it does not prove the application will never process its queued Paste command, so a delayed command may read the restored clipboard — callers must inspect the target and never retry automatically (line 23). The screenshot result carries its already-computed `bytes`/`mimeType`/`pixelWidth`/`pixelHeight`/`windowId` so callers need not guess the encoding.

### .agents/notes/implemented/architecture/2026-09-17-experimental-cua-object-api.zh.md
- Purpose: Chinese translation of the native CUA object API note; five hashed sections.
- Key abstractions: same `cua` library / `cua-macos` split with a JSON operation protocol.
- Data flow: same — per-operation tool binding resolution.
- Non-obvious design decisions: same — no persistence directive in CUA; handles bind process identity plus kernel start time.
- Edge cases / failure handling: same — `PASTE_NOT_CONSUMED` after `pasteReadTimeoutMs`, no automatic retry.
- Surprising: same — the returned screenshot describes its actual bytes so no re-encoding is needed.

### .agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.i18n.yaml
- Purpose: pairing record for the mandatory native V4 validation note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-mandatory-native-v4-relationship-validation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *mandatory* nature of the check.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note argues that a *local*-valid event can still be globally contradictory — the same class of bug the i18n hash check hunts.

### .agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.md
- Purpose: reject a Session whose events contradict each other, even when each event is locally valid.
- Key abstractions: the V4 format restorer and the current JSONL scanner share one mandatory cross-event relationship pass before exposing a restored artifact or storage handle (line 15).
- Data flow: the pass checks turn and step order, advertised tool calls and settlements, PTC parentage and settlement identity, retry chains and request providers, human-message title citations, command completion references, compaction ownership and current spans, and the protected system head.
- Non-obvious design decisions: the installed event set controls semantic interpretation, including compaction prepasses and title references; unknown ignorable records retain their payloads and original positions, but *known records remain validated even when marked ignorable* (line 15). The check reads native event fields without altering artifacts or projecting them into a historical format. JSON argument comparisons inspect **own properties** in both Node and the worker, so inherited prototype members cannot satisfy recorded fields.
- Edge cases / failure handling: an unfinished tail may retain an open turn, step, tool call or compaction, and a closing event must settle what it closes; an inherited unfinished compaction ends at its `session/end-seed` marker and does not constrain the child's lifecycle (line 17). Repair message identities retain their historical numeric suffix after earlier migrations change sequence coordinates.
- Surprising: `EpochHeader.system` explicitly reserves the retired key as `system?: never` with `@persistenceReserved` — the catalog keeps its empty value set so permitting a value later is a change to a *forbidden* field, not an ordinary optional-field addition (line 23).

### .agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.zh.md
- Purpose: Chinese translation of the mandatory native V4 validation note; five hashed sections.
- Key abstractions: same one shared cross-event relationship pass.
- Data flow: same — checks turn/step order, tool settlement, PTC parentage, compaction ownership, system head.
- Non-obvious design decisions: same — own-property comparison, known records validated even when ignorable.
- Edge cases / failure handling: same — partial tails allowed but closers must settle them.
- Surprising: same — `@persistenceReserved` on the retired `system` key.

### .agents/notes/implemented/architecture/2026-09-17-persistence-attribution-policy.i18n.yaml
- Purpose: pairing record for the recorded user-source attribution note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-recorded-user-source-attribution-compatibility`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *compatibility* concept.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's own rule — a qualified addition still changes fingerprints — is the same "record the change, then classify it" shape as the digests.

### .agents/notes/implemented/architecture/2026-09-17-persistence-attribution-policy.md
- Purpose: let a producer add a message-source attribution kind without forcing a Session-format bump.
- Key abstractions: the core-owned user-message source property binds the recorded compatibility policy; a producer separately qualifies its literal wire kind as *attribution-only*, and both saved schemas must carry compatible policy state before a qualified addition receives a same-version classification (line 13).
- Data flow: the tmux-context producer qualifies its location attribution; its own projection uses the kind to avoid repeated injection, while readers *without* that producer retain the recorded content and every source JSON property (line 15).
- Non-obvious design decisions: `RequestMessage` accepts a durable `Message` **or** a user-only `RequestUserInput` with content and no `id`/`source`; Session writes, Agent delivery and persisted title-request inputs still require durable messages, while Auto Review's outer prompt and the compaction summarizer's final instruction use request-only inputs (line 17). The qualification promises *reader independence*; it does not forbid producer-local duplicate suppression.
- Edge cases / failure handling: missing policy, unqualified additions, removals and changes to existing semantic groups all retain strict classification; fixed system, model and tool source fields do not participate (line 13).
- Surprising: the finalized V4 acknowledgement records the user-source policy and removes the two request-only source registrations — "This does not grant a general exception for removing accepted variants" (line 19).

### .agents/notes/implemented/architecture/2026-09-17-persistence-attribution-policy.zh.md
- Purpose: Chinese translation of the recorded user-source attribution note; five hashed sections.
- Key abstractions: same attribution-only qualification mechanism.
- Data flow: same — producer-local suppression allowed, reader independence promised.
- Non-obvious design decisions: same — request-only `RequestUserInput` for detached prompts, durable messages for writes.
- Edge cases / failure handling: same — unqualified changes keep strict classification.
- Surprising: same — the acknowledgement does not create a general removal exception.

### .agents/notes/implemented/architecture/2026-09-17-process-local-blank-sessions.i18n.yaml
- Purpose: pairing record for the blank-Session writer acquisition note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-writer-acquisition-for-blank-session-reuse`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *mechanism* (writer acquisition) rather than the topic.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the record is a good example of the note's own thesis — identity is carried by a reference to the thing that matters (the writer), not by a path.

### .agents/notes/implemented/architecture/2026-09-17-process-local-blank-sessions.md
- Purpose: make two Hosts sharing Session storage stop selecting the same blank Session.
- Key abstractions: the Session catalog includes persisted blanks; startup restoration selects the saved blank, ordinary Workspace navigation selects the first eligible unarchived member in catalog order (line 13).
- Data flow: explicit-id `session.create` names that Session; the Host resumes it and acquires its writer *before* opening history, and creates a new Session when another owner holds the writer.
- Non-obvious design decisions: the Agent retains the acquired handle throughout its lifetime — "Checking ownership and releasing a probe lock would leave a race before resume" (line 15). **No PID or process identity enters persisted data or the Remote schema** (line 15): kernel writer ownership already arbitrates acquisition, and PID reuse plus stale creator records add no authority (line 27).
- Edge cases / failure handling: separate Hosts create distinct blanks while existing writers remain held; a held selected blank causes fresh creation even when another blank is free, and navigation does not search for another candidate; a non-contention acquisition failure aborts the navigation, while a hero Workspace pick or explicit draft preparation reports it as a notice and startup restoration only to the console (line 31).
- Surprising: a blank means no `turn/start`, not no events — a live Agent can still append command and configuration events, so releasing its lock permits competing writers (line 23).

### .agents/notes/implemented/architecture/2026-09-17-process-local-blank-sessions.zh.md
- Purpose: Chinese translation of the blank-Session writer acquisition note; five hashed sections.
- Key abstractions: same persisted-blank catalog and writer acquisition.
- Data flow: same — acquire the writer before opening history.
- Non-obvious design decisions: same — the probe-lock race, and no PID in persisted data.
- Edge cases / failure handling: same — held candidate forces fresh creation; failure surfaces differently per entry point.
- Surprising: same — "Blank 表示没有 `turn/start`，并不表示没有事件".

### .agents/notes/implemented/architecture/2026-09-17-workspace-file-binary-transfer.i18n.yaml
- Purpose: pairing record for the binary workspace file transfer note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-binary-workspace-file-transfer`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: same standard shape.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note replaces base64 with multipart, and the record itself replaces prose comparison with a digest.

### .agents/notes/implemented/architecture/2026-09-17-workspace-file-binary-transfer.md
- Purpose: serve real file bytes to the browser without base64 bloat or a second dispatch route.
- Key abstractions: the workspace file service exposes one binary `readBytes` Remote whose required options object independently selects a byte `range` and a `baseFile` (line 13); Typert recursively recognizes `Uint8Array` in unary result types, and generated codecs provide `encode()` for byte-bearing subtrees and `decode()` to validate without iterating, copying or freezing byte payloads.
- Data flow: Gateway executes the generated encoder, keeps strict JSON values unchanged, and returns JSON-compatible metadata plus result-relative byte attachments to Connection; Connection owns standard `FormData` parts and preserves the RPC envelope and correlation id in JSON metadata, without inspecting business values (line 15).
- Non-obvious design decisions: one options object rather than separate `readAll`/range/related methods, because range and base-file are *orthogonal* choices; a whole-result binary marker or a reserved `data` field would couple the transport to one business result (line 21); `FormData` delegates framing and length validation to the platform at the cost of Blob copies, whereas a custom metadata prefix would need owned framing and would constrain long Unicode paths (line 23).
- Edge cases / failure handling: on HTTP disconnect the bridge aborts the request signal and drains materialized response chunks *without writing to the socket* — cancelling Node multipart bodies can race their producer and cause an unhandled `ERR_INVALID_STATE` rejection (line 27). Binary arguments, events and stream items remain unsupported, and recursive types require acyclic runtime values.
- Surprising: byte ranges retain only the requested bytes under `maxBytes`, independent of `maxFileBytes`; this is not a streaming preview or zero-copy optimisation (line 27).

### .agents/notes/implemented/architecture/2026-09-17-workspace-file-binary-transfer.zh.md
- Purpose: Chinese translation of the binary workspace file transfer note; five hashed sections.
- Key abstractions: same single `readBytes` Remote with orthogonal `range`/`baseFile`.
- Data flow: same — generated encoder → attachments → FormData parts, envelope preserved in JSON metadata.
- Non-obvious design decisions: same — one options object over method proliferation; FormData over a custom prefix.
- Edge cases / failure handling: same — the `ERR_INVALID_STATE` drain hazard on disconnect.
- Surprising: same — not a streaming or zero-copy path.

### .agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.i18n.yaml
- Purpose: pairing record for the declarative Agent presets note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-declarative-agent-presets-and-retained-revisions`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the "retained revisions" half.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's central idea — keep old revisions alive while new ones are edited — is exactly what a hash record does for a note.

### .agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md
- Purpose: express agent presets as ordinary Cordis configuration with a managed lifetime, instead of a parallel directory format.
- Key abstractions: `dsh-agent-preset-registry` owns selection and runtime revisions; `dsh-agent-preset` declares an identity, display metadata and child plugin list in ordinary Cordis YAML (line 13).
- Data flow: definitions activate eagerly; activation failures remain in the roster and reject new bindings *without preventing the application from starting* (line 13). Agents link their own scopes to the selected revision and children inherit their parent's exact revision.
- Non-obvious design decisions: the registry owns each revision's scope and Loader tree, so disposing a definition during a save cannot revoke tools from running Agents — retained revisions keep references until disposal and the final release disposes a retired tree (line 15). A *user override replaces the entire child list* rather than merging future builtin changes (line 33).
- Edge cases / failure handling: revision checks and profile locking prevent overwriting concurrent saves, and validation rejects a higher-priority override that would defeat the edit; persistence and activation outcomes are reported separately (line 17). Tool writes require approval or full access because configuration executes in the Host.
- Surprising: eager activation is chosen over lazy because it exposes failures before selection and avoids pending-first-use state (line 27); a session records only the preset *identity*, so a restart resolves it against current configuration and rejects a missing definition, while reusing a blank Session for a new conversation does not resolve it (line 19).

### .agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.zh.md
- Purpose: Chinese translation of the declarative Agent presets note; six hashed sections.
- Key abstractions: same registry-owned revisions with eager activation.
- Data flow: same — children inherit the parent's exact revision; failures stay in the roster.
- Non-obvious design decisions: same — registry ownership keeps running Agents' tools alive during a save.
- Edge cases / failure handling: same — concurrent-save revision checks; separate persistence/activation outcomes.
- Surprising: same — a user override replaces the whole child list.

### .agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.i18n.yaml
- Purpose: pairing record for the plugin install registries note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-plugin-install-registries`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key uses the plural topic name.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's whole subject — a *plan* of registries, ordered by who is asked first — and the record's subject — a plan of sections, hashed in order — have the same shape.

### .agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md
- Purpose: make package installation work on networks that cannot reach `registry.npmjs.org`, without a private registry ever falling through to a public one.
- Key abstractions: `PluginManager.Config` gains `registry` (asked first; absent = `null`, i.e. pnpm's own configuration) and `fallbackRegistries` (default npmmirror); `registryPlan` resolves one operation's plan: requested registry, else the configured first, then the rest (line 13).
- Data flow: pnpm's own registry is *public only once read as such* — the manager reads it via `pnpm config get registry` in the profile directory before each plan, and `null` joins the configured set only while that is npm's own or a configured fallback; otherwise it is asked alone (line 15).
- Non-obvious design decisions: a requested registry outside the configured set is asked alone, because "a private registry never falls through to a public one, where a name that exists on both would install someone else's package" (line 13) — dependency confusion as a first-class concern. `attributeFailure` lays `network`, `timeout`, `not-found` and `no-matching-version` at the registry (a mirror lags the registry it copies) but stops at once on every other kind; a git spec or tarball carries the host pnpm fetches it from, which no registry stands in for (line 17).
- Edge cases / failure handling: reading pnpm's registry **fails closed** — an unreadable answer leaves `null` alone; a machine whose pnpm cannot be read gets no fallback (line 41). The check runs `pnpm view` with `--registry` and `--config.fetch-retries=0` so a dead registry is reported within `inspectTimeoutMs`; pnpm prints a `--json` refusal as `{ error: { code, message } }` on *stdout* with nothing on stderr, so the classifier reads both (line 17).
- Surprising: the install deliberately keeps pnpm's *own* retry settings, because the install downloads tarballs and a shorter timeout would cut slow-but-working downloads; and `--config.fetch-timeout` on the command line crashes pnpm 11.8 because it is read as a string (line 19).

### .agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.zh.md
- Purpose: Chinese translation of the plugin install registries note; six hashed sections.
- Key abstractions: same `registry` + `fallbackRegistries` plan model.
- Data flow: same — read pnpm's registry before each plan; `null` joins the set only if public.
- Non-obvious design decisions: same — dependency-confusion prevention; failure attribution by kind.
- Edge cases / failure handling: same — fail-closed reading; stdout refusal parsing.
- Surprising: same — the pnpm 11.8 `--config.fetch-timeout` string crash and the deliberate retention of pnpm's retry settings.

### .agents/notes/implemented/architecture/2026-09-18-volatile-config-references.i18n.yaml
- Purpose: pairing record for the volatile configuration references note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-volatile-configuration-references`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key uses "configuration" spelled out.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's mechanism — a *reference* to a value that survives a config change — is what the digest pair is: a reference that survives an edit, provided the other side is brought along.

### .agents/notes/implemented/architecture/2026-09-18-volatile-config-references.md
- Purpose: change a live setting without tearing down the plugin that reads it.
- Key abstractions: Schemastery declares live fields with `.volatile()`, preserving node types and form metadata while returning stable references to immutable snapshots; Cosmokit owns the shared protocol; general comparison treats two volatile references as equal (line 13).
- Data flow: Loader computes raw config differences using schema-declared volatile paths; when the raw diff reports no ordinary change but the raw config differs, Loader parses and validates the candidate through the fiber's `internal/config` hook, compares ordinary effective values, commits references when those values still match, and notifies the owning fiber — *every* update path (profile reconciliation, HMR Include refreshes, direct `entry.update()`) reaches this through `Entry.update` (line 13).
- Non-obvious design decisions: only volatile changes preserve the instance; ordinary-field changes use the existing remount lifecycle and do not update old references (line 15). An instance-local `loader/volatile-update` event reports paths *after* the complete candidate is validated and all references are committed, and it uses ordinary `emit` — listener completion is not a configuration commit condition.
- Edge cases / failure handling: references can be retained, but values may be captured for one operation only; missing optional values retain a readable reference; invalid edits stay in raw config but leave running references unchanged until a later activation (line 31). Listener failures during notification are logged and do not fail the update.
- Surprising: schema metadata keeps comparison independent of parsing — the diff does not execute expressions, validators or config hooks — and object nodes compare missing or null values using their declared defaults, avoiding remounts for equivalent object defaults; strict comparison treats class instances other than URL, Date and RegExp by identity, so an ordinary transform that builds a fresh instance per parse always remounts (line 31).

### .agents/notes/implemented/architecture/2026-09-18-volatile-config-references.zh.md
- Purpose: Chinese translation of the volatile configuration references note; five hashed sections.
- Key abstractions: same `.volatile()` declaration and stable-reference-to-immutable-snapshot model.
- Data flow: same — all update paths converge on `Entry.update`.
- Non-obvious design decisions: same — only volatile changes preserve the instance.
- Edge cases / failure handling: same — invalid edits keep raw config but not live references; listener failures are logged.
- Surprising: same — identity-based comparison for non-URL/Date/RegExp class instances forces remounts.

### .agents/notes/implemented/architecture/2026-09-19-concrete-web-bind-address.i18n.yaml
- Purpose: pairing record for the concrete Web bind address note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-bind-one-concrete-web-address`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is an imperative phrase.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's title is a constraint on the operator, and the record is a constraint on the translator — both are "state one thing, exactly".

### .agents/notes/implemented/architecture/2026-09-19-concrete-web-bind-address.md
- Purpose: stop the Web listener from exposing every interface of the machine.
- Key abstractions: `webserver.config.host` accepts one concrete IPv4 or IPv6 address literal, loopback by default; the unspecified address in every spelling (`0.0.0.0`, `::`, `::ffff:0.0.0.0` and their expansions) is rejected at config load, and the shipped `dsh web` command refuses the same spellings before any consumer activates (line 13).
- Data flow: the browser Host/Origin fence accepts the listener's own bind IP literal as `Host` on any port, independently of `trustedHosts` and ignoring the zone; Connection reads the invocation authorities directly from the `webStartup` provider, and the `webRuntime` service and LAN sampling no longer exist (line 15).
- Non-obvious design decisions: LAN sampling into `trustedHosts` is rejected because it grants authorities for interfaces the operator never named and mixes *inferred reachability* into *configured trust* (line 21); keeping `0.0.0.0` with a warning is rejected because binding every interface exposes remote code execution to every network the machine joins (line 25).
- Edge cases / failure handling: the advertised URL uses IPv4 for mapped loopback binds, brackets other IPv6 binds, drops a loopback zone, and requires `--public-url` for a zoned non-loopback bind because a zone cannot appear in a URL; a non-loopback bind serves plain HTTP and warns at startup even when an HTTPS `--public-url` fronts it (line 17).
- Surprising: `web-runtime` is a *required* startup entry, so a bind failure fails startup instead of leaving a silent listener-less process (line 17); the bind IP is accepted on any port, since a port-less `trustedHosts` entry already matches any port and a proxy on the same address may listen elsewhere (line 23).

### .agents/notes/implemented/architecture/2026-09-19-concrete-web-bind-address.zh.md
- Purpose: Chinese translation of the concrete Web bind address note; six hashed sections.
- Key abstractions: same single-literal `host` with wildcard spellings rejected.
- Data flow: same — bind IP accepted as Host on any port; `webRuntime` and LAN sampling removed.
- Non-obvious design decisions: same — inferred reachability vs configured trust.
- Edge cases / failure handling: same — zoned non-loopback requires `--public-url`; required `web-runtime` entry fails startup on bind failure.
- Surprising: same — bind IP accepted on any port.

### .agents/notes/implemented/architecture/2026-09-19-profile-owned-live-configuration.i18n.yaml
- Purpose: pairing record for the profile-owned live configuration note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-keep-live-configuration-in-the-owning-profile`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the ownership principle.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note argues that "one owner" beats "two stores" — the pairing record is an instance of that preference.

### .agents/notes/implemented/architecture/2026-09-19-profile-owned-live-configuration.md
- Purpose: make the Loader's resolved Config the single owner of configuration, with Settings reduced to a form generator.
- Key abstractions: a plugin declares every configurable value in its Cordis Config; fields that can change without remounting use `.volatile()`; Settings enumerates those fields for forms and never supplies business configuration (line 13).
- Data flow: the profile editor writes `cordis.patch.yml` and applies the ordinary Loader reconciliation path; form writes target the active profile, while home patches and command-line overlays remain higher-priority deployment inputs, and an edit they would shadow fails *before* persistence (line 15).
- Non-obvious design decisions: a Cordis config patch replaces a *complete* entry config, so an edit stores the entry's whole composed config (ordinary fields as composed at write time plus every volatile field) — which means later bundle changes to those fields do not reach that profile until the override is removed (line 17). Narrowing a write to the edited fields would need merge semantics for patch `config`, which Include does not provide.
- Edge cases / failure handling: two plugin instances are addressed by their distinct profile entry ids; nested Includes retain independent ownership and are not writable through the profile form (line 15). The removed `$DSH_HOME/settings.yaml` is imported once into the active profile after the Loader has settled every entry, and the file is renamed to `settings.yaml.imported` *before* the first write so the import never repeats; a rejected section is logged and stays in the renamed file (line 19).
- Surprising: in the shipped bundles this pinning freezes `permission.presets` after a default-preset change, `agent-presets` after a preset choice, `agent-loop.agents` after a parallelism edit, and `web-search-deepseek.apiKeyEnv` after a Web Search edit — and the client marks *every* volatile field of such a row as overridden, not only the edited one (line 17).

### .agents/notes/implemented/architecture/2026-09-19-profile-owned-live-configuration.zh.md
- Purpose: Chinese translation of the profile-owned live configuration note; five hashed sections.
- Key abstractions: same single-owner Config with `.volatile()` fields.
- Data flow: same — profile editor writes `cordis.patch.yml` through the ordinary reconciliation path.
- Non-obvious design decisions: same — complete-entry-config replacement pins unrelated fields.
- Edge cases / failure handling: same — one-time settings.yaml import with rename-before-write.
- Surprising: same — the four shipped pins and the "every volatile field is overridden" rule.

### .agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.i18n.yaml
- Purpose: pairing record for the profile module-resolution note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-resolve-profile-modules-along-the-ancestor-chain-with-an-interception-layer`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the whole rule in one phrase.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's demand — "a developer must be able to restate the resolution rule in one sentence" — and the record's key is exactly that one sentence.

### .agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md
- Purpose: make a profile's plugins resolve the *running* dsh packages, not disk copies, while keeping Node's own resolution rules intact.
- Key abstractions: ordinary module requests retain Node's ancestor `node_modules` order; inside a profile, runtime-resolution entries occupy their package positions at `$DSH_HOME/profiles/node_modules` (line 15). The chain is numbered ① plugin-private, ② profile-installed, ③ the interception layer, ④ harness home, ⑤ filesystem root (lines 27-33).
- Data flow: for a linked directory outside the tree, each candidate `D/node_modules` applies one rule — a name declared in `D/package.json` under `peerDependencies` *and* present in the runtime resolution uses the runtime package at that position; otherwise Node tries the physical package there. A nearer candidate precedes a peer declaration farther up.
- Non-obvious design decisions: explicit CommonJS `paths` always bypass interception (line 15); the interception layer does not read, write or delete any disk link, and legacy leftover symlinks are simply treated as ordinary filesystem content (line 47). The rule exists so it "can be stated in one sentence and nobody can judge whether a given resolution result was expected" (line 11) — the previous implementation hid the whole layer for every package name and kept special-case code for historical layouts.
- Edge cases / failure handling: the runtime resolution is computed once at profile start from four parts (installation closure, bundle-only entries, local package names, linked roots); a package's `exports` refusing a subpath is terminal, and Node's own error messages have the internal declaration position rewritten back to the original importer (line 99).
- Surprising: runtime resolution does *not* enforce peer version ranges (line 179); only direct links from `<profile>/node_modules` become linked roots, and a dependency whose real directory lies outside every recorded root uses native Node; the resolver depends on supported Node Internal interfaces and must be re-verified on Node upgrades (line 182).

### .agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.zh.md
- Purpose: Chinese translation of the profile module-resolution note; five hashed sections.
- Key abstractions: same ①–⑤ ancestor chain with the ③ interception layer.
- Data flow: same — per-candidate peer interception for linked roots.
- Non-obvious design decisions: same — the one-sentence restatability test; explicit CJS `paths` bypass.
- Edge cases / failure handling: same — `exports` refusal is terminal; error positions rewritten back to the importer.
- Surprising: same — no peer version-range enforcement; Node-Internal dependence.

### .agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.i18n.yaml
- Purpose: pairing record for the projection-cache identity note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-projection-cache-read-only-face-matches-the-lifecycle-identity-the-client-store-separates-cached-and-sequenced-rows`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the entire (long) title, compressed to a slug.
- Edge cases / failure handling: digest mismatch only.
- Surprising: this note is *about* distinguishing two sequence spaces (cached vs sequenced) — and the i18n key is itself a disambiguation of a long title into a stable identifier.

### .agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md
- Purpose: fix forked sessions showing no title in the sidebar after a Host restart, and make connection data unconditionally override list hints.
- Key abstractions: a cache record is bound to a *lifecycle identity* — `formatVersion + createdAt + cwd + isSeeded + inheritedEventCount` — matched by `identityMatches` on full equality (line 15). The cut (`inheritedEventCount`) no longer appears in the logical header, and the physical header line stopped storing `seedLength` in format v2, so a header-only read *cannot* obtain it.
- Data flow: `fromHeaderLine` hard-codes `inheritedEventCount: 0` for header-only reads, and both consumers grew the same guard `header.isSeeded ? undefined : cachedSnapshot(header, 0) ?? cachedPredecessorTitle(header, 0)` (lines 21-22) — with no fallback, so a seeded session got no title, no `sessionListMetadata`, `blank` fell back to `false`, and ordering fell back to `createdAt`.
- Non-obvious design decisions: the fix splits the cache into two read faces — a **read-only face** matching the four-field lifecycle identity from the header, and a **fold face** matching the five-field identity including the cut (lines 52-53). Comparability is then expressed by a *separate field* `kind` (`cached` vs `sequenced`) rather than by overloading `asOfSeq` (line 57); the rejected alternative was an `asOfSeq: -1` sentinel, because one field would carry two meanings and a delayed control baseline at a lower cut overwrote a newer list value (line 131).
- Edge cases / failure handling: the read-only face may skip the cut because the rejection set does not change — a record from another lifecycle is still rejected, unseeded results are identical, and seeded lifecycles go from *unaddressable* to *addressable* (line 62). The only new exposure is a record identical in all four fields but differing in cut, which the system cannot produce; even then it would only affect the list until the session is opened.
- Surprising: the "worst case" walkthrough shows the fix is unconditional rather than sequence-based: a list hint is written as a `cached` row, the history first-page baseline `seed` discards all `cached` rows first and then writes per block, and a later list refresh hits a `sequenced` row and is ignored — so the wrong value has zero residue regardless of seq magnitude (lines 116-119).

### .agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.zh.md
- Purpose: Chinese translation of the projection-cache identity note; five hashed sections.
- Key abstractions: same four-field read-only identity vs five-field fold identity.
- Data flow: same — `kind` separates the two sequence spaces.
- Non-obvious design decisions: same — a separate `kind` field rather than a sentinel.
- Edge cases / failure handling: same — the read-only rejection set is unchanged.
- Surprising: same — the unconditional-replacement worst-case walkthrough.

### .agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.i18n.yaml
- Purpose: pairing record for the remote duplex stream note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-remote-duplex-stream-one-kind-of-stream-an-uplink-channel-and-an-invocation-context`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key carries all three of the note's three-part title.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the longest note in the shard (616 lines) still yields a ~1.5 KB pairing record, because digests are per-section.

### .agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.md
- Purpose: one duplex stream kind with a typed uplink, so interactive consumers stop pairing a stream with a second unary RPC.
- Key abstractions: `RemoteStream<Out, In = never>` is a *type alias* (not an interface) so a future Node-stream shape only changes the alias; the Client face gets a distinct name, `RemoteStreamHandle<Out, In>`, exported from the same entry point (line 24).
- Data flow: `this.ctx.invocation.uplink<In>()` gives the Host the uplink iterator; the invocation also carries the admitted Peer and the cancellation signal. The mechanism relies on two existing Cordis behaviours: `ctx.extend(meta)` is `Object.create(parent)` plus own properties — no registration, no fiber, nothing to release, so deriving one per call costs nothing; and `ctx.get(service)` returns a traceable proxy whose shadow method's `this` carries `ctx.extend({ [symbols.shadow]: origin })` (lines 173-175).
- Non-obvious design decisions: uplink and downlink types are written in *one* place — the method's return type — and the generator derives both codecs from it. A separate `mode: 'duplex'` with a reserved parameter is rejected because "duplex is an inherent property of a transport stream, not a mode of a method" (zh line 559).
- Edge cases / failure handling: the uplink inbox is metered in UTF-8 bytes with a default limit of 262144, and on overflow the *whole logical stream* fails with `gateway/uplink-overflow` — no data is discarded, and a method that does not read its uplink while the Client keeps sending is a usage error the failure exposes explicitly (line 300). `uplink()` may be taken only once; the second call throws. `In` defaulting to `never` means the descriptor has no uplink codec, so `send` is `never` at compile time.
- Surprising: while `uplink()` has not been called, uplink items simply accumulate in the inbox until the limit or the end of the stream — deliberately, so "a method that does not read the uplink need not know the uplink exists" (line 165). The transport knows only *one* generation: reconnect, cursor resumption and baseline validation are upper-layer protocol concerns (line 567 area).

### .agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.zh.md
- Purpose: Chinese translation of the remote duplex stream note; five hashed sections.
- Key abstractions: same `RemoteStream<Out, In>` alias + `RemoteStreamHandle` name split.
- Data flow: same — `ctx.extend({ invocation })` + shadow receiver gives the method its per-call view.
- Non-obvious design decisions: same — both types in one return type; duplex rejected as a "mode" (zh line 559).
- Edge cases / failure handling: same — byte-metered inbox, whole-stream `uplink-overflow` failure.
- Surprising: same — uplink items accumulate silently until the limit; one generation only.

### .agents/notes/implemented/architecture/2026-09-19-timed-user-question-two-settlements.i18n.yaml
- Purpose: pairing record for the timed user question note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-timed-user-questions-as-two-settlements`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the two-settlement model.
- Edge cases / failure handling: digest mismatch only.
- Surprising: "two settlements" is a compact name for "one foreground answer path and one durable late-answer path" — the same kind of compression the note itself applies.

### .agents/notes/implemented/architecture/2026-09-19-timed-user-question-two-settlements.md
- Purpose: let a timed question release the tool call without discarding the question.
- Key abstractions: foreground answers use the existing Remote Event waterfall; a timeout ends that request and returns pending, while a later answer uses a business RPC that steers a durable user message; the claim stream controls the foreground wait only (line 15).
- Data flow: `TimedQuestionWait` owns a private cancellation signal, the original Host deadline and Client claims; the Host runs a timer only while no answer UI holds a claim, and losing the last claim restores the original deadline (line 39). A timed request carries `wait: { callId, timed: true }` and the Client opens `attachWait`, a business Remote stream that yields one Host-computed `remainingMs` frame and stays open for the claim's lifetime.
- Non-obvious design decisions: the *pending* result is neither a skipped answer nor permission to proceed with work requiring approval (line 9) — so a pending question keeps its own durable state. A native blocking call made with the timed schema still participates in timed-question projection and review; it is not identical to a legacy call (line 20). Human interaction requires the exact live runtime root: a stale instance fails `CALLER_NOT_LIVE` and an owned child fails `DELEGATED_CALLER`.
- Edge cases / failure handling: the Client retains its claim through *delivery* of the waterfall to the Host — releasing it at local answer time would let an already-expired Host timer settle first (line 43). A terminal claim-stream failure can reject the foreground question rather than produce pending, and no unattended-wait fallback is provided for that failure (line 112). A PTC sub-call interrupted before its `tool/ptc-dispatch` result is recorded cannot be reconstructed from the parent `run_code` failure, so it cannot take a late answer after recovery (line 116).
- Surprising: the durable question projection is rebuilt from existing Session events — the `request/header`'s `timeout` parameter identifies the timed schema — so **no new Session event type or wait-state log is needed** (line 55); a queued late reply is a durable inbox message, and the reservation spans queue → claim → admission.

### .agents/notes/implemented/architecture/2026-09-19-timed-user-question-two-settlements.zh.md
- Purpose: Chinese translation of the timed user question note; five hashed sections.
- Key abstractions: same waterfall-foreground / RPC-late two-settlement split.
- Data flow: same — `attachWait` claim stream; timer only while unclaimed.
- Non-obvious design decisions: same — pending is neither a skip nor an approval; the claim is held through *delivery*.
- Edge cases / failure handling: same — no fallback for a terminal claim-stream failure; PTC sub-call reconstruction gap.
- Surprising: same — the projection is rebuilt from existing events, so no new event type is added.

### .agents/notes/implemented/architecture/2026-09-19-window-drag-coverage-contract.i18n.yaml
- Purpose: pairing record for the window drag coverage note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-window-drag-coverage-as-a-contract`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the *contract* framing.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note converts a hand-maintained double description into an executable contract; the pairing record is itself a small instance of "make the invariant checkable".

### .agents/notes/implemented/architecture/2026-09-19-window-drag-coverage-contract.md
- Purpose: stop the macOS window's drag region and its chrome layout from drifting apart.
- Key abstractions: coverage becomes a contract with four executed parts (line 13): (1) `window-drag/regions.ts` publishes the composition rule as an *executable model* — a point is draggable when the last collected app-region box containing it declares `drag` — together with `INTERACTIVE_SELECTOR`, the single source for the interactive subtraction ui-web's base.css declares; (2) the shell declares the darwin drag surface exactly once, `html[data-platform='darwin'] [data-window-drag]`; (3) a browser lane boots the shipped composition in Chromium with `data-platform='darwin'` and asserts no interactive box lies inside the drag surface; (4) one shell-owned recollection watcher measures every marked row once per frame while the surface can move.
- Data flow: every chrome row marks its own element in markup, so the row's box *is* the window's draggable geometry — no fixed band has to match any row's height (line 16).
- Non-obvious design decisions: a ui-theme app-region gate holds a manifest pairing each row's markup mark with its sheet, class selector and authored height, and refuses a mark on any element the manifest does not name — so a row that stops marking itself, an unmarked row added to the composition, and a mark on a content container all fail the same gate (line 16). Publishing measured rectangles from JavaScript is rejected because "one stale frame is exactly the swallow class this work removes" (line 24).
- Edge cases / failure handling: the recall watcher sets `data-window-drag-recall` for each frame whose geometry changed and clears it once the geometry holds still through a short grace window, "so a report that arrives before a CSS transition moves anything cannot end the loop on its first unchanged sample" (line 18).
- Surprising: the native half stays a *checklist*, because no keyless CI lane reaches the window server — the state matrix must be run for any change to this layer (line 20). The watcher exists because Electron only re-collects drag rectangles when the computed app-region value changes, and Blink's collection skips hidden boxes, so a row sliding across a hide/show boundary needs a pulse (line 39).

### .agents/notes/implemented/architecture/2026-09-19-window-drag-coverage-contract.zh.md
- Purpose: Chinese translation of the window drag coverage note; five hashed sections.
- Key abstractions: same four-part executable contract.
- Data flow: same — markup marks, one shell rule, executable region model.
- Non-obvious design decisions: same — the manifest gate and the stale-frame rejection.
- Edge cases / failure handling: same — grace window before clearing the recall mark.
- Surprising: same — the native half remains a manual matrix.

### .agents/notes/implemented/architecture/2026-09-20-device-local-shortcut-preferences.i18n.yaml
- Purpose: pairing record for the device-local shortcut preferences note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-keep-shortcut-preferences-device-local-and-commit-before-activation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the ordering rule.
- Edge cases / failure handling: digest mismatch only.
- Surprising: "commit before activation" is the whole note; the key says it in eight words.

### .agents/notes/implemented/architecture/2026-09-20-device-local-shortcut-preferences.md
- Purpose: keep keyboard bindings per device and never show a binding that was not persisted.
- Key abstractions: the shortcut service stores only versioned overrides per runtime/platform; Web owns origin-local browser storage, Electron main owns `userData/keybindings.json` independently of the Harness home; both adapters share validation and transaction logic (line 13).
- Data flow: successful persistence publishes one accepted configuration from which command matching, keycaps and native interception derive.
- Non-obvious design decisions: **optimistic activation is rejected** — updating bindings before persistence makes a failed save look successful and leaves restart behaviour inconsistent with the visible controls (line 21). Host settings are rejected because a server's OS and settings scope do not identify the visitor's device or browser restrictions, and Host storage would couple remote visitors' preferences (line 19).
- Edge cases / failure handling: missing commands retain dormant overrides; explicit overrides win over newly introduced defaults, and conflicting explicit overrides are *all* disabled. An unreadable configuration blocks ordinary edits and preserves the last accepted values, and Restore All clears only the accepted current profile and cannot overwrite unreadable or future-version data (line 15).
- Surprising: cross-tab atomic merging is impossible because localStorage has no compare-and-swap transaction — Web rereads before each operation and rejects known stale drafts but accepts last-writer-wins for simultaneous writes, while Electron main serializes edits and rejects stale revisions (line 23).

### .agents/notes/implemented/architecture/2026-09-20-device-local-shortcut-preferences.zh.md
- Purpose: Chinese translation of the device-local shortcut preferences note; five hashed sections.
- Key abstractions: same per-runtime/platform versioned overrides.
- Data flow: same — publish one accepted configuration after persistence.
- Non-obvious design decisions: same — optimistic activation rejected; Host settings rejected.
- Edge cases / failure handling: same — unreadable config blocks edits and preserves last accepted values.
- Surprising: same — localStorage has no CAS, so last-writer-wins.

### .agents/notes/implemented/architecture/2026-09-20-dynamic-tool-updates.i18n.yaml
- Purpose: pairing record for the dynamic tool updates note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-active-tool-headers-and-stateful-request-projection`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the two halves (headers + projection).
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about keeping the *cache* valid while tools change; the record is about keeping a *hash* valid while a section changes.

### .agents/notes/implemented/architecture/2026-09-20-dynamic-tool-updates.md
- Purpose: let the tool set change mid-conversation without destroying the provider's cached prompt prefix.
- Key abstractions: `request/header.tools` records assembled active tools *independently of model capability*; the loop compares names against the preceding header and emits one `developer/message` with additions and removals under the `tool-registry` source (line 13).
- Data flow: `Session.toolHistory()` caches a capability-independent fold of committed headers and developer messages — first access restores inherited events, later reads consume only unseen events; immutable snapshots carry initial declarations and ordered update identities with additions resolved through their historical headers (line 15). Loop and compaction requests carry this snapshot as `GenerateOptions.toolHistory`; at adapter dispatch, `projectToolUpdates` uses the prepared route's `toolUpdate`.
- Non-obvious design decisions: stored provider declarations are *not* stored as active tools, because "retained removed definitions are not active tools" and mixing the two meanings makes durable updates capability-dependent (line 23). Restoring a retained name with an unchanged definition continues the series: the projection keeps the declaration unchanged and lets the recorded addition re-offer the tool after its earlier removal, so a removal never disables a declared tool and a loading mode never rewrites an earlier declaration (line 15).
- Edge cases / failure handling: unsupported routes receive active definitions without `deferLoading` or developer messages; `in-history` retains removed definitions and removal blocks, `addition-only` omits both. Missing history, or a request prefix omitting recorded updates, uses current declarations without developer updates (line 17). Calls to removed retained tools fail through the existing `UNKNOWN_TOOL` path.
- Surprising: the deferred implementation of the *registration-time* historical check is stated explicitly: same-name schema changes remain allowed, they rebuild declarations and invalidate prefix reuse even on `in-history` routes, and the restriction is deferred "because of its implementation complexity" (line 29) — the note names its own gap rather than pretending the check exists.

### .agents/notes/implemented/architecture/2026-09-20-dynamic-tool-updates.zh.md
- Purpose: Chinese translation of the dynamic tool updates note; five hashed sections.
- Key abstractions: same capability-independent `request/header.tools` plus `developer/message` deltas.
- Data flow: same — cached `toolHistory()` fold feeding `GenerateOptions.toolHistory`.
- Non-obvious design decisions: same — retained provider declarations are not active tools; restoration continues the series.
- Edge cases / failure handling: same — route-dependent projection; `UNKNOWN_TOOL` path for removed tools.
- Surprising: same — the explicitly deferred registration-time historical check.

### .agents/notes/implemented/architecture/2026-09-20-sidebar-retained-tab-layout.i18n.yaml
- Purpose: pairing record for the Sidebar retained tab layout note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-stable-sidebar-tab-mounting-and-session-retention`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both halves.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's subject — a page that must not be unmounted — is the exact hazard the digest pair avoids.

### .agents/notes/implemented/architecture/2026-09-20-sidebar-retained-tab-layout.md
- Purpose: keep a live browser page alive across tab, pane, session and floating transitions.
- Key abstractions: Sidebar owns live-body retention independently of Browser navigation and Workspace storage; a retained page's DOM ancestors remain connected and unchanged during session switches, tab selection, pane moves, collapse, floating and docking back (line 13).
- Data flow: `SidebarRightTabDefinition.keepMounted` enables lazy retention for a type (Desktop Browser enables it); a retained body is first created on display, then survives hiding until its occurrence or provider lifetime ends; the policy is not persisted and does not select a storage partition (line 25). `SidebarSessionView` acquires and releases one `SessionReference` using the independent `sidebarView` source.
- Non-obvious design decisions: Electron 44's `WebViewElement.disconnectedCallback` detaches and resets its guest, so preserving a React key or caching an element reference cannot compensate for disconnected ancestors (line 9) — hence the ancestors themselves must not change. Floating changes the *same frame* to `position: fixed` without changing its parent or replacing the Body (line 18).
- Edge cases / failure handling: a floating frame's zero-sized Grid cell establishes a stacking context at the float layer and CSS `order` expresses float depth there, so raising many floats cannot increment their layer past menus (line 19). Background tabs without an initialised retained body are removed from the view list, and the reference is released only after the committed React root unmounts, so a still-mounted subtree does not lose its session scope first (line 33).
- Surprising: there is no implicit LRU or idle timeout — background retention holds page memory *and* session scope and subscriptions, and future reclamation needs an explicit pause/resume policy (line 76); caching and moving DOM is rejected because ordinary reparenting triggers Electron's disconnect handling.

### .agents/notes/implemented/architecture/2026-09-20-sidebar-retained-tab-layout.zh.md
- Purpose: Chinese translation of the Sidebar retained tab layout note; five hashed sections.
- Key abstractions: same `keepMounted` retention with stable DOM ancestors.
- Data flow: same — `sidebarView` source, one `SessionReference` per view.
- Non-obvious design decisions: same — the `disconnectedCallback` guest-reset hazard drives the whole design.
- Edge cases / failure handling: same — release after React unmount; CSS `order` for float depth.
- Surprising: same — no implicit LRU; retention costs session scope too.

### .agents/notes/implemented/architecture/2026-09-21-conversation-build-groups.i18n.yaml
- Purpose: pairing record for the conversation build groups note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-definition-owned-grouping-with-generic-node-group-assembly`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the ownership split.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note argues that a broad benchmark budget does not prove locality; the record's per-section hash is a *precise* locality check of a different kind.

### .agents/notes/implemented/architecture/2026-09-21-conversation-build-groups.md
- Purpose: make expandable groups a business concern while the framework assembles them generically.
- Key abstractions: the grouping foundation provides a separate, Node-input `ConversationGroupDefinition`, its registry and Session-local context, generic Builder input/publication, keyed Group storage, and two React branches (line 19).
- Data flow: `create()` initialises State; `update(context, input)` returns the State the framework adopts; `buildGroups(context)` materialises the pending output and does not re-interpret events or increase counts on repeated reads (line 49). Replacing an input requires a complete root sequence and group replacement, so a removed node leaves no dangling reference.
- Non-obvious design decisions: process groups are *orthogonal* to steps — one Assistant Node can contribute reasoning inside a group and a reply outside it, and step-number ranges cannot describe membership (line 13). Mode is absent from Definition input, keys and parent selection, so Compact/Detailed/Expanded share grouping results and switching modes does not rebuild React instances by removing group containers or changing keys (line 9).
- Edge cases / failure handling: registration requires an existing View target but does not construct a Builder; duplicate registration for one target is an error, and no winner is chosen and no policies are stacked (line 46). `ConversationLocationIndex` writes cumulative change rounds from boundary events; the assembler hands the same batch to all updated targets, covering a Turn end that upserts no node.
- Surprising: the note explicitly declines to claim performance: "Stable mounting does not eliminate layout, paint, or retained-memory costs. No measured latency or optimal-performance claim is made" (line 171); and the Client's identity checks live in `packages/client/ui-conversation/src/client/contract/groups.ts` while Chat owns the segmentation rules in its own README.

### .agents/notes/implemented/architecture/2026-09-21-conversation-build-groups.zh.md
- Purpose: Chinese translation of the conversation build groups note; five hashed sections.
- Key abstractions: same separate `ConversationGroupDefinition` input category.
- Data flow: same — `create`/`update`/`buildGroups` and full root replacement.
- Non-obvious design decisions: same — groups orthogonal to steps; mode absent from Definition input.
- Edge cases / failure handling: same — duplicate registration errors; location index cumulative rounds.
- Surprising: same — the explicit "no performance claim" (zh line 171).

### .agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.i18n.yaml
- Purpose: pairing record for the desktop page close shortcuts note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-desktop-close-shortcuts-follow-page-focus`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the focus-following rule.
- Edge cases / failure handling: digest mismatch only.
- Surprising: same shape as the concrete-bind note — a small, tightly-scoped UI rule.

### .agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.md
- Purpose: route the close command to the focused sidebar page, and only then to the window.
- Key abstractions: the sidebar page owner resolves close against live focus and captures the target's Session, pane, tab occurrence and navigation revision (line 13).
- Data flow: it closes that page through its resource cleanup handler, or collapses the sole docked guide; stale sidebar targets do not fall back to another page or the window; without a closeable page, Desktop requests native window closure and Web has no window fallback.
- Non-obvious design decisions: Electron's native close role is rejected because it closes the window without asking the focused page owner and cannot preserve the accepted custom binding's routing (line 21). Native closure requires the current configuration revision, a focused and enabled product window, and inactive shortcut recording.
- Edge cases / failure handling: on Windows and Linux, closing the last window also quits the instance and stops its Host tasks — so the fallback is a *lifecycle* choice, not a menu-label change (line 9); the existing window lifecycle applies without a shortcut-specific confirmation.
- Surprising: the macOS File menu routes Close Page or Window through the same owner and displays the accepted single-key binding, so the menu and the shortcut cannot disagree (line 15).

### .agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.zh.md
- Purpose: Chinese translation of the desktop page close shortcuts note; five hashed sections.
- Key abstractions: same focus-resolving page owner.
- Data flow: same — page close, else native window close; no Web fallback.
- Non-obvious design decisions: same — Electron's native close role rejected.
- Edge cases / failure handling: same — Windows/Linux quit stops Host tasks.
- Surprising: same — the macOS File menu shares the owner and shows the accepted binding.

### .agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.i18n.yaml
- Purpose: pairing record for the experimental-capabilities-as-optional-bundles note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-ship-experimental-capabilities-as-optional-bundles`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the imperative title.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's central claim — that shipping a capability is not the same as offering it — is exactly the distinction the i18n record preserves between "the English note" and "its Chinese counterpart".

### .agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md
- Purpose: ship experimental capabilities as default-off optional bundles instead of requiring a name to install.
- Key abstractions: `OPTIONAL_BUNDLES` owns the installation's default-off selections; every bundle declares `icon` and exports `./locale/*.json` with `meta.title`/`meta.description` (line 13).
- Data flow: an optional bundle's dependencies are downloaded with every `dsh` installation; admission therefore considers installation cost and whether a switch supplies a usable composition without an additional configuration form (line 15).
- Non-obvious design decisions: a bundle's *presentation* does not determine its experimental status (line 13) — Official discovery, experimental maturity and optional delivery are three independent properties. Optional model tools register in the **global** tool layer, so every preset including `minimal` receives them, which is why a dedicated `preset` patch operation was rejected: "Limiting tools to full presets required a second patch language across profile composition, reload, plugin management, and the plugin page" (line 29).
- Edge cases / failure handling: switching a bundle off keeps its installed files; failed activation retains the existing saved-selection behaviour; a replacement title provider may register once the previous provider's disposal starts, and the previous provider's late results never commit (line 17).
- Surprising: browser and computer providers remain explicit compositions because they add substantial runtimes or require an external executable, and Stagehand requires model credentials while Python PTC replaces a core provider and conflicts with TypeScript workflow consumers (line 15).

### .agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md
- Purpose: Chinese translation of the experimental-capabilities-as-optional-bundles note; five hashed sections.
- Key abstractions: same `OPTIONAL_BUNDLES` default-off catalog.
- Data flow: same — dependencies download with every install; admission weighs cost.
- Non-obvious design decisions: same — presentation ≠ experimental status; global tool layer.
- Edge cases / failure handling: same — off keeps files; late title-provider results never commit.
- Surprising: same — the provider-specific exclusions (Stagehand credentials, Python PTC conflict).

### .agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.i18n.yaml
- Purpose: pairing record for the fatal diagnostics note; eight section hashes (adds relationship subsections and testing).
- Key abstractions: en/zh digests under `/agent-note-fatal-diagnostics-and-desktop-crash-reports`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: two separate "relationship to" subsections are hashed independently, so the relationships to the earlier decision and to the logging design cannot drift into each other.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's whole complaint is that "a screenshot of an eight-line dialog" was the only evidence — and the fix is to persist the evidence, which is what the pairing record does for every other section of the doc set.

### .agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md
- Purpose: make fatal Desktop failures diagnosable after the fact, and stop one fallible step from killing a feature.
- Key abstractions: `installFailLoud` in `dsh-app-boot` registers the same handler for `'uncaughtException'` as for `'unhandledRejection'`: write one labelled `util.inspect` diagnostic to stderr, await the surface's release hook under the existing timeout, exit 1 (line 21).
- Data flow: `DesktopFatalRecovery.report` awaits `writeCrashReport` for at most one second, then shows the dialog with the file path on its own line, independent of whether the error was shortened (line 23).
- Non-obvious design decisions: control never returns to the failed operation, because "only the throw site knows which state is intact" — a `'data'` listener that threw mid-update has already dropped a chunk and half-set its own fields (line 21). `util.inspect` replaces `err.stack` because a `node:fs` error's `code`, `syscall` and `path`, and any `cause` chain, are enumerable properties the stack line omits. Spill files are best-effort at *every* step and the removed directory is not recreated, because the design's security rests on a random name created once by this process (line 23).
- Edge cases / failure handling: a batch script that loads but registers no row is *never* re-executed, because re-running it would stop at the first already-registered package with a duplicate-factory error; each executed batch URL is remembered so a later row that finds itself missing goes straight to its single-resource combo URL (line 27). A transport failure *is* retried once on the same URL, shared by all rows of that batch.
- Surprising: the crash report deliberately retains raw stderr and console tails, rejecting the "classified error categories" rule of the continuous-log design, because "the `path:` property and the renderer's `bundle script … failed to load` line were the load-bearing evidence in both diagnoses" (line 57); the report is bounded (256 KiB error, 64 KiB Host, 64 KiB renderer console) and owner-only readable.

### .agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.zh.md
- Purpose: Chinese translation of the fatal diagnostics note; eight hashed sections.
- Key abstractions: same shared `installFailLoud` handler for both exception and rejection.
- Data flow: same — one-second bounded crash report, then the dialog with the path on its own line.
- Non-obvious design decisions: same — `util.inspect` over `err.stack`; no directory recreation.
- Edge cases / failure handling: same — zero-registration batches never re-run; transport failures retried once.
- Surprising: same — the crash report keeps raw evidence against the logging design's classification rule.

### .agents/notes/implemented/architecture/2026-09-22-platform-browser-storage.i18n.yaml
- Purpose: pairing record for the account-scoped platform browser storage note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-account-scoped-platform-browser-storage`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the scoping rule.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's core is a *hash of the origin and account id* — and the i18n record is a hash of the sections.

### .agents/notes/implemented/architecture/2026-09-22-platform-browser-storage.md
- Purpose: keep Platform notice-dismissal preferences across view and application lifetimes without leaving credentials behind.
- Key abstractions: Desktop partitions browser storage by a SHA-256 hash of the Platform origin and stable account ID; raw account IDs and tokens do not appear in partition names (line 13).
- Data flow: a persistent partition keeps only localStorage; opening one clears cookies, filesystem, IndexedDB, Cache Storage, the HTTP and shader caches, service workers and HTTP authentication *before* the document loads, while a disposable partition clears all of its storage (line 15).
- Non-obvious design decisions: while the Host has no account id from a successful profile read, the view uses a disposable partition, "so preparing a Platform session never waits for a profile request"; an id that arrives for the already-open credential leaves the mounted disposable document in place and the next open uses the account-scoped partition (line 13). A token-derived name is rejected because it discards preferences when credentials change (line 19).
- Edge cases / failure handling: closing a view destroys its document, detaches the credential-bearing request interceptors and schedules the same cleanup, so authentication left by an unclean exit is cleared before the next document loads; the next open and application shutdown await that cleanup, and an update install awaits it before the installer takes over the exit (line 15). A failed cleanup rejects that open and keeps its account from opening again until a later cleanup succeeds, while other accounts keep opening.
- Surprising: persistent site storage is explicitly *not* a credential vault, and the Host-only credential still enters the trusted page through the existing preload and is never written to browser storage by the bridge (line 15).

### .agents/notes/implemented/architecture/2026-09-22-platform-browser-storage.zh.md
- Purpose: Chinese translation of the account-scoped platform browser storage note; five hashed sections.
- Key abstractions: same origin+account-id SHA-256 partition naming.
- Data flow: same — localStorage only; everything else cleared before load.
- Non-obvious design decisions: same — disposable partition while the account id is unknown; no token-derived names.
- Edge cases / failure handling: same — cleanup awaited on close, shutdown and update install; a failed cleanup blocks only that account.
- Surprising: same — persistent site storage is not a credential vault.

### .agents/notes/implemented/architecture/2026-09-22-schedule-hard-delete-and-bounded-history.i18n.yaml
- Purpose: pairing record for the schedule hard-delete note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-schedule-deletes-task-rows-and-bounds-delivery-history`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states both halves (delete + bound).
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about making a document's size a function of configuration rather than of history — and the pairing record is a bounded document whose size is a function of the note's headings.

### .agents/notes/implemented/architecture/2026-09-22-schedule-hard-delete-and-bounded-history.md
- Purpose: give a scheduled task one deletion semantics and bound the storage document's growth.
- Key abstractions: deletion is hard — `ScheduleService.delete` removes the storage row through `tasks.delete`, so the task leaves `list` and `catalog` and `history` answers `schedule_not_found` for the same `(sessionId, id)`; the task schema has no `deleted` field (line 13).
- Data flow: delivery history is bounded by plugin `Config`: `deliveryHistoryDays` (default 30, 1–3650) and `deliveryHistoryRecords` (default 200, 1–10000), both applied on the only write path, `appendDelivery` (line 15).
- Non-obvious design decisions: the window is measured **from the appended receipt's `deliveredAt`**, not from the task's creation or committed target, because anchoring it to the task would discard a newly written receipt of an old task (line 25). A count cap alone is rejected: it keeps arbitrarily old receipts when deliveries are sparse and drops a burst of recent ones when they are not.
- Edge cases / failure handling: pruning sets `earlierRecordsUnavailable` and `earlierRecordsPruned`, and later appends preserve them; the latter flag is optional in stored rows and confirms actual removal, so legacy unavailability alone does not imply pruning (line 15). The Client shows the cleanup notice only for confirmed pruning after loading the final nonempty page.
- Surprising: because the domain is one whole-unit JSON document rewritten on every mutation, "every retained byte in a task row grows every write" — retention is therefore a bound the *storage layout* requires, not a retention preference (line 27).

### .agents/notes/implemented/architecture/2026-09-22-schedule-hard-delete-and-bounded-history.zh.md
- Purpose: Chinese translation of the schedule hard-delete note; five hashed sections.
- Key abstractions: same hard delete with no `deleted` flag.
- Data flow: same — day + count bounds on the single write path.
- Non-obvious design decisions: same — the window is anchored on the appended receipt, not the task.
- Edge cases / failure handling: same — `earlierRecordsPruned` confirms actual removal.
- Surprising: same — retention is a storage-layout requirement.

### .agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.i18n.yaml
- Purpose: pairing record for the three-phase tool call note; ten section hashes (adds five decision subsections).
- Key abstractions: en/zh digests under `/agent-note-tool-calls-own-preparation-dispatch-and-results-by-callid`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the five `/decision/...` subsections are hashed separately, so a translation that flattens them fails.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the most finely-grained record in the shard — the note itself is the one that splits a lifecycle into three named stages, and the record mirrors that granularity exactly.

### .agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.md
- Purpose: show a tool call as soon as its identity is known, without inventing a second node.
- Key abstractions: the Tool Definition groups calls by callId and supplies explicit stage data: `preparing` (a live delta with a call id and tool name — call identity, name, time and a lazy partial-argument view; one non-expandable row), `start` (`tool/call` — complete arguments), `result` (`tool/result`) (line 19).
- Data flow: successful stream settlement publishes the final Assistant message while retaining transient deltas until `step/end`; each `tool/call` updates its existing callId, and the Assistant keeps its live ordering anchor until the same cleanup; failed, interrupted or abandoned streams retire their deltas immediately (line 33).
- Non-obvious design decisions: an argument block ending does *not* trigger dispatch presentation, and an empty argument string does not stand in for a dispatched call (line 25). The earliest start in the current event sequence initialises State and every later Match — including another start for the same id — goes through update, so matching reads only the current event, without Context lookup, additional roles, registries or separate caches (line 31).
- Edge cases / failure handling: historical pages do not expand settled Assistant messages into live deltas, and reconnection restores only an attempt that is still live; "Equal durable events produce equal final state; intermediate presentation and preparation-group identity need not match" (line 37). On retirement the Assembler reselects starts and recomputes State from remaining Matches; undispatched preparations hide without synthetic execution results.
- Surprising: multiple starts with one id are one lifecycle, so a second-start error no longer detects identity reuse — independent calls must use distinct ids (line 64); and preparation is deliberately *not* persisted or replayed, because durable calls and results already suffice to reconstruct the final presentation (line 57).

### .agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.zh.md
- Purpose: Chinese translation of the three-phase tool call note; ten hashed sections.
- Key abstractions: same preparing/start/result stage table.
- Data flow: same — deltas retired on failure, `step/end` cleanup.
- Non-obvious design decisions: same — argument-block end does not trigger dispatch; start-matching reads only the current event.
- Edge cases / failure handling: same — equal durable events produce equal final state.
- Surprising: same — id reuse is no longer detectable via a second start (zh line 64).

### .agents/notes/implemented/architecture/2026-09-23-best-effort-persistent-ptc.i18n.yaml
- Purpose: pairing record for the Node PTC execution modes note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-node-ptc-execution-modes-and-in-memory-state`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both the modes and the state.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note insists `durable` is *not* an accepted configuration value, and the record's own discipline — a hash per section — is a form of durability for the prose.

### .agents/notes/implemented/architecture/2026-09-23-best-effort-persistent-ptc.md
- Purpose: let interactive automation keep JS objects, imports and helpers between model calls.
- Key abstractions: `executionMode` selects `per-call` (default) or `persistent-in-memory`; both provide the same `ctx.ptcRuntime` service; PTC uses the live Agent as owner and awaits release during its context disposal (line 13).
- Data flow: the Session records submitted programs, nested tool calls and returned output; it does *not* serialize the REPL heap or rerun earlier programs after restart, resume or fork, because replaying automation could repeat external side effects (line 19).
- Non-obvious design decisions: mode names describe *state retention*, not a process implementation or source syntax — `programFormat` describes source evaluation independently, so a REPL need not retain state (line 17). `durable` is a reserved name for a future capability and is explicitly not an accepted configuration value: "a future implementation must define its recovery point, recoverable values and external-resource handling before exposing that mode" (line 15).
- Edge cases / failure handling: cancellation, deadline expiry, protocol or output-limit failure, owner disposal and process exit all discard the environment; ordinary exceptions retain earlier mutations; a retained function uses the *active* evaluation's host bindings, so asynchronous work from an earlier evaluation cannot acquire a later evaluation's tool authority or output sink (line 21). A missing variable is a normal program error.
- Surprising: one npm package and one plugin entry keep installation paths stable, and the Node provider delegates retained-process ownership to an internal execution object that registers *no additional Cordis service* (line 17); an idle owner retains a process with no expiration timer, and calls for one retained owner cannot overlap (line 37).

### .agents/notes/implemented/architecture/2026-09-23-best-effort-persistent-ptc.zh.md
- Purpose: Chinese translation of the Node PTC execution modes note; five hashed sections.
- Key abstractions: same `executionMode` split with one shared service.
- Data flow: same — programs and outputs recorded; heap not serialised; no replay.
- Non-obvious design decisions: same — mode names describe retention, not implementation; `durable` reserved but unusable.
- Edge cases / failure handling: same — evaluation-scoped binding authority; no automatic retry.
- Surprising: same — no extra Cordis service; no idle expiration.

### .agents/notes/implemented/architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.i18n.yaml
- Purpose: pairing record for the Desktop close-to-background note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-hide-the-desktop-window-on-close-and-confirm-interruptible-quits`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key is the whole title, and this note's H1 is the only one in the shard left in English.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's own H1 was never translated, while its body was — a small inconsistency the record still tracks.

### .agents/notes/implemented/architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.md
- Purpose: make closing the window hide it (not destroy it), and warn only when a quit would actually interrupt something.
- Key abstractions: closing the main window hides it on both platforms; the page and Host keep running and the next show presents the same document; Windows gets a permanent tray icon (line 15).
- Data flow: every ordinary quit entry asks the Host over the private IPC channel for two facts — active tasks under the update-restart rule, and armed scheduled reminders reported by `schedule` for sessions loaded in this run (line 17).
- Non-obvious design decisions: the quit confirmation is a **native message box without an owner window**, because an HTML overlay needs a visible parent window and a working renderer, and the quit must also work when the window is hidden or the page is stuck (line 25). An inspection failure or a missed two-second deadline counts as "running tasks", "because a needless prompt is cheaper than a silent interruption" (line 17). Repeated quit requests join the open box, the copy is frozen while it is open, and approval does not re-inspect.
- Edge cases / failure handling: a Host that is not ready cannot run tasks, so the quit proceeds silently; the installer restart, fatal recovery, the development restart command and OS session end all skip the confirmation (line 17).
- Surprising: Dock activation reopens the hidden window when *no window is visible*, not only when none exists (line 7); reminders in sessions never loaded during the run are neither counted nor resumed until those sessions open, and Desktop does not enable scheduled tasks by default, so the scheduled-task copy appears only once that feature is on (line 33).

### .agents/notes/implemented/architecture/2026-09-23-desktop-close-to-background-and-quit-confirmation.zh.md
- Purpose: Chinese translation of the Desktop close-to-background note; five hashed sections. Note the H1 is left in English here (zh line 1) while the body is translated.
- Key abstractions: same hide-on-close plus tray icon, same two-fact quit inspection.
- Data flow: same — active tasks and armed reminders over private IPC.
- Non-obvious design decisions: same — native message box, fail-safe toward prompting, joined repeated requests.
- Edge cases / failure handling: same — bypass list for installer/fatal/dev/OS paths.
- Surprising: same — the untranslated H1, and the "unloaded sessions are not counted" rule.

### .agents/notes/implemented/architecture/2026-09-23-native-https-web-listener.i18n.yaml
- Purpose: pairing record for the native HTTPS listener note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-native-https-on-the-web-listener`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the transport.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about TLS on the listener, and the record is about a hash that also protects the text's integrity.

### .agents/notes/implemented/architecture/2026-09-23-native-https-web-listener.md
- Purpose: encrypt launch tokens and session cookies without requiring a TLS-terminating proxy.
- Key abstractions: WebServer owns optional TLS through `tls: { certFile, keyFile }`, exposed as paired `--tls-cert`/`--tls-key` flags; certificate and unencrypted private-key PEM files are loaded before binding, and unreadable, empty, invalid or mismatched material fails activation *without an HTTP fallback* (line 13).
- Data flow: `webServer.protocol` is the source for the bind-address URL, the non-loopback plain-HTTP warning, and Connection's `Secure` cookie attribute; neither forwarded headers nor `publicUrl` control encryption or that attribute (line 15).
- Non-obvious design decisions: the API authority check does not equate a proxy's upstream transport with the browser page's scheme — an HTTPS listener can accept a matching HTTP Origin, but `sec-fetch-site: cross-site` still rejects the request and authentication remains required (line 17). Falling back to HTTP on certificate errors is rejected because it would expose credentials despite an explicit request for encryption.
- Edge cases / failure handling: disposal also owns incomplete TLS handshakes; HTTPS cookie names and signed audiences include the `https:` scheme, preventing replay of an HTTP credential on any HTTPS port even if the cookie is renamed (line 19).
- Surprising: HTTP cookie audiences retain their existing spelling so enabling TLS does not invalidate unrelated HTTP sessions (line 19); the certificate must cover the hostname or IP the TLS client dials, and replacement requires a listener reload or process restart (line 21).

### .agents/notes/implemented/architecture/2026-09-23-native-https-web-listener.zh.md
- Purpose: Chinese translation of the native HTTPS listener note; six hashed sections.
- Key abstractions: same `tls: { certFile, keyFile }` with no HTTP fallback.
- Data flow: same — `webServer.protocol` is the single source for scheme-derived decisions.
- Non-obvious design decisions: same — proxy upstream transport ≠ page scheme.
- Edge cases / failure handling: same — disposal owns incomplete handshakes; scheme-qualified cookie audiences.
- Surprising: same — HTTP cookie audiences keep their old spelling.

### .agents/notes/implemented/architecture/2026-09-24-bounded-session-log-upload.i18n.yaml
- Purpose: pairing record for the bounded session-log upload note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-bounded-deepseek-session-log-upload`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the boundedness.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note solves a "the whole log exceeds the JS string limit" failure; the record is a compact, bounded stand-in for the same idea.

### .agents/notes/implemented/architecture/2026-09-24-bounded-session-log-upload.md
- Purpose: stop a long Session log from making every model request fail.
- Key abstractions: `session-log-deepseek.Config.maxBytes`, 8 MiB by default, bounds the complete serialized `dsh_session_log` field in UTF-8 bytes; each request carries the longest contiguous run after the watermark whose field fits the limit, and acceptance advances the watermark to that run's `throughSeq` (line 12).
- Data flow: the DeepSeek adapter treats a merged request body that fails to serialize as an *extension* failure rather than a transport failure: it sends the base body without any extension field, skips the joint acceptance transaction, and reports the omitted field names through the provider plugin's logger, so contributors resend unaccepted state later (line 14).
- Non-obvious design decisions: the measured failure is documented precisely — a 269 MiB first upload of a 96,341-event Session waited 34 s for its 2xx, and above the V8 string limit (2^29 − 24 UTF-16 code units) the adapter's `JSON.stringify` throws `RangeError`, reports `TRANSPORT`, and the default retry policy repeats the same serialization, so no request ever reaches the 2xx that would advance the watermark and *every* model request in that Session fails (line 8). Serializing the whole pending run first and bounding on overflow is rejected on measurement: 182 ms to serialize a 135 MiB backlog versus 10 ms to fill 8 MiB (line 20).
- Edge cases / failure handling: when the first pending event alone exceeds the limit the request omits the field, logs a warning, and the watermark stays *before* that event until `maxBytes` admits it; an event whose JSON text exceeds the runtime's string limit counts as exceeding every limit, so it blocks upload without failing the request (line 12). A base body that cannot serialize still fails the request.
- Surprising: acceptance is a *joint* transaction across extension fields, so the fallback drops **every** extension field on that path rather than only the failing one — losing only the small `dsh_plugin_packages` inventory for one request (line 24).

### .agents/notes/implemented/architecture/2026-09-24-bounded-session-log-upload.zh.md
- Purpose: Chinese translation of the bounded session-log upload note; five hashed sections.
- Key abstractions: same 8 MiB `maxBytes` with a `throughSeq` watermark.
- Data flow: same — extension failure drops all extension fields and skips the acceptance transaction.
- Non-obvious design decisions: same — the measured 269 MiB / 34 s and 182 ms-vs-10 ms numbers are carried in the translation.
- Edge cases / failure handling: same — oversized first event blocks upload without failing the request.
- Surprising: same — the joint-acceptance reason for dropping all extension fields.

### .agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.i18n.yaml
- Purpose: pairing record for the remote model catalog note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-deepseek-account-models-come-from-the-account-listing-and-gate-by-client-version`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states both the source and the gate.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's rule — a model is available only if the service declares a minimum client version — and the record's rule — a section is valid only if its counterpart's hash is recorded — are the same shape.

### .agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.md
- Purpose: let the model list come from the account service, without letting an old build request a model it cannot drive.
- Key abstractions: `llm-deepseek-account` loads the listing lazily per credential, waits once up to `modelsTimeoutMs`, refreshes in the background after `modelsMaxAgeMs`, keeps the last good listing on failure, and serves the bundled catalog before any listing loads; the cache is in memory keyed by endpoint and token fingerprint (line 13).
- Data flow: listed capabilities replace bundled ones field by field; the bundled entry keeps client-side knowledge such as tool-update mode and image budgets; `modelOverrides` applies last (line 15).
- Non-obvious design decisions: a listed model is available only when its `client_requirements["deepseek-harness"].min_version` is at most the current version in semver order; without that declaration, only ids the built-in catalog knows are available, "because a client cannot tell which future version supports them" (line 14). Server-side filtering by client version is rejected because an older build then cannot show that a newer version supports a model (line 20).
- Edge cases / failure handling: a request for a refused listed model fails **before network I/O** with `CLIENT_UPGRADE_REQUIRED` or `MODEL_UNSUPPORTED`; the first account access after sign-in may wait up to `modelsTimeoutMs` and an offline start uses bundled capabilities (line 36).
- Surprising: whole-listing validation is rejected — Codex, ZCode and Kimi reject the whole listing on one bad field, so "one malformed row would then send every account back to the bundled catalog" (line 24); and the shared transport gains only two provider hooks, `connect` and `admit`, with listing, gating and merging staying in the account package (line 16).

### .agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.zh.md
- Purpose: Chinese translation of the remote model catalog note; five hashed sections.
- Key abstractions: same lazily-loaded per-credential listing with an in-memory keyed cache.
- Data flow: same — field-by-field capability merge; `modelOverrides` last.
- Non-obvious design decisions: same — the `min_version` gate; no whole-listing validation.
- Edge cases / failure handling: same — pre-network failure with `CLIENT_UPGRADE_REQUIRED`/`MODEL_UNSUPPORTED`.
- Surprising: same — only two transport hooks added.

### .agents/notes/implemented/architecture/2026-09-24-preparing-tool-arguments.i18n.yaml
- Purpose: pairing record for the preparing tool arguments note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-incremental-tool-argument-scanning-and-argument-order-during-preparation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both the scanner and the ordering question.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is a *measurement* of model behaviour, and the record preserves the measurement's text in both languages.

### .agents/notes/implemented/architecture/2026-09-24-preparing-tool-arguments.md
- Purpose: scan streaming tool arguments so a row can show a path, a decoded length or a description before the call is dispatched.
- Key abstractions: `PartialArguments` is a tool-independent lazy reader in `dsh-util-values`; it retains separate argument fragments and a top-level key/value range index, or borrows an already-parsed PTC payload; reads index only newly received boundaries, and unrequested values are neither decoded, counted nor parsed (line 26).
- Data flow: the boundary scanner tracks quotes, backslash parity and matching nested brackets across fragments; key names are decoded for lookup while value contents are deferred; `complete()` reports a closing delimiter, not validated content, and `invalid` reports errors already found (line 28). `append(delta)` only retains the fragment and `refresh()` compares remembered answers at publication time — with nothing read yet it does not scan or report a change (line 32).
- Non-obvious design decisions: the *ordering* of generated arguments was measured, not guessed — 310 controlled requests against the real DeepSeek V4 API showed that reordering `properties` alone changed nothing (0/20 for bash, 0/20 for run_code), while reordering `required` together with `properties` forced the description first in 10/10 forced-choice and 7/10 free Pro calls but 0/20 free Flash calls, and adding one sentence to the description ("Provide `description` before `command` in the arguments.") took free Flash to 19/20 and 20/20 (lines 11-18).
- Edge cases / failure handling: formal tool-input validation remains outside this presentation reader, and content errors do not prevent indexing subsequent fields (line 28). A stream whose name arrives after its arguments gives up scanning; that call's preparing row falls back to the title alone (line 88).
- Surprising: the view *judges change itself* — the business states its granularity as it reads, so `stringLength('content', { step: 1024 })` makes only a kilobyte crossing count while `text('description')` makes every character count (line 32); and a benchmark is required, with CI budgets of 750/375 ms and 37.5/10 MiB, because the historical cumulative-indexing control took ~4,000 ms for write and ~1,480 ms for bash (line 81).

### .agents/notes/implemented/architecture/2026-09-24-preparing-tool-arguments.zh.md
- Purpose: Chinese translation of the preparing tool arguments note; six hashed sections.
- Key abstractions: same tool-independent `PartialArguments` lazy reader.
- Data flow: same — fragment retention, deferred decoding, self-judged change.
- Non-obvious design decisions: same — the 310-request measurement of `required` vs `properties` ordering is carried in the translation (zh lines 11-18).
- Edge cases / failure handling: same — validation outside the reader; late-named streams give up scanning.
- Surprising: same — per-read granularity (step 1024 vs per-character) and the mandatory benchmark budget.

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-schedule-tools.i18n.yaml
- Purpose: pairing record for the preset-scoped schedule tools note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-preset-scoped-schedule-tools`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the scoping.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about *not* putting a tool in everyone's schema; the record is about keeping two copies of a decision in step.

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-schedule-tools.md
- Purpose: stop a capability-poor preset from carrying reminder tool schemas it cannot use.
- Key abstractions: `@deepseek-ai/dsh-tool-schedule` contributes the four tools as a preset-level Consumer; it declares `inject = ['tools']` and registers the definitions on `ctx.tools` from inside `ctx.inject(['schedule'], …)`, so the mounting scope owns them and registration waits for the Host Schedule service in that same scope (line 13).
- Data flow: `dsh-tool-schedule` is the model-facing consumer of `ctx.schedule` — it checks selector and identity constraints before the service call, reads `exec.agent` for the Session binding, and maps failures that are not `ScheduleInputError` to `internal_error` so storage details never reach the model (line 15).
- Non-obvious design decisions: the availability decision had been sitting in the package that owns *storage* — the `agent/created` listener's only filter was membership in `ctx.agents.roots()`, which "says nothing about the Agent preset" (line 9). A `Config` flag is rejected because it would move a composition choice into the storage plugin, where no preset can state it.
- Edge cases / failure handling: a delegated child inherits the preset's four schemas, but `subagentCallerRefusal` returns `{ code: 'subagent_session', … }` from each tool when the caller's delegation depth is above zero, and the *service* refuses too, because a Session a delegated child owns can never receive a delivered reminder (lines 29-30). "Visibility does not authorize execution."
- Surprising: the rule sits in the service, so other consumers reach it too — the Automation surface included — and the delegation depth is carried by the persisted session header across a cold resume, so the refusal survives a restart (line 30).

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-schedule-tools.zh.md
- Purpose: Chinese translation of the preset-scoped schedule tools note; six hashed sections.
- Key abstractions: same preset-level Consumer with `inject = ['tools']`.
- Data flow: same — `exec.agent` for the Session binding; storage errors mapped to `internal_error`.
- Non-obvious design decisions: same — the availability decision belongs to the composition, not the storage plugin.
- Edge cases / failure handling: same — `subagent_session` refusal in both the tool and the service.
- Surprising: same — the refusal survives a cold resume via the persisted header.

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-time-context.i18n.yaml
- Purpose: pairing record for the preset-scoped time context note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-preset-scoped-time-context`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the scoping.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note separates "an injection carrying time belongs to the preset that consumes it" — the same principle the record embodies by scoping a hash to a section.

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-time-context.md
- Purpose: put the clock reading only in presets that use it.
- Key abstractions: `standard.patch.yml`, `ptc.patch.yml` and `cordis.patch.yml` each declare `time-context` among their Agent-context rows; `minimal.patch.yml` does not; the global `cordis.patch.yml` carries no `time-context` row and only inserts `schedule` and `ui-schedule` (line 13).
- Data flow: the plugin is unchanged — it still appends the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message, at the configured minimum interval (line 17).
- Non-obvious design decisions: the stated boundary is "an injection carrying time belongs to the preset that consumes it" — a preset decides whether its Agents receive a clock reading, so the reading travels with the reminder tools that consume it, while preset-independent surfaces are inserted for the whole deployment (line 15). Declaring the row in `minimal` too is rejected because it keeps an unused durable message in the capability-poor composition.
- Edge cases / failure handling: a profile patch layer cannot disable or reconfigure the row by id — `applyEntryPatches` reaches a loaded entry or a group's children, and a preset's declared plugins sit inside the preset row's `config.plugins` — so changing the row means restating the row (line 32).
- Surprising: the reading is model-visible and durable, so it replays, compacts and appears in exported Session logs, and `snapshots/web/minimal-preset/session.v4.jsonl` no longer records one (line 31); a preset mount reaches that preset's subagents, so a `standard` child receives the reading its parent receives while the reminder tools stay denied to it.

### .agents/notes/implemented/architecture/2026-09-24-preset-scoped-time-context.zh.md
- Purpose: Chinese translation of the preset-scoped time context note; six hashed sections.
- Key abstractions: same per-preset `time-context` declaration.
- Data flow: same — plugin unchanged; appends instant, zone, elapsed.
- Non-obvious design decisions: same — the reading belongs to the consuming preset.
- Edge cases / failure handling: same — rows cannot be patched by id.
- Surprising: same — the reading is durable and exported; subagents inherit it.

### .agents/notes/implemented/architecture/2026-09-24-scheduled-message-framing.i18n.yaml
- Purpose: pairing record for the scheduled message framing note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-delivered-reminders-are-framed-as-scheduled-messages-from-the-user`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the framing.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's whole subject is *how a message announces its own origin* — and the record announces a section's origin by its digest.

### .agents/notes/implemented/architecture/2026-09-24-scheduled-message-framing.md
- Purpose: give delivered reminders a fixed framing line that names their origin.
- Key abstractions: `renderReminderFraming` and `renderRecurringReminderBatchFraming` both emit one shared fixed line, `SCHEDULED_MESSAGE_FRAMING`: `This is a scheduled message from the user`; it is the block's second line, after the bracketed marker, and the dynamic field lines are unchanged (line 13).
- Data flow: a one-shot message still appends `schedule_id_json`, `occurrence_at` and `reminder_prompt_json`; a recurring batch still appends `reminders_json`.
- Non-obvious design decisions: the fixed line states the *origin*, and the previous line marked the payload untrusted — that instruction is dropped deliberately, so the change "accepts the residual risk that model-authored text arrives under a user-origin line", with an explicit reintroduction condition (line 15). The reason is that the Host cannot attest the user typed the prompt: `schedule_create`/`schedule_update` let the model write it, and a model-written prompt can carry text the model read from the web, files or command output.
- Edge cases / failure handling: framing-line forgery is closed by *encoding* — the schedule id and prompt are JSON strings, the occurrence instant is a validated canonical RFC 3339 value, and each occupies one line, so a prompt carrying embedded newlines or an `occurrence_at:`-style line cannot add framing lines (line 15).
- Surprising: the note records a *missing harness capability* instead of a fixture: no scenario patch controls the wall clock the schedule runtime reads, and the snapshot harness seeds Sessions rather than the schedule storage domain, so no committed fixture contains a `schedule` message (line 27); the delivered text is instead pinned by five full-string assertions plus `expectReminderFraming` in the Web e2e.

### .agents/notes/implemented/architecture/2026-09-24-scheduled-message-framing.zh.md
- Purpose: Chinese translation of the scheduled message framing note; five hashed sections.
- Key abstractions: same shared `SCHEDULED_MESSAGE_FRAMING` constant.
- Data flow: same — one fixed line plus unchanged dynamic field lines.
- Non-obvious design decisions: same — the accepted residual risk and its reintroduction condition.
- Edge cases / failure handling: same — encoding closes framing-line forgery.
- Surprising: same — the missing harness clock-control capability is recorded instead of a fixture.

### .agents/notes/implemented/architecture/2026-09-25-session-log-otel-byte-limits.i18n.yaml
- Purpose: pairing record for the session-log OTLP byte limits note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-session-log-otlp-strings-and-bounded-requests`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the mechanism and the bound.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note replaces count-based batching with byte-based batching, and the record replaces "does the other language exist" with "does the other language have the same bytes".

### .agents/notes/implemented/architecture/2026-09-25-session-log-otel-byte-limits.md
- Purpose: bound telemetry requests by bytes rather than by record count.
- Key abstractions: the shared `otel` Cordis plugin owns ordinary-event and Session-log transport implementations; business adapters inject it and create independent caller-owned channels (line 13).
- Data flow: each canonical event becomes `eventName: "session-log"` with `sessionId` and JSON-stringified event values in `content`; redaction runs before serialization and the copied envelope excludes the payload (line 13).
- Non-obvious design decisions: each record is measured **once** with the SDK serializer *including a full envelope*, and the sum conservatively bounds a combined request; greedy packing avoids full-candidate serialization and recursive re-encoding (line 15). Counting compressed bytes or characters is rejected for a specific reason: collector limits can apply after decompression, and characters omit UTF-8 and escaping overhead (line 25).
- Edge cases / failure handling: single oversized records receive one diagnostic and do not block later events; one HTTP request owns the transport slot until settlement, even after its watchdog fires, and shutdown expiry stops the remaining queue (line 15). Queue overflow, oversize rejection, exit and transport failure can lose data — no durable outbox or acknowledgement is added (line 29).
- Surprising: one string for the entire Session is rejected, because one large Session would exceed the request ceiling even when each event fits — one event per record preserves event identity *and* permits batching (line 21); and the SDK batch deadline rule is replaced because "SDK batch deadlines cannot own an operation split into multiple HTTP requests" (line 17).

### .agents/notes/implemented/architecture/2026-09-25-session-log-otel-byte-limits.zh.md
- Purpose: Chinese translation of the session-log OTLP byte limits note; five hashed sections.
- Key abstractions: same shared `otel` plugin with per-adapter channels.
- Data flow: same — one event per record, redaction before serialization.
- Non-obvious design decisions: same — measure once with the envelope; greedy packing.
- Edge cases / failure handling: same — oversized record diagnosed once, no blocking; data loss accepted without an outbox.
- Surprising: same — one-record-per-event preserved deliberately.

### .agents/notes/implemented/architecture/2026-09-26-cua-application-consent.i18n.yaml
- Purpose: pairing record for the CUA application consent note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-application-consent-for-native-computer-use`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the consent subject.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's distinction — OS privilege vs user choice of target app — is exactly the kind of distinction the per-section hash protects from being flattened.

### .agents/notes/implemented/architecture/2026-09-26-cua-application-consent.md
- Purpose: require an explicit human decision before the agent acts on a chosen application.
- Key abstractions: the CUA executor owns application consent for every object-API and native-tool dispatch; it uses the existing User Questions service for human decisions and the provider's existing profile configuration for saved grants (line 13).
- Data flow: a saved identity combines the canonical executable path with a verified designated signing requirement, represented by a SHA-256 digest; the path prevents authorization from following a copied application and the signing requirement distinguishes replacements while allowing matching signed updates (line 15).
- Non-obvious design decisions: macOS privileges authorize an *execution host*, not a user's choice of target application, and retained app and window objects can outlive that choice (line 9). Unverifiable and ad-hoc applications receive task access only, tied to a process instance and Agent connection lifetime; labels never establish identity.
- Edge cases / failure handling: cold application selection prepares an executable identity and handle *without launching*, so a refused application is never started (line 17). Removing a saved grant invalidates Agent connections retaining the application's handles and cancels active operations; reauthorization uses a fresh connection, so old app and window snapshots cannot become valid again (line 21). Selections of the same application within one task are serialized, so a pending question cannot produce competing decisions.
- Surprising: revoking one application also invalidates *other* application handles on the same Agent connection, and those applications require fresh selection — while saved grants remain reusable and task grants expire (line 35).

### .agents/notes/implemented/architecture/2026-09-26-cua-application-consent.zh.md
- Purpose: Chinese translation of the CUA application consent note; five hashed sections.
- Key abstractions: same executor-owned consent with User Questions + profile grants.
- Data flow: same — path + designated signing requirement as a SHA-256 identity.
- Non-obvious design decisions: same — OS privilege ≠ target-app consent; labels are not identity.
- Edge cases / failure handling: same — prepare-without-launch; revocation invalidates handles and requires a fresh connection.
- Surprising: same — revoking one app invalidates other handles on the same connection.

### .agents/notes/implemented/architecture/2026-09-27-progressive-office-skills.i18n.yaml
- Purpose: pairing record for the progressive Office skills note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-progressive-office-skills-with-ordinary-shell-execution`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the execution substrate.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's claim — no dedicated renderer tool — is achieved by making the *shell* the execution substrate; the record's own execution substrate is a hash.

### .agents/notes/implemented/architecture/2026-09-27-progressive-office-skills.md
- Purpose: give the model Office authoring and rendering skills without a second discovery path or a second permission model.
- Key abstractions: the Office provider lists a compact router and six format-specific authoring or operation skills; the model loads full instructions by name and selects rendering for appearance-focused changes unless the user explicitly skips it (line 14).
- Data flow: rendering uses a private, randomly named temporary directory inside the task workspace and removes it after inspection; skills invoke the shared Python checker and the configured LibreOffice Kit CLI through ordinary Bash or PowerShell.
- Non-obvious design decisions: a dedicated renderer tool is rejected — "A small typed schema constrains rendering arguments, but requires its own execution configuration, scoped registration, projection, and activation lifecycle" — and the CLI operation skills accept shell quoting and model-selected arguments in exchange for reusing the existing approval, sandbox, cancellation and output mechanisms (line 22). Rendering tool activation is rejected because shell tools already own execution permissions and process management, and a missing renderer can prevent loading otherwise usable editing guidance (line 9).
- Edge cases / failure handling: carriers own interpreter and resource locations; operation skills append the configured Node and CLI paths only when their bodies are loaded, and loading instructions does not prepare engines or authoring payloads (line 16). Rendering failures preserve usable sources and stop visual checks — "successful commands alone cannot establish usable images" (line 32).
- Surprising: subskills are *not* hidden from the catalogue, because that would require a generic visibility policy independent of invocation permission; listing seven short summaries keeps the existing skill API while full bodies stay demand-loaded (line 24).

### .agents/notes/implemented/architecture/2026-09-27-progressive-office-skills.zh.md
- Purpose: Chinese translation of the progressive Office skills note; five hashed sections.
- Key abstractions: same compact router plus six format skills.
- Data flow: same — random temp dir inside the workspace; shared checker and Kit CLI via Bash/PowerShell.
- Non-obvious design decisions: same — the dedicated-renderer rejection; the CLI's quoting cost.
- Edge cases / failure handling: same — loading instructions prepares no engines; rendering failure preserves sources.
- Surprising: same — subskills stay in the catalogue with short summaries.

### .agents/notes/implemented/architecture/2026-09-29-explicit-session-history-preparation.i18n.yaml
- Purpose: pairing record for the explicit session history preparation note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-open-the-session-when-migration-is-required`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the user-visible action.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's answer to a technical problem is "make the user open the session" — and the record's answer to a translation drift is "re-record the hash".

### .agents/notes/implemented/architecture/2026-09-29-explicit-session-history-preparation.md
- Purpose: make a fork or catalog expansion on an old-format Session an explicit user action rather than a silent migration.
- Key abstractions: the WorkspaceBrowser row-menu fork request carries `allowMigration: false`, and the Host checks `stat` format information before calling the original fork flow (line 13).
- Data flow: only a source format requiring migration is refused, with an app-wide Toast offering to open the original Session; that action only navigates and does not retry the fork. Other fork callers omit the option and allow automatic migration.
- Non-obvious design decisions: residency and stored format are different things, so treating every cold Session as needing migration "would reject otherwise valid forks and discard catalog information available on disk" (line 29). Globally forbidding auto-migrating forks is rejected because "the sidebar's interaction choice does not govern other callers, so its request explicitly carries the restriction" (line 31).
- Edge cases / failure handling: `session.projections` also checks the stored format first; current-format cold history still uses the original observation flow for exact projections. Success returns `kind: sequenced` and its real `asOfSeq`; required migration returns `kind: migration-required` hints, and cached values cannot replace sequenced values published by history or control (line 17). Ordinary loading, cancellation and storage errors do not become this branch.
- Surprising: giving cached hints `asOfSeq: -1` is rejected because "hints have no event cut in current history and cannot participate in sequence comparisons" (line 37) — the same `asOfSeq` reasoning as the projection-cache note, arrived at independently.

### .agents/notes/implemented/architecture/2026-09-29-explicit-session-history-preparation.zh.md
- Purpose: Chinese translation of the explicit session history preparation note; six hashed sections.
- Key abstractions: same `allowMigration: false` request option.
- Data flow: same — refuse only migration-requiring sources, offer "open the original session".
- Non-obvious design decisions: same — residency ≠ stored format; the restriction travels with the request.
- Edge cases / failure handling: same — `kind: sequenced` vs `kind: migration-required`.
- Surprising: same — the `asOfSeq: -1` rejection for hints.

### .agents/notes/implemented/architecture/2026-09-30-profile-package-refresh-and-manifest-invalidation.i18n.yaml
- Purpose: pairing record for the package-refresh note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-refresh-runtime-resolution-after-package-operations-and-expire-hmr-package-configuration`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both halves of the split.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's central insight — "package configuration and module evaluation have separate caches" — is the same class of error the pairing record exists to prevent between two renderings.

### .agents/notes/implemented/architecture/2026-09-30-profile-package-refresh-and-manifest-invalidation.md
- Purpose: make installed packages actually take effect while the process runs.
- Key abstractions: three owners with distinct duties (line 18-22): the resolver's `replace()` may remove `scope: profile` entries and profile-local names and change a retained profile entry's version in place but touches no Node cache; the plugin-manager calls `pluginPackages.refresh()` at fixed points of package operations (without HMR) and never constructs resolutions or manages caches; HMR expires package configuration and preserves ordinary reloads for manifests loaded as JSON modules.
- Data flow: publication points are enumerated per operation (line 36-41): with HMR, inside HMR's recomposition after the dropped rows stopped and before the generation applies; without HMR, after the profile files are saved and before reconciliation, or after pnpm remove succeeds — and a *failed or cancelled* install publishes nothing.
- Non-obvious design decisions: clearing a plugin's module cache does not refresh the package.json fields Node uses for `exports`, `main`, `imports` and format detection, and a package.json can itself be imported as a JSON module needing ordinary module reloads (line 12) — so the two caches need two owners. The implementation wraps Node internals: `readPackageJSON`, `getPackageScopeConfig`, `getPackageType`, `package_json_reader.getNearestParentPackageJSON`, the ESM loader's `ResolveCache` prototype `get`, CJS `Module._pathCache` and `Module._load` (lines 68-74).
- Edge cases / failure handling: package configuration below expired directories is parsed in JavaScript and must keep the native reader's field and error semantics, so tests compare it with the native reader on Node 22, 24 and 26 (line 116). A published-then-rejected resolution does not roll back the completed package operation — the result reports the runtime application failure and keeps the successful disk changes (line 47).
- Surprising: the implementation "depends on several Node internal interfaces, and these tests must run again for Node upgrades" (line 117); and a pending startup-bundle disablement without HMR defers later publications until restart, preserving running plugins' mappings (line 114).

### .agents/notes/implemented/architecture/2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md
- Purpose: Chinese translation of the package-refresh note; six hashed sections.
- Key abstractions: same three-owner split (resolver / plugin-manager / HMR).
- Data flow: same — enumerated publication points per operation.
- Non-obvious design decisions: same — package configuration and module evaluation need separate caches and separate owners.
- Edge cases / failure handling: same — JS-parsed manifest must match native reader semantics across Node 22/24/26; no rollback of a successful package operation.
- Surprising: same — the Node-internal dependency and the mandatory re-run on Node upgrades.

### .agents/notes/implemented/architecture/2026-09-30-structured-draft-initialization.i18n.yaml
- Purpose: pairing record for the structured draft initialization note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-initial-draft-content-and-structured-reference-restoration`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both halves.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's subject — restoring a draft *structurally* rather than as text — is the same care the record takes with a document's structure.

### .agents/notes/implemented/architecture/2026-09-30-structured-draft-initialization.md
- Purpose: put unsent content (text *and* chips) into the composer without losing the chip's provenance.
- Key abstractions: `DraftSnapshot` contains `text` and `references`; each reference retains `offset`, `length`, `source`, `ref`, `label`, `appearance`, `clipboardText` and its invalid flag, and reference spans must be ordered, non-overlapping and equal to the corresponding `clipboardText` (line 19).
- Data flow: initial import finishes before `InputHub.shellFor()` returns, without React effects restoring text; existing input objects are not restored again; React mounts the same editor and binds the existing persistence callback (line 13).
- Non-obvious design decisions: saving only the *text* projection loses the chips' source, target and presentation fields when the input object is disposed, and filling the composer after mounting cannot guarantee the first input-model read contains the complete document (line 9). The snapshot excludes Lexical NodeKeys, DOM, runtime occurrenceIds, functions and temporary highlights — so it is a serialisable document, not a live editor state.
- Edge cases / failure handling: the public `SessionInput.setDraft` and `InputActions.setDraft` accept only text; internal structured restoration reuses the editor's reference restoration without listing directories or reading files. A string represents input without structured references, and an ambiguous `@` query never selects a file automatically (line 21). Legacy string drafts restore as plain text, because missing reference information cannot be reconstructed losslessly (line 86).
- Surprising: reference changes must reach persistence *even when the visible text does not change* (line 23), and the async skill matcher re-matches the current document on lexicon arrival rather than saving the text from when the request was issued — so it never overwrites chips, selection or Undo history (line 64).

### .agents/notes/implemented/architecture/2026-09-30-structured-draft-initialization.zh.md
- Purpose: Chinese translation of the structured draft initialization note; six hashed sections.
- Key abstractions: same `DraftSnapshot` with positional reference spans.
- Data flow: same — import completes before `shellFor()` returns; no React-effect restoration.
- Non-obvious design decisions: same — text-only projection loses chip provenance.
- Edge cases / failure handling: same — legacy strings restore as plain text; ambiguous `@` never auto-selects.
- Surprising: same — reference-only changes must persist; late lexicon arrival re-matches without touching Undo.

### .agents/notes/implemented/architecture/2026-10-01-replace-changed-package-modules-on-recomposition.i18n.yaml
- Purpose: pairing record for the package module replacement note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-replace-plugins-whose-loaded-package-files-changed-during-profile-recomposition`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the trigger condition.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about detecting *changed files*; the record detects *changed text* — same technique, different domain.

### .agents/notes/implemented/architecture/2026-10-01-replace-changed-package-modules-on-recomposition.md
- Purpose: make an upgraded package actually load its new code, without a restart.
- Key abstractions: `Hmr.reconcileProfile()` is the one recomposition path used by HMR's profile watches and by Plugin Manager, and it runs inside `runExclusive()`; Plugin Manager only edits profile files and runs pnpm, and refuses to install over an installed package it can name before pnpm runs (line 15).
- Data flow: the six steps (line 17-22) are: read patches and compare loaded modules with disk; plan replacement; evict replaceable changed modules and their importers; stop the Loader entries running the replaced plugins by deleting their runtimes; call app-boot's `recomposeProfile()` once; evict the loaded modules below the dropped mappings' directories.
- Non-obvious design decisions: Node caches an evaluated module by file URL, and pnpm's hoisted layout keeps the path `node_modules/<name>` whatever the version, so overwriting a package returns the cached module of the previous version (line 9). `ModuleFiles` records inode, size and modification time — but deliberately **not** ctime, because pnpm hard-links from its store and adding a link elsewhere changes ctime while the content is unchanged (line 26). The comparison uses no version numbers, because the lockfile records no content identity for `file:` and `link:` dependencies (line 44).
- Edge cases / failure handling: a changed module whose importers reach the process entry's static graph or a plugin no Loader entry owns stays loaded with its importers and is reported (line 21). If no generation applied, the published resolution and the stopped rows are restored and the stopped entries start again. A failed cleanup remains retryable and prevents process reuse.
- Surprising: `reconcileProfile()` returns `pending` naming each stale module and its reason (`host-module`, `unmanaged-plugin`, `module-comparison`), and Plugin Manager turns `pending` into `restart-required` with that reason, so the Web page localises the reason and the agent tool writes a `nextStep` — "therefore no interface parses diagnostic strings" (line 32).

### .agents/notes/implemented/architecture/2026-10-01-replace-changed-package-modules-on-recomposition.zh.md
- Purpose: Chinese translation of the package module replacement note; five hashed sections.
- Key abstractions: same single `reconcileProfile()` path inside `runExclusive()`.
- Data flow: same — six-step recomposition.
- Non-obvious design decisions: same — inode/size/mtime but not ctime; no version-number comparison.
- Edge cases / failure handling: same — host-graph modules stay loaded; failed publication restores stopped rows.
- Surprising: same — the `pending` reason codes flow to a `nextStep` so no UI parses diagnostics.

### .agents/notes/implemented/architecture/2026-10-05-anonymous-reasoning-translation.i18n.yaml
- Purpose: pairing record for the anonymous reasoning translation note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-anonymous-translation-remains-separate-from-model-history`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the separation guarantee.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's rule — the translated text must not enter model history — and the record's rule — the translation must not drift from the source — are the same concern applied to prose instead of reasoning.

### .agents/notes/implemented/architecture/2026-10-05-anonymous-reasoning-translation.md
- Purpose: translate reasoning for the reader without touching model history.
- Key abstractions: the experimental translator owns explicit Google or Bing routing, provider-language normalization and bounded network requests; its Service Definition and both providers share one package (line 13).
- Data flow: the GUI registers a translation wrapper in the standard `conversation.chat.reasoning.body` Slot and calls the official `conversation.chat.reasoning.content` Factory for original or translated text; only *expanded* bodies start translation, and collapsing, changing selection or unloading aborts outstanding work and excludes late results (line 17).
- Non-obvious design decisions: there is **no provider fallback** — "a local failure cannot authorize uploading speech to a cloud service" is the voice case, and here "Silently try another endpoint after failure … sends potentially private text to another operator without an explicit selection" (line 25). Rewriting reasoning in the Session or provider stream is rejected because it changes the original trajectory and can affect model reasoning passback. Enabling the bundle permits transmission of expanded reasoning to the chosen service, disclosed in plugin metadata and settings.
- Edge cases / failure handling: translated text neither replaces persisted assistant output nor enters model input; the original always remains available.
- Surprising: the GUI wrapper owns its toolbar and passes its localized labels to the Factory, which supplies default labels when callers omit them and fixes compact typography — so a third-party wrapper never imports private official React components (line 17).

### .agents/notes/implemented/architecture/2026-10-05-anonymous-reasoning-translation.zh.md
- Purpose: Chinese translation of the anonymous reasoning translation note; five hashed sections.
- Key abstractions: same explicit Google/Bing routing with no fallback.
- Data flow: same — Body Slot wrapper calling the official content Factory; only expanded bodies translate.
- Non-obvious design decisions: same — no silent provider switching; no rewriting of the trajectory.
- Edge cases / failure handling: same — original always available; late results excluded.
- Surprising: same — the wrapper owns its labels and toolbar.

### .agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.i18n.yaml
- Purpose: pairing record for the official on-demand bundles note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-discover-official-bundles-without-installing-their-runtimes`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the discovery-without-install property.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note separates "Official" (project maintenance) from "optional delivery" and "experimental maturity"; the record similarly separates a note's identity from the translations of it.

### .agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.md
- Purpose: let users discover native agent integrations without paying their runtime cost up front.
- Key abstractions: `ON_DEMAND_BUNDLES` admits the Claude Code and Codex bundles to an installation-owned catalog that embeds their package-owned localized metadata and icons, so discovery works offline without resolving or importing either package (line 13).
- Data flow: selection reuses the ordinary third-party bundle installer, profile dependency, Host row patches, compatibility evaluation, progress, cancellation, registry fallback and build-script approval; native authentication and configuration remain provider-owned.
- Non-obvious design decisions: the *running installation* owns the target — published applications offer the exact DSH release version and save an exact registry dependency pin, while source Web and development Desktop offer ordinary `link:` dependencies into the same checkout as the running CLI (line 17). A development checkout can share a version string with different published code, so replacement compares the *source* as well as the version; an incomplete checkout does not fall back to the registry.
- Edge cases / failure handling: Off only deselects; Remove remains separate and refuses while the bundle's rows are in use. Activation failure can retain the saved dependency and selection — there is no rollback (line 37). Catalog verification rejects missing metadata, unsupported membership and stale generated content.
- Surprising: "Official identifies project maintenance; optional delivery and experimental maturity remain independent properties" (line 13) — and the sibling naming note makes the same three-way split for experimental status.

### .agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.zh.md
- Purpose: Chinese translation of the official on-demand bundles note; five hashed sections.
- Key abstractions: same installation-owned `ON_DEMAND_BUNDLES` catalog with embedded metadata.
- Data flow: same — reuse of the ordinary third-party installer path.
- Non-obvious design decisions: same — the running installation owns the target; source vs version compared separately.
- Edge cases / failure handling: same — Off vs Remove; no rollback on activation failure.
- Surprising: same — Official ≠ optional ≠ experimental.

### .agents/notes/implemented/architecture/2026-10-05-paid-native-flash-reasoning-translation.i18n.yaml
- Purpose: pairing record for the paid native Flash translation note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-paid-native-flash-translation-uses-independent-queries`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the independence property.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's requirement — that a paid translation never inherit the conversation's history — and the record's — that a translation never inherit content the source did not have.

### .agents/notes/implemented/architecture/2026-10-05-paid-native-flash-reasoning-translation.md
- Purpose: offer model-based translation without contaminating the conversation request.
- Key abstractions: only active built-in `deepseek-account` and `deepseek-official` owners with configured credentials and the exact `deepseek-flash` catalog ID qualify; display names and versions do not participate and pi-ai routes are excluded (line 13).
- Data flow: each fragment receives one fresh text-only query, a simple translation instruction and disabled thinking; no previous fragment or main history is supplied. The original Session keeps `plugin:translator/request` with the exact model-visible input in optional `metadata.modelRequest` before dispatch.
- Non-obvious design decisions: reusing the conversation's model call is rejected because its history, model and thinking settings are unrelated to a translation fragment, and session-log delivery could transmit more than the selected text (line 19). Translation does not supply the main Session identity to the native request extensions, so a fragment cannot authorize uploading its full conversation log (line 15).
- Edge cases / failure handling: read-only cache lookup precedes native admission and needs no live Session; a cache miss uses the active Session writer and flushes before dispatch, and the GUI joins normal Session activation when needed, retrying once (line 15). Failures never choose another route.
- Surprising: reopening reuses persisted successful results *even when native credentials or model configuration are unavailable* (line 27), and the Host enforces the configured paid choice before billing (line 15).

### .agents/notes/implemented/architecture/2026-10-05-paid-native-flash-reasoning-translation.zh.md
- Purpose: Chinese translation of the paid native Flash translation note; five hashed sections.
- Key abstractions: same narrow qualification (exact `deepseek-flash` id, two built-in owners).
- Data flow: same — one fresh text-only query per fragment.
- Non-obvious design decisions: same — no conversation history; no session-log authority.
- Edge cases / failure handling: same — cache lookup before native admission; cached results survive missing credentials.
- Surprising: same — Host-side billing enforcement before the call.

### .agents/notes/implemented/architecture/2026-10-05-persistent-machine-translation.i18n.yaml
- Purpose: pairing record for the persistent machine translation note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-machine-translation-results-use-shared-session-records`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the shared-record mechanism.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's "one shared record format for every provider" is the same instinct as "one shared record format for every language".

### .agents/notes/implemented/architecture/2026-10-05-persistent-machine-translation.md
- Purpose: make a translation survive reopening the reasoning panel or restarting the app.
- Key abstractions: the translator owns `plugin:translator/request` and `plugin:translator/result` for *every* provider; a request records its selected provider, exact source text, source and target languages, and recipe identity; a result references the request's Session sequence and retains the completed translated text (line 13).
- Data flow: requests are durable before dispatch and results are durable before they return to the GUI; read-only lookup precedes provider work, and new records use the active Session's existing writer through `appendPluginRecord` and a targeted flush (line 17).
- Non-obvious design decisions: identity includes the provider *and* the recipe, so changing the receiver, language or translation settings cannot substitute another result (line 15). A disclosure-only cache is rejected because reopening loses the displayed value and sends the same text again, with possible repeat charges. Giving anonymous and model translations different result formats is rejected — the reader needs the same source-to-translation relationship from every provider.
- Edge cases / failure handling: an uncached inactive Session rejects before provider work, and the GUI consumer joins normal Session controller activation and retries once (line 17). Only completed persisted results supply cached text; failed or incomplete attempts do not. A completion already in the append-only log may survive a late caller cancellation.
- Surprising: a translation may wait for normal Session activation, including preset startup hooks, resume markers, interrupted-turn repair and any required generation migration — "these ordinary lifecycle effects can append context; translation does not bypass them" (line 35); the translator owns no second writer and requires no core lifecycle changes.

### .agents/notes/implemented/architecture/2026-10-05-persistent-machine-translation.zh.md
- Purpose: Chinese translation of the persistent machine translation note; five hashed sections.
- Key abstractions: same shared `plugin:translator/request`/`result` records for all providers.
- Data flow: same — durable before dispatch, durable before return.
- Non-obvious design decisions: same — identity includes provider and recipe.
- Edge cases / failure handling: same — inactive Session rejects before provider work; only completed results cache.
- Surprising: same — translation waits for normal Session activation and inherits its context appends.

### .agents/notes/implemented/architecture/2026-10-05-shared-agents-root-instructions.i18n.yaml
- Purpose: pairing record for the shared agents root instructions note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-shared-agents-root-joins-the-user-global-instruction-chain`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the chain.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's deduplication-by-content rule is the same rule the record applies — one digest decides which member of a candidate group renders.

### .agents/notes/implemented/architecture/2026-10-05-shared-agents-root-instructions.md
- Purpose: load shared cross-tool instructions without copying them into the harness home.
- Key abstractions: the user-global instruction scope has two ordered roots, `$DSH_HOME/AGENTS.md` first, then `<agentsHome>/AGENTS.md`; `resolveAgentsHome`/`agentsHomeDisplay` in `dsh-home-paths` own the resolution for both `dsh-agent-instructions` and `dsh-skill-filesystem` (line 13).
- Data flow: the two files are candidates of one candidate group; they deduplicate by *trimmed content*, so identical copies render once from the harness home, and an unobservable candidate preserves the group's last-good state (line 15).
- Non-obvious design decisions: path identity is rejected as the duplicate test, because the common layout is `$DSH_HOME/AGENTS.md` symlinked to `~/.agents/AGENTS.md` — "two paths for one file" — and path identity drops neither, so the same text would render twice under two display labels (line 29). The two roots are *not* alternatives: loading the shared root only when the harness-home file is absent "makes a DSH-specific file silently suppress the shared one instead of composing with it" (line 25).
- Edge cases / failure handling: a duplicate of budget-retained content keeps being reconciled, so deleting or changing the retained candidate promotes it; a byte-budget omission leaves that candidate and its content duplicates unprobed. The two user-global files share one fate on probe failure, because one digest decides which member renders (line 36).
- Surprising: the harness-home file keeps the `user-global` scope key that earlier sessions recorded, while the shared file carries `agents-global` — and the scope *directory* stays out of model-visible prose, with a colliding project path rendered with a leading `.` so it keeps its own scope (line 17).

### .agents/notes/implemented/architecture/2026-10-05-shared-agents-root-instructions.zh.md
- Purpose: Chinese translation of the shared agents root instructions note; five hashed sections.
- Key abstractions: same two ordered roots with content-based dedup.
- Data flow: same — one candidate group, last-good state preserved on probe failure.
- Non-obvious design decisions: same — content, not path, is the duplicate test.
- Edge cases / failure handling: same — shared fate on probe failure.
- Surprising: same — the `agents-global` scope key and the escaped project directory name.

### .agents/notes/implemented/architecture/2026-10-06-web-desktop-plugin-identity-compatibility.i18n.yaml
- Purpose: pairing record for the plugin identity compatibility note; six section hashes (adds the deferred-naming-cleanup subsection).
- Key abstractions: en/zh digests under `/agent-note-preserve-web-and-desktop-plugin-identities-across-experimental-consolidation`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the deferred-cleanup subsection is hashed separately, so a translation cannot quietly drop the list of deferred renames.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note is about *not* renaming things; the record preserves a rename list it will not perform.

### .agents/notes/implemented/architecture/2026-10-06-web-desktop-plugin-identity-compatibility.md
- Purpose: move capabilities into the experimental directory without breaking users' installed profiles.
- Key abstractions: the moved packages retain the published names declared by the typed `experimental-package-policy.ts` directory-to-name map — the sole maintained inventory of naming exceptions (line 13).
- Data flow: existing badge, Ralph and native delegation row IDs remain valid Host row selectors; later user layers still replace configuration or disable rows.
- Non-obvious design decisions: renaming a published package or an existing configuration row "can make a working Web or Desktop customization require edits unrelated to the capability's behavior" (line 9). Publishing aliases or keeping duplicate compatibility rows is rejected: parallel identities need continuing resolution and removal rules and can register the same capability twice.
- Edge cases / failure handling: selecting an optional bundle is still explicit — a patch targeting an absent row does not select its bundle (line 15). The isolation check still rejects experimental dependencies of nonexperimental bundles.
- Edge cases / failure handling: the deferred-cleanup table (line 21) names exactly what *would* be renamed later and why each is deferred; directory moves or pre-stable API status alone do not retire the exceptions, and a later cleanup requires an explicit release and migration decision, an inventory of affected configurations, and installed-profile upgrade evidence.
- Surprising: public APIs remain pre-stable and new output metadata stays required "unless an actual consumer needs an accommodation" (line 17) — pre-stability is used as a reason to *keep* requirements, not to relax them.

### .agents/notes/implemented/architecture/2026-10-06-web-desktop-plugin-identity-compatibility.zh.md
- Purpose: Chinese translation of the plugin identity compatibility note; six hashed sections.
- Key abstractions: same typed naming-exception map.
- Data flow: same — existing row IDs stay valid selectors.
- Non-obvious design decisions: same — no aliases, no parallel identities.
- Edge cases / failure handling: same — explicit bundle selection; deferred-cleanup table with reasons.
- Surprising: same — pre-stability keeps requirements rather than relaxing them.

### .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.i18n.yaml
- Purpose: pairing record for the desktop shell configuration note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-desktop-shell-configuration-independent-of-the-host`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the independence.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note argues for a second configuration store with clear ownership; the record is a second store of the note's own text with clear ownership.

### .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md
- Purpose: let Electron-owned features read their preferences before or without the Host.
- Key abstractions: Electron main owns `userData/desktop/settings.json` independently of Host startup and Cordis evaluation (line 13).
- Data flow: ownership follows *runtime dependencies*: Electron-owned functions needing configuration before Host startup or while the Host is unavailable use shell configuration; Host plugin settings, including shared Web/Desktop preferences, continue to use Cordis (line 15).
- Non-obvious design decisions: putting every preference in Cordis is rejected — "Reading `cordis.patch.yml` directly in Electron duplicates configuration evaluation; a patch alone omits plugin defaults and other configuration layers" (line 21). Moving every setting shown in Desktop is rejected because interface placement does not imply a Host-independent requirement.
- Edge cases / failure handling: a unified settings *interface* can use separate storage owners (line 15); the `desktop` subdirectory groups shell configuration without relocating existing files.
- Surprising: the note is explicitly an evaluation *direction*, not a scheduled migration or a predefined list — "Existing settings are candidates for individual evaluation when their functionality changes or a Host-independent use is required" (line 27).

### .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.zh.md
- Purpose: Chinese translation of the desktop shell configuration note; five hashed sections.
- Key abstractions: same Electron-owned `settings.json`.
- Data flow: same — ownership follows runtime dependencies.
- Non-obvious design decisions: same — direct `cordis.patch.yml` reading duplicates evaluation.
- Edge cases / failure handling: same — unified interface, separate storage owners.
- Surprising: same — the migration is an evaluation direction, not a plan.

### .agents/notes/implemented/architecture/2026-10-08-persistent-ptc-sandbox.i18n.yaml
- Purpose: pairing record for the retained PTC file-policy note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-retained-ptc-processes-follow-file-policy`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the subject and the rule.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note and the record are both about "the thing that retains state must follow policy".

### .agents/notes/implemented/architecture/2026-10-08-persistent-ptc-sandbox.md
- Purpose: make a retained Node process obey the Session's file policy.
- Key abstractions: `persistent-in-memory` starts its Node process through the same sandbox provider as `per-call`; a retained owner uses one resolved mode, workspace root and Session identity until release (line 13).
- Data flow: the [PTC-owned cleanup note](2026-10-09-ptc-owned-policy-cleanup.md) supersedes this note's permission-setter completion and cleanup-ownership decision — permission changes commit synchronously, PTC owns immediate cancellation and waits internally before subsequent execution.
- Non-obvious design decisions: retaining JavaScript variables does not require broader file access (line 9). Changing the *running* process policy is rejected: existing backends apply restrictions at launch, and arbitrary retained objects, open handles and background work cannot be transferred into another policy with the existing interface — so the environment is released instead (line 23).
- Edge cases / failure handling: an approved one-time escalation omits the state owner and receives a fresh temporary environment, released before the call returns; it cannot access standing variables and its declarations do not survive, while the standing environment keeps its original policy and variables (line 17).
- Surprising: the provider rejects inconsistent reuse — a runtime consumer must release a retained owner before supplying a different policy without a Session mode change (line 31).

### .agents/notes/implemented/architecture/2026-10-08-persistent-ptc-sandbox.zh.md
- Purpose: Chinese translation of the retained PTC file-policy note; five hashed sections.
- Key abstractions: same sandbox provider for both PTC modes.
- Data flow: same — policy change invalidates retained environments; PTC owns the wait.
- Non-obvious design decisions: same — variable retention does not justify broader file access.
- Edge cases / failure handling: same — one-time escalation gets a fresh temporary environment.
- Surprising: same — the provider rejects inconsistent reuse.

### .agents/notes/implemented/architecture/2026-10-09-composer-command-chip.i18n.yaml
- Purpose: pairing record for the composer command chip note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-claimed-commands-as-atomic-composer-chips`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the mechanism (an atomic chip).
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note exists because a styled TextNode transform looped Lexical into error #14; the record exists because a doc drifted once; both are "make the failure structural instead of probabilistic".

### .agents/notes/implemented/architecture/2026-10-09-composer-command-chip.md
- Purpose: represent a claimed slash command as an atomic chip instead of styled leading text.
- Key abstractions: a claim replaces the leading trigger span with `CommandChipNode`, an atomic inline `DecoratorNode`, followed by the token's argument separator as an ordinary text node (line 13).
- Data flow: outside a submit transaction the machine's claim follows the document — `draft-changed` carries the leading chip's claim, so deleting or displacing the chip releases the claim and a history restore re-enters claimed (line 17).
- Non-obvious design decisions: the reason for the change is a concrete Lexical failure — the styled TextNode transform split typed overflow back out, Lexical merged same-style neighbours before the overflow node's own transform ran, and the split/merge looped until Lexical aborted the update with error #14 and the DOM diverged from editor state (issue #4490) (line 9). Keeping literal text and repairing each gesture is rejected: "Every gesture that reaches the boundary node needs its own proof".
- Edge cases / failure handling: deletion is two-step — a character deletion that reaches the chip from a collapsed caret marks it selected (`data-selected`), and the next deletion in the same direction removes it whole; deletions are decided on both the character-deletion command and deletion input events, because iOS applies a ranged `deleteContentBackward` without that command (line 19). A key whose dispatch produced no character deletion, a click, blur, or a caret that leaves the chip clears the mark, so macOS Ctrl+H keeps it.
- Surprising: the persisted draft records the leading chip's *claim token* (`DraftSnapshot.command`), never the claim; on restore the input asks the trigger pipeline's `resolveClaim`, which awaits the source's catalog and answers only a claim, never invoking or executing the command — unlike Enter's `matchEnter` (line 20).

### .agents/notes/implemented/architecture/2026-10-09-composer-command-chip.zh.md
- Purpose: Chinese translation of the composer command chip note; five hashed sections.
- Key abstractions: same atomic `CommandChipNode` DecoratorNode.
- Data flow: same — the claim follows the document outside a submit transaction.
- Non-obvious design decisions: same — the Lexical error #14 split/merge loop is the stated cause.
- Edge cases / failure handling: same — two-step deletion; iOS ranged-delete handled.
- Surprising: same — only the claim *token* is persisted, and restore never executes the command.

### .agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.i18n.yaml
- Purpose: pairing record for the shared native CUA helper note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-shared-native-cua-process-with-agent-scoped-state`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the sharing model.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's root cause was an *executable-path-derived identity* collision; the record's identity is a content digest — the same lesson applied to a different subject.

### .agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.md
- Purpose: share one native CUA service per executable content digest, with per-Agent state.
- Key abstractions: one user shares a native service per executable *content digest* across Agents and Hosts; a version lock elects the service and an additional canonical-executable-path lock prevents different builds published at one path from running together (line 13).
- Data flow: the managed startup command hands service lifetime to its client connections, and the last connection's completed cleanup ends the service; each Agent connection owns its application handles, AX snapshots, limits and cancellation state; a FIFO orders complete desktop operations including clipboard transactions (line 15).
- Non-obvious design decisions: the root cause was specific — on macOS 26.6.2 `replayd` derives capture-client identity from the executable *path*, so two live helpers at the same path repeatedly replace each other's connections even when their screenshot requests are sequential; byte-identical executables at distinct real paths complete captures, and two symlinks to one executable reproduce the failure (line 9).
- Edge cases / failure handling: cancellation and timeout first stop one request and wait for acknowledgement; a timed-out screenshot retains the single system-RPC slot until the real callback completes, and new screenshots fail with `CAPTURE_BUSY` instead of accumulating requests; late pixels are discarded (line 17). An operation or cleanup that cannot stop can invalidate the process, making every old handle unusable. Uncertain input is never replayed automatically.
- Surprising: an app handle grants no exclusive use of the application, and two Hosts can race to start the service and receive the same instance — so Agent A can retain an app object while Agent B screenshots and changes the same application (line 25); the historical DeepSeek failures have matching RPC errors, but their competing-client identity "was not recovered from retained logs" (line 25).

### .agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.zh.md
- Purpose: Chinese translation of the shared native CUA helper note; five hashed sections.
- Key abstractions: same per-content-digest service with per-Agent connections.
- Data flow: same — FIFO-ordered desktop operations, response writes independent.
- Non-obvious design decisions: same — path-derived capture identity as the root cause.
- Edge cases / failure handling: same — `CAPTURE_BUSY`, late pixels discarded, no automatic input replay.
- Surprising: same — app handles are not exclusive; the historical identity was unrecoverable.

### .agents/notes/implemented/architecture/2026-10-09-message-node-factories-and-delegates.i18n.yaml
- Purpose: pairing record for the domain image Slots note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-domain-image-slots-and-a-shared-gallery-factory`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the two-layer model.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note separates "one implementation" from "one replacement position"; the record separates "one note" from "one translation" the same way.

### .agents/notes/implemented/architecture/2026-10-09-message-node-factories-and-delegates.md
- Purpose: let image presentation be replaced per domain while sharing one gallery implementation.
- Key abstractions: each domain declares its own image Slot and supplies the framework's `renderSlot` seat to the component that renders it; the official attachment entries use one reusable Content Factory (line 13).
- Data flow: the attachment plugin fills all four image Slots with the same `MessageImages` React adapter at priority 100; a smaller priority replaces only the selected domain's entry, and disposing that replacement restores the official entry (line 23).
- Non-obvious design decisions: one shared image Slot for every caller is rejected — "A replacement intended for one domain would also affect the others; shared implementation does not require shared replacement identity" (line 37). Passing custom image-rendering functions or supplying the loader through a private Context is rejected, because framework Slot seats already express rendering authority while explicit loader props preserve the caller's Session authority.
- Edge cases / failure handling: the shared gallery never searches for a global current Session — persistent reads use the loader supplied by the caller, while submission-echo previews retain their existing browser URLs (line 29). Unloading the attachment implementation removes its entries without removing the Slots declared by the owning domains (line 50).
- Surprising: the shared Factory neither declares the domain Slots nor selects a domain from a scene parameter, and there is no image-entry Factory that exists solely to forward one Slot call (line 25).

### .agents/notes/implemented/architecture/2026-10-09-message-node-factories-and-delegates.zh.md
- Purpose: Chinese translation of the domain image Slots note; six hashed sections.
- Key abstractions: same per-domain Slots plus one shared Content Factory.
- Data flow: same — priority-100 defaults, smaller priority replaces one domain only.
- Non-obvious design decisions: same — shared implementation ≠ shared replacement identity.
- Edge cases / failure handling: same — no global current Session lookup; unloading leaves domain Slots.
- Surprising: same — no forwarding-only image Factory.

### .agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.i18n.yaml
- Purpose: pairing record for the peer-scoped connect handshake note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-peer-scoped-connect-handshake`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the scoping.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the filename still says "operator" while the note's title and content have moved to "Peer" — and the hash record is the only place that still records the old name, in the filename.

### .agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.md
- Purpose: give CLI and MCP callers independent participation in forwarded events without disturbing browser auth.
- Key abstractions: browsers keep their signed cookie, root launch-token exchange, shared `connection.browserPeer` with owner principal and `interactions: 'answer'`; only API callers create independent Peers through `GET /connect?token=<launch-token>&interactions=answer|none`, which is API-only, defaults to `none`, and rejects invalid or repeated declarations with 400 (line 13).
- Data flow: connect publishes the API Peer before returning; its signed API Cookie carries the authority, Peer id and issue/expiry interval, and interaction participation belongs to the live Peer rather than another credential field (line 17). One API lifecycle WebSocket owns the Peer; duplicate attachment is refused, and closure removes the Peer before asynchronous disposal completes.
- Non-obvious design decisions: publishing only after an upgrade, or requiring Mux readiness before a unary call, is rejected — "Both reject or delay valid HTTP that arrives first. Connect is the publication point" (line 37). Deadlines and pending/bound activation states are rejected as the price of reclaiming lightweight idle records.
- Edge cases / failure handling: already-admitted unary requests keep their request-level cancellation semantics, and closing the lifecycle socket does not cancel independent HTTP requests or accepted Session work (line 20). A terminal claim-stream failure can reject a foreground question — for this note, raw stream failure is terminal and the caller owns any new connect and retry.
- Surprising: an API caller may exit after connect without establishing its WebSocket, and its Peer then retains only lightweight identity, scope and registry state — it may remain until Host shutdown, because "Repeated abandoned connects accumulate lightweight records, an accepted cost for authenticated local callers" (line 25). And any launch-token holder may request `answer` — "this is interaction participation, not user isolation" (line 53).

### .agents/notes/implemented/architecture/2026-10-09-operator-scoped-connect-handshake.zh.md
- Purpose: Chinese translation of the peer-scoped connect handshake note; six hashed sections.
- Key abstractions: same API-only `/connect` producing independent Peers.
- Data flow: same — connect publishes the Peer before returning; the lifecycle socket owns it.
- Non-obvious design decisions: same — connect is the publication point; no idle sweep.
- Edge cases / failure handling: same — unary requests keep their own cancellation.
- Surprising: same — abandoned connects accumulate lightweight records; `answer` is not user isolation.

### .agents/notes/implemented/architecture/2026-10-09-ptc-owned-policy-cleanup.i18n.yaml
- Purpose: pairing record for the PTC-owned policy cleanup note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-ptc-owns-policy-change-cleanup-waits`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the ownership of the wait.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note moves a wait from the *setter* to the *owner* — the same relocation the record performs by moving the truth from prose to a hash.

### .agents/notes/implemented/architecture/2026-10-09-ptc-owned-policy-cleanup.md
- Purpose: stop a permission change from blocking unrelated callers on process teardown.
- Key abstractions: permission setters commit synchronously — "Success means the selected policy is recorded; it does not guarantee that operations admitted under the old policy have completely stopped" (line 13).
- Data flow: PTC observes committed Session mode changes; the tool bridge immediately cancels affected complete calls including pending approvals and nested tools; a later PTC call waits for cancelled predecessors to settle before resolving the latest standing policy (line 15).
- Non-obvious design decisions: waiting in the permission setters is rejected because no current permission consumer requires that guarantee, and it would introduce a general resource registry plus an asynchronous API migration for PTC-specific cleanup (line 19). Cleaning up only on the next PTC call is rejected because an idle environment can retain background work indefinitely when no further call occurs.
- Edge cases / failure handling: the Node provider immediately invalidates affected processes including idle environments, starts cleanup, and retains the cleanup Promise internally; a later program waits for that cleanup, and a failed cleanup remains retryable and prevents process reuse (line 15). Unchanged modes preserve environments.
- Surprising: permission changes return without process-cleanup latency and cleanup failure does not roll back the recorded policy — so old operations may remain active while cancellation finishes (line 27); the Webhook creation path keeps its synchronous permission step, so that step adds no cancellation window before prompt admission.

### .agents/notes/implemented/architecture/2026-10-09-ptc-owned-policy-cleanup.zh.md
- Purpose: Chinese translation of the PTC-owned policy cleanup note; five hashed sections.
- Key abstractions: same synchronous commit with PTC-owned wait.
- Data flow: same — bridge cancels immediately, later calls wait.
- Non-obvious design decisions: same — no general resource registry.
- Edge cases / failure handling: same — failed cleanup retryable and blocks reuse.
- Surprising: same — no rollback of the recorded policy; Webhook keeps its synchronous step.

### .agents/notes/implemented/architecture/2026-10-09-reasoning-content-slot-factory.i18n.yaml
- Purpose: pairing record for the reasoning Body Slot / Content Factory note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-standard-reasoning-body-slot-and-reusable-content-factory`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names both halves of the two-layer model.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note separates "the position that accepts registrations" from "the implementation anyone can call" — the record does the same for a note and its translation.

### .agents/notes/implemented/architecture/2026-10-09-reasoning-content-slot-factory.md
- Purpose: let third parties replace the reasoning body without giving up the official renderer.
- Key abstractions: `conversation.chat.reasoning.body` is a `single`, `session` Slot declared by the Assistant node registration; `conversation.chat.reasoning.content` is a `root` Factory provided by `ui-chat` that accepts text, streaming state and optional labels, supplies default labels and fixes `variant="compact"` (line 19).
- Data flow: the Chat plugin registers the Content Factory *independently of any Body occupant*, so replacing a body does not remove the base implementation (line 22); third parties wait for the Body declaration through `slots.inject` and register with a smaller priority.
- Non-obvious design decisions: the render position and the base implementation serve different purposes — the position accepts registrations and lets the framework select one, while any component can call the implementation directly; calling the base implementation must not repeat plugin selection or require a Session (line 11). An optional renderer parameter making the host choose between direct rendering and a chain fallback is rejected because it leaves the default body outside the registration system and forces plugins to maintain another Markdown call.
- Edge cases / failure handling: the Factory receives no Session identity, reads no Session and owns no translation state; `root` expresses the absence of a Session dependency while each render position still has an independent React instance. Multiple third-party registrations follow existing single-slot priorities — they do not form middleware and do not render multiple bodies together (line 30).
- Surprising: the Body remains an *exclusive* replacement position — "This design does not automatically compose multiple text-transformation plugins or turn display transformations into redaction or model-input modification" (line 102); and the old Slot name, chain-selector registrations and header-action callback are unsupported, so third parties must migrate (line 100).

### .agents/notes/implemented/architecture/2026-10-09-reasoning-content-slot-factory.zh.md
- Purpose: Chinese translation of the reasoning Body Slot / Content Factory note; six hashed sections.
- Key abstractions: same two-layer Slot/Factory model.
- Data flow: same — Factory registered independently of any Body occupant.
- Non-obvious design decisions: same — position and implementation have different purposes.
- Edge cases / failure handling: same — `root` scope means no Session dependency; single-slot priorities, no middleware.
- Surprising: same — the Body stays exclusive; old registration forms unsupported.

### .agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.i18n.yaml
- Purpose: pairing record for the stored credential precedence note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-stored-credentials-take-precedence-over-the-launch-environment`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the precedence rule.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note reverses a precedence in order to remove a contradiction; the record's digests are the mechanism that makes such a reversal checkable.

### .agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.md
- Purpose: make credential precedence identical for every provider.
- Key abstractions: `LocalCredentialProvider` resolves a reference in a fixed order — `$DSH_HOME/.credentials.yaml` (provider-managed) > inherited process environment > `<invocation cwd>/.env` > `$DSH_HOME/.env` (line 18-22).
- Data flow: a save always writes the winning layer, so `describe` reports `writable: true` for every reference, and `set`/`unset` never refuse a name because it is exported; `resolve`/`describe` still report the supplying layer as `source` (line 24).
- Non-obvious design decisions: the old order made two kinds of stored credential have *opposite* precedence — pi-ai's resolvers read the credential stored under `llm-pi-ai/<provider>` before any environment variable, while a key stored by the Models page under a reference lost to the same exported name, so "which credential a request used … depended on the provider family" (line 11). A stored credential now wins for every provider.
- Edge cases / failure handling: refusing a write while only the launch environment supplies the name is rejected, because under the new order such a write takes effect and refusing it "would block the first save of a key for every exported name" (line 36). Warning when a stored value hides an exported variable is rejected as per-resolution comparison cost; the Models page help text states the order and `describe` reports the layer.
- Surprising: the per-run override is gone by design — "There is no per-run flag above the store. A one-run override takes a separate `DSH_HOME`" (line 44) — and the note's opening line records that the headless-environment-auth decision partially supersedes it (line 7).

### .agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.zh.md
- Purpose: Chinese translation of the stored credential precedence note; five hashed sections.
- Key abstractions: same four-layer resolution order.
- Data flow: same — a save always writes the winning layer; `source` still reported.
- Non-obvious design decisions: same — one precedence for every provider.
- Edge cases / failure handling: same — write refusals removed; no shadow warnings.
- Surprising: same — a one-run override now needs a separate `DSH_HOME`.

### .agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.i18n.yaml
- Purpose: pairing record for the user-text candidate scheduling note; six section hashes (adds verification).
- Key abstractions: en/zh digests under `/agent-note-user-text-candidate-scheduling-and-facts-driven-refresh`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the two halves.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note's design — a *pure logic* evaluator whose scheduling is assertable without React or timing — is mirrored by a record that makes the document's structure assertable without reading it.

### .agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.md
- Purpose: recognise references in user text deterministically, and refresh only what a Facts change actually affects.
- Key abstractions: every rule provides an ID, finite order and a synchronous `match(text, from, context)`; each call returns its nearest eligible node with `start >= from`, or no candidate anywhere in the remaining original text — one node, not all matches and not a replacement document (line 17).
- Data flow: one reconciliation loop keeps original text, the previous successful segmentation, registered definitions, per-rule Facts reads and query results; it selects the smallest candidate start, breaks same-start ties by ascending rule order and stable ID, emits the preceding raw Text gap, emits the winner, and advances the cursor (line 27).
- Non-obvious design decisions: the original string and UTF-16 offsets remain intact — "a search cursor does not create a new word, line, or quoted-token boundary" (line 17). Matching depends only on original text and Facts, not on previously selected node payloads. A rule's own `from` offset drives the search so the matcher must implement forward search rather than re-collecting all matches on each call (line 39).
- Edge cases / failure handling: previously accepted nodes are reusable *output*, not a complete list of possible matches — a losing candidate can become visible when an earlier winner disappears, so the evaluator retains queries rather than treating an old Text node as evidence of no match (line 31). A query from `q` that returned a candidate starting at `s` is valid for any requested cursor `c` with `q <= c <= s` (line 35).
- Surprising: the performance evidence is the *exact scheduling count and query offsets*, and the semantic evidence compares a refreshed output with a fresh evaluator — "This mechanism requires no browser end-to-end or elapsed-time benchmark tests" (line 91); and `context.read(key)` records reads *including `undefined`*, so a rule that reads a missing field still invalidates on that field's change (line 43).

### .agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.zh.md
- Purpose: Chinese translation of the user-text candidate scheduling note; six hashed sections.
- Key abstractions: same one-rule-type, one-candidate-protocol model.
- Data flow: same — single reconciliation loop with cursor and cached queries.
- Non-obvious design decisions: same — original coordinates preserved; matching depends only on text and Facts.
- Edge cases / failure handling: same — losing candidates can reappear; query validity range `q <= c <= s`.
- Surprising: same — the evidence is scheduling counts, not wall-clock benchmarks.

### .agents/notes/implemented/architecture/2026-10-11-chat-group-tree-exchanges.i18n.yaml
- Purpose: pairing record for the chat group-tree exchanges note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-chat-group-tree-positions-and-exchanges`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the mechanism.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note fixes a 596 px blank with a *position taxonomy*; the record fixes drift with a *per-section digest* — both are "make the invariant a first-class value".

### .agents/notes/implemented/architecture/2026-10-11-chat-group-tree-exchanges.md
- Purpose: stop a background notice from folding the conversation and leaving the reader with blank space.
- Key abstractions: `ChatConversationViewNode.groupTree` declares a Node's position in the group tree, typed `ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'` and ordered outermost first; a Node at a position also has the effect of every inner position (line 15).
- Data flow: `GroupTreeSegments(position)` splits the loaded Turns at the Turns holding a Node at that position; the latest segment starts at the last opening Turn, or at the first loaded Turn when the window holds none; it counts per Turn incrementally without scanning loaded Nodes, and a start move returns only the Turns that entered or left the latest segment.
- Non-obvious design decisions: a notice is neither body text nor a user message, so folding and bottom advancement ignore it; the bottom changes from the last Turn to the latest exchange (line 13). The *human opening* is marked, not the notice: the host claims the waking input right after `turn/start`, assembles the system prompt, and only then logs `step/start` and `user/message` — the recorded Session spent 187 ms in that gap, and marking only the notice would fold and reopen the previous Turn during it (line 24).
- Edge cases / failure handling: a claim that mixes a notice with human input needs extra classification, and a kind-based list cannot separate Step-1 steering from mid-Turn steering (line 30); publishing Turn-level Location data is rejected because only one Context may publish a key for a Turn while the opening input comes from several message Contexts (line 32).
- Surprising: the measured symptom was specific — the notice woke the next Turn 13–15 ms after the previous Turn ended, and the minimal reproduction left 596 px blank that had not recovered after five seconds (line 9); and under "On next message" a long run of notice-woken Turns (up to 31 goal-mode Turns in sampled Sessions) stays expanded until the human types again (line 46).

### .agents/notes/implemented/architecture/2026-10-11-chat-group-tree-exchanges.zh.md
- Purpose: Chinese translation of the chat group-tree exchanges note; six hashed sections.
- Key abstractions: same four-position group-tree taxonomy.
- Data flow: same — `GroupTreeSegments` splits loaded Turns incrementally.
- Non-obvious design decisions: same — the human opening is marked, not the notice; the 187 ms gap is inert.
- Edge cases / failure handling: same — kind lists and Turn-level Location data rejected.
- Surprising: same — 596 px blank; 31 goal-mode Turns stay expanded.

### .agents/notes/implemented/architecture/2026-10-12-exclusive-conversation-matches.i18n.yaml
- Purpose: pairing record for the exclusive conversation matches note; six section hashes (adds testing).
- Key abstractions: en/zh digests under `/agent-note-exclusive-conversation-matches`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the claim mechanism.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note introduces a one-word concept (`exclusive: true`) to replace a whole aggregation mechanism; the record introduces a one-line key to replace "is the translation in sync".

### .agents/notes/implemented/architecture/2026-10-12-exclusive-conversation-matches.md
- Purpose: let a business Definition claim an event so a generic one does not also build a node for it.
- Key abstractions: a match result may claim its event on the Definition's target — `readonly exclusive?: true` on `ConversationMatchResult` (line 19).
- Data flow: `ConversationNodeAssembler.dispatchInput()` evaluates every match of one event into two reused arrays *before accepting any*, then settles claims; other Definitions of a claimed target build no Context for the event, and that target's unmatched-event fallback does not run (line 25).
- Non-obvious design decisions: definition precedence (`specific`/`default`) is rejected — "dispatch would become a priority order rather than a statement of which Definition presents an event", and a claim needs no change to the generic Definition, while two claims fail instead of silently ranking (line 32). A registry of human-authored sources is rejected because it would require reassembling every bound Conversation and the text rule would need the message source as a fact.
- Edge cases / failure handling: two claims on one target, or a claim from a Definition without a target, throw during dispatch and name the event, its `seq` and the claiming Definition kinds (line 26). A conflicting claim fails at *dispatch* rather than at registration, because claims are decided per event from event data.
- Surprising: the shipped case is a UI-level artefact: Chat's generic `input-message` Definition matched every appended `user/message`, so the late question reply was presented twice, and Chat worked around it by dropping the duplicate `turn-trigger` presentation by message id in both the Turn-owned and unscoped paths — a workaround that left the duplicate Node in the Node Store and visible to every other Chat reader (line 11). The claim removes the need for the workaround entirely.

### .agents/notes/implemented/architecture/2026-10-12-exclusive-conversation-matches.zh.md
- Purpose: Chinese translation of the exclusive conversation matches note; six hashed sections.
- Key abstractions: same `exclusive?: true` claim on the match result.
- Data flow: same — all matches evaluated before any is accepted; claims settle afterwards.
- Non-obvious design decisions: same — precedence rejected in favour of an explicit claim.
- Edge cases / failure handling: same — double or target-less claims throw at dispatch.
- Surprising: same — the duplicate-node workaround is removed at the source.

### .agents/notes/implemented/architecture/2026-10-12-headless-environment-auth.i18n.yaml
- Purpose: pairing record for the headless environment auth note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-headless-jobs-omit-the-interactive-credential-store`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key states the omission.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note removes a store to change behaviour — a different shape from the sibling note that reorders a store to change behaviour.

### .agents/notes/implemented/architecture/2026-10-12-headless-environment-auth.md
- Purpose: stop a headless job from silently using the GUI's saved account.
- Key abstractions: the shipped headless bundle disables the base `credentials`, `authorization` and `deepseek-account` rows; API-key adapters already support compositions without the credentials service and resolve through the launch snapshot — process environment, invocation-directory `.env`, then Harness-home `.env` (line 13).
- Data flow: the profile does not read, migrate, write or delete `.credentials.yaml`; dependent authorization and account rows are disabled explicitly so ordinary jobs do not emit pending-service warnings.
- Non-obvious design decisions: changing reference precedence alone would leave pi-ai provider records and saved grants ahead of the environment, so the store is *omitted* rather than reordered (line 9). A second precedence mode in the store is rejected: "It introduces configuration and record-handling policy into the shared provider when existing adapter fallbacks and profile overrides already supply the required behavior" (line 23).
- Edge cases / failure handling: a provider requiring stored sign-in or the DeepSeek account route fails until the user restores stored authentication, and restoring it also restores saved-first precedence (line 27).
- Surprising: disabling only the credentials row is rejected, because it would leave the authorization and account providers pending and produce a warning on every launch (line 21) — a configuration decision made for *log noise* as much as for security.

### .agents/notes/implemented/architecture/2026-10-12-headless-environment-auth.zh.md
- Purpose: Chinese translation of the headless environment auth note; five hashed sections.
- Key abstractions: same disabled `credentials`/`authorization`/`deepseek-account` rows.
- Data flow: same — three-layer environment snapshot resolution.
- Non-obvious design decisions: same — omit the store rather than reorder it.
- Edge cases / failure handling: same — restoring stored auth restores saved-first precedence.
- Surprising: same — the pending-service warning is part of the reason for disabling all three rows.

### .agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.i18n.yaml
- Purpose: pairing record for the peer principal note; the shard's largest record, with a deeply nested key tree.
- Key abstractions: en/zh digests under `/agent-note-peer-principals-and-method-level-remote-access-control`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key tree mirrors the note's own nested structure (scope → peer model → identity types → lifecycle → method-level access control → RBAC mapping → resources → roles/bindings/policies → snapshot stream → client face → security invariants → message source → review standards → migration list).
- Edge cases / failure handling: digest mismatch only.
- Surprising: the pairing record for a 675-line note is still just a flat list of hashes — the structure is preserved without a byte of prose.

### .agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md
- Purpose: make a Remote method know *who* is calling and refuse methods the caller may not invoke — the shard's most complete mechanism.
- Key abstractions: two layers. **Principal** = the caller identity permission decisions read (`share-viewer{shareId, actor}` proven by a share token; the local user `{ kind: 'owner' }`); **Peer** = the lifetime scope of one connection. One principal has N peers (line 34-35).
- Data flow: the Gateway resolves a call to *resources* — a `{ kind: 'global' }` or a `{ kind, id }` of a declared kind — using per-kind readers on `@Remote({ resources })`, then lookup parameters and Context identities that declare that kind's `resource`, then the kind's default wire field (line 219). It asks `remoteAccess.decide({ principal, action, resources, args })`; a non-owner is allowed only when some binding's role explicitly lists the action, and *every* listed resource must be allowed (AND) (line 155).
- Non-obvious design decisions: identity is assigned by in-process Host code and **no wire field can set or override it** — principal is read-only, `createPeer()` has no route, and args' extra top-level fields are rejected by `assertExactArguments` (line 15, line 500). There is **no implicit Peer fallback**: the required parameter turns a missed Peer into a compile error, because a default Peer silently grants owner identity (line 579). Resources do **not** inherit: a `global` grant does not imply any session or workspace grant (line 156). A call that resolves no resource falls to `global`, so only an explicit global role can allow it — default deny everywhere.
- Edge cases / failure handling: the Gateway checks `peer.signal.aborted` *before* reading the wire payload, so a disposed Peer carrying a malformed payload still gets `gateway/peer-disposed` (line 127). `bindings()`, condition or `explain()` throwing makes the decision `policy-failed` and, when computing a snapshot, a thrown `bindings()` means the principal has *no* grant — a broken rule cannot break the shared `$events` source, the snapshot stream or page rendering; the first failure per policy is logged once (line 332). An invalid resource is refused with `remote-access/denied` reason `resource-invalid` *without* asking `decide()`.
- Surprising: authorization runs at steps 3-4 of the call, **before** lookup and Context resolution, so an unauthorized call never activates a session or produces any other side effect (line 398). The decision and the frontend's visibility snapshot come from one source: for the same principal, action and resource (without arguments) the snapshot answer equals `decide()` (line 451). The snapshot carries only *endpoint* actions, never `event:<name>`, and the Client never makes a request to check access — it reads a pushed stream.

### .agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md
- Purpose: Chinese translation of the peer principal note; the shard's largest translation, 675 lines mirroring the English's structure.
- Key abstractions: same principal/peer two-layer split with the same cardinality table.
- Data flow: same — resource resolution precedence, `decide()` with AND over resources.
- Non-obvious design decisions: same — no wire field can set the principal; no implicit Peer; no resource inheritance; default deny.
- Edge cases / failure handling: same — `peer-disposed` checked before payload read; `policy-failed` isolation; `resource-invalid` without asking `decide()`.
- Surprising: same — authorization precedes lookup/Context resolution so no session is activated; the snapshot and `decide()` share one source; the Client hook never makes a request.

### .agents/notes/implemented/architecture/2026-10-13-chat-single-fold-motion.i18n.yaml
- Purpose: pairing record for the chat single fold motion note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-one-fold-motion-for-collapsing-on-the-next-message`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the unification ("One fold motion").
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note deletes a *second code path*; the record deletes the possibility of a second *wording*.

### .agents/notes/implemented/architecture/2026-10-13-chat-single-fold-motion.md
- Purpose: replace two scroll fold paths with one, so a fold above the reader no longer blanks the viewport.
- Key abstractions: `flow-motion.ts` hands every batch of closing rows to the `InputFoldDriver` the viewport supplies, and `use-chat-viewport.ts` chooses one of two landings when the batch begins (line 30).
- Data flow: the driver's four steps are `begin` (measure the boxes, choose the landing), `prepare` (grow the room before box writes so the browser does not clamp an intermediate frame), `frame` (write box heights and scrollTop together), `finish` (install the final room) (line 34).
- Non-obvious design decisions: the old split keyed on `ownInput`, which held for only three signals — a local transcript echo (`submissionId`), a steer echo (`steeringId`), or the last list row being a user message (`lastIsUser`) — and in the commit where the Host records the opening input the Turn's process control is ordered *after* that input, so `lastIsUser` does not hold (line 14). Every human input without a transcript echo on this page therefore took the generic path, which reserved the closing height as bottom room and left the whole viewport blank.
- Edge cases / failure handling: the generic path's `reserve` callback, `pendingReserve`/`pendingGrowth` computation, `reserveBelow` and `followAfterFold` are **deleted**; `reclaimBelow` and `resetBelow` are kept. A row that starts closing or revealing while a batch runs keeps its current size and does not run its own transition until the batch settles (line 41). Focus protection keeps a focused closing row open — and if it is a height-capped process group its body shrinks to the cap immediately, before the batch begins, so the reader-content-still landing cannot measure it (line 92).
- Surprising: the cost of the unification is stated — "with a short body, content never sliding back still leaves the deficit until new content fills it" (line 91); and the subagent echo gap is diagnosed precisely: when echoes were introduced, `subagents.prompt` carried no request id, so an echo could not be matched with the message the child recorded; the Host now records `SubagentPromptRequest.requestId` as the child message's `source.rpcId` (line 26).

### .agents/notes/implemented/architecture/2026-10-13-chat-single-fold-motion.zh.md
- Purpose: Chinese translation of the chat single fold motion note; five hashed sections.
- Key abstractions: same single `InputFoldDriver` with two landings.
- Data flow: same — begin/prepare/frame/finish batch steps.
- Non-obvious design decisions: same — the `ownInput` three-signal limitation and the deleted generic path.
- Edge cases / failure handling: same — in-batch rows keep size; focus protection shrinks before the batch.
- Surprising: same — the short-body deficit is the accepted cost; the subagent `source.rpcId` fix.

### .agents/notes/implemented/architecture/2026-10-13-context-breakdown-system-prompt-state.i18n.yaml
- Purpose: pairing record for the context breakdown note; five section hashes.
- Key abstractions: en/zh digests under `/agent-note-context-breakdown-retains-only-system-prompts`.
- Data flow: `verify-translation-pairing --write` maintains it.
- Non-obvious design decisions: the key names the retained subset.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the note shrinks state by 65×; the record shrinks a 675-line note to a handful of hashes — the same "keep only what the invariant needs" move.

### .agents/notes/implemented/architecture/2026-10-13-context-breakdown-system-prompt-state.md
- Purpose: stop the context-breakdown checkpoint from growing with the number of messages.
- Key abstractions: `breakdown-projection.ts` retains the surviving `system/message` nodes in surface order with their heuristic prices, one running surface total, and at most one armed shadow-price claim; state version 6 discards version-5 rows (line 13).
- Data flow: an append adds its price; a `system/message` append also joins the end of the system list. `compaction/summary` and `compaction/prune` arm a claim from `shadowedRange`, `shadowedTokenCount` and the retained system prompts named by `shadowedSeqs`; the next event consumes or expires it (line 16).
- Non-obvious design decisions: the old design kept one `{ seq, heuristicTokens, system }` entry per retained surface node so that any replacement could subtract the exact price of its range — its checkpoint therefore grew with the message count, and in a corpus of 836 Sessions, 151,122 entries made the unit's rows 7.13 MB, up to 103 KB for one Session, and *every cached Session listing validated all of them* (line 9). A faster validator is rejected: it cut listing validation from 75 ms to 4.5 ms but kept the 7.13 MB, an O(surface) array copy per event and proportional checkpoint writes (line 28).
- Edge cases / failure handling: a replacement over the claimed range subtracts the claim price and drops those prompts; a replacement naming another range, or putting a `system/message` in place of a metered range, **throws** (line 16). An unmetered replacement of one retained system prompt subtracts that prompt's own price; any other unmetered replacement folds at zero delta, the rule `contextPressure` already applies.
- Surprising: the fix is verified to be *semantically identical*, not merely smaller — folding all 836 stored logs with the v5 and v6 definitions produced identical breakdowns after every event, while retained state fell from 7.13 MB to 110 KB with at most five surviving system prompts in one Session (line 24); and the stated limit is that an unmetered non-system replacement leaves the figures off by that replacement's price difference (line 36).

### .agents/notes/implemented/architecture/2026-10-13-context-breakdown-system-prompt-state.zh.md
- Purpose: Chinese translation of the context breakdown note; five hashed sections.
- Key abstractions: same retained-system-prompts-only state with one armed shadow claim.
- Data flow: same — append adds price; compaction arms the claim.
- Non-obvious design decisions: same — the 7.13 MB / 103 KB per Session diagnosis.
- Edge cases / failure handling: same — mismatched replacements throw; other unmetered replacements fold at zero.
- Surprising: same — identical breakdowns proven over 836 logs while state fell to 110 KB.

### .agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.i18n.yaml
- Purpose: pairing record for the continuous CUA hover note; the shard's one orphan record — its English `.md` and Chinese `.zh.md` belong to shard `dsh-notes-impl-arch#3`, so this file is the only member of its triplet in this shard.
- Key abstractions: en/zh digests under `/agent-note-continuous-cua-hover-without-cross-call-ownership`.
- Data flow: `verify-translation-pairing --write` maintains it; the target file is `2026-10-13-cua-continuous-hover.md` in the same directory.
- Non-obvious design decisions: the key states the ownership property — continuous hover without acquiring cross-call application ownership.
- Edge cases / failure handling: digest mismatch only.
- Surprising: the record is verifiable in isolation here: its header names `2026-10-13-cua-continuous-hover.md` and its command line targets that exact path.

## Ideas worth stealing

- **A byte-bounded upload watermark that drains a backlog instead of resending it** - `.agents/notes/implemented/architecture/2026-09-24-bounded-session-log-upload.md:12` - `session-log-deepseek.Config.maxBytes` (8 MiB) bounds the serialized `dsh_session_log` field; each request carries the *longest contiguous run after the watermark* that fits, and acceptance advances the watermark to that run's `throughSeq`. This is the transferable shape for August's own telemetry/log shipping: a naive "send everything pending" design fails catastrophically because one oversized payload makes the adapter's `JSON.stringify` throw `RangeError`, the provider reports `TRANSPORT`, the retry policy repeats the same serialization, and *every* model request in that session fails. A contiguous-run watermark (not a per-event one) means a single event that exceeds the cap blocks its own run without failing the request, and the measured numbers (269 MiB / 34 s, 182 ms vs 10 ms) tell you what the alternative costs.
- **Two cache identities: a lifecycle identity for reads, a fold identity for continuation** - `.agents/notes/implemented/architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md:52` - the same on-disk record is matched on `formatVersion + createdAt + cwd + isSeeded` when *read* and on that plus `inheritedEventCount` when *used to continue a fold*, because the cut is not derivable from a header-only read. The lesson generalises: a cache record often needs two identity tuples, one for "is this the same thing" and one for "may this continue from here", and conflating them produces exactly the bug this note fixed — 44 of 241 seeded sessions showing no title after a restart. The companion decision at line 57 is the other half: comparability is expressed by a *separate* `kind` field (`cached` vs `sequenced`), never by overloading `asOfSeq` (the sentinel alternative is rejected at line 131 because one field then carries two meanings).
- **Three-phase tool calls keyed by callId, with preparation never persisted** - `.agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.md:19` - one Tool owns `preparing` (a live delta with a call id and name) → `start` (`tool/call`, complete arguments) → `result`, and a named live delta creates the preparing row while a historical `tool/call` creates the dispatched stage directly. Two rules matter for August: (a) "equal durable events produce equal final state; intermediate presentation and preparation-group identity need not match" (line 37), so the live view may show a stage the replay never shows without the transcript diverging; and (b) preparation is deliberately *not* persisted, because durable calls and results already suffice to reconstruct the final presentation (line 57). This removes the "the model is visibly waiting and the UI shows nothing" interval without adding a persisted state.
- **Measure what the model actually generates, then encode the order in the schema** - `.agents/notes/implemented/architecture/2026-09-24-preparing-tool-arguments.md:11` - 310 controlled requests against the real API showed that reordering a JSON schema's `properties` changed nothing (0/20 for bash, 0/20 for run_code), while reordering `required` *together with* `properties` forced the description first in 10/10 forced-choice and 7/10 free Pro calls but **0/20 free Flash calls**, and only adding one sentence to the parameter description ("Provide `description` before `command` in the arguments") took free Flash to 19/20 and 20/20. The shipped fix is therefore both an ordering change in the schema DSL *and* one instruction string in the description (line 52). For August: when a UI depends on a field arriving first, measure the generation order on your real model tier before assuming the schema controls it.
- **Default-deny method-level access with a resource identity the caller cannot forge** - `.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md:155` - a non-owner is allowed only when a binding's role explicitly lists the action, and *every* resolved resource must be allowed; there is no implicit Peer (a required parameter makes a missed Peer a compile error rather than a silent owner grant, line 579) and no wire field can set the principal (line 500). Two details are worth stealing verbatim: authorization runs **before** lookup and Context resolution, so an unauthorized call never activates a session or leaves a side effect (line 398); and a throwing policy is *isolated* — `bindings()` throwing means the principal has no grant, so a broken rule cannot break the shared event source or the page (line 332). The frontend's visibility snapshot is computed from the same bindings as `decide()`, so the two cannot disagree (line 451).
- **A bounded per-stream uplink inbox that fails the whole stream, not the item** - `.agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.md:300` - each logical stream's uplink is metered in UTF-8 bytes (default 262144); on overflow the entire stream fails with `gateway/uplink-overflow` and the `uplink()` iterator ends with the same error, with *no data discarded*. The reasoning is the transferable part: a method that does not read its uplink while the client keeps sending is a usage error, and the failure exposes it explicitly rather than degrading silently. August's duplex channels (terminal input, approval answers) want exactly this: one meter, one failure, one error code — rather than per-item backpressure that lets one stuck consumer accumulate.
- **Bounded telemetry by bytes measured with the real serializer, not by record count** - `.agents/notes/implemented/architecture/2026-09-25-session-log-otel-byte-limits.md:15` - each record is measured *once* with the SDK serializer including a full envelope, and the sum conservatively bounds a combined request; greedy packing avoids full-candidate serialization and recursive re-encoding. Counting compressed bytes or characters is rejected for a specific reason: collector limits can apply after decompression, and characters omit UTF-8 and escaping overhead (line 25). One event per record is also kept deliberately, because one large session would otherwise exceed the ceiling even when each event fits (line 21).
- **Document-relative routes: the served document is the only authority on its own mount** - `.agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md:15` - exactly one `<base href="./">` is spliced into the served index, and browser references become document-relative while *server* route keys stay absolute. The reasoning is the transferable part (line 11): the mount cannot be recovered from the transport — a configured base URL is deployment input, forwarded-prefix inference makes a request header authoritative for routing, and proxy rewriting reimplements the same fact in fragments. One bundle then serves the origin root and any prefix-stripping proxy mount. The implementation detail worth copying is the boundary strip (`KEY.slice(1)`) with the browser form living beside the key constant as `*_ROUTE` (line 17).
- **A retired field is declared `never` with `@persistenceReserved` so its *history* forbids it** - `.agents/notes/implemented/architecture/2026-09-17-developer-session-changes.md:17` - `ToolAdditionBlock.tool` is an optional `never` with `@persistenceReserved`, so the schema history records the rejected field: permitting a value later is a value-type change requiring a format bump, while unrelated optional metadata stays additive. The same trick appears at `.agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.md:23` (`EpochHeader.system`). For August's persistence schemas this is a cheap way to make "we will never add this field" checkable rather than a comment.
- **A single shared translation record per note, hashed per section** - `.agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.i18n.yaml:1` - every note carries a machine record of per-heading-section en/zh digests, recomputable with one command (`pnpm run verify-translation-pairing --write <note>.md`). The digests cover only text *outside* code blocks and generated regions (line 2), and subsection headings are hashed separately (see `.agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.i18n.yaml:1`, which has ten hashes for five decision subsections plus the standard five). August's docs are bilingual; this turns "is the Chinese copy still the same decision?" from a review question into a CI check, and the header line names the exact file and the exact command to re-record it.
- **Retain only what the invariant needs — and prove the smaller state is equivalent** - `.agents/notes/implemented/architecture/2026-10-13-context-breakdown-system-prompt-state.md:24` - the context breakdown kept one entry per surface node so any replacement could subtract its exact price; 151,122 entries over 836 sessions made the unit 7.13 MB and every cached listing validated all of them. The fix keeps only the surviving system prompts, one surface total and at most one armed shadow-price claim — 110 KB, at most five prompts per session — and is *verified* by folding all 836 logs with both definitions and getting identical breakdowns after every event. The verification pattern (old and new implementations over the same corpus, compared event by event) is what makes this a steal rather than a guess; a faster validator was rejected precisely because it kept the 7.13 MB (line 28).
- **An "exclusive" match claim instead of a precedence order** - `.agents/notes/implemented/architecture/2026-10-12-exclusive-conversation-matches.md:19` - one extra optional field (`exclusive?: true`) lets a business Definition claim an event on its target, so a generic Definition does not also build a node for it. The dispatcher evaluates *all* matches of an event before accepting any, then settles claims, so the outcome is independent of registration order (line 25). Precedence (`specific`/`default`) is rejected because it turns dispatch into a priority order and needs the generic Definition's cooperation (line 32); the shipped bug was a duplicate `turn-trigger` node for a late question reply that Chat had been working around by deduplicating by message id in two separate grouping paths, leaving the duplicate in the Node Store (line 11).
- **Retain a shared service, isolate the state** - `.agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.md:13` - one native service per executable *content digest* is shared across Agents and Hosts, while each Agent connection owns its application handles, AX snapshots, limits and cancellation state. The root cause is worth noting because it is a general class of bug: the underlying system derived capture-client identity from the executable *path*, so two live helpers at the same path replaced each other's connections even for sequential screenshots, and two symlinks to one executable reproduced it (line 9) — identity derived from a mutable path is not identity.
- **Turn a layout convention into an executable contract with one owner and a manifest** - `.agents/notes/implemented/architecture/2026-09-19-window-drag-coverage-contract.md:15` - the composition rule becomes an executable model ("a point is draggable when the last collected app-region box containing it declares `drag`"), the shell declares the surface exactly once, and a manifest gate refuses a mark on any element the manifest does not name. Publishing measured rectangles from JavaScript is rejected because "one stale frame is exactly the swallow class this work removes" (line 24). August's drag/hover regions and its context-meter overlays can use the same shape: one CSS-derived rule, a manifest that names every participant, and a browser lane that executes the model rather than a checklist.

## Files skipped (with reasons)

None. All 260 files in the shard were opened and read: the 86 English `.md` notes in full, the 87 Chinese `.zh.md` translations in full (the two longest — `peer-principal-and-remote-access.zh.md` and `remote-duplex-stream.zh.md` — read in three chunks each), and all 87 `.i18n.yaml` pairing records (header, section keys and en/zh digests). No file in this shard is generated, vendored, binary or large-data, so nothing qualified for a skip.

## Uncertainties

- **The two 675/616-line notes were read in three chunks each** (English and Chinese). I read every line of both, but I did not re-read the middle sections a second time, so a sentence-level nuance in, say, the `RemoteAccessService` interface listing (`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md:315`) or the `UplinkInbox` class listing (`.agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.md:421`) is reported from a single reading.
- **The `.i18n.yaml` files were read structurally, not semantically.** I verified for all 87 that the header names its own `.md`, that line 4 carries the correct `verify-translation-pairing --write <path>` command, that each has at least one section key, and I dumped every section key and every en/zh digest. I did **not** independently recompute the digests to confirm they match the current English/Chinese text — that would require running the repo's tool, which the read-only rule forbids. So a stale-but-consistent record would not have been caught.
- **Two English notes in this shard are only partially in it.** `2026-09-11-plugin-owned-message-projections.md` and its `.i18n.yaml` are owned by shard `dsh-notes-impl-arch#1`; `2026-10-13-cua-continuous-hover.md` and `.zh.md` are owned by `dsh-notes-impl-arch#3`. I read the English `.md` of the first and the English `.md` of the second *for context* (they are the translation targets of files in my shard), but they are not in my ledger. Their absence from the ledger is a shard-assignment fact, not a skip.
- **Cross-references were not followed.** These notes link heavily to sibling notes in `../feature/`, `../process/`, `../simplification/`, `../../../../packages/**/README.md` and `docs/subsystems/*`. I did not open those; where a note states what a linked record owns, I report the note's claim, not the linked record's text. Any statement here about "the X note owns Y" is a quote of the shard's notes, not an independent check of the referenced note.
- **No code was read or executed.** Every mechanism described here is documented in the notes; the corresponding implementation in `packages/**` was not inspected, so I cannot confirm that the shipped code matches the decision text. Where a note describes behaviour with measured numbers (e.g. 596 px of blank space, 7.13 MB of cache rows, 310 controlled requests), those are the note's own measurements, and I did not re-verify them.
- **`2026-10-13-cua-continuous-hover` content is out of shard.** My shard holds only its `.i18n.yaml`; the note's own decision (continuous hover without cross-call application ownership) is therefore known to me only from the digest key and from the sibling note's cross-reference at `.agents/notes/implemented/architecture/2026-10-09-cua-shared-native-helper.md:21`, not from the note itself.
