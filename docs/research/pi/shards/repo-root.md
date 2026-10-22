# pi / repo-root

## Shard shape

This shard is pi's **repository-level contract layer** — the files that decide what pi is allowed to contain, how it is built and tested, and what its on-disk configuration looks like, rather than how the agent loop actually runs. It holds four things: (1) the **monorepo build/release spine** — the root `package.json` workspace map, Biome/TypeScript/Vitest configuration, the `npm run check` gate chain, the `test.sh` isolation harness, the Nix packaging and its content-addressed model-catalog pin, and the per-package `install-lock/` that gives the pi.dev installer a pinned transitive tree the plain npm install does not get; (2) the **dependency-supply-chain policy** — exact pins, `min-release-age=2`, a pre-commit lockfile gate, and a `SECURITY.md` that states pi's trust boundary explicitly ("pi runs with the user's own permissions; containerize it if you need more"); (3) the **four GENERATED JSON Schemas** (`settings`, `models`, `keybindings`, `theme`) plus the two generator scripts that produce them — this is the single richest artefact in the shard, because it is the whole configuration surface expressed as data, and the generators are the mechanism that keeps docs, validators and editors from drifting; and (4) the **prose contract** — the top-level README, `AGENTS.md` (the rules an agent must obey in this repo), `CONTRIBUTING.md`, `SECURITY.md`, the `packages/ai/README.md` (the provider/model abstraction's public API, read in full), and the two large per-package CHANGELOGs, which in pi function as the design-decision record: nearly every mechanism in the agent, TUI and provider layers is explained there with the reason and the bug it fixed. The actual agent loop, provider adapters, TUI renderer, chord runtime and extension host live in other shards; this shard only holds the edges that plug into them — the config schema, the build, the test rig, and the prose.

## Per-file notes

### .gitattributes
- Purpose: repo-wide line-ending and binary policy.
- Key abstractions: `* text=auto eol=lf` with CRLF forced on `*.bat`, `*.cmd`, `*.ps1` (Windows tooling) and LF on `*.sh`.
- Data flow: checked out on any platform; pi is cross-platform so CRLF/LF must not depend on the contributor's OS.
- Non-obvious design decisions: `packages/agent/docs/**/*.diff -whitespace` preserves whitespace exactly in archived patch artifacts — a patch whose whitespace was normalised no longer applies.
- Edge cases / failure handling: `*.png`…`*.woff2` marked `binary` so git never tries to diff them.
- Surprising: the diff exemption implies pi keeps regression patches as committed artefacts, not just tests.

### .gitignore
- Purpose: what must never enter the index.
- Key abstractions: `packages/ai/src/providers/data/` (hydrated model catalog data) and `packages/ai/src/providers/.model-generation-*/` are ignored, with `AGENTS.md:28` forbidding even looking for them in git history.
- Data flow: the model catalog is *fetched* at build time (`npm run generate:models`) rather than committed; only the generated TypeScript wrapper is tracked.
- Non-obvious design decisions: local user state is ignored at the repo level (`.pi/settings.json`, `.pi/hf-sessions/`) so a developer's own settings never leak into a commit; scratch names (`todo.md`, `plans/`, `collect.sh`, `out.jsonl`) are listed because pi's own AGENTS rules forbid leaving scratch files behind.
- Edge cases / failure handling: `packages/coding-agent/binaries/`, `packages/env/bin/` and `packages/env/daemon/target/` are ignored (Rust/Go build outputs).
- Surprising: the ignore list doubles as an enforcement of the "delete your scratch files" rule — the names are enumerated so a leftover is visible in `git status`.

### .husky/pre-commit
- Purpose: the gate that runs before any commit.
- Key abstractions: three phases — (1) `node scripts/check-lockfile-commit.mjs` (a lockfile change is a *reviewed* change and must be explicitly acknowledged with `PI_ALLOW_LOCKFILE_CHANGE=1`); (2) `npm run check` (Biome with `--write`, pinned-dep check, runtime-dep check, ts-import check, entry-graph check, install-lock check, `tsc --noEmit`, browser-smoke check); (3) a **staged-file-scoped** browser smoke that only fires when `packages/ai/*`, `packages/web-ui/*`, `package.json` or `package-lock.json` are among the staged files.
- Data flow: `git diff --cached --name-only` → phase decisions → `npm run check` → re-`git add` the staged files (the formatter rewrote them) → commit.
- Non-obvious design decisions: the browser smoke is *conditional on what changed*, not run on every commit — the cost is paid only where it can fail. The re-staging loop is deliberate: `npm run check` runs Biome with `--write`, so the working tree changes under the user.
- Edge cases / failure handling: each phase checks `$?` and exits 1 with a message; a separate `apps/p2` sub-check exists because that app has its own Biome/TypeScript configs and lives outside the root ones.
- Surprising: the hook never commits — it only refuses to let a bad commit through.

### .npmrc
- Purpose: two lines that are the whole npm-side supply-chain policy.
- Key abstractions: `save-exact=true` (every direct dependency pinned to an exact version) and `min-release-age=2` (npm refuses any release published less than two days ago).
- Data flow: read by npm at install/resolve time.
- Non-obvious design decisions: `min-release-age` is npm's own supply-chain valve — a malicious or broken release published minutes ago cannot enter a lockfile resolution, which closes the "compromised maintainer" window without any pi-side tooling.
- Edge cases / failure handling: the two-day delay also means a hotfix cannot be picked up immediately; that is the accepted trade.
- Surprising: `README.md:173` restates both settings in prose, so the policy is discoverable without reading the file.

### AGENTS.md
- Purpose: the rules an agent (or human) must follow when working in this repo.
- Key abstractions: the file is organised as Conversational Style / Code Quality / Commands / Dependency and Install Security / Git / Issues and PRs / Changelog / Releasing / User Override, and ends with an explicit precedence rule: "If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding."
- Data flow: `AGENTS.md` is auto-loaded into an agent's context when the agent runs in the repo root (CONTRIBUTING.md:19 tells you to run the agent from the repo root so it picks the file up); `README.md:100` links it for humans too.
- Non-obvious design decisions: **erasable-syntax-only TypeScript** (`AGENTS.md:24`) — no `enum`, `namespace`, `import =`, or parameter properties anywhere under `packages/*/src`, `packages/*/test` or the examples — so the whole tree can run under Node's type-stripping mode without a build step. Enforced in `tsconfig.base.json:7` (`erasableSyntaxOnly: true`). "No inline imports (`await import()`)" is the same idea applied to module loading.
- Edge cases / failure handling: `AGENTS.md:34` — "Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present"; run `./test.sh` instead, which is exactly what `test.sh` implements (an `env -i` sandbox with no ambient keys). `AGENTS.md:37` — if you touch a test file you must run it.
- Surprising: the Git section (`AGENTS.md:54-72`) is written for *multiple concurrent agents in one checkout*: stage explicit paths, never `git add -A`/`git add .`, never `git reset --hard`/`git checkout .`/`git clean -fd`/`git stash`, and if a rebase conflict touches a file you did not modify, abort and ask. This is a concrete acknowledgement that an agent harness is often multi-agent.

### biome.json
- Purpose: lint + format configuration, and the file-selection boundary for both.
- Key abstractions: `recommended: true` with `noExplicitAny`, `noNonNullAssertion`, `noEmptyInterface`, `noControlCharactersInRegex` and `useNodejsImportProtocol` off; formatting is tab-indented at width 3 with a 120-column line width; a `files.includes` allowlist of `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts` and the two examples trees, with `models.generated.ts` and `*.models.ts` excluded.
- Data flow: `npm run check` invokes `scripts/biome-check.mjs --write`, so Biome both lints and rewrites.
- Non-obvious design decisions: the *exclude* of `!**/models.generated.ts` and `!**/*.models.ts` keeps the generated catalogue out of formatting churn (the generator owns those files). `noExplicitAny: off` is a deliberate loosening; `AGENTS.md:18` still says "No `any` unless absolutely necessary", so the policy lives in prose while the linter stays permissive.
- Edge cases / failure handling: the includes list also excludes `apps` and `node_modules`, and `packages/mom/data/**` (another package's data).
- Surprising: a custom **Grit** plugin (`scripts/biome/model-type-comparison.grit`) is registered — Biome can host domain-specific pattern rules.

### CONTRIBUTING.md
- Purpose: the contribution gate, and the philosophy it enforces.
- Key abstractions: "**pi's core is minimal**" — "If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected." Plus "**The One Rule**: You must understand your code."
- Data flow: new contributors' issues and PRs are auto-closed by default; a maintainer replies `lgtm` (issues *and* PRs) or `lgtmi` (issues only) to opt them in, and the command must be at the start of the reply or at the end.
- Non-obvious design decisions: `CONTRIBUTING.md:43` — "Write in your own voice (do not use an LLM to generate text)". The gate exists because a tracking system flooded with agent-written issues costs more maintainer time than it returns (the FAQ at `:79-93` says so explicitly). `:91` — "Why not let AI triage everything? … It is not trusted to make final maintainer decisions."
- Edge cases / failure handling: ignoring the document twice, or spamming the tracker with agent-generated issues, means a permanent block (`:50-54`).
- Surprising: `:69` — "Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers." (Note: `AGENTS.md:102-118` says the opposite for *agents* — they append under `## [Unreleased]`. The two documents address different audiences.)

### flake.lock
- Purpose: pins the two nixpkgs inputs by revision and content hash.
- Key abstractions: two nodes, `nixpkgs` (nixos-unstable) and `nixpkgs-darwin-x64` (nixpkgs-26.05-darwin).
- Data flow: consumed by Nix at build time; `flake.nix:27` selects the Darwin-specific nixpkgs only for `x86_64-darwin`.
- Non-obvious design decisions: the second input exists because "nixpkgs unstable no longer supports Intel macOS" (`flake.nix:7-8`), so pi keeps the final Darwin branch that does.
- Edge cases / failure handling: n/a — this is a generated lockfile with hashes, so a changed input is a visible diff.
- Surprising: the comment explains a *dependency-pin* decision in the flake, not in a changelog.

### flake.nix
- Purpose: the Nix entry point: packages, apps and an overlay.
- Key abstractions: `systems = [aarch64-darwin, aarch64-linux, x86_64-darwin, x86_64-linux]`; `nixpkgsFor` picks the Darwin fork for Intel macOS; `packagesFor` calls `./nix/package.nix`.
- Data flow: `nix run github:earendil-works/pi/stable` resolves `self.packages.${system}.default`, whose `installPhase` wraps `dist/bundle/cli.js`.
- Non-obvious design decisions: an `overlays.default` is exported so downstream flakes can consume `pi` as a normal nixpkgs package.
- Edge cases / failure handling: Nix builds are offline by design (see `README.md:66`) — the model catalog is fetched by pinned hash, not by a live API call.
- Surprising: the flake is the only place where pi's *reproducibility* story is visible at a glance: no network at build time except one content-addressed fetch.

### LICENSE
- Purpose: MIT licence text, Copyright (c) 2025 Mario Zechner.
- Key abstractions: none.
- Data flow: n/a.
- Non-obvious design decisions: MIT, so the harness is permissively reusable — the point of pi.
- Edge cases / failure handling: n/a.
- Surprising: the author is the same person credited in `packages/ai/package.json:91`, and pi.dev is a donated domain (`README.md:202-206`).

### nix/model-catalog.json
- Purpose: pins the model catalog by **content hash**, not by version.
- Key abstractions: a single field `revision` holding a `sha256-…` digest.
- Data flow: `nix/package.nix:28-29` uses it twice — as the URL path segment (`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`) and as `fetchurl`'s `sha256` (with the prefix stripped). The same hash is the fetch's expected content hash, so a tampered catalog cannot be fetched.
- Non-obvious design decisions: the revision is the *typed* catalog (`types=chat,image,classifier`) — the comment at `nix/package.nix:27` says so explicitly, because the hash is over that representation's bytes.
- Edge cases / failure handling: `README.md:66` — "The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type"; `npm run update:model-catalog-pin` refreshes it by hand.
- Surprising: a single JSON file of one hash is the mechanism that makes an offline, reproducible Nix build of a *model catalogue* possible.

### nix/package.nix
- Purpose: the actual Nix derivation for pi.
- Key abstractions: two derivations — `workspacePackages` (builds the monorepo packages from source and `npm pack`s each into a tarball) and the outer `pi` package (installs the separate `install-lock` tree with `packageSourceOverrides` pointing the internal packages at the locally built tarballs).
- Data flow: `buildPhase` runs `node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}` (writes the pinned catalog into the source tree) then `npm run build:offline`; `installPhase` copies the install-lock tree to `$out/lib/pi` and `makeWrapper`s node around `dist/bundle/cli.js`.
- Non-obvious design decisions: `npmRebuildFlags = [ "--ignore-scripts" ]` in both derivations — no dependency lifecycle script ever runs during the build. The PATH is composed *carefully*: node is appended (so a bash-tool shell keeps the user's own node/npm from mise or nvm) while `fd`, `ripgrep` and the clipboard tools are *prepended* (they are pi's own dependencies).
- Edge cases / failure handling: `installCheckPhase` asserts `pi --version` equals the package version, then `require()`s every TUI native `.node` prebuild and `photon-node` — "so missing native dependencies fail the build rather than silently disabling clipboard support".
- Surprising: the package installs the *install-lock* tree rather than the workspace tree, so the published artefact's dependency resolution is exactly the pinned one the pi.dev installer uses.

### package-lock.json
- Purpose: npm's resolved dependency graph for the whole monorepo (lockfileVersion 3).
- Key abstractions: a `packages` map keyed by install path, each entry carrying `version`, `resolved` registry URL, `integrity` sha512 and its own dependency edges.
- Data flow: `npm ci --ignore-scripts` in CI (`README.md:179`), `npm install --package-lock-only --ignore-scripts` when metadata changes (`AGENTS.md:48`).
- Non-obvious design decisions: `README.md:174` calls it "the dependency ground truth", and `README.md:176` distinguishes it from `packages/coding-agent/install-lock/`, which is derived from it for the installer.
- Edge cases / failure handling: committing a lockfile change is blocked by the pre-commit hook unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- Surprising: pi's CI also runs `npm audit --omit=dev` **and** `npm audit signatures --omit=dev` on a schedule — signature verification of published tarballs, not just version pinning.

### package.json
- Purpose: the root workspace manifest and the script spine.
- Key abstractions: workspaces `packages/*` plus five *example-extension* workspaces (`with-deps`, `custom-provider-anthropic`, `custom-provider-gitlab-duo`, `sandbox`, `gondolin`); the `build` script builds the packages in a strict dependency order (telemetry → chord → tui → codemode → mcp → ai → durable → env → agent → coding-agent); `check` is a chain: biome `--write`, pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, `tsc --noEmit`, browser-smoke.
- Data flow: `npm run check` is what `AGENTS.md:32` requires after code changes ("full output, no tail"), and it is what the pre-commit hook runs.
- Non-obvious design decisions: eight *named static gates* rather than one linter invocation — each is a separate script under `scripts/` (owned by the `scripts-ci` shard) and each catches a class the others cannot. `check` deliberately does **not** run tests; `AGENTS.md:33` forbids `npm run build` and `npm test` unless requested.
- Edge cases / failure handling: `overrides: { protobufjs: "7.6.6" }` forces one protobuf version across the tree (a transitive-conflict resolution). `engines.node >= 22.19.0` because the tree uses Node's type-stripping mode and `erasableSyntaxOnly`.
- Surprising: the example-extension workspaces are first-class members of the build — pi's extension ecosystem is compiled and type-checked with the core, so a broken example breaks CI.

### packages/ai/bedrock-provider.d.ts
- Purpose: hand-written type shim so the published subpath `@earendil-works/pi-ai/bedrock-provider` resolves from a *source* checkout where `dist/` does not exist yet.
- Key abstractions: one line — `export * from "./dist/bedrock-provider.js";`.
- Data flow: the built artifact comes from `packages/ai/src/bedrock-provider.ts`; this file re-exports it.
- Non-obvious design decisions: it exists because Bedrock's AWS SDK must be loaded through a bundler-opaque Node-only import (`packages/ai/README.md:1755-1764`), so the package needs a stable, explicitly-overridable entry point.
- Edge cases / failure handling: the README documents that a single-file bundle must call `setBedrockProviderModule(bedrockProviderModule)` explicitly or the opaque runtime import will look for a file that is not there.
- Surprising: a 44-byte file carries a real deployment contract.

### packages/ai/bedrock-provider.js
- Purpose: the runtime twin of the `.d.ts` shim — same one-line re-export of `./dist/bedrock-provider.js`.
- Key abstractions: none beyond the re-export.
- Data flow: same as the `.d.ts`.
- Non-obvious design decisions: keeping the `.js` and `.d.ts` side by side at the package root means a consumer can `import { setBedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider'` in plain Node ESM without a build step.
- Edge cases / failure handling: n/a.
- Surprising: it is the only file in the package that is not covered by `packages/ai/tsconfig.build.json` (whose `include` is `src/**/*.ts` and whose `exclude` drops every `**/*.d.ts`).

### packages/ai/CHANGELOG.md
- Purpose: the design-decision record for the provider/model layer.
- Key abstractions: the standard Keep-a-Changelog shape (`### Breaking Changes / Added / Changed / Fixed / Removed`) under `## [Unreleased]`, with issue and PR links on every entry.
- Data flow: `AGENTS.md:104-118` requires new entries to be appended under `## [Unreleased]` and forbids editing released sections.
- Non-obvious design decisions: the entries record *reasons*, not just changes. Examples read in this shard: `:1839` (a server-requested retry delay longer than `maxRetryDelayMs` **fails the request immediately** instead of waiting silently); `:2341` (provider-level tool-argument validation was *removed* so validation happens once in the agent loop and the model can retry on it); `:55` (model switching drops the previous model's thinking blocks instead of sending them as text, because "the new model previously saw the old model's reasoning as part of its replies and could start writing its own reasoning into the visible answer").
- Edge cases / failure handling: `:39` — any HTTP 413 now counts as context overflow so the caller compacts and retries; `:1444` — Bedrock throttling was being misidentified as context overflow, "causing unnecessary compaction instead of retry". These two sit one commit apart and show how easily the overflow/retry boundary is crossed by accident.
- Surprising: the changelog is the closest thing pi has to an ADR log; several entries name the specific provider error string that had to be classified.

### packages/ai/package.json
- Purpose: the published manifest for `@earendil-works/pi-ai` 1.4.0.
- Key abstractions: a **wildcard export map** — `./providers/*`, `./api/*`, `./utils/*` — plus named entries for `.`, `./models`, `./compat`, `./oauth`, `./bedrock-provider`, `./bun-oauth`; an explicit `sideEffects` array naming `compat.js`, `images.js` and `providers/images/register-builtins.js`; a `bin` entry `pi-ai` → `dist/cli.js`.
- Data flow: `scripts/` in the package generates models; `build:offline` typechecks with `tsconfig.build.json`, then deletes and re-copies `src/providers/data` into `dist/providers/data` (hydrated data is not compiled).
- Non-obvious design decisions: the wildcard subpaths are the *code-splitting surface* — `packages/ai/README.md:1711-1731` explains that importing `@earendil-works/pi-ai/models` avoids TypeBox, catalogs and SDKs entirely, and that `providers/<id>` imports only that provider's catalog plus a lazy API wrapper. The `sideEffects` list is what keeps the compat/image *registries* alive when a bundler tree-shakes.
- Edge cases / failure handling: `build` (online) regenerates the model data; `build:offline` uses existing hydrated data — the Nix path uses `build:offline` after hydrating from the pinned catalog.
- Surprising: `compat` is a *published entry point*, not a deprecated leftover — it is the old global API preserved verbatim so a consumer can migrate by changing one import path.

### packages/ai/README.md
- Purpose: the public API contract of the provider/model abstraction (read in full, 1995 lines).
- Key abstractions: the **provider is the runtime unit** (`:240`) — it owns its model catalog, its auth and its stream behaviour; a `Models` collection holds providers and routes each request to the provider that owns the model. Providers share **API implementations** (wire protocols): `anthropic-messages`, `openai-responses`, `openai-completions`, `google-generative-ai`, `bedrock-converse-stream`, `mistral-conversations`, `openai-codex-responses`, `azure-openai-responses`, `google-vertex`.
- Data flow: `models.stream(model, context)` → provider auth resolution → header merge → API implementation → a typed event stream (`start → text/thinking/toolcall start/delta/end → done | error`) → `await s.result()` for the final `AssistantMessage`. A `Context` is `{ systemPrompt, messages, tools }`; `normalizeContext()` is called **once** at the public entry points and everything below receives a `TranscriptContext` that has only `messages` (`:1618`).
- Non-obvious design decisions:
  - **Header merge order is specified exactly** (`:419-427`): `provider auth headers → model.headers → explicit options.headers → transformHeaders → Provider.stream*()`, merged case-insensitively, with `null` as the delete signal.
  - **`partial` is a live view, not a snapshot** (`:733`): "providers may mutate the same message and content blocks as generation advances … Inspect it when handling an event instead of retaining it as historical state." And `:752`: events for different content blocks are **not guaranteed to be contiguous** — consumers must use `contentIndex`.
  - **Errors never throw after the stream is returned** (`:1150`): a setup failure emits `error` with no `start`; a failure after generation emits `start`, updates, then `error`. Direct `streamSimple()` calls *do* throw synchronously when auth is missing.
  - **Auth distinguishes "absent" from "broken"** (`:401`): `getAuth()` resolves `undefined` for unconfigured but **rejects** with a `ModelsError` when the credential store or OAuth refresh actually failed.
  - **A stored credential owns its provider** (`:468`): env vars are consulted only when nothing is stored, and a failed refresh never silently falls back to an env key. `modify(providerId, fn)` is the only write path, and OAuth refresh runs *inside* it so concurrent processes cannot double-refresh a rotated token.
  - **Compat flags auto-detect from `baseUrl` and a partial `compat` merges with the detected defaults** (`:1481`).
  - **Cross-provider handoff drops thinking blocks when the model changes** (`:1582`) — signatures and encrypted reasoning only work with the model that produced them.
- Edge cases / failure handling: `constrainedSampling.strict` has `prefer` (fall back) and `require` (fail the request) semantics (`:571`); validation failure of a tool call is returned as a tool result with `isError: true` so the model can retry (`:714-724`); `generateImages()` and `classify()` **never reject** — they return a result with `stopReason: "error"` (`:818`, `:936`).
- Surprising: the **System One / classifier** API (`classify()` with `choice`/`score`/`bool` questions, `llama-cpp-classify` answering from next-token probabilities) puts structured classification in the same `Models` collection as chat, keyed on a model `type`. And `:1146`: "Telemetry does not record prompts, generated text, reasoning content, or arguments in attributes/events" — the telemetry contract is explicitly content-free, with the one documented exception (500 chars of provider error text) called out.

### packages/ai/tsconfig.build.json
- Purpose: the emit config for the published `dist/`.
- Key abstractions: `outDir: ./dist`, `rootDir: ./src`, `module/moduleResolution: NodeNext` (overriding the base's Node16), `include: ["src/**/*.ts"]`, `exclude: ["node_modules", "dist", "**/*.d.ts", "src/**/*.d.ts"]`.
- Data flow: `npm run build:offline` runs `tsc -p tsconfig.build.json`, then copies the hydrated `src/providers/data` directory into `dist/providers/data`.
- Non-obvious design decisions: excluding `**/*.d.ts` means hand-written declaration files under `src` are **not** re-emitted — they are inputs to the typecheck only.
- Edge cases / failure handling: `rootDir: ./src` means nothing outside `src` can be imported by a `src` file without a tsc error.
- Surprising: the build config uses NodeNext while the base uses Node16 — because the package ships ESM-only (`"type": "module"`).

### packages/ai/vitest.config.ts
- Purpose: test configuration for the provider package.
- Key abstractions: `testTimeout: 30000` "for API calls"; `reporters` switch to `["dot", "github-actions"]` under `GITHUB_ACTIONS`; `silent: "passed-only"`; one `resolve.alias` entry mapping `@earendil-works/pi-telemetry` to `../telemetry/src/index.ts`.
- Data flow: `npm test` in the package runs `vitest --run`.
- Non-obvious design decisions: the alias points at **source**, so the telemetry contract is exercised as written rather than as built; unlike the coding-agent package, this config does **not** set `PI_OFFLINE=1` — the ai package's live-provider tests opt in individually.
- Edge cases / failure handling: the 30-second timeout is generous enough for a real provider call, which is why `AGENTS.md:34` warns that the full suite activates live-API e2e tests when endpoint/auth env vars are present.
- Surprising: `globals: true` means test files do not import `describe`/`it`.

### packages/coding-agent/.gitignore
- Purpose: one line — `*.bun-build`.
- Key abstractions: n/a.
- Data flow: the Bun single-file binary build (`build:binary`) emits a `.bun-build` artefact that must not be committed.
- Non-obvious design decisions: the package-level ignore exists because the root `.gitignore` cannot know about package-specific build products.
- Edge cases / failure handling: n/a.
- Surprising: tiny, but it documents that pi ships a compiled binary as well as a npm package.

### packages/coding-agent/CHANGELOG.md
- Purpose: the design-decision record for the whole coding agent (6367 lines) — the closest thing pi has to an ADR log.
- Key abstractions: the same Keep-a-Changelog sections, but with a `### New Features` section above `### Added` that summarises the release in prose with links to `docs/*.md`.
- Data flow: `AGENTS.md:102-118` governs how entries are appended; `README.md:100` points humans at the RFCs for longer-term plans.
- Non-obvious design decisions (all read in this shard):
  - **Observation and action are different channels** (`:546`, `:552`): `ExtensionRunner.emit()` no longer accepts `turn_end`; actionable boundaries are dispatched separately via `emitBoundary(baseEvent, buildContext)`, and a handler returns `{ entries, continue: true }` to "persist structural entries in order and ensure one next provider request **without changing steering or follow-up scheduling**".
  - **The session manager is canonical for provider context** (`:545`): "Assigning `session.agent.state.messages` no longer replaces future request history." Context changes go through append-only edits (`:551`: `sessionManager.appendContextEdit(entryId, null)` omits a message from future provider context *without changing raw history, usage, or UI history*).
  - **The host restores what a mutating hook broke** (`:563`): `context` handlers no longer see system messages, and Pi restores the prompt and tool state after they run — because handlers that filtered messages were dropping tool declarations.
  - **Unknown is representable** (`:3637`): after compaction `ContextUsage.tokens` and `.percent` are `number | null`, because the count is genuinely unknown until the next LLM response. The footer renders `?/200k` (`:3652`).
  - **The system prompt is a cache key** (`:3318`, `:1446`, `:2648`, `:392`, `:351`): only the current date in ISO form (not the time, not a locale-dependent format) is included, "so prompt prefixes stay cacheable across reloads and resumed sessions"; the `codemode` description deliberately excludes deferred tools, tool counts and MCP server instructions "so it no longer changes when MCP servers connect or change their tools"; and that same work shrank a default GPT-5.6 request "from about 5,300 to 3,300 tokens".
  - **Queued messages have a defined interruption point** (`:3249`, `:5643`): steering waits "until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls", and queueing during tool execution interrupts the batch — "Remaining tools are skipped with an error result, and your queued message is processed immediately."
  - **The summarisation request is a different shape from the turn request** (`:35`, `:137`, `:840`, `:1262`): summaries use the model's *output limit* rather than a fixed cap (and `compaction.reserveTokens` "only controls when compaction starts"); `serializeConversation()` omits thinking blocks "because replayed thinking … could make a summarization request larger than the context it summarizes and fail"; summaries must not expose tools; and they use a fresh routing session id with prompt caching disabled where supported.
  - **Compaction failures are first-class events** (`:812`): `session_compact_failed` carries reason, retry state, source and error message; `session_before_compact`/`session_compact` carry `reason` and `willRetry` (`:1636`) so a handler can tell manual `/compact` from threshold compaction from overflow retry.
  - **Re-entrancy is handled at dispatch level** (`:547`, `:121`): runs requested from `agent_settled` handlers are deferred until every settled handler finishes; the session counts as busy *while a run starts*, so `pi.sendMessage()` queues into the starting run instead of racing it.
- Edge cases / failure handling: `:147` — print mode used to exit 0 with a truncated final response; it now prints the partial text, warns on stderr and exits 1. `:151` — a session broken by a response cut off at the output limit kept the tool results but dropped the truncated tool call, "so providers rejected every later request".
- Surprising: `:5590`-area entries show pi distinguishes **extension tools the branch never added or removed** (active by default) from ones registered with `defaultActive: false` (`:46`) — a resume/branch-navigation correctness detail that took a dedicated fix.

### packages/coding-agent/install-lock/package-lock.json
- Purpose: the resolved dependency tree for the **pi.dev installer**, kept separate from the repo lockfile.
- Key abstractions: lockfileVersion 3; the root entry depends only on `@earendil-works/pi-coding-agent` 1.4.0, and every transitive dependency is resolved and hashed.
- Data flow: the installer installs from this lock; `nix/package.nix:77-90` uses it as the npm root and overrides the internal packages with locally built tarballs.
- Non-obvious design decisions: `README.md:176` — "The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps." Two different supply-chain guarantees for two different installers, deliberately.
- Edge cases / failure handling: `npm run check:install-lock:coding-agent` (root `package.json:26`) regenerates and diffs it, so drift from the root lockfile fails `npm run check`.
- Surprising: `AGENTS.md:49` adds that new dependencies *with lifecycle scripts* require review and an explicit allowlist entry in the generator script — "never add one silently".

### packages/coding-agent/install-lock/package.json
- Purpose: the lock root for the installer.
- Key abstractions: `name: "@earendil-works/pi-coding-agent-install"`, `private: true`, one dependency pinned to an exact version (`@earendil-works/pi-coding-agent: 1.4.0`), the same `protobufjs` override as the root, and the same `engines.node >= 22.19.0`.
- Data flow: `scripts/generate-coding-agent-install-lock.mjs` derives this tree from the root lockfile; the installer runs `npm ci` against it.
- Non-obvious design decisions: the exact-version pin (not a range) for the package itself, because the whole point of this lock is reproducibility.
- Edge cases / failure handling: `engines` is repeated so the installer enforces the Node floor too.
- Surprising: 317 bytes carrying the entire promise that "the installer pins all dependencies and updates Pi with `pi update`" (`README.md:37`).

### packages/coding-agent/package.json
- Purpose: the published manifest for `@earendil-works/pi-coding-agent` 1.4.0.
- Key abstractions: `piConfig: { configDir: ".pi" }` — the package declares where its configuration lives; `bin: { pi: "dist/bundle/cli.js" }`; an `exports` map with `.` and `./rpc-entry` (the stdio RPC entry point); a `files` list shipping `dist`, `docs`, `examples`, `schemas` and `containerization.md`.
- Data flow: `build` = `build:unbundled` (tsc + chmod + copy-assets) then `scripts/build-coding-agent-bundle.mjs`; `build:binary` additionally compiles a Bun single-file executable and copies the WASM image library.
- Non-obvious design decisions: the generated **schemas are shipped in the npm package** (they are in `files`), so a consumer's editor gets `$schema` validation against pi's own schema. The schema/reference generators are run through the TS source resolver: `node --import ./src/experimental/source-resolver.ts scripts/generate-schemas.ts`.
- Edge cases / failure handling: `copy-assets` copies theme JSONs, interactive PNG assets and the HTML-export template/vendor JS explicitly — a build that forgets them produces a subtly broken TUI rather than a compile error.
- Surprising: `dependencies` pins all internal `@earendil-works/*` packages to **exact** versions (`1.4.0`), and `CHANGELOG.md:83` records why: "Pinned internal Pi dependencies to exact release versions to prevent fresh installs from mixing incompatible packages."

### packages/coding-agent/README.md
- Purpose: the package-level install and development README.
- Key abstractions: the same install story as the root README (installer script, npm with `--ignore-scripts`, `nix profile add`), plus the development loop.
- Data flow: `npm install --ignore-scripts` then `./pi-test.sh` — "can be called from any directory and preserves the caller's working directory".
- Non-obvious design decisions: `pi-test.sh` is presented as the *primary* way to run the agent (not `npm start`), because it runs the TypeScript sources directly.
- Edge cases / failure handling: the README repeats the pre-PR requirement (`npm run check` + `./test.sh`) and points at `AGENTS.md` for repository-specific rules.
- Surprising: it is mostly a subset of the root README — the repo keeps one canonical document rather than two drifting ones.

### packages/coding-agent/schemas/keybindings.schema.json
- Purpose: the published JSON Schema for `keybindings.json`.
- Key abstractions: every binding is a **dotted action id** with a human description — `tui.editor.*` (cursor, history, delete, yank), `tui.input.*`, `tui.select.*`, `tui.altScreen.*` (including `previousPrompt`/`nextPrompt`/`search`), `app.interrupt`, `app.thinking.cycle`, `app.model.cycleForward`, `app.session.*` (new/tree/fork/resume/rename/delete), `app.tree.filter.*`, `app.message.followUp` ("Queue follow-up message") and `app.message.dequeue` ("Restore queued messages").
- Data flow: generated by `scripts/generate-schemas.ts` from `src/core/keybindings-schema.ts`; published at `https://pi.dev/schemas/keybindings.schema.json`.
- Non-obvious design decisions: `additionalProperties` **allows** any additional key as a `KeybindingValue` — so a user-defined binding validates, but a typo'd action id is silently accepted as a custom binding (a deliberate trade of strictness for extensibility). The `KeybindingValue` pattern uses a negative lookahead forbidding a doubled modifier (`ctrl+…ctrl+`), so the schema rejects a nonsense binding instead of accepting it.
- Edge cases / failure handling: the value may be a single string or an array of strings (a chord).
- Surprising: the schema is a complete inventory of pi's *entire* key surface, and the two queue actions (`app.message.followUp` / `app.message.dequeue`) are the steering mechanism's UI contract.

### packages/coding-agent/schemas/models.schema.json
- Purpose: the published JSON Schema for `models.json` — the provider/model abstraction expressed as pure configuration data.
- Key abstractions: `providers` is an open map (any provider id) whose value carries `name`, `baseUrl`, `apiKey` ("Literal key, `\"$NAME\"` environment interpolation, or `\"!command\"` output"), `api`, `headers` (values "resolve like apiKey"), `authHeader`, `compat`, `models[]` and `modelOverrides{}`. A model entry carries `id`, `api` (overrides the provider's), `baseUrl`, `reasoning`, `thinkingLevelMap` (per-level provider values, `null` = unsupported), `input`, `inputLimits`, `cost` (with `tiers[]` for long-prompt pricing), `promptCache` (`short`/`long` lifetimes in seconds), `contextWindow` (default 128000), `maxTokens` (default 16384), `samplingParams` and `samplingParamsByThinkingLevel`.
- Data flow: generated from `src/core/model-config.ts` + the ai package's `ProviderCompatSchema` / `ModelCostSchema` / `ModelInputLimitsSchema` / `ModelPromptCacheSchema` / `ThinkingLevelMapSchema`; the same TypeBox objects are consumed by `scripts/generate-references.ts` to render the human reference page.
- Non-obvious design decisions: the `ProviderCompat` block is ~50 explicit capability booleans, each with a *stated default and reason* — `supportsMidConvoSystemMessages` ("When false, later system messages are folded into the leading system message"), `supportsMidConvoToolAdditions`, `supportsMidConvoEffort` (a thinking-level change sent *inside* the conversation so the prompt cache survives), `supportsStrictTools`, `supportsEagerToolInputStreaming`, `supportsCacheControlOnTools`, `supportsTemperature` ("Claude Opus 4.7+ rejects non-default values"), `supportsMaxOutputTokens` ("Some Codex-protocol gateways reject it"), `allowedFallbackModels` (max 3, with local pricing), `thinkingFormat` (11 named formats), `chatTemplateKwargs`/`chatTemplateArgs` with a `$var` escape hatch for `thinking.enabled|effort|budget` and `omitWhenOff`, `sessionAffinityFormat`, `cacheControlFormat`, `vllmPriority`, `imageInput` (`assets`/`images`/`state-image-urls`), and `sendImageOptInHeader`. The model→provider precedence is: model value overrides provider value **per field**.
- Edge cases / failure handling: `thinkingLevelMap` — "Levels the model does not map use the provider's default value through high; xhigh and max are unsupported" unless explicitly mapped; `null` marks a level unsupported. `cost.tiers` applies "the highest matching input threshold … to the full request".
- Surprising: `ProviderCompat.additionalProperties` is **true**, so an unknown compat flag is passed through rather than rejected — the schema is deliberately permissive at the leaf so a newer ai package's flags survive an older coding-agent.

### packages/coding-agent/schemas/settings.schema.json
- Purpose: the published JSON Schema for `settings.json` — the whole runtime configuration surface.
- Key abstractions: `steeringMode` and `followUpMode` (each `"all" | "one-at-a-time"`, default `one-at-a-time`); `compaction` (`enabled`, `reserveTokens` 16384, `keepRecentTokens` 20000, `modelOverrides` keyed by exact `"provider/modelId"`); `branchSummary` (`reserveTokens`, `skipPrompt`); `retry` (`enabled`, `maxRetries` 3, `baseDelayMs` 2000 "Exponential backoff base delay in milliseconds: 2s, 4s, 8s", `maxAgentDelayMs` 60000, `provider.timeoutMs`, `provider.maxRetries`, `provider.maxRetryDelayMs` 60000); `transport` (`auto|sse|websocket|websocket-cached`); `codemode.mode` (`on|only`) with `inlineBudget` 3000; `cacheWarming` (`off|streaming|idle`, default `streaming`, "Global only because each refresh costs money"); `defaultProjectTrust` (`ask|always|never`); `packages[]` (npm/git sources, string form or object form with `autoload` and per-kind `extensions`/`skills`/`prompts`/`themes` filters); `defaultTools` ("Plain names replace the inherited selection; `+name` and `-name` entries add or remove tools"); `doubleEscapeAction` (`fork|tree|none`); `treeFilterMode`; `sessionDir`; `httpIdleTimeoutMs`; `websocketConnectTimeoutMs`; `thinkingBudgets` per level; `modelThinkingLevels` per `"provider/modelId"`.
- Data flow: generated from `src/core/settings-schema.ts`; `packages/coding-agent/package.json:39` runs the generator; the schema is published and shipped in the npm package.
- Non-obvious design decisions:
  - **Deprecated keys are kept and marked** rather than deleted: `retry.maxDelayMs` ("Legacy retry delay setting. Use provider.maxRetryDelayMs instead."), `queueMode` ("Legacy setting migrated to steeringMode."), `websockets` ("Legacy setting migrated to transport."), and the object form of `skills` (`enableSkillCommands`/`customDirectories`) marked `deprecated`.
  - **`additionalProperties: true`** at the top level, so an unknown setting does not break a config file.
  - **The retry ceiling is a first-class setting with the refusal written into the description**: `provider.maxRetryDelayMs` — "Maximum server-requested delay before failing." The `packages/ai/CHANGELOG.md:1839` entry supplies the reason: a provider asking for a delay longer than the ceiling fails the request immediately with an informative error "instead of waiting silently", default 60000 ms, `0` disables the cap.
  - **Money-spending and identity features are explicitly global-only**: `cacheWarming` ("Global only because each refresh costs money"), `defaultProjectTrust` ("Global setting only."), `deviceId` ("Global only.").
  - **Per-model overrides are keyed by exact `"provider/modelId"`**, for both compaction budgets and thinking levels.
- Edge cases / failure handling: `quietStartup` is `boolean | "header"`; `terminal.images` is `kitty|iterm2|auto|false`; `httpIdleTimeoutMs` and `websocketConnectTimeoutMs` accept `0` or the string `"disabled"` to mean the same thing.
- Surprising: the settings schema contains **two separate queue-mode settings** (`steeringMode`, `followUpMode`) — pi distinguishes "interrupt/steer the running turn" from "queue a follow-up for after it" as two different policies with two different settings, both defaulting to `one-at-a-time`.

### packages/coding-agent/schemas/theme.schema.json
- Purpose: the published JSON Schema for `theme.json`.
- Key abstractions: a required `name` (pattern `^[^/]+$` because "/" is reserved for automatic light/dark theme settings), an optional `appearance` (`dark|light`, "Detected from the theme colors when omitted"), a `vars` map of reusable colour variables, and a `colors` object with **~50 required named colours** — accent/border family, success/error/warning/muted/dim/text, thinking-text, the three tool-box states (`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`), the full markdown colour set, the diff colours, the syntax-highlighting set, and one colour per thinking level (`thinkingOff`…`thinkingXhigh`).
- Data flow: generated from `src/modes/interactive/theme/theme-schema.ts`.
- Non-obvious design decisions: the required set is large and explicit because a theme that omits a colour silently inherits the default; the *optional* colours carry their fallback **in the description** ("scrollbarTrack … falls back to muted when omitted", "thinkingMax … falls back to thinkingXhigh when omitted", "searchMatchBg … falls back to selectedBg when omitted"). `additionalProperties: false` on `colors` — a typo'd colour name is an error, not a no-op. A separate `export` object holds HTML-export colours (`pageBg`, `cardBg`, `infoBg`) so the HTML export has its own palette.
- Edge cases / failure handling: `ColorValue` is a union of a string (hex `#RGB`/`#RRGGBB`, OKLCH/OKHSL, a variable reference, or the empty string for the terminal default) **or** an integer 0-255 for the 256-colour palette.
- Surprising: `infoBg` is documented as "Info sections background (system prompt, notices)" — the theme schema names the *system prompt surface* as a first-class UI region.

### packages/coding-agent/scripts/generate-references.ts
- Purpose: generates the human-readable `docs/models-configuration.md` **from the same TypeBox schemas the validator uses**.
- Key abstractions: a `ReferenceArtifact` list (currently one: models configuration) whose `sections` name a heading, an intro, a `schema` to tabulate, a `links` map (top-level fields that link to another section instead of expanding), and a `collapsed` list (top-level fields listed without their nested fields); a `ReferenceSchema` interface that is explicitly "The subset of JSON Schema that reference pages render".
- Data flow: imports `CompatSchemasByApi` from the ai package and `ModelsJsonSchemas` from `src/core/model-config.ts` → `referenceRows()` walks `properties` → a markdown table per section → written to `docs/models-configuration.md`.
- Non-obvious design decisions:
  - **`referenceType()` derives a human type string from the schema** (`:101-110`) rather than carrying a second hand-written type table; `anyOf` branches are unioned and de-duplicated, arrays get `[]` appended, and a union item is parenthesised.
  - **`documentedObject()` (`:113-123`) only recurses into a nested object when at least one of its fields carries a `description` or a `default`. A nested object with no documentation is listed by name, not expanded — so the reference page cannot drift into documenting undocumented internals, and cannot go stale when an undocumented field is added.
  - **The merge rule is stated in prose in the generated page** (`:78`): "Object fields, such as `cost`, merge with the model's value field by field; other fields replace it."
  - **The compat schemas are grouped by identity, not by name** (`:47-50`, `:91-96`): APIs that share one schema object are listed together, with the aliases named ("Also applies to `…`").
- Edge cases / failure handling: `escapeTableText` escapes `|` and `<` so a description containing a pipe cannot break the table; the "Required." marker is prepended to the description when the field is in `required`.
- Surprising: the file exports `renderReferences()` as a pure function *and* runs the writer only when invoked as the entry point (`import.meta.url` guard at `:175`) — so a test can render the reference and diff it against the committed file without touching the filesystem.

### packages/coding-agent/scripts/generate-schemas.ts
- Purpose: generates the four published JSON Schemas (`models`, `settings`, `keybindings`, `theme`) from TypeBox.
- Key abstractions: a `SchemaArtifact` list pairing a filename with a schema and optional shared `definitions`; `splitAnnotations()` separates JSON-Schema **annotation** keys (`default`, `deprecated`, `description`, `examples`, `readOnly`, `title`, `writeOnly`) from **shape** keys; `addDefinitions()` rewrites repeated sub-schemas into `$defs` references.
- Data flow: `serializeSchema()` emits `{ $schema: draft-2020-12, $id: "https://pi.dev/schemas/<file>.schema.json", $comment: "<generated notice>", ...schema }` with 2-space JSON and a trailing newline → written to `packages/coding-agent/schemas/`.
- Non-obvious design decisions:
  - **`$defs` are deduplicated by SHAPE IDENTITY, not by name** (`:94-106`): the generator computes `JSON.stringify(shape)` for each candidate definition and replaces any occurrence of a matching shape with `{ $ref: "#/$defs/<Name>", ...annotations }`. Two logically identical schemas collapse to one definition *even if they were declared under different names*, and per-use annotations survive the rewrite.
  - **A definition that is never referenced is a BUILD ERROR** (`:120-125`): `throw new Error("Unused schema definitions: …")`. This is the cheapest possible dead-weight detector — a definition that stops being referenced because its use site was deleted fails the generator rather than shipping.
  - **Definition names are validated** against `^[A-Za-z][A-Za-z0-9_-]*$` (`:86-88`) so a `$ref` is always well-formed.
  - **A definition cannot reference itself** (`excludedName` at `:118`).
- Edge cases / failure handling: `renderConfigSchemas()` is exported separately from the writer (`:143-159`) so a test can assert the rendered bytes without writing files.
- Surprising: the `$comment` on every published file is the human instruction "This file is generated from TypeScript source. Do not edit it manually; run `npm run generate:schemas`." — the artefact itself carries its own provenance.

### packages/coding-agent/scripts/migrate-sessions.sh
- Purpose: a one-shot repair for sessions written to the wrong directory by a v0.30.0 bug.
- Key abstractions: `AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"`; the target layout `sessions/--<encoded-cwd>--/`; a `--dry-run` flag.
- Data flow: for each `*.jsonl` directly in the agent dir → `head -1` → `jq -r '.cwd // empty'` → `sed` the cwd into `--<path-with-dashes>--` → `mkdir -p` + `mv`.
- Non-obvious design decisions: the encoding strips the leading slash and replaces `/`, `:` and `\` with `-`, which is the same on-disk naming the session manager uses — the migration reproduces the target's convention rather than inventing one.
- Edge cases / failure handling: every failure mode is a **skip with a counted reason** (unreadable file, invalid JSON, no `cwd` in the header, target already exists) and never overwrites an existing target. The run prints `Migrated: N / Skipped: M`.
- Surprising: it is the only script in the shard that hard-depends on `jq` — a deliberate dependency on a standard tool rather than a reimplementation.

### packages/coding-agent/tsconfig.build.json
- Purpose: the emit config for the coding agent's `dist/`.
- Key abstractions: `paths` resolving `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` (and their `/*` subpaths) to the **built `.d.ts`** of the sibling packages; `rootDir: ./src`; `include: ["src/**/*.ts", "src/**/*.d.ts"]`.
- Data flow: `npm run build:unbundled` runs `tsc -p tsconfig.build.json` then chmods `dist/cli.js` and `dist/rpc-entry.js`.
- Non-obvious design decisions: the build resolves siblings through their *published* type surface, so the coding agent is type-checked against the exact API its consumers will see — a different discipline from the root `tsconfig.json`, which resolves siblings to **source**.
- Edge cases / failure handling: `exclude: [..., "src/experimental"]` keeps the unreleased experimental stack out of the published build (and `packages/coding-agent/CHANGELOG.md:167` records the removal of the whole experimental server/client/plugin stack).
- Surprising: the same repo type-checks the package twice, against two different dependency surfaces — source for development, dist for publication.

### packages/coding-agent/tsconfig.examples.json
- Purpose: a separate, `noEmit` typecheck for `examples/`.
- Key abstractions: `paths` resolving `@earendil-works/pi-coding-agent`, `.../hooks`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` and `typebox` to **source** rather than dist.
- Data flow: `include: ["examples/**/*.ts"]`.
- Non-obvious design decisions: examples are type-checked against the *unpublished* API surface on purpose — an example may use an internal export, and the moment it is published the example stops being representative. `AGENTS.md:24` explicitly includes `packages/coding-agent/examples` in the erasable-syntax-only zone, so examples are held to the same runtime constraint as production code.
- Edge cases / failure handling: `skipLibCheck: true` so a dependency's own type errors do not block the example check.
- Surprising: `tsconfig.examples.json` is not referenced by any npm script in this shard's `package.json` — it exists for the root `tsc --noEmit` include sweep (`tsconfig.json:52` includes `packages/coding-agent/examples/**/*`).

### packages/coding-agent/vitest.config.ts
- Purpose: the test configuration for the coding agent.
- Key abstractions: `env: { PI_OFFLINE: "1" }` with the comment "Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts"; `unstubEnvs: true`; 30s timeout; `server.deps.external: [/@silvia-odwyer\/photon-node/]`; aliases resolving pi-ai, pi-agent-core and pi-tui to workspace source (plus the legacy `@mariozechner/*` names).
- Data flow: `npm test` → `vitest --run`; `mergeConfig(baseConfig, …)` inherits the alias table from `vitest.base.ts`.
- Non-obvious design decisions: **network access is off by default and opt-in per test** — the offline switch is a *default*, not a prohibition, and `allowNetwork()` is the documented escape hatch. `unstubEnvs: true` undoes `vi.stubEnv` after each test, which is exactly what a harness needs when a test stubs an API key.
- Edge cases / failure handling: the legacy `@mariozechner/pi-ai` aliases exist so older example code and third-party extensions keep resolving.
- Surprising: the alias for `pi-tui` maps the *whole* package to `packages/tui/src/index.ts`, so a TUI bug is reproducible in a unit test without building the native module (which is why `photon-node` is externalised rather than aliased).

### pi-test.bat
- Purpose: the Windows entry point for running pi from source.
- Key abstractions: `setlocal`, `SCRIPT_DIR=%~dp0`, and a `where powershell.exe` probe.
- Data flow: `pi-test.bat <args>` → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%pi-test.ps1" %*` → exit code propagated via `exit /b %ERRORLEVEL%`.
- Non-obvious design decisions: `-ExecutionPolicy Bypass` because the default Windows policy blocks unsigned local scripts; `-NoProfile` so a user's PowerShell profile cannot alter the run.
- Edge cases / failure handling: if `powershell.exe` is absent (or blocked by an AppLocker rule), the script prints "powershell.exe not found. Install PowerShell or run pi-test.ps1 directly." and exits 1 rather than emitting a cryptic error.
- Surprising: 352 bytes that exist purely to bridge cmd.exe to PowerShell.

### pi-test.ps1
- Purpose: runs pi from TypeScript source on Windows, with an optional credential scrub.
- Key abstractions: the `--no-env` flag and the list of 36 environment variables it removes (every major provider key, the OAuth tokens, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`/`GITHUB_TOKEN`, `HF_TOKEN`, the Google Cloud variables, the whole AWS family including `AWS_BEARER_TOKEN_BEDROCK` and the ECS/web-identity URIs, and the Azure OpenAI triple).
- Data flow: `node --import $resolverUrl $cliPath @forwardArgs`, where `$resolverUrl` is `` `[System.Uri](Join-Path …).AbsoluteUri` `` — a file URL, "because Windows paths are not specifiers".
- Non-obvious design decisions: the credential list is **explicit and enumerated** rather than "unset everything that looks like a key" — it is a maintained list, so a new provider's variable must be added to three files (`pi-test.sh`, `pi-test.ps1`, and the ai package's `env-api-keys.ts`, which the comment at `pi-test.sh:18` cites).
- Edge cases / failure handling: `Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue` so a variable that was never set is not an error; the script captures `$LASTEXITCODE` and exits with it.
- Surprising: the same script is both the *developer entry point* and the *no-credentials safety mode* — one flag separates "run pi locally" from "run pi with a clean environment".

### pi-test.sh
- Purpose: the POSIX twin of `pi-test.ps1`.
- Key abstractions: the same `--no-env` flag and the same 36-variable credential list (kept in lock-step with the PowerShell version).
- Data flow: `RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/coding-agent/src/experimental/source-resolver.ts")"` then `node --import "$RESOLVER_URL" … cli.ts`.
- Non-obvious design decisions: the comment at `:57` states the reason for the URL conversion: "`--import` takes a module specifier, so pass the resolver as a file URL (raw paths break on #, ?, %)". The script also runs from any directory — `SCRIPT_DIR` is derived from `BASH_SOURCE`, not from `$PWD`.
- Edge cases / failure handling: `ARGS+=("$arg")` with `${ARGS[@]+"${ARGS[@]}"}` so an empty argument list does not expand to a single empty string under `set -u`.
- Surprising: the credential list in the shell script references `packages/ai/src/env-api-keys.ts` as the canonical inventory — the scrub list and the provider code are explicitly linked.

### README.md
- Purpose: the top-level product document.
- Key abstractions: the package table (chord — "Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links"; pi-telemetry; pi-ai; pi-durable; pi-agent-core; pi-coding-agent; pi-tui — "Terminal UI library with differential rendering"); the install paths (curl|sh installer which pins deps, npm which does not, Nix); and the three-mode usage surface (interactive, print/JSON, RPC, SDK).
- Data flow: the README is the entry point into `packages/coding-agent/docs/*.md` for extensions, skills, prompt templates, themes and packages.
- Non-obvious design decisions:
  - **The permission stance is stated up front** (`:88-96`): "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it." — followed by three named containerization patterns (Gondolin extension, plain Docker, OpenShell). The refusal to build a permission system *into* the core is the clearest statement of pi's philosophy in the shard.
  - **"Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want"** (`:19`) — the core/extensibility split stated as a product promise.
  - **The supply-chain section is a checklist** (`:168-180`): exact pins for direct external deps, version ranges only for internal workspace packages, `save-exact` + `min-release-age`, lockfile-as-ground-truth, the pre-commit lockfile gate, `npm run check` verifying pinned deps / native TS import compatibility / the generated install lock, the install-lock for the installer, the same tarball packer for local smoke tests and npm publication, `--ignore-scripts` everywhere, `npm ci --ignore-scripts` in CI, and a scheduled `npm audit --omit=dev` **plus** `npm audit signatures --omit=dev`.
- Edge cases / failure handling: Node.js 22.19+ is required; the Nix path is offline by construction.
- Surprising: `:86` points OSS session sharing at a Hugging Face dataset (`badlogicgames/pi-mono`) — the project publishes its own agent trajectories as training data.

### SECURITY.md
- Purpose: the security model and the reporting channel.
- Key abstractions: the **trust boundary** (`:11-17`): "Pi treats the local user account and files writable by that account as inside the same trust boundary as the Pi process itself." A report that depends on prior local write access is not a vulnerability "unless they demonstrate how Pi grants that write access or crosses an operating-system privilege boundary."
- Data flow: reports go to `security@earendil.com` or a private GitHub Security Advisory; the scope explicitly includes pi.dev infrastructure.
- Non-obvious design decisions: the out-of-scope list is the interesting part — prompt injection, malicious model output, behaviour of user-installed extensions/skills, and "Local code execution or sandboxing behavior (the Pi coding agent intentionally does not have a sandbox)". `SECURITY.md:19-22` explains why: files like `AGENTS.md` or comments "can be used to prompt inject the coding agent trivially and this cannot be protected against."
- Edge cases / failure handling: the out-of-scope list enumerates the exact paths that matter — `~/.pi`, `~/.pi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions, dotfiles — and the exception clause is narrow: "unless the report shows how Pi itself grants that access."
- Surprising: this is a *model-level* security statement: pi does not claim prompt-injection resistance, and says so in writing, rather than implying it.

### test.sh
- Purpose: the test harness — the single entry point for running the suite.
- Key abstractions: `mktemp -d "$temp_parent/pi-test.XXXXXX"` as `test_root`; a marker file `$test_root/.pi-test-owned`; an explicit environment allowlist array; and a `cleanup()` trap.
- Data flow: `env -i "${test_env[@]}" npm test` — the process starts with **an empty environment** and only the listed variables.
- Non-obvious design decisions:
  - **The allowlist is enumerated, not inherited**: `PATH`, `PWD`, a fake `HOME`/`USERPROFILE`, `TMPDIR`/`TMP`/`TEMP`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `LANG`/`LC_ALL`/`TZ`, the Git prompt-suppression variables (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=false`, `GIT_EDITOR=true`), npm's config/cache redirection, `PI_NO_LOCAL_LLM=1`, `AWS_EC2_METADATA_DISABLED=true`, and `NODE_EXTRA_CA_CERTS` **only if already set** (so a corporate proxy's CA still works).
  - **The cleanup refuses to delete anything it did not verify**: the `case` requires the path to match `"$temp_parent"/pi-test.*`, to be a directory, **not a symlink**, and to contain the `.pi-test-owned` marker; otherwise it prints "Refusing to remove unverified test directory" and forces a non-zero exit.
  - **Windows needs a few inherited variables** to launch child processes (`SystemRoot`, `WINDIR`, `COMSPEC`, `PATHEXT`), so they are re-added explicitly.
- Edge cases / failure handling: `cleanup()` preserves the original exit status (`local status=$?` before anything else) and turns a cleanup refusal into a failure even on an otherwise-successful run.
- Surprising: this is the direct counterpart of August's `e2e:smoke` (which points `AUGUST_DATA_DIR` at a temp directory) — pi's version additionally proves the isolation by *refusing to delete* anything unverified, and by never inheriting a credential in the first place.

### tsconfig.base.json
- Purpose: the compiler options every package inherits.
- Key abstractions: `target`/`lib` ES2024; `module`/`moduleResolution` Node16; `strict: true`; **`erasableSyntaxOnly: true`**; `verbatimModuleSyntax: true`; `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`; `declaration` + `declarationMap` + `sourceMap` + `inlineSources`; `resolveJsonModule`; `types: ["node"]`.
- Data flow: `packages/ai/tsconfig.build.json`, `packages/coding-agent/tsconfig.build.json` and `packages/coding-agent/tsconfig.examples.json` all `extends` it.
- Non-obvious design decisions: `erasableSyntaxOnly` is the machine-checked half of `AGENTS.md:24` — it makes "no enum, no namespace, no parameter properties" a *compile error* rather than a review comment, so the whole tree can run under Node's type-stripping loader. `rewriteRelativeImportExtensions` lets source files write `./foo.ts` and still emit runnable JS. `inlineSources: true` with `inlineSourceMap: false` puts the original TypeScript inside the published `.js.map` so stack traces in the shipped bundle point at real source lines.
- Edge cases / failure handling: `forceConsistentCasingInFileNames` (Windows and macOS are case-insensitive; Linux is not).
- Surprising: `skipLibCheck: true` is the only relaxation in the file.

### tsconfig.json
- Purpose: the root typecheck configuration — the `tsc --noEmit` half of `npm run check`.
- Key abstractions: `noEmit: true`, `module`/`moduleResolution` NodeNext (overriding the base's Node16), and a **`paths` map covering every workspace package and subpath** — `chord` (+ `/context`, `/delta`, `/node`, `/output`, `/sqlite`, `/sqlite/node`, `/sqlite/cloudflare`, `/telemetry-sqlite`), `pi-telemetry` (+ `/testing`, `/render`), `pi-codemode` (+ `/cloudflare`, `/declarations`, `/portable`, `/source`, `/worker`), `pi-mcp` (+ `/oauth`, `/testing`), `pi-ai` (+ `/models`, `/compat`, `/oauth`, and the wildcards `/*` → `src/*.ts` and `src/providers/*.ts`, plus `/dist/*`), `pi-durable` (+ `/testing`, `/*`), `pi-env`, `pi-agent-core`, `pi-coding-agent` (+ `/hooks`, `/*`), `typebox` → `./node_modules/typebox`, `pi-tui` (+ `/*`), and the legacy `pi-agent-old`.
- Data flow: `include` spans `scripts/model-catalog-protocol.ts` and its test, `packages/*/src/**/*`, `packages/*/test/**/*`, `packages/durable/test-workers/**/*`, `packages/coding-agent/examples/**/*` and `packages/agent/examples/**/*`.
- Non-obvious design decisions: the paths map resolves every workspace package to **source**, so the root typecheck exercises the monorepo as one program — a cross-package API break fails `npm run check` immediately, without a build. The explicit `typebox` mapping to `./node_modules/typebox` is there because TypeBox ships its own types in a shape tsc otherwise misresolves.
- Edge cases / failure handling: `exclude` drops `**/dist/**` and `packages/coding-agent/examples/extensions/gondolin/**` (the Gondolin example ships its own dependency tree).
- Surprising: `packages/agent-old` is still in the paths map — dead packages are removed from the map slowly, so the typecheck does not police that.

### vitest.base.ts
- Purpose: the shared Vitest configuration — chiefly, the workspace alias table.
- Key abstractions: `workspaceSourcePaths` names the source entry point of every workspace package and of the ai package's *directory* subpaths (`aiApi` → `src/api`, `aiProviders` → `src/providers`, `aiUtils` → `src/utils`); the `resolve.alias` array maps each package specifier to that path.
- Data flow: `packages/coding-agent/vitest.config.ts` does `mergeConfig(baseConfig, defineConfig({...}))`, so it inherits the whole alias table and adds its own overrides.
- Non-obvious design decisions: **every test in the monorepo runs against source, never against `dist`** — a stale build cannot make a test pass or fail falsely. The regex aliases (`/^@earendil-works\/pi-ai\/utils\/(.+)$/` → `${aiUtils}/$1.ts`) make the wildcard subpath exports work in the test runner exactly as they work in the published package.
- Edge cases / failure handling: the alias table must be kept in step with the `tsconfig.json` paths map — two parallel lists describing the same module graph, one for tsc and one for vitest.
- Surprising: `packages/ai/vitest.config.ts` does *not* use this base config; it declares its own single alias. The base is used by the coding agent (and presumably other packages), so the alias tables are not uniformly centralised.

## Ideas worth stealing

- **Generate the configuration schema from the validator, and let the schema generate the documentation.** `packages/coding-agent/scripts/generate-schemas.ts:32` declares the four artefacts; `packages/coding-agent/scripts/generate-references.ts:101` derives a human type string from the *same* TypeBox schema, and `packages/coding-agent/scripts/generate-references.ts:113` only expands nested objects that carry a `description` or `default`. August's Settings panel and its backend brain-config validator are two hand-maintained descriptions of one key set, and `check:brain-config` exists precisely because they drift; one generated schema plus one generated reference page collapses that class of bug by construction. (The reference page even carries the merge rule in prose: `packages/coding-agent/scripts/generate-references.ts:78` — "Object fields, such as `cost`, merge with the model's value field by field; other fields replace it.")

- **Make a dead `$defs` entry a build error.** `packages/coding-agent/scripts/generate-schemas.ts:120-125` throws "Unused schema definitions" when a declared definition is never referenced. August's `check:brain-config` asks the backend which keys it accepts; the same idea applied at generation time is cheaper — a schema fragment that stopped being used cannot survive a green build.

- **Deduplicate schema fragments by shape identity, and keep per-use annotations.** `packages/coding-agent/scripts/generate-schemas.ts:94-106` compares `JSON.stringify(shape)` and rewrites matches to `{ $ref, ...annotations }`. The transferable part is the *annotation split* (`packages/coding-agent/scripts/generate-schemas.ts:61-81`): annotation keys are separated from shape keys so a shared fragment can be referenced while each use site keeps its own `description`/`default`.

- **Make the server-requested retry wait a named, configurable ceiling that refuses rather than absorbs.** `packages/coding-agent/schemas/settings.schema.json:188-192` defines `retry.provider.maxRetryDelayMs` with the description "Maximum server-requested delay before failing."; `packages/ai/CHANGELOG.md:1839` gives the reason — a provider asking for a delay longer than the ceiling fails the request immediately "instead of waiting silently", default 60 s, `0` disables it. August has the same hazard (`_retryWaitRefusalMs`); pi's contribution is that the ceiling is *documented in the schema description itself*, so the UI can explain it.

- **Let the host own the prompt and the tool set, and restore them after a mutating hook runs.** `packages/coding-agent/CHANGELOG.md:563` — "Handlers no longer see system messages; Pi restores the prompt and tool state after they run" (the bug being that a `context` handler that filtered messages dropped the tool declarations and Codex then emitted raw tool-call text). August's extension/hook surface has the same shape of hazard; the fix is to hand the hook a *narrowed* view and re-assert the host-owned parts afterwards.

- **Separate the observation channel from the actionable channel.** `packages/coding-agent/CHANGELOG.md:546` — "`ExtensionRunner.emit()` no longer accepts `turn_end`; host integrations dispatch actionable boundaries with `emitBoundary(baseEvent, buildContext)`"; `packages/coding-agent/CHANGELOG.md:552` — a handler returns `{ entries, continue: true }` to "ensure one next provider request **without changing steering or follow-up scheduling**". August's `turn_end {reason, rounds, error}` is an observation; the ability to force one more provider request is a different capability and should not share a door with it.

- **Make "unknown" representable in the type instead of folding it into zero.** `packages/coding-agent/CHANGELOG.md:3637` — "`ContextUsage.tokens` and `ContextUsage.percent` are now `number | null`. After compaction, context token count is unknown until the next LLM response, so these fields return `null`." and `:3652` — the footer renders `?/200k`. This is the inverse of August's `Number(undefined) || 0` lesson: pi removed the fold at the *type* boundary, so no consumer can re-introduce it.

- **Keep the context edit append-only and separate from the raw history.** `packages/coding-agent/CHANGELOG.md:545` — "Made `SessionManager` canonical for `AgentSession` provider context. Assigning `session.agent.state.messages` no longer replaces future request history"; `:551` — "Added append-only model-context edits. For example, `sessionManager.appendContextEdit(entryId, null)` omits one message from future provider context **without changing raw history, usage, or UI history**." August's compaction-note and tool-output-pruning problems are exactly this shape: the model's view changes, the user's transcript does not.

- **Treat the system prompt as a cache key: stable content, small size, and no volatile state.** `packages/coding-agent/CHANGELOG.md:3318` — the prompt carries "only the current date in ISO format, not the current time, so prompt prefixes stay cacheable across reloads and resumed sessions"; `:392` — the `codemode` description deliberately excludes deferred tools, tool counts and MCP server instructions "so it no longer changes when MCP servers connect or change their tools"; `:351` — the same work shrank a default GPT-5.6 request "from about 5,300 to 3,300 tokens"; `:3496-3497` — a tool carries its own one-line `promptSnippet` and optional `promptGuidelines` so tool documentation lives with the tool instead of in a global prompt blob. August's `<memory_policy>`, `<brain_config>`-style sections are the same budget.

- **Give the system prompt NAMED, individually patchable sections, and replay them to get the current prompt and tools.** `packages/ai/README.md:1621-1628` — `SystemMessage.sections?: Record<string, string | null>` ("named prompt sections; later messages patch by name, null removes") with `toolsAdded`/`toolsRemoved`; `:1631` — "Replaying every system message in order yields the current prompt and tools"; `:1645` — the provider layer reads the prompt only through `getCurrentSystemPrompt()`/`getCurrentTools()`, because "`context.systemPrompt` and `context.tools` do not exist at that layer". One replay function is the single door for "what prompt does the model actually see".

- **Make mid-conversation tool changes cache-preserving by construction.** `packages/ai/README.md:1647` — Anthropic's `inline-tools-2026-09-15` beta keeps "the top-level tool list … a stable deferred placeholder and never changes", with later tools defined by value in `tool_addition` blocks and removals as `tool_removal` references, "so tool changes do not invalidate the prompt cache"; and `packages/coding-agent/schemas/models.schema.json` (`supportsMidConvoToolAdditions`, `supportsMidConvoToolChanges`, `supportsMidConvoSystemMessages`) makes it a per-model capability rather than an assumption. August's progressive tool-disclosure and its "tools changed mid-turn" problem are the same shape.

- **Do the tool-argument validation ONCE, in the agent loop, and hand the failure back to the model.** `packages/ai/CHANGELOG.md:2341` — "Removed provider-level tool argument validation. Validation now happens in `agentLoop` via `executeToolCalls`, allowing models to retry on validation errors."; `packages/ai/README.md:714-724` shows the shape — a validation failure becomes a tool result with `isError: true` rather than a throw. And `packages/ai/CHANGELOG.md:69` — a tool call whose final arguments are malformed JSON now "carries `argumentsError` and fail[s] validation with the raw arguments text, so the model sees what it sent" (the fix for the silent partial-parse execution August also hit).

- **Classify provider errors into a small, maintained taxonomy and put the taxonomy on a schedule.** `packages/ai/CHANGELOG.md:39` (any HTTP 413 is context overflow, so the caller compacts and retries), `:1444` (Bedrock throttling was misidentified as context overflow, "causing unnecessary compaction instead of retry"), `:1050` ("SDK retries default to `0`, and quota/billing 429s are not retried behind Pi's retry handling"), `:2317` ("Set `maxRetries: 0` on Anthropic client to allow application-level retry handling. The SDK's built-in retries were interfering"). Two rules transfer directly: (a) **there must be exactly one retry owner** — disable the SDK's; (b) overflow and throttling must not share a branch, because the wrong one costs a compaction instead of a retry.

- **Give the queue an explicit interruption point and a way to inspect it.** `packages/coding-agent/CHANGELOG.md:3249` — "Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls"; `:5643` — "Queuing a message while tools are executing now interrupts the current tool batch. Remaining tools are skipped with an error result, and your queued message is processed immediately."; `:753` — an RPC `clear_queue` that returns *and removes* the queued steering and follow-up messages; `packages/coding-agent/schemas/settings.schema.json:71` and `:84` — `steeringMode` and `followUpMode` are **two separate settings** with two separate policies. August's `queued_user` path is exactly this and needs the same explicit semantics.

- **Make the summarisation request a different SHAPE from the turn request, built at one site.** `packages/coding-agent/CHANGELOG.md:35` — "Summaries now use the model's output limit, and `compaction.reserveTokens` only controls when compaction starts" (a trigger budget and a size budget are different knobs); `:137` — `serializeConversation()` omits thinking blocks "because replayed thinking … could make a summarization request larger than the context it summarizes and fail"; `:840` — compaction and branch summarisation must not expose tools; `:1262` — they use a fresh routing session id with prompt caching disabled where supported; `:812` — `session_compact_failed` events carry reason, retry state, source and error message. This is the answer to August's "five paths compact and they were reconciled by a census" problem: one request builder, with the differences expressed as parameters.

- **Assert that the "live" streaming object is a live view, and pin the event order contract in prose.** `packages/ai/README.md:733` — "Every non-terminal event's `partial` is the shared live response-so-far helper. It is intentionally not an event-time snapshot … Inspect it when handling an event instead of retaining it as historical state."; `:752` — "Streaming events for different content blocks are not guaranteed to be contiguous … Consumers must use `contentIndex`." August's SSE re-render path needs both statements verbatim.

- **Run the whole suite in an empty environment with a fake HOME, and refuse to delete what you did not verify.** `test.sh:83-84` — `env -i "${test_env[@]}" npm test` with an enumerated allowlist; `test.sh:20-33` — the cleanup refuses to remove a path that is not the marked, non-symlink directory it created, and turns that refusal into a non-zero exit. August's `e2e:smoke` already redirects `AUGUST_DATA_DIR`; pi adds the two halves August would benefit from — no ambient credential can reach a paid API, and the deletion is provably scoped.

- **Pin the transitive tree for the *installer* separately from the package, and check that it is in sync.** `packages/coding-agent/install-lock/package.json` is a 15-line private lock root whose only dependency is the agent at an exact version; `packages/coding-agent/install-lock/package-lock.json` pins the whole transitive tree; `package.json:26` runs `npm run check:install-lock:coding-agent` so drift fails `npm run check`. August's desktop bundle has an analogous problem — bundled backend payload versus npm install — and pi's answer (one derived lock, regenerated by a checked script) is the shape to copy.

- **Resolve the model catalog by content hash so an offline build is reproducible.** `nix/model-catalog.json` holds one sha256 revision; `nix/package.nix:25-30` uses that same hash as the fetch URL segment *and* as `fetchurl`'s expected content hash. August's model/pricing tables would benefit from the same "the pin IS the hash" property — a stale catalog is then a visible diff rather than a silent download.

- **Use npm's own `min-release-age` as a supply-chain valve.** `.npmrc:2` — `min-release-age=2` makes npm refuse any release published less than two days ago. It costs nothing to add and closes the "compromised maintainer published a bad version" window that version pinning alone does not.

- **Ship a faux provider so the harness can be tested deterministically without a network.** `packages/ai/README.md:1487-1572` — `fauxProvider({ tokensPerSecond })` with a scripted response queue, `faux.setResponses([...])` / `appendResponses([...])`, `faux.state.callCount`, incremental tool-call argument streaming, simulated prompt-cache read/write accounting, and the honest limitation "The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids." August's `e2e:smoke` would be far cheaper and far more precise with this shape than with a live provider.

- **Default the network OFF in the test configuration and make opting in explicit.** `packages/coding-agent/vitest.config.ts:12` — `env: { PI_OFFLINE: "1" }` with "opt in with `allowNetwork()` from test/test-network-env.ts"; `packages/ai/vitest.config.ts:8-13` — `silent: "passed-only"` and a GitHub Actions reporter only in CI. The generalisation: the *default* is the safe value and the escape hatch is named in the config file, so a test that reaches the network is a deliberate, greppable act.

## Files skipped (with reasons)

- `package-lock.json` — generated by npm (lockfileVersion 3); 6451 lines of `resolved` registry URLs, `integrity` sha512 hashes and per-package dependency edges. I opened the head (the root `packages[""]` block with the workspace list and devDependencies, plus the first two dependency entries) to confirm it is the monorepo root lockfile matching `package.json`. Not read line by line because it is mechanical dependency metadata with no harness mechanism, and the manifest itself classifies it `generated-vendored`.
- `packages/coding-agent/install-lock/package-lock.json` — the generated installer lockfile; 1507 lines of the same shape. I opened the head to confirm it pins `@earendil-works/pi-coding-agent` 1.4.0 and its full transitive tree (including `@anthropic-ai/sdk` and `@aws-sdk/client-bedrock-runtime`). Not read line by line for the same reason; the manifest classifies it `generated-vendored`.

## Uncertainties

- **The two CHANGELOGs are not read in full.** `packages/coding-agent/CHANGELOG.md` is 6367 lines / 654 KB and `packages/ai/CHANGELOG.md` is 2379 lines / 200 KB. I read `packages/coding-agent/CHANGELOG.md:1-820` and `packages/ai/CHANGELOG.md:1-260` line by line, then grepped each file in full for `compaction`, `steering`, `system prompt`, `retry`/`Retry-After`, `context overflow` and `queue` to locate the mechanism entries I cite. The release bodies I did not open (older `packages/coding-agent/CHANGELOG.md` sections and `packages/ai/CHANGELOG.md` after line ~260) may contain additional mechanism decisions I did not surface; every line number I cite in this report was read in context, not inferred from a grep snippet.
- **I did not open the TypeBox sources the schemas are generated from** (`src/core/settings-schema.ts`, `src/core/model-config.ts`, `src/core/keybindings-schema.ts`, `src/modes/interactive/theme/theme-schema.ts`) — they are owned by other shards. My statements about the schemas are statements about the *generated JSON*, which is what ships and what an editor consumes. Where I describe generation behaviour (e.g. `$defs` dedup) I read the generator in `packages/coding-agent/scripts/generate-schemas.ts` directly.
- **The `packages/ai/README.md` is the documented contract, not the implementation.** The provider, API and model code lives in `packages/ai/src/**` (the `ai-provider-core` shard). Where I describe the provider/runtime mechanism — the header merge order, `normalizeContext()`, the credential store, the streaming event contract — I am reporting what the README states, cross-checked against the changelog entries that describe the same behaviour. I did not verify any of it in the source.
- **`packages/ai/src/bedrock-provider.ts` (140 bytes, other shard) is the origin of the two root shims** I read; I inferred that relationship from the `exports` map in `packages/ai/package.json:42-45` and `packages/ai/tsconfig.build.json:9-10`, not from reading the source file.
- **The `scripts/**` and `.github/**` trees that implement the gates named in `package.json` and `.husky/pre-commit` are owned by the `scripts-ci` shard and were not read.** So `check-lockfile-commit.mjs`, `check-pinned-deps.mjs`, `check-runtime-deps.mjs`, `check-ts-relative-imports.mjs`, `check-entry-graphs.mjs`, `generate-coding-agent-install-lock.mjs` and `check-browser-smoke.mjs` are described here only by the commands that invoke them and by the comments in this shard.
- **`flake.lock` and `package-lock.json` hash formats were not independently verified** — I confirmed their structure and the fields they carry, not that the recorded hashes are correct.
- **I did not run, build, install or execute anything in the clone.** Every statement in this report comes from reading files.
