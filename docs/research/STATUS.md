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

## Phase status — **all four phases complete**

| Phase | Scope | State |
|---|---|---|
| 0 | August baseline — read August's own areas, write `docs/research/august-baseline.md` | **done** |
| 1 | Coverage ledger — `manifest.tsv` per repo, every tracked file classified and sharded | **done** |
| 2 | Parallel subagent deep-dive, one subagent per shard | **done** |
| 3 | Verification gate — lead re-diffs, spot-checks, writes `ARCHITECTURE.md` per repo | **done** |
| 4 | `docs/research/AUGUST-IMPROVEMENTS.md` with a ranked top-5 | **done** |

---

## The coverage numbers

| Repo | Tracked files | Shards | Reports | Read | Skipped (with a reason) | **Unresolved** | Citations checked | Bad citations |
|---|---|---|---|---|---|---|---|---|
| pi | 1 987 | 17 | 17 / 17 | 1 962 | 25 | **0** | 527 | **0** |
| simulide | 1 359 | 10 | 10 / 10 | 1 348 | 11 | **0** | 613 | **0** |
| deepseek-harness | 16 297 | 88 | 88 / 88 | 16 139 | 158 | **0** | 2 014 | **0** |
| **Total** | **19 643** | **115** | **115 / 115** | **19 449** | **194** | **0** | **3 154** | **0** |

Every one of the 19 643 tracked files is in the manifest, in exactly one
shard, and carries a status of `read` or `skipped` **with a one-line
justification**. Zero rows lack a note. Zero shards lack a report.

## What the gate actually did

`scripts/research/merge-rows.mjs` reconciles each manifest against
`git ls-files` and fails on any file that is neither `read` nor
`skipped`-with-a-reason. It reported:

```
pi               tracked=1987  rows=1987   UNRESOLVED: 0   skipped w/o reason: 0   read w/o note: 0
simulide         tracked=1359  rows=1359   UNRESOLVED: 0   skipped w/o reason: 0   read w/o note: 0
deepseek-harness tracked=16297 rows=16297  UNRESOLVED: 0   skipped w/o reason: 0   read w/o note: 0
```

`scripts/research/check-citations.mjs` parses every `path:line` a shard report
cites, reopens the file in the clone, and confirms the line exists and is in
range — and separately confirms that every file in the shard's ledger is
mentioned in its report. **3 154 citations, 0 bad.**

> **What that number does and does not mean.** The verifier checks that the
> cited LINE NUMBER exists — never that the line says what the shard claims — so
> a right-line/wrong-fact citation passes. It also silently skips a citation
> whose basename is ambiguous or absent from the manifest: roughly 3 700
> occurrences (≈475 pi, ≈259 SimulIDE, ≈2 998 DeepSeek harness), over half of
> that repo's citations. It scans `shards/*.md` and their `.rows.tsv` only, not
> `STATUS.md`, `IDEAS.md` or `AUGUST-IMPROVEMENTS.md`, so it verifies no August
> claim at all; it needs the `%TEMP%` clones and is not wired into `package.json`
> or CI. "0 bad" means "0 citations pointed past the end of a file".

Beyond the automated check, four claims were re-read **by hand** at their
cited lines and confirmed true:

- `packages/agent/src/agent-loop.ts:274-279` — a length-truncated message
  fails every tool call in it rather than executing it;
- `packages/agent/src/agent-loop.ts:342` — the executable-vs-declared tool
  diff;
- `packages/agent/src/agent-loop.ts:700-702` — a batch terminates only on
  unanimity;
- `packages/agent/src/proxy.ts:219-230` — a proxy stream that ends without a
  terminal event becomes an error.

### What the gate caught, and what it cost

Three defects, all recorded rather than guessed:

1. **A shard worker rewrote the manifest.** It replaced `manifest.tsv`'s
   `owner-shard` column with 62 shards of its own devising and rewrote
   `shard-sizes.tsv` into a different format. Three shards that read the
   corrupted manifest then resolved a fraction of their files (pi
   `durable#1` 5 of 89, pi `durable#2` 29 of 130, SimulIDE
   `components-analog` 82 of 183) — **286 files short**. The gate named
   every one of them. The manifest was restored from git, **all six ledger
   files were then set read-only** so a worker cannot rewrite them again,
   and the three shards were re-dispatched against the restored partition.
2. **Two bad citations** in SimulIDE (`gui`, `resources#2`) — both shards
   re-dispatched, both now verify.
3. **Six DSH shards** had a complete ledger but a report that narrated only
   part of the file set. Re-dispatched as a completion pass. That pass is
   where the finding behind proposal 2 came from.

**Re-dispatched shards: 17** (3 manifest-corruption victims, 2 bad-citation
shards, 6 DSH narrative gaps, 3 DSH shards that produced no output, 3 more
DSH gaps). All now verify.

### The concurrency lesson

The runtime enforces a **global 8-active-child limit** across all workflows
and all `subagent` calls. Two workflows running concurrently collide: when one
advances to its next batch it cannot start its children because the other
holds the pool, and the batch is silently lost — the first pi run lost 12 of
17 shards to exactly this. **Phase 2 therefore ran as a single queue**, and
the re-dispatch as a second, each with a per-batch try/catch and the failed
set re-collected.

---

## Phase 0 — the August baseline

`docs/research/august-baseline.md`. Built from three prior August audits
already in the repo, then **corrected by three independent first-hand
read-only surveys** of the live tree. The surveys changed the baseline in
several places that matter:

- **"Five-layer memory" is a doc claim with zero code behind it.** It exists
  in three June-2026 design specs; `cognitive_config.py:217` deletes
  `cognitive_layers` and `cognitive_boot.py:3` says the layers were removed.
  The real system is **one SQLite file with seven surfaces**.
- **`AGENTS.md`/`docs/ARCHITECTURE.md`'s "the parent turn is the single memory
  write door" is FALSE** — `save_fact(` has **8** call sites.
- **153 registered tools** (AST count), not "~180".
- **Progressive disclosure activates on a token budget** (10 % of the model
  window), not a tool count — the bridge's "≥ 200 tools" comment is false.
- **The system prompt is ~2.5–3.5 k tokens, not the 9 422 the old gap
  analysis claims** (that document's own breakdown sums to 13 256). The **tool
  definitions are 6 911 tok — 3× the prompt** and are the real cost.
- **The Windows sandbox is soft, and `enforcement_report()` can claim
  `strong=True` while every command runs soft.**
- **The code-mode ↔ hardline parity gate is gone** (deleted with the suite on
  2026-10-17). The port is real; the drift check is not.
- **The worker prompt says "Do not spawn further sub-agents" while the
  mechanism offers the spawn tool** (`subagent.py:752` vs `:105-118`) — a
  prompt that states a rule the code does not enforce.

---

## Prior research this work builds on (not redone)

- `docs/research/2026-10-21-simulide-and-pi-harness.md` — two full dive
  passes over SimulIDE and pi, with corrections (§A9–A12, B9–B10) and a
  "must NOT be copied" list. **Reused.**
- `docs/research/2026-10-21-deep-dive-and-cleanup.md` — an August-side
  review (architecture, tool/permission stack, memory, gates, dead code).
- `docs/plans/2026-10-05-harness-pattern-gap-analysis.md` — a 33-row gap table
  vs the reference harnesses, read with a 17-day staleness discount.
- `docs/plans/ui-refactor/research/2026-10-03-reference-deepseek-harness.md` —
  a DSH **UI** study from the local install, not the source repo.
- `docs/plans/2026-10-15-harness-reference-dsbot-abacus.md` — DS Bot + abacus
  reference dive.

---

## Deliverables

| Path | What it is |
|---|---|
| `docs/research/august-baseline.md` | What August actually does today, with every claim checked |
| `docs/research/AUGUST-IMPROVEMENTS.md` | **The proposals** — nine, with the ranked top-5 and the rejected list |
| `docs/research/IDEAS.md` | Every "ideas worth stealing" from every shard, consolidated |
| `docs/research/STATUS.md` | This file |
| `docs/research/<repo>/ARCHITECTURE.md` | How each system fits together, plus its coverage summary |
| `docs/research/<repo>/manifest.tsv` | The coverage ledger: one row per tracked file |
| `docs/research/<repo>/shards/<shard>.md` | 115 shard reports |
| `docs/research/<repo>/shards/<shard>.rows.tsv` | 115 per-file ledgers |

## Tooling

- `scripts/research/build-ledger.mjs` — rebuilds the manifest and the shard
  partition from `git ls-files` + `stat` only. Never executes repository code.
- `scripts/research/verify-manifest.mjs` — reconciles a manifest against
  `git ls-files` and reports shard balance.
- `scripts/research/merge-rows.mjs` — merges the per-shard ledgers back into
  the manifest and **fails the gate** on any unresolved file, any skipped row
  without a reason, or any read row without a note.
- `scripts/research/check-citations.mjs` — reopens every `path:line` a report
  cites and confirms the line exists; separately confirms every ledger file is
  mentioned in its report.
- `scripts/research/synthesize-ideas.mjs` — extracts the consolidated
  "ideas worth stealing".
