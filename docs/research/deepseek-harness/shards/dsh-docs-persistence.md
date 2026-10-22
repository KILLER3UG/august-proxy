# deepseek-harness / dsh-docs-persistence

## Shard shape

This shard is two documents held together by one idea. The first half
(`docs/persistence-changes/`, 195 files) is the machine-checked **compatibility
ledger for DSH's persisted Session format**: a normalized, content-addressed
inventory of every persisted type (the Session header, the physical JSONL header
line, the event envelope, and every first-party event), a dated *acknowledgement
record* for every structural change to that inventory, four complete snapshots
of historical formats (V0–V3), and a retrospective archive of 26 alpha/RC
release tags reconstructed offline. Each dated record is four sibling files —
an English `.md`, a Chinese `.zh.md` carrying the byte-identical machine
declaration, a generated `.i18n.yaml` of per-heading en/zh hashes, and a
generated `.schema.json` of the affected roots' after-state. The second half
(`docs/user/`, 64 files) is the end-user and plugin-developer surface:
provider/model configuration, the Web UI quickstart, the Python SDK, schedule
reminders, plugin markets, MCP memory servers, network proxying, reverse-proxy
deployment, and the Cordis plugin-authoring tutorials (basic / framework /
practice) that explain the plugin lifecycle, services, events and the LLM
adapter contract. The two halves meet at one point: the *same* digest-and-record
discipline that governs the persisted schema is what the change records in the
first half use to say "this is safe", and the second half shows the same
"declare the mechanism, state the limit" voice the first half enforces. The
shard contains **no runtime code** — every mechanism here is described in prose
and machine-readable data, which is why it is worth reading carefully: it is
DSH's own statement of its invariants.

## Per-file notes

### docs/persistence-changes/README.md
- Purpose: The rulebook for the persistence-change ledger — who owns which
  file, what a valid acknowledgement looks like, and exactly when a Session
  format version may be kept.
- Key abstractions: a **root** (a persisted type with a SHA-256 digest over its
  normalized schema); a **record** (a dated acknowledgement naming each
  affected root, its predecessor record, its after-digest, and a decision of
  `same-version` or `version-bump`); a **finalization checkpoint**
  (`finalized/vN.json`).
- Data flow: source types → `gen-persistence-catalog` → current catalog +
  `persistence-schema.json` → per-change `.schema.json` snapshots → dated
  records → verifier → CI.
- Non-obvious design decisions:
  - "Unknown fields or values count only when existing readers actually handle
    them safely; type differences alone cannot establish that behavior" (line
    49). A type delta is *not* a compatibility verdict.
  - The classifier "identifies established same-version cases and changes
    requiring compatibility review; it cannot decide semantic safety" (line
    61), so a change that lands in the review bucket needs an explicit
    `--decision same-version` from a human, and CI accepts the recorded
    decision whether the record was generated or hand-edited.
  - "Finalized records remain immutable, so a later record cannot reuse the
    accepted 3→4 transition" (line 61).
  - Digests describe *declared* types, not runtime behaviour: comments, source
    locations, alias names and harmless reordering do not move a digest, but
    compatibility annotations do (line 80).
- Edge cases / failure handling: the verifier "rejects missing predecessors,
  cycles, duplicate successors for one root, digest mismatches, and current
  roots that disagree with their latest records" (line 76). Independent roots
  advance independently; two changes on the same predecessor need a single
  ordered history after integration. An unaccepted terminal record may be
  refreshed explicitly, but the command refuses baselines, records with
  dependants, and checkpoint-locked records.
- Surprising: the mechanism explicitly says it cannot prove that a checkpoint
  and its authority record were never edited together (line 78), and that
  "an unchanged digest does not establish unchanged behavior" — the ledger
  bounds *declared* compatibility and nothing more.

### docs/persistence-changes/finalized/v4.json
- Purpose: the accepted V4 compatibility baseline — every root's kind, digest
  and **surface** flag, plus the semantic hash of each accepted record.
- Key abstractions: `schemaVersion`, `sessionFormatVersion: 4`, `roots` (key →
  kind/digest/event/surface), `acceptedRecords` (record id → semantic hash).
- Data flow: written by `createPersistenceFinalizationCheckpoint`, which
  requires current schemas to match the complete acknowledged history and
  writes a *new* version-named file without replacing an earlier one.
- Non-obvious design decisions: exactly five roots carry `surface: true` —
  `assistant/message` (line 57), `developer/message` (line 105),
  `system/message` (line 261), `tool/result` (line 339) and `user/message`
  (line 357). Every other root, including `tool/call` and
  `tool/ptc-dispatch`, is `surface: false`. That is a machine-checkable answer
  to "which events does the model actually see".
- Edge cases / failure handling: the checkpoint "protects accepted machine
  declarations and after schemas even after the writer advances, while
  excluding prose, aliases, and source locations from record hashes".
- Surprising: only **five** of the 65 roots are model-visible, and
  `acceptedRecords` lists only five acknowledgements (initial,
  auto-review-error-metadata, image-offload, workspace-changes-event,
  session-format-v4) even though 16 dated change records exist — the other 11
  are not yet finalized.

### docs/persistence-changes/2026-09-16-session-format-v4.md
- Purpose: the shard's only `version-bump` record — the V3→V4 transition.
- Key abstractions: a *tool-role* first-class message; `forked` as a
  `turn/end.reason`; producer-owned message sources; developer-role events
  with `headerSeq`; an optional `deferLoading` marker.
- Data flow: V3 logs → V3-to-V4 migration (lifting user-role tool results into
  tool-role messages with required `toolCallId` and optional `isError`) →
  native read/write admission → V4 files published beside unchanged
  predecessors.
- Non-obvious design decisions:
  - "The tool-role declaration changes ten event roots because inbox entries,
    message events, compaction summaries, title requests, team messages, and
    PTC dispatches embed the shared `Message` or `ContentBlock` declarations"
    (line 90) — one shared-type change, ten affected roots, no ten new
    protocols.
  - The retired `system` key in `request/header` is recorded as **forbidden**
    (line 96) so that later permitting a value is a compatibility review, not
    an ordinary optional-field addition.
  - "Same-name replacement, restart, fork, surface replacement and compaction
    retain historical schema identity without consulting the latest header or
    registry" (line 102) — schema identity is bound to a *historical* request
    header revision, not the current one.
  - Auto Review and the compaction summarizer became **request-only** user
    inputs: "These inputs cannot be written as durable Session messages"
    (line 100).
- Edge cases / failure handling: missing, multiple or unknown-version child
  descriptors skip that child's catalog backfill; conflicting identities,
  timestamps or modes refuse migration without publication. Delivery-generation
  checks keep historical acknowledgements from becoming active V4 watermarks.
- Surprising: `developer/message` and `developer/source` are fully specified
  in the persisted format, but "No shipped profile emits developer records;
  provider serialization, automatic emission and UI support remain deferred"
  (line 102) — a persisted type with no producer yet.

### docs/persistence-changes/2026-09-19-external-subagent-catalog.md
- Purpose: lets a parent catalog record a child that has **no local Session**.
- Key abstractions: catalog payload version 2 with `mode: 'external'`.
- Data flow: creation writes one membership fact; execution and cleanup never
  update it.
- Non-obvious design decisions: "New external executions write payload version
  2 with mode external, without a separate marker" (line 38) — the version
  *is* the marker, so there is no second field to keep in sync.
- Edge cases / failure handling: version 0 and version 1 facts stay valid
  (version 1 also retains `unknown`); duplicate child ids remain invalid; an
  external leaf is not navigable.
- Surprising: the schema shows the mode union growing to
  `continuable | one-shot | unknown | external` across payload versions
  0/1/2, with `label` becoming optional from version 1 onward.

### docs/persistence-changes/2026-09-20-unknown-child-catalog.md
- Purpose: retain historical children that can no longer be read, instead of
  dropping them.
- Key abstractions: catalog payload version 1 adds `mode: 'unknown'`.
- Data flow: migration emits v1 for unknown children; complete facts keep v0.
- Non-obvious design decisions: "The classifier allows higher event payload
  versions only when all old payload alternatives remain unchanged;
  same-version widening and removal of old readers stay breaking" (line 38) —
  a payload version is a promise to old readers, not just a label.
- Edge cases / failure handling: older readers reject v1; existing logs need no
  rewrite and the header stays V4.
- Surprising: the release archive shows the *same* root gaining `unknown` on
  2026-09-20 and `external` on 2026-09-19 — the external record's predecessor
  is the unknown record, i.e. the history runs backwards by date, because the
  external change was written against the unknown one.

### docs/persistence-changes/2026-09-30-job-session-lifecycle.md
- Purpose: record owned job registration and settlement inside the Session log.
- Key abstractions: `job/registered` and `job/settled`; one unique JobId
  shared between live control and durable pairing.
- Data flow: a tool call registers a job → the producer settles it → the
  event pair is reconstructable from the log.
- Non-obvious design decisions:
  - "producerReported describes completion-promise fulfillment, not verified
    resource release" (line 42) — a field named for the *claim*.
  - "historical sessions receive no fabricated job history" (line 42) — a new
    record type applied to old rows would invent a past.
  - New JobIds are a kind-prefixed UUID, so the same id is usable in both the
    live control plane and the durable record.
- Edge cases / failure handling: "Older builds reject unknown required
  events"; the job lifecycle contract allows incomplete terminal history
  during application teardown.
- Surprising: `job/settled` carries `cause: producer | teardown | kill` and
  `status: completed | failed | killed` — a job that was killed still settles,
  and the two axes are independent.

### docs/persistence-changes/2026-09-12-auto-review-error-metadata.md
- Purpose: add structured denial metadata to persisted tool errors.
- Key abstractions: optional `error` on `tool/ptc-dispatch`; optional `reason`
  on `tool/result`.
- Data flow: denial → persisted metadata → the Web reader shows Auto-review
  details only when the recorded error identity matches.
- Non-obvious design decisions: "PTC dispatch events do not enter model
  history; native tool-result replay projects data.message and does not include
  error metadata" (line 42) — the metadata is for the *user*, and the model's
  view is deliberately unchanged. Permission mode stays a string; selecting
  `auto` introduces no declared persistence-type change.
- Edge cases / failure handling: current Web readers accept absent reasons; an
  existing `tool/ptc-dispatch` may omit `error` and an existing `tool/result`
  may omit `reason`.
- Surprising: the same record adds fields to two roots in one release because
  the same denial is recorded in two places — the PTC dispatch record and the
  tool result — and the reader matches them by identity.

### docs/persistence-changes/2026-10-07-title-reasoning-effort.md
- Purpose: record the concrete reasoning effort selected for the auxiliary
  session-title request.
- Key abstractions: an optional `reasoningEffort` on
  `event:session/title-llm-request`.
- Data flow: the title route resolves an effort → the prepared request writes
  it → the log records which effort was used.
- Non-obvious design decisions: "Prepared title requests write the resolved
  effort when the route exposes selectable reasoning; no Session format bump
  is required." (line 38) — the field records a *route-specific* value, so a
  title request on a route with no selectable effort simply omits it. The
  verification names the case that matters: "The session-title-after-turn SDK
  snapshot passed with a recorded low effort selected from a route whose
  default is high" — the recorded value is the *selected* one, not the
  default.
- Edge cases / failure handling: "Existing V4 records remain valid and retain
  their original absence of a recorded effort" — absence is meaningful and is
  not back-filled.
- Surprising: this is the only change in the shard that records a *model
  parameter* rather than a structure; it is in the persistence ledger because
  the log must be able to reproduce the request, which is the same reason
  `2026-10-13-deepseek-search-thinking` records the `thinking` flag.

### docs/persistence-changes/2026-10-13-user-rpc-principal.md
- Purpose: record *who* submitted a prompt when the caller is not the owner.
- Key abstractions: an optional `principal` on the `user-rpc` message source.
- Data flow: non-owner prompt → `source.principal` persisted in
  `agent/inbox/spliced` → owner prompts stay byte-identical.
- Non-obvious design decisions: "an absent principal means the owner" and "A
  reader that predates the field ignores it and treats the message as an
  ordinary user message, because the kind stays 'user'" (line 50). The field
  is *not* part of any model request: provider adapters read only the
  model-visible message content.
- Edge cases / failure handling: `SESSION_FORMAT_VERSION` does not change; a
  current reader of an older log finds no principal and treats every message
  as the owner's.
- Surprising: the corresponding `.schema.json` records the promise in the
  *schema* rather than the prose — the `source` property carries a
  `compatibility` block with `policy: session-source-attribution`,
  `binding: session.user-message.source`, `discriminator: kind`,
  `unknownKinds: "preserve"` and the qualified `attributionKinds` list
  (`tmux-context`, `user-question-reply`, `working-directory`). The policy is
  data, so it is diffed and digested like a type.

### docs/persistence-changes/2026-10-13-deepseek-search-thinking.md
- Purpose: record that the auxiliary DeepSeek search turn disables thinking.
- Key abstractions: an optional `thinking` member on the logged request body.
- Data flow: provider writes `thinking: {type: 'disabled'}` on every new
  request → the log records it → no reader replays it.
- Non-obvious design decisions: "The event is log-only; no reader replays or
  interprets the body for behavior" (line 38). The schema shows `thinking` as
  an optional object whose only member is the literal `disabled`.
- Edge cases / failure handling: absence means the request omitted the field
  and DeepSeek applied its default.
- Surprising: the same schema records the web-search tool shape
  (`web_search` / `web_search_20250305`, `max_uses`) and the request's
  `max_tokens`, so the log is a replayable request body — which is exactly
  what makes "no reader replays it" a deliberate choice rather than an
  accident.

### docs/persistence-changes/2026-10-05-ptc-operation-metadata.md
- Purpose: keep operation-time directories and file targets in history.
- Key abstractions: an optional `meta` member on the nested PTC result.
- Data flow: a nested shell/PT call records its cwd and relative target →
  history retains it → the UI can offer navigation.
- Non-obvious design decisions: "The optional JsonValue field does not change
  canonical program values, model-visible content, tool identities or message
  ordering" (line 38) — pure presentation metadata is explicitly *not* model
  content. The schema types `meta` as an open index-signature object whose
  value type is `null`, i.e. arbitrary JSON, and keeps `arguments` as an
  `opaque` node with reason `unknown`.
- Edge cases / failure handling: "Historical calls without a recorded relative
  target keep safe unavailable navigation" — the UI degrades to no link rather
  than guessing.
- Surprising: `meta` is a free-form index signature in a *typed* schema, which
  is why the digest of this root changes whenever the shape of the metadata
  changes but the program value does not.

### docs/persistence-changes/2026-10-05-working-directory-attribution.md
- Purpose: give the working-directory component its own message-source kind.
- Key abstractions: the `working-directory` source kind.
- Data flow: component emits a user message → source kind records who →
  readers preserve it.
- Non-obvious design decisions: "The additive working-directory source kind is
  attribution only; the declared source policy preserves unknown attribution
  without interpreting it" (line 50). It joins the same qualified-attribution
  set as `tmux-context` and `user-question-reply`.
- Edge cases / failure handling: existing records remain valid; the Session
  format is unchanged.
- Surprising: the same change touches `developer/message` and
  `session/title-llm-request` too, because those share the `Message`
  declaration with `user/message` — one source-kind addition, four affected
  roots.

### docs/persistence-changes/2026-09-13-working-directory.md
- Purpose: add durable per-Session working-directory changes.
- Key abstractions: the new root `event:working-directory/change`, whose
  `data` is a single required string `cwd`.
- Data flow: a directory change → a new event → readers see the current cwd.
- Non-obvious design decisions: "The new event is required on read: older
  builds that do not know working-directory/change refuse logs containing it"
  (line 38). Required-on-read is the chosen refusal mode: refuse the log
  rather than guess.
- Edge cases / failure handling: existing headers and events stay valid; the
  event vocabulary grows without changing the structural format.
- Surprising: a brand-new event root is `same-version` even though older
  readers must refuse the log — the decision is about *writers*, not readers.

### docs/persistence-changes/2026-09-14-workspace-changes-event.md
- Purpose: record the files a top-level turn changed.
- Key abstractions: the log-only root `event:workspace/changes`, whose `data`
  is a single required number `turn`.
- Data flow: a turn ends → the Web bundle's workspace-changes plugin appends
  the event → the changed-files card reads the latest event per turn.
- Non-obvious design decisions: "The event is appended only by the Web
  bundle's workspace-changes plugin and is never model-visible; the Web
  changed-files card is its only consumer and reads the latest event per turn"
  (line 38).
- Edge cases / failure handling: readers that predate it refuse a log carrying
  it, as every required-on-read event does.
- Surprising: the persisted payload is just the turn number — the file list
  itself lives in the plugin's own projection, not in the Session log.

### docs/persistence-changes/2026-09-18-schedule-optional-title.md
- Purpose: make the stored title optional on `after`/`at`/`every` schedule
  create records.
- Key abstractions: the `schedule/change` root's create union.
- Data flow: a v1 event written before titles existed decodes without one →
  readers that need a name treat it as an unnamed task.
- Non-obvious design decisions: "The Host task record still requires the
  member: the storage decoder rejects a stored task without it, and creation,
  update, and the schedule tools still require it" (line 38) — the *log* is
  lenient, the *store* is strict, and both statements coexist in one record.
- Edge cases / failure handling: those older logs "decode and fold without one
  instead of being refused".
- Surprising: the schema shows the title optional on all three create
  variants while the dispatch/delete records are unchanged.

### docs/persistence-changes/2026-09-21-user-question-reply.md
- Purpose: a late answer to a continued `ask_user_question` call.
- Key abstractions: the qualified `user-question-reply` message source.
- Data flow: the answer RPC → `agent/inbox/spliced` → the `userQuestions`
  projection closes the named question and records the answers.
- Non-obvious design decisions: "Only the userQuestions projection reads this
  source to close the named question and record its answers. The answer RPC is
  its only producer and writes outcome answered; closing the Client panel
  persists no reply" (line 50).
- Edge cases / failure handling: readers without `dsh-user-questions` preserve
  the message and derive history from its content.
- Surprising: the same qualified-source change is the reason
  `developer/message` and `session/title-llm-request` appear in the
  declaration — they share the `Message` type.

### docs/persistence-changes/historical-formats/README.md
- Purpose: the index and maintenance procedure for the frozen V0–V3 format
  references.
- Key abstractions: a `vN.md`/`vN.zh.md` pair with `kind: persistence-format`,
  a `yaml persistence-format` declaration binding every root key to its
  captured digest, a pairing sidecar, and a complete `vN.schema.json`.
- Data flow: before advancing the writer, `verify-persistence-catalog` then
  `verify-persistence-formats --archive 3` snapshots the outgoing format; then
  `--write` refreshes the generated tables and pairing records.
- Non-obvious design decisions:
  - "`verify-persistence-formats` derives the required integer range from
    `SESSION_FORMAT_VERSION`. Every older integer needs its own complete
    record" (line 51) — coverage is derived, not remembered.
  - "The successor uses the current catalog; copying a new current catalog
    cannot satisfy the archived predecessor requirement" (line 60) — an
    archive must be a *snapshot*, not a re-derivation.
  - "`--archive N` … refuses an existing destination, a version other than the
    current writer, invalid or incomplete schemas, and combination with
    `--write`" (line 60) — the archive command refuses to run against a
    half-advanced writer.
  - The whole check "rejects missing, extra, misnumbered, incomplete, or
    inconsistent records and stale generated regions without fetching Git
    history or querying a service" (line 51).
- Edge cases / failure handling: V1 has no release tag, so its record names an
  intermediate tree (PR #3349) rather than inventing a product release.
- Surprising: the index is *generated* between comment markers
  (`persistence-format-index:start`), and the doc says so — the prose above
  it is authored, the table below it is not.

### docs/persistence-changes/historical-formats/v0.md
*(representative of v0.md / v1.md / v2.md / v3.md, 5,105–5,634 lines each)*
- Purpose: the complete declared type catalogue for one historical Session
  format.
- Key abstractions: source evidence (tag / PR), format characteristics (the
  hand-written part), the machine `yaml persistence-format` declaration, a
  per-root fingerprint table, and a generated "Resolved persistence types"
  section listing every reachable type with its own SHA-256.
- Data flow: historical source tree → `scripts/persistence-schema.ts` →
  `vN.schema.json` → the generated tables in `vN.md`.
- Non-obvious design decisions:
  - V0's characteristics state that `SessionHeader.version` is declared as
    plain `number`: "The source writer constant establishes V0; the numeric
    type alone does not restrict values to 0" (line 37). A broad declaration
    cannot supply a constant — the constant is recorded separately, as the
    release archive also insists.
  - The logical header requires `isSeeded` while the physical header stores
    optional `seedLength`; "This distinction must survive reconstruction of
    historical headers" (V1's wording, line 37).
  - Packed physical rows are described (text-chunks / reasoning-chunks /
    tool-call-chunks with `seq0`, `time0`, `dt` gaps that may be negative),
    and are explicitly *not* extra roots in the declared-type inventory.
- Edge cases / failure handling: "Historical surface-event declarations permit
  optional `surfaceOp`. This is retained evidence of declared types, not
  permission to omit fields required by a codec or migration validator."
- Surprising: the file is 90% generated (roughly 4,900 of 5,105 lines are the
  per-type catalogue) and the hand-written part is only ~115 lines — the
  generated region is fenced with `<!-- persistence-format-schema:start -->`.
  V1 has no tag at all, so its "source evidence" is a branch name and a
  commit title: "This identifies the intermediate tree, not the final merged
  PR tree."

### docs/persistence-changes/releases/README.md
- Purpose: the retrospective archive of 26 alpha/RC tags and their 25
  adjacent transitions.
- Key abstractions: a `kind: persistence-release` record per tag with a
  `yaml persistence-release` declaration (tag, previous, observed writer
  version, per-root before/after digests) and a `.schema.json` snapshot.
- Data flow: source at each tag → the merged `persistence-schema.ts` extractor
  → per-tag snapshot → a generated "Structural changes" table.
- Non-obvious design decisions:
  - "The first snapshot contains every root; later snapshots retain only
    changed roots that remain present and all their reachable types.
    Deletions use a null after value; unchanged releases retain empty changes
    and snapshots" (line 64) — an unchanged release ships a 55-byte empty
    snapshot.
  - "Current-rule classifications of old changes are reading aids: historical
    version 0 did contain structural changes without version increases. A
    backfilled record cannot authorize a current PR to omit acknowledgement or
    a required version increase." (line 68)
  - "Digests describe normalized reconstructed types, not verbatim source text
    or reproduction of the original toolchain … An unchanged digest does not
    establish unchanged behavior." (line 79)
  - "The release-archive check reads only the manifest, records, and snapshots
    in this tree, without Git, network access, or old-version checkouts"
    (line 84).
- Edge cases / failure handling: the first 22 tags legitimately declare
  optional `surfaceOp` on surface events, and historical parsing preserves
  that optionality while current-source parsing still requires the field
  (line 75). The captured tags use writer versions 0, 2 and 3 — **no tag uses
  writer version 1** (line 77).
- Surprising: the reconstruction needed exactly one adaptation — omitting a
  redundant `object` member from intersections of early concrete event
  records (line 73).

### docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.md
*(representative of the 26 release records)*
- Purpose: the tag where the writer jumps 0 → 2.
- Key abstractions: the before/after digest list plus the generated
  "Structural changes" table.
- Data flow: the tag's source → the extractor → 17 changed roots, 25
  structural differences → the table.
- Non-obvious design decisions: the table grades every difference as
  `not-required` or `review-required` **under current rules** — "calculated
  using current rules for comparison only; it does not assert historical
  compliance, migration correctness, or runtime compatibility" (line 110).
  The change kinds are `root-added`, `root-removed`, `property-removed`,
  `required-property-added`, `optional-property-added`,
  `property-made-optional`, `type-changed`, `union-variants-changed`,
  `index-signature-changed`.
- Edge cases / failure handling: a `null` before/after marks addition or
  deletion; a release with no changes still declares `changes: []` and links
  a 55-byte empty snapshot.
- Surprising: the table flags `event:team/member.data.version | type-changed
  | review-required` — the *team* payload version advanced 1→2 without the
  Session writer version advancing, which is exactly the kind of drift the
  release archive was built to make visible.

### docs/persistence-changes/releases/manifest.json
- Purpose: the captured-tag manifest that defines the archive's completeness
  yardstick.
- Key abstractions: `tag`, `sourceDate`, `publishedAt`, `sessionFormatVersion`.
- Data flow: the manifest is the completeness boundary — "Tag completeness is
  relative to the manifest's captured scope; offline checks do not discover
  later tags automatically."
- Non-obvious design decisions: `capturedAt: "2026-09-12"` and the first ten
  entries have `publishedAt: null` ("Tag only; no release object") while the
  other 16 have a publication timestamp.
- Edge cases / failure handling: absent tags are not invented.
- Surprising: the writer version jumps 0 → 2 with no version-1 tag anywhere in
  the manifest, which is why V1 has to be reconstructed from an untagged
  intermediate tree.

### docs/user/develop/practice/llm-adapter.md
- Purpose: how to connect a new LLM provider.
- Key abstractions: `LlmAdapter` with `stream(options): AsyncIterable<StreamChunk>`;
  the `StreamChunk` protocol; `GenerateOptions`; `resolveModel`;
  `listModels`; `LlmError` with stable codes.
- Data flow: the agent loop → `GenerateOptions` → adapter → provider HTTP →
  provider stream → `StreamChunk` sequence → the loop's chunk accumulator.
- Non-obvious design decisions:
  - The chunk protocol is a *state machine*, not a bag of events: every
    `block-start` has a matching `block-end`, `index` increases from 0 and
    identifies content-block order, `usage` is emitted before `finish`, and
    `finish` is the final chunk (lines 104–110).
  - "If the provider cannot honor a field, throw `LlmError` with a stable
    code instead of silently dropping it" (line 114).
  - "preserve the adapter's authoritative selectable list, including `off`
    when its upstream capability API returns it, instead of promoting those
    values into a core enum" (line 116) — the *menu* vocabulary and the
    *wire* vocabulary are different things, and only `off` is universal.
  - `resolveModel(provider, model, signal?)` returns identity **plus**
    context/reasoning metadata in one lookup, and "The service validates the
    aggregate and rejects unsupported explicit efforts before `stream()`"
    (line 116) — validation happens before the request, not after.
  - "Every provider HTTP request must also merge `attributionHeaders()` and
    forward `options.signal`" (line 156).
- Edge cases / failure handling: `LlmError` carries a stable code; the agent
  loop "preserves the error and code for diagnostics and policy; it does not
  convert an ordinary `Error` automatically" (line 156).
- Surprising: `GenerateOptions` carries an "adapter-owned reasoning-effort id"
  rather than a core enum, and `options.model` is "an adapter-owned model id
  without lifecycle registration" (line 124) — model identity is not
  registered in a global table.

### docs/user/develop/framework/events.md
- Purpose: the Cordis event system as DSH uses it.
- Key abstractions: four event modes — `emit` (broadcast, return values
  ignored), `bail` (first non-null/false/undefined result wins), `serial`
  (ordered, awaited, first result stops), `waterfall` (each listener may wrap
  the downstream result).
- Data flow: a plugin registers `ctx.on(name, handler)`; a dispatcher calls
  `ctx.emit` / `ctx.bail` / `ctx.serial` / `ctx.waterfall`.
- Non-obvious design decisions:
  - "A waterfall listener **must call `next()` to delegate downstream**;
    omitting the call short-circuits the pipeline" (line 66), and the warning
    box names that as deliberate: "enabling interception and gateway
    behavior" (line 80).
  - "`turn/*`, `step/*`, `tool/call`, `tool/result`, and `compaction/*` are
    durable session-event types, not same-named Cordis events. To observe
    them, listen to `session/event` and inspect `event.type`" (line 106) — the
    namespacing collision is called out explicitly.
  - Events are typed by declaration merging into `interface Events`.
- Edge cases / failure handling: a listener registered with `ctx.on()` is
  removed automatically when its plugin unloads; `bail`/`serial` treat
  `null`, `false` and `undefined` uniformly as "continue".
- Surprising: DSH's own event names are `namespace/action`
  (`agent/pre-step`, `agent/request`, `agent/request-error`, `tools/result`,
  `session/event`), and the "request-error" event is a first-class signal
  rather than a thrown exception.

### docs/user/develop/framework/index.md
- Purpose: the plugin lifecycle reference.
- Key abstractions: the **Fiber** scope and its states —
  `PENDING → LOADING → ACTIVE ↘ FAILED`, `ACTIVE → UNLOADING → DISPOSED`.
- Data flow: `inject` gates loading; `ctx.on` / `ctx.tools.register` /
  `ctx.llm.registerAdapter` / `ctx.effect` are all *effects* that are undone
  on unload; `ctx.plugin()` creates a child Fiber with its own lifecycle.
- Non-obvious design decisions:
  - "During unload, disposer invocation starts in reverse registration order,
    but multiple async disposers run concurrently and have no serial
    completion guarantee. Put order-dependent cleanup in one disposer
    returned from a single `ctx.effect()` and await its steps serially there."
    (line 63) — the doc states the hazard instead of hiding it.
  - "If a required service disappears, for example during provider
    replacement, the plugin unloads automatically (ACTIVE → DISPOSED) and
    loads again when the service returns."
  - HMR works because "plugin registrations clean themselves up, hot
    replacement does not retain registrations from the old instance".
- Edge cases / failure handling: `dispose` guarantees (1) registrations removed,
  (2) children recursively unloaded, (3) the promise resolves after all async
  cleanup finishes.
- Surprising: the state machine has no `RELOADING` state — a provider swap
  disposes the dependent and re-`apply`s it from scratch.

### docs/user/develop/framework/service.md
- Purpose: how a capability is exposed to other plugins.
- Key abstractions: a *service* is a named capability mounted on `ctx`;
  `inject` declares required services; `ctx.get(name)` is the optional
  variant.
- Data flow: a provider extends `Service` and calls `super(ctx, 'metrics')`;
  consumers declare `inject: ['metrics']` and type `ctx.metrics` by
  declaration merging.
- Non-obvious design decisions:
  - "If a required service disappears while the application is running …
    1. Dependent plugins dispose automatically. 2. They load again when the
    service returns. This prevents a plugin from calling a service that no
    longer exists." (lines 104–109)
  - `cordis.yml` can `isolate:` a service per plugin group, so two groups see
    different instances of the same service with no cross-group effect
    (lines 113–139).
  - "The repository generates the service names, public methods, and source
    locations into each service's subsystem page … do not maintain a second
    static list." (line 143) — the reference is generated from source.
- Edge cases / failure handling: a service may itself declare `inject`, so
  service dependencies are themselves dependency-driven.
- Surprising: `isolate:` is a configuration-level concept — isolation is
  expressed in the *composition file*, not in code.

### docs/user/develop/practice/index.md
- Purpose: the three-role capability pattern.
- Key abstractions: **Service Definition** (`dsh-shell`),
  **Service Provider** (`dsh-bash-local`), **Consumer** (`dsh-tool-bash`).
- Data flow: the consumer depends on the definition; the provider implements
  the definition; the two never depend on each other.
- Non-obvious design decisions:
  - "The complete capability is its seam. No individual role is a seam."
    (line 9)
  - "Do not split preemptively — use separate packages only when the roles
    need to evolve independently. A simple tool plugin does not." (line 149)
  - "Explicit > implicit — resolve defaults in an explicit `resolve(request):
    Spec` step rather than hiding `?? default` expressions inside `run()`."
    (line 151)
- Edge cases / failure handling: the definition owns the Request/Result types,
  so providers and consumers depend only on the definition package.
- Surprising: the same three roles are what makes a provider swappable
  without touching the tool surface — "the Service Definition and tool remain
  unchanged while the provider changes" (line 42).

### docs/user/develop/basic/publish.md
- Purpose: packaging a plugin as a **bundle** and installing it into a
  **profile**.
- Key abstractions: `dsh.bundle` (a package that contributes a patch layer)
  vs `dsh.profile` (a runnable composition under `$DSH_HOME/profiles/<name>`);
  `engines.dsh` SemVer ranges.
- Data flow: bundle patch → profile `bundles` list → layer order → effective
  Cordis configuration.
- Non-obvious design decisions:
  - The four-layer order (lines 122–127): each bundle patch in list order
    (base first), then the profile's own `cordis.patch.yml`, then
    `$DSH_HOME/cordis.patch.yml`, then each `--patch` overlay in argv order.
    "App arguments are not another patch layer."
  - "Later layers win per row, and a patch replaces a row's entire `config`
    value rather than deep-merging keys" (line 131) — a bundle author must
    restate every key the row needs.
  - A git install "fetches **sources, not built artifacts**" (line 169); the
    author must ship a self-contained `prepare` script and the user must
    allowlist it via `allowBuilds` in `pnpm-workspace.yaml`.
  - "Treat that allowance as **permission to execute the package's code on
    your machine at install time**, outside any sandbox the agent runs under."
    (line 181) — with the mitigation: pin a commit.
  - `engines.dsh` is checked at install and at profile startup; without it the
    `@deepseek-ai/dsh*` peer ranges are checked instead.
- Edge cases / failure handling: a package without `dsh.bundle` still installs
  but activates no layer, and `dsh plugin` warns.
- Surprising: peer resolution is a documented lookup-order contract
  ("A nearer physical package wins before a higher peer declaration", line
  107) shared by npm, Desktop and source launches.

### docs/user/develop/basic/config.md
- Purpose: plugin configuration via `cordis.yml`.
- Key abstractions: an exported `Config` **interface** and a same-named
  **Schemastery schema**; the schema supplies the defaults.
- Data flow: `cordis.yml` → schema validation at load → typed `config`
  argument to `apply(ctx, config)`.
- Non-obvious design decisions:
  - "Harness requires **anything that two deployments may want to set
    differently to be a configuration field**" (line 80), with the operative
    test: "whether `cordis.yml` can change the value without a code edit"
    (line 92).
  - "Do not export a plain object as `Config`; it does not implement the
    Standard Schema interface required by Cordis." (line 45)
  - "Invalid configuration fails the load with an actionable error" — the
    schema runs at load time, not at first use.
  - "A configuration edit hot-replaces the plugin: the framework unloads the
    old instance and loads a new one. Because registrations are effects and
    clean themselves up, replacement does not retain the old instance's
    registrations." (line 100)
- Edge cases / failure handling: self-contained constraints belong in the
  schema; constraints on services or registered resources need dependency
  injection instead.
- Surprising: the failure mode is *load-time*, so a misconfigured plugin
  never reaches a running state.

### docs/user/develop/basic/tool.md
- Purpose: adding a `greet` tool to the Web UI.
- Key abstractions: `defineTool({ name, description, parameters, output, execute })`
  where `output` has a `schema` (the canonical value) and a `render` (the
  model-facing content).
- Data flow: `ctx.tools.register(...)` → the model sees the tool schema → the
  model calls it → `execute` returns the canonical value → `render` converts
  it to content blocks.
- Non-obvious design decisions: "`defineTool` infers and validates `args` from
  `parameters`; `execute` returns the canonical value declared by
  `output.schema`, and `output.render` converts that value to model-facing
  content" (line 36) — the *program* value and the *model* value are separate
  types with an explicit conversion.
- Edge cases / failure handling: `inject: ['tools']` makes the framework wait
  for the tool registry.
- Surprising: the same page points at a cookbook for "nested schemas,
  canonical values, background work, policy hooks, PTC mode, and UI cards" —
  the tool contract is broader than the 20-line example.

### docs/user/develop/basic/index.md
- Purpose: the first-plugin tutorial.
- Key abstractions: a plugin is a module exporting `apply(ctx)`; `ctx.effect()`
  for disposers; `inject` for dependencies; three plugin forms (function,
  object, class).
- Data flow: `cordis.yml` `--patch` overlay → the loader resolves an
  **absolute** module path → `apply(ctx)` → registrations.
- Non-obvious design decisions:
  - "The plugin path must be absolute. A patch file contributes configuration
    but does not change the profile directory from which the loader resolves
    module paths." (line 56)
  - "Anything registered through `ctx`—event listeners, tools, or timers—is
    cleaned up when the plugin unloads. You do not need to call
    removeListener or clearInterval manually." (line 68)
  - "The framework waits for every required service before loading the
    plugin." (line 103)
- Edge cases / failure handling: class form exists for plugins that provide a
  service; function form is sufficient otherwise.
- Surprising: the tutorial's own scratch directory is named `scratch-plugin`
  and lives at the repo root, so the tutorial is reproducible from a checkout.

### docs/user/develop/practice/dynamic-cordis.md
- Purpose: configuring persistent plugins from a natural-language prompt.
- Key abstractions: Creator mode; the `plugin_manager` tool; a
  **configuration-only bundle** whose patch inserts a plugin row.
- Data flow: prompt → the agent writes the bundle → `plugin_manager
  install_bundle` → with HMR, the tools appear in the *same running session*.
- Non-obvious design decisions: the agent must "Verify both the management
  result (`application: applied`) and a successful `mcp__demo__ping` call.
  A saved entry with `restart-required` has not activated yet; a failed entry
  needs configuration repair." (line 13) — three distinct outcomes, and the
  verification is two-sided.
- Edge cases / failure handling: "Read the bundle patch before editing its
  configuration" — the file is the source of truth for the active state.
- Surprising: a plugin configuration change is *persistent* and belongs to the
  current profile, so a prompt is a durable write to the user's machine.

### docs/user/guide/providers.md
- Purpose: configuring models, providers, custom gateways, reasoning levels and
  request compatibility.
- Key abstractions: the DeepSeek card, third-party providers, **Custom model
  API** (Provider ID, base URL, API protocol, credential, models); the three
  protocols `openai-completions` / `openai-responses` / `anthropic-messages`;
  `input` / `inputModalities`; `reasoningEfforts`; the `compat` block.
- Data flow: Settings → Models → the page writes
  `$DSH_HOME/profiles/<profile>/cordis.patch.yml` → the adapters re-read it on
  the next request → no restart.
- Non-obvious design decisions:
  - "Keys are write-only. The page receives a redacted descriptor after
    saving, never the literal secret. The key is stored in
    `$DSH_HOME/.credentials.yaml`, while settings retain only its credential
    reference." (line 13)
  - "Give every switch you name a value: a key left empty
    (`supportsDeveloperRole:`) is refused rather than ignored, because an
    empty value would erase what the catalog knows while saying nothing in its
    place. A name no protocol accepts is refused too, and the message lists
    the ones that are available." (line 209)
  - "`defaultInput` is a fallback, not an override, and defaults to `[text]`:
    on a built-in provider it answers only for models its catalog does not
    describe" (line 99) — a route default cannot remove a capability a
    catalog model has.
  - Reasoning levels are a *menu key → wire value* map: "Each key is a level
    the menu offers, and its value is the spelling sent on the wire as
    `reasoning_effort`, so `max: xhigh` renames a level for a gateway with its
    own vocabulary. Only `off` may stay empty" (line 155).
  - "Both fields state a claim about your endpoint rather than checking it."
    (line 113) — the same honesty as the persistence records: a declaration is
    not a probe.
  - The two dominant gateway failures are named with their fix:
    `compat.supportsDeveloperRole: false` and `compat.maxTokensField:
    max_tokens` (lines 182, 221–222).
- Edge cases / failure handling: "A route's `compat` is the default for its
  models, and a model's own wins field by field"; "What neither sets keeps
  the installed catalog's value … and what the catalog does not describe falls
  to pi-ai's detection"; "Each switch belongs to the protocols that declare
  it, so a switch valid on one `api` may be refused on another".
  An image-capability claim that the endpoint does not honour fails at the
  provider, and "start a new session: the attached image stays in the session
  log, so the same request repeats until the session moves off it" (line 227).
- Surprising: `off` is *not* a universal "no thinking" switch — an empty
  `off` sends no reasoning field at all, so a model that thinks by default
  keeps thinking; `compat.thinkingFormat: deepseek` is what makes `off` send
  `thinking: {type: disabled}` (line 157).

### docs/user/guide/network-proxy.md
- Purpose: running DSH behind an outbound proxy.
- Key abstractions: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`;
  the "What stays direct" list.
- Data flow: variables read **at launch** → applied to model calls, web
  search, page fetches and HTTP MCP servers.
- Non-obvious design decisions:
  - "A project's own `.env` cannot set them: it arrives with `git clone`, and
    DSH refuses to start rather than let a repository decide where your
    traffic goes." (line 14)
  - "**SOCKS proxies are not supported.** A `socks5://` value is reported at
    startup and skipped, and DSH connects directly for the scheme that named
    it — setting `HTTPS_PROXY=socks5://…` alongside a usable `HTTP_PROXY`
    leaves `https:` direct rather than borrowing the HTTP proxy." (line 48)
  - "**A password in the proxy URL reaches those tools too.** … every command
    DSH runs — including the ones the model writes — can read it, and a
    command that prints its environment puts the password in output that is
    kept." (line 62) — the doc states the leak rather than pretending it away.
  - "Code the model writes. Workflow workers and Node ptc-runtime processes
    receive no proxy settings, so model-authored scripts cannot read a proxy
    URL that may carry a password." (line 69)
- Edge cases / failure handling: CIDR ranges in `NO_PROXY` do not work (host
  names or domain suffixes only); loopback is always bypassed; a literal
  private address in `web_fetch` is refused rather than proxied; telemetry
  connects directly and simply fails where direct egress is blocked.
- Surprising: the doc explains the three unrelated proxy mechanisms (OS
  settings, env vars, TUN) precisely so the reader does not conclude DSH is
  broken when the browser is proxied and the terminal is not.

### docs/user/guide/mcp-memory.md
- Purpose: three default-off reference configurations for third-party memory
  MCP servers.
- Key abstractions: `dsh-mcp-client` with `serverName`, `transport: stdio |
  streamable-http`, `command`/`args`/`env`/`cwd` or `url`/`headers`.
- Data flow: overlay → the client starts the child or connects → MCP tools
  are exposed as `mcp__<serverName>__<tool>`.
- Non-obvious design decisions:
  - "The stdio bridge deliberately removes ambient variables whose names
    usually identify credentials and all `DSH_*` variables before launching a
    child; other ambient variables remain inherited." (line 13) — a
    credential-shaped env is stripped by *name*, and a needed secret must be
    added explicitly to `config.env`.
  - "DSH does **not** download the server, initialize its database, choose its
    model or embedding provider, create a cloud account, migrate vendor data,
    or supervise a separate HTTP service." (line 11) — the responsibility
    split is stated in the negative, which is the useful form.
  - Each reference is pinned by version **and** commit hash (line 19–21).
  - "A crashed MCP child triggers automatic reconnection with backoff and a
    tool re-sync; tools stay listed and calls fail only during the outage,
    and after the reconnect budget is exhausted the tools are unregistered and
    reconnection stops until a reload or restart." (line 82)
- Edge cases / failure handling: "Initial discovery is asynchronous, so wait
  for the provider's `mcp__...` tools before sending the first validation
  prompt."
- Surprising: the guide's own verification procedure is a **three-session
  test** — write in session A, recall in a *fresh* session B, then use the
  recalled value — designed to catch a memory server that only appears to work
  within one conversation.

### docs/user/guide/schedule.md
- Purpose: reminders, their editing, and their delivery semantics.
- Key abstractions: `schedule_create` / `schedule_list` / `schedule_update` /
  `schedule_delete`; the Automation tasks page; the record kinds (one-time
  delay, absolute date-time, fixed interval, daily/weekly local time, cron).
- Data flow: the model creates a task → the Host schedules it → the reminder
  is written into the conversation inbox → a saved delivery record confirms
  persistence.
- Non-obvious design decisions:
  - "The `standard`, `cordis`, and `ptc` presets declare the four reminder
    tools … the `minimal` preset declares neither. A delegated subagent sees
    none of the four tools, because the presets' delegation rows deny them; a
    call that reaches one anyway is refused." (line 22) — denial is enforced
    at the *delegation* boundary, with a refusal behind it.
  - "Saved delivery records confirm messages persisted in the conversation
    inbox, not that the model completed the requested work. Failed inbox
    persistence or task writes add no saved record. A crash or task-write
    failure after inbox persistence can leave a delivered message unrecorded
    and repeat a delivery; exactly-once delivery is not guaranteed." (line 65)
  - "Records follow newest-first saved order even if the clock moves
    backward; they do not describe model execution results." (line 33)
  - "A catalog refresh keeps the fields you have edited and takes every other
    field from the refreshed record, so a concurrent change to another field
    survives an unsaved edit. … If delivery or another edit changed the
    task, a conflict prevents overwriting that change" (line 56) — an
    optimistic-concurrency rule stated for the UI.
  - DST behaviour is spelled out: "A daily local time or date that does not
    exist is skipped; an overlapping time uses the earlier instant once that
    day." (line 63)
- Edge cases / failure handling: an inactive task is read-only; a one-shot
  becomes inactive *after* its reminder is durably written; deletion removes
  the saved delivery records with the task; "If a query fails, Retry reloads
  the catalog; the error is not an empty successful result." (line 43)
- Surprising: "Reminders recorded only in an older Session log are not
  scheduled automatically; recreate the ones you still need" (line 69) — a
  reminder is a live Host object, not a log entry.

### docs/user/guide/plugin-market.md
- Purpose: the plugin-market index format and the reference generator.
- Key abstractions: the index JSON (`format: 1`), `LocalizedText`, the
  plugin / version / source / `engines.dsh` tables.
- Data flow: a plain list of package names or Git URLs → the generator →
  `index.json` plus an `icons/` directory → any static host → the Discover
  tab.
- Non-obvious design decisions:
  - "The generator only downloads and reads files; it never installs packages
    or runs their code. It keeps a cache in `.plugin-market-cache` next to the
    list, so a repeated run downloads only new versions and commits."
    (line 102)
  - "Markets are third-party content. A market chooses each plugin's title,
    description, icon, author, and source; DSH checks the file format but not
    those claims. Add only sources you trust, and check the source in the
    confirmation before installing." (line 34)
  - The recommended version is "the highest version compatible with the
    running DSH that is not a prerelease, or the highest compatible prerelease
    when the plugin lists no version without a prerelease tag" (line 30).
  - "Anyone on the network path can change an `http:` index, including the
    install specs it lists, so use `https:` for a market reached over a
    network you do not control." (line 23)
- Edge cases / failure handling: an index is at most 128 MiB, must be served
  with a 2xx and without redirects; an absolute icon URL on another origin
  must use `https:`; the whole index is rejected on any rule violation, with
  the JSON path of the offending value.
- Surprising: the `Install` confirmation shows the *source* (npm package and
  registry, or Git repository, commit and directory) and nothing is installed
  without it — the market cannot install anything on its own.

### docs/user/guide/python-sdk.md
- Purpose: the published Python SDK and the bundled `sdk-minimal` profile.
- Key abstractions: `DeepSeekHarness(provider, model, max_tokens, cwd,
  dsh_home, profile, patches=...)`; `harness.run(prompt, session_id=...)`;
  `result.final_response`.
- Data flow: the SDK starts `dsh --profile sdk-minimal` lazily and reuses it
  until the context manager exits; sessions land as uncompressed JSONL under
  `<dsh_home>/sessions`.
- Non-obvious design decisions:
  - "The example and SDK never silently read `~/.dsh`." (line 94) — the home
    is always explicit.
  - The minimal profile's property table (lines 167–175) names the system
    prompt, the model resolution order (`--model`, then `DSH_MODEL`, then
    `deepseek-v4-flash`), the model-facing tools, the 300 s shell timeout,
    **automatic compaction** ("summarizes older history through an additional
    model request") and the JSONL persistence format.
  - "It pins `danger-full-access`, so the platform-selected persistent shell
    can modify any path visible to the runtime; use a disposable checkout or
    container." (line 177)
  - "The profile's sole bundle inserts the complete tree over an empty root
    and does not include `dsh-base`; later base-profile tools therefore cannot
    appear implicitly." (line 177)
  - "The installed wheel still packages the full `web` profile and frontend
    assets … `web` is a separate CLI application and cannot serve a Python SDK
    client." (line 181)
- Edge cases / failure handling: "Another `profile` is valid when it includes
  `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. Missing server
  rows, unresolved plugins, and invalid patches fail during startup instead of
  falling back to another composition." (line 150)
  `str_replace_editor` is bundled but omitted from `sdk-minimal` and must be
  opted into with a patch.
- Surprising: "Image reading requires an image-capable route" — the SDK ships
  `read_image` unconditionally, but the route must accept images.

### docs/user/guide/public-deployments.md
- Purpose: publishing the Web UI behind a reverse proxy.
- Key abstractions: `--public-url` (the advertisement), `--trusted-host` (the
  admission fence), `--tls-cert` / `--tls-key` (native TLS).
- Data flow: the browser → the proxy → the loopback listener; the printed
  URL carries a launch token that is exchanged for a signed session cookie.
- Non-obvious design decisions:
  - "The fence accepts loopback, the listener's own bind address, and every
    authority `--trusted-host` names. A browser that reaches the deployment
    under any other authority gets 403 for every API call, however correct
    the proxy is, so name the browser-visible authority with
    `--trusted-host`; **advertising it with `--public-url` is display only and
    does not admit it.**" (line 25)
  - "The fence only admits the request; the launch token in the printed URL
    and the signed session cookie authenticate it." (line 25)
  - Five proxy duties are enumerated (line 17–21): preserve the browser-facing
    `Host`, strip the mount prefix, forward upgrades, rewrite cookie scope,
    and redirect the bare mount — because "`/ui/` is the only entry: it alone
    exchanges the launch token for the session cookie".
- Edge cases / failure handling: "Neither the advertised URL nor the fence
  protects the listening port itself, so restrict the port to the trusted
  proxy or network." (line 27) An `http://` browser-facing root exposes the
  launch token in plaintext.
- Surprising: the cookie-scope rewrite differs by whether the backend serves
  plain HTTP or its own TLS — the proxy adds `Secure` only in the first case.

### docs/user/guide/github-review.md
- Purpose: creating review Sessions from GitHub webhooks.
- Key abstractions: a second `WebServer` in an isolated realm; a rule module
  that returns a Session request; the `DSH_GITHUB_WEBHOOK_SECRET` credential
  reference.
- Data flow: GitHub `POST /github` → signature check → the rule runs → it may
  create a titled root Session with a read-only review prompt.
- Non-obvious design decisions:
  - "The HTTP response is intentionally weaker than the Agent outcome: `202`
    means the signature and JSON were accepted and rule calls were scheduled
    in memory. It does not mean this rule matched or that a Session was
    created." (line 69)
  - "It passes the exact head SHA plus selected PR fields to the review
    prompt, labeling the JSON as untrusted metadata and forbidding file,
    branch, PR, or GitHub mutation." (line 65)
  - "The overlay mounts a second WebServer in an isolated realm; only `POST
    /github` is registered there, and every other path returns `404`."
    (line 39)
  - "The webhook secret authenticates inbound GitHub data only. It grants
    neither rule code nor the created Agent outbound GitHub access" (line 99).
- Edge cases / failure handling: "The webhook runtime stores no delivery or
  execution state. Repeated delivery runs the rule and may create another
  Session. A crash loses rule calls that have not admitted their prompt."
  (line 97)
- Surprising: `run()` is ordinary trusted JavaScript, so a deployment can
  query an internal policy service before returning a Session request, and
  can map repositories to different local paths (lines 73–93) — the extension
  point is code, not configuration.

### docs/user/guide/index.md
- Purpose: the Web-UI quickstart.
- Key abstractions: Settings → Models; Choose workspace; a session.
- Data flow: save an API key → the route becomes usable without a restart;
  add a workspace → the composer unlocks.
- Non-obvious design decisions: "The `dsh` process uses its invoking
  directory as the default filesystem location, but a fresh Web UI has no
  selected workspace until you add one." (line 5) and "The session composer
  remains unavailable until a workspace is selected." (line 15)
- Edge cases / failure handling: "The Web UI asks before operations that
  require approval under the active permission policy." (line 23)
- Surprising: the model route becomes usable **immediately** after saving a
  key — no restart — while the workspace must be picked before any input.

### docs/persistence-changes/README.zh.md
- Purpose: the Chinese mirror of the change-record rulebook.
- Key abstractions: identical to the English file — the same compatibility
  table, the same `@persistenceSource` / `@persistenceAttribution` /
  `@persistenceReserved` policy text, the same verifier scope.
- Data flow: the English file is authoritative; the Chinese file must carry
  the *identical* machine declaration, which the verifier checks for equality.
- Non-obvious design decisions: the Chinese text keeps the technical terms
  untranslated where precision matters ("same-version", "version-bump",
  "Session header", "event envelope") and translates the reasoning.
- Edge cases / failure handling: the pairing record (`.i18n.yaml`) is what
  detects drift at the section level.
- Surprising: the Chinese file spells out the same subtlety in one extra
  sentence — the classification of a "same-version" change requires an
  explicit CLI choice, so the *absence* of a decision is itself an error.

### docs/persistence-changes/2026-09-11-initial.md
- Purpose: the baseline acknowledgement of the whole type inventory.
- Key abstractions: `baseline: true`, 64 roots each with `previous: null` and
  a `same-version` decision.
- Data flow: `gen-persistence-catalog.ts` → `persistence-changes --baseline
  2026-09-11-initial` → this record + its schema snapshot.
- Non-obvious design decisions: "This record initializes type history without
  asserting relationships to earlier formats or changing the Session writer
  version or runtime behavior." (line 270) — a baseline asserts nothing about
  the past.
- Edge cases / failure handling: "Each root starts without a predecessor and
  retains its complete normalized schema; successor records reference its
  after schema."
- Surprising: every one of the 64 roots is `same-version` — a baseline is not
  a version bump, it is the start of the history.

### docs/persistence-changes/2026-09-14-image-offload.md
- Purpose: record which image occurrences were offloaded, and derive the
  offloaded marks from the owning plugin's message projection.
- Key abstractions: the new root `event:image/offload`; an optional
  `offloaded` field on thirteen message-bearing roots.
- Data flow: an image is offloaded → the event is written → the owning
  plugin's projection derives the marks.
- Non-obvious design decisions: "The optional offloaded image field leaves
  unmarked occurrences retained. The new event is required on read: older
  builds that do not recognize image/offload refuse those logs, and current
  readers require its message projection." (line 86)
- Edge cases / failure handling: event envelopes and structural Session
  format versions are unchanged; the Python advanced SDK recording was
  refreshed through the built `dsh` profile so the standalone event appears.
- Surprising: the change touches thirteen roots because the offload mark
  rides on the shared `Message`/`ContentBlock` declarations — one field, many
  reachable schemas.

### docs/user/develop/basic/index.zh.md
- Purpose: the Chinese mirror of the first-plugin tutorial.
- Key abstractions: identical to the English file (the `apply(ctx)` contract,
  `ctx.effect`, `inject`, the three plugin forms).
- Data flow: the Chinese file is authoritative only for prose; the code
  blocks and the machine facts are identical.
- Non-obvious design decisions: the Chinese version keeps "Cordis" and the
  API names in English and translates the explanations.
- Edge cases / failure handling: the per-heading hash pairing is what keeps
  the two sides in step.
- Surprising: the tutorial is 144 lines in both languages — the Chinese
  version is not a summary, it is a full translation.

### docs/user/develop/framework/events.zh.md
- Purpose: the Chinese mirror of the event-system reference.
- Key abstractions: the same four event modes, the same `next()` requirement,
  the same Cordis-vs-session-event distinction.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese text keeps the mode names
  (`emit`, `bail`, `serial`, `waterfall`) and translates the contract
  sentences around them.
- Edge cases / failure handling: the pairing record detects a lagging
  translation at the section level.
- Surprising: the code blocks in the Chinese file are byte-identical to the
  English ones, including the `ignore-check` markers that keep the examples
  out of the compiler's way.

### docs/user/develop/framework/index.zh.md
- Purpose: the Chinese mirror of the plugin-lifecycle reference.
- Key abstractions: the same Fiber state table and the same disposer caveat.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the state names
  (`PENDING` / `LOADING` / `ACTIVE` / `FAILED` / `UNLOADING` / `DISPOSED`) in
  English inside a translated table.
- Edge cases / failure handling: the disposal-order caveat is present in both
  languages.
- Surprising: the Chinese file is 137 lines against the English 137 — the
  translation is line-for-line.

### docs/user/develop/framework/service.zh.md
- Purpose: the Chinese mirror of the services reference.
- Key abstractions: the same `Service` extension pattern, the same
  "when a service disappears" behaviour, the same `isolate:` example.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version translates "提供方" /
  "消费者" style terms consistently and keeps `inject` / `ctx.get()` in code.
- Edge cases / failure handling: the isolation example is reproduced
  verbatim, including both group rows.
- Surprising: 150 lines against the English 148 — the Chinese version is
  marginally longer, which is why the pairing hashes are per-section rather
  than per-file.

### docs/user/develop/practice/index.zh.md
- Purpose: the Chinese mirror of the three-role capability reference.
- Key abstractions: the same three roles and the same three-package Bash
  diagram.
- Data flow: identical to the English file.
- Non-obvious design decisions: "完整能力构成其 seam。任何单一角色都不是
  seam。" — the seam sentence is translated literally, which is the one place
  a bad translation would do real damage.
- Edge cases / failure handling: the design points ("Do not split
  preemptively", "Explicit > implicit") are translated in full.
- Surprising: the ASCII diagram is reproduced identically, box for box.

### docs/user/develop/practice/llm-adapter.zh.md
- Purpose: the Chinese mirror of the LLM-adapter guide.
- Key abstractions: the same `StreamChunk` protocol, the same
  `reasoningEfforts` reasoning, the same `LlmError` rule.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese text keeps the "stable code"
  phrasing and the "instead of promoting those values into a core enum"
  argument intact, because that is the design decision.
- Edge cases / failure handling: the `attributionHeaders()` requirement is
  restated in Chinese.
- Surprising: 189 lines in both languages.

### docs/user/develop/practice/dynamic-cordis.zh.md
- Purpose: the Chinese mirror of the configure-plugins-from-a-prompt note.
- Key abstractions: the same three outcomes (`application: applied`,
  `restart-required`, failed).
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version preserves the literal
  prompt text and the `mcp__demo__ping` call shape.
- Edge cases / failure handling: "返回 `restart-required` 的已保存条目尚未激活"
  — the "saved but not active" state is called out in both.
- Surprising: 15 lines in both — a deliberately short note.

### docs/user/develop/basic/config.zh.md
- Purpose: the Chinese mirror of the plugin-configuration tutorial.
- Key abstractions: the same exported `Config` interface + Schemastery
  schema pattern.
- Data flow: identical to the English file.
- Non-obvious design decisions: the "anything that two deployments may want
  to set differently" rule is translated with its emphasis intact.
- Edge cases / failure handling: the "do not export a plain object as
  `Config`" warning is present in both.
- Surprising: 106 lines in both languages.

### docs/user/develop/basic/tool.zh.md
- Purpose: the Chinese mirror of the tool-authoring tutorial.
- Key abstractions: the same `defineTool` shape with `parameters`, `output`
  and `execute`.
- Data flow: identical to the English file.
- Non-obvious design decisions: the canonical-value vs model-content
  distinction is translated explicitly.
- Edge cases / failure handling: the `inject: ['tools']` wait is stated in
  both.
- Surprising: 52 lines in both.

### docs/user/develop/basic/publish.zh.md
- Purpose: the Chinese mirror of the package-and-install tutorial.
- Key abstractions: the same bundle/profile split, the same four-layer
  precedence, the same `engines.dsh` rule.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the layer list
  intact and translates the "a patch replaces a row's entire `config` value
  rather than deep-merging keys" warning.
- Edge cases / failure handling: the `allowBuilds` allowance and its
  "permission to execute the package's code on your machine" warning are
  present in both.
- Surprising: the Chinese version is 3 lines shorter than the English
  (11,228 vs 11,967 bytes) — a good example of why per-section hashes beat a
  file-level check.

### docs/user/guide/providers.zh.md
- Purpose: the Chinese mirror of the model-configuration guide.
- Key abstractions: the same three protocols, the same `reasoningEfforts`
  map, the same `compat` switches.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese text keeps the field names
  (`defaultInput`, `maxTokensField`, `thinkingFormat`) and translates the
  reasoning about why an empty value is refused.
- Edge cases / failure handling: the eleven-item troubleshooting list is
  reproduced in full, including the "start a new session" workaround for the
  stuck-image case.
- Surprising: 227 lines against the English 227.

### docs/user/guide/network-proxy.zh.md
- Purpose: the Chinese mirror of the network-proxy guide.
- Key abstractions: the same env-var contract and the same "what stays
  direct" list.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the three-mechanism
  table and translates the "your browser is proxied but your terminal is not"
  explanation.
- Edge cases / failure handling: the SOCKS per-scheme rule is stated in both.
- Surprising: 85 lines against the English 85.

### docs/user/guide/mcp-memory.zh.md
- Purpose: the Chinese mirror of the memory-MCP guide.
- Key abstractions: the same three pinned references and the same generic
  MCP row.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the pinned commit
  hashes and the stdio env-stripping rule intact.
- Edge cases / failure handling: the three-session verification procedure is
  reproduced in full.
- Surprising: 101 lines against the English 101.

### docs/user/guide/schedule.zh.md
- Purpose: the Chinese mirror of the schedule guide.
- Key abstractions: the same four tools, the same timing rules, the same
  delivery-record semantics.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese text keeps "exactly-once
  delivery is not guaranteed" as a first-class statement.
- Edge cases / failure handling: the DST and pruning rules are reproduced.
- Surprising: 79 lines against the English 79.

### docs/user/guide/plugin-market.zh.md
- Purpose: the Chinese mirror of the plugin-market guide.
- Key abstractions: the same index-format tables and the same generator
  contract.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps `LocalizedText`,
  `publishTimestamp` and the `engines.dsh` semantics in the table.
- Edge cases / failure handling: the index validation rules are reproduced.
- Surprising: 148 lines against the English 148.

### docs/user/guide/python-sdk.zh.md
- Purpose: the Chinese mirror of the Python SDK guide.
- Key abstractions: the same `DeepSeekHarness` API and the same
  minimal-profile property table.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the `code-group`
  tabs for Linux/macOS and Windows PowerShell.
- Edge cases / failure handling: the `danger-full-access` warning and the
  "never silently read ~/.dsh" rule are both present.
- Surprising: 185 lines against the English 185.

### docs/user/guide/public-deployments.zh.md
- Purpose: the Chinese mirror of the reverse-proxy guide.
- Key abstractions: the same `--public-url` / `--trusted-host` / TLS split
  and the same five proxy duties.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the
  "advertising is display only, it does not admit" distinction.
- Edge cases / failure handling: the launch-token plaintext warning is
  reproduced.
- Surprising: 37 lines against the English 37.

### docs/user/guide/github-review.zh.md
- Purpose: the Chinese mirror of the GitHub-webhook guide.
- Key abstractions: the same isolated-realm WebServer and the same 202
  semantics.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the Caddyfile
  example and the "202 is weaker than the outcome" statement.
- Edge cases / failure handling: the "repeated delivery may create another
  Session" caveat is reproduced.
- Surprising: 99 lines against the English 99.

### docs/user/guide/index.zh.md
- Purpose: the Chinese mirror of the Web-UI quickstart.
- Key abstractions: the same three-step flow.
- Data flow: identical to the English file.
- Non-obvious design decisions: the Chinese version keeps the note that the
  composer is unavailable until a workspace is selected.
- Edge cases / failure handling: the approval prompt sentence is reproduced.
- Surprising: 31 lines against the English 31.

### docs/user/index.md
- Purpose: the user-docs landing page.
- Key abstractions: a `layout: false` frontmatter with a `meta http-equiv:
  refresh` pointing at `./guide/quickstart`.
- Data flow: the static site redirects to the quickstart.
- Non-obvious design decisions: the landing page carries no prose at all
  beyond the title, so the English and Chinese pages differ only in one line
  — and the pairing record reflects that (the root section hash is identical
  on both sides, `dc6b778eb6f830d6`).
- Edge cases / failure handling: none.
- Surprising: the i18n pairing record for this file has the same hash for the
  root section on both languages, which is exactly what a hash-pairing gate is
  supposed to be able to say.

### docs/persistence-changes/historical-formats/v1.md
- Purpose: the V1 format reference, for a format with **no release tag**.
- Key abstractions: identical to v0.md; the difference is the source
  evidence and the version literal.
- Data flow: the last V1 tree before the first V2 writer change in the
  ancestry of `dsh-v0.1.3-alpha.1` → the extractor → `v1.schema.json`.
- Non-obvious design decisions: "Its source change is dated 2026-09-02 and
  titled `fix(session): close live assistant framing races`. This identifies
  the intermediate tree, not the final merged PR tree. The prerelease archive
  records no V1 tag, so no product release is invented for this record."
- Edge cases / failure handling: "`SessionHeader.version` resolves to the
  literal 1; physical `JsonlHeaderLine.version` remains `number`."
- Surprising: V0 and V1 have the *same* root count (54) and type count (415)
  in the index table, and differ only in the header version literal and the
  digests — a one-token change, and the digest machinery catches it.

### docs/persistence-changes/historical-formats/v2.md
- Purpose: the V2 format reference.
- Key abstractions: the same six-section shape; the difference is embedded
  assistant streams and `isSeeded` in both headers.
- Data flow: tag `dsh-v0.1.3-alpha.2` → the extractor → `v2.schema.json`.
- Non-obvious design decisions: "`assistant/chunk` is absent. Both
  `assistant/message.data` and log-only `assistant/attempt.data` require an
  embedded `stream`." and "The V2 codec owns one-event-per-row framing,
  range-encoded source references, and inherited cuts derived from
  `session/end-seed` markers."
- Edge cases / failure handling: "For a seeded V2 Session, the last
  `session/end-seed` event carrying `data.inherited: true` identifies the
  inherited cut by its sequence position."
- Surprising: V2 introduces a **log-only** event — `assistant/attempt` is
  recorded but never enters model history — which is the same "surface" vs
  "log-only" distinction the finalized baseline encodes as a boolean.

### docs/persistence-changes/historical-formats/v3.md
- Purpose: the V3 format reference, captured before the V4 writer change.
- Key abstractions: the same six-section shape; V3 is where `surfaceOp`
  becomes required and where the system prompt moves out of `request/header`.
- Data flow: the initial tree of PR #4320 (an empty commit dated 2026-09-16)
  → the extractor → `v3.schema.json`.
- Non-obvious design decisions: "The catalog freshness check passed and the
  V3 archive command captured the inventory before the writer advanced. This
  checkpoint is neither the final PR tree nor a new product release."
- Edge cases / failure handling: "Historical surface-event declarations
  permit optional `surfaceOp`. This is retained evidence of declared types,
  not permission to omit fields required by a codec or migration validator."
- Surprising: the V3 archive was produced by a *command* against the live
  inventory (`--archive 3`) rather than by extracting a historical tree —
  the outgoing format is snapshotted from the writer itself, which is why the
  source evidence is "the initial tree of PR #4320".

### The remaining files

All files below were opened and are described here one line each; they are
structural, generated, or mirrored content whose substance is stated above.

- `docs/persistence-changes/2026-09-11-initial.i18n.yaml` — per-heading en/zh
  hash pairing for the baseline record (8 sections).
- `docs/persistence-changes/README.i18n.yaml` — pairing sidecar for the
  change-record README: 8 hash pairs under
  `/persistence-type-change-records` (root, summary, table-of-contents,
  files-and-ownership, compatibility-rules, history-and-limitations,
  dev-note), regenerable with `verify-translation-pairing --write`.
- `docs/persistence-changes/2026-09-12-auto-review-error-metadata.i18n.yaml` —
  per-heading en/zh hash pairing for the auto-review record.
- `docs/persistence-changes/2026-09-14-image-offload.i18n.yaml` — per-heading
  en/zh hash pairing for the image-offload record.
- `docs/persistence-changes/2026-09-14-workspace-changes-event.i18n.yaml` —
  per-heading en/zh hash pairing for the workspace-changes record.
- `docs/persistence-changes/2026-09-16-session-format-v4.i18n.yaml` —
  per-heading en/zh hash pairing for the V4 record.
- `docs/persistence-changes/2026-09-18-schedule-optional-title.i18n.yaml` —
  per-heading en/zh hash pairing for the schedule record.
- `docs/persistence-changes/2026-09-19-external-subagent-catalog.i18n.yaml` —
  per-heading en/zh hash pairing for the external-catalog record.
- `docs/persistence-changes/2026-09-20-unknown-child-catalog.i18n.yaml` —
  per-heading en/zh hash pairing for the unknown-child record.
- `docs/persistence-changes/2026-09-21-user-question-reply.i18n.yaml` —
  per-heading en/zh hash pairing for the user-question-reply record.
- `docs/persistence-changes/2026-09-30-job-session-lifecycle.i18n.yaml` —
  per-heading en/zh hash pairing for the job-lifecycle record.
- `docs/persistence-changes/2026-10-05-ptc-operation-metadata.i18n.yaml` —
  per-heading en/zh hash pairing for the PTC-metadata record.
- `docs/persistence-changes/2026-10-05-working-directory-attribution.i18n.yaml`
  — per-heading en/zh hash pairing for the working-directory-attribution
  record.
- `docs/persistence-changes/2026-10-07-title-reasoning-effort.i18n.yaml` —
  per-heading en/zh hash pairing for the title-reasoning-effort record.
- `docs/persistence-changes/2026-10-13-deepseek-search-thinking.i18n.yaml` —
  per-heading en/zh hash pairing for the DeepSeek-search record.
- `docs/persistence-changes/2026-10-13-user-rpc-principal.i18n.yaml` —
  per-heading en/zh hash pairing for the user-rpc-principal record.
- `docs/persistence-changes/2026-09-11-initial.zh.md` — Chinese mirror of the
  baseline, byte-identical 64-root declaration.
- `docs/persistence-changes/2026-09-12-auto-review-error-metadata.zh.md` —
  Chinese mirror of the auto-review record.
- `docs/persistence-changes/2026-09-13-working-directory.zh.md` — Chinese
  mirror of the working-directory record.
- `docs/persistence-changes/2026-09-14-image-offload.zh.md` — Chinese mirror
  of the image-offload record.
- `docs/persistence-changes/2026-09-14-workspace-changes-event.zh.md` —
  Chinese mirror of the workspace-changes record.
- `docs/persistence-changes/2026-09-16-session-format-v4.zh.md` — Chinese
  mirror of the V4 record.
- `docs/persistence-changes/2026-09-18-schedule-optional-title.zh.md` —
  Chinese mirror of the schedule record.
- `docs/persistence-changes/2026-09-19-external-subagent-catalog.zh.md` —
  Chinese mirror of the external-catalog record.
- `docs/persistence-changes/2026-09-20-unknown-child-catalog.zh.md` —
  Chinese mirror of the unknown-child record.
- `docs/persistence-changes/2026-09-21-user-question-reply.zh.md` — Chinese
  mirror of the user-question-reply record.
- `docs/persistence-changes/2026-09-30-job-session-lifecycle.zh.md` — Chinese
  mirror of the job-lifecycle record.
- `docs/persistence-changes/2026-10-05-ptc-operation-metadata.zh.md` —
  Chinese mirror of the PTC-metadata record.
- `docs/persistence-changes/2026-10-05-working-directory-attribution.zh.md` —
  Chinese mirror of the working-directory-attribution record.
- `docs/persistence-changes/2026-10-07-title-reasoning-effort.zh.md` —
  Chinese mirror of the title-reasoning-effort record.
- `docs/persistence-changes/2026-10-13-deepseek-search-thinking.zh.md` —
  Chinese mirror of the DeepSeek-search record.
- `docs/persistence-changes/2026-10-13-user-rpc-principal.zh.md` — Chinese
  mirror of the user-rpc-principal record.
- `docs/persistence-changes/2026-09-11-initial.schema.json` — generated
  formatVersion-1 baseline snapshot of all 64 roots (319 KB).
- `docs/persistence-changes/2026-09-12-auto-review-error-metadata.schema.json`
  — generated snapshot of the two changed roots (21 KB).
- `docs/persistence-changes/2026-09-13-working-directory.schema.json` — read
  in full: one root, `data.cwd` a required string.
- `docs/persistence-changes/2026-09-14-image-offload.schema.json` — generated
  snapshot of the 13 roots the offload mark touched (200 KB).
- `docs/persistence-changes/2026-09-14-workspace-changes-event.schema.json` —
  read in full: one root, `data.turn` a required number.
- `docs/persistence-changes/2026-09-16-session-format-v4.schema.json` —
  generated formatVersion-2 snapshot of the 14 roots the V4 bump changed
  (382 KB).
- `docs/persistence-changes/2026-09-18-schedule-optional-title.schema.json` —
  read in full: `title` optional on all three schedule create variants.
- `docs/persistence-changes/2026-09-19-external-subagent-catalog.schema.json`
  — read in full: mode union `continuable | one-shot | unknown | external`
  across payload versions 0/1/2.
- `docs/persistence-changes/2026-09-20-unknown-child-catalog.schema.json` —
  read in full: mode union with `unknown` added at payload version 1.
- `docs/persistence-changes/2026-09-21-user-question-reply.schema.json` —
  generated formatVersion-2 snapshot of the four message roots (269 KB).
- `docs/persistence-changes/2026-09-30-job-session-lifecycle.schema.json` —
  read in full: `cause producer|teardown|kill`, `status completed|failed|
  killed`, boolean `producerReported`.
- `docs/persistence-changes/2026-10-05-ptc-operation-metadata.schema.json` —
  read in full: `meta` is an open index signature, `arguments` is opaque.
- `docs/persistence-changes/2026-10-05-working-directory-attribution.schema.json`
  — generated formatVersion-2 snapshot of the four message roots (271 KB).
- `docs/persistence-changes/2026-10-07-title-reasoning-effort.schema.json` —
  generated snapshot of `session/title-llm-request` (71 KB).
- `docs/persistence-changes/2026-10-13-deepseek-search-thinking.schema.json`
  — read in full: `thinking` is an optional object whose only member is the
  literal `disabled`.
- `docs/persistence-changes/2026-10-13-user-rpc-principal.schema.json` —
  generated formatVersion-2 snapshot of the four message roots (273 KB);
  carries the `compatibility` policy block.
- `docs/persistence-changes/historical-formats/README.i18n.yaml` — per-heading
  en/zh hash pairing for the format index.
- `docs/persistence-changes/historical-formats/README.zh.md` — Chinese mirror
  of the format index, identical V0–V4 roots/types table.
- `docs/persistence-changes/historical-formats/v0.i18n.yaml` — 1,285-line
  per-heading en/zh hash pairing, one pair per generated type section.
- `docs/persistence-changes/historical-formats/v0.schema.json` — generated
  formatVersion-1 archive of the V0 inventory (1.15 MB, 54 roots).
- `docs/persistence-changes/historical-formats/v0.zh.md` — Chinese mirror of
  the V0 reference, identical 54-root declaration.
- `docs/persistence-changes/historical-formats/v1.i18n.yaml` — 1,285-line
  per-heading en/zh hash pairing for V1.
- `docs/persistence-changes/historical-formats/v1.schema.json` — generated
  archive of the V1 inventory (1.16 MB, 54 roots).
- `docs/persistence-changes/historical-formats/v1.zh.md` — Chinese mirror of
  the V1 reference.
- `docs/persistence-changes/historical-formats/v2.i18n.yaml` — 1,345-line
  per-heading en/zh hash pairing for V2.
- `docs/persistence-changes/historical-formats/v2.schema.json` — generated
  archive of the V2 inventory (1.32 MB, 56 roots).
- `docs/persistence-changes/historical-formats/v2.zh.md` — Chinese mirror of
  the V2 reference.
- `docs/persistence-changes/historical-formats/v3.i18n.yaml` — 1,441-line
  per-heading en/zh hash pairing for V3.
- `docs/persistence-changes/historical-formats/v3.schema.json` — generated
  archive of the V3 inventory (1.44 MB, 60 roots).
- `docs/persistence-changes/historical-formats/v3.zh.md` — Chinese mirror of
  the V3 reference.
- `docs/persistence-changes/releases/README.i18n.yaml` — per-heading en/zh
  hash pairing for the release archive index.
- `docs/persistence-changes/releases/README.zh.md` — Chinese mirror of the
  release archive index, identical 26-row tag table.
- `docs/persistence-changes/releases/manifest.json` — the 26 captured tags
  with sourceDate, publishedAt and writer version; the completeness boundary.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.1.i18n.yaml` — pairing
  sidecar for the earliest-tag record: 9 hash pairs under
  `/persistence-release-dsh-v0-0-1-rc-1` (root, summary, table-of-contents,
  release-evidence, declaration, structural-changes, verification, dev-note).
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.2.i18n.yaml` — pairing
  sidecar for the rc.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-0-1-rc-2`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.3.i18n.yaml` — pairing
  sidecar for the rc.3 record, 9 hash pairs under
  `/persistence-release-dsh-v0-0-1-rc-3`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.4.i18n.yaml` — pairing
  sidecar for the rc.4 record, 9 hash pairs under
  `/persistence-release-dsh-v0-0-1-rc-4`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.5.i18n.yaml` — pairing
  sidecar for the rc.5 record, 9 hash pairs under
  `/persistence-release-dsh-v0-0-1-rc-5`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.1.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-1`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.2.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-2`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.3.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.3 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-3`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.5.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.5 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-5`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.6.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.6 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-6`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.7.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.7 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-7`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.8.i18n.yaml` — pairing
  sidecar for the v0.1.0-rc.8 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-0-rc-8`.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.1.i18n.yaml` — pairing
  sidecar for the v0.1.1-rc.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-1-rc-1`.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.2.i18n.yaml` — pairing
  sidecar for the v0.1.1-rc.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-1-rc-2`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.i18n.yaml` — pairing
  sidecar for the v0.1.2-alpha.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-alpha-1`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.2.i18n.yaml` — pairing
  sidecar for the v0.1.2-alpha.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-alpha-2`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.3.i18n.yaml` — pairing
  sidecar for the v0.1.2-alpha.3 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-alpha-3`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.4.i18n.yaml` — pairing
  sidecar for the v0.1.2-alpha.4 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-alpha-4`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.5.i18n.yaml` — pairing
  sidecar for the v0.1.2-alpha.5 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-alpha-5`.
- `docs/persistence-changes/releases/dsh-v0.1.2-rc.1.i18n.yaml` — pairing
  sidecar for the v0.1.2-rc.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-2-rc-1`.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.i18n.yaml` — pairing
  sidecar for the v0.1.3-alpha.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-3-alpha-1`.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.2.i18n.yaml` — pairing
  sidecar for the v0.1.3-alpha.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-3-alpha-2`.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.1.i18n.yaml` — pairing
  sidecar for the v0.1.5-alpha.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-5-alpha-1`.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.2.i18n.yaml` — pairing
  sidecar for the v0.1.5-alpha.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-5-alpha-2`.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.1.i18n.yaml` — pairing
  sidecar for the v0.1.5-rc.1 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-5-rc-1`.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.2.i18n.yaml` — pairing
  sidecar for the v0.1.5-rc.2 record, 9 hash pairs under
  `/persistence-release-dsh-v0-1-5-rc-2`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.1.md` — earliest tag:
  42 roots / 341 types, no predecessor, no compatibility judgement.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.1.zh.md` — Chinese mirror
  of the earliest-tag record.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.2.md` — adds envelope
  `ignorable`, `schedule/change` and four tool-workflow roots; 45 changed
  roots, 48 differences.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.2.zh.md` — Chinese mirror
  of the rc.2 record.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.3.md` — renames
  `compact/*` → `compaction/*` and two source-kind literals.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.3.zh.md` — Chinese mirror
  of the rc.3 record.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.4.md` — unchanged-digest
  tag; the template every zero-change record follows.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.4.zh.md` — Chinese mirror
  of the rc.4 record.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.5.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.5.zh.md` — Chinese mirror
  of the rc.5 record.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.1.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.1.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.2.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.2.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.3.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.3.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.5.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.5.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.6.md` — unchanged digests,
  47 roots / 374 types.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.6.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.7.md` — `assistant/chunk`
  `replayState` moves from `unknown` to a typed object; 1 root changed.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.7.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.8.md` — adds the four
  `team/*` roots and optional `interrupted`.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.8.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.1.md` — `permission/preset`
  gains optional `origin` (default / selection / inferred).
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.1.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.2.md` — removes that
  `origin`; adds optional `originalDimensions` to attachment records.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.2.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.md` — removes envelope
  `ignorable`, adds `startsSeries` and three roots, writer version unchanged.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.2.md` — restores the
  optional envelope `ignorable`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.2.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.3.md` — unchanged
  digests, 54 roots / 417 types.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.3.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.4.md` — `seedLength` →
  required `isSeeded`; two source variants renamed to `agent-message`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.4.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.5.md` — unchanged
  digests, 54 roots / 415 types.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.5.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.2-rc.1.md` — unchanged digests,
  54 roots / 415 types.
- `docs/persistence-changes/releases/dsh-v0.1.2-rc.1.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.zh.md` — Chinese
  mirror of the writer 0→2 record.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.2.md` — adds
  `feedback/message-put` and `feedback/message-delete`.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.2.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.1.md` — writer 2→3:
  `system/message` added, `surfaceOp` start/end → startSeq/endSeq, PTC
  dispatch keys.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.1.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.2.md` — adds
  `deliverables/presented` and `subagent/catalog`; feedback `category`.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.2.zh.md` — Chinese
  mirror.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.1.md` — unchanged digests,
  59 roots / 462 types.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.1.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.2.md` — final captured tag:
  unchanged digests, 59 roots / 462 types.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.2.zh.md` — Chinese mirror.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.1.schema.json` — the
  first release snapshot: holds **every** root of the earliest tag (42 roots,
  930 KB), because the first entry establishes the comparison base.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.2.schema.json` — the 45
  roots that changed at rc.2 (1.01 MB), including the four new
  tool-workflow roots and `event:schedule/change`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.3.schema.json` — the 8
  roots changed at rc.3 (458 KB): four `event:compaction/*` additions, three
  `event:compact/*` removals, plus `event:agent/inbox/spliced`,
  `event:hook/invoked`, `event:session/title-llm-request` and
  `event:user/message`.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.4.schema.json` — read in
  full: a 55-byte empty snapshot (`formatVersion: 1`, zero roots, zero types)
  because rc.4 changed no root.
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.5.schema.json` — read in
  full: a 55-byte empty snapshot, rc.5 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.1.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.0-rc.1 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.2.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.0-rc.2 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.3.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.0-rc.3 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.5.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.0-rc.5 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.6.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.0-rc.6 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.7.schema.json` — the one
  changed root `event:assistant/chunk` (124 KB), whose `replayState` moved
  from `unknown` to a typed object.
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.8.schema.json` — the 8
  roots changed at v0.1.0-rc.8 (500 KB): the four new `event:team/*` roots
  plus `event:agent/inbox/spliced`, `event:assistant/message`,
  `event:session/title-llm-request` and `event:user/message`.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.1.schema.json` — the one
  changed root `event:permission/preset` (10 KB), whose `origin` was added.
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.2.schema.json` — the 10
  roots changed at v0.1.1-rc.2 (697 KB), including the six that gained
  `attachment.originalDimensions`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.schema.json` — the
  52 roots changed at v0.1.2-alpha.1 (1.13 MB), including the three added
  roots `event:model/selection`,
  `event:session-log-deepseek/delivery-accepted` and
  `event:subagent/model-selection-policy`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.2.schema.json` — the
  52 roots changed at v0.1.2-alpha.2 (1.16 MB), the mirror of alpha.1 with
  `ignorable` restored on the envelope.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.3.schema.json` — read
  in full: a 55-byte empty snapshot, v0.1.2-alpha.3 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.4.schema.json` — the
  4 roots changed at v0.1.2-alpha.4 (417 KB): `SessionHeader`,
  `event:agent/inbox/spliced`, `event:session/title-llm-request` and
  `event:user/message`.
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.5.schema.json` — read
  in full: a 55-byte empty snapshot, v0.1.2-alpha.5 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.2-rc.1.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.2-rc.1 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.schema.json` — the
  17 roots changed at v0.1.3-alpha.1 (911 KB), including the added
  `event:assistant/attempt` and the removed `event:assistant/chunk`.
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.2.schema.json` — the
  two roots added at v0.1.3-alpha.2 (20 KB):
  `event:feedback/message-delete` and `event:feedback/message-put`.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.1.schema.json` — the
  12 roots changed at v0.1.5-alpha.1 (578 KB), including the added
  `event:system/message` and the added `event:tool/ptc-dispatch` pair beside
  the removed `event:tool/code-dispatch` pair.
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.2.schema.json` — the
  4 roots changed at v0.1.5-alpha.2 (51 KB): the added
  `event:deliverables/presented` and `event:subagent/catalog`, plus
  `event:feedback/message-put` and `event:feedback/record`.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.1.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.5-rc.1 changed no root.
- `docs/persistence-changes/releases/dsh-v0.1.5-rc.2.schema.json` — read in
  full: a 55-byte empty snapshot, v0.1.5-rc.2 changed no root.
- `docs/user/develop/basic/config.i18n.yaml` — per-heading en/zh hash pairing
  for the plugin-configuration tutorial.
- `docs/user/develop/basic/index.i18n.yaml` — per-heading en/zh hash pairing
  for the first-plugin tutorial.
- `docs/user/develop/basic/publish.i18n.yaml` — per-heading en/zh hash pairing
  for the package-and-install tutorial.
- `docs/user/develop/basic/tool.i18n.yaml` — per-heading en/zh hash pairing
  for the tool-authoring tutorial.
- `docs/user/develop/framework/events.i18n.yaml` — per-heading en/zh hash
  pairing for the event-system reference.
- `docs/user/develop/framework/index.i18n.yaml` — per-heading en/zh hash
  pairing for the plugin-lifecycle reference.
- `docs/user/develop/framework/service.i18n.yaml` — per-heading en/zh hash
  pairing for the services reference.
- `docs/user/develop/practice/dynamic-cordis.i18n.yaml` — per-heading en/zh
  hash pairing for the configure-plugins-from-a-prompt note.
- `docs/user/develop/practice/index.i18n.yaml` — per-heading en/zh hash pairing
  for the three-role capability reference.
- `docs/user/develop/practice/llm-adapter.i18n.yaml` — per-heading en/zh hash
  pairing for the LLM-adapter guide.
- `docs/user/guide/github-review.i18n.yaml` — per-heading en/zh hash pairing
  for the GitHub-webhook guide.
- `docs/user/guide/index.i18n.yaml` — per-heading en/zh hash pairing for the
  Web-UI quickstart.
- `docs/user/guide/mcp-memory.i18n.yaml` — per-heading en/zh hash pairing for
  the memory-MCP guide.
- `docs/user/guide/network-proxy.i18n.yaml` — per-heading en/zh hash pairing
  for the network-proxy guide.
- `docs/user/guide/plugin-market.i18n.yaml` — per-heading en/zh hash pairing
  for the plugin-market guide.
- `docs/user/guide/providers.i18n.yaml` — per-heading en/zh hash pairing for
  the model-configuration guide.
- `docs/user/guide/public-deployments.i18n.yaml` — per-heading en/zh hash
  pairing for the reverse-proxy guide.
- `docs/user/guide/python-sdk.i18n.yaml` — per-heading en/zh hash pairing for
  the Python SDK guide.
- `docs/user/guide/schedule.i18n.yaml` — per-heading en/zh hash pairing for
  the schedule guide.
- `docs/user/guide/providers-models-page.png` — 1600×850 screenshot of the
  Settings → Models page: the DeepSeek card with its API-key field, the
  "Customized settings" expander, Cancel/Apply, and the dashed "Add model
  provider" entry.
- `docs/user/guide/providers-models-page.zh.png` — the same page in Chinese
  (设置 / 模型 / 通用设置 / 模型 / 内置插件 / Agent 预设), same layout.
- `docs/user/guide/providers-custom-form.png` — 1128×1426 screenshot of the
  "Custom model API" form: Provider ID, display name, base URL, API protocol
  dropdown, API key, the model catalog area with "Fetch available models", and
  the "Add model" / "Create provider" actions.
- `docs/user/guide/providers-custom-form.zh.png` — the same form in Chinese
  (第三方模型提供商 / 自定义模型 API), with the "模型目录" heading that the
  English form calls "Models".
- `docs/user/index.i18n.yaml` — per-heading en/zh hash pairing for the user
  docs landing page.
- `docs/user/index.zh.md` — the Chinese landing page: the same
  `layout: false` frontmatter and the same `meta http-equiv: refresh` to
  `./guide/quickstart`, differing from the English file only in the
  `[English](index.md) | 中文` switch line.

## Ideas worth stealing

- **A content-addressed compatibility ledger for persisted records** —
  `docs/persistence-changes/README.md:76` — every persisted type root carries
  a SHA-256 over its *normalized* schema, and any structural change must be
  acknowledged by a dated record naming the predecessor and the before/after
  digests; the verifier then "rejects missing predecessors, cycles, duplicate
  successors for one root, digest mismatches, and current roots that disagree
  with their latest records". Why it transfers to August: August persists
  `messages` rows, `turn_outcomes` rows and `transcript_archive` blocks that
  other code reads back; a digest per record type plus a dated acknowledgement
  turns "did we break a reader?" from a review ritual into a mechanical
  question, and it catches the exact class of bug in AGENTS.md where a
  transcript field is pruned before archiving and is then in neither place.
- **A change classifier that finds the shape of a change but refuses to
  decide safety, forcing a human to sign** —
  `docs/persistence-changes/README.md:61` — "The classifier identifies
  established same-version cases and changes requiring compatibility review;
  it cannot decide semantic safety. The latter require an explicit
  `--decision same-version` when recording or updating without a version
  increase." Why it transfers: August's brain-config and tool-surface changes
  have the same two-part shape (detect the delta, then reason about the
  reader) and the same failure mode (a detector that silently blesses a
  change). Making the safety judgement a *file* that CI reads means the
  judgement is reviewable, diffable and attributable.
- **A retrospective structural diff of your own history, graded by the
  current rules** — `docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.md:112`
  (the table) and `:110` (the framing) — every historical change is re-classified
  as `not-required` or `review-required` "using current rules for comparison
  only; it does not assert historical compliance, migration correctness, or
  runtime compatibility", and the release records refuse to authorise anything
  (`releases/README.md:68`: "A backfilled record cannot authorize a current PR
  to omit acknowledgement or a required version increase"). Why it transfers:
  August can run the same grader over its own migration history to find which
  past changes would today require a review — a free audit of the thing AGENTS.md
  worries about most.
- **Qualified attribution: a producer's unknown source kind is preserved and
  never interpreted, and the promise is recorded *in the schema*** —
  `docs/persistence-changes/README.md:67` (the prose) and
  `docs/persistence-changes/2026-10-13-user-rpc-principal.schema.json:101-112`
  (the machine form: `policy: session-source-attribution`, `discriminator:
  kind`, `unknownKinds: "preserve"`, and the qualified `attributionKinds`
  list). Why it transfers: August's `messages.source` and its Bot/remote
  principals need a way for a new producer to add a kind without every reader
  learning it. Making the *policy* a schema property means it is diffed and
  digested, so "readers must preserve and derive the recorded messages without
  that projection" is enforceable rather than aspirational.
- **Declare a deliberately forbidden field as optional `never` so that
  re-permitting it is a visible type change** —
  `docs/persistence-changes/README.md:71` — "When a reader rejects a JSON
  property by name, declare the property as optional `never` and mark it with
  argument-free `@persistenceReserved`. The extractor retains the forbidden
  field, so allowing a JSON value later requires an existing-field type
  change." Why it transfers: the V4 record uses this on the retired `system`
  key in `request/header` (`2026-09-16-session-format-v4.md:96`). August has
  the same need — a key the backend refuses today (a retired brain-config
  key, a blocked tool name) should be *typed* as forbidden so that relaxing
  it later shows up in a diff instead of appearing as a silent behaviour
  change.
- **An empty value for a named config switch is REFUSED, not ignored** —
  `docs/user/guide/providers.md:209` — "a key left empty
  (`supportsDeveloperRole:`) is refused rather than ignored, because an empty
  value would erase what the catalog knows while saying nothing in its
  place." Why it transfers: this is exactly the `0`-vs-absent trap in
  August's brain-config (`0 = off` vs `absent = armed at the shipped
  constant`). DSH's rule generalises it: if you name a key you must give it a
  value, and the *absence* of the key is the only way to say "use the
  inherited default".
- **Separate the advertised endpoint from the admitted one** —
  `docs/user/guide/public-deployments.md:25` — "advertising it with
  `--public-url` is display only and does not admit it"; the admission fence
  is `--trusted-host`, and "the fence only admits the request; the launch
  token in the printed URL and the signed session cookie authenticate it."
  Why it transfers: August's remote-access door has the same three layers
  (advertised URL, authority fence, credential), and conflating the first two
  is how a deployment ends up believing a printed URL is a security control.
- **A rejected config value fails per-scheme, never by substitution** —
  `docs/user/guide/network-proxy.md:48` — "A `socks5://` value is reported at
  startup and skipped, and DSH connects directly for the scheme that named
  it — setting `HTTPS_PROXY=socks5://…` alongside a usable `HTTP_PROXY` leaves
  `https:` direct rather than borrowing the HTTP proxy." Why it transfers:
  the general rule is "a value you refused for one target must not be
  silently replaced by a different target's value", and the failure is
  reported at startup, not at request time. August's provider routing has the
  same shape (a refused `apiFormat` must not fall back to another format's
  request body).
- **Adapter-owned reasoning vocabulary, not a core enum** —
  `docs/user/develop/practice/llm-adapter.md:116` — "preserve the adapter's
  authoritative selectable list, including `off` when its upstream capability
  API returns it, instead of promoting those values into a core enum"; and
  the wire side at `docs/user/guide/providers.md:155` — "Each key is a level
  the menu offers, and its value is the spelling sent on the wire as
  `reasoning_effort` … Only `off` may stay empty." Why it transfers: this is
  the exact shape of August's per-model `reasoning_effort` and its
  `thinkingFormat: deepseek` compat switch
  (`docs/user/guide/providers.md:157`) — the *menu* vocabulary and the *wire*
  vocabulary are different sets, `off` is the only universal member, and a
  model that thinks by default needs `off` to send an explicit disable.
- **Fail loudly rather than silently dropping an unhonourable provider
  field** — `docs/user/develop/practice/llm-adapter.md:114` — "If the
  provider cannot honor a field, throw `LlmError` with a stable code instead
  of silently dropping it." Why it transfers: August's tool loop has the same
  failure mode — a capability the model expects but the adapter cannot honour
  is dropped, and the model then loops on a field that will never arrive.
  A stable error code is also what makes the refusal countable.
- **Retain what you can no longer read, under a first-class "unknown" state** —
  `docs/persistence-changes/2026-09-20-unknown-child-catalog.md:38` (and the
  `mode: 'unknown'` literal in the sibling schema) — unreadable historical
  children stay in the catalog as `unknown`; complete facts keep payload
  version 0 while the migration emits version 1. Why it transfers: August's
  brain has a retired/consolidation-parked concept and its sessions have
  orphan records; a persisted record that is no longer readable should have a
  "we kept it and cannot interpret it" state rather than be deleted or
  silently downgraded into a valid-looking row.
- **Name a boolean for the claim, not for the fact** —
  `docs/persistence-changes/2026-09-30-job-session-lifecycle.md:42` —
  "producerReported describes completion-promise fulfillment, not verified
  resource release"; and in the same sentence, "historical sessions receive no
  fabricated job history". Why it transfers: August's job/process records
  need the same two properties — a field that says *who said it finished*
  rather than *it finished*, and a rule that a new record type applied to old
  rows must not invent a past.
- **A `surface` boolean per event root — a machine-checkable answer to "what
  does the model actually see"** —
  `docs/persistence-changes/finalized/v4.json:17` (an event with
  `surface: false`) versus `:53-58` (an event with `surface: true`) — exactly
  five of the 65 roots are model-visible: `assistant/message`,
  `developer/message`, `system/message`, `tool/result`, `user/message`.
  Why it transfers: August decides every turn what enters the model's history
  and what is log-only (PTC dispatch, workspace changes, retries, title
  requests). A declared per-event boolean makes that set checkable, and
  makes "this log-only event accidentally reached the model" a diff rather
  than a reading.
- **An archive must be a snapshot, not a re-derivation** —
  `docs/persistence-changes/historical-formats/README.md:60` — "The successor
  uses the current catalog; copying a new current catalog cannot satisfy the
  archived predecessor requirement." Why it transfers: August's DB migrations
  are the same shape; the pre-migration schema capture must be a frozen
  snapshot of the old state, and a rule that re-derives it from today's code
  cannot prove the old reader still works.
- **Say the disposal hazard instead of hiding it** —
  `docs/user/develop/framework/index.md:63` — "During unload, disposer
  invocation starts in reverse registration order, but multiple async disposers
  run concurrently and have no serial completion guarantee. Put order-dependent
  cleanup in one disposer returned from a single `ctx.effect()` and await its
  steps serially there." Why it transfers: any August shutdown path with more
  than one async cleanup has the same hazard, and the doc's remedy (collapse
  order-dependent work into one disposer) is the transferable part.
- **The capability is the seam, not its parts** —
  `docs/user/develop/practice/index.md:9` — "When a capability is general
  enough to need replaceable providers … Harness separates three roles … The
  complete capability is its seam. No individual role is a seam."; and
  `:151` — "Explicit > implicit — resolve defaults in an explicit
  `resolve(request): Spec` step rather than hiding `?? default` expressions
  inside `run()`." Why it transfers: this is the cleanest statement I found
  of how to make a tool surface swappable — and the explicit `resolve` step
  is the same shape August's "resolve, then run" gates would take.
- **A waterfall listener's `next()` is mandatory, and the doc says omitting it
  is a feature** —
  `docs/user/develop/framework/events.md:66` and the warning at `:80` — "A
  waterfall listener **must call `next()`** … omitting the call short-circuits
  the pipeline by design, enabling interception and gateway behavior." Why it
  transfers: August's request path has interception points (scrubbing, retry
  classification, budget pricing). Declaring the short-circuit as intended
  behaviour — rather than a bug — is what lets a future maintainer change the
  interception chain without fear.
- **A webhook's HTTP response is deliberately weaker than its outcome** —
  `docs/user/guide/github-review.md:69` — "`202` means the signature and JSON
  were accepted and rule calls were scheduled in memory. It does not mean this
  rule matched or that a Session was created." Why it transfers: any
  inbound-webhook door in August (a bot DM, a schedule trigger) should
  distinguish "accepted" from "done", because conflating them produces a
  retry storm.
- **Per-heading bilingual hash pairs as a translation-drift gate** —
  `docs/persistence-changes/2026-09-13-working-directory.i18n.yaml:1-4` (the
  header comment names the regeneration command and the hashing rule) — every
  section of every doc carries an en hash and a zh hash, so a translation
  that lags is detected *per section*, and the machine declaration inside the
  code block is compared for equality rather than translated. Why it
  transfers: August's docs are bilingual too, and the failure this catches —
  a machine-readable block that has silently diverged between languages — is
  exactly the failure a file-level "both files exist" check misses.

## Files skipped (with reasons)

Twenty-six files were marked `skipped` in the ledger. Every one of them is a
**generated** artifact (`docs/persistence-changes/**.schema.json`), and every
one was opened far enough to state exactly what it is. In each case I read the
file's head, its `formatVersion`, and the complete list of root keys (and, for
the larger formatVersion-2 ones, the per-property `compatibility` policy
block); what I did not do is read the full normalized node graph line by line,
because that graph is machine output whose meaning is already stated by the
digest list in the sibling `.md` record, and the two are generated from the
same source by the same extractor.

- `docs/persistence-changes/2026-09-11-initial.schema.json` — generated
  formatVersion-1 baseline snapshot of all 64 roots (319 KB). I read the head
  and enumerated all 64 root keys; not read line by line because it is the
  machine twin of the digest table already published in the sibling `.md`.
- `docs/persistence-changes/2026-09-12-auto-review-error-metadata.schema.json`
  — generated snapshot of the two changed roots (21 KB). Head, formatVersion
  and root keys read; the 21 KB of node graph is machine output duplicating
  the sibling `.md`'s declaration.
- `docs/persistence-changes/2026-09-14-image-offload.schema.json` — generated
  snapshot of the 13 roots the offload mark touched (200 KB). Head and root
  keys enumerated; the node graph is 200 KB of generated output.
- `docs/persistence-changes/2026-09-16-session-format-v4.schema.json` —
  generated formatVersion-2 snapshot of the 14 roots the V4 bump changed
  (382 KB). Head, formatVersion and root keys read; the node graph is
  generated output duplicating the record's digest list.
- `docs/persistence-changes/2026-09-21-user-question-reply.schema.json` —
  generated formatVersion-2 snapshot of the four message roots (269 KB). Head
  and root keys read; the node graph is generated output.
- `docs/persistence-changes/2026-10-05-working-directory-attribution.schema.json`
  — generated formatVersion-2 snapshot of the four message roots (271 KB).
  Head and root keys read; the node graph is generated output.
- `docs/persistence-changes/2026-10-07-title-reasoning-effort.schema.json` —
  generated formatVersion-2 snapshot of `session/title-llm-request` (71 KB).
  Head and root keys read; the node graph is generated output.
- `docs/persistence-changes/2026-10-13-user-rpc-principal.schema.json` —
  generated formatVersion-2 snapshot of the four message roots (273 KB). Head,
  root keys and the per-property `compatibility` block (the
  `session-source-attribution` policy, `unknownKinds: preserve` and the
  qualified `attributionKinds` list) read; the remaining node graph is
  generated output.
- `docs/persistence-changes/historical-formats/v0.schema.json` — generated
  formatVersion-1 archive of the complete V0 inventory (1.15 MB, 49,308
  lines, 54 roots). Head and every root key read; the node graph is generated
  output duplicating the digest table in `v0.md`.
- `docs/persistence-changes/historical-formats/v1.schema.json` — generated
  archive of the V1 inventory (1.16 MB, 49,411 lines, 54 roots). Head and
  root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/historical-formats/v2.schema.json` — generated
  archive of the V2 inventory (1.32 MB, 56,466 lines, 56 roots). Head and
  root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/historical-formats/v3.schema.json` — generated
  archive of the V3 inventory (1.44 MB, 61,307 lines, 60 roots). Head and
  root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.1.schema.json` — generated
  snapshot holding every root of the earliest tag (930 KB). Head and root keys
  read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.2.schema.json` — generated
  snapshot of the 45 roots changed at rc.2 (1.01 MB). Head and root keys read;
  node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.0.1-rc.3.schema.json` — generated
  snapshot of the 8 roots changed at rc.3 (458 KB). Head and root keys read;
  node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.7.schema.json` — generated
  snapshot of the single changed root `assistant/chunk` (124 KB). Head and
  root key read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.0-rc.8.schema.json` — generated
  snapshot of the 8 roots changed at v0.1.0-rc.8 (500 KB). Head and root keys
  read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.1.schema.json` — generated
  snapshot of the single changed root `permission/preset` (10 KB). Head and
  root key read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.1-rc.2.schema.json` — generated
  snapshot of the 10 roots changed at v0.1.1-rc.2 (697 KB). Head and root
  keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.schema.json` —
  generated snapshot of the 52 roots changed at v0.1.2-alpha.1 (1.13 MB). Head
  and root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.2.schema.json` —
  generated snapshot of the 52 roots changed at v0.1.2-alpha.2 (1.16 MB).
  Head and root keys read; node graph not read line by line (generated
  output).
- `docs/persistence-changes/releases/dsh-v0.1.2-alpha.4.schema.json` —
  generated snapshot of the 4 roots changed at v0.1.2-alpha.4 (417 KB). Head
  and root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.schema.json` —
  generated snapshot of the 17 roots changed at v0.1.3-alpha.1 (911 KB). Head
  and root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.3-alpha.2.schema.json` —
  generated snapshot of the 2 roots added at v0.1.3-alpha.2 (20 KB). Head and
  root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.1.schema.json` —
  generated snapshot of the 12 roots changed at v0.1.5-alpha.1 (578 KB). Head
  and root keys read; node graph not read line by line (generated output).
- `docs/persistence-changes/releases/dsh-v0.1.5-alpha.2.schema.json` —
  generated snapshot of the 4 roots changed at v0.1.5-alpha.2 (51 KB). Head
  and root keys read; node graph not read line by line (generated output).

No file in this shard is binary, and none is vendored third-party code.

## Uncertainties

- **I did not read the code these documents describe.** The extractor
  (`scripts/persistence-schema.ts`), the finalizer
  (`scripts/persistence-finalization.ts`), the V3-to-V4 migration package
  (`packages/session/session-format-v3-to-v4/`) and the V0/V1/V2/V3 codecs are
  all outside this shard. Every claim I make about them is a restatement of
  what the documents say, and I checked that the documents at least say it
  consistently — I did not verify the implementation.
- **I could not verify the digests.** The `.schema.json` digests and the
  digests declared in the sibling `.md` files should match; I confirmed the
  format, the root sets and, for the files I read in full, the specific
  digests, but I did not re-hash or cross-check every digest pair across the
  26 skipped snapshots. I deliberately avoided parsing the JSON with a
  script, since the shard's rules forbid piping a file into an interpreter.
- **The "types" counts in the prose do not obviously come from the
  `types` array in these files.** Every change-record and release
  `.schema.json` I inspected ends with `"types": []`, while the prose counts
  415 / 435 / 467 / 614 types per format. The counts therefore come from a
  different artifact — the current `docs/persistence-schema.json`, which is
  **not in this shard** — and I could not confirm that. I checked the current
  catalog's absence from my shard and the `finalized/v4.json` root list
  (65 roots, matching the index table's "65 / 614" row).
- **The `compatibility` policy block may appear on properties I did not
  survey.** I saw it on the `source` property of the formatVersion-2 message
  roots. I did not grep every one of the four large formatVersion-2 files for
  other occurrences, so I cannot say whether the policy vocabulary is
  used only for message sources.
- **The V1 format has no release tag.** Its record identifies an intermediate
  worktree by branch name, PR number and commit *title*. I took the document's
  word for it; I did not inspect Git history, and the shard rules forbid
  running anything against the clone.
- **The Chinese mirrors were not all read to the last line.** I read all 16
  change-record `.zh.md` files and all 10 `docs/user/**` `.zh.md` files in
  full, and the `docs/persistence-changes/README.zh.md`,
  `historical-formats/README.zh.md` and `releases/README.zh.md` in full. For
  the 26 release `.zh.md` files and the four `historical-formats/vN.zh.md`
  files (5,105–5,634 lines each) I read the frontmatter, title and Summary
  and confirmed the structure, but did not read every line of the generated
  type catalogue. Those catalogues are translations of the English files I
  did read in full, and the machine declarations are compared for equality by
  the verifier rather than translated.
- **The `.i18n.yaml` sidecars were read structurally, not exhaustively.** For
  the 26 release and the 10 guide sidecars (10–46 lines each) I read the
  header comment and the first hash pairs; for the four large
  `historical-formats/vN.i18n.yaml` files (64–73 KB, 1,285–1,441 lines) I
  read the head and the tail. I did not verify all ~1,400 hash pairs in each.
- **The four PNG screenshots were read visually, not as pixel data.** I
  confirmed the content of each (the two Models-page variants and the two
  Custom-model-API-form variants) and noted the Chinese labels, but I did not
  compare the English and Chinese images pixel-by-pixel to confirm they show
  the same fields in the same positions.
- **Nothing here was executed.** No script, build, test, CLI or import from
  the clone was run. The commands quoted in the documents
  (`pnpm run verify-persistence-catalog`, `verify-persistence-formats`,
  `verify-persistence-releases`, `doc-sync`,
  `verify-translation-pairing --write`) are reported as the documents state
  them; I did not run them and cannot confirm their current behaviour.
