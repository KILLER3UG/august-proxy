# pi / evals

## Shard shape

This shard is the `packages/evals` workspace package of the `pi` repo (30 files, ~150 KB of TypeScript). It is not part of the agent loop at all — it is the **measurement instrument** for the agent loop: a `vitest-evals`-based harness that runs a real `pi` coding agent against a real model and turns the result into a **paired A/B comparison with a withheld-headline failure mode**. The package has four moving parts. `src/harness.ts` is the adapter that boots an isolated `AgentSession` (isolated HOME, isolated agent dir, in-memory credential store, unprivileged UID drop) and returns transcript events, token usage and the session file as harness artifacts. `src/plan.ts` turns discovered Vitest case names into a fully enumerated `(case, variant, model, runNumber)` cohort. `src/docker.ts` + `docker/` build two container images that differ in exactly one respect (whether the coding-agent documentation and its `<docs>` prompt section are present) and run one arm per fresh container. `src/report.ts` reads the native Vitest JSON of each arm, pairs arms against the *written plan*, and computes pass-rate lift plus paired token/tool/latency/cost deltas — refusing to publish a headline if any pair is blocked. `evals/` holds the actual cases (a smoke test, a documentation-audit sweep over every doc page, and four paired doc-lift cases covering extensions, providers, models and TUI theming), `test/` holds unit tests for the runner itself using a real fixture HTTP provider (`acme-server.ts`) that speaks two wire protocols. The two halves fit together through one idea: **an experiment that cannot prove its own premises is not allowed to produce a number.** The shard's coverage of the standard harness lenses is therefore deliberately uneven — it goes very deep on *evaluation design, isolation, error honesty and reporting* and barely touches the agent loop, steering, compaction and skills.

## Per-file notes

### packages/evals/src/harness.ts
- **Purpose:** The vitest-evals adapter — the single place a `pi` agent session is created, run and torn down for an eval. Everything the runner learns about a run flows through `runPiCodingAgent` (line 272).
- **Key abstractions:** `PiCodingAgentHarnessOptions` (model selection, tool allowlist, `workspaceFiles`, `transformSystemPrompt`, `expectedPiDocumentation`); `PiCodingAgentInput` = `string | Array<{type:"prompt",content} | {type:"reload"}>` (line 43) — a multi-step script of prompts and reloads; `DOCUMENTATION_EVAL_TOOLS = ["read","write","edit","grep","find","ls"]` (line 485); `SandboxIdentity {uid,gid}` (line 102).
- **Data flow:** resolve model → `mkdtemp` a root containing `workspace/`, `home/`, `sessions/` (line 283) → `applyIsolatedEnvironment` overrides HOME/USERPROFILE/`PI_CODING_AGENT_DIR` and deletes every `PI_EVAL_*` var so the agent cannot see the runner's metadata (line 82) → read the host `auth.json` credential into an `InMemoryCredentialStore` (line 314) → `createAgentSessionServices` + `SessionManager.create(workspace, root/sessions)` (line 337) → `enterToolSandbox` drops the process to the sandbox UID (line 365) → run the prompt/reload steps → collect `toTranscriptEvents(session.messages)`, `session.getSessionStats()` and a sha256 of the system prompt → `verifySystemPrompt` → the optional `output()` callback → in `finally`, read the session file into the `piSessionJsonl` artifact, dispose the session, `rm -rf` the temp root, restore the environment.
- **Non-obvious design decisions:**
  - The transformed-module cache is protected *before* the privilege drop (lines 130-152): Node's type-stripping leaves transformed copies of the eval modules in `tmpdir`, so those files are chmodded 0600 while their cache roots stay 0755 — otherwise the judge source survives on disk where the dropped UID can read it.
  - The drop is **verified, not assumed** (lines 174-187): after `setuid`, every protected path is re-read and the run throws if one is still readable.
  - The credential is hidden at the *process* boundary, not just the file boundary (lines 328-335): with a sandbox identity the host `auth.json` is deleted and the API-key environment variable is removed from `process.env`, then restored after the run (lines 443-445).
  - `verifySystemPrompt` (line 257) asserts the prompt actually sent matches the arm's intent — `<rules>` must survive and `<docs>` must be present exactly when `expectedPiDocumentation` is true — so a mis-wired variant fails loudly instead of silently measuring nothing. It is called *after* the model was already prompted (line 413), i.e. it catches a bad experiment, it does not prevent a bad prompt from being sent.
  - Only expected inline extensions may load (lines 357-363): any extension path the session picked up beyond `<inline:name>` aborts the run, so a developer's personal extensions cannot contaminate an eval.
  - `hasPricing` (line 392) reports `estimatedCostUsd` **only** when the model has a non-zero price; a free model yields no cost field at all, so its cost is *absent*, not `$0.00`.
- **Edge cases / failure handling:** cleanup errors are aggregated with the run error rather than replacing it (`AggregateError`, lines 448-455); a run that failed *after* producing diagnostics re-attaches the partial run to the thrown error (lines 456-466) so the report can still record the failed arm's token cost; `promptAgent` treats any stop reason other than `stop`/`toolUse` as an error (line 247) and refuses an empty assistant text on a clean stop (line 253); `seedWorkspace` refuses absolute fixture paths and any path escaping the workspace (lines 225-236).
- **Surprising:** `applyIsolatedEnvironment` deletes `PI_EVAL_SANDBOX_UID`/`GID` too, but `resolveSandboxIdentity()` is called *earlier* (line 282 vs line 310) precisely so the drop can still see them — the ordering is load-bearing and undocumented.

### packages/evals/src/report.ts
- **Purpose:** The analysis layer. Turns per-arm Vitest JSON into a paired comparison report, and is the shard's most transferable module.
- **Key abstractions:** `EvalRunIdentity` = `{evalSet, caseId, variant, model, runNumber}` (line 11); `EvalObservation` = identity + metrics + a **discriminated union** `{outcome:"scored", score} | {outcome:"unscored"|"skipped"|"pending"|"errored"}` (line 32); `PairGroup` holds the *expected* count and the *observed* list per variant (line 196); `EvalComparisonReport` schemaVersion 3 (line 75).
- **Data flow:** `readTaskObservation` (line 136) reads the native Vitest JSON plus the `vitest-evals` workspace, checks that exactly one assertion exists, that its `fullName` matches the planned case, that the workspace case status matches the assertion status, that a harness run exists, and that the model that actually answered equals the planned model (line 161) → the observation is appended to `observations.jsonl` → `summarizeEvalObservations` (line 359) groups by `pairKey` **seeded from the written plan** (line 213), resolves each group into a pair or a blocked pair (line 249), computes per-eval-set pass rates and paired metric deltas → `formatEvalComparisonReport` renders it (line 436).
- **Non-obvious design decisions:**
  - **A pair is either two scored observations or it is blocked** (lines 249-281). Missing, duplicate, skipped, pending, unscored or errored arms each produce a *named reason* ("with_docs: errored", "without_docs: expected 1 observation, found 2"), and any blocked pair in an eval set sets `publishHeadline = false` (line 379) so `controlPassRate`/`treatmentPassRate`/`lift` are all `null`. The process then exits nonzero (cli.ts:192). Headline lift is **withheld, never computed over survivors**.
  - **Missing metrics are not zero** (lines 306-318, 85-91): `operationalTotal` returns `{availableRuns, total}` where `total` is `null` when nothing was measured, and the renderer prints "unavailable (0/2 measured)" instead of "0 tokens" (line 431). `optionalMetric` rejects negatives, `NaN` and `Infinity` — a malformed metric turns the whole arm into `errored` (line 176) rather than being silently dropped.
  - The denominator comes from `expectedRuns`, not from the observations (line 230), so a vanished arm shrinks the *eligible* count and enlarges the *blocked* count rather than quietly re-weighting the mean.
  - `difference()` uses `toPrecision(15)` (line 205) so float noise cannot manufacture a delta.
  - Flakiness is detected by collecting the *set* of pass-bits per (case, variant) across repetitions and flagging any set with more than one element (lines 344-355).
  - A zero score is data: `validateScore` accepts 0 and `outcome` stays `"scored"` (line 187 → report.test.ts:184).
- **Edge cases / failure handling:** every read failure (`readReportWorkspace`/`readVitestJsonReportFile` throwing) becomes `outcome:"errored"` (line 142-145); a report containing zero or several assertions is errored (line 149); a model mismatch is errored (line 161); `run.errors.length > 0` forces errored *even though the metrics were already collected* (line 178) — the metrics survive and are still reported.
- **Surprising:** the report deliberately prints the *withheld* case as a first-class line ("Pass rate  withheld because pairs are blocked", line 444) instead of hiding the section. The absence of a number is displayed, not implied.

### packages/evals/src/plan.ts
- **Purpose:** Pure planning — the module that decides *what will be run* before anything is run.
- **Key abstractions:** `DOCUMENTATION_VARIANTS = ["without_docs","with_docs"]` (line 1); `DiscoveredEvalCase {file, fullName, evalSet, caseId}`; `EvalTask` = case + `{variant, model, runNumber}`.
- **Data flow:** Vitest's `list --json` output → `parseDiscoveredCases` splits the test name on `" > "` into `evalSet`/`caseId` (line 28) → `createTaskPlan` expands every case into `runsPerVariant` tasks per variant.
- **Non-obvious design decisions:**
  - The eval-set/case split is a **convention encoded as a parse rule** ("Documentation eval must use \"<eval set> > <case>\"", line 30): a name with no separator or with extra segments is a hard error, so a case can never be ambiguous.
  - Duplicate `(evalSet, caseId)` identities are rejected (line 33) — the identity is the pairing key, and a duplicate would silently merge two cases.
  - **Variant order alternates by run parity** (line 53-54): run 1 is control-then-treatment, run 2 is treatment-then-control. This is the shard's only order-bias control, and it is a two-line mechanism.
  - The model identity must contain exactly one `/` and be non-empty on both sides (line 44) — a malformed identity would produce task directories that collide.
- **Edge cases / failure handling:** `runsPerVariant` must be a safe integer ≥ 1 (line 47); a non-array discovery payload is a `TypeError` (line 22).
- **Surprising:** the plan is *the* artifact of record — `expected-runs.json` is written before execution (cli.ts:168) and the report's pairing is computed against it, so the experiment's denominator is a file on disk rather than an in-memory recollection.

### packages/evals/src/cli.ts
- **Purpose:** The entry point of the documentation comparison (`npm run eval:docs` → `node --experimental-strip-types src/cli.ts`).
- **Key abstractions:** `EvalCliOptions {provider, model, runsPerVariant, requestedFiles, discoveryArgs}` (line 16); `RUNNER_OPTIONS` / `FILTER_OPTIONS` sets (lines 24-25); the `protocol` object (line 153).
- **Data flow:** parse args → select `*.docs.eval.ts` files (explicit list or a glob, line 118-123) → `requireEvalAuthFile` → `buildImages()` → **discovery in both images** → `compareDiscovery` → `createTaskPlan` → write `protocol.json` (with `protocolDigest`) and `expected-runs.json` → run each task in its own container → append an observation and **rewrite `observations.jsonl` after every arm** (line 180) → `summarizeEvalObservations` → write `report.json`/`report.txt` → `process.exitCode = 1` if any pair is blocked (line 192).
- **Non-obvious design decisions:**
  - **CLI model selection is all-or-nothing** (lines 71-77): passing `--provider` or `--model` makes both required; otherwise the environment supplies them, and half a pair is an error either way.
  - The two images must resolve to *different* image IDs or the run aborts (lines 132-133) — if `without_docs` and `with_docs` are the same image, the experiment measures nothing.
  - Discovery runs in **both** images and the cohorts must be identical (lines 106-112, 143-148). If a case exists in one arm and not the other, the whole run aborts *before* any model call is paid for.
  - The protocol (model, image IDs, cases, tasks) is hashed with sha256 and the digest is stamped into `report.json` (lines 162-167) and into the report object (report.ts:76) — a report cannot be quoted without naming the cohort it describes.
  - A failed container does **not** abort the cohort: `runTask` returns `undefined` when no `vitest.json` exists and the arm becomes `erroredObservation` (docker.ts:173-174, cli.ts:176-178). A failure blocks its pair; it does not destroy the run.
- **Edge cases / failure handling:** every container path is re-checked to be inside the package (line 93-98) and every discovered path to be inside the container package (line 100-104); unsupported arguments are a hard error (line 66); `runsPerVariant` must be a positive safe integer (line 81).
- **Surprising:** the observations file is rewritten after every single arm (line 180-183) — the run is crash-resumable by hand, and a 40-arm comparison never loses the 39 arms that already finished.

### packages/evals/src/docker.ts
- **Purpose:** Everything that shells out to `docker`.
- **Key abstractions:** `BuiltImages = Record<DocumentationVariant, {name, id}>` (line 12); `DockerContext` (line 14).
- **Data flow:** `buildImages` builds both `--target` variants from the repo root with a path-hashed tag (line 39), then `docker image inspect --format {{.Id}}` to capture the immutable image ID (line 55) → `dockerArgs` assembles the `docker run` line → `discoverCases` runs `--discover` → `runTask` runs one case with an anchored `--testNamePattern`.
- **Non-obvious design decisions:**
  - The image tag is a sha256 of the **repository root path** (line 39), so two checkouts never share a tag and a stale image from another clone cannot be picked up.
  - The image ID (not the tag) is what goes into the protocol (line 158) — a report names the exact bytes that produced it.
  - `docker run` uses `--read-only`, a tmpfs `/tmp`, a tmpfs for the Vite temp dir, and a bind mount only for the artifacts directory (lines 98-107). The host `auth.json` is bind-mounted **read-only** at `/run/pi-eval-secrets/auth.json` (line 121), so the container never sees a writable credential store.
  - The test-name pattern is regex-escaped and **anchored** (`^...$`, lines 163-164) so an arm runs exactly one case and cannot accidentally match a sibling with a similar name.
  - `requireEvalAuthFile` (line 67) validates the host credential file's *shape* — it must exist, parse as JSON, and carry a key for the requested provider — before any container is built.
  - The sandbox UID/GID are passed as 65532 (`nobody`) constants (lines 110-111), while the artifact UID/GID are the host's real uid/gid so the bind mount stays writable (lines 115-120).
- **Edge cases / failure handling:** `requireSuccess` throws with the command and status (line 33); a failed image inspection throws (line 56); `runTask` deliberately tolerates a nonzero container exit and reports "no report" instead (line 172-174).
- **Surprising:** `execute()` runs `docker` with `stdio: "inherit"` for builds (so the build log streams) but `"pipe"` for the one inspection that needs stdout — a two-line function that switches capture mode per call (line 23-31).

### packages/evals/docker/entrypoint.ts
- **Purpose:** The container's PID 1 — every precondition check and the actual Vitest invocation.
- **Key abstractions:** `assertDirectoryEntries(path, expected)` (line 19); `assertRootOnly(path)` (line 73); `assertSandboxCannotRead(path)` (line 80); `chownTree` (line 65).
- **Data flow:** read `PI_EVAL_VARIANT` → `assertWorkspace()` (exact allowlist of `/repo`, `/repo/packages`, `/repo/packages/evals`; coding-agent must expose `package.json` and `dist/index.js`; **every internal dependency must be free of docs/examples/src/test**; the `without_docs` arm must NOT contain README/CHANGELOG/docs/examples, the `with_docs` arm MUST contain four specific non-empty doc files) → assert root-only + unreadable-by-sandbox for the evaluator sources → assert `import.meta.resolve("@earendil-works/pi-coding-agent")` resolves to `/repo/node_modules/.../dist/index.js` (line 102) → copy `auth.json` into `/tmp/pi-eval-host-agent` and chown it to the sandbox UID → rewrite HOME/USERPROFILE/`PI_CODING_AGENT_DIR`/`PI_EVAL_CONTAINER` → spawn Vitest → chown `/artifacts` back to the host uid → exit with Vitest's status.
- **Non-obvious design decisions:**
  - **The confidentiality of the judge is proven, not asserted**: `assertSandboxCannotRead` (line 80) spawns a *child process as the sandbox uid* that tries to read the path, and the entrypoint throws if the read succeeds. Static permission bits are checked separately by `assertRootOnly` (which requires uid 0 **and** mode `& 0o077 === 0`). Two independent checks.
  - The doc-content asymmetry is checked in **both** directions (lines 48-62): the control must be missing its docs and the treatment must have four specific non-empty files.
  - The `with_docs`/`without_docs` difference is enforced symmetrically across *internal dependency packages* too (lines 35-47), so a transitive package's README cannot become an alternate instruction source.
  - The auth file is copied into a per-run temp agent dir and chowned to the sandbox UID (lines 107-111) rather than mounted into the agent's real home.
  - `umask(0o022)` is set explicitly (line 117) because the files the agent creates must be readable by nobody but itself — the default umask of a container root is unpredictable.
  - The artifacts directory is chowned **back** to the host uid after the run (lines 147-151) — a cross-uid handoff, because the host process that will read the report is a different uid than the one that wrote it.
- **Edge cases / failure handling:** `--discover` and `run` share one arg parser, and the `--discover` flag is *filtered out* of the Vitest args (line 123); an eval file list that contains no `*.eval.ts` is refused outright ("The container runner requires an explicit eval file", line 125); every eval file is individually re-checked for root-only + sandbox-unreadable (lines 127-130).
- **Surprising:** `vitest list --json=...` is used for *discovery* (line 133) — the cohort is enumerated by asking Vitest to list tests without running them, which is why the plan can be written and hashed before a single model call is made.

### packages/evals/docker/Dockerfile
- **Purpose:** Builds the two variant images so that the *only* difference is documentation.
- **Key abstractions:** four stages — `builder`, `without-docs-install`, `evaluator`, and the two final targets `without_docs` / `with_docs` (lines 1, 14, 21, 38, 42).
- **Data flow:** `builder` bind-mounts the repo at `/repo`, runs `npm ci --ignore-scripts` + `npm run build:offline` + `install-runtime.mjs /opt/evaluator` — and the comment states the rule: only `/opt/evaluator` persists; `node_modules` and `dist` created in `/repo` are discarded (lines 3-4). `without-docs-install` deletes exactly four paths from the installed coding-agent. `evaluator` copies `/opt/evaluator/root` into `/repo`, `chmod -R go-rwx` on the evaluator sources, keeps `vitest.base.ts` and `vitest.evals.config.ts` group-executable, and locks `/run/pi-eval-secrets` to 0700.
- **Non-obvious design decisions:**
  - **`npm ci --ignore-scripts`** (line 8): no lifecycle script in the dependency tree can execute during the image build.
  - The two final targets differ **only** by the `COPY --from` source of `node_modules` and one `ENV PI_EVAL_VARIANT` (lines 38-44) — the treatment target reuses the *builder's* install, the control uses the *stripped* install. The variant identity is therefore a property of the bytes, not of a runtime flag.
  - The evaluator sources are root-only so that "model tools and generated code cannot inspect judges or fixtures" (lines 26-27) — the comment states the reason, not just the action.
- **Edge cases / failure handling:** the build context excludes `.git`, `node_modules`, `dist`, `coverage` and `.env*` (see `Dockerfile.dockerignore`), so no secret or stale artifact enters the build.
- **Surprising:** the image is `node:24-slim` and the whole evaluation runs on Node's **native TypeScript stripping** (`node --experimental-strip-types`), with Vitest only as the test runner — the eval code ships as source, not as a build artifact.

### packages/evals/docker/install-runtime.mjs
- **Purpose:** Builds the runtime tree that the image stages — the "what does the agent actually see" decision, made at build time.
- **Key abstractions:** `produceArtifactSet` (from `scripts/package-artifacts.mjs`) and `installConsumer` (from `scripts/local-package-install.mjs`) — the repository's own consumer-install machinery, reused rather than reimplemented.
- **Data flow:** produce the workspace artifact set (no build, `source: null` because Docker contexts may omit git metadata — line 21) → `installConsumer` installs the coding-agent tarball into `/opt/evaluator/install` → `npm install --ignore-scripts --omit=dev` the evaluator's *own* dev dependencies that are not workspace artifacts (lines 27-39) → strip docs/examples/src/test from every internal workspace package (lines 41-53) → copy the runtime tree (`package.json`, `vitest.base.ts`, `packages/evals/{package.json,vitest.evals.config.ts,src,evals,docker/entrypoint.ts}`) into `/opt/evaluator/root` (lines 55-70).
- **Non-obvious design decisions:**
  - The evaluator's dev dependencies (`vitest`, `vitest-evals`, `autoevals`) are installed **separately from the artifacts**, so the runtime the agent sees is the consumer's runtime, and the harness's own tooling is a distinct layer (lines 23-39).
  - The documentation-stripping rule for internal packages is duplicated verbatim from `entrypoint.ts` — the same predicate (`docs|examples|src|test|tests` directories, `readme|changelog` files) at build time (line 47) and again as a runtime assertion (entrypoint.ts:41). Belt and braces on the same invariant, from two languages of enforcement.
  - The staged tree is a *curated copy* — only the listed files are copied (lines 57-70), so nothing else in the repo can accidentally become agent-visible.
- **Edge cases / failure handling:** `npm install` runs with `--ignore-scripts --omit=dev --no-audit --no-fund --no-save` (lines 29-36) — no install scripts, no lockfile churn, no audit network call.
- **Surprising:** `source: null` is passed to `produceArtifactSet` because the artifact set is consumed only inside the image build and the build context has no git metadata — a deliberate refusal to depend on VCS state inside Docker.

### packages/evals/evals/acme-server.ts
- **Purpose:** A real HTTP server used as a fake provider, so provider-adapter behaviour can be asserted on the wire rather than mocked at the client.
- **Key abstractions:** `AcmeServer {start, stop, reset, origin, baseUrl, validRequestReceived}` (line 51); two modes — `"openai"` (SSE at `/v1/chat/completions`) and `"stream"` (custom `application/x-ndjson` at `/generate`).
- **Data flow:** the request handler (line 65) checks path → method → content-type → JSON body → finds the first `user` message → checks the credential header (`Bearer resolved-acme-key` vs `x-acme-key: resolved-stream-key`) → checks model id, prompt presence and `stream === true` → writes the wire frames → sets `receivedValidRequest = prompt === <probe prompt>`.
- **Non-obvious design decisions:**
  - The server distinguishes **401** (bad credential) from **422** (wrong model / missing prompt / `stream` not true) from **404/405/415** — so a test can say *which* part of the adapter is wrong, not just "it failed" (lines 66-106).
  - `receivedValidRequest` is set only when the prompt equals the exact probe prompt (lines 92, 107). A 200 response to the *wrong* prompt is explicitly **not** a valid probe — the fixture cannot be satisfied by a coincidentally-correct request.
  - The NDJSON mode's wire format is invented (`text_delta` / `usage` / `done`) precisely so it is *not* an OpenAI clone — it forces the agent to read the API documentation rather than pattern-match a known provider.
- **Edge cases / failure handling:** non-JSON body → 400 (line 76); a JSON array instead of an object → 422 (line 78); the server binds port 0 and reads the assigned port back (lines 136-140).
- **Surprising:** `STREAM_API_DOCUMENTATION` (line 12) is the *documentation the agent is given*, generated from the same constants the server enforces — the fixture and its doc are one source of truth, so the doc cannot drift from the server.

### packages/evals/evals/configured-runtime.ts
- **Purpose:** The oracle that reads Pi's model configuration back *after* the agent changed it — the "did the edit actually take effect" probe.
- **Key abstractions:** `ProviderRuntimeOutput` / `AddedModelOutput` — both are `{result: {...}} | {error: string}` unions (lines 16-28); `ProviderScenario` (line 30); `ModelFields` (line 5) — a hand-picked projection of a `Model`.
- **Data flow:** `loadConfiguredModelRuntime(agentDir)` builds a `ModelRuntime` over `models.json` / `auth.json` / `models-store.json` with `allowModelNetwork: false` (line 61) → `inspectProvider` refreshes with network disabled, reads `runtime.getError()`, `getModel(provider, id)`, then `runtime.completeSimple(model, context, options)` and reports the model's fields plus the response (lines 65-93) → `inspectAddedModel` additionally builds a **pristine** runtime (`modelsPath: null`, line 100) to snapshot the built-in model list, then checks every one of those ids still resolves after the agent's edit (line 117).
- **Non-obvious design decisions:**
  - `allowModelNetwork: false` everywhere — the oracle must not be able to "pass" by reaching the internet for a model list; the provider list must come from the local config.
  - The "did I destroy the existing models?" check is done by comparing against a *separate pristine runtime* rather than a hardcoded list (lines 100-103, 117) — the expected baseline is the shipped default, not a snapshot that can rot.
  - Errors are returned as **data** (`{result:{error}}`), never thrown (lines 70-71, 90-92) — the judge compares a structured payload, so a broken configuration is a score of 0 with a reason, not an infrastructure crash.
  - `modelFields` (line 38) projects exactly the fields the judges assert — a deliberate narrowing so a new upstream `Model` field cannot silently change an eval's expected value.
- **Edge cases / failure handling:** a missing model after reload → structured error naming provider/id (line 74); a parse failure in `models.json` surfaces as an error string containing "Failed to parse models.json" (pinned by configured-runtime.test.ts:112-124).
- **Surprising:** `inspectAddedModel` is the only place in the shard that asserts a *non*-regression (the pre-existing models survived) — every other check asserts that something new appeared. The failure mode it guards is an edit that works but destroys state.

### packages/evals/evals/tui.docs.eval.ts
- **Purpose:** The hardest case in the shard — a paired experiment on a TUI theme change, graded by a frame-level rendering oracle instead of an LLM judge.
- **Key abstractions:** `RecordingTerminal` (line 24) — a fake terminal that records writes; `CONTEXT_FIXTURES` (line 18) — three `(percent, expectedBar)` pairs including an over-100% case that must clamp; `TuiFooterOutput` (line 78); a custom `createJudge` named `ContextFooterJudge` (line 192).
- **Data flow:** the harness's `output` callback (line 188) → `inspectContextFooter` (line 113) builds an **oracle session** with a model whose `contextWindow` is pinned to 272 000, an in-memory `SessionManager`, `noTools:"all"` and `thinkingLevel:"high"` → drives `InteractiveMode` against the `RecordingTerminal` → injects a synthetic assistant message with a chosen `usage` (lines 142-151) → for each fixture, replaces `session.agent.state.messages` and captures the renders (first via `mode.init()`, later via `terminal.requestResize()`) → the judge checks each captured frame.
- **Non-obvious design decisions:**
  - **Render frames are extracted from the terminal's synchronized-output markers** `\x1b[?2026h` … `\x1b[?2026l` (lines 62-73) — the test reads the terminal's own frame boundaries rather than guessing at redraws, and an unterminated frame is a hard error ("TUI emitted an incomplete synchronized render", line 71).
  - The oracle is a *separate session* from the agent session (lines 125-133), so the measured render cannot be perturbed by the conversation the eval just had.
  - `PI_OFFLINE=1` is set around the measurement (line 140) so a background refresh cannot race the capture.
  - The judge asserts **both** presence and absence: the expected bar must be present, the built-in numeric pattern must be *gone*, and none of the *other* fixtures' bars may appear (lines 221-227) — a rendering that accidentally shows 65% while asked for 42% fails.
  - `retained` is the **minimum** Levenshtein similarity across the fixtures, and is forced to 0 if not every fixture produced a score (line 236) — partial data reads as total failure, not as a partial pass.
  - The status line is normalized (trim + whitespace collapse) before comparison, because the model's theme may change spacing but not content.
- **Edge cases / failure handling:** `finally` chains `mode.stop("resume-hint")` → `runtime.dispose()` → restore `PI_OFFLINE`, each nested so one failure cannot skip the next (lines 174-185); a missing active model throws (line 115); a fixture whose `contextUsage` does not match the injected percentage invalidates the whole case (lines 207-212).
- **Surprising:** the eval asks the model to change a footer and then *reloads* (`{type:"reload"}`, line 260) — the task is judged on the theme the agent actually persisted and reloaded, not on the code it wrote.

### packages/evals/evals/documentation-audit.eval.ts
- **Purpose:** A documentation-drift CI. One test case per markdown page under `packages/coding-agent/docs`, generated by globbing the repo at module load.
- **Key abstractions:** `submit_documentation_audit`, a `defineTool` whose schema is a `Type.Union` of three verdicts plus a bounded explanation (lines 10-30); `constrainedSampling: {type:"json_schema", strict:"prefer"}` (line 22).
- **Data flow:** `globSync("**/*.md", {cwd: docsRoot})` → `it.for(pages)` (line 44) → the prompt names the doc page and the repo root, states the evidence rule, and demands the tool be called exactly once as the final action → the test asserts exactly one tool call, `status === "ok"`, and `verdict === "match"` (lines 59-64).
- **Non-obvious design decisions:**
  - The prompt defines a **narrow mismatch criterion** ("a clear, user-visible contradiction between an explicit documentation claim and actual runtime behaviour") and explicitly disqualifies names, comments, types, isolated helpers and tests as evidence (line 51) — the eval would otherwise flag style differences, not doc bugs.
  - It also names what is *not* a mismatch: missing internal detail, ambiguous wording, hypothetical misuse, undocumented edge cases (line 53), and instructs the model to answer `inconclusive` when the evidence is not decisive. **The tool schema has three verdicts because "I could not tell" must be a first-class, gradeable answer.**
  - The tool returns `terminate: true` (line 28) — the run ends on the verdict, so there is no trailing prose to grade.
  - The assertion is `verdict === "match"` — a genuine doc bug makes this suite **fail**, which is the point: it is a drift detector, not a capability measurement.
- **Edge cases / failure handling:** the tool-call count is asserted to be exactly 1 (line 60), so a model that hedges by calling it twice fails; the explanation is echoed as the assertion message so the CI log carries the reasoning (line 64).
- **Surprising:** this is the only eval in the shard with no `judge` and no `judgeThreshold` — the grading is a plain Vitest assertion against a structured tool call, because the task's verdict is a *fact about the repo*, not a quality judgement.

### packages/evals/evals/extensions.docs.eval.ts
- **Purpose:** Paired case proving the agent can install an extension, that a `reload` picks it up, and that the tool then works.
- **Key abstractions:** the harness `output` callback returns `{response, extensionErrors, toolLoaded, toolResult}` (lines 11-21) — a structured projection read from `session.resourceLoader.getExtensions()` and the message list.
- **Data flow:** prompt ("configure this installation with an extension containing a `hello` tool…") → `{type:"reload"}` → prompt ("use the hello tool to greet Bob") → the output callback reads the extension registry and finds the last non-error `toolResult` for `hello` (lines 13-16) → two judges.
- **Non-obvious design decisions:**
  - The scenario is split into **three steps** (prompt / reload / prompt) so the second prompt can only succeed if the reload actually re-read the extension — the extension's *effect* is measured, not its file.
  - `toolLoaded` is checked from the extension registry (`extensions.extensions.some(({tools}) => tools.has(TOOL_NAME))`) *and* `toolResult` from the transcript — two independent confirmations that the tool existed and ran.
  - `!message.isError` is part of the tool-result lookup (line 15) — a failed tool call cannot masquerade as a success.
  - Two judges of different kinds are combined: `StructuredOutputJudge` on the whole payload plus `ToolCallJudge` on the exact tool name and arguments (line 40).
- **Edge cases / failure handling:** `extensionErrors` must be empty (line 33) — an extension that failed to load is an explicit failure, not an absent field.
- **Surprising:** the tool the eval asks for is named `hello` and the expected result is the literal string `"Hello, Bob!"` — the case is trivially simple on purpose, so a failure means the extension mechanism is broken, not that the model is weak.

### packages/evals/evals/custom-provider.docs.eval.ts
- **Purpose:** Paired case: configure a *custom* (non-OpenAI) streaming provider from an API documentation file, then reload.
- **Key abstractions:** `STREAM_API_DOCUMENTATION` — the doc the agent is given, written into the workspace as `fixtures/acme-stream-api.json` (line 46); a strict `StructuredOutputJudge` over the full `ProviderRuntimeOutput` (line 58).
- **Data flow:** the server starts in `beforeAll` and its URL is interpolated into the prompt (line 65) → the agent writes a provider config and reloads → the output callback calls `inspectProvider(session.modelRuntime, …)` with `options.env` supplying the credential → the judge compares the whole payload strictly.
- **Non-obvious design decisions:**
  - The credential is delivered through the *model request's* `options.env` (line 54) — the agent must read it from `ACME_STREAM_API_KEY`, which the harness sets in `beforeAll` (line 19) and deletes in `afterAll` (line 24).
  - The provider's expected fields (context window 16 384, max tokens 2 048, reasoning false, zero cost) are given **in the prompt in prose** (line 67) and then checked exactly by the judge — the agent must transcribe structured config from natural language.
  - `match:"strict", allowExtras:false` (line 58) — an extra field in the provider config is a failure.
- **Edge cases / failure handling:** `server.reset()` in `beforeEach` clears the probe flag so a previous case cannot satisfy this one (line 22).
- **Surprising:** the two provider evals (this one and `openai-provider.docs.eval.ts`) are the shard's only cases where the *answer* is judged by a real request reaching a real socket — everything else is graded on internal state.

### packages/evals/evals/openai-provider.docs.eval.ts
- **Purpose:** The OpenAI-compatible counterpart of the custom-provider case.
- **Key abstractions:** the same `ProviderRuntimeOutput` shape; the base URL is `server.baseUrl()` = `<origin>/v1` (acme-server.ts:151).
- **Data flow:** the agent is told the provider id, the base URL and that it uses OpenAI Chat Completions → it configures the provider, reloads, and the oracle completes a real streamed request against the fixture.
- **Non-obvious design decisions:**
  - The fixture rejects anything that is not `stream: true` (acme-server.ts:104) — the adapter's streaming path is what is under test, not just its configuration.
  - The judge asserts the token counts the *server* reported (3 in / 2 out, line 32), so the numbers must have come back through the provider adapter, not from a config file.
- **Edge cases / failure handling:** identical to the custom-provider case — reset per test, server stopped after all.
- **Surprising:** the fixture speaks to `/v1/chat/completions` and *requires* the bearer header to be exactly `Bearer resolved-acme-key` — so a credential-resolution bug (e.g. reading the raw env var including a prefix) is caught as a 401, not as a vague failure.

### packages/evals/evals/models.docs.eval.ts
- **Purpose:** Paired case: add one model to an existing provider without disturbing the provider's existing models.
- **Key abstractions:** the same `AddedModelOutput` oracle; `PROVIDER_ID = "openai"` — a *built-in* provider, deliberately (line 5).
- **Data flow:** prompt → reload → `inspectAddedModel(session.modelRuntime, "openai", "fixture-chat")` → the oracle compares against a pristine runtime's built-in model list (configured-runtime.ts:100-103).
- **Non-obvious design decisions:**
  - The target provider is a **built-in** one, so the case exercises the merge path (built-in defaults + user model) rather than a pure user-defined provider.
  - `existingModelsPreserved` (line 21) is a first-class asserted field, not a side effect.
- **Edge cases / failure handling:** if the pristine runtime has no models for that provider, the oracle errors rather than comparing against an empty list (configured-runtime.ts:104-106).
- **Surprising:** the case asserts the *opposite* of what the prompt asked for as well — the model must be added **and** nothing else may change.

### packages/evals/evals/smoke.eval.ts
- **Purpose:** The smallest possible end-to-end check: one prompt, no tools, exact answer.
- **Key abstractions:** `createPiCodingAgentHarness({noTools:"all"})` (line 5) — the tool surface is removed entirely.
- **Data flow:** one prompt → the harness runs a full session → four assertions.
- **Non-obvious design decisions:** `expect(result.errors).toEqual([])` (line 11) — a harness error is a test failure even when the answer is right; the usage assertion compares provider/model against `process.env` (lines 12-15), so the test detects a model substitution; `totalTokens > 0` (line 16) catches a stubbed provider.
- **Edge cases / failure handling:** the answer is compared after `.trim()` (line 10) — trailing whitespace is tolerated, nothing else is.
- **Surprising:** this is the only eval in the shard with no judge — it is a plumbing check, and it is deliberately the cheapest possible one.

### packages/evals/README.md
- **Purpose:** The shard's specification, and the clearest statement of its philosophy.
- **Key abstractions:** the file conventions (`*.docs.eval.ts` = paired lift, others = host suites) and the runner's five modules (`cli` / `docker` / `plan` / `report` / `harness`).
- **Data flow:** documents the six-step runner pipeline (lines 71-80), the two documentation variants (lines 82-88), the artifact layout (lines 92-103) and the pairing rule (line 103).
- **Non-obvious design decisions:**
  - **"A pair contributes to pass-rate lift only when both arms produce exactly one score. Missing, duplicate, skipped, pending, unscored, or errored arms block the pair. If any pair in an eval set is blocked, headline pass rates are withheld."** (line 103) — the rule is stated in prose before any code implements it.
  - **"One repetition cannot establish stability."** (line 105) — the report's flakiness flag is a consequence of a stated stance, not a feature.
  - **"Use `judgeThreshold: null` for comparative scoring. A low score is data, not an infrastructure failure. Reserve Vitest assertions for broken suite invariants."** (line 129) — the separation of *scoring* from *hygiene*.
  - **"The outer runner owns variants, repetitions, isolation, identity, persistence, and reporting. Eval files should contain only scenario setup, the model task, and deterministic grading."** (line 127) — a hard ownership boundary.
  - The container's isolation properties are documented as a promise, not a hope: evaluator sources root-only and unreadable after the drop, a new home/agent-dir/workspace/session-dir per run (line 88), and an explicit statement that Docker alone **cannot** prove that agent-written code never uses the network (line 90) — the limit of the isolation is written down.
- **Edge cases / failure handling:** documents that artifacts may contain prompts, responses, generated code and tool output (line 107) — a data-handling warning.
- **Surprising:** line 88 states that "documentation and source files from internal dependency packages are removed symmetrically so they cannot act as alternate instructions" — the experiment's treatment is defined not just by *adding* documentation but by *removing every other possible documentation source*, so the measured delta is attributable.

### packages/evals/test/report.test.ts
- **Purpose:** The unit tests that pin the observation-reading contract — the shard's most safety-critical logic.
- **Key abstractions:** `writeTaskReport` synthesizes a complete native Vitest JSON (lines 29-64); `scoredMeta` synthesizes the `vitest-evals` harness payload (lines 66-98).
- **Data flow:** build a synthetic report → `readTaskObservation(task, reportPath, directory)` → assert the outcome and the persisted `session.jsonl`.
- **Non-obvious design decisions:**
  - Every branch of the outcome classifier has its own test: skipped/pending survive a missing harness run (lines 116-124); a **failed** eval still yields its metrics plus `outcome:"errored"` (lines 126-151); a **passed** eval with no harness run is errored (lines 153-156).
  - **A zero score is still a score** (lines 184-187) and a `null` score is `unscored` (lines 189-192) — the two are not collapsed.
  - A **model mismatch** is errored (lines 194-197) — the arm ran, but not on the model the plan named.
  - A missing session artifact does **not** fail the case (lines 204-207): the score stands.
- **Edge cases / failure handling:** the session artifact is written to a content-hashed directory and read back to prove it landed (lines 147-150, 177-181); temp dirs are cleaned in `afterEach` (lines 9-11).
- **Surprising:** the test file reconstructs the *entire* external Vitest JSON shape by hand — the runner's correctness is pinned against a synthetic replica of a third-party format, which means a change in that format breaks these tests loudly instead of silently.

### packages/evals/test/comparison.test.ts
- **Purpose:** Unit tests for the pairing and lift maths.
- **Key abstractions:** `scored(variant, runNumber, score, metrics)` and `errored(...)` builders (lines 10-47); `expectedFor(runNumbers)` reconstructs the plan (line 49).
- **Data flow:** synthesize observations + the matching plan → `summarizeEvalObservations` → assert the report.
- **Non-obvious design decisions:**
  - The "fails closed" test (lines 85-100) asserts both halves at once: the lift is `null` and the blocked pairs carry their *reasons*, **while the operational totals still include the failed arm's tokens** (line 99).
  - The duplicate test (lines 102-113) pins the exact reason string `"without_docs: expected 1 observation, found 2"` — the reason text is part of the contract, because it is what a human reads.
  - A missing metric is asserted to stay `total: null` with `availableRuns: 0`, while a genuine zero is `total: 0` with `availableRuns: 1` (lines 111-112) — the exact distinction August cares about.
- **Edge cases / failure handling:** `stripVTControlCharacters` is applied to the formatted report before the substring assertions (line 120) because the header is bold-styled.
- **Surprising:** the lift assertion is exact (`0.5`), not approximate — the comparison is integer-ratio arithmetic, so there is no tolerance to argue about.

### packages/evals/test/harness.test.ts
- **Purpose:** Unit tests for the harness's pure helpers and for the prompt surgery.
- **Key abstractions:** the real `buildSystemPrompt` from `packages/coding-agent/src/core/system-prompt.ts` is imported (line 4) — the test builds the **actual** default prompt rather than a fixture.
- **Data flow:** `buildSystemPrompt({cwd, selectedTools: DOCUMENTATION_EVAL_TOOLS})` → `excludePiDocumentation(prompt)` → assertions on both the stripped and unstripped prompt.
- **Non-obvious design decisions:**
  - The stripping test asserts **both directions**: the `<docs>` section and the doc paths are gone, and `<rules>` and `<cwd>` are still present (lines 82-91) — a strip that removed too much would fail.
  - It asserts the *absence of the doc paths themselves* (`getReadmePath()`, `getDocsPath()`, `getExamplesPath()` — lines 88-90), not merely the absence of the section.
  - "Fails closed when prompt markers are missing" (lines 106-111): a prompt with no `<docs>` section, or with a `<docs>` section but no `<cwd>` after it, both throw.
  - The documentation harness refuses to be constructed outside the container sandbox (lines 113-115) — the guard is tested, not assumed.
  - The environment-isolation test uses `vi.stubEnv` and asserts both the isolation *and* the restoration (lines 41-60).
- **Edge cases / failure handling:** half-specified model environments are rejected by `it.each` over three incomplete shapes (lines 32-37).
- **Surprising:** importing the real prompt builder from the *sibling* package means this test breaks when the prompt's section format changes — which is exactly the coupling you want for a "the docs section must exist" assertion.

### packages/evals/test/plan.test.ts
- **Purpose:** Two small unit suites for the discovery parser and the task planner.
- **Key abstractions:** the `discovered` fixture (line 4) is the exact shape Vitest's `list --json` produces.
- **Data flow:** `parseDiscoveredCases` → `createTaskPlan` → assertions on the shape.
- **Non-obvious design decisions:** the ambiguous-name rejection (line 19) and the duplicate-identity rejection (line 20) are pinned by their **error message**, so the diagnostic text is part of the contract; the plan test asserts the exact variant/run interleaving `[without,with],[with,without]` (lines 29-34), which pins the order-bias alternation.
- **Edge cases / failure handling:** an invalid model identity and a zero repetition count are both rejected (lines 37-41).
- **Surprising:** the whole file is 42 lines and covers the two invariants that would silently corrupt every downstream number — a good ratio for a shard whose value is in its arithmetic.

### packages/evals/test/acme-server.test.ts
- **Purpose:** Contract tests for the fixture provider, run identically against both wire modes.
- **Key abstractions:** a `Fixture[]` table with per-mode url/headers/model/prompt/response/content-type (lines 26-51); `streamedText` parses either SSE or NDJSON back into text (lines 65-81).
- **Data flow:** start the server → POST the probe → assert status, content type, streamed text and the recorded probe flag.
- **Non-obvious design decisions:** the same five tests run against both modes via `describe.each` (line 83) — the OpenAI-compatible and the custom-streaming provider must satisfy the *same* contract, which is what makes the fixture reusable as a provider oracle. "Does not treat a non-probe success as the probe" (lines 116-120) is the anti-coincidence test.
- **Edge cases / failure handling:** a 401 and a 422 both leave `validRequestReceived()` false (lines 106, 113), so a rejected request can never be mistaken for a success.
- **Surprising:** the fixture server is tested *more thoroughly than most of the agent code* — five assertions per mode, including that a successful-but-wrong request is not accepted.

### packages/evals/test/configured-runtime.test.ts
- **Purpose:** Unit tests for the configuration oracle against a real `ModelRuntime`.
- **Key abstractions:** `acmeModelsJson()` builds a `models.json` with an `apiKey: "$ACME_API_KEY"` indirection (lines 46-67) — the credential is a **variable reference**, not a literal.
- **Data flow:** write `models.json` into a temp agent dir → `loadConfiguredModelRuntime` → `inspectProvider`/`inspectAddedModel` → assert the structured payload.
- **Edge cases / failure handling:** a missing model → structured error (lines 104-110); an unparseable `models.json` → an error containing "Failed to parse models.json" (lines 112-124, 186-195); an **unauthorized** completion returns `stopReason:"error"` and is not a valid probe (lines 126-135).
- **Edge cases / failure handling:** `existingModelsPreserved` is asserted true against a real built-in provider (lines 152-175).
- **Surprising:** the credential indirection `"$ACME_API_KEY"` in `models.json` mirrors August's provider-secret-reference mechanism — the fixture proves the *variable expansion* path, not just a literal key.

### packages/evals/package.json
- One-line: private ESM package `@earendil-works/pi-evals` 1.4.0 whose four scripts separate *host evals* (`vitest --project host`), *doc evals* (`node --experimental-strip-types src/cli.ts`) and the runner's *own unit tests* (`vitest.test.config.ts`) into three independently runnable commands.

### packages/evals/vitest.evals.config.ts
- One-line: defines two Vitest projects in one config — `docs` (`evals/**/*.docs.eval.ts`) and `host` (all `*.eval.ts` minus the docs ones) — both strictly sequential with a 300 s timeout, plus a local-only alias that points `@earendil-works/pi-coding-agent` at the workspace source instead of the built package.

### packages/evals/vitest.test.config.ts
- One-line: a *separate* config whose only job is `test/**/*.test.ts`, keeping the runner's unit tests out of the eval projects so a broken eval cannot fail the runner's own tests (and vice versa).

### packages/evals/tsconfig.json
- One-line: `noEmit` + NodeNext resolution + `node`/`vitest` types, including `src`, `evals`, `docker`, `test` and the root-level `*.config.ts` — the package is type-checked but never emitted (the container runs the TypeScript directly).

### packages/evals/.gitignore
- One-line: a single entry, `.eval/` — every artifact directory the runner creates is ignored, so a comparison run never dirties the working tree.

### packages/evals/docker/Dockerfile.dockerignore
- One-line: seven build-context exclusions (`.git`, `**/.eval`, `**/node_modules`, `**/dist`, `**/coverage`, `**/.env`, `**/.env.*`) — the secret patterns are the point.

## Ideas worth stealing

- **Withhold the headline when a pair is broken, instead of averaging over survivors** — `packages/evals/src/report.ts:249` (`resolvePair`) with `packages/evals/src/report.ts:379` (`publishHeadline = blockedPairCount === 0 && pairs.length > 0`) and `packages/evals/src/cli.ts:192` (`process.exitCode = 1`). *Why it transfers:* August's harness reports numbers about model behaviour; if an arm errors and the report keeps the surviving arms, the pass rate is computed on a biased denominator and nobody can tell. Pi's rule — a pair counts only when *both* arms produced exactly one score; any other state blocks the pair, the whole eval set's headline becomes `null`, the reason string is printed, and the process exits nonzero — turns "we lost some data" into "we refuse to publish a number". This is the same discipline August already applies to `turn_outcomes` (NULL means unrecorded, not zero), applied to *reporting*.

- **Take the denominator from the written plan, not from what came back** — `packages/evals/src/report.ts:230` (groups are seeded from `expectedRuns` and each observation is counted against the plan) with `packages/evals/src/cli.ts:168` (`expected-runs.json` written before execution). *Why it transfers:* August has no equivalent ledger for "the cohort I intended to run". If an arm vanishes, the cohort must shrink visibly (`eligiblePairs` vs `totalPairs` vs `blockedPairs` are three separate numbers in `packages/evals/src/report.ts:43-56`), not silently. The plan file is the audit trail: a report plus a plan is reproducible; a report plus a memory is not.

- **Missing is not zero — in metrics, in counts, and in text** — `packages/evals/src/report.ts:306-318` (`operationalTotal` returns `{availableRuns, total}` with `total: null` when nothing was measured) rendered as "unavailable (0/2 measured)" at `packages/evals/src/report.ts:431`, and `packages/evals/src/report.ts:85-91` (`optionalMetric` rejects negative/NaN/Infinity, turning a malformed metric into an *errored arm* rather than a dropped one). *Why it transfers:* this is exactly August's "0.0 is a price, not an absence" rule, applied to a table instead of a scalar. Note the deliberate asymmetry with August's rule at `packages/evals/src/harness.ts:392` — a model whose price is all zeros is reported with **no** `estimatedCostUsd` field at all, so "free" and "free but unknown" collapse into absence. August should decide deliberately which way each metric goes; the transferable part is that the *absence* is displayed, never rendered as a 0.

- **Prove the experiment's premises before spending a token on it** — four independent gates: the two variant images must have different IDs (`packages/evals/src/cli.ts:132`), both images must discover an identical case cohort (`packages/evals/src/cli.ts:106` + `packages/evals/src/cli.ts:148`), the prompt that was actually sent must match the arm (`packages/evals/src/harness.ts:257` `verifySystemPrompt`, called at `packages/evals/src/harness.ts:413`), and the container's contents must match an allowlist (`packages/evals/docker/entrypoint.ts:19` and `:27`). *Why it transfers:* August runs A/B experiments on prompt sections, tool surfaces and memory injection. Each of these is a way to *accidentally measure nothing* (both arms identical, cohorts differ, the section was never removed). The gate is cheap: assert the thing you intended to vary actually varies, and fail the run if it does not. Pi's implementation is the model to copy — cheap string/shape assertions, each with its own named error.

- **Refuse to run the evaluation harness outside its isolation boundary** — `packages/evals/src/harness.ts:526` throws "Documentation evals must run in the isolated container sandbox" unless `PI_EVAL_CONTAINER === "1"` **and** a sandbox identity exists, and the test at `packages/evals/test/harness.test.ts:113` pins it. *Why it transfers:* an eval that silently degrades its isolation when a flag is missing produces a number that looks like a number. The guard is a constructor-time throw, not a warning.

- **Hide the credential from the process, not just from the file** — `packages/evals/src/harness.ts:328-335`: with a sandbox identity the host `auth.json` is deleted (`rm`) and the API-key environment variable is removed from `process.env` before the privilege drop; both are restored afterwards (`packages/evals/src/harness.ts:443-445`). *Why it transfers:* August spends a real key on every turn and scrubs it *outbound*; the complementary leak is the agent reading the key out of its own environment. Removing the variable from `process.env` (not just masking it in the tool) closes the door on any tool the agent writes.

- **Verify a privilege drop instead of assuming it, and protect the transformed-module cache** — `packages/evals/src/harness.ts:154-188` (`enterToolSandbox`: chown the tree, `setgroups([])`, `setgid`, `setuid`, then re-read every protected path and throw if one is still readable) and `packages/evals/src/harness.ts:130-152` (`protectTransformedModules`: chmod the Node type-stripping cache so the *judge's source* cannot be read after the drop). The container does the same check from the other side at `packages/evals/docker/entrypoint.ts:80-88` by **spawning a child as the sandbox uid** and failing if the read succeeds. *Why it transfers:* any harness that runs model-written code in-process needs this. The subtlety worth stealing is the cache: the secret is not only in your source file, it is in the *transformed copy* Node leaves in `tmpdir` — a protection pass that only chmods the source has already lost.

- **Assert that the model that answered is the model the plan asked for** — `packages/evals/src/report.ts:161`: `actualModel !== task.model` ⇒ the arm is `errored`, not `scored`; pinned by `packages/evals/test/report.test.ts:194`. *Why it transfers:* a provider fallback (or a config that silently resolves to a different model) would otherwise be scored as if it were the intended model — and the eval would "pass" against a model nobody was testing. One comparison in the observation reader catches the whole class.

- **Keep the metrics of a failed arm, and report them as part of the failure** — `packages/evals/src/harness.ts:456-466` (a failed run re-attaches its partial diagnostics to the thrown error) → `packages/evals/src/report.ts:178-180` (an arm with harness errors is `errored` *but keeps its metrics*) → `packages/evals/src/report.ts:411` (the operational totals are computed over **all** observations, failed ones included). *Why it transfers:* the cost of a failure is exactly the number people omit when they report "the model failed". Pi reports failed runs' tokens, tool calls, latency and cost in the same table as successful ones, and the coverage annotation ("2/3 measured") tells the reader how much of the table is real.

- **Detect flakiness by collecting the set of pass-bits per case across repetitions** — `packages/evals/src/report.ts:344-355`: for each `(case, variant)`, accumulate the distinct pass/fail bits seen across repetitions; any set with more than one element flags the eval set as `flaky`. Combined with the stance at `packages/evals/README.md:105` ("One repetition cannot establish stability") and the alternation at `packages/evals/src/plan.ts:53` (the variant order flips on odd/even run numbers to cancel order bias). *Why it transfers:* this is the cheapest possible answer to "is this result real", and it is a pure function over data August already persists (per-round outcomes). The alternation is two lines.

- **Stamp the report with a digest of the plan that produced it** — `packages/evals/src/cli.ts:162-167` (sha256 over the whole protocol: model, image IDs, cases, tasks) carried into the report object at `packages/evals/src/report.ts:76`. *Why it transfers:* an eval number that cannot name its cohort is a rumour. One hash makes "which image, which model, which cases, which repetitions" part of the artifact, and makes it impossible to compare two reports that were not the same experiment.

- **A low score is data, not an infrastructure failure — and the boundary is written down** — `packages/evals/README.md:129` ("Use `judgeThreshold: null` for comparative scoring. A low score is data, not an infrastructure failure. Reserve Vitest assertions for broken suite invariants."), applied consistently: every paired case uses `judgeThreshold: null` (`packages/evals/evals/extensions.docs.eval.ts:42`, `packages/evals/evals/models.docs.eval.ts:28`, `packages/evals/evals/openai-provider.docs.eval.ts:48`), while plain Vitest assertions are reserved for invariant violations (`packages/evals/evals/smoke.eval.ts:11`, `packages/evals/evals/documentation-audit.eval.ts:59-64`). *Why it transfers:* August's harness has no verifier gate today, so every "the model did badly" signal risks being mixed with "the harness broke". Pi draws the line explicitly and it is a cheap one to adopt: a judge score is data; an assertion is an invariant.

- **Give the eval file a hard ownership boundary** — `packages/evals/README.md:127` ("The outer runner owns variants, repetitions, isolation, identity, persistence, and reporting. Eval files should contain only scenario setup, the model task, and deterministic grading."). *Why it transfers:* the moment an eval file can choose its own model, its own isolation or its own repetitions, the comparison is no longer reproducible and the report's pairing invariants can be bypassed. August's eval suites (when they exist) should be able to be read as pure scenario + task + grade.

- **Measure a prompt-section effect by deleting exactly that section, and fail closed if it is not there** — `packages/evals/src/harness.ts:494-506` (`excludePiDocumentation` slices the section between `\n<docs>\n` and `\n</docs>`, and throws "Default Pi system prompt has no Pi documentation section" if either marker is missing) with the assertions in `packages/evals/test/harness.test.ts:82-91` proving the removal is *exactly* the docs section (rules and cwd survive, doc paths gone) and `packages/evals/test/harness.test.ts:106-111` pinning the fail-closed behaviour. The prompt itself is a set of named `<name>…</name>` sections (confirmed at `packages/coding-agent/src/core/system-prompt.ts:188-191`). *Why it transfers:* this is the cleanest possible measurement of "does this prompt section help" — remove one section, compare, and assert the section existed and that nothing else changed. August's system prompt is assembled from parts in several places; making those parts *named, addressable sections* is a precondition for this measurement.

- **Prefer a deterministic oracle over an LLM judge whenever the truth is a fact** — three examples: the TUI eval asserts exact progress-bar glyphs and the *absence* of the built-in numeric pattern (`packages/evals/evals/tui.docs.eval.ts:207-227`); the provider evals assert the exact HTTP status (401 vs 422 vs 200) and the exact streamed text of a real fixture server (`packages/evals/evals/acme-server.ts:86-106`); the model evals assert the exact configured field set and that the *previous* models survived (`packages/evals/evals/configured-runtime.ts:100-117`). *Why it transfers:* August's evaluations of its own harness should assert on what the system *did* (the request that went out, the config that persisted, the tokens that were spent), not on what a judge said about it. The fixture-server pattern — a real socket speaking the real wire format, with a 401/422 distinction — is directly reusable for August's provider abstraction.

- **Grade "I could not tell" as a first-class verdict** — `packages/evals/evals/documentation-audit.eval.ts:15-21`: the tool's schema is `match | mismatch | inconclusive`, the prompt defines exactly what counts as a mismatch and what does not ("Missing internal detail, ambiguous wording, hypothetical misuse, and undocumented edge cases are not mismatches… If the evidence is not decisive, report inconclusive", line 53), and the tool terminates the run (`terminate: true`, line 28). *Why it transfers:* this is a doc-drift CI — one auto-generated case per doc page (`packages/evals/evals/documentation-audit.eval.ts:34-36`, `it.for(pages)`) that **fails** when a doc contradicts the implementation. August has an extensive docs tree and no equivalent check; a prompt that reads the doc *and* the implementation and is required to answer "inconclusive" rather than guess is a pattern worth copying verbatim.

- **Make the isolation's limits explicit in the artefact** — `packages/evals/README.md:90`: "Provider traffic still requires container network access, so Docker alone cannot prove that arbitrary code written by an agent never uses the network." *Why it transfers:* the same honesty applies to August's sandbox: say what the container does *not* prove, so nobody cites the isolation as a guarantee it cannot give.

## Files skipped (with reasons)

None. All 30 files listed for this shard were opened and read in full — there are no generated, vendored, binary or large-data files in `packages/evals` (the largest file is `src/harness.ts` at 20 636 bytes, and the whole shard is under 150 KB of TypeScript/Markdown/JSON).

## Uncertainties

- **Shard naming.** The manifest has no row whose `owner-shard` column is literally `evals`; the only shard containing eval paths is `packages-evals-01` (30 rows), and every path in the manifest matching `eval` lives under `packages/evals/`. I took `packages-evals-01` as this shard's file list and cross-checked it against the pre-existing `C:/Dev/august-harness/docs/research/pi/shards/packages-evals-01.filelist.tsv` — the two sets are identical (30 paths, no dups, no extras). The lead may want to rename the shard key to `packages-evals-01` for consistency with the other rows.
- **The `vitest-evals` / `@vitest-evals/core` contract is external.** `describeEval`, `run()`, `judges`, `judgeThreshold`, `StructuredOutputJudge`, `ToolCallJudge`, `createJudge`, `toolCalls`, `readReportWorkspace` and `readVitestJsonReportFile` all come from npm packages (`vitest-evals@0.15.0`, `@vitest-evals/core@0.15.0`) that are **not** in this shard's file list. I inferred their contracts from usage here (e.g. `run()` returns `{output, errors, usage, timings, artifacts}`; `judgeThreshold: null` disables threshold gating). I did not read their source. If the lead wants the judge's exact scoring semantics, that is a separate shard.
- **Cross-shard dependencies were not audited.** `ModelRuntime`, `AgentSession`, `SessionManager`, `createAgentSessionFromServices`, `getCurrentSystemPrompt`, `readStoredCredential` and `InMemoryCredentialStore` live in `packages/coding-agent` and `packages/ai` (other shards). I read exactly one slice of a sibling file — `packages/coding-agent/src/core/system-prompt.ts:120-199` — to confirm that the system prompt is assembled from named `<name>…</name>` sections and that the `<docs>` section begins with the literal text `Pi documentation (read only`, which is what `excludePiDocumentation` and `verifySystemPrompt` slice and match on. Claims about `AgentSession.prompt`, `session.abort`, `session.reload` and `session.getSessionStats()` are read-from-this-shard's-usage, not from their implementations.
- **Runtime behaviour is unverified.** Per the read-only rules I executed nothing from the clone, so every behavioural statement in this report is a read-from-code claim. In particular I did not run an eval, did not build the images, and did not confirm that the privilege drop works on the target platform (the code requires POSIX uid APIs and refuses to run without them — `packages/evals/src/harness.ts:156-167`).
- **One minor code-reading ambiguity.** In `excludePiDocumentation` (`packages/evals/src/harness.ts:501-502`) the guard is `if (cwdStart < documentationEnd) throw new Error("...no working-directory section.")`. With `cwdStart = lastIndexOf("\n<cwd>\n")`, this throws both when there is no `<cwd>` section at all (`-1`) **and** when a `<cwd>` section appears *before* `<docs>` — two different faults sharing one message. The current prompt builder always emits `cwd` last (`packages/coding-agent/src/core/system-prompt.ts:183-190`), so the second case does not occur today; the message would be misleading if it did.
- **The `without_docs` arm's exact prompt surgery depends on section ordering.** `excludePiDocumentation` removes the `<docs>` section and asserts a `<cwd>` section follows it. If the prompt builder ever reorders sections so `cwd` precedes `docs`, the control arm would abort rather than silently measure the wrong thing — fail-closed, but it would break the control. I verified the current ordering in `packages/coding-agent/src/core/system-prompt.ts:150-190`; I did not verify that the ordering is contractually stable.
- **The `fixtures/acme-stream-api.json` path is not a repo file.** `packages/evals/evals/custom-provider.docs.eval.ts:14` names it, but it is written into the sandboxed workspace at run time from the `STREAM_API_DOCUMENTATION` constant (`packages/evals/evals/acme-server.ts:12-32`) via the harness's `workspaceFiles` option. There is no `fixtures/` directory in this shard's file list, and I confirmed the manifest contains no such path.
