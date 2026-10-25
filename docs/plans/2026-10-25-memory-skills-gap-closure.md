# Memory and skills — main-goal gap closure (2026-10-25)

The attached main goal is the 18-item "SKILL.md-compatible skills + a reliable
memory loop" spec. This file is the gap table and the backlog. The 2026-10-24
plan (`2026-10-24-memory-skills-reanchored.md`) re-anchored that spec onto this
repo and shipped items 14/15 plus the broken-path fixes; this pass closes the
remaining *partial* and *missing* rows. Where the spec and the repo disagree the
repo wins (its own rule), and each such deviation is named below.

## Decisions carried (and the two the newer goal reverses)

- **Kept:** `remember` / `list_facts` / `forget` / `brain_query`; `facts` is the
  system of record; no second store, no vector index; the existing approval and
  autonomy rails; no model-declared `tag`.
- **Provenance (item 7):** the record gets a stored `tag` (`stated` /
  `observed` / `inferred`) and `source` stays. The tag is **server-derived from
  the writer's code path**, never a model argument — a model-declared tag is a
  claim nothing can check. The model's door can only produce `stated`.
- **Bundled skills (item 4):** the repo deliberately keeps the *developer
  checkout* writable by `write_file` (AGENTS: reviewed in a diff). The skill
  doors (`skill_create` / `skill_patch` / `deleteSkill`) already refuse bundled
  skills; external roots added below are read-only. This is the repo-wins
  deviation from "bundled is never mutated".
- **History (item 9):** the rollback store is already the history system; the
  fact history endpoint reads it instead of adding a second history table.
- **Memory-save chip (item 16):** the 2026-10-24 plan recommended the receipt +
  Settings undo and no chip. The newer goal explicitly asks for one small chip
  with undo, so it is built in the existing chip style.
- **Derived cascade (item 9):** `derived_from` is added and the forget door
  cascades. Only internal/system writers may set it (never the model). No
  current producer of derived facts exists, so the mechanism is proven through
  the store door and named as forward-looking.

## Gap table

| # | Item | Status before this pass | Smallest change in this pass |
|---|------|--------------------------|------------------------------|
| 1 | Format + bad-skill skip + required name/description | Partial — body/name checked; description not required; non-mapping and unquoted colon accepted; cap 500 | Validate YAML mapping, require name+description at discovery, description cap 1024, keep logged skips |
| 2 | Optional keys + platforms/requires/fallback gating | Partial — keys round-trip; no gating | Gate discovery/catalogue/load on platform + registered tools |
| 3 | Progressive disclosure L0/L1/L2 + vars | Partial — L0/L1 done; L2 used generic read_file | `load_skill(name, file=...)` with containment + symlink/traversal refusal |
| 4 | Roots + precedence + read-only bundled/external | Partial — no external root; bundled writable by raw file tools | Add config `externalSkillRoots` (read-only); skill doors already refuse bundled; document the raw-file deviation |
| 5 | Authoring validation, patch-over-rewrite, Use-when warning, caps | Partial — validation/patch exists; no warning/caps | Warn (not block) on description without “Use when”; hard 100k chars; soft ~200-line warning |
| 6 | Install/import confirmation + scan + no execution | Partial — zip install only, no confirm/scan, no folder | Preview/confirm flag, content scan, local folder import; never run scripts |
| 7 | Record shape | Partial — no aliases/tag/version/source_session/sensitive/derived_from | Additive migration 056 + server-derived fields + writer updates |
| 8 | Listing-first recall | Partial — profile lane + BM25 tail; no preferences lane, no aliases/150-char index | Add preferences to the always-in lane; 150-char index descriptions; aliases in index |
| 9 | Optimistic locking, history, forget cascade | Partial — `if_version` + rollback snapshots; no derived cascade | Accept integer `version` too; history endpoint; `derived_from` cascade |
| 10 | Write triggers / never-write list | Partial — save categories exist; no decision/standing-preference/passing-mention wording | Compact prompt block |
| 11 | Recall triggers | Partial — mechanics exist; no trigger text; third-party boot index leak | Compact prompt block; filter person/sensitive from index/tail |
| 12 | Filters | Done (fixed earlier) | — |
| 13 | Writers: subagents/cron read-only | Done (fixed earlier) | — |
| 14 | One combined budget | Done | — |
| 15 | Alias pre-read | Done | — |
| 16 | One compact behavior block + save chip + no narration | Partial — memory policy exists; no skill-load-first/narration text; no chip | Extend policy + `<capabilities>` header; small chip with undo |
| 17 | Untrusted input | Partial — prompt clause; install unscanned; permission claims not filtered | Permission-claim filter arm + install scan |
| 18 | UI: lists, marker, master off, skill delete | Partial — lists/toggles/delete exist; no stated/inferred marker; no master off | Master `memoryEnabled`, marker, verify delete |

## Backlog (one commit each)

1. **M1** — migration 056 + schema columns + read normalization.
2. **M2** — every `save_fact` writer stamps the shape; `remember` aliases/version; list/get return it.
3. **M3** — derived cascade + fact history endpoint + detail “Previously”.
4. **P1** — compact write/recall/skill/anti-narration block.
5. **S1** — strict frontmatter discovery + description 1024.
6. **S2** — platforms/requires/fallback gating.
7. **S3** — hard 100k body cap + 200-line warning + Use-when warning.
8. **S4** — `load_skill(file=...)` L2 containment.
9. **S5** — install preview/confirm + content scan + local folder import.
10. **U1** — master `memoryEnabled` + marker + skill delete verification.
11. **U2** — memory-save chip with undo.
12. **X1** — permission-claim write filter + person/sensitive index filtering.
13. **V** — live 18-item verification, full gates, live-store census.

## Verification (live, isolated)

The 13 live checks in the main goal, run through the real store/tool/prompt paths
and the scripted-provider loop; live `facts`/`memory_store` counts and the live
skills-dir hash are re-checked afterwards. Model-judgment checks remain BLOCKED
without a funded provider and are reported with substitute evidence.

## Shipped 2026-10-25

| Item | Commit | Live proof |
|------|--------|------------|
| M1/M2/M3 record shape, migration 056, aliases, version CAS, cascade, history | `9d74a334` | shape/CAS/cascade/history harness; migration 056 on a copy of the live schema with backfill and `.pre-migration` |
| P1/X1 read lanes, master off, prompt triggers, person/sensitive filtering, permission-claim refusal | `46600697`, `1cd3408f` | master off → all four doors refuse, prompt 9301→5556 chars; profile+preference lane; person/sensitive absent from index; injected admin payload refused |
| S1–S4 strict frontmatter, gating, caps, L2, external roots | `8485cdb5` | 8 malformed fixtures skipped with reasons; 3 gating cases hidden; L2 traversal variants refused; warning returned |
| S5 install preview/confirm/scan/local | `a5329dce` | preview wrote nothing; confirm installed; unsafe pack refused and left no directory |
| U1/U2 master switch, tag marker, save chip, install confirm | `58ff3147`, `237cf42e`, `6806f2bd` | Playwright: tags, master on/off, detail tag, pack preview/confirm, skill delete; chip rendered and Undo present |
| API artifacts for the history route | `6806f2bd` | check:api, check:api-index green |

Remaining named limits: model-judgment checks (direct answer, drafting judgment, the model choosing
to load a skill) need a funded provider; the derived-fact producer is forward-looking (the store/
cascade is proven, no current path writes `derived_from`); the bundled checkout remains writable by
raw file tools (repo-wins deviation); the generic `read_file` remains machine-wide, so L2 must go
through `load_skill(file=…)`.

## Final addendum (same day)

Closed after the first ship: a raw `SKILL.md` URL now fetches the referenced
support files; the Memory detail renders the previous value from the history
endpoint; `harness_promote` records the project entry as `derived_from`, so
forgetting the project entry cascades to the promoted global fact; `remember`
collapses multi-line facts to one line; a model-claimed provenance other than
`stated` is refused; and untagged third-party facts (`my friend John`, `John's
phone`) are classified `subject_type=person` so the automatic index/tail leave
them alone. Core memory harness: all checks true. Gates green at `ddcd7a33`.
