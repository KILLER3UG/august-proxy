# deepseek-harness / dsh-session#1

## Shard shape

This shard is the entire `packages/session/` group of the deepseek-harness repo (260 files, ~2.3 MB): the **durable session data plane**, not the agent loop itself. It is organised in four families that stack bottom-up. (1) A **format chain**: one pure library (`session-format`) that compiles a unique, gap-free chain of *adjacent* format migrations, and four frozen edge packages (`v0→v1`, `v1→v2`, `v2→v3`, `v3→v4`) plus a build-static `session-format-catalog` that assembles them into one reader — the point of the whole group is that a log written by any released harness version can still be read losslessly, one physical row at a time, without ever materialising the old format in memory. (2) A **persistence seam** (`session-persistence`) defining the `ctx.sessionPersistence` service and the per-session `SessionHandle`, plus the shipped **JSONL backend** (`session-persistence-jsonl`) that stores one immutable, optionally Zstandard-compressed generation file per session and publishes a verified successor generation after a migration. (3) **Durability policy**: `session-checkpoint-policy` wraps `llm/stream`, `tools/execute` and `agent/pre-step` so a model request and a top-level tool side effect are on disk before the thing they cause happens, and `session-log-deepseek` ships the incremental canonical log to the official DeepSeek API with a durable acceptance watermark. (4) **Read models**: `session-projection` (a registry that folds committed events into whole current values), `session-projection-cache` (durable checkpoints of those folds), and `session-stats` (one concrete projection unit). The agent loop, memory/brain, tool registry and prompt assembly live in other shards; this shard is the *storage and derivation* half of the harness, and it is where the repo's hardest correctness work sits: a migration that changes event cardinality, a writer that publishes an immutable successor generation, and a checkpoint that must never be ahead of the log it describes.

---

## Per-file notes

### packages/session/README.md
Package map for the durable session data plane: 13 packages in four families (persistence, projection, titles, telemetry) with their ctx keys, plus links to the backend-neutral subsystem pages.

### packages/session/README.zh.md
Chinese translation of the same package map; no new mechanism.

### packages/session/README.i18n.yaml
Bilingual-pairing record: per-heading-section hashes of the English and Chinese README blocks, re-recorded with `pnpm run verify-translation-pairing --write` — a doc-consistency gate that makes "the zh side drifted" a build failure rather than a review comment.

### packages/session/session-format/src/types.ts
- Purpose: the type contract for the whole migration machinery.
- Key abstractions: `SessionFormatHeader` (logical metadata), `SessionFormatEvent` (one decoded event), `SessionFormatArtifact` (header + inherited cut + events), `SessionFormatMigration` (name, fromVersion, toVersion, `migrateHeader`, `createStage`, `validateTargetHeader`), `SessionFormatMigrationStage` (stateful per-artifact body stage), `SessionFormatRestore` (caller-owned single-pass row restore).
- Data flow: physical row → codec decoder → migration stage(s) → current artifact.
- Non-obvious design decisions: `sourceKind: 'decoded' | 'transformed'` (types.ts:66) tells an edge whether its input is physical decode output or a prior migration's *validated* output — that is what lets a frozen edge re-validate only what it owns.
- Edge cases / failure handling: `validateTargetHeader` exists so the *target writer* can refuse a header the edge produced.
- Surprising: `inheritedEventCount` is documented as "available only after a body read" (types.ts:40) — the inherited cut is a body property, not a header one.

### packages/session/session-format/src/chain.ts
- Purpose: compile the unique adjacent migration chain.
- Key abstractions: `defineSessionFormatMigration` (validates + freezes a declaration), `CompiledSessionFormatChain`.
- Data flow: constructor builds `byFrom: Map<version, migration>`; `plan(from)` walks v0→vN; `createStream` composes stages.
- Non-obvious design decisions: the constructor refuses any migration whose `toVersion !== fromVersion + 1` (chain.ts:30) and any gap (chain.ts:68) — the chain is *adjacent by construction*, not by convention, so a future format must add one edge package, never a span.
- Edge cases / failure handling: `throwUnsupportedRefusal` (chain.ts:244) re-wraps any non-migration error as `SessionFormatUnsupportedMigrationError` with the edge name and the source version, so the caller always learns *which* edge refused.
- Surprising: a migration that declares a version *beyond* `currentVersion` is refused at construction time (chain.ts:72-75), so the build cannot ship a forward edge by accident.

### packages/session/session-format/src/catalog.ts
- Purpose: physical version dispatch and header classification.
- Key abstractions: `createSessionFormatCatalog` → `readHeader` (returns `current | migration-required | unsupported | malformed`), `createRestore`, `encodeCurrentHeader`, `encodeCurrentEvent`.
- Data flow: `readHeader` inspects only the version field, then the codec's `decodeHeader`, then `chain.migrateHeader` — never the body.
- Non-obvious design decisions: codecs are validated to be exactly one per version `0..currentVersion` at construction (catalog.ts:37-43), so a missing or extra codec is a module-init failure, not a runtime surprise.
- Edge cases / failure handling: a stored version *newer* than the build returns `unsupported` with an explicit "upgrade the harness" reason rather than an error.
- Surprising: `readHeader` does the full header migration (not just version classification), so a listing can show the *current* header of an old log without touching the body.

### packages/session/session-format/src/json.ts
Lossless-JSON snapshot helpers plus the shared coordinate checks: `sessionFormatCount` (non-negative safe integer, explicitly rejecting `-0` because JSON cannot preserve it), `sessionFormatSafeInteger`, `sessionFormatVersion`, `snapshotSessionFormatJson`, `snapshotSessionFormatHeader`. The `Object.is(value, -0)` check is a genuinely good detail — JSON.stringify turns `-0` into `0`, so a negative-zero coordinate would silently change meaning on disk.

### packages/session/session-format/src/filename.ts
Canonical generation basename rules: `session.jsonl` for v0, `session.vN.jsonl` for N≥1, and a parser that refuses temporary, uppercase, leading-zero, `.v0` and compression-suffixed names. The strictness is the point — a filename is the *only* thing the backend trusts to pick a generation.

### packages/session/session-format/src/context.ts
`SessionFormatEventCollector`: the migration context that expands compact runs into retained events. Twenty-seven lines, and it is the seam that keeps memory bounded.

### packages/session/session-format/src/error.ts
Two error classes: `SessionFormatError` and `SessionFormatUnsupportedMigrationError` ("a readable artifact whose released source policy has no supported migration"). The split matters: the second is a *policy* refusal, the first is a *data* refusal.

### packages/session/session-format/src/index.ts
Barrel re-exporting the seven session-format modules.

### packages/session/session-format/tests/chain.spec.ts
Unit suite for the chain: current input bypasses every stage (asserted with a `vi.fn` spy, chain.spec.ts:86-99), one edge composes, and every invalid declaration / incomplete chain is refused.

### packages/session/session-format/tests/catalog.spec.ts
Catalog unit suite: header classification, single-pass restore, and that an unhandled compact run expands without an intermediate array (catalog.spec.ts:345-367).

### packages/session/session-format/tests/json.spec.ts
JSON unit suite: refuses `-0`, `Infinity`, `undefined` members, sparse arrays, symbol and non-enumerable members, array own-properties, cycles and custom prototypes; confirms `__proto__` keys survive as data and the prototype stays `Object.prototype`.

### packages/session/session-format/tests/filename.spec.ts
Filename unit suite pinning the canonical names and every rejected variant.

### packages/session/session-format/package.json
Library manifest for the pure migration machinery; one runtime dep (`dsh-util-values`), cordis as peer only — the library is deliberately not a plugin.

### packages/session/session-format/tsconfig.json
Project references (`vendor/cosmokit`, `vendor/cordis`, `util/values`).

### packages/session/session-format/tsdown.config.ts
tsdown build for the ESM library bundle.

### packages/session/session-format/README.md
Library contract: one restore pass, `readHeader` classification, recoverable vs strict recovery, and the stated limitation that "final current history remains resident" (the returned event array is O(event count)).

### packages/session/session-format/README.zh.md
Chinese translation of the session-format library contract.

### packages/session/session-format/README.i18n.yaml
Bilingual pairing hashes for the session-format README.

### packages/session/session-format-catalog/src/generated.ts
- Purpose: the build-static owner of codec and edge ordering.
- Key abstractions: `sessionFormatCatalogOptions` (currentVersion 4, codecs v0..v4, the four edges, `currentEncoder`), `sessionFormatCatalog`.
- Data flow: `createSessionFormatCatalog(sessionFormatCatalogOptions)` at module load.
- Non-obvious design decisions: the file is *generated* by `scripts/gen-session-format-catalog.ts` and imports the edge packages directly rather than through mounted plugins ("The direct imports make historical readability independent of mounted plugins", generated.ts:3).
- Edge cases / failure handling: `restoreCurrent` runs the full installed-current validation; `restoreTransformedCurrent` deliberately skips it for already-current input.
- Surprising: `restoreCurrentHeader` asserts the V4 header *and* revalidates it against the installed Session package, so a header that passes the frozen V4 rules can still be refused by the live build.

### packages/session/session-format-catalog/src/children.ts
`createSessionFormatCatalogWithChildren(children)`: binds one parent's historical child evidence into the V3→V4 edge by swapping in a closure-created migration, leaving every other edge untouched (children.ts:17). The evidence is retained unchanged for the catalog's lifetime.

### packages/session/session-format-catalog/src/historical.ts
A second, V0–V3-only catalog used to collect child prerequisites *without* recursively completing parent catalogs — the anti-recursion seam. It restores V0–V3 with the frozen released-V3 event vocabulary.

### packages/session/session-format-catalog/src/current.ts
Delegates final current-format validation to the installed `dsh-session` package via `Session.fromRestore`, so the format layer does not duplicate the live Session's rules. The version-skew check happens *before* the installed validation (current.ts:19-23).

### packages/session/session-format-catalog/src/message-projections.ts
A browser-safe list of the installed message interpreters (`imageOffloadProjection`); recovery listeners are mounted by their owning plugins, not here.

### packages/session/session-format-catalog/src/index.ts
Barrel exporting the static catalog, the child-bound factory, the historical catalog and the unsupported-migration error.

### packages/session/session-format-catalog/tests/catalog.spec.ts
Integration suite: every adjacent edge is statically owned through the current writer (catalog.spec.ts:30), and a post-release payload addition survives restoration *without* being frozen (catalog.spec.ts:64-79).

### packages/session/session-format-catalog/tests/children.spec.ts
Proves that a historical body read requires explicit child facts ("explicit historical child facts", children.spec.ts:12), and that interleaved restores over different parents stay isolated (children.spec.ts:17-37).

### packages/session/session-format-catalog/tests/current.spec.ts
Pins the installed-current rules: version skew is rejected first; a `request/header` `reason` must be `initial`/`resume`/`change`/`series`, and `startsSeries` must be true when present.

### packages/session/session-format-catalog/tests/developer-history.spec.ts
Proves tool-addition/removal history survives restoration *and* forks: it reconstructs the active tool set from `request/header` events plus `developer/message` blocks, then asserts the same sequence after a restore and after a fork seed (developer-history.spec.ts:80-120). Also pins that a `tool-addition` block stores only the *name*, never the inline schema (developer-history.spec.ts:76-78).

### packages/session/session-format-catalog/tests/preset-migration.spec.ts
Every historical preset selection migrates to `ptc` (including inherited and local selections), and a V3 session with a *custom* preset literally named `code` is **not** reinterpreted.

### packages/session/session-format-catalog/package.json
Library manifest depending on all four edge packages plus the image-offload projection; exports a `./message-projections` subpath.

### packages/session/session-format-catalog/tsconfig.json
Project references for the catalog package.

### packages/session/session-format-catalog/tsdown.config.ts
tsdown build for the static catalog library.

### packages/session/session-format-catalog/README.md
Contract: build-static first-party inventory, production reads use `{ recovery: 'recoverable', validation: 'transformed' }`, worker/fixture verification uses `{ recovery: 'strict', validation: 'current' }`, and "a profile cannot add, remove, or reorder an edge by mounting a feature plugin".

### packages/session/session-format-catalog/README.zh.md
Chinese translation of the catalog contract.

### packages/session/session-format-catalog/README.i18n.yaml
Bilingual pairing hashes for the catalog README.

### packages/session/session-format-v0-to-v1/src/dispositions.ts
- Purpose: the frozen top-level payload disposition for every released-v0 event type.
- Key abstractions: `ReleasedV0PayloadDisposition` = `{required, optional, opaque}` per event type; `RELEASED_V0_EVENT_TYPES` = the sorted 51-type inventory.
- Data flow: the dispositions drive `assertReleasedEventPayload`, which rejects an unexpected member and validates nested semantics.
- Non-obvious design decisions: the `opaque` list (e.g. `tool/result.meta`, PTC `arguments`) is retained as lossless JSON *without* Session-sequence interpretation — the boundary between "we check this" and "we preserve this" is data, not code.
- Edge cases / failure handling: `defineReleasedPayloadDisposition` freezes all three arrays so a consumer cannot mutate the inventory.
- Surprising: the inventory is exactly 51 types, and three of them (`assistant/chunk`, `tool/code-dispatch`, `tool/code-dispatch-start`) are *not* in the installed current vocabulary — the frozen reader still owns them.

### packages/session/session-format-v0-to-v1/src/payload-validation.ts
1062 lines of frozen nested payload validation: every known event type's nested fields, content blocks (text/reasoning/image/file/tool-call/tool-result), image attachments, tool schemas, goal snapshots, schedules, and the DeepSeek web-search body. Each branch has its own `assert*` helper that names the failing path (`${event.type} ${event.seq} data.attachment.width`).

### packages/session/session-format-v0-to-v1/src/relationships.ts
- Purpose: the frozen cross-event validator for one whole artifact.
- Key abstractions: turn/step ownership, surface ops (`append`/`replace`), tool lifecycles (`advertised → started`), retry chains, compaction ownership, title citations, command pairing.
- Data flow: one pass over `artifact.events` maintaining a small state machine; `extensions` lets later formats add roles without editing the frozen validator.
- Non-obvious design decisions: `ReleasedRelationshipExtensions` (relationships.ts:32-39) carries `stepEvents`, `preservedSourceTitleRequestText` and `legacyInterruptedTurnRestart` — later formats *extend* the frozen validator by declaration rather than by fork.
- Edge cases / failure handling: `isExactToolNotStartedRepair` (relationships.ts:382) recognises exactly one sanctioned repair shape (error code `TOOL_NOT_STARTED` + a specific fixed text) — a self-correction is admitted only if it is byte-identical to the canonical one.
- Surprising: an inherited compaction started before an `session/end-seed` marker is treated as *stale* and does not block the next turn (relationships.ts:329-341) — a forked child's inherited transaction is allowed to expire.

### packages/session/session-format-v0-to-v1/src/codec.ts
The frozen physical codec: exact v0/v1 header decode, packed Assistant delta rows (`text-chunks`/`reasoning-chunks`/`tool-call-chunks` with `dt` timing arrays) decoded into either a scalar event or a compact run, and range-encoded `sourceEventSeqs` (`[[start,end], …]`). The `scanRows` closure keeps only `rowIndex`, `eventCount` and one `issue` — bounded state for a whole log.

### packages/session/session-format-v0-to-v1/src/migration.ts
The identity edge plus the bounded legacy normalisers: `steering/message`→`user/message`, `compact/*`→`compaction/*`, retired `turn/end` reasons converted, `turn/start.trigger` removed, legacy messages given deterministic ids (`legacy-message:<sessionId>:<seq>`), and the obsolete `request/header.header.messagePrefix` removed. `LEGACY_ASSISTANT_SOURCE_KEY = ['pro','venance'].join('')` (migration.ts:24) is deliberately written as a join so the literal string never appears in the file.

### packages/session/session-format-v0-to-v1/src/validation.ts
Exact header, envelope, surface-metadata and payload validation for released v0/v1, including the retired `request/header` reason `fallback` and the "unsupported descriptor version" refusal.

### packages/session/session-format-v0-to-v1/src/validation-helpers.ts
Two tiny shared helpers: `releasedV0Record` (require a plain JSON object) and `assertReleasedV0Keys` (require every named member and *no* member outside the optional list).

### packages/session/session-format-v0-to-v1/src/testing/restore.ts
A test-only catalog facade (`restoreV0ToV1`, `restoreV1`) that drives the *production* decoder and stage, so the tests never re-implement the pipeline.

### packages/session/session-format-v0-to-v1/src/testing/validation.ts
The test validation ladder: v0 source → normalized v0 → v1 migration source → v1 artifact → v1 physical, each with a different strictness setting.

### packages/session/session-format-v0-to-v1/src/index.ts
Barrel for the frozen v0 codec, dispositions, migration and the exported validators.

### packages/session/session-format-v0-to-v1/tests/validation.spec.ts
The most valuable test in the shard: a `validPayloads` map with one executable fixture per released event type, then (a) an assertion that the map covers the frozen inventory exactly, (b) "refuses an unexpected member on every known payload", and (c) "refuses type corruption at every non-opaque nested member in the frozen fixture inventory" (validation.spec.ts:277). The opaque members are explicitly exempted, and there is a separate case that opaque members must still be lossless JSON (validation.spec.ts:300).

### packages/session/session-format-v0-to-v1/tests/relationships.spec.ts
25-case suite for the frozen relationship validator (turn/step ordering, retry chains, tool lifecycles, compaction spans, title citations, delivery markers, PTC ancestry).

### packages/session/session-format-v0-to-v1/tests/codec.spec.ts
Physical codec suite: header field decoding, packed-row expansion (text/reasoning/named and unnamed tool calls), strict vs recoverable seq gaps, and strictly-increasing range enforcement.

### packages/session/session-format-v0-to-v1/tests/legacy.spec.ts
Legacy-normalisation suite: message identity recovery, wrapped and flat steering shapes, every accepted old turn ending, and the compaction-checkpoint ownership refusal.

### packages/session/session-format-v0-to-v1/tests/migration.spec.ts
Stage-level suite for the identity edge and the normaliser chain, driven through `sessionFormatV0ToV1.createStage` directly.

### packages/session/session-format-v0-to-v1/package.json
Frozen edge manifest; the `dsh.sessionFormatMigration` block (from/to/export/migration/sourceCodec/targetCodec/targetHeaderValidator/targetRestorer) is what the catalog generator consumes.

### packages/session/session-format-v0-to-v1/tsconfig.json
Project references for the v0→v1 package.

### packages/session/session-format-v0-to-v1/tsdown.config.ts
tsdown build for the frozen migration library.

### packages/session/session-format-v0-to-v1/README.md
Contract for the frozen v0 decoder: the bounded legacy normalisers, refusal of every event type outside the frozen inventory (including one marked `ignorable: true`), and "No other event, reference, source, or payload fact may change."

### packages/session/session-format-v0-to-v1/README.zh.md
Chinese translation of the v0→v1 contract.

### packages/session/session-format-v0-to-v1/README.i18n.yaml
Bilingual pairing hashes for the v0→v1 README.

### packages/session/session-format-v1-to-v2/src/migration.ts
- Purpose: the **cardinality-changing** edge — many top-level `assistant/chunk` events become one `assistant/message` carrying the exact timed stream.
- Key abstractions: `AttemptGroup` (turn/step + spans + stream records + an `AssistantStreamAccumulator`), `DecodedReleasedV1ToV2Stage` (adds v1 payload validation), `TransformedReleasedV1ToV2Stage`.
- Data flow: chunks accumulate into an attempt group; a successful group is embedded into its citing `assistant/message`; an *unclaimed* attempt becomes a log-only `assistant/attempt` at its final chunk position; every surviving event and every declared reference is densely remapped through a `mapping: number[]`.
- Non-obvious design decisions: "compacts the chunks without joining token boundaries" (v1→v2 README:46) — the compaction must not merge two text deltas, because that would change the model's token stream.
- Edge cases / failure handling: a reference to a *consumed* chunk is refused rather than redirected ("refuses a reference to a consumed chunk instead of redirecting it to a different semantic event", v1→v2 README:52).
- Surprising: the seeded child's `session/end-seed` marker is *moved and tagged* after the collapse (migration.spec.ts:673), because collapsing an inherited attempt changes the inherited cut.

### packages/session/session-format-v1-to-v2/src/codec.ts
The released-v2 physical codec: exact header keys, one event per row, compact source-event range encoding, and a `encodeEvent` that expands ranges back into scalars for the current backend reader.

### packages/session/session-format-v1-to-v2/src/dispositions.ts
The V2 inventory derived from V0 by dropping `assistant/chunk`, `assistant/message` and the delivery marker, then adding `assistant/attempt` and re-shaping `assistant/message` to carry a `stream`.

### packages/session/session-format-v1-to-v2/src/validation.ts
Released-v2 header/envelope validation plus the bridge that reuses the frozen v0 relationship validator through `RELEASED_V2_RELATIONSHIP_EXTENSIONS` (`stepEvents: {assistant/attempt}`, `preservedSourceTitleRequestText: true`).

### packages/session/session-format-v1-to-v2/src/testing/validation.ts
- Purpose: the test that proves the embedded stream and the assembled message agree.
- Key abstractions: `expandAssistantStream` + `BlockAssembler`.
- Data flow: re-expand the stored `stream`, push every chunk through a fresh assembler, then compare the assembler's `blocks()`, `usage` and `replayState` with the stored `message.content`, `data.usage` and `message.source.replayState`.
- Non-obvious design decisions: an interrupted message compares against `assembler.interruptedBlocks()` instead of `assembler.blocks()` (validation.ts:84) — the same stream legitimately assembles differently when the turn was cut short.
- Edge cases / failure handling: an invalid embedded stream is reported as "has an invalid embedded stream" with the original error as `cause`.
- Surprising: this is a *content-addressed* integrity check: the stored message is redundant with the stored stream, and the redundancy is verified.

### packages/session/session-format-v1-to-v2/src/index.ts
Barrel for the v1→v2 codec, dispositions, migration and validators.

### packages/session/session-format-v1-to-v2/tests/migration.spec.ts
32-case suite: chunk coalescing, incompatible accumulator records, terminal packed successors, legacy goal-mutation splitting, the bounded legacy resume closure, dense remapping, seeded-marker movement, and every refusal (missing/partial/reordered source-event references, a lineage cut inside an interleaved stream).

### packages/session/session-format-v1-to-v2/tests/validation.spec.ts
21-case suite for the released-v2 header, envelope, Assistant-stream and seed relationships.

### packages/session/session-format-v1-to-v2/tests/codec.spec.ts
V2 codec suite: header round-trip, one-row-per-event storage, range compaction, and recoverable tails (including a "torn physical tail" case).

### packages/session/session-format-v1-to-v2/package.json
Frozen edge manifest; declares the v1→v2 `dsh.sessionFormatMigration` block.

### packages/session/session-format-v1-to-v2/tsconfig.json
Project references for the v1→v2 package.

### packages/session/session-format-v1-to-v2/tsdown.config.ts
tsdown build for the frozen migration library.

### packages/session/session-format-v1-to-v2/README.md
Contract for the cardinality-changing edge: chunk collapse, `assistant/attempt` for unclaimed attempts, the bounded legacy resume closure, the legacy round-zero goal-mutation split, and the explicit statement that the restored model-message sequence is unchanged, so "the migration alone does not alter request-prefix cache identity" (README:98-100).

### packages/session/session-format-v1-to-v2/README.zh.md
Chinese translation of the v1→v2 contract.

### packages/session/session-format-v1-to-v2/README.i18n.yaml
Bilingual pairing hashes for the v1→v2 README.

### packages/session/session-format-v2-to-v3/src/migration.ts
- Purpose: promote system prompts into messages and canonicalise envelopes.
- Key abstractions: `ReleasedV2ToV3Stage` with a `mapping: number[]`, `originalIds`/`generatedIds` sets, and a `prompt` string tracking the last emitted system head.
- Data flow: a `request/header` whose `header.system` differs from the current prompt emits a `system/message`; the `system` field is then removed from the header.
- Non-obvious design decisions: the system head is *emitted only on change* ("if (prompt !== this.prompt) this.emitSystem(...)", migration.ts:53) — an unchanged system prompt produces no new event, so the log stays small and the prompt-prefix cache stays stable.
- Edge cases / failure handling: a surface event before the first step is refused ("format v2 surface before first step cannot acquire a system head without changing chronology", migration.ts:57) rather than reordered.
- Surprising: the header preset `code` becomes `ptc` *only* in the header and in `agent-preset/selected` payloads; the migration never inspects installed presets, so the rename is host-independent (README:196 names this ambiguity explicitly).

### packages/session/session-format-v2-to-v3/src/payload.ts
Audited V2 admission and native V3 payload validation, independent of the installed core Session types. `assertEvent` refuses an *unclassified* event outright ("cannot safely transform unclassified event", payload.ts:50) — the edge will not guess.

### packages/session/session-format-v2-to-v3/src/references.ts
- Purpose: remap only the **audited** same-artifact references.
- Key abstractions: `remapEvent(event, seq, mapping)`.
- Data flow: a per-event-type switch maps `command/done.sourceEventSeq`, `compaction/*.{shadowedRange,shadowedSeqs}`, `session/title*.messageSeqs`, plus the envelope's `sourceEventSeqs` and replacement range.
- Non-obvious design decisions: the comment block at references.ts:42-43 is the key line — "Delivery watermarks and session-reference captures identify their original generation. Workflow seq, stream block indices, turn/step, and numeric tool JSON are not Session seqs." A number that looks like a seq is remapped only if it is *declared* to be one.
- Edge cases / failure handling: a reference to a later or unmapped source event is refused ("reference must name an earlier source event").
- Surprising: the whole `switch` is an allow-list, so a new event type with a seq-shaped field is *not* remapped by default — it has to be added deliberately.

### packages/session/session-format-v2-to-v3/src/codec.ts
The V3 codec: structural row admission runs *before* recovery can discard a tail, canonical event validation runs after source-event range decoding, and the inherited cut is derived from the last tagged `session/end-seed` marker. The `emitEvent` wrapper holds the first issue and re-raises it if a later `turn/end` proves the faulty region was committed (codec.ts:43).

### packages/session/session-format-v2-to-v3/src/validation.ts
Native V3 validation with a *private relationship view*: `relationshipEvent` projects a `system/message` into a user-role event so the frozen validator can see a surface-eligible event, and projects PTC events back into their released names — but that projection never escapes the function (validation.ts:69-71). It also implements the **protected system head**: the first appended surface event becomes the head, and neither a surface replacement nor a compaction may shadow it (validation.ts:43-64).

### packages/session/session-format-v2-to-v3/src/index.ts
Barrel for the V3 codec, migration and validators.

### packages/session/session-format-v2-to-v3/tests/migration.spec.ts
44-case suite: streaming system-prompt migration (empty head, changed and cleared prompts), head identity collisions, delivery-generation coordinates, derived seeded cuts, native V3 codec round-trips, and the composed PTC rename.

### packages/session/session-format-v2-to-v3/tests/canonical-envelopes.spec.ts
38-case suite for canonical envelope rewriting, native opaque preservation and physical admission recovery (including "discards an incomplete invalid tail" and "refuses a later commit after %s").

### packages/session/session-format-v2-to-v3/tests/content-admission.spec.ts
Content-admission suite that refuses an unknown message content kind in every carrier (`user/message`, inbox splices, title requests, compaction summaries, raw streams), at every nesting depth.

### packages/session/session-format-v2-to-v3/tests/admission.spec.ts
Admission suite: durable V3 failures, feedback payloads, tool-result repair identity, and coordinate remapping at the mapper boundary.

### packages/session/session-format-v2-to-v3/tests/canonical-regressions.spec.ts
Regression suite proving empty optionals and nested tool-schema values survive, and that an unaudited selection extension is refused.

### packages/session/session-format-v2-to-v3/tests/combined-migration.spec.ts
Composed suite: system-prompt insertion plus envelope canonicalisation plus PTC renames in one catalog migration.

### packages/session/session-format-v2-to-v3/tests/structural-regressions.spec.ts
Regression suite for prompt-history preservation across step and turn changes, repeated text, clear and reintroduction, and for distinguishing local coordinates from captured ones.

### packages/session/session-format-v2-to-v3/tests/preset-migration.spec.ts
Proves only the exact legacy `code` preset id is renamed to `ptc`, that unaudited selection fields are refused, and that a sparse source sequence is refused.

### packages/session/session-format-v2-to-v3/tests/catalog.ts
A fixed V0–V3 composition used by the released-edge tests, independent of the current writer.

### packages/session/session-format-v2-to-v3/package.json
Frozen edge manifest; declares the v2→v3 `dsh.sessionFormatMigration` block.

### packages/session/session-format-v2-to-v3/tsconfig.json
Project references for the v2→v3 package.

### packages/session/session-format-v2-to-v3/tsdown.config.ts
tsdown build for the frozen migration library.

### packages/session/session-format-v2-to-v3/README.md
The single specification of the V2→V3 edge: header and preset references, the system head and message identities, sequence references and inheritance, PTC vocabulary, canonical envelopes and tool errors, delivery guards, and the source audit/refusal rules. It states plainly that "inserted system events change event count, dense sequence positions, local references, and inherited cuts" (README:56).

### packages/session/session-format-v2-to-v3/README.zh.md
Chinese translation of the V2→V3 specification.

### packages/session/session-format-v2-to-v3/README.i18n.yaml
Bilingual pairing hashes for the v2→v3 README.

### packages/session/session-format-v3-to-v4/src/tool-role.ts
- Purpose: lift the released V3 *wrapper* tool result into a first-class V4 tool-role message.
- Key abstractions: `liftToolResult(event)`, `assertV4ToolResultMessage(event)`.
- Data flow: read `data.message` → require exactly one `tool-result` wrapper whose `toolCallId` equals `message.source.callId` → emit `{role:'tool', source, toolCallId, content, isError, id}`.
- Non-obvious design decisions: unknown fields are not dropped but *re-owned*: `extensionFields` renames them to `plugin:message:<key>` or `plugin:result:<key>` (tool-role.ts:10-15) so a message-level and a result-level extension can never merge.
- Edge cases / failure handling: a nested `tool-result` inside a result is refused as unsupported; a wrapper whose callId does not match the tool source is refused; `error` metadata on a non-error result is refused.
- Surprising: the wrapper is *validated before it is dropped* — "Validate the wrapper before dropping it so malformed historical content is rejected instead of being silently truncated" (tool-role.ts:29-31).

### packages/session/session-format-v3-to-v4/src/sources.ts
Plugin→producer attribution conversion. `RENAMED_PRODUCERS` maps five historical plugin names to their current producer kinds, `RELEASED_SAME_NAME_PRODUCERS` lists 24 that intentionally keep their name, and anything unknown becomes `plugin:<name>` (sources.ts:39-65). The `plugin` field is then dropped entirely, so a V4 reader sees a *producer*, not a wrapper.

### packages/session/session-format-v3-to-v4/src/content.ts
Converts V3 content tags to `plugin:<type>` for unknown block kinds, and refuses a V3 tool definition that carries the V4-only `deferLoading` field ("contains deferLoading, which is only defined in V4", content.ts:77) — a forward-only field must not silently survive.

### packages/session/session-format-v3-to-v4/src/developer.ts
Native V4 developer-message validation: `tool-addition`/`tool-removal` blocks require the developer role, an addition must omit any inline `tool` definition, `headerSeq` must be present exactly when there are additions, and a `deferLoading` tool flag must be `true`.

### packages/session/session-format-v3-to-v4/src/extension-identities.ts
The frozen V3 event-type list (58 names) with the comment "This historical list must not inherit additions or removals from the current Session event list" (extension-identities.ts:5), plus the rule that an unknown *ignorable* event is renamed `plugin:<type>` so it can never collide with a future first-party type.

### packages/session/session-format-v3-to-v4/src/facts.ts
Child-identity reduction: `historicalChildCatalogSource` extracts a child's own `subagent/descriptor` without requiring one to exist, `childCatalogFact` interprets only the *discovery* fields of known descriptor versions (1, 2, 3) and returns `undefined` otherwise, and `catalogFact` validates the versioned catalog payload (version 0/1/2 with mode constraints).

### packages/session/session-format-v3-to-v4/src/relationships.ts
The native V4 lifecycle validator (385 lines): a `Relationships` class folds the artifact once and enforces turn/step ordering, tool lifecycles (advertised → started → settled, with the exact `TOOL_NOT_STARTED` repair admitted), PTC dispatch ancestry, retry chains, title citations, command pairing, compaction spans excluding the protected head, and unique own catalog membership. It deliberately leaves unfinished tails open ("incomplete tails retain their open transactions", relationships.ts:1).

### packages/session/session-format-v3-to-v4/src/validation.ts
V4 header validation plus the installed-vocabulary-gated artifact restorer: it validates only event types the installed build *knows*, checks the delivery marker names this Session (except for inherited markers), and rejects duplicate own catalog children.

### packages/session/session-format-v3-to-v4/src/message-sources.ts
Native source admission: every declared durable message slot must carry a producer-owned `kind` that is neither empty nor `plugin`. The physical-row variant (`assertV4SourceRowAdmission`) runs *before* the scanner classifies a row, so retired plugin wrappers are refused even when the row is malformed.

### packages/session/session-format-v3-to-v4/src/retired-syntax.ts
Retired syntax (a `header.system` member, retired PTC event types, released `tool-result` wrappers in interpreted content slots) is a **hard refusal** even after a recoverable physical-row failure — the check runs on the parsed row, not on the decoded event.

### packages/session/session-format-v3-to-v4/src/system-message.ts
Native system-message field admission: positive turn/step, role `system`, non-empty id, content array, and a per-block switch that refuses the retired `tool-result` wrapper while leaving unknown block kinds to the merge-extensible map.

### packages/session/session-format-v3-to-v4/src/fork-result.ts
Validates a fork-generated not-started result: the id must be `forked-tool-result-<callId>-<n>`, the number must match the event's own seq for an append and must be strictly earlier for a replacement, and the replacement must cite exactly that one source seq.

### packages/session/session-format-v3-to-v4/src/references.ts
Remaps V3 local references after an interrupted-turn insertion, including `image/offload.targets[].seq`, and refuses a reference that does not name an earlier source event.

### packages/session/session-format-v3-to-v4/src/codec.ts
The V4 codec reuses released V2 physical framing but applies native admission *before* recovery can discard a suffix. `assertV4RowAdmission(row, knownEventTypes)` deliberately defers an ignorable `developer/message` when the reader does not know the type (codec.ts:63-66) — physical decoding cannot judge a payload it has no vocabulary for.

### packages/session/session-format-v3-to-v4/src/migration.ts
Appends historical child facts after converting V3 source events: the stage sorts candidate children by `childCreatedAt` then id, refuses a conflicting child identity or descriptor, and appends one `subagent/catalog` event per new child. The exported `sessionFormatV3ToV4.createStage()` **refuses** outright ("V3 catalog migration requires explicit historical child facts, including an empty array for a parent without children", migration.ts:24) — the header-only migration works, the body migration needs evidence.

### packages/session/session-format-v3-to-v4/src/testing/validation.ts
Test-only physical round-trip validator for a current artifact (encode → decode → finish).

### packages/session/session-format-v3-to-v4/src/index.ts
Barrel for the V4 codec, migration, validators and the frozen V3 vocabulary.

### packages/session/session-format-v3-to-v4/tests/corpus.spec.ts
The single best test in the shard: it walks `snapshots/sdk` and `snapshots/session` (25 parent/child pairs from *real* recorded sessions), restores each through the historical catalog, migrates each parent with its real children, and pins the exact list of 25 expected parent/child clock conflicts (corpus.spec.ts:93-118). It also asserts the pair count (25) and the number of children without a descriptor (1) so the corpus cannot silently shrink.

### packages/session/session-format-v3-to-v4/tests/relationships.spec.ts
Native V4 lifecycle relationship suite.

### packages/session/session-format-v3-to-v4/tests/validation.spec.ts
V4 header and artifact-restorer suite: dense envelopes, cuts, vocabulary, own-vs-inherited catalog membership, and the end-seed marker agreement.

### packages/session/session-format-v3-to-v4/tests/tool-role.spec.ts
Tool-role lifting and validation suite (wrapper refused, tool role required, callId must match, nested results refused).

### packages/session/session-format-v3-to-v4/tests/developer.spec.ts
Developer messages and deferred tool schemas survive native V4 persistence.

### packages/session/session-format-v3-to-v4/tests/developer-relationships.spec.ts
Developer surface positions and admission, distinct from unknown ignorable records.

### packages/session/session-format-v3-to-v4/tests/catalog-completion.spec.ts
Parent catalog completion suite: descriptor interpretation, conflict refusal, deterministic ordering, inherited-vs-own membership, and "requires explicit corpus facts".

### packages/session/session-format-v3-to-v4/tests/codec.spec.ts
V4 framing suite: version skew, delivery generations, torn cuts, own-vs-inherited catalog membership.

### packages/session/session-format-v3-to-v4/tests/content.spec.ts
Content-conversion suite: extension keys preserved, opaque values untouched, deferred-loading declaration kept.

### packages/session/session-format-v3-to-v4/tests/attribution.spec.ts
Proves an *uninstalled* producer's attribution (a source kind no plugin owns) survives decode, adoption and `deriveMessages()` byte-for-byte.

### packages/session/session-format-v3-to-v4/tests/canonical.spec.ts
Canonical V4 integration: seeded systems, source ownership, PTC, replacements and native round-trip.

### packages/session/session-format-v3-to-v4/tests/interrupted-turn.spec.ts
Interrupted-turn promotion: insertion, reference remap and the closed prior turn.

### packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts
Message-source admission: plugin wrappers refused, producer-owned kinds required.

### packages/session/session-format-v3-to-v4/tests/migration.spec.ts
V3→V4 migration suite: seed marker, delivery generation, child facts and opaque preservation.

### packages/session/session-format-v3-to-v4/tests/open-vocabulary.spec.ts
Proves unknown ignorable payloads and coordinates stay opaque to every native semantic pass.

### packages/session/session-format-v3-to-v4/tests/retired-content.spec.ts
Retired tool-result wrappers are refused in every interpreted content slot.

### packages/session/session-format-v3-to-v4/tests/retired-syntax.spec.ts
Retired headers and PTC tags refused in strict reads, encoding and recoverable suffixes.

### packages/session/session-format-v3-to-v4/tests/sources.spec.ts
Unit suite for the message traversal helper and the plugin→producer rename table.

### packages/session/session-format-v3-to-v4/tests/system-message.spec.ts
System-message field admission and the producer-owned system source.

### packages/session/session-format-v3-to-v4/tests/fork.spec.ts
Fork-generated tool results and the not-started repair identity in native V4.

### packages/session/session-format-v3-to-v4/package.json
Current edge manifest; declares the v3→v4 `dsh.sessionFormatMigration` block.

### packages/session/session-format-v3-to-v4/tsconfig.json
Project references for the v3→v4 package.

### packages/session/session-format-v3-to-v4/tsdown.config.ts
tsdown build for the current migration library.

### packages/session/session-format-v3-to-v4/README.md
The complete V3→V4 conversion spec plus native V4 admission, including a **table of required relationships per event owner** (README:236-249) that reads like a protocol specification. It also states the honest limit: "Current common admission does not validate each user/tool/developer content block against the complete generated schema… Unknown block kinds and uninspected fields can therefore survive storage admission and still be refused by a provider" (README:231).

### packages/session/session-format-v3-to-v4/README.zh.md
Chinese translation of the V3→V4 specification.

### packages/session/session-format-v3-to-v4/README.i18n.yaml
Bilingual pairing hashes for the v3→v4 README.

### packages/session/session-checkpoint-policy/src/index.ts
- Purpose: make model requests, top-level tool side effects and completed steps durable before the next action.
- Key abstractions: three Cordis listeners — `llm/stream`, `tools/execute`, `agent/pre-step`.
- Data flow: `llm/stream` → `ctx.sessions.flush(session)` → *then* construct the downstream stream; `tools/execute` → flush → check `exec.signal.aborted` → then invoke the tool body; `agent/pre-step` → flush the previous step's committed response/results.
- Non-obvious design decisions: the flush happens **before** the adapter stream is constructed (index.ts:34-38), not before the first chunk — so a crash during construction cannot lose the request. The tool listener only fires for a *top-level* call (`exec.agent !== undefined && exec.parent === undefined`, index.ts:71) because nested dispatches reuse the durable outer call.
- Edge cases / failure handling: fail-closed — a rejected flush propagates and the adapter/tool body never runs. If cancellation lands *while* the flush is pending, the wrapper returns the canonical `ABORTED_BEFORE_DISPATCH` result and never enters the tool body (index.ts:73).
- Surprising: the plugin has **no configuration** and adds no prompt or tool schema — it is purely a placement of three barriers.

### packages/session/session-checkpoint-policy/README.md
User/maintainer contract: three barriers, fail-closed rejection, and three stated limits — "durable execution intent, not exactly-once effects", "no checkpoint inside an active model attempt", and "unknown outcome, not automatic retry" (README:114-116). The KV-cache note is important: the repair result is appended *after* the reusable prefix, so recovery does not invalidate earlier cache entries (README:105).

### packages/session/session-checkpoint-policy/README.zh.md
Chinese translation of the checkpoint-policy contract.

### packages/session/session-checkpoint-policy/README.i18n.yaml
Bilingual pairing hashes for the checkpoint-policy README.

### packages/session/session-checkpoint-policy/package.json
Plugin manifest; peer-deps on dsh-agent/dsh-llm/dsh-session/dsh-session-persistence/dsh-tools, no runtime deps and no config surface.

### packages/session/session-checkpoint-policy/tsconfig.json
Project references for the checkpoint-policy package.

### packages/session/session-checkpoint-policy/locale/en.json
Plugin locale stub: only `meta.title`.

### packages/session/session-checkpoint-policy/locale/zh.json
Chinese locale stub for the checkpoint policy plugin.

### packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts
Unit suite pinning the flush-before-adapter ordering with an explicit order array (`['flush:start','flush:end','adapter']`, spec.ts:73), no checkpoint without a live session or for a detached id, and fail-closed behaviour on a rejecting flush.

### packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts
- Purpose: prove the durability claim against a *real* SIGKILL.
- Key abstractions: a marker file whose *content* (not its existence) is the readiness signal (`waitForMarker`, crash-recovery.e2e.ts:21-37); `interruptedTurnClosers(events)` to balance the interrupted tail.
- Data flow: child publishes `request-dispatched` or `tool-side-effect`, parent SIGKILLs it, parent reopens the durable log and asserts the request survived, or that the missing tool result was repaired as `TOOL_OUTCOME_UNKNOWN` with the text "Do not retry blindly."
- Non-obvious design decisions: the test is `describe.skipIf(process.platform === 'win32')` — SIGKILL choreography is POSIX-only — and the child's `waitForCrash()` is an interval that never resolves so the kill is deterministic.
- Edge cases / failure handling: the marker-content protocol avoids the classic "file exists but not yet written" race.
- Surprising: the assertion is about the *repaired* transcript, not just the file bytes: a crash before a tool result yields a canonical unknown-outcome result rather than a dangling call.

### packages/session/session-checkpoint-policy/tests/fixtures/crash-child.ts
The crash fixture: a `CrashAdapter` that writes `request-dispatched` and hangs, and a `crash_tool` that writes `tool-side-effect` and hangs.

### packages/session/session-persistence/src/storage-contract.ts
- Purpose: the backend-shared validation every persistence backend composes.
- Key abstractions: `assertStoredId`, `assertVersion`, `validateStoredEvents`, `materializeCreateHeader`, `materializeAppendBatch`, `assertContiguous`.
- Data flow: a backend reads events → `validateStoredEvents` adopts/freezes them in place → the handle serves them.
- Non-obvious design decisions: `materializeAppendBatch` validates **and** deep-snapshots in one traversal, with the reason stated: "a check followed by a copy could reread accessors into a different record" (storage-contract.ts:126) — a TOCTOU on getters.
- Edge cases / failure handling: an unknown event type that is not `ignorable: true` refuses the whole log with "it was likely written by a newer harness" (storage-contract.ts:77). The one retired shape hiding under a known type (`request/header` reason `fallback`) is also refused (storage-contract.ts:83-91).
- Surprising: `validateStoredEvents` mutates the array in place and returns it — the checked value *is* the persisted value.

### packages/session/session-persistence/src/errors.ts
The stable error vocabulary plus `sessionFormatVersionRefusal` (errors.ts:133-136), which produces *direction-aware* text: newer → "the log was written by a newer harness — upgrade the harness to open it"; older → "this build ships no upgrade path for it". Never "corrupt" for a version mismatch — the user must be told which action to take.

### packages/session/session-persistence/src/handle.ts
The per-session handle contract: `read(offset?, length?)`, `append(events)`, `flush()`, `close()`. The freshness rule is precise: "once an `append` or `flush` resolves on a write handle, every read STARTED afterwards on the same backend instance — on any handle, or through `stat`/`list` — observes at least that prefix" (handle.ts:53-57).

### packages/session/session-persistence/src/index.ts
The `ctx.sessionPersistence` Service Definition: `create`, `open(id, access)`, `stat`, `list`, `flush`, plus the `SessionPersistenceSnapshot` shape (header + optional format status + revision + optional eventCount/sizeBytes).

### packages/session/session-persistence/src/revision.ts
A branded opaque revision token — the mechanism that lets a derived read-model cache notice a change without diffing the log.

### packages/session/session-persistence/tests/contract.ts
- Purpose: the reusable backend-agnostic handle contract.
- Key abstractions: `runPersistenceContract(name, make)` — 21 cases every backend must pass, including "a torn physical tail is never served and is durably truncated by the write path" (contract.ts:539) and the vocabulary fail-closed case.
- Data flow: `make()` must return a *fresh* backend over fresh, empty storage per test; optional `reopen()` simulates another process, optional `corruptTail()` injects a crash.
- Non-obvious design decisions: the fixture builders are shared (`oneTurnLog`, `releasedV1OneTurnLog`) so every backend is tested against the same bytes, including a frozen v0/v1 shape.
- Edge cases / failure handling: single-writer ownership, read-handle mutation refusal, closed-handle rejection, `asyncDispose`, and an erased created session leaving no trace.
- Surprising: `releasedV1OneTurnLog()` (contract.ts:95-122) is the *historical* event shape expressed in today's types — the contract suite therefore exercises the frozen format path too.

### packages/session/session-persistence/tests/live-write-contract.ts
The reusable live-write-path suite: routed events reach the active write handle inside one batching window, `session/flush` is the durability *and error-observation* barrier, `session/disposed` drains and closes, and `close()` itself drains the routed buffer — including through backend teardown with no cross-fiber ordering.

### packages/session/session-persistence/tests/storage-contract.spec.ts
Unit suite for the shared storage helpers and the error vocabulary (including that a merge-extended `turn/end` reason outside the closed built-in set is *accepted*).

### packages/session/session-persistence/README.md
Backend-neutral seam contract: five service methods, handle semantics, the service-level flush that aggregates per-session failures, and the limitations (no deletion API, unpaginated `list()`, "synthetic closers are the only crash story").

### packages/session/session-persistence/README.zh.md
Chinese translation of the persistence seam contract.

### packages/session/session-persistence/README.i18n.yaml
Bilingual pairing hashes for the persistence seam README.

### packages/session/session-persistence/package.json
Seam manifest: `ctx.sessionPersistence` Service Definition; peers on dsh-session/dsh-brand/dsh-timeout.

### packages/session/session-persistence/tsconfig.json
Project references for the persistence seam.

### packages/session/session-persistence-jsonl/src/index.ts
- Purpose: the shipped JSONL backend (1837 lines).
- Key abstractions: `JsonlSessionPersistence extends SessionPersistence`; `JsonlBackendTracker` (the in-process writer registry + live routing); a bounded cold-log memo keyed by session id and guarded by the stat-derived revision; a `migrationPreparations` map (one joinable preparation per selected historical file revision).
- Data flow: `open(id,'write')` → resolve the highest canonical generation in the session directory → if it is historical, `prepareJsonlMigration` (decode + migrate + stage + verify) → publish the successor → hand the handle the current artifact.
- Non-obvious design decisions: the root is resolved once in the constructor so a later `process.cwd()` change cannot split one backend across roots (index.ts:325-326). Listing I/O is bounded by a shared `pLimit` (`listConcurrency`, default 3) across *every* concurrent listing (index.ts:299-302). The cold-log memo holds at most 2 entries (`COLD_LOG_MEMO_MAX_ENTRIES`, index.ts:67) — it exists only for the observation-then-resume handoff.
- Edge cases / failure handling: a session id appearing in two project directories is a hard error, not a pick-one (index.ts:1583-1585); a filename whose version disagrees with its header is an error (index.ts:1196-1200); an artifact in the *opposite* encoding is refused rather than misread (index.ts:1559).
- Surprising: the service-level `flush()` treats a handle that closed mid-sweep as flushed, because close itself drains durably — and the backend's own `flushAll` does the same (storage.ts:516-518).

### packages/session/session-persistence-jsonl/src/storage.ts
- Purpose: the write handle and the live write-behind runtime.
- Key abstractions: `JsonlSessionHandle` (per-handle mutation chain + routed buffer), `JsonlBackendTracker` (writers map, pending map, open handles, teardown).
- Data flow: `session/event` → `enqueueLive` (structured clone) → a ≤200 ms batching timer → `drainLive` splices the buffer and writes the contiguous batch through the mutation chain.
- Non-obvious design decisions: a failed drain **restores the batch at the front of the buffer** and pauses the timer (`this.buffered = batch.concat(this.buffered); this.drainPaused = true`, storage.ts:310-311) so order is retained and the next drain retries loudly rather than losing events.
- Edge cases / failure handling: `close()` drains the buffer, then releases the kernel lock, and aggregates a drain failure with a release failure into one `AggregateError`; the in-process claim is released *whatever* the lock release does, "a skipped releaseHandle would wedge the id in this process behind a lock the kernel may already have dropped" (storage.ts:243-245).
- Surprising: the handle `flush()` **flushes the session log before** the checkpoint value is written — the ordering that guarantees a cache can never be ahead of the log.

### packages/session/session-persistence-jsonl/src/generation.ts
- Purpose: durable whole-generation publication (1059 lines).
- Key abstractions: `JsonlGenerationFormatAdapter` (the seam between physical framing and the format catalog), `prepareJsonlMigration` / `publish`, `readStableJsonlFile`, `readDecodedJsonlSource`, `MigratingJsonlRows` (an incremental JSONL parser that keeps only one cross-frame fragment).
- Data flow: read the source stably → decode+migrate row by row → encode into 1 MiB chunks → write a synced temp file → verify in a Worker → re-check the source identity → publish exclusively.
- Non-obvious design decisions: `publishPreparedMigration` re-stats the source *after* verification and refuses if the identity changed ("source vN artifact remains unchanged"), and the staged file's bytes+digest must match what the verifier saw (generation.ts:902-904). A competing publisher is accepted only if its bytes and digest are identical (generation.ts:930-932).
- Edge cases / failure handling: `inspectExpectedCurrent` refuses a target that resolves to a *non-canonical* directory entry (case-different name) or a symlink/non-regular file (generation.ts:851-873). A torn Zstandard frame or a complete frame containing a torn JSONL record is refused with a distinct message.
- Surprising: `readStableSnapshot` retries a changing file and, on the second attempt, returns the bytes truncated to the *first* stat's size (generation.ts:277-279) — a deliberately conservative read of a file being written.

### packages/session/session-persistence-jsonl/src/format.ts
On-disk format helpers: `encodeSegment` (a SessionId is an unvalidated branded string and MUST be encoded before it touches a path — no traversal, no collision), the per-project/session directory layout, header-line (de)serialisation, the incremental `SessionLogScanner` with its torn-tail offset, and `scanLog` as a compatibility wrapper.

### packages/session/session-persistence-jsonl/src/lease.ts
- Purpose: the cross-process write-ownership lock.
- Key abstractions: `SessionWriteLease.acquire(dir, id)` / `.release()`; POSIX `flock` via the native addon, Windows a named kernel semaphore.
- Data flow: `mkdir(dir, {mode: 0o700})` → open `session.lock` → `tryLockExclusive(fd)` → **verify the locked inode is still the file at the lock path** → hold for the handle's lifetime.
- Non-obvious design decisions: "A POSIX lock names an inode, not a path, so after locking the holder verifies the locked inode is still the file at the lock path and retries otherwise" (lease.ts:14-19) — an unlinked-and-recreated lock file carries a fresh inode, and a lock on the orphan proves nothing. There is deliberately **no expiry**: "there is deliberately no expiry that could expropriate a stalled writer whose resumed appends would tear the log" (lease.ts:11-13).
- Edge cases / failure handling: `EAGAIN`/`EWOULDBLOCK` → `SessionAlreadyOwnedError`; a Win32 `EBUSY` sharing violation → the same error. The lock file is never removed on release, because every acquired lock belongs to a materialized session and the surviving file preserves the inode later lockers verify against.
- Surprising: readers never touch the lock, so a read handle works while another process holds the write lock.

### packages/session/session-persistence-jsonl/src/migration-verifier.ts
Runs the staged generation verification in a **fresh Worker thread**, capped at `MAX_CONCURRENT_VERIFIERS = 2` (a process-wide memory bound, migration-verifier.ts:21). The worker must exit naturally with code 0 after posting its result; any other outcome is a failure.

### packages/session/session-persistence-jsonl/src/worker.ts
The Worker entry: validates the request shape (including that an expected prefix digest is a 64-char hex string) and posts back `{ok:true, result}` or `{ok:false, message, stack}`.

### packages/session/session-persistence-jsonl/src/zstd.ts
Zstandard frame primitives: `scanZstdFrames` parses the frame header and block headers *structurally* (no decompression) to find complete frames and the start of a torn final frame; `compressZstdFrame`/`decompressZstdFrame` use checksummed frames; `createZstdFrameDecoder` picks the fast private decoder or the public fallback.

### packages/session/session-persistence-jsonl/src/zstd-private-decoder.ts
A synchronous multi-frame Zstandard decoder built on Node's *private* stream handle (`_handle.writeSync`, `_writeState`) so one native context is reused across frames; `privateZstdStream` probes for the expected shape and returns `undefined` (falling back) if it is absent.

### packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts
The public-API one-shot fallback decoder (40 lines), used whenever the private shape is unavailable.

### packages/session/session-persistence-jsonl/src/win32.ts
Windows durable-namespace helpers: `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` for publication without replacement or cross-volume copy fallback, named semaphores for the write lock, and a Win32→errno error mapping. Koffi is loaded lazily so non-Windows processes never load it.

### packages/session/session-persistence-jsonl/src/catalog-migration.ts
Collects each historical child's own descriptor through the existing historical codecs *without* recursively preparing related current generations, and revalidates each child's physical identity (dev/ino/size/mtimeNs/ctimeNs) before publication.

### packages/session/session-persistence-jsonl/src/testing/generation.ts
A test-only factory exposing deterministic filesystem, platform and race seams for the generation runtime.

### packages/session/session-persistence-jsonl/tests/jsonl.spec.ts
The 2892-line backend suite: runs the shared handle contract and the live-write contract, and adds listing races (stat settle/churn, readdir failure), torn-tail repair, encoding-selection conflicts and revision stability.

### packages/session/session-persistence-jsonl/tests/generation.spec.ts
The publication suite: staging, verification, source-change refusal, batched exact-threshold writes, Windows no-overwrite publication, and "publishes the current generation beside an immutable suffixless v0 source".

### packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts
Historical catalog publication suite: revision invalidation on child membership/content changes, child discovery races ("detects children added after preparation instead of publishing incomplete membership"), and publication refusal when a related child disappears.

### packages/session/session-persistence-jsonl/tests/migration-refusal.spec.ts
Durable EOF refusals preserve historical generations and never fall back from the selected generation.

### packages/session/session-persistence-jsonl/tests/multi-edge-publication.spec.ts
Composes chunk collapse and V3 system/reference migration into one durable publication.

### packages/session/session-persistence-jsonl/tests/v2-system-migration.spec.ts
Proves system-prompt promotion is durable and keeps request history across publication.

### packages/session/session-persistence-jsonl/tests/v2-ptc-migration.spec.ts
Proves provider-neutral message content (tool JSON, replay state, image blocks) survives the PTC rename *literally* — a migration must not rewrite text that merely mentions an old name.

### packages/session/session-persistence-jsonl/tests/v3-restart-migration.spec.ts
Proves interrupted-turn V3 publication yields an exact successor in both encodings.

### packages/session/session-persistence-jsonl/tests/content-admission.spec.ts
Proves V2 content admission refuses a whole generation rather than publishing a valid prefix.

### packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts
Proves an unknown required event type refuses both read and write opens **without truncating the file** (the inode and bytes are asserted unchanged).

### packages/session/session-persistence-jsonl/tests/retired-content-admission.spec.ts
Retired content fails before migration publication or recoverable native-tail suppression.

### packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts
Native developer relationships are enforced before stored data is exposed.

### packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts
Native message-source admission across both encodings and both access modes.

### packages/session/session-persistence-jsonl/tests/lease.spec.ts
Lock suite: exclusion while a holder is live, immediate admission after close, lock-file residue rules, and the unlinked-and-recreated lock-path inode check. Filesystem and flock refusals are injected through module mocks because POSIX modes cannot express them on Windows.

### packages/session/session-persistence-jsonl/tests/lease.two-process.e2e.ts
Real two-process e2e: a child holds the kernel lock; this process is excluded while the child lives, reads are unaffected, and after a SIGKILL the takeover succeeds with **no waiting period** because the kernel drops the lock with the dead process's descriptors.

### packages/session/session-persistence-jsonl/tests/fixtures/lease-holder.mjs
The lock-holder fixture: creates a session, materialises two events, prints `holding` and keeps the descriptor open forever.

### packages/session/session-persistence-jsonl/tests/zstd.spec.ts
Zstandard suite: torn frames, checksum failures, rollback of a checksummed append frame when fsync fails, and header discovery that skips unreadable compressed headers while refusing targeted reads.

### packages/session/session-persistence-jsonl/tests/win32.spec.ts
Mocked-kernel32 unit suite for the Win32 durable-namespace helpers, so the `MoveFileExW` error mapping and the race handling stay covered on every host (the real suite exercises them on native Windows).

### packages/session/session-persistence-jsonl/tests/zstd.compat.spec.ts
Round-trips concatenated checksummed frames and pins the private-decoder preference and torn-checksum detection.

### packages/session/session-persistence-jsonl/tests/migration-verifier.spec.ts
Worker lifecycle suite with a mocked `node:worker_threads`: message, error, exit and abort paths.

### packages/session/session-persistence-jsonl/tests/migration-verifier-real.spec.ts
Proves the verifier Worker exits naturally (no `terminate` call) after verifying both encodings.

### packages/session/session-persistence-jsonl/tests/built-migration-worker.e2e.ts
Proves the *built* package's verifier Worker runs under plain Node with no workspace imports — the bundling config is tested, not just the source.

### packages/session/session-persistence-jsonl/tests/teardown-loader.e2e.ts
Proves an asynchronously disposing consumer's final event is persisted during teardown, and that listeners and leases are released.

### packages/session/session-persistence-jsonl/tests/load-path.spec.ts
Proves the plugin namespace and `Config` survive the Loader's module normalization (no `default` export).

### packages/session/session-persistence-jsonl/tests/fixtures/released-v0-real-shapes.jsonl
A 25-line released-v0 fixture with realistic shapes: a retry chain, five top-level assistant chunks, a compaction span with a descending seq list, and a title-LLM request.

### packages/session/session-persistence-jsonl/tests/catalog-migration.perf.ts
A threshold-free perf harness that spawns child processes to measure `stat`, cold read, memoised read and publish as the unrelated-log count grows (0, 100, 1000) — measurements are printed as JSON rather than asserted, so a reviewer reads the numbers.

### packages/session/session-persistence-jsonl/README.md
User/maintainer contract for the shipped backend: `root` (required, no default), `compression` (`'zstd'` default), `listConcurrency` (3), the on-disk layout, the three POSIX/Windows-specific limits (hard-link materialisation, the flock addon, no ordered root disposal).

### packages/session/session-persistence-jsonl/README.zh.md
Chinese translation of the JSONL backend contract.

### packages/session/session-persistence-jsonl/README.i18n.yaml
Bilingual pairing hashes for the JSONL backend README.

### packages/session/session-persistence-jsonl/package.json
Backend manifest; deps include `koffi` (Win32 FFI), `p-limit`, the format catalog and the native flock addon.

### packages/session/session-persistence-jsonl/tsconfig.json
Project references for the JSONL backend, including the native system addon.

### packages/session/session-persistence-jsonl/tsdown.config.ts
Two-bundle build: an ESM backend and a **CJS path-loaded verifier** with workspace deps inlined ("Fresh verifiers need no host singleton identity"), which is what makes the isolated verification possible.

### packages/session/session-persistence-jsonl/locale/en.json
Plugin locale stub: `meta.title` = "session-persistence-jsonl".

### packages/session/session-persistence-jsonl/locale/zh.json
Chinese locale stub for the JSONL persistence backend.

### packages/session/session-projection/src/index.ts
- Purpose: the projection registry (`ctx.sessionProjections`).
- Key abstractions: `ProjectionDefinition` (`key`, `stateSchema`, `init`, `apply`, optional `wire:{viewSchema,view}`, `stateVersion`), per-session `UnitCell` (state + `observedSeq` + two view slots), `ProjectionSnapshot` (`asOfSeq` + values).
- Data flow: the registry drives `apply` over every committed session event; a unit that returns the *same state reference* produces zero downstream work; the wire view is compared with `Object.is` across two retained slots.
- Non-obvious design decisions: the "whole-value event rule (load-bearing): a state-carrying log event MUST carry the complete post-change state, never a bare delta — it keeps every unit's transition trivially cheap and every served value self-describing" (index.ts:13-16). Registration is an *effect on the calling fiber*, so HMR/unload removes the key (index.ts:273-291).
- Edge cases / failure handling: a key registered at a different `stateVersion` is refused (index.ts:279-281); a `stateVersion` that is not a non-negative integer is refused at register time; a checkpoint row whose `seq` is past the supplied log end is refused with "re-read from seq 0" (index.ts:515-519).
- Surprising: `snapshot()` reports `asOfSeq` as the cursor *before* the session's next seq, and every value in the snapshot reflects that same log position — the snapshot is a consistent cut, not a bag of values.

### packages/session/session-projection/src/types.ts
The pure-type outlet holding the two merge-extensible projection tables: `SessionProjectionMap` (client-visible wire values) and `SessionProjectionStateMap` (host fold state). Domain packages declare-merge into either; re-export preserves symbol identity so both land on the same table.

### packages/session/session-projection/tests/registry.spec.ts
The 793-line registry suite: drive semantics, lazy cell build, the `Object.is` no-change gates (including a four-state identity sequence across listener gaps), snapshot consistency, duplicate-key rejection, `stateVersion` validation, effect-tied removal, checkpoint/restore round-trips and "fails loud when a unit view violates its own schema".

### packages/session/session-projection/README.md
The developer/maintainer contract for a projection unit: `init` must receive the exact fork-inherited cut and must not infer it from `firstLiveSeq` or `session/end-seed` (README:54); `apply` must be synchronous and return the same reference for uninteresting events; the wire view must reuse its reference to suppress publication.

### packages/session/session-projection/README.zh.md
Chinese translation of the projection contract page.

### packages/session/session-projection/README.i18n.yaml
Bilingual pairing hashes for the projection README.

### packages/session/session-projection/package.json
Seam manifest for `ctx.sessionProjections`; one runtime dep (zod), cordis and dsh-session as peers.

### packages/session/session-projection/tsconfig.json
Project references for the projection seam.

### packages/session/session-projection/locale/en.json
Plugin locale stub: `meta.title` = "session-projection".

### packages/session/session-projection/locale/zh.json
Chinese locale stub for the projection registry plugin.

### packages/session/session-projection-cache/src/index.ts
- Purpose: the durable projection cache (`ctx.sessionProjectionCache`).
- Key abstractions: `write(session)` (durable now), `coldSnapshot(meta, inheritedEventCount, events)` (fold shortcut), `cachedSnapshot(meta, keys?)` (zero-I/O listing read); a per-session dirty counter plus interval timer.
- Data flow: `session/event` → dirty counter → `turn/end` (mandatory), count threshold, or interval → `flushSoft` → checkpoint rows → flush the **session log first** → then put the record on the domain write chain.
- Non-obvious design decisions: the cache is "a fold shortcut, never an authority: a row is possibly stale (its `seq` says how stale) but never wrong, so every write path is fail-soft (a lost write costs a longer tail replay on the next cold read) and a `ver` mismatch discards the row instead of migrating it" (index.ts:10-14). The write order guarantees "a crash can leave the cache behind the log (longer tail replay) but never ahead of it (phantom values folded from events no stored log contains)" (index.ts:261-263).
- Edge cases / failure handling: three *mandatory* write points always fire (session creation — to capture the seed-derived cut, `turn/end`, and disposal); between them the count and interval throttles apply. A failed write logs a warning and stays stale; the next write self-heals.
- Surprising: creation is a mandatory point specifically because "a session that never talks (a forked child seeded with its ancestor's title, say) would otherwise get its first row only at detach" (index.ts:332-336).

### packages/session/session-projection-cache/src/spec.ts
- Purpose: the `session_projcache` storage-domain declaration.
- Key abstractions: `checkpointIdentity` (formatVersion, createdAt, cwd, isSeeded, inheritedEventCount), `checkpointRow` (`ver`, `seq`, `val`), `checkpointRecord` (identity + rows).
- Data flow: the storage domain reads one document per session (`per-record` layout) and the cache reads it from the domain's in-memory tables — zero I/O on the listing read.
- Non-obvious design decisions: "a session id names a slot, not a lifecycle — a deleted-then-recreated id, or a persistence root swapped under a surviving cache, would otherwise let an old record pass every watermark check and seed state folded from an unrelated log" (spec.ts:38-43). `invalidRecords: 'backup-and-skip'` — a stored record that fails the schema is disposable derived data and "must never cost the boot"; the domain moves it aside as `<key>.json.bak.<stamp>` and serves the session as uncached.
- Edge cases / failure handling: a record without `formatVersion` is refused for hydration ("no current Session log can prove that record's fold semantics") but may still expose a version-compatible title through a listing-only hint.
- Surprising: `compatibleVersions: [3,4,5,6]` keeps structurally valid predecessor records *available* for a later rewrite while still refusing them as fold shortcuts.

### packages/session/session-projection-cache/tests/cache.spec.ts
The 811-line cache suite: mandatory-point writes, count/interval throttling, fail-soft durability with self-heal, the listing-read identity rules (lifecycle match on formatVersion/createdAt/cwd/isSeeded), and cold-read seeding that applies only the events after each cached watermark.

### packages/session/session-projection-cache/tests/fixtures.spec.ts
Cross-version recovery suite over the *released* v3/v4/v5 fixtures plus the synthetic v7 document, including the v5-stamped lineage-less document that reproduces byte-for-byte what the formerly unguarded legacy bootstrap wrote.

### packages/session/session-projection-cache/tests/fixtures/v3-single-unit.json
Released v3 whole-unit cache fixture: 13 projection rows including `sessionStats`, `tokenUsage`, `contextPressure`, `contextBreakdown`, `permissions`, `todos` and `plan`.

### packages/session/session-projection-cache/tests/fixtures/v4-session-doc.json
Released v4 per-record document fixture with `title`, `titleInput` and `llmRetry` rows.

### packages/session/session-projection-cache/tests/fixtures/v5-session-doc.json
Released v5 per-record document fixture carrying the full lineage identity.

### packages/session/session-projection-cache/tests/fixtures/v5-lineageless-doc.json
Released v5 lineage-less document fixture reproducing the formerly unguarded legacy bootstrap output.

### packages/session/session-projection-cache/tests/fixtures/v7-opaque-session-doc.json
Synthetic v7 document with `__proto__`/`constructor` keys at several nesting depths, proving opaque checkpoint JSON preservation.

### packages/session/session-projection-cache/README.md
Deployment contract: three mandatory write points, count/interval throttles, the zero-I/O listing read, and the version/lineage disposition table (a predecessor record may serve a title but never a fold shortcut).

### packages/session/session-projection-cache/README.zh.md
Chinese translation of the projection-cache contract.

### packages/session/session-projection-cache/README.i18n.yaml
Bilingual pairing hashes for the projection-cache README.

### packages/session/session-projection-cache/package.json
Cache manifest; peers on the projection registry, storage-domain and dsh-session; zod + schemastery deps.

### packages/session/session-projection-cache/tsconfig.json
Project references for the projection cache (storage, storage-domain, storage-json).

### packages/session/session-projection-cache/locale/en.json
Plugin locale stub: `meta.title` = "session-projection-cache".

### packages/session/session-projection-cache/locale/zh.json
Chinese locale stub for the projection cache plugin.

### packages/session/session-log-deepseek/src/index.ts
- Purpose: contribute the incremental canonical session log to official DeepSeek requests.
- Key abstractions: `Config` (`enabled`, `maxBytes`), `AcceptanceFold` (a `WeakMap<Session, {scannedEvents, throughSeq}>`), the `dsh_session_log` extension payload.
- Data flow: on request → fold the greatest accepted watermark for that exact Session *and format generation* → snapshot `session.events` → take the longest contiguous run that fits `maxBytes` → the adapter calls `accept()` after HTTP 2xx → `accept()` appends `session-log-deepseek/delivery-accepted` with `throughSeq` and `sessionFormatVersion`.
- Non-obvious design decisions: the acceptance watermark lives *in the canonical log*, not in a side store, "so restart recovery can conservatively resend uncertain tails without maintaining another store" (index.ts:3-5). The fold takes the **maximum** matching `throughSeq` so concurrent out-of-order acceptances cannot regress the cursor.
- Edge cases / failure handling: a single pending event larger than `maxBytes` stalls the upload — the request omits the field, one warning is logged per blocking event, and the watermark stays before it. A forked session ignores the parent's watermark because both the recorded id *and* the format generation must match.
- Surprising: a crash after server acceptance but before the watermark persists causes a *replay* — the failure direction is deliberately at-least-once ("uncertainty creates duplicates, never a skipped sequence", README:49).

### packages/session/session-log-deepseek/src/types.ts
The wire DTO types: a raw-number header (`seedLength` present only for a seeded Session), a per-event union that *requires* `surfaceOp` for surface events and *forbids* `sourceEventSeqs` on assistant messages, and the `dsh_session_log` extension shape (`version`, `sessionFormatVersion`, `session`, `afterSeq`, `throughSeq`, `events`).

### packages/session/session-log-deepseek/tests/upload.spec.ts
The 29-case upload suite: the wire DTO shape, watermark reconstruction after restart, a migrated V3 log uploading from the beginning before current-generation acknowledgements, out-of-order acceptance taking the maximum, byte-bounded draining, and the oversized-event stall.

### packages/session/session-log-deepseek/tests/feedback-composition.spec.ts
Real-composition suite through the Loader and a mock DeepSeek server: freeform feedback and message put/edit/delete upload through the unchanged provider route, and a backlog above `maxBytes` drains across consecutive requests.

### packages/session/session-log-deepseek/tests/config.spec.ts
Config suite: `enabled` and `maxBytes` defaults and the positive-integer byte limit, checked across process lanes.

### packages/session/session-log-deepseek/README.md
User contract for the `dsh_session_log` request field: configuration, the byte bound, the acceptance/retry direction, and the four stated limitations (crash-window duplicates, no live Session means no field, an oversized event stalls upload, provider rejection fails the request rather than truncating the log).

### packages/session/session-log-deepseek/README.zh.md
Chinese translation of the session-log upload contract.

### packages/session/session-log-deepseek/README.i18n.yaml
Bilingual pairing hashes for the session-log README.

### packages/session/session-log-deepseek/package.json
Plugin manifest; deps on dsh-brand/dsh-util-values/schemastery, peers on the DeepSeek extension registry and dsh-session.

### packages/session/session-log-deepseek/tsconfig.json
Project references for the session-log package.

### packages/session/session-log-deepseek/locale/en.json
Plugin locale stub: `meta.title` = "session-log-deepseek".

### packages/session/session-log-deepseek/locale/zh.json
Chinese locale stub for the session-log upload plugin.

### packages/session/session-stats/src/projection.ts
- Purpose: the `sessionStats` projection unit — whole-log turn/step counts and wall times.
- Key abstractions: `SessionStatsTotals` (8 figures), `SessionStatsState` (totals + `lastTurn` + `openStep` + `pendingCalls`), a strict zod schema for the wire view.
- Data flow: `step/start` opens a step boundary; the first non-empty delta chunk records the first-token time; `assistant/message` closes the step and accrues model time, decode time and output tokens; `tool/call`/`tool/result` pair by callId for tool time; `step/end` counts the step; `turn/end` drops leftover pending calls.
- Non-obvious design decisions: "`step/end` — not `assistant/message` — is the counted step event because it is the step lifecycle authority: the loop appends exactly one per entered step, in a `finally`, so completed, failed, cancelled, and max-tokens steps all land one" (projection.ts:6-11). Counting assembled messages instead would overcount max-tokens usage-host messages and undercount cancelled steps.
- Edge cases / failure handling: a first-token time survives an in-step `llm/retry`; decode time accrues only over steps carrying both a first token and a valid usage report; a callId colliding with an `Object` prototype name reads as unmatched (the map is a plain object, so `__proto__` is a real hazard).
- Surprising: the wall-time fields mirror the *client window fold* field by field, so an assembly without this unit can fall back to the client fold wholesale (README:49).

### packages/session/session-stats/src/index.ts
The plugin body: `inject = ['sessionProjections']` and a single `ctx.sessionProjections.register(sessionStatsProjectionDefinition)` — because the registration is an effect on the mounting fiber, unmounting removes the key (HMR safety).

### packages/session/session-stats/src/types.ts
One home of the `sessionStats` projection-key declaration and the eight field types, in a module with no host-side value imports so client aggregates can import it without dragging in cordis/zod.

### packages/session/session-stats/src/client.ts
A ten-line client-namespace projection of the same types — `./client` and `./types` serve identical content with zero duplication.

### packages/session/session-stats/tests/projection.spec.ts
The 362-line fold suite, whose header names the two counting regressions it pins: a cancelled step never assembles a message but still counts, and a max-tokens usage-host message (empty content) adds no extra step.

### packages/session/session-stats/tests/loader-composition.spec.ts
A real YAML/Loader composition proof that the shipped shape boots through the vendored Loader and serves `{turns: 1, steps: 1}` for a fully logged turn.

### packages/session/session-stats/README.md
The field-by-field contract for the whole-log statistics figures, the fold rules, and the statement that the composed registry always serves the key, so clients read the value rather than key presence.

### packages/session/session-stats/README.zh.md
Chinese translation of the session-stats contract.

### packages/session/session-stats/README.i18n.yaml
Bilingual pairing hashes for the session-stats README.

### packages/session/session-stats/package.json
Plugin manifest with `./types` and `./client` subpath exports and no runtime deps beyond zod.

### packages/session/session-stats/tsconfig.json
Project references for the session-stats package.

### packages/session/session-stats/locale/en.json
Plugin locale stub: `meta.title` = "session-stats".

### packages/session/session-stats/locale/zh.json
Chinese locale stub for the session-stats plugin.

---

## Ideas worth stealing

- **A "checkpoint the side effect, not the outcome" barrier at three named seams** — `packages/session/session-checkpoint-policy/src/index.ts:64` — the model request is flushed *before the adapter stream is even constructed*, the top-level tool call is flushed *before the tool body runs*, and `agent/pre-step` flushes the previous step's response/results. A rejected flush is **fail-closed**: the adapter or tool body does not run. This is exactly the shape August needs for "a crash between a recorded tool call and its result" — and the nested-call exemption (`exec.parent !== undefined` → skip) means a nested dispatch inherits the outer call's durability instead of paying for it twice.

- **Fail-closed unknown-vocabulary gate with an actionable message** — `packages/session/session-persistence/src/storage-contract.ts:75` — an event type this build does not know, unless its writer marked it `ignorable: true`, refuses the whole log with "it was likely written by a newer harness". August's session/event readers should refuse rather than skip: silently skipping an unknown *required* event reconstructs a wrong conversation, and the user is told to upgrade rather than told the file is corrupt.

- **Direction-aware refusal text** — `packages/session/session-persistence/src/errors.ts:134` — newer format → "the log was written by a newer harness — upgrade the harness to open it"; older format → "this build ships no upgrade path for it". Never "corrupt" for a version mismatch. A single `sessionFormatVersionRefusal()` is shared by every backend so the wording cannot drift per backend.

- **Validate-and-snapshot in ONE traversal** — `packages/session/session-persistence/src/storage-contract.ts:131` — `materializeAppendBatch` refuses "a check followed by a copy could reread accessors into a different record". The value that is *checked* is the value that is *persisted*. August's tool-argument and event-batch writers have the same TOCTOU exposure if they validate then copy.

- **Whole-value event rule for anything a projection folds** — `packages/session/session-projection/src/index.ts:13` — "a state-carrying log event MUST carry the complete post-change state, never a bare delta — it keeps every unit's transition trivially cheap and every served value self-describing". August's `update_state` and todo events could adopt this: a delta forces every reader to maintain history, a whole value makes the read O(1) and the log self-sufficient.

- **Reference identity as the change gate** — `packages/session/session-projection/src/index.ts:66` and `packages/session/session-projection/src/index.ts:690` — a unit that returns the *same state reference* for an uninteresting event produces zero downstream work, and the wire view is compared with `Object.is` across two retained slots. This is a zero-cost, allocation-free way to keep a change feed quiet; August's SSE emitters could use the same two-slot comparison instead of diffing.

- **Cache is a fold shortcut, never an authority — and the write order proves it** — `packages/session/session-projection-cache/src/index.ts:10` and `packages/session/session-projection-cache/src/index.ts:266` — "a row is possibly stale (its `seq` says how stale) but never wrong"; every write path is fail-soft; a `ver` mismatch *discards* rather than migrates. And the write order flushes the **session log before** the checkpoint row, so "a crash can leave the cache behind the log (longer tail replay) but never ahead of it (phantom values folded from events no stored log contains)". This is the single most transferable ordering rule in the shard.

- **A session id names a SLOT, not a LIFECYCLE** — `packages/session/session-projection-cache/src/spec.ts:38` — the cache record binds `formatVersion` + `createdAt` + `cwd` + `isSeeded` + `inheritedEventCount`; "a deleted-then-recreated id, or a persistence root swapped under a surviving cache, would otherwise let an old record pass every watermark check and seed state folded from an unrelated log". August's brain/session caches should bind a lifecycle identity, not just a row key.

- **A protected system head that no compaction may shadow** — `packages/session/session-format-v2-to-v3/src/validation.ts:43` — the first appended surface event becomes the head; a surface replacement must replace *exactly* that head ("system/message must replace exactly the current system head"), and neither a surface replacement nor a compaction span may include it. This is the session-log form of "the system prompt must never be compacted away" and it is enforced at the data layer, not by convention.

- **An allow-list of sequence references** — `packages/session/session-format-v2-to-v3/src/references.ts:30` — only `command/done.sourceEventSeq`, `compaction/*.{shadowedRange,shadowedSeqs}`, `session/title*.messageSeqs` and the envelope fields are remapped, and the comment says why: "Delivery watermarks and session-reference captures identify their original generation. Workflow seq, stream block indices, turn/step, and numeric tool JSON are not Session seqs." A number that *looks* like an id is remapped only if it is *declared* to be one. August's compaction/prune path needs exactly this discipline.

- **Refuse rather than guess** — `packages/session/session-format-v2-to-v3/src/payload.ts:50` and `packages/session/session-format-v3-to-v4/src/migration.ts:24` — an unclassified event type, an unclassified message content kind, or a body migration without explicit child evidence is a hard refusal, each with a message naming what was missing. August's format migrations should have the same "there is no safe default" posture.

- **The system prompt is emitted only on CHANGE** — `packages/session/session-format-v2-to-v3/src/migration.ts:53` — `if (prompt !== this.prompt) this.emitSystem(prompt, …)`. An unchanged system prompt produces no new event. August's request-header persistence should do the same: the prompt prefix is stable, and the log should not grow a duplicate copy of it every turn (this is also what keeps the provider's prompt cache warm).

- **Immutable generations + exclusive successor publication, verified by a second process** — `packages/session/session-persistence-jsonl/src/generation.ts:894` and `packages/session/session-persistence-jsonl/src/migration-verifier.ts:108` — the successor is written to a synced temp file, verified by a **fresh Worker thread** that decodes it independently and reports a digest, the source identity is re-checked *after* verification, and publication is a no-overwrite rename; a competing publisher is accepted only if its bytes and digest are identical. August's "publish a new format generation" path needs the same four steps: stage, verify independently, re-check the source, publish exclusively.

- **A kernel lock with an inode re-verification and NO expiry** — `packages/session/session-persistence-jsonl/src/lease.ts:99` and `packages/session/session-persistence-jsonl/src/lease.ts:11` — POSIX `flock` names an inode, so after locking the holder verifies the locked inode is still the file at the lock path and retries otherwise; and "there is deliberately no expiry that could expropriate a stalled writer whose resumed appends would tear the log". Two lessons: verify the lock still refers to the file you think, and never time out a lock whose holder might still be writing.

- **Crash recovery produces an UNKNOWN OUTCOME, not a retry** — `packages/session/session-checkpoint-policy/README.md:116` — "a persisted call without a result cannot prove whether its external effect completed, so recovery records an unknown outcome instead of retrying"; the recovery message permits retry for read-only or idempotent work and requires verification for side-effecting work. August's interrupted-tool recovery should be worded and behaved the same way, and the repair result is appended *after* the reusable prefix so it does not invalidate the provider's cache.

- **Provider-attribution becomes producer-owned, and unknown producers survive** — `packages/session/session-format-v3-to-v4/src/sources.ts:59` and `packages/session/session-format-v3-to-v4/src/extension-identities.ts:76` — a historical `plugin` source is rewritten to the *producer's own* kind (with an explicit rename table and an explicit same-name table), unknown producers become `plugin:<name>`, and an unknown ignorable event type is namespaced `plugin:<type>` so it can never collide with a future first-party type. August's message-source model should carry the producer, not the plugin wrapper.

- **Extension fields are re-owned, not dropped** — `packages/session/session-format-v3-to-v4/src/tool-role.ts:10` — unknown fields on a message and on a wrapper are renamed `plugin:message:<key>` / `plugin:result:<key>` so the two owners' extensions can never merge. August's tool-result payload should do the same when it lifts a wrapper into a first-class role.

- **Validate the wrapper BEFORE dropping it** — `packages/session/session-format-v3-to-v4/src/tool-role.ts:29` — "Validate the wrapper before dropping it so malformed historical content is rejected instead of being silently truncated." A schema upgrade that removes a wrapper must not become a truncation.

- **Re-derive the model output from the stored stream and compare** — `packages/session/session-format-v1-to-v2/src/testing/validation.ts:61` — re-expand the embedded Assistant stream, push it through a fresh `BlockAssembler`, and require the stored message content, usage and replay state to agree with the assembled result. The transcript carries the stream *and* the assembled message redundantly, and the redundancy is verified — a genuine "the persisted transcript still means what the model produced" check.

- **Fold the chunk stream without joining token boundaries** — `packages/session/session-format-v1-to-v2/README.md:46` — the compaction must not merge two text deltas. Reasoning/text deltas are the one thing a log may compact but never merge, because merging changes the model's token stream.

- **A frozen event-type list that must NOT inherit from the current list** — `packages/session/session-format-v3-to-v4/src/extension-identities.ts:5` — "This historical list must not inherit additions or removals from the current Session event list." August needs the same discipline for any versioned vocabulary: a frozen reader's vocabulary is a snapshot, not a view.

- **One immutable successor, published by a per-file preparation that is re-validated** — `packages/session/session-persistence-jsonl/src/catalog-migration.ts:83` and `packages/session/session-persistence-jsonl/src/index.ts:697` — the child set is re-read and compared before publication ("detects children added after preparation instead of publishing incomplete membership"), and each witness file's dev/ino/size/mtimeNs/ctimeNs is re-checked.

- **A durable acceptance watermark that lives in the log itself** — `packages/session/session-log-deepseek/src/index.ts:237` — acceptance appends a `session-log-deepseek/delivery-accepted` event carrying `throughSeq` and the format generation, so restart recovery can conservatively resend uncertain tails "without maintaining another store". The failure direction is stated and deliberate: "uncertainty creates duplicates, never a skipped sequence."

- **A byte-bounded outbound payload with an explicit stall** — `packages/session/session-log-deepseek/README.md:42` — the request carries the longest pending prefix that fits `maxBytes`; one oversized event stalls the upload with one warning per blocking event, and the watermark stays put. August's outbound telemetry should have a documented, bounded size and a stated behaviour when a single item cannot fit.

- **A real-corpus migration test with a pinned conflict list** — `packages/session/session-format-v3-to-v4/tests/corpus.spec.ts:48` — the migration is run over 25 real recorded parent/child pairs, and the exact list of 25 expected clock conflicts is pinned, along with the pair count and the number of descriptor-less children so the corpus cannot silently shrink. This is the difference between "we believe the migration is right" and "we ran it against what real sessions look like".

- **A shared, backend-agnostic contract suite every backend must pass** — `packages/session/session-persistence/tests/contract.ts:139` and `packages/session/session-persistence/tests/live-write-contract.ts:49` — 21 handle cases plus 14 live-write cases, with the torn-tail injection and the same-storage reopen as *optional capabilities* a backend declares. Any new August persistence backend should be written against such a suite rather than against its own tests.

- **Fail-soft derived state with a self-healing next write** — `packages/session/session-projection-cache/src/index.ts:329` (pinned by `packages/session/session-projection-cache/tests/cache.spec.ts:329`) — a durable write failure logs a warning, leaves the event path unharmed, and the next write self-heals. A derived cache must never be able to fail a turn.

- **Count step boundaries, not assembled messages** — `packages/session/session-stats/src/projection.ts:6` — counting assembled assistant messages "would overcount max-tokens usage-host messages (empty content, excluded from the surface) and undercount cancelled steps (aborted before the message assembles)". Any metric August computes about turns/steps/latency should be anchored to the *lifecycle* event, not to the artefact the model happened to produce.

- **Bilingual README pairing as a build gate** — `packages/session/README.i18n.yaml:1` — per-heading-section hashes of the English and Chinese blocks, re-recorded by a script; a drift between the two languages is a CI failure. If August ships bilingual docs, this is a cheap, high-value gate.

---

## Files skipped (with reasons)

None. Every one of the 260 files in the shard was opened and read; the ledger marks all 260 as `read`. Two classes of file were read *partially* rather than line-by-line, and are flagged here for honesty:

- **Very large test files** — `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` (135 KB, 2892 lines), `packages/session/session-persistence-jsonl/tests/generation.spec.ts` (71 KB), `packages/session/session-format-v1-to-v2/tests/migration.spec.ts` (47 KB), `packages/session/session-format-v0-to-v1/tests/validation.spec.ts` (38 KB), `packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` (33 KB), `packages/session/session-log-deepseek/tests/upload.spec.ts` (33 KB), `packages/session/session-projection/tests/registry.spec.ts` (34 KB), `packages/session/session-projection-cache/tests/cache.spec.ts` (36 KB), `packages/session/session-persistence-jsonl/tests/zstd.spec.ts` (39 KB), `packages/session/session-format-v2-to-v3/tests/migration.spec.ts` (37 KB) and `packages/session/session-format-v3-to-v4/tests/tool-role.spec.ts` (21 KB) — were read in their head (imports, fixtures, the first test bodies) and then **exhaustively enumerated by `grep` over every `it(`/`describe(` title**, which gives the complete behavioural inventory of the file. Their assertions were not read line by line.
- **Chinese README translations** (`README.zh.md` in every package) were read in their first 14–60 lines and confirmed to be direct translations of the English README already read in full; no translation contains a mechanism the English page lacks.

---

## Uncertainties

- **The `dsh-session` core package is not in this shard.** `packages/core/session` (which owns `Session`, `Session.fromRestore`, `adoptSessionEvent`, `KNOWN_SESSION_EVENT_TYPES`, `SESSION_FORMAT_VERSION`, `interruptedTurnClosers`, `buildForkSeed`) is outside `packages/session/`, so several mechanisms this shard depends on are only observable from their *call sites* here. Specifically: the exact semantics of `interruptedTurnClosers` (used by the crash-recovery e2e) and `adoptSessionEvent` (used by `validateStoredEvents`) were inferred from usage and error messages, not read.
- **`@deepseek-ai/dsh-util-values` was not read.** `snapshotJsonValue`, `deepFreeze`, `deepEqualJson` and `isJsonValue` are used pervasively (lossless-JSON admission is a load-bearing idea here) but the implementation is in another package. I verified the *contract* only through the callers' assertions (e.g. `tests/json.spec.ts:11-21`).
- **The `dsh-agent-loop` is not in this shard**, so I could not confirm the claim in `session-stats/src/projection.ts:6-11` that "the loop appends exactly one `step/end` per entered step, in a `finally`". The statement is a comment in this shard and a fixture assumption in `session-stats/tests/projection.spec.ts`; the loop itself is elsewhere.
- **Prompt construction and cache-hit optimisation are largely outside this shard.** The only prompt-related mechanisms here are the *persisted* `request/header` event (config + tools + `reason`), the `system/message` head and its protection, and the migration's explicit statement that the restored model-message sequence is unchanged ("the migration alone does not alter request-prefix cache identity"). The actual request builder, prefix-stability logic and prompt cache accounting live in the llm/agent-loop packages and were not examined.
- **Model-specific adaptations and fallbacks are not present in this shard** except for the frozen per-model *record shapes* (`llm/retry` with its `policyKey`, `request/header` with `reason: initial|resume|change|series`). Whether the harness retries differently per provider is decided in the llm packages.
- **Memory / learning mechanisms are not in this shard at all** — no brain/facts/skill code appears here. The nearest thing is `feedback/record` and `feedback/message-put|delete` as *durable events*, and the projection-cache's ability to checkpoint any domain's fold state.
- **Subagent / parallel execution appears only as durable evidence** (`subagent/descriptor`, `subagent/catalog`, `delegationDepth`, `origin: 'subagent'`, `parentSession`, `header.isSeeded` + `inheritedEventCount`). The spawn/parallel mechanism itself is in the agent packages; this shard only records and validates its results.
- **`packages/session/session-format-catalog/src/generated.ts` is marked GENERATED** by `scripts/gen-session-format-catalog.ts`, which is not in this shard. I read the generated file and the `dsh.sessionFormatMigration` manifest blocks that feed it, but not the generator, so I could not verify that the generator's output is byte-identical to the committed file (there is presumably a CI check for that).
- **The `snapshots/` corpus** referenced by `packages/session/session-format-v3-to-v4/tests/corpus.spec.ts:52` (`snapshots/sdk`, `snapshots/session`) lives at the repo root and is **not** in this shard. I read the test that consumes it and its pinned expectations (25 pairs, 1 descriptor-less child, 25 named conflicts) but did not read the snapshot files themselves.
- **I did not run anything.** Per the assignment, no build, test, install or script from the clone was executed; every statement above comes from reading source, tests, READMEs and comments.
