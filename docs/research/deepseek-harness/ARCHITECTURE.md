# The DeepSeek harness — how the whole system fits together

**Repo:** `github.com/deepseek-ai/deepseek-harness` @ `687f282` (MIT).
**Clone:** `%LOCALAPPDATA%\Temp\harness-research\deepseek-harness` — shallow,
read-only, never built, never executed.
**Evidence:** every claim below is anchored to a `path:line` in the clone; the
per-file reading is in `docs/research/deepseek-harness/shards/` and the
per-file ledger is in `docs/research/deepseek-harness/manifest.tsv`.

> **This repo is not one harness — it is a platform.** The tagline is
> "Everything is a Plugin", and the code is organised as a set of *seams*
> (an abstract service on a context object) with one or more shipped backends
> behind each. Almost every interesting idea in it is a decision about **where
> the seam is**, not about what the agent loop does.

---

## 1. The shape of the thing

```
                       apps/desktop (Electron)   apps/web (Vite)   apps/cli (dsh)
                              │                       │                  │
                              └──────────┬────────────┴──────────────────┘
                                         │  profile = an ordered stack of
                                         │  plugin-bundle patch layers
                              packages/boot + packages/bundle
                                         │
     packages/core ──────────────────────┼────────────── the API spine
       scope/   session/   system-prompt/   tools/   agent/   agent-loop/
         │         │            │            │         │          │
     packages/session   packages/llm   packages/compaction
     (durable log,     (provider-     (a SEAM + a shipped backend
      format chain)     neutral svc)    + a model-free pruner)
         │
     packages/extensions  (the "Cordis" dynamic-plugin subsystem:
         │                 host half + client half, node:vm sandbox,
         │                 an approval round trip)
         │
   packages/{subagent,sandbox,fs,shell,terminal,subprocess,workflow,
             interaction,guard,plan,preset,mcp,lsp,web,jobs,deliverables,
             feedback,attachment,credentials,context,skill,todo,goal,spill}
         │
   packages/platform  (util, typert, host, telemetry, identity, workspace, settings)
   packages/ptc-runtime  (a model-written program against host bindings,
                         in a sandboxed child process)
   packages/client/*    (the browser UI plugin layer: each plugin is a
                         node half + a browser half)
   native/system        (a Linux Landlock launcher + a Node-API flock binding)
   .agents/notes/       (the decision-record system)
   .agents/skills/      (the repo's own agent-facing instruction set)
```

**The vocabulary that explains the whole thing:**

| Term | Meaning |
|---|---|
| **seam** | An abstract service on a context object (`ctx.compaction`, `ctx.ptcRuntime`, `ctx.sidebarRight`). The seam owns the *vocabulary*; a backend owns the *behaviour*. |
| **profile** | A directory. A **bundle** is a YAML patch layer. The **composition** is the ordered stack of layers over an empty root. |
| **plugin** | A package with a node half (usually an inert `apply()` loader seat) and a browser half. `ctx.effect()` owns teardown ordering. |
| **scope** | The isolation primitive: a tagged Cordis sub-context plus an event-routing carrier. Registration views inherit *down* the scope chain; event admission extends *up* it. |
| **Agent Note** | The decision-record format: `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`, with a closed skeleton — Problem → Decision → Alternatives considered → Consequences, plus Testing/Verification where there is evidence. |

---

## 2. The API spine (`packages/core/`)

Eight packages, and every composition depends on them.

- **`scope/`** — the isolation primitive.
- **`session/`** — the **append-only, event-sourced log** every conversation is
  derived from. "Compaction" is a *logged replacement*, not a delete.
- **`system-prompt/`** — assembles the ordered prompt from registered
  sections, variables and tool schemas. `orderTools` (`packages/core/system-prompt/src/index.ts:674`)
  **canonicalises the model-facing tool order** so registration order cannot
  leak downstream: registering `zulu, alpha, mike` in any order produces the
  same header.
- **`tools/`** — the registry and the **six-stage execution pipeline**.
- **`agent/`** — the public `Agent` handle, its registry, and the event
  dispatch (`packages/core/agent/src/dispatch.ts:107` keeps a *fused*
  dispatcher so an event's subject and its scope key cannot diverge).
- **`agent-loop/`** — the one concrete driver.

**The agent loop's shape**, from `packages/core/`:

| Rule | Where | Formulation |
|---|---|---|
| ~~A truncated message poisons its tool calls~~ | — | **Not a DSH rule.** That mechanism is pi's (`failToolCallsFromTruncatedMessage`, `packages/agent/src/agent-loop.ts:278,488`); DSH's loop makes `max-tokens` sticky and ends the turn (`packages/core/agent-loop/src/agent.ts:338-343,547`) but does not fail the message's calls. The row was copied across from pi. |
| A tool failure is a result, never an exception | `packages/core/tools/src/index.ts:1917` `toolErrorResult` | the content is exactly `Error: <message>`; the structured name/code live **beside** it, never in the model-visible text. Unknown tools, throwing tools, hostile thrown values, wrapper failures, post-policy failures and timeouts all resolve to an `isError` result. |
| Parallel tools commit in **model** order | `packages/core/tools` | a bounded parallel pool that commits results in *model* order and **reclassifies pending calls before they start** |
| Concurrency is classified fail-closed | `packages/core/tools` | only an exact `true` from the tool's own classifier means "parallel-safe" |
| A changed system prompt is admitted by the route's capability | `packages/core/agent-loop/src/runtime-context.ts:88` | with `systemPromptUpdate: 'in-history'` a changed prompt is **appended after the cached history**, so the prefix through that history stays reusable; on an incapable route it is consolidated at node 0 |
| The request header is logged as a full canonical snapshot, only when it changed | `packages/core/agent-loop` | then the request can be reconstructed from the log alone |
| The model is told when its own earlier turns came from a different model | `packages/core/agent/src/model-selection.ts:113` | — |
| A "consumed work" fold a turn cannot fake | `packages/core/agent/src/consumed-work.ts:69` `foldConsumedWork` | — |
| Cancellations distinguish "not attempted" from "attempted and interrupted" | `packages/core/tools/src/index.ts:1966` | — |
| A policy denial is unreversible, and the monotonic guard sits **after** the extensible waterfall | `packages/core/tools/src/index.ts` | — |
| Attribution is process-local and says so | `packages/core/agent` | an `AsyncLocalStorage` initiator scope, "and say plainly that it is process-local" |

---

## 3. The durable session data plane (`packages/session/`)

Four families, bottom-up:

1. **A format chain.** One pure library (`session-format`) compiles a unique,
   gap-free chain of *adjacent* format migrations, plus four frozen edge
   packages (`v0→v1`, `v1→v2`, `v2→v3`, `v3→v4`) and a build-static
   `session-format-catalog` that assembles them into one reader. **The point
   is that a log written by any released harness version is still readable
   losslessly, one physical row at a time, without ever materialising the old
   format in memory.**
2. The write path (batched, durable).
3. The projection path (per-session projection caches, packed chunk
   transport, conversation-node assembly).
4. The query path.

**This is the piece most worth comparing against August.** August's
transcript is append-only **and archived**, with the archive as a second
source of truth; DSH's is a single event-sourced log with a *migration chain*,
so there is exactly one truth and the old shape is computed on read.

---

## 4. Compaction is a seam (`packages/compaction/`)

Five packages:

- **`compaction/`** — the **seam**: an abstract `CompactionEngine` service on
  `ctx.compaction`, the `compaction/*` session-event vocabulary, the
  **tool-pairing boundary helpers**, and the `compact-checkpoint` message
  marker.
- **`compaction-basic/`** — the shipped backend: a pressure policy resolved
  per routed model, the LLM summarizer, and the **bracket-first region
  transaction**.
- **`compaction-tool-result-pruner/`** — an optional **model-free** pruner.

**Bracket-first** is the idea worth taking: a region is bracketed by its
*boundaries* (a tool call and its result) before anything is cut, so a cut can
never separate them. pi arrives at the same rule by a token walk that snaps
forward to the nearest legal cut; August already has tool-pair-safe units but
says so nowhere.

---

## 5. The wire layer (`packages/llm/`)

One provider-neutral service (`llm`: the message/content-block/stream-chunk
vocabulary, the adapter registry, the configurable-provider directory, the
streaming boundary) and **two structurally different adapters** over it:
`llm-deepseek` (a direct Messages-wire implementation with its own serializer,
SSE translator, vision-token calculator) and `llm-pi-*`. The point of two
*structurally different* adapters over one service is that a provider with
real quirks does not have to be bent into the shape of a provider that has
none.

---

## 6. The plugin system (`packages/extensions/`, the "Cordis" family)

- **`cordis-host-runner`** — the host half: a process-local registry of
  immutable "packages" (versions of a dynamic plugin), a **`node:vm` sandbox**
  in which a model's host-half code is evaluated, a registration guard
  (schema normalisation, a whitelisting `ctx` facade, a marker-guarded
  tool-registration pair), and **the approval round trip that suspends a run
  until a human says yes**.
- **`cordis-client-runner`** — the browser half: evaluates the browser half as
  a closure.

`packages/platform#1` is the rest of the platform layer: `packages/host/` (the
web-GUI host half), `packages/settings/`, `packages/identity/`.

**Two rules from the notes that generalise:**

- *"A delegated child must not see the delegation tools"* —
  `packages/bundle/web-app/README.md:60`: "The `tool-subagent` and
  `tool-subagent-fork` rows in those presets **deny** the four tools, so a
  delegated child's scope never lists them." Denying at the *advertisement*
  level, rather than at call time, is what keeps a child's schema small and
  its scope unambiguous.
- *"Subagent locality is decided by one snapshotted flag, never by names or
  lineage"* — `packages/sdk/server/src/server.ts:129-147`: "The service
  snapshots the provider name and local flag through child disposal; matching
  ids or parent lineage alone never establishes locality."

---

## 7. The edges (`packages/interaction/`, `packages/guard/`, `packages/remote-ptc`)

- **`packages/guard/`** — two loop-hygiene plugins: `repeat-tool-reminder`
  (an **advisory** detector for identical repeated tool calls) and
  `timeout-policy` (a cooperative per-tool-call deadline).
- **`packages/interaction/`** — the human-collaboration plane: `commands`
  (slash commands that run *without* a model round trip), `user-approval`
  (one-shot allow/reject with a per-session policy), `permission-presets`.
- **`packages/ptc-runtime/`** — the PTC execution seam: a model-written
  program running against host-provided async bindings inside a sandboxed
  child process, with a request/spec/result vocabulary, an **orthogonal
  failure taxonomy**, and portable-identifier exclusion sets.
- **`native/system/`** — the harness's only native code: a Linux **Landlock
  launcher** (a static musl C11 executable that confines a subprocess by
  self-restricting then `exec`ing) and a **Node-API v8 `flock`** binding.

---

## 8. The clients

`packages/client/*` is a **plugin-per-surface** layer: `ui-chat`,
`ui-conversation`, `ui-tool`, `ui-trajectory`, `ui-approval`, `ui-plan`,
`ui-subagent`, `ui-goal`, `ui-schedule`, `ui-user-questions`, `ui-settings*`,
`ui-sidebar-*`, `ui-primitives`, `ui-dockkit`, `ui-commands`, `ui-theme`,
`ui-layout`, `ui-renderer`, `ui-deliverables`, `ui-plugin-manager`, … Each is
a Cordis plugin with a **node half** (often an inert `apply()` loader seat)
and a **browser half**, and each ships a README that states its *Model
Experience* and *KV Cache effect* — `ui-chat`'s README says "Model Experience:
None / KV Cache effect: None": it never assembles or mutates a provider
request. That declaration is itself a useful discipline.

`ui-chat` is a **pure read-only projection**: durable Session events → typed
Chat Nodes, with an incremental keyed conversation assembly.

`ui-primitives` holds the renderers for **untrusted model output**: a
hand-written mdast→React markdown pipeline with an *incremental* streaming
parser, KaTeX, a lazy shiki highlighter, and an ANSI terminal replayer.

---

## 9. The decision-record system (`.agents/notes/`)

The single most distinctive thing in the repo, and it is **prose, not code**.

- **Format:** `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`, with a closed
  skeleton enforced by a gate — `## Problem` / `## Decision` / `## Alternatives
  considered` / `## Consequences`, plus `## Testing` or `## Verification` where
  the note has evidence. The archive is **sealed**: `manifest.json` carries a
  SHA-256 for every entry.
- **Bilingual:** every English note has a `.zh.md` translation and an
  `.i18n.yaml` sidecar that records a **per-heading hash** proving the two
  languages' blocks match. The sidecar is generated, and the pairing is a
  gate.
- **Lifecycles:** `proposed` / `implemented` / `archived` / `rejected`.
  **The `rejected/` directory is part of the design** — 24 notes record what
  was considered and declined, and what it would have cost.
- **The load-bearing sections are *Alternatives considered* and
  *Consequences*** — what was rejected and why, and the cost the decision
  accepted. Most notes quote a measurement, a reproduction, or an explicit
  "verified fail-before" line, and several carry a table of accepted residual
  costs.

**The archived corpus is 185 architecture notes, 182 bug-fix notes, 306
feature notes and 120 process notes** (English `.md` under
`.agents/notes/archived/<category>/`, counted with `git ls-files`; the earlier
87/87/86/86 figure was wrong) — roughly 790 shipped decisions, each with its
alternatives. It is the best single artefact in any of the three repos: a
harness that explains itself in the past tense, with the rejected options
still on file.

`.agents/skills/` is the repo's own agent-facing instruction set (41 files:
prose standards, documentation templates, CI reliability, code review, error
handling, UI/UX rules, performance work, a "trim CoT leakage" audit, bilingual
translation, and a browser-GIF recorder with a real ffmpeg encoder).

---

## 10. The UI, from the study that preceded this one

The prior study (`docs/plans/ui-refactor/research/2026-10-03-reference-deepseek-harness.md`)
read the **shipped app**, not the source, and its findings still hold and are
consistent with what the source shows:

- **Reasoning and tool activity are process groups** — collapsible cards that
  fold completed turns without ever hiding the final answer. Collapsed title:
  *"Thought for a while"* with activity rollups ("{count} tool calls · {count}
  messages · {count} subagents", separator " · "), completed header "Completed
  in {duration}"; the running state is *"Deep diving" / "Deep diving for
  {duration} ···"*.
- **A "Work details" dial** — Compact / Standard / Detailed / Verbose —
  progressive disclosure as a single user setting.
- **A right sidebar that is a real docking system** (`dockkit`): one persisted
  surface per session, tab capsules, max two horizontal panes, float/dock,
  fullscreen presentation; layout stored per session as
  `dsh.sidebar-right.v1.<sessionId>` in localStorage, replayable, with the
  layout restored *before* the bodies render.
- **A three-column AppFrame** with a ladder that protects the centre column:
  shrink the right panel to 300 px → auto-close it → only then compress the
  centre below 400 px.
- **No icon font** — inline React SVG components in `dsh-client-ui-primitives`,
  size-neutral with two weights: `Regular` (1 px stroke) and `Medium`
  (1.3 px stroke), the same geometry, rendered size via prop.
- **Alias-token architecture** — 75 `--dsw-alias-*` semantic names resolved per
  theme, with `--dsw-*` tokens as "the sole color authority".

---

## 11. The evidence for the proposals

The DSH shard reports produced **718+ "ideas worth stealing"** before the
final pass, of which the ones that survived the baseline check are in
`docs/research/AUGUST-IMPROVEMENTS.md`. The load-bearing ones for August:

| Idea | Where |
|---|---|
| Keep the prompt prefix byte-identical across a tool-registry change; derive the transcript's tool history from the **wire**, not from the model | `apps/cli/tests/profiles/sdk/dynamic-tool-cache.e2e.ts:142-163` |
| A prefix that must stay cache-stable **must be asserted as stable** | `apps/web/tests/chat-continuous-conversation.e2e.ts:341-342` |
| Prove prefix stability against the **real provider**, not only in mocks | `packages/core/agent-loop/tests/request-cache.e2e.ts:74` |
| A liveness signal that counts **buffered writes**, not just pings | `packages/api/gateway/src/stream-server.ts:114` |
| Every stream carries a byte-bounded inbox, and overflow **fails the stream, not the process** | `packages/api/gateway/src/stream-server.ts:61` |
| Every tool failure becomes a structured, frozen `isError` result | `packages/core/tools/src/index.ts:1917` |
| A conservative synthetic tool result when a call's outcome is unknown, with a retry contract | `packages/core/session/src/repair.ts:32` |
| A delegated child must not see the delegation tools | `packages/bundle/web-app/README.md:60` |
| Drain the children before the parents | `packages/acp/acp/src/session.ts:461` |
| `__proto__` is a legal env var and a legal header name — keep it as data | `packages/acp/acp/src/mcp.ts:82-84` |
| The output-limit notice names the recovery verb and promises the earlier output survived | `apps/web/tests/expected/max-tokens-notice/history-turn.expected.txt:1-3` |

---

## 12. Coverage summary

| | deepseek-harness |
|---|---|
| Tracked files (`git ls-files`) | 16 297 |
| In manifest | 16 297 — **0 missing, 0 extra, 0 duplicate**, every file in exactly one shard |
| Shards | 88 |
| Shard reports | 88 / 88 |
| Files marked `read` | **16 139** |
| Files marked `skipped` (each with a one-line justification) | **158** |
| **Unresolved** | **0** |
| Rows with no note | 0 |
| Skipped rows with no reason | 0 |
| `path:line` citations re-checked against the clone | **2 014 checked, 0 bad** |
| Reports spot-checked by reopening the source | 12 of 88 (14 % — above the 10 % floor), plus every citation in every report |

**The skips are all generated, vendored or binary, and each is justified
individually** — 8 generated golden tool-schema catalogues, 8 binary OOXML
packages, 18-line and 22-line generated goldens, binary fixtures, the
`pnpm-lock.yaml`, the `*.i18n.yaml` bilingual hash sidecars, the `patches/`
tree, `snapshots/` (1 681 session/web/sdk/acp fixtures), `vendor/`, `native/`
and the `*.schema.json` session-format schemas. **None was dropped silently.**

**The one substantive gap, recorded rather than guessed.** Three shards
(`dsh-notes-arch-feature#1`, `dsh-notes-archived-rest#2`,
`dsh-notes-arch-feature#3`) first came back with a ledger complete but a
*report* that narrated only part of the file set — the English Agent Notes
were covered while their `.zh.md` translations and `.i18n.yaml` pairing
sidecars were not, and in `simplification/` 73 English notes were not
narrated at all. The affected shards were re-dispatched as a completion pass
with an explicit instruction to cover every file, and the ledger was
re-verified. The re-dispatch also surfaced the finding that became proposal 2
(`2026-07-20-unwrap-injected-content-envelopes.md`).

**A separate incident, recorded because the ledger is what caught it.** A shard
worker in an early pass **rewrote `manifest.tsv`'s `owner-shard` column** into
62 shards of its own devising, and rewrote `shard-sizes.tsv` into a different
format. Two pi shards and one SimulIDE shard then read the corrupted manifest
and resolved 5 files where there should have been 89. The gate caught it
(`UNRESOLVED: 185`, naming the files), the manifest was restored from git,
**all six ledger files were then set read-only** so a worker cannot rewrite
them again, and the affected shards were re-dispatched against the restored
partition. Every subsequent pass was instructed not to touch the manifest.

