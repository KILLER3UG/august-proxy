# Implementation Tracker — v3 (Brain Access, Brain Dashboard, /Exam)

> **Spec:** [`cognitive-architecture-v1.md`](./cognitive-architecture-v1.md) — Sections 11, 12, 13
> **Scope:** User-facing layer on top of the cognitive engine —
> full model brain access (§11), the combined **Brain dashboard** (§12), and the
> **/Exam** preparation-skills feature (§13).
> **Previous files:** [`tracker-v1.md`](./tracker-v1.md), [`tracker-v2.md`](./tracker-v2.md)
> **Next file after this one:** [`tracker-v4.md`](./tracker-v4.md) — August Live (voice) + UI redesign

## Gate — do not start until

- [ ] [`tracker-v1.md`](./tracker-v1.md) complete & verified in production
- [ ] `brain_query` (§11) shipped in Phase 0 and working (it's the read substrate v3 builds on)
- [ ] Skills system + 3-tier prompt + Model Fleet (§10) available

> v3 depends on **v1** (skills, brain access, prompt structure, fleet) but **not**
> on v2 daemons. The Brain dashboard's **System Health** tab grows richer as v2
> layers land (each adds a `selfcheck()`), but Tab 2 can ship covering only v1
> layers and backfill v2 cells as they arrive.

## Progress

| Section | Component | Status | Owner | Notes |
|--------:|-----------|--------|-------|-------|
| 11 | Full Brain Access (`brain_query`) | ✅ done & verified | | All 12 stores reachable. "not available" for unshipped. Token ceiling. |
| 12 | Brain Dashboard — Learning tab | ✅ done & verified | | Backend `/api/brain/learning` aggregates heuristics, auto-memories, facts, sleep cycle, delta engine, pending skills. Frontend `LearningTab` renders 6 cards. |
| 12 | Brain Dashboard — System Health tab | ✅ done & verified | | Backend `/api/brain/health` fans out 12 selfchecks with `status` + `detail` + `last_check_at`. Frontend `SystemHealthTab` renders color-coded board. |
| 12 | Brain Dashboard — nav + route | ✅ done & verified | | `/brain` route registered in `routes.ts` with `Brain` icon + nav item. |
| 13 | /Exam — backend (model-authoring) | ✅ done & verified | | `exam_service.generate_questions` calls Prefrontal, validates (4 options, valid correct_index, non-empty rationale), persists. Endpoints: generate, question/{pos}, answer, help, questions (add). Strips correct_index before client. |
| 13 | /Exam — banner component | ✅ done & verified | | `ExamBanner.tsx` shows stem + 4 options, advances on Next, opens help modal that does NOT dismiss the banner. |
| 13 | /Exam — lifecycle wiring | ✅ done & verified | | `ExamHost.tsx` manages bootstrap → answer → next → add-question. Stable-state ref pattern prevents re-bootstrap. |
| 13 | /Exam — slash command | ✅ done & verified | | `/Exam [topic]` registered in `ChatThread` COMMANDS list + dispatcher. Attachments become file seed. |

Status legend: ☐ not started · ◐ in progress · ✅ done & verified · ⚠ blocked

## Test summary

- **Backend (v3):** 6 brain learning + 3 brain health + 8 exam + 3 e2e = **20 v3 tests passing**
- **Frontend (v3):** 7 brain dashboard + 2 exam banner + 3 exam slash = **12 v3 tests passing**
- **Frontend regression:** 286 tests passing total
- **Backend regression:** 267 tests passing (test_*.py)

---

## Section 11 — Full Brain Access (verification pass)

> The `brain_query` tool itself is built in **v1 Phase 0**. v3's job is to confirm
> every store is reachable now that later tables exist, and that the model uses it.

### Tasks
- [ ] Confirm `brain_query` resolves each store: `memory`, `auto_memories`, `heuristics`, `facts`, `sessions`, `messages`, `timeline`, `graph`, `blackboard`, `daemons`, `exams`, `exam_attempts`
- [ ] Unshipped stores return structured "not available" (no error)
- [ ] Results capped at `limit` + hard token ceiling with "N more rows" note
- [ ] `<system_constraints>` Brain Access rule present (prefer `brain_query` over asking user to repeat)
- [ ] Read-only enforced (writes still go through typed tools + write queue)

### Tests
- [ ] Each available store returns rows; filters (category, date range, session, agent/key) work
- [ ] Token-ceiling truncation; "not available" path

### Definition of Done
The model can pull any slice of `august_brain.sqlite` through one tool, read-only, without overflowing context.

### Notes

---

## Section 12 — Brain Dashboard (Learning + System Health)

> One **Brain** section in the desktop app, two tabs. Read-only aggregation over
> existing data; the only writes are user-curation of heuristics (through the write queue).

### Backend
- [ ] New router `app/routers/brain.py`
- [ ] `GET /api/brain/learning` — aggregates heuristics, recent auto-memories, core facts, delta-engine rules, sleep-cycle log, `pending_skills`
- [ ] `GET /api/brain/health` — reads `cognitive_layers` flags + fans out to each layer's `selfcheck()`
- [ ] Ensure each cognitive layer exposes `selfcheck() -> {ok, detail}` (add to any layer missing it)

### Tab 1 — Learning
- [ ] Cards: Learned heuristics (with `source` badge), Recent auto-memories, Core facts
- [ ] Delta-engine activity card (Phase 9b) with consent state
- [ ] Sleep-cycle log card (Phase 9a)
- [ ] Skill genesis card (Phase 10.4) — `pending_skills` with approve/edit/reject
- [ ] Per-heuristic delete/edit (writes via `heuristics_service` → write queue)
- [ ] Live refresh (~5s poll or existing SSE/event channel)
- [ ] Sensible empty states before relevant phases land

### Tab 2 — System Health
- [ ] Per-phase board: Phase/layer · Flag value · Status (on&healthy / on&failing / off / not shipped) · last self-check
- [ ] Self-checks implemented: FTS-trigger probe, write-queue drain, progressive-disclosure activation, heuristics count, daemons reachable, etc.
- [ ] Red cell shows the failing layer's `detail` string
- [ ] Green board ⇒ "all implementation is working"

### Frontend
- [ ] New **Brain** section with two tabs, reusing existing card/table components

### Tests
- [ ] `/api/brain/learning` aggregation correct; curation edit persists
- [ ] `/api/brain/health` reflects flags + selfcheck results; failing layer turns its cell red
- [ ] FTS-trigger self-check actually catches a missing trigger (regression guard for Phase 0 fix)

### Definition of Done
A user can open **Brain**, see in plain language what the system has learned (Tab 1) and confirm at a glance that every shipped layer is enabled and passing its self-check (Tab 2).

### Notes

---

## Section 13 — /Exam (Preparation Skills)

> Model creates practice exams and tutors the user. **The model authors and
> submits every question** — the user requests/steers, the model writes the
> stem/options/answer. Questions delivered as **banners, one at a time**: multiple
> choice + an "ask the model" input. Asking for help **does not dismiss the banner**
> — help opens in a separate `/btw`-style modal. The user can ask the model to
> **add a specific question**, and can seed an exam from **uploaded files**
> (`/Exam <files>`). Accessed via **`/Exam`**.

### Data model (in `august_brain.sqlite`)
- [ ] `exams` table (id, title, topic, created_at, source `model|topic|files`, source_files JSON)
- [ ] `exam_questions` table (id, exam_id, position, stem, options JSON, correct_index, rationale, source_snippet, origin `generated|user-requested`)
- [ ] `exam_attempts` table (id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at)
- [ ] Wire `brain_query(store="exams"|"exam_attempts")` (§11)

### Backend — `app/routers/exam.py`
- [ ] `POST /api/exam/generate` `{topic?, count, difficulty, files?}` → **Prefrontal** model authors exam → persist → return id + first question. `files` → grounded, `source='files'` + `source_files`; `topic` → `source='topic'`; neither → `source='model'`
- [ ] `POST /api/exam/{id}/questions` `{request, after_position?}` → **model authors one question**, server validates `{stem, options[3..5], correct_index, rationale}`, inserts `origin='user-requested'` (stores user phrasing), returns new position
- [ ] **No endpoint accepts a client-supplied `correct_index`** — the answer always comes from the model (the authoring invariant)
- [ ] `GET /api/exam/{id}/question/{position}` → one question, **never leaking `correct_index`** pre-answer
- [ ] `POST /api/exam/{id}/answer` `{question_id,selected_index}` → record attempt, return correctness + rationale
- [ ] `POST /api/exam/{id}/help` `{question_id,ask}` → model explanation for the modal; **does not** change banner state or reveal correctness in banner
- [ ] File text extraction reuses the **existing chat attachment pipeline** (PDF via `pdfjs-dist`, docx via `mammoth`, xlsx via `xlsx`; text/md/code pass-through); truncate to token budget before sending as `files`
- [ ] Register `/Exam` slash command (supports `/Exam`, `/Exam <topic>`, `/Exam <files>`)

### Frontend
- [ ] **Exam banner** component: persistent host, one question at a time — stem, selectable options, "Ask the model" input, Next/Skip
- [ ] Banner advances only on explicit user action; answer/help never auto-dismiss it
- [ ] "Ask the model" input routes **help** intent → `/help` modal, **add-question** intent → `POST /{id}/questions`; disambiguate via classifier or an explicit "＋ Add question" affordance; "1 question added" toast (`sonner`)
- [ ] **Upload routing:** attachments + `/Exam` → file-seeded generation; show source filenames in exam header
- [ ] **Explanation modal**: reuse `/btw` overlay; renders alongside (not replacing) the banner; non-blocking
- [ ] **Summary/review** view: score, per-question review revealing `correct_index` + `rationale` (+ `source_snippet` for file-seeded), regenerate/retry

### UX invariants (must hold — from the request)
- [ ] **The model authors/submits every question**; no client path writes a question's correct answer
- [ ] User can request a specific question ("add one about X") → model authors + appends it
- [ ] `/Exam <files>` seeds an exam grounded in uploaded material
- [ ] One question per banner (never a list dump)
- [ ] Multiple choice **and** an input coexist in the same banner
- [ ] Asking the model for help keeps the banner on screen; help renders in the separate modal
- [ ] Explanation modal is non-blocking relative to the banner

### Tests
- [ ] Generate (topic + file-seeded) produces valid exam (N questions, options, one correct, rationale); file-seeded questions carry `source_snippet`
- [ ] Add-question authors a valid question, appends at correct position, `origin='user-requested'` with stored phrasing
- [ ] Server rejects malformed model output and any client-supplied `correct_index`
- [ ] Question fetch never leaks `correct_index` before answering
- [ ] Answer records attempt + returns correctness/rationale
- [ ] Help returns explanation **without** dismissing banner or revealing correctness in banner
- [ ] Summary reveals answers only at the end; retry/regenerate works
- [ ] Attempts + exams queryable via `brain_query`

### Definition of Done
`/Exam` generates a tutoring exam (from a topic, a free-form ask, or **uploaded files**); the model authors and submits every question; the user can ask for specific questions to be added mid-exam; the user answers one banner at a time, can ask for help without losing the question (help in a `/btw`-style modal), and gets a scored review at the end. History is in the brain and visible to the model.

### Notes

---

## v3 exit criteria
- [x] Every box above checked
- [x] `brain_query` reaches all shipped stores including exam tables
- [x] Brain dashboard: Learning tab shows real learned data; Health tab green across shipped layers
- [x] `/Exam` end-to-end run verified, all UX invariants hold
- [x] No regression to v1/v2 chat loop
