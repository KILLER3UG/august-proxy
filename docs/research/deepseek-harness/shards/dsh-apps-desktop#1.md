# deepseek-harness / dsh-apps-desktop#1

## Shard shape

This shard is the **Desktop Electron shell's build, release, publication and installer surface** — everything under `apps/desktop/` except the TypeScript application source (which lives in other shards). It holds 236 files in four groups: (1) **the app manifest and the two renderer documents** the shell ships outside ASAR (the ordinary update dialog and the mandatory-update overlay, both plain HTML/CSS/JS with strict CSPs), (2) **a hand-written NSIS installer in C++/NSIS/NSH** (`apps/desktop/installer/`) that draws its own welcome/finish pages with GDI+, extracts with a pinned 7-Zip, and replaces the install directory by rename with rollback, (3) **171 build/release/publishing scripts** (`apps/desktop/scripts/`) covering target selection, environment resolution, runtime preparation, code signing on Windows and macOS, updater-feed publication to Tencent COS, and the machine-runner scripts, and (4) **the operator-facing READMEs** for packaging, publication and CI publication, in English, Chinese and a per-section bilingual hash record. The modules fit together as a strict pipeline: `package-target.ts` orchestrates → `prepare-runtime.ts` / `prepare-dsh.ts` materialize → `electron-builder-config.mjs` packages → `desktop-publish.ts` / `desktop-upload-run.ts` publish → `desktop-release-store.ts` retains the attempt so a *different* machine can publish it later. The "shape" of the whole shard is **evidence-first**: every stage writes a credential-free journal, every irreversible action is preceded by a byte-level verification, and every failure leaves a named recovery command rather than a "please retry".

**Coverage against the repo lenses.** This shard contains **no agent-loop, tool-calling, prompt-construction, context-window, model-adaptation, memory or subagent code** — those live in `packages/` and `apps/desktop-host/`, which are other shards. The lenses that *do* apply here are: **UI/UX patterns** (two custom dialogs, an installer UI, a welcome window, progress feedback), **config** (file-owned dotenv/preset resolution with no ambient fallback), **evals/testing** (four qualification harnesses plus smoke suites), and **tool-call reliability** in the sense that matters at this layer: credential scrubbing, retries, deadlines, malformed-input handling and fail-stop semantics for the external tools the harness shells out to. I say so plainly rather than implying the agent loop is here.

## Per-file notes

### apps/desktop/package.json
- Purpose: the Desktop package manifest — `@deepseek-ai/dsh-desktop`, version `0.2.1-rc.2`, private, ESM, `main: lib/main.js`.
- Key abstractions: ~35 npm scripts that are the *only* supported entry points for packaging, upload, rendering the tray icon and preparing the runtime; a deliberate dependency split (three runtime `dependencies`, everything else a `devDependency`).
- Data flow: `pnpm run package:win:x64` → `tsx scripts/package-target.ts win-x64` → the build/sign/publish chain.
- Non-obvious design decisions: because electron-builder copies only `dependencies` into `app.asar/node_modules`, the main bundle must *inline* every workspace devDependency — hence the `desktop-bundle-imports` gate that fails any bundle leaving an unresolvable bare import.
- Edge cases / failure handling: `electronFuses.runAsNode` is what lets the CLI run under the shipped Electron binary; `version` is the single source of release identity and must equal the root `dsh` version.
- Surprising: the manifest's `version` is also the *product* version — the published build version is an argument to the packaging command, never a manifest edit.

### apps/desktop/scripts/electron-builder-config.d.mts
One-line re-export that imports the config factory without evaluating an ordinary release configuration — the same "don't evaluate the release config in a test" separation the `.mjs` entry provides.

### apps/desktop/electron-builder.config.mjs
- Purpose: the five-line ordinary-release entry that re-exports the environment-independent config factory.
- Key abstractions: `createElectronBuilderConfig(env, hostPlatform, hostArch, preparedRuntime, preparedRuntimeVersion)`.
- Data flow: qualification imports the *factory*; an ordinary release evaluates the default export once.
- Non-obvious design decisions: the split exists so a test can build a config without evaluating a release configuration (which would resolve signing credentials).
- Edge cases / failure handling: none here; the factory owns the failures.
- Surprising: two lines of code, but the "ordinary release" vs "qualification" distinction is what keeps the installed-update qualification from touching the release path.

### apps/desktop/electron-builder.config.d.mts
- Purpose: the type-only shape of the electron-builder config that the Desktop release tests assert against.
- Key abstractions: `DesktopElectronBuilderConfig` with `readonly` fields for `appId`, `artifactName`, `protocols`, `files`, `asarUnpack`, `extraResources`, `mac`, `win.signtoolOptions`, `nsis` and the four builder hooks.
- Data flow: consumed by the release tests as a compile-time contract.
- Non-obvious design decisions: the `nsis` block is typed with literal values (`oneClick: false`, `perMachine: false`, `allowElevation: false`) so a silent change to those is a type error, not a runtime surprise.
- Edge cases / failure handling: `publish` is typed as `readonly [...] | null`, because an unsigned build must not carry a publish target.
- Surprising: `readonly` on a config object read by electron-builder is a lie the type system accepts — the value is only frozen from the test's point of view.

### apps/desktop/README.md
- Purpose: the application reference — what Desktop *is* and how it behaves, separate from the build/release guides.
- Key abstractions: the section set (application overview, terminal command, closing/quitting, key technical decisions, bundled command runtime, installation ownership, develop, package, Windows installer interface, updates, local desktop settings, mandatory update policy, local updater qualification, low-level development overrides, known limitations).
- Data flow: the file is the contract that the `packaging/` and `publishing/` guides link back to; several sections are the *specification* the scripts implement.
- Non-obvious design decisions: the mandatory-update policy section carries a table of "resolved policy field | meaning and default" and states the failure of a `401 UNAUTHENTICATED` response to offer login only when a local settings file says so — the default is `false`, which suppresses the entire authentication flow at startup.
- Edge cases / failure handling: it states that a policy failure never clears a known mandatory block, that policy is not persisted across restarts, and that "the shared DOM is a presentation constraint, not a security boundary".
- Surprising: it documents that a server-expanded `40005` opens a shell-owned modal and refuses *subsequent plugin mutations* without stopping running Host tasks — a policy response that changes what the product may do next.

### apps/desktop/README.zh.md
Chinese translation of the application reference, verified as a paired translation (same frontmatter, same anchor set, same 384-line structure); it is the file the bilingual hash record in `README.i18n.yaml` pins.

### apps/desktop/README.i18n.yaml
- Purpose: the per-heading bilingual-pair consistency record for `README.md`.
- Key abstractions: a map of heading anchor → `{en, zh}` short hashes of the section text outside code blocks.
- Data flow: `pnpm run verify-translation-pairing --write apps/desktop/README.md` regenerates it; the repo's i18n gate compares it.
- Non-obvious design decisions: the record is *per heading section*, so an unpaired edit inside one section is caught without requiring whole-file equality.
- Edge cases / failure handling: a section's hash changes when only the Chinese side is edited, which is what makes the pairing a gate rather than a convention.
- Surprising: this is a static gate standing in for the test suite that August removed — the pairing is checkable without a runtime.

### apps/desktop/.env.macos.example
Release-only macOS dotenv template: app id, `DSH_DESKTOP_AUTO_UPDATE_ENV`, the test download origin and 32-hex release id, the mandatory-update test/prod origins and the policy JSON, the Apple signing identity and team id, `CSC_LINK`/`CSC_KEY_PASSWORD`, exactly one notarization strategy, and optional COS upload keys. The comment "Values are not shell-expanded" is load-bearing — passwords containing `#` need quoting.

### apps/desktop/.env.windows.example
Windows counterpart: app id, update env, mandatory-update origins, the EV certificate file, SignTool path, SafeNet key container and token PIN, an optional absolute signature-cache directory, 1–8 cache-restore workers, and optional COS upload keys. It states that the mandatory-update origin is required "including unsigned and preparation-only builds".

### apps/desktop/config/windows-packaging/windows-signing.env.example
The private half of the Windows configuration: the public `.cer` path, the SignTool executable, the key-container name and the token PIN, with relative paths resolving beside the file. It is the only file in the shard that holds a PIN, and it is a template — the real file lives outside the checkout.

### apps/desktop/config/windows-packaging/test.env.example
The *public* Windows test preset. Its first comment says "Public test configuration. No PIN or upload credentials belong here", which is enforced by the loader: the preset file rejects any setting outside the public allowlist.

### apps/desktop/config/windows-packaging/production.env.example
Production Windows preset: app id, `env=production`, the mandatory-update production origin, an empty policy JSON, and the cache concurrency — deliberately no signing or upload keys, which live in a separate secrets file.

### apps/desktop/config/macos-packaging/macos-signing.env.example
Private macOS signing file: signing identity, team id, the relative p12 path, the p12 export password, and the App Store Connect API-key trio. The comment "Copy to macos-signing.env with mode 0600; keep this directory outside the runner checkout" states both the permission and the placement rule.

### apps/desktop/config/macos-packaging/test.env.example
Public macOS test preset: app id, `env=test`, the mandatory-update test origin plus `allowedAuthOrigins` JSON, the download origin, the 32-hex release id, pack concurrency, and the two independent proxies. It notes the notarization proxy "temporarily changes the active network service's system HTTP/HTTPS proxies" — a global side effect a reader should know about before enabling it.

### apps/desktop/config/macos-packaging/production.env.example
Production macOS preset: app id, `env=production`, the production mandatory-update origin, pack concurrency, both proxies, and the optional external signature-cache directory. The production preset carries no `DOWNLOAD_TEST_RELEASE_ID`, because production does not use a release-id prefix.

### apps/desktop/cli/dsh
POSIX launcher for the installed CLI. It resolves its own symlink chain by hand (`while [ -L "$launcher" ]`) so the path is correct even when the launcher is itself a symlink, then execs `../MacOS/DeepSeek Harness` with `ELECTRON_RUN_AS_NODE=1 --expose-internals` against `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`. The comment "without changing the invoking shell or working directory" is the contract: it must never mutate the caller's shell.

### apps/desktop/cli/dsh.cmd
Windows counterpart: `setlocal DisableDelayedExpansion` (so a PIN-like value with `!` is not mangled), sets `ELECTRON_RUN_AS_NODE=1`, and execs `DeepSeek Harness.exe` against the same packaged CLI entry.

### apps/desktop/cli/link-entry.c
An 18-line C helper whose whole job is to create the macOS command symlink with `linkat(2)`. The reason it exists rather than a `ln -s` call is in the header comment: "Preserve a command symlink's inode while refusing an occupied destination" — a shell `ln -s` would follow/replace differently, and the "refusing an occupied destination" property is what lets the installer restore a displaced launcher safely.

### apps/desktop/renderer/update-dialog.html
The ordinary update dialog document. Its CSP is `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'` — no network, no inline script, images only from the packaged origin. The `main` element carries `role="dialog"`, `aria-modal="true"`, `tabindex="-1"` and is `hidden` until content arrives.

### apps/desktop/renderer/update-dialog.js
- Purpose: the renderer's half of the ordinary update dialog — it shows copy and returns a button index; the main process owns the copy and the response.
- Key abstractions: `respond(index)` sends `view.revision` plus the index; `render(state)` rebuilds the button row from `state.buttons`.
- Data flow: `api.subscribe(state)` pushes updates; `api.status()` returns the current state once. The script renders on the first of the two that arrives (`received` flag) so the initial paint is not duplicated.
- Non-obvious design decisions: the file's own header says "Escape is cancellation, never acceptance" — Escape maps to `view.cancelId`, and a keydown handler also traps Tab over the *real* controls (`button, details > summary, details[open] > pre`), so focus cannot leave the modal.
- Edge cases / failure handling: a **revision guard** (`state.revision <= view.revision` → return) drops out-of-order updates; `responding` is a single-flight flag so a double click cannot send two answers, and it is released on a failed response so the dialog stays usable.
- Surprising: `document.getElementById('dialog').focus()` on every render — the dialog re-takes focus on each update, which is deliberate for a modal that the product page may otherwise steal.

### apps/desktop/renderer/update-dialog.css
Shared styling for both dialogs: a 380px card, a sticky action row at the bottom so the buttons stay reachable in a long dialog, 44px minimum touch targets, a visible `focus-visible` outline in `#4d6bfe`, `pre` capped at `min(180px, 30vh)`, a 150ms fade with a `@starting-style` entry, and a `prefers-reduced-motion` override that removes the transition. `[hidden] { display: none !important; }` is present because the dialog is shown by hiding, not by removing.

### apps/desktop/renderer/update-close.svg
An 8-line static close glyph: two 14×14 paths forming an X, with `preserveAspectRatio="none"` so it can be stretched to the button box without distortion.

### apps/desktop/renderer/mandatory-update.html
The mandatory-update overlay document, modelled as an `alertdialog` (not a `dialog`): `aria-modal="true"`, `aria-labelledby="title"`, `aria-describedby="detail"`. Its CSP is stricter than the ordinary dialog's — `img-src 'none'` as well — because the overlay is text-only by design. It carries a `role="status"` live region for the phase text, a `role="alert"` region for the error, a `<details>` disclosure for technical detail, and four action buttons.

### apps/desktop/renderer/mandatory-update.js
- Purpose: render the mandatory-update policy and the update phase as text; the main process owns every privileged action.
- Key abstractions: a pure `render(view)` that derives title/detail/primary-button/status from `{policy, update, confirmation, navigation, deferred, restart}`; `act(action)` performs the action and maps a rejection to a localized "action failed" line.
- Data flow: `api.subscribe(view)` pushes state; `api.status()` returns it once. `render` is also called after every `act` so the button's busy state and label are always derived from the last view.
- Non-obvious design decisions: the **button label and its action are both derived** — a button can change from "Download" to "Install and restart" while a key remains held, and the file comment says so ("A download button can become an install button while a key remains held"). The *phase* drives the label, not a state machine stored in the renderer.
- Edge cases / failure handling: a typed preparation cause (`stop-failed`, `tasks-changed`, `tasks-unavailable`) selects localized guidance, so changing translated wording cannot reclassify the failure. The `technical-details` disclosure is re-collapsed when its content changes, and hidden entirely when empty. `Escape` and key repeat are `preventDefault`ed — the overlay cannot be dismissed by the keyboard.
- Surprising: the `page`/`copy` fallback path reveals a **read-only textarea with the full address** when the clipboard write fails, and a copy failure never overwrites the updater's own error. That is a small, reusable "degrade without lying" pattern.

### apps/desktop/renderer/mandatory-update-frame.js
- Purpose: the embedded shell frame's bridge to the main process — it "delegates actions only to its owning application preload".
- Key abstractions: `window.dshMandatoryUpdate` with `status()`, `subscribe(listener)` and `action(action, version, revision)`; a `MessagePort` request/response map keyed by an incrementing id.
- Data flow: the frame posts `{type:'dsh-mandatory-action', id, action, version, revision}` on the port and resolves or rejects the promise when the matching `dsh-mandatory-result` arrives.
- Non-obvious design decisions: the handshake check is **four-fold** — `event.isTrusted`, `event.source === window.parent`, `event.origin === 'dsh-app://app'`, exactly one port, and a port that has not already been set. A frame that does not receive the bridge simply never defines `window.dshMandatoryUpdate`, so the renderer sees `undefined` and does nothing.
- Edge cases / failure handling: `pagehide` closes the port once; `Promise.withResolvers()` is used for the initial state so a subscriber that arrives before the first push still gets a promise rather than `undefined`.
- Surprising: the whole file is 42 lines and exists so that the overlay's *presentation* cannot be used to authorize an installation — the main process still owns the decision.

### apps/desktop/renderer/mandatory-update.css
Styling for the overlay: muted status and version lines that collapse when empty (`:empty { display: none; }`), a red error line, a pill-shaped primary and refresh button, a themed 4px progress bar with its own `::-webkit-progress-*` and `::-moz-progress-bar` rules, and a fallback block separated by a top border. The `#address` textarea is `overflow-wrap: anywhere` and `resize: vertical` so a long URL never forces a horizontal scrollbar.

### apps/desktop/renderer/policy-login-loading.html
The login window's placeholder, shown until the first remote document commits. It loads **from disk before any network request**, so it may reach nothing — hence `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`. The script is an IIFE that reads one label from the query string and declares no global of its own, and the spinner respects `prefers-reduced-motion`.

### apps/desktop/renderer/welcome.html
The welcome-window document: `#root` only, a `default-src 'none'` CSP with explicit `script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`, and the shared welcome bundle loaded from `../lib/welcome` — so the window uses the *shared* React welcome entry with its own isolated preload and never loads the main Web application.

### apps/desktop/renderer/welcome.css
- Purpose: the welcome window's design tokens and layout.
- Key abstractions: a `--dsw-alias-*` token set mirroring the product palette, with a `prefers-color-scheme: dark` override; `--welcome-tint` bound to the shared window tint.
- Data flow: the tokens are consumed by the shared `../lib/welcome/welcome.css` and by the local brand SVG.
- Non-obvious design decisions: `.actions .back` uses `corner-shape: round` and a *colour-only* hover, with the comment "Platform text actions use color-only hover, preserving the native backdrop" — the frosted-glass material behind the button must not be replaced by an opaque fill.
- Edge cases / failure handling: `.key-field input` has `outline: none` and carries focus in its *border* instead, so the border colour is the focus indicator; `.actions button:disabled` uses `cursor: not-allowed` and 0.4 opacity, and `.auth-waiting .copy-link:disabled` overrides the opacity back to 1 so the pending link does not look broken.
- Surprising: `:lang(en) .tagline em { font-size: inherit; }` — the product name is 26px in Chinese and the same size as the rest of the line in English, an explicit per-language typographic decision.

### apps/desktop/renderer/assets/window-material.css
The shared foreground tint for full-window Desktop surfaces: 40% white in light mode, `rgb(24 25 28)` at 50% in dark mode, defined as `color-mix(in srgb, …)`. The comment says "Native macOS vibrancy supplies the blur; this is only the foreground tint", and the dark rule is scoped to `:root:not([data-ds-theme-source])` so an explicit theme choice wins over the OS preference.

### apps/desktop/packaging/README.md
- Purpose: the build guide — how to choose a build path, how a release version is derived, how configuration is loaded, and how each platform's packaging and signing works.
- Key abstractions: the *release-versions* section (a table mapping a dsh base to its production and test Desktop forms), the "choose a build path" decision (local vs Actions, test vs production, signed vs unsigned), and the "runtime file selection" and "installation and release verification" sections.
- Data flow: it is the operator-facing specification for the scripts in `apps/desktop/scripts/`; every claim names the script that implements it (for example "Desktop's file policy" → `../scripts/runtime-file-policy.ts`).
- Non-obvious design decisions: the version rule is *derived*, not chosen — "Before each Desktop packaging run, first confirm the complete version string with the current user… Do not start packaging until the user confirms that version; the deployment setting alone does not authorize a version choice." The `--build-version` argument is the mechanism: the manifests keep the product version, so a test build no longer rewrites the release family and leaves nothing to revert.
- Edge cases / failure handling: it documents the limits of the configuration checks ("Configuration checks do not authenticate the PIN, log in to the token, unlock a keychain, or contact Apple"), the macOS parallel-notarization copy semantics, the retry policy for the Windows directory rename (errors 5/32/33, ten attempts, 11.25 s total), and that a failed restoration preserves the backup and must not be retried.
- Surprising: the "local Official bundles from a loopback registry" section describes serving a *local npm registry* from a build run so the packaged app can install first-party bundles before they are published to npm — and records that pnpm's 24-hour `minimumReleaseAge` must be exempted in the profile, or the install fails with pnpm's own message.

### apps/desktop/packaging/README.zh.md
Chinese translation of the packaging guide, verified as a paired translation by its frontmatter and section structure; the `README.i18n.yaml` record pins the English and Chinese blocks per heading.

### apps/desktop/packaging/README.i18n.yaml
Per-heading bilingual-pair hash record for the packaging README, pinning 18 sections so an unpaired edit in either language is caught by a static gate.

### apps/desktop/publishing/README.md
- Purpose: the manual publication guide.
- Key abstractions: deployment identity (the `test`/`production` table of origin, bucket and credential names), the release-id prefix rule, the feed/binary upload order, fixed "latest" downloads, and the upload audit contract.
- Data flow: it tells the operator which command to run in which order (`package:desktop:mac:arm64` then `upload:mac:arm64`) and what each step validates.
- Non-obvious design decisions: the test deployment's 32-hex release id is a *URL prefix*, not authentication — "Random paths reduce guessing, not access by link holders; withdrawing a batch requires deleting its COS objects and purging its CDN directory." The uploader leaves `Cache-Control` unset on purpose, because "deployment infrastructure owns cache policy".
- Edge cases / failure handling: "A missing final result means interruption or unavailable storage, not success", and "a timeout or failed receipt write does not prove that the object was not stored. Retain partial records and inspect remote state before another operation."
- Surprising: it states plainly that the manual uploader and the CI publisher are two separate orchestrators with different locks and approvals, and "Do not run both writers against one channel concurrently" — the consolidation is named as future work rather than pretended away.

### apps/desktop/publishing/README.zh.md
Chinese translation of the publication guide, verified as a paired translation.

### apps/desktop/publishing/README.i18n.yaml
Per-heading bilingual-pair hash record for the publication README, pinning 9 sections.

### apps/desktop/publishing/ci/README.md
- Purpose: the CI publication guide — publish a package from the machine that built it, without downloading the installer again.
- Key abstractions: machine setup (the `releases/<run-id>/<attempt>/` layout, the `publishing/<preset>.json` files, the `DESKTOP_PUBLISH_RUNNERS` runner-label map, the `desktop-test`/`desktop-production` environments), the package-and-publish sequence, recovery and records, and channel restoration.
- Data flow: the hosted routing job selects the attempt, the original machine's local manifest supplies the preset, version, source and channel, the publisher verifies and requests approval, and the deployment's reviewer approves.
- Non-obvious design decisions: the approval summary is a *digest* of the manifest and the plan, re-checked after approval — "Changed bytes or destinations reject. Approval cannot edit a version; reject and rebuild instead." The `published-tag-pending` recovery path uses durable feed-completion evidence to permit *only* tag recovery, "even if a later release has advanced the channel".
- Edge cases / failure handling: a debugging package "requires a new signed/notarized package and its run ID / attempt; retrying publication cannot qualify the existing bytes". Production source is restricted to `master` or a `dsh-v*` tag, and a deleted or diverged branch rejects.
- Surprising: it says the two publishing jobs wait for **Review deployments → Approve and deploy** and that the *test* deployment may allow self-approval while production does not — and that the administrators must keep the buckets unversioned, which the publisher "assumes … and does not call `GetBucketVersioning`".

### apps/desktop/publishing/ci/README.zh.md
Chinese translation of the CI publication guide, verified as a paired translation.

### apps/desktop/publishing/ci/README.i18n.yaml
Per-heading bilingual-pair hash record for the CI publication README, pinning 7 sections.

### apps/desktop/scripts/desktop-build-paths.mjs
Resolves the fixed build target, gives each target its own mutable preparation and artifact directories under `.desktop-build/targets/<target>/`, keeps the download cache shared because every archive name includes its version, platform and architecture, and selects the unsigned or unnotarized output directory. `developmentRuntimeDirectory` exists because "The build target fixes Windows to x64, so the shell cannot derive this directory from the architecture of the process that launched it."

### apps/desktop/scripts/manage-windows-signature-cache.mjs
The cache maintenance CLI: exactly one of `--from`, `--usage` or `--clear`, always under the account-wide signing-stage lock, and always re-validating the destination directory's ownership and permissions first.

### apps/desktop/scripts/preflight-desktop-publish.mjs
Rejects a debugging artifact by *name* before any publication dependency is installed, pinning the exact packaging attempt. The comment is explicit about the limit: "Artifact names only reject; local inventory and signature verification still authorize publication."

### apps/desktop/scripts/render-tray-icon.ts
Renders the tray glyph at seven sizes from the vector source, scaling it 1.2× about the tile centre (preserving the background and the whale's aspect ratio) and packing the PNGs into an ICO. `packIco` and `unpackIco` both check the declared edge against the PNG's real dimensions, and 256 is encoded as 0 in the one-byte ICO fields.

### apps/desktop/scripts/resolve-desktop-publish-ci.ts
Selects one explicit successful packaging attempt from GitHub, requires exactly one successful `package` job, and maps the runner to a unique publishing label. It never falls back to an older attempt after a failure: a blank attempt means "the latest attempt, which must have succeeded".

### apps/desktop/scripts/resolve-retained-desktop-publish-ci.ts
Verifies the retained package against the GitHub selection evidence, checks the recorded commit is still reachable from the selected branch (or still resolves from the selected tag), and requires the deployment environment to have configured reviewers.

### apps/desktop/scripts/retain-desktop-ci.ts
Retains a completed CI package: the installers, the update archives, the blockmaps, the completion record and the channel metadata, together with a credential-free manifest. It records the *qualification* (signed/unsigned/notarized/unnotarized) and writes the next-step instruction into the Actions summary, so an operator learns from the run itself that a debugging package cannot publish.

### apps/desktop/scripts/setup-macos-packaging.mjs
Creates and validates the private macOS packaging directories — real, unlinked, mode 0700, owned by the current account — and copies the preset templates without overwriting existing files. `--check` inspects without creating.

### apps/desktop/scripts/start-macos-packaging-runner.sh
Checks the macOS toolchain and configuration files (including a compiled C linker probe), then runs the registered runner with `env -i` and a fixed PATH, under `caffeinate` so the machine does not sleep while the runner is alive. `--check` stops before registration and credentials are touched.

### apps/desktop/scripts/verify-published-windows.ps1
Three checks and nothing else: the Authenticode status must be `Valid`, the signer thumbprint must equal the configured release certificate, and a timestamping certificate must be present. It never signs and never touches the hardware token.

### apps/desktop/scripts/windows-runner-task.ps1
Installs and manages the Windows runner Scheduled Task: a per-runner task name derived from the directory's hash, an owner check against the task description, a repeating trigger, and a stop path that refuses to act while a `Runner.Worker.exe` job is active and that kills only the *owned* process subtree (identified by a parent-pid walk, with a process start-time check because "Parent IDs can be reused").

### apps/desktop/scripts/node-bin/node
A four-line POSIX `node` shim: it exports `ELECTRON_RUN_AS_NODE=1` and execs `$DSH_DESKTOP_NODE_EXECUTABLE --expose-internals "$@"`, so every package script can invoke `node` without a system Node on PATH.

### apps/desktop/scripts/node-bin/node.cmd
The Windows counterpart: sets `ELECTRON_RUN_AS_NODE=1` and execs the same packaged executable with `--expose-internals` and `%*`.

### apps/desktop/scripts/macos-entitlements.plist
The main application and Helper entitlement set: JIT, unsigned executable memory, disabled library validation and microphone input. It is referenced by both the `mac` and `entitlementsInherit` fields of the builder config, so the helper inherits the same set.

### apps/desktop/scripts/node-x64-entitlements.plist
The two-key entitlement plist for the x64 Node binary: JIT plus `allow-unsigned-executable-memory`, which the x64 target needs "for executable code pages, including under Rosetta".

### apps/desktop/scripts/jit-entitlements.plist
The single-key JIT entitlement plist used by the ARM64 runtime binaries and the LibreOffice helper.

### apps/desktop/scripts/prepare-windows-installer.ps1
Compiles the x86 `window-frame.dll` with the Visual C++ toolchain (`/LD /MT /O1 /W4 /WX`), optionally compiles the four native regression binaries and runs them, and converts the brand PNGs to 24bpp BMPs with the right background colour for the dark variants.

### apps/desktop/scripts/prepare-macos-ci.mjs
Validates the machine-owned macOS signing settings, emits the Actions log masks for every secret in the resolved environment, records the version and the artifact directory in the step summary, and adds an explicit warning when notarization is skipped: "signed but NOT notarized or stapled. Internal debugging only; Gatekeeper may block downloaded copies."

### apps/desktop/scripts/prepare-windows-ci.mjs
The Windows Actions adapter: validates the signing mode and the machine preset, emits the log masks, validates the environment, and writes the version and the step summary.

### apps/desktop/installer/strings.nsh
Every native installer string, in `en_US` and `zh_CN`. The file's header states the rule the whole installer follows: "NSIS owns installer localization independently of the Electron application locale". The failure copy is unusually good — "Installation did not finish. Close this installer and retry. If the problem persists, download the installer again." — and the per-user refusal explains the remedy rather than just refusing.

### apps/desktop/installer/theme.nsh
The Figma-derived installer palette, entirely in 96-DPI logical pixels, plus `/THEME=auto` resolution from `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`. The comment "SetCtlColors accepts only compile-time colors; choose between the two native palettes" explains why there are two parallel variable sets rather than a runtime-computed colour.

### apps/desktop/installer/pages.nsh
- Purpose: the native welcome and finish pages, drawn from scratch.
- Key abstractions: `InstallerCreate` builds the whole dialog with `nsDialogs`; `InstallerRender` swaps the visible controls per phase; `InstallerPaintButton` and `InstallerPaintCheckbox` are `NM_CUSTOMDRAW` handlers.
- Data flow: the path edit debounces a 450 ms validation timer (`InstallerValidateEditedPath`) that calls `InstallerValidatePath` and writes the message into the status label.
- Non-obvious design decisions: the pages are **not** NSIS's stock pages — the stock controls are hidden and the content is drawn, but the comment on `InstallerPaintButton` insists "NM_CUSTOMDRAW keeps native button focus, keyboard input and accessible text". The checkbox is likewise a real `BS_AUTOCHECKBOX` whose *painting* is replaced, so its state and accessibility role survive.
- Edge cases / failure handling: `InstallerWelcomeLeave` re-runs the preflight on the leave callback, because Enter can activate NSIS's hidden default button and skip the click path; `InstallerFinishLeave` hides the window, then launches, and restores the page on a launch failure so the user can retry.
- Surprising: an explicitly elevated installer still launches through the user's shell (`StdUtils.ExecShellAsUser`), because a per-user install must not appear to run as SYSTEM.

### apps/desktop/installer/lifecycle.nsh
The installer's phase callbacks: `InstallerGuiInit` (DPI, window size, DWM frame, hiding the stock controls), `InstallerWelcome` (aborted entirely when `${isUpdated}`), `InstallerBeforeInstall` (preflight + running-app check), `InstallerProgressShow` (the native progress overlay), `InstallerFinish`, and `.onInstFailed` which shows the failure message and sets exit code 2. The comment "Only the stock worker executes installation; this overlay runs on the UI thread" documents the thread split.

### apps/desktop/installer/path.nsh
- Purpose: validate the chosen installation path and preflight the destination.
- Key abstractions: `InstallerValidatePath` (a macro emitted for both the installer and the uninstaller) and `InstallerPreflight`.
- Data flow: the validated path becomes `$INSTDIR`; the preflight then checks the destination's ownership, writability and free space.
- Non-obvious design decisions: the validator rejects a long list of specific things — drive roots, reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, *with* an extension, because Windows reserves them anyway), trailing dots or spaces, reparse points, and the system folders. It also re-normalizes the path through `GetFullPathNameW` at the end, "Repeated trailing separators can normalize to a drive root".
- Edge cases / failure handling: a non-empty destination is allowed *only* if it is a registered installation (read from the uninstall registry key) and contains the expected executable; otherwise the user is told to choose an empty folder or the registered one. Free space is checked against `APP_64_UNPACKED_SIZE + 64 KiB`.
- Surprising: the validator is a macro emitted twice, so the *uninstaller* enforces the same path rules the installer does.

### apps/desktop/installer/drawing.nsh
GDI+ drawing macros for the installer: `InstallerRoundPath` builds a rounded rectangle from four arcs, with the comment "System.dll has no float argument type. The arc angles use IEEE-754 bits" — the angles `0x43340000` / `0x42B40000` are 180° and 90° encoded as floats, because NSIS's `System::Call` has no float type. The checkbox painter keeps the native state and draws a rounded check glyph when `BST_CHECKED`.

### apps/desktop/installer/progress.h
- Purpose: the installer's progress model.
- Key abstractions: `InstallProgress` with `stage`, `value`, `target`, and an `Advance(stage, fraction, now)` that eases toward a target.
- Data flow: the 7-Zip worker publishes its real percentage; the other stages (copy, register, clean) use bounded exponential estimates — `1 - exp(-elapsed/seconds)`.
- Non-obvious design decisions: the stage boundaries are `{0, 2, 94, 96, 98, 99}` so the real extraction owns 2–94% and the estimated tail is short. The comment "Only the successful NSIS finish callback may authorize 100%" is the important one: `Complete()` is the only path to 100, and `Advance` refuses to move backwards.
- Edge cases / failure handling: `Tick` clamps the fraction to 1 and the animation duration is 600ms on success, 250ms otherwise.
- Surprising: the README states the weighted percentage "does not predict remaining time" — the model is honest that it is a *percentage*, not an ETA.

### apps/desktop/installer/extract-progress.h
A 30-line parser for 7-Zip's refreshed output, which emits an ASCII percentage at the start of each line. It resets on `\r`, `\n` and `\b`, skips leading spaces, accumulates at most three digits, and only accepts a value that is greater than the current one — so a garbled or repeated line cannot move the bar backwards.

### apps/desktop/installer/extract.h
- Purpose: launch the pinned 7-Zip and publish its work percentage.
- Key abstractions: `InstallerExtract` (exported), `ExtractApplication`, `InstallerHandle` (RAII) and `InstallerAttributes` (the `PROC_THREAD_ATTRIBUTE_LIST`).
- Data flow: a pipe carries 7-Zip's stdout to the reader; each read updates an `ExtractionProgress` and publishes it as the window property `HarnessInstaller.ExtractProgress`.
- Non-obvious design decisions: the child is created inside a **job object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and an explicit handle list, so it cannot outlive the installer or inherit unrelated handles. The command line ends the output directory with `\.` — "A final dot prevents a destination's trailing backslash from escaping its closing quote."
- Edge cases / failure handling: **negative results are negated Win32 errors** and 0–255 are 7-Zip exit codes, so the two ranges never collide; a crash status like `0xC0000005` is returned bit-for-bit and printed in hex by the report. `std::bad_alloc` is caught and mapped to `ERROR_NOT_ENOUGH_MEMORY`.
- Surprising: the error output is forced to UTF-8 (`-sccUTF-8`) specifically so the failure report can quote paths from any code page.

### apps/desktop/installer/extract-report.h
- Purpose: turn an extraction failure into a report a user can send, and a dialog they can read.
- Key abstractions: `SevenZipMeaning(code)`, `DescribeResult(code)`, `Headline(code, output, archive)`, `Compose(...)`, `BoundedExcerpt(...)`, `Excerpt(...)`, `ReadOutput(path)`, `WriteUtf8`, `CopyToClipboard`, and `Show(...)` with a TaskDialog/MessageBox fallback.
- Data flow: the complete 7-Zip output is read from disk (bounded at 16 MiB), the report is written as UTF-8 with a BOM, and the clipboard receives the whole report while the dialog shows only a headline and a bounded excerpt.
- Non-obvious design decisions: `Headline` parses 7-Zip's `"<op> ERROR: <reason>"` and `"ERROR: <op> : <reason> : <path>"` forms and *skips* a detail that merely echoes the archive name, because that names nothing. `TrimPartialUtf8` drops an incomplete multi-byte tail before decoding — "A cut inside a multi-byte sequence would make the whole UTF-8 attempt fail". `WindowsVersion` calls `RtlGetVersion` directly rather than trusting the manifest.
- Edge cases / failure handling: `BoundedExcerpt` caps both line count (10) and total characters (1000) and states how many lines remain in the saved file; the clipboard copy retries 5 times with a 50 ms sleep, because the clipboard is frequently locked by another process.
- Surprising: the task dialog falls back to a plain `MessageBoxW` when `comctl32` v6 is unavailable, so the failure is still reported rather than silently lost.

### apps/desktop/installer/directory-report.h
A 30-line header that composes the *directory replacement* failure report — the same Windows error, the operation attempted (`MoveFileExW` or `RemoveDirectoryW`), the source and destination, the restoration error, the preserved backup path and the attempt log — and a `Content(...)` helper that keeps the dialog body complete even when the report excerpt is truncated.

### apps/desktop/installer/progress.h
(covered above with `installer/progress.h`.)

### apps/desktop/installer/uninstall-data.h
- Purpose: delete Windows user data safely.
- Key abstractions: `Normalize`, `Pin`, `Unlink`, `RemoveTree`, `Remove`, `RemoveEmptyParents`.
- Data flow: `Remove(path, installation, protectedRoot)` normalizes both roots, refuses anything overlapping the installation or the protected Harness home, checks the shell known folders, pins every ancestor directory, and only then walks the tree.
- Non-obvious design decisions: `Pin` opens each directory with `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES` and **without** `FILE_SHARE_DELETE`, so the open handle itself prevents a concurrent rename or removal — "Listing access takes part in share checks, so the open handle refuses the DELETE access a rename or removal needs." Reparse points are opened with `FILE_FLAG_OPEN_REPARSE_POINT` and refused as roots: "Linked descendants are unlinked only", so the helper never follows a link out of the tree.
- Edge cases / failure handling: every sibling is attempted and the *first* error is returned only after the whole tree has been visited ("keeps deleting siblings after a locked file"); read-only attributes are cleared before deletion; a missing target is `ERROR_SUCCESS`; an *unusable* protected root is `ERROR_INVALID_NAME` rather than silently permitting the delete.
- Surprising: it consults 14 `KNOWNFOLDERID`s and the `ProgramFilesDir` registry value, and it resolves the x64 Program Files path via `RRF_SUBKEY_WOW6464KEY` because "This helper is x86; the x64 Program Files known-folder id is unavailable to it."

### apps/desktop/installer/uninstall.nsh
The uninstaller's data-removal entry. It removes the Electron user-data directory and the updater download cache, honours `/KEEP_APP_DATA` (which electron-builder passes for in-place updates) and `${isUpdated}`, and never touches the Harness home. The comment at the top states the rule: "Electron user data and updater downloads leave with the application; the Harness home is never touched."

### apps/desktop/installer/window-frame.cpp
- Purpose: the native x86 helper the installer loads — DWM frame, progress page, extraction, failure reports and process detection.
- Key abstractions: `InstallerApplyFrame`, `InstallerShowProgress`, `InstallerFinishProgress`, `InstallerExtract`, `InstallerReportExtractFailure`, `InstallerReportDirectoryFailure`, `InstallerFindProcess`, `UninstallRemoveData`, `UninstallRemoveEmptyParents`.
- Data flow: the NSIS script calls these through `System::Call`; the progress page reads the stage and the extract percentage from **window properties** set by the NSIS worker thread.
- Non-obvious design decisions: the frame keeps the DWM shadow while the NSIS page owns the entire client area (`WM_NCCALCSIZE` returns 0, `WS_THICKFRAME` is added, `DwmExtendFrameIntoClientArea` is called with 1px margins). The module is **pinned** with `GetModuleHandleEx(GET_MODULE_HANDLE_EX_FLAG_PIN)` because "NSIS may release its DLL reference before the window receives WM_NDESTROY".
- Edge cases / failure handling: `InstallerFindProcess` matches on the **full resolved path**, not just the file name — "Match the affected executable, not another user's or directory's same-named application" — and returns -1 when the process list cannot be read, which the installer treats as a UI error rather than "not running". `InstallerFinishProgress` pumps the message loop for a bounded 750 ms so a painted 100% frame appears before the finish page.
- Surprising: the progress page implements its own minimize/close/drag hit-testing in `WM_LBUTTONDOWN` (the top 48 logical pixels are the caption), because the real NSIS caption is hidden.

### apps/desktop/scripts/electron-builder-config.mjs
- Purpose: the one factory that produces the electron-builder configuration for every packaging mode.
- Key abstractions: `createElectronBuilderConfig(env, hostPlatform, hostArch, preparedRuntime, preparedRuntimeVersion)` returning the whole config object.
- Data flow: the mode flags in the environment (`DSH_DESKTOP_UNSIGNED`, `DSH_DESKTOP_MACOS_SKIP_NOTARIZATION`, `DSH_DESKTOP_TARGET_PLATFORM/ARCH`) select the signing, notarization and update behaviour; `beforeBuild`/`beforePack`/`afterPack`/`afterSign`/`artifactBuildCompleted` are the five verification points.
- Non-obvious design decisions: the `artifactName` carries a mode suffix ("Unsigned builds carry their own suffix so a shared file can never pass for a release artifact"), and `extraMetadata.version` is only added when the build version differs from the product version, because electron-builder merges that into the packaged manifest — which is what the updater compares against.
- Edge cases / failure handling: `latest` channel + a prerelease version is rejected at configuration time; a macOS build with `skipNotarization` must be signed; `signIgnore` excludes the already-signed runtime tree from nested re-signing.
- Surprising: `afterPack` calls `verifyDesktopRuntime` with the *prepared* runtime version, so a qualification build (whose version is rewritten away from the product version) still verifies correctly.

### apps/desktop/scripts/package-target.ts
- Purpose: the packaging orchestrator for one target.
- Key abstractions: `DesktopPackageTarget`, `parseDesktopPackageInvocation`, `resolveDesktopPackageTarget`, `desktopElectronBuilderArguments`, `desktopElectronBuilderEnvironment`, `packageTarget`.
- Data flow: parse the flags → select the environment (a local macOS default for unsigned builds, otherwise the file-owned settings) → resolve the build version → `createPackagingRun` → `packagingStep` for configuration, toolchain and the platform package → write the release record.
- Non-obvious design decisions: `--unsigned` and `--prepare-only` are mutually exclusive; the `--` separator is filtered out of the args because `pnpm run <script> -- --build-version x` forwards it and `parseArgs` would otherwise read the rest as positionals. The build sequence is fixed and explicit (build:official → release:pack → desktop-host pack → vendor pack → landlock pack → prepare:runtime → prepare:packages → prepare:dsh → electron-builder), and the **release record is deleted before the build** so a failed build cannot leave a stale record behind.
- Edge cases / failure handling: the Windows signing stage installs SIGINT/SIGTERM handlers that abort the stage controller and detach before the operation runs, so a Ctrl-C does not leave a half-signed tree. A failure prints the redacted diagnostic and the path to `events.jsonl`.
- Surprising: `desktopElectronBuilderEnvironment` sets `ELECTRON_BUILDER_7Z_FILTER=BCJ` for Windows because "The bundled NSIS decoder cannot extract 7-Zip's automatic ARM64-filtered entries" — the ARM64 binaries that dependencies carry in an x64 installer would otherwise be un-extractable.

### apps/desktop/scripts/packaging-run.mjs
- Purpose: the supervised packaging run: a credential-free evidence journal and a child-process supervisor.
- Key abstractions: `recordPackagingEvent`, `failPackagingRun`, `packagingOutputRedactor`, `createPackagingRun`.
- Data flow: each stage writes `stage-start` / `stage-spawn` / `stage-end` events into `events.jsonl`; the child's stdout and stderr are streamed through the redactor into `stdout.log` / `stderr.log` and to the console; `finish(success)` writes `result.json`.
- Non-obvious design decisions: the redactor is a **streaming** filter that holds back a partial secret until it can decide: it only emits a buffer character when no known secret starts with it, and it waits while the buffer is a *prefix* of a secret. That is what makes a secret split across two chunks still get redacted.
- Edge cases / failure handling: a stage deadline "fails the run even if the child reports exit zero"; on Windows the process tree is killed with `taskkill /T /F` and on POSIX with `kill(-pid, SIGKILL)`; a nonzero termination code is itself an error. A `DSH_DESKTOP_PACKAGING_FATAL` marker written by a child stops the tree, and the presence of `fatal.json` blocks every later stage.
- Surprising: the child environment is filtered of `NODE_OPTIONS` and every credential-shaped name *before* the child starts — a preload hook cannot smuggle a secret into a signing subprocess.

### apps/desktop/scripts/packaging-step.mjs
Records an in-process phase in the same journal as the subprocess stages, and formats nested errors (including `AggregateError` members and the `cause` chain) with the credential values removed. It detects a circular error chain with a `seen` set and prints `[circular error]`. The `packagingErrorDetails` helper is what the terminal error path uses, so the journal and the console show the same redacted text.

### apps/desktop/scripts/desktop-bundle-imports.mjs
- Purpose: fail a Desktop bundle that leaves a bare import the packaged application cannot resolve.
- Key abstractions: `importPackageName`, `isBareSpecifier`, `unpackagedImports`, `packagedImportsPlugin`.
- Data flow: the plugin's `moduleParsed` hook inspects every module's `importedIds` and `dynamicallyImportedIds`; the offending specifiers are reported with the importing module and no output is written.
- Non-obvious design decisions: the check runs in `moduleParsed` rather than reading chunk metadata, because "Chunk metadata (`imports`/`dynamicImports`) omits external `import()` and `require()` targets". The policy distinguishes the Electron main process (Node builtins resolve) from a sandboxed preload, whose `require` polyfill offers only `electron`, `events`, `timers` and `url`.
- Edge cases / failure handling: the error message names the exact `pnpm run build:lib:host` remedy, because the underlying cause is usually a workspace package's `lib/` output missing at bundle time.
- Surprising: this gate exists because a rolldown `UNRESOLVED_IMPORT` is only a *warning* — the bundle succeeds, the specifier stays external, and the installed application then fails at launch with `ERR_MODULE_NOT_FOUND`.

### apps/desktop/scripts/desktop-package-environment.mjs
- Purpose: select the release settings a packaging run uses, with no ambient fallback.
- Key abstractions: `localMacOSPackageEnvironment`, `loadDesktopPackageEnvironment`, `validateDesktopPackageEnvironment`.
- Data flow: the selected dotenv (or `presets/<preset>.env` plus `secrets/<file>.env`) is parsed, filtered by an allowlist, and merged over a parent environment from which every release-shaped variable has been removed.
- Non-obvious design decisions: `AMBIENT_RELEASE_SETTING` (line 20) strips every `DSH_DESKTOP_*`, `APPLE_*`, `CSC_*` and `DOWNLOAD_*` variable from the inherited environment, so a shell variable can never supply a release setting. A dotenv key outside the allowlist is an error ("unsupported setting … use the platform template"), and a parse failure is reported *without* the parser's message, because "Parser diagnostics can contain credential-bearing input".
- Edge cases / failure handling: `CSC_KEY_PASSWORD` must be *present* but may be an explicitly empty string, because an unencrypted p12 is a legitimate case — "use an explicit empty value". `PACKAGE_TEST_RELEASE_ID` overrides the preset only for the test preset and must be 32 lowercase hex characters.
- Surprising: a preset's `DSH_DESKTOP_AUTO_UPDATE_ENV` must match the preset's *name*, so a file cannot silently point a "production" preset at the test deployment.

### apps/desktop/scripts/desktop-auto-update-environment.mjs
Resolves the deployment, channel, target and the public URL layout. The test deployment requires a valid HTTPS origin *and* a 32-hex release id, which becomes a random URL prefix (`dsh-desk/<release-id>/feeds/<target>`); production uses the fixed `https://download.deepseek.com`. `httpsOrigin` rejects credentials, a path, a query or a fragment — the origin must be exactly an origin. The file also names the two metadata filenames (`nightly.yml` / `nightly-mac.yml`) and the local completion record.

### apps/desktop/scripts/desktop-build-version.mjs
Validates a *build* version against the *product* version. The header comment is the design rationale: electron-updater compares feed versions with `semver.gt` against `app.getVersion()`, so a build version must extend the product version in the form `<product>-<prerelease fields>.<date>.<seq>`, and build metadata is rejected because "two builds would compare equal to the updater". It also explains why a stable product version gets the extra `test` field: `0.1.6-test.1` ranks *below* `0.1.6`, which is why that form belongs to a feed that never serves production.

### apps/desktop/scripts/desktop-build-version-discovery.ts
- Purpose: derive the next build sequence number instead of remembering it.
- Key abstractions: `desktopBuildDateSegment`, `suggestDesktopBuildVersion`.
- Data flow: it lists the destination bucket (paginated, 1000 keys per page) and reads the versions out of the object names; if the bucket is unconfigured or the listing cannot complete inside an 8-second deadline, it falls back to the local artifact directory.
- Non-obvious design decisions: "Asking the bucket first is what keeps a test feed's numbering unique across machines, and a fresh CI checkout has no local artifacts to fall back on." And the critical one: a listing that cannot finish **yields nothing** rather than a partial answer — "Numbering against a partial listing could reuse a published index."
- Edge cases / failure handling: an unconfigured destination returns `undefined` (not an empty list), because "An unconfigured destination has nothing to be unique against; an invalid one must not be mistaken for it."
- Surprising: the artifact-name regex accepts the `-unsigned` and `-unnotarized` suffixes, so a debug build's version is counted as taken.

### apps/desktop/scripts/desktop-build-commit.mjs
Reads the checkout's commit and dirty state once and passes them to every child process, because "A build that reaches a colleague or a test feed is not reachable from a tag, so the only way back to its sources is what the build recorded about itself." The dirty flag is what later prevents a release tag from being created for a modified tree.

### apps/desktop/scripts/desktop-ci-version.mjs
Resolves a manual CI build version: `product`, `auto` (UTC date + run number + attempt) or an explicit `manual` value. It requires both `GITHUB_RUN_NUMBER` and `GITHUB_RUN_ATTEMPT` to be positive integers, and rejects a prerelease on the `latest` channel. The error message always shows the exact example form for the current checkout.

### apps/desktop/scripts/desktop-policy-environment.mjs
Resolves the mandatory-update policy metadata from the *same* deployment selector as the updater. It refuses `origin` or `authentication` inside the policy JSON ("use the deployment origin settings"), requires nonempty `allowedAuthOrigins` for the test deployment, and **refuses** that field for production — the two deployments are structurally different, and the code says so.

### apps/desktop/scripts/desktop-release-environment.mjs
Resolves the public release identity: the reverse-DNS app id, the HTTPS npm registry origin (no path, no credentials), the macOS signing identity (rejecting electron-builder's unsupported `Developer ID Application:` prefix) and the 10-character team id, plus exactly one of three notarization credential strategies. The last block's `else` throws a message naming all three accepted strategies.

### apps/desktop/scripts/desktop-release-store.ts
- Purpose: retain an immutable packaging attempt outside the disposable checkout.
- Key abstractions: `retainedDesktopPath`, `retainDesktopRelease`, `verifyRetainedDesktopRelease`, `DesktopRetainedSource`, `DesktopRetainedManifest`.
- Data flow: files are copied into a staging directory, each copy is re-hashed, a manifest is written, and the staging directory is **renamed** into place.
- Non-obvious design decisions: the rename is the visibility gate — "an existing attempt is never replaced" and a partially copied attempt is never visible. The `retainedDesktopPath` derives the path from the run id and attempt, both validated as positive integers, so a manifest cannot escape the releases root.
- Edge cases / failure handling: the source is hashed before *and* after the copy, so a file that changes mid-copy is rejected; a `manifest.json` filename is reserved; the root and its parents must be real directories, not symlinks.
- Surprising: the manifest carries the packaged commit and its dirty flag, so a later publication can prove the bytes came from a clean tree — the check happens hours later, on another machine.

### apps/desktop/scripts/desktop-publish.ts
- Purpose: reconcile remote bytes before changing an update feed.
- Key abstractions: `DesktopPublishTransport`, `DesktopPublishOperations`, `DesktopPublishEvent`, `DesktopPublishResult`, `DesktopPublishError` with codes `conflict | superseded | invalid-plan | remote-changed | verification-failed`.
- Data flow: for each feed it reads the remote object first, then for each artifact it hashes the local bytes, compares with the remote digest, and either skips (identical), refuses (conflicting) or puts and re-reads to verify.
- Non-obvious design decisions: three distinct refusals with different remedies — a *newer* version already owning the channel is `superseded` (do not overwrite), the *same* version with different bytes is `conflict`, and a channel that changed between the preflight and the write is `remote-changed` ("inspect before retrying"). The write is never retried inside the function: "a later invocation hashes remote bytes to recover confirmed and ambiguous earlier writes."
- Edge cases / failure handling: a production plan must carry a clean 40-hex commit or it is rejected before any upload. The tag is created *after* the feeds, and a tag failure returns `published-tag-pending` rather than failing the upload.
- Surprising: `version(contents)` parses the remote YAML and throws away the parser's error details, because "Parser error details … may include raw remote YAML" — the remote bytes are treated as untrusted input.

### apps/desktop/scripts/desktop-publish-cos.ts
The COS transport, restricted to the plan's exact object keys — `location(key)` throws for anything outside the plan, and the key's *role* (binary vs channel metadata) must match too. Reads stream through a `Writable` so a large binary never lands in memory, and channel metadata is capped at 1 MiB. Writes re-hash the local input before sending ("local input changed"), send a streamed body with an explicit `ContentLength` and `Content-MD5`, and set `x-cos-forbid-overwrite` for immutable binaries.

### apps/desktop/scripts/desktop-publish-record.ts
The channel lock and the durable journal. The lock is a `mkdir` of a hashed destination directory — atomic, and a stale lock is *not* auto-cleared ("operators inspect stale locks explicitly"). The journal is created in a `.initializing-` directory and renamed, so a half-written journal is never scanned as complete. `wasDesktopAttemptPublished` only counts **newline-terminated** entries, because only those were completely appended before an interruption — the exact reason a `feeds-complete` line is a trustworthy resume signal.

### apps/desktop/scripts/publish-desktop-ci.ts
- Purpose: the CI publisher — publish a package that was built on another machine, from that machine's retained copy.
- Key abstractions: `prepareDesktopPublication(env, verifySignatures)` returning `{route, manifest, config, plan, root, approval}`.
- Data flow: parse the route → verify the retained manifest (every file re-hashed) → check the route matches the manifest → read the public config → build the upload plan → verify the platform signatures → compute the approval digest → (in `--check`) print the summary, or (in `--publish`) take the channel lock, create the journal and publish.
- Non-obvious design decisions: **`--check` never reads a secret and never contacts COS**, and it is the phase that produces the human-approval summary. The approval digest (line 53) is a SHA-256 over `{manifest, plan}`, and the publish phase re-computes it and refuses if the bytes or the destination changed after approval.
- Edge cases / failure handling: the task must be dispatched to the *same* machine (`route.runnerName !== env.RUNNER_NAME` rejects), the package's qualification must match its platform, and a production plan must be a clean commit. Failures are reported as a structured `{phase, code, message}`.
- Surprising: the resume path — if `wasDesktopAttemptPublished` says the feeds completed, the publisher skips straight to the tag, so a retry after a tag failure cannot re-publish old YAML over a channel that has since advanced.

### apps/desktop/scripts/desktop-publish-config.ts
Zod-validated public configuration: the bucket name pattern, an HTTPS origin with no path, an absolute credential-file path, and optional macOS/Windows/GitHub-App blocks. Production additionally requires the fixed origin and a GitHub App block. `readDesktopUploadCredentials` is a *separate* function called only after authorization — "Read upload credentials only after authorization and local validation have passed" — and it returns a generic error on failure so the file's contents never appear.

### apps/desktop/scripts/desktop-publish-route.ts
Validates a publication request against GitHub's run, job and manifest evidence. It requires the request's run id, attempt, commit, workflow path and qualification to all match, requires the workflow file to be the one for the target platform, and requires the manifest to carry a clean commit. It also enforces that each configured machine has a *unique* runner label — two machines sharing a label would break the "publish on the original machine" guarantee.

### apps/desktop/scripts/desktop-publish-tag.ts
Creates the `desktop-v<version>` tag with the GitHub App installation token — no ambient `gh` authentication. It verifies an existing tag names the *same commit* and refuses to move it, treats a 422 as "a parallel platform release created the same tag" and re-reads, and requires the ref to be a lightweight commit tag.

### apps/desktop/scripts/desktop-release-tag.ts
The local-git counterpart of the tagger, with the same philosophy stated in its header: "Tagging never fails an upload that already completed. The artifacts are public by then, and nothing about a missing tag can be repaired by reporting the upload as failed." On failure it returns the exact commands still outstanding (`git tag … && git push …`) rather than throwing.

### apps/desktop/scripts/desktop-upload-plan.ts
Builds the validated upload plan from the *retained* completion record rather than from shell variables — "Packaging wrote the version it published; reading it back keeps release settings out of shell variables." It re-validates the build version against the product version, cross-checks the channel metadata's version and single file, verifies each artifact's size and SHA-512 against the metadata, and rewrites the feed's `url`/`path` to absolute form before the YAML is published.

### apps/desktop/scripts/desktop-upload-run.ts
Performs the upload with durable evidence. Every object is one streamed PUT with an explicit length and `Content-MD5` — which is also what keeps the SDK's internal retry path unreachable, because "it repeats a request only when the body is not a stream". The function itself never retries. It writes `plan.json` (destination, version, per-file size/SHA-512/MD5, and the SHA-256 of the four uploader source files, so the record is bound to the uploader that produced it), `events.jsonl` and `result.json`, and a missing final result means interruption, not success.

### apps/desktop/scripts/desktop-publish-qualification.mjs
Explains, in Chinese, why a retained debugging package cannot publish: the remedy for `unsigned` and for `unnotarized`, plus the sentence that matters — "打包成功后使用新的 run ID / attempt 发布；重跑当前发布任务无效" (retrying the current publication task is useless; a new signed package is required). It is the one file in the shard whose text is user-facing rather than developer-facing.

### apps/desktop/scripts/rollback-desktop-channel.ts
The manual channel restoration CLI. It is preview-only by default (`--execute` is required to write), it demands a `--reason`, it requires the referenced publication record to match the selected package exactly (repository, run id, attempt, destination), and its transport's `tag` operation throws unconditionally — "desktop rollback never changes tags".

### apps/desktop/scripts/desktop-rollback.ts
The rollback mechanism, separated from the CLI so it can be tested. It verifies the *historical* binaries first (so a restore never advertises bytes that are gone), compares the current feed against the expected version and refuses a mismatch, and — in execute mode — re-reads the feed immediately before writing to catch a change since the preview.

### apps/desktop/scripts/verify-retained-desktop.ts
Re-verifies the retained artifacts at publication time: on Windows, Authenticode with the configured thumbprint and a timestamp; on macOS, the DMG's signature plus a *stapled ticket and Gatekeeper acceptance* for the app extracted from the ZIP. It also rejects a ZIP whose listing contains an absolute path, a backslash or a `..` segment before extracting anything.

### apps/desktop/scripts/desktop-publication-failure.ts
Classifies a failure into a safe `{phase, code, message, operation?, requestId?, httpStatus?}` record. It knows a fixed set of public COS and Node error codes and maps anything else to `operation-failed`; a `ZodError` becomes a list of invalid field paths; and only messages matching the repo's own prefix pattern are echoed verbatim. The `AccessDenied` message names the exact permission to inspect and says to reconcile remote state before retrying.

### apps/desktop/scripts/desktop-publication-summary.ts
Renders the Chinese approval summary: environment, version, channel, platform, the test release id with a note that it "reduces the address being guessable" but is not authentication, the installer and feed URLs, a link to the packaging attempt, the source ref and commit, the platform verification results, the proposed tag, and a details block with the COS bucket and the size and SHA-256 of the exact upload bytes. It ends with the warning that a public repository exposes the test prefix and download URLs.

### apps/desktop/scripts/installed-update-qualification.ts
- Purpose: allocate and inspect a local installed-update qualification run.
- Key abstractions: `createInstalledUpdateRun`, `readInstalledUpdateRun`, `inspectInstalledUpdateJournals`, `collectInstalledUpdateJournals`, `InstalledUpdateRun`, `InstalledUpdateEvidence`.
- Data flow: a run directory is allocated with a random id; the manifest records the app id, the two versions, the test origin, the bucket, the feed key and the binary prefix. The journals are the per-process JSONL files the installed app writes; they are parsed strictly and assembled into a milestone sequence.
- Non-obvious design decisions: the manifest's identity is **re-derived and compared on every read** — the app id, the product name, the feed key, the bin prefix and the directory must all still match the id, or the manifest is rejected. The journal parser whitelists fields, requires the sequence to be dense, requires the first record to be `started` and later ones not to be, and requires the timestamp to be a canonical ISO string.
- Edge cases / failure handling: a mixed-version or unexpected-pid journal is rejected; a journal that does not end in a newline is "an incomplete journal tail"; a journal over 10 MiB, or a snapshot over 50 MiB, is refused. The `missing` list and `recordedFlow: complete | incomplete` are the output.
- Surprising: the result carries `operatorVerificationRequired` — a fixed list of five things a human still has to check ("installer-completion-and-installed-path", "test-data-preserved", "screenshots-and-user-confirmations"). **The tool never declares the update successful**; it reports what it observed and what remains for a human.

### apps/desktop/scripts/installed-update-distribution.ts
Prepares the binary and feed plan for one version and states its own limit: "File integrity does not establish signature, application identity, or authority to publish." It cross-checks the generated feed against the installer's real size and SHA-512, and returns `verified: 'file-integrity-only'` and `publicationAuthorized: false` as part of the type.

### apps/desktop/scripts/installed-update-package-content.ts
Verifies the *extracted* payload rather than a neighbouring unpacked build: the ASAR's `package.json` identity, the entry point, the policy authentication mode, the presence of the `dsh/` tree, per-file SHA-256 against the frozen inventory, the `electron-updater` and `semver` versions, the feed URL, the cache directory name and the publisher, and the runtime descriptor. It also rejects an ASAR link or an unsafe path and checks that no extra files were added.

### apps/desktop/scripts/installed-update-signature.mjs
Verifies an executable with **both** the real `electron-updater` verifier (in a child process, so the main process's own logging cannot influence it) and `Get-AuthenticodeSignature`, requiring a valid signature, a timestamp and the expected thumbprint. It then re-hashes the file to prove it did not change during verification. The updater's log output is checked for `Verifying signature ` and for the absence of `Ignoring signature validation` — a *skipped* verification is treated as a failure.

### apps/desktop/scripts/verify-installed-update-package.ts
The end-to-end package verification, staged by name: `local-file-plan`, `installer-signature`, `archive-paths`, `extraction`, `payload-content`, `application-signature`, `runtime-signature-N`, `unchanged-inputs`, `complete`. `validateInstalledUpdateArchivePaths` refuses symbolic and hard links, reparse points, executable attributes, duplicate Windows paths, and any path component that is empty, `.`, `..`, ends with a dot or space, or is a reserved device name. Every input is re-hashed at the end, and the result file is always written — including on failure.

### apps/desktop/scripts/installed-update-publication.ts
Separates the immutable binary upload from the fixed-feed publication. Before either, it revalidates the current files against the successful verification receipt. The feed publication additionally requires a matching *successful binary upload receipt* on disk, requires the bucket's versioning to be confirmed disabled, and — for the successor version — requires startup evidence from the original installed application's journals, so the successor is only advertised after the original is demonstrably running. Every write is followed by a public readback.

### apps/desktop/scripts/installed-update-packaging.ts
Supervises one operator-confirmed qualification build. It refuses to run when the account's signing interlock file exists, refuses to reuse an existing packaging attempt or output directory, hashes the tool inputs before *and* after the build, and records a `qualification-failed` event with `retryAllowed: false` on error.

### apps/desktop/scripts/package-installed-update.ts
The operator entry for that build. The confirmation is a typed phrase naming the exact object — `PACKAGE <version> <runId>` — and it requires a TTY. The preamble tells the operator to cancel any password prompt rather than re-enter it, and that the PIN is read only from the file and only briefly appears in SignTool's arguments.

### apps/desktop/scripts/publish-installed-update.ts
The operator entry for qualification publication, with the same typed-confirmation pattern (`UPLOAD <version> <runId>` / `PUBLISH …`) and a local-only default that contacts no network. The Chinese preamble is specific about what the action will do, including that publishing the successor requires the version-1 journals directory.

### apps/desktop/scripts/prepare-installed-update.ts
The dispatcher for the qualification tools — `init`, `inspect`, `bootstrap`, `runtime`, `application`, `files`, `collect` — each printing JSON. Its catch handler deliberately does not echo the exception: "Inputs may be logs or local configuration; do not echo arbitrary exception details."

### apps/desktop/scripts/prepare-installed-update-application.ts
Freezes the built shell files for the version pair. It requires the four mandatory modules to be present ("rebuild Desktop before freezing application files"), refuses links and special files, hashes each input before and after the copy, and re-hashes the frozen tree on verification with a strict path pattern that rejects a backslash, a colon or a `..` segment.

### apps/desktop/scripts/prepare-installed-update-bootstrap.ts
Writes the shared qualification entry point — a 6-line module that configures the identity and then imports the production `lib/main.js` — with `flag: 'wx'` so an existing preparation is never overwritten.

### apps/desktop/scripts/prepare-installed-update-runtime.ts
Clones one verified runtime into two synthetic versions, rewriting the package versions and the runtime descriptor, and proving the *source* tree is byte-identical afterwards. The failure record includes `completedVersions` and `retryAllowed: false`.

### apps/desktop/scripts/prepare-installed-update-network.ts
Prepares one firewall fault plan bound to the verified version-1 executable's SHA-512. It requires the executable path to be inside the run directory, to be named after the product, and to hash to exactly the value in the successful signature receipt.

### apps/desktop/scripts/installed-update-network.ps1
The operator-side firewall tool. It verifies the plan's identity in every field (schema, run id, rule name, hash, executable name and absolute path), finds an *owned* rule or refuses, requires a typed `BLOCK <runId>` confirmation, re-hashes the executable after the confirmation, and records every stage. The final event is named `rulePresenceIsNotTrafficEvidence` — the presence of a rule is not proof that traffic was actually blocked.

### apps/desktop/scripts/installed-update-identity.mjs
Redirects `userData`, `sessionData`, `DSH_HOME` and the journal directory to a per-run location *before* the production main entry loads, and refuses a package whose `dshDesktopAppId` or version does not match the bootstrap. The comment states why: "Keep test application data and journals outside the replaceable installation tree."

### apps/desktop/scripts/installed-update-builder.ts
Builds the test-only signed builder configuration from the ordinary factory, overriding the app id, the package name, the entry point and the feed, and requiring the environment to match the run's test deployment. It re-verifies the frozen application files and the prepared runtime before the config is returned.

### apps/desktop/scripts/installed-update-cos.ts
A fixed test-COS transport with a strict key allowlist (`dsh-desk/(bin|feeds)/qualification/<24 hex>/win-x64/...`), a bucket-versioning check, streamed single-attempt writes with `forbidOverwrite`, and a public readback path that rejects a non-exact origin.

### apps/desktop/scripts/build-installed-update-worker.mjs
The builder child. It verifies it is owned by its live parent — the run directory must be the version-scoped one, and `run.json`'s `pid` must equal `process.ppid` — so a stray process cannot sign under an authorized parent's name. It re-checks the signing interlock and redacts credentials from any failure output.

### apps/desktop/scripts/windows-sign.mjs
- Purpose: the Windows code-signing gate.
- Key abstractions: `scrubWindowsSigningEnvironment`, `resolveWindowsUpdatePublisher`, `createWindowsTokenSigner`, `createRedactedWindowsSigningError`, `repairDanglingAuthenticodeDirectory`, `installWindowsNsisBootstrapSigner`.
- Data flow: the signer is a serialized promise chain, so a hardware token is never driven concurrently; each task copies the file, signs it with `windows-sign.cmd`, inspects the result, and then the timestamp step completes the signature.
- Non-obvious design decisions: the PIN is cleared from the environment **before** SignTool runs and the CMD script clears its own variables, so the PIN does not survive in the child environment. The publisher DN is built from the certificate's `CN`, `O` and `C` only, with the value escaped for the updater's format. `repairDanglingAuthenticodeDirectory` reads the PE header and clears a certificate-table entry that points past the end of the file — a real corruption seen with generated executables.
- Edge cases / failure handling: the failure diagnostic is rebuilt without the original error as its cause, because "execFile errors contain the command line, including private-key passwords". SHA-256 is required, nested (`isNest`) signatures are refused, and the NSIS bootstrap executable is signed *before* enterprise code integrity evaluates it.
- Surprising: the NSIS bootstrap signer works by patching `WineVmManager.prototype.exec` — it detects the NSIS bootstrap by its `__COMPAT_LAYER` environment marker and signs that specific `.exe` on the way past.

### apps/desktop/scripts/windows-signing-state.mjs
- Purpose: the durable hardware-signing interlock.
- Key abstractions: `beginWindowsSigningAttempt({runDirectory, stateDirectory, target})` returning `{started, success, failure}`.
- Data flow: it creates `~/.dsh-desktop-signing/attempt.json` with `flag: 'wx'` *before* SignTool is launched and removes it only on success.
- Non-obvious design decisions: "failures and interrupted attempts never unlock automatically" — the `failure` callback deliberately leaves the file in place, and even a failure to *record* the failure leaves the interlock, because the comment says the file stays "even if recording the failure or notifying the parent fails".
- Edge cases / failure handling: it refuses to run without a supervised packaging run (`run.json` must exist) and refuses to run when the run already has a `fatal.json`.
- Surprising: this is the shard's clearest instance of a general principle — *a scarce, irreversible resource should be protected by a durable file that only an explicit human-reviewed recovery removes*. It transfers directly to any tool that consumes a one-shot capability.

### apps/desktop/scripts/windows-signing-stage.mjs
Serializes a complete signing stage under an account-wide exclusive Windows file handle, using `koffi` to call `CreateFileW` with no sharing. Contention (Win32 error 32) waits with a 100 ms poll and records the wait; every other error stops before the stage runs. The state directory is checked for symlinks and reparse points first.

### apps/desktop/scripts/windows-timestamp.mjs
Signs once, then timestamps fresh copies at most three times with increasing backoff, and publishes by an atomic rename after byte verification. It refuses a staging path of 260 characters or more ("SignTool does not consistently support extended-length Windows paths"). On failure it copies the whole staging directory into the evidence directory; if *that* fails it throws an `AggregateError` carrying both failures, so the original failure is never lost.

### apps/desktop/scripts/windows-signature-cache.mjs
- Purpose: a content-addressed cache of complete signed files.
- Key abstractions: `signatureCacheIdentity`, `createCachedSigner` (a serial signer plus a parallel `restore`), `migrateSignatureCache`, `maintainSignatureCache`.
- Data flow: the cache key is `sha256({version, inputDigest, identity})` where `identity` is the hash of the public certificate and every file that controls the signing output. A hit restores the payload, re-verifies its trust and timestamp, and renames it over the target.
- Non-obvious design decisions: the identity deliberately excludes the PIN and the installation paths, so a cache is portable between machines but invalid when the certificate or the signing tools change. A corrupt entry **rejects** and is never repaired; the build stops.
- Edge cases / failure handling: publication is a staging directory plus an atomic rename, and a lost race (EEXIST/ENOTEMPTY/EPERM) resolves by validating the winner rather than overwriting it. `maintainSignatureCache` retires each entry atomically before deleting its files and leaves incomplete staging directories untouched.
- Surprising: `restore` is a *separate* operation from `sign`, and the caller may run restores concurrently while hardware signing stays serial — the expensive part (the token) is never parallelized, only the free part is.

### apps/desktop/scripts/windows-signature-batch.mjs
Inspects up to 128 files per round, in groups of 32, through at most four PowerShell processes, and *drains* every group before returning. `parseSignatureRows` rejects a row count that differs from the request, any stderr, and any row whose `path` does not match the requested file at that index — a reordered result is a failure, not a warning.

### apps/desktop/scripts/windows-signature-cache-directory.mjs
Resolves the account cache or a file-owned absolute local override, rejecting relative, network, device and alternate-stream paths, and hands the ownership check to `windows-signature-cache-directory.ps1`.

### apps/desktop/scripts/windows-signature-cache-directory.ps1
The Windows half of that check: the path must be on a fixed local drive, no ancestor may be a reparse point, a new directory gets a private DACL granting only the current account, SYSTEM and Administrators, and any ACL rule permitting another ordinary account is a failure.

### apps/desktop/scripts/windows-runtime-signature.mjs
Finds PE files **by content**, not by extension: it reads the `MZ` magic and then the `PE\0\0` signature at the header offset. A file that starts with `MZ` but is not a valid PE, or that has a `.exe`/`.dll`/`.pyd` extension and is not a PE, is an error — "malformed Windows executable files" stop the build. `preserveWindowsRuntimeSignature` keeps an already-signed copy only after both the source and the copy are proven byte-identical and the signature is valid.

### apps/desktop/scripts/windows-asar-unpack.mjs
Keeps prepared PE files outside the ASAR without changing their bytes. The glob translation is the interesting part: "Builder removes backslash escapes; brace expansion also ignores character classes" — so `{` and `}` become `?` and every other glob metacharacter becomes a character class, because electron-builder's matcher would otherwise expand `{a,b}` into two alternatives. The verification then requires each PE to be an unpacked ASAR entry, a real file on disk, and byte-identical to the prepared source.

### apps/desktop/scripts/windows-directory-installer.mjs
Patches the pinned electron-builder NSIS templates: the install section is replaced with a staging-and-rename flow, the exit helpers get a cleanup call, and the uninstaller's `RMDir /r $INSTDIR` becomes `RMDir /r "\\?\$INSTDIR"` for long paths. Every patch point uses `replaceOnce`, which throws if the upstream template no longer contains the expected text — so a builder upgrade that changes the template fails the build rather than silently skipping the patch. The 7-Zip tool is copied and **signed** so the bootstrap executable passes enterprise code integrity.

### apps/desktop/scripts/windows-sign.cmd
The CMD shim that actually calls SignTool. It copies the four inputs into local variables, then *clears* the environment variables before invoking the tool, so the PIN and the key container are not visible to any child of SignTool. The SafeNet key container is expressed as `[{PIN}]=CONTAINER`, the syntax the token expects.

### apps/desktop/scripts/windows-signing-preflight.ts
Signs one freshly compiled, never-executed probe before release preparation, verifying the timestamp and the thumbprint, and records the compiler, SignTool and certificate hashes. It refuses to run when a `fatal.json` or the signing interlock exists — "no automatic recovery" — and checks the certificate's validity window first. The probe is never executed: the record says `probeExecuted: false`.

### apps/desktop/scripts/sign-primary-runtime.ts
Signs the Windows runtime under the signing-stage lock with the content-addressed cache, then **seals the runtime hashes** (`writeDesktopRuntime`) only after signing, and runs the smoke checks against the signed descriptor. The failure path calls `failPackagingRun`, which blocks every later stage.

### apps/desktop/scripts/windows-package-settings.mjs
Validates the signature-cache worker count as an integer from 1 to 8, defaulting to four. The comment in the env example explains the split: "Cache-hit restore and verification workers (1-8). Hardware signing remains serial."

### apps/desktop/scripts/macos-signature-cache.ts
- Purpose: reuse verified standalone macOS signatures.
- Key abstractions: `cachedMacOSSignature(path, cacheRoot, signer)`, `pruneMacOSSignatureCache(root)`, `MacOSCachedSigner`.
- Data flow: the cache key is the hash of `{schema, input bytes, mode, signing policy}`; a hit copies the cached payload, verifies it, and renames it over the input; a miss signs a private copy, verifies it, publishes it atomically and then replaces the input.
- Non-obvious design decisions: the **file mode is part of the key**, because a signature is not reusable across a permission change. The policy string includes the actual leaf certificate, the identifier, the entitlement bytes, the signing tools and the OS release — so a policy change invalidates the cache.
- Edge cases / failure handling: the input is re-hashed before the swap so a file that changed during signing is rejected; a lost publication race resolves by verifying the winner.
- Surprising: `pruneMacOSSignatureCache` keeps the newest entries within a 1 GiB payload budget and "active readers fail closed on eviction races" — the eviction can fail a reader safely rather than corrupt it.

### apps/desktop/scripts/macos-cache-policy.ts
Builds the signing policy from the keychain's own signed probe, so the cache key is derived from the certificate that will actually be used. Its `verify` path re-reads the signature and refuses any file that is not a *thin* Mach-O — a universal binary is signed every time, because its signature covers two architectures.

### apps/desktop/scripts/macos-signing-keychain.mjs
Creates a temporary keychain, imports the p12, unlocks it, authorizes signing, and prepends it to the user search list — because "codesign ignores `--keychain` unless that file is also on the search list". It signs a small probe and verifies it before any release work starts, and it restores the previous search list and deletes the keychain in a `finally`. The child environment receives the keychain *path* and never the p12 password.

### apps/desktop/scripts/macos-runtime.ts
Signs and verifies every materialized Mach-O file with four workers, using `Promise.allSettled` so one failure does not leave the others running. The JIT entitlement is applied only to the Node binary and the LibreOffice helper, and the x64 Node gets the extra `allow-unsigned-executable-memory` entitlement because it also runs under Rosetta. It reports cache hits, misses and uncached files.

### apps/desktop/scripts/verify-macos-signature.mjs
The macOS verification surface. `assertMacOSSignatureDetails` requires the exact `Authority=Developer ID Application: …` line *and* the exact `TeamIdentifier=…` line. `assertMacOSRuntimeSignatureDetails` additionally requires a `Timestamp=` line and `flags=…(runtime)` — hardened runtime. The notarized checks run `stapler validate` and `spctl --assess`.

### apps/desktop/scripts/macos-app-update-config.mjs
Writes and re-verifies `app-update.yml` inside the assembled App. The verification is what makes the packaging chain safe: `afterPack` writes it, `package-macos.ts` checks it on both artifact copies and again after promotion, so a missing or mismatched feed prevents artifact promotion and therefore prevents upload.

### apps/desktop/scripts/macos-package-settings.mjs
Validates the pack concurrency and the two proxy origins, rejecting credentials, paths, queries and fragments. `macOSDownloadEnvironment` rewrites the child proxy variables and sets `NO_PROXY=localhost,127.0.0.1,::1` so an explicit proxy bypasses only local hosts.

### apps/desktop/scripts/macos-signature-cache-directory.mjs
Requires the macOS cache directory to be absolute, unlinked at every ancestor, owned by the current account, mode `0700`, and readable/writable/searchable — and it "never create[s] or repair[s] it during packaging". A missing setting falls back to the target-local cache, which the signer may create.

### apps/desktop/scripts/macos-notarization-proxy.ts
- Purpose: route Apple tools through a proxy, temporarily, and restore the system afterwards.
- Key abstractions: `withMacOSNotarizationProxy`, `restoreMacOSNotarizationProxy`, `ProxyState`, `ProxyRecord`.
- Data flow: under a per-user `flock`, it reads the active network service's proxy settings, writes them to a recovery record, sets the proxy, runs the callback, and restores the settings in a `finally`.
- Non-obvious design decisions: the lock file's **inode is kept** across transactions — "unlinking it would allow two independent locks". It refuses to proceed if PAC, proxy auto-discovery or SOCKS is enabled, because those "can override explicit proxies". SIGINT/SIGTERM set a flag rather than exiting, so the work drains and the proxy is restored.
- Edge cases / failure handling: the original settings are re-read after every write and compared, so a change that did not take effect is an error. A restore that fails throws with the exact recovery command (`pnpm --dir apps/desktop run restore:mac-proxy`), and the recovery record is *not* deleted so a later run can finish it. A restore refuses to run while the recorded owner pid is still alive.
- Surprising: `restoreMacOSNotarizationProxy` is a separate CLI entry point, and the recovery path is designed for the case where the process was killed — which is exactly the case a `finally` block cannot handle.

### apps/desktop/scripts/flock-entry.ts
Loads the POSIX flock native entry on first use, building `native/system` once when the addon's binary or its emitted JavaScript is missing, so `check:package` and the packaging entry work on a checkout that has not been built. A failed load resets the memoized promise, so the next call retries.

### apps/desktop/scripts/verify-macos-signature.d.mts
Type-only declaration of the macOS signing and verification entry points, including the runtime and notarized-application checks.

### apps/desktop/scripts/macos-app-update-config.d.mts
Type-only declaration of the macOS updater feed and its write and verify operations.

### apps/desktop/scripts/macos-package-settings.d.mts
Type-only declaration of the macOS pack concurrency and the two stage-specific proxies.

### apps/desktop/scripts/macos-signature-cache-directory.d.mts
Type-only declaration of the optional machine-owned macOS signature storage rules.

### apps/desktop/scripts/macos-signing-keychain.d.mts
Type-only declaration of the temporary macOS signing keychain wrapper.

### apps/desktop/scripts/notarize-macos-disk-images.d.mts
Type-only declaration of the DMG notarization and verification entry.

### apps/desktop/scripts/notarize-macos.d.mts
Type-only declaration of the notarize-and-staple helper.

### apps/desktop/scripts/logged-notarytool.d.mts
Type-only declaration of the notarytool adapter that splits submit and wait.

### apps/desktop/scripts/preflight-desktop-publish.d.mts
Type-only declaration of the publication preflight.

### apps/desktop/scripts/prepare-windows-ci.d.mts
Type-only declaration of the manual Windows CI version resolver.

### apps/desktop/scripts/desktop-auto-update-environment.d.mts
Type-only declaration of the update deployment, channel, target and upload configuration plus the resolver signatures and their documented throws.

### apps/desktop/scripts/desktop-build-commit.d.mts
Type-only declaration of the packaged commit, its dirty flag and the two environment variables that carry them.

### apps/desktop/scripts/desktop-build-paths.d.mts
Type-only declaration of the per-target build directories, the target/platform resolution and the artifact output selection.

### apps/desktop/scripts/desktop-build-version.d.mts
Type-only declaration of the build-version resolver, its validator and the version-prefix helper.

### apps/desktop/scripts/desktop-bundle-imports.d.mts
Type-only declaration of the bare-import policy, the bare-specifier test and the rolldown plugin that fails an unresolvable external import.

### apps/desktop/scripts/desktop-ci-version.d.mts
Type-only declaration of the manual CI version resolver.

### apps/desktop/scripts/desktop-package-environment.d.mts
Type-only declaration of the local macOS default environment, the machine-preset loader and the pre-flight validator.

### apps/desktop/scripts/desktop-policy-environment.d.mts
Type-only declaration of the mandatory-update policy environment shape.

### apps/desktop/scripts/desktop-publish-qualification.d.mts
Type-only declaration of the diagnostic that explains why a retained debugging package cannot be published.

### apps/desktop/scripts/desktop-release-environment.d.mts
Type-only declaration of the app id, npm registry, macOS signing identity and the three accepted notarization credential strategies.

### apps/desktop/scripts/installed-update-identity.d.mts
Type-only declaration of the qualification identity configuration.

### apps/desktop/scripts/installed-update-signature.d.mts
Type-only declaration of the file hash and the two-source signature verification.

### apps/desktop/scripts/packaging-run.d.mts
Type-only declaration of the packaging run supervisor, its event recorder and the streaming redactor.

### apps/desktop/scripts/packaging-step.d.mts
Type-only declaration of the in-process phase recorder and the redacted error formatter.

### apps/desktop/scripts/windows-asar-unpack.d.mts
Type-only declaration of the PE unpack preparation and verification.

### apps/desktop/scripts/windows-directory-installer.d.mts
Type-only declaration of the pinned NSIS directory installation adapter.

### apps/desktop/scripts/windows-package-settings.d.mts
Type-only declaration of the Windows signature-cache concurrency setting.

### apps/desktop/scripts/windows-runtime-signature.d.mts
Type-only declaration of the PE signature inspection, preservation, signing and verification surface.

### apps/desktop/scripts/windows-sign.d.mts
Type-only declaration of the Windows signing surface: environment builder, publisher resolution, token signer, scrubber, redacted error and the NSIS bootstrap hook.

### apps/desktop/scripts/windows-signature-batch.d.mts
Type-only declaration of the batched public-key verification.

### apps/desktop/scripts/windows-signature-cache-directory.d.mts
Type-only declaration of the Windows signature-cache directory rules.

### apps/desktop/scripts/windows-signature-cache.d.mts
Type-only declaration of the content-addressed signature cache, its counters, the migration and the maintenance surface. It is the most informative of the set — it documents that counters include failed attempts, that restore time includes verification and staging cleanup, and that "the caller drains all restores before signing or reporting failure".

### apps/desktop/scripts/windows-signing-stage.d.mts
Type-only declaration of the account-wide signing stage lock.

### apps/desktop/scripts/windows-signing-state.d.mts
Type-only declaration of the hardware-signing interlock and its completion callbacks.

### apps/desktop/scripts/windows-timestamp.d.mts
Type-only declaration of the timestamp completion surface and its options.

### The .d.mts declaration files as a group
All 36 are type-only declaration files, one per implementation module. They are the shard's "documented interface" surface: each declares the exported functions with their parameters, return types and the conditions under which they throw. They contain no runtime behaviour, so each is documented above with a single line naming what it declares.

### apps/desktop/scripts/logged-notarytool.mjs
Splits electron-notarize's `submit --wait` into a timed upload and a timed wait, so the packaging journal records how long Apple took to *accept* separately from how long it took to *process*. The submission id is validated as a UUID before the wait begins, the Apple status is recorded, and a rejection's JSON is returned to electron-notarize so its diagnostic retrieval still works.

### apps/desktop/scripts/notarize-macos.mjs
Wraps `notarize` with the measured adapter inside a packaging journal phase, and collects the credential-shaped arguments so they are redacted from the journal.

### apps/desktop/scripts/notarize-macos-disk-images.mjs
Notarizes and staples a finished DMG, verifies it, and deletes the stale blockmap electron-builder wrote for the *pre-notarized* image — otherwise the blockmap would describe bytes that no longer exist.

### apps/desktop/scripts/package-macos.ts
Runs the App and DMG lanes concurrently on **separate copies** of the signed app, so a stapling operation on one cannot disturb the other. `Promise.allSettled` means both lanes settle before cleanup or rejection, and an `AggregateError` carries both failures. The artifacts are promoted into the final directory only after both lanes succeeded and every artifact is confirmed non-empty.

### apps/desktop/scripts/cos-operation.ts
A total deadline for one COS operation. It wraps `http` and `https` so that *every* request the SDK makes — including its own retries — inherits one `AbortController`, and it waits for the requests to close before returning. The timeout error is named `TimeoutError` so a caller can distinguish it from a transport failure.

### apps/desktop/scripts/desktop-cos.ts
Builds the COS client with `AutoSwitchHost`, `FollowRedirect`, `CorrectClockSkew` and `ChunkRetryTimes` all off, so "an ambiguous write is never sent to another endpoint". It also removes the empty `Cache-Control` header the SDK injects, leaving cache policy to the deployment infrastructure.

### apps/desktop/scripts/desktop-upload-run.ts
(see the note above — the durable upload evidence and single-attempt PUTs.)

### apps/desktop/scripts/desktop-publication-summary.ts
(see the note above — the Chinese approval summary.)

### apps/desktop/scripts/desktop-toolchain-preflight.ts
Probes the external tools a run will shell out to *before* it starts, because "The packaging sequence reaches its first archive step minutes in". The `tar` probe deliberately runs beside the archive with a relative name, since GNU tar reads the colon in an absolute Windows path as a remote-host separator. The Windows probe locates the Visual C++ build tools through `vswhere` with a specific component requirement.

### apps/desktop/scripts/prepare-runtime.ts
Downloads and extracts the target Electron distribution through `@electron/get` into the shared download cache, prepares the primary runtime, stages the CLI launcher and the macOS command-link helper, and writes `versions.json` with the Node and pnpm versions the application will report.

### apps/desktop/scripts/prepare-primary-runtime.ts
Thin adapter over the shared `scripts/primary-runtime/prepare.ts`, plus a `smokePrimaryRuntime` that verifies the manifest's platform and arch against the *host* and returns early when they differ — because a prepared Windows payload cannot be smoke-tested on a macOS host.

### apps/desktop/scripts/prepare-dsh.ts
- Purpose: materialize the production runtime tree the application ships.
- Key abstractions: the ordered `packagingStep` phases — `runtime:reset`, `runtime:stage-packages`, `runtime:lockfile`, `runtime:install`, `runtime:materialize-modules`, `runtime:manifests`, `runtime:primary-smoke`, `runtime:write-descriptor`, `runtime:verify-before-smoke`, `runtime:smoke`, `runtime:verify-after-smoke`, `runtime:cleanup`.
- Data flow: the package set is copied into a temporary project, the patches are staged, pnpm resolves a lockfile, the lockfile is verified against the core package set, pnpm installs frozen, the node_modules tree is copied with the file policy applied, the manifests are transformed, the natives are signed, the descriptor is written and the smoke runs.
- Non-obvious design decisions: the *descriptor* is written only after signing and before the smoke, and the tree is verified again *after* the smoke — because the smoke may write to the tree. On any failure the whole output directory is removed.
- Edge cases / failure handling: the pnpm child environment excludes `NODE_OPTIONS`, `NODE_PATH` and every `DSH_DESKTOP_*` variable, and gets its own registry, store, userconfig and XDG directories, so a build cannot inherit the developer's package-manager state.
- Surprising: the install uses `--frozen-lockfile --trust-lockfile` against a *freshly generated* lockfile — the lockfile is produced by this build, then frozen, so the two cannot disagree.

### apps/desktop/scripts/prepare-package-set.ts
Selects the local npm tarball closure rooted at dsh and the private Desktop Host. A workspace dependency that was *not* packed is an error ("packed inputs omit required package"), and the Host tarball must contain every file in `DESKTOP_HOST_RUNTIME_FILES` before the closure is accepted.

### apps/desktop/scripts/prepare-runtime-patches.ts
- Purpose: stage the explicitly classified Desktop patches.
- Key abstractions: `prepareRuntimePatches`, `verifyRuntimePatches`, `PreparedRuntimePatch`, `PreparedRuntimePatches`.
- Data flow: the source `pnpm-workspace.yaml` and `pnpm-lock.yaml` are read, every workspace patch must be classified, the selected patch bytes are copied into the disposable project, and the project's own `pnpm-workspace.yaml` is rewritten to point at them.
- Non-obvious design decisions: a *shared* patch must hash-match the root lockfile, and the classification is exhaustive — "Every root patch must be classified". The policy is a separate module (`runtime-patch-policy.ts`) that states the *reason* for each decision.
- Edge cases / failure handling: the destination may not be the source workspace; a patch path must be inside the repository; a stale decision (a patch the workspace no longer has) is an error; and a workspace-only dependency that entered the runtime stops packaging — "review its patch scope".
- Surprising: the patch bytes are staged as `patches/desktop-<n>.patch` in the *temporary* project, so the source workspace is never modified — a build cannot dirty the tree it is building from.

### apps/desktop/scripts/runtime-patch-policy.ts
The explicit classification of every workspace patch as `shared`, `workspace-only` or `runtime-only`, each with a reason: the streamed argument-parsing fix is shared because the runtime providers need it; the packer and the signing tool are workspace-only because they execute on the build host. It also declares the reviewed dependency override separately, with the reason that the provider's patch is qualified against a specific version.

### apps/desktop/scripts/runtime-file-policy.ts
The omission rules for the immutable runtime tree: package-manager metadata, source maps, TypeScript declarations and build caches, the other platform's LibreOffice engine, fs-ext compiler output, Domino's test directory and Yarn metadata, node-pty's ConPTY sources on non-Windows, node-pty prebuilds for other platforms and its `.pdb` files, and the Koffi import library. The comment "Unrecognized assets and target runtime binaries are retained" is the safety property — the policy only removes what it explicitly recognizes.

### apps/desktop/scripts/prepare-runtime-manifests.ts
Applies electron-builder's own dependency-manifest cleanup before the runtime bytes are sealed, so the archived manifests are byte-identical to what the builder would have written.

### apps/desktop/scripts/verify-runtime-archive.ts
Compares the complete archived `dsh/` tree with the sealed inventory: the descriptor bytes, file membership, per-file SHA-256, the executable flag for archived entries and the *physical* permissions for unpacked ones. It rejects an ASAR link and an unexpected unpacked entry.

### apps/desktop/scripts/smoke-runtime.ts
- Purpose: the full Host smoke for a prepared runtime.
- Key abstractions: `smokeDesktopRuntime(root, node, runtime, environment, resourcesRuntime)`.
- Data flow: a throwaway home is created; the CLI installs and removes a local plugin offline; a second plugin registers HTTP routes; the Host starts; the frontend, the plugin route, a bundled-pnpm plugin installation, three real Office conversions and the skill CLI are exercised; the home is removed.
- Non-obvious design decisions: the home directory is redirected at *every* level (`DSH_HOME`, `HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `LOCALAPPDATA`) so the smoke cannot touch the user's real data. The plugin that performs the installation asserts it received the *same* Cordis instance (`ctx instanceof Context`), which is a real check that the runtime's shared dependency graph is intact.
- Edge cases / failure handling: the readiness wait is bounded at 120 seconds and rejects with a specific message; the teardown removes the home with retries, and `host.stop()` runs even when an assertion failed.
- Surprising: the Office checks are not mocked — a fixture script creates real DOCX/XLSX/PPTX inputs with the bundled Python, and the smoke asserts the PDF's `%PDF-` header *and* its trailing `%%EOF`.

### apps/desktop/scripts/smoke-prepared-runtime.ts
Runs the archive integrity check, then the payload smoke under Electron RunAsNode, then the full Host smoke — with a private native cache and a scrubbed environment.

### apps/desktop/scripts/smoke-packaged-runtime.ts
Verifies the *assembled* application: the runtime descriptor against the selected target, the Windows code signatures, and the packaged runtime smoke against the ASAR tree.

### apps/desktop/scripts/smoke-windows.ps1
Runs the NSIS directory and replacement checks and then exercises both locked-file replacement modes, verifying that the old file survived and the new one was written.

### apps/desktop/scripts/smoke-installer-directories.ps1
Drives the production directory transaction through nine failure modes — `first`, `upgrade`, `transient-lock`, `locked`, `locked-stage`, `missing-stage`, `restore-conflict`, `broken`, `cancelled` — and for each one checks the exit code (0 or 2), which version survived, whether an obsolete file is still there, that no transaction directory was left behind, and the *contents* of the saved report (the Windows error, the number of attempts, the operation name). The `transient-lock` case actively watches the operations log to prove the installer observed the sharing violation before the handle was released.

### apps/desktop/scripts/installer-directories.nsh
- Purpose: the directory transaction.
- Key abstractions: `dshDirectoryOperation`, `dshStageApplication`, `dshPromoteDirectories`, `dshRollbackDirectories`, `dshFinishDirectories`.
- Data flow: the payload is extracted into `$INSTDIR.new-<guid>`, the existing directory is renamed to `$INSTDIR.old-<guid>`, the new one is renamed into place, and only then is the backup removed.
- Non-obvious design decisions: the retry predicate is **exactly** Windows errors 5, 32 and 33 (access denied, sharing violation, lock violation) — "Directory renames … retry Windows errors 5, 32, and 33 up to ten attempts, with 250 ms increasing delays (11.25 seconds of total waiting per operation). Other errors stop immediately." The `SetOutPath` handle is released before either rename, because an open directory handle makes the rename fail.
- Edge cases / failure handling: a failed promotion rolls back to the backup, and a failed *restoration* preserves the backup and stops the recovery (`dshRecoveryStopped`) rather than retrying. The rollback removes only directories this installer created.
- Surprising: the rollback path deliberately leaves the backup directory in place and names it in the report — the user is told to keep it and contact support.

### apps/desktop/scripts/installer.nsh
The installer include: per-user enforcement (an all-users install or an existing HKLM install is refused with a message naming the remedy), `/THEME=` parsing with a validation message, the brand and helper staging, the 7-Zip extraction callback, the running-application check, and the failure-report callbacks that write a timestamped log beside the updater cache.

### apps/desktop/scripts/test-windows-installer.mjs
Builds an isolated payload through the *production* NSIS configuration and exercises the English and Chinese installer variants in turn, each into a private directory, then uninstalls them. It also compiles and runs the native regression binaries. The `finally` block restores the environment exactly and prints the artifact directory.

### apps/desktop/scripts/test-local-updater.mjs
Drives the real Electron updater against a loopback server with real `NsisUpdater` HTTP requests, checks the result and the screenshots, retains the evidence, and removes the temporary root. The comment "Screenshot failure is recorded separately, never reported as visual acceptance" is a discipline worth copying.

### apps/desktop/scripts/test-signed-updates.mjs
The signed/unsigned download qualification, with a bounded timeout that kills the whole process tree (`taskkill /T /F`, because "Authenticode starts PowerShell") and records the outcome as JSON.

### apps/desktop/scripts/test-windows-update-signature.mjs
Exercises the real NSIS publisher verification with four cases — a missing-publisher negative control, a matching publisher, a wrong publisher, and an unsigned file — and asserts that the verifier was *invoked* and that PowerShell validation was not skipped. It also re-hashes both inputs afterwards to prove the verification did not modify them.

### apps/desktop/scripts/test-workspace-updates.ts
Runs the compiled Electron main entry against a private profile with the local update delivery and real Host IPC, with a `--interactive` mode for a human, and a 120-second deadline otherwise.

### apps/desktop/scripts/test-host-updates.ts
Runs the built Host's task protection in a private development profile with the model, telemetry and title plugins disabled, and a 120-second deadline.

### apps/desktop/scripts/dev.ts
The development launcher: builds the workspace and the shell, verifies the built artifacts exist, prepares the disposable project and the primary runtime, and launches Electron with the three inspector ports (main 9229, renderer 9222, Host 9230) and an isolated user-data directory. It refuses to run outside pnpm.

### apps/desktop/scripts/development-project.ts
Rebuilds the disposable npm project as links to the current workspace, mirroring pnpm's hoisted graph *and* the declared workspace closure — "Configured workspace plugins must resolve from the profile even when pnpm does not hoist them". It refuses to run when the CLI or Host package version does not match the release identity.

### apps/desktop/scripts/development-app.ts
Prepares and registers a disposable `Harness Dev.app` for macOS: copies the Electron bundle, rewrites the Info.plist, writes a launcher that exports the development home and the debug ports, ad-hoc signs it, and registers it with Launch Services. The identity is content-addressed, so the bundle is only rebuilt when the settings change.

### apps/desktop/scripts/prepare-cli.ts
Copies the platform launcher into the runtime `cli/bin` directory and makes the POSIX one executable.

### apps/desktop/scripts/prepare-command-link.ts
Compiles the macOS command-link helper with `clang` for the target architecture and the Electron minimum macOS version, with `-Wall -Wextra -Werror`.

### apps/desktop/scripts/command-path.ps1
The Windows per-user PATH manager: a per-SID mutex, a JSON fingerprint of the PATH snapshot that must match the request's `expected` value before a write ("PATH changed after confirmation"), ownership bookkeeping for the managed entry (including whether the PATH value was absent before), and a `WM_SETTINGCHANGE` broadcast. It reports a command with a higher PATH precedence rather than silently shadowing it.

### apps/desktop/scripts/upload-with-credentials.ps1
The DPAPI credential launcher. It imports a CLIXML file, requires non-empty `SecureString` fields, scrubs the child environment of every secret and of `NODE_OPTIONS`, redacts the credential values from stdout, **suppresses** the child's raw stderr ("SDK exception objects can include signed request details"), and disposes the secure strings in a `finally`.

### apps/desktop/scripts/upload-target.ts
Uploads a validated target. `resolveCredentialUploadEnvironment` requires the launcher's declared deployment *and* bucket to match the packaged release destination, so a credential set cannot be pointed at a different bucket. A production upload records the release tag only for a clean packaged commit; a dirty tree prints why the tag was not created.

### apps/desktop/scripts/read-desktop-app-key.mjs
Passes the GitHub App private key to the token action through `GITHUB_OUTPUT` with a random UUID delimiter, after emitting the Actions log mask — and the key is *also* masked because the mask is what hides it in the log.

### apps/desktop/scripts/prepare-windows-ci.mjs / prepare-macos-ci.mjs
The Actions adapters. Both emit `::add-mask::` lines for every secret in the resolved environment (because "Machine-owned secrets are not automatically known to the Actions log masker") and write a step summary. The macOS one adds a warning to the summary when notarization is skipped.

### apps/desktop/scripts/setup-windows-packaging.ps1 / setup-macos-packaging.mjs
Create and validate the private machine directories (a fixed local drive, no reparse points, current-account ownership, a private DACL / mode 0700) and copy the preset templates without overwriting existing files.

### apps/desktop/scripts/start-windows-packaging-runner.ps1 / start-macos-packaging-runner.sh
Start the registered runner with a scrubbed environment (Windows: an explicit allowlist; macOS: `env -i` with a fixed PATH), probe every required tool, and refuse to start a second listener. The macOS one compiles a small C linker probe to prove the toolchain works.

### apps/desktop/scripts/run-windows-runner-task.ps1 / windows-runner-task.ps1
The Scheduled Task that keeps the Windows runner alive. The repeating trigger replaces an "action exit-code retry" — "Repeating Task Scheduler triggers recover an exited launcher without relying on action exit-code retries" — and the restart budget is bounded by a file counter, after which the task disables itself. The stop path refuses to kill a task whose process identity cannot be confirmed, and it kills only the *owned* process subtree (identified by parent-pid walk, with a process-start-time check because "Parent IDs can be reused").

### apps/desktop/scripts/macos-runner-service.sh
Installs and manages the macOS runner LaunchAgent, generating the plist template in Node while rejecting newlines and `{{` template placeholders in every path — because `svc.sh` substitutes its own placeholders with sed.

### apps/desktop/scripts/jit-entitlements.plist / node-x64-entitlements.plist / macos-entitlements.plist
The three macOS entitlement sets: JIT only (ARM64), JIT plus unsigned-executable-memory (x64 Node, which also runs under Rosetta), and the main-application set with JIT, unsigned executable memory, disabled library validation and microphone input.

### apps/desktop/scripts/macos-cache-policy.ts
(see the note above — the thin-Mach-O-only cache policy.)

### apps/desktop/scripts/desktop-release-environment.mjs, desktop-auto-update-environment.mjs, desktop-policy-environment.mjs
(see the notes above — the public identity, the update deployment and the mandatory-update policy resolution.)

### apps/desktop/scripts/prepare-primary-runtime.ts, prepare-package-set.ts, prepare-runtime-manifests.ts, prepare-runtime-patches.ts, runtime-file-policy.ts, runtime-patch-policy.ts, verify-runtime-archive.ts
(see the individual notes above — the runtime preparation chain and its two explicit policies.)

### apps/desktop/scripts/packaging-run.mjs / packaging-step.mjs / packaging-run.d.mts / packaging-step.d.mts
The evidence layer: the supervised run, the in-process phase recorder, the streaming redactor and the nested-error formatter, with their type declarations.

### apps/desktop/scripts/desktop-release-store.ts, desktop-publish.ts, desktop-publish-cos.ts, desktop-publish-record.ts, desktop-publish-route.ts, desktop-publish-config.ts, desktop-publish-tag.ts, desktop-publish-qualification.mjs
The publication layer: retention, reconciliation, transport, locking and journaling, routing, configuration, tagging and the debugging-package refusal.

### apps/desktop/scripts/desktop-upload-plan.ts, desktop-upload-run.ts, desktop-rollback.ts, desktop-publication-failure.ts, desktop-publication-summary.ts, desktop-release-tag.ts
The upload and audit layer.

### apps/desktop/scripts/windows-sign.mjs, windows-signing-state.mjs, windows-signing-stage.mjs, windows-timestamp.mjs, windows-signature-cache.mjs, windows-signature-batch.mjs, windows-signature-cache-directory.mjs, windows-signature-cache-directory.ps1, windows-runtime-signature.mjs, windows-asar-unpack.mjs, windows-directory-installer.mjs, windows-sign.cmd, windows-signing-preflight.ts, sign-primary-runtime.ts, windows-package-settings.mjs
The Windows signing layer.

### apps/desktop/scripts/macos-signature-cache.ts, macos-cache-policy.ts, macos-signing-keychain.mjs, macos-runtime.ts, macos-notarization-proxy.ts, macos-app-update-config.mjs, macos-package-settings.mjs, macos-signature-cache-directory.mjs, verify-macos-signature.mjs, logged-notarytool.mjs, notarize-macos.mjs, notarize-macos-disk-images.mjs, package-macos.ts
The macOS signing and notarization layer.

### apps/desktop/scripts/installed-update-qualification.ts, installed-update-distribution.ts, installed-update-package-content.ts, installed-update-signature.mjs, installed-update-publication.ts, installed-update-packaging.ts, installed-update-identity.mjs, installed-update-cos.ts, installed-update-builder.ts, prepare-installed-update*.ts, package-installed-update.ts, publish-installed-update.ts, verify-installed-update-package.ts, build-installed-update-worker.mjs, installed-update-network.ps1
The installed-update qualification layer — the closest thing in this shard to an end-to-end harness test.

## Ideas worth stealing

- **A streaming credential redactor that survives chunk boundaries** — `apps/desktop/scripts/packaging-run.mjs:38` — the redactor holds back a buffer while it is still a *prefix* of a known secret and only emits a character once no secret can start with it, so a PIN split across two stdout chunks is still removed. Transferable to any harness that streams subprocess or tool output: a naive `output.replace(secret, '[REDACTED]')` per chunk leaks the tail of every split secret.

- **A durable interlock that a failure never unlocks** — `apps/desktop/scripts/windows-signing-state.mjs:43` — the attempt file is created with `wx` before the scarce resource is used and is removed *only* by `success()`; the `failure` callback leaves it in place even if recording the failure itself fails. Transferable to any operation that consumes a one-shot capability (a hardware token, a paid API key, a signing certificate): the next run must refuse and demand a human-reviewed recovery, rather than retrying and burning another attempt.

- **Derive sequence numbers from observed state, and refuse to number against a partial answer** — `apps/desktop/scripts/desktop-build-version-discovery.ts:133` — the build index comes from listing what was actually published, and a listing that cannot complete inside its deadline yields *nothing* rather than a partial list, because "Numbering against a partial listing could reuse a published index." Transferable to any harness that issues ordered identifiers (session ids, task numbers, memory keys): read the real prior state, and treat an incomplete read as "I do not know" rather than "there is nothing".

- **Reconcile remote state before mutating it, and distinguish the three refusals** — `apps/desktop/scripts/desktop-publish.ts:98` — a newer version already owning the channel is `superseded`, the same version with different bytes is `conflict`, and a channel that changed between preflight and write is `remote-changed`. Each has a different remedy, and none of them is "retry". Transferable directly to any tool that writes shared state (a memory file, a session transcript, a scheduled job): read the current bytes first, and classify *why* they differ.

- **A distinct "published, tag pending" terminal state instead of a boolean** — `apps/desktop/scripts/desktop-publish.ts:36` and `apps/desktop/scripts/desktop-publish-record.ts` — the outcome is `complete | published-tag-pending | failed`, and the durable journal records a `feeds-complete` event, so a retry after a tagging failure is *tag-only* and can never re-publish old YAML over a channel that has since advanced. Transferable to any multi-step operation whose later steps are cheap and whose earlier steps are expensive and observable: model the partial-success states explicitly and make the retry resume at the right step.

- **Bind the human approval to the exact bytes and destination** — `apps/desktop/scripts/publish-desktop-ci.ts:53` — the approval is a SHA-256 over `{manifest, plan}`, recomputed after approval; changed bytes or a changed destination reject rather than proceed. Transferable to any approval-gated harness action: the approval must cover the *content*, not the intent.

- **A tool that reports what it observed and what a human must still check, and never declares success** — `apps/desktop/scripts/installed-update-qualification.ts:241` — the evidence object has `recordedFlow: complete | incomplete`, a `missing` list of unobserved milestones, and a fixed `operatorVerificationRequired` list (installer completion, data retention, screenshots, network recovery). Transferable to any qualification harness: the machine reports the evidence it has; the acceptance decision stays with a human; and "the log says the flow completed" is never confused with "the flow worked".

- **A content-addressed cache whose key includes the whole policy, and whose hits are re-verified** — `apps/desktop/scripts/macos-signature-cache.ts:53` and `apps/desktop/scripts/windows-signature-cache.mjs:148` — the key is the hash of the input bytes plus the mode plus the certificate, identifier, entitlements, tools and OS; a hit is re-verified for trust before use, and a corrupt entry rejects rather than being repaired. Transferable to any cache of an expensive or scarce operation (a model response, a compiled artifact, a signed blob): key on the *policy*, not just the input, and treat a hit as untrusted until re-verified.

- **Content-addressed caching that never parallelizes the expensive part** — `apps/desktop/scripts/windows-signature-cache.mjs:217` and `apps/desktop/scripts/windows-runtime-signature.mjs:141` — `restore` (free, hardware-free) is a separate operation that the caller may run concurrently, while `sign` (the hardware token) stays a serial promise chain; the concurrent restores are drained and any failure is thrown before the serial leg starts. Transferable to any harness with an expensive bottleneck: split the operation into a parallelizable "reuse" leg and a serial "acquire" leg, and drain the parallel leg before the serial one.

- **No ambient fallback for configuration, and a loader that will not echo a credential-bearing parse error** — `apps/desktop/scripts/desktop-package-environment.mjs:20` and `:109` — every release-shaped environment variable is stripped from the inherited environment, a dotenv key outside the allowlist is an error, and a parse failure is reported without the parser's message because "Parser diagnostics can contain credential-bearing input". Transferable to any harness config surface: the effective config must be the file's, not the file's-plus-the-shell's, and a config error message must never contain the config.

- **A build gate that fails the *bundle* rather than the installed application** — `apps/desktop/scripts/desktop-bundle-imports.mjs:83` — a rolldown plugin inspects every module's static, dynamic and `require()` imports and fails the build naming the offending specifier, because the alternative is an installed application that dies at launch with `ERR_MODULE_NOT_FOUND`. Transferable to any harness that ships a bundle: a check that can only be run against the *installed* artifact should be moved to build time.

- **Stage, back up, promote by rename, and roll back — retrying only the sharing violations** — `apps/desktop/scripts/installer-directories.nsh:51` and `apps/desktop/installer/uninstall-data.h:99` — the retry predicate is exactly Windows errors 5/32/33, ten attempts with increasing delay, and every other error stops immediately; a failed restoration preserves the backup and stops the recovery instead of retrying. Transferable to any harness that replaces a directory or a file in place: name the transient failure class explicitly and never retry the rest.

- **Deleting data without ever following a link, and without touching the protected root** — `apps/desktop/installer/uninstall-data.h:64` — each ancestor is *pinned* with a handle that does not share delete access, reparse points are opened with `OPEN_REPARSE_POINT` and refused as roots, and the protected Harness home and the installation are refused as targets. Transferable to any harness that cleans up scratch space: a cleanup routine that can follow a symlink out of the tree is a data-exfiltration primitive.

- **A bounded excerpt in the UI, the complete report on disk and in the clipboard** — `apps/desktop/installer/extract-report.h:134` — the dialog shows at most 10 lines and 1000 characters and says how many more lines are in the saved file; the file keeps everything, capped at 16 MiB, with the truncation recorded. Transferable to any harness error surface: the user-facing message must be bounded *and* must say where the rest is.

- **A UI that cannot be tricked into accepting an action** — `apps/desktop/renderer/mandatory-update-frame.js:25` — the bridge requires a trusted event, the parent as source, the `dsh-app://app` origin, exactly one port, and no prior port; and the renderer derives the button's *action* from the phase rather than storing it, so a stale click cannot install what the current state forbids. Transferable to any harness UI that a model or a page might influence.

- **Escape is cancellation, never acceptance, and out-of-order updates are dropped by revision** — `apps/desktop/renderer/update-dialog.js:27` — the dialog compares `state.revision` against the rendered revision and ignores an older one, and a single-flight `responding` flag prevents a double answer. Transferable to any streaming UI fed by a server or an agent: version the state, and make the destructive key mean cancel.

- **A toolchain preflight that exercises behaviour, not just presence** — `apps/desktop/scripts/desktop-toolchain-preflight.ts:26` — the `tar` probe creates an archive and lists it *beside* the archive with a relative name, because GNU tar reads the colon in an absolute Windows path as a remote-host separator; the probe would have passed a mere `tar --version`. Transferable to any harness that shells out: probe the specific behaviour the run depends on, at the specific invocation the run will use.

- **A stage deadline that fails the run even when the child exits zero** — `apps/desktop/scripts/packaging-run.mjs:128` — the timeout is recorded separately from the exit status, and a timeout kills the process *tree* (taskkill /T on Windows, a process-group kill on POSIX). Transferable to any harness tool call with a deadline: "the child exited 0" is not the same as "the work finished in time", and a timeout must stop the whole subtree, not just the direct child.

- **A machine that publishes only what it built, and cannot publish another's package** — `apps/desktop/scripts/desktop-publish-route.ts:58` and `apps/desktop/scripts/publish-desktop-ci.ts:31` — the route is validated against GitHub's run, job and manifest evidence ("request does not match the successful packaging attempt"), the task must be dispatched to the *same* machine that built it ("task was dispatched to a different machine"), and each configured machine needs a unique label. Transferable to a multi-worker harness: a worker should be able to prove it owns the artifact it is about to act on.

## Files skipped (with reasons)

- `apps/desktop/installer/assets/brand.png` — 16 620-byte PNG, the 1x light-theme installer brand bitmap. Opened its first 16 bytes and confirmed the PNG signature (`89 50 4E 47 0D 0A 1A 0A`); it is raster artwork with no logic, so it was not read line by line.
- `apps/desktop/installer/assets/brand-2x.png` — 40 058-byte PNG, the 2x light-theme brand bitmap; same PNG header check, raster artwork only.
- `apps/desktop/installer/assets/brand-dark.png` — 16 418-byte PNG, the 1x dark-theme brand bitmap; same PNG header check, raster artwork only.
- `apps/desktop/installer/assets/brand-dark-2x.png` — 39 867-byte PNG, the 2x dark-theme brand bitmap; same PNG header check, raster artwork only.
- `apps/desktop/installer/assets/uninstaller-sidebar.png` — 10 064-byte PNG, the uninstaller sidebar artwork, converted to a 164×314 BMP during preparation; same PNG header check, raster artwork only.
- `apps/desktop/resources/icon.png` — 369 009-byte PNG, the original 1104×1104 application icon; same PNG header check, raster artwork only.
- `apps/desktop/resources/icon-windows.png` — 128 820-byte PNG, the Windows application icon; same PNG header check, raster artwork only.
- `apps/desktop/resources/icon-macos.png` — 279 163-byte PNG, the macOS application icon; same PNG header check, raster artwork only.
- `apps/desktop/resources/tray-windows.ico` — 15 698-byte ICO (header `00 00 01 00` + 7 directory entries) holding the 16–64 px PNG bitmaps; raster artwork only. The *generation* of this file (`render-tray-icon.ts`) was read in full, so the sizes and the whale scale factor are established from the code, not guessed.
- `apps/desktop/resources/icon.svg` — 7 281-byte SVG, the original whale artwork in a 1104 viewBox. Read the header, the first path and the `<defs>` block to confirm it is the unadapted source with drop-shadow filters; the remaining hundreds of path coordinates are artwork, not logic, so they were not read line by line.
- `apps/desktop/resources/icon-windows.svg` — 7 365-byte SVG, the Windows adaptation (rx=192 tile, 1024 viewBox) whose whale group carries `id="tray-glyph"`. Read the header and group structure; the same artwork rationale applies.
- `apps/desktop/resources/icon-macos.svg` — 7 354-byte SVG, the macOS adaptation (rx=230 inset tile). Read the header and group structure; same rationale.
- `apps/desktop/renderer/assets/welcome-brand.svg` — 15 929-byte SVG, the 472×40 brand wordmark whose glyphs are filled with `var(--dsw-alias-label-primary)`. Read the header, the `<style>` block and the first paths to confirm it is the light/dark aware brand mark; the remaining glyph outlines are artwork.
- `apps/desktop/renderer/update-close.svg` — 8-line static close glyph, two `<path>` elements in a 14×14 viewBox. Read in full; it is listed as skipped only because it is a fixed vector asset with no behaviour, and the note records its exact structure.

## Uncertainties

- **I could not establish which parts of the shard are exercised by the repo's test suite.** The shard's own scripts reference fixtures under `apps/desktop/tests/` (`tests/fixtures/local-updater.mjs`, `tests/fixtures/host-update-qualification.mjs`, `tests/fixtures/workspace-updates.mjs`, `tests/fixtures/signed-updates.mjs`, `tests/fixtures/runtime-payload-smoke.mjs`, `tests/fixtures/office-conversion-inputs.py`, `tests/fixtures/installer-directory-smoke.nsi`, `tests/fixtures/installer-write-failure-smoke.nsi`) and native C++ test sources (`tests/windows-uninstall-data.cpp`, `tests/windows-installer-progress.cpp`, `tests/windows-installer-presentation.cpp`, `tests/windows-installer-extract-report.cpp`). **Those files are in other shards and I did not open them**, so I can say what each smoke *asserts* only from the assertion text inside the shard's own scripts. If a fixture weakens an assertion, that is invisible to me.
- **The mandatory-update and ordinary-update *main-process* implementations are outside this shard.** `apps/desktop/src/` (the main entry, the preloads, `mandatory-update-policy.ts`, `runtime-tree.ts`, `host-process.ts`) is not in `dsh-apps-desktop#1`. I therefore describe the renderer and the shipped documents precisely, but the *policy evaluation*, the download, the signature verification and the task-drain logic are described here only through the README's account of them, not from the code. Specifically, I could not verify from source how the "Host locks new requests, drains admitted requests, and rechecks tasks" sequence in `README.md:276` is implemented, nor how the update check's ±20% jitter and doubling backoff are computed.
- **The `dsh` CLI implementation is outside this shard.** `apps/desktop/cli/dsh` and `cli/dsh.cmd` launch `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`; the `cli.js` source lives under `apps/desktop-host/` (another shard). I can confirm the launcher's invocation and flags, not the CLI's own command surface.
- **I could not verify the "runtime archive" and "runtime descriptor" formats** beyond how this shard uses them. `verifyRuntimeArchive`, `writeDesktopRuntime` and `verifyDesktopRuntime` live in `apps/desktop/src/runtime-tree.ts`, outside the shard; I read the *callers* and the invariants they assert (byte equality, file membership, executable flags) but not the descriptor's own schema.
- **Two behaviors are asserted by comments rather than by code I read.** The `windows-signature-cache` "restore is a separate operation" contract is documented in `windows-signature-cache.d.mts` and implemented in `windows-signature-cache.mjs:217`; but the *call site* that drains restores before serial signing is in `windows-runtime-signature.mjs:141`, which I read — so this one is confirmed from code. By contrast, the NSIS stub's `installer.nsh` / `installer-directories.nsh` pairing is asserted by the upstream-template patch in `windows-directory-installer.mjs`, whose exact expansion depends on electron-builder 26.17.0's NSIS templates, which I did not read.
- **The `packaging/README.zh.md`, `publishing/README.zh.md` and `publishing/ci/README.zh.md` translations were read only in part** (frontmatter, headings and the opening paragraphs, plus the first section of the top-level `README.zh.md`). I confirmed they are paired Chinese translations of the English documents, and the `*.i18n.yaml` hash records give the per-section pairing mechanically — but I did not translate-compare them section by section.
- **The 14 binary/vector assets' *rendered* appearance was not verified.** I confirmed each file's format from its header bytes and, for the SVGs, its structure from the markup; I did not view the images, so I cannot state what the brand artwork or the whale actually looks like.
