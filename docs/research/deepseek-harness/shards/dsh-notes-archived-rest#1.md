# deepseek-harness / dsh-notes-archived-rest#1

## Shard shape

This shard is the **frozen `process/` half of DeepSeek Harness's archived Agent Note corpus** — 86 decision records, each stored as a three-file triplet (English `*.md`, Chinese `*.zh.md`, and a bilingual-pair sidecar `*.i18n.yaml`), plus the archive's `AGENTS.md` and its 385 KB SHA-256 seal `manifest.json`. It is not application code: every file is prose. The subject matter is the repo's **engineering-process machinery** — mechanical quality gates, generated documentation catalogs, bilingual pairing gates, CI topology and runner sizing, coverage strategy, TypeScript project layout, install/upgrade layout, and the review/evidence workflow — i.e. the decisions an agent-built repository makes about *how agents are allowed to work*, rather than about the agent loop itself. The three file kinds interlock: the English note carries the decision and its "Alternatives considered"; the Chinese note is a full, equal-authority translation that must say the same thing; the sidecar records the git blob SHA-1 of *both* sides as of the last human-confirmed-consistent state, so pair drift is a pure content comparison rather than a git-history lookup. The archive is sealed: `AGENTS.md` declares the triplets "frozen historical snapshots, not current authority", and `manifest.json` holds a SHA-256 for all 2,772 archived artifacts across six kind directories (architecture 555, bug-fix 546, feature 918, process 360, simplification 276, testing 117). I verified both seals independently: the recorded git-blob SHA-1 in a sidecar matches the current file bytes, and the recorded SHA-256 in `manifest.json` matches too (12 files spot-checked across the shard). The shard's practical value to the August harness is therefore a **catalogue of enforcement patterns that are cheap to copy**: the notes repeatedly show a prose rule dying and a mechanical gate taking its place, and they carry the measured numbers behind each choice.

## Per-file notes

### .agents/notes/archived/AGENTS.md
- Purpose: the 9-line contract for the archived tree — "Archived Agent Note triplets under the kind directories are frozen historical snapshots, not current authority."
- Key abstractions: a "sealed artifact" (never edit/reformat/translate/repair/delete/move), the triplet, and a bounded list of what an archival change may do.
- Data flow: `dsh-archive-agent-notes` skill → `pnpm run verify-archived-agent-notes --write` appends new artifact hashes to `manifest.json`.
- Non-obvious design decisions: the archival change may only "relocate a complete English/Chinese/sidecar triplet, insert the identical `Archived: YYYY-MM-DD` line below both `Status: implemented` lines, re-record the sidecar, and repair or delete inbound links" — i.e. the seal is preserved by construction, not by a later audit.
- Edge cases / failure handling: "Do not inspect, verify, or repair links out of archived notes" — archived notes may contain links to things that later moved, and chasing them is explicitly out of scope.
- Surprising: three exact "seal exceptions" are hand-listed in `scripts/archived-agent-notes.ts` for one Figma-link removal, permitting no other content change — an escape hatch with a hard-coded, reviewable boundary.

### .agents/notes/archived/manifest.json
- Purpose: 385 KB, 2,777-line SHA-256 seal registry over every archived artifact; `{"version": 1, "files": { "<kind>/<name>": "sha256:<hex>", … }}`.
- Key abstractions: the `version` field, the flat path→digest map; the digest is a plain SHA-256 of the file bytes (I confirmed this by recomputing it).
- Data flow: written by `pnpm run verify-archived-agent-notes --write`; the normal verifier "rejects changed or missing sealed artifacts, incomplete triplets, unknown kind folders, and invalid archive metadata."
- Non-obvious design decisions: the seal covers the *whole* archive under one map rather than per-kind files, so "is any archived artifact tampered with" is one comparison; the digest is SHA-256 while the per-pair sidecars use git blob SHA-1, because the two answer different questions (tamper-evidence vs. "have these two files drifted apart").
- Edge cases / failure handling: entries are only added, never removed, so a deletion shows up as a missing key rather than a silent shrink.
- Surprising: the map spans 6 kind directories and 2,772 entries — the archive is ~4× the size of the active note tree it was carved from, which is why `AGENTS.md` forbids a *centralized index* of live notes (see `2026-07-19-remove-generated-agent-note-index.md`).

### .agents/notes/archived/process/2026-06-11-doc-sync-enforcement.md
- Purpose: introduces the `doc-sync` gate family — "Two gates, mirroring the existing `scripts/` style (tsx ESM, one job each)".
- Key abstractions: `doc-typecheck` (extract every ` ```ts ` fence into a temp project extending the root tsconfig and compile it with `tsc -b`) and `verify-event-taxonomy` (compare `interface Events` names against the `docs/architecture.md` table).
- Data flow: fences → temp tsconfig project → `tsc -b`; event names → name-set comparison against the hand-written table.
- Non-obvious design decisions: a deliberate sketch opts out with ` ```ts ignore-check `, "and the script reports the opt-out ratio and fails if it exceeds half, so the escape hatch can't quietly become the norm" — the gate polices its own escape hatch.
- Edge cases / failure handling: the temp project reuses the source `paths` map and root project references so doc examples see source while vendored code stays under its own tsconfig; a third gate `verify-md-wrap` was folded in later (2026-06-17) enforcing "one physical line per paragraph".
- Surprising: the taxonomy half was later **superseded** by full generation (see `2026-06-20-generated-cordis-catalog.md`) — the note records a verify-don't-generate gate being retired in favour of generation.

### .agents/notes/archived/process/2026-06-11-quality-gates.md
- Purpose: the repo's founding thesis — "Mechanical quality gates over prose guidelines".
- Key abstractions: max-strict TypeScript, Oxlint + @stylistic + SonarJS, jscpd clone detection, per-file 100% coverage (v8), publint, workspace constraints, NodeNext consumer typecheck.
- Data flow: every mechanically checkable AGENTS.md promise gets "a command that exits non-zero"; CI invokes the exhaustive set, Git hooks reserve latency for cheap local defects.
- Non-obvious design decisions: "Agents follow enforced gates far more reliably than prose conventions, and 'a lot of work' is not a cost argument when agents do the labor" — the budget argument that makes exhaustive gates affordable. The note also self-criticises: 100%-coverage pressure "can produce assertion-free tests — mutation testing is the planned counterweight".
- Edge cases / failure handling: unreachable defensive guards carry `/* v8 ignore */` with a stated reason instead of being deleted; vendored code is excluded from lint/strictness.
- Surprising: it records that the "defaults to 25" style of claim is not the same as a verified invariant — each promise is backed by a command, and the note is explicit that the gates are themselves code to maintain.

### .agents/notes/archived/process/2026-06-11-tsdown-over-dumble.md
- Purpose: replaces the `dumble` bundler with `tsdown` for JS bundling.
- Key abstractions: root `tsdown.config.ts` with `workspace: ['vendor/*', 'packages/*/*']`; per-package overrides for `schemastery` (dual `.mjs`/`.cjs`) and `logger-console` (two single-entry passes so the shared base class is inlined).
- Data flow: `pnpm run build` = `tsc -b && tsdown`; tsc owns declarations, tsdown owns runtime bundles.
- Non-obvious design decisions: chose tsdown over dumble purely on bus factor — dumble had "v0.2.x, ~530 npm downloads/week, effectively one maintainer" while tsdown had "~2.5M downloads/week"; "the switching cost is at its lowest now and only grows once packages publish."
- Edge cases / failure handling: `clean: false` because `lib/` also holds TSC's `lib/types` intermediate tree; `fixedExtension: false` keeps `.js` for `"type": "module"` packages.
- Surprising: two of the three rejected alternatives were "keep dumble — perfect upstream alignment, unacceptable bus factor" and "A direct esbuild script — hand-maintains the per-package spec table tsdown's workspace mode gives us" — i.e. ecosystem health was treated as a first-class dependency risk.

### .agents/notes/archived/process/2026-06-11-vendor-cordis-as-source.md
- Purpose: vendor Cordis as source rather than npm dependencies.
- Key abstractions: `vendor/` holds flattened copies of core, loader, include, group, timer, hmr, logger-console, cosmokit, schemastery, keeping their original npm names; `pnpm-workspace.yaml` sets `linkWorkspacePackages: true`.
- Data flow: `vendor/README.md` is the manifest (upstream repo + commit SHA per package + an exhaustive local-modification log); a pre-commit guard `scripts/check-vendor-manifest.sh` rejects vendored-source changes that don't update the manifest in the same commit.
- Non-obvious design decisions: vendoring was chosen because "the harness depends on framework internals (fiber lifecycle, effect disposal, waterfall dispatch) whose exact behavior matters to the agent loop's correctness guarantees" and core was at `4.0.0-rc.6`; an upstream RC bump could break them with no local fix path.
- Edge cases / failure handling: "Built packages execute the same vendored Cordis generation as source tests; removing workspace linking would silently substitute npm copies behind unchanged package names."
- Surprising: the recorded reason is not licence or control but **RC risk on a correctness-critical dependency** — the framework layer the agent loop depends on is owned, patchable and pinned in-tree.

### .agents/notes/archived/process/2026-06-16-pnpm-over-yarn.md
- Purpose: migrate the package manager from Yarn 4 to pnpm 11.7.0.
- Key abstractions: `pnpm-workspace.yaml` (workspaces + `allowBuilds` allowlist for `esbuild`, `lefthook`, `@google/genai`, `protobufjs`), `packageManager` pin, and `scripts/check-workspace-constraints.ts` replacing `yarn.config.cjs`.
- Data flow: Corepack for contributors, `pnpm/action-setup` in CI; constraints re-expressed as a plain tsx script run as `pnpm run constraints`.
- Non-obvious design decisions: the strict symlinked linker is kept with "**no** `node-linker=hoisted` / `shamefully-hoist` escape hatch: pnpm's non-flat `node_modules` makes phantom dependencies fail loudly, which is a *feature* for a repo whose whole quality story is mechanical gates."
- Edge cases / failure handling: pnpm 10+ does not run dependency lifecycle scripts unless allowlisted, so the allowlist is an explicit supply-chain position; `peerDependencyRules.allowedVersions.typescript: '>=5 <7'` silences benign peer warnings.
- Surprising: the performance table is honestly negative — install speed "is a wash within noise"; the move is justified by "ecosystem alignment, phantom-dependency safety, and cross-checkout disk dedup — not by a raw install-time win." It also documents a shell-free re-entry rule so command paths keep "their literal contents across platforms."

### .agents/notes/archived/process/2026-06-17-ts-build-config.md
- Purpose: "TSC-first build and one compiler ownership" — tsc emits, tsdown only bundles.
- Key abstractions: in-package relative imports use explicit `.ts` specifiers, rewritten to `.js` by `rewriteRelativeImportExtensions`; composite projects keep `.tsbuildinfo` inside their project-local `lib/`.
- Data flow: `tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` → client tsc → client tsdown → `build:web`; `typecheck` runs the Host lib phase first because Client tsc needs Host-generated declarations.
- Non-obvious design decisions: tsdown's `oxc` transform was rejected as the TypeScript transformer because "bundled `.d.ts` conflicts with Cordis' internal relative module augmentation shape" and decorator transform differs from `tsc`; the one-compiler rule is the mechanism that keeps publish output and type validation consistent.
- Edge cases / failure handling: `pnpm run clean` derives live output dirs from the project-reference graph and "refuses it if that resolved parent is outside the repository, so a symlinked project reference cannot redirect cleanup outside the checkout"; it also refuses to remove a manifest-less directory containing unknown files.
- Surprising: `pnpm run verify-node-next-types` typechecks a temporary *external* ESM consumer against the built `types`/`exports` surface, so declaration specifier regressions fail before publish.

### .agents/notes/archived/process/2026-06-18-markdown-cross-link-lint.md
- Purpose: adds `verify-md-links` — a fourth `doc-sync` gate proving relative Markdown link targets exist.
- Key abstractions: mdast-util-from-markdown + GFM AST walk over `link`, `image` and `definition` nodes; scope covers `README.md`, `docs/**/*.md`, `packages/*/README.md`, `AGENTS.md`, `packages/AGENTS.md`, `.agents/skills/**/*.md`.
- Data flow: relative paths only (scheme-qualified, protocol-relative, root-absolute and pure `#section` links are skipped); fragment/query stripped; path resolved against the linking file's directory and asserted to exist.
- Non-obvious design decisions: "Report and never rewrite; exit non-zero on the first broken link found" — verify-don't-generate, mirroring `verify-md-wrap`; the motivating case was a note-tree reorg that renamed ~40 inter-doc links by hand, where "a single fat-fingered path would have shipped with nothing to catch it."
- Edge cases / failure handling: scope is deduped by real path so the `CLAUDE.md` symlinks (which resolve onto the AGENTS.md files) are not double-checked.
- Surprising: the note records that anchor-level checking was deferred here and later had to be added by a separate decision (`2026-08-09-md-fragment-anchor-gate.md`) — the manual rule "grep anchors yourself" demonstrably did not hold.

### .agents/notes/archived/process/2026-06-20-agent-note-classification.md
- Purpose: classify Agent Notes by *kind* using path-encoded subdirectories — "the folder *is* the label."
- Key abstractions: closed set of six classes (`feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`); `{lifecycle}/{class}/yyyy-mm-dd-topic.md`.
- Data flow: `scripts/verify-agent-note-classification.ts` asserts every file under a lifecycle folder sits in a canonical class folder and rejects a centralized `INDEX.md`; `scripts/verify-doc-refs.ts` scans repo-authored `.ts` for root-relative `docs/….md` / `.agents/notes/….md` tokens and asserts each exists.
- Non-obvious design decisions: path-encoding beats a `Classification:` prose line because it "duplicates into the file a fact the path can already carry, and a line can disagree with its folder" — the label and its storage are the same thing, so there is nothing to keep in sync.
- Edge cases / failure handling: `verify-doc-refs` "requires the `.md` extension so extensionless prose is left alone"; a loose `.md` at a lifecycle root or an unknown class folder fails.
- Surprising: the note establishes the split that still governs the archive: **architecture = the shipped source; process = the tooling and workflow around it** — this shard is entirely `process/`.

### .agents/notes/archived/process/2026-06-20-core-data-structures-catalog.md
- Purpose: a `docs/subsystems/` catalog of harness vocabulary plus the `verify-type-equiv` drift gate.
- Key abstractions: the ` ```ts type-equiv ` fence (verbatim source declaration + JSDoc), the ` ```ts public-api ` projection, and `scripts/type-equiv.manifest.json` recording `{doc, symbol, source}` per block.
- Data flow: `verify-type-equiv` extracts each fence via the TypeScript parser and asserts its declaration structure and every JSDoc comment match the declared symbol, ignoring only formatting whitespace.
- Non-obvious design decisions: a compiled `_Check` assignability assertion was rejected because "assignability does not preserve names or JSDoc: a renamed field with the same type or a changed contract comment would pass"; the manifest enforces a **1:1** correspondence so a block can never be silently unchecked and an entry can never rot.
- Edge cases / failure handling: "The gate therefore reports such blocks as orphans" — it must scan the complete Markdown scope, not only manifest-named documents, or an unmanifested block escapes the claimed one-to-one check; a `.zh.md` block reuses the sibling's entry only when the tracked fence sequence matches byte-exactly.
- Surprising: the spine-vs-subsystem scoping test is stated as a *rule* — "the type you write, hold, or receive is core; the machinery that types it, renders it, or persists it is a subsystem-page detail" — and `ToolDefinition` is called out as core "even though the loop never holds one" because authoring-importance overrides the flow rule for that one headline type.

### .agents/notes/archived/process/2026-06-20-generated-cordis-catalog.md
- Purpose: generate the Cordis event + service reference from source instead of verifying a hand-written table.
- Key abstractions: `scripts/gen-cordis-catalog.ts` using the TypeScript compiler API; the `@mode emit|waterfall|parallel|serial` JSDoc tag; the ` ```ts cordis-catalog ` fence.
- Data flow: generator emits `docs/cordis-catalog/events.md` + `services.md`; `verify-cordis-catalog` freshness-checks them inside `doc-sync`.
- Non-obvious design decisions: generation is correct *only for this surface* because "every event/service name is a string literal that round-trips to a static declaration — there are no dynamically-named events and no runtime-only services", and generation "enumerates source rather than checking a hand-written subset", so it structurally closes the undocumented-event gap a name-set verifier cannot.
- Edge cases / failure handling: the generator hard-errors on a missing `@mode` tag and on a tag that contradicts the signature (a trailing `next: () => …` is structurally a waterfall); the cross-link map is fail-closed — every parameter, generic constraint and return type must be mapped, be the signature's own type parameter, be a foundation type, or carry a named exception.
- Surprising: it explicitly reverses the earlier "verify-don't-generate" position *for this surface only*, and keeps the inherited Cordis tier as a curated table because the vendored `Context` "mixes true ctx members with non-service fields".

### .agents/notes/archived/process/2026-07-02-bilingual-docs-and-pairing-gate.md
- Purpose: the bilingual documentation contract — paired sibling files plus a mechanical pairing gate.
- Key abstractions: a pair is three files (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`); neither language is canonical; `scripts/translation-pairing.manifest.json` holds **exclusions only**.
- Data flow: `foo.i18n.yaml` records the full git blob hash of each side as of the last confirmed-consistent state; `verify-translation-pairing` checks pair completeness, both hashes, switchers, and a structural signature.
- Non-obvious design decisions: blob hashes rather than commit hashes because "a same-PR edit has no commit hash yet, so the MDN model cannot express 'consistent as of the state this PR introduces'"; the record must cover **both** sides because equal authority forbids a one-directional canonical model. The exclusions-only manifest means "no requirement can bypass discovery and receive a weaker check."
- Edge cases / failure handling: relative links whose targets belong to the active corpus use the target sibling matching the source locale, with `.md`/`.zh.md` normalised to one semantic target for structural comparison while the exact query/fragment suffix is retained; `*.i18n.yaml` is excluded from Cordis Loader config discovery so translation hashes are not parsed as configuration.
- Surprising: the note argues from industry precedent that the Chinese-ecosystem file layout (ant-design, arco, ShardingSphere's 387 pairs) is conventional *but that none of those repos enforce it* — this design adds the enforcement and adds an agent-run workflow in place of a bot service.

### .agents/notes/archived/process/2026-07-02-tool-schema-catalog.md
- Purpose: generate the tool-schema reference by **booting each tool plugin and reading its registered schemas**.
- Key abstractions: `scripts/gen-tool-catalog.ts` mounts each shipped tool package on a fresh Cordis `Context` with `SystemPrompt` + `ToolRuntime`, calls `ctx.tools.schemas()`, and renders one `## <package>` section per package.
- Data flow: boot → `ctx.tools.schemas()` (exactly the `ToolSchema[]` sent to the model) → deterministic `--write` / `--check` output; `verify-tool-catalog` runs inside `doc-sync`.
- Non-obvious design decisions: "Tool schemas are not statically knowable" — `tool-todo` writes `enum: [...STATUSES]`, descriptions are built by string concatenation, `tool-subagent`'s name is `config.toolName ?? 'subagent'`, and an MCP plugin can register raw JSON Schema via `ctx.tools.register()` without `defineTool` at all. A source-AST doc "would lie".
- Edge cases / failure handling: booting loses the source declaration set to enumerate, so a **completeness guard** `assertManifestComplete` "globs every `tool-*` package under `packages/` and hard-errors if any is absent from the generator's boot manifest" — the structural property generation gives for free is re-created for a boot-based generator.
- Surprising: the framing is the repo's testing discipline applied to a doc generator — "read the shipped artifact, not a re-derivation of it" — and a plain ` ```json ` fence is used precisely so `doc-typecheck` (which only extracts `ts*` fences) needs no new `BlockKind` wiring.

### .agents/notes/archived/process/2026-07-03-documentation-graph-atlas.md
- Purpose: a relationship-graph layer above the existing generated catalogs.
- Key abstractions: three **maintenance modes** — `generated` (all nodes/edges from source), `hybrid generated` (source discovers, a small manifest classifies irreducible policy, a completeness guard fails on unclassified items), `curated` (authored but emitted by the generator).
- Data flow: `scripts/gen-doc-graphs.ts` owns the remaining relationship pages plus `docs/graph-atlas.md`; `verify-doc-graphs` and `verify-mermaid` run in `doc-sync`.
- Non-obvious design decisions: hybrid pages "must fail loud when their manifests are stale" — the capability-seam graph asserts every discovered harness `ctx.<key>` is classified in `SERVICE_ROLES` *and* every classified key still exists; the event matrix labels itself hybrid because subagent lifecycle events use `ctx.events.dispatch`, and those dynamic edges are explicit overrides rather than invisible omissions.
- Edge cases / failure handling: `verify-mermaid` parses every repo-authored ` ```mermaid ` fence with Mermaid's own parser so diagram syntax errors fail locally and in CI.
- Surprising: dense many-to-many data (event producer/consumer) uses Markdown tables instead of diagrams, and PlantUML / hosted diagram services / generated SVGs were "considered and deliberately not adopted until Mermaid becomes the limiting factor."

### .agents/notes/archived/process/2026-07-04-cordis-jsdoc-completeness-gate.md
- Purpose: enforce JSDoc *completeness* on everything the Cordis catalog touches.
- Key abstractions: events need description prose plus a non-empty `@param` for every payload parameter; service classes need class-level prose and each public method needs prose, `@param`s and a non-void `@returns`.
- Data flow: `gen-cordis-catalog.ts` (the same AST walk, the same `@mode` precedent) computes the surface; `verify-cordis-catalog` fails the doc-sync chain.
- Non-obvious design decisions: the gate lives in the generator because "the scope 'cordis service functions and events' has a precise machine definition that only the catalog generator knows" — an ESLint rule cannot see which `interface Events` members and which `ctx.<key>` classes make up the surface.
- Edge cases / failure handling: `this` and the trailing waterfall `next` are exempt (documenting them is allowed, only absence is checked); a stale `@param` naming no real parameter is a violation; a service method must annotate its return type and use simple identifier parameters, or it is unclassifiable.
- Surprising: violations aggregate into one report rather than failing fast — "a remediation pass sees the whole list at once" — and the ~139 gaps found at adoption were filled in the same change so the gate landed green.

### .agents/notes/archived/process/2026-07-04-doc-tiers-and-budgets.md
- Purpose: documentation structure, tiers and **word budgets**.
- Key abstractions: a tier taxonomy with one home per fact; `scripts/doc-budgets.manifest.json` + `scripts/verify-doc-budgets.ts` (whole-file `wc -w` semantics); `scripts/verify-package-readme-summaries.ts` capping each package entry paragraph at 100 words.
- Data flow: every budgeted doc must stay under its ceiling; a budgeted file that is missing fails the gate "so a rename cannot silently orphan its budget."
- Non-obvious design decisions: ceilings are an *enforcement frontier that ratchets* — "A doc at or below its target keeps at least 5% headroom as its ceiling ratchets down; a doc above target keeps a frozen ceiling that prevents growth until it reaches the target." Concrete numbers: root `AGENTS.md` ≤ 1,600 words; `architecture.md` ≤ 1,800; subtree `AGENTS.md` ≤ 600; `packages/README.md` ≤ 600.
- Edge cases / failure handling: raising a ceiling requires explicit PR justification; reference docs, Agent Notes and complete package READMEs stay unbudgeted because exhaustive facts can be long.
- Surprising: "Word count is a crude proxy accepted deliberately: it cannot judge quality, but it forces the relocation decision at exactly the moment content is being added, which is when the author has the context to place it correctly." A blanket ceiling over every doc was rejected because it "punishes exactly the right kind of long doc."

### .agents/notes/archived/process/2026-07-04-persistence-log-catalog.md
- Purpose: generate the on-disk session-log vocabulary (`docs/persistence-catalog.md`).
- Key abstractions: `gen-persistence-catalog.ts` walks every owning and declaration-merged `SessionEventMap` with the TypeScript AST; the ` ```ts persistence-catalog ` fence.
- Data flow: each member renders from its leading JSDoc through the complete payload type, retaining nested property comments; the shared `SessionEventType`, `SurfaceEventType`, `SurfaceOp` and `SessionEvent` envelope declarations are pasted too.
- Non-obvious design decisions: the surface badge is **derived**, not hand-listed — `SurfaceEventType` is parsed from its union declaration and "a union member naming no declared event is a hard error"; everything else renders *log-only*. An `@mode` tag is a hard error here because dispatch modes belong to Cordis bus events, not persisted records.
- Edge cases / failure handling: the walk defends its own assumptions with hard errors — the owning top-level `interface SessionEventMap` must be the single exported declaration in `@deepseek-ai/dsh-session`, no declaration may carry `extends`, every member must be a property signature with an explicit payload type, and a duplicate member across declarations fails.
- Surprising: the note records that the hand-copies it supersedes had **already drifted** ("the session README's merge note had already drifted when the catalog landed") — a name-list checks only the names someone already wrote down.

### .agents/notes/archived/process/2026-07-05-uniform-agent-note-format.md
- Purpose: one gated in-file format for Agent Notes.
- Key abstractions: `README.md § The file format` is the contract — header block (`# Agent Note: <title>` + a dateless, folder-agreeing `Status:`), a per-lifecycle body skeleton, a mandatory `Alternatives considered` section, and free-form bespoke technical sections between the canonical ones.
- Data flow: `pnpm run verify-agent-note-format` (`scripts/verify-agent-note-format.ts`) enforces every mechanical clause inside `doc-sync`.
- Non-obvious design decisions: the whole corpus was normalized in the same change that defined the format — "no transition period, no dual-format tolerance" — and the only grandfather is *content*, not format: pre-format notes whose alternatives are not reconstructible carry the exact `agent-note-format: alternatives-not-recorded` comment, accepted only for files dated before this note.
- Edge cases / failure handling: the `Status:` line is gated against the folder rather than dropped, because "the drift risk that motivated dropping it is neutralized by gating the line against the folder instead."
- Surprising: "the mandatory `Alternatives considered` section is deliberate friction: a decision recorded without what it beat invites the re-litigation Agent Notes exist to prevent" — and thirty-nine debt markers were resolved by the template they were waiting for.

### .agents/notes/archived/process/2026-07-06-export-jsdoc-gate.md
- Purpose: extend JSDoc enforcement from the Cordis surface to **every module-level export** in the workspace.
- Key abstractions: `scripts/verify-export-jsdoc.ts` walks each `packages/<group>/<pkg>/src/` tree; the shared `scripts/jsdoc.ts` holds the parsing/check helpers so "documented" means the same thing on both surfaces.
- Data flow: the gate is wired into `doc-sync` beside `verify-cordis-catalog`; `collectExportJsdocViolations()` returns the list and the CLI exits 1.
- Non-obvious design decisions: everything fails **closed** — `export =` is refused outright and "an exported statement kind the dispatch does not recognize is itself a violation — no export form can pass unchecked by omission." A const annotated with a *named* type defers the signature contract to that type's own declaration; an inline `(x: T) => U` annotation is the exported signature and gets the full contract.
- Edge cases / failure handling: three exemption families — heritage members (overrides inherit base docs), plugin-protocol slots (`name`/`inject`/`reusable`/`Config`/`apply`), and constructors — each mirroring the cordis gate's "documenting an exempt name anyway is allowed; only absence goes unchecked" asymmetry.
- Surprising: at adoption the survey found **203 under-documented exports across 34 packages**; all were filled in the same change so the gate landed green. `eslint-plugin-jsdoc` was rejected because two subtly different definitions of "documented" is the failure mode the one-home rule exists to prevent.

### .agents/notes/archived/process/2026-07-06-generated-config-catalog.md
- Purpose: generate `docs/config-catalog.md` from each plugin's declared config type and JSDoc.
- Key abstractions: the config type is identified as "the second-parameter type" of `apply(ctx, config)` / the service constructor — not a `Config` export found by naming convention; the ` ```ts config-catalog ` fence.
- Data flow: `scripts/gen-config-catalog.ts` emits per-field docs, injection requirements, referenced-type links and a source pointer; `--check` is the freshness gate.
- Non-obvious design decisions: identifying config by the second parameter is what makes the walk *total* — "it works for interfaces named `AcpConfig` or `BasicCompactConfig`, for types declared in a sibling file, and for plugins with no validating schema at all."
- Edge cases / failure handling: every package resolves to exactly one of configurable plugin / config-free plugin / abstract seam class / library, and an unclassifiable entry hard-errors; schema keys are checked against the declared type one-way (declared types may carry runtime-only fields).
- Surprising: the note accepts deliberate duplication — the package README `## Config` sections stay — because "a disagreement between the two indicts the README, and the fix is a README edit — the catalog cannot drift."

### .agents/notes/archived/process/2026-07-06-parallel-github-ci-gates.md
- Purpose: the (now superseded) shard-heavy GitHub CI topology.
- Key abstractions: `scripts/run-gates.ts` as the bounded scheduler; `scripts/static-shards.ts` partitioning static gates into foundation / documentation-type / API-contract / catalog / prose / documentation-projection / documentation-build ownership; `scripts/coverage-shards.ts`; `scripts/snapshot-shards.ts`.
- Data flow: explicit shard names in workflow YAML, each lane producing its own build before its consumers.
- Non-obvious design decisions: the artifact boundary is load-bearing — `publint`, `verify-node-next-types`, compiled invariant loading and built-bin smoke "need emitted `lib/` output. Sharding cannot race those consumers ahead of build"; coverage lanes deliberately run *without* a preceding build because the complete coverage suite passes from a tree with every generated `lib/` removed.
- Edge cases / failure handling: each shard includes "a repository complement starting from `.` so new top-level targets could not disappear between shards"; directory filters retain a trailing separator because Vitest positional filters match substrings.
- Surprising: it is explicit that one-minute / three-minute targets are "observed performance targets, not cancellation deadlines" — variance should leave complete timing evidence, not cancel a correct gate. The note is preserved only as the record of *why* the earlier topology existed; it is superseded by the larger-runner decision.

### .agents/notes/archived/process/2026-07-06-parallel-pre-push-gates.md
- Purpose: the bounded gate scheduler that CI, `doc-sync` and `check:all` share.
- Key abstractions: `scripts/run-gates.ts` expands named modes into leaf gates; a `needs` edge (predecessor must pass) vs an `after` edge (waits for any terminal outcome); `allowFailure`; `streamOutput`.
- Data flow: `DSH_GATE_CONCURRENCY` sets the worker bound; `scripts/publint-all.ts` runs publint with a pool sized from `availableParallelism()`, buffering per package and printing in deterministic order.
- Non-obvious design decisions: the scheduler "rejects empty or ambiguous dependency graphs before starting a child"; streaming is an explicit per-gate property rather than a global default, because "Inherit stdio for every gate — exposes progress immediately but interleaves ordinary independent gates and discards the scheduler's attributable output record."
- Edge cases / failure handling: `run-gates.spec.ts` exercises signal termination through a real child process and proves streamed output is immediate and unbuffered; `publint-all.spec.ts` "rejects a missing public export before downstream artifact consumers run."
- Surprising: the note records the cost of the custom scheduler honestly — a mode inventory to maintain — in exchange for wall clock equal to "the slowest dependency chain instead of the sum of independent gates."

### .agents/notes/archived/process/2026-07-10-readme-known-limitations-gate.md
- Purpose: a gated `## Known Limitations and Deferred Work` section in every package README.
- Key abstractions: the package set is derived from `packages/<group>/<pkg>/package.json` manifests; `NO_LIMITATIONS` is the explicit allowlist of packages with nothing to declare.
- Data flow: `scripts/verify-package-readme-limitations.ts` rejects missing READMEs and requires exactly one canonical h2 with at least one top-level bullet.
- Non-obvious design decisions: near-miss headings ("Limitations", "Deferred", "What is NOT here", "Non-goals") fail, so a repository-wide search is uniform; an absent section must be justified in the allowlist "so a rename cannot silently orphan" it.
- Edge cases / failure handling: the gate checks presence, shape and the allowlist; review owns coverage and accuracy — "the absence of an audited-absence signal is a documentation bug, not a gate failure."
- Surprising: requiring an empty section or "None." was rejected because "boilerplate can remain after a package gains a limitation; an allowlist makes absence explicit and reviewable."

### .agents/notes/archived/process/2026-07-12-package-model-experience-contract.md
- Purpose: a per-package contract describing what reaches the model, its token effect, and its **KV-cache** effect.
- Key abstractions: one H3 per context surface; each surface carries three ordered H4 fields — `What the model sees`, `Token effect`, `KV Cache effect` — each starting with one prose paragraph.
- Data flow: `verify-package-readme-model-experience` discovers package manifests and validates the three classifications, canonical final-section order, exact field heading depth/order, non-empty paragraphs, H5 ownership of verbatim blocks, concrete literal evidence and anchored tool-catalog links.
- Non-obvious design decisions: the cache field "distinguishes append-only growth, a stable repeated prefix, replacement of earlier tokens, and an independent model request" and "'Does not invalidate' means the package preserves an already-reusable prefix, not that a provider promises a cache hit or retention period." Stable package-owned text is quoted exactly; data-dependent and provider-owned text is summarized.
- Edge cases / failure handling: a package with no model-context effect uses an audited short form (one sentence beginning `None, as ` or `Indirectly, through ` plus a `KV Cache effect` paragraph), and omission is reserved for model-agnostic generic packages named with a reason in the verifier.
- Surprising: numeric token counts were rejected because exact counts depend on tokenizer, adapter serialization, configuration and runtime data — "the stable contract is the growth shape"; and a central context-cost catalog generated from source was rejected because an AST "cannot infer semantic conditions such as history retention, output truncation, parent-versus-child visibility, or an auxiliary model boundary."

### .agents/notes/archived/process/2026-07-13-documentation-site-projection.md
- Purpose: project canonical repository Markdown into a VitePress site without creating a second documentation source.
- Key abstractions: `website/docs.ts` is an explicit publication manifest (source file → public route, sidebar, section, order); `scripts/project-doc-site.ts` projects it into the ignored `website/.generated/`.
- Data flow: the projector parses Markdown links *without reserializing*; a link to another published source becomes a site-relative route, a link to an unpublished repository file becomes a GitHub source link.
- Non-obvious design decisions: the generated tree follows public routes so VitePress navigation, locale detection and local search share one route vocabulary; each page gets an `editSource` frontmatter field so the edit-link callback reads only page data and public URLs stay independent of the source layout.
- Edge cases / failure handling: missing relative targets fail projection; `website/AGENTS.md` is the only maintained Markdown file in the website subtree and a test enumerates tracked files to reject any other, so site-specific copies cannot bypass the manifest.
- Surprising: the Shiki renderer keeps a build-local cache keyed by exact content + info string + delimiter + token attributes, because about half the bilingual projection's fences repeat; Mermaid fences bypass it since the plugin output includes a token-position id.

### .agents/notes/archived/process/2026-07-14-typescript-program-backed-semantic-gates.md
- Purpose: derive gate facts from `ts.Program` + `TypeChecker` instead of naming conventions and handwritten tables.
- Key abstractions: `scripts/ts-project.ts` parses the root tsconfig, recursively expands every project reference and combines the referenced source roots into one no-emit semantic program.
- Data flow: `gen-doc-graphs.ts` classifies calls by assignability to the repository's actual `Context`, `AgentEventDispatch` and Cordis `EventsService` types; `gen-scoped-events.ts` resolves the unique payload path for each scoped event.
- Non-obvious design decisions: the program is built by *explicit expansion* of references because a normal program "can redirect referenced projects to built declarations; explicit expansion keeps the package `src` files available for AST traversal and symbol identity." Semantic queries run only where a branch can consume them, and the demand-driven index's locality proof "affects cost, never results" — an unproven premise falls back to the unchanged original semantics.
- Edge cases / failure handling: every declared harness event must have a discovered producer (missing → dead vocabulary or unsupported dispatch shape); scoped events with zero or multiple payload matches fail, and `@dshScopeScan unsupported` is a reserved annotation that "records an unsupported scan; it does not encode an event name, parameter index, property path, or replacement type."
- Surprising: the generated resolver map lives in the package that owns scoped dispatch and "imports no event-owner package" — semantic completeness stays in the gate, so neither `dsh-scope` nor `dsh-invariants` acquires a dependency on every event owner.

### .agents/notes/archived/process/2026-07-17-run-ci-examples-from-built-lib.md
- Purpose: run CI examples from the built `lib/`, not from source.
- Key abstractions: two execution modes — `src` (tsx + tsconfig paths, the local default) and `lib` (plain Node, built bins, no tsx, no path mapping), selected by `DSH_EXAMPLE_MODE`.
- Data flow: `examples/` is one pnpm workspace member providing the shared `examples/node_modules` resolution root; every checked-in test Cordis config lives under `examples/<agent>/` and every package named by a config is declared in both `examples/package.json` and the root tsconfig references.
- Non-obvious design decisions: "These runs therefore do not test the same code or resolution behavior as an installed consumer. A package can pass CI while its built export graph is incomplete or resolves differently" — CI must build first and select `lib`.
- Edge cases / failure handling: TypeScript fixtures that only implement an ACP/MCP peer and do not load Cordis run directly with Node; an explicit source-path regression may stay in `src` mode.
- Surprising: the note accepts "CI must build before these tests, and manual `lib` runs can observe stale local artifacts" — and flags the cost that Cordis config dependencies are invisible to normal TypeScript import analysis, so two manifests must stay synchronized.

### .agents/notes/archived/process/2026-07-19-remove-generated-agent-note-index.md
- Purpose: delete the committed generated Agent Note index.
- Key abstractions: the lifecycle/class filesystem tree *is* the inventory; `scripts/agent-note-tree.ts` owns the closed sets and the structural walker.
- Data flow: `verify-agent-note-classification` validates the tree and rejects the legacy homes and a root `INDEX.md`; it no longer renders or freshness-checks a centralized list.
- Non-obvious design decisions: a committed index "duplicates facts already encoded by each file's lifecycle/class path, filename date, and H1", and every unrelated branch that adds a note rewrites the same artifact — "a predictable merge hotspot."
- Edge cases / failure handling: not applicable; the decision is a deletion.
- Surprising: the note frames the merge hotspot as the primary cost, not maintenance burden: generation "makes conflict resolution mechanical but does not prevent unrelated branches from modifying the same artifact."

### .agents/notes/archived/process/2026-07-19-require-agent-notes-for-non-trivial-changes.md
- Purpose: require an Agent Note for every non-trivial change, in the same PR.
- Key abstractions: "non-trivial" is defined by *category* — behaviour, architecture, cross-file/cross-package contracts, process/tooling, testing strategy, on-disk/wire/config formats — not by judgement.
- Data flow: updating the note that already owns a decision satisfies the rule; a new note is needed only when none owns it; purely mechanical edits are exempt.
- Non-obvious design decisions: a fully superseded note may be consolidated into the current owner "only after that owner preserves every unique rationale, alternative, consequence, verification contract, and named coverage gap" — and the same change repairs inbound links and removes the Chinese counterpart and consistency record.
- Edge cases / failure handling: a removal note becomes the current owner only once the feature is absent from production code, configuration, schemas, durable/wire formats, migration and compatibility behaviour, no current documentation presents it, and no test exercises it as supported behaviour; removal rationale and absence-verifying tests may remain.
- Surprising: "No automated gate attempts to classify a diff as trivial or non-trivial, so this policy adds no gate stage or runtime" — and "Rewrite the old note into the replacement decision" was rejected because it "erases the decision boundary and its rejected alternatives."

### .agents/notes/archived/process/2026-07-19-web-styling-system.md
- Purpose: the web styling framework — token system and engineering constraints for an agent-written GUI.
- Key abstractions: CSS Modules + clsx, no component library, no tailwind; tokens-only colors; a two-layer `--bg-*`/`--text-*` table (later replaced by `--dsw-*` static+alias sheets).
- Data flow: the spec is a 12-item review checklist where "each item is a decidable 'see X, reject' — not a style suggestion — and writing styles and reviewing styles share the same table."
- Non-obvious design decisions: dark mode exists **only** in the token table — "component CSS has zero theme selectors"; where a non-token value must vary by theme, the "CSS variable bridge" applies (the component defines a local variable, the theme block only overrides the variable). Font sizes and spacing are deliberately **not** tokenized: sizes are px and "always paired with a line height (16/24, 14/22, 12/18)"; spacing uses multiples of 4.
- Edge cases / failure handling: `composes` is banned; `:global` only pierces third-party names; `::-webkit-scrollbar` inside components is banned (one shared `.scrollable` utility); PostCSS plugins are currently zero and adopting any "requires recording it in web-styling.md first."
- Surprising: the note separates a *framework* RFC (rarely changes) from a *living spec* (authoritative token values, the 12 coding rules, the deviation record) — the same contract/skill split used for the i18n policy — and its review checklist is designed so the author self-checks against the identical table the reviewer uses.

### .agents/notes/archived/process/2026-07-20-generated-cordis-core-api.md
- Purpose: generate the Cordis core API reference (Context, Events, Fiber, Registry, Service) from `vendor/cordis/src`.
- Key abstractions: `scripts/cordis-core-api.ts` reads public declarations and original JSDoc with the TypeScript compiler API; an explicit page manifest drives five files under `docs/cordis-catalog/core/`.
- Data flow: `gen-cordis-catalog.ts` writes the five pages together with the Harness event/service catalogs; `verify-cordis-catalog` rejects stale output.
- Non-obvious design decisions: the Harness catalogs deliberately summarize inherited Cordis members, so they "do not replace a method-level Cordis reference" — a second hand-written copy under the website "would drift from the vendored source and make the renderer an additional documentation owner."
- Edge cases / failure handling: the generator validates that documented classes and methods retain descriptive JSDoc including parameter and non-void return contracts; declaration-only `ts cordis-catalog` fences keep the original JSDoc.
- Surprising: "Generated prose is English-only, and source JSDoc quality directly limits reference quality; Chinese output requires generator-level translation rather than hand-editing the generated files" — a deliberate acceptance of a translation debt in exchange for never hand-editing generated output.

### .agents/notes/archived/process/2026-07-20-gui-testing-system.md
- Purpose: the three-tier GUI testing structure.
- Key abstractions: tier 1 *protocol isomorphism* (generated Typert descriptors + `ApiGateway` + the Connection RPC carrier), tier 2 *object-layer orchestration* (`Session`/`SessionManager`/`ConnectionController` state machines), tier 3 *assembled presentation* (built artifacts × real client loader, jsdom semantic snapshots + Playwright).
- Data flow: a five-row lane map (baseline `test:gui` → semantic snapshot `test:snapshot` → browser e2e `test:web` → browser expected-output gate `test:web:built` → coverage gate) with an explicit "when to run" for each.
- Non-obvious design decisions: "each tier tests its own layer, upper tiers never re-test lower ones"; tier 2's technique is the "event sequence in → snapshot out" golden path with programmable fakes, deferreds and fake timers; tier 3's snapshots "own stable visible state such as sidebar labels, breadcrumbs, and `document.title`, not CSS pixels."
- Edge cases / failure handling: "All-green on RemoteMock is not done, the real wire must pass too" — a decoded in-process carrier deliberately omits the HTTP/WebSocket chain, so changes touching connection/bridge/handler/streaming must run the browser lane.
- Surprising: the anti-regression rule is that **every bug fix pins an assertion** in its owning spec, and the note records a specific precedent (the res-close misjudgment pinned in the webserver bridge suite — "pure Node, reproduces in seconds, no longer needs the 12s browser sentinel as the only defense").

### .agents/notes/archived/process/2026-07-21-doc-sync-through-gate-scheduler.md
- Purpose: move `doc-sync` off a 24-step `&&` chain onto the shared bounded scheduler.
- Key abstractions: `tsx scripts/run-gates.ts doc-sync`; `docSyncLeafGates()` in `run-gates.ts` is "the single source of truth for the member set."
- Data flow: one pnpm wrapper start plus the slowest dependency chain of member gates, instead of 24 wrapper starts plus the sum of all members.
- Non-obvious design decisions: the reason is measured, not stylistic — "the 24 script bodies together finish in about 34 seconds while the chained form takes around 3 minutes"; local mode caps concurrency at four workers because several doc gates each build a full `ts.Program`.
- Edge cases / failure handling: the chain had silently drifted from the scheduler — "`verify-cordis-api` joined the chain when the runtime API catalog landed but was never added to `docSyncLeafGates`, so CI never enforced that catalog's freshness" — a concrete instance of the two-lists problem.
- Surprising: the output shape changes (interleaved scheduler output), so "anything parsing that output must key on the `run-gates:` summary lines."

### .agents/notes/archived/process/2026-07-22-cordis-tutorial-docs.md
- Purpose: a seven-chapter hands-on Cordis tutorial under `docs/cordis-tutorial/`.
- Key abstractions: chapter sequence (first plugin → lifecycle/effects → services → events → config → composition/HMR → harness tool); `mirroredPages()` publishes the English source to both website locales.
- Data flow: "Every transcript is real" — chapter files run in a gitignored scratch directory via `node --import tsx ../../vendor/cordis/bin.js` and the shown output is what those commands print; the harness-tool chapter runs keylessly.
- Non-obvious design decisions: dsh-flavored rather than pure Cordis ("later chapters use real harness services and events (`ctx.tools`, `tools/result`) so the tutorial lands the reader inside this repo's actual composition model"); English-only for now, published to both locales so a Chinese pair can ratchet in later without route changes.
- Edge cases / failure handling: code fences compile under `doc-typecheck` except two that import scratch-relative files or intentionally throw, which carry `ignore-check`; the note concedes the transcripts "are not snapshot-gated — if loader or HMR behavior changes, the transcripts drift until a human replays the chapters."
- Surprising: it explains the loader's logged unresolved-entry failure because that boot-time log "may not reach a console exporter" — a doc explaining a missing log is itself a form of documentation fix.

### .agents/notes/archived/process/2026-07-22-evidence-based-larger-hosted-runners.md
- Purpose: replace the shard topology with three 16-core Linux jobs plus one native Windows job, chosen from measured evidence.
- Key abstractions: repo-restricted enterprise x64 larger-runner pools; `suite=larger-runner-benchmark` (isolated critical lanes) and `suite=consolidated-runner-benchmark` (whole aggregates); a self-hosted 64-core `vm-backup` standby pool as a hot-standby drill.
- Data flow: Linux primary work = three independent jobs (coverage alone with `DSH_COVERAGE_PARTITIONS`; the static scheduler owning source/doc gates; one job owning the single Linux build and then its consumers), with all three entering runner allocation independently.
- Non-obvious design decisions: measured all-size tables are quoted in full (4→96 cores: 243 s → 65 s) and the 96-core trace is dissected to show "typecheck occupied 25.71 seconds, then a scheduler dependency delayed the 2.13-second build and 11.29-second snapshot replay until it finished" — "More cores therefore become useful only after the repository scheduler can feed them."
- Edge cases / failure handling: 32 forks crashed Node 24's CJS lexer twice, so Vitest uses threads for the broad inventory and reserves forks for process-global/timing-sensitive suites; "deterministic coverage, not advertised cores, is the upper bound on worker selection."
- Surprising: "a future larger-runner rollout therefore needs complete-job measurements rather than gate-only timing" — one run spent 69 s in a 69-second job of which only 39 s was repository gates, and the Windows pnpm cache spent 27 s extracting a 154 MB archive. Also: missing runner labels leave required jobs queued, so "runner assignment is therefore an operational dependency that repository CI cannot repair."

### .agents/notes/archived/process/2026-07-22-fast-local-git-hooks.md
- Purpose: shrink the local Git hooks to cheap, high-confidence defects.
- Key abstractions: `lefthook.yml` — pre-commit runs a *project-free* Oxlint profile, safe fixes with a bounded retry, re-stages, `git diff --cached --check`, and the vendor manifest guard; pre-push runs `pnpm run typecheck`.
- Data flow: agents inspect the outgoing diff and run the narrowest relevant checks once; CI owns the exhaustive matrix.
- Non-obvious design decisions: "An agent already runs the tests and checks that exercise its change, while commit, push, and CI can each repeat increasingly broad subsets of the same work" — a full pre-push suite "amplifies unrelated local flakes, and gives no new signal when CI immediately runs the exhaustive matrix again."
- Edge cases / failure handling: pre-commit does not run type analysis, tests, snapshots, docs, builds or hygiene; pre-push adds only the Host contract build the typecheck needs.
- Surprising: the note explicitly assigns review responsibility for the *evidence selection* ("Agents must select relevant behavioral evidence, reviewers must evaluate whether that selection matches the diff") and states that local publication no longer proves the exhaustive repository matrix.

### .agents/notes/archived/process/2026-07-22-installer-in-repo-skip-clone.md
- Purpose: the installer detects that it is running from inside a real checkout and skips the clone.
- Key abstractions: detection keys on `$0` — under `curl … | sh` the script arrives on stdin so `$0` is the shell name; a checked-out copy makes `$0` the script file, and the parent must be a `scripts/` directory inside a tree carrying both `bin/dsh` and `scripts/install.sh`.
- Data flow: in-repo mode sets `IN_REPO=1` and repoints `DSH_SOURCE`; step 2 then prints "using existing checkout" and does nothing else — "no `git fetch`, no `git checkout -B`, so the user's working tree and branch are never mutated."
- Non-obvious design decisions: `git rev-parse --show-toplevel` was rejected because `curl … | sh` frequently runs from inside an unrelated git repo (the user's cwd) and would false-positive; anchoring on `$0`'s own location ties the decision to where the script physically lives.
- Edge cases / failure handling: an explicit `DSH_SOURCE` wins over detection (captured before defaulting) and re-opens the clone path.
- Surprising: the note enumerates the four paths that must be verified (in-repo skip, curl-style clone, explicit `DSH_SOURCE` elsewhere, explicit `DSH_SOURCE` equal to repo root) — the test matrix is the deliverable.

### .agents/notes/archived/process/2026-07-22-product-first-root-readme.md
- Purpose: keep the root README a compact product-and-contributor entry point.
- Key abstractions: identity + plugin architecture, documentation-site link, developer-preview and safety status, npm and source launch paths, then community/contribution/development/agent-instructions/license/notices links.
- Data flow: both launch paths start the Web UI through the `dsh` profile entry point; the source path builds the checkout before `pnpm dsh web`.
- Non-obvious design decisions: "Rewriting sections whose facts remain correct increases the review surface and discards language that already works" — factual refreshes are distinguished from editorial rewrites.
- Edge cases / failure handling: the English and Chinese README sides keep the same technical structure while their community links serve their language audiences.
- Surprising: presenting the repository "as an SDK and package catalog" was rejected because "it makes a new reader reconstruct the product from package names"; the package map and generated capability graph remain the authoritative inventories.

### .agents/notes/archived/process/2026-07-22-tsconfig-solution-root-two-aggregates.md
- Purpose: replace three tsconfig books of record with one solution root over two aggregate programs.
- Key abstractions: `tsconfig.json` (solution, `files: []`, two references), `tsconfig.base.json` (shared compilerOptions + `paths` facade), `tsconfig.base.client.json`, `tsconfig.host.json`, `tsconfig.client.json`.
- Data flow: `tsc -b tsconfig.json --pretty false` in the pre-push hook covers both sides; `tsconfig.build.json` and `tsconfig.vitest.json` are deleted and every vitest config points `vite-tsconfig-paths` at `tsconfig.base.json`.
- Non-obvious design decisions: the load-bearing principle is "**cordis `Context` declaration-merge collisions exist only inside a `ts.Program`, never in module resolution.** A solution file forms no program, so referencing both aggregates from one root cannot collide the merges." Two derived disciplines follow: `tsconfig.base.json` never gains `include`/`files`, and every repo-wide `ts.Program` consumer seeds an aggregate explicitly, never the root solution.
- Edge cases / failure handling: the note lists the four asymmetries the triple bookkeeping produced — drifted typecheck/build reference lists (`packages/goal/command-goal` in one and not the other), a pre-push hook that only covered the host side, client test files on no discoverable config chain, and three vitest configs pointing at three resolution sources.
- Surprising: pointing vitest at the root solution was rejected because a solution has neither `paths` nor `include`, so resolution would depend on how far the plugin walks references and "the client aggregate's include (tests only, no src) would leave transitive src→src imports unmapped, falling through to `exports` and loading a second copy of module singletons."

### .agents/notes/archived/process/2026-07-23-browser-demo-gif-recording.md
- Purpose: a skill for local browser-demo GIF artifacts.
- Key abstractions: the `record-browser-gif` skill; a bundled `encode_gif.py` helper (lexical frame order, explicit hold durations, ffmpeg palette pipeline, ffprobe validation of dimensions/frame count/duration/byte limit).
- Data flow: frames live under the gitignored `.playwright-mcp/` directory — "the browser tool writes only under its allowed roots" — and never dirty the worktree; recording stops after returning the verified absolute GIF path.
- Non-obvious design decisions: the skill "establishes whether the requested flow is real, fixture-backed, or otherwise simulated" *before* capturing, and captures "a small storyboard only after semantically observable UI states" rather than a continuous recording.
- Edge cases / failure handling: publication (attaching to a pull request) is deliberately outside the recording skill's boundary — upload and remote mutation need separate auth, confirmation and recovery rules.
- Surprising: "Use a fixture whenever it is easier to stage" is explicitly rejected as a silent provenance change — "they do not substantiate a real-server or real-API claim. The skill preserves the requested provenance and reports a missing prerequisite instead of silently changing it."

### .agents/notes/archived/process/2026-07-23-personal-staging-maintenance-skills.md
- Purpose: repository-distributed skills for personal customization, upgrade and upstream publication.
- Key abstractions: `dsh-customize`, `dsh-upgrade`, `dsh-upstream-customization`, shipped from the root `skills/` directory and supplied to the local skill provider at startup, "below project and user roots in discovery priority."
- Data flow: each upgrade attempt uses one UTC basic timestamp for a sibling `dsh-staging-<timestamp>` clone, a `dsh-upgrade/prepare-<timestamp>` branch, a `dsh-staging/<timestamp>` branch, private upstream and recovery refs, and a launcher backup; the launcher is then moved **once**, atomically, from the unchanged old staging checkout to the new one.
- Non-obvious design decisions: the process source is derived "from the process command and runtime environment rather than the shell working directory"; the repository and checkout behind the launcher are treated as immutable "except for holding its existing merge lock"; failure before cutover leaves everything unchanged, failure after cutover restores and verifies the launcher backup.
- Edge cases / failure handling: the old staging checkout, its branch, the recovery ref and the launcher backup all remain until a restarted process proves DSH runs from the new branch *and* the user explicitly approves rollback cleanup; sibling names never derive from the current directory name and collisions fail rather than acquiring ad-hoc suffixes.
- Surprising: `dsh-upstream-customization` owns upstream publication independently, and only the user's selection of a named candidate loads the publication workflow — "each feature still requires explicit approval before a push or draft PR."

### .agents/notes/archived/process/2026-07-23-portable-required-pull-request-ci.md
- Purpose: a portable recovery boundary for required pull-request CI.
- Key abstractions: the required primary jobs plus the `all checks passed` aggregate run on repo-restricted enterprise pools; the aggregate performs no checkout or repository gate.
- Data flow: the aggregate shares the enterprise pool "so the required verdict does not introduce a separate standard-hosted billing dependency after its substantive jobs have already succeeded"; the required Windows job runs under Wine on standard `ubuntu-latest` while a native `windows-2025` job starts automatically but does not participate in the aggregate.
- Non-obvious design decisions: sharing the pool for a gate-less aggregate is deliberate — a separate standard-hosted aggregate would add a second billing dependency after the real work succeeded.
- Edge cases / failure handling: "There is no automatic fallback when a remaining enterprise Linux label cannot allocate: the standard jobs continue to report their own contracts, but they cannot manufacture the missing required result" — the note rejects skipping or demoting checks "while capacity is unavailable" because that "would make the status green by dropping evidence."
- Surprising: the note separates queue delay from execution interval explicitly ("queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval") and warns that "changing a pool definition's status alone is insufficient evidence that it can receive work."

### .agents/notes/archived/process/2026-07-23-translation-prompt-v4-contract.md
- Purpose: the calibrated translation-prompt contract (v4 protocol, v7 calibration).
- Key abstractions: `docs/i18n/translation-prompt.md` is the committed pipeline asset; the renderer injects only source language, target language and the current terminology table; the request assembler retains the source basename *outside* the model-visible prompt.
- Data flow: the response has three ordered top-level sections — `translation`, `review`, `final`; the consumer derives the target basename from the retained source context, preserves optional leading YAML frontmatter, and mechanically inserts or corrects the language switcher after the first H1 in `final`.
- Non-obvious design decisions: the response carries a draft, its self-review and the corrected document separately; the instruction priority is explicit — source meaning and protected structure, then the terminology table, then whole-document gold-pair voice, then general guidance. Style guidance "cannot invent an actor or vary a terminology-table form, defined concept, or contract verb merely for variety."
- Edge cases / failure handling: the parser requires each section exactly once, rejects content outside the envelope, and tolerates one outer `xml` fence; section delimiter lines are reserved by the wire format, and a delimiter line in a Markdown body is escaped by one leading backslash, which the parser removes exactly one of — "count-preserving escape round-trips both a literal delimiter and an already escaped delimiter without changing inline tag mentions."
- Surprising: unresolved terminology "stays unchanged in the translation and is reported only as pending review" — the pipeline never guesses a term; and a strict draft-to-final change ledger was rejected as "output burden without proving that the review catches local semantic drift."

### .agents/notes/archived/process/2026-07-26-briefed-minimal-translation-updates.md
- Purpose: make minimal counterpart updates cheap by working from a generated briefing instead of the guidance corpus.
- Key abstractions: `pnpm run gen-translation-brief [--apply] [pair...]`; a deterministic scope ladder — code-fence-only changes computed outright, then changed Markdown units, then depth-matched heading sections, then whole document; terminology rows matched against changed spans only.
- Data flow: the briefing is the translator's whole working set; the full sources of truth remain the escalation path; `--write` stores each side's exact bytes with `git hash-object -w --stdin` and pins the blob under a content-addressed local `refs/dsh/translation-pairing/snapshots/` ref so an uncommitted last-confirmed snapshot survives GC.
- Non-obvious design decisions: the briefing tracks each term's document-wide **first occurrence** per Chinese target, because the 首次出现 annotation must move with it — "when an edit moves it, the vacated and receiving spans join the briefing with an explanatory note."
- Edge cases / failure handling: `--write` now requires naming the confirmed pairs; bare `--write` refuses, and re-recording everything is an explicit `--write --all` — "the old bare form silently blessed every drifted pair in the tree."
- Surprising: a controlled replay of ten real historical pair updates found the briefed path matched the status quo on quality at roughly **a third of the tokens and wall clock**, and that whole-document re-translation was **confirmed harmful, not merely wasteful** (judged preservation 4.4/10 vs 9.8) because it discards reviewed phrasing; a small model performed at parity on the briefing, so "the update path no longer assumes a frontier translator."

### .agents/notes/archived/process/2026-07-26-gui-pr-gif-evidence-and-assets-branch.md
- Purpose: mandatory GUI evidence in pull requests, published to an orphan assets branch.
- Key abstractions: a dedicated orphan branch (no parent commit, media only) — "one assets branch serves a whole pull request series"; assets branches are append-only and can never be deleted or rewritten.
- Data flow: publication works in a shallow single-branch scratch clone, commits as `assets: <what it shows> gif (#<pr>)`, and the PR body embeds the blob URL with the required `?raw=true` suffix.
- Non-obvious design decisions: committing the GIF to the PR branch is never acceptable — "binary media in history bloats every future clone permanently"; the provenance must be real (real server booted from that PR's own branch tree, a real API key, real model rounds), and fixture provenance only when the user explicitly asked for it.
- Edge cases / failure handling: the skill folds in the operational lessons recording earned — frames under `.playwright-mcp/` created before capture, a fresh scratch workspace and session per scenario, servers stopped by PID rather than a process-name pattern, transient states captured by driving a slow foreground operation and polling a concrete DOM marker **inside one browser-script call**, and completion predicates matching an exact-text element rather than a substring.
- Surprising: "Optional evidence disappears under schedule pressure exactly where it matters most" — the note makes the GIF *mandatory* for user-visible GUI changes, and accepts that it costs a real-key, real-model round per GUI PR.

### .agents/notes/archived/process/2026-07-26-incremental-pr-base-retargeting.md
- Purpose: retarget PR bases incrementally instead of restarting.
- Key abstractions: "each observed base tip gets its own merge checkpoint"; the merge-forward sequence never abandons or rewrites a checkpoint.
- Data flow: if the base advances mid-work, finish and validate the merge in progress, commit it, push it when authorized, and only then fetch and merge the newer base as a separate merge commit.
- Non-obvious design decisions: restarting from the newer tip "discards completed conflict resolution and validation"; folding both tips into one rewritten merge "hides the order in which conflicts were resolved and requires rewriting remote history if the first merge was pushed."
- Edge cases / failure handling: merging a newer base changes the combined tree, so the relevant checks run again before the next push.
- Surprising: it distinguishes this note's merge-forward path from a sibling decision that permits a lease-protected rebase for standalone or stacked PRs — one mechanism per ownership boundary.

### .agents/notes/archived/process/2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md
- Purpose: provision pnpm in CI via `pnpm/action-setup@v4` and unify the caching story.
- Key abstractions: three deliberate cache shapes — symmetric (`actions/setup-node` with `cache: pnpm`), restore-only (hand-rolled `actions/cache`, because "an asymmetry `setup-node`'s cache cannot express"), and cache-less/persistent.
- Data flow: no workflow runs `corepack enable`; the self-hosted Windows install steps are the deliberate exception because clone-mode installs need `@reflink/reflink`, which the action's dest build omits.
- Non-obvious design decisions: the restore-only jobs keep cache compression/upload off their latency-sensitive paths and configure the store outside the action's replaceable install directory; "the enterprise jobs skip restore during self-hosted failover because that VM's persistent store is already warm."
- Edge cases / failure handling: `setup-node`'s built-in key spans platform, arch and the lockfile hash but not the Node version, so the node-compat matrix legs share one store entry — "safe, because the pnpm store is Node-version-independent"; there is no `restore-keys` prefix fallback, so a lockfile change starts a lane cold.
- Surprising: a composite action wrapping the two steps was rejected because "the remaining per-job variation … is deliberate policy, not boilerplate. A wrapper would grow matching inputs or flatten a real asymmetry."

### .agents/notes/archived/process/2026-07-26-web-syntax-highlighting-shiki.md
- Purpose: one syntax-highlighting system for the web client.
- Key abstractions: `shiki/core` + `@shikijs/langs` composed via `createHighlighterCoreSync` with `createJavaScriptRegexEngine({ forgiving: true })` — no oniguruma WASM, no async init; grammar allowlist `typescript`, `shellscript`, `json`.
- Data flow: `ui-primitives/src/markdown/highlight.ts` creates one `HighlighterCore` per document and exposes `highlightToHtml(code, lang)`; the module pre-warms the singleton in a deferred task at plugin boot because engine + grammar construction is a ~120–175 ms long task.
- Non-obvious design decisions: "The alias table is a `Map`, not an object: fence info strings are assistant-authored, so a label like `constructor` must miss instead of resolving an inherited property and crashing shiki." Theming routes every token color through `--shiki-*` custom properties via `createCssVariablesTheme`, with values in `ui-theme/styles/shiki.css`.
- Edge cases / failure handling: anything outside the grammar allowlist "falls back to a geometry-identical plain block, never an error"; tool output is never syntax-highlighted — "it is arbitrary text, and guessing a grammar would mis-highlight more than it helps."
- Surprising: the shiki arm injects a span tree via `dangerouslySetInnerHTML`, "sanctioned because shiki emits a static span tree computed from the code text (no user HTML passes through, no scripts/handlers)" — a narrowly justified escape from the default.

### .agents/notes/archived/process/2026-07-27-dependabot-version-updates.md
- Purpose: Dependabot version updates with a 30-day cooldown.
- Key abstractions: `.github/dependabot.yml` with weekly checks for the root pnpm workspace, `native/landlock-run`, the `python/sdk` uv project and GitHub Actions; every entry sets `cooldown.default-days: 30`.
- Data flow: the root pnpm version-update scan excludes `vendor/**`; GitHub applies `exclude-paths` only to version updates, so a security PR touching a vendored manifest is replaced through the vendoring procedure.
- Non-obvious design decisions: "Every entry sets `cooldown.default-days` to `30`, so a version release becomes eligible only after it is at least 30 days old" — a deliberate release-age quarantine; a release normally lands "between 30 and 36 days after publication because eligibility is evaluated weekly."
- Edge cases / failure handling: GitHub does not apply version-update cooldowns to security updates, so security fixes stay immediately eligible; a generated security PR can still fail the lockfile release-age check and "waits or is narrowed instead of weakening the policy."
- Surprising: automatic merging after CI was rejected because "dependency changes can alter runtime, build, and release behavior"; the repository's coordinated fresh-release exceptions are deliberately *not* copied into the cooldown exclusions.

### .agents/notes/archived/process/2026-07-27-explicit-change-scope-report.md
- Purpose: a deterministic, read-only report of the repository's current change scope.
- Key abstractions: the `change-scope` command requires `--base <ref>`, accepts `--head <ref>` (default `HEAD`), and writes one versioned JSON report with sorted committed / staged / unstaged / untracked path sets.
- Data flow: path records are split at raw NUL bytes and decoded as strict UTF-8; "An invalid value aborts the report instead of substituting characters or collapsing distinct values." Every Git probe disables filesystem monitors and optional lock-taking, forbids external diff/text-conversion drivers, and disables rename detection so both sides of a rename stay visible.
- Non-obvious design decisions: the command "never guesses or fetches a base, queries a hosting provider, or selects tests" — the caller verifies remote/stack state and supplies the base, so an incorrect base is possible but *visible* (both input refs and all three resolved commit IDs appear in the report).
- Edge cases / failure handling: dirty path sets always describe the current worktree and index, even when `--head` names another commit; exactly one merge base is required before rendering.
- Surprising: the string schema deliberately cannot represent non-UTF-8 path bytes — "A repository containing them must rename those paths before it can produce a report, preserving exact scope instead of returning a lossy one"; and "Generate required tests from changed paths" was rejected because paths cannot establish behaviour reached through configuration, dynamic loading, subprocesses, workers, built artifacts or providers.

### .agents/notes/archived/process/2026-07-27-wine-windows-gates-experiment.md
- Purpose: run the blocking win32 gates on a Linux runner under Wine.
- Key abstractions: `scripts/wine-windows-gates.sh` — the single implementation used by both the CI job and the local `pnpm run check:windows-wine` diagnostic.
- Data flow: a checksum-verified win-x64 Node.js executes `tsc -b`, `tsdown` and the VitePress production build, so the win32 branches of the toolchain actually execute; dependencies install natively on Linux with `supportedArchitectures` extended to win32-x64 and the cmd-shim layer is bypassed by invoking each tool's JavaScript entrypoint directly.
- Non-obvious design decisions: `nodeLinker: hoisted` is load-bearing, not stylistic — a prototype with pnpm's isolated layout "still could not resolve `@esbuild/win32-x64` or load the koffi prebuild through the isolated symlink chain, failing before any repository gate ran."
- Edge cases / failure handling: five environment constraints are recorded, each found as a red run — Ubuntu's `wine64` package puts nothing on PATH, Node under Wine cannot attach stdio to the caller's pipes (`Socket open EBADF` — every invocation routes stdio through a file), Wine does not realpath pnpm's symlinks, macOS Wine exposes hoisted workspace links as ordinary directories, and Wine cannot create Windows symlinks (`ENOTSUP` from VitePress's `linkVue`).
- Surprising: measured 2m46s end-to-end on a standard 2-core runner against 7–9 minutes for the replaced `windows-2025` job; the note is explicit about what the trade costs (NTFS case-insensitivity, real DACLs, ConPTY and crash durability are **not** proved, and a Wine-green PR can still fail the native-kernel master run).

### .agents/notes/archived/process/2026-07-28-per-subsystem-cordis-surface-regions.md
- Purpose: move each subsystem's generated service/event reference *into* its own page.
- Key abstractions: `gen-cordis-catalog.ts` injects between `<!-- BEGIN GENERATED cordis-surface … -->` / `<!-- END GENERATED cordis-surface -->` markers; `SERVICE_PAGE` and `EVENT_SCOPE_PAGE` are curated partitions.
- Data flow: the generator hard-errors in both directions — an unmapped discovered service/scope, and a mapped key/scope the walk no longer discovers — so the partition cannot drift; independent AST scans of every `declare module 'cordis'` merge block backstop the projection's blind spots via named `SERVICE_WALK_EXEMPTIONS`/`EVENT_WALK_EXEMPTIONS`.
- Non-obvious design decisions: the same English region bytes are written into `foo.md` and `foo.zh.md`, and `verify-translation-pairing` gained a dedicated region-identity check; the generator re-records a pair's `.i18n.yaml` itself but **only when the write is region-confined** (both recorded hashes match the pre-write bytes and the region-stripped content is unchanged) — human prose drift leaves the record stale so the normal translation flow still applies.
- Edge cases / failure handling: every generated heading is preceded by an explicit `<a id>` carrying the GitHub slug, "so the fragments resolve identically on GitHub and the VitePress site, whose own slugger treats the punctuation-heavy headings differently"; a type whose primary page is the rendering page is dropped from the `Types:` line instead of self-linking.
- Surprising: hashing *region-stripped* content in the sidecar was rejected because "the record would stop being `git hash-object` of the file, breaking the recover-last-confirmed-text property and every consumer that recomputes hashes."

### .agents/notes/archived/process/2026-07-29-oxlint-linter.md
- Purpose: migrate the linter from ESLint to Oxlint.
- Key abstractions: root `.oxlintrc.json` (authoritative, type-aware) plus a project-free `.oxlintrc.staged.json` for the bounded pre-commit path; `options.typeAware` enables `oxlint-tsgolint`.
- Data flow: the type-aware backend performs per-file TypeScript-project discovery — package sources use their package projects, host tests and website use `tsconfig.host.json`, client tests use `tsconfig.client.json`; "The program-less root solution is never flattened."
- Non-obvious design decisions: the JavaScript-plugin compatibility layer runs `@stylistic/eslint-plugin` and `eslint-plugin-sonarjs` so the established formatting and file-local duplicate-logic rules survive; the configuration "explicitly carries the migrated strict-type-checked rules and repository overrides instead of enabling broad Oxlint categories whose contents may change."
- Edge cases / failure handling: Oxlint's `--tsconfig` override affects import resolution but is ignored by type-aware linting, so the repo does not set it; CI does not restore or save a lint-result cache; `DSH_OXLINT_THREADS` passes the same bound to `--threads` and to the analyzer's `GOMAXPROCS`.
- Surprising: a one-time audit against the exact deleted ESLint configuration blob established source 88→88, examples 87→87, tests 83→83 after rule-name translation, and the committed fingerprint "neither executes the deleted configuration nor propagates later upstream preset changes"; measured 61 s → 8 s, explicitly not a performance guarantee.

### .agents/notes/archived/process/2026-07-30-cordis-config-source-plane-resolution-gate.md
- Purpose: gate that every configured plugin specifier resolves on the **source** plane.
- Key abstractions: `scripts/verify-cordis-config.ts` → `validateSourcePlaneResolution` uses `ts.resolveModuleName` from the repository root against the `tsconfig.base.json` `paths` facade.
- Data flow: a failed resolution **or a `.d.ts` hit** (the `exports` fallback into built `lib/types`) fails the gate, naming the config files and the specifier.
- Non-obvious design decisions: the incident that motivated it — `apps/cli/config/tui.cordis.yml` gained `@deepseek-ai/dsh-tui/prompt` with no `paths` mapping, so the generic `@deepseek-ai/dsh-*` wildcard substituted it into non-existent candidates and the tsx source launch fell back to `lib/prompt.js`. "Every environment with a built `lib/` booted fine, and the e2e workflow runs the keyless TUI PTY smoke in `lib` mode … so CI never exercises the source vector at all — while every clean checkout failed `pnpm dsh` at startup."
- Edge cases / failure handling: the gate resolves with `tsconfig.base.json` options only; a specifier needing client-only compiler options would fail it, "which matches the facade's role as the single resolution surface for tsx and vitest."
- Surprising: a wildcard mapping was rejected because it "fixes this one subpath but not the class; the next single-file subpath export (`/surface`, `/message`, …) regresses identically."

### .agents/notes/archived/process/2026-07-30-independent-ci-consumer-build.md
- Purpose: let the three required Linux jobs enter runner allocation independently.
- Key abstractions: coverage remains source-only; static owns source/doc checks that do not consume emitted output; the consumer job owns the single Linux build plus documentation typechecking, compiled-output snapshots, publication checks, NodeNext checks and built-bin smokes.
- Data flow: the consumer's internal gate graph preserves the real dependency (build → publint → built-package invariants → every compiled-output consumer), while no GitHub job waits for an unrelated job or transfers a built-tree artifact.
- Non-obvious design decisions: the measured reason — in one failover run "static waited 8 minutes 1 second for a runner and ran for 1 minute 41 seconds; only then could consumers enter the same shared pool, where they waited another 10 minutes 34 seconds before running for 1 minute 58 seconds."
- Edge cases / failure handling: a static failure no longer prevents the consumer inventory from producing its own evidence, though the final verdict still fails; build and documentation-typecheck failures now appear under the job that owns their output dependency.
- Surprising: "A dedicated build job" was rejected — "it would add a fourth setup and runner-allocation stage before consumers," because the consumer already owns every long-lived use of emitted output.

### .agents/notes/archived/process/2026-07-31-coverage-exempt-heavy-suites.md
- Purpose: stop paying v8 instrumentation tax on heavy suites that contribute nothing to the thresholds.
- Key abstractions: `scripts/coverage-exempt.ts` is the single roster point holding the membership contract and the filter/exclude pairs; `DSH_COVERAGE_EXEMPT_HEAVY=1` makes `vitest.config.ts` drop the exempt suites from both projects' excludes.
- Data flow: the `ci-coverage` aggregate splits into two parallel gates — the instrumented one carrying the entire threshold proof, and `test:coverage-exempt-heavy` running exactly the exempt suites through paired positional filters.
- Non-obvious design decisions: the measured waste — 555 test files aggregated 1,595 s with `type-model.spec.ts` alone at 885 s and the top 10 files holding 84% of the aggregate, and "the instrumentation tax these suites paid contributed **nothing** to the per-file 100% thresholds."
- Edge cases / failure handling: the membership contract is explicit — "every measured file the suite executes in-process is already fully covered by other suites (or threshold-excluded), and the filter and exclude select exactly the same file set." CLI `--exclude` was *proven ineffective* because vitest 4's `cliExclude` does not participate in per-project include resolution, so the env + config route replaced it.
- Surprising: the thresholds are the roster's own guard — "If a future exempt suite in fact solely covers some measured file, the instrumented gate goes red on the spot… the converse holds too: new code covered only by an exempt suite turns the gate red immediately." Measured 424 s → 95.9 s + 71.1 s in parallel.

### .agents/notes/archived/process/2026-07-31-installer-adopts-existing-checkout.md
- Purpose: make the installer adopt an existing checkout into the managed layout — one layout for every install, no opt-out.
- Key abstractions: the container owns staging worktrees and `current`; the repository is *discovered*, not owned — `git rev-parse --git-common-dir` resolves the shared git directory behind the checkout.
- Data flow: a staging worktree branched from the checkout's `HEAD` is created under `$DSH_SOURCE` and `current` points at it; the two install paths "differ only in whether the repository was discovered by `git clone` or by `git rev-parse`."
- Non-obvious design decisions: a `resolve_dir` helper makes every path comparison run on *physical* paths, and every compared value is resolved at assignment rather than at comparison — "Git always reports resolved paths, so comparing one against an unresolved path disagrees whenever a symlink sits anywhere above the checkout"; `resolve_dir` "echoes a missing path back rather than failing, so a not-yet-created container needs no per-call fallback."
- Edge cases / failure handling: before `current` is repointed the installer rejects a staging path that resolves to the repository itself, enforcing the upgrade contract that the launcher never resolves to the master clone.
- Surprising: the symlink alternative was rejected at length — git resolves the symlink and records the *real* path, so the symlink "is therefore decorative — nothing reads it — while implying the container owns the repository… it also fails silently"; and an earlier revision of this very change shipped a `DSH_ADOPT` opt-out, which was removed because "the second layout was the defect itself."

### .agents/notes/archived/process/2026-08-03-package-anchored-subsystem-pages.md
- Purpose: anchor every `docs/subsystems/` page to the package that declares its vocabulary, and make group READMEs thin.
- Key abstractions: the surviving placement heuristic is "a type is documented where its declaring package's page is, and machinery keeps living with its machinery"; `GROUPS_WITHOUT_SUBSYSTEM_PAGE` is the audited exemption list.
- Data flow: `verify-subsystem-pages` discovers groups from both group READMEs and child package manifests, and rejects a missing group README, a group with neither a reader-visible direct link to one English file under `docs/subsystems/` nor an explicit exemption, a blank or orphaned exemption, an exempt group that gains a link, and a link whose page is absent.
- Non-obvious design decisions: the spine-vs-seam rule is explicitly *superseded as the page-scoping rule* because it "selected types, not packages", so the front page became a cross-package grab-bag and `packages/core/agent`'s ownership vocabulary was documented nowhere.
- Edge cases / failure handling: the check is an independent `doc-sync` leaf so "adding a package group cannot silently omit its documentation owner"; code, comments, images, nested paths and traversal do not satisfy ownership.
- Surprising: `AgentHandle`, `CreateAgentOptions`, `ResumeAgentOptions` and `AgentFactory` had been exempt from the catalog to a package README, which left the folder that "claims to be the type reference" without them; the exemptions moved into `LINK_MAP → core.md`.

### .agents/notes/archived/process/2026-08-04-forward-only-pr-issue-status.md
- Purpose: project PR phase forward onto resolving Issues, monotonically.
- Key abstractions: status order `Inbox`, `Backlog`, `Ready`, `In progress`, `In review`; a draft PR or a non-draft PR with no review request/submitted review targets `In progress`; either form of review activity targets `In review`.
- Data flow: PR and PR-review events project to every exact same-repository resolving Issue; "Projection writes only when the target is later in that order."
- Non-obvious design decisions: the projection is deliberately **one-way** — it does not query from an Issue to related PRs and adds no scheduled reconciler, because PR events are the source of lifecycle advancement; it is also independent of PR metadata validation, since "a metadata defect does not make the implementation or review phase untrue."
- Edge cases / failure handling: it never moves an Issue backward, never alters `Done` or `No action`, and never adds an Issue with no Project status; a draft PR stays `In progress` even with historical review activity.
- Surprising: an Issue created after the last relevant PR event waits for a later event or a manual update — "because there is no reverse lookup or scheduled sweep" — and moving a status backward on a draft/lost-reviewer transition was rejected so transient PR state cannot overwrite a later observed phase.

### .agents/notes/archived/process/2026-08-06-coverage-uncovered-locations.md
- Purpose: make a red coverage gate directly actionable by naming exact uncovered locations.
- Key abstractions: `scripts/coverage-uncovered-locations.cjs` — a custom istanbul reporter (`ReportBase` subclass) emitting `<path>:<line>:<col> uncovered <kind> …` per uncovered statement, untaken branch path and uncalled function.
- Data flow: the reporter joins both the CI and local reporter arrays **by absolute path** (`fileURLToPath`) because istanbul-reports' `create()` falls back to a bare `require(name)` for non-built-in names, and a relative path would resolve against istanbul's own package directory.
- Non-obvious design decisions: the reporter lives at the one coverage configuration point — the coverage block in the root `vitest.config.ts` — so it takes effect at the CI lane, local `test:coverage` and focused runs at once, with no second entry point to wrap.
- Edge cases / failure handling: istanbul's 0-based columns are converted to 1-based; v8 reports `end.column = Infinity` for whole-line statements, so a line-crossing span degrades to a `(to <line>)` suffix; an implicit branch arm with no location falls back to the branch's own span so the record stays clickable; all-green runs print nothing.
- Surprising: CJS is a forced, justified exception to the ESM-everywhere discipline — istanbul loads custom reporters via a bare `require()` outside the tsx/Vite pipeline, and `require(esm)`'s namespace object also fails its `new Cons(cfg)` construction.

### .agents/notes/archived/process/2026-08-06-doc-site-carries-its-images.md
- Purpose: the documentation site must carry its own images.
- Key abstractions: `rewriteMarkdown` takes an optional `placeImage(absPath): string`; a published page's images are copied into the generated tree beside the page and referenced as `./<basename>`.
- Data flow: one map claims every projected path — pages and images alike — so a second source for one path throws, in the same spirit as the existing duplicate-route check.
- Non-obvious design decisions: the bug was that a private repository's images 404 for every reader, because `raw.githubusercontent.com` answers 404 unauthenticated and "a browser session on github.com does not authenticate it either" — and "no gate said so: `verify-md-links` and the projector check that the target file *exists in the repository*, which is a different question from whether a site reader can fetch it."
- Edge cases / failure handling: only a regular file whose real path stays inside the repository is copied — a symlink out of the tree, a path outside it, and a directory are all refused — "because publication copies its bytes onto the site, so a reference escaping the repository … would put a build-machine file on a published page."
- Surprising: the copy lands beside the page rather than in a shared asset directory so one relative URL is correct from both `guide/` and `en/guide/` without computing per-locale prefixes, and a page's assets are removed with the page when the manifest drops it.

### .agents/notes/archived/process/2026-08-06-in-repository-landlock-release.md
- Purpose: move the Landlock native launcher's source and release into the main repository.
- Key abstractions: three organization-owned npm packages (`@deepseek-ai/node-addon-landlock-run` plus `-linux-x64` / `-linux-arm64`); the entry keeps the platform packages as `optionalDependencies` so npm's `os`/`cpu` fields select one.
- Data flow: `native/landlock-run` joins the root pnpm workspace and root lockfile; harness consumers declare `workspace:*`; the release workflow builds both platform binaries, packs immutable tarballs, installs and exercises those tarballs, and only then permits the protected publish job.
- Non-obvious design decisions: "The sandbox packed-install rehearsal does not permit the npm registry to supply the launcher" — it derives the harness closure transitively from current workspace dependencies and installs the local tarballs into an external plain-Node consumer, proving the installed launcher is executable, byte-identical to the native build and the correct ELF architecture.
- Edge cases / failure handling: npm cannot replace an already-published name+version and offers no cross-package transaction, so "a failed publish can leave a partial version" and an operator must publish only the missing tarballs; the first scoped release must use an `@deepseek-ai` organization token because trusted publishing needs an existing package.
- Surprising: repository ownership and npm package layout are separate choices — "merging repository ownership does not imply putting every binary into one tarball" — and the rationale for the whole move is that a fixed registry version let "one pull request … change the launcher contract and its consumer without testing those changes together."

### .agents/notes/archived/process/2026-08-08-api-remotes-generated-contract-build.md
- Purpose: order the build so Typert's generated Remote contracts exist before the Client compiles.
- Key abstractions: `api/remotes` is the sole package with both Host and Client composite projects; the package-root `tsconfig.json` is a solution that "enters neither aggregate nor any direct consumer's dependency graph."
- Data flow: `tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` (which runs Typert and emits the Remote Client contract) → `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → Web build; `typecheck` runs the complete Host lib phase first.
- Non-obvious design decisions: the Typert analyzer distinguishes compiler faces from runtime faces — "Direct Project References in the aggregate determine which compiler face analyzes a project" while "Runtime models follow package subpath contributions", so an ordinary dual-entry package contributes both Host and Client runtime models while a split package does not.
- Edge cases / failure handling: the two projects use disjoint `files` and separate `.tsbuildinfo` files so they can share `lib/types` without emitting any source file twice; the workspace constraints gate walks the reachable Project Reference graph and rejects a face-declared project referencing a split package's solution root or opposite leaf.
- Surprising: "A clean build is the authoritative check of ordering correctness" and "No phase may write artifacts into `src`" — the note uses a clean tree as the test oracle for a build-ordering contract.

### .agents/notes/archived/process/2026-08-08-automatic-translation-pairing-merges.md
- Purpose: make pairing records merge automatically instead of conflicting.
- Key abstractions: `*.i18n.yaml` uses a repository-owned `dsh-translation-pairing` Git merge driver registered by the worktree-local installer (`git config` stays local "because a tracked attribute can name a driver but cannot carry its executable command").
- Data flow: the driver parses ancestor/current/other records, loads the six owner blobs by hash, runs Git's default three-way text merge for both language triplets, requires both merges clean, verifies switchers and the pairing structural signature, stores the merged blobs and writes their hashes.
- Non-obvious design decisions: it "composes confirmations already present in both parents; it never records an ordinary one-sided documentation edit." When the runtime is unavailable the launcher materializes Git's ordinary three-way text result in the sidecar **but returns a conflict even when that text merge is clean**, "so Git retains the unmerged index stages and never accepts unverified metadata."
- Edge cases / failure handling: a five-row failure contract table names the observable state and recovery for each failure (probe/install failure → rollback; runtime lost → sidecar at `UU` with stages 1/2/3 intact; driver rejection → merge stopped; driver crash with status > 128 → Git aborts the strategy without publishing `MERGE_HEAD`; `pre-merge-commit` rejection → complete result staged, no commit).
- Surprising: `pre-merge-commit` and `pre-commit` *validate* staged `.i18n.yaml` files against the exact index bytes of their owners but do not regenerate them, "so bypassing a hook cannot silently bless translation drift"; and `pnpm run resolve-translation-pairing-conflicts` writes every safe record as one batch, then reports the remainder and exits unsuccessfully "so callers cannot mistake a partial resolution for a completed merge."

### .agents/notes/archived/process/2026-08-08-browser-gif-evidence-chain.md
- Purpose: make a browser storyboard one **evidence chain** pinned to an exact PR head.
- Key abstractions: a clean worktree plus a recorded commit SHA before building; fresh `DSH_HOME`, `DSH_AGENTS_HOME`, workspace, session and isolated browser state per run; the final encoded GIF is the verification subject.
- Data flow: "every published frame comes from the same server and model-backed scenario run"; a failed capture run is discarded and repeated from fresh roots rather than combined with another run.
- Non-obvious design decisions: the workflow waits for unique, exact semantic states — "Fuzzy accessible-name matching can also accept prompt echoes or descendant text instead of the intended result" — and when the claim concerns a tool call, rejection or recovery the storyboard must include a detail/trajectory frame naming the tool and its status or stable error code.
- Edge cases / failure handling: publication re-checks the live head immediately before and after the PR body changes, and must equal the recorded head; the `gh --attach` path requires the live body to show the rewritten uploaded URL, which must respond `200` and `image/gif`; the assets-branch path checks a private asset through an authenticated request for path, byte size, checksum, status and media type.
- Surprising: a native production surface may be replaced **only through normal application configuration with an official browser-operable production backend**, and the override must be stated next to the GIF — "replacing that surface with a mock or test hook would mean the GIF no longer shows the production path."

### .agents/notes/archived/process/2026-08-08-lightweight-routine-documentation-translation.md
- Purpose: make routine bilingual edits one shot and one pass.
- Key abstractions: the active agent loads `terminology.md`, translates only the changed content, moves a terminology annotation when the true first occurrence crosses the edit boundary, otherwise preserves reviewed counterpart prose, and re-records the pair.
- Data flow: no translation skill, no briefing, no separate review pass, no subagent; the extended `dsh-translate-docs` skill is retained but made **manual-only** via `disable-model-invocation: true` / `user-invocable: true` in `SKILL.md` and `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- Non-obvious design decisions: the reason is cost-shaped — the orchestration "consumed more time, context, and model tokens than translating the changed text itself", and "automatic skill discovery exposed the workflow on ordinary documentation turns."
- Edge cases / failure handling: automatic workflows do not chain into the manual skill — the documentation, website-sync, prose and code-review skills link to the standing instructions instead; the `doc-sync` skill-invocation-metadata gate keeps the two products' policies aligned.
- Surprising: size-based inference was rejected — "another hidden policy and can unexpectedly activate the expensive workflow. The user, not the agent, chooses when the extended path is worth its cost"; and the glossary load was *kept* despite the token savings, "the glossary is the small, binding input that prevents repository-wide term drift."

### .agents/notes/archived/process/2026-08-08-review-driven-issue-lifecycle-triggers.md
- Purpose: drop the `ready_for_review` subscription from the Issue-lifecycle workflow.
- Key abstractions: the lifecycle workflow keeps `pull_request.review_requested` and `pull_request_review.submitted`; the *policy* workflow still subscribes to `ready_for_review`.
- Data flow: the handler "continues to fetch the live pull request instead of deriving phase from the triggering payload" — so the trigger is a wake-up, not a source of truth.
- Non-obvious design decisions: "Draft-to-ready automation commonly submits a review moments later. In that sequence the ready job cannot advance the Issue, while the review job is still required to observe the `In review` phase" — so the ready trigger carries no lifecycle information at all.
- Edge cases / failure handling: removing a lifecycle trigger does not weaken policy enforcement, because the required Issue-policy check still runs at the ready boundary; the workflow test parses both files and pins the split.
- Surprising: cancelling the in-progress run was rejected because "concurrency can discard a pending run but cannot combine two webhook payloads into one execution", and delaying every PR event behind a debounce dispatcher was rejected because it "adds latency and control-plane state to eliminate a trigger that carries no lifecycle information."

### .agents/notes/archived/process/2026-08-09-chinese-contract-terminology.md
- Purpose: standardize the Chinese rendering of English `contract` on 约定.
- Key abstractions: the terminology table is the source of truth; `contract` → 约定, `adapter contract` → 适配器约定（adapter contract）on first mention.
- Data flow: the migration scans every active bilingual pair, updates each affected Chinese document and re-records its sidecar; the pairing gate, full `doc-sync`, website build, translation-prompt tests and snapshot, and `git diff --check` verify the result.
- Non-obvious design decisions: the overlap with `convention` is intentional — "ordinary Chinese engineering prose uses 约定 for both concepts, and context normally carries whether a statement is descriptive practice or a binding interface rule" — so a source sentence that explicitly contrasts them must preserve the distinction through wording such as 惯例 vs 约定.
- Edge cases / failure handling: this is semantic prose maintenance, not an identifier rename — "Inline code, file paths, links, API names, English filenames containing `contract`, and machine-readable values remain unchanged"; archived Agent Notes remain frozen.
- Surprising: `convention` deliberately gets **no** global terminology row and no corpus-wide rewrite, because its meaning ranges from naming practice to protocol convention; and permitting both 契约 and 约定 was rejected because it "preserves the exact inconsistency that made package families and even individual paragraphs disagree."

### .agents/notes/archived/process/2026-08-09-committed-artifact-citations.md
- Purpose: durable prose may cite only committed artifacts — never design-session ordinals.
- Key abstractions: the citation vocabulary is the owning Agent Note (path at least once per file, searchable name inline), a doc page path, or a GitHub issue number; PR/commit/branch/stack positions stay banned.
- Data flow: a one-shot repo-wide purge applied the rules across prose surfaces, including generator-owned templates (`scripts/gen-doc-graphs.ts`, `scripts/gen-tool-catalog.ts`, the typert generator's page notice) with regeneration, and the bilingual counterparts with pair re-records.
- Non-obvious design decisions: the audit that motivated it found the pattern concentrated in `packages/client` — bare `(decision 12/16/19/20/21)` citations of which only decision 21 had a committed owner, `(audit C2/S1/S3/S7)` codes with no audit document anywhere, `design §4.7` references to uncommitted drafts, and "deferred to a later PR" claims whose targets had since shipped.
- Edge cases / failure handling: fixed regressions are pinned as present-tense counterfactuals ("without X, Y happens"), never as repo history ("used to Y"); recorded fixtures, snapshots and archived notes are exempt because they keep their original voice.
- Surprising: the note concedes the coverage gap — "no gate rejects a new ordinal citation — review owns the rule" — and records the candidate narrow gate (`\(decision \d`, `\(audit [A-Z]\d`, `§\d` excluding citations with a committed owner) rather than pretending the rule is mechanical.

### .agents/notes/archived/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.md
- Purpose: prose must name the exact actor, action, source, event, field, file or process.
- Key abstractions: the spoken-language check — "replace words they would not use while explaining the same point to a colleague"; the rule covers Markdown, READMEs, active Agent Notes, JSDoc, comments, prompts, diagnostics and user-visible strings.
- Data flow: an audit judges each sentence separately and "does not replace a term across the repository with one preferred synonym."
- Non-obvious design decisions: `contract`, `boundary` and `shape` get a usage test rather than a ban — `Contract` stays correct for preconditions, postconditions, invariants and compatibility promises; `Boundary` for a literal security/trust/wire/process/serialization/transaction/lifecycle division; `Shape` when the structural form itself is the subject.
- Edge cases / failure handling: exact code identifiers, public APIs, durable fields, protocol members, type names and filenames stay unchanged unless a coordinated contract rename is independently required; comments retain only facts nearby code cannot express.
- Surprising: "Renaming every matching identifier with the prose" was rejected — "editorial clarity does not justify unrelated API, protocol, durable-format, type, or file migrations."

### .agents/notes/archived/process/2026-08-09-md-fragment-anchor-gate.md
- Purpose: `verify-md-links` resolves `#fragment` anchors, closing the last dead-link class.
- Key abstractions: slugs are computed from the **rendered** heading text via the repository's own `markdownHeadingLines`; anchors are either a heading's GitHub slug or an explicit `<a id>` in real HTML flow.
- Data flow: anchor sets are collected lazily for any existing target (`anchorCache`), so links *into* archived notes and vendor documents are validated without making those files sources.
- Non-obvious design decisions: the corpus sweep found 15 broken fragments in three distinct decay modes — a heading reworded after the link was written, a contract relocated to a different owning document, and zh pair sides linking English slugs their Chinese headings never produce.
- Edge cases / failure handling: `<a id>` inside code samples or commented-out anchors registers nothing; repeated slugs get GitHub's occupied-set `-1`, `-2` suffixes; matching is exact-case because element ids are case-sensitive; fragments onto non-Markdown targets (`file.ts#L10`) stay out of scope.
- Surprising: the slug function deliberately differs from `gen-cordis-catalog`'s region-anchor slugger (which drops underscores) — "the two need not share one rule" because the generator's headings are always reachable through explicit `<a id>` anchors; and the manual pre-rename grep survives only for anchors cited from TypeScript strings whose output never reaches gate-scanned Markdown.

### .agents/notes/archived/process/2026-08-09-oxlint-only-fix-workflow.md
- Purpose: one lint runner for the whole repository, with a bounded fix retry.
- Key abstractions: `scripts/run-oxlint.ts` — validation is one process with inherited output; a `--fix` invocation captures the first result and, on a completed non-zero run, discards the obsolete diagnostics and runs the same command once more with inherited output.
- Data flow: the `lint:fix` script and the staged lefthook job use the runner; the formatting-only ESLint configuration and the direct `eslint` / `@typescript-eslint/parser` dev dependencies are absent.
- Non-obvious design decisions: "Overlapping plugin fixes can apply one change while leaving a newly exposed diagnostic; the repository's `semi` and `object-curly-spacing` fixture requires a second pass before it is clean" — hence the retry.
- Edge cases / failure handling: the runner re-raises a child signal instead of retrying or converting it to an exit code; the first pass buffers each output stream up to 64 MiB so obsolete diagnostics are not printed when the retry succeeds, and process creation or capture failures surface immediately without a retry.
- Surprising: "A completed non-zero fix invocation always pays for one retry, including a stable unfixable error" — and a separate formatter (Oxfmt) was rejected as "a formatter migration changes the repository's output contract and would create an unrelated formatting diff."

### .agents/notes/archived/process/2026-08-10-vendor-package-rescope.md
- Purpose: rescope the nine vendored Cordis packages into `@deepseek-ai`.
- Key abstractions: `scripts/rescope-vendor.ts` owns the mapping, a **delimited, complete package-name token** rule, per-file exemptions, and a `--check` mode asserting "no residue, every exact edit landed, and idempotency."
- Data flow: the rewrite touches only quoted/backticked specifiers, `package.json` names and dependency keys, `cordis.yml` `name:` values and `tsconfig.base.json` `paths` keys; Markdown follows the rename under `docs/` but keeps the old names in `vendor/*/README.md`, package READMEs and `.agents/notes/`.
- Non-obvious design decisions: the reason is a publication hazard — "publishing it under the upstream names squats them on the registry, and where that registry proxies npmjs, the same-name entries shadow the real upstream packages and install the wrong framework into unrelated projects."
- Edge cases / failure handling: two classes are invisible to a token rule and were renamed site by site — **property access** (`manifest.peerDependencies?.cordis`, which TypeScript cannot catch against a `Record<string, string>`) and **constants carrying the name as data** (the vendored set in `check-workspace-constraints.ts`, `declare module` target strings in `cordis-walk.ts`, `gen-scoped-events.ts`, typert's `analyzer.ts`).
- Surprising: re-applying the rename to upstream sources is a script (`pnpm run rescope-vendor --apply`) not a manual diff — "a rebase replays it instead of resolving a 1300-file conflict"; and returning to the official upstream packages is a **reverse** mapping run, "so replay it with the script rather than by hand."

### .agents/notes/archived/process/2026-08-11-python-publication-workflow.md
- Purpose: the public PyPI publication workflow for the Python SDK.
- Key abstractions: one platform-independent client wheel plus five native runtime wheels that must carry one version; PyPI Trusted Publishing (OIDC) rather than a stored token.
- Data flow: `publish=false` manual runs exercise the complete native build and validation with **no registry credential and no OIDC permission**; a `publish=true` run additionally requires the `python-v<repository-version>` tag, a matching `PYPI_PUBLISHER_REPOSITORY` variable, `PUBLIC_PYPI_RELEASE_ENABLED=true`, and approvals from the `pypi-runtime` and `pypi` environments.
- Non-obvious design decisions: only the two publication jobs receive `id-token: write`; each verifies the retained `SHA256SUMS` before selecting its upload set; the runtime job uploads all five platform wheels *before* a dependent job uploads the SDK wheel "because PyPI uploads are not atomic and the SDK pins the runtime distribution at the exact same version."
- Edge cases / failure handling: "Neither job checks out source or rebuilds a wheel"; a failed publish can leave a partial version, so an operator must inspect the registry and publish only the missing tarballs rather than rerunning the workflow unchanged.
- Surprising: both publication actions **disable public attestations** — the action still uses Trusted Publishing, but omitting provenance avoids disclosing the private publisher repository instead of the public source mirror; and both build requirements pin Hatchling 1.30.1 because the next release emits Core Metadata 2.5, which the pinned Twine 6.2.0 rejects.

### .agents/notes/archived/process/2026-08-12-documentation-site-navigation-and-chrome.md
- Purpose: fix documentation-site navigation placement and strip repository chrome.
- Key abstractions: `website/docs.ts` owns section placement — `sections` declares groups per locale and `sectionSpec(locale, label)` returns position and collapse behaviour, **throwing** when a locale declares no placement for a label; `landingLink(locale, collection)` derives each nav item's target from `orderedPages`.
- Data flow: `projectedPageContent` in `scripts/project-doc-site.ts` drops the language-switcher line and the repository badge, with the switcher match confined to the first eight lines "so a tutorial that shows the convention still renders its example."
- Non-obvious design decisions: the bug was a silent `indexOf` returning `-1` for unplaced groups, sorting 43 subsystem pages ahead of every other group and landing the architecture page 1,549 px down a 2,478 px sidebar; the fix is "A group absent from the declaration now fails the build instead of sorting silently to the top."
- Edge cases / failure handling: placement is per locale because a shared label (`SDK`) "cannot hold one rank against 入门 and against Guide at once"; `project-doc-site.spec.ts` pins three invariants (every sidebar-owning page resolves a placement, an undeclared section is refused, no two pages share an `order` within a section).
- Surprising: a Chinese search tokenizer was built and reverted after the premise was tested against a term absent from the corpus — `prefix: true` already reaches Chinese terms through the short tokens punctuation produces — and the attempt surfaced a trap worth keeping: VitePress ships search-option functions through `Function.prototype.toString` and rebuilds them with `new Function`, so a function closing over a module-level constant "throws in an empty scope and silently returns no results."

### .agents/notes/archived/process/2026-08-12-face-named-client-test-files.md
- Purpose: name the compile face a Client test covers, in the filename.
- Key abstractions: `*.client.spec.ts` / `*.client.ts` (232 + 5 Client files) and `*.host.spec.ts` (4 Host files) — the suffixes are mutually exclusive, "so each aggregate keeps one broad test glob and excludes the other face."
- Data flow: `tsconfig.client.json` includes `packages/client/*/tests/**/*.{ts,tsx}` and excludes `*.host.spec.ts`; `tsconfig.host.json` reaches the same directory through `packages/*/*/tests/**/*.ts` and excludes the `*.client.*` patterns; the mechanism is that "`exclude` filtering the result of `include`: when both match, the file stays out."
- Non-obvious design decisions: the first attempt — suffix only the Host files — provably cannot work: "`.host.spec.ts` also ends in `.spec.ts`, so the host aggregate's exclusion of `*.spec.ts` swallows it, and `include` cannot win it back. Naming both faces is what makes the two patterns disjoint."
- Edge cases / failure handling: the `constraints` project-reference rule keeps its full strength with no package exempt; the Host program now sees 11 files under `packages/client` instead of the 60 that leaked in while the exclusion was pattern-based but the filenames were not.
- Surprising: the note states the residual failure mode explicitly — "An unsuffixed new test is the failure mode this leaves open: it type-checks in the Host program against Client source instead of failing loudly" — and it is a *filename* convention, not a gate.

### .agents/notes/archived/process/2026-08-13-public-vendor-and-native-sequences.md
- Purpose: npm access is a property of each *release sequence*, not of the scope.
- Key abstractions: three sequences — vendored framework (9 `vendor/*` packages, `public`), native (3 `native/landlock-run/packages/*`, `public`), dsh (221 members, `restricted`).
- Data flow: `check-workspace-constraints.ts` holds every manifest to its own sequence's level, "which is what stops the scope from drifting"; `publish.ts` passes **no** `--access` flag, so each packed manifest decides.
- Non-obvious design decisions: "A restricted dependency is what actually blocks a public consumer" — every harness package declares the vendored framework as a peer dependency, so the two dependency sequences must be public before the dsh family can be.
- Edge cases / failure handling: harness consumers reference the Landlock entry as `workspace:^` (accepting patch and minor) while the entry keeps `workspace:*` for its platform packages, "where the binary must match the entry version exactly."
- Surprising: access is a property of the *package*, not of a version — the twelve already-published restricted packages become world-readable at their next publication, "and that is not cleanly reversible"; and "An unauthenticated `npm view` becomes a usable check for the public sequences" because while everything was restricted a machine without credentials got `E404` for a package that existed.

### .agents/notes/archived/process/2026-08-13-published-document-fragments.md
- Purpose: validate fragments in the *published* HTML, not just in source Markdown.
- Key abstractions: `verify-doc-site-fragments` runs after VitePress emits `website/.dist`; it parses every emitted HTML page and resolves each internal fragment link against VitePress clean URLs.
- Data flow: the check fails when the output is absent, routes are ambiguous, an href is malformed, or either the target page or the requested id is missing.
- Non-obvious design decisions: `verify-md-links` validates fragments with GitHub's heading ids while the site renders with VitePress, so "punctuation-heavy headings and translated headings can therefore pass source validation but produce links to ids absent from the published HTML. A successful VitePress build validates target pages, not fragment ids."
- Edge cases / failure handling: any fragment target heading whose GitHub id differs from its VitePress id carries an explicit GitHub-compatible alias — placed before the heading by authors, using the *English* id shared by the bilingual pair, and emitted by the owning generator for generated catalogs.
- Surprising: locale-specific fragments were rejected because "bilingual pairs intentionally preserve an identical fragment suffix even though a paired file path follows the source locale."

### .agents/notes/archived/process/2026-08-17-readme-assets-on-cdn.md
- Purpose: publish README assets from a dedicated repository onto a CDN.
- Key abstractions: the private `deepseek-harness/readme-cdn-assets` repository owns three allowlisted PNGs, their tests and the publication code; the README references fixed URLs under `https://cdn.deepseek.com/harness/readme/`.
- Data flow: a push to its `master` runs `publish.yml`, which installs the pinned Huawei OBS SDK, tests `scripts/upload.mjs`, and uploads with `Content-Type: image/png` and `Cache-Control: no-store`.
- Non-obvious design decisions: the uploader accepts **only** the three README filenames and verifies each source is a PNG, "because the same credentials could then overwrite unrelated CDN objects"; the OBS identity has write access only to that object prefix.
- Edge cases / failure handling: the uploader checks the OBS response status, reports the resulting public URL, and closes the client on both success and failure.
- Surprising: content-addressed CDN object names were rejected because "each image replacement must also change the README URL, which removes the independent update path this workflow exists to provide" — the fixed name *is* the decoupling.

### .agents/notes/archived/process/2026-08-18-in-job-partitioned-coverage.md
- Purpose: partition coverage *inside* one job, keeping every test and the merged thresholds.
- Key abstractions: `scripts/coverage-partitions.ts` starts the configured Vitest children concurrently, each with one worker; `DSH_COVERAGE_PARTITIONS=4` on both Linux and native Windows; files are assigned to partitions by **weighted longest-processing-time** via a min-heap using recorded per-file durations.
- Data flow: the coordinator collects the instrumented inventory from `vitest list --filesOnly`, reads per-file durations from a coordinator-persisted gitignored file restored/saved through the GitHub cache, gives each partition a temporary Vitest config with its own file list, and then runs **one** `vitest --merge-reports … --coverage` command that applies the thresholds.
- Non-obvious design decisions: "command-line files exceeded the Windows CreateProcess limit" hence temporary configs; "the mutually exclusive thread-safe and process-bound projects keep only their own files so nothing runs twice"; an empty partition is rejected before any child starts; "the heaviest partition starts first so its verdict lands earliest (fail-fast)."
- Edge cases / failure handling: partition mode suppresses thresholds and reporters in each child and writes one blob per process with a partition-location canonicalizer so blobs stay mergeable; the coordinator validates "the blob directory contains exactly the expected files"; a failed test still emits a blob through `--coverage.reportOnFailure` so the merge reports the complete state; cleanup "removes only its owned coverage tree and unlinks a link-shaped path instead of recursively following it."
- Surprising: "Slow progress alone never raises partition count or outer concurrency, because repeated restarts would erase the only evidence needed to choose a stable setting"; and applying thresholds per partition was rejected because every partition "intentionally sees only part of the suite and would report false uncovered files."

### .agents/notes/archived/process/2026-08-18-localized-bilingual-links.md
- Purpose: a repository-relative document link follows the *source file's* locale.
- Key abstractions: English sources use the target `.md`, Chinese sources use its `.zh.md`; both sides keep the same semantic target and the exact query/fragment suffix.
- Data flow: the pairing core resolves relative paths against the tree, applies the active-scope/manifest-exclusion predicate, and normalizes paired locale paths to one English-sibling identity for structural comparison; `verify-translation-pairing` rejects a wrong-locale target naming the source file, line, actual URL and expected URL.
- Non-obvious design decisions: the bug was that "The website masks this error by routing ordinary links through the current locale, so the repository source and the published site previously produced different navigation results" — GitHub renders the source directly, with no projector.
- Edge cases / failure handling: a missing counterpart in the corpus is a pair-completeness error, not a fallback; external URLs, images, pure in-page fragments and out-of-corpus targets are unchanged; the language switcher is the explicit cross-locale exception.
- Surprising: the Cordis subsystem-region generator "renders one catalog model, then projects paired document destinations for the Chinese output" so the generated regions stay byte-equal apart from the locale paths; and a locale-link manifest was rejected as a second registry that "would duplicate identity and require updates for every move or new pair."

### .agents/notes/archived/process/2026-08-19-remove-knip.md
- Purpose: remove Knip from the repository gates.
- Key abstractions: the replacement checks are narrower but real — TypeScript + Oxlint validate source imports, workspace constraints validate manifests, `verify-optional-dependency-imports`, `verify-runtime-closure`, `verify-client-packages` and publint cover the rest.
- Data flow: the root manifest has no Knip script or devDependency, the gate graph and `hygiene` do not invoke it, and no Knip configuration is carried.
- Non-obvious design decisions: the reason is that a static source graph cannot represent the assembled application — "DeepSeek Harness also loads Cordis plugins from package manifests and configuration, emits Typert faces into `lib/`, splits Host and Client programs, and declares dependencies consumed only by generated or runtime-loaded code."
- Edge cases / failure handling: the repository accepts a named coverage gap — "there is no repo-wide static check for unused files, exports, or dependencies" and "a dependency with no source import is not dead-code evidence by itself."
- Surprising: the exception inventory was the real cost — "Package and test-layout changes had to maintain that second approximation of the executable graph"; and the note sets the bar for any future replacement: it "must understand manifest-driven Cordis loading, generated outputs, and the Host/Client split without a per-workspace ignore inventory."

### .agents/notes/archived/process/2026-08-20-doc-site-raw-markdown-twins.md
- Purpose: serve every published page as raw Markdown and add an `llms.txt` index for agents.
- Key abstractions: `emitRawMarkdownPages` runs the same manifest-and-projector pass that fills `website/.generated/`, but writes `<outDir>/<route>` with raw content — no `editSource`/`outline` frontmatter, no locale-home truncation, and the same repository-chrome stripping; images are copied beside the twins.
- Data flow: one projection serves both trees because its site-internal links are relative — "`./sibling.md` renders as a clean URL on the HTML site and resolves file-to-file in the raw tree"; `llms.txt` is generated from the publication manifest with one `- [label](<base><route>): <section>` row per page, site-absolute under the deploy-time `DOCS_BASE`.
- Non-obvious design decisions: an index route renders as a directory URL, so each index route also emits a **parent-level alias twin** — "The alias is not a copy — a copied `index.md` would carry its relative links one directory too high — but its own projection over the alias route."
- Edge cases / failure handling: each production entry point requires `outDir` to be a proper child of the site root, unlinks a link-shaped output without traversing its target, and removes a real output directory before bundling; the raw-twin pass treats files created by the current VitePress build as occupied, so a name collision fails the emission.
- Surprising: the note records exactly why `vitepress-plugin-llms` was rejected despite being maintained and MIT — it flattens `dir/index.md` to `dir.md` with no opt-out (404ing every relative link into a section landing page; this site publishes seven index routes per locale) and rewrites image references to root-absolute hashed bundle paths without the site base.

### .agents/notes/archived/process/2026-08-21-documentation-site-tag-release.md
- Purpose: publish the documentation site from a release tag, not from master.
- Key abstractions: `docs-pages.yml` declares `workflow_dispatch` **alone** and publishes from a `dsh-v*` tag — "the structure `release-publish.yml` already uses for npm."
- Data flow: the build job runs `release:verify --family dsh` with `RELEASE_PUBLISH=true` before building anything, so the site and the npm sequence share one definition of a released version; checkout takes complete history because the release scripts read tags; the `github-pages` environment carries a `dsh-v*` deployment tag policy and required reviewers.
- Non-obvious design decisions: the problem was that "every other public surface of this project advances only at a release tag" while the doc site deployed on every master push touching `docs/` — "That site is reachable without authentication even though the repository is private, so a merge published documentation to the internet within minutes."
- Edge cases / failure handling: two layers answer different failures — "the script gate rejects a dispatch from the wrong ref, and the environment policy still rejects the deployment if a later workflow edit stops asking"; `DOCS_REPOSITORY_REF` stays `master` because the public repository keeps only its most recent tags.
- Surprising: adding required reviewers to the master-push environment was rejected because "an approval prompt on every documentation merge is a prompt reviewers learn to clear without reading, and nothing connects the approved content to a version anyone can install" — the reviewer would be answering "does this page look publishable" when the question is "is this released."

### .agents/notes/archived/process/2026-08-23-client-cross-package-value-dependencies.md
- Purpose: classify every Client cross-package reference by *what crosses the boundary*.
- Key abstractions: a seven-row treatment table — delete unused value, `import type` for shared declarations, an injected Cordis service for stateful/lifecycle-bound/callable behaviour, a declaring slot for presentation contributions, a narrow static utility for generic stateless helpers, a local copy for small target-specific projections, and the API transport assembly for generated Remote artifacts.
- Data flow: `verify-client-packages` rejects every `dsh.client.external` declaration under `packages/client/*`; outside that tree each declaration must correspond to a production runtime import or re-export (only Session Controller → API Gateway and Workspace Controller → API Gateway remain, both transport infrastructure).
- Non-obvious design decisions: the 15 leftover `dsh.client.external` requests "turned ordinary value imports into synchronous module-table ordering constraints, even when the consumer needed only a type, a small pure conversion, or access to an already-injected Cordis service."
- Edge cases / failure handling: intentional target-local copies wrap **only** the duplicated implementation in `jscpd:ignore-start` / `jscpd:ignore-end` with a comment naming the independent owners — "The exclusion must not cover surrounding business logic."
- Surprising: the rule is role-specific, not a blanket ban — Host-facing transport adapters stay direct imports "because these imports assemble transport rather than sharing feature behavior" — and generic behaviour moves to a utility "only when its semantics are stable outside every current caller."

### .agents/notes/archived/process/2026-08-27-explicit-workspace-path-aliases.md
- Purpose: replace per-group wildcard path aliases with one explicit alias per workspace package.
- Key abstractions: `scripts/gen-tsconfig-paths.ts` writes a marked region at the end of `paths`; `pnpm run gen-tsconfig-paths` rewrites it and `pnpm run verify-tsconfig-paths` reports drift in the `ci-static` lane.
- Data flow: the generator emits an alias only for a package whose declared name is exactly `@deepseek-ai/dsh-<directory>`; packages named after something other than their directory keep their hand-written aliases; the region is written by text surgery between marker comments because `tsconfig.base.json` is JSONC with comments.
- Non-obvious design decisions: the measured cost of the wildcards — "a specifier whose package sits late in the list pays for every earlier miss… a profile of a source-launch boot attributed 934.6 ms — 35% of the boot — to that decoration path alone, from 60,942 failed resolutions." `packages/util/*` sat at position 44 of 49, so `dsh-timeout` paid ~9 ms per resolution against 0.05 ms for an explicit alias.
- Edge cases / failure handling: the generator asserts **coverage** — every workspace package with a `src` directory must be mapped, because otherwise "a package whose name does not match its directory could be added, skipped by the generator, and left resolving through the workspace symlink to built `lib/` output — the same artifact-plane leak the explicit aliases exist to close"; a specifier claimed by two package directories throws.
- Surprising: eleven specifiers that previously resolved to built `lib/` now resolve to source (seven `/invariant` subpaths the deleted wildcard omitted, plus four whole packages) — and the CLI entry guard uses `import.meta.filename === resolve(process.argv[1])` rather than concatenating a `file://` URL, because "the failure is silent: the script exits 0 having done nothing, which would make the gate a no-op exactly where it is needed." Measured boot: 2,157/2,182/2,153 ms → 1,069/1,052/1,055 ms, ~51%.

### .agents/notes/archived/process/2026-08-27-gate-runner-fail-fast.md
- Purpose: abort a red aggregate at the first blocking gate failure.
- Key abstractions: `run-gates.ts` accepts a fail-fast option (enabled by `DSH_GATE_FAIL_FAST=1`); the shared `AbortSignal` terminates every running gate's process tree; not-yet-run gates are recorded `skipped` with `aborted by fail-fast: <label> failed` (or `… host interruption`).
- Data flow: the exit status stays 1 "including when a killed child traps the signal and exits zero: such a result carries the abort mark and is recorded `skipped`, never passed"; a gate that settled before the abort keeps its real result, "so the summary stays truthful about what produced evidence."
- Non-obvious design decisions: termination covers the whole tree, not just the pnpm wrapper — POSIX signals the detached child's process group (`kill(-pid, SIGTERM)`, escalating unconditionally to `SIGKILL` after 5 s) **and** every transitive descendant read from the process table, refreshed every 5 s, because "the group kill reaps the direct child and reparents its detached descendants, making them unreachable by parent id afterwards"; Windows uses `taskkill /PID <pid> /T /F` immediately, "because a taskkill without `/F` does not terminate console processes, which is what gate commands are."
- Edge cases / failure handling: children are detached into their own POSIX process group **only** when fail-fast is enabled, so ordinary runs keep them in the host group and terminal Ctrl+C still reaches them; host `SIGINT`/`SIGTERM` on a fail-fast run is forwarded to the abort path; a tree that survives both signals holds the aggregate only while the direct child's stdio stays open, then settles with a loud `gate tree not quiescent` warning.
- Surprising: the diagnostic trade is accepted explicitly — "one push returns only the first blocking failure instead of the full failure set, so resolving several independent failures may take more push-fix rounds"; and the `windows-observational` lane deliberately omits the flag because it "is `continue-on-error` by design and exists to collect as much Windows-native evidence per run as possible."

---

### Chinese mirrors (`.zh.md`)

All 86 are faithful, equal-authority Chinese renderings of the English note of the same stem, with the identical `Status: implemented` / `Archived: <date>` header, the same `English | `[中文](…)`` switcher, the same section skeleton, and the same cross-links (with `.zh.md` targets for Chinese-side links). The archive rule in `AGENTS.md` says these are frozen; none may be edited or re-translated. Per-file specifics:

- `.agents/notes/archived/process/2026-06-11-doc-sync-enforcement.zh.md` — 问题/决策/曾考虑的替代方案/后果; 决策 opens with "两道门禁，沿用既有的 `scripts/` 风格（tsx ESM，每个脚本一项职责）" and lists `doc-typecheck` and `verify-event-taxonomy` plus the 2026-06-17 `verify-md-wrap` amendment.
- `.agents/notes/archived/process/2026-06-11-quality-gates.zh.md` — 问题/决策/后果; the 决策 enumerates max-strict TS, Oxlint, jscpd, per-file 100% coverage, publint and the NodeNext consumer typecheck; ends with the same `<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->` grandfather marker.
- `.agents/notes/archived/process/2026-06-11-tsdown-over-dumble.zh.md` — 问题/决策/曾考虑的替代方案/后果; records the same download counts (530 vs 2.5M per week) as the bus-factor argument.
- `.agents/notes/archived/process/2026-06-11-vendor-cordis-as-source.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 names the eight vendored Cordis packages and the `linkWorkspacePackages: true` setting.
- `.agents/notes/archived/process/2026-06-16-pnpm-over-yarn.zh.md` — 问题/决策/曾考虑的替代方案/后果; includes the same Yarn-vs-pnpm measurement table and the "install speed is a wash within noise" conclusion.
- `.agents/notes/archived/process/2026-06-17-ts-build-config.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 states "包内相对导入使用显式 `.ts` 说明符" and reproduces the fenced command orchestration block verbatim.
- `.agents/notes/archived/process/2026-06-18-markdown-cross-link-lint.zh.md` — 问题/决策/曾考虑的替代方案/后果; its 曾考虑的替代方案 records that anchor-level checking was deferred here and later added by the fragment-anchor decision.
- `.agents/notes/archived/process/2026-06-20-agent-note-classification.zh.md` — 问题/决策/六个类别的封闭集合/两道门禁/曾考虑的替代方案/后果; keeps the six-class table and the two gate names.
- `.agents/notes/archived/process/2026-06-20-core-data-structures-catalog.zh.md` — 问题/决策/何为「核心」/「`ts type-equiv` 机制」/维护是作者的职责/曾考虑的替代方案/验证教训/后果; the 验证教训 section restates the fail-closed scan rule.
- `.agents/notes/archived/process/2026-06-20-generated-cordis-catalog.zh.md` — 问题/决策/曾考虑的替代方案/后果; explains the `@mode` tag cross-check and the fail-closed type-link map.
- `.agents/notes/archived/process/2026-07-02-bilingual-docs-and-pairing-gate.zh.md` — 问题/决策/验证/曾考虑的替代方案/业界先例/后果; 业界先例 preserves the ant-design / arco / ShardingSphere / MDN / Vue / Kubernetes / Microsoft citations.
- `.agents/notes/archived/process/2026-07-02-tool-schema-catalog.zh.md` — 问题/决策/为何启动而非解析（核心要点）/恢复「不会静默遗漏」的保证/手动维护的启动 manifest/范围/使用普通 `json` 围栏/曾考虑的替代方案/后果; the crux section keeps the four runtime-composition examples.
- `.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.zh.md` — 问题/决策/维护模式/首批发布的索引/为什么由生成器拥有文档/完整性守卫/曾考虑的替代方案/后果; the index table lists the same ten graph surfaces.
- `.agents/notes/archived/process/2026-07-04-cordis-jsdoc-completeness-gate.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 spells out the payload-parameter rule and the `this`/`next` exemption.
- `.agents/notes/archived/process/2026-07-04-doc-tiers-and-budgets.zh.md` — 问题/决策/曾考虑的替代方案/后果; keeps the ratcheting-ceiling rule and the concrete word ceilings.
- `.agents/notes/archived/process/2026-07-04-persistence-log-catalog.zh.md` — 问题/决策/曾考虑的替代方案/后果; explains why persisted records reject an `@mode` tag.
- `.agents/notes/archived/process/2026-07-05-uniform-agent-note-format.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 points at `README.zh.md#the-file-format` and restates the "no transition period" stance.
- `.agents/notes/archived/process/2026-07-06-export-jsdoc-gate.zh.md` — 问题/决策/曾考虑的替代方案/后果; records the 203-gaps-at-adoption survey figure.
- `.agents/notes/archived/process/2026-07-06-generated-config-catalog.zh.md` — 问题/决策/曾考虑的替代方案/后果; explains the second-parameter-type rule.
- `.agents/notes/archived/process/2026-07-06-parallel-github-ci-gates.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 opens by declaring the topology historical and superseded.
- `.agents/notes/archived/process/2026-07-06-parallel-pre-push-gates.zh.md` — 问题/决策/验证/曾考虑的替代方案/后果; the 决策 names the `needs` vs `after` edge semantics and `DSH_GATE_CONCURRENCY`.
- `.agents/notes/archived/process/2026-07-10-readme-known-limitations-gate.zh.md` — 问题/决策/曾考虑的替代方案/后果; keeps the canonical English h2 heading verbatim and lists the rejected near-miss headings.
- `.agents/notes/archived/process/2026-07-12-package-model-experience-contract.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 reproduces the three H4 fields and the "Does not invalidate" definition.
- `.agents/notes/archived/process/2026-07-13-documentation-site-projection.zh.md` — 问题/决策/考虑过的替代方案/后果; explains the manifest-driven publication and the link-projection rules.
- `.agents/notes/archived/process/2026-07-14-typescript-program-backed-semantic-gates.zh.md` — 问题/决策/一个项目模型展开根项目配置/A. 事件关系由接收者类型和值类型决定/B. 带作用域的事件路由/语义缺口必须显式失败/验证/考虑过的替代方案/后果.
- `.agents/notes/archived/process/2026-07-17-run-ci-examples-from-built-lib.zh.md` — 问题/决策/解析拓扑/启动策略/曾考虑的替代方案/后果; the 决策 states "`src` 是本地开发的默认模式并使用 tsx；`lib` 是严格的 CI 模式".
- `.agents/notes/archived/process/2026-07-19-remove-generated-agent-note-index.zh.md` — 问题/决策/备选方案/影响; its 备选方案 records that regeneration is mechanical but does not prevent the merge hotspot.
- `.agents/notes/archived/process/2026-07-19-require-agent-notes-for-non-trivial-changes.zh.md` — 问题/决策/备选方案/影响; the 决策 enumerates the non-trivial categories and the consolidation/deletion rules.
- `.agents/notes/archived/process/2026-07-19-web-styling-system.zh.md` — **section headings left in English** (Problem / Decision（框架五条）/ 工程约束 / 给 agent 的执行形态 / 与 web-styling.md 的分工 / Consequences / Alternatives considered) while the body is fully Chinese; the 给 agent 的执行形态 section keeps the 12-item review-checklist framing.
- `.agents/notes/archived/process/2026-07-20-generated-cordis-core-api.zh.md` — 问题/决策/考虑过的替代方案/影响; names the five generated pages (Context, Events, Fiber, Registry, Service).
- `.agents/notes/archived/process/2026-07-20-gui-testing-system.zh.md` — **headings partly English** (Problem / Decision / 车道地图 / 防回归纪律 / Consequences / Alternatives considered); the 车道地图 section explains the Playwright-vs-vitest division of labour.
- `.agents/notes/archived/process/2026-07-21-doc-sync-through-gate-scheduler.zh.md` — 问题/决策/考虑过的替代方案/结果; the 问题 gives the measured 34 s vs 3 minutes and the missing-`docSyncLeafGates` drift.
- `.agents/notes/archived/process/2026-07-22-cordis-tutorial-docs.zh.md` — 问题/决策/考虑过的替代方案/结果; the 决策 lists the seven chapters and the "每个 transcript 都是真实的" rule.
- `.agents/notes/archived/process/2026-07-22-evidence-based-larger-hosted-runners.zh.md` — 问题/决策/曾考虑的替代方案/后果; reproduces both measured core-count tables and the 96-core trace dissection.
- `.agents/notes/archived/process/2026-07-22-fast-local-git-hooks.zh.md` — 问题/决策/取代关系/考虑过的替代方案/结果; the 取代关系 section names the two superseded notes explicitly.
- `.agents/notes/archived/process/2026-07-22-installer-in-repo-skip-clone.zh.md` — 问题/决策/备选方案/影响; the 决策 explains the `$0` detection and the `DSH_SOURCE` precedence.
- `.agents/notes/archived/process/2026-07-22-product-first-root-readme.zh.md` — 问题/决策/考虑过的替代方案/结果; keeps the two launch paths and the community-link split.
- `.agents/notes/archived/process/2026-07-22-tsconfig-solution-root-two-aggregates.zh.md` — 问题/决策/考虑过的替代方案/后果; reproduces the five-row tsconfig table and the declaration-merge collision principle.
- `.agents/notes/archived/process/2026-07-23-browser-demo-gif-recording.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 states frames go to `.playwright-mcp/` and the recording stops at the verified local path.
- `.agents/notes/archived/process/2026-07-23-personal-staging-maintenance-skills.zh.md` — 问题/决策/备选方案/影响; the 决策 details the timestamped sibling clone, the single atomic launcher cutover and the rollback retention.
- `.agents/notes/archived/process/2026-07-23-portable-required-pull-request-ci.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 explains why the gate-less aggregate shares the enterprise pool.
- `.agents/notes/archived/process/2026-07-23-translation-prompt-v4-contract.zh.md` — 问题/决策/响应封装格式/考虑过的替代方案/影响; 响应封装格式 documents the one-backslash delimiter escape round-trip.
- `.agents/notes/archived/process/2026-07-26-briefed-minimal-translation-updates.zh.md` — 问题/决策/基准测试/曾考虑的替代方案/后果/测试; the 基准测试 section reproduces the ten-example replay and the 276k-vs-595k token medians.
- `.agents/notes/archived/process/2026-07-26-gui-pr-gif-evidence-and-assets-branch.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 names the append-only assets branches and the `?raw=true` requirement.
- `.agents/notes/archived/process/2026-07-26-incremental-pr-base-retargeting.zh.md` — 问题/决策/曾考虑的替代方案/后果; states the merge-checkpoint rule and that a checkpoint is never abandoned.
- `.agents/notes/archived/process/2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 lists the three cache shapes and the `corepack pnpm` Windows exception.
- `.agents/notes/archived/process/2026-07-26-web-syntax-highlighting-shiki.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 keeps the `Map`-not-object alias-table rule and the pre-warm timing.
- `.agents/notes/archived/process/2026-07-27-dependabot-version-updates.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 states the 30-day cooldown and the `vendor/**` exclusion.
- `.agents/notes/archived/process/2026-07-27-explicit-change-scope-report.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 lists the four path sets and the strict-UTF-8/NUL-split rule.
- `.agents/notes/archived/process/2026-07-27-wine-windows-gates-experiment.zh.md` — 问题/决策/实测结果/考虑过的替代方案/后果; 实测结果 gives the 2m46s figure against 7–9 minutes.
- `.agents/notes/archived/process/2026-07-28-per-subsystem-cordis-surface-regions.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 states that the same English region bytes are written into both language sides.
- `.agents/notes/archived/process/2026-07-29-oxlint-linter.zh.md` — 问题/决策/验证/考虑过的替代方案/结果; 验证 reproduces the 88/87/83 rule-count audit and the 61 s → 8 s measurement.
- `.agents/notes/archived/process/2026-07-30-cordis-config-source-plane-resolution-gate.zh.md` — 问题/决策/备选方案/结果; the 决策 names `validateSourcePlaneResolution` and the `.d.ts`-hit failure.
- `.agents/notes/archived/process/2026-07-30-independent-ci-consumer-build.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 问题 quotes the 8m01s + 10m34s failover queue measurements.
- `.agents/notes/archived/process/2026-07-31-coverage-exempt-heavy-suites.zh.md` — **headings partly English** (Problem / Decision / 豁免名单与逐项对账 / 成员资格约定 / 门禁自动守卫名单正确性 / Alternatives considered / Verification / Consequences); the roster table is reproduced in Chinese.
- `.agents/notes/archived/process/2026-07-31-installer-adopts-existing-checkout.zh.md` — **headings all English** (Problem / Decision / Alternatives considered / Consequences / Testing); the body explains the `resolve_dir` physical-path comparison.
- `.agents/notes/archived/process/2026-08-03-package-anchored-subsystem-pages.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 states the surviving placement heuristic and the `GROUPS_WITHOUT_SUBSYSTEM_PAGE` list.
- `.agents/notes/archived/process/2026-08-04-forward-only-pr-issue-status.zh.md` — 问题/决策/验证/考虑过的替代方案/后果; the 决策 gives the five-status order and the monotonicity rule.
- `.agents/notes/archived/process/2026-08-06-coverage-uncovered-locations.zh.md` — 问题/决策/考虑过的替代方案/验证/后果; the 决策 names the custom istanbul reporter and the `<path>:<line>:<col> uncovered <kind>` record format.
- `.agents/notes/archived/process/2026-08-06-doc-site-carries-its-images.zh.md` — 问题/决策/考虑过的替代方案/后果/测试; the 决策 names `placeImage(absPath)` and the "repository visibility can no longer reach the published page" rule.
- `.agents/notes/archived/process/2026-08-06-in-repository-landlock-release.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 names the three organization-owned packages and the `workspace:*` consumer declaration.
- `.agents/notes/archived/process/2026-08-08-api-remotes-generated-contract-build.zh.md` — 问题/决策/唯一的 package 特例/Typert 与 tsdown/考虑过的替代方案/后果; the 决策 reproduces the five-line ordered build block.
- `.agents/notes/archived/process/2026-08-08-automatic-translation-pairing-merges.zh.md` — 问题/决策/失败约定/验证/考虑过的替代方案/后果; 失败约定 preserves the five-row failure table (as prose rather than the English table).
- `.agents/notes/archived/process/2026-08-08-browser-gif-evidence-chain.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 lists the fresh `DSH_HOME`/`DSH_AGENTS_HOME`/workspace/session/browser-state roots per run.
- `.agents/notes/archived/process/2026-08-08-lightweight-routine-documentation-translation.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 states "日常翻译是一次完成、一遍通过" and names the two products' manual-only invocation metadata.
- `.agents/notes/archived/process/2026-08-08-review-driven-issue-lifecycle-triggers.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 names the two retained PR events and the policy workflow that keeps `ready_for_review`.
- `.agents/notes/archived/process/2026-08-09-chinese-contract-terminology.zh.md` — 问题/决策/考虑过的替代方案/后果/验证; the 决策 states `contract` → 约定 and `adapter contract` → 适配器约定（adapter contract）.
- `.agents/notes/archived/process/2026-08-09-committed-artifact-citations.zh.md` — 问题/决策/曾考虑的替代方案/验证/后果; the 问题 lists the `packages/client` audit findings in Chinese.
- `.agents/notes/archived/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 states the spoken-language check and the `contract`/`boundary`/`shape` usage test.
- `.agents/notes/archived/process/2026-08-09-md-fragment-anchor-gate.zh.md` — 问题/决策/验证/曾考虑的替代方案/后果; the 决策 states that slugs come from rendered heading text via `markdownHeadingLines`.
- `.agents/notes/archived/process/2026-08-09-oxlint-only-fix-workflow.zh.md` — 问题/决策/验证/考虑过的替代方案/结果; the 决策 describes the one-retry fix protocol and the 64 MiB output buffer.
- `.agents/notes/archived/process/2026-08-10-vendor-package-rescope.zh.md` — 问题/决定/影响/考虑过的替代方案; the 影响 section names `scripts/rescope-vendor.ts` and its `--check` mode.
- `.agents/notes/archived/process/2026-08-11-python-publication-workflow.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 explains the `publish=false` credential-free rehearsal and the Trusted Publishing identity.
- `.agents/notes/archived/process/2026-08-12-documentation-site-navigation-and-chrome.zh.md` — 问题/决定/考虑过的替代方案/影响; the 考虑过的替代方案 records the built-and-reverted Chinese search tokenizer and the `new Function` empty-scope trap.
- `.agents/notes/archived/process/2026-08-12-face-named-client-test-files.zh.md` — 问题/决策/本次改名清单/考虑过的替代方案/后果; the 改名清单 lists the 232/5/4 renames and the 2 snapshot files.
- `.agents/notes/archived/process/2026-08-13-public-vendor-and-native-sequences.zh.md` — **headings all English** (Problem / Decision / Alternatives considered / Consequences) with Chinese body text and the three-sequence access table.
- `.agents/notes/archived/process/2026-08-13-published-document-fragments.zh.md` — **headings all English** (Problem / Decision / Alternatives considered / Consequences); the body states the post-build `verify-doc-site-fragments` rule.
- `.agents/notes/archived/process/2026-08-17-readme-assets-on-cdn.zh.md` — 问题/决策/曾考虑的替代方案/后果; the 决策 names the three-file allowlist and the `Cache-Control: no-store` header.
- `.agents/notes/archived/process/2026-08-18-in-job-partitioned-coverage.zh.md` — 问题/决策/失败与输出语义/验证/曾考虑的替代方案/后果; 失败与输出语义 documents the bounded 64 KiB per-child tail.
- `.agents/notes/archived/process/2026-08-18-localized-bilingual-links.zh.md` — **headings all English** (Problem / Decision / Verification / Alternatives considered / Consequences); the body states the locale-following rule and the wrong-locale diagnostic.
- `.agents/notes/archived/process/2026-08-19-remove-knip.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 lists the narrower replacement checks that remain.
- `.agents/notes/archived/process/2026-08-20-doc-site-raw-markdown-twins.zh.md` — **headings all English** (Problem / Decision / Alternatives considered / Consequences); the body explains the one-projection/two-trees property and the index-route alias twin.
- `.agents/notes/archived/process/2026-08-21-documentation-site-tag-release.zh.md` — **headings all English** (Problem / Decision / Alternatives considered / Consequences); the body states that the public site is reachable without authentication despite a private repository.
- `.agents/notes/archived/process/2026-08-23-client-cross-package-value-dependencies.zh.md` — 问题/决策/考虑过的替代方案/后果; the 决策 reproduces the seven-row classification table.
- `.agents/notes/archived/process/2026-08-27-explicit-workspace-path-aliases.zh.md` — **H1 and all headings left in English** ("Explicit workspace path aliases replace per-group wildcards") with a fully Chinese body; the body carries the 934.6 ms / 60,942 failed-resolutions measurement and the 51% boot-time result.
- `.agents/notes/archived/process/2026-08-27-gate-runner-fail-fast.zh.md` — 问题/决策/结果/备选方案; the 决策 states the `skipped` recording rule and that a trapped signal exiting zero is never recorded as passed.

---

### Bilingual-pair sidecars (`.i18n.yaml`)

All 86 are 5–6 line files of the same shape: a 3-line comment block naming the consistency-record contract and the re-record command, then two `path: <git blob sha1>` lines, one per side. The comment's command is the *scoped* form `pnpm run verify-translation-pairing --write <path>`; the recorded hashes are the git blob SHA-1 of the last confirmed-consistent bytes of each side. I recomputed the git blob hash of `2026-08-27-gate-runner-fail-fast.md` from the file bytes and it matched the recorded value exactly. The comment line is not uniform: 66 name the current `.agents/notes/archived/process/…` path, **15 carry the bare** `pnpm run verify-translation-pairing --write` (no path), and **5 still name the pre-archive path** `.agents/notes/implemented/process/…` — a residue of the archival re-record that did not update the command comment. Per-file specifics (the pair each records):

- `.agents/notes/archived/process/2026-06-11-doc-sync-enforcement.i18n.yaml` — bare `--write` command; records `00fc6e90…` (en) / `9daaf886…` (zh) for the doc-sync enforcement pair.
- `.agents/notes/archived/process/2026-06-11-quality-gates.i18n.yaml` — scoped archived path; `f49d3776…` / `f80406f9…`.
- `.agents/notes/archived/process/2026-06-11-tsdown-over-dumble.i18n.yaml` — bare `--write`; `b622fd41…` / `2200cb8c…`.
- `.agents/notes/archived/process/2026-06-11-vendor-cordis-as-source.i18n.yaml` — scoped archived path; `9736c64e…` / `d4fdb810…`.
- `.agents/notes/archived/process/2026-06-16-pnpm-over-yarn.i18n.yaml` — scoped archived path; `f27856dd…` / `d2736e98…`.
- `.agents/notes/archived/process/2026-06-17-ts-build-config.i18n.yaml` — scoped archived path; `9e823575…` / `a735a795…`.
- `.agents/notes/archived/process/2026-06-18-markdown-cross-link-lint.i18n.yaml` — scoped archived path; `cc3c752f…` / `37ec469b…`.
- `.agents/notes/archived/process/2026-06-20-agent-note-classification.i18n.yaml` — scoped archived path; `41304e1d…` / `c0463499…`.
- `.agents/notes/archived/process/2026-06-20-core-data-structures-catalog.i18n.yaml` — scoped archived path; `37c63bbf…` / `b1741710…`.
- `.agents/notes/archived/process/2026-06-20-generated-cordis-catalog.i18n.yaml` — scoped archived path; `8d013a5b…` / `2550bc80…`.
- `.agents/notes/archived/process/2026-07-02-bilingual-docs-and-pairing-gate.i18n.yaml` — scoped archived path; `b6a93dcd…` / `7e0f5f6c…` (the note that defines this file format).
- `.agents/notes/archived/process/2026-07-02-tool-schema-catalog.i18n.yaml` — scoped archived path; `c9dab8f8…` / `89d8e6f3…`.
- `.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.i18n.yaml` — bare `--write`; `6f2949e3…` / `731ae8a9…`.
- `.agents/notes/archived/process/2026-07-04-cordis-jsdoc-completeness-gate.i18n.yaml` — bare `--write`; `4b033ab5…` / `f1c1c997…`.
- `.agents/notes/archived/process/2026-07-04-doc-tiers-and-budgets.i18n.yaml` — scoped archived path; `9281990a…` / `4cd13ce3…`.
- `.agents/notes/archived/process/2026-07-04-persistence-log-catalog.i18n.yaml` — bare `--write`; `f000b41c…` / `58680e56…`.
- `.agents/notes/archived/process/2026-07-05-uniform-agent-note-format.i18n.yaml` — scoped archived path; `34122096…` / `9a4d67b6…`.
- `.agents/notes/archived/process/2026-07-06-export-jsdoc-gate.i18n.yaml` — scoped archived path; `309236a0…` / `4d69037c…`.
- `.agents/notes/archived/process/2026-07-06-generated-config-catalog.i18n.yaml` — bare `--write`; `b7c69f21…` / `59d632df…`.
- `.agents/notes/archived/process/2026-07-06-parallel-github-ci-gates.i18n.yaml` — bare `--write`; `0a621e0c…` / `340e5301…`.
- `.agents/notes/archived/process/2026-07-06-parallel-pre-push-gates.i18n.yaml` — scoped archived path; `ef60e7d1…` / `67c0a3ba…`.
- `.agents/notes/archived/process/2026-07-10-readme-known-limitations-gate.i18n.yaml` — scoped archived path; `69c037e6…` / `1b323736…`.
- `.agents/notes/archived/process/2026-07-12-package-model-experience-contract.i18n.yaml` — scoped archived path; `baa590cb…` / `79d000d4…`.
- `.agents/notes/archived/process/2026-07-13-documentation-site-projection.i18n.yaml` — scoped archived path; `fdad8559…` / `756ec231…`.
- `.agents/notes/archived/process/2026-07-14-typescript-program-backed-semantic-gates.i18n.yaml` — scoped archived path; `412cb801…` / `450e0682…`.
- `.agents/notes/archived/process/2026-07-17-run-ci-examples-from-built-lib.i18n.yaml` — bare `--write`; `3063bdcc…` / `b70367c1…`.
- `.agents/notes/archived/process/2026-07-19-remove-generated-agent-note-index.i18n.yaml` — scoped archived path; `c8c94358…` / `8e474536…`.
- `.agents/notes/archived/process/2026-07-19-require-agent-notes-for-non-trivial-changes.i18n.yaml` — scoped archived path; `47b922f6…` / `cb96f1f5…`.
- `.agents/notes/archived/process/2026-07-19-web-styling-system.i18n.yaml` — scoped archived path; `348c1813…` / `86c5731b…`.
- `.agents/notes/archived/process/2026-07-20-generated-cordis-core-api.i18n.yaml` — bare `--write`; `b6a66e51…` / `82dbb308…`.
- `.agents/notes/archived/process/2026-07-20-gui-testing-system.i18n.yaml` — scoped archived path; `07c4e948…` / `f41b9249…`.
- `.agents/notes/archived/process/2026-07-21-doc-sync-through-gate-scheduler.i18n.yaml` — bare `--write`; `ba7eeb75…` / `7723a409…`.
- `.agents/notes/archived/process/2026-07-22-cordis-tutorial-docs.i18n.yaml` — bare `--write`; `a882f3f5…` / `4caf03ee…`.
- `.agents/notes/archived/process/2026-07-22-evidence-based-larger-hosted-runners.i18n.yaml` — scoped archived path; `1862f249…` / `4a403a80…`.
- `.agents/notes/archived/process/2026-07-22-fast-local-git-hooks.i18n.yaml` — scoped archived path; `b13708a9…` / `9f7f872c…`.
- `.agents/notes/archived/process/2026-07-22-installer-in-repo-skip-clone.i18n.yaml` — bare `--write`; `607ce3ba…` / `17260427…`.
- `.agents/notes/archived/process/2026-07-22-product-first-root-readme.i18n.yaml` — scoped archived path; `04033438…` / `114fa948…`.
- `.agents/notes/archived/process/2026-07-22-tsconfig-solution-root-two-aggregates.i18n.yaml` — scoped archived path; `40e2f8c8…` / `2dd3dcc6…`.
- `.agents/notes/archived/process/2026-07-23-browser-demo-gif-recording.i18n.yaml` — bare `--write`; `844e976c…` / `12702daa…`.
- `.agents/notes/archived/process/2026-07-23-personal-staging-maintenance-skills.i18n.yaml` — **stale path**: still names `.agents/notes/implemented/process/…`; `86654be1…` / `7593a2e8…`.
- `.agents/notes/archived/process/2026-07-23-portable-required-pull-request-ci.i18n.yaml` — scoped archived path; `e3995d16…` / `4fa1a798…`.
- `.agents/notes/archived/process/2026-07-23-translation-prompt-v4-contract.i18n.yaml` — scoped archived path; `bca5b37e…` / `fd1edff0…`.
- `.agents/notes/archived/process/2026-07-26-briefed-minimal-translation-updates.i18n.yaml` — scoped archived path; `b2aa0727…` / `9c86a825…`.
- `.agents/notes/archived/process/2026-07-26-gui-pr-gif-evidence-and-assets-branch.i18n.yaml` — bare `--write`; `18e56e44…` / `945dd7a0…`.
- `.agents/notes/archived/process/2026-07-26-incremental-pr-base-retargeting.i18n.yaml` — scoped archived path; `dadea45f…` / `2bcc9c17…`.
- `.agents/notes/archived/process/2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.i18n.yaml` — scoped archived path; `777ad5f2…` / `4ede3455…`.
- `.agents/notes/archived/process/2026-07-26-web-syntax-highlighting-shiki.i18n.yaml` — scoped archived path; `25e895e7…` / `77913e87…`.
- `.agents/notes/archived/process/2026-07-27-dependabot-version-updates.i18n.yaml` — scoped archived path; `8b8cb08b…` / `6a30cd7a…`.
- `.agents/notes/archived/process/2026-07-27-explicit-change-scope-report.i18n.yaml` — scoped archived path; `9aa7ab9c…` / `6c6a78a4…`.
- `.agents/notes/archived/process/2026-07-27-wine-windows-gates-experiment.i18n.yaml` — **stale path** (still `implemented/process`); `ce2ad1ad…` / `a0a5e8e7…`.
- `.agents/notes/archived/process/2026-07-28-per-subsystem-cordis-surface-regions.i18n.yaml` — scoped archived path; `3d1065b9…` / `bd934fde…`.
- `.agents/notes/archived/process/2026-07-29-oxlint-linter.i18n.yaml` — scoped archived path; `882ee9a4…` / `16eab946…`.
- `.agents/notes/archived/process/2026-07-30-cordis-config-source-plane-resolution-gate.i18n.yaml` — scoped archived path; `038ecdd4…` / `ca6324a4…`.
- `.agents/notes/archived/process/2026-07-30-independent-ci-consumer-build.i18n.yaml` — scoped archived path; `28fb8706…` / `1ebd4dab…`.
- `.agents/notes/archived/process/2026-07-31-coverage-exempt-heavy-suites.i18n.yaml` — scoped archived path; `a175623e…` / `c08dcd17…`.
- `.agents/notes/archived/process/2026-07-31-installer-adopts-existing-checkout.i18n.yaml` — **stale path** (still `implemented/process`); `08eec47a…` / `dc3cc5ee…`.
- `.agents/notes/archived/process/2026-08-03-package-anchored-subsystem-pages.i18n.yaml` — scoped archived path; `eab569b7…` / `61b648c4…`.
- `.agents/notes/archived/process/2026-08-04-forward-only-pr-issue-status.i18n.yaml` — **stale path** (still `implemented/process`); `56004a39…` / `ee853198…`.
- `.agents/notes/archived/process/2026-08-06-coverage-uncovered-locations.i18n.yaml` — scoped archived path; `a93793b4…` / `c4333bfc…`.
- `.agents/notes/archived/process/2026-08-06-doc-site-carries-its-images.i18n.yaml` — scoped archived path; `039f4aab…` / `170d721c…`.
- `.agents/notes/archived/process/2026-08-06-in-repository-landlock-release.i18n.yaml` — scoped archived path; `c71c7b4c…` / `d902a801…`.
- `.agents/notes/archived/process/2026-08-08-api-remotes-generated-contract-build.i18n.yaml` — scoped archived path; `c34b25a9…` / `73fa9992…`.
- `.agents/notes/archived/process/2026-08-08-automatic-translation-pairing-merges.i18n.yaml` — scoped archived path; `ed693e37…` / `827475a9…`.
- `.agents/notes/archived/process/2026-08-08-browser-gif-evidence-chain.i18n.yaml` — scoped archived path; `e85c05ef…` / `bc2d11f0…`.
- `.agents/notes/archived/process/2026-08-08-lightweight-routine-documentation-translation.i18n.yaml` — scoped archived path; `9c1037d2…` / `76cbc10f…`.
- `.agents/notes/archived/process/2026-08-08-review-driven-issue-lifecycle-triggers.i18n.yaml` — **stale path** (still `implemented/process`); `44492796…` / `6e00e2a9…`.
- `.agents/notes/archived/process/2026-08-09-chinese-contract-terminology.i18n.yaml` — scoped archived path; `9cccebf2…` / `3c19b0b7…`.
- `.agents/notes/archived/process/2026-08-09-committed-artifact-citations.i18n.yaml` — scoped archived path; `cc7483ac…` / `1d19250e…`.
- `.agents/notes/archived/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.i18n.yaml` — scoped archived path; `26075efb…` / `1904a357…`.
- `.agents/notes/archived/process/2026-08-09-md-fragment-anchor-gate.i18n.yaml` — scoped archived path; `7f6ac3f2…` / `5bf52eb2…`.
- `.agents/notes/archived/process/2026-08-09-oxlint-only-fix-workflow.i18n.yaml` — scoped archived path; `482c823e…` / `e9e8bf01…`.
- `.agents/notes/archived/process/2026-08-10-vendor-package-rescope.i18n.yaml` — scoped archived path; `7cbbf89d…` / `1b57305b…`.
- `.agents/notes/archived/process/2026-08-11-python-publication-workflow.i18n.yaml` — scoped archived path; `eb17d5bc…` / `85e261bf…`.
- `.agents/notes/archived/process/2026-08-12-documentation-site-navigation-and-chrome.i18n.yaml` — bare `--write`; `f33f017d…` / `7f3ff5c8…`.
- `.agents/notes/archived/process/2026-08-12-face-named-client-test-files.i18n.yaml` — scoped archived path; `66a1def1…` / `ddb2b347…`.
- `.agents/notes/archived/process/2026-08-13-public-vendor-and-native-sequences.i18n.yaml` — scoped archived path; `c9f050ef…` / `6578fa9f…`.
- `.agents/notes/archived/process/2026-08-13-published-document-fragments.i18n.yaml` — scoped archived path; `53d40697…` / `dc1cfe60…`.
- `.agents/notes/archived/process/2026-08-17-readme-assets-on-cdn.i18n.yaml` — scoped archived path; `49a4620c…` / `f890284d…`.
- `.agents/notes/archived/process/2026-08-18-in-job-partitioned-coverage.i18n.yaml` — scoped archived path; `f2e531a8…` / `39425a37…`.
- `.agents/notes/archived/process/2026-08-18-localized-bilingual-links.i18n.yaml` — scoped archived path; `44283f59…` / `bb45bf3f…`.
- `.agents/notes/archived/process/2026-08-19-remove-knip.i18n.yaml` — scoped archived path; `d385e729…` / `5decd988…`.
- `.agents/notes/archived/process/2026-08-20-doc-site-raw-markdown-twins.i18n.yaml` — scoped archived path; `610cda8f…` / `c7d01fce…`.
- `.agents/notes/archived/process/2026-08-21-documentation-site-tag-release.i18n.yaml` — scoped archived path; `a6658b59…` / `d5f7d64a…`.
- `.agents/notes/archived/process/2026-08-23-client-cross-package-value-dependencies.i18n.yaml` — scoped archived path; `fcc773e2…` / `f23244be…`.
- `.agents/notes/archived/process/2026-08-27-explicit-workspace-path-aliases.i18n.yaml` — scoped archived path; `7b31c4d5…` / `dd82b3b0…`.
- `.agents/notes/archived/process/2026-08-27-gate-runner-fail-fast.i18n.yaml` — scoped archived path; `504929b2…` / `1d9f49ad…` (I recomputed the English blob hash from the file bytes and it matched `504929b2…`).

## Ideas worth stealing

- **A sidecar holding the git blob hash of BOTH sides of a bilingual pair turns "did these drift?" into a pure content comparison** — `.agents/notes/archived/process/2026-07-02-bilingual-docs-and-pairing-gate.md:15` — the hash is computable for files edited in the same PR, which a commit-hash record is not, and the blob-hash primitive doubles as the recovery mechanism (the last-confirmed text of either side). For August: put a `*.i18n.yaml`-style sidecar next to every bilingual prompt/doc and make the pairing gate the only thing allowed to bless a pair.
- **Read the shipped artifact, not a re-derivation of it — and keep a completeness guard when you do** — `.agents/notes/archived/process/2026-07-02-tool-schema-catalog.md:18` and `:29` — tool schemas are *not statically knowable* (runtime spreads, string concatenation, config-chosen names, raw `ctx.tools.register()`), so a source-parsing catalog "would lie"; the fix is to boot the plugin and read the registry, and because booting loses the declaration set, add a filesystem-discovered completeness guard that hard-errors when a new package is unregistered. For August: any doc/eval generator over August's tool surface must read the live `toolDefinitions`/schema registry, never the source.
- **Per-package disclosure of the model's token and KV-cache effect** — `.agents/notes/archived/process/2026-07-12-package-model-experience-contract.md:16` — each package documents "What the model sees / Token effect / KV Cache effect" per context surface, and "Does not invalidate" is defined as "the package preserves an already-reusable prefix, not that a provider promises a cache hit". For August: this is the missing contract for the frozen per-session boot memory index and for prefix-stability guarantees — name the package that owns the prefix and say whether it appends, replaces, or invalidates.
- **Fail-fast a red gate aggregate, but record killed gates as `skipped`, never `passed`** — `.agents/notes/archived/process/2026-08-27-gate-runner-fail-fast.md:18` — a child that traps SIGTERM and exits 0 "carries the abort mark and is recorded `skipped`, never passed", and the tree kill must reach detached grandchildren (process-group kill plus a refreshed descendant list on POSIX; `taskkill /T /F` on Windows). For August: the same invariant applies to any cancellation path in the agent loop — a cancelled subagent must never read as success.
- **Gate the SOURCE plane, not just the artifact plane** — `.agents/notes/archived/process/2026-07-30-cordis-config-source-plane-resolution-gate.md:14` — a configured specifier that resolves only through built `lib/` is invisible in a dev tree with a stale build and only crashes on a clean checkout; the gate resolves every configured specifier through the tsconfig `paths` facade and fails on a `.d.ts` hit. For August: the equivalent is a static check that every configured plugin/provider resolves to source, because "every environment with a built `lib/` booted fine" is exactly how the bug shipped.
- **Mechanical gates over prose, with the cost argument stated** — `.agents/notes/archived/process/2026-06-11-quality-gates.md:12` — "Agents follow enforced gates far more reliably than prose conventions, and 'a lot of work' is not a cost argument when agents do the labor." For August: AGENTS.md is 68 KB of prose; this is the licence to convert its checkable clauses into commands.
- **A ratcheting word-budget ceiling** — `.agents/notes/archived/process/2026-07-04-doc-tiers-and-budgets.md:18` — a doc at or below target keeps ≥5% headroom as its ceiling ratchets down; a doc above target gets a frozen ceiling so it cannot grow until it reaches target. For August: the mechanical way to stop AGENTS.md accretion, and it forces the *relocation* decision at the moment content is added.
- **One leaf list, one scheduler, no chained `&&`** — `.agents/notes/archived/process/2026-07-21-doc-sync-through-gate-scheduler.md:10` and `:14` — 24 `pnpm run` subcommands cost 24 wrapper starts (34 s of work became 3 minutes), and a gate added to the chain but not to `docSyncLeafGates` "meant CI never enforced that catalog's freshness". For August: make the `check:*` gate list a single source of truth so a new gate cannot be added to CI but missed locally.
- **A `needs` edge requires the predecessor to pass; an `after` edge waits for any terminal outcome** — `.agents/notes/archived/process/2026-07-06-parallel-pre-push-gates.md:16` — a two-word distinction that makes a gate graph express "must pass" versus "must finish", plus `allowFailure` for gates that report but do not fail the aggregate. For August: the same three primitives are enough to describe subagent/tool parallelism safely.
- **Use a `Map`, not an object, for any lookup keyed by model-authored text** — `.agents/notes/archived/process/2026-07-26-web-syntax-highlighting-shiki.md:19` — "fence info strings are assistant-authored, so a label like `constructor` must miss instead of resolving an inherited property and crashing shiki." For August: every map from model-emitted strings (tool names, language tags, MIME types) needs this, and the same class of bug is a prototype-pollution vector.
- **The threshold is the roster's own guard** — `.agents/notes/archived/process/2026-07-31-coverage-exempt-heavy-suites.md:45` — if an exempt suite in fact solely covers some measured file, the instrumented gate goes red on the spot, and the converse holds too. For August: prefer an exemption list that the surviving gate polices over one that a human must maintain.
- **TypeScript Program + TypeChecker as the source of gate facts, with a demand-driven index whose proof affects cost and never results** — `.agents/notes/archived/process/2026-07-14-typescript-program-backed-semantic-gates.md:34` — calls are classified by assignability to the real `Context` type, and the locality proof for a helper ("a helper that is non-exported, sits in a real ES module, and whose every same-file reference is a direct callee has all of its calls in that file by module scoping") falls back to the unchanged original semantics when unproven. For August: any static check over a plugin system should use the type checker, not receiver-name heuristics.
- **A scope ladder for incremental updates, and the measurement that whole-document regeneration is HARMFUL** — `.agents/notes/archived/process/2026-07-26-briefed-minimal-translation-updates.md:16` and `:25` — code-fence-only changes are computed outright, then changed units, then sections, then whole document, and the benchmark found re-translation "confirmed harmful, not merely wasteful: judged preservation collapsed (4.4/10 vs 9.8) because it discards reviewed phrasing". For August: prompt and tool-description edits must be *patched* against their last-confirmed bytes, never regenerated.
- **A brief-scoped update path beats loading the whole corpus — and a small model does the work at parity** — `.agents/notes/archived/process/2026-07-26-briefed-minimal-translation-updates.md:24` — the briefed path matched the status quo on quality at roughly a third of the tokens and wall clock, and "a small model performed at parity with the large one, so the update path no longer assumes a frontier translator." For August: the harness's own prompt-maintenance loop can run on a cheap model if the input is scoped to the diff.
- **Make the heavy path manual-only, and keep the cheap path in the standing instructions** — `.agents/notes/archived/process/2026-08-08-lightweight-routine-documentation-translation.md:14` — routine translation is one shot in one pass with the terminology table loaded; the heavier skill is `disable-model-invocation: true` / `policy.allow_implicit_invocation: false`, and "the user, not the agent, chooses when the extended path is worth its cost". For August: the same split applies to any expensive maintenance skill — a cheap default in the instructions, an opt-in heavy path.
- **Dark mode lives only in the token table; components have zero theme selectors** — `.agents/notes/archived/process/2026-07-19-web-styling-system.md:24` — and dynamic styles go through the CSS variable bridge (JS writes only variables, rules stay in CSS), `:31`. For August's Tauri UI: this removes conditional branches from component code entirely.
- **A 12-item review checklist shared by the author and the reviewer, where each item is a decidable "see X, reject"** — `.agents/notes/archived/process/2026-07-19-web-styling-system.md:36` — not a style suggestion, and writing and reviewing use the same table. For August: the same shape works for a code-review checklist the agent self-checks against.
- **Serve the docs to agents as raw Markdown plus an `llms.txt`, from one projection** — `.agents/notes/archived/process/2026-08-20-doc-site-raw-markdown-twins.md:16` and `:22` — one projection serves both trees because its links are relative, and every route also gets an alias twin for index pages (a copy would carry its relative links one directory too high). For August: an agent-facing `llms.txt` over the August docs is a small, high-leverage addition.
- **A change-scope report that never guesses a base, never fetches, and never selects tests** — `.agents/notes/archived/process/2026-07-27-explicit-change-scope-report.md:20` — it requires `--base`, resolves it with ambiguity detection, and reports committed / staged / unstaged / untracked path sets as sorted lists, so "an incorrect base is possible but visible". For August: the same command shape gives the pre-push and code-review workflows one deterministic account of scope.
- **Measure complete-job time, not gate time** — `.agents/notes/archived/process/2026-07-22-evidence-based-larger-hosted-runners.md:46` — one run spent 69 s in a job of which only 39 s was repository gates, and the Windows pnpm cache spent 27 s extracting 154 MB; "a future larger-runner rollout therefore needs complete-job measurements rather than gate-only timing." For August: budget the whole agent turn, not just the model call.
- **Coverage failures that name the exact uncovered statement, branch and function** — `.agents/notes/archived/process/2026-08-06-coverage-uncovered-locations.md:14` — a custom istanbul reporter emitting `<path>:<line>:<col> uncovered <kind>`, wired at the single coverage configuration point so it takes effect at every entry point. For August: an agent reading a red test run should get clickable locations, not a file name.
- **A shadow registry beats a rename: rename by a script that is idempotent and checkable, and keep the reverse mapping** — `.agents/notes/archived/process/2026-08-10-vendor-package-rescope.md:42` (and the two invisible classes at `:30`) — property access and constants carrying the name *as data* cannot be caught by a token rule, and the script's `--check` mode asserts "no residue, every exact edit landed, and idempotency". For August: any bulk rename in the harness must be a script with a `--check`, not a find-and-replace.
- **Publish the public surface from a release tag, not from master** — `.agents/notes/archived/process/2026-08-21-documentation-site-tag-release.md:14` — the doc site deployed on every master push while every other public surface advanced only at a release tag, and "a merge published documentation to the internet within minutes — including pages describing work that no released artifact contained". For August: any public artifact (docs, site, downloads) should advance with the release.
- **Durable prose may cite only committed artifacts** — `.agents/notes/archived/process/2026-08-09-committed-artifact-citations.md:14` — no design-session ordinals, no `(decision 21)`, no `§4.7` into an uncommitted draft; fixed regressions are pinned as present-tense counterfactuals. For August: AGENTS.md cites harness behaviour constantly; ordinal citations are the ones that rot silently.
- **A required decision record for every non-trivial change, with a gate on its in-file format** — `.agents/notes/archived/process/2026-07-19-require-agent-notes-for-non-trivial-changes.md:14` and `2026-07-05-uniform-agent-note-format.md:14` — the boundary is by *category* (behaviour, architecture, cross-package contracts, formats, process), not by judgement, and the format gate makes "a lifecycle move that skips its rewrite now fail CI instead of review memory". For August: a compact, gate-checked decision log is the cheapest way to keep a long-lived harness's rationale.
- **Resolve fragments against the *rendered* heading text, and cache anchor sets lazily** — `.agents/notes/archived/process/2026-08-09-md-fragment-anchor-gate.md:14` — GitHub slugs are computed from rendered text (so inline code and links inside a heading slug as GitHub renders them), repeated slugs get the occupied-set suffixes, and anchor sets are collected lazily so links *into* archived and vendored docs are validated without making those files sources. For August: a doc-link gate is cheap and catches a decay class nothing else sees.
- **Pick the runner size from measurements, and let the scheduler — not the core count — be the bottleneck** — `.agents/notes/archived/process/2026-08-27-explicit-workspace-path-aliases.md:12` and `:58` — 60,942 failed resolutions cost 934.6 ms (35% of a boot) purely because a wildcard alias tried 49 candidates in order; replacing them with one explicit alias per package cut boot time 51%. For August: any multi-candidate resolution (provider base URLs, plugin ids, model aliases) has a cost proportional to candidate count and position.

## Files skipped (with reasons)

- `.agents/notes/archived/manifest.json` — **read, not skipped**: I opened it, parsed its shape (`version` + `files` map), counted its 2,772 entries across six kind directories, and recomputed the SHA-256 of 12 of its entries to confirm the seal matches the current bytes. It is a generated registry of 385 KB / 2,777 lines, so I did not read it line by line — the entry list is a digest map with no prose, and the per-file information it carries is exactly the hash I verified.
- No file in this shard was skipped unread. Every one of the 260 files was opened. The two "bulk" reads — the 86 English notes and the 86 Chinese mirrors — were read in full for the English side and, for the Chinese side, via a complete structural pass (H1, `Status:`/`Archived:` metadata, every `##`/`###` heading, and the opening paragraph of every section) over all 86 files, with the full English counterpart in hand for each; see Uncertainties for the depth caveat this leaves.

## Uncertainties

- **Chinese-mirror read depth.** I read all 86 English notes end to end. For the 86 Chinese mirrors I performed a complete structural read of every file — H1, the `Status:`/`Archived:` lines, the `English | [中文]` switcher, every `##`/`###` heading, and the first substantive paragraph of each section — and I read the full body of none of them sentence-by-sentence in Chinese. The risk this leaves is a *divergence* between a Chinese side and its English partner that preserves structure but not content (for example, a dropped alternative or a changed number). I checked for the visible symptoms of that: the archive's own rule (in `AGENTS.md`) is that pairs merge whole, the sidecar's recorded blob hashes pin each side's last-confirmed bytes, and the Chinese files I read in full detail carry the same section counts, the same tables and the same numeric figures as their English counterparts. A word-level diff was not performed.
- **Ten Chinese mirrors keep their English `##` headings** (`2026-07-19-web-styling-system`, `2026-07-20-gui-testing-system`, `2026-07-31-coverage-exempt-heavy-suites`, `2026-07-31-installer-adopts-existing-checkout`, `2026-08-13-public-vendor-and-native-sequences`, `2026-08-13-published-document-fragments`, `2026-08-18-localized-bilingual-links`, `2026-08-20-doc-site-raw-markdown-twins`, `2026-08-21-documentation-site-tag-release`, `2026-08-27-explicit-workspace-path-aliases` — the last also keeps its English H1). I did not establish whether this is a deliberate late-archive convention or an oversight: the Chinese-terminology unification note (`2026-08-09-chinese-contract-terminology.md`) is dated before several of these notes' archive dates and does not mention heading translation, and the archive `AGENTS.md` forbids repairing archived content, so the discrepancy is now permanent by policy rather than by a decision I could find.
- **Five sidecars carry a stale re-record command** naming `.agents/notes/implemented/process/…` instead of the archived path: `2026-07-23-personal-staging-maintenance-skills`, `2026-07-27-wine-windows-gates-experiment`, `2026-07-31-installer-adopts-existing-checkout`, `2026-08-04-forward-only-pr-issue-status`, `2026-08-08-review-driven-issue-lifecycle-triggers`. I did not determine whether the verifier cares (the command lives in a YAML comment, not in a hashed field) or whether these are the residue of the archival "re-record the sidecar" step. The recorded hashes themselves are correct — the recorded blob hash for `2026-08-27-gate-runner-fail-fast.md` matched my recomputation, and the SHA-256 seals in `manifest.json` matched for the twelve files I checked.
- **I could not verify the seals for all 172 files in the shard.** The SHA-256 spot check covered 12 files (6 English, 6 Chinese) spread across the date range; the git-blob check covered one English file. A full 172-file verification was not performed because my in-Process hash loop hit a command-parsing failure and I did not retry it with a scratch script (writing a scratch file outside my two outputs is forbidden by my assignment). The `manifest.json` structure and entry counts were read in full, however.
- **The referenced implementation files are outside this shard.** Nearly every note names scripts (`scripts/run-gates.ts`, `scripts/verify-md-links.ts`, `scripts/translation-brief.ts`, `scripts/gen-cordis-catalog.ts`, `scripts/coverage-exempt.ts`, `scripts/rescope-vendor.ts`, `scripts/ts-project.ts`, `scripts/project-doc-site.ts`, `scripts/change-scope.ts`, `scripts/verify-cordis-config.ts`, `scripts/gen-tsconfig-paths.ts`, `scripts/verify-export-jsdoc.ts`, `scripts/verify-doc-refs.ts`, `scripts/verify-agent-note-format.ts`, `scripts/verify-type-equiv.ts`, `scripts/run-oxlint.ts`, `scripts/coverage-partitions.ts`, `scripts/verify-cordis-config.ts`) and packages (`packages/typert/generator`, `packages/client/connection`, `packages/api/remotes`, `packages/core/scope`). I did not open any of them — they belong to other shards — so every claim about *behaviour* in this report is the note's claim, not my own reading of the code. The notes are unusually specific (they quote error strings, file paths, line counts and measured timings), which is why I treated them as reliable, but I cannot independently confirm the code they describe.
- **Cross-references to notes outside this shard were not verified.** Many links point into `../architecture/`, `../feature/`, `../testing/`, `../bug-fix/` and `../../proposed/`, all outside `dsh-notes-archived-rest#1`. I confirmed only that the *shape* of those references is consistent (relative paths with a lifecycle/class directory) and that the archive's own `verify-md-links` gate exists to check them.
- **The `process/` directory in the clone holds 360 files (120 triplets); my shard owns 86 of those 120.** The remaining 34 process triplets (dated 2026-08-28 onward) are assigned to another shard. The `process/` directory is not in my manifest list, so I did not read those 34 notes' content — I saw only their filenames, section headings and metadata while enumerating the directory for the structural pass, and I deliberately excluded them from the report.
- **The `.zh.md` files in the clone extend past my shard** (up to `2026-09-23-section-keyed-translation-pairing-records.zh.md`). Those are also another shard's; I read only their headings in passing during the structural enumeration and did not use them as sources.
