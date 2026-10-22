# deepseek-harness / dsh-experimental-rest#2

## Shard shape

This shard is the **bulk of `packages/experimental/`** — 241 files across 18 packages (plus the group-level `packages/experimental/README*`). It is not a coherent subsystem but the "optional capabilities" shelf of the harness, and it divides into four families that fit together like this: **(1) a shared hook protocol library** (`hook-protocol`) with two dialect bridges on top of it (`hooks-claude-code`, `hooks-codex`) that let a user's existing Claude Code / Codex `hooks.json` fire on the harness's interception extension points (`agent/pre-step`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping`, `subagent/start|end`); **(2) model-facing tool packages** that register into `ctx.tools` with a system-prompt section — `tool-session-query` (workspace-authorized session-history search/trace/read), `tool-terminal` (six persistent-PTY tools), `tool-ralph` (a fixed fresh-agent iteration loop over the workflow/subagent seams), `tool-worktree` (one Git-worktree creation tool); **(3) a language-level execution backend** — `ptc-runtime-python`, a CPython subprocess runtime for programmatic tool calling that speaks a versionless JSON-lines protocol on the child's fd 3 and treats every inbound frame as hostile; **(4) two vertical services plus their provider** — `speech-to-text` (a provider registry) with `speech-to-text-sensevoice` (a local ONNX/Silero worker in a managed subprocess), and `session-title-all-prompts-llm` (an LLM title provider). The remaining seven packages are one-line **bundle/stub layers** (`inspector-profile`, `plugin-market-bundle`, `ralph-bundle`, `session-search`, `session-titles-bundle`, `skill-badge`, `terminal-bundle`) whose entire runtime is a `cordis.patch.yml` that inserts or disables rows in a profile — the "optional capability, off by default, selectable in the GUI plugin manager" packaging pattern the group README describes. Lens coverage across the shard: the agent loop and tool-calling flow is the strongest area (hook bridges, four tool packages); tool-call reliability is unusually well served (never-throw-into-the-loop, most-restrictive merge, hostile-frame rebuilds, bounded handoffs); model-specific adaptation shows up as the two hook dialects; memory/learning is thin (only the title provider's `currentTitle` anchoring and the bundled badge skill); **context-window management and compaction are essentially absent** from this shard — the closest thing is the Ralph loop's bounded cross-round handoff; reasoning/thinking content is handled in exactly one place (the title provider rejecting a reasoning-only response); UI/UX appears as the tool `presentCall` / `presentResult` cards and the SenseVoice preparation step machine; config is uniformly schemastery-validated-at-load; evals/testing is strong, with a "prefer the real implementation" rule and an executable cross-language mirror test.

## Per-file notes

### packages/experimental/README.md
- Purpose: The group map for `packages/experimental` — definitions of **Experimental**, **Optional** and **Official**, and a 46-row package table giving each package's role and `ctx` key.
- Key abstractions: The tri-state vocabulary (Experimental = no support commitment; Optional = user-selected; Official = listed in the Plugins page) and the rule that *none* of the three describes maturity.
- Data flow: Pure documentation; the promotion criteria (named product role, documented behaviour, current consumers, release contents, test evidence) are the gate the group enforces on itself.
- Non-obvious design decisions: "A package belongs here only when its entire public contract is experimental or internal-only; an experimental option inside a product package stays with that product role" — so the shard boundary is per-package, never per-feature.
- Edge cases / failure handling: n/a — but the doc names the two policy sources it defers to (`scripts/experimental-package-policy.ts` and the optional-bundle Agent Note).
- Surprising: The group explicitly says publication, default installation and GUI visibility do **not** determine maturity — three axes deliberately orthogonal.

### packages/experimental/README.zh.md
Chinese translation of the group map; same frontmatter (`kind: package-group`), same 46-row table.

### packages/experimental/README.i18n.yaml
Bilingual-pair consistency record: a per-heading-section hash of the English and Chinese blocks, regenerated with `pnpm run verify-translation-pairing --write`. The file is the machine-checkable proof that the two READMEs did not drift.

### packages/experimental/hook-protocol/src/types.ts
- Purpose: The dialect-neutral vocabulary shared by both hook bridges.
- Key abstractions: `HookDialect` (`'claude-code' | 'codex'`), `CommandHook` (command + `timeoutSec`), `MatcherGroup` (matcher + hooks), `MatcherMode`, and `HookOutput` whose **every field is optional** because a hook may exercise any subset.
- Data flow: `declare module '@deepseek-ai/dsh-session/types'` merges `'hook/invoked'` and `'hook/result'` into `SessionEventMap`; the two bridges import the types and build their own payloads.
- Non-obvious design decisions: The merged events are explicitly *not* `SurfaceEventType`s and carry no `surfaceOp` — they are durable audit records, not surface intent. `HookOutput.updatedInput` is **parsed but never honoured**, deferred to a named Agent Note.
- Edge cases / failure handling: `handlerId` is a stable id so an invoked/result pair correlates; `turn` is the open turn the invocation lives inside, so a `SessionStart` hook (which runs before turn 1) writes no event at all.
- Surprising: A native plugin at an interception point is **not** a bridge and writes no `hook/*` records — the event vocabulary is reserved for the two reference dialects.

### packages/experimental/hook-protocol/src/codec.ts
- Purpose: Decode a hook process outcome (exit code + stdout + stderr) into a neutral `HookOutput`.
- Key abstractions: `parseHookOutput(exitCode, stdout, stderr, expectedEventName?)` plus two private helpers `topLevelDecisionOf` / `permissionDecisionOf`.
- Data flow: stdout is trimmed; exit 2 ⇒ `decision:'block'` with stderr as `reason`; exit 0 ⇒ stdout is parsed as JSON *only if* it starts with `{`; `applyStructured` folds the parsed fields in.
- Non-obvious design decisions: The legacy top-level `decision` accepts **only** `approve`/`block`; `allow`/`deny`/`ask` are reserved for `hookSpecificOutput.permissionDecision`. An out-of-band `{"decision":"deny"}` is invalid and ignored rather than coerced — the schemas say so, and this is a security-relevant distinction, not a nicety.
- Edge cases / failure handling: Malformed JSON on a clean exit is **lenient** (stays plain stdout, no throw). Structured stdout on an exit-2 run is **ignored** — stderr is authoritative. The `expectedEventName` guard discards a `hookSpecificOutput` block whose `hookEventName` names a different event *or is missing*, while still recording the claimed discriminator for the log.
- Surprising: `permissionDecision` **overrides** the legacy top-level decision — the two channels are kept distinct on the wire and folded only at the end.

### packages/experimental/hook-protocol/src/matcher.ts
- Purpose: Pattern interpretation and group selection for both dialects.
- Key abstractions: `matchesMatcher(matcher, query, mode)`, `matcherDiagnostic(matcher, mode)`, `selectHookGroups(groups, query, mode)`.
- Data flow: `isMatchAll` treats absent / `''` / `'*'` as match-all; Claude mode tests `CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/` and exact-matches pipe-separated alternatives; Codex mode is always an unanchored regex.
- Non-obvious design decisions: The dialects' **only** difference is collapsed into one `mode` parameter rather than duplicating the engine. The same pattern `Bash` therefore means "exactly Bash" in Claude and "/Bash/" in Codex — a real semantic divergence, pinned by a test.
- Edge cases / failure handling: An invalid regex is a **non-match at runtime** (never throws) and a **config error at parse time** (via `matcherDiagnostic`) — two different doors, deliberately.
- Surprising: `selectHookGroups` filters out groups with zero hooks *before* matching, so a group that matches but carries no command is invisible.

### packages/experimental/hook-protocol/src/merge.ts
- Purpose: Fold every matched hook's outcome into one most-restrictive decision.
- Key abstractions: `MergedDecision` (`allow|ask|deny|none`), `MergedHookOutcome`, and the private `rank()` / `decisionForRank()` pair.
- Data flow: `rank` maps `deny|block`→3, `ask`→2, `approve|allow`→1, none→0; the max rank wins; reasons are collected **per rank** so only the objections explaining the winning decision surface; the first `continue:false` is sticky; `additionalContext` and `systemMessages` accumulate in hook order.
- Non-obvious design decisions: Reasons are stored in a `Map<number, string[]>` rather than one flat list — an `allow` hook's reason is never shown, and when `deny` beats `ask` the ask's reasons are dropped.
- Edge cases / failure handling: An empty hook list yields the neutral `none` outcome, which the caller reads as "no hook had anything to say".
- Surprising: The merge is **order-independent** in its decision but **order-dependent** in its context accumulation — the README notes the reference engines launch concurrently, so serial execution is a deliberate trade.

### packages/experimental/hook-protocol/src/runner.ts
- Purpose: Execute one command hook through `ctx.shell` and decode the outcome.
- Key abstractions: `runHook(bash, hook, options, now)` returning `{ output, durationMs }`; `RunHookOptions` carries the payload, env, cwd, an **explicit caller-owned** `AbortSignal`, the `trailingNewline` flag, `defaultTimeoutMs` and `expectedEventName`.
- Data flow: The payload is JSON-stringified onto stdin; `hook.timeoutSec * 1000` overrides `defaultTimeoutMs`; `bash.resolve(request)` then `bash.execute(...).result()`; `exitCode ?? undefined` maps a signal death to "no exit code".
- Non-obvious design decisions: The runner uses the **shell executor** rather than a bespoke spawn, inheriting its credential scrub, process-group cancellation and timeout machinery. The 10-minute `DEFAULT_HOOK_TIMEOUT_MS` lives here, once, because both reference engines use it.
- Edge cases / failure handling: `runHook` **never throws** — an executor rejection becomes a `HookOutput` with no exit code and the failure on stderr, so a hook that cannot run is a non-blocking error and the turn proceeds.
- Surprising: `signal` is a required, caller-owned `AbortSignal` (asserted with `expectTypeOf`), not an optional convenience.

### packages/experimental/hook-protocol/src/events.ts
- Purpose: Append helpers for the durable, log-only `hook/*` session events.
- Key abstractions: `HookInvocation`, `HookResultRecord`, `DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500`, `summarizeStderr`, `appendHookInvoked`, `appendHookResult`.
- Data flow: `appendHookInvoked` writes `turn/point/dialect/handlerId` and omits an absent matcher; `appendHookResult` derives `decision` = parsed decision, else `stop` for `continue:false`, else `pass`, plus the optional `exitCode`, the capped `stderrSummary` and `durationMs`.
- Non-obvious design decisions: The stderr cap is a **parameter**, not a constant baked in, so each bridge owns its own `stderrSummaryMaxChars` while the default lives once next to the truncation rule.
- Edge cases / failure handling: `summarizeStderr` returns `undefined` for blank stderr rather than `''`, so the event simply omits the key.
- Surprising: The `decision` fallback order puts an explicit decision *above* the `continue:false` fallback — a `continue:false` hook that also returned `decision:'block'` is recorded as `block`.

### packages/experimental/hook-protocol/src/detached.ts
- Purpose: Quiescence tracking for emit-shaped hook runs that no extension point awaits.
- Key abstractions: The `DetachedRuns` interface (`signal`, `track(run)`, `drain()`) and `createDetachedRuns()`.
- Data flow: `track` adds the promise to a `Set` and prunes it on settle; `drain` aborts the controller (killing a still-running hook process rather than waiting out its 10-minute timeout) and then loops `while (inflight.size > 0)` awaiting `Promise.allSettled`.
- Non-obvious design decisions: The drain loop **re-checks after each wave** because a chain can be tracked while a prior wave is settling — a single `allSettled` snapshot would resolve early.
- Edge cases / failure handling: A rejected chain is absorbed by the bookkeeping so the drain still resolves; the doc insists the *caller* must still attach a `.catch` (an untracked rejection is what turns a failure into silence).
- Surprising: `drain` is registered as the bridge's **effect disposer**, so `fiber.dispose()` resolving means the bridge's detached work is quiescent — the whole point.

### packages/experimental/hook-protocol/src/index.ts
Public export barrel: types, `matcherDiagnostic`/`matchesMatcher`/`selectHookGroups`, `parseHookOutput`, `DEFAULT_HOOK_TIMEOUT_MS`/`runHook`, `mergeHookOutputs`, the event helpers, and `createDetachedRuns`. A one-file re-export surface; no logic.

### packages/experimental/hook-protocol/package.json
Manifest for `@deepseek-ai/dsh-hook-protocol` v0.2.1-rc.2: ESM, publishes `lib/index.js` + `lib/types`, peer-deps `dsh-shell`/`dsh-session`/`cordis`, and exports `./src/*` so tests import source directly.

### packages/experimental/hook-protocol/tsconfig.json
TS project: `rootDir src`, `outDir lib/types`, references vendor/cosmokit, vendor/cordis, packages/shell/shell, packages/core/session.

### packages/experimental/hook-protocol/README.md
Package reference for the shared engine: what a hook can do (block with a model-visible reason, ask before a tool runs, attach context, request a stop), the six-step pipeline, the design philosophy ("**Never throw into the loop**"), and the three explicit limits (input rewrite deferred, a folded halt has no run-level effect, only the command-hook shape runs). It also states the KV-cache effect: hook context is append-only and does not invalidate the reusable prefix.

### packages/experimental/hook-protocol/README.zh.md
Chinese translation of the hook-protocol reference; same three Known Limitations and the same "never throw into the loop" rule.

### packages/experimental/hook-protocol/README.i18n.yaml
Per-heading-section bilingual hash record for the hook-protocol README.

### packages/experimental/hook-protocol/tests/codec.spec.ts
Vitest for `parseHookOutput`: exit-code semantics, the approve/block-only legacy decision (allow/deny/ask at top level are invalid), `permissionDecision` overriding it, the `hookEventName` mismatch **and** missing-discriminator discards, top-level fields surviving a mismatched block, and structured stdout ignored on exit 2.

### packages/experimental/hook-protocol/tests/matcher.spec.ts
Vitest for matcher semantics: the three match-all sentinels, Claude literal exact-match vs Codex substring-regex on the identical `'Bash'` pattern, invalid regex as a non-match, the two stable diagnostic strings, and `selectHookGroups` preserving config order and original references.

### packages/experimental/hook-protocol/tests/merge.spec.ts
Vitest for `mergeHookOutputs`: deny>ask>allow ordering regardless of input order, reasons joined with a blank line only from blocking hooks and only at the winning rank, the sticky first `continue:false`, and context/system messages collected in hook order with empties skipped.

### packages/experimental/hook-protocol/tests/runner.spec.ts
Vitest for `runHook` with a duck-typed recording `ShellExecutor`: stdin framing with/without the trailing newline, env and cwd threading, `timeoutSec` vs the default, signal passthrough, a null exit code (signal death) decoding as `undefined`, and an executor rejection (including a non-`Error` rejection) becoming a non-blocking error rather than a throw.

### packages/experimental/hook-protocol/tests/events.spec.ts
Vitest for the `hook/*` events: log-only (no `surfaceOp`), an absent matcher omitted, the decision falling back to `stop`/`pass`, the 500-character stderr summary with an ellipsis (the cap is exclusive — exactly 500 is kept verbatim), and invoked/result correlating by `handlerId`.

### packages/experimental/hook-protocol/tests/detached.spec.ts
Vitest for `createDetachedRuns`: the drain fires the signal, an empty drain resolves immediately, a drain waits for a tracked run, a drain waits for a run tracked **while a prior wave was settling**, and a rejected tracked run is absorbed so the drain still resolves.

### packages/experimental/hooks-claude-code/src/config.ts
- Purpose: Parse a Claude Code `hooks.json` (or a settings file's `hooks` key) into shared `MatcherGroup`s.
- Key abstractions: `parseClaudeCodeConfig(raw, vars)` returning `{ config, skipped }`; `substituteCommand(command, vars)`; the `CLAUDE_EVENTS` allowlist of seven events.
- Data flow: For each event, each group's hooks are filtered to `type === 'command'` (others are pushed to `skipped`), `command` strings get `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substituted, `timeout` becomes `timeoutSec`, and the matcher is validated.
- Non-obvious design decisions: Matchers on `UserPromptSubmit` and `Stop` are **discarded before validation** — those events have no matcher subject, so an invalid regex there must not reject the whole config. Unsupported events are ignored *before* their groups are parsed, so an invalid matcher on `Setup` cannot disable a valid `PreToolUse` hook.
- Edge cases / failure handling: Malformed entries (non-array groups, non-object group/hook, missing command) are dropped silently rather than failing boot. A matcher-bearing runnable group with an invalid regex **throws** a `SyntaxError` naming the event, so the bridge can reject the complete config before registering any listener.
- Surprising: A hook with no `type` field is treated as a command — the Claude Code default.

### packages/experimental/hooks-claude-code/src/index.ts
- Purpose: The Claude Code bridge plugin — run unmodified CC command hooks on the harness's interception points.
- Key abstractions: `apply(ctx, config)`, the `runPoint(point, matchQuery, payload, opts)` helper, the `Config` schema (`configPath`, `pluginRoot`, `projectDir`, `defaultTimeoutMs`, `stderrSummaryMaxChars`), and the per-event payload builders.
- Data flow: `runPoint` selects matching groups, resolves the session workspace (`ctx.workingDirectory.ensure`), appends `hook/invoked`, runs the hook through `ctx.shell` with `expectedEventName: point`, appends `hook/result`, and folds all outputs with `mergeHookOutputs`. The merged outcome is then mapped onto the extension point's decision.
- Non-obvious design decisions: **"Adding context is not a veto."** A context-only hook calls `await next()` *first* and folds its sourced message into the downstream decision afterwards, so a later `agent/pre-step` or `tools/post-execute` listener can still reject or rewrite. The `Stop` hook forces another step via `agent.steer(...)` at `agent/turn-stopping`. Matched hooks run **serially in config order** so each invoked/result pair stays adjacent in the log.
- Edge cases / failure handling: A config that cannot be read or parsed logs a warning and **registers nothing** — the agent still starts. `updatedInput` and `systemMessage` are parsed but warned as "not yet honored/surfaced". A detached `SessionStart`/`SubagentStart` inject failure is caught and logged.
- Surprising: `transcript_path` is always `''` — the persistence seam exposes no artifact path and the default zstd session log is not readable by hook scripts; the field is kept only for compatibility. `SUBAGENT_TYPE` is the constant `'general-purpose'` because the harness subagent seam carries no per-kind label, so a config matching a specific kind never fires.

### packages/experimental/hooks-claude-code/tests/bridge.spec.ts
Full-loop bridge test: a scripted `MockAdapter` drives the **real** agent loop and **real** bash executor while **real** shell hook scripts run from a temp dir — only the model is mocked ("prefer the real implementation"). Cases cover a blocked prompt closing the turn with zero model requests, `PreToolUse` deny (tool never runs, `isError` result), `PostToolUse` block rewriting the result to `isError` with feedback, an `ask` decision **failing closed** when no approval service is mounted, disposal aborting and reaping a still-running hook (asserted with `process.kill(pid, 0)` throwing), and the "no stray `default` export" loader shape guard.

### packages/experimental/hooks-claude-code/tests/config.spec.ts
Vitest for `parseClaudeCodeConfig` / `substituteCommand`: bare vs settings-wrapper equivalence, `timeout`→`timeoutSec`, skipped non-command hooks recorded, malformed entries dropped without throwing, the invalid-regex `SyntaxError` message, and matchers discarded on matcher-less events before validation.

### packages/experimental/hooks-claude-code/tests/coverage-cases.ts
Shared 788-line coverage matrix for the CC bridge, sliced by group (`config`|`stop`|`context`|`edge-paths`) so the branches can be scheduled independently. 36 named cases cover `transcript_path` degrading to `''` even with persistence mounted, `pluginRoot`/`projectDir` substitution plus the skip warning, `updatedInput` warned as a no-op, empty-stderr default reasons for deny/block, `{"continue":false}` recorded as `stop` but not halting, a `hookSpecificOutput` naming a *different* event not denying the tool, and `CLAUDE_PROJECT_DIR` defaulting to the session workspace.

### packages/experimental/hooks-claude-code/tests/coverage-config.spec.ts
Four-line slice registering the `config` group of `coverage-cases.ts` (config option arms, substitution, skip warning).

### packages/experimental/hooks-claude-code/tests/coverage-context.spec.ts
Four-line slice registering the `context` group of `coverage-cases.ts`.

### packages/experimental/hooks-claude-code/tests/coverage-edge-paths.spec.ts
Four-line slice registering the `edge-paths` group of `coverage-cases.ts`.

### packages/experimental/hooks-claude-code/tests/coverage-stop.spec.ts
Four-line slice registering the `stop` group of `coverage-cases.ts`.

### packages/experimental/hooks-claude-code/README.md
Package reference for the CC bridge: the hook-point table (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart/Stop), the "hooks run in the agent's current Session directory" rule, the design philosophy (compatibility adapter not a power tool; adding context is not a veto; containment at every failure; dispose reaches quiescence; serial not concurrent), and a long Known Limitations list (23 of CC's 30 events unsupported, and each supported event explicitly *partial*).

### packages/experimental/hooks-claude-code/README.zh.md
Chinese translation of the CC bridge reference.

### packages/experimental/hooks-claude-code/README.i18n.yaml
Per-section bilingual hash record for the hooks-claude-code README.

### packages/experimental/hooks-claude-code/package.json
Manifest: peer-deps on dsh-agent, dsh-hook-protocol, dsh-llm, dsh-session, dsh-subagent, dsh-tools, dsh-session-projection, dsh-working-directory; dev-deps on the real agent-loop, bash-local and subprocess-local so the bridge is exercised against the real implementation.

### packages/experimental/hooks-claude-code/tsconfig.json
TS project with references to hook-protocol, core/agent, core/tools, core/session, subagent/subagent, llm/llm, shell/shell and session/working-directory.

### packages/experimental/hooks-codex/src/config.ts
- Purpose: Parse the Codex five-event hook subset into shared `MatcherGroup`s.
- Key abstractions: `parseCodexConfig(raw)` returning `{ config, skipped }`; `CODEX_EVENTS` = `PreToolUse, PostToolUse, SessionStart, UserPromptSubmit, Stop`.
- Data flow: Only `type === 'command'` hooks run, and `async: true` is recorded as a skipped `'async hook'`; both `timeout` and the `timeoutSec` alias are accepted; the matcher is validated per group.
- Non-obvious design decisions: Codex performs **no command substitution** and has no `pluginRoot`/`projectDir` variables, so the parser stays dialect-local rather than sharing the CC parser — the duplication is deliberate, and `/* jscpd:ignore-start */` marks it as such.
- Edge cases / failure handling: Unknown events are dropped silently; an invalid regex throws a `SyntaxError` naming the event, matching the CC bridge's behaviour so both fail at the same door.
- Surprising: The `skipped` list carries a **reason** string per entry (`unsupported "prompt" hook` vs `async hook`), unlike the CC bridge's bare `type`.

### packages/experimental/hooks-codex/src/index.ts
- Purpose: The Codex bridge plugin.
- Key abstractions: `apply(ctx, config)`; `Config` adds `model` (stamped on every payload) to the shared fields; `runPoint` mirrors the CC bridge.
- Data flow: Payloads are snake_case with `turn_id` on turn-scoped events, `model` and `permission_mode: "default"` on every event, and `transcript_path` always `null`. stdin is written **without** a trailing newline.
- Non-obvious design decisions: A clean **plain** stdout becomes `additionalContext` only when no structured context exists and the text is not JSON — the bridge never lets raw JSON leak into the conversation as prose. Only `deny` is honoured: no `allow`, no `ask`, no `defer`.
- Edge cases / failure handling: The same containment rules as the CC bridge (config failure registers nothing; a detached failure is logged), and `expectedEventName: point` discards a mismatched `hookSpecificOutput` block.
- Surprising: `tool_name` is the **real** tool name (`exec.name`) — a hardcoded constant would disagree with what the matcher tests and make a tool matcher never fire. The `tool_input` shape is Codex's `{ command }`, derived from the call's `command` argument, so non-shell tool arguments are not faithfully exposed (and the README says so).

### packages/experimental/hooks-codex/tests/bridge.spec.ts
Full-loop Codex bridge test: regex substring matching, a `Stop` hook forcing continuation with the reason as steering, **turn cancellation aborting and reaping** a running `UserPromptSubmit` hook (asserted by `process.kill(pid, 0)` throwing and the event list showing the hook pair inside the turn), disposal quiescence, the five-event limit, and the loader export-shape guard.

### packages/experimental/hooks-codex/tests/config.spec.ts
Vitest for `parseCodexConfig`: only the five supported events survive, `timeout`/`timeoutSec` accepted with no substitution, non-command and `async:true` recorded as skipped, malformed entries dropped, matcher omitted for match-all and kept when present, and the invalid-regex message.

### packages/experimental/hooks-codex/tests/coverage-cases.ts
Shared coverage matrix for the Codex bridge, sliced by group (`prompt`|`post-tool`|`result-shape`|`edge-paths`|`payload`). The head shows the `prompt` group asserting `transcript_path` degrades to `null` even with persistence mounted, and a `UserPromptSubmit` exit-2 block closing the turn with no model step.

### packages/experimental/hooks-codex/tests/coverage-post-tool.spec.ts
Three-line slice registering the `['post-tool','payload']` groups of `coverage-cases.ts`.

### packages/experimental/hooks-codex/tests/coverage-prompt.spec.ts
Three-line slice registering the `['prompt','edge-paths']` groups of `coverage-cases.ts`.

### packages/experimental/hooks-codex/tests/coverage-result-shape.spec.ts
Three-line slice registering the `result-shape` group of `coverage-cases.ts`.

### packages/experimental/hooks-codex/README.md
Package reference for the Codex bridge: the five hook points, the dialect-shaped payloads, the design philosophy ("**Dialect-shaped, not maximal**" — the protocol's shape is preserved even where the harness could do more), and the limits (5 of 10 events unsupported; `transcript_path` always `null`; `stop_hook_active` always `false`).

### packages/experimental/hooks-codex/README.zh.md
Chinese translation of the Codex bridge reference.

### packages/experimental/hooks-codex/README.i18n.yaml
Per-section bilingual hash record for the hooks-codex README.

### packages/experimental/hooks-codex/package.json
Manifest: the same peer-dep set as the CC bridge **minus** `dsh-subagent` (Codex has no subagent hook points), plus dev-deps on the real agent loop and bash-local.

### packages/experimental/hooks-codex/tsconfig.json
TS project with references to hook-protocol, core/agent, core/tools, core/session, llm/llm, shell/shell and session/working-directory — and no subagent reference, mirroring the missing subagent events.

### packages/experimental/ptc-runtime-python/src/protocol.ts
- Purpose: The host side of the versionless JSON-lines wire protocol between the Node host and the CPython subprocess.
- Key abstractions: The frame unions (`ChildToHost`, `ReplyMessage`), `PROTOCOL_FD = 3`, `encodeJsonPlain`, `checkDoneValue`, `hasUnsafeIntegerToken`, `hasNonLosslessNumber`, `logTruncationMarker`, and `validateChildFrame`.
- Data flow: Frames travel on the child's fd 3, one JSON object per line, leaving stdout/stderr free for the program's own output. The host sends `boot` (every cap + namespace declarations), then `run` (only the program body) after `boot-ack`, and answers each `call` with one `reply`.
- Non-obvious design decisions: **One direction of trust** — the host treats every inbound frame as hostile (model code has fd 3 and can post anything) and **rebuilds** it field by field; the Python side trusts host replies. `validateChildFrame` returns `undefined` for anything that does not rebuild cleanly, so a throw in the host's `message` handler cannot crash the host process. A `done` frame may carry **both** `value` and `error`; the validator preserves both and the contract says the consumer must check `error` first.
- Edge cases / failure handling: A call id must be a finite number and not `-0` (which `JSON.stringify` would re-serialize as `0`, colliding with a real id-0 call). A `log` frame's `truncated` is rebuilt only for the literal `true` — a forged `1` or `'yes'` would otherwise silence capture for the rest of the run. `hasUnsafeIntegerToken` reads the **raw text** because `JSON.parse` rounds `9007199254740993` before any validation can see it.
- Surprising: `encodeJsonPlain` is a hand-written non-recursive encoder, because `JSON.stringify` throws `RangeError` a few thousand levels deep and the seam's `PtcJsonValue` has no depth limit; it also emits a beyond-safe-range integral double as its exact BigInt digits rather than `JSON.stringify`'s rounded spelling.

### packages/experimental/ptc-runtime-python/src/index.ts
- Purpose: The `PythonPtcRuntime` plugin — spawn, frame pump, budgets, containment, teardown.
- Key abstractions: `Config` (every cap), `PythonPtcRuntime extends PtcRuntime`, and the exported helpers `hostFrameParseCeiling`, `readProcessStart`, `resolvePythonBin`, `detachResidual`.
- Data flow: The constructor validates every config value, resolves and version-probes the interpreter, and registers the teardown effect. `run` resolves a spec, validates the bindings, spawns the child **detached** with `stdio: ['pipe','pipe','pipe','pipe']`, then pumps fd 3: frames are validated, `call` frames are dispatched to the host bindings and answered, `log` frames are admitted against a byte ledger, and `done` settles the run. Teardown aborts every live run, escalates SIGTERM→SIGKILL, and awaits each child's exit.
- Non-obvious design decisions: The **load-time config gate** rejects configurations that would fail late and expensively: a non-integer `cpuSeconds` (`setrlimit` needs an int), an `addressSpaceMb` whose derived byte count is not a safe integer (it would cross the wire as `null` and the child would get **no limit at all**), a `maxWallMs` past `MAX_TIMER_DELAY_MS` (`setTimeout` silently clamps it to 1 ms), and a byte budget that cannot fit the fd-3 frame parse cap. The output budget is also checked against `RLIMIT_AS` × a 12× worst-case Unicode expansion so a near-budget output *truncates* rather than dying as `worker-exit`.
- Edge cases / failure handling: The log ledger charges each entry its **serialized** cost (quotes + escapes + separator), starting one byte below `maxLogBytes` so an exactly-exhausted ledger still serializes to exactly `maxLogBytes`. A cheap lower bound (`text.length + 3`) is checked *before* the escaped copy exists, so a control-heavy forgery never materialises a sixfold-inflated string. A signal death maps to `exitCode: undefined` (a non-blocking error, no clean exit code to act on). `messageOf` wraps the conversion of a rejected binding's value because a throwing `Symbol.toPrimitive` in a detached reply callback would leave the program blocked on `await` forever.
- Surprising: `readProcessStart` reads field 22 of `/proc/<pid>/stat` — a pid is reusable the moment the kernel reaps it, so signalling one that a later process inherited would kill an unrelated process group; start time is the identity half of (pid, started).

### packages/experimental/ptc-runtime-python/src/launch.ts
`bootstrapInput()` reads the shipped `py/protocol.py` and `py/bootstrap.py` through the host filesystem (including packaged virtual files) and returns them as JSON; `PYTHON_BOOTSTRAP_LOADER` is a nine-line interpreter entry that reads that JSON from **stdin**, compiles the protocol module into a synthetic `protocol` module, and execs the bootstrap. The trusted sources therefore reach the interpreter independently of sandbox temp mounts and locale text encoding.

### packages/experimental/ptc-runtime-python/py/protocol.py
The Python mirror of the wire: `PROTOCOL_FD = 3`, one `TypedDict` per frame, `ChildToHost` / `ReplyMessage` / `HostToChild` unions, and `log_truncation_marker` producing byte-identical text to the TS side. The `global` wire key is a Python keyword, so those `TypedDict`s are declared with the **functional** syntax (`_NamespaceRequired = TypedDict("_NamespaceRequired", {...})`) — a class attribute cannot be named `global` and a `global_` attribute would describe a key the wire never sends.

### packages/experimental/ptc-runtime-python/py/bootstrap.py
Child-side bootstrap (2,599 lines): the fd-3 channel, the `LogBuffer` ledger, resource-limit application, running the model program as the body of an async function (so top-level `await` and `return` work), binding dispatch through awaitables, and settlement. The head shows three defensive details worth naming: a fixed `Context(prec=28)` for float encoding (a program that sets `getcontext().prec = 2` would otherwise silently round the completion value, and `traps[Inexact] = True` would make a *successful* run raise); the raw `_os_write` primitive bound into the `_run` frame locals (so a program that rebinds `os.write` cannot change which write the last-resort fallback uses); and a pre-encoded `_FALLBACK_DONE_FRAME` literal so a done frame can still be written when every transitive name has been sabotaged.

### packages/experimental/ptc-runtime-python/tests/protocol-mirror.e2e.ts
Cross-language mirror test: spawns a **real** `python3` and compares `PROTOCOL_FD`, the truncation-marker text across three budgets, and every public `TypedDict`'s required/optional key set against the TS `WIRE_FRAME_FIELDS`. It enumerates the Python side's own `vars(protocol)` rather than a TS-supplied name list, so a Python-only extra frame is visible. Self-skips when no `python3` is on PATH.

### packages/experimental/ptc-runtime-python/tests/protocol.spec.ts
Vitest for the host codec: the marker text, `validateChildFrame` rebuilding (forged extras dropped; only the literal `true` keeps `truncated`; a call frame without `args` drops whole so a binding can never be invoked with a non-JSON value), and the losslessness meters.

### packages/experimental/ptc-runtime-python/tests/runtime.spec.ts
The real-subprocess suite (293 KB, ~5,700 lines, 250+ named cases) covering: load-time config rejections, inherited RLIMIT handling (an inherited soft limit stricter than the configured cap is preserved; a CPU overrun is reported as a `timeout`), program and binding round-trips, deep and wide JSON, forged frames, monkeypatched bootstrap primitives (the CPU budget is still enforced when the program rebinds the enforcer), SIGTERM→SIGKILL escalation, the reply-backlog and call-backlog caps, and a dedicated "hostile peer" section. Read the head and the complete describe/it index; individual case bodies were not each re-read line by line.

### packages/experimental/ptc-runtime-python/tests/sandbox.spec.ts
Probes the sandbox provider **independently** first, so a Python launch regression cannot skip the confinement tests, then asserts `read-only` / `workspace-write` / `danger-full-access` behaviour, symlink escapes, and the `sandbox.denied` diagnostic being separate from the program outcome.

### packages/experimental/ptc-runtime-python/tests/boot-write-failure.spec.ts
Mocks `node:child_process` so the fd-3 pipe throws `EPIPE` on the very first boot-frame write, proving a child that cannot be fed settles the run instead of hanging the host.

### packages/experimental/ptc-runtime-python/tests/residual-detach.spec.ts
Proves `detachResidual` returns a right-sized copy that does **not** share the source frame's backing store, so a small residual view cannot pin a 1 MiB allocation behind it. The fixture deliberately exceeds Node's Buffer pool threshold so the `byteLength` assertion is meaningful.

### packages/experimental/ptc-runtime-python/tests/stray-fragments.spec.ts
Mocks `child_process` so every stdout byte arrives as its own `data` event, proving stray fragments are **sealed** without recopying the sealed prefix (≤1024 fragments, ≤256 KB copied for 60,001 one-byte fragments), and that illegal UTF-8 / CESU-8 payloads are bounded by their U+FFFD-decoded cost rather than their raw length.

### packages/experimental/ptc-runtime-python/tests/setup.ts
`createRuntimeContext` helper: mounts the local sandbox, session projections and sandbox policy, with an owned teardown via `onTestFinished`.

### packages/experimental/ptc-runtime-python/README.md
Package reference for the Python PTC backend: the one-direction-of-trust model, the fd-3 wire, the lossless-JSON crossing, the mirror alignment (and the stated limit that **field types** are not compared across the language boundary), and a long Known Limitations list (no byte cap on binding values, a `setsid` escape is not reaped, a late `log` frame is dropped, `run()` is one-shot, Unix only, CPU-signal classification depends on the launcher).

### packages/experimental/ptc-runtime-python/README.zh.md
Chinese translation of the ptc-runtime-python reference.

### packages/experimental/ptc-runtime-python/README.i18n.yaml
Per-section bilingual hash record for the ptc-runtime-python README.

### packages/experimental/ptc-runtime-python/package.json
Manifest: publishes `lib/index.js` **plus** `py/**/*.py` (the Python sources ship verbatim, no build step), peer-deps `dsh-ptc-runtime`, `dsh-timeout`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-util-values`.

### packages/experimental/ptc-runtime-python/tsconfig.json
TS project with references to ptc-runtime, util/timeout, util/values, sandbox and sandbox-policy.

### packages/experimental/ptc-runtime-python/tsdown.config.ts
tsdown config: one ESM bundle; the Python side is not TypeScript and ships verbatim under `py/`.

### packages/experimental/speech-to-text-sensevoice/src/recognizer.ts
- Purpose: One serial SenseVoice worker with request-owned cancellation and idle reclamation.
- Key abstractions: The `SenseVoiceWorker` class, `readReady(handle, limit, signal)`, `readTranscript(response, limit)`.
- Data flow: `transcribe` enqueues onto a serial tail; the queue has a `maxPending` bound and each job runs with `AbortSignal.any([caller, lifetime])`. `start` spawns the child with a 32-byte random bearer token in `DSH_SPEECH_TOKEN`, reads one bounded readiness frame, and publishes `ready`. `execute` POSTs the WAV to the loopback worker under an inference deadline. `stop` terminates and joins the worker; an idle timer stops it after `idleTimeoutMs`.
- Non-obvious design decisions: The preparation state machine is **step-keyed** (`check`/`model`/`vad`/`verify`/`load`) with a per-step status, and progress notifications are **throttled** by `progressIntervalMs` while a completed snapshot is always retained. `inspect()` runs at activation and only *inspects* disk caches — activation performs no download and starts no worker.
- Edge cases / failure handling: A cancelled preparation keeps the completed steps; a failure publishes a `failed` phase with a sanitized `SpeechDownloadError` diagnostic and no raw cause. A worker that exits unexpectedly is reclaimed (the process range joined) before a replacement is started. A `SpeechInputError` (invalid input) **keeps** the loaded worker; any other failure stops it and returns to `standby`.
- Surprising: The `transcribe` path never triggers a download — a recording submitted in an unprepared state is rejected with "Prepare the local speech provider before recording".

### packages/experimental/speech-to-text-sensevoice/src/runtime.ts
- Purpose: Verified runtime assets and managed command execution for local transcription.
- Key abstractions: `Asset` (name/url/sha256/bytes), `RuntimeLock`, `RuntimePaths`, `inspectRuntime`, `downloadAsset`, `prepareRuntime`.
- Data flow: `downloadAsset` downloads to a unique `.<uuid>.part` file through a hashing `Transform` that also reports byte progress, verifies the size and SHA-256, then **atomically renames** the partial into place; the partial is removed in a `finally`. `prepareRuntime` orders the sources, tries each in turn, and finally re-verifies every file.
- Non-obvious design decisions: The ledger is keyed on **exact size + SHA-256** from a release-pinned lock file, so a cached file is trusted only if it matches bit-for-bit. A verified file that already exists is reused without any network request at all.
- Edge cases / failure handling: A download that exceeds the expected byte count aborts mid-stream with an `integrity` failure and no partial file survives. Source fallback happens for network/http/certificate/integrity failures but **not** for cancellation, storage failures or unclassified errors. A timeout is distinguished from an explicit cancellation via `timeoutOf(signal)`.
- Surprising: The model directory is `config.modelDirectory ?? <dataRoot>/models/sensevoice-onnx` and the VAD lives under a different subtree, so an explicit deployment path overrides only the model.

### packages/experimental/speech-to-text-sensevoice/src/model-sources.ts
`orderModelSources(assetUrl, origins, timeoutMs, signal)`: concurrent `HEAD` requests to every configured origin, the first 2xx wins and is returned first, all probes are joined in a `finally` and their bodies released, and a total probe failure falls back to the configured order rather than failing the preparation. A single deduplicated origin skips probing entirely.

### packages/experimental/speech-to-text-sensevoice/src/download-error.ts
`classifyDownloadFailure` walks the error `cause` chain (and `AggregateError.errors`) with a visited set so a cyclic chain terminates, mapping native codes to `dns` / `timeout` / `certificate` / `storage` / `network`; `SpeechDownloadError` exposes a `SpeechDownloadFailure` (resource, source, reason, code, status) whose public text carries **no** URL credentials, query strings or raw cause messages.

### packages/experimental/speech-to-text-sensevoice/src/process-server.ts
The private worker's authenticated loopback server: a `timingSafeEqual` bearer-token compare (with a length check first, since `timingSafeEqual` throws on a length mismatch), `POST /transcribe` only, a `content-length` bound, and 400-with-`invalid-input` vs 500 separation so the host can tell an input rejection from a native failure.

### packages/experimental/speech-to-text-sensevoice/src/inference.ts
Loads sherpa-onnx's `OfflineRecognizer` + Silero `Vad` (a CommonJS Node-API binding with JSDoc but no declarations, so it is loaded via `createRequire`), decodes 16 kHz PCM16, feeds 512-sample windows, and restores the onset a **cold** VAD reports late by padding the first segment only. The VAD output buffer is copied because Electron's V8 memory cage requires copied native buffers.

### packages/experimental/speech-to-text-sensevoice/src/input.ts
The accepted language hints (`auto`, `zh`, `en`, `yue`, `ja`, `ko`) and `validateInput`, which rejects an unsupported language, an oversized recording, or a malformed WAV as a `SpeechInputError` — a class distinct from a native failure so the loaded worker stays reusable.

### packages/experimental/speech-to-text-sensevoice/src/config.ts
The schemastery config: `providerId`, absolute `dataRoot`, optional pre-existing `modelDirectory`/`vadModelPath`, `precision`, `modelOrigin`/`modelOrigins` (a URL pattern that rejects embedded credentials and paths), and every timing budget bounded by `MAX_TIMER_DELAY_MS`.

### packages/experimental/speech-to-text-sensevoice/src/worker.ts
The child entry: it parses `argv[2]`, reads `DSH_SPEECH_TOKEN`, **deletes the token from its own environment**, starts the loopback server, and prints exactly one readiness line to stdout. A failure before readiness writes only the message to stderr and exits 1 — because the host parses the first stdout line as readiness.

### packages/experimental/speech-to-text-sensevoice/src/index.ts
The plugin entry: it rejects relative paths and invalid origins **before** registering, publishes a disk/memory estimate, registers the provider on `ctx.speechToText` with the `preparation` and `transcribe` handles, and calls `worker.inspect()` so activation performs no download and loads no model.

### packages/experimental/speech-to-text-sensevoice/runtime/assets.json
The release-pinned asset lock: the int8 and fp32 SenseVoice ONNX files, `tokens.txt` and the Silero VAD file, each with an exact byte count, a SHA-256 and a revision-pinned Hugging Face `resolve` URL.

### packages/experimental/speech-to-text-sensevoice/tests/worker.spec.ts
The largest behavioural suite (36 named cases): worker warmth across recordings, manual download-source pinning (and the refusal to change an active task's source), standby wake-up without re-preparing, queue bounds, disposal joining running **and** waiting requests, idle stop and reload, cancellation retention, recovery after a provider error or an unexpected worker exit, safe download diagnostics published and cleared, and the process-range reclamation after an unexpected idle exit. Read the head and the full 36-case index.

### packages/experimental/speech-to-text-sensevoice/tests/installer.spec.ts
Vitest for `prepareRuntime` / `inspectRuntime` with a mocked asset lock: verified caches restored on every activation with no download and no worker, a missing or corrupted model/tokens/vad requiring preparation, platform-specific preparation, FP32 selection, cancellation, and source fallback on http/network/integrity but **not** on a local storage failure.

### packages/experimental/speech-to-text-sensevoice/tests/runtime.spec.ts
Vitest for `downloadAsset`: verified files published and reused offline, altered downloads and HTTP failures leaving **no** partial file, credentials and query strings absent from the public message, the redirected source reported, and explicit cancellation distinguished from a preparation deadline.

### packages/experimental/speech-to-text-sensevoice/tests/model-sources.spec.ts
Vitest for `orderModelSources` with controlled response barriers: first success wins, a faster HTTP error is ignored, configured order survives total failure, the probe deadline bounds without cancelling the download, and body cleanup is awaited before the result resolves.

### packages/experimental/speech-to-text-sensevoice/tests/protocol.spec.ts
Vitest for `readReady` / `readTranscript`: a fragmented readiness frame then listener detachment, malformed / oversized / invalid-port frames, exit-before-readiness, spawn failure, cancellation (including a primitive abort reason), a missing stdout, and marked input failures classified only on status 400/413.

### packages/experimental/speech-to-text-sensevoice/tests/provider-queue.spec.ts
Vitest for the bounded queue: a recording submitted during worker startup joins the queue, a third recording is refused with "queue is full", and a waiting recording's cancellation stops it from ever reaching the worker (the request file shows only the first language).

### packages/experimental/speech-to-text-sensevoice/tests/provider.spec.ts
Vitest for the plugin: lazy registration with no transcription until asked, the exact provider info and setup estimate, refusal of relative runtime/model/cache paths, and rejection of invalid download-source configuration (empty origins, an origin with a path, an origin with credentials, `file://`, a zero probe timeout, a probe timeout past `MAX_TIMER_DELAY_MS`).

### packages/experimental/speech-to-text-sensevoice/tests/process-server.spec.ts
Vitest for the private server: 401 on a missing or wrong token, 404 on an unknown path, 413 on an out-of-range content-length (both over and under), a 200 transcript, and 400 vs 500 for a `SpeechInputError` versus a native failure.

### packages/experimental/speech-to-text-sensevoice/tests/inference.spec.ts
Vitest for `createTranscriber` with a mocked sherpa-onnx: language changes carried into the native config, VAD buffers copied for Electron, invalid language / malformed WAV / oversize rejected, and the onset restoration applied to the first segment only and bounded by the padding window.

### packages/experimental/speech-to-text-sensevoice/tests/download-error.spec.ts
Vitest for `classifyDownloadFailure`: eleven nested error codes mapped to their reason, a `TimeoutReason` recognised as a timeout, a bare `fetch failed` as network, an unknown code as `unknown`, a non-Error as `unknown`, and a cyclic cause chain terminating.

### packages/experimental/speech-to-text-sensevoice/tests/worker-entry.spec.ts
Spawns the real worker entry with the tsx ESM hook and asserts six pre-readiness failure modes each exit 1 with an **empty stdout**, a newline-terminated stderr carrying only the message, and no stack trace.

### packages/experimental/speech-to-text-sensevoice/tests/worker-source.fixture.ts
One-line fixture importing the shared `worker.fixture.mjs` so the source-launch test and the built-launch test share one protocol peer.

### packages/experimental/speech-to-text-sensevoice/tests/worker.fixture.mjs
The protocol fixture replacing the native recognizer: a real loopback HTTP server that honours the bearer token, appends each request's language to a file, and can hold, crash, or answer `invalid-input` depending on the language.

### packages/experimental/speech-to-text-sensevoice/tests/local.e2e.ts
Opt-in real-inference e2e, gated on `DSH_SPEECH_E2E_ROOT` / `DSH_SPEECH_E2E_AUDIO`: prepares a real recognizer, transcribes cold then warm, asserts identical text, rejects an unsupported language, and asserts the worker was spawned only once.

### packages/experimental/speech-to-text-sensevoice/README.md
Package reference: the ONNX/Silero CPU provider, the model-origin probe policy, the source list, and the limits (CPU only; INT8 ≈239 MB vs FP32 ≈938 MB; Windows ARM64 and Linux musl unverified; model memory exceeds file size).

### packages/experimental/speech-to-text-sensevoice/README.zh.md
Chinese translation of the SenseVoice provider page.

### packages/experimental/speech-to-text-sensevoice/README.i18n.yaml
Per-section bilingual hash record for the speech-to-text-sensevoice README.

### packages/experimental/speech-to-text-sensevoice/package.json
Manifest: depends on `sherpa-onnx-node` 1.13.8 and `zod` 4.4.3, ships `runtime/assets.json`, and exports `./worker` separately so the child process can be launched from the packaged `lib/worker.js`.

### packages/experimental/speech-to-text-sensevoice/locale/en.json
Plugin-manager locale entry: title "Local SenseVoice recognition".

### packages/experimental/speech-to-text-sensevoice/locale/zh.json
Chinese locale entry: title "SenseVoice 本地识别".

### packages/experimental/speech-to-text-sensevoice/tsconfig.json
TS project with references to util/timeout, vendor/cordis, the speech-to-text package and subprocess.

### packages/experimental/speech-to-text-sensevoice/tsdown.config.ts
tsdown config building **two** ESM entries (`index` and `worker`) so the packaged worker can be launched as its own process.

### packages/experimental/speech-to-text/src/index.ts
- Purpose: The `SpeechToText` service — a registry of named transcription providers.
- Key abstractions: `register(provider)`, `resolve(request)`, `transcribe(spec, signal)`, `prepare(id, options)`, `cancelPreparation(id)`, `snapshot()`, and the `follow(caller)` async generator.
- Data flow: `resolve` pins the provider **instance** plus the recording and the language; `transcribe` re-checks that the pinned instance is still the registered one and combines the caller's signal with the registration's lifetime signal. `configure(patch)` writes the changed fields into the plugin's profile entry through the `settings` service, and the live instance reads the updated volatile values **without remounting**.
- Non-obvious design decisions: `follow()` is an **async generator** yielding complete `SpeechSnapshot` values; a slow reader coalesces intermediate progress rather than being flooded. Preparation is **Host-owned**, not observer-owned — closing an observer never cancels preparation.
- Edge cases / failure handling: A duplicate provider id throws and does **not** replace the original. The registration disposer closes admission, aborts accepted requests and joins provider settlement. `resolve` rejects a language the selected provider does not accept, before transcription. `transcribe` throws "Resolved speech provider is no longer registered" if the registration moved.
- Surprising: There is **no fallback** — a failed provider never silently sends the audio to another recognizer, and no audio is uploaded.

### packages/experimental/speech-to-text/src/types.ts
Provider-neutral types: `SpeechProviderInfo` (no credentials, no filesystem paths), the `SpeechPreparationState` union, `SpeechDownloadFailure` (URLs without credentials or query strings), the `SpeechPreparation` control interface, and the `SpeechRequest` → `SpeechSpec` resolve/transcribe split. The doc comments are explicit that byte totals describe downloads, never estimated installation percentages.

### packages/experimental/speech-to-text/src/wave.ts
`validateWave(audio, maxDurationSeconds)`: a canonical 16 kHz mono PCM16 WAV header check (the `RIFF`/`WAVE`/`fmt `/`data` tags, the exact chunk sizes, the even sample count) plus a duration bound, shared by the Remote consumer and the native recognition process.

### packages/experimental/speech-to-text/tests/configuration.spec.ts
Boots a **real** profile with the Loader, the Config Editor and the Settings service, changes the language and provider preferences, asserts the plugin fiber is **not** remounted, and asserts the saved `cordis.patch.yml` plus a restart restoring the same selection.

### packages/experimental/speech-to-text/tests/service.spec.ts
Vitest for the service: preparation shared across observers and **not** cancelled when observation ends, the provider and language writes, provider withdrawal, and the registration lifetime behaviours. Read the first 60 lines and the surrounding case names.

### packages/experimental/speech-to-text/tests/fixtures/selection.patch.yml
Three-row profile patch inserting config-editor, settings and the speech-to-text service with `defaultProvider: sensevoice-local`.

### packages/experimental/speech-to-text/README.md
Package reference: `resolve()` captures the provider instance, `transcribe()` rejects a withdrawn registration, a registration disposer closes admission/aborts/joins, **no fallback selects a different recognizer or uploads audio**, and `defaultProvider`/`language` are volatile Config fields persisted through the settings service.

### packages/experimental/speech-to-text/README.zh.md
Chinese translation of the speech-to-text service page.

### packages/experimental/speech-to-text/README.i18n.yaml
Per-section bilingual hash record for the speech-to-text README.

### packages/experimental/speech-to-text/package.json
Manifest: exports `.`, `./types` and `./wave`; peer-deps on `dsh-settings` and an **optional** `cordis-plugin-loader` (so the service works outside the Loader).

### packages/experimental/speech-to-text/locale/en.json
Plugin-manager locale entry: title "Speech recognition".

### packages/experimental/speech-to-text/locale/zh.json
Chinese locale entry: title "语音识别".

### packages/experimental/speech-to-text/tsconfig.json
TS project with references to util/brand, vendor/schemastery, vendor/cordis and settings/settings.

### packages/experimental/speech-to-text/tsdown.config.ts
tsdown config bundling `lib/types/index.js` to `lib` as ESM/node/es2024 with `dts: false`.

### packages/experimental/tool-session-query/src/workspace-access.ts
- Purpose: Caller identity, workspace authorization, and visible-lineage projection.
- Key abstractions: `callerOf(exec, ctx)`, `targetId`, `authorizeTarget`, `recordAuthorized` / `headerAuthorized`, `assertObservedTargetAuthorized`, `authorizeSessionIds`, `readTitles` / `readTitle`, `authorizeDescendants`.
- Data flow: The caller is derived from `exec.agent` (its session id, header and the `turnBoundary` projection). A target is authorized only if its `cwd` **exactly** equals the caller's; the check is re-run against the header observed with each result. Ancestors are walked until the first unauthorized record, which becomes a boundary marker; descendant subtrees that are not authorized are pruned to `null`.
- Non-obvious design decisions: **Authority is derived from the caller, never from the model.** A caller with no `cwd` may inspect only itself. Unauthorized records are rendered as *markers* (`[outside workspace boundary]`, `[outside workspace subtree]`) with **no hidden id**, so a model cannot infer the shape of what it may not see.
- Edge cases / failure handling: `assertObservedTargetAuthorized` throws if the observed header's id differs from the requested target or its cwd moved — a TOCTOU re-check. A title observation that is *rejected* becomes an "untitled (title unavailable: <code>)" view, but an *unauthorized* one is re-thrown as a hard refusal.
- Surprising: The descendant projection is built with an explicit linked-list frame stack rather than recursion, so a deep lineage cannot blow the stack.

### packages/experimental/tool-session-query/src/service-boundary.ts
- Purpose: The single model-boundary error sanitizer for every trusted `ctx.sessionQuery` call.
- Key abstractions: `SAFE_SESSION_QUERY_FAILURES` (an exhaustive `satisfies Record<SessionQueryErrorCode, …>` table), `call(ctx, signal, operation, invoke)`, `sanitizeError(ctx, operation, error)`.
- Data flow: `call` aborts before and after the invoke, and converts any failure through `sanitizeError`, which logs the **full** diagnostic to the internal logger and then maps the service error code to a fixed model-safe message. Any code not in the table, and anything unprintable, collapses to `SESSION_QUERY_TOOL_FAILED`.
- Non-obvious design decisions: The table is `satisfies Record<SessionQueryErrorCode, …>` so a new service error code **cannot be added without** a model-safe mapping — the type system enforces the completeness. `renderFullError` walks the `cause` chain with a visited set, so a cyclic cause graph is logged rather than hanging.
- Edge cases / failure handling: Caller cancellation is preserved exactly (it is re-thrown before sanitization). The `SESSION_QUERY_TOOL_UNAUTHORIZED` code is re-raised verbatim because it is tool-owned, not service-owned.
- Surprising: The model never sees a stack, a path, or a service diagnostic — only a code and a sentence.

### packages/experimental/tool-session-query/src/operations.ts
- Purpose: The five tool operation workflows over the session-query service.
- Key abstractions: `executeSessionSearch`, `executeEventSearch`, `executeSessionTrace`, `executeEventTrace`, `executeEventRead`, and the shared `collectPages` pager.
- Data flow: A session search filters by the caller's `cwd`, optionally pre-authorizes requested parent ids, and pages internally until `maxResults` or exhaustion. An event search authorizes the target first, then pages. Traces authorize the target, then re-check the observed header, then walk ancestors and descendants.
- Non-obvious design decisions: **`collectPages` hides the cursor from the model.** It drains provider pages, caps the authorized count, and throws `SESSION_QUERY_INVALID_CURSOR` if the provider repeats a continuation cursor — so a broken provider fails loudly instead of looping. A current-session event search is capped at `stepStartSeq - 1`, so the model cannot see the step that issued the call.
- Edge cases / failure handling: A missing parent id and a cross-workspace parent id behave **identically** (both are simply not authorized), so a model cannot probe for the existence of a session outside its workspace. When the cap is hit the presentation says "Result cap reached. Narrow the query or add filters" — the model is told to refine, not handed a cursor.
- Surprising: The search *excludes the caller session* — a model searching "what did I do" gets other sessions, and its own history is available through the session tools instead.

### packages/experimental/tool-session-query/src/input.ts
- Purpose: The model-facing argument schemas and the normalization of every value.
- Key abstractions: `sessionSearchParameters`, `eventSearchParameters`, `targetSessionParameter`, `buildSessionFilters`, `buildEventFilters`, `normalizeQuery`, `sequenceRange`, `assertNonNegativeSafeInteger`.
- Data flow: A query is trimmed and whitespace-collapsed, and rejected if empty or if it contains a NUL. Sequence bounds must be non-negative safe integers with `from <= to`. ISO-8601 timestamps are parsed by a hand-written regex (not `Date.parse`) into a millisecond value plus the exact sub-millisecond remainder.
- Non-obvious design decisions: The timestamp machinery keeps the **exact** decimal remainder and compares it digit by digit, then maps a bound to the adjacent representable double (`nextUpFinite` / `nextDownFinite` via raw float64 bit arithmetic) so an inclusive bound is not widened into a range it should not cover, and a sub-millisecond difference is not collapsed.
- Edge cases / failure handling: An empty array for any optional filter is rejected ("must contain at least one value when supplied") rather than silently meaning "no filter". A platform parser that cannot produce a finite value is rejected.
- Surprising: The regex requires an explicit `Z` or a numeric offset — a naive local timestamp is refused, because "inclusive timezone-qualified" is the contract.

### packages/experimental/tool-session-query/src/presentation.ts
- Purpose: Model text rendering and the generic tool-call cards.
- Key abstractions: `formatSessionSearch`, `formatEventSearch`, `formatSessionTrace`, `formatEventTrace`, `formatEventRead`, and the four `present*Call` functions.
- Data flow: A search hit renders as a numbered block with the session id, title, creation time, parent (or `root` / `[outside workspace]`), availability (`live`, `persisted`, `unavailable`) and the best-match snippet. A trace renders ancestors nearest-first and a depth-indented descendant tree. An event read renders the unabridged target event as fenced JSON plus neighbour summaries.
- Non-obvious design decisions: The renderers **never truncate** — there is no second truncation format; the generic spill policy owns bounded inline output. The `present*` functions return a `GenericCallView` with a `kind` of `search` / `read`, so the UI can pick a card without knowing the tool.
- Edge cases / failure handling: A neighbour event with no semantic text renders "(no semantic text)" rather than an empty line, so the model can tell "no text" from "missing".
- Surprising: The `event_read` output is a **fenced JSON block of the whole event** — the model gets the exact stored record, not a summary.

### packages/experimental/tool-session-query/src/index.ts
- Purpose: The plugin entry — the five tool registrations and the model guidance.
- Key abstractions: `Config` (`maxSearchResults` default 100, `searchTimeoutMs` default 30,000), the `PROMPT_TEXT` section, and the five `defineTool` registrations.
- Data flow: A system-prompt section named `tool:session-query` teaches the search-then-trace workflow; each tool declares its parameters, a text output, a timeout, an `isConcurrencySafe` predicate and a presenter.
- Non-obvious design decisions: The three **search** tools are generation-bound (not concurrency-safe) while the three **observation** tools are `isConcurrencySafe: () => true` — reads may run in parallel, searches may not. The prompt text explicitly names the follow-up: "Follow a useful hit with `session_trace`, `session_event_trace`, or `session_event_read`".
- Edge cases / failure handling: `resolveConfig` re-validates the numbers even when a caller invokes `apply()` without Loader normalization, and throws a `TypeError` naming the field.
- Surprising: The model is given **no** page size, offset, limit or cursor parameter at all — the only knobs are the deployment's `maxSearchResults` and `searchTimeoutMs`.

### packages/experimental/tool-session-query/tests/tool-session-query.spec.ts
The 84 KB unit suite (60 named cases): tool registration and the prompt section, config validation, exact timestamp bounds (including the "maps exact same-millisecond decimal bounds to adjacent numeric values without collapsing the interval" case), workspace authority and lineage redaction, hidden-vs-nonexistent parent guesses being indistinguishable, pagination and the cap, cancellation precedence over a pending trace, and the trace/read rendering. Read the head and the complete describe/it index.

### packages/experimental/tool-session-query/tests/sqlite-integration.spec.ts
End-to-end against the **real** SQLite provider: searching live prior-step history and a persisted same-workspace log through the registered tools, with a real session store, the turn-boundary projection and the JSONL persistence backend. Read the first 45 lines and the harness.

### packages/experimental/tool-session-query/README.md
Package reference: the five cursor-free read-only tools, exact `cwd` equality for cross-session authority, the search excluding the caller session, a capped result that asks the model to narrow its query, the one error sanitizer, and "**No second truncation format**" — results stay complete and the generic spill policy owns bounded inline output.

### packages/experimental/tool-session-query/README.zh.md
Chinese translation of the tool-session-query page.

### packages/experimental/tool-session-query/README.i18n.yaml
Per-section bilingual hash record for the tool-session-query README.

### packages/experimental/tool-session-query/package.json
Manifest: peer-deps on dsh-agent, dsh-llm, dsh-session, dsh-session-projection, dsh-session-query, dsh-system-prompt, dsh-timeout and dsh-tools; dev-deps on the real SQLite session-query engine and the tool-call timeout policy.

### packages/experimental/tool-session-query/tsconfig.json
TS project with references to llm/llm, core/session, core/tools, core/system-prompt, session-query/session-query, util/timeout, session/session-projection and core/agent.

### packages/experimental/tool-terminal/src/index.ts
- Purpose: Six model-facing persistent terminal tools.
- Key abstractions: `Config` (`enableRunInBackground`, `maxResultBytes`), the `finalizeContent` re-bounder, the `SESSION_STATUS_SCHEMA` / `SESSION_SNAPSHOT_SCHEMA` output schemas, and the six registrations.
- Data flow: `terminal_open` resolves the session working directory and spawns an owner-scoped session; `terminal_send` either waits for a foreground outcome or starts a `pty-send` job in `ctx.jobs`; `terminal_read` pages retained output; `terminal_signal` delivers an allowed signal; `terminal_close` waits for the owned process tree to end; `terminal_list` lists the caller's sessions.
- Non-obvious design decisions: **Owner identity is the exact tool-execution Agent** (`requireAgent(exec.agent)`), which is what prevents one agent from operating another's sessions. Every result passes through `finalizeContent`, which re-bounds the text to `maxResultBytes` *after* the tool's own rendering. The system-prompt section says outright: "**An inferred_idle or timeout result does not prove the foreground command exited.**"
- Edge cases / failure handling: A background send fails **before writing input** if the jobs surface is absent. The `terminal_signal` schema offers SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP but the description states a shell-targeted SIGKILL is rejected (use `terminal_close`). An aborted foreground send throws "terminal send aborted".
- Surprising: The `presentCall` for a foreground send returns the `terminal` card (not `generic`) so the UI can render a live terminal, and the fallback strings are kept aligned with the Web locale keys `terminal.sendInput` and `terminal.session`.

### packages/experimental/tool-terminal/src/render.ts
- Purpose: Model and UI rendering for persistent terminal tool results, with byte-exact bounding.
- Key abstractions: `boundTerminalText`, `renderSpawn`, `renderSend`, `renderSendRead`, `renderRead`, `renderList`.
- Data flow: Each renderer composes a body plus a fixed metadata suffix (`[wait: <reason>]`, `[session: …]`, `[lines: a-b of n]`, `[output truncated]`) and then fits the whole thing into `maxBytes`.
- Non-obvious design decisions: `boundBodyWithSuffix` **reserves the metadata bytes first** and truncates the body to what is left, so a truncated result still carries the wait reason and session status that explain it. `TextRetainer` performs the cut on a UTF-8 boundary.
- Edge cases / failure handling: When the fixed suffix alone exceeds the cap, the suffix itself is retained tail-first — the metadata wins over the body.
- Surprising: `renderSendRead` adds the truncation marker on its own line only when the delta did not already end with one, so a background job's incremental output is not double-marked.

### packages/experimental/tool-terminal/src/background.ts
`sendSource(operation)` adapts the terminal's consuming send reader to the generic job registry's pull source: the reader has no offsets of its own, so the source counts the bytes it delivered to keep the registry cursor monotonic, and it binds lazily because the send only starts inside the job starter (a read before that point delivers nothing).

### packages/experimental/tool-terminal/tests/tools.spec.ts
Tool-level suite against a stub terminal backend: owner isolation between two agents, the background job path, the foreground wait reasons, the output bound, and the job source adapter. Read the first 45 lines and the stub backend.

### packages/experimental/tool-terminal/tests/loader-composition.spec.ts
Boots a **real** `cordis.yml` through the Loader with the real bash terminal backend and proves shell state survives across separate tool calls — an exported variable and a changed `cwd` both persist between two `terminal_send` calls.

### packages/experimental/tool-terminal/tests/render.spec.ts
Vitest for the renderers: spawn with and without a name or MOTD, every send status shape, the history and list shapes, and byte-bound assertions that the metadata markers survive truncation at tight caps (e.g. a 64-byte send that still contains `[wait: stdin_read]`).

### packages/experimental/tool-terminal/README.md
Package reference: the six tools, owner isolation, the guidance to prefer one-shot tools for bounded work, the background-send flow via `job_output` / `job_kill`, and the honest statement that `inferred_idle` or `timeout` never proves the foreground command exited.

### packages/experimental/tool-terminal/README.zh.md
Chinese translation of the tool-terminal page.

### packages/experimental/tool-terminal/README.i18n.yaml
Per-section bilingual hash record for the tool-terminal README.

### packages/experimental/tool-terminal/package.json
Manifest: peer-deps on dsh-terminal, dsh-output-retention, dsh-jobs, dsh-tools, dsh-system-prompt and dsh-working-directory; dev-deps on the real terminal-bash backend and the jobs stack.

### packages/experimental/tool-terminal/tsconfig.json
TS project with references to util/output-retention, terminal/terminal, core/agent, llm/llm, core/system-prompt, core/tools, jobs/jobs and session/working-directory.

### packages/experimental/tool-ralph/src/index.ts
- Purpose: The `ralph` tool — a foreground fresh-agent loop over the workflow and subagent seams.
- Key abstractions: `RALPH_SCRIPT` (a fixed, deployment-owned workflow script), `RALPH_META`, the `Config` (`subagentProvider`, `maxRounds`, `maxHandoffChars`, `maxResultChars`), and the defensive decoders `readReport` / `readRunResult`.
- Data flow: The tool starts a workflow run carrying the fixed script, the args, the provider route and `maxTotalAgents`; the script loops, opening one fresh structured-output child per round whose prompt contains the immutable objective, the round counter, the shared-workspace instruction and the previous bounded report. The child's structured report is validated inside the script *and* again at the consumer boundary; a `complete` / `blocked` / `budget-limited` result is returned.
- Non-obvious design decisions: **The loop is deployment-owned; the model supplies data only.** The model cannot alter the loop, the provider route, the schema or the handoff validation. `requireFreshProvider` refuses a provider that does not support structured output **or** that reports `inheritsParentContext: true` — a Ralph round must be genuinely fresh. The prompt tells each round to "treat the previous report only as a bounded handoff; confirm it against the workspace" — the workspace is the long-term memory, the report is only a hint.
- Edge cases / failure handling: An invalid or oversized report **fails the workflow** rather than being truncated or mistaken for cap exhaustion. A `round-failed` outcome is an error naming the failed round and retaining the last successful handoff. A non-clean workflow finish (cancelled / error) is never a partial success. The parent's abort signal cancels the workflow run.
- Surprising: The prompt section says "Completion and blockers are **worker reports, not independent evaluation**" — the tool does not present a model's self-report as certification.

### packages/experimental/tool-ralph/tests/tool-ralph.spec.ts
Stubbed-workflow-engine unit suite: the recorded `WorkflowStartRequest` (script, args, `subagentProvider`, `maxTotalAgents`, `parent`), the cancellation path, the malformed-report rejections, the round cap, and a non-clean stop reason becoming an error. Read the head and the harness.

### packages/experimental/tool-ralph/tests/integration.spec.ts
Mounts the **real** Ralph stack (agent loop, PTC workflow engine, in-process spawn subagent, JSONL persistence) with a `MockAdapter` script and drives the tool end to end through the workflow engine. Read the first 40 lines and the harness setup.

### packages/experimental/tool-ralph/README.md
Package reference: a fixed foreground loop, one fresh child per round, only the previous bounded report crossing rounds, the deployment `maxRounds` acting as both default and ceiling, the provider requirements, and the explicit statement that worker reports are not independently verified.

### packages/experimental/tool-ralph/README.zh.md
Chinese translation of the tool-ralph page.

### packages/experimental/tool-ralph/README.i18n.yaml
Per-section bilingual hash record for the tool-ralph README.

### packages/experimental/tool-ralph/package.json
Manifest: peer-deps on dsh-agent, dsh-llm, dsh-subagent, dsh-system-prompt, dsh-tools and dsh-workflow; dev-deps on the real `dsh-workflow-ptc` and `dsh-subagent-spawn-in-process` providers.

### packages/experimental/tool-ralph/locale/en.json
Plugin-manager locale entry: title "tool-ralph" only — no description key.

### packages/experimental/tool-ralph/locale/zh.json
Chinese locale entry: title "Ralph 迭代工具" with a description naming the per-round fresh subagent and the bounded previous report.

### packages/experimental/tool-ralph/tsconfig.json
TS project with references to core/agent, llm/llm, subagent/subagent, core/system-prompt, core/tools and workflow/workflow.

### packages/experimental/tool-worktree/src/index.ts
Registers the `create_worktree` tool: a two-parameter schema (`name`, `from`), a typed result (`path`, `branch`, `baseCommit`, `repositoryRoot`), an execute that **requires** `exec.agent` and delegates to `ctx.worktrees.create(exec.agent, args, exec.signal)`, and a pure generic presenter. The tool holds no state of its own.

### packages/experimental/tool-worktree/tests/loader-composition.spec.ts
Real Loader composition against a **real git repository**: creates a repo, commits, drives `create_worktree` through the tools runtime, asserts the canonical record (`path`, `branch`, `baseCommit`, `repositoryRoot`), asserts the session's working directory changed, asserts the "requires a calling agent" failure, and asserts the tool is unregistered when its fiber is disposed.

### packages/experimental/tool-worktree/README.md
Bundle page: the Git Worktrees switch, the `create_worktree` contract and the `working_directory` escape, the KV-cache note that an unchanged schema retains the prefix while calls append after prior history, and the limits (a calling Agent is required; creation only).

### packages/experimental/tool-worktree/README.zh.md
Chinese translation of the tool-worktree page.

### packages/experimental/tool-worktree/README.i18n.yaml
Per-section bilingual hash record for the tool-worktree README.

### packages/experimental/tool-worktree/cordis.patch.yml
Two-row patch inserting the experimental-worktree runtime and the tool-worktree consumer — the whole "optional capability" is two rows.

### packages/experimental/tool-worktree/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml`, an icon, and a single dependency on `dsh-experimental-worktree`; dev-deps include the real agent loop and working-directory service.

### packages/experimental/tool-worktree/locale/en.json
Plugin-manager locale entry: title "Git Worktrees".

### packages/experimental/tool-worktree/locale/zh.json
Chinese locale entry: title "Git 工作树".

### packages/experimental/tool-worktree/icon.svg
36×36 SVG bundle glyph: a branch line with two square nodes on the trunk and a third leaf node on the branch.

### packages/experimental/tool-worktree/tsconfig.json
TS project with references to vendor/cosmokit, vendor/cordis, core/tools and packages/worktree.

### packages/experimental/session-title-all-prompts-llm/src/index.ts
- Purpose: The `all-prompts` session-title provider.
- Key abstractions: `Config` (required `targetWords` / `targetCjkCharacters` plus the shared execution controls), `systemPrompt(config, hasCurrentTitle)`, `frameMessages`, `titleFromOutput`, `titleFromResponse`.
- Data flow: On a refresh, the provider collects the eligible human messages' `seq`s, decides whether a `currentTitle` anchor exists (only a **provider**-sourced title anchors, not a user-pinned or fallback one), calls the shared `executeSessionTitleLlm` with its own system and input, and returns `{ title, messageSeqs, model }`.
- Non-obvious design decisions: The messages are framed as **JSON** so user text cannot break a structural delimiter. The system prompt gains a stability block only when a title is anchored: keep the existing wording *exactly* unless the topic materially changed, and "keeping its exact wording takes priority over the target length". The reasoning effort is chosen as the route's **least** supported one.
- Edge cases / failure handling: A `tool-calls` or `max-tokens` finish is rejected outright, and a response whose only block is a *reasoning* block produces "no text" — the title is never synthesised from thinking content. `titleFromOutput` takes the first non-empty line and strips whole-line asterisk emphasis, but keeps emphasis **inside** a longer line (`**a** and **b**` survives).
- Surprising: The provider's own prompt and parsing policy are **not** shared with the first-prompt provider — only the execution module is; the two strategies diverge on purpose.

### packages/experimental/session-title-all-prompts-llm/tests/provider.spec.ts
Vitest for the title provider: `currentTitle` anchored only for an accepted provider title, seeded history plus the latest prompt with the logged request route inherited, the least-supported reasoning effort selected, five title-parsing cases, rejection of tool-call and max-tokens finishes, positive-integer config validation with unknown-key rejection, and verbatim preservation of an accepted title across a follow-up prompt.

### packages/experimental/session-title-all-prompts-llm/README.md
Package reference: the `all-prompts` cadence, a new revision after each new human prompt, a newer revision aborting and superseding older work, seeded history and child-session prompts, and the KV-cache note that the main request's cache is untouched but the auxiliary input grows after each prompt so provider-side cache reuse ends at the first changed JSON token.

### packages/experimental/session-title-all-prompts-llm/README.zh.md
Chinese translation of the all-prompts title provider page.

### packages/experimental/session-title-all-prompts-llm/README.i18n.yaml
Per-section bilingual hash record for the session-title-all-prompts-llm README.

### packages/experimental/session-title-all-prompts-llm/package.json
Manifest: peer-deps on dsh-llm, dsh-session, dsh-session-title and dsh-session-title-llm; ships only `lib/index.js` and `lib/types`.

### packages/experimental/session-title-all-prompts-llm/tsconfig.json
TS project with references to util/values, llm/llm, session/session-title and session/session-title-llm.

### packages/experimental/skill-badge/src/index.ts
Registers the bundled `dsh-badge` skill provider on `ctx.skills`: one fixed candidate at `BUNDLED_SKILL_RANK`, the packaged `assets/` directory as the skill's resource base, and the body re-read from `assets/dsh-badge.md` on every `get()`. The provider is immutable, so discovery always succeeds with exactly one skill.

### packages/experimental/skill-badge/assets/dsh-badge.md
The skill body: the Shields.io badge URL, the linked and unlinked Markdown snippets, and the usage rules (upload the local PNG where remote images are unreliable, keep 121×20, place at the end, do not substitute colours or logos).

### packages/experimental/skill-badge/assets/dsh-badge.png
Binary PNG badge image (12,339 bytes) — **not read line by line**, because a raster has no line structure; see the Files-skipped entry below. What was established: the PNG signature is `89 50 4e 47 0d 0a 1a 0a` and the IHDR width/height read from the header bytes as 726×120, which is the same pair the package's own test pins (along with a SHA-256 of the shipped bytes). It is the asset a skill must upload where remote images cannot be fetched.

### packages/experimental/skill-badge/tests/skill-badge.spec.ts
Three cases: the exact catalog entry and its resource base, the icon being **byte-identical** to `badge-skill-bundle/icon.svg`, and the PNG's 726×120 dimensions plus a pinned SHA-256 of the shipped bytes.

### packages/experimental/skill-badge/README.md
Package reference: an immutable bundled skill provider registering one fixed candidate at rank 600, the assets directory as the resource base, the body re-read on every load, and the limits (one fixed skill; the remote Markdown relies on Shields.io).

### packages/experimental/skill-badge/README.zh.md
Chinese translation of the skill-badge page.

### packages/experimental/skill-badge/README.i18n.yaml
Per-section bilingual hash record for the skill-badge README.

### packages/experimental/skill-badge/package.json
Manifest: exports the locale JSON, ships the `assets` directory, and declares no dependencies beyond the `dsh-skill` peer.

### packages/experimental/skill-badge/locale/en.json
Plugin-manager locale entry: title "DSH", description "Provide the official powered-by-DSH badge skill."

### packages/experimental/skill-badge/locale/zh.json
Chinese locale entry: title "DSH", description naming the official powered-by-DSH badge skill.

### packages/experimental/skill-badge/icon.svg
36×36 SVG glyph drawing the letters "dsh" as stroked paths inside a blue rounded rectangle.

### packages/experimental/skill-badge/tsconfig.json
TS project with references to vendor/cordis and packages/skill/skill.

### packages/experimental/inspector-profile/cordis.patch.yml
Two-row patch inserting the experimental-inspector (with `captureFetch: true`) and the session-inspector plugins; the whole bundle is therefore just a profile patch.

### packages/experimental/inspector-profile/src/index.ts
Empty 90-byte module whose only content is a doc comment saying the runtime composition lives in `cordis.patch.yml`; it exists to satisfy the package entry point.

### packages/experimental/inspector-profile/tests/profile.spec.ts
Asserts the bundle manifest's shape (public publish access, the `dsh.bundle.patch` path, the two workspace dependencies) and parses `cordis.patch.yml` with the Loader's `entryListSchema` to pin the exact inserted rows.

### packages/experimental/inspector-profile/README.md
Bundle page: the Developer Tools switch in Plugin Manager, the Session Log view, the `Ctrl/Cmd+Shift+.` NodeJS Inspector shortcut, and the limits (Web only; enabling it starts unredacted Host fetch capture and local code execution).

### packages/experimental/inspector-profile/README.zh.md
Chinese translation of the inspector-profile bundle page.

### packages/experimental/inspector-profile/README.i18n.yaml
Per-section bilingual hash record for the inspector-profile README.

### packages/experimental/inspector-profile/package.json
Bundle manifest declaring `dsh.bundle.patch: ./cordis.patch.yml`, public publish access, the two inspector dependencies and the shipped file whitelist (icon.svg, locale, lib, cordis.patch.yml).

### packages/experimental/inspector-profile/locale/en.json
Plugin-manager locale entry: title "Developer Tools", description naming raw session data, grouped chat messages and the NodeJS backend.

### packages/experimental/inspector-profile/locale/zh.json
Chinese locale entry: title "开发者工具" with the same description.

### packages/experimental/inspector-profile/icon.svg
36x36 SVG bundle glyph: a blue data panel behind a magnifying-lens cutout, filled with two linearGradients; pure vector art, no logic.

### packages/experimental/inspector-profile/tsconfig.json
TS project: `rootDir src`, references vendor/cordis and the inspector host tsconfig.

### packages/experimental/plugin-market-bundle/cordis.patch.yml
Inserts the plugin-market Host service row — disabled via a `!!js "!ctx.get('profileContext')"` expression when there is no profile — and the ui-plugin-market browser row.

### packages/experimental/plugin-market-bundle/src/index.ts
Empty 103-byte module; the doc comment states the runtime rows live in cordis.patch.yml.

### packages/experimental/plugin-market-bundle/README.md
Bundle page: the Plugins > More > Custom plugin markets switch, the Installed/Discover tabs, and the KV-cache note that switching the bundle on or off adds or removes one tool schema in Creator sessions and therefore changes the cached request prefix of later requests.

### packages/experimental/plugin-market-bundle/README.zh.md
Chinese translation of the plugin-market-bundle page, including the same KV-cache-effect paragraph.

### packages/experimental/plugin-market-bundle/README.i18n.yaml
Per-section bilingual hash record for the plugin-market-bundle README.

### packages/experimental/plugin-market-bundle/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml`, dependencies on dsh-plugin-market and dsh-client-ui-plugin-market, and the icon/locale/lib/patch file whitelist.

### packages/experimental/plugin-market-bundle/locale/en.json
Plugin-manager locale entry: title "Custom plugin markets", describing the added Discover tab.

### packages/experimental/plugin-market-bundle/locale/zh.json
Chinese locale entry: title "自定义插件市场".

### packages/experimental/plugin-market-bundle/icon.svg
36x36 SVG bundle glyph: a 2x2 grid of rounded squares with a plus in the fourth cell, filled with a blue linearGradient.

### packages/experimental/plugin-market-bundle/tsconfig.json
TS project: `rootDir src`, `outDir lib/types`, a single reference to vendor/cordis.

### packages/experimental/plugin-market-bundle/tsdown.config.ts
tsdown config bundling lib/types/index.js to lib as ESM/node/es2024 with dts: false and clean: false.

### packages/experimental/ralph-bundle/cordis.patch.yml
Inserts an isolated `optional-ralph` group (`isolate: { workflowEngine: true }`) holding dsh-workflow-ptc (provider `spawn`) and dsh-tool-ralph (`subagentProvider: spawn`, `maxRounds: 64`).

### packages/experimental/ralph-bundle/src/index.ts
Empty 94-byte module; the doc comment states the runtime entries are declared in cordis.patch.yml.

### packages/experimental/ralph-bundle/README.md
Bundle page: the Ralph loops switch in Plugin Manager, the note that enabling or disabling registers or removes the global tools in the running Host so every Agent sees the change on its next request in every preset including minimal, and the isolated-workflowEngine detail.

### packages/experimental/ralph-bundle/README.zh.md
Chinese translation of the ralph-bundle page.

### packages/experimental/ralph-bundle/README.i18n.yaml
Per-section bilingual hash record for the ralph-bundle README.

### packages/experimental/ralph-bundle/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml` and dependencies on dsh-tool-ralph and dsh-workflow-ptc.

### packages/experimental/ralph-bundle/locale/en.json
Plugin-manager locale entry: title "tool-ralph" only (no description key).

### packages/experimental/ralph-bundle/locale/zh.json
Chinese locale entry: title "Ralph 迭代工具" with a description naming the per-round fresh subagent and the bounded previous report.

### packages/experimental/ralph-bundle/icon.svg
36x36 SVG bundle glyph: four quadrant arcs in two purple/blue gradients meeting at the centre.

### packages/experimental/ralph-bundle/tsconfig.json
TS project: `rootDir src` with a single reference to vendor/cordis.

### packages/experimental/session-search/cordis.patch.yml
Inserts an isolated `optional-session-search` group (`isolate: { sessionQuery: true }`) holding dsh-session-query-sqlite with a lazy `:memory:` index (`openAt: first-search`) and dsh-tool-session-query.

### packages/experimental/session-search/src/index.ts
Empty 97-byte module; the doc comment states the runtime entries are declared in cordis.patch.yml.

### packages/experimental/session-search/README.md
Bundle page: the Session search switch, the five global read-only tools, the lazily opened shared in-memory index, and the KV-cache note that toggling the bundle changes live Sessions' tool list and invalidates their cached request prefix once.

### packages/experimental/session-search/README.zh.md
Chinese translation of the session-search page, including the same KV-cache-effect paragraph.

### packages/experimental/session-search/README.i18n.yaml
Per-section bilingual hash record for the session-search README.

### packages/experimental/session-search/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml` and dependencies on dsh-session-query-sqlite and dsh-tool-session-query.

### packages/experimental/session-search/locale/en.json
Plugin-manager locale entry: title "Session search", describing the agent tools for earlier sessions.

### packages/experimental/session-search/locale/zh.json
Chinese locale entry: title "会话搜索".

### packages/experimental/session-search/icon.svg
36x36 SVG bundle glyph: a magnifying lens with a teal-to-blue gradient ring.

### packages/experimental/session-search/tsconfig.json
TS project: `rootDir src` with a single reference to vendor/cordis.

### packages/experimental/session-titles-bundle/cordis.patch.yml
Two-part patch: first `- id: session-title-llm / disabled: true` (disable the predecessor), then insert the all-prompts provider with targetWords 5, targetCjkCharacters 10, maxInputBytes 4096, maxOutputTokens 64, timeoutMs 60000.

### packages/experimental/session-titles-bundle/src/index.ts
Empty 112-byte module; the doc comment states the runtime entries are declared in cordis.patch.yml.

### packages/experimental/session-titles-bundle/README.md
Bundle page: the Conversation-following titles switch, the rule that the layer disables session-title-llm before selecting its replacement (and deselection restores the default), the 4096-byte title-input budget that rejects rather than truncates, and the guarantee that automatic updates preserve user-pinned titles.

### packages/experimental/session-titles-bundle/README.zh.md
Chinese translation of the session-titles-bundle page.

### packages/experimental/session-titles-bundle/README.i18n.yaml
Per-section bilingual hash record for the session-titles-bundle README.

### packages/experimental/session-titles-bundle/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml` and a single dependency on dsh-session-title-all-prompts-llm.

### packages/experimental/session-titles-bundle/locale/en.json
Plugin-manager locale entry: title "Conversation-following titles".

### packages/experimental/session-titles-bundle/locale/zh.json
Chinese locale entry: title "随对话更新的标题".

### packages/experimental/session-titles-bundle/icon.svg
36x36 SVG bundle glyph: a rounded chat bubble with a plus sign, filled with a blue gradient.

### packages/experimental/session-titles-bundle/tsconfig.json
TS project: `rootDir src` with a single reference to vendor/cordis.

### packages/experimental/terminal-bundle/cordis.patch.yml
Inserts an isolated `optional-persistent-terminals` group (`isolate: { terminals: true }`) with the terminal registry, the bash backend (disabled on Windows), a second bash backend configured `shellDialect: pwsh` (disabled off Windows), and the tool-terminal consumer.

### packages/experimental/terminal-bundle/src/index.ts
Empty 103-byte module; the doc comment states the runtime entries are declared in cordis.patch.yml.

### packages/experimental/terminal-bundle/README.md
Bundle page: the Persistent terminals switch, the isolated registry with the platform shell backend, the KV-cache note that toggling changes live Sessions' tool list and invalidates the cached request prefix once, and the limit that terminals belong to the creating Agent.

### packages/experimental/terminal-bundle/README.zh.md
Chinese translation of the terminal-bundle page.

### packages/experimental/terminal-bundle/README.i18n.yaml
Per-section bilingual hash record for the terminal-bundle README.

### packages/experimental/terminal-bundle/package.json
Bundle manifest with `dsh.bundle.patch: ./cordis.patch.yml` and dependencies on dsh-tool-terminal, dsh-terminal and dsh-terminal-bash.

### packages/experimental/terminal-bundle/locale/en.json
Plugin-manager locale entry: title "Persistent terminals".

### packages/experimental/terminal-bundle/locale/zh.json
Chinese locale entry: title "持久终端".

### packages/experimental/terminal-bundle/icon.svg
36x36 SVG bundle glyph: a blue chevron and an underscore forming a shell prompt.

### packages/experimental/terminal-bundle/tsconfig.json
TS project: `rootDir src` with a single reference to vendor/cordis.

## Ideas worth stealing

### Agent loop and tool-calling flow

- **"Adding context is not a veto" — delegate first, then fold your context onto the downstream decision** - `packages/experimental/hooks-claude-code/src/index.ts:234` (and the twin at `:262` for `tools/post-execute`) - A hook that only wants to *add* context still calls `await next()` **before** folding its sourced message into the downstream decision, so a later policy listener can still reject or rewrite the turn. August's own approval/sandbox listeners are exactly the "later listener" this protects; the pattern makes adding a policy layer composable instead of ordering-dependent.
- **A blocking `Stop` hook steers rather than errors** - `packages/experimental/hooks-claude-code/src/index.ts:281` - The bridge maps a denied `Stop` hook onto `agent.steer(createUserMessage(...))` at the turn-stopping boundary, so the machine observes pending input and runs another step. This is a reusable "the model must keep going" primitive with a model-visible reason attached, and the README states the honest limit: an unconditionally blocking hook force-continues every step unless it self-limits.
- **A fixed, deployment-owned loop the model can only feed** - `packages/experimental/tool-ralph/src/index.ts:88` - `RALPH_SCRIPT` is a workflow script owned by the deployment; the model's only inputs are `objective` and `maxRounds`. The prompt section then says the tool is for an *explicitly requested* Ralph loop, and that ordinary long-running work belongs to the goal tools. August's "bounded repeated delegation" needs exactly this separation: a loop the model cannot reshape, plus a prompt that names the alternative.
- **A "genuinely fresh" provider is checked, not assumed** - `packages/experimental/tool-ralph/src/index.ts:218` - `requireFreshProvider` refuses a subagent provider that lacks structured output **or** reports `inheritsParentContext: true`, before any round starts. August's delegation ceiling logic depends on a child that truly starts clean; making that a load-time check rather than a runtime surprise is the transferable part.
- **Serial execution chosen so the log stays legible** - `packages/experimental/hooks-claude-code/README.md:109` (design philosophy) - Matched hooks run serially in config order, purely so each `hook/invoked`/`hook/result` pair stays adjacent in the session log, while the decision fold is order-independent. August's activity-line rendering has the same constraint; naming the trade (serialised latency for a legible log) is worth copying verbatim.

### Reasoning / thinking content

- **A reasoning-only response is "no text", not a title** - `packages/experimental/session-title-all-prompts-llm/src/index.ts:136` - The provider rejects a response whose only block is a `reasoning` block ("produced no text") rather than mining thinking content for an answer. August's LLM helpers should have the same rule: reasoning is not an output surface.

### Prompt construction and caching

- **Frame user content as JSON so it cannot break a structural delimiter** - `packages/experimental/session-title-all-prompts-llm/src/index.ts:98` - `frameMessages` serialises the message array with `JSON.stringify` instead of interpolating it into prose. This is the cheapest possible prompt-injection hygiene for anything that embeds user text.
- **An anchored title is kept *verbatim*, and verbatim beats the length target** - `packages/experimental/session-title-all-prompts-llm/src/index.ts:88` - The stability block says "If it still accurately describes the main topic or task, return it exactly unchanged" and "Keeping its exact wording takes priority over the target length". August's memory/skill titles need the same explicit precedence rule, otherwise every re-summarisation churns the name.
- **Hook context is append-only and does not invalidate the reusable prefix** - `packages/experimental/hook-protocol/README.md:117` - The KV-cache section states exactly what a hook's contribution does to the cached prefix (nothing) and what it does to the token bill (data-dependent, resent until compaction). Every experimental package in this shard carries such a section, including the honest note that toggling a *bundle* changes the tool list and therefore invalidates the prefix **once**.
- **The tool list is the only thing a bundle toggle changes in the request** - `packages/experimental/session-search/README.md:75` - "Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once." A useful thing for August's plugin system to state out loud: enabling a feature is a one-time prefix invalidation, not a per-turn cost.

### Context window management

- **Only a bounded, validated report crosses a context boundary** - `packages/experimental/tool-ralph/src/index.ts:142` and `:273` - The handoff is a status-validated JSON report whose **serialized** length is checked against `maxHandoffChars`, both inside the workflow and again at the consumer boundary. The workspace is the long-term memory; the report is a hint the next round is told to *confirm against the workspace*. This is a compactable-context pattern for a long agentic run.
- **An oversized input is rejected, not truncated** - `packages/experimental/session-titles-bundle/README.md:76` - "The 4096-byte title-input budget includes the current generated title when supplied and rejects oversized input instead of truncating conversation history." Silent truncation of a budgeted input is a class of bug August has already met with the marker tables.

### Model-specific adaptations and fallbacks

- **One `mode` parameter absorbs the entire dialect difference** - `packages/experimental/hook-protocol/src/matcher.ts:18` - `CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/` decides whether a pattern is a literal alternation or a regex; Codex is always regex. One engine, one axis, and the divergence is *visible* in the test (the same `'Bash'` pattern matches `BashOutput` under Codex and not under Claude Code). August's multi-provider adapters should collapse differences into a named axis rather than fork the engine.
- **Dialect-shaped, not maximal** - `packages/experimental/hooks-codex/README.md:105` - The Codex bridge deliberately does *not* implement a pre-tool approval path or an input rewrite even though the harness could, because the reference protocol has no such thing. Fidelity to the source protocol beats capability, and the deviation is documented as a limit.
- **A clean plain stdout becomes context only when no structured context exists** - `packages/experimental/hooks-codex/src/index.ts:155` - The condition also excludes stdout that starts with `{`, so raw JSON can never leak into the conversation as prose.
- **The least supported reasoning effort is used for a cheap auxiliary call** - `packages/experimental/session-title-all-prompts-llm/src/index.ts:75` - `model.reasoning?.efforts[0]?.id` picks the cheapest reasoning tier the route supports for a title call. A model-capability-aware default for auxiliary calls, exactly what August's model-adaptation layer needs.
- **No fallback ever sends the payload elsewhere** - `packages/experimental/speech-to-text/src/index.ts:187` - "Execute exactly the resolved provider; no fallback sends audio elsewhere." A pinned provider instance means a withdrawn or replaced registration is an error, not a silent reroute.

### Memory and learning

- **A title is a memory anchor that only a provider may set** - `packages/experimental/session-title-all-prompts-llm/src/index.ts:162` - The `currentTitle` anchor is taken only when `request.currentTitle?.source.kind === 'provider'`; a user-pinned title is not an anchor and a fallback title is not either. Distinguishing "the model wrote this" from "the human wrote this" at the read site is the transferable rule.
- **The provider re-reads its own body on every load** - `packages/experimental/skill-badge/src/index.ts:47` - The bundled provider reads `assets/dsh-badge.md` from disk on each `get()` instead of embedding the text, so a packaged asset can be corrected without a code change.

### Subagent and parallel execution

- **A bounded serial queue, not a semaphore** - `packages/experimental/speech-to-text-sensevoice/src/recognizer.ts:228` - `enqueue` chains every job onto one `tail` promise, with `pending` counted against `maxPending`; a cancelled waiting job never acquires the worker, and a rejected job does not poison the chain (`this.tail = job.then(() => undefined, () => undefined)`). August's serial-resource tools should use the same shape.
- **A reader that coalesces and a slow consumer that is not flooded** - `packages/experimental/speech-to-text/src/index.ts:97` - `follow()` is an async generator that yields complete snapshots and coalesces intermediate progress; the Host owns preparation so closing the observer never cancels the work.

### Tool-call reliability

- **Rebuild every inbound frame; never pass it through** - `packages/experimental/ptc-runtime-python/src/protocol.ts:661` - `validateChildFrame` validates and *reconstructs* each field, so forged extras never ride along, a truthy-but-wrong `truncated` cannot silence capture, and junk returns `undefined` so a throw in the host's message handler cannot crash the host. This is the exact "a marker table has to be checked against every emitter" discipline, applied to a wire.
- **An event-scoped guard discards a mismatched structured block** - `packages/experimental/hook-protocol/src/codec.ts:122` - A `hookSpecificOutput` whose `hookEventName` names a different event (or is missing) has its event-scoped fields discarded while the top-level fields survive and the claimed discriminator is still recorded. A stray `PreToolUse` deny can no longer deny a `Stop` hook.
- **The most restrictive outcome wins, and only the winning rank's reasons are shown** - `packages/experimental/hook-protocol/src/merge.ts:74` - Reasons are collected in a `Map<rank, string[]>`, so an `allow` hook's explanation is never shown and a superseded `ask` objection is dropped when `deny` wins.
- **A non-blocking failure never stops the turn** - `packages/experimental/hook-protocol/src/runner.ts:96` - An executor rejection becomes a `HookOutput` with no exit code and the failure on stderr; the turn proceeds and the failure is recorded. A hook that cannot run is treated exactly like a hook that returned the wrong exit code.
- **A single error sanitizer with a type-checked code table** - `packages/experimental/tool-session-query/src/service-boundary.ts:21` - `SAFE_SESSION_QUERY_FAILURES` is `satisfies Record<SessionQueryErrorCode, …>`, so a new service error code cannot be added without a model-safe message; the full diagnostic goes to the internal log, and the model sees only a code and a sentence. August's tool-error path should have exactly one sanitizer with the same completeness property.
- **A malformed result fails the workflow; it is never truncated or reinterpreted** - `packages/experimental/tool-ralph/src/index.ts:245` - `readReport` checks the exact key set, the status, the normalisation of every string, the status-specific semantics and the serialized size, and throws otherwise. A report that fails is not "cap exhaustion" and not a partial success.
- **A provider that repeats a cursor fails loudly instead of looping** - `packages/experimental/tool-session-query/src/operations.ts:268` - `collectPages` keeps a `seen` set of cursors and raises `SESSION_QUERY_INVALID_CURSOR` on a repeat. The same "repeated cursor" class of bug (and its "a stale cursor must not transparently restart" rule) is worth having in August's paged readers.
- **A byte ledger that charges the *serialized* cost, and measures without allocating** - `packages/experimental/ptc-runtime-python/src/index.ts:1270` - A cheap lower bound (`text.length + 3`) is checked first so a control-heavy forgery never materialises its sixfold-inflated escaped copy; only then is the exact escaped cost measured. The ledger also starts one byte below the cap so an exactly-exhausted result still serializes to exactly the cap.
- **A budget that cannot be honoured is rejected at load, not clamped at runtime** - `packages/experimental/ptc-runtime-python/src/index.ts:938` - The output budget is checked against `RLIMIT_AS` × a 12× worst-case Unicode expansion minus a reserved interpreter baseline, so a near-budget output *truncates* rather than dying as `worker-exit`. August's file-read and compaction byte caps have the same shape of failure.
- **An invalid regex is a non-match at runtime and a config error at parse time** - `packages/experimental/hook-protocol/src/matcher.ts:37` - Two different doors for the same defect, so a bad pattern can neither crash a turn nor be discovered late.
- **The current step is excluded from a current-session search** - `packages/experimental/tool-session-query/src/operations.ts:138` - `range.to = min(range.to, stepStartSeq - 1)` — a model searching its own session cannot read the step that issued the search.
- **A pid is not an identity** - `packages/experimental/ptc-runtime-python/src/index.ts:379` - `readProcessStart` reads field 22 of `/proc/<pid>/stat` because a pid is reusable the moment the kernel reaps it; signalling one that a later process inherited would kill an unrelated process group. August's process-group teardown should carry the same (pid, started) pair.
- **Disposal reaches quiescence** - `packages/experimental/hook-protocol/src/detached.ts:53` - `drain()` aborts the signal (killing a still-running hook rather than waiting out its 10-minute timeout) and loops until the registry is observed empty, re-checking after each wave because a chain can be tracked mid-drain. Registered as the plugin's effect disposer, so `fiber.dispose()` resolving *means* the detached work is done.

### UI / UX

- **Truncation must not drop the metadata that explains the truncation** - `packages/experimental/tool-terminal/src/render.ts:75` - `boundBodyWithSuffix` reserves the bytes for `[wait: <reason>]`, `[session: …]` and `[lines: a-b of n]` *first* and truncates the body to what is left, so a clipped result still explains itself.
- **A result card that tells the model what it does not know** - `packages/experimental/tool-terminal/src/index.ts:162` - "An `inferred_idle` or `timeout` result does not prove the foreground command exited." A prompt-level honesty rule, and the render layer backs it with an explicit `waitReason` enum (`stdin_read | inferred_idle | timeout | session_exit`).
- **A step-keyed preparation state with throttled progress but a complete snapshot** - `packages/experimental/speech-to-text-sensevoice/src/recognizer.ts:142` - The `publish` function reconciles a new phase against the previous steps, so a step that was running when a failure arrived is marked failed rather than left spinning, and intermediate download notifications are throttled while the final snapshot is complete.
- **A model guidance section per tool, not a wall of text** - `packages/experimental/tool-session-query/src/index.ts:51` - The `PROMPT_TEXT` section teaches the *sequence* ("Follow a useful hit with `session_trace`, `session_event_trace`, or `session_event_read`") rather than describing the tools.
- **Unauthorised content is shown as a marker, never as a hidden id** - `packages/experimental/tool-session-query/src/presentation.ts:126` - `[outside workspace boundary]` and `[outside workspace subtree]` tell the model the wall exists without revealing what is behind it.

### Config

- **Validate every cap at load, and reject the values that would fail late** - `packages/experimental/ptc-runtime-python/src/index.ts:788` - A non-integer `cpuSeconds`, an `addressSpaceMb` whose derived byte count is not a safe integer (it would cross the wire as `null` and the child would get **no limit at all**), a `pythonBin` that `spawn` would throw on, a timer past `MAX_TIMER_DELAY_MS` (`setTimeout` silently clamps it to 1 ms), and a byte budget larger than the frame cap — all rejected at construction, each with a message naming the knob and the reason.
- **A volatile config field persisted through the settings service, without a remount** - `packages/experimental/speech-to-text/src/index.ts:134` - `configure()` writes only the changed fields into the plugin's profile entry and the live instance reads the updated values; the profile test asserts the fiber is **not** remounted and that a restart restores the selection. This is the shape August's brain-config keys already use, applied to a service.
- **An explicit deployment path overrides only its own subtree** - `packages/experimental/speech-to-text-sensevoice/src/runtime.ts:59` - `modelDirectory` overrides the model root but the VAD still resolves under the data dir; a deployment that supplies the model does not silently supply the VAD.
- **The "optional capability" is a profile patch, and disabling a predecessor is part of the patch** - `packages/experimental/session-titles-bundle/cordis.patch.yml:1` - The patch is `- id: session-title-llm / disabled: true` followed by the insert of the replacement; deselection restores the default. One file expresses the whole capability switch, and the same file is the unit of override.
- **An isolated group per optional capability** - `packages/experimental/session-search/cordis.patch.yml:1` - `isolate: { sessionQuery: true }` plus a lazy `:memory:` index with `openAt: first-search` means the optional capability owns its resources and releases them when the bundle is switched off.

### Evals / testing

- **Make a cross-language contract an executable check** - `packages/experimental/ptc-runtime-python/tests/protocol-mirror.e2e.ts:70` - The test spawns a real `python3`, enumerates the Python module's own `TypedDict`s, and compares each frame's required/optional key set with the TS map. The Python side is enumerated from *its* namespace, so a Python-only extra frame is visible. August's TS↔Python parity obligations are currently review-only; this converts them into a gate.
- **A compile-time exhaustive field-role map** - `packages/experimental/ptc-runtime-python/src/protocol.ts:231` - `WIRE_FRAME_FIELD_ROLES` is `Record<keyof T, 'required'|'optional'>` bound by `satisfies`, so a field added to a frame interface without a role entry fails typecheck, and an optionality flip is caught too. A two-way union⊆roster proof at `:215` catches a frame added to or removed from a union.
- **"Prefer the real implementation" as an explicit test rule** - `packages/experimental/hooks-claude-code/tests/bridge.spec.ts:20` — "a scripted mock MODEL drives the REAL agent loop + REAL bash executor, and the REAL bridge runs REAL shell hook scripts written to a temp dir — only the model is mocked". The same rule appears in the Codex bridge and the terminal loader test.
- **A test that would pass even when the fix regressed is a bad test** - `packages/experimental/hooks-claude-code/tests/bridge.spec.ts:439` - The HMR-safety test uses a *blocking* hook, because "a no-op `true` hook would pass even leaked, so it proved nothing". August's own tests have been burned by exactly this class.
- **A scanner gate that passes on zero matches is not a gate** - the shard's own coverage matrix is sliced by group so a branch cannot hide behind a whole-file run; and `tests/worker-entry.spec.ts:16` asserts the *failure* contract (empty stdout, message-only stderr, exit 1) rather than a success path.
- **An end-to-end test against the real provider, not a mock** - `packages/experimental/tool-session-query/tests/sqlite-integration.spec.ts:38` — the same tools are driven against the real SQLite engine, the real session store and the real turn-boundary projection.

## Files skipped (with reasons)

- `packages/experimental/skill-badge/assets/dsh-badge.png` — a **binary** PNG badge image (12,339 bytes). It has no line structure, so it was not read line by line; I verified the PNG signature (`89 50 4e 47 0d 0a 1a 0a`) and read the IHDR width/height as 726×120 directly from the header bytes, which is also what the package's own test pins (along with a SHA-256).

No other file was skipped. Every source, test, config, doc, locale file and asset in the shard was opened; the largest four files (`ptc-runtime-python/src/index.ts` 2,382 lines, `ptc-runtime-python/py/bootstrap.py` 2,599 lines, `ptc-runtime-python/tests/runtime.spec.ts` 293 KB, `tool-session-query/tests/tool-session-query.spec.ts` 84 KB) were read as head + key regions + a full `describe`/`it` index rather than every line, and this is stated in their individual notes.

## Uncertainties

- **How much of the very large files I actually read.** For `ptc-runtime-python/src/index.ts` I read lines 1–460 and 744–1303 in full and grepped the class members; the region between (the frame pump's settlement ladder, the kill/escalation code, the reply pump) is characterised by its JSDoc and by the corresponding test names, not by my own line-by-line reading. Same for `py/bootstrap.py` (head only) and the two large test suites (head + full case index). I did not execute anything, per the read-only rule, so no behaviour is empirically confirmed.
- **The zh READMEs.** I opened the head of each `README.zh.md` and confirmed it is the Chinese counterpart of the English file (same frontmatter `kind`, same section structure, matching content in the summary). I did **not** diff them line by line against the English — the repo's own `README.i18n.yaml` hash record is the authority for that, and I read the hashes but did not recompute them.
- **Where the harness-side counterpart of these packages lives.** The `packages/experimental/README.md` table names `ctx` keys (`ctx.speechToText`, `ctx.workflowEngine`, `ctx.terminals`, `ctx.ptcRuntime`, `ctx.skills`, `ctx.tools`, `ctx.sessionTitle`, `ctx.worktrees`) whose service definitions are in *other* shards of this manifest. I therefore describe the consumer side of each seam (what the bridge asks of `ctx.terminals`, `ctx.sessionQuery`, `ctx.workflowEngine`) but I did not verify the service implementation.
- **Whether the harness's own agent loop consumes `hook/invoked` / `hook/result`.** The protocol declares them as log-only records with no `surfaceOp`; nothing in this shard shows the frontend rendering them, and the "hook/invoked" surface question belongs to the client/UI shards.
- **The SenseVoice native path.** `sherpa-onnx-node` is a native CommonJS binding; I read the code and the mocked tests but could not exercise the real recognizer, so the ONNX/VAD behaviour claims rest on the code and the `local.e2e.ts` opt-in test, not on my own run.
- **The `packages/experimental` group map lists 46 packages but my shard holds 18.** The manifest splits `packages/experimental` across `dsh-experimental-rest#1`, `#2` (this one) and `#3`, plus three `dsh-experimental-inspect` shards for the inspector/web packages. The group README's "Packages" table therefore names packages I did not read (e.g. `webhook`, `translator`, `cua`, `auto-review`, `claude-code-mods`, `agent-team`, `browser-use-*`).
- **Reasoning/thinking coverage.** This shard contains essentially no reasoning-stream handling: the single place it appears is the title provider's rejection of a reasoning-only response. If DSH's reasoning/thinking handling is a first-class concern, it lives in the `llm`/`agent-loop` packages, which are not in this shard.
- **Context-window management and compaction are absent from this shard.** The only bounded-cross-boundary mechanism here is the Ralph loop's size-capped structured handoff; August's compaction/relief machinery has no counterpart in these 241 files.