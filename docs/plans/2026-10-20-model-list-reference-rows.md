# The model list is a list, not a card grid

Date: 2026-10-20 · Status: **shipped** · Scope: the desktop app (`frontend/desktop/`) · Naming: camelCase TS.

Goal: Settings → Models → **All models** renders the reference's model list — one row per
model, a context-window chip, and a right-aligned cluster of four actions — instead of a
card grid. The row itself already existed; this is where it is used, and what it says.

---

## 1. The reference, as measured

The reference screenshot is a flat model list. Reading it row by row:

| Element | What the reference shows |
|---|---|
| Leading text | the model id, in a heavy MONO face, truncated to the column |
| Second text | the model's display name, in a heavy SANS face |
| Chip | the context window (`128K`, `200K`) in a muted rounded chip |
| Actions | four icons, right-aligned and evenly spaced: **pin · test · edit · delete** |
| Row chrome | no card, no border, no background — a hairline between rows |

The blue in the capture is a drag-selection artefact, not a design element; the rows read
as monochrome text on a dark surface.

The action set is the tell. August's `ModelRow` already carries **exactly** those four
actions in that order — the reference and August agree on what a model row can do. What
they did not agree on is where the row LIVES: August's provider list draws it as a row,
and the All-models tab drew a card instead, with one hover-revealed pin and nothing else.
So the All-models tab could pin a model but could not test, edit or remove one, while the
provider list beside it could do all four.

## 2. What changed

- [`AllModelsTab.tsx`](../../frontend/desktop/src/sections/workspace/models/AllModelsTab.tsx)
  renders [`ModelRow`](../../frontend/desktop/src/sections/workspace/models/ModelRow.tsx)
  per model, in per-provider groups, inside a hairline-separated list. The card grid and
  its `AllModelCard` are gone.
- The provider's own model list ([`ProviderDetailForm.tsx`](../../frontend/desktop/src/sections/workspace/models/ProviderDetailForm.tsx))
  and the All-models tab now sort with ONE comparator
  ([`compareProviderModels`](../../frontend/desktop/src/sections/workspace/models/modelSettingsShared.ts)):
  pinned → free → display name. They sorted two different ways before, so a model pinned
  in one list sat in a different spot in the other.
- The row's leading text is the model's **name** (sans) when the name says something the
  id does not, and the **id** (mono) otherwise. A fetched model usually carries the id AS
  its name (`beam-free`), so "has a name" is not the test — "has a name that is not the
  id" is. The id stays in the tooltip and in the action buttons' accessible names — a
  renamed model's id was previously shown nowhere at all.
- The four actions are the shared `Button` primitive now, which removes four raw
  `<button>` elements rather than adding any (`npm run check:design` is a ratchet).

**One thing to expect when you use it:** pinning a model flips its `fetched` chip to
`manual`. That is the backend, not this view — any per-model patch marks the entry
manual so a later discovery pass never prunes it or its overrides
(`backend-py/app/routers/providers.py`, "Any per-model patch marks the entry manual").
The chip is reporting that the entry is now yours, which is true.

## 3. Decisions, and what was deliberately not adopted

- **Name-only rows.** The reference leads with the raw id. August's row leads with the
  display name, and the id moved into the tooltip and the buttons' accessible names. An id
  is an identifier; a name is prose, and the row says which of the two it is showing.
- **Provider groups kept.** The reference's list is flat; August's All-models tab is
  grouped by provider, with a quiet uppercase group label carrying the provider name, the
  gateway id, the count and the `disabled` badge.
- **The `fetched` / `manual` chip is a label, not a status.** It was the one blue chip on
  the row, which made a discovered model look like a different KIND of model. It is the
  same muted chip as the context window now. The per-model wire-format override keeps its
  `primary` chip: that one is an override, not a label.
- **One pin signal.** The row used to carry a pin glyph beside the name AND a pin button
  in the cluster. The glyph is gone; the cluster's button is the signal.

## 4. The measurement that shaped the cap

The catalog on the machine this was built on holds **982 models** across four providers
(OpenRouter 470, KiloCode 402, B.A.I 61, OpenCode Zen 49), and every row carries an edit
dialog, a test flow and a delete confirmation. A provider's own list is bounded by one
provider and already mounts 470 of them, so the cost is not new — but the WHOLE catalog in
one tree is.

So each provider group renders at most `GROUP_ROW_CAP` (100) rows, and a group with more
says so: *"Showing the first 100 of 470 models — filter to narrow."* The filter above the
list searches ids, names and provider names, so a capped-out model is one query away, and
the cap states what it held back rather than quietly truncating. This mirrors the
composer's own picker, which caps its search hits at 80 and says the same thing.

The cap is one constant. Removing it is a one-line change with a measured cost.

## 5. Verification

`npm run check -w frontend/desktop` (tsc + eslint), `npm run check:design`,
`npm run check:truncate`, `npm run check:docs` and `npm run check:doc-links` are green.

The static gates cannot see whether the app starts, so the tab was opened in the running
app against a throwaway backend holding a COPY of this machine's provider store (982
models across four providers):

| Checked | Result |
|---|---|
| The list renders | 310 rows — 49 + 100 + 100 + 61, i.e. the cap applied per group |
| The cap states itself | "Showing the first 100 of 470 models — filter to narrow." |
| Time to the first row | ~1.5 s from reload with the full 982-model catalog |
| The pencil opens the edit modal | yes, and Escape closes it |
| The plug tests the model | yes — "Failed · API key not configured" inline under the row, because the throwaway store has no key |
| The pin toggles | yes, and `/api/models` then reports the model pinned — the catalog refresh reaches the composer dropdown |
| The filter narrows | yes — "laguna" leaves 8 rows |
| The trash asks first | yes — "Remove model \"beam-free\"?", cancelled with Escape |
| The provider's own list | the same 49 rows, the same row, the pin shown in both |
