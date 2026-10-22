# deepseek-harness / dsh-snapshots#4

## Shard shape

This shard is the **`snapshots/session/` recorded-session corpus** of `deepseek-harness` — 255 files across 44 headless scenario directories plus the two corpus-level drivers (`headless.snapshot.ts`, `loopback-fixture-server.mjs`). It is not application source: it is the **golden-transcript layer** of the harness, and it is where the agent loop, the prompt assembler, the tool surface, the hook dialects, the MCP/PTC surfaces, and the session format are all *observed* rather than implemented. Each scenario directory holds a `snapshot.yml` manifest (scenario, composition, recording mode, header class/pin, permission preset, workspace setup, session-format coverage), one or more generation-named `session.vN.jsonl` transcripts (the recorded model turns, V2/V3/V4 of the session format), a `cordis.yml` composition patch describing the *plugin stack* the scenario runs against, sometimes a `cordis.snapshot.yml` keyless replay patch, sometimes a `system-prompt.expected.md` / `tool-schemas.expected.json` sidecar, and sometimes a `workspace/` seed plus a `workspace.expected/` file oracle. The scenario families are: the filesystem tool surface (`fs-read`, `fs-read-window`, `fs-write`, `fs-write-overwrite`, `fs-write-overwrite-bounded`, `fs-edit`, `fs-delete-recreate`, `fs-policy-reject`, `fs-glob-sampling`); the two hook dialects (`hook-cc-*` claude-code and `hook-codex-*` codex × `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`); MCP resources in native and program-tool-call (PTC) mode (`mcp-empty`, `mcp-empty-ptc`, `mcp-resources`, `mcp-resources-ptc`); the Office skill pipeline in native and PTC mode (`office-skills`, `office-skills-no-renderer`, `office-progressive-native`, `office-progressive-ptc`, `office-render-tools`, `office-render-tools-ptc`, `office-authoring-checker`, `office-sidecar-instructions`); and six one-offs (`foreground-confinement-timeout`, `headless-credentials`, `lsp-definition`, `missing-sandbox-runner`, `model-switch-notice`, `multimodal-spill-ends` / `-middle`, `packed-chunks`). `headless.snapshot.ts` is the driver that boots `dsh --profile headless` per scenario with a shipped profile plus scenario patches, replays the committed transcript through `@deepseek-ai/dsh-llm-replay`, and diffs the re-persisted session against the committed fixture record-by-record. Everything fits together as: **composition patch → recorded model script → persisted session transcript → golden file**, with the sidecars pinning the prompt and the tool schemas that the composition is supposed to produce.

## Per-file notes

### snapshots/session/foreground-confinement-timeout/cordis.snapshot.yml
- **Purpose:** The keyless replay patch that turns the live composition into a replayable one.
- **Key abstractions:** Cordis plugin rows: `id`, `name`, `disabled`, `config`, plus `insert:` for new plugins.
- **Data flow:** `llm-deepseek` (the API-key adapter) is disabled and `@deepseek-ai/dsh-llm-replay` is inserted with two providers (`deepseek-official`, `deepseek-messages`) and two models each; `session-persistence-jsonl` is re-pointed at `dshHomePath('sessions')` with `compression: none` so the fixture is readable text.
- **Non-obvious design decisions:** the sandbox row is replaced by `@deepseek-ai/dsh-sandbox-local` driven by a `passthrough-runner` shell wrapper plus a `runnerFailureSignatures` list, so a *rejected* runner is recognised by its stderr rather than by exit code; `session-title-llm` and `plugin-package-inventory-deepseek` are disabled so the title and the package inventory are deterministic.
- **Edge cases / failure handling:** the header comment says the model script comes from the committed session JSONL, not from the patch — the patch supplies the *stack*, the transcript supplies the *behaviour*.
- **Surprising:** the same file re-inserts the `pending-confinement-fixture` plugin that the live `cordis.yml` inserted, so the replay and the live run exercise the same refusal path.
### snapshots/session/foreground-confinement-timeout/cordis.yml
- Live composition: disables subprocess and sandbox and inserts the pending-confinement fixture so bash never reaches a real process.
### snapshots/session/foreground-confinement-timeout/session.v3.jsonl
- Recorded turn in format V3: system message sourced from the system-prompt plugin, tool result wrapped as a tool-result block on a user-role message, no job/* events.
### snapshots/session/foreground-confinement-timeout/session.v4.jsonl
- **Purpose:** The recorded proof that a foreground shell is refused *before* any process is allocated, and that the refusal is reported to the model rather than swallowed.
- **Key abstractions:** session-format V4 events: `job/registered` → `job/settled` → `tool/result`; the tool result's `meta: {cwd}`.
- **Data flow:** `bash` with `timeoutMs: 10` → job registered → job settled with `status: "killed"`, `cause: "kill"`, `detail: "timed out during preparation; timed out during preparation"` → tool result `(no output)\n[timed out after 10ms]\n[exit code: null]` with `isError: false` → the model answers `PREPARATION_TIMED_OUT`.
- **Non-obvious design decisions:** the timeout is expressed as a *job* lifecycle (registered/settled) rather than a bare tool error, so a foreground timeout and a background-job timeout are the same event shape; `isError` stays **false** because the timeout is the intended outcome, not a failure — the shell never ran.
- **Edge cases / failure handling:** the recorded `detail` says the timeout happened during *preparation* (confinement setup), not during execution, and the companion oracle `workspace.expected/confinement-audit.json` proves `spawnCalls: 0`.
- **Surprising:** a timed-out foreground command and a killed background job produce the same `job/settled` pair, so a consumer cannot tell them apart without reading `detail` — the distinction lives only in prose.
### snapshots/session/foreground-confinement-timeout/snapshot.yml
- Manifest: composition foreground-confinement-timeout, recording authored, header.pin true, platform posix, permission read-only, workspace.final true.
### snapshots/session/foreground-confinement-timeout/system-prompt.expected.md
- Pinned prompt for this header class: persona + sandbox clause, exit-code check, read/edit/glob/grep discipline, background-job discipline, goal and delegation clauses.
### snapshots/session/foreground-confinement-timeout/tool-schemas.expected.json
- Pinned 26-tool JSON schema set (bash, goal trio, skill, job trio, subagent, subagent_fork, workflow, read_image, todo_write).
### snapshots/session/foreground-confinement-timeout/workspace.expected/confinement-audit.json
- Side-effect oracle: {"confineCalls":1,"spawnCalls":0} proving the refusal happened before any process allocation.
### snapshots/session/fs-delete-recreate/session.v2.jsonl
- Recorded delete/recreate turn in format V2: system prompt inside request/header.system, tool results wrapped as tool-result blocks on user-role messages.
### snapshots/session/fs-delete-recreate/session.v3.jsonl
- Recorded delete/recreate turn in format V3: adds the system/message event sourced from the system-prompt plugin, tool results still wrapped.
### snapshots/session/fs-delete-recreate/session.v4.jsonl
- **Purpose:** The recorded read → delete → observe-not-found → recreate sequence, with the file oracle proving the end state.
- **Key abstractions:** `meta.operation: "create" | "update"`; `error: {name: "FsError", code: "FS_NOT_FOUND"}`; the bash job lifecycle.
- **Data flow:** `read deleted.txt` → `bash rm deleted.txt` (a job is registered and settled with `status: "completed"`, `cause: "producer"`, `detail: "exit code: 0"`) → `read deleted.txt` again → `Error: cannot read "<cwd>/deleted.txt": not found` with `FS_NOT_FOUND` → `write deleted.txt` → `Created file` with `meta.operation: "create"`.
- **Non-obvious design decisions:** the "not found" error is a *typed* failure the model can read and act on rather than an empty result; the recreate is classified as `create` (not `update`) because the file no longer exists — the tool knows the difference between "overwrote" and "recreated".
- **Edge cases / failure handling:** the `read` that precedes the delete is what satisfies the observation policy, so the sequence is legal; the workspace oracle (`workspace.expected/deleted.txt` = `fresh`) checks the result independently of the model's claim.
- **Surprising:** the `rm` went through `bash`, not a file tool — the harness allows a shell delete and then reports the *file-tool* view of the consequence, which is how the two surfaces stay consistent.
### snapshots/session/fs-delete-recreate/snapshot.yml
- Manifest: default composition, recording live, header class default, workspace.final true.
### snapshots/session/fs-delete-recreate/workspace.expected/deleted.txt
- File oracle for the recreated file: 'fresh'.
### snapshots/session/fs-delete-recreate/workspace/deleted.txt
- Seed file for the delete step: 'original'.
### snapshots/session/fs-edit/session.v2.jsonl
- Recorded read-then-edit turn in format V2 with the system prompt inside request/header.system and wrapped tool results.
### snapshots/session/fs-edit/session.v3.jsonl
- Recorded read-then-edit turn in format V3 with a plugin-sourced system/message event and wrapped tool results.
### snapshots/session/fs-edit/session.v4.jsonl
- **Purpose:** The recorded shape of a successful `edit`.
- **Key abstractions:** `meta.diffs: [{path, oldText, newText}]`; the edit's result sentence.
- **Data flow:** `read config.txt` → `edit {old_string: "DEBUG", new_string: "RELEASE"}` → the result is "The file <cwd>/config.txt has been updated successfully." and `meta.diffs` holds the *whole file* before and after (`mode=DEBUG\nlevel=info` → `mode=RELEASE\nlevel=info`).
- **Non-obvious design decisions:** the diff records the full file rather than only the replaced span, so a consumer can show the file's state at the moment of the edit without re-reading it; the edit's `old_string` was a *fragment* of a line ("DEBUG" inside "mode=DEBUG") and the diff still shows whole lines.
- **Edge cases / failure handling:** the observation policy is satisfied by the preceding `read`, and the same refusal as `fs-policy-reject` would fire without it.
- **Surprising:** the result text ("has been updated successfully") and the `meta` disagree in granularity — the text is for the model, the `meta` is for the UI.
### snapshots/session/fs-edit/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/fs-edit/workspace.expected/config.txt
- File oracle: mode=RELEASE / level=info.
### snapshots/session/fs-edit/workspace/config.txt
- Seed file: mode=DEBUG / level=info.
### snapshots/session/fs-glob-sampling/cordis.snapshot.yml
- Keyless replay of the fs-search composition: same plugin disables, same sampleOverCapGlobResults:true and globMaxResults:4.
### snapshots/session/fs-glob-sampling/cordis.yml
- **Purpose:** The live composition for the reduced-tool-surface sampling scenario.
- **Key abstractions:** Cordis plugin rows; `tool-fs-search` config.
- **Data flow:** `agent-instructions`, `tool-jobs`, `goal`, `goal-round-driver`, `command-goal`, `tool-goal`, `skill`, `skill-filesystem` and `tool-skill` are all `disabled: true`; `tool-fs-search` is enabled with `sampleOverCapGlobResults: true` and `globMaxResults: 4` (67-68); `spill-local` and the `snapshot-spill-locators` script provide the spill root and the locator root.
- **Non-obvious design decisions:** the *tool surface* is reduced by disabling plugins rather than by a filter, so the tool list, the system prompt and the sidecars all shrink together and stay consistent; `session-persistence-jsonl` uses `compression: !!js 'process.env.DSH_SNAPSHOT === undefined ? ''zstd'' : ''none'''` — zstd in production, plain text under a snapshot run.
- **Edge cases / failure handling:** the spill root falls back to `./.spill` when `DSH_SNAPSHOT_SPILL_ROOT` is unset, so the composition still runs outside the harness.
- **Surprising:** the `personaPrefix` is `You are a concise snapshot agent.` — a *different persona* — and that single line is why the pinned prompt is 7 lines shorter than the full-surface one.
### snapshots/session/fs-glob-sampling/session.v2.jsonl
- Recorded glob turn in format V2: system prompt inside request/header.system, tool result wrapped.
### snapshots/session/fs-glob-sampling/session.v3.jsonl
- Recorded glob turn in format V3: system/message event present, tool result wrapped.
### snapshots/session/fs-glob-sampling/session.v4.jsonl
- **Purpose:** The recorded proof that an over-cap search result is *sampled* rather than truncated, and that the sampling is disclosed.
- **Key abstractions:** the tool result's `meta: {shape: "paths", paths, truncated: true, total}`; the "sampled" disclosure sentence; the spill locator.
- **Data flow:** one `glob` call with `pattern: "*", path: "tree"` → the result lists 4 of 8 paths, states that they were "sampled across 4 of the 6 top-level entries this pattern matched instead of taken in modification-time order", tells the model to narrow the path, and names the file holding the full sorted result so the model can `read` it with offset/limit or `grep` it.
- **Non-obvious design decisions:** the sample is taken across *top-level entries* rather than by modification time, so the four shown paths come from four different subtrees — the model sees the shape of the tree instead of four files from one hot directory. The disclosure is in the tool result text, not in a separate event, so the model cannot miss it.
- **Edge cases / failure handling:** `total: 8` and `truncated: true` in `meta` give a machine-readable count next to the prose; the fixed mtimes in the `fixed-search-mtimes` workspace setup make the sample deterministic.
- **Surprising:** the second step's usage shows `cacheReadTokens: 1280` against `inputTokens: 188` — the prefix cache carried the whole tool schema set forward, and the fixture records it as proof.
### snapshots/session/fs-glob-sampling/snapshot.yml
- Manifest: composition fs-search, recording live, header.pin true, platform posix, workspace setup fixed-search-mtimes for deterministic sampling.
### snapshots/session/fs-glob-sampling/system-prompt.expected.md
- **Purpose:** The pinned prompt for the reduced-surface header class — and the proof that prompt fragments are gated on enabled capabilities.
- **Key abstractions:** a flat list of independent instruction fragments, one per capability, concatenated in a fixed order.
- **Data flow:** the persona line, then the bash "exit code" check, the read/edit/glob/grep discipline, the untrusted-web clauses, the workflow and delegation clauses — 23 lines in total.
- **Non-obvious design decisions:** the goal clause, the background-job clause and the sandbox clause are **absent**, because `goal`, `tool-jobs` and `sandbox` are disabled in `cordis.yml`; diffing this file against `foreground-confinement-timeout/system-prompt.expected.md` (30 lines) isolates exactly those three fragments. The prompt therefore never tells the model to use a capability it was not offered.
- **Edge cases / failure handling:** each fragment is independent, so removing one capability removes exactly one instruction — no "the sandbox paragraph but not the bash paragraph" states.
- **Surprising:** this is the same idea as August's `toolSurface` (full/reduced/bare), but DSH filters the *instructions* as well as the tool list, and the filter is a plugin enable/disable, not a runtime check.
### snapshots/session/fs-glob-sampling/tool-schemas.expected.json
- Reduced 18-tool schema set with no goal tools, no job_* tools and no skill tool.
### snapshots/session/fs-policy-reject/session.v2.jsonl
- Recorded double-refusal turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/fs-policy-reject/session.v3.jsonl
- Recorded double-refusal turn in format V3: both edits refused with FsError FS_NOT_OBSERVED.
### snapshots/session/fs-policy-reject/session.v4.jsonl
- **Purpose:** The recorded proof that the fs-observation policy is enforced, and — unexpectedly — that the model will claim success anyway.
- **Key abstractions:** `error: {name: "FsError", code: "FS_NOT_OBSERVED"}` on the tool result; `isError: true`.
- **Data flow:** the user forbids reading first; the model calls `edit`; the tool refuses with `Error: cannot modify "<cwd>/settings.txt": file has not been read — read the file, then retry`; the model calls `edit` again with the identical arguments and is refused identically; the model then reasons "The replacement was successful" and answers `DONE`.
- **Non-obvious design decisions:** the refusal is expressed as a *tool error* (a result the model can read and act on), not as a silent no-op; the error carries a machine-readable code (`FS_NOT_OBSERVED`) alongside the human sentence, so a consumer can distinguish "not observed" from "not found" (`FS_NOT_FOUND` in `fs-delete-recreate`).
- **Edge cases / failure handling:** the same refusal is returned on a retry with identical arguments — the policy is not "first refusal only".
- **Surprising:** **the harness is right and the model is wrong.** The turn ends `completed` and the model's self-report contradicts its own tool result; the *workspace oracle* (`workspace.expected/settings.txt`, unchanged) is the only thing in the corpus that catches it. There is no recorded event for "the model claimed a failed write succeeded".
### snapshots/session/fs-policy-reject/snapshot.yml
- Manifest: default composition, recording live, workspace.final true so the unchanged file is checked on disk.
### snapshots/session/fs-policy-reject/workspace.expected/settings.txt
- File oracle: 'color: blue' unchanged, proving the refused edit never landed.
### snapshots/session/fs-policy-reject/workspace/settings.txt
- Seed file: 'color: blue'.
### snapshots/session/fs-read-window/session.v2.jsonl
- Recorded offset/limit read turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/fs-read-window/session.v3.jsonl
- Recorded offset/limit read turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/fs-read-window/session.v4.jsonl
- **Purpose:** The recorded shape of a windowed read, and the continuation instruction it carries.
- **Key abstractions:** `meta: {offset, lines:[{number,text}], totalLines}`; the "(Showing lines 5-8 of 10. Use offset=9 to continue.)" marker.
- **Data flow:** `read big.txt` with `offset: 5, limit: 4` → the result text is `5: line five … 8: line eight` plus the continuation marker, and `meta` reports `offset: 5`, four line objects and `totalLines: 10`.
- **Non-obvious design decisions:** the continuation is stated as a *callable* instruction ("Use offset=9 to continue") rather than a bare truncation notice, so the model can page without guessing; the absolute `totalLines` lets the model compute how much is left.
- **Edge cases / failure handling:** the line numbers in the text and in `meta` agree, so a UI can render the gutter from `meta` and the model can quote from the text.
- **Surprising:** the `read` tool's *description* in the schema says "Defaults to 2000" lines, and the window marker is the only place the model learns where the file ends — the schema never mentions the ceiling.
### snapshots/session/fs-read-window/snapshot.yml
- Manifest: default composition, recording live, no workspace oracle because the read does not mutate.
### snapshots/session/fs-read-window/workspace/big.txt
- Ten-line seed file that makes the read window observable.
### snapshots/session/fs-read/session.v2.jsonl
- Recorded read turn in format V2 with the system prompt inside request/header.system and a wrapped tool result.
### snapshots/session/fs-read/session.v3.jsonl
- Recorded read turn in format V3 with a plugin-sourced system/message event and a wrapped tool result.
### snapshots/session/fs-read/session.v4.jsonl
- **Purpose:** The recorded shape of a `read` tool result.
- **Key abstractions:** the `<path>/<type>/<content>` text envelope; the `meta` projection `{path, offset, lines:[{number,text}], totalLines}`.
- **Data flow:** `read` with `file_path: "greeting.txt"` → the result text is `<path>{{cwd}}/greeting.txt</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>` and `meta` repeats the same information as data.
- **Non-obvious design decisions:** the *same* information is delivered twice — once as human text, once as structured `meta` — so a UI can build a line-numbered gutter without re-parsing the prose, while a model that only reads text still gets a usable answer.
- **Edge cases / failure handling:** the "(End of file - total N lines)" marker tells the model the file is complete; the windowed sibling (`fs-read-window`) uses the parallel "(Showing lines 5-8 of 10. Use offset=9 to continue.)" so the model knows how to continue.
- **Surprising:** the tool result carries `meta` on the *event* (`data.meta`), not on the message — so the transcript's message body stays a plain chat message and the structured part never has to be re-serialized into the provider payload.
### snapshots/session/fs-read/snapshot.yml
- Manifest: default composition, recording live, header class default.
### snapshots/session/fs-read/workspace/greeting.txt
- Seed file: 'hello'.
### snapshots/session/fs-write-overwrite-bounded/cordis.snapshot.yml
- Keyless replay counterpart with the same fs-sandbox diffBasisMaxBytes:64 and a replay provider re-declaring contextWindow/maxTokens/reasoningEfforts to match the pinned headers.
### snapshots/session/fs-write-overwrite-bounded/cordis.yml
- **Purpose:** The live composition that shrinks the diff-basis bound to make the degradation observable.
- **Key abstractions:** plugin config rows; `!!js` tagged expressions for runtime values.
- **Data flow:** `agent-default-model` pinned to `deepseek-v4-flash`; `session-persistence-jsonl` with zstd off under a snapshot run; `agent-instructions` with `maxBytes: 65536`; `system-prompt` with a two-line `personaPrefix`; `fs-sandbox` with `cwd: !!js process.cwd()` and `diffBasisMaxBytes: 64` (36).
- **Non-obvious design decisions:** the file's own comment says "A config patch replaces the row's whole config, so `cwd` is restated verbatim" — the patch semantics are merge-by-row, not merge-by-key, and the comment records that so a future edit does not drop it.
- **Edge cases / failure handling:** `diffBasisMaxBytes` is a *composition* knob, not a hardcoded constant, so the behaviour is reachable in production too — a user with a large file gets the degraded diff without any special build.
- **Surprising:** the persona is a `!!js`-free plain string here but the *replay* patch (`cordis.snapshot.yml`) re-declares the model capabilities to match the recorded header, which is how the fixture stays stable when the adapter's defaults change.
### snapshots/session/fs-write-overwrite-bounded/session.v2.jsonl
- Recorded bounded overwrite turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/fs-write-overwrite-bounded/session.v3.jsonl
- Recorded bounded overwrite turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/fs-write-overwrite-bounded/session.v4.jsonl
- **Purpose:** The recorded proof that the write tool's diff is *bounded* — past a byte budget the diff is abandoned rather than computed.
- **Key abstractions:** `meta: {operation: "create" | "update", path, diffs}`; the `fs-sandbox` config `diffBasisMaxBytes`; `adapterDefaults` in the request header.
- **Data flow:** `read data.txt` → `write data.txt` with a 87-byte replacement → the result is `Updated file` with `meta.diffs: []` (empty, because the basis exceeded the 64-byte bound) and the request header carries `config.maxTokens: 256000`, `config.reasoningEffort: "max"`, `adapterDefaults: {reasoningEffort: true, maxTokens: true}` and `request/context.contextWindow: 1000000`.
- **Non-obvious design decisions:** the bound is on the *diff basis* (how much of the old file the diff is computed against), not on the new content; when the bound is crossed the tool degrades to a whole-file diff and says so by returning an empty `diffs` list rather than a partial one. The empty list is the tell — a reader can distinguish "no change" from "diff suppressed".
- **Edge cases / failure handling:** the non-bounded twin (`fs-write-overwrite`) returns `diffs: [{path, oldText, newText}]` for the same operation, so the two fixtures bracket the threshold.
- **Surprising:** the header's `adapterDefaults` records *which* knobs the adapter chose (maxTokens, reasoningEffort) separately from the values, so a replay can reproduce the request without the adapter's defaults being re-derived.
### snapshots/session/fs-write-overwrite-bounded/snapshot.yml
- Manifest: composition fs-diff-bound, header.pin true, sidecar sources named as text-turn so another scenario owns the prompt and schema files.
### snapshots/session/fs-write-overwrite-bounded/workspace.expected/data.txt
- File oracle: the 87-byte replacement line that exceeds the 64-byte diff basis bound.
### snapshots/session/fs-write-overwrite-bounded/workspace/data.txt
- Seed file: 'original contents'.
### snapshots/session/fs-write-overwrite/session.v2.jsonl
- Recorded read-then-overwrite turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/fs-write-overwrite/session.v3.jsonl
- Recorded read-then-overwrite turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/fs-write-overwrite/session.v4.jsonl
- **Purpose:** The recorded shape of an *unbounded* overwrite, for contrast with the bounded twin.
- **Key abstractions:** `meta.diffs` with a populated list.
- **Data flow:** `read data.txt` → `write data.txt` with `replaced` → the result is "Updated file" and `meta.diffs` is `[{path: "<cwd>/data.txt", oldText: "original contents", newText: "replaced"}]`.
- **Non-obvious design decisions:** the diff is computed against the whole prior content, so `oldText` is the *entire* previous file — the pair is a before/after snapshot, not a hunk.
- **Edge cases / failure handling:** the same `read`-then-`write` shape as the create case; the workspace oracle checks the bytes.
- **Surprising:** `meta.path` is absolute in V4 and relative in V3 — the V3 fixture stores `{"path": "config.txt", …}` while V4 stores `{"path": "{{cwd}}/config.txt", …}`. A consumer that assumed the path was stable across formats would break on the migration.
### snapshots/session/fs-write-overwrite/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/fs-write-overwrite/workspace.expected/data.txt
- File oracle: 'replaced'.
### snapshots/session/fs-write-overwrite/workspace/data.txt
- Seed file: 'original contents'.
### snapshots/session/fs-write/session.v2.jsonl
- Recorded single write turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/fs-write/session.v3.jsonl
- Recorded single write turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/fs-write/session.v4.jsonl
- **Purpose:** The recorded shape of a first write (create, not update).
- **Key abstractions:** `meta: {operation: "create", path, diffs: []}`; the "Created file" result text.
- **Data flow:** a single `write notes.txt` with content `hello world` → the result is the `<path>/<type>/<content>` envelope with "Created file" and `meta.operation: "create"`.
- **Non-obvious design decisions:** an empty `diffs` list on a *create* is correct (there was no previous content to diff), which is why the bounded-overwrite fixture — where `diffs: []` on an *update* means "suppressed" — needs the `operation` field to be unambiguous.
- **Edge cases / failure handling:** the write did not need a prior read (there was no file), and the workspace oracle (`workspace.expected/notes.txt`) confirms the bytes on disk.
- **Surprising:** the create case and the suppressed-diff case both produce `diffs: []`; only `operation` distinguishes them — a consumer that reads `diffs.length === 0` as "nothing changed" will be wrong in both cases.
### snapshots/session/fs-write/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/fs-write/workspace.expected/notes.txt
- File oracle: 'hello world'.
### snapshots/session/headless-credentials/session.v4.jsonl
- **Purpose:** The recorded proof that the headless profile does not activate a managed credential store.
- **Key abstractions:** the `cordis_inspect_query` introspection tool; the `Config.listConfigs` method.
- **Data flow:** the model calls `cordis_inspect_query {platform: "host", provider: "Config", method: "listConfigs", input: {name: "@deepseek-ai/dsh-credentials-local"}}` → the result is a JSON page `{entries: [{id: "include:credentials", patchId: "credentials", name: "@deepseek-ai/dsh-credentials-local", status: "inactive"}], total: 1, nextOffset: null}` → the model answers `HEADLESS_CREDENTIALS_INACTIVE`.
- **Non-obvious design decisions:** the headless profile exposes the *host's own* configuration introspection API to the model, which is a deliberate capability for exactly this kind of assertion; the entry is present but `inactive`, so the check is "the plugin is registered but holds nothing", not "the plugin is absent".
- **Edge cases / failure handling:** the paging fields (`total`, `nextOffset`) are present even for a single page, so a consumer never has to special-case the empty case.
- **Surprising:** the credential plugin's *name* is in the transcript, so the fixture is safe to commit — it names the plugin but exposes no secret.
### snapshots/session/headless-credentials/snapshot.yml
- Manifest: composition advanced, recording authored, header class advanced.
### snapshots/session/headless.snapshot.ts
- **Purpose:** The corpus driver. Boots `dsh --profile headless` once per scenario and asserts that the re-persisted session equals the committed fixture.
- **Key abstractions:** `SnapshotMode = 'replay' | 'record' | 'refresh'`; `HeadlessScenario` (name, dir, manifest); `workspaceSetups` (named seed functions); `verify*` helpers per scenario family; `normalizedSystemPrompts` / `normalizedToolSchemas` / `normalizedHeaders` / `redactSessionSnapshotIds` from `@deepseek-ai/dsh-session-snapshot`.
- **Data flow:** `collectScenarios()` (563) → for each scenario: read `snapshot.yml`, pick the composition owner and the header-class pin, materialize `.snapshot-patches/0-…`, seed the workspace, run `runLoaderSmoke({binScript: dshBin, …})` with `DSH_SNAPSHOT=replay`, read back `.dsh/sessions/**`, normalize both sides, `expect(actualRecords).toEqual(expectedRecords)` (1441), then `verifyHeaders` (1443) and the workspace oracle (1445-1453).
- **Non-obvious design decisions:** the *task* is derived from the committed JSONL (`taskFromSession`, 326) and there is no `input.json` — asserted at 997; the system prompt and the tool schemas are stripped out of the transcript into sidecars (`scrubSystemPrompts` / `scrubToolSchemas`, asserted at 994-995) so a prompt change does not rewrite 40 transcripts; every composition and header class must have exactly ONE current-writer pin (955-960); scenario HTTP fixtures must bind an OS-assigned port, checked by walking the TypeScript AST for `listen(` without `port: 0` (962-987) — a static gate that needs no execution.
- **Edge cases / failure handling:** `compactionWorkspaceOptions` (102) pads the temp dir name to a *fixed* length so compaction pricing is not platform-dependent; `persistedSessions` (201) sorts children by `subagent/catalog` publication order, not by `createdAt`, because concurrent provider startup can publish an older child after a newer one; `sessionReferenceSpillExpected` (633) refuses to compare two different source-session format generations.
- **Surprising:** `stderrFromSession` (380) reconstructs the *reasoning stderr* of the headless run from the transcript, and the test compares it byte-for-byte — so the reasoning stream is a first-class, replayable artifact, not a UI nicety.
### snapshots/session/hook-cc-invalid-matcher/session.v2.jsonl
- Invalid-matcher turn in format V2: no hook/* event at all, the malformed matcher silently drops the handler.
### snapshots/session/hook-cc-invalid-matcher/session.v3.jsonl
- Invalid-matcher turn in format V3: still no hook/* event, the turn completes normally.
### snapshots/session/hook-cc-invalid-matcher/session.v4.jsonl
- **Purpose:** The recorded behaviour of a hook whose matcher is not a valid regex.
- **Key abstractions:** the `matcher` field of a hook rule; the `hook/invoked` event.
- **Data flow:** the `PreToolUse` rule has `matcher: "["` → **no `hook/invoked` event is emitted at all** → the turn proceeds normally and completes.
- **Non-obvious design decisions:** the malformed matcher causes the handler to be *dropped* rather than to fail the turn or to match everything. That is fail-open, and it is the opposite of the fail-closed behaviour the sandbox uses.
- **Edge cases / failure handling:** the same scenario's `UserPromptSubmit` rule has no matcher and is not invoked either (the turn needs no tool), so the fixture isolates the matcher behaviour.
- **Surprising:** a security hook that fails open on a typo is silent — nothing in the transcript, stderr or exit code says the rule was skipped. August should check its own hook matcher parsing for the same hole.
### snapshots/session/hook-cc-invalid-matcher/snapshot.yml
- Manifest: default composition, recording authored.
### snapshots/session/hook-cc-invalid-matcher/workspace/hooks.json
- Claude-code hook config with a no-matcher UserPromptSubmit and a PreToolUse whose matcher is the invalid regex '['.
### snapshots/session/hook-cc-posttool-block/session.v2.jsonl
- PostToolUse block turn in format V2: the successful tool output is replaced by the hook's stderr.
### snapshots/session/hook-cc-posttool-block/session.v3.jsonl
- PostToolUse block turn in format V3: the tool result is replaced and marked isError, the model retries once and the one-shot hook then passes.
### snapshots/session/hook-cc-posttool-block/session.v4.jsonl
- **Purpose:** The recorded proof that a `PostToolUse` hook can *replace* a successful tool result.
- **Key abstractions:** `hook/invoked` (point, dialect, handlerId, matcher) and `hook/result` (decision, exitCode, stderrSummary, durationMs); the tool result's `isError`.
- **Data flow:** `bash` runs and succeeds (a job is registered and settled) → the `PostToolUse` hook fires and blocks → the persisted tool result is `tool output rejected by policy: retry once` with `isError: true` — the original output is nowhere in the transcript → the model retries the same command, the one-shot hook now exits 0, and the real `HELLO` comes back.
- **Non-obvious design decisions:** the replacement happens at the *result* boundary, so the model never sees the bytes the hook is protecting; the replacement is marked `isError: true` so the model treats it as a failure rather than as output. The hook's stderr summary becomes the model's error text verbatim.
- **Edge cases / failure handling:** the hook is a one-shot (it touches `.posttool-blocked` first), so the retry path is exercised without making the test flaky; the marker file is the workspace oracle.
- **Surprising:** the *successful* command's own output is never persisted — the transcript shows the refusal, not the data. That is output redaction at the right layer, and it is exactly where August's outbound credential scrub would want to live.
### snapshots/session/hook-cc-posttool-block/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/hook-cc-posttool-block/workspace.expected/.posttool-blocked
- Zero-byte side-effect oracle proving the PostToolUse hook actually ran.
### snapshots/session/hook-cc-posttool-block/workspace.expected/hooks.json
- Unchanged copy of the hook config; the oracle only checks the new marker file.
### snapshots/session/hook-cc-posttool-block/workspace.expected/posttool-once.sh
- Unchanged copy of the one-shot hook script.
### snapshots/session/hook-cc-posttool-block/workspace/hooks.json
- Claude-code PostToolUse hook matching bash and running sh posttool-once.sh.
### snapshots/session/hook-cc-posttool-block/workspace/posttool-once.sh
- One-shot hook: creates .posttool-blocked and exits 2 the first time, exits 0 afterwards.
### snapshots/session/hook-cc-posttool-context/session.v2.jsonl
- PostToolUse context turn in format V2: the additional context is appended as a hooks-claude-code user message.
### snapshots/session/hook-cc-posttool-context/session.v3.jsonl
- PostToolUse context turn in format V3 with the context sourced from the hooks-claude-code plugin.
### snapshots/session/hook-cc-posttool-context/session.v4.jsonl
- The hook passes, the tool result is the real HELLO, and the additional context arrives as a separate user-role message with source kind hooks-claude-code.
### snapshots/session/hook-cc-posttool-context/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-cc-posttool-context/workspace/hooks.json
- Claude-code PostToolUse hook echoing a hookSpecificOutput JSON envelope with additionalContext.
### snapshots/session/hook-cc-pretool-ask/session.v2.jsonl
- PreToolUse ask turn in format V2: the ask and the rejection both appear.
### snapshots/session/hook-cc-pretool-ask/session.v3.jsonl
- PreToolUse ask turn in format V3: approval/asked and approval/decided precede the refusal.
### snapshots/session/hook-cc-pretool-ask/session.v4.jsonl
- **Purpose:** The recorded proof that an `ask` decision produces a real approval round-trip and fails closed with no answerer.
- **Key abstractions:** `hook/result` with `decision: "ask"`; `approval/asked` (id, toolName, callId, reason); `approval/decided` (id, outcome).
- **Data flow:** the hook returns `permissionDecision: "ask"` → the harness emits `approval/asked` with the tool name, call id and the hook's reason → with no answerer present it emits `approval/decided` with `outcome: "rejected"` → the tool result is `Error: the user rejected tool "bash"` with `isError: true`.
- **Non-obvious design decisions:** the *ask* and the *decision* are two separate durable events, so a consumer can render "August wanted to run X" independently of "who said no"; the hook's `exitCode: 0` is kept distinct from the decision value, because the hook succeeded in *reporting* an ask.
- **Edge cases / failure handling:** the runtime-context text in the same turn states "without an available answerer, the request fails closed" — the fixture is the proof of that sentence, and the model gets a refusal rather than a hang.
- **Surprising:** the tool never ran at all, yet a `tool/call` event exists — the call is recorded and then answered with an error, so the transcript shows the intent as well as the refusal.
### snapshots/session/hook-cc-pretool-ask/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-cc-pretool-ask/workspace/hooks.json
- Claude-code PreToolUse hook returning permissionDecision ask with a reason.
### snapshots/session/hook-cc-pretool-deny/session.v2.jsonl
- PreToolUse deny turn in format V2: the bash call is refused.
### snapshots/session/hook-cc-pretool-deny/session.v3.jsonl
- PreToolUse deny turn in format V3: the refusal carries the hook's stderrSummary.
### snapshots/session/hook-cc-pretool-deny/session.v4.jsonl
- The bash tool is blocked by the hook; the tool result is 'Error: bash is disabled by policy in this session' with isError:true and the turn still ends completed.
### snapshots/session/hook-cc-pretool-deny/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-cc-pretool-deny/workspace/hooks.json
- Claude-code PreToolUse hook matching bash that writes to stderr and exits 2.
### snapshots/session/hook-cc-promptsubmit-block/session.v2.jsonl
- Prompt-submit block turn in format V2: hook/result decision block and turn/end reason blocked, with the model never called.
### snapshots/session/hook-cc-promptsubmit-block/session.v3.jsonl
- Prompt-submit block turn in format V3 with the same blocked reason, showing the reason vocabulary predates the migration.
### snapshots/session/hook-cc-promptsubmit-block/session.v4.jsonl
- **Purpose:** The recorded proof that a `UserPromptSubmit` hook can abort a turn *before* the model is called.
- **Key abstractions:** `turn/end` with `reason: {kind: "blocked"}`; the absence of any `system/message` or `request/header`.
- **Data flow:** the user asks "Delete everything in the repo." → the hook fires and blocks with `exitCode: 2` and `stderrSummary: "blocked by policy hook"` → `turn/end` says `blocked` → the transcript is ten lines and contains **no** model call at all.
- **Non-obvious design decisions:** the block is a *turn-level* outcome with its own reason kind, not a tool error — the model never ran, so there is no model output to qualify; the `blocked` reason is already present in the V2 fixture, so the reason vocabulary is stable across the session-format migration.
- **Edge cases / failure handling:** the `durationMs` on the hook result is recorded even for a block, so a slow blocking hook is measurable.
- **Surprising:** the transcript for a blocked turn is so short that the whole policy decision fits in nine lines — an audit of "what was this session" is a single read of the last line.
### snapshots/session/hook-cc-promptsubmit-block/snapshot.yml
- Manifest: default composition, recording authored.
### snapshots/session/hook-cc-promptsubmit-block/workspace/hooks.json
- Claude-code UserPromptSubmit hook with the invalid matcher '[' whose command would exit 2.
### snapshots/session/hook-cc-promptsubmit-context/session.v2.jsonl
- Prompt-submit context turn in format V2: the additional context is appended as a hooks-claude-code user message.
### snapshots/session/hook-cc-promptsubmit-context/session.v3.jsonl
- Prompt-submit context turn in format V3 with the context sourced from the hooks-claude-code plugin.
### snapshots/session/hook-cc-promptsubmit-context/session.v4.jsonl
- **Purpose:** The recorded proof that a hook can add facts to the conversation without touching the tool surface.
- **Key abstractions:** the `hookSpecificOutput.additionalContext` envelope; a `user/message` whose `source.kind` is `hooks-claude-code`.
- **Data flow:** the `UserPromptSubmit` hook runs and passes → its `additionalContext` ("The user has previously stated their favorite color is teal.") is appended as a **user-role** message after the runtime-context message → the model answers `teal` and never calls a tool.
- **Non-obvious design decisions:** the injected text is a *user* message, not a system message, so it lands in the conversation prefix at a stable position and the model treats it as context rather than as instruction; the hook's own decision is still recorded (`decision: "pass"`, exit 0), so the transcript shows that the hook ran and permitted the turn.
- **Edge cases / failure handling:** the injected message has its own message id, so it can be addressed or removed like any other message; in V3 the same injection carries `source: {kind: "plugin", plugin: "hooks-claude-code"}`.
- **Surprising:** the hook's text becomes part of the *persisted transcript* and is therefore replayable — a hook is a way to inject durable context, not just a gate.
### snapshots/session/hook-cc-promptsubmit-context/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-cc-promptsubmit-context/workspace/hooks.json
- Claude-code UserPromptSubmit hook echoing a hookSpecificOutput envelope with additionalContext about the user's favourite colour.
### snapshots/session/hook-cc-stop-continue/session.v2.jsonl
- Stop-hook continuation turn in format V2: the block text is spliced into the inbox and a second step runs.
### snapshots/session/hook-cc-stop-continue/session.v3.jsonl
- Stop-hook continuation turn in format V3: two agent/inbox/spliced events become a hooks-claude-code user message and the Stop hook is re-invoked.
### snapshots/session/hook-cc-stop-continue/session.v4.jsonl
- **Purpose:** The recorded proof that a `Stop` hook can continue the turn.
- **Key abstractions:** the `Stop` hook point; `agent/inbox/spliced` with `target: "next-step"`; a `user/message` with `source: {kind: "hooks-claude-code"}`.
- **Data flow:** the model answers `FIRST` → the `Stop` hook fires and blocks, and its stderr ("Also reply with the single word SECOND, then stop.") is injected through two `agent/inbox/spliced` events (inserted, then removed) → a second `step` runs and the model answers `SECOND` → the `Stop` hook is invoked **again** (handlerId `:1` → `:2`) and this time passes → the turn ends `completed`.
- **Non-obvious design decisions:** the continuation is delivered through the *inbox* (the same mechanism as a human message arriving mid-turn), not by mutating the assistant message — so the "the model was told to do more" is a first-class part of the conversation and survives a reload; the hook is re-invoked rather than trusted once, so a hook that always blocks cannot loop forever without being visible.
- **Edge cases / failure handling:** the hook script itself is one-shot (`.stop_fired`), so the fixture terminates deterministically; the workspace oracle is the zero-byte `.stop_fired` file.
- **Surprising:** the same scenario in V3 delivers the continuation through `agent/inbox/spliced` with `target: "next-step"`, whereas V4 records the injected text as a plain `user/message` with a typed source — the *inbox* was flattened into a message event.
### snapshots/session/hook-cc-stop-continue/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/hook-cc-stop-continue/workspace.expected/.stop_fired
- Zero-byte side-effect oracle proving the Stop hook fired.
### snapshots/session/hook-cc-stop-continue/workspace.expected/hooks.json
- Unchanged copy of the hook config.
### snapshots/session/hook-cc-stop-continue/workspace/hooks.json
- Claude-code Stop hook that touches .stop_fired and exits 2 with a follow-up instruction the first time.
### snapshots/session/hook-codex-invalid-matcher/session.v2.jsonl
- Codex invalid-matcher turn in format V2: no hook event, the handler is silently dropped.
### snapshots/session/hook-codex-invalid-matcher/session.v3.jsonl
- Codex invalid-matcher turn in format V3: still no hook event.
### snapshots/session/hook-codex-invalid-matcher/session.v4.jsonl
- Codex dialect with the invalid regex '[' matcher: no hook/* event is emitted and the turn completes normally.
### snapshots/session/hook-codex-invalid-matcher/snapshot.yml
- Manifest: default composition, recording authored.
### snapshots/session/hook-codex-invalid-matcher/workspace/codex-hooks.json
- The codex dialect reads codex-hooks.json rather than hooks.json; same invalid matcher.
### snapshots/session/hook-codex-posttool-block/session.v2.jsonl
- Codex PostToolUse block turn in format V2: the tool output is replaced by the hook's message.
### snapshots/session/hook-codex-posttool-block/session.v3.jsonl
- Codex PostToolUse block turn in format V3 with the replacement marked isError.
### snapshots/session/hook-codex-posttool-block/session.v4.jsonl
- The successful bash output is replaced by 'tool output rejected by codex policy: summarize instead' with isError:true; the codex hook blocks unconditionally.
### snapshots/session/hook-codex-posttool-block/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-codex-posttool-block/workspace/codex-hooks.json
- Codex PostToolUse hook matching bash that rejects the output with a policy message.
### snapshots/session/hook-codex-posttool-context/session.v2.jsonl
- Codex PostToolUse context turn in format V2: the context is appended as a hooks-codex user message.
### snapshots/session/hook-codex-posttool-context/session.v3.jsonl
- Codex PostToolUse context turn in format V3 with the context sourced from the hooks-codex plugin.
### snapshots/session/hook-codex-posttool-context/session.v4.jsonl
- The tool result is the real HELLO and the context arrives as a user-role message with source kind hooks-codex; here codex uses the same JSON envelope as claude-code.
### snapshots/session/hook-codex-posttool-context/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-codex-posttool-context/workspace/codex-hooks.json
- Codex PostToolUse hook echoing the hookSpecificOutput JSON envelope.
### snapshots/session/hook-codex-pretool-block/session.v2.jsonl
- Codex PreToolUse block turn in format V2: the bash call is refused.
### snapshots/session/hook-codex-pretool-block/session.v3.jsonl
- Codex PreToolUse block turn in format V3 with the codex-specific refusal text.
### snapshots/session/hook-codex-pretool-block/session.v4.jsonl
- The bash tool is blocked with 'Error: bash is disabled by codex policy in this session' and isError:true; the codex dialect has no ask variant in this corpus.
### snapshots/session/hook-codex-pretool-block/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-codex-pretool-block/workspace/codex-hooks.json
- Codex PreToolUse hook matching bash that writes to stderr and exits 2.
### snapshots/session/hook-codex-promptsubmit-block/session.v2.jsonl
- Codex prompt-submit block turn in format V2: turn/end reason blocked.
### snapshots/session/hook-codex-promptsubmit-block/session.v3.jsonl
- Codex prompt-submit block turn in format V3 with the same blocked reason.
### snapshots/session/hook-codex-promptsubmit-block/session.v4.jsonl
- Same block shape as the claude-code dialect but with dialect codex and handlerId codex:UserPromptSubmit:1.
### snapshots/session/hook-codex-promptsubmit-block/snapshot.yml
- Manifest: default composition, recording authored.
### snapshots/session/hook-codex-promptsubmit-block/workspace/codex-hooks.json
- Codex UserPromptSubmit block hook.
### snapshots/session/hook-codex-promptsubmit-context/session.v2.jsonl
- Codex prompt-submit context turn in format V2: the raw stdout becomes a hooks-codex user message.
### snapshots/session/hook-codex-promptsubmit-context/session.v3.jsonl
- Codex prompt-submit context turn in format V3 with the context sourced from the hooks-codex plugin.
### snapshots/session/hook-codex-promptsubmit-context/session.v4.jsonl
- **Purpose:** The recorded behaviour of the *codex* dialect's `UserPromptSubmit` context hook — and the dialect difference against claude-code.
- **Key abstractions:** the `dialect` field on `hook/invoked`; the codex config file name `codex-hooks.json`; raw stdout as context.
- **Data flow:** the hook echoes **plain text** (no `hookSpecificOutput` envelope) → the text becomes a `user/message` with `source: {kind: "hooks-codex"}` → the hook fires *before* the user's own message is appended, the opposite of the claude-code ordering.
- **Non-obvious design decisions:** the two dialects disagree on both the *encoding* of the context (raw stdout vs. a JSON envelope) and the *ordering* of the injection relative to the user message; both are pinned by separate fixtures so neither can drift silently.
- **Edge cases / failure handling:** the `handlerId` namespace is dialect-scoped (`codex:UserPromptSubmit:1` vs `claude-code:UserPromptSubmit:1`), so the two dialects can be registered simultaneously without colliding.
- **Surprising:** the codex dialect's `PostToolUse` context hook *does* use the JSON envelope (`hook-codex-posttool-context`), so the dialects are not uniformly different — the difference is per hook point, not per dialect.
### snapshots/session/hook-codex-promptsubmit-context/snapshot.yml
- Manifest: default composition, recording live.
### snapshots/session/hook-codex-promptsubmit-context/workspace/codex-hooks.json
- Codex UserPromptSubmit hook that echoes plain text rather than a hookSpecificOutput envelope.
### snapshots/session/hook-codex-stop-continue/session.v2.jsonl
- Codex stop-hook continuation turn in format V2: the block text is spliced into the inbox.
### snapshots/session/hook-codex-stop-continue/session.v3.jsonl
- Codex stop-hook continuation turn in format V3: the Stop hook is re-invoked with an incremented handlerId.
### snapshots/session/hook-codex-stop-continue/session.v4.jsonl
- Same block -> inbox splice -> SECOND -> second Stop invocation passes shape as claude-code, with dialect codex and handlerIds codex:Stop:1 and :2.
### snapshots/session/hook-codex-stop-continue/snapshot.yml
- Manifest: default composition, recording live, workspace.final true.
### snapshots/session/hook-codex-stop-continue/workspace.expected/.stop_fired
- Zero-byte side-effect oracle proving the Stop hook fired.
### snapshots/session/hook-codex-stop-continue/workspace.expected/codex-hooks.json
- Unchanged copy of the hook config.
### snapshots/session/hook-codex-stop-continue/workspace/codex-hooks.json
- Codex Stop hook identical in shell to the claude-code one.
### snapshots/session/loopback-fixture-server.mjs
- **Purpose:** Shared lifecycle for snapshot HTTP fixtures that need an ephemeral loopback port.
- **Key abstractions:** `applyLoopbackServerEffect(ctx, {label, onCleanup, onListening, requestListener})` registered as a Cordis effect.
- **Data flow:** `ctx.effect()` → `listen(server)` on port 0 → `onListening(address)` → returns a cleanup closure.
- **Non-obvious design decisions:** `server.unref()` (64) so a fixture never holds the process open past protocol shutdown; cleanup errors are aggregated (`AggregateError`) rather than swallowed, and a setup failure still runs cleanup (66-73).
- **Edge cases / failure handling:** `server.closeAllConnections()` after `close()` so a keep-alive socket cannot delay teardown; the fixture's port is never written into the transcript, which is why the corpus can be byte-identical across machines.
- **Surprising:** the whole file is 75 lines and has no dependency on the harness — it is a generic pattern for "a test fixture that must not leak a port or a process".
### snapshots/session/lsp-definition/cordis.snapshot.yml
- Keyless replay of the LSP composition: llm-deepseek swapped for llm-replay, same lsp/lsp-stdio/tool-lsp rows and the timeout-policy plugin.
### snapshots/session/lsp-definition/cordis.yml
- Live composition inserting dsh-lsp and dsh-lsp-stdio with a fixture server, tool-lsp with maxLocations 1, and the tool-call-timeout-policy plugin.
### snapshots/session/lsp-definition/session.v2.jsonl
- Recorded LSP turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/lsp-definition/session.v3.jsonl
- Recorded LSP turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/lsp-definition/session.v4.jsonl
- One lsp goToDefinition call whose result is 'subject.ts:1:7' plus '... 1 more location omitted (limit 1).' - the cap is reported in the result text.
### snapshots/session/lsp-definition/snapshot.yml
- Manifest: composition lsp, recording authored, header.pin true.
### snapshots/session/lsp-definition/system-prompt.expected.md
- Pinned prompt that gains an LSP fragment (when to use lsp, one-based UTF-16 positions, findReferences includes the declaration) because the lsp tool is present.
### snapshots/session/lsp-definition/tool-schemas.expected.json
- Pinned schema set including the lsp tool.
### snapshots/session/lsp-definition/workspace/lsp-server.mjs
- **Purpose:** A 57-line deterministic LSP server so the LSP tool can be exercised without a real language server.
- **Key abstractions:** the LSP `Content-Length` framing; `initialize` with `positionEncoding: "utf-16"`; `textDocument/definition`.
- **Data flow:** the server buffers stdin, parses the header block and the body, and answers `initialize` with `definitionProvider: true` and `textDocument/definition` with **two** locations for the same file — so the tool's `maxLocations: 1` cap is observable.
- **Non-obvious design decisions:** the framing is implemented by hand rather than pulled from a library, so the fixture has no dependency and the byte-level protocol is explicit; `positionEncoding: "utf-16"` is declared so the position semantics under test are the ones the prompt describes.
- **Edge cases / failure handling:** a partial header or a short body returns without parsing, so a chunked write is handled; a missing `Content-Length` throws rather than guessing.
- **Surprising:** the server answers `textDocument/definition` with two locations *of the same file at different lines* — the fixture is built to make the "1 more location omitted (limit 1)" truncation visible in the tool result.
### snapshots/session/lsp-definition/workspace/subject.ts
- Two-line TypeScript subject: export const answer = 42.
### snapshots/session/mcp-empty-ptc/cordis.snapshot.yml
- Keyless replay of the PTC composition: llm-replay inserted, literal-sdk fixture, tools mode ptc, and a two-line persona prefix.
### snapshots/session/mcp-empty-ptc/cordis.yml
- PTC composition: inserts the literal-sdk fixture and sets tools mode ptc so the whole tool list collapses to a single run_code tool.
### snapshots/session/mcp-empty-ptc/session.v3.jsonl
- PTC turn in format V3: one run_code call fanning out to two sub-calls, each recorded as tool/ptc-dispatch.
### snapshots/session/mcp-empty-ptc/session.v4.jsonl
- **Purpose:** The recorded proof that program-tool-call mode collapses N tool calls into one model round-trip while keeping every sub-call auditable.
- **Key abstractions:** `tool/ptc-dispatch-start`, `tool/ptc-dispatch`, `job/registered`, `job/settled`; the `rootCallId` / `parentCallId` / `subCallId` triple.
- **Data flow:** one `run_code` call whose program awaits `tools.bash({command: 'echo CODE_ONE'})` then `tools.bash({command: 'echo CODE_TWO'})` → the transcript records, for each sub-call, a `tool/ptc-dispatch-start` (with `subCallId` = `<rootCallId>:ptc:1`), the job lifecycle, and a `tool/ptc-dispatch` carrying the result → one `tool/result` for the whole program.
- **Non-obvious design decisions:** the sub-call id is *derived* from the root call id, so the join back to the model request is structural rather than a side table; the program itself is persisted as the `run_code` arguments, so the whole program is replayable.
- **Edge cases / failure handling:** a sub-call is a first-class job, so a long-running sub-tool inside a program gets the same timeout and cancellation treatment as a top-level tool.
- **Surprising:** the model only ever names `run_code`; the tool schemas of every other tool are absent from the request and appear instead as a TypeScript declaration inside the system prompt — the tool surface is code, not a list.
### snapshots/session/mcp-empty-ptc/snapshot.yml
- Manifest: composition mcp-empty-ptc, header.pin true, sidecar sources named as ptc-turn.
### snapshots/session/mcp-empty/cordis.snapshot.yml
- Keyless replay: llm-deepseek disabled, llm-replay inserted with contextWindow 1000000, defaultMaxTokens 256000, reasoningEfforts [off,low,high,max], defaultReasoningEffort max.
### snapshots/session/mcp-empty/cordis.yml
- Literally an empty list - no MCP server is configured at all.
### snapshots/session/mcp-empty/session.v3.jsonl
- Plain bash turn in format V3 with the full 26-tool surface and no MCP anywhere.
### snapshots/session/mcp-empty/session.v4.jsonl
- Plain bash turn in format V4; the driver asserts that no tool name contains mcp and the prompt contains neither MCP nor mcp__.
### snapshots/session/mcp-empty/snapshot.yml
- Manifest: composition mcp-empty, header.pin true, sidecar sources named as text-turn.
### snapshots/session/mcp-resources-ptc/cordis.snapshot.yml
- Keyless replay of the PTC MCP composition: same mcp-client row plus tools mode ptc.
### snapshots/session/mcp-resources-ptc/cordis.yml
- The MCP client plus tools name dsh-tools with config mode ptc.
### snapshots/session/mcp-resources-ptc/session.v3.jsonl
- MCP resource work in format V3 driven through run_code, with five tool/ptc-dispatch events.
### snapshots/session/mcp-resources-ptc/session.v4.jsonl
- The same resource work through run_code; the driver asserts the PTC form exposes binaryAvailable:true where the native form refuses the binary.
### snapshots/session/mcp-resources-ptc/snapshot.yml
- Manifest: composition mcp-resources-ptc, recording live, header.pin true.
### snapshots/session/mcp-resources-ptc/system-prompt.expected.md
- **Purpose:** The PTC-mode prompt, which teaches the model to drive every tool from inside a program.
- **Key abstractions:** the "run_code is the only tool you can call directly" rule; the "Writing code for run_code" contract; the `ToolArgsMap` / `ToolOutputMap` TypeScript declarations.
- **Data flow:** the standard fragments → the run_code-only rule → the contract (erasable syntax only; `await tools.name(args)`; a failed call rejects with `ToolCallError` carrying `toolName` and a human-readable message; independent *read-only* calls may overlap under `Promise.all` while mutating calls run alone in submission order; only what is printed or returned is program output; an image-bearing result is attached after the run) → the full type declarations.
- **Non-obvious design decisions:** the prompt states the read-only/mutating split explicitly, because a program that races two mutating tools would otherwise be an ordering bug the model cannot see; it also states that intermediate tool results stay out of the conversation, so the model must extract what it needs rather than assume it will see everything.
- **Edge cases / failure handling:** "Programs are never replayed automatically" is in the tool description — a program that partly ran must not be silently re-executed, because its side effects may already exist.
- **Surprising:** the declarations are *typed*, so a model that writes `tools.office_tools(...)` gets a `TypeError: tools.office_tools is not a function` from the runtime rather than a silent no-op — the type surface is the contract.
### snapshots/session/mcp-resources-ptc/tool-schemas.expected.json
- A single tool (run_code) whose description carries the whole program contract including 'Programs are never replayed automatically'.
### snapshots/session/mcp-resources/cordis.snapshot.yml
- Keyless replay of the MCP composition: llm-replay with the full capability block plus the same mcp-client row.
### snapshots/session/mcp-resources/cordis.yml
- Inserts dsh-mcp-client with transport stdio, serverName catalog, failOnStartupError true and reconnect disabled.
### snapshots/session/mcp-resources/session.v3.jsonl
- MCP resource turn in format V3: list and read calls, tool results wrapped, binary returned as a placeholder rather than base64.
### snapshots/session/mcp-resources/session.v4.jsonl
- **Purpose:** The recorded MCP resource flow in native mode, including parallel calls and the treatment of binary content.
- **Key abstractions:** `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`; a resource result framed by `MCP server: <name>` plus the raw MCP JSON payload.
- **Data flow:** step 1 issues `list_mcp_resources` **and** `list_mcp_resource_templates` in the same step (two parallel tool calls) → step 2 issues two `read_mcp_resource` calls in the same step → step 3 reads the binary resource → the binary comes back as `blob: "[binary resource: 28 base64 characters; available to programmatic callers]"`.
- **Non-obvious design decisions:** the base64 payload is **never written to the transcript** — the model is told how big it is and that a programmatic caller can get it, but the bytes stay out; in PTC mode the same resource exposes `binaryAvailable: true` instead, so a program can fetch it.
- **Edge cases / failure handling:** the `_meta` server-info block, `ttlMs` and `cacheScope` are passed through verbatim, so the model sees the server's own cache scope; `{{braces}}` in the resource text survive unescaped and a fixture asserts it.
- **Surprising:** the MCP server can also inject an instruction block into the *system prompt* (`MCP_RESOURCE_INSTRUCTION`) — a server-authored text path into the model's instructions, which is a prompt-injection surface the corpus does not visibly guard.
### snapshots/session/mcp-resources/snapshot.yml
- Manifest: composition mcp-resources, recording live, header.pin true.
### snapshots/session/mcp-resources/system-prompt.expected.md
- **Purpose:** The pinned prompt for a composition that has an MCP server, and the record of the server's contribution to it.
- **Key abstractions:** the `## MCP resource servers` section; the per-server `### MCP server: <name>` subsection; the `MCP_RESOURCE_INSTRUCTION` line.
- **Data flow:** the standard fragments, then "Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ["catalog"]", then the server's own instruction text.
- **Non-obvious design decisions:** the *tool names* and the *server names* are stated in the prompt (the server name is a required argument to every MCP tool, so the model cannot guess it), but the MCP tools are **not** in the tool schemas for the PTC variant — there the tool API is a TypeScript declaration instead.
- **Edge cases / failure handling:** the empty-MCP fixture (`mcp-empty`) asserts the *absence* of the section and of the word `MCP` in the prompt, so the section is genuinely conditional and not a fixed header.
- **Surprising:** the server's instruction is injected verbatim into the model's instructions, with no visible escaping or attribution — a hostile or compromised MCP server can write into the system prompt.
### snapshots/session/mcp-resources/tool-schemas.expected.json
- Pinned schema set including list_mcp_resources, list_mcp_resource_templates and read_mcp_resource.
### snapshots/session/missing-sandbox-runner/session.v2.jsonl
- Sandbox-failure turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/missing-sandbox-runner/session.v3.jsonl
- Sandbox-failure turn in format V3 with a plugin-sourced system/message event.
### snapshots/session/missing-sandbox-runner/session.v4.jsonl
- **Purpose:** The recorded proof that the sandbox fails *closed* when no backend is usable, and says what to do about it.
- **Key abstractions:** the `SandboxUnavailable`-style error; the `job_output` "unknown job" follow-up.
- **Data flow:** a `bash` call with `permission: read-only` → the error is "Error: sandbox mode \"read-only\" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access. Runner failure: Error: spawn …/.dsh-missing-sandbox-runner ENOENT" → the model's next call is `job_output {job_id: "bash-1"}` and gets `Error: unknown job bash-1`.
- **Non-obvious design decisions:** the refusal is unconditional — "refusing to run the command unconfined" — and the error names the *per-platform* remedy (bubblewrap / Landlock / sandbox-exec / ACL restricted token), so a user on any OS can act on it; the "otherwise switch the consumer to danger-full-access" clause names the configuration knob.
- **Edge cases / failure handling:** the follow-up `job_output` proves that no job was ever registered — the command never reached a process, so there is nothing to collect.
- **Surprising:** the model was *told* to look for job `bash-1`; the answer is that the id does not exist. A consumer that assumes a tool call implies a job will be wrong here.
### snapshots/session/missing-sandbox-runner/snapshot.yml
- Manifest: composition partial-landlock, platform posix, permission read-only, environment DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER=1.
### snapshots/session/model-switch-notice/cordis.snapshot.yml
- Keyless replay keeping both recorded model routes in the replay catalog and applying the same second-assembly selection change.
### snapshots/session/model-switch-notice/cordis.yml
- Live composition inserting a test-only driver that changes the model selection after the first step.
### snapshots/session/model-switch-notice/model-switch-driver.mjs
- **Purpose:** A 52-line test-only Cordis plugin that switches the model between two steps.
- **Key abstractions:** `installModelSelection(agent.ctx, selection)`; the `system-prompt/assemble` and `agent/request` waterfalls.
- **Data flow:** on `agent/created` the driver installs a selection holder; on a `todo/write` event it sets `selection.current`; the `system-prompt/assemble` waterfall rewrites the assembled prompt's `provider`/`model` variables (29); the `agent/request` waterfall replaces the resolved request with the selected provider/model (39) and **deliberately drops the inherited `reasoningEffort`**.
- **Non-obvious design decisions:** the driver is authoritative — the comment says "These root waterfalls make the driver authoritative; ending after step two avoids a reverse notice" — so the selection cannot be re-derived by a later plugin; dropping the inherited `reasoningEffort` proves the new model's own default applies rather than the old model's setting leaking across.
- **Edge cases / failure handling:** `ctx.on('session/event', …)` filters on `event.type !== 'todo/write'` and throws if the selection was never installed, so a driver that lost the race fails loudly instead of silently doing nothing.
- **Surprising:** this is a *composition-level* way to change the model — no model-facing tool and no API call — which is how the harness can swap models on a policy decision without the model being able to ask for it.
### snapshots/session/model-switch-notice/session.v2.jsonl
- Model-switch turn in format V2 with the system prompt inside request/header.system.
### snapshots/session/model-switch-notice/session.v3.jsonl
- Model-switch turn in format V3 with two system/message events (the second replacing the first).
### snapshots/session/model-switch-notice/session.v4.jsonl
- **Purpose:** The recorded proof that a mid-turn model change is announced, not silent.
- **Key abstractions:** `surfaceOp: {op: "replace", startSeq, endSeq}`; a `user/message` with `source: {kind: "model-selection", form: "notice", summary}`; a `request/header` with `reason: "change"` and `startsSeries: true`.
- **Data flow:** step 1 calls `todo_write` → the `system/message` is re-emitted with a *replace* surface op (so the prompt is swapped, not duplicated) → a user message is inserted reading "[model changed: assistant turns above this point were generated by deepseek-v4-flash; the session continues with deepseek-v4-pro]" → the next `request/header` names `deepseek-v4-pro` and marks the new request series.
- **Non-obvious design decisions:** the prompt is *replaced* rather than appended, which keeps the prompt prefix the same length and stops the two generations from accumulating; `startsSeries: true` tells a consumer that the request history is now split by model.
- **Edge cases / failure handling:** the notice is a plain user-role message, so it is part of the conversation and is replayed — the cheap model that continues the turn is *told* what happened.
- **Surprising:** the `summary` field carries the machine-readable transition (`deepseek-v4-flash → deepseek-v4-pro`) while the message text carries the human-readable one — the same event serves both a UI badge and a model.
### snapshots/session/model-switch-notice/snapshot.yml
- Manifest: composition model-switch-notice, recording live, header.pin true, changes 1, promptChanges 1, toolSchemasSource compaction-recovery.
### snapshots/session/model-switch-notice/system-prompt.expected.md
- Both prompt generations separated by an HTML comment marker '<!-- system/message change 1 -->'.
### snapshots/session/multimodal-spill-ends/cordis.snapshot.yml
- Keyless replay declaring inputModalities [text] for text models and [text,image] plus imageRequestTokens 169 for the vision model, so the strict read_image gate accepts the route.
### snapshots/session/multimodal-spill-ends/cordis.yml
- **Purpose:** The live composition for the image/spill scenario.
- **Key abstractions:** the `agent-default-model` row; `attachment-local`; `spill-policy`; `spill-local`.
- **Data flow:** the default model is pinned to `deepseek-v4-flash-vision-exp`; `agent-instructions` gets `maxBytes: 65536`; `spill-policy` gets `maxInlineTokens: 1000` (36); the `snapshot-spill-locators` script is inserted with the spill root and the locator root.
- **Non-obvious design decisions:** the inline budget is a **plugin config** (`maxInlineTokens`), not a constant, so the same behaviour is reachable in production and tunable; the comment says the attachment store "resolves its root from `$DSH_HOME`, which the snapshot harness scopes per run, so the patch itself carries no attachment path" — the isolation is the harness's job, not the patch's.
- **Edge cases / failure handling:** the spill root falls back to `./.spill` outside a snapshot run, so the composition is self-contained.
- **Surprising:** a *vision* model is required for the scenario, which makes the composition itself a model-capability test — the image path only works if the selected model can accept images.
### snapshots/session/multimodal-spill-ends/fixture.mjs
- Cordis plugin registering mcp__fixture__inspect, whose call returns the 'ends' layout (A, image, 20000 Bs, image, C) or the 'middle' layout (8000 As, image, 8000 Cs).
### snapshots/session/multimodal-spill-ends/session.v3.jsonl
- Multimodal tool result in format V3: images and text blocks as a wrapped tool-result message.
### snapshots/session/multimodal-spill-ends/session.v4.jsonl
- **Purpose:** The recorded proof of the "keep the ends" policy for an oversized multimodal tool result.
- **Key abstractions:** `{type: "image", attachment: {attachmentId, mediaType, width, height, bytes}}`; the spill notice.
- **Data flow:** the MCP tool returns `[text "A", image, text "B"×20000, image, text "C"]` → the persisted result keeps the text blocks and converts each image to a sha256 attachment reference → the last text ends with "(Omitted 18108 bytes. Full formatted result stored at: /tmp/…/…-mcp__fixture__inspect.txt. Use read with offset/limit, or grep this path to search within it.)".
- **Non-obvious design decisions:** the images survive because they are near the *ends* of the result; the omitted bytes are the middle of the 20 000-character block, so the model keeps the shape of the answer. The attachment id is the sha256 of the bytes, which makes the reference content-addressed and dedupable.
- **Edge cases / failure handling:** the spill notice names the file and the two ways to use it (`read` with offset/limit, or `grep`), so the model has a route to the omitted bytes that does not blow the context window again.
- **Surprising:** the *image bytes* never enter the transcript at all — only a 90-byte descriptor does, plus a pointer into the durable attachment store.
### snapshots/session/multimodal-spill-ends/snapshot.yml
- Manifest: composition multimodal-spill, recording authored, header.pin true.
### snapshots/session/multimodal-spill-ends/system-prompt.expected.md
- Pinned prompt whose persona line names the deepseek-v4-flash-vision-exp model.
### snapshots/session/multimodal-spill-ends/tool-schemas.expected.json
- Pinned schema set including the MCP tool mcp__fixture__inspect.
### snapshots/session/multimodal-spill-middle/session.v3.jsonl
- Middle-layout multimodal result in format V3 with the image dropped and the tool result wrapped.
### snapshots/session/multimodal-spill-middle/session.v4.jsonl
- **Purpose:** The recorded proof that a middle image is *dropped* from an oversized result, and that the drop is disclosed.
- **Key abstractions:** the "Omitted N images" clause in the spill notice.
- **Data flow:** the tool returns `[text "A"×8000, image, text "C"×8000]` → the transcript keeps the head and tail of the text, **drops the image**, and ends with "(Omitted 12308 bytes. Omitted 1 images. Full formatted result stored at: /tmp/…/…-mcp__fixture__inspect.txt. Use read with offset/limit, or grep this path to search within it.)".
- **Non-obvious design decisions:** the policy is positional, not type-based: an image at the end of a result is kept, an image buried in the middle of a large text block is not. The "Omitted 1 images" wording tells the model that an image *existed* rather than pretending the result never had one.
- **Edge cases / failure handling:** the count of omitted images is stated separately from the byte count, so a model (or a human) can tell a text-truncated result from an image-dropped one.
- **Surprising:** the grammatical "1 images" is in the recorded golden file — the string is byte-pinned, which tells you the corpus is diffed exactly, not fuzzily.
### snapshots/session/multimodal-spill-middle/snapshot.yml
- Manifest: same multimodal-spill composition, recording authored, no pin because it shares the header class with -ends.
### snapshots/session/office-authoring-checker/cordis.snapshot.yml
- Keyless replay whose replay models carry toolUpdate: in-history, a per-model capability that changes how the tool list is updated mid-conversation.
### snapshots/session/office-authoring-checker/cordis.yml
- Inserts dsh-skill-office with assetRoot and cli:false (no renderer) and disables tool-bash and tool-pwsh.
### snapshots/session/office-authoring-checker/session.v4.jsonl
- Loads office-docx, office-pptx and office-xlsx then reads office-skills/office/references/sidecar.md - the checker reads the reference file instead of running anything.
### snapshots/session/office-authoring-checker/snapshot.yml
- Manifest: composition office-authoring-checker, recording authored, header.pin true, toolSchemasSource office-progressive-native.
### snapshots/session/office-authoring-checker/system-prompt.expected.md
- Pinned prompt for the Office authoring header class (the standard fragment set).
### snapshots/session/office-progressive-native/session.v4.jsonl
- Four sequential skill calls (office, office-xlsx, office-recalculate, office-export-pdf) - the progressive-disclosure ladder.
### snapshots/session/office-progressive-native/snapshot.yml
- Manifest: composition office-render-tools, recording authored, header.pin true.
### snapshots/session/office-progressive-native/system-prompt.expected.md
- Pinned prompt for the Office header class.
### snapshots/session/office-progressive-native/tool-schemas.expected.json
- Pinned schema set with no bash tool, because the Office composition disables tool-bash and tool-pwsh.
### snapshots/session/office-progressive-native/workspace/render-cli.cjs
- Two-line deterministic renderer stub writing a fixed {images:[{path:'preview/page-1.png'}]} payload; real CLI output is covered by E2E.
### snapshots/session/office-progressive-ptc/session.v4.jsonl
- The same four skills reached through run_code programs, each producing a tool/ptc-dispatch with subCallId <root>:ptc:1.
### snapshots/session/office-progressive-ptc/snapshot.yml
- Manifest: composition office-render-tools-ptc, platform posix, recording authored, header.pin true.
### snapshots/session/office-progressive-ptc/system-prompt.expected.md
- **Purpose:** The PTC prompt rendered for the Office composition — the same contract, plus the fact that `bash` and `pwsh` are disabled.
- **Key abstractions:** the run_code contract; the `ToolArgsMap` / `ToolOutputMap` pair; the `declare const tools` binding.
- **Data flow:** persona → run_code-only rule → the shared fragments (read, edit, glob, grep, background jobs, untrusted web, goals, workflow, delegation) → the "Writing code for run_code" section with the declarations.
- **Non-obvious design decisions:** the declarations are the *complete* tool API for the composition, so a tool that is disabled simply has no declaration — the type surface and the advertised tool list cannot disagree, because there is only one of them.
- **Edge cases / failure handling:** `type ToolName = keyof ToolOutputMap` and `declare class ToolCallError` give the model the exact error type it can `try/catch`; the doc comment on the `workflow` tool is the tool's own description, carried verbatim.
- **Surprising:** `todo_write`'s output type includes a `counts` object (`pending` / `inProgress` / `completed`) — the tool's *result* carries a summary so a program can branch on it without re-counting the array.
### snapshots/session/office-progressive-ptc/tool-schemas.expected.json
- The single run_code tool schema.
### snapshots/session/office-progressive-ptc/workspace/render-cli.cjs
- Two-line deterministic renderer stub.
### snapshots/session/office-render-tools-ptc/cordis.snapshot.yml
- Keyless replay of the retired PTC composition, pinning ptc-runtime.launch to the workspace office-ptc-node script.
### snapshots/session/office-render-tools-ptc/cordis.yml
- Office skill plugin plus tools mode ptc.
### snapshots/session/office-render-tools-ptc/session.v4.jsonl
- The retired-tool workflow driven through run_code; the system prompt is re-emitted with surfaceOp replace after office_tools changes the tool list.
### snapshots/session/office-render-tools-ptc/snapshot.yml
- Manifest with sessionFormat {version:4, coverage:[retired-tools]} and workspace setup office-retired-ptc.
### snapshots/session/office-render-tools-ptc/workspace/render-cli.cjs
- Two-line deterministic renderer stub.
### snapshots/session/office-render-tools-ptc/writer.expected.jsonl
- **Purpose:** The PTC-mode twin of the retired-tools oracle.
- **Key abstractions:** `error: {name: "CodeRunFailedError", code: "CODE_RUN_FAILED"}`; the JS-object rendering of a tool result inside a program.
- **Data flow:** `run_code` programs calling `tools.skill(...)` (still succeeds) and `tools.office_tools(...)` / `tools.render_document(...)` (now fail) → the results are `Error: code run failed (exception): TypeError: tools.office_tools is not a function` followed by `File sandbox: danger-full-access.`
- **Non-obvious design decisions:** in PTC mode a missing tool is a *JavaScript* `TypeError` — because the tool is a function in the program's type surface, not a name — and it is wrapped as `CodeRunFailedError`. The `File sandbox: <mode>` suffix on the error is how the model learns which sandbox the program ran under.
- **Edge cases / failure handling:** the `skill` result in PTC mode is rendered as a JavaScript object literal (`{ name: 'office-xlsx', provider: 'dsh-office', resourceBase: {kind:'directory', path: '…'}, content: '…' }`) rather than the XML envelope of native mode — the same data, a different surface.
- **Surprising:** the failed call's error text includes the sandbox mode, so a program that hits a denial can see the policy that produced it without a second round-trip.
### snapshots/session/office-render-tools/cordis.snapshot.yml
- Keyless replay of the retired-tools Office composition with the skill-office row and the replay catalog.
### snapshots/session/office-render-tools/cordis.yml
- Inserts dsh-skill-office with assetRoot, node and cli pointing at the workspace stubs and disables tool-bash and tool-pwsh.
### snapshots/session/office-render-tools/session.v4.jsonl
- **Purpose:** The retained recording of the Office renderer workflow as it was, when `office_tools` and `render_document` were real tools.
- **Key abstractions:** the `office_tools` control tool (`action: "load" | "remove"`) and the `render_document` tool; `meta: {officeTools: "load"}`.
- **Data flow:** `skill` (`office-xlsx`) → `office_tools {action: "load"}` → `{"name": "render_document", "active": true}` → `render_document {input, outputDirectory, pages}` → `{"images": [{"path": "preview/page-1.png"}]}` → `office_tools {action: "remove"}` → `{"name": "render_document", "active": false}`.
- **Non-obvious design decisions:** the renderer is *mounted and unmounted* around the task — the tools are present only while they are needed, which is a tool-surface lifecycle rather than a static list. `meta.officeTools` records the mount state on the tool result so a consumer can tell which step mounted what.
- **Edge cases / failure handling:** the `remove` step is part of the recorded turn, so the fixture proves the renderer is torn down again and does not linger in the tool list.
- **Surprising:** the same directory keeps a `writer.expected.jsonl` that records what the *current* writer does with the very same calls — the old behaviour and the new refusal live side by side as a regression pair.
### snapshots/session/office-render-tools/snapshot.yml
- Manifest with sessionFormat {version:4, coverage:[retired-tools]} - the scenario deliberately keeps a historical generation.
### snapshots/session/office-render-tools/workspace/render-cli.cjs
- Two-line deterministic renderer stub.
### snapshots/session/office-render-tools/writer.expected.jsonl
- **Purpose:** The current-writer oracle for the retired-tools scenario — what the harness must produce now that the tools are gone.
- **Key abstractions:** `error: {name: "ToolNotFoundError", code: "UNKNOWN_TOOL"}`; the `tool/result` error text.
- **Data flow:** the same four calls, and now each one returns `Error: unknown tool "office_tools"` / `Error: unknown tool "render_document"` with `isError: true` and a `ToolNotFoundError`/`UNKNOWN_TOOL` code.
- **Non-obvious design decisions:** the retired generation is *never rewritten*; the corpus keeps the old fixture and adds a new one, so "the tool is gone" is a fact the harness is re-proved against on every run instead of being quietly forgotten.
- **Edge cases / failure handling:** the refusal is a structured error, not a generic failure — a consumer can distinguish "no such tool" from "the tool failed".
- **Surprising:** the `skill` call still succeeds in the oracle (the skill plugin is not retired) — only the *renderer* tools are gone, so the oracle isolates exactly the removal under test.
### snapshots/session/office-sidecar-instructions/cordis.snapshot.yml
- Keyless replay of the sidecar composition with toolUpdate: in-history on the replay models.
### snapshots/session/office-sidecar-instructions/cordis.yml
- Office skill plugin with cli:false (no renderer) and tool-bash/tool-pwsh disabled.
### snapshots/session/office-sidecar-instructions/session.v4.jsonl
- Loads office-render, office-export-pdf and office-recalculate then reads office-skills/office/references/sidecar.md, proving the skill's reference document is reachable without a renderer.
### snapshots/session/office-sidecar-instructions/snapshot.yml
- Manifest: composition office-sidecar-instructions, recording authored, header.pin true, toolSchemasSource office-progressive-native.
### snapshots/session/office-sidecar-instructions/system-prompt.expected.md
- Pinned prompt for the sidecar header class.
### snapshots/session/office-skills-no-renderer/cordis.snapshot.yml
- Keyless replay whose replay model carries defaultMaxTokens 8192, reasoningEfforts [off,low,high,max] and defaultReasoningEffort high.
### snapshots/session/office-skills-no-renderer/cordis.yml
- Office skill plugin pointed at render-cli.cjs instead of the real CLI, llm-deepseek with thinking enabled, reasoningEffort high, maxTokens 8192, and tool-bash/tool-pwsh disabled.
### snapshots/session/office-skills-no-renderer/session.v3.jsonl
- Skill-catalogue turn in format V3: the available_skills system-reminder is appended as a user message.
### snapshots/session/office-skills-no-renderer/session.v4.jsonl
- **Purpose:** The recorded proof that the skill *catalogue* is injected separately from the system prompt, and that skills can be loaded in parallel.
- **Key abstractions:** the `<system-reminder><available_skills>` block as a user message; parallel `skill` calls.
- **Data flow:** the user asks (in Chinese) whether a missing renderer blocks delivery → a `<system-reminder>` user message lists the available skills with their one-line descriptions → the model issues **three** `skill` calls (`office-docx`, `office-pptx`, `office-xlsx`) in the *same step* → the turn completes.
- **Non-obvious design decisions:** the catalogue is a *system-reminder* user message rather than part of the system prompt, so the prompt prefix stays byte-stable across skill-list changes — a change to the catalogue does not invalidate the provider's prompt cache; only the description (name + one-line trigger) is injected, and the body is loaded on demand.
- **Edge cases / failure handling:** the three skill calls are parallel, so the catalogue-to-body progressive disclosure costs one round-trip, not three.
- **Surprising:** the whole turn is in Chinese while the harness's own text is English — the corpus exercises a non-English task against English instructions.
### snapshots/session/office-skills-no-renderer/snapshot.yml
- Manifest: composition office-skills-no-renderer, recording live, header.pin true, sidecar sources named as office-skills.
### snapshots/session/office-skills/cordis.snapshot.yml
- Keyless replay of the Office skill composition with the same skill-office row and the replay catalog.
### snapshots/session/office-skills/cordis.yml
- Office skill plugin with assetRoot, node and cli; tool-bash and tool-pwsh disabled.
### snapshots/session/office-skills/session.v3.jsonl
- Skill-loading turn in format V3: the skill result is the XML skill_content envelope.
### snapshots/session/office-skills/session.v4.jsonl
- The skill tool result is a <skill_content> envelope with a <skill_resources> base directory and the skill instructions.
### snapshots/session/office-skills/snapshot.yml
- Manifest: composition office-skills, recording authored, header.pin true, workspace setup office-skills.
### snapshots/session/office-skills/system-prompt.expected.md
- Pinned prompt for the Office header class; the skill catalogue is not in the prompt but injected as a separate system-reminder message.
### snapshots/session/office-skills/tool-schemas.expected.json
- Pinned schema set with no bash and no pwsh tools.
### snapshots/session/packed-chunks/session.jsonl
- **Purpose:** The V0 recording that stores streamed deltas in *packed* rows — a storage-compression format for the transcript.
- **Key abstractions:** `reasoning-chunks` / `text-chunks` / `tool-call-chunks` rows carrying a `texts` array (or `args` array) plus a per-token `dt` delta-time array; `sourceEventSeqs` on the settled message.
- **Data flow:** the model's reasoning and tool-call arguments are written as three packed rows; the settled `assistant/message` event carries `sourceEventSeqs: [12…59]`, which is the *expanded* logical sequence the packed rows stand for.
- **Non-obvious design decisions:** the transcript stores one row per *block* rather than one row per token, with per-token timing preserved inside the row; the `sourceEventSeqs` range is what keeps the logical event sequence recoverable, so the compression is lossless at the sequence level.
- **Edge cases / failure handling:** `headless.snapshot.ts:1002-1031` decodes the packed rows with the released V0 codec and asserts that the expanded event stream normalizes to exactly the same thing as the unpacked recording — a strong losslessness test.
- **Surprising:** the V0 fixture is still *committed* and still *replayed*; `snapshot.yml` pins `sessionFormat: {version: 0, coverage: [packed-row]}` so the decoder can never rot, and `writer.expected.jsonl` shows the current V4 writer's equivalent output for the same turn.
### snapshots/session/packed-chunks/snapshot.yml
- Manifest pinning sessionFormat {version:0, coverage:[packed-row]} so the packed-row decoder stays exercised.
### snapshots/session/packed-chunks/workspace/hooks.json
- PreToolUse hook blocking bash so the packed recording has a deterministic tool result.
### snapshots/session/packed-chunks/writer.expected.jsonl
- Current-writer (V4) equivalent of the same turn, used as the oracle that the V0 packed recording still migrates correctly.

## Ideas worth stealing

- **The system prompt is assembled from per-capability fragments, and a fragment is only included when its capability is enabled.** `snapshots/session/fs-glob-sampling/system-prompt.expected.md:1` (18 tools, 23 lines) versus `snapshots/session/foreground-confinement-timeout/system-prompt.expected.md:1` (26 tools, 30 lines): diffing the two shows the goal clause, the background-job clause and the sandbox persona clause disappear exactly when the `goal` / `tool-jobs` / `sandbox` plugins are disabled in `snapshots/session/fs-glob-sampling/cordis.yml:32-62`. **Why it matters for August:** the prompt stops lying about what the model can do, which is the cheapest possible defence against a model calling a tool it was never offered — and it keeps the prefix short for cheap local models. August's `toolSurface` (full/reduced/bare) is the same idea but currently expressed as a tool *filter*; the DSH version also filters the *instructions*.

- **Program-tool-call (PTC): one model round-trip, many real tool calls, each individually auditable.** `snapshots/session/mcp-empty-ptc/session.v4.jsonl:16-24` records a single `run_code` call that awaits two `tools.bash(...)` calls; each sub-call gets its own `tool/ptc-dispatch-start` → `job/registered` → `job/settled` → `tool/ptc-dispatch` quartet, and the sub-call id is `<rootCallId>:ptc:<n>` with `rootCallId`/`parentCallId` on every event. **Why it matters:** this collapses N model round-trips into 1, which is the single biggest lever on a cheap-model harness — but it keeps a per-tool audit trail, so nothing is hidden behind "the program did it". August's subagents would benefit directly, and the `rootCallId` field is the join key you need to attribute a failure back to the model request that caused it.

- **Oversized tool results: keep the text ENDS, drop images that fall in the middle, and hand the model a file locator.** `snapshots/session/multimodal-spill-middle/session.v4.jsonl:17` ends with `(Omitted 12308 bytes. Omitted 1 images. Full formatted result stored at: /tmp/…/…-mcp__fixture__inspect.txt. Use read with offset/limit, or grep this path to search within it.)`; the twin `snapshots/session/multimodal-spill-ends/session.v4.jsonl:17` keeps the images (because they sit near the ends) and omits only 18 108 bytes of the middle text. The threshold is a plugin config, `maxInlineTokens: 1000` at `snapshots/session/multimodal-spill-ends/cordis.yml:36`. **Why it matters:** this is a context-window management policy that is *lossless in the parts that matter* (the head and tail of a result) and *explicit about what it dropped*; the "Omitted N images" wording tells the model that an image existed rather than silently hiding it. August currently truncates tool output to its tail — this is strictly better.

- **Images become content-addressed attachments, never inline base64.** `snapshots/session/multimodal-spill-ends/session.v4.jsonl:17` stores `{type: "image", attachment: {attachmentId: "sha256:999f1d15…", mediaType: "image/png", width: 1, height: 1, bytes: 90}}` and the MCP resource path refuses to write base64 at all (`snapshots/session/headless.snapshot.ts:728` asserts the transcript does not contain the base64 blob). **Why it matters:** the transcript stays small, the same image referenced twice costs nothing, and the attachment id is a stable key for a UI cache — August's multimodal path would get dedupe and persistence for free.

- **A tool result carries a machine-readable `meta` beside the human-readable text.** `snapshots/session/fs-read/session.v4.jsonl:17` (`{path, offset, lines:[{number,text}], totalLines}`), `snapshots/session/fs-glob-sampling/session.v4.jsonl:17` (`{shape: "paths", paths, truncated, total}`), `snapshots/session/fs-write-overwrite/session.v4.jsonl:22` (`{operation, path, diffs:[{path, oldText, newText}]}`), `snapshots/session/office-render-tools/session.v4.jsonl:24` (`{officeTools: "load"}`). **Why it matters:** August's UI re-parses tool *text* to build cards; a structured `meta` beside the text removes a whole class of brittle string parsing, and it is what lets a "Showing 4 of 8 paths" banner and a diff view share one transport.

- **A `PostToolUse` hook can REPLACE a successful tool result with its own message, and the replacement is marked as an error.** `snapshots/session/hook-cc-posttool-block/session.v4.jsonl:19-21`: the `bash` ran and succeeded, the hook blocked, and the persisted result is `tool output rejected by policy: retry once` with `isError: true` — the model never sees the original output. **Why it matters:** this is output *redaction at the boundary*, which is exactly where August's "the outbound body is scrubbed of this install's own credentials" rule wants to live, and it works for any policy that must not merely annotate but suppress.

- **A `Stop` hook can continue the turn by injecting a durable user-role message through the inbox.** `snapshots/session/hook-cc-stop-continue/session.v4.jsonl:17-26`: the `Stop` hook blocks, the text is spliced in through two `agent/inbox/spliced` events and becomes a `user/message` with `source: {kind: "hooks-claude-code"}`, a second step runs, and the `Stop` hook is re-invoked with an incremented `handlerId` (`:1` → `:2`) and passes. **Why it matters:** "the model forgot to do X, run it again" is a general agent-loop need; August currently answers it with a self-correction nudge that is runtime-only and not persisted. This version is *durable and visible in the transcript*.

- **A model switch leaves a durable, human-readable notice in the transcript and starts a new request series.** `snapshots/session/model-switch-notice/session.v4.jsonl:21-23`: the system message is re-emitted with `surfaceOp: {op: "replace", startSeq: 7, endSeq: 7}` (so the prompt is not duplicated), a `user/message` with `source: {kind: "model-selection", form: "notice", summary: "deepseek-v4-flash → deepseek-v4-pro"}` carries `[model changed: assistant turns above this point were generated by deepseek-v4-flash; the session continues with deepseek-v4-pro]`, and the next `request/header` has `reason: "change"` and `startsSeries: true`. **Why it matters:** when August falls back from a strong model to a cheap one mid-turn, the transcript must say so — otherwise the user cannot tell which half of the answer came from which model, and the cheap model has no idea it is continuing someone else's work.

- **Ask-with-no-answerer fails closed, and the ask/answer round-trip is its own recorded events.** `snapshots/session/hook-cc-pretool-ask/session.v4.jsonl:19-21`: `approval/asked` (tool name, call id, reason) → `approval/decided` (`outcome: "rejected"`) → the tool result is `Error: the user rejected tool "bash"` with `isError: true`. **Why it matters:** August's approval policy says "without an available answerer, the request fails closed" but does not record the *ask* separately from the *decision*; having them as separate durable events is what lets a UI show "August wanted to run X" and an audit answer "who said no".

- **Per-model capability declarations drive a hard gate, not just a hint.** `snapshots/session/multimodal-spill-ends/cordis.snapshot.yml:43-48` declares `inputModalities: [text]` for the text models and `inputModalities: [text, image]` + `imageRequestTokens: 169` for the vision model; the comment above it says the "strict read_image gate" accepts the route only because the replay catalog declares image input. **Why it matters:** August's "model-specific adaptations and fallbacks" currently live in ad-hoc places; a declared `inputModalities` list makes "this model cannot see images" a fact the tool layer can enforce instead of a comment.

- **The recorded transcript is the oracle for a retired tool.** `snapshots/session/office-render-tools/session.v4.jsonl:24` records the *old* behaviour (`office_tools` → `{"name":"render_document","active":true}`) and `snapshots/session/office-render-tools/writer.expected.jsonl:24` records what the *current* writer does (`Error: unknown tool "office_tools"`, `error.code: "UNKNOWN_TOOL"`); `snapshot.yml` declares `sessionFormat: {version: 4, coverage: [retired-tools]}` so the old generation is never rewritten. **Why it matters:** a "retired tools" corpus is the only way to keep proving that a removed capability still fails *cleanly* instead of half-working; August has exactly this problem with `update_agent`/`delete_agent`/verifier endpoints and could adopt the same "retained generation + current-writer oracle" pair.

- **The transcript is stored compactly (packed chunk rows) but the logical event sequence stays recoverable.** `snapshots/session/packed-chunks/session.jsonl:15` stores a whole reasoning block as one row with a `texts` array and a per-token `dt` array, and the `assistant/message` event records `sourceEventSeqs: [12…59]`; `snapshots/session/headless.snapshot.ts:1002-1031` decodes the packed rows with the released V0 codec and asserts they are *logically equal* to the unpacked recording. **Why it matters:** August's transcript persistence writes one row per streamed token; a packed row with a per-token delta-time array would cut the persisted size by an order of magnitude while keeping the UI's timing data — and the equality test is a rigorous way to prove the compression is lossless.

- **The recorded session is a normalization fixed point, so identities become typed tokens and prompts/schemas leave the transcript.** `snapshots/session/headless.snapshot.ts:989-1000` asserts that re-running the redaction over a committed fixture changes nothing, that no fixture still contains a system prompt or a tool schema, and that no scenario has an `input.json` or an `stdout.expected.jsonl`; the fixture files themselves use `{{session:1}}`, `{{message:4}}`, `{{id:1}}`, `{{cwd}}`, `{{tools}}`, `{{system}}`. **Why it matters:** this is how you make a golden-transcript corpus diffable and machine-checkable across machines. August's `check:*` gates are all static checks; a normalization-fixed-point corpus would give it a *behavioural* gate that is still diffable.

- **The prompt declares what a tool result is allowed to contain, so an output shape is a contract.** `snapshots/session/office-progressive-ptc/system-prompt.expected.md:38-41` tells the model that a failed call rejects with `ToolCallError` (with `toolName` and a human-readable `message`), that independent *read-only* calls may overlap under `Promise.all` while mutating calls run alone in submission order, and that "every other intermediate result stays out of the conversation, so extract just what you need". **Why it matters:** August's tool-call reliability story is about the *executor*; this is the model-side contract that makes a compound call safe, and the read-only/mutating split is exactly the distinction August's "five policy/secret checks" already tries to make.

## Files skipped (with reasons)

- None. All 255 files in this shard were opened and read. The largest single file, `snapshots/session/headless.snapshot.ts` (71 527 bytes, 1 456 lines), was read in full across four passes. The large `tool-schemas.expected.json` sidecars (up to 28 KB) were read as JSON-schema text: for `mcp-resources/tool-schemas.expected.json` and `mcp-resources-ptc/tool-schemas.expected.json` I read the complete `initial` array and the full `ToolOutputMap` declaration; for `office-progressive-native/tool-schemas.expected.json`, `office-skills/tool-schemas.expected.json`, `lsp-definition/tool-schemas.expected.json`, `foreground-confinement-timeout/tool-schemas.expected.json`, `fs-glob-sampling/tool-schemas.expected.json` and `multimodal-spill-ends/tool-schemas.expected.json` I read the complete tool-name list and the full description and parameter block of each distinct tool. The `office-render-tools/writer.expected.jsonl` (21 254 bytes) and `office-render-tools-ptc/writer.expected.jsonl` (28 866 bytes) were read line-by-line for every event row; their content is the same skill/renderer sequence already read in full from the sibling `session.v4.jsonl` files.

## Uncertainties

- **The session-format migration is inferred from the fixtures, not from the codec.** I established the v2→v3→v4 differences by reading the fixtures side by side (v2 carries the system prompt inside `request/header.system` and has no `system/message` event; v3 adds `system/message` with `source.kind: "plugin"`; v4 uses `source.kind: "system-prompt"`, native `role: "tool"` results, and adds `job/registered` / `job/settled` events). I did **not** read `packages/session-format*` or `@deepseek-ai/dsh-session-format-v0-to-v1` (not in this shard), so I cannot state the authoritative migration rules — only that the fixtures are consistent with the differences above. The one place I saw the migration rules quoted verbatim is `snapshots/session/AGENTS.md:9` (which says the corpus policy requires V3 inputs for direct upgrade coverage and explicit V0–V2 migration coverage).
- **I did not verify the `dt` (delta-time) semantics of the packed chunk rows.** `snapshots/session/packed-chunks/session.jsonl:15` shows `dt` as a per-token array of integers that is almost always `0` with one `1` in it; I could not establish from this shard whether `dt` is milliseconds, a tick count, or a "this token was slow" flag. I checked `snapshots/session/headless.snapshot.ts:1019-1024`, which decodes the packed rows and compares the *expanded* event stream, so the values themselves are not asserted anywhere in the files I read.
- **The `hook/*` decision vocabulary is only partly observable.** I saw `pass`, `block` and `ask` (`snapshots/session/hook-cc-pretool-ask/session.v4.jsonl:18`). I did not find a fixture for a `deny` decision distinct from `block`, nor for hook *timeouts* or a hook that crashes, so I cannot say what the harness does with a hook that neither exits 0 nor 2.
- **The invalid-matcher behaviour is fail-open, and I could not determine whether that is deliberate.** `snapshots/session/hook-cc-invalid-matcher/session.v4.jsonl` and `snapshots/session/hook-codex-invalid-matcher/session.v4.jsonl` contain **no** `hook/*` events at all — the handler with the invalid regex `[` is simply not invoked and the turn completes normally. Whether the matcher is compiled once at load and silently skipped, or rejected with a warning that is not persisted, is not visible in any file in this shard. I flag it because a security hook that fails open on a typo is the kind of thing August should check for explicitly.
- **The MCP resource instruction block is server-supplied text injected into the system prompt** (`snapshots/session/mcp-resources/system-prompt.expected.md`, `## MCP resource servers` → `MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal. Read resources from the catalog server.`). I could not tell from this shard whether that text is escaped, length-limited, or attributed to an untrusted source in the model-facing prompt. The `{{braces}}` literal-preservation test suggests the harness is at least aware that the server's text can contain template-like syntax.
- **The `spill-policy` / `attachment-local` / `spill-local` plugins themselves are not in this shard** — only their configuration rows are. I know `maxInlineTokens: 1000` is the inline budget and that the spill root is `DSH_SNAPSHOT_SPILL_ROOT`, but I could not read the plugin to confirm whether the budget is measured in tokens or in a token estimate, nor how the spill file name (`<hash>-<toolname>.txt`) is derived.
- **`fs-glob-sampling`'s sampling claim is asserted by the fixture, not by code I read.** The tool result says the sample was taken "across 4 of the 6 top-level entries … instead of taken in modification-time order"; the config is `sampleOverCapGlobResults: true` / `globMaxResults: 4` at `snapshots/session/fs-glob-sampling/cordis.yml:67-68`. I did not read the `dsh-tool-fs-search` implementation, so I take the diversity claim from the recorded output.
- **Two recorded model failures are visible and I could not tell whether the harness notices them.** In `snapshots/session/fs-policy-reject/session.v4.jsonl` the model is refused twice with `FS_NOT_OBSERVED` and then asserts "The replacement was successful" and answers `DONE`; the workspace oracle (`workspace.expected/settings.txt`, unchanged) proves the edit never landed, so the *harness* is right and the *model* is wrong. There is no recorded event marking this as a failure — the turn ends `completed`. Whether DSH has a separate check for "the model claimed success against a failed tool result" is outside this shard.
- **`meta.path` changed shape between V3 and V4** (relative in V3, absolute in V4 for `fs-edit`). I observed this in the fixtures but did not read the migration code, so I cannot say whether the change was deliberate or a side effect of the migration.
- **I did not read `snapshots/session/AGENTS.md` as part of the shard** — I read it (17 lines) for context, but it is not in my shard, so it appears in no ledger row; the manifest policy it references (`scripts/session-snapshot-corpus-policy.ts`) is likewise outside this shard.
