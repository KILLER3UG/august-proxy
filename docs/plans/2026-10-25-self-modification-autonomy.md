# Self-modification autonomy — Phase 0 (2026-10-25)

**Owner ruling:** *option 2 — environment + audit-and-undo autonomy.* The agent may rewrite its own
prompts, tool descriptions and skills **without asking**; every change records the old value, carries an
Undo, and shows a diff in the Learning panel. The rails become "review after", not "approve before".
Anything that changes **what the agent is allowed to do** stays human.

**Phase 0 verdict: the machinery is already here. Option 2 is an extension of `harness_rails`, not a new
system** — and one unknown decides whether the Undo half is cheap or needs new storage.

## What exists (verified in code, this tree at `d94e26c7`)

| piece | where | what it does |
|---|---|---|
| the one switch | `harness_rails.autonomy_enabled()` | reads `skillAutonomy`; both the pass and the rails consult it, on purpose (the comment cites `consolidation.py:546`, where two readings of one switch made a pass nobody ran) |
| what may run unattended | `armed_kinds()` | `autonomyKinds` config **intersected with** code-owned `AUTO_APPLIABLE_KINDS = {skill_create, skill_patch}` — config can narrow, never widen. Shipped default arms `skill_patch` only |
| the rails | `auto_apply_allowed()` → `rail_trace()` | one verdict per rule, recorded — so a refusal is explainable after the fact, not a silent skip |
| cooldown / bar | `PROBATION_COOLDOWN_DAYS = 30`, a reverted finding barred for 14 days | measured, not arbitrary: a cooldown shorter than the measurement window expires about when the evidence arrives |
| rehearsal | `shadow_enabled()` → `shadow_decisions.jsonl` (keep 200) | read only AFTER the rails allow, so "shadow" means "this would have been written", never "browsing history edited the agent" |
| the ledger | `harness_self_improve`: `save_proposal`, `read_ledger`, `_append_ledger`, `decide_proposal`, `_apply_approved` | proposals persist; `REVERT_KINDS = {'revert'}` already exists as a kind |
| the human doors | `routers/harness_proposals.py`, `routers/harness_mcp.py` | approve/reject today |

## The three real gaps for option 2

1. **`tool_description` and `flow_map` cannot be applied at all.** They sit in `OBSERVATION_KINDS`, which
   are proposable and never appliable. So "the agent rewrites its own tool descriptions" is currently
   impossible *by construction*, and that is half of what the owner asked for. Each needs its own applier
   with the same class of validation the skill kinds get (a description that instructs credential access is
   a different defect from a bad one).
2. **The old value EXISTS — as a version snapshot, not a payload field.** Verified in
   `harness_self_improve._apply_approved`'s skill applier: before it writes, it calls
   `skill_versions.snapshot_before_write(...)` and records the returned `snapshotTs` on the apply
   result; the probation path reads that timestamp back. So Undo is a RESTORE over an existing
   version store, not a migration and not a new column — which is the cheap half of this option and
   the reason it is worth doing. It also means the diff has a source: the snapshot bytes versus the
   bytes now.
3. **The UI stops at approve/reject.** Nothing lists *applied* changes with a diff and an Undo; the panel
   needs an applied-changes view over `read_ledger()` plus the revert action, and the revert kind already
   exists to carry it.

## Smallest first slice (Phase 1)

1. A restore path over `skill_versions` keyed by the `snapshotTs` the apply result already carries, plus
   that timestamp on the applied row so the panel can offer Undo. Read `skill_versions` first: it may
   already expose a restore, in which case this is wiring, not code.
2. Add `tool_description` + `flow_map` appliers **behind the same `armed_kinds()` ceiling** (code owns the
   allow-list; config still only narrows), with a validation pass for instruction-injection shape before a
   description can be written.
3. The Learning panel's applied-changes view: old value, new value, what ruled on it (`rail_trace`), and
   Undo (a `revert` proposal applied immediately — the kind exists).
4. Proof, not claims: a temp-data-dir probe that arms autonomy, files a `skill_patch` and a
   `tool_description`, asserts both applied, asserts the ledger holds the before state, then reverts and
   asserts the bytes came back byte-identical. `e2e:smoke` on a scratch dir, plus ruff/mypy.

## What this phase deliberately does NOT do

- It does not touch `HARD_KINDS`, the credential/shell/URL scans, or the approval door for permissions and
  brain config — those are the boundary that makes unattended editing safe to leave running.
- It does not add a second ledger, a second switch, or a parallel proposal store: everything rides
  `harness_self_improve`'s rows and `harness_rails`' one switch.
