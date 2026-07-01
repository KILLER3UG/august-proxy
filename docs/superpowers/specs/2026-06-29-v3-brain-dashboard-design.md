# v3 — Brain Dashboard Design Doc

**Date:** 2026-06-29
**Status:** Draft for review
**Scope:** A user-facing delivery built on top of v1.1 (tagged `v1.1.0`) and v2 (tagged `v2.0.0`): a combined **Brain dashboard** (Learning + System Health tabs) and the **/Exam** preparation-skills feature.
**Reference:** `docs/design/cognitive-architecture-v1.md` §12 (Brain Dashboard) and §13 (/Exam). The v1.1 design doc §6 (tracker-v3.md) lists the original tasks.

---

## 1. Background

After v1.1 and v2, every cognitive layer produces data — heuristics, auto-memories, facts, pending skills, daemons, env watcher events, blackboard notes, consolidation history, episodic timeline. But this data is invisible to the user.

v3 makes it visible through a single **Brain** section in the desktop app with two tabs:
- **Learning** — what the brain has picked up (read-only feed, with curation actions)
- **System Health** — whether every cognitive layer is enabled, healthy, and self-checking

Plus, the **/Exam** feature (a tutor workflow where the model authors multiple-choice questions from a topic or uploaded files) is shipped in v3.

## 2. Goals and non-goals

### Goals
- One **Brain** section in the desktop app nav, with two tabs
- **Learning tab** shows real data from `august_brain.sqlite`:
  - Learned heuristics (with `source` badge: `manual` / `local-diff` / `auto`)
  - Recent auto-memories with importance
  - Core facts
  - Delta-engine activity (queue size, last batch flush)
  - Sleep-cycle log (last consolidation: merges / promotions / deletions)
  - Skill genesis (pending skills with approve / edit / reject)
- **System Health tab** shows a per-phase board:
  - Phase/layer · Flag value · Status (on & healthy / on & failing / off / not shipped) · Last self-check
  - Red cell shows the failing layer's `detail` string
  - Green board ⇒ "all implementation is working"
- **`/Exam` slash command** — generate practice exams (from a topic or uploaded files), one question at a time, with `/btw`-style help modal and end-of-exam summary
- All v3 features read from existing data sources; no new write paths except user curation of heuristics and approve/reject of pending skills

### Non-goals
- No new cognitive layers (the five-layer model is fixed)
- No new model providers (Cortex/Cerebellum/Hippocampus/Prefrontal is fixed)
- No v4 (August Live + UI redesign) — that's a separate plan
- No real-time streaming updates (polling refresh every 5s is sufficient)

---

## 3. Component map

### Backend (mostly done in v2)

- **`app/routers/brain.py`** — `/api/brain/learning` aggregates heuristics, facts, auto-memories, delta-engine, sleep-cycle, pending_skills. `/api/brain/health` reads `cognitive_layers` flags and fans out to each layer's `selfcheck()`. (v2 already added real `pending_skills` query.)
- **`app/routers/exam.py`** — `/api/exam/generate`, `/api/exam/{id}/questions`, `/api/exam/{id}/question/{pos}`, `/api/exam/{id}/answer`, `/api/exam/{id}/help`. (v2 stubbed; v3 implements the model-authoring path with Prefrontal.)
- **`app/services/exam_service.py`** (new) — orchestration of exam generation, question fetch, answer scoring, help. Prefrontal model called to author questions.
- **`app/services/skill_service.py`** — pending skills + approval flow. (v2 has `draft_skill_for_session`, `approve_pending_skill`, `reject_pending_skill`.)
- **`app/services/heuristics_service.py`** — already CRUDs `learned_heuristics`. v3 adds delete/edit affordances via the existing API.

### Frontend

- **`frontend/desktop/src/sections/brain/BrainDashboard.tsx`** — already exists (v3 stub) with two tabs but not registered in nav. v3: register it, populate cards with real data, wire mutations.
- **`frontend/desktop/src/sections/brain/LearningTab.tsx`** (new) — heuristics list, auto-memories, facts, delta engine card, sleep cycle card, skill genesis card
- **`frontend/desktop/src/sections/brain/SystemHealthTab.tsx`** (new) — per-phase status board
- **`frontend/desktop/src/sections/exam/ExamBanner.tsx`** (new) — one-question-at-a-time UI with help modal
- **`frontend/desktop/src/sections/exam/ExamSummary.tsx`** (new) — scored review with per-question details
- **`frontend/desktop/src/workspace-registry.ts`** (or equivalent) — register Brain as a workspace-level item
- **`frontend/desktop/src/routes.ts`** — add `/brain` route

---

## 4. Tab 1: Learning

### Data source

`GET /api/brain/learning` returns:

```json
{
  "heuristics": [
    { "id": int, "rule": str, "source": "manual|local-diff|auto", "category": str, "created_at": str }
  ],
  "heuristic_count": int,
  "core_facts": { ... } | null,
  "user_profile": { ... } | null,
  "auto_memories": [
    { "id": int, "key": str, "content": str, "importance": real, "created_at": str }
  ],
  "delta_engine": {
    "consent_granted": bool,
    "queue_size": int,
    "last_flush_at": str | null
  },
  "sleep_cycle": {
    "last_run_at": str | null,
    "last_merged": int,
    "last_promoted": int,
    "last_deleted": int
  },
  "pending_skills": [
    { "id": int, "name": str, "description": str, "trigger_text": str,
      "draft_path": str, "source_session_id": str, "created_at": str, "use_count": int }
  ]
}
```

(v2 already adds `pending_skills` and `auto_memories` query; v3 adds `sleep_cycle` and `delta_engine.last_flush_at`.)

### UI cards

| Card | Source | Shows | User actions |
|------|--------|-------|--------------|
| **Learned heuristics** | `learned_heuristics` | Each rule, source badge, category, age, use count | Delete (with confirm), edit (inline text edit) |
| **Recent auto-memories** | `auto_memories` (top 20 by importance) | Key, content, importance bar, age | View full (modal) |
| **Core facts** | `facts` table joined with `core_memory` key | Structured facts (e.g., `code_style: spaces`) | View full |
| **Delta engine** | `delta_engine._diff_queue` size + last flush | Queue size, "last flushed 4h ago", consent state | Open consent dialog if not granted |
| **Sleep cycle** | `consolidation_daemon._last_run` | Last run time, last merges/promotions/deletions | Run now button (calls `/api/brain/run-consolidation`) |
| **Skill genesis** | `pending_skills` (v2 already surfaces this) | Each pending skill with name, description, trigger, source session | Approve / Edit / Reject (calls existing endpoints) |

### Empty states

- No heuristics yet: *"No learned heuristics yet — the brain starts learning once you use it."*
- No auto-memories: *"No auto-memories captured yet. The model will start saving them as you chat."*
- No pending skills: *"No auto-generated skills pending review. The brain drafts skills from complex successful sessions."*

### Refresh

- Auto-refresh every 5s (polling) or on user focus
- Use React Query or SWR for caching + invalidation (or simple `useEffect` + `setInterval`)

### Mutations

- Delete heuristic: `DELETE /api/brain/heuristics/{id}` → calls `heuristics_service.remove_heuristic`
- Edit heuristic: `PATCH /api/brain/heuristics/{id}` → updates `rule` column
- Approve skill: `POST /api/brain/skills/{name}/approve` → calls `consolidation_daemon.approve_pending_skill`
- Reject skill: `POST /api/brain/skills/{name}/reject` → calls `consolidation_daemon.reject_pending_skill`
- Run consolidation: `POST /api/brain/run-consolidation` → calls `await consolidation_daemon.run_consolidation()`

All mutations go through `db_writer.enqueue_write` (v2 hardening) so the dashboard never directly mutates the DB.

---

## 5. Tab 2: System Health

### Data source

`GET /api/brain/health` returns:

```json
{
  "layers": {
    "heuristics": {
      "flag": true,
      "status": "on & healthy",
      "last_check_at": "2026-06-29T10:00:00Z",
      "detail": "12 active heuristics"
    },
    "daemons": {
      "flag": true,
      "status": "on & healthy",
      "last_check_at": "2026-06-29T10:00:01Z",
      "detail": "3 daemons running, 0 errors"
    },
    "consolidation": {
      "flag": true,
      "status": "on & healthy",
      "last_check_at": "2026-06-29T10:00:02Z",
      "detail": "Last run 4h ago: 2 merges, 1 promotion"
    },
    "blackboard": {
      "flag": true,
      "status": "on & failing",
      "last_check_at": "2026-06-29T10:00:03Z",
      "detail": "3 notes older than TTL — cleanup may be slow"
    },
    "env_watcher": { ... },
    "verifier_reflex": { ... },
    "skill_genesis": { ... }
  },
  "all_healthy": false
}
```

Each layer exposes a `selfcheck()` function (v2 already added several; v3 fills in the rest).

### UI board

A table with columns:
- **Layer** (name)
- **Flag** (✅ on / ❌ off)
- **Status** (color-coded: green=on & healthy, yellow=on & warning, red=on & failing, gray=off)
- **Last check** (relative time)
- **Detail** (the `detail` string from selfcheck)

Click a row → expand to show the raw selfcheck output.

### Selfcheck implementations (v3)

| Layer | `selfcheck()` logic |
|-------|---------------------|
| `heuristics` | count heuristics, verify schema |
| `execution_state` | verify session state read works |
| `scratchpad` | verify session scratchpad read works |
| `tool_guardrails` | count tracker hits, verify no false blocks |
| `cognitive_budget` | trigger a sample computation, verify pressure levels |
| `daemons` | count daemons, verify none errored |
| `consolidation` | verify last run was successful (use `_last_run` tracking) |
| `delta_engine` | queue size, last flush timestamp |
| `progressive_disclosure` | verify BM25 catalog is non-empty |
| `prompt_caching` | verify cache hit rate > 0 |
| `blackboard` | check note counts, TTL cleanup rate |
| `env_watcher` | check last change event was within expected window |
| `verifier_reflex` | verify gate injection logic |
| `skill_genesis` | count pending skills, last drafted timestamp |

The selfcheck is a function that returns a `dict` with `status` (string) and `detail` (string). The router calls all of them in parallel via `asyncio.gather` and aggregates.

---

## 6. /Exam (preparation skills feature)

### Overview

A user-facing tutor workflow:
1. User types `/Exam <topic>` or `/Exam <files>` (e.g., `/Exam ~/notes.pdf auth.py`)
2. Backend generates a practice exam (default 5 questions) using **Prefrontal** model
3. UI shows one question at a time in a banner
4. User picks an option, submits; UI advances to next question
5. "Ask the model" input on the banner → opens help modal (doesn't dismiss banner)
6. End of exam: scored review with correct_index + rationale revealed

### Backend (v3 work)

`POST /api/exam/generate {topic?, count, difficulty, files?}`:
- If `files` provided: extract text (PDF via pdfjs-dist, docx via mammoth, xlsx via xlsx, code/text pass-through)
- If no `files`: use `topic` as a free-form description
- Call Prefrontal with: *"Generate {count} multiple-choice questions on this topic. Each question has 4 options, exactly 1 correct, with a 1-sentence rationale. Return JSON: [{'stem': str, 'options': [str, str, str, str], 'correct_index': 0-3, 'rationale': str}]"*
- Validate: stem non-empty, exactly 4 options, correct_index 0-3, rationale non-empty
- Insert into `exams` + `exam_questions` (existing tables)
- Return `{exam_id, first_question}` (with `correct_index` stripped)

`POST /api/exam/{id}/questions {request, after_position?}`:
- Call Prefrontal with: *"Generate ONE more question on this topic, similar in style to the existing questions. Return JSON: {...}"*
- Append to exam
- Return new question (without `correct_index`)

`GET /api/exam/{id}/question/{position}`:
- Return the question at `position` — but **strip `correct_index` and `rationale`** until answered

`POST /api/exam/{id}/answer {question_id, selected_index}`:
- Record attempt
- Return `{is_correct, correct_index, rationale}`

`POST /api/exam/{id}/help {question_id, ask}`:
- Call Prefrontal with the question + user question
- Return `{explanation: str}` — does NOT change banner state, does NOT reveal correctness

### Frontend (v3 work)

- **`ExamBanner.tsx`**: persistent host that displays one question at a time
  - Stem, 4 options (radio), submit button
  - "Ask the model..." input → opens HelpModal
  - On submit: show correct/incorrect indicator, then advance to next question
  - "Add a question about X..." input → calls `/api/exam/{id}/questions`
  - On end: route to `ExamSummary.tsx`
- **`HelpModal.tsx`**: reusable `/btw`-style overlay (already exists in the codebase; v3 reuses it)
- **`ExamSummary.tsx`**: scored review with per-question details (correct_index + rationale + source_snippet for file-seeded)

### UX invariants (must hold)

- The model authors/submits every question; no client path writes a question's correct answer
- One question per banner (never a list dump)
- Multiple choice + "Ask the model" coexist in the same banner
- Help modal is non-blocking relative to the banner
- Banner advances only on explicit user action; help/answer never auto-dismiss

---

## 7. File map

### New files

- `backend-py/app/services/exam_service.py` — exam orchestration
- `frontend/desktop/src/sections/brain/LearningTab.tsx`
- `frontend/desktop/src/sections/brain/SystemHealthTab.tsx`
- `frontend/desktop/src/sections/exam/ExamBanner.tsx`
- `frontend/desktop/src/sections/exam/ExamSummary.tsx`
- `backend-py/tests/v3_brain_learning.py`
- `backend-py/tests/v3_brain_health.py`
- `backend-py/tests/v3_exam.py`
- `frontend/desktop/src/test/v3_brain_dashboard.test.tsx`
- `frontend/desktop/src/test/v3_exam_banner.test.tsx`

### Modified files

- `backend-py/app/routers/brain.py` — add `sleep_cycle` and `delta_engine.last_flush_at` fields; add `DELETE/PATCH /api/brain/heuristics/{id}`; add `POST /api/brain/skills/{name}/approve|reject`; add `POST /api/brain/run-consolidation`
- `backend-py/app/routers/exam.py` — implement the real model-authoring path
- `frontend/desktop/src/sections/brain/BrainDashboard.tsx` — register in nav, populate with real data
- `frontend/desktop/src/workspace-registry.ts` (or equivalent) — add Brain as a workspace-level item
- `frontend/desktop/src/routes.ts` — add `/brain` route
- `frontend/desktop/src/ChatThread.tsx` (or similar) — register `/Exam` slash command

### Existing files reused

- `app/services/consolidation_daemon.py` (v2) — `draft_skill_for_session`, `approve_pending_skill`, `reject_pending_skill`
- `app/services/memory_store.py` (v1.1) — `exams`, `exam_questions`, `exam_attempts` tables already exist
- `app/services/heuristics_service.py` (v1.1) — CRUD for `learned_heuristics`
- `frontend/desktop/src/sections/chat/ChatMarkdown.tsx` (v1.1) — math/unicode rendering

---

## 8. Testing strategy

- Backend tests: each router endpoint has a test (mock Prefrontal where needed)
- Frontend tests: each tab component has a Vitest test
- E2E test: full flow — create exam, answer questions, get summary
- Real-LLM test (optional): add to `v2_real_llm.py` or new `v3_real_llm.py` — verify exam generation works with a real LLM

Total target: ~30 new tests (15 backend, 15 frontend)

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM produces malformed exam JSON (wrong number of options, invalid correct_index) | Medium | Medium | Validate on generation; reject + retry once; on second failure, return error to UI |
| Brain dashboard adds nav clutter | Low | Low | Use the existing workspace-level section pattern; don't add a new top-level nav item |
| `/Exam` slash command conflicts with existing `/Exam` paths | Low | Low | Verify the slash dispatch table before registering |
| Card polling at 5s causes unnecessary network | Low | Low | Use a 5s interval; pause when tab is hidden |
| Skill approval flow doesn't show pending_skills if none exist | Low | Low | Empty state with helpful text |

---

## 10. Definition of Done

v3 ships when:
- All 6 cards on the Learning tab show real data (or appropriate empty states)
- The System Health tab shows 12+ layers with selfcheck
- `/Exam` slash command works end-to-end (topic or files → exam → answer → summary)
- Mutation actions (delete heuristic, edit heuristic, approve/reject skill, run consolidation) all work
- Trackers updated to reflect actual state
- `v3.0.0` tag created locally

---

## 11. Out of scope (deferred to v4)

- Voice interaction (August Live) — v4
- UI redesign (bubble-less chat, caps role label, 14px composer, etc.) — v4
- Real-time streaming updates (polling is sufficient for v3)
- Brain dashboard customizations (filters, search) — future
- Exam analytics (per-topic performance, retry logic) — future

---

## 12. Glossary additions (vs v2)

- **Brain dashboard** — user-facing section showing what the brain has learned and whether every cognitive layer is healthy
- **System Health tab** — per-phase status board (flag value, status, last self-check, detail)
- **/Exam** — slash command that generates a practice exam from a topic or uploaded files
- **Exam banner** — persistent UI host that displays one question at a time
- **Selfcheck** — per-layer function returning `{status, detail}` used by the System Health board

---

**End of design doc. After your review, I'll invoke the writing-plans skill to produce the v3 implementation plan.**
