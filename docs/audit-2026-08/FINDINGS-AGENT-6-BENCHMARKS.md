# Agent 6 audit — benchmarks, evals & model-specific handling

Worktree: `C:\Dev\august-agent-6` (branch `agent-audit-6-benchmarks`, master `ce538561`).
Backend run: `uvicorn app.main:app --port 8016` (one Pre-existing venv glitch — `python-dotenv`
dist-info present but module files missing; fixed with `uv pip install --reinstall python-dotenv`).

**Verdict up front:** the golden-eval harness exists, runs, passes, and is wired to a live
endpoint — but it covers only the *harness-side* failure modes (loop termination, malformed
JSON, verifier gate, stall, narration-stream-rule, text-protocol, code-mode, chat-mode).
It does **not** cover the *model-side* failures real users hit on weak/free tiers:
intermittent empty responses mid-turn, refusals that need the text-protocol downgrade,
tool schemas that exceed a weak model's effective attention, per-model capability
selection when the model id is unknown, and upstream-quirk handling (rate-limit retry,
fallback chain, context-promotion). Those paths are individually unit-tested, but never
exercised end-to-end against the real loop with a scripted weak model.

---

## Eval infrastructure audit

### Coverage map

| Area | Covered by | Where | Status |
|------|-----------|-------|--------|
| Well-behaved text turn | golden | `tests/test_harness_evals.py:50` | pass |
| Native tool round-trip | golden | `tests/test_harness_evals.py:62` | pass |
| Malformed-JSON self-heal (never executes `{}`) | golden | `tests/test_harness_evals.py:79` | pass |
| Empty upstream response → error event | golden | `tests/test_harness_evals.py:96` | pass |
| Runaway tool loop (round cap or stall stop) | golden | `tests/test_harness_evals.py:106` | pass |
| Stall detection / reflection nudge | golden | `tests/test_harness_evals.py:119` | pass |
| Stream rule: narrated tool call aborts | golden | `tests/test_harness_evals.py:130` | pass |
| Verifier gate blocks without receipts | golden | `tests/test_harness_evals.py:143` | pass |
| Verifier gate passes with receipt | golden | `tests/test_harness_evals.py:163` | pass |
| Code mode executes fenced python | golden | `tests/test_harness_evals.py:181` | pass |
| Chat mode blocks tools | golden | `tests/test_harness_evals.py:201` | pass |
| `[TOOLCALL]` text protocol executes | golden | `tests/test_harness_evals.py:229` | pass |
| Eval-run persistence (`record_eval_run`) | golden | `tests/test_harness_evals.py:219` | pass |
| **Live route**: `GET /api/brain/harness/evals` | — | `app/routers/brain.py:286` | verified live (9/9 pass at boot) |
| **Live route**: `POST /api/brain/harness/evals/run` | — | `app/routers/brain.py:307` | verified live (fires 9 scenarios) |
| Boot scheduler (6h cadence) | — | `app/main.py:189` → `harness_eval.scheduled_evals_loop` | verified live (auto-ran at boot) |
| Memory-block prompt cases | static JSON | `evals/memory/default-cases.json` | **stale / unwired — no consumer found** (`grep -rn 'default-cases\|evals/memory' app/ frontend/desktop/src` → 0 hits) |
| Per-model capability fingerprint unit tests | unit | `tests/test_trace_store.py:111-149`, `tests/test_harness_fixes.py:218-288` | pass |
| Anthropic-format loop behavior | — | — | **NOT covered** — `ScriptedClient` only implements `chat_completions_stream` (`harness_eval.py:110`) |
| `evals/` at repo root | — | only `evals/memory/` exists | no top-level runner |

### What the golden suite does NOT cover (model-relevant gaps)

1. **Intermittent empty mid-turn response** — verified live (see "Empirical probes" below):
   a weak model alternating tool-call / empty-text rounds terminates the turn with an
   error. The golden suite has `empty-response-error` only as a *first-round* script;
   the loop's empty-after-round-N handling is a separate branch (`workbench.py:2735`,
   `workbench.py:2740`) with no scripted scenario.
2. **Refusal → text-protocol downgrade end-to-end.** The path exists in code
   (`workbench.py:2764-2811`) and text-protocol *parsing* is tested, but the
   *transition* (refusal count 1 → 2 → `_text_tool_protocol=True` at :2780) is never
   driven by a scripted model through the real loop.
3. **Bare-surface downgrade after ≥3 malformed calls** (`workbench.py:3448-3462`).
   Verified live below; no golden scenario asserts the emitted warning or the truncation
   of the next round's tool list.
4. **Rate-limit retry + fallback chain + context-promotion**
   (`workbench.py:152-196`, :2492-2504). `_isRetryableModelError` is unit-testable;
   the actual switch to the next chain model mid-turn is not scripted.
5. **Anthropic wire format through the loop.** `ScriptedClient.chat_completions_stream`
   is OpenAI-only. Anthropic's `messages_stream` path (aggregator, `AnthropicNativeStreamState`,
   `_raw` malformed-input marker) has unit tests (`test_harness_fixes.py:28-63`) but no
   golden scenario drives a full Anthropic turn.
6. **Per-model capability profile actually applied in a turn.** Profiles are applied in
   `openaiToolDefinitions`/`tool_definitions` (`workbench.py:1109`, :1244), unit-tested
   (`test_harness_fixes.py:218`), but no scripted scenario starts a session with
   `toolSurface='bare'` or `toolSurface='text'` set on the provider entry and asserts the
   model sees N tools.
7. **Auto-route / routing-suggestion based on evidence.** `routing_evidence.record_turn`
   runs at turn end (`workbench.py:3693-3708`); the decision path is not scripted.
8. **`evals/memory/default-cases.json` — dead weight.** Three prompt-shaping cases
   (`learned_guideline_surfaces`, `semantic_project_context_surfaces`,
   `memory_off_omits_august_context`) with `expectedTokens`/`expectedMinimum` — no loader,
   no runner, no scheduled job references them. Looks like an abandoned Phase-4 memory
   eval scaffold.

### Broken / stale / weak assertions

- Full `pytest -q --no-cov`: **1426 passed, 1 failed, 1 skipped** in 680s.
  - FAILED: `tests/test_camel_model_git.py::test_post_api_git_command_accepts_camelcase_json` —
    `git rev-parse --is-inside-work-tree` returns `{"detail":"fatal: not a git repository…"}`
    when the suite is run from `backend-py/` (cwd assumption). Reproduces in isolation.
    Pre-existing on master — not caused by this audit. Fix: pass the worktree root, not
    `Path.cwd()`.
  - SKIPPED: `tests/test_phase7_e2e_inventory.py:196/233` — `discord.py` not installed
    (optional dependency `importorskip`). Benign.
- `test_harness_evals.py` — all 13 pass in 24s. No stale/always-true asserts spotted.
- Boot log shows two warnings that look benign but worth noting:
  - `normalize_api_format: unknown apiFormat 'eval-model' — using default 'openaiChat'`
    (eval harness itself — cosmetic).
  - `Migration 007 … duplicate column name: source_session_id` fires on every startup
    (idempotent-migration detector not recognizing already-applied state) — not an eval
    concern but pollutes logs and the FTS desync warning (`index=20 base=16 — rebuilding`)
    suggests the FTS trigger count drifts from the base table.

---

## Model-handling audit

### How August adapts per model today

1. **Per-model capability profile stored on the provider's model entry.**
   `toolSurface` ∈ {`full`, `reduced`, `bare`, `text`}, `maxTools`, `maxToolResultChars`,
   `contextWindow`, `maxOutputTokens`, `apiFormat`. Loaded in
   `config_service.py:101-124`, exposed via providers router (`routers/providers.py:43-45`,
   edit at :621-639), applied at `workbench.py:1165-1184` (filter tools) and
   :1187-1191 (truncate tool results). UI: `ModelRow.tsx` →
   `Model settings → pencil-edit → Wire format / Capability profile` dropdowns.
2. **Tool-surface tiers** (`workbench.py:1112-1184`):
   - `full` (default): everything registered (~80 tools — **verified live: 79 tools,
     ~44.7 KB of tool-def JSON**).
   - `reduced`: drops heavy prefixes `('web_', 'browser', 'voice', 'notion', 'slack',
     'discord', 'search', 'fetch')` (`_HEAVY_TOOL_PREFIXES`, :1115).
   - `bare`: allow-list of 12 (read/write/edit/run_command/update_state/memory_search/…
     — `_BARE_TOOL_ALLOW`, :1116-1132). **Verified live: 7 tools** under the current
     registry (some allow-list names not registered by default).
   - `text`: zero tools, sets `_text_tool_protocol=True` so the loop parses
     `[TOOLCALL] name|json` lines (:1171-1176, :208-236).
3. **Auto-detect from real traffic.** `trace_store.capability_fingerprint` (:152-235)
   computes `invalid_json_rate`, `refusal_rate`, `stall_rate`, `tool_use_rate`,
   `thinking_only_rate` over the last 200 turns per model; at ≥10 turns it emits a
   `suggestedProfile` (text / bare / reduced) with a human-readable reason. The workbench
   emits a `modelProfileSuggestion` SSE once per change per model (`workbench.py:3749-3790`).
   Surfaces: `GET /api/harness/model-profiles` (`routers/harness.py:135`).
4. **In-loop graceful degradation** (independent of stored profile):
   - Refusal count 2 → flip `_text_tool_protocol` + inject a protocol reminder
     (`workbench.py:2776-2806`). 3rd refusal → accept the text answer (:2807).
   - Malformed JSON args → never execute as `{}`; `[Validation Error] … Do NOT stop`
     self-heal (:2845-2882). 3 consecutive → SSE warning suggesting `set_agent_mode(code)`
     (:2855-2865); after the round ends, the next round's tool surface is downgraded to
     `_BARE_TOOL_ALLOW` (:3448-3462). Counter resets on a clean round (:3443-3444).
   - Stall detector: session execution-state `(phase, step)` unchanged for 8 rounds past
     round 12 → reflection user-message, then a hard stop 2 rounds later
     (`workbench.py:64-65`, :2431-2469).
   - Mid-stream aborts on "narrated tool call" / code-fence tool JSON
     (`providers.py:506-528`), retry with reminder.
   - Inter-round `messages` compaction:**AUTO_COMPACT_RATIO** 0.80 of the model's
     `contextWindow` (default 128k if unset, `workbench.py:69-71`,
     `config_service.py:101-102`).
5. **Retry / fallback / promotion** (`workbench.py:152-196`, :2492-2504):
   - `_isRetryableModelError` matches 408/429/5xx plus text markers
     (`rate limit`, `timed out`, `overloaded`, …).
   - After per-model retries, the turn continues on the next model in the fleet
     `chat_chain`; on context-overflow (`_isContextOverflowError`, :331), the configured
     `chat_context_promotion` model takes over.
   - `reasoning_effort`-rejection special case: 400s naming `reasoning_effort` are treated
     as "drop the hint and retry" (`providers.py:531-550`).
6. **Provider env auto-detect is shallow.** `provider_detect.py` only maps env vars →
   base URL + api format. No capability inference at the provider level (e.g. "Ollama" →
   default to reduced surface).
7. **Per-model apiFormat** (independent knob from capability): model entry may override
   the provider format (`workbench.py` `_resolveModel`, `config_service.py:108`,
   `normalize_api_format`). UI suggests `v1/messages` for `claude-*` ids.
8. **Token budget** uses `contextWindow` (per-model) with tiktoken/anthropic/gemini
   heuristics in `workbench/token_budget.py:119-192`.

### Where it breaks or over-assumes for weak/free models

- **A1. Default profile is `full` for every new/unknown model.** Verified live: a
  made-up `some-weak-model` on an unknown provider gets **79 tools / ~45 KB of schemas**
  on round 1. Free Ollama / Nvidia NIM / AI-Studio-tier models routinely choke on >5
  tools; the reliable adaptation (`bare`, `text`) only kicks in after the model has
  already failed 10 times (auto-detect `min_turns=10`, `workbench.py:213`, default
  `min_turns` in the route :136). Nothing ships a "weak model starter profile."
  `provider_detect.py` is env-var only; there is no name-based heuristic (e.g. model id
  contains `7b`/`13b`/`groq`/`ollama` → start at `reduced`).
- **A2. Refusal-2 text-protocol flip depends on the model recognising a regex.** The
  `_isToolRefusal` regex decides whether to persist; weak free models that simply emit
  junk instead of refusing never enter the text-protocol path. Verified: blackbox junk
  text (not refusal-shaped) just ends the turn as the final answer. There is no
  "after N tool-less rounds when tools were clearly needed, try text protocol anyway"
  fallback — only the drift fingerprint at ≥10 turns.
- **A3. Empty-response mid-turn is not retried.** Verified live with a scripted model
  alternating tool-call / empty-text rounds: the loop logged
  `workbench model re-call failed after tool round 1: Provider returned an empty response…`
  and terminated with an error after the 2nd round (8 events total). `_isRetryableModelError`
  requires `response.get('error')` truthy — an empty `choices: []` response carries no
  `error` key (see `harness_eval.py:144-146` for what an empty stream yields), so it
  bypasses the retry ladder entirely. Free-tier gateways (OpenRouter free, AI Studio at
  rate limit edges) do exactly this. This is the single highest-impact gap: turns that
  *would* succeed on retry die on the spot.
- **A4. `reduced` tier still exposes ~70 tools.** `_HEAVY_TOOL_PREFIXES` strips only
  ~8 prefixed families; on a default registry of 79, `reduced` keeps the large majority.
  For the weak-free segment the meaningful split is `full` vs `bare` vs `text`; `reduced`
  is a weak lever. Verified by counting: `reduced` still includes all CRUD, git, memory,
  desktop, automation, etc. tools.
- **A5. Auto-detect signal is per-model, cold-start blind.** `capability_fingerprint`
  groups by `model` only (`trace_store.py:167-170`) — a brand-new provider/model pair
  inherits nothing from the same model id on another provider. And the 10-turn warmup
  costs 10 real (possibly paid) failures before a suggestion appears.
- **A6. Only `modelProfileSuggestion` SSE; no auto-apply.** The suggestion is advisory
  (frontend toast); nothing flips the profile when the user ignores it — the loop keeps
  re-failing. Given August targets weak models, an opt-in `AUGUST_AUTO_PROFILE=1` env
  (mirroring `AUGUST_AUTO_ROUTE=1`'s pattern for routing) is a natural next step.
- **A7. `AUTO_COMPACT_RATIO` uses the *reported* `contextWindow`, not the *usable* one.**
  Many free models advertise windows they can't reliably use for tool-heavy turns (long
  tool schemas + history → degenerate JSON well before overflow). No eval scenario
  measures "does this model still emit valid tool calls at 60%/80%/95% of window."
- **A8. `maxToolResultChars` default 64 KB.** `_BARE_TOOL_ALLOW` lets weak models call
  `read_file` and `run_command` whose outputs can be tens of KB. `_toolResultCap`
  (:1187-1191) honors per-model caps but defaults to 64 KB for every model — that single
  result can blow a small free model's effective attention window.
- **A9. `chat_chain` fallback is fleet-config, not per-provider.** A weak free primary
  can only fall back to another fleet-configured model; if the user has only free
  providers configured, fallback often lands on another weak model with the same
  profile problems. Combined with A3, a flaky free tier may still kill the turn.
- **A10. Anthropic-format scripted evals are missing entirely** (see above). The
  production loop's Anthropic path uses a different aggregator
  (`AnthropicNativeStreamState`) with its own malformed-JSON marker (`_raw`). A
  regression there will not be caught by the golden suite — only the unit tests in
  `test_harness_fixes.py:28-63` cover the aggregator in isolation.

### Empirical probes run

| Probe | Result |
|-------|--------|
| Full pytest suite | 1426 passed / 1 failed (cwd-dependent git test) / 1 skipped (discord) |
| `pytest tests/test_harness_evals.py` | 13 passed in 24s |
| Boot `scheduled_evals_loop` | Auto-ran 9 scenarios at startup; `GET /api/brain/harness/evals` → 9/9 pass, `passRate: 1.0` |
| `POST /api/brain/harness/evals/run` | `{"started":true}`; second fetch shows new rows 20s later |
| Unknown-model tool surface | 79 tools, all formats |
| `toolSurface='bare'` | 7 tools (validated `_BARE_TOOL_ALLOW` ∩ registry) |
| `toolSurface='text'` | 0 tools + `_text_tool_protocol=True` flag set |
| 8 malformed calls then text | 12 warnings incl. *"Repeated malformed tool calls — downgrading the tool surface to the essential set"*; turn ends clean |
| Alternating tool + empty-text rounds | Turn **errors out** at round 2 with `"Provider returned an empty response"`; no retry attempted |

---

## Proposed benchmark matrix

Tiers: **S** = strong frontier (Claude Sonnet/Opus, GPT-5),
**M** = mid (GPT-5-mini, Gemini 2.5 Flash, Claude Haiku),
**W** = weak/free (Ollama ≤14B, Nvidia NIM free, OpenRouter free, AI Studio free).

Scenario groups map to real failure modes; each cell is one scripted scenario in
`tests/test_harness_evals.py` style (all deterministic, all drive the real loop).

| # | Scenario | S | M | W | Assertion |
|---|----------|---|---|---|-----------|
| 1 | Single-shot answer | ✓ | ✓ | ✓ | `done`, no `error` |
| 2 | 3-step tool chain (`read→edit→run`) | ✓ | ✓ | ✓ | both `toolResult` and `done` |
| 3 | Malformed JSON args once, recover | ✓ | ✓ | ✓ | exactly 1 `[Validation Error]`, `done` |
| 4 | 3 consecutive malformed → surface downgrade | ✓ | ✓ | ✓ | warning text, next round sees `bare` allow-list |
| 5 | Refusal × 2 → text-protocol flip | ✓ | ✓ | ✓ | `_text_tool_protocol` set, 3rd call uses `[TOOLCALL]` |
| 6 | Empty response mid-turn | ✓ | ✓ | ✓ | **retries or completes — not silent error** (currently FAILS for all tiers — see A3) |
| 7 | Rate-limit on round 2 | ✓ | ✓ | ✓ | fallback chain engages |
| 8 | Context overflow marker | ✓ | ✓ | – | promotion model picks up |
| 9 | Stall detector (8 rounds, no phase progress) | ✓ | ✓ | ✓ | stall warning → recovery or stop |
| 10 | Runaway 25-round cap | ✓ | ✓ | ✓ | `Tool loop exceeded` error |
| 11 | Narrated tool call mid-stream | ✓ | ✓ | – | `stream_rule` warning |
| 12 | Verifier gate, blocked | ✓ | ✓ | ✓ | `verifierBlocked`, answer withheld |
| 13 | Verifier gate, passes | ✓ | ✓ | ✓ | `done` |
| 14 | Code-mode fenced python | ✓ | ✓ | ✓ | `code_run` result fed back |
| 15 | Chat mode, tool blocked | ✓ | ✓ | ✓ | toolResult="Chat mode" |
| 16 | Text protocol, 2 tools in one turn | – | ✓ | ✓ | both run, protocol lines stripped |
| 17 | Anthropic `messages_stream` full turn | ✓ | ✓ | – | needs `ScriptedClient.messages_stream` |
| 18 | Anthropic malformed `_raw` input | ✓ | ✓ | – | same self-heal as OpenAI |
| 19 | Large tool result (~100 KB read_file) | ✓ | – | ✓ | per-model `maxToolResultChars` honoured |
| 20 | 12K-token user prompt + tools, weak model | – | ✓ | ✓ | auto-compact fires before round 3 |
| 21 | Unknown model, no profile → weak starter | – | – | ✓ | **proposed:** default `reduced` for whitelist misses |
| 22 | Valid tool, model repeats same call 5× | ✓ | ✓ | ✓ | loop detector / forced different tool |
| 23 | Mid-turn user steer (`drainQueuedMessages`) | ✓ | ✓ | ✓ | queued user turn injected after tool round |
| 24 | Auto-profile suggestion fires once | ✓ | ✓ | ✓ | `modelProfileSuggestion` deduped per model |

Wire-in: extend `EVAL_SCENARIOS` in `app/services/harness_eval.py` with a `tier` field
(`S`/`M`/`W`); the scheduler already runs each scenario against the scripted client, so
per-tier outcomes land in the same `harness_eval:runs` KV with `model='scripted-{tier}'`.
The `/api/brain/harness/evals?limit=…` UI then shows pass rate per tier — a real signal
for the "does this release help weak models?" question.

---

## Suggested improvements (ordered by impact on real-world model success rate)

1. **[Impact: HIGH, Effort: S] Auto-retry empty mid-turn responses.** Treat a
   2nd-round empty `choices:[]` as retryable (extend `_isRetryableModelError` or
   special-case the branch at `workbench.py:2735`). Weak free tiers do this under
   rate-limit pressure; today the whole turn dies. Closes A3, unlocks scenario 6.
2. **[Impact: HIGH, Effort: S] Anthropic scripted client.** Add
   `ScriptedClient.messages_stream` mirroring `chat_completions_stream`
   (`harness_eval.py:110`), plus one eval scenario per Anthropic behaviour (stream
   rules, malformed `_raw`, round cap). One regression caught here is a release saved.
3. **[Impact: HIGH, Effort: M] Weak-model starter profile.** Heuristic on model id +
   provider name (`7b|13b|8x7b|ollama|nim|openrouter.*free|gemini-.*-flash`) → default
   `toolSurface='reduced'` (not full), overridable in Model settings. Today every new
   free model starts at 79 tools and burns ~10 failed turns before the auto-detect
   suggests anything. Closes A1 + A5.
4. **[Impact: HIGH, Effort: S] Per-tier eval scenarios (matrix above) wired into the
   6h scheduler.** The plumbing exists — only `taskId` strings and scripts are needed.
   Gives the Reliability dashboard a real weak-model trendline.
5. **[Impact: MED, Effort: S] Auto-apply capability suggestion behind env flag.**
   `AUGUST_AUTO_PROFILE=1` mirrors `AUGUST_AUTO_ROUTE=1`: when the fingerprint crosses
   the same thresholds the suggestion uses, write the `toolSurface` to the model's
   provider entry. Closes A6.
6. **[Impact: MED, Effort: S] Provider-level default surface.** Extend
   `provider_detect.py` (or a sibling table) so known weak hosts (Ollama, Nvidia NIM
   free tier) default new models to `reduced`, not `full`. Cheap companion to #3.
7. **[Impact: MED, Effort: M] Wire `evals/memory/default-cases.json`.** Either delete it
   or build the runner — right now it's dead weight suggesting memory eval exists when
   it doesn't. Decide; either is fine.
8. **[Impact: MED, Effort: M] Compact on *effective* window, not reported.** Multiply
   `contextWindow` by a per-tier fudge (1.0 S / 0.8 M / 0.6 W) before applying
   `AUTO_COMPACT_RATIO`. Weak models produce garbage JSON well before advertised
   overflow. Closes A7.
9. **[Impact: MED, Effort: S] Default `maxToolResultChars` by tier.** e.g. 64 KB S /
   16 KB M / 4 KB W (bare). Today `read_file` on a big log can single-handedly wipe a
   weak model's next round. Closes A8.
10. **[Impact: LOW, Effort: S] Fix the cwd-dependent git test**
    `tests/test_camel_model_git.py::test_post_api_git_command_accepts_camelcase_json` —
    use the repo root fixture rather than `Path.cwd()`. Keeps `pytest -q` green.
11. **[Impact: LOW, Effort: S] Quiet the eval-harness warnings** (`unknown apiFormat
    'eval-model'` — set `apiFormat` explicitly in the eval `providerConfig`,
    `harness_eval.py:227`). Cosmetic but declutters the log so real warnings stand out.

---

## Evidence index (runs)

- `cd backend-py && uv run pytest -q --no-cov` → `1 failed, 1426 passed, 1 skipped in 680.36s`
- `uv run pytest tests/test_harness_evals.py -q` → `13 passed in 24.36s`
- Server on `:8016` boot: `harness_eval.scheduled_evals_loop` ran; `curl /api/brain/harness/evals` → 9 runs, all pass (`taskId`s match `EVAL_SCENARIOS`).
- `curl -X POST /api/brain/harness/evals/run` → `{"started":true}`; refetch shows 9 fresh rows ~20s later.
- Tool-surface counts measured with live registry: full=79, bare=7, text=0.
- Malformed-loop probe: 8 malformed scripts → 12 warnings, bare-downgrade warning at #4.
- Empty-mid-turn probe: turn errors after 2 rounds, logs `Provider returned an empty response for model "eval-model"`.
