# Skills and the learning loop

A skill is a procedure, not a rule. `docs/SKILL_AUTHORING.md` is the format
spec; this file is the discovery, learning and safety detail.

## Format and discovery

The format is the Claude/Hermes merge: a folder with `SKILL.md`, frontmatter at
byte 0, and a body whose canonical sections are Title, When to Use, When NOT to
Use, Prerequisites, How to Run, Quick Reference, Procedure, Output format,
Examples, Pitfalls, Verification, Reference files. The `description` (capped)
is the TRIGGER — it names the capability, the situations, and when NOT to fire,
because a future agent sees only name + description before loading. Bundled
(hand-written) skills pass through the normalizer untouched. The frontmatter
parser also reads the nested Hermes `metadata.hermes` block, and unknown keys
round-trip through every patch.

Discovery walks five roots — bot → project → agent → external → bundled,
earlier wins — through one shared walker (`_iterSkillMd`) that is depth- and
count-bounded and never descends a dot-directory or a symlinked directory. A malformed skill is
skipped with a logged reason while its siblings still load. An optional
category level is supported (`<root>/<category>/<name>/SKILL.md`). A config
`externalSkillRoots` layer is read-only. The four roots are
`<workspace>/.aug/skills`, `<dataDir>/skills`, `<dataDir>/bots/<id>/skills` and
the bundled `<repo>/skills`.

**A learned skill is a procedure, not a rule**: the distiller drafts section
fields (`steps`, `pitfalls`, `verification`, …) that
`skill_service.renderSkillBody` renders, and `skill_service.bodySubstance`
measures **what was drafted before `_ensure_canonical_body` pads it** (two
steps, one pitfall that happened, one verification, one situation to use it
in). Below the bar the verdict becomes a memory lesson instead of a padded
skill — the padding is what used to let a one-sentence rule ship with every
heading present. `amend_trigger` carries no body, so it must ship the target's
current body through: normalizing the empty one wrote placeholders over a real
skill on approval.

`npm run check:skills` runs this same loader over the bundled tree. A file it
would skip at discovery, a frontmatter `name` that disagrees with its
directory, or two bundled skills sharing a name fails the gate; without it,
the runtime skip is the only symptom and the skill simply disappears from the
catalogue.

## Mutation and undo

Every mutation on the skills surface protects content first:

- `skill_create`, `skill_patch` and `deleteSkill` refuse bundled skills; edits
  go through a proposal and an approval.
- delete and patch snapshot through the rollback store; `restoreSkill` brings a
  deleted skill back.
- `install_pack`'s pack-owned reinstall and revision cleanup, and
  `uninstall_pack`, route through the same `_trashDir` door
  (`<dataDir>/.trash/skills`), so a replaced or removed pack skill is
  addressable by `restoreSkill`. `install_pack` refuses a skill whose old copy
  cannot be preserved, and a failed uninstall aborts leaving the manifest
  intact.
- `_apply_approved` **rewrites SKILL.md frontmatter wholesale**, so any field a
  `skill_patch` proposal does not restate is gone: `supersedes`, `origin`,
  `learned_from` and `trigger` are read back off the existing file before the
  write. Losing `trigger` is not cosmetic — it is what per-turn relevance
  matching reads, so a silent patch would retire a skill from recall.
- Skill usage lives at `<dataDir>/skills/<name>/.usage.json` and the install tree
  must stay free of it; `skill_delete` proposals, `patchSkill` and the usage
  counter all key on `SKILL.md`, never on directory existence.

The bundled checkout is deliberately writable by raw file tools — it is a
developer's checkout, reviewed in a diff. The model-facing doors
(`skill_create` / `skill_patch` / `deleteSkill`) refuse bundled skills; only a
human editing the repo changes them.

## Instruction state is a write-door rule

The skill roots are live instruction layers: a `write_file` into
`<dataDir>/skills` installs an instruction the NEXT turn reads. That is why
`skill_service._skillRoots` and `_agent_state_reason` fence the two agent
layers, `mcp-servers.json`, `automations.json`, `<workspace>/.aug/kernel/**` and
the brain database at the write door. See [security.md](security.md) for the
full list.

## The learning loop

Every other learning pass is started by something going wrong (a flagged
episode, a filed observation, a failing automation), so nothing ever read a
session that went *well*. `skill_distiller.run_review_pass()` does: one session
per pass, the most recently active one that still has unreviewed messages,
rendered as a message-id'd window and judged with `_REVIEW_SYSTEM` — an
extension of `_JUDGE_SYSTEM`, not a second copy, because "prefer none" must be
said once. Verdicts go through the SAME `apply_verdict` door as episode
verdicts, so the memory bar and the dedupe cannot disagree with themselves by
call site.

The fingerprint is `review:<sessionId>` (a bare message id collides with the
`episodes` id space and would let two sessions silence each other's drafts).
Review progress is a **per-session cursor map** (`internal_state` key
`skill_distiller:review:cursors`, JSON dict, capped at 500 entries by lowest
cursor) — NOT one global high-water id: work in A, open B, return to A and A's
message ids sit on both sides of B's, so a single cursor reviews B and then
jumps past all of A, which is exactly the "only one session ever gets learned
from" failure the pass exists to fix. An empty window still advances that
session's cursor, so tool-ack-only rows are never re-read.

Gated by brain-config `memoryReview` (**ARMED BY DEFAULT since 2026-10-24**; an
install that explicitly turned it off keeps it off) and scheduled as the
`review` job in `learning_scheduler`, so it has its own ledger row, cadence
(`reviewIntervalHours`) and run-now button. Its job adapter **must drop
`results`** before returning: `_finish_run` truncates the serialized detail at
2000 chars, a 60-entry list measured 2994, and a half-JSON blob parses to `{}`
in `scheduler_status` — a successful review would report as an unexplained one.
Settings → Memory is where the switch is; the Learning panel's job row names
that switch when it is off, so an armed-but-idle loop and a never-armed one do
not look identical.

## Prompt surfaces

The skill index the model sees is bounded per context window
(`tier1IndexBudget` / `currentIndexBudget`): the name lines, the descriptive
lines and the intake count all draw on one published triple, so a small-window
model gets less index rather than a truncated prefix. The subagent descriptive
index is bound to the combined memory+skills envelope. `alias_preread_skills`
adds a hint-only line when the user's message names a skill; the body still
loads only through `load_skill`. The current UX (Library, install preview,
patch proposals) and the open items are in
[../specs/memory-and-skills.md](../specs/memory-and-skills.md).
