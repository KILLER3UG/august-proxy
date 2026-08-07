# Audit & Harness Upgrade Pass — 2026-08-07 (0.12.55)

Full-codebase audit (backend logic, frontend UX, external-harness research —
Hermes Agent, Oh My Pi, Prime Agent, Codex CLI, Claude Code, OpenHands, Aider,
SWE-agent, smolagents, gptme, Letta) followed by one integrated fix/upgrade pass.
All findings were re-verified against the code before and after the changes.

## Critical adapter & security fixes

- **Tool_use `input_json_delta` accumulation** (`adapters/stream_state.py`) —
  the native Anthropic stream state never merged partial JSON, so managed
  tools executed with **empty args** on the streaming `/v1/messages` path.
  Deltas now accumulate (with `_raw` fallback for malformed JSON) and
  `signature_delta` lands on open thinking blocks for valid round-2 re-sends.
- **`_streamOpenaiAsAnthropic` multi-round tool loop** (`adapters/anthropic.py`)
  — managed tools were executed and discarded (the upstream was never
  re-called with tool results). Now mirrors `_streamAnthropicNative`.
- **`translateMessages` preserves `tool_result`** — Anthropic→OpenAI proxy
  translation emitted `role:'tool'` messages (previously dropped, so upstream
  models re-invoked stale tools).
- **Non-streaming tool loop no longer fakes 200** — a failed round-2 call
  previously returned the client's own last message as "assistant" content;
  upstream errors are normalized and surfaced.
- **`stop` → `stop_sequences`** in `_openaiToAnthropicBody` — strict Anthropic
  gateways no longer 400 the per-model apiFormat override path.
- **Auto-compaction emits `user`-role summaries** — mid-transcript `system`
  messages broke the next Anthropic call; legacy system-role summaries stay
  detectable (marker + closing fence).
- **Soft-sandbox relative-path escape closed** (`sandbox/paths.py`) —
  `cat ../../etc/passwd` / `echo x > ../../evil.txt` are now blocked.
- **Sub-agent `restrictedTools` race removed** — the module-global
  `wb.toolDefinitions` monkeypatch (which raced across concurrent workers and
  never filtered OpenAI-format tools) is replaced by a per-call
  `restricted_names` parameter that filters both wire formats.
- **Streaming `/v1/responses` rejected loudly** until Responses-style SSE is
  synthesized (previously emitted Chat Completions chunks on that path).

## Minor fixes & quick wins

- `/v1/models` reads `modelProfiles` **and** `model_profiles` (the resolver
  emits camelCase; the shadowed route is documented as such).
- Internal `_event_type` keys stripped in every SSE writer.
- Tool-loop `usage` stays snake_case (`prompt_tokens`/`completion_tokens`).
- `_writeScratchpad` preserves `verification_command` in execution state.
- `describe_environment` reports the real platform (`sys.platform`).
- Stream-task `finally` pops cancel events with an identity check (Stop after
  a restart works for the replacement turn).
- Verifier `update_state` validates `phase` against the known enum.
- `run_command` dangerous-pattern list covers relative `rm -rf *`,
  `git clean -fdx`, `del /s`, `format c:`.
- Token estimation matches Anthropic via `apiMode == 'anthropicMessages'`, not
  just the literal provider name.
- `/v1/messages` rejects responses-format models with a clear 400; unknown
  apiFormats are logged instead of silently defaulting.
- `getConfig()` returns a shallow copy and the read cache is validated against
  file mtime (direct/external writes propagate immediately).
- New **`GET /api/providers/quota`** endpoint (usage-events derived) — the
  Quotas tabs were permanently empty (no backend route existed).
- `/api/brain/harness/trends` — per-day fleet win-rate/token/duration signal.

## Frontend fixes

- Right-sidebar event name unified (`august:open-right-sidebar`) — three
  dispatchers used a dash variant nobody listened for.
- Reload mid-stream no longer truncates replies forever: `syncActiveStreams`
  reconnects with full per-turn handlers (the durable subscriber alone dropped
  main-turn text/toolUse/done events).
- Queue lifecycle events (`onUserMessageQueued/Dequeued/Injected`) added to the
  per-turn handler set — queued pills and injected user bubbles now work while
  a turn is streaming; stale "Your message is queued…" placeholders are
  cleaned up on drain.
- Dead `?`/`,` global shortcuts + the orphaned ShortcutsModal now work
  (hotkeys moved to `App.tsx`, modal mounted).
- Provider API keys can be rotated ("Change key" toggle).
- Onboarding checklist no longer reappears for fully-configured users
  (tautology removed).
- Offline compose consults the gateway store first — a cold-start backend no
  longer parks messages as "Offline".
- Availability dots are tri-state (good/bad/**unknown**), with the model
  picker's confirmed-unavailable providers in a collapsed group + "Check
  again".
- Model switch flow extracted to one shared routine (`switch-model.ts`) with
  the deferred auto-continue guarded against new user input.
- Markdown preview re-enabled via Ctrl/Cmd+Shift+P; verifier shield shows an
  "On" chip + first-use toast.
- A11y: listbox semantics in the model picker, status-dot labels, modal
  focus/Escape, real workspace basename in the empty state; focus/visibility
  stream resync is debounced.

## Harness upgrades (research-grounded)

1. **Tool-call recovery** — malformed tool JSON never executes as `{}`;
   a `[Validation Error] … Do NOT stop` self-heal result is returned, and 3+
   consecutive failures warn + downgrade the next round to the bare tool
   surface (weak-model drift).
2. **Stream rules** (Oh My Pi) — mid-stream abort when the model *narrates* a
   tool call (code-fenced JSON, "I'll use the X tool"), reminder injected,
   retry from the same point.
3. **Round budgets + stall detection** — `MAX_MANAGED_TOOL_ROUNDS` default 25
   (was unlimited); a turn whose execution phase/step never advances gets a
   reflection nudge, then hard-stop.
4. **Routing evidence → real routing** — `record_turn(ok=…)` records real
   outcomes (error turns were previously recorded as wins); with ≥3 samples a
   materially better model for the task type emits a `routingSuggestion` SSE,
   or replaces the model with `AUGUST_AUTO_ROUTE=1`.
5. **Verifier upgrades** — `run_command` always surfaces the exit code (zero
   included) so the gate is deterministic; the auto-run steers pass/fail
   explicitly with a fix-and-rerun loop.
6. **Sub-agents** — parent retry policy with backoff (a transient 429 no
   longer kills the agent), mid-run compaction, `yieldSchema` for
   schema-validated structured results.
7. **Context UX** — `contextPressure` SSE per turn; compaction audit trail
   (removed middle messages are persisted, never unrecoverable).
8. **Code map** (Aider repo-map lite) — bounded file skeleton + signatures in
   Tier 2 so models navigate without guessing paths.
9. **Per-model capability profiles** — `toolSurface` (full/reduced/bare),
   `maxTools`, `maxToolResultChars` per model, honored by both tool-definition
   paths and result truncation; editable in Model settings.
10. **Versioned self-improvement** (Prime /refine lean) — every heuristic
    mutation is recorded in a rollback trail; Tier 2 injects only the 12 most
    recent rules (bounded prompt weight).

## Deferred (roadmap)

- Arena/debate **history + replay UI** (endpoints exist; no archive surface).
- Memory **proposals panel** (`/api/memory/proposals` + `decide` — chips only).
- **Curator suggestion chips** in the composer (dry-run results where the user
  works).
- Reviewer-model one-shot critique in the verifier gate (opt-in).
- Full `code`/`shell-first` execution mode (smolagents CodeAgent) — the
  auto-downgrade mechanism is in; executing fenced Python needs a sandboxed
  runner.
- Loop-level **eval harness** (`evals/loop/` golden tasks + nightly trends) —
  the `/api/brain/harness/trends` feed exists; golden task files are the next
  step.
- Skills self-improvement during use + memory nudges (Hermes) — depends on the
  versioned state store.
- `/v1/responses` streaming (Responses-style SSE synthesis).

## Validation

- `uv run ruff check .` clean; `uv run mypy app/` 0 errors.
- Backend: 1342 passed (new `tests/test_harness_fixes.py` — 15 tests covering
  the delta accumulation, tool_result translation, `stop` mapping, SSE key
  stripping, sandbox escape, exit-code surfacing, user-role summaries, quota
  endpoint, responses rejection, stream rules, capability profiles, evidence
  outcomes).
- Frontend: `tsc --noEmit` clean; vitest 732 passed.
- Two order-dependent flakes observed on the full backend run
  (google-callback, web-search) are pre-existing and pass standalone.
