# The harness is the environment — goal environments, runs, outputs and marks (2026-10-25)

**Owner's goal, quoted:** *"Agents can edit their own harness in the middle of a task, on their own.
[…] The whole architecture is just the environment they work in. The system state lives in JSON files:
goals act as real environments where agents work, along with inputs, outputs, and custom triggers they
respond to. Agents can edit all of it while they work inside."*

This is **after noon on a task that was already built once**: the same design was implemented in the
August Trading repo by mistake. That code is deleted from that repo and must not be consulted as a
precedent — it is TypeScript for a different product with a different store. What ports is the
*design*, and only where this repo already has the seam.

## What this repo already is (verified at `5b354733`, not assumed)

| seam | what exists | file |
|---|---|---|
| the self-improvement harness (propose → human decides) | `harness_introspect`, `harness_propose`; rails, mode, outcome, playbook, promote services; `routers/harness.py` is the human door | `tool_registrations/harness_tools.py`, `services/harness_*.py` |
| memory of record | `facts` table, shape added in `056` (aliases, subject_type, tag, version, derived_from) | `migrations/056_fact_record_shape.sql` |
| tool surface | one registry, groups under `tool_registrations/`, `register_all()`, `AUGUST_CORE_TOOLS` for progressive disclosure | `services/tool_registry.py:457`, `services/tools/model_tools.py` |
| per-turn record | `turn_outcomes` (reason, rounds, counters; NULL = unrecorded) | `workbench/turn_close.py` |
| seat prompt | segments built and cached once | `workbench/prompt_segments_cache.py` |
| outputs | `artifact_tools` = generated FILES bound to the session workspace (deck/chart/video/circuit) — not a manifest | `tool_registrations/artifact_tools.py` |

Two consequences that decide the shape:

1. **"harness" already means the self-improvement pipeline here.** The new layer is therefore called
   **goals**, not a second harness, and it touches none of `harness_rails`. A goal environment is work
   state the agent may edit itself; a skill or harness *proposal* keeps its human gate.
2. **`artifact_tools` produces files, not records**, so a goal output is a *manifest pointing at* a
   file, a fact, a skill or a strategy — never a copy of the bytes.

## The mapping

| Octopus noun | here | writable by |
|---|---|---|
| Execution environment (JSON goal + policy, nestable) | `goal_envs`: goal, inputs, outputs, bound, parent, status | the agent, mid-turn |
| Policy, formed per arrival, never stored | `form_bound(chain, seat, bot)` — a pure function; a child may only narrow | nobody (derived) |
| Run (durable, parks/wakes) | `goal_runs`: status, round, model, session | the agent + the turn |
| Artifact (payload + manifest + movement) | `goal_artifacts` + `goal_movements` (a refusal is a row) | the agent |
| Mark (only after a verifier) | `goal_marks`: claim + verdict + evidence ref, verdict non-optional | the agent may claim; a mark needs evidence |
| Custom triggers | **deferred**: the repo already has jobs/routines that wake work; a second trigger store would be a parallel system | — |
| Interface | unchanged: the one tool registry | — |

## Slices, each its own commit and gate

1. **(this one)** `migrations/057_goal_environments.sql` + the same DDL in `create_extended_tables`, and
   `services/goals/records.py`: the pure rules — ids, narrowing (`assert_narrower`, `clamp_bound`), the
   run transition table, `unmet_outputs`, `to_mark`. No I/O, so it is checkable by `ruff` + `mypy` and by
   a temp-database script rather than by a suite this repo no longer has.
2. `services/goals/store.py`: SQLite through the existing schema helpers, one write function per
   transition, a refusal recorded rather than swallowed.
3. `tool_registrations/goal_tools.py`: `goal_read`, `goal_edit`, `goal_output`, `goal_run`; registered in
   `register_all()` beside the harness group; the write names kept out of the bare/weak-model allow-list
   until the read door has proven itself.
4. The compact block in `prompt_segments_cache.py` — the goal, the bound in force, the run and its
   rounds, the output still owed — inside the existing prompt assembly, no second injection point.
5. The turn lifecycle: open-or-resume a run, settle its rounds from `turn_outcomes`' own rounds value.
6. `routers/goals.py` + the Settings panel: goals, runs, claims versus marks, movement ledger.

## Rules this will be held to

- **A child may only narrow.** A widening request is clamped and the clamp is named, never silently
  applied. The proxy's settings (the analogue of the trader's rails) are not goal state and are not
  writable through a goal.
- **`done` needs its outputs; `abandoned` never needs anything.** A gate that blocks stopping work
  makes a run spin.
- **A mark needs a verdict and an evidence ref**, re-checked when read out of the database.
- **A refusal is a row** in the movement ledger, not a log line.
- Nothing blocks the event loop; every store call is awaited or explicitly sync on a short connection.

## Status (2026-10-25, end of the build pass)

Everything below the panel is landed and pushed to `origin/master` — commits `73dd8c38` (rules +
tables), `771f64b1` (store), `09133489` (four tools + policy), `a6be56e1` (enforcement),
`4724abf9` (prompt block), `92a80c9e` (turn lifecycle), `03ccdbc4` (API + regenerated spec/client).
Gates on each: ruff 0, mypy 0 over 356 files, `e2e:smoke` 20/20 on a fresh scratch data dir, and
six probes totalling **106 checks, 0 failed**, every one on a temp `AUGUST_DATA_DIR`.

### What the panel still needs (measured, so the next pass starts here)

- Panels live in **`frontend/desktop/src/sections/settings/`** (e.g. `MemorySection.tsx`) and are
  declared in **`frontend/desktop/src/settings/settings-registry.ts`**. That file is data plus an
  **in-file audit** with hard rules: section ids are immutable, every icon must be unique across the
  registry, every keyword must be owned by exactly one section, and each entry declares
  `tier: 'basic' | 'hidden'`. A `goals` section has to satisfy all four, and
  `settings-registry.ts` records the movement history the audit refers to.
- `components/settings/SettingsTabs.tsx` is referenced only by its own module and
  `settingsTabIds.ts` — the settings surface is **not** a simple tab→panel map, which is why an
  assumed `sections/panel` path was wrong on the first look.
- The API client belongs beside `frontend/desktop/src/api/api-client/brain-backup.ts` (it imports
  `api` from `../client`); the typed schema is already regenerated for the three routes.
- Gates for that change: `npm run check -w frontend/desktop` (tsc + eslint), `check:design`,
  `check:naming`, `npm run build`.

### Decisions taken while building (not in the original plan)

- **The ceiling is per wake window.** A resumed run restarts its count and names the window it spent
  ("resumed after 4 round(s) at the ceiling"); one accumulator printed `round 5 of 4` after the first
  park.
- **The root is uncapped** (the `10**6` sentinel): rounds accumulate across turns, so the per-turn
  budget would park a healthy conversation at its 150th total round.
- **The root is never trimmed by the allow list** — its allow list is the seat at seed time, and
  trimming would drop tools registered later (MCP, plugins). Only denials apply there.
- **No trigger table**: jobs and routines already wake work here.

