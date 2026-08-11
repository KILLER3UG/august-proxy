# August Harness Research — Agent 5

Comparative study of agent harnesses (Hermes, pi, oh-my-pi, Prime Agent, Codex
CLI, Claude Code, Aider, SWE-agent, OpenHands, Cline, smolagents, LangGraph),
mapped to concrete changes in August. Focus: techniques that raise **model
success rate**, especially on weak/free providers (Nvidia NIM, Ollama, Google
AI Studio free, OpenRouter free).

---

## How August's harness works today

All paths are under `backend-py/` unless noted.

**Turn loop** — `app/services/workbench/workbench.py`
- `MAX_MANAGED_TOOL_ROUNDS = 25` (`workbench.py:55`), overridable per-session
  via brain config `maxWorkbenchToolLoops` (`_managedToolLoopCap`, `:358`).
- Stall detection: after `MIN_ROUNDS_BEFORE_STALL_CHECK = 12` rounds
  (`:65`), if `session._execution_state` phase/step (set via `update_state`)
  hasn't advanced for `MAX_STALLED_ROUNDS = 8` (`:64`) consecutive rounds,
  a `[Proxy Self-Heal]` user message asks the model to reflect
  (`:2443-2462`); 2 further stalled rounds hard-stop the turn (`:2463-2468`).
- Retry: `_modelRetryPolicy()` (`:301`) retries transient upstream errors
  (429/5xx) with backoff (`_modelRetryDelayMs`, `:375`), then walks a
  **fallback chain** (`_chatFallbackChain`, `:337`) of configured models
  (`:2498-2522`); context overflow promotes once to a larger-context sibling
  (`_chatContextPromotionModel`, `:348`; `:2583-2604`).
- Stream rules: if the model **narrates** a tool call in prose instead of
  emitting one (`response.stream_rule`, `:2621-2646`), generation is aborted,
  a "[Proxy Self-Heal] Stop narrating tool calls" user message is injected,
  and the round retries.
- Malformed tool JSON: `_invalid_json`/`_raw`-marked inputs never execute as
  `{}`; the loop returns a `[Validation Error] … Do NOT stop` tool result
  (`:2851-2870`). `parseFailures` accumulates across the turn; at 3+
  consecutive failures a warning suggests `set_agent_mode(mode="code")`
  (`:2855-2864`).
- Refusal recovery: `_isToolRefusal` (`:203`) detects "I can't use tools"
  text; first refusal re-prompts, **second refusal downgrades the model to
  the text tool protocol** (`[TOOLCALL] name|json` lines, parsed by
  `_parseTextToolCalls` at `:216`), third accepts the plain-text answer
  (`:2768-2809`).
- Agent modes (`tool_registrations/system_tools.py:299-318`): `chat` blocks
  tools, `agent` = native calling, `code` executes a fenced ```python block
  through the sandboxed `run_command` with a workspace-bound API
  (`workbench/code_runner.py`) — the smolagents CodeAgent pattern.

**System prompt** — 3-tier XML (`app/services/memory/context_builder.py`):
- Tier 1 (`buildTier1`, `:226`): identity, guard mode, ranked HARD RULES —
  (1) agent mode, (2) never fabricate history, (3) verifier gate (must run a
  real verification command before review/complete), (4) proactive interrupts,
  (5) cognitive budget. Assembled per-turn in
  `workbench.buildSystemPrompt` (`workbench.py:551`) with per-tier caching
  (`prompt_cache.py`, `prompt_segments_cache.py`).
- Tier 2 (`:288`): workspace path + VCS + OS/shell line, goal/plan,
  **code map** (Aider repo-map lite, `workbench/code_map.py`), AUG.md
  (CLAUDE.md parity), top-12 learned heuristics.
- Tier 3 (`:349`): volatile state — execution_state, verifier receipts,
  cognitive budget, memories, daemon updates, failure feedback.

**Tool surface** — `toolDefinitions` (`workbench.py:1032`) /
`openaiToolDefinitions` (`:1194`): registry → Anthropic/OpenAI shapes, MCP
appended, guard-mode filtering, then **per-model capability profile**
(`_applyModelCapabilityProfile`, `:1165`): `toolSurface`
full/reduced/bare/**text** (text = no native tools, `[TOOLCALL]` lines only),
`maxTools` truncation, `maxToolResultChars` (`_toolResultCap`, `:1187`;
default `MAX_TOOL_RESULT_CHARS = 64KB` `:73`). Progressive disclosure
(BM25 tool pre-load) via `tools/model_tools.assembleToolDefs` when the tool
set exceeds a threshold budgeted against the model's real context window
(`:1092-1097`).

**Verifier gate** — opt-in per session (`verifierEnforced`).
`update_state(phase=...)` (`tool_registrations/system_tools.py:321`)
validates phases `research → plan → implement → review → complete`; entering
`review`/`complete` requires a `run_command` receipt this turn with a passing
exit code (`_verificationVerdict`, and `_EXIT_CODE_RE` at `:150`); a declared
`verificationCommand` must match the receipt. Final answers are withheld by
`_verifier_gated_emit` (`workbench.py:1771`) until phase=complete, emitting a
`verifierBlocked` SSE event; rejection records a learned heuristic
(`:1823-1839`). Optional one-shot reviewer model veto
(`AUGUST_VERIFIER_REVIEWER=1`, `_reviewerCritique`).

**Self-heal** — `workbench/selfheal.py`: pattern-matched error hints appended
to tool results (bash-in-PowerShell, path separators, permission errors;
`buildHints` `:74`); `applySelfHealToMessages` rewrites tool-result messages.

**Edit path** — `read_file` prefixes every result with `[sha256 <digest>]` of
the whole file (`tool_registrations/file_tools.py:141-147`); `edit_file` /
`str_replace` verify the echoed `fileHash` before applying (hash-anchored
edits, file-level). `_executeTool` (`workbench.py:3996`) dispatches.

**Compaction** — `compact_workbench_session_now` (`sessions.py:982`); auto-compact
when estimated history exceeds `AUTO_COMPACT_RATIO = 0.80` of the resolved
model window (`workbench.py:71`).

**Evidence** — routing evidence records `ok` per turn; malformed-JSON /
refusal / stall counts suggest a capability profile (`workbench.py:3750-3786`);
golden evals in `backend-py/tests/test_harness_evals.py`.

---

## Harness-by-harness findings

### Hermes (Nous Research) — function-calling convention
Source: <https://github.com/NousResearch/Hermes-Function-Calling> (README).

- **Wire format**: tool calls are emitted as `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`;
  results return as `role: tool` messages wrapped in `<tool_response>` tags.
  Function schemas are injected in the system prompt inside `<tools>` as
  OpenAI-format JSON, plus the Pydantic schema the call JSON must satisfy.
- **Loop**: `functioncall.py` runs a recursive generate→parse→execute→respond
  loop with `--max_depth` (default 5) as the iteration cap.
- **Validation**: Pydantic models validate every generated call before
  execution (`schema.py`); `jsonmode.py` constrains generation to a supplied
  JSON schema (constrained decoding when the backend supports it).
- **Hermes-3 reasoning scaffold**: a mandatory `<scratch_pad>` GOAP block —
  Goal / Actions / Observation / Reflection — before emitting calls, so weak
  reasoning is externalized into a fixed structure.
- *Takeaway for August*: Hermes shows a plain-text tag protocol +
  schema-validation loop works for self-hosted models; August already has the
  `[TOOLCALL]` text protocol and code mode. The GOAP scratch-pad (goal →
  actions → observation → reflection) is a cheap prompt-level scaffold August
  could offer weak models (see R6).

### pi (badlogic / mariozechner) — minimal terminal harness
Sources: <https://github.com/badlogic/pi-mono>, coding-agent README and
`packages/coding-agent/src/core/system-prompt.ts`,
`packages/coding-agent/src/core/tools/edit.ts`.

- **Radically small default surface**: 4 tools (`read`, `write`, `edit`,
  `bash`). The default system prompt is ~1 screen: "You are an expert coding
  assistant…", a one-line snippet per available tool, a short guidelines
  list, and `<project_context>` (AGENTS.md/CLAUDE.md concat). Guidelines are
  **assembled from which tools are actually available** (e.g. "Use bash for
  file operations like ls, rg, find" only when grep/find/ls tools are
  absent). Every tool contributes its own `promptSnippet` + `guidelines`
  (co-located with the tool implementation), so the prompt can never
  describe tools that aren't present.
- **Edit tool**: `edits[]` array of exact-match replacements in ONE call —
  but with guidelines that fight failure modes directly: "Each
  edits[].oldText is matched against the original file, not after earlier
  edits… merge nearby changes into one edit", "Keep oldText as small as
  possible while still being unique. Do not pad with large unchanged
  regions." — i.e. the tool *description itself* teaches the maneuver models
  most often get wrong.
- **Sessions as trees**: JSONL with id/parentId; `/tree` branch navigation,
  `/fork`, `/clone` — lossy compaction never destroys history.
- **Compaction**: automatic on overflow *and* proactive near-limit,
  `/compact <custom instructions>`, prompt-cache-aware footer (cache hit
  rate visible to the user).
- *Takeaway*: co-locate each tool's one-line snippet + honest guidelines in
  the tool's registration and render only what the session actually offers
  (August's `capabilities_prompt.build_capabilities_block` is the right
  seam; see R2).

### oh-my-pi (can1357, pi fork) — "the harness is the variable"
Sources: <https://github.com/can1357/oh-my-pi> (README);
Can Bölük, "We improved 15 LLMs at coding in one afternoon. Only the harness
changed" <https://blog.can.ac/2026/02/12/the-harness-problem> (redirects to
<https://stencil.so/blog/the-harness-problem>).

Measured benchmark: 16 models × 3 runs × 180 tasks, fresh sessions,
tools = read/edit/write, comparing edit formats (patch vs str_replace vs
**hashline** vs hashline-v2):

- **Hashline edit format**: every line returned by `read`/`grep` is tagged
  with a 2-3 char **content hash** (`2:f1 | return "world";`). Edits reference
  tags (`replace line 2:f1`, `replace range 1:a3 → 3:0e`, `insert after
  3:0e`). Stale file → hash mismatch → reject *before* corruption. The model
  never has to retype (or mis-retype) existing content. Results vs patch:
  Grok Code Fast 1 **6.7% → 68.3% pass**, MiniMax M2.1 +41.7pp, Devstral
  +40.5, GLM-4.5-Air +27, Sonnet 4.5 +14.4, GPT-5.1-Codex-Mini +20.3 (and
  +17.5pp more from hashline-v2); output tokens dropped up to **−61%**
  (Grok 4 Fast) because retry loops on bad diffs vanished. 14/16 models
  better than patch. Only DeepSeek V3.2 regressed slightly (−5).
- Reported patch failure rates on non-OpenAI models: Grok 4 **50.7%**, GLM-4.7
  **46.2%** — apply_patch is effectively an OpenAI-trained dialect. Google's
  own best Gemini edit attempt was beaten by +5.0pp; Gemini 2.5/3 Flash gets
  fuzzy-whitespace matching, not format change.
- **Summary-led reads**: `read` returns *summarized* snippets with ideal
  defaults instead of dumping whole files ("selector hit rate" tuned).
- **Stream rules ("time-traveling")**: regex rules sit dormant; on mid-stream
  match they **abort generation mid-token**, inject the rule as a system
  reminder, and retry from that point; injections survive compaction.
- **Structured subagent results**: `task` fans out subagents in isolated
  worktrees and returns **schema-validated** objects — "no prose to parse"
  (contrast called out: Claude Code leaks raw JSONL from subagent outputs,
  wasting hundreds of thousands of tokens).
- **Advisor**: a second model reads every turn and injects inline
  notes/blockers on its own context.
- **In-process coreutils** (ripgrep/glob/find built-ins, brush shell): no
  fork/exec, works identically on Windows without WSL — relevant to August's
  PowerShell-vs-bash self-heal category.
- *Takeaway*: the single highest-leverage, best-measured harness change in
  this whole survey is **line-level hash-anchored editing**. August has
  file-level sha256; moving to per-line anchors targets exactly the free-tier
  models August supports.

### Prime Agent (PrimeIntellect) — RLM / prompt-as-a-variable
Sources: <https://github.com/PrimeIntellect-ai/prime-agent> (README,
`packages/coding-agent/docs/rlm.md`, `skills/refine/SKILL.md`).

- **One built-in tool: a persistent IPython kernel**. File ops, shell,
  search, transforms, subagent calls all happen *as code* inside the REPL;
  Python state (variables, imports, parsed results) survives across tool
  calls **and across compaction**. The prompt/context is treated as a
  variable the REPL can inspect and slice programmatically.
- **Subagents are kernel calls**: `handle = await rlm("Review the auth
  flow", name="auth-reviewer")` — returns an admission handle immediately,
  results come back as `agent_message` replies or files, never as a return
  value. Children inherit parent model/provider/retry policy.
- **Continual harness** (`/refine`): reviews the current trajectory and
  applies *small, evidence-backed* updates to supplemental prompts, memories,
  skill descriptions, subagent specs — never rewrites the base system
  prompt; snapshots support rollback. Session-local by default, promotable
  to global. (August's `learned_heuristics` + `update_heuristics` is a
  sibling mechanism; Prime's version is evidence-backed and reviewable.)
- **Bounded autonomous mode**: configured turn/token/time budgets with
  user-defined quality gates; "a passed gate checks only what that gate
  verifies" — honest gating phrasing.
- *Takeaway*: August's `code` mode is halfway to the RLM pattern; a
  *persistent* kernel (state survives across rounds) plus prompt-as-variable
  introspection tools are the missing pieces (R7). The `/refine` review loop
  is a strict upgrade to bare heuristic injection (R9).

### Codex CLI (OpenAI)
Sources: <https://github.com/openai/codex>,
`codex-rs/core/gpt_5_codex_prompt.md`,
`codex-rs/core/prompt_with_apply_patch_instructions.md`.

- **Per-model-family prompt files** (`gpt_5_codex_prompt.md`,
  `gpt_5.2-codex_prompt.md`, …) — the harness maintains distinct tuned
  prompts per model generation rather than one universal prompt.
- **apply_patch as a trained dialect**: edits go through a strict
  OpenAI-flavored patch format; the Stencil data shows this *only* works
  because Codex models are trained/gateway-constrained on it. For other
  models it's the worst format. Not transferable to August's multi-provider
  reality — but the *lesson* (a canonical, validated patch grammar) is.
- **Preamble rule**: "Before making tool calls, send a brief preamble… 1-2
  sentences, 8-12 words for quick updates… Avoid a preamble for every
  trivial read" — pacing guidance that keeps text-only turns cheap and
  informative.
- **update_plan discipline**: skip planning for the easiest ~25% of tasks;
  never single-step plans; mark steps complete as you go; re-plan with an
  `explanation` when the plan changes. This is a *tool-centred* plan flow
  the model maintains (vs August's `update_state` phase tracker).
- **AGENTS.md spec**: scope rules (directory tree rooted at the file),
  precedence (deeper files win; direct instructions > AGENTS.md), and
  "AGENTS.md from CWD up to root is already in context; when working in
  subdirectories, *check* for nested ones".
- **Sandbox truth-telling**: model is told it's in a sandbox with explicit
  escalation semantics; hard rules against destructive git commands.
  Final-answer formatting rules are extremely specific (file refs as
  `path:line`, no URLs, no nested bullets).
- *Takeaway*: per-model prompt variants (R3) and the `update_plan`
  discipline (skip trivial tasks, re-plan with explanation) (R5).

### Claude Code (Anthropic)
Sources: <https://github.com/Piebald-AI/claude-code-system-prompts> (515
prompt fragments extracted from v2.1.227).

- **Not one prompt — ~500 conditional fragments**: tool descriptions carry
  much of the behavioral weight (long `Write`/`Bash`/`TodoWrite` docs);
  separate system prompts for subagents (Explore, Plan), for utility jobs
  (compaction, title generation, CLAUDE.md generation), and for review
  phases.
- **Truthful reporting** (`system-prompt-action-safety-and-truthful-reporting.md`):
  "Report outcomes faithfully: if tests fail, say so with the output; if a
  step was skipped, say that; when something is done and verified, state it
  plainly without hedging." Also: before deleting/overwriting, look at the
  target; if reality contradicts the description, surface it.
- **Doing-tasks fragments** discourage compatibility hacks, unnecessary
  error handling, and unnecessary additions — anti-overengineering steering.
- *Takeaway*: move behavioral load into tool descriptions (August's tool
  registry descriptions are terse compared to Claude Code's; see R2), and
  add a truthful-reporting rule to Tier 1 (R4).

### Aider
Sources: <https://aider.chat/docs/more/edit-formats.html>,
<https://aider.chat/docs/troubleshooting/edit-errors.html>.

- **Per-model edit format**: `whole` (rewrite entire file), `diff`
  (SEARCH/REPLACE blocks), `diff-fenced` (for Gemini fencing failures),
  `udiff` (GPT-4-Turbo; reduces "lazy coding" elision). Aider benchmarks
  (cited in the Stencil post) swung GPT-4 Turbo 26%→59% by format choice
  alone while GPT-3.5 scored 19% on the same format — **format must follow
  model capability**.
- Fallback ladder for weak models: `--edit-format whole` when the model
  can't conform; `--architect` mode splits "propose changes" (strong model)
  from "emit correctly-formatted edits" (editor model/format).
- **Context discipline**: above ~25k tokens of chat context "most models
  start to become distracted and… less likely to conform to their system
  prompt" — Aider's advice is `/drop` + repo-map, which August mirrors via
  the code map + budget-gated memory injection.
- *Takeaway*: capability-tiered edit strategy (R1) and a hard "weak model ⇒
  whole-file-rewrite or text-format fallback" ladder (R1b).

### SWE-agent (Princeton, NeurIPS 2024)
Source: <https://github.com/SWE-agent/SWE-agent>
(`config/bash_only.yaml`, `sweagent/agent/history_processors.py`).

- **bash_only config**: one bash command per turn, THOUGHT section before
  each command, "exactly ONE command… Failure to follow these rules will
  cause your response to be rejected" — extremely constraint-heavy
  formatting for broad model compatibility ("compatible with any
  instruction following LM").
- **History processors**: `LastNObservations` elides all but the last N
  tool observations; `TagToolCallObservations` + elision by tag;
  `CacheControlHistoryProcessor` places manual cache breakpoints. Cheap,
  deterministic context shaping instead of full summarization.
- **Reviewer**: a separate model pass over the trajectory before submission.
- *Takeaway*: observation elision as a first-class, cheap context strategy
  (R8); THOUGHT-before-command format as a text-protocol upgrade (R6).

### OpenHands (All-Hands-AI)
Source: <https://github.com/OpenHands/software-agent-sdk>
(`openhands-sdk/openhands/sdk/context/prompts/sections/static.py`,
`openhands-sdk/openhands/sdk/llm/utils/model_prompt_spec.py`).

- **Modular guarded sections**: each prompt section is a class with a cache
  tier (STATIC/DYNAMIC) and a `guard()` predicate — the nearest analog to
  August's 3-tier builder, but byte-for-byte pinned by tests
  ("Phase 0 snapshot oracle") so prompt drift is caught in CI.
- **Model-specific `<IMPORTANT>` blocks**: `model_prompt_spec.py` detects
  family (openai_gpt/anthropic_claude/google_gemini/llama/mistral/deepseek/
  qwen) and *variant* (e.g. gpt-5-codex vs gpt-5), then injects
  per-family/variant guidance (e.g. Gemini: "Avoid being too proactive…";
  Claude: "follow instructions exactly… fail fast instead of masking
  misconfigurations").
- Platform refinement: on Windows, `bash`→`powershell` string substitution
  across sections so the prompt always names the real shell.
- *Takeaway*: model-family `<IMPORTANT>` blocks are a concrete, low-effort
  version of per-model prompt differentiation (R3); byte-pinned prompt
  sections as regression tests (R10).

### Cline
Source: <https://github.com/cline/cline>
(`sdk/packages/shared/src/prompt/system.ts`, `cline.ts`).

- Explicit **parallelism doctrine**: "identify every independent read,
  search, command, or edit… emit all of those tool calls now… Do not split
  independent reads across separate turns", with good-parallelism examples.
- "Response without tool calls will be considered completed with final
  answer" — a crisp stop-condition contract.
- Plan/Act modes stamped on every user message
  (`<user_input mode="plan|act">`) so mid-conversation mode switches aren't
  invisible prompt swaps; file-editing commands are *hard-blocked* in plan
  mode by a hook (prompt is "first line of defense", hook is the backstop).
- *Takeaway*: parallelism doctrine + explicit stop contract are cheap Tier-1
  additions (R4); mode notices in-band (alt: August's plan-mode tool
  filtering already blocks; adding an in-band `<mode_notice>` when guard
  mode changes mid-session costs almost nothing).

### smolagents (Hugging Face)
Source: <https://github.com/huggingface/smolagents>
(`src/smolagents/prompts/code_agent.yaml`).

- **CodeAgent prompt**: Thought → ```py code → Observation cycle; the system
  prompt contains **3-4 full worked few-shot exemplars** (including one
  showing recovery from "No result found" by broadening a query) before the
  rules list.
- Rules worth copying verbatim-adjacent: "Use only variables that you have
  defined"; "never re-do a tool call that you previously did with the exact
  same parameters"; "The state persists between code executions"; "Don't
  give up!" — plus explicit chained-call guidance distinguishing tools with
  vs without JSON output schemas.
- Planning step: a separate facts-survey (given / to-look-up / to-derive)
  then a high-level plan ending with `<end_plan>` — a plan-then-act scaffold
  periodic via `planning_interval`.
- `final_answer` tool = explicit termination signal (no ambiguity about when
  the loop ends).
- *Takeaway*: few-shot exemplars embedded in the prompt measurably help weak
  models follow a loop format; a `final_answer` termination tool removes the
  "is prose an answer or narration?" ambiguity August solves heuristically
  with stream rules (R6).

### LangGraph
Unverified at source in this pass (rate-limited); from established public
knowledge: LangGraph models agents as explicit state graphs (nodes = model
calls/tools, edges = routing functions) with checkpointing and
interrupt/resume. The transferable idea for August is not the framework but
**explicit routing edges** for recovery (retry edge, fallback-model edge,
compact edge) — August already implements these imperatively in the while
loop; a declarative equivalent isn't needed. Skipping deeper claims to avoid
fabrication.

---

## Recommendations for August

Ordered by expected impact on **model success rate**; each tagged with
effort (S <1 day, M 1-3 days, L >3 days) and the models it helps most.

### R1 — Line-hash edit protocol ("hashline") for weak-and-middle models
**Impact: highest. Effort: M. Helps: weak/free models most (Grok-class,
Devstral-class, GLM-Air-class, MiniMax-class — i.e. exactly Nvidia NIM /
OpenRouter-free / Ollama traffic); also cuts output tokens ~20-60% for all.**

August today's `read_file` returns one whole-file sha256
(`tool_registrations/file_tools.py:141-147`), and `edit_file` verifies the
echoed hash then does exact-text replacement. The Stencil/oh-my-pi
benchmarks show the win comes from **per-line** anchors: the model never
reproduces existing content at all, so whitespace mismatches, truncation,
and "string not found" loops disappear.

Change:
- `read_file` (and `run_command`-adjacent file dumps) prefix each line with
  `lineno:hash2 | content` where `hash2` = first 2-3 chars of a fast hash of
  the stripped line. File: `tool_registrations/file_tools.py` (`_readFile`).
- New `edit_lines` tool: ops = `replace(line_ref, new_lines)`,
  `replace_range(a_ref, b_ref, new_lines)`, `insert_after(line_ref, lines)`,
  each tagged with expected hash; mismatch ⇒ reject with the *current* hash
  block of the neighborhood (so the self-heal message carries the corrected
  anchors — August's existing failure-feedback path,
  `session._failure_feedback`, can carry it).
- Keep `edit_file`/str_replace for strong models; make the edit protocol a
  capability-profile choice alongside `toolSurface`
  (`workbench.py:1141-1192`), default `hashline` for `bare`/`reduced`,
  auto-suggest via the existing evidence-driven profile suggestion
  (`workbench.py:3750-3786`).
- Schema sketch:
  ```json
  {"name": "edit_lines",
   "input_schema": {"path": "string",
     "ops": [{"op": "replace", "at": "42:f1", "lines": ["..."]},
             {"op": "insert_after", "at": "7:a3", "lines": ["..."]}]}}
  ```
- Risk: line-hash noise inflates read output ~8-10 chars/line; cap via
  existing `maxToolResultChars`.

### R2 — Tool co-located prompt snippets; render only the offered surface
**Impact: high. Effort: S-M. Helps: all weak models; zero-cost for strong.**

pi's design rule: the system prompt must never describe a tool the session
doesn't offer, and each tool carries its own one-liner + failure-mode
guidelines rendered *only when the tool is present*. August's capability
profiles (`_applyModelCapabilityProfile`) change the offered set, but Tier-1
hard rules and heuristic blocks are static text.

Change: extend `tool_registry.register(...)` with
`prompt_snippet` + `prompt_guidelines` fields; make
`memory/capabilities_prompt.build_capabilities_block` render guidelines for
exactly the tools in `sessionDict['toolNames']`
(`workbench.py:771` already passes the list). Port the pi edit-tool
guidelines ("oldText must match exactly"; "match against the original file,
not incrementally"; "smallest unique region") into `edit_file`'s description
today — Claude Code likewise packs behavioral weight into tool descriptions.

### R3 — Model-family `<IMPORTANT>` blocks
**Impact: high for weak/temperamental families. Effort: S. Helps: Gemini
(over-proactivity), DeepSeek/Qwen (format drift), Mistral/Devstral.**

OpenHands detects family+variant and injects 3-5 targeted bullets; Codex
ships an entire prompt file per model generation. August already resolves
model+provider per session (`_resolveChatLlm`), and already *suggests*
profiles from evidence — this is the prompt-side complement.

Change: add `modelFamilyNotice(model_id) -> str` (mirror OpenHands'
`_MODEL_FAMILY_PATTERNS`), injected as a Tier-1.5 block in
`context_builder.buildTier1`
(`memory/context_builder.py:226`) or via the existing `capabilitiesBlock`.
Seed with:
- Gemini: "Does the ask need a file change? If yes, call a tool. Do not
  append extra refactors beyond the request."
- DeepSeek/Qwen/flash-class: "Emit ONE tool call per assistant turn. If a
  tool call fails, fix the arguments — do not switch tools."
- Llama/Mistral small: "Prefer whole-file write_file over str_replace for
  files under 200 lines." (Aider whole-format fallback, validated by
  Cursor's finding that full-rewrite beats diffs under 400 lines.)

### R4 — Tier-1 additions: truthful reporting, parallelism doctrine, stop contract
**Impact: medium-high. Effort: S. Helps: all models; costs ~60 tokens.**

Three one-paragraph rules proven in Claude Code / Cline, absent from
August's HARD RULES (`context_builder.py:230-261`):
- "Report outcomes faithfully: if tests fail, quote the failure; if a step
  was skipped, say so." (complements the verifier gate — today the gate
  catches *behavior*; this catches *narration drift* between gate and
  final answer.)
- "Before tool calls, batch every independent read/search/edit into one
  turn — do not split independent calls across rounds." (Cuts rounds
  against the 25-round cap; biggest win on slow free endpoints.)
- "A response with no tool calls ends the task. If the task isn't done, a
  tool call is required in this response." (Removes the ambiguity August
  currently resolves with stream rules and refusal detection.)

### R5 — Plan-then-act scaffold via `update_state`, with Codex-style discipline
**Impact: medium. Effort: S-M. Helps: weak models on multi-step tasks.**

Codex's `update_plan` rules (skip the easiest quartile, no single-step
plans, re-plan with `explanation`) and smolagents' facts-survey are the two
extremes. August's `update_state` is already the phase tracker powering
stall detection and the verifier — extend its *defaults*:
- Guide text in the tool description
  (`tool_registrations/system_tools.py:453-…`): "Skip for single-step tasks.
  When the plan changes, call update_state again with the new step and note
  the reason in `blockers`."
- When `verifierEnforced` is on and the task text classifies as
  multi-step (brain `classifyTask` already runs per turn,
  `workbench.py:669-676`), inject a one-time scaffold user-message at turn
  start: "State the phase plan via update_state(phase='plan', …) before your
  first mutating call." This is scaf*fold*, not a gate — weak models get
  structure, strong models get 12 extra tokens.

### R6 — Few-shot loop exemplars for text/code-mode models
**Impact: medium-high on the refusal-downgrade path. Effort: S. Helps: any
model that lands on `toolSurface='text'` or the second-refusal downgrade.**

Today the downgrade injects *format rules* only
(`workbench.py:2787-2794`). smolagents' experience is that 2-3 worked
examples (including one failure-recovery example) outperform rule lists
massively for marginal models.

Change: extend the refusal-2 reminder to include one 6-line worked example:
```
[TOOLCALL] read_file|{"path": "src/app.ts"}
(result appears as a tool message)
[TOOLCALL] edit_lines|{"path": "src/app.ts", "ops": [...]}
```
and pair it with smolagents' rule: "Never reply with only the example —
execute it." For code mode, add one fenced-python exemplar to
`code_runner`'s mode-switch message. Keep exemplars under ~120 tokens each.

### R7 — Persistent code-mode kernel (RLM-lite)
**Impact: medium, rising for long tasks. Effort: L. Helps: all; biggest for
exploratory/multi-step where re-reading files burns context.**

Prime Agent's core insight: when state survives between execution cells, the
model *computes over* prior results instead of re-emitting them, and
compaction stops being lossy for working data. August's `code_runner`
executes fenced blocks statelessly today (one `run_command` per block;
`code_runner.py`).

Change: add an opt-in persistent Python kernel per session (spawn
`python -i`-style subprocess or jupyter-client), expose `code_run(code)`
tool in `code` agent mode; workspace paths remain sandbox-bound. This also
subsumes the "subagents return schema-validated objects" trick: parent can
`json.loads` a child's `yieldSchema` output instead of parsing prose.

### R8 — History shaping: observation elision before compaction
**Impact: medium. Effort: M. Helps: small-window models (Ollama 8k-32k,
some NIM endpoints) the most.**

SWE-agent's `LastNObservations` and Aider's ~25k-token distraction
threshold both say: beyond N tool observations, old full-fidelity results
are net-negative. August compacts at 80% of window (`workbench.py:71`) — a
cliff.

Change: in the history assembly before each model call
(`workbench.py` message-build path for `currentMessages`), replace tool
results older than the last 5 rounds with their first 500 chars + an
elision marker `…[elided {n} chars; re-read if needed]`, keeping the most
recent intact. Deterministic, no extra model call (unlike summarization),
cache-friendlier than full compaction. Gate behind attention-pressure
signal from `token_budget.computeBudget` so big-window models are
untouched.

### R9 — Evidence-backed `/refine` path over learned heuristics
**Impact: medium. Effort: M. Helps: long-running/assistant use cases
(recurring tasks, personal-assistant memory).**

August injects up to 12 learned heuristics every turn
(`context_builder.py:328-345`), and the verifier gate auto-records lessons.
Prime's `/refine` adds the missing pieces: (a) refinement runs at turn end
from the *trajectory*, not ad-hoc; (b) changes are small and
**reviewable**; (c) snapshots allow rollback.

Change: extend `heuristics_service` with a `pending_review` state;
auto-recorded lessons (verifier-lesson source) start pending and enter the
prompt only after surfacing in the Brain UI once. Cap auto-sources at turn
end. This prevents a single bad-weather session from polluting every future
prompt.

### R10 — Byte-pinned prompt regression tests + per-model eval tracks
**Impact: indirect (prevents regressions). Effort: S-M. Helps: everything.**

OpenHands pins every static prompt section byte-for-byte against a snapshot
oracle. August's prompt assembly is highly dynamic (heuristics, memory,
budget), which makes drift invisible. Add: (a) snapshot tests for
`buildTier1` with a fixed session dict; (b) extend
`tests/test_harness_evals.py` scenarios with a *weak-model scripted
scenario* that asserts the edit protocol + refusal path produce a
successful turn, so harness changes are measured against the profile they
claim to help.

---

### Cross-cutting notes

- **What August already does that most of the field doesn't**: enforced
  verifier receipts (SWE-agent/Prime only prompt for verification),
  stream-rule aborts (oh-my-pi has this; most others don't), refusal→text
  protocol downgrade (unique in this survey), capability profiles with
  evidence-driven suggestions. These are strengths; the gaps are
  concentrated in the **edit path** (file-level vs line-level anchors),
  **prompt adaptivity** (static Tier 1 vs per-family blocks), and
  **exemplar-free downgrade paths**.
- **Anti-recommendation**: do not adopt apply_patch as a default edit
  format. Measured 46-51% failure on non-OpenAI models; Codex only gets
  away with it via trained universe + gateway constraints.
- **Anti-recommendation**: don't add LangGraph-style graph orchestration;
  August's imperative loop already implements the useful edges (retry,
  fallback chain, promotion, stall-stop).

### Sources
- Hermes Function-Calling: <https://github.com/NousResearch/Hermes-Function-Calling>
- pi: <https://github.com/badlogic/pi-mono> (README, `src/core/system-prompt.ts`, `src/core/tools/edit.ts`)
- oh-my-pi: <https://github.com/can1357/oh-my-pi> (README); benchmark writeup
  <https://stencil.so/blog/the-harness-problem> (originally
  blog.can.ac/2026/02/12/the-harness-problem)
- Prime Agent: <https://github.com/PrimeIntellect-ai/prime-agent> (README,
  `docs/rlm.md`, `skills/refine/SKILL.md`)
- Codex CLI: <https://github.com/openai/codex> (`codex-rs/core/gpt_5_codex_prompt.md`,
  `prompt_with_apply_patch_instructions.md`)
- Claude Code prompts: <https://github.com/Piebald-AI/claude-code-system-prompts>
  (v2.1.227 extraction)
- Aider: <https://aider.chat/docs/more/edit-formats.html>,
  <https://aider.chat/docs/troubleshooting/edit-errors.html>
- SWE-agent: <https://github.com/SWE-agent/SWE-agent> (`config/bash_only.yaml`,
  `sweagent/agent/history_processors.py`)
- OpenHands: <https://github.com/OpenHands/software-agent-sdk>
  (`openhands-sdk/.../prompts/sections/static.py`, `llm/utils/model_prompt_spec.py`)
- Cline: <https://github.com/cline/cline> (`sdk/packages/shared/src/prompt/{system,cline}.ts`)
- smolagents: <https://github.com/huggingface/smolagents> (`src/smolagents/prompts/code_agent.yaml`)
- LangGraph: unverified at source this pass; claims limited to general
  knowledge and marked as such.
