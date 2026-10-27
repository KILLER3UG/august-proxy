# Memory / skill hardening — the two real gaps from the reachability review

**Source:** the 2026-10-27 three-agent review of the "SKILL.md-compatible
skills + a reliable memory loop" task against this repo. The review's verdict
was that the task is ~95% already built (migration 056, the 055 lineage
columns, the alias pre-read, the Tier-1 budget and the Library UI all
predate it); two genuine defects and one audit came out of it. This doc is
the record of implementing them.

## 1. Skill packs bypassed the undo rails (fixed)

`install_pack`'s pack-owned reinstall and revision cleanup, and
`uninstall_pack`, deleted live skill directories with a bare `rmtree` — the
one mutation path on the skills surface with no version snapshot and no
trash entry, while patch/delete/restore all protect content first.

**Fix:** a `_trashPackDir` helper routes all three paths through the
canonical `_trashDir` door (`skill_service`), so a replaced or removed pack
skill lands in `<dataDir>/.trash/skills` and is addressable by
`restoreSkill` like any delete. `install_pack` refuses a skill whose old
copy cannot be preserved; `uninstall_pack` aborts leaving the manifest
intact when any directory cannot be trashed (an undoable uninstall either
protects its content or does not happen). Both results carry `trashIds`.
The validation-failure cleanup (deleting the just-written, invalid files)
stays a `rmtree` — there is nothing of value to preserve there.

**Verified live** (isolated temp `AUGUST_DATA_DIR`): first install writes
no trash; a reinstall trashes the old copy and the trash id restores it via
`restoreSkill`; `restoreSkill` correctly REFUSES while the new install
holds the name; uninstall trashes and the directory is gone.

## 2. Memory edits now carry "now X, previously Y" (fixed, row 9's gap)

`save_fact`'s upsert overwrote the value with no record of what it
replaced; the prior value survived only inside the rollback snapshot.

**Fix:** migration **059** adds `facts.previous_value` (additive, idempotent
double-ownership: `_CORE_SCHEMA_SQL`, `ensure_column` fast path, `_SCHEMA_USER_VERSION`
19). The upsert sets it only when the content actually changes — an
unchanged re-save keeps whatever history it had. `_remember`'s result
carries `previousValue` for the model (a correction is distinguishable from
a first save), and the Library's memory detail pane renders a "Previously"
cell when set. The CAS/conflict path is untouched.

**Verified live** (same isolated store): edit → `previousValue` holds the
old sentence; no-change resave keeps it; a stale `if_version` still raises
`FactVersionConflict` with the live row.

## 3. Model-fetch audit (no hardcoded data — clean)

- Frontend: `useModels` → `GET /api/models` (backend aggregate of
  `providers.json` + model aliases), 2-minute poll, invalidation on provider
  edits. No model list is built in the UI.
- Backend: `model_service` states and implements the ruling — "No hardcoded
  model catalogs — models always come from the provider's /models endpoint
  (or the user's own provider config)"; `_STATICModelLists` is an empty
  runtime cache.
- The composer chip's model (`Opencode Zen · Hy3 (Free)` in the dev install)
  is PERSISTED USER SELECTION (`august_last_model` / the session row),
  rematched to the catalog when it loads — not a hardcoded default. The dev
  install's catalog is empty (no enabled providers), so the picker honestly
  reads "No models for this provider".
- Remaining model-name literals: `pages/DesignRoute.tsx` (dev-only design
  lab, `import.meta.env.DEV`-gated, never shipped), display heuristics and
  context-window fallbacks in `model-display.ts` (defaults when a model
  declares nothing, mirroring the backend's family table), and doc-string
  examples. None render as content.

## Not done, on purpose

- Row 8's "each turn" index re-injection: the session-frozen boot index is a
  documented prefix-cache decision; the spec conforms to the code.
- Subagent memory READ stays blocked (stricter than the spec's read-only) —
  a product ruling to open it is a one-line deny-set change later.
