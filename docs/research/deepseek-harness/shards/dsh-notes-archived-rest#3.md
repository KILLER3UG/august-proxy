# deepseek-harness / dsh-notes-archived-rest#3

## Shard shape

This shard is the tail of deepseek-harness's **archived Agent Note** corpus: 235 files covering 79 decision records under `.agents/notes/archived/simplification/` (2026-08-04 → 2026-09-19) and `.agents/notes/archived/testing/` (2026-06-11 → 2026-09-28). Each note ships as a trilingual-ish trio — an English `.md` decision record (`Status: implemented`, `Archived:` header, then Problem / Decision / Alternatives considered / Testing / Consequences), a Chinese `.zh.md` mirror, and a `.i18n.yaml` **bilingual-pair consistency record** that pins the git blob hash of both language sides as of the last confirmed-consistent state, plus the `pnpm run verify-translation-pairing --write` command that re-records it. (One note, `2026-08-04-remove-tui-package`, contributes only its Chinese side to this shard; its English and pairing record belong to another shard.) These are not source code — they are **retrospective decision records** about what the harness was built out of, and they are the clearest available statement of the harness's engineering *taste*: remove what has no consumer, prefer one mechanism over two, measure before optimising and again after, and treat every test flake as a statement about the observation rather than about the code. Substantively the shard is a **post-mortem corpus for a Cordis-plugin, streaming, multi-provider agent runtime**: request construction and freeze-evidence caching, tool-surface narrowing per preset, subagent/Team messaging and lifecycle ownership, session persistence trims and export semantics, scheduling, telemetry buffering, invariant companions, and — in the `testing/` half — the entire **record-once/replay-deterministic snapshot tier** (ACP transcript replay, per-session subagent keying, fork seed boundaries, a scriptable LLM wire-fault server, a whole-client assembly tier) plus a large, hard-won body of CI-reliability doctrine about budgets, barriers and observed completion. Recurring measurements: 246 ms → 67 ms request history, 11.54% content-scan gain, 297 ms hosted ceiling, 24–95 px of glow-induced horizontal scroll, 40+41 → 40+3 filesystem stats, 2738 request tokens per compaction read, 209 deleted invariant companions, 269-case client file.

## Per-file notes

### .agents/notes/archived/simplification/2026-08-04-remove-tui-package.zh.md
Chinese twin of the English removal note (whose `.md` and `.i18n.yaml` live in another shard): same Problem / 决策 / 考虑过的替代方案 / 后果 structure, translating the deletion of `packages/ui/tui` — the terminal renderer, the interactive command and QA adapters, extension overlays, snapshot fixtures, the patched `pi-tui` dependency — and the stated rule that a future terminal frontend must start from a real host and real interaction needs rather than inherit this implementation.

### .agents/notes/archived/simplification/2026-08-06-buffer-free-feedback-telemetry.i18n.yaml
Bilingual-pair consistency record: pins the last confirmed-consistent git blob hash of the English side (`7b35b5fff5c0d56f33a1888bb75853cfbe67cd74`) and the Chinese side (`be29674eba532c0020cb016915bd87a430bab7e8`); header comment carries the `pnpm run verify-translation-pairing --write` command. Boilerplate shared by all 78 pairing records in this shard, differing only in the two hashes.

### .agents/notes/archived/simplification/2026-08-06-buffer-free-feedback-telemetry.md
- Purpose: make feedback-gated telemetry **buffer-free** — the session-log prefix may only be uploaded after the user records feedback, so nothing proportional to the event count may be retained beforehand.
- Key abstractions: telemetry coordinator with `live` vs `on-demand` capture; `captureSession(session, throughSeq?)`; the `session-telemetry/record` waterfall; `FEEDBACK_ONLY` mode; the object-keyed handoff cursor (`WeakMap` keyed by Session object).
- Data flow: the `feedback/record` event's sequence is passed to `captureSession`; it reads the **canonical** session log from after the same-object handoff cursor to that inclusive boundary, deep-copies each event in order, runs redaction, and hands one record per event to the backend's non-blocking enqueue.
- Non-obvious design decisions: redaction is evaluated **at feedback time**, not append time, so a redaction-policy change before feedback affects the replay (line 18). A new Session object has no `WeakMap` entry, so its logical cursor is immediately before `firstLiveSeq` — `-1` for a fresh object, the constructor-seed sequence for a forked/resumed/migrated one — which distinguishes later replays without a second pending-record index.
- Edge cases / failure handling: script exhaustion is n/a, but the *event* cases are: a crash before feedback uploads nothing (accepted); the append is already committed when `session/event` listeners run, so the replay contains the feedback event and cannot include a later suffix; receivers must deduplicate repeated lifecycle-local rows on `(session.id, session.format_version, event.seq)`.
- Surprising: on-demand capture emits **no** `agent-error` or `shutdown` operational records at all, because it only reads the canonical log — a deliberate narrowing of what "telemetry" means.

### .agents/notes/archived/simplification/2026-08-06-buffer-free-feedback-telemetry.zh.md
Chinese twin of the English note: same structure with 问题 / 决策 / 考虑过的替代方案 / 后果, translating the live-vs-on-demand capture split, the `captureSession(session, throughSeq?)` replay of the canonical log, the object-keyed handoff cursor, and the three rejected alternatives (capture-time redacted records, session event references, a durable pre-feedback spool).

### .agents/notes/archived/simplification/2026-08-06-user-bubbles-drop-the-branch-action.i18n.yaml
Bilingual-pair consistency record: English `0cafa412aae45a02512c5e9911a4dfd46b4c8cad`, Chinese `8bf511d1ed16b57be69510479b849eab203fe4b9`.

### .agents/notes/archived/simplification/2026-08-06-user-bubbles-drop-the-branch-action.md
- Purpose: remove the branch/fork control from **user and steering bubbles**, because on those bubbles it could essentially never enable.
- Key abstractions: `MessageItem` fork props; `PendingSteeringBubble`'s `showBranch` special case; `messageBranchSeqs` → `assistantBranchSeqs`; the completed-turn-tail gate from the earlier bug-fix note.
- Data flow: a fork is a log-prefix cut at `turn/end`; the branch action is offered only on a completed turn's transcript tail where that tail is the turn's own content-text assistant node.
- Non-obvious design decisions: the gate is *effectively permanent* on user/steering bubbles (a turn-opening user message is followed by its own turn's nodes; a consumed steer is mid-turn by construction), so the control could enable only when the turn died before any model event — a tooltip promising a state the button cannot reach (line 10). The affordance also **lied**: a fork at a message seq cuts at the containing `turn/end`, so "branch at my message" includes the answer below it — the opposite of branch-to-re-ask.
- Edge cases / failure handling: a turn cancelled before any node followed its message loses its only handle and has no fork point, matching turns whose tail is a content-free interrupted node; the assistant-side "visible but temporarily unavailable" presentation is deliberately kept.
- Surprising: removing the control leaves the **seat free** for a future "re-ask from my prompt" feature (a cut *before* the message plus composer prefill) rather than squatting on it with opposite semantics.

### .agents/notes/archived/simplification/2026-08-06-user-bubbles-drop-the-branch-action.zh.md
Chinese twin of the English note: translating the "effectively permanent gate" argument, the narrowing of `messageBranchSeqs` to `assistantBranchSeqs`, and the rejection of hiding the control only while ineligible.

### .agents/notes/archived/simplification/2026-08-08-copy-only-preset-authoring.i18n.yaml
Bilingual-pair consistency record: English `07f8a6553cf9c70d5289a074b6e6d0d677dd4a28`, Chinese `58757a9774354b116d235f890beb136034f29904`.

### .agents/notes/archived/simplification/2026-08-08-copy-only-preset-authoring.md
- Purpose: replace the web YAML preset editor with **copy-only authoring** — files are the editor, the host owns the copy.
- Key abstractions: `agentPreset.copy { from, agentPreset, name? }` (replacing `agentPreset.write`); `settings/openAgentPresetDirectory { agentPreset }`; `settings/canOpenAgentPresetDirectory`; `PresetExistsError`; the standing-mount generation mechanism (`ensureStanding`, mtime+size stamped).
- Data flow: two ids resolved host-side against the host's own roots → whole-directory `cp` (symlinks dereferenced, modes re-tightened to owner-only with owner-execute kept) → metadata rewritten to keep the source description but never its name or `order`; a separate `openDocument` resolves the directory host-side and opens it natively, or answers `{ opened: false, path }` for headless deployments.
- Non-obvious design decisions: the old editor's shape check leaned on the Loader's own `entryListSchema`, whose dialect includes `!!js` — so "shape-checked text" was still **arbitrary code on the next mount** (line 10). Removing the editor dissolves that concern entirely (`assertComposition` deleted). Because hand-editing `agent.cordis.yml` becomes the only composition edit, the standing-mount layer had to gain **stamp-keyed generations**, or an edited file would serve stale compositions until process restart (line 19).
- Edge cases / failure handling: copy-target refusal is **two checks on purpose** — a roster check (any id a root supplies, so a user directory named like a shipped preset cannot shadow it) and a disk check (`PresetExistsError` before `cp`, with `errorOnExist` as the race backstop) for a directory occupying the name that discovery cannot see. Builtin directories are never opened (`openDocument` refuses non-`user` trust like `remove`).
- Surprising: showing the resolved path to the authenticated browser is classified as **response-direction disclosure**, not a violation of "no browser payload can select an arbitrary filesystem target" — the invariant is about the *request* direction, and the path never rides `list`.

### .agents/notes/archived/simplification/2026-08-08-copy-only-preset-authoring.zh.md
Chinese twin of the English note: translating the copy-only decision, the two-check copy-target refusal, the "revealed path is response-direction disclosure" argument, and the four rejected alternatives (better editor, patch-semantics copies, browser-side `session/openWorkspacePath`).

### .agents/notes/archived/simplification/2026-08-08-remove-cli-demo.i18n.yaml
Bilingual-pair consistency record: English `c23b622ccc1d9a7d87750c44c9b8df0bc68e314f`, Chinese `dec370ff11b099feab2d760b5646b6dc9bd422e5`.

### .agents/notes/archived/simplification/2026-08-08-remove-cli-demo.md
- Purpose: delete `@deepseek-ai/dsh-cli-demo` — a second application package that had become redundant once `dsh --profile headless` became the product one-shot command.
- Key abstractions: `dsh --profile headless`; `apps/cli/tests/profiles/headless` (loads shipped `base` + `headless` bundle layers, then narrow overlays); `@deepseek-ai/dsh-loader-smoke` (owns the shipped-profile composition helper, the shared direct-agent turn helper, and the test-only driver).
- Data flow: the source user runs `pnpm dsh --profile headless "task"`; that command owns final-text stdout, failure diagnostics on stderr, persistence, exit status and shutdown. The test-only driver renders canonical events as JSONL without defining a supported product output format.
- Non-obvious design decisions: the two entry points assembled **different trees**, so a successful demo did not prove the shipped `headless` profile worked (line 10). The replay suites still need canonical session events to pin assembled backend behaviour, but "that testing need does not require a published command or compatibility contract" — so the capability is kept as test-only infrastructure, not as a second product.
- Edge cases / failure handling: intentionally breaking — `dsh-cli-demo`, its `--output-format` choices and imports from its `cli.ts` no longer resolve, with no public event-stream replacement; callers needing structured automation must choose an existing protocol API.
- Surprising: the frozen Agent Note archive remains **historical evidence and is not rewritten** — archived notes are immutable snapshots, unlike active ones.

### .agents/notes/archived/simplification/2026-08-08-remove-cli-demo.zh.md
Chinese twin of the English note: translating the four rejected alternatives, including "delete the canonical-event snapshots with the package" (rejected because they pin model-visible assembled behaviour that final-text acceptance cannot observe).

### .agents/notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.i18n.yaml
Bilingual-pair consistency record: English `849ff666c38d92cf28edef7e6ea551584c152b03`, Chinese `da4868f0d23080e37cf8d78afd98700d3e88ed74`.

### .agents/notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.md
- Purpose: reduce a general recurrence subsystem to a single **bounded fixed-rate** selector, so "repeat every N seconds" does not drag in a Cron language, time-zone search and a global admission gate.
- Key abstractions: the `every_seconds` selector (safe integer ≥ 300); the durable rule union (After, At, Every); the tool selector union (`after_seconds`, `at`, `every_seconds`); the creation anchor; `acceptedAt` wall-clock dispatch record.
- Data flow: creation stores the first target as creation time + interval; each dispatch records the record id and one `acceptedAt`; pure integer arithmetic selects the **latest creation-anchor-aligned occurrence at or before that decision** and advances directly to the first aligned target after it. No missed occurrence is ever enumerated, persisted or replayed.
- Non-obvious design decisions: the five-minute minimum is a property of **each Every rule**, not a global gate (line 20) — there is no `lastRecurringAcceptedAt`, `deliveryNotBefore`, cooldown, quota or gate-exhaustion state. Advancing from *dispatch* time was rejected because it turns a fixed rate into a drifting delay loop; advancing from the *anchor* preserves the user's interval. Replaying every missed occurrence was rejected because it creates a backlog whose size depends on downtime.
- Edge cases / failure handling: when no one-shot is due, **every distinct overdue Every record participates in one follow-up batch** in target-and-creation order, each contributing exactly one latest occurrence, all using the same decision time; due one-shots keep priority so an already-promised reminder is not hidden inside a recurrence batch. If arithmetic cannot represent the next four-digit-year UTC target, the final dispatch terminates the record.
- Surprising: the removal is total — the Cron evaluator dependency, parser, canonicalizer, zone search, frequency proof, durable record/dispatch variants, tests, snapshots and third-party notice entry are gone, and old pre-release Cron records are **rejected by the strict v1 decoder** rather than migrated.

### .agents/notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.zh.md
Chinese twin of the English note: translating the every_seconds decision, the pure-integer latest-aligned-occurrence selection, the one-batch grouping, and the five rejected alternatives including "keep Cron as an optional branch".

### .agents/notes/archived/simplification/2026-08-09-conversational-schedule-delivery.i18n.yaml
Bilingual-pair consistency record: English `bd0497031bdaa1e23158851c4de05b2e3d16f97d`, Chinese `cf902b6a1c190c8ab4c00d808d6b27088a562ea8`.

### .agents/notes/archived/simplification/2026-08-09-conversational-schedule-delivery.md
- Purpose: make a due reminder visible **only as an ordinary conversation turn**, deleting a parallel durable receipt mechanism.
- Key abstractions: `followup()`; `schedule/change` as the only durable Schedule state; the removed delivery-receipt projection, Host sidecar, browser event node, keyed event slot and receipt renderer; `dsh-client-ui-schedule` as a read-only active-record projection.
- Data flow: a due reminder **waits for the Agent's idle maintenance phase**, then calls `followup()`, which starts a normal later turn appearing in the ordinary transcript. The dispatch operation records that the follow-up was *synchronously queued*, which prevents ordinary restart replay once the dispatch is durable.
- Non-obvious design decisions: dispatch does not claim model success, user acknowledgement or external notification (line 18) — it happens *before* the model request, so calling it "delivery" would overstate the durable fact. The narrow crash interval between enqueue and durable dispatch remains at-least-once. Schedule never calls `steer()` and never interrupts the running turn, so a reminder cannot hijack in-progress work.
- Edge cases / failure handling: a **failed model turn stays a failed turn** rather than producing a contradictory success receipt; the receipt was the thing that made the failure visible while the conversation contained no successful reminder answer. `schedule/change` remains the single durable state, and a separate Session projection may publish the complete active record set without carrying dispatch success or transcript history.
- Surprising: the Web overlay is opt-in and simply *enables the Web bundle's default-disabled catalog row* — the feature is contained in its own package plus ordinary composition, with no Schedule-specific behaviour left in Session, persistence, Host carriers or conversation rendering.

### .agents/notes/archived/simplification/2026-08-09-conversational-schedule-delivery.zh.md
Chinese twin of the English note: translating that the receipt created a second meaning of delivery, and the four rejected alternatives (keep the commit-aware receipt, render raw `schedule/change` events, treat dispatch as delivery, steer the current turn).

### .agents/notes/archived/simplification/2026-08-09-remove-repository-plugin.i18n.yaml
Bilingual-pair consistency record: English `34743014667d381af92a267b798d418756b9f4af`, Chinese `778499d9830e83c0336a198aad25685b2af1dcb8`.

### .agents/notes/archived/simplification/2026-08-09-remove-repository-plugin.md
- Purpose: remove the dedicated `.dsh-plugin` repository distribution path so external plugin installation has exactly **one** mechanism.
- Key abstractions: the profile bundle (`dsh.bundle.patch` → a `cordis.patch.yml` layer); `dsh plugin --profile <name> add <package-or-git-spec>`; the profile package manager and its lockfile; the removed `.dsh-plugin` manifest, `dsh-plugin-prepare` executable, generated wrapper, immutable repository cache and Loader builtin.
- Data flow: `dsh plugin add` records the dependency in the profile package; the installed package declares `dsh.bundle.patch` to contribute its patch layer; the patch owns Cordis Plugin selection and complete Plugin config. A bundle that contributes Skills mounts `@deepseek-ai/dsh-skill-filesystem`; one that contributes MCP servers mounts `@deepseek-ai/dsh-mcp-client`.
- Non-obvious design decisions: the duplicate path exposed **less** configuration than a bundle — its `repositories` list selected source strings but the generated wrapper mounted a code entry with no user-supplied Plugin config (line 12), so it was never going to become the general distribution mechanism. Under the pre-release compatibility stance, **no** `.dsh-plugin` parser or migration is retained.
- Edge cases / failure handling: profile installation now requires `pnpm` on the host `PATH` (acceptable for an explicit package-management operation); existing repository cache directories become **inert user data** that DSH neither reads nor deletes, so users can remove them themselves.
- Surprising: the note preserves the *motivation* of the four deleted decisions (external composition owned by the package manager; trusted lifecycle code; reuse existing owners; source identity in the dependency spec and lockfile) while dropping their implementation-specific wrappers, cache generations and preparation protocol.

### .agents/notes/archived/simplification/2026-08-09-remove-repository-plugin.zh.md
Chinese twin of the English note: translating that bundles compose existing owners directly, that package-relative static assets need a bundle-owned path form, and the four rejected alternatives including "keep the generic Loader repository cache for possible future consumers".

### .agents/notes/archived/simplification/2026-08-10-default-presets-single-editor.i18n.yaml
Bilingual-pair consistency record: English `2095cb4b6a436f21918e5ac0c4800a031174f7a1`, Chinese `2ea6109e13776a39e7c03a4f5d7a06e631c8c97a`.

### .agents/notes/archived/simplification/2026-08-10-default-presets-single-editor.md
- Purpose: give general-purpose presets **one** editing interface instead of two overlapping ones.
- Key abstractions: `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`; the `standard`, `code`, `cordis`, `minimal` preset rosters; PTC mode's registry and generated SDK.
- Data flow: the preset configuration mounts the fs plugins; the registry and the generated SDK derive the model-visible tool list from those mounted rows, so removing the mount removes the schema from every request.
- Non-obvious design decisions: `standard`/`code`/`cordis` drop `str_replace_editor` because it overlaps `read`/`write`/`edit` for ordinary inspection and editing, so "every request carried an additional tool schema without adding a distinct default capability" (line 10). `minimal` keeps it deliberately — its exact two-tool roster intentionally pairs `str_replace_editor` with persistent `bash`.
- Edge cases / failure handling: the decision narrows the preset **roster**, not the tool package or its Python runtime support; explicit deployments and user-authored presets may still mount the plugin, and preset composition tests pin its absence from the standard roster, the Cordis roster and the PTC SDK while minimal assertions pin its presence.
- Surprising: the earlier shared-roster decision ("even out shipped tool rosters") owns *why* surface-neutral tools live in preset composition; this note owns only the editor exception — a chain of narrow, single-purpose decisions rather than one big policy note.

### .agents/notes/archived/simplification/2026-08-10-default-presets-single-editor.zh.md
Chinese twin of the English note: translating the two rejected alternatives and that the `minimal` preset's two-tool roster is an intentional exception rather than an oversight.

### .agents/notes/archived/simplification/2026-08-10-source-run-without-managed-installer.i18n.yaml
Bilingual-pair consistency record: English `4e39ab10af027c3ba80d781fb8481e127a2687c7`, Chinese `e0ee88e5d76f29feb4e4253cae02d14b000fcd0b`.

### .agents/notes/archived/simplification/2026-08-10-source-run-without-managed-installer.md
- Purpose: run the harness from a source checkout **without** a repository-owned managed installer.
- Key abstractions: the root `pnpm` scripts; `node --import tsx/esm apps/cli/src/bin.ts`; the `dsh` package script; `NODE_USE_ENV_PROXY=1`; the source-launch/build separation note.
- Data flow: `pnpm dsh web`, `pnpm dsh --profile headless "task"` and `pnpm dsh --profile acp` launch the CLI directly through tsx, forwarding arguments and inheriting the caller's environment; artifact generation is the separate `pnpm run build`.
- Non-obvious design decisions: a repository-owned installer would make the repo responsible for a **second lifecycle** beside the package manager — host dependency installation, credential prompting, checkout adoption, symlink ownership, staging branch coordination, upgrade recovery, and continued compatibility with bundled maintenance skills (line 10) — none of which is required to run or develop from source.
- Edge cases / failure handling: users own checkout placement, Git updates and any launcher they create outside the repository; no atomic upgrade cutover, no preserved staging rollback checkout, and no automatic integration or upstream publication of personal source modifications. Any future publication workflow must isolate one approved feature and obtain explicit approval before its first push and draft PR.
- Surprising: the rejected alternative "keep the installer but document `pnpm run` as another path" is refused precisely because keeping both **lifecycle contracts active** (installer tests, staging-aware skills) is the cost, not the installer itself.

### .agents/notes/archived/simplification/2026-08-10-source-run-without-managed-installer.zh.md
Chinese twin of the English note: translating the second-lifecycle argument and the three rejected alternatives, including "replace the installer with a smaller launcher-link script" (still makes the repo responsible for host PATH mutation).

### .agents/notes/archived/simplification/2026-08-10-web-remove-steering-interjection-caption.i18n.yaml
Bilingual-pair consistency record: English `4a2d5df1757154584a897147b5d6a7d492945b89`, Chinese `82e24a16e7d8efb12a79b12069a5cb3ce39a3da7`.

### .agents/notes/archived/simplification/2026-08-10-web-remove-steering-interjection-caption.md
- Purpose: delete the permanent `插话` / `Interjection` caption from steering bubbles.
- Key abstractions: `UserStyleBubble` (loses its steering flag); `PendingSteeringBubble`; `UserMessageNodeView`; the deleted `message.steering` locale key and `.steeringMark` style; the retained `SteeringMessageNode` projection, `data-pending-steering` attribute and pending-to-durable hand-off.
- Data flow: a durable steer is projected from `agent/inbox/spliced` history into a `SteeringMessageNode`; presentation now renders it exactly as a user bubble, with content and actions only.
- Non-obvious design decisions: the caption repeats what the flow already shows — a steering bubble sits mid-turn, between the assistant content it interrupted, while a turn-opening prompt sits at a turn boundary — so "a permanent line of tertiary text above every steer bubble buys no reading a position-aware reader does not already have" (line 10). It was also the only chrome any user-style bubble carried, breaking the uniform right-aligned rhythm.
- Edge cases / failure handling: the runtime distinction is untouched because the pending lifecycle needs node identity regardless of presentation, and tests still locate pending bubbles through the attribute. A pending steer bubble is visually identical to an ordinary sent bubble until admission — only its missing clock time differs.
- Surprising: the caption has **flipped before** — removed on 2026-07-31 while the composer could not steer, reintroduced on 2026-08-04 after the composer gained a Steer gesture. This removal explicitly does *not* revisit the gesture, only the transcript's need to name the result.

### .agents/notes/archived/simplification/2026-08-10-web-remove-steering-interjection-caption.zh.md
Chinese twin of the English note: translating the "chrome that carries no information a reader lacks is removed, not maintained" rule and the three rejected alternatives (keep the caption, remove the node distinction too, quieter chrome).

### .agents/notes/archived/simplification/2026-08-11-cmdline-program-action.i18n.yaml
Bilingual-pair consistency record: English `96cbe2342eef90e68dece3c78b12a2de1bbea7c0`, Chinese `f5a9fea1447c78c9f099d3b54acd5b90a21aa503`.

### .agents/notes/archived/simplification/2026-08-11-cmdline-program-action.md
- Purpose: delete the bespoke `CmdlinePlan` callback seam and let the application's own commander `.action()` do the work.
- Key abstractions: `parseCmdline(ctx, program): void`; `CmdlinePlan<T> = (program, ctx) => T` (deleted); `isCommanderError`; `exitOverride`; `ctx.appExit`; `ctx.provide`.
- Data flow: `parseCmdline` parses the immutable `cmdlineArgs` snapshot and turns help, version, parse errors and action rejections into a single `ctx.appExit` request; both bundle providers publish from their action, which commander runs on a successful parse and never on help or rejection.
- Non-obvious design decisions: the whole seam **duplicated a slot commander already defines** — an action handler runs inside `parse`, and `program.error(...)` thrown from it obeys `exitOverride` exactly like a grammar rejection (line 10). Because the `Command` type cannot express the action precondition, `parseCmdline` reads the handler *structurally* and refuses at load a program in which no command declares an action — otherwise a provider that forgot its action parses successfully, publishes nothing, and surfaces only as dependent rows pending on an absent service at settlement.
- Edge cases / failure handling: `exitOverride` and output are configured on the **whole command tree**, not the root alone, because commander copies those settings into a subcommand only at registration — a root-only override would let a pre-registered subcommand's rejection call `process.exit` past `ctx.appExit`. An action must reject *before* it publishes; statements before its `program.error(...)` have already run. Actions must be synchronous because the helper calls `parse`, not `parseAsync`.
- Surprising: the behaviour was **verified on commander 15 before shipping** — an action runs inside `parse`, `program.error(...)` throws a `CommanderError` through `exitOverride`, help and version short-circuit before the action, and excess-argument handling is identical with and without an action.

### .agents/notes/archived/simplification/2026-08-11-cmdline-program-action.zh.md
Chinese twin of the English note: translating the "commander already defines this slot" argument, the whole-command-tree `exitOverride` rule, and the five rejected alternatives.

### .agents/notes/archived/simplification/2026-08-11-quickstart-documentation-home.i18n.yaml
Bilingual-pair consistency record: English `653c702eba4c90e52ee0539959d926ae23a98e6c`, Chinese `3d21566f9e4a822d095a115a5e65bfbaa3f947df`.

### .agents/notes/archived/simplification/2026-08-11-quickstart-documentation-home.md
- Purpose: make each locale root of the documentation site a **redirect to the quick start**, removing a second landing page.
- Key abstractions: VitePress frontmatter redirect in `docs/user/index.md` / `index.zh.md`; the documentation-site projector (`../process/2026-07-13-documentation-site-projection.md`); the relative redirect target `./guide/quickstart`; `DOCS_BASE`.
- Data flow: the projector publishes only the frontmatter for locale homes, so the canonical Markdown keeps its bilingual switcher without rendering a second landing page; `/` → `./guide/quickstart` and `/en/` → `/en/guide/quickstart`.
- Non-obvious design decisions: the target is **relative**, not origin-absolute, because an absolute path like `/guide/quickstart` ignores `DOCS_BASE` and fails when the site is hosted below an origin path (line 28). A separate documentation landing page duplicated product positioning and feature summaries, creating parallel claims that require synchronisation and review without helping readers reach technical instructions.
- Edge cases / failure handling: the projector test verifies that both locale roots use the same locale-relative quick-start target; product positioning and feature summaries stay outside the documentation site entirely.
- Surprising: the site *gives up* a promotional home surface — guide, development, reference, search and locale navigation remain reachable from the quick-start page, and the stable root routes remain valid entry points.

### .agents/notes/archived/simplification/2026-08-11-quickstart-documentation-home.zh.md
Chinese twin of the English note: translating that origin-absolute redirect targets were rejected because they ignore `DOCS_BASE`, and that the site no longer renders a second landing page at all.

### .agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.i18n.yaml
Bilingual-pair consistency record: English `865e80d2ee42f6aa38057d61f7151cf1802d962b`, Chinese `e978a5aecf349d1fd01b6d947609fa3b7692eb35`.

### .agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.md
- Purpose: delete the unreleased **SDK project toolchain** while keeping the runtime SDK.
- Key abstractions: the four deleted packages `@deepseek-ai/create-sdk`, `dsh-scripts`, `dsh-helper`, `dsh-telemetry`; the surviving `@deepseek-ai/dsh-sdk-client`, `dsh-sdk-protocol`, `dsh-sdk-jsonrpc-server`; the `packages/scaffold/` → `packages/sdk/` move; the repository naming contract note.
- Data flow: consumers continue to provide an executable plus an external `cordis.yml`; the JSON-RPC server remains an ordinary plugin selected by that configuration. The runtime SDK's npm names and wire behaviour do not change across the move.
- Non-obvious design decisions: the deletion criterion is **absence of a consumer** — "no project was created through a public release, and no current repository or external consumer requires that lifecycle", so the repo was maintaining four packages, two interactive command products, templates, package-manager adapters, configuration reconciliation, launcher telemetry, a repository skill and their tests without evidence that the product boundary should exist (line 12). The `scaffold/` group is split by *role*, not by folder: the SDK protocol/client/server stay because the Python SDK, the `dsh-sdk` subagent provider and the JSON-RPC example use them.
- Edge cases / failure handling: the repository loses the **complete support graph** rather than carrying dormant abstractions — workspace, build, test, packaging, documentation-generator, vendoring-rescope and dependency records are removed with the packages, and cancelled proposals are deleted rather than retained as active-or-rejected records.
- Surprising: `SDK` has exactly one repository meaning (the JSON-RPC client/server protocol used by the supported Python and TypeScript SDKs), which is why the survivors moved to `packages/sdk/` — "DeepSeek Harness itself is not an SDK project."

### .agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.zh.md
Chinese twin of the English note: translating the four rejected alternatives (delete only the initializer, keep error-only tombstones, delete the runtime stack too, leave it under `packages/scaffold/`).

### .agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.zh.md
Chinese twin of the English note: translating that the surviving runtime stack must stay because the Python SDK, the out-of-process Harness subagent provider and the JSON-RPC example are current consumers, and that reintroducing a project toolchain requires a real consumer.

### .agents/notes/archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.i18n.yaml
Bilingual-pair consistency record: English `ba37c2d81edda5c695743a080e83498ce6582b51`, Chinese `827f4f3a91da334766c11cbf4fd72a127ac80742`.

### .agents/notes/archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.md
- Purpose: keep optional product integrations (Codex, Claude Code) out of every production install's dependency closure.
- Key abstractions: `@deepseek-ai/dsh-base`'s dependency closure; Profile Bundles whose `dsh.bundle.patch` points to one package-owned `cordis.patch.yml`; the "self-provider Host row" (one per patch, zero Agent tool rows); the Agent Preset that independently decides tool grant.
- Data flow: installing a Bundle registers a **dormant** provider on the next Profile start; a separately authored Agent Preset grants the corresponding model-visible tool only to newly composed Sessions.
- Non-obvious design decisions: each provider Bundle **owns its pinned payload** — production starts the package-declared Codex wrapper (six platform aliases) and lets the Agent SDK select its private Claude Code CLI, and **never falls back to a host `codex`/`claude` binary** (line 16). Installing one Bundle does not pull in the other.
- Edge cases / failure handling: installation does not start a product, authenticate an account, rewrite native settings or grant model access; a missing payload fails **without** host fallback. Changed Host availability takes effect only on the next Profile start.
- Surprising: the design separates *availability* (the provider row) from *grant* (the preset row) — "installing one Bundle does not pull in the other", and the tool grant is a second, independent decision.

### .agents/notes/archived/simplification/2026-08-12-production-dsh-excludes-product-subagent-providers.zh.md
Chinese twin of the English note: translating the pinned wrapper/SDK ownership, the "no host fallback" rule, and the two rejected alternatives (keep dormant providers in the base bundle; add a wrapper or meta Bundle).

### .agents/notes/archived/simplification/2026-08-12-separate-source-launch-from-build.i18n.yaml
Bilingual-pair consistency record: English `2d285407b23071237ea02098204b09da45e39728`, Chinese `69c035ce7e6d1717cad780524afee01be82ac7c5`.

### .agents/notes/archived/simplification/2026-08-12-separate-source-launch-from-build.md
- Purpose: separate **source launch** from **repository build** so repeated startups do not pay repository-wide build latency.
- Key abstractions: the root `dsh` script (`node --import tsx/esm apps/cli/src/bin.ts`); `pnpm run build`; Typert host artifacts; frontend and client-plugin bundles; `pnpm run dev:web`.
- Data flow: the root script only launches; build is a separate artifact-producing operation. Source users build before the first production-like launch and whenever frontend or client-plugin artifacts need refreshing.
- Non-obvious design decisions: source modules reached through tsx and browser modules reached through built bundles "have different freshness behavior", so separating their commands requires explicit ownership of artifact production (line 12). Once package Node halves are built, `pnpm run dev:web` rebuilds only packages declaring `dsh.client`, keeping client-plugin bundles current and activating HMR — but it does **not** rebuild the frontend shell.
- Edge cases / failure handling: missing Typert host artifacts fail profile boot through module-resolution errors **without** a build instruction; missing frontend/client-plugin artifacts fail at startup with diagnostics that point at `pnpm run build`. The launcher does **not** validate artifact freshness — existing stale bundles are accepted and can run older browser code until the next build.
- Surprising: "build only when an artifact is missing" was rejected because it leaves stale output undetected while making build behaviour implicit and dependent on current filesystem contents.

### .agents/notes/archived/simplification/2026-08-12-separate-source-launch-from-build.zh.md
Chinese twin of the English note: translating the three rejected alternatives and that stale frontend/client-plugin bundles can silently serve older browser code.

### .agents/notes/archived/simplification/2026-08-12-trim-agent-teams-read-and-lifecycle-surface.i18n.yaml
Bilingual-pair consistency record: English `f4be797c47b804592818895db8daad0bb5b9e26d`, Chinese `196c3b241eb2552b98c186e78d6a161b8b5cd5b5`.

### .agents/notes/archived/simplification/2026-08-12-trim-agent-teams-read-and-lifecycle-surface.md
- Purpose: stop Agent Teams from duplicating the subagent continuation manager's data and lifecycle mechanics.
- Key abstractions: the package-private owners `TeamJournal`, `TeamRoster`, `TeamMailbox`, `TeamTaskBoard`, `TeamActivity`, `TeamRuntimeLifecycle` behind a Cordis-facing `TeamService` façade; `SubagentService.interrupt()`; the new `drainContinuableChildren(parent, childIds)`; `TeamMailbox` durable enqueue/acknowledgement.
- Data flow: Team keeps a durable named roster, a Lead-log mailbox and a task DAG; `TeamJournal` owns per-Lead transaction order and append-plus-flush publication; the mailbox owns target-local dispatch, acknowledgement and retry state; the board owns task authorization, DAG transitions and derived views.
- Non-obvious design decisions: the removed snapshot published pending mail that **no production caller read**, and `team.get` called it for Team identity and a global revision, discarded its collections, then re-listed members and tasks — the browser used neither the Team id it had already addressed nor the revision (line 12). Durable payloads copied timestamps already owned by the Session event envelope, and the fold validated them only against their previous copies, so the extra fields "added format and validation code without deciding behavior". `waitForChange()` returned a zero-or-one array with a domain kind and revision, yet every caller immediately re-listed authoritative state — so it now returns `{ timedOut }` and wakes current waiters after the owning flush.
- Edge cases / failure handling: Team `interrupt()` resolves the durable roster name then delegates to `SubagentService.interrupt()` with **exact ancestor authority** — previously it bypassed subagent authorization and cancellation semantics by calling `Agent.cancel()` directly. Teardown selects the roster's exact live direct-child ids and calls `drainContinuableChildren`, which authorizes exact direct ownership, opens selected Activation disposal synchronously, releases descendants child-first, leaves siblings and parent-wide admission alone, and treats absent targets as no-ops. Full teardown clears pending inbox work; only interrupt promises `keepInbox` (because `AgentHandle.dispose()` is a full release, so describing it as resumable parking would be false).
- Surprising: creation and dispatch remain **separate in-flight sets** because disposal must await creation before dispatches that creation recovery can register; and a coherent combined snapshot was not a consumer requirement, so `team.get` still folds once for members and once for tasks rather than adding an incremental cache that would introduce a separate consistency mechanism.

### .agents/notes/archived/simplification/2026-08-12-trim-agent-teams-read-and-lifecycle-surface.zh.md
Chinese twin of the English note: translating the eight removed public fields, the `drainContinuableDescendants` rejection (it would close admission for the whole Lead lineage), and the "keep all runtime responsibilities in one `TeamService` class" rejection.

### .agents/notes/archived/simplification/2026-08-13-remove-first-run-beta-notice.i18n.yaml
Bilingual-pair consistency record: English `535d0a20a5805c137551e6047f40fc5cf53153b8`, Chinese `20626bbd9d0bd13c00d4ee66f5dbc267c2e92082`.

### .agents/notes/archived/simplification/2026-08-13-remove-first-run-beta-notice.md
- Purpose: remove the full-viewport internal-beta notice from every GUI first launch.
- Key abstractions: the `settings.onboarding` step seat; the deleted notice component, acknowledgement store, copy owner and locale keys; the retained `ui-onboarding` Host namespace; the later shared-modal product onboarding note.
- Data flow: `ui-settings-general` seats no `settings.onboarding` step; the later `ui-settings-models` notice reuses the same `welcomeNoticeVersion` field and backend contract through a shared modal preceding the inline credential dialog.
- Non-obvious design decisions: the notice was **removed rather than reworded**, because the internal-test framing itself must not ship in a release build and telemetry already resolves to `DISABLED` when its mode is unset — so the only onboarding content about telemetry was a prompt explaining how to turn it *on* (line 10).
- Edge cases / failure handling: the Host keeps the `ui-onboarding` namespace registered so **existing settings documents remain valid** at no cost; a future consent flow can register through the unchanged seam with a fresh versioned field.
- Surprising: a versioned consent step was considered and rejected *for this release* — "a first-run question about enabling upload is still a telemetry prompt".

### .agents/notes/archived/simplification/2026-08-13-remove-first-run-beta-notice.zh.md
Chinese twin of the English note: translating that a mandatory first-run interstitial with no material statement left is pure friction, and that the restored notice is intentionally a different presentation and copy revision.

### .agents/notes/archived/simplification/2026-08-19-knip-config-cleanup.i18n.yaml
Bilingual-pair consistency record: English `56426aeb7ff53caf7828b3f252269559e596940d`, Chinese `a74fa831f2301d9b95d5e34b003585293501c874`.

### .agents/notes/archived/simplification/2026-08-19-knip-config-cleanup.md
- Purpose: delete stale and glob-duplicate `knip.json` workspace entries so the file stops looking bigger than the packages it describes.
- Key abstractions: knip 6.16 workspace selection (`getConfigKeyForWorkspace` uses specificity, not array merge); the `packages/*/*` glob default; workspace-scoped `ignoreDependencies`.
- Data flow: 15 `workspaces` entries are deleted — 2 stale keys (`packages/util/home`, removed in `4a09d9b34d`; `packages/client/web-ui`, an orphan with no directory and no git history) and 13 whose `entry`/`project` values were byte-identical to the glob default.
- Non-obvious design decisions: the deletion is safe because knip selects **one** workspace config per matched key, so a removed entry either lost an unresolvable target or fell back to an identical glob config — `pnpm run knip` runs clean before and after (line 19). Folding `zod` and other exemptions up to the root was rejected because the root `ignoreDependencies` is a repository-wide fallback and would mask a genuinely misplaced dependency in any future package.
- Edge cases / failure handling: knip 6.16 cannot itself detect the next stale key (that check arrived in 6.18), so a package removal must still remember to drop its key; upgrading to 6.18+ is deferred because it re-flags many `@deepseek-ai/...` test dependencies, changing analysis semantics rather than just adding hints.
- Surprising: the note explicitly realises the "never a restatement of the default stanza" criterion of an earlier package-inventory proposal, and names what remains open there (the e2e entry folding and the generated inventory).

### .agents/notes/archived/simplification/2026-08-19-knip-config-cleanup.zh.md
Chinese twin of the English note: translating that a key naming an absent package actively misleads, and that the remaining 54 explicit entries each carry a real reason to differ from the default.

### .agents/notes/archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.i18n.yaml
Bilingual-pair consistency record: English `8ba1e1a8d2ad5896421f029ae79265e00450b1da`, Chinese `857d0c7d6127c3dadb661fbc73f9516b385b297a`.

### .agents/notes/archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md
- Purpose: expose **minimal, actionable** diagnostics from product subagents without turning every upstream error member into a model-visible promise.
- Key abstractions: `SubagentResult.diagnostic` (the single public representation, bounded at 4096 UTF-8 bytes); the Claude Code five-category set (`limit`, `product-error`, `invalid-result`, `process`, `unknown`); the Codex eight-category set (adding `access-policy`, `service`, `transport`); the derived stage (`query-start`/`query-run`/`process`/`teardown`; `initialize`/`thread-start`/`turn-start`/`turn`/`process`/`teardown`).
- Data flow: each Provider derives a category from the current operation and **safe structured product facts**; the diagnostic also carries independently observed exit code and signal, and a contributing permission decision follows the failure line. Raw SDK text stays only on the internal cause chain and in Host observation.
- Non-obvious design decisions: raw SDK errors, app-server payloads, stderr, commands, paths, task content, environment values and credentials "cannot replace the structured mapping because they cross the product process boundary without a stable safety guarantee" (line 12) — so stderr is Host-only observation, neither classified nor copied into the result. Several upstream enum members lead to the same parent action, and the display-only consumer gains no behaviour from their exact names, so preserving them would make routine product upgrades redefine a larger Harness-facing promise.
- Edge cases / failure handling: successful completion and local cancellation expose **no** failure diagnostic; `contextWindowExceeded` still maps the shared stop reason to `max-tokens` and every other category remains `error`. The Provider owns one one-shot run with no retry authority, fallback model, persistent product session or recovery state — the category informs the parent, it does not start another product action.
- Surprising: the note includes an explicit **ownership table** — product error interpretation belongs to the official runtime, action category and stage to one Provider run, exit code and signal to the `dsh-subprocess` handle, permission decision to the Provider's callbacks, and diagnostic delivery and byte limit to `dsh-subagent` and its foreground/Job consumers.

### .agents/notes/archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.zh.md
Chinese twin of the English note: translating the two category tables and the ownership/lifecycle table, and that adding a shared structured error type would move product release churn into the provider-neutral seam without a consumer that needs it.

### .agents/notes/archived/simplification/2026-08-24-owner-local-profile-tests-and-guides.i18n.yaml
Bilingual-pair consistency record: English `fb9f1ad5c79fbf686cb84c4a9c8e4e4b835c6aef`, Chinese `904d21d32651728fa567f3a18146cb8a36351371`.

### .agents/notes/archived/simplification/2026-08-24-owner-local-profile-tests-and-guides.md
- Purpose: dissolve the top-level `examples/` tree so paths identify ownership without consulting a verdict table.
- Key abstractions: named `dsh` profiles as the only Node application compositions; `apps/cli/tests/profiles/` (cross-package ACP, headless, SDK profile tests); per-package `tests/fixtures/`; top-level `snapshots/`; `apps/cli/config/examples/` for shipped optional overlays; `docs/user/`; `python/sdk/examples/`.
- Data flow: `dsh --profile acp` starts ACP; the Cordis guide starts `dsh web` with its explicit overlay; `demo:ptc` remains a thin wrapper over `dsh --profile headless` with `DSH_TOOLS_MODE=ptc`. Optional overlays are shipped assets whose bare plugin names resolve through the CLI application manifest.
- Non-obvious design decisions: the umbrella workspace manifest existed primarily to make arbitrary nested Cordis files resolve packages, so **test and documentation placement had been determining dependency resolution** and unsupported demo launchers looked like product interfaces (line 10).
- Edge cases / failure handling: recorded-session tests stay under top-level `snapshots/` and non-session expected output stays owner-local; removing a guide or test no longer changes a global dependency umbrella. The `demo:acp` and `demo:cordis` scripts are absent — compatibility wrappers would preserve a second application vocabulary.
- Surprising: the decision is framed as *ownership placement*, not tidiness — "Package-specific test compositions evolve with their package, while user instructions belong in the published guide hierarchy".

### .agents/notes/archived/simplification/2026-08-24-owner-local-profile-tests-and-guides.zh.md
Chinese twin of the English note: translating that an examples-only workspace for module resolution "hides ownership and lets an arbitrary leaf behave like an application package".

### .agents/notes/archived/simplification/2026-08-26-remove-agent-spine-demo.i18n.yaml
Bilingual-pair consistency record: English `15768c10e15779c15c0207fc036af98d469d6a7c`, Chinese `31c6cf46aaadb8895bcdc2ea8e8958390f279786`.

### .agents/notes/archived/simplification/2026-08-26-remove-agent-spine-demo.md
- Purpose: remove an "example"-named package that actually exposed a public composition plugin with a large merged configuration.
- Key abstractions: `@deepseek-ai/dsh-agent-spine-demo`; `dsh-sdk-minimal`'s patch rows (timer, LLM, session, title, system-prompt, tools, agent, retry, local jobs, invariant registry, agent-loop); `loadProfile`; the root `cordis:include` used by application boot; `dsh-agent-loop-testkit`.
- Data flow: profile integration tests load the shipped profile and bundle patches through `loadProfile`, then pass the production patches plus narrow test `*.patch.yml` files to the same root `cordis:include` the application uses; test patches cover a mock provider or model, isolated persistence and the plugin under test.
- Non-obvious design decisions: the package's only shipped consumer was `dsh-sdk-minimal`, "where one plugin row hid the mandatory agent runtime from a bundle whose purpose is a complete explicit tree" (line 10) — so the fix is to make every mounted feature individually visible and patchable, even though the bundle gets longer.
- Edge cases / failure handling: the package duplicated composition policy already owned by `dsh-base` without offering an independently evolvable capability; replacing it with `dsh-base` was rejected because that bundle deliberately omits settings, credentials, workspace context, skill, goal, compaction, telemetry, subagent and broad tool rows. SDK server unit tests that do not exercise profile integration mount `dsh-agent-loop-testkit` and `dsh-agent-loop` locally.
- Surprising: as a consequence, profile integration tests now change when the shipped base or mode bundle changes — so their coverage reflects the **production tree** instead of a parallel test composition.

### .agents/notes/archived/simplification/2026-08-26-remove-agent-spine-demo.zh.md
Chinese twin of the English note: translating that a private mandatory-runtime composition for tests was rejected because a private TypeScript tree still duplicates production composition policy and can drift from the shipped profile.

### .agents/notes/archived/simplification/2026-08-27-persistence-export-and-pre-release-trims.i18n.yaml
Bilingual-pair consistency record: English `5a99bb7b38e0ce0ce6974897b09ec90fbe6bb074`, Chinese `2eb87104cf292d31e0775b8aa94e32947dd4f36b`.

### .agents/notes/archived/simplification/2026-08-27-persistence-export-and-pre-release-trims.md
- Purpose: shrink the session-persistence seam ahead of the handle-based refactor by deleting four surfaces the new design drops or replaces.
- Key abstractions: `SessionPersistence.export(id, signal?)` returning `SessionRawArtifact | undefined`; the removed `supportsRawArtifacts` capability flag and `readRaw`; the removed consumer-facing `locate` path query; `SessionLocation` retained only as refusal diagnostics; `SessionFormatUnsupportedError` / `SessionPersistenceCorruptionError`.
- Data flow: the base default resolves `undefined` and the JSONL backend overrides it with the former `readRaw` behaviour; the apiproxy ZIP download distinguishes an unsupported backend (session in `list()` but `export()` undefined → 501) from an absent session (404) **by list membership instead of a capability flag**.
- Non-obvious design decisions: the `locate` seam existed only to be honest with `compression: 'none'` — the default `.jsonl.zstd` artifact is unreadable from bash — so all three of its consumers (the `DSH_SESSION_JSONL` env var, the Claude Code/Codex hook bridges' `transcript_path`, the `locate`-based size gate and cold-blank probe) were either removed or degraded rather than ported (line 18). The ~300 lines of same-version legacy event-shape migration existed because durable payloads changed without bumping `SESSION_FORMAT_VERSION`; pre-identity logs now **refuse to load loudly** (with the raw-log path in the refusal) and pre-react-loop logs either refuse or load with stale turn-envelope fields passed through as extension-shaped data.
- Edge cases / failure handling: the cold-blank probe is gone — a cold row without a current cache answer reports `blank: false` (unknown) rather than guessing; the hook payload keeps `transcript_path` for protocol shape but always sends `''`/`null`, recorded as a durable consumer gap in both hook-bridge READMEs.
- Surprising: the note is explicit that this is a *recorded degradation*, not a free win: pre-identity logs that used to resume now refuse, and reintroduction is conditioned on "after the first tagged release, a durable format change bumps `SESSION_FORMAT_VERSION` and ships an explicit migration under the version gate — never another same-version exact-shape exception".

### .agents/notes/archived/simplification/2026-08-27-persistence-export-and-pre-release-trims.zh.md
Chinese twin of the English note: translating the three removed surfaces and the consolidated record of the two deleted same-version imports, including their capability given up and reintroduction condition.

### .agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.i18n.yaml
Bilingual-pair consistency record: English `db6e74752add7f7f78384987a55ea77f8a47c4ac`, Chinese `ecd3eec023ee18ee0ef3b638230b0d64ceed1d94`.

### .agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.md
- Purpose: stop every workspace package from publishing an `./invariant` companion, including packages with no runtime relationship to check.
- Key abstractions: the `./invariant` subpath, its `src/invariant.ts`, `lib/invariant.js` publication and invariant-only dependencies; `verify-package-invariants`; the retained `dsh-time-context` companion; the deleted synthetic `dsh-host-webserver` probe.
- Data flow: the audit removed 209 explained-empty companions and the webserver probe, leaving **39 checks with independent observations** — cross-event protocols (session, command, approval, workflow, hook lifecycles), event-to-state checks (settings, storage-domain, Workspace, client modules, slots), multi-producer assembly (system prompt, time context) and durable data consumed by projections (todo, plan mode, sandbox mode).
- Non-obvious design decisions: the publication criterion is *"can compare observations that may independently diverge"* — qualifying relationships are cross-event lifecycle, ordering, identity or pairing protocols; events compared with authoritative mutable state; output assembled from multiple producers; and durable data later folded by a different operation (line 18). Service or method presence, plugin metadata, fixed pure examples and probes that call the same mutation they claim to verify are type, load, unit or integration concerns. The webserver probe "had no independently produced observation: it mutated and inspected one route table through the implementation it claimed to verify".
- Edge cases / failure handling: omission must be **explicit in the package README** with a package-specific reason, and the verifier rejects partial export/publication/build wiring and empty installers. The retained `dsh-time-context` qualifies because its message is checked against independently owned current-turn user messages and durable event time — a same-writer payload round trip alone would not qualify.
- Surprising: the note states the general principle explicitly — "a package publishes `./invariant` only when it can compare observations that may independently diverge", and treats the README sentence as the place where a negative conclusion is recorded.

### .agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.zh.md
Chinese twin of the English note: translating the independent-observations criterion, the explicit-README-omission rule, and the audit result (209 removed, 39 retained).

### .agents/notes/archived/simplification/2026-08-28-remove-hero-input-glow.i18n.yaml
Bilingual-pair consistency record: English `43ef64cabca2dd07c4ac5a65f8098823b3291dfc`, Chinese `9ae9e1ac83326ee09a545a8d5b0057e2e1b84330`.

### .agents/notes/archived/simplification/2026-08-28-remove-hero-input-glow.md
- Purpose: delete a decorative backdrop ellipse under the New Session input card and the layout scaffolding it forced.
- Key abstractions: `HeroGlow` (figma 313:14109, `stdDeviation="50"`, sized `1051/776` of the hero box); `EmptyHero.tsx`; `ConversationRoot.module.css`; the `.scrollBody { overflow-x: hidden }` clip; `[data-conversation-scroll]`.
- Data flow: the glow's by-construction bleed past the conversation column gave the scroll container a real 24–95 px horizontal scroll range on laptop widths, which had been patched by declaring `overflow-x: hidden` on `.scrollBody` (2026-08-04).
- Non-obvious design decisions: a box that scrolls in one axis computes the other axis's initial `visible` as `auto`, so the glow's overhang — not a design choice — created the horizontal scroll (line 12). The `overflow-x: hidden` clip was kept only because the glow was there; the repo requires every declaration to have an owner, and "a silent clip would also hide the next accidental bleed instead of surfacing it in review".
- Edge cases / failure handling: the e2e scenario `conversation-column-overflow.e2e.ts` and its golden are deleted **with** the glow — the test's vacuity guard asserted the glow still bled, so it cannot pass once nothing bleeds. The standing guard is explicit: whoever reintroduces bleed must restore an explicit one-axis clip and a gesture-level regression test, because asserting `scrollWidth === clientWidth` is not a substitute — a clip hides the range without reflowing it away.
- Surprising: the note also records that on the shipped token sheets the ellipse read as "stray blue tint rather than intentional chrome" — the removal was a product-read judgement, not a token correction.

### .agents/notes/archived/simplification/2026-08-28-remove-hero-input-glow.zh.md
Chinese twin of the English note: translating the one-axis-scroll/`visible: auto` derivation and that keeping the overflow test against future bleed was rejected because its vacuity guard requires a presently-bleeding element.

### .agents/notes/archived/simplification/2026-08-28-windows-only-absent-probe-repair.i18n.yaml
Bilingual-pair consistency record: English `887e5fcf2280700b0f9b5c3fed821fdc4327a6ca`, Chinese `478110899d5faf931298c2e022ebaf859a1ebfc9`.

### .agents/notes/archived/simplification/2026-08-28-windows-only-absent-probe-repair.md
- Purpose: restrict an ENOENT-vs-ENOTDIR repair to the platform that actually needs it.
- Key abstractions: `JsonlSessionPersistence.exists`; `findLog`'s four probes per project directory (two rejecting the legacy flat-file layout, one for the opposite encoding, one for the log); the coordinator's `prepareCore` / `isPreparedSourceCurrent` double id resolution.
- Data flow: before returning false, the implementation stat'ed the path's parent so a session directory blocked by a regular file surfaces as a **storage fault** rather than a missing session; on Windows this is needed because `regular-file/child` reports ENOENT rather than ENOTDIR.
- Non-obvious design decisions: POSIX already reports ENOTDIR from `open(2)`, so the stat could only confirm what `open` had already said — it "detects no fault the caller would otherwise miss" and merely doubled the syscalls of every absent probe (line 33). The repair now runs only under `process.platform === 'win32'`, matching the platform dispatch `materialize` already uses.
- Edge cases / failure handling: measured before/after with the suite's existing module mock — loading an absent id went from 20 open + 20 stat to 20 open + **0** stat; loading an existing session from 40 open + 41 stat to 40 open + 3 stat. The 242 package tests pass unchanged and per-file coverage is identical.
- Surprising: the POSIX claim was **verified directly** rather than taken from the code's own comment — opening `regular-file/child` and `regular-file/child/deeper` reports ENOTDIR on macOS, while only a genuinely missing directory reports ENOENT. The note also states the remaining cost honestly: four opens per project directory per lookup, twice per `inspect`, growing with directory count rather than session count.

### .agents/notes/archived/simplification/2026-08-28-windows-only-absent-probe-repair.zh.md
Chinese twin of the English note: translating that `open(2)` specifies ENOTDIR when a path-prefix component is not a directory, and that collapsing the scan would first need to settle the per-lookup legacy-artifact guard.

### .agents/notes/archived/simplification/2026-08-30-team-send-message-steer.i18n.yaml
Bilingual-pair consistency record: English `f313a6fb11e4e32ff63944e961c615972807a820`, Chinese `fd5f7f3b9641048b1d1a113e5e82bef5e0fdf845`.

### .agents/notes/archived/simplification/2026-08-30-team-send-message-steer.md
- Purpose: collapse Team messaging to **one** model operation with fixed Steer scheduling.
- Key abstractions: `send_message({ target, message })` (the Team tool set now has nine operations); the durable `TeamMessageSnapshot` (sender, target, content, message identity — **no scheduling field**); the symbol-keyed host-only continuation adapter; `Agent.steer()`; `team/message/queued` and `team/message/delivered` events.
- Data flow: a running target receives the message at the nearest step boundary, an idle target starts a turn, an inactive teammate cold-resumes through the continuation lifecycle. The Lead receives the Team-attributed user message through `Agent.steer()`; a teammate receives it through a host-only adapter that authorizes the exact Lead-to-direct-child edge, preserves the original `TeamMessageSource`, and performs resident or cold-resume Steer admission.
- Non-obvious design decisions: the model was previously asked to choose a **scheduling policy** (quiet `send_message` vs waking `followup_task`) rather than to state whom to message, and quiet messages could accumulate unread on an inactive teammate until unrelated work resumed it (line 10). Sibling and teammate-to-Lead messages retain the real sender because the Team runtime never calls the public adjacent-Agent `sendMessage()` while impersonating the Lead — that operation authorizes only exact direct parent/child senders and derives its own source.
- Edge cases / failure handling: `accepted` means the target **inbox accepted** the message; `queued` means a temporary inspection, resume or inbox-admission failure left it in the Team mailbox for recovery; **neither means the target completed the work**. The Lead Session remains the mailbox transaction owner: it flushes `team/message/queued` before dispatch, serializes immediate admissions per target in Lead-log order, and records `team/message/delivered` only after the target Session durably contains the same message id. Recovery retries queued-minus-delivered records in order, and target-side source folding prevents duplicate acceptance across the crash window.
- Surprising: the durable snapshot has **no scheduling field** — the decision to always Steer is baked into the transport, not negotiated per message.

### .agents/notes/archived/simplification/2026-08-30-team-send-message-steer.zh.md
Chinese twin of the English note: translating the four rejected alternatives, including "drop the Team mailbox and deliver directly" (which would lose durable enqueue-before-admission, recovery, stable ids and target-side de-duplication).

### .agents/notes/archived/simplification/2026-09-01-css-produced-file-layout.i18n.yaml
Bilingual-pair consistency record: English `cc25fc2ab86cbbc03f49db72d12f107dd8c7aaf9`, Chinese `f9b670d9f7451304e818c4d1e2febe704caa617d`.

### .agents/notes/archived/simplification/2026-09-01-css-produced-file-layout.md
- Purpose: remove the JavaScript layout machinery that decided how many produced-file chips fit on one line.
- Key abstractions: `ProducedFiles` as an inline-size query container; CSS width bands; the six-file prefix; the pre-rendered localized remainder label; the local CSS custom properties for chip maximum and gap.
- Data flow: CSS width bands hide trailing chips from the six-file prefix and select the corresponding pre-rendered localized `+ N files` label; the flex row performs the actual shrinking and each basename uses CSS ellipsis while the selected remainder label keeps its intrinsic width. The same selected label gates the existing Host-gated "Show in folder" action.
- Non-obvious design decisions: the old row "duplicated every candidate chip in a hidden probe tree, synchronously read computed styles and element geometry in a layout effect, and repeated those reads whenever the row or a probe resized" — machinery whose *forced layout work cost more than exact width-dependent chip counts were worth* (line 10). The CSS band budget is derived from the row's own chip maximum and gap as local custom properties, so `+ N files` stays accurate for the CSS-selected prefix.
- Edge cases / failure handling: because fixed bands ignore actual text widths and localized remainder widths, the row may show one more or fewer chip than exact measurement would; flex shrinking and clipping preserve the single-line layout. Rendered files keep their full path in the accessible name and `title`.
- Surprising: the alternative "observe only the row and estimate from its width" was rejected because it still creates one observer and width-driven React state per mounted row *even though CSS already receives the same width* — and "always render six chips and let flexbox shrink them" was rejected because six filenames can shrink to nearly empty targets.

### .agents/notes/archived/simplification/2026-09-01-css-produced-file-layout.zh.md
Chinese twin of the English note: translating that the produced-file discovery and Host-opening behaviour remain owned by the earlier web file-links note, and that this decision changes only how the row handles limited horizontal space.

### .agents/notes/archived/simplification/2026-09-01-ptc-omits-workflow-tool.i18n.yaml
Bilingual-pair consistency record: English `ae53b30e43f9c27701724961162a1844111b1d2e`, Chinese `2fc839d0729b083ee86a8dff0c586fc426519421`.

### .agents/notes/archived/simplification/2026-09-01-ptc-omits-workflow-tool.md
- Purpose: remove the general `workflow` tool from the shipped `ptc` preset so the model faces one composition language.
- Key abstractions: the `tool-workflow` row in the `ptc` preset; the generated PTC mode SDK; the isolated `workflow-worker-thread` realm; `tool-ralph`; the model-facing wire contract of a single `run_code` tool.
- Data flow: disabling the consumer row removes the binding from registration, lookup and presentation together, so the PTC mode SDK omits `workflow` while `ralph` remains bound.
- Non-obvious design decisions: PTC mode already makes `run_code` the model-authored composition interface, so `workflow` "added a second orchestration language with different execution semantics" (line 10). The workflow package and its durable Session event types remain installed and existing workflow records keep rendering — this only prevents **new** top-level workflow calls from `ptc` agents.
- Edge cases / failure handling: hiding `workflow` only in the generated SDK was rejected because presentation-only filtering would leave executable tool lookup and the declared preset composition in disagreement. The preset retains `workflow-worker-thread` because `tool-ralph` consumes the same engine — disabling the whole realm would remove a provider `ralph` needs.
- Surprising: the preset **description** was changed to state the exception rather than to keep claiming complete parity with Standard mode — a copy that cannot state an intentional difference is a lie in the picker.

### .agents/notes/archived/simplification/2026-09-01-ptc-omits-workflow-tool.zh.md
Chinese twin of the English note: translating that keeping `workflow` until `run_code` has feature parity was rejected because the shipped PTC default is intended to make `run_code` its composition interface.

### .agents/notes/archived/simplification/2026-09-03-minimal-profiles-persistent-shell-only.i18n.yaml
Bilingual-pair consistency record: English `740d2e233d1b00f6babe4abbca889a3ffa0a5791`, Chinese `48d800683acc82e78706be8ee57a80965a3c9f83`.

### .agents/notes/archived/simplification/2026-09-03-minimal-profiles-persistent-shell-only.md
- Purpose: give the minimal profiles **exactly one** tool interface — a persistent shell — instead of a shell plus a separate editor.
- Key abstractions: the platform-selected shell (`bash` on Linux/macOS, `pwsh` on Windows); the removed `@deepseek-ai/dsh-tool-str-replace-editor`, filesystem tool and `fs-local` service; the shared persistent-Bash consumer's status-trailer contract.
- Data flow: settled commands append `[Command finished with exit code N]` (including on success); timeout output includes `[Command timed out or OOM]` plus the shell-reset notice; trailing newlines are removed before the trailer. Persistent Bash and PowerShell settle cancelled commands only **after** shell cleanup, so the existing ToolRuntime publishes `ABORTED` instead of stringifying the user's cancellation object.
- Non-obvious design decisions: the editor "added a second file-mutation interface and its complete schema to every minimal model request" and required an `fs-local` service no other row in either minimal composition consumed (line 10). Leaving it mounted but hidden through a presentation filter was rejected because an inactive capability can reappear when presentation configuration changes.
- Edge cases / failure handling: queued cancelled calls send no command; execution or cleanup failures retain their errors; the fixed complete persona, absence of runtime context and compaction, shell timeout and launch-specific host services remain unchanged. The editor package remains available for explicit custom compositions, which must insert it with a filesystem provider in the same service scope.
- Surprising: the note specifies the **tool-result text contract** of the persistent shell ("uses the one-shot shell's command-status wording while retaining its persistent state") and says both minimal Bash descriptions state that network access depends on the task environment — a detail that becomes part of the model-visible contract.

### .agents/notes/archived/simplification/2026-09-03-minimal-profiles-persistent-shell-only.zh.md
Chinese twin of the English note: translating that one persistent shell gives the model a consistent file-operation interface, and the four rejected alternatives including "keep the editor only in `sdk-minimal`".

### .agents/notes/archived/simplification/2026-09-05-base-default-file-editor.i18n.yaml
Bilingual-pair consistency record: English `e4e3740292fce922dcd7340e180feb81a999b23c`, Chinese `8623149547fc4b2293da72392087236394b29358`.

### .agents/notes/archived/simplification/2026-09-05-base-default-file-editor.md
- Purpose: pick **one** default file-editing interface for base-backed profiles (issue #3599).
- Key abstractions: the shared `packages/bundle/base/cordis.patch.yml`; the `read`/`write`/`edit` rows; the absent `tool-str-replace-editor` row; the Web minimal and `sdk-minimal` bundles' independent tool selection; patch `insert` semantics.
- Data flow: the base patch selects the three fs tools; SDK and Web application patches therefore need **no** disabling override, so every base-backed profile (SDK, headless, ACP, custom) omits the editor schema by default.
- Non-obvious design decisions: the base owns the shared choice directly rather than each application opting out — "disabling the editor separately in each application leaves overlapping defaults in base and requires each consumer to opt out" (line 22). Deleting the tool package was rejected because explicit custom compositions still use the interface.
- Edge cases / failure handling: a profile, home or invocation patch can add the tool with `insert`, but a patch that only sets `disabled: false` **requires an existing row and cannot create one** — a sharp asymmetry worth copying.
- Surprising: the note explicitly refuses to generalise — "this decision does not make all SDK and Web tools identical" — and defers Web minimal and `sdk-minimal` to the persistent-shell-only note.

### .agents/notes/archived/simplification/2026-09-05-base-default-file-editor.zh.md
Chinese twin of the English note: translating the `insert` versus `disabled: false` asymmetry and that the one-dsh-launcher note remains active for launch ownership, shared services and patch precedence.

### .agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.i18n.yaml
Bilingual-pair consistency record: English `dccd3ee770582dae10cbbaf0b3ec1e1ccca75634`, Chinese `1767c837a2e427454561b1010ca0b4144e94da6e`.

### .agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.md
- Purpose: stop re-proving that an already-frozen history is frozen on every request, without weakening the immutability guarantee.
- Key abstractions: a private `WeakSet<Message>` per `ReactLoopAgent` holding only identities whose **complete** `deepFreeze` succeeded in that instance; the per-request `canonicalHeader`; `markAgentLoopRequest`; `Session.deriveMessages` / `fromRestore`.
- Data flow: every unseen message is deep-frozen in place and then added to the WeakSet; later requests reuse that proof. The loop separately freezes its fresh messages array and request envelope, and leaves the live `AbortSignal` mutable.
- Non-obvious design decisions: skipping **all** frozen roots is unsafe because restore adopts independently owned graphs without freezing them and a shallow-frozen message can still contain mutable content (line 10). A frozen root does not prove its descendants frozen, so the shortcut was applied only inside the loop, never to the shared `deepFreeze` helper. Equal message ids do not establish object identity — only completed traversal of that exact object proves the requirement. Strong references were rejected because they extend old history lifetime; a global cache was rejected because it expands ownership beyond the Agent.
- Edge cases / failure handling: `canonicalHeader` shares nested values and `Session.append` freezes a separate snapshot, so neither proves the local tools or a `NO_ADAPTER` fallback's stop array immutable — those are frozen per request. LLM file, image and replay projections keep their own freezes because their newly produced values have no loop-local proof. Restored message identity and containing event-wrapper mutability are unchanged.
- Surprising: the measurement discipline is the story — 800-turn, four-tools-per-turn history, 40 live requests, 13,923 events; M4 median 246 ms → 67 ms (repeat median 72.9% below the original), cold tool continuation median 185.8 ms, retained heap 22.59 MiB against a 28.75 MiB budget. The hosted ceiling was then raised to **297 ms** (`floor(238 × 1.25)`) because two hosted runs on different Azure workers measured 183 ms and 146 ms — the allowance belongs only to `agent-continuation/request-history`, and a contaminated original-code run was retained rather than discarded.

### .agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.zh.md
Chinese twin of the English note: translating the measurement table, the hosted calibration runs, and the four rejected alternatives (including "remove downstream projection freezes").

### .agents/notes/archived/simplification/2026-09-07-file-content-scan.i18n.yaml
Bilingual-pair consistency record: English `4c72988ee7722b6b80ae594f936710714bb5eb23`, Chinese `55561b43f84d9780e3ece2bdeb51464737bcdc8b`.

### .agents/notes/archived/simplification/2026-09-07-file-content-scan.md
- Purpose: remove the per-array callback overhead from the per-dispatch file-content scan.
- Key abstractions: `contentHasFile` in `packages/llm/llm/src/content.ts`; the `llm/stream` dispatch path; the request-history benchmark worker.
- Data flow: every model dispatch checks complete message content for files (including tool-role result content); the new implementation iterates directly instead of recursing through `Array.some`, preserving early exit, tool-role result traversal and `false` for other block kinds.
- Non-obvious design decisions: the hot LLM source is **identical at both sampled master revisions and the measured V3 integration revision**, so the note explicitly declines to establish PR causality (line 10) — the measurement establishes an implementation gain, not a regression attribution.
- Edge cases / failure handling: the scan stores no identities, validation results or freeze proofs, so it remains linear in visited blocks and **rereads mutable nested content on each call**. A weak negative-result cache was rejected because it would need proof that every relevant descendant is immutable, and a shallow-frozen root is insufficient.
- Surprising: the measurement is unusually disciplined — nine **alternating** original/candidate pairs in fresh plain-Node processes, each receiving a copy of one native-V3 seed, with the median improving 11.54% and all nine pairs improving (4.871–12.243 ms); a separate five-pair scan probe over 5,601 frozen messages / 13,600 blocks cut the median from ~17.4 ms to ~8.7 ms.

### .agents/notes/archived/simplification/2026-09-07-file-content-scan.zh.md
Chinese twin of the English note: translating that optimising image traversal or system-prompt projection lacks evidence from this experiment and is outside the change.

### .agents/notes/archived/simplification/2026-09-08-web-subagent-catalog-projections.i18n.yaml
Bilingual-pair consistency record: English `a8660dc6d90f9e555429e7fe666c10e2cc6beaf6`, Chinese `aa4e9c2d1ae4057c3060d94c87b90d3c6b5e4a51`.

### .agents/notes/archived/simplification/2026-09-08-web-subagent-catalog-projections.md
- Purpose: make Web subagent catalogs consume the **shared** projection machinery instead of a parallel event + cache design.
- Key abstractions: the Client's per-Session projection store and `projectionsBySession`; the `session.projections` baseline endpoint; the `subagentCatalog` projection; Session-list baselines and status events; `TeamSnapshot`-like combined snapshots (not built).
- Data flow: an initial `session.projections` read returns a complete projection baseline from one live-preferred Session observation, and the same observation supplies values and the sequence cursor. Baseline responses and live control frames use the store's existing sequence ordering, so an older response cannot replace a newer value. Opening a conversation uses its follow baseline without scheduling a second projection read.
- Non-obvious design decisions: the dedicated catalog-change event, the repeated RPC reads and the second membership cache "duplicate that delivery and require coordination between responses and later events" (line 10) — the shared stream already delivers the changed value. The endpoint accepts **any** Session id and has no catalog-specific dependency or validation, and it does not activate an Agent or sample child activity.
- Edge cases / failure handling: parent Agent availability is reported separately by Session summaries and comes from the Session list independently of membership; projection responses cannot change it. Session removal cancels its pending read and marks parent availability false. Completed subagents retain their summaries and display projections after removal; removed ordinary Sessions retain stores only for nonempty child catalogs. Reconnect cancels previous reads and starts fresh ones.
- Surprising: the note is explicit about the limits — whole-value projection publication still costs O(D) for D children and no delta transport is introduced; and "Session sequence ordering does not establish identity across reused Session ids".

### .agents/notes/archived/simplification/2026-09-08-web-subagent-catalog-projections.zh.md
Chinese twin of the English note: translating that the initial-read endpoint was deferred rather than removed, because Session-list projections are cache hints and may be absent.

### .agents/notes/archived/simplification/2026-09-10-derived-workspace-recency.i18n.yaml
Bilingual-pair consistency record: English `65d861fc9ea7e10845c4a071c43959cfc4480c7c`, Chinese `5bf4a0020d447cbb3613a52a417d75f546a211d3`.

### .agents/notes/archived/simplification/2026-09-10-derived-workspace-recency.md
- Purpose: derive "Last updated" ordering from current timestamps alone, so a late-arriving older Session cannot be promoted ahead of a newer one.
- Key abstractions: the `updatedAt` projection with session id as tie-break; browser-persisted Manual order; the selected blank New Session as a display invariant; `seedSession`-style member supplementation.
- Data flow: ordinary rows sort by descending `updatedAt` (session id breaks ties); the selected blank New Session precedes ordinary rows until its first prompt; Grouped, Ungrouped and flat views use the same policy. Reloads and delayed summaries need no observed-timestamp history or promotion events in the view store.
- Non-obvious design decisions: the historical sidebar-order decision shared one editable order between Manual and Last updated "to preserve positions when switching modes", and that trade-off does not satisfy chronological browsing (line 10). Manual is redefined as **pausing** the current ordering: entering Manual freezes every active account from the current chronological ordering; returning to Last updated discards the manual layout and entering Manual again starts from current timestamps.
- Edge cases / failure handling: a Session drag snapshots every active account, applies the move to its browser-local account and selects Manual **atomically**; a cancelled or ineffective drag leaves the selected mode unchanged. Manual persists the observed blank position even while the Workspace stream reconnects. New members without summaries wait for the summary, while previously saved slots survive a temporarily missing summary. Workspace membership and Workspace-group order remain Host-owned.
- Surprising: the persistence key stores grouping, expansion and saved Manual positions but **not** persisted observed-timestamp data — "current metadata owns timestamp accuracy: a cold summary without prompt metadata can fall back to creation time, independently of view ordering".

### .agents/notes/archived/simplification/2026-09-10-derived-workspace-recency.zh.md
Chinese twin of the English note: translating the four rejected alternatives, including "persist a second chronological order" (a second ledger retaining synchronisation and recovery work without representing a user choice).

### .agents/notes/archived/simplification/2026-09-12-ralph-off-in-shipped-defaults.i18n.yaml
Bilingual-pair consistency record: English `6b1dea345c6d22c05550f6a5db35ccbc2da0216c`, Chinese `85ad7419301f7a18231622a5d0dba271fa02418e`.

### .agents/notes/archived/simplification/2026-09-12-ralph-off-in-shipped-defaults.md
- Purpose: ship the `ralph` loop **off** in the default compositions because the harness does not stand behind it yet.
- Key abstractions: the `tool-ralph` row in `packages/bundle/base/cordis.patch.yml` and in the `standard`/`ptc`/`cordis` presets; `workflow-ptc`; `validatePresetPlaneSeparation` in `scripts/verify-cordis-config.ts`; the Agent Preset registry's duplicate-id refusal; `snapshots/session/ralph-loop`'s re-enabling composition.
- Data flow: each disabled row carries its **restore recipe in a local comment** — an overlay row re-enables the capability for a base-backed profile from `$DSH_HOME/cordis.patch.yml` or a `--patch` file; a Web user overrides the row's `config.plugins` from the profile patch or saves a preset under a **new id** through the Web editor.
- Non-obvious design decisions: `ralph` runs a fixed foreground loop of fresh, unseeded child agents, and its own model-facing description restricts it to runs the direct human explicitly asked for; its README records that completion is a **worker self-declaration with no independent evaluator** and that the loop has no background collection, resume checkpoint or scheduler (line 10). Shipping it enabled meant "a default session carried a tool whose own description told the model not to reach for it".
- Edge cases / failure handling: the row is **disabled, not deleted** — deleting it would be unreachable for a user-owned composition, because a patch can only flip `disabled` on a row that already exists. In `ptc` the override must drop `disabled` from the tool row *and* the engine row together, because `tool-ralph` injects `ctx.workflowEngine`; the web-app patch restates the disable for its own layer because the plane-separation check collects row ids regardless of `disabled`. Existing sessions that already logged `ralph` calls still replay and render.
- Surprising: a **fifth shipped preset** was rejected because a shipped preset is offered to every user the moment it exists, so it cannot express "off by default", and the preset layer has no patch semantics so a new preset would be a full copy of `standard` that drifts silently.

### .agents/notes/archived/simplification/2026-09-12-ralph-off-in-shipped-defaults.zh.md
Chinese twin of the English note: translating that the goal tools were deliberately *not* demoted alongside `ralph`, because they are the supported long-running path.

### .agents/notes/archived/simplification/2026-09-15-host-only-remote-input-validation.i18n.yaml
Bilingual-pair consistency record: English `327f7ef025c7a5fac0447f07282fab6c5a2f62ca`, Chinese `9e8a1d67c77b3221b5d364c6e850887325164769`.

### .agents/notes/archived/simplification/2026-09-15-host-only-remote-input-validation.md
- Purpose: run Remote input validation **once**, on the Host, instead of on both sides.
- Key abstractions: `InvocationDescriptor` (shared between Host and Client artifacts); the Client contribution-mount descriptor check; the Host Gateway's strict parameter and identity codecs and JSON verification; `ctx.provide` / `ctx.remote`.
- Data flow: the Client validates descriptor integrity when a contribution mounts, then forwards typed arguments and bound Context identities **without calling invocation codec factories**; successful unary results and stream items pass through without Client-side type parsing.
- Non-obvious design decisions: executing the corresponding schema on every Client argument duplicated validation, materialized otherwise lazy Zod schemas in the Client, and gave invalid JavaScript calls "a different failure path depending on which side rejects them first" (line 10). The Client still keeps descriptor metadata because `InvocationDescriptor` is shared and mount-time strict checks require codecs for every Client-supplied field.
- Edge cases / failure handling: the Host owns runtime validation — it checks the exact named fields, executes the strict codecs, verifies JSON values and completes lookup before invoking business code; a value that cannot enter the carrier may fail serialization instead. Malformed runtime values now fail **later** than before, and undeclared object properties may cross the trusted carrier before the Host codec removes them.
- Surprising: the note names the security consequence explicitly — "callers that derive requests from untrusted or secret-bearing objects must construct the declared DTO rather than relying on Client parsing as a redaction step", i.e. Client-side parsing was doing duty as an accidental redaction layer, and losing it is stated rather than glossed.

### .agents/notes/archived/simplification/2026-09-15-host-only-remote-input-validation.zh.md
Chinese twin of the English note: translating that the Client still needs descriptor metadata for positional arity, wire-field mapping, scoped Context binding, undefined-omission and cancellation combination, but none of those requires executing a runtime schema.

### .agents/notes/archived/simplification/2026-09-15-model-agent-availability-and-team-targets.i18n.yaml
Bilingual-pair consistency record: English `61fafb5ad3de039b0c624be56285fc8556dc6fbf`, Chinese `595b4ce4eba6bf02c5223cf3029e7924f8f2da87`.

### .agents/notes/archived/simplification/2026-09-15-model-agent-availability-and-team-targets.md
- Purpose: give the model a **usable address** and an honest availability status for agents and Team members.
- Key abstractions: the Team tool adapter's `target`; `list_facts`-style member views; the `inactive` / `running` / `provisioning` / `failed` projections; `ownerName` on task views; `agent_id` for ordinary subagents.
- Data flow: messaging, interruption and task assignment all consume the same member name; the Team service owns roster and interruption availability for both tools and Web, while the ordinary subagent list tool owns its own projection.
- Non-obvious design decisions: returning both names and Session UUIDs "invites the model to choose an unusable address" (line 10); and loaded-between-turns and stored agents have distinct internal statuses despite requiring the same model action to continue work — so both project as `inactive`, and only an executing turn is `running`.
- Edge cases / failure handling: Team retains `provisioning` and `failed` for member creation, and ordinary subagent diagnostic rows keep their read-failure reasons; interruption projects its previous status by the same rule. Availability does not report task outcomes or waiting dependencies. Internal services, Web views and persisted Team records keep Session identity.
- Surprising: the note deliberately defers the harder question — stable subagent names and historical-data handling are deferred, and ordinary subagents keep `agent_id`, so Team addressing and subagent addressing remain different until a separate naming decision.

### .agents/notes/archived/simplification/2026-09-15-model-agent-availability-and-team-targets.zh.md
Chinese twin of the English note: translating that residency (loaded vs restored from storage) is a runtime concern the model should not see, and that merging internal runtime states was rejected.

### .agents/notes/archived/simplification/2026-09-16-subagent-catalog-membership-only.i18n.yaml
Bilingual-pair consistency record: English `b2c8395b3c7dc19aa3a0733a951390fa006ac95e`, Chinese `e41a115c875744cfcc5607d9afc4c693dbfce491`.

### .agents/notes/archived/simplification/2026-09-16-subagent-catalog-membership-only.md
- Purpose: keep the subagent catalog to **membership only** and drop creation-time model configuration.
- Key abstractions: the catalog event and projection; `establishCatalogChild(parent, childHeader, descriptor)`; the child composition and request history; the existing `modelSelection` projection.
- Data flow: the catalog retains child identity, creation time, mode and label; `establishCatalogChild` receives only the values needed to publish membership, and catalog loading adds no child observation or model lookup.
- Non-obvious design decisions: recording a child's creation-time LLM provider and model "would preserve immutable configuration without opening child histories, but discovery and navigation consumers do not read those values" — and creation configuration does not establish which model served a request (line 10). Optional fields still require durable schemas, cache invalidation, producers and replay expectations.
- Edge cases / failure handling: the unreleased optional metadata declaration and its dedicated expectations are absent, while existing historical Session generations from the migration base remain intact; initial reads, live updates, reconnect and authorization keep their existing owners.
- Surprising: the note states the reintroduction condition precisely — "a consumer whose requirement cannot be met by the existing child composition or request projections" — and points at the existing `modelSelection` projection as the place a display should read from.

### .agents/notes/archived/simplification/2026-09-16-subagent-catalog-membership-only.zh.md
Chinese twin of the English note: translating that reading child histories during discovery would add work proportional to child histories without helping membership.

### .agents/notes/archived/simplification/2026-09-19-deepseek-messages-only.i18n.yaml
Bilingual-pair consistency record: English `ef3ab51c733fa92d8d1c4e29cbfe9154b67481c1`, Chinese `1d5bdabbaf05ec7291bcb0ade354806ba7234b66`.

### .agents/notes/archived/simplification/2026-09-19-deepseek-messages-only.md
- Purpose: use **one** transport (Messages) for the official DeepSeek route.
- Key abstractions: `dsh-llm-deepseek`; the single adapter that resolves a request-local configuration snapshot; the Files client (Messages auth, metadata, pagination); the separate pi-ai adapter; the Messages-adapter note that owns thinking replay, system-message placement, image recovery and request-extension acceptance.
- Data flow: configuration exposes one endpoint and **no protocol selector**; the adapter performs the request; the Files client uses Messages authentication, metadata and pagination directly, and quota cleanup scans every page before selecting the oldest owned file.
- Non-obvious design decisions: the official route needs Messages thinking replay, image uploads and in-history updates; selecting a second transport "duplicates serializers, stream handling, Files wire formats, configuration branches, and fixtures without adding a required capability to this route" (line 10). A generic protocol dispatcher with one implementation was also rejected — it adds a second dependency representation and forwards every operation without selecting anything.
- Edge cases / failure handling: the route now requires a Messages-compatible endpoint; its mock-backed recovery, Loader, CLI and Web tests exercise Messages, so removing a wire implementation does not remove those behaviour checks. Committed Session generations remain readable through provider-neutral content and the retained Messages replay metadata.
- Surprising: the replay discriminators and upload-index namespaces **keep their existing values** — narrowing the transport does not invalidate durable data.

### .agents/notes/archived/testing/2026-06-11-property-based-testing.i18n.yaml
Bilingual-pair consistency record: English `e05574c8afba0eba19df7f59dd68225c3202ce18`, Chinese `20ccf68c3a28cda2b5ae1c5f3f8e720c5213e914`.

### .agents/notes/archived/testing/2026-06-11-property-based-testing.md
- Purpose: use property-based testing for **protocol-shaped** code, where the interesting bugs live in interleavings nobody wrote an example for.
- Key abstractions: `fast-check` (root devDependency); one `tests/properties.spec.ts` per protocol-shaped package; generators tuned for realistic-but-adversarial inputs; `numRuns` bounded so the suite stays well under ~10 s locally.
- Data flow: the BlockAssembler properties feed arbitrary chunk streams (valid and malformed — duplicate indices, stragglers, missing `block-start`); the session properties feed arbitrary event logs; the tools properties feed arbitrary `ParameterSchemaSpec`; the agent-loop properties feed arbitrary send schedules against a never-exhausting adapter, driven through the `agent/status` settle signal.
- Non-obvious design decisions: per-file 100% coverage "proves every line ran, not that every interleaving is correct" — a block-assembly ordering bug survived 100% line coverage of the happy paths (line 12). The loop properties are deterministic **by construction** (settle on `agent/status`, no wall-clock sleeps), so a hang is a real defect rather than a flake.
- Edge cases / failure handling: a property flake from a timeout is "a finding, not something to retry away"; failures print a reproducible seed. Generators bias toward small index pools and short strings so collisions and interleavings are common.
- Surprising: the note's own header says the suite **found a real BlockAssembler duplicate-`block-end` bug on its first run** (a duplicate at the same index rewrote a completed block; fixed so first close wins, matching the existing straggler rule). The nightly 100×-iterations CI job was explicitly *not* shipped — the property suite runs only in the normal `push`/`pull_request` CI.

### .agents/notes/archived/testing/2026-06-11-property-based-testing.zh.md
Chinese twin of the English note: translating the four per-package invariant lists and that property tests supplement rather than replace the example tests that pin specific branches for the coverage gate.

### .agents/notes/archived/testing/2026-06-19-acp-snapshot-tests.i18n.yaml
Bilingual-pair consistency record: English `35ac1b52fbcff87afc548dab7792f643cbbf52ae`, Chinese `76dfe847b53b1b0e15f578eebe9de75166339668`.

### .agents/notes/archived/testing/2026-06-19-acp-snapshot-tests.md
- Purpose: build a deterministic, keyless test tier with the **fidelity of a real run** — booting the shipped profile through `dsh` and diffing its normalised output against committed expectations.
- Key abstractions: the recorded-session snapshot; `@deepseek-ai/dsh-llm-replay` (a support package that short-circuits the provider-agnostic `llm/stream` waterfall); `deriveReplayScript()`; the in-memory `ReplayEntry` union (`chunks` / `throw` / `hang`); `replay.override.json`; `cordis.snapshot.yml`; the persisted-JSONL envelope projection.
- Data flow: recording runs the scenario with the real `llm-deepseek` adapter and `persistenceCompression: 'none'`, then projects the produced `.jsonl` into the scenario directory. Replay derives one positional call per recorded `assistant/message`/`assistant/attempt` stream, validating its terminal chunk; a `compaction/summary` with `llmStreamCall: true` contributes one call at its durable log position. Two normalised outputs are asserted: the framed ACP stdout transcript (`stdout.expected.jsonl`) and the re-persisted Session JSONL compared with the selected highest parent fixture.
- Non-obvious design decisions: **one generation is both the replay source and the behavioural expected output** — "the fixture is a projection of the product's persisted JSONL" (line 16), so a single ordinary Session generation serves both roles. Replay mode skips `.env` loading, so a stray API key cannot trigger a live call. Pre-stream throws, hangs and external summariser calls have no reconstructable local stream representation, so those scenarios provide an explicit `replay.override.json` rather than inferring adapter behaviour from lossy turn-end reasons.
- Edge cases / failure handling: replay is positional and permits only **one in-flight model stream per scenario**; more live sessions than recorded scripts fails loudly. A `throw` entry may carry prefix chunks for mid-stream failure. Changed call order requires re-recording. Normalisation replaces session, cwd, protocol-id, timestamp, path and process volatility; the shared writer expands `sourceEventSeqs` ranges before saving, so record and refresh produce canonical bytes independently of replay normalisation, and stores the generated workspace as `{{cwd}}`.
- Surprising: the surfaces are deliberately complementary — stdout covers the minimal automation wire while JSONL covers loop, tool and boundary structure "that the wire intentionally omits"; and a byte-level HTTP-record library (Polly/nock/MSW) was rejected as adapter-specific and lower-level than the thing under test.

### .agents/notes/archived/testing/2026-06-19-acp-snapshot-tests.zh.md
Chinese twin of the English note: translating the fixture-projection rule, the positional one-in-flight constraint, and the five rejected alternatives.

### .agents/notes/archived/testing/2026-06-20-remove-redundant-snapshot-log-expected-output.i18n.yaml
Bilingual-pair consistency record: English `306e1c67cc8370b629bd83c0335baf84037938f5`, Chinese `552fbb36fcea5dca5e9699348caa3a4fef1bb293`.

### .agents/notes/archived/testing/2026-06-20-remove-redundant-snapshot-log-expected-output.md
- Purpose: halve the committed session-log artefacts — every scenario gets at most one `session.jsonl`.
- Key abstractions: `session.jsonl` (replay fixture, expected log, or minimal boot fixture); `replay.override.json`; the `ReplayEntry` array; `normalizeSessionLog`; `fixtureContext()`.
- Data flow: for recorded scenarios `session.jsonl` stays the raw harvested log and the snapshot test compares the replay run's normalised persisted log against normalised `session.jsonl`. For authored override scenarios `replay.override.json` drives model behaviour and `session.jsonl` holds the expected produced log — the replay adapter ignores the fixture for model chunks when the override exists, so the same file can serve both roles. For no-model scenarios it stays the minimal fixture needed to boot `llm-replay`.
- Non-obvious design decisions: `session.expected.jsonl` was removed **entirely** because in the current fixtures the two normalised logs are identical for ordinary recorded scenarios (line 10). The alternative "normalise both sides against a shared (replay-run) context" was rejected because `normalizeSessionLog` scrubs cwd by exact string match, so the fixture's recorded cwd would survive unscrubbed and every compare would fail.
- Edge cases / failure handling: each side is normalised against its **own** header-derived context, which also makes already-normalised fixtures idempotent; session logs use plain equality rather than file-snapshot updates, so comparison never rewrites fixtures. The orphan-fixture guards know which files each scenario kind requires.
- Surprising: stdout expected outputs are explicitly **not** redundant — they are the editor-facing projection and protect the automation transcript, which the session fixture cannot observe.

### .agents/notes/archived/testing/2026-06-20-remove-redundant-snapshot-log-expected-output.zh.md
Chinese twin of the English note: translating that reviewers lose one artifact name, but the loop/persistence regression check is preserved without duplicating files.

### .agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.i18n.yaml
Bilingual-pair consistency record: English `da08d6dd9bf3719d1775686877a258c80ffd19d1`, Chinese `7be2527414aca87799f339c82cd6333e6ae2b51d`.

### .agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.md
- Purpose: stop a fork child's replay from silently serving the **parent's** recorded responses as the child's own model calls.
- Key abstractions: `SessionHeader.isSeeded`; the separately branded `SessionLogOffset.inheritedEventCount`; `CreateSessionOptions` / `CreateAgentOptions`; the v2 JSONL header plus `session/end-seed { inherited: true }`; the frozen v0 header's optional numeric `seedLength`.
- Data flow: the fork backend seeds the child session with a **balanced completed-turn prefix of the parent's log**, which `Session`'s constructor copies into `this.log`; so the fork child's `.jsonl` begins with the parent's events, including its Assistant settlements. `dsh-llm-replay` retains the decoded `inheritedEventCount` and `loadSessionScripts` derives a child's entries from `fixture.events.slice(inheritedEventCount)`.
- Non-obvious design decisions: `inheritedEventCount` is **explicit, never inferred from `seed.length`** — a reconstruction (resume/load) seeds the session with its whole stored log, so `seed.length` there is the full length, not the original boundary (line 26). The boundary is persisted at its source (the fork backend) rather than re-derived by a heuristic in the test harness: "a brittle heuristic in the test harness that re-derives a fact the producer already knows" was rejected.
- Edge cases / failure handling: for a spawn child the cut is 0 and the slice is a no-op; the v0 physical header stays byte-compatible while its codec translates the historical `seedLength` into the same logical pair; decoding uses the **last** tagged marker. The regression test uses a child fixture whose seeded prefix carries a parent chunk and is proven red without the slice.
- Surprising: the earlier per-session-replay note had explicitly called a fork snapshot "a trivial future addition, not a gap in the keying" — and this note records that the keying was never the problem; the *script derivation* was (line 10).

### .agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.zh.md
Chinese twin of the English note: translating that all recorded scenarios used spawn so the defect never fired, but would have mis-routed silently — exactly the class of bug the snapshot tier exists to catch.

### .agents/notes/archived/testing/2026-06-22-fork-snapshot-scenarios.i18n.yaml
Bilingual-pair consistency record: English `806ce2c1f3681810f609141936741c199e48fb67`, Chinese `72f242784efef56f38590c393935e2d344cb89e2`.

### .agents/notes/archived/testing/2026-06-22-fork-snapshot-scenarios.md
- Purpose: guard the fork replay slice at the **full-transcript tier**, not only in unit tests.
- Key abstractions: the `subagent-fork` and `subagent-mixed` recorded scenarios; the two in-process backends wired as two model-facing tools (`subagent` → spawn, `subagent_fork` → fork); per-child fixture keying by `seedLength`; `pnpm run test:snapshot:record`.
- Data flow: `subagent-fork` has the parent complete a turn (establishing a codeword) before delegating via `subagent_fork`, so the child's fixture carries a non-zero `seedLength`. `subagent-mixed` delegates once via `subagent` (spawn, `seedLength` 0) and once via `subagent_fork` (non-zero) in one transcript, with the two children ordered spawn-then-fork by `createdAt`.
- Non-obvious design decisions: a **completed turn 1 is required** — a parent that forks on its very first turn has no completed turn to inherit, so the seed is empty (≡ a fresh spawn, `seedLength` 0) and the slice would not be exercised (line 23). The recalled codeword is incidental; the load-bearing artefact is the child's recorded `seedLength`.
- Edge cases / failure handling: removing `slice(seedLength)` turns **both** new scenarios red — the fork child receives the parent's recorded chunks instead of its own — verified red→green when the scenarios landed. Out-of-process (ACP) subagent replay is a different shape (each child is its own process) and remains tracked as `TODO(acp-subagent-replay)`; these scenarios are in-process only.
- Surprising: the note is explicit about *why* a unit test was insufficient: "a fork-routing regression that left the unit tests green would still have escaped the tier built to catch transcript regressions" (line 10).

### .agents/notes/archived/testing/2026-06-22-fork-snapshot-scenarios.zh.md
Chinese twin of the English note: translating that the recalled codeword is incidental to the model's behaviour and the recorded `seedLength` is the actual load-bearing artefact.

### .agents/notes/archived/testing/2026-06-22-subagent-snapshot-replay.i18n.yaml
Bilingual-pair consistency record: English `7beb35764ae81154c1d5f73d74acf341eca7b0e2`, Chinese `c45acdfcdcddf84fc22cc564406b5497f7c42996`.

### .agents/notes/archived/testing/2026-06-22-subagent-snapshot-replay.md
- Purpose: make the snapshot tier express a **nested-agent** shape — a parent plus one recorded log per in-process subagent.
- Key abstractions: `GenerateOptions.sessionId` (a `Branded<'SessionId'>` from `dsh-brand`, used to avoid a `dsh-llm` ↔ `dsh-session` import cycle); per-session replay scripts; `harvestSessionLogs` and the plural `RunResult.sessionLogs`; the fixture naming `session[.vN].jsonl` and `session.<ordinal>[.vN].jsonl`.
- Data flow: `GenerateOptions.sessionId` is stamped from `agent.session.id` during request assembly; adapters ignore it, and an `llm/stream` listener routes by the issuing session. `harvestSessionLogs` recursively selects the numerically highest canonical generation under each persistence Session directory, parses each header, and orders them primary-first (top-level Session, then children by ascending `createdAt`).
- Non-obvious design decisions: replay is keyed by **who calls**, not by global call order, so it stays correct if subagents ever run concurrently or in the background (line 39). Live session ids are freshly random every run, so binding is by **first-call order** — the first live session to make any model call claims the first ordered script. A call carrying no `sessionId` is treated as one anonymous session bound to the primary script, so the single-session path is byte-for-byte the old behaviour.
- Edge cases / failure handling: more distinct live sessions than recorded scripts is a **fail-loud error** ("an unrecorded subagent appeared"), never a silent mis-route. The id tie-break only makes degenerate `createdAt` collisions deterministic; concurrent or background children would need an explicit first-call ordinal rather than relying on timestamps.
- Surprising: the rejected alternative was a **call-ordered merge** of parent and child logs into one global script — sound only because in-process execution is strictly nested (the parent blocks on the child), so it bakes in an invariant a future backgrounded subagent would break.

### .agents/notes/archived/testing/2026-06-22-subagent-snapshot-replay.zh.md
Chinese twin of the English note: translating the two original single-session assumptions (the unkeyed global cursor and the harness harvesting only the first `.jsonl`) and that the `sessionId` addition is "a small, honest core API addition useful beyond replay".

### .agents/notes/archived/testing/2026-07-04-hook-snapshot-matrix.i18n.yaml
Bilingual-pair consistency record: English `6c7229ee3b13867e01f657528265aabc2e4430df`, Chinese `7e46626db0234e269796338e8e0a4406547e1b71`.

### .agents/notes/archived/testing/2026-07-04-hook-snapshot-matrix.md
- Purpose: cover **every hook point** that has a deterministic, observable transcript footprint, for both the Claude and Codex dialects.
- Key abstractions: `dsh-hooks-claude` (7 Claude Code hook points) and `dsh-hooks-codex` (5 Codex points); the ACP example's `cordis.yml` / `cordis.snapshot.yml`; the 13 scenarios named `hook-<dialect>-<point>-<outcome>`; the `.stop_fired` marker file; the `durationMs` field scrubbed by the normaliser.
- Data flow: each scenario drives the **real** bridge translating a **real** hook process's outcome into the **real** seam decision, then the real loop's reaction through the automation wire and the persisted log. The ACP example now ships both bridges, each pointed at its own config file.
- Non-obvious design decisions: a bridge whose config file is absent is a **silent no-op** — `apply()` catches the read failure, logs through `ctx.logger` and registers nothing — so shipping both bridges is safe and was verified empirically (all pre-existing snapshots, none of which ship a `codex-hooks.json`, are byte-identical) (line 22). Hook commands emit only fixed literal strings (no timestamps/pids/`$RANDOM`/cwd echoes) so the transcript is stable.
- Edge cases / failure handling: three hook points are deliberately **not** snapshotted, and the note records the omissions as decisions. `SessionStart` and `SubagentStart` inject through a detached `void runPoint(...).then(agent.inject())` with **no turn binding**, so the resulting `context/message` races the work it precedes — a recorded expected output did not even reproduce on its own replay (10× stability check failed 10/10). `SubagentStop` is observe-only and writes nothing to the transcript, so an expected output would be byte-identical to the no-hook run and "could never be proven to fail — a guard that cannot bite".
- Surprising: the prove-red discipline is stated as a property of the design — "the hook process runs FOR REAL during replay (only the model is replayed)", so the expected output guards the actual hook→seam→loop path, not a mock of it.

### .agents/notes/archived/testing/2026-07-04-hook-snapshot-matrix.zh.md
Chinese twin of the English note: translating the three deliberately-unsnapshotted points and that the `stop_hook_active` loop-guard is still a bridge TODO, so the Stop scenarios self-limit with a marker file.

### .agents/notes/archived/testing/2026-07-04-single-source-acp-replay-config.i18n.yaml
Bilingual-pair consistency record: English `7d6217fe781209d449d87bb2e0411159e5f7eaa0`, Chinese `a040c14e6e08f9c60e9ad53449ad66c1203831c2`.

### .agents/notes/archived/testing/2026-07-04-single-source-acp-replay-config.md
- Purpose: eliminate the hand-maintained twin of the ACP application config.
- Key abstractions: `cordis.yml` (the live tree) and `cordis.snapshot.yml` (the overlay); the include plugin's `patches`; the loader's id map; the load guard that permits the intentionally disabled entry.
- Data flow: `cordis.snapshot.yml` includes the live config, disables the named DeepSeek adapter **by id and name**, and inserts the replay adapter — so every other entry comes from the shipping tree. Replay selects the overlay; recording still boots `cordis.yml`.
- Non-obvious design decisions: the twin's entire difference was the eight-line `llm-deepseek` stanza versus the two-line `llm-replay` stanza, and **nothing gated the symmetry** — if the copies drifted, the snapshot tier would silently exercise a different app than the one that ships, reintroducing the "green units, broken product" class one level up with reviewer vigilance as the only defence (line 10). The overlay keeps the delta declarative, readable and next to the base config.
- Edge cases / failure handling: the overlay depends on entries carrying stable `id:`s, and the `name` assertion on the disable patch guards mis-targeting (a reused id skips the patch instead of disabling the wrong plugin). An id **rename** degrades the patch to a skip whose warning needs a logger the replay app deliberately lacks — the observable result is a futile keyless `llm-deepseek` entry alongside `llm-replay`, with replay output still correct; it is "config rot for review to catch, not wrong snapshots". A top-level insert whose id collides resolves last-wins through the loader's id map.
- Surprising: the note records a deliberate dependency on a vendored-plugin fact — the include applies `patches` when it loads the file, while its `refresh()`/`internal/update` paths re-read without re-patching — which is exactly enough for a one-shot replay boot.

### .agents/notes/archived/testing/2026-07-04-single-source-acp-replay-config.zh.md
Chinese twin of the English note: translating that a bin-side swap would put YAML surgery inside a published artifact and move the replay delta out of sight.

### .agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.i18n.yaml
Bilingual-pair consistency record: English `cadb4f74a1e8556eb32a72285b78e1339f457514`, Chinese `5fdc38b9aa4cdce54026f23ad375b81d96b9c8c0`.

### .agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md
- Purpose: pin the exact composed **system prompt and tool-schema list** once per header-composition class, in reviewable form.
- Key abstractions: the `pinsHeader` flag; `system-prompt.expected.md` (Markdown) and `tool-schemas.expected.json` (structured JSON); the `{{system}}` / `{{tools}}` tokens inside `session.jsonl`; `scrubSystemPrompts`, `scrubToolSchemas`, `scrubRequestHeaders`; the suite factory's one-pin-per-class rule.
- Data flow: record and refresh write-back apply the appropriate scrub before writing JSONL and regenerate both sidecars from the normalised live full-header sequence, so neither path can reintroduce prompt/schema bulk into JSONL or leave a review artefact stale.
- Non-obvious design decisions: duplicating the header inside every `session.jsonl` would make a prompt or schema edit rewrite dozens of giant one-line JSON records, and keeping one raw header "still makes prompt review poor: prose is JSON-escaped onto one line and mixed with thousands of characters of tool schemas" (line 10). Each surface gets its natural review format — a prompt change produces a line-oriented Markdown diff in one file per affected class; a tool-description change produces a structured JSON diff.
- Edge cases / failure handling: guards make the split self-enforcing — on disk every `session*.jsonl` is a fixed point of both scrubbers, only non-pinning fixtures must be fixed points of the full header scrub, both sidecars exist exactly beside pinning fixtures in canonical newline-terminated formats, and each class has one pin. Live, every `request/header` from a parent, spawn child, fork child, initial request, resume or in-instance change must match the reconstructed class sequence after volatile-value normalisation; a header without a string prompt, without an array-valued tool list, or beyond the pin's declared changed-header count fails loud.
- Surprising: **one** pin covers the whole suite because every session composes the identical tool list and prompt modulo cwd — and the uniformity guard fails the suite the moment that stops holding. Slimming the session log itself (storing a content digest) was rejected because it violates the reconstructability contract: the product log must reproduce each request bit-for-bit.

### .agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.zh.md
Chinese twin of the English note: translating that header bulk is a test-artifact concern solved in test normalisation, and that the live log is untouched.

### .agents/notes/archived/testing/2026-07-08-shared-acp-snapshot-package.i18n.yaml
Bilingual-pair consistency record: English `6952f79eff8a764cd296bef98e9cd7b40e59cf01`, Chinese `35246fc4f98f616d70e31eb55499cca15f04c94e`.

### .agents/notes/archived/testing/2026-07-08-shared-acp-snapshot-package.md
- Purpose: move the snapshot machinery out of one example's test directory into a shared support package so it cannot fork.
- Key abstractions: `packages/support/acp-snapshot` (`@deepseek-ai/dsh-acp-snapshot`) with `src/launcher.ts` (`launchAcpTestAgent`), `src/harness.ts` (`runScenario`, `InputScript.permissionAnswers`), `src/normalize.ts` (pure normalisers) and `src/suite.ts` (`defineAcpSnapshotSuite`); the `AgentUnderTest` shape (`binScript`, `configPath`, `tsconfigPath`).
- Data flow: `launchAcpTestAgent` owns the unbuilt-process boundary (absolute tsx loader resolution, `TSX_TSCONFIG_PATH`, isolated harness homes, stdio wiring, a raw-byte stdout tee, stderr and update capture, fail-closed permission fallback, update waiters, graceful or signalled shutdown). `TestClient`/`runScenario` layer deterministic steps, temp workspaces, snapshot environment and persisted-log harvest over it. Reading `DSH_SNAPSHOT` stays at the edge — the library takes a resolved `mode`.
- Non-obvious design decisions: location decided test rigor — the per-file 100% coverage gate measures `packages/*/*/src` only, so machinery living in `examples/` was **unmeasured**, the same gap that had moved `dsh-llm-replay` out of `examples/` (line 12). A permission queue selects by option **kind**, not id, because ids are agent-issued randoms a committed script cannot know; an absent or exhausted queue answers `cancelled`, and a kind the request never offered rejects the run so the scenario bug fails the harness rather than being absorbed as an agent-side denial.
- Edge cases / failure handling: the normalisers are **hook-free by policy** — when a future event carries a new volatile field, the shared normaliser learns it in the same change, keeping one home for what "normalized" means. Refresh expands packed timing envelopes before aligning existing volatile event times so switching layouts cannot shift later records; fresh chunk-fragment arrays remain authoritative because their boundaries are replay behaviour.
- Surprising: the note lists what the tier **gives up** — `suite.ts` imports vitest, so the package entry is importable only inside a vitest run (a shape no other package has, stated in its README), and each suite pins its own ~8 KB header fixture. It also records a full "Deferred" list of product facts the tier surfaced but left alone (no `declare module` augmentation for `Context.connection`, no page-URL option on `TestClient.start`, a durable event pushed twice with the same seq dropped as a replay at the tail of `RemoteJournalStream`).

### .agents/notes/archived/testing/2026-07-08-shared-acp-snapshot-package.zh.md
Chinese twin of the English note: translating the six rejected alternatives, including "generalize beyond ACP (a transport-agnostic snapshot harness)" — rejected because no second transport exists.

### .agents/notes/archived/testing/2026-07-18-tui-terminal-state-snapshots.i18n.yaml
Bilingual-pair consistency record: English `eef9777c1f3d19c03985c0d105223960dd7d4878`, Chinese `50d2e1b81762538a08abda5608a7d26f2dd0b841`.

### .agents/notes/archived/testing/2026-07-18-tui-terminal-state-snapshots.md
- Purpose: give a stateful terminal renderer a **deterministic, reviewable** representation of terminal state.
- Key abstractions: the package-local `HeadlessTerminal` implementing the same pi-tui `Terminal` interface, feeding every ANSI write into the pinned `@xterm/headless` parser; the semantic projection (dimensions, active-buffer and viewport coordinates, lifecycle and cursor state, rows, wrap markers, non-default style ranges); `packages/ui/tui/tests/tui.spec.ts` and `tui.snapshot.ts`.
- Data flow: snapshot code waits for synchronised frames to quiesce before reading state; the streaming checkpoint freezes the loader interval while allowing real wall-clock delay across one animation tick, so it pins semantic status rather than whichever spinner glyph the scheduler happened to render.
- Non-obvious design decisions: unit tests that collect `Terminal.write()` fragments "can prove event handling, but they cannot prove the final screen a terminal displays", and the same screen may be emitted through different write fragments, so pinning fragments creates false regressions (line 10). Text and style are kept separate so a reviewer can distinguish content changes from presentation changes without decoding ANSI bytes.
- Edge cases / failure handling: every checkpoint enforces **theme independence** across the complete terminal state — no RGB colours, no palette entries beyond ANSI 0–15, no explicit background colours; reverse video remains valid for selection because it uses terminal defaults. Both suites own closed inventories that reject missing scenarios, missing checkpoints and orphaned expected-output files.
- Surprising: raster screenshots and raw-write snapshots were both rejected for different reasons (font/platform noise vs. unreadable cursor and clear sequences), and a completed flow built by appending plausible session events was rejected because it proves only that the renderer accepts those shapes, not that the production agent loop and tool implementations produce them.

### .agents/notes/archived/testing/2026-07-18-tui-terminal-state-snapshots.zh.md
Chinese twin of the English note: translating the removed application replay (the product TUI composition, journeys and PTY suite are gone; a deployment shipping a terminal front door owns those layers).

### .agents/notes/archived/testing/2026-07-22-cross-platform-test-fixtures.i18n.yaml
Bilingual-pair consistency record: English `edf2eb6b97f55dfa25c986978503cdd578f481f4`, Chinese `88a7904db3ca6e7811c94c1a66ab5cc4a83213e9`.

### .agents/notes/archived/testing/2026-07-22-cross-platform-test-fixtures.md
- Purpose: keep supported-platform tests **semantic** rather than encoding one platform's fixture syntax as product behaviour.
- Key abstractions: `node:path` / `node:url` for absolute paths and `file:` URIs; the connection's message writer as the transport-failure injection point; `fileURLToPath()` rejection for invalid-URI fixtures; negative process-group id on POSIX and `taskkill /T /F` on Windows.
- Data flow: transport-failure tests inject the connection's message writer and deliver the same asynchronous write-callback error a real Node stream would report, keeping a real child alive while the test distinguishes transport failure from process exit without touching platform-specific pipe handles. The production writer still writes framed messages to child stdin.
- Non-obvious design decisions: a literal POSIX path becomes drive-relative on Windows and a hosted `file:` URI can be a valid UNC path there, so "treating fixture syntax as product behavior either reports false regressions or encourages production normalization that erases native path semantics" (line 12). Normalising all paths to POSIX strings was rejected because external paths *are* native absolute paths and UNC file URIs are valid.
- Edge cases / failure handling: a language-server teardown targets the whole descendant tree via a negative process-group id on POSIX and synchronous `taskkill /T /F` on Windows; Windows suppresses only taskkill's already-absent-tree status, while command, permission and other tree-kill failures remain teardown failures. A read-only provider query retries once only when its selected pooled transport fails before or during that query; errors from a still-live server are not replayed. Terminal tests wait for observable rendered output rather than assuming one event-loop turn suffices.
- Surprising: only a **genuinely POSIX-only primitive** gets a narrow Windows exclusion, and the surrounding cross-platform cases continue to pin non-regular-file rejection, unavailable command rejection and inaccessible working-directory rejection — "broad exclusions would hide supported behavior".

### .agents/notes/archived/testing/2026-07-22-cross-platform-test-fixtures.zh.md
Chinese twin of the English note: translating that manipulating child-pipe internals until a write fails would test undocumented fixture machinery instead of the connection's write-failure contract.

### .agents/notes/archived/testing/2026-07-25-scriptable-llm-wire-fault-server.i18n.yaml
Bilingual-pair consistency record: English `5a691b8885bb6fbc99d9b59c28f64f2218acea7f`, Chinese `e2c6e7244b187c2eddaf1163c14fc04bd58066d3`.

### .agents/notes/archived/testing/2026-07-25-scriptable-llm-wire-fault-server.md
- Purpose: provide a reusable server for running the **shipping** HTTP adapter, agent loop and retry policy together against deterministic transport faults.
- Key abstractions: `@deepseek-ai/dsh-llm-mock-server` (private support package, importable Node HTTP server, **no installable binary**); the repository-local `pnpm run mock:llm` source entry; the behaviour vocabulary (socket reset, post-header disconnect, partial disconnect, stall, valid empty completion, clean truncated stream, malformed payload, HTTP failures, complete text/reasoning/tool-call responses, slow streaming, max-token completion); the `random` script entry with an unsigned 32-bit seed and caller-supplied relative weights.
- Data flow: the server accepts OpenAI-compatible root and `/v1` chat-completions paths, validates an optional bearer token, captures requests, and consumes **one explicit behaviour per accepted request**. Script exhaustion fails loud; repetition requires `repeatLast`. Real-composition tests route it through `dsh-llm-deepseek`, `dsh-agent-loop` and `dsh-llm-retry`.
- Non-obvious design decisions: connection refusal, a reset before the first event, clean EOF without `[DONE]`, a valid content-less completion and a reset after partial output "have different adapter and recovery outcomes. Treating them as one generic mock failure hides whether the provider boundary preserved the distinction and whether failed chunks remained outside committed model history" (line 12). A true `connection_refused` is a **CLI listener-lifecycle** phase, because a bound request handler cannot refuse its own TCP connection.
- Edge cases / failure handling: the server reports wire facts only and does **not** classify retryability — real-composition tests prove that connection refusal, hard disconnect, partial reset, idle timeout and a valid content-less completion recover under the existing default policy, while clean partial EOF remains `STREAM_CLOSED` and is not retried. The package does not change those policies. The shipped stress profile mixes transport, protocol, provider, timeout and semantic-empty outcomes and is "configurable test pressure rather than an estimate of production incident frequency".
- Surprising: an in-process `LlmAdapter` mock was rejected precisely because it "bypasses fetch, HTTP status/header parsing, SSE framing, socket termination, and the adapter idle watchdog: the exact boundaries this test infrastructure exists to exercise".

### .agents/notes/archived/testing/2026-07-25-scriptable-llm-wire-fault-server.zh.md
Chinese twin of the English note: translating the six rejected alternatives, including "expose an installable workspace binary" (pnpm links dependency binaries before repository build outputs exist).

### .agents/notes/archived/testing/2026-07-26-execa-for-test-subprocess-plumbing.i18n.yaml
Bilingual-pair consistency record: English `ca5edc50bf17a34809037462f8e9603b8ed28e74`, Chinese `186e5cd560b6500364c855438d6c3ff18206b52b`.

### .agents/notes/archived/testing/2026-07-26-execa-for-test-subprocess-plumbing.md
- Purpose: replace ~10 hand-rolled spawn/collect/timeout choreographies with one battle-tested implementation.
- Key abstractions: `execa` (root devDependency and runtime dependency of `@deepseek-ai/dsh-loader-smoke`); `node:util` `parseArgs`; `process.loadEnvFile`; `vi.waitFor` / `expect.poll`; the listed sites (`runLoaderSmoke`, `runBuiltBin`, `runBinExpectingExit`, the lsp-local and code-runtime-worker helpers, `pty-harness.ts`, `keyless-smoke.e2e.ts`).
- Data flow: the sites run through `await execa(cmd, args, { cwd, env, timeout, killSignal: 'SIGKILL', reject: false })`, whose result reports `{ stdout, stderr, exitCode, signal, timedOut, failed }` as **independent** fields — matching the repo's own defensive-patterns rule to report orthogonal subprocess outcomes independently.
- Non-obvious design decisions: the hand-rolled pattern was `let stdout = ''` accumulation with `setEncoding`/`data` handlers, a `setTimeout` → `kill('SIGKILL')` deadline and `once('exit')`/`once('error')` settlement, "each with small variations" (line 10). A repo-local shared helper was considered and rejected because it keeps deadline/kill/settlement logic in-repo and "has to re-earn cross-platform timeout, termination, and result-normalization behavior that execa already carries".
- Edge cases / failure handling: the genuinely custom parts stay custom — cli-demo's interrupt-on-marker mid-stream logic, jsonrpc's line-predicate protocol driving, and crash-recovery's SIGKILL-at-failpoint choreography; `smoke-real.e2e.ts` keeps raw `spawn` for its three long-lived interactive servers. `runLoaderSmoke` passes `input: ''` for its stdin-close contract, and sites pinning exact stream bytes pass `stripFinalNewline: false`.
- Surprising: the change **removed** two `/* v8 ignore */` un-inducible OS-error branches in `loader-smoke`, so the `src/` file now carries no coverage exemptions; and it introduces a new bound — execa's default 100 MB `maxBuffer` now caps previously unbounded captured output, a limitation recorded in that package's README.

### .agents/notes/archived/testing/2026-07-26-execa-for-test-subprocess-plumbing.zh.md
Chinese twin of the English note: translating the four individually rejected small dependencies (`get-port`, `wait-on`, `tempy`, `tree-kill`) with the reason for each.

### .agents/notes/archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.i18n.yaml
Bilingual-pair consistency record: English `1cc5d7ff306b6f1426d6ee36359674f826b2cd8a`, Chinese `cdd64d26f06e9b3fe62b8e01739f0e30e8b39212`.

### .agents/notes/archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.md
- Purpose: keep browser storage owned by jsdom when the Node runtime reserves a process-wide `globalThis.localStorage`.
- Key abstractions: the `--webstorage` / `--no-webstorage` runtime flag detection; each test project's `execArgv`; the `@vitest-environment jsdom` file-level selector; the Node compatibility aggregate.
- Data flow: Vitest workers disable Node's process-wide Web Storage when the runtime advertises the flag, passing `--no-webstorage` through `execArgv`; runtimes without the flag receive no argument. Node-environment suites therefore stay browser-free, while jsdom-selected files receive jsdom's isolated `localStorage`.
- Non-obvious design decisions: the supported Node range includes releases that reserve the key; Node 26 exposes it as `undefined` without `--localstorage-file`, and Vitest sees the reserved key and does not project jsdom's `Storage` over it — so component suites "fail before exercising product behavior" (line 10).
- Edge cases / failure handling: `NODE_OPTIONS=--no-webstorage` in package scripts or CI was rejected because it leaks test-runner policy into subprocesses and misses direct `pnpm exec vitest` invocations. Patching `globalThis.localStorage` in setup was rejected because it would depend on Vitest's private jsdom projection details. The compatibility aggregate runs a dedicated jsdom smoke on every advertised compatibility line, asserting both the conditional worker argument and usable storage, "so a future Node or Vitest change cannot leave the primary Node 24 suite as the only signal".
- Surprising: the decision has a stated cost — test workers deliberately cannot exercise Node's process-wide Web Storage, and a future product need for that API requires a separate explicit test configuration rather than weakening jsdom isolation.

### .agents/notes/archived/testing/2026-07-30-vitest-jsdom-webstorage-ownership.zh.md
Chinese twin of the English note: translating that `--localstorage-file` was rejected because one process-wide persistent store has different ownership and isolation semantics from browser storage created per jsdom environment.

### .agents/notes/archived/testing/2026-07-30-web-browser-snapshot-ci-gate.i18n.yaml
Bilingual-pair consistency record: English `a0034aed5858c89778d3516e114ec03386a2e905`, Chinese `3e84a335960f977eb6e6ed6fc82ec0185fa638fd`.

### .agents/notes/archived/testing/2026-07-30-web-browser-snapshot-ci-gate.md
- Purpose: make stale web browser expected outputs fail **in the PR that changed them**.
- Key abstractions: the Linux `node 24 / snapshots and artifacts` consumer job; `scripts/run-gates.ts` and its `ci-consumers` gate; `DSH_SNAPSHOT=replay` vs `record`/`refresh`; `DSH_WEB_SNAPSHOT_WORKERS`; `scripts/run-web-snapshots.ts`; the Playwright browser cache keyed by OS and lockfile.
- Data flow: `run-gates.ts` registers `test:web:ci` as a `ci-consumers` gate and explicitly injects `DSH_SNAPSHOT=replay`. The consumer job owns the single Linux build, so `apps/web/dist` and the packages' `lib/` directories remain in its workspace for the browser suite. `run-web-snapshots.ts` runs `hmr-live.e2e.ts` separately (it mutates built workspace state) and then a six-worker Vitest pool for the rest.
- Non-obvious design decisions: CI **never** runs in `record` or `refresh` mode, "so when the committed goldens disagree with the currently assembled application, the tests fail directly instead of silently rewriting them on the runner and then passing" (line 14). Running CI in refresh mode and then checking the working tree was rejected because it "turns the assertion mechanism into a generator". The Chromium suite runs everything, while the model and reasoning picker also runs in WebKit to cover native mouse focus behaviour.
- Edge cases / failure handling: the PR gate runs only in the Linux consumer job because the scenarios target POSIX and the other PR jobs do not provision both engines; the self-hosted standby runs the same comparison without hosted cache actions. A PR's "all checks passed" verdict already depends on the consumer job, so no new branch-protection check name is needed. The gate makes no claim of cross-platform browser consistency.
- Surprising: the budget was measured rather than guessed — the six-worker browser command took ~65–71 s, a twelve-worker comparison ~50 s, so halving the worker budget adds ~15–20 s rather than doubling wall time, and the scheduler starts browser snapshots as soon as `built-package-invariants` succeeds so it needs no dedicated job timeout.

### .agents/notes/archived/testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md
Chinese twin of the English note: translating that a standalone browser job rebuilding the whole repository was rejected because the existing Linux consumer job already owns that build and is part of the unified required verdict.

### .agents/notes/archived/testing/2026-08-12-required-python-runtime-pull-request-ci.i18n.yaml
Bilingual-pair consistency record: English `e7da767f22634bd50bc4fd38b1de34677c4124e7`, Chinese `702125b0da864eb35f1fe870748cc0e314b01a39`.

### .agents/notes/archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md
- Purpose: make the first-party Python distribution a **merge-time contract** rather than a release-time surprise.
- Key abstractions: the required `python-runtime` job in `.github/workflows/ci.yml`; the shared single-executable builder `.github/workflows/build-exe-for-python-sdk.yml`; the `node24-linux-x64` target; the manylinux 2.28 container; the concurrency key that includes the caller workflow.
- Data flow: the job calls the shared builder without a path filter, which builds the real executable, runs all keyless Python full-turn and direct-binary scenarios including both committed snapshots, builds the SDK and runtime wheels, installs them into a clean virtual environment, checks the executable and native addon's GLIBC requirements, and runs the installed wheels in a manylinux 2.28 container.
- Non-obvious design decisions: the real Python client, the packaged JSON-RPC executable, the executable-specific snapshot, release-shaped wheels and clean installation "meet only in the optional single-executable or Python release workflows", so a runtime event change could merge with a stale Python projection or a broken wheel path (line 10). Path filters or labels were rejected because Python behaviour depends on shared agent, session, workflow, subagent, plugin-loading and packaging code outside `python/`.
- Edge cases / failure handling: the required job and the publication workflow use the **same** builder, and the concurrency key includes the caller workflow so required CI and an explicit full release validation for the same ref do not cancel each other. The complete linux-x64 / linux-arm64 / macos-arm64 matrix stays a release validation, because one merge-blocking native carrier suffices for platform-independent behaviour while architecture-specific packaging still needs all targets.
- Surprising: the advanced executable snapshot normalises opaque session, message, subagent and workflow-run identifiers before comparison, so a newly persisted workflow event changes the reviewed expected output without making a random run identifier part of it.

### .agents/notes/archived/testing/2026-08-12-required-python-runtime-pull-request-ci.zh.md
Chinese twin of the English note: translating that running the snapshot against the development Node carrier "does not prove pkg assembly, the deployed runtime closure, native addon staging, wheel construction, exact dependency pins, or clean installation".

### .agents/notes/archived/testing/2026-08-13-python-minimal-model-visible-snapshot.i18n.yaml
Bilingual-pair consistency record: English `c97e92237c16a25d3b52a4af10c26fb6e48bb370`, Chinese `0baed199b6edf33ca2e72d4643718b4e46098cf3`.

### .agents/notes/archived/testing/2026-08-13-python-minimal-model-visible-snapshot.md
- Purpose: record **exactly what the standalone minimal profile shows the model**, in one file.
- Key abstractions: the `sdk-minimal` scenario in `scripts/smoke-python-runtime.py`; `scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json`; the shared snapshot comparison taking its directory and file set as arguments (`--update-snapshots` accepts `sdk-minimal`).
- Data flow: for every model request of the turn, the file records the advertised tool schemas **verbatim** and the message list. System and user messages keep their full text with the scenario's temporary directory tokenised; assistant and tool messages keep only call identity, because their PTY and filesystem text differs across replay platforms.
- Non-obvious design decisions: functional tool assertions prove execution but "do not reveal an added system section, tool description, or user-role context message", while the advanced executable snapshot replaces each request header's assembled system prompt with a token and each tool schema with its name (line 10). The profile omits dynamic runtime context, so **every** message it emits is compared.
- Edge cases / failure handling: snapshotting the minimal session log instead was rejected because the minimal turn drives a real PTY and editor, so persisted tool results carry platform-dependent text — the expected output would go red for reasons unrelated to model-visible assembly, and normalising that text away leaves the log carrying little the model-visible file does not. Extending the mock model's inline assertions was rejected because a failure would name one mismatch rather than the whole surface.
- Surprising: the note closes with a governance consequence — `AGENTS.md` and the testing policy now name both SDKs as independent projections of the agent loop, session lifecycle and `SessionEventMap`, so a change to any of those carries updating **both** expected outputs rather than only the one a contributor happens to run.

### .agents/notes/archived/testing/2026-08-13-python-minimal-model-visible-snapshot.zh.md
Chinese twin of the English note: translating that the minimal composition's tool descriptions become **reviewed expected output**.

### .agents/notes/archived/testing/2026-08-18-session-snapshot-envelope-projection.i18n.yaml
Bilingual-pair consistency record: English `9542330b16c4395837653a7c5118012be467e0d2`, Chinese `49cce9a60a9aa267391c35542230a0bd402713f8`.

### .agents/notes/archived/testing/2026-08-18-session-snapshot-envelope-projection.md
- Purpose: make committed session-snapshot diffs describe **behaviour**, not storage mechanics.
- Key abstractions: the envelope projection (omitting `seq`, `time`, `seq0`, `time0` from body rows); the untouched first `session` header; `parseSessionLog` as the replay entry point; the synthetic event-time anchor.
- Data flow: snapshot serialisation omits those four keys from the parsed body object before writing the line; snapshot comparison composes ordinary value normalisation with that projection, while generic log and stream normalisation retains sequence envelopes. Runtime persistence is unchanged.
- Non-obvious design decisions: the monotonic `seq` and wall-clock `time` fields are required by the durable runtime log, but their repetition "made reviewed snapshot diffs describe storage mechanics instead of changed behavior" (line 10). Changing runtime persistence to omit them was rejected because durable session validation, ordering and event relationships rely on complete sequence and time envelopes; keeping them but normalising to zero or positional numbers was rejected because every row would still carry non-behavioural noise and positional values would still churn after insertions.
- Edge cases / failure handling: the checked-in file is no longer byte-for-byte valid persistence JSONL, so replay consumers must use `parseSessionLog` rather than passing body rows to the storage decoder; the decoder assigns missing sequence fields in memory, synthetic event times start at zero, and packed `data.dt` values retain the relative gaps already stored. Nested fields with the same names are payload and remain unchanged.
- Surprising: publishing a shared session-snapshot codec package was explicitly rejected — "writers only delete four top-level fields while serializing, and replay only needs its existing session-log parser to accept the projected representation", so a new package and record-level API would "enlarge the change and create an ownership commitment without removing meaningful implementation".

### .agents/notes/archived/testing/2026-08-18-session-snapshot-envelope-projection.zh.md
Chinese twin of the English note: translating that replacing numeric payload references with semantic snapshot identifiers was rejected for this change because it would alter event payloads and require event-type-specific projection rules.

### .agents/notes/archived/testing/2026-08-27-translation-pairing-merge-budget.i18n.yaml
Bilingual-pair consistency record: English `b8b01f8647687fd2f0a1f30b0a63aafe5d5f910b`, Chinese `06e1d1ff356f582da8841d42035a8c13c5474ff0`.

### .agents/notes/archived/testing/2026-08-27-translation-pairing-merge-budget.md
- Purpose: stop a **host-contention spike** deciding a suite's outcome.
- Key abstractions: `scripts/translation-pairing-merge.spec.ts`'s `describe`-level `{ timeout: 15_000 }`; `DSH_COVERAGE_TEST_TIMEOUT_MS` in `.github/workflows/ci.yml`; the Windows coverage lane's `--testTimeout`.
- Data flow: every one of the suite's 23 cases builds a scratch repository and drives it through spawned `git` invocations, so the suite is bound by **process creation**, not by its assertions.
- Non-obvious design decisions: a `describe` value takes precedence over the runner flag rather than deferring to it, so the 15 s ceiling silently *lowered* what the lane's 90 s `--testTimeout` granted (line 18). The suite therefore takes `{ timeout: 90_000 }`, matching the lane.
- Edge cases / failure handling: the trade is stated honestly — the ceiling only decides when waiting stops, so a real slowdown from a few hundred milliseconds to tens of seconds now passes where the previous 15 s would have caught it. "That detection is traded away deliberately: the 15 s ceiling was firing on contention rather than on regressions, so what it caught was the shared volume, not the code."
- Surprising: the value is explicitly **not** a measurement of how long the cases need — the slowest three complete in roughly 0.7–1.2 s depending on the host, and raising the ceiling does not slow a passing run. Per-case allowances were rejected because twenty-three separate values restate one property of the machine and a later case added without one would silently inherit the lower ceiling again.

### .agents/notes/archived/testing/2026-08-27-translation-pairing-merge-budget.zh.md
Chinese twin of the English note: translating that retrying on failure "moves the failure to another case or another run and leaves a red gate that carries no information about the code under test".

### .agents/notes/archived/testing/2026-08-28-ci-test-reliability-skill.i18n.yaml
Bilingual-pair consistency record: English `c48cd48cab5d3fcedd55c1f47f45278ffad6e998`, Chinese `7251b38298adb95d2f1610bed757ac3feb971564`.

### .agents/notes/archived/testing/2026-08-28-ci-test-reliability-skill.md
- Purpose: give an agent a focused workflow for designing resource-owning tests against the real CI topology, and for classifying a probabilistic failure *before* changing code.
- Key abstractions: the `dsh-ci-test-reliability` skill (`skills/dsh-ci-test-reliability/SKILL.md`) and its separate diagnosis-only reference; the `dsh-pre-push-checks` and `dsh-code-review` skills that conditionally consult it.
- Data flow: the skill requires modelling concurrency beyond one Vitest process, allocating live resources atomically, separating stable fixture identities from ephemeral transport addresses, synchronising on observable state, restoring global mutations exactly, and awaiting teardown to quiescence.
- Non-obvious design decisions: process isolation does **not** isolate host ports, predictable paths, external namespaces or inherited children, and process-global mutations plus incomplete teardown can contaminate later tests — "a test can select the correct tier and still pass only when it runs alone" (line 10). Regression evidence must match the owned risk: negative controls for guards, deterministic barriers for races, concurrent independent processes for host-resource isolation, and external observations instead of component self-reports.
- Edge cases / failure handling: two rules cover failures the repository has actually paid for. A value the operating system owns is not guaranteed to return as written, so a test may write one back only where the assertion tolerates that write-back failing; where the assertion depends on it, the expected value comes from a fresh read. And a suite timeout overrides the runner flag rather than yielding to it, so a suite bound by process creation takes the lane budget, raises the hook budget with it, and keeps an outer wait far larger than any timeout under test.
- Surprising: the skill is **advisory**, so the note concedes it "cannot mechanically prevent every resource collision", and a repeated, statically identifiable defect can still justify an executed repository check. A generic stress runner or regex gate was rejected immediately because "repeated green runs do not prove a race is controlled, and literal ports, paths, sleeps, and URLs can be valid parser inputs or expected values".

### .agents/notes/archived/testing/2026-08-28-ci-test-reliability-skill.zh.md
Chinese twin of the English note: translating that the diagnosis-only workflow lives in a separate reference so ordinary authoring does not load Actions triage procedure.

### .agents/notes/archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.i18n.yaml
Bilingual-pair consistency record: English `414d9b32fa4a80a5f690659213246e10daa42177`, Chinese `9589134e954d7b1491d35f5430c96f9f20935396`.

### .agents/notes/archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md
- Purpose: stop Windows-runner contention deciding a suite's outcome, in the case body *and* in its teardown.
- Key abstractions: `scripts/install-lefthook.spec.ts`'s `describe`-level `{ timeout: 30_000 }` and its restated `MULTI_PROCESS_TEST_TIMEOUT_MS` constant; `coverageTestTimeoutArgs` in `scripts/coverage-partitions.ts`; `DSH_COVERAGE_TEST_TIMEOUT_MS`; `removeFixtureSafely`'s documented 10-second Windows handle-release retry window.
- Data flow: every Lefthook case builds scratch worktrees and drives them through spawned Git and Node subprocesses, so the suite is bound by process creation; `coverageTestTimeoutArgs` now emits `--testTimeout`, `--expect.poll.timeout` **and** `--hookTimeout` from the same environment variable.
- Non-obvious design decisions: raising only the test budget "moves a contended suite's failure from the case to its teardown rather than removing it" (line 14) — because setup and teardown pay the same contention the raised budget accounts for, and an `afterEach` exercising the 10-second cleanup window met the hook default exactly. The per-case constant was deleted rather than raised, because it restated the `describe` value and per-case allowances let a later case silently inherit a different ceiling.
- Edge cases / failure handling: the trade is stated plainly — both budgets widen what counts as an acceptable duration, so a real slowdown into tens of seconds now passes where the previous ceilings would have caught it; "those ceilings were firing on host contention rather than on regressions". A dedicated `--hookTimeout` variable was rejected because two knobs describe one property of the host.
- Surprising: the note records the *floor* as well as the ceiling — on an idle macOS host the slowest Lefthook case costs 7.5 s (roughly fourfold headroom), while the translation-pairing suite fired at 15 s with more than tenfold headroom, which is why the two suites failed for different reasons and were fixed separately.

### .agents/notes/archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.zh.md
Chinese twin of the English note: translating that shortening the `removeFixtureSafely` retry window would trade a cleanup failure for temp residue on the shared self-hosted /tmp, which has twice exhausted the host's inode capacity.

### .agents/notes/archived/testing/2026-09-06-client-assembly-test-line.i18n.yaml
Bilingual-pair consistency record: English `163f3ce63aee65055d995c12d81966f2dff98990`, Chinese `1dc6d07632caa21be9c87f2e8656a8152a013390`.

### .agents/notes/archived/testing/2026-09-06-client-assembly-test-line.md
- Purpose: replace ~40-line hand-built browser benches with a tier that boots the **real** client composition.
- Key abstractions: `@deepseek-ai/dsh-client-test-runtime` (`src/assembly/`) and `@deepseek-ai/dsh-remote-mock`; `bundleRoster(bundles)`; `webApp.closure([row])` / `pick` / `without`; `TestClient.start(plan, mock)`; `installConnection(ctx, { transport: { rpc: mock.rpc } })`; the `pendingQueue` registration facade; `bootClient` / `mountClient` / `tearDownEntryFiber`.
- Data flow: `bundleRoster` parses each bundle's `dsh.bundle.patch` with the include plugin's own `entryListSchema` and composes the layers with its `applyEntryPatches`, keeping every enabled row whose package declares `dsh.client.platform === 'web'`. `TestClient.start` loads each row's `/client` module, replaces the Connection row's page-global adapter, registers the resulting factories through the production facade's `pendingQueue`, boots through `bootClient`, optionally mounts through `mountClient` and waits for `connected`.
- Non-obvious design decisions: the roster is read **from the bundles, never copied** — a generated static roster module with a drift gate was rejected as "a copy of bundle data inside the test package" where every subset is a hand-list that misses rows (line 20). The old API-client fake re-implemented Gateway semantics it should only exercise (follow-stream snapshots derived from a history list, page cuts, stream pumps with delivery promises, an envelope layer), which "lets tests describe behavior the generated client cannot produce, such as a unary call that rejects". The `remote.<ns>` surface is a **contract-free Proxy**, not the generated client, because the generated clients exist only in built `lib/`.
- Edge cases / failure handling: unary rejections fold through the Gateway client's exported `carrierFailure` / `cancelledFailure` so product code that fires a Remote call without awaiting sees no rejection. `dispose()` fails the test on any endpoint that had no rule, and `remoteDefaultResponses` must gain a row when a plugin adds a boot-time call — "fails loud until it does". jsdom lacks `EventSource` and `ResizeObserver`, so `start` reference-counts inert stand-ins only where the global is absent. Module systems, Connection carriers, Remote mocks, reloads and disposal are instance-owned so clients start concurrently without page globals.
- Surprising: the note keeps an explicit **Deferred** list of product facts the tier surfaced but left as they are — no `declare module` augmentation for `Context.connection`, no page-URL option on `TestClient.start`, and a durable event pushed twice with the same seq dropped as a replay at the tail of `RemoteJournalStream` and never reaching `SessionQueueMirror.acceptDurable`. It also flags that the two web bundle names are repeated once in `WEB_PROFILE_BUNDLES` with no check linking the two, because the test program cannot import the Host's `Context`.

### .agents/notes/archived/testing/2026-09-06-client-assembly-test-line.zh.md
Chinese twin of the English note: translating the eleven rejected alternatives, including a worker-level boot turn around a page-global Connection carrier (which would make clients share mutable process state).

### .agents/notes/archived/testing/2026-09-06-pr-ci-runner-temporary-storage.i18n.yaml
Bilingual-pair consistency record: English `9faeaa088649d053c3d293ff5ec5282d4fd29d90`, Chinese `2a4355412286a8a76b404e367c217d5a1838a2a0`.

### .agents/notes/archived/testing/2026-09-06-pr-ci-runner-temporary-storage.md
- Purpose: give PR CI temp files a **job lifetime** instead of letting them accumulate on a shared failover volume.
- Key abstractions: `TMPDIR=runner.temp` exported through `GITHUB_ENV` in the first step of the static, coverage and consumer jobs; `RUNNER_TEMP`; the npm cache at `$HOME/.npm` and the shared pnpm store at `$HOME/.local/share/pnpm/store`.
- Data flow: Node, Vite, tsx and temporary test consumers inherit the runner-owned location; each runner owns its directory and GitHub Actions clears its removable contents at job start and completion, while fixtures still allocate unique children and retain their own cleanup.
- Non-obvious design decisions: files outside the runner's temp directory escape job cleanup, "including when cancellation prevents process-level disposal", so exhausting the shared directory makes unrelated PRs fail *before tests execute* (line 10). Package-manager caches deliberately stay shared (they rely on the package managers' concurrent-access support), and shared-cache capacity remains an operational responsibility.
- Edge cases / failure handling: the note also records four fixture-level consequences: the recorded ACP diagnostic scenario releases its child only after the jobs service registers the completion waiter (so a fast child cannot publish a legitimate job notice between recorded parent steps); the headless `session-sandbox-root` fixture uses `workspace.parent: outside-temp` so its write does not succeed through a temporary-directory exemption; the advanced Python snapshot pauses its workflow child until the parent's durable membership event is observed, supporting either arrival order; and the concurrent spill isolation test keeps each root paired with its run result rather than assuming filesystem allocation order matches input order.
- Surprising: the sandbox boundary is stated explicitly — Linux bwrap and Landlock grant **literal `/tmp`** and the workspace, not an inherited `TMPDIR` outside it, so confined fixtures must place temporary writes in those granted paths; and the snapshot spill helper separates fixed-length logical locators from atomically allocated live storage so no file is allocated at the logical `/tmp/dsh-acp-snap-*` prefix.

### .agents/notes/archived/testing/2026-09-06-pr-ci-runner-temporary-storage.zh.md
Chinese twin of the English note: translating that the parsed-workflow cases require the TMPDIR assignment on all three workers and reject step-level overrides, and that the YAML assertions alone do not prove host capacity.

### .agents/notes/archived/testing/2026-09-06-python-runtime-install-retry.i18n.yaml
Bilingual-pair consistency record: English `2fbb17afbcbc7ed0095256a5753d27273720585f`, Chinese `e1b20eab4ff066b7df90c8aeaee51cc99cd8d9ca`.

### .agents/notes/archived/testing/2026-09-06-python-runtime-install-retry.md
- Purpose: absorb a **transient external** install failure without a human rerunning the lane.
- Key abstractions: the `Install (immutable)` step running `pnpm install` on every target; `pnpm install --frozen-lockfile`; `bash` on every platform (Git Bash on hosted Windows images).
- Data flow: the step retries the frozen-lockfile install up to three attempts total with a ten-second pause between failures; success on any attempt ends the step immediately, and the diagnostics remain the pnpm output captured inside the step.
- Non-obvious design decisions: install-time native build downloads fetch Node headers from nodejs.org, and that endpoint stalls intermittently — on 2026-09-06 the hosted `node24-macos-x64` cell failed when the `fs-ext` build's node-gyp download raised `ConnectTimeoutError` after a 10-second connect timeout (line 10). The retry mirrors the Wine lane's documented bounded-transfer policy without pulling in a mirror, because these installs also resolve native addons whose second-download source matters.
- Edge cases / failure handling: a file-lock check or native-build error that would fail every attempt still fails the step after the bounded budget — so the retry costs at most two extra attempts (~20 s) on a transient stall while a deterministic defect still fails loudly. Increasing the connect or job timeout was rejected because a longer timeout still fails when the endpoint is down.
- Surprising: manual job reruns were rejected as the lane's standing remediation — "it costs a full lane cycle and stays manual; the bounded retry absorbs the transient while a sustained outage still fails loudly".

### .agents/notes/archived/testing/2026-09-06-python-runtime-install-retry.zh.md
Chinese twin of the English note: translating that a mirror was deferred because the Python runtime lane would need a per-target mirror and its own checksum authority.

### .agents/notes/archived/testing/2026-09-06-standard-hosted-benchmark-runner.i18n.yaml
Bilingual-pair consistency record: English `9ebf9868ef1ccd7e73e6a5bafac6af5eaf65ffaa`, Chinese `7f3af61c66939bc14ecdfd70c23431c87493c4f7`.

### .agents/notes/archived/testing/2026-09-06-standard-hosted-benchmark-runner.md
- Purpose: give wall-clock performance checks an **isolated, consistent** measurement lane.
- Key abstractions: the required benchmark job in `ci.yml`; the enterprise Linux failover switch; the standard GitHub-hosted `ubuntu-24.04` runner; `DSH_GATE_VERBOSE=1`; the endpoint-specific 50 ms expectation with 1.25× headroom (63 ms limit) for current-generation `open`.
- Data flow: the benchmark job uses the standard hosted runner independently of Linux failover, always attempts to restore the pnpm store cache, and retains a standalone benchmark lane; the complete job has a 15-minute timeout covering setup, installation, builds and measurements.
- Non-obvious design decisions: routing the measurements through the enterprise failover switch "makes their measurements depend on either larger hosted capacity or a shared self-hosted VM, while also consuming capacity needed by parallel correctness checks" (line 10). The 15-minute job timeout bounds **infrastructure execution, not an individual performance assertion**.
- Edge cases / failure handling: only current-generation `open` uses the endpoint-specific limit; all other performance budgets and the worker, test and hook deadlines remain unchanged, and successful raw measurements stay in the Actions log through the step-local verbose flag. The hardware-comparison workflows keep their deliberately different runner sizes.
- Surprising: the note insists on evidence discipline — "each runner change needs an actual hosted benchmark run before its job timeout is treated as validated; local workflow assertions alone cannot establish execution time", and the owning workflow tests pin runner routing, unconditional cache restoration, required status and the job timeout, with negative controls rejecting failover routing, a cache condition and the former 30-minute bound.

### .agents/notes/archived/testing/2026-09-06-standard-hosted-benchmark-runner.zh.md
Chinese twin of the English note: translating that increasing performance thresholds without endpoint measurements "conflates a bounded CI execution with a regression allowance".

### .agents/notes/archived/testing/2026-09-07-publint-test-subprocess-lifetime.i18n.yaml
Bilingual-pair consistency record: English `8e3430d1a357b6b903b980c248e469907b85974c`, Chinese `9f4f20a358c86f2d8d17df7da19a28c03694a231`.

### .agents/notes/archived/testing/2026-09-07-publint-test-subprocess-lifetime.md
- Purpose: make a test's subprocess lifetime obey the **execution lane's** budget rather than a private constant.
- Key abstractions: `scripts/publint-all.spec.ts`; the existing `execa` dependency; Vitest's test-context signal; `DSH_COVERAGE_TEST_TIMEOUT_MS` via `scripts/coverage-partitions.ts`.
- Data flow: each direct Node child is registered immediately, cancellation requests SIGKILL, and teardown awaits every owned child's result **and** close event before removing private package roots. Process errors, cancellation, timeout flags, signals and captured streams are diagnosed before expected exit codes are interpreted.
- Non-obvious design decisions: the spec used to carry a five-second synchronous subprocess deadline *below* the Windows coverage lane's 90-second test and hook budgets; the captured failures reported a null status in both the valid and invalid JavaScript/CSS cases with the valid case taking 5028 ms — and because the logs "omit the subprocess error and signal, they do not establish ETIMEDOUT", the note classifies it as "a shared test defect, not evidence that a product change caused the failures" (line 10). The fix is to have **no** independent subprocess timeout.
- Edge cases / failure handling: returning after kill was rejected — process and pipe closure must precede fixture removal. An ordinary exit code of one remains valid for the negative publint cases, and all five cases invoke the real script with isolated publication fixtures.
- Surprising: the note separates platform evidence honestly — "native Windows CI remains the owner of Windows termination and filesystem evidence; macOS results do not establish those guarantees" — and adds a readiness-gated deadline regression that cancels two live children and checks both closure events, dead PIDs and informative diagnostics.

### .agents/notes/archived/testing/2026-09-07-publint-test-subprocess-lifetime.zh.md
Chinese twin of the English note: translating that preloading or replacing publint would not exercise cold script imports and the real publication checks.

### .agents/notes/archived/testing/2026-09-07-pwsh-ci-observable-completion.i18n.yaml
Bilingual-pair consistency record: English `bb77be62e8d77c10749adb386d5a127eec5e76ac`, Chinese `6516febde66bb05373e29a2fac421835ebccd758`.

### .agents/notes/archived/testing/2026-09-07-pwsh-ci-observable-completion.md
- Purpose: make the PowerShell tests prove **execution**, not merely silence, and stop the snapshot fixtures from drifting from the shipped profile.
- Key abstractions: `packages/terminal/terminal-bash/tests/local.spec.ts`'s real-shell test; the `inferred_idle` vs `stdin_read` readiness tiers; the private-file barrier; `snapshots/session/pwsh-tool-turn` and `persistent-pwsh-tool-turn` with their owned header pins.
- Data flow: the test accepts either supported readiness tier, rejects timeout and exit settlements, and observes formatted child output in scrollback to prove environment persistence, current directory and credential scrubbing. The expected text is **absent from the submitted command**, so it cannot be satisfied by the echo. A private-file barrier holds execution beyond the silence settlement and releases it only after the next send settles.
- Non-obvious design decisions: output silence is "a supported bounded inference, not proof that a command finished", and the old test searched the output for text present in the echoed command, "which cannot independently prove execution" (line 10). Increasing silence or handoff timeouts was rejected because that changes latency without making readiness deterministic.
- Edge cases / failure handling: the barrier proves that later output remains observable **without extending production timings**, and session disposal precedes removal of the private test directory. The snapshot fixtures were refreshed through the built headless profile with a real PowerShell executable and recorded model replies, so policy events and available tools stay visible in the expectations while the tool result and final answer remain `PWSH_OK` and `DONE`.
- Surprising: hosts without PowerShell skip these cases and therefore **cannot detect that drift** — a standing coverage hole the note names explicitly rather than papering over.

### .agents/notes/archived/testing/2026-09-07-pwsh-ci-observable-completion.zh.md
Chinese twin of the English note: translating that "real PowerShell is required for this evidence; a skipped local run is not validation".

### .agents/notes/archived/testing/2026-09-07-subagent-teardown-test-budgets.i18n.yaml
Bilingual-pair consistency record: English `2a1049bdecfaabc172bb607fab4b25c7845d2acd`, Chinese `2650b3057fe35aab5cfe73b85e40851644e58e24`.

### .agents/notes/archived/testing/2026-09-07-subagent-teardown-test-budgets.md
- Purpose: make subagent teardown failures mean something, by removing local deadlines that outrank the lane's budget.
- Key abstractions: `packages/subagent/subagent-acp/tests/subagent-acp.spec.ts`; `packages/subagent/subagent-codex/tests/real-product.spec.ts`; `vitest.config.ts` applying the lane budget to every inline project; `coverageTestTimeoutOptions` in `scripts/coverage-partitions.ts`.
- Data flow: the ACP test awaits disposal under the execution lane's test budget, then checks the actual child outcome; a deferred exit observation proves that disposal cannot finish merely because termination was requested. The Codex test inherits the lane's hook budget; its cleanup captures contexts, HTTP fixtures and temporary roots **before its first asynchronous wait**, waits for every captured disposer, and attempts the remaining cleanup stages after a rejection.
- Non-obvious design decisions: neither deadline tested a product latency guarantee — the Codex body had already observed process-tree exit before its hook failed, and the log did not identify whether context disposal, HTTP closure or temporary-directory removal exceeded the hook budget (line 10). The cleanup order therefore matters: resources are captured first so "an overdue hook cannot drain resources registered by another test".
- Edge cases / failure handling: collected errors identify each failing stage or path and retain their causes, and cleanup reports them only after **all** captured resources have been attempted. Production EOF and termination grace periods remain unchanged, and the change "does not establish a Windows process-kill or filesystem defect".
- Surprising: the note insists that a passing macOS run proves nothing about Windows: "native Windows runs remain necessary for taskkill, process-exit delivery, and NTFS removal evidence".

### .agents/notes/archived/testing/2026-09-07-subagent-teardown-test-budgets.zh.md
Chinese twin of the English note: translating that returning from cleanup immediately after requesting termination "would permit children or sockets to outlive the fixture".

### .agents/notes/archived/testing/2026-09-08-ci-completion-observations.i18n.yaml
Bilingual-pair consistency record: English `c2d8fa0f0fe9e691cfa6e0d87c9fda0a8b5abdfe`, Chinese `97d64030ffa6f532904c440226c46e3d757a0f92`.

### .agents/notes/archived/testing/2026-09-08-ci-completion-observations.md
- Purpose: give each flaky CI fixture an **explicit completion condition** and controls that stop an intermediate state from satisfying it.
- Key abstractions: HTTP 202 vs durable completion; private file barriers; the `turn/end` observation; `handleControlFrame`; `RemoteJournalStream`; the scoped resolve/load hooks in the Node import sweep.
- Data flow: the GitHub review browser test holds real Workspace creation after HTTP 202, verifies that neither the Agent nor the model request exists, then releases creation and awaits the matching Session's `turn/end`; cleanup releases the barrier, restores the method and removes the event listener **even when the test times out**. The PowerShell executor tests hold startup and consuming reads at private file barriers and read the final stdin/environment output after `done`.
- Non-obvious design decisions: "HTTP acceptance, projected UI state, process startup, and durable completion are separate observations" (line 10), so each fixture owns its clocks, barriers, callbacks, processes and temporary paths. The queued-image test separately holds admission and attachment retrieval, then captures the admitted row's loaded thumbnail; cleanup shares one promise, releases held requests and drains their handlers before closing the browser.
- Edge cases / failure handling: the Details Session-lifecycle test awaits the frame's captured animation promises after the closed state appears and then checks the zero-width track — "cancelled transitions also reach that assertion; animation settlement cannot make a persistent nonzero track pass". The LSP backpressure test verifies the pending write callback settled and the captured subprocess completed **before** accepting the abort error, because `instance.dead` alone can be true as soon as disposal starts.
- Surprising: the built-client import classification admits the Dockkit bundle **only** when Node reports `ERR_UNKNOWN_FILE_EXTENSION` for a `.css` file, and fails every other error and every unexpectedly successful exempt import — a whitelist-with-negative-control rather than a blanket exemption.

### .agents/notes/archived/testing/2026-09-08-ci-completion-observations.zh.md
Chinese twin of the English note: translating the five rejected alternatives, including "controlled samples replacing real execution" (timer samples alone cannot verify process launch, control transport or managed cleanup).

### .agents/notes/archived/testing/2026-09-08-ci-readiness-and-completion.i18n.yaml
Bilingual-pair consistency record: English `1abe3e2b2f655b0622ee0288800364a473f51c84`, Chinese `8bac86c815d3343129ae0294debe680a076514b6`.

### .agents/notes/archived/testing/2026-09-08-ci-readiness-and-completion.md
- Purpose: replace short, arbitrary waits with waits on **owned completion**.
- Key abstractions: the six named fixtures (webhook browser test, feedback test, desktop transaction test, PowerShell tests, publint runner tests, LSP instance test, ACP disconnect tests, SDK subagent protocol-error test, Inspector tree tests); `vitest.config.ts`'s per-project budget; `coverageTestTimeoutOptions`.
- Data flow: the webhook test observes the model request caused by delivery before checking Session registration; the feedback test waits for the empty composer and enabled attachment control before comparing ARIA output; the desktop transaction test gives the worker readiness marker the active test's execution budget and its independent `afterEach` releases and awaits workers before deleting private roots, including when the runner abandons a timed-out test body.
- Non-obvious design decisions: the tests were failing because they measured **cold-start latency guarantees** rather than behaviour — a one-second webhook wait, a five-second PowerShell read, five- and three-second helper limits inside a 90-second lane budget, a one-second registry poll after transport failure (line 12). "Matching consecutive snapshots cannot prove that the command RPC has settled: its event stream can publish the acknowledgement first" — so the composer must be observed empty.
- Edge cases / failure handling: the ACP disconnect tests await the **real session handle disposer** for both EOF and transport failure, with a barrier holding disposal pending while ownership is checked, and neither case invokes plugin disposal to trigger the behaviour under test. The Inspector tree tests register cleanup while startup is still pending, because "a cancelled test cannot receive a late-ready handle". Teardown reports transaction failures independently from assertion failures.
- Surprising: the note catalogues the **contaminated measurement** problem — several helpers imposed five- and three-second limits inside the lane's 90-second test budget — and the fix is uniform: use the active test's budget, observe the specific promise that owns the completion, and never a separate polling deadline that "continues to compete with the execution lane's budget".

### .agents/notes/archived/testing/2026-09-08-ci-readiness-and-completion.zh.md
Chinese twin of the English note: translating that serialising CI or retrying these tests was rejected because neither establishes the missing completion condition nor releases a blocked child after an assertion failure.

### .agents/notes/archived/testing/2026-09-09-user-patch-hmr-test-delivery.i18n.yaml
Bilingual-pair consistency record: English `0c395b86ecaf07fe0f75432428c1b2b4f19ca4c5`, Chinese `1c479e29885c9e4c99c77891e597ec7e73362191`.

### .agents/notes/archived/testing/2026-09-09-user-patch-hmr-test-delivery.md
- Purpose: stop OS notification delivery from gating the **parser/activation/recovery** assertions the HMR test owns.
- Key abstractions: `packages/boot/app-boot/tests/user-patches.spec.ts`; a Chokidar watcher without native watch handles; `packages/boot/hmr/tests/watch-config.spec.ts`; the non-transactional Loader policy (no plugin rollback).
- Data flow: the user-patch test writes real patch files and delivers their add, change and unlink events through the Chokidar watcher; app-boot watcher registration, refresh serialisation, Include recomposition, plugin activation, failure reporting and recovery remain real. The fixture restores its watcher factory and disposes the Context even when setup fails before the local cleanup block.
- Non-obvious design decisions: native notifications for every refresh assertion were rejected because it "repeats the native delivery dependency across each parser and activation state transition", and a missing event then obscures which downstream behaviour is broken (line 20). Polling and fixed settling delays were rejected because neither acknowledges delivery of the *next* edit — Chokidar readiness does not expose completion of Node's asynchronous initial polling baseline, and a local polling reproduction still missed changes.
- Edge cases / failure handling: the separate watcher tests own native delivery (add/change/unlink, initially absent parents, filesystem aliases) and, before their first write, close a second `fs.watch` directory handle, which on darwin blocks until libuv has rebuilt the FSEvents stream that Chokidar readiness does not wait for; their polling deadline is the case's effective budget. The refresh test explicitly does not establish operating-system delivery guarantees.
- Surprising: "increasing the test deadline cannot recover an event that was never emitted" — the note names the failure mode (a macOS Sandbox run timing out waiting for the first user-patch addition, with concurrent local reproductions showing no filesystem notification reaching HMR) and splits ownership rather than papering over it with a longer wait.

### .agents/notes/archived/testing/2026-09-09-user-patch-hmr-test-delivery.zh.md
Chinese twin of the English note: translating that mocking HMR registration or Include was rejected because the test must retain real recomposition, activation failure reporting and the running configuration after parse failures.

### .agents/notes/archived/testing/2026-09-10-hosted-image-test-assumptions.i18n.yaml
Bilingual-pair consistency record: English `784d31b19f0cec2519fc335e7f5d3df89b855285`, Chinese `6b605fe7d96e27f36af98cfbcc5ddf6fd9a6a4e9`.

### .agents/notes/archived/testing/2026-09-10-hosted-image-test-assumptions.md
- Purpose: make each coverage case declare the **host properties** it depends on, so an unfamiliar runner image cannot decide the result.
- Key abstractions: `internals = { platform: 'darwin' }`; `probeLinuxNative`; `packages/subprocess/subprocess-local/tests/local.spec.ts`; `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts`; `packages/experimental/ptc-runtime-python/tests/stray-fragments.spec.ts`; the Windows folder-dialog smoke probing `CoCreateInstance(CLSID_FileOpenDialog)` through PowerShell.
- Data flow: terminal tests with mocked PTY exits select fallback containment explicitly; cases that do not exercise platform selection pin `platform: 'darwin'`, and the terminal-release lifecycle case leaves the platform unset and makes `probeLinuxNative` return false — exercising the host's default platform selection without starting a real Linux scope. The illegal-UTF-8 residual cases pace their writes with `time.sleep(0.001)`.
- Non-obvious design decisions: the failures were caused by host properties the cases never named — whether the host offered a usable user-systemd scope, a managed scope reporting a signal failure during ACP teardown, a starved reader coalescing writes the residual cases assumed arrived as separate chunks, and a Windows Server image refusing `CoCreateInstance(CLSID_FileOpenDialog)` outright (line 10). A probe mock alongside the platform pin is redundant because the pin selects fallback before the native probe is called.
- Edge cases / failure handling: the ACP dispose case asserts the **settlement contract** rather than one winner of the spawn-failure/teardown race — a bootstrap that published its pre-exec failure rejects with that failure, while a teardown that stopped the bootstrap first settles as the requested `SIGTERM`. The UTF-8 payloads stay above the bound (3200 bytes for the `0xFF` case, 1100 `ED A0 80` sequences for the CESU-8 case) so the undercount still flushes above 2048. The Windows probe reads every exception as refusal, so a host failing the probe for another reason only loses the real-dialog case.
- Surprising: the note reports hosted-image evidence by run id (34449848541 red, 34457655892 green with the diff plus the 90000 ms lane budget) and states the wall-clock cost openly — the ACP dispose case ~10 s and each residual case ~3.5 s per run.

### .agents/notes/archived/testing/2026-09-10-hosted-image-test-assumptions.zh.md
Chinese twin of the English note: translating that excluding the coverage lanes from the hosted leg was rejected because the failures named real host dependencies rather than a suite the pool cannot support.

### .agents/notes/archived/testing/2026-09-12-connection-and-compaction-fixture-preconditions.i18n.yaml
Bilingual-pair consistency record: English `ab7e0989db489e7f457a56061567e49886feb58a`, Chinese `8810fc279955dcd7d0fb035960259e0824aec288`.

### .agents/notes/archived/testing/2026-09-12-connection-and-compaction-fixture-preconditions.i18n.yaml
(none — see the ledger; this note has no separate English sibling in the shard beyond the mirrored `.md`/`.zh.md` pair above and below.) The file itself is the pairing record: English `ab7e0989db489e7f457a56061567e49886feb58a`, Chinese `8810fc279955dcd7d0fb035960259e0824aec288`.

### .agents/notes/archived/testing/2026-09-12-connection-and-compaction-fixture-preconditions.md
- Purpose: establish the **preconditions** the connection and compaction fixtures need, instead of asserting on an intermediate state.
- Key abstractions: `apps/web/tests/lifecycle-chrome.e2e.ts`; the CSS transition clock vs the mocked JavaScript retry-timer clock; `apps/cli/tests/profiles/headless/tests/compaction.e2e.ts`; the 8,000-token synthetic context window with compaction at 50% usage; the nonshrinking-checkpoint rejection.
- Data flow: the connection test reads the warning colour tokens from an **independent element**, then polls the indicator's computed foreground and background until both equal those tokens. The compaction smoke completes each file-reading turn before submitting the next; each file contains 200 repetitions of its numbered sentence (4,600 characters).
- Non-obvious design decisions: "a reconnect label can appear while its hover color is still transitioning", and "browser CSS transitions use a different clock from the mocked JavaScript retry timers" (line 14) — so a fixed delay or a disabled transition would either not observe completion or remove the production behaviour involved in the failure. In the compaction fixture, the 4,000-token pressure threshold is met because one completed read used 2,738 request tokens including 1,274 outside the conversation surface.
- Edge cases / failure handling: a failing calibration run selected about **60 tokens** of initial instruction but produced a **475-token** framed checkpoint, and "the runtime correctly rejected that larger replacement" — the nonshrinking rejection is the behaviour under test, so the fixture must provoke it. Separate completed turns prevent all four reads from becoming one retained tool group, which would leave nothing substantial to summarise. Failure output includes the recorded compaction errors, while the test still requires a summary, replaced history and a final answer.
- Surprising: the note refuses to "only enlarge the synthetic context window" — a model can still batch the reads into one retained tool group — and refuses to accept a nonshrinking checkpoint, so both the framing rule and the batching hazard have to be handled together.

### .agents/notes/archived/testing/2026-09-12-connection-and-compaction-fixture-preconditions.zh.md
Chinese twin of the English note: translating that "more time cannot make a short instruction larger than checkpoint framing", so the runtime's nonshrinking rejection remains required.

### .agents/notes/archived/testing/2026-09-26-web-conversation-clock-fixture-day.i18n.yaml
Bilingual-pair consistency record: English `1984219fc0850ca59c64b4f2864f790a63164d84`, Chinese `6ecdb4cfbefe49fbd15ebea1d5a59f2cc1595ef2`.

### .agents/notes/archived/testing/2026-09-26-web-conversation-clock-fixture-day.md
- Purpose: stop a run six minutes before local midnight from turning four browser scenarios red.
- Key abstractions: `newEnglishPage` pinning the browser to `Asia/Shanghai`; `formatMessageClock` prefixing `clock.md`/`clock.ymd` when the message's local calendar day or year differs from the renderer's; `WEB_FIXTURE_TIME`; `pinHostClock()`; `pinBrowserClock(page)`; `seedSession`'s `createdAt` argument; `PROCESS_TITLE_MINIMUM_MS` = 150 ms; the composer keymap's 10 ms composition guard.
- Data flow: live-stamped scenarios pin the Host clock with a `Date.now` spy advancing from the anchor with real elapsed time and the browser clock with `pinBrowserClock`; seeded scenarios anchor the seed through `seedSession`'s `createdAt` and pin the browser clock the same way. `pinBrowserClock` **re-applies one frozen instant from the anchor on an interval** rather than leaving it at a single value.
- Non-obvious design decisions: the failing job started at 15:54Z, six minutes before local midnight, "so rows stamped before it were captured after it and rendered a date prefix; the next run of the same scenario passed minutes after midnight" (line 12). The clock is re-applied rather than frozen because product code reads two `Date.now()` values to decide how long a rendered value is held — the step process keeps its previous title for 150 ms and the composer keymap keeps a composition guard 10 ms past `compositionend`; a permanently frozen clock never advances, so the hold never elapses and the golden's settled text stays unrendered.
- Edge cases / failure handling: the seed anchor is not only the rendered clock — the sidebar's relative ages are computed against the browser clock, so a pinned browser with a live-anchored seed reads `8mo` where the fork golden asserts `now` and `1min`. The steering mid capture waits for the settled question title before capturing, and the whole-queue scenario calls the queue gesture only after the running turn's Stop control appears.
- Surprising: collapsing the date prefix in `normalizeAria` was **measured and rejected** — a two-line change passed the four files and then failed `cordis-tool-round`, `stats-paged-history` and `navigation-panes`, because their goldens deliberately record the dated form (`9/1 {{clock}}`); "the two renderings state different facts — this row is from another day, this row is from today — so collapsing them deletes assertions instead of stabilizing them".

### .agents/notes/archived/testing/2026-09-26-web-conversation-clock-fixture-day.zh.md
Chinese twin of the English note: translating that pinning the clocks for the whole lane was rejected on blast-radius grounds (83 goldens carry a clock and session-tree goldens assert literal relative ages).

### .agents/notes/archived/testing/2026-09-27-oxlint-contract-spawn-case-budgets.i18n.yaml
Bilingual-pair consistency record: English `ccfaa054a5c201350e0c92ef75c9ae62ebe3013f`, Chinese `7170e37ef876b595d57b27e28bf53849116102ef`.

### .agents/notes/archived/testing/2026-09-27-oxlint-contract-spawn-case-budgets.md
- Purpose: size the timeout of every process-spawning contract case to the **execution lane**, not to Vitest's default.
- Key abstractions: `scripts/oxlint-contract.spec.ts` (14 cases, 12 spawning); `runOxlint` / `runRepositoryOxlint` (which boots `scripts/run-oxlint.ts` under tsx and runs oxlint twice under `--fix`); `DSH_COVERAGE_TEST_TIMEOUT_MS`; the darwin parity job in `sandbox.yml`.
- Data flow: the spawning cases run the real oxlint CLI or the repository lint entrypoint; each carries an explicit per-case `90_000` ceiling, while the two configuration-only cases (`keeps the complete stylistic contract in Oxlint`, `keeps repository lint workflows Oxlint-only`) spawn nothing and keep Vitest's default.
- Non-obvious design decisions: the value is "a completion ceiling for a hang, not a latency target" — the slowest case on the slow darwin runner took 9507 ms and the file peaked at 20767 ms under six-fold CPU oversubscription, both under a quarter of the ceiling (line 14). A `describe`-level value was rejected because case-level values already bound seven cases and take precedence, so a suite-level number would leave two budget styles in the file.
- Edge cases / failure handling: the rejected alternative "pass `--testTimeout 90000` to the darwin parity job and let the cases inherit the lane budget" was rejected because the cost is the file's own tsx boot plus two oxlint runs, not a darwin property — so a developer's plain `pnpm run test` would keep the default, and the parity job exists to run the same command developers run. A tighter 6.3 s value was rejected because the Windows contention fires as multi-second spikes that rotate across cases.
- Surprising: the note names the residual risk explicitly — "a spawning case added later without its own `90_000` runs on the default until the file's inventory is checked" — and cites the reproduction: under 72 busy-loop processes on a 12-core host the unbounded fix-retry case reproduced `Test timed out in 5000ms` at 7084 ms before the change and passes with the ceiling after it.

### .agents/notes/archived/testing/2026-09-27-oxlint-contract-spawn-case-budgets.zh.md
Chinese twin of the English note: translating that raising Vitest's global `testTimeout` would remove the hang detection the default provides everywhere else.

### .agents/notes/archived/testing/2026-09-27-plugin-install-interceptor-lifetime.i18n.yaml
Bilingual-pair consistency record: English `b1f1a5641d78483bc1954513ecfcf841951efe01`, Chinese `1e9ff9090086d08226f2bfd0b216610b27097b69`.

### .agents/notes/archived/testing/2026-09-27-plugin-install-interceptor-lifetime.md
- Purpose: keep the browser's route interception alive for the page lifetime, because tearing it down strands a Host read.
- Key abstractions: `apps/web/tests/plugin-install-cancel.e2e.ts`; the `installBundle` and `cancelInstall` Playwright interceptors; the typed handler each interceptor delegates to; `activeReplySettled`; the `data-plugin-status` attribute.
- Data flow: the scenario registers both interceptors **before navigation** and retains them until the browser closes; each interceptor calls a typed handler that the scenario replaces when it changes phase. The delivery and cancellation barriers keep their ordering, and `activeReplySettled` joins the lost-response handler before the next installation starts. Ordinary requests still reach the real Host.
- Non-obvious design decisions: the Host emits invalidations that trigger background reads while the scenario removes its Playwright routes between installation phases; "a stalled read keeps the installed package out of the list, so enabling it closes the dialog but never exposes the highlighted card" (line 10). The scenario separately polls the highlighted card's status until it becomes `running` — keeping interception active lets the directory read complete, and polling its result still establishes the state the golden records.
- Edge cases / failure handling: `unrouteAll({ behavior: 'wait' })` was rejected — waiting for matched handlers does not settle unrelated browser requests, and a captured Chromium protocol trace shows `Fetch.disable` immediately followed by a `pluginManager/listPlugins` request with no response or failure before teardown. Advancing the paused browser clock or extending the locator timeout does not release the stalled request, and the 2.4-second highlight expiry is not responsible for a package that never reaches the directory.
- Surprising: the note names the **protocol trace** as the independent evidence — the DOM assertion could not distinguish "the read never completed" from "the read completed but the card was elsewhere" — and it lists the other live-page `unrouteAll` call sites as candidates for separate investigations while refusing to claim this reproduction explains their failures.

### .agents/notes/archived/testing/2026-09-27-plugin-install-interceptor-lifetime.zh.md
Chinese twin of the English note: translating that adding a general route-switching helper was rejected because two endpoint handlers in one scenario do not need another fixture API.

### .agents/notes/archived/testing/2026-09-27-web-lane-assertions-name-their-input-state.i18n.yaml
Bilingual-pair consistency record: English `29c15d688ca18c7b0b05f934fd70b9984213d854`, Chinese `9b95e99c8e5e023e5caeda7395c087a38f4a8a41`.

### .agents/notes/archived/testing/2026-09-27-web-lane-assertions-name-their-input-state.md
- Purpose: make every browser capture **establish** the state its golden records, instead of sampling whatever the pointer or an in-flight read happened to leave behind.
- Key abstractions: `.projectRow:hover` / `.sessionRow:hover` in `Rows.module.css`; `Tooltip.tsx`'s "ignore focus while the last input came from a pointer, and only a keydown clears that flag"; `enableInstalled` in the plugin store; `captureStableAria`.
- Data flow: the folding scenario hovers the Workspace row before the sidebar capture and the first row the batch reveals before the first-batch capture, so both hovered rows are established rather than inherited from the layout around the "Show 11 more sessions" click. The turn-tail scenario clears the pointer flag with a key that moves nothing, focuses the Copy button, and waits for the tooltip the running golden records. The install-cancel scenario polls the card's status instead of sampling it.
- Non-obvious design decisions: `captureStableAria` already waits for two equal consecutive snapshots and **was satisfied by the wrong state** — so the limit is not stability but the state being captured (line 36). In the install-cancel case the status flipped `disabled` → `running` **61 ms** after the highlight in three local runs, and the failing run read it inside that window.
- Edge cases / failure handling: the settled capture keeps the plain focus, which is what its golden records once the Stop click has left the pointer owning the last input; the highlight stays the locator that finds the card, because the later 2400 ms clock advance still asserts the card detaches with it. Disabling hover styling or the tooltip modality rule was rejected because both are shipped rendering and interaction behaviour the goldens are the evidence for.
- Surprising: the note is scrupulous about scope — it records that the WebKit failure in the serial master lane is **not** a scenario race (the lane's step fetched the browser without its host libraries) and stays a runner/image issue, and it lists `document-preview.e2e.ts`'s spreadsheet-selection read as the same class of defect left to its own change.

### .agents/notes/archived/testing/2026-09-27-web-lane-assertions-name-their-input-state.zh.md
Chinese twin of the English note: translating the two negative controls that reproduce the recorded signatures (hovering the wrong row; a bare mouse press with no key) and the measured before/after pass counts.

### .agents/notes/archived/testing/2026-09-28-detail-close-waits-on-observed-state.i18n.yaml
Bilingual-pair consistency record: English `d77fb560ab205e0663df3a8b20417368ec6c8988`, Chinese `9c7d1524360b3d12d8fb37397c7da1581ade06a4`.

### .agents/notes/archived/testing/2026-09-28-detail-close-waits-on-observed-state.md
- Purpose: fix a flaky UI assertion by waiting on the state it actually asserts.
- Key abstractions: `packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx` (269 cases); `catalog-source.ts`'s single snapshot publishing `records: []` together with `status: 'ready'`; `TaskDetail`'s passive effect calling `onDeleted` → `closeDetails` → `selectedId = null`; `useTaskDetail`'s draft retention.
- Data flow: the case retries a failed catalog read after a confirmed deletion, awaits `screen.findByText(en['list.empty'])`, and then reads `screen.queryByRole('complementary')` **once**. The new assertion is `await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })`, and the `findByText` await stays as the case's check that the list fell back to its empty state.
- Non-obvious design decisions: the empty list and the removed detail are **two separate commits** — the first renders the empty-status region, the second's passive effect schedules the close, and only the following render drops `<TaskDetail>` and with it the `complementary` region (line 14). So "a single read issued on the resolution of the first signal can still see the panel". The page-level effect that closes a selection whose record left an authoritative ready snapshot does not fire here, because `useTaskDetail` keeps the confirmed deletion's task as its draft, so `selected` stays defined through the frame in which the row disappears.
- Edge cases / failure handling: the close is a **post-commit effect by design** — while a deletion is confirmed or a save failed, the panel must survive a refresh that removes its row, so it cannot be derived away during the render that drops the row. Closing during render was rejected for exactly that reason. The negative controls are precise: inserting a 25 ms delay between the `deleted` condition and `onDeleted` makes the pre-fix single read fail at the same assertion while the waiting assertion stays green; removing the `onDeleted` call from that effect makes the waiting assertion fail — so a panel that never closes is still reported.
- Surprising: the note explains why a `Promise.withResolvers` deferred (used by neighbouring refresh-ordering cases) was **not** chosen: those cases hold both the deletion's and the refresh's promises because their subject is the *ordering* between the two, while this case's subject is the state the retry button's own path settles into, and a deferred retry would replace the user-visible `list.retry` path with a hand-driven one.

### .agents/notes/archived/testing/2026-09-28-detail-close-waits-on-observed-state.zh.md
Chinese twin of the English note: translating that asserting that `onDelete` settled was rejected because "a settled callback does not prove the region was removed".

## Ideas worth stealing

- **Cache the *proof* of immutability, not the immutability itself** — `.agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.md:14` — Each `ReactLoopAgent` owns a private `WeakSet<Message>` holding only identities whose *complete* `deepFreeze` succeeded in that instance; every unseen message is deep-frozen in place and added, and later requests reuse that proof. Why it matters for August: August re-derives and re-freezes the request body on every turn, so a long tool conversation pays an O(history) traversal per request (246 ms → 67 ms median here). The WeakSet is the right container — a strong Set would extend old history's lifetime, a global cache would expand ownership past the Agent, and equal message ids do not establish identity. Transfer it as a per-loop proof table keyed on object identity, and keep the rule that a frozen *root* never proves its descendants.
- **Snapshot the behaviour, not the storage envelope** — `.agents/notes/archived/testing/2026-08-18-session-snapshot-envelope-projection.md:14` — A committed session snapshot is a *projection* of the persisted JSONL: the header row is untouched, each body row keeps its discriminant, payload and other top-level fields, but `seq`/`time`/`seq0`/`time0` are omitted at the writer's file boundary; replay's existing `parseSessionLog` assigns the missing sequence fields in memory. Why it matters for August: August's transcript goldens are exactly this shape — a local event insertion currently renumbers a suffix of rows, so every reviewed diff describes storage mechanics rather than changed behaviour. The note is explicit about the cost (the checked-in file is no longer byte-for-byte valid persistence JSONL) and about what was rejected (changing runtime persistence, or publishing a shared codec package for a four-field deletion).
- **Pin the composed system prompt and tool schemas once per composition class, in the format a human reviews** — `.agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md:14` — Exactly one scenario per header class is flagged `pinsHeader`; its directory holds `system-prompt.expected.md` (prose) and `tool-schemas.expected.json` (structure), while every other `session.jsonl` stores `{{system}}`/`{{tools}}`. A *live* uniformity guard compares every header the product actually sends — from a parent, a spawn child, a fork child, a resume, an in-instance change — against the reconstructed class sequence, and on-disk fixed-point checks keep the tokens honest. Why it matters for August: August cares about prefix stability for provider caching, and "the composed prompt as actually sent" is currently unrecorded; this is a cheap way to get a reviewable prompt diff (Markdown) and a reviewable tool-surface diff (JSON) without duplicating megabytes into every fixture.
- **Bind replay to *who* is calling, and bind by first-call order** — `.agents/notes/archived/testing/2026-06-22-subagent-snapshot-replay.md:31` — The session id rides on the model request (`GenerateOptions.sessionId`), so the replay listener routes by the issuing session; because live ids are random, live sessions claim recorded scripts by first-call order, and more live sessions than recorded scripts is a fail-loud error, never a silent mis-route. Why it matters for August: August's roster/delegation path spawns children that stream concurrently; a global cursor hands a child the parent's responses, and an id-equality scheme never binds at all. The same "key by who calls, not by global order" rule is what makes the design survive backgrounded children.
- **Persist the inheritance boundary at the producer, never re-derive it in the consumer** — `.agents/notes/archived/testing/2026-06-22-fork-child-replay-seed-boundary.md:24` — A fork child records `SessionHeader.isSeeded` plus an explicit `SessionLogOffset.inheritedEventCount`; it is never inferred from `seed.length` (a resume seeds the whole stored log), and the replay harness slices the fixture at that boundary. Why it matters for August: August forks conversations and seeds delegated workers with a parent prefix; without an explicit cut, the child inherits the parent's assistant settlements and the model-visible history is silently wrong. The note's reasoning is the transferable part — a heuristic re-derivation in the consumer is brittle and re-derives a fact the producer already knows.
- **One recorded generation can be both the replay source and the expected output** — `.agents/notes/archived/testing/2026-06-19-acp-snapshot-tests.md:16` — The fixture is a projection of the product's own persisted JSONL: replay derives the model script from it, and the same file is the behavioural expected output, compared in two normalised projections (the automation wire transcript and the re-persisted log). Why it matters for August: August's `e2e:smoke` currently asks fifteen doors questions; this pattern gives a second, free oracle for every future assertion — the product's own log *is* the expected output — and it removes the classic "two hand-written fixtures drift apart" failure.
- **One explicit wire behaviour per request, and script exhaustion fails loud** — `.agents/notes/archived/testing/2026-07-25-scriptable-llm-wire-fault-server.md:16` — A private Node HTTP server accepts the real OpenAI-compatible routes, validates the bearer token, captures the request and consumes **one** scripted behaviour per accepted request (socket reset, post-header disconnect, partial disconnect, stall, empty completion, clean truncated stream, malformed payload, HTTP failure, slow streaming, max tokens); the script list is exhausted loudly and `repeatLast` must be asked for explicitly. Why it matters for August: August's retry/backoff and tool-error paths are, by the note's own argument, currently only exercised by mocks that "bypass fetch, HTTP status/header parsing, SSE framing, socket termination, and the adapter idle watchdog". A scriptable server is how you get *wire-level* confidence in August's `429`/`5xx`/timeout behaviour without a live provider.
- **An observation must wait on the state it reads, not on an earlier signal** — `.agents/notes/archived/testing/2026-09-28-detail-close-waits-on-observed-state.md:22` — The empty list and the removed panel are two commits; the second is scheduled by the first's passive effect, so a single read issued when the empty text appears can still see the panel. The fix is to wait on the asserted DOM, and the note supplies the negative controls (a 25 ms delay reproduces the flake; removing the close call makes the waiting assertion fail, so a panel that never closes is still reported). Why it matters for August: August's UI assertions currently mix "wait for A" with "assert B"; this is the exact discipline that turns a flaky golden into a deterministic one.
- **Each capture must establish the input state its golden records** — `.agents/notes/archived/testing/2026-09-27-web-lane-assertions-name-their-input-state.md:20` — Hover the row the golden shows as hovered; press a key to clear the pointer flag before focusing a Tooltip anchor; poll a plugin status instead of sampling it 61 ms after the highlight. Why it matters for August: August's composer/chat goldens assert ARIA that depends on hover, focus modality and in-flight Host reads; `captureStableAria`-style stability waits are satisfied by the *wrong* state, so the state must be established before the capture, and the note shows the two negative controls that prove the fix bites.
- **Derive a small action-category set from structured product facts, and keep it display-only** — `.agents/notes/archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md:16` — Each product Provider maps upstream SDK/app-server failures onto a handful of categories (`limit`, `access-policy`, `service`, `transport`, `product-error`, `invalid-result`, `process`, `unknown`) plus a stage and independently observed exit code/signal, and the whole thing is one bounded (4096-byte) display string that consumers show but never parse. Raw stderr and payloads stay Host-only. Why it matters for August: August's subagent/roster boundary receives failures from independently versioned product runtimes; mirroring every upstream enum member makes a routine runtime upgrade redefine August's model-visible promise, and a raw-text passthrough leaks secrets across a process boundary. The note's ownership table (who owns interpretation, who owns the stage, who owns the byte limit) is the transferable part.
- **One Steer send operation for a whole roster, and say explicitly what `accepted` does not mean** — `.agents/notes/archived/simplification/2026-08-30-team-send-message-steer.md:16` — Every Team member gets one `send_message({target, message})` with fixed Steer scheduling (running target → next step boundary; idle → new turn; inactive → cold resume); the durable snapshot has no scheduling field, and `accepted`/`queued` are defined as *inbox* outcomes that explicitly do not mean the target completed the work. Why it matters for August: August's Bot-to-Bot and roster messaging currently has to choose between quiet injection and waking delivery; collapsing to one operation removes a policy choice the model was never equipped to make, and the "accepted ≠ completed" wording is the kind of precision that prevents a parent agent from over-reading a delivery receipt.
- **Delegate interruption and teardown to the one owner of the child's lifecycle** — `.agents/notes/archived/simplification/2026-08-12-trim-agent-teams-read-and-lifecycle-surface.md:30` — Team `interrupt()` resolves the roster name and delegates to `SubagentService.interrupt()` with exact ancestor authority (the old code called `Agent.cancel()` directly, bypassing authorization); teardown selects the roster's exact live direct-child ids and calls `drainContinuableChildren(parent, childIds)`, which releases descendants child-first, leaves siblings and parent-wide admission alone, and treats absent targets as no-ops. Why it matters for August: August has both an Agent.cancel-style door and a continuation/roster door; the note shows the exact shape of "the roster chooses *which* children; the lifecycle owner does the releasing" — and why draining the whole lineage (the tempting simplification) would stop unrelated work.
- **A check is worth publishing only if two observations can independently diverge** — `.agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.md:18` — 209 packages published an `./invariant` companion that asserted nothing, and one published a probe that mutated and inspected the same route table it claimed to verify. The criterion kept is "can compare observations that may independently diverge" (cross-event protocols, event-vs-authoritative-state, multi-producer assembly, durable data folded by a different operation). Why it matters for August: August's `check:*` static gates have exactly this shape; the note supplies the test for "is this gate real?" — if the only observation comes from the same writer, it is a unit test wearing a gate's clothes — plus the governance rule that the omission is recorded in the package's README with a package-specific reason.
- **Measure the hot path, then measure it again with alternating pairs in fresh processes** — `.agents/notes/archived/simplification/2026-09-07-file-content-scan.md:14` — `contentHasFile` replaced recursive `Array.some` with direct iteration: nine **alternating** original/candidate pairs, each in a fresh plain-Node process receiving a copy of one native-V3 seed; the median improved 11.54% and all nine pairs improved (4.871–12.243 ms), with a separate five-pair scan probe over 5,601 frozen messages. Why it matters for August: the method transfers verbatim — alternating pairs kill drift, fresh processes kill warm-cache bias, and "the hot source is identical at both sampled revisions, so these observations do not establish PR causality" is the honesty clause that keeps a benchmark from becoming a story. The same pairing discipline is applied to the request-freeze note, which reports a contaminated run as *retained but not used as calibration evidence*.
- **Never validate the same input twice on two sides of the wire** — `.agents/notes/archived/simplification/2026-09-15-host-only-remote-input-validation.md:16` — The client checks descriptor *integrity* at mount time but does not execute invocation codecs; the Host Gateway is the single runtime input-validation authority (exact named fields, strict codecs, JSON verification, lookup before business call). Why it matters for August: August's FastAPI backend is already the validation authority, so any client-side re-validation is duplicated cost and a second failure path — and the note names the security consequence honestly (undeclared properties may cross the carrier before the Host codec removes them, so callers must construct the declared DTO rather than rely on client parsing as a redaction step).
- **Collapse every overdue recurrence into one batch and catch up only the latest occurrence** — `.agents/notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.md:16` — Pure integer arithmetic picks the latest creation-anchor-aligned occurrence at or before one decision time; every distinct overdue record contributes exactly one occurrence and the whole batch shares one decision time; missed occurrences are never enumerated, persisted or replayed. Why it matters for August: August has scheduled automations and a Bot path that nobody watches; this is the shape that bounds a cold start to *current* work instead of a backlog whose size depends on downtime.
- **Replace JS layout probing with CSS width bands** — `.agents/notes/archived/simplification/2026-09-01-css-produced-file-layout.md:16` — The produced-files row became an inline-size query container: CSS bands hide trailing chips and select a pre-rendered localized `+ N files` label, so `ProducedFiles` has no resize observer, layout effect, layout state or geometry read. Why it matters for August: August's chat UI renders produced-file chips and pays a forced layout on mount and on every resize; the note's rejection of the "observe the row" alternative ("one observer and width-driven React state per mounted result row even though CSS already receives the same width") is the argument for pushing this decision into the stylesheet.
- **Fixture clocks must be pinned on both sides and re-applied, not frozen** — `.agents/notes/archived/testing/2026-09-26-web-conversation-clock-fixture-day.md:24` — `pinBrowserClock` re-applies one frozen instant from the anchor **on an interval** because product code reads two `Date.now()` values to decide how long to hold a rendered value (a 150 ms title hold, a 10 ms composition guard); a permanently frozen clock means the hold never elapses and the settled text never renders. Why it matters for August: any golden that asserts relative time ("2 minutes ago") needs both the browser clock and the Host clock pinned, and the pinning must not stop time from advancing for two-reading holds. The note also shows the wrong fix being measured and rejected (collapsing the date prefix in the ARIA normaliser broke three other goldens).
- **One environment variable, one budget — for cases *and* hooks** — `.agents/notes/archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md:20` — `coverageTestTimeoutArgs` now emits `--hookTimeout` beside `--testTimeout` and `--expect.poll.timeout`, because setup and teardown pay the same contention and raising only the test budget "moves a contended suite's failure from the case to its teardown rather than removing it". Why it matters for August: August's CI story is entirely static checks today; when a budgeted test lane appears, this is the shape that avoids two knobs describing one property of the host, and the note is explicit that the trade (losing detection of a real slowdown into tens of seconds) is deliberate.
- **Property-test the protocol-shaped code, with generators biased toward adversarial interleavings** — `.agents/notes/archived/testing/2026-06-11-property-based-testing.md:8` — One `fast-check` suite per protocol-shaped package (chunk assembly, event log, schema conversion, agent-loop scheduling), with generators tuned for *realistic-but-adversarial* inputs, `numRuns` bounded so the suite stays under ~10 s, and failures printing a reproducible seed. Why it matters for August: the motivating evidence here is the transferable one — "a block-assembly ordering bug once survived 100% line coverage of the happy paths" — and the suite found a real duplicate-`block-end` bug on its first run. For August's stream assembler and inbox scheduler, per-file 100% coverage is exactly the evidence that does *not* prove interleaving correctness.
- **Read the roster from the bundles; never copy it into the test package** — `.agents/notes/archived/testing/2026-09-06-client-assembly-test-line.md:20` — `bundleRoster` parses each bundle's `dsh.bundle.patch` with the include plugin's own `entryListSchema` and composes the layers with its `applyEntryPatches`, keeping enabled rows whose package declares the web client platform; the whole-client tier then boots those rows through the production `bootClient`/`mountClient` with a single Connection substitution. Why it matters for August: a copied roster in a test helper is a second source of truth that silently drifts; deriving it from the composition means "the product's default tool set" is always the product's default tool set. The same note's discipline — assert against *product facts* (the real section list, the real declarer, a Loader rebuild) — is what makes such a tier worth the five-seconds-cold boot it costs.

## Files skipped (with reasons)

None. All 235 files in this shard were opened and read; the ledger's status column is `read` on every row, and no file was classified `skipped`. There are no generated, vendored, binary or large-data files in this shard: every file is a UTF-8 Markdown note, a UTF-8 Markdown translation, or a 6-line YAML pairing record (largest file in the shard is 11,702 bytes, `2026-09-06-client-assembly-test-line.md`).

## Uncertainties

- **Depth of reading on the Chinese mirror sides.** All 79 `.zh.md` files were opened. The first 12 were read end-to-end (all 40 lines of `2026-08-04-remove-tui-package.zh.md` through `2026-08-11-cmdline-program-action.zh.md`); the remaining 67 were read to line 16 — title, `Status`, `Archived` date, the language link, the `## 问题`/`## Problem` heading with its paragraph, and the opening of the `## 决策`/`## Decision` section. For those 67 I verified that the note is a faithful mirror of its English sibling (same status, same archive date, same Problem and Decision content, same backticked identifiers) but I did **not** verify clause-by-clause that every sentence of the translation matches the English. Where a Chinese note differs structurally from its sibling — e.g. `2026-08-12-trim-agent-teams-read-and-lifecycle-surface.zh.md` and `2026-08-21-product-subagent-minimal-diagnostics.zh.md` keep the English `## Problem`/`## Decision` headings untranslated, as do `2026-08-28-remove-hero-input-glow.zh.md` and `2026-09-19-deepseek-messages-only.zh.md` — I read enough of each to confirm the anomaly is confined to the heading text.
- **How the 78 `.i18n.yaml` files were read.** They were read via two read-only shell dumps (one per archive directory) that printed each file's two hash lines and its `--write` command line; the three shared comment lines at the top are byte-identical across all 78 files, and the header comment names `pnpm run verify-translation-pairing --write <file>` as the way to re-record a pair. I did not separately re-read every one of the 78 with the line-by-line reader, because the distinguishing content (the two git blob hashes) was captured in full for every file.
- **The pairing hashes are not verified against the working tree.** I did not run `git hash-object` (that would be executing repo tooling), so I cannot confirm that the recorded hashes still match the current file contents — only that each file records a pair of hashes for the English and Chinese sides named in the same directory.
- **Line-number citations were verified mechanically.** Every `file:line` reference in "Ideas worth stealing" was re-read at that exact line to confirm the quoted mechanism is on it.
- **No source code was read.** Everything above is quoted or paraphrased from the note text itself. The packages, apps, scripts and benchmarks the notes point at (`packages/core/agent-loop`, `packages/llm/llm`, `packages/support/llm-replay`, `packages/support/acp-snapshot`, `apps/web/tests/…`, `scripts/…`) belong to other shards of this research effort, so I cannot confirm from this shard alone that the code still matches the notes — the notes are explicitly historical and archived, and several of them say the referenced decision has since been superseded.
- **One note in this shard has no English sibling in the shard**, and one English note has no Chinese sibling in the shard (`2026-08-04-remove-tui-package` contributes only its `.zh.md` here). Both are shard-boundary artefacts rather than repository gaps; the sibling shard owns the other half.



