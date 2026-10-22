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
| 0 | August baseline — read August's own areas, write `docs/research/august-baseline.md` | **in progress** |
| 1 | Coverage ledger — `manifest.tsv` per repo, every tracked file classified and sharded | **done** |
| 2 | Parallel subagent deep-dive, one subagent per shard | pending |
| 3 | Verification gate — lead re-diffs, spot-checks 10 %, writes `ARCHITECTURE.md` per repo | pending |
| 4 | `docs/research/AUGUST-IMPROVEMENTS.md` with ranked top-5 | pending |

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
