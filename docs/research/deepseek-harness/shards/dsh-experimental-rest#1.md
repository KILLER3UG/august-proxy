# deepseek-harness / dsh-experimental-rest#1

## Shard shape

This shard is the whole `packages/experimental/` tree of the deepseek-harness repo (245 files, 15 packages plus the directory-level `AGENTS.md`). It is not the agent loop itself — it is the **plugin layer that sits on top of the loop**: optional capability packages that a profile mounts, each one either a *provider* (a browser, a computer-use driver, a speech recogniser), a *bundle* (a `cordis.patch.yml` that composes rows into a profile), a *client UI plugin* (a browser-side React contribution registered into named slots), or a *shared library* the providers depend on. The unifying shape is the **Cordis plugin/fiber model**: `apply(ctx, config)` mounts, `ctx.effect()` owns teardown ordering, and every package ships a paired `README.md` / `README.zh.md` / `README.i18n.yaml` (a per-heading hash record of the bilingual pair) plus a `locale/en.json` + `locale/zh.json` metadata pair. The interesting engineering lives in four places: (a) an LLM-as-authorization-gate (`auto-review`), (b) a shared per-Session resource ownership runtime (`browser-use-runtime`) that both MCP and native browser providers plug into, (c) a computer-use stack (`cua` + two Cua Driver providers) that treats *application consent* and *coordinate freshness* as first-class protocol concerns, and (d) a reasoning-translation client that treats streamed thinking content as a paragraph stream with an explicit "tail is still growing" rule.

## Per-file notes

### packages/experimental/AGENTS.md
- Purpose: 9-line rules supplement for anything under `packages/experimental/`.
- Key abstractions: "experimental" = the package's *complete public contract* is experimental or internal-only; promotion means moving to a product-role group and re-reviewing the public contract, limitations, test evidence, release payload and named stable owner.
- Data flow: none — policy text.
- Non-obvious design decisions: (1) a package joins the dsh release family **by default** (`publishConfig.access: public`, no `private`) unless its directory is in `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`; (2) release packages and apps **outside** this group may not name experimental packages in `dependencies`/`optionalDependencies`/`peerDependencies` — the default-product isolation note also checks transitive installs, runtime imports and shipped compositions in CI; (3) experimental packages *may* depend on release packages and each other; (4) "publishing an experimental package does not promote it".
- Edge cases / failure handling: tests may use experimental packages through `devDependencies`; examples may load them explicitly.
- Surprising: "Experimental status does not relax engineering, security, documentation, lifecycle, testing, or snapshot requirements."

### packages/experimental/api-speech-to-text/src/index.ts
- Purpose: `SpeechController` — a `TypertRemoteService` exposing the `speech` Remote namespace to authenticated browser clients.
- Key abstractions: `Config { maxAudioBytes, maxDurationSeconds }`; `catalog()` / `follow()` / `configure()` / `prepare()` / `cancelPreparation()` / `transcribe()`.
- Data flow: browser records → base64 → `transcribe()` validates → `ctx.speechToText.resolve({audio, providerId, language})` → provider → `Transcript`. `follow()` streams `ctx.speechToText.follow(signal)` snapshots, each merged with the config limits.
- Non-obvious design decisions: the byte limit is checked **twice** — once cheaply on the encoded string length (`encoded.length > Math.ceil(maxAudioBytes/3)*4`) and once on the decoded bytes; canonical base64 is proven by **re-encoding and comparing** (`audio.toString('base64') !== encoded`), so a trailing newline or padding variant is rejected. `maxAudioBytes` default is 4 MiB and `z.natural().min(46)` encodes "the smallest possible WAV header". `configure()` is delegated to the Host, and the constructor comment says "Speech calls never activate or submit to an Agent".
- Edge cases / failure handling: `signal.throwIfAborted()` before dispatch and again in the catch, so an abort is never reported as a transcription failure; failures become `RemoteError('speech/transcription-failed', reason, { reason })` with the raw message. A `providerId`/`language` of `undefined` is spread as *absent* rather than `undefined`.
- Surprising: audio is **transient** — never a Session event or attachment; only the user's later ordinary submission records the recognised text (so the model context and the KV cache are untouched).

### packages/experimental/api-speech-to-text/src/types.ts
- Purpose: JSON-safe request/result types for the speech Remote plus the `RemoteErrorDetailsMap` entries.
- Key abstractions: `TranscriptionRequest { audioBase64, providerId?, language? }`; `SpeechCatalog extends SpeechSnapshot` adding the two limits.
- Data flow: types only.
- Non-obvious design decisions: the error map declares `'speech/invalid-audio'` and `'speech/transcription-failed'`, each with a `reason` string — the *reason* is a field, so the client can distinguish "encoding or size" from "the provider rejected it".
- Edge cases / failure handling: `TranscriptionRequest` is documented as "separate from Session admission" — the request never enters a Session.
- Surprising: the details map is declared in the *client-facing* types package, so the error vocabulary is typed on both sides.

### packages/experimental/api-speech-to-text/tests/controller.spec.ts
- Purpose: 71-line spec proving the domain methods validate audio *before* selecting a recogniser.
- Key abstractions: a `fixture()` that registers a fake provider on a real `SpeechToText` service and constructs a real `SpeechController`; a hand-built `recording()` that writes a canonical 16 kHz mono PCM16 WAV header byte by byte.
- Data flow: builds a 32044-byte WAV (44-byte header + 32000 bytes data) and base64s it.
- Non-obvious design decisions: the test asserts `expect(recognize).not.toHaveBeenCalled()` after every rejection — the *provider is never reached* on invalid audio, which is the whole point of validating first. The oversized case is tested twice: an over-long *encoded* string and a decoded buffer one byte over the limit.
- Edge cases / failure handling: cancellation is asserted by passing `AbortSignal.abort(new Error('cancel'))` and expecting the rejection to keep the abort reason rather than becoming a `speech/transcription-failed`; a non-Error rejection (`mockRejectedValueOnce('failed')`) is still surfaced as a message.
- Surprising: `api.configure({ language: 'zh' })` is expected to *reject* with 'settings service' — the fixture deliberately has no settings service, proving the controller does not own preference storage.

### packages/experimental/api-speech-to-text/tests/wave.spec.ts
- Purpose: 25-line spec for `validateWave` — the Host-side header/duration validator.
- Key abstractions: a `wave()` builder that writes a canonical 44-byte RIFF header plus 32000 bytes.
- Data flow: byte-level corruption of the header.
- Non-obvious design decisions: the corruption loop flips **one bit at each of 13 header offsets** (0, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 4, 40) and every one must be rejected as 'canonical' — the validator is expected to detect any single-field inconsistency, not just a broken magic number. An odd-length buffer whose sizes are rewritten consistently must *also* be rejected.
- Edge cases / failure handling: `validateWave(wave(), 1)` returns 1 (the duration) and `validateWave(wave(), 0.9)` throws 'exceeds' — the limit is a duration, checked against the declared data size, not the wall clock.
- Surprising: `validateWave` lives in the *speech-to-text* package, not here — this package only calls it, so the format has exactly one owner.

### packages/experimental/api-speech-to-text/README.md
- Purpose: package reference for the `speech` Remote.
- Key abstractions: the doc's fixed sections (Summary / Use / Understand / Further Exploration / Model Experience / Known Limitations / Dev Note).
- Data flow: documents that `prepare(providerId, { downloadSource })` forwards one advertised source; omission keeps the provider's configured policy.
- Non-obvious design decisions: the Model Experience section states "None, as recordings and preparation remain outside model requests" and "KV Cache effect: No direct effect" — the package is explicitly audited for its (non-)effect on prompt construction.
- Edge cases / failure handling: known limits: no file upload, no persistent transcript history, no streaming protocol; base64 adds transport overhead.
- Surprising: "A disconnected observer does not cancel preparation" — the preparation task is Host-owned and outlives the client that started it.

### packages/experimental/api-speech-to-text/README.zh.md
- Purpose: the Chinese mirror of the speech Remote reference (structure identical, section ids unchanged).
- Key abstractions: same 7-section template; anchors reuse the English ids so cross-links work in both languages.
- Data flow: n/a — translation of the English doc.
- Non-obvious design decisions: the pair is kept in sync by a *hash record* (`README.i18n.yaml`), not by hand: `pnpm run verify-translation-pairing --write <path>` re-records per-heading hashes after either side is edited.
- Edge cases / failure handling: the "Known Limitations" section names the same three gaps as the English side.
- Surprising: the Chinese text renders the `downloadSource` parameter with its English identifier untranslated, so the doc stays grep-able against the source.

### packages/experimental/api-speech-to-text/README.i18n.yaml
- Purpose: per-heading bilingual-pair hash record for the speech Remote README.
- Key abstractions: a YAML map from an anchor path to `{en, zh}` 64-bit hashes; the root key `/` plus one key per heading section.
- Data flow: `pnpm run verify-translation-pairing --write packages/experimental/api-speech-to-text/README.md` recomputes them.
- Non-obvious design decisions: hashes are taken "per heading section, of its English and Chinese blocks **outside code blocks and generated regions**" — so a fenced YAML sample cannot drift the record.
- Edge cases / failure handling: n/a — a mismatch fails the doc gate, not a test.
- Surprising: the same file shape is repeated for every package in the repo, which is how bilingual drift is caught mechanically rather than by review.

### packages/experimental/api-speech-to-text/locale/en.json
- Purpose: the plugin's marketplace metadata title/description in English.
- Key abstractions: a two-key `meta` object (`title`, `description`).
- Data flow: read by the Plugins page.
- Non-obvious design decisions: the description is written from the *user's* point of view ("Provide speech transcription for browser clients"), not the implementation's.
- Edge cases / failure handling: n/a.
- Surprising: 6 lines; the whole plugin's public identity is these two strings.

### packages/experimental/api-speech-to-text/locale/zh.json
- Purpose: the Chinese plugin metadata.
- Key abstractions: same `meta` shape as the English file.
- Data flow: n/a.
- Non-obvious design decisions: the two locale files are structurally identical so a missing key is a visible diff.
- Edge cases / failure handling: n/a.
- Surprising: the Chinese title drops the "API" word that the English title has ("语音转写接口" vs "Speech transcription API").

### packages/experimental/api-speech-to-text/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-api-speech-to-text`.
- Key abstractions: `exports` map with `.`, `./src/*`, `./package.json`, `./locale/*.json`, `./types`, `./typert`, `./remote`.
- Data flow: the `files` array ships `lib/index.js`, `lib/types/**`, `lib/typert.host.js` and `lib/typert.remote-client.js`.
- Non-obvious design decisions: the *host* and *remote-client* Typert artefacts are shipped from the same package, so the browser half does not need a second install. `@deepseek-ai/dsh-experimental-speech-to-text` is a **peer** dependency (plus a devDependency) rather than a dependency — the provider is host-owned and must not be duplicated per install.
- Edge cases / failure handling: `publishConfig.access: public`; version `0.2.1-rc.2`.
- Surprising: `zod` is a hard dependency while the *source* uses `@deepseek-ai/schemastery` — the Typert host side needs schemastery, and zod is pulled by the generated remote types.

### packages/experimental/api-speech-to-text/tsconfig.json
- Purpose: TypeScript project for the speech API package.
- Key abstractions: `rootDir: src`, `outDir: lib/types`, project references.
- Data flow: build graph only.
- Non-obvious design decisions: references point at `../../../vendor/schemastery`, `../../../vendor/cordis`, `../speech-to-text` and `../../typert/protocol` — the vendored framework and the two cross-package dependencies are all *referenced projects*, so `tsc -b` type-checks the whole chain.
- Edge cases / failure handling: `include: ["src"]` only — tests are type-checked by a different project.
- Surprising: `outDir` is `lib/types` (declaration output) while the runtime bundle is produced by `tsdown` from the compiled JS — a two-step build.

### packages/experimental/api-speech-to-text/tsdown.config.ts
- Purpose: 3-line tsdown bundle config.
- Key abstractions: `defineConfig({ entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false })`.
- Data flow: compiled `lib/types/*.js` → bundled `lib/*.js`.
- Non-obvious design decisions: `clean: false` and `dts: false` — the build never deletes the `lib/types` tree it reads from, and declarations are produced by `tsc`, not by the bundler.
- Edge cases / failure handling: n/a.
- Surprising: `fixedExtension: false` keeps the `.js` extension rather than emitting `.mjs`.

### packages/experimental/auto-review/src/index.ts
- Purpose: the whole Auto-review gate: an LLM that authorises each tool call before its body runs, replacing human approval.
- Key abstractions: `REVIEW_POLICY` (the fixed first section of the review request); `AutoReviewDecision` = a closed union of `{risk,decision}` / `{risk,decision,reason}`; `ReviewSourceRole` = `human-instruction | direct-parent-instruction | constraint | checkpoint | fact`; `ReviewSnapshot` = `{provider, model, cwd, projectInstructions, history, action}`; `PendingAction` = `{mode: 'native'|'ptc-inner', name, description, parameters, arguments}`.
- Data flow: on every `tools/pre-execute` (prepended), if the Session's permission preset is `AUTO_PRESET`, `snapshotAutoReview()` freezes a five-section request (ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION) from the Session's event log and request header; `classifyRisk()` streams it through `ctx.llm.stream` at `temperature: 0`; `readDecision()` assembles the reply; `parseDecision()` validates it; the result is turned into a `PreToolDecision` (`deny` / `ask` / `cancel`).
- Non-obvious design decisions: (1) the policy explicitly classifies by **actual effect, never by tool name or message tone** — "low: ordinary project-local reads and writes… low must be allowed without additional explicit authorization", "medium may be allowed only when a current human or direct-parent instruction explicitly authorizes the action, exact target and necessary scope", "high must always be denied, even when a human or parent explicitly requests the exact action"; (2) a **direct-parent instruction never overrides a human restriction**, and a later instruction resolves an earlier conflict only by explicitly revoking it; (3) the *outer* `run_code` transport is deliberately excluded — only native calls and started PTC inner calls are reviewed; (4) `parseDecision` uses `topLevelMemberCount` — a hand-written scanner that counts top-level JSON members — to reject a **repeated** member (`{"risk":"medium","risk":"high","decision":"deny"}`), which `JSON.parse` would silently accept; (5) the reply must be **zero or more reasoning blocks followed by exactly one text block** and a terminal `stop`; a `max-tokens` finish, a tool call, an image block, a second text block, or data after the terminal finish all fail; (6) the reviewer's request carries `provider`/`model` from the Session's latest request header, so the reviewer is the *same* model the agent is using; (7) the review prompt "is sent only through `ctx.llm.stream` and never enters a Session log".
- Edge cases / failure handling: a **reviewer failure is not a denial** — `failed()` produces `Auto review of tool "X" failed; its body was not executed: <error>` with a different message, so the model can tell "refused" from "broken"; the body never executes in either case. Under the `never` approval policy a denial is final; under `ask` the listener calls `next()` first and only converts a downstream `allow` into an `ask`, so a later denial/cancel/ask wins. On unload, live Auto Sessions are migrated to `danger-full-access` through the existing preset writer, then in-flight reviews are aborted and awaited, then the listener and contribution are withdrawn. A denial carries a *structured* `info` object (`AUTO_REVIEW_DENIED_ERROR_NAME` / `AUTO_REVIEW_DENIED_CODE` / optional `reason`) that is a durable UI detail and, per the README, "never enters the main model content".
- Surprising: `snapshotAutoReview` reconstructs the pending action by **cross-checking the live execution against the Session log** — if the logged name/arguments disagree with the in-flight execution, or the tool schema is missing or ambiguous in the request header, the review *throws* rather than guessing. The PTC branch additionally requires the inner call's start event to be inside the currently open `(turn, step)` scope (`scopedCallKey` = `turn\0step\0callId`), and a PTC call with no owning step is a hard error.

### packages/experimental/auto-review/tests/auto-review.spec.ts
- Purpose: 1832-line spec — the exhaustive behavioural contract of the reviewer.
- Key abstractions: a `harness()` that drives a real `LlmAdapter` with a scripted `ReviewScript`; `autoSession(ctx, id)` that builds a real Session; `appendHeader` / `appendAssistant` / `appendNativeCall` helpers that write real Session events.
- Data flow: the spec scripts the *reviewer's* stream and asserts on the resulting `PreToolDecision` and on whether the probe tool body ran.
- Non-obvious design decisions: the invalid-response table at lines 880–948 is the interesting part: it enumerates `null`, `"text"`, `[]`, a missing `decision`, `low+deny`, `high+allow`, `allow+reason`, an unknown risk, a non-string reason, an extra member, an extra array member, a repeated `risk`, non-JSON, reasoning-only, a second text block, an unexpected tool call, an image block, a late reasoning block after the decision, `max-tokens` finish, a truncated stream with no finish, and a usage-only tail — **all** of them must fail the call with a specific error and execute nothing.
- Edge cases / failure handling: the same spec pins the `never` vs `ask` approval split, the downstream-guard interaction (`downstream guard` denial wins and the user is never asked), and the "every non-protocol result fails with its specific error instead of a denial" rule.
- Surprising: `expect(probe.runs()).toBe(0)` and `expect(adapter.requests).toHaveLength(0)` at the end — after a whole battery of invalid reviewer scripts, the test proves that a *malformed* reviewer reply never even caused a model request to the tool's own agent.

### packages/experimental/auto-review/tests/auto-review.e2e.ts
- Purpose: 412-line opt-in end-to-end certification against the real DeepSeek models.
- Key abstractions: `REAL = process.env.DSH_AUTO_REVIEW_CERTIFICATION === '1'`; a `Risk`/`Decision`/`Path`/`Effect` case model; `UnusedSandbox` whose `confine()` throws so any sandbox request fails the case.
- Data flow: each case runs a real tool call through a real `AgentLoop`, a real `SandboxBashExecutor`, a real `NodePtcRuntime`, and a real provider (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`).
- Non-obvious design decisions: the fixture asserts that the reviewer **never sees the secret** in the tool inputs it reviews (`expect(runner.postToolInputs.at(-1)).not.toContain('TEST_ONLY_SECRET_')`) — the reviewer's request is filtered so the body of a pending call is not leaked into the reviewer prompt beyond the action itself.
- Edge cases / failure handling: the harness runs the same case over both `native` and `ptc-inner` paths; a denied call must leave its body unexecuted and the target file untouched (`expect(await readFile(target,'utf8')).toBe('keep\n')`).
- Surprising: the "effect" column distinguishes `deleted` / `blocked` / `unexpected` — the certification checks the *world*, not just the decision, and the tool UI must show a denied call as a normal tool card.

### packages/experimental/auto-review/README.md
- Purpose: the user-facing description of the Auto review permission mode.
- Key abstractions: the risk taxonomy (low / medium / high) as the doc's central concept; the `EXP` badge in the composer menu; the `/permission auto` command.
- Data flow: documents the profile install (`pnpm dsh plugin --profile web add ./packages/experimental/auto-review`) and the `cordis.patch.yml` row insertion.
- Non-obvious design decisions: the doc states the *failure modes of the feature itself* up front — "it can allow unsafe actions, deny useful work, and spend additional tokens" — and lists "no deterministic tool exemptions, persistent grants, configurable policy, or retry layer".
- Edge cases / failure handling: "A delegated in-process child pins the `never` policy, so its denials are final"; "Out-of-process children retain their native permission systems after the parent delegation call is allowed"; the reviewer currently reads the Session action history through the deprecated synchronous `snapshotEvents()` under a line-scoped waiver.
- Surprising: the Model Experience section states the token cost plainly: one extra model request per supported call, "not cached, retried, truncated, or compacted, and no separate small output budget".

### packages/experimental/auto-review/README.zh.md
- Purpose: the Chinese mirror of the Auto review reference.
- Key abstractions: the same risk taxonomy and the same five-section reviewer input.
- Data flow: n/a — translation.
- Non-obvious design decisions: it spells out the *unload* sequence in more detail than the English side: close the picker and review admission, migrate live Auto Sessions to Full access through the existing preset writer (writing the `never` approval policy *without* enqueuing a policy-change notification, so the model sees the new policy in its next runtime-context snapshot), then abort and await in-flight reviews, then withdraw the listener and contribution.
- Edge cases / failure handling: "A persistent Auto Session missing a complete integration cannot be published; reinstalling requires explicit user action. Reinstalling only restores the option; it does not switch a live Session back to Auto."
- Surprising: the doc notes the reviewer's *outer* input is a frozen `RequestUserInput` with no persistent identity or provenance, while the retained history inside the review text still carries its original sources.

### packages/experimental/auto-review/README.i18n.yaml
- Purpose: bilingual hash record for the Auto review README.
- Key abstractions: 15 anchor→hash pairs.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: this file's anchors reveal the README's exact heading tree, including `/model-experience/per-call-reviewer/what-the-model-sees` and `/model-experience/tool-denial/kv-cache-effect` — two separate Model-Experience subsections, one for the allow path and one for the denial path.
- Edge cases / failure handling: n/a.
- Surprising: the anchors make the *doc structure* itself a reviewable artefact; a new section must be re-recorded here or the doc gate fails.

### packages/experimental/auto-review/locale/en.json
- Purpose: English plugin metadata: "Auto Authorization Review".
- Key abstractions: `meta.title` / `meta.description`.
- Data flow: Plugins page.
- Non-obvious design decisions: the description states the mechanism ("uses the model to assess authorization before each tool call") rather than the benefit.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/auto-review/locale/zh.json
- Purpose: Chinese plugin metadata: "自动授权审查".
- Key abstractions: same two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/auto-review/icon.svg
- Purpose: 36×36 plugin icon: a gradient shield with a white check mark.
- Key abstractions: a single `linearGradient` (`#7AC2FF` → `#4A65E8`) and a stroked check path.
- Data flow: rendered in the Plugins list.
- Non-obvious design decisions: the icon encodes the *authorisation* metaphor (shield + check) rather than a magnifying glass or a robot, so it reads at 36 px.
- Edge cases / failure handling: n/a.
- Surprising: the gradient id is `a` — a one-character id, in a file that is otherwise carefully commented.

### packages/experimental/auto-review/cordis.patch.yml
- Purpose: the 3-line profile patch that inserts this package itself as an `auto-review` row.
- Key abstractions: `- insert: - { id: auto-review, name: '@deepseek-ai/dsh-experimental-auto-review' }`.
- Data flow: the profile composer merges this patch after the base and Web layers.
- Non-obvious design decisions: a package with a `dsh.bundle.patch` is *activated* as a profile layer; without one it is merely an installed dependency. The patch therefore is the whole activation mechanism.
- Edge cases / failure handling: "Reconciliation activates the patch as a profile layer" — a later root patch can disable the row.
- Surprising: the file contains no config at all; every knob lives in the plugin's own `Config`/`apply`.

### packages/experimental/auto-review/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-auto-review`.
- Key abstractions: `dsh.bundle.patch: "./cordis.patch.yml"`; a long `peerDependencies` list (agent, agent-instructions, llm, permission-presets, session, tools, working-directory).
- Data flow: `files` ships `icon.svg`, `locale/*.json`, `lib/index.js`, `cordis.patch.yml`.
- Non-obvious design decisions: **every** host service is a peer, and the *dev* dependency list is enormous (agent-loop, agent-loop-testkit, bash-sandbox, compaction, fs-local, fs-sandbox, llm-deepseek, llm-deepseek-api-key, ptc-runtime-node, sandbox, sandbox-policy, session-projection, shell, shell-env, subprocess-local, system-prompt, tool-bash, tool-fs, tool-subagent) — the package is tested against the *real* loop, the *real* sandbox and the *real* PTC runtime, with only `@deepseek-ai/dsh-util-values` as a real dependency.
- Edge cases / failure handling: `publishConfig.access: public`.
- Surprising: the peer list is the honest statement of what Auto must be able to see (the Session's event log, the tool runtime, the permission presets, the working directory).

### packages/experimental/auto-review/tsconfig.json
- Purpose: TS project for the Auto review package.
- Key abstractions: references to 11 cross-package projects, including `../../compaction/compaction` and `../../subagent/subagent`.
- Data flow: build graph.
- Non-obvious design decisions: the reference set mirrors the *review inputs* — compaction (for the `compact-checkpoint` source role) and subagent (for the direct-parent instruction role) are compile-time dependencies because the reviewer reads both.
- Edge cases / failure handling: `include: ["src"]`.
- Surprising: `../../util/values` is referenced for one symbol (`deepFreeze`) — the frozen snapshot is a real invariant, not a convention.

### packages/experimental/badge-skill-bundle/src/index.ts
- Purpose: 2-line marker module: "DSH badge skill profile layer; runtime entries are declared in cordis.patch.yml."
- Key abstractions: `export {}`.
- Data flow: none — the runtime rows come from the patch file.
- Non-obvious design decisions: a "bundle" package needs no code; the whole behaviour is the `cordis.patch.yml` row plus the capability package it names.
- Edge cases / failure handling: n/a.
- Surprising: the file is a one-line comment and an empty export — and it is *not* boilerplate to be skipped, because it documents where the behaviour actually lives.

### packages/experimental/badge-skill-bundle/cordis.patch.yml
- Purpose: inserts the `skill-badge` provider row on the Host.
- Key abstractions: `- insert: - { id: skill-badge, name: '@deepseek-ai/dsh-skill-badge' }`.
- Data flow: the profile composer activates the row.
- Non-obvious design decisions: "Later root patches can disable that row; an override alone does not select the bundle" — enabling is a separate act from overriding.
- Edge cases / failure handling: n/a.
- Surprising: the bundle depends on a **release** package (`dsh-skill-badge`), not an experimental one — the experimental layer here is only the *switch*.

### packages/experimental/badge-skill-bundle/README.md
- Purpose: describes the opt-in "powered by dsh" badge capability.
- Key abstractions: the switch adds or removes a *Host-wide skill provider* for existing and new Agents.
- Data flow: n/a.
- Non-obvious design decisions: "Presets that expose skill loading can use the badge; minimal keeps its tool catalog unchanged" — the bundle is deliberately inert for the minimal preset, and the README says so rather than leaving it to be discovered.
- Edge cases / failure handling: known limit: a preset must include skill discovery and loading.
- Surprising: the Model Experience section says the layer "adds no request content directly" — the effect is entirely in the capability implementation.

### packages/experimental/badge-skill-bundle/README.zh.md
- Purpose: Chinese mirror of the badge bundle reference.
- Key abstractions: same single-section structure.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: same known limit restated in Chinese.
- Surprising: n/a.

### packages/experimental/badge-skill-bundle/README.i18n.yaml
- Purpose: bilingual hash record (11 anchor pairs) for the badge bundle README.
- Key abstractions: anchor → `{en, zh}` hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: this file's `/model-experience/kv-cache-effect` hash (`1b2209bbbf869b1e`) differs from every other package's, because this package's text differs.

### packages/experimental/badge-skill-bundle/locale/en.json
- Purpose: English plugin metadata "DSH badge skill".
- Key abstractions: `meta.title` / `meta.description`.
- Data flow: Plugins page.
- Non-obvious design decisions: the description is the *capability* sentence, reused verbatim from the README front-matter.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/badge-skill-bundle/locale/zh.json
- Purpose: Chinese plugin metadata "DSH 徽章技能".
- Key abstractions: same two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/badge-skill-bundle/icon.svg
- Purpose: 36×36 icon: a rounded blue rectangle with the letters "DSH" drawn as strokes.
- Key abstractions: flat `#4D6BFE` fill, white strokes.
- Data flow: Plugins list.
- Non-obvious design decisions: the "H" is drawn as four separate line segments rather than a path with joins — a deliberate stroke-weight choice.
- Edge cases / failure handling: n/a.
- Surprising: unlike the auto-review icon, this one has no gradient — the two icons are visually distinct at a glance.

### packages/experimental/badge-skill-bundle/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-badge-skill-bundle`.
- Key abstractions: `dsh.bundle.patch`; a single real dependency `@deepseek-ai/dsh-skill-badge`.
- Data flow: `files` ships `icon.svg`, `locale/*.json`, `lib/index.js`, `cordis.patch.yml`, `lib/types/**/*.d.ts`.
- Non-obvious design decisions: the *only* dependency is the capability package; `cordis` is a peer + dev dependency, so the bundle adds no framework copy.
- Edge cases / failure handling: `publishConfig.access: public`.
- Surprising: `main: lib/index.js` points at a module that exports nothing — the manifest promises an entry point so the loader can mount the package, and the patch does the real work.

### packages/experimental/badge-skill-bundle/tsconfig.json
- Purpose: 15-line TS project referencing only the vendored cordis.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: build graph.
- Non-obvious design decisions: the absence of any cross-package reference mirrors the absence of code — the bundle's compile-time footprint is cordis alone.
- Edge cases / failure handling: n/a.
- Surprising: the file uses the multi-line JSON style used by the older packages, while newer ones use a compact single-line style — a visible generation split in the repo.

### packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts
- Purpose: mounts the pinned `chrome-devtools-mcp` server as a per-Session MCP provider.
- Key abstractions: `name`, `inject = ['browserUse','agents','tools','systemPrompt','workingDirectory']`, `Config = BrowserMcpConfig`, `apply(ctx, config)`.
- Data flow: resolves `chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js` via `import.meta.resolve`, builds the argv, and hands it to `mountSessionMcp` with `command: process.execPath`.
- Non-obvious design decisions: the server is started **under the current Node executable** rather than via a shell; `--no-usage-statistics` is always passed; attach mode chooses `--ws-endpoint` vs `--browser-url` by testing `/^wss?:/u` on the endpoint; launch mode always passes `--isolated` so the browser's own profile is never reused. `exclusive: config.mode === 'attach'` — only an *attached* browser is exclusive, a launched one is not.
- Edge cases / failure handling: `validateBrowserMcpConfig(config)` runs *before* any resource is acquired, so a malformed endpoint never leaves a browser behind.
- Surprising: the provider is a plain `apply(ctx, config): void` — no class, no service, because all the state lives in the shared runtime.

### packages/experimental/browser-use-chrome-devtools-mcp/README.md
- Purpose: package reference for the Chrome DevTools MCP provider.
- Key abstractions: a config table (`mode`, `headless`, `executablePath`, `endpoint`, `toolCallTimeoutMs`).
- Data flow: documents the attachment lifecycle: "The new live Session claims the attachment during initialization and retains it until unloading. If the attachment is busy, that activation continues without this browser and does not retry on later turns."
- Non-obvious design decisions: two operational warnings are stated as *user* guidance: "Loading or reloading this provider does not adopt Sessions that are already active" and "When configuring the system prompt's `toolOrder` for the whole process, leave browser tools under `<unlisted-tools>`" — because explicitly listing browser tool names can make prompt assembly fail for Sessions *without* a browser connection.
- Edge cases / failure handling: "Cleanup disconnects and leaves the external browser and its pages running"; "A disconnected client is not retried".
- Surprising: the KV Cache section says "An unchanged catalog preserves its tool-definition prefix" — the tool prefix is stable as long as the catalog is, which is the reason for discovering tools before the first model request.

### packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md
- Purpose: Chinese mirror of the DevTools MCP reference.
- Key abstractions: same config table and same attachment lifecycle.
- Data flow: n/a.
- Non-obvious design decisions: it adds the sentence the English side also carries: "加载或重新加载此提供方不会接管已经活动的 Session."
- Edge cases / failure handling: same seven known limitations.
- Surprising: n/a.

### packages/experimental/browser-use-chrome-devtools-mcp/README.i18n.yaml
- Purpose: bilingual hash record (15 pairs) for the DevTools MCP README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the `/model-experience/browser-tools-and-screenshots` subtree is duplicated in the Playwright package with *different* hashes — the docs are genuinely per-package, not shared.

### packages/experimental/browser-use-chrome-devtools-mcp/locale/en.json
- Purpose: English plugin metadata "Browser Use (Chrome DevTools)".
- Key abstractions: `meta.title` / `meta.description`.
- Data flow: Plugins page.
- Non-obvious design decisions: the description names the *mechanism* ("through Chrome DevTools MCP in a launched Chrome") so the user knows the browser is spawned, not attached, by default.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-chrome-devtools-mcp/locale/zh.json
- Purpose: Chinese plugin metadata "浏览器操作（Chrome DevTools）".
- Key abstractions: same two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-chrome-devtools-mcp/package.json
- Purpose: npm manifest for the DevTools MCP provider.
- Key abstractions: `chrome-devtools-mcp: "1.9.0"` as a **pinned** dependency; `@deepseek-ai/dsh-experimental-browser-use-runtime` as a real dependency.
- Data flow: the pinned version is what "the pinned npm entry" in the README refers to.
- Non-obvious design decisions: five host packages are peers (browser-use, agent, tools, system-prompt, working-directory) — the provider must use the *host's* registries, not its own copies.
- Edge cases / failure handling: `publishConfig.access: public`.
- Surprising: the dev dependency list is the full integration set (agent-loop, llm, session, session-projection, working-directory, cordis-plugin-loader/include) — the provider is only meaningfully tested inside a real loop.

### packages/experimental/browser-use-chrome-devtools-mcp/tests/provider.spec.ts
- Purpose: 37-line spec pinning the exact CLI argv for launch and attach.
- Key abstractions: the `mountSessionMcp` module is mocked, so the assertions are purely about argv and options.
- Data flow: `Provider.apply(new Context(), Provider.Config({...}))` then read `vi.mocked(mountSessionMcp).mock.calls[0][1]`.
- Non-obvious design decisions: the test asserts the **exact** argv array (`['--no-usage-statistics','--isolated','--headless=true','--executable-path','/custom/chrome']`) — a stable, greppable contract for a subprocess launch, which is the only thing a regression in this file could actually break. It also asserts `expect('default' in Provider).toBe(false)` — the provider must not export a `default`, so the loader cannot mount it twice.
- Edge cases / failure handling: the third case asserts that a trailing-garbage endpoint throws *before* `mountSessionMcp` is called at all (`expect(mountSessionMcp).not.toHaveBeenCalled()`).
- Surprising: `headless` is passed as `--headless=true` / `--headless=false` rather than being omitted, so the flag is always explicit.

### packages/experimental/browser-use-chrome-devtools-mcp/tests/upstream.e2e.ts
- Purpose: 8-line opt-in check against the *real* pinned server.
- Key abstractions: `it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each(['launch','attach'])`.
- Data flow: delegates to the shared `verifyMcpBrowser(Provider, 'chrome-devtools-mcp', {name:'new_page', ...}, mode)`.
- Non-obvious design decisions: the test is skipped unless an explicit executable path is exported — no accidental browser launch in CI.
- Edge cases / failure handling: n/a.
- Surprising: the provider package has no test of its own for the MCP protocol; the shared helper in `browser-use-runtime` owns that, which is how both browser providers stay honest with one suite.

### packages/experimental/browser-use-chrome-devtools-mcp/tsconfig.json
- Purpose: 21-line TS project referencing cordis, the shared browser runtime and working-directory.
- Key abstractions: `../browser-use-runtime` project reference.
- Data flow: build graph.
- Non-obvious design decisions: the reference set is exactly the *injection* set plus the runtime — the compile-time surface matches the runtime surface.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/src/index.ts
- Purpose: mounts the pinned `@playwright/mcp` server as a per-Session MCP provider.
- Key abstractions: same shape as the DevTools provider — `name`, `inject`, `Config`, `apply`.
- Data flow: resolves `@playwright/mcp/package.json` → `cli.js` beside it; argv `['--browser','chromium', ...]`.
- Non-obvious design decisions: **the inherited environment is scrubbed of every `PLAYWRIGHT_MCP_*` variable** — `Object.fromEntries(Object.keys(process.env).filter(k => k.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(k => [k,'']))` — because "Upstream environment options can otherwise replace the configured browser mode or import an unrelated profile. Empty values mean absent to its parser." That is a config-injection door closed by neutralising the variable rather than by refusing to pass it.
- Edge cases / failure handling: attach mode uses `--cdp-endpoint` and never passes `--isolated`/`--headless`; launch mode always passes `--isolated` and only adds `--headless` when headless is true (so a headed launch has no `--headless=false`).
- Surprising: the browser is pinned to `chromium` in argv, and `executablePath` is only meaningful in launch mode — there is no config validation for that pairing here (unlike Stagehand, which validates the mode/field matrix).

### packages/experimental/browser-use-playwright-mcp/README.md
- Purpose: package reference for the Playwright MCP provider.
- Key abstractions: the same config table as the DevTools provider.
- Data flow: n/a.
- Non-obvious design decisions: the README adds one sentence the DevTools one does not: "The child process clears inherited `PLAYWRIGHT_MCP_*` options so they cannot replace that configuration." The scrub is a *documented* behaviour, not an implementation detail.
- Edge cases / failure handling: same seven known limitations; the Playwright list has six (no usage-statistics line, because Playwright has no such flag).
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/README.zh.md
- Purpose: Chinese mirror of the Playwright MCP reference.
- Key abstractions: same config table.
- Data flow: n/a.
- Non-obvious design decisions: the scrub sentence is present in Chinese too.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/README.i18n.yaml
- Purpose: bilingual hash record (15 pairs) for the Playwright MCP README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the `/model-experience/browser-tools-and-screenshots/what-the-model-sees` hash differs from the DevTools package's while the token-effect and kv-cache hashes are identical — the docs are per-package prose over a shared template.

### packages/experimental/browser-use-playwright-mcp/locale/en.json
- Purpose: English plugin metadata "Browser Use (Playwright)".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description says "browse and operate web pages" (browse, not just inspect) — the two providers' descriptions differ in verb to match their upstream catalogues.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/locale/zh.json
- Purpose: Chinese plugin metadata "浏览器操作（Playwright）".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/tests/provider.spec.ts
- Purpose: 39-line spec pinning the Playwright argv and the environment scrub.
- Key abstractions: `vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')` sets the hostile value the provider must neutralise.
- Data flow: reads `vi.mocked(mountSessionMcp).mock.calls[0][1]`.
- Non-obvious design decisions: the scrub is asserted as `expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')` — empty string, not `undefined`, because the upstream parser treats empty as absent. Asserting the *exact* value matters: `undefined` would delete the key and the upstream default might then apply a real endpoint.
- Edge cases / failure handling: `afterEach` calls both `vi.clearAllMocks()` and `vi.unstubAllEnvs()`.
- Surprising: the test again asserts `expect('default' in Provider).toBe(false)`.

### packages/experimental/browser-use-playwright-mcp/tests/upstream.e2e.ts
- Purpose: 8-line opt-in check against the real Playwright MCP server.
- Key abstractions: `it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each(['launch','attach'])`.
- Data flow: delegates to `verifyMcpBrowser(Provider, 'playwright-mcp', {name:'browser_navigate', ...}, mode)`.
- Non-obvious design decisions: the tool name differs from the DevTools one (`browser_navigate` vs `new_page`) because the two servers name their tools differently — the shared helper is parameterised on the tool name, not hard-coded.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-playwright-mcp/tsconfig.json
- Purpose: 21-line TS project (same reference set as the DevTools provider).
- Key abstractions: `../browser-use-runtime`, `../../session/working-directory`.
- Data flow: build graph.
- Non-obvious design decisions: identical to the sibling package's, so the two providers can be diffed at a glance.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-runtime/src/index.ts
- Purpose: `SessionResources<T>` — the shared per-Session browser ownership and serialisation runtime.
- Key abstractions: `OwnedSessionResource<T> {value, close}`; `SessionResourceOptions<T> {label, exclusive, open(agent, signal)}`; an internal `Entry<T> {controller, ready, tail, closing?}`.
- Data flow: `get(agent, signal)` awaits the single `ready` promise; `run(agent, signal, operation)` chains onto `entry.tail` so one Session's operations run **in order** while other Sessions proceed independently; `dispose()` closes every entry and throws an `AggregateError` if any close failed.
- Non-obvious design decisions: (1) **ownership is keyed by live Agent identity, not by a durable Session id** — `entry()` throws `'Session is not a live browser owner'` when `this.ctx.get('agents')?.get(agent.id) !== agent`, so a *resumed* Session with the same id can never inherit the previous browser; (2) the cleanup order is deliberately **close-then-wait**: `closeEntry` aborts the entry controller, awaits `resource.close()`, and only then awaits `entry.tail` — "allowing connection teardown to interrupt work whose upstream API has no abort support"; (3) a *failed close retains the entry and rejects disposal*, preserving exclusive ownership rather than releasing it into an unknown state; (4) `awaitOperation` lets one caller's wait be cancelled without cancelling the Session-owned acquisition — "Cancellation stops a caller's wait while retaining handlers on the resource owner's work"; (5) `disposedOwners` is a `WeakSet`, so a disposed Agent is remembered without leaking; (6) an `AbortSignal` whose reason carries `kind: 'disposed'` triggers the close *before* AgentHandle waits for idle.
- Edge cases / failure handling: a failed acquisition releases its reservation only after the provider callback has rolled back (`open() owns rollback`); the `ready` promise is given a `void entry.ready.catch(() => {})` so an acquisition that outlives every cancelled caller does not produce an unhandled rejection, and later consumers still receive its failure.
- Surprising: `available(agent)` is a *pure predicate* that checks admission "without reserving or acquiring a browser", and it consults the live agent registry — the browser provider can ask "may I?" before it takes anything.

### packages/experimental/browser-use-runtime/src/mcp.ts
- Purpose: `mountSessionMcp` — connects a provider-owned MCP server per live Session and gates its tools.
- Key abstractions: `BrowserMcpConfig` = a schemastery union of `BrowserMcpLaunchConfig` and `BrowserMcpAttachConfig`; `SessionMcpOptions {name, exclusive, command, args, env?, toolCallTimeoutMs?}`; an internal `ClientState {status: 'ready'|'blocked', mask?}`.
- Data flow: `ctx.on('agent/created')` → `resources.get(agent, signal)` → `scope.ctx.plugin(McpClient, McpClient.Config({transport:'stdio', serverName, command, args, env, cwd: await workingDirectory.ensure(agent, signal), toolCallTimeoutMs, failOnStartupError: true, reconnect: {enabled: false}}))`; the client is scoped per Agent so its tools register in that Agent's scope.
- Non-obvious design decisions: (1) the MCP client is mounted **inside `agent/created`**, so tool discovery completes *before* the Agent's first model request — that is the mechanism behind "an unchanged catalog preserves its tool-definition prefix"; (2) `reconnect: {enabled: false}` — reconnection is disabled, so a dead browser is a dead browser; (3) a **busy attachment** leaves that activation `blocked` rather than failing it: the tools are masked out of the global layer with `state.mask.ctx.tools.restrict({deny: inherited})`, and the activation's other turns continue; (4) a cross-Session call is refused with `'browser tool belongs to another Session'`, and the check is identity-based (`ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)`) so a tool that is genuinely shared is not refused; (5) `system-prompt/assemble` **removes the `mcp:<name>` section** for any Session whose client is not ready, so the prompt never advertises a browser the Session does not have; (6) `validateBrowserMcpConfig` re-checks the endpoint with `new URL()` and a whitespace test, because the schema pattern alone accepts a URL with a space in it.
- Edge cases / failure handling: the mount throws `'browser MCP requires a working-directory provider'` *before* any browser resource is registered; a failed open disposes the scope in the `catch`; on unload `stopping = true` then `resources.dispose()` then `clients.clear()` — every server closes before the provider registration is released.
- Surprising: the provider's `cwd` is the Session's validated working directory at connect time and is *retained* if the Session later changes directory — "Retained servers keep that directory when the Session later selects another."

### packages/experimental/browser-use-runtime/README.md
- Purpose: the shared-runtime library reference.
- Key abstractions: the contract for providers: "Calls pass the exact live Agent to `run()`; stale owners and a second owner of an exclusive attachment fail before acquisition."
- Data flow: n/a.
- Non-obvious design decisions: the "Understand the implementation" section states the ownership rule in one sentence: "Agent-scoped cleanup prevents a resumed Session with the same durable id from inheriting a previous browser."
- Edge cases / failure handling: "A busy attachment skips startup permanently for that live activation while its other work continues. Releasing the attachment does not retry skipped activations; a newly created or resumed Agent can acquire it."
- Surprising: the Known Limitations section documents a **dependency-graph** hazard: because a profile installs this package beside the dsh installation, `@deepseek-ai/dsh-scope` and `@deepseek-ai/dsh-mcp-client` must stay peer dependencies — "A dependency edge ships a second `dsh-scope` copy whose scope tags host registries cannot read."

### packages/experimental/browser-use-runtime/README.zh.md
- Purpose: Chinese mirror of the shared-runtime reference.
- Key abstractions: same contract statements.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version keeps the same "Agent 作用域清理防止使用同一持久 id 恢复的 Session 继承之前的浏览器" sentence — the rule is stated identically in both languages because it is the safety property, not a description.
- Edge cases / failure handling: same limitations.
- Surprising: n/a.

### packages/experimental/browser-use-runtime/README.i18n.yaml
- Purpose: bilingual hash record (11 pairs) for the shared-runtime README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-runtime/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-browser-use-runtime`.
- Key abstractions: `exports` with a `./mcp` subpath; eight **peer** dependencies including `dsh-mcp-client` and `dsh-scope`.
- Data flow: `files` ships `lib/index.js` and `lib/types/**` only — no locale, no icon, because it is a library, not a plugin.
- Non-obvious design decisions: `dsh-scope` and `dsh-mcp-client` are peers **and** devDependencies and *not* dependencies — the single most important line in the package, as the shared-host-runtimes spec proves.
- Edge cases / failure handling: n/a.
- Surprising: the dev dependency list includes `dsh-ptc-runtime`, `dsh-attachment-local`, `dsh-session-persistence-jsonl` and `dsh-fs-local` — the runtime is tested against a real session, attachment and file system.

### packages/experimental/browser-use-runtime/tsconfig.json
- Purpose: 39-line TS project with 9 project references.
- Key abstractions: references to `../../core/agent`, `../../core/tools`, `../../core/scope`, `../../mcp/mcp-client`, `../../browser-use/browser-use`, `../../core/system-prompt`, `../../session/working-directory`.
- Data flow: build graph.
- Non-obvious design decisions: the reference set is the runtime's actual dependency surface, and `../../core/scope` is present precisely because of the singleton-scope hazard.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-runtime/tests/shared-host-runtimes.spec.ts
- Purpose: 36-line spec that reads the package's own `package.json` and asserts the peer-dependency rule.
- Key abstractions: `SHARED_HOST_RUNTIMES = ['@deepseek-ai/dsh-mcp-client','@deepseek-ai/dsh-scope']`.
- Data flow: `JSON.parse(await readFile(manifestPath,'utf8'))`.
- Non-obvious design decisions: it asserts **three** things per runtime — it must be a peerDependency, it must *also* be a devDependency (so the package can compile and test against it), and it must **not** be a dependency. The third assertion is the one that matters; the first two are hygiene. The docstring explains the mechanism in full: "`dsh-scope` mints its scope-tag symbol and `dsh-mcp-client` keeps its live `serverName` reservations per module instance."
- Edge cases / failure handling: n/a.
- Surprising: this is a **manifest test** — it reads the package's own metadata rather than exercising code, and it is the only test in the shard that does.

### packages/experimental/browser-use-runtime/tests/host-runtime-duplication.spec.ts
- Purpose: 103-line spec that *reproduces* the duplicated-module failure and then pins the shipped layout.
- Key abstractions: a `load()` that mounts the real AgentLoop harness and the real BrowserUse registry; `vi.resetModules()` + a fresh `import('@deepseek-ai/dsh-scope')` to simulate the second copy.
- Data flow: the first case creates a first Agent, then registers a plugin that uses the *profile's* copy of scope + mcp-client, then creates a second Agent.
- Non-obvious design decisions: the file documents itself as "a characterization of the duplicated package, not a behavior to preserve. Delete it once `dsh-scope` stops depending on module identity (for example a `Symbol.for` tag shared across copies)." It also names the upstream issue number (#4573) and the exact command to run it.
- Edge cases / failure handling: the failure it reproduces is "the first Agent succeeds, and every later Agent's tool synchronization collides" → `rejects.toThrow('mcp-client(browser-fixture): initial connection or tool synchronization failed')`. The control case asserts that under the shipped layout the global tool layer is **empty** (`expect(toolNames(ctx)).toEqual([])`) and each Agent sees its own tool.
- Surprising: the fixture MCP server is a separate `.mjs` file (`mcp-fixture.mjs`) spawned as a real child process — the duplication bug is only reproducible with a real subprocess, not a mock.

### packages/experimental/browser-use-runtime/tests/mcp.spec.ts
- Purpose: 613-line integration spec for `mountSessionMcp` with a real stdio fixture server, a real Loader, and a real AgentLoop.
- Key abstractions: a `FixtureModel` `LlmAdapter` that calls the browser tool when it is offered; a `PresentationRuntime` that *throws* if any PTC execution happens, proving the test never runs a PTC program.
- Data flow: `load()` writes a `cordis.yml` and loads the real modules through the real `Loader`/`Include` plugins.
- Non-obvious design decisions: the tests assert *ordering* and *ownership* rather than just outcomes — e.g. that a resume blocks until the discovery probe resolves, that provider reload affects only **future** activations, and that the existing Agent's tool call fails with an error while the future Agent's succeeds.
- Edge cases / failure handling: the fixture server has `gate` mode (answers `server/discover` only after a `release` file appears) so the test can hold the activation open and prove that a resume is *waiting*.
- Surprising: `expect(ctx.tools.schemas(agent)).toEqual([])` after disposal — unloading the provider removes the tools from the Agent's scope, and the test proves it.

### packages/experimental/browser-use-runtime/tests/resources.spec.ts
- Purpose: 357-line unit spec for `SessionResources` ownership, exclusivity and cleanup.
- Key abstractions: a fake `Agent` built from `Session.create(SessionId(id))` and registered in the real `AgentRegistry`; an `unsupportedInbox()` from the testkit.
- Data flow: `resources.get(agent)` / `resources.run(agent, signal, op)`.
- Non-obvious design decisions: the concurrency case proves "acquires once across concurrent requests" — `Promise.all([get(a), get(a), get(b)])` yields the *same* resource for `a` and a different one for `b`, with `open` called exactly twice. The reservation case proves an exclusive attachment is reserved *while acquisition or cleanup is pending* — `available(b)` is false before `open` resolves, and `get(b)` rejects with 'already reserved'.
- Edge cases / failure handling: a failed close logs a warning ("cleanup during Session cancellation failed") and `resources.dispose()` then rejects with 'browser cleanup failed' — the entry is **retained**, and the test asserts the warning rather than swallowing it.
- Surprising: the fake Agent's `steer` returns `{status:'rejected'}` and `runMaintenance` runs the task synchronously — the unit test uses the *real* registry but a deliberately inert Agent, which is what makes the ownership assertions about `ctx.agents.get(agent.id) === agent` meaningful.

### packages/experimental/browser-use-runtime/tests/agent-disposal.spec.ts
- Purpose: 91-line spec pinning the close-before-idle ordering.
- Key abstractions: `Promise.withResolvers` barriers to freeze the close at a known point.
- Data flow: `owner.agent.runMaintenance(signal => resources.run(owner.agent, signal, op))` then `owner.dispose()`.
- Non-obvious design decisions: the test asserts that `closing.promise` resolves *before* the Agent reaches idle, and that `ctx.agents.get(owner.agent.id)` is still the live agent at that moment — i.e. the browser is closed *during* disposal, not after it.
- Edge cases / failure handling: the second case covers a resource whose *acquisition* is still in flight when the user cancels: the acquisition signal is aborted, the operation never runs (`expect(execute).not.toHaveBeenCalled()`), and the rejection keeps the user's cancellation reason as its `cause`.
- Surprising: `expect(resources.available(owner.agent)).toBe(false)` after the close — `available` reflects the closed state, not just the presence of an entry.

### packages/experimental/browser-use-runtime/tests/mcp-fixture.mjs
- Purpose: a private stdio MCP server used by the runtime's tests.
- Key abstractions: modes chosen by the `mode` argv — `fail` (exit on discover/initialize), `hold` (never answer), `gate` (answer only after a `release` file appears), `error`, `crash`, `close-failure`.
- Data flow: JSON-RPC over stdin/stdout; every event is appended to `events.ndjson` in the run root.
- Non-obvious design decisions: the fixture writes `record('start', {cwd: process.cwd()})` so a test can assert the **launch directory**, and it answers `server/discover` with a `-32601 Method not found` error in `gate` mode — exercising the client's legacy-probe path.
- Edge cases / failure handling: `lines.once('close', () => process.exit(0))` makes stdin EOF a clean shutdown.
- Surprising: the fixture advertises `instructions: 'BROWSER_FIXTURE_INSTRUCTION: use this Session browser.'` — the "attributed server instructions" surface the browser READMEs describe.

### packages/experimental/browser-use-runtime/tests/mcp-upstream.ts
- Purpose: 110-line shared helper that verifies a *real* upstream MCP browser against a loopback page and a disposable Chromium.
- Key abstractions: `verifyMcpBrowser(provider, namespace, navigate, mode)`.
- Data flow: it starts an `http.createServer` fixture, writes a `cordis.yml`, loads the real modules through the real `Loader`, creates an Agent, assembles the system prompt, reads `ctx.tools.schemas(owner.agent)` and executes the navigate tool.
- Non-obvious design decisions: in `attach` mode it spawns a *real* Chromium with `--remote-debugging-port=0` and reads the port out of the `DevToolsActivePort` file — the whole point is to avoid assuming a fixed port. It then asserts that after the provider is disposed the *external browser is still running* and its page list still contains the fixture URL.
- Edge cases / failure handling: `expect(schemas.every(tool => tool.name.startsWith('mcp__'+namespace+'__'))).toBe(true)` — every tool in the scope must belong to this server, and `expect(ctx.tools.schemas(owner.agent)).toEqual([])` after disposal.
- Surprising: the helper is used by *both* browser provider packages, which is how two very different upstreams (Chrome DevTools and Playwright) are held to one contract.

### packages/experimental/browser-use-playwright-mcp/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`.
- Key abstractions: `@playwright/mcp: "0.0.80"` pinned; `@deepseek-ai/dsh-experimental-browser-use-runtime` as a real dependency.
- Data flow: `exports` ships `.`, `./src/*`, `./package.json`, `./locale/*.json`; `files` ships `locale/*.json`, `lib/index.js`, `lib/types/**`.
- Non-obvious design decisions: five host packages are peers (browser-use, agent, tools, system-prompt, working-directory) so the provider uses the *host's* registries rather than its own copies — the same rule the shared runtime enforces with peer dependencies.
- Edge cases / failure handling: `publishConfig.access: public`.
- Surprising: the dev dependency list is the full integration set (agent-loop, llm, session, session-projection, working-directory, cordis-plugin-loader/include) — the provider is only meaningfully tested inside a real loop.

### packages/experimental/browser-use-stagehand-native/src/index.ts
- Purpose: the native Stagehand provider — browser control through Stagehand's own SDK, with a *separately configured* native model.
- Key abstractions: `Config {model, mode, cdpEndpoint?, extensionId?, executablePath?, headless?, operationTimeoutMs?, shutdownGraceMs?}`; the `GUIDANCE` system-prompt text; `mountTools(ctx, resources)`.
- Data flow: `apply(ctx, input)` validates the mode/field matrix, registers the `stagehand-native` provider, creates a `SessionResources<BrowserResource>` whose `open()` launches Chromium (in launch mode) and opens the Stagehand Worker (in both modes), then mounts a child plugin that registers the six `stagehand_*` tools.
- Non-obvious design decisions: (1) the mode/field matrix is validated explicitly — `cdpEndpoint`/`extensionId` require attach mode, `executablePath` requires launch mode, and an attach endpoint must be an HTTP(S)/WS(S) URL; (2) the timeout ceiling is `2**31-1-10_000` because "Stagehand adds ten seconds to the action RPC timeout before arming its timer" — the schema reserves the SDK's own headroom; (3) the model credential is `Schema.role('secret')` and is validated by `stagehandModelSchema` at the *configuration boundary*, so a blank key is refused before the browser starts; (4) the cleanup rule is asymmetric and deliberate: a `StagehandDrainError` from the SDK does **not** block the reservation release if a *launched* Chromium was cleaned up successfully, because "Final cleanup of a launched browser can release its reservation after both Chromium and its Worker terminate, even if SDK drain failed" — but an attached browser keeps its reservation, because native extension work may still be running.
- Edge cases / failure handling: the browser is started **lazily** (on the first tool call) but the reservation is taken eagerly; a cancelled operation closes the connection and clears it so the next call reconnects; `resources.get(agent)` is the only way a tool reaches the runtime, and the tool requires an exact live Agent (`ctx.agents.requireInitiator()`).
- Surprising: the GUIDANCE text tells the model things the code cannot enforce — "A completed action does not prove the requested outcome, so verify it from fresh page state", "Cancellation waits for active Stagehand work to drain; inference and browser actions may continue during that wait", "Failed cleanup blocks reuse of the connection."

### packages/experimental/browser-use-stagehand-native/src/native.ts
- Purpose: the Stagehand SDK operations and the validated argument schemas.
- Key abstractions: `stagehandModelSchema` (a strict zod object with a non-blank API key); `browserInputs` (the per-operation zod schemas); `BrowserMethod`; `StagehandDrainError`; `NativeBrowserRuntime`.
- Data flow: `openNativeBrowser(config)` connects to the CDP endpoint with `localBrowser.connect`, creates the Stagehand instance with the explicit model, and returns an `execute(method, args)` that parses the arguments with the *same* schema the tool advertises.
- Non-obvious design decisions: (1) the tool arguments and the model/worker requests "share the same validated browser arguments" — one schema, two doors, so a worker cannot be called with something the tool would have rejected; (2) the model schema is `.strict()` and the transform re-validates against the SDK's own `StagehandClientCreateConfigSchema` — "The native-only fields above exclude the SDK's callback-model alternative"; (3) `extract` adapts a JSON-Schema argument to the Zod schema the SDK demands (`z.fromJSONSchema(args.schema)`), which is why the package pins `zod`; (4) the screenshot result is returned in MCP shape — a text block naming the tab plus the image block — so the existing MCP result adapter handles admission.
- Edge cases / failure handling: `selectPage` throws "Stagehand browser tab is unavailable; list tabs to select a current pageId" when the requested tab is gone; the `default` branch is an exhaustiveness guard (`assertNever`) marked `v8 ignore` because the Worker parses the method before dispatch.
- Surprising: `StagehandDrainError` is a *named* error class with an empty body — the type is the signal, so the caller can distinguish "the SDK did not drain" from any other cleanup failure.

### packages/experimental/browser-use-stagehand-native/src/launch.ts
- Purpose: owns the launched Chromium process and its temporary profile, independent of the Stagehand Worker.
- Key abstractions: `OwnedChromium {endpoint, close()}`; `launchChromium(config, signal)`.
- Data flow: `mkdtemp` a profile → `launch()` from `@puppeteer/browsers` with `--remote-debugging-port=0` → read the CDP websocket URL out of the child's stdout → return the endpoint.
- Non-obvious design decisions: (1) the debugging port is **0** (OS-allocated) and the endpoint is discovered from the `DevTools listening on …` line — no port guessing and no collision; (2) the child's environment is `scrubbedParentEnv()` — credential-shaped variables and DSH identity are removed while paths, locale and proxy settings are kept; (3) the profile directory is removed only *after* the child has closed, and `close()` is idempotent; (4) the comment at line 50 records a real subtlety: "Failed spawn emits error + close without exit; Process.hasClosed waits only for exit", so the code waits on the child's `close` event rather than `Process.hasClosed`.
- Edge cases / failure handling: an abort before the spawn prevents the spawn entirely; an abort after the spawn kills the process and waits for the close; a readiness failure cleans up *before* reporting the error; a kill that throws is preserved (the profile is then left behind, and the spec asserts that).
- Surprising: the browser is started with `--enable-unsafe-extension-debugging` and `--remote-allow-origins=*` — the flags Stagehand's extension needs to attach to a CDP browser.

### packages/experimental/browser-use-stagehand-native/src/worker-client.ts
- Purpose: the host side of the isolated Stagehand Worker.
- Key abstractions: `openBrowserWorker(config, signal, warn)`.
- Data flow: spawn a `Worker` with the resolved config as `workerData` → `request(worker,'ready')` → hand back an `execute`/`close` pair.
- Non-obvious design decisions: (1) the Worker gets an **empty environment** — "Only explicit model credentials cross in workerData; ambient credentials and proxy settings stay outside" — and the CDP connection therefore does not inherit the host's proxy; (2) the close path is a two-phase race: `request(worker,'close')` against a `shutdownGraceMs` timer, and a timeout becomes a `StagehandDrainError` ("SDK requests did not drain") *after* warning; the Worker is terminated either way; (3) a Worker that errors or exits aborts the lifetime signal, so an in-flight operation fails fast; (4) an abort during acquisition terminates the Worker; (5) the worker entry is resolved differently for source and built runs — a `tsx/esm/api` bootstrap for `.ts` and a plain `worker.js` for the published bundle.
- Edge cases / failure handling: `execute` refuses to run once `closing` is set; an operation-level abort triggers the close, so a cancelled call tears the connection down rather than leaving a half-used one.
- Surprising: the credential in `workerData` is the *only* secret that crosses; the `apiKey` is a plain string in the structured clone, and the Worker sends it to the browser extension.

### packages/experimental/browser-use-stagehand-native/src/worker-rpc.ts
- Purpose: the one-shot MessagePort RPC used between the host and the Worker.
- Key abstractions: `responseSchema` (a discriminated union on `ok`); `requestSchema`; `request(target, method, args?, signal?)`; `answer(raw, execute)`.
- Data flow: `request` creates a `MessageChannel`, posts `{method, args, reply}` with `port2` transferred, and waits for a reply on `port1`.
- Non-obvious design decisions: (1) **one channel per request** — a reply port that is closed cannot be reused, so a late reply cannot be mistaken for the answer to a later request; (2) the reply is validated (`z.discriminatedUnion('ok', …)`) before it is trusted — a malformed reply rejects the request; (3) `port1` also listens for `messageerror` and `close`, so a peer shutdown rejects the request instead of leaving it pending forever; (4) both ports are closed in a `finally`, and the abort listener is removed — the spec asserts `getEventListeners(controller.signal,'abort')` is empty afterwards.
- Edge cases / failure handling: an already-aborted signal throws *before* dispatch (and the spec proves nothing was posted); a non-transferable argument surfaces the structured-clone error; a non-transferable *result* is returned to the caller as a clone error.
- Surprising: `answer` wraps the operation in try/catch and posts `{ok:false, error}` — so a worker-side failure is a *reply*, not a transport error, and the reply port is closed in a `finally` either way.

### packages/experimental/browser-use-stagehand-native/src/worker.ts
- Purpose: the Worker entry — validates its configuration and dispatches validated operations.
- Key abstractions: the `workerData` zod schema; `methodSchema` (a `z.enum` of the browser method names).
- Data flow: parse `workerData` → start `openNativeBrowser` → answer messages.
- Non-obvious design decisions: (1) the *configuration* is validated again inside the Worker, so a malformed `workerData` cannot reach the SDK; (2) `opening` is started eagerly and its failure is kept observable through the host's `ready` request — "Initialization failure stays observable through the host's ready request" — so a broken extension surfaces as a failed `ready`, not a hang; (3) the method name is re-parsed with `methodSchema` before dispatch, so the Worker does not trust the string it was sent.
- Edge cases / failure handling: importing the module outside a Worker throws 'Stagehand attachment requires a Worker parent'; a protocol failure logs to stderr and `process.exit(1)`.
- Surprising: the Worker owns the **CDP connection** but not the browser process — the two halves are deliberately separated so a host crash does not leave an orphaned Chromium.

### packages/experimental/browser-use-stagehand-native/tests/fixtures/stagehand.ts
- Purpose: the fake Stagehand SDK, browser and pages.
- Key abstractions: `nativeModel`; `screenshotBase64` (a 1×1 PNG); a mutable `fixture` object; `FixturePage`, `FixtureBrowser`, `Stagehand`, `localBrowser`.
- Data flow: the fake `Stagehand.create` records the model it was given; `extract`/`act`/`observe` return a canned result and can be interrupted.
- Non-obvious design decisions: (1) `Stagehand.close()` awaits **all pending browser operations** (`Promise.allSettled(this.browser.pending)`) before marking itself closed — that is the "drain" the production code is built around; (2) the fixture's `inference` promise can be raced against the connection closing, so a test can hold an operation open and then interrupt it; (3) `localBrowser.connect` returns the *same* browser for the same `cdpUrl`, so an attached browser can be observed as a single instance.
- Edge cases / failure handling: `fixture.createError` makes the extension initialisation fail (the rollback case); `fixture.stagehandClose` can throw (the drain-failure case).
- Surprising: the fixture exposes `stagehandClosed` and `closed` as *separate* flags — the SDK's own close and the browser's close are distinct facts, and the production code's asymmetric cleanup rule depends on the difference.

### packages/experimental/browser-use-stagehand-native/tests/fixtures/chromium.ts
- Purpose: the fake `@puppeteer/browsers` module.
- Key abstractions: `launch(options)` returning a `nodeProcess`, `waitForLineOutput()` and `kill()`.
- Data flow: the fake records the launched browser in `fixture.browsers` and registers a synthetic `http://fixture/<n>` endpoint.
- Non-obvious design decisions: the fake derives the `headless` flag from `options.args.includes('--headless=new')` so the spec can assert the launcher passed it; `kill()` closes the browser and then emits `close` on the fake process — the same ordering the real child has.
- Edge cases / failure handling: the fake never fails, so the failure paths are tested elsewhere (in `launch.spec.ts` with a fuller mock).
- Surprising: it is a *module-level* mock of a third-party package, so the production `launch.ts` runs unchanged against it.

### packages/experimental/browser-use-stagehand-native/tests/fixtures/attachment-worker.mjs
- Purpose: a deterministic Worker peer for the client tests.
- Key abstractions: scenarios chosen by the `workerData.cdpEndpoint` hostname — `ready`, `opening`, `closing`, `failure`, `close-failure`, `error`, `crash`.
- Data flow: it opens a TCP listener and answers `request` messages with `{ok:true, value:{port, model, env}}` — the value carries the **environment** the Worker saw, which is how the spec proves the env scrub.
- Non-obvious design decisions: (1) the `act` method parks until a `fixture-release` message arrives, so a test can hold an operation open and then cancel it; (2) the `close` method waits for the active operation *and* the listener close before replying — a real drain; (3) the `crash` scenario exits with code 23, so the client's "Worker exited" path is exercised.
- Edge cases / failure handling: the `failure` and `close-failure` scenarios reply with `{ok:false, error: …}`.
- Surprising: the fixture's reply value includes `env: process.env` — the spec asserts that the ambient `STAGEHAND_FIXTURE_TOKEN` and `HTTP_PROXY` are **absent** inside the Worker.

### packages/experimental/browser-use-stagehand-native/tests/fixtures/built-attachment.mjs
- Purpose: a plain-Node smoke of the *published* provider (not the source).
- Key abstractions: it imports `../../lib/index.js` (the built bundle) and drives `stagehand_tabs` / `stagehand_navigate` through `ctx.tools.execute`.
- Data flow: mount the provider in attach mode with an offline model, create an Agent through the testkit harness, then call the two tools.
- Non-obvious design decisions: the model is a fake string (`apiKey: 'offline-browser-smoke'`) — the smoke never contacts a provider; and the result is written to stdout as JSON so a shell script can assert on it.
- Edge cases / failure handling: a failed tool call throws with the JSON content, so the smoke fails loudly.
- Surprising: this is the only fixture in the shard that exercises the **built** artefact; it exists because the Worker entry has to be loadable without the source files.

### packages/experimental/browser-use-stagehand-native/tests/launch.spec.ts
- Purpose: 116-line spec for Chromium ownership.
- Key abstractions: `vi.mock('@puppeteer/browsers')` with a `processFixture()` that returns a fake child, a `ready` promise and a `kill` spy.
- Data flow: `launchChromium(config, signal)` with the mocked launcher.
- Non-obvious design decisions: (1) the scrubbed environment is asserted field by field — `BROWSER_LAUNCH_PUBLIC` survives ("visible") while `BROWSER_LAUNCH_API_TOKEN` and `DSH_FIXTURE_ID` do not; (2) the profile directory is asserted to *exist* while the browser runs and to be *gone* after `close()`; (3) the "cancels after spawn and waits for close before removing the profile" case proves the profile outlives the kill until the child's `close` event.
- Edge cases / failure handling: the "preserves cleanup failure when a canceled process cannot be killed" case makes `kill` throw and asserts the error propagates **and** the profile is left behind (the failure is not masked by a successful-looking cleanup).
- Surprising: the spec is parameterised over `headless` true/false, so the `--headless=new` flag and the executable-path default are both pinned.

### packages/experimental/browser-use-stagehand-native/tests/launch-process.spec.ts
- Purpose: 15-line spec for the failed-spawn path against a *real* (missing) executable.
- Key abstractions: `join(tmpdir(), 'missing-browser-<uuid>')`.
- Data flow: `launchChromium` with a nonexistent `executablePath`.
- Non-obvious design decisions: it is the only test in the package that uses the real `@puppeteer/browsers` — "releases a real failed spawn without waiting for an exit event" — because the "error + close without exit" behaviour is a property of the real launcher, not of a mock.
- Edge cases / failure handling: the spec asserts the rejection message is 'Failed to launch the browser process'.
- Surprising: 15 lines, and they cover a bug that a mocked launcher could not have found.

### packages/experimental/browser-use-stagehand-native/tests/worker-client.spec.ts
- Purpose: 171-line spec for the Worker client, using **real** Workers against the fixture peer.
- Key abstractions: `vi.mock('node:worker_threads')` swaps the `Worker` class for one that loads `./fixtures/attachment-worker.mjs` while recording the requested entry.
- Data flow: `openBrowserWorker(config, signal, warn)` then `runtime.execute('tabs', {action:'list'})`.
- Non-obvious design decisions: (1) the spec asserts the *source* bootstrap contains `tsx` — proving the source-run path is the one under test; (2) it asserts the Worker saw only the explicit model and an environment without the ambient token or proxy; (3) after `close()` the Worker's thread id is `-1` and the TCP port the fixture held is now `ECONNREFUSED` — the listener really went away.
- Edge cases / failure handling: the "reports failed Worker termination during canceled request cleanup" case makes `worker.terminate` reject and asserts that `runtime.close()` then rejects with 'Worker shutdown refused' rather than swallowing it.
- Surprising: the spec drives the real `tsx` bootstrap, so the source and the built paths share one suite.

### packages/experimental/browser-use-stagehand-native/tests/worker-rpc.spec.ts
- Purpose: 140-line spec for the MessagePort RPC.
- Key abstractions: a `channel()` helper that tracks both ports' `close` events; a `receive(port)` helper that parses the request envelope.
- Data flow: `request(port1, 'extract', {...})` and `answer(raw, execute)`.
- Non-obvious design decisions: (1) every assertion is about *closure* — the reply port is closed after a malformed response, after a peer shutdown, and after a cancellation; (2) the abort listener is removed (`getEventListeners(controller.signal,'abort')` is asserted empty) so a long-lived controller does not accumulate listeners; (3) an already-cancelled request is **not dispatched** at all (`expect(received).not.toHaveBeenCalled()`).
- Edge cases / failure handling: the clone-failure cases (an argument and a result) are asserted with a `/clone/u` regex, because the structured-clone error is Node's, not the protocol's.
- Surprising: the malformed-response table covers `{ok:true, value:'unexpected', extra:true}`, `{ok:false, error:42}` and `{value:'missing status'}` — each rejected by the schema rather than by a hand-written check.

### packages/experimental/browser-use-stagehand-native/tests/worker.spec.ts
- Purpose: 58-line spec for the Worker entry.
- Key abstractions: `vi.mock('node:worker_threads')` to supply a fake `parentPort`/`workerData`; `vi.mock('@browserbasehq/stagehand')` with the fixture.
- Data flow: `import('../src/worker.ts')` then `request(peer, 'ready')` and the operations.
- Non-obvious design decisions: (1) the spec asserts the Stagehand instance was created with the **independently configured** model (`fixture.models` equals the configured model) — the native model is not the Session's model; (2) after a `close` it asserts `stagehandClosed === true` but `closed === false` — the SDK was closed and the *external* browser was not.
- Edge cases / failure handling: an initialisation failure is reported through the `ready` request and the external browser is still open; importing the module outside a Worker rejects with 'requires a Worker parent'.
- Surprising: the "unavailable method" case (`request(peer,'unavailable')`) proves the method name is validated against the closed set.

### packages/experimental/browser-use-stagehand-native/tests/worker-protocol.spec.ts
- Purpose: 35-line spec for the Worker's protocol failure path.
- Key abstractions: a real `Worker` started from a `data:` URL bootstrap that installs the snapshot hooks and imports the source entry.
- Data flow: `worker.postMessage({method: 42, reply: false})` — a deliberately malformed envelope.
- Non-obvious design decisions: the test captures the Worker's **stderr** and asserts it contains 'Stagehand Worker protocol failed:' and that the exit code is exactly `1` — the failure is diagnosable from the host's logs, not just from the rejection.
- Edge cases / failure handling: the malformed message kills only the owned Worker (`expect(worker.threadId).toBe(-1)`), not the host.
- Surprising: it uses the *snapshot* browser hooks (`snapshots/session/browser-use-stagehand-native/native-fixture.mjs`) to intercept the external browser — a cross-package fixture.

### packages/experimental/browser-use-stagehand-native/tests/provider.spec.ts
- Purpose: 421-line spec for the provider's ownership and tool behaviour, against real Agent/Session/ToolRuntime services.
- Key abstractions: hoisted `acquisition` state for the signals and the injected close errors; mocked `worker-client` and `launch`.
- Data flow: `ctx.plugin(Provider, {model, mode})` then `ctx.tools.execute({name:'stagehand_tabs', …})`.
- Non-obvious design decisions: (1) the spec proves the provider **never uses the Session's model** — `IndependentSessionModel.stream` throws 'Stagehand called the Session model'; (2) the "retains ownership when both SDK drainage and owned Chromium cleanup fail" case asserts the provider name is **still** `stagehand-native` after a failed dispose; (3) the "blocks reconnection and another owner after canceled native work fails to drain" case asserts that after a failed drain *every* subsequent call fails — the second agent included — so a poisoned connection is not reused.
- Edge cases / failure handling: the attach mode keeps the external browser open (`fixture.browsers[0].closed === false`) while launch mode closes it; the provider name is released only when the cleanup fully succeeded.
- Surprising: the tests assert `ctx.browserUse.providerName` rather than a boolean — the *identity* of the owner is part of the contract, because the browser-use registry is exclusive.

### packages/experimental/browser-use-stagehand-native/tests/loader-composition.spec.ts
- Purpose: 128-line spec that loads the provider from a real `cordis.yml` through the real Loader.
- Key abstractions: a `BrowserModel` `LlmAdapter` that calls `stagehand_extract` then `stagehand_screenshot`; the real `LocalAttachmentStore`.
- Data flow: the model calls the tools; the screenshot is admitted; the next request carries the attachment reference.
- Non-obvious design decisions: (1) the spec asserts the native **model key** never appears in the main model's requests (`expect(JSON.stringify(model.requests)).not.toContain('fixture-model-key')`) — the browser's own inference credential stays out of the session transcript; (2) the screenshot is verified end to end — the durable attachment's bytes equal the fixture PNG, the next request contains the *reference*, and the raw base64 is absent from the tool result.
- Edge cases / failure handling: the spec asserts no `browser-use/*` event is written to the session log — the browser activity is logged through the ordinary `tool/result` path, not a parallel event stream.
- Surprising: the Worker is bootstrapped from a `data:` URL that installs the snapshot hooks, so the real Worker runs against the external-browser fixture.

### packages/experimental/browser-use-stagehand-native/tests/native.e2e.ts
- Purpose: 255-line opt-in smoke against an installed Chromium and, optionally, a real Stagehand model.
- Key abstractions: an `ImageCapabilities` `LlmAdapter` that resolves image input but throws on `stream`; a local HTTP fixture page with a click button.
- Data flow: launch or attach a real Chromium, navigate, screenshot, then (optionally) drive a real native inference and a cancel/reconnect cycle.
- Non-obvious design decisions: the test is gated on **both** `DSH_STAGEHAND_E2E` and `DSH_BROWSER_EXECUTABLE`, and the real model path additionally needs `DSH_STAGEHAND_MODEL` and `DSH_STAGEHAND_MODEL_API_KEY`; the timeout is 120 s and `retry: 0`.
- Edge cases / failure handling: the reconnect case cancels a navigation and then asserts the browser is *retained* ("Retained browser") and that the subsequent navigation still works — cancellation must not destroy the attachment.
- Surprising: the test asserts the screenshot result's content contains the fixture page's text, so the whole path (capture → admission → model) is exercised, not just the capture.

### packages/experimental/browser-use-stagehand-native/tests/native.spec.ts
- Purpose: 49-line spec for the SDK-level native runtime.
- Key abstractions: the same `openNativeBrowser` entry the Worker uses.
- Data flow: `openNativeBrowser(config)` against the mocked SDK.
- Non-obvious design decisions: (1) the attachment-failure case asserts the browser is still `closed === false` and still has its `about:blank` page — a failed *extension* initialisation must not close the user's browser; (2) the cleanup-failure case asserts `runtime.close()` rejects and the browser stays open.
- Edge cases / failure handling: the screenshot case asserts the exact MCP content shape (`text` + `image` blocks).
- Surprising: it is the SDK-level twin of `worker.spec.ts` — the same facts checked one layer down.

### packages/experimental/browser-use-stagehand-native/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-browser-use-stagehand-native`.
- Key abstractions: `@browserbasehq/stagehand: "4.1.0"` and `@puppeteer/browsers: "3.2.2"` pinned; a `./worker` export.
- Data flow: `exports` ships `.` and `./worker` (`lib/worker.js`); `files` ships `lib/index.js`, `lib/worker.js`, `lib/types/**`.
- Non-obvious design decisions: the Worker is a **separate published entry point** so it can be loaded without the source files; `tsx` is a devDependency (the source-run bootstrap) but not a runtime one; and the package depends on `dsh-mcp-client` for `createMcpToolDefinition` so the native results use the same adapter as the MCP providers.
- Edge cases / failure handling: n/a.
- Surprising: the `peerDependencies` list is short (cordis, agent, browser-use, system-prompt, tools) while the `dependencies` list is long — the native SDK is a hard dependency, the host registries are not.

### packages/experimental/browser-use-stagehand-native/tsconfig.json
- Purpose: 17-line compact TS project.
- Key abstractions: references to cordis, schemastery, browser-use, agent, tools, system-prompt, mcp-client, subprocess, util/values and `../browser-use-runtime`.
- Data flow: build graph.
- Non-obvious design decisions: `../../subprocess/subprocess` is referenced because `launch.ts` uses `scrubbedParentEnv` from it — the env scrub is a compile-time dependency.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/browser-use-stagehand-native/tsdown.config.ts
- Purpose: 14-line tsdown config building two bundles.
- Key abstractions: `defineConfig(['index','worker'].map(entry => ({...})))`.
- Data flow: build only.
- Non-obvious design decisions: the two bundles are separate so the Worker is loadable on its own; `inlineDynamicImports: true` keeps the Worker bundle self-contained (it dynamically imports the SDK at runtime).
- Edge cases / failure handling: n/a.
- Surprising: the comment says "Separate bundles keep the attachment Worker loadable without source files" — the reason the Worker entry is exported at all.

### packages/experimental/browser-use-stagehand-native/README.md
- Purpose: package reference for the native Stagehand provider.
- Key abstractions: the config table; the "Host requirements" section.
- Data flow: n/a.
- Non-obvious design decisions: the doc is explicit that the native model is *independent* of the Session model ("`model` is required even for navigation-only use") and that the pinned SDK accepts only its own catalogued providers (OpenAI, Anthropic, Google, Groq, Cerebras — "DeepSeek endpoints and `baseURL` overrides are unsupported"); the guide also records the *verified* local Chromium flags.
- Edge cases / failure handling: known limits: the native inference accepts **no abort signal** — "SDK 关闭会等待活动工作" — and cancellation does not roll back delivered input; the cleanup-failure rules are spelled out per ownership case.
- Surprising: the Model Experience section reproduces the guidance text verbatim in a fenced block, so the exact system-prompt bytes are reviewable in the README.

### packages/experimental/browser-use-stagehand-native/README.zh.md
- Purpose: Chinese mirror of the native Stagehand reference.
- Key abstractions: same config table, same host requirements, the same guidance block.
- Data flow: n/a.
- Non-obvious design decisions: it keeps the same statement that the model is required even for navigation-only use, and the same "不支持 DeepSeek 端点" caveat.
- Edge cases / failure handling: the cleanup-failure rules are translated per ownership case, keeping the three distinct outcomes (attached browser keeps its reservation, launched browser may release it, worker/process/profile failure keeps it).
- Surprising: n/a.

### packages/experimental/browser-use-stagehand-native/README.i18n.yaml
- Purpose: bilingual hash record (18 pairs) for the native Stagehand README.
- Key abstractions: anchor → hashes, including the nested `…/browser-guidance-text` anchor.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: the anchor tree records the guidance as a named subsection of "What the model sees" — the exact prompt is a hashed artefact.
- Edge cases / failure handling: n/a.
- Surprising: 18 anchors, the joint largest in the shard with the native Cua Driver README.

### packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx
- Purpose: the Team panel — a roster and shared task board rendered in the conversation header.
- Key abstractions: `TeamActionInjected {openTeammate}`; `MemberStatus = 'running'|'inactive'|'provisioning'|'failed'`; `statusKey`/`memberStatusKey`/`memberDotState`/`taskDotState` mapping domain values to locale keys and `StateDotState`s.
- Data flow: every row is derived from `useSessions(state => state.projectionsBySession[...])`, `useSessionStatus(...)` and the `useSession` seats — the Lead identity comes from the current Session's `subagent.address`, the Team view from `projectionsBySession[lead].values.agentTeam`, the model from `projectionsBySession[member].values.modelSelection.next`.
- Non-obvious design decisions: (1) the panel is rendered **outside** the conversation container via `createPortal(..., document.body)` and positioned with `useAnchoredPosition` so it can overflow the header; (2) hover opens after 150 ms and closes after a 120 ms grace; a click *pins* the panel and moves focus into it; Escape returns focus to the trigger only when focus was inside; (3) the "current conversation" row is tagged and **not selectable**; a failed or provisioning member is rendered disabled; (4) `memberStatus` prefers the live `useSessionStatus` value and falls back to the session-list summary (`running ?? summaryRunning`).
- Edge cases / failure handling: a navigation failure is caught and shown as an `role="alert"`; switching conversations closes the panel and clears the failure; a projection that reports a rejected persisted Team record shows that failure *above* the last valid roster and tasks rather than blanking the panel.
- Surprising: the component derives everything from projections and performs **no RPC at all** — the panel is a pure view over the shared Session store.

### packages/experimental/client-ui-agent-team/src/client/mount.ts
- Purpose: registers the Team locale dictionaries and the conversation-header slot.
- Key abstractions: `inject = ['sessions','uiWorkspace','slots','locale']`; a `leadSessionId()` resolver.
- Data flow: `ctx.effect(() => ctx.locale.register(NS, {zh, en}))` and `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({id:'agent-team', order:-20, locale:NS, inject: () => actions}, TeamAction))`.
- Non-obvious design decisions: (1) `leadSessionId()` reads `sessions.binding(sessionId)?.session.getSnapshot().subagent?.address?.parentSessionId` so a teammate conversation resolves back to its Lead; (2) the injected `openTeammate` refuses to navigate when the Session is not retained by the main view (`retainedInfo(sessionId).getSnapshot().retainedBy.mainView === 0`); (3) the docstring says outright: "this registration performs no Team RPC."
- Edge cases / failure handling: opening the Lead from a teammate conversation uses `ctx.uiWorkspace.openSession(parentSessionId)`; opening a teammate uses `{parentSessionId, childSessionId, mode: 'continuable'}` — the *stable addressed-subagent* path, not the Team peer mailbox.
- Surprising: the slot is registered with `order: -20`, so it appears before other header actions.

### packages/experimental/client-ui-agent-team/src/client/locales.ts
- Purpose: the English and Chinese copy for the Team panel.
- Key abstractions: `NS = 'agent-team'`; `zh` is the **key source** (`type TeamKey = keyof typeof zh`) and `en` is checked against it (`satisfies Record<TeamKey, string>`).
- Data flow: n/a.
- Non-obvious design decisions: the Chinese dictionary is the source of truth and English is the checked translation — the reverse of the cot-translation package, which uses English as the source. The type system makes a missing key a compile error in both directions.
- Edge cases / failure handling: `failure: '团队持久记录无效：{message}'` — a `{message}` placeholder, the interpolation convention used across the repo.
- Surprising: the copy keeps a literal `'Owner'` and `'未分配'` (unowned) in the same panel, i.e. the owner label is *not* translated.

### packages/experimental/client-ui-agent-team/src/client/index.ts
- Purpose: the browser entry for the Team UI plugin.
- Key abstractions: `apply(ctx)` → `registerAgentTeamUi(ctx)`.
- Data flow: n/a.
- Non-obvious design decisions: it re-exports `inject` from `mount.ts` so the loader sees the same list the mount uses.
- Edge cases / failure handling: n/a.
- Surprising: 16 lines; the whole plugin is a thin entry.

### packages/experimental/client-ui-agent-team/src/index.ts
- Purpose: the inert **Host** half of a browser-discovered plugin.
- Key abstractions: `export function apply(): void {}`.
- Data flow: n/a.
- Non-obvious design decisions: a plugin that has only browser behaviour still needs a host entry so the loader can mount the package and discover the `./client` export.
- Edge cases / failure handling: n/a.
- Surprising: the spec asserts `expect(() => { nodeApply() }).not.toThrow()` — the host half is *tested for inertness*.

### packages/experimental/client-ui-agent-team/src/client/TeamAction.module.css
- Purpose: the panel's stylesheet.
- Key abstractions: `.panel`, `.panelCompact`, `.roster`, `.member`, `.taskTitle`, `.expandToggle`, `.notice`/`.error`.
- Data flow: n/a.
- Non-obvious design decisions: two documented layout traps. (1) The menu skin lives on a **pseudo-element** (`.panel::before`) because "backdrop-filter on the panel itself would turn it into the containing block for fixed descendants, so the member Tooltip bubbles would be re-anchored into the panel and clipped by its hidden overflow." (2) Horizontal insets live on the toolbar and scroll body, not the panel, "so member-card hover shadows stay inside the body's clip box; the thumb hugs the panel edge (2px) while the body's stable gutter and trailing padding rebuild the 16px content inset." A `@container (max-width: 480px)` rule hides the trigger label, and the component reads that collapsed state back to switch from hover-open to click-only.
- Edge cases / failure handling: `.panelCompact` drops the roster to one column when there is a lone member and no tasks.
- Surprising: `scrollbar-gutter: stable` on `.body` — the scrollbar is always reserved so the content does not shift when the list grows.

### packages/experimental/client-ui-agent-team/tests/team-action.client.spec.tsx
- Purpose: 565-line jsdom spec for the Team panel.
- Key abstractions: `bench()` builds real snapshot stores with `createSnapshotStore` and binds them with `bindSnapshotSelector`; `makeTranslate(zh, commonZh)`.
- Data flow: renders `<TeamAction {...b.props} />` and drives it with `fireEvent`.
- Non-obvious design decisions: the read-only property of the task board is asserted structurally: `for (const card of tasks) expect(card.querySelector('button, input, select, textarea')).toBeNull()` — not "the button does nothing", but *there is no control*. The dot states are asserted as an exact array `['idle','warning','done']`.
- Edge cases / failure handling: the "keeps the full original visible after a later paragraph fails" analogue: a projection failure shows the failure *beside* the last valid state, and the previously rendered roster/tasks stay on screen.
- Surprising: the spec asserts `expect(document.activeElement).toBe(screen.getByRole('button', {name: /智能体团队/u}))` after Escape — focus restoration is part of the contract.

### packages/experimental/client-ui-agent-team/tests/browser-plugin.client.spec.ts
- Purpose: 139-line spec for the *registration* side of the plugin.
- Key abstractions: a `bench()` that provides fake `sessions`, `uiWorkspace`, `conversation` and a real `LocaleRuntime` + `SlotRegistry`.
- Data flow: mounts the plugin through `ctx.plugin({inject, apply})` and inspects `ctx.slots.entries('conversation.session.header.actions')`.
- Non-obvious design decisions: the plugin's `inject` list is asserted exactly (`['sessions','uiWorkspace','slots','locale']`); the spec proves **no navigation happens at registration** (`expect(b.navigation).toEqual([])`), and that the slot survives the header being collapsed and re-declared (the `slots.inject` re-registers).
- Edge cases / failure handling: "does not open a teammate from a conversation outside the main view" — the injected callback returns without navigating when `retainedBy.mainView` is 0.
- Surprising: the spec asserts the entry matches `{options: {id:'agent-team', order:-20}, locale:'agent-team'}` — the slot's *ordering* is part of the contract.

### packages/experimental/client-ui-agent-team/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-client-ui-agent-team`.
- Key abstractions: a `dsh.client` block declaring `inject` (five browser packages) and `platform: 'web'`.
- Data flow: `exports` ships `.` and `./client`; `files` ships `lib/index.js`, `lib/client.js`, `lib/types/**`.
- Non-obvious design decisions: the `dsh.client.inject` list is the *browser-side* dependency declaration — the loader uses it to pull in the session controller, locale, conversation, primitives and workspace plugins before this one mounts.
- Edge cases / failure handling: `scripts: {bundle: 'tsdown', watch: 'tsdown --watch'}` — the client bundle is a separate build from the host package.
- Surprising: `react` and `react-dom` are devDependencies, not peers — the client bundle inlines them.

### packages/experimental/client-ui-agent-team/tsconfig.json
- Purpose: 22-line TS project extending `tsconfig.base.client.json`.
- Key abstractions: 12 project references including `../agent-team` (the Host domain) and `../../client/ui-slots`.
- Data flow: build graph.
- Non-obvious design decisions: the client project references the *Host* package `../agent-team` for its projection types only — the browser half consumes the domain's types without running the domain.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-agent-team/tsdown.config.ts
- Purpose: 3-line client bundle config.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: compiled client types → `lib/client.js`.
- Non-obvious design decisions: the shared `clientBundle` helper is imported from `../../client/tsdown.client.ts` — every browser plugin uses the same bundler recipe, so the outputs are comparable.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-agent-team/src/css-modules.d.ts
- Purpose: 6-line ambient declaration for `*.module.css`.
- Key abstractions: `declare module '*.module.css' { const classes: Record<string,string>; export default classes }` plus a bare `declare module '*.css'`.
- Data flow: makes `import css from './X.module.css'` type-check.
- Non-obvious design decisions: the class map is `Record<string,string>` — every class name is accepted, so a typo is a runtime `undefined` rather than a compile error. The tradeoff is deliberate: CSS-module class names are generated, not a stable API.
- Edge cases / failure handling: n/a.
- Surprising: the same 5–6 line file is duplicated in four client packages rather than shared.

### packages/experimental/client-ui-agent-team/README.md
- Purpose: the package reference for the Team panel.
- Key abstractions: the roster and task-board description; the file-role table.
- Data flow: n/a.
- Non-obvious design decisions: the README is unusually explicit about what the panel does *not* do: it "does not extend the stable API Proxy, store Team state, or register model-facing input", and the Model Experience section says "None".
- Edge cases / failure handling: known limits: no mailbox timeline; late plugin activation needs a page reload to receive the Team projection; a model appears only when the shared store has a durable selection; a human message after navigation uses the stable addressed-subagent path, not the Team peer mailbox; the panel cannot spawn/rename/delete/interrupt teammates and write scopes remain advisory.
- Surprising: "Task and roster updates appear while the panel stays open. Opening the panel performs no projection requests." — the freshness is free because the projection is pushed.

### packages/experimental/client-ui-agent-team/README.zh.md
- Purpose: Chinese mirror of the Team panel reference.
- Key abstractions: same structure and same file-role table.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version keeps the same "打开面板不发起投影请求" sentence.
- Edge cases / failure handling: same five known limitations.
- Surprising: n/a.

### packages/experimental/client-ui-agent-team/README.i18n.yaml
- Purpose: bilingual hash record (14 pairs) for the Team panel README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-agent-team/locale/en.json
- Purpose: English plugin metadata "Team Panel".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description enumerates the three verbs of the panel — "View team members and shared tasks, and navigate to member conversations".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-agent-team/locale/zh.json
- Purpose: Chinese plugin metadata "团队面板".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-claude-code-mods/src/client/Band.tsx
- Purpose: renders the band a Claude Code mod draws above the prompt.
- Key abstractions: `BandInjected {hooks: {band}, press}`; `BandProps`; a recursive `Node` component over `SerializedNode`.
- Data flow: `useBand(value => value)` selects the current `SurfaceSnapshot`; `snapshot.tree` is rendered; a button press calls `press(snapshot.generation, actionId)`.
- Non-obvious design decisions: (1) the serialized tree is mapped to a **small attribute vocabulary** — `data-color`, `data-bold`, `data-dim`, `data-italic`, `data-underline` for `Text`, and `data-direction` / `data-border` / inline padding & gap for `Box` — with the CSS doing the rest; the color names are restricted to the ten Claude Code terminal colours, and `grey` is normalised to `gray`; (2) **a Button without an action id is drawn but never pressable** (`actionId === ''` ⇒ disabled) — "drawn, never pressable"; (3) every button is disabled while any press is in flight, and the pressed one carries `aria-busy`.
- Edge cases / failure handling: a refused press shows the message under the band in a `role="status"` element and clears the pending state; the *content* of the error is the message only.
- Surprising: the props are a Claude Code subset — `width`, `height`, `overflow`, `wrap` and `truncate` are ignored, and the host renders for a band 120 columns wide, so the band wraps.

### packages/experimental/client-ui-claude-code-mods/src/client/mount.ts
- Purpose: bridges the Host's `claudeCodeMods` Remote into the browser band.
- Key abstractions: a tiny `BandStore` (a snapshot + a listener set) implementing `HostObservable`; `watchSession(ctx, sessionId, onEnd)`.
- Data flow: `ctx.remote.claudeCodeMods.watchBand(sessionId, signal)` is iterated and pushed into the store; `press` calls `ctx.remote.claudeCodeMods.pressBand(sessionId, generation, actionId)` and applies the returned snapshot.
- Non-obvious design decisions: (1) **one watch per session**, created lazily and cached in a `Map<SessionId, …>`; (2) when the stream ends, the `onEnd` callback *removes the entry*, "so the next subscriber opens a fresh stream instead of reading a stale store"; (3) the press carries the **generation** the band was drawn in, so a button from an older drawing is refused by the Host (the locale even has a `press.stale` message); (4) a stream that ends normally is dropped silently, but a stream that *fails* logs a warning — and a failure after disposal is not reported at all.
- Edge cases / failure handling: `dispose()` aborts the controller and disposes the handle; all watches are disposed by a `ctx.effect` cleanup.
- Surprising: `mountModsBand` mounts the Remote contribution *first* and injects the UI *second*, and on a UI failure it disposes the UI and then the Remote, in that order.

### packages/experimental/client-ui-claude-code-mods/src/client/locales.ts
- Purpose: the English and Chinese copy for the band chrome.
- Key abstractions: `NS = 'claude-code-mods'`; `zh` is the key source, `en` is `satisfies Record<ModsBandKey, string>`.
- Data flow: n/a.
- Non-obvious design decisions: only **four** keys — the mods' own content is theirs, so the plugin owns nothing but the chrome. The `press.stale` key exists even though the browser never renders it: the *Host* owns that message.
- Edge cases / failure handling: n/a.
- Surprising: the file's first line says "the mods' own content is theirs" — a deliberate scope boundary written into the doc comment.

### packages/experimental/client-ui-claude-code-mods/src/client/index.ts
- Purpose: the browser entry that mounts the generated Remote and registers the band.
- Key abstractions: `apply(ctx)` → `mountModsBand(ctx, modsRemote)`.
- Data flow: n/a.
- Non-obvious design decisions: the generated `modsRemote` contribution is imported from `@deepseek-ai/dsh-experimental-claude-code-mods/remote` — the browser half consumes a *generated* artefact, not the Host's implementation.
- Edge cases / failure handling: n/a.
- Surprising: 18 lines.

### packages/experimental/client-ui-claude-code-mods/src/index.ts
- Purpose: the inert Host marker for the browser-discovered mods band.
- Key abstractions: `export function apply(): void {}`.
- Data flow: n/a.
- Non-obvious design decisions: same inert-host pattern as the Team plugin.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-claude-code-mods/src/client/Band.module.css
- Purpose: the band's stylesheet.
- Key abstractions: `.band`, `.box[data-direction]`, `.text[data-*]`, `.button`, `.hotkey`, `.notice`.
- Data flow: n/a.
- Non-obvious design decisions: the ten Claude Code terminal colours are each mapped to a *theme token* (`--dsw-alias-state-warn-primary` for yellow, `--dsw-alias-state-error-primary` for red, `--dsw-alias-state-success-primary` for green, `--dsw-alias-button-info-fill` for cyan/blue, `--dsw-alias-state-business-primary` for magenta, `--dsw-alias-label-tertiary` for gray, `--dsw-alias-label-primary` for white/black) — the palette is reproduced in the theme's own vocabulary, and the same mapping is duplicated for the box border colours.
- Edge cases / failure handling: `.button:disabled { opacity: 0.6 }` — a disabled button is dimmed rather than hidden.
- Surprising: the band uses `font-family: var(--dsw-font-mono, ui-monospace, ...)` and `white-space: pre-wrap` — it is deliberately a *terminal* surface, not a prose surface.

### packages/experimental/client-ui-claude-code-mods/tests/band.client.spec.tsx
- Purpose: 116-line jsdom spec for the band renderer.
- Key abstractions: two fixture snapshots (`WEATHER` and `HOLD`); `fixture(initial)` returning a `press` spy and a `publish` helper.
- Data flow: renders `<Band {...props} />` with `useBand` bound to a real snapshot store.
- Non-obvious design decisions: the fixture deliberately includes a hostile `color: 'nonsense'` and a `grey` colour, and the assertions pin the *normalisation*: the nonsense colour yields **no** `data-color` attribute at all (the attribute is `null`), and `grey` becomes `gray`. The `HOLD` fixture includes a `Button` with no `actionId` ("Inert") and a `disabled: true` button, and the spec asserts both are disabled.
- Edge cases / failure handling: the press failure is asserted twice — once with an `Error` and once with a **bare string** rejection, and both render `按钮操作失败：<message>` — a non-Error rejection is stringified, not crashed on.
- Surprising: the spec asserts `expect(band.textContent).toBe('☀  Clear  18% of context  36k / 200kplain tail')` — the exact concatenated text, including the missing space before 'plain tail'. Rendering is a pure function of the tree.

### packages/experimental/client-ui-claude-code-mods/tests/mount.client.spec.ts
- Purpose: 180-line spec for the mount lifecycle and the per-session watch.
- Key abstractions: a hand-written `stream()` fake implementing the async-iterator handle; `assertBandInjected` narrowing the erased registry payload.
- Data flow: mounts the plugin with a fake `remote` service, then drives the watch by hand.
- Non-obvious design decisions: the spec pins the **stale-store** rule: after a stream closes, the next `injected('s1')` call must produce a **new** store object (`expect(f.injected('s1').hooks.band).not.toBe(stale)`) and a third `watchBand` call. It also distinguishes three endings — a clean close (no report), a failure (a warning naming the session and the message), and a failure *after* disposal (not reported, because "a failure after disposal is the stream closing, not a report").
- Edge cases / failure handling: the warning text is asserted exactly: `'claude-code-mods band: watch of s2 ended: text failure'`.
- Surprising: the spec uses `assert` from `node:assert/strict` rather than a type cast to narrow the injected face — the registry payload is genuinely erased.

### packages/experimental/client-ui-claude-code-mods/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-client-ui-claude-code-mods`.
- Key abstractions: a `dsh.client` block with five injected browser packages and `platform: 'web'`.
- Data flow: `exports` ships `.` and `./client`.
- Non-obvious design decisions: `@deepseek-ai/dsh-typert-protocol` is a devDependency here but a real dependency in `client-ui-cot-translation` — the difference is that the mods band consumes a *generated* Remote contribution it does not own, while the cot-translation plugin owns a Host controller it also exposes to the browser.
- Edge cases / failure handling: n/a.
- Surprising: `react`/`react-dom` are devDependencies.

### packages/experimental/client-ui-claude-code-mods/tsconfig.json
- Purpose: 48-line TS project extending `tsconfig.base.client.json`.
- Key abstractions: 12 references, including `../../api/remotes/tsconfig.client.json` and `../claude-code-mods`.
- Data flow: build graph.
- Non-obvious design decisions: the reference set includes the *Host* package `../claude-code-mods` for the `SurfaceSnapshot` / `SerializedNode` types and the generated `/remote` entry.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-claude-code-mods/tsdown.config.ts
- Purpose: 3-line client bundle config using the shared `clientBundle` helper.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: build only.
- Non-obvious design decisions: identical to the Team plugin's config — the shared helper is what makes the browser packages uniform.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-claude-code-mods/src/css-modules.d.ts
- Purpose: 5-line ambient declaration for `*.module.css`.
- Key abstractions: `Record<string,string>` class map.
- Data flow: type-only.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: this package's version has a doc comment ("CSS module names emitted by the browser bundle") where the Team package's does not — the same file drifted cosmetically.

### packages/experimental/client-ui-claude-code-mods/README.md
- Purpose: package reference for the mods band.
- Key abstractions: the three example mods named in the README (Token Weather, Blast Radius, Replay Theater).
- Data flow: n/a.
- Non-obvious design decisions: the doc states the *scope* of the feature set precisely: one band per session; no docked `Pane`, no `TextInput`, no hotkeys, no focus, no scrolling; the `width`/`height`/`overflow`/`wrap`/`truncate` props are ignored; and "The band reflects the Host's redraw triggers; a mod that changes state outside them is drawn at the next trigger."
- Edge cases / failure handling: a press the Host refuses shows its message under the band; while a press is in flight every button is disabled.
- Surprising: the Model Experience section says "None, as the band is drawn from Host state and never enters a model request" — the button's effect reaches the model only through the mod's own hooks.

### packages/experimental/client-ui-claude-code-mods/README.zh.md
- Purpose: Chinese mirror of the mods band reference.
- Key abstractions: same three example mods.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese file's Model Experience paragraph is *untranslated* — it still reads "None, as 横幅由宿主状态绘制…", i.e. the English sentence with Chinese nouns substituted. It is still recorded in the hash file, so the gate accepts it.
- Edge cases / failure handling: same two known limitations.
- Surprising: this is the one place in the shard where a Chinese README keeps an English sentence; the i18n hash gate does not detect it.

### packages/experimental/client-ui-claude-code-mods/README.i18n.yaml
- Purpose: bilingual hash record (11 pairs) for the mods band README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the `/model-experience` hash (`628c0f0f837e8f43`) is shared with `client-ui-voice-input` — identical English prose about "None / no direct effect" across two unrelated packages.

### packages/experimental/client-ui-cot-translation/src/client/translation.ts
- Purpose: the reasoning-translation engine — paragraph scheduling, request chunking, caching and cancellation.
- Key abstractions: `Fragment {text, suffix, complete}`; `TranslationState {text, pending, failed}`; `TranslateText`; the `ReasoningTranslation` class.
- Data flow: `update(text, running)` re-splits the reasoning, publishes the current state, and enqueues a translation of the next uncached *complete* fragment; each result is cached by the fragment text and re-published.
- Non-obvious design decisions: (1) **only completed paragraphs are translated** — the fragment splitter treats a blank line as the completion boundary and marks the trailing fragment `complete: match !== null || !running`, so "the unfinished tail stays original"; (2) a long paragraph is split at the request limit with **surrogate-pair safety** — `if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1` — and prefers to cut at whitespace, keeping the whitespace as the *suffix* so the reassembled text is byte-identical to the input; (3) translations are **cached by fragment text** for the lifetime of the disclosure, so a repeated paragraph is translated once; (4) one request is in flight at a time (`if (this.pending || this.failed || this.isDisposed()) return`); (5) a failure sets `failed` and **stops the loop** — it does not retry automatically; (6) `dispose()` aborts the controller and every later publication is suppressed, so a late resolve or reject is ignored entirely.
- Edge cases / failure handling: `catch (_error) { if (!this.isDisposed()) this.failed = true }` — the provider's message is *never* published; only a boolean failure flag reaches the UI.
- Surprising: the cache key is the fragment *text*, and the cache lives only while the disclosure is mounted — the durable cache is the Host's, not this one.

### packages/experimental/client-ui-cot-translation/src/client/TranslationBody.tsx
- Purpose: the wrapper registered into Chat's `conversation.chat.reasoning.body` slot.
- Key abstractions: `TranslationBodyInjected {hooks: {preferences, translationLocale, translationLimit}, translate}`.
- Data flow: `preferences.targetLanguage === 'auto'` resolves to the *active UI locale*; a `ReasoningTranslation` controller is created per (provider, targetLanguage, limit, translate) tuple; the text is rendered through the official `renderFactorySlot('conversation.chat.reasoning.content', …)` so the typography is the platform's, not the plugin's.
- Non-obvious design decisions: (1) the controller is **recreated** when the provider/language/limit/translate identity changes, and the old one is disposed — that is how a stale in-flight request is cancelled; (2) the *original* text is always retained: `const showOriginal = original || state.failed`, and the failure state forces the original view; (3) the view toggle is **disabled while failed** so the user cannot flip back into a broken state; (4) the data attributes `data-cot-translation`, `data-translation-state` (`failed|pending|ready`) and `data-translation-view` (`original|translated`) make the state machine testable and CSS-addressable.
- Edge cases / failure handling: the pending state shows a spinner with `aria-label`; the failure shows the `failed` message plus a Retry button that calls `translation.current?.retry()`.
- Surprising: the plugin registers into the **body** slot and delegates rendering to the **content factory** — it wraps the platform's renderer instead of replacing it, so the reasoning typography and the code-block toolbar stay identical in both views.

### packages/experimental/client-ui-cot-translation/src/client/mount.ts
- Purpose: mounts the translation Remote and registers both the reasoning body and the Plugins settings entry.
- Key abstractions: a revision counter (`revision`, `lastReadRevision`, `acceptedRevision`); `refresh()`; the `injected` factory.
- Data flow: on mount, `read()` fetches the Host's `limits()`; the result populates three snapshot stores (preferences, limit, available providers). Any of six Remote events (`settings/document-updated`, `llm/adapters-updated`, `deepseek-account/session-expired`, `deepseek-account/model-sign-in-required`, `credentials/record-updated`, `credentials/reference-updated`) or a `connection/reset` bumps the revision and triggers a refresh.
- Non-obvious design decisions: (1) the `read()` loop **re-reads** if the revision changed while the request was in flight (`if (observed === revision) return result` else loop) — a lost-update guard; (2) before a translation is dispatched, the browser **re-checks** that the request's provider, target language and text length still match the accepted Host state, and refuses with `'Translation preferences or limits changed'` if they do not — a stale-metadata guard at the door, not a display nicety; (3) while a refresh is in flight the translate callback *waits* for it (`while (updating !== undefined) await updating`), so a request is never sent against half-updated preferences; (4) the settings entry injects `availableProviders` plus a `refreshProviders` callback so the Plugins page can re-query eligibility without sending any text.
- Edge cases / failure handling: disposal aborts the lifetime controller and awaits the pending read and update; a failed refresh logs a warning and leaves the previous values in place; a `limits()` failure at mount rejects the mount.
- Surprising: the plugin is mounted with `ctx.inject(['remote.cotTranslation', ...inject.slice(1)], …)` — the *generated* namespace is injected as a service, so the UI cannot exist without the Remote.

### packages/experimental/client-ui-cot-translation/src/index.ts
- Purpose: the Host-side `CotTranslationController` — a `TypertRemoteService` exposing `limits()` and `translate()`.
- Key abstractions: `Config {provider, targetLanguage}` (both `Volatile`); the `cotTranslation` Remote namespace.
- Data flow: `translate(request, signal)` resolves the accepted provider/language, calls `ctx.translator.translate(spec, signal)`, and on `TRANSLATION_SESSION_INACTIVE` for a *scoped* request joins the ordinary Session activation and retries **once**.
- Non-obvious design decisions: (1) the provider is **never** silently substituted — `if (provider !== accepted) throw new Error('Translation provider is not selected')`, and the same for an explicitly configured target language; (2) the catch-all converts every failure into `RemoteError('cotTranslation/failed', 'Translation failed', {})` with **empty details** — "Failures omit the source and provider response", so a provider's response can never leak to the browser; (3) the activation retry races the caller's abort with `Promise.withResolvers<never>()` + `addAbortListener`, so cancelling the caller stops the wait but the shared activation may still finish for other readers; (4) the controller explicitly configures the settings service to `auto: false`.
- Edge cases / failure handling: `signal.throwIfAborted()` appears before and after the activation, so a cancellation is never reported as a translation failure; a `TranslationError` with any other code is rethrown into the sanitising catch.
- Surprising: `Volatile` on both config fields means a settings change is picked up immediately by the *next* call, without a restart — and the browser is told about it through the metadata refresh.

### packages/experimental/client-ui-cot-translation/src/preferences.ts
- Purpose: the shared validation constants for provider and language.
- Key abstractions: `LANGUAGE_PREFERENCE_PATTERN = /^(?:auto|[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*)$/`; `PROVIDER_PREFERENCES = ['bing','google','deepseek-account','deepseek-official']`.
- Data flow: imported by both the Host `Config` schema and the browser's preferences form — one validator for two doors.
- Non-obvious design decisions: the pattern accepts BCP-47-ish tags (`zh`, `zh-Hant`) and the literal `auto`, and nothing else; the provider list is `satisfies readonly TranslationProvider[]` so it cannot drift from the translator's own type.
- Edge cases / failure handling: a malformed language makes the *whole* save invalid (the form's Save button is disabled), not just that field.
- Surprising: the file re-exports the types from `./types.ts` so both the Host and the browser can import from one module.

### packages/experimental/client-ui-cot-translation/src/types.ts
- Purpose: the browser-safe preference and snapshot types.
- Key abstractions: `CotTranslationPreferences {provider, targetLanguage}`; `CotTranslationSnapshot {maxTextChars, preferences, availableProviders}`.
- Data flow: n/a.
- Non-obvious design decisions: the doc comment on `provider` says "requests never fall back to another provider" — a *type-level* statement of a policy that the code enforces at two doors (Host and browser).
- Edge cases / failure handling: the `RemoteErrorDetailsMap` entry `'cotTranslation/failed'` is typed as `Record<string, never>` — the error is structurally incapable of carrying details.
- Surprising: the `RemoteErrorDetailsMap` declaration lives in a *client-facing* types file, so both ends share one error vocabulary.

### packages/experimental/client-ui-cot-translation/src/client/TranslationSettings.tsx
- Purpose: the Plugins-page settings for the translation provider and language.
- Key abstractions: `TranslationSettingsInjected extends TranslationFormInjected` adding `availableProviders` and `refreshProviders`.
- Data flow: reads the staged form state and the available-provider list; edits go through `props.edit`, saves through `props.save`.
- Non-obvious design decisions: (1) a **missing** provider (configured but not currently eligible) is rendered as a disabled `<option>` with the label "X — unavailable" and is *kept* in the list rather than silently dropped, so the user can see what they had and why it is gone; (2) the privacy notice and a *paid-vs-anonymous* notice are rendered above the fields — the paid notice spells out "Each uncached fragment sends a separate paid DeepSeek Flash request"; (3) an overridden field shows an "Overridden" tag and a per-field Reset button.
- Edge cases / failure handling: the whole form is disabled while `!state.writable || state.saving`; an invalid provider shows a `role="status"` message; a *valid but unavailable* provider shows a different, non-invalid message.
- Surprising: the provider list is filtered by the Host's eligibility (`availableProviders`), so a paid DeepSeek route only appears once the account is actually configured.

### packages/experimental/client-ui-cot-translation/src/client/preferences-form.ts
- Purpose: the staged preferences model (draft → Save) built on the shared `SettingsFormModel`.
- Key abstractions: `TranslationFormState extends SettingsFormShell`; `TranslationPreferencesForm`.
- Data flow: `SettingsFormModel(scope, [providerField, targetLanguageField])` with custom `parse` functions; `form.bind(...)` publishes the field states.
- Non-obvious design decisions: (1) the `provider` parser distinguishes **three** outcomes — `{kind:'clear'}` for an empty string, `{kind:'set', value}` for a known provider, and `undefined` for an unknown one — so "clear this preference" and "this is wrong" are different states; (2) the language parser trims before testing the pattern; (3) `dispose()` releases the accepted-preference subscription, and the spec asserts `scope.listenerCount()` reaches 0 after disposal.
- Edge cases / failure handling: an unparseable value leaves the field invalid, which disables Save — nothing is written until one explicit save.
- Surprising: the form is constructed with a *Host-backed* scope, so the browser never stores the preferences itself; the browser is a staged editor over Host state.

### packages/experimental/client-ui-cot-translation/src/client/locales.ts
- Purpose: the English and Chinese copy for the translation UI.
- Key abstractions: `NS = 'cotTranslation'`; `en` is the key source, `zh` is `Record<CotTranslationKey, string>`; `formLabels(t)`.
- Data flow: n/a.
- Non-obvious design decisions: the copy is unusually *honest about cost and privacy*: `privacy` says "Expanded reasoning is sent to the selected service. It may contain private code or conversation details."; `paidNotice` says "Each uncached fragment sends a separate paid DeepSeek Flash request … Reopening reasoning reuses saved results; changing the provider, language, source text, or request settings may send a new paid request."
- Edge cases / failure handling: `failed: 'Translation failed. Showing the original.'` — the message states what the user is looking at.
- Surprising: `formLabels(t)` reuses the *plugin's own* dictionary for the shared form chrome (`unavailable`, `readOnly`, `saveFailed`, `save`, `saving`) instead of the common locale — the plugin's namespace is self-contained.

### packages/experimental/client-ui-cot-translation/src/client/index.ts
- Purpose: the browser entry for the translation plugin.
- Key abstractions: `apply(ctx)` → `mountTranslation(ctx, remote)`.
- Data flow: n/a.
- Non-obvious design decisions: it declares `LocaleNamespaceMap {cotTranslation: …}` in the *slots* module, so the namespace is registered in the type system and the locale dictionary is checked against it.
- Edge cases / failure handling: n/a.
- Surprising: 21 lines.

### packages/experimental/client-ui-cot-translation/src/client/Translation.module.css
- Purpose: the translation toolbar and settings styles.
- Key abstractions: `.toolbar`, `.viewToggle`, `.spinner`, `.failure`, `.field`, `.notice`.
- Data flow: n/a.
- Non-obvious design decisions: the view toggle is offset by `-10px` to cancel the small Button's inline padding "to align its label with the body"; the spinner animation is disabled under `prefers-reduced-motion: reduce`.
- Edge cases / failure handling: `.failure` uses the *primary* label colour, not an error colour, because the original text is still shown — the failure is a status, not an error block.
- Surprising: the file shares `.field` / `.notice` between the reasoning toolbar and the Plugins settings form — one stylesheet for both surfaces of the same plugin.

### packages/experimental/client-ui-cot-translation/tests/translation.client.spec.ts
- Purpose: 118-line spec for the fragment splitter and the translation controller.
- Key abstractions: `fixture(maxTextChars)` returning `{controller, translate, states}`.
- Data flow: `controller.update(text, running)` then `controller.retry()` / `controller.dispose()`.
- Non-obvious design decisions: (1) the completion table is a table-driven `it.each` over six cases — empty, unfinished, settled, `'First\n\nTail'` (running), `'First\r\n \r\nSecond'`, `' \n\n'`; (2) the whitespace-preservation test asserts `parts.map(p => p.text + p.suffix).join('') === text` for six inputs including emoji, and that no part ends with a lone high surrogate; (3) "does not restart an in-flight paragraph on streaming updates" — a second `update` with a longer tail must not issue a second request; (4) "keeps a repeated unfinished tail original until the paragraph completes" — the same text appearing twice is translated once, and the still-growing tail stays original.
- Edge cases / failure handling: the failure test asserts `expect(JSON.stringify(b.states)).not.toContain('sensitive')` — the provider's message never reaches the published state; the disposal test asserts the request's signal is aborted and that **no** further state is published after disposal, for both a late resolve and a late reject.
- Surprising: the "finishes long streaming chunks while retaining the incomplete tail" test shows a *streaming* paragraph being translated in pieces: `'abcdefghij'` with a limit of 4 yields requests for `'abcd'` and `'efgh'`, and the tail `'ij'` is only requested after `running` becomes false.

### packages/experimental/client-ui-cot-translation/tests/translation-body.client.spec.tsx
- Purpose: 121-line jsdom spec for the reasoning-body wrapper.
- Key abstractions: a `fixture()` with three snapshot stores and a `translate` spy; the real `renderReasoningFactory` fixture from `client/ui-chat/tests`.
- Data flow: renders `<TranslationBody {...b.props} />` and asserts on the rendered markdown.
- Non-obvious design decisions: (1) switching between the original and the translation must **not** issue another request and must **not** remount the markdown (`expect(view.container.querySelector('[data-markdown-variant]')).toBe(markdown)` — the same DOM node) — the view toggle is a pure display change; (2) a provider change aborts the in-flight request (`expect(firstSignal.aborted).toBe(true)`) and a late resolve is ignored (`expect(view.queryByText('outdated translation')).toBeNull()`); (3) a changed request limit cancels and **re-chunks** the text (`'abcdefghij'` with limit 4 → three requests of 4/4/2).
- Edge cases / failure handling: after a failure the "View translation" toggle is disabled, the original is visible, and only the explicit Retry re-issues the request; the failed paragraph's *earlier successful* translation is retained and re-used on retry.
- Surprising: the test asserts the failure message is generic (`en.failed`) and that the provider's message (`secret request text`) is nowhere in the DOM.

### packages/experimental/client-ui-cot-translation/tests/mount.client.spec.ts
- Purpose: 414-line spec for the mount, the metadata refresh and the withdrawal path.
- Key abstractions: a fake `Remote` service whose `$on` asserts the event name is one of the six allowed; a `stubConfigForm` scope.
- Data flow: mounts the plugin, reads the injected body face, calls `body.translate(...)`.
- Non-obvious design decisions: (1) the metadata-refresh test proves the *stale-guard*: while a refresh is in flight, a translation is not sent, and after the refresh lands a request with the old provider or an over-limit text is refused with 'changed'; only a request matching the *new* accepted state goes through. (2) the withdrawal test asserts that a late resolve *and* a late reject are both excluded, that the query signal is aborted, that the slot entries are gone, and that the Remote is unmounted exactly once.
- Edge cases / failure handling: a `limits()` failure at mount rejects the mount and the Remote is unmounted.
- Surprising: the last test iterates over all six refresh events and asserts the provider list updates for each — the event list is a contract, not a convenience.

### packages/experimental/client-ui-cot-translation/tests/controller.host.spec.ts
- Purpose: 203-line spec for the Host controller.
- Key abstractions: a `fixture()` providing a fake `translator`, `settings` and `sessionController`.
- Data flow: `controller.limits(signal)` and `controller.translate(request, signal)`.
- Non-obvious design decisions: (1) `limits()` must **not** translate anything (`expect(b.translate).not.toHaveBeenCalled()`); (2) the inactive-session retry is pinned as *exactly one* retry — `expect(b.resolveAgent).toHaveBeenCalledExactlyOnceWith(scoped.sessionId)` and `expect(b.translate).toHaveBeenCalledTimes(2)`; a second inactive failure produces `cotTranslation/failed`; (3) the *successful* retry sends the **same** arguments as the first attempt (`expect(b.translate.mock.calls[0]).toEqual(b.translate.mock.calls[1])`); (4) a cancelled `availableProviders()` catalogue must reject with the caller's *exact* reason object (`rejects.toBe(reason)`), not a wrapped one.
- Edge cases / failure handling: a `TranslationError` with a different code is not treated as an activation case; the sanitising catch turns it into the opaque remote error.
- Surprising: the spec asserts the controller configures the settings service with `{auto:false}` — the translation feature must not participate in automatic settings.

### packages/experimental/client-ui-cot-translation/tests/activation.host.spec.ts
- Purpose: 159-line spec that translation joins the GUI's ordinary Agent ownership without creating a model turn.
- Key abstractions: a `ReadOnlySessionQuery` subclass that *throws* on full-text search; a real JSONL session persistence with a real stored session.
- Data flow: a saved Session is opened read-only; a translation is attempted against it.
- Non-obvious design decisions: the test asserts `expect(resume).not.toHaveBeenCalled()`, `expect(stream).not.toHaveBeenCalled()` and `expect(b.requests).toEqual([])` — a translation failure on an inactive subagent Session must not resume the agent, must not call the model, and must not send the text to the provider. It also asserts the stored events are unchanged (`expect((await saved.read()).events).toEqual(b.original)`).
- Edge cases / failure handling: the failure surfaces as `RemoteError` with `code: 'cotTranslation/failed'`, `message: 'Translation failed'` and `details: {}` — empty details, as designed.
- Surprising: `expect(open.mock.calls.every(([, access]) => access === 'read')).toBe(true)` — the activation path may only ever open the session for reading.

### packages/experimental/client-ui-cot-translation/tests/preferences-form.client.spec.tsx
- Purpose: 157-line jsdom spec for the staged preferences form.
- Key abstractions: `stubConfigForm<CotTranslationPreferences>()`.
- Data flow: edits the fields, clicks Save, asserts `scope.mutate` was called with the exact op list and revision.
- Non-obvious design decisions: (1) a malformed language code ("invalid code!") makes the Save button disabled and `scope.mutate` is **not** called; (2) Save writes both fields atomically as one op array with the scope's revision (`{op:'set',path:['provider'],value:'google'}, {op:'set',path:['targetLanguage'],value:'zh-Hant'}`, revision 7); (3) the *reset* button restores the field to the base value without saving; (4) the test asserts the two dictionaries have the same key set (`expect(Object.keys(en)).toEqual(Object.keys(zh))`).
- Edge cases / failure handling: a provider that is configured but not available is shown as an unavailable option and is **not** silently replaced by the first available one.
- Surprising: the test uses the *English* dictionary as the source of truth for the key set even though the plugin's `locales.ts` uses English as the source too — consistent here, unlike the Team plugin.

### packages/experimental/client-ui-cot-translation/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-client-ui-cot-translation`.
- Key abstractions: `exports` with `.`, `./client`, `./remote`, `./typert`, `./types`; a `dsh.client` block with five injected browser packages.
- Key abstractions (2): `peerDependencies` includes `@deepseek-ai/dsh-experimental-translator` — the translator is a host service, not a copy.
- Data flow: `files` ships `lib/index.js`, `lib/client.js`, `lib/typert.host.js`, `lib/typert.remote-client.js` and the types.
- Non-obvious design decisions: this is the only client package that ships **both** a host and a browser artefact from one manifest, because the plugin owns the Host controller *and* the browser UI for it.
- Edge cases / failure handling: n/a.
- Surprising: `zod` is a real dependency and `schemastery` is too — the Host config uses schemastery while the shared types use zod.

### packages/experimental/client-ui-cot-translation/tsconfig.json
- Purpose: 11-line solution-style project referencing a host and a client project.
- Key abstractions: `files: []` + two references.
- Data flow: build graph.
- Non-obvious design decisions: the two-project split (`tsconfig.host.json` and `tsconfig.client.json`) lets the *same* source tree be compiled twice — once for the Node host (with `tsconfig.base.json`) and once for the browser (with `tsconfig.base.client.json`) — while the shared `src/preferences.ts` and `src/types.ts` are in *both* projects. That is how one validator serves two doors.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/tsconfig.host.json
- Purpose: 36-line host-side project (files: `src/index.ts`, `src/preferences.ts`, `src/types.ts`).
- Key abstractions: `tsBuildInfoFile: lib/tsconfig.host.tsbuildinfo`.
- Data flow: build graph.
- Non-obvious design decisions: only three files are in the host project — the browser sources are excluded entirely, so the Host build cannot accidentally pull in React.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/tsconfig.client.json
- Purpose: 55-line browser-side project (includes `src/client`, `src/preferences.ts`, `src/css-modules.d.ts`, `src/types.ts`).
- Key abstractions: `tsBuildInfoFile: lib/tsconfig.client.tsbuildinfo`.
- Data flow: build graph.
- Non-obvious design decisions: the client project deliberately **excludes** `src/index.ts` (the Host controller) so the browser bundle cannot import the translator service.
- Edge cases / failure handling: n/a.
- Surprising: `src/preferences.ts` and `src/types.ts` are in both projects, and each project has its own `tsbuildinfo` so the two builds do not thrash each other.

### packages/experimental/client-ui-cot-translation/tsdown.config.ts
- Purpose: 3-line client bundle config with `hostPhase: true`.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })`.
- Data flow: build only.
- Non-obvious design decisions: the `hostPhase` option tells the shared bundler that this package *also* has a host half which must be built in the same pass.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/src/css-modules.d.ts
- Purpose: 5-line ambient declaration for `*.module.css`.
- Key abstractions: `Record<string,string>` class map.
- Data flow: type-only.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/locale/en.json
- Purpose: English plugin metadata "Machine translation of reasoning".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description ends with a period and states the effect plainly: "Display expanded reasoning in another language using machine translation."
- Edge cases / failure handling: n/a.
- Surprising: the *bundle's* locale file (a different package) adds "; source text is sent to the selected service" — the privacy note lives in the bundle's metadata, not the plugin's.

### packages/experimental/client-ui-cot-translation/locale/zh.json
- Purpose: Chinese plugin metadata "思考过程机器翻译".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge_cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/README.md
- Purpose: package reference for the reasoning-translation plugin.
- Key abstractions: the "View original / View translation" toggle; the paragraph-translation rule.
- Data flow: n/a.
- Non-obvious design decisions: the doc is explicit about *who owns what*: "The browser binds each request to the disclosure's Session. The Host requires the accepted provider and any explicitly configured target language … The authenticated Client supplies source text and Session identity, and **the Host does not verify that the source text belongs to that Session**." That limitation is stated, not hidden.
- Edge cases / failure handling: known limits: "requests never fall back to another provider"; "An inactive subagent Session without a saved translation retains the original text and reports a translation failure; ordinary Session activation cannot restore subagent ownership"; collapsed previews stay original.
- Surprising: the Model Experience section is careful: the translation records do not replace model input, and "Normal activation may append context or repair an interrupted turn, with the same cache effects as opening the conversation."

### packages/experimental/client-ui-cot-translation/README.zh.md
- Purpose: Chinese mirror of the reasoning-translation reference.
- Key abstractions: same structure.
- Data flow: n/a.
- Non-obvious design decisions: it preserves the same caveat about the Host not verifying the source text's session membership.
- Edge cases / failure handling: same limitations.
- Surprising: n/a.

### packages/experimental/client-ui-cot-translation/README.i18n.yaml
- Purpose: bilingual hash record (11 pairs) for the translation plugin README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/src/client/audio.ts
- Purpose: browser-side microphone capture, Web Audio resampling and WAV encoding.
- Key abstractions: `RecordingError` with a closed `kind` union (`unavailable|permission|empty|cancelled|interrupted|deviceMissing`); `encodeWave(samples)`; `audioBase64(bytes)`; the `Recording` class.
- Data flow: `preview()` acquires a MediaStream without recording; `start()` records via `MediaRecorder`, then an `OfflineAudioContext` decodes and resamples to 16 kHz mono; `stop()` flushes the final chunk, encodes WAV and base64s it.
- Non-obvious design decisions: (1) `encodeWave` writes the canonical 44-byte header by hand and clamps each sample to [-1, 1] before the asymmetric 32768/32767 conversion — the *Host* validates the same format, so there is exactly one writer and one validator; (2) base64 is produced in **8192-byte chunks** through `String.fromCharCode(...subarray)` to avoid a call-stack overflow on a large recording; (3) a permission grant that arrives **after** cancellation is released immediately — `if (this.lifetime.signal.aborted) { stream.getTracks().forEach(t => t.stop()); throw new RecordingError('cancelled') }`; (4) `dispose()` is idempotent and returns the *same* promise; the release path stops the recorder, stops the tracks, closes the `AudioContext` and calls `onDispose` in a `finally`, so the plugin's ownership ends only when the context close settles.
- Edge cases / failure handling: `getUserMedia` rejections are mapped by DOMException name — `NotAllowedError` → `permission`, `NotFoundError`/`OverconstrainedError` → `deviceMissing` — and anything else is rethrown unchanged.
- Surprising: `RecordingError`'s `message` *is* its kind, so the UI can localise it by switching on `error.kind` and the log line is still readable.

### packages/experimental/client-ui-voice-input/src/client/readiness.ts
- Purpose: one shared, reconnecting mirror of the Host's speech readiness.
- Key abstractions: `SpeechReadiness {catalog, connected, error}`; `observeReadiness(ctx)`.
- Data flow: `ctx.remote.$stream({name:'Speech readiness', open: signal => ctx.remote.speech.follow(signal), ended: …, carrierFailed: …})` is iterated and each item is published to a snapshot store, then `item.accept()`ed.
- Key abstractions (2): the stream is created with an explicit `ended` handler that returns a `RemoteStreamCarrierError` — a stream that ends is a *failure*, not a quiet end.
- Non-obvious design decisions: (1) there is **one subscription per Client plugin**, not per rendered page or Session — "independent of rendered pages and Sessions"; (2) a transport failure sets `connected: false` and an error but **never rewrites the Host readiness** — the catalog and the transport state are separate fields; (3) `dispose()` sets a `disposed` flag *before* awaiting the stream, so a rejection that arrives during disposal is not reported as a Host failure.
- Edge cases / failure handling: `catch (error) { if (!isDisposed()) fail(error) }`.
- Surprising: the `accept()` call is explicit per item — the carrier requires the consumer to acknowledge each snapshot, which is what makes a reconnect re-deliver the current state.

### packages/experimental/client-ui-voice-input/src/client/microphone-device.ts
- Purpose: the browser-local microphone preference.
- Key abstractions: `MicrophoneDevice {id, label}`; `createMicrophoneDeviceStore()`.
- Data flow: a `SnapshotStore` persisted under the name `dsh.voice-input.microphone`.
- Non-obvious design decisions: the persisted value is **validated on read** — a malformed or partial object is replaced with `{id:'', label:''}` rather than trusted, so a corrupted localStorage entry cannot make the app request a nonexistent device; an empty id means "follow the system input".
- Edge cases / failure handling: the label is stored *without* a localised placeholder, so a locale change does not leave a stale translated name in the selector.
- Surprising: this preference lives entirely in the browser and is **independent of the Host's recognition settings** — the Host never learns which microphone was chosen.

### packages/experimental/client-ui-voice-input/src/client/VoiceInput.tsx
- Purpose: the composer's microphone button and the expanded capture row.
- Key abstractions: `VoiceInputActions` (the Host calls injected without exposing a Context); `VoiceInputInjected`; `Phase = 'idle'|'requesting'|'recording'|'transcribing'|'feedback'`; `ActiveRecording`.
- Data flow: click → `createRecording()` → `start()` → the recording owns an `AbortController` and a `TokenSpan` → `stop()` → `transcribe({audioBase64, providerId, language}, signal)` → the transcript is offered for insertion into the draft.
- Non-obvious design decisions: (1) the transcript is **never auto-sent** — it is offered with an explicit Insert action, and a changed draft keeps the transcript for explicit insertion or discard; (2) the editor selection carries a **draft revision** (`captureInsertion()` returns `{start, end, draftRev}`), so a transcript computed against an older draft can be detected; (3) the recording's `AbortController` and `TokenSpan` are per-attempt, so a session change, a hidden page or plugin disposal invalidates a late result; (4) a capture failure ends the recording UI immediately and offers a retry *inside the toolbar*; (5) the phase machine has an explicit `feedback` state where the pending transcript lives.
- Edge cases / failure handling: `disposeRecording()` swallows a close failure — "Tracks stop before `AudioContext.close()`; a close failure must not hide the recording result."
- Surprising: the whole feature produces text in the *draft* and never a Session event — the model sees it only when the user submits, so the KV cache is untouched by the recording itself.

### packages/experimental/client-ui-voice-input/src/client/PreparationCard.tsx
- Purpose: the provider-preparation card in the Plugins page (progress, steps, download source, preferences).
- Key abstractions: `preparationTone(state)` mapping a preparation phase to a `StateDotState`; `byteText`; `DownloadProgress`; `PreparationFailure`.
- Data flow: the card reads the provider's `preparation` state from the shared readiness mirror and calls `prepare` / `cancelPreparation` / `configure`.
- Non-obvious design decisions: (1) the summary is **collapsed by default** and expands to all steps; (2) the download progress is shown from *measured bytes* (`completedBytes`/`totalBytes`), with a `downloadUnknown` variant when the total is not known; (3) a download failure is decomposed into a **typed reason** (`download.network`, `download.dns`, `download.timeout`, `download.certificate`, `download.http`, `download.integrity`, `download.storage`, `download.unknown`) with a matching advice key and the source and code shown as metrics; (4) the model-download-source selector is disabled while preparing and hidden once the resources are ready.
- Edge cases / failure handling: the source choice is retained for retries in the current card without changing deployment configuration; the provider/language selects are disabled when the readiness mirror is disconnected.
- Surprising: the failure advice is addressed to the person running the *host* machine, not the browser: "Please check whether the machine running DSH can reach the download source and its model download service; if a proxy is needed, configure it on that machine and retry."

### packages/experimental/client-ui-voice-input/src/client/MicrophonePicker.tsx
- Purpose: the input-device selector with a live level meter.
- Key abstractions: `InputLevel` (an 8-bar dB meter driven by `requestAnimationFrame`); a `DeviceChoice` with an `unavailable` flag.
- Data flow: `enumerateDevices()` → options; a `Recording.preview()` on the selected device → the live level; a `devicechange` event → re-enumeration.
- Non-obvious design decisions: (1) the level meter is computed in dB (`20*log10(amplitude)`) and mapped to a 0..1 bar count over a 60 dB window; (2) the enumeration result is **guarded by an enumeration counter** so a slow `enumerateDevices` cannot overwrite a newer one; (3) a device that disappears keeps its **name and position** as a disabled "Unavailable" option, and the preview is released; (4) an explicitly selected device never silently falls back to another input — the choice is preserved as a disabled option.
- Edge cases / failure handling: an interruption releases the capture, clears the preview, shows the error and re-enumerates; a late permission grant is released by the `Recording` itself.
- Surprising: the browser's default device label is *not* persisted — `selectMicrophone({id:'', label:''})` for the system default — so the selector never shows a stale device name for "system default" (a spec asserts exactly this).

### packages/experimental/client-ui-voice-input/src/client/Waveform.tsx
- Purpose: the live waveform during a recording.
- Key abstractions: 80 SVG `<line>` elements; a `requestAnimationFrame` loop.
- Data flow: `recording.amplitude()` is sampled at most every 50 ms and the bars are updated by writing `y1`/`y2` attributes directly.
- Non-obvious design decisions: the geometry is updated **without React state** — "animation updates SVG geometry without React state churn" — and the 50 ms throttle keeps the amplitude sampler from running at display rate; the bars shift by one position each sample (`bar.level = next; next = previousLevel`).
- Edge cases / failure handling: when the recording is undefined the amplitude is 0, so the waveform collapses to its dotted baseline rather than freezing.
- Surprising: the initial bars are rendered with `opacity: 0.25 + index/120`, so the baseline already looks like a decaying waveform before any audio arrives.

### packages/experimental/client-ui-voice-input/src/client/VoiceSetupDialog.tsx
- Purpose: the shared modal for voice activation and unavailability.
- Key abstractions: `VoiceSetupDialogProps` picking `onDismiss`/`onOpenDetails` from the `plugins.bundle.activation` slot runtime.
- Data flow: n/a.
- Non-obvious design decisions: the dialog is **navigation only** — "a dismissible prompt that never starts preparation or recording" — and it carries `data-modal-autofocus` on the primary action so focus moves to it.
- Edge cases / failure handling: the title and body switch on `needsInstallation`; Escape or "Later" dismisses.
- Surprising: the same modal serves both "you need to install a model" and "recognition is not ready" — one component, two messages.

### packages/experimental/client-ui-voice-input/src/client/VoiceSetupPrompt.tsx
- Purpose: the activation-time guidance shown after the Host inspects local recognition resources.
- Key abstractions: `VoiceSetupPromptProps` picking `useSpeechReadiness` from the injected face.
- Data flow: reads the readiness mirror, finds the selected provider, and shows the dialog only when `phase === 'unprepared' && location === 'host-local'`.
- Non-obvious design decisions: the prompt **auto-dismisses** as soon as the phase is known and is not 'unprepared' — including for a `cloud` provider, so a cloud provider is never described as a local model installation; the `checking` phase shows nothing.
- Edge cases / failure handling: the effect watches `[phase, needsSetup, onDismiss]` and dismisses when the resources become ready.
- Surprising: the location check (`host-local`) is what stops the prompt from appearing for cloud recognisers.

### packages/experimental/client-ui-voice-input/src/client/mount.ts
- Purpose: the browser-side lifecycle for the speech Remote and its three slots.
- Key abstractions: `inject = ['remote','slots','locale','pluginNavigation']`; a `Set<Recording>` owned by the plugin.
- Data flow: `registerUi` registers the locale, creates the readiness mirror and the microphone store, and injects `VoiceInput` into `conversation.input.activity`, `VoicePreparation` into `plugins.bundle.config` and `VoiceSetupPrompt` into `plugins.bundle.activation`.
- Non-obvious design decisions: (1) the plugin **owns every Recording it creates** and disposes them all on unload; (2) `openSettings` navigates to the bundle by name (`ctx.pluginNavigation.openBundle('@deepseek-ai/dsh-experimental-voice-input-bundle')`); (3) each Remote call unwraps the `RemoteResult` and throws `result.error` so the UI never has to know the result envelope.
- Edge cases / failure handling: the `ctx.effect` cleanup awaits every recording's disposal before the plugin's Remote is unmounted.
- Surprising: the three slots share **one** injected face, so the composer, the settings card and the activation prompt all see the same readiness and the same microphone choice.

### packages/experimental/client-ui-voice-input/src/client/failure-text.ts
- Purpose: localises capture and transcription failures.
- Key abstractions: `failureText(failure, t)`.
- Data flow: n/a.
- Non-obvious design decisions: a `RecordingError` is translated by *its kind* (`t(failure.kind)`) — the kind is the locale key — while any other error is interpolated as `t('failed', {message})`.
- Edge cases / failure handling: a non-Error rejection is stringified.
- Surprising: 15 lines that make the error taxonomy a locale namespace rather than a switch statement in each component.

### packages/experimental/client-ui-voice-input/src/client/locales.ts
- Purpose: the English and Chinese copy for every voice control.
- Key abstractions: `NS = 'voice-input'`; `zh` as the key source, `en` checked against it.
- Data flow: n/a.
- Non-obvious design decisions: the dictionary is unusually large (200+ lines) because it covers the *whole* preparation lifecycle, including a per-reason download-failure family and a per-reason advice family; the advice is written for the **host machine operator** ("请检查运行 DSH 的机器的 DNS 和代理设置"), which is the person who can actually fix a download.
- Edge cases / failure handling: the `download.*` / `downloadAdvice.*` key families are keyed by the provider's own failure `reason`, so a new provider reason needs a new key pair or the UI shows a raw reason string.
- Surprising: the copy also contains the *local vs cloud* disclosure ("Audio will be sent to the selected cloud service") and the "no speech recognized" empty case.

### packages/experimental/client-ui-voice-input/src/client/index.ts
- Purpose: the browser entry for the voice-input plugin.
- Key abstractions: `apply(ctx)` → `mountVoiceInput(ctx, speechRemote)`.
- Data flow: n/a.
- Non-obvious design decisions: it imports the *generated* `speechRemote` contribution from `@deepseek-ai/dsh-experimental-api-speech-to-text/remote` — the browser never talks to the speech service directly.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/src/index.ts
- Purpose: the inert Host marker for the voice-input contribution.
- Key abstractions: `export function apply(): void {}`.
- Data flow: n/a.
- Non-obvious design decisions: same inert-host pattern.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/src/client/VoiceInput.module.css
- Purpose: the voice UI stylesheet.
- Key abstractions: `.trigger`, `.captureRow`, `.roundButton`, `.waveform`, `.activityMessage`, `.preparation*`, `.steps`, `.inputLevel`.
- Data flow: n/a.
- Non-obvious design decisions: the waveform is `flex: 1; width: 0; min-width: 24px` so it *shrinks* rather than pushing the recording buttons off the row — "The waveform stays shorter than the recording buttons" is a layout invariant; the device meter is absolutely positioned inside the select's right padding (`padding-right: 72px` when a meter is present) so the native select's arrow is not covered; a `@media (max-width: 480px)` rule collapses the settings grid to one column and moves the error message into column 1.
- Edge cases / failure handling: `.preparationActions:empty { display: none }` — an empty action row does not leave a gap.
- Surprising: the step list uses `data-step-state` (`pending|running|complete|failed|cancelled`) on the `<li>`, so the state is queryable from tests and CSS alike.

### packages/experimental/client-ui-voice-input/tests/audio.client.spec.ts
- Purpose: 194-line spec for the recording pipeline.
- Key abstractions: `captureFixture()` (in `audio-fixture.client.ts`) providing a fake `MediaRecorder`, `AudioContext`, `OfflineAudioContext` and `navigator.mediaDevices`.
- Data flow: builds real recordings through the real `Recording` class.
- Non-obvious design decisions: (1) the encoder is checked byte-for-byte — the header fields (`16000` sample rate, `10` data bytes) and the five decoded PCM16 values including the asymmetric `-32768`/`32767` extremes; (2) base64 is checked *round-trip* for a 17000-sample buffer, which is larger than one 8192-byte chunk, proving the chunked encoder; (3) "releases a microphone granted after cancellation" — the grant resolves *after* `dispose()`, and the spec asserts the track was stopped exactly once; (4) "discards decoding results that finish after cancellation".
- Edge cases / failure handling: the `failRecorder` path (the MediaRecorder raising `onerror`) and the `constructError` path (the constructor throwing) must both release the track and close the context.
- Surprising: the spec asserts `expect(b.offline).toHaveBeenCalledWith(1, 16000, 16000)` — the resampling is pinned to 16 kHz mono, matching the Host's WAV contract.

### packages/experimental/client-ui-voice-input/tests/audio-fixture.client.ts
- Purpose: the shared fake audio devices.
- Key abstractions: a `Recorder` class whose `stop()` queues the final `dataavailable` events; a fake `AudioContext` whose analyser always reports 0.25.
- Data flow: `captureFixture(options)` stubs `navigator`, `MediaRecorder`, `AudioContext` and `OfflineAudioContext`.
- Non-obvious design decisions: the fixture distinguishes `empty` (no data chunk), `recorderError` (an `onerror` after the chunk) and `constructError` (the constructor throws) — the three ways a capture can fail; the `offline` context's `startRendering` returns a fixed 2-sample buffer.
- Edge cases / failure handling: `failRecorder()` is exposed so a test can fire the error at a chosen moment.
- Surprising: it is a `.ts` fixture (not `.mjs`) so it can share types with the source.

### packages/experimental/client-ui-voice-input/tests/readiness.client.spec.ts
- Purpose: 61-line spec for the shared readiness mirror.
- Key abstractions: only the Gateway transport is replaced; "the readiness publication remains real".
- Data flow: `observeReadiness(ctx)` against a fake `remote` with a hand-written async iterator.
- Non-obvious design decisions: the spec pins the *separation* of concerns: a Host snapshot sets `connected: true, error: null`; a `carrierFailed` sets `connected: false` with the message but leaves the catalog; a terminal stream failure is reported; and a failure that arrives **after** `dispose()` is *not* published as a Host failure (`expect(b.mirror.state.getSnapshot().error).toBeNull()`).
- Edge cases / failure handling: the `ended(true)` handler must return a `RemoteStreamCarrierError` — the spec asserts the type, because a quiet end would leave the UI showing stale readiness.
- Surprising: the fixture asserts `expect(b.accept).toHaveBeenCalledOnce()` — the mirror acknowledges every snapshot.

### packages/experimental/client-ui-voice-input/tests/waveform.client.spec.tsx
- Purpose: 26-line jsdom spec for the waveform.
- Key abstractions: a stubbed `requestAnimationFrame` that captures the callback.
- Data flow: renders `<Waveform recording={recording} label="Recording" />` and drives frames by hand.
- Non-obvious design decisions: the 50 ms throttle is pinned numerically — a frame at t=0 samples the amplitude once, a frame at t=20 does **not** sample, and a frame at t=50 does; and with the recording removed the bars return to their baseline (`y2 === '21'`).
- Edge cases / failure handling: the animation frame is cancelled on unmount (`expect(cancel).toHaveBeenCalledWith(7)`).
- Surprising: the spec uses a real `Recording` instance with only `amplitude` spied — the component's contract is the amplitude accessor, not the recording.

### packages/experimental/client-ui-voice-input/tests/setup-prompt.client.spec.tsx
- Purpose: 61-line jsdom spec for the activation prompt.
- Key abstractions: a `publish(preparation, location)` helper that pushes a new readiness snapshot.
- Data flow: renders `<VoiceSetupPrompt>` and drives the readiness store.
- Non-obvious design decisions: the prompt must **wait for inspection** — publishing `phase: 'checking'` shows nothing and does not dismiss; only `phase: 'unprepared'` opens the dialog; `standby`, `ready` and `failed` all dismiss it; and a `cloud` provider with `unprepared` **also** dismisses it ("does not describe cloud-provider setup as a local model installation").
- Edge cases / failure handling: "Later" dismisses without navigating; "Go to setup" calls `onOpenDetails` exactly once and does not dismiss.
- Surprising: the dismissal is driven by the *phase*, so a provider that becomes ready while the dialog is open closes it automatically.

### packages/experimental/client-ui-voice-input/tests/mount.client.spec.ts
- Purpose: 159-line spec for the plugin lifecycle.
- Key abstractions: a fake `Remote` service and a `captureFixture` for the microphone.
- Data flow: mounts the plugin, inspects the slot entries, disposes the fiber.
- Non-obvious design decisions: the disposal test asserts the **ordering**: the plugin's `dispose()` must not return until the `AudioContext.close()` promise settles (`expect(b.unmount).not.toHaveBeenCalled()` while the close is pending) — the Remote is unmounted *after* the captures are released.
- Edge cases / failure handling: a slot registration that throws during mount must leave nothing mounted.
- Surprising: the spec asserts the selected device is passed to `getUserMedia` as `deviceId: {exact:'usb'}` — the exact-match constraint, so a renamed device is not silently substituted.

### packages/experimental/client-ui-voice-input/tests/preparation.client.spec.tsx
- Purpose: 214-line jsdom spec for the preparation card.
- Key abstractions: a `steps` fixture with four completed steps and one running.
- Data flow: renders `<PreparationCard>` and `<VoicePreparation>` with a scripted `preparation` state.
- Non-obvious design decisions: (1) the summary is collapsed by default and the "elapsed" text is driven by a ticking `now` state; (2) the byte progress is asserted in *both* the collapsed summary and the expanded active step (`'638.0 / 936.0 MB，68%'`), and the `<progress>` element's `value`/`max` are the raw byte counts; (3) the download-source selector is disabled while preparing and disappears entirely once the resources are ready; (4) the card survives a remount — a second `fixture(...)` with the same state shows the same elapsed text, so the state is Host-owned rather than component-owned.
- Edge cases / failure handling: the source choice is retained across a re-render with new `downloadSources` and is disabled while a prepare is in flight.
- Surprising: the spec uses fake timers and `vi.setSystemTime` to pin the "elapsed N seconds" text, which is a *host*-computed duration, not a client timer.

### packages/experimental/client-ui-voice-input/tests/voice-input.client.spec.tsx
- Purpose: 384-line jsdom spec for the composer microphone.
- Key abstractions: a `fixture(recording?)` that builds a fake `inputActions` object with `captureInsertion()` returning `{start:3, end:3, draftRev:1}`.
- Data flow: clicks the microphone, stops, and asserts on `inputActions.insertText`.
- Non-obvious design decisions: (1) the transcript is **inserted, not submitted** — `expect(b.inputActions.insertText).toHaveBeenCalledOnce()` and no `submit`; (2) repeated capture/stop clicks are **coalesced** — two clicks produce one `start` and one `stop`; (3) after a device failure the recording UI ends *immediately* and the pending transcription is dropped (`expect(b.transcribe).not.toHaveBeenCalled()`) even after the max-duration timer fires; (4) interruption notifications arriving after `cancel`/`session change`/`unmount`/`finishing`/`finished` are ignored — five separate `it.each` cases.
- Edge cases / failure handling: a capture that reports failure *before* `start()` settles must not restore the recording UI; recording is allowed while verified local resources are `waking`; the setup dialog is suppressed when the readiness becomes ready or the session changes.
- Surprising: the "recording while waking" case encodes a product decision: a model that is loaded but waking is still usable, and the UI must not block on it.

### packages/experimental/client-ui-voice-input/tests/microphone-picker.client.spec.tsx
- Purpose: 466-line jsdom spec for the device picker.
- Key abstractions: a `selectUsb(b)` helper; `enumerateDevices` as a mock; a `devicechange` EventTarget.
- Data flow: changes the select, fires `devicechange`, asserts on the options and the acquisition counts.
- Non-obvious design decisions: (1) device **insertion and removal** refresh the options *without* re-acquiring the selected microphone (`expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)`) — the live preview is not disturbed by an unrelated change; (2) a **disconnected** selection keeps its name and position as a disabled "Unavailable" option, and the two orderings (track-ended first vs devicechange first) are both tested; (3) reconnecting while the page is active restores the preview; (4) choosing another input removes the unavailable option; (5) the system-default option never restores a stale device name.
- Edge cases / failure handling: permission denial keeps the other choices accessible; the level meter survives a field blur.
- Surprising: the spec asserts the exact `getUserMedia` constraint object `{audio:{echoCancellation:true, noiseSuppression:true, deviceId:{exact:'usb'}}, video:false}` — the constraint set is a contract.

### packages/experimental/client-ui-voice-input/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-client-ui-voice-input`.
- Key abstractions: a `dsh.client` block with eight injected browser packages and an `external` list containing `@deepseek-ai/dsh-api-gateway/client`.
- Data flow: `exports` ships `.`, `./src/*`, `./package.json`, `./locale/*.json`, `./client`.
- Non-obvious design decisions: `dependencies: {}` — the plugin has **no** runtime dependencies; everything is a devDependency, because the browser bundle inlines what it needs. The `external` entry marks the gateway client as an import the bundler must not inline, so the plugin and the host share one gateway instance.
- Edge cases / failure handling: n/a.
- Surprising: the `external` list is the browser-side twin of the "shared host runtime must be a singleton" rule the server-side runtime enforces with peer dependencies.

### packages/experimental/client-ui-voice-input/tsconfig.json
- Purpose: 60-line TS project extending `tsconfig.base.client.json`.
- Key abstractions: 16 references including `../api-speech-to-text`, `../speech-to-text`, `../../api/gateway/tsconfig.client.json` and `../../client/ui-plugin-manager`.
- Data flow: build graph.
- Non-obvious design decisions: the reference set is the plugin's whole reach: the Remote protocol, the speech service types, the gateway client (for `RemoteStreamCarrierError`) and the plugin manager (for `openBundle`).
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/tsdown.config.ts
- Purpose: 3-line client bundle config using the shared helper.
- Key abstractions: `clientBundle(import.meta.dirname, ['lib/types/index.js'])`.
- Data flow: build only.
- Non-obvious design decisions: identical recipe to the other browser plugins.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/src/css-modules.d.ts
- Purpose: 5-line ambient declaration for `*.module.css`.
- Key abstractions: `Record<string,string>` class map.
- Data flow: type-only.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/locale/en.json
- Purpose: English plugin metadata "Voice recording".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description says "Record speech and insert **editable** text into the conversation draft" — "editable" is the promise.
- Edge cases / failure handling: n/a.
- Surprising: the Chinese description is longer and says the text is filled into the draft "支持编辑后发送" (editable before sending), which the English omits.

### packages/experimental/client-ui-voice-input/locale/zh.json
- Purpose: Chinese plugin metadata "录音输入".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/README.md
- Purpose: package reference for voice input.
- Key abstractions: the microphone sits "between the model selector and Send"; the preparation/disk/memory/time estimate card.
- Data flow: n/a.
- Non-obvious design decisions: the README is very precise about *browser vs host* asymmetry — "'Local' means the Host machine, which can differ from the browser's machine" — and about the *device* lifecycle: "A disconnected selection retains its name and position as a disabled option with an Unavailable label", "an explicitly selected device never silently falls back to another input", "Interrupted recordings require an explicit restart."
- Edge cases / failure handling: the dialog moves focus to its navigation action and keeps Tab traversal inside; Later or Escape restores the previous focus "without changing or submitting the draft"; "Window blur during the microphone permission request does not cancel capture; blur during recording does."
- Surprising: the Known Limits section states "No automatic send, always-on microphone, wake word, streaming captions or speech synthesis" — the feature is deliberately narrow.

### packages/experimental/client-ui-voice-input/README.zh.md
- Purpose: Chinese mirror of the voice-input reference.
- Key abstractions: same structure.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version keeps the "等待麦克风授权时窗口失焦不会取消采集；录音期间失焦会取消" sentence — the blur asymmetry is stated identically in both languages because it is a behavioural rule.
- Edge cases / failure handling: same limitations.
- Surprising: n/a.

### packages/experimental/client-ui-voice-input/README.i18n.yaml
- Purpose: bilingual hash record (11 pairs) for the voice-input README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-mcp/src/index.ts
- Purpose: mounts an **installed** `cua-driver` executable as the exclusive computer-use provider.
- Key abstractions: `Config {command, args, toolCallTimeoutMs?, reconnect}`; the `ComputerUseProviderName('cua-driver-mcp')` registration.
- Data flow: `apply()` builds an `McpClient.Config({transport:'stdio', serverName:'cua-driver-mcp', command, args, failOnStartupError: true, reconnect})`, registers the provider, and mounts the MCP client as a **child plugin**.
- Non-obvious design decisions: (1) the reservation and the child are inside **one ordered effect**: "One effect orders child shutdown before release; separate fiber effects unload concurrently and could otherwise admit another live driver." The generator yields the registration, then mounts the child, then yields `child.dispose` — so the child is torn down *before* the registration is released; (2) the provider name is registered **before** the connection, so a second provider fails fast without ever starting a process; (3) `failOnStartupError: true` — a failed initial connection rejects the activation and rolls back.
- Edge cases / failure handling: the child is awaited (`await child.await()`) so activation does not resolve before discovery; a failed activation still disposes the child before the registration.
- Surprising: `apply` is `async` and returns after the *first* tool discovery — the tools are in the registry before the caller continues.

### packages/experimental/computer-use-cua-driver-mcp/README.md
- Purpose: package reference for the installed-driver provider.
- Key abstractions: the config table; the "Activation and ownership" section.
- Data flow: n/a.
- Non-obvious design decisions: the ownership contract is spelled out: "The provider registers as `cua-driver-mcp` before connecting. A second computer-use provider fails activation, including another instance of this package. Failed initialization or initial tool discovery rejects this entry and releases its registration after cleanup. Later disconnects retain the registration while the MCP client reconnects or exhausts its attempt budget; unload the entry to release it." The last clause is the important one: a *disconnect* does not free the provider.
- Edge cases / failure handling: known limits: "Sessions share one desktop. Run one computer-use workflow at a time or coordinate them externally; the registration does not serialize Session actions."
- Surprising: the doc gives the exact command to verify an installed driver, including the macOS `--direct` variant and the `DSH_COMPUTER_USE_MCP_ARGS` JSON-array contract.

### packages/experimental/computer-use-cua-driver-mcp/README.zh.md
- Purpose: Chinese mirror of the installed-driver reference.
- Key abstractions: same config table and ownership contract.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese "已知限制" section keeps the "注册不会串行化 Session 的操作" caveat — the provider reserves the *provider*, not the desktop.
- Edge cases / failure handling: same limitations.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-mcp/README.i18n.yaml
- Purpose: bilingual hash record (15 pairs) for the installed-driver README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-mcp/locale/en.json
- Purpose: English plugin metadata "Computer Use (Cua Driver MCP)".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description says "through a **separately installed** cua-driver executable" — the plugin does not ship the driver.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-mcp/locale/zh.json
- Purpose: Chinese plugin metadata "电脑操作（Cua Driver MCP）".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-mcp/tests/lifecycle.spec.ts
- Purpose: 124-line spec that replaces the MCP client with barriers to pin the *disposal ordering*.
- Key abstractions: a hoisted `fake` with `start`/`close` promises; the `dsh-mcp-client` module mocked so `apply` is a no-op that records the config.
- Data flow: `ctx.plugin(Provider, {})` then `first.dispose()` with the child's close held open.
- Non-obvious design decisions: the first case asserts the *exact* resolved MCP config (`toolCallTimeoutMs: 60_000`, `reconnect: {enabled:true, initialDelayMs:500, maxDelayMs:30_000, maxAttempts:10}`) — the defaults are part of the contract. The second case holds the child's close open and asserts that `ctx.computerUse.providerName` is **still** `cua-driver-mcp` and that a second provider still fails — the reservation is held through the teardown. The third case proves a failed activation rolls back only *after* the child closes.
- Edge cases / failure handling: the fourth case asserts invalid configs (`command: ''`, `command: '  '`, `toolCallTimeoutMs: 0`, `reconnect.maxAttempts: 0`) are rejected *before* any driver is acquired (`expect(fake.start).not.toHaveBeenCalled()`).
- Surprising: the mock intercepts `apply` rather than the client internals, so the test is about the provider's lifecycle, not the transport.

### packages/experimental/computer-use-cua-driver-mcp/tests/composition.spec.ts
- Purpose: 196-line spec with a real stdio child and a scripted model, driven through the real Loader.
- Key abstractions: a `ScreenshotModel` `LlmAdapter` that calls the screenshot tool on its first request; a `driverEvents(root)` reader over the fixture's ndjson log.
- Data flow: writes a `cordis.yml`, loads the real modules, creates a Session, and lets the model call `mcp__cua-driver-mcp__screenshot`.
- Non-obvious design decisions: the fixture driver's `server/discover` **fails** with `-32601 Method not found` — the test exercises the client's legacy-probe fallback on every run; the `fail` mode makes the driver exit during `initialize` so the failure path can be tested against a real process.
- Edge cases / failure handling: the failure case asserts the Loader entry's fiber is `FAILED`, the rejection message is 'initial connection or tool synchronization failed', the provider name is released, the tool is gone, and **every** started driver process has exited (`expectProcessExited(event.pid)`).
- Surprising: the fixture writes an ndjson event log with the process pid, so the test can assert on process lifecycle rather than on mocks.

### packages/experimental/computer-use-cua-driver-mcp/tests/fixtures/driver.mjs
- Purpose: an external stdio MCP server that "never reads or controls the host desktop".
- Key abstractions: `screenshot` and `disconnect` tools; a 1×1 PNG constant.
- Data flow: JSON-RPC over stdio; every event appended to `driver.ndjson`.
- Non-obvious design decisions: the `disconnect` tool exits the process *after* the reply is flushed (`process.stdout.write(..., () => process.exit(0))`) — a graceful self-disconnect, which is the hardest case for a client to handle.
- Edge cases / failure handling: `mode === 'fail'` exits during `initialize`; the `disconnect` result is plain text.
- Surprising: the fixture answers `server/discover` with an error, so the client must fall back to `initialize` — the fixture is deliberately hostile to a lazy client.

### packages/experimental/computer-use-cua-driver-mcp/tests/installed-driver.e2e.ts
- Purpose: 69-line opt-in compatibility check against a real installed driver.
- Key abstractions: `driverArguments()` parses `DSH_COMPUTER_USE_MCP_ARGS` as a JSON array of strings and throws otherwise.
- Data flow: mounts the provider against the real executable, then calls `mcp__cua-driver-mcp__check_permissions` with `{prompt: false}`.
- Non-obvious design decisions: the check is deliberately passive — `prompt: false` — so the test never triggers an OS permission dialog; the executable path must be **absolute** (`isAbsolute(executable)` is asserted, with an explicit error message), so a PATH resolution surprise cannot be mistaken for a driver bug.
- Edge cases / failure handling: after disposal the test asserts the tool schemas are empty and the provider name is released; the canonical result is checked for `content` being an array and `structuredContent` being a non-null object.
- Surprising: the test asserts `result.content.every(block => block.type === 'text')` — the permission check returns text, not an image, and the test proves the image path was not taken.

### packages/experimental/computer-use-cua-driver-mcp/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`.
- Key abstractions: `dependencies: {schemastery, dsh-mcp-client}`; `peerDependencies: {cordis, dsh-computer-use}`.
- Data flow: `files` ships `locale/*.json`, `lib/index.js`, `lib/types/**`.
- Non-obvious design decisions: the *driver itself* is not a dependency — the user installs it out of band, which is the whole premise of this package.
- Edge cases / failure handling: n/a.
- Surprising: the dev dependency list is again the full integration set (agent-loop, attachment-local, session-projection, llm, tools).

### packages/experimental/computer-use-cua-driver-mcp/tsconfig.json
- Purpose: 14-line compact TS project.
- Key abstractions: references to `vendor/cordis`, `vendor/schemastery`, `../../computer-use/computer-use`, `../../mcp/mcp-client`.
- Data flow: build graph.
- Non-obvious design decisions: the file uses the compact one-line-per-reference style, matching the newer packages.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-native/src/index.ts
- Purpose: the **in-process** Cua Driver provider — the native npm SDK, no separate CLI.
- Key abstractions: `ToolCatalog` (a zod schema for the SDK's JSON catalogue); `TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u`; the `GUIDANCE` system-prompt text; `mountRuntime`.
- Data flow: `CuaDriver.create(undefined)` → `listToolsJson({signal})` → parse → for each tool register `cua_driver_native__<name>` via `createMcpToolDefinition` → a call does `activeDriver.callTool(tool.name, JSON.stringify(args), {signal})` → `JSON.parse(result.rawJson)`.
- Non-obvious design decisions: (1) the provider **reserves computer use before importing the native code** — "The provider reserves the shared computer-use registration before loading native code"; (2) the catalogue is validated *before any tool is registered*: JSON parse → zod → a duplicate name is an error → a name that does not fit the function-name alphabet is an error ("exceeds the supported function-name format"); (3) every call's signal is `AbortSignal.any([execution.signal, lifetime.signal])`, so unloading the provider cancels in-flight native calls; (4) the teardown is `await driver.shutdown()` **then** `driver.uniffiDestroy()`, and a failed shutdown **retains the registration** (fail-closed: no other driver may be admitted while native state is unknown); (5) the child plugin owns the *tools* and the *guidance*, while the parent effect owns the *native handle* — so the registration is held until the child has removed its tools and the native runtime has shut down.
- Edge cases / failure handling: the disposal path awaits `ready.catch(() => {})` (the startup failure is reported by `apply`, but the teardown still owns the native handle) and `Promise.allSettled(pending)`; `lifetime.abort()` fires on the `internal/plugin` event where `fiber.uid === null`, because "Cordis announces disposal before it awaits asynchronous plugin startup."
- Surprising: the `GUIDANCE` text encodes real operational knowledge — "A new snapshot of that window invalidates its earlier element tokens", "a delivered click alone does not prove the outcome", "A refusal does not authorize a foreground retry", "On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work."

### packages/experimental/computer-use-cua-driver-native/README.md
- Purpose: package reference for the in-process driver.
- Key abstractions: the host-requirements section; the "Verify the installed SDK" command.
- Data flow: n/a.
- Non-obvious design decisions: the "Host requirements" section is candid about the trade-off between the two Cua providers: "The native runtime shares the host process, so native crashes can terminate that process. Use the installed MCP provider when the separate Cua Driver application should own permissions and execution." And the verification command clears `NODE_USE_ENV_PROXY` "prevents Node from installing the launching shell's proxy before test setup" — a real, specific failure they hit.
- Edge cases / failure handling: known limits: "**Failed shutdown** — if native shutdown fails, the registration remains occupied. Restart the host before mounting another computer-use provider."
- Surprising: the Model Experience section publishes the guidance text *in full* as a fenced markdown block, so the exact system-prompt bytes are reviewable.

### packages/experimental/computer-use-cua-driver-native/README.zh.md
- Purpose: Chinese mirror of the in-process driver reference.
- Key abstractions: the same guidance block, reproduced in Chinese.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version reproduces the guidance text inside a fenced block too, including the macOS `facility_unavailable` sentence — the *content* is identical, only the surrounding prose is translated.
- Edge cases / failure handling: same limitations.
- Surprising: the Chinese "已知限制" section keeps the "注册名额保持占用" (registration stays occupied) phrasing for a failed shutdown.

### packages/experimental/computer-use-cua-driver-native/README.i18n.yaml
- Purpose: bilingual hash record (20 pairs) for the in-process driver README.
- Key abstractions: anchor → hashes, including the nested `…/native-cua-driver-guidance` anchor under `what-the-model-sees`.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: the anchor tree records that the guidance is a *named* subsection of "What the model sees", not prose — the exact prompt is a reviewable artefact with its own hash.
- Edge cases / failure handling: n/a.
- Surprising: 20 anchors is the largest in the shard — this package has the most detailed Model-Experience documentation.

### packages/experimental/computer-use-cua-driver-native/locale/en.json
- Purpose: English plugin metadata "Computer Use (Cua Driver)".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description names the permission requirement up front: "needs desktop permissions for the app that launches dsh".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-native/locale/zh.json
- Purpose: Chinese plugin metadata "电脑操作（Cua Driver）".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/computer-use-cua-driver-native/tests/provider.spec.ts
- Purpose: 226-line spec for the native provider's lifecycle and catalogue validation.
- Key abstractions: the `@trycua/cua-driver` module mocked with the fixture; `execute(rawName, args)` calling `cua_driver_native__<name>`.
- Data flow: `ctx.plugin(NativeProvider)` then `ctx.tools.execute(...)`.
- Non-obvious design decisions: (1) the "rejects another provider before importing or creating a native runtime" case asserts `expect(fixture.creates).toBe(0)` — the reservation is taken *before* the native library is even loaded; (2) the rollback table covers invalid JSON, a missing catalogue, duplicate names and a 70-character tool name; (3) the "keeps the reservation when native shutdown cannot prove completion" case asserts the provider name is **still** `cua-driver-native`, `fixture.destroys` is 0 and a replacement registration throws — the fail-closed rule.
- Edge cases / failure handling: a tool whose description is absent is accepted with `description: ''` rather than `undefined`.
- Surprising: the spec asserts the exact registered names against the fixture catalogue (`catalog.tools.map(t => 'cua_driver_native__'+t.name)`) — the public tool namespace is derived, not hand-listed.

### packages/experimental/computer-use-cua-driver-native/tests/cancellation.spec.ts
- Purpose: 87-line spec that unloading the provider aborts **image admission**, not just the native call.
- Key abstractions: a `BlockingModel` whose `resolveModel` requires a signal and rejects when it aborts.
- Data flow: a real tool call whose result is an image; the provider is disposed while the admission is pending.
- Non-obvious design decisions: the test asserts that the *caller's* signal is **not** aborted (`expect(controller.signal.aborted).toBe(false)`) and that `dispatch?.signal` is still the caller's signal — the provider's own lifetime aborts the *admission*, not the caller's cancellation contract.
- Edge cases / failure handling: after disposal the tool schemas are empty, the provider name is released, `fixture.shutdowns` and `fixture.destroys` are both 1, and the call's result is an error.
- Surprising: this is the only place in the shard where the *model-capability lookup* is treated as cancellable work that the provider owns.

### packages/experimental/computer-use-cua-driver-native/tests/loader-composition.spec.ts
- Purpose: 125-line spec that loads the provider from a real `cordis.yml` through the real Loader and runs a real Agent turn.
- Key abstractions: a `VisualModel` `LlmAdapter` that calls `cua_driver_native__get_window_state` first; the real `LocalAttachmentStore`.
- Data flow: the model calls the tool; the screenshot is admitted; the next request carries the attachment reference.
- Non-obvious design decisions: the test asserts the *whole* image pipeline: the tool result event carries the call id; the derived tool message contains an `image` block with `mediaType: 'image/png'`; `attachments.readImage` returns the exact fixture bytes; the next model request contains the **attachment reference** and **not** the base64 ("`expect(JSON.stringify(toolResult.content)).not.toContain(screenshotBase64)`").
- Edge cases / failure handling: a programmatic call (`ctx.tools.execute` without the agent loop) still returns the canonical raw result with `structuredContent`.
- Surprising: the spec asserts the guidance text is present in the first request (`toContain('Cua Driver native computer-use tools operate the host desktop.')`) — the system-prompt contribution is part of the contract.

### packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts
- Purpose: 50-line opt-in check against the *installed* native SDK.
- Key abstractions: `it.skipIf(process.env.DSH_COMPUTER_USE_NATIVE_E2E !== '1')`.
- Data flow: mounts the provider, lists the tool schemas, calls `check_permissions` with `{prompt: false}`.
- Non-obvious design decisions: the test asserts `result.content.some(block => block.type === 'image')` is **false** — the permission check must not produce an image; and the tool names must all start with `cua_driver_native__`.
- Edge cases / failure handling: after disposal the schemas are empty and the provider name is released.
- Surprising: the test is `retry: 0` — a native SDK that fails once is a failure, not a flake.

### packages/experimental/computer-use-cua-driver-native/tests/fixtures/cua-driver.ts
- Purpose: the fake native SDK.
- Key abstractions: a `catalog` with three tools (`get_window_state`, `click`, `check_permissions`); a mutable `fixture` object; a `CuaDriver` class with `create`, `listToolsJson`, `callTool`, `shutdown`, `uniffiDestroy`.
- Data flow: `callTool` returns a `rawJson` string, exactly like the real SDK.
- Non-obvious design decisions: the fixture returns **raw JSON strings** rather than parsed objects, so the provider's `JSON.parse(result.rawJson)` path is exercised for real; the `shutdown` hook can be made to throw, which is how the fail-closed reservation is tested; the `click` tool sets `fixture.clicked`, which the `get_window_state` result reflects.
- Edge cases / failure handling: `createError` makes the constructor throw (the rollback case).
- Surprising: the file is a valid stand-in for the published SDK *and* a Node module hook — the docstring says "usable by Vitest and test-only Node module hooks".

### packages/experimental/computer-use-cua-driver-native/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`.
- Key abstractions: `@trycua/cua-driver: "0.28.0"` pinned; `dsh-mcp-client` and `dsh-util-values`? (no — `schemastery`, `zod`).
- Data flow: `files` ships `locale/*.json`, `lib/index.js`, `lib/types/**`.
- Non-obvious design decisions: the provider depends on `dsh-mcp-client` only for `createMcpToolDefinition` — it reuses the *MCP result adapter* rather than writing a second image-admission path, which is why a native SDK result and an MCP server result behave identically in the transcript.
- Edge cases / failure handling: n/a.
- Surprising: `zod` is a real dependency because the catalogue schema and the JSON-schema conversion use it.

### packages/experimental/computer-use-cua-driver-native/tsconfig.json
- Purpose: 16-line compact TS project.
- Key abstractions: references to cordis, schemastery, computer-use, tools, system-prompt, mcp-client.
- Data flow: build graph.
- Non-obvious design decisions: the reference set includes `../../core/tools` and `../../core/system-prompt` because the provider registers tools *and* a prompt section.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/src/index.ts
- Purpose: 2-line marker module: "Optional reasoning translation composition; runtime rows live in cordis.patch.yml."
- Key abstractions: `export {}`.
- Data flow: n/a.
- Non-obvious design decisions: a bundle is *purely* its patch — the code is empty on purpose.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/cordis.patch.yml
- Purpose: inserts the two rows the feature needs, with defaults.
- Key abstractions: `translator` → `@deepseek-ai/dsh-experimental-translator`; `cot-translation` → `@deepseek-ai/dsh-experimental-client-ui-cot-translation` with `config: {provider: bing, targetLanguage: auto}`.
- Data flow: the profile composer applies the patch; the plugin's config becomes the Host's accepted preferences.
- Non-obvious design decisions: the **defaults are in the patch** — Bing and `auto` (follow the UI language) — so enabling the bundle is a single action and the provider choice is a *profile* decision, not a user one; the user can then change it in the Plugins page.
- Edge cases / failure handling: n/a.
- Surprising: the two rows are separate because the translator is the Host service and the client plugin is the browser half; the bundle is what pairs them.

### packages/experimental/cot-translation-bundle/README.md
- Purpose: the bundle's package reference.
- Key abstractions: the "Enable Reasoning translation in the Official group" flow; the paid-request accounting.
- Data flow: n/a.
- Non-obvious design decisions: the doc spells out the *billing* model precisely: "Each uncached fragment issues one independent query with thinking disabled. Reopening reuses saved results; changing provider, language, source or recipe may require another billed query. The model ID is matched without a version number, and pi-ai routes are excluded. Provider failure never sends the text to another service automatically." — a very specific privacy-and-cost contract.
- Edge cases / failure handling: known limits: anonymous Google/Bing endpoints may fail or rate-limit; "Collapsed summaries remain in the original language"; "Successful translations remain in the Session after collapse, bundle removal, or restart."
- Surprising: "Its generated Remote contribution is mounted only while the bundle is enabled" — disabling the bundle *cancels pending calls* and removes the controls.

### packages/experimental/cot-translation-bundle/README.zh.md
- Purpose: Chinese mirror of the translation bundle reference.
- Key abstractions: same flow and same billing contract.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version keeps "Provider 失败后不会自动将文本发送给其他服务" — the no-fallback rule is stated identically in both languages.
- Edge cases / failure handling: same limitations.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/README.i18n.yaml
- Purpose: bilingual hash record (11 pairs) for the translation bundle README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/locale/en.json
- Purpose: English plugin metadata "Machine translation of reasoning".
- Key abstractions: two keys.
- Data flow: Plugins page.
- Non-obvious design decisions: the description ends with "; source text is sent to the selected service" — the *bundle's* metadata carries the privacy warning (the plugin's own metadata does not).
- Edge cases / failure handling: n/a.
- Surprising: the same title as the plugin's locale file, with a different description — the bundle and the plugin are separately installable surfaces.

### packages/experimental/cot-translation-bundle/locale/zh.json
- Purpose: Chinese plugin metadata "思考过程机器翻译".
- Key abstractions: two keys.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/icon.svg
- Purpose: 36×36 icon: two overlapping rounded squares (a source document and a target document) with a "文" and a "字" glyph.
- Key abstractions: two gradients — blue (`#69B9FF` → `#324DE2`) for the source, teal-green (`#6AECB6` → `#37A6B1`) for the target.
- Data flow: Plugins list.
- Non-obvious design decisions: the two glyphs are transformed about their own centres (`transform="translate(14 14.75) scale(0.9) translate(-14 -14.75)"`) so the 0.9 scale does not shift the glyph's position.
- Edge cases / failure handling: n/a.
- Surprising: the icon encodes *two* languages, which is why it needs two gradients.

### packages/experimental/cot-translation-bundle/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-experimental-cot-translation-bundle`.
- Key abstractions: `dsh.bundle.patch`; two real dependencies (the translator and the client plugin).
- Data flow: `files` ships `icon.svg`, `locale/*.json`, `lib/index.js`, `cordis.patch.yml`, `lib/types/**/*.d.ts`.
- Non-obvious design decisions: `js-yaml` is a **devDependency** — the bundle's own tests parse the patch YAML, and the runtime does not.
- Edge cases / failure handling: n/a.
- Surprising: the bundle depends on an *experimental* package (`dsh-experimental-client-ui-cot-translation`) and on a *release-style* one (`dsh-experimental-translator`) — experimental packages may depend on each other, per `packages/experimental/AGENTS.md`.

### packages/experimental/cot-translation-bundle/tsconfig.json
- Purpose: 15-line TS project referencing only the vendored cordis.
- Key abstractions: `rootDir: src`, `outDir: lib/types`.
- Data flow: build graph.
- Non-obvious design decisions: no cross-package references, because the bundle has no code.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cot-translation-bundle/tsdown.config.ts
- Purpose: 3-line tsdown config (the node-style one, not the client one).
- Key abstractions: `defineConfig({entry:['lib/types/index.js'], outDir:'lib', format:['esm'], platform:'node', target:'es2024', fixedExtension:false, dts:false, clean:false})`.
- Data flow: build only.
- Non-obvious design decisions: identical to the api-speech-to-text bundle config — the bundle build recipe is shared across the repo.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cua/src/index.ts
- Purpose: `installCua` — the shared computer-use executor: one native connection per Agent, consent, coordinates, screenshots and image admission.
- Key abstractions: `CuaConfig` (twenty resource limits with hard maxima); `CuaBackend {helperPath, createChannel, guidance, description}`; `ownerFor(agent)`; `callNative`.
- Data flow: `ctx.tools.register({name:'cua', parameters: z.toJSONSchema(Request), output: {schema:{}, render: renderResult}, execute})` → per Agent, a `NativeClient` is created on demand → the request is validated by `Request.parse(args)` → the coordinates are converted → the native call runs → the result is parsed.
- Non-obvious design decisions: (1) the **model's JSON Schema is derived from the zod request schema** (`z.toJSONSchema(Request)`) so the tool description and the admission rules cannot drift; (2) the host-only limits are attached *after* validation — `maxElements`/`maxDepth` for `getState`, `maxAppMatches` for `findApps`, `maxClipboardBytes`/`pasteReadTimeoutMs` for `paste`, `durationMs`/`steps` for `drag` — so a model can never author them; (3) a screenshot requires an **attachment store** and a model route that declares image input ("CUA screenshots require model \"X\" to declare image input"), and the decoded image's dimensions must agree with the native report or the call fails with `NATIVE_PROTOCOL`; (4) the model-visible content is the *metadata plus one image* — the base64 is stripped by `renderResult` and stays in the canonical value; (5) the clipboard paste is serialised across processes with `withFileLock(join(tmpdir(),'dsh-cua-system-clipboard'), …)`; (6) `getApp` **obtains consent** and, if the app is not running, launches it through the *authorised* path — and the launched handle must equal the requested one.
- Edge cases / failure handling: a request carrying an `appHandle` without a client is refused with `APP_ACCESS_REQUIRED`; the Agent must be the exact live one (`ctx.agents.get(agent.id) !== agent` → 'dsh-cua agent has been disposed'); disposal aggregates the failures of the access layer, the clients and the owners into one `AggregateError`.
- Surprising: the tool is named `cua` (one tool, many operations) rather than one tool per operation — the operation is a discriminated union inside the arguments, which is how the "model-authored JSON cannot carry host configuration" property is achieved.

### packages/experimental/cua/src/protocol.ts
- Purpose: the single authority for model-submittable operations and native result shapes.
- Key abstractions: `Request` (a `z.discriminatedUnion('method', …)` of `operation(method, params)`); `ScreenshotResult`; `StateResult`; `WindowsResult`; `CapabilitiesResult`; `ActionResult`; `HoverResult`; `ShowResult`.
- Data flow: the model sends `Request`; the native helper returns the `*Result` shapes; `src/index.ts` parses both.
- Non-obvious design decisions: (1) every `params` object is `.strict()` — an extra key is an admission failure; (2) the `click`/`hover` params are a **union of three shapes** (snapshot element / absolute coordinate / relative coordinate) so a mixed target is impossible; (3) the base64 image validator re-encodes and compares — "Exact re-encoding also rejects whitespace, missing padding and nonzero pad bits without a recursive regex"; (4) `ActionResult = {dispatched: true, verified: false}` — an action never claims verification; (5) `CapabilitiesResult.coordinateSpace` is the literal `'screenshot-pixels'` and `browser` is the literal `false`.
- Edge cases / failure handling: `findApps` requires a non-empty query that contains a non-space character; `id` and `pid` have explicit integer maxima.
- Surprising: the "Host resource fields and private continuations are separate" comment at the top is the design statement: the *model* schema is a strict subset, and the host adds its limits afterwards.

### packages/experimental/cua/src/coordinates.ts
- Purpose: the agent-owned mapping from observed screenshot pixels (or integer ratios) to native window points.
- Key abstractions: `CuaCoordinates` with `observe(appHandle, windows, windowId?)`, `screenshot(appHandle, windowId, bounds, image)` and `parameters(request)`.
- Data flow: `observe` records each window's point size; `screenshot` binds the *delivered image's* pixel size to the window's point size; `parameters` converts the model's coordinates once, before dispatch.
- Non-obvious design decisions: (1) the mapping is keyed by (app handle, window id), so different windows and different applications are independent; (2) **a move preserves the mapping** but a **resize invalidates it** — a resize drops the image binding, and an absolute pixel coordinate then fails with `SCREENSHOT_REQUIRED` while a relative one still works; (3) an out-of-image coordinate fails with `INVALID_ARGUMENT` *before* dispatch; (4) relative coordinates are integer thousandths (0..1000) and are clamped to the window interior (`Math.max(0, frame[axis] - 1)`), so 1000 lands on the last pixel rather than one past the edge; (5) a window that has never been observed fails with `STALE_SNAPSHOT`.
- Edge cases / failure handling: a scoped observation (one window) leaves the *other* windows' mappings intact, and only the scoped closed window is removed.
- Surprising: the conversion is done by the **Host**, once, at the tool boundary — the native helper only ever sees window points, and the model's "pixels" are always interpreted against the exact image it was shown.

### packages/experimental/cua/src/application-access.ts
- Purpose: the application-consent layer.
- Key abstractions: `ApplicationAuthorizationResult` (a 64-hex digest id + name + executable path + `persistable`); `AccessOptions {grants, save?}`; `Selection {identity, scope: 'task'|'persistent', lifetime}`.
- Data flow: `select()` asks the user (through `ctx.userQuestions`) once per (agent, identity); `run()` re-checks the consent at every dispatch.
- Non-obvious design decisions: (1) the question offers exactly three options — "Allow for this task", "Deny", and "Always allow" (only when the identity is persistable *and* a saver exists); a **custom free-text answer never grants access** (`!answer.custom?.trim()`); (2) the question text states the scope explicitly — "Task access applies to the selected application instance, including its launch if needed"; (3) a **delegated** caller gets `APP_APPROVAL_UNAVAILABLE` rather than a question — "ask the main task to perform this operation"; (4) a *denial* is remembered per agent (`this.rejected`), so a second attempt at the same identity fails immediately without re-asking; (5) the denial message says "Do not retry or use another tool to bypass this decision."; (6) `select` is serialised per (agent, identity) so two concurrent approvals cannot race; (7) consent is re-read *after* the awaited user decision, because "The awaited user decision can outlive the helper".
- Edge cases / failure handling: revoking a grant aborts the selection's lifetime controller, aborts in-flight operations and invalidates the native client — so old objects require a fresh selection; `dispose()` aborts the lifetime, awaits the mutation tail and the active operations.
- Surprising: the "Always allow" path writes the grant through a **settings mutation with the descriptor's revision** (in `src/index.ts`), so the permission list is a versioned, auditable config change rather than a side file.

### packages/experimental/cua/src/native-client.ts
- Purpose: the JSONL client for the native helper — request correlation, byte limits, cancellation acknowledgement and failure settlement.
- Key abstractions: `NativeError` (a `code` + a message prefixed with the code); `NativeClientConfig`; `NativeChannel`/`NativeChannelFactory`; the `WireReply` union of a `Reply` and a `ScreenshotDiagnostic`.
- Data flow: `request(method, params, signal, callId?)` writes one JSON line, awaits the reply, and settles.
- Non-obvious design decisions: (1) the request id is the **logged tool invocation id** when there is one (`const id = callId ?? randomUUID()`), so a native request can be correlated with the transcript; (2) only one native operation may be in flight (`NATIVE_BUSY`); (3) the request frame is size-checked *before* dispatch (`NATIVE_REQUEST_LIMIT`); (4) **cancellation is acknowledged**: the client sends a `{type:'cancel', id}` frame and starts a `graceMs` timer — if the helper acknowledges (even with a *late success*, which is accepted as the acknowledgement) the connection survives; only if the grace expires without an acknowledgement does the client fail with `NATIVE_CLEANUP`; (5) the response buffer is byte-bounded (`NATIVE_RESPONSE_LIMIT`); (6) a diagnostic frame (`{type:'diagnostic'}`) can never become a result — it is retained in a **bounded 8 KiB buffer** and, if the buffer overflows, the oldest records are dropped and a marker line says so; (7) `reportDiagnostic` failures are swallowed — "Diagnostic consumers must not replace the native result or prevent process cleanup."
- Edge cases / failure handling: stdout EOF/close, a stdin error and a connection exit all map to stable codes (`NATIVE_EOF`, `NATIVE_IO`, `NATIVE_EXITED`); a reply that does not match the active request is a protocol error; a decode uses `new TextDecoder('utf-8', {fatal: true})` so malformed UTF-8 is a failure rather than replacement characters.
- Surprising: the diagnostic records are attached to the *error message* on failure ("`failure.message += '\\nScreenshot diagnostics:\\n'+diagnostics`") — the debugging trail rides the error, not a side channel.

### packages/experimental/cua/src/api.ts
- Purpose: the object facade over the logged operations.
- Key abstractions: `createCuaApi(dispatch, sink?)`; `requestIssueMessage(issues)`; `keyChord(chord)`.
- Data flow: `app.getAXState()` → `getState`; `app.getScreenshot()` → `screenshot`; `app.click(target)` → `click`; the object methods validate and dispatch.
- Non-obvious design decisions: (1) the zod issue renderer produces a **human-readable** message ("`x.y: not accepted for these arguments`", "…: Expected a non-empty search string") instead of a raw zod dump, and it handles `invalid_union` by picking the *fewest-error* branch; (2) a `keyChord` parser maps the human modifier names (`cmd`, `super`, `Super_L`, `alt`, `Option_L`, `fn`, …) onto the protocol's five modifiers; (3) the object refuses to act before an observation exists — "Read getAXState before using this surface"; (4) an observation whose identity does not match the selected app/window is rejected ("Native observation belongs to another application or window"), and windows belonging to another pid are rejected too; (5) the window is chosen as *focused* if it is among the visible non-zero-size windows, else the single visible one, else the caller must select one explicitly.
- Edge cases / failure handling: `emit:false` suppresses the *sink* but not the return value; a screenshot whose `windowId` differs from the requested one is rejected.
- Surprising: `getState()` at the API level is `listApps` plus an empty browser list — the browser list is hard-coded empty because the native implementation has no browser support yet, and the type says `browsers: []`.

### packages/experimental/cua/src/types.ts
- Purpose: the public object API types.
- Key abstractions: branded `CuaAppHandle`/`CuaSnapshotId`; `CuaApi`, `CuaApp`, `CuaSurface`, `CuaWindow`; `CuaCoordinateOptions {relative?}`; `CuaObservationSink`.
- Data flow: n/a (types only).
- Non-obvious design decisions: (1) the handles are **branded** so a raw string cannot be passed where a handle is expected; (2) `CuaDispatch` is documented as "Dispatch exactly once; a failed action must not be retried implicitly"; (3) `CuaCoordinateOptions.relative` is documented as "True uses integers from 0 to 1000; omitted or false uses the latest screenshot's pixels. Applies only to coordinate targets"; (4) `CuaCapabilities` documents that `sessionLocked === null` means no usable console session was verified — a *third* state, not a boolean.
- Edge cases / failure handling: `CuaAxOptions.disableDiffing` is marked "Reserved compatibility option; observations are never diffs" — a vestigial knob kept so callers do not break.
- Surprising: `CuaObservationOptions {emit?}` is documented as "Observations emit by default. Returned values are unaffected by this option" — the emit flag suppresses *output*, never *data*.

### packages/experimental/cua/src/bridge.ts
- Purpose: `connectCua` — the PTC-facing bridge from retained app objects to the host's current tool binding.
- Key abstractions: `CuaToolBinding`; `connectCua(getTool, onText?)`.
- Data flow: `createCuaApi(operation => getTool()(operation), {text: onText, image: () => {}})`.
- Non-obvious design decisions: (1) the binding is resolved **on every operation** — "do not capture a completed execution's binding" — so an app object retained across PTC calls uses the *current* execution's authority; (2) the image sink is a **no-op** because "The standard tools.cua result already carries the screenshot attachment" — the image enters the transcript exactly once, through the tool result, not again through the object's sink.
- Edge cases / failure handling: rejections propagate unchanged and are never retried.
- Surprising: the bridge deliberately does *not* own an evaluator or a lifetime; it is a thin adapter over the host's tool pipeline.

### packages/experimental/cua/src/application-types.ts
- Purpose: the application identity types.
- Key abstractions: branded `CuaApplicationId`; `CuaApplicationGrant {id, name, executablePath}`.
- Data flow: n/a.
- Non-obvious design decisions: the grant carries the **executable path** that was presented to the human, so the record of what was approved is legible after the fact.
- Edge cases / failure handling: n/a.
- Surprising: 14 lines; the identity is a digest of "an executable path and its signing requirement".

### packages/experimental/cua/README.md
- Purpose: the shared computer-use library reference.
- Key abstractions: the App/Window object model; the coordinate rules; the image pipeline.
- Data flow: n/a.
- Non-obvious design decisions: the doc states the *semantics* of the action result: "Actions return `dispatched:true, verified:false`; read fresh state to verify the result." and "No input is replayed after cancellation, timeout, or reconnect."
- Edge cases / failure handling: known limits: native execution is macOS-only today, with Windows planned as a separate provider package; "Persistent variables do not reserve an application across a sequence of operations"; "Hover and observations do not restore the previous pointer position."
- Surprising: the doc explains the image pipeline precisely — "Each screenshot enters the attachment pipeline once; `emit:false` only suppresses the object sink" — and the coordinate rules ("Resizing invalidates the screenshot mapping; `SCREENSHOT_REQUIRED` requires a new screenshot for absolute coordinates. Resizing rejects old coordinates with `WINDOW_CHANGED`; movement alone preserves window-local coordinates.").

### packages/experimental/cua/README.zh.md
- Purpose: Chinese mirror of the shared computer-use reference.
- Key abstractions: same object model and same coordinate rules.
- Data flow: n/a.
- Non-obvious design decisions: the Chinese version keeps the same `dispatched:true, verified:false` sentence in code font, so the literal value is identical in both languages.
- Edge cases / failure handling: same limitations, including the Windows-plan note.
- Surprising: n/a.

### packages/experimental/cua/README.i18n.yaml
- Purpose: bilingual hash record (14 pairs) for the shared computer-use README.
- Key abstractions: anchor → hashes.
- Data flow: regenerated by the pairing tool.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cua/package.json
- Purpose: npm manifest for `@deepseek-ai/dsh-cua`.
- Key abstractions: `exports` with `./api`, `./bridge`, `./native-client`, `./protocol` subpaths.
- Data flow: `files` ships `lib/index.js` and the four sub-entry bundles.
- Non-obvious design decisions: nine **peer** dependencies (cordis, computer-use, system-prompt, tools, agent, subprocess, user-questions, attachment, llm) and only three real ones (`dsh-util-values`, `schemastery`, `zod`, `dsh-brand`, `dsh-atomic-write`) — the library plugs into the host's registries rather than owning them.
- Edge cases / failure handling: n/a.
- Surprising: `sharp` is a devDependency — image dimension normalisation is tested against a real image library.

### packages/experimental/cua/tsconfig.json
- Purpose: 60-line TS project with 15 references.
- Key abstractions: references to computer-use, tools, system-prompt, agent, subprocess, values, brand, atomic-write, ptc-runtime, settings, user-questions, the vendored loader, attachment and llm.
- Data flow: build graph.
- Non-obvious design decisions: the reference set is exactly the set of services `installCua` reaches into — the compile-time surface equals the runtime surface.
- Edge cases / failure handling: n/a.
- Surprising: `../../../vendor/loader` is referenced even though the loader is not imported — the Cordis plugin type is needed for the `apply` signature.

### packages/experimental/cua/tsdown.config.ts
- Purpose: 10-line tsdown config building five named entries.
- Key abstractions: `Object.entries({index, api, bridge, 'native-client', protocol})` mapped to one config each.
- Data flow: build only.
- Non-obvious design decisions: the *public* sub-entries are separate bundles, not one bundle with subpath exports — so a consumer that imports only `@deepseek-ai/dsh-cua/protocol` does not pull the whole runtime.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/cua/tests/protocol.spec.ts
- Purpose: 74-line spec proving model-authored operation JSON cannot supply host configuration or bypass retained identities.
- Key abstractions: a `rejectedRequests` table with a *reason* string per case.
- Data flow: `Request.safeParse(request).success` must be false.
- Non-obvious design decisions: the rejection table is the clearest statement of the trust boundary in the shard: a raw `pid` instead of a selected handle; an unknown native method; the host-owned traversal limit `maxElements`; an extra tool argument `helperPath`; an element click without an observed snapshot; a coordinate click without a window; a *mixed* element+coordinate click; an unsupported modifier.
- Edge cases / failure handling: the base64 table rejects eight malformed encodings (`''`, `'not base64!'`, `'AQ'`, `'AQ==='`, `'AQ==\n'`, `'A Q=='`, `'AQ-_'`, `'AB=='`, `'AAF='`) — each a different way a decoder would be lenient; the screenshot metadata table rejects a bad mime type, a zero width, a negative height, a zero window id, a zero-width bounds and the wrong `coordinateSpace`.
- Surprising: the hover rules are *asymmetric* with click: hover accepts a snapshot or a coordinate but **no** button, click count or modifiers — a hover cannot carry a click's options.

### packages/experimental/cua/tests/coordinates.spec.ts
- Purpose: 86-line spec for the coordinate mapping.
- Key abstractions: a `window(width, height, x)` builder and a `call(method, params)` that goes through `Request.parse` so the test can never construct an invalid request.
- Data flow: `coordinates.observe(...)` / `coordinates.screenshot(...)` then `coordinates.parameters(request)`.
- Non-obvious design decisions: (1) the Retina case is the point: a 1280×960 image and a 320×240 image of the same 640×480 window both map the same pixel to the same native point — the conversion is scale-correct in both directions; (2) the endpoint check: relative 1000 maps to `width-1`, not `width`; (3) the invalidation rules are tested in sequence — move preserves, resize invalidates the *image* but not the *window*, close removes the window entirely (`STALE_SNAPSHOT`).
- Edge cases / failure handling: a zero-width or zero-height window is `STALE_SNAPSHOT`; an exactly-out-of-image coordinate is `INVALID_ARGUMENT`.
- Surprising: the last case proves the mapping is per (app, window): a second application with the same window id has its own mapping and does not interfere.

### packages/experimental/cua/tests/bridge.spec.ts
- Purpose: 65-line spec for the PTC bridge.
- Key abstractions: a `current: CuaToolBinding` variable that the test swaps mid-test.
- Data flow: `connectCua(() => current, text)`.
- Non-obvious design decisions: (1) the retained app is created with the first binding and *called* with the second — proving the binding is resolved per operation; (2) a denial propagates **without retry** (`expect(tool).toHaveBeenCalledTimes(1)`); (3) the screenshot case asserts the tool was called exactly three times (`getApp`, `getState`, `screenshot`) and that the *text* sink was **not** called for the image — one image-bearing call, no duplicate emission.
- Edge cases / failure handling: unusable tool results (`null`, a string, a content-block envelope) are rejected.
- Surprising: the test asserts the returned screenshot is `Uint8Array.from(Buffer.from(PNG,'base64'))` — the facade decodes the base64 for the object API while the tool result keeps it.

### packages/experimental/cua/tests/api.spec.ts
- Purpose: 588-line spec for the object facade over a fixture dispatcher.
- Key abstractions: a `fixture()` whose `dispatch` switches on the operation method; `state()` and `screenshot()` builders.
- Data flow: `createCuaApi(dispatch, sink)` then the object methods.
- Non-obvious design decisions: (1) the window-selection rules are tested exhaustively — one visible non-zero window is auto-selected, several require `getWindow`, a focused window is preferred, a focused id **not present** in the observation is *not* used, and menu/hidden/zero-size windows are preserved in discovery but excluded from selection; (2) the identity checks are tested for `appHandle`, `pid` and `windowId` mismatches, and for a window belonging to another pid.
- Edge cases / failure handling: a failed `getWindow` leaves the call count unchanged (no partial state); an invalid `getWindow(0)` never dispatches.
- Surprising: the "expands menu contents and details only for the requested observation" test asserts the exact `params` forwarded — the disclosure options are passed through and nothing else.

### packages/experimental/cua/tests/application-access.spec.ts
- Purpose: 319-line spec for the consent layer.
- Key abstractions: a mocked `NativeClient` class; a `setup()` that installs a real `UserQuestions` service and a fake answer.
- Data flow: `access.select(agent, client, handle, identity, signal)` and `access.run(client, handle, signal, dispatch)`.
- Non-obvious design decisions: (1) "refuses raw handle dispatch until getApp obtains consent" — `access.run` rejects with `APP_ACCESS_REQUIRED` and the dispatch is never called; (2) the answer spy is wired through the real `user-questions/request` event, so the consent flow is the platform's, not a mock; (3) the last case proves a denial in *another* task does not abort an operation already running in this one (`expect(operationSignal.aborted).toBe(false)`) — the denial is scoped to the agent that asked.
- Edge cases / failure handling: a cancelled question (`ASK_CANCELLED`) becomes a denial; a delegated caller (`DELEGATED_CALLER`) becomes `APP_APPROVAL_UNAVAILABLE`.
- Surprising: the spec runs with `options.questions === false` to prove the "no human answerer" path raises `APP_APPROVAL_UNAVAILABLE` instead of hanging.

### packages/experimental/cua/tests/native-client.spec.ts
- Purpose: 475-line spec for the JSONL transport.
- Key abstractions: a `fixture()` with `PassThrough` stdout and a `Writable` stdin that parses the frames; `Request`/`Cancel`/`Frame` zod schemas.
- Data flow: `client.request(method, params, signal, callId)`; the test writes replies into stdout.
- Non-obvious design decisions: (1) the request id is asserted to be the **logged tool invocation id** ("uses the logged tool invocation ID for the native request and its matching reply"); (2) the timeout path asserts that a `cancel` frame is sent and that the connection is **not** closed when the helper acknowledges with a late success — "accepts a successful reply as cancellation acknowledgement when the reply was already in flight"; (3) the grace path asserts the connection closes only after `graceMs` without an acknowledgement, with `NATIVE_CLEANUP` and `cause: {code:'NATIVE_TIMEOUT'}`; (4) six transport failure kinds (stdout error, stdin error, stdout end, stdout close, connection exit, connection rejection) each map to a stable code; (5) the diagnostic test asserts the bounded buffer drops the *oldest* records, inserts the marker "Earlier screenshot diagnostic records were discarded from the bounded diagnostic buffer.", and keeps the total under 8192 bytes.
- Edge cases / failure handling: a cancellation write that fails (throw or callback) closes the connection with `NATIVE_IO`; a screenshot request's diagnostic stream must never become the result ("does not let a Host diagnostic sink replace a screenshot result").
- Surprising: the spec asserts `expect(vi.getTimerCount()).toBe(0)` after each cancellation path — the client's timers are all cleaned up, so a long-lived host does not accumulate timers.

## Ideas worth stealing

- **Give the LLM a closed, machine-checkable answer grammar and treat every deviation as a failure** — `packages/experimental/auto-review/src/index.ts:41` (the fixed `REVIEW_POLICY`) and `packages/experimental/auto-review/src/index.ts:559` (`parseDecision`) — the reviewer must emit zero or more reasoning blocks followed by exactly one text block containing exactly one JSON object with exactly the members `{risk, decision}` (or `{risk, decision, reason}`), and `topLevelMemberCount` (`src/index.ts:537`) rejects a *repeated* member that `JSON.parse` would silently accept. **Why it transfers to August**: August's own self-correction/reminder path needs the same property — a model-authored structured reply must be verifiable by a *deterministic* checker, and "the JSON parsed" is not enough (duplicate keys, extra members, wrong risk/decision combinations and a missing terminal finish must all fail). The 20-case invalid-response table at `packages/experimental/auto-review/tests/auto-review.spec.ts:880` is the test matrix August would need.

- **Distinguish "the reviewer said no" from "the reviewer broke", and make both fail closed** — `packages/experimental/auto-review/src/index.ts:667` (`failed()`) versus `packages/experimental/auto-review/src/index.ts:639` (`denied()`), wired at `packages/experimental/auto-review/src/index.ts:705` — a reviewer failure produces `Auto review of tool "X" failed; its body was not executed: <error>`, a denial produces `Auto review rejected tool "X"; its body was not executed`, and in both cases the body never runs. **Why it transfers to August**: August's `_stuckRequest_escape` ladder and its "malformed tool JSON never executes as `{}`" rule are the same class of decision; giving the two outcomes *different* message shapes is what lets the model (and the log) tell "the system refused" from "the machinery broke", which is exactly the distinction August's `classify_error` taxonomy is trying to make.

- **Cross-check the in-flight action against the durable log before you act on it** — `packages/experimental/auto-review/src/index.ts:309` (the native action must agree with its logged name/arguments) and `packages/experimental/auto-review/src/index.ts:341` (the PTC inner call must agree with its dispatch-start event) — a disagreement is a hard error, not a guess. **Why it transfers to August**: August's "a request the provider refuses on shape is repaired, not replayed" logic and its shape-repair ladder both operate on tool calls whose provenance is not yet verified; a log-vs-execution cross-check is the missing first step, and the scoped key `turn\0step\0callId` (`src/index.ts:270`) is a ready-made identity for it.

- **Key a session-owned resource by the *live* agent, never by the durable session id** — `packages/experimental/browser-use-runtime/src/index.ts:149` — `this.ctx.get('agents')?.get(agent.id) !== agent` rejects a stale owner, so a *resumed* session with the same id can never inherit the previous browser. **Why it transfers to August**: August resumes sessions, spawns subagents and re-opens chats; every "one resource per conversation" rule (a browser, a voice model, a computer-use handle, a mock server) needs this identity test, otherwise a resumed session silently shares the previous session's live state.

- **Close the resource *before* waiting for the operations it is interrupting** — `packages/experimental/browser-use-runtime/src/index.ts:185` (`closeEntry`) — abort the entry, `await resource.close()`, and only then `await entry.tail`; the README states the reason: "Cleanup closes resources before waiting for running operations, allowing connection teardown to interrupt upstream APIs without abort support." **Why it transfers to August**: August's tool-cancellation path (`_stuckRequest_escape`, the `TOOL_ABORTED_BEFORE_DISPATCH` semantics) faces exactly this: an upstream HTTP call with no abort support will only be interrupted by closing the connection, so the teardown order is the only thing that actually stops it.

- **A failed close must RETAIN ownership, not release it** — `packages/experimental/browser-use-runtime/src/index.ts:139` (dispose aggregates the failures and throws) and `packages/experimental/computer-use-cua-driver-native/src/index.ts:66` (the registration is kept when `driver.shutdown()` cannot prove completion) — "Restart the host before mounting another computer-use provider." **Why it transfers to August**: August's own docs warn that a failed close "retains ownership"; this is the same fail-closed rule applied to *host* resources rather than to *agent* permissions, and it is the right default whenever the residue is invisible to the next caller.

- **Discover an MCP server's tools before the agent's first model request, and only for future activations** — `packages/experimental/browser-use-runtime/src/mcp.ts:181` — the client is mounted inside the `agent/created` event, `await resources.get(agent, signal)` blocks Agent creation until discovery completes, and `system-prompt/assemble` strips the `mcp:<name>` section for any Session whose client is not ready (`src/mcp.ts:215`). **Why it transfers to August**: this is the mechanism behind August's KV-cache discipline — the tool-definition prefix is stable because the catalogue is fixed *before* the first request, and a Session without the browser never sees a browser tool in its prompt (which would both break the prefix and lie to the model).

- **Identity-bearing runtime modules must be peer dependencies, never dependencies — and prove it with a test** — `packages/experimental/browser-use-runtime/tests/shared-host-runtimes.spec.ts:28` (asserts peer + dev, asserts *not* dependency) and `packages/experimental/browser-use-runtime/tests/host-runtime-duplication.spec.ts:66` (reproduces the failure) — a second copy of `dsh-scope` mints a different scope-tag symbol, so every Agent's MCP tools register in the *global* tool layer and the second Agent's tool synchronisation fails. **Why it transfers to August**: this is the generic form of August's "one code path" rule: any module that mints an identity (a scope tag, a registry key, a per-process singleton) must be a singleton in the host, and a profile-level plugin that installs its own copy breaks *every* session, not just its own.

- **Neutralise, do not forward, an inherited environment that could override your configuration** — `packages/experimental/browser-use-playwright-mcp/src/index.ts:32` — every `PLAYWRIGHT_MCP_*` variable is passed to the child as an **empty string**, because "Empty values mean absent to its parser", and the spec pins the exact value (`tests/provider.spec.ts:22`). **Why it transfers to August**: August's own sandbox work is full of "the ambient environment must not steer the decision" rules (scrubbed parent env, secret redaction at the transport, per-host env); the *implementation* detail that matters is that "unset" and "empty" are different to many parsers, so the scrub must be explicit and the value must be asserted.

- **Run the untrusted or third-party SDK in an isolated Worker with an explicitly empty environment** — `packages/experimental/browser-use-stagehand-native/src/worker-client.ts:21` — `const env: NodeJS.ProcessEnv = {}` (only `TSX_TSCONFIG_PATH` is forwarded) and the credentials cross explicitly through `workerData`; the comment says "ambient credentials and proxy settings stay outside." **Why it transfers to August**: August's code-runner and its PTC runtime both execute third-party code; a worker-thread boundary with a scrubbed env is a cheap way to make "the plugin cannot see the host's API keys" a structural fact rather than a policy.

- **Give a Worker RPC a validated response schema and release the reply port in a `finally`** — `packages/experimental/browser-use-stagehand-native/src/worker-rpc.ts:7` and `src/worker-rpc.ts:27` — the reply is a `z.discriminatedUnion('ok', …)`; a malformed response rejects the request and closes both ports; a clone failure surfaces as a clone error. **Why it transfers to August**: August's inter-process and worker protocols (the `run_code` transport, the PTC runtime bridge) have the same "the peer may be wrong" problem, and a discriminated-union reply plus a guaranteed port close is a two-line way to make a hung peer impossible.

- **A cancel must be *acknowledged*; only an unacknowledged cancel closes the connection** — `packages/experimental/cua/src/native-client.ts:136` — the client sends a `{type:'cancel', id}` frame and starts a `graceMs` timer; a late *success* counts as the acknowledgement, and the connection dies only if the grace expires (`NATIVE_CLEANUP`). The spec pins both halves (`packages/experimental/cua/tests/native-client.spec.ts:243` and `:271`). **Why it transfers to August**: this is the exact shape of August's "a server-requested wait above the ceiling is refused, not absorbed" and "a tool call that is cancelled must not leave the loop spinning" rules — a two-phase cancel (request, then grace, then fail) is more honest than an immediate local abort, and it distinguishes "the peer stopped" from "we gave up waiting".

- **Actions report `dispatched: true, verified: false` and never claim the outcome** — `packages/experimental/cua/src/protocol.ts:122` — with the guidance text repeating it to the model ("a delivered click alone does not prove the outcome"). **Why it transfers to August**: August's own tool results are the place where this matters most (a `run_command` that exits 0 is not a successful change; a `write_file` is not a correct file). Returning a "dispatched but unverified" shape, and telling the model in the *system prompt* to re-read state, is a cheap and honest contract that also keeps the model's post-hoc narration accurate.

- **Bind model coordinates to the exact image the model was shown, and invalidate the binding on a resize** — `packages/experimental/cua/src/coordinates.ts:42` (the screenshot binding) and `src/coordinates.ts:60` (the `STALE_SNAPSHOT` / `SCREENSHOT_REQUIRED` / `INVALID_ARGUMENT` errors) — the Host converts the model's pixels to native points once, before dispatch, and a resize demands a fresh screenshot while a *move* does not. **Why it transfers to August**: any August feature that lets a model act on a screenshot (a computer-use tool, a vision-guided click) has the same "the pixels the model reasoned about are no longer the pixels on screen" bug; the fix is a host-owned binding table plus three explicit error codes.

- **The model may not author host-owned fields — and the model-authored JSON is checked at admission** — `packages/experimental/cua/src/protocol.ts:21` (every `params` is `.strict()`) and `packages/experimental/cua/tests/protocol.spec.ts:6` (the rejection table: raw pid, unknown method, `maxElements`, extra `helperPath`, mixed element+coordinate targets) — plus `packages/experimental/cua/src/index.ts:227`, where the host attaches its own limits *after* validation. **Why it transfers to August**: August's tool schemas are model-visible; anything the host wants to own (limits, paths, timeouts, identities) must be structurally absent from the model's schema and attached afterwards, not merely documented as "the model shouldn't send these".

- **Application consent is a protocol phase with a closed answer set, and free text never grants access** — `packages/experimental/cua/src/application-access.ts:88` (the three options) and `src/application-access.ts:107` (`!answer.custom?.trim()` and exactly one selected option) — a denial is remembered per agent so a second attempt fails without re-asking, and a delegated caller gets `APP_APPROVAL_UNAVAILABLE` rather than a question. **Why it transfers to August**: August's `user_approval` door is exactly this shape, but August also has *model-mediated* consent (the auto-review `ask` path); the "custom free text never grants access" rule and the "delegated caller cannot ask" rule are the two edges worth copying.

- **Revoking a permission must cancel the work it authorised, in flight** — `packages/experimental/cua/src/application-access.ts:202` (`invalidate`) — the selection's lifetime controller is aborted, in-flight operations are aborted with `APP_ACCESS_REVOKED`, and the native client is invalidated so old handles are dead. **Why it transfers to August**: August's "an absent capability definition means inherit" and its `delete_agent` cascade are about *removing* authority; the missing half is that removal must also stop the work already running under that authority, not just block new calls.

- **Translate only *completed* paragraphs; leave the streaming tail in the original** — `packages/experimental/client-ui-cot-translation/src/client/translation.ts:38` — `complete: match !== null || !running` — combined with the whitespace-preserving, surrogate-safe splitter at `src/client/translation.ts:28` (`if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1`). **Why it transfers to August**: this is the single most directly transferable idea in the shard for August's reasoning/thinking surface. A reasoning block streams in; a blank line is a *completion boundary*; only closed paragraphs are eligible for any expensive per-paragraph treatment; the growing tail stays original; and the reassembled text is byte-identical to the input. The same rule generalises to any "translate / summarise / re-render a streaming markdown block" feature August might want.

- **Keep the original always, and make a failure show the original with an explicit retry** — `packages/experimental/client-ui-cot-translation/src/client/TranslationBody.tsx:48` (`const showOriginal = original || state.failed`) and `src/client/translation.ts:107` (the catch sets a boolean, never a message) — the provider's own error text never reaches the UI or the model, and the toggle is disabled while failed so the user cannot flip into a broken state. **Why it transfers to August**: August's compaction and summary features face the same failure mode; "the original is always one click away and a provider message never leaks" is a good default for anything that transforms content the user owns.

- **Re-check the accepted preferences and limits at the door, not at the display** — `packages/experimental/client-ui-cot-translation/src/client/mount.ts:93` — before a request is sent the browser compares the request's provider, target language and text length against the *accepted* Host state and refuses with "Translation preferences or limits changed"; the Host performs the same check (`packages/experimental/client-ui-cot-translation/src/index.ts:96`). **Why it transfers to August**: August's settings can change mid-turn (a brain key, a model selection, a provider credential); a stale client must not be allowed to send a request against superseded configuration, and the failure should be explicit rather than silently coerced.

- **A per-item acknowledgement protocol for a pushed stream, with an explicit "the stream ended" error** — `packages/experimental/client-ui-voice-input/src/client/readiness.ts:27` — `ctx.remote.$stream({open, ended: () => new RemoteStreamCarrierError(...), carrierFailed: fail})` and every item is `accept()`ed; the transport failure is kept *separate* from the Host's readiness so one never rewrites the other. **Why it transfers to August**: August's SSE and WebSocket surfaces need the same three-way separation (content / transport error / end-of-stream), and the "a stream that ends is a failure, not a quiet end" rule is the one that keeps a UI from showing stale state forever.

- **A browser-local preference, validated on read, independent of the Host's settings** — `packages/experimental/client-ui-voice-input/src/client/microphone-device.ts:14` — a malformed persisted object is replaced rather than trusted, and the device choice never reaches the Host. **Why it transfers to August**: August has several "this is a property of my browser, not of the server" settings; persisting them in the client store with a read-time shape check is a five-line pattern that removes a whole class of "why is it asking for a device that does not exist" bugs.

- **A transcript is inserted into the draft and never auto-sent; a changed draft keeps it for explicit insertion or discard** — `packages/experimental/client-ui-voice-input/src/client/VoiceInput.tsx` (the `captureInsertion()` draft revision and the `feedback` phase) and the README's "No automatic send" — the model only ever sees the text when the user submits. **Why it transfers to August**: August's voice input, its BTW/Live affordances and its "insert text" tools should all share this rule — a machine-produced insertion is a *draft*, never a submission, and a concurrent edit must not lose it.

- **A button press carries the generation it was drawn in, so a stale control is refused** — `packages/experimental/client-ui-claude-code-mods/src/client/mount.ts:102` (`pressBand(sessionId, generation, actionId)`) and `src/client/Band.tsx:79` (a Button with no action id is drawn but never pressable) — plus the locale key `press.stale`. **Why it transfers to August**: any UI that renders a *snapshot* of state and then acts on it needs a generation/etag so the action can be refused if the state moved on; this is the UI-side twin of the coordinate binding above.

- **A panel that is entirely projection-derived and performs no RPC at all** — `packages/experimental/client-ui-agent-team/src/client/mount.ts:26` ("this registration performs no Team RPC") — every row comes from `projectionsBySession[lead].values.agentTeam` in the shared Session store, so "Opening the panel performs no projection requests" and updates arrive while the panel is open. **Why it transfers to August**: August's own projection machinery (the `agentTeam` projection, the `modelSelection` projection) is the same shape; a panel that reads projections instead of polling an endpoint is both cheaper and always consistent, and the *read-only* property can be asserted structurally (`expect(card.querySelector('button, input, select, textarea')).toBeNull()`).

- **Reserve the exclusive provider name before the expensive startup, and hold it through the teardown** — `packages/experimental/computer-use-cua-driver-mcp/src/index.ts:62` (one ordered effect: "separate fiber effects unload concurrently and could otherwise admit another live driver") and `packages/experimental/computer-use-cua-driver-native/src/index.ts:59` (the registration is taken before the native library is even imported — the spec asserts `fixture.creates === 0` after a second provider fails). **Why it transfers to August**: August has exclusive resources (the permission preset, the computer-use provider, a browser attachment). The rule is: take the lock *first*, take it *around the whole lifecycle*, and never release it in a separate effect that could race.

- **A band that is drawn but not pressable, and a store that is dropped when its stream ends** — `packages/experimental/client-ui-claude-code-mods/src/client/Band.tsx:79` and `packages/experimental/client-ui-claude-code-mods/src/client/mount.ts:52` ("`onEnd` runs then, so the next subscriber opens a fresh stream instead of reading a stale store") — the second is the general rule for every Host-stream-backed browser store: when the stream ends, the store must be *forgotten*, not merely emptied.
- **Small, honest, tested error taxonomies**: `packages/experimental/cua/src/native-client.ts:21` (`NativeError` with a stable code and the code in the message), `packages/experimental/client-ui-voice-input/src/client/audio.ts:4` (`RecordingError` whose kind *is* the locale key), `packages/experimental/api-speech-to-text/src/types.ts:5` (a typed `RemoteErrorDetailsMap`), and `packages/experimental/cua/src/protocol.ts:122` (results whose shape states what is *not* known). Every one of them is a small, transferable discipline: a stable code the model and the log can both branch on, and a result shape that says what is unknown.

## Files skipped (with reasons)

None. Every one of the 245 files in the shard was opened and read. The largest files (`packages/experimental/auto-review/tests/auto-review.spec.ts`, 1832 lines; `packages/experimental/cua/tests/api.spec.ts`, 588 lines; `packages/experimental/browser-use-runtime/tests/mcp.spec.ts`, 613 lines; `packages/experimental/cua/tests/native-client.spec.ts`, 475 lines; `packages/experimental/client-ui-voice-input/tests/microphone-picker.client.spec.tsx`, 466 lines) were read in two or three chunks rather than in one, and the mid-file regions that the first read truncated were re-read explicitly so that no note rests on an unseen line. No file was generated, vendored, binary or large enough to skip; the biggest asset in the shard is `packages/experimental/client-ui-voice-input/src/client/locales.ts` at 216 lines and the largest binary-ish file is a 1 KB SVG icon.

## Uncertainties

- **The manifest's `note` column is empty for every row of this shard**, so I have no author-supplied hints to compare my notes against; every note above is derived from the file itself.
- **I did not read anything outside the shard.** The shard references many packages that live in other shards (`dsh-llm`, `dsh-agent-loop`, `dsh-tools`, `dsh-mcp-client`, `dsh-scope`, `dsh-session`, `dsh-user-questions`, `dsh-attachment`, `dsh-computer-use`, `dsh-speech-to-text`, `dsh-translator`, `dsh-agent-team`, `dsh-claude-code-mods`, `dsh-permission-presets`, `dsh-app-boot`, `dsh-cua-macos`). Where I describe their behaviour I did so **only** from what the shard's own files assert about it (docstrings, comments and test expectations). Specifically: I could not verify the real implementation of `TypertRemoteService`/`@Remote`, `SessionResources`' cooperation with `dsh-agent-loop`'s creation rollback, the MCP client's reconnect and image-admission internals, `dsh-scope`'s scope-tag mechanism, the translator's persistence, or the `dsh-agent-team` projection producer — I only read this shard's *consumers* of those behaviours.
- **`packages/experimental/cua` is platform-specific but the platform provider is not in this shard.** `packages/experimental/cua/README.md` points at `../cua-macos/README.md` for the actual native implementation and at `docs/subsystems/...`; I did not open either, so the macOS helper's behaviour (Accessibility APIs, `launchApp`, the CDP/AX wire format) is known to me only from `src/protocol.ts` and `src/native-client.ts`.
- **Two files' full bodies I read in two passes.** `packages/experimental/auto-review/src/index.ts` (738 lines) and `packages/experimental/cua/src/index.ts` (332 lines) were re-read end to end after the first read truncated their middles; the *tails* of `packages/experimental/auto-review/src/index.ts` (lines 720–738) and `packages/experimental/cua/src/index.ts` (lines 310–332) were seen only in the first read's tail excerpt — I read the former's tail and the latter's tail in the same pass as the middle, and both are covered by the notes.
- **The `BrowserUseProviderName` / `ComputerUseProviderName` brands and the `dsh-browser-use` "exclusive provider registration" service are outside the shard.** I verified only that the providers call `ctx.browserUse.register(...)` / `ctx.computerUse.register(...)` and that a second registration throws "already registered" (as asserted by the shard's own specs); I did not read the registry implementation.
- **`packages/experimental/browser-use-runtime/src/mcp.ts` has 220 lines and I read all of them**, but the interaction between its `refreshBlockedMasks` scope-restriction and `dsh-tools`' scope API is described only by the code's own comments; the exact "restrict/deny" semantics live in `dsh-tools`, outside this shard.
- **The `cua` package's `WINDOW_CHANGED` error code is mentioned in `packages/experimental/cua/README.md:38` but does not appear in `src/protocol.ts` or `src/coordinates.ts`** — the coordinates code emits `STALE_SNAPSHOT`, `SCREENSHOT_REQUIRED` and `INVALID_ARGUMENT` only. I could not establish where `WINDOW_CHANGED` is raised; it may live in the macOS provider, or the README may describe an intended behaviour. I flagged it rather than reconciling it.
- **I did not run, build, install or execute anything** from the clone, per the assignment. The behavioural claims in the notes are read from the source and its test expectations, not observed.
