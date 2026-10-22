# deepseek-harness / dsh-notes-proposed

## Shard shape

This shard is the repository's **decision-record archive for the "not yet shipped / considered and declined" layer** of DeepSeek Harness. It holds 150 files: 50 base Agent Notes, each stored as a triplet — the English `.md`, a Chinese `.zh.md` translation, and a `.i18n.yaml` sidecar that records a per-heading-section hash of both language blocks. Forty-two notes live under `.agents/notes/proposed/` (split into `architecture/`, `bug-fix/`, `feature/`, `process/`, `simplification/`, `testing/`) and eight under `.agents/notes/rejected/` (one `architecture/`, seven `simplification/`). Nothing here is executable code: every file is prose that records *what was proposed, what it would cost, what was rejected, and what would make it worth revisiting*. The content clusters into five thematic families that map onto the harness lenses: (a) the **session/log core** — `LogicalSession`/`SessionService`/`SessionStorage` abstraction, session projections, command-lifecycle logging, storage-domain KV, migration redirect; (b) the **context-management core** — recallable compaction with frozen index checkpoints and a mutable state checkpoint, and the rejected proposal to truncate interrupted turns; (c) the **tool/extension surface** — pre-tool input rewrite, Pi extension and plugin bridges, Task Surface, side sessions, attachment quarantine; (d) **runtime lifecycle and cleanup** — required `AbortSignal` propagation and the Cordis cleanup-dependency P0 audit; (e) **process/quality** — deterministic testing, mutation testing, documentation quality, supply chain, and a rejected "dependency swaps" audit that records thirty-odd *negative* dependency verdicts so the next audit does not restart from zero. Because the shard is prose, the "mechanism" lives in the *decisions and their stated reasons*, and that is what the notes below capture.

## Per-file notes

### .agents/notes/proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.md
- Purpose: Proposes that every asynchronous same-process capability operation reachable from a tool body must require an `AbortSignal` as a positional parameter or a required readonly field, so omission fails TypeScript compilation rather than silently dropping cancellation one call deeper.
- Key abstractions: "tool-reachable, lifetime-bearing capability seam"; derived signals (child deadline / cancellation scope) that stay linked to the upstream signal; an explicit **ownership handoff commit point** separating foreground work from detached work.
- Data flow: inventory from every first-party `ToolDefinition.execute()` through the capability calls it awaits → migrate each coherent Service Definition / Service Provider / Consumer seam together (filesystem, shell/task, web/provider, workflow/subagent, ptc-runtime) → typecheck failures become the caller inventory.
- Non-obvious design decisions: the requirement is scoped by *reachability from a tool* rather than "all async functions" (line 13), because some operations are not tool-reachable, some are synchronous, and detached work has a new owner after a handoff (line 27). Ambient async-local cancellation is rejected because it hides ownership and detached handoff (line 39); default / never-abort signals are rejected because "defaults erase the missing owner instead of exposing it at compile time" (line 41).
- Edge cases / failure handling: the initiating start operation still requires the caller signal until the handoff commits, and a later tool call that waits for detached work requires its own invocation signal (line 27); a capability that stores a borrowed signal past the delegated lifetime is called out as the ownership-confusion risk (line 61).
- Surprising: the note explicitly forbids runtime validation of `AbortSignal` "solely to repeat the typed same-process contract" (line 19) — type-level enforcement is treated as the only sound place for it.

### .agents/notes/proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.i18n.yaml
- Purpose: Sidecar consistency record pairing the English and Chinese blocks of the cancellation-seams note, seven section keys deep (`/problem`, `/proposal`, `/proposal/scope-boundary`, `/alternatives-considered`, `/acceptance-criteria`, `/risks`).
- Key abstractions: the record is keyed by the **English heading path**, not the Chinese one; each key carries an `en:` and `zh:` 64-bit hash of that heading's block, excluding code blocks and generated regions.
- Data flow: edit either language → bring the other along → `pnpm run verify-translation-pairing --write <file.md>` re-records the hashes (file header, lines 3–4).
- Non-obvious design decisions: the sidecar, not the prose, is the single consistency record — it preserves equal authority, last-confirmed-text recovery, automatic merge safety, generated-region recording, and archive sealing without creating owner-file conflicts.
- Edge cases / failure handling: a drifted hash is a gate failure; the record carries no prose, so it cannot drift semantically.
- Surprising: the hash is over the section's own direct text **excluding subsections**, which is why an empty section hashes to a constant (see the Uncertainties entry on the shared `986dd8097aac4d3d` value).

### .agents/notes/proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.zh.md
- Purpose: Chinese translation of the cancellation-seams proposal; mirrors it section-for-section with Chinese headings (问题 / 提议 / 范围边界 / 考虑过的替代方案 / 验收标准 / 风险).
- Key abstractions: same seam vocabulary as the English side — "seam", "所有权交接", "环境式异步本地取消" (ambient async-local cancellation), "分离工作" (detached work).
- Data flow: identical to the English note; the language switch on line 5 points back to the `.md`.
- Non-obvious design decisions: the translator keeps the technical term `seam` untranslated, consistent with the rest of the Chinese corpus.
- Edge cases / failure handling: none specific; the pairing record carries the machine-checked guarantee.
- Surprising: the Chinese file renders `Status: proposed` in English verbatim, as the format contract requires.

### .agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md
- Purpose: The full design of a domain-KV storage capability seam (`packages/storage/`: hub + json backend + sqlite backend + domain data form) plus the `dsh-workspace` consumer entity, because the host's only persistence surface was the append-only per-session event log and anything not owned by one session had nowhere to live.
- Key abstractions: `ctx.storage` hub (backend registry + data-form mounting); a backend is one **medium owner** exposing **data-shape facets** (only `kv` this phase); `DomainSpec` / `DomainGlobalSpec` / `DomainTableSpec`; `KvTable` with a synchronous in-memory snapshot and an async `update(key, fn)`; `WorkspaceRegistry` with branded `WorkspaceId` and realpath-canonical paths.
- Data flow: `DomainFacility.open(spec)` runs six sequential steps (already-open → backend routing via `config.routes[spec.name] ?? config.backend` → facet check → `kv.open(descriptor)` → `loadAll()` + per-record zod validation → construct + register effect); writes queue on one promise chain per domain; after each write's durability resolves, a `domain/changed` event is emitted (new snapshot + operation discriminant, no old value).
- Non-obvious design decisions: the backend contract says "The backend does not promise write ordering within a unit — **the caller serializes**" (line 49), so ordering is a domain-layer concern; records are plain immutable JSON POJOs with a TypeScript readonly projection and no runtime freezing (line 159); `update()`'s fn runs on the write chain so concurrency cannot interleave (line 160); versions fail loud with no migration and no rebuild because "the data is not regenerable" (line 161); the JSON backend keeps the file as the **net current state** via temp+fsync+atomic rename, which is the reason that backend exists (human legibility).
- Edge cases / failure handling: `deleteRecord` idempotent; `putRecord` overwrites; `close` idempotent and any later operation raises `StorageError('closed')`; a stored version mismatch is `version-mismatch`; a malformed medium is `malformed-medium`; the error vocabulary is a closed code list (`backend-not-found` / `form-not-mounted` / `duplicate-backend` / `duplicate-mount` / `version-mismatch` / `malformed-medium` / `closed`); recursive session delete is bottom-up so a mid-crash leaves "half the subtree deleted, ancestors intact" and re-running converges (line 190).
- Surprising: the storage layer emits a **push** event for the first time in the repo (line 326, listed as a risk) and a `routes` map lets one domain be moved to SQLite without touching consumers (line 293).

### .agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.i18n.yaml
- Purpose: Sidecar pairing record for the domain-KV note; the deepest record in the shard, with 13 section keys including nested proposal subsections (`/proposal/dsh-storage-the-storage-hub`, `/proposal/dsh-storage-json`, `/proposal/dsh-storage-sqlite`, `/proposal/dsh-domain-the-domain-data-form`, `/proposal/future-work-session-side-deletion-design-settled-not-implemented-this-phase`, `/proposal/dsh-workspace`, `/proposal/reuse-and-the-session-backend-migration-outlook`, `/proposal/test-matrix`, `/proposal/out-of-scope-list`).
- Key abstractions: same per-heading hash-pair scheme as every other sidecar.
- Data flow: `verify-translation-pairing --write` regenerates it; `doc-sync` checks it.
- Non-obvious design decisions: the key slug is derived from the English heading text, so a rename on the English side silently invalidates the record and forces a re-record.
- Edge cases / failure handling: the sidecar is the only thing that detects a one-sided edit; the note's own text is not self-describing about drift.
- Surprising: the record's own depth (13 keys) is a proxy for how finely the note is sectioned — the largest note in the shard produces the largest sidecar.

### .agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md
- Purpose: Chinese translation of the domain-KV storage design; the only note in the shard that translates its own code identifiers inside tables (e.g. `域表`, `介质` for medium, `归档并跳过` for backup-and-skip).
- Key abstractions: same package table and `DomainSpec` shape as the English side.
- Data flow: same six-step open and per-domain write chain.
- Non-obvious design decisions: the translator renders "authority" as 权威 and distinguishes it from "derived" (派生) — the exact distinction the `recovery` spec field encodes.
- Edge cases / failure handling: the closed error-code list is translated but the codes themselves stay in English.
- Surprising: line 15 retains the English "the workspace registry indexes sessions it cannot see from another launch directory" argument verbatim inside a Chinese paragraph, i.e. the file is not perfectly localized — a translation-fidelity observation the sidecar hash would flag.

### .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md
- Purpose: Proposes the seam that lets three in-flight web features (todo #497, goal #527, plan mode #587) stop each inventing its own client-side projection, and makes slash-command outcomes durable in the session log.
- Key abstractions: the **whole-value event rule** (a state-carrying log event carries the complete post-change state, never a delta); a host-side `dsh-session-projection` registry of `ProjectionDefinition` units (`init` / `apply` / `view` / `stateVersion` / optional `wire`); a client-side generic value store `key → { value, seq }` with a single **higher-seq-wins** rule; the `command/run` + `command/done` log-only event pair; `useProjection` as a fifth framework hook seat.
- Data flow: every committed session event passes every registered unit's `apply`; an unchanged state reference (`Object.is`) produces no downstream work; state lives in a per-session watermark cache `{state, observedSeq}` and later in a persisted projection cache keyed `(sessionId, key, ver, seq, val)`; the read recipe is identical cold and live — take the cached state (or `init()`), forward-apply only events past its watermark, then `view`.
- Non-obvious design decisions: the host is the **only** place a projection is computed, so a domain writes zero client code (line 58); the projections block rides the **history tail page** rather than a separate RPC, because every moment the client needs a fresh baseline (open, reconnect resync, gap repair) already pulls the tail page and the only path that never needs one (`loadOlder`) is the only path that passes `beforeSeq` — so the client has no independent "when to refetch" decision at all (line 77); a projection row is never wrong, only possibly stale, and its `seq` says exactly how stale (line 59); the `asOfSeq` is `session.seq - 1` so a push frame carrying the first post-baseline change always compares strictly greater (line 75).
- Edge cases / failure handling: live registry churn (a plugin loading/unloading mid-session) is **not** pushed — accepted as a dev-only HMR staleness window (line 187); synchronous unit discipline is load-bearing because an `await` inside `init`/`apply`/`view` would tear the consistency cut (line 186); the command handler must call `set()` before any failable path so the logged request and the run plane cannot diverge (line 168).
- Surprising: plan mode's "pending intent" is solved by folding the **command records** rather than adding a selection event, which makes pending a pure replay quantity and gives cross-tab pending for free (line 100) — and the retired `session.planMode` unary, `goals.get`, the `todos` rider field and `backscanTodos` in api-proxy all disappear with it (line 79).

### .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.i18n.yaml
- Purpose: Sidecar for the session-projection note; 13 keys, including the nested `/proposal/whole-value-event-rule`, `/proposal/host-projection-registry-dsh-session-projection-new-package`, `/proposal/wire-projections-block-on-the-history-tail-page`, `/proposal/push-frame-and-the-client-value-store-domains-write-zero-client-code`, and the bespoke `/delivery-plan` key (a top-level section name outside the canonical skeleton).
- Key abstractions: the pairing record tolerates **bespoke** section names alongside the canonical ones, because the note format allows free-form technical sections between the required ones.
- Data flow: same generate-and-verify loop.
- Non-obvious design decisions: because the key path is derived from headings, a bespoke section gets its own key rather than being folded into `/proposal`.
- Edge cases / failure handling: none beyond the hash drift check.
- Surprising: the sidecar's existence makes the *structure* of a proposal machine-checkable — you can diff two notes' section trees without reading either.

### .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md
- Purpose: Chinese translation of the session-projection and command-log proposal; the Chinese headings translate the canonical English skeleton (问题 / 方案 / 交付计划 / 备选方案 / 验收标准 / 风险) but keep bespoke subsection names in Chinese too.
- Key abstractions: renders "水位线（watermark）" for watermark and "全量值事件规则" for the whole-value event rule, keeping the English parenthesised on first use.
- Data flow: same as the English side.
- Non-obvious design decisions: the translator keeps `asOfSeq`, `Object.is`, `seq` and the `command/run` / `command/done` event names verbatim, which is what makes the translation usable as a spec.
- Edge cases / failure handling: none specific.
- Surprising: line 168 preserves the English clause "The handler must call `set()` before any failable path…" inside the Chinese Alternatives section — a partial-translation artefact that the section hash still covers.

### .agents/notes/proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md
- Purpose: Closes a root mismatch (session store global under `$DSH_HOME/sessions`, but the shipped Web overlay gave the JSON backend a relative `./.storages` root, so two launches from different directories shared sessions yet saw different workspace registries and projection caches) and proposes a per-domain **derived-media recovery** policy.
- Key abstractions: `DomainSpec.recovery?: 'reject' | 'reset'` (default `reject`); a new `KvFacet.destroy(descriptor)` primitive; a **closed damage-class list** (`version-mismatch`, `malformed-medium`, `invalid-record`) that is the only thing allowed to trigger a reset.
- Data flow: `DomainFacility.open` fails with exactly a damage-class error → log one warning naming the domain and the discarded medium → `destroy` → reopen empty; the retry is single-shot so a persistently failing medium cannot loop; everything else (`backend-not-found`, `facet-unsupported`, `already-open`, I/O errors) stays loud.
- Non-obvious design decisions: authority is a property of the domain and must be **declared by its owner** — a blanket auto-reset is rejected outright because `workspace.json` is authoritative user data (line 46); renaming the damaged medium aside is not chosen for derived media ("a derived medium's damaged bytes have no recovery value (the logs are the source of truth)") but is explicitly reserved for a future authoritative domain (line 44); the JSON backend still does not resolve its root, and the fix is to adopt the JSONL session backend's recorded rationale verbatim — resolve once at construction, because "a later `process.cwd()` change must not split one backend across roots" (line 22).
- Edge cases / failure handling: ENOENT already means "empty unit", so it is not a damage class; every I/O error (EACCES, EIO) propagates loudly; the single-shot retry bounds the blast radius to one delete per open (line 57).
- Surprising: the note records that the projection-cache half of its own proposal was **superseded** by a later decision (per-session cache files) and that the `invalid-record` class was superseded by the shipped `invalidRecords: 'backup-and-skip'` (line 13) — the note carries its own partial obsolescence.

### .agents/notes/proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.i18n.yaml
- Purpose: Sidecar for the storage-root note; seven keys, with two long bespoke proposal keys that encode the whole "shipped vs still open" split in their slugs (`one-global-storage-root-shipped-amended-form-resolved-once-at-construction-still-open`, `declared-derived-media-reset-instead-of-reject`).
- Key abstractions: same per-heading hash-pair scheme.
- Data flow: same generate-and-verify loop.
- Non-obvious design decisions: the slug is a lossy but greppable summary of the decision's status, so a reader scanning the sidecar learns that half the proposal already shipped.
- Edge cases / failure handling: none beyond hash drift.
- Surprising: because slugs are derived from headings, a note that bakes status into a heading (`…shipped…still open`) bakes it into the machine-readable record too.

### .agents/notes/proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.zh.md
- Purpose: Chinese translation of the storage-root and derived-media-recovery proposal; the only note in the shard whose Chinese body embeds two long verbatim English paragraphs (the two quoted Cordis/storage source rationales) inside the Chinese prose.
- Key abstractions: 权威 (authoritative) vs 派生 (derived) is carried consistently and is the pivot of the whole note.
- Data flow: same destroy-and-reopen ladder.
- Non-obvious design decisions: the Chinese side keeps the English status markers "已落地" and "仍开放" in the section heading, matching the English heading's "shipped … still open".
- Edge cases / failure handling: the closed damage-class list is named in Chinese but the error codes stay English.
- Surprising: line 13 reproduces an entire English paragraph inside the Chinese Problem section — a fidelity compromise that the section hash nevertheless records (the hashes differ between the two languages, so the tool is measuring the mixed text as-is).

### .agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.md
- Purpose: Proposes storing the latest human-prompt time in the Session index so cold (persisted, unattached) listings can sort by it exactly, instead of depending on the fail-soft projection cache's `lastPromptAt` or the JSONL file's mtime.
- Key abstractions: one exported **event predicate** (`user/message` whose `source.kind` is `user`) shared by the stored field and the attached projection's fold; a new `PersistenceBackend` contract element rather than backend-local bookkeeping.
- Data flow: the coordinator computes the value (it sees every append and already owns per-id state), backends persist it; `summarizeCold()` serves it without opening the log or depending on a cache checkpoint.
- Non-obvious design decisions: mtime is rejected not as undesirable but as **impossible to keep** — "mtime is the filesystem's, not the backend's", and restoring the timestamp after every boundary write "races any concurrent reader and lies about the artifact" (line 35); the JSONL header is line 1 written once at materialization and `jsonl.spec.ts` pins that committed bytes are never rewritten, so a per-append header field would violate an **asserted durability invariant**, not merely complicate the writer (line 21); a stored field is computed per batch while the projection folds a whole log, so both must use one exported reducer to prevent drift (line 25).
- Edge cases / failure handling: pre-field artifacts have no value; falling back to `createdAt` is honest but reorders every existing session in the picker and tree (line 27); a sidecar file can disagree with its log after a crash, leaving a stale value with no torn-tail marker to repair it (line 53).
- Surprising: the note explicitly allows its own outcome to be "documenting that decision rather than implementing a field" (line 57) — it is written so the *evidence* survives either way.

### .agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.i18n.yaml
- Purpose: Sidecar for the last-activity-index note; seven keys, with a `/related` key for the trailing reference section (a canonical section name used only in notes that end with one).
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: `## Related` is treated as a first-class key, so a note that points at other notes is machine-linked too.
- Edge cases / failure handling: none.
- Surprising: the sidecar is the only place in the shard where the note's *cross-references* are recorded as data.

### .agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.zh.md
- Purpose: Chinese translation of the last-activity-index proposal.
- Key abstractions: renders "冷会话" (cold session), "预测缓存" and the mtime reasoning; keeps `shadowedRange`, `source.kind`, `lastPromptAt`, `summarizeCold()` verbatim.
- Data flow: same coordinator-computes / backend-persists split.
- Non-obvious design decisions: the Chinese side preserves the note's hardest argument — that mtime answers a different question (when the artifact was last *written*) — with the same enumeration of the three non-prompt writes that refresh it.
- Edge cases / failure handling: the same fallback-vs-reorder consequence is stated in both languages.
- Surprising: the Chinese file is the only one in the shard that reaches 64 lines, matching the English 64 exactly — one of the two files where EN and ZH line counts coincide exactly.

### .agents/notes/proposed/architecture/2026-08-08-semantic-composer-chain-phases.md
- Purpose: Replaces the browser `conversation.composer` chain's single global numeric `priority` with ordered, domain-owned semantic phases, because one scalar was being used for two different decisions (resolving an existing interaction versus restricting new work) and any numeric repair preserves that hidden coupling.
- Key abstractions: a chain declaration carrying an ordered phase tuple (`conversation.composer` declares `['interaction', 'restriction']`); `SlotMap` carrying the exact tuple for compile-time registration and the runtime `SlotSpec` repeating it as the sorting authority; `SlotCore` sorting by declared phase index, then local priority, then stable registration order.
- Data flow: every registration on a phased chain must name one phase; `SlotCore` sorts by phase index first, local priority second, stable registration order third; question and approval register in `interaction` (question before approval), `SubagentReadOnlyComposer` registers in `restriction` with an ordinary local priority; when the pending wait resolves the chain re-elects and the read-only restriction becomes visible again.
- Non-obvious design decisions: the domain rule is stated precisely — "an interaction resolves a live Host wait that already exists; a restriction prevents the user from initiating work through the ordinary composer" — and "Resolving an existing wait is not a new follow-up to the one-shot child, so the interaction phase goes first" (line 17); the phase vocabulary belongs to the declaring slot, not the slot framework globally, so other chains acquire no composer terminology and need no migration (line 19); unphased chains retain their current numeric behaviour (line 15).
- Edge cases / failure handling: registration fails immediately when a phased chain entry omits its phase or names one outside the declaration (line 15); a future hard safety surface that must preempt answering "should not be mislabeled `restriction`; it needs an explicit earlier phase or a boundary outside this composer chain" (line 44); the generic slot types and stored-entry shape gain one conditional field, so an incomplete migration could compile in one face yet fail at runtime — "The exact tuple is repeated in the runtime declaration specifically to make that drift mechanically rejectable" (line 46).
- Surprising: the acceptance criteria require the client-only transition to leave the model request header byte-identical before and after, proving "Browser election therefore has no token cost and no KV-cache invalidation" (line 40) — a UI-semantics change is explicitly proven to be free of model-visible cost.

### .agents/notes/proposed/architecture/2026-08-08-semantic-composer-chain-phases.i18n.yaml
- Purpose: Sidecar pairing record for the composer-chain-phases note; 6 heading keys.
- Key abstractions: same per-heading en/zh block-hash scheme as every other sidecar in the shard.
- Data flow: `pnpm run verify-translation-pairing --write` regenerates it after an edit on either side.
- Non-obvious design decisions: because the key path is derived from the English headings, the Chinese file's translated headings (问题 / 提案 / 备选方案 / 验收标准 / 风险) do not appear in the record — the record indexes the English outline only.
- Edge cases / failure handling: a drifted hash fails the pairing gate; headings themselves are not hashed, so a Chinese heading rewrite is invisible to the record.
- Surprising: the smallest sidecar structure in the architecture folder (6 keys) corresponds to the shard's most compact decision — the proposal fits in a single page of English.

### .agents/notes/proposed/architecture/2026-08-08-semantic-composer-chain-phases.zh.md
- Purpose: Chinese translation of the composer-chain-phases proposal.
- Key abstractions: renders the phase vocabulary as 阶段 (phase) and 交互 / 限制 for `interaction` / `restriction`, keeping `SlotCore`, `SlotMap`, `SlotSpec`, `conversation.composer` and `SubagentReadOnlyComposer` verbatim.
- Data flow: the same phase-index → local-priority → registration-order sort, with the same registration-time failure on an unknown or omitted phase.
- Non-obvious design decisions: the Chinese side preserves the two-decisions-in-one-scalar diagnosis and the rule that the interaction phase precedes the restriction because resolving a wait is not a new follow-up.
- Edge cases / failure handling: the mislabeling hazard for a future safety surface is carried over verbatim in Chinese, and the "runtime declaration repeats the tuple so drift is mechanically rejectable" argument is preserved.
- Surprising: the Chinese file is 46 lines and the English 46 — exact parity, and the note's acceptance criteria are preserved as seven bullets matching the English one-for-one.

### .agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.md
- Purpose: The master plan for replacing the concrete `Session` class with a stable access path, staged so each stage either preserves observable behaviour or names exactly one behaviour change.
- Key abstractions: `LogicalSession` (abstract, with a mix of abstract and concrete members so implementations share identity/ownership/derived-view semantics), `SessionService` (creation, publication, fork, flush, projection-port registration), `SessionStorage` (the private physical provider protocol owning revisions, format migration, crash repair, batching, cross-process writer lease).
- Data flow: stage 1 changes internal dependency direction only; later stages move construction/publication into `SessionService`, split persistence into reader/writer roles, and move live writer enqueue onto the logical session.
- Non-obvious design decisions: the concrete `Session` class and its static constructors stay as **deprecated source-compatibility entries** for external developers while the in-memory implementation remains the object consumers hold (line 23); the enforcement gate `verify-logical-session-access` is **switchable** — the checked-in default is `warn` (prints findings, writes one GitHub Actions `::warning` per finding, exits 0) so branches still binding the class merge, and `DSH_LOGICAL_SESSION_ACCESS=enforce` fails it for one run (line 94); a compatibility name survives only while a later stage still has a real consumer and a stated removal condition (line 17).
- Edge cases / failure handling: the invariants list (lines 85–90) pins `append` as synchronous and validation-before-mutation, `session/created` as a synchronous publication veto, the store returning the *same* session object it registered ("No wrapper may replace that identity"), detached construction never entering the live registry, and JSONL bytes/migrations/crash-repair/lease behaviour unchanged.
- Surprising: the note names the failure mode of its own abstraction — "A thin abstraction can preserve type safety while hiding lifecycle gaps" (line 170) — and requires contract tests for freshness, close durability, migration preparation and cross-process ownership to compensate.

### .agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.i18n.yaml
- Purpose: Sidecar for the session-rebuild master plan; the only sidecar with **three levels of nesting** (`/stage-1-…/public-model`, `/stage-1-…/stage-1-substages`, `/stage-1-…/invariants`, `/stage-1-…/enforcement-and-completion`, `/destination-architecture/ownership-rules`, `/destination-architecture/later-stages`).
- Key abstractions: nesting depth in the key path is a faithful projection of the note's outline depth.
- Data flow: same loop.
- Non-obvious design decisions: a stage-progress *table* has no heading of its own, so it is folded into the enclosing key — the record cannot see table content.
- Edge cases / failure handling: none.
- Surprising: because the record is heading-driven, two notes with the same section titles but different content still produce different hashes; but tables and code blocks are excluded, so a table edit is invisible to the pairing gate.

### .agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.zh.md
- Purpose: Chinese translation of the session-rebuild master plan; translates "stage" as 阶段 and preserves the stage numbers 1.1→1.5→2→3 that the acceptance criteria reference.
- Key abstractions: same three protocols.
- Data flow: same staged plan; the Chinese side preserves the stage-progress table verbatim in structure.
- Non-obvious design decisions: the Chinese translation keeps the "warn by default / enforce by env var" mechanic intact, including the exact env var name.
- Edge cases / failure handling: the invariants list is translated item-for-item, including the object-identity rule.
- Surprising: the Chinese file's line count (174) exactly matches the English (174) — line-count parity is a stated requirement of the bilingual contract.

### .agents/notes/proposed/architecture/2026-09-10-session-capability-protocols.md
- Purpose: Defines the target protocols of the session system: `LogicalSession`, `SessionService`, `SessionStorage`, `SessionProjectionPort`, `SessionQuery`, plus the dependency rule that only composition sees concrete providers.
- Key abstractions: five orthogonal capabilities around a small logical core; the service is "the only live session acquisition point and live identity authority"; `enter` returns a synchronous disposer and `announce` publishes only an entered session.
- Data flow: `create`/`open`/`fork` finish fallible preparation **before** publication; `flush` combines owned participants; projection registration is removable and also applies to unpublished sessions.
- Non-obvious design decisions: `SessionQuery` absorbs exact event reads, filters, traces, full-text retrieval, list metadata and statistics reads so no separate `SessionSearch`/`SessionStats` service is needed (line 56); projection "is not a second Session and does not own writes" and "every projection can rebuild from the durable log" (line 52); the developer convention bans a *new* `Session` import "merely because compatibility exists" (line 18).
- Edge cases / failure handling: the note is explicit that the target signatures are **not all implemented in Stage 3** and "this note must not present unshipped behavior as current" (line 94).
- Surprising: the mermaid diagram draws the three provider families as dashed "composition selects" edges and the implementations as dashed "implements" edges — the dependency direction is expressed as a picture before it is expressed as code.

### .agents/notes/proposed/architecture/2026-09-10-session-capability-protocols.i18n.yaml
- Purpose: Sidecar for the capability-protocols note; 12 keys, with a distinctive `/proposal/overall-architecture` key covering the mermaid block.
- Key abstractions: the mermaid diagram is inside a `###` heading, so it is hashed as a block and is excluded from the hash as a code block — the diagram's text is therefore *not* compared across languages.
- Data flow: same loop.
- Non-obvious design decisions: excluding code blocks means a translated mermaid diagram can drift silently.
- Edge cases / failure handling: none.
- Surprising: this is the clearest case in the shard where the pairing gate has a known blind spot — code and diagrams are exempt by design.

### .agents/notes/proposed/architecture/2026-09-10-session-capability-protocols.zh.md
- Purpose: Chinese translation of the capability-protocols note; one of five Chinese files in the shard that keep the **English canonical section headings** (`## Problem`, `## Proposal`, `## Alternatives considered`, `## Acceptance criteria`, `## Risks`) while translating the body and the bespoke `###` subsection headings.
- Key abstractions: same five protocols; the `SessionService` abstract class is reproduced as an identical code block in both languages.
- Data flow: same.
- Non-obvious design decisions: keeping the canonical English headings means the Chinese file's heading path matches the English one exactly, which is what the pairing key path expects.
- Edge cases / failure handling: the note's own warning against presenting unshipped behaviour as current is preserved verbatim in Chinese.
- Surprising: this file and four siblings are the only notes in the shard where the Chinese side retains English canonical headings; every other Chinese file translates them.

### .agents/notes/proposed/architecture/2026-09-10-session-data-compatibility.md
- Purpose: States the rule that the session abstraction refactor must not change durable bytes: stages 1–3 "only rearrange code ownership" and do not touch V3 JSONL bytes, `SESSION_FORMAT_VERSION` or the user startup flow.
- Key abstractions: `SESSION_FORMAT_VERSION` as the writer authority; the format catalog owning the released v0→v1→v2→v3 path including a dedicated V2-to-V3 stage.
- Data flow: migration writes a **new current generation** and retains old committed generations for inspection and recovery; a current runtime can open released older formats through the catalog, but an older runtime is not promised to read V3.
- Non-obvious design decisions: do not overwrite old generations or auto-downgrade (line 17); derived data (query indexes, projection caches) is rebuildable and "cannot become recovery authority" (line 27); a future provider must distinguish unsupported future versions, corruption, ownership conflicts and migration failures (line 23).
- Edge cases / failure handling: if open fails, preserve the full session generation and the error text instead of deleting old files; large logs migrate through streaming stages to avoid whole-artifact memory peaks (line 21).
- Surprising: the note explicitly rejects conflating "Session V3" with any other component version named V3 — projection caches have different durability and recovery rules (line 33).

### .agents/notes/proposed/architecture/2026-09-10-session-data-compatibility.i18n.yaml
- Purpose: Sidecar for the data-compatibility note; 9 keys. Its `/proposal` key carries the **identical hash on both sides** (`986dd8097aac4d3d`) — the direct-text of the Proposal section is empty in both files (the heading is followed immediately by a `###` subheading), so the empty block hashes to a constant.
- Key abstractions: the hash covers a heading's own direct text, excluding subsections and code blocks.
- Data flow: same loop.
- Non-obvious design decisions: this is the empirical proof of the hash's scope — the same constant appears for a different note's empty `/proposal` section (see also `2026-09-10-session-refactor-faq.i18n.yaml`, same value).
- Edge cases / failure handling: none.
- Surprising: a matching en/zh hash pair is therefore ambiguous — it can mean "correct translation" or "both empty" — and the record alone cannot distinguish the two.

### .agents/notes/proposed/architecture/2026-09-10-session-data-compatibility.zh.md
- Purpose: Chinese translation of the data-compatibility note; one of the five that keep English canonical headings.
- Key abstractions: keeps `SESSION_FORMAT_VERSION`, "generation", "format catalog" and the V2→V3 stage names in English.
- Data flow: same migration contract.
- Non-obvious design decisions: the Chinese side preserves the "do not overwrite old generations or auto-downgrade" rule as a standalone paragraph rather than folding it into a bullet, matching the English structure.
- Edge cases / failure handling: the four failure categories (unsupported future version, corruption, ownership conflict, migration failure) are enumerated in Chinese and match the English list exactly.
- Surprising: the file's `## Problem` / `## Proposal` headings are English while every `###` subheading is Chinese — a hybrid that the sidecar tolerates because keys come from the English side.

### .agents/notes/proposed/architecture/2026-09-10-session-developer-transition.md
- Purpose: The developer-facing rules for living through the staged session refactor: one mental model ("obtain `LogicalSession` through `SessionService`… and let only providers and composition know the physical implementation") plus a per-stage rule table and operation-by-operation migration pseudocode.
- Key abstractions: `ctx.sessions` as the live registry; `SessionQuery` for cold/indexed/filtered/search/list/statistics reads; detached factories (`createLogicalSession`, `restoreLogicalSession`) reserved for validation, provider adapters and focused tests.
- Data flow: each migration entry pairs a "before" idiom with a "after" idiom — `new Session(...)` → `ctx.sessions.create()`, `session.events[index]` → `session.eventAt(seq)`, local event folding → `session.surface`, `push(events)` → `session.append(type, data, surfaceIntent)`, `handle.read(...)` → `session.snapshotEvents(from, to)`.
- Non-obvious design decisions: "Docs and tests label current, completed-stage, target, or compatibility behavior. They do not present draft PRs as released." (line 31); new code must not use `SessionPersistence`, `ctx.sessionPersistence`, or the old handle/access/snapshot/revision names (line 30); core code must not branch on provider names or scan packages (line 29).
- Edge cases / failure handling: developers must target their own branch and "must not backport Stage 3 APIs into a lower stage" (line 101); `LogicalSession` must not absorb search, statistics or I/O without natural ownership and become "a new large object" (line 101).
- Surprising: the contribution path forbids reading only the final stage's diff before editing an earlier stage (line 82) — a rule that encodes the stacked-PR workflow as process guidance.

### .agents/notes/proposed/architecture/2026-09-10-session-developer-transition.i18n.yaml
- Purpose: Sidecar for the developer-transition note; 9 keys, with the pseudocode block inside `/proposal/common-operation-migrations` excluded from hashing as a code block.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: because code blocks are exempt, the migration pseudocode — the most operationally important part of the note — is *not* compared across languages.
- Edge cases / failure handling: none.
- Surprising: the note's primary payload (pseudocode) is exactly what the sidecar cannot check.

### .agents/notes/proposed/architecture/2026-09-10-session-developer-transition.zh.md
- Purpose: Chinese translation of the developer-transition rules; one of the five keeping English canonical headings, with Chinese `###` subsection headings (维护规则 / 常见操作迁移 / 新贡献者怎样上手).
- Key abstractions: preserves `ctx.sessions`, `createLogicalSession` / `restoreLogicalSession`, `SessionQuery`, and the whole pseudocode block verbatim.
- Data flow: the per-stage rule table is reproduced with the same stage markers (当前 master / 阶段 1 后 / 阶段 2 后 / 阶段 3 后 / 阶段 4–5 后 / 长期).
- Non-obvious design decisions: the Chinese side keeps the "one mental model" sentence as a single bolded line, matching the English emphasis.
- Edge cases / failure handling: the stage-order rule and the "don't present draft PRs as released" rule are both carried over.
- Surprising: the Chinese file is 101 lines and the English 101 lines — exact parity, again matching the bilingual contract's physical-line requirement.

### .agents/notes/proposed/architecture/2026-09-10-session-refactor-faq.md
- Purpose: A short FAQ that disambiguates the five new session abstractions for contributors and, crucially, separates *temporary naming* from *long-term responsibility* from *current stack state*.
- Key abstractions: why the type is called `LogicalSession` (the concrete class already owns `Session`); why `SessionService` ≠ `SessionStorage`; where projection fits; why there is no `SessionSearch`/`SessionStats`.
- Data flow: every answer links to or follows one normative owner instead of copying full protocols.
- Non-obvious design decisions: renaming `LogicalSession` back to `Session` is explicitly deferred until after compatibility removal and is "not a prerequisite for the current stages" (line 15); the name `SessionRuntime` is rejected because the repo's package-naming table reserves `Runtime` for a component that "runs live work and owns dispatch, cancellation, or operation lifecycle", and this interface "holds one session's identity and log and runs nothing" (line 51).
- Edge cases / failure handling: the FAQ acknowledges it can go stale and requires every stage that updates the overview status to review it, with current branch types/tests/subsystem docs remaining authoritative (line 63).
- Surprising: the naming-table rejection reason is a *repository-wide convention* used to kill a single identifier — a cheap, checkable way to keep vocabulary coherent.

### .agents/notes/proposed/architecture/2026-09-10-session-refactor-faq.i18n.yaml
- Purpose: Sidecar for the FAQ note; 15 keys — the most keys for the shortest note, because each FAQ answer is its own `###` heading and therefore its own hash pair.
- Key abstractions: the key path encodes the question slug (`/proposal/why-logicalsession`, `/proposal/is-concrete-session-forbidden-immediately`, `/proposal/how-do-sessionservice-and-sessionstorage-differ`, `/proposal/where-does-projection-fit`, `/proposal/why-no-sessionsearch-or-sessionstats`, `/proposal/must-ordinary-users-migrate`, `/proposal/what-is-complete`, `/proposal/how-can-i-contribute`).
- Data flow: same loop.
- Non-obvious design decisions: a question-shaped document is perfectly suited to per-section pairing, because each answer can be revised independently without touching the others.
- Edge cases / failure handling: none.
- Surprising: the same constant `/proposal` hash `986dd8097aac4d3d` appears here as in the data-compatibility note — confirming it is the empty-block constant, not a content match.

### .agents/notes/proposed/architecture/2026-09-10-session-refactor-faq.zh.md
- Purpose: Chinese translation of the session-refactor FAQ; one of the five keeping English canonical headings, with Chinese `###` headings that are direct translations of the English questions.
- Key abstractions: each answer stays a separate paragraph so the pairing record can hash it individually.
- Data flow: same.
- Non-obvious design decisions: the `SessionRuntime` rejection reason is translated but keeps the package-naming-table link.
- Edge cases / failure handling: the staleness caveat is preserved.
- Surprising: the Chinese file is 63 lines against the English 63 — exact parity again.

### .agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.md
- Purpose: A two-stage refactor of the composer so one Session can be edited from several views: stage one performs five **mechanical** responsibility extractions (no behaviour change), stage two implements the shared-draft / multi-editor behaviour.
- Key abstractions: `DraftEditor` (the draft-editing area) vs Composer (draft + attachments + submission controls); a shared Session-associated Composer model owning draft text, semantic references, content revision, ordered attachment IDs and submission attempts; per-instance Lexical/DOM/NodeKey/selection/IME state.
- Data flow: the shared model accepts edits, assigns revisions and publishes; editors distinguish local changes from external rendering to avoid feedback loops; stale-revision, prior-lifetime and unmounted-view callbacks must not overwrite current content.
- Non-obvious design decisions: stage two "must not move existing files or directories, perform pure renames or helper/class/component extractions, reorder existing tests, or clean up formatting or comments" (line 65) — mechanical work and behaviour work must not share a diff; the note includes an explicit "Isolation actually achieved in stage one" table (lines 53–61) listing what stage one does **not** achieve (two editors in one Session, independent selection/IME/Undo origins, multi-view picker routing); a shared draft synchronises **complete semantic documents** rather than deltas because the draft is small (line 88).
- Edge cases / failure handling: IME preedit belongs to the local instance and updates from another view "must not directly disrupt text under composition"; Undo/Redo must operate on one logical draft rather than letting two Lexical histories restore stale whole documents over each other (line 90); a closed view must not redirect late UI actions into another view of the same Session (line 92); document drop must select one explicit target and process the drop exactly once (line 92).
- Surprising: the note insists `DraftEditor.tsx` extracts presentation **without adding a DOM wrapper**, and that hooks, refs, dependency arrays and relative effect order stay in the host — because "even stateless JSX extraction can alter ref or effect timing" (line 114).

### .agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.i18n.yaml
- Purpose: Sidecar for the composer refactor note; 11 keys, nesting the stage-one invariants and the stage-two ownership/synchronisation subsections.
- Key abstractions: same scheme; the `/proposal/stage-one-…/stage-one-invariants` key captures the invariants as one hashable block.
- Data flow: same loop.
- Non-obvious design decisions: the invariant list is a subsection (not free prose) precisely so it can be hashed as a unit.
- Edge cases / failure handling: none.
- Surprising: the tables inside the two stage subsections are excluded from hashing, so the "where does the behaviour change land" table can differ between languages unchecked.

### .agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.zh.md
- Purpose: Chinese translation of the composer/DraftEditor two-stage proposal.
- Key abstractions: renders Lexical, IME and "视图绑定" (view binding) faithfully; the stage-one extraction table maps the same five source locations to the same five destinations.
- Data flow: same shared-model publish model with revision guards.
- Non-obvious design decisions: the Chinese side preserves the "stage two must not include mechanical cleanup" restriction as its own bolded sentence, and keeps the "Isolation actually achieved" table.
- Edge cases / failure handling: the IME, Undo/Redo and late-action edge cases are all carried over.
- Surprising: the Chinese file is 116 lines and the English 116 — exact parity.

### .agents/notes/proposed/architecture/2026-09-20-unified-typert-remote-metadata.md
- Purpose: Replaces the committed-generated-source delivery of Typert/Remote metadata (`emitSourceDef`, `emitSourceDef`-generated files, `./remote-source`) with ordinary artifacts, and makes strict-vs-lenient input validation a **consumer choice** rather than a per-method annotation.
- Key abstractions: `TypertRemoteInfo` as a real lazy class instance (not a constructor or eager literal); `TypertRemoteMethodSpec` with ordered parameters and a single `result` codec; `TypertRemoteValue<Input>` with `create()` (Zod parser) and `jsonSchema` (optional projection); `isTypertRemoteMethod` as the narrowing predicate; the `TypertRemoteMethod` fifth generic retaining the carrier-decoded unary byte type independently of the result parser.
- Data flow: the emitter writes one static spec per endpoint and calls `createTypertRemoteInfo({ package, methods }, z)`; construction retains only the spec and the explicitly supplied Zod runtime without constructing schemas; the first read of `descriptors`/`methods` builds and caches one shared index; `methods[endpoint]` aliases the exact direct descriptor object.
- Non-obvious design decisions: every parameter emits **both** a normal `codec` and a `strictCodec` from the same checker-resolved type model, "with no per-method policy in the analyzer or model" (line 25); strictness is selected by the *consumer* via `input({ strict: true })`, not annotated by the author (line 45); each input-policy view, its parser and its JSON Schema projection are **independently lazy and cached** (line 31); the protocol root re-exports the factory without adding Zod to every protocol consumer's static module graph (line 31); documentation and JSON Schema are optional, and each unsupported projection records its own `jsonSchemaError` while preserving parsers (line 35).
- Edge cases / failure handling: the Loader validates static codec specs and callable `input`/`invoke` **without** calling the selector, parser factories or projections (line 47); once a strict local descriptor has been observed, its withdrawal must refuse invocation rather than downgrade to the fallback (line 45); the host must await local registration before serving calls — "`hasSeen()` does not protect an endpoint before its first registration" (line 47); native `dsh-tools` registration additionally requires `output.schema`, "a parser alone does not satisfy it" (line 35).
- Surprising: the note is explicitly a compatibility document for **four distinct consumer kinds** (browser/Node remote callers, offline CLI, MCP discovery/calls, native tools, plus independent adapters) with a table showing metadata adaptation and execution retained for each (lines 53–59) — one metadata surface serving five very different consumers.

### .agents/notes/proposed/architecture/2026-09-20-unified-typert-remote-metadata.i18n.yaml
- Purpose: Sidecar for the typert metadata note; 9 keys, with `/proposal/paired-usage-examples` covering the block of six paired old-vs-new code snippets.
- Key abstractions: same scheme; code blocks are excluded from hashing, so the six paired examples are unchecked.
- Data flow: same loop.
- Non-obvious design decisions: the note's most useful content (the paired examples) is exactly the content the gate cannot see.
- Edge cases / failure handling: none.
- Surprising: this note's sidecar is one of the shallowest for its size, which is a direct consequence of the code-block exemption.

### .agents/notes/proposed/architecture/2026-09-20-unified-typert-remote-metadata.zh.md
- Purpose: Chinese translation of the typert/remote metadata note; one of the five keeping English canonical headings, but here the bespoke `## 技术架构` heading *is* translated while `## Problem` / `## Proposal` stay English — the file mixes both conventions.
- Key abstractions: preserves `TypertRemoteInfo`, `TypertRemoteMethodSpec`, `strictCodec`, `codec`, `jsonSchema`, `TypertRemoteValue` and every package name verbatim.
- Data flow: same lazy-index construction and per-consumer metadata paths.
- Non-obvious design decisions: the Chinese side reproduces the six paired usage examples as code blocks, so those are identical in both languages.
- Edge cases / failure handling: the "strict descriptor withdrawal must refuse invocation" rule is carried over.
- Surprising: the mixed heading convention (English canonical + Chinese bespoke) is the one thing in the shard where the two heading vocabularies coexist inside a single file.

### .agents/notes/proposed/architecture/2026-09-29-session-migration-follow-redirect.md
- Purpose: Presents long-running Session format migration as a typed **business redirect** ("302") returned by a history read, so the client can show the real migration phase and failure instead of waiting on a blank history load.
- Key abstractions: a migration reference carried on page/follow responses; the Session object layer owning redirection, waiting, failure and reopening; explicit migration state observed by React and rendered by a dedicated component.
- Data flow: page/follow returns a migration reference → the client follows the migration for the current phase and subsequent progress → on success it returns to the original history read; multiple waiters share one operation and late joiners receive current state immediately; closing one view releases only its waiter.
- Non-obvious design decisions: progress deliberately enters **neither** the Session log nor `session.control` for this flow (line 17) — putting progress into history events "would contaminate the model log and change journal sequence semantics" (line 9); "302" is a business result and "accepts no arbitrary URL" (line 13); commands with committed effects are not replayable, so the scope is recoverable history reads rather than a general command-retry platform (line 31).
- Edge cases / failure handling: unknown totals produce **no fabricated percentages** (line 38); an old attempt cannot overwrite a newer one (line 36); cancellation never rolls back a published generation (line 37); the resumed history read cannot restart the same migration after cache eviction — the reference must retain the prepared result until the original follow takes ownership, not rely on an evictable short-lived cache (line 23).
- Surprising: the note leaves a real decision open — whether the redirect waits for *read* preparation or *write* publication, because waiting for publication adds write-permission and publication-time requirements to opening old history (line 23).

### .agents/notes/proposed/architecture/2026-09-29-session-migration-follow-redirect.i18n.yaml
- Purpose: Sidecar for the migration-redirect note; 7 keys, with a bespoke `/proposal/completion-milestone-remains-open` key naming the open decision in the slug.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: because the slug carries "remains open", the machine record states the note's own incompleteness.
- Edge cases / failure handling: none.
- Surprising: the sidecar is the only artifact in the shard that indexes a note's *unresolved* questions by name.

### .agents/notes/proposed/architecture/2026-09-29-session-migration-follow-redirect.zh.md
- Purpose: Chinese translation of the migration-redirect proposal.
- Key abstractions: renders the "302" business result as 「"302" 是业务结果，不是浏览器 HTTP 跳转」.
- Data flow: same waiter-sharing semantics.
- Non-obvious design decisions: the Chinese side keeps the exact phrase "不接受任意 URL" for the no-arbitrary-URL rule.
- Edge cases / failure handling: the no-fabricated-percentages rule is carried over and is one of the acceptance criteria.
- Surprising: the Chinese file is 43 lines against the English 43 — exact parity.

### .agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md
- Purpose: A P0 audit of a specific Cordis lifecycle violation: a disposer can await its consumers while a sibling disposer has already removed the listener or closed the resource those consumers need, so awaiting a provider's final disposal promise does not establish resource survival.
- Key abstractions: "stop admitting new work, settle accepted work and final publication, then drain and release the resource"; an explicit **composed ownership sequence** of the actual disposers (a returned wrapper does not capture an independently registered original effect).
- Data flow: five P0 findings, each traced to owners and a failure mode — Session persistence dropping events emitted during cleanup; Storage closing before Schedule commits accepted delivery; Authorization losing a required observation or an accepted credential write; SSH disabling cleanup requests before dependent process cleanup finishes; Windows sandbox releasing temporary process resources during consumer cleanup.
- Non-obvious design decisions: each finding separates what was **reproduced** from what is **source-traced** — the storage one reports the reproduced error `domain 'audit' is closed` from a real Cordis + storage-domain experiment (line 35), while the SSH and sandbox ones report controlled reproductions that verify the composed-provider defect but not real remote quiescence or native Windows access (lines 49, 57); a "returned wrapper does not capture an independently registered original effect" is called out because that is exactly how a fix can appear to work and not (line 15).
- Edge cases / failure handling: the acceptance criteria prescribe a **controlled-promise regression** per finding: pause the real consumer before its last dependency use, start provider or enclosing-owner disposal, release the pause, and await both operation and disposal (line 81); the Session case must compare live and restored history rather than checking only that `close()` ran (line 82); the credential case must distinguish new admission from accepted operations (line 43).
- Surprising: the note's most transferable artefact is not the finding but the **method**: a focused experiment using the real framework, with one controlled promise, that turns an ordering bug into a reproducible assertion.

### .agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.i18n.yaml
- Purpose: Sidecar for the cleanup-lifetimes note; 13 keys, one per P0 finding, each slug naming the failure (`session-persistence-drops-events-emitted-during-cleanup`, `storage-closes-before-schedule-commits-accepted-delivery`, …).
- Key abstractions: the note's findings become individually hashable units.
- Data flow: same loop.
- Non-obvious design decisions: a per-finding `###` heading is what makes each finding independently translatable and independently reviewable.
- Edge cases / failure handling: none.
- Surprising: the sidecar is effectively an index of the shard's P0 list — you can diff two revisions and see which findings changed wording without reading the prose.

### .agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.zh.md
- Purpose: Chinese translation of the cleanup-dependency-lifetimes P0 audit; the only note in the shard whose Chinese body embeds a long verbatim English blockquote of the Cordis audit skill anchor (line 11).
- Key abstractions: keeps `Fiber._unload`, `ReflectService.provide`, `EventsService.register` and the three vendor paths verbatim.
- Data flow: same five findings.
- Non-obvious design decisions: the Chinese side preserves the distinction between 复现 (reproduced) and 源码追踪 (source-traced) throughout, which is the note's core evidentiary discipline.
- Edge cases / failure handling: the controlled-promise acceptance recipe is translated intact.
- Surprising: the Chinese file is 93 lines against the English 93 — exact parity, and the only note in the shard with 93 lines.

### .agents/notes/proposed/bug-fix/2026-08-20-attachment-read-quarantine.md
- Purpose: Prevents one unreadable historical image from bricking every later request in a session: an admitted `ImageAttachmentRef` stays in durable history and participates in every request until compaction replaces it, so a missing/corrupt object made every subsequent model request fail.
- Key abstractions: a session-backed image-request projection that records unreadable references **before** provider dispatch; a durable `attachment/quarantine` event; deterministic text replacement carrying display name, attachment-id prefix and failure class.
- Data flow: `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_CORRUPT` append `attachment/quarantine` immediately; `ATTACHMENT_READ_FAILED` gets one cancellation-aware read retry, then the same event with a retryable reason; later requests derive the same replacement from the log and skip `readImage()`; the original image block stays in append-only history.
- Non-obvious design decisions: "A request that discovers and records a quarantine reprojects before calling the provider, so the failed read does not become a terminal model-request attempt" (line 15) — the quarantine is recorded *and* applied in the same request; recovery calls `readImage()` and appends `attachment/recovered` **only after digest and metadata verification succeeds**, and clearing quarantine without verification is invalid (line 17); missing or corrupt bytes are never overwritten automatically because the reference names verified immutable content (line 26).
- Edge cases / failure handling: cancellation and unclassified failures do **not** quarantine data (line 13); concurrent requests must coordinate so duplicate failures produce one effective transition (line 37); auxiliary calls without a live session cannot record recovery state and their failure policy is explicitly left as implementation scope, not an adapter fallback (line 37).
- Surprising: the note distinguishes the three failure classes on purpose — one is terminal and one is retryable — instead of collapsing them into "attachment failed".

### .agents/notes/proposed/bug-fix/2026-08-20-attachment-read-quarantine.i18n.yaml
- Purpose: Sidecar for the attachment-quarantine note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the ZH counterpart translates the canonical heading as 接受标准 ("acceptance standard") rather than the 验收标准 used by every other Chinese file — a small vocabulary drift the sidecar cannot flag, because headings are not hashed.
- Edge cases / failure handling: none.
- Surprising: this is the only place in the shard where the Chinese canonical vocabulary drifts, and it is invisible to the pairing gate for exactly that reason.

### .agents/notes/proposed/bug-fix/2026-08-20-attachment-read-quarantine.zh.md
- Purpose: Chinese translation of the attachment-quarantine bug-fix proposal.
- Key abstractions: keeps the three `ATTACHMENT_*` codes, `attachment/quarantine`, `attachment/recovered`, `readImage()` and `ImageAttachmentRef` verbatim.
- Data flow: same quarantine-then-reproject-then-skip flow.
- Non-obvious design decisions: the Chinese side preserves the "one cancellation-aware retry" wording and the "never automatically overwrite bytes" argument.
- Edge cases / failure handling: the concurrency and no-live-session caveats are carried over.
- Surprising: the Chinese file is 38 lines against the English 38 — exact parity.

### .agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md
- Purpose: Designs how a hook-supplied `updatedInput` (Claude Code's `PreToolUse`) can be honoured without letting the UI show one command while another runs.
- Key abstractions: the **three readers of pre-execution arguments** — `assistant/message` (the model-history source), `tool/call` (the durable audit record), and presentation (`presentCall`/`presentResult`, plus `dsh-tool-bash`'s card title, rawInput, cwd and terminal-vs-background treatment).
- Data flow: the effective value must be chosen **before** the registry constructs its immutable `ToolExecution`, and must be reflected atomically in all three readers; the audit event records the rewritten arguments with the original retained in a sidecar field.
- Non-obvious design decisions: the registry's protected-identity design (structured-clone + deep-freeze of `arguments`, non-writable execution identity properties, no test shim or listener path that can replace them) makes a partial rewrite **unrepresentable**, so the rewrite must be a "pre-identity consistency transaction" (lines 19, 23); extending `PreToolDecision` at its current firing point is insufficient because both durable records already exist by then (line 29).
- Edge cases / failure handling: whether rewriting the `assistant/message` tool-call block corrupts any provider's replay expectation is an **open question that must be settled empirically** before the decision shape freezes (line 45); the ordering relationship among `assistant/message`, `tool/call`, hook audit events and execution must be pinned without weakening turn enclosure or call/result adjacency (line 46).
- Surprising: the note is explicit that until the transaction exists, the CC/Codex bridges log and warn about `updatedInput` rather than claiming it was honoured — and anchors the gap with a `TODO(pre-tool-input-rewrite)` at the loop dispatch site (line 35).

### .agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.i18n.yaml
- Purpose: Sidecar for the pre-tool-input-rewrite note; 9 keys, with a bespoke `/the-problem-three-readers-of-pre-execution-arguments` key for the non-canonical section title.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the note's own canonical `## Problem` heading is followed by a second `##`-level section with a bespoke name; the record tolerates it by keying it separately.
- Edge cases / failure handling: none.
- Surprising: this note has two `##`-level sections after the header, one of which restates the problem — a structure the format gate allows but the record indexes.

### .agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md
- Purpose: Chinese translation of the pre-tool-input-rewrite proposal.
- Key abstractions: keeps `assistant/message`, `tool/call`, `presentCall`/`presentResult`, `ToolExecution.arguments` and `structured-clone` verbatim; renders the three readers as 三方读取.
- Data flow: same atomicity requirement across the three readers.
- Non-obvious design decisions: the Chinese side preserves the "protected identity" argument including the prohibition on a test shim.
- Edge cases / failure handling: the four open questions are translated one-for-one.
- Surprising: this file is 53 lines against the English 53 — exact parity.

### .agents/notes/proposed/feature/2026-07-06-recallable-compaction.md
- Purpose: The shard's most important context-management proposal: make compaction *recallable* and *prefix-cache-aware* by splitting the checkpoint into frozen index stubs plus one mutable state checkpoint, and giving the model tools to read back what the summary shadowed.
- Key abstractions: **frozen index checkpoints** (immutable ~100–200 token stubs, never rewritten, never re-entering a later compaction region); the **state checkpoint** (at most one mutable working-memory document, positioned after all stubs and before the retained tail); `history_read(checkpoint, offset?)` and `history_search(query, checkpoint?, limit?)` as model-facing tools; `chunkTokens` / `stubTokens` budgets; the deterministic code-assembled footer `[checkpoint c<summarySeq>: shadows conversation span #<start>–#<end>; originals retrievable via history_read]`.
- Data flow: stale history is chunked deterministically (`toolPairingBalancedBefore`/`After` edges, turn-boundary preference, trailing slice shrunk to roughly one turn); each chunk becomes one stub via a `compactRegion` call; a pass runs two phases — all summarize calls concurrently buffered off-surface, then regions commit strictly left to right so the state checkpoint lands after every stub via contiguous single-node replaces; the request prefix after a pass is `[system][stubs…][state][tail]`.
- Non-obvious design decisions: the root cause is named as one artifact playing two conflicting roles — "An **index** wants to be frozen, chronological, and cheap; the model's **working memory** wants a global view, re-prioritization, and mutability. A single summary can be neither well." (line 11); stub pointers are **code-composed from the `compaction/summary` seq and `shadowedRange`** — "the model never writes them" (line 25) — because pointers must be exact; a slice made entirely of recalled content is stubbed by code alone with no LLM call, and a failed stub call degrades the same way, making the state rewrite the only hard LLM dependency in a pass (line 27); the stub call's input is layered (fixed preamble → byte-identical pass-start state → keyword lines of previously committed stubs → one or two most recent stubs → the slice), so sibling stubs are not inputs (line 27); an **inflation guard** compares one metric on both sides — provider-reported usage, falling back to the character estimator on both sides — and if the post-compaction size is not strictly below the pre-compaction size, nothing commits and the turn proceeds (line 33).
- Edge cases / failure handling: a crash in the summarize phase commits nothing; a crash mid-commit leaves a left-to-right prefix committed, and the resumed pass reads its merge base from the log's latest state-class `compaction/summary` event and commits the remaining regions unconditionally — "restoring `[stubs…][state][tail]` outranks shrinking" (line 40); the superseded state checkpoint folds into the next pass's first chunk as ordinary history with no tombstone, keeping every trailing slice reachable through the two-hop chain (line 38); recall tools reject non-agent callers and typed-error on never-existing ids or orphaned `compaction/start`; recalled content lands at the context **tail** as ordinary `tool/result`s so reconstructability holds with no special casing (line 49).
- Surprising: the whole design is a **cache-economics** argument, not a quality argument — "Frozen stubs are byte-stable across passes, so the miss begins at the token replacing the previous state checkpoint and stays O(new chunks + state + tail) — instead of the baseline's position-zero miss" (line 53); recall stays a pure function of the log because an LLM or embedding call in the recall path "breaks keyless replay determinism" (line 90); and the note refuses to ship recall tools alone, because "untrained models under-use any new tool, so the gate would measure training absence rather than design value" (line 81).

### .agents/notes/proposed/feature/2026-07-06-recallable-compaction.i18n.yaml
- Purpose: Sidecar for the recallable-compaction note; 14 keys, with eight nested proposal subsections (`frozen-index-checkpoints`, `the-state-checkpoint`, `pass-execution`, `the-recall-tools`, `cache-and-cost`, `packaging`, `relation-to-in-flight-work`, `follow-ups`).
- Key abstractions: the note's structure is the mechanism — each mechanism gets its own heading, and therefore its own independently-checked translation.
- Data flow: same loop.
- Non-obvious design decisions: because "follow-ups" is a heading, the deferred work list is hashed and translated as one block rather than being scattered.
- Edge cases / failure handling: none.
- Surprising: the sidecar shows the note's centre of gravity — the deepest nesting is in the mechanism sections, and the shallowest in the acceptance/risk sections.

### .agents/notes/proposed/feature/2026-07-06-recallable-compaction.zh.md
- Purpose: Chinese translation of the recallable-compaction proposal; the only file in the shard whose Chinese body is **longer in bytes** than its English sibling (16,656 vs 16,541), because Chinese carries more characters for the same technical content.
- Key abstractions: renders 索引存根 (index stub), 状态检查点 (state checkpoint), 遮蔽区段 (shadowed span) and the two-hop chain.
- Data flow: same two-phase pass and the same `[stubs…][state][tail]` prefix — the ASCII prefix notation is kept verbatim in Chinese, which is what makes the cache argument legible in both languages.
- Non-obvious design decisions: the Chinese side preserves the exact code-composed footer string and the "模型绝不会编写它们" (the model never writes them) clause.
- Edge cases / failure handling: the crash-recovery rule (resume reads the merge base from the log and commits the state region unconditionally) is carried over intact.
- Surprising: the Chinese file is 110 lines against the English 110 — exact parity, despite the byte-length inversion.

### .agents/notes/proposed/feature/2026-07-08-interactive-side-sessions.md
- Purpose: Defines a **side session** — an ordinary live session forked at the source's last completed turn, attached to its own agent, framed as a read-only advisor, and able to merge back one condensed note — because existing primitives (session-store fork, fork subagents) give the user neither a separate conversation nor a recorded conclusion beside the session that produced it.
- Key abstractions: a plugin-sourced `context/message` as the framing and merge-back carrier; `meta.isSeeded: true` plus the exact sibling `inheritedEventCount` on the child.
- Data flow: fork the parent's balanced completed-turn prefix → `ctx.agents.create({ seed, inheritedEventCount, meta })` → inject one plugin-sourced `context/message` → on merge-back, ask the child for a length-capped handback and inject one plugin-sourced `context/message` into the parent, where the next parent request sees it at its logged position.
- Non-obvious design decisions: the advisor framing deliberately does **not** change the child's system prompt — "Keeping the system prompt byte-identical preserves the provider prefix cache over inherited history" (line 16); merge-back uses a sourced `context/message` rather than a new `sidechat/*` event, because a sourced message already records content, producer and replay input durably, and a dedicated event is justified only by a client that needs distinct rendering (line 26).
- Edge cases / failure handling: read-only behaviour is only **advisory** until a `tools/pre-execute` deny gate enforces it, and the interception point can add that gate without changing these mechanics (line 39); a compacted source forks its compacted view, so a bound UI should disclose that the child inherits summaries rather than replaced turns (line 40); repeated handbacks consume parent context, bounded by a per-merge length cap with later consolidation left to compaction (line 41).
- Surprising: the note is careful that side sessions are **user-driven, client-visible, and may outlive a parent turn**, which is exactly why the subagent seam (model-driven, returns one tool result) is rejected (line 24).

### .agents/notes/proposed/feature/2026-07-08-interactive-side-sessions.i18n.yaml
- Purpose: Sidecar for the side-sessions note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: the shortest sidecar in the shard corresponds to a note whose payload is mostly bullets, not prose — hash depth tracks structure, not size.

### .agents/notes/proposed/feature/2026-07-08-interactive-side-sessions.zh.md
- Purpose: Chinese translation of the side-sessions proposal.
- Key abstractions: renders 侧会话 (side session), 只读顾问 (read-only advisor) and 合并回写 (merge-back); keeps `context/message`, `inheritedEventCount`, `meta.isSeeded` and `tool/result` semantics verbatim.
- Data flow: same fork → frame → handback → merge-back chain.
- Non-obvious design decisions: the byte-identical-system-prompt prefix-cache rationale is preserved in Chinese, with "逐字节一致" (byte-for-byte identical).
- Edge cases / failure handling: the advisory-until-gated, compaction-inheritance and context-consumption caveats are all carried over.
- Surprising: the Chinese file is 41 lines against the English 41 — exact parity.

### .agents/notes/proposed/feature/2026-08-04-task-surface.md
- Purpose: A versioned declarative model for **temporary structured UI**: one stable model-facing tool `show_task_surface` publishes a JSON model that a normal Web Client Plugin renders; the user edits and submits, and the Host records the submission as one ordinary visible user message.
- Key abstractions: `TaskSurfaceModelV1` (sections, blocks `markdown`/`metrics`/`table`/`diff`/`notice`, fields `text`/`choice`/`multi-choice`/`toggle`/`order`, one submit label); `TaskSurfaceId` / `TaskSurfaceSubmissionId` / `TaskSurfaceDismissalId` branded IDs; `presentationMeta`; a `taskSurface` projection unit; `TaskSurfaceService.getActive` / `submit` / `dismiss`; a `TaskSurfaceDock` in the existing `conversation.input.dock` slot plus one keyed read-only `conversation.chat.toolview` row.
- Data flow: the Host parses and normalises the model, rejects the call when the Session already has an open Surface, mints `surfaceId`, returns canonical `{ surfaceId, model }`, and calls `exec.concludeTurn()` so the agent does not continue past the human checkpoint; `presentationMeta` persists `value.model` so the projector and executor cannot disagree about normalisation; the model lives on `tool/result.meta` while the projection carries only the active identity.
- Non-obvious design decisions: the model contains "no code, callbacks, selectors, HTML, CSS, URLs to executable assets, or expression language" (line 32) and is explicitly *not* a plugin — "Generated code has far more authority and lifecycle cost than a one-turn form needs" (line 11); unknown versions or union arms use the generic tool-result fallback instead of partial interpretation (line 72); the Markdown block forces `remoteImages: 'alt-only'` and "no model-supplied URL is dereferenced without explicit user activation" (line 74); the tool definition **omits** `isConcurrencySafe`, which under the existing tool-registry contract classifies every call as an exclusive ordering barrier without introducing a new `ToolDefinition` field (line 84); the Dock is independent of transcript pagination so an active Surface stays actionable when its `ToolResultNode` is outside the loaded history window (line 105); the model never chooses a tab, dock order, z-index or pixel position (line 109).
- Edge cases / failure handling: submission is transactional at the client boundary — acceptance returns the exact `messageId` in phase `queued`, double clicks and transport retries reuse `submissionId` and return the first result, and another submission id receives `submission-pending` while the first is live (line 187); the service keeps a process-local claim across asynchronous admission and reconnect until a matching durable `user/message` is published or the Agent reports a terminal discard, and **queue-row disappearance alone changes no UI state** (line 191); `session.updateQueue` rejects `edit` and `steer` for a Task-Surface-correlated row and allows `remove` only while queued (line 193); limits are schema-backed configuration (64 KiB model, 64 blocks, 32 fields, 200 table rows, 32 KiB submission) and a new block kind is a protocol change needing a parser, renderer, accessibility behaviour, fallback and replay fixture in the same change (line 76).
- Surprising: the product-side asymmetry is deliberate — the transcript row is kept strictly **read-only** so one Surface cannot acquire competing draft or submission owners, at the cost of a second compact representation while the Surface is active (line 109, echoed in Risks).

### .agents/notes/proposed/feature/2026-08-04-task-surface.i18n.yaml
- Purpose: Sidecar for the task-surface note; 12 keys, one per bespoke section (`declarative-model`, `tool-and-presentation-contract`, `submission-contract`, `lifecycle-and-recovery`, `package-boundaries-and-dependencies`, `delivery-stages`).
- Key abstractions: the seven-package ownership table is inside a `###` block and therefore not hashed.
- Data flow: same loop.
- Non-obvious design decisions: making each contract its own heading is what allows the note to be reviewed piecewise.
- Edge cases / failure handling: none.
- Surprising: the package-boundary table — the note's most consequential content for an implementer — is invisible to the pairing gate.

### .agents/notes/proposed/feature/2026-08-04-task-surface.zh.md
- Purpose: Chinese translation of the task-surface proposal; the largest Chinese file in the shard (25,956 bytes).
- Key abstractions: renders 声明式模型 (declarative model), 提交约定 (submission contract), 生命周期与恢复 and 包装边界 (package boundaries) as Chinese `###` headings.
- Data flow: same Host-normalise → concludeTurn → Dock-submit → queue-admission chain.
- Non-obvious design decisions: the Chinese side keeps the ASCII type names (`TaskSurfaceModelV1`, `show_task_surface`, `presentationMeta`, `exec.concludeTurn()`) exactly, so the TypeScript contract is readable in Chinese.
- Edge cases / failure handling: the transaction/claim/discard lifecycle and the forbidden queue actions are all carried over; the final Risks section enumerates the same six hazards.
- Surprising: the Chinese file is 277 lines and the English 277 — exact parity, the longest exact-parity pair in the shard.

### .agents/notes/proposed/feature/2026-09-08-desktop-mandatory-update-api.md
- Purpose: A self-contained guest-accessible policy endpoint (`GET /api/v0/check_client_update`) so a Desktop client whose business server is local, and which may be signed out, can still learn whether it must upgrade.
- Key abstractions: a request header set (`x-client-platform`, `x-client-version`, `x-client-bundle-id`, `x-client-locale`, `x-client-timezone-offset`, `x-client-arch`, `x-client-update-channel`, `x-client-bundled-dsh-version`); a two-outcome response shape (`code: 0` / `code: 40005` with `data.show_content` and `data.desktop_app_link`).
- Data flow: the server evaluates the current client conditions on every query against server-owned ranges and precedence using complete SemVer; a fresh no-force response clears a known block; a no-force response does not select, replace or invalidate an updater artifact.
- Non-obvious design decisions: `40005` determines *that* an upgrade is mandatory while the updater metadata determines the actual version and package — the two concerns are deliberately split and no `force_update`/`target_version` field is added (line 101); the query parameters `scenario` and `region` must not affect the decision for otherwise identical conditions, so they are ignored server-side (line 57); the platform-specific payload is flattened rather than reusing the mobile `alt_app`/`biz_data` nesting (line 91).
- Edge cases / failure handling: "Service failures must not masquerade as success because success may remove an existing block" (line 105) — missing headers, invalid SemVer and unsupported platform/arch/channel combinations must return explicit parameter errors, never a false no-force; the gateway must preserve the JSON body rather than replacing it with generic text or HTML (line 101); `Cache-Control: no-store` is preferred and the gateway must not share responses across client versions, platforms, architectures or channels on URL alone (line 122).
- Surprising: the note insists the page link "remains a fallback after in-app updater integration" and that "every download still requires user action" even under a mandatory policy (line 101) — the API decides *whether*, never *how*.

### .agents/notes/proposed/feature/2026-09-08-desktop-mandatory-update-api.i18n.yaml
- Purpose: Sidecar for the mandatory-update API note; 13 keys, one per bespoke section (`endpoint-and-access`, `request`, `no-mandatory-update`, `mandatory-update`, `errors-and-policy-matching`, `policy-publication-and-current-decisions`, `capacity-and-caching`).
- Key abstractions: same scheme; the JSON request/response examples are code blocks and therefore excluded from hashing.
- Data flow: same loop.
- Non-obvious design decisions: giving the response shapes their own headings makes the two outcome bodies separately translatable and separately reviewable.
- Edge cases / failure handling: none.
- Surprising: the JSON examples — the part an implementer copies — are the part the pairing gate does not check.

### .agents/notes/proposed/feature/2026-09-08-desktop-mandatory-update-api.zh.md
- Purpose: Chinese translation of the mandatory-update API proposal; the localized `show_content` strings are already Chinese in the English original, so the file is one of the few where the payload text is already the target language.
- Key abstractions: keeps every `x-client-*` header name and the `code` / `biz_code` / `data.show_content` field names verbatim.
- Data flow: same server-side evaluation and no-force-clears-block semantics.
- Non-obvious design decisions: the Chinese side preserves the split between "必须升级" (must upgrade) and "实际版本与安装包由 updater 元数据决定".
- Edge cases / failure handling: the "service failure must not masquerade as success" rule and the no-store/cross-client caching prohibition are carried over.
- Surprising: the Chinese file is 150 lines and the English 150 — exact parity, and one of the only pairs where the *content* is already bilingual.

### .agents/notes/proposed/feature/2026-09-08-desktop-update-extensions.md
- Purpose: Holds four deferred Desktop update capabilities out of the initial release: independent Desktop revisions (`.dsk.N`), stable subscription and channel switching, an automatic-installation setting, and next-launch installation — plus the qualification checklist for the updater dependency and the policy for multiple pending versions.
- Key abstractions: the `.dsk.N` SemVer reservation (`0.1.3-rc.2 < 0.1.3-rc.2.dsk.1 < 0.1.3-rc.2.dsk.2 < 0.1.3-rc.3`); `desktopVersion` / `bundledDshVersion` / `releaseChannel` records; stable (`latest.yml`) vs nightly (`nightly.yml`) feeds.
- Data flow: channel switching may check immediately but download follows the approved setting; old-channel responses are ignored and downloaded artifacts are reconfirmed against the new channel before installation; a channel change does not clear mandatory blocking without a valid policy response for the new conditions.
- Non-obvious design decisions: `0.1.3-dsk.1` is rejected for repairing a stable `0.1.3` because SemVer orders it *below* the stable release — stable fixes need a higher shared patch version (line 28); `allowDowngrade = false` is preserved when assigning the updater channel, and moving Nightly→stable keeps a higher installed Nightly until a higher stable exists (line 37); "Replacement after readiness is application coordination, not an assumed automatic capability of the updater library" (line 89); a cached ZIP or installer is not proof of completed native preparation (line 56); native installer staging may prevent cancellation or retargeting, so it must not be simulated by deleting native staging directories (line 58).
- Edge cases / failure handling: turning a future automatic setting off prevents new automatic downloads and installations but an active download may complete without a new cancel button (line 52); the multiple-pending-versions table enumerates A→C replacement, C-failure-after-replacing-A, and an intervening D (lines 82–87); cache identity includes artifact metadata and hashes, not just a version string (line 89); "metadata mismatch may invalidate some cache but is not strict revocation" (line 93).
- Surprising: the note keeps a long, explicit qualification table of updater API items (`autoInstallEvent`, object-form `quitAndInstall`, next-launch cache, Windows per-user NSIS, Windows session ending, macOS Squirrel staging, metadata/security defaults, build-tool migration, distributed old clients) each with the verification it requires, and says "this proposal does not claim they have been exercised locally" (line 62).

### .agents/notes/proposed/feature/2026-09-08-desktop-update-extensions.i18n.yaml
- Purpose: Sidecar for the update-extensions note; 13 keys, one per deferred extension section.
- Key abstractions: same scheme; the two large tables (channel feeds, pending-version situations) are excluded from hashing.
- Data flow: same loop.
- Non-obvious design decisions: one heading per deferred capability makes each independently approvable — the note's own acceptance criterion says "Approve each extension independently" (line 103).
- Edge cases / failure handling: none.
- Surprising: the sidecar's key list is effectively the list of things awaiting product approval.

### .agents/notes/proposed/feature/2026-09-08-desktop-update-extensions.zh.md
- Purpose: Chinese translation of the update-extensions proposal.
- Key abstractions: keeps `.dsk.N`, `allowDowngrade = false`, `latest.yml` / `nightly.yml`, `autoInstallEvent`, `quitAndInstall` and `NSIS` verbatim; renders the candidate Chinese helper copy as a quoted string.
- Data flow: same channel/pending-version semantics.
- Non-obvious design decisions: the Chinese side carries the "pre-download vs auto-install" distinction and the "not simulated by deleting native staging directories" caveat.
- Edge cases / failure handling: the whole qualification table and the pending-version situation table are reproduced.
- Surprising: the Chinese file is 113 lines and the English 113 — exact parity.

### .agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.md
- Purpose: The umbrella note for Desktop updates: it owns outstanding release/backend/CDN/product decisions and states which sibling document owns what; it also carries the CDN and capacity qualification checklist.
- Key abstractions: a three-document ownership table (this note / mandatory-update API / deferred extensions); the qualification checklist as unchecked `- [ ]` boxes rather than prose.
- Data flow: release owners must qualify signed Windows x64 and macOS x64/arm64 upgrades end to end (discovery, download, hash and signature checks, task-safe shutdown, installation, restart, new-version Host startup, profile reconciliation) and publish immutable packages and blockmaps before the mutable Nightly feed.
- Non-obvious design decisions: automatic *discovery* is kept while automatic *download* and automatic *installation* are not, because every initial transfer and retry requires user action independently of later installation approval (line 44); automatic restart or installation on ordinary quit is rejected because it "bypasses explicit task-impact approval" (line 46); the mandatory-policy API and the updater metadata feed stay separate even though both are remote, reusing only the installation coordinator once qualified (line 48).
- Edge cases / failure handling: if newer version C appears while A downloads or waits for installation, A is retained until product owners approve replacement — "never silently turn approval for A into installation of C" (line 27); the CDN checklist requires measuring fixed-URL replacement across regions because "a purge is not a guarantee of immediate global visibility" (line 35); the capacity note gives real numbers (100,000 online clients at ten-minute polling average ≈ 167 checks/second; 1,000,000 ≈ 1,667) and warns "a functional probe is not a load test" (line 39).
- Surprising: the checklist is written as **unchecked boxes** rather than requirements, because these are pending operations decisions, not shipped behaviour — the note is careful not to present unresolved choices as configuration.

### .agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.i18n.yaml
- Purpose: Sidecar for the update-policy note; 9 keys, with `/proposal/cdn-and-capacity-qualification` naming the checklist section — which in the English file is anchored with an explicit `<a id="cdn-and-capacity-qualification">` HTML anchor so a prose cross-reference can reach it (English line 29).
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the manual HTML anchor exists because the checklist is linked from prose; the pairing record picks the anchor's target heading as a key.
- Edge cases / failure handling: none.
- Surprising: the shard's only use of a raw HTML anchor, showing that the note format permits anchors when a heading slug is not stable enough to cite.

### .agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.zh.md
- Purpose: Chinese translation of the update-policy note; preserves the checkbox list, the ownership table and the Tencent Cloud documentation links.
- Key abstractions: renders 运维 (operations) and 发布负责人 (release owner) as the two accountable roles.
- Data flow: same qualification flow.
- Non-obvious design decisions: the Chinese side keeps the `- [ ]` checkboxes exactly, which is what makes the list still usable as a checklist in both languages.
- Edge cases / failure handling: the "never silently turn approval for A into installation of C" rule is carried over.
- Surprising: the Chinese file is 59 lines and the English 59 — exact parity.

### .agents/notes/proposed/feature/2026-10-03-pi-extensions-bridge.md
- Purpose: An experimental bridge that loads **unmodified** Pi 1.0.0 extension sources and serves Pi's `ExtensionAPI` from existing DSH extension points, answering two questions at once: how much of a third-party extension runs unchanged, and which DSH core mechanisms are narrower than Pi's.
- Key abstractions: `ctx.piExtensions`; a per-Session runtime (module evaluated once per row, factory run once per Session); an ordered per-Session handler queue; a **tool-name/argument translation table** for the six shared built-ins (`bash`, `read`, `edit`, `write`, `grep`, and Pi's `find` ↔ DSH's `glob`); ignorable `plugin:`-prefixed Session records.
- Data flow: a cordis.yml row names one extension source (file / directory with `index.ts`/`index.js` / a Pi package directory listing `pi.extensions`) and its flags; `jiti` imports the source so TypeScript loads in a built installation; the loader resolves Pi's own imports (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) to the bridge's own dependencies; Pi's ~40 lifecycle/context/tool/provider events are served by DSH's existing extension points (`agent/created`, `system-prompt/assemble`, `agent/pre-step`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-stopping`, session events, `ctx.tools`, `ctx.commands`, `agent.followup()`/`steer()`/`inject()`, `ctx.subprocess`, `ctx.userQuestions`).
- Non-obvious design decisions: the bridge has its own loader and event dispatcher and does **not** depend on `@earendil-works/pi-coding-agent`, because the exercise is "to carry Pi's API on DSH mechanisms, not to embed Pi's harness" (line 101); "Where Pi fails closed, the bridge does too" — a `tool_call` handler that edits `event.input` gets the call denied, because the logged call would otherwise differ from the executed one (line 65); an event DSH cannot raise is accepted at registration, never raised, and named in a warning at load (line 63); extension state lives in the Session log so it follows resume and fork, written as ignorable `plugin:` records that are not `SessionEventMap` members and are therefore skipped by a build without the bridge (line 71); the tool translation is enforced by a test that fails "when a mapped parameter is renamed or removed, or when a tool gains a parameter the table has not classified" (line 57).
- Edge cases / failure handling: all Pi handlers for one Session run through one ordered queue so "a notification never overtakes an earlier one, and an awaited hook such as `tool_call` runs after every notification queued before it" (line 51); extension code runs with the Host process's full authority and one uncaught error stops every Session (line 137); the bridge does not scan `~/.pi` or `.pi`, install packages, or decide project trust (line 21); an extension importing a module the loader cannot resolve fails to load with an error naming the module (line 26).
- Surprising: the note's second half is a **15-row ranked gap table** of DSH core mechanisms narrower than Pi's, each with a tracking issue (#5661–#5675) — per-request input rewrite, tool-argument rewrite, session tree / assistant-message replacement, awaited step-end and pre-commit hooks, tool progress and result replacement, per-tool exposure, input admission, plugin-owned durable records, compaction customisation, lifecycle reasons, Host-plugin display, command capabilities, provider request hooks, and fault isolation (lines 79–95). It is a self-audit produced incidentally by an ecosystem bridge.

### .agents/notes/proposed/feature/2026-10-03-pi-extensions-bridge.i18n.yaml
- Purpose: Sidecar for the pi-extensions-bridge note; 13 keys, with the 15-row gap table inside `/proposal/core-mechanisms-narrower-than-pi-s` excluded from hashing as a table.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the gap table's per-row issue numbers (#5661–#5675) live in a table and are therefore not translation-checked, though they are the note's most actionable output.
- Edge cases / failure handling: none.
- Surprising: the gap table — arguably the shard's most valuable self-assessment artefact — is exactly the part the pairing gate cannot see.

### .agents/notes/proposed/feature/2026-10-03-pi-extensions-bridge.zh.md
- Purpose: Chinese translation of the pi-extensions-bridge proposal; the whole body is translated but the entire "Serving the API" mapping table and the gap table keep their English cell contents verbatim.
- Key abstractions: keeps every DSH extension-point name (`agent/pre-step`, `tools/pre-execute`, `ctx.userQuestions`, `ctx.subprocess`) and every Pi API name verbatim.
- Data flow: same loader → per-Session runtime → ordered handler queue → event mapping.
- Non-obvious design decisions: the Chinese side keeps the "Where Pi fails closed, the bridge does too" rule as a bolded sentence with the same example.
- Edge cases / failure handling: the full-authority warning and the "no `~/.pi` discovery" rule are carried over.
- Surprising: the Chinese file is 142 lines and the English 142 — exact parity, despite two large tables remaining English.

### .agents/notes/proposed/feature/2026-10-03-pi-plugins-compatibility.md
- Purpose: A **six-level support ladder** for Pi's newer Chord-based plugin mechanism, each level naming what a plugin author gets, the upstream change that makes it worth building, and the DSH work it needs — with DSH pinned at level 0 until a trigger occurs.
- Key abstractions: Pi's facet model (`chord.facets` in `package.json`, default `src/session.ts` / `src/tui.ts`, a default-exported `{ id, setup(env) }`); the served services (`SessionDirectory`, `SessionManagement`, `PresentationPlugins`, `AgentController`, `Models`, `Transcript`, `SessionPlugins`, `SlashCommands`, `PresentationUI`); `env.use` / `env.observe` / `env.provide` / `env.provideMany` / `env.replicatedState` / `env.own` / `env.onActivate` / `env.onDeactivate`.
- Data flow: the package depends on `@earendil-works/chord` at one exact version, bundles each selected package with `bundleFacetPackage` into a cache under the Harness home, and loads the `session` entry with `createFacetBundleLoader`; the loader resolves `@earendil-works/chord` to the package's own instance (because Chord identifies replicated state through a module-instance-held registry) and Pi's plugin export to a module defining service tokens with Pi's IDs, since Chord matches services by ID string.
- Non-obvious design decisions: the note's justification for deferring is stated by upstream itself — the plugin stack runs only under `PI_EXPERIMENTAL=1`, the `./experimental/plugin` export has only a `source` condition and the npm tarball excludes its build output, and pi-durable says its "API changes without notice between releases" (line 13); "a plugin can do less than an extension" because the Session worker builds its tool/hook/prompt registry itself and does not expose it as a service (line 14); the Chord host **validates the complete dependency graph and activates providers before consumers**, and a facet requiring a service nobody provides fails to load with an error naming it (line 33, line 72).
- Edge cases / failure handling: the plugin loader "is not a sandbox: plugin code runs with the process's full authority" (line 35); levels 1–4 run plugin code in the Host process where one uncaught error stops every Session (line 137); level 3 depends on a pi-durable type upstream declares unstable (line 138); level 4's Remote endpoint payload is validated by Chord's wire parsers rather than by generated per-method codecs (line 139).
- Surprising: the note's "Runtime differences the plugin model exposes" table (lines 96–102) is an **incidental self-audit of DSH** produced while mapping an external ecosystem: provider replacement (Chord keeps a stable handle across a provider swap; DSH unloads and re-runs a fiber whose injected service changes), fault isolation (one worker process per Session in Pi; one shared Host process in DSH), remote declaration (runtime discovery vs build-time generation), shared state (replicated JSON vs per-domain snapshot/delta), and runtime loading (bundled per facet vs pre-built packages). The note states these differences "also apply to DSH work that has nothing to do with Pi" (line 16).

### .agents/notes/proposed/feature/2026-10-03-pi-plugins-compatibility.i18n.yaml
- Purpose: Sidecar for the pi-plugins note; 14 keys, with one key per support level (`level-1-session-facets` … `level-5-parity`) and one for the runtime-differences table.
- Key abstractions: the level headings make the ladder itself the record's index — you can diff two revisions and see which level changed.
- Data flow: same loop.
- Non-obvious design decisions: naming a heading `level-3-transcript-and-stored-selection` puts a *capability scope* into the machine key.
- Edge cases / failure handling: none.
- Surprising: the sidecar is a usable progress tracker for the ladder; a level that gains or loses detail is visible without reading prose.

### .agents/notes/proposed/feature/2026-10-03-pi-plugins-compatibility.zh.md
- Purpose: Chinese translation of the pi-plugins compatibility ladder; keeps the level table's structure and every service name (`AgentController`, `Models`, `Transcript`, `SessionPlugins`, `SlashCommands`, `PresentationUI`) in English.
- Key abstractions: renders facet as facet throughout, and 复制状态 for replicated state.
- Data flow: same level-by-level mapping, including the Pi-member → DSH-mechanism → difference table for level 1 (`agent.followup()`, `agent.steer()`, `agent.inbox.remove()`, `agent.cancel()`, `ctx.compaction.compactNow()`, a fold over Session events for `waitForPrompt`).
- Non-obvious design decisions: the Chinese side preserves the two upstream-quoted instability sentences verbatim in English inside the Chinese paragraph.
- Edge cases / failure handling: the level-3 unstable-type risk and the level-4 wire-parser risk are carried over.
- Surprising: the Chinese file is 140 lines and the English 140 — exact parity.

### .agents/notes/proposed/process/2026-06-11-api-extractor-reports.md
- Purpose: A deferred proposal to make public-API changes visible as a reviewable diff (api-extractor, or `tsc --emitDeclarationOnly` plus a normalised dump, producing a checked-in `etc/<pkg>.api.md` per package that CI verifies).
- Key abstractions: the checked-in, diffable public-API report as the artefact; CI failing when regeneration differs.
- Data flow: regenerate → diff against the committed report → CI fails on any difference.
- Non-obvious design decisions: the note records that the doc-block-typechecking and event-taxonomy parts of the same effort **did ship** with doc-sync, and only the API-report part remains (line 7); the deferral reason is calibrated to the repo's stage — "low value for an internal monorepo where reviewers already see the source diff" (line 32), with a stated revisit condition ("if the packages are ever published externally").
- Edge cases / failure handling: the report format churns with compiler upgrades, adding a maintenance burden "that buys little while the packages stay unpublished" (line 28).
- Surprising: the proposal keeps its deferral reason in the file as a `## Why deferred` section — the record is designed to be re-read when the triggering condition changes, not merely to be deleted.

### .agents/notes/proposed/process/2026-06-11-api-extractor-reports.i18n.yaml
- Purpose: Sidecar for the api-extractor note; 7 keys, including a bespoke `/why-deferred` key.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the deferral reason gets its own heading so it is translated and hash-checked like any other section, rather than living as a parenthetical.
- Edge cases / failure handling: none.
- Surprising: the note is the shortest in the shard (32 lines) yet has an above-average key count, because the deferral reason is a first-class section.

### .agents/notes/proposed/process/2026-06-11-api-extractor-reports.zh.md
- Purpose: Chinese translation of the api-extractor note; the leading blockquote about the shipped doc-sync parts is reproduced.
- Key abstractions: keeps `etc/<pkg>.api.md` and `tsc --emitDeclarationOnly` verbatim.
- Data flow: same generate-and-verify loop.
- Non-obvious design decisions: the Chinese side keeps the "推迟原因" (deferral reason) as its own `##` section.
- Edge cases / failure handling: none.
- Surprising: the Chinese file is 32 lines and the English 32 — exact parity.

### .agents/notes/proposed/process/2026-06-11-supply-chain-and-vendor-drift.md
- Purpose: Four supply-chain checks, of which the interesting one is a **vendor drift check**: the vendored `vendor/*` tree is enforced in the forward direction (a vendored change requires a manifest update) but nothing verifies the manifest's *claims* — that vendor/ actually equals upstream-at-SHA plus exactly the logged modifications.
- Key abstractions: a per-modification checked-in **patch file**, so "the log entries become verifiable artifacts rather than prose" (line 13); the vendor manifest as the SHA + modification log.
- Data flow: nightly CI shallow-clones the upstream repos at the manifest SHAs, copies the corresponding package sources, diffs against `vendor/*/src`, and fails unless the diff matches the checked-in patches; separately, osv-scanner (or `pnpm audit`) runs on the lockfile on a schedule and on lockfile-touching PRs; a license-inventory script asserts each vendored package carries its LICENSE and that `package.json` `license` fields match `vendor/README.md`; Renovate (or a scheduled agent task) proposes npm updates as small PRs that ride the full gate suite, with vendored packages excluded.
- Non-obvious design decisions: the plan orders the work by cost — item 3 (license inventory) is trivial and goes first, item 1 needs CI network access to private mirrors and a token plus converting the two existing logged modifications into patch files (line 20); the whole vendored-update path is envisioned as a semi-automated agent workflow (fetch upstream, re-apply patches, run gates, open a PR with the manifest table updated) (line 16).
- Edge cases / failure handling: upstream repos are private mirrors, so CI credentials and availability are the main friction; if blocked, the drift check can run as a local scheduled agent task instead of CI (line 35).
- Surprising: converting a prose change log into **patch files** is what turns the drift check from "compare and hope" into a mechanical equality — the patch *is* the specification.

### .agents/notes/proposed/process/2026-06-11-supply-chain-and-vendor-drift.i18n.yaml
- Purpose: Sidecar for the supply-chain note; 7 keys including a bespoke `/plan` key.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: `## Plan` is a legacy skeleton name (the format forbids it in implemented notes but allows it in proposed ones), and it is indexed as its own key.
- Edge cases / failure handling: none.
- Surprising: the presence of a `/plan` key is a reliable marker that a note predates the format-tightening era.

### .agents/notes/proposed/process/2026-06-11-supply-chain-and-vendor-drift.zh.md
- Purpose: Chinese translation of the supply-chain note.
- Key abstractions: keeps `vendor/*/src`, `osv-scanner`, `pnpm audit`, `vendor/README.md` and Renovate verbatim.
- Data flow: same nightly drift job and advisory scanning.
- Non-obvious design decisions: the Chinese side preserves the "patch 文件" (patch file) framing of the verifiable-artifact argument.
- Edge cases / failure handling: the private-mirror/CI-credential friction is carried over.
- Surprising: the Chinese file is 35 lines and the English 35 — exact parity.

### .agents/notes/proposed/process/2026-06-20-discover-package-inventory.md
- Purpose: Make the remaining package and gate inventories **discoverable** rather than hand-maintained, because they are repeated across TypeScript project references, package docs and CI prose and each new package creates avoidable synchronization points.
- Key abstractions: the `packages/<group>/<pkg>` hierarchy plus package manifests as the single canonical source; a generator writes an artefact and a `--check` mode in `hygiene`/`doc-sync` fails on a stale committed copy (the existing `gen-module-graph` / `gen-cordis-catalog` pattern).
- Data flow: the hierarchy drives the aggregate configs' `references`, the module graph and any other full-package list; `doc-sync` becomes the one command that defines and prints its own sub-gates, with docs linking to that command rather than restating a second list.
- Non-obvious design decisions: the note distinguishes static lists that encode **policy** (appropriate) from lists that merely duplicate manifest data or layout facts (friction) (line 13); it records that the earlier `@deepseek-ai/dsh-*` wildcard `paths` map was **reverted** to one explicit alias per package because resolving a wildcard's candidates in order dominated source-launch boot (line 11) — a concrete measured reason why the wildcard shortcut was wrong; the hierarchy should encode broad maintenance policy (core/product, integrations, capability seams, support/test/example) so scripts can tell them apart without a hand-maintained exception list (line 19).
- Edge cases / failure handling: "Discovery scripts can become too clever. The implementation should stay boring: read manifests, filter on explicit fields, print the resolved list, and fail loud." (line 30).
- Surprising: the note carries the `<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->` marker (line 32) — the format contract's explicit allowance for a pre-2026-07-05 file whose alternatives are not reconstructible — and it is used in exactly five places in this shard.

### .agents/notes/proposed/process/2026-06-20-discover-package-inventory.i18n.yaml
- Purpose: Sidecar for the discover-package-inventory note; 5 keys — it has no `## Alternatives considered` section because it carries the pre-format marker instead.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the pairing record records the *absence* of a section by simply not having a key for it, which is a quieter signal than the format gate's explicit comment.
- Edge cases / failure handling: none.
- Surprising: comparing the key list of this sidecar with a conformant one tells you a note predates the format contract without reading either file.

### .agents/notes/proposed/process/2026-06-20-discover-package-inventory.zh.md
- Purpose: Chinese translation of the discover-package-inventory note.
- Key abstractions: keeps `packages/<group>/<pkg>`, `gen-module-graph`, `gen-cordis-catalog`, `--check` and the `doc-sync`/`hygiene` gate names verbatim.
- Data flow: same discovery-plus-verify flow.
- Non-obvious design decisions: the Chinese side preserves the wildcard-revert rationale (including that it "dominated source-launch boot time"), which is the note's only measured argument.
- Edge cases / failure handling: the "stay boring, fail loud" constraint is carried over.
- Surprising: the Chinese file also carries the pre-format marker comment, in English, verbatim (line 32) — a machine-readable token that must not be translated.

### .agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.md
- Purpose: A periodic, out-of-repo workflow that turns *adopted human review feedback* into updates to the `dsh-code-review` skill, using two independently configured reviewer adapters and failing closed.
- Key abstractions: an **acquisition contract** (merge-commit reachability is the sole eligibility check; PR conversation comments are not acquired because current GitHub state cannot prove which surviving commit preceded them after a force-push); an **adoption-evidence** contract built from two PR-specific tree diffs (feedback-time snapshot from `merge-base(B,T)` to `B`; final snapshot from `T` to `M`); a dual-reviewer classification (`human-authored` / `forwarded-automation` / `unclear` × `adopted` / `rejected` / `unclear`); a byte-bounded, versioned JSON reviewer-adapter protocol.
- Data flow: daily run with a two-UTC-day overlap → list PRs merged in the window → collect pre-merge `User` feedback and final PR evidence → two reviewers verify author and adoption → two reviewers classify against the current skill → the primary adapter drafts complete candidate file content → both adapters review the same skill diff → bounded revision loop → documentation and lint gates → a reviewed local working-tree diff (the tool never commits, pushes, opens or merges).
- Non-obvious design decisions: merge status, a resolved thread, an author's "fixed" reply and a same-file edit are **context, not adoption proof** (line 37); a target-only change appears in neither PR patch while a change added to the PR after feedback appears only in the final snapshot, so the two snapshots together isolate causality (line 37); the primary adapter drafts from *structured agreed guidance*, never raw review text, and is tool-free and read-only by adapter-author contract (line 43); the tool refuses to run when the two reviewer commands resolve to byte-identical executables — a "minimum-bar mechanical check", with real independence remaining the operator's responsibility (line 47); a single batch whose adapter output fails schema or id validation is failed closed at the **batch** level — every item in it marked unclear and routed to `excluded` — rather than aborting the run, and the offending raw output is preserved privately (line 41).
- Edge cases / failure handling: the tool rejects staged changes and edits outside the target skill both before running the gates and again before reporting success, so a gate or concurrent process cannot slip through, and it restores its own write on failure using best-effort compare-and-swap (line 43); the promote helper refuses to apply a candidate when the current skill blob differs from the bundle's recorded source blob, "the helper never replaces a newer `SKILL.md` with stale complete-file output" (line 51); review submissions use GraphQL `lastEditedAt` because the REST representation omits edit time, and an equal-timestamp edit is treated as post-merge (line 33).
- Surprising: the untrusted-feedback handling is a prompt-injection defence built into the protocol — feedback is wrapped in a nonce-tagged `<untrusted-feedback nonce="…">` block that every prompt instructs the model to treat as data, and the 128-bit nonce prevents an untrusted body from forging the closing tag (line 47); reviewer subprocesses spawn with a scrubbed environment and `cwd` set to a private run directory rather than the repository root, and every production `git`/`gh`/gate spawn also uses the scrubbed environment so a pre-push hook's routing variables cannot silently redirect the maintainer (line 47). The note also records its own measured dry run: 62 merged PRs scanned, 5 skipped, 426 human feedback items considered, **0 candidates surfaced** (line 72).

### .agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.i18n.yaml
- Purpose: Sidecar for the human-review-maintenance note; 12 keys, one per bespoke subsection (`acquisition-contract`, `adoption-evidence`, `dual-reviewer-classification-and-drafting`, `reviewer-adapter-protocol`, `promotion-contract`, `where-the-mechanism-lives`).
- Key abstractions: the mermaid workflow diagram lives inside `## Proposal` and is a code block, so it is excluded from hashing.
- Data flow: same loop.
- Non-obvious design decisions: giving each contract its own heading makes the six contracts separately reviewable and separately translatable — the note is effectively six small contracts in one file.
- Edge cases / failure handling: none.
- Surprising: the sidecar's key list is a checklist of the note's contractual surface, which is the note's actual payload.

### .agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.zh.md
- Purpose: Chinese translation of the human-review maintenance note; the mermaid flowchart is reproduced byte-identically (it is a code block), and the two reproduced upstream quotations are kept in English.
- Key abstractions: keeps `merge-base(B, T)`, `T`, `M`, `commit_id`, `lastEditedAt`, `origin/master` and the adapter protocol names verbatim.
- Data flow: same seven-step pipeline.
- Non-obvious design decisions: the Chinese side preserves the "context, not adoption proof" framing and the nonce-tag explanation.
- Edge cases / failure handling: the forced-push fail-closed rules and the byte-identical-executable refusal are carried over; the "observed on 2026-07-15" run figures are reproduced with the same numbers.
- Surprising: the Chinese file is 85 lines and the English 85 — exact parity.

### .agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md
- Purpose: Removes a **temporary** mutation command (`migrate:packed-session-fixtures`) while keeping the permanent read-only canonical-layout check, because the command's only remaining purpose was to let in-flight branches carrying older fixture edits converge on current master without re-recording model output.
- Key abstractions: the permanent `scripts/session-fixture-layout.ts` canonicaliser and its snapshot check, versus the temporary branch-facing writer CLI.
- Data flow: the removal depends on a **live inventory** of open pull requests; each affected branch merges current master, runs the migrator once, commits the fixture-only rewrite separately, and verifies the repository-wide snapshot layout check.
- Non-obvious design decisions: the canonicalisation module is explicitly **not** transition residue — snapshot CI uses it to discover future fixtures, decode mixed physical records and compare them with the canonical packed representation, so removing it would remove enforcement (line 25); "Keeping a mutation command after its transition ends adds a second apparent maintenance path beside the permanent read-only snapshot check" (line 11).
- Edge cases / failure handling: the removal depends on live pull-request evidence, not elapsed time, because an incomplete open-branch inventory could strand a contributor with a large unpacked-fixture conflict (line 37); closed or superseded branches require no migration (line 19).
- Surprising: the note's acceptance criteria are written as an *inventory procedure* ("A live open-PR inventory finds no branch …") — a removal gated on evidence rather than on a date.

### .agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.i18n.yaml
- Purpose: Sidecar for the packed-session-fixture-migrator note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: this sidecar and its siblings prove the sidecar scheme generalises to *process* notes about one-off migrations, not just architecture.

### .agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.zh.md
- Purpose: Chinese translation of the packed-session-fixture-migrator note.
- Key abstractions: keeps `scripts/migrate-packed-session-fixtures.ts`, `scripts/session-fixture-layout.ts`, `scripts/session-fixture-layout.snapshot.ts` and `migrate:packed-session-fixtures` verbatim.
- Data flow: same inventory-gated removal.
- Non-obvious design decisions: the Chinese side preserves the "second apparent maintenance path" argument.
- Edge cases / failure handling: the live-evidence requirement is carried over.
- Surprising: the Chinese file is 38 lines and the English 38 — exact parity.

### .agents/notes/proposed/process/2026-08-20-audience-first-documentation-quality.md
- Purpose: Defines "brief, intuitive, friendly" as **reviewable outcomes**, because the existing documentation system has strong placement, freshness, linking, bilingual and source-equivalence checks but does not test whether a reader can finish a task.
- Key abstractions: five definitions — brief, intuitive, friendly, accurate, agent-readable; a table of **criteria by document job** (product quick start, user task guide, contributor tutorial, architecture overview, package/subsystem reference, generated reference, agent instruction/skill, proposed/implemented Agent Note), each with a primary outcome, required entry information and a verification method; the entry-layer/detail-layer split for generated references.
- Data flow: the standing documentation file is condensed to short standing orders that link to one canonical quality reference, creating budget headroom instead of placing another complete standard inside agent context (line 78); a generated reference exposes a compact entry layer (scope, intended lookup, grouping/index, direct links to conceptual guidance, generator/check command) before its exhaustive output, and generators report page words, entry count, heading count and largest section.
- Non-obvious design decisions: a blanket word ceiling is rejected because exhaustive reference rows, public contracts and decision rationale "can be long and correct" — the relevant constraint is *entry-path length and lookup cost* (line 104); readability scores are rejected because formulas "penalize exact technical terms and cannot detect wrong ownership, missing failure behavior, stale commands, or a broken reader journey" (line 108); a second hand-written copy of a durable claim is not a freshness mechanism — high-impact prose needs a named source or a focused check that *consumes* the source (line 15); a page crosses a review threshold when one lookup requires scanning unrelated groups or when one page dominates agent context, and the split must be "by a stable domain already present in source metadata rather than by an arbitrary word slice" (line 82).
- Edge cases / failure handling: the budget manifest records **both** target and temporary ceiling and its check reports or rejects a violated headroom/ratchet state (line 122); the sidecar remains the single consistency record because it preserves equal authority, last-confirmed-text recovery, automatic merge safety, generated-region recording and archive sealing "without creating owner-file conflicts" (line 124); a semantic check must not become "a repository-topology scanner that blocks legitimate changes" (line 135); the audit explicitly uses repository structure and representative pages rather than user research, and maintainers should validate the proposed reader outcomes with real tasks before broad rollout (line 139).
- Surprising: the note ships **measured corpus numbers** to make the argument: 1,042 English Markdown files / 986 Chinese counterparts / 1,106,138 English words, of which Active Agent Notes are 580 files and 637,850 words; 47 subsystem pages hold 100,759 words against 13 user pages' 7,540; 19 fully generated files hold 49,611 words, and generated Cordis regions contribute 34,622 of the subsystem tier's words (lines 21, 25, 35). The generator's completeness guarantee and the reader's lookup cost are treated as **two different problems** that must not be conflated.

### .agents/notes/proposed/process/2026-08-20-audience-first-documentation-quality.i18n.yaml
- Purpose: Sidecar for the audience-first documentation note; 16 keys — the largest in the shard — because the note nests five `###` findings under `## Problem` and six `###` sections under `## Proposal`.
- Key abstractions: the nesting under `/problem/…` is itself the argument structure: five separately named diagnoses, each independently translatable.
- Data flow: same loop.
- Non-obvious design decisions: the corpus measurements live in the `### Baseline` subsection, so they are hashed as one unit and cannot drift between the languages.
- Edge cases / failure handling: none.
- Surprising: this sidecar is the only place in the shard where the *structure of an argument* is machine-readable, and it is the clearest demonstration that the pairing record could support more than translation checking.

### .agents/notes/proposed/process/2026-08-20-audience-first-documentation-quality.zh.md
- Purpose: Chinese translation of the audience-first documentation quality note; reproduces the corpus measurements and the by-job criteria table.
- Key abstractions: renders 以受众为先 (audience-first), 入口层 / 细节层 (entry layer / detail layer) and 检索成本 (lookup cost).
- Data flow: same enforcement-slice sequencing (create and validate `dsh-doc`, review the rendered prototype, add narrow fixtures, extract standing rules, prototype the generated-doc split).
- Non-obvious design decisions: the Chinese side preserves the exact corpus numbers (1,042 / 986 / 1,106,138 / 637,850 / 100,759 / 49,611 / 34,622) so the measurement is checkable in either language.
- Edge cases / failure handling: the nine Risks items are carried over one-for-one, including the "a semantic check can become a repository-topology scanner" caution.
- Surprising: the Chinese file is 139 lines and the English 139 — exact parity.

### .agents/notes/proposed/simplification/2026-09-17-defer-office-background-scheduling.md
- Purpose: Removes the Office→PDF conversion queue's **background scheduling** machinery (foreground promotion/demotion, speculative eviction, a reserved foreground reader allowance, a background concurrency counter) because no production caller submits a background request.
- Key abstractions: `OfficeToPdfPriority`, request `priority`, config `maxBackgroundConversions`; the queue's general resource limits, which remain.
- Data flow: after removal, admit the oldest queued job whose source reservation fits whenever conversion capacity is available; reject a new distinct job when the metadata queue is full; keep joining an existing source job subject to the shared reader limit.
- Non-obvious design decisions: the note refuses to treat "absence from master" as sufficient evidence, because the open delivery-prewarming PR #4064 already provides a concrete prewarming consumer even though its implementation still calls the older `documentRender` API without a priority — "Removing scheduling must first be reconciled with that consumer; absence from master is insufficient evidence to proceed" (line 11); removing the whole shared provider or cache is rejected as exceeding the evidence, since independent conversion and bounded sharing remain coherent capabilities (line 29).
- Edge cases / failure handling: the existing bounded-conversion decision remains active because its cache, authorisation and lifetime rationale still applies; acceptance would replace only its scheduling policy (line 21); out-of-tree callers can use the exposed pre-stable API, and the proposal offers no compatibility alias (line 40).
- Surprising: the note's own acceptance criteria require re-running the caller search *after* reconciling with PR #4064 — a removal proposal that is allowed to change its answer.

### .agents/notes/proposed/simplification/2026-09-17-defer-office-background-scheduling.i18n.yaml
- Purpose: Sidecar for the office-scheduling note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: the sidecar does not encode the "reconcile with PR #4064 first" precondition — the acceptance criterion lives in prose, invisible to the machine record.

### .agents/notes/proposed/simplification/2026-09-17-defer-office-background-scheduling.zh.md
- Purpose: Chinese translation of the office-background-scheduling note.
- Key abstractions: keeps `officeToPdf`, `OfficeToPdfRequest`, `OfficeToPdfPriority`, `maxBackgroundConversions` and `documentRender` verbatim.
- Data flow: same FIFO-with-reservation admission.
- Non-obvious design decisions: the Chinese side preserves the "absence from master is insufficient evidence" reasoning and the PR #4064 precondition.
- Edge cases / failure handling: the "no compatibility alias" statement is carried over.
- Surprising: the Chinese file is 40 lines and the English 40 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-config-only-hmr.md
- Purpose: Narrows DSH's HMR subsystem to **live profile configuration refresh**, dropping running-JavaScript-module replacement (Node-loader internals, dependency traversal, cache backup, old/new plugin fibers, rollback, module watches, import-error formatting).
- Key abstractions: `watchConfig`, `runExclusive`, exact profile/home patch and manifest watches, application-readiness coordination, serialized refresh, disposal drainage — all retained; `baseDir`, `getOuterStack`, `getLinked`, `hmr/change`/`hmr/reload`, the module watcher and dispatch — all removed.
- Data flow: config changes refresh the running profile; source-module, arbitrary `Include` and framework-dependency changes now require a process restart, and the automatic framework-change call to `loader.exit()` is removed.
- Non-obvious design decisions: the note refuses to classify the removed code as unreachable — the opt-in is "real supported behavior" exercised by profile tests, module tests and a built-CLI test, and advertised by generated inspection APIs — so the trade is explicitly "developer continuity for a smaller maintained subsystem" (lines 11, 35); partial removal (dropping only rollback, or delegating replacement elsewhere) is rejected because it can leave cached modules and live fibers from different generations (line 25).
- Edge cases / failure handling: removed source options must produce an explicit migration/configuration error rather than being silently ignored, and the shipped `root: []` rows are updated (line 30); the shipped base composition already uses `root: []` and other profiles disable or omit HMR (line 9).
- Surprising: the note counts its own cost in two currencies — roughly 400 identified source lines and 372 dedicated test lines — while warning that retained configuration code and mixed tests must be counted separately at implementation time (line 17).

### .agents/notes/proposed/simplification/2026-09-19-config-only-hmr.i18n.yaml
- Purpose: Sidecar for the config-only-HMR note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: the note's risk section — the product trade — is one hashed block; the numeric line-count estimates are inside it and are therefore translated as prose rather than as a table.

### .agents/notes/proposed/simplification/2026-09-19-config-only-hmr.zh.md
- Purpose: Chinese translation of the config-only-HMR note; translates "HMR（热模块替换）" on first use and keeps every symbol (`watchConfig`, `runExclusive`, `baseDir`, `getOuterStack`, `getLinked`, `hmr/change`/`hmr/reload`) verbatim.
- Key abstractions: same retained/removed split.
- Data flow: same config-refresh-only behaviour.
- Non-obvious design decisions: the Chinese side preserves the "we do not classify the code as unreachable" honesty and the partial-removal rejection.
- Edge cases / failure handling: the explicit-error-instead-of-silence rule for removed options is carried over.
- Surprising: the Chinese file is 36 lines and the English 36 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-provider-only-instruction-reads.md
- Purpose: Requires a `FileSystem` provider throughout instruction discovery and loading, removing the direct-Node I/O path, because every repository production caller already supplies a provider and the dual path only adds separate error and cancellation coverage.
- Key abstractions: `discoverBaselineInstructionFiles`, `loadBaselineInstructions`, `findProjectRoot`; the removed `nodeStatFile`, `nodeTextChunks`, Node-only missing-path classification, the Node branch of `existsAsMarker`, and the `statFile` selector; the separate `skill-filesystem` owner, which keeps its providerless behaviour.
- Data flow: provider discovery supplies required targets; bounded reads consume those targets through `streamText`.
- Non-obvious design decisions: the plugin's missing-provider no-op is preserved (it returns when `ctx.get('fs')` is absent) while the pure `renderAgentInstructions` API stays providerless (line 17); the semantics that must survive are spelled out precisely — candidate precedence, source and rendered-output byte budgets, cancellation, symlink following, and error semantics where "unavailable candidates cannot imply removal, while root-marker failures remain errors" (line 17); implicitly constructing a local provider is rejected because it "hides filesystem selection and lifecycle ownership" (line 27).
- Edge cases / failure handling: the plugin's providerless composition still loads nothing (line 31); the workspace-context resume process expectation and the `ptc-workspace-context` scenario must retain their text and event order (line 33); useful provider tests must not be replaced by a convenience wrapper that recreates the removed fallback (line 37).
- Surprising: the note distinguishes two kinds of "no provider": the *plugin* may legitimately have none and must no-op, while the *helper functions* must refuse to be called without one — two different answers to the same question, and the note keeps them apart.

### .agents/notes/proposed/simplification/2026-09-19-provider-only-instruction-reads.i18n.yaml
- Purpose: Sidecar for the provider-only-instruction-reads note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none; a clean, minimal sidecar.

### .agents/notes/proposed/simplification/2026-09-19-provider-only-instruction-reads.zh.md
- Purpose: Chinese translation of the provider-only-instruction-reads note.
- Key abstractions: keeps `nodeStatFile`, `nodeTextChunks`, `existsAsMarker`, `statFile`, `streamText`, `renderAgentInstructions`, `skill-filesystem` and `FileSystem` verbatim.
- Data flow: same provider-driven discovery and bounded reads.
- Non-obvious design decisions: the Chinese side preserves the "unavailable candidates cannot imply removal, root-marker failures remain errors" pair.
- Edge cases / failure handling: the workspace-context and `ptc-workspace-context` expectations are carried over.
- Surprising: the Chinese file is 37 lines and the English 37 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-prune-stream-visibility-helpers.md
- Purpose: Removes five unused exported "visibility" queries from the compact Assistant stream implementation (`isVisibleChunk`, `chunkHasVisibleText`, `runFirstVisibleTime`, `assistantStreamHasVisibleContent`, `assistantStreamHasVisibleText`) plus their exclusive private helpers, keeping the first-token, raw-chunk, text-joining and assembly readers.
- Key abstractions: the retained **first-token reader**, which has current consumers in Session Stats and Trajectory; "compact readers avoid materializing per-member expansions, and durable input still uses validating expansion" (the package README owns this constraint).
- Data flow: repository searches find no production caller outside the family; the other consumers are unit tests, package docs and the record-reader reference; the package root and published `./assistant-stream` entry expose them to external callers, whose usage the search cannot establish (line 9).
- Non-obvious design decisions: the retained consumers' timing requirements "do not require the separate whitespace-sensitive visibility classification" — so the two concepts (first-token timing vs. whitespace-aware visibility) were never the same need (line 11); replacing visibility queries with stream expansion is rejected because there is no production caller to migrate and adding replacements "would retain an unused API and introduce the allocations the record readers avoid" (line 25).
- Edge cases / failure handling: dedicated visibility tests are removed and only obsolete assertions inside mixed reader tests are dropped, keeping the fixtures for first-token timing, early exit, raw chunks, text joining and assembly equivalence (line 17); Session formats, model input, transcript content and first-token timing must remain unchanged (line 31).
- Surprising: the note distinguishes "no repository consumer" from "no ecosystem consumer" and refuses the latter claim: "do not claim ecosystem-wide non-use" (line 35).

### .agents/notes/proposed/simplification/2026-09-19-prune-stream-visibility-helpers.i18n.yaml
- Purpose: Sidecar for the stream-visibility-pruning note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-prune-stream-visibility-helpers.zh.md
- Purpose: Chinese translation of the stream-visibility-pruning note.
- Key abstractions: keeps all five removed function names and `hasNonWhitespace` / `blockIsVisible` verbatim, and distinguishes 首 token 读取器 (first-token reader) from 可见性分类 (visibility classification).
- Data flow: same removal plus retained-readers story.
- Non-obvious design decisions: the Chinese side preserves the "do not claim ecosystem-wide non-use" instruction.
- Edge cases / failure handling: the "retain the mixed fixtures" rule is carried over.
- Surprising: the Chinese file is 35 lines and the English 35 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-python-sdk-directional-client.md
- Purpose: Removes the Python SDK client's **unused reverse RPC direction** — the incoming-request queue, the close-time wake-up, `next_request`, `respond`, `respond_error`, `notify`, and the `IncomingRequest` model — because the SDK server declares no server-originated request or client-notification handler.
- Key abstractions: the shared TypeScript transport, which stays bidirectional because the Codex wire adapter uses requests and notifications in both directions; the Python client's own one-way role.
- Data flow: client requests, response validation, incoming notification subscriptions and shutdown stay unchanged; a guard is retained for an unexpected frame containing both `id` and `method` before response matching.
- Non-obvious design decisions: the guard is the interesting part — "Retain an explicit guard for an unexpected frame containing both `id` and `method` before response matching, so a server request cannot settle an unrelated pending client request" (line 15); the shared TypeScript transport is deliberately **not** narrowed (line 23); keeping a generic Python peer for external plugins is rejected because no SDK method describes their request ownership, cancellation or delivery protocol (line 21).
- Edge cases / failure handling: prompt submission still returns the durable enqueue receipt and no per-prompt completion promise or response-based turn result is introduced (line 29); the released Session fixtures and the TypeScript transport are preserved (line 30).
- Surprising: the note separates "this proposal narrows only the Python client" from the shared transport, so a narrow public-API contraction does not drag a shared seam with it.

### .agents/notes/proposed/simplification/2026-09-19-python-sdk-directional-client.i18n.yaml
- Purpose: Sidecar for the python-sdk-directional-client note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-python-sdk-directional-client.zh.md
- Purpose: Chinese translation of the python-sdk-directional-client note.
- Key abstractions: keeps `next_request`, `respond`, `respond_error`, `notify`, `IncomingRequest` and `IncomingRequest` model's "no supported runtime producer" framing.
- Data flow: same one-way client role.
- Non-obvious design decisions: the Chinese side preserves the guard's rationale ("避免服务端请求完成无关的待处理客户端请求").
- Edge cases / failure handling: the durable-enqueue-receipt invariant is carried over.
- Surprising: the Chinese file is 34 lines and the English 34 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-retire-app-bin-boot-helpers.md
- Purpose: Deletes `resolveConfigPath` (with its basename-specific replay substitution) and `loadEnv` from app-boot's production exports, because the supported CLI launcher uses `loadLayeredEnv` and profile boot supplies an absolute path directly.
- Key abstractions: the retained `boot`, `loadLayeredEnv`, shipped profile composition and snapshot replay selection; the fixture-local one-directory `.env` handling that stays local to the single fixture that needs it.
- Data flow: exact-symbol searches find ten `resolveConfigPath` calls in eight fixture drivers, all passing `undefined` for replay mode; the only non-unit `loadEnv` caller is the Loader smoke fixture.
- Non-obvious design decisions: replacing every use with `loadLayeredEnv` is rejected because "layered discovery, filtering, and precedence differ from reading one fixture-local `.env`. Sharing a name does not establish equivalent behavior" (line 25); the note frames this as **partial supersession** — `boot` and fail-loud handling still have owners and the archived shared-app-bin record remains frozen (line 13).
- Edge cases / failure handling: all ten path replacements must remain absolute and select the same files (line 29); the sole environment-loading fixture must preserve its missing-file, present-file and warning behaviour (line 30); accidentally switching the fixture to layered environment discovery would change its test inputs and must be avoided explicitly (line 36).
- Surprising: the note prices the change in both directions — 39 production source/JSDoc lines and ~73 dedicated test lines removed, "less the small fixture-local environment handling and builtin imports; the estimate is not an implemented diff" (line 19).

### .agents/notes/proposed/simplification/2026-09-19-retire-app-bin-boot-helpers.i18n.yaml
- Purpose: Sidecar for the app-bin-boot-helpers note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-retire-app-bin-boot-helpers.zh.md
- Purpose: Chinese translation of the app-bin-boot-helpers note.
- Key abstractions: keeps `resolveConfigPath`, `loadEnv`, `loadLayeredEnv` and `path.resolve` verbatim.
- Data flow: same eight-fixture-driver replacement.
- Non-obvious design decisions: the Chinese side preserves the "sharing a name does not establish equivalent behaviour" argument.
- Edge cases / failure handling: the absolute-path and fixture-behaviour requirements are carried over.
- Surprising: the Chinese file is 36 lines and the English 36 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-retire-prompt-registry-change-event.md
- Purpose: Retires the `system-prompt/change` event and the loss of push observation of prompt-registry changes, because no supported product path requires it.
- Key abstractions: `SystemPrompt`'s emitter; `ScopedLayers`' constructor notification callback, which becomes **optional** — and, notably, must be *omitted* rather than supplied as a no-op (line 17).
- Data flow: the event's declaration, emitter, current documentation, generated discovery entries and notification-specific tests are removed; the existing no-op arguments in `jobs-local` and `mcp-resources` are removed at the same time; shared effects, action rollback, undo ordering, layer reclamation, and `tools/change` with its production consumers are preserved.
- Non-obvious design decisions: the implementation must **amend the active Remote event delivery note** to state that this proposal supersedes only its promise to retain `system-prompt/change`, and must keep that note active and cross-linked rather than rewriting or archiving it (line 19); per-step assembly is explicitly rejected as evidence of compatibility — "rebuilding model input does not replace push observation of registry changes" (line 11).
- Edge cases / failure handling: installed plugins may depend on notifications, or on listener exceptions rejecting registration; they lose both behaviours and repository searches cannot establish their absence (line 34); a future push consumer needs an explicit registration-observation requirement and ownership design before the event is reintroduced (line 34).
- Surprising: the note refuses the tempting "keep it for a future dashboard" argument by asking for a *consumer*, not a hope — "Push observation could support a real consumer, but none is identified in supported product paths" (line 23) — and it distinguishes the two behaviours (notification vs. listener-failure semantics) that are lost.

### .agents/notes/proposed/simplification/2026-09-19-retire-prompt-registry-change-event.i18n.yaml
- Purpose: Sidecar for the prompt-registry-event note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-retire-prompt-registry-change-event.zh.md
- Purpose: Chinese translation of the prompt-registry-change-event note.
- Key abstractions: keeps `system-prompt/change`, `ScopedLayers`, `jobs-local`, `mcp-resources` and `tools/change` verbatim; renders "no-op 回调" (no-op callback).
- Data flow: same removal with shared effects preserved.
- Non-obvious design decisions: the Chinese side preserves the requirement to amend rather than rewrite the active Remote-delivery decision.
- Edge cases / failure handling: the "repository searches cannot establish their absence" caveat is carried over.
- Surprising: the Chinese file is 35 lines and the English 35 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-shell-env-key-declarations.md
- Purpose: Reduces the shell-environment registry's contributor declaration to an explicit readonly collection of **keys**, removing the description objects, `BashEnvVariable`, `BashEnvVariableInfo`, `list()`, description-only validation and the exhaustive-catalog TODO.
- Key abstractions: the registry's retained surface — `register`, `collect`, reserved keys, ownership conflicts, undeclared-output refusal, deterministic environment output, effect disposal; the `DSH_WEB_URL` contributor from the Web bundle.
- Data flow: Bash and PowerShell call `collect`; runtime collection uses only contributor identity, declared keys and resolved values.
- Non-obvious design decisions: the note is explicit that this is an **API contraction, not unreachable-code removal** — the method is discoverable through the Cordis inspection provider (line 11); "Preserve the key ownership declaration independently of presentation metadata" (line 23); `collect()` is explicitly **not** advertised as an equivalent diagnostic replacement (line 34); the `list()` enumeration loss is stated honestly as a real cost to model-written and external plugins (line 34).
- Edge cases / failure handling: the acceptance criteria require re-checking fixed callers, recordings, generic inspection and current product requirements before implementation, and retaining the API if an actual diagnostics consumer now needs it (line 27); no secret-handling or ambient-environment policy changes (line 29).
- Surprising: the note distinguishes "no fixed production caller" from "model-written and external plugins can already discover and call `list()`" — the same careful separation of repository evidence from ecosystem evidence seen in the stream-visibility note.

### .agents/notes/proposed/simplification/2026-09-19-shell-env-key-declarations.i18n.yaml
- Purpose: Sidecar for the shell-env-key-declarations note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-shell-env-key-declarations.zh.md
- Purpose: Chinese translation of the shell-env-key-declarations note.
- Key abstractions: keeps `BashEnvVariable`, `BashEnvVariableInfo`, `list()`, `register`, `collect`, `DSH_WEB_URL` and `tool-cordis` inspection provider verbatim.
- Data flow: same key-only declaration model.
- Non-obvious design decisions: the Chinese side preserves the "API contraction, not unreachable-code removal" distinction.
- Edge cases / failure handling: the re-check-before-implementing criterion is carried over.
- Surprising: the Chinese file is 34 lines and the English 34 — exact parity.

### .agents/notes/proposed/simplification/2026-09-19-trim-session-query-convenience-api.md
- Purpose: Removes four unused `SessionQueryEngine` convenience methods (`readSession`, `readTitle`, `readTitleSnapshot`, `listEvents`) plus the orphaned `SessionLogSnapshot` type and `eventRecords`, and the entries in the type-equivalence manifest and the catalog generator's `LINK_MAP`.
- Key abstractions: the retained query surface — `filterEvents` / `_filterEvents` with their semantic extraction and filtering helpers, `observeSession`, `readTitleSnapshots`, `readSurface`, `readEvent`, listing, search and tracing; the single-service topology owned by the archived unified-query decision.
- Key rationale: these entry points add replay-validation and result-copying paths, wrappers, public types and endpoint-specific tests (line 11).
- Non-obvious design decisions: `filterEvents` is explicitly **kept** because "its provider-independent literal substring scan differs from FTS token matching" and the SQLite query documentation explicitly recommends it — removing it would withdraw a distinct query capability (line 25); the note distinguishes removing convenience operations from removing the single-service topology (line 19).
- Edge cases / failure handling: relevant assertions must be **moved** out of the removed methods' tests rather than deleted, and `readSession`'s additional replay validation accounted for explicitly (line 30); live-source precedence, corruption refusal, cancellation, detached results, cold reads and batch-title behaviour must survive through the retained endpoints (line 30); released Session generations remain unchanged (line 31).
- Surprising: the note tracks the **generated-metadata** consequences of a source removal — the type-equivalence manifest entry and the catalog generator's `LINK_MAP` entry must be removed too, or the generated discovery surface keeps advertising methods that no longer exist (line 15).

### .agents/notes/proposed/simplification/2026-09-19-trim-session-query-convenience-api.i18n.yaml
- Purpose: Sidecar for the trim-session-query note; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/simplification/2026-09-19-trim-session-query-convenience-api.zh.md
- Purpose: Chinese translation of the trim-session-query note.
- Key abstractions: keeps `readSession`, `readTitle`, `readTitleSnapshot`, `listEvents`, `SessionLogSnapshot`, `eventRecords`, `filterEvents`, `observeSession`, `readTitleSnapshots`, `readSurface`, `readEvent`, `LINK_MAP` and `type-equiv.manifest.json` verbatim.
- Data flow: same removal plus generated-metadata cleanup.
- Non-obvious design decisions: the Chinese side preserves the FTS-versus-substring reason for keeping `filterEvents`.
- Edge cases / failure handling: the "move assertions, don't delete them" rule is carried over.
- Surprising: the Chinese file is 35 lines and the English 35 — exact parity.

### .agents/notes/proposed/testing/2026-06-11-deterministic-and-stress-testing.md
- Purpose: Three test-discipline measures: no wall-clock sleeps in tests, a universal replay-invariant fixture, and nightly race stress.
- Key abstractions: `waitForIdle` extended to `waitForStatus` and `waitForEvent(n)`; a shared test helper that replays the agent's session log into a fresh `Session` and asserts `deriveMessages()` equality after **every** test; vitest `--repeat=200 --shuffle`.
- Data flow: the shared harness wraps the loop harness; after each test the log is replayed and the derived-message equality asserted automatically, so the invariant is checked "hundreds of times per CI run across every scenario the suite produces, not twice" (line 18).
- Non-obvious design decisions: the lint rule bans `setTimeout` in `packages/*/tests` outside an allowlisted helper module (line 17); fake timers are reserved for timer-service behaviour because "Fake timers interact subtly with Promise scheduling in the loop — prefer event-driven waits" (line 33); measures 1 and 2 land together because they touch the same helpers, and the nightly job waits until the suite is sleep-free so repeats are fast (line 23).
- Edge cases / failure handling: "any flake found is a bug to fix, never a retry" (line 19) — a flaky failure is triaged, not retried away.
- Surprising: the note names the cost of the current debt precisely — several loop tests synchronise with `setTimeout(30)` sleeps, which "wastes agent cycles on retries and can mask ordering bugs" — i.e. the flakiness costs *agent* budget, not just CI minutes (line 11).

### .agents/notes/proposed/testing/2026-06-11-deterministic-and-stress-testing.i18n.yaml
- Purpose: Sidecar for the deterministic-testing note; 6 keys including a bespoke `/plan` key.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: the sidecar is one of the smallest in the shard for a note whose mechanism is a *test harness*, because the mechanism lives in the body prose rather than in headings.

### .agents/notes/proposed/testing/2026-06-11-deterministic-and-stress-testing.zh.md
- Purpose: Chinese translation of the deterministic-testing note; the leading note about the CI test-reliability skill is reproduced.
- Key abstractions: keeps `waitForIdle`, `waitForStatus`, `waitForEvent(n)`, `deriveMessages()`, `setTimeout(30)` and `--repeat=200`/`--shuffle` verbatim.
- Data flow: same shared replay harness.
- Non-obvious design decisions: the Chinese side preserves the "flake 视为需要修复的 bug，绝不靠重试掩盖" rule.
- Edge cases / failure handling: the fake-timer caveat is carried over.
- Surprising: the Chinese file is 35 lines and the English 35 — exact parity.

### .agents/notes/proposed/testing/2026-06-11-mutation-testing.md
- Purpose: Proposes mutation testing as the counterweight to the per-file 100% coverage gate, because a coverage gate "proves every line *executes* under test — not that any assertion would notice if the line were wrong" (line 9).
- Key abstractions: Stryker (`@stryker-mutator/vitest-runner`) over `packages/*/src`; a tracked **mutation score** with a ratcheting threshold; annotated exclusions for provably equivalent mutants, mirroring the `/* v8 ignore */` policy.
- Data flow: PR-scoped incremental runs (changed files only) as a CI job; nightly full runs recording the score; surviving mutants become work items.
- Non-obvious design decisions: the threshold starts by *recording* the observed baseline and then ratchets upward, "same policy as coverage: thresholds only ever tighten" (line 16); the agent-loop framing is explicit — "Surviving mutants are work items: an agent picks a survivor, writes the killing test, repeats — a well-shaped autonomous loop" (line 17); the plan starts with the smallest, most algorithmic package (`llm`) and measures runtime before expanding (line 22).
- Edge cases / failure handling: mutation testing is expensive, but per-file 100% coverage helps because every mutant is at least reached; if PR-scoped runs stay too slow, they stay nightly-only and the score ratchet carries the gate (line 34) — and that outcome must be *recorded in the note* rather than left implicit (line 29).
- Surprising: the note diagnoses an agent-specific failure mode — "Under agent-written tests, coverage pressure can produce execution-without-assertion" (line 9) — which is exactly the failure mode a per-file coverage gate invites when the tests are machine-written.

### .agents/notes/proposed/testing/2026-06-11-mutation-testing.i18n.yaml
- Purpose: Sidecar for the mutation-testing note; 6 keys including a bespoke `/plan` key.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/proposed/testing/2026-06-11-mutation-testing.zh.md
- Purpose: Chinese translation of the mutation-testing note.
- Key abstractions: keeps Stryker, `@stryker-mutator/vitest-runner`, `packages/*/src` and `/* v8 ignore */` verbatim; renders the "execution-without-assertion" critique as 「执行但不断言」.
- Data flow: same PR-scoped and nightly runs.
- Non-obvious design decisions: the Chinese side preserves the ratchet-only-tightens rule and the agent work-item loop.
- Edge cases / failure handling: the "keep nightly-only and record that outcome" requirement is carried over.
- Surprising: the Chinese file is 36 lines and the English 36 — exact parity.

### .agents/notes/rejected/architecture/2026-06-16-typed-event-schemas.md
- Purpose: A **rejected** proposal (status: "runtime event-schema registry declined; event maps stay compile-time, Zod validates projection state, migrations validate durable payloads") asking whether the harness's core vocabulary should move to runtime schemas.
- Key abstractions: the **merge-extensible map** pattern — a TypeScript `interface` (`SessionEventMap`, `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnTriggerMap`, `TurnEndReasonMap`) that plugins augment by declaration merging, with the public union derived as `Map[keyof Map]`; the `defineTool` `InferArgs` DSL; the `assertNever` exhaustiveness convention; the runtime guard `isJsonValue`.
- Data flow: the pattern is compile-time only — the types vanish at runtime, so the JSONL provider `JSON.stringify`/`JSON.parse`s each event verbatim and the only runtime guard is round-trip serialisability, not structural validation; a plugin that declaration-merges a new event key gets compile-time typing for its own code but nothing validates the values it produces at the producer, at the persistence boundary, or on reload.
- Non-obvious design decisions: the note's structural insight — "**a plugin cannot declaration-merge a Zod schema.** Declaration merging is a TypeScript compile-time mechanism; a Zod schema is a runtime value" (line 20) — which reframes the question from a persistence change into a repository-wide vocabulary redesign; the blast radius is *measured*, not asserted: six merge-extensible maps (~370 LOC), ~10 `declare module` augmentation sites across eight packages, 16 `session.append(...)` call sites in the loop, ~7 switch consumers, the `defineTool` DSL and the architecture docs (lines 28–33).
- Edge cases / failure handling: the deferral deliberately leaves event `data` structurally unvalidated at the durable boundary, so a malformed-but-JSON datum is caught late by a consumer's `switch` — "the status-quo cost, accepted deliberately" (line 68); the hybrid open question is recorded (keep compile-time inference, add an *optional* runtime schema validated only at the persistence/wire boundary rather than on every in-process append) (line 74).
- Surprising: Option B — tighten only the genuinely closed shapes (the JSONL `HeaderLine` guard) with the repo's existing `schemastery` library — is identified as the *proportionate* step, and Option C (a full runtime registry) is deferred to its own implementation Agent Note (lines 59, 63); the note also notes Zod is currently only a transitive dependency while the repo's chosen schema library is schemastery, so adopting Zod broadly would itself be a dependency decision (line 55).

### .agents/notes/rejected/architecture/2026-06-16-typed-event-schemas.i18n.yaml
- Purpose: Sidecar for the typed-event-schemas rejection; 13 keys, with three nested alternatives keys (`a-status-quo-…`, `b-header-closed-shape-validation-only-schemastery-events-stay-opaque`, `c-runtime-schema-registry-for-the-whole-vocabulary-zod-or-schemastery`) and a bespoke `/why-this-is-not-a-persistence-change` key.
- Key abstractions: each alternative is its own `###` heading, so each is separately translatable and separately reviewable.
- Data flow: same loop.
- Non-obvious design decisions: the key slugs encode the option letters (A/B/C), making the rejected alternatives machine-indexed.
- Edge cases / failure handling: none.
- Surprising: the rejected note still uses the full canonical skeleton including `/acceptance-criteria` — the format contract freezes a rejected note as "the proposal, frozen" (see the notes README), so a rejection keeps the shape of a proposal.

### .agents/notes/rejected/architecture/2026-06-16-typed-event-schemas.zh.md
- Purpose: Chinese translation of the typed-event-schemas rejection; the `Status:` line keeps its **English** reason text verbatim ("runtime event-schema registry declined; event maps stay compile-time…"), because the status line is machine-checked.
- Key abstractions: keeps `SessionEventMap`, `ContentBlockMap`, `isJsonValue`, `assertNever`, `defineTool` / `InferArgs`, `schemastery` and `Zod` verbatim.
- Data flow: same compile-time-only analysis and the same measured blast radius (~370 LOC, ~10 augmentation sites, 16 append sites, ~7 switch consumers).
- Non-obvious design decisions: the Chinese side preserves the central "declaration merging is compile-time, a Zod schema is a runtime value" argument and the Option A/B/C structure.
- Edge cases / failure handling: the three open questions are translated in full.
- Surprising: the Chinese file is 75 lines and the English 75 — exact parity.

### .agents/notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.md
- Purpose: A **rejected** proposal to make the turn the only durable boundary by removing `step/start` and `step/end` from `SessionEventMap`.
- Key abstractions: the numeric `step` field retained on step-scoped events; step groups inferred from contiguous events sharing `(turn, step)`.
- Data flow: the loop increments the step counter and records step-scoped events with that number but stops appending open/close boundary events; invariants would enforce valid positive step numbers within an open turn rather than the presence of surrounding records; crash repair would close the turn without inventing step boundary records.
- Non-obvious design decisions: the rejection reason is substantive rather than stylistic — "`step/end` is concrete information: a reader can tell whether a model request finished, crashed, or is being repaired without deriving that state from the next event. A bare `step/start` is likewise useful for a model request that began but produced no chunks before failing" (line 11); the note states plainly what the rejected proposal would have given up — "The log no longer records 'a model request started but produced no event before the process died' as a durable fact" (line 30) — and that this loss is not acceptable while the log is the durable replay and audit surface.
- Edge cases / failure handling: the format version and recorded fixtures are refreshed and non-current stored logs are rejected per the pre-release format policy (line 26).
- Surprising: the rejection is recorded in the `Status:` line itself with its full reasoning, so the verdict is the first thing a reader of the file sees — the notes README's rationale for giving the rejected status "content".

### .agents/notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.i18n.yaml
- Purpose: Sidecar for the drop-durable-step-boundaries rejection; 5 keys, with a bespoke `/what-we-give-up` key instead of `/risks`.
- Key abstractions: the rejected skeleton's canonical trade-off section has its own key.
- Data flow: same loop.
- Non-obvious design decisions: `## What we give up` is the rejected-note counterpart of `## Risks`, and it is hashed independently so the cost of a rejection is translation-checked.
- Edge cases / failure handling: none.
- Surprising: this note has no `/alternatives-considered` key because it carries the pre-format marker instead — the sidecar's key list shows both the section set and the era.

### .agents/notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.zh.md
- Purpose: Chinese translation of the drop-durable-step-boundaries rejection; the `Status:` line keeps its English reason verbatim, including the clause "makes crash repair, invariants, and transcript inspection clearer than inferring completion from adjacent step-scoped events".
- Key abstractions: keeps `SessionEventMap`, `step/start`, `step/end`, `deriveMessages()`, `ACP` and `(turn, step)` verbatim.
- Data flow: same step-scoped-event-with-field model that the rejection argues against.
- Non-obvious design decisions: the Chinese side preserves the "concrete information" argument that decided the rejection.
- Edge cases / failure handling: the format-version refresh and the "what we give up" section are carried over.
- Surprising: the Chinese file is 32 lines and the English 32 — exact parity.

### .agents/notes/rejected/simplification/2026-06-20-fold-session-persistence-interface.md
- Purpose: A **rejected** proposal to fold the abstract `SessionPersistence` service, the shared write coordinator and the persistence contract helpers into `dsh-session`, deleting `@deepseek-ai/dsh-session-persistence` as a package.
- Key abstractions: the Service Definition package as "the intended modular role split for the durable-persistence capability seam"; the JSONL and SQLite backend packages, which would remain separate and register the session-owned service.
- Data flow: providers depend on the service contract; `agent-loop` finds a sibling service for resume; after the move, backends depend on `dsh-session` directly and `agent-loop` resume uses the session-owned service key.
- Non-obvious design decisions: the rejection turns on ecosystem stage, not on architecture — "if third-party persistence backends were already a public ecosystem, the separate Service Definition package would be a cleaner SDK boundary; pre-release, the extra package looks like abstraction before there is an external Consumer" (line 29); the note also notes that the split made sense when persistence was a new swappable-backend design and that the mutable summary's removal is what made the package mostly a wrapper (line 11).
- Edge cases / failure handling: the capability-seams guidance would need an explicit exception, because persistence is not like bash or LLM — "its vocabulary and lifecycle events are already the session package's core domain" (line 17).
- Surprising: the note distinguishes "the concept is duplicated" from "the package boundary is duplicated" — the concepts (`SessionHeader`, `SessionEvent`, `SessionId`, `session/event`, `session/flush`) already belong to `dsh-session`, and that is not the same argument as removing the package.

### .agents/notes/rejected/simplification/2026-06-20-fold-session-persistence-interface.i18n.yaml
- Purpose: Sidecar for the fold-session-persistence rejection; 5 keys with a bespoke `/what-we-give-up`.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard rejected-note skeleton.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/rejected/simplification/2026-06-20-fold-session-persistence-interface.zh.md
- Purpose: Chinese translation of the fold-session-persistence rejection; the `Status:` line keeps its English reason verbatim.
- Key abstractions: keeps `dsh-session-persistence`, `dsh-session`, `SessionPersistence`, `SessionHeader`, `SessionEvent`, `SessionId`, `session/event`, `session/flush` and `agent-loop` verbatim.
- Data flow: same proposal (rejected) and the same post-acceptance dependency shape.
- Non-obvious design decisions: the Chinese side preserves the "abstraction before there is an external Consumer" argument.
- Edge cases / failure handling: the capability-seams exception requirement is carried over.
- Surprising: the Chinese file is 31 lines and the English 31 — exact parity.

### .agents/notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.md
- Purpose: A **rejected** proposal to keep only the last completed turn on load, dropping the whole synthetic-close machinery (`interruptedTurnClosers()` synthesising error `tool/result` events, `step/end`, `turn/end { kind: 'interrupted' }`).
- Key abstractions: the persisted turn boundary as "a completed `turn/end` is the checkpoint. Anything after the last checkpoint is crash tail" (line 17); the `interrupted` turn-end reason.
- Data flow: on load, a backend still tolerates and truncates a torn final record, but if the parsed durable prefix ends after an open `turn/start`, the canonical repair drops every event after the previous `turn/end` — no synthetic events of any kind.
- Non-obvious design decisions: the rejection weighs two costs against each other — the current machinery "invents events that never happened", and a synthetic tool result "means the resumed log contains model-visible text that no tool produced" (line 11) — but the real work is preserved: "A crash can lose real work from the final turn: assistant text, tool calls, and tool output appended after the previous `turn/end`" (line 30). The rejection says that loss is acceptable, and says why: the product is unreleased, the final-turn recovery semantics are not user-proven, and "a clean completed-turn checkpoint is much easier to explain, test, and implement" (line 30).
- Edge cases / failure handling: the note is precise about the future path — "A future 'recover partial crashed work' feature should be designed as an explicit user-facing recovery view, not as synthetic events silently inserted into the canonical transcript" (line 30); `TurnEndReasonMap` would drop the `interrupted` variant and the format version and fixtures would be refreshed with no migration path (lines 21, 26).
- Surprising: the rejection explicitly accepts losing real work and accepts the synthetic-events cost in exchange for interpretability — and it names the shape of the eventual correct solution (a user-facing recovery view).

### .agents/notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.i18n.yaml
- Purpose: Sidecar for the truncate-interrupted-turns rejection; 6 keys, with a bespoke `/what-we-give-up` and a bespoke `/related`.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: the `/related` key captures the note's cross-links to the session-persistence docs and the universal turn-enclosure invariant — machine-readable provenance for a rejection.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.zh.md
- Purpose: Chinese translation of the truncate-interrupted-turns rejection; the `Status:` line keeps its English reason verbatim ("a single turn can contain substantial real work, including many steps and large tool output").
- Key abstractions: keeps `interruptedTurnClosers()`, `tool/result`, `step/end`, `turn/end { kind: 'interrupted' }`, `TurnEndReasonMap` and `turn/start` verbatim.
- Data flow: same load-time repair semantics (as proposed, and rejected).
- Non-obvious design decisions: the Chinese side preserves the "invented events that never happened" argument and the future recovery-view prescription.
- Edge cases / failure handling: the torn-record tolerance and the no-migration path are carried over.
- Surprising: the Chinese file is 36 lines and the English 36 — exact parity.

### .agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.md
- Purpose: A **rejected** proposal to prune `ctx.skills.register()`, `SkillRegistration`, the runtime pseudo-provider, runtime revisions/cache branches and runtime-only normalisation, plus `SkillSummary.whenToUse`, `SkillCandidate.path` and `SkillDefinition.path`.
- Key abstractions: the provider contract every shipped skill already uses; the deliberately open `metadata` extension point; `providerRevision` retained as the in-flight discovery epoch while completed catalogues are keyed by cwd alone.
- Data flow: every provider mutation synchronously clears the cache, and the post-await revision comparison already prevents inserting stale work (line 13); tests needing an embedded skill register a small real provider.
- Non-obvious design decisions: the rejection states the reason as intent — "Direct runtime skill registration is an intentional extension path for third-party plugins" (the Status line) — and the alternatives section keeps the embedder path alive by describing the provider-wrapper that could expose the same embedded data under effect-owned lifetime (line 19); the scope exclusion is explicit and important: agent-scoped system-prompt sections, tool providers and variables are deliberately registered during `setup(agentCtx)` through the agent-owned context, so "absence of a fixed in-repo scoped registration is not evidence of non-consumption" (line 15).
- Edge cases / failure handling: skill-local frontmatter parsing must continue to preserve and validate the supported metadata schema, and external providers remain able to supply embedded, filesystem, remote or other sources (line 29); the removed fields are "not observationally identical" for external consumers (line 29).
- Surprising: the note argues for a *cache-key simplification* (cwd-only completed cache) on the grounds that the revision epoch is only needed for in-flight invalidation — a smaller change than the API pruning it accompanies (line 13).

### .agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.i18n.yaml
- Purpose: Sidecar for the prune-skill-registry rejection; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard rejected-note skeleton.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.zh.md
- Purpose: Chinese translation of the prune-skill-registry rejection; the `Status:` line keeps its English reason verbatim.
- Key abstractions: keeps `ctx.skills.register()`, `SkillRegistration`, `SkillSummary.whenToUse`, `SkillCandidate.path`, `SkillDefinition.path`, `providerRevision`, `disableModelInvocation`, `resourceBase` and `setup(agentCtx)` verbatim.
- Data flow: same cwd-only completed-cache key with a revision epoch for in-flight invalidation.
- Non-obvious design decisions: the Chinese side preserves the "absence of a fixed in-repo scoped registration is not evidence of non-consumption" caveat and the agent-scope exclusion.
- Edge cases / failure handling: the frontmatter-validation requirement is carried over.
- Surprising: the Chinese file is 29 lines and the English 29 — exact parity.

### .agents/notes/rejected/simplification/2026-07-19-fold-compaction-package-split.md
- Purpose: A **rejected** proposal to move the basic compaction implementation into `@deepseek-ai/dsh-compaction` and remove `@deepseek-ai/dsh-compaction-basic`.
- Key abstractions: `ctx.compaction`, `CompactionResult`, the shared transcript and tool-pairing helpers; `summarize()` preserved as a protected customisation hook.
- Data flow: shipped configurations load only the basic package, and no production package independently consumes the Service Definition package except that provider (line 9); the split added a package manifest, README, project boundary, dependency edge, abstract forwarding class, generated catalog entries and composition wiring "without demonstrating backend substitution" (line 11).
- Non-obvious design decisions: the rejection turns on the capability-seam rule that requires "a real interface, implementation, and consumer rather than a preemptive split" (line 11) — and, crucially, on **planned** demand: "More compaction backends are planned, so the Service Definition and basic provider packages remain separate" (the Status line); the note says the recallable-compaction proposal adds a *consumer* of compaction results, "not necessarily another implementation", and a remote summariser can use the protected hook (line 23).
- Edge cases / failure handling: a separate Service Definition package is reintroduced "only when a second complete backend and an independent Consumer need substitution" (line 17); the naming decision is explicit — keeping `compaction-basic` would "make the product service appear to be one optional backend", whereas `compact` is already the stable service identity used by `ctx.compaction` (line 25); the acceptance criteria enumerate the behaviours that must survive (cancellation, locking, token accounting, tool pairing, durable events, cited source-event seqs, retry convergence, transcript rendering) (line 32).
- Surprising: the note's alternatives section treats the *recallable* proposal as a **consumer**, not an implementation — a fine distinction that decided the case, and a useful way to think about when a seam is justified.

### .agents/notes/rejected/simplification/2026-07-19-fold-compaction-package-split.i18n.yaml
- Purpose: Sidecar for the fold-compaction-package-split rejection; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard rejected-note skeleton.
- Edge cases / failure handling: none.
- Surprising: none.

### .agents/notes/rejected/simplification/2026-07-19-fold-compaction-package-split.zh.md
- Purpose: Chinese translation of the fold-compaction-package-split rejection; the `Status:` line keeps its English reason verbatim.
- Key abstractions: keeps `@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`, `ctx.compaction`, `CompactionResult` and `summarize()` verbatim.
- Data flow: same seam/consumer/implementation distinction.
- Non-obvious design decisions: the Chinese side preserves the "recall adds a consumer of compaction results, not necessarily another implementation" argument and the naming rationale.
- Edge cases / failure handling: the reintroduce-only-when-a-second-backend-and-consumer condition is carried over.
- Surprising: the Chinese file is 37 lines and the English 37 — exact parity.

### .agents/notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.md
- Purpose: A **rejected** proposal to replace three hand-rolled promise-wrapped timers (`cancellableDelay()` in llm-retry, a `sleep()` in workflow-worker-thread, `delay()` in terminal-bash) with `node:timers/promises`.
- Key abstractions: `setTimeout(ms, undefined, { signal })`, `setTimeout(ms, undefined, { ref: false })`, `import { setTimeout as delay }`; the empty `catch` naming the abort rejection per the repo's empty-catch rule.
- Data flow: llm-retry's helper resolves `true` on elapse and `false` on abort today; the rewrite changes it to try/catch control flow where the promise rejects only with the abort error and a pre-aborted signal rejects immediately (line 19).
- Non-obvious design decisions: the decisive reason is **not** in the proposal but in the implementation: "implementation (PR #679) falsified the parity premise: vitest's fake clock does not intercept `node:timers/promises`, so the swap costs deterministic fast tests for ~10 deleted lines" (the Status line) — the swap would have made the test suite slower and less deterministic to save ten lines.
- Edge cases / failure handling: the rejected status records the whole trade explicitly, so a future proposer sees the cost before re-proposing; the acceptance criteria demand the three packages' suites pass unchanged (behavioural parity) (line 33).
- Surprising: this is the shard's clearest example of a rejection whose evidence comes from *attempting the change* rather than from reasoning about it — and of the value of keeping the failed attempt's reason in the record.

### .agents/notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.i18n.yaml
- Purpose: Sidecar for the builtin-timer-promises rejection; 6 keys.
- Key abstractions: same scheme.
- Data flow: same loop.
- Non-obvious design decisions: none beyond the standard rejected-note skeleton.
- Edge cases / failure handling: none.
- Surprising: the sidecar records the proposal's *shape* but not the implementation finding that killed it — the Status line (which is English, and is not hashed) carries the real reason, so the machine record alone would show a clean, plausible proposal.

### .agents/notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.zh.md
- Purpose: Chinese translation of the builtin-timer-promises rejection; the `Status:` line keeps its English reason verbatim, including the vitest-fake-clock finding.
- Key abstractions: keeps `node:timers/promises`, `cancellableDelay()`, `workflow-worker-thread`, `terminal-bash`, `llm-retry`, `setTimeout(ms, undefined, { signal })` and `{ ref: false }` verbatim.
- Data flow: same timer-replacement shapes (as proposed, and rejected).
- Non-obvious design decisions: the Chinese side preserves the PR #679 falsification and the "deterministic fast tests for ~10 deleted lines" trade.
- Edge cases / failure handling: the "suites pass unchanged" parity criterion is carried over.
- Surprising: the Chinese file is 37 lines and the English 37 — exact parity.

### .agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md
- Purpose: A **rejected** note that freezes roughly thirty **negative** dependency verdicts from a ten-way-parallel "Not Invented Here" audit, so the next audit starts from the verdicts instead of re-deriving them.
- Key abstractions: the dependency policy ("would a maintained external package or Node builtin delete it with a net win?"); the four groups the verdict list is organised into — protocol and parsing, retry/timers/async, data and validation, filesystem/subprocess/terminal, servers and HTTP, SQLite and storage, repo tooling.
- Data flow: the note records, per candidate, the concrete reason the swap fails: `vscode-jsonrpc` cannot express the configured `maxMessageBytes` and inverts the cancel-grace teardown semantics and errors on pre-header stdout banners and is CJS in an ESM repo; `eventsource-parser` would add a dependency to a browser-safe package for ~15 lines of framing with both wire ends in-repo; `p-retry`/`exponential-backoff` has the wrong execution model because "the plugin is a decision-returning waterfall listener and the agent loop owns re-execution from the durable log; there is no function to re-invoke"; `AbortSignal.timeout` "cannot be disarmed early and carries a generic `TimeoutError`, not the capability-coded `TimeoutReason`"; `structuredClone` "accepts Map/Date/-0 and enforces nothing" where the hand-rolled `isJsonValue` enforces the lossless-JSON boundary; `write-file-atomic` lacks the private 0700 staging dir, Win32 DACL copy/`ReplaceFileW`, AbortSignal support and parent-dir fsync; `strip-ansi` "demonstrably leaks unterminated-OSC payloads the session-title normalizer must strip (anti-spoofing)"; `better-sqlite3` would complicate the single-file executable packaging; `@landstrip/landstrip` "fails the security-invariant test" because the Landlock launcher is a ~300-line reviewable C file with byte-pinned binaries.
- Non-obvious design decisions: the note's purpose is inverted — "The negative verdicts carry equal value — each names a plausible-looking swap whose hand-rolled shape is load-bearing — but would otherwise live only in a PR body. This note freezes them." (line 9); it also records a *partial* consolidation opportunity rather than pretending none exists (the YAML `!!js` tag duplication is deletable, ~20–25 lines, but the consolidation moment is a future include sync, not now) (line 72); and it explicitly says a future proposal for any item "must beat its recorded reason, not just re-cite the policy" (line 13).
- Edge cases / failure handling: where an owning Agent Note already rejected the alternative (retry, token-meter, schema DSL, zstd, sandbox, node-pty), this note cites rather than duplicates it (line 78); one rejected note per item was rejected as "~30 files of ceremony for verdicts that share one evidence standard and one fate" (line 77).
- Surprising: several verdicts are about **test-tooling fidelity**, not production semantics — `msw` is rejected because the mock server exists "to fault the wire — socket destroy, mid-SSE disconnect, stall, pre-listen refusal — for real HTTP adapters and subprocesses; in-process interception can express none of that", and `node:timers/promises` is rejected for breaking vitest's fake clock. The audit's evidence standard includes *whether the tool keeps the tests honest*, not only whether it is smaller.

### .agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.i18n.yaml
- Purpose: Sidecar for the NIH-audit rejection; only 4 keys (root, `/problem`, `/proposal`, `/alternatives-considered`) because the note has no `## Acceptance criteria` and no `## Risks` sections — all the substance is in the proposal body's grouped bullet lists.
- Key abstractions: the same scheme; the grouped verdict lists live inside `/proposal` and are hashed as one large block.
- Data flow: same loop.
- Non-obvious design decisions: the proposal section's slug is generic, so the sidecar alone does not reveal that it contains thirty verdicts — the note's size and shape are visible only in the body.
- Edge cases / failure handling: none.
- Surprising: this is the largest single hashed block in the shard (the whole verdict catalogue hashes as one unit), so any edit to any one verdict invalidates the whole block — the sidecar is coarse here in a way it is fine-grained elsewhere.

### .agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.zh.md
- Purpose: Chinese translation of the NIH-audit rejection; the `Status:` line keeps its English reason verbatim ("every swap below fails the net-simplification bar on evidence; recorded so the survey is not re-run from scratch").
- Key abstractions: keeps every candidate package name and repo symbol verbatim — `vscode-jsonrpc`, `vscode-languageserver-types`, `json-rpc-2.0`, `jsonrpcclient`, `eventsource-parser`, `p-retry`, `p-timeout`, `AbortSignal.timeout`, `p-limit`/`p-queue`, `async-mutex`, `Ajv`, `structuredClone`, `fast-deep-equal`, `safe-stable-stringify`, `gpt-tokenizer`, `partial-json`, `write-file-atomic`, `fzstd`, `picomatch`, `istextorbinary`, `shell-quote`, `strip-ansi`, `pidtree`, `execa`, `tree-kill`, `node-pty`, `msw`, `hono`/`sirv`, `better-sqlite3`, `wireit`, `@arethetypeswrong/cli`, `syncpack`/`manypkg`, `remark-validate-links`, `prebuildify`, `@landstrip/landstrip`, `hatch-nodejs-version`, `js-yaml`/`yaml`.
- Data flow: same seven grouped verdict lists (protocol and parsing; retry, timers and async; data and validation; filesystem, subprocess and terminal; servers and HTTP; SQLite and storage; repo tooling).
- Non-obvious design decisions: the Chinese side preserves each verdict's *specific* reason rather than a generic "not equivalent" — for example `vscode-jsonrpc` "cannot express the configured `maxMessageBytes` incoming-size bound", `events.once` "rejects if `error` fires first, but the hand-roll deliberately ignores `error`", `structuredClone` "accepts Map/Date/-0 and enforces nothing", and `stripVTControlCharacters` "demonstrably leaks unterminated-OSC payloads the session-title normalizer must strip (anti-spoofing)".
- Edge cases / failure handling: the YAML consolidation verdict is translated with its partial outcome intact — roughly 20–25 lines of duplicate `!!js` tag definitions are deletable, but "the consolidation moment is a future include sync, not now"; the note's closing alternatives are carried over, including the "one rejected note per item is ceremony" judgement.
- Surprising: the Chinese file is 78 lines and the English 78 — exact parity, and the only Chinese file in the shard that renders ~40 package names in a single translated list without a single dropped item.

## Ideas worth stealing

- **Split the compaction checkpoint into frozen index stubs plus exactly one mutable state checkpoint** — `.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md:53` — the request prefix becomes `[system][stubs…][state][tail]`, and because frozen stubs are byte-stable across passes the prompt-cache miss starts at the token replacing the previous state checkpoint instead of at position zero. August's compaction currently rewrites a head checkpoint every pass, which is exactly the position-zero miss this removes; the same note's inflation guard (line 33) gives August a cheap "did compaction actually help?" check by comparing one metric (provider usage, else the character estimator) on both sides.
- **Make shadowed history reachable with code-composed pointers plus two pure-log tools** — `.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md:25` — every checkpoint ends with `[checkpoint c<summarySeq>: shadows conversation span #<start>–#<end>; originals retrievable via history_read]`, assembled by *code* from the summary event's seq and shadowed range so the model never writes a pointer it could get wrong; `history_read` / `history_search` then re-read the shadowed span from the log. Recall stays a pure function of the log (line 90) because an LLM call in the recall path breaks keyless replay determinism — exactly August's requirement that a session log reconstructs identically.
- **The whole-value event rule, with a generic seq-guarded client store** — `.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md:23` and `:92` — a state-carrying log event carries the complete post-change state, never a delta, so a consumer can treat the latest pushed value as final (out-of-order immunity by seq, self-healing because a missed update is corrected by the next). The client then keeps one generic `key → { value, seq }` store under a single higher-seq-wins rule, and the host is the only place a projection is computed (`:58`) — a domain ships with **zero client code**. August's brain/permission/goal state could adopt this to collapse the per-domain fences it currently maintains.
- **Ride the baseline on the tail page so the client has no refetch decision** — `.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md:77` — the moments a client needs a fresh baseline (open, reconnect resync, gap repair) are exactly the moments it already pulls the history tail page, and the only path that never needs one (`loadOlder`) is the only path that passes `beforeSeq`. August's front-end currently re-derives "what is current" separately; this deletes that decision instead of managing it.
- **Log command outcomes durably, as `command/run` + `command/done`** — `.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md:126` — a slash command's outcome is currently a transient notice that a refresh or a second tab loses; two log-only events make refresh persistence, multi-tab sync and fork/resume recovery free (`:132`). August's `/compact`, `/brain`, `/memory` commands have the same loss.
- **Require an `AbortSignal` on every tool-reachable async capability, enforced by the compiler** — `.agents/notes/proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.md:17` — omission must fail TypeScript compilation, not be discovered at runtime; the note also forbids ambient async-local cancellation (`:39`) and never-abort defaults (`:41`), because both hide the missing owner. August's own cancellation story (turn cancellation, tool timeouts) currently relies on every intermediate layer remembering to forward a signal; this makes forgetting impossible to compile.
- **Declare derived media and reset them on a closed damage-class list; keep authoritative media loud** — `.agents/notes/proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md:27` and `:29` — `DomainSpec` gains `recovery?: 'reject' | 'reset'`, and only three deterministic parse-time codes (`version-mismatch`, `malformed-medium`, `invalid-record`) may trigger a destroy-and-reopen; ENOENT and every I/O error stay loud. This is the generalisation August needs for its projection caches, usage ledger and brain-derived tables, where a corrupt derived file must never brick boot while a corrupt authoritative one must.
- **Keep cleanup dependencies alive until consumers finish — and prove it with one controlled promise** — `.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md:15` and `:81` — the rule is that a resource's owner retains it through the consumers' complete asynchronous cleanup, and the test recipe is a controlled-promise regression: pause the real consumer before its last dependency use, start provider disposal, release the pause, await both. The reproduced failures are concrete and DSH-shaped: `domain 'audit' is closed` (`:35`), `NOT_COMMITTED` after a successful credential write (`:41`), `SSH connection is closed` during subprocess termination (`:49`). August's shutdown path has the same class of ordering hazard around the brain DB, the session writer and credential commits.
- **A pre-tool input rewrite must be atomic across three readers** — `.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md:13` — `assistant/message` (model history), `tool/call` (durable audit) and the presentation layer all read pre-execution arguments *before* the tool runs, so a partial rewrite would make the UI show one command while another ran. The registry's structured-clone + deep-freeze + non-writable identity makes a partial rewrite *unrepresentable* (`:19`), which is the part worth copying: if August wants to rewrite tool arguments, the rewrite must happen before identity creation, not via a mutable execution object.
- **Two-stage refactor: mechanical extraction first, behaviour second, with an honest table of what stage one did NOT achieve** — `.agents/notes/proposed/architecture/2026-09-14-composer-model-and-draft-editor.md:65` and `:53` — stage two is forbidden from moving files, renaming, extracting helpers, reordering tests or cleaning formatting, and stage one publishes a table stating that two editors per session, independent IME/Undo origins and multi-view picker routing are *not* achieved. August's own recent refactors would benefit from the "isolation achieved vs. not achieved" table: it stops a directory move from being reported as a state separation.
- **Byte-identical system prompts for forked/side sessions, and a sourced message as the merge-back carrier** — `.agents/notes/proposed/feature/2026-07-08-interactive-side-sessions.md:16` — "Keeping the system prompt byte-identical preserves the provider prefix cache over inherited history", and the advisor framing plus the merge-back note are both plugin-sourced `context/message`s, so no new session event is needed and replay stays exact. August's subagent/spawn paths currently pay for a distinct system prompt; this note shows how to get a separate conversation without paying a separate prefix.
- **A bounded, versioned, declarative UI model instead of bespoke panels or generated code** — `.agents/notes/proposed/feature/2026-08-04-task-surface.md:32` and `:78` — the model contains "no code, callbacks, selectors, HTML, CSS, URLs to executable assets, or expression language"; limits are schema-backed configuration (64 KiB model, 64 blocks, 32 fields, 200 table rows, 32 KiB submission); unknown versions fall back to the generic tool result rather than being partially interpreted (`:72`); and the Markdown block forces `remoteImages: 'alt-only'` with no model-supplied URL dereferenced without explicit user activation (`:74`). This is directly transferable to August's "ask the user a structured question" surface.
- **Quarantine unreadable history instead of letting it brick every later request** — `.agents/notes/proposed/bug-fix/2026-08-20-attachment-read-quarantine.md:13` — one missing or corrupt attachment makes every subsequent model request fail on the same object; the fix records a durable `attachment/quarantine` event, replaces the image with deterministic text, skips the read on later requests, and only restores it after digest + metadata verification (`:17`). August has the same shape of problem with tool outputs that reference vanished files.
- **Per-domain backend routing so a hot domain can move off the human-readable backend without touching consumers** — `.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md:101` and `:293` — `routes: { workspace: 'sqlite' }` selects a backend per domain; "routing is configuration; consumers unchanged", and the migration cost is "migrate the data by hand once". August's brain DB and session sidecar tables are exactly this shape.
- **Serialise writes in the domain layer and let the backend promise only per-call atomicity** — `.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md:49` and `:160` — the backend does not promise ordering within a unit ("the caller serializes"); the domain owns one promise chain per domain and `update(key, fn)` runs its fn on that chain so concurrent read-modify-write cannot interleave. This is the cleanest statement of the ordering boundary anywhere in the shard.
- **Staged abstraction refactor with a switchable enforcement gate (warn → enforce)** — `.agents/notes/proposed/architecture/2026-09-06-logical-session-storage-rebuild.md:94` — the gate that reports bindings of the concrete class ships as `warn` (prints, emits one `::warning` annotation per finding, exits 0) so in-flight branches merge, and an env var flips it to `enforce` for one run. August can use the identical shape to migrate a wide surface without blocking anyone's branch.
- **A universal replay-invariant fixture, and no wall-clock sleeps in tests** — `.agents/notes/proposed/testing/2026-06-11-deterministic-and-stress-testing.md:18` and `:17` — a shared harness replays every test's session log into a fresh `Session` and asserts `deriveMessages()` equality automatically, so the invariant is checked hundreds of times per CI run instead of twice; a lint rule bans `setTimeout` in `packages/*/tests`. August's own "session.messages is what the next turn sends" invariant deserves the same universal assertion, especially given that August has no test suite left.
- **Mutation testing as the counterweight to a coverage gate when the tests are agent-written** — `.agents/notes/proposed/testing/2026-06-11-mutation-testing.md:9` and `:17` — a per-file 100% coverage gate proves every line *executes*, not that any assertion would notice if the line were wrong, and "under agent-written tests, coverage pressure can produce execution-without-assertion". The surviving-mutant loop ("an agent picks a survivor, writes the killing test, repeats") is exactly the autonomous work item shape August already uses for skills.
- **Freeze the negative dependency verdicts** — `.agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md:9` — the negative verdicts "carry equal value … but would otherwise live only in a PR body", and a future proposal for any item "must beat its recorded reason, not just re-cite the policy" (`:13`). August's own "why not use library X" reasoning is scattered; a single frozen catalogue of ~30 rejected swaps (each with the concrete reason — wrong execution model, cannot express a needed bound, inverts teardown semantics, breaks the test fakes) is directly reusable.
- **Record a rejection with the reason the implementation failed, not just the argument against** — `.agents/notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.md:3` — the Status line reads "implementation (PR #679) falsified the parity premise: vitest's fake clock does not intercept `node:timers/promises`, so the swap costs deterministic fast tests for ~10 deleted lines". This is the most useful form of a rejected note: it prevents the next person from re-deriving the failure.
- **Keep durable boundaries that record facts the log otherwise cannot reconstruct** — `.agents/notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.md:11` — `step/end` is "concrete information: a reader can tell whether a model request finished, crashed, or is being repaired without deriving that state from the next event", and a bare `step/start` covers "a model request that began but produced no chunks before failing". August's turn/step boundaries should be judged by the same test: can the log answer "did this finish, crash, or get repaired?" without inference?
- **Preserve the tail of an interrupted turn rather than truncating it, and say what the future feature must look like** — `.agents/notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.md:30` — the rejection accepts that a crash can lose real work and explains that a future "recover partial crashed work" feature "should be designed as an explicit user-facing recovery view, not as synthetic events silently inserted into the canonical transcript". The distinction — synthetic repair events versus a recovery view — is the part worth carrying into August's resume path.
- **An ecosystem survey doubles as a self-audit of your own gaps** — `.agents/notes/proposed/feature/2026-10-03-pi-plugins-compatibility.md:96` and `.agents/notes/proposed/feature/2026-10-03-pi-extensions-bridge.md:79` — the plugin note's "runtime differences the plugin model exposes" table compares Chord and DSH on provider replacement, fault isolation, remote declaration, shared state and runtime loading, and admits these differences "also apply to DSH work that has nothing to do with Pi"; the bridge note produces a 15-row ranked gap table of DSH mechanisms narrower than Pi's, each with a tracking issue. Mapping a foreign harness onto your own services is a cheap way to find your own seams.
- **Two Chord mechanisms worth stealing regardless of Pi** — `.agents/notes/proposed/feature/2026-10-03-pi-plugins-compatibility.md:108` and `:109` — *stable service handles* (a consumer keeps its handle while a provider is replaced, so a plugin reload does not restart its dependents and lose their state — DSH's equivalent unloads and re-runs the fiber) and *declaration before activation* (the host rejects a missing provider, a duplicate provider, or a cycle before any facet activates; "Cordis resolves dependencies as services appear, so a fiber with a missing provider stays pending until an audit after startup reports it"). Both are direct answers to August's plugin-reload and missing-dependency problems.
- **Untrusted content in an agent prompt needs a nonce, not a warning** — `.agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.md:47` — feedback is wrapped in a nonce-tagged `<untrusted-feedback nonce="…">` block that every prompt instructs the model to treat as data, and "the 128-bit nonce prevents an untrusted body from forging the closing tag". The same note refuses to run when the two reviewer executables are byte-identical (`:47`) and scrubs the environment for every `git`/`gh`/gate spawn so a pre-push hook cannot redirect the maintainer.
- **A per-heading hash pairing record for bilingual docs, with an explicit regenerate command** — `.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.i18n.yaml:1` and `:4` — each heading section gets an `en:`/`zh:` hash of its block (excluding code blocks and generated regions), and `pnpm run verify-translation-pairing --write <file.md>` re-records after an edit. August has no equivalent, and the same sidecar mechanism could track *API-contract* drift between two implementations instead of two languages.
- **Separate "required" from "unknown": report a missing total honestly instead of fabricating a percentage** — `.agents/notes/proposed/architecture/2026-09-29-session-migration-follow-redirect.md:38` — "Unknown totals produce no fabricated percentages", and the redirect ("302" as a business result, not an HTTP redirect, accepting no arbitrary URL, `:13`) keeps migration progress out of the session log entirely (`:17`). August's long-running operations (backend updates, brain maintenance) could use the same typed-redirect shape instead of pushing progress into the transcript.

## Files skipped (with reasons)

None. All 150 files in this shard were opened and read; none was skipped as generated, vendored, binary or huge-data. Every file is hand-written prose or a small YAML pairing record.

Depth is uniform within the shard but is **not** uniform across files, and this is worth stating plainly:

- The 50 English `.md` notes were read **line by line in full** (435,117 bytes).
- The 50 `.i18n.yaml` sidecars were read **line by line in full** (76,122 bytes).
- The 50 Chinese `.zh.md` counterparts were read as follows: 37 files were read **in full**, covering every file at or below 9,876 bytes; the remaining 13 files (all above 12,000 bytes — `domain-kv-storage-and-workspace`, `session-projection-and-command-log`, `task-surface`, `pi-extensions-bridge`, `unified-typert-remote-metadata`, `cordis-cleanup-dependency-lifetimes`, `recallable-compaction`, `dependency-swaps-rejected-by-nih-audit`, `audience-first-documentation-quality`, `pi-plugins-compatibility`, `human-review-skill-maintenance`, `logical-session-storage-rebuild`, `composer-model-and-draft-editor`) were read as **head (first 30 lines) + tail (last 25 lines) windows**, 715 lines in total across all 13. For those 13 I additionally had the complete heading map of every file (an `^#{1,3} ` grep over the whole tree returning all 387 heading matches with line numbers), the complete English original, and the per-section hash pairing record — so the structure, the opening argument and the closing verdict of each is known in full, and the body of each is known from its English twin. The middle of those 13 Chinese files was not read line by line; their per-file notes above are therefore written from the English original plus the Chinese head/tail and heading map, not from a full Chinese read.

## Uncertainties

- **The pairing-record hash function was not located.** I inferred its scope (a heading's own direct text, excluding subsections and code blocks) from evidence inside the shard rather than from the tool that computes it. The evidence: `2026-09-10-session-data-compatibility.i18n.yaml:11-13` and `2026-09-10-session-refactor-faq.i18n.yaml:11-13` both carry the *same* value `986dd8097aac4d3d` for their `/proposal` key on both the `en` and `zh` sides, and in both files the `## Proposal` heading is immediately followed by a `###` subheading — i.e. the section's own direct text is empty in both languages. I did **not** read `docs/i18n/README.md` or `scripts/verify-translation-pairing.ts` (they are outside this shard and outside my assignment), so I could not confirm the hash algorithm, the normalisation rules, or whether an empty section is intentionally hashed to a constant. If it is not, the identical value would instead mean both files share the same Proposal body, which the files' content contradicts.
- **A matching en/zh hash pair is ambiguous.** Because of the above, a sidecar line where `en == zh` cannot be distinguished from "both sides empty" without opening both files. I checked the two instances I found and both were empty-body cases, but I did not check every one of the ~1,000 hash pairs in the shard for that pattern.
- **The five Chinese files that keep English canonical headings** (`2026-09-10-session-capability-protocols.zh.md`, `2026-09-10-session-data-compatibility.zh.md`, `2026-09-10-session-developer-transition.zh.md`, `2026-09-10-session-refactor-faq.zh.md`, `2026-09-20-unified-typert-remote-metadata.zh.md`) mix English `##` headings with Chinese `###` headings. I could not determine whether that is a deliberate convention for the 2026-09-10 batch or a drift, because the rule lives in `docs/i18n/README.md`, which is outside this shard.
- **The shard's relationship to the shipped code was not verified.** Every note here is `Status: proposed` or `Status: rejected`, and several refer to shipped mechanisms by path (for example `packages/session/session-persistence-jsonl/src/storage.ts`). I did not open any of those source files — they belong to other shards — so the notes' claims about current behaviour are taken as the notes state them, not independently confirmed. In particular, the "implemented" counterparts these notes link to (`../../implemented/...`) were not read.
- **Implementation status of the proposals is unknown.** Two notes explicitly say parts have shipped (the storage-root note's global-root change and the audience-first note's slices 1–3), but the `Status: proposed` line on both suggests the notes were never moved to `implemented/`. I did not check the `implemented/` tree, so I cannot say whether these decisions landed, were revised, or remain proposals.
- **Middle bodies of the 13 largest Chinese files were not read line by line** (see above). If a translation diverges from its English twin in a proposition-table cell, my note would not catch it; the pairing record's hash would, and that is precisely the check I could not run.
- **The manifest's own reconciliation was taken on trust.** The shard list was produced by filtering the manifest's fourth column for exactly `dsh-notes-proposed`, as instructed; I did not re-derive it from `git ls-files` in the clone, and I did not verify that no file in the clone under `.agents/notes/proposed/` or `.agents/notes/rejected/` is missing from the manifest (those directories may hold additional notes assigned to other shards — for example the `rejected/architecture/` and `rejected/simplification/` notes I read are in the shard, but I did not enumerate the directories independently to confirm completeness).
