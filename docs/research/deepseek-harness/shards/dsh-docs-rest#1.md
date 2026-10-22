# deepseek-harness / dsh-docs-rest#1

## Shard shape

This shard is the **whole `docs/` tree of the `deepseek-harness` repository except two files** (`docs/persistence-catalog.zh.md` and `docs/cordis-api/inherited.md`'s siblings — see Uncertainties), i.e. 149 files: 48 `.i18n.yaml` bilingual-pairing records, 40 `.zh.md` Simplified-Chinese counterparts, and 61 substantive Markdown/JSON sources. There is **no source code in this shard** — it is the harness's *narrative and reference* layer, and it is unusually load-bearing because the repo treats documentation as a **gated artifact**: `docs/AGENTS.md` defines a tier taxonomy ("one home per fact"), word budgets enforced by `scripts/doc-budgets.manifest.json`, and generated catalogs that are *verified fresh* by `pnpm run doc-sync` on every PR. The shard holds four functional clusters: (1) the **architecture and agent-loop contract** (`architecture.md`, `agent-lifecycle.md`, `glossary.md`, `event-producer-consumer.md`, `capability-seams.md`, `module-graph.md`) describing a Cordis-microkernel harness whose loop is `turn → step → tool-call` over an append-only Session log; (2) the **extension/authoring manuals** (`cookbook/*`, `defensive-patterns/*`, `cordis-tutorial/*`, `cordis-api/*`, `cordis-primer.md`) that teach how to add a tool, an LLM adapter, a package, a Remote API, a Session format version, and a settings card; (3) the **generated reference catalogs** (`config-catalog.md`, `persistence-catalog.md`, `event-producer-consumer.md`, `cli-help.md`, `dependency-catalog.json`) that are machine-produced from source and freshness-gated; and (4) the **bilingual machinery** (`i18n/*` plus every `.i18n.yaml`), which is itself a small distributed system: per-heading-section content hashes let Git's default text merge compose two-language edits. Everything a reader needs about the DeepSeek harness's reasoning, tool-calling, prompt, compaction, subagent, and reliability behaviour is stated *here*; the code itself lives in `packages/` (other shards).

## Per-file notes

### docs/agent-lifecycle.md
- Purpose: The curated Mermaid sequence diagram that is the visual companion to `architecture.md#turn-flow` — the authoritative statement of the agent turn/step lifecycle.
- Key abstractions: `Session` (durable log), `Driver` (the agent-loop), `Prompt` (`ctx.systemPrompt`), `LLM` (`ctx.llm`), `Tools` (`ctx.tools`), `Hook listeners`.
- Data flow: `followup` → inbox splice/insert → driver wakes → `turn/start` → claim next-step input + one queued prompt → `system-prompt/assemble` waterfall → `agent/pre-step` waterfall → `step/start` → `agent/request` waterfall → `prepareCall(config, signal)` → `system/message` + `user/message` → derive and freeze the request from the log → `llm/stream` waterfall → `agent/assistant-stream` chunks → `assistant/message` (success) or `assistant/attempt` (failure) → classify pending call by executionMode → `tool/call` → `tools/pre-execute` → execute → `tools/post-execute` → `tool/result` → `step/end` → `agent/turn-stopping` (serial) → `turn/end`.
- Non-obvious design decisions: (a) "cancellation during either async phase commits neither system nor users" (line 37) — `prepareCall` and `agent/request` both run before anything is logged, so a cancelled attempt leaves no orphan prompt; (b) retries happen **inside the open step** and "reconcile the same rendered assembly without repeating pre-step or users" (line 51); (c) `assistant/message` records *every* successful provider call including content-less and max-tokens finishes, while a failed/retried/cancelled attempt records `assistant/attempt` (line 83); (d) live `agent/assistant-stream` chunk frames are transient, so a hard process loss before settlement leaves no durable attempt stream.
- Edge cases / failure handling: `dsh-compaction-basic` uses `agent/pre-step` for *pressure* and `agent/request-error` only for *canonical context overflow* (line 85); recovery retries only when pruning or summarization advances the surface-replacement generation, otherwise the original request error stays authoritative.
- Surprising: "Empty content stays out of derived history" while the message itself is still logged (line 83) — the log is a superset of model history.

### docs/AGENTS.md
- Purpose: The documentation standard — document structure, Markdown tiers, writing rules, and `verify-doc-budgets` ceilings. It is the constitution every other doc in this shard obeys.
- Key abstractions: the **tier taxonomy** (lines 19–34): root `AGENTS.md`, subtree `AGENTS.md`, `architecture.md`, `subsystems/`, Agent Notes, `defensive-patterns/`, `postmortem/`, persistence history, `cookbook/`, `user/`, package README, `development.md`, generated reference, skills.
- Data flow: a fact is written once in the tier whose *job* it is; everywhere else links there. Placement map at line 36: bugs → postmortems, rationale → Agent Notes, procedures → cookbooks, type definitions → subsystems, package contracts → READMEs, standing orders → root `AGENTS.md`, review-enforced rules → `defensive-patterns/`.
- Non-obvious design decisions: the rule is "**one home per fact**" (line 17) and the *ceiling* is a relocation budget, not a reduction target — "Ceilings are guardrails, not reduction targets. At or below target, retain at least 5% headroom" (line 59). A too-low ceiling is itself called a bug.
- Edge cases / failure handling: the **slop checklist** (lines 61–73) is the self-audit: duplicated rules, history outside its tier, implementation-status annotations, hand-restated catalogs, reasoning transcripts, paragraph walls, emphasis inflation, spec-speak in `implemented/` notes.
- Surprising: prose is written in **one physical line per paragraph** (line 42, `verify-md-wrap`) — soft-wrap, not hard-wrap — and ` ```ts ` fences must actually compile (`doc-typecheck`), with ` ```ts type-equiv ` / ` ```ts public-api ` as the drift-guarded variants.

### docs/api-gateway.md
- Purpose: Current-state reference for the Typert API Gateway — how business services declare unary and stream Remote methods, how the build generates Host and Client contracts, and how calls reuse the Connection RPC and `/api` route.
- Key abstractions: `@Remote` / `@RemoteScope` decorators; `TypertLookupMap` (wire identity ↔ Host object); `RemoteStream<Out, In>`; `RemoteResult<T>`; `ctx.remote.$host`; the `TypertRemoteService` base vs `bindTypertRemote(this, serviceKey)`.
- Data flow: business package writes `@Remote` → Host tsdown pass runs the Typert generator over `tsconfig.host.json` → emits `typert.host.js/.d.ts` (Host) and `typert.remote-client.js/.d.ts` (Client) into the package's own `lib/` → `api-remotes` mounts the contribution via `ctx.remote.$mount()` → client calls `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)` → `POST /api/<namespace>/<method>` → Gateway resolves descriptor + live service, validates `args` against the strict schema, resolves lookups/Contexts, invokes → `ctx.remote.<ns>.<method>()` returns `RemoteResult<T>`.
- Non-obvious design decisions: the two **build faces are never in one `ts.Program`** (line 98) because Host and Client both declaration-merge the Cordis `Context` under the same keys with different services; the generator only runs during the *Host* pass and the Client pass consumes its output (line 102). A strict endpoint withdrawn on the Host "does not degrade to SRC inference, preventing a hot unload from silently weakening validation" (line 134).
- Edge cases / failure handling: a refused call (Peer is not the owner) "resolves no lookup and activates no Agent" (line 130) — the access check runs *before* any side effect; a disposed Peer is refused with `gateway/peer-disposed`; `ctx.remoteAccess.decide()` must name every resource the call touches, and an unfiltered aggregate is a defect. The **SRC fallback** (lines 136–142) is a deliberately weaker descriptor path for source runs: it parses parameter names from the live function, does *not* read TypeScript types, generate Zod schemas, or infer optional parameters.
- Surprising: the client "uses concrete functions on ordinary objects, not a JavaScript Proxy" (line 62).

### docs/architecture.md
- Purpose: The ordered system map — composition, core packages, loop, seams, extension points. Explicitly "read before changing anything under `packages/`".
- Key abstractions: **profile** (named composition in Harness home) vs **bundle** (distribution format for Cordis config rows + code); **capability seam** (Service Definition / Provider / Consumer); core packages table (lines 57–65): `core/session`, `core/system-prompt`, `core/tools`, `core/agent`, `core/agent-loop`, `core/scope`, `llm/llm`.
- Data flow: the turn flow pseudo-code at lines 83–104 is the whole loop in 22 lines: claim → assemble → `agent/pre-step` → `step/start` → `agent/request`/`prepareCall` → reconcile `system/message` → append `user/message` → `request/header`/`request/context` → derive & freeze model history from the log → stream → tool calls → `step/end` → repeat while tools owe another request or next-step input arrived → `agent/turn-stopping` → `turn/end`.
- Non-obvious design decisions: (a) "**Model-visible means logged.** Every model request must be reconstructable from the log" (line 124) — new model-visible inputs *require* session events; (b) the **prompt travels only as `system/message` history** and "The first admitted step reserves the system head before user messages even for an empty prompt (no wire message)" (line 110) — an empty rendering clears all active system nodes, capable routes *append* non-empty updates after cached history, incapable routes *consolidate* at the first node. This is the repo's KV-cache strategy expressed as a data rule, not a tuning knob; (c) Session generations are append-only: "committed generation paths are never renamed, replaced, or deleted" and a write open "first encodes, verifies, and exclusively publishes the final version-named successor beside the unchanged source" (line 122); (d) `agent/pre-step`, `agent/request`, `llm/stream` and the three `tools/*` events are **waterfalls** whose listeners must call `next()`, while `agent/turn-stopping` is serial and has no `next()` (line 106).
- Edge cases / failure handling: cancellation during either async phase commits neither system nor users; retries do not repeat assembly or `agent/pre-step`; surface replacements and image-offload decisions start a *new request series* while an unchanged resume continues the series (line 110); a header-only `stat`/`list` rescans the directory and translates a supported historical header *without loading events or publishing a successor*.
- Surprising: there is no privileged core — "you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads" (line 11).

### docs/capability-seams.md
- Purpose: Hybrid-generated graph + table classifying every `ctx.*` service as `core` spine, `seam` (swappable capability), `bundle`/`composition point`, or standalone `service`, with owner, implementations, direct consumers, and a one-line note per service.
- Key abstractions: the four service roles; a Mermaid graph with package→service and service→consumer edges (lines 297–609), then the table (lines 612–712).
- Data flow: the table is the answer to "who can replace this?" — e.g. `ctx.shell` (`capability-seams.md:686`) is a seam with three implementations (`bash-local`, `bash-sandbox`, `pwsh-local`) consumed by `tool-bash`, `tool-pwsh` and the two hook bridges, so "sandboxed, remote, or PowerShell executors replace bash-local without touching them".
- Non-obvious design decisions: the classification is done by `scripts/gen-doc-graphs.ts` "with a completeness guard" (line 714) — a service that appears in code but not in the table is a generator failure, not a doc omission. The `ctx.fs -. event gate .-> pkg_fs_observation_policy` edge (line 609) is the only dashed edge: it marks an *event* relationship rather than a service dependency.
- Edge cases / failure handling: the note column states the enforcement boundary per service, e.g. `ctx.approval` "absence fails closed to `unavailable`" (line 691), `ctx.sandboxPolicy` is "the one home for the deployment default mode + workspace root ... Both enforcing families read it so bash and fs cannot confine to different roots" (line 690), `ctx.spillStore` "the tools/post-execute consumer that decides when to spill" is a *different* package from the storage backend (line 703).
- Surprising: `ctx.tools` is `core`, not a seam (line 671) — the *registry* is core while each capability (`ctx.shell`, `ctx.fs`, `ctx.web`, `ctx.subprocess`, `ctx.sandbox`) is a seam beneath it.

### docs/cli-help.md
- Purpose: Generated, complete `--help` output for the launcher, subcommands and shipped profiles; "Identical help appears once with every invocation listed."
- Key abstractions: the launcher contract: `dsh [--profile] <name> [options] [app-args...]`, `dsh plugin --profile <name> <pnpm-args...>`.
- Data flow: flags documented here are the only supported surface — `--profile`, `--from-default-profile`, `--patch`, `--dump-config`, `--dump-config-schema`, `--dump-default-config`; `dsh web` adds `--host/--port/--public-url/--trusted-host/--tls-cert/--tls-key`.
- Non-obvious design decisions: `--host` accepts "one concrete IPv4 or IPv6 literal of a local interface; **wildcard addresses are rejected**" (line 177) and `--public-url` "grants no trust" (line 184) — the flag is presentation, the trust fence is `--trusted-host`.
- Edge cases / failure handling: `dsh headless --session-id <id>` adopts a persisted Session and "an unknown id is an error"; `--json` switches stdout to newline-delimited run events so "the answer goes to stdout and diagnostics to stderr" (line 108).
- Surprising: `dsh --profile sdk-minimal` is a *deliberate* exception — a standalone bundle that does not apply `dsh-base` (see `architecture.md:23`).

### docs/config-catalog.md
- Purpose: Generated **deployment-axis** reference — for every loadable harness package, the verbatim config declaration (JSDoc included) its `apply` receives, plus pasted or linked referenced types.
- Key abstractions: per-package `inject` (service keys the plugin needs), `refs` (referenced types not pasted), `source` (declaring file). The generator cross-checks the runtime schemastery schema against the pasted type so "the paste cannot hide a loader-accepted field" (line 8).
- Data flow: `cordis.yml` `config:` block → schemastery validation → `apply(ctx, config)`. Fields marked `Volatile<T>` are live-editable references; `role('secret')` fields are write-only.
- Non-obvious design decisions: the **compaction policy** (`config-catalog.md:704–723`) is the repo's context-window contract: `thresholdRatio` 0.8 of the window, `headroomTokens` 65536 on top of the routed output reservation, `retainRatio` 0.16 of (window − reserved output), `compactionRetries` 1 extra attempt when pressure persists, `maxOverflowRetries` 1 after canonical context overflow (`0` disables), and `summarizationProvider`/`summarizationModel` must be set *together* or inherit the conversation target. `modelPolicies[]` gives exact provider/model overrides that fail plugin load on duplicates.
- Edge cases / failure handling: `repeat-tool-reminder` (`config-catalog.md:2609–2633`) is the loop detector — thresholds `[3,5,8]`, `include`/`exclude` are `*`-wildcard predicates over tool names at call time (a pattern matching no registered tool is legal), and "the cap bounds the reminder, never the detection (the chain key always compares the FULL canonical string)". `spill-policy` bounds a retained result by `maxInlineTokens`. `compaction-tool-result-pruner` keeps head 4096 / tail 1024 code points once a result passes 8192.
- Surprising: `dsh-llm-retry` has **no config at all** — "This policy executor has no config; providers own `retryPolicy`" (`config-catalog.md:2138`): the retry policy belongs to the provider, the executor only enforces it. `dsh-tools` offers `mode: 'native' | 'ptc'` where PTC collapses the whole tool surface to `run_code` plus a generated SDK prompt (line 4228).

### docs/cordis-primer.md
- Purpose: Five-idea concept primer for the vendored plugin framework: plugin = object implementing Service; context = service repository; `inject` declares dependencies; typed events; **registrations are reversible effects**.
- Key abstractions: the five dispatch modes table (lines 19–25): `emit` (sync, no await, no value), `waterfall` (no await, value), `parallel` (awaited, no value), `serial` (awaited, in order, first bail value), `bail` (sync first-bail).
- Data flow: `ctx.on(...)` / `ctx.provide(...)` / `ctx.effect(...)` return disposers owned by the current fiber; unloading unwinds them in reverse order.
- Non-obvious design decisions: "**The dispatch mode is part of the event's public contract.** New harness events document it with an `@mode` tag so the generated catalog can check declarations against dispatch sites" (line 27) — a static check that a declared mode matches the actual dispatch call.
- Edge cases / failure handling: waterfall discipline — "a listener that only annotates or observes must delegate" (line 35); returning without `next()` is a deliberate short-circuit and silently swallows the default behaviour for everyone downstream.
- Surprising: `!!js` in a Loader entry is parsed into an expression node, and `disabled` is evaluated "at every mount decision, against the loader context" (line 39) while the rest of the entry metadata stays literal.

### docs/deepseek-llm-api-wire-extensions.md
- Purpose: Defines every DeepSeek-Harness-specific HTTP header and additive JSON field the `dsh-llm-deepseek` adapter sends on `deepseek-official` Messages requests.
- Key abstractions: `DeepSeekLlmApiExtensionRegistry` (one provider per top-level extension name); two shipped fields — `dsh_plugin_packages` (active Loader-backed npm inventory) and `dsh_session_log` (a contiguous suffix of the canonical Session log).
- Data flow: adapter serialises the **complete base body including the exact `messages`** → providers *prepare* fields against that immutable body → prepared JSON values are detached and merged as top-level siblings → one HTTP body → on HTTP 2xx the adapter runs the prepared `accept()` transaction **before reading the SSE response body**.
- Non-obvious design decisions: (a) "They remain outside `messages`, system prompts, and tool schemas, so they do not add model-input tokens or alter the model-visible prefix" (line 7) — the extension mechanism is deliberately KV-cache-neutral; (b) each body extension owns its `version` independently, "no compatibility or ordering relationship exists between versions of different fields" (line 18); (c) a contributor whose preparation fails is **omitted from that request** while the other fields are still sent, and a merged body that fails to serialize sends the base body with *no* extension field and skips acceptance "so contributors resend their state on a later request" (line 37).
- Edge cases / failure handling: acceptance records endpoint-level HTTP success only — "it does not assert that an SSE stream completed or that the endpoint persisted an extension" (line 39), and an acceptance failure is logged and does not fail the model request. The watermark folds the **greatest matching `throughSeq` for the current Session id *and* format generation**, so concurrent accepted requests cannot move the cursor backward and a watermark from another generation cannot authorise the current suffix (line 154). A fork ignores inherited watermarks naming another Session and re-uploads its own inherited prefix from sequence zero.
- Surprising: delivery is **at-least-once**: "A crash after endpoint acceptance but before local persistence may resend an already accepted range; uncertainty produces duplicates, never a sequence gap" (line 156). `maxBytes` defaults to 8 MiB counted in UTF-8 bytes *including* the header and numeric fields, so a backlog above the limit simply spans several accepted requests (line 113).

### docs/development.md
- Purpose: Setup tutorial + contributor reference: repository layout, daily workflow, CI organisation.
- Key abstractions: the **two-aggregate TypeScript project layout** — `tsconfig.host.json` and `tsconfig.client.json` as separate programs, `tsconfig.base.json` as a shared resolution facade with no `include`, `tsconfig.json` as a solution root (lines 61–75). Three disciplines follow: base never gains `include`/`files`; a repo-wide `ts.Program` seeds one aggregate explicitly; a new package is registered in exactly one aggregate.
- Data flow: `build:artifacts` = native system → `tsc -b` host refs → `tsdown --env.DSH_BUILD_FACE host` → desktop bundle → `tsc -b` client refs → `tsdown --env.DSH_BUILD_FACE client` → `build:web` (lines 79–87). `DSH_GATE_CONCURRENCY` bounds concurrency; `DSH_GATE_FAIL_FAST=1` stops at the first failure, otherwise a failure skips only its dependents so independent errors are all reported.
- Non-obvious design decisions: Host and Client stay two aggregates "because both sides declaration-merge the cordis `Context` interface under the same keys with different services; one program seeing both merges reports a collision" (line 69) — a collision that exists only inside a `ts.Program`, never in module resolution. The root `tsconfig.json` is still the tsserver discovery entry and the resolution config for tsx running `scripts/`.
- Edge cases / failure handling: `build:check` "neither detects nor rebuilds missing or stale `build:artifacts` output; missing output surfaces as compiler errors" (line 89). A successful `build`/`build:artifacts` writes a gitignored record binding the public version/dirty marker to the Vite output, and "release packing and built Web tests reject a missing record or artifacts changed by a later partial build" (line 108). `dev:web` deliberately does *not* validate that record because the watcher stages rewrite it.
- Surprising: the repo's own `pre-commit` hook runs pairing records, a project-free oxlint profile, whitespace checks, pi-ai provider metadata and the vendor manifest guard — but deliberately **no** tests, snapshots, doc checks, builds or hygiene; CI owns those (line 147).

### docs/event-producer-consumer.md
- Purpose: Generated matrix mapping every harness-owned event to its mode, declaring package, dispatchers, and listeners — the answer to "who may I listen to, and what breaks if I change this event?".
- Key abstractions: the three event domains — durable **session events**, live **agent events** (`agent/*`), and **capability events** (`fs/*`, `tools/*`, `telemetry/*`); a second table for "non-harness or undeclared event strings seen in package source" (lines 98–107).
- Data flow: for each event, `Declared in` (file:line) → `Dispatchers` (package + the dispatch method) → `Listeners` (every package that subscribes).
- Non-obvious design decisions: the matrix is **many-to-many**, so it is rendered as a table rather than one giant graph (line 6), and it deliberately covers "contained dispatch sites that deliberately bypass `ctx.emit`, such as subagent lifecycle containment" (line 6). The mode column is checked against the actual dispatch call, so a declaration that says `waterfall` but dispatches with `emit` is a generator failure.
- Edge cases / failure handling: high-fanout events are the load-bearing ones — `session/event` has 20+ listeners (line 67), `agent/pre-step` has 15 including `compaction-basic`, `plan-mode`, `repeat-tool-reminder`, `session-checkpoint-policy` and `tool-skill` (line 20), `tools/execute` includes `timeout-policy` (line 78), `tools/post-execute` includes `spill-policy` and `repeat-tool-reminder` (line 79), `agent/request-error` has exactly three listeners: `compaction-basic`, `compaction-image-offload`, `llm-retry` (line 22).
- Surprising: `llm/stream` is a **waterfall**, so the model call itself is interceptable (line 57) — as is `system-prompt/assemble` (line 75), which is what makes compaction and prompt-sections possible without touching the loop.

### docs/experimental-persistence-catalog.md
- Purpose: Small generated catalog of `PluginRecordMap` declarations — ignorable, log-only records owned by experimental packages.
- Key abstractions: `plugin:<owner>/<record>` namespacing; "Records stay outside the known-event set, persistence schema fingerprints, and compatibility history" (line 8).
- Data flow: two entries today — `plugin:translator/request` and `plugin:translator/result`, both owned by `@deepseek-ai/dsh-experimental-translator`.
- Non-obvious design decisions: format migrations retain these records on a **best-effort** basis — an experimental package's record may be dropped by a format bump, and that is acceptable because the record is explicitly outside the compatibility history.
- Edge cases / failure handling: a plugin record that is in neither this catalog nor the known-event set is still carried forward if the target format can represent it (see `cookbook/adding-a-session-format-version.md:61`).
- Surprising: the whole file is 17 lines — the experimental surface is deliberately tiny, and the catalogue exists mainly to say so.

### docs/glossary.md
- Purpose: One canonical term per concept, with implementation detail left to package READMEs and Agent Notes.
- Key abstractions: **seam** (Service Definition / Service Provider / Consumer, "never a TypeScript `interface`"); **scope** (global vs scoped, two flat levels, "scoped registrations do not inherit down to subagents; subtree behavior is expressed with *lineage* data, never scope structure"); **shadowing** (most-specific-wins); **lineage** (parent/child facts carried as data, "never affects visibility"); the **loop hierarchy** (turn / step / round / exchange); **Ralph** (loop / round / handoff).
- Data flow: a term is an anchor-linked definition; the file is the vocabulary the other docs in this shard depend on.
- Non-obvious design decisions: the **scope** model is deliberately flat and two-level (line 13) — depth comes from data, not from the scope tree, so a subagent's parent is not a scope ancestor. "A filtered-away global tool is absent from the prompt **and** refuses execution, indistinguishably from a nonexistent one" (line 19) — the tool surface is filtered as a *set*, not as a display. Goal **activation** is "deliberately absent from durable replay, so resume and fork require a later human-authorized resume mutation" (line 27).
- Edge cases / failure handling: the **exchange** unit (line 40) exists precisely because "turns woken by notices, such as settled subagents, goal rounds, or schedules, stay in the preceding exchange" — a UI folding rule that needs the boundary defined.
- Surprising: the **Ralph handoff** (line 46) is "a normalized bounded structured report … containing status, summary, evidence, next steps, and blocker text" — a fixed inter-round contract that supplements the shared workspace rather than replacing it as authority.

### docs/graph-atlas.md
- Purpose: 22-line index of the seven relationship diagrams, each labelled with its maintenance mode: `generated`, `hybrid generated`, or `curated`.
- Key abstractions: module dependency graph, tool schema catalog, capability seams, shared base composition, event producer/consumer matrix, agent turn/step lifecycle, tool execution pipeline.
- Data flow: `pnpm run gen-doc-graphs` regenerates; `pnpm run verify-doc-graphs` checks freshness. Each linked page declares its own mode.
- Non-obvious design decisions: mixing `generated` and `curated` in one index is allowed because "each linked page declares generated, hybrid, or curated mode" (line 22) — the mode is a property of the page, not of the index.
- Edge cases / failure handling: "Exact signatures and type definitions still live in the subsystem pages … and tool-catalog.md" (line 6) — the atlas deliberately does not duplicate.
- Surprising: the index links to `../apps/cli/composition.md`, a diagram living outside `docs/`.

### docs/i18n/README.md
- Purpose: The bilingual pairing contract — what a pair is, what the gate checks, scope and exclusions, division of labour.
- Key abstractions: a pair is **three sibling files** (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`) in the same directory; the consistency record holds one entry per heading section keyed by its English heading-slug path, with a hash of that section's English and Chinese blocks excluding fenced code and generated regions.
- Data flow: edit either side → patch the counterpart minimally against the edited side's diff → `pnpm run verify-translation-pairing --write <pair>` re-records the yaml → "that yaml diff is the reviewable act of confirming consistency, which is why `--write` requires naming the pairs you confirmed" (line 22).
- Non-obvious design decisions: the hash granularity is **per heading section**, not per file, so "edits to different sections change separate record lines, so Git's default text merge, including GitHub's, composes them" (line 22) — bilingual docs merge like any other file. A record conflicts only when both branches changed hashed content in the same section. The recorded hashes are of *content blocks*, so a regenerated region or a code block edited on both sides leaves the record unchanged.
- Edge cases / failure handling: the gate's own limit is stated: "**a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound.** It checks hashes and Markdown structure; it cannot judge whether the two sides say the same thing" (line 44). Excluded files (generated `cordis-api/inherited.md`, `docs/AGENTS.md`, archived Agent Notes, `translation-prompt.md`) must have no `.zh.md` and no `.i18n.yaml` at all.
- Surprising: the switcher rule is asymmetric by design — "an authored English file reciprocates there with `English | [中文](foo.zh.md)`; a listed generated English source omits that line so it remains byte-identical to generator output" (line 25).

### docs/i18n/terminology.md
- Purpose: The bilingual terminology source of truth — a four-column table (English / 中文 / 首次出现 / 不要译作) with a remarks column.
- Key abstractions: three classes — abbreviations used in both languages (ACP, CI, LLM, SSE…), terms kept in English in both (agent, seam, subagent, waterfall, transcript, KV Cache, Typert), and bilingual terms (capability→能力 vs feature→功能, compaction→压缩, reasoning vs inference→推理 both, provider→提供方 vs model provider→模型提供商).
- Data flow: load the table before translating; every listed term MUST follow its row and its "不要译作" prohibitions; a decided term enters this file in the same PR.
- Non-obvious design decisions: the "不要译作" column is a **hard prohibition list** with real teeth — `seam` must not become 接缝, `feature` must not become 能力 (and vice versa: `capability` must not become 功能), `Round` must not become 回合, `stale` must not become 过期 (only `expired` may), `postmortem` must not become 事后分析. First-occurrence annotation is a *one-shot*: a term glossed inside a compound (`agent loop（智能体循环）`) is not glossed again.
- Edge cases / failure handling: an unlisted technical term MAY use an established rendering from a major Chinese-language OSS or vendor source *cited in the PR*; without such precedent it MUST stay in English and be filed under 「待定术语」.
- Surprising: `Typert` is a product spelling with the explicit prohibition "TypeRT、typeRT、Type RT" — the glossary is partly a brand-protection list.

### docs/i18n/translation-prompt.md
- Purpose: The **machine-consumed prompt template** for the automated translation pipeline; it is deliberately excluded from bilingual pairing because its body enters a model request verbatim.
- Key abstractions: three placeholders only — `{{source_lang}}`, `{{target_lang}}`, `{{terminology}}`; the whole-document few-shot set (5 human-reviewed EN↔ZH pairs) is injected as example turns after the system message; the model must emit exactly three raw XML sections — `<translation>`, `<review>`, `<final>`.
- Data flow: the pipeline renders the template with the current terminology table, injects the gold pairs, sends the source document, parses `<final>`, then mechanically inserts or corrects the language switcher for a brand-new pair.
- Non-obvious design decisions: the output format is a **two-pass self-review** — the model writes `<translation>`, then re-reads it "in the target language only without comparing it with the source" (a trick to catch awkward phrasing), then compares clause by clause, writes only *actual* corrections to `<review>`, and emits the corrected whole document in `<final>` (lines 153–199). Priority ordering is explicit: source meaning and required structure > terminology table > gold-pair voice > general guidance; "A lower-priority rule may refine but never override a higher-priority requirement" (line 49).
- Edge cases / failure handling: framing tags that appear *inside* a section body must be escaped with one extra backslash (line 132); the review section must contain exactly `- 无修正` when nothing needed correcting; unlisted terms are reported as `[Terminology: pending]` in `<review>` with a tentative rendering, which "may appear in `<review>` but must not be silently adopted in `<translation>` or `<final>`" (line 124).
- Surprising: fenced code blocks must be **byte-identical including comments**, and inline code spans are never translated or reformatted — the pipeline treats identifiers as protected tokens even when the text resembles a terminology entry.

### docs/i18n/translation-rules.md
- Purpose: How to translate between the two sides of a pair; binds humans and agents equally, with RFC 2119 rule levels.
- Key abstractions: Faithfulness / Voice / Structure preservation / Terminology / Typography / Quality bar; the "voice" is calibrated by `style-samples.md`, and "where its voice and a prose voice rule disagree, the sample wins" (line 15).
- Data flow: the rules constrain a human or an agent producing the counterpart; the pairing gate enforces only the machine-checkable subset (heading depths, code blocks, table dimensions, list kinds, ordered-list starts, item counts, link locale and targets).
- Non-obvious design decisions: the gate checks *structure*, so the rules state the rest as review obligations — "Human review owns list and table order, noncanonical list numbering, inline code, emphasis, meaning, terminology, and tone" (line 57). The Chinese typography rules are pinned to a named authority set (MDN zh-CN guide, Kubernetes zh-cn guide, Vue.js translation conventions, 中文文案排版指北, W3C clreq, GB/T 15834—2011) rather than invented locally.
- Edge cases / failure handling: "When translating into Chinese, category nouns use Chinese with a first-mention English annotation (实操手册（cookbook）); when translating into English, use the conventional English category name" (line 20). Second person is 你, not 您, matching Vue/Kubernetes Chinese conventions.
- Surprising: Chinese prose "**SHOULD** prefer colons, periods, commas, or parentheses over em dashes" (line 47) — the opposite of the source-language house style, and deliberately so.

### docs/agent-lifecycle.zh.md
- Chinese counterpart of the turn/step sequence diagram; the Mermaid block and every event name are identical, the prose is translated.

### docs/api-gateway.zh.md
- Chinese counterpart of the API Gateway reference; the code samples are identical and the prose uses the terminology table's Chinese column with first-occurrence glosses.

### docs/architecture.zh.md
- Chinese counterpart of the architecture map; the turn-flow pseudocode block and every `ctx` key are identical.

### docs/capability-seams.zh.md
- Chinese counterpart of the capability seam graph and service table; the generated Mermaid and table regions are byte-identical.

### docs/cli-help.zh.md
- Chinese counterpart of the CLI help; the help output blocks keep their original language, only the surrounding prose is translated.

### docs/cordis-primer.zh.md
- Chinese counterpart of the Cordis primer; the dispatch-mode table and the waterfall rule are translated, code identical.

### docs/deepseek-llm-api-wire-extensions.zh.md
- Chinese counterpart of the wire-extensions reference; the JSON payload examples and member tables are identical.

### docs/development.zh.md
- Chinese counterpart of the development guide; the build-order command block and the tsconfig table are identical.

### docs/event-producer-consumer.zh.md
- Chinese counterpart of the event matrix; the generated table rows are byte-identical, only the preamble and the undeclared-strings intro are translated.

### docs/experimental-persistence-catalog.zh.md
- Chinese counterpart of the experimental record catalogue; the two translator record rows keep their English payload descriptions because they are identifiers.

### docs/glossary.zh.md
- Chinese counterpart of the glossary; the term definitions are translated with the terminology table's Chinese renderings and first-occurrence annotations.

### docs/graph-atlas.zh.md
- Chinese counterpart of the graph atlas index; the table of diagrams and their modes is translated, the links point at the `.zh.md` counterparts.

### docs/cookbook/adding-a-tool.md
- Purpose: The tool authoring reference — the contracts a model-facing tool must satisfy.
- Key abstractions: `defineTool({ name, description, parameters, output: { schema, render }, execute(args, exec) })`; `exec` carries immutable identity + token + `signal`; `output.presentationMeta(args, value)`; the card-tagged render intent (`generic | terminal | diff | read | search | web`); the five policy extension points.
- Data flow: registry validates `arguments` against the unified `ParameterSchemaSpec` before `execute` runs → materialises arguments as detached lossless JSON, freezes them, assigns an opaque `exec.token` → executes → snapshots the return value as lossless JSON, validates against `output.schema`, freezes → passes to `output.render(args, value)` → `presentationMeta` output is persisted on `tool/result` and handed to `presentResult` at replay.
- Non-obvious design decisions: (a) "**Declare and return one canonical JSON value**" — `execute` returns the typed value, never content blocks, so "callers [do not] parse prose for ids and fields" (line 45); (b) throwing **or** returning an invalid value means `isError` (line 46), so a successful domain outcome with a non-ideal state is a *value*, not an exception; (c) the **UI presenters must be pure functions** of `args` (+ result) because they run on live streaming *and* on session-log replay — "NO I/O, NO reading session state, NO clock/random" (line 87); (d) `agent.inject()` "appends durable context the NEXT model request sees — it is not a wake-up (an idle agent stays idle)" (line 49).
- Edge cases / failure handling: `defineTool` soft-validates the display path so "display must never crash a replay" (line 89); a pre-aborted background invocation is a *failure* because no task exists whose id could satisfy the successful output schema (line 53); once `ctx.jobs.start()` publishes the id, the producer must use a task-owned cancellation signal rather than `exec.signal`, so "later outer-call cancellation stops waiting for the call but does not kill published work".
- Surprising: **PTC mode reaches every registered tool for free** — `await tools.<name>(args)` with types derived from the same schemas, and a successful call resolves to the final canonical JSON *value* after policy, not the rendered Native content (line 63).

### docs/cookbook/adding-an-llm-adapter.md
- Purpose: How to connect a new model provider; the "protocol obligations (the contract two implementations verified)".
- Key abstractions: `LlmAdapter` subclass with `async *stream(options): AsyncIterable<StreamChunk>`; `ctx.llm.registerAdapter(['my-provider'], adapter)`; `resolveModel()` as the provider-neutral model-metadata seam; `finish.replayState`.
- Data flow: `options.provider` selects the adapter, `options.model` is the provider model id → adapter streams `StreamChunk`s → the runtime consumes them.
- Non-obvious design decisions: (a) "**Emit `usage` BEFORE `finish`; emit NOTHING after `finish`**" and the robust technique — "buffer finish/usage until the provider's end-of-stream marker, then flush (handles providers that send trailing usage-only chunks)" (line 27); (b) tool-call `arguments` are **raw JSON strings** end-to-end and must be re-stringified at `block-end` if the provider hands back parsed objects (line 28); (c) errors have **exactly two sanctioned paths** — THROW from `stream()` for transport/protocol failures, or end the stream with `finish {kind:'error'|'aborted'}` for provider in-band failures — and you pick per failure class and document it (line 30); (d) an option the provider cannot honour must throw `LlmError(..., 'UNSUPPORTED_OPTION')` "rather than silently dropping it" (line 32).
- Edge cases / failure handling: `finish.replayState` carries the minimal lossless-JSON projection a provider needs on follow-up calls, and "`LlmRuntime` passes it only when the historical provider route and target provider route are currently owned by the exact same adapter instance" — "Never infer native replay from provider/model names alone when state is absent" (line 33).
- Surprising: reasoning effort ids are **opaque and ordered**, mapped to provider requests by the adapter; the adapter's selectable list is authoritative, including an adapter-defined `off`, and "an id need not equal its wire representation" (line 35). Thinking-mode toggles stay in the adapter's Config, not in the provider-neutral seam.

### docs/cookbook/adding-a-package.md
- Purpose: The file-by-file checklist for a new `@deepseek-ai/dsh-<name>` package, validated against the bash and adapter packages as templates.
- Key abstractions: the **package topology** decision (Service Definition / Provider / Consumer in separate packages when they evolve independently); the **role-naming table** (lines 52–72) — Controller, Store, Directory, Presenter, Registry, Runtime, Resolver, Binder, Engine, Policy, Executor, Gateway, Provider, Backend, Handle, Config, Service, each with "use it when" / "do not use it when"; the **Model Experience** README contract.
- Data flow: package.json invariants (private, version matching root, `type: module`, `main`/`types`/`exports`, cordis in BOTH peer and dev deps, `files` list) → `tsconfig.json` extends base with `rootDir: src`, `outDir: lib/types` → register in exactly one aggregate → write the README → optional `locale/en.json` display metadata.
- Non-obvious design decisions: the **Model Experience** section (lines 78–110) is the repo's model-context contract: one H3 per model-context entry with three ordered H4 fields — *What the model sees*, *Token effect*, *KV Cache effect* — then a canonical *Known Limitations and Deferred Work* section. "In `KV Cache effect`, distinguish append-only growth, a stable repeated prefix, replacement of earlier request tokens, and an independent model request, then name the package-owned changes that can invalidate reuse" (line 108). A package with no effect uses an audited `None, as ` / `Indirectly, through ` sentence so it still must state its KV-cache effect.
- Edge cases / failure handling: the singular/plural `ctx` key rule (singular for one engine/runtime/policy/controller/resolver/store, plural for a registry or a service owning multiple named members) and "The class role and key number must agree" (line 50). `workspace:*` vs `workspace:~` are decided by the package family (see `defensive-patterns/package-surface.md`).
- Surprising: the *plural* form is not "several instances of one thing" but "a registry or a service that owns multiple named members" — and the guidance is explicitly "Do not name the first implementation, a possible future expansion, or the Cordis base class" (line 48).

### docs/cookbook/extension-cookbook.md
- Purpose: Reference patterns for extension plugin shapes, plus the **feature → mechanism map** that makes the microkernel claim checkable.
- Key abstractions: four plugin shapes (tool, hook/policy, UI, external protocol driver); the waterfall `tools/pre-execute` permission gate; the `ctx.tools.guard()` monotonic denial; `ToolExecution.concludeTurn()`; `ctx.subagents` provider registry.
- Data flow: a UI plugin combines durable `session/event` records with transient `agent/assistant-stream` frames and drives input back via `agent.followup()` / `agent.steer()`; a protocol driver adapts a wire peer to `ctx.agents` and returns the **durable enqueue receipt** rather than correlating a `MessageId` with `turn/end`.
- Non-obvious design decisions: (a) "`system-prompt/assemble` is an expert cooperative whole-assembly transform: its returned assembly is authoritative, so listener authors own preserving active PTC mode and structured-output protocol contributions" (line 102); (b) ToolSearch / progressive disclosure is "replace a scoped `ctx.tools.restrict()` registration as the visible set changes; the registry keeps presentation, lookup, and execution aligned" (line 116); (c) the monotonic terminal-turn policy is `ToolExecution.concludeTurn()` — "later tool calls in the same response remain guardable, and the loop stops after the step" (line 119); (d) compaction is *three* triggers on two events: automatic pressure on serial `agent/pre-step`, canonical overflow recovery on `agent/request-error`, manual callers on the same compact service (line 111).
- Edge cases / failure handling: a low-level prompt request "returns its durable enqueue receipt; it does not acquire a result by correlating `MessageId` with `turn/end`. Publish whole-agent status separately" (line 66) — the anti-pattern of inventing a per-request completion where none exists. Teardown must reach quiescence via `AgentHandle.dispose()`.
- Surprising: `/loop` is implemented as "on the `turn/end` session event, `followup()` the next iteration" (line 108) — a product feature is a listener on a durable session event, not a mode of the loop.

### docs/cookbook/adding-a-remote-api.md
- Purpose: The five steps to add or change a `ctx.remote` endpoint: declare the method, declare its failures, register on the package, consume on the Client, test.
- Key abstractions: `TypertRemoteService`; the `remoteExport*` adapter convention (used only when the shape must change); `RemoteError` + `RemoteErrorDetailsMap` as the *single* failure class; the `<domain>/<reason>` code table; `RemoteResult<T>`; `remoteErrorOf`; `isRemoteFailure`; `TestRemote`.
- Data flow: Host method → `RemoteError` codes declared by declaration merging → Client `ctx.remote.<ns>.<method>()` returns `RemoteResult<T>` → branch on `if (!result.ok)` and discriminate by `code` (which narrows `details` on its own).
- Non-obvious design decisions: (a) "**One `RemoteError`, one code table**" — "Do not build a family of domain error classes, and do not write an exit-mapping function" (line 53); (b) a code's placement is rule-bound: one producer declares it next to the throw, several producers declare it in the lowest common domain package, carrier codes live in protocol/gateway and "use them, never copy them" (lines 57–60); (c) "The caller is read only from `this.ctx.invocation.peer.principal`, never from arguments" (in the sibling rules) and the caller identity is never threaded through helper parameters; (d) a Remote call **does not reject** — "Do not write a defensive catch: a Remote call does not reject, and an assembly mistake should crash" (line 109).
- Edge cases / failure handling: an aborted unary call yields `gateway/cancelled` **on the error branch** rather than a throw (line 111); `ctx.remote.$host` is a plain read with no subscription and no generation counter, and `home` is `undefined` until the first ready frame, so it must be refreshed after a reconnect via `ctx.on('connection/reset')`.
- Surprising: the client-side test double must take **value** imports of `RemoteError` and `TestRemote` from `@deepseek-ai/dsh-client-test-runtime`, "because a value import from the `api-remotes` facade would load the unbuilt assembly chain" (line 169).

### docs/cookbook/adding-a-session-format-version.md
- Purpose: Tutorial for introducing the next Session log format version without rewriting released data.
- Key abstractions: an **identity edge** as a *library* (not a mounted plugin) declaring `dsh.sessionFormatMigration` with numeric `from`/`to`; the `SessionFormatMigration` declaration (`migrateHeader`, `validateTargetHeader`, `createStage`); the Stage interfaces; the generated format catalog.
- Data flow: each `createStage` produces independent state for one source artifact (counters, pending events, reference maps — "never share a mutable stage across Sessions"); `transformEvent` / `transformRun` / `finish` emit synchronously through `context.emitEvent`/`emitRun`; the chain finishes upstream stages before downstream ones.
- Non-obvious design decisions: (a) **a version bump is not automatic** — "Bump the format only when an effective discriminator cannot prevent unsafe interpretation" (line 23); safe same-version evolution goes through the type-change procedure instead; (b) "Each integer therefore identifies a family of supported representations, not one fixed schema. Owning readers must retain and distinguish those variants" (line 31) — same-version logs can mix historical and newer record variants after a resume; (c) the **native writer output is the conversion oracle** — "replay the same recorded LLM messages, tool outputs, and other inputs through the old and target writers. Compare migrated old output with raw target output before any format-normalizing helper" (line 63); (d) released codecs preserve accepted interpretations — "do not broaden an older codec to admit a current feature" (line 29).
- Edge cases / failure handling: the inherited cut is a *logical event count*, not a physical row count; "Never substitute zero for an unknown cut" (line 57). Alpha converters may explicitly refuse historical cases without an implemented, evidenced mapping, "Keep the source unchanged and publish no partial successor" (line 65). Strict restoration is proven through `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`; production's recoverable/transformed policy is not a substitute.
- Surprising: the **Final V3 event vocabulary** freeze (lines 137–148): while the published format is V3 and the integration writer is V4, master can still add V3 event types, so the migration-owned `RELEASED_V3_EVENT_TYPES` must be compared against a *pinned* V3-writer commit and must reach exact name equality — "adding the name alone does not establish a complete migration".

### docs/cookbook/reviewing-persistence-type-changes.md
- Purpose: Generate, acknowledge and verify Session persistence-type changes locally before opening a PR.
- Key abstractions: the **type fingerprint** (SHA-256 over a normalised type graph; comments, source locations, alias names, erased brands, readonly markers and harmless reordering do not affect it, but tuple order, property names, value types and optionality do); the machine inventory `docs/persistence-schema.json`; the record pair (en + zh prose with `summary` / `compatibility` / `verification`).
- Data flow: `pnpm run verify-persistence-changes --json` classifies the change and reports affected roots; the author writes bilingual prose; `pnpm run persistence-changes --record <date-slug> --prose <file> --json` validates the history and paired prose, infers established same-version decisions, and writes the record pair, complete after-schemas, both catalogs, the machine inventory and the pairing records.
- Non-obvious design decisions: a structural difference "can remain same-version with evidence of safe interpretation or refusal; it does not automatically require a higher writer version" (line 51). A change marked `requiresCompatibilityReview` must explain **both reader directions** and record executed checks; `--decision same-version` is required when the evidence supports keeping the version, and omitting it fails with `decision-required`. "An actual header version increase can infer `version-bump` … An unrelated historical bump cannot authorize it" (line 80).
- Edge cases / failure handling: `--check` only compares current source with acknowledged history and "cannot replace a base/head review or establish that a human reviewed the change" (line 42); `--update` refuses the initial baseline, records that another record depends on it, and refuses finalized checkpoint records. A stale generated inventory fails verification; the recording command refreshes it.
- Surprising: the read-only before/after comparison uses "actual literal `kind`/`form` values instead of union positions", so "Ambiguous alternatives remain separate additions and removals" (line 44) — a union reordering is not mistaken for a change.

### docs/cookbook/adding-a-settings-card.md
- Purpose: How to expose live configuration in the product's settings UI.
- Key abstractions: `Volatile<T>` config fields (`z.string().volatile()`); `config.<field>.get()`; `Config.check()` for cross-field validation; `role('secret')`; the `plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section` slot trio; `plugins.item` via `ctx.configForms.whileServed`.
- Data flow: schemastery schema declares the field → Loader validates and commits → the plugin reads `.get()` at operation start; the Settings form edits it → Host validates the full Config and applies the edit through ConfigEditor and volatile HMR.
- Non-obvious design decisions: a **volatile** field is a live reference, not a value: "Read `.get()` when starting an operation. A request that needs a consistent snapshot captures its values once … Do not retain that value for later operations" (line 30) and `.check()` cross-field validations "run on the Host before persistence and are omitted from serialized form schemas".
- Edge cases / failure handling: `role('secret')` keeps a value out of form responses; ordinary fields stay out of the settings schema (line 36). Verification requires checking the profile patch, the next consumer operation, unchanged plugin instance identity, restoration after restart, and that "an invalid value … leaves neither the file nor the live value changed" (line 40).
- Surprising: the browser half of a plugin rides on the **Loader row whose specifier is the bare package name** — "A row mounted from a subpath export never carries a half, so a bundle that splits one package into several rows keeps its half on the root row, and every page it registers goes away when that row is switched off" (line 58).

### docs/cookbook/adding-a-plugin-preview.md
- Purpose: How to add a built-in plugin's feature illustration (an optional SVG preview in Plugin Manager).
- Key abstractions: the internal `BUNDLE_PREVIEWS` map (`Map<string, Readonly<Record<'en'|'zh', string>>>`); fixed 640×300 (32:15) SVG canvas; the self-contained-SVG constraint.
- Data flow: draw one fixed-size SVG per language → import both into `PluginManagerPage.tsx` → add one exact built-in package name to `BUNDLE_PREVIEWS` → the Plugin Manager page renders one `<img>`.
- Non-obvious design decisions: the SVG must be self-contained — "no fonts, remote resources, scripts, handlers, animation, stylesheets, `text`, or `foreignObject`" — with lettering **outlined into paths** so no browser font substitution can change it (line 19); an `image` element may embed an unchanged official brand PNG/JPEG/WebP as a base64 data URL, which is the one raster exception.
- Edge cases / failure handling: both language files together must stay within 1 MiB because they are embedded as base64 data URLs in the client bundle; "Validation checks the data-URL envelope, not decoded pixels" (line 22); the page must show a localized notice on decode failure *without blocking controls*, and previews are visible before activation.
- Surprising: the page contract is fixed to the pixel — 24 px above the image, 32 px before the next section, one `<img>` at natural 640×300, at most 320 px high (lines 40–46).

### docs/cookbook/adding-a-vendored-package.md
- Purpose: File-by-file checklist for vendoring an upstream Cordis package under `vendor/`.
- Key abstractions: the vendored `tsconfig.json` (relaxes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters` because upstream code needs it); the `paths` map entry; the `vendor/README.md` manifest row (dir, npm name, version, upstream repo, commit SHA).
- Data flow: copy upstream `src/` verbatim → rescope the name → register in `tsconfig.base.json` `paths` and `tsconfig.host.json` references → add the manifest row → the pre-commit `scripts/check-vendor-manifest.sh` guard fails if `vendor/*/src` is staged without the manifest update.
- Non-obvious design decisions: vendored code enters the graph **through the host aggregate only** and through its own `vendor/<dir>/tsconfig.json`, "not pulled into an aggregate's strict program" (line 59). Vendored packages are publishable release members, so they must NOT set `private: true` and must set `publishConfig.access: public`. Local relative imports use explicit `.ts` specifiers, a repo-local build difference from upstream.
- Edge cases / failure handling: "vendoring one package often means vendoring its dependency tree (e.g. `@cordisjs/plugin-http` pulls `@cordisjs/fetch-file`)" (line 32) — the transitive closure is part of the decision, not an afterthought.
- Surprising: a per-package `tsdown.config.ts` is needed **only** when the build differs from the root default (dual ESM/CJS or multiple entries), and its entry must read the JS emitted under `lib/types`.

### docs/cookbook/maintaining-dsh-code-review.md
- Purpose: Operator entry point for keeping the `dsh-code-review` skill current via a private periodic maintenance tool.
- Key abstractions: the daily (2-UTC-day overlap) / weekly (7-day) window; two independently configured reviewer adapters; the promotion manifest; the three operator decisions (discard / batch / promote).
- Data flow: select merged PRs reachable from `origin/master` → collect pre-merge human review feedback with commit anchors → compare feedback-time against final landed patches → two adapters classify authorship and adoption → the primary drafts a revised `SKILL.md` → both review the same diff until both approve → `doc-sync` + `lint` run → the operator promotes via `dsh-code-review-promote <timestamp>`.
- Non-obvious design decisions: PRs whose merge commit is not reachable, or that exceed a 250-commit acquisition cap, are **skipped and logged**, not fatal (line 11); conversation comments are deliberately not acquired "because current GitHub state cannot give them a force-push-safe feedback-time baseline" (line 12); the tool refuses to run when the two reviewer commands resolve to byte-identical executables, and a total-provider outage must never collapse into "no candidate" (line 59).
- Edge cases / failure handling: the worktree is restored clean after every run "so the operator is never tempted to edit the maintenance copy in place" (line 17); a batch whose adapter response fails schema or id validation is failed closed at the *batch* level and the run continues with the raw output preserved.
- Surprising: "Days without a skill update are the workflow behaving correctly, not a stall" (line 52) — the absence of a candidate is an expected, non-alarming outcome, and the tool sends no notification to avoid alert fatigue.

### docs/cookbook/responding-to-pr-review-on-a-stack.md
- Purpose: Review-fix placement and propagation across a dependent PR stack (`A ← B ← C`).
- Key abstractions: one worktree per PR branch; GitHub's `PullRequest.stack` / `stackEntry.position` as the authoritative stack object; merge-forward vs native cascading rebase (`gh stack rebase` / `gh stack push` / `gh stack sync`).
- Data flow: triage every comment on the merits → map each accepted finding to its **originating** PR → fix there → propagate the fixed layer up-stack (merge-forward, or `gh stack rebase` then `gh stack push`) → reply in the review thread with the current commit that carries the fix → re-audit unresolved threads, approvals, mergeability and checks after any rewritten push.
- Non-obvious design decisions: "**A fix lands on the PR that INTRODUCED the issue, then flows up-stack**" — "Originating the fix downstream leaves `B` shipping the unfixed code and hides the fix from `B`'s reviewer" (line 11). Each review fix remains a distinct commit; a rebase may change its OID, but a reviewed fix must not be amended out of history. A rewritten push must be lease-protected and **must abort rather than overwrite a concurrently advanced remote head; raw `--force` is forbidden** (line 13).
- Edge cases / failure handling: "Treat delegated fixes as trust-but-verify: a sub-agent's report describes intent, not necessarily what landed" — and for a regression guard, "**prove it FAILS on the unfixed code** (introduce the regression, watch red, revert) — a guard that passes both ways guards nothing" (line 22). A sub-agent that reframes a problem as already handled is a signal to dig in personally.
- Surprising: after a rewritten push, "a force-pushed commit OID or outdated inline anchor is not current evidence that the finding remains resolved" (line 24) — resolution evidence expires with the push.

### docs/cordis-api/context.md
- Purpose: Generated reference for the Cordis `Context` — the core object every service, event and lifecycle API is reached through.
- Key abstractions: `ctx.extend(meta?)` (child context with shadowing own properties), `ctx.isolate(name, label?)` (independent service scope for one service name, joinable by sharing a `label`), `ctx.intercept(name, config)` (service-specific intercept config for plugins started below); the service store (`ctx.get/set/provide/accessor/mixin`).
- Data flow: a context is a **proxy**: normal property reads go through the service resolver; `extend`/`isolate`/`intercept` create scoped child contexts without mutating the parent.
- Non-obvious design decisions: `isolate()` defaults to a fresh unique symbol as the scope label, so two calls with no label are independent but two calls with the *same* label "join their scopes" (lines 48–59) — a deliberate sharing primitive. `Context.is(value)` "works across realms and across multiple copies of cordis, because the brand is keyed by a global symbol rather than by `instanceof`" (line 227).
- Edge cases / failure handling: `ctx.set` may only be called by the fiber that provided the service, and setting an unprovided name throws; `ctx.provide` throws if the name is already provided in this scope or declared as an accessor; mixins and accessors are removed when the current fiber unloads.
- Surprising: `ctx.get(name, strict = true)` returns only implementations whose providing fiber is **currently active** — a service that was unloaded reads as absent even though the key is still declared.

### docs/cordis-api/fiber.md
- Purpose: Generated reference for `Fiber` — one loaded plugin instance with its lifecycle state, validated config and registered effects.
- Key abstractions: the state machine (PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED, plus FAILED); `ctx.effect(execute, label?)`; `Effect` (a disposer, a promise of one, or an iterable of them — generator effects register each yielded disposer as it is produced); `EffectMeta`; `CordisError` with code `INACTIVE_EFFECT`; `ValidationError`.
- Data flow: `ctx.effect` runs the body immediately, collects the disposers it produces, and runs them **in reverse order** when the returned disposer is called or the fiber unloads, whichever comes first; `fiber.dispose()` resolves after all cleanup, including async disposers, has finished and recursively unloads child plugins.
- Non-obvious design decisions: calling the effect disposer twice is a **no-op**, and `ctx.effect` on an already-disposed fiber throws `CordisError('INACTIVE_EFFECT')` — idempotent teardown plus a loud misuse error.
- Edge cases / failure handling: `fiber.update(config, noSave?)` runs the `internal/update` waterfall first, so update hooks and HMR can veto or replace the restart; `noSave` is a hint for persistence hooks not to write back. `fiber.await()` waits for current lifecycle work and rethrows startup errors. `fiber.inertia` exposes the in-flight load/unload transition.
- Surprising: `fiber.getEffects()` returns a **tree** of nested effect labels (one `EffectMeta` node per labeled live effect, with `children`) — a live diagnostic view of what a plugin currently holds.

### docs/cordis-api/events.md
- Purpose: Generated reference for the event-dispatch API mixed into every context.
- Key abstractions: `emit` (sync, no await, no value), `parallel` (awaited, concurrent, no value), `serial` (awaited, in order, first bail value), `bail` (sync, first bail value), `waterfall` (around-middleware, last argument is a `next` continuation); `EventOptions { prepend?, global? }`.
- Data flow: `ctx.on(name, listener, options?)` registers a listener owned by the current fiber and returns a disposer that reports `true` if the listener was still registered; `ctx.once` is the self-disposing variant.
- Non-obvious design decisions: the dispatch mode is part of the event's **public contract** and is compared against the actual dispatch site by the generated catalog (also stated in `cordis-primer.md:27`). `serial` and `bail` treat a value as a bail only when it is non-null, non-false and non-undefined.
- Edge cases / failure handling: `options.global` makes a listener receive the event "regardless of context filter checks" — the escape hatch for a registry-wide observer, and the reason the scope filter is not a security boundary.
- Surprising: `emit` is documented as "Dispatch an event synchronously, ignoring listener return values" — an async listener's rejection is not the dispatcher's problem, which is why `parallel`/`serial` exist.

### docs/cordis-api/registry.md
- Purpose: Generated reference for plugin loading and dependency injection.
- Key abstractions: `ctx.plugin(plugin, ...args)` and `ctx.inject(deps, callback)`; the `Plugin` union (Function / Constructor / Object); `Plugin.Base` (`name`, `Config` standard-schema, `inject`, `provide`, `intercept`); `Plugin.Runtime` (the registry record shared by all fibers of one plugin callback); `Inject` (array form = no intercept config; object form = per-service intercept config).
- Data flow: `ctx.plugin` loads a plugin in the current context, validating its config against its `Config` schema; the returned fiber is awaitable and rejects on config or startup errors.
- Non-obvious design decisions: the **registry identity key is the executable entrypoint** (`Plugin.Runtime.callback: globalThis.Function`), so all fibers of one callback share one runtime record — which is what makes `ctx.inject` re-run the callback when a required service changes.
- Edge cases / failure handling: `Inject.resolve` normalises array / object / class-inherited inject metadata into one plain map (`service name → intercept config or null`); `null`/`undefined` add nothing.
- Surprising: `Plugin.Runtime.fibers` is a `DisposableList<Fiber>` — one plugin callback can have many live fibers (one per `ctx.plugin()` call), and disposing the runtime disposes them all.

### docs/cordis-api/service.md
- Purpose: Generated reference for the `Service` base class — the way a plugin publishes a named API on `ctx`.
- Key abstractions: `super(ctx, name)` registration; the static symbol keys `init` (post-construction hook for class plugins), `check` (availability predicate passed to `ctx.provide()`), `config` (phantom intercept-config type parameter), `invoke` (makes a service callable, e.g. `ctx.logger()`), `extend`, `tracker` (context tracing), `resolveConfig`.
- Data flow: a subclass calls `super(ctx, name)` in its constructor; the service is registered immediately and "automatically removed with the owning fiber".
- Non-obvious design decisions: the registration is **immediate**, not deferred to load completion, so `ctx.<name>` resolves as soon as the constructor returns; and removal is tied to the fiber, so a service can never outlive its owner.
- Edge cases / failure handling: the `check` predicate lets a service declare itself *unavailable* (so dependents stay PENDING) without the provider unloading — a graceful "not supported here" state.
- Surprising: `Service.init` is a symbol-keyed instance method run after construction for class plugins, i.e. an explicit post-construction hook distinct from the constructor's own `super()` call.

### docs/cordis-api/inherited.md
- Purpose: Generated summary of the framework `ctx` members and events every plugin sees beyond the harness tier, pinned to vendored source.
- Key abstractions: the inherited `ctx` member list (events, registry, effect, reflect, context derivation, ambient handles, `ctx.timer` helpers, `ctx.loader`) and the inherited event list (`internal/plugin`, `internal/status`, `internal/service`, `internal/update`, `internal/config`, `internal/get`, `internal/set`, `internal/listener`, `internal/dispatch`, `exit`, and the five `loader/*` events).
- Data flow: the file points at the vendored source file and line for every member, so a reader can verify a signature without reading the vendored tree.
- Non-obvious design decisions: the file is deliberately **terse** — "summarized tersely so the harness pages stay focused on repository-owned vocabulary" (line 6) — and is excluded from bilingual pairing because "generated without a reviewed Chinese counterpart, so both website locales project the English source" (per `i18n/README.md:58`).
- Edge cases / failure handling: `loader/volatile-update` is documented as "dispatched to the owning fiber only" — the instance-local nature of a live config change is a real contract, not an implementation detail.
- Surprising: `ctx.timer` is a *provided* key whose four helpers (`interval`/`timeout`/`throttle`/`debounce`) are mixed onto `ctx` directly via `Pick` — a different mechanism from `ctx.on`.

### docs/cordis-tutorial/index.md
- Purpose: Landing page for the seven-chapter hands-on Cordis tutorial; each chapter is a runnable example in a gitignored `tmp/cordis-tutorial` directory.
- Key abstractions: the one-file launcher `node --import tsx ../../vendor/cordis/bin.js`; the scratch directory; the three TypeScript notes (annotations, `import type`, declaration merging).
- Data flow: the launcher creates a root `Context`, mounts the Loader, and loads `./cordis.yml` from the current directory; everything else comes from the YAML.
- Non-obvious design decisions: the audience is **agent developers, not deep TypeScript experts** — the tutorial explains the three TS features it uses rather than assuming them, and every chapter shows the exact commands and expected output. The "no API key is needed" promise is explicit (line 15).
- Edge cases / failure handling: the tutorial teaches the *silent* failure mode early: "a config entry whose module cannot be resolved — a typo'd path or package name — is reported through the Cordis logger service instead of crashing the process, and at boot that report can be lost before a console exporter is watching" (in chapter 1).
- Surprising: `import type {} from './stats.ts'` is used purely to make TypeScript see another file's declaration merges — the runtime import is empty (chapter 4).

### docs/cordis-tutorial/01-first-plugin.md
- Purpose: Chapter 1 — a plugin is a function; the loader mounts it.
- Key abstractions: the function plugin (`export const name`, `export function apply(ctx)`); the three plugin shapes (function / object with `apply` / class extending `Service`).
- Data flow: `cordis.yml` is a list of entries; `name` is a module specifier; the loader resolves and mounts each entry; Cordis calls `apply(ctx)`.
- Non-obvious design decisions: "**Entries start concurrently, so list position guarantees nothing about which plugin loads first**; ordering comes from service dependencies (`inject`), not from position in the file" (line 31). The `name` export is optional display metadata only.
- Edge cases / failure handling: a plugin whose `apply` throws **kills the process** — "A plugin that fails to load is a loud failure, not a skipped entry" (line 89). By contrast an unresolvable module specifier is only logged.
- Surprising: the base bundle `dsh-base` is "a longer plugin composition that deployment overlays patch" (line 51) — a product is a patch stack over an ordinary plugin list.

### docs/cordis-tutorial/02-lifecycle-and-effects.md
- Purpose: Chapter 2 — what happens when a plugin unloads.
- Key abstractions: `ctx.effect(() => disposer)`; the fiber state machine; the list of built-ins that are *already* effects (`ctx.on`, `ctx.plugin`, service registrations, harness registry registrations such as `ctx.tools.register`).
- Data flow: the effect body runs during load; its disposer runs during unload; `fiber.dispose()` resolves after all cleanup, including async disposers, and recursively unloads child plugins.
- Non-obvious design decisions: "You never call the disposer yourself for a plugin-lifetime resource" (line 65) — the plugin lifetime *is* the ownership scope. A pending timeout inside an effect is cancelled if the owning plugin unloads first, "instead of firing on a dead app" (line 33).
- Edge cases / failure handling: the ordering caveat — "disposers start in reverse registration order, but multiple **async** disposers run concurrently. If teardown steps must run in sequence, keep them in one disposer and await them there" (line 94).
- Surprising: `ctx.plugin(heartbeat)` mounts a function *from code* as a plugin, the same operation the YAML loader performs — so programmatic composition and file composition are the same primitive.

### docs/cordis-tutorial/03-services.md
- Purpose: Chapter 3 — expose a capability on `ctx` and depend on it with `inject`.
- Key abstractions: `Service` subclass + `declare module '@deepseek-ai/cordis' { interface Context { greeter: GreeterService } }` (declaration merging); `inject: ['greeter']`; optional dependencies via `ctx.get('greeter')`.
- Data flow: `super(ctx, 'greeter')` registers the instance; the consumer plugin is held in PENDING until every injected service exists, so `ctx.greeter` is guaranteed ready inside `apply`.
- Non-obvious design decisions: the compile-time and runtime halves are taught as two separate mechanisms — "It generates no code; without it the service still works at runtime, but consumers lose type safety" (line 40). The service name space is **flat**, so own services must be namespaced distinctively (line 94).
- Edge cases / failure handling: `inject` is **not a one-shot boot check** — if a required service disappears while the app runs, every dependent plugin is unloaded too and loads again when it returns (line 76). A PENDING fiber does not keep Node's event loop alive, so a composition with nothing else running "exits 0 silently" (line 72) — a real, documented failure mode.
- Surprising: swapping two lines in `cordis.yml` changes nothing ("same output") — load order is dependency-driven, and the file is declarative rather than sequential.

### docs/cordis-tutorial/04-events.md
- Purpose: Chapter 4 — typed events, broadcast dispatch, and the waterfall short-circuit.
- Key abstractions: `interface Events { 'stats/report'(name: string, count: number): void }` declaration merging; the five dispatch modes; the `namespace/action` event naming convention.
- Data flow: a service emits; listeners registered with `ctx.on` receive it; because `ctx.on` is an effect, "the listener disappears with the plugin — no manual `removeListener` bookkeeping, ever" (line 78).
- Non-obvious design decisions: the waterfall discipline is taught as a *rule*, not a trick: "**a waterfall listener that only observes or annotates must call `next()`**; returning without `next()` is a deliberate short-circuit. Forgetting `next()` in a logging listener silently swallows the default behavior for everyone downstream" (line 138).
- Edge cases / failure handling: the two-listener walk-through shows the short-circuit interacting with the *outer* listener's post-processing — listener 1 uppercases listener 2's replacement on the way out, which is how a policy veto can still be decorated.
- Surprising: `agent/request` and `approval/request` are named as the harness's real waterfalls — "a plugin can replace the model-call config" and "a policy can answer instead of the user" (line 140).

### docs/cordis-tutorial/05-config.md
- Purpose: Chapter 5 — validated config from `cordis.yml`, failing loud on bad input, plus live (volatile) fields.
- Key abstractions: the exported `Config` as *both* a TypeScript interface and a Schemastery schema value; `.volatile()` fields read through `.get()`; the `!!js` computed-value tag.
- Data flow: the loader validates the `config:` block against the schema before `apply` runs; defaults fill omitted fields, so `apply` always receives complete config; a volatile-only change is parsed through the plugin's `internal/config` hook, validated, and — when every ordinary effective value still matches — committed into the running references and announced with one instance-local `loader/volatile-update`, bypassing `internal/update`.
- Non-obvious design decisions: the volatile contract is spelled out precisely (line 93): "A changed ordinary effective value, including a changed expression result, and simultaneous ordinary-field changes retain the existing update flow, leaving old references unchanged and unnotified." Volatile fields must be declared "at fixed object paths" — independent references inside arrays, dictionaries, union/intersect branches, lazy schemas, transforms or another volatile value are rejected.
- Edge cases / failure handling: `!!js` works **only** inside `config` and in an entry's `disabled` field; `disabled: !!js ...` "evaluates against the loader context at every mount decision … so a row can gate itself on platform or environment", while other entry metadata stays static.
- Surprising: "Object and array values are detached, recursively frozen snapshots of plain data; functions, class instances, and cycles are rejected" (line 91) — a volatile reference is a value snapshot, not a live proxy.

### docs/cordis-tutorial/06-composition-and-hmr.md
- Purpose: Chapter 6 — the config file as a plugin tree, hot reload, and diagnosing a plugin that never loads.
- Key abstractions: entry `id` (stable identity), `disabled`, groups, `isolate`; the fiber-state diagnostic loop over `ctx.registry.values()`.
- Data flow: HMR watches files and replaces a running plugin by unloading and loading it; editing `cordis.yml` makes the loader diff entries **by id** and mount/unmount/reconfigure only what changed.
- Non-obvious design decisions: "This is why the entries above carry explicit `id`s — an entry without one gets a generated id on every read, so after any config-file edit it counts as removed-plus-added and remounts even if its own lines did not change" (line 59). A `disabled: true` entry unmounts the plugin without deleting the entry, so flipping it back reloads it and everything PENDING on its services.
- Edge cases / failure handling: the **PENDING diagnostic** (lines 65–109) is the chapter's real payload: a plugin whose `inject` names a service nobody provides waits forever *printing nothing*, and no error is raised "since the provider may be mounted later". The cure is to enumerate fiber states and filter on `FiberState.PENDING`.
- Surprising: the tutorial warns that the silent PENDING case has two independent causes — a missing provider **and** a missing HMR support plugin (`@deepseek-ai/dsh-plugin-timer`), since HMR injects `timer` for debouncing and "without `@deepseek-ai/dsh-plugin-timer` it sits in PENDING forever, silently" (line 42).

### docs/cordis-tutorial/07-into-the-harness.md
- Purpose: Chapter 7 — register a model-callable tool against real harness services, drive one call through the real pipeline, observe the result event. Keyless, no model call.
- Key abstractions: `ctx.tools.register(defineTool({...}))`; `ctx.tools.execute({ callId, name, arguments, signal })`; the `tools/result` event; `brandString<ToolCallId>`.
- Data flow: registration attaches the disposer to the plugin, so unloading unregisters the tool; `defineTool` converts the `parameters` spec to the JSON Schema shown to the model, infers the `args` type, and validates model-supplied arguments before `execute` runs; the tool returns the canonical value while `output.render` separately produces the Native/durable result content.
- Non-obvious design decisions: "The logger fired first: `tools/result` is emitted as part of result materialization, **before** `execute`'s promise resolves to the caller" (line 95) — observers see the result before the caller does. `@deepseek-ai/dsh-tools` injects `systemPrompt` because tools contribute schemas to the system prompt, so the composition must list that provider too.
- Edge cases / failure handling: the composition lists both `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` precisely because a missing provider leaves the tools plugin PENDING — the chapter-6 lesson applied.
- Surprising: the demo stands in for the model with a hand-built `callId` — "standing in for the model. ToolCallId brands the correlation id a provider would issue" (line 37), which makes the whole tool pipeline testable without a provider.

### docs/defensive-patterns/README.md
- Purpose: Index of the review-enforced rules, split by artifact, with a routing table.
- Key abstractions: the five habits the pages apply — *Make correctness explicit*; *Keep one source of truth*; *Extend through the registered seam*; *Keep the change face equal to the review face*; *Require evidence*.
- Data flow: a contributor reads the page for the artifact they are about to change; `dsh-code-review` reads the directory when judging a pull request.
- Non-obvious design decisions: "Keep the change face equal to the review face" is stated as a *habit*, not a rule: "a change carries only the lines its stated behavior change needs, a migration moves code rather than rewriting it, and a performance-sensitive change carries its measurement" (line 14).
- Edge cases / failure handling: every rule page has the same four-part shape — requirement, how a reviewer judges it, its boundary and who approves an exception, and a correct and a wrong example — so a rule without a judged condition is incomplete.
- Surprising: the pages carry **rules**, the subsystem pages carry **semantics**; the two are deliberately separate tiers so neither rots the other.

### docs/defensive-patterns/general.md
- Purpose: Bug-class rules for lifecycle, concurrency, subprocess and teardown code — each a defect class that actually shipped or nearly shipped here.
- Key abstractions: 14 rules, each stated as *what must hold / how a reviewer judges it / its boundary / a correct and a wrong example*.
- Data flow: rules are stated as constraints on shapes, not on call sites; several name the exact type or method they bind (`LlmAdapter.stream()` vs `LlmRuntime.stream()`, `agent.followup()`, `reader.close()`).
- Non-obvious design decisions: (a) "**Report orthogonal outcomes independently**" — `timedOut`, `signal`, `exitCode` must each be reportable without entering another condition's branch, "or a caller reads a cut-short run as a clean success" (line 9); (b) "**Honor public contracts on BOTH sides**" — `LlmAdapter.stream()` may throw or emit `finish {kind:'error'|'aborted'}`, but `LlmRuntime.stream()` exposes model-request failures **only** as terminal finish chunks, so "a consumer can name the source of a failure from the public API alone" (line 15); (c) "**Async state is not synchronous state**" — "Never treat `agent/status` or `whenIdle()` as the result of one follow-up" (line 21); (d) "**Timing does not carry correctness**" — a `microtask`/`setTimeout` that decides whether work is correct "holds under a light load and silently fails under a busy one" (line 27); (e) "**One value states one fact**" — unknown / empty / absent are three facts and take three representations (line 73).
- Edge cases / failure handling: "**Dispose must reach quiescence, not just request it**" — await child exit after killing or aborting (line 192); "**Contain callback exceptions in the dispatcher**" — catch and report each listener's exception without rejecting the dispatch promise or starving later listeners (line 198); "**Never hand untrusted output the ambient environment or predictable paths**" — scrub `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`, use a 0700 dir and exclusive owner-only opens (`'wx'`, `0o600`) (line 214); "**Unlink link-shaped paths**" — `lstatSync().isSymbolicLink()` then `unlinkSync`, because Windows `rmSync(link)` throws `ERR_FS_EISDIR` on a junction and recursive deletion may descend through it into its target (line 220).
- Surprising: the performance rule forbids the obvious baseline: "Comparing old against new with the same hook attached on both sides dilutes the difference until it disappears" — the baseline must be the native implementation that carries no measurement hook (line 155).

### docs/defensive-patterns/client-components.md
- Purpose: Rules for client components, their state and their effects.
- Key abstractions: the Slot `inject` face (plain data, narrow action callbacks, the reserved `hooks` compartment bound to `use<Name>`); the `renderSlot` / `renderFactorySlot` derived helpers; `useResource`; declared stores with a `persist` key; `ChatNodeDataMap` declaration merging.
- Data flow: the registration's `inject` factory closes over `ctx`; the renderer binds observables into hook seats; the component reads one derived hook per field; the parent passes owner data through `renderSlot`.
- Non-obvious design decisions: (a) "**State arrives through injection**" — "Keeping every live value on that face is what makes a prop that did not change keep its identity, and what lets a component subscribe only to the sub-state it reads" (line 9); the failure mode is named: "any unrelated field change re-renders the whole subtree, which is how a long session under streaming events loses frames while the user scrolls or types"; (b) "**A slot registration is a stable function component**" — a component created during render is a *new component type* on every pass, so React unmounts and remounts the subtree, "which resets expanded rows, input focus, and scroll position" (line 97); (c) "**Effects never push render-derived data to a parent**" — a setter from props called in an effect "costs a second render, leaves the parent without the value on its first frame, and turns any later state change into a render cascade" (line 350).
- Edge cases / failure handling: "**Components never receive a Cordis context**" — no `ctx` in props, no raw `observable.value` read in render, no `useSyncExternalStore` in a component, because "a component that subscribes directly owns a lifecycle that nothing on the Injection face releases" (line 137). `useResource` is the only sanctioned read path for a resource, because "a second read path per protocol splits cache and invalidation policy" (line 190). "**Identity and initial state are deliberate**" — state changes must not remount a control or replace its DOM node, and initial state is "ready when the first flow runs" rather than filled in by an effect (line 275). A module-level store handle is forbidden: "module-cache identity is a disguised singleton across plugin reloads" (line 236).
- Surprising: "**Each shared layer keeps its own isolation level**" (line 450) is a table, not a rule: a feature absorbs its requirement in its own package; a new control starts in the feature package and is promoted into the shared catalogue only when a second consumer needs it.

### docs/defensive-patterns/conversation-and-session.md
- Purpose: Rules for reading a Session, holding one, computing conversation nodes, and rendering them.
- Key abstractions: `ctx.sessionProjections` (registered fold units with `stateVersion`); the `ProjectionDefinition` (`key`, `stateVersion`, `init`, `apply`, `wire`); `SessionReference` (`retain`/`release`); `ConversationNodeDefinition` (`kind`, `target`, `match`, `start`, `update`, `publication`, `buildViewNode`).
- Data flow: a projection unit folds committed session events incrementally; host consumers read one typed state with `stateOf()`; the client reads the published value at its render position; the node builder computes an increment on the affected subtree and publishes on a cadence.
- Non-obvious design decisions: (a) "**Projection is the only read and compute path**" — "Two answers to the same question — one pulled, one pushed — drift apart, so a render can show a value the Session log no longer supports" (line 9); (b) "**Cold reads are the last resort**" — the "small Session may be read in full" exception "is removed and is not reconsidered", and "There is no cache-size or Session-size exception, and no approver for one" (line 52); (c) "**Node computation is incremental and streaming publication is batched**" — the publication vocabulary is `none` / `animation-frame` / `immediate`, `immediate` is forbidden on the high-frequency delta path, and a per-chunk full rebuild "puts the whole node collection on the frame budget, and the transcript stalls behind the stream" (lines 128–135); (d) `stateVersion` starts at 1 and is bumped whenever the serialized state fields or the fold semantics change, "compatible or not", and registering one key twice with different `stateVersion` values throws instead of merging.
- Edge cases / failure handling: "**Retention follows one lifecycle rule**" — the predicate is exactly `refCount == 0 && inflight == 0`, and idle reclamation "never enumerates which Sessions may be reclaimed from business state, because that list has to be maintained by every feature that adds one" (line 87). A partial projection view may serve interface availability for individual keys but "never decides an externally visible result".
- Surprising: four consecutive rules state the *same* law from different angles — the grouping engine, the node list/seat components, the Markdown pipeline and the user-message model each "carry no business branch", so a feature expresses itself by merging its own key into `ChatNodeDataMap` and registering a renderer, never by editing the shared pipeline.

### docs/defensive-patterns/package-surface.md
- Purpose: Rules for what a package exports, how it is built, and how it declares dependencies.
- Key abstractions: the **Loader four** (`name`, `inject`, `Config`, `apply`) for a function plugin, or a default-exported Service class for a service plugin, and the ban on mixing the two; the two package shapes (Host, Host + Client); the standard `exports` key set; the workspace-family dependency syntax.
- Data flow: the entry point is what the Loader loads; `exports` maps are what consumers and the scans read; dependency declarations are checked mechanically by `scripts/verify-package-dependencies.ts` against `PACKAGE_DEPENDENCY_POLICY`.
- Non-obvious design decisions: (a) a test convenience must never become published API — "the rule stops a test convenience from freezing into published API" (line 9); (b) "**A new resolve hook is refused outright**" — a definite prohibition with two preconditions (re-audit the whole resolve strategy, and the domain owner's confirmation) because "the one resolution path is the tsx ESM hook" and a branch there "means the resolver returns no longer matches `node_modules`" (lines 188–211); (c) internal dependency syntax is decided by *package family*: `@deepseek-ai/dsh` and `dsh-*` use `workspace:*`, every other internal package uses `workspace:~`, and `workspace:^` has retired — "The uniform syntax keeps one resolution path and prevents duplicate instances of a dependency and the resolution differences that follow them" (line 150).
- Edge cases / failure handling: "**Package modules do not await at module scope**" — "a module-scope wait makes every importer's evaluation wait, turns a rejection into a module-evaluation failure, and cannot be lowered to the synchronous CommonJS wrapper of the browser-worker image" (line 228). The `exports` map may only use the standard key set; keys outside it "are pending review, not a pattern to copy". The dependency policy's rules live in the policy file, and "Editing the scan or relaxing its policy so that a change can land is not a normal edit and needs the domain owner's confirmation".
- Surprising: the `exports` standard set includes `./typert` and `./remote` as *semantic* keys tied to the Remote-call surface, and `./cordis.patch.yml` as the bundle patch layer — a package's export map doubles as a declaration of its architectural role.

### docs/defensive-patterns/remote-and-api.md
- Purpose: Rules for the `packages/api` layer and the remote methods it exposes.
- Key abstractions: a remote business capability = its own service; `@Remote`'s five disciplines; `packages/api` as generic orchestration only; `ctx.remoteAccess` as the access-control seam.
- Data flow: a decorated method is exposed; the Gateway resolves the descriptor and the live service; the caller identity comes from `this.ctx.invocation.peer.principal`; resources are resolved and filtered through `ctx.remoteAccess.allows(resource)`.
- Non-obvious design decisions: (a) "**A new remote capability gets its own service**" — split by business boundary, not by caller count: "a capability with a single caller today still gets its own service" (line 9); (b) the **five `@Remote` disciplines** (line 47) — the annotation goes on the *concrete* method (a body that only delegates means it is on the wrong method); client-facing types are aliased from the generated map (`TypertClientRemote['session']`) rather than hand-written twice; the wire payload is JSON with field-level binary and the decorator performs **no output-side decode**; existing names are additive (a rename is its own change); and every method names every resource it touches while reading its caller only from the invocation; (c) "**`packages/api` carries generic orchestration only**" — "The criterion is where the logic belongs, not where the file sits" (line 85).
- Edge cases / failure handling: "access control never checks a resource they omit" — an unnamed resource, an unfiltered aggregate, or an argument-supplied caller lets a non-owner reach what no binding grants it (line 53). A user-message source built in a Remote method must go through `principalOf(this.ctx.invocation)` and be passed down, never carry the principal as a function argument.
- Surprising: the page carries a **package census** (line 87) — nine packages under `packages/api`, `session-controller` the largest at 34 `src` files, `terminal-controller` 12, `gateway` 11 — because the impact of a business branch in the shared layer is a number, not an opinion.

### docs/module-graph.md
- Purpose: Generated Mermaid graph of **peer** dependencies among the `@deepseek-ai/dsh-*` packages, grouped by the `packages/<group>/<pkg>` hierarchy.
- Key abstractions: an edge `a --> b` means "package `a` has package `b` as a peer"; the groups are the package taxonomy (`util`, `llm`, `core`, `goal`, `fs`, `skill`, `subagent`, `web`, `spill`, `todo`, `plan`, `session-query`, `acp`, `api`, …).
- Data flow: a peer means "the consumer requires a shared instance"; ordinary runtime dependencies and development-only relationships are deliberately excluded.
- Non-obvious design decisions: showing only peers is the point — a peer edge is a *shared-instance* requirement, and drawing the runtime-dependency graph would show a much denser, much less informative picture. The `core` group is small (`agent`, `agent-loop`, `agent-default-model`, `agent-tool-presentation`, `scope`, `session`, `system-prompt`, `tools`).
- Edge cases / failure handling: the graph is the check surface for the "one package belongs to exactly one aggregate" rule and for duplicate-instance bugs — two packages must not end up with two copies of a shared singleton.
- Surprising: `llm` group contains `deepseek-llm-api-extensions`, `llm-deepseek`, `llm-pi-ai`, `llm-replay`, `llm-retry`, `token-meter`, `plugin-package-inventory-deepseek` and `llm-deepseek-account` / `llm-deepseek-api-key` — the retry *executor* and the *token meter* are separate packages from the adapter, because the executor has no config and the meter is a replay-side measurement service.

### docs/persistence-catalog.md
- Purpose: Generated catalogue of every repository-declared durable Session event with its source declaration, resolved types, and SHA-256 type fingerprints.
- Key abstractions: the event envelope (`type`, `seq`, `time`, `data`, optional `ignorable`, conditional `surfaceOp` / `sourceEventSeqs`); `SurfaceEventType` (the subset that produces model history: `system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result`); `SurfaceOp` = `'append'` or `{ op: 'replace', startSeq, endSeq }`; the **root fingerprint** table.
- Data flow: a durable event is appended to the log; a *surface* event produces model history, a *log-only* event does not; a `replace` surface op shadows a contiguous range of surface nodes and the replacing event's `sourceEventSeqs` must name every shadowed node.
- Non-obvious design decisions: the **fingerprint** is computed over a *normalised* type graph — "Comments, source locations, alias names, erased brands, readonly markers, and harmless field, union, or intersection reordering do not affect these fingerprints. Tuple order, property names, value types, and optionality do" — so a reformat does not force an acknowledgement, but a rename does; the catalogue text can still diff while the digest stays unchanged (line 16).
- Edge cases / failure handling: "An unrecognized canonical event without `ignorable: true` prevents lossless reconstruction" (from the wire-extensions doc, and the same rule governs the catalogue). The catalogue covers this repository only; external plugin types require their own declarations.
- Surprising: `sourceEventSeqs` is the *provenance* channel: it lets a replacement event name the surface nodes it shadows, which is what makes compaction's rewrite auditable rather than destructive.

### docs/dependency-catalog.json
- Purpose: Machine-readable inventory of the **published** `@deepseek-ai/dsh` npm package's dependency tree, captured by an install of `@deepseek-ai/dsh@latest`.
- Key abstractions: the top-level `package` / `version` / `requested` / `resolution` block (`capturedAt`, `npm`, `node`, `platform`, `arch`, `registry`, `installStrategy: hoisted`); the `dependencies` array, each entry carrying `name`, `version`, and an `installations` list with `location`, `direct`, `optional`, `peer` flags.
- Data flow: the file records what a consumer's install of the published package actually pulls in, and where — so a dependency that resolves to two locations, or that is present but optional, is visible.
- Non-obvious design decisions: it is a **capture of a real install**, not a manifest read: the `resolution` block pins the npm version, Node version, platform, arch and install strategy that produced the tree, so the inventory is reproducible rather than aspirational.
- Edge cases / failure handling: the per-dependency `installations` array with `direct`/`optional`/`peer` flags is what makes a *transitive* dependency distinguishable from a declared one, and it shows where in the tree each copy lives.
- Surprising: the catalog is a **consumer-side** view of the harness (it records the published package's tree, including `@agentclientprotocol/sdk` and `@anthropic-ai/sdk`), whereas `module-graph.md` is the *developer-side* peer graph of the monorepo — two different dependency views of the same product.

### docs/config-catalog.zh.md
- Purpose: The generated Chinese counterpart of the config catalogue (same structure, translated prose outside the generated regions).
- Key abstractions: mirrors the English file's per-package `inject` / `refs` / `source` blocks; the generated regions are byte-identical to the English source.
- Data flow: regenerated by `pnpm run gen-config-catalog` into both languages together, so a config change never requires a manual Chinese update.
- Non-obvious design decisions: the Chinese page keeps the identical generated fences and only translates the surrounding prose — "生成区块" are excluded from the pairing hash, so the pairing record stays small even for a 4,800-line file.
- Edge cases / failure handling: only 5 pairing-record entries exist for this file (19 lines of yaml) because the generated regions dominate it.
- Surprising: the `.i18n.yaml` for this file is 19 lines while the `.zh.md` is 4,803 lines — the record is per *heading section*, and the file has only four prose headings.

### docs/module-graph.zh.md
- Purpose: The generated Chinese counterpart of the peer-dependency graph.
- Key abstractions: identical Mermaid node ids and edges; only the prose and group labels are translated.
- Data flow: regenerated alongside the English source; the pairing record has just two entries.
- Non-obvious design decisions: the pairing record (`module-graph.i18n.yaml`) is 10 lines for a 1,776-line page, because the whole graph is a generated region.
- Edge cases / failure handling: none beyond the standard pairing rule — the generated bytes must be identical on both sides.
- Surprising: the Mermaid node ids stay English (`pkg_llm_deepseek`) so a diff between the two language files shows only prose changes.

### docs/persistence-catalog.zh.md
- Purpose: The generated Chinese counterpart of the persistence event catalogue. *(Read during research, but owned by `dsh-docs-rest#2` — see Uncertainties.)*
- Key abstractions: mirrors the English fingerprint table, envelope and resolved-type sections; generated regions are byte-identical.
- Data flow: regenerated together with the English source and the pairing record and the machine schema inventory.
- Non-obvious design decisions: the Chinese file uses the same `persistence-catalog` fence kind and the same anchor ids so the fingerprint links resolve identically on both sides.
- Edge cases / failure handling: a reviewed Chinese counterpart of a *generated* English source is allowed and preferred; the pairing record's 2,152 entries are the per-section hashes of the prose outside the generated regions.
- Surprising: the `persistence-catalog.i18n.yaml` record is 90 KB — 2,152 hash pairs — because this catalogue has hundreds of resolved-type headings, each needing its own merge-safe record line.

### docs/persistence-catalog.i18n.yaml
- Purpose: The per-heading-section bilingual pairing record for the persistence catalogue — the largest record file in the shard (2,152 hash pairs).
- Key abstractions: keys are the English heading-slug path; `~2`, `~3` suffixes disambiguate repeated headings; values are 16-hex-digit content hashes of each side's blocks.
- Data flow: `pnpm run verify-translation-pairing --write docs/persistence-catalog.md` recomputes and rewrites the record; a section whose blocks are all inside generated regions or code fences has no entry at all.
- Non-obvious design decisions: the record is *merge-safe by construction* — because each entry covers one heading section, two branches editing different sections touch different yaml lines and Git merges them without conflict.
- Edge cases / failure handling: the tail of the file shows the `resolved-persistence-types/...` entries and the `section` / `section~2` disambiguation for a repeated heading, which is exactly the case the `~2` suffix exists for.
- Surprising: entries whose `en` and `zh` hashes are *equal* exist (e.g. `/session-persistence-event-catalog/events/agent` at lines 20–22) — the record hashes content that merely happens to be identical, and code/generated content is excluded but not special-cased.

### docs/i18n/style-samples.md
- Purpose: The voice calibration anchor — seven human-approved EN↔ZH gold pairs, one per document genre (architecture narrative, defensive rules, test policy, mechanism description, policy statement, Agent Note argument, long-paragraph splitting).
- Key abstractions: the "points distilled from the samples" list at the end (lines 77–87), which is the actionable form of the calibrations.
- Data flow: a translator or reviewer compares against the *nearest* sample; "译文语体以这些样例为准——文体样例的效力高于对语气的文字描述，但术语表、忠实性与结构规则仍然优先" (line 3).
- Data flow note: the file is bilingual by construction and is **excluded** from pairing — it is a pair, not a pair member.
- Non-obvious design decisions: the samples include the *negative* form as well as the positive ("Bad" / "Good" pairs), which is what makes them calibrating rather than merely exemplary; and the distilled list explicitly encodes engineering-idiom substitutions (false positive/negative → 误报／漏检, ratchet → 只向前收紧不倒退放宽, reviewable act → 评审凭证).
- Edge cases / failure handling: "样例与 terminology.md 冲突时，以术语表为准" (line 86) — the samples are subordinate to the glossary even though they outrank the prose voice rules.
- Surprising: the last distilled point says "代码体标识符（事件名 `agent/status`、状态值 `running`、包名 `dsh-bash-local` 等）在译文中保留 code span 原文，不得口语化改写；Pass 2 必须逐句核验" — the two-pass self-review of the translation prompt is a *contract* here too.

### docs/i18n/README.zh.md
- Purpose: The Chinese counterpart of the bilingual pairing contract.
- Key abstractions: same three-sibling-file rule, same per-section hash record, same exclusions list.
- Data flow: identical to the English page — edit one side, patch the other, re-record.
- Non-obvious design decisions: the Chinese page preserves the "both languages carry equal authority" framing — a Chinese-first document is as legitimate as an English-first one (English line 9).
- Edge cases / failure handling: the same exclusion list, including `docs/AGENTS.md` and the archived Agent Notes.
- Surprising: the Chinese page is 71 lines against the English 69 — the translations are not line-for-line mirrors, which is exactly what the rules permit for prose while forbidding for structure.

### docs/i18n/translation-rules.zh.md
- Purpose: The Chinese counterpart of the translation rules.
- Key abstractions: the same RFC 2119 level vocabulary, rendered as 必须／禁止／应当／可以 with the source emphasis preserved.
- Data flow: same as the English rules; a Chinese target follows the "中文" column and the "首次出现" annotation.
- Non-obvious design decisions: the Chinese rules are not a translation of the English *rules* but the same rules written for a Chinese target — e.g. the English rule "prefer established target-language engineering idiom over calques" becomes an explicit list of Chinese substitutions.
- Edge cases / failure handling: code fences must be byte-identical including comments; inline code spans are never translated; relative links must use the source side's locale path.
- Surprising: the Chinese version is 69 lines vs the English 69 — coincidental, but the Chinese adds explicit full-width punctuation and mixed-script spacing rules that the English page does not need.

### docs/cookbook/adding-a-package.zh.md
- Chinese counterpart of the package checklist; the file tree, JSON snippets and the 17-role naming table are translated while code blocks stay byte-identical.

### docs/cookbook/adding-a-plugin-preview.zh.md
- Chinese counterpart of the plugin preview guide; the SVG constraints (640×300, self-contained, both languages) and the pixel page contract are translated.

### docs/cookbook/adding-a-remote-api.zh.md
- Chinese counterpart of the Remote API guide; the `RemoteError` code table and the client `RemoteResult` branching examples are translated, code identical.

### docs/cookbook/adding-a-session-format-version.zh.md
- Chinese counterpart of the format-version tutorial; the migration-edge and corpus-trial command blocks are identical.

### docs/cookbook/adding-a-settings-card.zh.md
- Chinese counterpart of the live configuration forms guide; the `Volatile` config snippet and the slot-registration snippet are identical.

### docs/cookbook/adding-a-tool.zh.md
- Chinese counterpart of the tool authoring reference; every code fence byte-identical to the English, prose translated with the terminology table's Chinese column.

### docs/cookbook/adding-a-vendored-package.zh.md
- Chinese counterpart of the vendored-package checklist; the vendored `tsconfig.json` and `package.json` snippets are identical.

### docs/cookbook/adding-an-llm-adapter.zh.md
- Chinese counterpart of the LLM adapter guide; the adapter skeleton and the protocol-obligation list are translated, code identical.

### docs/cookbook/extension-cookbook.zh.md
- Chinese counterpart of the extension cookbook; the feature-mechanism table rows are translated, the code snippets identical.

### docs/cookbook/maintaining-dsh-code-review.zh.md
- Chinese counterpart of the skill-maintenance cookbook; the workflow steps and the three operator decisions are translated.

### docs/cookbook/responding-to-pr-review-on-a-stack.zh.md
- Chinese counterpart of the stacked-PR guide; the five ground rules and the verification list are translated.

### docs/cookbook/reviewing-persistence-type-changes.zh.md
- Chinese counterpart of the persistence-type workflow; keeps the English YAML frontmatter *key* but translates its value (line 2).

### docs/cordis-api/context.zh.md
- Chinese counterpart of the generated Context reference; the `ts cordis-catalog` fences and the vendored source anchors stay untranslated.

### docs/cordis-api/events.zh.md
- Chinese counterpart of the generated Events reference; the dispatch-mode type and method signatures are identical.

### docs/cordis-api/fiber.zh.md
- Chinese counterpart of the generated Fiber reference; the state machine and effect/disposer signatures are identical.

### docs/cordis-api/registry.zh.md
- Chinese counterpart of the generated Registry reference; the `Plugin` namespace declarations are identical.

### docs/cordis-api/service.zh.md
- Chinese counterpart of the generated Service reference; the static symbol keys are identical.

### docs/cordis-tutorial/index.zh.md
- Chinese counterpart of the tutorial landing page; the chapter list and the `node --import tsx` launcher command are identical.

### docs/cordis-tutorial/01-first-plugin.zh.md
- Chinese counterpart of tutorial chapter 1; the expected console output stays in English because it is program output.

### docs/cordis-tutorial/02-lifecycle-and-effects.zh.md
- Chinese counterpart of tutorial chapter 2; the `ctx.effect` snippets and the fiber state diagram are identical.

### docs/cordis-tutorial/03-services.zh.md
- Chinese counterpart of tutorial chapter 3; the `declare module` and `inject` snippets are identical.

### docs/cordis-tutorial/04-events.zh.md
- Chinese counterpart of tutorial chapter 4; the dispatch-mode table and the waterfall demo are translated with identical code.

### docs/cordis-tutorial/05-config.zh.md
- Chinese counterpart of tutorial chapter 5; the `Schema.object` and volatile-field snippets are identical.

### docs/cordis-tutorial/06-composition-and-hmr.zh.md
- Chinese counterpart of tutorial chapter 6; the PENDING-fiber diagnostic code block is byte-identical.

### docs/cordis-tutorial/07-into-the-harness.zh.md
- Chinese counterpart of tutorial chapter 7; the `defineTool` and observer-plugin snippets are identical.

### docs/defensive-patterns/README.zh.md
- Chinese counterpart of the defensive-patterns index; the routing table targets the `.zh.md` pages.

### docs/defensive-patterns/client-components.zh.md
- Chinese counterpart of the client component rules; the inject/slot examples and the `ts ignore-check` wrong-forms are byte-identical.

### docs/defensive-patterns/conversation-and-session.zh.md
- Chinese counterpart of the conversation and session rules; the projection and node-definition snippets are identical.

### docs/defensive-patterns/general.zh.md
- Chinese counterpart of the general defensive patterns; 252 lines against the English 222 because the boundary clauses are longer in Chinese (permitted — paragraph boundaries may differ).

### docs/defensive-patterns/package-surface.zh.md
- Chinese counterpart of the package surface rules; the `package.json` and `exports` snippets are identical.

### docs/defensive-patterns/remote-and-api.zh.md
- Chinese counterpart of the remote and API rules; the `@Remote` example and the wrong-form block are identical.

### docs/agent-lifecycle.i18n.yaml
- Pairing record for `agent-lifecycle.md`: two hash pairs (the preamble and the H1), because the Mermaid sequence is a generated region excluded from hashing.

### docs/api-gateway.i18n.yaml
- Pairing record for `api-gateway.md`: nine hash pairs, one per prose heading (programming model → boundaries/business-ownership).

### docs/architecture.i18n.yaml
- Pairing record for `architecture.md`: twelve hash pairs, one per prose heading including turn-flow and session-log.

### docs/capability-seams.i18n.yaml
- Pairing record for `capability-seams.md`: two hash pairs only — the graph and the service table are generated regions.

### docs/cli-help.i18n.yaml
- Pairing record for `cli-help.md`: nine hash pairs; the preamble's `en` and `zh` hashes are identical because that section is machine-identical on both sides.

### docs/config-catalog.i18n.yaml
- Pairing record for `config-catalog.md`: five hash pairs despite a 4,801-line page, because the generated blocks dominate it.

### docs/cordis-primer.i18n.yaml
- Pairing record for `cordis-primer.md`: six hash pairs (five ideas, dispatch modes, waterfall semantics, loader configuration, practical rules).

### docs/deepseek-llm-api-wire-extensions.i18n.yaml
- Pairing record for the wire-extensions reference: nine hash pairs including the acceptance-watermark sub-section.

### docs/development.i18n.yaml
- Pairing record for `development.md`: thirteen hash pairs including the TypeScript project layout sub-section.

### docs/event-producer-consumer.i18n.yaml
- Pairing record for `event-producer-consumer.md`: three hash pairs; the undeclared-strings table is a generated region and hashes identically on both sides.

### docs/experimental-persistence-catalog.i18n.yaml
- Pairing record for the experimental catalogue: two hash pairs.

### docs/glossary.i18n.yaml
- Pairing record for `glossary.md`: seven hash pairs, one per term group (capability-seam, agent-scope, goal, human command, loop hierarchy, Ralph).

### docs/graph-atlas.i18n.yaml
- Pairing record for `graph-atlas.md`: two hash pairs; the index table is the whole page and is translated in both.

### docs/i18n/README.i18n.yaml
- Pairing record for `docs/i18n/README.md`: five hash pairs (pairing contract, gate, scope and exclusions, division of labour).

### docs/i18n/translation-rules.i18n.yaml
- Pairing record for `translation-rules.md`: eight hash pairs, one per rule section.

### docs/module-graph.i18n.yaml
- Pairing record for `module-graph.md`: two hash pairs; the whole Mermaid graph is a generated region.

### docs/cookbook/adding-a-package.i18n.yaml
- Pairing record for the package checklist: eight hash pairs, including the Model Experience README sub-section.

### docs/cookbook/adding-a-plugin-preview.i18n.yaml
- Pairing record for the plugin preview guide: six hash pairs for the five numbered steps.

### docs/cookbook/adding-a-remote-api.i18n.yaml
- Pairing record for the Remote API guide: eight hash pairs (declare, failures, register, consume, test, verify).

### docs/cookbook/adding-a-session-format-version.i18n.yaml
- Pairing record for the format-version tutorial: thirteen hash pairs, including nested keys for the V4 corpus trial and the frozen V3 vocabulary.

### docs/cookbook/adding-a-settings-card.i18n.yaml
- Pairing record for the live configuration forms guide: six hash pairs for the five numbered steps.

### docs/cookbook/adding-a-tool.i18n.yaml
- Pairing record for the tool authoring reference: nine hash pairs including the execute contract and the UI card section.

### docs/cookbook/adding-a-vendored-package.i18n.yaml
- Pairing record for the vendored-package checklist: four hash pairs.

### docs/cookbook/adding-an-llm-adapter.i18n.yaml
- Pairing record for the LLM adapter guide: four hash pairs.

### docs/cookbook/extension-cookbook.i18n.yaml
- Pairing record for the extension cookbook: seven hash pairs.

### docs/cookbook/maintaining-dsh-code-review.i18n.yaml
- Pairing record for the skill-maintenance cookbook: six hash pairs.

### docs/cookbook/responding-to-pr-review-on-a-stack.i18n.yaml
- Pairing record for the stacked-PR guide: four hash pairs.

### docs/cookbook/reviewing-persistence-type-changes.i18n.yaml
- Pairing record for the persistence-type workflow: nine hash pairs, starting with a `/` entry for the YAML frontmatter section.

### docs/cordis-api/context.i18n.yaml
- Pairing record for the generated Context page: thirty-three hash pairs, one per generated member heading.

### docs/cordis-api/events.i18n.yaml
- Pairing record for the generated Events page: nine hash pairs for the dispatch methods and the `DispatchMode` type.

### docs/cordis-api/fiber.i18n.yaml
- Pairing record for the generated Fiber page: thirty-seven hash pairs, one per Fiber member heading.

### docs/cordis-api/registry.i18n.yaml
- Pairing record for the generated Registry page: five hash pairs.

### docs/cordis-api/service.i18n.yaml
- Pairing record for the generated Service page: ten hash pairs for the static symbol keys.

### docs/cordis-tutorial/01-first-plugin.i18n.yaml
- Pairing record for tutorial chapter 1: six hash pairs.

### docs/cordis-tutorial/02-lifecycle-and-effects.i18n.yaml
- Pairing record for tutorial chapter 2: four hash pairs.

### docs/cordis-tutorial/03-services.i18n.yaml
- Pairing record for tutorial chapter 3: six hash pairs.

### docs/cordis-tutorial/04-events.i18n.yaml
- Pairing record for tutorial chapter 4: four hash pairs.

### docs/cordis-tutorial/05-config.i18n.yaml
- Pairing record for tutorial chapter 5: five hash pairs.

### docs/cordis-tutorial/06-composition-and-hmr.i18n.yaml
- Pairing record for tutorial chapter 6: four hash pairs.

### docs/cordis-tutorial/07-into-the-harness.i18n.yaml
- Pairing record for tutorial chapter 7: four hash pairs.

### docs/cordis-tutorial/index.i18n.yaml
- Pairing record for the tutorial landing page: four hash pairs.

### docs/defensive-patterns/README.i18n.yaml
- Pairing record for the defensive-patterns index: two hash pairs (the H1 and the habits section).

### docs/defensive-patterns/client-components.i18n.yaml
- Pairing record for the client component rules: fourteen hash pairs, one per rule.

### docs/defensive-patterns/conversation-and-session.i18n.yaml
- Pairing record for the conversation and session rules: nine hash pairs, one per rule.

### docs/defensive-patterns/general.i18n.yaml
- Pairing record for the general defensive patterns: fifteen hash pairs, one per bug-class rule.

### docs/defensive-patterns/package-surface.i18n.yaml
- Pairing record for the package surface rules: eight hash pairs, one per rule.

### docs/defensive-patterns/remote-and-api.i18n.yaml
- Pairing record for the remote and API rules: four hash pairs.

## Ideas worth stealing

- **Make every package document its own KV-cache and token effect as a gated README section.** `docs/cookbook/adding-a-package.md:99` defines a mandatory `#### KV Cache effect` field under a `## Model Experience` section, and `docs/cookbook/adding-a-package.md:108` specifies the four distinctions it must make: *append-only growth, a stable repeated prefix, replacement of earlier request tokens, and an independent model request* — plus "name the package-owned changes that can invalidate reuse". This turns "don't break the prompt cache" from tribal knowledge into a per-package, reviewable, machine-checked contract, and it is exactly the discipline August's prompt-assembly path needs (August's memory tail, tool schemas, and system-prompt sections each change the prefix). The audited escape hatches are also specified (`docs/cookbook/adding-a-package.md:110`): a package with no effect writes `None, as ` / `Indirectly, through ` and *still* states its cache effect.
- **Separate durable model-visible facts from transient live frames, and make the durable log the only source of truth.** `docs/architecture.md:124` states the rule as "**Model-visible means logged.** Every model request must be reconstructable from the log. New model-visible inputs require session events." The loop keeps `agent/assistant-stream` chunk frames process-local and transient, and commits the complete compact stream as one `assistant/message` (success) or `assistant/attempt` (failure) before a committed end frame (`docs/architecture.md:106`). For August this is the difference between a transcript that can be replayed/audited after a crash and one that cannot — and the failure/attempt split is what makes a failed provider call visible instead of silently dropped.
- **Give the LLM adapter exactly two sanctioned error channels and make the runtime normalise them.** `docs/cookbook/adding-an-llm-adapter.md:30` allows only THROW from `stream()` (transport/protocol) or a terminal `finish {kind:'error'|'aborted'}` (provider in-band), and `docs/defensive-patterns/general.md:15` requires the *runtime* to expose model-request failures only as terminal finish chunks so "a consumer can name the source of a failure from the public API alone". August's provider layer currently has to guess whether a caught exception came from the provider, a wrapper, or its own assembly; this is a one-rule fix. The same page's `finish.replayState` rule (`docs/cookbook/adding-an-llm-adapter.md:33`) — minimal lossless-JSON native metadata, passed only when the *same adapter instance* owns both the historical and target route — is the safe way to do cross-turn provider state restoration.
- **Make the tool surface a typed, validated, frozen contract with one canonical JSON value.** `docs/cookbook/adding-a-tool.md:42` (args validated against the unified `ParameterSchemaSpec` before `execute` runs), `:44` (arguments materialised as detached lossless JSON, frozen before policy, an opaque `exec.token`, and only an around-dispatch wrapper allowed to replace — never remove — `exec.signal`), and `:45` (one canonical JSON value; the registry snapshots, validates and freezes it) mean a model cannot smuggle a mutable or unvalidated argument into a tool. The complementary rule at `:46` — *throwing or returning an invalid value means `isError`* — keeps a successful-but-unhappy outcome (a non-zero exit) a value rather than an exception, which is what lets August's UI and its receipts agree.
- **Split tool output into model-facing prose and replayable UI state, and make the UI presenters pure.** `docs/cookbook/adding-a-tool.md:88` ("UI-only formatting stays out of the model result") and `:87` (presenters "must be pure functions of `args` (+ the result) — NO I/O, NO reading session state, NO clock/random", because they run on live streaming *and* on session-log replay) plus the durable `output.presentationMeta(args, value)` channel (`:48`) give a three-way split: canonical value → model, `render` → model prose, `presentationMeta` → replayable card state. August's "one line in the transcript" cards and its persisted `result.meta` would benefit directly.
- **Bound context by a *policy*, not by a byte count, and give the policy a named headroom and retry ladder.** `docs/config-catalog.md:704-723` specifies `thresholdRatio` 0.8, `headroomTokens` 65536, `retainRatio` 0.16, `compactionRetries` 1, `maxOverflowRetries` 1 (`0` disables), and a separate summarizer provider/model that must be set together or inherit the conversation target, with exact per-model overrides that fail plugin load on duplicates. The separate tool-result pruner (`docs/config-catalog.md:745-752`: 8192 code points threshold, 4096 head, 1024 tail) prunes *before* summarisation. This is a directly portable compaction policy: the two knobs August currently conflates (how much to keep, when to compact) become four independent, per-model-overridable dials.
- **Detect a stuck loop on the *canonical* call identity, and bound the reminder, not the detection.** `docs/config-catalog.md:2625-2632` states that the repeat-reminder quotes at most 500 characters of canonical arguments, "the cap bounds the reminder, never the detection (the chain key always compares the FULL canonical string)", with thresholds `[3,5,8]` and `*`-wildcard include/exclude predicates that are valid even when they match no registered tool. August's self-heal reminder would otherwise grow unbounded exactly in the case it is meant to catch.
- **Keep the model's wire extensions *outside* the model-visible prefix, and make their delivery at-least-once with a monotone watermark.** `docs/deepseek-llm-api-wire-extensions.md:7` ("they do not add model-input tokens or alter the model-visible prefix"), `:37` (a contributor that fails to prepare is omitted while the others still ship; a body that fails to serialize sends the base body and *skips acceptance so contributors resend*), and `:154` (the watermark folds the greatest matching `throughSeq` for the current session id **and format generation**, so concurrent accepted requests cannot move the cursor backward) together give a telemetry/metadata side-channel that is free of prompt-cache cost and cannot lose events silently.
- **Cache the prompt by *reusing a system head* rather than by tuning a flag.** `docs/architecture.md:110` states the mechanism: "The first admitted step reserves the system head before user messages even for an empty prompt (no wire message). The prompt travels only as `system/message` history: an empty rendering clears all active system nodes, leaving no old prompt model-visible; capable routes append non-empty updates after cached history, including supported tool updates; incapable routes and new request series consolidate non-empty prompt text at the first system node." A "capable" route can therefore *append* a section (append-only prefix growth) while an incapable route must rewrite the head — and the doc says which is which. This is a much sharper statement of prefix stability than "keep the system prompt short".
- **Compute conversation nodes incrementally and publish on a cadence, never per chunk.** `docs/defensive-patterns/conversation-and-session.md:128-135` forbids `immediate` publication and full recomputation on the high-frequency delta path, and names the vocabulary `none` / `animation-frame` / `immediate`; the wrong form "puts the whole node collection on the frame budget, and the transcript stalls behind the stream". Combined with "Projection is the only read and compute path" (`:9`) and "Cold reads are the last resort" (`:52`), this is the whole "long chat under streaming does not drop frames" story: one pushed read path, one fold, one cadence.
- **Hold a Session by explicit reference, and reclaim only on `refCount == 0 && inflight == 0`.** `docs/defensive-patterns/conversation-and-session.md:87` forbids enumerating business state to decide what may be reclaimed, "because that list has to be maintained by every feature that adds one" — an implicit holder makes reclamation unauditable. August's session/chat retention should carry the same explicit retain/release discipline.
- **Make a "one read path" law explicit: a session-derived value is read through a projection, never fetched by the component.** `docs/defensive-patterns/conversation-and-session.md:9` — "Two answers to the same question — one pulled, one pushed — drift apart, so a render can show a value the Session log no longer supports" — plus the `stateVersion` rule (bump on any fold-semantics change; registering one key twice with different `stateVersion` throws instead of merging) is a complete recipe for August's brain/memory read path.
- **Give every remote/API failure one class and one code table, and read the caller only from the invocation.** `docs/cookbook/adding-a-remote-api.md:53` ("Do not build a family of domain error classes"), `:57-60` (a code is declared next to its single producer, or in the lowest common domain package; carrier codes are used, never copied) and `docs/defensive-patterns/remote-and-api.md:53` ("access control never checks a resource they omit"; "The caller is read only from `this.ctx.invocation.peer.principal`, never from arguments") together make August's tool/API boundary auditable: every refusal has a code, a code has one owner, and the caller's identity cannot be forged by an argument.
- **Keep the plugin surface honest: four exports for a function plugin, no fifth.** `docs/defensive-patterns/package-surface.md:9` — "The rule stops a test convenience from freezing into published API" — combined with the ban on mixing the function and default-export forms (the Loader then discards the namespace) and the ban on a module-level store handle as "a disguised singleton across plugin reloads" (`docs/defensive-patterns/client-components.md:236`). For August's own plugin/tool surface this is a cheap, mechanical rule that prevents exactly the "one helper export added for a test" rot.
- **State the review judgment condition for every rule, and forbid the self-approved exception.** Every defensive-pattern page carries a "judged by" clause and names *who* approves an exception, and `docs/defensive-patterns/general.md:52` makes it explicit that "a call site that cannot state both behaviors is a review blocker, not a style preference". `docs/defensive-patterns/remote-and-api.md:13` likewise: "Where the business boundary itself is contested, the domain owner settles it as an architecture question before the change lands." This is the difference between a rule and a slogan.
- **Prove a regression guard fails on the unfixed code before trusting it.** `docs/cookbook/responding-to-pr-review-on-a-stack.md:22` — "for a regression guard, prove it FAILS on the unfixed code (introduce the regression, watch red, revert) — a guard that passes both ways guards nothing", and "a sub-agent's report describes intent, not necessarily what landed". This is the missing half of August's static gates, several of which (by the workspace's own account) have been proven to catch real defects — the same proof discipline applies to them.
- **Keep bilingual documentation merge-safe with per-section content hashes instead of a translation-memory file.** `docs/i18n/README.md:11-22` — the record is one hash pair per heading section, so "edits to different sections change separate record lines, so Git's default text merge, including GitHub's, composes them", and an out-of-sync pair is repaired by "patching the counterpart minimally against the edited side's diff, never by re-translating whole files". The pairing record is the *reviewable act* of confirming consistency (`:22`), and the gate's limit is stated honestly (`:44`).
- **Give the translation pipeline a two-pass, self-reviewing output contract with a machine-readable pending-term channel.** `docs/i18n/translation-prompt.md:153-199` — pass 1 writes the translation, pass 2 re-reads it *in the target language only* (which makes awkward phrasing visible), then compares clause by clause, writes only actual corrections to `<review>`, and emits the corrected whole document in `<final>`; unknown terms must be reported as `[Terminology: pending]` in `<review>` and "must not be silently adopted in `<translation>` or `<final>`" (`:124`). The pending channel is a review queue, not a footnote.
- **State the model-facing cost of every capability in a fixed, checkable vocabulary.** `docs/cookbook/adding-a-tool.md:87-89` — the UI presenters must be pure; UI-only formatting must not ride in the canonical value; and `defineTool` soft-validates the display path so "display must never crash a replay". A renderer that can throw on a malformed replay is a liveness bug in the transcript; making the display path total is the fix.
- **Express the "one canonical reading" of the product as a feature→mechanism table so the microkernel claim becomes checkable.** `docs/cookbook/extension-cookbook.md:104-132` maps every product feature to a listener on a documented extension point — compaction, plan mode, MCP, skills, memory, scheduled tasks, sub-agents, the goal round driver, ToolSearch, and the monotonic terminal-turn policy — and the page's own framing is "Every product feature maps to a listener on a documented extension point — the microkernel claim made checkable". The table doubles as the architectural test: if a feature has no row, it either modified the loop or has no mechanism.
- **Give every "how do I add X" the same shape: a numbered checklist, an exact verify command, and a named template package.** `docs/cookbook/adding-a-package.md:5` ("This checklist is validated against the bash and adapter packages as templates; if it drifts from them, fix it here") and `:161-168` (the verify block) — the *template package* is the drift oracle, which is a cheaper and more durable form of "keep the docs in sync" than a prose review.

## Files skipped (with reasons)

None of the shard's files are *skipped* in the ledger sense — every one of the 149 was opened and identified, and every one is marked `read`. Six files are large enough that I did **not** read them line by line; for each I read enough to state exactly what it is and where its content comes from, and I say so here and in the ledger note:

- `docs/config-catalog.md` (4,801 lines) and `docs/config-catalog.zh.md` (4,803 lines) — **generated** by `scripts/gen-config-catalog.ts` from every loadable package's declared config type. I read the header (the generator contract and the `inject`/`refs`/`source` labelling), the full section for `dsh-agent-loop`, and targeted sections for `dsh-compaction-basic`, `dsh-compaction-tool-result-pruner`, `dsh-llm-retry`, `dsh-repeat-tool-reminder`, `dsh-spill-policy`, `dsh-subagent`, `dsh-subagent-acp`, `dsh-system-prompt`, `dsh-tools` and `dsh-typert-loader`, plus the complete list of package headings and their `inject` sets. Not read line by line because the file is 250+ near-identical generated blocks; the mechanism I report is the generator's, which the header states.
- `docs/persistence-catalog.md` (9,140 lines) — **generated** by `scripts/gen-persistence-catalog.ts` from the `SessionEventMap` declaration merges. I read the header (envelope, surface-vs-log-only rule, fingerprint normalisation rules), the full 86-row root-fingerprint table, and the `SurfaceEventType` / `SurfaceOp` definitions. Not read line by line because the remaining bulk is one generated block per resolved type.
- `docs/persistence-catalog.i18n.yaml` (2,152 lines) — a **generated** pairing record: 2,152 `en:`/`zh:` hash pairs, one per heading section. I read the header, the first 30 entries and the last 33 (including the `section~2` disambiguation case). Not read line by line because every line has the identical shape and carries no prose.
- `docs/module-graph.md` (1,776 lines) and `docs/module-graph.zh.md` (1,778 lines) — **generated** by `scripts/gen-module-graph.ts`; a Mermaid node/edge list of peer dependencies. I read the header, the first 120 lines (the group definitions) and confirmed the edge-list shape. Not read line by line because the remaining content is ~1,600 `pkg_x --> pkg_y` lines.
- `docs/dependency-catalog.json` (7,312 lines) — a **machine-captured JSON inventory** of the published `@deepseek-ai/dsh` package's installed dependency tree, with a `resolution` block and one entry per dependency. I read the header (the resolution environment) and the first ~80 lines of the dependency array, confirming the per-entry `installations[].{direct,optional,peer}` shape. Not read line by line because it is 7,000 lines of repetitive dependency records with no prose.

## Uncertainties

- **Two files in this shard were read but are listed in the manifest as owned by another shard.** `docs/persistence-catalog.zh.md` exists in the clone (353,356 bytes) and I read it (it is the generated Chinese counterpart of the persistence catalogue), but the manifest assigns it to `dsh-docs-rest#2`, so it is **not** in my 149-row ledger. I verified this with a targeted query over `manifest.tsv` (the row for `docs/persistence-catalog.zh.md` has `owner-shard = dsh-docs-rest#2`); I read it only because it is interleaved with my files. Similarly `docs/cordis-api/inherited.md` is in **my** shard and is listed in the report; it has no `.zh.md` and no `.i18n.yaml` because it is an explicit exclusion (`docs/i18n/README.md:58`).
- **I could not verify from this shard that the harness's own agent loop enforces any turn/round ceiling.** The shard's docs describe the loop's *shape* (`docs/agent-lifecycle.md`, `docs/architecture.md:83-104`) and its compaction policy (`docs/config-catalog.md:704-723`), but the loop's budget/bound constants live in `packages/core/agent-loop`, which is outside this shard. `docs/config-catalog.md:99-116` shows the agent-loop's *only* declared config keys are `maxParallelToolCalls` and `agents[]` — so no turn-count ceiling is declared at the plugin-config surface. Whether one exists inside the loop package, I did not check.
- **I could not establish the harness's prompt-cache strategy in terms of provider prefix caching.** `docs/architecture.md:110` describes system-head reservation and append-vs-consolidate behaviour, and `docs/cookbook/adding-a-package.md:108` mandates a per-package "KV Cache effect" statement — but no document in this shard states a provider-side cache-control header, a cache-read indicator, or a measured hit rate. The "KV Cache" vocabulary here is about *request-prefix stability*, which is the part that transfers; whether DeepSeek's API exposes an explicit cache flag, this shard does not say.
- **The `docs/i18n/README.md:58` exclusion list references `docs/AGENTS.md` as excluded from pairing, and it is** — so `docs/AGENTS.md` is the only substantive English file in my shard with no `.zh.md` and no `.i18n.yaml`. I read it fully; it is the documentation standard.
- **Line-number drift risk.** Every `file:line` reference in this report was taken from the clone at `C:/Users/rober/AppData/Local/Temp/harness-research/deepseek-harness` as read on 2026-10-22. The `docs/` tree is bilingual-paired and frequently edited, so line numbers in the upstream repository may differ. The line numbers are exact for the clone I read.
- **`docs/capability-seams.md` claims a "completeness guard" for its service classification (`docs/capability-seams.md:714`), but I did not open `scripts/gen-doc-graphs.ts` (outside this shard) to confirm what the guard actually checks.** I report the claim as the document states it.
- **`docs/dependency-catalog.json` records a capture from 2026-09-12 of the *published* package at version `0.1.5-rc.1`,** which is older than the checkout's own version. It is a consumer-side snapshot, not a description of the current monorepo tree; `docs/module-graph.md` is the developer-side view. I did not reconcile the two (that would require reading `package.json` files outside this shard).
- **I did not read the sibling shards.** The shard overlaps with `dsh-docs-rest#2` on `docs/persistence-catalog.zh.md` and with other shards on `packages/**`, `scripts/**`, and `apps/**`. Conclusions about the harness's runtime behaviour are drawn only from the documentation in this shard; where the docs describe code I did not read (`packages/core/agent-loop`, `packages/core/tools`, `packages/llm/*`, `packages/compaction/*`), I have said so above.
