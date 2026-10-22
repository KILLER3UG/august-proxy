# The `pi` harness — how the whole system fits together

**Repo:** `github.com/earendil-works/pi` @ `58c0b02` (MIT).
**Clone:** `%LOCALAPPDATA%\Temp\harness-research\pi` — shallow, read-only, never
built, never executed.
**Evidence:** every claim below is anchored to a `path:line` in the clone; the
per-file reading is in `docs/research/pi/shards/` and the per-file ledger is in
`docs/research/pi/manifest.tsv`.

---

## 1. The shape of the thing

`pi` is a **monorepo of libraries with one product on top**. The single most
important structural fact, recorded in the repo itself, is that the *harness*
was cut out of the agent package:

> `packages/agent/CHANGELOG.md:37` — the whole experimental harness (sessions,
> session storage, durable runtime, pico3, harness tools, compaction, skills,
> prompt templates, system-prompt helpers, telemetry schemas) was **removed from
> this package in 1.0.0**, leaving "only `Agent`, the agent loop, the proxy
> stream, and their types".

So `pi` is not one harness — it is a **loop** (`packages/agent`), a **wire layer**
(`packages/ai`), a **product** (`packages/coding-agent`), a **durability-first
alternative harness** (`packages/durable`), and four satellite subsystems
(`tui`, `codemode`, `env`, `chord`). The loop knows nothing about sessions,
compaction, skills or prompts; it exposes **hooks** so a host can supply them.

```
packages/ai          wire layer    — canonical messages, one adapter per protocol,
                                     capability negotiation, credentials, primitives
        ▲
packages/agent       the loop      — Agent + agentLoop(); prepare→validate→hook→
                                     execute→finalize; steering & follow-up queues;
                                     four injection hooks. NO sessions, NO prompts.
        ▲                              ▲
packages/coding-agent  the product  │  packages/durable   the durable harness
  core/ (session tree, tools,          │   harness/ (generation, scheduler,
  compaction, extensions, skills)      │   context, prompt patch, compaction)
  modes/interactive (TUI)              │   storage backends
  modes/headless, sdk, rpc             │
        ▲                              ▲
packages/tui         terminal UI substrate (no knowledge of agents/models/tools)
packages/codemode    model-written JS in a QuickJS/wasm VM
packages/env         remote execution env (Rust daemon, framed protocol)
packages/chord       distributed object runtime (CRDT-ish delta tracker)
packages/evals       measurement instrument
```

---

## 2. The loop (`packages/agent`)

`packages/agent/src/agent-loop.ts` is 959 lines and the whole turn engine.

**The turn lifecycle** is an explicit event sequence — `agent_start` →
`turn_start` → message/tool events → `turn_end` → `agent_end`. A thrown run
failure does not escape as an exception: `packages/agent/src/agent.ts:542-558`
synthesises an assistant message with `stopReason: "error" | "aborted"` and
emits the missing tail, so **the UI never has to special-case "the run died"**.

**The tool pipeline** is five ordered stages, and the *nesting* rule is the
part August cannot borrow without thinking: `packages/agent/src/agent-loop.ts:800-829`
exports `runToolCall()` — the **only** exported way to run one call — and its
docstring says why:

> "Tools that call other tools use this so the hooks (for example permission
> checks) apply to those calls too."

So a tool that calls a tool cannot escape the validation/hook pipeline. pi
makes the safe path the only path.

**Three safety rules that are stated separately, not one rule with modes:**

| Rule | Where | Formulation |
|---|---|---|
| A truncated message poisons its tool calls | `agent-loop.ts:274-279` | `stopReason === "length"` ⇒ **every** tool call in the message is failed, not executed. The stated reason: streamed arguments are finalised with a *best-effort JSON salvage parser*, so a truncated message can yield calls whose arguments **parse and validate but are silently incomplete**. |
| A batch ends only on unanimity | `agent-loop.ts:700-702` | `finalizedCalls.every(f => f.result.terminate === true)` — a mixed batch continues. `terminate` is reachable from `execute`, a blocked `beforeToolCall`, and an `afterToolCall` override, and is **runtime-only** (it never reaches the model). |
| The executable tool set and the declared tool set are diffed | `agent-loop.ts:342-372` | Before every request the two are compared and a system message carrying `toolsAdded`/`toolsRemoved` is inserted or merged into a pending system message. **The executable set wins** when a pending message claims a change the runtime does not support (`packages/agent/test/agent.test.ts:247-280`). |

**Two queues, two poll points.** `packages/agent/src/agent.ts:149-180`:
**steering** is polled after every turn (`agent-loop.ts:304`); **follow-up** only
when the agent would otherwise stop (`:311`). The queue mode (`"all"` vs
`"one-at-a-time"`) is a property of the *queue*, not of the loop. And the poll
itself is subtle — `agent-loop.ts:210-215`:

> "Preparation can be long-running (for example, compaction). Pick up steering
> queued while it ran. Only poll again if the earlier poll returned nothing;
> otherwise one-at-a-time mode would deliver two messages in this turn."

Steering is injected only **after every tool call of the current assistant
message has completed** (`:283-287`).

**Four injection hooks**, so the loop stays ignorant: `transformContext`,
`convertToLlm`, `prepareRequest` (runs before *every* provider request and can
replace the whole context — `agent-loop.ts:228-248`), `prepareNextTurn` (the
host's compaction hook) and `finishTurn` (turn-finalisation policy).
`prepareRequest` runs *after* pending input has been emitted, so it can
install a canonical persisted projection without causing a double-delivery.

`finishTurn` returns a **decision**, and a natural request satisfies it
(`agent-loop.ts:295-307`): `{action:"end"}` stops; `{action:"continue"}` ensures
**one** next provider request — "Tool-result, steering, or follow-up scheduling
can satisfy that request and adds no extra request" — so the loop keeps an
`explicitContinuation` flag and clears it when a natural request already
happened.

---

## 3. The wire layer (`packages/ai`)

A **provider-neutral LLM client** with one adapter per wire protocol under
`src/api/`: OpenAI Completions, OpenAI Responses, Azure Responses, Anthropic
Messages, Bedrock Converse, Google Gemini, Google Vertex, Mistral Converse,
Codex, pi-messages, plus three classifier protocols and one image protocol.

The organising idea is **capability negotiation**: every provider quirk is
expressed as a capability the caller can ask about, rather than as a branch
inside the request path. A **generated catalogue** of ~40 provider definitions
(`src/providers/`) and a **generated** set of JSON Schemas for settings, models,
keybindings and theme live in `repo-root` — generated means *there is a
generator and a drift gate*, not "hand-maintained".

Credentials are a **separate subsystem** (`src/auth/`): OAuth flows *and*
api-keys, with an in-memory store used by the eval harness.

The shared primitives under `src/utils/` are where the hard parts live: retry,
overflow detection, **JSON repair**, tool-argument validation, **transcript
algebra**, token estimation, client identity. `transcript.ts:55-96` is the
important one for August — system messages carry named `sections` and
`toolsAdded`/`toolsRemoved` **deltas**, replayed into the current state, so a
mid-run change is a diff in the log rather than a rewrite of history.

The test suite (`ai-provider-tests`, 185 files) is organised around **wire
protocols, not features**. Four layers recur: payload-capture tests that mock
the vendor SDK and assert the exact JSON body; live per-provider E2E sweeps;
eleven OAuth flows; and catalogue/generator validation. **"What does the
provider actually receive" is the unit of testing** — August's
`dump_openai_upstream_body` is the same instinct without the harness.

---

## 4. The product (`packages/coding-agent`)

**`core/agent-session.ts`** owns the run lifecycle: prompt intake, the two
queues, the request projection, compaction triggers, retry/backoff, the tool
loadout, and the dispatch of every event to extensions.

**The session store is an append-only JSONL tree** (`core/session-manager.ts`),
and the model context is a **projection computed from the tree**
(`buildSessionProjection`) — with `context_edit` entries that can omit or
rewrite an earlier entry's content. That is a genuinely different shape from
August's append-only *and archived* transcript: pi's tree is the truth and the
context is derived, so a branch is a second leaf on the same tree rather than a
copy.

**The prompt lives in the transcript**, not in a builder: the system message
carries named sections, and the tool loadout is a diff.

**The TUI** is `modes/interactive/interactive-mode.ts` — 7 082 lines, the hub
that owns the component tree, subscribes to `AgentSessionEvent`s and translates
them into rendered chat, a pending-queue area, status indicators and
tool-execution components, with ~45 leaf components and a four-file theme system
that can *generate* a theme from the terminal's own reported colours.

**The headless surface is a real protocol** (`modes/headless`, `rpc`, `sdk`) —
the same agent driven over JSON-RPC, which is how the SDK examples and the
`rpc-client.ts` / `rpc-extension-ui.ts` examples work.

**Extensions** are the extension mechanism, and the repo says the examples are
the implementation reference (`docs/extensions.md:386`): "The checked extension
examples … are the implementation reference." 119 example files under
`examples/extensions/` are the de-facto spec.

**`docs/` (42 pages) is the normative specification** of the loop, session
tree, compaction, tool exposure, MCP, providers, extension lifecycle,
RPC/JSON protocols, TUI and settings — the shard report for
`coding-agent-examples-docs` calls it exactly that.

---

## 5. The durable harness (`packages/durable`)

This is the part of pi most unlike August, and the part the prior research
(`docs/research/2026-10-21-simulide-and-pi-harness.md`) already flagged as
**not vendorable**: it self-describes as experimental, "the API changes without
notice", and admits "this is not exactly-once execution" — and
`pi-coding-agent` **does not depend on it at all**. The shipped CLI never uses
it.

Its shape: **every turn, tool call and piece of application state is committed
to storage before it is observable.** `harness/generation.ts` is the turn
(prepare → request → classify → tools); `harness/scheduler.ts` (2 507 lines)
is a durable task scheduler owning a task/conversation ownership tree, abort
cascades, wait-graph validation and crash recovery; `harness/context.ts`
derives the active transcript and model context from committed entries;
`harness/prompt.ts` plans the **minimal** system-prompt patch so the provider
prefix stays byte-cacheable; `harness/codemode.ts` is a model-written
JavaScript program that runs in a QuickJS sandbox and **survives a process
restart by deterministic replay from a journal**.

`packages/durable/docs/spec.md` is 5 618 lines and 13 sections — records,
documents, transactions, tasks, submissions/inbox, extensions/hooks/tools,
built-in tasks, document observation, storage contract, backends, API
footguns, non-goals. The CHANGELOG is the most honest document in the repo,
because every entry is written as "what broke, and what we changed".

---

## 6. Compaction — the strongest thing in pi

Cut points are chosen by **walking backwards from the newest entry
accumulating estimated tokens until `keepRecentTokens` (20 000), then snapping
forward to the nearest LEGAL cut** (`packages/coding-agent/src/core/compaction/compaction.ts:446-501`).
**Legal** means user/assistant/bashExecution/custom/summary and **never a
`toolResult`** (`:351-364`) — so a cut never separates a call from its result.

Other rules in the same file:

- **Split turns are first-class** (`isSplitTurn` + `turnStartIndex`, `:491-500`)
  and cost two LLM calls merged into one summary (`:980-1104`).
- **A summary over an existing summary switches to an explicit merge contract**
  with `<previous-summary>` and PRESERVE/MOVE rules (`:540-575`, `:714`) — the
  direct answer to "each note carries its predecessors as 600 characters".
- **A file-op ledger survives compaction**: the previous run's
  `readFiles`/`modifiedFiles` are re-seeded and re-emitted as
  `<read-files>`/`<modified-files>` (`:60-88`, `:1043-1044`).
- `prepareCompaction` returns **nothing** when the tail is already a compaction
  or no visible content precedes the cut (`:863`, `:901`;
  `durable/harness/compaction.ts:279-296`) — "a compaction that frees nothing"
  is refused rather than reported as a success.
- Usage captured before a later `context_edit`/compaction is **thrown away**
  rather than trusted (`:227-262`).

---

## 7. Repair at the provider boundary

`packages/ai/src/utils/transform-messages.ts:180-256` fixes a torn history
**deterministically before every request**: an orphaned tool call gets a
synthetic `isError` "No result provided"; errored/aborted assistant messages
are dropped; system messages are held so they never split a call from its
result. This is the same failure August hit live (a 400 on an orphaned
`tool_use_id` bricking every later turn) and August's answer is
`_stuckRequestEscape` — an **escalation across turns** off a strike ledger.
pi's arm is cheaper, deterministic, and needs no strike count.

---

## 8. The measurement instrument (`packages/evals`)

`packages/evals` is not part of the loop. It runs a **real pi coding agent
against a real model** and turns the result into a **paired A/B comparison with
a withheld-headline failure mode**. `src/harness.ts` boots an isolated
`AgentSession` — isolated HOME, isolated agent dir, in-memory credential store,
unprivileged UID drop — and returns transcript events, token usage and the
session file as harness artefacts. Scoring is by deterministic assertion (a
structured-submit tool called exactly once with a verdict), including a paired
`with_docs`/`without_docs` lift.

**This is the two-arm measurement August still does not have**, and it needs no
test suite to exist.

---

## 9. Gates

`repo-root` and `scripts-ci` (121 files) hold the machinery around the agent:
the monorepo build spine (Biome/tsc/Vitest, the `npm run check` chain, a
`test.sh` isolation harness, Nix packaging with a content-addressed model-catalog
pin, and a separate `install-lock/` giving the installer a pinned transitive
tree), the **dependency supply-chain policy** (exact pins, `min-release-age=2`,
a pre-commit lockfile gate), 12 `scripts/check-*.mjs` static gates, and a
staged release (build → smoke-test on three OSes → **draft** release → publish
to npm via OIDC → write a verified "latest version" marker → only then flip the
draft public, with a cleanup job that deletes the draft if anything upstream
failed).

`SECURITY.md` states the trust boundary in one sentence: **"pi runs with the
user's own permissions; containerize it if you need more."** There is no
approval gate anywhere in the core, by design; the human gate is an extension
(`examples/extensions/permission-gate.ts`), and `project_trust` gates only
startup resource loading. There is also **no read-before-edit gate** — grep for
`hasBeenRead` across `packages/**/*.ts` returns nothing.

---

## 10. Coverage summary

| | pi |
|---|---|
| Tracked files (`git ls-files`) | 1 987 |
| In manifest | 1 987 (0 missing, 0 extra, 0 duplicate) |
| Shards | 17 |
| Files marked `read` | 1 777 |
| Files marked `skipped` (with a stated reason) | 25 |
| Unresolved | 185 — **all in `packages/durable/src/harness/`**, see below |
| Shard reports | 17 / 17 |
| `path:line` citations in the reports, re-checked against the clone | **696 checked, 0 bad** |
| Reports spot-checked by reopening the source | 4 of 17 (23 % — above the 10 % floor) |

### The one gap, and why it happened

`durable#1` and `durable#2` (219 files between them) were short by 185 files.
The cause is recorded rather than guessed: **a shard worker re-partitioned the
manifest** — it rewrote `manifest.tsv`'s `owner-shard` column into 62 shards
of its own devising, and rewrote `shard-sizes.tsv` into a different format
entirely. A worker that read the manifest *after* that rewrite then found a
5-file shard where there should have been 89.

This is exactly the failure the ledger is designed to catch, and it was caught:
the gate reported `UNRESOLVED: 185` and named the files. The manifest was
restored from git, **all six ledger files were then set read-only** so a worker
cannot rewrite them again, and the two shards were re-dispatched against the
restored partition.

**Every skipped file has a stated reason** and none was skipped silently. The
skips are generated JSON Schemas, compiled native prebuilds, lockfiles and
i18n YAML — all listed in the manifest with a one-line justification.
