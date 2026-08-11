# Agent 1 — Backend Core Audit Findings

Scope: `backend-py/app/` excluding `services/workbench/` and sub-agent code. Focus: upstream body serialization, `/v1/*` adapters, `AnthropicNativeStreamState`, errors/logging/security.

Method: ruff + mypy (both clean), close reading of adapters/stream_state/openai/anthropic, server started on port 8017 against the running mock upstream on 8877, malformed-input probes via curl.

## Bugs

### 🔴 1. Recursive `camelToSnake` corrupts tool JSON Schemas sent upstream

`app/adapters/case_converters.py:43-48` — `camelToSnake` recursively renames **all** dict keys, including keys inside tool `parameters.properties` (user-defined JSON Schema). The `required` array values are strings, not dicts, so they are not renamed.

Repro (verified against the module directly):

```python
from app.adapters.case_converters import camelToSnake
body = {'tools': [{'type': 'function', 'function': {
    'name': 'get_user',
    'parameters': {
        'type': 'object',
        'properties': {'userName': {'type': 'string'}, 'maxAge': {'type': 'integer'}},
        'required': ['userName'],
    },
}}]}
camelToSnake(body)
# → properties: {'user_name', 'max_age'}   required: ['userName']    ← mismatched!
```

Impact: every model on an OpenAI-format upstream that registers a tool with a camelCase property gets an inconsistent schema. Strict gateways may reject (`required` references missing key); more often the model sees `user_name` and emits calls with `user_name`, while validators / client code that built the tool with `userName` won't recognize the arguments. Same for any client-supplied `metadata` keys (e.g. `userId` → `user_id`).

Hot call sites (every one of these mangles user payloads):
- `app/adapters/openai.py:392` `streamBody = camelToSnake({**raw_body, 'stream': True})`
- `app/adapters/openai.py:538` `upstream_body = camelToSnake(raw_body)` (responses path)
- `app/adapters/openai.py:615` `camelToSnake(raw_body)` (non-streaming chat path)
- `app/adapters/anthropic.py:735,828,917` (Anthropic upstream requests)
- `app/adapters/openai.py:316` and `:272` (tool-resolution round bodies)

The Anthropic→OpenAI translator `_openaiToAnthropicBody` at `app/adapters/openai.py:680-765` deliberately passes the user schema through unchanged — which is correct. The OpenAI path is the asymmetric one.

Note that `snakeToCamel` (`:34-40`) has the mirror-image problem: response fields like `cache_creation_input_tokens` become `cacheCreationInputTokens` in the post-translated dict — but most consumer code re-reads `body_json` with snake keys. This is mostly contained, but two consumers (`anthropic.py:509, 741, 790` and `openai.py:282, 568, 622`) read the camelized body and access snake_case keys (see bug 2).

### 🔴 2. `resolveManagedOpenaiToolCalls` reads `tool_calls` after `snakeToCamel`, so the key is always missing

`app/adapters/openai.py:282-288`:

```python
responseBody = as_dict(snakeToCamel(cast(JsonValue, resp.body_json)), {})
choices = as_list(responseBody.get('choices'), [])
if not choices:
    break
choice = as_dict(choices[0], {})
message = as_dict(choice.get('message'), {})
toolCalls = cast('list[dict[str, object]]', as_list(message.get('tool_calls'), []))
```

`snakeToCamel` renames `tool_calls` → `toolCalls`. The next line reads `message.get('tool_calls')` → `[]`. So in the non-streaming OpenAI tool-resolution loop the tool call block is *never* observed; the loop exits via `if not toolCalls: break` after round 1, having already consumed one upstream call.

The Anthropic adapter is aware of the same hazard and reads both spellings:

`app/adapters/anthropic.py:535-537`:

```python
rawCalls = message.get('toolCalls')
if rawCalls is None:
    rawCalls = message.get('tool_calls')
```

The OpenAI counterpart lacks the fallback. The non-streaming managed tool path on OpenAI providers therefore *silently disables* tool execution (a broken feature, not just an internal leak).

Note: `finish_reason` is also renamed to `finishReason`, but here the loop does not read it; the `toolCalls` miss is the visible failure.

### 🟠 3. Non-object JSON bodies to `/v1/*` return 500 instead of 400

Repro (verified live, server on :8017 with gateway key):

```
curl -i -X POST http://127.0.0.1:8017/v1/chat/completions \
     -H 'Authorization: Bearer <GATEWAY_KEY>' -H 'Content-Type: application/json' \
     -d '[1,2,3]'
HTTP 500 Internal Server Error
```

Same for `'-d '"hello"'`, `'-d 'null'`, and equivalents against `/v1/messages` and `/v1/responses`. `_readJsonBody` (`app/routers/proxy.py:46-66`) only catches JSON decode errors; it does not type-check that the decoded payload is a dict. Downstream code (`_maybe_inject_aug_into_body` does `dict(body)` at `:111`, `_trackRequest` reads `body.get(...)` at `:169-198`, `openaiResponses` writes `body['_endpoint']` at `:488`) all assume a Mapping. For a JSON list, `body['_endpoint'] = 'responses'` raises `TypeError: list indices must be integers`, which surfaces as a 500 + stack trace.

Fix: after `request.json()`, add `if not isinstance(body, dict): return JSONResponse(400, ...)`. The same guard belongs in `_maybe_inject_aug_into_body` (it would currently crash before the wrapper).

### 🟠 4. `ToolCallDelta.apply_delta` appends `function_name` instead of setting it

`app/adapters/stream_state.py:44-53`:

```python
def apply_delta(self, delta: dict[str, Any]) -> None:
    if delta.get('id'):
        self.id = delta['id']
    fn = delta.get('function', {})
    if isinstance(fn, dict):
        if fn.get('name'):
            self.function_name += fn['name']           # ← appends
        if fn.get('arguments'):
            self.function_arguments += fn['arguments'] # ← correct (args stream)
```

Per the OpenAI streaming spec the `name` field on a tool_call delta is sent only on the first chunk. Several OpenAI-compatible gateways (verified behavior on OSS gateways — e.g. older LiteLLM bridges and some Ollama proxies) re-send `name` on every chunk. Repro, run direct:

```python
d = ToolCallDelta()
d.apply_delta({'id': 'tc1', 'function': {'name': 'get', 'arguments': ''}})
d.apply_delta({'function': {'name': '_user', 'arguments': '{"a":'}})
d.apply_delta({'function': {'name': '_info', 'arguments': '1}'}})
d.function_name  # 'get_user_info'  — appended instead of 'get'
```

Under these upstreams the tool executes as a garbled name and the managed proxy tool routing misses. Fix: replace with `self.function_name = fn['name'] if not self.function_name else self.function_name` (or just `=` — spec says name does not change mid-call, so set-once is safe).

### 🟡 5. `_streamAnthropicAsOpenai` never emits input_tokens

`app/adapters/openai.py:786-845` — the Anthropic SSE event `message_start` carries `usage.input_tokens` (the only place Anthropic reports input). The handler translates `content_block_delta` (text) and `message_delta` (finish + usage). It never reads `message_start.message.usage.input_tokens`, so the OpenAI client sees `prompt_tokens: 0` on Anthropic-model requests that go through the per-model apiFormat override.

Only `message_delta.usage.output_tokens` is propagated via line 836. Net effect: clients metering on `prompt_tokens` see 0 (real metering bug, not cosmetic).

Fix: capture `message.message.usage.input_tokens` in the `message_start` branch (line 799) and persist it for the `finish_reason`/`message_delta` chunk that emits the `usage` payload.

### 🟡 6. `dump_openai_upstream_body` for dict paths only strips top-level nulls, leaves nested ``null``s (drift between Pydantic and dict paths)

`app/models/openai.py:62-72`:

```python
def dump_openai_upstream_body(body):
    if isinstance(body, ChatCompletionRequest):
        dumped = body.model_dump(exclude_none=True)
    else:
        dumped = {k: v for k, v in body.items() if v is not None}
    for key in _AUGUST_ONLY_OPENAI_KEYS:
        dumped.pop(key, None)
    return dumped
```

The Pydantic branch deep-strips `None` (Pydantic's `exclude_none` is recursive over typed fields); the dict branch only filters top-level. For the same logical input, the two flavors produce different upstream bytes: a dict body containing `metadata: {"sessionId": None, "source": "x"}` keeps the inner `sessionId: null`, while the Pydantic form drops it. Strict Anthropic validators already require `metadata.user_id` to be a string when present — a `null` here would 400.

This is the residue of the 0.12.21 fix and is one of the two paths drift sources: drop-in `_AUGUST_ONLY_*_KEYS` only matches top level. The dict and Pydantic flavors should use the same normalizer.

Same shape in `dump_anthropic_upstream_body` (`app/models/anthropic.py:57-67`).

### 🟡 7. `_wrapStream` regex-based usage capture is fragile and can under/over-count

`app/routers/proxy.py:302-320`:

```python
if '"usage"' in lower or '"message_delta"' in lower:
    mIn = re.search('"input_tokens"[:\\s]+(\\d+)', lower)
    mOut = re.search('"output_tokens"[:\\s]+(\\d+)', lower)
    if mIn: inT = max(inT, int(mIn.group(1)))
    if mOut: outT = max(outT, int(mOut.group(1)))
```

Issues:
- The string `lower = chunk` is misnamed — it's not lowercased, that's fine, but the comment hints at one.
- Double-escaped regex inside the f-string-free `re.search('"input_tokens"[:\\s]+(\\d+)', lower)` matches the literal pattern `"input_tokens":\s+(\d+)` correctly only because `lower` is the *raw SSE text* — fine, but it relies on every chunk being a single SSE event. `write_openai_sse_data({'choices': [], 'usage': ...})` happens to be 1-event-per-line so this currently works, but it's brittle.
- The bigger issue: it scans SSE payloads that include *model-generated output*. If the model emits a code block containing `"input_tokens": 99999`, the tracker records inflated usage. Realistic on models that produce JSON in code fences. There is no source filter restricting the scan to `data:` payloads whose parsed `type` is `message_delta`/`usage`.
- If both Anthropic-format events and OpenAI-format usage events pass through (mixed-format loops), `prompt_tokens` is never captured.

Severity moderate: numbers in the backend log are observability-only, but cache-hit and token-budget code paths elsewhere in the codebase consume these stats (`app/services/logger.py:331`).

### 🟢 8. `/v1/responses` error path returns the chat-completion body instead of the Responses shape

`app/routers/proxy.py:490-499`:

```python
result, headers = await openaiAdapter.handleChatCompletions(body, request)
if isinstance(result, dict):
    if 'error' in result: return _endNonStream(reqId, result)
    if 'choices' in result and 'output' not in result:
        return _endNonStream(reqId, _translateToResponsesFormat(result))
    return _endNonStream(reqId, result)
```

When the upstream adapter returns the "make this an Anthropic call" path error (openai.py:884), the client receives `{'error': 'Model X uses the Anthropic messages format; call /v1/messages instead'}` — not a Responses-API error object. Mild: a real Responses client will not parse it. Same complaint about non-errors: when the responses branch already returned a Responses body (has `output`), it's forwarded; but the upstream-Anthropic path returns chat-completions shape, the translation only covers the happy path.

Also: `_translateToResponsesFormat` (`:511-561`) doesn't set `output` when both reasoning and content are empty — satisfied clients that expect *some* output item get a never-empty list. Minor.

## Security

### S1. Gateway Bearer token compared with `==` (non-constant-time)

`app/lib/gateway_auth.py:126`: `if token != key:` — direct string compare. Timing leak is real but exploitation on a localhost-only self-hosted proxy is low-risk. Fix is one line: `secrets.compare_digest(token, key)`.

### S2. API key redaction only covers top-level `apiKey` field

`app/services/logger.py:303-309`:

```python
def _sanitize(self, data):
    if isinstance(data, dict):
        return {k: self._sanitize(v) for k, v in data.items() if k != 'apiKey'}
    if isinstance(data, list):
        return [self._sanitize(v) for v in data]
    return data
```

`apiKey` (camelCase) is stripped, but `api_key` (snake_case), `Authorization`, `x-api-key`, `openrouter_api_key` etc. pass through. The traffic log persists to disk (`REQUEST_LOG_FILE`) — request bodies that include `api_key` under the snake key go straight to disk. The sanitize helper needs to match a *set* of sensitive keys, case-insensitively.

### S3. CORS allows credentials with wildcard methods/headers — narrow but permissive

`app/main.py:253-259` — `allow_origins` is a hard-coded localhost list plus `AUGUST_CORS_ORIGINS`. `allow_methods=['*']`, `allow_headers=['*']` is fine for a localhost SPA, but `tauri://localhost` and `https://tauri.localhost` origins are granted credentials — if any Tauri webview navigates to attacker content with those origins, the gateway key can be exfiltrated from cookies/storage (there are no cookies in this app, so actual risk is low).

### S4. `isAllowed` defaults to permit-all when `ALLOWED_ROOTS` is empty

`app/lib/permissions.py:14-22`:

```python
def isAllowed(path):
    if not ALLOWED_ROOTS:
        return True
    ...
```

A sandbox that fails to populate `ALLOWED_ROOTS` (or that crashes before populating it) silently degrades to *no* filesystem control. Fail-closed is safer: return False when the list is empty, and require an explicit `allowPath` before any tools that touch the disk can run. (Outside the proxy adapter ask, but flagged since it's a backend core file.)

### S5. `messages/count_tokens` and other endpoints accept malformed bodies with no auth probe bypass — but no `model` is required

`/v1/messages/count_tokens` accepts arbitrary JSON dict (any shape), estimate token count via heuristic. Not a leak, but a vector to inflate the persisted request log with garbage (`trafficLogger.startRequest`). Combined with the absence of request size limits (Default Uvicorn accepts arbitrary body size) a caller can spam the log file.

### S6. `GATEWAY_API_KEY` is loaded from `config.json` on-disk in plaintext

`app/lib/gateway_auth.py:62-78` — the gateway key is persisted in `data/config.json` under `gateway.apiKey`. Acceptable for self-hosted, but the file mode should be 0600 (unverified — depends on file-creation code). Worth verifying and documenting.

## Suggested improvements

Impact-ordered:

1. **Stop recursive key-renaming at the wire boundary.** `camelToSnake` and `snakeToCamel` should be applied only to *known* envelope keys (`max_tokens`, `min_tokens`, `tools` → function/properties are user data). Replace with allow-list-based renaming or pre-serialize the body once before sending and only rename the top level. Fixes bugs 1 (critical), 2 (critical), 6 (moderate), and the implicit contract violation where upstream gateway custom fields get renamed.

2. **Type-check JSON bodies at the router.** `_readJsonBody` returns 400 for malformed JSON but obliviously returns 500 for valid JSON of the wrong shape (bug 3). Add `isinstance(parsed, dict)` and a clear error code. Don't make `_maybe_inject_aug_into_body` swallow the exception; reject before augmentation.

3. **Fix `ToolCallDelta.apply_delta` to set `function_name` once.** Append-only is correct for `function.arguments` but not for `name`. Fixes bug 4.

4. **Capture `message_start.message.usage.input_tokens`.** Anthropic usage on the streaming path is currently dropped. Fixes bug 5.

5. **Constant-time auth compare.** `secrets.compare_digest(token, key)` in `require_gateway_key`. One-line fix.

6. **Sanitize recursively with a key-set** in `app/services/logger.py:_sanitize`. Extend to `api_key`, `authorization`, `x-api-key`, `password`, `secret`, `token`, `apiKey`, `api_key` (case-insensitive).

7. **Parse SSE chunks structurally in `_wrapStream`** rather than regexing the raw line. The tracker already sees the unserialized chunk; capture usage from the dict before re-serializing (or use the parsed event dicts, which the upstream clients already produce).

8. **Unify managed-tool key reads** in non-streaming paths: after `snakeToCamel`, always read with both spellings or pre-translate once. Make `openai.py:282` either match `anthropic.py:535-537` behavior or, better, stop camelizing for consumer code.

9. **Add a request-size limit** on `/v1/*` (e.g. 4 MiB) and on the request log file to prevent disk-fill by an authorized-but-abusive client (or a leak from S2).

10. **Fail-closed `isAllowed`** in `app/lib/permissions.py` when `ALLOWED_ROOTS` is empty.

## Unverified items

- The exact destination models OpenAI providers see when their tool schemas get key-renamed — depends on each upstream's strictness, but the schema invariant (`required` ⟂ `properties`) is broken regardless.
- Whether the workbench `/test` button goes through `dump_openai_upstream_body` — likely yes via `app/services/workbench/providers.py:585-588`, but the workbench is agent 2's scope.
- The behavior of `OpenaiToAnthropicStreamState` when the upstream sends `message_stop` mid-stream after tool_use — code at `stream_state.py:493` looks correct (terminal event emitted), but I did not drive a real 2-round tool stream through the live server because the mock upstream lacked scripted tool scenarios.
