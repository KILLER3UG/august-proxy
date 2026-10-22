# Harness research — status

**Objective.** Exhaustive deep-dive of three repos (Pi harness, SimulIDE, DeepSeek
harness) and evidence-based improvement proposals for the August harness.
**Research only — no August source code is modified by this work.**

**Clones** (shallow, read-only, treated as untrusted; never installed, built, or
executed):

| Repo | Origin | Commit | Tracked files |
|---|---|---|---|
| Pi harness | `github.com/earendil-works/pi` | `58c0b02` | 1 987 |
| SimulIDE | `github.com/Arcachofo/SimulIDE-dev` | `a7d9fc9` | 1 359 |
| DeepSeek harness | `github.com/deepseek-ai/deepseek-harness` | `687f282` | 16 297 |

Location: `%LOCALAPPDATA%\Temp\harness-research\{pi,simulide,deepseek-harness}`

---

## Phase status

| Phase | Scope | State |
|---|---|---|
| 0 | August baseline — read August's own areas, write `docs/research/august-baseline.md` | **done** |
| 1 | Coverage ledger — `manifest.tsv` per repo, every tracked file classified and sharded | **done** |
| 2 | Parallel subagent deep-dive, one subagent per shard | **in progress** |
| 3 | Verification gate — lead re-diffs, spot-checks 10 %, writes `ARCHITECTURE.md` per repo | **partial** (pi spot-check in progress) |
| 4 | `docs/research/AUGUST-IMPROVEMENTS.md` with ranked top-5 | pending |

### Phase 0 — the August baseline (done)

`docs/research/august-baseline.md`. Built from three prior August audits already
in the repo, then **corrected by three independent first-hand read-only
surveys** of the live tree (chat/proxy loop + streaming + provider routing +
settings shell; tool loop + registry + subagents + sandbox + system prompt;
memory + recall + consolidation + skills + compaction). The surveys changed the
baseline in several places that matter:

- **"Five-layer memory" is a doc claim with zero code behind it.** It exists in
  three June-2026 design specs; `cognitive_config.py:217` deletes
  `cognitive_layers` and `cognitive_boot.py:3` says the layers were removed.
  The real system is **one SQLite file with seven surfaces**.
- **`AGENTS.md`/`docs/ARCHITECTURE.md`'s "the parent turn is the single memory
  write door" is FALSE** — `save_fact(` has **8** call sites.
- **153 registered tools** (AST count), not "~180".
- **Progressive disclosure activates on a token budget** (10 % of the model
  window), not a tool count — the bridge's "≥ 200 tools" comment is false.
- **The system prompt is ~2.5–3.5 k tokens, not the 9 422 the old gap analysis
  claims** (that document's own breakdown sums to 13 256). The **tool
  definitions are 6 911 tok — 3× the prompt** and are the real cost.
- **The Windows sandbox is soft, and `enforcement_report()` can claim
  `strong=True` while every command runs soft.**
- **The code-mode ↔ hardline parity gate is gone** (deleted with the suite on
  2026-10-17). The port is real; the drift check is not.
- **Four stale comments** describe a state the code no longer has
  (`loop/guards.py:45-46,81-83`; `workbench.py:5848-5852`;
  `settings-registry.ts:7`; `workbench.py:1050`).

### Phase 2 — running note (concurrency)

The runtime enforces a **global 8-active-child limit** across *all* workflows
and *all* `subagent` calls. Two workflows running concurrently collide: when
one advances to its next batch it cannot start its children because the other
holds the pool, and the batch is lost. The first pi run lost 12 of its 17
shards to exactly this. **Phase 2 therefore runs as ONE queue at concurrency 7**,
with a per-batch try/catch, and the failed set is re-dispatched at the end.

### Phase 3 — spot-check tooling (partial)

`scripts/research/check-citations.mjs` parses every `path:line` citation in a
shard report and reopens the file in the clone to confirm the line exists and
is in range. First run over the six completed pi shard reports: **277
citations checked, 0 bad**. A manual re-read then confirmed that four specific
*claims* are true at their cited lines (length-truncated tool calls refused at
`packages/agent/src/agent-loop.ts:274-279`; the executable-vs-declared tool
diff at `:342`; terminate-unanimity at `:700-702`; a truncated proxy stream
becoming an error at `packages/agent/src/proxy.ts:219-230`).

## Phase 1 — coverage ledger (done)

`git ls-files` was reconciled against every manifest row. For all three repos:
**0 missing, 0 extra, 0 duplicate paths, every file in exactly one shard.**

| Repo | Files | Total | Readable | Shards | Max readable bytes/shard |
|---|---|---|---|---|---|
| pi | 1 987 | 24.3 MB | 21.2 MB | 17 | 2.3 MB |
| simulide | 1 359 | 12.2 MB | 10.1 MB | 10 | 2.5 MB |
| deepseek-harness | 16 297 | 127.0 MB | 95.7 MB | 88 | 2.5 MB |
| **Total** | **19 643** | **163.5 MB** | **127.0 MB** | **115** | — |

"Readable" excludes generated/vendored/binary payloads (1 842 DSH generated files,
DSH `snapshots/`, `vendor/`, `native/`, `*.schema.json`, lockfiles, `.i18n.yaml`,
`patches/`, `website/`; SimulIDE/pi assets). Those are still enumerated row by row
in the manifest and must be marked `skipped` **with a one-line justification** —
never silently dropped.

Type distribution:

| Repo | source | config | docs | tests | examples | build-CI | assets | generated-vendored |
|---|---|---|---|---|---|---|---|---|
| pi | 766 | 70 | 80 | 828 | 134 | 97 | 6 | 6 |
| simulide | 952 | 2 | 163 | 0 | 0 | 3 | 239 | 0 |
| deepseek-harness | 3 338 | 3 239 | 3 931 | 3 523 | 27 | 311 | 86 | 1 842 |

## Prior research this work builds on (not redone)

- `docs/research/2026-10-21-simulide-and-pi-harness.md` — two full dive passes over
  SimulIDE and pi, with corrections (§A9–A12, B9–B10) and a "must NOT be copied"
  list. **Reused, not repeated.**
- `docs/research/2026-10-21-deep-dive-and-cleanup.md` — an August-side review
  (architecture, tool/permission stack, memory, gates, dead code). Its findings
  feed the Phase 0 baseline.
- `docs/plans/ui-refactor/research/2026-10-03-reference-deepseek-harness.md` — a DSH
  **UI** study from the local install, not the source repo.
- `docs/plans/2026-10-15-harness-reference-dsbot-abacus.md` — DS Bot / abacus
  reference dive.

## Tooling

- `scripts/research/build-ledger.mjs` — rebuilds the manifest and shard partition
  from `git ls-files` + `stat` only. Never executes repository code.
- `scripts/research/verify-manifest.mjs` — reconciles a manifest against
  `git ls-files` and reports shard balance.
### Phase 3 — re-dispatch list (accumulated)

| Repo | Shard | Why | Action |
|---|---|---|---|
| pi | durable#1 | 84 of 89 files short — the worker read a re-partitioned manifest | re-dispatch against the restored partition |
| pi | durable#2 | 101 of 130 files short — same cause | re-dispatch |
| simulide | components-analog | 101 of 183 files short — same cause | re-dispatch |
| simulide | gui | 1 bad citation: src/gui/properties/proputils.cpp:99 in a 78-line file | correct the reference |
| simulide | resources#2 | 1 bad citation: src/components/component.cpp:1260 in a 722-line file | correct the reference |
| deepseek-harness | dsh-apps-cli | 44 files carry a ledger note but no report mention | top-up the per-file notes |
| deepseek-harness | dsh-client-chat#1 | 40 files carry a ledger note but no report mention | top-up |
| deepseek-harness | dsh-client-primitives#2 | 43 files carry a ledger note but no report mention | top-up |
| deepseek-harness | dsh-client-chat#2 | 2 files | top-up |
| deepseek-harness | dsh-client-agents-ui | 1 file | top-up |
| deepseek-harness | dsh-apps-web#3 | 6 files | top-up |

### Phase 2 — progress

| Repo | Shards read | Files read | Files skipped (with reason) | Unresolved |
|---|---|---|---|---|
| pi | 17 / 17 | 1 777 | 25 | 185 (durable) |
| simulide | 10 / 10 | 1 247 | 11 | 101 (components-analog) |
| deepseek-harness | 46 / 88 (in flight) | — | — | — |

Citation verification so far: pi **495 checked, 0 bad**; simulide **399 checked,
2 bad** (both in the re-dispatch list); deepseek-harness **543 checked, 0 bad**.
Every path:line a worker cited was reopened in the clone and confirmed to be
an in-range line in a real file. Four specific *claims* were additionally
re-read by hand at their cited lines and confirmed true.
