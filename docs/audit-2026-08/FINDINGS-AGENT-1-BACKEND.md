# Agent 1 — Backend Audit Findings (proxy adapters, workbench, security)

**Scope:** `backend-py/app/` — proxy adapters, managed tool loops, sandbox, verifier, code runner.
**Status:** all items landed & green (ruff/mypy/pytest) in `d1938423` + follow-up batches. B2 was pre-fixed by the same audit pass; the remaining Phase-0 items shipped with this doc.

---

## 🔴 Critical

### C1 — Non-streaming `/v1/chat/completions` managed-tool loop never detects tool calls (casing bug)
`app/adapters/openai.py` `resolveManagedOpenaiToolCalls`: the response body is run through
`snakeToCamel` (`tool_calls` → `toolCalls`), then the loop read `message.get('tool_calls')` → `None` →
exit before executing ANY managed tool; the client received an empty response with tool calls
silently dropped. Zero test references existed.
**Fix:** read `toolCalls` with a `tool_calls` fallback (caller + `_translateToResponsesFormat` too).
Regression tests: `TestManagedOpenaiToolCallCasing` (execution + passthrough preservation).

## 🟠 High

- **H1 — Streaming OpenAI→Anthropic appends bare `tool_result` blocks (no `role`)** (`anthropic.py`): round-2
  tool results were silently skipped by `translateMessages` → stale tool re-invoked forever.
  **Fix:** wrap via `_toolResultBlockMessage`; `TestManagedToolRound2Body` covers both upstreams.
- **H2 — Code-mode hardline bypass** (`code_runner.py`): the child's `run_command`/`read_file` shelled out
  directly — credential files (`providers.json`, `.aws/credentials`) were readable in Full Access.
  **Fix:** hardline guard rendered from the LIVE `hardline.py` patterns into every code run + parity corpus
  (`tests/test_code_runner_hardline.py`).
- **H3 — `message_stop` emitted between managed-tool rounds**: Anthropic SDK clients finalize on
  `message_stop` and dropped round-2 events. **Fix:** the terminal stop is buffered per round and flushed
  only when the loop actually ends (native + converter paths).
- **H4 — Streaming `/v1/chat/completions` managed loop executed only ONE extra round.** **Fix:** the
  round-2 block is now a proper `while True` loop (any number of managed rounds, cap respected).
- **H5 — Malformed tool JSON swallowed to `{}` on three OpenAI→Anthropic paths** (`stream_state.py`
  `to_anthropic_tool_use`, `anthropic.py` ×2). **Fix:** `_raw` preserved + execution guards surface a
  `[Validation Error]` self-heal result instead of a phantom arg.

## 🟠 Security

- **H2 (above)** code-mode hardline bypass.
- **M7 — PRE tool hooks swallowed exceptions** (`except Exception: pass`): a broken `secret_guard`
  silently allowed credential writes. **Fix:** PRE hooks fail CLOSED (deny + WARNING); POST hooks log.
- **Phase-0 — constant-time gateway auth:** `gateway_auth.py` compared the bearer token with `!=`
  (timing side channel). **Fix:** `hmac.compare_digest`.
- **Phase-0 — logger sanitization:** only the exact `apiKey` key was dropped. **Fix:** recursive key-set
  drop (`apiKey`/`api_key`/`authorization`/`token`/`secret`/`password`/`private_key`, any casing/nesting).

## 🟡 Medium

- **M1/M2/M3 — "exit code" cluster:** verifier verdict matched the FIRST `exit code:` (command stdout
  could flip the verdict); error detectors treated `"exit code"` as an error (successful runs flagged
  failed); proxy result formatting hid `Exit code: 0` (truthy check). **Fix:** last-match regex,
  `exit code:\s*[1-9]` patterns, `is not None` check.
- **M4 — Anthropic-upstream error path dropped the error body** (bare status only). **Fix:**
  `normalize_upstream_error`.
- **M5 — `_translateToResponsesFormat` casing bug** (read `tool_calls` from a camelized body). **Fix:**
  `toolCalls or tool_calls`.
- **M6 — hash-anchored edit guard matched read tools via substrings** (`read_creations` matched
  `create`). **Fix:** whole-token regex.
- **M8 — `OpenaiToAnthropicStreamState` tool-call index handling** — a `None` index fragmented one call
  across deltas. **Fix:** normalized to 0 (parity with `OpenaiStreamAccumulator`).
- **Phase-0 B1 — case converters corrupted JSON Schemas:** recursive key renaming reached
  `tools[].function.parameters` / `input_schema` payloads (`additionalProperties` →
  `additional_properties`). **Fix:** schema payloads pass through verbatim.
- **Phase-0 — `_readJsonBody` accepted non-object JSON** (array/string → 500 downstream). **Fix:** 400.
- **Phase-0 — `ToolCallDelta.apply_delta` appended `function_name`** — providers that re-send the name
  produced duplicated tool names. **Fix:** set-once.

## 🔵 Low / housekeeping

- L2 `strict: null` omitted; L3 OpenAI usage keys normalized to Anthropic keys; A9 fingerprint filtered
  by provider; A12 auto-route decision log moved to SQLite; L4 verifier retries bounded + force-release;
  A6 reversible in-turn downgrade; A5 two-way capability auto-detect + auto-apply/revert experiment;
  A7 verifier recovery steer (+ inferred command suggestion); prompt consolidation
  (`validationErrorText` single source; stable verifier-lesson rule); P16 `fileHash` documented in
  schemas; `result`-variable capture honored in code mode; per-model pricing (`cost_estimator`).

## What was verified correct (do not regress)

- Capability profiles applied to BOTH wire-format tool paths; malformed-JSON `_raw`/`_invalid_json`
  symmetry; `verifierEnforced` withholding even when `update_state` is skipped; `/v1/responses`
  pass-through; retry/fallback chain records `turnError` as routing losses.
