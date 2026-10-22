# deepseek-harness / dsh-sandbox-fs

## Shard shape

This shard holds the harness's **capability-seam** layer: the seams that decide *what a model may touch* and *how a mutation is made safe*, plus the durable-storage family that sits behind them. Four groups, all TypeScript monorepo packages under `packages/`. `packages/fs/` is the filesystem seam split four ways — `fs/` (the `ctx.fs` service contract and its `fs/*` policy-event vocabulary), `fs-local/` (the host-filesystem provider with realpath identity, atomic publication and a per-target mutation lock), `fs-sandbox/` (the same provider plus a per-call mode fence), `fs-observation-policy/` (a read-before-edit gate implemented purely as event listeners), and three model-facing tool packages (`tool-fs` = read/read_image/write/edit, `tool-fs-search` = glob/grep over a packaged ripgrep, `tool-str-replace-editor` = the Claude-Code-style single editor). `packages/sandbox/` is the *process* sandbox: `sandbox/` (the `ctx.sandbox` contract, the escalation ladder and the writable-root derivation), `sandbox-local/` (per-platform runner selection: bwrap → Landlock on Linux, Seatbelt on macOS, a restricted-token runner on Windows), `sandbox-policy/` (the one policy home: deployment default + per-session override, resolved per call), and `sandbox-windows-acl/` (a raw Win32 restricted-token backend with capability-SID ACL grants, plus a bundled PowerShell diagnosis skill). `packages/storage/` is a separate concern that happens to be in this shard: a hub (`storage`), two media backends (`storage-json` in `single`/`per-record` layouts, `storage-sqlite` document-per-row), and `storage-domain`, the schema-validated, change-emitting KV layer on top. The composition runs: the policy home resolves one per-call `SandboxExecutionPolicy`; the tools ask the single-slot `fs/*` intent waterfall for a guard; the provider performs the atomic freshness check inside a per-target lock; the storage domain serialises writes on one chain and emits `domain/changed` only after durability.

---

## Per-file notes

### packages/fs/README.md
Package-group map for `packages/fs`: the seven packages, their `ctx` keys, and why the policy is a plugin rather than a service the tools inject. Carries the family stance that **file I/O takes no timeout by design** — a deadline would kill work the OS still finishes, so cancellation is a best-effort signal at syscall boundaries.

### packages/fs/README.zh.md
Chinese translation of `packages/fs/README.md` (same section tree, same line count). Read the frontmatter and overview; the English file is the authoritative source for the content it mirrors.

### packages/fs/README.i18n.yaml
Bilingual-pair consistency record for `packages/fs/README.md`: a per-heading-section hash of the English and Chinese blocks, regenerated with `pnpm run verify-translation-pairing --write`. Pure hash bookkeeping, no mechanism.

### packages/fs/fs/src/index.ts
- **Purpose:** the `ctx.fs` Service Definition — the abstract `FileSystem` class every filesystem backend implements, plus the three-event `fs/*` policy vocabulary.
- **Key abstractions:** `FsTarget` (opaque `targetKey` + model-facing `displayPath`), `FsVersion` (opaque freshness token), `FsWriteIntent` (`createIfAbsent` | `replaceIfVersion`), `FsErrorCode`; the `fs/write-intent` and `fs/edit-intent` **single-slot waterfalls** and the fire-and-forget `fs/observed` event.
- **Data flow:** `resolve(path,{cwd})` → `stat`/`readText`/`streamText`/`readBytes`/`readByteRange`/`listDir` → `writeText`/`editText` with an optional guard. `readBytes` demands `maxBytes` and fails `FS_TOO_LARGE` rather than truncating; `readByteRange` is bounded by its window instead.
- **Non-obvious design decisions:** policy stays *off* the base class — "a backend works without policy enforcement; a sandboxed or remote backend inherits no model-facing observation policy." `editText` stays *on* the seam so version check, literal match and atomic rewrite share one critical section. The `sandboxMode` getter is documented as "the capability fact the tool layer reads to advertise the escalation fields honestly" — a backend that never confines reports `undefined`.
- **Edge cases / failure handling:** `watch()` on a provider that does not implement it rejects with `FS_IO_ERROR` rather than polling; every read/list/mutation failure is a typed `FsError` with a stable code, never ad-hoc message text.
- **Surprising:** the seam arms **no I/O deadline**; cancellation is an optional per-primitive `AbortSignal`.

### packages/fs/fs/src/types.ts
- **Purpose:** the filesystem vocabulary: branded `FsTargetKey`/`FsVersion`, `FsObservation` (present | absent), `FsInfo`/`FsPathInfo`/`FsDirEntry`, the write/edit request-outcome shapes, and the `FsErrorCode` union.
- **Key abstractions:** `Branded<'FsTargetKey'>` — consumers must not parse it; `FsPathInfo` exists purely so a consumer can reject a *symlink path* before `resolve()` follows it.
- **Data flow:** none — this file is the contract both the emitters (`dsh-tool-fs`) and the policy listener (`dsh-fs-observation-policy`) import, so neither depends on the other's package.
- **Non-obvious design decisions:** the branded factories are "for backend use only — a consumer never manufactures a key". `FsObservation` distinguishes *confirmed absent* from *unseen*, which is the three-state distinction the policy gate needs.
- **Edge cases / failure handling:** `FsError` extends `HarnessError` so it carries a stable code and chains `cause`; the tool registry exposes `{name, code}` on `isError` results so retry/permission/UI layers branch on the code, not the prose.
- **Surprising:** the code list includes `FS_NOT_OBSERVED` and `FS_AMBIGUOUS_EDIT` — policy outcomes and edit-match outcomes share one taxonomy with I/O failures.

### packages/fs/fs/tests/service.spec.ts
- **Purpose:** the seam's own conformance tests — registration as `ctx.fs`, duplicate-service rejection, disposal, and each primitive's contract.
- **Key abstractions:** a minimal in-test `FileSystem` subclass; the `FsTargetKey`/`FsVersion` brand factories; `FsError` identity.
- **Data flow:** registers the provider, then calls `resolve` → `stat`/`readText`/`streamText`/`readBytes`/`readByteRange`/`listDir`/`lstat` and asserts the documented shape of each result.
- **Non-obvious design decisions:** `streamText` must yield *the same text* `readText` returns — the seam owns cross-chunk UTF-8 decoding so the policy layer never touches raw bytes.
- **Edge cases / failure handling:** `readByteRange` shortens at EOF and is empty past it; `readBytes` enforces the byte cap with `FS_TOO_LARGE`; a provider without `watch` rejects rather than polling; `stat` returns `undefined` for an absent target.
- **Surprising:** `lstat` is asserted to return path metadata *before* resolving a target — the path-shaped probe is deliberately separate from the target-shaped one.

### packages/fs/fs/package.json
npm manifest for `@deepseek-ai/dsh-fs` — ESM, `main: lib/index.js`, `files` limited to the built JS and type declarations, peer deps on `dsh-brand`/`dsh-llm`/`dsh-sandbox`/`cordis`, and a `"./src/*": "./src/*"` export so the raw sources ship for in-repo consumers. No mechanism.

### packages/fs/fs/tsconfig.json
Project-reference tsconfig extending `tsconfig.base.json`: `rootDir: src`, `outDir: lib/types`, `include: ["src"]`, with references to the vendored `cosmokit`/`cordis`, `util/brand`, `llm/llm` and `sandbox/sandbox` projects. Build wiring only.

### packages/fs/fs/README.md
Package reference for the `ctx.fs` contract: what the service lets you do, the "contract over mechanism / policy stays off the base class / `editText` stays on the seam / bounds live at this seam" design philosophy, the source map, and the invariants (branded ids are opaque; failures are typed `FsError`s; no I/O deadline).

### packages/fs/fs/README.zh.md
Chinese translation of `packages/fs/fs/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative for the content it mirrors.

### packages/fs/fs/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/fs/README.md`; the same generated shape as every other package in the group. No mechanism.

### packages/fs/fs-local/src/fsio.ts
- **Purpose:** the Cordis-free raw-I/O layer: path resolution, metadata probes, text/byte reads, the atomic write, and the literal edit.
- **Key abstractions:** `LocalTarget` (`displayPath` for humans, `targetKey` = realpath identity for machines), `PathInfo`/`PathLinkInfo`, `FsIoInternals` (a test seam that overrides every native boundary: platform, temp names, DACL copy, `ReplaceFileW`, hard-link publication, staging-dir removal).
- **Data flow:** `resolveLocalTarget` realpaths the target, or — for a missing file — realpaths the nearest existing ancestor and re-appends the missing suffix, so the key is stable across creation. Writes stage into a private `0o700` sibling directory, open the temp file `'wx'` at `0o600`, write, `fsync`, then publish: `rename()` normally, `ReplaceFileW` on Windows over an existing file, or `link()` for a guarded create.
- **Non-obvious design decisions:** the staging directory is `.<basename>.<pid>.<uuid>.tmpdir` with mode `0700` because "an owner-only staging directory next to the target" is what makes the temp file unguessable; POSIX gets `0o700`/`0o600` while Windows inherits the destination directory's DACL. Binary detection samples only the first 8192 bytes on the read path but scans the whole buffer on the edit path — an asymmetry the README names as a known limit.
- **Edge cases / failure handling:** `ENOTDIR` is translated into the structured `FS_NOT_FOUND` taxonomy rather than escaping as a raw Node error; a failed publication inspects the target afterwards so a collision is not confused with missing hard-link support; a *post-commit* staging-cleanup failure does **not** turn a committed write into a failure.
- **Surprising:** `readTextForDiff` bounds the diff basis on the **opened descriptor**, not on a prior path stat, and reads one extra byte so a file that grows after the stat cannot cause unbounded buffering.

### packages/fs/fs-local/src/index.ts
- **Purpose:** the host-filesystem provider `LocalFileSystem` — service wiring for resolve/stat/lstat/read/list/write/edit/watch over `fsio.ts`.
- **Key abstractions:** a per-target FIFO **mutation lock** (`locks: Map<targetKey, Promise>`), `Config.cwd` (resolution default only), `Config.diffBasisMaxBytes` (overwrite-presentation bound, default 10 MiB).
- **Data flow:** `writeText` takes the per-target lock, probes the target, enforces the optional guard (`createIfAbsent` → `FS_NOT_OBSERVED` if present; `replaceIfVersion` → `FS_STALE_VERSION` if absent or changed), captures a bounded `before` diff basis, calls `writeFileAtomic`, then re-probes for the new version. `editText` does the same but checks the version guard **before** literal matching.
- **Non-obvious design decisions:** the lock exists so "the read→guard→write window can't interleave, making concurrent writes/edits deterministically ordered (one wins, the rest see the new version and reject as stale)". `before`/`after` are both LF-normalized so "a CRLF overwrite must not read as every line changed" — line-ending restoration is treated as a storage detail the diff ignores. `config.cwd` is explicitly documented as "a resolution default, NOT a containment boundary".
- **Edge cases / failure handling:** a missing target on an edit reports `FS_STALE_VERSION` *whether or not* a guard was supplied; a concurrent `createIfAbsent` creator is preserved and the loser gets `FS_NOT_OBSERVED`; the diff basis is skipped (yielding `before: null`) when either side is binary, non-UTF-8, or at the byte limit.
- **Surprising:** `watch()` uses a *filtered parent-directory* watch for a file target, so readiness also covers the creation of an initially missing file — a file watch is not a file watch.

### packages/fs/fs-local/src/win32.ts
- **Purpose:** the Windows security-descriptor helpers that make atomic replacement preserve the target's DACL.
- **Key abstractions:** lazily loaded `koffi` bindings for `GetFileSecurityW`/`SetFileSecurityW`/`ReplaceFileW`/`GetLastError`; a `Win32ErrnoException` carrying both the Node-style `code` and the raw `win32Code`.
- **Data flow:** `copyFileDaclWin32(source,destination)` reads the source's self-relative DACL and re-installs it on the destination with `PROTECTED_DACL_SECURITY_INFORMATION` (blocking staging-parent inheritance); `replaceFileWin32(replaced,replacement)` calls `ReplaceFileW` so the replaced file's ACL and other replace metadata survive.
- **Non-obvious design decisions:** Koffi is loaded **lazily** "so non-Windows processes never open Win32 libraries". The DACL is copied with the PROTECTED flag, and the destination "must still be empty when confidentiality depends on this call" — the write happens after the copy, never before.
- **Edge cases / failure handling:** Win32 codes are mapped to Node-style `ENOENT`/`EACCES`/`EIO` so the provider's error taxonomy is platform-independent; every API failure throws with the syscall name, the exact code and the path.
- **Surprising:** `ReplaceFileW` is used *instead of* `rename` on Windows precisely so the destination's ACL is not reset to the directory's default.

### packages/fs/fs-local/tests/filesystem.spec.ts
- **Purpose:** the provider's end-to-end contract suite — resolve, stat, lstat, read/stream, readBytes/readByteRange, listDir, writeText, editText, symlink identity, disposal.
- **Key abstractions:** a real temp-directory fixture; the `FsIoInternals` seam to force races; `ctx.fs` resolved from a live Cordis context.
- **Data flow:** each test drives the public provider API and asserts both the returned shape and the on-disk effect.
- **Non-obvious design decisions:** the suite pins the *stat budget* — "read stats once; write and edit never stat in the tool (the gate stats zero too)" — and pins concurrency semantics: two concurrent guarded writes → one updates, the other is `FS_STALE_VERSION`.
- **Edge cases / failure handling:** covered races include a `createIfAbsent` competitor appearing after the initial probe, a dangling symlink target, a same-size rewrite with a restored mtime (version must still change), an invalid-UTF-8 prior file, and a prior file exactly at the whole-file diff bound.
- **Surprising:** "an overwrite reports LF-normalized before AND after (a CRLF rewrite is not every-line-changed)" — the diff basis is deliberately newline-normalised.

### packages/fs/fs-local/tests/fsio.spec.ts
- **Purpose:** the raw-I/O layer's unit tests: `resolveLocalTarget`, `probe`/`probeNoFollow`, `listDirectory`, `readWholeText`, `readTextForDiff`, `streamWholeText`, `writeFileAtomic` temp-file safety, `applyLiteralEdit`, `readForEdit`/`restoreLineEndings`.
- **Key abstractions:** the `FsIoInternals` hook table; a fake platform so the Windows publication path is exercised on any host.
- **Data flow:** direct calls into `fsio.ts` with no Cordis context, asserting the structured `FsError` code for each failure.
- **Non-obvious design decisions:** the suite proves the *staging* invariants: "writes through a private staging dir and owner-only temp file", "opens staging paths exclusively — a pre-existing path is never clobbered", and "does not turn post-commit staging cleanup failure into a failed guarded write".
- **Edge cases / failure handling:** covered include a mid-read `AbortError` → `FS_ABORTED`, a file that grows or shrinks between stat and read, a vanished file, an opened descriptor that is no longer a regular file, and a directory permission failure → `FS_PERMISSION_DENIED`.
- **Surprising:** "an anchored relative cwd before retaining parent traversal in a display path" — POSIX keeps physical `..` in the *display* spelling while the realpath identity stays canonical.

### packages/fs/fs-local/tests/watch.spec.ts
- **Purpose:** the watcher's lifecycle: directory watches, cancellation before and during acquisition, error reporting, and post-init error normalisation.
- **Key abstractions:** a chokidar watcher injected through `LocalFileSystem`; `AbortSignal` for init cancellation.
- **Data flow:** `watch(target, changed, signal)` → stat → decide directory vs file → acquire a chokidar watcher → await `ready` → return a close function.
- **Non-obvious design decisions:** a cancelled init must **close the already-acquired watcher** before rejecting, and an already-cancelled signal must reject *without* acquiring one at all.
- **Edge cases / failure handling:** an initialisation error is reported and the watcher closed before the rejection propagates; a watcher error after init is normalised into the `changed(error)` callback.
- **Surprising:** the file case watches the **parent directory** and filters, rather than watching the file itself.

### packages/fs/fs-local/tests/win32.spec.ts
- **Purpose:** the Windows DACL helpers' own suite — protected DACL copy, descriptor-size probe failure, DACL read failure, install and replacement failure.
- **Key abstractions:** koffi bindings faked at the API boundary; `Win32Error` shape.
- **Data flow:** `readFileDaclWin32` → `copyFileDaclWin32` → `replaceFileWin32`.
- **Non-obvious design decisions:** the suite asserts the DACL is read and installed **before** the destination is replaced, i.e. confidentiality never depends on a window where the file is unprotected.
- **Edge cases / failure handling:** a failing size probe and a failing descriptor read produce distinct, exact errors rather than a generic one.
- **Surprising:** the failure messages carry the exact Win32 code, which is what makes an "access denied" diagnosable from a log line alone.

### packages/fs/fs-local/package.json
npm manifest for `@deepseek-ai/dsh-fs-local` — ESM, `main: lib/index.js`, dependencies `chokidar@5.0.0` (the watcher) and `koffi@3.1.1` (the Win32 FFI, loaded lazily), peer deps on `dsh-fs`/`cordis`, dev deps on `dsh-llm`. No mechanism.

### packages/fs/fs-local/tsconfig.json
Project-reference tsconfig: `rootDir: src`, `outDir: lib/types`, references to the vendored `cosmokit`/`cordis`/`schemastery`, `llm/llm` and the sibling `fs` project. Build wiring only.

### packages/fs/fs-local/README.md
Package reference for the host backend: the "three ideas" section (realpath identity, atomic publication, one mutation critical section), the write/edit paths, the config table (`cwd`, `diffBasisMaxBytes`), and a candid limitations list — `config.cwd` is not a sandbox, the mutation lock is in-process only, guarded creation needs hard-link support, and the diff basis is only a presentation aid.

### packages/fs/fs-local/README.zh.md
Chinese translation of `packages/fs/fs-local/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/fs-local/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/fs-local/README.md`; same generated shape as the group. No mechanism.

### packages/fs/fs-observation-policy/src/index.ts
- **Purpose:** the read-before-edit policy: three `fs/*` listeners and the observed-state gate, with no service and no filesystem I/O of its own.
- **Key abstractions:** `ObservedStateGate` — a `WeakMap<object /* owner */, Map<targetKey, FsObservation>>`; the owner is derived from the opaque event actor as `actor.agent.session`.
- **Data flow:** `fs/observed` records presence/absence for the owner and target; `fs/write-intent` resolves unseen-or-absent → `createIfAbsent` and observed-present → `replaceIfVersion` at the observed version; `fs/edit-intent` rejects unseen with `FS_NOT_OBSERVED`, observed-absent with `FS_NOT_FOUND`, else supplies the observed version as the CAS basis.
- **Non-obvious design decisions:** the plugin registers **no service** — "without this plugin, tools retain the bare provider's unconditional mutation behavior" — so removing it can never break the tools at an injection boundary. Each intent slot is occupied outright and `next()` is never called, so the slot is first-wins by registration order. The `WeakMap` owner means "a collected session frees its state".
- **Edge cases / failure handling:** an actor with no derivable owner (a direct tool call with no agent) reads freely but can never satisfy the write/edit prior-observation policy; the `fs/observed` recorder must stay **synchronous and non-throwing** because the mutation has already committed.
- **Surprising:** a *write* observation refreshes the basis, so a write→edit cycle needs no intervening read — the policy is about freshness, not about having used the `read` tool.

### packages/fs/fs-observation-policy/src/types.ts
- **Purpose:** the one shape the policy needs — `FsObservationActor`, a structural view of the opaque event actor.
- **Key abstractions:** `{ agent?: { session?: object } }`.
- **Data flow:** the tool passes its `exec` straight through as the opaque `object` actor; the plugin narrows it to `FsObservationActor` **without importing `dsh-tools`, `dsh-agent` or `dsh-session`**.
- **Non-obvious design decisions:** the owner is `agent.session` treated as an opaque identity — the package "never reads any of its fields" — and the type is duplicated structurally rather than imported, so the policy plugin stays dependency-free.
- **Edge cases / failure handling:** the absence of `agent` or `session` is the "no owner" case, handled by the gate rather than by the type.
- **Surprising:** a whole package exists to hold a five-field interface — the point is the *absence* of an import.

### packages/fs/fs-observation-policy/tests/policy.spec.ts
- **Purpose:** the gate's own suite: registration/disposal, the two intent decisions, observed-state transitions, multi-owner isolation, single-slot first-wins, and disposal clearing state.
- **Key abstractions:** synthetic actors with/without an agent and session; two distinct owners to prove isolation.
- **Data flow:** dispatch the real `fs/write-intent` / `fs/edit-intent` waterfalls and assert the produced intent or the thrown code.
- **Non-obvious design decisions:** the suite pins "a SECOND decider registered AFTER fs-observation-policy is not reached (first-wins short-circuit)" — the single-slot contract is tested from the *loser's* side.
- **Edge cases / failure handling:** an actor with an agent but no session has no owner; a no-owner observation records nothing; present → absent → present transitions are supported for one owner.
- **Surprising:** "owner A observing does not grant owner B edit authority" — the WeakMap keying is the isolation mechanism, and it is tested explicitly.

### packages/fs/fs-observation-policy/package.json
npm manifest for `@deepseek-ai/dsh-fs-observation-policy` — ESM, no runtime dependencies, peer deps on `dsh-fs`/`cordis` only; the `"./locale/*.json"` export and `locale/*.json` in `files` carry the plugin's UI metadata. No mechanism.

### packages/fs/fs-observation-policy/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`/`llm/llm` and the `fs` project. Build wiring only.

### packages/fs/fs-observation-policy/README.md
Package reference for the policy plugin: the minimal composition, the failure vocabulary (`FS_NOT_OBSERVED` vs `FS_NOT_FOUND`), the "event gate, not method service" concept, the single-slot first-wins rule, and a limitations list (observations do not survive a session resume; a non-agent caller can never satisfy the gate; a direct `ctx.fs` read emits no `fs/observed`).

### packages/fs/fs-observation-policy/README.zh.md
Chinese translation of `packages/fs/fs-observation-policy/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/fs-observation-policy/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/fs-observation-policy/README.md`. No mechanism.

### packages/fs/fs-observation-policy/locale/en.json
Two-line locale stub: `{"meta":{"title":"fs-observation-policy"}}` — the English plugin-catalog title. No mechanism.

### packages/fs/fs-observation-policy/locale/zh.json
Chinese locale stub: title `文件编辑保护` plus a one-line description ("requires the AI to read the file before editing, and to re-confirm content when the file changes"). No mechanism.

### packages/fs/fs-sandbox/src/index.ts
- **Purpose:** `SandboxedFileSystem` — the sandbox-enforcing implementation of `ctx.fs`, extending `LocalFileSystem` and adding only a per-call **policy fence** on the two mutations.
- **Key abstractions:** `SandboxExecutionPolicy` (mode + workspaceRoot + sessionId), `writableRoots(policy)` from `@deepseek-ai/dsh-sandbox`, the structured `FS_SANDBOX_DENIED` refusal.
- **Data flow:** `writeText`/`editText` → `checkedTarget` → resolve the per-call policy → `read-only` throws → `danger-full-access` returns the caller's target → `workspace-write` **re-canonicalizes now** and requires containment under a writable root, then delegates to the inherited atomic write **with that fresh target**.
- **Non-obvious design decisions:** the fence is "a policy check in TRUSTED code over a MODEL-CONTROLLED path, NOT a kernel boundary" — the operations are the seam's own, so canonicalize-then-contain is the complete answer; kernel-grade isolation of untrusted *code* stays `ctx.shell`'s job. The residual TOCTOU is narrowed by re-canonicalizing immediately before delegating and is accepted for this threat model. Reads pass through untouched: "every mode permits reading".
- **Edge cases / failure handling:** the denial is a structured `FsError`, not stderr inference — "an in-process fence knows exactly what it refused". A missing `ctx.sandboxPolicy` with a confining backend fails at construction.
- **Surprising:** `checkedTarget` returns the target it checked, so the mutation uses the *checked* identity — "no check-here-write-there TOCTOU".

### packages/fs/fs-sandbox/src/containment.ts
- **Purpose:** the path-containment check used by the fs fence.
- **Key abstractions:** `isPathUnder(path, root, caseSensitive)` — a lexical fast path plus a filesystem-identity fallback.
- **Data flow:** compare spellings; if they differ, `stat` the root and walk the target's existing ancestors comparing `(dev, ino)`.
- **Non-obvious design decisions:** the identity fallback exists so Windows 8.3 long-name aliases and casing differences are recognised "without weakening containment to a textual approximation"; case sensitivity defaults to `process.platform !== 'win32'`.
- **Edge cases / failure handling:** a missing root returns `false`; a missing ancestor during the walk is skipped; a non-missing stat failure is rethrown rather than treated as "not under".
- **Surprising:** the fallback walks *up* from the target comparing device+inode, so a target that does not exist yet can still be proven to live under the root.

### packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts
- **Purpose:** the fence's suite: the capability fact, `read-only` denial, `workspace-write` containment, `danger-full-access`, per-call policy override, registration/HMR, and `FsError` identity.
- **Key abstractions:** a `ctx.sandboxPolicy` double whose `resolve()` returns a chosen mode and root; real temp directories for the containment cases.
- **Data flow:** call `ctx.fs.writeText`/`editText` under each mode and assert whether a file appeared on disk.
- **Non-obvious design decisions:** the suite pins the *TOCTOU direction*: "mutates the freshly checked identity, not a stale outside targetKey" — a symlinked-out directory is denied even though the tool resolved a different key.
- **Edge cases / failure handling:** covered include a `..` traversal out of the workspace, a symlinked directory pointing out, a *new* file created under a symlinked-out directory, the filesystem root as the workspace (a path ending in the separator), and a `read-only` edit leaving the original untouched.
- **Surprising:** the workspace root itself passes the fence ("path equal to a writable root"), failing only on file type — containment is not a "must be strictly inside" rule.

### packages/fs/fs-sandbox/tests/containment.spec.ts
- **Purpose:** the containment helper's unit suite.
- **Key abstractions:** `isPathUnder` with an explicit `caseSensitive` flag, exercised on any platform.
- **Data flow:** build real directories and call the helper directly.
- **Non-obvious design decisions:** the case-insensitive lexical comparison for Windows-style spellings is tested explicitly, and the alias-equivalent root is recognised by *filesystem identity* even when the target does not exist.
- **Edge cases / failure handling:** unrelated roots and missing roots are denied; a regular file used as a path segment is treated as a *missing target*, not as containment.
- **Surprising:** a path segment that is a file makes the target un-creatable, and the containment check must not read that as "under the root".

### packages/fs/fs-sandbox/package.json
npm manifest for `@deepseek-ai/dsh-fs-sandbox` — ESM, no runtime dependencies, peer deps on `dsh-fs`, `dsh-fs-local`, `dsh-sandbox` and `dsh-sandbox-policy`; `"./locale/*.json"` exported for the plugin catalog. No mechanism.

### packages/fs/fs-sandbox/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`, the `fs` and `fs-local` projects, and `sandbox/sandbox` + `sandbox/sandbox-policy`. Build wiring only.

### packages/fs/fs-sandbox/README.md
Package reference for the fs fence: how the fence behaves per mode, the "canonicalize-then-contain" concept, the threat model ("a kernel-tight boundary would need `openat2`-class primitives whose portability cost is not worth it"), and the limitation that parity with the bash runner is *derived from one owner* (`writableRoots`).

### packages/fs/fs-sandbox/README.zh.md
Chinese translation of `packages/fs/fs-sandbox/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/fs-sandbox/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/fs-sandbox/README.md`. No mechanism.

### packages/fs/fs-sandbox/locale/en.json
Two-line locale stub: `{"meta":{"title":"fs-sandbox"}}`. No mechanism.

### packages/fs/fs-sandbox/locale/zh.json
Chinese locale stub: title `文件沙箱访问` with a one-line description of restricting writes/edits by the current permission mode. No mechanism.

### packages/fs/tool-fs/src/index.ts
- **Purpose:** the plugin entry for the model-facing `read` / `read_image` / `write` / `edit` tools: schemas, defaults, and composition.
- **Key abstractions:** `Config` (four tool switches plus four read caps), `READ_LIMIT = 2000`, `STREAM_MIN_SIZE = 10 MiB`, `READ_MAX_LINE_LENGTH = 2000`, `READ_MAX_BYTES = 50 KiB`; `FsSandboxController` shared by the two mutating tools.
- **Data flow:** `apply()` validates every cap is a positive integer, then registers the read tool, conditionally the image tool (inside `ctx.inject(['attachments'])`), and the write/edit pair with the shared escalation controller.
- **Non-obvious design decisions:** "read_image is composition-conditional: without a mounted attachment store the deployment cannot durably commit image bytes, so the tool never registers; the execute body keeps a defensive re-check for direct callers." A cap that is not a positive integer throws at load, because "windowing arithmetic misbehaves silently" otherwise.
- **Edge cases / failure handling:** the read caps stay validated even when the `read` tool is disabled — a bad number is a deployment error, not a runtime surprise.
- **Surprising:** all four tools may be disabled independently and the plugin still loads.

### packages/fs/tool-fs/src/read.ts
- **Purpose:** the `read` tool executor — one provider stat, size-based routing, a bounded window, and the observation.
- **Key abstractions:** `ReadToolCaps`, `parseReadArgs`, `buildWindow`/`formatReadOutput`, the `read` output schema and its `presentationMeta`/`presentResult` pair.
- **Data flow:** resolve → **one** `stat` (absence observation *or* type check + size routing + version) → stream when `size === undefined || size >= streamMinSize`, else read whole → build the window → emit `fs/observed` (present) → return `{path, offset, lines, totalLines}`.
- **Non-obvious design decisions:** reads do exactly one stat, and "a concurrent write can only make a later guarded mutation fail stale and require reread" — so the read is race-tolerant. `isConcurrencySafe: () => true` is declared because "observation races fail closed because guarded mutations re-check the version in-lock". The structured window is projected into persisted `meta` so a read card survives replay, because "the raw canonical output object is not on the wire".
- **Edge cases / failure handling:** a missing file is an absence observation *and* an `FS_NOT_FOUND`; a non-regular target is `FS_NOT_REGULAR_FILE`; a size-less backend streams rather than buffering.
- **Surprising:** `presentResult` re-parses the model-facing envelope with a regex to recover the body, because the canonical structured output is not on the wire — the card is reconstructed from two sources.

### packages/fs/tool-fs/src/read-render.ts
- **Purpose:** the pure read presentation: build a bounded, line-numbered window from decoded text and render the model-facing envelope.
- **Key abstractions:** `ReadWindow`, `WindowResult`, `FileReadOutcome`, `FsReadMeta`, `readMetaFromMeta` (defensive narrowing), `langFromPath` (re-exported from the shared code-language table).
- **Data flow:** `buildWindow(chunks, request, displayPath)` scans chunks line by line, counting total lines, truncating each line at `maxLineLength`, and stopping the byte budget when `outputBytes + bytes > maxBytes`; `formatReadOutput` renders `<path>/<type>/<content>` plus one of three footers.
- **Non-obvious design decisions:** the per-line buffer is capped at `maxLineLength + 1` characters — "one char past the truncation point is enough to prove a line overflows" — so "even one newline-free giant line cannot grow memory without bound". The byte cap is checked *before* the line is admitted, so the returned window never exceeds it.
- **Edge cases / failure handling:** an offset past EOF throws `FS_NOT_FOUND` with the real line count; a file whose last line has no trailing newline is flushed; a CRLF file is stripped of the `\r`. `readMetaFromMeta` enforces the *semantic* contract of replayed JSON (offset is 1-based, line numbers strictly increase and never exceed `totalLines`) and declines to a generic card rather than emitting a mis-numbered one.
- **Surprising:** the footer distinguishes three states (byte-capped, more-remaining, end-of-file) purely so the model knows whether to send `offset=`.

### packages/fs/tool-fs/src/read-target.ts
- **Purpose:** the shared resolve + validate step for the read-family tools.
- **Key abstractions:** `resolveRegularReadTarget(ctx, exec, requestedPath)` returning `{target, info}`.
- **Data flow:** resolve with the session cwd → one `stat` → on absence emit `fs/observed {kind:'absent'}` and throw `FS_NOT_FOUND` → on a non-file throw `FS_NOT_REGULAR_FILE` → else return the target and info.
- **Non-obvious design decisions:** absence is *recorded* even though the read fails — "following the remedy on an externally deleted file records absence, so the next guarded write can recreate it without clobbering a concurrent creator".
- **Edge cases / failure handling:** the absence observation is emitted before the throw, so the policy state is consistent with what the caller observed.
- **Surprising:** one helper serves both `read` and `read_image`, so the observation bookkeeping cannot drift between them.

### packages/fs/tool-fs/src/write.ts
- **Purpose:** the `write` tool executor — obtain an optional intent, write without a stat, record the result.
- **Key abstractions:** `parseWriteArgs`, `formatWriteOutput`, the `write` output schema, `presentationMeta` → `diffs`, `presentCall`/`presentResult` diff cards.
- **Data flow:** parse → resolve the per-call sandbox policy **first** (an escalating call throws its distinct text on any non-grant) → resolve the target → `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` → `ctx.fs.writeText(target, content, intent, signal, policy)` → on error `remediateFsError(sandbox.mapError(...))` → `mutationResult` emits `fs/observed` and returns `{path, operation, before, after}`.
- **Non-obvious design decisions:** the write does **no stat** — "Single-slot decision: the policy plugin produces createIfAbsent/replaceIfVersion; the bare default is undefined (unconditional). No stat." The result envelope deliberately does **not** echo the file content back to the model. The result-time diff is computed from the provider's own `before`/`after`, so a card can never disagree with what was written.
- **Edge cases / failure handling:** a sandbox denial becomes the shared `[sandbox: …]` marker; guarded-mutation failures get a stable model-facing diagnostic; `before: null` (a create, or an undiffable prior) makes the card fall back to a whole-file diff.
- **Surprising:** the tool's system-prompt guidance explicitly tells the model to "Read an existing file before overwriting it with write (the default fs-observation-policy requires it)" — the prompt and the policy agree, and the prompt stays even when the `read` tool is hidden.

### packages/fs/tool-fs/src/edit.ts
- **Purpose:** the `edit` tool executor — a unique-match literal replacement, guarded by the same intent slot.
- **Key abstractions:** `parseEditArgs`, `formatEditOutput` (a Claude-style sentence), the `edit` output schema with a `diffs` projection.
- **Data flow:** parse → resolve the sandbox policy → resolve the target → `ctx.waterfall('fs/edit-intent', ...)` **inside** the try (the slot itself can throw `FS_NOT_OBSERVED`) → `ctx.fs.editText(...)` → remediate errors → emit the observation.
- **Non-obvious design decisions:** "No stat — the bare default never manufactures a version basis." `old_string === new_string` is rejected at parse time because it is "a guaranteed no-op edit". The result envelope is a single human sentence, not a content dump.
- **Edge cases / failure handling:** an empty `old_string`, an identical pair, and a blank `file_path` are all plain argument errors; an ambiguous match is the provider's `FS_AMBIGUOUS_EDIT` with its own remedy.
- **Surprising:** the intent slot sits *inside* the try block specifically so a policy refusal and a provider refusal get the same model-facing remedy.

### packages/fs/tool-fs/src/sandbox.ts
- **Purpose:** the shared escalation API for `write` and `edit`: advertisement gating, per-call policy resolution, the one-approved-wider retry, and denial-marker mapping.
- **Key abstractions:** `FsSandboxController`, `EscalationSchemaFields` (`sandbox_permissions` + `justification`), the `escalationModes` list built from `ctx.fs.sandboxMode`.
- **Data flow:** the controller is built **once** at plugin-apply time from `ctx.fs.sandboxMode`; `resolvePolicy` validates the argument pairing, resolves the standing session policy, and — when a wider mode is requested — calls `approveEscalation` through `ctx.approval` before anything executes.
- **Non-obvious design decisions:** the escalation fields are advertised **only** under a confining backend, because "the enum pins the closed target vocabulary" and a knob that is always available is a lie. The strictly-wider check happens per call at execution, not in the schema. A confining backend without `ctx.sandboxPolicy` throws at construction rather than at first call.
- **Edge cases / failure handling:** `mapError` turns an `FS_SANDBOX_DENIED` into an `FsError` whose text is the shared denial marker plus the same-turn escalation hint, "while keeping the structured `FS_SANDBOX_DENIED` code — `ToolRuntime` populates `result.error` only for `HarnessError` instances, so a plain `Error` would strip the code retry/observers key off".
- **Surprising:** the same escalation vocabulary is shared with bash — "so bash and fs escalate identically" — and it lives in `@deepseek-ai/dsh-sandbox`, not in the tool package.

### packages/fs/tool-fs/src/error.ts
- **Purpose:** the stable model-facing diagnostics for guarded-mutation failures.
- **Key abstractions:** `remediateFsError(error, displayPath)`.
- **Data flow:** a caught error is inspected: `FS_NOT_OBSERVED` → one path-aware message; `FS_STALE_VERSION` → the provider's reason plus a re-read remedy; anything else passes through.
- **Non-obvious design decisions:** both remediations preserve the original code and chain the original as `cause`, so machine routing survives the human rewrite. `FS_NOT_OBSERVED` deliberately replaces "operation-specific policy/provider text" with one stable sentence.
- **Edge cases / failure handling:** non-`FsError` values are returned unchanged.
- **Surprising:** the stale remedy is a *suffix*, not a replacement — the provider's specific reason ("file changed since it was read") is kept because it is more informative than a generic one.

### packages/fs/tool-fs/src/diff.ts
- **Purpose:** result-time contextual diff presentation for `write` and `edit`.
- **Key abstractions:** `DIFF_CONTEXT = 3`, `FsDiffMeta`, `computeHunkDiffs`, `diffsFromMeta`, `pathFromMeta`.
- **Data flow:** `structuredPatch('', '', before, after, ..., {context: 3})` → per hunk, split the lines into `oldLines`/`newLines` (a context line goes to both sides) → one `FileDiff` per hunk.
- **Non-obvious design decisions:** the diff is computed **at result time** from the storage's before/after rather than persisted as a diff — "a consumer computes the result-time contextual diff from `before`/`after`". Pure insertions report `oldText: null`; scattered replacements stay separate hunks.
- **Edge cases / failure handling:** the unified-diff `\ No newline at end of file` marker is dropped so it never leaks into a diff block. `diffsFromMeta` rejects an empty `diffs` array so the write path can fall back to a whole-file diff.
- **Surprising:** the patch is generated with empty filename arguments — the diff is about content, not about paths.

### packages/fs/tool-fs/src/mutation-result.ts
- **Purpose:** the shared post-mutation step for `write` and `edit`.
- **Key abstractions:** `mutationResult(ctx, target, outcome, exec)`.
- **Data flow:** strip `version` from the provider outcome, emit `fs/observed {kind:'present', version}`, and return `{path: ctx.fs.processPath(target), ...result}`.
- **Non-obvious design decisions:** the version is **removed from the tool result** — it "stays in the observation event" — so the model-facing payload carries only the canonical path and the content basis.
- **Edge cases / failure handling:** the observation is emitted only after the provider has committed, so a failed mutation never records a version.
- **Surprising:** the canonical path comes from `processPath` (the execution-world path), not from `displayPath` — a backend may label the target differently for humans.

### packages/fs/tool-fs/src/session-cwd.ts
- **Purpose:** resolve the filesystem resolution options (cwd + signal) for one tool call.
- **Key abstractions:** `sessionResolveOptions(ctx, exec)`.
- **Data flow:** if the execution has an agent, `ctx.workingDirectory.ensure(agent, signal)` yields the session's current directory; otherwise the provider's own defaults apply.
- **Non-obvious design decisions:** a directory change "affects subsequent reads and mutations without changing sandbox permission roots" — the cwd is a resolution base, not a permission boundary.
- **Edge cases / failure handling:** the abort signal rides along so a cancelled call never opens a file.
- **Surprising:** the same helper serves the sandboxed and unsandboxed backends, so the workspace root the policy uses and the directory the tool resolves against are two separate facts.

### packages/fs/tool-fs/src/read-image.ts
- **Purpose:** the `read_image` tool — read a PNG/JPEG/WebP/GIF and return the image itself, durably committed.
- **Key abstractions:** `IMAGE_EXTENSIONS`, the magic-byte sniffer `sniffImageMediaType`, `assertImageCapableRoute`, `ImageReadValue`, `imageRefFromValue`, `formatImageReadOutput`.
- **Data flow:** extension check → attachment-store presence check → deployment media-type check → **image-capability check on the exact routed model** → resolve + stat → `ctx.fs.readBytes(target, signal, min(maxImageBytes, maxMessageImageBytes))` → declared-or-sniffed media type → `attachments.saveImage` → emit `fs/observed` → return `{path, image:{...}}`.
- **Non-obvious design decisions:** the route gate is "deliberately stricter than the host upload preflight" — an image-reading tool is only useful when the exact calling route can inspect its result, so an unknown capability **refuses** rather than relying on an adapter failure after filesystem and attachment work. The tool description tells the model not to install image libraries or create thumbnails, because the store downsizes automatically. The persisted `meta` carries the path only: "the settled `content` already carries the image block with the complete reference, so a second copy would keep two records of one fact".
- **Edge cases / failure handling:** every pre-read gate runs before any filesystem I/O, so a refusal never leaks a partial read; each attachment error code gets its own remedy (dimension too large, too many pixels, too large, 16-bit PNG conversion, invalid image, type mismatch) with a "downscale the image and read the smaller copy" instruction.
- **Surprising:** a downscaled read tells the model the multiplier to apply to coordinates measured on the attached image — and gives per-axis multipliers when integer rounding makes the two ratios differ.

### packages/fs/tool-fs/tests/tools.spec.ts
- **Purpose:** the tool suite's own contract: registration, injection, HMR, the read/write/edit executors, presentation (call-time and result-time), the plugin-config read caps, and the escalation API.
- **Key abstractions:** a fake `ctx.fs` provider, a fake `ctx.sandboxPolicy`, a fake `ctx.approval`, and the `defineTool` surface.
- **Data flow:** each test registers the plugin over fakes, calls the tool through the registry, and asserts the model-facing text, the `meta` projection and the presentation view.
- **Non-obvious design decisions:** the suite pins "read parallel-safe while write/edit remain exclusive", the three footer variants, and the escape contract "presentResult returns undefined on an error result (nothing applied)".
- **Edge cases / failure handling:** covered include a non-JSON numeric offset (rejected before tool-specific validation), a blank path, a size-less backend, a byte-capped read, a malformed `meta`, and a write whose applied-diff projection is empty (falls back to a whole-file diff).
- **Surprising:** the read tool's *call-time* card is derived from the raw args only, so an omitted `limit` keeps the title bare "instead of smuggling config into this pure presenter".

### packages/fs/tool-fs/tests/integration.spec.ts
- **Purpose:** the tool suite's end-to-end suite over a **real** `ctx.fs` backend and the real observation policy, with the tool called through the registry.
- **Key abstractions:** the real `dsh-fs-local` + `dsh-fs-observation-policy` + `dsh-tool-fs` stack over a temp directory; a stat-counting provider wrapper.
- **Data flow:** read → write → edit against real files on disk, with the observation policy mounted or not.
- **Non-obvious design decisions:** the suite asserts the **stat budget** end-to-end: "read stats once; write and edit never stat in the tool (the gate stats zero too)", and "a missing read still stats once and its recovery write stats zero times". It also pins that a *windowed* read authorises a full overwrite of an unchanged file — freshness, not full-view.
- **Edge cases / failure handling:** covered include the stale remedy being actionable (re-read unblocks the retry), a throwing `fs/observed` listener (surfaces as `isError` but the mutation already hit disk), a pre-aborted registry call (`ABORTED_BEFORE_DISPATCH`), and concurrent edits of the same file.
- **Surprising:** "a direct ctx.fs.readText records no observed-state, so a later edit rejects" — the gate really is event-only, with no method coupling.

### packages/fs/tool-fs/tests/read-image.spec.ts
- **Purpose:** the `read_image` suite: media-type mapping, magic-byte sniffing, the happy path, extension-less paths, the image-capability gate, admission failures and the registration surface.
- **Key abstractions:** a fake attachment store with configurable limits; a fake `llm` service returning `inputModalities`.
- **Data flow:** call `read_image` through the registry and assert the envelope, the image block, the emitted observation and the refusal text.
- **Non-obvious design decisions:** the suite pins "accepts an exact visual route even when the advisory model catalog omits it" — the *resolved* route is authoritative, not the catalog. It also pins "persists the path only, leaving the reference to the result content".
- **Edge cases / failure handling:** covered include the extension/declared-format mismatch repair text, the extension-less "sniffs as an image but does not decode" case, a missing attachment service, a deployment that does not accept the media type, and the per-message aggregate byte bound.
- **Surprising:** the tool reads a **normalised attachment object path** directly and dedups to the stored reference — content addressing makes a repeated read free.

### packages/fs/tool-fs/tests/read-render.spec.ts
- **Purpose:** the pure windowing and envelope suite: `buildWindow`, the per-request caps, chunked input, `langFromPath` and `readMetaFromMeta`.
- **Key abstractions:** `buildWindow` over an array or an async iterable of chunks — the same function serves a whole read and a streamed read.
- **Data flow:** feed text (whole or chunked) and assert the numbered window, the totals and the truncation flag.
- **Non-obvious design decisions:** the suite explicitly pins "caps a newline-free giant line split across chunks without unbounded buffering" and "windows identically when text arrives in small chunks" — chunk boundaries carry no meaning.
- **Edge cases / failure handling:** covered include an empty file at offset 1 (zero lines), an offset past EOF, a trailing newline (no dangling empty line), a final line with no trailing newline, and a byte cap that trips mid-stream.
- **Surprising:** `langFromPath` is pinned to keep "every already-persisted suffix byte-identical" — a recorded session's stored hint must not change when the shared table is extended.

### packages/fs/tool-fs/tests/diff.spec.ts
- **Purpose:** the diff projection's suite: hunk computation, the `oldText: null` insertion case, the no-newline marker, `DIFF_CONTEXT`, and the defensive `diffsFromMeta` narrowing.
- **Key abstractions:** `computeHunkDiffs` over plain strings.
- **Data flow:** compute a patch and assert the produced `FileDiff[]`.
- **Non-obvious design decisions:** "a scattered replace_all yields one FileDiff PER hunk (matching per-site editor blocks)" — a single replace-all is presented as separate diffs, not one merged one.
- **Edge cases / failure handling:** an identical before/after yields no hunks; a whole-file deletion reports empty `newText`; malformed `meta` narrows to `undefined` so the presentation falls back.
- **Surprising:** the context is fixed at 3 lines on both sides, matching the Claude Code edit-card shape.

### packages/fs/tool-fs/tests/error.spec.ts
- **Purpose:** the remediation helper's suite.
- **Key abstractions:** `remediateFsError`.
- **Data flow:** feed an `FsError` with a given code and assert the returned error's message, code and chained cause.
- **Non-obvious design decisions:** the suite pins "normalizes policy and provider FS_NOT_OBSERVED failures to one diagnostic" — two different producers must produce the same sentence.
- **Edge cases / failure handling:** other codes and non-`FsError` values pass through untouched.
- **Surprising:** the stale remedy is appended to the provider's own message rather than replacing it.

### packages/fs/tool-fs/tests/fs-tools.e2e.ts
- **Purpose:** the with-key end-to-end suite: create → read → edit verified on disk, and per-session cwd resolution.
- **Key abstractions:** the real agent loop with a real provider key (`fsHarness`).
- **Data flow:** the agent is prompted to run the tools; the assertions are on the files on disk afterwards.
- **Non-obvious design decisions:** the harness lives outside the e2e glob "so imports do not register tests", and the agent's workspace is the `fsCwd` because "Agents have no session cwd".
- **Edge cases / failure handling:** the second case proves a relative path resolves against the *session* cwd, not the provider's `config.cwd`.
- **Surprising:** this is the only place in the shard where a real model is in the loop.

### packages/fs/tool-fs/tests/harness.ts
- **Purpose:** the shared harness builder for the with-key e2e tests.
- **Key abstractions:** `fsHarness(fsCwd, persona)` mounting the agent loop, the DeepSeek key provider, `LocalFileSystem`, the working-directory service, the observation policy and the tools; `waitForIdle(ctx, agent)`.
- **Data flow:** returns a live `Context` with the whole fs stack mounted.
- **Non-obvious design decisions:** `persona` configures the deployment prompt; the helper is deliberately outside the e2e glob so importing it does not register a test.
- **Edge cases / failure handling:** `waitForIdle` subscribes to `agent/status` and disposes its own listener on `idle`.
- **Surprising:** the harness mounts the *observation policy* by default, so the e2e agent is subject to read-before-edit exactly as in production.

### packages/fs/tool-fs/package.json
npm manifest for `@deepseek-ai/dsh-tool-fs` — ESM, runtime deps `diff@^9.0.0` (the patch generator) and `@deepseek-ai/dsh-util-code-language`; peer deps on `dsh-fs`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-attachment`, `dsh-tools`, `dsh-user-approval` and `dsh-working-directory`. No mechanism.

### packages/fs/tool-fs/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to the vendored packages plus `core/tools`, `core/system-prompt`, `fs`, `fs-observation-policy`, `sandbox/sandbox`, `sandbox/sandbox-policy`, `interaction/user-approval`, `attachment/attachment`, `util/code-language` and `session/working-directory`. Build wiring only.

### packages/fs/tool-fs/README.md
Package reference for the four fs tools: the tool table, the config table, the policy/sandbox behaviour, the failure vocabulary, and — unusually detailed — a "Model Experience" section that states the **exact** model-facing envelopes and footers, the token cost of each, and the KV-cache effect of each (all "append-only; newly visible content follows the reusable request prefix").

### packages/fs/tool-fs/README.zh.md
Chinese translation of `packages/fs/tool-fs/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/tool-fs/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/tool-fs/README.md` — the largest record in the group (142 lines) because the English README has the most heading sections. No mechanism.

### packages/fs/tool-fs/locale/en.json
Two-line locale stub: `{"meta":{"title":"tool-fs"}}`. No mechanism.

### packages/fs/tool-fs/locale/zh.json
Chinese locale stub: title `文件读写工具` with a one-line description ("lets the AI read, create and edit work files"). No mechanism.

### packages/fs/tool-fs-search/src/index.ts
- **Purpose:** the plugin entry for the `glob` and `grep` discovery tools over the packaged ripgrep binary.
- **Key abstractions:** `Config` (`sampleOverCapGlobResults` is **required**; `globMaxResults` 100, `grepMaxMatches` 250, `grepMaxLineBytes` 2000, `searchMetaMaxBytes` 64 KiB, `rawOutputMaxBytes` 20 MB, `graceMs` 3000, `stderrMaxBytes` 64 KiB, `timeoutMs` 30000); `inject = ['tools','systemPrompt','subprocess','workingDirectory']`.
- **Data flow:** validate every cap is a positive integer and `graceMs <= MAX_TIMER_DELAY_MS` → `applyGlobTool` and `applyGrepTool`.
- **Non-obvious design decisions:** the package injects **`subprocess`, not `fs`** — "search is a process-backed ripgrep workflow, so filesystem backends stay free of a universal search API". `ctx.spillStore` is read opportunistically with `ctx.get()` because formatted-result spill is optional. `sampleOverCapGlobResults` has **no default**: "deployments choose the over-cap ordering contract explicitly".
- **Edge cases / failure handling:** a zero or fractional cap throws at load ("retention and timeout arithmetic misbehaves silently" otherwise); a grace beyond the Node timer range is rejected.
- **Surprising:** the tools never expose a background job — the call returns only after `rg` exits, is terminated by the cooperative timeout, is aborted, or fails.

### packages/fs/tool-fs-search/src/search-core.ts
- **Purpose:** the shared execution plumbing: the `SEARCH_*` error vocabulary, the ripgrep spawn helper, the retention helpers, the spill handoff and workdir-relative display.
- **Key abstractions:** `SearchError` (extends `HarnessError`), `SearchErrorCode`, `RipgrepRun`, `ItemRetainer`/`TextRetainer` from `@deepseek-ai/dsh-output-retention`, `resolveRgPath`.
- **Data flow:** `runRipgrep` resolves the workdir (session cwd or `process.cwd()`), spawns `[rgPath, '--no-config', ...argv]` through `ctx.subprocess.spawn` with stdout/stderr byte budgets and `graceMs`, awaits `handle.done`, classifies the exit (0 success, 1 no matches, anything else a `SearchError`), and returns the complete stdout.
- **Non-obvious design decisions:** `--no-config` is prepended because the spawn is **unconfined**: "a host `RIPGREP_CONFIG_PATH` (or `rg.conf` next to the binary) can otherwise inject `--pre` and make ripgrep execute an arbitrary preprocessor for every matched file". The packaged binary is resolved **lazily and memoised** so a missing binary fails at the first search call, not at module load. Exit semantics are tool-owned, and the two launch-time failure domains (a synchronous throw at spawn *creation* vs a rejected `handle.done`) are classified differently so the tool never claims the command did not start when it might have.
- **Edge cases / failure handling:** a lossy stdout read fails as `SEARCH_RAW_OUTPUT_OVERFLOW` rather than parsing a silently-partial stream; an abort is re-checked at three points (before spawn, after spawn creation, after the run); the stderr tail is capped and annotated when truncated; spill failure logs a warning and keeps the inline result — "search success never turns into `isError` because spill storage is unavailable".
- **Surprising:** the same retention pass (`retainGrepMatches` / `retainGlobPaths`) feeds both the model-facing render and the search-card projection, so "text and card never disagree about which matches survived".

### packages/fs/tool-fs-search/src/glob.ts
- **Purpose:** the `glob` tool — path-pattern discovery over ripgrep, modification-time ordered.
- **Key abstractions:** `GLOB_MAX_RESULTS = 100`, `GLOB_VCS_EXCLUDES` (`.git .svn .hg .bzr .jj .sl`), `GlobSample`, `buildGlobCommand`, `sampleAcrossTopLevel`, `formatGlobOutput`, `renderGlobPaths`, `globCardPage`.
- **Data flow:** `buildGlobCommand` → `rg --files --glob=<pattern> --sort=modified --no-ignore --hidden` + two negated globs per VCS name + `-- <path>` → `runRipgrep` → split stdout into display paths → the output render picks the inline page (whole result, modification-time head, or the top-level sample).
- **Non-obvious design decisions:** each VCS name is excluded with **two** negated globs — "an any-depth directory glob that matches — and prunes — the directory during traversal, and a contents glob that still excludes the internals when the search root itself is at or inside the directory". The search root rides behind `--` "so a leading-dash path can never be parsed as a flag". `sampleAcrossTopLevel` gives every top-level entry a slot before any entry gets a second, so an over-cap page is not all one hot directory.
- **Edge cases / failure handling:** the result is capped and the complete list is spilled; a failed spill keeps the inline page and says so. The card page is computed with the *same* function as the text page so the two cannot disagree.
- **Surprising:** the "sampled across N of the M top-level entries" sentence is part of the model-facing footer — the model is told the page is not modification-time order.

### packages/fs/tool-fs-search/src/grep.ts
- **Purpose:** the `grep` tool — content search with a ripgrep regular expression, line-oriented `--json` output.
- **Key abstractions:** `GREP_MAX_MATCHES = 250`, `GREP_MAX_LINE_BYTES = 2000`, `parseGrepArgs`, `validateInclude`, `buildGrepCommand`, `parseRecord`/`parseGrepMatches`, `formatGrepMatches`/`formatGrepOutput`.
- **Data flow:** validate → `rg --json --regexp=<pattern> [--glob=<include>] [-- <path>]` → parse each NDJSON line into a `GrepMatch` → group by file → retain the first 250 with per-line previews → render.
- **Non-obvious design decisions:** `rg --json` is used specifically "so file path, line number, and line text parse without colon-splitting ambiguity". Non-`match` record types (`begin`/`end`/`context`/`summary`) are "transport framing, not results: skipped, not malformed". `include` must be ONE positive glob — blank, negated (`!…`) and comma-separated lists are rejected up front, while a comma inside a brace group is fine.
- **Edge cases / failure handling:** a malformed `--json` line or a match missing its path/line number/content is a `SEARCH_FAILED`, not a partial result; a line that is not valid UTF-8 (ripgrep sends base64 `bytes`) yields a placeholder preview rather than failing the whole search.
- **Surprising:** the tool description omits the routine budgets — "a model that needs surrounding context reads the matched file with `read`" — the model is not asked to page through matches.

### packages/fs/tool-fs-search/src/presentation.ts
- **Purpose:** the result-time search-card projection: the `meta` payload for `grep` and `glob` and the defensive narrowing back to a view.
- **Key abstractions:** `SearchMeta` (a `shape`-discriminated union: `matches` | `paths`), `groupMatchesByFile`, `grepSearchMeta`, `globSearchMeta`, `capMetaBytes`, `searchViewFromMeta`.
- **Data flow:** the retained items (the *same* retention pass the text render consumed) → group by file → `{shape, files|paths, truncated, total}` → `capMetaBytes` → persisted `meta` → `searchViewFromMeta` narrows it back on replay.
- **Non-obvious design decisions:** a **second, independent** cap bounds the JSON `meta` itself, because "a deployment's final output budget (`dsh-spill-policy`) only shrinks a result's `content`, never its `meta`". `capMetaBytes` drops trailing groups/paths until the payload fits, but "a single item too large to fit on its own is kept: the invariant is a bounded payload wherever droppable, never an empty card that hides a real result".
- **Edge cases / failure handling:** a zero-result meta narrows to a valid **empty** card — unlike the mirrored `diffsFromMeta`, which rejects empty diffs — "because a zero-match grep is a legitimate result a UI shows as 'no matches'".
- **Surprising:** the meta member shapes use object-literal type aliases rather than the `SearchFileMatches` interfaces "because only a type alias is assignable to the `JsonValue` index signature `presentationMeta` returns".

### packages/fs/tool-fs-search/src/direct-call.ts
- **Purpose:** the shared "may I still project this value?" predicate used by both tools' spill post-processing.
- **Key abstractions:** `acceptedDirectCallValue(ctx, tool, exec, result, decision)`.
- **Data flow:** returns the canonical result value only when the decision is `accept`, no downstream policy replaced the content or the value, the call was top-level (`exec.parent === undefined`), the name matches the tool, the result is not an error, and the live scoped tool is still the same definition.
- **Non-obvious design decisions:** the check "the tool still owns a direct successful top-level call" is what stops a subagent's nested call from spilling the parent's page.
- **Edge cases / failure handling:** every disqualifying condition returns `undefined`, which makes the tool defer to the default decision.
- **Surprising:** it re-resolves the tool through `ctx.tools.get(exec.name, exec.agent)` — a scoped lookup — so a per-agent restriction is respected.

### packages/fs/tool-fs-search/src/ripgrep.d.ts
- **Purpose:** a hand-written ambient module declaration for `@vscode/ripgrep`, which ships no type declarations.
- **Key abstractions:** `declare module '@vscode/ripgrep' { export const rgPath: string }`.
- **Data flow:** none — it exists so `import('@vscode/ripgrep')` type-checks.
- **Non-obvious design decisions:** the doc comment states the shape precisely: an ESM module resolving the platform ripgrep binary through the `@vscode/ripgrep-<platform>-<arch>` optional dependency.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the whole file is 12 lines and exists because one dependency is untyped.

### packages/fs/tool-fs-search/tests/tools.spec.ts
- **Purpose:** the search tools' own suite: registration, config validation, argv construction, workdir derivation and signal forwarding, exit-semantics classification, raw-output acquisition, cross-directory sampling, and the glob/grep result paths.
- **Key abstractions:** a fake `ctx.subprocess` whose `spawn` records the argv and returns a scripted outcome; a fake spill store.
- **Data flow:** each test calls the tool through the registry and inspects the recorded spawn spec and the rendered text.
- **Non-obvious design decisions:** the suite pins the exact argv shape ("glob: fixed rg --files argv with the pattern and paired VCS excludes") and that the spawn carries `--no-config` and budgeted collect streams. It also pins "handles more top-level groups than the JavaScript argument limit" — the sampler must not spread into `apply`.
- **Edge cases / failure handling:** covered include a regex parse error → `SEARCH_INVALID_PATTERN`, a signal kill → `SEARCH_FAILED` (not a timeout), truncated stdout → `SEARCH_RAW_OUTPUT_OVERFLOW`, a pre-aborted call, and a downstream policy that replaced the canonical value (the spill must not resurrect the old one).
- **Surprising:** the "no spill file when the result fits inline" case is asserted — a spill on every search would litter the store.

### packages/fs/tool-fs-search/tests/presentation.spec.ts
- **Purpose:** the search-card projection's suite.
- **Key abstractions:** `groupMatchesByFile`, `grepSearchMeta`, `globSearchMeta`, `searchViewFromMeta`.
- **Data flow:** project retained items into a `SearchMeta`, then narrow it back into a view.
- **Non-obvious design decisions:** the meta byte cap is tested at the boundary — "drops trailing file groups until the serialized meta fits the byte cap" and "keeps a single oversized group rather than emit an empty card".
- **Edge cases / failure handling:** every malformed-shape case narrows to `undefined` so the generic card is used; a zero-result payload narrows to a valid empty card.
- **Surprising:** the `total` field is the *pre-cap* count, so a UI can say "showing 250 of 1,204" without re-reading the spill.

### packages/fs/tool-fs-search/tests/integration.spec.ts
- **Purpose:** the search tools over the **real** subprocess service and the **real** packaged ripgrep binary.
- **Key abstractions:** a temp workspace with hidden files and a `.git` directory; the real `dsh-subprocess-local` backend.
- **Data flow:** the tool spawns `rg` for real and the assertions are on the discovered paths and the grouped matches.
- **Non-obvious design decisions:** the suite proves the exclusion contract end-to-end: "excludes VCS internals even when the search root IS the VCS directory" — the case the second negated glob exists for.
- **Edge cases / failure handling:** covered include a hostile pattern staying inert ("a plain argv element, the world untouched"), a leading-dash pattern treated as a pattern and not a flag, a real regex error, a missing target, and an unusable session-cwd provider.
- **Surprising:** the leading-dash test is the direct proof that "no shell layer exists, so no quoting applies" is a safety property, not just a style.

### packages/fs/tool-fs-search/tests/load-path.spec.ts
- **Purpose:** the real-load-path guard — the package must load and boot through the Cordis plugin loader without a default-export conflict.
- **Key abstractions:** `unwrapExports`; a real `ctx` with the subprocess service.
- **Data flow:** import the module, unwrap its exports, and boot it over `ctx.subprocess`.
- **Non-obvious design decisions:** the guard exists because "Service packages default-export their service class and nothing else plugin-shaped (packages/AGENTS.md): mixing a default export with a function-plugin `apply` makes the Loader drop the plugin namespace."
- **Edge cases / failure handling:** the boot test asserts there is no `inject` error, i.e. the plugin's declared `inject` list is satisfiable.
- **Surprising:** this is a packaging invariant expressed as a test, and it is the kind of thing that silently breaks on an unrelated refactor.

### packages/fs/tool-fs-search/tests/rg-path.spec.ts
- **Purpose:** the lazy packaged-ripgrep resolution's failure behaviour.
- **Key abstractions:** the memoised `rgPathPromise`.
- **Data flow:** force the platform package to be unresolvable and call the tool.
- **Non-obvious design decisions:** the first search call fails with `SEARCH_FAILED` "instead of failing module load" — the composition still boots, so the failure is attributable to the search, not the loader.
- **Edge cases / failure handling:** the memoised rejection keeps failing on every subsequent call (the resolution is not retried).
- **Surprising:** a broken binary breaks *search* only; the rest of the harness is unaffected.

### packages/fs/tool-fs-search/tests/rg-sidecar.spec.ts
- **Purpose:** the four resolution modes of the ripgrep binary: pkg sidecar, Windows sidecar name, dependency path, Electron ASAR unpack.
- **Key abstractions:** the `process.execPath` sidecar convention and the `.asar` → `.asar.unpacked` rewrite.
- **Data flow:** each case fakes the environment and asserts the resolved path.
- **Non-obvious design decisions:** a single-file (pkg) runtime uses the executable's `-rg` sidecar "because a native helper cannot be spawned from pkg's virtual filesystem".
- **Edge cases / failure handling:** a packaged runtime with no sidecar falls back to the dependency binary; Electron needs the unpacked path.
- **Surprising:** the Windows sidecar name is `name-rg.exe` (from `parse(process.execPath).name`) while POSIX uses `${process.execPath}-rg`.

### packages/fs/tool-fs-search/package.json
npm manifest for `@deepseek-ai/dsh-tool-fs-search` — runtime dep `@vscode/ripgrep@^1.18.0` (the packaged binary) and `schemastery`; peer deps on `dsh-subprocess`, `dsh-spill`, `dsh-output-retention`, `dsh-timeout`, `dsh-tools` and `dsh-working-directory`. No mechanism.

### packages/fs/tool-fs-search/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `util/output-retention`, `llm/llm`, `core/session`, `core/tools`, `core/system-prompt`, `shell/shell`, `spill/spill`, `util/timeout` and `session/working-directory`. Build wiring only.

### packages/fs/tool-fs-search/README.md
Package reference for `glob`/`grep`: the tool table, the config table, the deployment requirement (no host `rg`; the Python SDK wheels copy a `-rg` sidecar), the failure codes, the "two budgets, two artifacts" model (raw stdout/stderr are transport; only the inline page is capped), and the honest limitation that "search and file access have no shared-workspace proof".

### packages/fs/tool-fs-search/README.zh.md
Chinese translation of `packages/fs/tool-fs-search/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/tool-fs-search/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/tool-fs-search/README.md`. No mechanism.

### packages/fs/tool-fs-search/locale/en.json
Two-line locale stub: `{"meta":{"title":"tool-fs-search"}}`. No mechanism.

### packages/fs/tool-fs-search/locale/zh.json
Chinese locale stub: title `文件搜索工具` with a one-line description ("lets the AI search local files by name or by text content"). No mechanism.

### packages/fs/tool-str-replace-editor/src/index.ts
- **Purpose:** the standalone `str_replace_editor` tool over `ctx.fs` — `view`, `create`, `str_replace`, `insert` in one schema.
- **Key abstractions:** `MutationPolicy` (the local escalation wrapper), `formatFileView`, `listDirectory`, `matchOffsets`/`lineNumbersAt`, the `DEFAULT_DESCRIPTION` (the Claude-Code-style tool description).
- **Data flow:** every command resolves an **absolute** path first; `view` stats and renders (numbered content or a two-level listing); `create`/`str_replace`/`insert` resolve the sandbox policy, run the `fs/write-intent` or `fs/edit-intent` waterfall, delegate to `ctx.fs.writeText`/`editText`, and emit `fs/observed` on success.
- **Non-obvious design decisions:** `str_replace` and `insert` re-read the file and use the *observed* version as the CAS basis when no policy plugin supplies a guard, so they are safe even without the policy. `new_str: null` is rejected (deletion requires omission) while a null placeholder for an unused parameter is treated as omitted. The view preserves tabs, "so displayed text stays valid literal replacement input". An ambiguous match reports the **line numbers** of every occurrence.
- **Edge cases / failure handling:** a relative path is refused with a hint ("Maybe you meant /path?"); a failed view records absence so a later `create` can recover an externally deleted path; a missing `ctx.sandboxPolicy` under a confining backend fails at plugin startup.
- **Surprising:** the tool is a single `str_replace_editor` schema with four commands, yet it still routes every mutation through the *same* `fs/*` intent slots as the `read`/`write`/`edit` suite — the tool vocabulary differs, the policy does not.

### packages/fs/tool-str-replace-editor/tests/tools.spec.ts
- **Purpose:** the editor tool's suite: registration, the four commands, clipping, the failure vocabulary, and the delegation to the policy and the sandbox.
- **Key abstractions:** a fake `ctx.fs`, a fake `ctx.sandboxPolicy`, and a real `fs-observation-policy` for the delegation test.
- **Data flow:** each test calls the tool through the registry and asserts the model-facing text and the on-disk effect.
- **Non-obvious design decisions:** the suite pins "clips a view at a code-unit boundary without splitting a surrogate pair" and "preserves tabs outside the edited region" — two details that a naive implementation gets wrong.
- **Edge cases / failure handling:** covered include an invalid command, invalid arguments, a relative path, a missing sandbox-policy composition at startup, and an unexpected backend write failure mapped for both `str_replace` and `insert`.
- **Surprising:** the tool's own description carries the "old_str must be EXACTLY one or more consecutive lines … Be mindful of whitespaces!" guidance — the tool teaches its own contract in the schema text.

### packages/fs/tool-str-replace-editor/package.json
npm manifest for `@deepseek-ai/dsh-tool-str-replace-editor` — ESM, runtime dep `schemastery`; peer deps on `dsh-fs`, `dsh-output-retention`, `dsh-sandbox`, `dsh-sandbox-policy` and `dsh-tools`. No mechanism.

### packages/fs/tool-str-replace-editor/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `vendor/cordis`, `vendor/schemastery`, `util/output-retention`, `core/tools`, `fs`, `sandbox/sandbox` and `sandbox/sandbox-policy`. Build wiring only.

### packages/fs/tool-str-replace-editor/README.md
Package reference for the editor tool: the four commands, the config table, the failure/recovery vocabulary, the "mutations never touch the provider directly with their own assumptions" concept, and the note that this is a standalone plugin for custom compositions, not an optional bundle in the Plugins page.

### packages/fs/tool-str-replace-editor/README.zh.md
Chinese translation of `packages/fs/tool-str-replace-editor/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/fs/tool-str-replace-editor/README.i18n.yaml
Per-heading bilingual hash record for `packages/fs/tool-str-replace-editor/README.md`. No mechanism.

### packages/sandbox/README.md
Package-group map for `packages/sandbox`: the four packages, their `ctx` keys, and the statement that "Confinement is same-world only: it shares the host kernel and filesystem, while containers, microVMs, and remote executors replace whole capabilities instead of registering here."

### packages/sandbox/README.zh.md
Chinese translation of `packages/sandbox/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/sandbox/README.i18n.yaml
Per-heading bilingual hash record for `packages/sandbox/README.md` (25 lines — the smallest group map). No mechanism.

### packages/sandbox/sandbox/src/index.ts
- **Purpose:** the `ctx.sandbox` Service Definition — the modes, the per-call policy, the enforcement-completeness fact, the runner-failure evidence shape, and the fail-closed error.
- **Key abstractions:** `SandboxMode` (`read-only` | `workspace-write` | `danger-full-access`), `ConfinedSandboxMode`, `SandboxExecutionPolicy` (mode + workspaceRoot + optional `sessionId`), `SandboxPolicy` (the confined subset), `SandboxEnforcement` (`full` | `partial`), `ConfinedArgv` (argv + enforcement + `denialSignatures` + `runnerFailureRules`), `RunnerFailureRule`.
- **Data flow:** a consumer resolves a policy per call and calls `confine(argv, policy, signal)`; the provider returns the argv to spawn *in place of* the caller's own, plus the backend's own facts.
- **Non-obvious design decisions:** the policy "is carried PER CALL, not fixed on the provider" — two consumers may confine under different policies at the same instant, and an approved escalated retry is a new call with a wider policy. `denialSignatures` is a **per-backend dialect**, not a cross-backend union, because "the union claims denials a given backend never produces". `runnerFailureRules` exist so "runner failure means the command never ran, while denial means confinement worked and blocked it" — the two are separated by the rule shape, not by heuristics.
- **Edge cases / failure handling:** `confine()` "must return enforcing argv or fail closed"; `SandboxUnavailableError` carries `SANDBOX_UNAVAILABLE` through the structured error channel and names the operator escape hatches per platform.
- **Surprising:** `SandboxExecutionPolicy` carries the workspace root even under modes that do not consume it, "so callers can resolve policy once before choosing the enforcement path".

### packages/sandbox/sandbox/src/escalation.ts
- **Purpose:** the escalation vocabulary and choreography shared by every sandbox-enforcing tool family.
- **Key abstractions:** `WIDER_MODES` (the closed strictly-wider table), `ESCALATION_TARGETS` (the closed target vocabulary advertised in schemas), `validateEscalationArgs`, `sandboxDenialMarker`, `escalationHintMarker`, `sandboxPermissionsDescription`, `approveEscalation`, `EscalationApprover` (a minimal structural approval shape).
- **Data flow:** `approveEscalation(request, approval)` — repeating the effective mode returns it with **no approval**; a strictly wider mode requires the approver, which is asked with an audit reason and a bilingual `displayReason`; the outcome (`allowed-once` | `rejected` | `cancelled` | `unavailable`) maps to a distinct verbatim text.
- **Non-obvious design decisions:** the schema enum is the closed *target* vocabulary while the strictly-wider check is an *execution* check against the call's effective mode — "schemas are registry-global while the effective mode is per-call truth". The escalation fields are advertised even when the composition's default is wider than the target, "or a `danger-full-access` default would advertise nothing while a narrower-switched session stays confined with no lever". The approval channel is a **structural function shape**, not the approval service type, "so this package never depends on the approval or agent packages".
- **Edge cases / failure handling:** a missing approver, an agent-less call, a narrower target and an unsupported target each throw with distinct text *before* execution; the `assertNever` guard catches an outcome outside the closed union.
- **Surprising:** the audit reason embeds the target mode (`escalate sandbox to <mode>: <justification>`), "so the grant's identity" is reconstructible from the request.

### packages/sandbox/sandbox/src/roots.ts
- **Purpose:** the one derivation of "what a confined execution may write under".
- **Key abstractions:** `canonicalPath(path)` and `writableRoots(policy)`.
- **Data flow:** `writableRoots` returns `[]` under `read-only`; under `workspace-write` it returns the canonical, deduplicated set `{policy.workspaceRoot, '/tmp', os.tmpdir()}`.
- **Non-obvious design decisions:** this module exists "so the Seatbelt profile and the in-process filesystem fence grant exactly the same roots" — the asymmetry "the write tool cannot write /tmp but bash can" is designed out. `canonicalPath` uses `realpathSync.native` because "Node's JavaScript realpath implementation lexically collapses `..` before resolving a preceding symlink on some platforms".
- **Edge cases / failure handling:** a path that cannot be resolved is returned as spelled — "a missing root matches nothing until it exists — the conservative outcome; inventing a fallback would grant a path the caller never named".
- **Surprising:** `os.tmpdir()` is included because "omitting it would deny what the mode promises" — the allow-list is a promise, not just a restriction.

### packages/sandbox/sandbox/src/diagnostics.ts
- **Purpose:** classify a failed confined run into "the runner failed" versus "confinement denied the file effect".
- **Key abstractions:** `isRunnerSpawnFailure(error, runnerProgram, workdir)`, `classifyRunnerFailure(exitCode, stderr, rules)`, `matchesSignature(exitCode, stderr, signatures)`.
- **Data flow:** `classifyRunnerFailure` splits stderr into lines, drops `informationalLines` by exact case-insensitive equality, then matches `fatalSignatures` case-insensitively within each remaining line, subject to the rule's optional `allowedExitCodes` gate.
- **Non-obvious design decisions:** "Exit status alone never proves runner failure" — a nonzero exit plus a fatal line is required. `isRunnerSpawnFailure` first rules out the **caller-owned cwd**: a spawn failure is only attributed to the runner when the workdir is usable *and* the error path equals argv[0] (or the syscall names it exactly). Empty or whitespace-only signatures are ignored, "instead of treating exit status or notice text as evidence".
- **Edge cases / failure handling:** a clean exit or a signal exit classifies as nothing; a workdir that cannot be entered makes every spawn failure unattributable, which is the conservative direction.
- **Surprising:** the workdir is checked at classification time, not atomically with the spawn — "concurrent path replacement may change attribution but cannot permit an unconfined execution".

### packages/sandbox/sandbox/tests/escalation.spec.ts
- **Purpose:** the escalation choreography's suite: the ladder, the argument pairing, the three marker texts, and every `approveEscalation` outcome.
- **Key abstractions:** a stub `EscalationApprover` returning a chosen outcome.
- **Data flow:** call the exported functions and assert the produced mode or the thrown text.
- **Non-obvious design decisions:** the suite pins the exact verbatim texts, "so bash and fs escalate identically" cannot drift.
- **Edge cases / failure handling:** every non-grant outcome maps to a distinct message (rejected / cancelled / unavailable); an outcome outside the closed union trips the exhaustiveness guard.
- **Surprising:** the rejected message tells the model what to do next — "it stays denied, so stop and explain instead of working around it".

### packages/sandbox/sandbox/tests/diagnostics.spec.ts
- **Purpose:** the runner-failure classifier's suite.
- **Key abstractions:** `RunnerFailureRule` fixtures, synthetic spawn errors.
- **Data flow:** feed an exit code, a stderr blob and a rule set; assert the matched detail or `undefined`.
- **Non-obvious design decisions:** the Landlock case requires "exit 125 plus a non-notice fatal line", and the returned detail is the **original** line, not the normalised one.
- **Edge cases / failure handling:** an empty signature beside a valid one is ignored without disabling the valid one; resource errors, non-spawn syscalls and a mismatched program are all rejected.
- **Surprising:** the classifier returns the *first* matching rule's line, and the rules are ordered — the table's order is the priority.

### packages/sandbox/sandbox/tests/roots.spec.ts
- **Purpose:** the writable-root derivation's suite.
- **Key abstractions:** `canonicalPath`, `writableRoots`.
- **Data flow:** build a real directory, then assert the derived set.
- **Non-obvious design decisions:** a path that cannot be resolved is returned as spelled — "conservative — matches nothing until it exists".
- **Edge cases / failure handling:** `read-only` grants nothing; the `workspace-write` set is canonical and deduplicated.
- **Surprising:** the set includes three roots, not one — the workspace, `/tmp` and the per-user temp dir.

### packages/sandbox/sandbox/tests/vocabulary.spec.ts
- **Purpose:** the fail-closed error's identity and message contract.
- **Key abstractions:** `SandboxUnavailableError`.
- **Data flow:** construct the error and assert `{name, code}` and the message.
- **Non-obvious design decisions:** the message names the refused mode and the three platform escape hatches, so an operator can fix the host without reading the code.
- **Edge cases / failure handling:** the runner detail is appended when the failure was discovered at execution time.
- **Surprising:** the error extends `HarnessError` so the structured code survives into `tool/result` — "callers can distinguish missing confinement from command failure".

### packages/sandbox/sandbox/package.json
npm manifest for `@deepseek-ai/dsh-sandbox` — ESM, runtime dep `@deepseek-ai/dsh-util-values` (for `assertNever`), peer deps on `dsh-llm`/`dsh-session`/`cordis`. No mechanism.

### packages/sandbox/sandbox/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`/`llm/llm`/`core/session`. Build wiring only.

### packages/sandbox/sandbox/README.md
Package reference for the confinement seam: the mode table, the denied-calls-and-escalation flow, the fail-closed behaviour, the design philosophy ("one execution world", "policy rides the call", "fail closed", "one vocabulary for denial and escalation"), and an honest limitations list — including that "denial reporting is a stderr dialect" and that "runner diagnostics are in-band", so a confined child that mimics its runner can cause a false attribution.

### packages/sandbox/sandbox/README.zh.md
Chinese translation of `packages/sandbox/sandbox/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/sandbox/sandbox/README.i18n.yaml
Per-heading bilingual hash record for `packages/sandbox/sandbox/README.md`. No mechanism.

### packages/sandbox/sandbox-local/src/index.ts
- **Purpose:** the local per-platform sandbox provider — runner selection, functional probes, the per-call wrap, and the Windows ACL grant lifecycle.
- **Key abstractions:** `PLATFORM_CHAINS` (linux `['bwrap','landlock']`, darwin `['seatbelt']`, win32 `['windows-acl']`), `STATIC_ENFORCEMENT` (win32 is **`partial`**), `DENIAL_SIGNATURES`, `RUNNER_FAILURE_RULES`, `SandboxInternals` (a test hook for every probe and every resolved binary), `AclWriteGrant`/`AclTempCapability`.
- **Data flow:** `confine(argv, policy, signal)` → canonicalise the workspace root → if `runnerCommand` is configured, wrap with the bwrap-shaped profile and assert `full`; else `selectRunner(mode)` (cached for the provider's lifetime) → build the runner argv → return `{argv, enforcement, denialSignatures, runnerFailureRules}`.
- **Non-obvious design decisions:** selection is **by platform first, probes second**: "a platform's chain is probed in preference order only when it has MORE than one candidate (probing arbitrates; it does not re-validate a choice that has no alternative)". A sole candidate is selected *without* a probe. The Windows rung is always `partial` because "NTFS hard links still alias a granted workspace file to a path outside it, reads stay unconfined, and a tree another AppContainer tool has ACL'd with a package SID is not readable by the Low-integrity child". `probeTimeoutMs` must be a positive finite number because "Node treats `spawnSync({timeout: 0})` as NO timeout, so an unvalidated 0 would silently mean 'unbounded' — the opposite of what the field promises".
- **Edge cases / failure handling:** a platform with no chain, or a chain where every probe fails, is `unavailable` and `confine()` throws `SandboxUnavailableError` — "the command never runs". The Windows runner's failure exit is **127**, distinct from Landlock's 125, and the rule is exit-gated on it "so a confined command that merely PRINTS the signature ... is never misclassified". Grant cleanup failures are logged, not thrown, because "cordis teardown must not be aborted by grant cleanup".
- **Surprising:** the workspace ACE is a **standing, never-revoked** grant that acts as a cross-session reuse cache, while the per-session temp grant is revocable; the exact-ACE skip makes every later provision O(1) instead of re-propagating the tree.

### packages/sandbox/sandbox-local/src/profiles.ts
- **Purpose:** the per-platform profile builders — bwrap mounts, Landlock grants, Seatbelt SBPL.
- **Key abstractions:** `bwrapProfileArgs`, `landlockProfileArgs`, `seatbeltProfileArgs`, `sbplString`.
- **Data flow:** each builder maps a `SandboxPolicy` to the runner's own dialect; the Seatbelt builder pulls its writable set from the shared `writableRoots` helper.
- **Non-obvious design decisions:** the bwrap profile is `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent` — "commands manage their descendants but cannot see host processes, so procfs magic links cannot bypass the mounts". The Seatbelt profile is "allow-default with `(deny file-write*)`" plus write allow-lists, and every root is canonicalised "because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`)".
- **Edge cases / failure handling:** SBPL string literals escape backslashes and double quotes.
- **Surprising:** the bwrap and Landlock dialects keep their **own** grant spellings (an ephemeral `/tmp` mount, launcher-owned flags) rather than reusing `writableRoots` — the README calls this "the honest per-runner differences recorded in the sandbox RFC, with parity pinned by test".

### packages/sandbox/sandbox-local/tests/local.spec.ts
- **Purpose:** the provider's unit suite: the three profile dialects, the `runnerCommand` override, the platform chains, the default probes, and the Windows runner invocation.
- **Key abstractions:** `SandboxInternals` (fake probes, fake launchers, a fake platform), the `ConfinedArgv` facts.
- **Data flow:** call `confine` and assert the produced argv, the enforcement fact, the denial signatures and the failure rules.
- **Non-obvious design decisions:** the suite pins that "darwin selects its sole candidate WITHOUT probing: nothing to arbitrate" and that "a platform with no chain fails closed without a single probe: the command never runs". It also pins the verdict cache: "one chain walk across wraps".
- **Edge cases / failure handling:** covered include a rogue chain entry and a rogue cached runner tag (both trip the exhaustiveness guard), a `probeTimeoutMs` of 0 (rejected as unbounded), a failing launcher read as `unusable`, and the source-runner fallback when the built entry is absent.
- **Surprising:** the source fallback "loads the full source runner independently of cwd and ambient tsconfig" — the tsx loader and the TypeScript path mapping are pinned into the argv, so a hostile `TSX_TSCONFIG_PATH` cannot redirect the runner's imports.

### packages/sandbox/sandbox-local/tests/acl-grants.spec.ts
- **Purpose:** the Windows grant lifecycle at the provider level: materialisation, reuse, upgrade/downgrade, crash residue, forks, workspace changes, and teardown.
- **Key abstractions:** the fake `ctx.fs`/grant internals; a real temp directory tree.
- **Data flow:** call `confine` under each mode and inspect the materialised grants.
- **Non-obvious design decisions:** the suite pins the reuse cache: "workspace-write materializes one standing workspace grant and one private temp capability, then reuses both" and "read-only materializes no capability; upgrade creates them and downgrade leaves them reusable".
- **Edge cases / failure handling:** covered include a cancelled confinement request (no grants created), a workspace containing the ambient temp root (rejected *before any ACL mutation*), a grant failure that disposes its SID and never creates a temp directory, and a teardown that reports cleanup failures without aborting.
- **Surprising:** "a fresh provider gives a resumed session a new temp path and SID, so crash residue cannot collide" — the random path, not a stored one, is the identity.

### packages/sandbox/sandbox-local/tests/bwrap.e2e.ts
- **Purpose:** the Linux bwrap rung's real-kernel end-to-end suite.
- **Key abstractions:** the real `bwrap` binary; a temp workspace.
- **Data flow:** a real confined process runs and the assertions are on the filesystem afterwards.
- **Non-obvious design decisions:** the suite pins "workspace-write mounts an EPHEMERAL /tmp: the write succeeds inside, the host /tmp stays untouched" — the bwrap dialect's documented difference from Landlock/Seatbelt.
- **Edge cases / failure handling:** covered include the read-only denial (the file must **not** exist), the tree staying readable with `/dev/null` writable, descendants being observable inside the private PID namespace, and a write beside the workspace being denied.
- **Surprising:** "keeps descendants observable and controllable inside the private PID namespace" — process visibility is deliberately preserved inside the namespace even though the host's processes are hidden.

### packages/sandbox/sandbox-local/tests/landlock.e2e.ts
- **Purpose:** the Linux Landlock rung's real-kernel end-to-end suite.
- **Key abstractions:** the packaged `landlock-run` launcher.
- **Data flow:** a real confined process runs under the launcher.
- **Non-obvious design decisions:** it pins the *documented profile difference*: "workspace-write grants the host /tmp (the documented Landlock-profile difference)" — Landlock grants the host temp area where bwrap mounts an ephemeral one.
- **Edge cases / failure handling:** covered include the read-only denial, the tree staying readable, and a write beneath the host `/dev` being denied so "the /dev/shm tmpfs must stay untouched".
- **Surprising:** the enforcement fact is read back from the launcher's own probe report rather than assumed.

### packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts
- **Purpose:** the macOS Seatbelt rung's real-kernel end-to-end suite.
- **Key abstractions:** `sandbox-exec -p <SBPL>`.
- **Data flow:** a real confined process runs under the SBPL profile.
- **Non-obvious design decisions:** it pins that read-only grants **no** temp area at all — "a write under the user temp dir is denied too" — the opposite of the workspace-write profile.
- **Edge cases / failure handling:** covered include the read-only denial, the tree staying readable, and the workspace-write profile granting both `/tmp` and the user temp dir.
- **Surprising:** the same "workspace-write" *mode* means three different writable sets across the three dialects — the reason `writableRoots` exists as a single owner.

### packages/sandbox/sandbox-local/tests/packed-install.e2e.ts
- **Purpose:** the packed (single-file) install rehearsal for the Landlock launcher.
- **Key abstractions:** the built launcher artifact; the installed consumer's `node_modules`.
- **Data flow:** install the launcher, then resolve it from the consumer and confine a real command through it.
- **Non-obvious design decisions:** the assertion is "confines through the installed launcher (enforcing kernel) or fails closed (non-enforcing) — **never unconfined**".
- **Edge cases / failure handling:** the launcher must be present, executable, byte-identical and of the right ELF arch; the provider must resolve the launcher *inside* the consumer's platform package.
- **Surprising:** the test is allowed to pass on a non-enforcing kernel — it asserts the fail-closed outcome, not success.

### packages/sandbox/sandbox-local/tests/packed-workspace-closure.ts
- **Purpose:** the helper that computes the runtime closure a packed install must ship.
- **Key abstractions:** `readWorkspacePackages(repoRoot)`, `packedWorkspaceClosure(rootName, packages)`, `WorkspacePackage`.
- **Data flow:** `pnpm list --recursive --depth -1 --json` → each manifest → follow `dependencies`/`optionalDependencies`/required `peerDependencies` whose range starts with `workspace:` → sorted closure.
- **Non-obvious design decisions:** optional peers are excluded, so a packed install does not ship a package it may never use.
- **Edge cases / failure handling:** a non-array inventory, a non-object entry, a manifest whose declared name disagrees with the inventory, and a repeated name all throw; an unresolvable dependency throws.
- **Surprising:** it shells out to `pnpm` — a build-time rehearsal helper, not runtime code.

### packages/sandbox/sandbox-local/tests/packed-workspace-closure.spec.ts
- **Purpose:** the closure helper's suite.
- **Key abstractions:** synthetic workspace manifests.
- **Data flow:** build a map of packages and assert the computed closure.
- **Non-obvious design decisions:** the suite pins "follows install edges and required peers but excludes development and optional peers".
- **Edge cases / failure handling:** a missing workspace dependency fails the closure rather than being silently skipped.
- **Surprising:** the closure is sorted by package *directory*, which makes the packed artifact's file order deterministic.

### packages/sandbox/sandbox-local/package.json
npm manifest for `@deepseek-ai/dsh-sandbox-local` — runtime deps `@deepseek-ai/dsh-sandbox-windows-acl`, `@deepseek-ai/dsh-util-values` and `@deepseek-ai/node-addon-system` (the Landlock launcher); peer deps on `dsh-sandbox`/`dsh-session`/`cordis`. No mechanism.

### packages/sandbox/sandbox-local/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `native/system/packages/entry` (the Landlock launcher), `sandbox/sandbox`, `sandbox/sandbox-windows-acl` and `core/session`. Build wiring only.

### packages/sandbox/sandbox-local/README.md
Package reference for the local provider: the config table, the enforcement facts, the fail-closed behaviour, the runner-selection rules, the per-platform profile summaries, the Windows grant model, and the limitations (Windows ACL is partial, Landlock may be partial, Seatbelt depends on a deprecated `sandbox-exec`, the selection is cached for the provider lifetime, and `runnerCommand` is an operator assertion).

### packages/sandbox/sandbox-local/README.zh.md
Chinese translation of `packages/sandbox/sandbox-local/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/sandbox/sandbox-local/README.i18n.yaml
Per-heading bilingual hash record for `packages/sandbox/sandbox-local/README.md`. No mechanism.

### packages/sandbox/sandbox-local/locale/en.json
Two-line locale stub: `{"meta":{"title":"sandbox-local"}}`. No mechanism.

### packages/sandbox/sandbox-local/locale/zh.json
Chinese locale stub: title `本地进程沙箱` with a one-line description of per-OS process isolation. No mechanism.

### packages/sandbox/sandbox-policy/src/index.ts
- **Purpose:** the shared policy home `ctx.sandboxPolicy` — the deployment default, the fallback workspace root, per-session resolution, and the model-visible current policy.
- **Key abstractions:** `SandboxPolicyService`, `Config` (`mode` defaulting to **`read-only`**, `workspaceRoot` with no schema default), `SandboxPolicyRequest`, the `sandboxMode` session projection, the `sandbox:policy` system-prompt context.
- **Data flow:** `resolve({session, mode})` → mode = explicit grant ?? the session's folded `sandbox/mode` state ?? the deployment default; workspaceRoot = the session's immutable `header.cwd` ?? the configured fallback; the resolved policy is stamped onto every capability call and rendered into the runtime-context snapshot.
- **Non-obvious design decisions:** `read-only` is the shipped default because it is "the fail-safe default; a deployment that wants a workspace-writable agent opts in explicitly". The context contribution describes the *mode's* file-effect contract "without claiming which capabilities are mounted" — tool plugins keep their own operation-specific guidance. The contribution is injected under `ctx.inject(['systemPrompt'])` so it appears only when a prompt service exists.
- **Edge cases / failure handling:** a relative configured `workspaceRoot` fails at load; the mode is validated at load so "a typo fails loud instead of silently changing policy"; an agentless call falls back to the configured root.
- **Surprising:** the workspace root keeps the **execution-world spelling** — "Enforcing providers canonicalize the root on their own filesystem, so remote `symlink/..` paths are never resolved on the Harness host."

### packages/sandbox/sandbox-policy/src/session-mode.ts
- **Purpose:** the per-session sandbox-mode override — the session log as the store, plus the write path.
- **Key abstractions:** the `sandbox/mode` session event, `SANDBOX_MODES`, `setSandboxMode(session, mode)`.
- **Data flow:** `setSandboxMode` appends exactly one `sandbox/mode` event; the `sandboxMode` session projection folds the last such event; `overrideOf(session)` reads the folded state.
- **Non-obvious design decisions:** "the switch IS its event; nothing mutates mode state out of band" — there is no external config store, so an override "survives restart by replay, two sessions can never see each other's state, and there is no external config store". The event is **log-only** (the `approval/*` precedent): durable and replayable, never in the model transcript.
- **Edge cases / failure handling:** a session with no switch reads as `null` and the deployment default applies; a `source: 'delegation'` marker distinguishes an override seeded into a child.
- **Surprising:** the workspace identity needs no event at all — the immutable `SessionHeader.cwd` recorded at creation is the boundary for the session's whole life.

### packages/sandbox/sandbox-policy/tests/policy.spec.ts
- **Purpose:** the policy service's suite: defaults, load-time validation, per-session resolution, the approved-mode override, the request context, and the session kit.
- **Key abstractions:** real `Session` objects with projections; a `systemPrompt` service double.
- **Data flow:** call `resolve` and `setSandboxMode` and assert the resolved policy and the rendered context.
- **Non-obvious design decisions:** the context suite asserts "keeps the complete rendered prompt byte-stable across TMPDIR changes" — the policy text must not leak host-dependent temp paths — and "reflects the latest durable switch on the next assembly and stays byte-stable otherwise".
- **Edge cases / failure handling:** covered include a relative root rejected at load, a mode outside the closed vocabulary rejected at load, a session without a cwd falling back to the configured root, and the projection folding to the last switch.
- **Surprising:** the switch survives a restart by log replay, so the policy is reconstructed from the transcript rather than from a config file.

### packages/sandbox/sandbox-policy/package.json
npm manifest for `@deepseek-ai/dsh-sandbox-policy` — runtime deps `schemastery` and `zod@4.4.3` (the projection state schema); peer deps on `dsh-agent`, `dsh-sandbox`, `dsh-session`, `dsh-system-prompt`, `dsh-session-projection` and `cordis`. No mechanism.

### packages/sandbox/sandbox-policy/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `core/agent`, `sandbox/sandbox`, `core/session`, `core/system-prompt` and `session/session-projection`. Build wiring only.

### packages/sandbox/sandbox-policy/tsdown.config.ts
A one-file tsdown bundle config: ESM, node platform, `es2024` target, `dts: false`, `clean: false` — the package ships a single bundled `lib/index.js` with no type build. Build wiring only.

### packages/sandbox/sandbox-policy/README.md
Package reference for the policy home: the config table, the resolution precedence, the per-session store, the model-visible text (all three modes quoted verbatim), and the limitations — one primary workspace root per session, file-effect modes only, and temporary areas deliberately summarised because "enforcing backends grant different platform temporary areas, which are selected after policy resolution".

### packages/sandbox/sandbox-policy/README.zh.md
Chinese translation of `packages/sandbox/sandbox-policy/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/sandbox/sandbox-policy/README.i18n.yaml
Per-heading bilingual hash record for `packages/sandbox/sandbox-policy/README.md`. No mechanism.

### packages/sandbox/sandbox-policy/locale/en.json
Two-line locale stub: `{"meta":{"title":"sandbox-policy"}}`. No mechanism.

### packages/sandbox/sandbox-policy/locale/zh.json
Chinese locale stub: title `沙箱权限策略` with a one-line description of per-call limits derived from the session's mode and workspace. No mechanism.

### packages/sandbox/sandbox-windows-acl/src/index.ts
- **Purpose:** `AclSandbox` — the Windows write-restriction backend: a `WRITE_RESTRICTED` token whose restricting SIDs carry the workspace and temp write capabilities, plus the DACL/label grants and the fail-closed spawn.
- **Key abstractions:** `AclSandboxOptions` (writable dirs, temp dir, `writeSid`, `tempWriteSid`, mode, `manageDacls`), `AclSandboxChild`, `AclSandboxChildResult`.
- **Data flow:** `init()` → open the current token → parse the write SIDs → validate the temp directory → grant the ACE + deny + Low label → find the logon SID → `CreateRestrictedToken` with the mode's restricting list → lower the integrity level → merge a full-access ACE into the token's default DACL → `spawn()` the child under the token.
- **Non-obvious design decisions:** the default-DACL merge exists because "the restricted token's default DACL still names only the user's ambient SIDs — none of the restricting SIDs", so a new anonymous pipe would fail the write pass-2 check and "break every piped-stdio grandchild spawn"; the merged ACE names the **temp** SID when present "so default-DACL objects in one session's temp tree do not acquire the shared workspace capability". `init()` is fail-closed — any Win32 failure revokes the revocable grants and throws, and standing workspace ACEs are deliberately *not* revoked ("they are the intended end state, not an error artifact"). The constructor validates the whole grant shape up front (workspace-write needs a write SID and an explicit temp dir or `null`; the two SIDs must be distinct).
- **Edge cases / failure handling:** `spawn` refuses before `init()`, refuses a control pipe with piped stdio, and never creates an unrestricted child. `dispose()` reports every cleanup failure as an `AggregateError`. A failed init aggregates the primary error with the cleanup failures.
- **Surprising:** `manageDacls: false` exists so the *caller* (the sandbox seam) can own the grant lifecycle — the seam materialises the ACEs once per workspace and passes both SIDs to the runner, which then grants and revokes nothing.

### packages/sandbox/sandbox-windows-acl/src/token.ts
- **Purpose:** the restricted-token construction: open the current token, extract the logon SID, build the well-known SIDs, create the restricted token, lower its integrity, and adjust its default DACL.
- **Key abstractions:** `openCurrentProcessToken`, `findLogonSid`, `makeWellKnownSid`, `setTokenDefaultDaclGrant`, `restrictTokenIntegrity`, `createRestrictedToken`, `buildRestrictingSids`.
- **Data flow:** `CreateRestrictedToken(currentToken, DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED, 0, null, 0, null, restrictingSids.length, restrictingSids, out)` → `SetTokenInformation(TokenIntegrityLevel)` → `SetTokenInformation(TokenDefaultDacl)`.
- **Non-obvious design decisions:** the restricting list is `[logon SID, EVERYONE]` under read-only and `[logon SID, EVERYONE, workspace SID, temp SID]` under workspace-write. The keep-alive group is in **both** modes because "early DLL init dies with 0xC0000142 and CNG (`\Device\CNG` write trustee — pwsh crashes 0xE0434352) fails without them". The write SIDs join **only** workspace-write, so "a standing grant ACE from an earlier workspace-write period ... stays INERT under read-only" while "the unrevoked ACE keeps the re-upgrade free". Authenticated Users is absent from both lists (the WMI namespace check fails, so CIM is unavailable — "and the C:\-root tree-creation escape ... is closed in both"), and INTERACTIVE/LOCAL are absent so the host's Public tree writes are denied.
- **Edge cases / failure handling:** every API call is checked; a failure throws with the API name and the exact Win32 code — "the original POC ignored all of these and silently ran children with the FULL, unrestricted token". The `SE_GROUP_LOGON_ID` test uses `>>> 0` because "JS bitwise & is signed 32-bit; SE_GROUP_LOGON_ID has bit 31 set".
- **Surprising:** `SE_GROUP_LOGON_ID` is `0xC0000000` — a signed-int trap that the code explicitly calls out with a comment.

### packages/sandbox/sandbox-windows-acl/src/acl.ts
- **Purpose:** the ACL editing primitives — grant and revoke a capability SID on a directory, with the ambient-delete deny and the Low mandatory label.
- **Key abstractions:** `grantWrite`, `revokeWrite`, `withPathLock`, `lockFilePath`, `buildExplicitAccess`, `buildLowLabelAcl`, `readCurrentSecurity`, `mergeAndApply`, `hasExactEntry`/`hasExactGrant`/`hasExactDeny`/`hasExactLabel`/`hasForeignGrant`.
- **Data flow:** `withPathLock` (a `LockFileEx` lock file under `GetTempPathW()`) → `GetNamedSecurityInfoW` → the exact-ACE/deny/label check → `SetEntriesInAclW` merge → `SetNamedSecurityInfoW` applying the DACL and the label in **one** call → free every allocation.
- **Non-obvious design decisions:** each grant applies **three** edits in one call: the capability allow ACE, a `FILE_DELETE_CHILD` deny for the world SID, and the Low no-write-up label. The deny "is what keeps one granted root out of another's reach: Windows also authorizes a delete from the parent directory's `FILE_DELETE_CHILD` right, which the token's write-restricted intersection does not reach". The deny inherits to **containers only** — "the right is evaluated on directories, and inheriting its bit onto files would deny every `FILE_ALL_ACCESS`/`GENERIC_ALL` open inside the root". The exact-ACE check exists because the alternative is "eager inheritance; minutes on large workspaces". The lock file is opened **without** `FILE_SHARE_DELETE` "because a deletable lock file could be removed and recreated under the holder, letting two processes hold 'the same' lock".
- **Edge cases / failure handling:** the allocation contract is explicit — "only the descriptor may be LocalFree'd, and it must not be freed before SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself corrupts the heap (verified the hard way)". A malformed ACL header reads as "no exact entry" and falls back to the merge path. `revokeWrite` clears the shared Low label only when no other capability grant remains.
- **Surprising:** the ACE's SID is **inline** in the ACE after the 4-byte mask — "there is no pointer to read; reading one yields garbage addresses and crashed EqualSid, verified by gdb" — so the comparison is a bounded field-by-field read.

### packages/sandbox/sandbox-windows-acl/src/grant.ts
- **Purpose:** `AclWriteGrant` — the server-side materialisation of one write SID's grants across directories.
- **Key abstractions:** `AclWriteGrant.create(writeSid, api?)`, `add(path, standing)`, `dispose()`, `paths`.
- **Data flow:** `create` parses the SID string and builds the Low-label and world SIDs; `add` records the path and calls `grantWrite`; `dispose` revokes the *revocable* paths, keeps the *standing* ones, and frees the three SIDs.
- **Non-obvious design decisions:** the standing/revocable split is the reuse cache: workspace paths are "STANDING (their security descriptor edits are the cross-session reuse cache and outlive the grant ... or the next provision would re-propagate the whole tree)", temp paths are revocable. The path is recorded **before** the grant, because "a post-apply throw (a LocalFree failure after SetNamedSecurityInfoW succeeded) must still revoke it, and revoking an ungranted path is a no-op merge".
- **Edge cases / failure handling:** `create` fails closed — a SID parse failure throws "before anything is granted", and the Low-label SID is freed if the world SID then fails. `dispose` aggregates every cleanup failure into an `AggregateError`.
- **Surprising:** a grant instance is a *capability*, not a directory — the same SID can be granted on many directories, and one revocation undoes all of them.

### packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts
- **Purpose:** the two capability identities — the per-workspace write SID and the per-private-temp write SID.
- **Key abstractions:** `workspaceWriteSid(canonicalRoot)` and `tempWriteSid(tempDir)`, both producing an `S-1-4-x-y` (or `S-1-4-x-y-1`) SDDL string.
- **Data flow:** `sha256(path)` → two 30-bit sub-authorities → the SDDL string; the temp variant hashes `'temp\0' + path` for domain separation.
- **Non-obvious design decisions:** the workspace SID is **deterministic from the canonical path**, so "every confined execution of the same workspace — across sessions, server restarts, and calls — carries the SAME write SID" and the workspace-root ACE materialises once per workspace per machine. The input **must** be canonical: "canonicalization converges case/alias spellings, so two spellings of one workspace derive one SID; an as-spelled fallback path would mint a second identity for the same directory". The temp SID's third sub-authority domain-separates it from every two-sub-authority workspace SID.
- **Edge cases / failure handling:** renaming the workspace derives a new SID — "the old standing ACEs are inert residue, and the next session re-propagates once".
- **Surprising:** "The SID's power is defined solely by the ACEs that name it ... and only tokens minted for that workspace carry it — the SID string itself is not a secret."

### packages/sandbox/sandbox-windows-acl/src/path-boundary.ts
- **Purpose:** the two canonical boundary checks between the workspace capability and the private temp capability.
- **Key abstractions:** `assertTempRootOutsideWorkspace(workspaceRoot, tempRoot)`, `assertPrivateTempDisjoint(writableDirs, tempDir)`, `containsDirectory`.
- **Data flow:** `realpathSync.native` both paths, then `relative()` to decide containment.
- **Non-obvious design decisions:** the temp root may not be *inside* the workspace, "because every child created below it would inherit the standing workspace capability"; the private temp directory must be disjoint in **either** direction, "because either inheritance direction would merge the two capabilities".
- **Edge cases / failure handling:** both checks throw with the offending paths named.
- **Surprising:** the first check compares a *parent* (the temp root) against the workspace, while the second compares the *actual private directory* — two different questions about two different objects.

### packages/sandbox/sandbox-windows-acl/src/ffi.ts
- **Purpose:** the koffi binding table for the ACL/token APIs, layered on the shared `dsh-win32-process` bindings.
- **Key abstractions:** `Win32Bindings`, `allocBytes`, `allocOverlapped`, `allocPtrSlot`, `encodeUint32`, `ptrAddress`, `decodePtrAt`, `decodeUint8At`/`Uint16`/`Uint32`, `sameSidAt`, `isInvalidHandle`, `getTempPath`, `win32`/`win32Sync`.
- **Data flow:** `bindings()` lazily loads koffi, binds each Win32 function once, and caches the table; `win32()`/`win32Sync()` hand it out.
- **Non-obvious design decisions:** `allocOverlapped` returns a **zeroed** 32-byte record rather than `NULL`, because "Koffi 3.1.1 crashes when LockFileEx or UnlockFileEx receives NULL; a zeroed OVERLAPPED is equivalent for the synchronous lock-file handle". `sameSidAt` compares SIDs **field by field through bounded offset reads** — "no memcpy, no pointer arithmetic".
- **Edge cases / failure handling:** `decodePtrAt` maps address zero to `null`; `isInvalidHandle` treats null, zero and the all-bits-one sentinel as failure; `getTempPath` rejects a required length larger than the fixed buffer.
- **Surprising:** the `PVOID`/`PPVOID` koffi types are cached separately because `koffi.pointer('void')` is not a compile-time constant.

### packages/sandbox/sandbox-windows-acl/src/win32-abi.ts
- **Purpose:** the numeric Win32 constants the sandbox uses, in one auditable file.
- **Key abstractions:** the access masks, the ACE types, the inheritance flags, the `TOKEN_INFORMATION_CLASS` values, the struct sizes and offsets.
- **Data flow:** none — imported by every other module in the package.
- **Non-obvious design decisions:** `GRANT_MASK` deliberately excludes `WRITE_DAC` and `WRITE_OWNER` "so a confined child cannot rewrite DACLs or take ownership to escape the allowlist". `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP` is documented as covering "writes and deletes granted through a parent directory's FILE_DELETE_CHILD right — the path the write-restricted pass-2 intersection does not reach".
- **Edge cases / failure handling:** n/a.
- **Surprising:** the file is the *other half* of `verify/abi-probe.cpp` — every constant here is asserted against the real Windows headers by a C++ `static_assert` program.

### packages/sandbox/sandbox-windows-acl/src/spawn.ts
- **Purpose:** the restricted-token spawn adapters over the shared `dsh-win32-process` primitives.
- **Key abstractions:** `spawnSandboxed` (piped stdio), `spawnSandboxedInherited` (kill-on-close job + inherited stdio), `waitForExit`, plus the re-exported `drainPipe`.
- **Data flow:** both helpers delegate to the shared package with the restricted token attached.
- **Non-obvious design decisions:** this file owns no Win32 logic — the shared package owns "process, stdio, and Job ABI" and this package only supplies the token.
- **Edge cases / failure handling:** the shared package's handle-cleanup contract applies unchanged.
- **Surprising:** the file is 60 lines because the hard part (CreateProcessAsUserW, the job object, the pipe drains) was already extracted into a shared, separately verified package.

### packages/sandbox/sandbox-windows-acl/src/runner.ts
- **Purpose:** the argv-prefix confinement runner the sandbox seam spawns in place of the caller's command.
- **Key abstractions:** the stable argv contract, `parseArgs`, `requireDirectory`, `fail(detail)`, `RunnerFailure`.
- **Data flow:** parse the argv → validate both directories in **both** modes → derive/verify the SIDs → `AclSandbox.init()` → rewrite `TMP`/`TEMP` to the private directory → `spawn` with `stdio: 'inherit'` → mirror the child's exit code → dispose and remove the owned temp directory.
- **Non-obvious design decisions:** the runner sets `SetConsoleCtrlHandler(null, 1)` to ignore its own Ctrl+C, "because the confined child (same console) keeps handling its own; the runner must survive to revoke grants and mirror the child's exit code". The `TMP`/`TEMP` rewrite happens in the runner's **own** environment because "an explicit block through koffi trips ERROR_INVALID_PARAMETER in CreateProcessAsUserW, verified empirically". The SID pair is optional: with it the runner manages no DACLs at all; without it, the runner creates a random private child under `--temp` and removes it on exit.
- **Edge cases / failure handling:** every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits **127** — "the seam's RUNNER_FAILURE_RULES matches that signature. The child is NEVER spawned unrestricted". Cleanup failures are reported but "must not mask the child's exit code".
- **Surprising:** the exit-code mirroring is full-width on Windows — a child exiting with `STATUS_ACCESS_VIOLATION` is read back as the uint32 3221225477 and mirrored exactly, "so no truncation or masking happens anywhere in the chain".

### packages/sandbox/sandbox-windows-acl/src/acl-skill.ts
- **Purpose:** registers the bundled `diagnose-windows-sandbox-acl` skill with the skill registry.
- **Key abstractions:** `ACL_DIAGNOSIS_SKILL`, `registerAclDiagnosisSkill(ctx)`, `parseSkill`.
- **Data flow:** on registration the packaged assets are **copied to a private temp directory** (`SKILL.md` + the PowerShell script, mode `0600`), the frontmatter is parsed for the description, and a `SkillCandidate` + `SkillProvider` are registered.
- **Non-obvious design decisions:** the copy exists because "The provider owns a private filesystem copy of its resources so external PowerShell can execute them even when the package lives inside ASAR or SEA". The copy is removed on disposal. A missing or invalid packaged asset fails registration loudly.
- **Edge cases / failure handling:** `parseSkill` throws when the frontmatter is missing or the description is absent/empty.
- **Surprising:** the skill body never enters the model context — only its description does, via the catalog.

### packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/SKILL.md
- **Purpose:** the model-facing instructions for diagnosing and repairing Windows sandbox ACL failures.
- **Key abstractions:** the single-command contract (`-Path`, `-AllowRoot`, `-Out`), the `nextAction` table, the "never" list, the user-facing stop message (in Chinese and English).
- **Data flow:** the model reads the skill, requests one approval for one command, runs the script unconfined, reads the `RECAP`, and decides from `details.nextAction`.
- **Non-obvious design decisions:** the approval request must be written "in plain words, in the user's language" and must exclude ACL jargon ("write Windows file permissions, not ACL or ACE"). The script must be run **unconfined**: "The script writes permissions, which the confined token cannot do — run it there and it would report the sandbox's own restriction as a missing right". The skill insists on one command, one approval, and never splitting diagnosis from repair.
- **Edge cases / failure handling:** a denied approval means "report the path as undiagnosed and stop". The `nextAction` table (`verify_original_confined_operation` / `stop` / `restore_pending_then_stop`) is the decision surface. A verified repair is **not** undone because the original operation fails for a further reason.
- **Surprising:** the skill tells the model to ask the user to switch the session to full access and to send the session as feedback — "only what reaches this conversation travels with it" — an explicit feedback loop for uncovered failure classes.

### packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1
- **Purpose:** the 798-line PowerShell program that diagnoses and repairs Windows ACL failures in one run.
- **Key abstractions:** `param(Path, AllowRoot, Out, Restore)`; the `REPORT`/`RECAP`/`SUMMARY` stdout protocol; the `$PACKAGE_SID` pattern and `$SCAN_LIMIT = 2000`; the helper functions (`Write-Report`, `Invoke-ReportedOperation`, `Save-AclBackup`, `Restore-SavedDacl`, `Get-ObjectFacts`, `Get-Ancestors`, `Get-SubtreePackageSources`, `Get-RepairRefusal`).
- **Data flow:** classify each requested path and its ancestors → grant a full-control allow ACE where `WRITE_DAC`/`WRITE_OWNER` is missing → remove explicit AppContainer package allow ACEs ancestor-first → verify each change by re-reading it → roll back on failure → emit a JSON report, a `.jsonl` report file, a DACL backup and a recovery `.ps1` per change.
- **Non-obvious design decisions:** the script "never creates, deletes, or writes the contents of any file" — its only writes are the recovery artifacts and the DACLs it repairs. Every report record is **also** written to `-Out\acl-report-*.jsonl`, "because tool output keeps only its tail". A `REPORT_IO_FAILED` line goes to stderr so a truncated report file cannot be mistaken for a complete one. The package-SID pattern `'^S-1-15-2-(?![12]$)'` excludes the two well-known groups that name *all* packages. A subtree scan is bounded by `$SCAN_LIMIT` and reports truncation instead of claiming a complete walk.
- **Edge cases / failure handling:** `-AllowRoot` bounds every change ("an object is modified only when it is that directory or strictly inside it"); reparse paths and managed application trees are refused; a failed repair restores the attempted changes **in reverse order** and exits nonzero; a rollback that cannot be verified leaves `restore_pending_then_stop` with the pending commands printed.
- **Surprising:** it never spawns `whoami.exe` to read the integrity level, "because inside a below-Medium token that process fails to initialize (STATUS_DLL_INIT_FAILED, 0xc0000142) and raises an application-error dialog on the user's desktop" — it reads the token through `GetTokenInformation` instead.

### packages/sandbox/sandbox-windows-acl/verify/abi-probe.cpp
- **Purpose:** the C++ verification program that asserts every Win32 constant and struct layout the package hard-codes.
- **Key abstractions:** a `P(expr)` macro printing each constant, and a block of `static_assert`s.
- **Data flow:** compiled and run on Windows; it prints the measured values and asserts the package's assumptions.
- **Non-obvious design decisions:** the `static_assert`s pin `sizeof(EXPLICIT_ACCESS_W) == 48`, `sizeof(TRUSTEE_W) == 32`, `sizeof(SID_AND_ATTRIBUTES) == 16`, `sizeof(TOKEN_MANDATORY_LABEL) == 16`, `sizeof(ACL) == 8`, the token rights, the access mask `0x110156`, and the share/open/lock flags.
- **Edge cases / failure handling:** the program exits nonzero if any assertion fails, which is the gate.
- **Surprising:** this is a *compiled* check shipped inside the npm package — the TypeScript constants are not "trust me", they are checked against the headers on every release.

### packages/sandbox/sandbox-windows-acl/tests/acl.spec.ts
- **Purpose:** the ACL primitive's behavioural suite on real Windows ACLs.
- **Key abstractions:** real directories with real DACLs; `grantWrite`/`revokeWrite`; `withPathLock`.
- **Data flow:** grant, inspect, revoke, and assert the resulting DACL.
- **Non-obvious design decisions:** the suite pins "the ambient-delete deny inherits to subdirectories only, never onto files" and "revoking one of two grants on a directory keeps the shared Low label" — both are the boundaries that keep one granted root from reaching another.
- **Edge cases / failure handling:** covered include an explicit `Users` ACE surviving grant+revoke (the merge, not a replace), the idempotent exact-ACE skip, interleaved sandbox instances leaving **both** standing workspace ACEs, an overlapping private temp directory rejected before either capability is applied, and the per-path lock being genuinely exclusive (`ERROR_LOCK_VIOLATION`).
- **Surprising:** the applied grant mask is asserted to carry `DELETE` and `FILE_DELETE_CHILD` but **never** `WRITE_DAC`/`WRITE_OWNER` — the child cannot rewrite its own DACLs.

### packages/sandbox/sandbox-windows-acl/tests/acl-failure-paths.spec.ts
- **Purpose:** the exhaustive Win32 failure-path suite for the ACL module.
- **Key abstractions:** a faked koffi binding table that fails one call at a time.
- **Data flow:** force each API to fail and assert the reported error and the free/cleanup behaviour.
- **Non-obvious design decisions:** each case asserts *which allocations were freed* — "frees the descriptor and reports when SetEntriesInAclW fails", "frees the merged ACL and the label ACL and reports when SetNamedSecurityInfoW fails" — so a leak is a test failure, not a code review comment.
- **Edge cases / failure handling:** covered include an invalid `CreateFileW` handle, a failed `LockFileEx`/`UnlockFileEx`/`CloseHandle`, a failed `GetLengthSid`/`LocalAlloc`/`InitializeAcl`/`AddMandatoryAce`, a NULL merged ACL, and a failed `LocalFree` after a *successful* apply.
- **Surprising:** the "lying ACE size" and "malformed tiny DACL" cases exist so a corrupt ACL can never make the revoke path *keep* a label it should clear.

### packages/sandbox/sandbox-windows-acl/tests/index-failure-paths.spec.ts
- **Purpose:** the `AclSandbox` constructor-validation and init/spawn/dispose failure suite.
- **Key abstractions:** the constructor's grant-shape validation; a faked Win32 table.
- **Data flow:** construct with each invalid shape, then force failures inside `init`, `spawn` and `dispose`.
- **Non-obvious design decisions:** the constructor rejects the *shape* combinations up front (workspace-write without a write SID, a temp SID without a temp directory, the two SIDs equal, read-only with a temp directory or any write SID) — "a knob that always refuses is a lie" is the sibling principle.
- **Edge cases / failure handling:** covered include a missing writable directory, a relative directory resolved to absolute, a second `init()` refused, a `ConvertStringSidToSidW` failure before any grant, an aggregated token-close failure, a revoked temp grant on a failed init, a control pipe requested with piped stdio (refused **before** process creation), and a failed kill-on-close job close.
- **Surprising:** `manageDacls: false` is tested to apply **no** grants and revoke **none** — the caller's ownership is a hard invariant, not a convention.

### packages/sandbox/sandbox-windows-acl/tests/token-failure-paths.spec.ts
- **Purpose:** the token-construction failure suite.
- **Key abstractions:** a faked binding table; the `RestrictingSidSet` shape.
- **Data flow:** force each token API to fail and assert the error and the restricting list that would have been built.
- **Non-obvious design decisions:** the suite asserts the exact restricting lists — "builds the read-only restricting list without a write SID" and "builds the workspace-write restricting list with the write SID".
- **Edge cases / failure handling:** covered include a NULL `OpenProcess` handle, a failed `OpenProcessToken` (the process handle is closed on the error path), a NULL token handle, a size probe that wrote nothing, an implausibly small `TokenGroups`, a NULL group SID pointer, a non-logon group, a zero SID length, a failed `CopySid`, a failed `CreateWellKnownSid`, an invalid well-known SID, a failed `SetEntriesInAclW` merge, and a failed `SetTokenInformation` for both the integrity level and the default DACL.
- **Surprising:** "skips a NULL group SID pointer and throws when no logon SID remains" — a null group is skipped, but a *missing* logon SID is fatal, because the restricted token needs it for WinSta0/desktop.

### packages/sandbox/sandbox-windows-acl/tests/grant-failure-paths.spec.ts
- **Purpose:** the `AclWriteGrant` failure suite.
- **Key abstractions:** a faked binding table.
- **Data flow:** force the SID parse, the well-known SID creation, the revocation or the free to fail.
- **Non-obvious design decisions:** the suite pins the exact free order — "create frees both earlier SIDs when the world SID cannot be created" — so a partially-constructed grant leaks nothing.
- **Edge cases / failure handling:** a failing revocation and a failing SID free are each aggregated into an `AggregateError` ("best-effort cleanup").
- **Surprising:** the `create` failure path is tested *before any grant exists*, so the "nothing is granted" guarantee is enforced, not assumed.

### packages/sandbox/sandbox-windows-acl/tests/grant.spec.ts
- **Purpose:** the `AclWriteGrant` happy-path suite.
- **Key abstractions:** a real `AclWriteGrant` over a real directory, with the SID parsed from an SDDL string.
- **Data flow:** `create` → `add(path, standing)` → inspect the resulting DACL → `dispose()` and re-inspect.
- **Non-obvious design decisions:** the suite pins the standing-versus-revocable split directly — `dispose` "revokes revocable paths and keeps standing paths standing" — which is the reuse cache expressed as a test.
- **Edge cases / failure handling:** a malformed SID throws before anything is granted; two grants with different SIDs coexist and revoke independently.
- **Surprising:** a grant instance is a *capability* over a SID, not a directory — adding it to many directories and revoking it once is the intended usage.

### packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts
- **Purpose:** the runner's Windows behavioural suite — the real confinement, the mode-downgrade leak, the escape regressions, and the runner failure contract.
- **Key abstractions:** real `pwsh` children under the restricted token; real temp workspaces.
- **Data flow:** the runner is invoked with the seam's argv and a real command runs under it; the assertions are on the filesystem and the child's exit code.
- **Non-obvious design decisions:** the suite includes explicit **regression** cases named as such: "mode-downgrade leak regression: a STANDING workspace grant is inert under read-only and effective again on re-upgrade", "ambient-writable escape regression: a C:\Users\Public subdirectory is denied under BOTH modes (INTERACTIVE absent from both lists)", "delete-escape regression: deletes outside the granted roots are denied in BOTH modes, through every delete authority", and "cross-root delete regression: one session cannot delete inside ANOTHER granted root".
- **Edge cases / failure handling:** covered include temp capability isolation between sibling sessions, an agentless workspace-write creating and removing a fresh private temp per call, a temp root inside the workspace rejected before spawning, grandchild spawning with inherited stdio while piped capture stays denied, and a runner-side failure exiting 127 with the signature.
- **Surprising:** "the Low mandatory label closes the Everyone-Modify ambient boundary under BOTH modes" and "NUL writes stay ambient under the Low token in BOTH modes" — two explicitly recorded residual boundaries rather than silent gaps.

### packages/sandbox/sandbox-windows-acl/tests/probe.spec.ts
- **Purpose:** the sandbox's own probe of the confined child.
- **Key abstractions:** a real `AclSandbox` instance over temp directories.
- **Data flow:** init, spawn a probe command, inspect the filesystem.
- **Non-obvious design decisions:** the suite asserts the confinement actually holds ("allows writes only in granted directories and denies the escape write") and that "fails closed when the write SID cannot be parsed (no unrestricted fallback)".
- **Edge cases / failure handling:** "failed init clears provisional temp state before a retry" — a failed init leaves nothing behind.
- **Surprising:** the suite treats "the write SID cannot be parsed" as a *fail-closed* case rather than a configuration error to be tolerated.

### packages/sandbox/sandbox-windows-acl/tests/control.spec.ts
- **Purpose:** the control-pipe forwarding test.
- **Key abstractions:** the `controlFileDescriptor: 7` option and the kill-on-close job.
- **Data flow:** spawn with inherited stdio and the control descriptor; assert the bytes arrive.
- **Non-obvious design decisions:** "preserves binary bytes through the Job and restricted-token runners while denying writes" — the control channel must be byte-exact, not text-safe.
- **Edge cases / failure handling:** the write denial still applies on this path.
- **Surprising:** the control pipe rides file descriptor 7, a convention inherited from the subprocess seam.

### packages/sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts
- **Purpose:** the win32 chain's contract at the provider level.
- **Key abstractions:** the `LocalSandboxProvider` win32 branch.
- **Data flow:** `confine` under each mode and assert the runner argv prefix, the temp root, the mode flag, the enforcement fact and the denial dialect.
- **Non-obvious design decisions:** the suite pins the exact argv shape the seam builds — `--workspace <dir> --temp <dir> --mode <mode>` — and that enforcement is reported as **`partial`**.
- **Edge cases / failure handling:** the read-only case asserts the same runner and contract with only the mode flag changed.
- **Surprising:** the win32 chain is a **sole candidate**, so it is selected without a probe — the enforcement fact is the static `partial` claim, not a probe result.

### packages/sandbox/sandbox-windows-acl/tests/workspace-sid.spec.ts
- **Purpose:** the capability-identity derivation's suite.
- **Key abstractions:** `workspaceWriteSid`, `tempWriteSid`.
- **Data flow:** derive SIDs for real paths and assert their shape and distinctness.
- **Non-obvious design decisions:** the suite pins the canonicalisation contract — "is byte-sensitive: the canonical path is the caller's contract (an alias spelling derives a second identity)" — so the caller, not the derivation, owns canonicalisation.
- **Edge cases / failure handling:** distinct paths must produce distinct identities; the temp variant is domain-separated.
- **Surprising:** the workspace SID is stable across processes and restarts, which is exactly what makes the ACE a reuse cache.

### packages/sandbox/sandbox-windows-acl/tests/path-boundary.spec.ts
- **Purpose:** the two boundary checks' suite.
- **Key abstractions:** `assertTempRootOutsideWorkspace`, `assertPrivateTempDisjoint`.
- **Data flow:** build real directories and assert the accept/reject decision.
- **Non-obvious design decisions:** the suite pins the asymmetry — "accepts a temp parent above the workspace because a fresh child is a sibling" — so the check is about *inheritance*, not about disjointness.
- **Edge cases / failure handling:** a temp root equal to or below the workspace is refused; the private directory must be disjoint in either direction.
- **Surprising:** the two checks answer different questions about different objects and are tested separately.

### packages/sandbox/sandbox-windows-acl/tests/ffi.spec.ts
- **Purpose:** the pointer and SID-comparison helpers' suite.
- **Key abstractions:** `getTempPath`, `isInvalidHandle`, `decodePtrAt`, `sameSidAt`.
- **Data flow:** call the helpers with crafted buffers.
- **Non-obvious design decisions:** `sameSidAt` is a *bounded* field-by-field comparison — the suite proves it "accepts identical SIDs at nonzero offsets over differing leading bytes", i.e. it never reads outside the SID's own bytes.
- **Edge cases / failure handling:** a revision mismatch short-circuits before anything else; a sub-authority-count mismatch and an implausible count (>15) are rejected; a differing identifier-authority byte is rejected.
- **Surprising:** the helper exists because "reading one yields garbage addresses and crashed EqualSid, verified by gdb" — a crash the test suite now prevents.

### packages/sandbox/sandbox-windows-acl/tests/acl-skill.spec.ts
- **Purpose:** the bundled skill's registration suite.
- **Key abstractions:** the skill registry, the resource copy.
- **Data flow:** register the skill and dispose it.
- **Non-obvious design decisions:** disposal must remove **both** the provider and its extracted resource copy.
- **Edge cases / failure handling:** n/a.
- **Surprising:** the resource copy's deletion is part of the disposal contract, not a background cleanup.

### packages/sandbox/sandbox-windows-acl/tests/skill-composition.spec.ts
- **Purpose:** the real-composition test: the Windows-only provider registers the skill through the shipped `sandbox-local` injection.
- **Key abstractions:** the real Cordis `Loader` and `Include` plugins, a stubbed `loader.internal.import`.
- **Data flow:** load the fixture `cordis.yml` (which mounts `sandbox-local` and `dsh-skill`), assert the skill is listed and its body is the packaged one, dispose the sandbox fiber, and assert the skill and the resource directory are gone.
- **Non-obvious design decisions:** the test is `it.skipIf(process.platform !== 'win32')` because "sandbox-local's POSIX suites are excluded on Windows; this owner runs in Windows coverage". The loader's `register`/`load` operations throw, "This composition does not use Node HMR operations".
- **Edge cases / failure handling:** the second half of the test mounts `sandbox-local` with a `runnerCommand` override and asserts the skill is **not** registered — "An operator-supplied `runnerCommand` does not register it".
- **Surprising:** the test compares the extracted script byte-for-byte with the packaged asset, so the extraction path cannot silently rewrite the file.

### packages/sandbox/sandbox-windows-acl/tests/fixtures/skill-composition/cordis.yml
A four-line Cordis composition fixture: mount `@deepseek-ai/dsh-sandbox-local` (id `sandbox`) and `@deepseek-ai/dsh-skill` (id `skills`). Data, not mechanism.

### packages/sandbox/sandbox-windows-acl/tests/diagnose-script.spec.ts
- **Purpose:** the PowerShell diagnosis script's behavioural suite, run for real on Windows.
- **Key abstractions:** real directories with real DACLs; the script's `-Path`/`-AllowRoot`/`-Out`/`-Restore` contract; the `REPORT`/`RECAP` protocol.
- **Data flow:** set up an ACL condition, run the script, assert the report records and the filesystem state.
- **Non-obvious design decisions:** the suite pins "preserves deny ACEs, capability SIDs and the well-known package groups", "refuses an inherited source outside -AllowRoot before touching an in-root explicit entry", and "preserves a deny that shares the removed package allow SID" — a removal must not take a collateral deny with it.
- **Edge cases / failure handling:** covered include a healthy directory (no change), a missing `WRITE_DAC` grant, a package ACE and a missing grant repaired in the same invocation, a deny ACE blocking `WRITE_OWNER` (stop and restore), a later path failing after earlier successes (restored in reverse order), a rollback that cannot be verified (`restore_pending_then_stop`), an object outside `-AllowRoot` (refused, exit 2), an unreadable ACL (a *partial* observation, not an invented permission), and idempotence.
- **Surprising:** "trust `verification` records, never `completed` actions" is enforced by the suite, and the script's own report distinguishes "Action completion records API execution; verification records the observed result."

### packages/sandbox/sandbox-windows-acl/package.json
npm manifest for `@deepseek-ai/dsh-sandbox-windows-acl` — ESM with a **second export** (`"./runner"`) so the seam can spawn the built runner entry; runtime deps `koffi@3.1.1`, `yaml@^2.4.2`, `dsh-lazy-require` and `dsh-win32-process`; `files` ships `assets/` so the diagnosis skill travels with the package. No mechanism.

### packages/sandbox/sandbox-windows-acl/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `subprocess/win32-process`, `subprocess/subprocess`, `util/lazy-require` and `skill/skill`. Build wiring only.

### packages/sandbox/sandbox-windows-acl/tsdown.config.ts
A two-entry tsdown build (`index` and `runner`), ESM, node platform, `es2024` target, `dts: false`, `clean: false` — the runner is "path-loaded by dsh-sandbox-local's win32 chain" and inlines the sandbox primitives "while koffi stays an external native require". Build wiring only.

### packages/sandbox/sandbox-windows-acl/README.md
Package reference for the Windows backend: the direct `AclSandbox` API example, the confinement guarantees, the failure-and-recovery contract, the bundled diagnosis skill, the mechanism (the two-pass access check, the `FILE_DELETE_CHILD` deny, the Low label, the deterministic workspace SID), the two mode-specific restricting lists, the runner contract, and a long, honest "verified boundaries" list (hard links, console isolation, standing ACEs, the Low label outliving DSH, `WRITE_OWNER` requirements, piped-stdio capture being impossible for grandchildren, eager full-tree grant propagation, and AppContainer-ACL'd trees becoming unreadable).

### packages/sandbox/sandbox-windows-acl/README.zh.md
Chinese translation of `packages/sandbox/sandbox-windows-acl/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/sandbox/sandbox-windows-acl/README.i18n.yaml
Per-heading bilingual hash record for `packages/sandbox/sandbox-windows-acl/README.md`. No mechanism.

### packages/storage/README.md
Package-group map for `packages/storage`: the four packages and their roles, and the statement that the group is "optional and host-side: they do not expose tools, prompt content, or session events to the model". Its Dev Note records that the design Agent Note is still marked *proposed* while the family ships.

### packages/storage/README.zh.md
Chinese translation of `packages/storage/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/storage/README.i18n.yaml
Per-heading bilingual hash record for `packages/storage/README.md`. No mechanism.

### packages/storage/storage/src/backend.ts
- **Purpose:** the normative backend contract — the vocabulary every storage backend implements and the shared conformance suite checks.
- **Key abstractions:** `StorageBackend` (one medium, optional facets), `KvFacet`, `KvUnit`, `KvUnitDescriptor` (name, version, tables, `hasGlobal`, `layout`, `compatibleVersions`), `UNIT_NAME_RE`.
- **Data flow:** `kv.open(descriptor)` → a unit → `loadAll()` / `putRecord` / `deleteRecord` / `backupRecord?` / `setGlobal` → `close()`. Values are opaque JSON to this layer: "no schema, no events, no domain meaning".
- **Non-obvious design decisions:** the unit "does NOT serialize concurrent writes — write ordering is the caller's responsibility (the domain layer runs one write chain per unit)"; the unit only guarantees that "each single call is atomic on the medium and durable once resolved". The `layout` field exists so "a unit whose records are large or sparse never rewrites the rest on one write", and `compatibleVersions` scopes the version check *per record* in that layout — "an unaccepted version stamp discards only that record instead of rejecting the whole unit".
- **Edge cases / failure handling:** a stored version differing from the descriptor rejects with `version-mismatch`; an unparsable medium rejects with `malformed-medium`; a double open "is a caller bug and rejects"; any call after `close` rejects with `closed`.
- **Surprising:** `backupRecord` is an **optional** member — "Backends whose medium has no per-record document to move (the `single` layout, a row store) omit this member, and the caller falls back to its reject-loud path."

### packages/storage/storage/src/index.ts
- **Purpose:** the `ctx.storage` hub — a named backend registry plus mountable data-form facilities. "The hub itself performs no IO."
- **Key abstractions:** `Storage` (service), `StorageForms` (declaration-merged form map), `storageBackendServiceKey(name)`, `BackendRegistry`, `StorageError`.
- **Data flow:** a backend plugin registers under a name and publishes a lifecycle-only service key `storage.backend.<name>`; a form provider injects those keys and mounts its facility on the hub; consumers resolve `ctx.storage.backend.get(name)` or `ctx.storage.<form>`.
- **Non-obvious design decisions:** the lifecycle-only service key exists so "activation cannot race backend registration even though callers continue resolving backends through the storage registry". Mounting is an **effect** with a disposer, and the disposer removes only its own contribution. The package's default export is the service class **only** — "mixing a default export with a function-plugin `apply` makes the Loader drop the plugin namespace".
- **Edge cases / failure handling:** a duplicate backend or form throws `duplicate-backend`/`duplicate-mount`; reading a form before its owner mounts throws `form-not-mounted`; a stale disposer firing after a re-register is ignored.
- **Surprising:** the hub is deliberately dumb — "backends own media, data forms own semantics" — so a new medium or a new data form never touches the hub.

### packages/storage/storage/src/registry.ts
- **Purpose:** the named backend table.
- **Key abstractions:** `BackendRegistry` with `register` / `get` / `names`.
- **Data flow:** `register(name, backend)` returns a disposer; `get(name)` resolves or throws.
- **Non-obvious design decisions:** "Disposal does NOT close the backend — the owning plugin closes it after unregistering." The disposer only removes *its own* registration: "after dispose + re-register, a stale disposer firing again must not remove the successor."
- **Edge cases / failure handling:** a duplicate name throws `duplicate-backend`; an unknown name throws `backend-not-found` and **lists the registered names** in the message.
- **Surprising:** the error message enumerates the registered backends, which turns a composition mistake into a one-line fix.

### packages/storage/storage/src/error.ts
- **Purpose:** the shared error vocabulary for the hub and every backend.
- **Key abstractions:** `StorageErrorCode` (`backend-not-found`, `form-not-mounted`, `duplicate-backend`, `duplicate-mount`, `version-mismatch`, `malformed-medium`, `closed`), `StorageError`.
- **Data flow:** none — a leaf vocabulary module.
- **Non-obvious design decisions:** the `code` is "the stable contract consumers may switch on; `message` is diagnostic prose."
- **Edge cases / failure handling:** standard `ErrorOptions` (`cause`) is chained.
- **Surprising:** the code set is deliberately small and contains no "not found" for a *record* — a missing record is a domain-level `missing-key`, not a storage error.

### packages/storage/storage/tests/contract.ts
- **Purpose:** the shared KV-backend conformance suite, run against each backend.
- **Key abstractions:** `KvBackendContractHarness` (a fresh backend plus a `reopen()` that simulates a process restart over the same medium), a fixed `DESCRIPTOR` (name `contract_unit`, version 3, tables `alpha`/`beta`, global).
- **Data flow:** `runKvBackendContract(label, create)` registers five `it` cases that every backend must satisfy.
- **Non-obvious design decisions:** the suite asserts the *contract text*, not an implementation: "the suite asserts every clause of the `src/backend.ts` contract so both backends are held to identical semantics." The record key `weird key / with:stuff` is deliberate — keys are arbitrary strings that never reach file paths.
- **Edge cases / failure handling:** covered include opening a missing unit as empty, durability across a reopen, overwrite + idempotent delete, `version-mismatch` on reopen **without touching the data**, and `closed` after close with an idempotent close.
- **Surprising:** the "version mismatch" case re-opens with the *original* descriptor afterwards and asserts the data is still there — a rejected open must not destroy the medium.

### packages/storage/storage/tests/registry.spec.ts
- **Purpose:** the registry and hub's suite: register/resolve/dispose, duplicate rejection, the service-key derivation, form mounting, and the stale-disposer guard.
- **Key abstractions:** a real `Context`; a fake backend object.
- **Data flow:** register a backend, resolve it, dispose, re-register.
- **Non-obvious design decisions:** "ignores a stale disposer after dispose and re-mount / re-register" is pinned explicitly.
- **Edge cases / failure handling:** a duplicate name throws.
- **Surprising:** the hub is a plain class with no I/O, so its whole test suite is about disposal discipline.

### packages/storage/storage/package.json
npm manifest for `@deepseek-ai/dsh-storage` — ESM, **no runtime dependencies at all** (only `schemastery` is absent too; the package depends on nothing but `cordis` as a peer), and `"./locale/*.json"` exported for the plugin catalog. No mechanism.

### packages/storage/storage/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to the vendored `cosmokit` and `cordis` only — the hub is deliberately dependency-free. Build wiring only.

### packages/storage/storage/README.md
Package reference for the hub: the minimal composition, the four `StorageError` codes, the "backends own media, data forms own semantics" concept, the backend contract's summary, the source map, and the limitations (`kv` is the only data shape; forms resolve lazily).

### packages/storage/storage/README.zh.md
Chinese translation of `packages/storage/storage/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/storage/storage/README.i18n.yaml
Per-heading bilingual hash record for `packages/storage/storage/README.md`. No mechanism.

### packages/storage/storage/locale/en.json
Two-line locale stub: `{"meta":{"title":"storage"}}`. No mechanism.

### packages/storage/storage/locale/zh.json
Chinese locale stub: title `数据存储服务` with a one-line description of unified backend management. No mechanism.

### packages/storage/storage-domain/src/spec.ts
- **Purpose:** the domain declaration vocabulary — the single source of a domain's identity, layout and record schemas.
- **Key abstractions:** `DomainSpec`, `DomainGlobalSpec`, `DomainTableSpec`, `defineDomain`, `domainTable`, `descriptorOf`, `TableKeyOf`/`TableValueOf`/`GlobalValueOf`.
- **Data flow:** the owning package calls `defineDomain(spec)` once at module load; `descriptorOf(spec)` projects the spec onto the backend-facing `KvUnitDescriptor`.
- **Non-obvious design decisions:** record schemas are **zod** while plugin `Config` stays schemastery — "z.infer keeps types un-duplicated and the same schemas later project to RPC wire schemas". `defineDomain` validates at module load "before any medium is touched", so a misconfiguration fails loud at import time.
- **Edge cases / failure handling:** a name outside `UNIT_NAME_RE`, a negative/non-integer version, a `compatibleVersions` entry that is not below the current version, an unknown `layout` or `invalidRecords` value, and a **global schema that accepts `null`** all throw.
- **Surprising:** the `null`-accepting global schema is rejected because "`null` is the medium's 'never written' sentinel, so a stored null could not round-trip" — a nullable global would silently revert to `initial` on reopen.

### packages/storage/storage-domain/src/domain.ts
- **Purpose:** the open-domain runtime — authoritative in-memory state, one write chain per domain, and change-event emission.
- **Key abstractions:** `Domain`/`DomainGlobal`/`KvTable`, `DomainImpl`, `KvTableImpl`, the `TableHost` internal boundary, the `chain` tail promise.
- **Data flow:** every write **queues on the chain**: await the backend's durability → mutate memory → emit `domain/changed`. Reads are synchronous from memory. `close()` sets `disposing` (new writes reject), drains the chain, closes the unit, then frees the name.
- **Non-obvious design decisions:** "a rejected backend write leaves memory untouched (no divergence between reads and the medium), and events carry values that equal the in-memory state at emission, in write order." `update`'s transform runs **at its queue slot**, so concurrent updates never interleave — "the domain layer runs one write chain per unit". `domain/changed` is "a notification, not a transaction participant": a throwing listener is contained with a logged warning rather than rejecting the already-durable write.
- **Edge cases / failure handling:** `delete` decides existence at its chain slot, not at call time; `update` on a missing key throws `missing-key`; reads are valid while draining but reject once closed; `close()` is idempotent via a memoised `disposal` promise.
- **Surprising:** the chain links are settled with `then(noop, noop)` so a rejected write never poisons the chain for the writes behind it.

### packages/storage/storage-domain/src/index.ts
- **Purpose:** the domain data form — the `DomainFacility` that opens declared domains over routed backends, plus the plugin entry.
- **Key abstractions:** `DomainFacility` (`open`, `get`, `closeAll`), `Config` (`backend` required, `routes` per domain), the `domain` form key, the `storageDomain` service.
- **Data flow:** `open(spec)` → reject an already-reserved name → resolve the route → require the `kv` facet → open the unit → `loadAll()` → validate every record against its zod schema → construct the domain. `apply()` injects the configured backend service keys, then mounts the form.
- **Non-obvious design decisions:** which backend serves which domain is the **domain form's** configuration, "never the hub". The `reserved` set is separate from the `domains` map so "concurrent opens of one name fail loud" rather than racing. A stored `null` global means "never written" and serves `initial` without materialising it. Backend failures (`version-mismatch`, `malformed-medium`) **pass through** unrewrapped.
- **Edge cases / failure handling:** `already-open`, `facet-unsupported`, `invalid-record` (naming table and key), `missing-key`, `closed`; a failed open closes the unit and releases the name reservation unconditionally.
- **Surprising:** `invalidRecords: 'backup-and-skip'` is a **spec-level** policy for disposable derived data: the failing document is moved aside, the failure is logged with its cause, and the open continues — but only when the backend can move documents; otherwise the loud path is kept.

### packages/storage/storage-domain/src/events.ts
- **Purpose:** the `domain/changed` event vocabulary.
- **Key abstractions:** `DomainChanged` = `DomainChangedPut` | `DomainChangedDeleted`; `DomainChangedBase` (domain, table, key — `''` for the global slot).
- **Data flow:** one event per durable write, emitted strictly after the backend acknowledged durability, in the domain's write-chain order.
- **Non-obvious design decisions:** the event carries the **new** snapshot and "never the old value (a diffing consumer keeps its own previous snapshot)". The event is declared with `@mode emit` (fire-and-forget, not a waterfall).
- **Edge cases / failure handling:** a delete is a tombstone with no value.
- **Surprising:** the module is the declared "event source for cross-process change push (RPC frames) in a later phase" — the shape is already designed for a transport it does not have yet.

### packages/storage/storage-domain/src/error.ts
- **Purpose:** the domain layer's error vocabulary.
- **Key abstractions:** `DomainErrorCode` (`already-open`, `facet-unsupported`, `invalid-record`, `missing-key`, `closed`), `InvalidRecordDetail` (table + key), `DomainError`.
- **Data flow:** none — a leaf vocabulary module.
- **Non-obvious design decisions:** the `detail` field is "Present exactly when `code` is `invalid-record`", so a machine can locate the bad record without parsing the message.
- **Edge cases / failure handling:** backend failures are **not** rewrapped — "the domain layer does not rewrap them."
- **Surprising:** the error carries a *location* (table + key) as structured data, which is what makes a bad record in a thousand-record file diagnosable.

### packages/storage/storage-domain/tests/domain.spec.ts
- **Purpose:** the domain layer's suite: spec validation, the open sequence, table/snapshot reads, the write chain, durability failure, the global singleton, close/lifecycle, and change events.
- **Key abstractions:** the in-memory backend double (`memory-backend.ts`); a spec factory.
- **Data flow:** open a domain over the memory backend, exercise every handle, and assert the events and the durability behaviour.
- **Non-obvious design decisions:** the suite pins "serializes concurrent updates on one key without losing increments" — the write chain is the mechanism. It also pins the two halves of the commit rule: "leaves memory untouched and emits nothing when the backend rejects a write" and "keeps serving initial when the first global set fails durability".
- **Edge cases / failure handling:** covered include a second open of the same name, an unregistered route target, a backend without the `kv` facet, a record the backend omitted from `loadAll` (treated as empty), a stored record failing its schema (naming table and key), `backup-and-skip` falling back to the rejecting default when the backend cannot move documents, a stored global failing its schema, and a passing-through backend `version-mismatch`.
- **Surprising:** "contains a throwing domain/changed listener without rejecting the committed write" — the event is explicitly not a transaction participant.

### packages/storage/storage-domain/tests/helpers/memory-backend.ts
- **Purpose:** the in-memory `StorageBackend` test double shared by the domain suite and the workspace package's tests.
- **Key abstractions:** `MemoryMediaPool` (shared `media`, `versions`, `failNextWrites`), `MemoryStorageBackend`, `MemoryKvUnit`, `MemoryMedium`.
- **Data flow:** the pool is handed to several backend instances to simulate reopening the same medium after a restart; `failNextWrites` injects a write failure.
- **Non-obvious design decisions:** the double's fidelity to the real contract is documented clause by clause — version stamping and `version-mismatch` on reopen, `closed` after close, delete idempotence. The file lives under `tests/`, "never `src/`, so it stays out of the published surface".
- **Edge cases / failure handling:** a double-open is a plain `Error` (no dedicated `StorageError` code exists for it), and `versions` can be pre-stamped to force a mismatch without a prior open.
- **Surprising:** `failNextWrites` decrements per rejection, so a test can make exactly one write fail and assert the domain's memory is untouched.

### packages/storage/storage-domain/package.json
npm manifest for `@deepseek-ai/dsh-storage-domain` — ESM, runtime deps `schemastery` and `zod@4.4.3`; peer deps on `dsh-storage` and `cordis` only. No mechanism.

### packages/storage/storage-domain/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`/`schemastery` and the sibling `storage` project. Build wiring only.

### packages/storage/storage-domain/README.md
Package reference for the domain form: declaring a domain, opening and using one, routing domains to backends, the stable error codes, the "memory is authoritative; the medium is the durable projection" concept, the open sequence, and the limitations (single-process change visibility, no cross-table transactions or secondary indexes, and **no data migration** — a version change requires migrating the stored data by hand).

### packages/storage/storage-domain/README.zh.md
Chinese translation of `packages/storage/storage-domain/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/storage/storage-domain/README.i18n.yaml
Per-heading bilingual hash record for `packages/storage/storage-domain/README.md`. No mechanism.

### packages/storage/storage-domain/locale/en.json
Two-line locale stub: `{"meta":{"title":"storage-domain"}}`. No mechanism.

### packages/storage/storage-domain/locale/zh.json
Chinese locale stub: title `结构化数据存储` with a one-line description of schema-validated KV data with change notification. No mechanism.

### packages/storage/storage-json/src/index.ts
- **Purpose:** the JSON storage backend — one human-readable document per unit under a configured root, in either the `single` or `per-record` layout.
- **Key abstractions:** `JsonStorageBackend` (the `kv` facet), `Config.root` (required, no `process.cwd()` fallback), the `open`/`opening` maps.
- **Data flow:** `kv.open(descriptor)` → validate the descriptor names → reserve the name → `mkdir(root, {mode: 0o700})` → dispatch to the layout opener → register the unit.
- **Non-obvious design decisions:** `root` has **no default** "because a `process.cwd()` fallback would scatter unit files wherever the process happens to start; assemblies state the location explicitly". The `opening` map is reserved **synchronously** at `open()` entry so a concurrent open of the same unit fails, and `close()` can await opens still in flight. A unit opened while the backend is closing is closed again rather than handed out.
- **Edge cases / failure handling:** a double open is a plain `Error` ("a unit has exactly one live handle"); an invalid unit or table name is `malformed-medium`; `close()` awaits every in-flight open and then every unit.
- **Surprising:** the backend distinguishes the two layouts only in the *opener* — "the two layouts differ in medium shape only" — so the rest of the backend is layout-agnostic.

### packages/storage/storage-json/src/single-unit.ts
- **Purpose:** the `single`-layout unit — the whole unit is one `<root>/<name>.json` document, and memory is authoritative.
- **Key abstractions:** `SingleJsonUnit`, the `inFlight` publish tracker, the `UnitState` projection.
- **Data flow:** open → read the file (a missing file = an empty unit, materialisation deferred) → parse → hold the state in memory. Each write mutates memory, then `publish()` serialises the whole state and replaces the file atomically.
- **Non-obvious design decisions:** a failed publish **rolls back** the in-memory change, "because memory is authoritative, so a rejected write must not survive in memory (or ride along with the next publish)". Writes are not queued here — ordering is the domain layer's job.
- **Edge cases / failure handling:** the in-flight set lets `close()` drain the publishes; an undeclared table or a `setGlobal` on a unit without a global are caller errors.
- **Surprising:** every write rewrites the **whole** unit file — the README names this as the backend's central cost, and the mitigation is routing the domain to SQLite instead of changing the package.

### packages/storage/storage-json/src/per-record-unit.ts
- **Purpose:** the `per-record`-layout unit — one version-stamped document per record; the directory tree is the state.
- **Key abstractions:** `PerRecordJsonUnit`, `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`, `loadPerRecordState`, `bootstrapLegacyUnit`, `backupRecord`, `backupStamp`.
- **Data flow:** `loadAll` re-reads `<root>/<unit>/<table>/<key>.json` plus `global.json`; `putRecord` writes one document atomically; `deleteRecord` removes one; `backupRecord` renames a document to `<key>.json.bak.<YYYYMMDDHHmm>`.
- **Non-obvious design decisions:** the unit holds **no in-memory state** — "this unit holds NO in-memory state of its own ... this unit never mutates memory and needs no rollback — a failed write simply leaves both the file and the domain's memory unchanged". A malformed or stale document reads as **absent**, "so one bad or stale file never bricks the whole unit". The legacy bootstrap copies a whole-unit file into per-record documents only when the stored version is in the accepted set, and "any new document path ... suppresses the bootstrap for the whole unit".
- **Edge cases / failure handling:** an unsafe key is rejected before any file operation; a missing directory is the empty unit; an unreadable document reads as absent; a backup file no longer ends in `.json`, so every later read ignores it.
- **Surprising:** the legacy bootstrap exists at all — it is a one-time upgrade path from the pre-per-record layout, and it deliberately **leaves the legacy file unchanged**.

### packages/storage/storage-json/src/format.ts
- **Purpose:** the on-disk JSON format — the whole-unit document, the per-record document, and their parsing/validation.
- **Key abstractions:** `UnitState`, `serialize`, `parse`, `serializeRecord`, `parseRecord`.
- **Data flow:** `parse(text, descriptor)` validates the header (name + version) and the tables map, then returns the in-memory state; `serialize` writes the whole document pretty-printed with a trailing newline.
- **Non-obvious design decisions:** the file is "always the current net state, kept human-readable (pretty-printed, stable key order from insertion) — that legibility is this backend's reason to exist". The `parse` path rejects an **array** in the `tables` field: "reading one as a table map reports every declared table as absent, and the next publish replaces the file with that empty view, discarding records this reader could not see."
- **Edge cases / failure handling:** a version mismatch rejects with `version-mismatch`; a malformed document rejects with `malformed-medium`; a per-record document with an unaccepted stamp is **foreign** and reads as absent.
- **Surprising:** the two layouts have deliberately *opposite* version semantics — the whole-unit format **rejects** a foreign version, the per-record format **discards** it — because "there is exactly one document" versus "one bad or stale record file must not brick the whole unit".

### packages/storage/storage-json/src/atomic.ts
- **Purpose:** atomic whole-file replacement for the JSON backend.
- **Key abstractions:** `writeAtomic(path, data)`, `fsyncDirectory(path)`.
- **Data flow:** write a same-directory temp file with `'wx'` at mode `0600` → write → `handle.sync()` → `rename()` over the target → fsync the parent directory (POSIX only).
- **Non-obvious design decisions:** rename is an atomic replace on POSIX and on Windows (libuv maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`), and "replacement is the intended semantic here — unlike the session-log backend's link()+unlink() no-clobber protocol, a unit file has exactly one writer per process and last-write-wins is correct".
- **Edge cases / failure handling:** a failure removes the temp file before rethrowing; the directory fsync is skipped on Windows because "Windows rejects O_RDONLY directory opens".
- **Surprising:** the comment names the *other* backend's different protocol explicitly — the two durability strategies are contrasted in the source.

### packages/storage/storage-json/tests/json-backend.spec.ts
- **Purpose:** the JSON backend's suite — the whole-unit layout's specifics, then the `per-record` layout's specifics.
- **Key abstractions:** real temp roots; the shared conformance suite is *not* used here (this file tests the layout-specific clauses).
- **Data flow:** open units, write, read back, reopen, and inspect the files on disk.
- **Non-obvious design decisions:** the suite pins "rolls back memory when a publish fails", "rejects a whole-unit document whose `tables` is an array", and "reads per-record documents stamped with a declared compat version and stamps writes current".
- **Edge cases / failure handling:** covered include a malformed medium, a foreign unit header, a double open, a malformed table shape, an unreadable record document (reads as absent), an unsafe key, a legacy bootstrap with an accepted and with a rejected version, and "ignores the legacy whole-unit file when any new document path exists".
- **Surprising:** "backupRecord moves the document aside; reads see it absent and a write recreates it" — the backup is a *rename*, not a copy, so the bytes are moved rather than duplicated.

### packages/storage/storage-json/package.json
npm manifest for `@deepseek-ai/dsh-storage-json` — ESM, runtime dep `schemastery` only; peer deps on `dsh-storage` and `cordis`; `"./locale/*.json"` exported. No mechanism.

### packages/storage/storage-json/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`/`schemastery` and the sibling `storage` project. Build wiring only.

### packages/storage/storage-json/README.md
Package reference for the JSON backend: the two layouts and when to choose each, the config table, the observable behaviour (malformed vs stale documents, path-safe keys, the legacy bootstrap's precise conditions), the "memory is authoritative" vs "the directory is authoritative" split, the file formats, and the limitations (whole-unit rewrite cost, no cross-process write locking, Windows rename without explicit write-through).

### packages/storage/storage-json/README.zh.md
Chinese translation of `packages/storage/storage-json/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/storage/storage-json/README.i18n.yaml
Per-heading bilingual hash record for `packages/storage/storage-json/README.md`. No mechanism.

### packages/storage/storage-json/locale/en.json
Two-line locale stub: `{"meta":{"title":"storage-json"}}`. No mechanism.

### packages/storage/storage-json/locale/zh.json
Chinese locale stub: title `JSON 文件存储` with a one-line description of saving KV data as local JSON files. No mechanism.

### packages/storage/storage-sqlite/src/index.ts
- **Purpose:** the SQLite storage backend — every routed unit in one database file, one row per record.
- **Key abstractions:** `SqliteStorageBackend`, `Config.path` (or `:memory:`), `Config.journalMode`, the `units` table (name + version), the `u_<unit>_<table>` record tables.
- **Data flow:** `kv.open(descriptor)` → validate the names → reserve the name → `SELECT version FROM units` → insert or reject on a mismatch → `CREATE TABLE IF NOT EXISTS` per declared table (STRICT) → hand back a `SqliteKvUnit`.
- **Non-obvious design decisions:** the name is reserved **synchronously** so a concurrent second open rejects "instead of racing past the guard during the awaits below". Both name segments are validated against `UNIT_NAME_RE` before they reach DDL, "so no external input is ever interpolated into SQL identifiers". The disposer **unregisters first, then closes** the medium.
- **Edge cases / failure handling:** a version mismatch rejects with `version-mismatch`; a failed materialisation releases the reserved name; `close()` drains a still-pending failed open.
- **Surprising:** the backend's `ready` promise has a `.catch(() => {})` attached "so an unhandled-rejection crash" cannot happen when the open fails before the first use — the failure still surfaces to each caller that re-awaits it.

### packages/storage/storage-sqlite/src/unit.ts
- **Purpose:** one opened SQLite unit — prepared per-table statements over the `u_<unit>_<table>` tables plus the unit's row in `unit_globals`.
- **Key abstractions:** `TableStatements` (`upsert`/`remove`/`selectAll`), `SqliteKvUnit`.
- **Data flow:** each primitive is **one** prepared statement — `INSERT ... ON CONFLICT(key) DO UPDATE` for an upsert, `DELETE ... WHERE key = ?`, `SELECT key, value` — with the value stored as JSON text.
- **Non-obvious design decisions:** "Each primitive is a single statement, so atomicity comes from SQLite itself — no explicit transactions, and no write queue". `loadAll` builds the record maps with `Object.create(null)`: "record keys are arbitrary strings, so `'__proto__'` must land as an own property instead of mutating the prototype."
- **Edge cases / failure handling:** `settle` maps a synchronous throw into a rejection "so the Promise-returning contract never throws synchronously", and wraps a non-`Error` `toJSON` throw into an `Error`. Bad JSON in a stored column becomes `malformed-medium` naming the slot.
- **Surprising:** the `settle` wrapper exists purely so the Promise-returning contract holds — a `JSON.stringify` of a value whose `toJSON` throws would otherwise escape synchronously.

### packages/storage/storage-sqlite/src/schema.ts
- **Purpose:** the SQLite open sequence, the physical layout version, and the unit metadata tables.
- **Key abstractions:** `STORAGE_SQLITE_SCHEMA_VERSION = 1`, `JournalMode`, `openDatabase`, `configureDatabase`, `createDatabaseFile`, `recordTableName`.
- **Data flow:** resolve the path → `mkdir(dirname, {mode: 0o700})` → exclusively create a missing file at `0o600` → `new DatabaseSync` → `PRAGMA foreign_keys = ON` → the journal pragma → read `PRAGMA user_version` → create `units` and `unit_globals` → stamp a fresh database.
- **Non-obvious design decisions:** the `user_version` stamp is applied **LAST** — "the stamp asserts the layout is complete, so a failure above must leave the medium unstamped (a re-open after the obstruction is cleared retries materialization from scratch)". `memory`/`off` journal modes are excluded from the union: "dropping journal durability silently contradicts the durability clause of the KV backend contract."
- **Edge cases / failure handling:** a non-zero `user_version` other than the current one rejects outright (no migration); an existing database keeps its modes; errors other than `EEXIST` propagate.
- **Surprising:** the open sequence is **deliberately duplicated** from the session-query-sqlite package, with the reason in the source: "each package owns a distinct database identity and schema, so a shared helper would couple otherwise independent storage providers".

### packages/storage/storage-sqlite/tests/sqlite-backend.spec.ts
- **Purpose:** the SQLite backend's suite.
- **Key abstractions:** `:memory:` databases; real files for the mode tests.
- **Data flow:** open units, write, read back, reopen, and assert the medium's state.
- **Non-obvious design decisions:** the suite pins "round-trips prototype-polluting keys as own properties" — the `'__proto__'` key survives as data — and "leaves a failed materialization unstamped so a repaired medium reopens".
- **Edge cases / failure handling:** covered include a mismatched database schema version, invalid unit/table names **before touching the medium**, a second open of the same name, re-open after close, an unparsable stored JSON (`malformed-medium`), a non-`Error` `toJSON` throw, a `setGlobal` on a unit without a global, writes to undeclared tables, a pending failed open during close, filesystem errors other than an existing file, an invalid database filename, and an unparsable global slot.
- **Surprising:** "preserves the mode of an existing database file" — the backend creates owner-only but never *chmods* an existing database.

### packages/storage/storage-sqlite/package.json
npm manifest for `@deepseek-ai/dsh-storage-sqlite` — ESM, runtime dep `schemastery` only; peer deps on `dsh-storage` and `cordis`. No mechanism.

### packages/storage/storage-sqlite/tsconfig.json
Project-reference tsconfig with `rootDir: src`, `outDir: lib/types`, and references to `cosmokit`/`cordis`/`schemastery` and the sibling `storage` project. Build wiring only.

### packages/storage/storage-sqlite/README.md
Package reference for the SQLite backend: when to choose it over the JSON one, the config table, the observable behaviour (owner-only creation, version rejection, no migration), the "document per row" concept, the open sequence, and the limitations (the synchronous driver blocks the event loop, no busy-wait or retry policy, only the current physical layout opens, and the open sequence is duplicated with the query provider).

### packages/storage/storage-sqlite/README.zh.md
Chinese translation of `packages/storage/storage-sqlite/README.md` (same section tree, same line count). Frontmatter and overview read; the English file is authoritative.

### packages/storage/storage-sqlite/README.i18n.yaml
Per-heading bilingual hash record for `packages/storage/storage-sqlite/README.md`. No mechanism.

---

## Ideas worth stealing

- **Policy as a single-slot waterfall event, not a service the tools inject** - `packages/fs/fs/src/index.ts:59` - The `fs/write-intent` and `fs/edit-intent` events are declared as Cordis **waterfalls** with a documented rule: "Calling `next()` yields the bare provider's unconditional write; the first listener that returns an intent owns the decision rather than composing with peers." The tool then does `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` and the *policy* plugin — a package the tool does not depend on — decides. August's harness can use the same shape for its own read-before-write or approval gates: the executor asks a slot, a plugin answers, and removing the plugin degrades to the unguarded behaviour instead of breaking the executor. The companion rule is that the policy plugin "performs no filesystem I/O of its own" — it only converts recorded state into the provider's optional guard.

- **Derive a capability identity from a canonical path so the expensive permission grant is paid once** - `packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts:35` - `workspaceWriteSid` hashes the **canonical** workspace path into an `S-1-4-x-y` SID, so every session, call and restart of the same workspace presents the same identity and the workspace-root ACE materialises once per machine. August's Windows path has the same shape of problem (a per-session grant forces a full tree re-propagation per session); a deterministic per-workspace identity turns that into an O(1) exact-ACE skip. The companion rule is that the input **must** be canonical — "an as-spelled fallback path would mint a second identity for the same directory".

- **Detect the already-standing grant and skip the eager re-propagation** - `packages/sandbox/sandbox-windows-acl/src/acl.ts:386` - Before applying, `grantWrite` reads the current DACL and label and checks whether the *exact* ACE, the *exact* deny and the *exact* mandatory label already stand; if so it frees the descriptor and returns without calling `SetNamedSecurityInfoW`, because that call would re-propagate the identical descriptor across the whole tree ("minutes on large workspaces"). The comparison is field-by-field through bounded offset reads, and a malformed header reads as "not exact" so the merge path still handles it. Any August step that stamps a permission set onto a tree should have this skip.

- **Fail the write closed with a typed code instead of letting the model read stderr** - `packages/fs/fs-sandbox/src/index.ts:127` - A denied mutation throws `new FsError(..., 'FS_SANDBOX_DENIED')` — a structured code — and the tool layer maps it to the shared marker `[sandbox: file access denied under <mode> mode]` plus a same-turn escalation hint (`packages/sandbox/sandbox/src/escalation.ts:71`). The README states the reason plainly: "A denial is a structured `FsError`, not stderr inference — an in-process fence knows exactly what it refused." August currently infers some denials from process output; a typed refusal with a stable code is machine-routable, and one shared marker vocabulary across every enforcing family is what stops the bash and filesystem denials from drifting.

- **One owner for the writable-root set, shared by every enforcement dialect** - `packages/sandbox/sandbox/src/roots.ts:52` - `writableRoots(policy)` is the single derivation of "what `workspace-write` may write under": the workspace root plus `/tmp` plus `os.tmpdir()`, canonicalised and deduplicated. The Seatbelt SBPL profile and the in-process filesystem fence both call it, precisely so the asymmetry "the write tool cannot write /tmp but bash can" cannot arise. August's harness has exactly this risk (a bash allow-list and a file-tool allow-list maintained separately); one function that both read is the cheapest possible fix.

- **Stage a write in a private owner-only directory and publish with a no-replace primitive** - `packages/fs/fs-local/src/fsio.ts:601` and `packages/fs/fs-local/src/fsio.ts:635` - The write stages into `.<name>.<pid>.<uuid>.tmpdir` (mode `0700`) with the temp file opened `'wx'` at `0o600`, fsynced, and then published. For a *guarded create* the publication is a **hard link** rather than a rename, so a concurrent creator's file is never clobbered and the loser gets `FS_NOT_OBSERVED` instead of silently overwriting. The staging-dir removal after a committed write is best-effort and cannot turn a committed write into a failure. This is the pattern August's `write_file` and edit gate want: a create that cannot clobber, and residue that is owner-only.

- **Bound the read window on the *current line* as well as on the total bytes** - `packages/fs/tool-fs/src/read-render.ts:118` - The window builder caps the per-line buffer at `maxLineLength + 1` characters, "one char past the truncation point is enough to prove a line overflows", so a single newline-free multi-gigabyte line cannot grow memory without bound even while the byte budget is not yet exhausted. The same file also enforces the *semantic* contract on replayed metadata (`packages/fs/tool-fs/src/read-render.ts:230`): offset must be 1-based, line numbers must strictly increase and never exceed `totalLines`, and a violation declines to the generic card rather than rendering a mis-numbered one. August's `read_file` needs the same two guards.

- **Prefix `--no-config` to an unconfined ripgrep spawn** - `packages/fs/tool-fs-search/src/search-core.ts:240` - The search tools spawn the packaged binary through the subprocess seam with a plain argv vector and **prepend** `--no-config`, because the spawn is unconfined: "a host `RIPGREP_CONFIG_PATH` (or `rg.conf` next to the binary) can otherwise inject `--pre` and make ripgrep execute an arbitrary preprocessor for every matched file." The same line shows the other half of the discipline — every model-controlled value is a plain argv element and the search root rides behind `--`, so no shell quoting is involved and a leading-dash path cannot be parsed as a flag. August's shell-based grep has the same exposure and the same fix.

- **Derive the result-time diff from the storage's own before/after, not from a persisted diff** - `packages/fs/tool-fs/src/diff.ts:35` and `packages/fs/tool-fs/src/write.ts:103` - The write/edit tools never compute a diff before writing. The provider returns the file's `before` and `after` text, and the *result* layer computes the hunks from that pair, so "the card can never disagree with what was written" — and a write whose prior side is binary, non-UTF-8 or over the byte bound simply yields `before: null` and falls back to a whole-file diff instead of a wrong contextual one. The same idea applies to any August transcript card that claims to show what a tool changed.

- **Emit the change event only after durability, and contain a throwing listener** - `packages/storage/storage-domain/src/domain.ts:194` and `packages/storage/storage-domain/src/domain.ts:251` - The domain's write chain is *durability first, then memory, then the event*: a rejected backend write leaves memory untouched, so "reads never diverge from the medium", and the event carries a value that equals the in-memory state at emission. A listener that throws is contained with a logged warning, because "the event is a notification, not a transaction participant — the commit point has passed". August's memory/skill layer has the same shape of risk: the ordering is the guarantee, and the notification must not be able to un-commit it.

- **Serialise the read→guard→write window with a per-target FIFO lock** - `packages/fs/fs-local/src/index.ts:104` - The local provider keeps a promise chain per `targetKey`, so two concurrent writes or edits to the same file are deterministically ordered: one wins and the rest see the new version and are rejected as stale. August's tool loop can hit the same race (a model firing two writes, or a subagent and a parent writing the same file); a per-target promise chain turns a race into a defined outcome.

- **Give a permission-elevation request a closed, strictly-wider ladder and a one-shot approval** - `packages/sandbox/sandbox/src/escalation.ts:28` and `packages/sandbox/sandbox/src/escalation.ts:171` - The escalation targets are a closed table (`read-only` → `workspace-write` | `danger-full-access`; `workspace-write` → `danger-full-access`), the check is at **execution** against the call's effective mode rather than in the schema, repeating the effective mode needs no approval at all, and the grant applies to exactly one call. The four outcomes map to four distinct verbatim texts, and the audit reason embeds the target mode so the grant's identity is reconstructible. August's approval path is a natural host for this shape.

- **Cap the persisted `meta` separately from the model-facing content, and never drop the last item** - `packages/fs/tool-fs-search/src/presentation.ts:107` - A search's structured projection is bounded by its own byte cap, because "a deployment's final output budget only shrinks a result's `content`, never its `meta`". Trailing groups are dropped until the payload fits, but "a single item too large to fit on its own is kept: the invariant is a bounded payload wherever droppable, never an empty card that hides a real result", and the pre-cap `total` is always carried so a UI can say "showing 250 of 1,204".

---

## Files skipped (with reasons)

- (none — every file in the shard was opened; see the note below the list)

**None.** No file in this shard was skipped. Every one of the 231 manifest rows was opened, and the shard decomposes as: 65 `.ts` source files, 58 test files (including the two `*.e2e.ts` suites and the two shared test helpers), 1 C++ header-verification program, 1 PowerShell diagnostic asset, 18 English READMEs, 18 Chinese READMEs, 18 `.i18n.yaml` pairing records, 15 `package.json` manifests, 15 `tsconfig.json` project references, 2 `tsdown.config.ts` build configs, 9 `locale/en.json` + 9 `locale/zh.json` stubs, 1 bundled `SKILL.md` and 1 Cordis composition fixture. The 65 source files were read end to end; the test files were characterised by their full `describe`/`it` title sets (which name the invariant each case pins) and the smaller ones were read end to end; the 18 English READMEs were read in full; the 18 Chinese READMEs were read at their frontmatter and overview and confirmed to be section-for-section translations with matching line counts; the 18 `.i18n.yaml` records were read (three in full, the rest in their header and first records — all the same generated hash format); every `package.json`, `tsconfig.json`, `tsdown.config.ts`, `locale/*.json` and fixture file was read in full; and the PowerShell asset was read in two verbatim passes plus a structural pass over its 24 functions (see Uncertainties).

---

## Uncertainties

- **The Chinese READMEs were sampled, not read line by line.** `packages/fs/**/README.zh.md`, `packages/sandbox/**/README.zh.md` and `packages/storage/**/README.zh.md` (18 files) were each opened at the frontmatter and overview and their line counts compared with the English originals (they match exactly, e.g. `packages/fs/tool-fs/README.zh.md` 266 lines vs `README.md` 266 lines). The content they carry is a translation of the English file whose content is quoted in the per-file notes above, so no unique mechanism is expected to be hidden in them — but I did not verify every Chinese sentence. The English README is the authoritative source for each.
- **The `.i18n.yaml` pairing records were read structurally.** Three (`packages/fs/fs/README.i18n.yaml`, `packages/fs/README.i18n.yaml`, `packages/sandbox/sandbox-windows-acl/README.i18n.yaml`) were read in full; the other 15 were read at their header and first records and confirmed to be the same generated per-heading hash format with only the package path and hashes differing. I did not re-compute any hash.
- **The 63 test files were characterised by their `describe`/`it` titles** (via a read-only grep over the source) plus full reads of the smaller ones (`error.spec.ts`, `harness.ts`, `contract.ts`, `memory-backend.ts`, `packed-workspace-closure.ts`, `skill-composition.spec.ts`, `cordis.yml`, `watch.spec.ts`, `win32.spec.ts`, `containment.spec.ts`, `roots.spec.ts`, `vocabulary.spec.ts`, `load-path.spec.ts`, `rg-path.spec.ts`, `rg-sidecar.spec.ts`, `diff.spec.ts`). For the larger ones the assertions are named by their titles, which is how the repo itself documents them, but I did not read every assertion body.
- **`packages/fs/tool-fs/tests/read-image.spec.ts` and `tests/tools.spec.ts` (tool-fs) were title-characterised, not read in full** — the titles are unusually complete in this repo (each names the invariant it pins), but I did not verify the assertion bodies.
- **The PowerShell diagnosis script was read in two passes, not one**: lines 1–160 and 660–798 verbatim, with the function inventory (24 functions from `Write-Line` to `Get-Ancestors`) read structurally. The middle region (lines ~160–660: the native-API initialisation, the object-fact collector, the ancestor walk and the subtree scan) was read by its function signatures and the surrounding comments, not line by line. The class-level behaviour is described from the parts I did read plus the package README's account of it.
- **`packages/sandbox/sandbox-windows-acl/tests/diagnose-script.spec.ts` and `tests/runner.spec.ts` were title-characterised.** These are Windows-only suites whose bodies were not read line by line.
- **The manifest's shard assignment for `packages/storage/*` is thematically surprising.** The shard is named `dsh-sandbox-fs` but the manifest assigns all 47 `packages/storage/**` files to it. I followed the manifest as instructed and covered them, but a reader looking for the storage family would not expect to find it under a sandbox/fs shard. I did **not** modify the manifest.
- **No manifest row was missing or wrong in this shard.** I verified that all 231 rows exist in the clone at `C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness` and that the recorded sizes match the files on disk. The `type` column labels are consistent with what the files are (`source` for the `.ts`/`.ps1`/`.cpp`, `tests` for the `*.spec.ts`/`*.e2e.ts`/helper files, `docs` for the READMEs, `config` for manifests/locale/i18n). The `note` column is empty for every row in this shard, and the `status` column is `pending` for every row — I did not change either, since the manifest is read-only.
- **Nothing was executed.** No build, test, install, or script from the clone was run; the clone was read and grepped only. All 231 files were inspected through `read`/`grep` and read-only shell listing.

