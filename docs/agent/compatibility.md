# Upstream compatibility ledger

This is the registry for host code that compensates for an upstream provider,
wire format, model or SDK behaviour. It is not a bug list: each entry names the
owner, the observed failure, the workaround, how to verify it still works, and
what would let us delete it.

Read this before changing provider serialization, tool-argument parsing, or a
retry policy. When an upstream version changes, re-check the entry against the
installed implementation and the named probe — release notes are not evidence.

## Rules

- A new workaround adds an entry here in the same change as the code.
- An entry that no longer reproduces is deleted with its workaround; do not keep
  a compatibility layer as a habit.
- A parity test that fails after an upstream bump is evidence of drift, not
  permission to weaken the test.
- A product policy (a wait ceiling, a sandbox rule, a memory scope) is **not** an
  upstream compatibility entry. It belongs in the owning area file and does not
  disappear when the provider changes.

## Open entries

### Strict OpenAI-compatible gateways reject null fields

**Owner:** [providers.md](providers.md), `backend-py/app/models/openai.py`
(`dump_openai_upstream_body`), `backend-py/app/services/workbench/providers.py`.

**Symptom:** OpenCode Console and other strict gateways Zod-reject a request
carrying `session_id: null` (or another optional field serialized as `null`) with
`400 Invalid input: expected string, received null`. Loose gateways often accept
the same body, so a model can work on one provider and fail on another.

**Workaround:** the upstream body dump uses `exclude_none` and strips
August-only keys before dispatch. The same dump is used by workbench chat, the
model Test button and the `/v1` proxy adapters, so there is one serialization
policy.

**Verify:** send one chat with the provider's model and no session id, then one
with a session id. Both must reach the provider without a null-field 400. The
failure is a request-body assertion, not a model answer.

**Removal gate:** every supported gateway accepts `null` for the optional
fields and no August-only field reaches the wire. Re-check the installed dump
and one strict gateway, not just the release notes.

### One provider can serve different wire formats per model

**Owner:** [providers.md](providers.md), the per-model `apiFormat` override.

**Symptom:** OpenCode Zen lists Claude, GPT and DeepSeek models under one
provider, but each family needs a different leaf (`/v1/messages`,
`/chat/completions`, `/responses`). A provider-level format cannot serve all
three, and inventing `/v1` on a base URL breaks gateways that already include it.

**Workaround:** a model entry may carry its own `apiFormat`; the override wins
over the provider format and is honored by chat, Test, Live/BTW and the proxy
adapters. Base URLs stay exactly as pasted.

**Verify:** the model Test button for one model of each family; then one proxy
request through `/v1/chat/completions` for a Claude model. A wrong leaf fails
before generation.

**Removal gate:** the provider exposes one wire format for the catalog, or its
`/models` response names the leaf per model and August can read it. Do not
remove the per-model override while the catalog still mixes families.

### Raw backslashes in model-written tool JSON

**Owner:** [harness.md](harness.md), `backend-py/app/services/workbench/json_salvage.py`
(`parse_tool_arguments`), and the four stream accumulators that route through it.

**Symptom:** a model writes a Windows path as `"C:\Users\me\file"` in a tool
argument. That is not valid JSON, so a bare `json.loads` either fails the call or
silently executes `{}`; the same model can succeed on one wire and fail on
another depending on which accumulator parsed it.

**Workaround:** one parse door: strict parse → per-string-literal escape repair →
`{'_raw': text}`, which the loop reports as a `[Validation Error] … Do NOT stop`
self-heal instead of executing a phantom argument-less call. The repair is
decided per string literal; a body whose escapes are all valid (the common
`write_file` `content` with real `\n` escapes) is left alone. Stated limit:
`C:\new\file` is a valid JSON escape and stays a newline.

**Verify:** drive the same model through the Anthropic-native and OpenAI paths
with a path argument written with one backslash; both must reach the same
self-heal or execution verdict. Then send a `write_file` with real `\n` escapes
and confirm the file does not contain literal two-character backslash-ns.

**Removal gate:** every supported model emits valid JSON escapes on every wire,
or the wire/parser repairs the value before August sees it. There is no version
number for model behaviour; re-check with the same probe after a model change.

## Not compatibility entries

These are deliberate host policy and stay even if an upstream changes:

- **A server-requested wait above the ceiling is refused, not slept**
  (`_retryWaitRefusalMs`). The provider may legitimately ask for an hour; the
  turn cannot spend it frozen, so the refusal is a product decision, not a
  workaround to delete.
- **MCP tools are treated as mutating for the guard axes.** A server can write
  or drive a device; the conservative classification is August's, not the
  provider's.
- **The memory store is SQLite `facts` and the markdown mirror is one-way.**
  That is the memory contract, not a serialization workaround.
