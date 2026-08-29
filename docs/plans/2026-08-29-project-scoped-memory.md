# Project-Scoped Memory & Skills (Memory Architecture v2)

**Status:** DRAFT — awaiting ruling. All file:line references verified against the working tree on 2026-08-29.
**Related:** *Part 16 — Self-Improvement Loops* (`2026-08-29-self-improvement-loops.md`). This plan is the **substrate** (where per-project memories and skills live); Part 16 is the **engine** (how they improve). Its Phase E global distillation calls Part 16's Phase C distiller when adopted; a minimal fallback is specified in §5 so this plan ships standalone.

---

## 1. Goal (the user's spec, restated)

1. **Each folder/project gets its own memory index.** A chat opened in `D:\proj\sheesh` remembers that project's details in every new session — without leaking other projects' memories into its context.
2. **Memory tab gains a dropdown** listing every folder the user has added to August, plus a Global level.
3. **Per-project memory files:** each project has `memory.md` as its default memory file; the model can create additional `.md` files alongside it. Files are human-readable, in the project, inspectable and editable by the user.
4. **Per-project skills:** the model can create skills scoped to a project; they load only in that project's sessions.
5. **Global distillation:** a global level reviews all projects' memories/skills and distills the best into global memories/skills.

## 2. Why today's code can't do this (verified findings)

| Gap | Evidence |
|---|---|
| Memory is **global-only** | `facts` table has no workspace/project column (memory_schema.py:31-40, :418-425); BM25 retrieval (`fact_retrieval.py:76-80`) and `brain_index_snippet` (brain.py:357-397) query the whole store unfiltered; the per-turn `<memory>` block injects globally for every session (workbench.py:2651-2690) |
| Skills are **global-only** | `_skillRoots()` (skill_service.py:35-37) returns two global dirs; `list_all`/`catalogue` take no scope; `load_skill` loads any skill from any session (skill_tools.py:9-24) |
| **No backend project registry** | Folders live in localStorage (`august-folders-list-v1` store/sessions/storage.ts:6; `august-workspaces-v1` store/workspaces.ts:10-11); backend only stores `workspace_path` per session row (memory_schema.py:78). A dropdown needs a server-side enumeration. |
| A **ready-made dropdown exists, dormant** | `WorkspaceSelector.tsx:19-170` (folder list, check-mark, "Open folder") is imported nowhere; `store/workspaces.ts` already has the add/dedupe/normalize logic (addWorkspace :88-111) |
| Strong `.aug/` in-workspace precedent | `.aug/plans` (workbench.py:612), `.aug/spill` (:318), `.aug/verify.json` (edit_verification.py:8), `.aug/code_runs` (code_runner.py:402), `.aug/kernel` (kernel.py:12) — a per-project `.aug/memory/` is convention reuse, not a new behavior class |
| Per-workspace precedent for *config* | tool always-grants are keyed by workspace path (workbench.py:4855-4870) — scoping by path is an established pattern |

**Cache constraint carried from the 2026-08-29 freeze fix:** anything injected near the top of the system prompt (intake) must be byte-stable per session (`_frozen_mem_index`, workbench.py:982-993; test_prompt_cache_stability.py). The project index joins the frozen block; per-turn `<memory>` stays a tail-of-last-user-message patch (workbench.py:2651-2690) and may change per turn.

## 3. Architecture

### 3.1 Project memory = files in the project (files are the source of truth)

```
<project>/.aug/memory/
  memory.md          ← default file, auto-created on first project session
  <anything>.md      ← model may create more; loader picks up every .md
```

- **Format (Claude-style human-readable, one entry per bullet):**

  ```markdown
  ---
  name: sheesh
  description: Cyclone IV VHDL coursework project
  updated: 2026-08-29
  ---

  - [quartus-version] Toolchain: Quartus 18.1 Lite, device EP4CE6E22C8 — never suggest full Quartus.
  - [coding-style] User wants testbenches written before RTL in this project.
  ```

  The `[key]` slug gives update-over-duplicate semantics identical to `save_fact`'s `fact_key` (rest.py:30-73): same key = replace the bullet, not append.
- **Why files, not a scoped facts table:** one source of truth (no DB↔file sync bugs), human-readable in place (the 2026-08-26 readability ruling), versionable by the project's own git, and the model needs **no new write door** — it creates/edits these files with the existing hash-anchored file tools, already sandbox-contained to the workspace (sandbox/paths.py:79-127). The backend loader reads; only `remember(scope=project)` writes server-side (bullet upsert).
- **Loader + index:** new `backend-py/app/services/project_memory.py` — parses frontmatter + `[key]` bullets, builds a per-project BM25 corpus (same pure-Python approach and corpus-on-mtime cache as fact_retrieval.py:34-38, :64-108), never touches the facts table.

### 3.2 What a project session sees

| Surface | Change | Cache stability |
|---|---|---|
| Intake index (top of system prompt) | One new frozen line: `Project memory index (names only): memory.md — 12 entries, notes.md — 3 entries` + project skill names. Frozen into the same `_frozen_mem_index` snapshot (sessions.py:123-130) | **Frozen per session** |
| Per-turn `<memory>` block (tail of last user message) | `build_memory_block` merges **project hits first, then global facts**, one combined ≤1600-char budget (fact_retrieval.py:173-211); the `index:` line lists project keys + fact keys | Per-turn (already outside the cached prefix) |
| `brain_index_snippet` (brain.py:357-397) | Unchanged for global facts; the project line is rendered separately in intake so the frozen snapshot covers both | Frozen |
| Turn-end usage feedback | `touch_fact_usage` (workbench.py:4305-4316) also bumps the touched project bullet's `use_count` counter held in the loader's sidecar (`<ws>/.aug/memory/.usage.json`) | n/a (no prompt impact) |

New sessions in a project therefore inherit project context automatically — the bootstrap the spec asks for — and a session with no workspace sees exactly today's behavior.

### 3.3 Model write doors

| Door | Behavior |
|---|---|
| `remember(scope='project')` | New optional param on `_remember` (session_tools.py:134-249). Upserts a `[key]` bullet into `<ws>/.aug/memory/memory.md`. Same denylist, same 3/turn budget, same length caps. No workspace bound to the session → returns a soft error telling the model to use global scope. |
| `remember(scope='global')` (default) | Exactly today's behavior — zero regression risk for existing flows. |
| Free-form `.md` creation | Model writes additional files with ordinary file tools (with a `<memory_policy>` hint that extra topic files belong in `.aug/memory/`); loader picks them up on next mtime change. |
| `forget` | Gains scope awareness: removes a `[key]` bullet from project files when the key resolves there (session_tools.py:258-319 — same system-lane protections: model cannot delete `source='harness'` rows; human-initiated project-file edits are always allowed). |
| `brain_query(store='project')` | Reads the project loader's entries so the model can grep its own project memory on demand (brain.py:155-283 gains a file-backed store handler). |
| `list_facts(scope='project')` | Lists parsed project entries (session_tools.py:322-380). |

### 3.4 Project skills

```
<project>/.aug/skills/<name>/SKILL.md
```

- `_skillRoots()` becomes `_skillRoots(workspace: Path | None)` (skill_service.py:35-37): `[project .aug/skills, agent data/skills, bundled skills]` — **project wins on name clash** (mirrors the existing agent-over-bundled dedupe, :253-255). `list_all`/`catalogue` gain the same optional param (skill_service.py:215-257, :319-366).
- Injection: intake skills line (workbench.py:1008-1009) and `<relevant_skills>` BM25 (capabilities_prompt.py:472-533) render the session-scoped catalogue — project skills simply appear when the session has a workspace, and never otherwise. `format_skill_index` tags project entries `[project]`.
- `load_skill`/`list_skills`/`load_skills` resolve via the session's workspace (session ContextVar — same plumbing `remember` already uses for its per-turn budget, session_tools.py:111-122). Cross-project loads are refused in v1 (open question 3).
- Creation: the model authors project skills through the **proposal queue** (Part 16 Phase C/D; proposals gain a `scope` field, applier `_apply_approved` harness_self_improve.py:421-510 writes into the project dir instead of `data/skills/`). Direct `POST /api/skills` gains an optional `workspace` field for UI authoring. Canonical-body normalization applies identically (`_ensure_canonical_body`, :532-577).

### 3.5 Project registry (new, small)

- Migration: `projects` table — `path TEXT PRIMARY KEY, name TEXT, created_at, last_seen_at, active INTEGER DEFAULT 1` (next free migration number; coordinate with Part 16 if both land in one batch).
- Endpoints (new router `routers/projects.py`):
  - `GET /api/projects` — registry rows **plus** distinct `sessions.workspace_path` values (so projects that predate the registry appear); home path excluded everywhere (the `isHomePath` guard, ChatLayout.tsx:469-479).
  - `POST /api/projects/register {path}` / `DELETE /api/projects/{path}` (deactivate; files stay in the project — they belong to it).
- Frontend registration hooks (three call sites, all existing functions): `addWorkspace` (store/workspaces.ts:88-111), `ensureFolderForWorkspacePath` (store/sessions.ts:650-674), `bindSessionToWorkspacePath` (:681-720). Fire-and-forget POST; localStorage registries remain the UI's working state, the DB becomes the enumeration SoT the Memory tab reads.

## 4. Memory tab UI (dropdown + per-project view)

- **Dropdown** at the top of `MemorySection.tsx`: `Global` + one row per registered project (name + path, reuse the dormant `WorkspaceSelector.tsx:19-170` interaction pattern and `store/workspaces.ts` naming helpers). Selection is URL state (`/settings/memory-knowledge?project=<path>`) so deep links keep working. Vertical rail stays; no pill tabs (2026-08-27 ruling).
- **Global view** = today's MemorySection unchanged (two unified scopes, :60-71) + a **Distillation card** (§5).
- **Project view** = three stacked groups (no tabs):
  1. **Memory files** — parsed entries from `.aug/memory/` rendered exactly like today's flat human-readable rows (title, kind chip, relative time, ⋯ menu with view/edit/delete). Edit/delete go through new scoped endpoints (`GET/PUT/DELETE /api/projects/memory?path=…&file=…&key=…`) that write files server-side, sandbox-validated to `<path>/.aug/memory/`; a raw-file toggle shows the actual markdown.
  2. **Project skills** — read-only list for the project (`GET /api/skills?workspace=…`), each linking into the Skills hub detail view.
  3. **Activity** — sessions bound to this workspace (existing `sessions.workspace_path` rows) with token spend; no new telemetry needed.
- "Open folder" and "Add folder to August" actions reuse `openFolderViaTauri` (WorkspaceSelector.tsx:54-65).

## 5. Global distillation

- **Job:** scheduled (consolidation loop cadence, cognitive_boot.py:102-114) + a manual "Distill across projects" button in the Global view's Distillation card. Reads every active project's `.aug/memory/*.md` + project skill catalogue (via the registry, not filesystem scans).
- **Engine:** Part 16 Phase C distiller when adopted. **Standalone fallback** (so this plan ships independently): one cheap-model call per project batch producing global-memory candidates only — `save_fact(source='harness', kind='lesson', category='project')` rows tagged `distilled_from: <project path>`; global skill proposals always go through the queue. Never deletes or modifies project data; the global layer is strictly additive.
- **Output visibility:** runs logged like consolidation (`GET /api/brain/distillation/log`, rendered in the card); distilled rows are ordinary deletable facts (`_ROW_DELETABLE` includes `facts`, brain.py:409), so the user stays in control of what the global layer "decided."
- **Privacy bound:** distillation reads project memory files the harness already holds; it ships nothing off-device beyond the configured model call, same trust boundary as every other memory feature.

## 6. Phasing

| Phase | Contents | Depends on |
|---|---|---|
| **A — Registry** | projects table + endpoints + frontend registration hooks; `GET /api/projects` | — |
| **B — Project memory engine** | `project_memory.py` loader + BM25; injection merge (§3.2); `remember`/`forget`/`brain_query`/`list_facts` scope support; intake freeze extension; default `memory.md` bootstrap | A |
| **C — Project skills** | scoped roots/catalogue/load; proposal `scope`; intake + relevant_skills rendering | B (plumbing), can parallel D |
| **D — Memory tab UI** | dropdown, project view groups, scoped endpoints, Global view untouched | A, B |
| **E — Global distillation** | scheduled + manual job, log endpoint, Distillation card; Part 16 §4C engine when available | B, (C for skill distillation) |

Each phase is independently shippable in the desktop bundle (7-file version bump on release).

## 7. Validation

- New tests: `tests/test_project_memory.py` (parse/upsert/bootstrap, BM25 scoping isolation between two temp projects, frozen intake stability alongside `test_prompt_cache_stability.py`'s pattern), `tests/test_project_skills.py` (precedence, clash, scope refusal, proposal write path), `tests/test_projects_registry.py` (register/enumerate/deactivate, home-path exclusion, distinct-union behavior).
- Existing suites must stay green — baseline **191 passed** across the 14 memory/skills suites + prompt-cache tests (2026-08-29). Run subsets with `--basetemp="$TEMP/august_pytest"`; never two suites concurrently.
- Fast path per phase: `uv run ruff check . && uv run mypy app/ && uv run pytest -q <subset>`.
- Frontend: `npm run test:frontend` (tsc + vitest); eslint has pre-existing errors at HEAD — diff before blaming.
- Manual desktop check per the product rule: `npm run dev:desktop` — open two projects, confirm each session's intake shows only its project line, confirm `<memory>` tail shows project-first hits, confirm the other project's keys are absent (the leak test).

## 8. Open questions for ruling

1. **Default file location** — plan assumes `<project>/.aug/memory/memory.md` (reuses the established `.aug/` convention, keeps the project root clean, excluded from AUG.md scanning). The spec said "a memory.md file" — if you want it literally at the project root, say so and §3.1 changes one constant (plus a root-file scan exclusion for AUG.md). Recommend `.aug/memory/`.
2. **`remember` default scope in project sessions** — plan default: `global` unless the model passes `scope='project'` (predictable, zero regression). Alternative: default to `project` when a workspace is bound. Recommend explicit-only in v1.
3. **Cross-project skill loads** — plan refuses them in v1 (a project skill name is invisible outside its project). Relax later if the model starts needing shared helpers — the right fix then is global promotion via distillation, not cross-loads.
4. **Git treatment of `.aug/memory/`** — the files sit in the user's project and will show up in its git status. Leave to the user's `.gitignore` (plan adds nothing), but August's own shadow-git should exclude `.aug/memory` alongside `.aug/spill` (shadow_git.py:47) — confirm at implementation.
5. **Distillation cadence** — recommend: manual button + weekly scheduled pass (consolidation-loop cadence). Ruling on default schedule?
6. **Registry SoT** — recommend DB-backed registry with localStorage kept as UI state (§3.5). Pure-localStorage dropdown would break the moment another frontend surface (mobile, `/v1` proxy consumers) needs the project list.

## 9. Non-goals

- No embeddings/vector store (lexical BM25, consistent with the rest of the brain).
- No per-project usage_events schema change (project activity view joins `sessions.workspace_path`, memory_schema.py:78 — no new columns).
- No auto-deletion or rewriting of project files by distillation (global layer is additive only).
- No subagent memory writes (unchanged — subagents stay blocked from durable memory, workbench/subagent.py:43-48).
