# Memory and skills — current specification

Status: **current**, 2026-10-29. This file supersedes the 2026-10-24
re-anchoring, the 2026-10-25 gap closure, the 2026-10-27 markdown-mirror plan
and the 2026-10-27 hardening plan. Those documents were removed from the tree
on 2026-10-29; their evidence is in git history and in the commits named
below. The agent-facing rules are in
[`docs/agent/memory.md`](../agent/memory.md) and
[`docs/agent/skills.md`](../agent/skills.md); the product standard is in
[`docs/PRODUCT.md`](../PRODUCT.md).

## 1. What the user sees

| Surface | What it shows | State |
|---|---|---|
| Settings → Memory | One flat chronological list across kinds, filter chips, an add box, a detail pane (source, tag, subject type, updated, **Previously**), a master switch, and the backups card | Shipped |
| Memory detail history | The latest prior value is shown; the history endpoint exists | Partial — see §5 |
| Chat receipts | A memory write is a receipt; the save chip carries **Undo** | Shipped |
| Recalled-memory chip | The facts injected into this turn | Shipped (four fields only) |
| Backups & restore | Verified rolling backups, staged restore at next launch, integrity read | Shipped |
| Open folder | Opens `<dataDir>/memory/`, the human-readable mirror | Shipped |
| Learning hub | The skills library, proposals, and the `review` job row | Shipped |
| Skill library | List, create, patch (diff), delete, restore; pack install preview + confirm + content scan; local-folder import | Shipped |
| Skill trash | A replaced or removed pack skill is restorable | Shipped |

The mirror is a **one-way view**: one `.md` per active fact plus a `MEMORY.md`
index. Reads never parse it; hand edits are overwritten; `write_file`, the
terminal and code mode refuse `<dataDir>/memory/**` because a model that can
write the human-readable view can install instruction-shaped content beside the
facts a person audits.

## 2. What the model gets

**Memory tools.** `remember` (write/update by key), `list_facts` (enumerate,
with `offset`/`total`/`hasMore` and `include_retired`), `forget`, and
`brain_query` (including the `facts` and `memory` stores). All are core tools
and in the bare-tool allow list.

**Three lanes, not one mechanism.**

- **Profile** — `kind='profile'` facts, always rendered first, inside a
  ~600-char budget, even when automatic recall is off.
- **Delta** — facts whose `updated_at` is newer than the session's creation
  stamp, appended to the tail as `new in memory since this chat opened:`.
- **Recall** — BM25 over `facts`, gated by `memoryAutoInject` (**armed by
  default** since 2026-10-24; an explicit stored `false` wins). A fact dropped
  for budget is named in a `recall partial:` line.

**Write rules.**

- `remember` refuses its first write in a turn until `list_facts` (or a memory
  search) has run once that turn, and only when the store has something to
  check; `modelMemoryRead` off disables that gate.
- A sentence already stored under a different key is refused with the existing
  key named (`existingKey`).
- A stale `if_version` returns `{ok: false, conflict: 'version', current}`.
- `source` is stamped by the code path, never by the writer's claim. A stored
  `tag` (`stated` / `observed` / `inferred`) is server-derived; a model-claimed
  value other than `stated` is refused.
- Subagents read and recall but never write. The parent turn is the only
  model-facing write door.

**Skill tools.** `load_skill(name)` (L1 body + file list + absolute directory),
`load_skill(name, file=…)` (L2, containment-checked: traversal and symlinks
refused), `list_skills`, `skill_create`, `skill_patch`, `deleteSkill`, restore,
and pack install/import. The skills index is budgeted per context window; an
alias pre-read adds a hint-only line when the user's message names a skill.

## 3. Record shape

`facts` columns that matter to this spec: `fact_key`, `fact_value`, `title`,
`description`, `kind`, `category`, `source`, `tag`, `subject_type`, `aliases`,
`version`, `updated_at`, `verified_at`, `sensitive`, `source_session`,
`derived_from`, `previous_value`, `expires_at`, `scope`, `supersedes`,
`superseded_by`, `contradicts`, `injected_count`, `last_injected_at`.

- `updated_at` is the CAS token and is handed to the model by `list_facts`.
- `previous_value` is set only when the content actually changes (migration
  059); an unchanged re-save keeps the prior history.
- `derived_from` is written only by internal/system writers (never the model)
  and is cascaded on forget. The mechanism is proven; no current producer
  exists besides `harness_promote`.
- DB scopes are `global` and `bot:<agentId>`. `project:<path>` is refused; the
  workspace memory layer is `<workspace>/.aug/memory`.

## 4. Status — what is met

| Item | Evidence |
|---|---|
| SKILL.md format, strict frontmatter, required name/description, logged skips, recursive discovery, category level | S1 + the shared `_iterSkillMd` walker |
| Platform / `requires_*` / `fallback_for_*` gating | S2 |
| L2 with containment, external roots, body caps, "Use when" warning | S3/S4 |
| Install preview/confirm, content scan, local-folder import, never execute scripts | S5 |
| Record shape, aliases, version CAS, history, `derived_from` cascade | M1–M3 |
| Read lanes, master off, prompt triggers, person/sensitive filtering, permission-claim refusal | P1/X1 |
| Master switch, tag marker, save chip with Undo, install confirmation | U1/U2 |
| Pack reinstall/uninstall through trash + `restoreSkill`; `previous_value` | Hardening (migration 059) |
| Markdown mirror + ZCode type aliases as input | Mirror plan |

## 5. Open — defects, limits and decisions

| Item | Type | Detail |
|---|---|---|
| Model-judgment checks are unrun | Limit | The "will the model choose to load the skill / draft a good one" checks need a funded provider; they were reported as blocked, with substitute evidence. |
| Derived-fact producer is forward-looking | Limit | The store and cascade are proven; only `harness_promote` writes `derived_from` today. |
| Bundled checkout is writable by raw file tools | Deliberate deviation | The skill doors refuse bundled skills; a human editing the repo can still change them. Reviewed in a diff, not app state. |
| Directory-symlink descent is implemented, unproven | Limit | The probe shell could not create a directory symlink; the walker does not descend one. |
| Subagent memory reads are blocked | Product ruling | Stricter than the spec's read-only; opening reads is a one-line deny-set change and an owner decision. |
| Mirror has no ingest-back, no per-scope mirrors, no watch mode | Deliberate | The mirror is a view, not a second write path. |
| Save-chip usage is unmeasured | Unknown | The chip shipped; whether users reach for it has not been measured. |
| `_recalled_row` emits four keys only (`key`, `category`, `snippet`, `scope`) | Limit | The chat chip cannot show which lane matched or when the fact was last injected. |

## 6. The UX backlog (next work)

These are product improvements, not code defects, except where noted.

1. **Make recall legible.** The chip should say which lane matched (profile,
   delta, recall, alias), which field matched, and when the fact was last
   injected. `matched_field` already exists on the alias path;
   `injected_count` / `last_injected_at` exist on the row; `_recalled_row`
   intentionally emits only four keys, so this is a contract addition with a
   migration-free wire change.
2. **Make a skill's state visible.** The skill detail should show the full
   trigger, usage count, last used, version history, and — when a skill is
   hidden — the exact gate that hid it (platform, missing tool, disabled,
   retired). A silent absence reads as a bug.
3. **`list_skills` renders the full trigger — DONE (2026-10-29).** The 60-char
   cut deleted the "when NOT to fire" half of the description, so the listing
   advertised the skill while hiding the rule for using it.
4. **Diff an install against an existing skill.** The preview/confirm door
   exists; show what changes when a pack would replace a skill of the same
   name.
5. **Show the whole fact history.** The detail pane shows the latest
   `previousValue`; the history endpoint has the rest. Render it as a timeline.
6. **Show derivation when it exists.** Once a producer writes `derived_from`,
   the detail should name the parent, and forget should explain the cascade
   before it runs.
7. **Measure the save chip.** If usage is near zero, remove the chip and keep
   the receipt + Settings undo, rather than carrying new UI for a
   low-frequency action.

## 7. Verification

There is no test suite. The memory/skills work was verified through the real
store, tool and prompt paths with an isolated `HARNESS_DATA_DIR` and the
scripted provider, and the shipped commits record what each run measured. The
gates that still hold the shape are `npm run check:docs`,
`check:brain-config`, `check:naming`, `check:tool-registration`, `check:sse`
and `e2e:smoke`; `uv run mypy app/` holds the types. A future change to this
area should re-run those and state which live probe it used — reading this spec
is not verification.
