# deepseek-harness / dsh-apps-cli

## Shard shape

`apps/cli` is the **`dsh` launcher**: the single Node entry point that boots a *profile*. A profile is not a config file — it is an **ordered stack of plugin-bundle patch layers** composed over an empty root, with the user's own `cordis.patch.yml` and any `--patch` overlays layered on top, and the whole thing mounted into a Cordis plugin tree. The shard holds four things that fit together this way:

1. **The launcher itself** (`src/args.ts`, `src/bin.ts`, `src/profile-boot.ts`, `src/process-shutdown.ts`, `src/plugin.ts`, `src/dump-config*.ts`, `src/startup-diagnostics.ts`). `args.ts` owns the command grammar and draws a hard *boundary* — the first token it does not recognise starts the booted app's own arguments, handed over verbatim through `ctx.cmdlineArgs`. `profile-boot.ts` composes the layers, installs the outbound proxy from a frozen launch snapshot, provides `appReady`/`appExit`, and wires bounded, escalating shutdown. `plugin.ts` forwards package management to pnpm and holds the exact-version compatibility exemption mechanism.
2. **The normative contract** (`README.md`, `reference/README.md`, `composition.md` + their Chinese mirrors and i18n hash records). `reference/README.md` is the densest document in the shard: it specifies layer precedence, the config-dump and schema-dump semantics, startup diagnostics, plugin management, the Web profile, and source execution. `composition.md` is a *generated* mermaid graph of the ~90 rows the `dsh-base` bundle inserts.
3. **The product's own surfaces** (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) exercised as **profiles of the same launcher**, with per-profile patch overlays and golden snapshot fixtures.
4. **A large acceptance corpus** (160 of the 182 files are tests, fixtures or golden data) that is unusually disciplined: it verifies the **world** (files on disk, the bytes the provider received, the exact process exit code) rather than the model's self-report, and it uses **recorded-session replay** (`@deepseek-ai/dsh-llm-replay`) plus a golden-file snapshot mechanism (`DSH_SNAPSHOT=refresh`) so behaviour changes are visible as a diff.

The shard is best read as **the harness's deployment and composition layer**, not its agent loop: the loop itself lives in `packages/core/agent-loop`, which this shard *composes, configures, and observes* through profiles.

---

## Per-file notes

### apps/cli/src/args.ts
- **Purpose:** the Commander adapter that owns the `dsh` command grammar and nothing else.
- **Key abstractions:** `DshInvocation` is a four-way discriminated union — `profile | dump-config | dump-config-schema | plugin` — each carrying the profile name, the optional `--from-default-profile` template, the ordered `--patch` overlay list, and (for `profile`) the inner `args` snapshot.
- **Data flow:** `parseDshArgs(argv, version, manageDesktopProfile)` builds a `Command` with `.allowUnknownOption().passThroughOptions().enablePositionalOptions()` and a `[args...]` positional. Commander's unknown-option pass-through is what creates the boundary: the first token the launcher does not own lands in `args`. `resolveBoot()` then validates (empty `--patch`/`--from-default-profile` values, mutually exclusive dump flags, dump-with-app-arguments) and returns the union. `first === 'plugin'` installs a subcommand whose own `.helpOption('-h, --help')` restores the help Commander copied down from the disabled parent.
- **Non-obvious design decisions:**
  - `--patch` is a *repeatable single-value collector*, explicitly **never variadic** (`args.ts:72-76`): "a variadic `--patch` would swallow the inner arguments."
  - The launcher's own `-h/--help` is **disabled** (`.helpOption(false)`, `.helpCommand(false)`) so the booted app's `-h` reaches the app, not the launcher. A bare `dsh -h` with no profile prints the launcher's help via the action handler (`args.ts:175-179`).
  - `dsh <name>` expands to `dsh --profile <name>` by prepending `--profile` to argv, but **only** when the first token is not a flag and is not literally `plugin` (`args.ts:206-208`).
  - A dump is **boot-free**, so it is *rejected* when app arguments are present (`args.ts:122-127`): "it never runs app command-line providers, so it cannot show what those flags would decide, and printing a tree that differs from the same invocation's boot would mislead."
  - `desktop` is reserved case-insensitively (`args.ts:83-87`); the installed Desktop carrier may manage *its* profile via a `manageDesktopProfile` flag, but the npm CLI may not.
  - Repeated `--profile` is rejected with a specific message (`select a profile only once`), but a *late* `--profile` after the boundary is forwarded to the app (`args.ts:46-56`, `args.ts:97-111`).
- **Edge cases / failure handling:** `CommanderError` exits with its own code; any other error exits 1 (`args.ts:210-212`). `resolved === undefined` after a successful parse is treated as impossible and throws.
- **Surprising:** `plugin` is only the plugin-management command when it *immediately* follows `dsh`; after a profile is selected, `plugin` and `web` are ordinary app arguments (`args.ts:73-80`).

### apps/cli/src/bin.ts
- **Purpose:** the `runCli()` entry, shared by the npm CLI, the packaged launcher, and the Desktop carrier.
- **Key abstractions:** `RunCliOptions` is a `Pick` of `RunProfileOptions` plus `manageDesktopProfile` — the installation owns the package runtime, the CLI owns the profile lifecycle.
- **Data flow:** parse argv → `switch (invocation.mode)` → **dynamically import only the selected runner** (`profile-boot.ts`, `plugin.ts`, `dump-config.ts`, `dump-config-schema.ts`). `loadLayeredEnv('dsh')` produces the frozen environment snapshot before any plugin mounts.
- **Non-obvious design decisions:** the `default:` branch uses `invocation satisfies never` so adding a mode to the union becomes a **compile error** here rather than a runtime fallthrough (`bin.ts:70-73`).
- **Edge cases / failure handling:** a `StartupError` is caught and handed to `reportStartupFailure(...)` (which writes the private log) before `process.exit(1)`; any other error rethrows.
- **Surprising:** the mode dispatch is a *dynamic import* per mode — the web/headless/sdk/ACP runtimes are never loaded unless selected.

### apps/cli/src/profile-boot.ts
- **Purpose:** the shared profile boot for every `dsh` surface, and the host-side lifecycle reused by the Desktop app via the `@deepseek-ai/dsh/profile-boot` export.
- **Key abstractions:**
  - `ComposedProfile` = `{ profile, resolution, overlays }` — the loaded profile, an **immutable runtime resolution computed before any plugin imports**, and the frozen command-line overlay contents.
  - `ResolvedProfileRuntime` — an application-owned profile plus its own installation anchor (the Desktop path).
  - `createAppReady()` — a readiness service with a one-shot `commit()`.
- **Data flow:** `installProxyFromEnvironment(environment, warn)` → `composeProfile()` (load profile, `createRuntimeResolution()`, `loadOverlayPatches()` per `--patch`) → `boot(NAME, rootConfig, readProfilePatches(...), setup)` where `setup` provides `profileContext`, the launch-environment service, `PluginPackages` (carrying the resolution), and `provideCmdline(ctx, { args, exit, ready })`.
- **Non-obvious design decisions:**
  - **The empty root config is rewritten on every boot** (`profile-boot.ts:180-200`). The comment states why: "the vendored Loader's tree write-back (a plugin self-disposing persists the current tree) can bake composed rows into this file — which would duplicate every bundle insert on the next boot." The file exists only so the Loader has a real include root to anchor `baseUrl` at the profile directory.
  - **The outbound proxy is resolved from the launch snapshot, not `process.env`** (`profile-boot.ts:272-279`): "Node's fetch ignores the proxy environment on its own… Resolving from the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start."
  - **The launch environment is provided as a service before any config-tree entry mounts** (`profile-boot.ts:326-328`), so every plugin resolves launch-time values from the same immutable snapshot.
  - **Profile replacement uses a staging directory + two renames** (`profile-boot.ts:108-177`): the staging dir is a *sibling* of the target so both renames stay on one filesystem; the previous target is moved to `<staging>/previous` first; a failed restore throws an `AggregateError` **naming the staging path** so a human can recover the old profile by hand; a leftover staging dir is reported on stderr but is not fatal (the replacement already succeeded).
  - **Windows reports `EPERM` rather than `EEXIST`/`ENOTEMPTY`**, so a concurrent winner is detected by *the target's state* rather than the error code (`profile-boot.ts:148-153`).
  - **Readiness is committed only on four conditions**: the shutdown was not aborted, the fiber is `ACTIVE`, a `loader` service exists, and boot returned (`profile-boot.ts:341-345`).
  - **Signals own teardown throughout the startup window**, not only after boot settles (`profile-boot.ts:302-308`): "an inserted provider can publish before sibling rows finish mounting."
  - **SIGTERM exits 0, SIGINT exits 130** — the stated reason: "SIGTERM is a supervisor's ordinary stop request and exits 0 on every surface — the launcher does not know whether the app considered its work complete; SIGINT is a user interrupt and reports 130."
  - `homePatchPath()` is resolved *per call*, not at module load, because `$DSH_HOME` may be set by the test or the launcher after import (`profile-boot.ts:67-75`).
- **Edge cases / failure handling:** the disposer releases both the fiber and the proxy and aggregates failures (`AggregateError` for >1); a startup failure re-throws the original error after cleanup, wrapping both in an `AggregateError` when cleanup also failed (`profile-boot.ts:347-352`).
- **Surprising:** `PROFILE_ROOT_CONFIG` is a literal constant that is *always* re-written, and the shipped profile name comparison is **case-insensitive** (a `Web` profile would collide with the shipped `web` directory on a case-insensitive filesystem).

### apps/cli/src/process-shutdown.ts
- **Purpose:** a bounded, escalating process-exit controller shared by the long-lived CLI surfaces.
- **Key abstractions:** `ProcessShutdown` = `{ shutdown(code): Promise<void>, interrupt(code): void }`.
- **Data flow:** `shutdown()` starts a `setTimeout(forceExit, PROCESS_SHUTDOWN_TIMEOUT_MS)` (5 s) and calls `dispose()`; on resolve it calls `complete(code)` (default: set `process.exitCode`), on reject it forces exit. `interrupt(code)` while a shutdown is already pending **forces exit immediately**; otherwise it starts the drain and *will* force-exit when disposal finishes.
- **Non-obvious design decisions:**
  - **Repeated `shutdown()` calls coalesce and do not escalate** — the second call returns the *same* promise (`process-shutdown.ts:52-53`, `149-165`). Only a *signal* escalates.
  - `forceExitOnce` / `completeOnce` make both paths idempotent, and `completeOnce` refuses to run after a forced exit (`process-shutdown.ts:38-50`).
- **Edge cases / failure handling:** a disposer that never settles is bounded by the 5 s timer; a disposer that *rejects* forces exit immediately rather than waiting for the bound.
- **Surprising:** `shutdown()` after a signal has already forced the exit still resolves — the controller never throws.

### apps/cli/src/plugin.ts
- **Purpose:** profile package management, plus **explicit, exact-version compatibility approvals**.
- **Key abstractions:** `versionCommand()` owns only the three DSH-owned verbs (`allow-version`, `revoke-version`, `version-exemptions`); everything else falls through to pnpm verbatim.
- **Data flow:** `runPlugin(profile, args, packageManager)` → desktop guard → `versionCommand()` (which takes the profile's `package.json` **file lock** for the whole read-modify-write) → `runPluginCommand()` / `runProfilePnpm()` with a 120 s lock wait and 16 KB output cap.
- **Non-obvious design decisions:**
  - **The grant is an exact pair** — `package@version` **plus** the exact DSH runtime version — never a range (`plugin.ts:34-39`; the spec rejects `plugin@^1.2.3`).
  - **`--accept-risk` is required** for `allow-version`, and the risk warning is printed **before** the grant is written (`plugin.ts:40-42`).
  - The exemption lives in its own `compatibility.json` file, **not** in the dependency manifest — so the manifest and the bundle list stay untouched (`plugin.spec.ts:41-42`, `plugin-compatibility.expected.e2e.ts:60-62`).
  - **The Desktop profile is never created by the CLI**: `requireDesktopProfile()` refuses with an instruction to open Desktop once and quit it (`plugin.ts:10-14`).
  - Desktop package operations run under the **same writer lock** as the profile manifest, and the lock file must not survive the run (`plugin.spec.ts:141-160`).
  - A git-hosted plugin's `prepare` script needs pnpm's `allowBuilds`; the CLI prints the exact remediation (`plugin.ts:103-105`).
- **Edge cases / failure handling:** exit code 127 gets a "pnpm was not found" message; each incompatible package gets its **own copy-pasteable** grant command (`plugin.ts:99-101`).
- **Surprising:** `versionCommand` parses its own flags out of the argument list and *rejects* any unexpected argument, so a typo is an error rather than a silent no-op.

### apps/cli/src/dump-config.ts
- **Purpose:** the boot-free YAML composition dump.
- **Key abstractions:** `collectConfigDumpLayers(loaded, defaultOnly, patches)` returns `ConfigDumpLayer[]` = `{ label, patches }`, where `label` is the *file* that supplied the layer.
- **Data flow:** `prepareProfile()` (which initialises the profile and rewrites the empty root) → collect layers → `renderConfigDump(NAME, rootConfigPath, layers)`, anchored on the **same empty root file the boot includes** so the dump and the boot compose over an identical base.
- **Non-obvious design decisions:** `--dump-default-config` **never reads** the profile/home/argv patch files at all (not just "ignores them") — so a broken `cordis.patch.yml` cannot break the recovery diagnostic (`dump-config.ts:60-73`, `reference/README.md:53`).
- **Edge cases / failure handling:** unmatched patch targets are reported on stderr by the renderer; the dump itself does not evaluate `!!js`.
- **Surprising:** the dump *does* initialise missing profile files — it is not a pure read.

### apps/cli/src/dump-config-schema.ts
- **Purpose:** print one JSON Schema 2020-12 document for the composed profile, without mounting it.
- **Key abstractions:** `ConfigSchemaDump` — a JSON Schema document carrying an `x-cordis` annotation block (`profile`, `complete`, `entries`, `diagnostics`, `patchSchema`).
- **Data flow:** `prepareProfile()` → `collectConfigDumpLayers()` → `generateConfigSchema(loaded, layerPatches, INSTALL_ANCHOR)`, which **imports** the plugin modules to read their Schemastery declarations, then the document is printed to stdout and the diagnostics to stderr.
- **Non-obvious design decisions:**
  - **stdout is redirected to stderr for the whole collection** (`dump-config-schema.ts:32-41`): "Trusted module diagnostics must not precede the JSON document on stdout." A module's `console.log` cannot corrupt the document.
  - The collection **never applies plugins and never evaluates `!!js`** — it imports, reads schemas, and stops.
  - **Incomplete collection still prints a schema** but sets `process.exitCode = 1` (`dump-config-schema.ts:47`).
- **Edge cases / failure handling:** preparation / patch-parse / resolution failures exit nonzero *without* a schema; collection and projection failures retain partial output and exit 1.
- **Surprising:** the file is entirely `/* v8 ignore file */` — the shipped behaviour is exercised by the built-bin acceptance, not by unit coverage.

### apps/cli/src/startup-diagnostics.ts
- **Purpose:** save the full startup failure report privately while keeping the terminal output short.
- **Key abstractions:** `StartupDiagnosticContext` = `{ home, version, profile }` — deliberately **no environment values and no plugin configuration** are collected.
- **Data flow:** `reportStartupFailure(error, context, write)` → build the report with `util.inspect` (depth/string/array limits disabled, `customInspect: false`, `getters: false`) → write the one-line summary to stderr → `mkdir(logDir, { mode: 0o700 })` → `writeFile(logPath, report, { flag: 'wx', mode: 0o600 })` → print the saved path.
- **Non-obvious design decisions:**
  - **`flag: 'wx'`** — the file is created exclusively, so a concurrent failure can never overwrite an earlier report (`startup-diagnostics.ts:62`).
  - **The report header warns that raw diagnostics may contain credential values** and are not redacted (`startup-diagnostics.ts:40`).
  - **If the write fails, the whole report is printed to stderr** rather than claiming a path that does not exist (`startup-diagnostics.ts:63-66`).
  - The path is `startup-<timestamp>-<uuid>.log` — the UUID makes concurrent failures distinct files.
- **Edge cases / failure handling:** stderr completion is *awaited* via the write callback, so the process does not exit before the report is flushed; a stderr write error propagates as a rejection.
- **Surprising:** `inspect` is configured with `showHidden: true` so non-enumerable and `Symbol` properties survive, but with `getters: false` so an accessor is *described* and never evaluated (`startup-diagnostics.spec.ts:80-105`).

### apps/cli/src/sdk-source.cordis.patch.yml
- **Purpose:** disable the `typert-loader` row in clean source checkouts.
- **Key abstractions:** a one-row patch list; the `id` is the Loader row id and `disabled: true` is the switch.
- **Data flow:** applied as a source-overlay during SDK-profile runs; the installed build keeps the complete `dsh-base` row.
- **Non-obvious design decisions:** the comment names *why* — "Clean source checkouts have no build-generated Typert contributor modules. The SDK JSON-RPC application does not consume the Typert remote gateway."
- **Edge cases / failure handling:** none; the row is simply off in source mode.
- **Surprising:** the disabled row is still *present* in the composition, so the config dump shows it as disabled rather than absent.

### apps/cli/tsdown.config.ts
- **Purpose:** the bundler config for the CLI.
- **Key abstractions:** two entries — `lib/types/bin.js` and `lib/types/profile-boot.js` — the latter being the Desktop-facing export.
- **Data flow:** `tsc -b` produces `lib/types/*.js` + `.d.ts`; tsdown bundles the two JS entries into `lib/`, `dts: false` (declarations come from `tsc`).
- **Non-obvious design decisions:** `clean: ['lib/*.js']` keeps the hand-built type output from being deleted; `fixedExtension: false` because the package is ESM-only.
- **Edge cases / failure handling:** none in this file.
- **Surprising:** the *published* `files` list is only `lib/*.js` and `lib/types/*.d.ts` — the CLI ships almost nothing.

### apps/cli/tsconfig.json
- **Purpose:** the CLI's TypeScript project: `rootDir: src`, `outDir: lib/types`, extending the workspace base.
- **Key abstractions:** 25 project references — vendored `cordis`/`loader`/`include`, the `boot` packages, the three bundle packages (`base`, `headless`, `web-app`), the host packages, and the core `session`/`system-prompt`/`tools`.
- **Data flow:** `tsc -b` walks the references, so the CLI's declarations are built against the *referenced projects'* outputs.
- **Non-obvious design decisions:** the reference list is the CLI's **compile-time dependency closure** and is a good proxy for what the launcher actually touches.
- **Edge cases / failure handling:** none.
- **Surprising:** `include` is only `["src"]` — the `tests/` tree is not type-checked by this project.

### apps/cli/package.json
- **Purpose:** the published `@deepseek-ai/dsh` manifest.
- **Key abstractions:** `bin: { dsh: "lib/bin.js" }`; `exports` publishes `./profile-boot` for the Desktop host and `./lib/*` for the built tree.
- **Data flow:** ~90 `dependencies` (all `workspace:*`) are the **runtime closure**; ~50 `devDependencies` are the *test* closure (the LLM adapters, the mock server, the replay adapter, the agent loop testkit, the subagent providers, the webhook packages).
- **Non-obvious design decisions:** the dependency list is the honest picture of the shipped surface — `@deepseek-ai/dsh-http-proxy`, `dsh-mcp-resources`, `dsh-plugin-manager`, `dsh-atomic-write` are there because the launcher uses them directly, not transitively.
- **Edge cases / failure handling:** `publishConfig.access: public`; `files` restricts the tarball to `lib/*.js` + `lib/types/*.d.ts`.
- **Surprising:** `version` is `0.2.1-rc.2` — a prerelease, and the built-bin test explicitly refuses to pin a literal version because the manifest carries the prerelease.

### apps/cli/README.md
- **Purpose:** the user-facing entry-mode and profile documentation.
- **Key abstractions:** the entry-mode table (`dsh <name>`, `--from-default-profile`, `plugin`, `dsh web`) and the profile directory contract (`package.json` with `dsh.profile.bundles` + `cordis.patch.yml`).
- **Data flow:** documents the composition order (bundle layers → profile patch → home patch → `--patch` overlays) and the bundle resolution order (installation first, then the profile's own `node_modules`).
- **Non-obvious design decisions:** it states that **the npm CLI also rejects its own plugin-management requests** for the desktop profile, and that only the Desktop-installed command can manage it.
- **Edge cases / failure handling:** mentions the `engines.dsh` range check and the exact-version exemption.
- **Surprising:** "The Python runtime wheel packages this same command" — the CLI ships inside the Python wheel, and the SDK profile defaults to `sdk`.

### apps/cli/README.zh.md
- **Purpose:** the Chinese mirror of `README.md`.
- **Key abstractions:** same entry-mode table and profile contract, with bilingual terminology (profile manifest = 元数据清单, agent = 智能体).
- **Data flow:** identical layer order and the same optional-overlay policy.
- **Non-obvious design decisions:** it keeps the same link targets and section ids so the bilingual pairing hash covers the same structure.
- **Edge cases / failure handling:** same as the English text.
- **Surprising:** it is not a machine translation — the prose reorders clauses to Chinese grammar, which is why the pairing gate hashes *per heading block* rather than per file.

### apps/cli/README.i18n.yaml
- **Purpose:** the bilingual-pair consistency record for `README.md`.
- **Key abstractions:** one entry per heading section, keyed by a slash-path (`/deepseek-ai-dsh/profiles`), holding an `en` and a `zh` hash.
- **Data flow:** `pnpm run verify-translation-pairing --write apps/cli/README.md` recomputes the hashes of each English and Chinese block outside code fences and generated regions.
- **Non-obvious design decisions:** the hash is **per heading section**, not per file — so a drift in one section is reported precisely, and a reordering of sections does not invalidate the whole file.
- **Edge cases / failure handling:** the file is a record, not a validator; the gate lives elsewhere.
- **Surprising:** the key path is derived from the heading text, so renaming a heading invalidates its own record.

### apps/cli/reference/README.md
- **Purpose:** the **normative** CLI behaviour reference — the document the whole product is measured against.
- **Key abstractions:** sections for profile boot, app arguments, config-schema dump, startup diagnostics, plugin management, the Web profile, shared deployment behaviour, and source execution.
- **Data flow:** it is prose, but every sentence is a contract that a test in this shard pins. Examples: "`--dump-config` … rejects an invocation that carries app arguments"; "the launcher consumes one `--`"; "`plugin` selects plugin management only when it immediately follows `dsh`".
- **Non-obvious design decisions:**
  - The **layer precedence** is stated once and precisely: bundle patches in `dsh.profile.bundles` order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml` (home outranks profile because it is "machine-local preferences shared by every profile"), then each `--patch` overlay in argv order. "Later layers win per row; a patch replaces the targeted row's complete `config` value rather than deep-merging keys."
  - The **config-schema dump** section is a full contract: `!!js` becomes an inert `{ "__jsExpr": "..." }` marker; "JSON Schema defaults are annotations, not default insertion"; unions use `anyOf` while "native execution still selects its first successful branch"; "An absent Config means unknown fields, not forbidden configuration"; `complete` is false for any error diagnostic, any `partial`/`unsupported`/`error` entry, or one plugin name mapping to multiple Config definitions; and "**`complete` does not guarantee successful boot**".
  - The **startup diagnostics** section specifies the report's contents, the `0700`/`0600` modes, the "print a file path only after writing succeeds" rule, and that "Values are not redacted".
  - The **Web profile** section pins `--host` (must be a concrete local address, not a wildcard), `--public-url` ("It grants no trust"), the TLS pair ("both or neither"), the 5 s dispose budget, and the "first `SIGINT`/`SIGTERM` starts that graceful drain … a second signal forces immediate exit" rule.
  - The **deployment behaviour** section pins the credential resolution order (inherited environment → `$DSH_HOME/.credentials.yaml` → the invoking directory's `.env` → `$DSH_HOME/.env`) and the telemetry switches (`DSH_TELEMETRY_MODE=DISABLED` disables, `FULL` is rejected, any non-empty `DSH_TELEMETRY_DISABLED` disables its row).
- **Edge cases / failure handling:** it states the *limits* of each mechanism as first-class facts — e.g. "Handoff is best-effort, not collector acceptance; no durable outbox or retry guarantee is provided."
- **Surprising:** it explicitly calls the schema dump "a regenerated, pre-stable reference, not a versioned persisted catalog" and tells readers to "follow `$ref` and `configRef` rather than hard-coding definition names, ordering, or text."

### apps/cli/reference/README.zh.md
- **Purpose:** the Chinese mirror of the behaviour reference.
- **Key abstractions:** identical section ids and order, so the same per-heading pairing hashes apply.
- **Data flow:** the same contracts, rephrased — the layer order, the schema-dump semantics, the startup-diagnostics rules, the plugin-management rules, the Web flags.
- **Non-obvious design decisions:** it keeps the technical terms untranslated where translation would be ambiguous (`patch`, `overlay`, `profile`, `bundle`), which is why the English headings survive as the hash keys.
- **Edge cases / failure handling:** same.
- **Surprising:** it is the *longer* of the two in places — the Chinese text expands several English clauses rather than compressing them.

### apps/cli/reference/README.i18n.yaml
- **Purpose:** the pairing record for `reference/README.md`.
- **Key abstractions:** ten heading-scoped en/zh hash pairs, including the two nested `profile-boot/...` sub-sections.
- **Data flow:** regenerated by the same `verify-translation-pairing --write` gate.
- **Non-obvious design decisions:** the anchor ids (`config-schema-dump`, `startup-diagnostics`, `source-execution`) are part of the key path, so a moved anchor is a drift.
- **Edge cases / failure handling:** the gate is external.
- **Surprising:** the record proves the *Chinese* document is edited in step with the English one — a doc-drift gate that is data rather than a script.

### apps/cli/composition.md
- **Purpose:** a **generated** graph of the `dsh-base` bundle's composition.
- **Key abstractions:** a mermaid `flowchart LR` from the `cordis.yml` config node to ~90 plugin nodes, plus a `Plugin id | Package / module` table.
- **Data flow:** `scripts/gen-doc-graphs.ts` parses the bundle's `cordis.patch.yml` row list and expands the app packages from package source; the file header says "do not edit by hand".
- **Non-obvious design decisions:** the table maps the *Loader row id* to the *npm package*, so an operator can find the package that owns a failing row without reading the YAML.
- **Edge cases / failure handling:** "Maintenance mode: hybrid: the patch row list is parsed from its `cordis.yml`; app package expansion is curated from package source."
- **Surprising:** the graph is the fastest way to see the whole product's shape — the agent loop, the tools, the subagent family, the compaction family, the MCP rows, the telemetry rows and the OTEL rows are all in one picture.

### apps/cli/config/examples/mcp-memory/engram.cordis.yml
- **Purpose:** an opt-in overlay adding the Engram memory MCP server.
- **Key abstractions:** one `insert` row naming `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: stdio`, `command: engram`, `args: [mcp]`.
- **Data flow:** DSH starts the pinned `engram` executable; storage and project selection stay Engram-owned.
- **Non-obvious design decisions:** `cwd: !!js process.cwd()` — the MCP server inherits the *session* working directory.
- **Edge cases / failure handling:** the pinned version is stated in the comment ("Engram 1.20.0"); the user must install the executable first.
- **Surprising:** the file is a *product asset*, not a test fixture — `tests/profiles/AGENTS.md` says so explicitly.

### apps/cli/config/examples/mcp-memory/mcp-reference-memory.cordis.yml
- **Purpose:** an opt-in overlay for the reference MCP memory server.
- **Key abstractions:** the same `mcp-client` row shape, with `serverName: reference_memory` and no `args`.
- **Data flow:** `env.MEMORY_FILE_PATH` is a `!!js` expression that falls back to `~/.dsh-mcp-reference-memory.jsonl`.
- **Non-obvious design decisions:** the env value is an **expression**, not a literal — the server's store path follows the user's environment.
- **Edge cases / failure handling:** the comment states "DSH starts it but does not run a package manager."
- **Surprising:** the memory store is *outside* `$DSH_HOME` by default, and the `mcp-memory-configs.spec.ts` test asserts the overlays carry no secret-shaped text.

### apps/cli/config/examples/mcp-memory/memorix.cordis.yml
- **Purpose:** an opt-in overlay for Memorix.
- **Key abstractions:** `serverName: memorix`, `transport: stdio`, `command: memorix`, `args: [serve]`.
- **Data flow:** DSH launches the pinned `memorix` executable; the MCP client bridges its tools into the agent's tool table.
- **Non-obvious design decisions:** the same shape as the other two examples, so the three differ only in the command and its version pin.
- **Edge cases / failure handling:** "Install the pinned `memorix` executable first".
- **Surprising:** `memory-mcp-configs.spec.ts` proves the *real* Loader discovers `mcp__<server>__greet` from these rows — the example is a working integration, not a sketch.

---

## Per-file notes (tests and fixtures)

### apps/cli/tests/args.spec.ts
Commander-grammar spec (257 lines). Pins the boundary behaviour precisely: `parse(['--profile','tui','--resume','abc'])` yields `args: ['--resume','abc']`; a *late* `--patch` after the boundary is an app argument; `dsh web --from-default-profile web` still works; `plugin` after a profile is an app argument; the three dump flags are mutually exclusive; `desktop`/`Desktop`/`DESKTOP` are rejected in every mode including `plugin` unless `manageDesktopProfile` is set; `--dump-config` with `--port 8080` is rejected. The `exitCode()` helper spies on `process.exit` and throws, which is how the spec asserts a nonzero exit without killing the worker.

### apps/cli/tests/process-shutdown.spec.ts
Shutdown-controller spec. Uses fake timers to advance to `PROCESS_SHUTDOWN_TIMEOUT_MS - 1` and then `+1` to prove the forced exit lands exactly on the bound; proves `shutdown()` coalesces (the second call returns the *same* promise object); proves `interrupt()` after a pending `shutdown()` exits 130 immediately; proves the default `complete` writes `process.exitCode` rather than calling `process.exit`.

### apps/cli/tests/startup-diagnostics.spec.ts
Diagnostic-file spec. Asserts the filename shape `startup-[\w.-]+\.log`, the `0600`/`0700` modes on POSIX, that two concurrent failures produce **two** files with distinct contents, that a blocked `logs` path makes the whole report go to stderr and leaves the blocking file untouched, and — the sharpest part — that a custom `inspect` function is **not** called and a lazy getter is **not** evaluated (`inspected === false`, `getterRead === false`).

### apps/cli/tests/plugin.spec.ts
Exemption-command spec. Mocks `runPluginCommand`/`runProfilePnpm` and asserts the exemption file content, the exact warning text, that a malformed or unacknowledged command returns 1 and creates **no** `compatibility.json`, that the Desktop profile is never created by the CLI, and that a Desktop run leaves no `package.json.lock` behind and the manifest byte-identical.

### apps/cli/tests/profile-initialization.spec.ts
Profile-replacement spec (263 lines). Mocks `node:fs.renameSync` to inject failures, and proves: the template copy carries the template's *bundle list* but **not** the source profile's dependencies or user patch; a residual target directory is replaced; a failed move **restores** the previous directory byte-for-byte; a failed restore leaves the previous profile at `.<name>.staging-*/previous` and throws an `AggregateError` naming that path; a case-variant shipped name (`Web`) is refused; and **two synchronised processes** replacing the same target leave exactly one complete copy, with the loser reporting "was recreated concurrently".

### apps/cli/tests/resolved-profile-boot.spec.ts
Application-owned-profile spec. Proves the Desktop path shares the named-profile lifecycle: the patch layer order is profile → home → `--patch` overlay (the overlay wins), the launch-environment snapshot is what the proxy is installed from, `ctx.cmdlineArgs.get()` returns the app's arguments, `appReady` fires, and — the important part — that **every** startup-resource release path (composition failure, boot failure, tree cleanup failure, proxy cleanup failure, both) is exercised and produces the right aggregated error.

### apps/cli/tests/profile-hmr.spec.ts
HMR-ownership spec over the *real* shipped bundle patches. `base` + `web-app` enable the watcher; `headless`/`sdk-app`/`acp-app` disable it with a bundle override (and a later YAML layer can re-enable it); `sdk-minimal` has no `hmr` row at all. A useful fact for anyone reasoning about which surfaces hot-reload.

### apps/cli/tests/profile-mcp.spec.ts
MCP-ownership spec. Every shipped profile carries exactly one `mcp-resources` row and **zero** `mcp-client` rows — the resource consumer is shared, the server is not enabled by default.

### apps/cli/tests/telemetry-switch.spec.ts
Telemetry-switch spec (22 lines) with a precise rule: **any** non-empty value of `DSH_TELEMETRY_DISABLED` disables the row, including `"0"`, `"false"` and `"no"`; an absent/empty value preserves the configured mode; and a composition without the telemetry row needs no patch at all.

### apps/cli/tests/memory-mcp-configs.spec.ts
Example-overlay spec. Parses each checked-in overlay, asserts the id, the package name, the server name, the transport, and that the **first line of the file carries the version pin**; asserts no `sk-…`-shaped string and no `DEEPSEEK_API_KEY` in the file. Then it replaces only the upstream endpoint with the package-owned keyless fixture and proves the **real** Cordis Loader discovers `mcp__<server>__greet` through the generic bridge.

### apps/cli/tests/windows-shell.spec.ts
Shell-composition spec over the real bundle layers. Pins the per-platform roster: the `bash-sandbox`/`pwsh-sandbox` rows gate *themselves* by `!!js process.platform` (one shared patch set, two rosters), the host `tool-bash`/`tool-pwsh` rows are disabled on every platform, the permission surface never moves, and the cold-start dependency closure must reach `@deepseek-ai/dsh-pwsh-sandbox` and `@deepseek-ai/dsh-tool-pwsh`. A second block pins the same gating inside the shipped agent presets, evaluated with a platform-scoped `process` so both outcomes hold on any host.

### apps/cli/tests/source-launch.compat.spec.ts
Source-lane check. Asserts the root script is exactly `node --import tsx/esm apps/cli/src/bin.ts` and that a bare source launch exits nonzero with `--profile <name> is required` and **empty stdout**. It also calls the same `testProfileResolution('src')` the built lane calls with `'lib'`.

### apps/cli/tests/lazy-search-startup.compat.spec.ts
Node-22 startup smoke. Boots the built Web CLI, waits for the settled `dsh web: http://127.0.0.1:<port>` line, then SIGTERMs it; also asserts the shipped `session-query-sqlite` row keeps `openAt: 'never'` in *both* the base and the web layer (the web restatement must not re-enable it).

### apps/cli/tests/built-bin.e2e.ts
The published-entry acceptance (1324 lines) over `node apps/cli/lib/bin.js` with no tsx. Covers: the help file snapshot; every shipped profile's own `--help`; an optional SDK plugin import failure staying non-fatal; a real JSON-RPC SDK `initialize`/`shutdown` round trip; a mock-backed ACP turn over the real `@agentclientprotocol/sdk`; a headless run whose **stdout is only the final text** and whose **stderr is only the `dsh: reasoning:` block**; `--version` not loading a project environment; a missing profile failing with the `dsh plugin … add` hint; `--from-default-profile` creating then replacing a profile and surviving a failed boot; the profile-lifecycle fixture (ready/settled/disposed markers); the hot-reload echo (a patch edit changes the value, deleting the patch reverts to the bundle default, and the **home** layer outranks the profile layer); bundle-list recomposition under the manifest lock; source-module replacement coordinated through `dsh-hmr`; the app's arguments reaching the app before its rows start; and the config-dump section (including the exact 35-row `sdk-minimal` tree).

### apps/cli/tests/plugin-compatibility.expected.e2e.ts
Compatibility acceptance against real pnpm. An incompatible plugin is refused **before installation** ("nothing was installed", the profile manifest unchanged, no `compatibility.json`); a package installed *outside* DSH is still refused at startup; the grant then permits install and boot; the exemption is its own metadata file and the dependency manifest is untouched; revoking it stops the plugin again.

### apps/cli/tests/optional-bundle-transitions.e2e.ts
Optional-bundle transition suite (350 lines). Boots the real Web tree with a scripted model and **enables and disables five bundles live** through the plugin manager, asserting: the default host catalog is only `working_directory`; the `minimal` preset's catalog is exactly `[shell, read_image, working_directory]`; the PTC preset's assembled SDK contains `session_trace`; the badge asset loads only while its bundle is selected; a real persistent terminal runs and closes; a real Ralph workflow spawns a fresh agent; the title provider switches between `session-title-first-prompt-llm` and `session-title-all-prompts-llm` and back; and all five compose as global tools across every preset.

### apps/cli/tests/agent-team-headless.e2e.ts
Agent-Teams e2e. Runs two teammates, a workflow child, dependent tasks, waiting and final aggregation, then asserts the *persisted* session logs: 4 `.jsonl` files, a `subagent/descriptor` with `mode: 'continuable', provider: 'spawn'`, 4 `team/member` edges, 2 peer messages, 2 completed tasks, and the tool names `wait_agent`, `team_task_list`, `list_agents`, `workflow`. Notably it asserts `team/message/queued` and `team/message/delivered` are **absent** — peer mail is delivered in-band, not through a queue.

### apps/cli/tests/headless-shutdown.e2e.ts
POSIX-only PTY driver (a Python `pty.fork` program embedded as a string). It writes Ctrl+C twice and asserts the process exits 130 — the second signal forces exit while the first is still draining. The `never-dispose` fixture is what makes the first signal block.

### apps/cli/tests/web-agent-shutdown.e2e.ts
SIGTERM regression (4 states: idle/running × cancel-first/not). Proves the agent's scope-owned cleanup runs during Web teardown: `abortHandled: 1`, the inbox's `next-step` and `next-turn` entries each spliced with `removedCount: 1`, and the `turn/end` reason is `aborted` with `parent` or `disposed` depending on the case.

### apps/cli/tests/web-auth.e2e.ts
Real Web authentication. The launch URL carries a 43-character token; a forged `Host: localhost:<port>` gets 401 `unauthorized`; the token exchange returns 303 with a `HttpOnly; SameSite=Strict` cookie (and **no** `Secure` on plain HTTP); the cookie is accepted on the correct authority; and after a **restart** the old cookie still works although the printed token changed. `.credentials.yaml` is asserted to be mode 0600.

### apps/cli/tests/web-browser-open.expected.e2e.ts
Assembled browser-handoff snapshot (4 cases). The default handoff opens the reachable page and reports `bootManifest: true` with **no** API key and **no** `DSH_HOME` in the opener's environment; a failed OS handoff prints the reason and points at the URL while the server keeps running; an inherited `SSH_CONNECTION` suppresses the browser but not the URL; and a project `.env` that sets `BROWSER` is **rejected before startup** with a message naming the file and the env var.

### apps/cli/tests/web-agent-presets.e2e.ts
The preset-composition suite (1070 lines) — the densest statement of the agent plane in this shard. Notable assertions: the global layer exposes **only** `working_directory`; the `standard` preset's tool table is asserted **exactly** (34 names) because "an omission is this design's quietest failure mode, since a row that registers into the wrong layer mounts cleanly and simply contributes nothing"; the `minimal` preset's system prompt is exactly `You are a helpful software engineer assistant.` and its tools are exactly `[bash, read_image, working_directory]`; PTC mode collapses the wire to `[run_code]` while the *registry* catalog is unchanged ("PTC mode collapses the presentation, not the capabilities"); a delegated child gets the parent's exact tool schemas; the subagent model allowlist is default-off and applies only to **new** sessions; the token meter must live on the **host** plane (the projection registry is process-wide, so a preset-side meter would leak into other sessions); and disposing an agent must never rewrite the shipped profile patch.

### apps/cli/tests/github-webhook-real.e2e.ts
Real end-to-end through the built CLI and a real model. A signed `pull_request`/`ready_for_review` delivery is posted to the webhook ingress; the test then asserts a Workspace-attached Session appears, that `session/list` shows it with the right cwd and `agentPreset: 'minimal'`, that the history carries the title, the `permission/preset` and a `user/message` whose `source.kind` is `webhook` with the provider, delivery id and rule id — and finally that the model's answer contains the marker.

### apps/cli/tests/dump-config-schema.expected.e2e.ts
The schema-dump acceptance (420 lines) and the strongest "inspection must not mutate" proof in the shard: every fixture module carries an `apply()` that writes `apply-ran` and throws, and the test asserts `apply-ran` **does not exist** after the dump. It also proves `!!js` is never evaluated (a `disabled: !!js (() => { throw … })()` row is dumped without running), that a class plugin's `Config` is projected, that an unknown plugin name gets `status: 'absent'` with `configRef: '#/$defs/unknownConfig'`, that a malformed row yields a positioned error **without discarding its healthy siblings**, and that a non-JSON annotation yields `status: 'partial'` and exit 1 while the schema stays usable.

### apps/cli/tests/expected/dump-config-schema.json
The 615-line golden JSON Schema for the acceptance fixture. It shows the whole projection contract in one document: `loaderExpression` as the inert `__jsExpr` marker, `entryMetadata` with the `disabled` union (boolean | null | expression) and a description that explicitly rejects the truthy values the Loader would coerce, `entryList`/`patchList`, `unknownConfig` as an empty schema whose `$comment` says "this is unknown configuration, not a prohibition on fields", `includeConfig`/`includePatch` with the "config is replaced wholesale, not deep-merged" rule, the `config0`/`config1` projections, and the `x-cordis` block with `profile`, `complete`, per-entry `path`/`id`/`name`/`status`/`configRef`, `diagnostics` and `patchSchema`.

### apps/cli/tests/expected/launcher-help.txt
The 32-line golden `--help` output, matched with `toMatchFileSnapshot`. It is the launcher-help half of a generated `docs/cli-help.md` that a `verify-cli-help` CI gate checks against the current CLI — so the help text cannot drift from the parser.

### apps/cli/tests/dsh-badge.expected.e2e.ts
The assembled skill-catalog snapshot. With the bundle off the catalog is `null` and the `skill` tool returns `Error: skill "dsh-badge" is unknown or no longer available`; with it on, the catalog carries the full `<system-reminder>` listing and the loaded `<skill_content>` body including the `<skill_resources>` base-directory block. The absolute asset path is normalised to `{{badgeAssetsPath}}` so the snapshot is machine-independent.

### apps/cli/tests/desktop-host.e2e.ts
Forks the *built* Desktop Host with stubbed `dsh`/`dsh-app-boot`/`dsh-home-paths` modules, then disconnects the parent IPC channel **before** the profile startup settles. Asserts the host still settles, exits 0 (or 1 on the fixture's boot failure), and never logs `ERR_IPC_CHANNEL_CLOSED` or an unhandled rejection. The stub also asserts the package-manager command shape the Host hands to the launcher (`node --expose-internals <pnpm.mjs>` with `ELECTRON_RUN_AS_NODE=1`).

### apps/cli/tests/fixtures/agent-shutdown.mjs
- **Purpose:** the fixture behind the Web SIGTERM regression — it proves that *scope-owned* cleanup runs while the Web profile tears down.
- **Key abstractions:** a `LlmAdapter` subclass whose `stream()` throws `"The cancelled request must not reach the adapter."` — so a request that reaches the adapter is itself a failure; an `AbortController` wired to `agent.cancel({ kind: 'parent' })`.
- **Data flow:** `apply()` registers the adapter on `ctx.llm`, waits for `appReady`, creates an agent with `provider: 'shutdown-fixture'`, and — when `config.running` — hooks `agent/request` to hold the turn until the abort fires. It queues one `next-step` and one `next-turn` message with `agent.send(..., false)`, then optionally cancels first.
- **Non-obvious design decisions:** the abort listener calls `agent.cancel({ kind: 'parent' })` **twice** (`agent-shutdown.mjs:44-48`) to prove the cancel handler is once-only rather than merely idempotent by accident; and on scope disposal it writes `{ abortHandled, status, nextStep, nextTurn, lastEvent, cancelled }` to a file (`agent-shutdown.mjs:49-61`) — the *world* evidence, not a log line.
- **Edge cases / failure handling:** Windows has no deliverable SIGTERM, so the fixture polls an arm file every 20 ms and `process.emit('SIGTERM')` itself (`agent-shutdown.mjs:26-33`), clearing the timer through `ctx.effect` so it cannot outlive the scope.
- **Surprising:** the fixture's own `console.log('agent-shutdown: ready')` is the readiness marker the test waits for; the turn is held open deliberately so the cancel arrives *while* a request is in flight.

### apps/cli/tests/fixtures/dsh-badge/cordis.yml
Ten-line overlay: inserts the `@deepseek-ai/dsh-skill-badge` row and disables `skill-filesystem`'s `watch` and the `session-telemetry-otel` row, so the skill-catalog snapshot is deterministic.

### apps/cli/tests/fixtures/dsh-badge/default.cordis.yml
Six-line baseline with the same two disables but **without** the badge insert — the pair (with/without) is what proves the badge bundle is the only difference between the two snapshots.

### apps/cli/tests/fixtures/dsh-badge/snapshot.ts
- **Purpose:** produce the assembled skill-catalog snapshot from a real tree.
- **Key abstractions:** the real `boot()` from `@deepseek-ai/dsh-app-boot`; `agentEvents(ctx, agent).waterfall('agent/pre-step', …)`; `unsupportedInbox()` from the agent-loop testkit.
- **Data flow:** it loads the *base bundle's* root config and patch by absolute path, loads the caller's overlay, and rewrites the badge row's `name` to its **resolved module URL** (`import.meta.resolve('@deepseek-ai/dsh-skill-badge')`) so the fixture works in a source checkout where the package is not installed. It then fabricates a minimal `Agent` whose `inject` **throws** ("must receive the catalog at the step boundary"), fires the real waterfall, and prints `{ catalog, summary, result }` as one JSON line.
- **Non-obvious design decisions:** the fixture is mounted as a *plugin* rather than a bespoke harness, so the catalog is produced by the same code path a live session uses.
- **Edge cases / failure handling:** `ctx.fiber.dispose()` runs in a `finally`, so a failed assertion still tears the tree down.
- **Surprising:** the badge row is renamed to a `file:` URL — a bundle row is resolved by package name at boot, and the snapshot needs a *file* it can actually import.

### apps/cli/tests/fixtures/github-webhook/cordis.yml
Thirty-six-line **real-product** overlay (its comment says the CLI, provider, Web servers, webhook runtime, adapter, rule, Workspace, Session and Agent all remain production modules). It inserts the webhook runtime, the rule (with `!!js` reads of `DSH_GITHUB_E2E_WORKSPACE` / `DSH_GITHUB_E2E_MARKER`), and a `cordis:group` with `isolate: { webServer: true }` holding the webserver and the GitHub adapter. The isolated group is the interesting part: the webhook ingress gets its **own** web server, separate from the app's.

### apps/cli/tests/fixtures/github-webhook/github-webhook-rule.mjs
- **Purpose:** a *real* webhook rule, not a stub.
- **Key abstractions:** `run(delivery, signal)` returning `null` for "not mine" or a `{ workspacePath, title, prompt, agentPreset, permissionPreset }` request; a Schemastery `Config` whose every field is `required()`.
- **Data flow:** the rule filters on the source, the event name (`pull_request`), the payload action (`ready_for_review`) and `payload.repository.full_name`; it then calls `signal.throwIfAborted()` and returns the workspace, a title, a prompt that asks for an exact marker, and the two preset names.
- **Non-obvious design decisions:** returning `null` rather than throwing is the rule contract — a rule that does not match must be a no-op, not an error — and the configuration is validated at *mount* time, not at first use.
- **Edge cases / failure handling:** the abort check happens *after* the filters and *before* the return, so a cancelled delivery never produces a request.
- **Surprising:** the returned request carries the *permission preset* as well as the agent preset, so the rule decides the child's authority, not just its persona.

### apps/cli/tests/fixtures/initialize-profile-from-default.ts
Eighteen-line child-process fixture: it writes a `ready` file, then polls for a `gate` file (up to a 30 s deadline) and finally calls `initializeProfileFromDefault(name, source, home)`. Two of these run concurrently, synchronised on the gate — which is how the profile-initialization spec creates a genuine replacement race rather than a simulated one.

### apps/cli/tests/fixtures/invalid-provider.cordis.yml
Seven-line overlay that overrides the optional `llm-pi-ai` row with a provider shape carrying a bogus `apiKey`; used to prove an optional provider's failure does not stop the run.

### apps/cli/tests/fixtures/memory-mcp-base.cordis.yml
Eight-line minimal tree: only the `system-prompt` and `tools` rows, both named `cordis:memory-test-*`, so the example MCP overlays can be loaded against the *source-built* builtins without prebuilt workspace artefacts.

### apps/cli/tests/fixtures/never-dispose.mjs
Nineteen-line plugin whose disposer announces itself on stderr and then `await new Promise(() => {})` — it never settles — but **only** when the arm file `DSH_TEST_SHUTDOWN_ARM_FILE` exists. The arm-file gate is what lets the same fixture be harmless in other suites. It also holds a `setInterval` keep-alive so the process cannot exit on its own before the disposer runs.

### apps/cli/tests/fixtures/source-tool-driver.ts
- **Purpose:** collect *source-lane* tool-dispatch evidence from the real agent and the real Node module cache.
- **Key abstractions:** `SourceToolEvidence` = `{ execArgv, modules, errors, events }`; the `modules` list is the **Node module cache** (`ctx.loader.internal.loadCache`) filtered to `/packages/core/(tools|agent-loop)/`.
- **Data flow:** it listens globally for `session/event` and `agent/error`, creates one mock-model agent, waits for idle, and prints `DSH_SOURCE_TOOL_RESULT {…}` on stdout.
- **Non-obvious design decisions:** the module-cache filter is the *whole* point — it is how the caller proves that no `lib/` copy was loaded alongside `src/`, without trusting the runtime's own bookkeeping.
- **Edge cases / failure handling:** the agent handle is disposed in a `finally`, and the exit code is `errors.length === 0 ? 0 : 1`.
- **Surprising:** the evidence is emitted on **stdout** as a prefixed line, so the parent test can parse it out of a stream that also carries ordinary output.

### apps/cli/tests/fixtures/web-browser-open/open.mjs
- **Purpose:** the stand-in for the OS `open` module, so the *production* browser-handoff path runs unmodified.
- **Key abstractions:** the real token exchange — GET with `redirect: 'manual'`, expecting **303** plus a `set-cookie` and a `location`, then a second request carrying the cookie.
- **Data flow:** it reports `{ url, status, bootManifest, apiKeyPresent, dshHomePresent }` — the assertion that the opener sees **no** API key and **no** `DSH_HOME` — and then spawns a detached probe that writes a marker only while the helper is still alive, so an early helper exit is detectable.
- **Non-obvious design decisions:** the failure path is a *thrown* error from `process.env.BROWSER_OPEN_TEST_FAILURE`, so the product's own error handling (not the fixture's) produces the user-visible message.
- **Edge cases / failure handling:** a non-303, a missing cookie or a missing location all raise a named error rather than a silent success.
- **Surprising:** the detached probe checks liveness with `process.kill(pid, 0)` on Windows — the one platform where that throws instead of returning.

### apps/cli/tests/fixtures/web-browser-open/register.mjs
A Node `registerHooks` resolver that short-circuits the `open` specifier to the fixture, plus two `console.log` / `console.error` interceptors that exit the process when the "ready" or "could not open" line appears. The `registerHooks` approach means the product's browser-handoff code path is exercised without changing it; the console interceptors are how the SSH case (which has no opener helper to stop) ends the long-lived Web process.

### apps/cli/tests/profiles/AGENTS.md
The house rule for the profile test tree: "Start product scenarios through `apps/cli/src/bin.ts` with `--profile <name>` or the `<name>` shorthand; a test-only Loader driver is allowed only when the public profile output cannot expose the asserted internal evidence." Also: keep a composition here only when the CLI profile assembly is the subject; package-specific loader configs belong in that package's `tests/fixtures/`; and `config/examples/` is a **product asset**, not a test fixture.

### apps/cli/tests/profiles/headless/credentials-snapshot.patch.yml
Thirty-two-line overlay: disables `headless-startup`, `headless-runner`, `llm-deepseek` and `llm-deepseek-account`, points `agent-loop` at `deepseek-official` / `deepseek-v4-flash`, and inserts `@deepseek-ai/dsh-llm-deepseek-api-key` with `baseURL: 'http://127.0.0.1:9'` — a route that registers the production adapter but can never reach its endpoint, which is how the missing-credential guidance is exercised without a request leaving the machine.

### apps/cli/tests/profiles/headless/goal-snapshot.patch.yml
Thirty-three-line overlay: the same three disables, then inserts `@deepseek-ai/dsh-llm-replay` for the `deepseek-official` provider and turns off `session-log-deepseek` — the replay adapter replaces the network entirely, so the goal-tool snapshot is deterministic.

### apps/cli/tests/profiles/headless/real-model.patch.yml
Thirty-two-line overlay: `llm-deepseek` is kept but configured with `thinking: enabled` and `reasoningEffort: max`, and both models advertise `contextWindow: 128000` / `maxTokens: 8192`. Its persistence compression is `!!js "process.env.DSH_SNAPSHOT === undefined ? 'zstd' : 'none'"` — an *expression*, so the same overlay produces a zstd log in production and a readable one in a snapshot.

### apps/cli/tests/profiles/headless/retry-snapshot.patch.yml
Twenty-six-line overlay inserting `./tests/fixtures/retry-snapshot-backend.mjs` over the shipped headless profile, so the provider failure is a deterministic in-process `LlmError` rather than a network accident.

### apps/cli/tests/profiles/headless/semantic-checkpoint-snapshot.patch.yml
Twenty-nine-line overlay: disables the product runner and the DeepSeek row, inserts the replay adapter with `file` / `overrideFile` read from `DSH_SNAPSHOT_FILE` / `DSH_SNAPSHOT_OVERRIDE`, and inserts the `resumed-agent` fixture whose comment says "Publish the persisted agent before the driver selects the single root" — the ordering the resume test depends on.

### apps/cli/tests/profiles/headless/subagent-diagnostic-snapshot.patch.yml
Thirty-two-line overlay: it also disables `session-query-sqlite` and inserts `./tests/fixtures/subagent-diagnostic-query.ts` (a `SessionQueryEngine` whose *search* methods reject) so the cold-child discovery path is forced through the exact-read route and cannot accidentally succeed via an index.

### apps/cli/tests/profiles/headless/subagent-inheritance-snapshot.patch.yml
Forty-one-line overlay: forces `sandbox-policy` to `mode: workspace-write` with `workspaceRoot: !!js process.cwd()`, sets `tool-subagent` to `provider: spawn` with `maxDepth: 1`, and inserts the replay adapter, the settlement barrier and the `resumed-agent` fixture. Its header comment states the point — "The profile's workspace-write deployment default must lose to the session override in its child."

### apps/cli/tests/profiles/headless/subagent-settlement-snapshot.patch.yml
Thirty-seven-line overlay: inserts the replay adapter for `deepseek-official` and the `settlement-fence` fixture, with the comment "Hold the parent's second step until the manager notice enters its inbox" — the fence that makes the settlement ordering observable rather than racy.

### apps/cli/tests/profiles/headless/team-snapshot.patch.yml
Fifty-five-line overlay: disables all five direct subagent tools (`tool-subagent-control`, `-list-agents`, `-report`, `tool-subagent`, `tool-subagent-fork`) and inserts the experimental Agent Teams bundle with `maxMembers: 8`, `maxTasks: 256`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`, plus the tool bundle (`freshProvider: spawn`, `forkProvider: fork`) and the deterministic `team-llm.mjs` adapter.

### apps/cli/tests/profiles/headless/workspace-context-resume-snapshot.patch.yml
Thirty-three-line overlay: raises `agent-instructions` to `maxBytes: 65536`, inserts the replay adapter with the same env-driven `file` / `overrideFile`, and inserts the `resumed-agent` fixture for the workspace-instruction session.

### apps/cli/tests/profiles/headless/tests/harness.ts
The shared harness for the key-gated e2es: the real agent loop, the real DeepSeek adapter, the real `LocalBashExecutor`, the real `tool-bash` and `tool-todo`, and — opt-in — the token meter, tool-result pruner, `BasicCompactionEngine` and JSONL persistence. It also fixes the persona prompts (`SYSTEM_PROMPT`, `TODO_SYSTEM_PROMPT`) and provides `waitForIdle(ctx, agent)` and `finalText(events)`.

### apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts
The 1211-line snapshot suite for the product headless profile. It covers: the text mode (stdout is only the final text; stderr is only the `dsh: reasoning:` block) and the `--json` mode (a `session` record, then `thinking`/`tool_call`/`tool_result`, then a `final` record); `--session-id` for an unknown session failing with a usable message; two `--session-id` wakes resuming the same persisted session; a terminal model failure printed through the product command; an unrelated activation error warning without failing the run; a provider retry recorded as a single `llm/retry` event carrying a **policy key** (`["normal",1,["RATE_LIMIT"],1,1,0]`), the retry number, the max, the delay and the failure; missing-credential and invalid-credential guidance (the invalid one must not echo the key or the transport symptom); the reasoning-effort ladder; the native DeepSeek defaults (two `/v1/messages` requests, `max_tokens: 256000`, `output_config: { effort: 'low' }`, and a title request capped at 4096); a compatibility stream kept open until the title request arrives; the pi-ai DeepSeek and Kimi routes; a keyless Agent Team run; the goal tools; and a continuable child settling **without polling**.

### apps/cli/tests/profiles/headless/tests/profile-resolution.ts
The module-resolution proof (313 lines). It builds an `installed` and an `npm-link` dependency graph with deliberately *conflicting* versions at each level, then asserts that the resolved leaf is the expected version, that the ESM and CJS identities are the *same object*, that the profile-installed external beats the ancestor one, that the `Tools` class is the **same instance** for the profile, the plugin and the source package (via the `TOOL_RUNTIME_SCHEDULER` symbol), that the managed-resolution table does **not** contain the external package, and that only `src/index.ts` (or only `lib/index.js`) is loaded — never both.

### apps/cli/tests/profiles/headless/tests/ptc.e2e.ts
The PTC suite (412 lines). Keyless half: a 100 KB value crosses the boundary intact; a failing tool exposes only `name`/`toolName`/`message` and **not** `code`/`content`/`info`; a background bash returns a `bash-<16 hex>` job id that can be polled to completion; a pre-abort spawns nothing while a post-publication abort leaves `job_kill` as the cancellation owner; a foreground bash is coupled to the outer signal; and PTC can call back into the runtime's own inspection providers. Keyed half: the wire tool list is **exactly** `[run_code]`, every request header agrees, and each inner call is recorded as a `tool/ptc-dispatch` whose `parentCallId` matches the outer call.

### apps/cli/tests/profiles/headless/tests/compaction.e2e.ts
Key-gated compaction smoke. The harness advertises a 15 000-token window with a 7 000-token output cap, leaving an 8 000-token message budget; four large file reads force the compaction. It asserts the `compaction/start`/`compaction/end` brackets are balanced, a `compaction/summary` exists, a `user/message` carries a `surfaceOp` (the surface mutation), the summary's `shadowedSeqs` names the real `tool/result` events, and the final answer still recalls the file count and the number in file1.

### apps/cli/tests/profiles/headless/tests/credentials.e2e.ts
The credential-precedence spec (203 lines). A local Messages server records the `x-api-key` it received. The matrix proves: the launch environment wins over everything; the project's `.env` wins over the home `.env`; the home `.env` wins over the saved store; an *absent* key produces `MISSING_CREDENTIAL` and **no request at all**; an *empty* key is treated as absent; an *invalid stored document* does not crash the run; and restoring the stored credentials works. A second block proves the pi-ai route uses the launch credentials for both a named reference and native discovery.

### apps/cli/tests/profiles/headless/tests/session-format-guard.expected.e2e.ts
The session-format lifecycle spec. A v0 log **migrates before resume without changing its source** (the source file's bytes and its `dev`/`ino` are identical afterwards; the successor is a different inode, and the directory holds exactly `session.jsonl`, `session.lock` and the new generation file). A newer format is refused with the upgrade direction and the raw log path. A v2 log with an unclassified message content kind is refused ("cannot safely transform unclassified message content kind") and the source artifact is left unchanged. An unknown required event type is refused: "refusing to interpret the log — it was likely written by a newer harness".

### apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts
The delegation-confinement snapshot. The parent is seeded `read-only`; the deployment default is `workspace-write`. The child's log shows `sandbox/mode: { mode: 'read-only', source: 'delegation' }` and `approval/policy: { policy: 'never', source: 'delegation' }` **before** the child's `turn/start` — the fence is armed before the child can do anything — and the child's real write **never reached the disk** (`ENOENT`). The runtime-context sections injected into both sessions say the policy applies to "Any available operation enforced by the DSH file sandbox" and, importantly, "Do not refuse a required modification from this policy alone".

### apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts
The cold-child discovery snapshot. The parent owns a `subagent/catalog` event for a child whose own log has **no descriptor**; the parent's model-visible list shows the child as `descriptorless child` and **not** as `[diagnostic: corrupt]`, because discovery reads the parent catalog and never opens the child's log.

### apps/cli/tests/profiles/headless/tests/workspace-context-resume.expected.e2e.ts
The workspace-instruction resume snapshot. The seeded baseline carries a `baselineIdentity` (project root, root markers, byte budgets, candidate file names) and a per-file `changes` list with a sha1 digest. After an offline edit the resume appends **one** replacement and does **not** duplicate the baseline. When the candidate *precedence* changed offline (CLAUDE.md before AGENTS.md), the earlier baseline is **superseded** rather than appended to, and the new baseline says it "replaces all earlier workspace instruction baselines".

### apps/cli/tests/profiles/headless/tests/semantic-checkpoint.expected.e2e.ts
The semantic-checkpoint snapshot. A session is seeded with a `tool/call` and **no** `tool/result`. On resume the harness synthesises one: `ToolOutcomeUnknownError` / `TOOL_OUTCOME_UNKNOWN`, with the text "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly." The model's scripted answer is to verify external state first.

### apps/cli/tests/profiles/headless/tests/fixtures/cli.patch.yml
Thirty-seven-line keyless overlay: the mock `cli-mock` provider, `shell-env` and `skill-filesystem` pointed at `./.dsh-home` / `./.agents-home` (so nothing touches the real home), `agent-instructions` disabled, JSONL sessions under `./.sessions`, and the shared `cli-mock-llm` fixture inserted.

### apps/cli/tests/profiles/headless/tests/fixtures/deepseek-defaults.patch.yml
Twenty-nine-line overlay: `llm-deepseek` is pointed at `!!js process.env.DSH_SNAPSHOT_BASE_URL` with `thinking: enabled`, `reasoningEffort: low` and a **150 ms** `streamIdleTimeoutMs` — the short idle timeout is what makes the native-defaults assertions cheap.

### apps/cli/tests/profiles/headless/tests/fixtures/headless-profile.patch.yml
Nine-line product-profile patch: it swaps `agent-default-model` to the keyless `cli-mock` route and inserts the `cli-mock-llm` fixture. It is the *only* overlay that does not disable the product runner, because the keyless smoke asserts the product profile's own composition.

### apps/cli/tests/profiles/headless/tests/fixtures/pi-ai-conversation-updates.patch.yml
Thirty-six-line overlay: it routes to the pi-ai `moonshotai` provider with `apiKeyEnv: MOONSHOT_API_KEY` and `streamIdleTimeoutMs: 1000`, disables `session-title-llm` (the comment explains why: "The fixture counts every model request, so title generation stays off"), and inserts the dynamic tool-prompt-update fixture.

### apps/cli/tests/profiles/headless/tests/fixtures/pi-ai-defaults.patch.yml
Thirty-seven-line overlay: the pi-ai `deepseek` route with `modelOverrides: { deepseek-flash: { maxTokens: 1024 } }` and `streamIdleTimeoutMs: 1000` — the override is how the snapshot pins the *model-specific* token cap rather than the provider default.

### apps/cli/tests/profiles/headless/tests/fixtures/retry-snapshot-backend.mjs
- **Purpose:** a deterministic provider that fails once and then succeeds.
- **Key abstractions:** a `LlmAdapter` subclass with an explicit `resolveRetryPolicy({ mode: 'normal', maxRetries: 1, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'retry-snapshot-backend.retryPolicy')` — the policy is *declared by the fixture*, not inferred by the test.
- **Data flow:** the first request throws `new LlmError('snapshot transient failure', 'RATE_LIMIT', { status: 429 })`; the second compares its own `JSON.stringify(options.messages)` with the first and throws `'retry snapshot changed the model-visible messages'` if they differ (`retry-snapshot-backend.mjs:30-32`); the third yields the text `RETRY_OK` with a fixed usage.
- **Non-obvious design decisions:** the policy is exported through `providerRetryPolicy()` so the *runtime* — not the fixture — decides to retry, and the zero-jitter 1 ms backoff makes the test fast without changing the policy's shape.
- **Edge cases / failure handling:** a retry that mutates the conversation fails the test loudly, which is the whole point.
- **Surprising:** `retryableCodes: ['RATE_LIMIT']` is a *code*, not an HTTP status; the 429 is carried alongside it.

### apps/cli/tests/profiles/headless/tests/fixtures/semantic-checkpoint-agent.ts
Twenty-five-line loader fixture that resumes the seeded session `semantic-checkpoint-unknown-outcome` through `ctx.agents.resume(...)` and binds the handle to the plugin's lifetime with `ctx.effect(() => () => handle.dispose(), …)`. Resuming *before* the CLI's own dispatch is what makes the seeded tool call the first thing the runtime sees.

### apps/cli/tests/profiles/headless/tests/fixtures/startup-activation-error/activation-error.mjs
Six-line plugin whose `apply()` throws an `Error` whose `.stack` is **overwritten** with a fixed string ("at activation-error-fixture"), so the startup diagnostic is snapshot-stable across machines and Node versions.

### apps/cli/tests/profiles/headless/tests/fixtures/startup-activation-error/activation-error.patch.yml
Four-line overlay inserting the `activation-error` plugin into the shipped headless profile — the unrelated failure the best-effort startup must survive.

### apps/cli/tests/profiles/headless/tests/fixtures/subagent-diagnostic-agent.ts
Twenty-six-line loader fixture that resumes the seeded parent session `subagent-diagnostic-parent` before CLI dispatch, so `list_agents` runs against a pre-seeded **cold** child.

### apps/cli/tests/profiles/headless/tests/fixtures/subagent-diagnostic-query.ts
Fourteen-line `SessionQueryEngine` subclass whose `searchSessions()` and `searchEvents()` both reject ("session search is unavailable in this fixture"). Only the *search* path is broken; the inherited corpus and observation reads stay real, which is what isolates the exact-read route.

### apps/cli/tests/profiles/headless/tests/fixtures/subagent-inheritance-agent.ts
Twenty-five-line loader fixture resuming the seeded read-only parent `subagent-inheritance-parent` before CLI dispatch, so the delegation happens inside the seeded session rather than a fresh one.

### apps/cli/tests/profiles/headless/tests/fixtures/subagent-settlement-fence.ts
- **Purpose:** hold the parent's second step until the child's settlement notice is admitted, so the *content order* of the transcript is deterministic.
- **Key abstractions:** two root listeners — `agent/inbox/inserted` (which resolves a promise when a `source.kind === 'subagent-settled'` message arrives for a *root* agent) and `agent/pre-step` (which awaits that promise for turn 1, step 2).
- **Data flow:** the fence ignores any message whose agent has a `parentSession` (that is the child's own mail, not the notice), and ignores any source kind other than `subagent-settled`.
- **Non-obvious design decisions:** the docstring states the reason explicitly (`subagent-settlement-fence.ts:16-19`): "This pins content order, not step placement: the held pre-step runs after its own `Inbox.claim()`, so the notice lands after step 2's claim and is claimed at step 3 because the child's settlement pipeline is strictly longer than the parent's claim path, not because a barrier forces it." The fence is deliberately *not* a hard barrier.
- **Edge cases / failure handling:** both listeners are disposed in the effect's cleanup, so the fence cannot outlive the plugin.
- **Surprising:** the fence is registered on `ctx.root` and filters by `parentSession` — a child-side event with the same `source.kind` would otherwise satisfy it.

### apps/cli/tests/profiles/headless/tests/fixtures/team-llm.mjs
- **Purpose:** a deterministic, keyless Agent-Teams adapter that scripts three roles.
- **Key abstractions:** three pure functions — `researcher(messages)`, `implementer(messages)` and `lead(messages)` — that read the conversation's tool-call names and return a scripted chunk list; plus the helpers `calls`, `latestAssistantCalls`, `hasTaskAction` and `latestToolText`.
- **Data flow:** the adapter chooses its role from the **runtime-context** section named `team:identity` ("You are teammate \"researcher\"." and so on), which is why the identity has to be carried in the prompt rather than in a config field.
- **Non-obvious design decisions:** the adapter *asserts* the composition rather than assuming it: if the tool list contains `subagent` or `subagent_fork` it throws "Team profile exposes a direct subagent tool" (`team-llm.mjs:182-184`), and if `spawn_teammate` or `workflow` is missing it throws "Team profile is missing teammate or workflow tools" (`team-llm.mjs:189-191`).
- **Edge cases / failure handling:** every yielded chunk passes through `options.signal?.throwIfAborted()`, so a cancelled turn stops the script.
- **Surprising:** the lead role spawns a *workflow* child first (`'return await agent("TEAM_WORKFLOW_CHILD");'`) and only then the two teammates, so one run exercises delegation, a dependency (`blocked_by: ['task-1']`), peer mail and final aggregation.

### apps/cli/tests/profiles/headless/tests/fixtures/workspace-context-resume-agent.ts
Twenty-five-line loader fixture resuming the seeded `workspace-context-resume` session before CLI dispatch.

### apps/cli/tests/profiles/headless/tests/expected/goal-tools/input.json
Ten-line scenario script with one `prompt` step: "Probe strict-schema fillers against missing-goal revision 1, then create a durable goal to finish the snapshot proof and inspect it." The first half of the sentence names the *negative* case the scripted model then exercises.

### apps/cli/tests/profiles/headless/tests/expected/goal-tools/replay.override.json
Fifty-two-line scripted response in five turns: an `update_goal` call against a **missing** goal id at revision 1 (the strict-schema probe), a text reply, a `create_goal` with `max_goal_rounds: 7`, a `get_goal`, and finally the `GOAL READY` text. Each turn carries a fixed `usage` and a `finish` reason, so the golden is byte-stable.

### apps/cli/tests/profiles/headless/tests/expected/goal-tools/stream-json.expected.jsonl
Thirty-two-line golden stream in the `--json` mode: the `agent/inbox/spliced` that carries the user turn, `turn/start`, the inbox splice that *removes* the message (`removedCount: 1`), `step/start`, the request header, the three goal tool calls and their results, and finally a `result` record with `output: "GOAL READY"` and its usage.

### apps/cli/tests/profiles/headless/tests/expected/headless-profile/reasoning.stderr.expected.txt
Two-line golden stderr: the `dsh: reasoning:` heading and the single reasoning line the mock model produced.

### apps/cli/tests/profiles/headless/tests/expected/headless-profile/session.expected.jsonl
- **Purpose:** the canonical example of the persisted session format — 26 lines, one JSON object per line.
- **Key abstractions:** the `session` header (version 4) with `{{sessionId}}` / `{{cwd}}` placeholders; the three policy events (`permission/preset`, `sandbox/mode`, `approval/policy`); the `request/header` event carrying `config`, `adapterDefaults` and the tool list; the `request/context` event; the `session/title` and `session/title-llm-request` pair.
- **Data flow:** the order is permission → sandbox → approval → inbox splice → turn → step → system message → user message → runtime-context message → request header → title → assistant message → tool call → job registered → job settled → tool result → step end → second step → request header ("change") → assistant message → turn end.
- **Non-obvious design decisions:** the `runtime-context` user message is a **structured** message — `source.kind: 'runtime-context'`, `form: 'snapshot'`, and a `sections` array naming `working-directory:current`, `sandbox:policy` and `approval:policy` (`headless-profile/session.expected.jsonl:11`) — so a consumer can read the policy without parsing the prose.
- **Edge cases / failure handling:** the `request/header` event's `reason` is `"initial"` for the first request and `"change"` for the second, which is how a reader knows the tool list or the config moved.
- **Surprising:** the title comes from a **fallback** provider (`source: { kind: 'fallback' }`) and a separate `session/title-llm-request` event records the LLM attempt with `maxTokens: 4096` and `reasoningEffort: 'off'` — the title request is a first-class, inspectable request, not a hidden side channel.

### apps/cli/tests/profiles/headless/tests/expected/headless-profile/stderr.expected.txt
One-line golden stderr for the mock provider's failure: `dsh: SERVER: CLI mock provider failed`.

### apps/cli/tests/profiles/headless/tests/expected/invalid-credential/stream-json.expected.jsonl
Fifteen-line golden stream for a key that *exists* but cannot be carried in an HTTP header: the turn ends with `reason: { kind: 'error', error: { message: 'llm-deepseek: the API key resolved from DEEPSEEK_API_KEY contains characters no HTTP header can carry; set DEEPSEEK_API_KEY to the raw key alone (the web Models page writes it)', code: 'INVALID_CREDENTIAL' } }` and the `result` record has an **empty** output.

### apps/cli/tests/profiles/headless/tests/expected/mcp-pagination/stderr-cause.txt
One-line golden cause: `SdkError: tools/list: exceeded listMaxPages (64); server pagination did not terminate` — the exact line the MCP pagination test extracts from stderr and matches.

### apps/cli/tests/profiles/headless/tests/expected/missing-credential/stream-json.expected.jsonl
Fifteen-line golden stream for an absent credential: the turn ends with `code: 'MISSING_CREDENTIAL'` and a message naming both remedies ("store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment"), and the `result` output is empty.

### apps/cli/tests/profiles/headless/tests/expected/provider-retry/input.json
Eight-line scenario script with one `prompt` step: "retry the transient provider failure".

### apps/cli/tests/profiles/headless/tests/expected/provider-retry/stream-json.expected.jsonl
Eighteen-line golden stream: the inbox splice, the turn, the step, the request header, the `llm/retry` event (which carries the provider, the mode, the **policy key** `["normal",1,["RATE_LIMIT"],1,1,0]`, the retry number, the max, the delay and the failure), the successful assistant message, and a `result` record with `output: "RETRY_OK"`.

### apps/cli/tests/profiles/headless/tests/expected/semantic-checkpoint/replay.jsonl
One-line v0 session placeholder (`{"type":"session","version":0,"id":"semantic-checkpoint-replay",…}`) — the replay adapter's "the primary fixture path must exist" guard.

### apps/cli/tests/profiles/headless/tests/expected/semantic-checkpoint/replay.override.json
Eleven-line scripted reply: "I will verify the external state before deciding whether to retry the side-effecting operation." The model's answer is part of the fixture, because the *behaviour under test* is what it does with the synthesized unknown-outcome tool result.

### apps/cli/tests/profiles/headless/tests/expected/semantic-checkpoint/session.expected.jsonl
- **Purpose:** the golden for a session that was seeded with a `tool/call` and **no** `tool/result`.
- **Key abstractions:** the synthesized `tool/result` at line 8, whose message id is `interrupted-tool-result-unknown-outcome-call-6`.
- **Data flow:** the log opens with the session header, a turn and a step, then the synthesized result appears *before* the model's second turn — and that turn answers by verifying external state.
- **Non-obvious design decisions:** the synthesized result is a **tool result with `isError: true`**, not a system message — the model sees a failed tool call it can reason about, and the transcript stays uniform.
- **Edge cases / failure handling:** the error text names the ambiguity and gives a *decision rule* — retry only if the operation is read-only or idempotent, otherwise verify external state or ask the user, and "Do not retry blindly."
- **Surprising:** the golden asserts the model's *reasoning*, not just its output: the point of the fixture is that the model chooses verification over a blind retry.

### apps/cli/tests/profiles/headless/tests/expected/startup-activation-error/stderr.expected.txt
Five-line golden stderr: the best-effort warning (`dsh: warning: 1 entry did not activate`), the failing plugin with its name and the **fixed** stack, and then the `dsh: reasoning:` heading — i.e. an unrelated activation failure does not stop the run.

### apps/cli/tests/profiles/headless/tests/expected/subagent-diagnostic/parent.expected.jsonl
Thirty-line golden parent session. Its point is the `subagent/catalog` event: the parent knows a child exists, but the child's own log has **no descriptor**, and the parent still renders it as a descriptor-less child rather than a corrupt one.

### apps/cli/tests/profiles/headless/tests/expected/subagent-diagnostic/replay.override.json
One-line scripted pair: a `list_agents` tool call, then the answer "The catalogued subagent is ready. PARENT_DONE".

### apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.expected.jsonl
- **Purpose:** the golden for a delegated child whose permissions are *narrower* than the deployment default.
- **Key abstractions:** the `subagent/descriptor` (version 3, `mode: 'continuable'`, `provider: 'spawn'`), the two policy events with `source: 'delegation'`, and the runtime-context message.
- **Data flow:** the descriptor and the `sandbox/mode` / `approval/policy` events are written **before** `turn/start` (`subagent-inheritance/child.expected.jsonl:2-6`) — the fence is armed before the child can act. The child's `write` call is then denied with `FS_SANDBOX_DENIED`, and the model answers `CHILD_DENIED [sandbox: file access denied under read-only mode]`.
- **Non-obvious design decisions:** the runtime-context text says "Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns" — a denial is scoped, not a blanket refusal, and the denial message itself offers the escalation path.
- **Edge cases / failure handling:** the denial is a **tool result** with `isError: true` and a structured `error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' }`, so the model can distinguish "denied" from "broken".
- **Surprising:** the inbox carries a second text block that tells the child to `send_message` to the parent and explains that "The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning" — the delegation contract is stated in the prompt, not assumed.

### apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.replay.jsonl
Eighteen-line v0-format child replay: the session header with `delegationDepth: 1`, a `turn/start` with a trigger, the user message, a `write` tool call to `inherited.txt` streamed as three `assistant/chunk` events, then the denial text and `turn/end`. This is the *seed* the resume path reads.

### apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.replay.v3.jsonl
Thirteen-line v3-format child replay — the *released* format, replayed through the v3→v4 migration. It shows the v3 vocabulary: `system/message` and `user/message` with `surfaceOp: 'append'`, an `assistant/message` carrying a `stream` array with the chunk kinds (`chunk`, `tool-call-chunks`, `text-chunks`), and a `tool/result` with `sourceEventSeqs`. The same child, written in the old format — this file is the migration fixture.

### apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/parent.expected.jsonl
Thirty-five-line golden parent session: the read-only sandbox mode and never-approve policy, the `subagent` delegation call, the child's denial, and the parent's own closing message. It is the parent's half of the inheritance proof.

### apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/replay.override.json
One-line scripted pair: the `subagent` call whose prompt tells the child exactly what to attempt and how to answer ("reply with the single word CHILD_DENIED and the denial marker line; do not retry and do not request escalation"), then the parent's "The delegated child was denied by the sandbox. PARENT_DONE".

### apps/cli/tests/profiles/headless/tests/expected/subagent-settlement/child.expected.jsonl
Seventeen-line golden child session: the descriptor (`mode: 'continuable'`, `provider: 'spawn'`), the delegated `workspace-write` sandbox and `never` approval, the parent's id in the prompt, the runtime context with the delegation-depth sections, and the single `CHILD_RESULT` text answer. The child never calls `send_message` — the settlement path is the parent's business.

### apps/cli/tests/profiles/headless/tests/expected/subagent-settlement/child.replay.jsonl
Eight-line v0 child replay: the session header with `delegationDepth: 1`, a turn, a step, and four `assistant/chunk` events that spell out `CHILD_RESULT`.

### apps/cli/tests/profiles/headless/tests/expected/subagent-settlement/parent.override.json
Forty-two-line scripted parent response in four turns: the `subagent` call ("Reply with exactly CHILD_RESULT and nothing else. Do not call send_message."), a "Subagent settlement" text, a "STARTED" text, and finally "PARENT_RECEIVED_SETTLEMENT_NOTICE" — the last one is only possible if the notice was *pushed* into the parent's inbox.

### apps/cli/tests/profiles/headless/tests/expected/subagent-settlement/parent.replay.jsonl
One-line v0 session placeholder for the settlement scenario.

### apps/cli/tests/profiles/headless/tests/expected/subagent-settlement/stream-json.expected.jsonl
Twenty-eight-line golden stream: the user's turn, the turn and the step, the `subagent` call, the child result, and then the `agent/inbox/spliced` carrying the settlement notice — whose `source.kind` is `subagent-settled` — followed by the parent's acknowledgement and a `result` record with `output: "PARENT_RECEIVED_SETTLEMENT_NOTICE"`.

### apps/cli/tests/profiles/headless/tests/expected/workspace-context-resume/offline-edit/replay.jsonl
One-line v0 session placeholder for the workspace-resume scenario.

### apps/cli/tests/profiles/headless/tests/expected/workspace-context-resume/offline-edit/replay.override.json
Eleven-line scripted reply: the single word `RESUME_DONE`.

### apps/cli/tests/profiles/headless/tests/expected/workspace-context-resume/offline-edit/session.expected.jsonl
Twenty-six-line golden session. Its substance is the `runtime-context` message: the seeded baseline carries a `baselineIdentity` (project root, root markers, byte budgets, candidate file names) and a per-file `changes` list with a sha1 digest; after an offline edit the resume appends **one** replacement and does not duplicate the baseline.

### apps/cli/tests/profiles/headless/tests/expected/workspace-context-resume/precedence-change/session.expected.jsonl
Twenty-six-line golden session for the *other* offline change: the candidate precedence changed (CLAUDE.md before AGENTS.md), so the earlier baseline is **superseded** rather than appended to, and the new baseline says it "replaces all earlier workspace instruction baselines".

### apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts
The keyless headless smoke. It boots the **real** Loader tree, runs the **production** shell tool, and reads the persisted `.jsonl.zstd` session: the magic bytes `28b52ffd` (zstd), no torn frame, a `request/header` whose `tools` list contains `read`, `write`, `edit`, `web_fetch`, `web_search` and **not** `str_replace_editor`, and a `result` record whose `usage` carries `inputTokens`, `outputTokens`, `cacheReadTokens` and `reasoningTokens`.

### apps/cli/tests/profiles/headless/tests/coding-task.e2e.ts
- **Purpose:** the swebench-style smoke — a real model fixes a real bug in a temp directory using only the bash tool.
- **Key abstractions:** `TEST_FILE` and `BUGGY_ADD` as inline source arrays; `codingHarness(workdir, { personaPrefix: SYSTEM_PROMPT })`; `waitForIdle(ctx, agent)` and `finalText(events)`.
- **Data flow:** the fixture is confirmed **broken before the agent runs** (`spawnSync('node', ['add.test.js'])` must fail), then the agent is asked to fix `add.js` and *not* to modify `add.test.js`.
- **Non-obvious design decisions:** the assertion that the test file is **byte-identical** afterwards (`coding-task.e2e.ts:76-77`) — the comment says "an agent that neutered the test instead of fixing the bug fails here, not just on a keyword probe" — and the assertion is repeated by *re-running the test outside the agent* (`coding-task.e2e.ts:79-81`). A keyword probe on the model's answer would catch neither.
- **Edge cases / failure handling:** the `afterEach` disposes the harness "even on failure/retry: agent-loop teardown stops the loop and LocalBashExecutor teardown kills anything the model left running", and removes the temp directory.
- **Surprising:** the final check is not just "the test passes" but `expect(fixed).not.toMatch(/a\s*-\s*b/)` — the *shape* of the bug must be gone, so a fix that hard-codes the two asserted cases would still fail.

### apps/cli/tests/profiles/headless/tests/full-loop.e2e.ts
Forty-nine-line canary — the cheapest place a real model meets the real bash tool. It asks for `echo e2e-ok`, then asserts three separate things: a `tool/call` for `bash` exists, a `tool/result` contains `e2e-ok`, and the final text contains it too. The world, the tool result and the narration are three different claims, and all three are checked.

### apps/cli/tests/profiles/headless/tests/real-model.e2e.ts
Thirty-three-line test built on the shared `runLoaderSmoke` driver: it writes `task.txt` with `value=before\n`, asks the model to replace its contents with exactly `value=after\n`, and then reads the file **outside** the agent (`inspect: async (cwd) => { verified = await readFile(join(cwd, 'task.txt'), 'utf8') }`) and asserts the exact bytes. The assertion is on a file the model had to edit, not on its sentence.

### apps/cli/tests/profiles/headless/tests/resume.e2e.ts
- **Purpose:** prove durable conversation continuity across processes.
- **Key abstractions:** `SECRET = 'plum-galaxy-1791'` and a fixed `SESSION_ID`; two separate `codingHarness` instances over the same `persistenceRoot`.
- **Data flow:** run 1 tells the real model a code and disposes the whole context (so only the JSONL log survives); run 2 creates a **new** context, `ctx.agents.resume({ resumeSessionId: SESSION_ID })`, asserts the rehydrated messages already contain the secret, then asks the model to recall it.
- **Non-obvious design decisions:** the test asserts the secret is in `resumed.session.deriveMessages()` **before** the model is asked (`resume.e2e.ts:60`) — the recall must come from the rehydrated log, not from the model's memory of the previous run.
- **Edge cases / failure handling:** the `afterEach` disposes the context "even on failure/retry: … the JSONL backend flushes" and then removes the sessions root.
- **Surprising:** the disposal is the mechanism under test — the harness is thrown away entirely between the two runs, so nothing but the file can carry the fact.

### apps/cli/tests/profiles/headless/tests/todo-write.e2e.ts
Fifty-eight-line test that a *real* model drives the real `todo_write` tool. It asserts two separate things: that a `tool/call` for `todo_write` happened, and that a durable `todo/write` event exists whose `todos` array is **exactly** the three requested items — including the two that are simultaneously `in_progress` (`todo-write.e2e.ts:52-56`). The parallel contract is therefore asserted in the *world*, not in the model's prose.

### apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts
- **Purpose:** prove that a source-lane tool call reaches `tool/result` through exactly one `Tools` instance.
- **Key abstractions:** `SourceToolEvidence` imported from the fixture; the patch is written as **JSON** (not YAML) so it can be generated at run time; `clearedProxyEnv()` from the HTTP proxy package.
- **Data flow:** the test writes a temp patch that inserts the mock provider and the `source-tool-driver` fixture, launches `node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch <patch>` with `DSH_TOOLS_MODE: 'native'`, and parses the `DSH_SOURCE_TOOL_RESULT` line.
- **Non-obvious design decisions:** the assertion **tolerates** an explicit `SandboxUnavailableError` (`source-tool.built.e2e.ts:91-93`) — the header comment says the subject is "that a source-profile tool call reaches tool/result through one Tools instance, not that the host can confine the shell", and that `keyless-smoke.e2e.ts` in the same gate owns the confinement round trip and "stays strict". Two suites, two different claims.
- **Edge cases / failure handling:** the tool call's name is asserted per platform (`pwsh` on Windows, `bash` elsewhere) — the *capability* is asserted, not the shell.
- **Surprising:** the module check is `expect(evidence.modules.filter(url => url.endsWith('/packages/core/tools/src/index.ts'))).toHaveLength(1)` and the matching `/lib/` list must be empty — the proof that the *source* tree and the *built* tree are never both in the module cache.

### apps/cli/tests/profiles/headless/tests/mcp-pagination.expected.e2e.ts
- **Purpose:** the startup diagnostic when MCP discovery exceeds the SDK's page limit.
- **Key abstractions:** `runLoaderSmoke` with two `--patch` layers (the headless overlay and the MCP pagination fixture's own patch).
- **Data flow:** the test asserts the *task still completed* (`stdout` is exactly `CLI tool round trip complete: CLI_TOOL_ROUND_TRIP\n`), that stderr carries `dsh: warning: 1 entry did not activate` and the row name `mcp-pagination-limit (@deepseek-ai/dsh-mcp-client)`, and then matches the one line containing `exceeded listMaxPages` against the golden `stderr-cause.txt`.
- **Non-obvious design decisions:** the MCP server is *not* disabled — the failure is a real pagination limit against a real stdio server, so the warning is produced by the shipped discovery path.
- **Edge cases / failure handling:** the assertion `toContain('initial connection or tool synchronization failed')` — the diagnostic names the *stage* that failed, not just the row.
- **Surprising:** the golden is a **single line** extracted from stderr and compared with `toMatchFileSnapshot` — a whole-stderr snapshot would break on every unrelated log line.

### apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts
The prompt-cache-stability proof, and the most transferable mechanism in the shard. The fixture registers and removes a tool **at runtime**; the test records every outbound request body and asserts that after a tool *addition*: the system prompt is byte-identical, the **message prefix** is byte-identical (`added.body.messages.slice(0, before.body.messages.length)` equals the previous messages), the **tool list prefix** is byte-identical and the new tool is appended last with `defer_loading: true`, and the provider's `cacheReadTokens` covers the preceding conversation (`cached >= precedingInput - 256`). It also asserts the transcript's registry history is derived from **the tool lists the provider saw**, not from call counts — "a model-chosen extra add/remove cycle changes both sides or neither" — and prints the measured cache deficit to stdout so a regression is visible rather than merely failing.

### apps/cli/tests/profiles/sdk/fixtures/dynamic-tool-cache.mjs
The fixture behind that proof. It registers a `deepseekLlmApiExtensions` observer that records every request body, mounts a scoped `cache_tool_control` tool whose `add` action registers a second scoped tool (with an optional prompt-guidance section) and whose `remove` action disposes it, and turns the tool list into a *restriction* first so the registry diff is unambiguous.

### apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts
The SDK-profile smoke (593 lines). It drives the real JSON-RPC server over stdio and pins: the `initialize` result, the `session/prompt` result, and the `turn/end` reason `max-tokens`; the outbound request's `output_config: { effort: 'max' }` and `max_tokens: 1234`; the tool list containing `read`/`write`/`edit`/`web_fetch`/`web_search` and *not* `list_subagent_models`; the `DSH_MAX_TOKENS_AS_SUCCESS` env switch (and that an invalid value fails startup with a `SyntaxError` naming the offending value); the `sdk-minimal` standalone tree (one bundle, `[shell, read_image, working_directory]`, an opt-in `str_replace_editor` patch read **verbatim out of the user guide**, and an image-offload mode that replaces the image with a reference); the startup-failure path with stdin still open; and the Office resource composition across eight modes (bundled / python-only / missing assets / wrong type), including the "expected file at `<python>`" error for a mistyped interpreter.

### apps/cli/tests/profiles/sdk/office-cli.e2e.ts
The Office-discovery test. It builds a `.docx`, removes Node and the system LibreOffice from `PATH` (with decoy `libreoffice`/`soffice` shims that would write a marker), and asserts the agent still finds the **bundled** CLI, calls the `skill` tool before `bash`, and that the decoy marker was never written. A useful pattern: put a *decoy* on `PATH` and assert it was not invoked.

### apps/cli/tests/profiles/acp/cordis.yml
A one-line pointer file whose entire content is the relative path `../../../../../snapshots/acp/escalation-approved/cordis.yml`. It is the ACP profile's composition entry point: the ACP tests pass it as the `configPath`, so every ACP scenario composes the *same* shipped snapshot rather than a local copy. The target itself lives in the repository's `snapshots/` tree, outside this shard — I read the pointer but not the target, so the ACP profile's exact row list is known here only second-hand through the tests that consume it.

### apps/cli/tests/profiles/acp/tests/acp.e2e.ts
- **Purpose:** the ACP profile driven as a real subprocess over stdio.
- **Key abstractions:** `launchAcpTestAgent` from `@deepseek-ai/dsh-session-snapshot`; the real `@agentclientprotocol/sdk` client.
- **Data flow:** three tests. (1) **stdout purity** — every non-empty stdout line must `JSON.parse`, because a logger leak on the protocol channel is a protocol violation. (2) `session/new` must **resolve**. (3) With a key, a real prompt makes the agent write `proof.txt`, and the file is read back from disk.
- **Non-obvious design decisions:** the first two tests run **without real credentials** using `DEEPSEEK_API_KEY ?? 'sk-dummy-for-boot'`, because the deepseek adapter only checks *presence* at apply time and the key is used only on a real model call, which those tests never make.
- **Edge cases / failure handling:** test 2 is a named regression guard: `session/new` drives the full bridge → `ctx.agents.create` → AgentLoop → registry/persistence path from the JSON-RPC read loop **outside** the bridge plugin's injection scope, so a lazy `ctx.<service>` read there throws an Internal error. The comment states that the key-gated prompt test never caught it (it needs real creds) and the initialize-only purity test never caught it either (initialize does not reach the factory).
- **Surprising:** the test asserts the *transport* separately from the *world*: the world effect (the file on disk) independently proves the standard tool lifecycle ran, and the `session/update` frames prove the same thing was published.

### apps/cli/tests/profiles/acp/tests/cleanup.ts
Twenty-three-line shared teardown. It closes the process and removes the workspace with `Promise.allSettled` on each, collects the rejections, and throws a single `AggregateError` — "attempting both operations and reporting every failure instead of allowing the later one to mask the earlier one". A failure to *close* the agent must not stop the workspace from being deleted.

### apps/cli/tests/profiles/acp/tests/cleanup.e2e.ts
Thirty-eight-line spec of that helper. The first case proves the workspace is removed **even when** the process close rejects; the second proves both failures are reported together (`errors` has length 2 and the first is the close failure). The second case passes the invalid path `'\0'` on purpose to force the removal to fail too.

### apps/cli/tests/profiles/acp/tests/control-surface.e2e.ts
- **Purpose:** the generic ACP v1 control-surface conformance, keyless.
- **Key abstractions:** `selectValue(options, configId, name)` — a helper that finds a named value inside a *grouped* or ungrouped select option, because the model list is grouped by provider.
- **Data flow:** initialize (asserting the exact `agentCapabilities` object and that `_meta` is not echoed back), `newSession` with an attached MCP server, select the `Beta` model and the `Low` reasoning effort, prompt, and assert the **exact** update sequence `['agent_thought_chunk','usage_update','tool_call','tool_call_update','agent_message_chunk','usage_update']`. Then close the session, **restart the process**, `listSessions` (exactly one session), `resumeSession`, prompt, and `cancel` mid-tool.
- **Non-obvious design decisions:** the prompt is sent *before* the cancel is requested, and the test waits for the `tool_call_update` to land first — so the cancellation happens *after* a tool has run, not during the first request. The assertion is on the exact ordering of the update frames, not on a subset.
- **Edge cases / failure handling:** the `finally` closes both processes with `Promise.allSettled` and removes the temp root, so a failed assertion cannot leak a subprocess.
- **Surprising:** the model identity is asserted through the *answer*: the fixture answers `model=beta; tool=5`, so the selection is proven by what the model saw, not by an API echo.

### apps/cli/tests/profiles/acp/tests/escalation.e2e.ts
- **Purpose:** the live approval loop, and the default ACP composition's real Loader path.
- **Key abstractions:** `launchExampleAcpAgent(cwd, answer, sandboxMode?)` — a scripted client that answers every `session/request_permission` with a chosen option and **cancels** (fails closed) if the requested option is absent; `STANDARD_EXECUTION_UPDATES` as the allowed set of semantic update kinds.
- **Data flow:** the keyless smoke boots the profile and asserts the exact `agentCapabilities` and that a session opens. The with-key flow starts read-only, the model's first bash write is denied, the model retries with `sandbox_permissions: workspace-write` plus a justification, the bridge raises a real `session/request_permission` on the client, the client answers `allow-once`, and the retry lands on disk.
- **Non-obvious design decisions:** the runner probe is explicit — `bwrap` on Linux, `sandbox-exec` on macOS — and the suite **self-skips** without a usable runner, because "Without one the strict attempt would fail closed (SANDBOX_UNAVAILABLE) instead of producing the denial this flow starts from."
- **Edge cases / failure handling:** the rejected variant proves the file never appears (`await expect(readFile(...)).rejects.toThrow()`) and that the rejection still travelled the machine-policy channel.
- **Surprising:** the permission request is asserted to carry the escalating tool call (`prompt.toolCall.toolCallId`) and to offer **exactly** the one-shot options `['allow-once','reject-once']` — a grant is scoped to a single call, never a standing permission.

### apps/cli/tests/profiles/acp/tests/goal.expected.e2e.ts
- **Purpose:** the goal lifecycle over the ACP automation driver.
- **Key abstractions:** `runScenario(input, { mode: 'replay', fixtureFile, overrideFile })`; `foldGoal(events)` from `@deepseek-ai/dsh-goal`; a local `normalizeGoalTimestamps` that zeroes `createdAt` / `updatedAt` / `clearedAt`.
- **Data flow:** two scenarios. The round driver asserts the tool-call sequence `['create_goal','get_goal']`, that the goal rounds are exactly `[1, 2]`, and that `foldGoal` reports `{ phase: 'paused', revision: 2, maxGoalRounds: 2, roundsStarted: 2 }`. The wrap-up asserts `['create_goal','update_goal']` and `phase: 'complete'`.
- **Non-obvious design decisions:** the goal timestamps are normalised *inside the JSON text* as well as in the parsed objects (the regex `("(?:createdAt|updatedAt|clearedAt)":)\d+` → `$10`), because the same numbers appear in rendered XML. The suite owns a **separate snapshot root** "because this lifecycle proof has goal-specific timestamp normalization and semantic assertions".
- **Edge cases / failure handling:** `DSH_SNAPSHOT === 'refresh'` rewrites the goldens, and the expectation is still compared *after* the refresh — a refresh can never make a broken run green.
- **Surprising:** the wrap-up asserts the *injection point*: exactly one `user/message` with `source.kind === 'tool-goal'` containing `<goal_complete>`, delivered **after** the terminal tool result, with the model still answering inside the same turn (`goal.expected.e2e.ts:152-156`) — the wrap-up is a context injection, not a new turn.

### apps/cli/tests/profiles/acp/tests/hooks.e2e.ts
Eighty-one-line with-key test of the Claude hook bridge. It writes a `hooks.json` in the **launch cwd** with a `PreToolUse` command that exits 2, asks a real model to write `proof.txt`, and then proves the file never appeared. The turn still ends normally — "the block is a tool-result error fed back to the model, not a turn failure" — and the ACP updates are asserted to contain only the five standard semantic kinds, so hook internals never leak onto the protocol channel.

### apps/cli/tests/profiles/acp/tests/image-offload.expected.e2e.ts
- **Purpose:** pin the Messages Files offload and its inline fallback in the **assembled** request.
- **Key abstractions:** a local `node:http` server that answers `POST /v1/files` (as a multipart upload) and `POST /v1/messages` (as an Anthropic-style SSE stream); a `rejectFiles` flag that flips the Files endpoint to a 503.
- **Data flow:** the scenario sends two images plus text through the ACP `promptContent` step. The test asserts exactly one `POST /v1/files` of **69 bytes** (the 1×1 PNG), then asserts the *exact* content array of the first request: the offloaded image is replaced by a text block `[image omitted to fit request image limits; sha256:…]` plus a "Normalized copy (read-only; may be resized or re-encoded)" path, while the other image stays a `file` reference.
- **Non-obvious design decisions:** the attachment's *content-addressed path* is reconstructed from the digest the test knows (`<root>/.dsh/attachments/v1/objects/<2 hex>/<digest>`), so the assertion is on the real store layout rather than a normalised placeholder.
- **Edge cases / failure handling:** with `rejectFiles = true` the run is repeated and the assertion flips: the Files endpoint is tried again, fails, and the image is inlined as `base64` instead. The fallback is therefore a *tested* path, not a comment.
- **Surprising:** the `read_image` tool result is asserted to carry the image description **and** the file reference, and the follow-up request is asserted to contain the offloaded text block **twice** — the placeholder is repeated so the model still sees that an image was dropped.

### apps/cli/tests/profiles/acp/tests/fixtures/control-surface/cordis.yml
Twenty-one-line keyless ACP patch: it disables `llm-deepseek` and replaces the `acp` row's provider with `control-fixture` / `alpha`, points `session-persistence-jsonl` at `!!js process.env.DSH_CONFORMANCE_PERSISTENCE_ROOT` with `compression: none`, and inserts the fixture adapter. The `!!js` root is what lets the same patch serve a test that restarts the process and finds the same sessions.

### apps/cli/tests/profiles/acp/tests/fixtures/control-surface/control-surface-llm.ts
- **Purpose:** a keyless two-model adapter that drives the ACP control-surface conformance.
- **Key abstractions:** `listModels` offers `alpha` and `beta`; `resolveModel` advertises a **2 048-token** window and `low` / `high` reasoning efforts with `high` as the default.
- **Data flow:** `stream` looks at the messages *after the last user turn*. With no tool result yet it emits one reasoning block and one `mcp__fixture__add` tool call; when the prompt contains "cancel" it instead emits a text turn that **hangs** until the abort signal fires; otherwise it answers `model=${options.model}; tool=5`.
- **Non-obvious design decisions:** the tool-call id is `control-cancel-add` when the prompt mentions cancel, so the test can wait for *that* call before cancelling — the cancellation is driven by a tool that has already finished.
- **Edge cases / failure handling:** the hang path rejects with `new Error('cancelled')` on the abort signal, so the turn ends the way a real cancellation ends it.
- **Surprising:** the answer text embeds the resolved model name, so the *selection* is verified through the model's own output rather than through an API echo.

### apps/cli/tests/profiles/acp/tests/fixtures/image-offload.cordis.yml
Forty-four-line patch for the native image-offload snapshot. `maxRequestFilesBytes: 92` and `imageOffloadByteQuantum: 1` are set **deliberately tiny** so the offload path fires on a 69-byte PNG; the model is declared with `inputModalities: [text, image]` and a 32 768-token window; the system prompt is a fixed two-line persona; and `attachment-local` is mounted so the attachment store is the real one. The `baseURL` and `apiKeyEnv` come from the snapshot environment, not from a literal.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/input.json
Ten-line scenario script: `initialize`, `newSession`, a `promptAndWaitForAgentMessage` that waits for the text "GOAL ROUND ONE", `waitForTurnStart` with `minimumTurn: 3`, a `cancel` that waits for the file `.dsh-snapshot-goal-cancel-ready`, a `waitForTurnEnd`, and a `waitForEventAfterTurnEnd` for a `goal/change`. The sequence deliberately drives **two** goal rounds before cancelling.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/replay.override.json
Forty-three-line scripted model response in four turns plus a hang: `create_goal` with `max_goal_rounds: 2`, `get_goal`, the text "GOAL READY", the text "GOAL ROUND ONE", and finally a fifth entry `{"kind": "hang", "readyFile": ".dsh-snapshot-goal-cancel-ready"}` (`goal-round-driver/replay.override.json:42`) — the hang is what makes the cancellation land in the middle of a turn.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/session.expected.jsonl
Forty-seven-line golden session. It shows the three-turn shape of an automatic goal run: turn 1 creates and inspects the goal, turn 2 is driven by an injected `<goal_round>` message (Round 1/2) and answers "GOAL ROUND ONE", and turn 3 is driven by Round 2/2, answers "partial" — with `"interrupted": true` on the assistant message — and ends `aborted` with `reason: { kind: 'user' }`. A final `goal/change` records the pause: `phase: 'paused'`, `revision: 2`, `roundsStarted: 2`.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/session.jsonl
One-line v0 session placeholder (`goal-session-placeholder`) — the replay adapter's "the primary fixture path must exist" guard.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/stdout.expected.jsonl
Ten-line golden ACP stdout: the `initialize` result with the exact `agentCapabilities`, the `session/new` result whose `configOptions` carry the grouped `model` select (`deepseek-official` → `deepseek-v4-flash`, `deepseek-v4-pro`), the `create_goal` / `get_goal` `tool_call` + `tool_call_update` pairs, the "GOAL READY" message, the `stopReason: end_turn`, and the partial second round.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-wrapup/input.json
Thirteen-line scenario script: `initialize`, `newSession`, a `promptAndWaitForAgentMessage` waiting for "GOAL READY", then `waitForTurnStart` with `minimumTurn: 2` and `waitForTurnEnd`.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-wrapup/replay.override.json
Forty-two-line scripted response in four turns: `create_goal` with `max_goal_rounds: 2`, the text "GOAL READY", an `update_goal` call whose `goal_id` is the **template** `"{{fromRequest:goal-[0-9a-f-]+}}"` (the real id is extracted from the earlier request rather than hard-coded), and finally the closing "GOAL WRAP-UP: …".

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-wrapup/session.expected.jsonl
Forty-one-line golden session. Its distinguishing event is the wrap-up injection: after the `update_goal` result, an `agent/inbox/spliced` on `next-step` carries the `<goal_complete>` message ("The goal is marked complete and this autonomous run is ending. Write the closing message to the user now…"), and the model answers it **inside the same turn** — the log shows turn 2 with two steps and one `turn/end`.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-wrapup/session.jsonl
One-line v0 session placeholder for the wrap-up scenario.

### apps/cli/tests/profiles/acp/tests/goal-expected/goal-wrapup/stdout.expected.jsonl
Nine-line golden ACP stdout for the wrap-up: the `initialize` result, the `session/new` result with the grouped model select, the `create_goal` call pair, "GOAL READY", `stopReason: end_turn`, the `update_goal` call pair (whose result shows `phase: "complete"`, `revision: 2`, `activation: "disarmed"`), and the closing message.

### apps/cli/tests/profiles/web/tests/default-web-process.ts
- **Purpose:** own a **built** Web process over IPC for the isolation smokes.
- **Key abstractions:** `withDefaultWeb(test, inspect, options)`; the `DefaultWeb` handle = `{ root, url, request('roster' | 'mount-experimental' | 'mount-experimental-entry') }`; `webGet` / `webRequest` for direct loopback requests.
- **Data flow:** it transpiles two TypeScript helpers to JS **in the temp root** with the TypeScript compiler API (`ts.transpileModule`), writes a patch that inserts the observer by `file:` URL, and launches the built `apps/cli/lib/bin.js` with `--profile web --host 127.0.0.1 --port 0 --no-open` and a scrubbed environment (`NODE_OPTIONS`, `NODE_PATH` and `TSX_TSCONFIG_PATH` explicitly `undefined`).
- **Non-obvious design decisions:** the observer patch is given a `negativeControl` pointing at the *built* experimental package — the negative control the isolation test mounts on demand. The stop path asks the child to shut down over IPC and only force-kills after **twice** the CLI's own `PROCESS_SHUTDOWN_TIMEOUT_MS` (`default-web-process.ts:136-137`).
- **Edge cases / failure handling:** the `finally` asserts the child exited **0** with **no** signal and that it was never force-killed (`expect(forced, stderr).toBe(false)`), so a graceful-shutdown regression fails here rather than silently passing. `webRequest` uses `agent: false` so Node's process-start proxy dispatcher is not inherited.
- **Surprising:** the `test.signal` is threaded through the whole helper — an aborted test rejects the pending IPC requests with "Web isolation test was cancelled" and closes the child.

### apps/cli/tests/profiles/web/tests/runtime-roster.ts
- **Purpose:** collect the *real* runtime state of a booted Web process.
- **Key abstractions:** `RuntimeRoster` = `{ entries, plugins, modules, client }`; `modulePackage(url)` walks up to the nearest `package.json` to name the owning npm package.
- **Data flow:** `runtimeRoster(ctx)` reads `ctx.loader.internal.loadCache` (the Node module cache), resolves each loaded module's Cordis namespace to the registry callback that owns it, adds every `require.cache` entry, and returns the Loader entries, the registry fibers with the module URLs each callback owns, the sorted module list, and `ctx.clientModules.graph()`.
- **Non-obvious design decisions:** the collector does **not** import any application code to find the package — it reads `package.json` files on disk, so inspecting the runtime cannot change it.
- **Edge cases / failure handling:** if `ctx.loader.internal` is missing it throws "Web isolation smoke requires Node module-cache introspection" — the smoke fails rather than silently reporting an empty roster.
- **Surprising:** `modules` is the union of the Loader's load cache and `createRequire(import.meta.url).cache` — a module loaded by a CommonJS path would otherwise be invisible to the isolation check.

### apps/cli/tests/profiles/web/tests/runtime-roster-isolation.ts
Twenty-four-line helper that gathers every experimental identity from the roster — the Loader entry names, each plugin's owner and module URLs, the module list, and the client graph's entry ids, `inject` and `external` lists plus the batch entries — and keeps the ones `hasExperimentalPackageReference` accepts. A `file:` URL is additionally checked against the `/packages/experimental/` path and against the package name its `package.json` declares, which is how an *installed alias* is caught.

### apps/cli/tests/profiles/web/tests/runtime-roster-isolation.spec.ts
Thirty-eight-line spec over every name in `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS`. It builds a fake `node_modules/ordinary-alias` whose `package.json` declares the experimental name, and asserts that the detector reports **all six** spellings (the name, a subpath, the module URL, and the three client-graph references). The negative control is the second half: renaming the package to `<name>-unrelated` must produce an empty result.

### apps/cli/tests/profiles/web/tests/fixtures/creator-plugin-manager.mjs
- **Purpose:** an IPC observer that drives the real `plugin_manager` **tool** through a scripted approval policy.
- **Key abstractions:** it intercepts `approval/request` with `{ prepend: true }` and answers only for `toolName === 'plugin_manager'`, letting every other approval fall through to the product's own handler.
- **Data flow:** on the `initial` or `restart` message it creates two agents (each with `ctx.agentPresets.mount(scope, 'cordis')` in its `setup`), records the tool list before the change, calls `plugin_manager` with `action: 'install_bundle'`, records the list again, and — on the `restart` phase — calls `plugin_manager` with `action: 'remove_bundle'`.
- **Non-obvious design decisions:** the answer is a **variable** (`answer`), switched from `'rejected'` to `'allowed-once'` mid-run, so one fixture exercises both the refusal and the grant and reports the sequence of approvals it saw.
- **Edge cases / failure handling:** the `finally` disposes the approval interceptor, appends the `turn/end` for the active session and disposes both agent handles.
- **Surprising:** the observer calls the tool through `ctx.tools.execute({ name: 'plugin_manager', arguments, agent, callId, signal })` — the *same* door the model would use — so the test proves the tool's own approval path, not a private API.

### apps/cli/tests/profiles/web/tests/fixtures/runtime-roster-observer.ts
Thirty-eight-line IPC observer mounted *beside* the unchanged default Web composition. It requires `process.send` (throwing "Runtime roster observer requires an IPC channel" otherwise), answers the three commands, and — for `mount-experimental` — imports the configured negative-control module and mounts it through `ctx.plugin(ctx.loader.unwrapExports(namespace))`, or for `mount-experimental-entry` through `ctx.loader.create({ name })`. Either way it calls `ctx.loader.await()` before reporting, so the roster reflects a *settled* tree.

### apps/cli/tests/profiles/web/tests/office.expected.e2e.ts
Twelve-line isolation test: the ordinary Web profile must mount **no** `skill-office`, `office-commands` or `tool-workspace-dependencies` row. It asks the process for its roster and asserts each name is absent. "Ordinary Web leaves Office authoring composition to its carrier."

### apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts
- **Purpose:** prove the default Web product is isolated from the experimental packages.
- **Key abstractions:** the `__DSH_BOOT__` graph parsed out of the served HTML; `FiberState` from Cordis.
- **Data flow:** it authenticates, fetches `/`, extracts `globalThis["__DSH_BOOT__"] = …` from the HTML, and asserts `roster.client` **equals** the delivered graph (`web-default-isolation.expected.e2e.ts:20-24`) — the browser's view and the process's view must be the same graph. It then checks that the Host webserver and client-modules rows are ACTIVE, that the built-in sidebar Browser row is present but **not** delivered to the browser, that the Schedule service *and* its task page are mounted while the clock is not, and that no experimental reference exists.
- **Non-obvious design decisions:** the **negative control** is the sharpest part: after asserting the clean state, the test asks the process to mount the real experimental package and asserts the detector now reports it (`web-default-isolation.expected.e2e.ts:48-54`). A scanner that passes on zero matches is not a scanner.
- **Edge cases / failure handling:** `roster.plugins.length` is asserted to be **greater** than `roster.entries.length` — the registry holds more than the Loader lists, so a roster built from the wrong source would fail.
- **Surprising:** the built-in Browser row is *mounted* (its state is `undefined`, i.e. not yet active) but is **not** in the delivered client graph — a row can exist on the host plane without shipping to the browser.

### apps/cli/tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts
- **Purpose:** the acceptance for best-effort initial plugin activation.
- **Key abstractions:** a fixture that writes five failing plugins (import, sync apply, async apply, a missing dependency, and a `disabled: !!js` expression that throws) plus one *good* plugin that records `apply` / `dispose` into an events file.
- **Data flow:** the first case boots the Web profile with those six probe rows and waits for a stderr line containing `dsh: warning: 6 entries did not activate` **and** the async failure and the missing service. It then asserts the page still serves (`<div id="root"></div>` and `__DSH_BOOT__`), that the good plugin applied but did **not** dispose while the app was live, and that stderr names each failing row, the `@deepseek-ai/dsh-tool-todo` package, and the disabled-expression `SyntaxError`.
- **Non-obvious design decisions:** the "optional" case is decided by the **row**, not by the failure: a second family of cases makes the `modules` or `connection` row *required* and asserts the process exits 1 with `startup failed:` and `<id> (required)`. The optional case exits 0.
- **Edge cases / failure handling:** the bind-failure case occupies the port first and asserts the stderr *summary* contains exactly one `EADDRINUSE` and does **not** contain the stack, the `[cause]` chain or the Node version banner (`web-best-effort-startup.expected.e2e.ts:301-303`) — the summary is a summary. The same case runs twice, once with `$DSH_HOME/logs` blocked by a file, and asserts the report then goes to stderr with `could not write startup diagnostics:` and the blocking file is left untouched.
- **Surprising:** the last case shows a **detached** rejection (a promise rejection inside an `appReady` effect) is fatal — `fatal load failure: Error: detached Web failure` and exit 1 — even though the app had already started serving.

### apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts
- **Purpose:** the failure policy of the built Web process, at startup and under the native configuration watcher.
- **Key abstractions:** eight failure classes (`import`, `module evaluation`, `schema`, `config expression`, `disabled expression`, `sync apply`, `async apply`, `dependency`); a `render(id, failure, generation)` that emits the patch for a class; an observer that exports the loader's entry states and the authenticated URL.
- **Data flow:** each class is run twice — as a **required** row (the process must exit 1 and the *witness* row must be disposed) and as an **optional** row (the app must keep serving, stderr must say `warning: 1 entry did not activate`, and the witness must survive). The same matrix is then run under native HMR: a bad patch must not dispose the previous generation, must not apply the new one, and must leave the app serving; a later valid correction applies it and only then disposes the old generation.
- **Non-obvious design decisions:** the observer writes its state file with a `.tmp` + `renameSync` pair so a reader never sees a half-written JSON, and it writes the recovery URL only after `scope.get('loader').await()` resolves — "A recovery URL is a readiness signal; sibling HMR work must settle first."
- **Edge cases / failure handling:** the overlay-rejection table gives each malformation its **own** diagnostic — "failed to read overlay", "failed to parse overlay", "top-level YAML array", "must be a mapping" — and asserts the app never became ready and the witness never applied. A schema failure keeps the *existing* config live until a valid correction arrives.
- **Surprising:** the HMR tests also prove the reverse direction: disabling a shipped **required** row (`modules`, `connection`) disposes it, re-adding it with a *missing* dependency leaves it `PENDING` (not failed), and providing the dependency later brings it to `ACTIVE` — the required-row lifecycle is re-entrant, not one-shot (`web-failure-matrix.expected.e2e.ts:466-486`).

### apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts
- **Purpose:** the built Web profile's bind address, its advertised public root, and browser authentication.
- **Key abstractions:** `bootWeb(root, flags)` waits for **two** signals — the marker plugin's `public-url-listen-port: <port>` line and the `dsh web: http…` line; `request(protocol, dial, port, path, host, method, cookie?, ca?)` builds a raw request with an explicit `Host` header.
- **Data flow:** six cases. TLS: the advertised origin is `https://127.0.0.1:<port>`, a client without the CA is rejected with a self-signed-certificate error, the cookie carries `; Secure`, and an unauthenticated API call is 401. The advertised mount: a **prefix proxy** strips `/tools/dsh/` and the API still answers at both the mount and at loopback, while a foreign `Host` gets 403. The non-loopback bind: the declared authority is admitted, any other name for the same socket is a "rebound Host" and gets 403, and the stderr warns `listening on <ip> over plain HTTP` — and does **not** contain the token.
- **Non-obvious design decisions:** the token must not be echoed to stderr, so the test asserts `expect(stopped.stderr).not.toContain(token!)` — the launch URL carries the token, the *log* must not. IPv4-mapped and zoned IPv6 loopbacks are enumerated and the advertised root is normalised to the canonical `127.0.0.1` / `[::1]` spelling.
- **Edge cases / failure handling:** the `stop` helper writes an interrupt file and force-kills only after twice the CLI's own shutdown budget; `expectCleanExit` then asserts exit 0 with no signal.
- **Surprising:** the process is stopped through a **marker file** the plugin polls, because "Windows has no deliverable SIGTERM" — the same trick the shutdown fixture uses.

### apps/cli/tests/profiles/web/tests/schedule-timing.expected.e2e.ts
- **Purpose:** the Remote schedule bindings against a built Web process.
- **Key abstractions:** a seeded `schedule.json` in the storage unit's format (`{ unit, global, tables }`); an `encoded(task)` helper; a `connect(url, signal)` that performs the token exchange and then speaks the `client-request` / `server-response` envelope over `/api/<method>`.
- **Data flow:** it seeds a task whose owning session id does **not** exist, then asserts the catalog still lists it, the history is preserved, and an update carrying an `expected` record succeeds. A second update with the **same** `expected` returns `updated: false, code: 'schedule_conflict'`; an update naming a different owner returns `code: 'schedule_not_found'` — and the file on disk is byte-identical after both refusals (`schedule-timing.expected.e2e.ts:80-83`). The whole scenario is then re-run against a **cold** process, and the seeded history is still there.
- **Non-obvious design decisions:** the update carries an `expected` record — an optimistic-concurrency token — and a *semantically equivalent* time zone change (`UTC` → `Etc/UTC`) is accepted as a no-op (`updated: false` with the record echoed) rather than as a conflict.
- **Edge cases / failure handling:** the seeded task's `lastDelivery` and `deliveryHistory` are asserted to survive every operation, and the file's bytes are compared after each step.
- **Surprising:** a second case creates the *explicit* session id bound to the seeded task data and asserts that `session/create` is **idempotent** (two calls, one result) and that the task file is not touched by the creation.

### apps/cli/tests/profiles/web/tests/creator-plugin-manager.expected.e2e.ts
- **Purpose:** the plugin manager over a live built Web profile.
- **Key abstractions:** an `Observation` record returned over IPC by the observer; a locally built `@test/creator-mcp` **bundle** (a `package.json` with `dsh.bundle.patch` and a `cordis.patch.yml` inserting an `mcp-client` row pointed at an HTTP MCP fixture).
- **Data flow:** the observer installs the bundle through the real `plugin_manager` **tool** with a scripted approval policy. The test asserts the denial path first (the approval is `rejected`, the tool result says "the user rejected escalating", the tool list is unchanged, and the bundle is not installed), then the allowed path (`allowed-once`, `application: 'applied', changed: true`) — after which **both** the existing session and a *new* session see `mcp__demo__ping` and the MCP server really receives `ping`. The profile manifest is then read back and must list the bundle and the dependency.
- **Non-obvious design decisions:** the process is **restarted** and the bundle must still be there — the configuration lives in the profile manifest, not in the running tree — and only then is it removed, after which the tool disappears again. The MCP server's call log is asserted to be exactly `['ping','ping']`.
- **Edge cases / failure handling:** the retired `cordis_*` tool names are asserted *absent* from the tool list, so a legacy tool surface cannot linger.
- **Surprising:** the approval sequence is asserted as exactly `['rejected', 'allowed-once']` — the approval policy is per operation, and the test proves the first refusal did not poison the second attempt.

### apps/cli/tests/profiles/packed-installation.ts
The packed-installation helper. It packs the workspace closure to tarballs with `pnpm pack --recursive`, installs them into an isolated tree with `nodeLinker: hoisted` and `autoInstallPeers: false`, resolves every external dependency to the version actually installed (so the overrides are exact), and then asserts — with `assertInstalledTree` — that **no symlink in the installed tree escapes its installation root**, including dangling `.bin` shims. It also snapshots the workspace's own link state before and after and asserts it is unchanged, so the packing never mutates the checkout.

### apps/cli/tests/profiles/official-installer-packed.e2e.ts
The Official-bundle acceptance. It packs two real provider closures, serves them from a **local registry** (with a manifest recording the build id and every served package), installs them into an isolated product through the **generic** plugin manager, and asserts the whole lifecycle: unavailable → installed (with the right rows, the provider enabled and the native artefact present) → a 9999.0.0 install failing with the manifest unchanged → disabled → enabled → removed → absent. A failure in the body is preserved: the plugin manager's pnpm log tail is appended so a stalled operation is diagnosable.

### apps/cli/tests/profiles/fixtures/official-installer-observer.mjs
The installed-profile observer. It writes a `PACKED_OFFICIAL_STEP=<stage>` line at every stage (so a killed child still names where it stalled) and wraps each manager operation in a **bounded** race — the comment names the reason: "pnpm 11.7.0 can print its result and never exit (pnpm#12297, fixed in 11.23.0)". On expiry it reads `.plugin-manager/run.json`, checks whether the recorded pid is alive, and reports the process's `/proc` state and cmdline. A very practical diagnostic pattern.

### apps/cli/tests/profiles/webhook-packed.e2e.ts
The published-webhook test from an isolated installed Web profile: it packs the runtime and adapter, installs them as **profile** dependencies (asserting they are not present in the installation), wires the shipped `examples/github-review/cordis.yml`, and proves a correctly signed `ping` delivery is accepted with HTTP 202 while a signed pull-request delivery is not. It also asserts no session log was written — a webhook ping must not start an agent.

---

## Ideas worth stealing

- **Draw a hard argument boundary instead of a flag list, and let the child own everything after it** — `apps/cli/src/args.ts:159-167` — Commander is configured with `.allowUnknownOption().passThroughOptions().enablePositionalOptions()` and a `[args...]` positional, so the *first token the launcher does not own* becomes the app's argument list. For August this is the cleanest way to let a host (`dsh`, a desktop shell, an SDK) own its own flags while sharing one boot: the host owns a fixed prefix, the runtime owns the rest, and no shared flag registry is needed. The companion rule is at `apps/cli/src/args.ts:122-127`: **a read-only/inspection mode must refuse the arguments it cannot honour**, because "printing a tree that differs from the same invocation's boot would mislead."

- **Regenerate the base file from a constant on every boot so a partial write-back can never accumulate** — `apps/cli/src/profile-boot.ts:180-200` — the empty root config is a literal string that is *always* rewritten, because the Loader writes back the composed tree when a plugin self-disposes, and a written-back root would duplicate every bundle insert on the next boot. August's August-side equivalents (a persisted prompt prefix, a saved tool list, a cached system prompt) have exactly this failure mode: any file the runtime may write back must be re-derived from a constant, never read back.

- **Freeze the launch environment once and serve it as a service** — `apps/cli/src/profile-boot.ts:272-279` and `:326-328` — the proxy is resolved from a *snapshot*, not `process.env`, because "Node's fetch ignores the proxy environment on its own" and "Node samples the environment at start"; and the snapshot is provided to the tree **before any config-tree entry mounts**, so every plugin reads the same immutable values. August's gateway already has a layered-env concept; making it a *snapshot* that plugins receive as a service (rather than ambient `process.env`) is the transferable half.

- **A staging directory with a recoverable `previous` copy, and a concurrent-winner detection that does not trust the error code** — `apps/cli/src/profile-boot.ts:132-176` — the new profile is assembled in a *sibling* staging directory so both renames stay on one filesystem; the old target is moved to `<staging>/previous` before the new one is moved in; a failed restore throws an `AggregateError` **naming the path where the old profile can be recovered by hand**; and because "Windows reports EPERM instead of EEXIST or ENOTEMPTY", a concurrent winner is detected by the *target's state*. This is the pattern August needs for any destructive state transition (profile reset, memory import, session replacement).

- **Escalating shutdown: drain on the first signal, force on the second, and never let a repeated graceful call escalate** — `apps/cli/src/process-shutdown.ts:52-75` and `apps/cli/src/profile-boot.ts:302-308` — `shutdown()` coalesces (the second call returns the same promise); only a *signal* escalates; SIGTERM exits 0 and SIGINT exits 130 because "the launcher does not know whether the app considered its work complete". August's desktop host and its unattended paths need exactly this vocabulary, and the "repeated graceful call must not escalate" rule is the part people get wrong.

- **A readiness signal committed only on four independent conditions, not on "boot returned"** — `apps/cli/src/profile-boot.ts:341-345` — readiness is committed only if the shutdown was not already aborted, the fiber is `ACTIVE`, a `loader` service exists, and boot resolved. A progress indicator driven by "the process started" lies; one driven by these four conditions does not.

- **Save the diagnostic privately, print the summary, and never print a path you did not write** — `apps/cli/src/startup-diagnostics.ts:34-68` — a unique `startup-<ts>-<uuid>.log` under `$DSH_HOME/logs`, created with `flag: 'wx'` so a concurrent failure cannot overwrite an earlier report, modes `0700`/`0600`, a header that warns the report may contain credential values, and — if the write fails — the **whole** report goes to stderr instead of a claim that a file exists. The `inspect` settings (`showHidden: true`, `getters: false`, `customInspect: false`) preserve nested causes, aggregate members, cycles and symbols without ever evaluating an accessor.

- **Turn "the tool call was recorded but no result was" into an explicit, actionable error** — `apps/cli/tests/profiles/headless/tests/expected/semantic-checkpoint/session.expected.jsonl:8` — the synthesised `tool/result` is `ToolOutcomeUnknownError` / `TOOL_OUTCOME_UNKNOWN` and says: "Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly." August's crash-recovery path needs this: an ambiguous side effect must become a *named, actionable* tool result, not a hang, a silent retry, or a generic error.

- **Keep the prompt prefix byte-identical across a tool-registry change, and derive the transcript's tool history from what the provider saw** — `apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:142-163` — after a runtime tool addition the system prompt is unchanged, the message prefix is byte-identical, the **tool list prefix** is byte-identical with the new tool appended last (`defer_loading: true`), and the provider's `cacheReadTokens` still covers the preceding conversation. The new tool is registered *scoped* so the registry diff is unambiguous, and the transcript's registry history is computed as the **diff of consecutive request headers** — "a model-chosen extra add/remove cycle changes both sides or neither" — not from call counts. This is the concrete recipe for August's prompt-cache hit rate: append, never reorder; and derive the "tools changed" message from the wire, not from the model.

- **A retry must not change the model-visible messages** — `apps/cli/tests/profiles/headless/tests/fixtures/retry-snapshot-backend.mjs:30-32` — the fixture throws "retry snapshot changed the model-visible messages" if the second attempt's messages differ from the first. Combined with the `llm/retry` event, which records the *policy key* that produced the decision (`apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts:517-525`), this gives August both a cache invariant and an auditable retry ledger.

- **Verify the world, not the model's self-report — and check the test file is byte-identical** — `apps/cli/tests/profiles/headless/tests/coding-task.e2e.ts:69-84` — "an agent that neutered the test instead of fixing the bug fails here, not just on a keyword probe". The same rule appears in the todo test (assert the `todo/write` event's contents), the ACP tests (assert the file on disk), the escalation test (assert the write landed) and the credential tests (assert the key the *server* received). August's evals should assert the same way: re-run the check yourself, outside the agent.

- **An inspection path must be provably non-mutating** — `apps/cli/tests/dump-config-schema.expected.e2e.ts:25-32` and `:108` — every fixture plugin carries an `apply()` that writes `apply-ran` and throws, and the test asserts the file does **not** exist after the dump; `!!js` expressions that would throw are dumped without evaluating them. The same discipline belongs on any August-side "explain/diagnose" endpoint: it must be able to prove it changed nothing.

- **Absence of a capability is not a prohibition** — `apps/cli/tests/expected/dump-config-schema.json:108-110` and `apps/cli/reference/README.md:64` — `unknownConfig` is an *empty* schema whose `$comment` says "this is unknown configuration, not a prohibition on fields", and `complete: false` "does not guarantee successful boot". August's config introspection should make the same distinction explicit rather than treating "I don't know" as "invalid".

- **Compose the agent's capabilities from a per-session scope, and keep the host plane minimal** — `apps/cli/tests/web-agent-presets.e2e.ts:248-251` and `:288-311` — the global layer exposes **only** `working_directory`; every action tool belongs to a preset; the preset's catalog is asserted **exactly**, because "an omission is this design's quietest failure mode, since a row that registers into the wrong layer mounts cleanly and simply contributes nothing". A delegated child inherits the parent's *live scope*, not the parent's creation header (`apps/cli/tests/web-agent-presets.e2e.ts:959-982`) — "The live scope chain is the authority, not the parent's creation header".

- **A child's permissions must be armed before the child's first turn** — `apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.expected.jsonl:3-6` — the child's log shows `sandbox/mode: { mode: 'read-only', source: 'delegation' }` and `approval/policy: { policy: 'never', source: 'delegation' }` **before** `turn/start`, and the write never reached disk. The injected runtime context also says "Do not refuse a required modification from this policy alone" — a denial must be scoped, not a blanket refusal. This is the ordering August's subagent path must guarantee: constraints are installed *before* the child can act.

- **A child that settles must notify its parent; the parent must not have to poll** — `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts:1137-1210` and `apps/cli/tests/profiles/headless/tests/fixtures/subagent-settlement-fence.ts:16-19` — the settlement notice arrives as an `agent/inbox/spliced` with `source.kind: 'subagent-settled'`; the fixture holds the parent's second step until the notice is admitted, which pins *content order* rather than step placement. Push, not poll.

- **The parent's catalog alone is enough to discover a cold child** — `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts:134-137` — "Direct discovery must not read that child log"; the parent shows the child as inactive-but-known and never as corrupt. A registry entry, not a re-read of the child's log, is the discovery mechanism.

- **A failed hot-reload must keep the previous configuration live** — `apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:329-346` — a schema failure in a new patch generation does not apply the new row, does not dispose the old one, and does not interrupt the serving siblings; a later valid correction applies it and only then disposes the previous generation. The same matrix shows that a malformed *overlay* is rejected before readiness with a specific diagnostic per malformation ("failed to read overlay", "failed to parse overlay", "top-level YAML array", "must be a mapping").

- **Separate required failures from optional failures, and say which is which** — `apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:233-258` — a required entry that fails to import aborts the process with the failed plugin's package, the pending plugins and the missing services; an optional one produces `warning: 1 entry did not activate` and the app keeps serving. "Optional" must be a *declared* property of a row, not an inference from the failure.

- **Prove an isolation check can fail — a negative control** — `apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts:48-54` — the test mounts a real experimental package at runtime and asserts the detector now reports it. A scanner that passes on zero matches is not a scanner; August's August-side gates should carry the same negative control (and the August workspace's own `check:sse` handler-supply rule is the same idea).

- **A permission grant is bound to one call, and the request carries the call** — `apps/cli/tests/profiles/acp/tests/escalation.e2e.ts:165-170` — the `session/request_permission` request must carry `prompt.toolCall.toolCallId` and offer exactly `['allow-once','reject-once']`; a scripted client that cannot find the requested option *cancels* rather than grants. For August: a permission prompt must name the operation it is approving, and a grant must expire with that operation — never become a standing permission for the session.

- **A denial must be a scoped, structured tool result that carries the escalation path** — `apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.expected.jsonl:17` — the refused `write` comes back as a tool result with `isError: true` and a structured `error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' }`, and the text offers the next step ("retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification"). The injected runtime context separately says "Do not refuse a required modification from this policy alone". August's policy engine should emit a *machine-readable* refusal plus a *human-actionable* remedy, and the model must be told not to treat a scoped denial as a reason to abandon the task.

- **The failure summary must be a summary — assert the absence of the detail, not just its presence** — `apps/cli/tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts:301-303` — the stderr summary must contain exactly one `EADDRINUSE` and must **not** contain the stack, the `[cause]` chain, `at boot (`, `at runCli (` or the Node version banner; the full report lives in a separate file. August's startup failure path should split the one-line summary from the diagnostics dump and pin that split with negative assertions.

- **A required row's lifecycle is re-entrant, not one-shot** — `apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:466-486` — disabling a shipped *required* row disposes it; re-adding it while one of its dependencies is missing leaves the row **PENDING** (not failed), and providing the dependency later brings it to **ACTIVE** without a restart. For August: a disabled-and-re-enabled capability must be able to come back to life, and "waiting for a dependency" must be a distinct state from "failed".

- **Compare the graph the client received with the graph the process built** — `apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts:20-24` — the test extracts `globalThis["__DSH_BOOT__"]` from the served HTML, parses it, and asserts it **equals** the process's own `ctx.clientModules.graph()`. The isolation claim is therefore "the browser and the process agree", not "the browser's list matches a hand-written expectation" — which is the form that rots the moment a feature is added.

- **A mock model should refuse to run under a composition it was not designed for** — `apps/cli/tests/profiles/headless/tests/fixtures/team-llm.mjs:182-191` — the fixture throws "Team profile exposes a direct subagent tool" and "Team profile is missing teammate or workflow tools" instead of producing a plausible answer. For August's evals: a scripted model is also a *composition assertion*, and it should fail loudly when the tool surface it expects is not the one it was given.

- **A scripted-model layer needs a "hang" primitive, or cancellation is only testable with a real model** — `apps/cli/tests/profiles/acp/tests/goal-expected/goal-round-driver/replay.override.json:42` — the replay override's last entry is `{"kind": "hang", "readyFile": ".dsh-snapshot-goal-cancel-ready"}`, which parks the turn until the driver writes the file and then cancels it. August's replay/record layer should be able to park a turn deterministically, so abort, cancel and escalation flows are testable without a provider.

- **A mutating call that a user can race should carry an `expected` precondition, and the refusal codes must be distinguishable** — `apps/cli/tests/profiles/web/tests/schedule-timing.expected.e2e.ts:80-83` — `schedule/update` carries the record it expects; a stale precondition returns `code: 'schedule_conflict'` and a foreign owner returns `code: 'schedule_not_found'`, and the file on disk is proven byte-identical after both refusals. "Conflict" and "not found" are different problems and must not share a code.

- **Assert the world in three places: the action, the artefact, and the narration** — `apps/cli/tests/profiles/headless/tests/full-loop.e2e.ts:37-47` — the test asserts that a `tool/call` for `bash` happened, that a `tool/result` contains `e2e-ok`, *and* that the final text contains it. A model can fake any one of the three; August's evals should check all three, in the cheapest one that can fail.

- **The injected runtime context should be structured, not prose** — `apps/cli/tests/profiles/headless/tests/expected/headless-profile/session.expected.jsonl:11` — the runtime-context user message carries `source.kind: 'runtime-context'`, `form: 'snapshot'` and a `sections` array naming `working-directory:current`, `sandbox:policy` and `approval:policy`, so a consumer can read the policy without parsing English. August's equivalent (the workspace, the file policy, the approval policy) should be section-addressable too, so a UI can re-render one part of it.

- **One test body, two execution lanes** — `apps/cli/tests/source-launch.compat.spec.ts:18` and `apps/cli/tests/built-bin.e2e.ts:345` — the same `testProfileResolution(mode)` helper is called with `'src'` and with `'lib'`, and the lane-specific differences are pinned explicitly (the source lane's `execArgv` is `['--import','tsx/esm']`; the built lane's is empty; only `src/index.ts` **or** only `lib/index.js` may be loaded, never both). One assertion set, two execution modes, and a "no duplicate module identity" check that the `TOOL_RUNTIME_SCHEDULER` symbol makes concrete (`apps/cli/tests/profiles/headless/tests/profile-resolution.ts:217`).

- **Bilingual parity as a hash record per heading, not a translation memory** — `apps/cli/README.i18n.yaml` and `apps/cli/reference/README.i18n.yaml` — one `en`/`zh` hash pair per heading section, regenerated by `pnpm run verify-translation-pairing --write <file>`. Drift is then reported per section instead of per file, and the "record" is data an agent can read and update. August's bilingual docs could adopt the same shape verbatim.

- **Ship a generated composition graph next to the launcher** — `apps/cli/composition.md:1-4` — a mermaid graph from the config node to every plugin row plus a `Plugin id | Package / module` table, produced by `scripts/gen-doc-graphs.ts` and marked "do not edit by hand". For August, an auto-generated map from "feature name" to "owning module" is the same artefact: it turns a 90-row configuration into something a human (or an agent) can navigate.

---

## Files skipped (with reasons)

None. Every one of the 182 files in the shard was opened. The only qualification is about *depth* on the machine-generated golden data, recorded in Uncertainties below.

---

## Uncertainties

- **Golden data files were read by prefix, not line by line.** For the ~40 `*.expected.jsonl`, `*.json` and `*.override.json` fixtures under `apps/cli/tests/**` I read the first 6–12 lines (and the whole file for the small ones) rather than every line. I checked that the remainder is homogeneous: the files are one JSON object per line, each a normalised `session_event` record or a scripted `{kind:'chunks', chunks:[…]}` response, with the same event vocabulary repeated. I confirmed the *shape* of the tail of the two largest goldens (`apps/cli/tests/expected/dump-config-schema.json:361-615` and `apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts:421-593`) in full, so the characterisation of every golden file rests on its header plus a sample of its body. In the completion pass the largest goldens I read end-to-end were `apps/cli/tests/profiles/headless/tests/expected/headless-profile/session.expected.jsonl` (26 lines) and the two ACP goal goldens (47 and 41 lines, read with their long fields truncated to 420 characters each).
- **The shard is the launcher, not the agent loop.** The loop, the tool registry, compaction, the memory store and the subagent runtime live in `packages/core/*` and `packages/agent/*`, which are other shards. Where this shard *observes* those mechanisms (the request header's tool list, the `compaction/start|summary` events, the `subagent/catalog` and `subagent/descriptor` events, the `sandbox/mode` and `approval/policy` events, the `agent/inbox/spliced` events), I have described what the observation shows and not claimed to have read the implementation. The event names and their payloads are quoted from the goldens and the assertions in this shard.
- **The `composition.md` "app package expansion is curated from package source"** means the plugin-id → package table is partly hand-maintained; the row list is generated. I did not open `scripts/gen-doc-graphs.ts` to confirm which half is which beyond the file's own footer.
- **`apps/cli/reference/README.md` is 146 lines but states roughly a hundred separate contracts.** I treated each of them as a fact, and quoted the ones that carry a mechanism. Where the reference asserts a behaviour that no test in *this* shard pins, I have not verified it elsewhere in the repository.
- **`apps/cli/tests/profiles/acp/cordis.yml` is a one-line pointer** to `snapshots/acp/escalation-approved/cordis.yml`, which is outside this shard. I read the pointer but not the target, so the ACP profile's actual composition is only known second-hand through the tests that use it. The same applies to the two places inside the shard that point outside it: `apps/cli/tests/profiles/acp/tests/goal.expected.e2e.ts:30` and `apps/cli/tests/profiles/acp/tests/image-offload.expected.e2e.ts:13` name that snapshot path directly, and `apps/cli/tests/profiles/acp/tests/image-offload.expected.e2e.ts:19` points at `snapshots/session/read-image/workspace/`.
- **Two suites are Windows-hostile by construction**: `apps/cli/tests/headless-shutdown.e2e.ts` (POSIX PTY) and `apps/cli/tests/profiles/sdk/office-cli.e2e.ts` (`process.platform === 'win32'` skip). I read them but could not reason about their Windows behaviour beyond what their own skip conditions state. Two more in this shard are *conditionally* skipped: `apps/cli/tests/profiles/acp/tests/escalation.e2e.ts:47-55` skips without a usable `bwrap`/`sandbox-exec` runner, and `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts:25-35` skips the non-loopback and zoned-IPv6 cases when the corresponding address cannot be probed on the host.
- **The completion pass corrected one citation from the first pass.** The first pass cited the preset suite under a path that does not exist — it placed the file under `apps/cli/tests/profiles/web/tests/`, but the file actually sits one level up, directly under `apps/cli/tests/`. The line numbers were correct for the real file and have been kept with the corrected path, `apps/cli/tests/web-agent-presets.e2e.ts`. Every other citation in this report was re-checked against the clone and resolves.
- **The manifest was read, never written.** I took the shard's file list from the `owner-shard` column of `C:/Dev/august-proxy/docs/research/deepseek-harness/manifest.tsv` and found 182 rows whose fourth column is exactly `dsh-apps-cli`; the ledger and this report both cover exactly those 182 paths. I did not modify the manifest.
