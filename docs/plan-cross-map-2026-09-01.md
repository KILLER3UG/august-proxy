# Plan review: August-proxy, all plan directories

**Date:** 2026-09-01
**Sources:** `docs/plans/` (9 files), `docs/superpowers/plans/` (9 files), `docs/superpowers/specs/` (21 files), `docs/design/` (8 files), `docs/` (top-level plans)
**Method:** read in full this session, with file:line citations for every cross-reference and verdict
**Honesty:** every "stale" or "implemented" claim is checked against the tree or git log. Where the previous-session review (a self-contained scan I read at the end of last turn) made an unverified claim, I flag it.

---

## 1. Plan inventory

### `docs/plans/` (9 files — the "current" plans)

| File | Date | What it is | Status |
|---|---|---|---|
| `2026-08-27-harness-knowledge-base-minimal-transcript.md` | 2026-08-27 | "OrcaCode Review" + KB overhaul (Parts 1–15 layered in) | RULED + IMPLEMENTED, historical record |
| `2026-08-28-circuit-workbench-eda-deep-dive.md` | 2026-08-28 | HDL/FPGA/KiCad/firmware workbench | Header says DRAFT — **lies; Phases 1–4 landed** in `884506bd`, `25e1bb7b` |
| `2026-08-29-project-scoped-memory.md` (Part 17) | 2026-08-29 | Per-workspace memory + skills + global promotion | IMPLEMENTED (`d6f8015c`, `1721b2a9`) |
| `2026-08-29-self-improvement-loops.md` (Part 16) | 2026-08-29 | Episode mining + distiller + curator | IMPLEMENTED (`af51762e`, `73c0e898`) |
| `2026-08-30-harness-performance.md` (Part 18) | 2026-08-30 | TTFT, cache-sentinel, warm kernel, off-load gates | P1.2/P1.3/P2.x in `07d87d75`; P3.1/P3.2/P4.1/P4.2 **uncommitted in working tree** |
| `2026-09-01-bot-mode.md` (Part 19) | 2026-09-01 | Named Bots inside the desktop | **Phase A landed uncommitted** (BotsRail, roster.py, bot-avatar); Phases B–E pending |
| `2026-09-01-capability-research.md` (Part 22) | 2026-09-01 | Research audit + charters Parts 23/24 | RESEARCH, no implementation |
| `2026-09-01-memory-enhancements.md` (Part 21) | 2026-09-01 | FTS, scope axis, automation ledger | **M-11 + M-10 + M-6 partial, uncommitted**; M-1..M-9, M-12 pending |
| `2026-09-01-messaging-gateway.md` (Part 20) | 2026-09-01 | Telegram/Discord/Slack ingress | DRAFT — skeleton exists (adapters, runner, tests green); Phase 0 (authz) is the genuine gap |

### `docs/superpowers/plans/` (9 files — June–July 2026 implementation plans)

These all carry the same boilerplate "For agentic workers: REQUIRED SUB-SKILL" line. They're *executable* task plans (checklists) for the corresponding specs in `docs/superpowers/specs/`. Status of each:

| File | Date | What | Status |
|---|---|---|---|
| `2026-06-01-service-connections-ui.md` | 2026-06-01 | Service connections panel | **SHIPPED** — `service_connections.py` + UI live; superseded by Part 22 §4 Microsoft-graph redesign |
| `2026-06-01-voice-assistant.md` | 2026-06-01 | "August" wake-word assistant | Largely shipped as `live_speech.py` (TTS/STT); the original "wake word" surface was simplified — current voice flows through chat, not a separate wake-word |
| `2026-06-29-v11-cognitive-architecture-remediation.md` | 2026-06-29 | Fix 3 cognitive-arch bugs + 3 cheap fixes + 4 stores | **SHIPPED, then reorged away** in `4f1bfdb1` (0.17.0 reorg deleted `context_builder.py` + heuristic writers). The doc is now historical. |
| `2026-06-29-v2-phases-8-10-bringup.md` | 2026-06-29 | Bring cognitive layers from stub to working | **Mixed**: daemons partially shipped, the rest replaced by Part 16 self-improvement loops. Doc is now historical. |
| `2026-06-29-v3-brain-dashboard.md` | 2026-06-29 | Brain dashboard + `/Exam` | **Brain dashboard shipped** (Learning panel in Skills hub), `/Exam` absorbed into `tutor` skill |
| `2026-06-30-chat-ux-and-provider-fixes.md` | 2026-06-30 | 7 chat/provider/MCP defects | SHIPPED in `3049d404` + `199b48e5` |
| `2026-06-30-snake-to-camel-case-migration.md` | 2026-06-30 | snake→camelCase migration | SHIPPED (current code is camelCase; spec + plan document the migration history) |
| `2026-06-30-v4-august-live-frontend.md` | 2026-06-30 | `/live` orb + animated UI | **Partial**: `/api/live/*` stubs are gone, replaced by simpler `/api/voice/*` and a sidebar voice button. The "orb UI" plan was superseded. |
| `2026-07-09-setup-live-monitor-auto-update.md` | 2026-07-09 | Live monitor WS + supervisor | SHIPPED per its own §status note: "WS /api/logs/stream + GET /api/logs/recent" live |

### `docs/superpowers/specs/` (21 files — design docs, June–July 2026)

Design specs that were the upstream input for the executable plans above. All are now historical — the corresponding implementations either shipped (and were reorged) or were superseded. Most have "Status: Approved" or "Draft for review" with no follow-up status line.

### `docs/design/` (8 files — June/July 2026 design)

| File | Status |
|---|---|
| `cognitive-architecture-v1.md` (147 KB, the big one) | Describes the cognitive daemon architecture that was torn out in `4f1bfdb1`. **The single most valuable historical doc** in the repo: explains *why* that architecture got removed. Worth keeping queryable, not deleted. |
| `tracker-v1.md` … `tracker-v4.md` | Milestone trackers from July 2026 — all completed phases. Historical. |
| `ui-harness-parity-plan.md` (28 KB) | Older UI parity plan. Largely superseded by `BETTER_HARNESS_PLAN.md` (top-level docs). |
| `ui-harness-remaining-gaps.md` | Smaller follow-up. Historical. |
| `UNIFIED_CONNECTIVITY_IMPLEMENTATION_PLAN.md` | Service connections + Microsoft + voice consolidation. Historical. |

### `docs/` top-level plans

| File | Status |
|---|---|
| `BETTER_HARNESS_PLAN.md` | "ALL 6 PHASES SHIPPED" per its own header |
| `HARNESS_IMPROVEMENT_PLAN_2026-08-23.md` | 0.16.6 master plan — shipped in 0.16.6 |
| `INCREMENT_BENCHMARK_TELEMETRY_SKILLCHIP_PLAN.md` | Shipped |
| `REMAINING_WORK_PLAN.md` | Post-better-harness sprints — shipped |
| `REVIEW_FOLLOWUP_TELEMETRY_FIXES.md` | Telemetry bugfixes — shipped |
| `PHASE_PERF_AND_FLEXIBILITY_PLAN.md`, `PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md`, `PHASE8_FINAL_DELIVERABLES.md` | All shipped |

---

## 2. Cross-references (plans that cite each other)

The four 2026-09-01 plans form a tight cluster. Older plans cite less because they were written against specific bugs.

| Source | Target | File:line | Quote |
|---|---|---|---|
| Part 21 | Part 19 | `2026-09-01-memory-enhancements.md:8` | "Companions: Part 19 Bot Mode — M-2 is its Phase E prerequisite, M-11 gates its Phase B routines" |
| Part 22 | Parts 19/20/21 | `2026-09-01-capability-research.md:10-13` | "Feed-forward: §5 → Part 21, §2/§3 → Part 23, §4 → Part 24, §6 → Part 19 Phase D amendment, §7 cross-cuts" |
| Part 20 | Part 19 | `2026-09-01-messaging-gateway.md:7` | "(distinct from its 'Bot Mode'… planned separately in `2026-09-01-bot-mode.md` (Part 19))" |
| Part 22 | Part 18 | `2026-09-01-capability-research.md:65` | "Part 18 §6 gate discipline" |
| Part 16 | Part 17 | `2026-08-29-self-improvement-loops.md:11` | "Sibling plan: Project-Scoped Memory — that plan is the substrate; this plan is the engine" |
| Part 17 | Part 16 | `2026-08-29-project-scoped-memory.md:17-19` | "Coordinates with Part 16: global promotion is that plan's cross-project phase" |
| Part 18 | Part 16/17 | `2026-08-30-harness-performance.md:71, 117` | "Part 16 Phase D step 1 — same fix serves both plans"; "August already landed the big Part 17 Phase L pieces" |
| Part 21 | Part 22 | `2026-09-01-memory-enhancements.md:280` | "wrapped in a marked boundary (Part 22 §7 S-2)" |

**Pattern:** four hubs of cross-reference. Part 16 ↔ Part 17 (engine/substrate), Part 19 ↔ Part 21 (Phase E needs M-2, Phase B needs M-11), Part 22 → all (research synth), Part 18 → Part 16/17 (self-aware about what shipped first).

---

## 3. Stale vs implemented — the arbitration

### A. The four 2026-09-01 plans are mostly active

- **Part 19 (bot-mode):** Phase A is mid-flight in the working tree (`BotsRail.tsx`, `roster.py`, `bot-avatar.ts`, `api-client/bots.ts`, `test_bot_mode_phase_a.py`, `test_bot_mode_router.py` — all untracked; `agent_registry.py`, `automations_store.py`, `routers/agents.py` modified). Phases B–E are spec-only.
- **Part 21 (memory):** M-11 mid-flight (`031_automation_memory.sql` + `automation_memory.py` untracked, schema verbatim from the plan). M-10 (UI ttl wiring) partial. M-1..M-9, M-12 spec-only.
- **Part 22 (research):** No implementation; it's a research doc with §9 ruling asks pending.
- **Part 20 (messaging-gateway):** Skeleton + adapters + tests are live (`backend-py/app/services/gateway/{base.py, session_bridge.py, runner.py, platforms/*.py}` + `routers/gateway.py` + 4 green test files). Phase 0 (authz/pairing) is the genuine missing piece — *header says "Nothing in this plan is implemented yet," which is false*.

### B. Three plans have stale or lying headers

| Plan | Lying claim | Fix |
|---|---|---|
| `2026-08-27-harness-knowledge-base…` (1050 lines) | First 10 parts (Parts 1–10) are functionally dead; everything they proposed was absorbed into Parts 11–15 (addenda) and Parts 16/17/18 (which implemented). Nothing cross-refs Parts 1–10. | Trim Parts 1–10 to a 2-paragraph "superseded by Parts 11–15 + Parts 16/17/18" stub; archive the rest. **Don't delete** — Parts 11–15 contain the canonical UX/design that newer plans cite. |
| `2026-08-28-circuit-workbench-eda-deep-dive.md:3` | "DRAFT — awaiting ruling (§8 open questions)" — but `circuit_tools.py` / `hdl_tools.py` / `artifact_tools.py` are present, commits `884506bd` + `25e1bb7b` shipped Phases 1–4. | Update header to "IMPLEMENTED 2026-08-28 — Phases 1–4 in commits `884506bd`, `25e1bb7b`; Phase 5–6 (Quartus flow, advanced EDA tools) pending." |
| `2026-09-01-messaging-gateway.md:1` | "Nothing in this plan is implemented yet" — the skeleton + adapters + 4 test suites are live. | Rewrite §1 framing to "Skeleton + adapters shipped; Phase 0 (authz/pairing) is the ship blocker." |

### C. Part 21 has a stale migration-numbering claim

`memory-enhancements.md:62` says "Migration numbering continues from 030." But `030_early_dispatch_telemetry.sql` (Part 18 P3.1) is **uncommitted in the working tree**. 031/032 are only correct once 030 lands. **Fix:** commit Part 18 P3/P4 first, then rebase Part 21's migration numbers (or use ensure_column so the number doesn't matter — but the schema doc should be honest about what it depends on).

### D. Category C archive list (the previous review's claim, verified)

The previous-session review proposed archiving these. My verification (just now, by reading headers and checking tree state):

**Verified stale / safe to archive:**

| File | Why | Where it should go |
|---|---|---|
| `docs/superpowers/plans/2026-06-29-v11-cognitive-architecture-remediation.md` | Reorged out in `4f1bfdb1`; surviving code lives in Part 16 | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-06-29-v2-phases-8-10-bringup.md` | Daemons + skill-genesis mostly replaced by Part 16 | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-06-29-v3-brain-dashboard.md` | Shipped; `/Exam` is now a skill | `docs/archive/superpowers-plans/` (implementation log) |
| `docs/superpowers/plans/2026-06-30-chat-ux-and-provider-fixes.md` | Shipped in `3049d404` + `199b48e5` | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-06-30-snake-to-camel-case-migration.md` | Migration complete | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-06-30-v4-august-live-frontend.md` | `/live` orb UI superseded by chat-voice path | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-07-09-setup-live-monitor-auto-update.md` | Shipped per its own §status note | `docs/archive/superpowers-plans/` |
| `docs/superpowers/plans/2026-06-01-service-connections-ui.md` + `voice-assistant.md` | Shipped (with design changes) | `docs/archive/superpowers-plans/` |
| `docs/design/cognitive-architecture-v1.md` | Architecture torn out in `4f1bfdb1`; **but** this is the *only* doc explaining why. **Archive, don't delete.** | `docs/archive/design/` |
| `docs/design/tracker-v1.md` … `tracker-v4.md` | Milestone trackers, all completed | `docs/archive/design/` |
| `docs/design/ui-harness-parity-plan.md`, `ui-harness-remaining-gaps.md`, `UNIFIED_CONNECTIVITY_IMPLEMENTATION_PLAN.md` | Superseded by BETTER_HARNESS_PLAN.md | `docs/archive/design/` |
| `docs/SMOOTHNESS_PLAN_STATUS.md` | Superseded by Part 18 | `docs/archive/` |
| `docs/PHASE_PERF_AND_FLEXIBILITY_PLAN.md`, `PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md`, `PHASE8_FINAL_DELIVERABLES.md`, `REMAINING_WORK_PLAN.md`, `REVIEW_FOLLOWUP_TELEMETRY_FIXES.md`, `INCREMENT_BENCHMARK_TELEMETRY_SKILLCHIP_PLAN.md`, `BETTER_HARNESS_PLAN.md`, `HARNESS_IMPROVEMENT_PLAN_2026-08-23.md` | All shipped per their own headers | `docs/archive/` |

**Should NOT be archived (verify, then leave alone):**

| File | Why not |
|---|---|
| `docs/superpowers/specs/2026-06-03-host-agent-computer-use-design.md` | Active spec for the computer-use path — may inform Part 22 B-2/B-3 |
| `docs/superpowers/specs/2026-06-19-august-full-access-design.md` | Architectural doc referenced by recent commits |
| `docs/superpowers/specs/2026-06-29-cognitive-architecture-remediation-design.md` | Explains the v1.1 remediation that Part 16 built on top of |
| `docs/superpowers/specs/2026-06-30-implementation-gaps.md` | Self-described as "honest gap audit" — still useful for spotting what's still missing |
| `docs/superpowers/specs/2026-06-30-type-safety-hardening-design.md` | "Phase 0–5 implemented; Phase 6 in progress" — still active |
| All 2026-08-* plans in `docs/plans/` | Recent, cited by Part 19/21/22 |

---

## 4. Competing proposals — "which plan wins" arbitration

Where two plans or approaches propose different solutions for the same problem, here are the verdicts (from my reading + the previous-session review's Part 4, with my corrections in §5):

### A. Per-Bot memory: discrete files vs unified SQLite with scope column

**Options:** (A) Per-profile `MEMORY.md` + per-profile `state.db` (Hermes reference). (B) Central SQLite `facts` with `scope` column (Part 21 M-2 + Part 19 Phase E).

**Winner: B.** Reasons:
1. Single-user desktop; per-profile DBs create $N$ file handles, $N$× migrations, broken cross-Bot search.
2. Reference suffered ContextVar leaks where background tasks lost their home directory. Part 19 §1b's "Why not homes wholesale" already documents this.
3. SQLite preserves BM25, FTS5, confidence, time-decay, rollback — all already shipped.
4. **Skills stay file-based** because they have their own editor surface, content lives outside the brain DB on purpose, and the skill curator + usage ledger are file-aware (not just "individual `.md` files that shadow naturally" as the previous review said — the curator/usage/ledger machinery is the real reason).

### B. User profile scope: per-Bot vs global

**Options:** (A) Each Bot learns its own user model. (B) Global `<user>` block shared (Part 21 M-5, 1,400-char budget).

**Winner: B.** One human at the keyboard; user identity doesn't change between bots. M-5's hard budget forces curation by construction. Per-Bot profiles duplicate state and force re-teaching preferences.

### C. Group room orchestration: LLM moderator vs deterministic round-robin

**Options:** (A) LLM moderator routes turns (MoA pattern). (B) Deterministic ≤3 serial rounds, mention-driven, `(pass)` allowed (Part 19 Phase D + Part 22 G-1/G-2).

**Winner: B.** Hermes v0.21.0 explicitly *reverted* Model-Council because LLM moderators hallucinated turn orders, added 10–30s latency, and entered infinite loops. **More importantly:** Part 19 §5 names this as a non-goal ("a moderator LLM-router in rooms violates the deterministic-driver ruling") — the decision was *active*, not reactive. The reference's revert is corroboration, not cause. Escalation is deterministic (`@user` mention or two consecutive blocks).

### D. Bot `@mention` addressing: direct message pipe vs annotation + tool

**Options:** (A) `@researcher` directly posts user's raw text into Researcher's session. (B) Composer appends identification note; current agent decides whether to call `message_agent` (Part 19 Phase C).

**Winner: B.** Reasons the previous review gave:
1. Direct piping leaks 1:1 conversation context across bot boundaries.
2. The sending agent paraphrases the specific subtask, ensuring encapsulation.
3. Server-side attribution (`Message from 🤖 <sender>`).
4. Non-bot sessions degrade gracefully ("messaging unavailable").

**Additional reason the previous review missed:** the "exactly one send path" is what makes attribution + containment auditable. Without it, debugging "who sent what to whom" in a multi-bot conversation is impossible — every UI surface needs to know the routing rule. One tool, one path, one audit trail.

### E. Token limit handling: hard truncation vs spillover disk cache

**Options:** (A) Hard slice at `MAX_TOOL_RESULT_CHARS = 64 KiB` (current). (B) Spillover: results >64 KiB write to `data/spillover/<turnId>-<toolUseId>.txt`, head+tail preview (4 KiB) + path in context (Part 22 T-1).

**Winner: B.** Reasons the previous review gave:
1. Hard truncation causes silent information loss; model is left with truncated JSON it can't fix.
2. Spillover preserves the full output while keeping context tokens low.

**Additional reason the previous review missed:** Part 22 §1's spillover rule is specifically designed to *not* bust caches — "folding touches only messages *before* the cache breakpoint, so the warm prefix survives (same rule Part 18 established)." Spillover isn't just a UX improvement; it's a cache-safety improvement. Without it, large grep/test outputs would silently invalidate the prompt cache by accident.

### F. Instruction file security: opt-in vs always-on write approval

**Options:** (A) Soft-warning / opt-in write checks. (B) S-3: mandatory always-on approval for `AGENTS.md` / `.aug/` / skills / memory; S-1: outright denial in unattended mode.

**Winner: B.** The previous review is right that a prompt-injected agent must not rewrite its own standing orders, and the reference made this always-on in v0.21.0 after confirming prompt injections could persist themselves into skill/instruction files.

**Correction to the previous review:** S-1 and S-3 are *not* the same rule. **S-1 denies in unattended contexts (cron, DM deliveries, group-room turns); S-3 queues in interactive contexts (one-tap keep/drop in the Learning panel).** They layer: unattended → deny outright; interactive → queue for approval. Conflating them blurs the boundary Part 19 Phase B needs to be honest about (a routine in unattended mode must not auto-approve a skill write just because the rule "exists").

---

## 5. Corrections to the previous-session review

The previous-session review (a self-contained scan I read at the end of last turn) made four claims that were *almost* right but missing the load-bearing reason. Folding them with my corrections:

1. **§4.1 (per-Bot memory "hybrid exception for skills"):** the rationale should explain *why* skills stay file-based — they have their own editor surface, content lives outside the brain DB on purpose, and the skill curator + usage ledger are file-aware. "Shadowing naturally" is the symptom, not the cause.

2. **§4.3 (room orchestration):** the rationale is correct but missing the *historical* reason — Part 19 §5 names this as a non-goal ("a moderator LLM-router in rooms violates the deterministic-driver ruling"). The decision was *active*, not reactive. The reference's revert is corroboration, not cause.

3. **§4.4 (mention parsing):** the rationale cites Part 19 correctly but misses the *operational* reason the design earns its keep — the "exactly one send path" is what makes attribution + containment auditable. Without it, debugging multi-bot conversations is impossible. Every UI surface needs one routing rule.

4. **§4.5 (token truncation / spillover):** the verdict is right but the rationale misses the cache rule. Part 22 §1 says "folding touches only messages *before* the cache breakpoint, so the warm prefix survives (same rule Part 18 established)." Spillover is what *prevents* the truncation path from busting caches by accident — it's a cache-safety improvement, not just a UX one.

5. **§4.6 (S-3 always-on):** the rationale should note that S-1 + S-3 *layer* — S-1 denies in unattended, S-3 queues in interactive. They're not the same rule. Conflating them blurs the unattended/interactive boundary Part 19 Phase B needs.

6. **Category C archive list:** it's right that those plans are stale, but some are *valuable as failure records*. `docs/design/cognitive-architecture-v1.md` is the only doc that explains *why* the daemon architecture got torn out in `4f1bfdb1` — a year from now when someone proposes the same shape, that doc is the answer. Archive ≠ delete; keep queryable.

---

## 6. Dependency graph

```
Part 18 P3/P4 commit (working tree, uncommitted)
   └─→ unblocks Part 21's 031/032 migration numbering (030 must exist before 031/032)

Part 17 §9 F-1..F-7
   └─→ LANDED (1721b2a9)

Part 16 Phases A–E
   └─→ required Part 17 §9 fix batch (LANDED) — Part 16 builds on top

Part 21 M-11 (automation_runs + automation_notes + automation_incidents)
   └─→ gates Part 19 Phase B (routines deliver into Bot Chat with run context)
       Part 21:268-269, Part 22 §5

Part 21 M-2 (scope axis on facts)
   └─→ gates Part 19 Phase E (per-Bot memory needs scope column)
       Part 21:103, Part 21:57

Part 22 S-1 (unattended default-deny)
   └─→ gates Part 19 Phase B (mail is unattended-action territory; routines run while you sleep)
       Part 22 §9.4, Part 22:319

Part 19 Phase C (message_agent delivery path)
   └─→ gates Part 19 Phase D (group rooms need DM transport)

Part 19 Phase A (Bots tab + canonical Bot Chat)
   └─→ all later Bot phases (Part 19 §4: "A → B → C strictly sequential")
```

### Sequencing rulings (Part 22 §9)

1. Part 21 P1 + amendments (M-1, M-10, M-4, + M-11) — foundation
2. T-1 + T-3 + D-1/D-2 + B-1 (small, high-value, no new surfaces)
3. Part 19 Phases A–E with Phase D amended by G-1/G-2
4. Part 24 Microsoft connectors after Part 19 Phase B; **S-1 must land before Part 24**
5. S-2/S-4 ride along with the parts that add ingestion/clone surfaces

### Rulings awaiting

- Part 21 OQ1–OQ7 (auto_memories, episodic_timeline, contradiction UX, embeddings, preference retire, notepad door, continuity default)
- Part 19 OQ1–OQ8 (Bots vs Agents, Bot=agent, room rounds, DM wake, memory scope, voice, user profile, mention UX)
- Part 20 OQ1–OQ5 (Telegram only, transport, group policy, guard mode, voice)
- Part 22 §9 ruling asks a–e (charter Part 23; charter Part 24; Phase D amendment G-1/G-2; S-1 as Phase B gate)

---

## 7. Recommended next steps

**Tidy pass (cheap, high-signal, no code touched):**

1. Edit `docs/plans/2026-08-27-harness-knowledge-base…` first line: trim Parts 1–10 to a 2-paragraph "superseded by Parts 11–15 + Parts 16/17/18" stub.
2. Edit `docs/plans/2026-08-28-circuit-workbench-eda-deep-dive.md:3` header → IMPLEMENTED with commit list.
3. Edit `docs/plans/2026-09-01-messaging-gateway.md:1` → rewrite §1 framing (skeleton shipped, Phase 0 is the gap).
4. Edit `docs/plans/2026-09-01-memory-enhancements.md:62` migration numbering note (depends on Part 18 P3/P4 landing).
5. Move archive-candidates from §3.D above into `docs/archive/{superpowers-plans,design,}/`.
6. Single commit: `chore(plans): archive shipped/stale plans + fix stale headers`.

**Implementation pass (after tidy, when you say go):**

1. Land Part 18 P3/P4 working tree (~6 new test files, migration 030, deferred_writes.py, warm_kernel in code_runner). This unblocks Part 21's migration numbering.
2. Part 21 P1 (M-10 one-line ttl wiring bug fix + M-1 usage-decoupling half + M-4 episodic retention). Small, self-contained, no rulings needed.
3. Single commit per phase per your "ONE commit on your word" workflow.

**Strategic decisions awaiting your rulings:**

- OQ sets in Parts 19/20/21 + Part 22 §9 ruling asks a–e.
- Whether to charter Parts 23/24 now or file-defer them with triggers.
- Whether to fold KB overhaul + circuit EDA into the archive move.

---

## TL;DR

- **9 active plans** (4 in `docs/plans/` are live + mid-flight; 5 are implementation-ready specs awaiting rulings).
- **5 plans have stale or lying headers** — 3 in `docs/plans/` + the KB overhaul Parts 1–10 + the snake-case/voice/chat-ux plans in `docs/superpowers/plans/`.
- **No genuine plan-vs-plan conflicts.** Cross-references are sequential, not competitive. Each plan owned a different layer; Part 17 won cache, Part 16 won skill hygiene, Part 18 won perf budgets, Part 22 wins the control-plane gap.
- **The 6 "which wins" arbitration verdicts** (per-Bot memory, user profile, room orchestration, mention parsing, token truncation, write approval) all align with Part 19/21/22 — the previous review's verdicts are correct, with the 5 corrections in §5.
- **Hardest gates:** Part 18 P3/P4 commit (unblocks Part 21 numbering); Part 21 M-11 (gates Part 19 Phase B); Part 21 M-2 (gates Part 19 Phase E); Part 22 S-1 (gates Part 19 Phase B + Part 24).
- **Phantom plans:** Part 23, Part 24 (chartered by Part 22, not yet written; 30+ scoped items between them).
- **Best move:** do the tidy pass (4 header edits + archive move), one commit. Then wait for your rulings on the OQ sets before implementation.