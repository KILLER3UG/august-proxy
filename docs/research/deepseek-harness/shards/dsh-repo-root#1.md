# deepseek-harness / dsh-repo-root#1

## Shard shape

This shard is the **alphabetically-first 200 tracked files** of the `deepseek-harness` repository — the harness's own operating layer rather than its product code. It contains four clusters that together describe how the harness team works on, tests, benchmarks, releases, and ships the product:

1. **`.agents/skills/**` (41 files)** — the repo's own agent-facing instruction set: prose standards, documentation templates, CI reliability, code review, error handling, UI/UX rules, performance work, "trim CoT leakage" auditing, bilingual translation, and the browser-GIF recorder (with a real ffmpeg encoder + Python test). These are *meta-prompts for agents working on the repo*.
2. **`.github/**` (59 files)** — the whole CI/release/governance surface: 25 GitHub Actions workflows, the Issue policy engine (`rules.mjs` / `github.mjs` / `pull-request.mjs` / `lifecycle.mjs` + a 1077-line test), the weighted-approval scoring engine (`check-approval.mjs` + blame/author-weight modules + Python blame measurement), issue templates, and preview-runner sizing notes.
3. **Repo-root config and contract** (~20 files) — `AGENTS.md` (the root contract), `.oxlintrc.json`, `.jscpd.json`, `.gitlab-ci.yml` (the Python release lane), `lefthook.yml`, `Makefile`, and bilingual brand/contributing docs.
4. **`apps/desktop-host/**` (15), `apps/plugin-market-generator/**` (18), `benchmarks/**` (47)** — two small real applications and the **required performance-gate benchmark tree**.

The benchmark tree is the most transferable part for August: it is a full *performance contract* — a synthetic corpus anchored on measured real quantiles, compiled workers that assert they measured the shipped artifact, budgets calibrated from a reference machine to the CI runner, and a self-contained HTML report that rescales each endpoint per machine. The `plugin-market-generator` is the most transferable *application* part: it downloads and reads untrusted third-party code **without ever executing it**, and it is a concrete reference for "how to consume an ecosystem safely".

Nothing in this shard is the agent loop itself (that lives in `packages/`), so the lenses on the loop, prompt construction, compaction, and memory are covered here only indirectly — through the harness's own discipline about measuring them, and through the skill corpus that governs how agents in this repo are instructed.

---

## Per-file notes

### .agents/skills/.gitignore
- One-line ignore rule: `*/agents/openai.yaml` — per-skill generated agent manifests stay out of git.

### .agents/skills/agent-experience/SKILL.md
- Symlink (stored as a one-line path) to `packages/preset/agent-preset/skills/agent-experience/SKILL.md`; the preset package owns the content.

### .agents/skills/cordis-styling-nitpicking/SKILL.md
- Purpose: a focused P0 review skill for Cordis plugin ownership and lifecycle.
- Key abstractions: three rules — singleton pattern, unreversed side effect, cleanup-before-consumer-done.
- Data flow: start at exported plugin roots (`apply` or a concrete default export) → trace initialization, registrations, listeners, effects, disposers → compare consumer completion against when each dependency becomes unusable.
- Non-obvious design decisions: requires establishing "a legal failing interleaving and observable impact" before reporting, and explicitly forbids reporting defects in vendored Cordis; a finding must carry plugin root, consumer, resource owner, failing interleaving, correction, and a deterministic acceptance test.
- Edge cases: excludes immutable scalars, frozen tables, stateless functions and objects allocated inside an explicitly scoped owner; `ctx.on()`/`ctx.plugin()`/`ctx.effect()` already provide reversal.
- Surprising: "reverse start order and dependency registration alone do not establish completion order" — start order is explicitly not evidence of completion order.

### .agents/skills/dsh-archive-agent-notes/SKILL.md
- Purpose: governs the life-cycle of the repo's Agent Notes (its decision-rationale corpus).
- Key abstractions: the note **triplet** (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`), the `archived/{kind}` path, and the seal manifest.
- Data flow: a new note triggers a scoped supersession audit of active notes; classified as implemented→delete / implemented→keep active / implemented→archive / proposed→never archive / rejected→keep-as-guardrail / rejected→delete.
- Non-obvious design decisions: "Judge every note semantically; word count and age are discovery aids, never archive criteria" — and small UI adjustments are deleted even when implemented, while a note stating a **reintroduction condition** is kept until the condition lands.
- Edge cases: archived triplets are frozen forever; inbound links from active prose must be redirected, but the archive never checks its own outbound links.
- Surprising: archiving is metadata-only — insert `Archived: YYYY-MM-DD` below `Status: implemented`, re-record hashes mechanically, and never edit the body.

### .agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md
- Purpose: the read-only workflow for diagnosing an existing probabilistic CI failure.
- Key abstractions: an eight-class failure taxonomy — host-resource collision, incomplete lifecycle, process-global contamination, load-sensitive synchronization, platform/entry-path mismatch, product concurrency defect, external-provider transience, runner infrastructure.
- Data flow: freeze evidence (repo, SHA, runner labels, first stable signature) → compare same-SHA runs → classify → reproduce at the smallest reachable topology → fix at the owner.
- Non-obvious design decisions: "One passing rerun does not prove an infrastructure fault, and one timeout does not prove a product race", and "Do not collapse a timeout, signal, exit code, and assertion into a single inferred outcome."
- Edge cases: when the failing signature belongs to a platform the host cannot run, the ladder stops at the last reachable rung and the limit is recorded rather than substituted with a passing run elsewhere.
- Surprising: the file is a *diagnosis* contract — "A diagnosis-only request remains read-only: report the cause and evidence unless the user also asks for a fix."

### .agents/skills/dsh-ci-test-reliability/SKILL.md
- Purpose: design/review rules for tests that must stay correct under the repo's real CI concurrency.
- Key abstractions: four overlapping execution layers (same file → other files/workers → other gate processes in one job → different jobs sharing a host).
- Data flow: model topology → allocate resources atomically → contain process-global state → prove quiescent teardown → diagnose existing flakes.
- Non-obvious design decisions: "Process isolation does not isolate host ports, predictable filesystem paths, external services, databases, sockets, or inherited child processes" and "Do not serialize an entire suite merely because one fixture lacks isolation."
- Edge cases: resource allocation must be atomic — `listen(0)` and read the assigned address *after* the server reports listening; never scan for a free port and bind later. `mkdtemp` for private roots; exclusive creation where a path must not exist.
- Surprising: a sequential Vitest block cannot protect a host resource from another file, process, job, or runner — so isolation is per-resource-owner, never per-suite.

### .agents/skills/dsh-client-ui-ux/SKILL.md
- Purpose: judgement calls lint and typecheck cannot make — feedback surfaces, token reuse, overlay safety, contrast.
- Key abstractions: feedback-surface taxonomy (toast vs in-place notice vs empty state), icon-only controls, platform window adaptation.
- Data flow: search the target page and its nearest established sibling for an existing token/component before introducing a literal value; then verify both themes.
- Non-obvious design decisions: font weight tops out at 500 in feature CSS (differentiate with size or ink); the Plugins page is the standing reference for full-page surfaces.
- Edge cases: dimmed tones are called out as the standing counter-example — they fall below readability on text in one theme.
- Surprising: it explicitly declines to be a checklist ("this skill adds judgment on top of those rules, not a second copy of them").

### .agents/skills/dsh-code-review/SKILL.md
- Purpose: orients a reviewer to this codebase's standards and the review-only checks code cannot show.
- Key abstractions: "Sources of truth" map from changed paths → owning requirement pages; blocker vs suggestion.
- Data flow: verify base and head → `pnpm run change-scope --base … --head …` → map changed paths to owning artifacts → read those pages → read the diff → report.
- Non-obvious design decisions: "Judging a diff against memory of the rules is how a violation passes review" — the owning page is read *before* the diff; "a short review with one substantiated blocker is better than a list of nits".
- Edge cases: expected-output diffs are reviewed as behavior changes, not formatting noise; a green pairing hash does not prove translation quality.
- Surprising: disagreeing with an Agent Note is a design discussion, not an automatic veto.

### .agents/skills/dsh-create-upgrade-guide/SKILL.md
- Purpose: writes `docs/upgrade-guide/v<version>/<item>/guide.md` when an externally perceptible surface breaks.
- Key abstractions: the break categories (CLI, config keys, persisted data, SDK/wire APIs, published entry points); the item directory contains exactly `guide.md`, `guide.zh.md`, `guide.i18n.yaml`.
- Data flow: the change that introduces the break writes the guide immediately; later changes to the same surface update it in the same change; a reverted break deletes it.
- Non-obvious design decisions: a 500-word ceiling forces rationale into an Agent Note and mechanical steps into a script — "link source files or symbols instead of restating code".
- Edge cases: a Session-format change still follows type acknowledgements; the guide states only reader actions and links that record.
- Surprising: "Never write a guide spanning more than one release", and guides in older version directories are frozen after the version bump.

### .agents/skills/dsh-doc/references/metadata-links-i18n.md
- Purpose: the `kind` metadata system, link syntax rules, and the bilingual pairing record.
- Key abstractions: `kind` selects exactly one template; `*.i18n.yaml` sidecar records a hash pair **per heading section**.
- Data flow: derive the kind mechanically (group map → bundle patch → audited library registry → plugin reference), write frontmatter, write the Chinese sibling, re-record the pairing.
- Non-obvious design decisions: the frontmatter carries no field a filename convention or an executed gate already owns; `tags` are banned until a taxonomy and search consumer justify them.
- Edge cases: repository links must stay renderer-valid relative URLs; the counterpart path is derived from the sibling filename, so README-local `i18n` metadata is redundant.
- Surprising: the per-section hashes deliberately exclude fenced code and generated regions so edits to different sections merge with Git's default text merge — and the hashes are kept *out* of frontmatter because two independent edits to one header line would turn mergeable prose into an owner-file conflict.

### .agents/skills/dsh-doc/references/review.md
- Purpose: review criteria for documentation, keyed to whether a reader completes an outcome.
- Key abstractions: the newcomer test; the evidence hierarchy (package metadata → public types/JSDoc → runtime code → tests → generated catalogs → Agent Notes).
- Data flow: for each operational claim, *run* it against the current checkout and quote only observed output; claims depending on unavailable keys name a verification owner instead.
- Non-obvious design decisions: a package README's Summary describes reader-visible capability, not Cordis roles or internal components; "Do not restate JSDoc or generated catalogs."
- Edge cases: install guidance is classified by package shape (bundle / plugin / library) and rejected if written for another shape.
- Surprising: the `session-persistence-jsonl` README pair is the named reference example of the format, so the standard has a canonical artifact.

### .agents/skills/dsh-doc/references/structure-hierarchy.md
- Purpose: page order, section progression, and the `docs/` hierarchy.
- Key abstractions: Summary → ToC → stable content → optional Further Exploration → final Dev Note; `docs/learn`, `user`, `developer`, `scratch`, `subsystems`.
- Data flow: classify the page by one primary job and reader, then place it at its nearest owner.
- Non-obvious design decisions: the Dev Note is the only home for partial ideas and undecided directions; a blank one must say `None.` rather than accumulate placeholder prose.
- Edge cases: package READMEs keep `Model Experience` and `Known Limitations and Deferred Work` as the final two H2s, with the Dev Note as an H3 inside the limitations section.
- Surprising: the `docs/` tree is a *target map, not permission for an opportunistic mass move* — one coherent topic at a time, with inbound links and website mappings repaired atomically.

### .agents/skills/dsh-doc/references/style.md
- Purpose: page-level style: short Summary, controlled English, separators, folds, emphasis.
- Key abstractions: ASD-STE100-inspired review pass; `-----` separators; GitHub-native `<details>` folds.
- Data flow: 3–5 sentence Summary stating what the reader can do, why they care, the operating model, and the most important boundary.
- Non-obvious design decisions: 20 words for an instruction and 25 for a description are *review prompts, not mechanical gates*; never remove or strengthen `must`, `may`, `never`, timing, exceptions or numbers to hit a length target.
- Edge cases: "A rule directly after a paragraph would parse as a Setext heading" — separators need blank lines around them.
- Surprising: inside a `<details>` block every Markdown line must stay at column 0 or it becomes a code block, but headings/lists/tables inside keep their anchors.

### .agents/skills/dsh-doc/references/website-sync.md
- Purpose: the documentation website is a *tested projection* of repository Markdown, never a second copy.
- Key abstractions: `website/docs.ts` as the explicit public allowlist; `DocsPage` fields (`source`, `route`, `label`, `sidebar`, `section`, `order`, `sourceAliases`).
- Data flow: `scripts/project-doc-site.ts` rewrites mapped sources into the disposable `website/.generated/` tree; VitePress builds that tree and emits a raw-Markdown twin plus `llms.txt`.
- Non-obvious design decisions: keep the manifest an explicit allowlist — do not publish RFCs, postmortems, testing guides or `AGENTS.md` merely because they exist under `docs/`.
- Edge cases: a missing repository-relative link target **fails projection** instead of silently producing a broken link; cross-page fragments use the English GitHub heading id as canonical.
- Surprising: `DOCS_REPOSITORY_REF` deliberately stays on `master` rather than following the dispatched tag, because the public repo's master only advances to release commits — following the tag would leave every projected source link on an older deploy unresolvable.

### .agents/skills/dsh-doc/SKILL.md
- Purpose: the full documentation standard — create, restructure, audit, migrate, publish.
- Key abstractions: a 9-step workflow; the kind→template mapping; wordcount budgets; corpus audits.
- Data flow: read owning `AGENTS.md`s → classify page job/reader → place at nearest owner → define the reader's starting state, outcome, likely failure, recovery and next depth → write metadata and content in a fixed order → update the bilingual counterpart in the same pass → verify every claim against code/tests/generators.
- Non-obvious design decisions: "the only admissible evidence for an operation claim is having run it"; "Preserve one owner per fact" across source, tests, generated catalogs, READMEs, guides, Agent Notes and scratch.
- Edge cases: the Summary gate caps an English package README Summary at 100 `wc -w` words; skills must pass the repository's skill-invocation metadata check.
- Surprising: `pnpm run test:docs` is the quick comprehensive documentation gate (pairing, wrap, links, README gates, budgets, skill metadata, Agent Note gates) and runs *before* the full `doc-sync`.

### .agents/skills/dsh-doc/templates/package-bundle.md
- Package README skeleton for `dsh.bundle.patch` packages; leads with the `dsh plugin --profile … add` path and folds the patch document; Model Experience form is `indirect`/`none` for bundle carriers.

### .agents/skills/dsh-doc/templates/package-group.md
- Group-map README skeleton: one row per direct package, role text only; explicitly no Model Experience or Known Limitations section, because "the group map owns no runtime behavior".

### .agents/skills/dsh-doc/templates/package-library.md
- Library README skeleton for plain-module-API packages: no install guidance (a library is a dependency, not a layer), no mount configuration, and a Model Experience form the gate assigns.

### .agents/skills/dsh-doc/templates/package-reference.md
- The default Cordis-plugin README skeleton: `cordis.yml` mount row, config table, generated config catalog as the exhaustive field source, and the two gate-owned final sections.

### .agents/skills/dsh-doc/templates/persistence-change.md
- Template for a persisted-type change record: exactly one `yaml persistence-change` declaration, byte-identical across languages, with the `after` digest matching the generated companion schema.

### .agents/skills/dsh-doc/templates/persistence-format.md
- Rules for a historical Session format checkpoint: one `yaml persistence-format` block per language, a generated schema region, and an explicit statement that it does not claim codec admission or migration safety.

### .agents/skills/dsh-doc/templates/persistence-release.md
- Rules for a reconstructed tagged release record — an *observation*, not a compatibility acknowledgement, and it never joins the current-source acknowledgement chain.

### .agents/skills/dsh-doc/templates/upgrade-guide.md
- Minimal upgrade-guide skeleton: frontmatter `kind: upgrade-guide`, one H1, then exactly `## Change` and `## Migration` (Chinese: `## 变更` / `## 迁移`).

### .agents/skills/dsh-error-handling/SKILL.md
- Purpose: the repo's error-handling principles.
- Key abstractions: typed failures with stable discriminants; catch/recover/stop ownership; "handling and reporting owners, containment, and guarantees".
- Data flow: for each failure, define owners and guarantees in the owning API documentation; then make the outcome *visible* (UI or default-enabled accessible logs).
- Non-obvious design decisions: "Catching limits exception propagation, not mutations. Only the affected state's owner can establish safe continuation" and "Logging alone is not recovery."
- Edge cases: containment must never turn an unexpected defect into success; reporting failures need an independent fallback.
- Surprising: it bans routing handling by parsing messages — "Never route handling by parsing messages."

### .agents/skills/dsh-find-simplifications/references/historical-patterns.md
- Calibration set of recorded simplification decisions; four families — require a complete effect path, reduce distinctions where consumers decide, trade general behavior for a smaller explicit promise, and prefer explicit over general.

### .agents/skills/dsh-find-simplifications/SKILL.md
- Purpose: find simplifications that remove *maintained obligations*, not just lines.
- Key abstractions: the effect-path test (a declaration, a serializer branch and a test can form convincing support without an effective feature).
- Data flow: survey broad domains (delegated per domain), trace producer → transformation → provider/endpoint → observable result, then classify.
- Non-obvious design decisions: the two LLM adapters are protected — JSONL is the sole first-party persistence provider while the Service Definition keeps the backend-neutral seam; a survey does not imply a repository-wide note audit.
- Edge cases: "Zero fixed callers is weaker evidence than unreachability" — a deliberate third-party registration path is not dead code.
- Surprising: when proposing a trade, the note must "Name the capability given up and the machinery deleted."

### .agents/skills/dsh-merging-stacked-prs/SKILL.md
- Purpose: land dependent PRs through GitHub's native stack object instead of manual merge+retarget.
- Key abstractions: the GraphQL `PullRequest.stack` / `stackEntry.position` query as the *membership authority* (not base-branch inference).
- Data flow: verify `gh stack --version` → fetch live PR metadata and exact head OIDs → establish bottom-to-top order from live bases → link missing members → refresh only when needed → submit the whole stack or a bounded prefix.
- Non-obvious design decisions: hard-stop rather than fall back to manual merging; `gh stack link` is additive and merged/queued entries cannot be unstacked, so existing stacks are never dissolved or reordered automatically.
- Edge cases: cross-fork chains hard-stop; differing authors require asking the user before any GitHub mutation.
- Surprising: the tool requires a clean dedicated worktree and treats a moved head as a stop condition.

### .agents/skills/dsh-official-plugin-artwork/SKILL.md
- Purpose: draw/review official plugin icons (SVG geometry only) and optional feature previews.
- Key abstractions: the `36 × 36` viewBox canvas; the `PluginArtwork` glyph language; separate owners for bundle artwork vs component metadata.
- Data flow: inspect the real feature and its owning manifest → reuse one coherent treatment → refine one dimension at a time → export self-contained SVG.
- Non-obvious design decisions: lettering is exported as paths with no font dependency; a hollow lens must be genuinely transparent via a local mask, never a white or dark disk.
- Edge cases: package images render through `<img>`, so no scripts, handlers, animation, external images, fonts or `foreignObject`; inline React artwork needs per-instance IDs.
- Surprising: a badge-producing skill may need a tag, not a medal — the subject is derived from the actual feature, not the name.

### .agents/skills/dsh-pre-push-checks/SKILL.md
- Purpose: select the smallest outgoing evidence before a push, instead of reflexively running the full suite.
- Key abstractions: `pnpm run change-scope --base <verified-ref>` (versioned JSON of committed paths vs the merge base, plus staged/unstaged/untracked).
- Data flow: confirm checkout/branch → verify the live PR base → run the scope report → map scope to the narrowest owning test/check → run it → report exact commands and observed results.
- Non-obvious design decisions: git hooks are deliberately narrow (pre-commit fixes staged lint, checks staged whitespace, guards vendored metadata; pre-push runs only the incremental typecheck) — "CI owns exhaustive coverage and the platform matrix".
- Edge cases: `gh pr checks` reporting "no checks reported" with zero workflow runs usually means the PR is `CONFLICTING`/`DIRTY` — GitHub creates no `pull_request` runs for a conflicting PR, so empty commits and revert-and-restore bounces only add junk history.
- Surprising: pending checks must be reported as pending; "do not describe retries, skipped tests, or pending CI as passing."

### .agents/skills/dsh-prose-standard/references/examples.md
- Distilled prose examples: "Balanced" preserves every load-bearing proposition with the least explanation needed at that location. Covers preserving actor/timing/ownership, public JSDoc that includes failure modes, and limitations as contracts rather than debt inventories.

### .agents/skills/dsh-prose-standard/SKILL.md
- Purpose: editorial judgement and required prose coverage across Markdown, JSDoc, comments, prompts and visible strings.
- Key abstractions: the **complete-proposition** rule; `contract`/`boundary`/`shape` as terms to check rather than banned words.
- Data flow: enumerate every proposition in the passage (actor, condition/timing/ordering, modality, negative guarantee/exception, ownership/side effect/failure mode/consequence), then remove only decoration and repetition.
- Non-obvious design decisions: require an explicit `scope` — "If it is missing, report the required input and stop"; exclude `vendor/` and `.agents/notes/archived/` always, with exclusions *after* inclusion globs so a later include cannot re-admit them.
- Edge cases: generated catalogs, snapshots and fixtures are derivative — trace every consumer, edit the owning source, then regenerate; bilingual pairs have no permanent owner (either language may be the authored side).
- Surprising: "A smaller word count alone is not an improvement."

### .agents/skills/dsh-responsive-ui/SKILL.md
- Purpose: responsive client layout rules — truncation, title wrapping, icon-only controls, touch vs hover, keyboard.
- Key abstractions: the 390 CSS-px acceptance minimum; the decision order (reallocate/wrap first, then truncate, then icon-only, then move into More).
- Data flow: nothing here is procedural; it is an ordered judgement list with worked examples (model selector, "More account information", Session statistics under the input box).
- Non-obvious design decisions: hover effects are gated on `@media (hover: hover)`, **not** on viewport width — a phone tap must not leave hover-only backgrounds behind.
- Edge cases: truncated content must remain fully available elsewhere, and truncation must never lose an error; important information not available elsewhere must be shown in full.
- Surprising: on mobile the input keyboard is not raised automatically unless explicitly intended.

### .agents/skills/dsh-speed-up-perf/SKILL.md
- Purpose: turn "make it faster" into reproducible user-path measurements and small, evidence-backed fixes.
- Key abstractions: the user path list (cold startup, many-turn history, initial transport/fold, live streaming/reconnect).
- Data flow: agree endpoint, workload range, resource constraints and a stopping rule → survey user paths → rank candidates by measured cost → build realistic synthetic benchmarks → fix at the owning layer → publish evidence.
- Non-obvious design decisions: "Keep backend and browser end-to-end measurements separate: a fast history iterator or Client fold does not prove fast transport, paint, scrolling, or input response"; model/network latency is excluded from local-overhead measurement *and the exclusion is stated*.
- Edge cases: distinguish merged, closed-unmerged, superseded, estimated and newly measured evidence; a PR body may describe an abandoned implementation.
- Surprising: "A suspicious loop, unused cache, or large file alone is not evidence of a bottleneck."

### .agents/skills/dsh-translate-docs/SKILL.md
- Purpose: the explicitly-invoked bilingual translation workflow (`disable-model-invocation: true`).
- Key abstractions: triage by change type — Update (briefing-driven), New pair (whole-document), Deleted/renamed.
- Data flow: `pnpm run gen-translation-brief <file>` maps the change at the narrowest safely aligned granularity (paragraph → table row → list item → heading, then section, then document) and embeds each changed unit's three-way context plus a digest of the binding rules.
- Non-obvious design decisions: never re-translate a whole document to apply an update — "a re-translation throws that review away"; the briefing is the translator's whole working set so the subagent does not re-read the corpus.
- Edge cases: a mechanical-only diff (changes entirely inside byte-identical shared code fences) is applied by `--apply` with no subagent.
- Surprising: frozen archived Agent Note triplets are never updated, re-recorded or repaired.

### .agents/skills/dsh-trim-cot-leakage/references/examples.md
- Few-shot leakage examples with the overcorrection traps: deleting a true fact along with the transcript, promoting a hypothetical to a shipped feature, dropping the evidence source ("keep 'measured'").

### .agents/skills/dsh-trim-cot-leakage/references/recall-batteries.md
- Purpose: calibrated ripgrep probes for the leakage taxonomy.
- Key abstractions: the English battery (7 patterns) and Chinese batteries (change narration, authoring-language slips in Markdown, in TS/JS comments, in Python comments).
- Data flow: run each pattern, calibrate against a known positive and a near-miss negative, then judge every hit semantically.
- Non-obvious design decisions: the first (code-pattern) line stays case-sensitive while natural-language lines carry `-i`, because `-i` would turn `\bT\d\b` and `\bP-I\b` into noise; complete phrases are bounded so `\bthis PR\b` does not match "this project".
- Edge cases: exclusions go *last* so a later include cannot re-admit them; the skill's own directory self-hits through its quoted evidence and must be judged as evidence.
- Surprising: "The batteries are probes, not the definition — each review round of the original purge found cases the batteries missed", so an unpatterned read of the densest prose is mandatory.

### .agents/skills/dsh-trim-cot-leakage/SKILL.md
- Purpose: audit and fix prose that reads like a leaked reasoning transcript.
- Key abstractions: the 8-class taxonomy (dead design-session citations, stack/PR vantage, change narration and version stamps, review choreography, reviewer-addressed justification, restatement transcripts, hedges, authoring-language slips) plus an explicit keep-list.
- Data flow: scope and exclusions → read-only audit with the batteries → fix owner-first per surface → verify by re-running the batteries and checking every remaining citation resolves at HEAD.
- Non-obvious design decisions: the single test is *"could a reader at HEAD, with no access to any session transcript, PR thread, or uncommitted draft, resolve every reference and verify every claim?"*; a resolvable change story is still change narration on current-state surfaces.
- Edge cases: suppression justifications, counterfactual-present regression pins, measured bounds, runtime old/new states, external standards with their own §-numbering, and project voice are all explicitly *not* leakage.
- Surprising: a passage carrying factual clauses is *restated* to stand at HEAD, then the transcript around it is deleted; a passage carrying none is deleted outright.

### .agents/skills/record-browser-gif/scripts/encode_gif.py
- Purpose: encode a Playwright video or ordered screenshots into a verified GIF, deterministically.
- Key abstractions: `parse_durations` (one hold duration or exactly one per frame), `probe_stream` (ffprobe JSON), `require_binary` (ffmpeg/ffprobe on PATH, no installation attempted).
- Data flow: validate CLI numbers (finite, positive) → probe the stream → trim / speed / final-hold / scale → palette → encode → verify frame count, width and byte size → print a JSON summary.
- Non-obvious design decisions: `fail()` raises a concise user-correctable `SystemExit`; the output is only written after the invariants hold.
- Edge cases: `NaN`/`inf` durations are refused; an output file is never left behind on a rejected option.
- Surprising: it caps the output at `DEFAULT_MAX_BYTES = 5 MiB` and fails loudly rather than silently shipping an unusable asset.

### .agents/skills/record-browser-gif/scripts/test_encode_gif.py
- unittest suite that drives `encode_gif.py` through **real** ffmpeg/ffprobe subprocesses (not mocks): three coloured 2-second clips concatenated, then asserts timing, the colour order at specific seconds, the exact dimensions, and that invalid options produce no output file.

### .agents/skills/record-browser-gif/SKILL.md
- Purpose: record a truthful UI demonstration as a GIF, and (separately) publish it.
- Key abstractions: recording vs publication as two separate phases; the assets branch as the fallback for `gh --attach`.
- Data flow: require a clean worktree and record `git rev-parse HEAD` → build that recorded tree → boot one server per port with fresh scratch `DSH_HOME` → record with the browser-control workflow → encode → embed.
- Non-obvious design decisions: "The recording itself is part of the evidence" — a real server, a real API key and real model rounds; fixture queries, mock transports and synthetic event injection are forbidden unless explicitly requested.
- Edge cases: re-read the PR's live head immediately before editing the body and require it to remain at the recorded commit; after editing, confirm the expected `<img>` is present via GitHub's Markdown API.
- Surprising: the raw blob URL needs `?raw=true`, and the assets branch is append-only and never force-pushed, because merged PR bodies reference its URLs forever.

### .claude/skills
- Symlink (one-line path) to `../.agents/skills`, so Claude and the other agent surfaces share one skill tree.

### .editorconfig
- Editor-side declaration of LF and a final newline, explicitly paired with `.gitattributes`: "that file pins what GIT produces (LF checkouts), this one pins what EDITORS write to disk — the one path git's filters cannot reach."

### .gitattributes
- Git-side text normalisation (`* text=auto eol=lf`, `*.cmd text eol=crlf` so Windows command scripts still run under cmd.exe) plus `linguist-generated` marks for the persistence schema projections.

### .github/AGENTS.md
- Routing notes for the Actions topology: PR jobs run on Windows runners under native `pwsh`; `ci.yml` is pull-request-only while `ci-master.yml` listens to master pushes; the failover variables (`DSH_CI_FAILOVER_LINUX` = `selfhosted`/`blacksmith`) and the dedicated Windows packaging label are preserved as-is.

### .github/dependabot.yml
- Three ecosystems (npm, uv, github-actions) on a 04:00 Asia/Shanghai cron with a 30-day cooldown; `vendor/**` excluded from npm updates because vendored Cordis follows `vendor/README.md` instead.

### .github/ISSUE_TEMPLATE/bug.md
- Chinese-language bug template: Summary / Reproduction / Current behavior / Expected behavior / Environment, each with an inline hint comment.

### .github/ISSUE_TEMPLATE/config.yml
- `blank_issues_enabled: false` — one line; every issue must come from a template.

### .github/ISSUE_TEMPLATE/feature.md
- Chinese-language feature template: Motivation / Behavior.

### .github/ISSUE_TEMPLATE/task.md
- Chinese-language task template: Summary / Deliverables, for work that is neither Feature nor Bug.

### .github/issue-management/config.json
- Single source for the repository, project number, lifecycle actor, Priority and Start Date field names, timezone and the seven statuses (`Inbox`…`No action`).

### .github/issue-management/github.mjs
- Purpose: the GitHub transport, Issue/Project readers, and Project membership and field writes.
- Key abstractions: `api()` (REST with `allow404`), `graphql()` (Project-authenticated), `issueSnapshot()`, `projectContext()`, `ensureProjectItem()`, `setStatus()`/`updateStatus()`.
- Data flow: repository REST reads use `GH_TOKEN`/`GITHUB_TOKEN`; Project validation uses `PROJECT_TOKEN` or falls back to the repo token; GraphQL errors are joined and thrown.
- Non-obvious design decisions: two credential tiers so REST reads never need Project scope; `issueSnapshot` returns `null` for a pull-request number so a PR is never treated as an Issue.
- Edge cases: `allow404` returns null instead of throwing; a 204 returns null.
- Surprising: `projectToken()` prefers `PROJECT_TOKEN` but silently falls back to the repository token, so a missing Project credential degrades to a permission error rather than a crash.

### .github/issue-management/lifecycle.mjs
- Purpose: event-driven Issue/Project state transitions and the audit comment.
- Key abstractions: `AUDIT_MARKER` (an HTML marker that identifies the bot's own comment), `auditIssue()` (repair-then-validate-then-upsert).
- Data flow: `issues` events → status by action (`opened`→Inbox, `closed`→Done or No action by `state_reason`, `reopened`→Inbox) → `ensureProjectItem` → audit; PR/review events → resolve the resolving Issues → transition → audit.
- Non-obvious design decisions: audit is *repairing*: invalid PR-kind labels and retired aliases are deleted before validation, so a deterministic violation is fixed rather than only reported.
- Edge cases: the audit comment is updated in place — patched when the body changed, deleted when there are no errors — so the Issue carries at most one audit comment.
- Surprising: an explicit `TODO` records that the latest-state guard is a substitute for a real compare-and-swap, which GraphQL's ProjectV2 API does not offer.

### .github/issue-management/policy.mjs
- A 29-line command dispatcher (`pr-preflight|pr|lifecycle`) that reads `GITHUB_EVENT_PATH` and forwards to the owning modules; it owns no policy of its own.

### .github/issue-management/policy.test.mjs
- 1077-line `node:test` suite: a mock GraphQL packument builder, mocked `fetch` for REST and GraphQL, and cases for reference parsing, Priority inheritance, Project Start Date writes (including preserving an existing value and adding Project membership first), and `projectDate` timezone conversion.

### .github/issue-management/pull-request.mjs
- Purpose: read-only PR snapshots and the preflight/check entry points.
- Key abstractions: `pullRequestSnapshot()` (never writes), `resolvingReferencesSnapshot()` (REST distinguishes Issues from PR numbers), `runPullRequestPreflight()` / `runPullRequestCheck()`.
- Data flow: fetch the PR → skip drafts/Bots/App authors → read reviews → if the policy applies, resolve references → optionally read Project Priority → validate.
- Non-obvious design decisions: preflight and check are separate entry points that compute eligibility *independently*; "Final validation re-reads live state: preflight is not a cached verdict or an exemption for metadata edits."
- Edge cases: informational references (`Refs #3624`) establish context and never require a Project read; a resolving PR with a Priority label requires *every* resolving Issue to have a Priority.
- Surprising: the policy applies only to non-draft, human-authored PRs that have a requested review or a submitted review — everything else is exempt by design.

### .github/issue-management/README.i18n.yaml
- Per-heading English/Chinese hash pair record for the Issue-management README, re-recorded with `verify-translation-pairing --write`.

### .github/issue-management/README.md
- Owner doc for the Issue policy: exemption scope, the `kind/*` + `area/*` + one `p0`–`p3` label rule, informational vs resolving references, the two-tier credential model, and the lifecycle event map.
- Non-obvious design decisions: the Project `Priority` field is a *Project custom single-select*, not the native organization Issue Priority field; Project-local planning fields need no separate organization Issue Fields permission.
- Edge cases: "Lifecycle processing is event-driven, not a reconciler. Omitted events do not repair Project state, and concurrent Project mutations have no atomic compare-and-swap."
- Surprising: it warns that removing a legacy organization field requires comparing every value with its Project value *including archived Project items*.

### .github/issue-management/README.zh.md
- Line-aligned Chinese counterpart of the Issue-management owner doc, including the same "event-driven, not a reconciler" limitation.

### .github/issue-management/rules.mjs
- Purpose: pure validation, reference parsing, status decisions and date conversion (no I/O).
- Key abstractions: `TYPES`, `PRIORITIES`, `PR_KINDS`, `LEGACY_LABELS` (retired aliases reserved so they cannot be recreated), `TERMINAL_STATUSES`.
- Data flow: `requiresPullRequestPolicy` → `resolvingIssueStatusCommand` → `nextResolvingIssueStatus` → `validateIssue` / `validatePullRequest` → `projectDate`.
- Non-obvious design decisions: the module self-validates `config.json` at import time (statuses must contain `In progress` and `In review`; actor/field/timezone must be strings) and calls `Intl.DateTimeFormat` once so a bad timezone fails at load, not at first use.
- Edge cases: an `edited` PR action with no `changes.body` is a title-only edit and produces no lifecycle command; `changes_requested` is matched case-insensitively.
- Surprising: `PR_KINDS` and `LEGACY_LABELS` are separate sets, so a retired alias is a *validation failure* rather than silently accepted.

### .github/issue-management/selective-preflight.json
- `{"version": 1}` marker; its presence in the trusted checkout switches the workflow to the selective preflight path, and its absence preserves legacy behaviour.

### .github/preview-sizing/README.i18n.yaml
- Per-heading hash pair record for the PR preview runner-sizing README pair.

### .github/preview-sizing/README.md
- Purpose: the method for comparing PR preview runner cost.
- Key abstractions: a sizing experiment that holds SHA, lockfile, Node/pnpm versions, workspace build and packing commands constant; "estimated gross compute" = Σ (elapsed minutes rounded up × rate).
- Data flow: cold install (no cache restore) vs warm install (same exact cache, no prefix fallback) → record image, CPU, RAM, disk, cache outcome, phase durations, exit status, peak memory → compute the estimate.
- Non-obvious design decisions: "GNU time maximum RSS reports a process maximum, not simultaneous aggregate memory across the build process tree"; queue delay is a latency observation, not executed job time.
- Edge cases: "A build-only benchmark does not deploy, access Cloudflare credentials, or post pull-request comments. Its cost does not establish complete preview publication cost."
- Surprising: "standard-runner included minutes and storage are separate" — the estimate is explicitly not an invoice total.

### .github/preview-sizing/README.zh.md
- Line-aligned Chinese counterpart of the preview runner-sizing methodology.

### .github/pull_request_template.md
- PR body template: Motivation (with a `Fixes #NN`/`Related #NN` hint), Changes (two hint lines: command/config/API/protocol/persistence-format and user/model/system-observable behaviour), and one Testing bullet per method with a nested `<details>Proof</details>` evidence block.

### .github/review-ownership/.gitignore
- `__pycache__/` — the only Python artifact the directory can produce.

### .github/review-ownership/approval-policy.json
- The scoring policy as data: `requiredPoints: 2`, `defaultPoints: 1`, and six named reviewers worth 2 points each.

### .github/review-ownership/author-weight.mjs
- Purpose: author credit derived from merged PRs in the same repository.
- Key abstractions: `authorCreditPoints()` = `min(100, mergedCount) × 11 / 1000`; `countMergedAuthorPulls()` paginates GraphQL by immutable author id.
- Data flow: page merged PRs newest-first → skip the current PR → count entries whose `author.id` matches → stop at the 100 cap → return.
- Non-obvious design decisions: identity is the **immutable account id**, not the login, so a renamed account keeps its credit; deleted accounts (`author: null`) are simply not counted.
- Edge cases: an incomplete response is an error, not a smaller count — `response.errors`, a missing `pageInfo.hasNextPage`, a non-advancing cursor, or an invalid PR number all throw `GitHub merged PR history is incomplete`.
- Surprising: overlapping pages are de-duplicated by PR number, so a repeated page cannot inflate the credit.

### .github/review-ownership/author-weight.test.mjs
- `node:test` suite: same-account counting with deleted accounts, cursor following with page overlap and the 100 cap, zero only for a *complete* empty history, and rejection of a repeated cursor.

### .github/review-ownership/blame-ownership.mjs
- Purpose: merge-base production ownership for approval scoring.
- Key abstractions: `LOGIN` (shared account syntax), `resolveBlameAuthors()` (batched GraphQL author lookup), `productionOwnership()` (fetch base+head without a checkout).
- Data flow: fetch the base ref and head SHA into the local repo → run `blame-production.py` → parse its JSON counts → batch-commit author lookups (50 per query) → fold into case-folded reviewer line counts.
- Non-obvious design decisions: "PR blobs are data, never programs" — the Python helper is invoked with two SHAs, so no PR file is ever executed; the fetch uses an `http.<server>/.extraheader` authorization header and `GIT_TERMINAL_PROMPT=0`.
- Edge cases: the PR's head must still equal the reviewed SHA, else the read throws; a commit with no linked GitHub account stays in the denominator but contributes nothing.
- Surprising: the `git` invocation is bounded by `maxBuffer: 16 MiB` and refuses to run if the repo is a different PR than reviewed.

### .github/review-ownership/blame-ownership.test.mjs
- `node:test` suite for author resolution: case folding (`Writer`/`writer` merge), 50-commit batching, a zero-line change that must not query GitHub, and rejection of incomplete lookups rather than a lowered denominator.

### .github/review-ownership/blame-production.py
- Purpose: count changed *old* production lines and attribute them to their merge-base blame commits.
- Key abstractions: `EXCLUDED` directory names, `EXTENSIONS`, `SHIPPED_ROOTS`/`SHIPPED_FILES`, `GENERATED` header regex, `code_lines()` (Pygments-based).
- Data flow: `git diff --raw -z --find-renames` → filter to production paths → read the old blob → compute code lines → intersect with the unified-0 hunk ranges → one `git blame --line-porcelain -L min,max` per file → count.
- Non-obvious design decisions: git is run with `--no-replace-objects`, `--no-ext-diff` and `--no-textconv` so external diff drivers and textconv filters cannot run; `GIT_TERMINAL_PROMPT=0` and a 120s timeout.
- Edge cases: a shallow repository is refused (`blame requires complete history`); a generated file header (`auto-generated` / `do not edit`) makes the file contribute no code lines; a file whose blame attributes fewer lines than were changed raises `incomplete blame for <path>` rather than under-reporting.
- Surprising: "One blame per file covers all changed ranges; unchanged intervening lines never count" — the blame is bounded to the changed span instead of the whole file.

### .github/review-ownership/check-approval.mjs
- Purpose: the weighted-approval evaluator and status publisher.
- Key abstractions: `parseApprovalPolicy`, `effectiveReviewDecisions`, `delegationCommands`/`effectiveDelegations`, `evaluateApproval`, `runApprovalCheck`, `publishApprovalPhase`, and the event resolvers (`approvalEventFromPullRequest` / `FromComment` / `FromWorkflowRun`).
- Data flow: resolve the live PR → read reviews and comments → compute each reviewer's *current* decision → read permissions → apply `/delegate` commands → add author credit → add the ownership boost → publish a commit status → dismiss superseded delegated reviews → re-evaluate → request the delegate's review.
- Non-obvious design decisions: the score uses unrounded points with a `1e-12` tolerance while the *displayed* score is rounded to three decimals; the ownership boost (`min(2, 1 + 4 × ownedLines/totalLines)`) is only computed when reviewer points plus author credit still fall short, so the expensive blame is skipped when it cannot change the verdict.
- Edge cases: `DISMISSED` deletes a reviewer's decision; a comment edited by anyone other than its author is not a delegation command; a failed review request leaves the score unchanged and is retried later; an incomplete delegation editor history fails the evaluation rather than trusting the comment.
- Surprising: `publishStatus` rejects a non-HTTPS run URL and a description longer than 140 characters — the GitHub API's own limits are enforced locally.

### .github/review-ownership/check-approval.test.mjs
- 1146-line `node:test` suite: policy validation, the review state machine, delegation lifecycle (including dismissal of the sender's old decisions and staying active across dismissal events), phase publication, ownership boost arithmetic, and event resolution that rejects stale heads and closed PRs.

### .github/review-ownership/README.md
- Owner doc for the approval policy: two checks (the publisher job and the `weighted approval` commit status), the scoring curve, author credit, delegation, blockers, and the requirement that branch rules require the *commit status* with GitHub Actions as the expected source.

### .github/review-ownership/requirements.txt
- `Pygments==2.21.0` — the pinned lexer `blame-production.py` uses to recognise code lines.

### .github/review-ownership/test_blame_production.py
- unittest suite that builds isolated real Git histories (per-test `mkdtemp`, `core.hooksPath` disabled) to pin code-token detection, production-path exclusions, generated-header handling, merge-base attribution, binary blobs, shallow-history rejection and the "generated words in code do not exclude handwritten files" control.

### .github/workflows/build-exe-for-python-sdk.yml
- Reusable workflow building the single-file executable SDK/runtime wheels for five native targets; a `plan` job computes the matrix because job-level conditions cannot inspect `matrix`.

### .github/workflows/build-exe-for-ssh-helper.yml
- Reusable workflow building SSH-helper archives for four targets; each target is verified for relocated execution and (on Linux) real Landlock confinement and OpenSSH compatibility on glibc 2.28 without Node.

### .github/workflows/build-preview-cloudflare.yml
- PR preview workflow: Cloudflare Pages upload per branch alias, sourcemap deletion, `preview.html` copied to the deployment root, a protected-image check requiring HTTP 200 with gzip magic bytes, and an idempotent preview-URL comment.

### .github/workflows/ci-master.yml
- Master-only CI: a Wine Windows lane, serial self-hosted Linux and Windows standby drills (which continuously prove the failover pool can take a required lane), a disabled `serial-macos` job with a TODO, and two manual runner-sizing matrices.

### .github/workflows/ci.yml
- Pull-request CI with nine jobs (static, coverage, benchmarks, consumers, node-compat, python-sdk, python-runtime, windows-build, windows-native-tests) and a final aggregate gate that fails if any needed job was skipped, cancelled or failed.

### .github/workflows/desktop-publish.yml
- Manual desktop publication: `route` (pick the successful package run and its original machine), `prepare` (resolve the retained package and the approval environment, verify with `--check` and no upload credentials), `publish` (behind `desktop-test`/`desktop-production`).

### .github/workflows/docs-pages.yml
- Manual-only GitHub Pages deployment from a `dsh-v*` tag; `release:verify --family dsh` is the single definition of "released" shared with the npm sequence.

### .github/workflows/e2e.yml
- Real-API end-to-end workflow with an explicit security note that the trigger must never become `pull_request_target`, a job-level `if:` that skips fork/Dependabot PRs, and a mandatory key preflight.

### .github/workflows/expected-filenames.yml
- Fails PRs that add golden/snapshot-named files, with `DSH_TELEMETRY_DISABLED=1` so CI never reports to the production telemetry endpoint.

### .github/workflows/issue-lifecycle.yml
- Lifecycle workflow that checks out the **trusted default branch** with `persist-credentials: false`, mints a Project App token, and runs `policy.mjs lifecycle` — the PR body is never executed.

### .github/workflows/issue-policy.yml
- Policy workflow whose preflight decides whether a privileged Project token is minted at all; the validation step always re-reads live state, and a failed supported preflight fails the job instead of falling back.

### .github/workflows/macos-package.yml
- Manual macOS arm64 packaging on a self-hosted runner; the first step validates the source ref (production must be `master` or a `dsh-v*` tag, the tag must match `package.json`, and the checkout must equal the tag) before any dependency install.

### .github/workflows/node-addon-system-release.yml
- Release workflow for the native addon family: per-architecture prebuilds, assembly, pack, verify-packed-install with `NALR_REQUIRE_LANDLOCK=1`, and a publish script that skips already-published versions so a re-run is safe.

### .github/workflows/node-addon-system.yml
- Native addon CI: each platform builds once and those exact bytes are tested on Node 20/22/24/26 and inside musl containers; the Landlock launcher test sets `NALR_REQUIRE_LANDLOCK=1` so an unenforcing kernel fails instead of skipping.

### .github/workflows/pi-ai-provider-e2e.yml
- Opt-in e2e against Azure OpenAI and Anthropic with a mandatory key preflight (fails rather than reporting an all-skipped green) and `DSH_E2E_MAX_WORKERS=2`.

### .github/workflows/publish-ssh-helper.yml
- SSH helper release: validate the tag against `package.json`, build through the reusable workflow, verify checksums against the recorded source commit, then attach the archives to a GitHub release.

### .github/workflows/python-release.yml
- Python release: build six wheels, prove compatibility on Python 3.10 and 3.14 by installing the wheels and running the public entry path, verify `SHA256SUMS`, and publish the SDK and runtime wheels as separate jobs.

### .github/workflows/release-publish.yml
- Manual npm publication of the `dsh` family: pack, pack the vendored framework and the Landlock entry *locally* so the verification does not depend on the registry, verify the packed install, then publish in the protected `npm-publish` environment with `--ignore-scripts`.

### .github/workflows/release-vendor-publish.yml
- Manual npm publication of the vendored Cordis packages from a `vendor-*` tag, with an optional `--dist-tag` input; the publish job installs with `--ignore-scripts` and uploads the bytes the pack job produced.

### .github/workflows/release-vendor.yml
- Credential-free rehearsal of the vendor family on every PR and master push; the persistent-runner expression admits the in-house pool only for this repository, non-Dependabot, master push or same-repo non-fork PR.

### .github/workflows/release.yml
- Credential-free dependency-layout verification and pack rehearsal for the `dsh` family on every PR and master push, using the same self-hosted trust predicate as the vendor rehearsal.

### .github/workflows/sandbox.yml
- Master-only real-kernel sandbox proofs: bwrap, Landlock (x64 and arm64) and Seatbelt legs, each of which must assert its own platform files actually ran.

### .github/workflows/weighted-approval-review-event.yml
- A minimal workflow whose only job echoes that a review event happened, so the publisher can react via `workflow_run` without granting the untrusted PR any permission.

### .github/workflows/weighted-approval.yml
- The weighted-approval publisher: revoke the previous status *before* dependency setup, then publish success/pending/error; the status-writing job checks out the trusted default branch and reads PR content only as API data.

### .github/workflows/windows-package.yml
- Manual Windows packaging on a dedicated self-hosted runner; the first step resets the checkout after proving it is a direct child of `RUNNER_WORKSPACE` with no reparse-point ancestors.

### .gitignore
- Root ignore list: build outputs (`lib/`, `dist/`, `apps/web/dist/`, `apps/desktop/.desktop-build/`), caches, `.env` and signing material, session/state directories, worktrees and Python caches.

### .gitlab-ci.yml
- GitLab CI for the Python release family: tag-gated workflow, SDK and per-platform runtime wheels, glibc ≤ 2.28 and manylinux_2_28 container smoke, macOS deployment-target and `lipo` arch checks, and a twine upload to GitLab PyPI.

### .jscpd.json
- Duplicate-detection config: 60 tokens / 6 lines, TS and TSX only, tests and `tsdown.config.ts` ignored, `exitCode: 1`, and a `jscpd:ignore-start/end` escape hatch.

### .oxlintrc.json
- The oxlint configuration: type-aware rules, a shared strict override for package/app/script/website sources, and many narrow overrides.
- Non-obvious design decisions: `no-restricted-properties` bans `crypto.randomUUID` with the reason in the message ("browsers withhold crypto.randomUUID outside secure contexts"); `typescript/no-explicit-any` is an error because "every intentional any needs a narrow suppression with rationale"; a comment calls lost promises "the repository's highest-value linted bug class".
- Edge cases: each ignore pattern carries a comment saying *why* it is ignored (vendored source keeps upstream style; `native/**` has its own gates; `website/.generated/**` is generated).
- Surprising: `categories.correctness` is off repo-wide and the rules are re-enabled per override, so the rule set is explicit rather than inherited from a preset.

### .oxlintrc.staged.json
- Pre-commit overlay: extends the main config with `typeAware: false` and a narrower ignore list; the staged lint hook then applies `--fix` and stages the result.

### .rgignore
- One-line ripgrep ignore excluding `/.agents/notes/archived/` because frozen notes are "historical snapshots, not current search authority".

### snapshots/web/present/workspace.expected/说明.txt
- A 15-byte expected-output file for the `present` web snapshot (the literal text `DELIVERED_NOTE`); read in full — it is a fixture assertion, not code. (The manifest records size 0; the file on disk holds 15 bytes, so the manifest's size column appears stale for this one path.)

### AGENTS.md
- Purpose: the root contract every contributor and agent reads.
- Key abstractions: the package-group layout table; the command list; the conventions list.
- Data flow: `pnpm install` → `build:artifacts` → `build:check` → focused checks per surface → `dsh-pre-push-checks`.
- Non-obvious design decisions: "Registrations are effects" — every contribution goes through `ctx.effect()`/`ctx.on()` and a registry's `register()` returns the disposer; "Model-visible ⟺ logged" — anything reaching a model request must be reconstructable from the session log.
- Edge cases: "Trust TypeScript at typed same-process boundaries. Do not add runtime validation … solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries." Also: an empty `catch` must name the error and why, and keep its `try` to one statement.
- Surprising: "No hardcoded tunables in plugins" — deployment-varying choices are validated `Config` fields changeable from `cordis.yml`, and a `DEFAULT_*` constant or test hook is *not* configurability.

### apps/desktop-host/package.json
- Private Node-mode host package manifest; depends on `koffi` (FFI), the Cordis workspace, and the app-boot/agent/jobs/schedule/workspace/webserver/connection/account packages.

### apps/desktop-host/src/cli.ts
- Desktop CLI entry: runs the ordinary `dsh` CLI with the bundled runtime's `pnpm` as the package manager and the Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), and installs Windows console-signal handling on win32.

### apps/desktop-host/src/index.ts
- Purpose: launch the Desktop profile through the Web application and report its URL to Electron.
- Key abstractions: the IPC protocol (`ready`, `shutdown`, `quit-inspection`, `update-tasks`, `platform-session`, `fatal`).
- Data flow: resolve the profile and layered env → `runProfile()` on `127.0.0.1:0` → install the update/quit controls → mount the Office plugin → publish the authenticated URL with the index injections.
- Non-obvious design decisions: `stop` is memoized (`stopping ??=`) so shutdown happens exactly once, and startup failure is reported by `main` while shutdown only owns a tree that booted (`await application.catch(() => undefined)`); the fatal diagnostic is sent over IPC *and* to stderr because "stderr bytes and this IPC message race, and the shell reports the first failure it sees".
- Edge cases: `quit-inspection` and `update-tasks` messages are validated for a safe-integer `requestId` and an allowed action before any work; an unavailable host answers with `activeTasks: true` so "the shell treats an unknown state as interruptible work and asks before quitting".
- Surprising: the runtime directory is passed as `process.argv[2]` and an optional `process.argv[5]` re-launches Node with `--expose-internals`, which is how the packaged runtime is entered.

### apps/desktop-host/src/office-engine.ts
- Purpose: make packaged Office engine manifests resolvable from their unpacked directories.
- Key abstractions: a Node `module.registerHooks` resolver; `runtimeArchivePath()`.
- Data flow: detect `app.asar` → compute the `app.asar.unpacked` twin → intercept resolution of `@deepseek-ai/libreoffice-kit-<platform>-…` → realpath the canonical target → rewrite the URL.
- Non-obvious design decisions: the hook applies only to the current thread, so worker threads must install their own resolver; the canonical path is computed with `realpathSync` before comparison so a symlinked engine is still detected.
- Edge cases: an engine that resolves elsewhere *inside the archive* throws `desktop Office engine resolved outside the runtime package directory` rather than silently running the archived copy.
- Surprising: a prepared (non-ASAR) runtime returns `undefined` and installs no hook at all.

### apps/desktop-host/src/office.ts
- Cordis plugin mounting the Office skills and workspace dependencies with the packaged payload's paths; missing sibling `office-skills` resources fail Host startup.

### apps/desktop-host/src/platform-session.ts
- Publishes DeepSeek Platform credential sessions to the Electron shell over private IPC.
- Key abstractions: an `AbortController` per effect lifetime; `account.watch(signal, true)` for identity changes.
- Data flow: subscribe → for each state change read the platform session → publish it → on disposal abort, publish `null` and await the loop.
- Non-obvious design decisions: the credential read is re-checked against `lifetime.signal.aborted` *after* the await, so a read that completes during disposal is suppressed rather than published stale; the disposer publishes `null` before awaiting the update loop so the credential is cleared first.
- Edge cases: a subscription failure is logged as a warning only when the lifetime was not aborted (an abort is not an error).
- Surprising: the docstring states the credentials "never" reach the renderer — the publisher is a private IPC channel.

### apps/desktop-host/src/quit-inspection.ts
- Purpose: report what quitting the Host now would affect.
- Key abstractions: `DesktopQuitInspection { activeTasks, scheduledTasks }`; the `workspace/session-activity` waterfall.
- Data flow: list live agents → `hasDesktopActiveTasks` → for each agent, ask the workspace for session activity → report whether any entry has `kind === 'schedule'`.
- Non-obvious design decisions: the inspector only counts reminders of sessions that were *loaded during this run*, because a session never loaded cannot fire a timer; the waterfall supplies a default of `[]` so a missing provider is not an error.
- Edge cases: after disposal the inspector rejects with `desktop quit: Host is stopping`; unavailable task services reject with `task services are unavailable` rather than reporting "idle".
- Surprising: the same `hasDesktopActiveTasks` rule is shared with the update-restart check, so the two surfaces cannot disagree.

### apps/desktop-host/src/update-tasks.ts
- Purpose: update admission and task inspection for the shared Web Host.
- Key abstractions: `hasDesktopActiveTasks()`; `installDesktopUpdateTaskControl()` with `inspect | lock | unlock`.
- Data flow: `connection/request` listener → if locked answer 503 and stop → otherwise track the admitted request → on `lock`, set the flag, drain `pendingRequests`, then re-check for active work.
- Non-obvious design decisions: read requests are not tasks, but admitted writes must finish before the final work check; a `lockGeneration` counter detects a lock that was superseded while draining, and the caller is told so.
- Edge cases: a request admitted before the lock still completes (`Promise.all(pendingRequests)`), so the update never cuts a write in half; after disposal every action rejects with `desktop update: Host is stopping`.
- Surprising: `unlock` also increments the generation, so a late `lock` cannot silently re-close the door.

### apps/desktop-host/src/windows-cli-signals.ts
- Purpose: deliver console interrupts to CLI listeners in Electron's Windows Node mode.
- Key abstractions: a `koffi` FFI binding to `SetConsoleCtrlHandler`.
- Data flow: load `kernel32.dll` → declare the `__stdcall` handler prototype → register a callback mapping event 0 → `SIGINT` and 1 → `SIGBREAK` → install the handler.
- Non-obvious design decisions: koffi queues callbacks from the console thread onto the JS thread, so the callback is a thin trampoline; the registration lasts until process exit.
- Edge cases: if `SetConsoleCtrlHandler` returns 0 the handler is unregistered and the call throws `desktop CLI: cannot register the Windows console handler`; unknown events return 0 to retain native handling.
- Surprising: this is the whole of Ctrl-C support for the desktop CLI — a one-file mechanism that would be hard to rediscover.

### apps/desktop-host/tests/office-engine.spec.ts
- Vitest suite for the ASAR resolver: engine manifests resolve into `app.asar.unpacked`, unrelated modules are untouched, an engine missing from the unpacked tree throws, a renamed runtime directory still works, a directory alias resolves, and an engine resolved elsewhere inside the archive throws the specific message.

### apps/desktop-host/tests/office.spec.ts
- Vitest suite mounting the office plugin in a real Cordis context: the seven office skills appear, the `office-pptx` skill body contains `office-render` and *not* the Node directory, exactly one tool (`load_workspace_dependencies`) is registered, and disposing the plugin entry removes both the skills and the tools.

### apps/desktop-host/tests/platform-session.spec.ts
- Vitest suite for credential publication: a replaced provider republishes a new session, a stream that ends (with or without failure) clears the credential, and a credential read that completes *during* provider disposal is suppressed.

### apps/desktop-host/tests/quit-inspection.spec.ts
- Vitest suite for quit inspection using narrow service doubles over a real Cordis event lifecycle; the schedule family is counted only for loaded sessions, the walk stops at the first armed reminder, unavailable services are not "idle", and the inspector refuses after disposal.

### apps/desktop-host/tsconfig.json
- Project references for the desktop host: Cordis, agent, jobs, schedule, workspace, skill-office, home-paths, tool-workspace-dependencies, apps/cli, app-boot, the client connection host config, the webserver and the credential account package.

### apps/desktop-host/tsdown.config.ts
- tsdown config emitting two ESM entries (`index`, `cli`) with `codeSplitting: false`, `dts: false` and `clean: false`.

### apps/plugin-market-generator/package.json
- Private generator package with `commander`, `semver`, `tar`, `yaml`, `hosted-git-info` and `resolve.exports`; the workspace index/manifest packages supply the format and the shared types.

### apps/plugin-market-generator/README.i18n.yaml
- Per-heading hash pair record for the plugin-market-generator README pair.

### apps/plugin-market-generator/README.md
- Owner doc for the index generator: options and defaults, the 0/1/2 exit-status contract, what gets listed (npm non-deprecated bundle versions; Git release tags and the default branch), the caching model, the security model, and the stated limits.

### apps/plugin-market-generator/README.zh.md
- Line-aligned Chinese counterpart, including the same security section (64 MiB tarball bounds, integrity verification, hooks/fsmonitor/submodules disabled, https+ssh only).

### apps/plugin-market-generator/src/bin.ts
- Four-line entry: `process.exitCode = await main(process.argv.slice(2))`.

### apps/plugin-market-generator/src/cli.ts
- Purpose: the command-line surface of the index generator.
- Key abstractions: bounded integer option parsers; `run()`; `main()`.
- Data flow: parse options → resolve paths against `INIT_CWD` (because `pnpm --filter … start` runs in the package directory) → `generate()` → write icons and the index with `writeIfChanged` → delete stale generated icons → print a one-line summary.
- Non-obvious design decisions: the exit status is a *contract* (0 = all sources read, 1 = some source fell back or was omitted, 2 = invalid arguments or input) and it is documented in `--help`; the output index is rewritten only when its content changes.
- Edge cases: `CommanderError` with `commander.helpDisplayed` maps to 0, every other parse error to 2; a thrown error in `run()` is reported as a message, not a stack.
- Surprising: stale generated icons are deleted by a `GENERATED_ICON` name pattern, so a user's own file in `icons/` is never removed.

### apps/plugin-market-generator/src/fetchers.ts
- Purpose: download package files **without running their code**.
- Key abstractions: `FetchLimits`; `npmPackument`; `npmTarball`; `gitEnv`/`git`; `GitObjects`; `withGitObjects`.
- Data flow: registry document → tarball bytes → integrity check → in-memory unpack → `PackageFiles`; or `ls-remote` → private bare repo → depth-1 fetch by SHA (falling back to ref names) → `ls-tree`/`cat-file` blob reads.
- Non-obvious design decisions: the git environment strips every `GIT_*` variable except `GIT_SSH`/`GIT_SSH_COMMAND`, forces `GIT_TERMINAL_PROMPT=0` and `GIT_LFS_SKIP_SMUDGE=1`, and every invocation carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c protocol.allow=never` plus `protocol.<t>.allow=always` for the allowed transports only.
- Edge cases: the tarball is bounded in compressed *and* unpacked size; the registry integrity hash must match; the unpacked `package.json` must name the requested package and version; symbolic links (mode 120000) and submodules (160000) are treated as non-files.
- Surprising: because objects are read as blobs with **no working tree**, checkout filters, LFS downloads and symlinks never take effect — the fixture cannot be tricked into executing anything.

### apps/plugin-market-generator/src/files.ts
- Purpose: atomic writes and the in-memory file tree.
- Key abstractions: `writeIfChanged()` (temp sibling + rename); `readJsonFile()` (lenient); `PackageFiles`.
- Data flow: write → compare bytes → skip or temp-write → rename; read → normalise POSIX path → reject anything leaving the tree.
- Non-obvious design decisions: `readJsonFile` swallows malformed JSON and treats the file as absent, because "a file from an older or interrupted generator is treated as absent and rebuilt"; `PackageFiles.resolve` rejects absolute paths and `..` escapes.
- Edge cases: `MAX_TEXT_FILE_BYTES = 1 MiB` refuses an oversized manifest, locale or workspace file; `within(dir)` re-roots a subtree.
- Surprising: `writeIfChanged` never touches the file when the bytes already match, which is what makes the generator's output deterministic across runs.

### apps/plugin-market-generator/src/generate.ts
- Purpose: turn a source list into a validated format-1 index, reusing cached results for unchanged releases and commits.
- Key abstractions: `Cache` (keyed by `[CACHE_VERSION, ...immutable inputs]`); `readNpm`; `readGit`; `mapLimited`; `generate`.
- Data flow: for npm, read the packument → filter to non-deprecated bundle versions with a publish time → derive a range → key the cache on (registry, icon threshold, name, sorted version list) → on a miss download only the highest version's tarball for display fields. For Git, read refs → derive release tags → key the cache on (icon threshold, url, head, tags) → on a miss walk the head tree, then per (commit, package directory) read and cache the release.
- Non-obvious design decisions: `CACHE_VERSION = 7` is part of every cache key, so changing how entries are derived invalidates every cached record; a cached record is only used when the index format accepts its plugins *and* its icon files exist; version ranking is `rank` first (a `<name>@` tag beats a unified tag beats the default branch) then publish time.
- Edge cases: a source that cannot be read keeps its last successful result and is still reported in `failures`; a commit that cannot be read (a release-named tag on a blob) lists none and is warned about, so one bad ref cannot fail the repository.
- Surprising: only the *highest* listed npm version's tarball is downloaded — every other version's display fields are inherited, which is what makes a 3,000-package run cheap.

### apps/plugin-market-generator/src/metadata.ts
- Purpose: read a package's display metadata the way DSH reads installed plugin metadata, without evaluating anything.
- Key abstractions: `Display`; `DisplayOptions`; `IconFile`; `resource()` (exports-map resolution); `dictionaries()`; `localized()`; `repositoryUrl()`; `readIcon()`.
- Data flow: resolve `./locale/en.json` through the package's `exports` map → read every sibling `*.json` in that directory → require each to resolve into the same directory → build a language→fields map → combine with the manifest fallback → resolve the icon → inline it as a data URL or write it as a file.
- Non-obvious design decisions: the manifest `icon` takes priority over the `./icon` export; the `author` person string is stripped of `<email>` and `(url)` so "no address spreads into the index"; `homepage` is copied *as written* and nothing else stands in for it.
- Edge cases: a locale whose name is not a language id, a duplicate locale, a locale that does not resolve into the English locale's directory, a malformed locale JSON, an icon outside the package, an icon in an unsupported format, or an icon over 256 KiB are all warned about and omitted.
- Surprising: the format requires English, so a translation with no English value *and* no manifest fallback is dropped entirely.

### apps/plugin-market-generator/src/packages.ts
- Purpose: read manifests and find bundle packages without running any of their code.
- Key abstractions: `Manifest`; `isBundle()`; `dshRange()`; `workspaceGlobs()`; `expandGlob()`; `findBundlePackages()`.
- Data flow: `dsh.bundle.patch` decides whether a package is a plugin; `engines.dsh` (or the conjunction of the `@deepseek-ai/dsh*` peer ranges) decides the advertised range; workspace globs (or a three-level fallback scan) locate bundle packages.
- Non-obvious design decisions: a peer range of exactly `workspace:*`, `workspace:^` or `workspace:~` means "the running DSH version" and imposes nothing, while a `*` range admits every version; the conjunction of several ranges is computed by combining one `||` alternative of each, keeping each comparator once, and dropping combinations no version satisfies — bounded at 256 alternatives.
- Edge cases: a range that no DSH version satisfies (empty, `workspace:`-prefixed, invalid, or mutually unsatisfiable) is an **error** that skips the version with a warning, not a silent pass; negated workspace globs are ignored; a glob matching nothing is reported.
- Surprising: `expandGlob` matches each path segment literally, with `*` inside a segment and `**` for zero or more directories bounded by `SCAN_DEPTH`; a parent-relative glob matches nothing.

### apps/plugin-market-generator/src/sources.ts
- Purpose: parse the source list.
- Key abstractions: `Source`; `parseSources()`.
- Data flow: split lines → skip blanks and `#` comments → for a URL, normalise away a trailing `/` and `.git` → validate the line by constructing a throwaway index and calling the real format parser → de-duplicate by kind+key.
- Non-obvious design decisions: the accept/reject decision is delegated to the index format itself rather than duplicated — "the CLI's accept/reject decision is the format's decision".
- Edge cases: the error message carries the 1-based line number and the format's own reason (`must use https:`, `must not contain credentials`, `must name a repository with at least two path segments`, `must name a repository, not a tarball`).
- Surprising: `https://github.com/o/r/` and `https://github.com/o/r.git` are the same repository, so they de-duplicate to one source.

### apps/plugin-market-generator/tests/cli.spec.ts
- Vitest suite for the CLI: help text contains every option with its default and the exit-status sentence; invalid numbers, unknown options and missing required options all exit 2 with the Commander message; a missing input file is reported as ENOENT.

### apps/plugin-market-generator/tests/discovery.spec.ts
- Vitest suite covering source parsing (9 rejection cases), bundle detection, `dshRange` derivation, workspace glob expansion, locale handling and every icon rejection message.

### apps/plugin-market-generator/tests/generate.spec.ts
- Vitest suite running the real CLI against a local HTTP registry serving packuments and tarballs, including a mirror that answers 503, a tarball whose integrity does not match, an oversized body with no content length, and stale-icon cleanup.

### apps/plugin-market-generator/tests/git.spec.ts
- Vitest suite that builds real Git repositories, routes an `https` URL to the fixture with `url.<base>.insteadOf`, sets `protocol.version=0` and a *required* checkout filter — and proves the filter never runs because there is no working tree; also covers an oversized manifest and a user's `GIT_SSH_COMMAND` being preserved.

### apps/plugin-market-generator/tests/support.ts
- Shared test helpers: an ordered cleanup list that runs in reverse even when one fails (aggregating errors), `scratch()` temp dirs and `setEnv()`.

### apps/plugin-market-generator/tsconfig.json
- Project references to the plugin-market-index and package-manifest packages.

### BENCHMARK.md
- Three-line pointer to the Python SDK guide, with the practical advice to use separate workspaces and session IDs for independent benchmark tasks.

### benchmarks/active-stream-reconnect/README.i18n.yaml
- Per-heading hash pair record for the reconnect benchmark README pair.

### benchmarks/active-stream-reconnect/README.md
- Owner doc: the production Client fold when a reconnect carries an unfinished 100,000-delta reasoning prefix; a compiled private adapter reaches `ClientAssistantStream.replace()` without adding product exports; three fresh plain-Node workers synthesize the baseline before timing; 50 ms reference expectation → 125 ms CI ceiling; 30 MiB retained-heap budget with no time scaling.

### benchmarks/active-stream-reconnect/README.zh.md
- Line-aligned Chinese counterpart of the reconnect benchmark owner doc.

### benchmarks/active-stream-reconnect/reconnect.bench.client.ts
- Bench case that (a) accepts the three recorded hosted sample sets and rejects synthetic regressions, pinning the budget arithmetic, and (b) runs three fresh workers and enforces the median replace time and the retained-heap ceiling.

### benchmarks/active-stream-reconnect/reconnect.worker.client.ts
- Compiled worker: builds the 100,000-delta reasoning prefix with the production `AssistantStreamAccumulator`, times only `client.replace()`, measures retained heap after a forced GC, and then proves the *next* dense live frame is still accepted (`nextFrame === 'transient'`).

### benchmarks/agent-continuation/README.i18n.yaml
- Per-heading hash pair record for the backend continuation benchmark README pair.

### benchmarks/agent-continuation/README.md
- Owner doc for four backend continuation cases, with per-case budgets (900 ms + 1.25× for catalog and tool continuation, a separately reviewed 297 ms hosted limit for request history, reference-machine scaling for the SDK variant) and the rule that temporary roots are removed on failure too.

### benchmarks/agent-continuation/README.zh.md
- Line-aligned Chinese counterpart of the backend continuation owner doc.

### benchmarks/agent-continuation/agent-continuation.bench.ts
- Bench file for four cases with five fresh-process samples each, a runtime fingerprint (CPU models, available parallelism, platform, Node/V8 versions), and *calibration cases* that assert the recorded hosted samples pass the new budget and fail the old one.

### benchmarks/agent-continuation/agent-continuation.worker.ts
- Worker that seeds and resumes an 800-turn session through the real `AgentLoop` with a synthetic `LlmAdapter` and a registered content tool, then reports total/resume/turns/flush timings, CPU time, retained heap and peak RSS.

### benchmarks/agent-continuation/child-catalog.worker.ts
- Worker seeding 16 fork children that each *inherit* an 80-turn history (`inheritedEventCount`), then measuring the first and repeated `listChildren` catalog reads.

### benchmarks/agent-continuation/profile-adapter.ts
- A compiled plugin (`name`, `inject = ['llm']`) registering a synthetic provider that drives the production `str_replace_editor` tool on alternating turns.

### benchmarks/agent-continuation/profile-continuation.worker.ts
- Worker driving the **shipped** `sdk-minimal` profile through `DeepSeekHarness` with a written patch file that disables the real provider and mounts the benchmark model — 100 turns, 800 real file reads, with a 40 s watchdog that requests cancellation.

### benchmarks/agent-continuation/synthetic-history.bench.ts
- Bench case proving the benchmark seed's protected system head survives continuation: after the next prompt replaces it, the restored session's first derived message is the new prompt and the rest of the history is byte-identical.

### benchmarks/agent-continuation/workload.ts
- The reviewed synthetic workload dimensions (800 history turns, 4 tools per historical turn, 40 request turns, 20 continuation turns, 16 children) and the deterministic builders: `response()` emits a full chunk stream, `syntheticHistory()` authors history through the production `Session.append` API, `resultText()` produces a bounded tool result.

### benchmarks/AGENTS.md
- Purpose: the contract for the benchmark tree.
- Key abstractions: organize by measured user path (not by package); `*.bench.ts` for Host cases and `*.bench.client.ts` for Client-face cases; support modules carry no benchmark suffix.
- Data flow: `test:bench` builds workspace libraries and the `benchmarks/.dsh-build/` workers before Vitest orchestration; each budgeted endpoint is passed to `recordTimings` *before* it is asserted.
- Non-obvious design decisions: "Synthesize fixed inputs from reviewed constants. Never use recorded Sessions, user material, ambient repositories, or network services"; "Exercise production entry points. Do not copy product algorithms, add production exports solely for measurement"; a compiled worker may bundle a private integration adapter only when no public Node export exposes the measured path.
- Edge cases: process-level samples run in fresh children with private `mkdtemp` roots that are removed after failure as well as success; memory budgets take headroom but never the time scale.
- Surprising: `pnpm run test:bench:memory 4g|8g` reruns selected files inside a swapless cgroup capped at 4 or 8 GiB, and a file's budgets must stay valid under both caps.

### benchmarks/conversation-fold/conversation-fold.bench.client.ts
- Bench cases for the large-window fold (200 replies, 500,000 streamed deltas compacted into 1,600 records, 16 ms reference) and for streamed tool-argument preparation (`write` 512 KiB, `bash` 128 KiB) with separate time and retained-heap budgets.

### benchmarks/conversation-fold/conversation-fold.worker.client.ts
- Compiled worker that folds 200 replies through the production `ConversationNodeAssembler` and every production chat node definition, and reports the delta-scaling ratio between a 100-delta and a 2,000-delta window with equal event and record counts.

### benchmarks/long-session-browser/README.i18n.yaml
- Per-heading hash pair record for the long-session browser benchmark README pair.

### benchmarks/long-session-browser/README.md
- Owner doc for the Chromium workflow: open, page, trajectory and stream endpoints, the readiness rules ("A replaced button fails instead of selecting a replacement"), the 900/700/520 ms hosted expectations → 1125/875/650 ms limits, and the fixture's shape (mixed-language prompts, 20 code fences, 40 synthetic tool results).

### benchmarks/long-session-browser/README.zh.md
- Line-aligned Chinese counterpart of the long-session browser owner doc.

### benchmarks/long-session-browser/long-session.bench.ts
- The Chromium benchmark plus its **control cases**: a fixed measurement clock still enforces browser deadlines; a page that renders beyond the unchanged paging ceiling is rejected; an ambiguous or replaced "Load earlier" button fails before paging.

### benchmarks/long-session-browser/synthetic-history.ts
- Synthetic 240-turn current-generation history (mixed prose, code fences, reasoning, tool calls) and a 120-delta paced reply, authored through the production `Session`/`AssistantStreamAccumulator` APIs.

### benchmarks/package.json
- The private benchmark workspace manifest, listing every production package the benchmark lanes depend on — including the agent-loop, session, subagent, tools and client-UI packages.

### benchmarks/session-corpus/README.i18n.yaml
- Per-heading hash pair record for the session-corpus benchmark README pair.

### benchmarks/session-corpus/README.md
- Owner doc for the list/search/fork benchmarks: every synthetic Session is at least as long as the same quantile of a *measured local* corpus; search and fork use separate 1,000-Session corpora, list uses 3,000; seeding writes ~1.5 GB of Zstandard logs.

### benchmarks/session-corpus/README.zh.md
- Line-aligned Chinese counterpart of the session-corpus owner doc.

### benchmarks/session-corpus/corpus-shape.ts
- Purpose: the measured quantile anchors the synthetic corpus follows.
- Key abstractions: 22 quantiles; three measured dimensions (events, logical bytes, turns) from 1,650 local Sessions measured on 2026-09-28.
- Data flow: `sessionShape(rank, count)` maps an ascending rank to the next measured anchor at or above that quantile, so every quantile of the generated corpus is at least the measured one, and dimensions share the rank so a long Session is long in every dimension.
- Non-obvious design decisions: only counts and byte totals were extracted — "no content, identity, or path" — so the fixture carries no user material.
- Edge cases: a rank outside the corpus throws rather than clamping.

### benchmarks/session-corpus/projection-list.bench.ts
- Bench case measuring the Session-list projection + JSON and the *worst Host queue delay* across modest (50 sessions), tail (300) and cheap (3,000) workloads; the queue delay gets its own budget with `ioShare = 0` because "Queue delay is time other callbacks wait behind list work on the Host thread, which is CPU work".

### benchmarks/session-corpus/projection-list.worker.ts
- Worker seeding large persisted projections against small wire summaries, using a `zod` schema to declare the synthetic projection state and measuring list latency, wire views, callback delay and event-loop delay via `monitorEventLoopDelay`.

### benchmarks/session-corpus/session-corpus.bench.ts
- Bench file with three cases (list 3,000 / search 1,000 / fork 1,000), the recorded hosted medians *and* the rounded expectations above them, separate peak-RSS budgets, and a final case failing when the whole file — **including seeding** — exceeds five minutes.

### benchmarks/session-corpus/session-corpus.worker.ts
- Worker that mounts the shipped Web Host's Session list/search/fork dependencies, prepares anchor bodies through the production writer (replay-validated by `Session.create`), waits for the projection-cache write-back to become durable, and measures list/search/fork with CPU and memory.

### benchmarks/session-corpus/synthetic-corpus.ts
- Deterministic corpus writer: one event body per anchor stored as its own header frame plus body, a Mulberry32 PRNG, a prime stride that permutes creation order independently of length rank, a 19-sessions-per-project spread, every sixth session a subagent child, and a vocabulary-driven pair of search queries.

### benchmarks/session-open/session-open.bench.ts
- Bench file for cold Session preparation, first history and Agent resume, with two access kinds (first open from a released V0 file vs fresh-process reopen after upgrade), per-phase budgets, hosted calibration cases, and a 128 MB old-space variant.

### benchmarks/session-open/session-open.constants.ts
- The stable session id, cwd, storage directory and released-v0 filename the whole opening benchmark agrees on.

### benchmarks/session-open/session-open.worker.ts
- Worker measuring four scenarios (`phase-migrate`, `phase-steady`, `first-history`, `agent-resume`) with phase timings, CPU time and a before/after forced-GC memory delta.

### benchmarks/session-open/synthetic-released-v0-session.ts
- Builder for a deterministic released-v0 Zstandard generation, including the compact `*-chunks` row shape (`seq0`, `time0`, `dt` array, `texts`) that matches the real historical layout.

### benchmarks/tsdown.config.ts
- tsdown build config for the benchmark tree: one entry per benchmark worker, each emitted into its own `benchmarks/.dsh-build/<name>` directory with `deps.neverBundle: [/^@deepseek-ai\//]`, so every product package keeps resolving through its built `lib/` entry while the worker itself is compiled.
- Non-obvious design decisions: the Client-face workers (`reconnect`, `conversation-fold`, `user-text`) build with `tsconfig.client.json` and the Host-face workers with `tsconfig.host.json`, so the two compiler faces stay explicit and a worker never mixes them.
- Edge cases: `clean: true` per output directory, so a stale worker can never be measured.

### benchmarks/support/built-worker.ts
- Purpose: launch compiled benchmark workers in a plain Node child.
- Key abstractions: `runBuiltBenchmarkWorker()`; `assertBuiltBenchmarkRuntime()`.
- Data flow: spawn with the requested V8 flags and a scrubbed environment → collect stdout/stderr → on close, parse the last JSON line as the report → resolve with exit code, signal, timeout flag and stderr.
- Non-obvious design decisions: `NODE_OPTIONS` and `TSX_TSCONFIG_PATH` are removed from the child environment so no loader can leak in; `assertBuiltBenchmarkRuntime` then *re-checks* that the worker ran from `benchmarks/.dsh-build`, that no tsx loader is in `process.execArgv`, and that every product package resolved to a built `lib/*.js`.
- Edge cases: a stuck child is `SIGKILL`ed at the deadline and the run reports `timedOut: true` rather than hanging.
- Surprising: the report is taken from the last stdout line that starts with `{`, so a worker may print diagnostics before its report.

### benchmarks/support/calibration.ts
- Purpose: convert a reference-machine expectation into a CI wall-time budget.
- Key abstractions: `CI_TIME_SCALE = 2` (measured x64-CI vs arm64-reference ratio), `PERFORMANCE_BUDGET_HEADROOM = 1.25`, `ciTimeBudget()`.
- Data flow: `ciTimeBudget(expectedMs) = ceil(expectedMs × 2 × 1.25)`.
- Non-obvious design decisions: the scale is *measured*, not assumed, and it applies to **time only** — memory and dimensionless ratios are never scaled.
- Edge cases: the result is an integer ceiling, so the budget is never below the expectation.
- Surprising: two constants in one 15-line file encode the entire performance-governance policy of the repository.

### benchmarks/support/machine-profiles.ts
- Purpose: reviewed machine profiles used to rescale benchmark endpoints.
- Key abstractions: `MachineProfile { cpuScore, cores, ioLatencyUs, cpuModelMatches }`; 17 profiles from a 2015 laptop to AWS/GCP/Azure/Alibaba and the GitHub runners.
- Data flow: `matchMachineProfile(os.cpus()[0].model)` identifies the measuring machine; the report then rescales each endpoint to every other profile.
- Non-obvious design decisions: `cpuScore` is a PassMark single-thread rating retrieved on a stated date, because measured endpoints run on one JS thread; `cores` limits endpoints whose CPU time shows more than one busy CPU; memory is not modelled at all.
- Edge cases: the docstring states the limits — PassMark across ISAs, burstable/shared vCPUs and hybrid efficiency cores is coarse, and the storage latencies are estimates.

### benchmarks/support/scaling-report.ts
- Purpose: collect budgeted endpoints and render a self-contained interactive HTML report.
- Key abstractions: `BenchmarkCase { id, measures, affects }`; `Timing` (either `cpuMs` measured or a declared `ioShare`); `recordTimings()`; `recordPeakMemory()`.
- Data flow: bench files append records to `benchmarks/.dsh-report/results.jsonl` → the Vitest global setup renders `report.html` → the report rescales each endpoint per machine profile and renders it as a table with per-endpoint `io` overrides.
- Non-obvious design decisions: the scaling formula is `ms × ((1 − io)·cpuScore(measured)/cpuScore(target)·coreFactor + io·ioLatency(target)/ioLatency(measured))`; `io` is the measured non-CPU share when the worker reports CPU time and a declared estimate otherwise; memory and dimensionless ratios are not scaled.
- Edge cases: the report is rendered even after a failed case, so a red run still produces evidence; `ioShare` overrides are per-endpoint and reversible.
- Surprising: every endpoint must carry a `BenchmarkCase` stating *what it measures* and *which user scenario it affects* — the report's rows are reader-facing, not just numbers.

### benchmarks/terminal-io/session-adapter.ts
- One-line adapter bundling the production `LocalPtySession` into the plain-Node terminal worker (the package has no plain-Node export).

### benchmarks/terminal-io/terminal-io.bench.ts
- Bench cases bounding terminal ingest as the retained window grows 32× (128 KiB → 4 MiB) with a ratio budget of 4, the retained-heap ceiling of 16 MiB for tiny-chunk and OSC-filtered input, and a 5 MiB send.

### benchmarks/terminal-io/terminal-io.worker.ts
- Worker driving `LocalPtySession` against a deterministic `SubprocessTerminalHandle` double (a `Readable` plus resolvers), measuring ingest vs complete separately and asserting the bounded endpoint's exact byte count.

### benchmarks/user-text/user-text.bench.client.ts
- Bench cases for sent-user-text evaluation with the credential matcher: unmatched corpora (absolute time *and* a ratio to the shipped rules without the matcher), matched corpora (every credential masked within budget), a linearity check on 1,000 vs 2,000 pasted keys, ten adversarial inputs at two sizes each, and an allocation budget per workload.

### benchmarks/user-text/user-text.worker.client.ts
- Compiled worker measuring the credential matcher with and without it, plus young-generation allocation.
- Non-obvious design decisions: the baseline and the matcher are measured as *adjacent pairs* with the order alternated, and the reported figure is the minimum over pairs, to limit scheduler bias; allocation is measured as `new_space + new_large_object_space` growth with a `PerformanceObserver` watching GC entries, and the measurement **fails** if any GC ran inside the interval.
- Edge cases: `queryAll` walks the matcher exactly as the scheduler does (an index loop calling `rule.match(text, from)`), so the measured allocation is the real query pattern and the loop itself allocates nothing; a fixed `--min/max-semi-space-size` keeps an interval smaller than the semi-space from scavenging.

### BRAND_GUIDELINES.i18n.yaml
- Per-heading hash pair record for the brand guidelines pair.

### BRAND_GUIDELINES.md
- Brand usage rules: third parties may truthfully say "built on DeepSeek Harness", the `DSH` abbreviation is recommended, the full trademark must not appear in a project name, and official brand assets must not imply endorsement.

### BRAND_GUIDELINES.zh.md
- Chinese counterpart of the brand asset usage guidelines.

### CLAUDE.md
- Symlink (one-line path) to `AGENTS.md` so Claude reads the same root contract.

### CONTRIBUTING.i18n.yaml
- Per-heading hash pair record for the contributing guide pair.

### CONTRIBUTING.md
- No external PRs are accepted yet, but Discussions, plugins, blog posts and answering questions are all named as ways to help.

### CONTRIBUTING.zh.md
- Line-aligned Chinese counterpart of the contribution guide.

### lefthook.yml
- Git hooks: pre-commit translation-pairing check, archived-note seal, staged oxlint with `--fix` and `stage_fixed: true`, `git diff --cached --check` whitespace check, pi-ai provider metadata check, vendor manifest guard; pre-push runs only `pnpm run typecheck`.

### LICENSE
- MIT license text, copyright 2026 DeepSeek.

### Makefile
- Short aliases (`build`, `clean`, `web`, `desktop`, `dev-web`, `dev-desktop`) over the `package.json` scripts, which remain the source of truth; `ARGS` forwards options to the launched application.

---

## Ideas worth stealing

- **A self-skipping test is not a green test** — `.github/workflows/sandbox.yml:38-42` — Each sandbox leg asserts *both* of its platform files actually ran (`Test Files 2 passed (2)`, no skips), because the e2e files self-skip where the runner is absent and a self-skip would otherwise be a false green. Transfer: any August suite that skips when a key, a kernel feature or a tool is missing must assert the skip did **not** happen, exactly as August's `e2e:smoke` already does for its keyless self-skip.

- **Preflight the secret so a self-skipping suite cannot report a false green** — `.github/workflows/e2e.yml:88-104` — The e2e suites self-skip when `DEEPSEEK_API_KEY` is absent, so the workflow adds a hard-failing preflight on the trusted events where the secret *must* exist. Transfer: August's real-provider evals need the same "the key is required here" assertion, or a missing secret silently becomes an all-skipped green.

- **Never let a `pull_request_target`-style trigger carry untrusted code** — `.github/workflows/e2e.yml:20-26` — The workflow states the security rule inline and names the fork/secret model: `pull_request` runs PR code without secrets; `pull_request_target` runs in the base repo's context with secrets while still able to check out untrusted fork code. Transfer: any August automation that acts on untrusted user content must execute its policy from the trusted branch and treat the content as data — the same shape as `.github/workflows/weighted-approval.yml:32-38`.

- **Invalidate the stale positive before doing expensive work** — `.github/workflows/weighted-approval.yml:39-44` — The publisher marks the head *pending* before Python setup or the lexer install, so "failed setup or an interrupted history fetch cannot leave a previous success in place". Transfer: any long-running status in August (a turn verdict, a build, a health check) must first clear the previous success, or a crash leaves a false green behind.

- **Two-phase gating: a cheap eligibility pass, then a full check that re-reads live state** — `.github/issue-management/issue-policy.yml:24-58` and `.github/issue-management/pull-request.mjs:97-109` — The preflight computes eligibility and whether a privileged token is needed; the validation step then re-reads the live repository, because "preflight is not a cached verdict or an exemption for metadata edits". Transfer: August's cheap policy pre-check (does this request need the expensive path?) must never be the final verdict.

- **A cheap read decides, and the privileged read is scoped to the subset that needs it** — `.github/issue-management/pull-request.mjs:21-38` — REST distinguishes an Issue from a pull-request number first; only references that resolve to real Issues require the Project read, so informational references never cost a privileged call. Transfer: August's tool-policy classification should resolve cheap metadata before escalating to any privileged or expensive operation.

- **"Incomplete" must never be reported as "zero"** — `.github/review-ownership/author-weight.mjs:40-60` — The paginated read throws `GitHub merged PR history is incomplete` on GraphQL errors, a missing `pageInfo.hasNextPage`, an invalid PR record or a cursor that did not advance; zero is returned only for a *complete* empty history, and overlapping pages are de-duplicated by PR number. Transfer: August's usage, billing and limit counters must distinguish "the provider said zero" from "I could not read the provider" — an incomplete read must never be silently priced as zero.

- **A partial measurement must fail, not under-report** — `.github/review-ownership/blame-production.py:116-125` — One blame per file covers all changed ranges; if the number of attributed lines differs from the number of changed lines the script raises `incomplete blame for <path>`. Transfer: August's perf/telemetry measurements should throw rather than report a smaller number when an instrumented path did not complete.

- **Fold an append-only log into current state with an explicit delete** — `.github/review-ownership/check-approval.mjs:55-76` — `effectiveReviewDecisions` walks the chronological review list and keeps each reviewer's *current* decision, with `DISMISSED` deleting the decision entirely. Transfer: this is exactly the fold August's session projection performs; the "dismissed deletes" rule is the model for a retraction event.

- **Treat user-authored text as an instruction only while it is still the author's own text** — `.github/review-ownership/check-approval.mjs:170-177` — A `/delegate` comment counts as a command only if nobody else edited it (`node.lastEditedAt !== null && node.editor?.id !== node.author.id → continue`), and an incomplete editor history fails the whole evaluation. Transfer: August's comment/slash-command handling should verify authorship and edit history before acting on a user's text as a directive.

- **Harden Git as a data source so repository content cannot execute** — `apps/plugin-market-generator/src/fetchers.ts:133-159` — Every invocation strips all `GIT_*` variables except `GIT_SSH`/`GIT_SSH_COMMAND`, forces `GIT_TERMINAL_PROMPT=0` and `GIT_LFS_SKIP_SMUDGE=1`, and passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c protocol.allow=never` plus `protocol.<t>.allow=always` for the allowed transports only. Transfer: if August ever runs git (or any agent workspace) over untrusted input, this is a ready-made hardening recipe.

- **Read objects as blobs with no working tree** — `apps/plugin-market-generator/src/fetchers.ts:219-232` — Symlinks (mode 120000) and submodules (160000) are skipped as non-files, and because no checkout exists, "no checkout filter, LFS download, or symbolic link takes effect". The test at `apps/plugin-market-generator/tests/git.spec.ts:44-60` proves it by installing a *required* smudge filter and showing it never runs. Transfer: any August feature that ingests a third-party repository should read blobs, never check out.

- **Verify the bytes against the registry's own integrity, and never run the package** — `apps/plugin-market-generator/src/fetchers.ts:100-121` — The tarball is streamed under a size cap, its bytes must match the registry's `integrity` hash, it is unpacked **in memory** under a second cap, and the unpacked `package.json` must name the requested package and version. Transfer: August's plugin/package ingestion should have the same three checks before anything from the package is trusted.

- **Degrade, don't disappear** — `apps/plugin-market-generator/src/generate.ts:328-336` — "Any failure of one source keeps that source's last result instead of failing the run"; the failure is still reported in `failures` and the exit status becomes 1. Transfer: when a provider, a tool or a background service fails mid-session, August should keep the last good state visible and mark it degraded rather than dropping the content.

- **A cached record is used only if it is still valid** — `apps/plugin-market-generator/src/generate.ts:88-122` — The cache record is accepted only when the index format still accepts its plugins *and* its icon files exist; a malformed or format-rejected cache file is treated as absent and rebuilt; `CACHE_VERSION` is part of every key so a change in derivation invalidates every record. Transfer: August's caches must be self-invalidating on both a schema change and a missing dependency, not merely stale-tolerant.

- **Derive validation from the single format, do not re-implement it** — `apps/plugin-market-generator/src/sources.ts:10-13` — The list parser validates each line by constructing a throwaway index and calling the real format validator, so the CLI's accept/reject decision *is* the format's decision and the error carries the format's own reason. Transfer: August's config/list parsing should call the same validator the runtime uses instead of maintaining a parallel rule set.

- **An explicit fallback chain with a stated terminal case** — `apps/plugin-market-generator/src/metadata.ts:120-131` — `localized()` uses the English locale, then the manifest fallback; if neither exists the translation is *dropped*, because the format requires English. Transfer: August's localized strings should have one documented chain and one documented terminal case, rather than per-site fallbacks.

- **Derive the advertised engine range from the real dependency ranges, and treat "unsatisfiable" as an error** — `apps/plugin-market-generator/src/packages.ts:83-105` — `workspace:*`/`^`/`~` means "the running version" and imposes nothing, `*` imposes nothing, several ranges are combined by taking one `||` alternative of each and dropping combinations no version satisfies (bounded at 256 alternatives), and a range no version satisfies is an **error** that skips the version with a warning. Transfer: August's provider/plugin compatibility advertising should be computed from the real dependency ranges, and "impossible on every version" must be an explicit refusal rather than a silently-ignored constraint.

- **Atomic writes that never expose a partial file** — `apps/plugin-market-generator/src/files.ts:12-20` — `writeIfChanged` writes to a temp sibling and renames, and skips the write entirely when the bytes already match; a malformed JSON file is treated as absent so an interrupted writer's debris is rebuilt rather than fatal. Transfer: August's snapshot and persistence writers.

- **Measure the shipped artifact, and prove it in code** — `benchmarks/support/built-worker.ts:88-101` — `assertBuiltBenchmarkRuntime` throws if the worker did not run from `benchmarks/.dsh-build`, if a tsx loader is in `process.execArgv`, or if any product package resolved to something other than a built `lib/*.js`; the launcher also strips `NODE_OPTIONS` so no loader can leak in. Transfer: August's perf gate should refuse to report a number measured against source rather than the built bundle.

- **Scale the expectation to the machine, and scale only time** — `benchmarks/support/calibration.ts:4-15` and `benchmarks/support/scaling-report.ts:9-14` — `CI_TIME_SCALE = 2` (a *measured* ratio) and `PERFORMANCE_BUDGET_HEADROOM = 1.25` give the CI budget; memory and dimensionless ratios are never scaled. Transfer: August's budgets must be calibrated to the runner, otherwise they either flake or stop catching regressions.

- **Record every budgeted endpoint before asserting it** — `benchmarks/AGENTS.md:11` — "Pass every budgeted wall-clock endpoint to `recordTimings` … before asserting it, with a `BenchmarkCase` stating what it measures and which user scenario it affects." The report and the assertion therefore cannot disagree. Transfer: August's perf harness should emit the evidence before the pass/fail decision, not after.

- **A benchmark that silently did less work must not report a better time** — `benchmarks/agent-continuation/agent-continuation.worker.ts:113-116` — After the run the worker asserts that the adapter issued exactly the expected number of model requests and that exactly the expected number of tool calls happened, and throws otherwise. Transfer: August's evals should assert the work actually performed, not just that a number came back.

- **Budget the shape of the growth, not only the absolute value** — `benchmarks/user-text/user-text.bench.client.ts:59-61, 145-152` — "Doubling the input doubles a linear scan", so `MAX_DOUBLING_SCALING = 2 × headroom` is enforced on 64 KiB vs 128 KiB adversarial inputs: a backtracking matcher fails the scaling assertion even when it passes the absolute budget. Transfer: August's regex and scanner work should carry a doubling-scaling budget, which is what catches catastrophic backtracking before it bites on real input.

- **Measure allocation without letting the collector lie** — `benchmarks/user-text/user-text.worker.client.ts:270-282, 321-347` — Allocation is young-generation growth only, a `PerformanceObserver` watches GC entries, and the measurement *fails* if any GC ran inside the interval ("enlarge the young generation"); a fixed `--min/max-semi-space-size` keeps the interval smaller than the semi-space from scavenging. Transfer: August's memory regressions (especially in the credential-masking path it already has) could use the same discipline.

- **Assert the system head survives continuation** — `benchmarks/agent-continuation/synthetic-history.bench.ts:15-38` and `benchmarks/agent-continuation/workload.ts:66-105` — The seed reserves an empty system head in the first step so the resumed prompt *replaces* that head without moving historical messages; the bench then asserts the restored session's first derived message is the new prompt and the remaining history is unchanged. Transfer: this is a direct prompt-construction pin — August's "frozen per-session prefix" behaviour should have exactly this kind of test, since a head that moves silently invalidates any provider prefix cache.

- **Repair an interrupted turn at read time, not only at write time** — `benchmarks/session-open/session-open.worker.ts:240-247` — The seed is `[...read.events, ...interruptedTurnClosers(read.events)]`, so a turn that was cut off mid-flight is closed by the *reader* when the session is opened, not only when it is written. Transfer: August's crash recovery for a killed turn should be exercised on the read path, because that is the path a reopened session takes.

- **Synthesize fixtures through the production writer** — `benchmarks/agent-continuation/workload.ts:66-105` and `benchmarks/session-corpus/session-corpus.worker.ts:198-212` — Synthetic history is authored through `Session.create` + `session.append(...)` with `surfaceOp` and `sourceEventSeqs`, and each authored body is replay-validated by `Session.create` before it is written, so a fixture cannot drift from the real format. Transfer: August's fixtures and evals should be produced by the same writers the product uses.

- **Anchor a synthetic corpus on measured real quantiles, and extract only counts** — `benchmarks/session-corpus/corpus-shape.ts:10-25` and `benchmarks/session-corpus/synthetic-corpus.ts:19-37` — 22 quantiles measured over 1,650 real local Sessions (events, logical bytes, turns) drive the generator; only counts and byte totals were extracted, "no content, identity, or path", and the per-quantile projection guarantees every generated quantile is at least the measured one. Transfer: August's load tests should be shaped by a measured distribution, and the measurement must extract no user material.

- **Bound the whole benchmark file, seeding included** — `benchmarks/session-corpus/session-corpus.bench.ts:29, 330-334` — `FILE_LIMIT_MS = 300_000` and a final case that fails when the file, *including seeding*, exceeds five minutes. Transfer: a perf gate that spends 90% of its budget building fixtures is a fixture-cost problem, and this makes that visible.

- **Measure the Host's queue delay as its own endpoint** — `benchmarks/session-corpus/projection-list.bench.ts:21-24` — "Queue delay is time other callbacks wait behind list work on the Host thread, which is CPU work", so it gets `ioShare = 0` and its own 30 ms reference budget. Transfer: August's desktop/Web responsiveness story should have a "how long did *other* work wait" endpoint, not only a per-operation latency.

- **Prove the measurement instrument itself** — `benchmarks/long-session-browser/long-session.bench.ts:281-292, 294-321, 323-342` — Three control cases: a fixed measurement clock still enforces browser deadlines; a page that renders past the unchanged paging ceiling is rejected; an ambiguous or replaced "Load earlier" button fails *before* paging. Transfer: August's browser/e2e harness should carry a control case proving its clock and its selectors cannot be defeated.

- **A reviewer must be a write-capable human, and the policy says so** — `.github/issue-management/rules.mjs:60-68` — The PR policy applies only to non-draft, human-authored PRs with a requested review or a submitted review; Bot/App authors are exempt. Transfer: August's policy enforcement should be scoped by *who is asking*, and the exemption should be explicit and documented rather than incidental.

- **The audit surface is one update-in-place comment** — `.github/issue-management/lifecycle.mjs:41-71` — The bot finds its own comment by marker, patches it when the body changed, posts it when absent and deletes it when there are no errors, so an Issue never accumulates duplicate audit comments. Transfer: August's "recovery"/"self-heal" events should be a single updating surface, not an append-only stream of duplicates — the same reason August's August→August transcript renders a *run* as one line.

- **Isolate the resource, not the suite** — `.agents/skills/dsh-ci-test-reliability/SKILL.md:20-41` — Model four overlapping execution layers, allocate atomically (`listen(0)` then read the assigned address after the server is listening; `mkdtemp`; unique namespaces), and "Do not serialize an entire suite merely because one fixture lacks isolation. … A sequential Vitest block cannot protect a host resource from another file, process, job, or runner." Transfer: August's test isolation should be per-resource-owner.

- **Contain process-global state exactly** — `.agents/skills/dsh-ci-test-reliability/SKILL.md:43-53` — Capture whether the original value was *absent or present*, restore that exact state, register restoration immediately, keep the `try/finally` to the smallest mutation scope, and keep an `afterEach` fallback. Transfer: August's env/clock/global mocking.

- **Classify a flake before fixing it** — `.agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md:16-26` — Eight named classes (host-resource collision, incomplete lifecycle, process-global contamination, load-sensitive synchronization, platform/entry-path mismatch, product concurrency defect, external-provider transience, runner infrastructure), each with the evidence required; "Do not collapse a timeout, signal, exit code, and assertion into a single inferred outcome." Transfer: August's flaky-test triage should force a class before a fix.

- **A leak is anything a reader at HEAD cannot resolve** — `.agents/skills/dsh-trim-cot-leakage/SKILL.md:10-12` — The one test: "could a reader at HEAD, with no access to any session transcript, PR thread, or uncommitted draft, resolve every reference and verify every claim?" A passage with factual clauses is *restated* to stand at HEAD and the transcript around it is deleted; a passage with none is deleted outright. Transfer: this is a directly usable audit for reasoning content that leaks into August's prompts, tool descriptions and comments.

- **Calibrate every probe against a positive and a negative** — `.agents/skills/dsh-trim-cot-leakage/references/recall-batteries.md:9-11` — "A zero-hit pattern proves nothing until it matches a known positive, and a noisy pattern proves nothing until it rejects a near-miss negative"; the code-pattern line stays case-sensitive while natural-language lines carry `-i`. Transfer: August's own lint/regex gates should be required to demonstrate both a catch and a non-catch before they are trusted.

- **Preserve every proposition before editing prose** — `.agents/skills/dsh-prose-standard/SKILL.md:28-38` — Enumerate actor, condition/timing/ordering, modality, negative guarantee/exception, and ownership/side-effect/failure-mode/consequence, then remove only decoration and repetition; "A smaller word count alone is not an improvement." Transfer: August's prompt and comment editing benefits from the same checklist, especially when trimming a model's system prompt.

- **Catching is not recovery** — `.agents/skills/dsh-error-handling/SKILL.md:16-24` — "Catching limits exception propagation, not mutations. Only the affected state's owner can establish safe continuation." and "Logging alone is not recovery." Transfer: August's tool-failure paths must state who can declare the state safe again.

- **Hover is a capability, not a width** — `.agents/skills/dsh-responsive-ui/SKILL.md:41-45` — "Enable mouse-hover effects only on devices that support hovering. Use `@media (hover: hover)`, not viewport width"; a phone tap must not leave hover-only backgrounds behind, and selected/pressed/focus states must be preserved. Transfer: August's desktop/mobile parity work.

- **Reuse before adding, with a named reference surface** — `.agents/skills/dsh-client-ui-ux/SKILL.md:8, 19-23` — Before introducing a literal value, search the target page and its nearest established sibling (the Plugins page is the named reference) and adopt what is already there; every colour must be verified in light and dark. Transfer: August's UI review checklists.

- **Per-section bilingual merge records instead of a whole-file hash** — `.agents/skills/dsh-doc/references/metadata-links-i18n.md:74` — The sidecar records a hash per heading section, excluding fenced code and generated regions, so edits to different sections merge with Git's default text merge; the hashes stay *out* of the frontmatter because two independent edits to one header line would turn mergeable prose into an owner-file conflict. Transfer: August's bilingual docs.

- **A `-----` rule needs blank lines around it** — `.agents/skills/dsh-doc/references/style.md:35` — "A rule directly after a paragraph would parse as a Setext heading." Transfer: August's markdown renderer and any doc linting.

- **Judge memory by future decision value, never by size or age** — `.agents/skills/dsh-archive-agent-notes/SKILL.md:8, 22-27` — Word count and age are discovery aids, never archive criteria; a small UI adjustment is deleted even when implemented, while a note stating a **reintroduction condition** is kept until the condition lands; a rejected note survives only while the losing proposal remains a tempting mistake. Transfer: August's durable-memory retention policy.

- **Protect the seam, not just the code** — `.agents/skills/dsh-find-simplifications/SKILL.md:14` — "The two LLM adapters are intentional. JSONL is the sole first-party Session persistence provider, while the backend-neutral Service Definition supports out-of-tree providers. Do not propose deleting an LLM twin or the persistence seam." Transfer: August's "delete this duplicate adapter" refactors should carry the same explicit protection.

- **Name what you give up** — `.agents/skills/dsh-find-simplifications/references/historical-patterns.md:22-27` — "Name the capability given up and the machinery deleted"; a simplification is a behaviour decision, not a line count. Transfer: August's refactor proposals.

- **Backend and browser measurements are different claims** — `.agents/skills/dsh-speed-up-perf/SKILL.md:14, 29` — "a fast history iterator or Client fold does not prove fast transport, paint, scrolling, or input response"; candidates are ranked by observed latency, CPU/allocations, retained memory, occurrence and confidence, and "a suspicious loop, unused cache, or large file alone is not evidence of a bottleneck". Transfer: August's perf work.

- **Hard-stop rather than silently degrade a release path** — `.agents/skills/dsh-merging-stacked-prs/SKILL.md:12` — "Hard-stop if the official extension or server-side stack feature is unavailable; do not fall back to manually merging and retargeting PRs one at a time." Transfer: August's release tooling.

- **Trust the machine, not the comment** — `.github/workflows/node-addon-system.yml:99-106` — `NALR_REQUIRE_LANDLOCK=1` is set so "a self-skip on the very platform that exists to prove enforcement would be a false green, so an unenforcing kernel fails the leg instead of skipping". Transfer: August's sandbox/confinement proofs.

- **Persistent runners accept only trusted, credential-free rehearsals** — `.github/workflows/release.yml:29-42` — The self-hosted-pool expression requires this repository, a non-Dependabot actor, and either a master push or a same-repo non-fork PR. Transfer: August's self-hosted CI or local agents.

- **Idempotent publication with a marker comment** — `.github/workflows/build-preview-cloudflare.yml:153-170` — The workflow looks for its own marker comment first and exits if one exists; "The marker sits on its own line: markdown renders no link on a line that opens with a raw HTML comment." Transfer: August's bot comments (PR review, update notices).

- **Require master before anything else in a publication** — `.github/workflows/desktop-publish.yml:29-38` — The very first step asserts the ref is `refs/heads/master` and throws otherwise, *before* any dependency installation or credential use. Transfer: August's release scripts.

- **Serialize only what shares registry state** — `.github/workflows/python-release.yml:19-23` — "Public runs stay globally serialized across tags. Dry runs remain isolated by ref so they do not block an intentional publication." Transfer: August's release concurrency.

- **The extension point is not dead code** — `.agents/skills/dsh-find-simplifications/references/historical-patterns.md:9` — "Zero fixed callers is weaker evidence than unreachability"; a deliberate third-party registration path is preserved. Transfer: August's "unused plugin API" cleanups.

---

## Files skipped (with reasons)

None. Every one of the 200 files in this shard was opened and read; all 200 ledger rows carry status `read`. Two files are close to boilerplate and were read in full rather than skipped: `snapshots/web/present/workspace.expected/说明.txt` (15 bytes of expected-output text) and `.agents/skills/.gitignore` (one line).

Two files were *partially* truncated by the tool's own output cap (not by choice) and were re-read in additional passes to cover the missing middle: `.github/workflows/ci.yml` (763 lines), `.github/workflows/ci-master.yml` (531), `.github/workflows/build-exe-for-python-sdk.yml` (512), `.github/workflows/python-release.yml` (248), `.github/workflows/release.yml` (180), `.github/workflows/sandbox.yml` (168), `.github/workflows/windows-package.yml` (167), `.github/workflows/build-preview-cloudflare.yml` (170), `.github/review-ownership/check-approval.mjs` (590), `.github/review-ownership/check-approval.test.mjs` (1146), `.github/issue-management/policy.test.mjs` (1077), `.oxlintrc.json` (358), `AGENTS.md` (185), `apps/plugin-market-generator/src/{generate,fetchers,metadata,packages}.ts`, and the larger `benchmarks/**` sources. The sections that were not re-read line-by-line are the dense fixture/assertion blocks inside the two large test files and the sub-second body of `build-exe-for-python-sdk.yml`'s per-target jobs; their structure, inputs and outputs were understood from the surrounding text and the parts I did read.

---

## Uncertainties

- **The manifest's size for `snapshots/web/present/workspace.expected/说明.txt` is `0`, but the file on disk is 15 bytes** and contains the text `DELIVERED_NOTE`. The path in the manifest is quoted with octal escapes (`"snapshots/web/present/workspace.expected/\350\257\264\346\230\216.txt"`); the file I opened is `说明.txt` in that directory. I recorded the manifest's literal path text in the ledger so the merge matches; the manifest size column appears stale for this one row.
- **`.claude/skills`, `CLAUDE.md`, `.agents/skills/agent-experience/SKILL.md` and `snapshots/.../说明.txt` are symlinks or non-ASCII paths stored as short text.** Git stores the first three as their target path in a text blob, which is why the manifest reports 17, 9 and 70 bytes. I read the blob content (the target path) and, for the Chinese-named file, the real file on disk. I did not resolve whether the Chinese-named file is itself a symlink.
- **`.github/issue-management/README.md` and `.github/preview-sizing/README.md` describe the Issue-policy and preview-runner designs, but the *implementations* they describe live outside this shard** (`packages/api/*`, `scripts/*`). I verified the two README claims I could check inside the shard (the two-tier token selection in `issue-policy.yml`/`pull-request.mjs`, and the idempotent comment in `build-preview-cloudflare.yml`) but could not confirm the end-to-end behaviour of the preview runner-sizing claims.
- **`benchmarks/**` budgets are stated in three different currencies** — a reference-machine expectation scaled by `ciTimeBudget`, a "reviewed hosted limit" pinned as a literal (e.g. `REQUEST_HISTORY_BUDGET_MS = 297`), and a "standard hosted CI expectation" rounded above a recorded median. Which of these is authoritative for a given endpoint is not stated in one place; the per-file comments and the Agent Notes they cite would settle it, and those notes are outside this shard.
- **The `dsh-doc` skill's `kind` mapping and the `verify-*` gate names it references** live in `scripts/` (outside this shard). I confirmed the mapping as *documented* and found the matching `verify-translation-pairing`, `verify-package-readme-*` and `verify-upgrade-guides` invocations in the skill files, but did not read the gates themselves.
- **The `benchmarks/long-session-browser/README.md` "Measurements" paragraph is a single very long line** (the read tool truncated it at 2,000 characters). The truncated tail covers the "stream endpoint overhead budgets" and the diagnostics rules; the rest of the paragraph was readable, and the corresponding rules are implemented in `long-session.bench.ts`, which I did read.
- **I could not confirm what `apps/desktop-host/src/index.ts:97` (`process.argv[4]`) means** — it is the fallback Office payload source (`<runtimeDir>/../runtime/primary-runtime`) when argv[4] is absent. The Electron shell that supplies argv[4] is outside this shard.
- **`apps/desktop-host/tests/office-engine.spec.ts:43` states that Node 24.13's `require.resolve` bypasses module hooks**, so the Electron-specific path is covered by a packaged Office smoke test instead. I did not find that smoke test in this shard and could not confirm where it lives.
